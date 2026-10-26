import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GotzjiNativeAdapter, gotzjiNativeChildEnvironment, runGotzjiNativePowerShell } from './gotzji-native-adapter.js';
import { nativeBytesDigest, planGotzjiNativeOperation, type GotzjiNativeGrant } from './gotzji-native-contract.js';
import { GotzjiNativeBrowserAdapter } from './gotzji-native-browser.js';
import type { BrowserCdpProtocol } from './browser-cdp-backend.js';

let qualificationRoot = path.resolve(process.env.LOCALAPPDATA ?? process.cwd(), 'gotzji', 'qualification');
const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    const relative = path.relative(qualificationRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture cleanup scope denied');
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(): Promise<{ root: string; source: string; output: string; script: string; grant: GotzjiNativeGrant }> {
  await mkdir(qualificationRoot, { recursive: true });
  qualificationRoot = await realpath(qualificationRoot);
  const root = await realpath(await mkdtemp(path.join(qualificationRoot, 'native-adapter-test-'))); qualificationRoot = path.dirname(root); fixtures.push(root);
  const source = path.join(root, 'source.xlsx'); const output = path.join(root, 'result.xlsx'); const script = path.join(root, 'provider.ps1');
  await writeFile(source, 'original'); await writeFile(script, 'pinned provider');
  return { root, source, output, script, grant: { ownerId: 'owner', projectId: 'project', jobId: 'job', operationId: 'operation', rootPath: root, proof: 'private-proof' } };
}
function input(source: string, output: string): Record<string, unknown> {
  return { operation: 'excel.range.write', filePath: source, outputPath: output, expectedSha256: nativeBytesDigest(Buffer.from('original')), sheet: 'Sheet', range: 'A1', values: [['after']] };
}
function fakeChild(): ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> } {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { void Promise.resolve().then(() => child.emit('close', null, null)); return true; }) });
  return child as unknown as ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> };
}

describe('gotzji native admission and verification', () => {
  it('verifies bounded Excel sheet metadata and refuses forged receipt shape without changing the workbook', async () => {
    const f = await fixture();
    const operation = { operation: 'excel.sheets.inspect', filePath: f.source, expectedSha256: nativeBytesDigest(Buffer.from('original')) };
    let snapshot: unknown = { sheets: [{ name: 'ข้อมูล', used_range: 'B2:D4', rows: 3, columns: 3 }], total: 1, returned: 1, truncated: false };
    const runner = vi.fn(async (): Promise<unknown> => ({ operation: operation.operation, provider: 'excel', providerVersion: 'explicit-metadata-fixture', nativePid: 123, sourceSha256: operation.expectedSha256, outputSha256: null, originalPreserved: true, savedAndReopened: false, unrelatedPreserved: true, verified: true, before: snapshot, after: snapshot }));
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true, runner });
    const plan = await planGotzjiNativeOperation(operation, f.root);
    expect(plan.resourceKeys).toHaveLength(2);
    expect(await adapter.execute(f.grant, operation)).toMatchObject({ after: snapshot });
    for (const field of ['sheet', 'range', 'values', 'outputPath']) await expect(planGotzjiNativeOperation({ ...operation, [field]: 'forged' }, f.root)).rejects.toThrow('NATIVE_INPUT_INVALID');
    snapshot = { sheets: [], total: 0, returned: 0, truncated: false };
    expect(await adapter.execute(f.grant, operation)).toMatchObject({ after: snapshot });
    const sheets = Array.from({ length: 256 }, (_, index) => ({ name: `Sheet${index}`, used_range: 'A1', rows: 1, columns: 1 }));
    snapshot = { sheets, total: 257, returned: 256, truncated: true };
    expect(await adapter.execute(f.grant, operation)).toMatchObject({ after: snapshot });
    for (const invalid of [
      { sheets, total: 257, returned: 256, truncated: false },
      { sheets: [...sheets, sheets[0]], total: 257, returned: 257, truncated: false },
      { sheets: [{ name: 'S', used_range: 'A1:B2', rows: 1, columns: 2 }], total: 1, returned: 1, truncated: false },
      { sheets: [{ name: 'S', used_range: 'XFE1', rows: 1, columns: 1 }], total: 1, returned: 1, truncated: false },
      { sheets: [], total: 1, returned: 0, truncated: true },
    ]) {
      snapshot = invalid;
      await expect(adapter.execute(f.grant, operation)).rejects.toThrow('NATIVE_RECEIPT_INVALID');
    }
    expect(await readFile(f.source, 'utf8')).toBe('original');
  });
  it('persists the exact Office application identity before any document open and exposes no ambient kill path', async () => {
    const provider = await readFile(fileURLToPath(new URL('../../../apps/desktop/build/gotzji-native-office.ps1', import.meta.url)), 'utf8');
    const identity = provider.indexOf("Write-ProcessIdentity $script:ownedPid $ownedBirth $ownedExecutable 'office'");
    expect(identity).toBeGreaterThan(0);
    for (const open of ['$application.Workbooks.Open(', '$application.Documents.Open(', '$application.Presentations.Open(']) expect(provider.indexOf(open)).toBeGreaterThan(identity);
    expect(provider).not.toMatch(/\bStop-Process\b|\.Kill\s*\(/u);
  });
  it.runIf(process.platform === 'win32')('authenticates the actual PowerShell Office identity function without creating Office', async () => {
    const f = await fixture();
    const provider = fileURLToPath(new URL('../../../apps/desktop/build/gotzji-native-office.ps1', import.meta.url)).replaceAll("'", "''");
    const evidence = { schemaVersion: 1, provider: 'office', effectRoot: f.root, journalPath: path.join(f.root, 'native-process-identities.jsonl'), jobId: 'job', epoch: 'epoch', generation: 1, planDigest: 'b'.repeat(64), evidenceKey: 'a'.repeat(64), invocationId: '00000000-0000-0000-0000-000000000001' };
    const encoded = Buffer.from(JSON.stringify(evidence)).toString('base64');
    const script = `
      $ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
      $tokens=$null; $parseErrors=$null
      $tree=[Management.Automation.Language.Parser]::ParseFile('${provider}',[ref]$tokens,[ref]$parseErrors)
      if($parseErrors.Count -ne 0){throw ($parseErrors|Out-String)}
      foreach($name in @('Fail','Require-ProcessEvidence','Write-ProcessIdentity')){
        $definition=$tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
        if($definition.Count -ne 1){throw 'Function identity changed'}
        Invoke-Expression $definition[0].Extent.Text
      }
      Add-Type -TypeDefinition 'public static class GotzjiNativeEvidenceJournal { public static string Journal; public static string Root; public static string Line; public static void Append(string journal, string root, string line) { Journal=journal; Root=root; Line=line; } }'
      $script:processEvidence=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
      Write-ProcessIdentity 123 '638000000000000000' 'C:\\Owned\\EXCEL.EXE' 'office'
      [Console]::Write(([ordered]@{journalPath=[GotzjiNativeEvidenceJournal]::Journal;effectRoot=[GotzjiNativeEvidenceJournal]::Root;line=[GotzjiNativeEvidenceJournal]::Line}|ConvertTo-Json -Compress))
    `;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
    const captured = JSON.parse(stdout) as { journalPath: string; effectRoot: string; line: string };
    expect(captured).toMatchObject({ journalPath: evidence.journalPath, effectRoot: f.root });
    const envelope = JSON.parse(captured.line) as { body: string; mac: string };
    expect(envelope.mac).toBe(createHmac('sha256', Buffer.from(evidence.evidenceKey, 'hex')).update(envelope.body).digest('hex'));
    expect(JSON.parse(envelope.body)).toMatchObject({ schemaVersion: 1, recordType: 'identity', jobId: 'job', epoch: 'epoch', generation: 1, planDigest: evidence.planDigest, invocationId: evidence.invocationId, provider: 'office', pid: 123, birth: '638000000000000000', executable: 'c:\\owned\\excel.exe' });
    expect(envelope.body).not.toContain(evidence.evidenceKey);
  });
  it.runIf(process.platform === 'win32')('records bounded actual Office finally diagnostics without creating Office', async () => {
    const f = await fixture();
    const provider = fileURLToPath(new URL('../../../apps/desktop/build/gotzji-native-office.ps1', import.meta.url)).replaceAll("'", "''");
    const root = Buffer.from(f.root).toString('base64');
    const script = `
      $ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
      $tokens=$null; $parseErrors=$null
      $tree=[Management.Automation.Language.Parser]::ParseFile('${provider}',[ref]$tokens,[ref]$parseErrors)
      if($parseErrors.Count -ne 0){throw ($parseErrors|Out-String)}
      $outer=@($tree.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst] -and $null -ne $_.Finally})
      if($outer.Count -ne 1){throw 'Outer cleanup identity changed'}
      $cleanupBlock=[scriptblock]::Create(($outer[0].Finally.Statements|ForEach-Object {$_.Extent.Text}) -join "\n")
      $definition=@($tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'As-Json'},$true))
      if($definition.Count -ne 1){throw 'JSON function identity changed'}
      Invoke-Expression $definition[0].Extent.Text
      Add-Type -TypeDefinition 'public static class GotzjiNativeEvidenceJournal { public static string Journal; public static string Root; public static string Line; public static System.Collections.Generic.List<string> Events=new System.Collections.Generic.List<string>(); public static void Append(string journal, string root, string line) { Events.Add("journal.append"); Journal=journal; Root=root; Line=line; } }'
      function Release-Com($Value){[GotzjiNativeEvidenceJournal]::Events.Add('release.'+$Value.Kind)}
      $processEvidence=[pscustomobject]@{jobId='job';effectRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${root}'))}
      $script:ownedPid=123; $provider='excel'; $results=@()
      foreach($scenario in @('close-throws','count-throws','remaining','quit-throws','success','identity-close','identity-close-throws','no-owned-pid')){
        [GotzjiNativeEvidenceJournal]::Events.Clear()
        [GotzjiNativeEvidenceJournal]::Line=''
        $script:ownedPid=if($scenario -eq 'no-owned-pid'){0}else{123}
        $identityDocument=$null
        if($scenario -in @('identity-close','identity-close-throws')){
          $identityDocument=[pscustomobject]@{Kind='identity';Throws=($scenario -eq 'identity-close-throws')}
          $identityDocument|Add-Member ScriptMethod Close {param($saveChanges) [GotzjiNativeEvidenceJournal]::Events.Add('identity.close.'+$saveChanges);if($this.Throws){throw 'PRIVATE-IDENTITY-DETAIL'}}
        }
        $document=[pscustomobject]@{Kind='document';Throws=($scenario -eq 'close-throws');SaveChanges=$null}
        $document|Add-Member ScriptMethod Close {param($saveChanges) [GotzjiNativeEvidenceJournal]::Events.Add('document.close');$this.SaveChanges=$saveChanges;if($this.Throws){throw 'PRIVATE-CLOSE-DETAIL'}}
        $books=[pscustomobject]@{Throws=($scenario -eq 'count-throws');Remaining=if($scenario -eq 'remaining'){1}else{0}}
        $books|Add-Member ScriptProperty Count {[GotzjiNativeEvidenceJournal]::Events.Add('workbooks.count');if($this.Throws){throw 'PRIVATE-COUNT-DETAIL'};return $this.Remaining}
        $application=[pscustomobject]@{Kind='application';Workbooks=$books;Throws=($scenario -eq 'quit-throws')}
        $application|Add-Member ScriptMethod Quit {[GotzjiNativeEvidenceJournal]::Events.Add('application.quit');if($this.Throws){throw 'PRIVATE-QUIT-DETAIL'}}
        & $cleanupBlock
        $results += [ordered]@{scenario=$scenario;events=@([GotzjiNativeEvidenceJournal]::Events);saveChanges=$document.SaveChanges;journalPath=[GotzjiNativeEvidenceJournal]::Journal;effectRoot=[GotzjiNativeEvidenceJournal]::Root;line=[GotzjiNativeEvidenceJournal]::Line}
      }
      [Console]::Write((ConvertTo-Json -InputObject $results -Depth 10 -Compress))
    `;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
    const results = JSON.parse(stdout) as { scenario: string; events: string[]; saveChanges: boolean; journalPath: string; effectRoot: string; line: string }[];
    const expected = [
      { scenario: 'close-throws', closed: false, closeError: true, remaining: 0, quitRequested: true, quitError: false },
      // PowerShell suppresses the getter exception into null; the diagnostic must preserve unknown instead of casting it to zero.
      { scenario: 'count-throws', closed: true, closeError: false, remaining: -1, quitRequested: false, quitError: false },
      { scenario: 'remaining', closed: true, closeError: false, remaining: 1, quitRequested: false, quitError: false },
      { scenario: 'quit-throws', closed: true, closeError: false, remaining: 0, quitRequested: false, quitError: true },
      { scenario: 'success', closed: true, closeError: false, remaining: 0, quitRequested: true, quitError: false },
      { scenario: 'identity-close', closed: true, closeError: false, remaining: 0, quitRequested: true, quitError: false },
      { scenario: 'identity-close-throws', closed: true, closeError: true, remaining: 0, quitRequested: true, quitError: false },
    ];
    expect(results).toHaveLength(expected.length + 1);
    for (const [index, { scenario, ...flags }] of expected.entries()) {
      const result = results[index]!;
      expect(result).toMatchObject({ scenario, saveChanges: false, journalPath: path.join(f.root, 'native-cleanup-diagnostic.jsonl'), effectRoot: f.root });
      expect(result.events).toEqual([...(scenario.startsWith('identity-close') ? ['identity.close.False', 'release.identity'] : []), 'document.close', 'release.document', 'workbooks.count', ...(['count-throws', 'remaining'].includes(scenario) ? [] : ['application.quit']), 'release.application', 'journal.append']);
      expect(JSON.parse(result.line)).toEqual({ schemaVersion: 1, jobId: 'job', pid: 123, ...flags });
      expect(result.line).not.toMatch(/PRIVATE-|DETAIL|exception|token|evidenceKey/u);
    }
    expect(results.at(-1)).toMatchObject({ scenario: 'no-owned-pid', line: '', events: ['document.close', 'release.document', 'workbooks.count', 'release.application'] });
  });
  it('keeps Windows native prerequisites while excluding inherited credentials and incompatible module paths', () => {
    const environment = gotzjiNativeChildEnvironment({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Owner', CLAUDE_API_KEY: 'private', SOME_AUTH: 'private', NODE_OPTIONS: 'untrusted-loader', PSModulePath: 'PowerShell-7-modules' });
    expect(environment.USERPROFILE).toBe('C:\\Owner');
    expect(environment.PSModulePath).toContain('WindowsPowerShell');
    expect(environment.CLAUDE_API_KEY).toBeUndefined(); expect(environment.SOME_AUTH).toBeUndefined(); expect(environment.NODE_OPTIONS).toBeUndefined();
  });
  it('requires an authentic host grant and provider pin before invoking native code', async () => {
    const f = await fixture(); const runner = vi.fn(); const beforeProviderSpawn = vi.fn(async () => undefined);
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => false, beforeProviderSpawn, runner });
    await expect(adapter.execute(f.grant, input(f.source, f.output))).rejects.toThrow('NATIVE_AUTHORITY_DENIED');
    expect(runner).not.toHaveBeenCalled(); expect(beforeProviderSpawn).not.toHaveBeenCalled();
    const wrongPin = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: '0'.repeat(64), verifyGrant: async (): Promise<boolean> => true, runner });
    await expect(wrongPin.execute(f.grant, input(f.source, f.output))).rejects.toThrow('NATIVE_PROVIDER_CHANGED');
    expect(runner).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'win32')('requires and completes the trusted dispatch callback before the default runner can spawn', async () => {
    const boundary = Object.assign(new Error('SIGNED_DISPATCH_BOUNDARY_REFUSED'), { code: 'SIGNED_DISPATCH_BOUNDARY_REFUSED' });
    await expect(runGotzjiNativePowerShell('Z:\\path-that-must-not-spawn\\provider.ps1', {}, undefined, undefined, async () => { throw boundary; })).rejects.toBe(boundary);
    await expect(runGotzjiNativePowerShell('Z:\\path-that-must-not-spawn\\provider.ps1', {})).rejects.toMatchObject({ code: 'NATIVE_DISPATCH_BOUNDARY_REQUIRED' });
  });
  it.runIf(process.platform === 'win32')('spawns then stops when abort races the dispatch callback or listener registration', async () => {
    const duringCallback = new AbortController(); const first = fakeChild(); const firstStart = vi.fn(() => first);
    await expect(runGotzjiNativePowerShell('synthetic.ps1', {}, duringCallback.signal, undefined, async () => { duringCallback.abort(); }, firstStart)).rejects.toMatchObject({ code: 'NATIVE_TERMINATION_UNVERIFIED', outcome: 'unknown' });
    expect(firstStart).toHaveBeenCalledTimes(1); expect(first.kill).toHaveBeenCalledTimes(1);

    let aborted = false; const listenerRace = { get aborted(): boolean { return aborted; }, addEventListener: (): void => { aborted = true; }, removeEventListener: (): void => undefined } as unknown as AbortSignal;
    const second = fakeChild(); const secondStart = vi.fn(() => second); const boundary = vi.fn(async () => undefined);
    await expect(runGotzjiNativePowerShell('synthetic.ps1', {}, listenerRace, undefined, boundary, secondStart)).rejects.toMatchObject({ code: 'NATIVE_TERMINATION_UNVERIFIED', outcome: 'unknown' });
    expect(boundary).toHaveBeenCalledTimes(1); expect(secondStart).toHaveBeenCalledTimes(1); expect(second.kill).toHaveBeenCalledTimes(1);
  });
  it.runIf(process.platform === 'win32')('records the boundary before a synchronous helper spawn refusal', async () => {
    const boundary = vi.fn(async () => undefined); const start = vi.fn(() => { throw new Error('synthetic spawn refusal'); });
    await expect(runGotzjiNativePowerShell('synthetic.ps1', {}, undefined, undefined, boundary, start)).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_START_FAILED', outcome: 'none', confirmedNoProviderProcess: true, noLaunchReason: 'synchronous-spawn-throw' });
    expect(boundary).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });
  it.runIf(process.platform === 'win32')('tags only an asynchronous ENOENT with no spawn event or usable PID as no-launch', async () => {
    const boundary = vi.fn(async () => undefined); const child = fakeChild();
    const start = vi.fn(() => { void Promise.resolve().then(() => child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }))); return child; });
    await expect(runGotzjiNativePowerShell('synthetic.ps1', {}, undefined, undefined, boundary, start)).rejects.toMatchObject({ code: 'NATIVE_PROVIDER_START_FAILED', confirmedNoProviderProcess: true, noLaunchReason: 'spawn-error-no-pid' });
    expect(boundary).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
  });
  it('denies stale bytes, existing output, invalid matrices and unexpected/raw fields without changing originals', async () => {
    const f = await fixture();
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), expectedSha256: '0'.repeat(64) }, f.root)).rejects.toThrow('NATIVE_FILE_VERSION_CONFLICT');
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), values: ['after'] }, f.root)).rejects.toThrow('values');
    await expect(planGotzjiNativeOperation({ ...input(f.source, f.output), executable: 'anything' }, f.root)).rejects.toThrow('NATIVE_INPUT_INVALID');
    await writeFile(f.output, 'existing');
    await expect(planGotzjiNativeOperation(input(f.source, f.output), f.root)).rejects.toThrow('NATIVE_OUTPUT_EXISTS');
    expect(await readFile(f.source, 'utf8')).toBe('original'); expect(await readFile(f.output, 'utf8')).toBe('existing');
  });
  it('derives document/provider resources and rejects output targets outside the enrolled project', async () => {
    const f = await fixture();
    const plan = await planGotzjiNativeOperation(input(f.source, f.output), f.root);
    expect(plan.resourceKeys).toHaveLength(3); expect(plan.resourceKeys[0]).toBe('native-provider:excel');
    await expect(planGotzjiNativeOperation(input(f.source, path.join(qualificationRoot, 'outside.xlsx')), f.root)).rejects.toThrow('NATIVE_SCOPE_DENIED');
  });
  it('keeps the private process-evidence binding outside input and binds one Office invocation to the native plan', async () => {
    const f = await fixture(); const plan = await planGotzjiNativeOperation(input(f.source, f.output), f.root); let observed: unknown;
    const processEvidence = { schemaVersion: 1 as const, effectRoot: f.root, journalPath: path.join(f.root, 'native-process-identities.jsonl'), jobId: 'job', epoch: 'epoch', generation: 1, planDigest: plan.digest, provider: 'office' as const, evidenceKey: 'a'.repeat(64) };
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true, processEvidence,
      runner: async (_script, providerInput, _signal, evidence): Promise<unknown> => {
        observed = { providerInput, evidence }; await writeFile(f.output, 'after');
        return { operation: 'excel.range.write', provider: 'excel', providerVersion: '16.0', nativePid: 123, sourceSha256: nativeBytesDigest(Buffer.from('original')), outputSha256: nativeBytesDigest(Buffer.from('after')), originalPreserved: true, savedAndReopened: true, unrelatedPreserved: true, verified: true, before: {}, after: {} };
      } });
    await expect(adapter.execute(f.grant, input(f.source, f.output))).resolves.toMatchObject({ verified: true });
    expect(observed).toMatchObject({ providerInput: { operation: 'excel.range.write' }, evidence: { ...processEvidence, provider: 'office' } });
    expect((observed as { evidence: { invocationId: string } }).evidence.invocationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify((observed as { providerInput: unknown }).providerInput)).not.toContain('evidenceKey');
  });
  it('independently checks original and returned output hashes rather than accepting preservation flags', async () => {
    const f = await fixture();
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true,
      runner: async (): Promise<unknown> => {
        await writeFile(f.output, 'wrong result');
        return { operation: 'excel.range.write', provider: 'excel', providerVersion: '16.0', nativePid: 123, sourceSha256: nativeBytesDigest(Buffer.from('original')), outputSha256: '0'.repeat(64), originalPreserved: true, savedAndReopened: true, unrelatedPreserved: true, verified: true, before: {}, after: {} };
      } });
    await expect(adapter.execute(f.grant, input(f.source, f.output))).rejects.toMatchObject({ code: 'NATIVE_PRESERVATION_FAILED', outcome: 'unknown' });
    expect(await readFile(f.source, 'utf8')).toBe('original');
  });
  it('aborting before provider startup does not invoke it or claim an effect', async () => {
    const f = await fixture(); const runner = vi.fn(); const signal = AbortSignal.abort();
    const adapter = new GotzjiNativeAdapter({ scriptPath: f.script, scriptSha256: nativeBytesDigest(Buffer.from('pinned provider')), verifyGrant: async (): Promise<boolean> => true, runner });
    await expect(adapter.execute(f.grant, input(f.source, f.output), signal)).rejects.toMatchObject({ code: 'NATIVE_CANCELLED_BEFORE_START', outcome: 'none' });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('gotzji selected browser admission', () => {
  it('rejects a changed selected tab document before dispatch', async () => {
    const f = await fixture(); const dispatch = vi.fn();
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs: async () => [{ id: 'tab', type: 'page', title: 'Fixture', url: 'https://changed.example' }], newTab: vi.fn(), closeTab: vi.fn(), request: dispatch };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => true);
    await expect(adapter.execute(f.grant, { operation: 'browser.query', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#input' })).rejects.toThrow('BROWSER_DOCUMENT_CHANGED');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires a verified grant before reading browser tabs', async () => {
    const f = await fixture(); const listTabs = vi.fn();
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs, newTab: vi.fn(), closeTab: vi.fn(), request: vi.fn() };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => false);
    await expect(adapter.execute(f.grant, { operation: 'browser.query', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#input' })).rejects.toThrow('NATIVE_AUTHORITY_DENIED');
    expect(listTabs).not.toHaveBeenCalled();
  });
  it('dispatches only a selected typed click and independently observes its postcondition', async () => {
    const f = await fixture(); let text = 'before'; const expressions: string[] = [];
    const protocol: BrowserCdpProtocol = { status: async () => ({ ready: true, port: 1 }), listTabs: async () => [{ id: 'tab', type: 'page', title: 'Fixture', url: 'https://selected.example' }], newTab: vi.fn(), closeTab: vi.fn(),
      request: async (tabId, method, params) => {
        expect(tabId).toBe('tab'); expect(method).toBe('Runtime.evaluate');
        const expression = String(params.expression); expressions.push(expression);
        if (expression.includes('el.click()')) { text = 'after'; return { result: { result: { value: { ok: true } } } }; }
        return { result: { result: { value: { ok: true, text, tag: 'BUTTON' } } } };
      } };
    const adapter = new GotzjiNativeBrowserAdapter(protocol, async () => true);
    await expect(adapter.execute(f.grant, { operation: 'browser.click', tabId: 'tab', expectedUrl: 'https://selected.example', selector: '#button', postSelector: '#state', expectedPostText: 'after' })).resolves.toMatchObject({ tabId: 'tab', verified: true });
    expect(expressions).toHaveLength(3); expect(expressions.every((expression) => expression.includes('location.href'))).toBe(true);
  });
});
