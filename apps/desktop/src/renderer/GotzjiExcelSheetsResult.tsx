import type { ReactElement } from 'react';
import { isExcelSheetsSnapshot, type ExcelSheetMetadata, type ExcelSheetsSnapshot } from '@lnwjud/capabilities/gotzji-excel-sheets';

export interface ExcelSheetsResult {
  readonly projectId: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly snapshot: ExcelSheetsSnapshot;
}
/** Display only; Core verified the saved receipt before returning this result. */
export function excelSheetsResult(value: unknown): ExcelSheetsResult | undefined {
  if (!record(value) || !record(value.output) || value.operation !== 'excel.sheets.inspect' || value.output.operation !== 'excel.sheets.inspect'
    || typeof value.output.projectId !== 'string' || value.output.projectId !== value.projectId || typeof value.output.path !== 'string') return undefined;
  const receipt = value.output.nativeReceipt;
  if (!record(receipt) || receipt.operation !== 'excel.sheets.inspect' || receipt.provider !== 'excel' || receipt.verified !== true
    || receipt.originalPreserved !== true || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sourceSha256)
    || !isExcelSheetsSnapshot(receipt.after)) return undefined;
  return { projectId: value.output.projectId, path: value.output.path, sourceSha256: receipt.sourceSha256, snapshot: receipt.after };
}

export function GotzjiExcelSheetsResult({ value, disabled, select }: {
  readonly value: ExcelSheetsResult;
  readonly disabled: boolean;
  readonly select: (sheet: ExcelSheetMetadata) => void;
}): ReactElement {
  const { snapshot } = value;
  return <section aria-label="รายชื่อแผ่นงาน Excel"><h4>แผ่นงานใน {value.path}</h4>
    <p>พบ {snapshot.total} แผ่นงาน · แสดง {snapshot.returned} แผ่นงาน{snapshot.truncated ? ' · แสดงได้บางส่วน' : ''}</p>
    <p>ช่วงที่ Excel รายงานอาจรวมเซลล์ว่างที่มีรูปแบบ แถวและคอลัมน์เป็นขนาดของช่วงนี้ ไม่ใช่จำนวนเซลล์ที่มีข้อมูลค่ะ</p>
    {snapshot.returned === 0 ? <p>ไฟล์นี้ไม่มีแผ่นงานแบบเซลล์</p> : <table><thead><tr><th>แผ่นงาน</th><th>ช่วงที่ Excel รายงาน</th><th>แถว</th><th>คอลัมน์</th><th>อ่านต่อ</th></tr></thead><tbody>{snapshot.sheets.map((sheet) => {
      const first = sheet.used_range.split(':')[0]!;
      return <tr key={sheet.name}><td>{sheet.name}</td><td>{sheet.used_range}</td><td>{sheet.rows}</td><td>{sheet.columns}</td><td><button disabled={disabled} onClick={() => select(sheet)}>เตรียมอ่านเซลล์แรก {first} ใน {sheet.name}</button></td></tr>;
    })}</tbody></table>}
  </section>;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
