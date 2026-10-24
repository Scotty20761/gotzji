import { useId, useState, type ReactElement } from 'react';
import { buildWorkflowPrompt, workflowPromptTemplates, type WorkflowProject, type WorkflowPromptTemplate } from './gotzji-workflow-prompts.js';

export function GotzjiWorkflowPrompts({ project, disabled }: { readonly project: WorkflowProject | null; readonly disabled: boolean }): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const formId = useId();
  const template = workflowPromptTemplates.find((item) => item.id === selected);
  return <section className="gotzji-workflow-prompts"><h3>เริ่มงานกับ ChatGPT</h3>
    <p>เลือกงาน กรอกรายละเอียด แล้วตรวจคำขอก่อนนำไปวางใน ChatGPT ที่เชื่อม gotzji การคัดลอกยังไม่เริ่มงาน</p>
    {!project && <p>เลือกโครงการด้านบนเพื่อเตรียมคำขอ</p>}
    <div className="gotzji-workflow-cards">{workflowPromptTemplates.map((item) => <button key={item.id} disabled={disabled || !project} aria-pressed={selected === item.id} aria-controls={formId} onClick={() => setSelected(item.id)}>
      <strong>{item.title}</strong><span>{item.description}</span><small>{item.readOnly ? 'ตรวจและรายงานผล' : 'สร้างผลงานเป็นไฟล์ใหม่'}</small>
    </button>)}</div>
    <div id={formId}>{project && template && <WorkflowPromptForm key={template.id} template={template} project={project} disabled={disabled} />}</div>
  </section>;
}

function WorkflowPromptForm({ template, project, disabled }: { readonly template: WorkflowPromptTemplate; readonly project: WorkflowProject; readonly disabled: boolean }): ReactElement {
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(template.fields.map((field) => [field.key, field.options?.[0]?.value ?? ''])));
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const id = useId();
  const change = (key: string, value: string): void => { setValues((current) => ({ ...current, [key]: value })); setPreview(null); setError(null); setCopied(false); };
  const copy = async (): Promise<void> => {
    if (!preview || disabled || copying) return;
    setCopying(true); setError(null);
    try { await navigator.clipboard.writeText(preview); setCopied(true); }
    catch { setError('คัดลอกไม่สำเร็จ คุณเลือกและคัดลอกข้อความคำขอด้านล่างได้'); }
    finally { setCopying(false); }
  };
  return <form className="gotzji-workflow-form" onSubmit={(event) => {
    event.preventDefault(); setCopied(false);
    try { setPreview(buildWorkflowPrompt(template.id, project, values)); setError(null); }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'ตรวจรายละเอียดอีกครั้ง'); }
  }}>
    <fieldset disabled={disabled || copying}><legend>{template.title}</legend><p>โครงการ: {project.displayName}</p>
      {template.fields.map((field) => <label key={field.key} htmlFor={`${id}-${field.key}`}>{field.label}
        {field.options ? <select id={`${id}-${field.key}`} value={values[field.key] ?? ''} onChange={(event) => change(field.key, event.target.value)}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : <input id={`${id}-${field.key}`} maxLength={2048} required={!field.optional} value={values[field.key] ?? ''} placeholder={field.path ? 'ชื่อไฟล์ภายในโครงการ' : undefined} onChange={(event) => change(field.key, event.target.value)} />}
      </label>)}
      <button type="submit">ตรวจคำขอ</button>
      {error && <p role="alert" className="gotzji-file-error">{error}</p>}
      {preview && <div className="gotzji-workflow-review"><h4>ตรวจรายละเอียดก่อนส่ง</h4><p>{template.task}</p>
        <dl><dt>โครงการ</dt><dd>{project.displayName}</dd>{template.fields.filter((field) => values[field.key]?.trim()).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{field.options?.find((option) => option.value === values[field.key])?.label ?? values[field.key]}</dd></div>)}</dl>
        <p>ChatGPT จะตรวจเครื่องมือที่พร้อมจริงและดำเนินงานผ่าน gotzji ตามสิทธิ์เดิม</p>
        <button type="button" className="gotzji-primary" onClick={() => void copy()}>คัดลอกคำขอ</button>
        <p role="status">{copied ? 'คัดลอกแล้ว พร้อมนำไปวางใน ChatGPT' : 'ตรวจรายละเอียดแล้วจึงคัดลอกคำขอ'}</p>
        <details><summary>อ่านข้อความคำขอทั้งหมด</summary><label htmlFor={`${id}-preview`}>คำขอสำหรับ ChatGPT</label><textarea id={`${id}-preview`} value={preview} readOnly rows={12} /></details>
      </div>}
    </fieldset>
  </form>;
}
