import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { GotzjiHostStatus, GotzjiMethod } from '@lnwjud/ipc-contracts';
import './gotzji.css';
import gracePortrait from './assets/grace.webp';
import { GotzjiProjectFiles } from './GotzjiProjectFiles.js';
import { GotzjiGitPanel } from './GotzjiGitPanel.js';
import { GotzjiToolReference } from './GotzjiToolReference.js';
import { GotzjiToolsPanel } from './GotzjiToolsPanel.js';
import { GotzjiWorkflowPrompts } from './GotzjiWorkflowPrompts.js';
import { GotzjiJobLogs } from './GotzjiJobLogs.js';
import { GotzjiProjectCommands } from './GotzjiProjectCommands.js';
import { projectCommandOptions } from './gotzji-project-commands.js';
import { buildNativeFormInput, nativeFormFields } from './gotzji-native-form.js';
import { DELIVERY_INSTRUCTION, EMPTY_RECIPE_FORM, recipeRequest, recipeReviewLines, type RecipeForm } from './gotzji-recipe-form.js';
import { GotzjiConnectionPanel } from './GotzjiConnectionPanel.js';
import { GotzjiStartupPanel } from './GotzjiStartupPanel.js';
import { GotzjiBrowserPanel } from './GotzjiBrowserPanel.js';
import { browserReadResult } from './gotzji-browser-result.js';
import { browserReadBinding, browserSessionProjection } from './gotzji-browser-session.js';
import { GotzjiLibraryChannelPanel } from './GotzjiLibraryChannelPanel.js';
import { statusLabel } from './gotzji-job-status.js';
import { GotzjiProjectContext } from './GotzjiProjectContext.js';
import { GotzjiVersionNotes } from './GotzjiVersionNotes.js';
import { GotzjiDeliveryApprovals } from './GotzjiDeliveryApprovals.js';
import { GotzjiProjectManager, type ManagedProject } from './GotzjiProjectManager.js';
import { GotzjiExcelSheetsResult, excelSheetsResult } from './GotzjiExcelSheetsResult.js';
import { GotzjiExcelRangeResult, excelRangeResult } from './GotzjiExcelRangeResult.js';
import { GotzjiOperationResult, operationResult, operationResultMessage } from './GotzjiOperationResult.js';
import { GotzjiDoctorPanel } from './GotzjiDoctorPanel.js';

type Row = Readonly<Record<string, unknown>>;
interface JobResultView { readonly jobId: string; readonly value: unknown; readonly loading: boolean; readonly error: string | null; readonly pageIndex: number }
type Page = 'home' | 'projects' | 'workflows' | 'tools' | 'git' | 'worklog' | 'live' | 'settings' | 'doctor';
const labels: Record<Page, string> = { home: 'หน้าแรก', projects: 'โครงการ', workflows: 'เวิร์กโฟลว์', tools: 'เครื่องมือ', git: 'Git', worklog: 'ประวัติงาน', live: 'บันทึกสด', settings: 'ตั้งค่า', doctor: 'ตรวจระบบ' };

/** Product controls address explicit canonical IDs, never the inherited provider API. */
export function GotzjiApp({ requestPort, exportNativePort }: { readonly requestPort?: (method: GotzjiMethod, input: Record<string, unknown>) => Promise<unknown>; readonly exportNativePort?: (jobId: string) => Promise<{ readonly exported: boolean; readonly cancelled: boolean }> } = {}): ReactElement {
  const worklogTabsId = useId();
  const historyFilterId = useId();
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState('all');
  const [worklogTab, setWorklogTab] = useState<'history' | 'queue'>('history');
  const [queueState, setQueueState] = useState<'loading' | 'ready' | 'error'>('loading');
  const workflowProjectSelectId = useId();
  const operationSelectId = useId();
  const [page, setPage] = useState<Page>('home');
  const [host, setHost] = useState<GotzjiHostStatus | null>(null);
  const [projects, setProjects] = useState<readonly Row[]>([]);
  const [managedProjects, setManagedProjects] = useState<readonly ManagedProject[] | null>(null);
  const [jobs, setJobs] = useState<readonly Row[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [catalog, setCatalog] = useState<readonly Row[]>([]);
  const [catalogState, setCatalogState] = useState<'ready' | 'unavailable'>('unavailable');
  const [diagnosticToolKey, setDiagnosticToolKey] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [jobId, setJobId] = useState('');
  const [nativeExportJob, setNativeExportJob] = useState<string | null>(null);
  const [nativeExportNotice, setNativeExportNotice] = useState<string | null>(null);
  const nativeExportLock = useRef<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<unknown>(null);
  const [resultView, setResultView] = useState<JobResultView | null>(null);
  const result = resultView?.jobId === jobId ? resultView.value : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState({ projectId: '', displayName: '', rootPath: '' });
  const [projectKind, setProjectKind] = useState<'project' | 'library'>('project');
  const [selectedRecipes, setSelectedRecipes] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState('file.read');
  const [toolPreparationOpen, setToolPreparationOpen] = useState(false);
  const toolPreparationRef = useRef<HTMLElement>(null);
  const projectFilesRef = useRef<HTMLDivElement>(null);
  const projectCommandsRef = useRef<HTMLDivElement>(null);
  const deliveryApprovalsRef = useRef<HTMLDivElement>(null);
  const toolStatusRef = useRef<HTMLDivElement>(null);
  const gitDestination = useRef<'commands' | 'approvals' | null>(null);
  const toolDiagnosticsDestination = useRef(false);
  const [target, setTarget] = useState('');
  const [content, setContent] = useState('');
  const [expectedSha256, setExpectedSha256] = useState('');
  const [expectedAbsent, setExpectedAbsent] = useState(false);
  const [workflowParameters, setWorkflowParameters] = useState('{"paths":"[\\"README.md\\"]"}');
  const [browserValues, setBrowserValues] = useState({ selector: 'h1', text: '', postSelector: 'h1', expectedPostText: '', url: '', steps: '[]' });
  const [deliveryScope, setDeliveryScope] = useState('commit');
  const [recipeForm, setRecipeForm] = useState<RecipeForm>(EMPTY_RECIPE_FORM);
  const [recipeReview, setRecipeReview] = useState<readonly string[]>([]);
  const [recipeBinding, setRecipeBinding] = useState({ projectId: '', recipeId: '' });
  const [reportExport, setReportExport] = useState<string | null>(null);
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [nativeValues, setNativeValues] = useState<Readonly<Record<string, string>>>({ paragraph: '1', slide: '1', x: '0', y: '0', z: '0' });
  const [priority, setPriority] = useState('1');
  const [queue, setQueue] = useState<readonly Row[]>([]);
  const [jobPriority, setJobPriority] = useState('1');
  const refreshGeneration = useRef(0);
  const resultGeneration = useRef(0);
  const resultSelection = useRef('');
  const preparationProject = useRef(projectId);

  function selectJob(id: string): void { if (nativeExportLock.current === null) setJobId(id); }
  async function exportSelectedNative(id: string): Promise<{ readonly exported: boolean; readonly cancelled: boolean }> {
    if (nativeExportLock.current !== null || resultSelection.current !== id) throw new Error('RESULT_SELECTION_CHANGED');
    nativeExportLock.current = id; setNativeExportJob(id); setNativeExportNotice(null);
    try { return await (exportNativePort ?? window.gotzji.exportNativeOutput)(id); }
    catch (error) {
      if (error instanceof Error && error.message.includes('NATIVE_OUTPUT_WRITE_INCOMPLETE')) setNativeExportNotice(`งาน ${id}: บันทึกไม่สำเร็จ ไฟล์ที่เลือกอาจไม่สมบูรณ์ โปรดตรวจไฟล์ก่อนใช้งาน`);
      throw error;
    }
    finally { nativeExportLock.current = null; setNativeExportJob(null); }
  }

  const request = useCallback((method: GotzjiMethod, input: Record<string, unknown> = {}): Promise<unknown> => requestPort ? requestPort(method, input) : window.gotzji.request({ method, input }), [requestPort]);
  useLayoutEffect(() => { preparationProject.current = projectId; }, [projectId]);
  useLayoutEffect(() => {
    const target = page === 'tools' && gitDestination.current === 'commands' ? projectCommandsRef.current
      : page === 'home' && gitDestination.current === 'approvals' ? deliveryApprovalsRef.current : null;
    if (target) { gitDestination.current = null; target.focus(); target.scrollIntoView({ block: 'start' }); }
    else if (page === 'tools' && gitDestination.current === 'commands') gitDestination.current = null;
  }, [page]);
  useLayoutEffect(() => {
    if (page === 'doctor' && toolDiagnosticsDestination.current && toolStatusRef.current) {
      toolDiagnosticsDestination.current = false;
      toolStatusRef.current.focus(); toolStatusRef.current.scrollIntoView({ block: 'start' });
    }
  }, [page]);
  useLayoutEffect(() => {
    resultSelection.current = jobId; resultGeneration.current += 1; setResultView(null);
    return (): void => { resultSelection.current = ''; resultGeneration.current += 1; };
  }, [jobId, request]);
  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current;
    try {
      const status = await window.gotzji.hostStatus();
      if (generation !== refreshGeneration.current) return;
      setHost(status);
      if (status.state === 'unavailable') { setCatalogState('unavailable'); setCatalog([]); setJobsLoaded(false); setManagedProjects(null); return; }
      if (status.state === 'control-only') {
        setCatalogState('unavailable'); setCatalog([]);
        const jobRows = await request('listJobs');
        if (generation !== refreshGeneration.current) return;
        setJobs(rows(jobRows)); setJobsLoaded(true); setProjects([]); setManagedProjects(null);
        return;
      }
      const [projectRows, jobRows, catalogRows, selected, managedRows] = await Promise.all([
        request('listProjects'), request('listJobs'), request('listCatalog'), request('selectedProject'), request('listManagedProjects'),
      ]);
      if (generation !== refreshGeneration.current) return;
      if (!Array.isArray(catalogRows) || !catalogRows.every(item => record(item) && typeof item.name === 'string' && typeof item.state === 'string')) throw new Error('CATALOG_RESPONSE_INVALID');
      setProjects(rows(projectRows));
      setManagedProjects(managedProjectRows(managedRows));
      setProjectId(record(selected) && typeof selected.projectId === 'string' ? selected.projectId : '');
      setJobs(rows(jobRows)); setJobsLoaded(true);
      setCatalog(rows(catalogRows));
      setCatalogState('ready');
    } catch (cause) {
      if (generation === refreshGeneration.current) { setCatalogState('unavailable'); setCatalog([]); }
      throw cause;
    }
  }, [request]);

  useEffect(() => {
    document.title = 'gotzji';
    let disposed = false;
    const update = (): void => { void refresh().catch((cause: unknown) => { if (!disposed) setError(message(cause)); }); };
    update();
    const timer = window.setInterval(update, 5_000);
    return (): void => { disposed = true; refreshGeneration.current += 1; window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    setPreparationId(null); setRequestId(null);
  }, [projectId, operation, target, content, expectedSha256, nativeValues, priority]);
  useEffect(() => {
    if (page !== 'home' && !(page === 'worklog' && worklogTab === 'queue')) return;
    setQueueState('loading');
    if (!host || host.state === 'unavailable') return;
    let disposed = false;
    const update = (): void => { void request('inspectQueue').then((value) => { if (!disposed) { setQueue(rows(value)); setQueueState('ready'); } }).catch(() => { if (!disposed) setQueueState('error'); }); };
    update(); const timer = window.setInterval(update, 3_000);
    return (): void => { disposed = true; window.clearInterval(timer); };
  }, [page, worklogTab, host?.state, request]);
  useEffect(() => {
    setSelectedJob(null);
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

  async function readResult(): Promise<void> {
    if (!jobId) return;
    const requestedJobId = jobId; const generation = ++resultGeneration.current;
    const isCurrentResultRequest = (): boolean => resultSelection.current === requestedJobId && resultGeneration.current === generation;
    setError(null); setResultView({ jobId: requestedJobId, value: null, loading: true, error: null, pageIndex: 0 });
    try {
      const value = await request('result', { jobId: requestedJobId });
      if (isCurrentResultRequest()) setResultView({ jobId: requestedJobId, value, loading: false, error: null, pageIndex: 0 });
    } catch (cause: unknown) {
      if (isCurrentResultRequest()) setResultView({ jobId: requestedJobId, value: null, loading: false, error: message(cause), pageIndex: 0 });
    }
  }
  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(null);
    try { await action(); } catch (cause: unknown) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function prepare(): Promise<void> {
    const stableId = requestId ?? crypto.randomUUID();
    setRequestId(stableId);
    const workflow = catalog.find((entry) => entry.name === 'library.workflow' && entry.projectId === projectId && `library:${entry.workflowId}:${entry.workflowVersion}` === operation);
    const selectedBrowser = operation.startsWith('browser.') ? browserReadBinding(browserSessionProjection(await request('browserSession', { projectId }), projectId), projectId) : null;
    if (preparationProject.current !== projectId) throw new Error('โครงการเปลี่ยนแล้ว เลือกเครื่องมือและเตรียมคำขอใหม่');
    const input: Record<string, unknown> = { requestId: stableId, projectId, operation: workflow ? 'library.workflow' : operation, priority: Number(priority) };
    if (workflow) { input.workflowId = workflow.workflowId; input.workflowVersion = workflow.workflowVersion; const parameters: unknown = JSON.parse(workflowParameters); if (!record(parameters)) throw new Error('LIBRARY_PARAMETERS_INVALID'); input.parameters = parameters; }
    else if (operation.startsWith('browser.')) {
      if (!selectedBrowser) throw new Error('ยังยืนยันหน้าปัจจุบันไม่ได้ เปิดเบราว์เซอร์ของโครงการแล้วตรวจหน้าปัจจุบันก่อนเตรียมคำขอ');
      Object.assign(input, selectedBrowser);
      if (operation === 'browser.workflow') input.steps = JSON.parse(browserValues.steps);
      else if (operation === 'browser.navigate') input.url = browserValues.url;
      else { input.selector = browserValues.selector; if (operation === 'browser.type') input.text = browserValues.text; if (operation === 'browser.click') { input.postSelector = browserValues.postSelector; input.expectedPostText = browserValues.expectedPostText; } }
    }
    else {
    if (operation === 'command.run') input.commandId = target;
    else input.path = target;
    if (operation === 'file.write') { input.content = content; input.expectedSha256 = expectedAbsent ? null : expectedSha256; }
    if (nativeFormFields(operation).length > 0 || operation === 'excel.sheets.inspect') { Object.assign(input, buildNativeFormInput(operation, nativeValues)); if (expectedSha256) input.expectedSha256 = expectedSha256; }
    }
    await navigator.clipboard.writeText(`อ่านบริบทโครงการ ${projectId} แล้วตรวจและเตรียมงานตามรายละเอียดนี้ผ่าน gotzji จากนั้นตรวจผลจริงและบันทึกสรุปเมื่อเสร็จ\n\n${JSON.stringify(input, null, 2)}`);
    setPreparationId(stableId);
  }
  const available = catalog.filter((item) => item.state === 'available' && item.recipeId === undefined && item.name !== 'library.workflow');
  const workflows = catalog.filter((item) => item.state === 'available' && item.name === 'library.workflow' && item.projectId === projectId);
  const recipes = catalog.filter((item) => item.state === 'available' && typeof item.recipeId === 'string');
  const selectedProject = projects.find((item) => item.projectId === projectId);
  const diagnosticTool = diagnosticToolKey === null ? undefined : catalog.find(item => toolIdentity(item) === diagnosticToolKey);
  const browserResult = browserReadResult(result);
  const sheetsResult = excelSheetsResult(result);
  const rangeResult = excelRangeResult(result, jobId);
  const resultProjectId = record(selectedJob) && selectedJob.jobId === jobId && typeof selectedJob.projectId === 'string' ? selectedJob.projectId : null;
  const simpleResult = resultProjectId ? operationResult(result, { jobId, projectId: resultProjectId }) : undefined;
  const boundRecipeIds = Array.isArray(selectedProject?.recipeIds) ? selectedProject.recipeIds as string[] : [];
  const projectCommands = projectCommandOptions(boundRecipeIds, catalog);
  const projectNames = new Map(projects.map(project => [String(project.projectId), String(project.displayName)]));
  const historyQuery = historySearch.trim().toLocaleLowerCase();
  const matchingHistory = jobs.filter(job => {
    const text = [job.jobId, job.projectId, projectNames.get(String(job.projectId)), job.requestedOperation, job.operation, job.summary, statusLabel(job.status)].join(' ').toLocaleLowerCase();
    return (historyStatus === 'all' || job.status === historyStatus) && text.includes(historyQuery);
  });

  return <div className="gotzji-app"><div className="gotzji-titlebar">gotzji</div>
    {nativeExportJob && <p role="status">กำลังบันทึกผลงานของงาน {nativeExportJob} · เลือกงานอื่นได้เมื่อเสร็จ</p>}
    {nativeExportNotice && <p role="alert">{nativeExportNotice}</p>}
    <aside><div className="gotzji-brand"><img src={gracePortrait} alt="Grace ผู้ช่วยส่วนตัว" /><div><h1>gotzji</h1><p>สั่งงานผ่านปลั๊กอิน ChatGPT</p></div></div><nav>{(Object.keys(labels) as Page[]).map((name) =>
      <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{labels[name]}</button>)}</nav>
      <p className="gotzji-owner">{host?.ownerId ? 'คอมพิวเตอร์เครื่องนี้' : 'กำลังเชื่อมต่อ'}</p><GotzjiVersionNotes /></aside>
    <main><header><h2>{labels[page]}</h2>{selectedProject && <p>โครงการที่เลือก: {String(selectedProject.displayName)}</p>}<button disabled={busy} onClick={() => void act(refresh)}>รีเฟรช</button></header>
      {error !== null && <div role="alert" className="gotzji-error">{error}<button onClick={() => setError(null)}>ปิด</button></div>}
      {page === 'home' && <><div className="gotzji-welcome"><div><p className="gotzji-greeting">Grace ผู้ช่วยงานบนคอมพิวเตอร์</p><h3>วันนี้มีอะไรให้ช่วยคะ</h3><p>เลือกโครงการ แล้วสั่งงานต่อจาก ChatGPT หรือเปิดดูงานเดิมได้ที่นี่</p><button onClick={() => setPage('projects')}>เปิดโครงการ</button></div><img src={gracePortrait} alt="" /></div><section><h3>เรื่องที่รอคุณดูแล</h3>{!jobsLoaded ? <p>กำลังตรวจงานที่รอคุณดูแล</p> : jobs.filter((job) => ['blocked', 'failed'].includes(String(job.status))).length === 0 ? <p>ไม่พบเรื่องที่รอคุณตอบจากข้อมูลล่าสุด</p> : <JobList jobs={jobs.filter((job) => ['blocked', 'failed'].includes(String(job.status)))} disabled={busy || nativeExportJob !== null} select={(id) => { selectJob(id); setPage('worklog'); }} />}</section><section><h3>ระบบควบคุม</h3><p>{host?.state === 'ready' ? 'ระบบในเครื่องพร้อมทำงาน' : host?.state === 'control-only' ? 'ดูผลและยกเลิกงานเดิมได้ · ต้องตรวจระบบก่อนเริ่มงานใหม่' : 'กำลังรอระบบ'}</p>
        {host?.errorCode && <p>{host.errorCode}</p>}{host?.action && <p>{host.action}</p>}<p>งานที่เริ่มแล้วมีประวัติแยกกัน เปิดกลับมาดูและควบคุมได้จากประวัติงาน</p></section>
        <section><h3>คิวงาน</h3><p>{queueState === 'ready' ? `งานที่กำลังรอ ${queue.length} งาน` : queueState === 'error' ? 'ยังอ่านคิวไม่ได้ ระบบจะตรวจใหม่เมื่อเชื่อมต่อได้' : 'กำลังอ่านคิวงาน…'}</p><button onClick={() => { setWorklogTab('queue'); setPage('worklog'); }}>เปิดคิวงาน</button></section><section><h3>งานล่าสุด {jobs.length} งาน</h3><JobList jobs={jobs} disabled={busy || nativeExportJob !== null} select={(id) => { selectJob(id); setPage('worklog'); }} /></section><div className="gotzji-navigation-target" ref={deliveryApprovalsRef} tabIndex={-1} role="group" aria-label="คำขอส่งมอบ"><GotzjiDeliveryApprovals request={request} disabled={busy || host?.state !== 'ready'} /></div><GotzjiConnectionPanel disabled={host?.state !== 'ready'} /></>}
      {page === 'projects' && <>{projectId && <GotzjiProjectContext key={projectId} projectId={projectId} request={request} onJob={(id) => { selectJob(id); setWorklogTab('history'); setPage('worklog'); }} />}<GotzjiProjectManager projects={managedProjects} selectedProjectId={projectId} disabled={busy || host?.state !== 'ready'} request={request}
        select={(id) => void act(async () => { await request('selectProject', { projectId: id }); setProjectId(id); setPage(current => current === 'projects' ? 'tools' : current); })} changed={refresh} />
        <section><h3>เพิ่มโครงการ</h3>{(['projectId', 'displayName', 'rootPath'] as const).map((field) => <label key={field}>{field === 'projectId' ? 'รหัสโครงการ' : field === 'displayName' ? 'ชื่อโครงการ' : 'โฟลเดอร์โครงการ'}
          <input disabled={busy} value={registration[field]} onChange={(event) => setRegistration({ ...registration, [field]: event.target.value })} /></label>)}
          <button disabled={busy || host?.state !== 'ready'} onClick={() => void act(async () => {
            const selected = await window.gotzji.pickProjectFolder();
            if (!selected.cancelled) setRegistration(previous => ({ ...previous, rootPath: selected.path }));
          })}>เลือกโฟลเดอร์โครงการ</button>
          {recipes.length > 0 && <fieldset><legend>คำสั่งที่ระบบตรวจไว้แล้ว</legend>{recipes.map((recipe) => <label key={String(recipe.recipeId)}>
            <input type="checkbox" disabled={busy} checked={selectedRecipes.includes(String(recipe.recipeId))} onChange={(event) => setSelectedRecipes((previous) => event.target.checked ? [...previous, String(recipe.recipeId)] : previous.filter((id) => id !== recipe.recipeId))} />{String(recipe.description)}</label>)}</fieldset>}
          <button disabled={busy || !registration.projectId || !registration.rootPath || !registration.displayName}
            onClick={() => void act(async () => { await request('registerProject', { ...registration, kind: projectKind, recipeIds: selectedRecipes }); await request('selectProject', { projectId: registration.projectId }); await refresh(); })}>ลงทะเบียน</button>
          <label>ประเภทโครงการ<select value={projectKind} disabled={busy} onChange={(event) => setProjectKind(event.target.value as 'project' | 'library')}><option value="project">โครงการทั่วไป</option><option value="library">Library ที่มีข้อกำหนดและดัชนี</option></select></label></section>
        <section><h3>คำสั่งที่เจ้าของตรวจแล้ว</h3><p>คำสั่งนี้รันโปรแกรมที่เลือกด้วยสิทธิ์ของคุณ ChatGPT เลือกได้เฉพาะคำสั่งที่ผูกกับโครงการ และใส่อาร์กิวเมนต์เองไม่ได้ ไฟล์ที่เขียนเป็น {'${projectRoot}/…'} จะตรึงค่าตอนเริ่มงานแต่ละครั้ง ซึ่ง ChatGPT แก้ไฟล์ในโครงการได้ ถ้าต้องการตรึงสคริปต์ไว้ตั้งแต่ตอนอนุมัติ ให้ใช้ path เต็มนอกโครงการ อย่าใส่ path ในชื่อคำสั่ง เพราะ ChatGPT เห็นชื่อนี้ PowerShell ให้ใส่ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File และ python แนะนำ -I</p>
          {(['recipeId', 'displayName', 'executable', 'timeoutMinutes'] as const).map((field) => <label key={field}>{field === 'recipeId' ? 'รหัสคำสั่ง' : field === 'displayName' ? 'ชื่อที่ ChatGPT เห็น' : field === 'executable' ? 'โปรแกรม (path เต็ม)' : 'เวลาสูงสุด (นาที)'}
            <input disabled={busy} value={recipeForm[field]} onChange={(event) => setRecipeForm({ ...recipeForm, [field]: event.target.value })} /></label>)}
          {(['args', 'dependencies'] as const).map((field) => <label key={field}>{field === 'args' ? 'อาร์กิวเมนต์ (บรรทัดละหนึ่ง)' : 'ไฟล์ที่คำสั่งใช้ (บรรทัดละหนึ่ง)'}
            <textarea disabled={busy} value={recipeForm[field]} onChange={(event) => setRecipeForm({ ...recipeForm, [field]: event.target.value })} /></label>)}
          <label><input type="checkbox" disabled={busy} checked={recipeForm.projectOnly} onChange={(event) => setRecipeForm({ ...recipeForm, projectOnly: event.target.checked })} />
            เขียนเฉพาะในโฟลเดอร์ของโครงการ: เลือกเมื่อคำสั่งนี้ไม่เขียนนอกโฟลเดอร์ของโครงการ และไม่รัน Git หรือ build ทั้งคลัง งานในโฟลเดอร์อื่นของเวิร์กสเปซเดียวกันจะทำพร้อมกันได้ ถ้าไม่เลือก คำสั่งนี้จะถือทั้งเวิร์กสเปซจนจบ</label>
          <label><input type="checkbox" disabled={busy} checked={recipeForm.delivery} onChange={(event) => setRecipeForm({ ...recipeForm, delivery: event.target.checked })} />
            คำสั่งส่งมอบ (push, เผยแพร่, โปรโมตเป็นเวอร์ชันทางการ): {DELIVERY_INSTRUCTION} การอนุมัติยังไม่เริ่มงาน สิ่งที่ถูกส่งออกคือสิ่งที่อยู่ในโครงการตอนที่รัน ถ้าต้องการตรึงสิ่งที่ส่ง ให้ประกาศไฟล์นั้นเป็นไฟล์ที่คำสั่งใช้</label>
          <button disabled={busy || !recipeForm.recipeId || !recipeForm.executable} onClick={() => void act(async () => { setRecipeReview(recipeReviewLines(await request('registerRecipe', { ...recipeRequest(recipeForm) }))); await refresh(); })}>อนุมัติคำสั่งนี้</button>
          {recipeReview.length > 0 && <pre>{recipeReview.join('\n')}</pre>}
          <label>ผูกกับโครงการ<select disabled={busy} value={recipeBinding.projectId} onChange={(event) => setRecipeBinding({ ...recipeBinding, projectId: event.target.value })}><option value="">เลือกโครงการ</option>
            {projects.filter((project) => project.kind !== 'library').map((project) => <option key={String(project.projectId)} value={String(project.projectId)}>{String(project.displayName)}</option>)}</select></label>
          <label>คำสั่ง<select disabled={busy} value={recipeBinding.recipeId} onChange={(event) => setRecipeBinding({ ...recipeBinding, recipeId: event.target.value })}><option value="">เลือกคำสั่ง</option>
            {recipes.map((recipe) => <option key={String(recipe.recipeId)} value={String(recipe.recipeId)}>{String(recipe.description ?? recipe.recipeId)}</option>)}</select></label>
          <button disabled={busy || !recipeBinding.projectId || !recipeBinding.recipeId} onClick={() => void act(async () => { await request('bindProjectRecipe', recipeBinding); await refresh(); })}>เพิ่มคำสั่งให้โครงการ</button></section></>}
      {selectedProject && <div className="gotzji-navigation-target" ref={projectCommandsRef} tabIndex={-1} role="group" aria-label="คำสั่งของโครงการ" hidden={page !== 'tools'}><GotzjiProjectCommands chatgptOnly key={`${JSON.stringify(selectedProject)}:${JSON.stringify(projectCommands)}`} visible={page === 'tools'} projectId={projectId} projectName={String(selectedProject.displayName)} commands={projectCommands} disabled={busy || host?.state !== 'ready'} request={request} onSettings={() => setPage('projects')} onJob={(id) => { selectJob(id); setPage((current) => current === 'tools' ? 'worklog' : current); void refresh(); }} /></div>}
      {selectedProject && <GotzjiBrowserPanel chatgptOnly key={projectId} visible={page === 'tools'} projectId={projectId} projectName={String(selectedProject.displayName)} disabled={busy || host?.state !== 'ready'} request={request} onChanged={refresh} onJob={(id) => { selectJob(id); setPage((current) => current === 'tools' ? 'worklog' : current); void refresh(); }} />}
      {page === 'tools' && <><GotzjiToolsPanel catalog={catalog.filter(item => item.projectId === undefined || item.projectId === projectId)} projectName={selectedProject ? String(selectedProject.displayName) : null} boundRecipeIds={boundRecipeIds} canBindRecipes={selectedProject?.kind !== 'library'} disabled={busy || host?.state !== 'ready'} onProject={item => { if (typeof item?.recipeId === 'string') setRecipeBinding({ projectId: selectedProject?.kind === 'library' ? '' : projectId, recipeId: item.recipeId }); setPage('projects'); }} onDiagnostics={item => { setDiagnosticToolKey(toolIdentity(item)); toolDiagnosticsDestination.current = true; setPage('doctor'); }} onPrepare={item => {
        if (['file.read.direct', 'file.list', 'file.search'].includes(String(item.name))) { projectFilesRef.current?.focus(); projectFilesRef.current?.scrollIntoView({ block: 'start' }); return; }
        setOperation(item.name === 'library.workflow' ? `library:${item.workflowId}:${item.workflowVersion}` : typeof item.recipeId === 'string' ? 'command.run' : String(item.name));
        setTarget(typeof item.recipeId === 'string' && boundRecipeIds.includes(item.recipeId) ? item.recipeId : '');
        setPreparationId(null); setRequestId(null); setToolPreparationOpen(true);
        requestAnimationFrame(() => { toolPreparationRef.current?.focus(); toolPreparationRef.current?.scrollIntoView({ block: 'start' }); });
      }} />{projectId && <div ref={projectFilesRef} tabIndex={-1}><GotzjiProjectFiles chatgptOnly key={projectId} projectId={projectId} request={request} disabled={busy || host?.state !== 'ready'} onJob={(id) => { selectJob(id); setPage('worklog'); void refresh(); }} /></div>}
        <GotzjiToolReference />
        {selectedProject?.kind === 'library' && <GotzjiLibraryChannelPanel projectId={projectId} disabled={host?.state !== 'ready'} />}
        <details className="gotzji-advanced" open={toolPreparationOpen || operation === 'excel.range.read' && sheetsResult !== undefined} onToggle={event => setToolPreparationOpen(event.currentTarget.open)}><summary>เครื่องมือขั้นสูง</summary><section ref={toolPreparationRef} tabIndex={-1}><h3>เตรียมคำสั่งของโครงการ</h3><label>โครงการ<select disabled={busy} value={projectId} onChange={(event) => { const id = event.target.value; if (id) void act(async () => { await request('selectProject', { projectId: id }); setProjectId(id); }); }}><option value="">เลือกโครงการ</option>
          {projects.map((project) => <option key={String(project.projectId)} value={String(project.projectId)}>{String(project.displayName)}</option>)}</select></label>
          <label htmlFor={operationSelectId}>เครื่องมือ</label><select id={operationSelectId} disabled={busy} value={operation} onChange={(event) => setOperation(event.target.value)}>{available.map((item) => <option key={String(item.name)} value={String(item.name)}>{String(item.name)}</option>)}{workflows.map((item) => <option key={`${item.workflowId}:${item.workflowVersion}`} value={`library:${item.workflowId}:${item.workflowVersion}`}>{String(item.workflowId)} · {String(item.description)}</option>)}</select>
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
          <div className="gotzji-actions"><button disabled={busy || !projectId || !(operation.startsWith('browser.') || operation.startsWith('library:')) && !target || !(available.some((item) => item.name === operation) || workflows.some((item) => `library:${item.workflowId}:${item.workflowVersion}` === operation))} onClick={() => void act(prepare)}>คัดลอกคำสั่งสำหรับ ChatGPT</button></div>
          {preparationId !== null && <p>คัดลอกแล้ว วางข้อความใน ChatGPT เพื่อเริ่มงาน</p>}</section></details></>}
      {page === 'worklog' && <><div className="gotzji-tabs" role="tablist" aria-label="มุมมองประวัติงาน" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const focused = event.target instanceof HTMLElement && event.target.id === `${worklogTabsId}-history` ? 'history' : 'queue';
        const next = event.key === 'Home' ? 'history' : event.key === 'End' ? 'queue' : focused === 'history' ? 'queue' : 'history';
        setWorklogTab(next); document.getElementById(`${worklogTabsId}-${next}`)?.focus();
      }}>
        {(['history', 'queue'] as const).map((tab) => <button key={tab} id={`${worklogTabsId}-${tab}`} role="tab" aria-selected={worklogTab === tab} aria-controls={`${worklogTabsId}-panel`} tabIndex={worklogTab === tab ? 0 : -1} onClick={() => setWorklogTab(tab)}>{tab === 'history' ? 'รายการงาน' : 'คิวงาน'}</button>)}
      </div><section role="tabpanel" id={`${worklogTabsId}-panel`} aria-labelledby={`${worklogTabsId}-${worklogTab}`} tabIndex={0}>
        {worklogTab === 'history' ? <><h3>เลือกงาน</h3><div role="region" aria-label="ค้นหาและกรองประวัติงาน">
          <label htmlFor={`${historyFilterId}-search`}>ค้นหาประวัติงาน<input id={`${historyFilterId}-search`} type="search" value={historySearch} onChange={event => setHistorySearch(event.target.value)} placeholder="โครงการ รหัสงาน หรือเครื่องมือ" /></label>
          <label htmlFor={`${historyFilterId}-status`}>สถานะงานที่แสดง</label><select id={`${historyFilterId}-status`} value={historyStatus} onChange={event => setHistoryStatus(event.target.value)}><option value="all">ทุกสถานะ</option>{['queued', 'running', 'verifying', 'blocked', 'completed', 'cancelled', 'failed'].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
          {!jobsLoaded ? <p>{host?.state === 'unavailable' ? 'ระบบในเครื่องยังไม่พร้อม อ่านประวัติใหม่เมื่อเชื่อมต่อได้' : 'กำลังอ่านประวัติงาน…'}</p> : <><p aria-live="polite">แสดง {matchingHistory.length} จาก {jobs.length} งานที่อ่านได้</p>{jobs.length > 0 && matchingHistory.length === 0 ? <p>ไม่พบงานที่ตรงกับตัวกรองในข้อมูลที่อ่านได้</p> : <JobList jobs={matchingHistory} projectNames={projectNames} disabled={busy || nativeExportJob !== null} select={selectJob} />}</>}
        </div>
          <label>รหัสงาน<input disabled={busy || nativeExportJob !== null} value={jobId} onChange={(event) => selectJob(event.target.value)} placeholder="เลือกรายการหรือวางรหัสงาน" /></label></>
          : <><h3>งานที่กำลังรอ</h3>{queueState === 'loading' ? <p role="status">กำลังอ่านคิวงาน…</p> : queueState === 'error' ? <p role="alert">ยังอ่านคิวไม่ได้ ระบบจะตรวจใหม่เมื่อเชื่อมต่อได้</p> : <JobList jobs={queue} disabled={busy || nativeExportJob !== null} select={selectJob} />}</>}
      </section>
        {jobId && <section><h3>งาน {jobId}</h3><JobStatus value={selectedJob} /><div className="gotzji-actions">
          <button disabled={busy || host?.state !== 'ready'} onClick={() => void act(async () => { setSelectedJob(await request('resume', { jobId })); })}>ตรวจและทำต่อ</button>
          <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('cancel', { jobId })); await refresh(); })}>ยกเลิกงานนี้</button>
          <button disabled={busy} onClick={() => setPage('live')}>อ่านบันทึกต่อ</button>
          <button disabled={busy} onClick={() => void readResult()}>ดูผลลัพธ์</button></div>
          {resultView?.jobId === jobId && resultView.loading && <p role="status">กำลังอ่านผลลัพธ์…</p>}
          {resultView?.jobId === jobId && resultView.error && <div role="alert"><p>{operationResultMessage(resultView.error)}</p><details><summary>รายละเอียดข้อผิดพลาด</summary><pre>{resultView.error}</pre></details></div>}
          {record(selectedJob) && selectedJob.status === 'queued' && <label>เปลี่ยนลำดับความสำคัญ<select disabled={busy || host?.state !== 'ready'} value={jobPriority} onChange={(event) => setJobPriority(event.target.value)}>{priorityOptions()}</select>
            <button disabled={busy || host?.state !== 'ready'} onClick={() => void act(async () => { setSelectedJob(await request('reprioritize', { jobId, priority: Number(jobPriority) })); await refresh(); })}>ปรับคิวงานนี้</button></label>}
          {record(selectedJob) && selectedJob.requestedOperation === 'library.workflow' && <fieldset><legend>อนุญาตส่งผลงานของงานนี้</legend><p>เลือกขอบเขตสำหรับรหัสงานนี้เท่านั้น แล้วตรวจและทำต่อ</p>
            <label>ขอบเขต<select value={deliveryScope} disabled={busy || host?.state !== 'ready'} onChange={(event) => setDeliveryScope(event.target.value)}><option value="commit">บันทึกลง Git</option><option value="push">ส่งขึ้น Git</option><option value="deploy">เผยแพร่เว็บ</option><option value="user-delivery">ส่งผลงานให้ผู้ใช้</option></select></label>
            <button disabled={busy || host?.state !== 'ready' || typeof selectedJob.projectId !== 'string'} onClick={() => void act(async () => { await request('authorizeLibraryDelivery', { projectId: selectedJob.projectId, jobId, scope: deliveryScope }); setSelectedJob(await request('status', { jobId })); })}>อนุญาตขอบเขตที่เลือกสำหรับงานนี้</button></fieldset>}
          {record(selectedJob) && Array.isArray(selectedJob.settleDecisions) && <fieldset><legend>ตัดสินงานที่ค้าง</legend><p>งานนี้ทำงานจบหรือหยุดไปแล้ว แต่ยังถือโครงการไว้ เพราะระบบยืนยันผลเองไม่ได้ ตรวจไฟล์หรือผลในโครงการก่อน แล้วเลือกตามที่เห็น ระบบจะบันทึกการตัดสินและปล่อยโครงการให้งานถัดไป โดยไม่แก้ไฟล์ใด ๆ</p>
            <div className="gotzji-actions">{selectedJob.settleDecisions.includes('effect-present') && <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('settleJob', { jobId, decision: 'effect-present' })); await refresh(); })}>ผลเกิดแล้ว · ปล่อยโครงการ</button>}
            {selectedJob.settleDecisions.includes('no-effect') && <button disabled={busy} onClick={() => void act(async () => { setSelectedJob(await request('settleJob', { jobId, decision: 'no-effect' })); await refresh(); })}>ไม่มีผล · ปล่อยโครงการ</button>}</div></fieldset>}
          {result !== null && (sheetsResult ? <><GotzjiExcelSheetsResult value={sheetsResult} disabled={busy || host?.state !== 'ready' || !projects.some((project) => project.projectId === sheetsResult.projectId)}
            select={(sheet) => void act(async () => {
              await request('selectProject', { projectId: sheetsResult.projectId }); setProjectId(sheetsResult.projectId);
              setOperation('excel.range.read'); setTarget(sheetsResult.path); setExpectedSha256(sheetsResult.sourceSha256);
              setNativeValues((previous) => ({ ...previous, sheet: sheet.name, range: sheet.used_range.split(':')[0]! })); setPage('tools');
            })} /><details><summary>รายละเอียดการตรวจยืนยัน</summary><pre>{display(result)}</pre></details></>
            : rangeResult ? <><GotzjiExcelRangeResult value={rangeResult} pageIndex={resultView?.pageIndex ?? 0}
              pageChanged={(pageIndex) => setResultView((previous) => previous && previous === resultView ? { ...previous, pageIndex } : previous)} />
              <details><summary>รายละเอียดการตรวจยืนยัน</summary><pre>{display(result)}</pre></details></>
            : browserResult ? <section aria-label="ผลการอ่านหน้าเว็บ"><h4>อ่านหน้าเว็บสำเร็จ</h4><p>{browserResult.url}</p><pre>{browserResult.text || 'หน้านี้ไม่มีข้อความ'}</pre><details><summary>รายละเอียดการตรวจยืนยัน</summary><pre>{display(result)}</pre></details></section>
            : simpleResult && resultProjectId ? <><GotzjiOperationResult key={`${jobId}:${resultProjectId}`} value={simpleResult} onLogs={() => setPage('live')} exportNative={() => exportSelectedNative(jobId)} disabled={busy || host?.state !== 'ready'} readFile={async (path) => {
              const generation = resultGeneration.current;
              const refreshed = await request('result', { jobId });
              if (resultSelection.current !== jobId || resultGeneration.current !== generation) throw new Error('RESULT_SELECTION_CHANGED');
              const verified = operationResult(refreshed, { jobId, projectId: resultProjectId });
              if (simpleResult.kind !== 'file-write' || verified?.kind !== 'file-write' || verified.path !== path || verified.sha256 !== simpleResult.sha256) throw new Error('RESULT_NOT_VERIFIED');
              return request('readProjectFile', { projectId: resultProjectId, path });
            }} /><details><summary>รายละเอียดการตรวจยืนยัน</summary><pre>{display(result)}</pre></details></>
            : <section aria-label="รายละเอียดผลลัพธ์"><p>ผลชนิดนี้ยังไม่มีมุมมองสรุป เปิดรายละเอียดจากระบบเพื่อตรวจข้อมูล</p><details><summary>รายละเอียดการตรวจยืนยัน</summary><pre>{display(result)}</pre></details></section>)}</section>}</>}
      {page === 'workflows' && <><section><label htmlFor={workflowProjectSelectId}>โครงการสำหรับเวิร์กโฟลว์</label><select id={workflowProjectSelectId} value={projectId} disabled={busy || host?.state !== 'ready'} onChange={(event) => { const id = event.target.value; if (id) void act(async () => { await request('selectProject', { projectId: id }); setProjectId(id); }); }}><option value="">เลือกโครงการ</option>{projects.map((project) => <option key={String(project.projectId)} value={String(project.projectId)}>{String(project.displayName)}</option>)}</select></section>
        <GotzjiWorkflowPrompts key={`${projectId}:${String(selectedProject?.displayName ?? '')}`} project={selectedProject ? { projectId, displayName: String(selectedProject.displayName) } : null} disabled={busy || host?.state !== 'ready'} />
        <section><h3>งาน Library ของโครงการ</h3><p>เลือกงานที่ระบบรองรับสำหรับโครงการนี้ แล้วตรวจรายละเอียดก่อนเริ่ม</p>
          {workflows.length === 0 ? <><p>ยังไม่มีงาน Library ที่พร้อมใช้งานสำหรับโครงการนี้</p><button onClick={() => setPage('projects')}>เลือกโครงการ</button></> : workflows.map((workflow) => <article key={`${workflow.workflowId}:${workflow.workflowVersion}`}><h4>{String(workflow.workflowId)}</h4><p>{String(workflow.description)}</p><button onClick={() => { setOperation(`library:${workflow.workflowId}:${workflow.workflowVersion}`); setPage('tools'); }}>เปิดรายละเอียดและเตรียมงาน</button></article>)}
        </section></>}
      {page === 'settings' && <><GotzjiConnectionPanel disabled={host?.state !== 'ready'} /><GotzjiStartupPanel /></>}
      {page === 'git' && (projectId ? <GotzjiGitPanel key={projectId} projectId={projectId} disabled={busy || host?.state !== 'ready'} request={request} onCommands={() => { if (!selectedProject) { setPage('projects'); return; } gitDestination.current = 'commands'; setPage('tools'); }} onApprovals={() => { gitDestination.current = 'approvals'; setPage('home'); }} /> : <section><h3>เลือกโครงการก่อนดู Git</h3><button onClick={() => setPage('projects')}>เลือกโครงการ</button></section>)}
      {page === 'live' && <section><h3>บันทึกสดของงาน</h3><p>เลือกงานที่ต้องการอ่านบันทึก โดยไม่เริ่มงานซ้ำ</p><JobList jobs={jobs} disabled={busy || nativeExportJob !== null} select={selectJob} />{jobId && <><h3>งาน {jobId}</h3><JobStatus value={selectedJob} /><button onClick={() => setPage('worklog')}>ดูสถานะและผลลัพธ์</button></>}</section>}
      {page === 'doctor' && <><GotzjiDoctorPanel request={request} disabled={busy || !host || host.state === 'unavailable'} onJob={id => { selectJob(id); setPage('worklog'); }} /><section><h3>ระบบควบคุมงาน</h3><p>{host?.state === 'ready' ? 'ระบบในเครื่องพร้อมทำงาน' : host?.state === 'control-only' ? 'ควบคุมงานเดิมได้ · รอตรวจความเข้ากันได้ของรุ่น' : 'ยังไม่พร้อม'}</p>{host?.errorCode && <p>{host.errorCode}</p>}<p>อัปเดตด้วยไฟล์รุ่นที่ตรวจแล้ว</p>
        <div className="gotzji-navigation-target" ref={toolStatusRef} tabIndex={-1} role="group" aria-label="สถานะเครื่องมือ"><h3>เครื่องมือและโปรแกรม</h3>{catalogState !== 'ready' ? <p role="status">ยังอ่านสถานะเครื่องมือล่าสุดไม่ได้ ตรวจการเชื่อมต่อแล้วรีเฟรชอีกครั้ง</p> : <><p>สถานะจากการอ่านครั้งล่าสุด อาจเปลี่ยนได้</p>{diagnosticToolKey !== null && <div aria-label="เครื่องมือที่เลือก">{diagnosticTool ? <><p>เครื่องมือที่เลือก: {String(diagnosticTool.workflowId ?? diagnosticTool.recipeId ?? diagnosticTool.name)}</p><p>{String(diagnosticTool.name)}{diagnosticTool.projectId !== undefined ? ` · โครงการ: ${String(diagnosticTool.projectId)}` : ''}{diagnosticTool.workflowVersion !== undefined ? ` · รุ่น: ${String(diagnosticTool.workflowVersion)}` : ''}</p><p>{String(diagnosticTool.state)} {String(diagnosticTool.reason ?? '')}</p></> : <p>รายการที่เลือกไม่อยู่ในข้อมูลล่าสุด ลองกลับไปเลือกเครื่องมืออีกครั้ง</p>}</div>}{catalog.map((item) => <p key={toolIdentity(item)}>{String(item.workflowId ?? item.name)}: {String(item.state)} {String(item.reason ?? '')}</p>)}</>}</div></section><section><h3>รายงานช่วยเหลือ</h3><p>บันทึกเหตุผลของงานที่ล้มหรือค้าง ใครกำลังถือโครงการหรือทรัพยากรอะไร คิวงาน และสถานะของ CAD, Office และเบราว์เซอร์ ลงไฟล์ที่คุณเลือก รายงานมีชื่อโครงการตามที่คุณตั้ง แต่ไม่มีเนื้อหาไฟล์ path หรือ URL และไม่ถูกส่งไปที่ไหน</p><button disabled={busy || !host || host.state === 'unavailable'} onClick={() => void act(async () => { const saved = await window.gotzji.exportSupportReport(); setReportExport(saved.exported ? 'บันทึกรายงานแล้ว' : 'ยกเลิกการบันทึก'); })}>บันทึกรายงานช่วยเหลือ</button>{reportExport && <p>{reportExport}</p>}</section><GotzjiConnectionPanel disabled={host?.state !== 'ready'} /><GotzjiStartupPanel /></>}
      {jobId && <GotzjiJobLogs key={jobId} jobId={jobId} visible={page === 'live'} request={request} />}
    </main>
  </div>;
}
function JobList({ jobs, select, disabled, projectNames = new Map() }: { readonly jobs: readonly Row[]; readonly select: (jobId: string) => void; readonly disabled: boolean; readonly projectNames?: ReadonlyMap<string, string> }): ReactElement {
  return <div className="gotzji-job-list">{jobs.length === 0 ? <p>ยังไม่มีงาน</p> : jobs.map((job) => <button disabled={disabled} key={String(job.jobId)} onClick={() => select(String(job.jobId))}>
    <strong>{String(job.requestedOperation ?? job.operation ?? 'งาน')}</strong><span>{statusLabel(job.status)} · {projectNames.get(String(job.projectId)) ?? String(job.projectId ?? '')}</span><small>{String(job.jobId)}</small></button>)}</div>;
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
    {value.blockerCode === 'GRACE_ACCOUNT_LIMIT' && <p>งานเดิมจากรุ่นก่อนรอขีดจำกัดผู้ให้บริการ ดูหลักฐานก่อนดำเนินงานนั้นต่อ</p>}
    {typeof value.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt)) && <p>ลองงานเดิมต่อได้หลัง {new Date(value.retryAt).toLocaleString('th-TH')}</p>}
    <details><summary>รายละเอียดงาน</summary><pre>{display(value)}</pre></details></>;
}
function priorityOptions(): ReactElement[] { return ['ต่ำ', 'ปกติ', 'สูง', 'เร่งด่วน'].map((label, index) => <option key={index} value={String(index)}>{label}</option>); }

function toolIdentity(item: Row): string { return JSON.stringify([item.name, item.recipeId, item.projectId, item.workflowId, item.workflowVersion]); }
function record(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rows(value: unknown): readonly Row[] {
  const candidate = Array.isArray(value) ? value : record(value) ? (value.items ?? value.projects ?? value.jobs ?? value.operations) : null;
  if (!Array.isArray(candidate) || candidate.some((item: unknown) => !record(item))) throw new Error('LIST_RESPONSE_INVALID');
  return candidate as Row[];
}
function managedProjectRows(value: unknown): readonly ManagedProject[] {
  return rows(value).map((project) => {
    if (typeof project.projectId !== 'string' || typeof project.displayName !== 'string' || typeof project.rootPath !== 'string'
      || project.archivedAt !== null && typeof project.archivedAt !== 'string') throw new Error('PROJECT_LIST_INVALID');
    return { projectId: project.projectId, displayName: project.displayName, rootPath: project.rootPath, archivedAt: project.archivedAt };
  });
}
function message(value: unknown): string { return value instanceof Error ? value.message : 'ไม่สามารถเชื่อมต่อได้'; }
function display(value: unknown): string { return value === null ? 'กำลังอ่านสถานะ…' : JSON.stringify(value, null, 2); }
