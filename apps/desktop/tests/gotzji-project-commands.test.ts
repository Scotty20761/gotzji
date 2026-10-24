import { describe, expect, it } from 'vitest';
import { projectCommandOptions } from '../src/renderer/gotzji-project-commands.js';

describe('normal project command choices', () => {
  it('offers only available reviewed recipes bound to this project', () => {
    expect(projectCommandOptions(['check'], [
      { name: 'command.recipe.check', recipeId: 'check', state: 'available', description: 'ตรวจโครงการ', controller: 'chatgpt-plugin' },
      { name: 'command.recipe.other', recipeId: 'other', state: 'available', description: 'Other' },
      { name: 'command.recipe.old', recipeId: 'old', state: 'unsupported' },
      { name: 'file.write', recipeId: 'check', state: 'available' },
    ])).toEqual([{ recipeId: 'check', title: 'ตรวจโครงการ', ownerOnly: false }]);
  });
  it('keeps the explicit owner-only delivery indication', () => {
    expect(projectCommandOptions(['ship'], [{ name: 'command.recipe.ship', recipeId: 'ship', state: 'available', description: 'ส่งผลงาน', controller: 'owner' }])).toEqual([{ recipeId: 'ship', title: 'ส่งผลงาน', ownerOnly: true }]);
  });
  it('does not offer missing, disabled or unbound entries', () => {
    expect(projectCommandOptions(['missing', 'off'], [{ name: 'command.recipe.off', recipeId: 'off', state: 'unsupported' }])).toEqual([]);
    expect(projectCommandOptions([], [{ name: 'command.recipe.check', recipeId: 'check', state: 'available' }])).toEqual([]);
  });
  it('uses the stable recipe ID as fallback and keeps paths/arguments out of choices', () => {
    expect(projectCommandOptions(['check'], [{ name: 'command.recipe.check', recipeId: 'check', state: 'available', executable: '/private/node', args: ['private'] }])).toEqual([{ recipeId: 'check', title: 'check', ownerOnly: false }]);
  });
});
