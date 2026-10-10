import { describe, expect, it } from 'vitest';
import { EMPTY_RECIPE_FORM, recipeRequest, recipeReviewLines } from '../src/renderer/gotzji-recipe-form.js';

describe('owner recipe form', () => {
  it('sends each argument line exactly as typed, with minutes as milliseconds', () => {
    expect(recipeRequest({ recipeId: ' phase-tests ', displayName: 'Phase 2 checks', executable: 'C:\\Python312\\python.exe', args: '-I\r\n${projectRoot}/validation/test_phase2.py\n\n --label=two words', dependencies: ' ${projectRoot}/validation/test_phase2.py \n', timeoutMinutes: '10', projectOnly: true, delivery: true }))
      .toEqual({ recipeId: 'phase-tests', displayName: 'Phase 2 checks', executable: 'C:\\Python312\\python.exe', args: ['-I', '${projectRoot}/validation/test_phase2.py', ' --label=two words'], dependencies: ['${projectRoot}/validation/test_phase2.py'], timeoutMs: 600000, writeScope: 'project', delivery: true });
    expect(recipeRequest({ ...EMPTY_RECIPE_FORM, recipeId: 'x', executable: 'C:\\tool.exe' })).toEqual({ recipeId: 'x', executable: 'C:\\tool.exe', args: [], dependencies: [] });
  });

  it('shows the approved program, its hash, each stored argument and when each file is pinned', () => {
    expect(recipeReviewLines({ name: 'command.recipe.x', review: { executable: 'C:\\tool.exe', executableSha256: 'a'.repeat(64), args: ['-I', 'two words'], writeScope: 'project', delivery: true, dependencies: [{ path: 'C:\\pinned.py', pinned: 'at-approval', sha256: 'b'.repeat(64) }, { path: '${projectRoot}/x.py', pinned: 'each-run' }] } }))
      .toEqual(['โปรแกรม C:\\tool.exe', `SHA-256 ${'a'.repeat(64)}`, 'อาร์กิวเมนต์ 1: "-I"', 'อาร์กิวเมนต์ 2: "two words"', 'คำสั่งส่งมอบ: Grace สั่งรันเองไม่ได้ เจ้าของกดรันจากแอปนี้เท่านั้น', 'เขียนได้เฉพาะในโฟลเดอร์ของโปรเจกต์ (งานในโฟลเดอร์อื่นของเวิร์กสเปซเดียวกันทำพร้อมกันได้)', `ตรึงตอนอนุมัติ C:\\pinned.py · ${'b'.repeat(64)}`, 'ตรึงทุกครั้งที่เริ่มงาน (Grace แก้ไฟล์นี้ได้) ${projectRoot}/x.py']);
    expect(recipeReviewLines({ review: { executable: 'C:\\tool.exe', executableSha256: 'a', args: [], writeScope: 'workspace', dependencies: [] } })).toContain('เขียนได้ทั้งเวิร์กสเปซ (งานอื่นในเวิร์กสเปซเดียวกันต้องรอ)');
    expect(recipeReviewLines({ accepted: true })).toEqual([]);
    expect(recipeReviewLines(null)).toEqual([]);
  });
});
