export interface GotzjiReleaseNotes { readonly status: 'development' | 'release'; readonly th: readonly string[]; readonly en: readonly string[] }
export const GOTZJI_RELEASE_NOTES: Readonly<Record<string, GotzjiReleaseNotes>> = {
  '5.7.3': {
    status: 'development',
    th: ['รุ่นฐานสำหรับพัฒนา gotzji ยังไม่ได้เผยแพร่เป็นรุ่นทางการ', 'เพิ่มระบบแยก ประวัติงาน และเครื่องมือที่ Grace ควบคุม พร้อมตรวจความพร้อมของแต่ละโปรแกรมและช่องทางเชื่อมต่อ'],
    en: ['gotzji development baseline. This version is not an official published gotzji release.', 'Introduces an isolated host, durable project jobs and Grace-controlled tools, with provider and connection readiness reported separately.'],
  },
  '1.0.0': {
    status: 'release',
    th: ['แอป gotzji แยกระบบและประวัติงานของตัวเอง พร้อมให้ Grace ควบคุมการทำงานตามโครงการที่เลือก', 'เตรียมงานและติดตามคิว ผลลัพธ์ บันทึก และการยกเลิกเฉพาะงาน โดยเก็บประวัติไว้ให้กลับมาตรวจได้', 'เพิ่มเครื่องมือไฟล์ คำสั่งที่ตรวจไว้ วัตถุใน Office, CAD, เบราว์เซอร์ และขั้นตอน Library ตามความพร้อมของโปรแกรมในเครื่อง', 'ตั้งค่าการเชื่อมต่อส่วนตัวผ่าน OpenAI Secure MCP Tunnel และช่องทาง Library แยก โดยยังใช้ประวัติงานชุดเดียวกัน', 'อัปเดตด้วยไฟล์รุ่นที่ตรวจแล้ว พร้อมตรวจความเข้ากันได้และสถานะงานก่อนทำต่อ'],
    en: ['An independently identified gotzji app and durable host, with Grace-controlled work in explicitly enrolled projects.', 'Prepared requests, visible queue order, retained logs and verified results, plus cancellation of explicitly selected jobs.', 'Typed file, reviewed-command, Office, CAD, browser and Library workflow operations, subject to the installed providers and their readiness.', 'Private OpenAI Secure MCP Tunnel setup and a separately enrolled Library channel over the same job authority.', 'Manual verified updates with compatibility and retained-work inspection before continuation.'],
  },
};
export function gotzjiReleaseNotes(version: string): GotzjiReleaseNotes | null { return GOTZJI_RELEASE_NOTES[version] ?? null; }
