import { useId, useState, type ReactElement } from 'react';
import baseline from './gotzji-tool-baseline.json' with { type: 'json' };

const mappings: Readonly<Record<string, string>> = {
  workspace_list: 'โครงการที่ลงทะเบียน', workspace_info: 'ข้อมูลโครงการที่เลือก',
  read_file: 'อ่านไฟล์ในโครงการ', list_files: 'อ่านโฟลเดอร์ในโครงการ', search_text: 'ค้นหาข้อความในโครงการ',
  write_file: 'เตรียมและบันทึกไฟล์', edit_file: 'แก้ไฟล์จากรุ่นที่อ่านแล้ว',
  shell: 'คำสั่งที่เจ้าของตรวจและผูกกับโครงการ', process_start: 'งานคำสั่งที่มีประวัติ',
  get_goal: 'สถานะงานที่เลือก', list_goals: 'ประวัติงาน', run_goal: 'ตรวจและทำงานเดิมต่อ', cancel_goal: 'ยกเลิกงานที่เลือก',
};

/** Reference coverage is deliberately separate from the host's live readiness catalog. */
export function GotzjiToolReference(): ReactElement {
  const [query, setQuery] = useState('');
  const inputId = useId();
  const normalized = query.trim().toLocaleLowerCase();
  const matches = baseline.tools.filter((tool) => `${tool.id} ${tool.description} ${tool.tags.join(' ')}`.toLocaleLowerCase().includes(normalized));
  return <details className="gotzji-reference"><summary>เทียบความสามารถกับ lnwjud</summary>
    <p>รายการอ้างอิงรุ่น {baseline.version} จำนวน {baseline.tools.length} รายการ ที่เก็บเมื่อ {baseline.capturedOn} การมีทางใช้งานบางส่วนยังไม่ถือว่าทำได้ครบตามต้นทาง ดูสถานะพร้อมใช้งานจริงในรายการเครื่องมือของเครื่องนี้</p>
    <label htmlFor={inputId}>ค้นหาเครื่องมืออ้างอิง</label><input id={inputId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ชื่อเครื่องมือหรือประเภทงาน" />
    <p aria-live="polite">พบ {matches.length} รายการ</p>
    {matches.length === 0 ? <p>ไม่พบเครื่องมือที่ตรงกับคำค้นนี้</p> : <div className="gotzji-reference-table"><table>
      <thead><tr><th>เครื่องมือเดิม</th><th>ความครอบคลุม</th><th>ทางใช้งานใน gotzji</th></tr></thead>
      <tbody>{matches.map((tool) => <tr key={tool.id}><td><strong>{tool.id}</strong><p>{tool.description}</p></td>
        <td>{mappings[tool.id] ? 'รองรับบางส่วน' : 'ยังต้องเชื่อม'}</td><td>{mappings[tool.id] ?? 'อยู่ในรายการงานที่จะพัฒนาและตรวจผล'}</td></tr>)}</tbody>
    </table></div>}
  </details>;
}
