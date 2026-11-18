// Robowski Studio - Empirical TLC Self-Calibration from Campaign Plate Measurements
import { RunResult, RunState, TlcLane, TlcSet, TlcSpot } from '../../types';
import {
  analyzeLaneBoundaryOccupancy,
  containerOfLane,
  findSpots,
  getChannelHistogram,
  TLC_SIGNAL,
  TlcChannelKey,
  tlcFront,
  tlcOrigin,
  wellLabel,
} from '../tlcLanes';
import { getTlcPlateSlice } from '../tlcPlateSlice';
import { extractWellForPrediction } from './plateBridge';
import { predictWellReactions } from './engine';
import {
  buildWellTlcContext,
  CalibratedLaneComparison,
  CalibratedPlateSummary,
  computeCalibrationFeatureVector,
  computeFeatureDemandDelta,
  findSolventSystemById,
  predictTlcRf,
  profileMoleculeForTlc,
  RF_SIGMA,
  SolventFamily,
  TLC_SOLVENT_LIBRARY,
  TlcCalibrationFeatureWeights,
  TlcCalibrationModel,
  TlcCalibrationPhaseFit,
  TlcCalibrationSpotPair,
  TlcMolProfile,
  TlcSolventSystemDef,
  TlcStationaryPhasePreference,
} from './tlcSolventAdvisor';
import {
  composeSolventSystem,
  generateExtendedDynamicSpecs,
  generatePrismaTernarySpecs,
} from './solventSystemModel';
import { PredictedSpecies, WellPredictionResult } from './types';

const CORE_SYSTEM_IDS = new Set(TLC_SOLVENT_LIBRARY.map((s) => s.id));
const DYNAMIC_SOLVENT_SYSTEMS: TlcSolventSystemDef[] = [
  ...generateExtendedDynamicSpecs({
    hasStrongWellAcid: true,
    needsBasicMod: true,
    needsAcidMod: true,
    aromaticHeavyPlate: true,
  }),
  ...generatePrismaTernarySpecs({
    targetStrengths: [0.3, 0.5, 0.72],
    aromaticHeavyPlate: true,
    hasStrongWellAcid: false,
    maxAcidStress: 0,
    needsBasicMod: false,
    needsAcidMod: false,
  }),
]
  .filter((spec) => !CORE_SYSTEM_IDS.has(spec.id))
  .map(composeSolventSystem);

export interface SolventNameMatchResult {
  system: TlcSolventSystemDef;
  stationaryPhase: TlcStationaryPhasePreference;
  matchSource: 'auto' | 'manual';
}

export interface MeasuredWellSpots {
  wellIndex: number;
  laneId: number;
  spots: TlcSpot[];
  hasWhiteChannel: boolean;
  originOccupied?: boolean;
  frontOccupied?: boolean;
  originExcess?: number;
  frontExcess?: number;
}

export interface SetExtractionResult {
  laneCountWithSpots: number;
  hasValidCalibration: boolean;
  hasWhiteChannel: boolean;
  wells: Map<number, MeasuredWellSpots>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeSolventText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/₂/g, '2')
    .replace(/₃/g, '3')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseStationaryPhaseFromSetName(name: string): TlcStationaryPhasePreference {
  const norm = normalizeSolventText(name);
  if (/neutral\s*al2o3|neutral\s*alumina/.test(norm)) return 'Al2O3_neutral';
  if (/basic\s*al2o3|basic\s*alumina/.test(norm)) return 'Al2O3_basic';
  if (/\bc18\b|rp[-\s]*18|reverse[-\s]*phase|mecn\s*\/\s*h2o|meoh\s*\/\s*h2o/.test(norm)) return 'C18';
  return 'SiO2';
}

/**
 * Matches a TLC tab name (either advisor-generated or chemist shorthand like "1:1 EA/Hex" or "5% MeOH/DCM + Et3N")
 * to a solvent system definition in TLC_SOLVENT_LIBRARY.
 */
export function matchTlcSetNameToSolvent(
  name: string,
  manualSystemId?: string
): SolventNameMatchResult | null {
  if (manualSystemId === 'ignore') return null;

  const parsedPhase = parseStationaryPhaseFromSetName(name);

  if (manualSystemId) {
    const manualSys = findSolventSystemById(manualSystemId);
    if (manualSys) {
      return {
        system: manualSys,
        stationaryPhase:
          manualSys.stationaryPhase === 'C18'
            ? 'C18'
            : parsedPhase === 'Al2O3_neutral' || parsedPhase === 'Al2O3_basic'
            ? parsedPhase
            : 'SiO2',
        matchSource: 'manual',
      };
    }
  }

  const rawNorm = normalizeSolventText(name)
    .replace(/\((neutral al2o3|basic al2o3|sio2|c18[^)]*)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!rawNorm || /^(set\s*\d+|plate\s*\d+|tlc\s*\d*|untitled)$/.test(rawNorm)) {
    return null;
  }

  // 1. Exact or normalized match on canonical or dynamic composed name / shortLabel
  for (const sys of [...TLC_SOLVENT_LIBRARY, ...DYNAMIC_SOLVENT_SYSTEMS]) {
    const sysName = normalizeSolventText(sys.name).replace(/\(c18 rp\)/g, '').trim();
    const sysShort = normalizeSolventText(sys.shortLabel).replace(/\(c18\)/g, '').trim();
    if (rawNorm === sysName || rawNorm === sysShort || rawNorm === normalizeSolventText(sys.name)) {
      return {
        system: sys,
        stationaryPhase: sys.stationaryPhase === 'C18' ? 'C18' : parsedPhase === 'C18' ? 'SiO2' : parsedPhase,
        matchSource: 'auto',
      };
    }
  }

  // 2. Heuristic parser for common shorthand solvent names
  const hasEt3N = /et3n|tea\b/.test(rawNorm);
  const hasNh3 = /nh3|nh4oh/.test(rawNorm);
  const hasAcOH = /acoh|hoac|acetic/.test(rawNorm);
  const hasTfa = /tfa/.test(rawNorm);

  // Extract percentage or ratio A:B
  let pct: number | null = null;
  const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(rawNorm);
  const ratioMatch = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(rawNorm);
  const isNeatHexanes = /^(?:100%\s*|neat\s*)?(?:hex|hexanes?|hept|heptane)\s*$/.test(rawNorm);
  const isNeatEtOAc = /(?:^|\b)(?:100%\s*|neat\s*)?(?:etoac|ea|ethyl acetate)\s*$/.test(rawNorm);
  const isNeatDcm = /(?:^|\b)(?:100%\s*|neat\s*)?(?:dcm|ch2cl2)\s*$/.test(rawNorm);

  if (pctMatch) {
    pct = parseFloat(pctMatch[1]);
  } else if (ratioMatch) {
    const a = parseFloat(ratioMatch[1]);
    const b = parseFloat(ratioMatch[2]);
    if (a + b > 0) {
      // Handle inverted hex:ea order such as "2:1 Hex/EtOAc" -> 33% EtOAc
      const hexFirst = /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:hex|hexanes|pentane)\s*\/\s*(?:etoac|ea|acetone|et2o)/.test(rawNorm);
      const dcmFirst = /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:dcm|ch2cl2)\s*\/\s*(?:meoh|nh3)/.test(rawNorm);
      pct = (hexFirst || dcmFirst ? (b / (a + b)) : (a / (a + b))) * 100;
    }
  } else if (isNeatHexanes) {
    pct = 0;
  } else if (isNeatEtOAc) {
    pct = 100;
  } else if (isNeatDcm) {
    pct = 0;
  }

  const pickClosest = (candidates: TlcSolventSystemDef[], targetStrength: number): TlcSolventSystemDef | null => {
    if (candidates.length === 0) return null;
    let best = candidates[0];
    let bestDiff = Math.abs(best.strength - targetStrength);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(candidates[i].strength - targetStrength);
      if (d < bestDiff) {
        bestDiff = d;
        best = candidates[i];
      }
    }
    return bestDiff <= 0.16 ? best : null;
  };

  let candidate: TlcSolventSystemDef | null = null;

  // Reverse-phase C18 shorthand
  if (parsedPhase === 'C18' || /mecn.*h2o|acn.*h2o|meoh.*h2o/.test(rawNorm)) {
    const isMeOH = /meoh/.test(rawNorm);
    const pool = TLC_SOLVENT_LIBRARY.filter(
      (s) =>
        s.stationaryPhase === 'C18' &&
        (hasTfa ? Boolean(s.acidModifier) : !s.acidModifier) &&
        (isMeOH ? s.id.includes('meoh') : s.id.includes('mecn'))
    );
    const targetOrg = pct !== null ? clamp(pct / 100, 0.15, 0.95) : 0.6;
    candidate = pickClosest(pool.length > 0 ? pool : TLC_SOLVENT_LIBRARY.filter((s) => s.stationaryPhase === 'C18'), targetOrg);
    if (candidate) {
      return { system: candidate, stationaryPhase: 'C18', matchSource: 'auto' };
    }
  }

  // Normal-phase families
  const npPhase: TlcStationaryPhasePreference =
    parsedPhase === 'Al2O3_neutral' || parsedPhase === 'Al2O3_basic' ? parsedPhase : 'SiO2';

  const isEtoacHex = /(etoac|\bea\b|ethyl acetate).*(hex|hept)|(?:hex|hept).*(etoac|\bea\b)|^100%\s*etoac|^neat\s*(?:etoac|ea)/.test(rawNorm);
  const isMeohDcm = /(meoh|methanol).*(dcm|ch2cl2|nh3)|(dcm|ch2cl2).*(meoh|nh3)/.test(rawNorm);
  const isAcetoneHex = /acetone.*hex|hex.*acetone/.test(rawNorm);
  const isMeohTol = /meoh.*tol|tol.*meoh/.test(rawNorm);
  const isEtoacTol = /(etoac|\bea\b|ethyl acetate).*tol|tol.*(etoac|\bea\b|ethyl acetate)/.test(rawNorm);
  const isMeohEtoac = /meoh.*etoac|etoac.*meoh|meoh.*\bea\b/.test(rawNorm);
  const isEtoacDcm = /(etoac|\bea\b).*(dcm|ch2cl2)|(dcm|ch2cl2).*(etoac|\bea\b)/.test(rawNorm);
  const isEtherPentane = /(et2o|ether).*pentane|pentane.*(et2o|ether)/.test(rawNorm);
  const isMtbeHex = /\bmtbe\b.*hex|hex.*\bmtbe\b/.test(rawNorm);

  if (isEtoacHex || isNeatEtOAc || isNeatHexanes) {
    const p = clamp(pct ?? 50, 0, 100);
    const pool = TLC_SOLVENT_LIBRARY.filter((s) => {
      if (hasEt3N) return s.family === 'basic_mod' && s.baseModifier?.includes('Et₃N') && s.alcoholPct === 0;
      if (hasAcOH) return s.family === 'acid_mod' && s.alcoholPct === 0;
      return s.family === 'etoac_hex';
    });
    // Piecewise strength mapping so 0% (0.00), 2% (0.04), 5% (0.09), 10% (0.14), 25% (0.28), 50% (0.45), 100% (0.69) map accurately
    const approxStrength =
      p <= 10
        ? (p / 10) * 0.14
        : p <= 25
        ? 0.14 + ((p - 10) / 15) * 0.14
        : 0.28 + ((p - 25) / 75) * 0.41;
    candidate = pickClosest(pool, approxStrength);
  } else if (isMeohDcm || isNeatDcm) {
    const p = pct ?? 5;
    const isHighNh3 = hasNh3 && (/4%\s*\(?2m\s*nh3|94\s*:\s*2\s*:\s*4|88\s*:\s*8\s*:\s*4|4%\s*nh3/.test(rawNorm));
    const poolSource = isHighNh3 ? DYNAMIC_SOLVENT_SYSTEMS : TLC_SOLVENT_LIBRARY;
    const pool = poolSource.filter((s) => {
      if (hasNh3) return Boolean(s.baseModifier?.includes('NH₃'));
      if (hasEt3N) return Boolean(s.baseModifier?.includes('Et₃N')) && s.alcoholPct > 0;
      if (hasAcOH) return Boolean(s.acidModifier) && s.alcoholPct > 0;
      return s.family === 'meoh_dcm';
    });
    const approxStrength = 0.43 + clamp(p, 0, 18) * 0.036;
    candidate = pickClosest(pool, approxStrength);
  } else if (isAcetoneHex) {
    const p = pct ?? 35;
    candidate = pickClosest(
      TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'acetone_hex'),
      0.18 + (p / 100) * 0.56
    );
  } else if (isMtbeHex) {
    const p = pct ?? 25;
    candidate = pickClosest(
      TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'mtbe_hex'),
      0.12 + (p / 100) * 0.34
    );
  } else if (isMeohTol) {
    const p = pct ?? 6;
    const tolPool = hasEt3N
      ? DYNAMIC_SOLVENT_SYSTEMS.filter((s) => s.family === 'meoh_toluene' && Boolean(s.baseModifier?.includes('Et₃N')))
      : TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'meoh_toluene');
    candidate = pickClosest(tolPool, 0.40 + p * 0.035);
  } else if (isEtoacTol) {
    const p = pct ?? 25;
    const etTolPool = DYNAMIC_SOLVENT_SYSTEMS.filter(
      (s) => s.composition?.strongSolvent === 'EtOAc' && s.composition?.weakSolvent === 'Toluene'
    );
    candidate = pickClosest(etTolPool, 0.23 + (p / 100) * 0.46);
  } else if (isMeohEtoac) {
    const p = pct ?? 8;
    candidate = pickClosest(
      TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'meoh_etoac'),
      0.66 + p * 0.015
    );
  } else if (isEtoacDcm) {
    const p = pct ?? 20;
    candidate = pickClosest(
      TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'etoac_dcm'),
      0.34 + (p / 100) * 0.45
    );
  } else if (isEtherPentane) {
    const p = pct ?? 30;
    candidate = pickClosest(
      TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'ether_pentane'),
      0.10 + (p / 100) * 0.45
    );
  }

  if (!candidate) return null;
  if ((npPhase === 'Al2O3_neutral' || npPhase === 'Al2O3_basic') && (candidate.acidModifier || candidate.baseModifier)) {
    return null;
  }
  return { system: candidate, stationaryPhase: npPhase, matchSource: 'auto' };
}

function defaultGetProfile(set: TlcSet, key: TlcChannelKey, lane: TlcLane): number[] {
  const ckCore = `${key}:${lane.id}:0.35`;
  if (set.prof?.[ckCore]) return set.prof[ckCore];
  const ckPlain = `${key}:${lane.id}`;
  if (set.prof?.[ckPlain]) return set.prof[ckPlain];
  return [];
}

function availableChannelsForSlice(slice: TlcSet): TlcChannelKey[] {
  const out: TlcChannelKey[] = [];
  for (const ch of ['UV254', 'UV366', 'White'] as TlcChannelKey[]) {
    const hasBmp = Boolean(slice.imgs?.[ch]?.bmp);
    const hasProf = Boolean(
      slice.prof && Object.keys(slice.prof).some((k) => k.startsWith(`${ch}:`) && (slice.prof?.[k]?.length || 0) > 10)
    );
    if (hasBmp || hasProf) out.push(ch);
  }
  return out;
}

/**
 * Extracts measured TLC spot Rfs per well (0..53 container index) from a plate slice,
 * matching the same origin/front & spot-merging rules used in PlateHeatmap.
 */
export function extractMeasuredWellSpotsForSet(
  setSlice: TlcSet,
  options: {
    getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[];
    spotProminence?: number;
  } = {}
): SetExtractionResult {
  const lanes = setSlice.cfg?.lanes || [];
  const wells = new Map<number, MeasuredWellSpots>();
  if (lanes.length === 0) {
    return { laneCountWithSpots: 0, hasValidCalibration: false, hasWhiteChannel: false, wells };
  }

  const getProf = options.getProfile || defaultGetProfile;
  const spotProm = options.spotProminence ?? setSlice.spotProminence ?? 0.28;
  const channels = availableChannelsForSlice(setSlice);
  const hasWhiteChannel = channels.includes('White');
  const hasAnyCustom = lanes.some((l) => l.customSpots && l.customSpots.length > 0);
  if (channels.length === 0 && !hasAnyCustom) {
    return { laneCountWithSpots: 0, hasValidCalibration: false, hasWhiteChannel, wells };
  }

  let validSpanLanes = 0;
  let laneCountWithSpots = 0;
  let boundaryOccupiedLanes = 0;
  const boundaryInputs: Array<{ laneId: number; profile: number[]; origin: number; front: number; sign: number }> = [];
  const laneResults = new Map<number, { spots: TlcSpot[] }>();

  for (const lane of lanes) {
    try {
      const hasCustom = Array.isArray(lane.customSpots);
      let mergedSpots: TlcSpot[] = [];

      if (hasCustom) {
        mergedSpots = [...lane.customSpots!];
        validSpanLanes++;
      } else {
        const oVal = tlcOrigin(setSlice, lane, getProf);
        const fVal = tlcFront(setSlice, lane, getProf);
        const span = fVal - oVal;
        const minSpan = Math.max(25, (lane.length || 400) * 0.25);
        if (!Number.isFinite(span) || span < minSpan) continue;
        validSpanLanes++;

        // Prefer UV254 then UV366; include White only if present
        let primaryChRecorded = false;
        for (const ch of channels) {
          const prof = getProf(setSlice, ch, lane);
          if (!prof || prof.length < 10) continue;
          if (!primaryChRecorded) {
            boundaryInputs.push({
              laneId: lane.id,
              profile: prof,
              origin: oVal,
              front: fVal,
              sign: TLC_SIGNAL[ch]?.sign ?? -1,
            });
            primaryChRecorded = true;
          }
          const chSpots = findSpots(prof, {
            sign: TLC_SIGNAL[ch]?.sign ?? -1,
            origin: oVal,
            front: fVal,
            radius: lane.spotRadius || 24,
            minProminence: spotProm,
            plateHistogram: getChannelHistogram(setSlice, ch, getProf),
          });
          for (const sp of chSpots) {
            const match = mergedSpots.find((m) => Math.abs(m.rf - sp.rf) < 0.04);
            if (!match) {
              mergedSpots.push({ ...sp });
            } else if (sp.strength > match.strength) {
              match.strength = sp.strength;
              match.pos = sp.pos;
            }
          }
        }
      }

      const cleanSpots = mergedSpots
        .filter((sp) => Number.isFinite(sp.rf) && sp.rf >= 0.01 && sp.rf <= 0.99)
        .sort((a, b) => a.rf - b.rf);

      if (cleanSpots.length > 0) laneCountWithSpots++;
      laneResults.set(lane.id, { spots: cleanSpots });
    } catch {
      // Skip problematic lane
    }
  }

  const boundaryMap = analyzeLaneBoundaryOccupancy(boundaryInputs);

  for (const lane of lanes) {
    const res = laneResults.get(lane.id);
    if (!res) continue;
    const wellIdx = containerOfLane(lane.id);
    const bnd = boundaryMap.get(lane.id);
    const highSpotFront = res.spots.some((s) => s.rf >= 0.92);
    const lowSpotOrigin = res.spots.some((s) => s.rf <= 0.05);
    const frontOccupied = Boolean(bnd?.frontOccupied || highSpotFront);
    const originOccupied = Boolean(bnd?.originOccupied || lowSpotOrigin);
    if (frontOccupied || originOccupied) boundaryOccupiedLanes++;
    wells.set(wellIdx, {
      wellIndex: wellIdx,
      laneId: lane.id,
      spots: res.spots,
      hasWhiteChannel,
      frontOccupied,
      originOccupied,
      frontExcess: bnd?.frontExcess ?? (highSpotFront ? 0.5 : 0),
      originExcess: bnd?.originExcess ?? (lowSpotOrigin ? 0.5 : 0),
    });
  }

  return {
    laneCountWithSpots: Math.max(laneCountWithSpots, boundaryOccupiedLanes > 0 ? boundaryOccupiedLanes : 0),
    hasValidCalibration: validSpanLanes >= 2 && (laneCountWithSpots >= 1 || boundaryOccupiedLanes >= 1),
    hasWhiteChannel,
    wells,
  };
}

function logitRf(rf: number): number {
  const p = clamp(rf, 0.02, 0.97);
  return Math.log(p / (1 - p));
}

export function applyCalibrationShiftToRf(
  rfBefore: number,
  demandShift: number,
  isC18: boolean,
  demandSlope: number = 1.0,
  featureDelta: number = 0,
  displacementN: number = 1.0
): number {
  const rawDispScale = isC18 ? 0.6 + 0.4 * displacementN : displacementN;
  const dispScale = rfBefore > 0.5 ? Math.max(1.0, rawDispScale) : rawDispScale;
  const k = (isC18 ? 4.8 : 6.2) * dispScale;
  const zAfter = demandSlope * (logitRf(rfBefore) - k * (demandShift + featureDelta));
  const raw = 1 / (1 + Math.exp(-clamp(zAfter, -12, 12)));
  return Math.round(clamp(raw, 0.02, 0.99) * 100) / 100;
}

export function rfShiftAtMidplate(globalDemandShift: number, isC18: boolean = false): number {
  const k = isC18 ? 4.8 : 6.2;
  const z = clamp(-k * globalDemandShift, -12, 12);
  return Math.round((1 / (1 + Math.exp(-z)) - 0.5) * 1000) / 1000;
}

/** Solves small k x k linear system A x = b via Gauss-Jordan partial pivoting */
function solveSmallLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const diag = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

interface PredAnchor {
  label: string;
  kind: 'substrate' | 'product';
  tier?: PredictedSpecies['tier'];
  rf: number;
  weight: number;
  profile: TlcMolProfile;
}

/**
 * Conservatively pairs sorted measured spots (<= 5) with sorted predicted UV species spots
 * using order-preserving dynamic programming (with a strict +/-0.24 Rf gate and ambiguity rejection).
 */
function pairMeasuredAndPredictedSpots(
  obsSpots: TlcSpot[],
  preds: PredAnchor[]
): Array<{ obs: TlcSpot; pred: PredAnchor }> {
  if (obsSpots.length === 0 || preds.length === 0 || obsSpots.length > 5) return [];

  // Deduplicate predicted anchors within 0.035 Rf (keeping highest weight representative)
  const sortedPreds = [...preds].sort((a, b) => a.rf - b.rf);
  const dedupPreds: PredAnchor[] = [];
  for (const p of sortedPreds) {
    const prev = dedupPreds[dedupPreds.length - 1];
    if (prev && Math.abs(p.rf - prev.rf) < 0.035) {
      if (p.weight > prev.weight) {
        dedupPreds[dedupPreds.length - 1] = p;
      }
    } else {
      dedupPreds.push(p);
    }
  }

  const MAX_RF_GAP = 0.24;
  const obs = [...obsSpots].sort((a, b) => a.rf - b.rf);

  // Single-spot lane guard: avoid arbitrary assignment if multiple predicted spots bracket the observed peak
  if (obs.length === 1) {
    const o = obs[0];
    if (dedupPreds.length === 1) {
      return Math.abs(o.rf - dedupPreds[0].rf) <= MAX_RF_GAP ? [{ obs: o, pred: dedupPreds[0] }] : [];
    }
    const sortedByDist = dedupPreds
      .map((p) => ({ p, d: Math.abs(o.rf - p.rf) }))
      .sort((a, b) => a.d - b.d);
    if (sortedByDist[0].d > MAX_RF_GAP) return [];

    const allSameSide =
      dedupPreds.every((p) => p.rf <= o.rf + 0.03) ||
      dedupPreds.every((p) => p.rf >= o.rf - 0.03);
    const clearWinner = sortedByDist[1].d - sortedByDist[0].d >= 0.07;

    if (clearWinner || allSameSide) {
      return [{ obs: o, pred: sortedByDist[0].p }];
    }
    return [];
  }

  // General monotonic injective matching of M observed spots onto N predicted spots (M <= N or partial)
  const m = obs.length;
  const n = dedupPreds.length;
  const kMatch = Math.min(m, n);

  // Backtrack all valid strictly-increasing matchings of size r = kMatch (or kMatch - 1 if one spot unmatched cleanly)
  // Small sizes (m <= 5, n <= 6) make exact recursion instant (< 50 states).
  let bestPairs: Array<{ oi: number; pi: number }> = [];
  let bestCost = Infinity;
  let secondBestCost = Infinity;

  const evalSubset = (oiStart: number, piStart: number, chosen: Array<{ oi: number; pi: number }>, cost: number, targetCount: number) => {
    if (chosen.length === targetCount) {
      if (cost < bestCost) {
        secondBestCost = bestCost;
        bestCost = cost;
        bestPairs = [...chosen];
      } else if (cost < secondBestCost) {
        secondBestCost = cost;
      }
      return;
    }
    const remNeed = targetCount - chosen.length;
    if (m - oiStart < remNeed || n - piStart < remNeed) return;

    for (let oi = oiStart; oi <= m - remNeed; oi++) {
      for (let pi = piStart; pi <= n - remNeed; pi++) {
        const diff = Math.abs(obs[oi].rf - dedupPreds[pi].rf);
        if (diff > MAX_RF_GAP) continue;
        chosen.push({ oi, pi });
        evalSubset(oi + 1, pi + 1, chosen, cost + diff, targetCount);
        chosen.pop();
      }
    }
  };

  evalSubset(0, 0, [], 0, kMatch);
  if (bestPairs.length === 0 && kMatch > 1) {
    bestCost = Infinity;
    secondBestCost = Infinity;
    evalSubset(0, 0, [], 0, kMatch - 1);
  }

  if (bestPairs.length === 0) return [];
  // If an alternative assignment exists with virtually identical cost (classic crossing flip), drop ambiguous pairs
  if (secondBestCost - bestCost < 0.03 && bestPairs.length > 1) {
    // Keep only pairs that agree in both assignments or sit cleanly far apart; simplest safe rule: only keep strong outer anchors if all residuals share the same sign
    const allPos = bestPairs.every(({ oi, pi }) => obs[oi].rf - dedupPreds[pi].rf >= -0.02);
    const allNeg = bestPairs.every(({ oi, pi }) => obs[oi].rf - dedupPreds[pi].rf <= 0.02);
    if (!allPos && !allNeg) return [];
  }

  return bestPairs.map(({ oi, pi }) => ({ obs: obs[oi], pred: dedupPreds[pi] }));
}

export interface CalibrateTlcParams {
  rdkit: any;
  state: RunState;
  run: RunResult | null;
  triMeta?: any[];
  tlcSets: TlcSet[];
  cachedPredictions?: Record<string, WellPredictionResult>;
  spotProminence?: number;
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[];
  setSolventOverrides?: Record<string, string>;
  conditionOverrides?: any;
  profileCache?: Map<string, TlcMolProfile>;
}

/**
 * Fits an empirical calibration model (demand shift, family shifts, and uncertainty sigma)
 * from already-measured TLC plates in the current campaign (`tlcSets`).
 */
export function calibrateTlcModelFromCampaign(params: CalibrateTlcParams): {
  model: TlcCalibrationModel;
  newlyComputedPredictions: Record<string, WellPredictionResult>;
} {
  const {
    rdkit,
    state,
    run,
    triMeta = [],
    tlcSets,
    cachedPredictions = {},
    spotProminence,
    getProfile,
    setSolventOverrides = {},
    conditionOverrides,
  } = params;
  const profileCache = params.profileCache || new Map<string, TlcMolProfile>();
  const newlyComputedPredictions: Record<string, WellPredictionResult> = {};
  const PLATE_SIZE = 54;

  const model: TlcCalibrationModel = {
    byPhase: {},
    plates: [],
    unmatchedSets: [],
  };

  if (!run?.rows?.length || !tlcSets || tlcSets.length === 0) {
    return { model, newlyComputedPredictions };
  }

  // Group run rows by plateIndex -> container wellIndex
  const rowsByPlate = new Map<number, Map<number, any>>();
  run.rows.forEach((r, idx) => {
    const p = r.plate_number ?? Math.floor(idx / PLATE_SIZE);
    const w = r.container_id ?? idx % PLATE_SIZE;
    let m = rowsByPlate.get(p);
    if (!m) {
      m = new Map();
      rowsByPlate.set(p, m);
    }
    m.set(w, r);
  });

  const numPlates = Math.max(run.plates || 1, rowsByPlate.size);
  const reactionMemo = new Map<string, WellPredictionResult | undefined>();

  // Intermediate pair and censored-boundary records per stationary phase
  interface RawPairRecord {
    plateSummaryIdx: number;
    family: SolventFamily;
    isC18: boolean;
    profile: TlcMolProfile;
    features: [number, number, number, number, number];
    displacementN: number;
    pair: Omit<TlcCalibrationSpotPair, 'predictedRfAfter'>;
  }
  interface CensoredBoundaryRecord {
    plateSummaryIdx: number;
    family: SolventFamily;
    isC18: boolean;
    kind: 'front' | 'baseline';
    predictedRfBefore: number;
    boundRf: number;
    weight: number;
  }
  const pairsByPhase = new Map<TlcStationaryPhasePreference, RawPairRecord[]>();
  const censoredByPhase = new Map<TlcStationaryPhasePreference, CensoredBoundaryRecord[]>();
  const plateAnchorProfiles = new Map<number, Map<number, TlcMolProfile[]>>();

  for (const set of tlcSets) {
    // Check each plate index stored inside `set` (0 top-level + >0 in set.plateData)
    const candidatePlateIndices = [0];
    if (set.plateData) {
      for (const k of Object.keys(set.plateData)) {
        const pi = Number(k);
        if (Number.isFinite(pi) && pi > 0 && pi < numPlates) candidatePlateIndices.push(pi);
      }
    }

    for (const pIdx of candidatePlateIndices) {
      const slice = getTlcPlateSlice(set, pIdx);
      const extracted = extractMeasuredWellSpotsForSet(slice, { getProfile, spotProminence });
      if (!extracted.hasValidCalibration || extracted.wells.size === 0) continue;

      const overrideKey = `${set.uid}:${pIdx}`;
      const manualId = setSolventOverrides[overrideKey] ?? setSolventOverrides[set.uid];
      if (manualId === 'ignore') continue;

      const matched = matchTlcSetNameToSolvent(set.name, manualId);
      if (!matched) {
        model.unmatchedSets.push({
          key: overrideKey,
          uid: set.uid,
          name: set.name,
          plateIndex: pIdx,
          laneCountWithSpots: extracted.laneCountWithSpots,
        });
        continue;
      }

      const plateRows = rowsByPlate.get(pIdx);
      if (!plateRows) continue;

      const isC18 = matched.system.stationaryPhase === 'C18';
      const platePairs: Array<{
        pair: Omit<TlcCalibrationSpotPair, 'predictedRfAfter'>;
        profile: TlcMolProfile;
      }> = [];
      const laneCompMap = new Map<number, CalibratedLaneComparison>();
      const laneProfilesMap = new Map<number, TlcMolProfile[]>();

      for (let wIdx = 0; wIdx < PLATE_SIZE; wIdx++) {
        const measuredWell = extracted.wells.get(wIdx);
        const r = plateRows.get(wIdx);
        const gIdx = r?.global_index ?? pIdx * PLATE_SIZE + wIdx;
        const isBlank =
          !r ||
          (state.mode === 'triplet' && Boolean(triMeta[gIdx]?.blank)) ||
          Boolean(r.recipe?.every((rc: any) => rc.target_concentration <= 0));

        if (isBlank) {
          laneCompMap.set(wIdx, {
            wellIndex: wIdx,
            wellCoord: wellLabel(wIdx),
            isBlank: true,
            measuredSpots: (measuredWell?.spots || []).map((sp) => ({
              rf: Math.round(sp.rf * 100) / 100,
              strength: sp.strength,
            })),
            predictedSpots: [],
          });
          continue;
        }

        const cacheKey = `${pIdx}-${wIdx}`;
        let pred = cachedPredictions[cacheKey] || newlyComputedPredictions[cacheKey];

        const ext = extractWellForPrediction(state, r, conditionOverrides);
        const validSubs = ext.substrates.filter((s) => s.smiles.trim().length > 0);
        if (validSubs.length === 0) {
          laneCompMap.set(wIdx, {
            wellIndex: wIdx,
            wellCoord: wellLabel(wIdx),
            isBlank: false,
            measuredSpots: (measuredWell?.spots || []).map((sp) => ({
              rf: Math.round(sp.rf * 100) / 100,
              strength: sp.strength,
            })),
            predictedSpots: [],
          });
          continue;
        }

        if (!pred && rdkit) {
          const sig =
            validSubs
              .map((s) => `${s.code}:${s.smiles.trim()}:${Math.round(s.equivalents * 100) / 100}`)
              .sort()
              .join('|') +
            `@${ext.condition.medium}:${ext.condition.additiveName}:${Math.round(ext.condition.additiveEquiv * 100) / 100}:${ext.condition.temperatureC}:${ext.condition.waterPct}`;
          if (reactionMemo.has(sig)) {
            pred = reactionMemo.get(sig);
          } else {
            try {
              pred = predictWellReactions(rdkit, validSubs, ext.condition, {
                includeSpeculative: false,
                maxDepth: 4,
                maxExpansions: 60,
              });
            } catch {
              pred = undefined;
            }
            reactionMemo.set(sig, pred);
          }
          if (pred) {
            newlyComputedPredictions[cacheKey] = pred;
          }
        }

        const wellCtx = buildWellTlcContext(ext, pred);

        const anchors: PredAnchor[] = [];
        const hasWhite = measuredWell?.hasWhiteChannel ?? extracted.hasWhiteChannel;
        const subsList =
          pred?.substrates ||
          validSubs.map((s) => ({
            code: s.code,
            name: s.name,
            neutralSmiles: s.smiles,
            valid: true,
          }));
        for (const s of subsList as any[]) {
          if (s.valid === false) continue;
          const smi = s.neutralSmiles || s.smiles || '';
          if (!smi) continue;
          const prof = profileMoleculeForTlc(rdkit, smi, profileCache);
          if (!hasWhite && !prof.uvActive) continue;
          const res = predictTlcRf(prof, matched.system, wellCtx, matched.stationaryPhase, 0);
          anchors.push({
            label: s.name || s.code || 'SM',
            kind: 'substrate',
            rf: res.rf,
            weight: 1.0,
            profile: prof,
          });
        }

        const seenProd = new Set<string>();
        for (const sp of pred?.species || []) {
          if (sp.tier !== 'High' && sp.tier !== 'Medium') continue;
          const k = sp.tautomerKey || sp.key;
          if (seenProd.has(k)) continue;
          seenProd.add(k);
          const prof = profileMoleculeForTlc(rdkit, sp.smiles, profileCache);
          if (!hasWhite && !prof.uvActive) continue;
          const res = predictTlcRf(prof, matched.system, wellCtx, matched.stationaryPhase, 0);
          anchors.push({
            label: sp.mechanismSummary || sp.formula || 'Product',
            kind: 'product',
            tier: sp.tier,
            rf: res.rf,
            weight: sp.tier === 'High' ? 1.0 : 0.85,
            profile: prof,
          });
          if (seenProd.size >= 4) break;
        }
        laneProfilesMap.set(wIdx, anchors.map((a) => a.profile));

        const obsSpots = measuredWell?.spots || [];
        const matchedPairs = pairMeasuredAndPredictedSpots(obsSpots, anchors);
        const pairedByObs = new Map<TlcSpot, PredAnchor>();
        const pairedByPred = new Map<PredAnchor, TlcSpot>();
        const isFrontPegged = (rf: number) => rf >= 0.92;
        const isBasePegged = (rf: number) => rf <= 0.05;

        for (const { obs, pred: pAnchor } of matchedPairs) {
          pairedByObs.set(obs, pAnchor);
          pairedByPred.set(pAnchor, obs);

          // Interior quantitative pairs enter least-squares residual minimization;
          // boundary-pegged peaks (>=0.92 or <=0.05) enter as one-sided censored bounds below.
          if (isFrontPegged(obs.rf) || isBasePegged(obs.rf)) continue;

          const dispN = pAnchor.profile.lser?.displacementN ?? 1.0;
          const kEff = (isC18 ? 4.8 * (0.6 + 0.4 * dispN) : 6.2 * dispN);
          const resRf = obs.rf - pAnchor.rf;
          const rawResDem = clamp(-(logitRf(obs.rf) - logitRf(pAnchor.rf)) / kEff, -0.32, 0.32);
          const huberW = Math.abs(rawResDem) <= 0.14 ? 1.0 : 0.14 / Math.abs(rawResDem);
          platePairs.push({
            profile: pAnchor.profile,
            pair: {
              wellIndex: wIdx,
              wellCoord: wellLabel(wIdx),
              speciesLabel: pAnchor.label,
              speciesKind: pAnchor.kind,
              observedRf: Math.round(obs.rf * 100) / 100,
              predictedRfBefore: pAnchor.rf,
              residualRf: Math.round(resRf * 1000) / 1000,
              residualDemand: Math.round(rawResDem * 10000) / 10000,
              weight: Math.round(pAnchor.weight * huberW * 1000) / 1000,
            },
          });
        }

        const frontBoundarySpot = obsSpots.find((sp) => isFrontPegged(sp.rf));
        const originBoundarySpot = obsSpots.find((sp) => isBasePegged(sp.rf));
        const hasFrontEvidence = Boolean(measuredWell?.frontOccupied || frontBoundarySpot);
        const hasOriginEvidence = Boolean(measuredWell?.originOccupied || originBoundarySpot);

        // Build per-lane Found vs Boundary-Saturated vs Missing vs Extra comparison
        const compMeasured = obsSpots.map((sp) => {
          const pMatch = pairedByObs.get(sp);
          return {
            rf: Math.round(sp.rf * 100) / 100,
            strength: sp.strength,
            ...(pMatch
              ? {
                  matchedLabel: pMatch.label,
                  matchedKind: pMatch.kind,
                  matchedPredRfBefore: pMatch.rf,
                  matchedPredRfAfter: pMatch.rf,
                }
              : {}),
          };
        });

        let laneFrontCensored = 0;
        let laneBaseCensored = 0;
        const laneCensoredRecords: Array<Omit<CensoredBoundaryRecord, 'plateSummaryIdx'>> = [];

        const compPredicted = anchors.map((anc) => {
          let obsMatch = pairedByPred.get(anc);
          if (!obsMatch) {
            // If a near-coeluting representative replaced `anc` during dedup, still mark it found
            for (const [pUsed, obsUsed] of pairedByPred.entries()) {
              if (Math.abs(pUsed.rf - anc.rf) < 0.04) {
                obsMatch = obsUsed;
                break;
              }
            }
          }
          let boundaryStatus: 'found' | 'front_saturated' | 'baseline_pinned' | 'missing' = 'missing';
          let boundaryObsRf: number | undefined;
          if (obsMatch && !isFrontPegged(obsMatch.rf) && !isBasePegged(obsMatch.rf)) {
            boundaryStatus = 'found';
          } else if (
            (obsMatch && isFrontPegged(obsMatch.rf)) ||
            (!obsMatch && hasFrontEvidence && anc.rf >= 0.72)
          ) {
            boundaryStatus = 'front_saturated';
            const usedObs = obsMatch && isFrontPegged(obsMatch.rf) ? obsMatch : frontBoundarySpot;
            boundaryObsRf = usedObs ? Math.round(usedObs.rf * 100) / 100 : undefined;
            laneFrontCensored++;
            laneCensoredRecords.push({
              family: matched.system.family,
              isC18,
              kind: 'front',
              predictedRfBefore: anc.rf,
              boundRf: usedObs ? Math.min(0.95, Math.max(0.92, usedObs.rf)) : 0.94,
              weight: anc.weight * 0.75,
            });
          } else if (
            (obsMatch && isBasePegged(obsMatch.rf)) ||
            (!obsMatch && hasOriginEvidence && anc.rf <= 0.28)
          ) {
            boundaryStatus = 'baseline_pinned';
            const usedObs = obsMatch && isBasePegged(obsMatch.rf) ? obsMatch : originBoundarySpot;
            boundaryObsRf = usedObs ? Math.round(usedObs.rf * 100) / 100 : undefined;
            laneBaseCensored++;
            laneCensoredRecords.push({
              family: matched.system.family,
              isC18,
              kind: 'baseline',
              predictedRfBefore: anc.rf,
              boundRf: usedObs ? Math.max(0.02, Math.min(0.06, usedObs.rf)) : 0.05,
              weight: anc.weight * 0.75,
            });
          }
          return {
            label: anc.label,
            kind: anc.kind,
            tier: anc.tier,
            rfBefore: anc.rf,
            rfAfter: anc.rf,
            found: Boolean(obsMatch || boundaryObsRf !== undefined),
            boundaryStatus,
            ...(obsMatch
              ? { matchedObsRf: Math.round(obsMatch.rf * 100) / 100 }
              : boundaryObsRf !== undefined
              ? { matchedObsRf: boundaryObsRf }
              : {}),
          };
        });

        laneCompMap.set(wIdx, {
          wellIndex: wIdx,
          wellCoord: wellLabel(wIdx),
          isBlank: false,
          frontOccupied: hasFrontEvidence,
          originOccupied: hasOriginEvidence,
          frontExcess: measuredWell?.frontExcess ?? 0,
          originExcess: measuredWell?.originExcess ?? 0,
          measuredSpots: compMeasured,
          predictedSpots: compPredicted,
        });

        // Attach censored boundary records for this well to phase pool
        if (laneCensoredRecords.length > 0) {
          let cArr = censoredByPhase.get(matched.stationaryPhase);
          if (!cArr) {
            cArr = [];
            censoredByPhase.set(matched.stationaryPhase, cArr);
          }
          const targetIdx = model.plates.length;
          for (const cr of laneCensoredRecords) {
            cArr.push({ ...cr, plateSummaryIdx: targetIdx });
          }
        }
        void laneFrontCensored;
        void laneBaseCensored;
      }

      const lanesOut = Array.from({ length: PLATE_SIZE }, (_, w) => laneCompMap.get(w)!);

      let plateFrontCensCount = 0;
      let plateBaseCensCount = 0;
      for (const l of lanesOut) {
        if (l.isBlank) continue;
        for (const p of l.predictedSpots) {
          if (p.boundaryStatus === 'front_saturated') plateFrontCensCount++;
          else if (p.boundaryStatus === 'baseline_pinned') plateBaseCensCount++;
        }
      }

      const plateSummaryIdx = model.plates.length;
      plateAnchorProfiles.set(plateSummaryIdx, laneProfilesMap);
      model.plates.push({
        setUid: set.uid,
        setName: set.name,
        plateIndex: pIdx,
        matchedSystemId: matched.system.id,
        matchedSystemName: matched.system.name,
        stationaryPhase: matched.stationaryPhase,
        family: matched.system.family,
        matchSource: matched.matchSource,
        laneCountWithSpots: extracted.laneCountWithSpots,
        pairedCount: platePairs.length,
        frontCensoredCount: plateFrontCensCount,
        baselineCensoredCount: plateBaseCensCount,
        meanRfResidual: 0,
        rmseBefore: 0,
        rmseAfter: 0,
        midplateRfShift: 0,
        demandShift: 0,
        pairs: [],
        lanes: lanesOut,
      });

      if (platePairs.length > 0) {
        let arr = pairsByPhase.get(matched.stationaryPhase);
        if (!arr) {
          arr = [];
          pairsByPhase.set(matched.stationaryPhase, arr);
        }
        for (const item of platePairs) {
          arr.push({
            plateSummaryIdx,
            family: matched.system.family,
            isC18,
            profile: item.profile,
            features: computeCalibrationFeatureVector(item.profile),
            displacementN: item.profile.lser?.displacementN ?? 1.0,
            pair: item.pair,
          });
        }
      }
    }
  }

  // Fit shrinkage-regularized offsets & optional logit polarity slope per stationary phase
  // incorporating both interior spot pairs AND left/right censored boundary hits (front/baseline saturation)
  const GLOBAL_LAMBDA = 6.0;
  const SLOPE_LAMBDA = 22.0;
  const FAMILY_LAMBDA = 10.0;
  const SIGMA_PRIOR_N = 8.0;

  const allPhases = new Set<TlcStationaryPhasePreference>([
    ...pairsByPhase.keys(),
    ...censoredByPhase.keys(),
  ]);

  for (const phase of allPhases) {
    const records = pairsByPhase.get(phase) || [];
    const censRecords = censoredByPhase.get(phase) || [];
    if (records.length === 0 && censRecords.length === 0) continue;
    const isC18 = phase === 'C18';
    const kPhase = isC18 ? 4.8 : 6.2;

    const evalPhaseObjective = (shift: number, slope: number): number => {
      let loss = GLOBAL_LAMBDA * shift * shift + SLOPE_LAMBDA * (slope - 1) * (slope - 1);
      for (const rec of records) {
        const dispScale = isC18 ? 0.6 + 0.4 * rec.displacementN : rec.displacementN;
        const kEff = kPhase * dispScale;
        const zB = logitRf(rec.pair.predictedRfBefore);
        const zObs = logitRf(rec.pair.observedRf);
        const zAfter = slope * (zB - kEff * shift);
        const residD = (zAfter - zObs) / kEff;
        loss += rec.pair.weight * residD * residD;
      }
      for (const cr of censRecords) {
        const zB = logitRf(cr.predictedRfBefore);
        const zBound = logitRf(cr.boundRf);
        const zAfter = slope * (zB - kPhase * shift);
        if (cr.kind === 'front' && zAfter < zBound) {
          const gapD = (zBound - zAfter) / kPhase;
          loss += cr.weight * gapD * gapD;
        } else if (cr.kind === 'baseline' && zAfter > zBound) {
          const gapD = (zAfter - zBound) / kPhase;
          loss += cr.weight * gapD * gapD;
        }
      }
      return loss;
    };

    // Fast 2D coordinate refinement (shift in [-0.22, +0.22], slope in [0.82, 1.25])
    let globalDemandShift = 0;
    let demandSlope = 1.0;
    if (records.length > 0) {
      let wS = 0;
      let wrS = 0;
      for (const rec of records) {
        wS += rec.pair.weight;
        wrS += rec.pair.weight * rec.pair.residualDemand;
      }
      globalDemandShift = clamp(wrS / (wS + GLOBAL_LAMBDA), -0.22, 0.22);
    }
    const allowSlopeFit = records.length >= 6 || (records.length >= 2 && censRecords.length >= 2);
    const steps = [0.04, 0.015, 0.005, 0.0015];
    for (const h of steps) {
      let improved = true;
      let iter = 0;
      while (improved && iter < 15) {
        improved = false;
        iter++;
        const curObj = evalPhaseObjective(globalDemandShift, demandSlope);
        for (const ds of [-h, h]) {
          const ns = clamp(globalDemandShift + ds, -0.22, 0.22);
          if (evalPhaseObjective(ns, demandSlope) + 1e-12 < curObj) {
            globalDemandShift = ns;
            improved = true;
          }
        }
        if (allowSlopeFit) {
          const curObj2 = evalPhaseObjective(globalDemandShift, demandSlope);
          for (const dsl of [-h * 1.2, h * 1.2]) {
            const nsl = clamp(demandSlope + dsl, 0.82, 1.25);
            if (evalPhaseObjective(globalDemandShift, nsl) + 1e-12 < curObj2) {
              demandSlope = nsl;
              improved = true;
            }
          }
        }
      }
    }
    globalDemandShift = Math.round(globalDemandShift * 10000) / 10000;
    demandSlope = Math.round(demandSlope * 1000) / 1000;

    // Optional solvent-family residual shifts (only when a family has meaningful evidence)
    const familySums = new Map<SolventFamily, { w: number; wr: number }>();
    for (const rec of records) {
      const cur = familySums.get(rec.family) || { w: 0, wr: 0 };
      const residAfterGlobal = rec.pair.residualDemand - globalDemandShift;
      cur.w += rec.pair.weight;
      cur.wr += rec.pair.weight * residAfterGlobal;
      familySums.set(rec.family, cur);
    }

    const familyDemandShifts: Partial<Record<SolventFamily, number>> = {};
    for (const [fam, stats] of familySums.entries()) {
      if (stats.w >= 4.5) {
        const famShift = clamp(stats.wr / (stats.w + FAMILY_LAMBDA), -0.12, 0.12);
        if (Math.abs(famShift) >= 0.005) {
          familyDemandShifts[fam] = Math.round(famShift * 10000) / 10000;
        }
      }
    }

    // Multivariate 5D L2-regularized Ridge regression on post-shift/slope descriptor residuals
    // Only activates when >= 10 paired spots exist and keeps uniform shifts strictly untouched.
    let featureWeights: TlcCalibrationFeatureWeights | undefined;
    if (records.length >= 10) {
      const RIDGE_LAMBDA = 24.0;
      const featMeans = [0, 0, 0, 0, 0];
      let wTot = 0;
      for (const rec of records) {
        wTot += rec.pair.weight;
        for (let j = 0; j < 5; j++) featMeans[j] += rec.pair.weight * rec.features[j];
      }
      if (wTot > 0) {
        for (let j = 0; j < 5; j++) featMeans[j] /= wTot;

        const A: number[][] = Array.from({ length: 5 }, (_, r) =>
          Array.from({ length: 5 }, (__, c) => (r === c ? RIDGE_LAMBDA : 0))
        );
        const b: number[] = [0, 0, 0, 0, 0];

        for (const rec of records) {
          const dispScale = isC18 ? 0.6 + 0.4 * rec.displacementN : rec.displacementN;
          const kEff = kPhase * dispScale;
          const famShift = familyDemandShifts[rec.family] ?? 0;
          const zB = logitRf(rec.pair.predictedRfBefore);
          const zObs = logitRf(rec.pair.observedRf);
          const postResid = clamp((zB - zObs / demandSlope) / kEff - (globalDemandShift + famShift), -0.25, 0.25);
          const xc = rec.features.map((f, j) => f - featMeans[j]);
          for (let r = 0; r < 5; r++) {
            b[r] += rec.pair.weight * xc[r] * postResid;
            for (let c = 0; c < 5; c++) {
              A[r][c] += rec.pair.weight * xc[r] * xc[c];
            }
          }
        }

        const rawW = solveSmallLinearSystem(A, b);
        if (rawW) {
          const clampedW = rawW.map((v) => {
            const c = clamp(v, -0.08, 0.08);
            return Math.abs(c) < 0.005 ? 0 : Math.round(c * 10000) / 10000;
          });
          if (clampedW.some((v) => Math.abs(v) >= 0.005)) {
            featureWeights = {
              tpsa: clampedW[0],
              hbd: clampedW[1],
              aromaticRings: clampedW[2],
              basicN: clampedW[3],
              clogP: clampedW[4],
            };
            // Preserve exact training-centroid mean by folding centroid feature offset into globalDemandShift
            let meanDot = 0;
            for (let j = 0; j < 5; j++) meanDot += clampedW[j] * featMeans[j];
            globalDemandShift = Math.round(clamp(globalDemandShift - meanDot, -0.22, 0.22) * 10000) / 10000;
          }
        }
      }
    }

    // Re-evaluate all pairs after calibration to fill parity points & RMSE
    let wSum = 0;
    let sqErrBefore = 0;
    let sqErrAfter = 0;
    let rfBiasSum = 0;
    const uniqueLanes = new Set<string>();
    const plateAccum = new Map<
      number,
      { sqBefore: number; sqAfter: number; rfSum: number; wSum: number; wrSum: number }
    >();

    for (const rec of records) {
      const famShift = familyDemandShifts[rec.family] ?? 0;
      const totalShift = globalDemandShift + famShift;
      const featDelta = computeFeatureDemandDelta(rec.profile, featureWeights);
      const predAfter = applyCalibrationShiftToRf(
        rec.pair.predictedRfBefore,
        totalShift,
        isC18,
        demandSlope,
        featDelta,
        rec.displacementN
      );
      const errBefore = rec.pair.observedRf - rec.pair.predictedRfBefore;
      const errAfter = rec.pair.observedRf - predAfter;

      wSum += rec.pair.weight;
      sqErrBefore += errBefore * errBefore;
      sqErrAfter += errAfter * errAfter;
      rfBiasSum += errBefore;
      uniqueLanes.add(`${rec.plateSummaryIdx}:${rec.pair.wellIndex}`);

      const fullPair: TlcCalibrationSpotPair = {
        ...rec.pair,
        predictedRfAfter: predAfter,
      };
      model.plates[rec.plateSummaryIdx].pairs.push(fullPair);

      const pa = plateAccum.get(rec.plateSummaryIdx) || {
        sqBefore: 0,
        sqAfter: 0,
        rfSum: 0,
        wSum: 0,
        wrSum: 0,
      };
      pa.sqBefore += errBefore * errBefore;
      pa.sqAfter += errAfter * errAfter;
      pa.rfSum += errBefore;
      pa.wSum += rec.pair.weight;
      pa.wrSum += rec.pair.weight * rec.pair.residualDemand;
      plateAccum.set(rec.plateSummaryIdx, pa);
    }

    const n = records.length;
    const rmseBefore = n > 0 ? Math.round(Math.sqrt(sqErrBefore / n) * 1000) / 1000 : 0.12;
    const rmseAfter = n > 0 ? Math.round(Math.sqrt(sqErrAfter / n) * 1000) / 1000 : 0.12;
    const calibratedSigma = Math.round(
      clamp((SIGMA_PRIOR_N * RF_SIGMA + wSum * rmseAfter) / (SIGMA_PRIOR_N + wSum), 0.065, 0.17) * 1000
    ) / 1000;

    // Update EVERY plate in this phase (including plates that only contributed censored front/baseline constraints)
    for (let pIdxSummary = 0; pIdxSummary < model.plates.length; pIdxSummary++) {
      const pEntry = model.plates[pIdxSummary];
      if (pEntry.stationaryPhase !== phase) continue;
      const pa = plateAccum.get(pIdxSummary);
      const pn = pEntry.pairs.length || 1;
      pEntry.meanRfResidual = pa ? Math.round((pa.rfSum / pn) * 1000) / 1000 : 0;
      pEntry.rmseBefore = pa ? Math.round(Math.sqrt(pa.sqBefore / pn) * 1000) / 1000 : 0;
      pEntry.rmseAfter = pa ? Math.round(Math.sqrt(pa.sqAfter / pn) * 1000) / 1000 : 0;
      pEntry.demandShift = Math.round((globalDemandShift + (familyDemandShifts[pEntry.family] ?? 0)) * 10000) / 10000;
      pEntry.midplateRfShift = rfShiftAtMidplate(pEntry.demandShift, isC18);

      const profilesByWell = plateAnchorProfiles.get(pIdxSummary);
      const pairByWell = new Map<string, TlcCalibrationSpotPair>();
      for (const fp of pEntry.pairs) {
        pairByWell.set(`${fp.wellIndex}:${fp.speciesLabel}`, fp);
      }

      // Update per-lane calibrated Rf projections so the Found vs Missing plate visual shows both raw and calibrated predicted Rf
      for (const lane of pEntry.lanes) {
        const anchorProfs = profilesByWell?.get(lane.wellIndex) || [];
        for (const mSp of lane.measuredSpots) {
          if (mSp.matchedPredRfBefore !== undefined) {
            const matchedPair = mSp.matchedLabel
              ? pairByWell.get(`${lane.wellIndex}:${mSp.matchedLabel}`)
              : undefined;
            mSp.matchedPredRfAfter =
              matchedPair?.predictedRfAfter ??
              applyCalibrationShiftToRf(mSp.matchedPredRfBefore, pEntry.demandShift, isC18, demandSlope);
          }
        }
        lane.predictedSpots.forEach((pSp, pIdxSpot) => {
          const prof = anchorProfs[pIdxSpot];
          const featDelta = prof ? computeFeatureDemandDelta(prof, featureWeights) : 0;
          const dispN = prof?.lser?.displacementN ?? 1.0;
          pSp.rfAfter = applyCalibrationShiftToRf(
            pSp.rfBefore,
            pEntry.demandShift,
            isC18,
            demandSlope,
            featDelta,
            dispN
          );
        });
      }
    }

    const frontCensoredCount = censRecords.filter((c) => c.kind === 'front').length;
    const baselineCensoredCount = censRecords.filter((c) => c.kind === 'baseline').length;

    const fit: TlcCalibrationPhaseFit = {
      globalDemandShift,
      demandSlope,
      familyDemandShifts,
      ...(featureWeights ? { featureWeights } : {}),
      midplateRfShift: rfShiftAtMidplate(globalDemandShift, isC18),
      calibratedSigma,
      pairedSpotCount: n,
      matchedLaneCount: uniqueLanes.size,
      frontCensoredCount,
      baselineCensoredCount,
      meanRfBias: n > 0 ? Math.round((rfBiasSum / n) * 1000) / 1000 : 0,
      rmseBefore,
      rmseAfter,
    };
    model.byPhase[phase] = fit;
  }

  return { model, newlyComputedPredictions };
}
