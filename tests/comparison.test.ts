import { describe, expect, it } from 'vitest';
import {
  CURRENT_RUN_ID,
  buildRunSnapshotFromState,
  buildWellComparisonMatrix,
  compareRunsSummary,
  extractWellSnapshot,
  toComparableRunFromCurrent,
  toComparableRunFromSaved,
} from '../src/engine/comparison';
import { RunState, SavedRun } from '../src/types';
import { WellPredictionResult } from '../src/engine/predictor/types';

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run_base',
    name: 'Base Screen',
    mode: 'equivalence',
    hood: 'left',
    vialVolume: 500,
    threshold: 50,
    dilutionFactor: 5,
    reactionSolvent: 'ethanol',
    leftoverMl: 2,
    flasksText: '2, 5, 10, 20, 50',
    randomize: false,
    randomSeed: 42,
    solventAfter: 0,
    deckPlates: null,
    stockVolumeCheck: true,
    newTipEveryTransfer: false,
    reagents: [
      {
        code: 'A',
        name: 'Benzaldehyde',
        molarMass: 106.12,
        density: 1.04,
        stock: 500,
        solvent: 'ethanol',
        smiles: 'O=Cc1ccccc1',
      },
      {
        code: 'B',
        name: 'Aniline',
        molarMass: 93.13,
        density: 1.02,
        stock: 500,
        solvent: 'ethanol',
        smiles: 'Nc1ccccc1',
      },
      {
        code: 'Ac',
        name: 'TsOH',
        molarMass: 172.2,
        density: 0,
        stock: 250,
        solvent: 'ethanol',
      },
    ],
    sets: [
      {
        name: 'Set 1',
        items: [
          { on: true, min: 50, step: 50, max: 100 },
          { on: true, min: 1, step: 0.5, max: 1.5 },
          { on: true, min: 0.2, step: 0.2, max: 0.2 },
        ],
      },
    ],
    eln: {
      temperatureC: 60,
      reactionTimeHours: 12,
      atmosphere: 'N2 Glovebox',
      wells: {
        '0-0': {
          wellIndex: 0,
          plateIndex: 0,
          status: 'clean',
          conversion: 72,
          yield: 65,
          tags: ['homogeneous'],
          notes: 'Clean imine spot',
        },
        '0-1': {
          wellIndex: 1,
          plateIndex: 0,
          status: 'hit',
          conversion: 96,
          yield: 89,
          tags: ['homogeneous'],
          notes: 'Best condition',
        },
      },
    },
    ...overrides,
  };
}

function makeSavedRun(id: string, name: string, state: RunState): SavedRun {
  return {
    id,
    name,
    mode: state.mode,
    hood: state.hood,
    reactions: 4,
    plates: 1,
    tips: '4 / 0 / 0',
    stocks: 3,
    codes: state.reagents.map((r) => r.code),
    colors: ['#111', '#222', '#333'],
    status: 'exported',
    updated: Date.now(),
    state,
    tlc_status: 'ready',
    tlc_sets: [
      {
        uid: `set_${id}`,
        name: 'Plate 1',
        cfg: {
          hasZeroRf: true,
          warnings: [],
          lanes: [
            {
              id: 0, // Well A1 (container 0 -> lane 0 in column order)
              x0: 100,
              y0: 2000,
              length: 900,
              width: 30,
              angle: 0,
              customSpots: [
                { pos: 200, rf: 0.22, strength: 0.8, areaPct: 30, source: 'manual' },
                { pos: 500, rf: 0.55, strength: 0.9, areaPct: 70, source: 'manual' },
              ],
            },
            {
              id: 6, // Well A2 (container 1 -> lane 1*6 + 0 = 6 in column order)
              x0: 140,
              y0: 2000,
              length: 900,
              width: 30,
              angle: 0,
              customSpots: [
                { pos: 210, rf: 0.23, strength: 0.4, areaPct: 12, source: 'manual' },
                { pos: 520, rf: 0.57, strength: 0.95, areaPct: 88, source: 'manual' },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe('Multi-Run and Multi-Well Comparison Engine', () => {
  it('reconstructs RunResult and supports comparing 3+ runs side-by-side with reagent alignment by SMILES', () => {
    const st1 = makeRunState({ name: 'Screen EtOH 60C' });
    const built1 = buildRunSnapshotFromState(st1);
    expect(built1.run).not.toBeNull();
    expect(built1.run!.reactions).toBe(4);

    const compCurrent = toComparableRunFromCurrent(st1, built1.run, [], [], 'draft');
    expect(compCurrent.id).toBe(CURRENT_RUN_ID);

    // Run 2 changes solvent to DMSO, temp to 90C, and renames Benzaldehyde code to Ald
    const st2 = makeRunState({
      id: 'run_2',
      name: 'Screen DMSO 90C',
      reactionSolvent: 'DMSO',
      reagents: [
        {
          code: 'Ald',
          name: 'Benzaldehyde',
          molarMass: 106.12,
          density: 1.04,
          stock: 400,
          solvent: 'DMSO',
          smiles: 'O=Cc1ccccc1',
        },
        ...st1.reagents.slice(1),
      ],
      eln: {
        temperatureC: 90,
        reactionTimeHours: 16,
        atmosphere: 'Argon',
        wells: {
          '0-0': {
            wellIndex: 0,
            plateIndex: 0,
            status: 'hit',
            conversion: 98,
            yield: 91,
          },
        },
      },
    });
    const compRun2 = toComparableRunFromSaved(makeSavedRun('run_2', 'Screen DMSO 90C', st2));

    // Run 3 adds a 4th reagent (DMAP)
    const st3 = makeRunState({
      id: 'run_3',
      name: 'Screen DMAP Cat',
      reagents: [
        ...st1.reagents,
        {
          code: 'Cat',
          name: 'DMAP',
          molarMass: 122.17,
          density: 0,
          stock: 100,
          solvent: 'ethanol',
          smiles: 'CN(C)c1ccncc1',
        },
      ],
      sets: [
        {
          name: 'Set 1',
          items: [
            { on: true, min: 50, step: 50, max: 100 },
            { on: true, min: 1, step: 0.5, max: 1.5 },
            { on: true, min: 0.2, step: 0.2, max: 0.2 },
            { on: true, min: 0.1, step: 0.1, max: 0.1 },
          ],
        },
      ],
    });
    const compRun3 = toComparableRunFromSaved(makeSavedRun('run_3', 'Screen DMAP Cat', st3));

    const multiRun = compareRunsSummary([compCurrent, compRun2, compRun3]);
    expect(multiRun.runs).toHaveLength(3);

    // Benzaldehyde should align across all 3 runs despite code changing from A -> Ald
    const benzRow = multiRun.reagentRows.find((r) => r.smiles === 'O=Cc1ccccc1');
    expect(benzRow).toBeDefined();
    expect(benzRow!.entries.every((e) => e !== null)).toBe(true);
    expect(benzRow!.diffFlags.stock).toBe(true);

    // DMAP should be flagged as missing in runs 1 and 2
    const dmapRow = multiRun.reagentRows.find((r) => r.displayName === 'DMAP');
    expect(dmapRow).toBeDefined();
    expect(dmapRow!.diffFlags.missingAny).toBe(true);
    expect(dmapRow!.entries[0]).toBeNull();
    expect(dmapRow!.entries[1]).toBeNull();
    expect(dmapRow!.entries[2]).not.toBeNull();

    // Solvent diff detected across the 3 runs
    const solventRow = multiRun.parameterRows.find((p) => p.key === 'solvent');
    expect(solventRow?.hasDiff).toBe(true);
    expect(solventRow?.diffFromBaseline).toEqual([false, true, false]);

    // ELN summaries counted accurately
    expect(multiRun.elnSummaries[0].hits).toBe(1);
    expect(multiRun.elnSummaries[1].hits).toBe(1);
  });

  it('compares 3 wells across runs across stoichiometry, conditions, Rf bands, ELN notes, and predicted products', () => {
    const st1 = makeRunState({ name: 'EtOH Run' });
    const run1 = toComparableRunFromSaved(makeSavedRun('r1', 'EtOH Run', st1));

    const st2 = makeRunState({
      name: 'DMSO Run',
      reactionSolvent: 'DMSO',
      eln: {
        temperatureC: 95,
        wells: {
          '0-0': {
            wellIndex: 0,
            plateIndex: 0,
            status: 'hit',
            conversion: 94,
            yield: 88,
            notes: 'High selectivity',
          },
        },
      },
    });
    const run2 = toComparableRunFromSaved(makeSavedRun('r2', 'DMSO Run', st2));

    const snap1 = extractWellSnapshot(run1, 0, 0, 's1'); // Run 1 A1
    const snap2 = extractWellSnapshot(run1, 0, 1, 's2'); // Run 1 A2
    const snap3 = extractWellSnapshot(run2, 0, 0, 's3'); // Run 2 A1

    const mockPred = (species: Array<{ smiles: string; formula: string; score: number; mh: number }>): WellPredictionResult =>
      ({
        condition: snap1.extraction!.condition,
        acidBase: { effectiveMedium: 'acid', effectivePhDmso: 3.1, protonatedFraction: 0.5 },
        substrates: [],
        species: species.map((sp, i) => ({
          key: sp.smiles,
          smiles: sp.smiles,
          formula: sp.formula,
          exactMass: sp.mh - 1.0073,
          mhPlus: sp.mh,
          mNaPlus: sp.mh + 21.9819,
          mHMinus: sp.mh - 2.0146,
          clogP: 2.1,
          tpsa: 24,
          score: sp.score,
          tier: sp.score >= 0.7 ? 'High' : 'Medium',
          status: 'sink',
          stepsCount: i + 1,
          mechanismSummary: 'Imine condensation',
          alerts: [],
        })),
        stats: { highCount: 1, mediumCount: 0, lowCount: 0 },
      } as unknown as WellPredictionResult);

    const matrix = buildWellComparisonMatrix([snap1, snap2, snap3], {
      s1: mockPred([
        { smiles: 'c1ccc(C=Nc2ccccc2)cc1', formula: 'C13H11N', score: 0.91, mh: 182.0964 },
        { smiles: 'O=C(O)c1ccccc1', formula: 'C7H6O2', score: 0.42, mh: 123.0441 },
      ]),
      s2: mockPred([
        { smiles: 'c1ccc(C=Nc2ccccc2)cc1', formula: 'C13H11N', score: 0.95, mh: 182.0964 },
      ]),
      s3: mockPred([
        { smiles: 'c1ccc(C=Nc2ccccc2)cc1', formula: 'C13H11N', score: 0.88, mh: 182.0964 },
        { smiles: 'CS(=O)C', formula: 'C2H6OS', score: 0.55, mh: 79.0212 },
      ]),
    });

    // Condition rows should catch solvent & temperature difference on slot 3
    const tempRow = matrix.conditionRows.find((r) => r.key === 'temp');
    expect(tempRow?.hasDiff).toBe(true);
    expect(tempRow?.diffFromBaseline).toEqual([false, false, true]);

    // TLC Rf bands should cluster Rf ~0.22 and Rf ~0.55 across all 3 slots
    expect(matrix.rfBands.length).toBe(2);
    expect(matrix.rfBands[0].cells.every((c) => c.matched)).toBe(true);
    expect(matrix.rfBands[1].cells[1].deltaRf).toBeCloseTo(0.02, 2);

    // Product matrix should detect shared imine (3/3) and two unique species (1/3 each)
    expect(matrix.productRows[0].presenceKind).toBe('shared');
    expect(matrix.productRows[0].presentCount).toBe(3);
    const uniqueRows = matrix.productRows.filter((p) => p.presenceKind === 'unique');
    expect(uniqueRows).toHaveLength(2);
  });
});
