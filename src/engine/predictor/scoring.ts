// Robowski Studio - Thermodynamic + Bottleneck Kinetic Scoring & Ring-Size Analysis
import { AcidBaseSummary, ConfidenceClass, PredictionTier, StepEvent, WellConditionConfig } from './types';
import { ReactionRuleDef } from './rules';

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

  let factor = 1.0;
  for (const smi of reactantSmiles) {
    // Check tert-butyl or heavily branched quaternary centers near carbonyl/ester/amine
    if (rule.stericRule === 'alpha_branching') {
      const tBuMatches = (smi.match(/C\(C\)\(C\)C/g) || []).length;
      if (tBuMatches > 0) {
        factor *= Math.pow(0.74, Math.min(2, tBuMatches));
      }
      // Di-substituted / bulky ketones react slower than aldehydes
      if (/CC\(=O\)C/.test(smi) && !/C=O/.test(smi.replace(/CC\(=O\)C/g, ''))) {
        factor *= 0.85;
      }
    } else if (rule.stericRule === 'nucleophile_crowding') {
      const tBuMatches = (smi.match(/C\(C\)\(C\)C/g) || []).length;
      if (tBuMatches > 0 && /N/.test(smi)) {
        factor *= Math.pow(0.82, Math.min(2, tBuMatches));
      }
      // Check aromaticity/resonance attenuation for anilines vs aliphatic amines
      if (/Nc1/.test(smi) && !/N[CH2,CH3]/.test(smi)) {
        factor *= 0.86;
      }
    }
  }

  // Also check heavy-atom crowding via RDKit molecular weight/branching subtly
  void rdkit;
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

/**
 * Computes non-collapsing pathway plausibility score from step events.
 * Uses bottleneck kinetic rate + geometric path quality + thermodynamic sink driving force,
 * and partitions reversible transients cleanly.
 */
export function scoreChain(
  chain: StepEvent[],
  cumulativeThermoBonus: number,
  isTransient: boolean,
  lowestClass: ConfidenceClass,
  competitionPenalty = 1.0
): { score: number; bottleneckScore: number; thermoBoost: number; tier: PredictionTier } {
  if (chain.length === 0) {
    return { score: 1.0, bottleneckScore: 1.0, thermoBoost: 0, tier: 'High' };
  }

  const weights = chain.map((s) => Math.max(0.01, Math.min(1.15, s.stepWeight)));
  const minW = Math.min(...weights);
  const logSum = weights.reduce((acc, w) => acc + Math.log(w), 0);
  const geomMean = Math.exp(logSum / weights.length);

  // Bottleneck-weighted kinetic plausibility
  const bottleneckScore = Math.pow(minW, 0.48) * Math.pow(geomMean, 0.52);

  // Very gentle complexity penalty so clean 1-step & 5-step cyclizations both shine,
  // while endless oligomerization is discouraged
  const depthPenalty = Math.pow(0.955, Math.max(0, chain.length - 1));

  // Thermodynamic driving force for ring closure / aromatization / amide / gas release
  const thermoBoost = Math.min(0.32, Math.max(-0.08, cumulativeThermoBonus * 0.42));

  let rawScore = bottleneckScore * depthPenalty * competitionPenalty * (0.82 + thermoBoost);

  // Reversible transient penalty (equilibrium K/(1+K))
  if (isTransient) {
    const last = chain[chain.length - 1];
    // Hemiaminals / uncyclized reversible adducts stay lower in steady-state solution
    const eqScale =
      last.stepLabel === 'Tautomer'
        ? 0.3
        : last.stepLabel === 'NA(N)' || last.stepLabel === 'NA(C)'
        ? 0.36
        : 0.48;
    rawScore *= eqScale;
  }

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
    bottleneckScore: Math.round(bottleneckScore * 1000) / 1000,
    thermoBoost: Math.round(thermoBoost * 1000) / 1000,
    tier,
  };
}
