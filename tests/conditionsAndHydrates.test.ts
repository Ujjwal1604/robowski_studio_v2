import { describe, it, expect, beforeAll } from 'vitest';
import {
  detectHydrateStoichiometry,
  getCanonicalRunConditions,
  applyRunConditionsPatch,
  summarizeRunHydrates,
  extractWellForPrediction,
  predictWellReactions,
  WATER_PCT_PER_MM,
} from '../src/engine';
import { exampleState, normalize } from '../src/context/runPayload';
import { RunRow, RunState } from '../src/types';

let rdkit: any;
beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  rdkit = await (mod.default || mod)();
});

describe('Canonical Run Conditions Synchronization', () => {
  it('syncs solvent, temperature, water %, and ELN execution conditions without losing 0°C or 0% H2O', () => {
    const base = normalize(exampleState());
    expect(getCanonicalRunConditions(base).temperatureC).toBe(25);
    expect(getCanonicalRunConditions(base).baseWaterPct).toBe(2);

    const chilled = applyRunConditionsPatch(base, {
      solvent: 'DMSO',
      temperatureC: 0,
      baseWaterPct: 0,
      reactionTimeHours: 24,
      atmosphere: 'Argon Schlenk',
    });

    expect(chilled.reactionSolvent).toBe('DMSO');
    expect(chilled.temperatureC).toBe(0);
    expect(chilled.waterPct).toBe(0);
    expect(chilled.eln?.temperatureC).toBe(0);
    expect(chilled.eln?.waterPct).toBe(0);
    expect(chilled.eln?.reactionTimeHours).toBe(24);
    expect(chilled.eln?.atmosphere).toBe('Argon Schlenk');

    const roundTripped = normalize(JSON.parse(JSON.stringify(chilled)));
    const cond = getCanonicalRunConditions(roundTripped);
    expect(cond.solvent).toBe('DMSO');
    expect(cond.temperatureC).toBe(0);
    expect(cond.baseWaterPct).toBe(0);
  });

  it('recovers legacy ELN temperature when top-level temperatureC is absent', () => {
    const legacy: RunState = {
      ...exampleState(),
      temperatureC: undefined,
      waterPct: undefined,
    };
    legacy.eln = { ...(legacy.eln || { wells: {} }), temperatureC: 65 };
    const norm = normalize(legacy);
    expect(norm.temperatureC).toBe(65);
    expect(getCanonicalRunConditions(norm).temperatureC).toBe(65);
  });
});

describe('Hydrate Stoichiometry & Quantitative Water Contribution', () => {
  it('detects hydrate stoichiometry from SMILES fragments, chemical names, and formula suffixes without double counting', () => {
    expect(detectHydrateStoichiometry('Cc1ccc(S(=O)(=O)O)cc1.O').waterEquivPerMol).toBe(1);
    expect(detectHydrateStoichiometry('O=C(O)C(=O)O.O.O').waterEquivPerMol).toBe(2);
    expect(detectHydrateStoichiometry('Cc1ccc(S(=O)(=O)O)cc1', 'p-Toluenesulfonic acid monohydrate').waterEquivPerMol).toBe(1);
    expect(detectHydrateStoichiometry('Cc1ccc(S(=O)(=O)O)cc1.O', 'p-Toluenesulfonic acid monohydrate').waterEquivPerMol).toBe(1);
    expect(detectHydrateStoichiometry('', 'TsOH·H2O').waterEquivPerMol).toBe(1);
    expect(detectHydrateStoichiometry('', 'CuSO4·5H2O').waterEquivPerMol).toBe(5);
    expect(detectHydrateStoichiometry('', 'Copper(II) sulfate pentahydrate').waterEquivPerMol).toBe(5);
    expect(detectHydrateStoichiometry('', 'Potassium carbonate sesquihydrate').waterEquivPerMol).toBe(1.5);
    expect(detectHydrateStoichiometry('', 'Oxalic acid dihydrate').waterEquivPerMol).toBe(2);
    expect(detectHydrateStoichiometry('', 'Calcium sulfate hemihydrate').waterEquivPerMol).toBe(0.5);

    // Avoid false positives on non-hydrate names
    expect(detectHydrateStoichiometry('C=O', 'Formaldehyde (CH2O)').waterEquivPerMol).toBe(0);
    expect(detectHydrateStoichiometry('', 'Standard carbohydrate substrate').waterEquivPerMol).toBe(0);
    expect(detectHydrateStoichiometry('Cc1ccc(S(=O)(=O)O)cc1', 'Anhydrous p-TsOH').waterEquivPerMol).toBe(0);
  });

  it('captures hydrate water from both organic substrates and known additives across plateBridge & engine without double counting', () => {
    const baseState = applyRunConditionsPatch(normalize(exampleState()), {
      solvent: 'DMSO',
      temperatureC: 80,
      baseWaterPct: 0.2,
    });
    baseState.reagents = [
      {
        code: 'A',
        name: 'Benzaldehyde',
        molarMass: 106.12,
        density: 1.04,
        stock: 500,
        solvent: 'DMSO',
        smiles: 'O=Cc1ccccc1',
      },
      {
        code: 'B',
        name: 'Aniline',
        molarMass: 93.13,
        density: 1.02,
        stock: 500,
        solvent: 'DMSO',
        smiles: 'Nc1ccccc1',
      },
      {
        code: 'Ac',
        name: 'p-Toluenesulfonic acid monohydrate',
        molarMass: 190.22,
        density: 1.24,
        stock: 250,
        solvent: 'DMSO',
        smiles: 'Cc1ccc(S(=O)(=O)O)cc1.O',
      },
    ];

    const row: RunRow = {
      local_index: 0,
      global_index: 0,
      combo_index: 0,
      plate_number: 0,
      container_id: 0,
      'vol#solvent': 400,
      recipe: [
        {
          code: 'A',
          name: 'Benzaldehyde',
          color: '#111',
          target_concentration: 100,
          value: 100,
          equivalence: 1,
          base_volume: 100,
          transfer_volume: 100,
          stock_key: 'A',
          dilution_level: 0,
          stock_concentration: 500,
          solvent: 'DMSO',
          molarMass: 106.12,
          chemicalDensity: 1.04,
          liquidDensity: 1.04,
        },
        {
          code: 'B',
          name: 'Aniline',
          color: '#222',
          target_concentration: 100,
          value: 100,
          equivalence: 1,
          base_volume: 100,
          transfer_volume: 100,
          stock_key: 'B',
          dilution_level: 0,
          stock_concentration: 500,
          solvent: 'DMSO',
          molarMass: 93.13,
          chemicalDensity: 1.02,
          liquidDensity: 1.02,
        },
        {
          code: 'Ac',
          name: 'p-Toluenesulfonic acid monohydrate',
          color: '#333',
          target_concentration: 50,
          value: 50,
          equivalence: 0.5,
          base_volume: 100,
          transfer_volume: 100,
          stock_key: 'Ac',
          dilution_level: 0,
          stock_concentration: 250,
          solvent: 'DMSO',
          molarMass: 190.22,
          chemicalDensity: 1.24,
          liquidDensity: 1.24,
        },
      ],
    };

    const extraction = extractWellForPrediction(baseState, row);
    expect(extraction.condition.temperatureC).toBe(80);
    expect(extraction.condition.baseWaterPct).toBeCloseTo(0.2, 3);
    // 50 mM TsOH·H2O additive -> 50 mM H2O -> 0.09025% v/v
    expect(extraction.condition.hydrateWaterMm).toBe(50);
    expect(extraction.condition.hydrateWaterPct).toBeCloseTo(50 * WATER_PCT_PER_MM, 3);
    expect(extraction.condition.waterPct).toBeCloseTo(0.2 + 50 * WATER_PCT_PER_MM, 3);

    const pred = predictWellReactions(rdkit, extraction.substrates, extraction.condition);
    // No double counting when prediction engine consumes extraction
    expect(pred.condition.baseWaterPct).toBeCloseTo(0.2, 3);
    expect(pred.condition.hydrateWaterMm).toBe(50);
    expect(pred.condition.waterPct).toBeCloseTo(0.2 + 50 * WATER_PCT_PER_MM, 3);
    expect(pred.alerts.some((a) => a.kind === 'hydrate_water')).toBe(true);

    // Also test Setup-level hydrate summary
    const hydSummary = summarizeRunHydrates(baseState, { rows: [row] } as any);
    expect(hydSummary.hasHydrates).toBe(true);
    expect(hydSummary.items).toHaveLength(1);
    expect(hydSummary.items[0].code).toBe('Ac');
    expect(hydSummary.minTotalHydrateWaterPct).toBeCloseTo(50 * WATER_PCT_PER_MM, 3);
  });

  it('reduces reversible dehydration persistence & score when a high-equivalent pentahydrate adds substantial water', () => {
    const drySubs = [
      { id: '1', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1, concentrationMm: 200 },
      { id: '2', code: 'B', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1, concentrationMm: 200 },
    ];
    const hydrateSubs = [
      { id: '1', code: 'A', name: 'Benzaldehyde (pentahydrate test)', smiles: 'O=Cc1ccccc1.O.O.O.O.O', equivalents: 1, concentrationMm: 400 },
      { id: '2', code: 'B', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1, concentrationMm: 400 },
    ];

    const cond = {
      medium: 'acid' as const,
      additiveName: 'TsOH',
      additiveEquiv: 0.2,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 0.2,
      solvent: 'DMSO',
      equivBasis: 'limiting' as const,
    };

    const resDry = predictWellReactions(rdkit, drySubs, cond);
    const resHyd = predictWellReactions(rdkit, hydrateSubs, cond);

    const imineDry = resDry.species.find((s) => s.formula === 'C13H11N')!;
    const imineHyd = resHyd.species.find((s) => s.formula === 'C13H11N')!;

    // 400 mM pentahydrate -> 2000 mM H2O -> +3.61% v/v H2O -> reduces imine persistence!
    expect(resHyd.condition.hydrateWaterMm).toBe(2000);
    expect(resHyd.condition.waterPct).toBeCloseTo(0.2 + 2000 * WATER_PCT_PER_MM, 2);
    expect(imineHyd.persistence).toBeLessThan(imineDry.persistence);
  });
});
