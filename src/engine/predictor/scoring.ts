// Robowski Studio - Thermodynamic + Bottleneck Kinetic Scoring & Ring-Size Analysis
import { AcidBaseSummary, ConfidenceClass, PredictionTier, StepEvent, WellConditionConfig } from './types';
import { ReactionRuleDef } from './rules';
import { countSubstruct } from './molQueries';

export function computeRingSizesFromMol(mol: any): number[] {
  try {
    const json = JSON.parse(mol.get_json());
    const m0 = json?.molecules?.[0];
    const ext = m0?.extensions?.find((e: any) => Array.isArray(e?.atomRings));
    if (!ext) return [];
    return ext.atomRings.map((r: number[]) => r.length);
  } catch {
    return [];
  }
}

export function evaluateNewRingFactor(
  parentRingSizes: number[][],
  productRingSizes: number[]
): { factor: number; addedSizes: number[]; reject: boolean } {
  const prevCounts = new Map<number, number>();
  for (const rs of parentRingSizes) {
    for (const sz of rs) prevCounts.set(sz, (prevCounts.get(sz) || 0) + 1);
  }
  const prodCounts = new Map<number, number>();
  for (const sz of productRingSizes) {
    prodCounts.set(sz, (prodCounts.get(sz) || 0) + 1);
  }

  const addedSizes: number[] = [];
  for (const [sz, cnt] of prodCounts.entries()) {
    const diff = cnt - (prevCounts.get(sz) || 0);
    for (let i = 0; i < diff; i++) addedSizes.push(sz);
  }

  if (addedSizes.length === 0) {
    return { factor: 1.0, addedSizes: [], reject: false };
  }

  let factor = 1.0;
  let reject = false;
  for (const sz of addedSizes) {
    if (sz <= 4) {
      factor *= 0.04;
      reject = true;
    } else if (sz === 5 || sz === 6) {
      // Baldwin / effective molarity advantage in dilute screening wells
      factor *= 1.38;
    } else if (sz === 7) {
      factor *= 0.62;
    } else {
      // 8+ macrocyclization is negligible in standard HTE concentration
      factor *= 0.05;
      reject = true;
    }
  }
  return { factor, addedSizes, reject };
}

export function temperatureGate(rule: ReactionRuleDef, tempC: number): number {
  const w = Math.max(4, rule.width || 15);
  const z = Math.max(-20, Math.min(20, -(tempC - rule.t50) / w));
  return 1 / (1 + Math.exp(z));
}

export function conditionGate(
  rule: ReactionRuleDef,
  acidBase: AcidBaseSummary,
  cond: WellConditionConfig
): number {
  if (rule.requiresFreeAcid) {
    if (acidBase.freeAcidEq < 0.05) return 0.0;
    return Math.min(1.0, acidBase.acidBlend * Math.min(1.0, acidBase.freeAcidEq * 2.5));
  }

  const denom = acidBase.acidBlend + acidBase.baseBlend + acidBase.neutralBlend || 1;
  let blend =
    (acidBase.acidBlend * rule.acidFactor +
      acidBase.baseBlend * rule.baseFactor +
      acidBase.neutralBlend * rule.neutralFactor) /
    denom;

  // Water retardation on dehydrations
  if (rule.waterSensitiveReverse) {
    const water = Math.max(0, Number(cond.waterPct) || 0);
    const waterFactor = 1 / (1 + 0.06 * water);
    blend *= waterFactor;
  }

  return Math.max(0, Math.min(1, blend));
}

/**
 * Local steric crowding factor from RDKit descriptors & simple structural motifs.
 * Evaluates tert-butyl / quaternary branching near functional groups.
 */
export function estimateStericFactor(
  rule: ReactionRuleDef,
  reactantSmiles: string[],
  rdkit: any
): number {
  if (!rule.stericRule || rule.stericRule === 'none') return 1.0;

  // RDKit substructure queries so atom order in SMILES never affects steric penalties
  const TERT_BUTYL = '[CX4;H0]([CH3])([CH3])[CH3]';
  const KETONE = '[CX3;H0](=O)([#6])[#6]';
  const ALDEHYDE = '[CX3;H1](=O)[#6]';
  const AMINE_N = '[NX3;H2,H1;!$(N-C=[O,N,S])]';
  const ARYL_AMINE_N = '[NX3;H2,H1;$(N-c);!$(N-C=[O,N,S])]';

  let factor = 1.0;
  for (const smi of reactantSmiles) {
    if (rule.stericRule === 'alpha_branching') {
      const tBu = countSubstruct(rdkit, smi, TERT_BUTYL);
      if (tBu > 0) factor *= Math.pow(0.74, Math.min(2, tBu));
      if (countSubstruct(rdkit, smi, KETONE) > 0 && countSubstruct(rdkit, smi, ALDEHYDE) === 0) {
        factor *= 0.85;
      }
    } else if (rule.stericRule === 'nucleophile_crowding') {
      const tBu = countSubstruct(rdkit, smi, TERT_BUTYL);
      if (tBu > 0 && countSubstruct(rdkit, smi, AMINE_N) > 0) {
        factor *= Math.pow(0.82, Math.min(2, tBu));
      }
      if (
        countSubstruct(rdkit, smi, ARYL_AMINE_N) > 0 &&
        countSubstruct(rdkit, smi, AMINE_N) === countSubstruct(rdkit, smi, ARYL_AMINE_N)
      ) {
        factor *= 0.86;
      }
    }
  }

  return Math.max(0.25, Math.min(1.0, factor));
}

/**
 * Leaving group & electrophile electronics modifier (I > Br > Cl > F for SN2; aldehyde > ketone)
 */
export function estimateElectronicFactor(rule: ReactionRuleDef, reactantSmiles: string[]): number {
  let factor = 1.0;
  const joined = reactantSmiles.join('.');

  if (rule.stepLabel === 'SN(N)' || rule.stepLabel === 'SN(S)' || rule.stepLabel === 'SN(O)') {
    if (/I/.test(joined)) factor *= 1.08;
    else if (/Br/.test(joined)) factor *= 1.0;
    else if (/Cl/.test(joined)) factor *= 0.86;
  }

  if (rule.stepLabel === 'AR') {
    if (/F/.test(joined)) factor *= 1.08; // F is fastest in SNAr!
    else if (/Cl/.test(joined)) factor *= 0.96;
    else if (/Br/.test(joined)) factor *= 0.88;
  }

  if (rule.stepLabel === 'NA(N)' || rule.stepLabel === 'NA(C)') {
    // Malononitrile / 1,3-diketone higher intrinsic reactivity than malonate ester
    if (/N#CCC#N/.test(joined)) factor *= 1.08;
    // Aldehydes (excluding ketones/esters) faster than ketones
    const hasAld = reactantSmiles.some((s) => /(^|=O\))C=O|^O=C/.test(s) || /C=O/.test(s));
    if (hasAld) factor *= 1.0;
  }

  return Math.max(0.4, Math.min(1.15, factor));
}

// Equilibrium constants of reversible step types:
// Bimolecular steps use M^-1 (multiplied by cM); unimolecular dehydration DH shifts strongly right in organic
// solvent relative to the hemiaminal while remaining water-sensitive.
const K_EQ: Record<string, number> = {
  'NA(N)': 3,
  'NA(C)': 3,
  'NA(O)': 2,
  'NA(S)': 5,
  'MI(N)': 10,
  'MI(C)': 40,
  'MI(S)': 8,
  'MI(O)': 3,
  DH: 50, // dehydration equilibrium relative to hemiaminal so imines stay viable in 15-50 mM wells
  IS: 10,
  Tautomer: 0.6,
};
const DEFAULT_K_EQ = 5;
const EFFECTIVE_MOLARITY = 5;
const REF_CONC_MM = 50;
const HALF_SAT_MM = 8;

export interface ScoreContext {
  concMm?: number;
  waterPct?: number;
}

/**
 * Share of a reversible end-species expected to persist at equilibrium.
 */
export function equilibriumPersistence(chain: StepEvent[], ctx: ScoreContext = {}): number {
  const cM = Math.max(1, ctx.concMm ?? REF_CONC_MM) / 1000;
  const water = Math.max(0, ctx.waterPct ?? 0);
  let x = 1;
  let n = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const st = chain[i];
    if (!st.reversible) break;
    const k = K_EQ[st.stepLabel] ?? DEFAULT_K_EQ;
    let xi: number;
    if (st.stepLabel === 'DH') xi = k / (1 + 0.35 * water);
    else if (st.stepLabel === 'Tautomer') xi = k;
    else if (st.reactantSmiles.length >= 2) xi = k * cM;
    else xi = k * EFFECTIVE_MOLARITY;
    x *= xi;
    n++;
  }
  if (n === 0) return 1;
  return Math.max(0.02, Math.min(0.97, x / (1 + x)));
}

/**
 * Pathway plausibility reported as likelihood (kinetics/conc/length) and persistence (equilibrium survival).
 * Uses an 8% per-step complexity discount (0.92) to curb 5+ step noise without penalizing 3-4 step cyclizations.
 */
export function scoreChain(
  chain: StepEvent[],
  cumulativeThermoBonus: number,
  isTransient: boolean,
  lowestClass: ConfidenceClass,
  competitionPenalty = 1.0,
  ctx: ScoreContext = {}
): {
  score: number;
  likelihood: number;
  persistence: number;
  bottleneckScore: number;
  thermoBoost: number;
  tier: PredictionTier;
} {
  if (chain.length === 0) {
    return { score: 1.0, likelihood: 1.0, persistence: 1.0, bottleneckScore: 1.0, thermoBoost: 0, tier: 'High' };
  }

  const weights = chain.map((s) => Math.max(0.01, Math.min(1.15, s.stepWeight)));
  const minW = Math.min(...weights);
  const logSum = weights.reduce((acc, w) => acc + Math.log(w), 0);
  const geomMean = Math.exp(logSum / weights.length);

  const bottleneckScore = Math.pow(minW, 0.48) * Math.pow(geomMean, 0.52);

  // Balanced 8% per-step discount: rejects speculative 5+ step bloat while keeping 3-4 step ring closures High
  const depthPenalty = Math.pow(0.92, Math.max(0, chain.length - 1));

  // Concentration effect on bimolecular steps relative to 50 mM reference
  const c = Math.max(1, ctx.concMm ?? REF_CONC_MM);
  const perBimolecular = c / (c + HALF_SAT_MM) / (REF_CONC_MM / (REF_CONC_MM + HALF_SAT_MM));
  const bimolecularSteps = chain.filter((s) => s.reactantSmiles.length >= 2).length;
  const concFactor = Math.pow(Math.min(1.15, perBimolecular), bimolecularSteps);

  const thermoBoost = Math.min(0.32, Math.max(-0.08, cumulativeThermoBonus * 0.42));

  const likelihood = Math.max(
    0,
    Math.min(0.98, bottleneckScore * depthPenalty * competitionPenalty * concFactor * (0.82 + thermoBoost))
  );
  const persistence = isTransient ? equilibriumPersistence(chain, ctx) : 1.0;
  const rawScore = likelihood * (0.4 + 0.6 * persistence);

  const score = Math.max(0, Math.min(0.98, Math.round(rawScore * 1000) / 1000));

  let tier: PredictionTier =
    score >= 0.55 ? 'High' : score >= 0.28 ? 'Medium' : score >= 0.1 ? 'Low' : 'Speculative';

  if (lowestClass === 'C') {
    if (tier === 'High') tier = 'Medium';
    else if (tier === 'Medium') tier = 'Low';
    else if (tier === 'Low') tier = 'Speculative';
  }

  return {
    score,
    likelihood: Math.round(likelihood * 1000) / 1000,
    persistence: Math.round(persistence * 1000) / 1000,
    bottleneckScore: Math.round(bottleneckScore * 1000) / 1000,
    thermoBoost: Math.round(thermoBoost * 1000) / 1000,
    tier,
  };
}
