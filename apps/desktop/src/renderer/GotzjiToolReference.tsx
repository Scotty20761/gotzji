import { useId, useState, type ReactElement } from 'react';
import baseline from './gotzji-tool-baseline.json' with { type: 'json' };

const mappings: Readonly<Record<string, string>> = {
  workspace_list: 'โครงการที่ลงทะเบียน', workspace_info: 'ข้อมูลโครงการที่เลือก',
  read_file: 'อ่านไฟล์ในโครงการ', list_files: 'อ่านโฟลเดอร์ในโครงการ', search_text: 'ค้นหาข้อความในโครงการ',
  write_file: 'เตรียมและบันทึกไฟล์', edit_file: 'แก้ไฟล์จากรุ่นที่อ่านแล้ว',
  git: 'อ่านสถานะ ประวัติ และความต่างของไฟล์ที่เลือก',
  git_status: 'อ่านสถานะ Git ของโครงการ', git_diff: 'อ่านความต่างของไฟล์ที่เลือก', git_log: 'อ่านประวัติ Git ล่าสุด',
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
    <p>รายการเทียบแอปเดิมรุ่น {baseline.version} จำนวน {baseline.tools.length} ชื่อ จากแคตตาล็อก ช่องทางเชื่อมต่อ และชุดโปรแกรมต้นฉบับ รวบรวมถึง {baseline.referenceUpdatedOn} บางชื่อเป็นทางเรียกงานเดียวกัน การมีทางใช้งานบางส่วนยังไม่ถือว่าทำได้ครบตามต้นทาง ดูสถานะพร้อมใช้งานจริงในรายการเครื่องมือของเครื่องนี้</p>
    <p>{baseline.advertisedCallableNames} ชื่อมีหลักฐานในช่องทางเชื่อมต่อที่เก็บไว้ อีก {baseline.staticOnlyNames} ชื่อพบในชุดโปรแกรมต้นฉบับและยังต้องเทียบรายละเอียดก่อนเชื่อมใช้งาน</p>
    <p>คำอธิบายต้นทางเป็นของ lnwjud การใช้งาน gotzji ยึดสิทธิ์และสถานะที่แอปนี้แสดง</p>
    <label htmlFor={inputId}>ค้นหาเครื่องมืออ้างอิง</label><input id={inputId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ชื่อเครื่องมือหรือประเภทงาน" />
    <p aria-live="polite">พบ {matches.length} รายการ</p>
    {matches.length === 0 ? <p>ไม่พบเครื่องมือที่ตรงกับคำค้นนี้</p> : <div className="gotzji-reference-table"><table>
      <thead><tr><th>เครื่องมือเดิม</th><th>ความครอบคลุม</th><th>ทางใช้งานใน gotzji</th></tr></thead>
      <tbody>{matches.map((tool) => <tr key={tool.id}><td><strong>{tool.id}</strong>{tool.surface === 'static-only' && <p><small>รายการจากชุดโปรแกรมต้นฉบับ</small></p>}<p>{tool.description}</p></td>
        <td>{mappings[tool.id] ? 'รองรับบางส่วน' : 'ยังต้องเชื่อม'}</td><td>{mappings[tool.id] ?? 'อยู่ในรายการงานที่จะพัฒนาและตรวจผล'}</td></tr>)}</tbody>
    </table></div>}
  </details>;
}
