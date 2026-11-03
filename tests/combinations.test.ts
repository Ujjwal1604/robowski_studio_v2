import { describe, it, expect } from 'vitest';
import { axisValues, targetCombinations } from '../src/engine/combinations';

describe('Combinations & Grid Sweeps', () => {
  it('generates exact integer axis values', () => {
    const vals = axisValues(1, 1, 5, 'R1');
    expect(vals).toEqual([1, 2, 3, 4, 5]);
  });

  it('generates floating point axis values with precision', () => {
    const vals = axisValues(0.1, 0.1, 0.4, 'Catalyst');
    expect(vals).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('handles single point range (min === max)', () => {
    const vals = axisValues(2.5, 1, 2.5, 'Reagent');
    expect(vals).toEqual([2.5]);
  });

  it('throws error when step is zero or negative', () => {
    expect(() => axisValues(1, 0, 5, 'R1')).toThrow('step must be greater than zero');
    expect(() => axisValues(1, -1, 5, 'R1')).toThrow('step must be greater than zero');
  });

  it('throws error when max is less than min', () => {
    expect(() => axisValues(5, 1, 2, 'R1')).toThrow('maximum must be greater than or equal to minimum');
  });

  it('throws error when step does not land exactly on max', () => {
    expect(() => axisValues(0, 3, 10, 'R1')).toThrow('is not reached by minimum 0 and step 3');
  });

  it('generates full Cartesian product in concentration mode', () => {
    const result = targetCombinations({
      mode: 'concentration',
      randomize: false,
      reagents: [
        { code: 'A', min: 10, step: 10, max: 20 },
        { code: 'B', min: 5, step: 5, max: 10 },
      ],
    });

    expect(result.indexed.length).toBe(4);
    expect(result.indexed[0].values).toEqual([10, 5]);
    expect(result.indexed[1].values).toEqual([10, 10]);
    expect(result.indexed[2].values).toEqual([20, 5]);
    expect(result.indexed[3].values).toEqual([20, 10]);
  });

  it('produces deterministic seeded shuffle order', () => {
    const runA = targetCombinations({
      mode: 'concentration',
      randomize: true,
      randomSeed: 42,
      reagents: [
        { code: 'A', min: 1, step: 1, max: 3 },
        { code: 'B', min: 1, step: 1, max: 3 },
      ],
    });

    const runB = targetCombinations({
      mode: 'concentration',
      randomize: true,
      randomSeed: 42,
      reagents: [
        { code: 'A', min: 1, step: 1, max: 3 },
        { code: 'B', min: 1, step: 1, max: 3 },
      ],
    });

    expect(runA.indexed.map((x) => x.globalIndex)).toEqual(runB.indexed.map((x) => x.globalIndex));
  });
});
