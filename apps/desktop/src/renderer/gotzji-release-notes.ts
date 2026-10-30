export interface GotzjiReleaseNotes { readonly status: 'development' | 'release'; readonly th: readonly string[]; readonly en: readonly string[] }
export const GOTZJI_RELEASE_NOTES: Readonly<Record<string, GotzjiReleaseNotes>> = {
  '5.7.3': {
    status: 'development',
    th: ['รุ่นฐานสำหรับพัฒนา gotzji ยังไม่ได้เผยแพร่เป็นรุ่นทางการ', 'เพิ่มระบบแยก ประวัติงาน และเครื่องมือที่ Grace ควบคุม พร้อมตรวจความพร้อมของแต่ละโปรแกรมและช่องทางเชื่อมต่อ'],
    en: ['gotzji development baseline. This version is not an official published gotzji release.', 'Introduces an isolated host, durable project jobs and Grace-controlled tools, with provider and connection readiness reported separately.'],
  },
  '1.0.0': {
    status: 'development',
    th: ['รวมฐานโค้ด lnwjud 5.8.7 พร้อมรายการเทียบเครื่องมือต้นฉบับ 294 ชื่อ ซึ่งยังแยกจากการตรวจว่าใช้งานได้จริง', 'เพิ่มการจำโครงการและสรุปบริบทข้ามแชต เริ่มงานใหม่ผ่าน ChatGPT และติดตามในแอป', 'แอป gotzji เชื่อมปลั๊กอิน ChatGPT กับเครื่องมือและประวัติงานของโครงการ โดยไม่ต้องใช้ Claude', 'เตรียมงานและติดตามคิว ผลลัพธ์ บันทึก และการยกเลิกเฉพาะงาน โดยเก็บประวัติไว้ให้กลับมาตรวจได้', 'เพิ่มเครื่องมือไฟล์ คำสั่งที่ตรวจไว้ วัตถุใน Office, CAD, เบราว์เซอร์ และขั้นตอน Library ตามความพร้อมของโปรแกรมในเครื่อง', 'ตั้งค่าการเชื่อมต่อส่วนตัวผ่าน OpenAI Secure MCP Tunnel พร้อมแสดงความพร้อมของเครื่องมือและขั้นตอน Library แต่ละรายการ', 'อัปเดตด้วยไฟล์รุ่นที่ตรวจแล้ว พร้อมตรวจความเข้ากันได้และสถานะงานก่อนทำต่อ'],
    en: ['Integrates lnwjud 5.8.7 source and inventories 294 upstream definitions separately from qualified execution.', 'Persists selected-project context across chats; ChatGPT starts new work and Desktop monitors it.', 'An independently identified gotzji app and durable host controlled through the ChatGPT MCP plugin, without a Claude runtime.', 'Prepared requests, visible queue order, retained logs and verified results, plus cancellation of explicitly selected jobs.', 'Typed file, reviewed-command, Office, CAD, browser and Library workflow operations, subject to the installed providers and their readiness.', 'Private OpenAI Secure MCP Tunnel setup with capability-specific tool and Library workflow readiness.', 'Manual verified updates with compatibility and retained-work inspection before continuation.'],
  },
};
export function gotzjiReleaseNotes(version: string): GotzjiReleaseNotes | null { return GOTZJI_RELEASE_NOTES[version] ?? null; }
