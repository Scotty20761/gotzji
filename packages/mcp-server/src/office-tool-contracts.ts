import { z } from 'zod';

export const OFFICE_SEMANTIC_TOOL_NAMES = [
  'office_status',
  'office_word',
  'office_excel',
  'office_powerpoint',
  'office_outlook',
  'office_calendar',
  'office_contacts',
  'office_tasks',
  'office_onenote',
  'office_onedrive',
  'office_sharepoint',
  'office_teams',
  'office_access',
  'office_visio',
  'office_project',
  'office_publisher',
  'office_convert',
  'office_batch',
] as const;

export type OfficeSemanticToolName = (typeof OFFICE_SEMANTIC_TOOL_NAMES)[number];

const workspaceId = z.string().min(1).max(128).optional();
const pathField = z.string().min(1).max(4096).optional();
const shortText = z.string().max(32_768).optional();
const longText = z.string().max(262_144).optional();
const identifier = z.string().min(1).max(2048).optional();
const positiveInt = z.number().int().positive().optional();
const nonNegativeInt = z.number().int().nonnegative().optional();
const booleanField = z.boolean().optional();
const stringArray = z.array(z.string().max(32_768)).max(512).optional();
const recordField = z.record(z.string(), z.unknown()).optional();
const commonMutation = {
  dryRun: booleanField,
  dry_run: booleanField,
};

export const OFFICE_WORD_ACTIONS = [
  'create', 'inspect_document', 'read_text', 'read_range', 'get_structure', 'get_sections',
  'get_paragraphs', 'get_runs', 'get_styles', 'get_headings', 'get_tables', 'get_images',
  'get_headers_footers', 'get_bookmarks', 'get_hyperlinks', 'get_fields', 'get_comments',
  'get_revisions', 'get_footnotes', 'get_endnotes', 'search', 'document_properties',
  'page_setup', 'protection_status', 'insert_text', 'append_text', 'prepend_text',
  'replace_text', 'replace_range', 'delete_range', 'set_font', 'set_character_format',
  'set_paragraph_format', 'set_alignment', 'set_spacing', 'apply_style',
  'create_or_update_style', 'add_heading', 'add_page_break', 'add_section_break',
  'insert_table', 'update_table_cells', 'add_row', 'delete_row', 'add_column',
  'delete_column', 'merge_cells', 'split_cells', 'set_table_style', 'insert_image',
  'replace_image', 'add_textbox', 'add_shape', 'add_hyperlink', 'edit_hyperlink',
  'add_bookmark', 'remove_bookmark', 'update_header_footer', 'page_numbering',
  'set_page_setup', 'add_footnote', 'add_endnote', 'update_toc', 'update_field',
  'add_comment', 'read_comments', 'resolve_comment', 'delete_comment', 'set_track_changes',
  'accept_revision', 'reject_revision', 'mail_merge_preview', 'mail_merge', 'merge',
  'save', 'save_as', 'export_pdf', 'export_text', 'print', 'protect', 'unprotect',
] as const;

export const OFFICE_EXCEL_ACTIONS = [
  'audit_data', 'compare_cells', 'create_report',
  'create', 'list_sheets', 'inspect_workbook', 'used_range', 'read_range', 'read_values',
  'read_formulas', 'read_number_formats', 'read_styles', 'read_tables', 'read_named_ranges',
  'read_charts', 'read_pivots', 'read_filters', 'read_data_validation',
  'read_conditional_formatting', 'workbook_properties', 'connection_metadata',
  'calculation_status', 'search', 'add_sheet', 'delete_sheet', 'rename_sheet', 'copy_sheet',
  'move_sheet', 'write_values', 'write_formulas', 'fill_range', 'copy_range',
  'clear_contents', 'clear_formats', 'insert_rows', 'delete_rows', 'insert_columns',
  'delete_columns', 'merge_cells', 'unmerge_cells', 'set_row_height', 'set_column_width',
  'autofit', 'set_number_format', 'set_font', 'set_fill', 'set_border', 'set_alignment',
  'create_table', 'resize_table', 'style_table', 'sort', 'filter', 'clear_filter',
  'freeze_panes', 'create_named_range', 'update_named_range', 'delete_named_range',
  'set_data_validation', 'delete_data_validation', 'set_conditional_formatting',
  'delete_conditional_formatting', 'add_comment', 'add_hyperlink', 'insert_image',
  'replace_image', 'create_chart', 'update_chart', 'delete_chart', 'create_pivot',
  'refresh_pivot', 'update_pivot', 'recalculate', 'refresh_connections', 'protect',
  'unprotect', 'save', 'save_as', 'export_csv', 'export_tsv', 'export_pdf', 'print',
  'list_macros', 'run_macro', 'formula_errors',
] as const;

export const OFFICE_POWERPOINT_ACTIONS = [
  'create', 'inspect_presentation', 'list_slides', 'get_slide', 'get_slide_text',
  'get_shapes', 'get_images', 'get_tables', 'get_charts', 'get_notes', 'get_layout',
  'presentation_properties', 'slide_size', 'get_hyperlinks', 'get_transitions',
  'add_slide', 'duplicate_slide', 'delete_slide', 'reorder_slide', 'change_layout',
  'edit_text', 'add_textbox', 'edit_textbox', 'remove_textbox', 'add_shape', 'edit_shape',
  'remove_shape', 'add_image', 'edit_image', 'remove_image', 'crop_image', 'add_table',
  'edit_table', 'add_chart', 'edit_chart', 'add_hyperlink', 'set_notes', 'set_background',
  'set_theme', 'set_master', 'set_slide_size', 'set_transition', 'save', 'save_as',
  'export_pdf', 'export_images', 'export_video', 'print',
] as const;

export const OFFICE_OUTLOOK_ACTIONS = [
  'list_folders', 'list_messages', 'get_message', 'get_headers', 'get_body',
  'list_attachments', 'save_attachment', 'search', 'conversation', 'get_state',
  'mailbox_status', 'create_draft', 'update_draft', 'add_recipients', 'remove_recipients',
  'attach_file', 'detach_file', 'reply_draft', 'reply_all_draft', 'forward_draft',
  'set_importance', 'set_category', 'set_flag', 'mark_read', 'mark_unread',
  'move_message', 'copy_message', 'send', 'delete', 'permanent_delete',
] as const;

export const OFFICE_CALENDAR_ACTIONS = [
  'list_calendars', 'get_events', 'search_events', 'get_event', 'availability',
  'create_event', 'update_event', 'move_event', 'add_attendees', 'remove_attendees',
  'set_reminder', 'set_recurrence', 'set_location', 'send_invite', 'send_update',
  'cancel_event', 'delete_event', 'respond',
] as const;

export const OFFICE_CONTACT_ACTIONS = [
  'list_contacts', 'search_contacts', 'get_contact', 'create_contact', 'update_contact',
  'set_categories', 'create_group', 'update_group', 'delete_contact',
] as const;

export const OFFICE_TASK_ACTIONS = [
  'list_task_folders', 'list_tasks', 'search_tasks', 'get_task', 'create_task',
  'update_task', 'complete_task', 'reopen_task', 'delete_task',
] as const;

export const OFFICE_ONENOTE_ACTIONS = [
  'list_notebooks', 'list_sections', 'list_pages', 'read_page', 'search',
  'create_page', 'append_page', 'update_page', 'add_resource', 'move_page',
  'copy_page', 'delete_page',
] as const;

export const OFFICE_ONEDRIVE_ACTIONS = [
  'list', 'search', 'metadata', 'download', 'upload', 'create_folder', 'copy', 'move',
  'rename', 'versions', 'sharing', 'update_sharing', 'delete', 'restore',
] as const;

export const OFFICE_SHAREPOINT_ACTIONS = [
  'list_sites', 'search_sites', 'list_drives', 'list_items', 'read_item', 'list_files',
  'download', 'upload', 'create_item', 'update_item', 'sharing', 'update_sharing',
] as const;

export const OFFICE_TEAMS_ACTIONS = [
  'list_teams', 'list_channels', 'list_messages', 'get_message', 'draft_message',
  'send_message',
] as const;

export const OFFICE_ACCESS_ACTIONS = [
  'status', 'inspect', 'list_objects', 'table_schema', 'query', 'create_table',
  'update_table', 'create_query', 'update_query', 'import', 'export', 'run_saved_query',
  'export_report', 'compact_repair', 'run_vba',
] as const;

export const OFFICE_VISIO_ACTIONS = [
  'status', 'list_pages', 'list_layers', 'list_masters', 'read_shapes', 'create_shape',
  'update_shape', 'delete_shape', 'connect_shapes', 'set_position', 'set_layer',
  'page_properties', 'export_pdf', 'export_svg', 'export_png', 'validate',
] as const;

export const OFFICE_PROJECT_ACTIONS = [
  'status', 'metadata', 'list_tasks', 'list_milestones', 'list_dependencies',
  'list_resources', 'list_assignments', 'list_calendars', 'create_task', 'update_task',
  'create_resource', 'update_resource', 'create_assignment', 'update_assignment',
  'set_baseline', 'save', 'export_pdf', 'export_excel',
] as const;

export const OFFICE_PUBLISHER_ACTIONS = [
  'status', 'inspect', 'list_pages', 'read_text', 'read_images', 'create_element',
  'update_element', 'save', 'save_as', 'export_pdf',
] as const;

const wordSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_WORD_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  merge_paths: z.array(z.string().min(1).max(4096)).max(32).optional(),
  text: longText,
  find: shortText,
  replace_with: longText,
  range: recordField,
  table: recordField,
  style: recordField,
  image_path: pathField,
  source_path: pathField,
  index: nonNegativeInt,
  parameters: recordField,
  ...commonMutation,
}).strict();

const excelSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_EXCEL_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  image_path: pathField,
  sheet: z.string().max(256).optional(),
  range: z.string().max(256).optional(),
  values: z.unknown().optional(),
  formulas: z.unknown().optional(),
  name: z.string().max(256).optional(),
  new_name: z.string().max(256).optional(),
  index: nonNegativeInt,
  count: positiveInt,
  parameters: recordField,
  password: z.string().max(4096).optional(),
  macro: z.string().max(512).optional(),
  ...commonMutation,
}).strict();

const powerpointSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_POWERPOINT_ACTIONS),
  file_path: pathField,
  target_path: pathField,
  slide: positiveInt,
  target_slide: positiveInt,
  shape: identifier,
  text: longText,
  image_path: pathField,
  theme_path: pathField,
  parameters: recordField,
  ...commonMutation,
}).strict();

const outlookSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_OUTLOOK_ACTIONS),
  folder: z.string().max(2048).optional(),
  target_folder: z.string().max(2048).optional(),
  max_messages: z.number().int().min(1).max(100).optional(),
  page: positiveInt,
  query: z.string().max(8192).optional(),
  message_id: identifier,
  draft_id: identifier,
  subject: z.string().max(4096).optional(),
  body: longText,
  body_html: z.string().max(524_288).optional(),
  to: stringArray,
  cc: stringArray,
  bcc: stringArray,
  recipients: stringArray,
  attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
  attachment_id: identifier,
  target_path: pathField,
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const calendarSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_CALENDAR_ACTIONS),
  calendar: identifier,
  target_calendar: identifier,
  event_id: identifier,
  query: z.string().max(8192).optional(),
  start: z.string().max(128).optional(),
  end: z.string().max(128).optional(),
  max_results: z.number().int().min(1).max(200).optional(),
  subject: z.string().max(4096).optional(),
  body: longText,
  attendees: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const contactsSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_CONTACT_ACTIONS),
  contact_id: identifier,
  group_id: identifier,
  members: stringArray,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  name: z.string().max(4096).optional(),
  email: z.string().max(4096).optional(),
  company: z.string().max(4096).optional(),
  title: z.string().max(4096).optional(),
  phones: recordField,
  addresses: recordField,
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const tasksSchema = z.object({
  workspaceId,
  action: z.enum(OFFICE_TASK_ACTIONS),
  task_id: identifier,
  folder: identifier,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  subject: z.string().max(4096).optional(),
  body: longText,
  due: z.string().max(128).optional(),
  reminder: z.string().max(128).optional(),
  importance: z.string().max(64).optional(),
  status: z.string().max(128).optional(),
  categories: stringArray,
  parameters: recordField,
  ...commonMutation,
}).strict();

const cloudBase = {
  workspaceId,
  item_id: identifier,
  parent_id: identifier,
  query: z.string().max(8192).optional(),
  max_results: z.number().int().min(1).max(500).optional(),
  file_path: pathField,
  target_path: pathField,
  name: z.string().max(4096).optional(),
  body: longText,
  parameters: recordField,
  ...commonMutation,
};

const oneNoteSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_ONENOTE_ACTIONS), notebook_id: identifier, section_id: identifier, page_id: identifier }).strict();
const oneDriveSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_ONEDRIVE_ACTIONS), drive_id: identifier }).strict();
const sharePointSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_SHAREPOINT_ACTIONS), site_id: identifier, drive_id: identifier, list_id: identifier }).strict();
const teamsSchema = z.object({ ...cloudBase, action: z.enum(OFFICE_TEAMS_ACTIONS), team_id: identifier, channel_id: identifier, message_id: identifier }).strict();

const optionalBase = {
  workspaceId,
  file_path: pathField,
  target_path: pathField,
  item_id: identifier,
  name: z.string().max(4096).optional(),
  query: z.string().max(65_536).optional(),
  parameters: recordField,
  ...commonMutation,
};

const accessSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_ACCESS_ACTIONS) }).strict();
const visioSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_VISIO_ACTIONS) }).strict();
const projectSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_PROJECT_ACTIONS) }).strict();
const publisherSchema = z.object({ ...optionalBase, action: z.enum(OFFICE_PUBLISHER_ACTIONS) }).strict();

const convertSchema = z.object({
  workspaceId,
  source_path: z.string().min(1).max(4096),
  target_path: z.string().min(1).max(4096),
  format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'txt', 'png', 'jpeg']).optional(),
  ...commonMutation,
}).strict();

const batchOperationSchema = z.object({
  tool: z.enum([
    'office_word', 'office_excel', 'office_powerpoint', 'office_outlook', 'office_calendar',
    'office_contacts', 'office_tasks', 'office_onenote', 'office_onedrive',
    'office_sharepoint', 'office_teams', 'office_access', 'office_visio',
    'office_project', 'office_publisher', 'office_convert',
  ]),
  input: z.record(z.string(), z.unknown()),
}).strict();

const batchSchema = z.object({
  workspaceId,
  operations: z.array(batchOperationSchema).min(1).max(32),
  fail_fast: z.boolean().optional(),
  dryRun: booleanField,
  dry_run: booleanField,
}).strict();

const statusSchema = z.object({
  workspaceId,
  include_optional: z.boolean().optional(),
}).strict();

const OFFICE_SCHEMAS: Record<OfficeSemanticToolName, z.ZodObject> = {
  office_status: statusSchema,
  office_word: wordSchema,
  office_excel: excelSchema,
  office_powerpoint: powerpointSchema,
  office_outlook: outlookSchema,
  office_calendar: calendarSchema,
  office_contacts: contactsSchema,
  office_tasks: tasksSchema,
  office_onenote: oneNoteSchema,
  office_onedrive: oneDriveSchema,
  office_sharepoint: sharePointSchema,
  office_teams: teamsSchema,
  office_access: accessSchema,
  office_visio: visioSchema,
  office_project: projectSchema,
  office_publisher: publisherSchema,
  office_convert: convertSchema,
  office_batch: batchSchema,
};

export function isOfficeSemanticToolName(value: string): value is OfficeSemanticToolName {
  return (OFFICE_SEMANTIC_TOOL_NAMES as readonly string[]).includes(value);
}

export function officeToolInputSchema(name: OfficeSemanticToolName): z.ZodObject {
  return OFFICE_SCHEMAS[name].superRefine((input, context) => {
    const message = validateOfficeNativeAction(name, input);
    if (message !== undefined) context.addIssue({ code: 'custom', message });
  });
}

const number = z.number().finite();
const index = z.number().int().min(1).max(1_000_000);
const color = z.number().int().min(0).max(16_777_215);
const bounds = { left: number.min(-100_000).max(100_000), top: number.min(-100_000).max(100_000), width: number.min(1).max(100_000), height: number.min(1).max(100_000) };
const font = z.object({ name: z.string().min(1).max(256).optional(), size: number.min(1).max(1638).optional(), bold: booleanField, italic: booleanField, underline: z.number().int().min(0).max(55).optional(), color: color.optional(), strike_through: booleanField, superscript: booleanField, subscript: booleanField }).strict();
const paragraph = z.object({ alignment: z.number().int().min(0).max(9).optional(), space_before: number.min(0).max(1584).optional(), space_after: number.min(0).max(1584).optional(), line_spacing: number.min(1).max(1584).optional(), left_indent: number.min(-1584).max(1584).optional(), right_indent: number.min(-1584).max(1584).optional(), first_line_indent: number.min(-1584).max(1584).optional(), keep_with_next: booleanField, keep_together: booleanField }).strict();
const empty = z.object({}).strict();
const address = z.string().min(1).max(4096).refine((value) => /^(?:https?:|mailto:|#)/i.test(value), 'Hyperlinks must be HTTP, HTTPS, mailto, or an internal anchor');
const shapeOptions = z.object({ left: bounds.left.optional(), top: bounds.top.optional(), width: bounds.width.optional(), height: bounds.height.optional(), rotation: number.min(-360).max(360).optional(), fill_color: color.optional(), line_color: color.optional() }).strict();

const EXTENDED_PARAMETERS: Readonly<Record<string, z.ZodType>> = {
  'office_word:get_runs': z.object({ max_characters: z.number().int().min(1).max(100_000).optional() }).strict(),
  'office_word:get_styles': empty, 'office_word:get_fields': empty, 'office_word:get_footnotes': empty, 'office_word:get_endnotes': empty,
  'office_word:page_setup': z.object({ section: index.optional() }).strict(),
  'office_word:replace_range': empty, 'office_word:delete_range': empty,
  'office_word:set_character_format': font,
  'office_word:set_paragraph_format': paragraph,
  'office_word:set_alignment': z.object({ alignment: z.number().int().min(0).max(9) }).strict(),
  'office_word:set_spacing': paragraph,
  'office_word:create_or_update_style': empty,
  'office_word:add_heading': z.object({ level: z.number().int().min(1).max(9) }).strict(),
  'office_word:add_page_break': empty,
  'office_word:add_section_break': z.object({ kind: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional() }).strict(),
  'office_word:merge_cells': z.object({ end_row: index, end_column: index }).strict(),
  'office_word:split_cells': z.object({ rows: index.max(100), columns: index.max(100) }).strict(),
  'office_word:set_table_style': z.object({ name: z.string().min(1).max(256) }).strict(),
  'office_word:replace_image': empty,
  'office_word:add_textbox': z.object(bounds).strict(),
  'office_word:add_shape': z.object({ ...bounds, type: z.number().int().min(1).max(200) }).strict(),
  'office_word:add_hyperlink': z.object({ address }).strict(),
  'office_word:edit_hyperlink': z.object({ address }).strict(),
  'office_word:add_bookmark': z.object({ name: z.string().regex(/^[\p{L}_][\p{L}\p{N}_]{0,39}$/u) }).strict(),
  'office_word:remove_bookmark': z.object({ name: z.string().min(1).max(40) }).strict(),
  'office_word:page_numbering': z.object({ section: index, alignment: z.number().int().min(0).max(4) }).strict(),
  'office_word:set_page_setup': z.object({ section: index.optional(), top_margin: number.min(0).max(1584).optional(), bottom_margin: number.min(0).max(1584).optional(), left_margin: number.min(0).max(1584).optional(), right_margin: number.min(0).max(1584).optional(), page_width: number.min(1).max(1584).optional(), page_height: number.min(1).max(1584).optional(), orientation: z.union([z.literal(0), z.literal(1)]).optional() }).strict(),
  'office_word:add_footnote': empty, 'office_word:add_endnote': empty, 'office_word:update_toc': empty, 'office_word:update_field': empty, 'office_word:resolve_comment': empty, 'office_word:delete_comment': empty,
  'office_word:mail_merge_preview': z.object({ record: index.max(100_000).optional() }).strict(),
  'office_word:mail_merge': z.object({ first_record: index.max(100_000).optional(), last_record: index.max(100_000).optional() }).strict().refine((value) => value.last_record === undefined || (value.last_record >= (value.first_record ?? 1) && value.last_record - (value.first_record ?? 1) < 1000), 'Mail merge accepts an ordered window of at most 1000 records'), 'office_word:print': empty,
  'office_excel:read_named_ranges': empty, 'office_excel:read_filters': empty, 'office_excel:read_data_validation': empty, 'office_excel:read_conditional_formatting': empty, 'office_excel:connection_metadata': empty,
  'office_excel:copy_sheet': z.object({ target_sheet: z.string().min(1).max(31) }).strict(),
  'office_excel:move_sheet': z.object({ target_sheet: z.string().min(1).max(31) }).strict(),
  'office_excel:set_border': z.object({ edges: z.array(z.number().int().min(5).max(12)).min(1).max(8).optional(), line_style: z.union([z.literal(-4142), z.literal(1), z.literal(-4115), z.literal(4), z.literal(5), z.literal(-4118), z.literal(-4119), z.literal(13)]), weight: z.union([z.literal(-4138), z.literal(1), z.literal(2), z.literal(4)]).optional(), color: color.optional() }).strict(),
  'office_excel:create_named_range': empty, 'office_excel:update_named_range': empty, 'office_excel:delete_named_range': empty,
  'office_excel:set_conditional_formatting': z.object({ type: z.union([z.literal(1), z.literal(2)]), operator: z.number().int().min(1).max(8).optional(), formula1: z.string().min(1).max(8192), formula2: z.string().max(8192).optional(), color: color.optional() }).strict().refine((value) => value.type !== 1 || value.operator !== undefined, 'Cell-value conditions require operator'),
  'office_excel:delete_conditional_formatting': empty,
  'office_excel:add_hyperlink': z.object({ address }).strict(),
  'office_excel:replace_image': empty, 'office_excel:refresh_connections': empty, 'office_excel:print': empty, 'office_excel:list_macros': empty, 'office_excel:run_macro': empty,
  'office_powerpoint:get_hyperlinks': empty, 'office_powerpoint:get_transitions': empty,
  'office_powerpoint:change_layout': z.object({ layout: index.max(36) }).strict(),
  'office_powerpoint:edit_textbox': shapeOptions, 'office_powerpoint:edit_shape': shapeOptions, 'office_powerpoint:edit_image': shapeOptions,
  'office_powerpoint:remove_textbox': empty, 'office_powerpoint:remove_shape': empty, 'office_powerpoint:remove_image': empty,
  'office_powerpoint:add_shape': z.object({ ...bounds, type: index.max(200) }).strict(),
  'office_powerpoint:crop_image': z.object({ left: number.min(0).max(100_000).optional(), top: number.min(0).max(100_000).optional(), right: number.min(0).max(100_000).optional(), bottom: number.min(0).max(100_000).optional() }).strict(),
  'office_powerpoint:add_hyperlink': z.object({ address }).strict(),
  'office_powerpoint:set_background': z.object({ color }).strict(),
  'office_powerpoint:set_theme': empty,
  'office_powerpoint:set_master': z.object({ design: index }).strict(),
  'office_powerpoint:set_slide_size': z.object({ width: number.min(1).max(4032), height: number.min(1).max(4032) }).strict(),
  'office_powerpoint:set_transition': z.object({ effect: z.number().int().min(0).max(4000).optional(), duration: number.min(0).max(60).optional(), advance_time: number.min(0).max(86400).optional(), advance_on_click: booleanField }).strict(),
  'office_powerpoint:export_images': empty, 'office_powerpoint:export_video': empty, 'office_powerpoint:print': empty,
  'office_outlook:reply_draft': empty, 'office_outlook:reply_all_draft': empty, 'office_outlook:forward_draft': empty, 'office_outlook:permanent_delete': empty,
  'office_calendar:availability': z.object({ minutes_per_slot: index.max(1440).optional() }).strict(),
  'office_calendar:move_event': empty, 'office_calendar:add_attendees': empty, 'office_calendar:remove_attendees': empty,
  'office_calendar:set_reminder': z.object({ enabled: z.boolean(), minutes_before_start: z.number().int().min(0).max(525_600).optional() }).strict().refine((value) => !value.enabled || value.minutes_before_start !== undefined, 'Enabled reminder requires minutes_before_start'),
  'office_calendar:set_recurrence': z.object({ type: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6)]), interval: index.max(99), day_of_week_mask: index.max(127).optional(), day_of_month: index.max(31).optional(), month_of_year: index.max(12).optional(), instance: index.max(5).optional(), occurrences: index.max(10_000).optional() }).strict(),
  'office_calendar:set_location': z.object({ location: z.string().min(1).max(4096) }).strict(),
  'office_calendar:send_update': empty, 'office_calendar:cancel_event': empty,
  'office_calendar:respond': z.object({ response: z.enum(['accept', 'tentative', 'decline']) }).strict(),
  'office_contacts:set_categories': empty, 'office_contacts:create_group': empty,
  'office_contacts:update_group': z.object({ remove_members: z.array(z.string().min(1).max(4096)).max(512).optional() }).strict(),
};

export function windowsOfficeExtendedActions(tool: OfficeSemanticToolName): readonly string[] {
  const prefix = `${tool}:`;
  return Object.keys(EXTENDED_PARAMETERS).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

export function validateOfficeNativeAction(tool: OfficeSemanticToolName, input: Readonly<Record<string, unknown>>): string | undefined {
  const action = typeof input.action === 'string' ? input.action : '';
  const specification = EXTENDED_PARAMETERS[`${tool}:${action}`];
  if (specification === undefined) return undefined;
  const parameters = specification.safeParse(input.parameters ?? {});
  if (!parameters.success) return `${tool} ${action} parameters are invalid: ${parameters.error.issues.map((issue) => issue.message).join('; ')}`;
  const requireFields = (fields: readonly string[]): string | undefined => fields.find((field) => typeof input[field] !== 'string' || String(input[field]).trim().length === 0);
  if (['office_word', 'office_excel', 'office_powerpoint'].includes(tool) && requireFields(['file_path']) !== undefined) return 'file_path is required';
  if (tool === 'office_word') {
    if (['replace_range', 'delete_range'].includes(action) && input.range === undefined) return 'An explicit range is required';
    if (input.range !== undefined && !z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().refine((range) => range.end >= range.start).safeParse(input.range).success) return 'range requires ordered nonnegative start and end';
    if (action === 'replace_range' && typeof input.replace_with !== 'string') return 'replace_with is required';
    if (['replace_image', 'edit_hyperlink', 'update_toc', 'update_field', 'resolve_comment', 'delete_comment'].includes(action) && !index.safeParse(input.index).success) return 'A positive index is required';
    if (['merge_cells', 'split_cells', 'set_table_style'].includes(action) && !z.object({ index, row: index.optional(), column: index.optional() }).strict().safeParse(input.table).success) return 'A table selector is required';
    if (['merge_cells', 'split_cells'].includes(action) && (!isObject(input.table) || input.table.row === undefined || input.table.column === undefined)) return 'Table row and column are required';
    if (action === 'create_or_update_style' && !z.object({ name: z.string().min(1).max(256), type: index.max(3).optional(), font: font.optional(), paragraph: paragraph.optional() }).strict().safeParse(input.style).success) return 'style requires a name and valid formatting';
    if (action === 'replace_image' && requireFields(['image_path'])) return 'image_path is required';
    if (['mail_merge', 'mail_merge_preview'].includes(action) && requireFields(['source_path'])) return 'source_path is required';
    if (['mail_merge', 'mail_merge_preview'].includes(action) && !/\.csv$/i.test(String(input.source_path))) return 'Mail merge source must be a local CSV file';
    if (action === 'mail_merge' && requireFields(['target_path'])) return 'target_path is required';
  }
  if (tool === 'office_excel') {
    if (['read_data_validation', 'read_conditional_formatting', 'set_border', 'create_named_range', 'update_named_range', 'set_conditional_formatting', 'delete_conditional_formatting', 'add_hyperlink'].includes(action) && requireFields(['range'])) return 'range is required';
    if (['create_named_range', 'update_named_range', 'delete_named_range', 'replace_image'].includes(action) && requireFields(['name'])) return 'name is required';
    if (action === 'replace_image' && requireFields(['image_path'])) return 'image_path is required';
    if (action === 'delete_conditional_formatting' && !index.safeParse(input.index).success) return 'A positive index is required';
    if (action === 'run_macro' && !z.string().max(512).regex(/^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)?$/u).safeParse(input.macro).success) return 'macro must name a workbook-local VBA procedure';
    if (action === 'run_macro' && !/\.(xlsm|xltm|xlam)$/i.test(String(input.file_path))) return 'Explicit VBA macro execution requires an inspectable macro-enabled OOXML workbook';
  }
  if (tool === 'office_powerpoint') {
    if (!['set_theme', 'set_slide_size', 'export_video', 'print'].includes(action) && !index.safeParse(input.slide).success) return 'A positive slide is required';
    if (['edit_textbox', 'edit_shape', 'edit_image', 'remove_textbox', 'remove_shape', 'remove_image', 'crop_image', 'add_hyperlink'].includes(action) && requireFields(['shape'])) return 'shape is required';
    if (action === 'set_theme' && requireFields(['theme_path'])) return 'theme_path is required';
    if (['export_images', 'export_video'].includes(action) && requireFields(['target_path'])) return 'target_path is required';
    if (action === 'export_images' && !/\.(png|jpe?g)$/i.test(String(input.target_path))) return 'export_images target_path must be PNG or JPEG';
    if (action === 'export_video' && !/\.mp4$/i.test(String(input.target_path))) return 'export_video target_path must be MP4';
  }
  if (tool === 'office_outlook' && requireFields(['message_id'])) return 'message_id is required';
  if (tool === 'office_calendar') {
    if (action !== 'availability' && requireFields(['event_id'])) return 'event_id is required';
    if (action === 'move_event' && requireFields(['target_calendar'])) return 'target_calendar is required';
    if (['availability', 'add_attendees', 'remove_attendees'].includes(action) && !z.array(z.string().min(1).max(4096)).min(1).max(50).safeParse(input.attendees).success) return '1-50 attendees are required';
    if (action === 'availability') { const start = Date.parse(String(input.start)); const end = Date.parse(String(input.end)); if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) return 'availability requires an increasing interval of at most 31 days'; }
  }
  if (tool === 'office_contacts') {
    if (action === 'set_categories' && requireFields(['contact_id'])) return 'contact_id is required';
    if (action === 'update_group' && requireFields(['group_id'])) return 'group_id is required';
    if (action === 'create_group' && requireFields(['name'])) return 'name is required';
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export const OFFICE_READ_ACTIONS = new Set<string>([
  'audit_data', 'compare_cells',
  'status', 'inspect_document', 'read_text', 'read_range', 'get_structure', 'get_sections',
  'get_paragraphs', 'get_runs', 'get_styles', 'get_headings', 'get_tables', 'get_images',
  'get_headers_footers', 'get_bookmarks', 'get_hyperlinks', 'get_fields', 'get_comments',
  'get_revisions', 'get_footnotes', 'get_endnotes', 'search', 'document_properties',
  'page_setup', 'protection_status', 'list_sheets', 'inspect_workbook', 'used_range',
  'read_values', 'read_formulas', 'read_number_formats', 'read_styles', 'read_tables',
  'read_named_ranges', 'read_charts', 'read_pivots', 'read_filters',
  'read_data_validation', 'read_conditional_formatting', 'workbook_properties',
  'connection_metadata', 'calculation_status', 'formula_errors', 'list_macros',
  'inspect_presentation', 'list_slides', 'get_slide', 'get_slide_text', 'get_shapes',
  'get_notes', 'get_layout', 'presentation_properties', 'slide_size', 'get_transitions',
  'list_folders', 'list_messages', 'get_message', 'get_headers', 'get_body',
  'list_attachments', 'conversation', 'get_state', 'mailbox_status', 'list_calendars',
  'get_events', 'search_events', 'get_event', 'availability', 'list_contacts',
  'search_contacts', 'get_contact', 'list_task_folders', 'list_tasks', 'search_tasks',
  'get_task', 'list_notebooks', 'list_sections', 'list_pages', 'read_page', 'list',
  'metadata', 'versions', 'sharing', 'list_sites', 'search_sites', 'list_drives',
  'list_items', 'read_item', 'list_files', 'list_teams', 'list_channels',
  'list_objects', 'table_schema', 'query', 'list_layers', 'list_masters',
  'read_shapes', 'validate', 'list_milestones', 'list_dependencies', 'list_resources',
  'list_assignments', 'inspect',
]);

export const OFFICE_DESTRUCTIVE_ACTIONS = new Set<string>([
  'delete', 'permanent_delete', 'delete_event', 'cancel_event', 'delete_contact',
  'delete_task', 'delete_page', 'delete_shape', 'delete_sheet', 'delete_row',
  'delete_column', 'delete_rows', 'delete_columns', 'remove_textbox', 'remove_shape',
  'remove_image', 'delete_chart', 'delete_named_range', 'delete_data_validation',
  'delete_conditional_formatting', 'delete_comment',
]);

export const OFFICE_DANGEROUS_ACTIONS = new Set<string>([
  'send', 'send_invite', 'send_update', 'respond', 'print', 'run_macro', 'run_vba',
  'refresh_connections', 'mail_merge', 'export_video', 'compact_repair', 'set_baseline',
]);
