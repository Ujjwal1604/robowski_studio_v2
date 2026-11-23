// Robowski Studio - Empirical TLC Self-Calibration from Campaign Plate Measurements
import { RunResult, RunState, TlcLane, TlcSet, TlcSpot } from '../../types';
import {
  analyzeLaneBoundaryOccupancy,
  containerOfLane,
  findSpots,
  getChannelHistogram,
  getChannelFrontBandProfile,
  getLane2dMetrics,
  tlcHalf,
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
  CalibratedCompoundSummary,
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
  TlcCalibrationFamilyStats,
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
  hasSameEluentComposition,
  parseStructuredSolventName,
} from './solventSystemModel';
import { PredictedSpecies, WellPredictionResult } from './types';

// Predicted products may not have formed (or may be mis-paired), so they anchor the fit far less than
// starting materials, whose identity is known.
const PRODUCT_ANCHOR_WEIGHT = 0.3;
// Never report a calibrated sigma tighter than this: it comes from a few compounds on a few plates.
const SIGMA_FLOOR = 0.09;

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

export interface MeasuredTlcSpot extends TlcSpot {
  /** Measured vertical spot extent normalized by origin-to-front span (Rf units). */
  rfSpan?: number;
}

export interface MeasuredWellSpots {
  wellIndex: number;
  laneId: number;
  spots: MeasuredTlcSpot[];
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

  const knownSystems = [...TLC_SOLVENT_LIBRARY, ...DYNAMIC_SOLVENT_SYSTEMS];

  // 1. Exact or normalized match on canonical or dynamic composed name / shortLabel
  for (const sys of knownSystems) {
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

  // 1b. Exact structured parser for advisor-synthesized eluents (Langmuir-tailored binary/ternary,
  //     PRISMA ternaries with modifiers, and 2M NH3-in-MeOH systems like "Toluene / MeOH / (2M NH₃ in MeOH) (94:4:2)")
  const parsedSpec = parseStructuredSolventName(name);
  if (parsedSpec) {
    const exactKnown = knownSystems.find((sys) => hasSameEluentComposition(sys, parsedSpec));
    const resolvedSys = exactKnown || composeSolventSystem(parsedSpec);
    const resolvedPhase: TlcStationaryPhasePreference =
      resolvedSys.stationaryPhase === 'C18'
        ? 'C18'
        : parsedPhase === 'Al2O3_neutral' || parsedPhase === 'Al2O3_basic'
        ? parsedPhase
        : 'SiO2';
    if (
      (resolvedPhase === 'Al2O3_neutral' || resolvedPhase === 'Al2O3_basic') &&
      (resolvedSys.acidModifier || resolvedSys.baseModifier)
    ) {
      return null;
    }
    return {
      system: resolvedSys,
      stationaryPhase: resolvedPhase,
      matchSource: 'auto',
    };
  }

  // 2. Heuristic parser for common shorthand solvent names
  const hasEt3N = /et3n|net3|\btea\b/.test(rawNorm);
  const hasNh3 = /nh3|nh4oh/.test(rawNorm);
  const hasAcOH = /acoh|hoac|acetic/.test(rawNorm);
  const hasTfa = /tfa/.test(rawNorm);

  // Extract percentage or ratio A:B (or ternary A:B:C)
  let pct: number | null = null;
  const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(rawNorm);
  const ratio3Match = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(rawNorm);
  const ratioMatch = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(rawNorm);
  const isNeatHexanes = /^(?:100%\s*|neat\s*)?(?:hex|hexanes?|hept|heptane)\s*$/.test(rawNorm);
  const isNeatEtOAc = /(?:^|\b)(?:100%\s*|neat\s*)?(?:etoac|ea|ethyl acetate)\s*$/.test(rawNorm);
  const isNeatDcm = /(?:^|\b)(?:100%\s*|neat\s*)?(?:dcm|ch2cl2)\s*$/.test(rawNorm);

  if (pctMatch) {
    pct = parseFloat(pctMatch[1]);
  } else if (ratio3Match) {
    const a = parseFloat(ratio3Match[1]);
    const b = parseFloat(ratio3Match[2]);
    const c = parseFloat(ratio3Match[3]);
    const sum = a + b + c;
    if (sum > 0) {
      const weakFirst = /^(?:\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:v\/v\/v\s*)?)?(?:hex|hexanes?|pentane|dcm|ch2cl2|tol|toluene)\b/.test(rawNorm);
      if (weakFirst) {
        pct = ((hasNh3 ? b + c : b) / sum) * 100;
      } else {
        pct = ((hasNh3 ? a + c : a) / sum) * 100;
      }
    }
  } else if (ratioMatch) {
    const a = parseFloat(ratioMatch[1]);
    const b = parseFloat(ratioMatch[2]);
    if (a + b > 0) {
      // Handle inverted weak:strong order such as "2:1 Hex/EtOAc", "95:5 DCM/MeOH", "95:5 Toluene/MeOH"
      const hexFirst = /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:hex|hexanes|pentane)\s*[/:]\s*(?:etoac|ea|acetone|et2o|mtbe)/.test(rawNorm);
      const dcmFirst = /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:dcm|ch2cl2)\s*[/:]\s*(?:meoh|nh3|etoac|ea)/.test(rawNorm);
      const tolFirst = /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\s*(?:tol|toluene)\s*[/:]\s*(?:meoh|nh3|etoac|ea)/.test(rawNorm);
      pct = (hexFirst || dcmFirst || tolFirst ? (b / (a + b)) : (a / (a + b))) * 100;
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
  const isMeohDcm = /(meoh|methanol).*(dcm|ch2cl2)|(dcm|ch2cl2).*(meoh|methanol|nh3)/.test(rawNorm);
  const isAcetoneHex = /acetone.*hex|hex.*acetone/.test(rawNorm);
  const isMeohTol = /(meoh|methanol|nh3).*(tol|toluene)|(tol|toluene).*(meoh|methanol|nh3)/.test(rawNorm);
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
    const p = clamp(pct ?? 6, 0, 18);
    if (hasNh3) {
      const modId = /4%\s*\(?2m\s*nh3|4%\s*nh3/.test(rawNorm) ? 'nh3_meoh_4' : 'nh3_meoh_2';
      const modVol = modId === 'nh3_meoh_4' ? 4 : 2;
      const neatMeoh = Math.max(0, Math.round(p - modVol));
      candidate = composeSolventSystem({
        id: `synth_meoh_tol_${neatMeoh}_${modId}`,
        strongSolvent: 'MeOH',
        weakSolvent: 'Toluene',
        strongPct: neatMeoh,
        modifierId: modId,
        stationaryPhase: 'SiO2',
        family: 'meoh_toluene',
        preferenceTier: 'secondary',
        isSynthesized: true,
      });
    } else {
      const tolPool = hasEt3N
        ? DYNAMIC_SOLVENT_SYSTEMS.filter((s) => s.family === 'meoh_toluene' && Boolean(s.baseModifier?.includes('Et₃N')))
        : TLC_SOLVENT_LIBRARY.filter((s) => s.family === 'meoh_toluene');
      candidate = pickClosest(tolPool, 0.23 + p * 0.012);
    }
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
  const laneResults = new Map<number, { spots: MeasuredTlcSpot[] }>();

  for (const lane of lanes) {
    try {
      const hasCustom = Array.isArray(lane.customSpots);
      let mergedSpots: MeasuredTlcSpot[] = [];

      if (hasCustom) {
        mergedSpots = lane.customSpots!.map((sp) => ({ ...sp }));
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
            lane2d: getLane2dMetrics(setSlice, ch, lane),
            frontBandBg: getChannelFrontBandProfile(setSlice, ch, tlcHalf(lane), getProf),
            detectorMode: setSlice.spotDetectorMode,
          });
          for (const sp of chSpots) {
            const rfSpan =
              sp.extentStart !== undefined && sp.extentEnd !== undefined && span > 0
                ? Math.round(clamp((sp.extentEnd - sp.extentStart) / span, 0.01, 0.95) * 1000) / 1000
                : undefined;
            const enriched: MeasuredTlcSpot = {
              ...sp,
              ...(rfSpan !== undefined ? { rfSpan } : {}),
            };
            const match = mergedSpots.find((m) => Math.abs(m.rf - sp.rf) < 0.04);
            if (!match) {
              mergedSpots.push(enriched);
            } else {
              if (sp.strength > match.strength) {
                match.strength = sp.strength;
                match.pos = sp.pos;
                if (sp.widthFrac !== undefined) match.widthFrac = sp.widthFrac;
                if (sp.tailing !== undefined) match.tailing = sp.tailing;
                if (rfSpan !== undefined) match.rfSpan = rfSpan;
              } else if (sp.strength >= match.strength * 0.55) {
                if (sp.tailing !== undefined && (match.tailing === undefined || sp.tailing > match.tailing)) {
                  match.tailing = sp.tailing;
                }
                if (rfSpan !== undefined && (match.rfSpan === undefined || rfSpan > match.rfSpan)) {
                  match.rfSpan = rfSpan;
                }
                if (sp.widthFrac !== undefined && match.widthFrac === undefined) {
                  match.widthFrac = sp.widthFrac;
                }
              }
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

/**
 * Plate-level distribution check, independent of spot pairing. Pairing can miss a drastic eluent
 * error (a predicted Rf 0.95–0.99 never pairs with a measured 0.65, so the pair never enters the fit).
 * Comparing the median logit-Rf of measured interior spots with that of the predicted starting materials
 * on the same plate exposes it. Returns a demand shift (positive = runs lower than predicted), or null
 * when there is too little evidence to say anything.
 */
export function estimatePlateLevelDemandShift(
  observedRf: number[],
  predictedRf: number[],
  kPhase: number
): { shift: number; n: number } | null {
  const obs = observedRf.filter((r) => Number.isFinite(r) && r > 0.05 && r < 0.92);
  // Exclude baseline-pinned predictions (<= 0.05) symmetrically with obs (> 0.05) so polar
  // origin-pinned SMs cannot collapse medianLogit(pred) and fabricate a huge upward Rf shift;
  // keep predictions up to 0.99 so front-clamped over-predictions are still detected.
  const pred = predictedRf.filter((r) => Number.isFinite(r) && r > 0.05 && r <= 0.99);
  if (obs.length < 8 || pred.length < 8) return null;
  const medianLogit = (a: number[]) => {
    const b = a.map((r) => logitRf(r)).sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const raw = (medianLogit(pred) - medianLogit(obs)) / kPhase;
  const n = Math.min(obs.length, pred.length);
  const shrunk = (raw * n) / (n + 10);
  return { shift: Math.max(-0.45, Math.min(0.45, shrunk)), n };
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

interface PlateWellCollection {
  wIdx: number;
  measuredWell: MeasuredWellSpots | undefined;
  anchors: PredAnchor[];
  obsSpots: MeasuredTlcSpot[];
}

export interface CrossWellConsensusLock {
  compoundKey: string;
  observedRfMean: number;
  observedRfSpread: number;
  matchedWells: number;
  totalWells: number;
  precision: number;
  youdenJ: number;
  channels?: TlcChannelKey[];
}

/**
 * Stage 1 plate-wide cross-well compound consensus matching.
 * Uses presence/absence across all 54 wells (plus spot Rf consistency & channel signature) to
 * identify shared compounds even when raw predicted Rf is off by 0.25–0.45 Rf (beyond the
 * per-well ±0.24 Rf gate).
 */
function inferCrossWellConsensusLocks(
  wells: PlateWellCollection[]
): Map<string, CrossWellConsensusLock> {
  const locks = new Map<string, CrossWellConsensusLock>();
  const isInterior = (rf: number) => rf > 0.05 && rf < 0.92;

  const activeWells = wells.filter((w) => w.obsSpots.some((sp) => isInterior(sp.rf)));
  if (activeWells.length < 4) return locks;

  // 1. Collect per-compound presence across active wells
  interface CompoundInfo {
    key: string;
    kind: 'substrate' | 'product';
    wellIndices: Set<number>;
    predRfSum: number;
    predRfCount: number;
    aromaticRings: number;
  }
  const compMap = new Map<string, CompoundInfo>();
  for (const w of activeWells) {
    const seenInWell = new Map<string, PredAnchor>();
    for (const a of w.anchors) {
      const ck = a.profile.canonicalSmiles || a.profile.smiles;
      if (!ck) continue;
      const prev = seenInWell.get(ck);
      if (!prev || (a.kind === 'substrate' && prev.kind !== 'substrate')) {
        seenInWell.set(ck, a);
      }
    }
    for (const [ck, a] of seenInWell.entries()) {
      let info = compMap.get(ck);
      if (!info) {
        info = {
          key: ck,
          kind: a.kind,
          wellIndices: new Set(),
          predRfSum: 0,
          predRfCount: 0,
          aromaticRings: a.profile.aromaticRings || 0,
        };
        compMap.set(ck, info);
      }
      if (a.kind === 'substrate') info.kind = 'substrate';
      info.wellIndices.add(w.wIdx);
      info.predRfSum += a.rf;
      info.predRfCount++;
      if ((a.profile.aromaticRings || 0) > info.aromaticRings) {
        info.aromaticRings = a.profile.aromaticRings || 0;
      }
    }
  }

  const candidateComps = Array.from(compMap.values()).filter((c) => c.wellIndices.size >= 3);
  if (candidateComps.length === 0) return locks;

  // 2. Discover candidate plate-wide Rf bands from all interior measured spots
  const allObs: Array<{ wIdx: number; spot: TlcSpot }> = [];
  for (const w of activeWells) {
    for (const sp of w.obsSpots) {
      if (isInterior(sp.rf)) allObs.push({ wIdx: w.wIdx, spot: sp });
    }
  }
  allObs.sort((a, b) => a.spot.rf - b.spot.rf);

  // 0.052 radius accommodates slight top-vs-bottom bowing across 54 lanes on a 20 cm HTE plate
  const BAND_RADIUS = 0.052;
  interface RfBand {
    id: number;
    centerRf: number;
    wellSpots: Map<number, TlcSpot>;
  }
  const rawCenters: number[] = [];
  for (let i = 0; i < allObs.length; i++) {
    const rf = allObs[i].spot.rf;
    let cnt = 0;
    const wSeen = new Set<number>();
    for (let j = i; j >= 0 && rf - allObs[j].spot.rf <= BAND_RADIUS; j--) {
      if (!wSeen.has(allObs[j].wIdx)) {
        wSeen.add(allObs[j].wIdx);
        cnt++;
      }
    }
    for (let j = i + 1; j < allObs.length && allObs[j].spot.rf - rf <= BAND_RADIUS; j++) {
      if (!wSeen.has(allObs[j].wIdx)) {
        wSeen.add(allObs[j].wIdx);
        cnt++;
      }
    }
    if (cnt >= 3) rawCenters.push(rf);
  }

  // Merge nearby candidate centers into distinct horizontal Rf bands
  const bands: RfBand[] = [];
  let cIdx = 0;
  while (cIdx < rawCenters.length) {
    let end = cIdx;
    while (end + 1 < rawCenters.length && rawCenters[end + 1] - rawCenters[cIdx] <= 0.044) {
      end++;
    }
    const seedRf = rawCenters[Math.floor((cIdx + end) / 2)];
    const wellSpots = new Map<number, TlcSpot>();
    for (const { wIdx, spot } of allObs) {
      if (Math.abs(spot.rf - seedRf) <= BAND_RADIUS) {
        const cur = wellSpots.get(wIdx);
        if (!cur || Math.abs(spot.rf - seedRf) < Math.abs(cur.rf - seedRf)) {
          wellSpots.set(wIdx, spot);
        }
      }
    }
    if (wellSpots.size >= 3) {
      const rfs = Array.from(wellSpots.values())
        .map((s) => s.rf)
        .sort((a, b) => a - b);
      const medRf = rfs[Math.floor(rfs.length / 2)];
      if (!bands.some((b) => Math.abs(b.centerRf - medRf) < 0.032)) {
        bands.push({ id: bands.length, centerRf: medRf, wellSpots });
      }
    }
    cIdx = end + 1;
  }
  if (bands.length === 0) return locks;

  // 3. Score (compound, band) candidates under presence/absence discrimination OR universal-substrate mode
  interface ScoredEdge {
    comp: CompoundInfo;
    band: RfBand;
    meanPredRf: number;
    tp: number;
    fp: number;
    recall: number;
    precision: number;
    youdenJ: number;
    score: number;
  }
  const frontOccupiedFrac =
    activeWells.filter((w) => w.measuredWell?.frontOccupied).length / Math.max(1, activeWells.length);
  const originOccupiedFrac =
    activeWells.filter((w) => w.measuredWell?.originOccupied).length / Math.max(1, activeWells.length);

  const isNearUniversalSubstrate = (c: CompoundInfo): boolean => {
    if (c.kind !== 'substrate' || c.wellIndices.size < 6) return false;
    const neg = activeWells.length - c.wellIndices.size;
    return neg < 2 || (c.wellIndices.size >= 12 && c.wellIndices.size / activeWells.length >= 0.88);
  };
  const isExpectedBoundary = (meanPredRf: number): boolean =>
    (frontOccupiedFrac >= 0.40 && meanPredRf >= 0.78) ||
    (originOccupiedFrac >= 0.40 && meanPredRf <= 0.16);

  // Exclude boundary-pinned / front-saturated universal substrates so dark origin deposits or
  // nonpolar front-running partners never block interior universal substrates (e.g. 2'-hydroxyacetophenone)
  const interiorUniversalComps = candidateComps
    .filter((c) => {
      if (!isNearUniversalSubstrate(c)) return false;
      const mPred = c.predRfSum / Math.max(1, c.predRfCount);
      return !isExpectedBoundary(mPred);
    })
    .sort((a, b) => a.predRfSum / Math.max(1, a.predRfCount) - b.predRfSum / Math.max(1, b.predRfCount));
  const universalBands = bands
    .filter((b) => b.wellSpots.size >= Math.max(6, Math.ceil(activeWells.length * 0.6)))
    .sort((a, b) => a.centerRf - b.centerRf);

  const edges: ScoredEdge[] = [];
  for (const comp of candidateComps) {
    const P = comp.wellIndices.size;
    const N = activeWells.length - P;
    const meanPredRf = comp.predRfSum / Math.max(1, comp.predRfCount);
    const nearUniv = isNearUniversalSubstrate(comp);

    for (const band of bands) {
      let tp = 0;
      let fp = 0;
      for (const wIdx of band.wellSpots.keys()) {
        if (comp.wellIndices.has(wIdx)) tp++;
        else fp++;
      }
      if (tp < 3) continue;
      const recall = tp / P;
      const precision = tp / Math.max(1, tp + fp);
      const rfGap = Math.abs(band.centerRf - meanPredRf);

      let addedDiscrim = false;
      if (N >= 2) {
        // Discriminatory presence/absence mode
        const fpRate = fp / N;
        const youdenJ = recall - fpRate;
        const minPrec = comp.kind === 'substrate' ? 0.70 : 0.75;
        const minJ = comp.kind === 'substrate' ? 0.45 : 0.50;
        if (recall >= 0.45 && precision >= minPrec && youdenJ >= minJ && rfGap <= 0.48) {
          // Substrates are physically dispensed into wells while predicted products are hypothetical;
          // give substrates decisive priority so a speculative product near Rf 0.70 cannot steal an SM band.
          const score =
            0.55 * youdenJ +
            0.30 * precision +
            0.15 * Math.max(0, 1 - rfGap / 0.50) +
            (comp.kind === 'substrate' ? 0.25 : 0);
          edges.push({ comp, band, meanPredRf, tp, fp, recall, precision, youdenJ, score });
          addedDiscrim = true;
        }
      }

      if (!addedDiscrim && nearUniv && !isExpectedBoundary(meanPredRf)) {
        // Universal / near-universal substrate mode (e.g. fixed substrate present in 88-100% of wells).
        if (recall >= 0.60 && tp >= 6 && rfGap <= 0.45) {
          const boundaryAmbiguous =
            (frontOccupiedFrac >= 0.45 && meanPredRf >= 0.76 && band.centerRf < meanPredRf - 0.04) ||
            (originOccupiedFrac >= 0.45 && meanPredRf <= 0.20 && band.centerRf > meanPredRf + 0.04);
          if (boundaryAmbiguous) continue;

          if (interiorUniversalComps.length === 1) {
            const closerCompeting = universalBands.some(
              (ob) => ob.id !== band.id && Math.abs(ob.centerRf - meanPredRf) + 0.08 < rfGap
            );
            const soleDominantBand =
              recall >= 0.80 &&
              universalBands.filter((ob) => ob.wellSpots.size >= Math.ceil(activeWells.length * 0.8)).length === 1;
            if (!closerCompeting && (universalBands.length <= 2 || soleDominantBand)) {
              const score = 0.60 * recall + 0.35 * Math.max(0, 1 - rfGap / 0.48) + 0.25;
              edges.push({ comp, band, meanPredRf, tp, fp, recall, precision, youdenJ: recall, score });
            }
          } else if (
            interiorUniversalComps.length >= 2 &&
            universalBands.length === interiorUniversalComps.length
          ) {
            const compRank = interiorUniversalComps.findIndex((c) => c.key === comp.key);
            const bandRank = universalBands.findIndex((b) => b.id === band.id);
            if (compRank >= 0 && compRank === bandRank) {
              const score = 0.60 * recall + 0.35 * Math.max(0, 1 - rfGap / 0.48) + 0.25;
              edges.push({ comp, band, meanPredRf, tp, fp, recall, precision, youdenJ: recall, score });
            }
          } else if (
            interiorUniversalComps.length >= 2 &&
            universalBands.length === 1 &&
            universalBands[0].id === band.id &&
            recall >= 0.75 &&
            rfGap <= 0.42
          ) {
            // Multiple interior universal substrates but ONLY ONE universal band exists on the plate
            // (e.g. partner substrate was consumed or lacks strong UV254 chromophore):
            // lock only if this substrate is unambiguously the closest or the sole aromatic chromophore.
            const otherGaps = interiorUniversalComps
              .filter((c) => c.key !== comp.key)
              .map((c) => Math.abs(band.centerRf - c.predRfSum / Math.max(1, c.predRfCount)));
            const bestOtherGap = Math.min(...otherGaps);
            const strictlyClosest = rfGap + 0.06 < bestOtherGap;
            const uniquelyAromatic =
              comp.aromaticRings > 0 &&
              interiorUniversalComps.every((c) => c.key === comp.key || c.aromaticRings === 0);
            if (strictlyClosest || uniquelyAromatic) {
              const score = 0.55 * recall + 0.30 * Math.max(0, 1 - rfGap / 0.45) + 0.25;
              edges.push({ comp, band, meanPredRf, tp, fp, recall, precision, youdenJ: recall, score });
            }
          }
        }
      }
    }
  }

  edges.sort((a, b) => b.score - a.score);

  // 4. Greedy conflict-free lock selection (co-occurring compounds cannot share the same Rf band or cross order)
  const chosen: Array<{ edge: ScoredEdge; obsMean: number; obsSpread: number; channels?: TlcChannelKey[] }> = [];
  const lockedComps = new Set<string>();

  const sharedWellCount = (a: Set<number>, b: Set<number>): number => {
    let cnt = 0;
    for (const x of a) if (b.has(x)) cnt++;
    return cnt;
  };

  for (const edge of edges) {
    if (lockedComps.has(edge.comp.key)) continue;

    // Prevent co-occurring compounds from claiming the same Rf band, and preserve predicted Rf
    // order when presence/absence across distinct wells cannot independently prove an inversion.
    let conflict = false;
    for (const prev of chosen) {
      const overlap = sharedWellCount(edge.comp.wellIndices, prev.edge.comp.wellIndices);
      if (overlap >= 2) {
        if (Math.abs(edge.band.centerRf - prev.edge.band.centerRf) < 0.04) {
          conflict = true;
          break;
        }
        const sameWellMask =
          overlap === edge.comp.wellIndices.size && overlap === prev.edge.comp.wellIndices.size;
        const stronglyDiscriminated =
          !sameWellMask &&
          edge.youdenJ >= 0.65 &&
          edge.precision >= 0.80 &&
          prev.edge.youdenJ >= 0.65 &&
          prev.edge.precision >= 0.80;
        if (!stronglyDiscriminated) {
          const predDiff = edge.meanPredRf - prev.edge.meanPredRf;
          const obsDiff = edge.band.centerRf - prev.edge.band.centerRf;
          if (Math.abs(predDiff) >= 0.14 && predDiff * obsDiff < 0 && Math.abs(obsDiff) >= 0.08) {
            conflict = true;
            break;
          }
        }
      }
    }
    if (conflict) continue;

    // Compute exact observed Rf mean, spread, and dominant channels over this compound's wells
    const matchedSpots: TlcSpot[] = [];
    for (const wIdx of edge.comp.wellIndices) {
      const sp = edge.band.wellSpots.get(wIdx);
      if (sp) matchedSpots.push(sp);
    }
    if (matchedSpots.length < 3) continue;

    const meanRf = matchedSpots.reduce((s, sp) => s + sp.rf, 0) / matchedSpots.length;
    const varRf =
      matchedSpots.reduce((s, sp) => s + (sp.rf - meanRf) ** 2, 0) / matchedSpots.length;
    const spreadRf = Math.sqrt(varRf);

    const chCounts = new Map<TlcChannelKey, number>();
    for (const sp of matchedSpots) {
      for (const ch of sp.channels || []) {
        chCounts.set(ch, (chCounts.get(ch) ?? 0) + 1);
      }
    }
    const domChannels: TlcChannelKey[] = [];
    for (const [ch, c] of chCounts.entries()) {
      if (c >= matchedSpots.length * 0.4) domChannels.push(ch);
    }

    lockedComps.add(edge.comp.key);
    chosen.push({
      edge,
      obsMean: Math.round(meanRf * 1000) / 1000,
      obsSpread: Math.round(spreadRf * 1000) / 1000,
      ...(domChannels.length > 0 ? { channels: domChannels } : {}),
    });
  }

  for (const item of chosen) {
    locks.set(item.edge.comp.key, {
      compoundKey: item.edge.comp.key,
      observedRfMean: item.obsMean,
      observedRfSpread: item.obsSpread,
      matchedWells: item.edge.tp,
      totalWells: item.edge.comp.wellIndices.size,
      precision: Math.round(item.edge.precision * 1000) / 1000,
      youdenJ: Math.round(item.edge.youdenJ * 1000) / 1000,
      ...(item.channels ? { channels: item.channels } : {}),
    });
  }

  return locks;
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
    compoundKey: string;
    profile: TlcMolProfile;
    features: [number, number, number, number, number];
    displacementN: number;
    pair: Omit<TlcCalibrationSpotPair, 'predictedRfAfter'>;
  }
  interface CensoredBoundaryRecord {
    plateSummaryIdx: number;
    family: SolventFamily;
    isC18: boolean;
    compoundKey: string;
    kind: 'front' | 'baseline';
    predictedRfBefore: number;
    boundRf: number;
    weight: number;
  }
  const pairsByPhase = new Map<TlcStationaryPhasePreference, RawPairRecord[]>();
  const censoredByPhase = new Map<TlcStationaryPhasePreference, CensoredBoundaryRecord[]>();
  const plateAnchorProfiles = new Map<number, Map<number, TlcMolProfile[]>>();
  const plateCompoundMeta = new Map<
    number,
    {
      wellsPresentByCompound: Map<string, Set<number>>;
      consensusLocks: Map<string, CrossWellConsensusLock>;
    }
  >();
  const plateLevelByPhase = new Map<
    TlcStationaryPhasePreference,
    Array<{ family: SolventFamily; shift: number; n: number; obsCount: number }>
  >();

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
      const plateObsRf: number[] = [];
      const platePredSmRf: number[] = [];
      const laneCompMap = new Map<number, CalibratedLaneComparison>();
      const laneProfilesMap = new Map<number, TlcMolProfile[]>();
      const collectedWells: PlateWellCollection[] = [];
      const wellsPresentByCompound = new Map<string, Set<number>>();

      // Pass A: Extract predicted anchors & observed spots for all 54 wells on this plate
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
            weight: sp.tier === 'High' ? PRODUCT_ANCHOR_WEIGHT : PRODUCT_ANCHOR_WEIGHT * 0.85,
            profile: prof,
          });
          if (seenProd.size >= 4) break;
        }
        laneProfilesMap.set(wIdx, anchors.map((a) => a.profile));

        for (const a of anchors) {
          const ck = a.profile.canonicalSmiles || a.profile.smiles;
          if (!ck) continue;
          let ws = wellsPresentByCompound.get(ck);
          if (!ws) {
            ws = new Set();
            wellsPresentByCompound.set(ck, ws);
          }
          ws.add(wIdx);
        }

        const obsSpots = measuredWell?.spots || [];
        for (const sp of obsSpots) plateObsRf.push(sp.rf);
        for (const a of anchors) if (a.kind === 'substrate') platePredSmRf.push(a.rf);
        collectedWells.push({ wIdx, measuredWell, anchors, obsSpots });
      }

      // Stage 1: Infer plate-wide cross-well compound consensus locks before per-well pairing
      const consensusLocks = inferCrossWellConsensusLocks(collectedWells);
      let plateConsensusMatchCount = 0;

      // Pass B1: Pair each well using consensus locks first, then conservative per-well DP matching
      const isFrontPegged = (rf: number) => rf >= 0.92;
      const isBasePegged = (rf: number) => rf <= 0.05;

      interface WellMatchBundle {
        well: PlateWellCollection;
        matchedPairs: Array<{
          obs: TlcSpot;
          pred: PredAnchor;
          matchMethod: 'consensus' | 'per_well';
          consensusWellCount?: number;
          consensusTotalWells?: number;
        }>;
      }
      const wellMatchBundles: WellMatchBundle[] = [];

      for (const well of collectedWells) {
        const { anchors, obsSpots } = well;
        const usedObs = new Set<TlcSpot>();
        const usedPred = new Set<PredAnchor>();
        const matchedPairs: WellMatchBundle['matchedPairs'] = [];

        // 1. Apply cross-well consensus locks closest-distance-first so a consumed compound never
        // steals a neighboring locked compound's spot due to arbitrary anchor ordering.
        const consensusCandidates: Array<{
          anc: PredAnchor;
          sp: TlcSpot;
          dist: number;
          lock: CrossWellConsensusLock;
        }> = [];
        for (const anc of anchors) {
          const ck = anc.profile.canonicalSmiles || anc.profile.smiles;
          const lock = ck ? consensusLocks.get(ck) : undefined;
          if (!lock) continue;
          // Once a compound's true Rf band is confirmed across the plate, never let Stage 2 steal a
          // completely different Rf spot (e.g. a reaction product) in wells where this compound was consumed.
          usedPred.add(anc);
          const maxRadius = Math.min(0.062, Math.max(0.042, lock.observedRfSpread * 3 + 0.025));
          for (const sp of obsSpots) {
            if (isFrontPegged(sp.rf) || isBasePegged(sp.rf)) continue;
            const d = Math.abs(sp.rf - lock.observedRfMean);
            if (d <= maxRadius) {
              consensusCandidates.push({ anc, sp, dist: d, lock });
            }
          }
        }
        consensusCandidates.sort((a, b) => a.dist - b.dist);
        const matchedConsensusAnc = new Set<PredAnchor>();
        for (const cand of consensusCandidates) {
          if (matchedConsensusAnc.has(cand.anc) || usedObs.has(cand.sp)) continue;
          matchedConsensusAnc.add(cand.anc);
          usedObs.add(cand.sp);
          matchedPairs.push({
            obs: cand.sp,
            pred: cand.anc,
            matchMethod: 'consensus',
            consensusWellCount: cand.lock.matchedWells,
            consensusTotalWells: cand.lock.totalWells,
          });
          plateConsensusMatchCount++;
        }

        // 2. Per-well order-preserving DP matching for remaining unmatched spots & anchors
        const remObs = obsSpots.filter((sp) => !usedObs.has(sp));
        const remAnchors = anchors.filter((a) => !usedPred.has(a));
        for (const p of pairMeasuredAndPredictedSpots(remObs, remAnchors)) {
          matchedPairs.push({ obs: p.obs, pred: p.pred, matchMethod: 'per_well' });
        }

        wellMatchBundles.push({ well, matchedPairs });
      }

      // Pass B2: Sparse-substrate anti-hallucination guard.
      // If an unlocked substrate is present in >= 10 active wells, Stage 2 only matched it in a tiny
      // minority (< 25%), AND an unclaimed horizontal band exists in >= 55% of its wells (>= 2.5x more),
      // those sparse Stage 2 matches are almost certainly reaction products rather than the SM.
      const stage2SubstrateCounts = new Map<string, { count: number; predRfSum: number }>();
      const unclaimedByWell = new Map<number, TlcSpot[]>();
      for (const { well, matchedPairs } of wellMatchBundles) {
        const claimedObs = new Set(matchedPairs.map((m) => m.obs));
        const remInterior = well.obsSpots.filter(
          (sp) => !claimedObs.has(sp) && !isFrontPegged(sp.rf) && !isBasePegged(sp.rf)
        );
        if (remInterior.length > 0) unclaimedByWell.set(well.wIdx, remInterior);
        for (const mp of matchedPairs) {
          if (mp.matchMethod !== 'per_well' || mp.pred.kind !== 'substrate') continue;
          const ck = mp.pred.profile.canonicalSmiles || mp.pred.profile.smiles;
          if (!ck || consensusLocks.has(ck)) continue;
          const cur = stage2SubstrateCounts.get(ck) || { count: 0, predRfSum: 0 };
          cur.count++;
          cur.predRfSum += mp.pred.rf;
          stage2SubstrateCounts.set(ck, cur);
        }
      }

      const rejectedSparseSubstrates = new Set<string>();
      for (const [ck, st] of stage2SubstrateCounts.entries()) {
        const presentWells = wellsPresentByCompound.get(ck);
        if (!presentWells || presentWells.size < 10) continue;
        const P = presentWells.size;
        if (st.count >= Math.max(4, Math.ceil(P * 0.25))) continue;
        const meanPred = st.predRfSum / Math.max(1, st.count);

        // Scan unclaimed interior spots in this substrate's wells for a dominant unclaimed Rf band
        const candRfs: number[] = [];
        for (const wIdx of presentWells) {
          for (const sp of unclaimedByWell.get(wIdx) || []) {
            if (Math.abs(sp.rf - meanPred) <= 0.48) candRfs.push(sp.rf);
          }
        }
        let maxBandWells = 0;
        for (const seed of candRfs) {
          let hits = 0;
          for (const wIdx of presentWells) {
            if ((unclaimedByWell.get(wIdx) || []).some((sp) => Math.abs(sp.rf - seed) <= 0.055)) {
              hits++;
            }
          }
          if (hits > maxBandWells) maxBandWells = hits;
        }
        if (maxBandWells >= Math.max(6, Math.ceil(P * 0.55)) && maxBandWells >= st.count * 2.5) {
          rejectedSparseSubstrates.add(ck);
        }
      }

      for (const { well, matchedPairs: rawMatchedPairs } of wellMatchBundles) {
        const { wIdx, measuredWell, anchors, obsSpots } = well;
        const matchedPairs =
          rejectedSparseSubstrates.size > 0
            ? rawMatchedPairs.filter((mp) => {
                if (mp.matchMethod !== 'per_well' || mp.pred.kind !== 'substrate') return true;
                const ck = mp.pred.profile.canonicalSmiles || mp.pred.profile.smiles;
                return !ck || !rejectedSparseSubstrates.has(ck);
              })
            : rawMatchedPairs;

        const pairedByObs = new Map<TlcSpot, { pred: PredAnchor; matchMethod: 'consensus' | 'per_well' }>();
        const pairedByPred = new Map<PredAnchor, { obs: TlcSpot; matchMethod: 'consensus' | 'per_well' }>();

        for (const { obs, pred: pAnchor, matchMethod, consensusWellCount, consensusTotalWells } of matchedPairs) {
          pairedByObs.set(obs, { pred: pAnchor, matchMethod });
          pairedByPred.set(pAnchor, { obs, matchMethod });

          // Interior quantitative pairs enter least-squares residual minimization;
          // boundary-pegged peaks (>=0.92 or <=0.05) enter as one-sided censored bounds below.
          if (isFrontPegged(obs.rf) || isBasePegged(obs.rf)) continue;

          const dispN = pAnchor.profile.lser?.displacementN ?? 1.0;
          const kEff = isC18 ? 4.8 * (0.6 + 0.4 * dispN) : 6.2 * dispN;
          const resRf = obs.rf - pAnchor.rf;
          const rawResDem = clamp(-(logitRf(obs.rf) - logitRf(pAnchor.rf)) / kEff, -0.35, 0.35);
          // Consensus-locked compounds are verified across multiple wells, so use a gentler Huber cutoff
          const huberCut = matchMethod === 'consensus' ? 0.24 : 0.14;
          const huberW = Math.abs(rawResDem) <= huberCut ? 1.0 : huberCut / Math.abs(rawResDem);
          const ck = pAnchor.profile.canonicalSmiles || pAnchor.profile.smiles;
          platePairs.push({
            profile: pAnchor.profile,
            pair: {
              wellIndex: wIdx,
              wellCoord: wellLabel(wIdx),
              speciesLabel: pAnchor.label,
              speciesKind: pAnchor.kind,
              compoundKey: ck,
              observedRf: Math.round(obs.rf * 100) / 100,
              predictedRfBefore: pAnchor.rf,
              residualRf: Math.round(resRf * 1000) / 1000,
              residualDemand: Math.round(rawResDem * 10000) / 10000,
              weight: Math.round(pAnchor.weight * huberW * 1000) / 1000,
              matchMethod,
              ...(consensusWellCount !== undefined ? { consensusWellCount } : {}),
              ...(consensusTotalWells !== undefined ? { consensusTotalWells } : {}),
            },
          });
        }

        const frontBoundarySpot = obsSpots.find((sp) => isFrontPegged(sp.rf));
        const originBoundarySpot = obsSpots.find((sp) => isBasePegged(sp.rf));
        const hasFrontEvidence = Boolean(measuredWell?.frontOccupied || frontBoundarySpot);
        const hasOriginEvidence = Boolean(measuredWell?.originOccupied || originBoundarySpot);

        // Build per-lane Found vs Boundary-Saturated vs Missing vs Extra comparison
        // Only evaluate tailing/streaking on interior spots (boundary bands at the front/origin are saturation, not streaking)
        let maxTailing = 0;
        let maxRfSpan = 0;
        const compMeasured = obsSpots.map((sp) => {
          const pMatchEntry = pairedByObs.get(sp);
          const pMatch = pMatchEntry?.pred;
          const isInterior = sp.rf > 0.08 && sp.rf < 0.90;
          if (isInterior) {
            if (sp.tailing !== undefined && sp.tailing > maxTailing) maxTailing = sp.tailing;
            if (sp.rfSpan !== undefined && sp.rfSpan > maxRfSpan) maxRfSpan = sp.rfSpan;
          }
          return {
            rf: Math.round(sp.rf * 100) / 100,
            strength: sp.strength,
            ...(sp.widthFrac !== undefined ? { widthFrac: Math.round(sp.widthFrac * 1000) / 1000 } : {}),
            ...(sp.tailing !== undefined ? { tailing: Math.round(sp.tailing * 100) / 100 } : {}),
            ...(sp.rfSpan !== undefined ? { rfSpan: sp.rfSpan } : {}),
            ...(pMatch
              ? {
                  matchedLabel: pMatch.label,
                  matchedKind: pMatch.kind,
                  matchedPredRfBefore: pMatch.rf,
                  matchedPredRfAfter: pMatch.rf,
                  matchMethod: pMatchEntry?.matchMethod,
                }
              : {}),
          };
        });
        const measuredTailing = maxTailing >= 1.85 || maxRfSpan >= 0.18;

        let laneFrontCensored = 0;
        let laneBaseCensored = 0;
        const laneCensoredRecords: Array<Omit<CensoredBoundaryRecord, 'plateSummaryIdx'>> = [];

        const compPredicted = anchors.map((anc) => {
          let obsEntry = pairedByPred.get(anc);
          if (!obsEntry) {
            // If a near-coeluting representative replaced `anc` during dedup, still mark it found
            for (const [pUsed, entryUsed] of pairedByPred.entries()) {
              if (Math.abs(pUsed.rf - anc.rf) < 0.04) {
                obsEntry = entryUsed;
                break;
              }
            }
          }
          const obsMatch = obsEntry?.obs;
          let boundaryStatus: 'found' | 'front_saturated' | 'baseline_pinned' | 'missing' = 'missing';
          let boundaryObsRf: number | undefined;
          const ancCompoundKey = anc.profile.canonicalSmiles || anc.profile.smiles;
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
              compoundKey: ancCompoundKey,
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
              compoundKey: ancCompoundKey,
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
              ? { matchedObsRf: Math.round(obsMatch.rf * 100) / 100, matchMethod: obsEntry?.matchMethod }
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
          measuredTailing,
          ...(maxTailing > 0 ? { maxMeasuredTailing: Math.round(maxTailing * 100) / 100 } : {}),
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
      let plateTailingLaneCount = 0;
      for (const l of lanesOut) {
        if (l.isBlank) continue;
        if (l.measuredTailing) plateTailingLaneCount++;
        for (const p of l.predictedSpots) {
          if (p.boundaryStatus === 'front_saturated') plateFrontCensCount++;
          else if (p.boundaryStatus === 'baseline_pinned') plateBaseCensCount++;
        }
      }

      const plateSummaryIdx = model.plates.length;
      plateAnchorProfiles.set(plateSummaryIdx, laneProfilesMap);
      // Stash per-plate compound well counts & consensus channel info for summary building after fit
      plateCompoundMeta.set(plateSummaryIdx, { wellsPresentByCompound, consensusLocks });
      model.plates.push({
        setUid: set.uid,
        setName: set.name,
        plateIndex: pIdx,
        matchedSystemId: matched.system.id,
        matchedSystemName: matched.system.name,
        matchedSystem: matched.system,
        stationaryPhase: matched.stationaryPhase,
        family: matched.system.family,
        matchSource: matched.matchSource,
        laneCountWithSpots: extracted.laneCountWithSpots,
        pairedCount: platePairs.length,
        consensusMatchCount: plateConsensusMatchCount,
        frontCensoredCount: plateFrontCensCount,
        baselineCensoredCount: plateBaseCensCount,
        tailingLaneCount: plateTailingLaneCount,
        meanRfResidual: 0,
        rmseBefore: 0,
        rmseAfter: 0,
        midplateRfShift: 0,
        demandShift: 0,
        pairs: [],
        lanes: lanesOut,
      });

      {
        const interiorObsCount = plateObsRf.filter((r) => Number.isFinite(r) && r > 0.05 && r < 0.92).length;
        const est = estimatePlateLevelDemandShift(plateObsRf, platePredSmRf, isC18 ? 4.8 : 6.2);
        if (est) {
          let pl = plateLevelByPhase.get(matched.stationaryPhase);
          if (!pl) {
            pl = [];
            plateLevelByPhase.set(matched.stationaryPhase, pl);
          }
          pl.push({ family: matched.system.family, shift: est.shift, n: est.n, obsCount: interiorObsCount });
        }
      }

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
            compoundKey: item.profile.canonicalSmiles || item.profile.smiles,
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
  // Weights are per compound (not per well), so the prior pull is expressed in 'compound' units.
  const GLOBAL_LAMBDA = 1.6;
  const SLOPE_LAMBDA = 6.0;
  const FAMILY_LAMBDA = 3.0;
  const SIGMA_PRIOR_N = 8.0;

  const allPhases = new Set<TlcStationaryPhasePreference>([
    ...pairsByPhase.keys(),
    ...censoredByPhase.keys(),
    ...plateLevelByPhase.keys(),
  ]);

  for (const phase of allPhases) {
    const records = pairsByPhase.get(phase) || [];
    const censRecords = censoredByPhase.get(phase) || [];
    const plateLevel = plateLevelByPhase.get(phase) || [];
    if (records.length === 0 && censRecords.length === 0 && plateLevel.length === 0) continue;
    const isC18 = phase === 'C18';
    const kPhase = isC18 ? 4.8 : 6.2;

    interface PhaseFitResult {
      globalDemandShift: number;
      demandSlope: number;
      familyDemandShifts: Partial<Record<SolventFamily, number>>;
      featureWeights?: TlcCalibrationFeatureWeights;
    }

    // Fits shift / slope (+ optional family shifts and descriptor ridge when allowExtras) on a set of records.
    const fitPhaseModel = (
      fitRecords: RawPairRecord[],
      fitCensRecords: CensoredBoundaryRecord[],
      allowExtras: boolean,
      uniqueCount: number
    ): PhaseFitResult => {
      const evalPhaseObjective = (shift: number, slope: number): number => {
        let loss = GLOBAL_LAMBDA * shift * shift + SLOPE_LAMBDA * (slope - 1) * (slope - 1);
        for (const rec of fitRecords) {
          const dispScale = isC18 ? 0.6 + 0.4 * rec.displacementN : rec.displacementN;
          const kEff = kPhase * dispScale;
          const zB = logitRf(rec.pair.predictedRfBefore);
          const zObs = logitRf(rec.pair.observedRf);
          const zAfter = slope * (zB - kEff * shift);
          const residD = (zAfter - zObs) / kEff;
          loss += rec.pair.weight * residD * residD;
        }
        for (const cr of fitCensRecords) {
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
      if (fitRecords.length > 0) {
        let wS = 0;
        let wrS = 0;
        for (const rec of fitRecords) {
          wS += rec.pair.weight;
          wrS += rec.pair.weight * rec.pair.residualDemand;
        }
        globalDemandShift = clamp(wrS / (wS + GLOBAL_LAMBDA), -0.22, 0.22);
      }
      const allowSlopeFit = uniqueCount >= 4 || (uniqueCount >= 2 && fitCensRecords.length >= 2);
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
      for (const rec of fitRecords) {
        const cur = familySums.get(rec.family) || { w: 0, wr: 0 };
        const residAfterGlobal = rec.pair.residualDemand - globalDemandShift;
        cur.w += rec.pair.weight;
        cur.wr += rec.pair.weight * residAfterGlobal;
        familySums.set(rec.family, cur);
      }

      const familyDemandShifts: Partial<Record<SolventFamily, number>> = {};
      for (const [fam, stats] of familySums.entries()) {
        if (allowExtras && stats.w >= 2.5) {
          const famShift = clamp(stats.wr / (stats.w + FAMILY_LAMBDA), -0.12, 0.12);
          if (Math.abs(famShift) >= 0.005) {
            familyDemandShifts[fam] = Math.round(famShift * 10000) / 10000;
          }
        }
      }

      // Multivariate 5D L2-regularized Ridge regression on post-shift/slope descriptor residuals
      // Only activates with sufficient distinct compounds & paired spots; keeps uniform shifts strictly untouched.
      let featureWeights: TlcCalibrationFeatureWeights | undefined;
      if (allowExtras && fitRecords.length >= 20 && uniqueCount >= 6) {
        const RIDGE_LAMBDA = 1.5;
        const featMeans = [0, 0, 0, 0, 0];
        let wTot = 0;
        for (const rec of fitRecords) {
          wTot += rec.pair.weight;
          for (let j = 0; j < 5; j++) featMeans[j] += rec.pair.weight * rec.features[j];
        }
        if (wTot > 0) {
          for (let j = 0; j < 5; j++) featMeans[j] /= wTot;

          const A: number[][] = Array.from({ length: 5 }, (_, r) =>
            Array.from({ length: 5 }, (__, c) => (r === c ? RIDGE_LAMBDA : 0))
          );
          const b: number[] = [0, 0, 0, 0, 0];

          for (const rec of fitRecords) {
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

      return {
        globalDemandShift,
        demandSlope,
        familyDemandShifts,
        ...(featureWeights ? { featureWeights } : {}),
      };
    };

    // Effective weights: a compound seen in many wells (even across non-canonical SMILES variants)
    // counts about once overall, not once per well.
    const compoundCount = new Map<string, number>();
    for (const rec of records) compoundCount.set(rec.compoundKey, (compoundCount.get(rec.compoundKey) ?? 0) + 1);
    for (const rec of records) {
      rec.pair.weight = Math.round((rec.pair.weight / (compoundCount.get(rec.compoundKey) ?? 1)) * 10000) / 10000;
    }
    const uniqueCompounds = compoundCount.size;
    // Censored front / baseline hits are per well too: cap their total pull at about one unit per compound.
    const censCap = Math.max(2, uniqueCompounds);
    const censTotal = censRecords.reduce((a, c) => a + c.weight, 0);
    if (censTotal > censCap) {
      const f = censCap / censTotal;
      for (const c of censRecords) c.weight = c.weight * f;
    }

    // Grouped (leave-compounds-out) validation: an eluent-polarity correction must predict compounds it has
    // not seen. Both paired records AND censored boundary hits are filtered by canonical compoundKey so zero
    // test-compound evidence leaks into any training fold.
    // Candidate A = global shift + slope only; candidate B adds family shifts / descriptor ridge.
    const predictRf = (rec: RawPairRecord, phaseFit: PhaseFitResult): number => {
      const famShift = phaseFit.familyDemandShifts[rec.family] ?? 0;
      return applyCalibrationShiftToRf(
        rec.pair.predictedRfBefore,
        phaseFit.globalDemandShift + famShift,
        isC18,
        phaseFit.demandSlope,
        computeFeatureDemandDelta(rec.profile, phaseFit.featureWeights),
        rec.displacementN
      );
    };
    let cvRmse: number | undefined;
    let cvRmseBaseline: number | undefined;
    let useExtras = false;
    let validated = false;
    if (uniqueCompounds >= 4 && records.length >= 6) {
      const compounds = Array.from(compoundCount.keys());
      const folds = Math.min(5, compounds.length);
      const foldOf = new Map<string, number>();
      compounds.forEach((c, i) => foldOf.set(c, i % folds));
      const cvError = (allowExtras: boolean): number => {
        let se = 0;
        let wt = 0;
        for (let f = 0; f < folds; f++) {
          const train = records.filter((r) => foldOf.get(r.compoundKey) !== f);
          const test = records.filter((r) => foldOf.get(r.compoundKey) === f);
          if (test.length === 0 || train.length === 0) continue;
          const foldCens = censRecords.filter((c) => foldOf.get(c.compoundKey) !== f);
          const tc = new Set(train.map((r) => r.compoundKey)).size;
          const foldFit = fitPhaseModel(train, foldCens, allowExtras, tc);
          for (const r of test) {
            const e = r.pair.observedRf - predictRf(r, foldFit);
            se += r.pair.weight * e * e;
            wt += r.pair.weight;
          }
        }
        return wt > 0 ? Math.sqrt(se / wt) : NaN;
      };
      let baseSe = 0;
      let baseW = 0;
      for (const r of records) {
        const e = r.pair.observedRf - r.pair.predictedRfBefore;
        baseSe += r.pair.weight * e * e;
        baseW += r.pair.weight;
      }
      cvRmseBaseline = baseW > 0 ? Math.sqrt(baseSe / baseW) : undefined;
      const cvA = cvError(false);
      // family shifts / descriptor ridge are only even considered with enough pairs and distinct compounds
      const extrasEligible = records.length >= 30 && uniqueCompounds >= 8;
      const cvB = extrasEligible ? cvError(true) : cvA;
      if (Number.isFinite(cvA) && Number.isFinite(cvB)) {
        validated = true;
        useExtras = extrasEligible && cvB < cvA - 0.003;
        cvRmse = Math.min(cvA, cvB);
      }
    }

    // Leave-one-plate-out holdout validation when >= 2 measured plates exist in this phase
    let plateCvRmse: number | undefined;
    let plateCvRmseBaseline: number | undefined;
    const distinctPlates = Array.from(new Set(records.map((r) => r.plateSummaryIdx)));
    if (distinctPlates.length >= 2 && records.length >= 6) {
      let pSe = 0;
      let pBaseSe = 0;
      let pWt = 0;
      for (const heldOutPlate of distinctPlates) {
        const train = records.filter((r) => r.plateSummaryIdx !== heldOutPlate);
        const test = records.filter((r) => r.plateSummaryIdx === heldOutPlate);
        if (train.length === 0 || test.length === 0) continue;
        const trainCens = censRecords.filter((c) => c.plateSummaryIdx !== heldOutPlate);
        const tc = new Set(train.map((r) => r.compoundKey)).size;
        const foldFit = fitPhaseModel(train, trainCens, useExtras, tc);
        for (const r of test) {
          const e = r.pair.observedRf - predictRf(r, foldFit);
          const e0 = r.pair.observedRf - r.pair.predictedRfBefore;
          pSe += r.pair.weight * e * e;
          pBaseSe += r.pair.weight * e0 * e0;
          pWt += r.pair.weight;
        }
      }
      if (pWt > 0) {
        plateCvRmse = Math.round(Math.sqrt(pSe / pWt) * 1000) / 1000;
        plateCvRmseBaseline = Math.round(Math.sqrt(pBaseSe / pWt) * 1000) / 1000;
      }
    }

    let { globalDemandShift, demandSlope, familyDemandShifts, featureWeights } = fitPhaseModel(
      records,
      censRecords,
      useExtras,
      uniqueCompounds
    );
    // If held-out error is no better than the uncalibrated model, do not apply a correction at all.
    const calibrationHelps =
      !validated || cvRmseBaseline === undefined || cvRmse === undefined || cvRmse < cvRmseBaseline - 0.002;
    if (!calibrationHelps) {
      globalDemandShift = 0;
      demandSlope = 1;
      familyDemandShifts = {};
      featureWeights = undefined;
    }

    // Plate-level backstop: ONLY activates when a family's whole plate runs far from the prediction
    // AND pairing actually failed to cover the plate's interior spots (< 10 pairs or < 25% of observed spots),
    // AND never when applying it worsens the paired spots' RMSE.
    const plateLevelFamilies: Partial<Record<SolventFamily, number>> = {};
    {
      const byFam = new Map<SolventFamily, { w: number; ws: number; obsCount: number }>();
      for (const pl of plateLevel) {
        const cur = byFam.get(pl.family) || { w: 0, ws: 0, obsCount: 0 };
        cur.w += pl.n;
        cur.ws += pl.n * pl.shift;
        cur.obsCount += pl.obsCount;
        byFam.set(pl.family, cur);
      }
      for (const [fam, st] of byFam.entries()) {
        const est = st.ws / st.w;
        const pairBased = globalDemandShift + (familyDemandShifts[fam] ?? 0);
        if (Math.abs(est - pairBased) <= 0.15) continue;

        const famRecords = records.filter((r) => r.family === fam);
        // Gate 1: If pairing already matched a healthy share of interior spots, trust the paired fit.
        if (famRecords.length >= 10 && famRecords.length >= 0.25 * st.obsCount) continue;

        // Gate 2: Never apply a backstop shift that degrades the existing paired spots' RMSE.
        if (famRecords.length > 0) {
          let sqCur = 0;
          let sqEst = 0;
          for (const rec of famRecords) {
            const featDelta = computeFeatureDemandDelta(rec.profile, featureWeights);
            const pCur = applyCalibrationShiftToRf(
              rec.pair.predictedRfBefore,
              pairBased,
              isC18,
              demandSlope,
              featDelta,
              rec.displacementN
            );
            const pEst = applyCalibrationShiftToRf(
              rec.pair.predictedRfBefore,
              est,
              isC18,
              demandSlope,
              featDelta,
              rec.displacementN
            );
            sqCur += (rec.pair.observedRf - pCur) ** 2;
            sqEst += (rec.pair.observedRf - pEst) ** 2;
          }
          const rmseCur = Math.sqrt(sqCur / famRecords.length);
          const rmseEst = Math.sqrt(sqEst / famRecords.length);
          if (rmseEst > rmseCur + 0.025) continue;
        }

        familyDemandShifts[fam] = Math.round(clamp(est - globalDemandShift, -0.45, 0.45) * 10000) / 10000;
        plateLevelFamilies[fam] = Math.round(est * 10000) / 10000;
      }
    }

    // Re-evaluate all pairs after calibration to fill parity points, RMSE, and per-family stats
    let wSum = 0;
    let sqErrBefore = 0;
    let sqErrAfter = 0;
    let rfBiasSum = 0;
    const uniqueLanes = new Set<string>();
    const plateAccum = new Map<
      number,
      { sqBefore: number; sqAfter: number; rfSum: number; wSum: number; wrSum: number }
    >();
    const familyAccum = new Map<
      SolventFamily,
      { plates: Set<number>; count: number; sqBefore: number; sqAfter: number }
    >();

    for (let pIdxSummary = 0; pIdxSummary < model.plates.length; pIdxSummary++) {
      const pEntry = model.plates[pIdxSummary];
      if (pEntry.stationaryPhase !== phase) continue;
      let fa = familyAccum.get(pEntry.family);
      if (!fa) {
        fa = { plates: new Set(), count: 0, sqBefore: 0, sqAfter: 0 };
        familyAccum.set(pEntry.family, fa);
      }
      fa.plates.add(pIdxSummary);
    }

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

      let fa = familyAccum.get(rec.family);
      if (!fa) {
        fa = { plates: new Set(), count: 0, sqBefore: 0, sqAfter: 0 };
        familyAccum.set(rec.family, fa);
      }
      fa.plates.add(rec.plateSummaryIdx);
      fa.count++;
      fa.sqBefore += errBefore * errBefore;
      fa.sqAfter += errAfter * errAfter;
    }

    const familyStats: Partial<Record<SolventFamily, TlcCalibrationFamilyStats>> = {};
    for (const [fam, fa] of familyAccum.entries()) {
      familyStats[fam] = {
        plateCount: fa.plates.size,
        pairedCount: fa.count,
        rmseBefore: fa.count > 0 ? Math.round(Math.sqrt(fa.sqBefore / fa.count) * 1000) / 1000 : 0,
        rmseAfter: fa.count > 0 ? Math.round(Math.sqrt(fa.sqAfter / fa.count) * 1000) / 1000 : 0,
      };
    }

    const n = records.length;
    const rmseBefore = n > 0 ? Math.round(Math.sqrt(sqErrBefore / n) * 1000) / 1000 : 0.12;
    const rmseAfter = n > 0 ? Math.round(Math.sqrt(sqErrAfter / n) * 1000) / 1000 : 0.12;
    // In-sample error flatters the fit; use the held-out error when we have it, and never go below the floor.
    const sigmaErr = cvRmse !== undefined ? Math.max(rmseAfter, cvRmse) : Math.max(rmseAfter, RF_SIGMA);
    const calibratedSigma = Math.round(
      clamp((SIGMA_PRIOR_N * RF_SIGMA + wSum * sigmaErr) / (SIGMA_PRIOR_N + wSum), SIGMA_FLOOR, 0.17) * 1000
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

      // Build per-compound summaries for this plate (human-readable breakdown for chemists)
      const compMeta = plateCompoundMeta.get(pIdxSummary);
      const byCompound = new Map<
        string,
        {
          label: string;
          kind: 'substrate' | 'product';
          obsRfs: number[];
          predBefores: number[];
          predAfters: number[];
          hasConsensus: boolean;
          wellsPresent: number;
          channels?: Array<'UV254' | 'UV366' | 'White'>;
        }
      >();
      for (const fp of pEntry.pairs) {
        const ck = fp.compoundKey || fp.speciesLabel;
        let entry = byCompound.get(ck);
        if (!entry) {
          const lock = compMeta?.consensusLocks.get(ck);
          const presentCount =
            compMeta?.wellsPresentByCompound.get(ck)?.size ??
            fp.consensusTotalWells ??
            1;
          const lockCh = lock?.channels?.filter(
            (ch): ch is 'UV254' | 'UV366' | 'White' =>
              ch === 'UV254' || ch === 'UV366' || ch === 'White'
          );
          entry = {
            label: fp.speciesLabel,
            kind: fp.speciesKind,
            obsRfs: [],
            predBefores: [],
            predAfters: [],
            hasConsensus: fp.matchMethod === 'consensus',
            wellsPresent: presentCount,
            channels: lockCh && lockCh.length > 0 ? lockCh : undefined,
          };
          byCompound.set(ck, entry);
        }
        if (fp.speciesKind === 'substrate') entry.kind = 'substrate';
        if (fp.matchMethod === 'consensus') entry.hasConsensus = true;
        entry.obsRfs.push(fp.observedRf);
        entry.predBefores.push(fp.predictedRfBefore);
        entry.predAfters.push(fp.predictedRfAfter);
      }

      const plateSummaries: CalibratedCompoundSummary[] = [];
      for (const [ck, e] of byCompound.entries()) {
        const m = e.obsRfs.length;
        if (m === 0) continue;
        const obsMean = e.obsRfs.reduce((a, b) => a + b, 0) / m;
        const predBeforeMean = e.predBefores.reduce((a, b) => a + b, 0) / m;
        const predAfterMean = e.predAfters.reduce((a, b) => a + b, 0) / m;
        const variance = e.obsRfs.reduce((a, b) => a + (b - obsMean) ** 2, 0) / m;
        plateSummaries.push({
          compoundKey: ck,
          label: e.label,
          kind: e.kind,
          wellsPresent: Math.max(e.wellsPresent, m),
          wellsMatched: m,
          predictedRfBefore: Math.round(predBeforeMean * 100) / 100,
          predictedRfAfter: Math.round(predAfterMean * 100) / 100,
          observedRfMean: Math.round(obsMean * 100) / 100,
          observedRfSpread: Math.round(Math.sqrt(variance) * 1000) / 1000,
          rfShift: Math.round((obsMean - predBeforeMean) * 100) / 100,
          matchMethod: e.hasConsensus ? 'consensus' : 'per_well',
          ...(e.channels ? { channels: e.channels } : {}),
        });
      }
      plateSummaries.sort((a, b) => {
        if (a.matchMethod !== b.matchMethod) return a.matchMethod === 'consensus' ? -1 : 1;
        if (b.wellsMatched !== a.wellsMatched) return b.wellsMatched - a.wellsMatched;
        return Math.abs(b.rfShift) - Math.abs(a.rfShift);
      });
      pEntry.compoundSummaries = plateSummaries;
    }

    // Aggregate compound summaries across all plates in this phase
    const phaseCompAccum = new Map<
      string,
      {
        label: string;
        kind: 'substrate' | 'product';
        wellsPresent: number;
        wellsMatched: number;
        obsWeighted: number;
        predBeforeWeighted: number;
        predAfterWeighted: number;
        spreadWeighted: number;
        hasConsensus: boolean;
        channels: Set<'UV254' | 'UV366' | 'White'>;
      }
    >();
    for (const pEntry of model.plates) {
      if (pEntry.stationaryPhase !== phase || !pEntry.compoundSummaries) continue;
      for (const cs of pEntry.compoundSummaries) {
        let agg = phaseCompAccum.get(cs.compoundKey);
        if (!agg) {
          agg = {
            label: cs.label,
            kind: cs.kind,
            wellsPresent: 0,
            wellsMatched: 0,
            obsWeighted: 0,
            predBeforeWeighted: 0,
            predAfterWeighted: 0,
            spreadWeighted: 0,
            hasConsensus: false,
            channels: new Set(),
          };
          phaseCompAccum.set(cs.compoundKey, agg);
        }
        if (cs.kind === 'substrate') agg.kind = 'substrate';
        if (cs.matchMethod === 'consensus') agg.hasConsensus = true;
        agg.wellsPresent += cs.wellsPresent;
        agg.wellsMatched += cs.wellsMatched;
        agg.obsWeighted += cs.observedRfMean * cs.wellsMatched;
        agg.predBeforeWeighted += cs.predictedRfBefore * cs.wellsMatched;
        agg.predAfterWeighted += cs.predictedRfAfter * cs.wellsMatched;
        agg.spreadWeighted += cs.observedRfSpread * cs.wellsMatched;
        if (cs.channels) {
          for (const ch of cs.channels) agg.channels.add(ch);
        }
      }
    }

    const phaseCompoundSummaries: CalibratedCompoundSummary[] = [];
    for (const [ck, agg] of phaseCompAccum.entries()) {
      const m = Math.max(1, agg.wellsMatched);
      const obsMean = agg.obsWeighted / m;
      const predBeforeMean = agg.predBeforeWeighted / m;
      const predAfterMean = agg.predAfterWeighted / m;
      const chArr = Array.from(agg.channels);
      phaseCompoundSummaries.push({
        compoundKey: ck,
        label: agg.label,
        kind: agg.kind,
        wellsPresent: Math.max(agg.wellsPresent, agg.wellsMatched),
        wellsMatched: agg.wellsMatched,
        predictedRfBefore: Math.round(predBeforeMean * 100) / 100,
        predictedRfAfter: Math.round(predAfterMean * 100) / 100,
        observedRfMean: Math.round(obsMean * 100) / 100,
        observedRfSpread: Math.round((agg.spreadWeighted / m) * 1000) / 1000,
        rfShift: Math.round((obsMean - predBeforeMean) * 100) / 100,
        matchMethod: agg.hasConsensus ? 'consensus' : 'per_well',
        ...(chArr.length > 0 ? { channels: chArr } : {}),
      });
    }
    phaseCompoundSummaries.sort((a, b) => {
      if (a.matchMethod !== b.matchMethod) return a.matchMethod === 'consensus' ? -1 : 1;
      if (b.wellsMatched !== a.wellsMatched) return b.wellsMatched - a.wellsMatched;
      return Math.abs(b.rfShift) - Math.abs(a.rfShift);
    });
    const consensusCompoundCount = phaseCompoundSummaries.filter((c) => c.matchMethod === 'consensus').length;

    const frontCensoredCount = censRecords.filter((c) => c.kind === 'front').length;
    const baselineCensoredCount = censRecords.filter((c) => c.kind === 'baseline').length;

    const fit: TlcCalibrationPhaseFit = {
      globalDemandShift,
      demandSlope,
      familyDemandShifts,
      ...(Object.keys(familyStats).length > 0 ? { familyStats } : {}),
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
      uniqueCompounds,
      consensusCompoundCount,
      ...(phaseCompoundSummaries.length > 0 ? { compoundSummaries: phaseCompoundSummaries } : {}),
      validated,
      ...(cvRmse !== undefined ? { cvRmse: Math.round(cvRmse * 1000) / 1000 } : {}),
      ...(cvRmseBaseline !== undefined ? { cvRmseBaseline: Math.round(cvRmseBaseline * 1000) / 1000 } : {}),
      ...(plateCvRmse !== undefined ? { plateCvRmse } : {}),
      ...(plateCvRmseBaseline !== undefined ? { plateCvRmseBaseline } : {}),
      calibrationApplied: calibrationHelps || Object.keys(plateLevelFamilies).length > 0,
      ...(Object.keys(plateLevelFamilies).length > 0 ? { plateLevelFamilies } : {}),
    };
    model.byPhase[phase] = fit;
  }

  return { model, newlyComputedPredictions };
}
