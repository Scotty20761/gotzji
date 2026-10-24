import type { ReactElement } from 'react';

export const EXCEL_RANGE_RESULT_PAGE_SIZE = 100;

export type ExcelRangeScalar = string | number | boolean | null;

export interface ExcelRangeCellResult {
  readonly sheet: string;
  readonly address: string;
  readonly value: ExcelRangeScalar;
  readonly formula: ExcelRangeScalar;
  readonly format: string;
  readonly bold: boolean;
}

export interface ExcelRangeResult {
  readonly jobId: string;
  readonly projectId: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly requestedSheet: string;
  readonly requestedRange: string;
  readonly normalizedRange: string;
  readonly observedSheet: string | null;
  readonly cells: readonly ExcelRangeCellResult[];
}

interface CellReference {
  readonly address: string;
  readonly column: number;
  readonly row: number;
}

interface RangeBounds {
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly normalized: string;
  readonly area: number;
}

/** Display only; Core verified the saved receipt and projected nativeSelection before returning this result. */
export function excelRangeResult(value: unknown, selectedJobId: string): ExcelRangeResult | undefined {
  if (!selectedJobId || !record(value) || !record(value.output) || !record(value.nativeSelection)
    || value.operation !== 'excel.range.read' || value.output.operation !== 'excel.range.read'
    || typeof value.projectId !== 'string' || !value.projectId || value.output.projectId !== value.projectId
    || value.output.state !== 'completed' || value.output.jobId !== selectedJobId
    || typeof value.output.path !== 'string' || !value.output.path
    || typeof value.nativeSelection.sheet !== 'string' || !value.nativeSelection.sheet
    || typeof value.nativeSelection.range !== 'string') return undefined;

  const bounds = rangeBounds(value.nativeSelection.range);
  if (!bounds || bounds.area > 10_000) return undefined;

  const receipt = value.output.nativeReceipt;
  if (!record(receipt) || receipt.operation !== 'excel.range.read' || receipt.provider !== 'excel'
    || receipt.verified !== true || receipt.originalPreserved !== true || receipt.unrelatedPreserved !== true
    || receipt.outputSha256 !== null || receipt.savedAndReopened !== false
    || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.sourceSha256)
    || !record(receipt.after) || !Array.isArray(receipt.after.selected) || receipt.after.selected.length > 10_000) return undefined;

  const cells: ExcelRangeCellResult[] = [];
  const addresses = new Set<string>();
  let observedSheet: string | null = null;
  for (const candidate of receipt.after.selected) {
    if (!record(candidate) || typeof candidate.sheet !== 'string' || !candidate.sheet
      || typeof candidate.address !== 'string' || typeof candidate.format !== 'string'
      || typeof candidate.bold !== 'boolean' || !scalar(candidate.value) || !scalar(candidate.formula)) return undefined;
    const reference = canonicalCellReference(candidate.address);
    if (!reference || reference.column < bounds.firstColumn || reference.column > bounds.lastColumn
      || reference.row < bounds.firstRow || reference.row > bounds.lastRow || addresses.has(reference.address)) return undefined;
    if (observedSheet === null) observedSheet = candidate.sheet;
    else if (candidate.sheet !== observedSheet) return undefined;
    addresses.add(reference.address);
    cells.push({
      sheet: candidate.sheet,
      address: reference.address,
      value: candidate.value,
      formula: candidate.formula,
      format: candidate.format,
      bold: candidate.bold,
    });
  }

  return {
    jobId: selectedJobId,
    projectId: value.projectId,
    path: value.output.path,
    sourceSha256: receipt.sourceSha256,
    requestedSheet: value.nativeSelection.sheet,
    requestedRange: value.nativeSelection.range,
    normalizedRange: bounds.normalized,
    observedSheet,
    cells,
  };
}

export function GotzjiExcelRangeResult({ value, pageIndex, pageChanged }: {
  readonly value: ExcelRangeResult;
  readonly pageIndex: number;
  readonly pageChanged: (pageIndex: number) => void;
}): ReactElement {
  const pageCount = Math.ceil(value.cells.length / EXCEL_RANGE_RESULT_PAGE_SIZE);
  const selectedPage = pageCount === 0 ? 0 : Math.min(Number.isSafeInteger(pageIndex) && pageIndex >= 0 ? pageIndex : 0, pageCount - 1);
  const start = selectedPage * EXCEL_RANGE_RESULT_PAGE_SIZE;
  const cells = value.cells.slice(start, start + EXCEL_RANGE_RESULT_PAGE_SIZE);

  return <section aria-label="ผลการอ่านช่วงเซลล์ Excel">
    <h4>ผลการอ่านช่วงเซลล์ Excel</h4>
    <dl>
      <dt>ไฟล์ที่ขออ่าน</dt><dd>{value.path}</dd>
      <dt>แผ่นงานที่ขอ</dt><dd>{value.requestedSheet}</dd>
      <dt>ช่วงที่ขอ</dt><dd>{value.requestedRange}</dd>
      <dt>แผ่นงานที่ Excel รายงาน</dt><dd>{value.observedSheet ?? 'ไม่มีรายการเซลล์ให้ระบุ'}</dd>
    </dl>
    <p>Excel ส่งกลับ {value.cells.length} รายการ · ค่าที่แสดงเป็นค่าดิบ Value2</p>
    <p>ผลอาจมีเฉพาะเซลล์ที่อยู่ใน UsedRange ระบบไม่เติมช่องว่างที่ไม่ได้ส่งกลับ และไม่สรุปว่าครบทุกเซลล์ในช่วงที่ขอค่ะ</p>
    {value.cells.length === 0 ? <p>Excel ไม่ส่งกลับรายการเซลล์สำหรับช่วงนี้</p> : <>
      <table><thead><tr><th>ตำแหน่งเซลล์</th><th>ค่าดิบ (Value2)</th></tr></thead><tbody>{cells.map((cell) => <tr key={cell.address}>
        <td>{cell.address}</td><td>{scalarText(cell.value)}</td>
      </tr>)}</tbody></table>
      {pageCount > 1 && <nav aria-label="แบ่งหน้าผลการอ่านช่วงเซลล์ Excel">
        <button type="button" aria-label="หน้าก่อนหน้าของผลการอ่านช่วงเซลล์" disabled={selectedPage === 0} onClick={() => pageChanged(selectedPage - 1)}>ก่อนหน้า</button>
        <span aria-live="polite">หน้า {selectedPage + 1} จาก {pageCount}</span>
        <button type="button" aria-label="หน้าถัดไปของผลการอ่านช่วงเซลล์" disabled={selectedPage + 1 >= pageCount} onClick={() => pageChanged(selectedPage + 1)}>ถัดไป</button>
      </nav>}
    </>}
  </section>;
}

function rangeBounds(value: string): RangeBounds | undefined {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/u.exec(value);
  if (!match) return undefined;
  const first = cellReference(match[1]!, match[2]!);
  const second = cellReference(match[3] ?? match[1]!, match[4] ?? match[2]!);
  if (!first || !second) return undefined;
  const firstColumn = Math.min(first.column, second.column);
  const lastColumn = Math.max(first.column, second.column);
  const firstRow = Math.min(first.row, second.row);
  const lastRow = Math.max(first.row, second.row);
  const area = (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1);
  const normalizedFirst = `${columnName(firstColumn)}${firstRow}`;
  const normalizedLast = `${columnName(lastColumn)}${lastRow}`;
  return { firstColumn, lastColumn, firstRow, lastRow, area, normalized: match[3] === undefined ? normalizedFirst : `${normalizedFirst}:${normalizedLast}` };
}

function canonicalCellReference(value: string): CellReference | undefined {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(value);
  if (!match) return undefined;
  const parsed = cellReference(match[1]!, match[2]!);
  return parsed?.address === value ? parsed : undefined;
}

function cellReference(columnText: string, rowText: string): CellReference | undefined {
  let column = 0;
  for (const character of columnText) column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(rowText);
  if (column < 1 || column > 16_384 || !Number.isSafeInteger(row) || row < 1 || row > 1_048_576) return undefined;
  return { address: `${columnName(column)}${row}`, column, row };
}

function columnName(value: number): string {
  let column = value;
  let result = '';
  while (column > 0) {
    column -= 1;
    result = String.fromCharCode(65 + column % 26) + result;
    column = Math.floor(column / 26);
  }
  return result;
}

function scalar(value: unknown): value is ExcelRangeScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}

function scalarText(value: ExcelRangeScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
