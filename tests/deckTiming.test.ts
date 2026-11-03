import { describe, it, expect } from 'vitest';
import { assignDeckPositions, tipSize, calculateTipCounts, estimateRuntime } from '../src/engine/deckTiming';
import { defaultPlates } from '../src/engine/constants';

describe('Deck Geometry & Timing Models', () => {
  it('configures distinct default deck configurations for left and right hoods', () => {
    const left = defaultPlates('left');
    expect(left.solventKind).toBe('jar');
    expect(left.solventPlate).toBe(4);
    expect(left.stockPlates).toEqual([3, 5, 6]);

    const right = defaultPlates('right');
    expect(right.solventKind).toBe('bottle');
    expect(right.solventPlate).toBe(3);
    expect(right.stockPlates).toEqual([4, 5]);
  });

  it('assigns deck positions correctly within capacity', () => {
    const stocks = {
      R1: { dilution_level: 0 },
      R2: { dilution_level: 0 },
      R3_N: { dilution_level: 1 },
    };
    const layout = assignDeckPositions('left', stocks);
    expect(layout.positions_fit).toBe(true);
    expect((stocks.R1 as any).breadboard_plate_id).toBe(3);
    expect((stocks.R1 as any).container_id).toBe(0);
    expect((stocks.R2 as any).container_id).toBe(1);
    expect((stocks.R3_N as any).container_id).toBe(2);
  });

  it('classifies transfer volumes into correct tip sizes', () => {
    expect(tipSize(0.2)).toBeNull(); // below 0.5 µL
    expect(tipSize(0.5)).toBe(50);
    expect(tipSize(50)).toBe(50);
    expect(tipSize(50.1)).toBe(300);
    expect(tipSize(300)).toBe(300);
    expect(tipSize(300.1)).toBe(1000);
    expect(tipSize(1500)).toBe(1000);
    expect(tipSize(2500)).toBeNull(); // exceeds tip capacity
  });

  it('computes tip counts and tip racks requirement', () => {
    const rows: any[] = [
      { 'vol#R1': 20, 'vol#solvent': 480 },
      { 'vol#R1': 150, 'vol#solvent': 350 },
    ];
    const stocks = { R1: {} };
    const counts = calculateTipCounts(rows, stocks, false, false);
    expect(counts[50]).toBeGreaterThanOrEqual(1);
    expect(counts[300]).toBeGreaterThanOrEqual(1);
    expect(counts[1000]).toBeGreaterThanOrEqual(1);
  });

  it('estimates runtime with low, expected, and high ranges', () => {
    const rows: any[] = Array.from({ length: 54 }, (_, i) => ({
      local_index: i,
      global_index: i,
      'vol#R1': 100,
      'vol#solvent': 400,
    }));
    const tipCounts = calculateTipCounts(rows, { R1: {} }, true, false);
    const est = estimateRuntime(rows, tipCounts, true, false);
    expect(est.seconds).toBeGreaterThan(0);
    expect(est.lowSeconds).toBeLessThanOrEqual(est.seconds);
    expect(est.highSeconds).toBeGreaterThanOrEqual(est.seconds);
    expect(est.plates).toBe(1);
  });
});
