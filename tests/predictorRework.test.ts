import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  PredictorSubstrateInput,
  WellConditionConfig,
  REACTION_RULES,
} from '../src/engine/predictor';
import { stepIsAtomBalanced, parseFormula, countSubstruct } from '../src/engine/predictor/molQueries';
import { estimateStericFactor, equilibriumPersistence } from '../src/engine/predictor/scoring';

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
const carbons = (f: string) => parseFormula(f).C || 0;
const nitrogens = (f: string) => parseFormula(f).N || 0;

describe('atom bookkeeping', () => {
  it('parses formulas and checks balance', () => {
    expect(parseFormula('C27H22N6O')).toEqual({ C: 27, H: 22, N: 6, O: 1 });
    expect(stepIsAtomBalanced(['C7H6O', 'C6H7N'], ['C13H11N', 'H2O'])).toBe(true);
    expect(stepIsAtomBalanced(['C7H6O', 'C6H7N'], ['C13H11N'])).toBe(true);
    expect(stepIsAtomBalanced(['C7H6O', 'C6H7N'], ['C12H11N'])).toBe(false);
    expect(stepIsAtomBalanced(['C7H6O', 'C6H7N'], ['C13H12N2O'])).toBe(false);
    expect(stepIsAtomBalanced(['C11H20O4'], ['C7H12O4'])).toBe(false);
    expect(stepIsAtomBalanced(['C11H20O4'], ['C7H12O4'], true)).toBe(true);
  });

  it('no predicted species loses or invents carbon/nitrogen in a 4-component well', () => {
    const subs = [
      S('A', 'O=Cc1ccccc1'),
      S('B', 'N#CCC#N'),
      S('C', 'Nc1ccccc1'),
      S('D', 'O=C1CCCC1'),
    ];
    const res = predictWellReactions(
      rdkit,
      subs,
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 0.5, additivePka: 13.9, temperatureC: 80 })
    );
    expect(res.species.length).toBeGreaterThan(20);
    for (const sp of res.species) {
      const sumC = res.substrates.reduce((a, sub, i) => a + carbons(sub.formula) * (sp.inventory[i] || 0), 0);
      const sumN = res.substrates.reduce((a, sub, i) => a + nitrogens(sub.formula) * (sp.inventory[i] || 0), 0);
      expect(carbons(sp.formula), `${sp.smiles} carbon`).toBe(sumC);
      expect(nitrogens(sp.formula), `${sp.smiles} nitrogen`).toBe(sumN);
    }
  });
});

describe('structural steric checks', () => {
  it('counts both tert-butyl groups however the SMILES is written', () => {
    expect(countSubstruct(rdkit, 'CC(C)(C)OC(=O)CC(=O)OC(C)(C)C', '[CX4;H0]([CH3])([CH3])[CH3]')).toBe(2);
    expect(countSubstruct(rdkit, 'O=C(CC(=O)OC(C)(C)C)OC(C)(C)C', '[CX4;H0]([CH3])([CH3])[CH3]')).toBe(2);
  });

  it('penalizes a di-tert-butyl substrate twice regardless of atom order', () => {
    const rule = REACTION_RULES.find((r) => r.stericRule === 'alpha_branching')!;
    const a = estimateStericFactor(rule, ['CC(C)(C)OC(=O)CC(=O)OC(C)(C)C'], rdkit);
    const b = estimateStericFactor(rule, ['O=C(CC(=O)OC(C)(C)C)OC(C)(C)C'], rdkit);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeCloseTo(0.74 * 0.74, 3);
  });
});

describe('scoring rework and LC-MS in-source ions', () => {
  it('imine formation under acid at 80 C is Medium (even in 15 mM wells) and outranks its carbinolamine', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'Nc1ccccc1')],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 80 })
    );
    const imine = res.species.find((s) => s.formula === 'C13H11N')!;
    const hemi = res.species.find((s) => s.formula === 'C13H13NO')!;
    expect(imine.tier).toBe('Medium');
    expect(imine.score).toBeGreaterThan(hemi.score);
    expect(imine.reversibleEnd).toBe(true);
    expect(imine.persistence).toBeGreaterThan(hemi.persistence);

    // Also stays Medium at realistic 15 mM screening concentration
    const resDilute = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1', 1, 15), S('B', 'Nc1ccccc1', 1, 15)],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.2, additivePka: 0.9, temperatureC: 80 })
    );
    const imineDilute = resDilute.species.find((s) => s.formula === 'C13H11N')!;
    expect(imineDilute.tier).toBe('Medium');
  });

  it('uncatalyzed ester aminolysis is not rated above an acid-catalyzed imine', () => {
    const amide = predictWellReactions(
      rdkit,
      [S('A', 'COC(=O)c1ccccc1'), S('B', 'NCc1ccccc1')],
      COND({ temperatureC: 120 })
    ).species.find((s) => s.formula === 'C14H13NO')!;
    expect(amide.tier).not.toBe('Medium');
    expect(amide.tier).not.toBe('High');
    expect(amide.persistence).toBe(1);
  });

  it('long cascades are discounted relative to short ones', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'N#CCC#N'), S('C', 'Nc1ccccc1'), S('D', 'O=C1CCCC1')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 0.5, additivePka: 13.9, temperatureC: 80 })
    );
    const long = res.species.filter((s) => s.stepsCount >= 5);
    expect(long.every((s) => s.tier !== 'High')).toBe(true);
    const short = res.species.filter((s) => s.stepsCount <= 2 && s.status === 'sink');
    expect(Math.max(...short.map((s) => s.score))).toBeGreaterThan(Math.max(...long.map((s) => s.score)));
  });

  it('dilution lowers scores of bimolecular steps; water lowers dehydration persistence', () => {
    const subsHi = [S('A', 'O=Cc1ccccc1', 1), S('B', 'Nc1ccccc1', 1)];
    const subsLo = subsHi.map((s) => ({ ...s, concentrationMm: 5 }));
    const hi = predictWellReactions(rdkit, subsHi, COND({ temperatureC: 80 })).species.find((s) => s.formula === 'C13H11N')!;
    const lo = predictWellReactions(rdkit, subsLo, COND({ temperatureC: 80 })).species.find((s) => s.formula === 'C13H11N')!;
    expect(lo.likelihood).toBeLessThan(hi.likelihood);
    const chain = hi.bestChain;
    expect(equilibriumPersistence(chain, { concMm: 50, waterPct: 0.2 })).toBeGreaterThan(
      equilibriumPersistence(chain, { concMm: 50, waterPct: 10 })
    );
  });

  it('reports likelihood and persistence, with irreversible sinks at persistence 1', () => {
    const res = predictWellReactions(
      rdkit,
      [S('A', 'O=Cc1ccccc1'), S('B', 'N#CCC#N')],
      COND({ medium: 'base', additiveName: 'DBU', additiveEquiv: 0.2, additivePka: 13.9 })
    );
    const sink = res.species.find((s) => s.formula === 'C10H6N2')!;
    expect(sink.persistence).toBe(1);
    expect(sink.likelihood).toBeCloseTo(sink.score, 2);
    for (const s of res.species) {
      expect(s.score).toBeLessThanOrEqual(s.likelihood + 1e-9);
    }
  });

  it('does not mislabel N-Boc carbamate products as tert-butyl esters', () => {
    const res = predictWellReactions(
      rdkit,
      [
        S('A', 'O=Cc1ccc(F)cc1'),
        S('D', 'CC(C)(C)OC(=O)NCCN=C(N)N'),
      ],
      COND({ medium: 'acid', additiveName: 'TsOH', additiveEquiv: 0.5, additivePka: 0.9, temperatureC: 80 })
    );
    const bocProducts = res.species.filter((sp) => sp.lossIons.some((l) => l.label === '[M+H-Boc]+'));
    expect(bocProducts.length).toBeGreaterThan(0);
    for (const sp of bocProducts) {
      expect(sp.lossIons.some((l) => l.label === '[M+H-C4H8]+')).toBe(false);
    }
  });
});

describe('guanidine + quinoline aldehyde + malonate well', () => {
  const subs = [
    S('A', 'N=C(N)NCc1ccncc1'),
    S('D', 'O=Cc1ccc2ccccc2n1', 2),
    S('E', 'CC(C)(C)OC(=O)CC(=O)OC(C)(C)C'),
  ];
  let res: ReturnType<typeof predictWellReactions>;
  beforeAll(() => {
    res = predictWellReactions(rdkit, subs, COND());
  });

  it('does not couple a carbinolamine carbon to a second aldehyde (no benzoin-type chains)', () => {
    const bad = res.species.filter((s) => {
      const ids = s.bestChain.map((c) => c.ruleId);
      const k = ids.indexOf('NA_N_carbonyl');
      return k >= 0 && ids.slice(k + 1).includes('NA_C_carbonyl_single');
    });
    expect(bad).toHaveLength(0);
    expect(res.species.find((s) => s.formula === 'C17H15N5')).toBeDefined();
  });

  it('flags carbinolamines and t-butyl esters with in-source loss ions', () => {
    const hemi = res.species.find((s) => s.formula === 'C17H17N5O')!;
    const loss = hemi.lossIons.find((l) => l.label === '[M+H-H2O]+')!;
    expect(loss).toBeDefined();
    const imine = res.species.find((s) => s.formula === 'C17H15N5')!;
    expect(Math.abs(loss.mz - imine.mhPlus)).toBeLessThan(0.002);
    const ester = res.species.find((s) => s.lossIons.some((l) => l.label === '[M+H-C4H8]+'));
    expect(ester).toBeDefined();
  });

  it('keys 1,3- and 1,1-substituted guanidine adducts separately', () => {
    const forms = res.species.filter((s) => s.formula === 'C17H17N5O');
    const keys = new Set(forms.map((f) => f.tautomerKey));
    expect(keys.size).toBe(forms.length);
  });
});
