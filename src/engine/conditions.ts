// Robowski Studio - Canonical Run Reaction Conditions & Hydrate Water Stoichiometry
import { Reagent, RunResult, RunState } from '../types';

/**
 * Volumetric water % (v/v) per 1 mM of H2O dissolved in solution:
 * 1 mmol/L * 18.015 mg/mmol / (0.998 mg/uL) = 18.051 uL/L = 0.0018051 % v/v.
 */
export const WATER_PCT_PER_MM = 0.001805;

export interface CanonicalRunConditions {
  solvent: string;
  temperatureC: number;
  baseWaterPct: number;
  reactionTimeHours: number | '';
  atmosphere: string;
  agitation: string;
  heatingApparatus: string;
  illumination: string;
  plateSealType: string;
}

export interface HydrateDetectionResult {
  waterEquivPerMol: number;
  source: 'smiles' | 'name' | null;
  label: string | null;
}

export interface RunHydrateItem {
  code: string;
  name: string;
  waterEquivPerMol: number;
  source: 'smiles' | 'name';
  label: string;
  minConcMm: number;
  maxConcMm: number;
  minWaterMm: number;
  maxWaterMm: number;
  minWaterPct: number;
  maxWaterPct: number;
}

export interface RunHydrateSummary {
  items: RunHydrateItem[];
  hasHydrates: boolean;
  minTotalHydrateWaterPct: number;
  maxTotalHydrateWaterPct: number;
  minEffectiveWaterPct: number;
  maxEffectiveWaterPct: number;
  baseWaterPct: number;
}

const WATER_SMILES_FRAGMENTS = new Set(['O', '[H]O[H]', '[OH2]', 'OH2']);

const HYDRATE_WORD_MULTIPLIERS: Array<[RegExp, number, string]> = [
  [/\bdodecahydrate\b/i, 12, 'Dodecahydrate (12 H₂O)'],
  [/\bundecahydrate\b/i, 11, 'Undecahydrate (11 H₂O)'],
  [/\bdecahydrate\b/i, 10, 'Decahydrate (10 H₂O)'],
  [/\bnonahydrate\b/i, 9, 'Nonahydrate (9 H₂O)'],
  [/\boctahydrate\b/i, 8, 'Octahydrate (8 H₂O)'],
  [/\bheptahydrate\b/i, 7, 'Heptahydrate (7 H₂O)'],
  [/\bhexahydrate\b/i, 6, 'Hexahydrate (6 H₂O)'],
  [/\bpentahydrate\b/i, 5, 'Pentahydrate (5 H₂O)'],
  [/\btetrahydrate\b/i, 4, 'Tetrahydrate (4 H₂O)'],
  [/\btrihydrate\b/i, 3, 'Trihydrate (3 H₂O)'],
  [/\bsesquihydrate\b/i, 1.5, 'Sesquihydrate (1.5 H₂O)'],
  [/\bdihydrate\b/i, 2, 'Dihydrate (2 H₂O)'],
  [/\bhemihydrate\b|\bsemihydrate\b/i, 0.5, 'Hemihydrate (0.5 H₂O)'],
  [/\bmonohydrate\b/i, 1, 'Monohydrate (1 H₂O)'],
];

function parseHydrateCountFromText(rawText: string): { count: number; label: string } {
  const text = (rawText || '').trim();
  if (!text) return { count: 0, label: '' };

  // Check explicit formula annotations first (e.g. "TsOH·H2O", "CuSO4·5H2O", "K2CO3 · 1.5 H2O")
  // Separator or start of string ensures we don't match random substrings like "CH2O" or "pH2O".
  const formulaRegex = /(?:^|[\s·•*.\/,(+-])(?:(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*\*?\s*)?H[2₂]O(?=$|[\s),.;\]*])/g;
  let maxFormulaCount = 0;
  let match: RegExpExecArray | null;
  while ((match = formulaRegex.exec(text)) !== null) {
    const stoichStr = (match[1] || '').trim();
    let count = 1;
    if (stoichStr) {
      if (stoichStr.includes('/')) {
        const [num, den] = stoichStr.split('/').map(Number);
        if (Number.isFinite(num) && Number.isFinite(den) && den > 0) count = num / den;
      } else {
        const val = Number(stoichStr);
        if (Number.isFinite(val) && val > 0) count = val;
      }
    }
    if (count > maxFormulaCount) maxFormulaCount = count;
  }

  // If marked explicitly anhydrous without a counter-formula, treat word patterns as 0
  if (/\banhydrous\b|\banhydrate\b/i.test(text) && maxFormulaCount === 0) {
    return { count: 0, label: '' };
  }

  for (const [rx, val, lbl] of HYDRATE_WORD_MULTIPLIERS) {
    if (rx.test(text)) {
      const best = Math.max(val, maxFormulaCount);
      return {
        count: best,
        label: maxFormulaCount > val ? `${best} H₂O` : lbl,
      };
    }
  }

  // Numeric prefix before "-hydrate" / " hydrate" (e.g. "1.5-hydrate", "3 hydrate")
  const numHydrateMatch = text.match(/(?:^|[\s,(])(\d+(?:\.\d+)?)\s*[-\s]?hydrate\b/i);
  if (numHydrateMatch) {
    const val = Number(numHydrateMatch[1]);
    if (Number.isFinite(val) && val > 0) {
      const best = Math.max(val, maxFormulaCount);
      return { count: best, label: `${best} H₂O` };
    }
  }

  // Standalone word "hydrate" (word boundaries avoid "carbohydrate")
  if (/\bhydrate\b/i.test(text)) {
    const best = Math.max(1, maxFormulaCount);
    return { count: best, label: best === 1 ? 'Hydrate (1 H₂O)' : `${best} H₂O` };
  }

  if (maxFormulaCount > 0) {
    return {
      count: maxFormulaCount,
      label: maxFormulaCount === 1 ? 'Monohydrate (1 H₂O)' : `${maxFormulaCount} H₂O`,
    };
  }

  return { count: 0, label: '' };
}

/**
 * Detects water of crystallization from both SMILES (e.g. ".O", ".O.O") and chemical name/IUPAC
 * (e.g. "p-TsOH·H2O", "CuSO4 pentahydrate"), without double-counting when both match.
 */
export function detectHydrateStoichiometry(
  smiles?: string,
  name?: string,
  iupac?: string
): HydrateDetectionResult {
  const smi = (smiles || '').trim();
  let smilesCount = 0;
  if (smi && smi.includes('.')) {
    const frags = smi.split('.').map((f) => f.trim()).filter(Boolean);
    for (const f of frags) {
      if (WATER_SMILES_FRAGMENTS.has(f)) {
        smilesCount += 1;
      }
    }
  }

  const fromName = parseHydrateCountFromText(name || '');
  const fromIupac = parseHydrateCountFromText(iupac || '');
  const nameCount = Math.max(fromName.count, fromIupac.count);
  const nameLabel = fromName.count >= fromIupac.count ? fromName.label : fromIupac.label;

  const waterEquivPerMol = Math.max(smilesCount, nameCount);
  if (waterEquivPerMol <= 0) {
    return { waterEquivPerMol: 0, source: null, label: null };
  }

  const source: 'smiles' | 'name' = smilesCount >= nameCount ? 'smiles' : 'name';
  const label =
    nameLabel ||
    (waterEquivPerMol === 1 ? 'Monohydrate (1 H₂O)' : `${waterEquivPerMol} H₂O`);

  return { waterEquivPerMol, source, label };
}

function parseFiniteNum(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns the single canonical reaction condition configuration for a RunState,
 * reading top-level condition fields first with seamless fallback to state.eln.
 */
export function getCanonicalRunConditions(state: RunState): CanonicalRunConditions {
  const eln = state.eln;
  const temp = parseFiniteNum(eln?.temperatureC) ?? parseFiniteNum(state.temperatureC) ?? 25;
  const water = parseFiniteNum(eln?.waterPct) ?? parseFiniteNum(state.waterPct) ?? 2.0;
  const rawTime = eln?.reactionTimeHours;
  const parsedTime = rawTime === '' ? '' : parseFiniteNum(rawTime) ?? 16;

  return {
    solvent: state.reactionSolvent || 'ethanol',
    temperatureC: temp,
    baseWaterPct: Math.max(0, water),
    reactionTimeHours: parsedTime,
    atmosphere: eln?.atmosphere ?? 'N2 Glovebox',
    agitation: eln?.agitation ?? 'Tumble stirrer 800 rpm',
    heatingApparatus: eln?.heatingApparatus ?? '',
    illumination: eln?.illumination ?? 'None',
    plateSealType: eln?.plateSealType ?? 'Teflon silicone bonded mat',
  };
}

/**
 * Applies a partial condition update to RunState while keeping top-level state and state.eln
 * synchronized so Setup, Predictor, TLC, ELN, Compare, and Exports stay uniform.
 */
export function applyRunConditionsPatch(
  prev: RunState,
  patch: Partial<CanonicalRunConditions>
): RunState {
  const next: RunState = JSON.parse(JSON.stringify(prev));
  if (!next.eln) {
    next.eln = {
      campaignTitle: next.name || '',
      objective: '',
      reactionClass: '',
      temperatureC: 25,
      waterPct: 2.0,
      reactionTimeHours: 16,
      atmosphere: 'N2 Glovebox',
      agitation: 'Tumble stirrer 800 rpm',
      illumination: 'None',
      plateSealType: 'Teflon silicone bonded mat',
      postReactionNotes: '',
      wells: {},
    };
  } else if (!next.eln.wells) {
    next.eln.wells = {};
  }

  if (patch.solvent !== undefined) {
    next.reactionSolvent = patch.solvent;
  }
  if (patch.temperatureC !== undefined) {
    next.temperatureC = patch.temperatureC;
    next.eln.temperatureC = patch.temperatureC;
  }
  if (patch.baseWaterPct !== undefined) {
    const cleanWater = Math.max(0, Number(patch.baseWaterPct) || 0);
    next.waterPct = cleanWater;
    next.eln.waterPct = cleanWater;
  }
  if (patch.reactionTimeHours !== undefined) {
    next.eln.reactionTimeHours = patch.reactionTimeHours;
  }
  if (patch.atmosphere !== undefined) {
    next.eln.atmosphere = patch.atmosphere;
  }
  if (patch.agitation !== undefined) {
    next.eln.agitation = patch.agitation;
  }
  if (patch.heatingApparatus !== undefined) {
    next.eln.heatingApparatus = patch.heatingApparatus;
  }
  if (patch.illumination !== undefined) {
    next.eln.illumination = patch.illumination;
  }
  if (patch.plateSealType !== undefined) {
    next.eln.plateSealType = patch.plateSealType;
  }

  return next;
}

/**
 * Summarizes hydrate reagents and exact % v/v water contributed across active wells.
 */
export function summarizeRunHydrates(
  state: RunState,
  run?: RunResult | null
): RunHydrateSummary {
  const cond = getCanonicalRunConditions(state);
  const hydrateByCode = new Map<string, { reagent: Reagent; det: HydrateDetectionResult }>();
  for (const r of state.reagents || []) {
    const det = detectHydrateStoichiometry(r.smiles, r.name, r.iupac);
    if (det.waterEquivPerMol > 0) {
      hydrateByCode.set(r.code, { reagent: r, det });
    }
  }

  if (hydrateByCode.size === 0) {
    return {
      items: [],
      hasHydrates: false,
      minTotalHydrateWaterPct: 0,
      maxTotalHydrateWaterPct: 0,
      minEffectiveWaterPct: cond.baseWaterPct,
      maxEffectiveWaterPct: cond.baseWaterPct,
      baseWaterPct: cond.baseWaterPct,
    };
  }

  const wellHydrateTotals: number[] = [];
  const concsByCode = new Map<string, number[]>();

  if (run?.rows && run.rows.length > 0) {
    for (const row of run.rows) {
      let rowHydratePct = 0;
      let anyActive = false;
      for (const rec of row.recipe || []) {
        const concMm = Number(rec.target_concentration) || 0;
        if (concMm <= 0) continue;
        anyActive = true;
        const h = hydrateByCode.get(rec.code);
        if (h) {
          let list = concsByCode.get(rec.code);
          if (!list) {
            list = [];
            concsByCode.set(rec.code, list);
          }
          list.push(concMm);
          rowHydratePct += concMm * h.det.waterEquivPerMol * WATER_PCT_PER_MM;
        }
      }
      if (anyActive) wellHydrateTotals.push(rowHydratePct);
    }
  }

  const items: RunHydrateItem[] = [];
  for (const [code, { reagent, det }] of hydrateByCode.entries()) {
    const concs = concsByCode.get(code);
    const minConcMm = concs && concs.length ? Math.min(...concs) : 50;
    const maxConcMm = concs && concs.length ? Math.max(...concs) : 50;
    const minWaterMm = minConcMm * det.waterEquivPerMol;
    const maxWaterMm = maxConcMm * det.waterEquivPerMol;
    items.push({
      code,
      name: reagent.name || code,
      waterEquivPerMol: det.waterEquivPerMol,
      source: det.source || 'name',
      label: det.label || `${det.waterEquivPerMol} H₂O`,
      minConcMm,
      maxConcMm,
      minWaterMm,
      maxWaterMm,
      minWaterPct: Math.round(minWaterMm * WATER_PCT_PER_MM * 1000) / 1000,
      maxWaterPct: Math.round(maxWaterMm * WATER_PCT_PER_MM * 1000) / 1000,
    });
  }

  const minTotalHydrateWaterPct = wellHydrateTotals.length
    ? Math.round(Math.min(...wellHydrateTotals) * 1000) / 1000
    : Math.round(items.reduce((s, it) => s + it.minWaterPct, 0) * 1000) / 1000;
  const maxTotalHydrateWaterPct = wellHydrateTotals.length
    ? Math.round(Math.max(...wellHydrateTotals) * 1000) / 1000
    : Math.round(items.reduce((s, it) => s + it.maxWaterPct, 0) * 1000) / 1000;

  return {
    items,
    hasHydrates: true,
    minTotalHydrateWaterPct,
    maxTotalHydrateWaterPct,
    minEffectiveWaterPct: Math.round((cond.baseWaterPct + minTotalHydrateWaterPct) * 1000) / 1000,
    maxEffectiveWaterPct: Math.round((cond.baseWaterPct + maxTotalHydrateWaterPct) * 1000) / 1000,
    baseWaterPct: cond.baseWaterPct,
  };
}
