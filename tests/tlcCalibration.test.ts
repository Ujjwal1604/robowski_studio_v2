import { describe, it, expect, beforeAll } from 'vitest';
import {
  TLC_SOLVENT_LIBRARY,
  matchTlcSetNameToSolvent,
  calibrateTlcModelFromCampaign,
  optimizePlateTlcSolvents,
  predictTlcRf,
  profileMoleculeForTlc,
} from '../src/engine/predictor';
import { estimatePlateLevelDemandShift } from '../src/engine/predictor/tlcCalibration';
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

  it('recognizes Toluene / MeOH / (2M NH₃ in MeOH) (94:4:2), pencil-style ratios, and every advisor-synthesized / PRISMA ternary solvent name', async () => {
    const {
      CORE_ELUENT_SPECS,
      composeSolventSystem,
      generateExtendedDynamicSpecs,
      generatePrismaTernarySpecs,
      synthesizePlateTailoredSpecs,
    } = await import('../src/engine/predictor/solventSystemModel');

    // Exact regression case from user screenshot
    for (const tabName of [
      'Toluene / MeOH / (2M NH₃ in MeOH) (94:4:2)',
      'Toluene / MeOH / (2M NH3 in MeOH) (94:4:2)',
      'Toluene / MeOH / (2M NH₃ in MeOH) (94:4:2) (SiO₂)',
      '94:4:2 Toluene/MeOH/NH3',
      '94:4:2 Toluene:MeOH:NH3 in MeOH',
    ]) {
      const m = matchTlcSetNameToSolvent(tabName);
      expect(m, `Expected "${tabName}" to match`).not.toBeNull();
      expect(m!.system.composition?.weakSolvent).toBe('Toluene');
      expect(m!.system.composition?.strongSolvent).toBe('MeOH');
      expect(m!.system.composition?.strongPct).toBe(4);
      expect(m!.system.composition?.modifierId).toBe('nh3_meoh_2');
      expect(m!.system.alcoholPct).toBe(6); // 4% neat MeOH + 2% MeOH carrier from 2M NH3/MeOH
      expect(m!.system.baseModifier).toContain('NH₃');
      expect(m!.stationaryPhase).toBe('SiO2');
    }

    // Chemist plate-pencil shorthand
    const pencilNh3 = matchTlcSetNameToSolvent('95:3:2 DCM:MeOH:NH3 in MeOH');
    expect(pencilNh3?.system.id).toBe('nh3_meoh_dcm_5');
    expect(pencilNh3?.system.alcoholPct).toBe(5);

    const pencilEt3n = matchTlcSetNameToSolvent('DCM:MeOH:NEt3 94:5:1');
    expect(pencilEt3n?.system.id).toBe('meoh_dcm_5_et3n');
    expect(pencilEt3n?.system.baseModifier).toContain('Et₃N');

    const tolNh3Bin = matchTlcSetNameToSolvent('Toluene / (2M NH₃ in MeOH) (98:2)');
    expect(tolNh3Bin?.system.composition?.weakSolvent).toBe('Toluene');
    expect(tolNh3Bin?.system.alcoholPct).toBe(2);

    // Exhaustive round-trip invariant: EVERY advisor-generated system must be auto-recognized
    const allGeneratedSpecs = [
      ...CORE_ELUENT_SPECS,
      ...generateExtendedDynamicSpecs({
        hasStrongWellAcid: true,
        needsBasicMod: true,
        needsAcidMod: true,
        aromaticHeavyPlate: true,
      }),
    ];
    for (const flags of [
      { aromaticHeavyPlate: false, hasStrongWellAcid: false, maxAcidStress: 0, needsBasicMod: false, needsAcidMod: false },
      { aromaticHeavyPlate: true, hasStrongWellAcid: false, maxAcidStress: 0, needsBasicMod: true, needsAcidMod: false },
      { aromaticHeavyPlate: true, hasStrongWellAcid: true, maxAcidStress: 1.2, needsBasicMod: true, needsAcidMod: false },
      { aromaticHeavyPlate: true, hasStrongWellAcid: false, maxAcidStress: 0, needsBasicMod: false, needsAcidMod: true },
    ]) {
      const input = { targetStrengths: [0.12, 0.25, 0.38, 0.5, 0.62, 0.74], ...flags };
      allGeneratedSpecs.push(...synthesizePlateTailoredSpecs(input));
      allGeneratedSpecs.push(...generatePrismaTernarySpecs(input));
    }

    for (const spec of allGeneratedSpecs) {
      const sys = composeSolventSystem(spec);
      const byName = matchTlcSetNameToSolvent(sys.name);
      expect(byName, `Advisor system name "${sys.name}" (${sys.id}) was unrecognized`).not.toBeNull();
      expect(byName!.system.strength).toBeCloseTo(sys.strength, 2);
      expect(byName!.system.alcoholPct).toBe(sys.alcoholPct);
      expect(byName!.system.stationaryPhase).toBe(sys.stationaryPhase);
      expect(byName!.system.baseModifier).toBe(sys.baseModifier);
      expect(byName!.system.acidModifier).toBe(sys.acidModifier);

      const byShort = matchTlcSetNameToSolvent(sys.shortLabel);
      expect(byShort, `Advisor system shortLabel "${sys.shortLabel}" (${sys.id}) was unrecognized`).not.toBeNull();
      expect(byShort!.system.strength).toBeCloseTo(sys.strength, 2);
    }
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
    // Structures & compound identity keys must be preserved for Real TLC Matches inspection
    const firstLane = model.plates[0].lanes.find((l) => !l.isBlank && l.predictedSpots.length > 0);
    expect(firstLane).toBeDefined();
    expect(firstLane!.predictedSpots[0].smiles).toBeTruthy();
    expect(firstLane!.predictedSpots[0].compoundKey).toBeTruthy();
    expect(model.plates[0].compoundSummaries?.[0]?.smiles).toBeTruthy();
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
      { code: 'G', name: 'Acetonaphthone', smiles: 'CC(=O)c1cccc2ccccc12', aromBias: 0.17 },
      { code: 'H', name: 'Benzanilide', smiles: 'O=C(Nc1ccccc1)c1ccccc1', aromBias: 0.17 },
      { code: 'I', name: 'Valerylcyclopentylamide', smiles: 'CCCCC(=O)NC1CCCC1', aromBias: -0.09 },
      { code: 'J', name: 'Diethylisovaleramide', smiles: 'CC(C)CC(=O)N(CC)CC', aromBias: -0.08 },
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

    const sys25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    // 30 single-substrate wells (3 replicates of 10 distinct molecules): ridge needs >= 30 pairs and >= 8 distinct compounds
    const rows = Array.from({ length: 30 }, (_, w) => {
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
    const fakeRun = { plates: 1, reactions: 30, rows } as unknown as RunResult;

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
      if (wellIdx < 30) {
        const m = mols[wellIdx % mols.length];
        const baseRf = predictTlcRf(profileMoleculeForTlc(rdkit, m.smiles), sys25).rf;
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
      name: '25% EtOAc / Hexanes',
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
    expect(fit!.pairedSpotCount).toBe(30);
    expect(fit!.uniqueCompounds).toBe(10);
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

  it('reports distinct-compound count, held-out error and a floored sigma; repeated wells of one compound count once', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    // Diverse aromatic vs aliphatic reagent panel so standardized features have healthy variance
    const mols = [
      { code: 'A', name: 'Naphthylamide', smiles: 'CC(=O)Nc1ccc2ccccc2c1', aromBias: 0.1 },
      { code: 'B', name: 'Biphenylketone', smiles: 'O=C(c1ccccc1)c1ccc(-c2ccccc2)cc1', aromBias: 0.1 },
      { code: 'C', name: 'AnthraceneCarbaldehyde', smiles: 'O=Cc1c2ccccc2cc2ccccc12', aromBias: 0.1 },
      { code: 'D', name: 'CyclohexylPropionamide', smiles: 'CCC(=O)NC1CCCCC1', aromBias: 0.1 },
      { code: 'E', name: 'AdamantylAcetamide', smiles: 'CC(=O)NC12CC3CC(CC(C3)C1)C2', aromBias: 0.1 },
      { code: 'F', name: 'Octanamide', smiles: 'CCCCCCCC(=O)N(C)C', aromBias: 0.1 },
      { code: 'G', name: 'Acetonaphthone', smiles: 'CC(=O)c1cccc2ccccc12', aromBias: 0.1 },
      { code: 'H', name: 'Benzanilide', smiles: 'O=C(Nc1ccccc1)c1ccccc1', aromBias: 0.1 },
      { code: 'I', name: 'Valerylcyclopentylamide', smiles: 'CCCCC(=O)NC1CCCC1', aromBias: 0.1 },
      { code: 'J', name: 'Diethylisovaleramide', smiles: 'CC(C)CC(=O)N(CC)CC', aromBias: 0.1 },
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
    // 30 single-substrate wells (3 replicates of 10 distinct molecules): ridge needs >= 30 pairs and >= 8 distinct compounds
    const rows = Array.from({ length: 30 }, (_, w) => {
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
    const fakeRun = { plates: 1, reactions: 30, rows } as unknown as RunResult;

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
      if (wellIdx < 30) {
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
      uid: 'set_noise',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'noise',
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
    expect(fit!.uniqueCompounds).toBe(10);
    expect(fit!.validated).toBe(true);
    expect(fit!.cvRmse).toBeDefined();
    expect(fit!.calibrationApplied).toBe(true);
    // sigma never below the floor
    expect(fit!.calibratedSigma).toBeGreaterThanOrEqual(0.09);
    // 30 wells of 10 compounds: effective weight of the pairs is about one unit per compound, not per well
    const wSumPairs = model.plates[0].pairs.reduce((a, p) => a + p.weight, 0);
    expect(wSumPairs).toBeLessThanOrEqual(10.05);
  });
});

describe('plate-level distribution check', () => {
  it('detects a plate that runs far lower than predicted even when spots never pair or predictions clamp at 0.99', () => {
    const pred = Array.from({ length: 40 }, (_, i) => 0.88 + (i % 3) * 0.02); // predicted ~0.9
    const obs = Array.from({ length: 40 }, (_, i) => 0.6 + (i % 4) * 0.03); // measured ~0.65
    const est = estimatePlateLevelDemandShift(obs, pred, 6.2)!;
    expect(est.shift).toBeGreaterThan(0.15); // positive = runs lower than predicted
    const none = estimatePlateLevelDemandShift(pred, pred, 6.2)!;
    expect(Math.abs(none.shift)).toBeLessThan(0.05);

    // Worst-case over-prediction where all predicted Rfs clamp at 0.99
    const predClamped = Array.from({ length: 20 }, () => 0.99);
    const obsMid = Array.from({ length: 20 }, () => 0.6);
    const estClamped = estimatePlateLevelDemandShift(obsMid, predClamped, 6.2)!;
    expect(estClamped).not.toBeNull();
    expect(estClamped.shift).toBeGreaterThan(0.25);
  });

  it('stays silent with too little evidence', () => {
    expect(estimatePlateLevelDemandShift([0.5, 0.6], [0.9, 0.9], 6.2)).toBeNull();
  });

  it('ignores baseline-pinned predicted SMs (<= 0.05) so polar SMs cannot fabricate a giant upward Rf shift on a well-matched plate', () => {
    // 25 baseline-pinned polar SMs (0.02-0.04) + 15 interior mobile SMs (0.50-0.60); observed interior spots sit at 0.55-0.65 (+0.05 shift)
    const pred = [
      ...Array.from({ length: 25 }, () => 0.03),
      ...Array.from({ length: 15 }, (_, i) => 0.50 + (i % 3) * 0.04),
    ];
    const obs = Array.from({ length: 15 }, (_, i) => 0.55 + (i % 3) * 0.04);
    const est = estimatePlateLevelDemandShift(obs, pred, 6.2)!;
    expect(est).not.toBeNull();
    // True shift is only ~ -0.03 demand (+0.05 Rf), never the bogus -0.45 blow-up
    expect(Math.abs(est.shift)).toBeLessThan(0.08);
  });
});

describe('rigorous multi-plate validation, canonical grouping & 2D tailing feedback', () => {
  it('groups non-canonical SMILES duplicates as one compound, computes leave-one-plate-out plateCvRmse and per-family familyStats', () => {
    const state = exampleState();
    state.mode = 'concentration';
    // Include two non-canonical SMILES forms of Benzaldehyde ('O=Cc1ccccc1' and 'c1ccccc1C=O')
    const mols = [
      { code: 'A', name: 'Benzaldehyde-1', smiles: 'O=Cc1ccccc1' },
      { code: 'B', name: 'Benzaldehyde-2', smiles: 'c1ccccc1C=O' },
      { code: 'C', name: 'Acetophenone', smiles: 'CC(=O)c1ccccc1' },
      { code: 'D', name: '4-Nitroanisole', smiles: 'COc1ccc([N+](=O)[O-])cc1' },
      { code: 'E', name: 'Acetanilide', smiles: 'CC(=O)Nc1ccccc1' },
      { code: 'F', name: 'Benzamide', smiles: 'NC(=O)c1ccccc1' },
    ];
    state.reagents = mols.map((m) => ({
      code: m.code, name: m.name, smiles: m.smiles, molarMass: 135, density: 1.1, stock: 500, solvent: 'DMSO',
    }));
    const rows = mols.map((m, w) => ({
      local_index: w, global_index: w, combo_index: w, plate_number: 0, container_id: w,
      recipe: [{ code: m.code, name: m.name, target_concentration: 50, equivalence: 1 }],
    }));
    const fakeRun = { plates: 1, reactions: mols.length, rows } as unknown as RunResult;

    const makePlate = (uid: string, name: string, sysId: string, shiftRf: number): TlcSet => {
      const sys = TLC_SOLVENT_LIBRARY.find((s) => s.id === sysId)!;
      const lanes = Array.from({ length: 54 }, (_, laneId) => {
        const w = containerOfLane(laneId);
        const m = mols[w];
        const baseRf = m ? predictTlcRf(profileMoleculeForTlc(rdkit, m.smiles), sys).rf : 0;
        const obsRf = Math.max(0.10, Math.min(0.88, baseRf + shiftRf));
        return {
          id: laneId, x0: 10 + laneId * 20, y0: 0, x1: 10 + laneId * 20, y1: 400, width: 14, length: 400, zeroRf: 40,
          customSpots: m ? [{ pos: Math.round(40 + obsRf * 320), rf: obsRf, strength: 0.9, source: 'manual' as const }] : [],
        };
      });
      return { uid, name, cfg: { lanes }, cfgName: uid, frameW: LANE_FRAME_WIDTH, frontPx: 360, originPx: 40, imgs: {} };
    };

    const p1 = makePlate('p_ea', '50% EtOAc / Hexanes', 'etoac_hex_50', -0.14);
    const p2 = makePlate('p_meoh', '3% MeOH / DCM', 'meoh_dcm_3', -0.12);

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [p1, p2],
    });

    const fit = model.byPhase.SiO2!;
    expect(fit).toBeDefined();
    // 6 reagents but 2 are non-canonical duplicates of Benzaldehyde -> at most 5 distinct compounds
    expect(fit.uniqueCompounds).toBeLessThanOrEqual(5);
    expect(fit.plateCvRmse).toBeDefined();
    expect(fit.plateCvRmseBaseline).toBeDefined();
    expect(fit.plateCvRmse!).toBeLessThan(fit.plateCvRmseBaseline!);
    expect(fit.familyStats?.etoac_hex?.plateCount).toBe(1);
    expect(fit.familyStats?.meoh_dcm?.plateCount).toBe(1);
    expect(fit.familyStats?.etoac_hex?.pairedCount).toBeGreaterThan(0);
    expect(fit.familyStats?.meoh_dcm?.pairedCount).toBeGreaterThan(0);
  });

  it('feeds 2D measured tailing into followUpPlan rescue recommendations and tracks multi-plate progression', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    const smAmine = 'NCc1ccccc1';
    const smAld = 'O=Cc1ccc(O)cc1';
    const prodImine = 'Oc1ccc(C=NCc2ccccc2)cc1';
    state.reagents = [
      { code: 'A', name: 'Benzylamine', smiles: smAmine, molarMass: 107.15, density: 0.98, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: '4-Hydroxybenzaldehyde', smiles: smAld, molarMass: 122.12, density: 1.12, stock: 500, solvent: 'DMSO' },
    ];
    const rows = Array.from({ length: 4 }, (_, w) => ({
      local_index: w, global_index: w, combo_index: w, plate_number: 0, container_id: w,
      recipe: [
        { code: 'A', name: 'Benzylamine', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: '4-Hydroxybenzaldehyde', target_concentration: 50, equivalence: 1 },
      ],
    }));
    const fakeRun = { plates: 1, reactions: 4, rows } as unknown as RunResult;
    const cachedPredictions: Record<string, any> = {};
    for (let w = 0; w < 4; w++) {
      cachedPredictions[`0-${w}`] = {
        substrates: [
          { code: 'A', name: 'Benzylamine', neutralSmiles: smAmine, valid: true },
          { code: 'B', name: '4-Hydroxybenzaldehyde', neutralSmiles: smAld, valid: true },
        ],
        species: [
          { key: 'imine', tautomerKey: 'imine', smiles: prodImine, formula: 'C14H13NO', mechanismSummary: 'Imine adduct', tier: 'High', score: 0.9 },
        ],
      };
    }

    // Plate 1: unbuffered 50% EtOAc/Hexanes where the interior spot shows severe 2D measured tailing (tailing = 2.6)
    const lanesTailing = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      return {
        id: laneId, x0: 10 + laneId * 20, y0: 0, x1: 10 + laneId * 20, y1: 400, width: 14, length: 400, zeroRf: 40,
        customSpots:
          w < 4
            ? [
                { pos: 140, rf: 0.31, strength: 0.85, tailing: 2.6, widthFrac: 0.55, source: 'manual' as const },
                { pos: 245, rf: 0.64, strength: 0.9, tailing: 1.1, widthFrac: 0.45, source: 'manual' as const },
              ]
            : [],
      };
    });
    const tailingSet: TlcSet = {
      uid: 'set_tail', name: '50% EtOAc / Hexanes', cfg: { lanes: lanesTailing },
      cfgName: 'tail', frameW: LANE_FRAME_WIDTH, frontPx: 360, originPx: 40, imgs: {},
    };

    const { model: mTail } = calibrateTlcModelFromCampaign({
      rdkit, state, run: fakeRun, tlcSets: [tailingSet], cachedPredictions,
    });
    expect(mTail.plates[0].tailingLaneCount).toBe(4);
    expect(mTail.plates[0].lanes[0].measuredTailing).toBe(true);

    const plan1 = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0, stationaryPhase: 'SiO2', cachedPredictions, calibration: mTail,
    });
    expect(plan1.followUpPlan?.summary.tailingWells.length).toBe(4);
    expect(plan1.followUpPlan!.recommendations.length).toBeGreaterThanOrEqual(1);
    const rescueOpt = plan1.followUpPlan!.recommendations[0];
    expect(rescueOpt.rescuedTailingCount).toBeGreaterThan(0);
    expect(Boolean(rescueOpt.system.baseModifier) || rescueOpt.system.alcoholPct >= 5).toBe(true);

    // Plate 2: base-modified rescue plate resolves the 4 wells cleanly -> plateProgressionNote records the gain
    const sysRescue = rescueOpt.system;
    const prodRfR = predictTlcRf(profileMoleculeForTlc(rdkit, prodImine), sysRescue).rf;
    const smRfR = predictTlcRf(profileMoleculeForTlc(rdkit, smAmine), sysRescue).rf;
    const lanesClean = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      return {
        id: laneId, x0: 10 + laneId * 20, y0: 0, x1: 10 + laneId * 20, y1: 400, width: 14, length: 400, zeroRf: 40,
        customSpots:
          w < 4
            ? [
                { pos: Math.round(40 + smRfR * 320), rf: smRfR, strength: 0.85, tailing: 1.15, source: 'manual' as const },
                { pos: Math.round(40 + prodRfR * 320), rf: prodRfR, strength: 0.9, tailing: 1.1, source: 'manual' as const },
              ]
            : [],
      };
    });
    const cleanSet: TlcSet = {
      uid: 'set_clean', name: sysRescue.name, cfg: { lanes: lanesClean },
      cfgName: 'clean', frameW: LANE_FRAME_WIDTH, frontPx: 360, originPx: 40, imgs: {},
    };
    const { model: m2 } = calibrateTlcModelFromCampaign({
      rdkit, state, run: fakeRun, tlcSets: [tailingSet, cleanSet], cachedPredictions,
    });
    const plan2 = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0, stationaryPhase: 'SiO2', cachedPredictions, calibration: m2,
    });
    expect(plan2.followUpPlan?.summary.plateProgressionNote).toBeTruthy();
    expect(plan2.followUpPlan!.summary.resolvedWellCount).toBeGreaterThan(plan1.followUpPlan!.summary.resolvedWellCount);
  });
});

describe('Stage 1 plate-wide cross-well compound consensus matching', () => {
  it('locks a compound shifted by +0.30 Rf (beyond single-well ±0.24 cutoff) when confirmed across its wells and absent elsewhere', () => {
    const state = exampleState();
    state.mode = 'concentration';

    const mols = [
      { code: 'A', name: 'Shifted Benzamide', smiles: 'NC(=O)c1ccccc1' },
      { code: 'B', name: 'Acetanilide', smiles: 'CC(=O)Nc1ccccc1' },
      { code: 'C', name: 'Acetophenone', smiles: 'CC(=O)c1ccccc1' },
      { code: 'D', name: 'Methyl benzoate', smiles: 'COC(=O)c1ccccc1' },
    ];
    state.reagents = mols.map((m) => ({
      code: m.code,
      name: m.name,
      smiles: m.smiles,
      molarMass: 140,
      density: 1.1,
      stock: 500,
      solvent: 'DMSO',
    }));

    const sys25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const predRfByCode = new Map<string, number>(
      mols.map((m) => [m.code, predictTlcRf(profileMoleculeForTlc(rdkit, m.smiles), sys25).rf])
    );

    // Observed Rf for A is +0.32 Rf above its raw prediction (strictly outside ±0.24 per-well gate)
    const predA = predRfByCode.get('A')!;
    const obsA = Math.min(0.86, predA + 0.32);
    expect(Math.abs(obsA - predA)).toBeGreaterThan(0.28);

    // 24 wells: wells 0..9 contain A (+ B in 0..4, + C in 5..9); wells 10..23 do NOT contain A
    const rows = Array.from({ length: 24 }, (_, w) => {
      const recipe =
        w < 5
          ? [
              { code: 'A', name: mols[0].name, target_concentration: 50, equivalence: 1 },
              { code: 'B', name: mols[1].name, target_concentration: 50, equivalence: 1 },
            ]
          : w < 10
          ? [
              { code: 'A', name: mols[0].name, target_concentration: 50, equivalence: 1 },
              { code: 'C', name: mols[2].name, target_concentration: 50, equivalence: 1 },
            ]
          : w < 17
          ? [
              { code: 'B', name: mols[1].name, target_concentration: 50, equivalence: 1 },
              { code: 'D', name: mols[3].name, target_concentration: 50, equivalence: 1 },
            ]
          : [
              { code: 'C', name: mols[2].name, target_concentration: 50, equivalence: 1 },
              { code: 'D', name: mols[3].name, target_concentration: 50, equivalence: 1 },
            ];
      return {
        local_index: w,
        global_index: w,
        combo_index: w,
        plate_number: 0,
        container_id: w,
        recipe,
      };
    });
    const fakeRun = { plates: 1, reactions: 24, rows } as unknown as RunResult;

    const lanes = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      const r = rows[w];
      const spots: Array<{ pos: number; rf: number; strength: number; source: 'manual' }> = [];
      if (r) {
        for (const item of r.recipe) {
          const rf =
            item.code === 'A'
              ? obsA + ((w % 3) - 1) * 0.008
              : Math.max(0.08, Math.min(0.88, predRfByCode.get(item.code)! + 0.02));
          spots.push({
            pos: Math.round(40 + rf * 320),
            rf,
            strength: 0.9,
            source: 'manual',
          });
        }
      }
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots: spots,
      };
    });

    const measSet: TlcSet = {
      uid: 'set_consensus_shift',
      name: '25% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'consensus_shift',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measSet],
    });

    const fit = model.byPhase.SiO2!;
    expect(fit).toBeDefined();
    expect(fit.consensusCompoundCount).toBeGreaterThanOrEqual(1);

    const plate = model.plates[0];
    expect(plate.consensusMatchCount).toBeGreaterThanOrEqual(10);
    const summaryA = plate.compoundSummaries?.find((c) => c.label.includes('Shifted Benzamide'));
    expect(summaryA).toBeDefined();
    expect(summaryA!.matchMethod).toBe('consensus');
    expect(summaryA!.wellsMatched).toBe(10);
    expect(summaryA!.wellsPresent).toBe(10);
    expect(summaryA!.observedRfMean).toBeCloseTo(obsA, 1);
    expect(summaryA!.rfShift).toBeGreaterThan(0.25);

    const phaseSummaryA = fit.compoundSummaries?.find((c) => c.label.includes('Shifted Benzamide'));
    expect(phaseSummaryA?.matchMethod).toBe('consensus');
  });

  it('tolerates partial reaction conversion (60% wells retaining SM) and rejects random uncorrelated spots', () => {
    const state = exampleState();
    state.mode = 'concentration';

    const mols = [
      { code: 'A', name: 'Partial-Conv Amide', smiles: 'NC(=O)c1ccccc1' },
      { code: 'B', name: 'Random-Only Ester', smiles: 'COC(=O)c1ccc(O)cc1' },
      { code: 'C', name: 'Reference Ketone', smiles: 'CC(=O)c1ccccc1' },
    ];
    state.reagents = mols.map((m) => ({
      code: m.code,
      name: m.name,
      smiles: m.smiles,
      molarMass: 140,
      density: 1.1,
      stock: 500,
      solvent: 'DMSO',
    }));

    const sys50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const predA = predictTlcRf(profileMoleculeForTlc(rdkit, mols[0].smiles), sys50).rf;
    const predC = predictTlcRf(profileMoleculeForTlc(rdkit, mols[2].smiles), sys50).rf;
    const obsA = Math.min(0.84, predA + 0.30);

    const rows = Array.from({ length: 20 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe:
        w < 10
          ? [
              { code: 'A', name: mols[0].name, target_concentration: 50, equivalence: 1 },
              { code: 'C', name: mols[2].name, target_concentration: 50, equivalence: 1 },
            ]
          : [
              { code: 'B', name: mols[1].name, target_concentration: 50, equivalence: 1 },
              { code: 'C', name: mols[2].name, target_concentration: 50, equivalence: 1 },
            ],
    }));
    const fakeRun = { plates: 1, reactions: 20, rows } as unknown as RunResult;

    const lanes = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      const spots: Array<{ pos: number; rf: number; strength: number; source: 'manual' }> = [];
      if (w < 20) {
        spots.push({ pos: Math.round(40 + predC * 320), rf: predC, strength: 0.9, source: 'manual' });
        if (w < 6) {
          spots.push({ pos: Math.round(40 + obsA * 320), rf: obsA, strength: 0.85, source: 'manual' });
        }
        if (w % 2 === 0) {
          spots.push({ pos: Math.round(40 + 0.19 * 320), rf: 0.19, strength: 0.7, source: 'manual' });
        }
      }
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots: spots,
      };
    });

    const measSet: TlcSet = {
      uid: 'set_partial_conv',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'partial_conv',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measSet],
    });

    const plate = model.plates[0];
    const summaryA = plate.compoundSummaries?.find((c) => c.label.includes('Partial-Conv Amide'));
    expect(summaryA).toBeDefined();
    expect(summaryA!.matchMethod).toBe('consensus');
    expect(summaryA!.wellsMatched).toBe(6);
    expect(summaryA!.wellsPresent).toBe(10);

    const summaryB = plate.compoundSummaries?.find((c) => c.label.includes('Random-Only Ester'));
    expect(summaryB?.matchMethod).not.toBe('consensus');
  });

  it('models 6-membered intramolecular H-bonding so 2-hydroxyacetophenone predicts ~0.65-0.75 in 25% EtOAc/Hex while 4-hydroxyacetophenone stays polar', () => {
    const sys25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const orthoProf = profileMoleculeForTlc(rdkit, 'CC(=O)c1ccccc1O'); // 2'-hydroxyacetophenone
    const paraProf = profileMoleculeForTlc(rdkit, 'CC(=O)c1ccc(O)cc1'); // 4'-hydroxyacetophenone

    expect(orthoProf.intraHbondOhCount).toBe(1);
    expect(paraProf.intraHbondOhCount).toBe(0);

    const orthoRf = predictTlcRf(orthoProf, sys25).rf;
    const paraRf = predictTlcRf(paraProf, sys25).rf;
    expect(orthoRf).toBeGreaterThan(0.60);
    expect(orthoRf).toBeLessThan(0.80);
    expect(orthoRf - paraRf).toBeGreaterThan(0.18);
  });

  it('locks a universal shifted substrate (+0.30 Rf) on a plate with dark origin spots and never assigns 6 sparse Rf 0.55 spots to it', () => {
    const state = exampleState();
    state.mode = 'concentration';

    // Use 4'-hydroxyacetophenone (predicted ~0.40 in 25% EtOAc/Hex) + polar origin-pinned partner (Benzamide/benzoic acid)
    // Simulate a universal substrate present in ALL 24 wells running at Rf 0.70, dark origin deposits on every lane,
    // plus 6 sparse product spots at Rf 0.55 (and a hypothetical predicted product near 0.70).
    const smShifted = 'CC(=O)c1ccc(O)cc1'; // predicted ~0.40 in 25% EtOAc/Hex
    const smPolar = 'O=C(O)c1ccc(N)cc1'; // polar origin-pinned partner
    const prodSpeculative = 'COc1ccc(C(C)=O)cc1'; // speculative nonpolar product near 0.68

    state.reagents = [
      { code: 'A', name: 'Universal Ketone', smiles: smShifted, molarMass: 136, density: 1.1, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: 'Polar Partner', smiles: smPolar, molarMass: 137, density: 1.1, stock: 500, solvent: 'DMSO' },
    ];

    const rows = Array.from({ length: 24 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: 'Universal Ketone', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Polar Partner', target_concentration: 50, equivalence: 1 },
      ],
    }));
    const fakeRun = { plates: 1, reactions: 24, rows } as unknown as RunResult;

    const cachedPredictions: Record<string, any> = {};
    for (let w = 0; w < 24; w++) {
      cachedPredictions[`0-${w}`] = {
        substrates: [
          { code: 'A', name: 'Universal Ketone', neutralSmiles: smShifted, valid: true },
          { code: 'B', name: 'Polar Partner', neutralSmiles: smPolar, valid: true },
        ],
        species: [
          {
            key: 'spec_prod',
            tautomerKey: 'spec_prod',
            smiles: prodSpeculative,
            formula: 'C9H10O2',
            mechanismSummary: 'Speculative High-Rf Product',
            tier: 'High',
            score: 0.8,
          },
        ],
      };
    }

    const lanes = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      const spots: Array<{ pos: number; rf: number; strength: number; source: 'manual' }> = [];
      if (w < 24) {
        // Dark origin deposit on every lane (Rf 0.02)
        spots.push({ pos: 46, rf: 0.02, strength: 0.95, source: 'manual' });
        // Universal Rf 0.70 band present in 22/24 wells (2 wells consumed)
        if (w < 22) {
          const rf70 = 0.70 + ((w % 3) - 1) * 0.012;
          spots.push({ pos: Math.round(40 + rf70 * 320), rf: rf70, strength: 0.9, source: 'manual' });
        }
        // Sparse Rf 0.55 spots in ONLY 6 wells (including the 2 consumed wells!)
        if (w < 4 || w >= 22) {
          spots.push({ pos: Math.round(40 + 0.55 * 320), rf: 0.55, strength: 0.75, source: 'manual' });
        }
      }
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots: spots,
      };
    });

    const measSet: TlcSet = {
      uid: 'set_univ_origin_sparse',
      name: '25% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'univ_origin_sparse',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measSet],
      cachedPredictions,
    });

    const plate = model.plates[0];
    const summaryA = plate.compoundSummaries?.find((c) => c.label.includes('Universal Ketone'));
    expect(summaryA).toBeDefined();
    expect(summaryA!.matchMethod).toBe('consensus');
    // Must match the 22 wells at Rf ~0.70, NOT the 6 sparse Rf 0.55 spots (and NOT steal 0.55 in the 2 consumed wells!)
    expect(summaryA!.wellsMatched).toBe(22);
    expect(summaryA!.observedRfMean).toBeCloseTo(0.70, 1);
  });

  it('never marks BOTH a starting material and a co-eluting predicted product as Found from a single real TLC spot', () => {
    const state = exampleState();
    state.mode = 'concentration';
    // Choose a polar acid SM and a closely co-eluting polar product (within ΔRf <= 0.05) in 50% EtOAc/Hexanes
    const smSmiles = 'O=C(O)c1ccc(Br)cc1N'; // 5-bromoanthranilic acid (low Rf)
    const prodSmiles = 'O=C(O)c1ccc(Cl)cc1N'; // 5-chloroanthranilic acid (nearly identical Rf!)
    state.reagents = [
      {
        code: 'A',
        name: '5-Bromoanthranilic acid',
        smiles: smSmiles,
        molarMass: 216.03,
        density: 1.5,
        stock: 500,
        solvent: 'DMSO',
      },
    ];

    const sys50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const smRf = predictTlcRf(profileMoleculeForTlc(rdkit, smSmiles)!, sys50).rf;
    const prodRf = predictTlcRf(profileMoleculeForTlc(rdkit, prodSmiles)!, sys50).rf;
    expect(Math.abs(smRf - prodRf)).toBeLessThan(0.05);

    const rows = [
      {
        local_index: 0,
        global_index: 0,
        combo_index: 0,
        plate_number: 0,
        container_id: 0,
        recipe: [{ code: 'A', name: '5-Bromoanthranilic acid', target_concentration: 50, equivalence: 1 }],
      },
    ];
    const fakeRun = { plates: 1, reactions: 1, rows } as unknown as RunResult;

    const cachedPredictions: any = {
      '0-0': {
        substrates: [{ code: 'A', name: '5-Bromoanthranilic acid', neutralSmiles: smSmiles, valid: true }],
        species: [
          {
            key: 'prod_coelute',
            tautomerKey: 'prod_coelute',
            smiles: prodSmiles,
            formula: 'C7H6ClNO2',
            mechanismSummary: 'Co-eluting Predicted Product',
            tier: 'Medium',
            score: 0.7,
          },
        ],
      },
    };

    // Real lane has ONLY ONE observed spot at Rf 0.07 (matching the user's exact scenario!)
    const obsRf = Math.max(0.07, Math.min(0.85, smRf + 0.04));
    const lanes = Array.from({ length: 54 }, (_, laneId) => ({
      id: laneId,
      x0: 10 + laneId * 20,
      y0: 0,
      x1: 10 + laneId * 20,
      y1: 400,
      width: 14,
      length: 400,
      zeroRf: 40,
      customSpots:
        containerOfLane(laneId) === 0
          ? [{ pos: Math.round(40 + obsRf * 320), rf: obsRf, strength: 0.85, source: 'manual' as const }]
          : [],
    }));

    const measSet: TlcSet = {
      uid: 'set_coelute_single',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes },
      cfgName: 'coelute_single',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [measSet],
      cachedPredictions,
    });

    const w0 = model.plates[0].lanes[0];
    const smPred = w0.predictedSpots.find((p) => p.kind === 'substrate');
    const prodPred = w0.predictedSpots.find((p) => p.kind === 'product');
    expect(smPred).toBeDefined();
    expect(prodPred).toBeDefined();

    // Neither should claim unambiguous "found" on a single ambiguous per-well spot — BOTH are co-eluting!
    expect(smPred!.boundaryStatus).toBe('coeluted');
    expect(smPred!.found).toBe(false);
    expect(smPred!.coelutedWith).toContain('Co-eluting Predicted Product');

    expect(prodPred!.boundaryStatus).toBe('coeluted');
    expect(prodPred!.found).toBe(false);
    expect(prodPred!.coelutedWith).toContain('5-Bromoanthranilic acid');

    // Measured spot carries the co-elution overlap label
    expect(w0.measuredSpots[0].coelutedLabels).toContain('Co-eluting Predicted Product');
  });

  it('flags cross-plate contradictions when a product appears on System A in one well and only on System B in another, while preserving legitimate boundary complementarity', () => {
    const state = exampleState();
    state.mode = 'concentration';

    const smSmiles = 'CC(=O)Nc1ccccc1'; // Acetanilide (reference SM present in both wells, stays below 0.92 front)
    const prodMidSmiles = 'NC(=O)c1ccccc1'; // Benzamide (elutes cleanly mid-plate on both 25% EtOAc/Hex & 3% MeOH/DCM)
    const prodPolarSmiles = 'NC(=O)c1cc(O)c(O)cc1'; // 3,4-Dihydroxybenzamide (pinned at baseline on 25% EtOAc/Hex, mobile on 3% MeOH/DCM)

    state.reagents = [
      {
        code: 'A',
        name: 'Acetanilide',
        smiles: smSmiles,
        molarMass: 135.17,
        density: 1.22,
        stock: 500,
        solvent: 'DMSO',
      },
    ];

    const rows = [0, 1].map((w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [{ code: 'A', name: 'Acetanilide', target_concentration: 50, equivalence: 1 }],
    }));
    const fakeRun = { plates: 1, reactions: 2, rows } as unknown as RunResult;

    const cachedPredictions: Record<string, any> = {};
    for (const w of [0, 1]) {
      cachedPredictions[`0-${w}`] = {
        substrates: [{ code: 'A', name: 'Acetanilide', neutralSmiles: smSmiles, valid: true }],
        species: [
          {
            key: 'prod_conflict',
            tautomerKey: 'prod_conflict',
            smiles: prodMidSmiles,
            formula: 'C7H7NO',
            mechanismSummary: 'Mid-Polarity Product',
            tier: 'High',
            score: 0.9,
          },
          {
            key: 'prod_polar',
            tautomerKey: 'prod_polar',
            smiles: prodPolarSmiles,
            formula: 'C7H7NO3',
            mechanismSummary: 'Polar Amide Product',
            tier: 'Medium',
            score: 0.75,
          },
        ],
      };
    }

    const sysA = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const sysB = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;

    const smRfA = predictTlcRf(profileMoleculeForTlc(rdkit, smSmiles)!, sysA).rf;
    const prodMidRfA = predictTlcRf(profileMoleculeForTlc(rdkit, prodMidSmiles)!, sysA).rf;
    const prodPolarRfA = predictTlcRf(profileMoleculeForTlc(rdkit, prodPolarSmiles)!, sysA).rf;

    const smRfB = predictTlcRf(profileMoleculeForTlc(rdkit, smSmiles)!, sysB).rf;
    const prodMidRfB = predictTlcRf(profileMoleculeForTlc(rdkit, prodMidSmiles)!, sysB).rf;
    const prodPolarRfB = predictTlcRf(profileMoleculeForTlc(rdkit, prodPolarSmiles)!, sysB).rf;

    // Sanity: Polar Amide Product is baseline-pinned on 25% EtOAc/Hex and mid-plate on 3% MeOH/DCM,
    // while Mid-Polarity Product elutes cleanly inside the interior on both plates without co-eluting with SM.
    expect(prodPolarRfA).toBeLessThanOrEqual(0.08);
    expect(prodPolarRfB).toBeGreaterThan(0.12);
    expect(prodMidRfA).toBeGreaterThan(0.15);
    expect(prodMidRfA).toBeLessThan(0.85);
    expect(prodMidRfB).toBeGreaterThan(0.15);
    expect(prodMidRfB).toBeLessThan(0.85);
    expect(smRfB).toBeLessThan(0.92);

    // Plate A (25% EtOAc/Hexanes):
    // - Well 0: SM present + Mid-Polarity Product spot present + origin spot for Polar Amide Product
    // - Well 1: SM present ONLY (Mid-Polarity Product ABSENT on Plate A!)
    const lanesA = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      const spots: Array<{ pos: number; rf: number; strength: number; source: 'manual' }> = [];
      if (w === 0) {
        spots.push({ pos: Math.round(40 + smRfA * 320), rf: smRfA, strength: 0.9, source: 'manual' });
        spots.push({ pos: Math.round(40 + prodMidRfA * 320), rf: prodMidRfA, strength: 0.85, source: 'manual' });
        spots.push({ pos: 45, rf: 0.02, strength: 0.8, source: 'manual' }); // origin deposit -> baseline_pinned
      } else if (w === 1) {
        spots.push({ pos: Math.round(40 + smRfA * 320), rf: smRfA, strength: 0.9, source: 'manual' });
      }
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots: spots,
      };
    });

    // Plate B (3% MeOH/DCM):
    // - Well 0: SM present + Polar Amide Product cleanly resolved (Mid-Polarity Product ABSENT on Plate B!)
    // - Well 1: SM present + Mid-Polarity Product spot present
    const lanesB = Array.from({ length: 54 }, (_, laneId) => {
      const w = containerOfLane(laneId);
      const spots: Array<{ pos: number; rf: number; strength: number; source: 'manual' }> = [];
      if (w === 0) {
        spots.push({ pos: Math.round(40 + smRfB * 320), rf: smRfB, strength: 0.9, source: 'manual' });
        spots.push({ pos: Math.round(40 + prodPolarRfB * 320), rf: prodPolarRfB, strength: 0.85, source: 'manual' });
      } else if (w === 1) {
        spots.push({ pos: Math.round(40 + smRfB * 320), rf: smRfB, strength: 0.9, source: 'manual' });
        spots.push({ pos: Math.round(40 + prodMidRfB * 320), rf: prodMidRfB, strength: 0.85, source: 'manual' });
      }
      return {
        id: laneId,
        x0: 10 + laneId * 20,
        y0: 0,
        x1: 10 + laneId * 20,
        y1: 400,
        width: 14,
        length: 400,
        zeroRf: 40,
        customSpots: spots,
      };
    });

    const setA: TlcSet = {
      uid: 'set_conflict_a',
      name: '50% EtOAc / Hexanes',
      cfg: { lanes: lanesA },
      cfgName: 'conflict_a',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };
    const setB: TlcSet = {
      uid: 'set_conflict_b',
      name: '7% MeOH / DCM',
      cfg: { lanes: lanesB },
      cfgName: 'conflict_b',
      frameW: LANE_FRAME_WIDTH,
      frontPx: 360,
      originPx: 40,
      imgs: {},
    };

    const { model } = calibrateTlcModelFromCampaign({
      rdkit,
      state,
      run: fakeRun,
      tlcSets: [setA, setB],
      cachedPredictions,
    });

    const plateA = model.plates.find((p) => p.setUid === 'set_conflict_a')!;
    const plateB = model.plates.find((p) => p.setUid === 'set_conflict_b')!;

    // 1. Mid-Polarity Product: found on Plate A in Well 0 (absent on B) & on Plate B in Well 1 (absent on A)
    //    -> BOTH single-plate hits are physically contradictory and MUST be downgraded to 'inconsistent'!
    const midWell0PlateA = plateA.lanes[0].predictedSpots.find((p) => p.label === 'Mid-Polarity Product')!;
    const midWell1PlateB = plateB.lanes[1].predictedSpots.find((p) => p.label === 'Mid-Polarity Product')!;
    expect(midWell0PlateA.boundaryStatus).toBe('inconsistent');
    expect(midWell0PlateA.found).toBe(false);
    expect(midWell0PlateA.conflictPlates).toContain(plateB.matchedSystemName);

    expect(midWell1PlateB.boundaryStatus).toBe('inconsistent');
    expect(midWell1PlateB.found).toBe(false);
    expect(midWell1PlateB.conflictPlates).toContain(plateA.matchedSystemName);

    // 2. Polar Amide Product in Well 0: pinned at baseline on 25% EtOAc/Hex AND cleanly resolved on 50% EtOAc/Hex
    //    -> Legitimate cross-plate complementarity! Must STAY 'found' on Plate B!
    const polarWell0PlateA = plateA.lanes[0].predictedSpots.find((p) => p.label === 'Polar Amide Product')!;
    const polarWell0PlateB = plateB.lanes[0].predictedSpots.find((p) => p.label === 'Polar Amide Product')!;
    expect(polarWell0PlateA.boundaryStatus).toBe('baseline_pinned');
    expect(polarWell0PlateB.boundaryStatus).toBe('found');
    expect(polarWell0PlateB.found).toBe(true);
    expect(polarWell0PlateB.conflictPlates).toBeUndefined();

    // 3. Starting material Acetophenone: present in BOTH wells on BOTH plates -> stays cleanly 'found'
    const smWell0PlateA = plateA.lanes[0].predictedSpots.find((p) => p.kind === 'substrate')!;
    const smWell0PlateB = plateB.lanes[0].predictedSpots.find((p) => p.kind === 'substrate')!;
    expect(smWell0PlateA.boundaryStatus).toBe('found');
    expect(smWell0PlateB.boundaryStatus).toBe('found');
  });
});




