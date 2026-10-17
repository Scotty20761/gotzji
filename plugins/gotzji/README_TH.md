# ปลั๊กอิน gotzji สำหรับ ChatGPT

แพ็กเกจนี้เพิ่มคำแนะนำให้ ChatGPT ควบคุมงานผ่าน MCP ของ gotzji โดย host บน Windows ทำเฉพาะคำสั่งแบบมีชนิดที่ประกาศไว้ พร้อมรักษาโปรเจกต์ คำขอ งาน หลักฐาน และสิทธิ์ของเจ้าของแต่ละชิ้นอย่างชัดเจน บัญชีและบทสนทนา ChatGPT ปัจจุบันของเจ้าของเป็นส่วน reasoning; นอกเหนือจากนั้นการทำงานปกติไม่ต้องมี Claude, Grace, Codex, local/secondary inference backend, provider login, subscription หรือโมเดลเพิ่ม และไม่มี API สำหรับ inference เพิ่มเติม

## สถานะของแพ็กเกจทั่วไป

แพ็กเกจทั่วไปเป็นต้นแบบสาธารณะที่ **ยังไม่ผูกกับ MCP app ของบัญชีใด** จึงติดตั้งเพื่อดูคำแนะนำได้ แต่ยังเรียกเครื่องมือ gotzji ใน ChatGPT ไม่ได้ ไฟล์ `app-binding.template.json` แสดงเพียงรูปแบบการผูกแอป ไม่มี technical ID จริง และไม่ใช่ `.app.json`

การมี ZIP หรือผ่านการตรวจไฟล์หมายถึงแพ็กเกจถูกประกอบถูกต้องเท่านั้น ยังไม่ใช่หลักฐานว่าแอปเชื่อมต่อแล้ว งานทำงานจริงแล้ว หรือบัญชี Plus/Pro ผ่านการทดสอบแล้ว

## สร้างสำเนาส่วนตัวหลังลงทะเบียน MCP app แล้ว

1. เปิด gotzji บน Windows และตั้งค่า OpenAI Secure MCP Tunnel ของ gotzji ให้พร้อมจากหน้าแอป เก็บ runtime key ไว้ในแอปเท่านั้น
2. ใน ChatGPT สร้าง custom MCP app จาก tunnel ของ gotzji แล้วคัดลอก technical ID จริงที่ ChatGPT ออกให้ ซึ่งขึ้นต้นด้วย `plugin_asdk_app_`
3. สร้างแพ็กเกจส่วนตัวในเครื่อง:

   ```powershell
   $env:GOTZJI_REGISTERED_APP_ID = '<technical ID ที่ ChatGPT ออกให้>'
   node scripts/package-gotzji-plugin.mjs --personal
   Remove-Item Env:GOTZJI_REGISTERED_APP_ID
   ```

   หรือส่งค่าด้วย `--app-id` ได้ หากยอมรับว่าค่านั้นจะอยู่ในประวัติคำสั่งของ shell

4. แตก ZIP ส่วนตัวไปยังแหล่งปลั๊กอินส่วนตัวของคุณ แล้วเพิ่มตำแหน่งนั้นใน local marketplace ตามคู่มือ Agent Plugins ของ OpenAI
5. รีสตาร์ต ChatGPT desktop app ติดตั้งปลั๊กอินจาก local marketplace แล้วทดสอบในแชตใหม่ เริ่มจาก `gotzji_health` และ `gotzji_projects`

สคริปต์สร้าง `.app.json` เฉพาะในแพ็กเกจส่วนตัว และระบุสถานะว่า `provided-unverified` จนกว่าจะทดสอบการเชื่อมต่อจริง technical ID ไม่ใช่ runtime key และไม่ควรนำสำเนาส่วนตัวขึ้น public repository

## ขอบเขตความปลอดภัย

- ลงทะเบียนโปรเจกต์ สูตรงาน และการเชื่อมต่อจากแอป gotzji บนเครื่อง
- ให้ ChatGPT ตรวจ `gotzji_health`, โปรเจกต์ และรายการ operation ที่ host ประกาศก่อนเริ่มงาน แล้วเรียกเฉพาะเครื่องมือแบบมีชนิดผ่านระบบงานเดียวของ gotzji
- ใช้ `requestId` เดิมสำหรับคำขอเดียวกัน และเลือกงานด้วย `jobId` ที่แน่นอนทุกครั้งเมื่อตรวจสถานะ อ่าน log รับผล ทำต่อ หรือยกเลิกจนจบ
- ขอบเขตเป้าหมายยังครอบคลุม 3 กลุ่ม: ไฟล์/โค้ด/คำสั่ง/งานเบื้องหลัง, browser/Office/CAD และ Investment Library
- การตรวจสถานะและ log ไม่ได้แปลว่างานเสร็จ ผลงานพร้อมส่ง หรือมีการ commit, push, deploy หรือเผยแพร่แล้ว
- workflow ของ Investment Library ที่ยังต้องอาศัยการวิเคราะห์หรือการตัดสินใจจากโมเดลถือว่ายังไม่รองรับ จนกว่าจะมีสัญญาให้ ChatGPT ดำเนินขั้น reasoning และส่งต่อ typed operation อย่างชัดเจน ห้ามนับว่าเสร็จจากการข้ามขั้นเหล่านั้น
- แพ็กเกจไม่ติดตั้ง hook, scheduler, runtime key, API key, โปรไฟล์ tunnel, ข้อมูลโปรเจกต์ หรือข้อมูลส่วนตัว และไม่รันโค้ดระหว่างการติดตั้ง

gotzji และปลั๊กอินนี้ใช้สัญญาอนุญาต MIT ดูได้จาก `LICENSE` ส่วนแอป Windows แบบ official unsigned และการเผยแพร่สาธารณะเป็นขั้นตอนแยกที่ต้องผ่านการทดสอบจริงก่อน
