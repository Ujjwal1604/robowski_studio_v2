import { describe, it, expect } from 'vitest';
import { computeDilutionTier } from '../src/engine/dilutionTier';

describe('computeDilutionTier', () => {
  const baseReagent = {
    code: 'AA',
    name: 'Compound A',
    molarMass: 100,
    density: '',
    stock: 200, // 200 mM
    solvent: 'ethanol',
  };

  it('identifies direct transfer when min volume >= threshold', () => {
    // 50 mM in 500 uL vial from 200 mM stock = (50*500)/200 = 125 uL (threshold 50 uL)
    const tier = computeDilutionTier(
      baseReagent,
      { on: true, min: 50, step: 10, max: 80 },
      500,
      50,
      5,
      'concentration'
    );
    expect(tier?.tier).toBe('direct');
    expect(tier?.label).toBe('Direct 1×');
  });

  it('identifies single hand dilution (5x) when min volume < threshold but min*5 >= threshold', () => {
    // 5 mM in 500 uL vial from 200 mM stock = (5*500)/200 = 12.5 uL (< 50 uL)
    // with 5x dilution, 12.5 * 5 = 62.5 uL (>= 50 uL)
    const tier = computeDilutionTier(
      baseReagent,
      { on: true, min: 5, step: 2, max: 9 },
      500,
      50,
      5,
      'concentration'
    );
    expect(tier?.tier).toBe('dil1');
    expect(tier?.label).toBe('Dilution 5×');
  });

  it('identifies mixed transfer when max is direct but min requires dilution', () => {
    // 10 mM = 25 uL (needs dilution), 30 mM = 75 uL (direct >= 50 uL)
    const tier = computeDilutionTier(
      baseReagent,
      { on: true, min: 10, step: 10, max: 30 },
      500,
      50,
      5,
      'concentration'
    );
    expect(tier?.tier).toBe('mixed');
  });

  it('identifies 2-step dilution (25x)', () => {
    // 1 mM in 500 uL from 200 mM = 2.5 uL.
    // 2.5 * 5 = 12.5 uL (< 50).
    // 2.5 * 25 = 62.5 uL (>= 50).
    const tier = computeDilutionTier(
      baseReagent,
      { on: true, min: 1, step: 0.5, max: 2 },
      500,
      50,
      5,
      'concentration'
    );
    expect(tier?.tier).toBe('dil2');
    expect(tier?.label).toBe('Dilution 25× (N²)');
  });

  it('identifies sub-threshold when below 2 dilutions', () => {
    // 0.05 mM = 0.125 uL. 0.125 * 25 = 3.125 uL (< 50).
    const tier = computeDilutionTier(
      baseReagent,
      { on: true, min: 0.05, step: 0.01, max: 0.09 },
      500,
      50,
      5,
      'concentration'
    );
    expect(tier?.tier).toBe('sub');
  });
});
