import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { GotzjiMethod } from '@lnwjud/ipc-contracts';

interface Props {
  readonly projectId: string;
  readonly disabled: boolean;
  readonly request: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly onJob: (jobId: string) => void;
  readonly chatgptOnly?: boolean;
}
interface Entry { readonly path: string; readonly type: 'file' | 'directory' }
interface Snapshot { readonly path: string; readonly content: string; readonly sha256: string }
interface Preparation { readonly id: string; readonly requestId: string }
interface SearchHit { readonly path: string; readonly line: number; readonly text: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Reads and writes use the same project and expected-version authority as the plugin. */
export function GotzjiProjectFiles({ projectId, disabled, request, onJob, chatgptOnly = false }: Props): ReactElement {
  const editorId = useId();
  const [directory, setDirectory] = useState('.');
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [path, setPath] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [content, setContent] = useState('');
  const [createNew, setCreateNew] = useState(false);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [listed, setListed] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ matches: readonly SearchHit[]; truncated: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return (): void => { mounted.current = false; }; }, []);
  const locked = disabled || busy;
  const changed = createNew || snapshot !== null && content !== snapshot.content;

  async function act(work: () => Promise<void>): Promise<void> {
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'อ่านข้อมูลไม่สำเร็จ กรุณาลองใหม่'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function list(selectedDirectory = directory): Promise<void> {
    const value = await request('listProjectFiles', { projectId, path: selectedDirectory });
    if (!record(value) || !Array.isArray(value.entries) || value.entries.some((entry: unknown) => !record(entry) || typeof entry.path !== 'string' || !['file', 'directory'].includes(String(entry.type)))) throw new Error('รายการไฟล์ไม่สมบูรณ์ กรุณาอ่านโฟลเดอร์ใหม่');
    if (!mounted.current) return;
    setDirectory(selectedDirectory); setEntries(value.entries as Entry[]); setIncomplete(value.truncated === true); setListed(true); setSearch(null);
  }
  async function read(selectedPath: string): Promise<void> {
    const value = await request('readProjectFile', { projectId, path: selectedPath });
    if (!record(value) || typeof value.content !== 'string' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error('อ่านรุ่นของไฟล์ไม่สำเร็จ กรุณาเปิดไฟล์อีกครั้ง');
    if (!mounted.current) return;
    setPath(selectedPath); setSnapshot({ path: selectedPath, content: value.content, sha256: value.sha256 });
    setContent(value.content); setCreateNew(false); setPreparation(null);
  }
  async function find(): Promise<void> {
    const value = await request('searchProjectFiles', { projectId, path: directory, query });
    if (!record(value) || typeof value.truncated !== 'boolean' || !Array.isArray(value.matches) || value.matches.some((hit: unknown) => !record(hit) || typeof hit.path !== 'string' || !Number.isSafeInteger(hit.line) || Number(hit.line) < 1 || typeof hit.text !== 'string')) throw new Error('ผลการค้นหาไม่สมบูรณ์ กรุณาค้นหาใหม่');
    if (mounted.current) setSearch({ matches: value.matches as SearchHit[], truncated: value.truncated });
  }
  async function prepare(): Promise<void> {
    if (!createNew && (!snapshot || snapshot.path !== path)) throw new Error('เปิดไฟล์เดิมก่อนตรวจการแก้ไข');
    const requestId = crypto.randomUUID();
    const value = await request('prepareOperation', { requestId, projectId, operation: 'file.write', path, content, expectedSha256: createNew ? null : snapshot!.sha256 });
    if (!record(value) || typeof value.preparationId !== 'string') throw new Error('ยังเตรียมการบันทึกไม่สำเร็จ');
    if (mounted.current) setPreparation({ id: value.preparationId, requestId });
  }
  async function submit(): Promise<void> {
    if (!preparation) return;
    // Keep the same preparation after an uncertain response: retry never creates a new request.
    const value = await request('submit', { preparationId: preparation.id });
    if (!record(value) || typeof value.jobId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.jobId)) throw new Error('ยังยืนยันการรับงานไม่ได้ ลองบันทึกอีกครั้งด้วยรายการเดิม');
    if (mounted.current) onJob(value.jobId);
  }

  return <section className="gotzji-files" aria-busy={busy}>
    <div className="gotzji-section-heading"><div><h3>ไฟล์ในโครงการ</h3><p>เปิดไฟล์ ตรวจการแก้ไข แล้วติดตามผลในประวัติงาน</p></div>
      <button disabled={locked} onClick={() => { setCreateNew(true); setPath(''); setContent(''); setSnapshot(null); setPreparation(null); }}>ไฟล์ใหม่</button></div>
    {error && <p role="alert" className="gotzji-file-error">{error}</p>}
    <div className="gotzji-file-layout"><div className="gotzji-file-browser">
      <label>โฟลเดอร์ในโครงการ<input disabled={locked} value={directory} onChange={(event) => { setDirectory(event.target.value); setSearch(null); }} /></label>
      <button disabled={locked || !directory} onClick={() => void act(() => list())}>อ่านโฟลเดอร์</button>
      {incomplete && <p role="status">แสดงรายการได้บางส่วน ลองเลือกโฟลเดอร์ย่อยเพื่อดูให้ครบ</p>}
      <div className="gotzji-file-list">{entries.map((entry) => <button key={entry.path} disabled={locked} title={entry.path}
        onClick={() => void act(() => entry.type === 'directory' ? list(entry.path) : read(entry.path))}>
        <span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span> {entry.path.split('/').at(-1)}</button>)}</div>
      {listed && entries.length === 0 && <p>ไม่มีไฟล์ในรายการนี้</p>}
      <label htmlFor={`${editorId}-search`}>ข้อความที่ต้องการค้นหา</label><input id={`${editorId}-search`} disabled={locked} value={query} onChange={(event) => { setQuery(event.target.value); setSearch(null); }} />
      <p className="gotzji-muted">ค้นหาข้อความตรงตามที่พิมพ์ในโฟลเดอร์ที่เลือก</p><button disabled={locked || !query || !directory} onClick={() => void act(find)}>ค้นหาในโครงการ</button>
      {search && <div className="gotzji-search-results"><h4>ผลการค้นหา</h4>{search.truncated && <p role="status">ค้นหาได้บางส่วน ลองเลือกโฟลเดอร์ย่อยหรือข้อความที่เจาะจงขึ้น</p>}
        {search.matches.length ? <ul>{search.matches.map((hit) => <li key={`${hit.path}:${hit.line}`}><button disabled={locked} onClick={() => void act(() => read(hit.path))}>{hit.path}:{hit.line}</button><p>{hit.text}</p></li>)}</ul> : <p>{search.truncated ? 'ยังไม่พบข้อความในส่วนที่ค้นหาได้' : 'ไม่พบข้อความที่ค้นหา'}</p>}</div>}
    </div><div className="gotzji-file-editor">
      <label>ไฟล์ที่เลือก<input disabled={locked || !createNew} value={path} placeholder="ชื่อไฟล์ภายในโครงการ" onChange={(event) => { setPath(event.target.value); setPreparation(null); }} /></label>
      {!snapshot && !createNew ? <p className="gotzji-empty">เลือกไฟล์จากรายการ หรือเริ่มสร้างไฟล์ใหม่</p> : <>
        <label htmlFor={editorId}>เนื้อหาไฟล์</label><textarea id={editorId} disabled={locked} spellCheck={false} value={content} onChange={(event) => { setContent(event.target.value); setPreparation(null); }} />
        {snapshot && <details><summary>เนื้อหาเดิมก่อนแก้ไข</summary><pre>{snapshot.content}</pre></details>}
        {createNew && <p>สร้างได้เมื่อชื่อไฟล์นี้ยังไม่มีอยู่ในโครงการ</p>}
        {chatgptOnly ? <div className="gotzji-actions"><button disabled={locked || !path || !changed} onClick={() => void act(async () => {
          await navigator.clipboard.writeText(`อ่านบริบทโครงการ ${projectId} แล้วตรวจและ${createNew ? 'สร้างไฟล์ใหม่' : 'แก้ไขไฟล์'} ${path} ตามเนื้อหาด้านล่าง ตรวจรุ่นไฟล์จริงก่อนเขียน และตรวจผลงานหลังบันทึก\n\n${content}`);
        })}>คัดลอกงานแก้ไฟล์สำหรับ ChatGPT</button><p>การแก้ในช่องนี้เป็นร่าง ส่งผ่าน ChatGPT เพื่อเริ่มบันทึกไฟล์จริง</p></div> : <div className="gotzji-actions"><button disabled={locked || !path || !changed} onClick={() => void act(prepare)}>ตรวจการแก้ไข</button>
          <button className="gotzji-primary" disabled={locked || !preparation} onClick={() => void act(submit)}>บันทึกไฟล์</button></div>
        }
        {preparation && <p role="status">ตรวจแล้ว พร้อมเริ่มงานบันทึกไฟล์ที่เลือก</p>}
      </>}
    </div></div>
  </section>;
}
