import { describe, it, expect } from 'vitest';
import { flaskPrep, flaskLabel, buildRun } from '../src/engine/dilution';

describe('Dilution Engine & Run Calculation', () => {
  it('selects the smallest flask that fits the volume', () => {
    expect(flaskPrep(1.5)).toBe(2);
    expect(flaskPrep(2.0)).toBe(2);
    expect(flaskPrep(2.1)).toBe(5);
    expect(flaskPrep(8.5)).toBe(10);
    expect(flaskPrep(45)).toBe(50);
    expect(flaskPrep(80)).toBe(100);
    expect(flaskPrep(150)).toBe(200); // 2 x 100 mL
  });

  it('formats appropriate flask labels', () => {
    expect(flaskLabel(5)).toBe('5 mL flask');
    expect(flaskLabel(100)).toBe('100 mL flask');
    expect(flaskLabel(200)).toBe('2 × 100 mL flasks');
  });

  it('calculates direct pipetting when transfer volume is above threshold', () => {
    // Vial: 500 µL, Stock: 100 mM, Target: 20 mM -> Transfer = (20 * 500) / 100 = 100 µL (>= 50 µL threshold)
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      randomize: false,
      reagents: [
        { code: 'R1', stock: 100, min: 20, step: 1, max: 20, molarMass: 150 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20, molarMass: 200 },
      ],
    });

    expect(run.rows.length).toBe(1);
    const row = run.rows[0];
    expect(row['vol#R1']).toBe(100);
    expect(row['vol#R2']).toBe(100);
    expect(row['vol#solvent']).toBe(300); // 500 - 100 - 100 = 300 µL
    expect(run.stocks['R1'].dilution_level).toBe(0);
    expect(run.stocks['R2'].dilution_level).toBe(0);
    expect(run.blockingIssues).toBe(0);
  });

  it('automatically triggers N dilution when volume falls below threshold', () => {
    // Vial: 500 µL, Stock: 100 mM, Target: 4 mM -> Base Vol = (4 * 500) / 100 = 20 µL (< 50 µL threshold)
    // With N=5, transfer becomes 20 * 5 = 100 µL (>= 50 µL threshold)
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      randomize: false,
      reagents: [
        { code: 'R1', stock: 100, min: 4, step: 1, max: 4, molarMass: 150 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20, molarMass: 200 },
      ],
    });

    expect(run.stocks['R1_N']).toBeDefined();
    expect(run.stocks['R1_N'].dilution_level).toBe(1);
    expect(run.stocks['R1_N'].concentration_mM).toBe(20); // 100 / 5 = 20 mM
    const row = run.rows[0];
    expect(row['vol#R1_N']).toBe(100); // 20 µL * 5 = 100 µL
    expect(row['vol#R2']).toBe(100);
    expect(row['vol#solvent']).toBe(300); // 500 - 100 - 100 = 300 µL
  });

  it('triggers N2 double dilution when 1st dilution is still below threshold', () => {
    // Vial: 500 µL, Stock: 100 mM, Target: 0.5 mM -> Base Vol = (0.5 * 500) / 100 = 2.5 µL
    // Dilution 1 (5x): 2.5 * 5 = 12.5 µL (< 50 µL)
    // Dilution 2 (25x): 2.5 * 25 = 62.5 µL (>= 50 µL)
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      randomize: false,
      reagents: [
        { code: 'R1', stock: 100, min: 0.5, step: 1, max: 0.5, molarMass: 150 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20, molarMass: 200 },
      ],
    });

    expect(run.stocks['R1_N2']).toBeDefined();
    expect(run.stocks['R1_N2'].dilution_level).toBe(2);
    expect(run.stocks['R1_N2'].concentration_mM).toBe(4); // 100 / 25 = 4 mM
    expect(run.stocks['R1_N2'].parent_stock_key).toBe('R1_N');
    const prepVolN2 = run.stocks['R1_N2'].prep_volume_ml;
    expect(run.stocks['R1_N2'].parent_source_volume_ml).toBeCloseTo(prepVolN2 / 5, 4);
    expect(run.stocks['R1_N2'].diluent_volume_ml).toBeCloseTo(prepVolN2 - (prepVolN2 / 5), 4);
    // Ensure parent R1_N accounts for the volume drawn by R1_N2
    expect(run.stocks['R1_N'].additional_dilution_source_ml).toBeCloseTo(prepVolN2 / 5, 4);
    const row = run.rows[0];
    expect(row['vol#R1_N2']).toBe(62.5);
  });

  it('flags blocking issue when solvent volume is negative', () => {
    // 500 µL vial, but reagents add up to 300 + 300 = 600 µL
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      randomize: false,
      reagents: [
        { code: 'R1', stock: 100, min: 60, step: 1, max: 60 },
        { code: 'R2', stock: 100, min: 60, step: 1, max: 60 },
      ],
    });

    expect(run.blockingIssues).toBeGreaterThan(0);
    const issue = run.issues.find((i) => i.type === 'negative-solvent');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('block');
  });

  it('calculates mass correctly for chemical stock preparation', () => {
    // Prep: 10 mL, Stock: 200 mM, MW: 150 g/mol
    // mass_g = (prep_ml * conc_mM * MW) / 1e6 = (10 * 200 * 150) / 1e6 = 0.3 g
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      flaskSizes: [10],
      reagents: [
        { code: 'R1', stock: 200, min: 20, step: 1, max: 20, molarMass: 150, prepareVolumeMl: 10 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20, molarMass: 100, prepareVolumeMl: 10 },
      ],
    });

    expect(run.stocks['R1'].mass_g).toBeCloseTo(0.3, 4);
  });
});
