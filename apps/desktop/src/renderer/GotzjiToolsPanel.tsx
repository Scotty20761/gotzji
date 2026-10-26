import { useId, useState, type ReactElement } from 'react';

type ToolRow = Readonly<Record<string, unknown>>;
const categories = { file: 'ไฟล์', command: 'คำสั่งที่ตรวจแล้ว', browser: 'เบราว์เซอร์', excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint', cad: 'CAD', library: 'Library', other: 'อื่น ๆ' };
type Category = keyof typeof categories;
const labels: Readonly<Record<string, string>> = {
  'file.read': 'อ่านไฟล์เป็นงาน', 'file.read.direct': 'อ่านไฟล์โดยตรง', 'file.list': 'ดูรายการไฟล์', 'file.search': 'ค้นหาข้อความในไฟล์', 'file.write': 'บันทึกไฟล์',
  'command.run': 'รันคำสั่งที่ตรวจแล้ว', 'excel.sheets.inspect': 'ดูแผ่นงาน Excel', 'excel.range.read': 'อ่านเซลล์ Excel',
  'excel.range.write': 'เขียนเซลล์ Excel', 'browser.read': 'อ่านข้อความบนเว็บ', 'browser.navigate': 'เปิดหน้าเว็บ',
  'word.paragraph.read': 'อ่านย่อหน้า Word', 'word.paragraph.write': 'แก้ย่อหน้า Word',
  'powerpoint.shape.read': 'อ่านวัตถุ PowerPoint', 'powerpoint.shape.write': 'แก้ข้อความ PowerPoint',
  'cad.entity.inspect': 'ตรวจวัตถุ CAD', 'cad.entity.move': 'ย้ายวัตถุ CAD', 'cad.layers.inspect': 'ดูชั้นงาน CAD',
  'browser.query': 'ค้นหาจุดบนหน้าเว็บ', 'browser.type': 'กรอกข้อความบนเว็บ', 'browser.click': 'คลิกจุดบนหน้าเว็บ', 'browser.workflow': 'ทำขั้นตอนบนเว็บ',
};
const descriptions: Readonly<Record<string, string>> = {
  'file.read.direct': 'อ่านเนื้อหาและรหัสตรวจไฟล์ทันที โดยไม่สร้างงานใหม่', 'file.list': 'เปิดดูไฟล์ในโฟลเดอร์ที่เลือกภายในโครงการ',
  'file.search': 'ค้นหาข้อความในไฟล์ของโครงการ พร้อมบอกขอบเขตที่อ่านได้', 'file.read': 'อ่านไฟล์และเก็บผลไว้ในประวัติงาน',
  'file.write': 'เปลี่ยนเนื้อหาจากไฟล์รุ่นที่ตรวจแล้ว พร้อมเก็บต้นฉบับ', 'command.run': 'เลือกคำสั่งที่เจ้าของตรวจและผูกกับโครงการไว้แล้ว',
};
const reasons: Readonly<Record<string, string>> = {
  PROVIDER_NOT_QUALIFIED: 'เครื่องมือตระกูลนี้ยังเชื่อมและตรวจไม่ครบ ดูเครื่องมือย่อยและตรวจระบบก่อนใช้งาน',
  NATIVE_PROVIDER_NOT_QUALIFIED: 'ยังไม่มีตัวเชื่อมโปรแกรมที่ผ่านการตรวจสำหรับเครื่องมือนี้ ตรวจการติดตั้งและตัวเชื่อมในตั้งค่า',
  BROWSER_PROVIDER_NOT_QUALIFIED: 'ยังไม่มีเบราว์เซอร์ที่ลงทะเบียนพร้อมใช้ เปิดส่วนเบราว์เซอร์ของโครงการเพื่อตรวจการเชื่อมต่อ',
  PRODUCT_PROFILE_REQUIRED: 'ระบบนี้ยังไม่พร้อมรับงานใหม่ เปิดตรวจระบบเพื่อตรวจการเชื่อมต่อ',
  BUILTIN_RECIPE_SUPERSEDED: 'คำสั่งนี้มีรุ่นใหม่แทนแล้ว เลือกคำสั่งรุ่นปัจจุบันที่ผูกกับโครงการ',
};

function category(row: ToolRow): Category {
  const name = String(row.name ?? '').split('.')[0] ?? '';
  return Object.hasOwn(categories, name) ? name as Category : 'other';
}

/** Displays host declarations; selecting a row only prepares the existing owner journey. */
export function GotzjiToolsPanel({ catalog, projectName, boundRecipeIds = [], canBindRecipes = true, disabled, onPrepare, onSettings, onProject }: {
  readonly catalog: readonly ToolRow[]; readonly projectName: string | null; readonly disabled: boolean;
  readonly boundRecipeIds?: readonly string[];
  readonly canBindRecipes?: boolean;
  readonly onPrepare: (row: ToolRow) => void; readonly onSettings: () => void; readonly onProject: (row?: ToolRow) => void;
}): ReactElement {
  const id = useId();
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [readiness, setReadiness] = useState('all');
  const matching = catalog.filter(row => {
    const group = category(row);
    const text = [row.name, row.recipeId, row.workflowId, row.description, row.reason, labels[String(row.name)], descriptions[String(row.name)], reasons[String(row.reason)], categories[group]].join(' ').toLocaleLowerCase();
    return text.includes(query.trim().toLocaleLowerCase()) && (selectedCategory === 'all' || selectedCategory === group) && (readiness === 'all' || (readiness === 'available' ? row.state === 'available' : row.state !== 'available'));
  });
  return <section aria-labelledby={`${id}-title`} className="gotzji-tools-panel">
    <h3 id={`${id}-title`}>เครื่องมือของเครื่องนี้</h3>
    <p>ค้นหาเครื่องมือ เลือกรายละเอียด แล้วนำคำขอไปเริ่มงานใน ChatGPT</p>
    <p>สถานะมาจากระบบในเครื่อง การแสดงว่าพร้อมยังไม่ยืนยันผลทดสอบกับโปรแกรมจริงหรือรุ่นที่ติดตั้ง</p>
    {projectName ? <p>เตรียมให้โครงการ: {projectName}</p> : <div className="gotzji-actions"><p>เลือกโครงการก่อนเตรียมคำขอ</p><button onClick={() => onProject()}>เลือกโครงการ</button></div>}
    {disabled && <p role="status">รอระบบพร้อมก่อนเตรียมคำขอ ยังค้นหาและอ่านรายละเอียดได้</p>}
    <div className="gotzji-tool-filters">
      <label htmlFor={`${id}-search`}>ค้นหาเครื่องมือ<input id={`${id}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="ชื่อเครื่องมือหรือสิ่งที่ต้องการทำ" /></label>
      <div><label htmlFor={`${id}-category`}>ประเภทเครื่องมือ</label><select id={`${id}-category`} value={selectedCategory} onChange={event => setSelectedCategory(event.target.value)}><option value="all">ทุกประเภท</option>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div><label htmlFor={`${id}-readiness`}>ความพร้อม</label><select id={`${id}-readiness`} value={readiness} onChange={event => setReadiness(event.target.value)}><option value="all">ทุกสถานะ</option><option value="available">ระบบแจ้งว่าพร้อม</option><option value="unavailable">ยังไม่พร้อม</option></select></div>
    </div>
    <p aria-live="polite">แสดง {matching.length} จาก {catalog.length} รายการ</p>
    {matching.length === 0 ? <p>{catalog.length === 0 ? 'ยังไม่มีรายการจากระบบ ลองรีเฟรชหรือตรวจการเชื่อมต่อ' : 'ไม่พบเครื่องมือที่ตรงกับตัวกรอง ลองเปลี่ยนคำค้นหรือเลือกทุกประเภท'}</p> : <div className="gotzji-tool-table"><table><thead><tr><th>เครื่องมือ</th><th>ความพร้อมและเงื่อนไข</th><th>เตรียมงาน</th></tr></thead><tbody>{matching.map(row => {
      const name = String(row.name); const available = row.state === 'available';
      const direct = ['file.read.direct', 'file.list', 'file.search'].includes(name);
      const unbound = typeof row.recipeId === 'string' && !boundRecipeIds.includes(row.recipeId);
      return <tr key={JSON.stringify([row.name, row.recipeId, row.projectId, row.workflowId, row.workflowVersion])}>
        <td><strong>{String(row.workflowId ?? row.recipeId ?? labels[name] ?? name)}</strong><p><code>{name}</code></p><small>{categories[category(row)]}</small></td>
        <td><strong>{available ? 'ระบบแจ้งว่าพร้อม' : 'ยังไม่พร้อม'}</strong><p>{available ? descriptions[name] ?? String(row.description ?? '') : reasons[String(row.reason)] ?? 'ยังไม่มีข้อมูลยืนยันความพร้อม ตรวจระบบและตัวเชื่อมก่อนใช้งาน'}</p>{available && unbound && projectName && <p>{canBindRecipes ? 'คำสั่งนี้ยังไม่ผูกกับโครงการที่เลือก' : 'คำสั่งแบบนี้ใช้กับโครงการทั่วไป สำหรับ Library ให้เลือกเวิร์กโฟลว์ของโครงการ'}</p>}{!available && <details><summary>รายละเอียดจากระบบ</summary><p>{String(row.reason ?? row.state ?? 'ไม่ทราบสถานะ')}</p><p>{String(row.description ?? '')}</p></details>}</td>
        <td>{available ? unbound ? <button disabled={disabled || !projectName} onClick={() => onProject(row)}>{canBindRecipes ? 'ผูกคำสั่งกับโครงการ' : 'เลือกโครงการทั่วไป'}</button> : <button disabled={disabled || !projectName} onClick={() => onPrepare(row)}>{direct ? 'เปิดไฟล์ในโครงการ' : 'เตรียมคำสั่ง'}</button> : <button onClick={onSettings}>ตรวจตั้งค่าเครื่องมือ</button>}</td>
      </tr>;
    })}</tbody></table></div>}
  </section>;
}
