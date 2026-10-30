import { describe, expect, it } from 'vitest';
import { doctorReport } from '../src/renderer/GotzjiDoctorPanel.js';

const id = 'a'.repeat(64);
const report = { schemaVersion: 1, generatedAt: '2026-10-27T00:00:00.000Z', jobs: [{ jobId: id, status: 'completed', operation: 'file.read', requestIdHash: 'retained', events: [] }], holders: [{ jobId: id, kind: 'writer', resource: 'folder:123456789abc', epoch: 'private-internal' }], host: { unrelated: 'not for display' } };

describe('app-only Doctor report presentation boundary', () => {
  it('projects canonical job identity and retained status without treating it as verified result contents', () => {
    const value = doctorReport(report);
    expect(value).toEqual({ generatedAt: report.generatedAt, jobs: [{ jobId: id, status: 'completed', operation: 'file.read' }], holders: [{ jobId: id, kind: 'writer', resource: 'folder:123456789abc' }] });
    expect(JSON.stringify(value)).not.toMatch(/private-internal|requestIdHash|unrelated|verified/u);
    expect(doctorReport({ ...report, jobs: [], holders: [] })).toEqual({ generatedAt: report.generatedAt, jobs: [], holders: [] });
  });
  it('refuses malformed reports and noncanonical job links instead of displaying a successful snapshot', () => {
    for (const value of [null, {}, { ...report, schemaVersion: 2 }, { ...report, generatedAt: 'invalid' },
      { ...report, jobs: [{ jobId: '../other-job', status: 'completed' }] }, { ...report, jobs: [{ jobId: id, status: 'invented' }] },
      { ...report, jobs: [{ jobId: id, status: 'blocked', blockerCode: {} }] }, { ...report, jobs: Array.from({ length: 201 }, () => report.jobs[0]) },
      { ...report, holders: [{ jobId: 'foreign', kind: 'writer', resource: 'folder:123' }] }, { ...report, holders: [{ jobId: id, kind: 'invented', resource: 'folder:123' }] },
    ]) expect(doctorReport(value)).toBeUndefined();
  });
});
