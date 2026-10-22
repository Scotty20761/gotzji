export interface ExcelSheetMetadata { readonly name: string; readonly used_range: string; readonly rows: number; readonly columns: number }
export interface ExcelSheetsSnapshot { readonly sheets: readonly ExcelSheetMetadata[]; readonly total: number; readonly returned: number; readonly truncated: boolean }
export const EXCEL_SHEETS_LIMIT = 256;
/** UsedRange reports Excel's formatted/used extent, not a count of nonempty cells. */
export function isExcelSheetsSnapshot(value: unknown): value is ExcelSheetsSnapshot {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'returned,sheets,total,truncated' || !Array.isArray(value.sheets)
    || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || value.returned !== value.sheets.length
    || value.returned !== Math.min(Number(value.total), EXCEL_SHEETS_LIMIT) || value.truncated !== (Number(value.total) > Number(value.returned))) return false;
  const names = new Set<string>();
  return value.sheets.every((sheet: unknown) => {
    if (!record(sheet) || Object.keys(sheet).sort().join(',') !== 'columns,name,rows,used_range' || typeof sheet.name !== 'string' || !sheet.name || sheet.name.length > 128 || sheet.name.includes('\0')
      || typeof sheet.used_range !== 'string' || sheet.used_range.length > 64 || !/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/u.test(sheet.used_range)
      || !Number.isSafeInteger(sheet.rows) || Number(sheet.rows) < 1 || Number(sheet.rows) > 1048576 || !Number.isSafeInteger(sheet.columns) || Number(sheet.columns) < 1 || Number(sheet.columns) > 16384
      || !matchesDimensions(sheet.used_range, Number(sheet.rows), Number(sheet.columns))) return false;
    const name = sheet.name.toLowerCase(); if (names.has(name)) return false; names.add(name); return true;
  });
}
function matchesDimensions(address: string, rows: number, columns: number): boolean {
  const cells = address.split(':').map((cell) => {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(cell)!;
    return { row: Number(match[2]), column: [...match[1]!].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) };
  });
  const first = cells[0]!; const last = cells[1] ?? first;
  return first.row <= last.row && first.column <= last.column && last.row <= 1048576 && last.column <= 16384
    && rows === last.row - first.row + 1 && columns === last.column - first.column + 1;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
