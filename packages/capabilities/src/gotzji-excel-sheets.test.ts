import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isExcelSheetsSnapshot } from './gotzji-excel-sheets.js';

describe('bounded Excel worksheet metadata', () => {
  it('checks empty, truncated and malformed metadata without treating formatted extents as cell counts', () => {
    expect(isExcelSheetsSnapshot({ sheets: [], total: 0, returned: 0, truncated: false })).toBe(true);
    expect(isExcelSheetsSnapshot({ sheets: [{ name: 'ข้อมูล', used_range: 'B2:D4', rows: 3, columns: 3 }], total: 1, returned: 1, truncated: false })).toBe(true);
    for (const row of [{ name: 'S', used_range: 'B2:A1', rows: 1, columns: 1 }, { name: 'S', used_range: 'A1048577', rows: 1, columns: 1 }, { name: 'S', used_range: 'A1:B1', rows: 1, columns: 1 }]) expect(isExcelSheetsSnapshot({ sheets: [row], total: 1, returned: 1, truncated: false })).toBe(false);
    expect(isExcelSheetsSnapshot({ sheets: [{ name: 'S', used_range: 'A1', rows: 1, columns: 1 }, { name: 's', used_range: 'A1', rows: 1, columns: 1 }], total: 2, returned: 2, truncated: false })).toBe(false);
  });
  it.skipIf(process.platform !== 'win32')('executes the actual Office metadata function with empty and over-cap collections without creating Office', async () => {
    const provider = fileURLToPath(new URL('../../../apps/desktop/build/gotzji-native-office.ps1', import.meta.url)).replaceAll("'", "''");
    const script = `
      $ErrorActionPreference='Stop'; Set-StrictMode -Off
      $tokens=$null; $parseErrors=$null
      $tree=[Management.Automation.Language.Parser]::ParseFile('${provider}',[ref]$tokens,[ref]$parseErrors)
      if($parseErrors.Count -ne 0){throw ($parseErrors|Out-String)}
      foreach($name in @('Fail','Release-Com','Excel-SheetsSnapshot')){
        $definition=$tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
        if($definition.Count -ne 1){throw 'Function identity changed'}
        Invoke-Expression $definition[0].Extent.Text
      }
      class MetadataSheets {
        [int]$Count
        MetadataSheets([int]$count){$this.Count=$count}
        [object] Item([int]$index){
          $used=[pscustomobject]@{Rows=[pscustomobject]@{Count=3};Columns=[pscustomobject]@{Count=3}}
          $used|Add-Member -MemberType ScriptMethod -Name Address -Value {param($absoluteRow,$absoluteColumn) return 'B2:D4'}
          return [pscustomobject]@{Name='Sheet'+$index;UsedRange=$used}
        }
      }
      $snapshots=@()
      foreach($count in @(0,1,257)){$book=[pscustomobject]@{Worksheets=[MetadataSheets]::new($count)};$snapshots+=Excel-SheetsSnapshot $book}
      Add-Type -TypeDefinition '
        public sealed class UnavailableMetadataSheets {
          readonly string mode;
          public UnavailableMetadataSheets(string mode) { this.mode=mode; }
          public object Count { get { if(mode=="count-throws")throw new System.InvalidOperationException("synthetic-count-getter-refused"); return null; } }
          public object Item(int index) { throw new System.InvalidOperationException("unexpected-item-access"); }
        }
        public sealed class UnavailableMetadataBook {
          readonly string mode;
          public UnavailableMetadataBook(string mode) { this.mode=mode; }
          public object Worksheets { get { if(mode=="worksheets-throws")throw new System.InvalidOperationException("synthetic-worksheets-getter-refused"); if(mode=="worksheets-null")return null; return new UnavailableMetadataSheets(mode); } }
        }'
      $unavailable=@()
      foreach($scenario in @('count-throws','count-null','worksheets-throws','worksheets-null')){
        try { Excel-SheetsSnapshot ([UnavailableMetadataBook]::new($scenario))|Out-Null; $unavailable += [ordered]@{scenario=$scenario;ok=$true} }
        catch { $unavailable += [ordered]@{scenario=$scenario;ok=$false;code=$_.Exception.Message} }
      }
      [Console]::Write(([ordered]@{snapshots=$snapshots;unavailable=$unavailable}|ConvertTo-Json -Depth 10 -Compress))
    `;
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
    const { snapshots, unavailable } = JSON.parse(stdout) as { snapshots: unknown[]; unavailable: { scenario: string; ok: boolean; code?: string }[] };
    expect(snapshots).toHaveLength(3); expect(snapshots.every(isExcelSheetsSnapshot)).toBe(true);
    expect(snapshots[0]).toMatchObject({ total: 0, returned: 0, sheets: [], truncated: false });
    expect(snapshots[2]).toMatchObject({ total: 257, returned: 256, truncated: true });
    expect(unavailable).toEqual(['count-throws', 'count-null', 'worksheets-throws', 'worksheets-null'].map((scenario) => ({ scenario, ok: false, code: 'NATIVE_WORKSHEET_METADATA_UNAVAILABLE' })));
  });
});
