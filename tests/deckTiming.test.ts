import { describe, it, expect } from 'vitest';
import {
  assignDeckPositions,
  tipSize,
  calculateTipCounts,
  estimateRuntime,
  surfaceHeight,
  surfaceHeightExact,
  prewetVolumeUl,
  computePreFlightChecks,
} from '../src/engine/deckTiming';
import { defaultPlates, robotProfileForHood } from '../src/engine/constants';
import { calculateDiluterPlan } from '../src/engine/robotDiluter';
import { buildRun } from '../src/engine/dilution';

describe('Deck Geometry & Timing Models', () => {
  it('configures breadboard.py-accurate default deck layouts for Robowski#2 (left) and Roboski#1 (right)', () => {
    const left = defaultPlates('left');
    expect(left.solventKind).toBe('jar');
    expect(left.solventPlate).toBe(6);
    expect(left.stockPlates).toEqual([3, 4, 5]);

    const right = defaultPlates('right');
    expect(right.solventKind).toBe('bottle');
    expect(right.solventPlate).toBe(3);
    expect(right.stockPlates).toEqual([3, 4, 5]);

    expect(robotProfileForHood('left').pipetterName).toBe('Robowski#2');
    expect(robotProfileForHood('right').pipetterName).toBe('Roboski#1');
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

  it('matches breadboard.py surface height geometry for bottle_20ml and jar_100ml', () => {
    // bottle_20ml: bottom 2180, area 475.0506 mm^2 -> 10 mL = 10000 uL => 210.504 steps => 1969.496 => 1969
    expect(surfaceHeight('bottle', 10000)).toBe(1969);
    expect(surfaceHeightExact('bottle', 10000)).toBeCloseTo(2180 - (10000 / 475.0506) * 10, 1);

    // jar_100ml: bottom 2120, area 2122 mm^2 -> 50 mL = 50000 uL => 235.63 steps => 1884
    expect(surfaceHeight('jar', 50000)).toBe(1884);
    expect(prewetVolumeUl('bottle', 1000)).toBeLessThanOrEqual(1000);
    expect(prewetVolumeUl('jar', 1000)).toBe(1000);
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

  it('computes tip counts for autoLiquidHeight (0 probe tips), legacy stockCheck, and by_vial strategy', () => {
    const rows: any[] = [
      { 'vol#R1': 20, 'vol#solvent': 480 },
      { 'vol#R1': 20, 'vol#solvent': 480 },
    ];
    const stocks = { R1: {} };

    const autoCounts = calculateTipCounts(rows, stocks, false, false, { autoLiquidHeight: true });
    expect(autoCounts.stockCheckTips).toBe(0);
    expect(autoCounts[50]).toBe(1);
    expect(autoCounts[1000]).toBe(1);

    const legacyCounts = calculateTipCounts(rows, stocks, true, false);
    expect(legacyCounts.stockCheckTips).toBe(2); // R1 + solvent
    expect(legacyCounts[300]).toBeGreaterThanOrEqual(2);

    const byVialCounts = calculateTipCounts(rows, stocks, false, false, {
      autoLiquidHeight: true,
      pipettingStrategy: 'by_vial',
    });
    expect(byVialCounts[50]).toBe(2);
    expect(byVialCounts[1000]).toBe(2);
  });

  it('estimates runtime with inter-reagent delays (ask_time_delays)', () => {
    const rows: any[] = Array.from({ length: 54 }, (_, i) => ({
      local_index: i,
      global_index: i,
      'vol#R1': 100,
      'vol#solvent': 400,
    }));
    const tipCounts = calculateTipCounts(rows, { R1: {} }, false, false, { autoLiquidHeight: true });
    const estNoDelay = estimateRuntime(rows, tipCounts, false, false, {
      autoLiquidHeight: true,
      substanceDelaySec: 0,
    });
    const estWithDelay = estimateRuntime(rows, tipCounts, false, false, {
      autoLiquidHeight: true,
      substanceDelaySec: 120,
    });

    expect(estNoDelay.seconds).toBeGreaterThan(0);
    expect(estNoDelay.lowSeconds).toBeLessThanOrEqual(estNoDelay.seconds);
    expect(estNoDelay.highSeconds).toBeGreaterThanOrEqual(estNoDelay.seconds);
    expect(estNoDelay.plates).toBe(1);
    expect(estWithDelay.delaySeconds).toBe(120);
    expect(estWithDelay.seconds).toBe(estNoDelay.seconds + 120);
  });

  it('builds pre-flight checks flagging 40 mL bottles and dead-volume shortages', () => {
    const checks = computePreFlightChecks({
      stocks: {
        A: {
          substance: 'A',
          breadboard_plate_id: 3,
          container_id: 0,
          solvent: 'DMF',
          consumption_uL: 24000,
          prep_volume_ml: 25,
          direct_consumption_ml: 24,
          additional_dilution_source_ml: 0,
        },
        B: {
          substance: 'B',
          breadboard_plate_id: 3,
          container_id: 1,
          solvent: 'DMF',
          consumption_uL: 4500,
          prep_volume_ml: 5,
          direct_consumption_ml: 4.5,
          additional_dilution_source_ml: 0,
        },
      } as any,
      deck: {
        solvent_plate: 6,
        solvent_container: 0,
        solvent_kind: 'jar',
      } as any,
      reactionSolvent: 'DMF',
      solventConsumptionMl: 20,
      solventRecommendedMl: 30,
    });

    const aCheck = checks.find((c) => c.substance === 'A');
    const bCheck = checks.find((c) => c.substance === 'B');
    const sCheck = checks.find((c) => c.isSolvent);
    expect(aCheck?.bottleSizeLabel).toBe('40 mL bottle');
    expect(aCheck?.status).toBe('warn');
    expect(bCheck?.status).toBe('warn'); // 4.5 mL needed + 1.0 mL dead = 5.5 mL > 5 mL prepared
    expect(bCheck?.marginUl).toBeLessThan(0);
    expect(sCheck?.status).toBe('ok');
  });

  it('warns when Roboski#1 (right hood) uses water or DMSO with 50 µL empty-mode transfers', () => {
    const run = buildRun({
      hood: 'right',
      vialVolume: 500,
      threshold: 10,
      dilutionFactor: 5,
      leftoverMl: 2,
      reactionSolvent: 'water',
      reagents: [
        {
          code: 'A',
          name: 'Acid',
          molarMass: 100,
          solvent: 'water',
          stock: 100,
          min: 6,
          step: 1,
          max: 6,
        },
        {
          code: 'B',
          name: 'Base',
          molarMass: 100,
          solvent: 'water',
          stock: 100,
          min: 20,
          step: 1,
          max: 20,
        },
      ],
    });
    expect(run.issues.some((i) => i.type === 'roboski1-lc0')).toBe(true);
  });

  it('plans zeus-pipetter/diluter.py two-stage dilutions with exact factors, tips, and overflow checks', () => {
    const plan = calculateDiluterPlan({
      vialCount: 54,
      crudeVolumeUl: 500,
      solvent0: 'ethanol',
      solvent0JarPlate: 6,
      solvent0JarPos: 0,
      volSolventToA: 500,
      volAToB: 50,
      volSolventToB: 950,
      enableSecondStage: true,
      solvent1: 'ethanol',
      solvent1JarPlate: 6,
      solvent1JarPos: 1,
      volSolventToBExtra: 0,
      volBToC: 100,
      volSolventToC: 900,
    });

    expect(plan.volumesArray).toEqual([500, 50, 950, 0, 100, 900]);
    expect(plan.pythonVolumesLine).toBe('volumes = [500, 50, 950, 0, 100, 900]');
    expect(plan.factorA).toBe(2); // (500 + 500) / 500
    expect(plan.factorAB).toBe(20); // (50 + 950) / 50
    expect(plan.totalFactorB).toBe(40);
    expect(plan.totalFactorC).toBe(400);
    expect(plan.tips[50]).toBe(54); // A->B 50 uL new tip per vial
    expect(plan.tips[300]).toBe(54); // B->C 100 uL new tip per vial
    expect(plan.tips[1000]).toBe(3); // 3 bulk solvent steps (1 tip each)
    expect(plan.ok).toBe(true);
  });

  it('auto-corrects bottle plates (plate3-5) to bottle kind and ignores dead volume when 0 mL solvent is required', () => {
    const layout = assignDeckPositions('left', {}, {
      solventPlate: 4,
      solventKind: 'jar', // stale jar setting on a bottle plate
      solventPos: 0,
      stockPlates: [3, 4, 5],
    });
    expect(layout.solvent_kind).toBe('bottle');

    const checks = computePreFlightChecks({
      stocks: {},
      deck: {
        solvent_plate: 6,
        solvent_container: 0,
        solvent_kind: 'jar',
      } as any,
      reactionSolvent: 'DMSO',
      solventConsumptionMl: 0,
      solventRecommendedMl: 0,
    });
    const sCheck = checks.find((c) => c.isSolvent);
    expect(sCheck?.deadVolumeUl).toBe(0);
    expect(sCheck?.status).toBe('ok');
    expect(sCheck?.bottleSizeLabel).toBe('Not needed');

    // Full run where two reagents fill 100% of vial -> 0 solvent needed -> 0 solventRecommendedMl, no Low liquid warning
    const run = buildRun({
      hood: 'left',
      vialVolume: 500,
      threshold: 10,
      dilutionFactor: 5,
      leftoverMl: 2,
      reactionSolvent: 'DMSO',
      reagents: [
        {
          code: 'A',
          name: 'SubA',
          molarMass: 100,
          solvent: 'DMSO',
          stock: 100,
          min: 50,
          step: 10,
          max: 50,
        },
        {
          code: 'B',
          name: 'SubB',
          molarMass: 100,
          solvent: 'DMSO',
          stock: 100,
          min: 50,
          step: 10,
          max: 50,
        },
      ],
    });
    expect(run.solventConsumptionMl).toBe(0);
    expect(run.solventRecommendedMl).toBe(0);
    const runSolventCheck = run.preFlight.find((c) => c.isSolvent);
    expect(runSolventCheck?.status).toBe('ok');
    expect(runSolventCheck?.deadVolumeUl).toBe(0);
  });
});
