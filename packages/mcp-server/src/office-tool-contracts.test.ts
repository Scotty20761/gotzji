import { describe, expect, it } from 'vitest';
import { officeToolInputSchema, validateOfficeNativeAction } from './office-tool-contracts.js';
import { inspectMutationOperation } from './mutation-policy.js';

describe('Office native action boundaries', () => {
  it.each(['read_styles', 'read_tables', 'read_charts', 'read_pivots', 'read_named_ranges', 'read_filters', 'read_data_validation', 'read_conditional_formatting', 'connection_metadata', 'get_images', 'get_headers_footers', 'get_runs', 'get_styles', 'get_fields', 'get_footnotes', 'get_endnotes'])('classifies %s as read at the semantic and raw Office gateways', (action) => {
    expect(inspectMutationOperation('office', { action }, 'WRITE').kind).toBe('read');
    expect(inspectMutationOperation('office_word', { action }, 'WRITE').kind).toBe('read');
  });
  it.each([
    ['office_word', { action: 'delete_range', file_path: 'a.docx' }],
    ['office_word', { action: 'replace_range', file_path: 'a.docx', range: { start: 8, end: 2 }, replace_with: '' }],
    ['office_word', { action: 'set_character_format', file_path: 'a.docx', parameters: { size: -5 } }],
    ['office_excel', { action: 'run_macro', file_path: 'a.xlsm', macro: "'foreign.xlsm'!Module1.Run" }],
    ['office_excel', { action: 'run_macro', file_path: 'a.xlsx', macro: 'Module1.Run' }],
    ['office_excel', { action: 'run_macro', file_path: 'a.xls', macro: 'Module1.Run' }],
    ['office_excel', { action: 'set_border', file_path: 'a.xlsx', range: 'A1', parameters: { line_style: 999 } }],
    ['office_powerpoint', { action: 'export_images', file_path: 'a.pptx', slide: 1, target_path: 'a.png/extra' }],
    ['office_powerpoint', { action: 'set_theme', file_path: 'a.pptx', parameters: { theme_path: 'foreign.thmx' } }],
    ['office_calendar', { action: 'availability', start: '2026-10-12', end: '2026-10-11', attendees: ['a@example.test'] }],
    ['office_calendar', { action: 'set_reminder', event_id: 'event', parameters: { enabled: true } }],
    ['office_contacts', { action: 'update_group', name: 'group' }],
  ] as const)('rejects invalid %s action input before dispatch', (tool, input) => {
    expect(officeToolInputSchema(tool).safeParse(input).success).toBe(false);
    expect(validateOfficeNativeAction(tool, input)).toBeTypeOf('string');
  });

  it.each([
    ['office_word', { action: 'replace_range', file_path: 'ไทย.docx', range: { start: 0, end: 4 }, replace_with: 'ไทย 😀' }],
    ['office_excel', { action: 'replace_image', file_path: 'a.xlsx', name: 'image', image_path: 'ไทย.png' }],
    ['office_powerpoint', { action: 'set_theme', file_path: 'a.pptx', theme_path: 'ไทย.thmx' }],
    ['office_calendar', { action: 'move_event', event_id: 'event', target_calendar: 'calendar' }],
    ['office_contacts', { action: 'create_group', name: 'ไทย', members: ['a@example.test'] }],
  ] as const)('accepts scoped %s identities without changing Unicode data', (tool, input) => {
    expect(officeToolInputSchema(tool).parse(input)).toEqual(input);
  });
});
