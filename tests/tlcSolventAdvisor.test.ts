import { describe, it, expect, beforeAll } from 'vitest';
import {
  TLC_SOLVENT_LIBRARY,
  profileMoleculeForTlc,
  predictNormalPhaseRf,
  optimizePlateTlcSolvents,
  predictWellReactions,
  extractWellForPrediction,
  WellPredictionResult,
} from '../src/engine/predictor';
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
});
