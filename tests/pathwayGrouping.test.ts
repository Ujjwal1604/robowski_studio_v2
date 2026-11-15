import { describe, it, expect, beforeAll } from 'vitest';
import {
  predictWellReactions,
  groupSpeciesByPathway,
  PredictorSubstrateInput,
  WellConditionConfig,
  PredictedSpecies,
  ParsedSubstrate,
} from '../src/engine/predictor';

let rdkit: any;

beforeAll(async () => {
  const mod: any = await import('@rdkit/rdkit');
  const initFn = mod.default || mod;
  rdkit = await initFn();
});

function makeSyntheticSpecies(
  partial: Partial<PredictedSpecies> & { key: string; score: number }
): PredictedSpecies {
  const tier =
    partial.score >= 0.7
      ? 'High'
      : partial.score >= 0.45
        ? 'Medium'
        : partial.score >= 0.2
          ? 'Low'
          : 'Speculative';
  return {
    key: partial.key,
    smiles: partial.smiles || partial.key,
    formula: partial.formula || 'C10H10O',
    exactMass: partial.exactMass ?? 146.0732,
    mhPlus: partial.mhPlus ?? 147.0804,
    mNaPlus: partial.mNaPlus ?? 169.0624,
    mHMinus: partial.mHMinus ?? 145.0659,
    clogP: 1.5,
    tpsa: 25,
    numRings: 1,
    numAromaticRings: 0,
    inventory: partial.inventory || [1, 1],
    fragmentUses: 0,
    score: partial.score,
    bottleneckScore: partial.score,
    thermoBonus: 0,
    tier: partial.tier || tier,
    status: partial.status || 'sink',
    isSubstrate: false,
    isSmallFragment: false,
    stepsCount: partial.stepsCount ?? (partial.bestChain?.length || 1),
    bestChain: partial.bestChain || [],
    alternativeChains: partial.alternativeChains || [],
    mechanismSummary: partial.mechanismSummary || 'NA(N)',
    alerts: [],
  };
}

const dummySubstrates: ParsedSubstrate[] = [
  {
    id: 'A',
    code: 'A',
    name: 'Substrate A',
    rawSmiles: 'O=CC',
    neutralSmiles: 'O=CC',
    equivalents: 1,
    concentrationMm: 50,
    saltDetected: null,
    saltAcidEquiv: 0,
    hydrateWaterEquiv: 0,
    sites: [],
    exactMass: 44,
    formula: 'C2H4O',
    valid: true,
  },
  {
    id: 'D',
    code: 'D',
    name: 'Substrate D',
    rawSmiles: 'NC',
    neutralSmiles: 'NC',
    equivalents: 1,
    concentrationMm: 50,
    saltDetected: null,
    saltAcidEquiv: 0,
    hydrateWaterEquiv: 0,
    sites: [],
    exactMass: 31,
    formula: 'CH5N',
    valid: true,
  },
  {
    id: 'E',
    code: 'E',
    name: 'Substrate E',
    rawSmiles: 'C=CC=O',
    neutralSmiles: 'C=CC=O',
    equivalents: 1,
    concentrationMm: 50,
    saltDetected: null,
    saltAcidEquiv: 0,
    hydrateWaterEquiv: 0,
    sites: [],
    exactMass: 56,
    formula: 'C3H4O',
    valid: true,
  },
];

describe('Pathway Family Grouping', () => {
  it('orders families globally descending by peak confidence score and preserves global ranks', () => {
    const stepBase = {
      stepWeight: 0.9,
      bottleneckFactor: 0.9,
      conditionFactor: 1,
      tempFactor: 1,
      stericFactor: 1,
      ringFactor: 1,
      electronicFactor: 1,
      reversible: false,
    };

    const sp1 = makeSyntheticSpecies({
      key: 'SINK_A_E_CYCLIZED',
      score: 0.89,
      tier: 'High',
      inventory: [1, 0, 1],
      stepsCount: 2,
      bestChain: [
        { ...stepBase, ruleId: 'MI_nuc', stepLabel: 'MI(N)', description: 'Michael addition', reactantSmiles: ['O=CC', 'C=CC=O'] },
        { ...stepBase, ruleId: 'CYCL_1', stepLabel: 'NA(N)', description: 'Cyclization', reactantSmiles: ['INTERM_A_E'] },
      ],
    });

    const sp2 = makeSyntheticSpecies({
      key: 'SINK_A_D',
      score: 0.72,
      tier: 'High',
      inventory: [1, 1, 0],
      stepsCount: 1,
      bestChain: [
        { ...stepBase, ruleId: 'NA_imine', stepLabel: 'NA(N)', description: 'Imine addition', reactantSmiles: ['O=CC', 'NC'] },
      ],
    });

    const sp3 = makeSyntheticSpecies({
      key: 'INTERM_A_E',
      score: 0.36,
      tier: 'Low',
      status: 'transient',
      inventory: [1, 0, 1],
      stepsCount: 1,
      bestChain: [
        { ...stepBase, ruleId: 'MI_nuc', stepLabel: 'MI(N)', description: 'Michael addition', reactantSmiles: ['O=CC', 'C=CC=O'], reversible: true },
      ],
    });

    const sp4 = makeSyntheticSpecies({
      key: 'MINOR_LEAF_A_E',
      score: 0.21,
      tier: 'Low',
      status: 'sink',
      inventory: [1, 0, 2],
      stepsCount: 2,
      bestChain: [
        { ...stepBase, ruleId: 'MI_nuc', stepLabel: 'MI(N)', description: 'Michael addition', reactantSmiles: ['O=CC', 'C=CC=O'] },
        { ...stepBase, ruleId: 'OVER_ADD', stepLabel: 'MI(C)', description: 'Second addition', reactantSmiles: ['INTERM_A_E', 'C=CC=O'] },
      ],
    });

    // Species input is sorted descending by score: sp1 (#1), sp2 (#2), sp3 (#3), sp4 (#4)
    const families = groupSpeciesByPathway([sp1, sp2, sp3, sp4], dummySubstrates);

    expect(families.length).toBe(2);
    // Pathway 1 must be the MI(N) family because its peakScore (0.89) > NA(N) family (0.72)
    expect(families[0].pathwayNumber).toBe(1);
    expect(families[0].peakScore).toBe(0.89);
    expect(families[1].pathwayNumber).toBe(2);
    expect(families[1].peakScore).toBe(0.72);

    // Essential ancestor sp3 (Low, 0.36) feeds sp1 (High, 0.89) so it MUST stay in primaryNodes!
    const fam1PrimaryKeys = families[0].primaryNodes.map((n) => n.species.key);
    expect(fam1PrimaryKeys).toContain('INTERM_A_E');
    expect(fam1PrimaryKeys).toContain('SINK_A_E_CYCLIZED');
    // Progression order: entry intermediate before its extension sink
    expect(fam1PrimaryKeys.indexOf('INTERM_A_E')).toBeLessThan(
      fam1PrimaryKeys.indexOf('SINK_A_E_CYCLIZED')
    );

    // Non-essential Low leaf sp4 goes to minorNodes
    expect(families[0].minorNodes.map((n) => n.species.key)).toEqual(['MINOR_LEAF_A_E']);

    // Global ranks match the flat score list (#1..#4)
    const sinkNode = families[0].primaryNodes.find((n) => n.species.key === 'SINK_A_E_CYCLIZED')!;
    const intermNode = families[0].primaryNodes.find((n) => n.species.key === 'INTERM_A_E')!;
    expect(sinkNode.globalRank).toBe(1);
    expect(intermNode.globalRank).toBe(3);
    expect(sinkNode.parentKey).toBe('INTERM_A_E');
    expect(sinkNode.parentGlobalRank).toBe(3);
  });

  it('attaches pure tautomer intermediates to their downstream family and flags convergent alternativeChains', () => {
    const stepBase = {
      stepWeight: 0.9,
      bottleneckFactor: 0.9,
      conditionFactor: 1,
      tempFactor: 1,
      stericFactor: 1,
      ringFactor: 1,
      electronicFactor: 1,
      reversible: false,
    };

    const taut = makeSyntheticSpecies({
      key: 'A_TAUT',
      score: 0.55,
      tier: 'Medium',
      status: 'transient',
      inventory: [1, 0, 0],
      stepsCount: 1,
      bestChain: [
        { ...stepBase, ruleId: 'TAUT_beta_gamma_enone', stepLabel: 'Tautomer', description: 'Conjugated isomerization', reactantSmiles: ['O=CC'], reversible: true },
      ],
    });

    const fam1Lead = makeSyntheticSpecies({
      key: 'CONVERGED_PROD',
      score: 0.88,
      tier: 'High',
      inventory: [1, 0, 1],
      stepsCount: 2,
      bestChain: [
        { ...stepBase, ruleId: 'TAUT_beta_gamma_enone', stepLabel: 'Tautomer', description: 'Conjugated isomerization', reactantSmiles: ['O=CC'], reversible: true },
        { ...stepBase, ruleId: 'MI_enone', stepLabel: 'MI(N)', description: 'Aza-Michael', reactantSmiles: ['A_TAUT', 'C=CC=O'] },
      ],
      alternativeChains: [
        [
          { ...stepBase, ruleId: 'DIRECT_AD', stepLabel: 'NA(C)', description: 'Direct aldol', reactantSmiles: ['O=CC', 'NC'] },
        ],
      ],
    });

    const fam2Lead = makeSyntheticSpecies({
      key: 'ALDOL_PROD',
      score: 0.65,
      tier: 'Medium',
      inventory: [1, 1, 0],
      stepsCount: 1,
      bestChain: [
        { ...stepBase, ruleId: 'DIRECT_AD', stepLabel: 'NA(C)', description: 'Direct aldol', reactantSmiles: ['O=CC', 'NC'] },
      ],
    });

    const families = groupSpeciesByPathway([fam1Lead, fam2Lead, taut], dummySubstrates);

    // Pre-tautomer did NOT create a noisy 3rd family
    expect(families.length).toBe(2);
    expect(families[0].nodes.map((n) => n.species.key)).toContain('A_TAUT');

    // Converged product appears once (in Pathway 1) and cross-references Pathway 2
    const convNode = families[0].nodes.find((n) => n.species.key === 'CONVERGED_PROD')!;
    expect(convNode.alsoViaLabels.length).toBe(1);
    expect(convNode.alsoViaLabels[0]).toContain('Pathway 2');
  });

  it('groups real Benzaldehyde + Malononitrile + Aniline cascade intermediates with their downstream adducts', () => {
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
    const families = groupSpeciesByPathway(res.species, res.substrates);

    expect(families.length).toBeGreaterThanOrEqual(2);
    // Families strictly descending by peakScore
    for (let i = 1; i < families.length; i++) {
      expect(families[i - 1].peakScore).toBeGreaterThanOrEqual(families[i].peakScore);
    }

    // Total grouped species equals total input species (zero lost, zero duplicated)
    const totalGrouped = families.reduce((acc, f) => acc + f.nodes.length, 0);
    expect(totalGrouped).toBe(res.species.length);

    // Knoevenagel (C10H6N2) and 3-comp Knoevenagel+Aniline (C16H13N3) share the same initial pathway family!
    const famWithKnoev = families.find((f) =>
      f.nodes.some((n) => n.species.formula === 'C10H6N2')
    );
    expect(famWithKnoev).toBeDefined();
    expect(famWithKnoev!.nodes.some((n) => n.species.formula === 'C16H13N3')).toBe(true);
  });

  it('keeps Well B6 (2-cyclopenten-1-one + aldehyde + benzimidazole) coherent and loss-free', { timeout: 15000 }, () => {
    const subs: PredictorSubstrateInput[] = [
      { id: 'A', code: 'A', name: '2-Cyclopenten-1-one', smiles: 'O=C1CCC=C1', equivalents: 1 },
      { id: 'D', code: 'D', name: '2-Imidazolecarboxaldehyde', smiles: 'O=Cc1ncc[nH]1', equivalents: 1 },
      { id: 'E', code: 'E', name: '5-Chlorobenzimidazole', smiles: 'Clc1ccc2[nH]cnc2c1', equivalents: 1 },
    ];
    const cond: WellConditionConfig = {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 2,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    };

    const res = predictWellReactions(rdkit, subs, cond);
    const families = groupSpeciesByPathway(res.species, res.substrates);

    expect(families.length).toBeGreaterThanOrEqual(1);
    const totalGrouped = families.reduce((acc, f) => acc + f.nodes.length, 0);
    expect(totalGrouped).toBe(res.species.length);
    for (let i = 1; i < families.length; i++) {
      expect(families[i - 1].peakScore).toBeGreaterThanOrEqual(families[i].peakScore);
    }
  });
});
