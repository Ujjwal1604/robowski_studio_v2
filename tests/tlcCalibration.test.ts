import { describe, it, expect, beforeAll } from 'vitest';
import {
  TLC_SOLVENT_LIBRARY,
  matchTlcSetNameToSolvent,
  calibrateTlcModelFromCampaign,
  optimizePlateTlcSolvents,
  predictTlcRf,
  profileMoleculeForTlc,
} from '../src/engine/predictor';
import { containerOfLane } from '../src/engine/tlcLanes';
import { LANE_FRAME_WIDTH } from '../src/engine/constants';
import { exampleState } from '../src/context/runPayload';
import { RunResult, TlcSet } from '../src/types';

let rdkit: any;

beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  const initFn = mod.default || mod;
  rdkit = await initFn();
});

function buildSyntheticPlateProfile(rfTargets: number[], length: number = 400, origin: number = 40, front: number = 360): number[] {
  const arr = new Array(length).fill(230);
  const span = front - origin;
  // Dark origin mark + bright front edge (UV254 negative spots)
  for (let i = Math.max(0, origin - 2); i <= Math.min(length - 1, origin + 2); i++) arr[i] = 170;
  for (let i = Math.max(0, front - 2); i <= Math.min(length - 1, front + 2); i++) arr[i] = 245;
  for (const rf of rfTargets) {
    const center = Math.round(origin + rf * span);
    for (let dy = -7; dy <= 7; dy++) {
      const idx = center + dy;
      if (idx > origin + 8 && idx < front - 6) {
        const drop = 110 * Math.exp(-(dy * dy) / 14);
        arr[idx] = Math.min(arr[idx], Math.round(230 - drop));
      }
    }
  }
  return arr;
}

describe('Empirical TLC Self-Calibration (#7)', () => {
  it('parses canonical and chemist shorthand TLC tab names cleanly and flags unknown names', () => {
    const m1 = matchTlcSetNameToSolvent('25% EtOAc / Hexanes');
    expect(m1?.system.id).toBe('etoac_hex_25');
    expect(m1?.stationaryPhase).toBe('SiO2');

    const m2 = matchTlcSetNameToSolvent('1:1 EA/Hex');
    expect(m2?.system.id).toBe('etoac_hex_50');

    const m3 = matchTlcSetNameToSolvent('2:1 Hex/EtOAc');
    expect(m3?.system.id).toBe('etoac_hex_25');

    const m4 = matchTlcSetNameToSolvent('5% MeOH / DCM + 1% Et₃N');
    expect(m4?.system.id).toBe('meoh_dcm_5_et3n');

    const m5 = matchTlcSetNameToSolvent('50% EtOAc / Hexanes (Neutral Al₂O₃)');
    expect(m5?.system.id).toBe('etoac_hex_50');
    expect(m5?.stationaryPhase).toBe('Al2O3_neutral');

    const m6 = matchTlcSetNameToSolvent('Set 1');
    expect(m6).toBeNull();

    const mOverride = matchTlcSetNameToSolvent('Set 1', 'etoac_hex_50');
    expect(mOverride?.system.id).toBe('etoac_hex_50');
    expect(mOverride?.matchSource).toBe('manual');

    expect(matchTlcSetNameToSolvent('25% EtOAc / Hexanes', 'ignore')).toBeNull();
  });

  it('fits positive mid-plate Rf shift when measured TLC spots elute consistently higher than uncalibrated predictions, and respects stationary-phase isolation + OFF toggle', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      {
        code: 'A',
        name: 'Benzaldehyde',
        smiles: 'O=Cc1ccccc1',
        molarMass: 106.12,
        density: 1.04,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'B',
        name: 'Malononitrile',
        smiles: 'N#CCC#N',
        molarMass: 66.06,
        density: 1.05,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };

    // 14 active wells
    const rows = Array.from({ length: 14 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: 'Benzaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Malononitrile', target_concentration: 50, equivalence: 1 },
      ],
      'vol#solvent': 400,
    }));
    const fakeRun = { plates: 1, reactions: 14, rows } as unknown as RunResult;

    const sys25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const benzPred = predictTlcRf(profileMoleculeForTlc(rdkit, 'O=Cc1ccccc1'), sys25).rf;
    // Construct 14 lanes in 25% EtOAc/Hex where spots consistently elute +0.16 Rf higher than raw model
    const lanes = [];
    const prof: Record<string, number[]> = {};
    for (let laneId = 0; laneId < 54; laneId++) {
      const wellIdx = containerOfLane(laneId);
      const isMeas = wellIdx < 14;
      const obsRf = Math.min(0.92, benzPred + 0.16);
      lanes.push({
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
      });
      if (isMeas) {
        prof[`UV254:${laneId}:0.35`] = buildSyntheticPlateProfile([obsRf], 400, 40, 360);
      }
    }

    const measuredSet: TlcSet = {
      uid: 'set_meas_1',
      name: '25% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'synthetic',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      frontAuto: {},
      originPx: 40,
      originAuto: {},
      imgs: {},
      prof,
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measuredSet],
    });

    const sio2Fit = model.byPhase.SiO2;
    expect(sio2Fit).toBeDefined();
    expect(sio2Fit!.pairedSpotCount).toBe(14);
    expect(sio2Fit!.globalDemandShift).toBeLessThan(0);
    expect(sio2Fit!.midplateRfShift).toBeGreaterThan(0.05);
    expect(sio2Fit!.rmseAfter).toBeLessThan(sio2Fit!.rmseBefore);
    // Phase isolation: C18 and Al2O3 remain uncalibrated
    expect(model.byPhase.C18).toBeUndefined();
    expect(model.byPhase.Al2O3_neutral).toBeUndefined();

    // Uncalibrated vs Calibrated plan comparison ("Turn OFF" vs "Turn ON")
    const rawPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0,
      stationaryPhase: 'SiO2',
      calibration: undefined,
    });
    const calPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0,
      stationaryPhase: 'SiO2',
      calibration: model,
    });

    expect(rawPlan.calibrationApplied).toBeUndefined();
    expect(calPlan.calibrationApplied?.active).toBe(true);
    expect(calPlan.calibrationApplied?.pairedSpotCount).toBe(14);

    // For a given solvent (25% EtOAc/Hex), calibrated simulated spot Rf shifts higher than uncalibrated spot Rf
    const find25 = (plan: typeof rawPlan) =>
      [...plan.recommendedSystems, ...plan.otherSystems].find((s) => s.system.id === 'etoac_hex_25')!;
    const rawSpotRf = find25(rawPlan).lanes[0].spots[0].rf;
    const calSpotRf = find25(calPlan).lanes[0].spots[0].rf;
    expect(calSpotRf).toBeGreaterThan(rawSpotRf);
  });

  it('keeps shrinkage conservative on 1-2 noisy spots and preserves zero shift when no plates match', () => {
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      {
        code: 'A',
        name: 'Benzaldehyde',
        smiles: 'O=Cc1ccccc1',
        molarMass: 106.12,
        density: 1.04,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    const rows = [
      {
        local_index: 0,
        global_index: 0,
        combo_index: 0,
        plate_number: 0,
        container_id: 0,
        recipe: [{ code: 'A', name: 'Benzaldehyde', target_concentration: 50, equivalence: 1 }],
      },
    ];
    const fakeRun = { plates: 1, reactions: 1, rows } as unknown as RunResult;

    const singleSpotSet: TlcSet = {
      uid: 'set_small',
      name: '25% EtOAc / Hexanes',
      cfg: {
        lanes: [
          {
            id: 0,
            x0: 10,
            y0: 0,
            x1: 10,
            y1: 400,
            width: 14,
            length: 400,
            zeroRf: 40,
            customSpots: [{ pos: 300, rf: 0.72, strength: 0.9, source: 'manual' }],
          },
          {
            id: 1,
            x0: 30,
            y0: 0,
            x1: 30,
            y1: 400,
            width: 14,
            length: 400,
            zeroRf: 40,
            customSpots: [],
          },
        ],
      },
      cfgName: 'small',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [singleSpotSet],
    });
    // Strong shrinkage lambda=6 prevents 1 spot from swinging prediction massively
    expect(Math.abs(model.byPhase.SiO2?.midplateRfShift ?? 0)).toBeLessThan(0.08);
  });

  it('builds per-lane Found vs Missing vs Extra spot comparison across all 54 wells', () => {
    const state = exampleState();
    state.mode = 'concentration';
    const smSmiles = 'CC(=O)Nc1ccccc1'; // Acetanilide (UV active)
    const prod1Smiles = 'O=[N+]([O-])c1ccc(OC)cc1'; // 4-nitroanisole (distinct Rf, UV active)
    const prod2Smiles = 'NC(=O)c1ccccc1'; // Benzamide (more polar, UV active)

    state.reagents = [
      {
        code: 'A',
        name: 'Acetanilide',
        smiles: smSmiles,
        molarMass: 135.17,
        density: 1.2,
        stock: 500,
        solvent: 'DMSO',
      },
    ];

    const sys50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const smRf = predictTlcRf(profileMoleculeForTlc(rdkit, smSmiles), sys50).rf;
    const prod1Rf = predictTlcRf(profileMoleculeForTlc(rdkit, prod1Smiles), sys50).rf;
    const prod2Rf = predictTlcRf(profileMoleculeForTlc(rdkit, prod2Smiles), sys50).rf;

    // Pick an extra Rf guaranteed > 0.26 away from all predicted species
    const candidates = [0.05, 0.95, 0.50, 0.20, 0.80];
    const extraRf =
      candidates.find(
        (c) =>
          Math.abs(c - smRf) > 0.26 &&
          Math.abs(c - prod1Rf) > 0.26 &&
          Math.abs(c - prod2Rf) > 0.26
      ) ?? 0.96;

    const rows = [
      {
        local_index: 0,
        global_index: 0,
        combo_index: 0,
        plate_number: 0,
        container_id: 0,
        recipe: [{ code: 'A', name: 'Acetanilide', target_concentration: 50, equivalence: 1 }],
      },
    ];
    const fakeRun = { plates: 1, reactions: 1, rows } as unknown as RunResult;

    const cachedPredictions: any = {
      '0-0': {
        substrates: [{ code: 'A', name: 'Acetanilide', neutralSmiles: smSmiles, valid: true }],
        species: [
          {
            key: 'prod_found',
            tautomerKey: 'prod_found',
            smiles: prod1Smiles,
            formula: 'C7H7NO3',
            mechanismSummary: 'Found Target',
            tier: 'High',
            score: 0.9,
          },
          {
            key: 'prod_missing',
            tautomerKey: 'prod_missing',
            smiles: prod2Smiles,
            formula: 'C7H7NO',
            mechanismSummary: 'Missing Side Product',
            tier: 'Medium',
            score: 0.6,
          },
        ],
      },
    };

    // Only spot Prod 1 (Found) and an Extra unpredicted spot; omit SM and Prod 2!
    const lanes = Array.from({ length: 54 }, (_, laneId) => {
      const wellIdx = containerOfLane(laneId);
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots:
          wellIdx === 0
            ? [
                { pos: Math.round(40 + prod1Rf * 320), rf: prod1Rf, strength: 0.9, source: 'manual' as const },
                { pos: Math.round(40 + extraRf * 320), rf: extraRf, strength: 0.7, source: 'manual' as const },
              ]
            : [],
      };
    });

    const tlcSet: TlcSet = {
      uid: 'set_comp',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'comp',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [tlcSet],
      cachedPredictions,
    });

    expect(model.plates.length).toBe(1);
    const compPlate = model.plates[0];
    expect(compPlate.lanes.length).toBe(54);

    const w0 = compPlate.lanes[0];
    expect(w0.isBlank).toBe(false);

    const foundEntry = w0.predictedSpots.find((p) => p.label === 'Found Target');
    const missingProdEntry = w0.predictedSpots.find((p) => p.label === 'Missing Side Product');
    const missingSmEntry = w0.predictedSpots.find((p) => p.kind === 'substrate');
    expect(foundEntry?.found).toBe(true);
    expect(foundEntry?.matchedObsRf).toBeCloseTo(prod1Rf, 1);

    // Omitted spots are flagged as not found (only if > 0.24 away from prod1Rf and extraRf)
    if (Math.abs(prod2Rf - prod1Rf) > 0.24 && Math.abs(prod2Rf - extraRf) > 0.24) {
      expect(missingProdEntry?.found).toBe(false);
    }
    if (Math.abs(smRf - prod1Rf) > 0.24 && Math.abs(smRf - extraRf) > 0.24) {
      expect(missingSmEntry?.found).toBe(false);
    }

    // Extra measured spot remains unassigned
    const unmatchedMeasured = w0.measuredSpots.filter((m) => !m.matchedLabel);
    expect(unmatchedMeasured.length).toBe(1);
    expect(unmatchedMeasured[0].rf).toBeCloseTo(extraRf, 1);

    // Unused wells 1..53 are marked blank
    expect(compPlate.lanes[1].isBlank).toBe(true);
  });

  it('matches weak nonpolar eluents (100% Hexanes, 2% and 5% EtOAc/Hex) and solves front saturation via censored calibration + follow-up rescue recommender', async () => {
    // 1. Weak nonpolar shorthand matching
    expect(matchTlcSetNameToSolvent('100% Hexanes')?.system.id).toBe('hexanes_100');
    expect(matchTlcSetNameToSolvent('2% EtOAc / Hexanes')?.system.id).toBe('etoac_hex_2');
    expect(matchTlcSetNameToSolvent('5% EtOAc/Hex')?.system.id).toBe('etoac_hex_5');

    // 2. Nonpolar substrate (4-Methoxybiphenyl, Rf ~0.85 in 25% EtOAc/Hex) + polar/mid substrate (Benzophenone, Rf ~0.62)
    //    + nonpolar ester product (Methyl biphenyl-4-carboxylate, Rf ~0.74 in 25% EtOAc/Hex, separated nicely at 2–5% EtOAc/Hex)
    const state = exampleState();
    state.mode = 'concentration';
    const smNonpolar = 'COc1ccc(-c2ccccc2)cc1'; // 4-methoxybiphenyl
    const smMid = 'O=C(c1ccccc1)c1ccccc1'; // Benzophenone
    const prodNonpolar = 'COC(=O)c1ccc(-c2ccccc2)cc1'; // Methyl biphenyl-4-carboxylate

    state.reagents = [
      {
        code: 'A',
        name: '4-Methoxybiphenyl',
        smiles: smNonpolar,
        molarMass: 184.24,
        density: 1.04,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'B',
        name: 'Benzophenone',
        smiles: smMid,
        molarMass: 182.22,
        density: 1.1,
        stock: 500,
        solvent: 'DMSO',
      },
    ];

    const rows = Array.from({ length: 8 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: '4-Methoxybiphenyl', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Benzophenone', target_concentration: 50, equivalence: 1 },
      ],
    }));
    const fakeRun = { plates: 1, reactions: 8, rows } as unknown as RunResult;

    const cachedPredictions: Record<string, any> = {};
    for (let w = 0; w < 8; w++) {
      cachedPredictions[`0-${w}`] = {
        substrates: [
          { code: 'A', name: '4-Methoxybiphenyl', neutralSmiles: smNonpolar, valid: true },
          { code: 'B', name: 'Benzophenone', neutralSmiles: smMid, valid: true },
        ],
        species: [
          {
            key: 'np_prod',
            tautomerKey: 'np_prod',
            smiles: prodNonpolar,
            formula: 'C14H12O2',
            mechanismSummary: 'Nonpolar Ester Product',
            tier: 'High',
            score: 0.9,
          },
        ],
      };
    }

    const sys25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const midPredRf = predictTlcRf(profileMoleculeForTlc(rdkit, smMid), sys25).rf;

    // Plate 1: 25% EtOAc/Hexanes where Benzophenone elutes higher than predicted (+0.15 Rf),
    // and Biphenyl + Nonpolar Product both run right into the solvent front (Rf 0.96 -> frontOccupied)
    const lanes1 = [];
    const prof1: Record<string, number[]> = {};
    for (let laneId = 0; laneId < 54; laneId++) {
      const wellIdx = containerOfLane(laneId);
      const isMeas = wellIdx < 8;
      lanes1.push({
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
      });
      const arr = new Array(400).fill(230);
      for (let i = 38; i <= 42; i++) arr[i] = 195; // uniform origin line
      for (let i = 358; i <= 362; i++) arr[i] = 200; // uniform meniscus
      if (isMeas) {
        // Interior spot for Benzophenone shifted +0.15 Rf higher
        const midCenter = Math.round(40 + Math.min(0.84, midPredRf + 0.15) * 320);
        for (let dy = -7; dy <= 7; dy++) {
          const idx = midCenter + dy;
          if (idx > 48 && idx < 350) {
            arr[idx] = Math.min(arr[idx], Math.round(230 - 110 * Math.exp(-(dy * dy) / 14)));
          }
        }
        // Fast nonpolar band merged at the solvent front (340..361)
        for (let i = 340; i <= 361; i++) {
          arr[i] = Math.min(arr[i], Math.round(230 - 135 * Math.exp(-(((i - 354) / 7) ** 2))));
        }
      }
      prof1[`UV254:${laneId}:0.35`] = arr;
    }

    const plate1Set: TlcSet = {
      uid: 'set_front_sat',
      name: '25% EtOAc / Hexanes',
      cfg: { lanes: lanes1 },
      cfgName: 'front_sat',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
      prof: prof1,
    };

    const { model: model1 } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [plate1Set],
      cachedPredictions,
    });

    const fit1 = model1.byPhase.SiO2;
    expect(fit1).toBeDefined();
    expect(fit1!.frontCensoredCount).toBeGreaterThan(0);
    expect(fit1!.globalDemandShift).toBeLessThan(0);

    // Check lane diagnostic flags on well 0
    const lane0Comp = model1.plates[0].lanes[0];
    expect(lane0Comp.frontOccupied).toBe(true);
    expect(lane0Comp.predictedSpots.some((p) => p.boundaryStatus === 'front_saturated')).toBe(true);

    // Follow-up solvent recommender diagnoses front crowding in Plate 1 and recommends a weaker nonpolar solvent (< 0.28 strength)
    const followPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0,
      stationaryPhase: 'SiO2',
      cachedPredictions,
      calibration: model1,
    });

    expect(followPlan.followUpPlan).toBeDefined();
    expect(followPlan.followUpPlan!.summary.frontCrowdedWells).toContain(0);
    expect(followPlan.followUpPlan!.recommendations.length).toBeGreaterThanOrEqual(1);
    const topRec = followPlan.followUpPlan!.recommendations[0];
    expect(topRec.system.strength).toBeLessThan(sys25.strength);
    expect(topRec.rescuedFrontCount).toBeGreaterThan(0);

    // Now add a second measured rescue plate (e.g., 5% EtOAc / Hexanes) where spots resolve cleanly in the interior,
    // and verify iterative multi-plate calibration incorporates both plates.
    const sys5 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_5')!;
    const npRf5 = predictTlcRf(profileMoleculeForTlc(rdkit, smNonpolar), sys5).rf;
    const midRf5 = predictTlcRf(profileMoleculeForTlc(rdkit, smMid), sys5).rf;

    const lanes2 = lanes1.map((l) => ({ ...l }));
    const prof2: Record<string, number[]> = {};
    for (let laneId = 0; laneId < 54; laneId++) {
      const wellIdx = containerOfLane(laneId);
      prof2[`UV254:${laneId}:0.35`] =
        wellIdx < 8
          ? buildSyntheticPlateProfile([Math.max(0.15, midRf5 + 0.05), Math.min(0.84, npRf5 + 0.08)], 400, 40, 360)
          : buildSyntheticPlateProfile([], 400, 40, 360);
    }

    const plate2Set: TlcSet = {
      uid: 'set_rescue_5',
      name: '5% EtOAc / Hexanes',
      cfg: { lanes: lanes2 },
      cfgName: 'rescue5',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
      prof: prof2,
    };

    const { model: model2 } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [plate1Set, plate2Set],
      cachedPredictions,
    });

    expect(model2.plates.length).toBe(2);
    expect(model2.byPhase.SiO2!.pairedSpotCount).toBeGreaterThan(fit1!.pairedSpotCount);
    expect(model2.byPhase.SiO2!.rmseAfter).toBeLessThanOrEqual(model2.byPhase.SiO2!.rmseBefore + 0.01);
  });

  it('learns L2-regularized Ridge descriptor featureWeights on systematic structural bias without overfitting uniform shifts', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    // Diverse aromatic vs aliphatic reagent panel so standardized features have healthy variance
    const mols = [
      { code: 'A', name: 'Naphthylamide', smiles: 'CC(=O)Nc1ccc2ccccc2c1', aromBias: 0.17 },
      { code: 'B', name: 'Biphenylketone', smiles: 'O=C(c1ccccc1)c1ccc(-c2ccccc2)cc1', aromBias: 0.17 },
      { code: 'C', name: 'AnthraceneCarbaldehyde', smiles: 'O=Cc1c2ccccc2cc2ccccc12', aromBias: 0.18 },
      { code: 'D', name: 'CyclohexylPropionamide', smiles: 'CCC(=O)NC1CCCCC1', aromBias: -0.09 },
      { code: 'E', name: 'AdamantylAcetamide', smiles: 'CC(=O)NC12CC3CC(CC(C3)C1)C2', aromBias: -0.09 },
      { code: 'F', name: 'Octanamide', smiles: 'CCCCCCCC(=O)N(C)C', aromBias: -0.08 },
    ];
    state.reagents = mols.map((m) => ({
      code: m.code,
      name: m.name,
      smiles: m.smiles,
      molarMass: 200,
      density: 1.05,
      stock: 500,
      solvent: 'DMSO',
    }));

    const sys50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    // 18 single-substrate wells (3 replicates per molecule) so 18 >= 10 paired spots with strong aromatic-ring systematic offset
    const rows = Array.from({ length: 18 }, (_, w) => {
      const m = mols[w % mols.length];
      return {
        local_index: w,
        global_index: w,
        combo_index: w,
        plate_number: 0,
        container_id: w,
        recipe: [{ code: m.code, name: m.name, target_concentration: 50, equivalence: 1 }],
      };
    });
    const fakeRun = { plates: 1, reactions: 18, rows } as unknown as RunResult;

    const lanes = [];
    const prof: Record<string, number[]> = {};
    for (let laneId = 0; laneId < 54; laneId++) {
      const wellIdx = containerOfLane(laneId);
      lanes.push({
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
      });
      if (wellIdx < 18) {
        const m = mols[wellIdx % mols.length];
        const baseRf = predictTlcRf(profileMoleculeForTlc(rdkit, m.smiles), sys50).rf;
        const obsRf = Math.max(0.08, Math.min(0.9, baseRf + m.aromBias));
        prof[`UV254:${laneId}:0.35`] = buildSyntheticPlateProfile([obsRf], 400, 40, 360);
        prof[`White:${laneId}:0.35`] = buildSyntheticPlateProfile([obsRf], 400, 40, 360);
      } else {
        prof[`UV254:${laneId}:0.35`] = buildSyntheticPlateProfile([], 400, 40, 360);
        prof[`White:${laneId}:0.35`] = buildSyntheticPlateProfile([], 400, 40, 360);
      }
    }

    const measSet: TlcSet = {
      uid: 'set_ridge',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'ridge',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
      prof,
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measSet],
    });

    const fit = model.byPhase.SiO2;
    expect(fit).toBeDefined();
    expect(fit!.pairedSpotCount).toBe(18);
    expect(fit!.featureWeights).toBeDefined();
    // Aromatic rings elute higher than predicted (lower effective polarity demand -> negative weight on aromaticRings)
    expect(fit!.featureWeights!.aromaticRings).toBeLessThan(-0.004);
    expect(fit!.rmseAfter).toBeLessThan(fit!.rmseBefore);

    const calPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0,
      stationaryPhase: 'SiO2',
      calibration: model,
    });
    expect(calPlan.calibrationApplied?.hasFeatureWeights).toBe(true);
  });
});


