export interface NativeFormField { readonly name: string; readonly label: string; readonly type: 'text' | 'number' | 'textarea' }
const fields: Record<string, readonly NativeFormField[]> = {
  'excel.range.read': [{ name: 'sheet', label: 'ชื่อแผ่นงาน', type: 'text' }, { name: 'range', label: 'ช่วงเซลล์ เช่น A1:B3', type: 'text' }],
  'excel.range.write': [{ name: 'sheet', label: 'ชื่อแผ่นงาน', type: 'text' }, { name: 'range', label: 'ช่วงเซลล์ เช่น A1:B3', type: 'text' }, { name: 'values', label: 'ค่าใหม่: บรรทัดละแถว คั่นคอลัมน์ด้วย Tab', type: 'textarea' }, { name: 'outputPath', label: 'ไฟล์ผลลัพธ์ใหม่ในโครงการ', type: 'text' }],
  'word.paragraph.read': [{ name: 'paragraph', label: 'ลำดับย่อหน้า', type: 'number' }],
  'word.paragraph.write': [{ name: 'paragraph', label: 'ลำดับย่อหน้า', type: 'number' }, { name: 'text', label: 'ข้อความใหม่ในย่อหน้า', type: 'textarea' }, { name: 'outputPath', label: 'ไฟล์ผลลัพธ์ใหม่ในโครงการ', type: 'text' }],
  'powerpoint.shape.read': [{ name: 'slide', label: 'ลำดับสไลด์', type: 'number' }, { name: 'shape', label: 'ชื่อวัตถุในสไลด์', type: 'text' }],
  'powerpoint.shape.write': [{ name: 'slide', label: 'ลำดับสไลด์', type: 'number' }, { name: 'shape', label: 'ชื่อวัตถุในสไลด์', type: 'text' }, { name: 'text', label: 'ข้อความใหม่', type: 'textarea' }, { name: 'outputPath', label: 'ไฟล์ผลลัพธ์ใหม่ในโครงการ', type: 'text' }],
  'cad.entity.inspect': [{ name: 'handle', label: 'รหัสวัตถุ (Handle)', type: 'text' }],
  'cad.entity.move': [{ name: 'handle', label: 'รหัสวัตถุ (Handle)', type: 'text' }, { name: 'x', label: 'ระยะย้ายตามแกน X', type: 'number' }, { name: 'y', label: 'ระยะย้ายตามแกน Y', type: 'number' }, { name: 'z', label: 'ระยะย้ายตามแกน Z', type: 'number' }, { name: 'outputPath', label: 'ไฟล์ผลลัพธ์ใหม่ในโครงการ', type: 'text' }],
};
export function nativeFormFields(operation: string): readonly NativeFormField[] { return fields[operation] ?? []; }
export function buildNativeFormInput(operation: string, values: Readonly<Record<string, string>>): Record<string, unknown> {
  const selected = nativeFormFields(operation);
  if (selected.length === 0) throw new Error('เลือกเครื่องมือที่รองรับก่อน');
  const input: Record<string, unknown> = {};
  for (const field of selected) {
    const value = values[field.name] ?? '';
    if (!value && field.name !== 'text') throw new Error(`กรอก${field.label}`);
    if (field.name === 'values') input.values = tableValues(value);
    else if (field.type === 'number') {
      const number = Number(value); if (!Number.isFinite(number) || ((field.name === 'paragraph' || field.name === 'slide') && (!Number.isInteger(number) || number < 1))) throw new Error(`ตรวจ${field.label}`);
      input[field.name] = number;
    } else input[field.name] = value;
  }
  if (operation === 'cad.entity.move') { input.displacement = [input.x, input.y, input.z]; delete input.x; delete input.y; delete input.z; }
  return input;
}
function tableValues(text: string): readonly (readonly (string | number | boolean)[])[] {
  const rows = text.split(/\r?\n/u).map((row) => row.split('\t').map((cell) => {
    if (cell === 'true') return true; if (cell === 'false') return false;
    // Keep IDs with leading zeroes intact when values are pasted from Excel.
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(cell) && Number.isFinite(Number(cell))) return Number(cell);
    return cell;
  }));
  if (rows.some((row) => row.length !== rows[0]?.length)) throw new Error('จำนวนคอลัมน์ในแต่ละแถวต้องเท่ากัน');
  return rows;
}
