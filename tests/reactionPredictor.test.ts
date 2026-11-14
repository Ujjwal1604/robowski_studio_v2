import { describe, it, expect, beforeAll } from 'vitest';
import {
  REACTION_RULES,
  parseSubstrateAndSalts,
  solveAcidBaseEquilibrium,
  predictWellReactions,
  PredictorSubstrateInput,
  WellConditionConfig,
} from '../src/engine/predictor';

let rdkit: any;

beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  const initFn = mod.default || mod;
  rdkit = await initFn();
});

describe('Reaction Predictor Engine (RDKit WASM)', () => {
  it('compiles all SMARTS reaction rules cleanly without errors', () => {
    for (const rule of REACTION_RULES) {
      const rxn = rdkit.get_rxn(rule.smarts);
      expect(rxn, `Rule ${rule.id} failed to compile SMARTS: ${rule.smarts}`).toBeTruthy();
      expect(rxn.run_reactants).toBeTypeOf('function');
    }
  });

  it('predicts Benzaldehyde + Malononitrile + Aniline cascade under acid and base', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: '1', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1 },
      { id: '2', code: 'B', name: 'Malononitrile', smiles: 'N#CCC#N', equivalents: 1 },
      { id: '3', code: 'C', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1 },
    ];
    const condBase: WellConditionConfig = {
      medium: 'base',
      additiveName: 'DBU',
      additiveEquiv: 0.5,
      additivePka: 13.9,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, condBase);
    expect(res.species.length).toBeGreaterThanOrEqual(3);

    // Knoevenagel adduct N#CC(=Cc1ccccc1)C#N should be high/medium stable sink
    const knoevenagel = res.species.find((s) => s.formula === 'C10H6N2');
    expect(knoevenagel).toBeDefined();
    expect(knoevenagel!.status).toBe('sink');
    expect(knoevenagel!.score).toBeGreaterThanOrEqual(0.45);

    // Benzaldehyde-aniline imine C13H11N should be detected as transient equilibrium species
    const imine = res.species.find((s) => s.formula === 'C13H11N');
    expect(imine).toBeDefined();
    expect(imine!.status).toBe('transient');

    // Aza-Michael adduct (Benzaldehyde + Malononitrile + Aniline 3-component) C16H13N3 should also be predicted
    const threeComp = res.species.find((s) => s.formula === 'C16H13N3');
    expect(threeComp).toBeDefined();
  });

  it('handles worked example A + D + E (free-base guanidine buffers 0.5 eq TsOH, suppressing t-Bu cleavage)', () => {
    const subs: PredictorSubstrateInput[] = [
      {
        id: 'A',
        code: 'A',
        name: 'N-(pyridin-4-ylmethyl)guanidine',
        smiles: 'N=C(N)NCc1ccncc1',
        equivalents: 1,
      },
      {
        id: 'D',
        code: 'D',
        name: 'Quinoline-2-carbaldehyde',
        smiles: 'O=Cc1ccc2ccccc2n1',
        equivalents: 1,
      },
      {
        id: 'E',
        code: 'E',
        name: 'Di-tert-butyl malonate',
        smiles: 'CC(C)(C)OC(=O)CC(=O)OC(C)(C)C',
        equivalents: 1,
      },
    ];

    const condAcid120: WellConditionConfig = {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 120,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, condAcid120);
    // Guanidine absorbs 0.5 eq TsOH -> buffered!
    expect(res.acidBase.effectiveMedium).toBe('buffered');
    expect(res.acidBase.freeAcidEq).toBeLessThan(0.05);

    // tert-Butyl cleavage to malonic acid (C3H4O4) must be suppressed in buffered well
    const malonicAcid = res.species.find((s) => s.formula === 'C3H4O4');
    expect(malonicAcid).toBeUndefined();

    // Knoevenagel adduct C21H25NO4 should appear
    const knoev = res.species.find((s) => s.formula === 'C21H25NO4');
    expect(knoev).toBeDefined();
    expect(knoev!.mhPlus).toBeCloseTo(356.1856, 2);

    // Reversible imine & aza-Michael should rank below or as transient
    const imine = res.species.find((s) => s.formula === 'C17H15N5');
    expect(imine).toBeDefined();
    expect(imine!.status).toBe('transient');
  });

  it('detects .Cl salt from SMILES and flips buffered well to free acid, unlocking t-Bu cleavage', () => {
    const subs: PredictorSubstrateInput[] = [
      {
        id: 'A',
        code: 'A',
        name: 'Guanidine HCl salt',
        smiles: 'N=C(N)NCc1ccncc1.Cl',
        equivalents: 1,
      },
      {
        id: 'D',
        code: 'D',
        name: 'Quinoline-2-carbaldehyde',
        smiles: 'O=Cc1ccc2ccccc2n1',
        equivalents: 1,
      },
      {
        id: 'E',
        code: 'E',
        name: 'Di-tert-butyl malonate',
        smiles: 'CC(C)(C)OC(=O)CC(=O)OC(C)(C)C',
        equivalents: 1,
      },
    ];

    const parsedA = parseSubstrateAndSalts(rdkit, subs[0]);
    expect(parsedA.valid).toBe(true);
    expect(parsedA.saltDetected).toContain('HCl');
    expect(parsedA.saltAcidEquiv).toBe(1);

    const condAcid120: WellConditionConfig = {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 120,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, condAcid120);
    expect(res.acidBase.effectiveMedium).toBe('free_acid');
    expect(res.acidBase.freeAcidEq).toBeGreaterThan(0.1);
    expect(res.releasedGases.some((g) => g.includes('Isobutylene'))).toBe(true);
  });

  it('tracks stoichiometry cleanly so double-Michael appears at 1:1:2 ratio and not 1:1:1', () => {
    const baseSubs: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1 },
      { id: 'D', code: 'D', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1 },
      { id: 'E', code: 'E', name: 'Malononitrile', smiles: 'N#CCC#N', equivalents: 1 },
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

    const res111 = predictWellReactions(rdkit, baseSubs, cond);
    const double111 = res111.species.find((s) => s.inventory[2] >= 2);
    expect(double111).toBeUndefined();

    const subs112 = baseSubs.map((s, idx) => (idx === 2 ? { ...s, equivalents: 2 } : s));
    const res112 = predictWellReactions(rdkit, subs112, cond);
    const double112 = res112.species.find((s) => s.inventory[2] >= 2);
    expect(double112).toBeDefined();
  });

  it('keeps released small reactive fragments (MeOH / NH3) available in the well pool', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: '1', code: 'A', name: 'Methyl benzoate', smiles: 'COC(=O)c1ccccc1', equivalents: 1 },
      { id: '2', code: 'B', name: 'Benzylamine', smiles: 'NCc1ccccc1', equivalents: 1 },
      { id: '3', code: 'C', name: 'Ethyl bromoacetate', smiles: 'CCOC(=O)CBr', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'base',
      additiveName: 'DBU',
      additiveEquiv: 0.5,
      additivePka: 13.9,
      temperatureC: 100,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, cond);
    // Released methanol (CO) should appear in releasedFragments
    expect(res.releasedFragments.some((f) => f.smiles === 'CO' || f.smiles === 'CCO')).toBe(true);
  });

  it('supports 1-, 2-, 4-component arbitrary mixtures (e.g. Hantzsch thiazole)', () => {
    const subs: PredictorSubstrateInput[] = [
      { id: '1', code: 'A', name: 'Bromoacetophenone', smiles: 'O=C(CBr)c1ccccc1', equivalents: 1 },
      { id: '2', code: 'B', name: 'Thioacetamide', smiles: 'CC(=S)N', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'neutral',
      additiveName: 'None',
      additiveEquiv: 0,
      additivePka: 7,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, cond);
    // 2-methyl-4-phenylthiazole: C10H9NS
    const thiazole = res.species.find((s) => s.formula === 'C10H9NS');
    expect(thiazole).toBeDefined();
    expect(thiazole!.tier).toBe('High');
    expect(thiazole!.status).toBe('sink');
  });

  it('solves proton balance properly for polybasic / acidic mixtures', () => {
    const subs = [
      parseSubstrateAndSalts(rdkit, { id: '1', code: 'A', name: 'Amine', smiles: 'CCCN', equivalents: 1 }),
      parseSubstrateAndSalts(rdkit, { id: '2', code: 'B', name: 'Acid', smiles: 'CC(=O)O', equivalents: 1 }),
    ];
    const eq = solveAcidBaseEquilibrium(subs, {
      medium: 'neutral',
      additiveName: 'None',
      additiveEquiv: 0,
      additivePka: 7,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    });
    expect(eq.effectivePhDmso).toBeGreaterThan(9);
    expect(eq.effectivePhDmso).toBeLessThan(14);
  });

  it('rejects zero-ring intramolecular artifacts (C5H8O) and predicts aldol/dehydration, azole aza-Michael, and SNAr in Well B6', () => {
    const subsB6Isomer: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: '2-Cyclopenten-1-one (3-enone isomer)', smiles: 'O=C1CC=CC1', equivalents: 1 },
      { id: 'D', code: 'D', name: '2-Imidazolecarboxaldehyde', smiles: 'O=Cc1[nH]ccn1', equivalents: 1 },
      { id: 'E', code: 'E', name: '5-Chlorobenzimidazole', smiles: 'Clc1ccc2[nH]cnc2c1', equivalents: 2 },
    ];
    const cond25Base: WellConditionConfig = {
      medium: 'base',
      additiveName: 'DBU',
      additiveEquiv: 0.5,
      additivePka: 13.9,
      temperatureC: 25,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res25 = predictWellReactions(rdkit, subsB6Isomer, cond25Base, { includeSpeculative: true });
    // Spurious zero-ring reduction C5H8O must NEVER appear
    expect(res25.species.find((s) => s.formula === 'C5H8O')).toBeUndefined();
    // Direct azole aza-Michael products onto isomerized enone should surface as Medium
    expect(res25.species.some((s) => s.formula === 'C9H10N2O2' && s.tier === 'Medium')).toBe(true);
    expect(res25.species.some((s) => s.formula === 'C12H11ClN2O' && s.tier === 'Medium')).toBe(true);
    // Ketone aldol + dehydration product C9H8N2O (ketone + 2-imidazolecarboxaldehyde) should appear
    expect(res25.species.some((s) => s.formula === 'C9H8N2O')).toBe(true);

    // Also verify conjugated 2-cyclopenten-1-one (O=C1CCC=C1) directly without tautomer hop needed
    const subsB6Conj: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: '2-Cyclopenten-1-one', smiles: 'O=C1CCC=C1', equivalents: 1 },
      subsB6Isomer[1],
      subsB6Isomer[2],
    ];
    const resConj = predictWellReactions(rdkit, subsB6Conj, cond25Base);
    expect(resConj.species.find((s) => s.formula === 'C5H8O')).toBeUndefined();
    expect(resConj.species.some((s) => s.formula === 'C12H11ClN2O' && s.tier === 'Medium')).toBe(true);
    expect(resConj.species.some((s) => s.formula === 'C9H8N2O' && s.bestChain.some((st) => st.stepLabel === 'DH'))).toBe(true);

    // At 80 °C, azole SNAr product (C11H8N4O) should also appear cleanly
    const res80 = predictWellReactions(rdkit, subsB6Conj, { ...cond25Base, temperatureC: 80 });
    expect(res80.species.some((s) => s.bestChain.some((st) => st.stepLabel === 'AR'))).toBe(true);
  });
});

