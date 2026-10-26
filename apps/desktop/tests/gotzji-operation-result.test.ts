import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GotzjiOperationResult, operationResult, operationResultMessage } from '../src/renderer/GotzjiOperationResult.js';

const context = { jobId: 'selected-job', projectId: 'project-a' };
const sha256 = 'a'.repeat(64);
function envelope(output: Record<string, unknown>): Record<string, unknown> {
  return { verifier: 'host-product-receipt-v1', operation: output.operation, projectId: 'project-a', artifactHash: sha256, output };
}
describe('same-job operation result presentation', () => {
  it('explains retained-result expiry and changed evidence without claiming a successful read', () => {
    expect(operationResultMessage('RESULT_EXPIRED')).toContain('ไม่เก็บผลลัพธ์');
    expect(operationResultMessage('NATIVE_ARTIFACT_CHANGED')).toContain('เปลี่ยนไป');
    expect(operationResultMessage('RESULT_NOT_VERIFIED')).toContain('ยังไม่มีผล');
    expect(operationResultMessage('some internal stack')).not.toContain('some internal stack');
  });
  it('shows verified file content as text with the project path and no execution controls', () => {
    const value = operationResult(envelope({ operation: 'file.read', state: 'completed', projectId: 'project-a', path: 'ข้อมูล.txt', sha256, beforeSha256: sha256, content: '<script>ตัวอย่าง</script>' }), context);
    expect(value).toMatchObject({ kind: 'file-read', path: 'ข้อมูล.txt', content: '<script>ตัวอย่าง</script>' });
    const html = renderToStaticMarkup(createElement(GotzjiOperationResult, { value: value!, onLogs: () => { throw new Error('Rendering must not act'); } }));
    expect(html).toContain('อ่านไฟล์แล้ว'); expect(html).toContain('ข้อมูล.txt');
    expect(html).toContain('&lt;script&gt;ตัวอย่าง&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('<button');
  });
  it('distinguishes a newly created empty file from a replacement with a retained original', () => {
    const created = operationResult(envelope({ operation: 'file.write', state: 'completed', projectId: 'project-a', path: 'new.txt', sha256, beforeSha256: null, bytes: 0 }), context);
    expect(created).toMatchObject({ kind: 'file-write', path: 'new.txt', bytes: 0, created: true, originalRetained: false });
    const oldSha = 'b'.repeat(64);
    const replaced = operationResult({ ...envelope({ operation: 'file.write', state: 'completed', projectId: 'project-a', path: 'old.txt', sha256, beforeSha256: oldSha, bytes: 25 }), before: { sha256: oldSha, content: 'original' } }, context);
    expect(replaced).toMatchObject({ kind: 'file-write', created: false, originalRetained: true });
    const html = renderToStaticMarkup(createElement(GotzjiOperationResult, { value: replaced!, onLogs: () => undefined }));
    expect(html).toContain('บันทึกไฟล์แล้ว'); expect(html).toContain('25 ไบต์'); expect(html).toContain('มีสำเนาต้นฉบับในหลักฐานของงานนี้');
    expect(html).not.toContain('original');
  });
  it('shows the selected command exit and measured duration without treating log bytes as result content', () => {
    const value = operationResult(envelope({ operation: 'command.run', jobId: context.jobId, state: 'completed', commandId: 'check-project', exitCode: 0, elapsedMs: 1250, outputBytes: 1048576, truncated: true }), context);
    expect(value).toMatchObject({ kind: 'command', commandId: 'check-project', elapsedMs: 1250, truncated: true });
    const html = renderToStaticMarkup(createElement(GotzjiOperationResult, { value: value!, onLogs: () => undefined }));
    expect(html).toContain('คำสั่งจบแล้ว'); expect(html).toContain('รหัสจบ: 0'); expect(html).toContain('1.25 วินาที');
    expect(html).toContain('บันทึกข้อความถูกจำกัดขนาด'); expect(html).toContain('อ่านบันทึกของงานนี้');
  });
  it('accepts a successful command with no output and no optional truncation field', () => {
    expect(operationResult(envelope({ operation: 'command.run', jobId: context.jobId, state: 'completed', commandId: 'quiet-check', exitCode: 0, elapsedMs: 0, outputBytes: 0 }), context)).toMatchObject({ kind: 'command', outputBytes: 0, truncated: false });
  });
  it('refuses foreign, incomplete or failed evidence instead of presenting a success summary', () => {
    const file = { operation: 'file.read', state: 'completed', projectId: 'project-a', path: 'data.txt', sha256, content: 'data' };
    for (const value of [null, {}, { ...envelope(file), verifier: 'unverified' }, { ...envelope(file), projectId: 'foreign' },
      { ...envelope(file), artifactHash: 'bad' }, envelope({ ...file, projectId: 'foreign' }), envelope({ ...file, state: 'failed' }),
      envelope({ ...file, operation: 'unrecognized' }), envelope({ ...file, content: null }),
      envelope({ operation: 'command.run', state: 'completed', jobId: 'other-job', commandId: 'check', exitCode: 0, elapsedMs: 1, outputBytes: 0 }),
      envelope({ operation: 'file.write', state: 'completed', projectId: 'project-a', path: 'data.txt', sha256, beforeSha256: sha256, bytes: -1 }),
    ]) expect(operationResult(value, context)).toBeUndefined();
  });
});
