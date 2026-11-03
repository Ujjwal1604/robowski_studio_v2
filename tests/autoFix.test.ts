import { describe, it, expect } from 'vitest';
import { suggestFixes, explainNoFix } from '../src/engine/autoFix';

describe('Auto-Fix Solver & Diagnostics', () => {
  it('returns empty fixes when there are no blocking issues', () => {
    const data = {
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 20, step: 1, max: 20 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20 },
      ],
    };
    const fixes = suggestFixes(data);
    expect(fixes).toEqual([]);
  });

  it('suggests raising stock concentration when transfer volumes exceed vial capacity', () => {
    // 500 µL vial, but reagents add up to 300 + 300 = 600 µL -> negative solvent
    const data = {
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 60, step: 1, max: 60 },
        { code: 'R2', stock: 100, min: 60, step: 1, max: 60 },
      ],
    };
    const fixes = suggestFixes(data);
    expect(fixes.length).toBeGreaterThan(0);
    const stockFix = fixes.find((f) => f.kind === 'stock');
    expect(stockFix).toBeDefined();
    expect(stockFix!.patch.stocks).toBeDefined();
  });

  it('explains the reason when no single fix is possible', () => {
    const data = {
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 60, step: 1, max: 60 },
        { code: 'R2', stock: 100, min: 60, step: 1, max: 60 },
      ],
    };
    const reasons = explainNoFix(data);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((r) => r.includes('undiluted stocks') || r.includes('Vial'))).toBe(true);
  });
});
