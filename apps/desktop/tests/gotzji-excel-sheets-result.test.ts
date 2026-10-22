import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { excelSheetsResult, GotzjiExcelSheetsResult } from '../src/renderer/GotzjiExcelSheetsResult.js';

function result(snapshot: unknown): unknown {
  return { operation: 'excel.sheets.inspect', projectId: 'project', output: { operation: 'excel.sheets.inspect', projectId: 'project', path: 'book.xlsx', nativeReceipt: { operation: 'excel.sheets.inspect', provider: 'excel', verified: true, originalPreserved: true, sourceSha256: 'a'.repeat(64), after: snapshot } } };
}
describe('Excel sheet result presentation', () => {
  it('shows named worksheet extents and explicitly prepares only the first cell without starting work', () => {
    const value = excelSheetsResult(result({ sheets: [{ name: 'ข้อมูล', used_range: 'B2:D4', rows: 3, columns: 3 }], total: 1, returned: 1, truncated: false }));
    expect(value).toMatchObject({ projectId: 'project', path: 'book.xlsx', snapshot: { total: 1 } });
    const html = renderToStaticMarkup(createElement(GotzjiExcelSheetsResult, { value: value!, disabled: false, select: () => { throw new Error('Rendering must not select or start work'); } }));
    expect(html).toContain('B2:D4'); expect(html).toContain('เตรียมอ่านเซลล์แรก B2 ใน ข้อมูล'); expect(html).toContain('ไม่ใช่จำนวนเซลล์ที่มีข้อมูล');
    expect(html).not.toContain('<pre>'); expect(html).toContain('<table>');
  });
  it('shows an empty worksheet list and truthful truncation rather than inventing missing rows', () => {
    const empty = excelSheetsResult(result({ sheets: [], total: 0, returned: 0, truncated: false }))!;
    expect(renderToStaticMarkup(createElement(GotzjiExcelSheetsResult, { value: empty, disabled: true, select: () => undefined }))).toContain('ไม่มีแผ่นงานแบบเซลล์');
    const snapshot = { sheets: Array.from({ length: 256 }, (_, index) => ({ name: `Sheet${index}`, used_range: 'A1', rows: 1, columns: 1 })), total: 300, returned: 256, truncated: true };
    const html = renderToStaticMarkup(createElement(GotzjiExcelSheetsResult, { value: excelSheetsResult(result(snapshot))!, disabled: true, select: () => undefined }));
    expect(html).toContain('พบ 300 แผ่นงาน'); expect(html).toContain('แสดง 256 แผ่นงาน'); expect(html).toContain('แสดงได้บางส่วน');
  });
  it('rejects malformed, mismatched and unverified result envelopes', () => {
    expect(excelSheetsResult(result({ sheets: [], total: 1, returned: 0, truncated: true }))).toBeUndefined();
    expect(excelSheetsResult({ operation: 'excel.sheets.inspect', projectId: 'foreign', output: { projectId: 'project' } })).toBeUndefined();
    expect(excelSheetsResult(result({ sheets: [{ name: 'S', used_range: 'A1', rows: -1, columns: 1 }], total: 1, returned: 1, truncated: false }))).toBeUndefined();
  });
});
