import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { processIdentities, sameProcessIdentity } from '../../../packages/execution-core/src/process-identity.mjs';

/** Read back only the synthetic Office package selected by the native qualification. */
export async function readOfficePackage(powershell: string, filename: string, xmlPath: string, mediaPrefix: string): Promise<{ readonly xml: string; readonly media: readonly Buffer[] }> {
  const script = `
    $ErrorActionPreference='Stop'
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    $inputReader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8)
    $request=$inputReader.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $archive=[IO.Compression.ZipFile]::OpenRead([string]$request.filename)
    function Read-Entry($entry) {
      if ($null -eq $entry -or $entry.Length -gt 1048576) { throw 'Synthetic entry missing or unexpectedly large' }
      $inputStream=$entry.Open(); $memory=[IO.MemoryStream]::new()
      try { $inputStream.CopyTo($memory); return ,$memory.ToArray() } finally { $inputStream.Dispose(); $memory.Dispose() }
    }
    try {
      $xml=[Text.Encoding]::UTF8.GetString((Read-Entry ($archive.GetEntry([string]$request.xmlPath))))
      $media=@($archive.Entries | Where-Object { $_.FullName.StartsWith([string]$request.mediaPrefix) -and -not $_.FullName.EndsWith('/') } | ForEach-Object { [Convert]::ToBase64String((Read-Entry $_)) })
      [Console]::Write(([ordered]@{xml=$xml;media=$media} | ConvertTo-Json -Compress))
    } finally { $archive.Dispose() }
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end(JSON.stringify({ filename, xmlPath, mediaPrefix }));
  });
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !('xml' in value) || typeof value.xml !== 'string' || !('media' in value) || !Array.isArray(value.media) || value.media.some(entry => typeof entry !== 'string')) throw new Error('Synthetic Office package read-back malformed');
  return { xml: value.xml, media: value.media.map(entry => Buffer.from(String(entry), 'base64')) };
}

/** The existing provider journal binds each PID/birth/executable to this admitted owned job. */
export async function proveOfficeProcessesAbsent(dataRoot: string, jobIds: readonly string[], executableName: string): Promise<void> {
  for (const jobId of jobIds) {
    if (!/^[a-f0-9]{64}$/u.test(jobId)) throw new Error('Unexpected native fixture job identity');
    const journal = await readFile(path.join(dataRoot, 'runtime', 'effects', jobId, 'native-process-identities.jsonl'), 'utf8');
    const identities = journal.trim().split(/\r?\n/u).map(line => {
      const envelope = JSON.parse(line) as { body: string };
      const value = JSON.parse(envelope.body) as { provider: string; jobId: string; pid: number; birth: string; executable: string };
      if (value.provider !== 'office' || value.jobId !== jobId || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^\d+$/u.test(value.birth) || path.basename(value.executable).toLowerCase() !== executableName) throw new Error('Native fixture process journal mismatch');
      return value;
    });
    if (identities.length === 0) throw new Error('Native fixture process journal empty');
    for (let observation = 0; observation < 2; observation++) {
      const current = await processIdentities(identities.map(value => value.pid));
      for (const identity of identities) if (current[identity.pid] === 'unknown' || current[identity.pid] === undefined || sameProcessIdentity(identity, current[identity.pid])) throw new Error('Owned Office process absence unproved');
    }
  }
}