import { describe, it, expect } from 'vitest';
import { buildLcmsTargets, lcmsTargetsToCsv } from '../src/engine/predictor/lcmsTargets';

const sp = (key: string, formula: string, mh: number, loss: number[] = []): any => ({
  key,
  smiles: key,
  formula,
  mhPlus: mh,
  mNaPlus: mh + 21.98,
  mHMinus: mh - 2.015,
  score: 0.5,
  likelihood: 0.6,
  persistence: 0.8,
  lossIons: loss.map((mz) => ({ label: '[M+H-H2O]+', mz, note: '' })),
});

describe('lcmsTargets', () => {
  it('lists parent, adducts and in-source ions', () => {
    const t = buildLcmsTargets([sp('a', 'C1', 200.1, [182.09])]);
    expect(t.map((x) => x.ion)).toEqual(
      expect.arrayContaining(['[M+H]+', '[M+Na]+', '[M-H]-', '[M+H-H2O]+'])
    );
  });

  it('flags a mass explainable by two species', () => {
    const t = buildLcmsTargets([sp('a', 'C1', 200.1), sp('b', 'C2', 218.11, [200.101])]);
    const hit = t.find((x) => x.speciesKey === 'a' && x.ion === '[M+H]+')!;
    expect(hit.sharedWith.length).toBe(1);
  });

  it('writes CSV', () => {
    expect(lcmsTargetsToCsv(buildLcmsTargets([sp('a', 'C1', 200.1)])).split('\n').length).toBe(4);
  });
});
