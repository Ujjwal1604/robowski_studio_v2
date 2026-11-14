// Robowski Studio - Bridge between Robowski RunState/RunRow wells and Reaction Predictor
import { Reagent, RunResult, RunRow, RunState } from '../../types';
import {
  MediumMode,
  PredictorSubstrateInput,
  WellConditionConfig,
  WellPredictionResult,
} from './types';

interface KnownAdditiveProfile {
  pattern: RegExp;
  medium: MediumMode;
  pka: number;
  label: string;
}

const KNOWN_ADDITIVES: KnownAdditiveProfile[] = [
  { pattern: /^Ac$|\bTsOH\b|toluenesulfonic|tosic/i, medium: 'acid', pka: 0.9, label: 'TsOH' },
  { pattern: /\bTFA\b|trifluoroacetic/i, medium: 'acid', pka: 3.45, label: 'TFA' },
  { pattern: /\bHCl\b|hydrochloric/i, medium: 'acid', pka: 1.8, label: 'HCl' },
  { pattern: /\bAcOH\b|acetic\s+acid/i, medium: 'acid', pka: 12.6, label: 'AcOH' },
  { pattern: /\bTfOH\b|triflic/i, medium: 'acid', pka: 0.3, label: 'TfOH' },
  { pattern: /^Ba$|\bDBU\b|diazabicyclo/i, medium: 'base', pka: 13.9, label: 'DBU' },
  { pattern: /\bTBD\b|\bMTBD\b|\bBTMG\b/i, medium: 'base', pka: 15.0, label: 'DBU/Guanidine base' },
  { pattern: /\bDIPEA\b|\bHunig|\bTEA\b|Et3N|triethylamine/i, medium: 'base', pka: 9.0, label: 'TEA / DIPEA' },
  { pattern: /\bK2CO3\b|\bCs2CO3\b|\bK3PO4\b|carbonate/i, medium: 'base', pka: 12.5, label: 'Carbonate base' },
  { pattern: /\bNaOH\b|\bKOH\b|\bKOtBu\b|\btBuOK\b/i, medium: 'base', pka: 18.0, label: 'Alkoxide / Hydroxide' },
];

export function isKnownAdditiveReagent(reagent: Reagent, state: RunState): KnownAdditiveProfile | null {
  const additiveCodes = new Set((state.tri?.adds || []).map((a) => a.code).filter(Boolean));
  const combined = `${reagent.code || ''} ${reagent.name || ''}`.trim();

  for (const prof of KNOWN_ADDITIVES) {
    if (prof.pattern.test(combined)) return prof;
  }
  if (additiveCodes.has(reagent.code)) {
    // Fallback heuristic if custom additive code in Triplet mode
    if (/^A|acid/i.test(combined)) return { pattern: /.*/, medium: 'acid', pka: 0.9, label: reagent.name || reagent.code };
    if (/^B|base/i.test(combined)) return { pattern: /.*/, medium: 'base', pka: 13.9, label: reagent.name || reagent.code };
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
  const substrates: PredictorSubstrateInput[] = organicItems.map((o, idx) => {
    const smi = (o.reagent.smiles || '').trim();
    if (!smi) missingSmilesCodes.push(o.reagent.code);
    const eq = minOrganicMm > 0 ? Math.round((o.concMm / minOrganicMm) * 100) / 100 : 1;
    return {
      id: `${o.reagent.code}_${idx}`,
      code: o.reagent.code,
      name: o.reagent.name || o.reagent.code,
      smiles: smi,
      equivalents: eq,
      concentrationMm: o.concMm,
    };
  });

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

  const elnTemp = Number(state.eln?.temperatureC);
  const defaultTemp = Number.isFinite(elnTemp) && elnTemp > 0 ? elnTemp : 80;

  const condition: WellConditionConfig = {
    medium: overrides?.medium ?? medium,
    additiveName: overrides?.additiveName ?? additiveName,
    additiveEquiv: overrides?.additiveEquiv ?? additiveEquiv,
    additivePka: overrides?.additivePka ?? additivePka,
    temperatureC: overrides?.temperatureC ?? defaultTemp,
    waterPct: overrides?.waterPct ?? 2.0,
    solvent: overrides?.solvent ?? (state.reactionSolvent || 'DMSO'),
    equivBasis: overrides?.equivBasis ?? 'limiting',
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
    'Role / State',
    'Formula',
    'Exact Mass',
    '[M+H]+',
    '[M+Na]+',
    '[M-H]-',
    'cLogP',
    'TPSA',
    'Steps',
    'Mechanism Chain',
    'Predicted SMILES',
    'Alerts',
  ];

  const lines = [headers.join(',')];

  for (const entry of results) {
    const { wellLabel, groupLabel, result } = entry;
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
          sp.status === 'sink' ? 'Stable Product' : sp.status === 'transient' ? 'Reversible Intermediate' : 'Byproduct',
          sp.formula,
          sp.exactMass.toFixed(4),
          sp.mhPlus.toFixed(4),
          sp.mNaPlus.toFixed(4),
          sp.mHMinus.toFixed(4),
          sp.clogP.toFixed(2),
          sp.tpsa.toFixed(1),
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
