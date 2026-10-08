import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { GotzjiHostStatus, GotzjiMethod } from '@lnwjud/ipc-contracts';
import './gotzji.css';
import { buildNativeFormInput, nativeFormFields } from './gotzji-native-form.js';
import { GotzjiConnectionPanel } from './GotzjiConnectionPanel.js';
import { GotzjiStartupPanel } from './GotzjiStartupPanel.js';
import { GotzjiBrowserPanel } from './GotzjiBrowserPanel.js';
import { GotzjiLibraryChannelPanel } from './GotzjiLibraryChannelPanel.js';
import { GotzjiVersionNotes } from './GotzjiVersionNotes.js';

type Row = Readonly<Record<string, unknown>>;
type Page = 'home' | 'projects' | 'tools' | 'worklog' | 'queue' | 'doctor';
const labels: Record<Page, string> = { home: 'ภาพรวม', projects: 'โครงการ', tools: 'เครื่องมือ', worklog: 'ประวัติงาน', queue: 'คิวงาน', doctor: 'ตรวจระบบ' };

/** Product controls address explicit canonical IDs, never the inherited provider API. */
export function GotzjiApp(): ReactElement {
  const [page, setPage] = useState<Page>('home');
  const [host, setHost] = useState<GotzjiHostStatus | null>(null);
  const [projects, setProjects] = useState<readonly Row[]>([]);
  const [jobs, setJobs] = useState<readonly Row[]>([]);
  const [catalog, setCatalog] = useState<readonly Row[]>([]);
  const [projectId, setProjectId] = useState('');
  const [jobId, setJobId] = useState('');
  const [selectedJob, setSelectedJob] = useState<unknown>(null);
  const [logs, setLogs] = useState('');
  const [logCursor, setLogCursor] = useState(0);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState({ projectId: '', displayName: '', rootPath: '' });
  const [projectKind, setProjectKind] = useState<'project' | 'library'>('project');
  const [selectedRecipes, setSelectedRecipes] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState('file.read');
  const [target, setTarget] = useState('');
  const [content, setContent] = useState('');
  const [expectedSha256, setExpectedSha256] = useState('');
  const [expectedAbsent, setExpectedAbsent] = useState(false);
  const [workflowParameters, setWorkflowParameters] = useState('{"paths":"[\\"README.md\\"]"}');
  const [browserValues, setBrowserValues] = useState({ selector: 'h1', text: '', postSelector: 'h1', expectedPostText: '', url: '', steps: '[]' });
  const [deliveryScope, setDeliveryScope] = useState('commit');
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [nativeValues, setNativeValues] = useState<Readonly<Record<string, string>>>({ paragraph: '1', slide: '1', x: '0', y: '0', z: '0' });
  const [priority, setPriority] = useState('1');
  const [queue, setQueue] = useState<readonly Row[]>([]);
  const [jobPriority, setJobPriority] = useState('1');

  const request = useCallback((method: GotzjiMethod, input: Record<string, unknown> = {}): Promise<unknown> => window.gotzji.request({ method, input }), []);
  const refresh = useCallback(async (): Promise<void> => {
    const status = await window.gotzji.hostStatus();
    setHost(status);
    if (status.state === 'unavailable') return;
    if (status.state === 'control-only') {
      setJobs(rows(await request('listJobs'))); setProjects([]); setCatalog([]);
      return;
    }
    const [projectRows, jobRows, catalogRows] = await Promise.all([
      request('listProjects'), request('listJobs'), request('listCatalog'),
    ]);
    setProjects(rows(projectRows));
    setJobs(rows(jobRows));
    setCatalog(rows(catalogRows));
  }, [request]);

  useEffect(() => {
    document.title = 'gotzji';
    let disposed = false;
    const update = (): void => { void refresh().catch((cause: unknown) => { if (!disposed) setError(message(cause)); }); };
    update();
    const timer = window.setInterval(update, 5_000);
    return (): void => { disposed = true; window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    setPreparationId(null); setRequestId(null);
  }, [projectId, operation, target, content, expectedSha256, nativeValues, priority]);
  useEffect(() => {
    if (page !== 'queue') return;
    let disposed = false;
    const update = (): void => { void request('inspectQueue').then((value) => { if (!disposed) setQueue(rows(value)); }).catch((cause: unknown) => { if (!disposed) setError(message(cause)); }); };
    update(); const timer = window.setInterval(update, 3_000);
    return (): void => { disposed = true; window.clearInterval(timer); };
  }, [page, request]);
  useEffect(() => {
    setSelectedJob(null); setLogs(''); setLogCursor(0); setResult(null);
    if (!jobId) return;
    let disposed = false;
    const update = (): void => {
      void request('status', { jobId }).then((value) => { if (!disposed) setSelectedJob(value); })
        .catch((cause: unknown) => { if (!disposed) setError(message(cause)); });
    };
    update();
    const timer = window.setInterval(update, 2_000);
    return (): void => { disposed = true; window.clearInterval(timer); };
  }, [jobId, request]);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(null);
    try { await action(); } catch (cause: unknown) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function prepare(): Promise<void> {
    const stableId = requestId ?? crypto.randomUUID();
    setRequestId(stableId);
    const workflow = catalog.find((entry) => entry.name === 'library.workflow' && entry.projectId === projectId && `library:${entry.workflowId}:${entry.workflowVersion}` === operation);
    const selectedBrowser = catalog.find((entry) => entry.name === operation && record(entry.browserSession) && entry.browserSession.projectId === projectId)?.browserSession;
    const input: Record<string, unknown> = { requestId: stableId, projectId, operation: workflow ? 'library.workflow' : operation, priority: Number(priority) };
    if (workflow) { input.workflowId = workflow.workflowId; input.workflowVersion = workflow.workflowVersion; const parameters: unknown = JSON.parse(workflowParameters); if (!record(parameters)) throw new Error('LIBRARY_PARAMETERS_INVALID'); input.parameters = parameters; }
    else if (operation.startsWith('browser.')) {
      if (!record(selectedBrowser)) throw new Error('BROWSER_SESSION_REQUIRED');
      for (const key of ['sessionId', 'tabId', 'expectedUrl', 'expectedDocumentId']) input[key] = selectedBrowser[key];
      if (operation === 'browser.workflow') input.steps = JSON.parse(browserValues.steps);
      else if (operation === 'browser.navigate') input.url = browserValues.url;
      else { input.selector = browserValues.selector; if (operation === 'browser.type') input.text = browserValues.text; if (operation === 'browser.click') { input.postSelector = browserValues.postSelector; input.expectedPostText = browserValues.expectedPostText; } }
    }
    else {
    if (operation === 'command.run') input.commandId = target;
    else input.path = target;
    if (operation === 'file.write') { input.content = content; input.expectedSha256 = expectedAbsent ? null : expectedSha256; }
    if (nativeFormFields(operation).length > 0) { Object.assign(input, buildNativeFormInput(operation, nativeValues)); if (expectedSha256) input.expectedSha256 = expectedSha256; }
    }
    const prepared = await request('prepareOperation', input);
    if (!record(prepared) || typeof prepared.preparationId !== 'string') throw new Error('PREPARATION_RESPONSE_INVALID');
    setPreparationId(prepared.preparationId);
  }
  async function submit(): Promise<void> {
    if (preparationId === null) return;
    const job = await request('submit', { preparationId });
    if (!record(job) || typeof job.jobId !== 'string') throw new Error('JOB_RESPONSE_INVALID');
    setJobId(job.jobId); setPage('worklog'); await refresh();
    // Keep this preparation so a lost follow-up can select/retry the same request.
  }
  async function readLogs(): Promise<void> {
    const value = await request('logs', { jobId, cursor: logCursor, limit: 4_000 });
    if (!record(value) || typeof value.text !== 'string' || !Number.isSafeInteger(value.nextCursor)) throw new Error('LOG_RESPONSE_INVALID');
    setLogs((previous) => previous + String(value.text)); setLogCursor(Number(value.nextCursor));
  }
  const available = catalog.filter((item) => item.state === 'available' && item.recipeId === undefined && item.name !== 'library.workflow');
  const workflows = catalog.filter((item) => item.state === 'available' && item.name === 'library.workflow' && item.projectId === projectId);
  const recipes = catalog.filter((item) => item.state === 'available' && typeof item.recipeId === 'string');
  const selectedProject = projects.find((item) => item.projectId === projectId);
  const boundRecipeIds = Array.isArray(selectedProject?.recipeIds) ? selectedProject.recipeIds as string[] : [];

  return <div className="gotzji-app"><div className="gotzji-titlebar">gotzji</div>
    <aside><h1>gotzji</h1><p>Grace ดูแลงานของคุณ</p><nav>{(Object.keys(labels) as Page[]).map((name) =>
      <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{labels[name]}</button>)}</nav>
      <p className="gotzji-owner">{host?.ownerId ?? 'กำลังเชื่อมต่อ'}</p><GotzjiVersionNotes /></aside>
    <main><header><h2>{labels[page]}</h2><button disabled={busy} onClick={() => void act(refresh)}>รีเฟรช</button></header>
      {error !== null && <div role="alert" className="gotzji-error">{error}<button onClick={() => setError(null)}>ปิด</button></div>}
      {page === 'home' && <><section><h3>ระบบควบคุม</h3><p>{host?.state === 'ready' ? 'ระบบพร้อมรับงาน · Grace ควบคุมการทำงาน' : host?.state === 'control-only' ? 'ดูผลและยกเลิกงานเดิมได้ · ต้องตรวจระบบก่อนเริ่มงานใหม่' : 'กำลังรอระบบ'}</p>
        {host?.errorCode && <p>{host.errorCode}</p>}{host?.action && <p>{host.action}</p>}<p>งานที่เริ่มแล้วมีประวัติแยกกัน เปิดกลับมาดูและควบคุมได้จากประวัติงาน</p></section>
        <section><h3>งานทั้งหมด {jobs.length}</h3><JobList jobs={jobs} disabled={busy} select={(id) => { setJobId(id); setPage('worklog'); }} /></section><GotzjiConnectionPanel disabled={host?.state !== 'ready'} /></>}
      {page === 'projects' && <><section><h3>โครงการที่ลงทะเบียน</h3>{projects.map((project) => <button disabled={busy} key={String(project.projectId)}
        onClick={() => { setProjectId(String(project.projectId)); setPage('tools'); }}>{String(project.displayName)} · {String(project.rootPath)}</button>)}</section>
        <section><h3>เพิ่มโครงการ</h3>{(['projectId', 'displayName', 'rootPath'] as const).map((field) => <label key={field}>{field === 'projectId' ? 'รหัสโครงการ' : field === 'displayName' ? 'ชื่อโครงการ' : 'โฟลเดอร์โครงการ'}
          <input disabled={busy} value={registration[field]} onChange={(event) => setRegistration({ ...registration, [field]: event.target.value })} /></label>)}
          {recipes.length > 0 && <fieldset><legend>คำสั่งที่ระบบตรวจไว้แล้ว</legend>{recipes.map((recipe) => <label key={String(recipe.recipeId)}>
            <input type="checkbox" disabled={busy} checked={selectedRecipes.includes(String(recipe.recipeId))} onChange={(event) => setSelectedRecipes((previous) => event.target.checked ? [...previous, String(recipe.recipeId)] : previous.filter((id) => id !== recipe.recipeId))} />{String(recipe.description)}</label>)}</fieldset>}
          <button disabled={busy || !registration.projectId || !registration.rootPath || !registration.displayName}
            onClick={() => void act(async () => { await request('registerProject', { ...registration, kind: projectKind, recipeIds: selectedRecipes }); await refresh(); setProjectId(registration.projectId); })}>ลงทะเบียน</button>
          <label>ประเภทโครงการ<select value={projectKind} disabled={busy} onChange={(event) => setProjectKind(event.target.value as 'project' | 'library')}><option value="project">โครงการทั่วไป</option><option value="library">Library ที่มีข้อกำหนดและดัชนี</option></select></label></section></>}
      {page === 'tools' && <><section><h3>เครื่องมือ</h3><table><thead><tr><th>เครื่องมือ</th><th>สถานะ</th><th>รายละเอียด</th></tr></thead><tbody>{catalog.map((item) =>
        <tr key={`${item.name}:${item.projectId ?? ''}:${item.workflowId ?? ''}:${item.workflowVersion ?? ''}`}><td>{String(item.workflowId ?? item.name)}</td><td>{item.state === 'available' ? 'พร้อมใช้งาน' : 'ยังไม่พร้อม'}</td><td>{String(item.reason ?? item.description ?? '')}</td></tr>)}</tbody></table></section>
        <GotzjiBrowserPanel projectId={projectId} disabled={host?.state !== 'ready'} onChanged={refresh} />
        {selectedProject?.kind === 'library' && <GotzjiLibraryChannelPanel projectId={projectId} disabled={host?.state !== 'ready'} />}
        <section><h3>เริ่มงานผ่าน Grace</h3><label>โครงการ<select disabled={busy} value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">เลือกโครงการ</option>
          {projects.map((project) => <option key={String(project.projectId)} value={String(project.projectId)}>{String(project.displayName)}</option>)}</select></label>
          <label>เครื่องมือ<select disabled={busy} value={operation} onChange={(event) => setOperation(event.target.value)}>{available.map((item) => <option key={String(item.name)} value={String(item.name)}>{String(item.name)}</option>)}{workflows.map((item) => <option key={`${item.workflowId}:${item.workflowVersion}`} value={`library:${item.workflowId}:${item.workflowVersion}`}>{String(item.workflowId)} · {String(item.description)}</option>)}</select></label>
          {!operation.startsWith('browser.') && !operation.startsWith('library:') && <label>{operation === 'command.run' ? 'คำสั่งที่ตรวจไว้แล้ว' : 'ไฟล์ในโครงการ'}{operation === 'command.run'
            ? <select disabled={busy} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">เลือกคำสั่ง</option>{boundRecipeIds.map((id) => <option key={id} value={id}>{String(recipes.find((recipe) => recipe.recipeId === id)?.description ?? id)}</option>)}</select>
            : <input disabled={busy} value={target} onChange={(event) => setTarget(event.target.value)} />}</label>}
          {operation.startsWith('library:') && <label>ข้อมูลของขั้นตอน Library<textarea value={workflowParameters} disabled={busy} onChange={(event) => setWorkflowParameters(event.target.value)} /></label>}
          {operation.startsWith('browser.') && <>{operation === 'browser.workflow' ? <label>ขั้นตอนเบราว์เซอร์<textarea value={browserValues.steps} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, steps: event.target.value })} /></label> : operation === 'browser.navigate' ? <label>หน้าเว็บที่จะเปิด<input value={browserValues.url} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, url: event.target.value })} /></label> : <><label>จุดที่เลือกบนหน้าเว็บ<input value={browserValues.selector} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, selector: event.target.value })} /></label>{operation === 'browser.type' && <label>ข้อความ<input value={browserValues.text} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, text: event.target.value })} /></label>}{operation === 'browser.click' && <><label>จุดที่จะตรวจหลังคลิก<input value={browserValues.postSelector} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, postSelector: event.target.value })} /></label><label>ข้อความที่ต้องพบหลังคลิก<input value={browserValues.expectedPostText} disabled={busy} onChange={(event) => setBrowserValues({ ...browserValues, expectedPostText: event.target.value })} /></label></>}</>}</>}
          {operation === 'file.write' && <><label><input type="checkbox" checked={expectedAbsent} disabled={busy} onChange={(event) => setExpectedAbsent(event.target.checked)} />สร้างไฟล์ใหม่ที่ยังไม่มีอยู่</label><label>SHA-256 ของไฟล์เดิม<input disabled={busy || expectedAbsent} value={expectedSha256} onChange={(event) => setExpectedSha256(event.target.value)} /></label>
            <label>เนื้อหาใหม่<textarea disabled={busy} value={content} onChange={(event) => setContent(event.target.value)} /></label></>}
          {nativeFormFields(operation).map((field) => <label key={field.name}>{field.label}{field.type === 'textarea'
            ? <textarea disabled={busy} value={nativeValues[field.name] ?? ''} onChange={(event) => setNativeValues({ ...nativeValues, [field.name]: event.target.value })} />
            : <input disabled={busy} type={field.type === 'number' ? 'number' : 'text'} value={nativeValues[field.name] ?? ''} onChange={(event) => setNativeValues({ ...nativeValues, [field.name]: event.target.value })} />}</label>)}
          <label>ลำดับความสำคัญ<select disabled={busy} value={priority} onChange={(event) => setPriority(event.target.value)}>{priorityOptions()}</select></label>
          <div className="gotzji-actions"><button disabled={busy || !projectId || !(operation.startsWith('browser.') || operation.startsWith('library:')) && !target || !(available.some((item) => item.name === operation) || workflows.some((item) => `library:${item.workflowId}:${item.workflowVersion}` === operation))} onClick={() => void act(prepare)}>ตรวจและเตรียมงาน</button>
            <button disabled={busy || preparationId === null} onClick={() => void act(submit)}>เริ่มงาน</button></div>
          {preparationId !== null && <p>เตรียมงานแล้ว · {requestId}</p>}</section></>}
      {page === 'worklog' && <><section><h3>เลือกงาน</h3><JobList jobs={jobs} disabled={busy} select={setJobId} />
        <label>รหัสงาน<input disabled={busy} value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="เลือกรายการหรือวางรหัสงาน" /></label></section>
        {jobId && <section><h3>งาน {jobId}</h3><JobStatus value={selectedJob} /><div className="gotzji-actions">
          <button disabled={busy || host?.state !== 'ready'} onClick={() => void act(async () => { setSelectedJob(await request('resume', { jobId })); })}>ตรวจและทำต่อ</button>
          <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('cancel', { jobId })); await refresh(); })}>ยกเลิกงานนี้</button>
          <button disabled={busy} onClick={() => void act(readLogs)}>อ่านบันทึกต่อ</button>
          <button disabled={busy} onClick={() => void act(async () => { setResult(await request('result', { jobId })); })}>ดูผลลัพธ์</button></div>
          {record(selectedJob) && selectedJob.status === 'queued' && <label>เปลี่ยนลำดับความสำคัญ<select disabled={busy || host?.state !== 'ready'} value={jobPriority} onChange={(event) => setJobPriority(event.target.value)}>{priorityOptions()}</select>
            <button disabled={busy || host?.state !== 'ready'} onClick={() => void act(async () => { setSelectedJob(await request('reprioritize', { jobId, priority: Number(jobPriority) })); await refresh(); })}>ปรับคิวงานนี้</button></label>}
          {record(selectedJob) && selectedJob.requestedOperation === 'library.workflow' && <fieldset><legend>อนุญาตส่งผลงานของงานนี้</legend><p>เลือกขอบเขตสำหรับรหัสงานนี้เท่านั้น แล้วตรวจและทำต่อ</p>
            <label>ขอบเขต<select value={deliveryScope} disabled={busy || host?.state !== 'ready'} onChange={(event) => setDeliveryScope(event.target.value)}><option value="commit">บันทึกลง Git</option><option value="push">ส่งขึ้น Git</option><option value="deploy">เผยแพร่เว็บ</option><option value="user-delivery">ส่งผลงานให้ผู้ใช้</option></select></label>
            <button disabled={busy || host?.state !== 'ready' || typeof selectedJob.projectId !== 'string'} onClick={() => void act(async () => { await request('authorizeLibraryDelivery', { projectId: selectedJob.projectId, jobId, scope: deliveryScope }); setSelectedJob(await request('status', { jobId })); })}>อนุญาตขอบเขตที่เลือกสำหรับงานนี้</button></fieldset>}
          {record(selectedJob) && Array.isArray(selectedJob.settleDecisions) && <fieldset><legend>ตัดสินงานที่ค้าง</legend><p>งานนี้ทำงานจบหรือหยุดไปแล้ว แต่ยังถือโครงการไว้ เพราะระบบยืนยันผลเองไม่ได้ ตรวจไฟล์หรือผลในโครงการก่อน แล้วเลือกตามที่เห็น ระบบจะบันทึกการตัดสินและปล่อยโครงการให้งานถัดไป โดยไม่แก้ไฟล์ใด ๆ</p>
            <div className="gotzji-actions">{selectedJob.settleDecisions.includes('effect-present') && <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('settleJob', { jobId, decision: 'effect-present' })); await refresh(); })}>ผลเกิดแล้ว · ปล่อยโครงการ</button>}
            {selectedJob.settleDecisions.includes('no-effect') && <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('settleJob', { jobId, decision: 'no-effect' })); await refresh(); })}>ไม่มีผล · ปล่อยโครงการ</button>}</div></fieldset>}
          {logs && <pre>{logs}</pre>}{result !== null && <pre>{display(result)}</pre>}</section>}</>}
      {page === 'queue' && <section><h3>งานที่กำลังรอ</h3><JobList jobs={queue} disabled={busy} select={(id) => { setJobId(id); setPage('worklog'); }} /></section>}
      {page === 'doctor' && <><section><h3>ระบบควบคุมงาน</h3><p>{host?.state === 'ready' ? 'ระบบพร้อมรับงาน · Grace ควบคุมการทำงาน' : host?.state === 'control-only' ? 'ควบคุมงานเดิมได้ · รอตรวจความเข้ากันได้ของรุ่น' : 'ยังไม่พร้อม'}</p>{host?.errorCode && <p>{host.errorCode}</p>}<p>อัปเดตด้วยไฟล์รุ่นที่ตรวจแล้ว</p>
        <h3>เครื่องมือและโปรแกรม</h3>{catalog.map((item) => <p key={`${item.name}:${item.projectId ?? ''}:${item.workflowId ?? ''}:${item.workflowVersion ?? ''}`}>{String(item.workflowId ?? item.name)}: {String(item.state)} {String(item.reason ?? '')}</p>)}</section><GotzjiConnectionPanel disabled={host?.state !== 'ready'} /><GotzjiStartupPanel /></>}
    </main>
  </div>;
}
function JobList({ jobs, select, disabled }: { readonly jobs: readonly Row[]; readonly select: (jobId: string) => void; readonly disabled: boolean }): ReactElement {
  return <div className="gotzji-job-list">{jobs.length === 0 ? <p>ยังไม่มีงาน</p> : jobs.map((job) => <button disabled={disabled} key={String(job.jobId)} onClick={() => select(String(job.jobId))}>
    <strong>{String(job.requestedOperation ?? job.operation ?? 'งาน')}</strong><span>{statusLabel(job.status)} · {String(job.projectId ?? '')}</span><small>{String(job.jobId)}</small></button>)}</div>;
}
function JobStatus({ value }: { readonly value: unknown }): ReactElement {
  if (!record(value)) return <p>กำลังอ่านสถานะ…</p>;
  const progress = record(value.progress) ? value.progress : null;
  return <><p><strong>{statusLabel(value.status)}</strong>{value.waitingReason ? ` · ${String(value.waitingReason)}` : ''}</p>
    {Number(value.queuePosition) > 0 && <p>ลำดับคิว {String(value.queuePosition)} · ความสำคัญ {String(value.priority ?? 1)}</p>}
    {value.blockingJob ? <p>รอทรัพยากรจากงาน {String(value.blockingJob)}</p> : null}
    {value.blockingDependency ? <p>รอผลงาน {String(value.blockingDependency)}</p> : null}
    {progress && <p>ใช้เวลา {Math.floor(Number(progress.elapsedMs ?? 0) / 1_000)} วินาที · ความคืบหน้าล่าสุด {String(progress.lastProgressAt ?? '')}</p>}
    {value.blockerCode ? <p>{String(value.blockerCode)}</p> : null}
    {value.blockerCode === 'GRACE_ACCOUNT_LIMIT' && <p>บัญชี Claude ถึงขีดจำกัด งานนี้กำลังรอผู้ให้บริการ</p>}
    {typeof value.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt)) && <p>ลองงานเดิมต่อได้หลัง {new Date(value.retryAt).toLocaleString('th-TH')}</p>}
    <details><summary>รายละเอียดงาน</summary><pre>{display(value)}</pre></details></>;
}
function priorityOptions(): ReactElement[] { return ['ต่ำ', 'ปกติ', 'สูง', 'เร่งด่วน'].map((label, index) => <option key={index} value={String(index)}>{label}</option>); }
function statusLabel(value: unknown): string {
  const labels: Record<string, string> = { queued: 'รอคิว', running: 'กำลังทำงาน', verifying: 'กำลังตรวจผล', blocked: 'รอการแก้ไข', completed: 'เสร็จแล้ว', cancelled: 'ยกเลิกแล้ว', failed: 'เกิดข้อผิดพลาด' };
  return labels[String(value)] ?? String(value);
}
function record(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rows(value: unknown): readonly Row[] {
  const candidate = Array.isArray(value) ? value : record(value) ? (value.items ?? value.projects ?? value.jobs ?? value.operations) : null;
  if (!Array.isArray(candidate) || candidate.some((item: unknown) => !record(item))) throw new Error('LIST_RESPONSE_INVALID');
  return candidate as Row[];
}
function message(value: unknown): string { return value instanceof Error ? value.message : 'ไม่สามารถเชื่อมต่อได้'; }
function display(value: unknown): string { return value === null ? 'กำลังอ่านสถานะ…' : JSON.stringify(value, null, 2); }
