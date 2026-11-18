// Robowski Studio - Bridge between Robowski RunState/RunRow wells and Reaction Predictor
import { Reagent, RunResult, RunRow, RunState } from '../../types';
import {
  MediumMode,
  PredictorSubstrateInput,
  WellConditionConfig,
  WellPredictionResult,
} from './types';
import { buildLcmsTargets } from './lcmsTargets';
import {
  detectHydrateStoichiometry,
  getCanonicalRunConditions,
  WATER_PCT_PER_MM,
} from '../conditions';

interface KnownAdditiveProfile {
  pattern: RegExp;
  medium: MediumMode;
  pka: number;
  label: string;
}

const KNOWN_ADDITIVES: KnownAdditiveProfile[] = [
  { pattern: /^Ac$|\bp?-?TsOH\b|\bPTSA\b|toluenesulfon|methylbenzenesulfon|benzenesulfon|tosic|tosyl/i, medium: 'acid', pka: 0.9, label: 'TsOH' },
  { pattern: /\bTFA\b|trifluoroacetic/i, medium: 'acid', pka: 3.45, label: 'TFA' },
  { pattern: /\bHCl\b|hydrochloric/i, medium: 'acid', pka: 1.8, label: 'HCl' },
  { pattern: /\bTfOH\b|triflic/i, medium: 'acid', pka: 0.3, label: 'TfOH' },
  { pattern: /\bMsOH\b|methanesulfonic/i, medium: 'acid', pka: 1.6, label: 'MsOH' },
  { pattern: /\bH2SO4\b|sulfuric\s+acid/i, medium: 'acid', pka: 1.9, label: 'H₂SO₄' },
  { pattern: /\bH3PO4\b|phosphoric\s+acid/i, medium: 'acid', pka: 3.5, label: 'H₃PO₄' },
  { pattern: /\bPPTS\b|pyridinium/i, medium: 'acid', pka: 5.2, label: 'PPTS' },
  { pattern: /\bCSA\b|camphorsulfonic/i, medium: 'acid', pka: 1.2, label: 'CSA' },
  { pattern: /\bHCOOH\b|formic\s+acid/i, medium: 'acid', pka: 11.6, label: 'HCOOH' },
  { pattern: /\bAcOH\b|\bHOAc\b|acetic\s+acid/i, medium: 'acid', pka: 12.6, label: 'AcOH' },
  { pattern: /\bNH4Cl\b|ammonium\s+chloride/i, medium: 'acid', pka: 10.5, label: 'NH₄Cl' },
  { pattern: /^Ba$|\bDBU\b|diazabicyclo/i, medium: 'base', pka: 13.9, label: 'DBU' },
  { pattern: /\bTBD\b|\bMTBD\b|\bBTMG\b|\bTMG\b/i, medium: 'base', pka: 15.0, label: 'DBU/Guanidine base' },
  { pattern: /\bDIPEA\b|\bHunig|\bTEA\b|Et3N|triethylamine|\bNMM\b|N-methylmorpholine|\bDABCO\b/i, medium: 'base', pka: 9.0, label: 'TEA / DIPEA' },
  { pattern: /\bDMAP\b|\bpyridine\b|\blutidine\b/i, medium: 'base', pka: 5.2, label: 'Pyridine / DMAP' },
  { pattern: /\bK2CO3\b|\bCs2CO3\b|\bNa2CO3\b|\bNaHCO3\b|\bKHCO3\b|\bK3PO4\b|\bK2HPO4\b|carbonate/i, medium: 'base', pka: 12.5, label: 'Carbonate base' },
  { pattern: /\bNaOAc\b|\bKOAc\b|\bNH4OAc\b|sodium\s+acetate|potassium\s+acetate/i, medium: 'base', pka: 12.6, label: 'Acetate buffer' },
  { pattern: /\bNaOH\b|\bKOH\b|\bKOtBu\b|\btBuOK\b|\bLiHMDS\b|\bNaHMDS\b/i, medium: 'base', pka: 18.0, label: 'Alkoxide / Hydroxide' },
];

export function isKnownAdditiveReagent(reagent: Reagent, state: RunState): KnownAdditiveProfile | null {
  const additiveCodes = new Set((state.tri?.adds || []).map((a) => a.code).filter(Boolean));
  const combined = `${reagent.code || ''} ${reagent.name || ''} ${reagent.iupac || ''}`.trim();

  for (const prof of KNOWN_ADDITIVES) {
    if (prof.pattern.test(combined)) return prof;
  }
  if (additiveCodes.has(reagent.code)) {
    // Fallback heuristic if custom additive code in Triplet mode
    if (/^A|acid|OTf|triflate|lewis/i.test(combined)) {
      return { pattern: /.*/, medium: 'acid', pka: 0.9, label: reagent.name || reagent.code };
    }
    if (/^B|base|carb|hydrox|morph|pyr|guanid/i.test(combined)) {
      return { pattern: /.*/, medium: 'base', pka: 13.9, label: reagent.name || reagent.code };
    }
    if (!(reagent.smiles || '').trim()) {
      return { pattern: /.*/, medium: 'neutral', pka: 7.0, label: reagent.name || reagent.code };
    }
  }
  return null;
}

export interface WellExtractionResult {
  substrates: PredictorSubstrateInput[];
  condition: WellConditionConfig;
  missingSmilesCodes: string[];
  inactiveAdditiveOnly: boolean;
}

/**
 * Extracts substrates (with exact normalized equivalents) and condition config from any Robowski well row.
 */
export function extractWellForPrediction(
  state: RunState,
  row: RunRow,
  overrides?: Partial<WellConditionConfig>
): WellExtractionResult {
  const reagentMap = new Map(state.reagents.map((r) => [r.code, r]));
  const activeItems = (row.recipe || []).filter((it) => Number(it.target_concentration) > 0);

  const organicItems: Array<{
    reagent: Reagent;
    concMm: number;
    equiv?: number | null;
  }> = [];
  const additiveItems: Array<{
    reagent: Reagent;
    prof: KnownAdditiveProfile;
    concMm: number;
  }> = [];

  for (const item of activeItems) {
    const r = reagentMap.get(item.code);
    if (!r) continue;
    const addProf = isKnownAdditiveReagent(r, state);
    if (addProf) {
      additiveItems.push({ reagent: r, prof: addProf, concMm: Number(item.target_concentration) });
    } else {
      organicItems.push({ reagent: r, concMm: Number(item.target_concentration), equiv: item.equivalence });
    }
  }

  const minOrganicMm = organicItems.length
    ? Math.min(...organicItems.map((o) => o.concMm))
    : 50;

  const missingSmilesCodes: string[] = [];
  let organicHydrateMm = 0;
  let organicHydrateEquiv = 0;
  const organicHydrateSources: string[] = [];

  const substrates: PredictorSubstrateInput[] = organicItems.map((o, idx) => {
    const smi = (o.reagent.smiles || '').trim();
    if (!smi) missingSmilesCodes.push(o.reagent.code);
    const eq = minOrganicMm > 0 ? Math.round((o.concMm / minOrganicMm) * 100) / 100 : 1;
    const hDet = detectHydrateStoichiometry(smi, o.reagent.name, o.reagent.iupac);
    if (hDet.waterEquivPerMol > 0) {
      organicHydrateMm += o.concMm * hDet.waterEquivPerMol;
      organicHydrateEquiv += eq * hDet.waterEquivPerMol;
      organicHydrateSources.push(
        `${o.reagent.code} (${hDet.waterEquivPerMol} H₂O, ${Math.round(o.concMm * 10) / 10} mM)`
      );
    }
    return {
      id: `${o.reagent.code}_${idx}`,
      code: o.reagent.code,
      name: o.reagent.name || o.reagent.code,
      iupac: o.reagent.iupac,
      smiles: smi,
      equivalents: eq,
      concentrationMm: o.concMm,
    };
  });

  let additiveHydrateMm = 0;
  let additiveHydrateEquiv = 0;
  const additiveHydrateSources: string[] = [];
  for (const add of additiveItems) {
    const hDet = detectHydrateStoichiometry(add.reagent.smiles, add.reagent.name, add.reagent.iupac);
    if (hDet.waterEquivPerMol > 0) {
      const addEq = minOrganicMm > 0 ? add.concMm / minOrganicMm : 0.5;
      additiveHydrateMm += add.concMm * hDet.waterEquivPerMol;
      additiveHydrateEquiv += addEq * hDet.waterEquivPerMol;
      additiveHydrateSources.push(
        `${add.reagent.code} (${hDet.waterEquivPerMol} H₂O, ${Math.round(add.concMm * 10) / 10} mM)`
      );
    }
  }

  let medium: MediumMode = 'neutral';
  let additiveName = 'None (Neutral)';
  let additiveEquiv = 0;
  let additivePka = 7.0;

  if (additiveItems.length > 0) {
    const primaryAdd = additiveItems[0];
    medium = primaryAdd.prof.medium;
    additiveName = primaryAdd.reagent.name || primaryAdd.prof.label;
    additivePka = primaryAdd.prof.pka;
    additiveEquiv = minOrganicMm > 0 ? Math.round((primaryAdd.concMm / minOrganicMm) * 100) / 100 : 0.5;
  }

  const runCond = getCanonicalRunConditions(state);
  const baseWaterPct =
    overrides?.baseWaterPct != null && Number.isFinite(Number(overrides.baseWaterPct))
      ? Math.max(0, Number(overrides.baseWaterPct))
      : overrides?.waterPct != null && Number.isFinite(Number(overrides.waterPct))
      ? Math.max(0, Number(overrides.waterPct))
      : runCond.baseWaterPct;

  const totalHydrateMm = organicHydrateMm + additiveHydrateMm;
  const hydrateWaterPct = Math.round(totalHydrateMm * WATER_PCT_PER_MM * 1000) / 1000;
  const effectiveWaterPct = Math.round((baseWaterPct + hydrateWaterPct) * 1000) / 1000;

  const condition: WellConditionConfig = {
    medium: overrides?.medium ?? medium,
    additiveName: overrides?.additiveName ?? additiveName,
    additiveEquiv: overrides?.additiveEquiv ?? additiveEquiv,
    additivePka: overrides?.additivePka ?? additivePka,
    temperatureC: overrides?.temperatureC ?? runCond.temperatureC,
    waterPct: effectiveWaterPct,
    baseWaterPct,
    hydrateWaterPct,
    hydrateWaterMm: Math.round(totalHydrateMm * 100) / 100,
    hydrateWaterEquiv: Math.round((organicHydrateEquiv + additiveHydrateEquiv) * 1000) / 1000,
    hydrateSources: [...organicHydrateSources, ...additiveHydrateSources],
    additiveHydrateWaterMm: Math.round(additiveHydrateMm * 100) / 100,
    additiveHydrateWaterEquiv: Math.round(additiveHydrateEquiv * 1000) / 1000,
    additiveHydrateSources,
    solvent: overrides?.solvent ?? runCond.solvent,
    equivBasis: overrides?.equivBasis ?? 'limiting',
    reactionTimeHours: overrides?.reactionTimeHours ?? runCond.reactionTimeHours,
    atmosphere: overrides?.atmosphere ?? runCond.atmosphere,
    agitation: overrides?.agitation ?? runCond.agitation,
  };

  return {
    substrates,
    condition,
    missingSmilesCodes,
    inactiveAdditiveOnly: organicItems.length === 0,
  };
}

export function exportLcmsTargetListCsv(
  results: Array<{ wellLabel: string; groupLabel: string; result: WellPredictionResult }>
): string {
  const esc = (v: any) => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = [
    'Well',
    'Group / Reaction',
    'Medium',
    'Temperature (°C)',
    'pH (DMSO est.)',
    'Rank',
    'Tier',
    'Score',
    'Likelihood',
    'Persistence',
    'Reversible',
    'Tautomer forms',
    'Role / State',
    'Formula',
    'Exact Mass',
    '[M+H]+',
    '[M+Na]+',
    '[M-H]-',
    'cLogP',
    'TPSA',
    'In-source ions',
    'Ambiguous m/z',
    'Steps',
    'Mechanism Chain',
    'Predicted SMILES',
    'Alerts',
  ];

  const lines = [headers.join(',')];

  for (const entry of results) {
    const { wellLabel, groupLabel, result } = entry;
    const amb = new Map<string, Set<string>>();
    for (const t of buildLcmsTargets(result.species)) {
      if (!t.sharedWith.length) continue;
      if (!amb.has(t.speciesKey)) amb.set(t.speciesKey, new Set());
      amb.get(t.speciesKey)!.add(`${t.ion} ${t.mz.toFixed(3)} also ${t.sharedWith.join('/')}`);
    }
    result.species.forEach((sp, idx) => {
      lines.push(
        [
          wellLabel,
          groupLabel,
          result.acidBase.effectiveMedium,
          result.condition.temperatureC,
          result.acidBase.effectivePhDmso,
          idx + 1,
          sp.tier,
          sp.score.toFixed(3),
          sp.likelihood.toFixed(3),
          sp.persistence.toFixed(3),
          sp.reversibleEnd ? 'yes' : 'no',
          sp.tautomerForms,
          sp.status === 'sink' ? 'Stable Product' : sp.status === 'transient' ? 'Reversible Intermediate' : 'Byproduct',
          sp.formula,
          sp.exactMass.toFixed(4),
          sp.mhPlus.toFixed(4),
          sp.mNaPlus.toFixed(4),
          sp.mHMinus.toFixed(4),
          sp.clogP.toFixed(2),
          sp.tpsa.toFixed(1),
          (sp.lossIons ?? []).map((l) => `${l.label} ${l.mz.toFixed(4)}`).join('; '),
          [...(amb.get(sp.key) ?? [])].join('; '),
          sp.stepsCount,
          sp.mechanismSummary,
          sp.smiles,
          sp.alerts.map((a) => a.message).join('; '),
        ]
          .map(esc)
          .join(',')
      );
    });
  }

  return lines.join('\n');
}

export function getSuggestedWellDisplay(row: RunRow, run: RunResult | null, triMeta: any[]) {
  const meta = triMeta?.[row.global_index];
  const groupLabel = meta?.group
    ? `${meta.group}${meta.cond ? ` (${meta.cond})` : ''}`
    : row.label?.name
    ? `${row.label.name}${row.label.cond ? ` (${row.label.cond})` : ''}`
    : `Reaction #${row.global_index + 1}`;
  void run;
  return groupLabel;
}
