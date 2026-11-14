import { describe, it, expect, beforeAll } from 'vitest';
import {
  TLC_SOLVENT_LIBRARY,
  profileMoleculeForTlc,
  predictNormalPhaseRf,
  optimizePlateTlcSolvents,
  predictWellReactions,
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

    expect(plan.activeWellCount).toBe(53);
    expect(plan.highRankedWellCount).toBeGreaterThan(20);
    expect(plan.recommendedSystems.length).toBeGreaterThanOrEqual(2);
    expect(plan.recommendedSystems.length).toBeLessThanOrEqual(3);
    expect(plan.totalCoveragePct).toBeGreaterThanOrEqual(80);

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
});
