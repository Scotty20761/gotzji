/** Owner form for a reviewed command: one argument or dependency per line, timeout in minutes, and the folder it may write. */
export interface RecipeForm { readonly recipeId: string; readonly displayName: string; readonly executable: string; readonly args: string; readonly dependencies: string; readonly timeoutMinutes: string; readonly projectOnly: boolean }

export const EMPTY_RECIPE_FORM: RecipeForm = { recipeId: '', displayName: '', executable: '', args: '', dependencies: '', timeoutMinutes: '', projectOnly: false };

/** The request the owner approves: each non-empty argument line is sent exactly as typed; other fields are trimmed. */
export function recipeRequest(form: RecipeForm): Readonly<Record<string, unknown>> {
  const lines = (value: string): string[] => value.split(/\r?\n/u).filter((line) => line.length > 0);
  const minutes = Number(form.timeoutMinutes);
  return {
    recipeId: form.recipeId.trim(), executable: form.executable.trim(), args: lines(form.args), dependencies: lines(form.dependencies).map((line) => line.trim()).filter(Boolean),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
    ...(form.timeoutMinutes.trim() && Number.isFinite(minutes) ? { timeoutMs: Math.round(minutes * 60_000) } : {}),
    ...(form.projectOnly ? { writeScope: 'project' } : {}),
  };
}

/** What the host recorded, in the owner's words: the program, its hash, each argument as stored, and when each file is pinned. */
export function recipeReviewLines(value: unknown): readonly string[] {
  const review = value !== null && typeof value === 'object' && 'review' in value ? (value as { review: unknown }).review : undefined;
  if (review === null || typeof review !== 'object') return [];
  const entry = review as { executable?: unknown; executableSha256?: unknown; args?: unknown; dependencies?: unknown; writeScope?: unknown };
  const dependencies = Array.isArray(entry.dependencies) ? entry.dependencies as { path?: unknown; pinned?: unknown; sha256?: unknown }[] : [];
  return [
    `โปรแกรม ${String(entry.executable)}`, `SHA-256 ${String(entry.executableSha256)}`,
    ...(Array.isArray(entry.args) ? entry.args.map((arg, index) => `อาร์กิวเมนต์ ${index + 1}: ${JSON.stringify(String(arg))}`) : []),
    entry.writeScope === 'project' ? 'เขียนได้เฉพาะในโฟลเดอร์ของโปรเจกต์ (งานในโฟลเดอร์อื่นของเวิร์กสเปซเดียวกันทำพร้อมกันได้)' : 'เขียนได้ทั้งเวิร์กสเปซ (งานอื่นในเวิร์กสเปซเดียวกันต้องรอ)',
    ...dependencies.map((item) => item.pinned === 'at-approval' ? `ตรึงตอนอนุมัติ ${String(item.path)} · ${String(item.sha256)}` : `ตรึงทุกครั้งที่เริ่มงาน (Grace แก้ไฟล์นี้ได้) ${String(item.path)}`),
  ];
}
