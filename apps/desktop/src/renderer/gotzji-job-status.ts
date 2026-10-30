export function statusLabel(value: unknown): string {
  const labels: Record<string, string> = { queued: 'รอคิว', running: 'กำลังทำงาน', verifying: 'กำลังตรวจผล', blocked: 'รอการแก้ไข', completed: 'เสร็จแล้ว', cancelled: 'ยกเลิกแล้ว', failed: 'เกิดข้อผิดพลาด' };
  return labels[String(value)] ?? String(value);
}

export function operationLabel(value: unknown): string {
  const labels: Record<string, string> = { 'file.read': 'อ่านไฟล์โครงการ', 'file.write': 'เขียนไฟล์โครงการ', 'command.run': 'รันคำสั่งที่อนุมัติ', 'library.workflow': 'เวิร์กโฟลว์โครงการ' };
  return labels[String(value)] ?? 'งานของโครงการ';
}
