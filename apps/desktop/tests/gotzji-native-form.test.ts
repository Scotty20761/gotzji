import { describe, expect, it } from 'vitest';
import { buildNativeFormInput } from '../src/renderer/gotzji-native-form.js';
describe('typed native input from desktop forms', () => {
  it('preserves leading-zero IDs and literal formulas while interpreting pasted numbers and booleans', () => {
    expect(buildNativeFormInput('excel.range.write', { sheet: 'Sheet', range: 'A1:C2', values: '001\t12\t=1+2\nID\t2.5\ttrue', outputPath: 'result.xlsx' })).toEqual({ sheet: 'Sheet', range: 'A1:C2', values: [['001', 12, '=1+2'], ['ID', 2.5, true]], outputPath: 'result.xlsx' });
  });
  it('uses only named provider fields and rejects malformed object references', () => {
    expect(buildNativeFormInput('cad.entity.move', { handle: 'A1', x: '1', y: '2', z: '0', outputPath: 'result.dwg', scriptPath: 'caller-script' })).toEqual({ handle: 'A1', outputPath: 'result.dwg', displacement: [1, 2, 0] });
    expect(() => buildNativeFormInput('word.paragraph.read', { paragraph: '1.5' })).toThrow();
    expect(() => buildNativeFormInput('excel.range.write', { sheet: 'S', range: 'A1', values: 'one\ttwo\nthree', outputPath: 'result.xlsx' })).toThrow();
  });
});
