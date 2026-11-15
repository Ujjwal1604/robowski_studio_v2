import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  computeSpeciesHighlightBonds,
  REACTION_RULES,
  TAUTOMER_RULES,
  PredictorSubstrateInput,
  WellConditionConfig,
} from '../src/engine/predictor';
import { drawSmilesWithRDKit } from '../src/utils/rdkit';

let rdkit: any;

beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  const initFn = mod.default || mod;
  rdkit = await initFn();
});

describe('New-Bond Highlighting in Cascade Products', () => {
  it('compiles RHS SMARTS cleanly for every reaction and tautomer rule', () => {
    for (const rule of [...REACTION_RULES, ...TAUTOMER_RULES]) {
      const rhs = rule.smarts.split('>>')[1].split('.')[0].replace(/:\d+(?=\])/g, '');
      const qmol = rdkit.get_qmol(rhs);
      expect(qmol, `Rule ${rule.id} RHS failed`).toBeTruthy();
      qmol.delete();
    }
  });

  it('highlights newly formed C=N imine bond in benzaldehyde + aniline reaction and renders highlight paths in SVG', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1 },
      { id: 'B', code: 'B', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.2,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 1,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };
    const res = predictWellReactions(rdkit, subs, cond);
    const imine = res.species.find((sp) => sp.formula === 'C13H11N');
    expect(imine).toBeDefined();

    const hl = computeSpeciesHighlightBonds(rdkit, imine!);
    expect(hl.lastStepBonds.length).toBe(1);
    expect(hl.allNewBonds.length).toBeGreaterThanOrEqual(1);

    const mol = rdkit.get_mol(imine!.smiles);
    const json = JSON.parse(mol.get_json()).molecules[0];
    mol.delete();
    const bIdx = hl.lastStepBonds[0];
    const [u, v] = json.bonds[bIdx].atoms;
    const zPair = [json.atoms[u].z ?? 6, json.atoms[v].z ?? 6].sort((a, b) => a - b);
    // Must be the C=N imine bond (atomic numbers 6 and 7, bond order 2)
    expect(zPair).toEqual([6, 7]);
    expect(json.bonds[bIdx].bo).toBe(2);

    const svg = drawSmilesWithRDKit(rdkit, imine!.smiles, {
      width: 264,
      height: 172,
      highlightBonds: hl.allNewBonds,
    });
    expect(svg).toBeTruthy();
    expect(svg!).toContain('#8CEFCC');
    expect(svg!).toContain('fill-opacity:1');
  });

  it('accumulates all newly formed bonds across a multi-step Knoevenagel + Michael cascade', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1 },
      { id: 'B', code: 'B', name: 'Malononitrile', smiles: 'N#CCC#N', equivalents: 1 },
      { id: 'C', code: 'C', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'base',
      additiveName: 'DBU',
      additiveEquiv: 0.5,
      additivePka: 13.9,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };
    const res = predictWellReactions(rdkit, subs, cond);
    const michael = res.species.find(
      (sp) => sp.formula === 'C16H13N3' && sp.bestChain.some((s) => s.stepLabel === 'MI(N)')
    );
    expect(michael).toBeDefined();

    const hl = computeSpeciesHighlightBonds(rdkit, michael!);
    expect(hl.lastStepBonds.length).toBeGreaterThanOrEqual(1);
    // All newly formed bonds include both the Knoevenagel C-C bond and the Michael C-N bond
    expect(hl.allNewBonds.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves E/Z guanidine imine bonds and accumulates multi-step bonds in 4-fluorobenzaldehyde + N-Boc-aminoethylguanidine + chalcone', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: '4-Fluorobenzaldehyde', smiles: 'O=Cc1ccc(F)cc1', equivalents: 1 },
      { id: 'D', code: 'D', name: 'N-Boc-aminoethylguanidine', smiles: 'CC(C)(C)OC(=O)NCCN=C(N)N', equivalents: 1 },
      { id: 'E', code: 'E', name: 'Chalcone', smiles: 'O=C(C=Cc1ccccc1)c1ccccc1', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'buffer',
      additiveName: 'DBU',
      additiveEquiv: 1,
      additivePka: 13.6,
      temperatureC: 80,
      waterPct: 2.0,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };
    const res = predictWellReactions(rdkit, subs, cond);
    expect(res.species.length).toBeGreaterThan(10);

    // Every predicted species in this cascade should resolve at least one newly formed bond
    const zeroHighlight = res.species.filter(
      (sp) => computeSpeciesHighlightBonds(rdkit, sp).allNewBonds.length === 0
    );
    expect(zeroHighlight.length).toBe(0);

    // 3-step dihydropyrimidine/cyclic adduct (MI(N) -> NA(N) -> DH) carries both Michael and condensation bonds
    const lead3 = res.species.find(
      (sp) => sp.formula === 'C23H28N4O2' && sp.bestChain.length === 3
    );
    expect(lead3).toBeDefined();
    expect(computeSpeciesHighlightBonds(rdkit, lead3!).allNewBonds.length).toBe(2);

    // 4-step 3-component adduct (MI(N) -> NA(N) -> NA(N) -> DH) carries all 3 forged bonds
    const lead4 = res.species.find(
      (sp) =>
        sp.formula === 'C30H33FN4O3' &&
        sp.bestChain.length === 4 &&
        sp.bestChain[0].stepLabel === 'MI(N)'
    );
    expect(lead4).toBeDefined();
    expect(computeSpeciesHighlightBonds(rdkit, lead4!).allNewBonds.length).toBe(3);
  }, 20000);
});
