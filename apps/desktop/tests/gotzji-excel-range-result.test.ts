import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { excelRangeResult, GotzjiExcelRangeResult } from '../src/renderer/GotzjiExcelRangeResult.js';

const sha256 = 'a'.repeat(64);

function cell(address: string, value: unknown = address, sheet = 'ข้อมูลจริง'): Record<string, unknown> {
  return { sheet, address, value, formula: value, format: 'General', bold: false };
}

function envelope(selected: readonly unknown[] = [cell('A1')], options: {
  readonly jobId?: string;
  readonly projectId?: string;
  readonly range?: string;
  readonly requestedSheet?: string;
} = {}): Record<string, unknown> {
  const jobId = options.jobId ?? 'job-1';
  const projectId = options.projectId ?? 'project';
  return {
    operation: 'excel.range.read', projectId,
    nativeSelection: { sheet: options.requestedSheet ?? 'ข้อมูล', range: options.range ?? 'A1' },
    output: {
      operation: 'excel.range.read', projectId, path: 'book.xlsx', state: 'completed', jobId,
      nativeReceipt: {
        operation: 'excel.range.read', provider: 'excel', providerVersion: '16', nativePid: 123,
        sourceSha256: sha256, outputSha256: null, originalPreserved: true, savedAndReopened: false,
        unrelatedPreserved: true, verified: true, before: { selected }, after: { selected },
      },
    },
  };
}

function parsed(selected: readonly unknown[] = [cell('A1')], options: Parameters<typeof envelope>[1] = {}): ReturnType<typeof excelRangeResult> {
  return excelRangeResult(envelope(selected, options), options.jobId ?? 'job-1');
}

function render(value: NonNullable<ReturnType<typeof excelRangeResult>>, pageIndex = 0): string {
  return renderToStaticMarkup(createElement(GotzjiExcelRangeResult, { value, pageIndex, pageChanged: vi.fn() }));
}

describe('Excel range result projection', () => {
  it('keeps requested and observed worksheet names distinct and renders raw Value2 scalars safely', () => {
    const selected = [
      cell('A1', 0), cell('A2', false), cell('A3', null), cell('A4', 'ภาษาไทย'), cell('A5', '<img src=x onerror=alert(1)>'),
    ].map((entry) => ({ ...entry, sheet: 'data' }));
    const value = parsed(selected, { range: 'A1:A5', requestedSheet: 'Data' });
    expect(value).toMatchObject({ requestedSheet: 'Data', observedSheet: 'data', requestedRange: 'A1:A5', normalizedRange: 'A1:A5' });
    expect(value?.cells.map((entry) => entry.value)).toEqual([0, false, null, 'ภาษาไทย', '<img src=x onerror=alert(1)>']);
    const html = render(value!);
    expect(html).toContain('ค่าดิบ (Value2)'); expect(html).toContain('>0<'); expect(html).toContain('>false<'); expect(html).toContain('>null<');
    expect(html).toContain('ภาษาไทย'); expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(html).not.toContain('<img src=x');
    expect(html).toContain('แผ่นงานที่ขอ'); expect(html).toContain('แผ่นงานที่ Excel รายงาน'); expect(html).toContain('ไม่สรุปว่าครบทุกเซลล์');
  });

  it('accepts partial and empty observed selections without inventing blanks or completeness', () => {
    const partial = parsed([cell('A1', 'first'), cell('C3', 'last')], { range: 'A1:C3' });
    expect(partial?.cells).toHaveLength(2); expect(partial?.observedSheet).toBe('ข้อมูลจริง');
    expect(render(partial!)).toContain('Excel ส่งกลับ 2 รายการ');
    const empty = parsed([], { range: 'A1:C3' });
    expect(empty).toMatchObject({ observedSheet: null, cells: [] });
    const html = render(empty!);
    expect(html).toContain('Excel ไม่ส่งกลับรายการเซลล์สำหรับช่วงนี้'); expect(html).not.toContain('<table>');
  });

  it('rejects malformed envelope, operation, project, selected job, status and receipt evidence', () => {
    const valid = envelope();
    const output = (valid.output as Record<string, unknown>);
    const receipt = output.nativeReceipt as Record<string, unknown>;
    const cases: unknown[] = [
      null,
      { ...valid, operation: 'excel.range.write' },
      { ...valid, output: { ...output, operation: 'excel.range.write' } },
      { ...valid, projectId: 'foreign' },
      { ...valid, output: { ...output, projectId: 'foreign' } },
      { ...valid, output: { ...output, jobId: 'job-2' } },
      { ...valid, output: { ...output, state: 'failed' } },
      { ...valid, nativeSelection: undefined },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, operation: 'excel.range.write' } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, provider: 'word' } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, verified: false } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, originalPreserved: false } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, unrelatedPreserved: false } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, outputSha256: sha256 } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, savedAndReopened: true } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, sourceSha256: 'not-a-hash' } } },
      { ...valid, output: { ...output, nativeReceipt: { ...receipt, after: { selected: 'not-an-array' } } } },
    ];
    for (const candidate of cases) expect(excelRangeResult(candidate, 'job-1')).toBeUndefined();
    expect(excelRangeResult(valid, 'job-2')).toBeUndefined();
  });

  it('rejects invalid cells, mixed observed worksheets, duplicates and cells outside the requested bounds', () => {
    const invalidCells = [
      { ...cell('A1'), value: Number.NaN },
      { ...cell('A1'), value: Number.POSITIVE_INFINITY },
      { ...cell('A1'), value: {} },
      { ...cell('A1'), formula: {} },
      { ...cell('A1'), format: 42 },
      { ...cell('A1'), bold: 'yes' },
      cell('$A$1'), cell('a1'), cell('A01'), cell('A1:B2'), cell('XFE1'), cell('A1048577'),
    ];
    for (const invalid of invalidCells) expect(parsed([invalid])).toBeUndefined();
    expect(parsed(Array.from({ length: 10_001 }, () => cell('A1')), { range: 'A1:A10000' })).toBeUndefined();
    expect(parsed([cell('A1'), cell('A1')])).toBeUndefined();
    expect(parsed([cell('A1'), cell('A2', 'other', 'อีกแผ่น')], { range: 'A1:A2' })).toBeUndefined();
    expect(parsed([cell('B1')], { range: 'A1' })).toBeUndefined();
  });

  it('normalizes absolute and reversed requested ranges through the Excel grid', () => {
    expect(parsed([cell('XFC1048575'), cell('XFD1048576')], { range: '$XFD$1048576:$XFC$1048575' })).toMatchObject({
      requestedRange: '$XFD$1048576:$XFC$1048575', normalizedRange: 'XFC1048575:XFD1048576',
    });
    expect(parsed([cell('A1')], { range: '$A$1' })).toMatchObject({ normalizedRange: 'A1' });
    expect(parsed([cell('A1'), cell('B2')], { range: 'B2:A1' })).toMatchObject({ normalizedRange: 'A1:B2' });
    for (const range of ['A0', 'A0001', 'a1', 'AAAA1', 'XFE1', 'A1048577', 'A1:A10001']) expect(parsed([], { range })).toBeUndefined();
    expect(parsed([], { range: 'A1:A10000' })).toBeDefined();
  });
});

describe('Excel range result pagination', () => {
  it.each([0, 1, 100, 101, 10_000])('retains and renders a bounded result with %i returned cells', (count) => {
    const selected = Array.from({ length: count }, (_, index) => cell(`A${index + 1}`, index));
    const value = parsed(selected, { range: `A1:A${Math.max(1, count)}` });
    expect(value?.cells).toHaveLength(count);
    const first = render(value!);
    expect(first).toContain(`Excel ส่งกลับ ${count} รายการ`);
    if (count <= 100) expect(first).not.toContain('แบ่งหน้าผลการอ่านช่วงเซลล์ Excel');
    else expect(first).toContain(`หน้า 1 จาก ${Math.ceil(count / 100)}`);
  });

  it('shows exactly 100 entries per page and preserves both results when rendering page zero explicitly', () => {
    const selected = Array.from({ length: 101 }, (_, index) => cell(`A${index + 1}`, `job-1-value-${index + 1}`));
    const first = parsed(selected, { range: 'A1:A101', jobId: 'job-1' })!;
    const secondPage = render(first, 1);
    expect(secondPage).toContain('job-1-value-101'); expect(secondPage).not.toContain('job-1-value-100<');
    expect(secondPage).toContain('หน้า 2 จาก 2');

    const replacementCells = Array.from({ length: 101 }, (_, index) => cell(`A${index + 1}`, `job-2-value-${index + 1}`));
    const replacement = parsed(replacementCells, { range: 'A1:A101', jobId: 'job-2' })!;
    const reset = render(replacement, 0);
    expect(reset).toContain('job-2-value-1'); expect(reset).not.toContain('job-2-value-101<'); expect(reset).toContain('หน้า 1 จาก 2');
    expect(first.cells).toHaveLength(101); expect(replacement.cells).toHaveLength(101); expect(first.jobId).not.toBe(replacement.jobId);
  });

  it('renders the final page of the 10000-entry maximum without dropping earlier entries from the model', () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => cell(`A${index + 1}`, index + 1));
    const value = parsed(selected, { range: 'A1:A10000' })!;
    const html = render(value, 99);
    expect(html).toContain('>A9901<'); expect(html).toContain('>A10000<'); expect(html).toContain('หน้า 100 จาก 100');
    expect(value.cells[0]?.address).toBe('A1'); expect(value.cells).toHaveLength(10_000);
  });
});
