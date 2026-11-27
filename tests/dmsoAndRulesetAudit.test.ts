import { describe, it, expect, beforeAll } from 'vitest';
import initRDKitModule from '@rdkit/rdkit';
import { predictWellReactions } from '../src/engine/predictor/engine';
import type { PredictorSubstrateInput, WellConditionConfig } from '../src/engine/predictor/types';

let rdkit: any;

const S = (code: string, smiles: string, equivalents = 1.0, conc = 50): PredictorSubstrateInput => ({
  id: code,
  code,
  name: code,
  smiles,
  equivalents,
  concentrationMm: conc,
});

const COND = (over: Partial<WellConditionConfig> = {}): WellConditionConfig => ({
  medium: 'neutral',
  additiveName: '',
  additiveEquiv: 0,
  additivePka: 7,
  temperatureC: 80,
  waterPct: 0.5,
  solvent: 'DMSO',
  equivBasis: 'limiting',
  ...over,
});

beforeAll(async () => {
  rdkit = await initRDKitModule();
}, 30000);

describe('DMSO reactivity rules & solvent gating', () => {
  it('predicts Kornblum oxidation of phenacyl bromide to phenylglyoxal in DMSO (buffered 120 C) and blocks it in MeCN', () => {
    const dmsoRes = predictWellReactions(
      rdkit,
      [
        S('B', 'O=C(CBr)c1ccccc1', 2.0, 100), // Phenacyl bromide
        S('D', 'O=Cc1ncc[nH]1', 1.0, 50), // 2-Imidazolecarboxaldehyde
        S('E', 'Clc1ccc2[nH]cnc2c1', 1.0, 50), // 5-Chlorobenzimidazole
      ],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.5, additivePka: 0.9, temperatureC: 120, waterPct: 2.04, solvent: 'DMSO' })
    );

    const glyoxal = dmsoRes.species.find((s) => s.formula === 'C8H6O2' && s.smiles === 'O=CC(=O)c1ccccc1');
    expect(glyoxal).toBeDefined();
    expect(glyoxal!.score).toBeGreaterThanOrEqual(0.4);
    expect(glyoxal!.status).toBe('sink');
    expect(glyoxal!.bestChain[0].ruleId).toBe('OX_kornblum_haloketone');

    // No bogus bromo-enone aldol condensation from phenacyl bromide
    const bromoEnone = dmsoRes.species.find((s) => /C=C\(Br\)|BrC=C/.test(s.smiles));
    expect(bromoEnone).toBeUndefined();

    // Non-DMSO solvent must NOT trigger Kornblum oxidation
    const mecnRes = predictWellReactions(
      rdkit,
      [S('B', 'O=C(CBr)c1ccccc1', 1.0, 50)],
      COND({ temperatureC: 120, solvent: 'MeCN' })
    );
    expect(mecnRes.species.some((s) => s.bestChain.some((st) => st.ruleId.startsWith('OX_kornblum')))).toBe(false);
  }, 15000);

  it('supports Krapcho decarbalkoxylation, DMSO Pummerer -SMe, and DMSO C1 benzimidazole cyclization strictly in DMSO', () => {
    // Krapcho on diethyl malonate in wet hot DMSO
    const krapcho = predictWellReactions(
      rdkit,
      [S('A', 'CCOC(=O)CC(=O)OCC')],
      COND({ temperatureC: 130, waterPct: 1.5, solvent: 'DMSO' })
    );
    expect(krapcho.species.some((s) => s.formula === 'C4H8O2' && s.bestChain[0].ruleId === 'DC_krapcho_dmso')).toBe(true);

    // Krapcho blocked in EtOH
    const krapchoEtoh = predictWellReactions(
      rdkit,
      [S('A', 'CCOC(=O)CC(=O)OCC')],
      COND({ temperatureC: 130, waterPct: 1.5, solvent: 'EtOH' })
    );
    expect(krapchoEtoh.species.some((s) => s.bestChain.some((st) => st.ruleId === 'DC_krapcho_dmso'))).toBe(false);

    // Pummerer -SMe & C1 methylene on indole in hot acidic DMSO
    const indoleDmso = predictWellReactions(
      rdkit,
      [S('A', 'c1ccc2[nH]ccc2c1', 2.0, 100)],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.5, additivePka: 0.9, temperatureC: 120, solvent: 'DMSO' }),
      { includeSpeculative: true }
    );
    expect(indoleDmso.species.some((s) => s.formula === 'C9H9NS')).toBe(true); // 3-(methylthio)indole
    expect(indoleDmso.species.some((s) => s.formula === 'C17H14N2')).toBe(true); // 3,3'-bis(indolyl)methane

    // o-Phenylenediamine + hot acidic DMSO -> benzimidazole
    const opda = predictWellReactions(
      rdkit,
      [S('A', 'Nc1ccccc1N')],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 1.2, additivePka: 0.9, temperatureC: 120, solvent: 'DMSO' }),
      { includeSpeculative: true }
    );
    expect(opda.species.some((s) => s.formula === 'C7H6N2' && s.bestChain[0].ruleId === 'OX_dmso_c1_benzimidazole')).toBe(true);
  });

  it('emits dmso_reactivity incompatibility alert for acyl/sulfonyl halides in DMSO only', () => {
    const dmsoAlert = predictWellReactions(
      rdkit,
      [S('A', 'O=C(Cl)c1ccccc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25, solvent: 'DMSO' })
    );
    expect(dmsoAlert.alerts.some((a) => a.kind === 'dmso_reactivity')).toBe(true);

    const dcmAlert = predictWellReactions(
      rdkit,
      [S('A', 'O=C(Cl)c1ccccc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25, solvent: 'DCM' })
    );
    expect(dcmAlert.alerts.some((a) => a.kind === 'dmso_reactivity')).toBe(false);
  });
});

describe('Expanded core chemistry rules & regioselectivity', () => {
  it('predicts thiol SNAr (AR_S), phenol SNAr (AR_O), and active methylene C-alkylation (SN_C_fast)', () => {
    const arS = predictWellReactions(
      rdkit,
      [S('A', 'Fc1ccc([N+](=O)[O-])cc1'), S('B', 'Sc1ccccc1')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 1.0, additivePka: 13.9, temperatureC: 60 })
    );
    expect(arS.species.some((s) => s.formula === 'C12H9NO2S' && s.score >= 0.45)).toBe(true);

    const arO = predictWellReactions(
      rdkit,
      [S('A', 'Fc1ccc([N+](=O)[O-])cc1'), S('B', 'Oc1ccccc1')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 1.0, additivePka: 13.9, temperatureC: 90 })
    );
    expect(arO.species.some((s) => s.formula === 'C12H9NO3' && s.score >= 0.35)).toBe(true);

    const snC = predictWellReactions(
      rdkit,
      [S('A', 'BrCc1ccccc1'), S('B', 'N#CCC#N')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 1.0, additivePka: 13.9, temperatureC: 50 })
    );
    expect(snC.species.some((s) => s.formula === 'C10H8N2' && s.bestChain.some((st) => st.ruleId === 'SN_C_fast'))).toBe(true);
  });

  it('predicts cyclic anhydride ring opening, chloroformate/Boc2O carbamation, and classic heterocycle condensations', () => {
    // Succinic anhydride + benzylamine -> mono-amide acid (single connected molecule C11H13NO3)
    const cycAnh = predictWellReactions(
      rdkit,
      [S('A', 'O=C1CCC(=O)O1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 })
    );
    expect(cycAnh.species.some((s) => s.formula === 'C11H13NO3' && s.score >= 0.5)).toBe(true);

    // Boc2O + benzylamine -> Boc-benzylamine (C12H17NO2)
    const boc = predictWellReactions(
      rdkit,
      [S('A', 'CC(C)(C)OC(=O)OC(=O)OC(C)(C)C'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 })
    );
    expect(boc.species.some((s) => s.formula === 'C12H17NO2' && s.score >= 0.5)).toBe(true);

    // Acetylacetone + phenylhydrazine -> 1-phenyl-3,5-dimethylpyrazole (C11H12N2)
    const pyr = predictWellReactions(
      rdkit,
      [S('A', 'CC(=O)CC(=O)C'), S('B', 'NNc1ccccc1')],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 60 })
    );
    expect(pyr.species.some((s) => s.formula === 'C11H12N2' && s.bestChain[0].ruleId === 'PC_pyrazole_sub')).toBe(true);

    // 2-Aminopyridine + benzaldehyde + tert-butyl isocyanide -> GBB imidazo[1,2-a]pyridine (C17H19N3)
    const gbb = predictWellReactions(
      rdkit,
      [S('A', 'Nc1ccccn1'), S('B', 'O=Cc1ccccc1'), S('C', '[C-]#[N+]C(C)(C)C')],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 70 })
    );
    expect(gbb.species.some((s) => s.formula === 'C17H19N3' && s.bestChain.some((st) => st.ruleId === 'PC_gbb_imidazoazine'))).toBe(true);
  });

  it('prefers indole C3 over C2 and predicts bis(indolyl)methane under acid', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'c1ccc2[nH]ccc2c1', 2.0, 100), S('B', 'O=Cc1ccccc1', 1.0, 50)],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 60 })
    );
    const c3 = res.species.find((s) => s.smiles === 'OC(c1ccccc1)c1c[nH]c2ccccc12');
    const c2 = res.species.find((s) => s.smiles === 'OC(c1ccccc1)c1cc2ccccc2[nH]1');
    expect(c3).toBeDefined();
    if (c2) {
      expect(c3!.score).toBeGreaterThan(c2.score);
    }
    // Bis(indolyl)methane (C23H18N2)
    expect(res.species.some((s) => s.formula === 'C23H18N2' && s.score >= 0.35)).toBe(true);
  });

  it('oxidatively aromatizes o-phenylenediamine + benzaldehyde to 2-phenylbenzimidazole', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'Nc1ccccc1N'), S('B', 'O=Cc1ccccc1')],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 80, solvent: 'DMSO' })
    );
    const benzim = res.species.find((s) => s.formula === 'C13H10N2' && s.numAromaticRings === 3);
    expect(benzim).toBeDefined();
    expect(benzim!.score).toBeGreaterThanOrEqual(0.45);
  });

  it('completes carbinolamine -> imine dehydration and Pictet-Spengler cyclization in dense multi-component and buffered wells', () => {
    // 4-component well where bimolecular expansion hits maxSpecies: unimolecular maturation must still produce the imine & Pictet-Spengler product
    const fourSub = predictWellReactions(
      rdkit,
      [
        S('A', 'O=Cc1ncc[nH]1', 1.0, 50),
        S('B', 'O=C(CBr)c1ccccc1', 2.0, 100),
        S('C', 'NCCc1c[nH]c2ccccc12', 1.0, 50),
        S('D', 'Clc1ccc2[nH]cnc2c1', 1.0, 50),
      ],
      COND({ temperatureC: 120, waterPct: 2.04, solvent: 'DMSO' })
    );
    const imine4 = fourSub.species.find((s) => s.smiles === 'O=C(C=NCCc1c[nH]c2ccccc12)c1ccccc1');
    const ps4 = fourSub.species.find((s) => s.smiles === 'O=C(c1ccccc1)C1NCCc2c1[nH]c1ccccc21');
    expect(imine4).toBeDefined();
    expect(imine4!.score).toBeGreaterThanOrEqual(0.35);
    expect(ps4).toBeDefined();
    expect(ps4!.bestChain.some((st) => st.ruleId === 'EA_pictet_spengler_intra')).toBe(true);

    // Buffered acidic well (1 eq TsOH + tryptamine + phenacyl bromide): imine & Pictet-Spengler stay strong
    const buffered = predictWellReactions(
      rdkit,
      [S('B', 'O=C(CBr)c1ccccc1', 1.0, 50), S('C', 'NCCc1c[nH]c2ccccc12', 1.0, 50)],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 1.0, additivePka: 0.9, temperatureC: 120, waterPct: 2.04, solvent: 'DMSO' })
    );
    const imineBuf = buffered.species.find((s) => s.smiles === 'O=C(C=NCCc1c[nH]c2ccccc12)c1ccccc1');
    const psBuf = buffered.species.find((s) => s.smiles === 'O=C(c1ccccc1)C1NCCc2c1[nH]c1ccccc21');
    expect(imineBuf).toBeDefined();
    expect(imineBuf!.score).toBeGreaterThanOrEqual(0.3);
    expect(psBuf).toBeDefined();
    expect(psBuf!.score).toBeGreaterThanOrEqual(0.35);
  }, 20000);
});

