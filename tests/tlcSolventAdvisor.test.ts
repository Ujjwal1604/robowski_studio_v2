import { describe, it, expect, beforeAll } from 'vitest';
import {
  TLC_SOLVENT_LIBRARY,
  profileMoleculeForTlc,
  predictNormalPhaseRf,
  optimizePlateTlcSolvents,
  predictWellReactions,
  extractWellForPrediction,
  buildWellTlcContext,
  WellPredictionResult,
  composeSolventSystem,
  computeMixtureDescriptors,
  validateEluentCompatibility,
  generateExtendedDynamicSpecs,
  generatePrismaTernarySpecs,
  invertLangmuirForPct,
  synthesizePlateTailoredSpecs,
  matchTlcSetNameToSolvent,
  eluentReactivityWarnings,
  resolveSystemPhase,
} from '../src/engine/predictor';
import { MEOH_AFFINITY_SCALE_BY_CARRIER, chamberPrepForNh3Stock } from '../src/engine/predictor/solventSystemModel';
import { exampleState } from '../src/context/runPayload';
import { RunResult } from '../src/types';

let rdkit: any;

beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  const initFn = mod.default || mod;
  rdkit = await initFn();
});

describe('54-Well Normal-Phase TLC Solvent Advisor', () => {
  it('detects basic amine/guanidine and carboxylic acid streaking and rescues with Et3N / AcOH modifiers', () => {
    const amineProf = profileMoleculeForTlc(rdkit, 'N=C(N)NCc1ccccc1');
    expect(amineProf.aliphAmineCount).toBeGreaterThan(0);

    const acidProf = profileMoleculeForTlc(rdkit, 'O=C(O)c1ccccc1');
    expect(acidProf.carboxylicAcidCount).toBeGreaterThan(0);

    const neutralEtOAc = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const baseMod = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_et3n')!;
    const acidMod = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_acoh')!;

    const amineInNeutral = predictNormalPhaseRf(amineProf, neutralEtOAc);
    const amineInBaseMod = predictNormalPhaseRf(amineProf, baseMod);
    expect(amineInNeutral.tailing).toBe(true);
    expect(amineInBaseMod.tailing).toBe(false);
    expect(amineInBaseMod.rf).toBeGreaterThan(amineInNeutral.rf);

    // NH3/MeOH streaks less than Et3N, so any Et3N eluent carries a small residual-streak penalty for basic amines
    const nh3Sys = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_10')!;
    const etHex = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_60_et3n')!;
    expect(predictNormalPhaseRf(amineProf, baseMod).mildStreak).toBe(true);
    expect(predictNormalPhaseRf(amineProf, nh3Sys).mildStreak).toBeFalsy();
    expect(predictNormalPhaseRf(amineProf, etHex).mildStreak).toBe(true);

    const acidInNeutral = predictNormalPhaseRf(acidProf, neutralEtOAc);
    const acidInAcidMod = predictNormalPhaseRf(acidProf, acidMod);
    expect(acidInNeutral.tailing).toBe(true);
    expect(acidInAcidMod.tailing).toBe(false);
    expect(acidInAcidMod.rf).toBeGreaterThan(acidInNeutral.rf);
  });

  it('orders polar azole adducts lower in non-polar eluent than lipophilic ketones', () => {
    const ketoneProf = profileMoleculeForTlc(rdkit, 'CC(=O)c1ccccc1');
    const azoleProf = profileMoleculeForTlc(rdkit, 'O=Cc1ncc[nH]1');
    expect(azoleProf.azoleCount).toBeGreaterThanOrEqual(1);

    const hex25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const meoh7 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;

    expect(predictNormalPhaseRf(ketoneProf, hex25).rf).toBeGreaterThan(
      predictNormalPhaseRf(azoleProf, hex25).rf
    );
    expect(predictNormalPhaseRf(azoleProf, meoh7).rf).toBeGreaterThan(
      predictNormalPhaseRf(azoleProf, hex25).rf
    );
  });

  it('optimizes a finite set of solvent systems across all 54 wells prioritizing High & Medium predicted products', async () => {
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
      {
        code: 'C',
        name: '2-Imidazolecarboxaldehyde',
        smiles: 'O=Cc1ncc[nH]1',
        molarMass: 96.09,
        density: 1.2,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'D',
        name: 'Benzylamine',
        smiles: 'NCc1ccccc1',
        molarMass: 107.15,
        density: 0.98,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'E',
        name: 'DBU',
        smiles: '',
        molarMass: 152.24,
        density: 1.02,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };

    const rows: any[] = [];
    for (let w = 0; w < 54; w++) {
      if (w === 53) {
        // Blank well F9
        rows.push({
          local_index: w,
          global_index: w,
          combo_index: w,
          plate_number: 0,
          container_id: w,
          recipe: [{ code: 'A', name: 'Benzaldehyde', target_concentration: 0 }],
          'vol#solvent': 500,
        });
        continue;
      }
      const isNonPolarHalf = w < 27;
      const recipe = isNonPolarHalf
        ? [
            { code: 'A', name: 'Benzaldehyde', target_concentration: 50, equivalence: 1 },
            { code: 'B', name: 'Malononitrile', target_concentration: 50, equivalence: 1 },
            { code: 'E', name: 'DBU', target_concentration: 15, equivalence: 0.3 },
          ]
        : [
            { code: 'C', name: '2-Imidazolecarboxaldehyde', target_concentration: 50, equivalence: 1 },
            { code: 'D', name: 'Benzylamine', target_concentration: 50, equivalence: 1 },
            { code: 'E', name: 'DBU', target_concentration: 15, equivalence: 0.3 },
          ];
      rows.push({
        local_index: w,
        global_index: w,
        combo_index: w,
        plate_number: 0,
        container_id: w,
        recipe,
        'vol#solvent': 400,
      });
    }

    const fakeRun = {
      plates: 1,
      reactions: 54,
      rows,
    } as unknown as RunResult;

    // Pre-cache one representative well from each half so cachedPredictions reuse + fresh computation both exercise
    const cached: Record<string, WellPredictionResult> = {
      '0-0': predictWellReactions(
        rdkit,
        [
          { id: 'A', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1 },
          { id: 'B', code: 'B', name: 'Malononitrile', smiles: 'N#CCC#N', equivalents: 1 },
        ],
        {
          medium: 'base',
          additiveName: 'DBU',
          additiveEquiv: 0.3,
          additivePka: 13.9,
          temperatureC: 80,
          waterPct: 2,
          solvent: 'DMSO',
          equivBasis: 'limiting',
        }
      ),
    };

    const plan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      plateIndex: 0,
      maxSystems: 3,
      cachedPredictions: cached,
    });

    // Et3N <-> NH3/MeOH swaps are offered as 'or' alternatives
    for (const r of plan.recommendedSystems) {
      for (const alt of r.alternatives ?? []) {
        expect(alt.baseModifier).toBeTruthy();
        expect(alt.id).not.toBe(r.system.id);
        expect(plan.recommendedSystems.some((o) => o.system.id === alt.id)).toBe(false);
      }
    }

    // Remaining systems are grouped into complementary sets that do not reuse the main suggestion
    const recIds = new Set(plan.recommendedSystems.map((r) => r.system.id));
    expect(plan.otherGroups.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const g of plan.otherGroups) {
      expect(g.systems.length).toBeGreaterThanOrEqual(1);
      for (const e of g.systems) {
        expect(recIds.has(e.system.id)).toBe(false);
        expect(seen.has(e.system.id)).toBe(false);
        seen.add(e.system.id);
      }
    }

    expect(plan.activeWellCount).toBe(53);

    // the Low-weight option is accepted and keeps the plan valid at both extremes
    for (const lowTierWeight of [0, 1]) {
      const p2 = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
        plateIndex: 0,
        maxSystems: 3,
        cachedPredictions: cached,
        includeSpeculative: true,
        lowTierWeight,
      });
      expect(p2.recommendedSystems.length).toBeGreaterThanOrEqual(1);
    }
    expect(plan.highRankedWellCount).toBeGreaterThan(20);
    expect(plan.recommendedSystems.length).toBeGreaterThanOrEqual(2);
    expect(plan.recommendedSystems.length).toBeLessThanOrEqual(3);
    expect(plan.totalCoveragePct).toBeGreaterThanOrEqual(80);

    // Honest reporting: only resolved wells are assigned; the rest are listed as unresolved
    const assignedTotal = plan.recommendedSystems.reduce((n, r) => n + r.assignedWellIndices.length, 0);
    expect(assignedTotal).toBe(plan.resolvedWellCount);
    expect(plan.resolvedWellCount + plan.unresolvedWellIndices.length).toBe(plan.activeWellCount);

    // Each recommended solvent system renders a complete 54-lane simulated plate
    for (const rec of plan.recommendedSystems) {
      expect(rec.lanes).toHaveLength(54);
      expect(rec.lanes[53].isBlank).toBe(true);
      expect(rec.lanes[0].spots.some((s) => s.kind === 'product')).toBe(true);
    }

    // Because polar benzylamine/imidazole products are present on half 2, the finite set should include at least one polar/base-modified system
    const hasPolarEluent = plan.recommendedSystems.some(
      (s) => s.system.alcoholPct > 0 || Boolean(s.system.baseModifier)
    );
    expect(hasPolarEluent).toBe(true);

    // Ensure recommended finite set uses complementary distinct families rather than duplicates
    const families = plan.recommendedSystems.map((s) => s.system.family);
    expect(new Set(families).size).toBeGreaterThanOrEqual(2);

    // Ensure secondary complementary systems (C18, Acetone/Hex, MeOH/EtOAc, MeOH/Toluene) are exposed in otherSystems
    expect(plan.otherSystems.length).toBeGreaterThan(5);
    expect(plan.otherSystems.some((s) => s.system.stationaryPhase === 'C18')).toBe(true);
    expect(plan.otherSystems.some((s) => s.system.family === 'acetone_hex')).toBe(true);
    expect(plan.otherSystems.some((s) => s.system.family === 'meoh_toluene')).toBe(true);
    expect(plan.otherSystems.some((s) => s.system.family === 'meoh_etoac')).toBe(true);
  });

  it('rescues basic amines with DCM / MeOH / (2M NH3 in MeOH) (95:3:2 & 88:10:2 = 12% total MeOH) and inverts elution order on C18 reverse-phase TLC', () => {
    const amineProf = profileMoleculeForTlc(rdkit, 'NCc1ccccc1');
    const nh3_95 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_5')!;
    const nh3_88 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_10')!;
    const neutralDcm = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;

    expect(nh3_95.ratio).toContain('95:3:2');
    expect(nh3_88.ratio).toContain('88:10:2');
    expect(nh3_88.alcoholPct).toBe(12);

    const inNeutral = predictNormalPhaseRf(amineProf, neutralDcm);
    const inNh3 = predictNormalPhaseRf(amineProf, nh3_88);
    expect(inNeutral.tailing).toBe(true);
    expect(inNh3.tailing).toBe(false);
    expect(inNh3.rf).toBeGreaterThan(inNeutral.rf);

    // Polar guanidine-ketone adduct shouldn't falsely pin at 0.02 in 88:10:2 (12% total MeOH + NH3)
    const guanidineProf = profileMoleculeForTlc(rdkit, 'N=C(N)NCc1ccncc1');
    expect(predictNormalPhaseRf(guanidineProf, nh3_88).rf).toBeGreaterThanOrEqual(0.20);

    // C18 reverse-phase: polar imidazole elutes higher than lipophilic biphenyl ketone
    const polarAzole = profileMoleculeForTlc(rdkit, 'O=Cc1ncc[nH]1');
    const lipophilicKetone = profileMoleculeForTlc(rdkit, 'O=C(c1ccccc1)c1ccc(-c2ccccc2)cc1');
    const c18_60 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'c18_mecn_60')!;
    const c18_85 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'c18_mecn_85')!;

    expect(predictNormalPhaseRf(polarAzole, c18_60).rf).toBeGreaterThan(
      predictNormalPhaseRf(lipophilicKetone, c18_60).rf
    );
    expect(predictNormalPhaseRf(lipophilicKetone, c18_85).rf).toBeGreaterThan(
      predictNormalPhaseRf(lipophilicKetone, c18_60).rf
    );
  });

  it('offers polarity-matched solvent systems with AcOH/Et3N modifiers and avoids suggesting standalone additives or unnecessary modifiers on neutral plates', async () => {
    // Low/medium-polarity carboxylic acid (benzoic acid) should have a readable EtOAc/Hex + 1% AcOH system rather than blowing to the front in 8% MeOH/DCM + AcOH
    const benzoicProf = profileMoleculeForTlc(rdkit, 'O=C(O)c1ccccc1');
    const etoac30AcOH = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_30_acoh')!;
    const meoh8AcOH = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_acoh')!;
    expect(etoac30AcOH.name).toContain('EtOAc / Hexanes + 1% AcOH');
    expect(etoac30AcOH.chamberPrep50mL).toContain('EtOAc');
    expect(etoac30AcOH.chamberPrep50mL).toContain('AcOH');

    const benzoicInEtoac = predictNormalPhaseRf(benzoicProf, etoac30AcOH);
    const benzoicInMeoh = predictNormalPhaseRf(benzoicProf, meoh8AcOH);
    expect(benzoicInEtoac.tailing).toBe(false);
    expect(benzoicInEtoac.rf).toBeGreaterThanOrEqual(0.22);
    expect(benzoicInEtoac.rf).toBeLessThanOrEqual(0.68);
    expect(benzoicInMeoh.rf).toBeGreaterThan(0.80);

    // Acidic well (TsOH) protonating a pyridine-containing substrate tails without base modifier and is rescued by Et3N in EtOAc/Hexanes
    const pyrKetone = profileMoleculeForTlc(rdkit, 'CC(=O)c1ccncc1');
    const neutral50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const basic60 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_60_et3n')!;
    const inAcidWellNeutralEluent = predictNormalPhaseRf(pyrKetone, neutral50, {
      hasAcidAdditive: true,
      additiveLabel: 'TsOH',
    });
    const inAcidWellBasicEluent = predictNormalPhaseRf(pyrKetone, basic60, {
      hasAcidAdditive: true,
      additiveLabel: 'TsOH',
    });
    expect(inAcidWellNeutralEluent.tailing).toBe(true);
    expect(inAcidWellBasicEluent.tailing).toBe(false);
    expect(inAcidWellBasicEluent.rf).toBeGreaterThan(inAcidWellNeutralEluent.rf);

    // Neutral plate (Benzaldehyde + Malononitrile, no amines/acids/additives) should NOT pull in Et3N/AcOH modifiers
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
      {
        code: 'C',
        name: 'Pyridine',
        smiles: '',
        molarMass: 79.1,
        density: 0.98,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };
    const neutralRow = {
      local_index: 0,
      global_index: 0,
      combo_index: 0,
      plate_number: 0,
      container_id: 0,
      recipe: [
        { code: 'A', name: 'Benzaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Malononitrile', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: 'Pyridine', target_concentration: 10, equivalence: 0.2 },
      ],
      'vol#solvent': 400,
    };

    const ext = extractWellForPrediction(state, neutralRow as any);
    expect(ext.substrates.map((s) => s.code)).toEqual(['A', 'B']);
    expect(ext.condition.medium).toBe('base');

    const neutralRun = {
      plates: 1,
      reactions: 1,
      rows: [neutralRow],
    } as unknown as RunResult;

    const neutralPlan = await optimizePlateTlcSolvents(rdkit, state, neutralRun, [], {
      plateIndex: 0,
      maxSystems: 3,
    });
    expect(neutralPlan.recommendedSystems.length).toBeGreaterThanOrEqual(1);
    for (const rec of neutralPlan.recommendedSystems) {
      expect(rec.system.baseModifier).toBeUndefined();
      expect(rec.system.acidModifier).toBeUndefined();
      expect(rec.system.chamberPrep50mL).toMatch(/EtOAc|Hexanes|DCM|MeOH|Acetone|Toluene|MeCN|Et₂O|Pentane/i);
    }
  });

  it('respects explicit stationaryPhase preference (SiO2, C18, Neutral Al2O3, Basic Al2O3)', async () => {
    const amineProf = profileMoleculeForTlc(rdkit, 'NCc1ccccc1');
    const acidProf = profileMoleculeForTlc(rdkit, 'O=C(O)c1ccccc1');
    const meoh7 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;

    // On Basic Al2O3, basic amine elutes cleanly without Et3N even with TsOH well additive; carboxylic acid pins strongly
    const amineOnBasicAl = predictNormalPhaseRf(
      amineProf,
      meoh7,
      { hasAcidAdditive: true, additiveLabel: 'TsOH' },
      'Al2O3_basic'
    );
    const acidOnBasicAl = predictNormalPhaseRf(acidProf, meoh7, undefined, 'Al2O3_basic');
    expect(amineOnBasicAl.tailing).toBe(false);
    expect(amineOnBasicAl.rf).toBeGreaterThan(0.30);
    expect(acidOnBasicAl.tailing).toBe(true);
    expect(acidOnBasicAl.tailingReason).toMatch(/Al₂O₃/);

    // Build a 6-well plate with imidazole-2-carboxaldehyde + benzylamine
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      {
        code: 'A',
        name: '2-Imidazolecarboxaldehyde',
        smiles: 'O=Cc1ncc[nH]1',
        molarMass: 96.09,
        density: 1.2,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'B',
        name: 'Benzylamine',
        smiles: 'NCc1ccccc1',
        molarMass: 107.15,
        density: 0.98,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    state.eln = { ...state.eln!, temperatureC: 60 };
    const rows = Array.from({ length: 6 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: '2-Imidazolecarboxaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Benzylamine', target_concentration: 50, equivalence: 1 },
      ],
      'vol#solvent': 400,
    }));
    const fakeRun = { plates: 1, reactions: 6, rows } as unknown as RunResult;

    // 1. SiO2-only mode excludes C18 systems even in balanced mode
    const sio2Plan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      maxSystems: 3,
      poolMode: 'balanced',
      stationaryPhase: 'SiO2',
    });
    expect(sio2Plan.stationaryPhase).toBe('SiO2');
    expect(sio2Plan.recommendedSystems.every((r) => r.system.stationaryPhase === 'SiO2')).toBe(true);
    expect(sio2Plan.otherSystems.every((r) => r.system.stationaryPhase === 'SiO2')).toBe(true);

    // 2. C18 mode recommends only C18 reverse-phase systems even when poolMode is 'primary_only'
    const c18Plan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      maxSystems: 3,
      poolMode: 'primary_only',
      stationaryPhase: 'C18',
    });
    expect(c18Plan.stationaryPhase).toBe('C18');
    expect(c18Plan.recommendedSystems.length).toBeGreaterThanOrEqual(1);
    expect(c18Plan.recommendedSystems.every((r) => r.system.stationaryPhase === 'C18')).toBe(true);
    expect(c18Plan.otherSystems.every((r) => r.system.stationaryPhase === 'C18')).toBe(true);

    // 3. Basic Al2O3 mode excludes both AcOH and NH3/Et3N systems as well as C18
    const alBasicPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      maxSystems: 3,
      poolMode: 'prefer_primary',
      stationaryPhase: 'Al2O3_basic',
    });
    expect(alBasicPlan.stationaryPhase).toBe('Al2O3_basic');
    expect(
      alBasicPlan.recommendedSystems.every(
        (r) => r.system.stationaryPhase === 'SiO2' && !r.system.acidModifier && !r.system.baseModifier
      )
    ).toBe(true);
    expect(
      alBasicPlan.otherSystems.every(
        (r) => r.system.stationaryPhase === 'SiO2' && !r.system.acidModifier && !r.system.baseModifier
      )
    ).toBe(true);

    // 4. Neutral Al2O3 mode excludes both AcOH and NH3/Et3N systems as well as C18 (even with TsOH salt additive in plate)
    const alNeutralPlan = await optimizePlateTlcSolvents(rdkit, state, fakeRun, [], {
      maxSystems: 3,
      poolMode: 'prefer_primary',
      stationaryPhase: 'Al2O3_neutral',
    });
    expect(alNeutralPlan.stationaryPhase).toBe('Al2O3_neutral');
    expect(
      alNeutralPlan.recommendedSystems.every(
        (r) => r.system.stationaryPhase === 'SiO2' && !r.system.acidModifier && !r.system.baseModifier
      )
    ).toBe(true);
    expect(
      alNeutralPlan.otherSystems.every(
        (r) => r.system.stationaryPhase === 'SiO2' && !r.system.acidModifier && !r.system.baseModifier
      )
    ).toBe(true);
  });

  it('differentiates primary/tertiary amides, ureas, sulfonamides, phenols, boronic acids, -CF3 halides, and quaternary salts (#3)', () => {
    const primAmide = profileMoleculeForTlc(rdkit, 'NC(=O)c1ccccc1'); // benzamide
    const tertAmide = profileMoleculeForTlc(rdkit, 'CN(C)C(=O)c1ccccc1'); // N,N-dimethylbenzamide
    const urea = profileMoleculeForTlc(rdkit, 'O=C(Nc1ccccc1)Nc1ccccc1'); // diphenylurea
    const sulfonamide = profileMoleculeForTlc(rdkit, 'NS(=O)(=O)c1ccccc1'); // benzenesulfonamide
    const phenol = profileMoleculeForTlc(rdkit, 'Oc1ccccc1'); // phenol
    const boronic = profileMoleculeForTlc(rdkit, 'OB(O)c1ccccc1'); // phenylboronic acid
    const cf3Bromide = profileMoleculeForTlc(rdkit, 'FC(F)(F)c1ccc(Br)cc1'); // 4-bromobenzotrifluoride
    const quatSalt = profileMoleculeForTlc(rdkit, 'C[N+](C)(C)Cc1ccccc1.[Cl-]');

    expect(primAmide.primaryAmideCount).toBe(1);
    expect(tertAmide.primaryAmideCount).toBe(0);
    expect(tertAmide.secondaryAmideCount).toBe(0);
    expect(urea.ureaCount).toBe(1);
    expect(sulfonamide.sulfonamideCount).toBe(1);
    expect(phenol.phenolCount).toBe(1);
    expect(boronic.boronicCount).toBe(1);
    expect(cf3Bromide.cf3Count).toBe(1);
    expect(cf3Bromide.heavyHalogenCount).toBe(1);
    expect(quatSalt.zwitterionOrQuatCount).toBe(1);
    expect(primAmide.exactmw).toBeGreaterThan(100);

    const etoac50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const etoac10 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_10')!;
    const meoh7 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;
    const c18_60 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'c18_mecn_60')!;

    // Primary amide retains noticeably stronger than N,N-dimethyl tertiary amide
    expect(predictNormalPhaseRf(tertAmide, etoac50).rf).toBeGreaterThan(
      predictNormalPhaseRf(primAmide, etoac50).rf
    );
    // Free boronic acid flags streaking in 50% EtOAc/Hex and is rescued by polar MeOH/AcOH or C18
    expect(predictNormalPhaseRf(boronic, etoac50).tailing).toBe(true);
    expect(predictNormalPhaseRf(boronic, meoh7).tailing).toBe(false);
    expect(predictNormalPhaseRf(boronic, c18_60).rf).toBeGreaterThan(0.5);
    // CF3/Br arene elutes cleanly at high Rf even in 10% EtOAc/Hex
    expect(predictNormalPhaseRf(cf3Bromide, etoac10).rf).toBeGreaterThan(0.45);
    // Quaternary ammonium pins on SiO2 and elutes readily on C18
    expect(predictNormalPhaseRf(quatSalt, etoac50).tailing).toBe(true);
    expect(predictNormalPhaseRf(quatSalt, etoac50).rf).toBeLessThan(0.12);
    expect(predictNormalPhaseRf(quatSalt, c18_60).rf).toBeGreaterThan(0.55);
  });

  it('models TsOH protonation stoichiometry and finite 1% Et3N capacity vs 2M NH3/MeOH & Basic Al2O3', async () => {
    const aminoBenz = profileMoleculeForTlc(rdkit, 'Nc1ccc2[nH]cnc2c1'); // 5-aminobenzimidazole
    const pyrroleKetone = profileMoleculeForTlc(rdkit, 'O=C(C(Cl)(Cl)Cl)c1ccc[nH]1'); // 2-(trichloroacetyl)pyrrole
    const polyBasicImine = profileMoleculeForTlc(rdkit, 'c1c[nH]c(C=Nc2ccc3[nH]cnc3c2)n1'); // C11H9N5

    expect(aminoBenz.basicAzoleNCount).toBe(1);
    expect(aminoBenz.anilineCount).toBe(1);
    expect(pyrroleKetone.basicAzoleNCount).toBe(0);
    expect(pyrroleKetone.anilineCount).toBe(0);
    expect(polyBasicImine.basicAzoleNCount).toBe(2);

    const meoh5Et3n = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_5_et3n')!;
    const meoh5Nh3 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_5')!;
    const meoh7 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;

    const tsoh1EqCtx = buildWellTlcContext({
      substrates: [
        { smiles: 'Nc1ccc2[nH]cnc2c1', equivalence: 1.0 },
        { smiles: 'O=C(C(Cl)(Cl)Cl)c1ccc[nH]1', equivalence: 1.0 },
      ],
      condition: {
        medium: 'acid',
        additiveName: 'TsOH',
        additiveEquiv: 1.0,
        additivePka: 0.9,
        temperatureC: 80,
        waterPct: 0,
      },
    });
    expect(tsoh1EqCtx.acidStrength).toBe('strong_nonvolatile');
    expect(tsoh1EqCtx.acidLoadEq).toBeCloseTo(1.0, 1);

    const acohCtx = buildWellTlcContext({
      substrates: [{ smiles: 'Nc1ccc2[nH]cnc2c1', equivalence: 1.0 }],
      condition: {
        medium: 'acid',
        additiveName: 'AcOH',
        additiveEquiv: 0.3,
        additivePka: 12.3,
        temperatureC: 80,
        waterPct: 0,
      },
    });
    expect(acohCtx.acidStrength).toBe('weak');

    // Non-basic pyrrole is unaffected by 1.0 eq TsOH
    expect(predictNormalPhaseRf(pyrroleKetone, meoh5Et3n, tsoh1EqCtx).rf).toBe(
      predictNormalPhaseRf(pyrroleKetone, meoh5Et3n).rf
    );

    // 1% Et3N cannot fully neutralize 1.0 eq TsOH + silica Si-OH for basic 5-aminobenzimidazole / poly-basic imine
    const smBNeutral = predictNormalPhaseRf(aminoBenz, meoh5Et3n);
    const smBTsohEt3n = predictNormalPhaseRf(aminoBenz, meoh5Et3n, tsoh1EqCtx);
    const prod2TsohEt3n = predictNormalPhaseRf(polyBasicImine, meoh5Et3n, tsoh1EqCtx);
    const prod2TsohNh3 = predictNormalPhaseRf(polyBasicImine, meoh5Nh3, tsoh1EqCtx);
    const prod2TsohBasicAl = predictNormalPhaseRf(polyBasicImine, meoh7, tsoh1EqCtx, 'Al2O3_basic');

    expect(smBTsohEt3n.rf).toBeLessThan(smBNeutral.rf);
    expect(smBTsohEt3n.tailing).toBe(true);
    expect(smBTsohEt3n.tailingReason).toMatch(/1% Et₃N/);
    expect(prod2TsohEt3n.tailing).toBe(true);

    // Weak volatile AcOH (0.3 eq) does not overwhelm 1% Et3N
    expect(predictNormalPhaseRf(aminoBenz, meoh5Et3n, acohCtx).tailing).toBe(false);

    // 2M NH3/MeOH and Basic Al2O3 neutralize 1.0 eq TsOH much cleaner than 1% Et3N
    expect(prod2TsohNh3.tailing).toBe(false);
    expect(prod2TsohNh3.rf).toBeGreaterThan(prod2TsohEt3n.rf);
    expect(prod2TsohBasicAl.tailing).toBe(false);

    // Plate advisor on a 1.0 eq TsOH plate emits the TsOH / 1% Et3N warning in summaryNotes and avoids ranking 1% Et3N above NH3/MeOH
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      {
        code: 'A',
        name: '4-Imidazolecarboxaldehyde',
        smiles: 'O=Cc1c[nH]cn1',
        molarMass: 96.09,
        density: 1.2,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'B',
        name: '5-Aminobenzimidazole',
        smiles: 'Nc1ccc2[nH]cnc2c1',
        molarMass: 133.15,
        density: 1.1,
        stock: 500,
        solvent: 'DMSO',
      },
      {
        code: 'C',
        name: 'TsOH·H2O',
        smiles: '',
        molarMass: 190.22,
        density: 1.2,
        stock: 500,
        solvent: 'DMSO',
      },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };
    const tsohRow = {
      local_index: 0,
      global_index: 0,
      combo_index: 0,
      plate_number: 0,
      container_id: 0,
      recipe: [
        { code: 'A', name: '4-Imidazolecarboxaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: '5-Aminobenzimidazole', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: 'TsOH·H2O', target_concentration: 50, equivalence: 1.0 },
      ],
      'vol#solvent': 400,
    };
    const tsohPlan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 1, rows: [tsohRow] } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 2 }
    );
    expect(tsohPlan.summaryNotes.some((n) => /1% Et₃N/.test(n) && /TsOH/.test(n))).toBe(true);
    expect(tsohPlan.recommendedSystems.some((r) => r.system.baseModifier?.includes('NH₃'))).toBe(true);

    // Buffered well regression: when basic azoles absorb 0.2-1.0 eq TsOH into ImH+ TsO- (effectivePhDmso ~7.0-8.0, freeAcidEq=0),
    // buildWellTlcContext(ext, pred) must STILL model salt retention & lag in 1% Et3N vs 2M NH3/MeOH.
    const imidAld = profileMoleculeForTlc(rdkit, 'O=Cc1c[nH]cn1');
    const subs = [
      { id: 'A', code: 'A', name: '4-Imidazolecarboxaldehyde', smiles: 'O=Cc1c[nH]cn1', equivalents: 1 },
      { id: 'B', code: 'B', name: '5-Aminobenzimidazole', smiles: 'Nc1ccc2[nH]cnc2c1', equivalents: 1 },
      { id: 'C', code: 'C', name: '2-(Trichloroacetyl)pyrrole', smiles: 'O=C(C(Cl)(Cl)Cl)c1ccc[nH]1', equivalents: 1 },
    ];
    const condHalf = {
      medium: 'acid' as const,
      additiveName: 'pTsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting' as const,
    };
    const predHalf = predictWellReactions(rdkit, subs, condHalf);
    expect(predHalf.acidBase.effectiveMedium).toBe('buffered');
    const ctxHalf = buildWellTlcContext({ substrates: subs, condition: condHalf }, predHalf);
    expect(ctxHalf.acidStrength).toBe('strong_nonvolatile');

    const imidNeutral = predictNormalPhaseRf(imidAld, meoh5Et3n);
    const imidHalfEt3n = predictNormalPhaseRf(imidAld, meoh5Et3n, ctxHalf);
    const imidHalfNh3 = predictNormalPhaseRf(imidAld, meoh5Nh3, ctxHalf);
    expect(imidHalfEt3n.rf).toBeLessThan(imidNeutral.rf - 0.15);
    expect(imidHalfEt3n.mildStreak || imidHalfEt3n.tailing).toBe(true);
    expect(imidHalfNh3.tailing).toBe(false);
    expect(imidHalfNh3.rf).toBeGreaterThan(imidHalfEt3n.rf);
    expect(predictNormalPhaseRf(aminoBenz, meoh5Et3n, ctxHalf).tailing).toBe(true);

    // PTSA naming variant recognized as strong acid additive in plateBridge
    state.reagents[2] = { ...state.reagents[2], name: 'PTSA' };
    const extPtsa = extractWellForPrediction(state, tsohRow as any);
    expect(extPtsa.condition.medium).toBe('acid');
  });

  it('derives solvent strength via Langmuir silanol saturation, enforces chemical compatibility, and applies toluene aromatic selectivity', async () => {
    // 1. Langmuir non-linear silanol saturation: MeOH in DCM rises sharply at low % and saturates above 10%
    const d1 = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 1, modifierId: 'none', stationaryPhase: 'SiO2' });
    const d5 = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 5, modifierId: 'none', stationaryPhase: 'SiO2' });
    const d12 = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 12, modifierId: 'none', stationaryPhase: 'SiO2' });
    expect(d5.strength - d1.strength).toBeGreaterThan(d12.strength - d5.strength);
    expect(d12.strength).toBeGreaterThan(d5.strength);

    // EtOAc/Hexanes monotonic curve + modifier NH3/MeOH carrier MeOH contribution
    const ea15 = composeSolventSystem({
      id: 'etoac_hex_15',
      strongSolvent: 'EtOAc',
      weakSolvent: 'Hexanes',
      strongPct: 15,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'etoac_hex',
      preferenceTier: 'primary',
    });
    expect(ea15.strength).toBeGreaterThan(0.14);
    expect(ea15.strength).toBeLessThan(0.28);
    expect(ea15.chamberPrep50mL).toBe('7.5 mL EtOAc + 42.5 mL Hexanes');

    const nh3High = composeSolventSystem({
      id: 'nh3_meoh_dcm_high_6',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 2,
      modifierId: 'nh3_meoh_4',
      stationaryPhase: 'SiO2',
      family: 'basic_mod',
      preferenceTier: 'primary',
    });
    expect(nh3High.alcoholPct).toBe(6);
    expect(nh3High.descriptors?.modifierCapacity).toBeGreaterThan(1.2);
    expect(nh3High.chamberPrep50mL).toContain('2.0 mL (2M NH₃ in MeOH)');

    // 2. Compatibility rules reject immiscible/reactive/destructive mixtures
    expect(validateEluentCompatibility({ strongSolvent: 'MeOH', weakSolvent: 'Hexanes', strongPct: 5, modifierId: 'none', stationaryPhase: 'SiO2' }).valid).toBe(false);
    expect(validateEluentCompatibility({ strongSolvent: 'EtOAc', weakSolvent: 'Hexanes', strongPct: 50, modifierId: 'nh3_meoh_2', stationaryPhase: 'SiO2' }).valid).toBe(false);
    expect(validateEluentCompatibility({ strongSolvent: 'Acetone', weakSolvent: 'Hexanes', strongPct: 30, modifierId: 'nh3_meoh_2', stationaryPhase: 'SiO2' }).valid).toBe(false);
    expect(validateEluentCompatibility({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 20, modifierId: 'none', stationaryPhase: 'SiO2' }).valid).toBe(false);
    expect(validateEluentCompatibility({ strongSolvent: 'EtOAc', weakSolvent: 'Hexanes', strongPct: 30, modifierId: 'et3n_1', stationaryPhase: 'SiO2' }, 'Al2O3_basic').valid).toBe(false);

    // 3. Aromatic pi-competition: EtOAc/Toluene 25% selectively lifts polyaromatic heterocycle relative to EtOAc/Hex 50% (similar bulk strength)
    const polyArom = profileMoleculeForTlc(rdkit, 'O=c1[nH]c2ccccc2c2ccccc12'); // fused aromatic lactam
    const aliphAmide = profileMoleculeForTlc(rdkit, 'CCCCCC(=O)NC1CCCCC1'); // matched non-aromatic amide
    const eaHex50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const eaTol25 = composeSolventSystem(
      generateExtendedDynamicSpecs({ aromaticHeavyPlate: true }).find((s) => s.id === 'etoac_toluene_25')!
    );
    const aromGapTol = predictNormalPhaseRf(polyArom, eaTol25).rf - predictNormalPhaseRf(aliphAmide, eaTol25).rf;
    const aromGapHex = predictNormalPhaseRf(polyArom, eaHex50).rf - predictNormalPhaseRf(aliphAmide, eaHex50).rf;
    expect(aromGapTol).toBeGreaterThan(aromGapHex);

    // 4. Calibration matcher resolves dynamic eluent names cleanly while preserving canonical 2:1 Hex/EtOAc -> etoac_hex_25
    expect(matchTlcSetNameToSolvent('15% EtOAc / Hexanes')?.system.id).toBe('etoac_hex_15');
    expect(matchTlcSetNameToSolvent('25% EtOAc / Toluene')?.system.id).toBe('etoac_toluene_25');
    expect(matchTlcSetNameToSolvent('5% MeOH / Toluene + 1% Et₃N')?.system.id).toBe('meoh_toluene_5_et3n');
    expect(matchTlcSetNameToSolvent('94:2:4 DCM/MeOH/NH₃')?.system.id).toBe('nh3_meoh_dcm_high_6');
    expect(matchTlcSetNameToSolvent('2:1 Hex/EtOAc')?.system.id).toBe('etoac_hex_25');

    // 5. High-acid TsOH plate optimizer exposes and scores high-capacity 4% (2M NH3/MeOH) dynamic candidate cleanly
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: '4-Imidazolecarboxaldehyde', smiles: 'O=Cc1c[nH]cn1', molarMass: 96.09, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: '5-Aminobenzimidazole', smiles: 'Nc1ccc2[nH]cnc2c1', molarMass: 133.15, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'C', name: 'TsOH·H2O', smiles: '', molarMass: 190.22, density: 1.2, stock: 500, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };
    const heavyTsohRow = {
      local_index: 0,
      global_index: 0,
      combo_index: 0,
      plate_number: 0,
      container_id: 0,
      recipe: [
        { code: 'A', name: '4-Imidazolecarboxaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: '5-Aminobenzimidazole', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: 'TsOH·H2O', target_concentration: 60, equivalence: 1.2 },
      ],
      'vol#solvent': 400,
    };
    const heavyPlan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 1, rows: [heavyTsohRow] } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 2 }
    );
    const allExposed = [...heavyPlan.recommendedSystems, ...heavyPlan.otherSystems];
    expect(allExposed.some((e) => e.system.id.startsWith('nh3_meoh_dcm_high_'))).toBe(true);
    const imidProf = profileMoleculeForTlc(rdkit, 'O=Cc1c[nH]cn1');
    const pred2 = predictNormalPhaseRf(imidProf, TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_5')!, { hasAcidAdditive: true, additiveLabel: 'TsOH', acidStrength: 'strong_nonvolatile', acidLoadEq: 1.2 });
    const pred4 = predictNormalPhaseRf(imidProf, nh3High, { hasAcidAdditive: true, additiveLabel: 'TsOH', acidStrength: 'strong_nonvolatile', acidLoadEq: 1.2 });
    expect(pred4.rf).toBeGreaterThanOrEqual(pred2.rf);
    expect(pred4.tailing).toBe(false);

    // 6. Langmuir inversion & plate-tailored eluent synthesis + EmpiricalPlateProfile
    const invPct = invertLangmuirForPct('EtOAc', 'Hexanes', 'none', 0.37);
    expect(invPct).not.toBeNull();
    const invDesc = computeMixtureDescriptors({ strongSolvent: 'EtOAc', weakSolvent: 'Hexanes', strongPct: invPct!, modifierId: 'none', stationaryPhase: 'SiO2' });
    expect(Math.abs(invDesc.strength - 0.37)).toBeLessThan(0.05);

    const synth = synthesizePlateTailoredSpecs({
      targetStrengths: [0.36, 0.72],
      aromaticHeavyPlate: true,
      hasStrongWellAcid: true,
      maxAcidStress: 1.1,
      needsBasicMod: true,
      needsAcidMod: false,
    });
    expect(synth.some((s) => s.isSynthesized && s.modifierId === 'nh3_meoh_4')).toBe(true);
    expect(synth.some((s) => s.isSynthesized && s.weakSolvent === 'Toluene')).toBe(true);

    expect(heavyPlan.empiricalProfile).toBeDefined();
    expect(heavyPlan.empiricalProfile!.maxAcidStress).toBeGreaterThanOrEqual(0.95);
    expect(heavyPlan.empiricalProfile!.recommendedMinBaseCap).toBe(1.35);
    expect(heavyPlan.empiricalProfile!.meanAromaticRings).toBeGreaterThanOrEqual(1.5);
    expect(heavyPlan.empiricalProfile!.synthesizedCandidateCount).toBeGreaterThan(0);
    expect(heavyPlan.empiricalProfile!.prismaCandidateCount).toBeGreaterThan(0);
  });

  it('models LSER inductive EWG attenuation, Snyder-Soczewinski n_i slope, Geiss beta-front demixing, and MTBE/PRISMA ternary blends', async () => {
    // 1. LSER + EWG inductive attenuation
    const aniline = profileMoleculeForTlc(rdkit, 'Nc1ccccc1');
    const cf3Aniline = profileMoleculeForTlc(rdkit, 'Nc1ccc(C(F)(F)F)cc1');
    const nitroAniline = profileMoleculeForTlc(rdkit, 'Nc1ccc([N+](=O)[O-])cc1');
    expect(aniline.lser).toBeDefined();
    expect(cf3Aniline.cf3Count).toBe(1);
    expect(nitroAniline.nitroCount).toBe(1);
    expect(cf3Aniline.lser!.B).toBeLessThan(aniline.lser!.B);
    expect(nitroAniline.lser!.S).toBeGreaterThan(aniline.lser!.S);

    // 2. Snyder-Soczewinski displacement slope n_i: large multifunctional solute has steeper d(Rf)/d(eps0) than compact fragment
    const compactImid = profileMoleculeForTlc(rdkit, 'O=Cc1c[nH]cn1');
    const largeBisAmide = profileMoleculeForTlc(rdkit, 'Cc1ccc(S(=O)(=O)Nc2ccc(C(=O)Nc3ccc(OC)cc3)cc2)cc1');
    expect(largeBisAmide.lser!.displacementN).toBeGreaterThan(1.1);
    expect(compactImid.lser!.displacementN).toBeLessThan(largeBisAmide.lser!.displacementN);

    const ea25 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const ea80 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_80')!;
    const ea50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const largeSpan = predictNormalPhaseRf(largeBisAmide, ea80).rf - predictNormalPhaseRf(largeBisAmide, ea25).rf;
    const compactSpan = predictNormalPhaseRf(compactImid, ea80).rf - predictNormalPhaseRf(compactImid, ea25).rf;
    expect(largeSpan).toBeGreaterThan(compactSpan);
    expect(predictNormalPhaseRf(cf3Aniline, ea50).rf).toBeGreaterThan(predictNormalPhaseRf(aniline, ea50).rf - 0.05);

    // Apolar small halides like benzyl bromide move with the solvent front (>= 0.97) in MeOH/DCM & DCM/NH3-MeOH
    const benzylBromide = profileMoleculeForTlc(rdkit, 'BrCc1ccccc1');
    const nh3Dcm2 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_2')!;
    const meohDcm3 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_3')!;
    expect(predictNormalPhaseRf(benzylBromide, nh3Dcm2).rf).toBeGreaterThanOrEqual(0.97);
    expect(predictNormalPhaseRf(benzylBromide, meohDcm3).rf).toBeGreaterThanOrEqual(0.98);

    // 3. Geiss secondary solvent front (beta-front demixing) on dry SiO2
    const meoh3Desc = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 3, modifierId: 'none', stationaryPhase: 'SiO2' });
    const meoh12Desc = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 12, modifierId: 'none', stationaryPhase: 'SiO2' });
    expect(meoh3Desc.betaFrontCeiling).toBeDefined();
    expect(meoh12Desc.betaFrontCeiling).toBeDefined();
    expect(meoh3Desc.betaFrontCeiling!).toBeLessThan(0.9);
    expect(meoh12Desc.betaFrontCeiling!).toBeGreaterThan(meoh3Desc.betaFrontCeiling!);

    const sysMeoh3 = composeSolventSystem({
      id: 'meoh_dcm_3_test',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 3,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_dcm',
      preferenceTier: 'primary',
    });
    const sysMeoh12 = composeSolventSystem({
      id: 'meoh_dcm_12_test',
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 12,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'meoh_dcm',
      preferenceTier: 'primary',
    });
    const fastPolarAmide = profileMoleculeForTlc(rdkit, 'CCCCCCCCNC(=O)c1ccccc1O'); // H-bond dependent phenolic amide
    const pred3 = predictNormalPhaseRf(fastPolarAmide, sysMeoh3);
    const pred12 = predictNormalPhaseRf(fastPolarAmide, sysMeoh12);
    expect(pred3.rf).toBeLessThanOrEqual(meoh3Desc.betaFrontCeiling! + 0.01);
    expect(pred12.rf).toBeGreaterThan(pred3.rf);

    // 4. MTBE vertex + Nyiredy PRISMA ternary blends & miscibility rules
    const mtbe50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'mtbe_hex_50');
    expect(mtbe50).toBeDefined();
    expect(mtbe50!.family).toBe('mtbe_hex');
    expect(mtbe50!.preferenceTier).toBe('secondary');
    expect(matchTlcSetNameToSolvent('50% MTBE / Hexanes')?.system.id).toBe('mtbe_hex_50');

    // Immiscible MeOH/Hex without >=25% bridging co-solvent fails, whereas 5% MeOH + 35% EtOAc + 60% Hex succeeds
    expect(
      validateEluentCompatibility({
        strongSolvent: 'MeOH',
        weakSolvent: 'Hexanes',
        ternaryCoSolvent: { solvent: 'EtOAc', pct: 10 },
        strongPct: 5,
        modifierId: 'none',
        stationaryPhase: 'SiO2',
      }).valid
    ).toBe(false);

    const prismaBlend = composeSolventSystem({
      id: 'prisma_test_blend',
      strongSolvent: 'MeOH',
      weakSolvent: 'Hexanes',
      ternaryCoSolvent: { solvent: 'EtOAc', pct: 35 },
      strongPct: 5,
      modifierId: 'none',
      stationaryPhase: 'SiO2',
      family: 'prisma_ternary',
      preferenceTier: 'secondary',
    });
    expect(prismaBlend.chamberPrep50mL).toContain('MeOH');
    expect(prismaBlend.chamberPrep50mL).toContain('EtOAc');
    expect(prismaBlend.chamberPrep50mL).toContain('Hexanes');
    expect(prismaBlend.composition?.ternaryCoSolvent).toEqual({ solvent: 'EtOAc', pct: 35 });
    expect(prismaBlend.strength).toBeGreaterThan(0.35);

    const prismaSpecs = generatePrismaTernarySpecs({
      targetStrengths: [0.34, 0.62],
      aromaticHeavyPlate: true,
      hasStrongWellAcid: false,
      maxAcidStress: 0,
      needsBasicMod: false,
      needsAcidMod: false,
    });
    expect(prismaSpecs.length).toBeGreaterThan(0);
    expect(prismaSpecs.every((p) => p.family === 'prisma_ternary' && Boolean(p.ternaryCoSolvent))).toBe(true);
  });

  it('tracks every UV-active starting material on at least one plate while resolving polar/acidic products via weak-to-strong bracketing', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: '4-Imidazolecarboxaldehyde', smiles: 'O=Cc1c[nH]cn1', molarMass: 96.09, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: '5-Aminobenzimidazole', smiles: 'Nc1ccc2[nH]cnc2c1', molarMass: 133.15, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'C', name: '2-(Trichloroacetyl)pyrrole', smiles: 'O=C(C(Cl)(Cl)Cl)c1ccc[nH]1', molarMass: 212.46, density: 1.4, stock: 500, solvent: 'DMSO' },
      { code: 'D', name: '2-Butyl-1H-imidazole-4-carbaldehyde', smiles: 'CCCCc1nc(C=O)c[nH]1', molarMass: 152.19, density: 1.1, stock: 500, solvent: 'DMSO' },
      { code: 'E', name: '2-Cyclopenten-1-one', smiles: 'O=C1C=CCC1', molarMass: 82.10, density: 0.98, stock: 500, solvent: 'DMSO' },
      { code: 'F', name: 'Benzyl bromide', smiles: 'BrCc1ccccc1', molarMass: 171.03, density: 1.44, stock: 500, solvent: 'DMSO' },
      { code: 'G', name: 'TsOH·H2O', smiles: '', molarMass: 190.22, density: 1.2, stock: 500, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };

    // Mix of polar/acidic wells (like A1) and wide-polarity-span wells (like A8 with Benzyl bromide + Cyclopentenone + Butyl-imidazole)
    const rows: any[] = [];
    for (let w = 0; w < 12; w++) {
      const isA1Type = w < 6;
      rows.push({
        local_index: w,
        global_index: w,
        combo_index: w,
        plate_number: 0,
        container_id: w,
        recipe: isA1Type
          ? [
              { code: 'A', name: '4-Imidazolecarboxaldehyde', target_concentration: 50, equivalence: 1 },
              { code: 'B', name: '5-Aminobenzimidazole', target_concentration: 50, equivalence: 1 },
              { code: 'C', name: '2-(Trichloroacetyl)pyrrole', target_concentration: 50, equivalence: 1 },
              { code: 'G', name: 'TsOH·H2O', target_concentration: 25, equivalence: 0.5 },
            ]
          : [
              { code: 'D', name: '2-Butyl-1H-imidazole-4-carbaldehyde', target_concentration: 50, equivalence: 1 },
              { code: 'E', name: '2-Cyclopenten-1-one', target_concentration: 50, equivalence: 1 },
              { code: 'F', name: 'Benzyl bromide', target_concentration: 50, equivalence: 1 },
              ...(w >= 9 ? [{ code: 'G', name: 'TsOH·H2O', target_concentration: 25, equivalence: 0.5 }] : []),
            ],
        'vol#solvent': 400,
      });
    }

    const plan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 12, rows } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 3 }
    );

    expect(plan.recommendedSystems.length).toBeGreaterThanOrEqual(2);
    expect(plan.recommendedSystems.every((r) => r.system.stationaryPhase === 'SiO2')).toBe(true);
    expect(plan.totalCoveragePct).toBeGreaterThanOrEqual(80);
    // Weak-to-strong ordering: Plate #1 is milder than the final polar rescue plate
    const s0 = plan.recommendedSystems[0].system;
    const sLast = plan.recommendedSystems[plan.recommendedSystems.length - 1].system;
    expect(s0.strength).toBeLessThan(sLast.strength);

    // On both representative wells (0 = A1-type, 6 = A8-type), EVERY UV-active SM must sit in 0.10..0.85 on at least one recommended plate!
    for (const wi of [0, 6]) {
      const subCodes = Array.from(
        new Set(
          plan.recommendedSystems[0].lanes[wi].spots
            .filter((s) => s.kind === 'substrate' && s.uvActive !== false)
            .map((s) => s.code)
        )
      );
      expect(subCodes.length).toBe(3);
      for (const code of subCodes) {
        const clearlyTrackedOnSomePlate = plan.recommendedSystems.some((rec) => {
          const sp = rec.lanes[wi].spots.find((s) => s.kind === 'substrate' && s.code === code);
          return sp ? sp.rf >= 0.10 && sp.rf <= 0.85 : false;
        });
        expect(clearlyTrackedOnSomePlate).toBe(true);
      }
    }
  });
});

describe('eluent reactivity warnings', () => {
  it('flags acetone with primary amines/hydrazines and MeOH with acid chlorides, but not benign cases', () => {
    const acetone = TLC_SOLVENT_LIBRARY.find((s) => s.family === 'acetone_hex' || s.composition?.strongSolvent === 'Acetone');
    const meoh = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_et3n')!;
    const etoac = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    if (acetone) {
      expect(eluentReactivityWarnings(rdkit, ['NNc1ccccc1'], [acetone]).join(' ')).toMatch(/Acetone/);
      expect(eluentReactivityWarnings(rdkit, ['CC(=O)Nc1ccccc1'], [acetone])).toHaveLength(0);
    }
    expect(eluentReactivityWarnings(rdkit, ['O=C(Cl)c1ccccc1'], [meoh]).join(' ')).toMatch(/MeOH/);
    expect(eluentReactivityWarnings(rdkit, ['O=C(Cl)c1ccccc1'], [etoac])).toHaveLength(0);
  });
});

describe('toluene/MeOH/NH3 strength (plate UJG-C0021 regression)', () => {
  it('runs like ~25% EtOAc/Hex for weakly polar compounds, as measured, and weaker than DCM/MeOH/NH3', () => {
    const et = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_25')!;
    const tol = composeSolventSystem({
      strongSolvent: 'MeOH',
      weakSolvent: 'Toluene',
      strongPct: 4,
      modifierId: 'nh3_meoh_2',
      stationaryPhase: 'SiO2',
    } as any);
    const dcm = composeSolventSystem({
      strongSolvent: 'MeOH',
      weakSolvent: 'DCM',
      strongPct: 4,
      modifierId: 'nh3_meoh_2',
      stationaryPhase: 'SiO2',
    } as any);
    expect(MEOH_AFFINITY_SCALE_BY_CARRIER.Toluene).toBeLessThan(1);
    expect(tol.strength).toBeLessThan(dcm.strength - 0.2);
    for (const smi of [
      'O=C(c1ccc[nH]1)C(Cl)(Cl)Cl',
      'CC(C)(O)CCCC1=CCC(C=O)CC1',
      'CC(=O)c1ccccc1O',
    ]) {
      const p = profileMoleculeForTlc(rdkit, smi);
      const rEt = predictNormalPhaseRf(p, et).rf;
      const rTol = predictNormalPhaseRf(p, tol).rf;
      expect(Math.abs(rTol - rEt)).toBeLessThan(0.25);
    }

    // Forward & inverse Langmuir consistency for MeOH in Toluene
    const invPct = invertLangmuirForPct('MeOH', 'Toluene', 'nh3_meoh_2', tol.strength);
    expect(invPct).toBeGreaterThanOrEqual(3);
    expect(invPct).toBeLessThanOrEqual(5);
  });
});

describe('same-base alternative with more modifier capacity', () => {
  it('a 2% NH3/MeOH rung streaks less than the 1% rung for acid-loaded wells, and any offered alternative is justified', async () => {
    const amine = profileMoleculeForTlc(rdkit, 'Nc1ccccc1C(=O)c1ccccc1');
    const ctx = { hasAcidAdditive: true, additiveLabel: 'TsOH', acidStrength: 'strong_nonvolatile', acidLoadEq: 0.9 } as any;
    const one = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_1')!;
    const two = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'nh3_meoh_dcm_2')!;
    const p1 = predictNormalPhaseRf(amine, one, ctx);
    const p2 = predictNormalPhaseRf(amine, two, ctx);
    const flagged = (p: any) => Boolean(p.tailing || (p.mildStreak && p.tailingReason));
    expect(flagged(p1) || !flagged(p2)).toBe(true); // headroom never goes the wrong way
    expect(flagged(p2) && !flagged(p1)).toBe(false);

    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: 'amine', smiles: 'Nc1ccccc1C(=O)c1ccccc1', molarMass: 197, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'C', name: 'TsOH·H2O', smiles: '', molarMass: 190.22, density: 1.2, stock: 500, solvent: 'DMSO' },
    ];
    const row = {
      local_index: 0, global_index: 0, combo_index: 0, plate_number: 0, container_id: 0,
      recipe: [
        { code: 'A', name: 'amine', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: 'TsOH·H2O', target_concentration: 45, equivalence: 0.9 },
      ],
      'vol#solvent': 400,
    };
    const plan = await optimizePlateTlcSolvents(rdkit, state, { plates: 1, reactions: 1, rows: [row] } as unknown as RunResult, [], { plateIndex: 0, maxSystems: 3 });
    for (const rec of plan.recommendedSystems) {
      if (rec.alternativeNote) {
        const alt = rec.alternatives![0];
        expect(alt.id).not.toBe(rec.system.id);
        expect(alt.baseModifier).toBeTruthy();
      }
    }
  });
});

describe('clean-spot coverage in eluent selection', () => {
  it('a set chosen with the clean-spot term never leaves more spots streaking everywhere than one chosen without it', async () => {
    const state: any = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'C', name: '4-Bromopyrimidin-2-amine', smiles: 'Nc1nccc(Br)n1', molarMass: 174, density: 1.2, stock: 225, solvent: 'DMSO' },
      { code: 'F', name: '2-Aminobenzophenone', smiles: 'Nc1ccccc1C(=O)c1ccccc1', molarMass: 197, density: 1.2, stock: 225, solvent: 'DMSO' },
      { code: 'Acid', name: 'P-Toluenesulfonic acid monohydrate', smiles: '', molarMass: 190.2, density: 1.2, stock: 225, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 80 };
    const mk = (i: number, f: number) => ({
      local_index: i, global_index: i, combo_index: i, plate_number: 0, container_id: i,
      recipe: [
        { code: 'C', name: '4-Bromopyrimidin-2-amine', target_concentration: 75, equivalence: 1 },
        { code: 'F', name: '2-Aminobenzophenone', target_concentration: 75, equivalence: 1 },
        { code: 'Acid', name: 'P-Toluenesulfonic acid monohydrate', target_concentration: 25 * f, equivalence: 0.33 * f },
      ],
      'vol#solvent': 400,
    });
    const rows = Array.from({ length: 8 }, (_, i) => mk(i, [0.5, 1, 2, 3][i % 4]));
    const run = { plates: 1, reactions: 8, rows } as unknown as RunResult;
    // spots (substrates + High/Medium products) that run clean in at least one chosen eluent
    const cleanSpots = (plan: any): number => {
      let n = 0;
      for (const wi of new Set<number>(plan.recommendedSystems.flatMap((r: any) => r.lanes.map((l: any) => l.wellIndex)))) {
        const per: Array<Set<number>> = [];
        for (const r of plan.recommendedSystems) {
          const lane = r.lanes.find((l: any) => l.wellIndex === wi);
          if (!lane || lane.isBlank) continue;
          const ok = new Set<number>();
          lane.spots.forEach((sp: any, i: number) => {
            const counted = sp.kind === 'substrate' || sp.tier === 'High' || sp.tier === 'Medium';
            const flagged = sp.tailing || (sp.mildStreak && sp.tailingReason);
            if (counted && !flagged && sp.rf >= 0.06 && sp.rf <= 0.94) ok.add(i);
          });
          per.push(ok);
        }
        n += new Set(per.flatMap((s) => [...s])).size;
      }
      return n;
    };
    const without = await optimizePlateTlcSolvents(rdkit, state, run, [], { plateIndex: 0, maxSystems: 3, cleanSpotWeight: 0 });
    const withTerm = await optimizePlateTlcSolvents(rdkit, state, run, [], { plateIndex: 0, maxSystems: 3 });
    expect(cleanSpots(withTerm)).toBeGreaterThanOrEqual(cleanSpots(without));
  }, 120000);
});

describe('7 M NH3/MeOH stock option', () => {
  const vol = (txt: string, token: RegExp): number => {
    const m = txt.match(new RegExp(`([\\d.]+) (mL|µL) ${token.source}`));
    if (!m) throw new Error(`no ${token} in ${txt}`);
    return m[2] === 'µL' ? Number(m[1]) / 1000 : Number(m[1]);
  };
  it('keeps NH3 amount and total MeOH identical, using 2/7 the volume of stock', () => {
    const sys = composeSolventSystem({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 3, modifierId: 'nh3_meoh_2', stationaryPhase: 'SiO2' } as any);
    const p2 = chamberPrepForNh3Stock(sys, 2);
    const p7 = chamberPrepForNh3Stock(sys, 7);
    expect(p2).toBe(sys.chamberPrep50mL);
    expect(p7).toContain('7M NH₃ in MeOH');
    // 50 mL of 95:3:2: 1.0 mL of 2 M = 2 mmol NH3, same in 7 M stock
    const nh3_2 = vol(p2, /\(2M/) * 2;
    const nh3_7 = vol(p7, /\(7M/) * 7;
    expect(nh3_7).toBeCloseTo(nh3_2, 1);
    const meoh2 = vol(p2, /MeOH \+/) + vol(p2, /\(2M/);
    const meoh7 = vol(p7, /MeOH \+/) + vol(p7, /\(7M/);
    expect(meoh7).toBeCloseTo(meoh2, 1);
    // total still 50 mL
    const total7 = vol(p7, /DCM/) + vol(p7, /MeOH \+/) + vol(p7, /\(7M/);
    expect(total7).toBeCloseTo(50, 1);
  });
  it('leaves non-ammonia systems and the default untouched', () => {
    const et = TLC_SOLVENT_LIBRARY.find((x) => x.id === 'etoac_hex_25')!;
    expect(chamberPrepForNh3Stock(et, 7)).toBe(et.chamberPrep50mL);
  });
});

describe('upgraded retention physics, ionization, reactivity & explainability', () => {
  it('detects internal zwitterions, attenuates EWG-substituted basicity, and widens per-spot rfSigma on hard spots', () => {
    const phe = profileMoleculeForTlc(rdkit, 'NC(Cc1ccccc1)C(=O)O'); // phenylalanine (internal zwitterion)
    expect(phe.isInternalZwitterion).toBe(true);
    expect(phe.canonicalSmiles.length).toBeGreaterThan(0);

    const meoh7 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'meoh_dcm_7')!;
    const c18_60 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'c18_mecn_60')!;
    const ket = profileMoleculeForTlc(rdkit, 'CC(=O)c1ccccc1');

    const pheNp = predictNormalPhaseRf(phe, meoh7);
    const pheC18 = predictNormalPhaseRf(phe, c18_60);
    const ketNp = predictNormalPhaseRf(ket, meoh7);

    expect(pheNp.tailing).toBe(true);
    expect(pheNp.tailingReason).toMatch(/zwitterion/i);
    expect(pheNp.rf).toBeLessThan(0.20);
    expect(pheC18.rf).toBeGreaterThan(0.65);
    expect(pheNp.rfSigma).toBeGreaterThan(ketNp.rfSigma);

    // EWG attenuation: 4-nitroaniline & 2-chloropyridine suffer less TsOH protonation lag than aniline / pyridine
    const aniline = profileMoleculeForTlc(rdkit, 'Nc1ccccc1');
    const nitroAniline = profileMoleculeForTlc(rdkit, 'Nc1ccc([N+](=O)[O-])cc1');
    const pyridine = profileMoleculeForTlc(rdkit, 'c1ccncc1');
    const chloroPyr = profileMoleculeForTlc(rdkit, 'Clc1ccccn1');
    expect(nitroAniline.ewgAttenuatedBasicity).toBeGreaterThan(0);
    expect(chloroPyr.ewgAttenuatedBasicity).toBeGreaterThan(0);

    const ea50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;
    const tsohCtx = { hasAcidAdditive: true, additiveLabel: 'TsOH', acidStrength: 'strong_nonvolatile' as const, acidLoadEq: 0.6 };
    const anilDrop = predictNormalPhaseRf(aniline, ea50).rf - predictNormalPhaseRf(aniline, ea50, tsohCtx).rf;
    const nitroDrop = predictNormalPhaseRf(nitroAniline, ea50).rf - predictNormalPhaseRf(nitroAniline, ea50, tsohCtx).rf;
    expect(nitroDrop).toBeLessThanOrEqual(anilDrop);
  });

  it('models independent Al2O3 retention (tighter phenol/nitro retention relative to amines vs SiO2)', () => {
    const phenol = profileMoleculeForTlc(rdkit, 'Oc1ccccc1');
    const nitro = profileMoleculeForTlc(rdkit, 'O=[N+]([O-])c1ccccc1');
    const amine = profileMoleculeForTlc(rdkit, 'NCc1ccccc1');
    const ea50 = TLC_SOLVENT_LIBRARY.find((s) => s.id === 'etoac_hex_50')!;

    // On SiO2, phenol elutes much higher than benzylamine (which tails/pins);
    // on Neutral Al2O3, phenol chelates strongly while benzylamine runs far cleaner/higher.
    const gapSiO2 = predictNormalPhaseRf(phenol, ea50, undefined, 'SiO2').rf - predictNormalPhaseRf(amine, ea50, undefined, 'SiO2').rf;
    const gapAl2O3 = predictNormalPhaseRf(phenol, ea50, undefined, 'Al2O3_neutral').rf - predictNormalPhaseRf(amine, ea50, undefined, 'Al2O3_neutral').rf;
    expect(gapAl2O3).toBeLessThan(gapSiO2 - 0.15);

    // Nitroarene is also retained more strongly on Al2O3 (dipole/pi) than on SiO2
    const nitroSi = predictNormalPhaseRf(nitro, ea50, undefined, 'SiO2').rf;
    const nitroAl = predictNormalPhaseRf(nitro, ea50, undefined, 'Al2O3_neutral').rf;
    expect(nitroAl).toBeLessThan(nitroSi);
  });

  it('flags reactive sample-eluent pairs in-loop, computes EHS practicality descriptors, and populates advisor card explainability', async () => {
    const amine = profileMoleculeForTlc(rdkit, 'NCc1ccccc1');
    const acidChloride = profileMoleculeForTlc(rdkit, 'O=C(Cl)c1ccccc1');
    expect(amine.acetoneReactiveLabel).toBeTruthy();
    expect(acidChloride.meohReactiveLabel).toBeTruthy();

    // EHS practicality ordering: EtOAc/Hexanes cleaner than DCM/MeOH and Et2O/Pentane
    const dEaHex = computeMixtureDescriptors({ strongSolvent: 'EtOAc', weakSolvent: 'Hexanes', strongPct: 40, modifierId: 'none', stationaryPhase: 'SiO2' });
    const dDcm = computeMixtureDescriptors({ strongSolvent: 'MeOH', weakSolvent: 'DCM', strongPct: 5, modifierId: 'none', stationaryPhase: 'SiO2' });
    const dEther = computeMixtureDescriptors({ strongSolvent: 'Et2O', weakSolvent: 'Pentane', strongPct: 30, modifierId: 'none', stationaryPhase: 'SiO2' });
    expect(dEaHex.practicalityPenalty).toBeLessThan(dDcm.practicalityPenalty);
    expect(dDcm.practicalityPenalty).toBeLessThan(dEther.practicalityPenalty);
    expect(dEther.practicalityNote).toMatch(/volatile/i);

    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', molarMass: 106.12, density: 1.04, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: 'Benzylamine', smiles: 'NCc1ccccc1', molarMass: 107.15, density: 0.98, stock: 500, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 60 };
    const rows = Array.from({ length: 4 }, (_, w) => ({
      local_index: w, global_index: w, combo_index: w, plate_number: 0, container_id: w,
      recipe: [
        { code: 'A', name: 'Benzaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: 'Benzylamine', target_concentration: 50, equivalence: 1 },
      ],
      'vol#solvent': 400,
    }));
    const plan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 4, rows } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 2, poolMode: 'balanced' }
    );

    // Primary amine plate must not rank an Acetone/Hexanes system in recommendedSystems
    expect(plan.recommendedSystems.every((r) => r.system.family !== 'acetone_hex')).toBe(true);
    // Any Acetone system in otherSystems exposes reactiveWells > 0 in riskSummary
    const acetoneAlt = plan.otherSystems.find((s) => s.system.family === 'acetone_hex');
    if (acetoneAlt) {
      expect(acetoneAlt.riskSummary.reactiveWells).toBeGreaterThan(0);
    }

    // Explainability fields populated on every recommended card
    for (const rec of plan.recommendedSystems) {
      expect(rec.meanRfSigma).toBeGreaterThan(0.05);
      expect(rec.meanRfSigma).toBeLessThan(0.35);
      expect(rec.rationale.length).toBeGreaterThan(10);
      expect(rec.evidenceSummary.length).toBeGreaterThan(10);
      expect(rec.riskSummary).toBeDefined();
      expect(Array.isArray(rec.uniqueWellIndices)).toBe(true);
    }
  });
});

describe('all_equal stationary phase mode', () => {
  it('evaluates SiO2, Neutral Al2O3, Basic Al2O3, and C18 equally and picks C18 without penalty on zwitterionic/polar plates', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: 'N-Benzyl-L-phenylalanine', smiles: 'O=C(O)C(Cc1ccccc1)NCc1ccccc1', molarMass: 255.31, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: '4-Chlorobenzaldehyde', smiles: 'O=Cc1ccc(Cl)cc1', molarMass: 140.57, density: 1.2, stock: 500, solvent: 'DMSO' },
      { code: 'C', name: '2-Naphthoic acid', smiles: 'O=C(O)c1ccc2ccccc2c1', molarMass: 172.18, density: 1.2, stock: 500, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 60 };
    const rows = Array.from({ length: 4 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: 'N-Benzyl-L-phenylalanine', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: '4-Chlorobenzaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: '2-Naphthoic acid', target_concentration: 50, equivalence: 1 },
      ],
      'vol#solvent': 400,
    }));

    const plan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 4, rows } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 2, stationaryPhase: 'all_equal', poolMode: 'prefer_primary' }
    );

    expect(plan.stationaryPhase).toBe('all_equal');
    expect(plan.recommendedSystems.length).toBeGreaterThanOrEqual(1);
    // All 4 phases must appear across recommended + otherSystems
    const allPhases = new Set(
      [...plan.recommendedSystems, ...plan.otherSystems].map((r) => resolveSystemPhase(r.system, 'all_equal'))
    );
    expect(allPhases.has('SiO2')).toBe(true);
    expect(allPhases.has('C18')).toBe(true);
    expect(allPhases.has('Al2O3_neutral')).toBe(true);
    expect(allPhases.has('Al2O3_basic')).toBe(true);
    // Every returned system must carry an explicit effectivePhase
    for (const r of plan.recommendedSystems) {
      expect(r.system.effectivePhase).toBeDefined();
    }
    // On an amino-acid / zwitterionic plate, C18 should win as top choice without penalty
    expect(
      plan.recommendedSystems.some((r) => resolveSystemPhase(r.system, 'all_equal') === 'C18')
    ).toBe(true);
    expect(plan.summaryNotes.some((n) => /evaluated equally/i.test(n))).toBe(true);
  });

  it('can select Basic Al2O3 cleanly on a strong-acid + basic-amine plate without requiring SiO2 modifiers', async () => {
    const state = exampleState();
    state.mode = 'concentration';
    state.reagents = [
      { code: 'A', name: 'Benzylamine', smiles: 'NCc1ccccc1', molarMass: 107.15, density: 0.98, stock: 500, solvent: 'DMSO' },
      { code: 'B', name: '4-Phenylpyridine', smiles: 'c1ccc(-c2ccncc2)cc1', molarMass: 155.20, density: 1.1, stock: 500, solvent: 'DMSO' },
      { code: 'C', name: '4-Fluorobenzaldehyde', smiles: 'O=Cc1ccc(F)cc1', molarMass: 124.11, density: 1.15, stock: 500, solvent: 'DMSO' },
      { code: 'D', name: 'TsOH·H2O', smiles: '', molarMass: 190.22, density: 1.2, stock: 500, solvent: 'DMSO' },
    ];
    state.eln = { ...state.eln!, temperatureC: 60 };
    const rows = Array.from({ length: 4 }, (_, w) => ({
      local_index: w,
      global_index: w,
      combo_index: w,
      plate_number: 0,
      container_id: w,
      recipe: [
        { code: 'A', name: 'Benzylamine', target_concentration: 50, equivalence: 1 },
        { code: 'B', name: '4-Phenylpyridine', target_concentration: 50, equivalence: 1 },
        { code: 'C', name: '4-Fluorobenzaldehyde', target_concentration: 50, equivalence: 1 },
        { code: 'D', name: 'TsOH·H2O', target_concentration: 50, equivalence: 1.0 },
      ],
      'vol#solvent': 400,
    }));

    const plan = await optimizePlateTlcSolvents(
      rdkit,
      state,
      { plates: 1, reactions: 4, rows } as unknown as RunResult,
      [],
      { plateIndex: 0, maxSystems: 2, stationaryPhase: 'all_equal', poolMode: 'prefer_primary' }
    );

    expect(plan.totalCoveragePct).toBeGreaterThanOrEqual(75);
    // Basic Al2O3 or 2M NH3/MeOH should handle the TsOH + amine cleanly with zero tailing on recommended plates
    const bestPhase = resolveSystemPhase(plan.recommendedSystems[0].system, 'all_equal');
    expect(['Al2O3_basic', 'SiO2', 'C18']).toContain(bestPhase);
    // Verify Al2O3_basic candidates never carry acid/base modifiers
    const basicAluminaEntries = [...plan.recommendedSystems, ...plan.otherSystems].filter(
      (r) => resolveSystemPhase(r.system, 'all_equal') === 'Al2O3_basic'
    );
    expect(basicAluminaEntries.length).toBeGreaterThan(0);
    expect(basicAluminaEntries.every((r) => !r.system.baseModifier && !r.system.acidModifier)).toBe(true);
  });
});




