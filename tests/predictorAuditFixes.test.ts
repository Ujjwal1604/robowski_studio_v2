import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  PredictorSubstrateInput,
  WellConditionConfig,
  REACTION_RULES,
} from '../src/engine/predictor';
import { estimateElectronicFactor } from '../src/engine/predictor/scoring';

let rdkit: any;
beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  rdkit = await (mod.default || mod)();
});

const S = (code: string, smiles: string, eq = 1, concMm?: number): PredictorSubstrateInput => ({
  id: code,
  code,
  name: code,
  smiles,
  equivalents: eq,
  concentrationMm: concMm ?? 50 * eq,
});

const COND = (o: Partial<WellConditionConfig> = {}): WellConditionConfig => ({
  medium: 'auto',
  additiveName: '',
  additiveEquiv: 0,
  additivePka: 0,
  temperatureC: 25,
  waterPct: 2,
  solvent: 'DMSO',
  equivBasis: 'limiting',
  ...o,
});

describe('Audit #1: SNAr ortho/para activation (not meta) and fast tier', () => {
  it('4-F-nitrobenzene + morpholine at 80 C hits activated SNAr (not AR_het_broad), while 3-F-nitrobenzene stays Speculative', () => {
    const cond = COND({ temperatureC: 80 });
    const paraRes = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(F)cc1'), S('B', 'C1COCCN1')],
      cond,
      { includeSpeculative: true }
    );
    const metaRes = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1cccc(F)c1'), S('B', 'C1COCCN1')],
      cond,
      { includeSpeculative: true }
    );

    const paraSnar = paraRes.species.find((s) => s.bestChain.some((st) => st.stepLabel === 'AR'));
    const metaSnar = metaRes.species.find((s) => s.bestChain.some((st) => st.stepLabel === 'AR'));

    expect(paraSnar).toBeDefined();
    expect(['AR_N_fast', 'AR_N']).toContain(paraSnar!.bestChain[0].ruleId);
    expect(['High', 'Medium']).toContain(paraSnar!.tier);
    expect(paraSnar!.score).toBeGreaterThan(0.35);

    expect(metaSnar).toBeDefined();
    expect(metaSnar!.bestChain[0].ruleId).toBe('AR_het_broad');
    expect(metaSnar!.tier).toBe('Speculative');
    expect(paraSnar!.score).toBeGreaterThan(metaSnar!.score * 4);
  });

  it('4-Cl-nitrobenzene + aniline at 80 C hits activated AR_N instead of AR_het_broad', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(Cl)cc1'), S('B', 'Nc1ccccc1')],
      COND({ temperatureC: 80, medium: 'base', additiveName: 'DIPEA', additiveEquiv: 2, additivePka: 11.4 }),
      { includeSpeculative: true }
    );
    const snar = res.species.find((s) => s.bestChain.some((st) => st.stepLabel === 'AR'));
    expect(snar).toBeDefined();
    expect(snar!.bestChain[0].ruleId).toBe('AR_N');
    expect(snar!.score).toBeGreaterThan(0.25);
  });

  it('4-F-benzonitrile + piperidine at 80 C ranks SNAr above amidine (NA_N_nitrile)', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'N#Cc1ccc(F)cc1'), S('B', 'C1CCNCC1')],
      COND({ temperatureC: 80 }),
      { includeSpeculative: true }
    );
    const snar = res.species.find((s) => s.bestChain[0]?.stepLabel === 'AR');
    const amidine = res.species.find((s) => s.bestChain[0]?.ruleId === 'NA_N_nitrile');
    expect(snar).toBeDefined();
    expect(snar!.bestChain[0].ruleId).toBe('AR_N');
    if (amidine) {
      expect(snar!.score).toBeGreaterThan(amidine.score);
    }
  });

  it('2,4-difluoronitrobenzene + benzylamine reacts cleanly at 25 C (Medium/High), while 2-Cl-pyridine stays Speculative at 25 C', () => {
    const dfnb = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(F)cc1F'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 }),
      { includeSpeculative: true }
    );
    const dfnbSnar = dfnb.species.find((s) => s.bestChain[0]?.stepLabel === 'AR');
    expect(dfnbSnar).toBeDefined();
    expect(['High', 'Medium']).toContain(dfnbSnar!.tier);
    expect(dfnbSnar!.score).toBeGreaterThan(0.28);

    const clNitroPyr = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(Cl)nc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 }),
      { includeSpeculative: true }
    );
    const clNitroPyrSnar = clNitroPyr.species.find((s) => s.bestChain[0]?.stepLabel === 'AR');
    expect(clNitroPyrSnar).toBeDefined();
    expect(clNitroPyrSnar!.bestChain[0].ruleId).toBe('AR_N_double_fast');
    expect(['High', 'Medium']).toContain(clNitroPyrSnar!.tier);

    const clPyr = predictWellReactions(
      rdkit,
      [S('A', 'Clc1ccccn1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 }),
      { includeSpeculative: true }
    );
    const clPyrSnar = clPyr.species.find((s) => s.bestChain[0]?.stepLabel === 'AR');
    if (clPyrSnar) {
      expect(clPyrSnar.tier).toBe('Speculative');
    }
  });
});

describe('Audit #2: CARBON_ACID_SINGLE excludes benzylic hydrocarbons and includes 4-picoline', () => {
  const base80 = COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 1, additivePka: 13.9, temperatureC: 80 });

  it('PhCHO + toluene / ethylbenzene / 2-methylfuran produce NO aldol product', () => {
    for (const [label, smi] of [
      ['toluene', 'Cc1ccccc1'],
      ['ethylbenzene', 'CCc1ccccc1'],
      ['2-methylfuran', 'Cc1ccco1'],
    ]) {
      const res = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', smi)], base80, {
        includeSpeculative: true,
      });
      const aldol = res.species.filter((s) => s.bestChain.some((st) => st.ruleId === 'NA_C_carbonyl_single'));
      expect(aldol, `${label} should not form aldol adduct`).toHaveLength(0);
    }
  });

  it('PhCHO + 4-picoline (and 2-picoline) DOES qualify as a single-EWG carbon acid', () => {
    for (const [label, smi] of [
      ['4-picoline', 'Cc1ccncc1'],
      ['2-picoline', 'Cc1ccccn1'],
    ]) {
      const res = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', smi)], base80, {
        includeSpeculative: true,
      });
      const hit = res.species.find((s) => s.bestChain.some((st) => st.ruleId === 'NA_C_carbonyl_single'));
      expect(hit, `${label} should match NA_C_carbonyl_single`).toBeDefined();
    }
  });
});

describe('Audit #3: Substrate-aware SN2 reactivity tiers and steric/polyhalo forbids', () => {
  it('benzyl bromide + aniline at 25 C scores Medium/High via SN_N_fast', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'BrCc1ccccc1'), S('B', 'Nc1ccccc1')],
      COND({ temperatureC: 25 })
    );
    const sn = res.species.find((s) => s.bestChain[0]?.stepLabel === 'SN(N)');
    expect(sn).toBeDefined();
    expect(sn!.bestChain[0].ruleId).toBe('SN_N_fast');
    expect(['High', 'Medium']).toContain(sn!.tier);
    expect(sn!.score).toBeGreaterThan(0.32);
  });

  it('t-BuCl, neopentyl bromide, and CHCl3 produce NO SN2 product with benzylamine at 60 C', () => {
    const cond60 = COND({ temperatureC: 60 });
    for (const [label, smi] of [
      ['t-BuCl', 'CC(C)(C)Cl'],
      ['neopentyl bromide', 'CC(C)(C)CBr'],
      ['chloroform', 'ClC(Cl)Cl'],
    ]) {
      const res = predictWellReactions(rdkit, [S('A', smi), S('B', 'NCc1ccccc1')], cond60, {
        includeSpeculative: true,
      });
      const sn = res.species.filter((s) => s.bestChain.some((st) => st.stepLabel === 'SN(N)'));
      expect(sn, `${label} must not undergo SN2`).toHaveLength(0);
    }
  });
});

describe('Audit #4: Newly added reactive families & unmodeled-group safety alert', () => {
  it('benzoyl chloride, acetic anhydride, phenyl isocyanate, TsCl, and styrene oxide all react with benzylamine', () => {
    const cases: Array<{ name: string; smi: string; temp: number; expectFormula: string }> = [
      { name: 'benzoyl chloride', smi: 'O=C(Cl)c1ccccc1', temp: 25, expectFormula: 'C14H13NO' },
      { name: 'acetic anhydride', smi: 'CC(=O)OC(=O)C', temp: 25, expectFormula: 'C9H11NO' },
      { name: 'phenyl isocyanate', smi: 'O=C=Nc1ccccc1', temp: 25, expectFormula: 'C14H14N2O' },
      { name: 'TsCl', smi: 'Cc1ccc(S(=O)(=O)Cl)cc1', temp: 25, expectFormula: 'C14H15NO2S' },
      { name: 'styrene oxide', smi: 'c1ccc(C2CO2)cc1', temp: 50, expectFormula: 'C15H17NO' },
    ];
    for (const c of cases) {
      const res = predictWellReactions(
        rdkit,
        [S('A', c.smi), S('B', 'NCc1ccccc1')],
        COND({ temperatureC: c.temp })
      );
      const prod = res.species.find((s) => s.formula === c.expectFormula);
      expect(prod, `${c.name} should yield ${c.expectFormula}`).toBeDefined();
      expect(['High', 'Medium'], `${c.name} should be Medium/High`).toContain(prod!.tier);
    }
  });

  it('activated esters (NHS, PFP, p-nitrophenyl) react at 25 C while methyl ester stays inactive at 25 C', () => {
    const activated: Array<[string, string]> = [
      ['NHS benzoate', 'O=C(ON1C(=O)CCC1=O)c1ccccc1'],
      ['PFP benzoate', 'O=C(Oc1c(F)c(F)c(F)c(F)c1F)c1ccccc1'],
      ['p-nitrophenyl benzoate', 'O=C(Oc1ccc([N+](=O)[O-])cc1)c1ccccc1'],
    ];
    for (const [label, smi] of activated) {
      const res = predictWellReactions(
        rdkit,
        [S('A', smi), S('B', 'NCc1ccccc1')],
        COND({ temperatureC: 25 })
      );
      const amide = res.species.find((s) => s.formula === 'C14H13NO');
      expect(amide, `${label} should form amide at 25 C`).toBeDefined();
      expect(['High', 'Medium']).toContain(amide!.tier);
    }

    const methylRes = predictWellReactions(
      rdkit,
      [S('A', 'COC(=O)c1ccccc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 })
    );
    expect(methylRes.species.find((s) => s.formula === 'C14H13NO')).toBeUndefined();
  });

  it('alkyl tosylate and mesylate react with benzylamine', () => {
    for (const [label, smi, expectedFormula] of [
      ['ethyl tosylate', 'CCOS(=O)(=O)c1ccc(C)cc1', 'C9H13N'],
      ['benzyl mesylate', 'CS(=O)(=O)OCc1ccccc1', 'C14H15N'],
    ]) {
      const res = predictWellReactions(
        rdkit,
        [S('A', smi), S('B', 'NCc1ccccc1')],
        COND({ temperatureC: 50 })
      );
      const hit = res.species.find((s) => s.formula === expectedFormula);
      expect(hit, `${label} should alkylate benzylamine`).toBeDefined();
      expect(['High', 'Medium']).toContain(hit!.tier);
    }
  });

  it('aryl iodide and aryl triflate undergo SNAr when activated', () => {
    const iRes = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(I)cc1'), S('B', 'C1COCCN1')],
      COND({ temperatureC: 80 })
    );
    expect(iRes.species.find((s) => s.bestChain[0]?.stepLabel === 'AR')).toBeDefined();

    const otfRes = predictWellReactions(
      rdkit,
      [S('A', 'O=[N+]([O-])c1ccc(OS(=O)(=O)C(F)(F)F)cc1'), S('B', 'C1COCCN1')],
      COND({ temperatureC: 80 })
    );
    const otfSnar = otfRes.species.find((s) => s.bestChain[0]?.ruleId === 'AR_triflate_N');
    expect(otfSnar).toBeDefined();
    expect(['High', 'Medium']).toContain(otfSnar!.tier);
  });

  it('Biginelli: PhCHO + urea + ethyl acetoacetate produces dihydropyrimidinone (C14H16N2O3)', () => {
    const res = predictWellReactions(
      rdkit,
      [
        S('A', 'O=Cc1ccccc1'),
        S('B', 'NC(=O)N'),
        S('C', 'CCOC(=O)CC(=O)C'),
      ],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 80 })
    );
    const dhpm = res.species.find((s) => s.formula === 'C14H16N2O3');
    expect(dhpm).toBeDefined();
    expect(dhpm!.bestChain.some((st) => st.ruleId === 'PC_biginelli_cyclization')).toBe(true);
  });

  it('emits unmodeled_reactive_group alert for unmodeled reactive motifs (e.g. carbodiimide, boronic acid)', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'OB(O)c1ccccc1'), S('B', 'C1CCCCC1N=C=NC2CCCCC2')],
      COND({ temperatureC: 25 })
    );
    const alerts = res.alerts.filter((a) => a.kind === 'unmodeled_reactive_group');
    expect(alerts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Audit #5: Ranking distortions & structural electronics', () => {
  it('benzaldehyde + aniline imine outranks acetophenone + aniline ketimine', () => {
    const cond = COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 80 });
    const aldRes = predictWellReactions(rdkit, [S('A', 'O=Cc1ccccc1'), S('B', 'Nc1ccccc1')], cond);
    const ketRes = predictWellReactions(rdkit, [S('A', 'CC(=O)c1ccccc1'), S('B', 'Nc1ccccc1')], cond, {
      includeSpeculative: true,
    });
    const aldimine = aldRes.species.find((s) => s.formula === 'C13H11N')!;
    const ketimine = ketRes.species.find((s) => s.formula === 'C14H13N')!;
    expect(aldimine).toBeDefined();
    expect(ketimine).toBeDefined();
    expect(aldimine.score).toBeGreaterThan(ketimine.score * 1.3);
  });

  it('4-F-acetophenone + piperidine at 80 C ranks SNAr above simple enamine', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'CC(=O)c1ccc(F)cc1'), S('B', 'C1CCNCC1')],
      COND({ temperatureC: 80 }),
      { includeSpeculative: true }
    );
    const snar = res.species.find((s) => s.bestChain[0]?.stepLabel === 'AR');
    const enamine = res.species.find((s) => s.bestChain.some((st) => st.ruleId === 'DH_enamine'));
    expect(snar).toBeDefined();
    if (enamine) {
      expect(snar!.score).toBeGreaterThan(enamine.score);
    }
  });

  it('ethyl acrylate outranks acrylamide in Michael addition with amine', () => {
    const cond = COND({ temperatureC: 40 });
    const acrylRes = predictWellReactions(rdkit, [S('A', 'CCOC(=O)C=C'), S('B', 'NCc1ccccc1')], cond, {
      includeSpeculative: true,
    });
    const amideRes = predictWellReactions(rdkit, [S('A', 'NC(=O)C=C'), S('B', 'NCc1ccccc1')], cond, {
      includeSpeculative: true,
    });
    const acrylateAdduct = acrylRes.species.find((s) => s.bestChain[0]?.ruleId === 'MI_N')!;
    const acrylamideAdduct = amideRes.species.find((s) => s.bestChain[0]?.stepLabel === 'MI(N)')!;
    expect(acrylateAdduct).toBeDefined();
    expect(acrylamideAdduct).toBeDefined();
    expect(acrylateAdduct.score).toBeGreaterThan(acrylamideAdduct.score * 1.5);
  });

  it('Boc carbamate deprotection yields free amine via EL_Boc_amine without spurious carbamic acid via EL_tBu_ester', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'CC(C)(C)OC(=O)NCc1ccccc1')],
      COND({ medium: 'acid', additiveName: 'TFA', additiveEquiv: 5, additivePka: 0.2, temperatureC: 60 }),
      { includeSpeculative: true }
    );
    const amine = res.species.find((s) => s.formula === 'C7H9N');
    const carbamicAcid = res.species.find((s) => s.formula === 'C8H9NO2');
    expect(amine).toBeDefined();
    expect(carbamicAcid).toBeUndefined();
  });

  it('electronic factor ignores spectator -CF3 and spectator aryl-I', () => {
    const arRule = REACTION_RULES.find((r) => r.id === 'AR_N')!;
    const snRule = REACTION_RULES.find((r) => r.id === 'SN_N')!;

    // 4-Cl-benzotrifluoride has CF3 (spectator F), NOT aryl-F leaving group
    const cf3ClFactor = estimateElectronicFactor(arRule, ['Clc1ccc(C(F)(F)F)cc1', 'C1COCCN1'], rdkit);
    const arylFFactor = estimateElectronicFactor(arRule, ['O=[N+]([O-])c1ccc(F)cc1', 'C1COCCN1'], rdkit);
    expect(arylFFactor).toBeGreaterThan(cf3ClFactor);

    // 1-chloro-4-iodobenzene has aryl-I (not alkyl-I), while alkyl-Cl is the SN2 LG
    const spectatorIFactor = estimateElectronicFactor(snRule, ['ClCCCc1ccc(I)cc1', 'NCc1ccccc1'], rdkit);
    const alkylIFactor = estimateElectronicFactor(snRule, ['ICCCc1ccccc1', 'NCc1ccccc1'], rdkit);
    expect(alkylIFactor).toBeGreaterThan(spectatorIFactor);
  });

  it('ethyl acetoacetate + benzylamine produces conjugated enaminone labeled DH_enaminone (not DH_aldol)', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'CCOC(=O)CC(=O)C'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 60 })
    );
    const enaminone = res.species.find((s) => s.formula === 'C13H17NO2');
    expect(enaminone).toBeDefined();
    expect(enaminone!.bestChain.some((st) => st.ruleId === 'DH_enaminone')).toBe(true);
    expect(enaminone!.bestChain.some((st) => st.ruleId === 'DH_aldol')).toBe(false);
    expect(['High', 'Medium']).toContain(enaminone!.tier);
  });
});

describe('Audit #6: Search truncation reporting and baseline regressions', () => {
  it('sets stats.truncated = true and emits search_truncated alert when cap is reached, false on small wells', () => {
    const smallRes = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'Nc1ccccc1')],
      COND({ temperatureC: 60 })
    );
    expect(smallRes.stats.truncated).toBe(false);
    expect(smallRes.stats.truncationReason).toBeNull();
    expect(smallRes.alerts.some((a) => a.kind === 'search_truncated')).toBe(false);

    const cappedRes = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'N#CCC#N'), S('C', 'Nc1ccccc1'), S('D', 'O=C1CCCC1')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 0.5, additivePka: 13.9, temperatureC: 80 }),
      { maxExpansions: 5 }
    );
    expect(cappedRes.stats.truncated).toBe(true);
    expect(cappedRes.stats.truncationReason).toBe('max_expansions');
    expect(cappedRes.alerts.some((a) => a.kind === 'search_truncated')).toBe(true);
  });

  it('preserves baseline correct rules (acylhydrazone, oxime, maleimide+thiol, acid+amine@25C blank)', () => {
    const hydrazone = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'O=C(NN)c1ccccc1')],
      COND({ temperatureC: 25 })
    );
    expect(hydrazone.species.find((s) => s.formula === 'C14H12N2O')).toBeDefined();

    const oxime = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'NO')],
      COND({ temperatureC: 25 })
    );
    expect(oxime.species.find((s) => s.formula === 'C7H7NO')).toBeDefined();

    const maleimide = predictWellReactions(
      rdkit,
      [S('A', 'O=C1C=CC(=O)N1C'), S('B', 'CCS')],
      COND({ temperatureC: 25 })
    );
    expect(maleimide.species.find((s) => s.formula === 'C7H11NO2S')).toBeDefined();

    const acidAmine = predictWellReactions(
      rdkit,
      [S('A', 'O=C(O)c1ccccc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 25 })
    );
    expect(acidAmine.species.find((s) => s.formula === 'C14H13NO')).toBeUndefined();
  });
});
