// Robowski Studio - TLC Lane Mathematics, Signal Densitometry & Coordinate Transforms
import {
  RunResult,
  TlcLane,
  TlcLaneConfig,
  TlcLaneRow,
  TlcSpot,
  TlcProfileOptions,
  TlcDensitogramData,
  TlcSet,
  TlcImageEntry,
  TlcPreRunAlignment,
  ProfileHistogramStats,
  Lane2dMetrics,
} from '../types';
export type { ProfileHistogramStats, Lane2dMetrics };
import { parseDelimited } from './importers/tableReader';
import { csvText } from './exporters/csv';
import { getTlcPlateSlice } from './tlcPlateSlice';
import {
  analyzeLaneStripRgb,
  applyFlatFieldCorrection,
  detectCurvedFrontSeam,
  detectGlassTopEdge,
  findDualHalfGapCeiling,
  isProfileOnPlate,
  CurvedFrontChannelInput,
  CurvedFrontSeamOptions,
  CurvedFrontSeamResult,
} from './tlcVision2d';
import {
  computeAutomiddleOffsets,
  inspectLabTlcFilename,
  sampleFloatRgbLaneStrip,
} from './tlcLabPipeline';

export const LANE_FRAME_WIDTH = 3280;
export const TLC_ROWS = 6;
export const TLC_COLS = 9;
export const TLC_ORDER = 'column';

export const TLC_SIGNAL = {
  UV254: { ch: 1, sign: -1, label: 'UV 254 nm' },
  UV366: { ch: 2, sign: 1, label: 'UV 365 nm' },
  White: { ch: 2, sign: -1, label: 'Visible' },
} as const;

export type TlcChannelKey = keyof typeof TLC_SIGNAL;

export function parseLaneConfig(text: string): TlcLaneConfig {
  const rows = parseDelimited(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length < 2) throw new Error('The lane file has no rows.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const n of ['id', 'x0', 'y0', 'length', 'width', 'direction_angle']) {
    if (col(n) < 0) {
      throw new Error(
        `The lane file needs a "${n}" column (found: ${head.filter(Boolean).join(', ') || 'none'}).`
      );
    }
  }
  const num = (r: any[], n: string, i: number) => {
    const k = col(n);
    if (k < 0) return null;
    const v = r[k] === '' || r[k] == null ? NaN : +r[k];
    if (!isFinite(v)) {
      if (n === 'spot_radius_px' || n === 'px_location_of_zero_rf') return null;
      throw new Error(`Row ${i + 2}: "${n}" is not a number.`);
    }
    return v;
  };
  const lanes: TlcLane[] = rows.slice(1).map((r, i) => ({
    id: num(r, 'id', i) as number,
    x0: num(r, 'x0', i) as number,
    y0: num(r, 'y0', i) as number,
    length: num(r, 'length', i) as number,
    width: num(r, 'width', i) as number,
    angle: num(r, 'direction_angle', i) as number,
    spotRadius: num(r, 'spot_radius_px', i),
    zeroRf: num(r, 'px_location_of_zero_rf', i),
  }));
  if (lanes.some((l) => l.length <= 0 || l.width <= 0)) {
    throw new Error('Every lane needs a length and width above zero.');
  }

  const warnings: string[] = [];
  if (lanes.length > 54) {
    warnings.push(`${lanes.length} lanes found; only the first 54 fit a 6 x 9 plate.`);
  }

  // Detect Merck TLC Explorer / Hamilton Vantage alternating parallel lane numbering
  // (e.g., lab PC calibration/lanes.csv & microadjusted_lane_config.csv where even IDs 0,2,4..52
  // are bottom-half A1..C5 at angle≈0° and odd IDs 1,3,5..53 are top-half D5..F9 at angle≈180°).
  // Normalize to our grouped convention (0..26 = lower half A1..C5, 27..53 = upper half D5..F9)
  // so every well coordinate A1..F9 matches the physical Hamilton spotting layout!
  let normalizedLanes = lanes;
  if (lanes.length >= 10 && lanes.length % 2 === 0 && lanes.length <= 54) {
    const isUp = (ang: number) => {
      const a = (((ang % 360) + 540) % 360) - 180; // [-180, 180)
      return Math.abs(a) < 45;
    };
    const isDown = (ang: number) => {
      const a = (((ang % 360) + 540) % 360) - 180;
      return Math.abs(Math.abs(a) - 180) < 45;
    };
    const evens = lanes.filter((l) => l.id % 2 === 0);
    const odds = lanes.filter((l) => l.id % 2 !== 0);
    const halfN = lanes.length / 2;
    if (evens.length === halfN && odds.length === halfN) {
      const evenUp = evens.filter((l) => isUp(l.angle)).length;
      const evenDown = evens.filter((l) => isDown(l.angle)).length;
      const oddUp = odds.filter((l) => isUp(l.angle)).length;
      const oddDown = odds.filter((l) => isDown(l.angle)).length;
      const evenY = evens.reduce((s, l) => s + l.y0, 0) / halfN;
      const oddY = odds.reduce((s, l) => s + l.y0, 0) / halfN;

      const interleavedEvenLower =
        (evenUp >= halfN * 0.85 && oddDown >= halfN * 0.85) ||
        (evenUp >= halfN * 0.85 && oddUp >= halfN * 0.85 && evenY > oddY + 250);
      const interleavedOddLower =
        oddUp >= halfN * 0.85 && evenDown >= halfN * 0.85;

      if (interleavedEvenLower || interleavedOddLower) {
        const lower = (interleavedEvenLower ? evens : odds).slice().sort((a, b) => a.id - b.id);
        const upper = (interleavedEvenLower ? odds : evens).slice().sort((a, b) => a.id - b.id);
        normalizedLanes = [
          ...lower.map((l, idx) => ({ ...l, id: idx })),
          ...upper.map((l, idx) => ({ ...l, id: halfN + idx })),
        ];
        warnings.push(
          'Detected lab PC alternating lane numbering (even=A1–C5, odd=D5–F9) and remapped to A1–F9 automatically.'
        );
      }
    }
  }

  return {
    lanes: normalizedLanes,
    hasZeroRf: normalizedLanes.every((l) => l.zeroRf != null),
    warnings,
  };
}

export function createDefaultLaneConfig(
  frameWidth: number = LANE_FRAME_WIDTH,
  layout: 'two-tier' | 'single-tier' = 'two-tier'
): TlcLaneConfig {
  const lanes: TlcLane[] = [];
  const total = 54;

  if (layout === 'single-tier') {
    const leftMargin = Math.round(frameWidth * 0.06);
    const rightMargin = Math.round(frameWidth * 0.94);
    const step = (rightMargin - leftMargin) / (total - 1);
    const laneWidth = Math.max(20, Math.round(step * 0.65));
    const laneLength = 1200;
    const y0 = 2100;

    for (let i = 0; i < total; i++) {
      lanes.push({
        id: i,
        x0: Math.round(leftMargin + i * step),
        y0,
        length: laneLength,
        width: laneWidth,
        angle: 0,
        spotRadius: 16,
        zeroRf: 120,
      });
    }
  } else {
    // Standard Two-Tier HTS TLC layout: 27 lanes in lower tier (0..26), 27 lanes in upper tier (27..53)
    const perTier = 27;
    const leftMargin = Math.round(frameWidth * 0.08);
    const rightMargin = Math.round(frameWidth * 0.92);
    const step = (rightMargin - leftMargin) / (perTier - 1);
    const laneWidth = Math.max(24, Math.round(step * 0.6));

    // Lower tier: Lanes 0 to 26
    for (let i = 0; i < perTier; i++) {
      lanes.push({
        id: i,
        x0: Math.round(leftMargin + i * step),
        y0: 2150,
        length: 980,
        width: laneWidth,
        angle: 0,
        spotRadius: 16,
        zeroRf: 120,
      });
    }

    // Upper tier: Lanes 27 to 53
    for (let i = perTier; i < total; i++) {
      lanes.push({
        id: i,
        x0: Math.round(leftMargin + (i - perTier) * step),
        y0: 1050,
        length: 980,
        width: laneWidth,
        angle: 0,
        spotRadius: 16,
        zeroRf: 120,
      });
    }
  }

  return {
    lanes,
    hasZeroRf: true,
    warnings: [],
  };
}

export function createDefaultLaneCsvText(layout: 'two-tier' | 'single-tier' = 'two-tier'): string {
  const cfg = createDefaultLaneConfig(LANE_FRAME_WIDTH, layout);
  return exportLaneConfigCsv(cfg);
}

export function exportLaneConfigCsv(cfg: TlcLaneConfig): string {
  const rows = [
    'id,x0,y0,length,width,direction_angle,spot_radius_px,px_location_of_zero_rf',
    ...cfg.lanes.map(
      (l) => `${l.id},${Math.round(l.x0)},${Math.round(l.y0)},${Math.round(l.length)},${Math.round(l.width)},${Number(l.angle.toFixed(2))},${l.spotRadius ?? ''},${l.zeroRf != null ? Math.round(l.zeroRf) : ''}`
    ),
  ];
  return rows.join('\n');
}

export function tlcLane(container: number, order: string = TLC_ORDER): number {
  const r = Math.floor(container / TLC_COLS);
  const c = container % TLC_COLS;
  return order === 'row' ? container : c * TLC_ROWS + r;
}

export function containerOfLane(t: number): number {
  const c = Math.floor(t / TLC_ROWS);
  const r = t % TLC_ROWS;
  return r * TLC_COLS + c;
}

export function wellLabel(container: number): string {
  return 'ABCDEF'[Math.floor(container / TLC_COLS)] + ((container % TLC_COLS) + 1);
}

export function laneMatrix(l: TlcLane, imgScale: number, k: number): number[] {
  const th = (l.angle * Math.PI) / 180;
  const dx = Math.sin(th);
  const dy = -Math.cos(th);
  const nx = Math.cos(th);
  const ny = Math.sin(th);
  const kk = k / imgScale;
  const ox = imgScale * l.x0;
  const oy = imgScale * l.y0;
  return [
    kk * nx,
    -kk * dx,
    kk * ny,
    -kk * dy,
    (k * l.width) / 2 - kk * (nx * ox + ny * oy),
    k * l.length + kk * (dx * ox + dy * oy),
  ];
}

export function tlcLaneRows(run: RunResult, order: string = TLC_ORDER): TlcLaneRow[] {
  return run.rows
    .map((r) => ({
      plate: r.plate_number,
      lane: tlcLane(r.container_id, order),
      half: tlcLane(r.container_id, order) < 27 ? 1 : 2,
      well: wellLabel(r.container_id),
      vial: r.container_id,
      reaction: r.global_index + 1,
      row: r,
    }))
    .sort((a, b) => a.plate - b.plate || a.lane - b.lane);
}

export function tlcLaneCsv(run: RunResult, order: string = TLC_ORDER): string {
  const benchNum = (v: any) =>
    Number.isFinite(+v) ? String(Number.parseFloat((+v).toPrecision(8))) : '';
  const codes = run.rows[0] ? run.rows[0].recipe.map((x) => x.code) : [];
  const rows = [
    [
      'plate',
      'tlc_lane',
      'tlc_half',
      'well',
      'robot_vial_index',
      'reaction',
      ...codes.map((c) => c + '_mM'),
      'solvent_uL',
    ],
  ];
  for (const x of tlcLaneRows(run, order)) {
    rows.push([
      String(x.plate),
      String(x.lane),
      String(x.half),
      x.well,
      String(x.vial),
      String(x.reaction),
      ...x.row.recipe.map((rc: any) => benchNum(rc.target_concentration)),
      benchNum(x.row['vol#solvent']),
    ]);
  }
  return csvText(rows);
}

// ---- Spots and Rf from a lane brightness profile ---------------------------------------------------------

// Center-weighted lane row sampling: isolates the central trajectory of the lane and
// applies a cosine window tapering to zero at the margins to suppress spillover from adjacent lanes.
export function computeLaneRowIntensity(
  rowData: Uint8ClampedArray | number[],
  width: number,
  channel: number,
  coreWidthFraction: number = 0.40
): number {
  if (width <= 0) return 0;
  const center = (width - 1) / 2;
  const halfSpan = Math.max(1, (width * coreWidthFraction) / 2);
  const x0 = Math.max(0, Math.floor(center - halfSpan));
  const x1 = Math.min(width - 1, Math.ceil(center + halfSpan));

  let sum = 0;
  let weightSum = 0;

  for (let x = x0; x <= x1; x++) {
    const dist = Math.abs(x - center);
    // Cosine taper: 1.0 at center, 0.0 at margins
    const weight = Math.cos((dist / halfSpan) * (Math.PI / 2));
    const val = rowData[x * 4 + channel] ?? 0;
    sum += val * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? sum / weightSum : 0;
}

// Shared off-screen scratch canvases for 2D full-RGB lane strip extraction & blank silica flat-fielding
let sharedLaneScratchCanvas: HTMLCanvasElement | null = null;
let sharedBlankScratchCanvas: HTMLCanvasElement | null = null;

export interface BlankSilicaEntry {
  name: string;
  bmp: ImageBitmap;
}

const blankSilicaRefs: Partial<Record<TlcChannelKey, BlankSilicaEntry>> = {};
let blankSilicaEnabled = true;
let blankSilicaVersion = 0;

let automiddleEnabled = false;
let automiddleVersion = 0;

export function setAutomiddleEnabled(enabled: boolean): void {
  if (automiddleEnabled !== enabled) {
    automiddleEnabled = enabled;
    automiddleVersion++;
  }
}

export function isAutomiddleEnabled(): boolean {
  return automiddleEnabled;
}

export function getAutomiddleSignature(): string {
  return `autoMid:${automiddleVersion}:${automiddleEnabled ? 'on' : 'off'}`;
}

export function setBlankSilicaRef(key: TlcChannelKey, entry: BlankSilicaEntry): void {
  blankSilicaRefs[key] = entry;
  blankSilicaVersion++;
}

export function clearBlankSilicaRef(key?: TlcChannelKey): void {
  if (key) {
    delete blankSilicaRefs[key];
  } else {
    delete blankSilicaRefs.UV254;
    delete blankSilicaRefs.UV366;
    delete blankSilicaRefs.White;
  }
  blankSilicaVersion++;
}

export function setBlankSilicaEnabled(enabled: boolean): void {
  if (blankSilicaEnabled !== enabled) {
    blankSilicaEnabled = enabled;
    blankSilicaVersion++;
  }
}

export function isBlankSilicaEnabled(): boolean {
  return blankSilicaEnabled;
}

export function getBlankSilicaMeta(): Partial<Record<TlcChannelKey, { name: string }>> {
  const out: Partial<Record<TlcChannelKey, { name: string }>> = {};
  for (const k of ['UV254', 'UV366', 'White'] as TlcChannelKey[]) {
    if (blankSilicaRefs[k]) out[k] = { name: blankSilicaRefs[k]!.name };
  }
  return out;
}

export function getBlankSilicaSignature(): string {
  const active = blankSilicaEnabled
    ? (['UV254', 'UV366', 'White'] as TlcChannelKey[])
        .filter((k) => Boolean(blankSilicaRefs[k]?.bmp))
        .map((k) => `${k}:${blankSilicaRefs[k]!.name}`)
        .join(',')
    : 'off';
  return `blank:${blankSilicaVersion}:${active}|${getAutomiddleSignature()}`;
}

/**
 * Helper to extract a raw W x L RGBA strip (Float32Array if unclipped .npy floatRgb is loaded,
 * otherwise Uint8ClampedArray via Canvas2D) for a given channel & lane.
 */
function extractRawChannelStrip(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  W: number,
  L: number
): Float32Array | Uint8ClampedArray | null {
  const im = set.imgs?.[key];
  if (!im) return null;

  // Prefer unclipped float32 radiance array directly from .npy when available
  if (im.floatRgb && im.floatWidth && im.floatHeight) {
    const imgScale = im.floatWidth / (set.frameW || LANE_FRAME_WIDTH);
    return sampleFloatRgbLaneStrip(im.floatRgb, im.floatWidth, im.floatHeight, lane, imgScale, W, L);
  }

  if (!im.bmp || typeof document === 'undefined') return null;
  if (!sharedLaneScratchCanvas) {
    sharedLaneScratchCanvas = document.createElement('canvas');
  }
  sharedLaneScratchCanvas.width = W;
  sharedLaneScratchCanvas.height = L;
  const ctx = sharedLaneScratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, L);
  const m = laneMatrix(lane, im.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(im.bmp, 0, 0);
  return ctx.getImageData(0, 0, W, L).data;
}

/**
 * Extracts a full-RGB 1D chromatographic profile AND caches 2D lateral strip metrics
 * (`lateralExcess`, `edgeRatio`, `coreRgb`, `bgRgb`, `offPlate`, `borderStraddle`, `automiddleOffsets`) on the TlcSet.
 * - Uses unclipped float32 sampling when a lab `.npy` image is loaded.
 * - Automatically skips duplicate blank-silica flat-fielding on pre-flat-fielded `uni_linint_corrected_*` images.
 * - Optionally follows curved/drifting lanes when `automiddleEnabled` is turned on.
 */
export function extractLaneProfile2d(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  const bSig = getBlankSilicaSignature();
  if ((set as any)._blankSig !== bSig) {
    if (set.imgs?.[key]?.bmp || set.imgs?.[key]?.floatRgb) {
      set.prof = {};
      (set as any)._prof2d = {};
    }
    (set as any)._blankSig = bSig;
  }

  const ck = `${key}:${lane.id}:${coreFraction.toFixed(2)}`;
  const cached2d = (set as any)._prof2d as Record<string, Lane2dMetrics> | undefined;
  if (set.prof && set.prof[ck] && (cached2d?.[ck] || (!set.imgs?.[key]?.bmp && !set.imgs?.[key]?.floatRgb))) {
    return set.prof[ck];
  }

  const im = set.imgs?.[key];
  if (!im || (!im.bmp && !im.floatRgb)) {
    return set.prof?.[ck] || [];
  }

  const W = Math.max(1, Math.round(lane.width));
  const L = Math.max(1, Math.round(lane.length));

  let stripRgba = extractRawChannelStrip(set, key, lane, W, L);
  if (!stripRgba) return set.prof?.[ck] || [];

  // Apply once-per-camera blank silica flat-field calibration when available & enabled,
  // EXCEPT on lab-calibrated `uni_linint_corrected_*` images (which are already flat-fielded!).
  const isPreFlatFielded = im.preFlatFielded ?? inspectLabTlcFilename(im.name).isPreFlatFielded;
  const blankRef = blankSilicaEnabled && !isPreFlatFielded ? blankSilicaRefs[key] : undefined;
  if (blankRef?.bmp && typeof document !== 'undefined') {
    if (!sharedBlankScratchCanvas) {
      sharedBlankScratchCanvas = document.createElement('canvas');
    }
    sharedBlankScratchCanvas.width = W;
    sharedBlankScratchCanvas.height = L;
    const bCtx = sharedBlankScratchCanvas.getContext('2d', { willReadFrequently: true });
    if (bCtx) {
      bCtx.setTransform(1, 0, 0, 1, 0, 0);
      bCtx.clearRect(0, 0, W, L);
      const bm = laneMatrix(lane, blankRef.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
      bCtx.setTransform(bm[0], bm[1], bm[2], bm[3], bm[4], bm[5]);
      bCtx.drawImage(blankRef.bmp, 0, 0);
      const blankData = bCtx.getImageData(0, 0, W, L);
      stripRgba = applyFlatFieldCorrection(stripRgba, blankData.data, W, L, key);
    }
  }

  const isPreRunProbe = Boolean((set as any)._isPreRunProbe);
  // Undeveloped plates have compact circular spots with zero elution bleed: use a wider core
  // fraction (60%) so ±1–2 mm horizontal box-placement error still captures every dot cleanly.
  const effCore = isPreRunProbe ? Math.max(coreFraction, 0.60) : coreFraction;

  // Optional curved-lane centerline tracking (savgol_automiddle) on real developed lanes (never on gutters or pre-run probes)
  let centerOffsets: Float32Array | undefined;
  if (automiddleEnabled && !isPreRunProbe && lane.id < 1000 && W >= 7 && L >= 24) {
    // Copy primary strip before optionally reading UV366 on the shared scratch canvas
    const primaryCopy = stripRgba instanceof Float32Array ? stripRgba : new Uint8ClampedArray(stripRgba);
    let uv366Strip: Float32Array | Uint8ClampedArray | undefined;
    if (key === 'UV254' && set.imgs?.UV366 && (set.imgs.UV366.floatRgb || set.imgs.UV366.bmp)) {
      uv366Strip = extractRawChannelStrip(set, 'UV366', lane, W, L) || undefined;
    }
    const approxOrigin =
      lane.zeroRf != null
        ? lane.zeroRf
        : set.originPx != null
        ? set.originPx
        : set.originAutoByLane?.[lane.id] ?? set.originAuto?.[tlcHalf(lane)] ?? Math.round(L * 0.08);
    centerOffsets = computeAutomiddleOffsets(primaryCopy, W, L, key, {
      uv366Rgba: uv366Strip,
      originPx: approxOrigin,
      spotRadiusPx: lane.spotRadius ?? Math.max(6, Math.round(L * 0.02)),
    });
    stripRgba = primaryCopy;
  }

  const { profile, metrics } = analyzeLaneStripRgb(
    stripRgba,
    W,
    L,
    key,
    effCore,
    lane.id >= 1000,
    centerOffsets
  );

  set.prof = set.prof || {};
  set.prof[ck] = profile;
  const map2d: Record<string, Lane2dMetrics> = ((set as any)._prof2d = (set as any)._prof2d || {});
  map2d[ck] = metrics;
  return profile;
}

/**
 * Returns cached 2D lateral strip metrics for a lane/channel (extracting on demand if a bitmap or floatRgb is loaded).
 */
export function getLane2dMetrics(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): Lane2dMetrics | undefined {
  const bSig = getBlankSilicaSignature();
  if ((set as any)._blankSig !== bSig && (set.imgs?.[key]?.bmp || set.imgs?.[key]?.floatRgb)) {
    set.prof = {};
    (set as any)._prof2d = {};
    (set as any)._blankSig = bSig;
  }
  const ck = `${key}:${lane.id}:${coreFraction.toFixed(2)}`;
  const map2d = (set as any)._prof2d as Record<string, Lane2dMetrics> | undefined;
  if (map2d?.[ck]) return map2d[ck];
  if (set.imgs?.[key]?.floatRgb || (set.imgs?.[key]?.bmp && typeof document !== 'undefined')) {
    extractLaneProfile2d(set, key, lane, coreFraction);
    return ((set as any)._prof2d as Record<string, Lane2dMetrics> | undefined)?.[ck];
  }
  return undefined;
}

/**
 * Returns already-cached 2D strip metrics for a lane/channel regardless of coreFraction,
 * falling back to default getLane2dMetrics extraction if a bitmap is loaded.
 */
function getCachedLane2dMetrics(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane
): Lane2dMetrics | undefined {
  const map2d = (set as any)._prof2d as Record<string, Lane2dMetrics> | undefined;
  if (map2d) {
    const exact = map2d[`${key}:${lane.id}:0.35`];
    if (exact) return exact;
    const prefix = `${key}:${lane.id}:`;
    for (const k in map2d) {
      if (k.startsWith(prefix)) return map2d[k];
    }
  }
  return getLane2dMetrics(set, key, lane);
}

// Moving average box filter for signal smoothing
export function movingAvg(a: number[], w: number): number[] {
  const h = w >> 1;
  const out = new Array(a.length);
  let s = 0;
  let n = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < a.length; i++) {
    while (hi < Math.min(a.length - 1, i + h)) {
      hi++;
      s += a[hi];
      n++;
    }
    while (lo < i - h) {
      s -= a[lo];
      lo++;
      n--;
    }
    out[i] = n > 0 ? s / n : a[i];
  }
  return out;
}

// Percentile calculation
export function pctile(a: ArrayLike<number>, p: number): number {
  if (!a.length) return 0;
  const b = Array.from(a).sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))];
}

function medianSortedBuf(buf: Float64Array, len: number): number {
  if (len <= 0) return 0;
  const view = buf.subarray(0, len);
  view.sort();
  const mid = len >> 1;
  return len % 2 === 1 ? view[mid] : 0.5 * (view[mid - 1] + view[mid]);
}

function windowQuantile(a: ArrayLike<number>, start: number, end: number, buf: Float64Array, q: number): number {
  const s = Math.max(0, start);
  const e = Math.min(a.length - 1, end);
  if (e < s) return 0;
  const span = e - s + 1;
  const step = span <= buf.length ? 1 : Math.ceil(span / buf.length);
  let k = 0;
  for (let i = s; i <= e && k < buf.length; i += step) {
    buf[k++] = a[i];
  }
  if (k <= 0) return 0;
  const view = buf.subarray(0, k);
  view.sort();
  return view[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))];
}

function windowMedian(a: ArrayLike<number>, start: number, end: number, buf: Float64Array): number {
  const s = Math.max(0, start);
  const e = Math.min(a.length - 1, end);
  if (e < s) return 0;
  const span = e - s + 1;
  const step = span <= buf.length ? 1 : Math.ceil(span / buf.length);
  let k = 0;
  for (let i = s; i <= e && k < buf.length; i += step) {
    buf[k++] = a[i];
  }
  return medianSortedBuf(buf, k);
}

function windowMean(a: ArrayLike<number>, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(a.length - 1, end);
  if (e < s) return 0;
  let sum = 0;
  for (let i = s; i <= e; i++) sum += a[i];
  return sum / (e - s + 1);
}

export interface FrontDetectionResult {
  pos: number;
  score: number;
}

const MIN_FRONT_SNR = 4.5;
const RIDGE_ONLY_FACTOR = 0.75;

/**
 * Computes a 256-bin grayscale intensity histogram over interior regions of one or more TLC
 * profiles (ideal for uniform Merck TLC Explorer illumination). Measures the clean silica
 * background mode, one-sided quiet background noise sigma (uncontaminated by spots), usable
 * contrast span, highlight/shadow clipping fractions, and bimodal Otsu wet-vs-dry separation.
 */
export function analyzeProfileHistogram(
  profiles: number[][],
  sign: number = -1,
  loFrac: number = 0.06,
  hiFrac: number = 0.94
): ProfileHistogramStats {
  const bins = new Uint32Array(256);
  let total = 0;

  for (const p of profiles) {
    const len = p?.length || 0;
    if (len < 6) continue;
    const s = Math.max(0, Math.floor(len * loFrac));
    const e = Math.min(len, Math.ceil(len * hiFrac));
    for (let i = s; i < e; i++) {
      const v = Math.max(0, Math.min(255, Math.round(p[i])));
      bins[v]++;
      total++;
    }
  }

  if (total < 8) {
    return {
      bgMode: sign < 0 ? 200 : 20,
      bgSigma: 2.0,
      contrastSpan: 100,
      sigTail: sign < 0 ? 100 : 120,
      clipLowFrac: 0,
      clipHighFrac: 0,
      otsuThresh: 0,
      otsuEta: 0,
      sampleCount: total,
    };
  }

  const clipLowFrac = (bins[0] + bins[1] + bins[2]) / total;
  const clipHighFrac = (bins[253] + bins[254] + bins[255]) / total;

  const cdfAt = (q: number): number => {
    const target = Math.max(1, Math.min(total, Math.round(q * total)));
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += bins[v];
      if (acc >= target) return v;
    }
    return 255;
  };

  // 5-bin triangular smoothing prevents single-bin quantization spikes from shifting the mode
  const sm = new Float64Array(256);
  const wKer = [1, 2, 3, 2, 1];
  for (let v = 0; v < 256; v++) {
    let ws = 0;
    let wt = 0;
    for (let k = -2; k <= 2; k++) {
      const idx = v + k;
      if (idx >= 0 && idx < 256) {
        const w = wKer[k + 2];
        ws += bins[idx] * w;
        wt += w;
      }
    }
    sm[v] = wt > 0 ? ws / wt : 0;
  }

  const p02 = cdfAt(0.02);
  const p30 = cdfAt(0.30);
  const p70 = cdfAt(0.70);
  const p98 = cdfAt(0.98);

  // Locate clean silica background mode on the background-dominant quantile band
  const mLo = sign < 0 ? Math.max(4, p30) : Math.max(3, p02);
  const mHi = sign < 0 ? Math.min(252, p98) : Math.min(251, p70);
  let bgMode = sign < 0 ? p70 : p30;
  let maxPeak = -1;
  for (let v = mLo; v <= mHi; v++) {
    if (sm[v] > maxPeak) {
      maxPeak = sm[v];
      bgMode = v;
    }
  }
  if (maxPeak <= 0) {
    for (let v = 0; v < 256; v++) {
      if (sm[v] > maxPeak) {
        maxPeak = sm[v];
        bgMode = v;
      }
    }
  }

  // Estimate silica noise sigma strictly on the non-spot (quiet) side of bgMode within ±16 bins
  // so spots, smears, and distant wet/dry shifts do not inflate background noise.
  let quietCount = 0;
  if (sign < 0) {
    const qHi = Math.min(253, bgMode + 16);
    for (let v = bgMode; v <= qHi; v++) quietCount += bins[v];
  } else {
    const qLo = Math.max(2, bgMode - 16);
    for (let v = qLo; v <= bgMode; v++) quietCount += bins[v];
  }

  let bgSigma = 1.5;
  if (quietCount >= 6) {
    const target = 0.6827 * quietCount;
    let acc = 0;
    let prevAcc = 0;
    let foundD = 0;
    for (let d = 0; d <= 16; d++) {
      const v = sign < 0 ? bgMode + d : bgMode - d;
      if (v < 2 || v > 253) break;
      prevAcc = acc;
      acc += bins[v];
      if (acc >= target) {
        const binW = Math.max(1, bins[v]);
        const frac = (target - prevAcc) / binW;
        foundD = d === 0 ? frac : d - 0.5 + frac;
        break;
      }
      foundD = d;
    }
    bgSigma = Math.max(0.4, Math.min(20.0, foundD));
  } else {
    // Fallback symmetric local MAD around bgMode when clipped at 0 or 255
    let symCount = 0;
    for (let d = 0; d <= 16; d++) {
      const vL = bgMode - d;
      const vR = bgMode + d;
      if (vL >= 0) symCount += bins[vL];
      if (d > 0 && vR <= 255) symCount += bins[vR];
    }
    if (symCount >= 6) {
      const target = 0.6827 * symCount;
      let acc = 0;
      let foundD = 0.8;
      for (let d = 0; d <= 16; d++) {
        if (d === 0) acc += bins[bgMode];
        else {
          if (bgMode - d >= 0) acc += bins[bgMode - d];
          if (bgMode + d <= 255) acc += bins[bgMode + d];
        }
        if (acc >= target) {
          foundD = Math.max(0.4, d);
          break;
        }
      }
      bgSigma = Math.min(20.0, foundD);
    }
  }

  const sigTail = sign < 0 ? p02 : p98;
  const contrastSpan = Math.max(0, sign < 0 ? bgMode - sigTail : sigTail - bgMode);

  // 1D Otsu between-class variance split (bimodality strength eta in [0, 1])
  let sumAll = 0;
  let sumSqAll = 0;
  for (let v = 0; v < 256; v++) {
    sumAll += v * bins[v];
    sumSqAll += v * v * bins[v];
  }
  const meanAll = sumAll / total;
  const totalVar = Math.max(0, sumSqAll / total - meanAll * meanAll);

  let wB = 0;
  let sumB = 0;
  let maxBetween = 0;
  let otsuThresh = Math.round(meanAll);
  for (let t = 0; t < 255; t++) {
    wB += bins[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * bins[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = (wB / total) * (wF / total) * (mB - mF) * (mB - mF);
    if (between > maxBetween) {
      maxBetween = between;
      otsuThresh = t;
    }
  }
  const otsuEta = totalVar > 1e-6 ? Math.min(1, maxBetween / totalVar) : 0;

  return {
    bgMode,
    bgSigma,
    contrastSpan,
    sigTail,
    clipLowFrac,
    clipHighFrac,
    otsuThresh,
    otsuEta,
    sampleCount: total,
  };
}

/**
 * Returns cached interior channel histogram statistics across all lanes of a TLC set.
 */
export function getChannelHistogram(
  set: TlcSet,
  key: TlcChannelKey,
  getProfile: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): ProfileHistogramStats | undefined {
  if (!set.cfg?.lanes?.length || !set.imgs?.[key]) return undefined;
  const sig = autoCacheSignature(set);
  if ((set as any)._autoCacheSig !== sig) {
    set.frontAuto = {};
    set.frontAutoByLane = {};
    set.originAuto = {};
    set.originAutoByLane = {};
    set.autoConf = {};
    (set as any)._histCache = {};
    (set as any)._prof2d = {};
    (set as any)._autoCacheSig = sig;
  }
  const cache: Record<string, ProfileHistogramStats> = ((set as any)._histCache =
    (set as any)._histCache || {});
  if (cache[key]) return cache[key];

  const profiles = set.cfg.lanes
    .map((l) => getProfile(set, key, l))
    .filter((p) => p && p.length >= 10);
  if (!profiles.length) return undefined;

  const stats = analyzeProfileHistogram(profiles, TLC_SIGNAL[key]?.sign ?? -1, 0.06, 0.94);
  cache[key] = stats;
  return stats;
}

// Detect solvent front from thin meniscus line (sharp local ridge) and/or persistent wet-vs-dry background step
// across 50%-96% of the lane. Returns { pos: 0, score: 0 } when no reliable front signal is found.
export function detectFrontDetailed(
  profile: number[],
  sign: number = 1,
  hist?: ProfileHistogramStats,
  maxHi?: number
): FrontDetectionResult {
  const n = profile.length;
  if (n < 20) return { pos: 0, score: 0 };

  const h = hist ?? analyzeProfileHistogram([profile], sign, 0.10, 0.95);
  const minStepAmp = h.sampleCount >= 16 ? Math.max(0.8, Math.min(1.5, 1.4 * h.bgSigma)) : 1.5;
  const minFeatFloor = h.sampleCount >= 16 ? Math.max(2.2, Math.min(5.0, 3.2 * h.bgSigma)) : 5.0;

  const s = movingAvg(profile, 3);
  const lo = Math.max(4, Math.floor(n * 0.50));
  const rawHi = Math.min(n - 4, Math.floor(n * 0.96));
  const hi = maxHi != null ? Math.min(rawHi, maxHi) : rawHi;
  const topLim = maxHi != null ? Math.min(n - 1, maxHi + 4) : n - 1;
  if (hi <= lo) return { pos: 0, score: 0 };

  const count = hi - lo + 1;
  const rCore = Math.max(0, Math.round(n * 0.0015));
  const tIn = Math.max(2, Math.round(n * 0.003));
  const tOut = tIn + Math.max(3, Math.round(n * 0.007));
  const mIn = tOut + 1;
  const mOut = mIn + Math.max(8, Math.round(n * 0.025));

  const bgNear = Math.max(3, Math.round(n * 0.008));
  const bgMid = Math.max(24, Math.round(n * 0.14));
  const bgFarLo = Math.max(36, Math.round(n * 0.22));
  const eWin = Math.max(2, Math.round(n * 0.006));

  // Estimate high-frequency noise on `s` via second differences within the search window
  const d2Arr = new Float64Array(Math.max(1, count - 2));
  let d2Count = 0;
  for (let i = lo + 1; i <= hi - 1; i++) {
    d2Arr[d2Count++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  // For 3-pt moving avg s, std(s[i+1] - 2s[i] + s[i-1]) = (2 / sqrt(3)) * sigma_s
  const sigmaMin = h.sampleCount >= 16 ? Math.max(0.5, Math.min(0.8, h.bgSigma)) : 0.8;
  const sigmaS = Math.max(sigmaMin, 1.4826 * medianSortedBuf(d2Arr, d2Count) * 0.866);

  const buf = new Float64Array(36);
  const feats = new Float64Array(count);
  let bestIdx = lo;
  let bestFeat = 0;
  let bestRank = 0;
  // Wet->dry background step moves brighter (+1) in UV254/White (sign=-1) and darker (-1) in UV366 (sign=+1)
  const dirSign = -Math.sign(sign || 1);

  for (let i = lo; i <= hi; i++) {
    // 1. Bilateral thin-line ridge response (suppresses spots and one-sided border cliffs)
    const c = windowMean(s, i - rCore, Math.min(topLim, i + rCore));
    const mLT = windowMean(s, i - tOut, i - tIn);
    const mRT = windowMean(s, Math.min(topLim, i + tIn), Math.min(topLim, i + tOut));
    const dL = sign * (c - mLT);
    const dR = sign * (c - mRT);

    let ridgeAmp = 0;
    if (dL > 1.0 && dR > 1.0 && Math.min(dL, dR) >= 0.30 * Math.max(dL, dR)) {
      const tightRidge = 0.7 * Math.min(dL, dR) + 0.3 * 0.5 * (dL + dR);
      const mLM = windowMedian(s, i - mOut, i - mIn, buf);
      let mRM = windowMedian(s, Math.min(topLim, i + mIn), Math.min(topLim, i + mOut), buf);
      // Near the far end of the lane (e.g. half-plate edge / midline divider), a dark gap or label strip
      // just beyond the dry front rim can drop into `i + mIn .. i + mOut` and invert `dRM`.
      if (i >= n * 0.78 && sign * (c - mRM) < 0.35 * dR) {
        const tailEnd = windowMean(s, Math.min(topLim, i + mOut - 4), Math.min(topLim, i + mOut + 12));
        if (sign * (tailEnd - mRT) > 2.0) {
          const shelf = windowQuantile(s, Math.min(topLim, i + mIn), Math.min(topLim, i + mOut), buf, sign < 0 ? 0.80 : 0.20);
          mRM = sign < 0 ? Math.max(mRT, shelf) : Math.min(mRT, shelf);
        }
      }
      const dLM = sign * (c - mLM);
      const dRM = sign * (c - mRM);
      if (dLM > 1.0 && dRM > 1.0 && Math.min(dLM, dRM) >= 0.25 * Math.max(dLM, dRM)) {
        const medRidge = 0.7 * Math.min(dLM, dRM) + 0.3 * 0.5 * (dLM + dRM);
        const sharpness = tightRidge / Math.max(tightRidge, medRidge, 1e-6);
        ridgeAmp = tightRidge * (sharpness * sharpness);
      }
    }

    // 2. Persistent wet-vs-dry background step across `i` (polarity-guarded against borders/glare/ink)
    let stepAmp = 0;
    if (i + bgNear <= topLim && i - bgNear >= 0) {
      const medAfter = windowMedian(s, i + bgNear, Math.min(topLim, i + bgMid), buf);
      const medBefore = windowMedian(s, Math.max(0, i - bgMid), i - bgNear, buf);
      const farBefore =
        i - Math.round(n * 0.06) >= 3
          ? windowMedian(s, Math.max(0, i - bgFarLo), i - Math.max(bgNear + 2, Math.round(n * 0.06)), buf)
          : medBefore;
      const edgeL = windowMean(s, Math.max(0, i - rCore - eWin), Math.max(0, i - rCore - 1));
      const edgeR = windowMean(s, Math.min(topLim, i + rCore + 1), Math.min(topLim, i + rCore + eWin));
      const macroDelta = medAfter - medBefore;
      const farDelta = medAfter - farBefore;
      const localDelta = edgeR - edgeL;
      if (
        macroDelta * dirSign > 0 &&
        farDelta * dirSign > 0 &&
        localDelta * dirSign > 0 &&
        Math.abs(macroDelta) >= 0.4 * Math.abs(farDelta)
      ) {
        stepAmp = Math.min(Math.abs(macroDelta), Math.abs(farDelta), Math.abs(localDelta));
      }
    }

    const feat = ridgeAmp + 0.65 * stepAmp;
    feats[i - lo] = feat;
    // A pencil line (or ink/scratch) is a thin ridge with no wet-vs-dry background change across it;
    // the real front has both. Down-weight ridge-only candidates when ranking against step-backed fronts.
    const rank = stepAmp >= minStepAmp ? feat : feat * RIDGE_ONLY_FACTOR;
    if (rank > bestRank) {
      bestRank = rank;
      bestFeat = feat;
      bestIdx = i;
    }
  }

  const featsSorted = new Float64Array(feats);
  const medFeat = medianSortedBuf(featsSorted, count);
  for (let j = 0; j < count; j++) featsSorted[j] = Math.abs(feats[j] - medFeat);
  const madFeat = 1.4826 * medianSortedBuf(featsSorted, count);

  const noiseFloor = Math.max(sigmaS, madFeat, Math.min(1.6, Math.max(0.5, h.bgSigma)));
  const snr = bestFeat / noiseFloor;
  if (snr < MIN_FRONT_SNR || bestFeat < minFeatFloor) {
    return { pos: 0, score: 0 };
  }
  return { pos: bestIdx, score: snr };
}

// Detect solvent front from meniscus line or persistent background step across 50%-97% of the lane
export function detectFront(profile: number[], sign: number = 1): number {
  return detectFrontDetailed(profile, sign).pos;
}

const MIN_ORIGIN_SNR = 3.5;

interface OriginCoreRefinement {
  pos: number;
  fwhm: number;
  coreMax: number;
  isTailing: boolean;
  backEdge50: number;
  bg: number;
}

interface OriginRefineOptions {
  metrics?: Lane2dMetrics;
  laneWidthPx?: number;
  plateMedianDiam?: number;
}

function refineOriginCoreDetailed(
  s: number[],
  idx: number,
  sign: number,
  opts?: OriginRefineOptions
): OriginCoreRefinement {
  const n = s.length;
  if (idx <= 2 || idx >= n - 3) {
    return { pos: idx, fwhm: 0, coreMax: 0, isTailing: false, backEdge50: idx, bg: s[idx] ?? 0 };
  }

  const flankIn = Math.max(6, Math.round(n * 0.024));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));
  const buf = new Float64Array(48);
  const mBelow = windowMedian(s, Math.max(0, idx - flankOut), Math.max(0, idx - flankIn), buf);
  const mAbove = windowMedian(s, Math.min(n - 1, idx + flankIn), Math.min(n - 1, idx + flankOut), buf);
  const bg0 = sign < 0 ? Math.max(mBelow, mAbove) : Math.min(mBelow, mAbove);

  const sig0 = (k: number) => Math.max(0, sign * (s[k] - bg0));
  const idxSig0 = sig0(idx);
  // Generous search radius (~5% of lane) so huge saturated circular dots are never clipped.
  const searchR = Math.max(14, Math.round(n * 0.050));

  // Walk backward/forward across the connected deposit core.
  // Stop backward walk if we cross a bright silica valley into a dark plate border.
  let loConn = idx;
  let coreMax0 = idxSig0;
  let minBackSig = idxSig0;
  while (loConn > Math.max(1, idx - searchR)) {
    const prevSig = sig0(loConn - 1);
    if (prevSig < 0.35 * idxSig0) break;
    // Only break on a deep valley (<42% peak, e.g., bright silica gap before a dark plate border)
    // so hollow "coffee-ring" origin halos (which dip to ~65-80% in the center) stay whole.
    if (minBackSig < 0.42 * coreMax0 && prevSig > minBackSig + Math.max(2.5, 0.06 * coreMax0)) break;
    loConn--;
    if (prevSig > coreMax0) coreMax0 = prevSig;
    if (prevSig < minBackSig) minBackSig = prevSig;
  }
  let hiConn = idx;
  while (hiConn < Math.min(n - 2, idx + searchR) && sig0(hiConn + 1) >= 0.35 * idxSig0) {
    hiConn++;
    const v = sig0(hiConn);
    if (v > coreMax0) coreMax0 = v;
  }

  // Recompute clean silica background strictly OUTSIDE the connected dot core so a huge dot's
  // own rim can never contaminate the background estimate.
  const bgGap = Math.max(3, Math.round(n * 0.008));
  const bgSpan = Math.max(8, Math.round(n * 0.024));
  const backBgA = Math.max(0, loConn - bgGap - bgSpan);
  const backBgB = Math.max(0, loConn - Math.min(bgGap, Math.max(1, loConn)));
  const fwdBgA = Math.min(n - 1, hiConn + bgGap);
  const fwdBgB = Math.min(n - 1, hiConn + bgGap + bgSpan);

  // Near the plate edge (loConn < 8% of lane), use a mild 65th/35th quantile behind loConn so a
  // nearby dark plate border cannot drag cleanBackBg down; elsewhere use the unbiased median so
  // noisy dark UV366 channels don't underestimate background on faint halos.
  const nearBorder = loConn < Math.max(24, Math.round(n * 0.08));
  let cleanBackBg = mBelow;
  if (backBgB >= backBgA) {
    const cnt = backBgB - backBgA + 1;
    const tmp = new Float64Array(cnt);
    for (let k = 0; k < cnt; k++) tmp[k] = s[backBgA + k];
    tmp.sort();
    const qFrac = nearBorder ? (sign < 0 ? 0.65 : 0.35) : 0.50;
    const qIdx = Math.max(0, Math.min(cnt - 1, Math.floor(cnt * qFrac)));
    cleanBackBg = tmp[qIdx];
  }
  const cleanFwdBg = fwdBgB >= fwdBgA ? windowMedian(s, fwdBgA, fwdBgB, buf) : mAbove;
  const bg =
    sign < 0
      ? Math.max(cleanBackBg, cleanFwdBg)
      : Math.min(cleanBackBg, cleanFwdBg);

  const sigAt = (k: number) => Math.max(0, sign * (s[k] - bg));
  let coreMax = 0;
  for (let k = loConn; k <= hiConn; k++) {
    const v = sigAt(k);
    if (v > coreMax) coreMax = v;
  }
  if (coreMax < 3.5) return { pos: idx, fwhm: 0, coreMax, isTailing: false, backEdge50: idx, bg };

  // Find the >=90% core plateau within [loConn .. hiConn].
  // Because solvent elutes strictly forward (+k), pLo (the back onset of the plateau) and
  // backEdge50/backEdge64 are ALWAYS crisp and un-smeared!
  let pLo = -1;
  let pHi = -1;
  for (let k = loConn; k <= hiConn; k++) {
    if (sigAt(k) >= 0.90 * coreMax) {
      if (pLo === -1) pLo = k;
      pHi = k;
    }
  }
  if (pLo === -1) {
    for (let k = loConn; k <= hiConn; k++) {
      if (sigAt(k) >= 0.85 * coreMax) {
        if (pLo === -1) pLo = k;
        pHi = k;
      }
    }
  }
  if (pLo === -1) {
    pLo = idx;
    pHi = idx;
  }

  const maxHalf = Math.max(16, Math.round(n * 0.055));
  const walkBackEdge = (start: number, thr: number): number => {
    let l = start;
    const minK = Math.max(0, start - maxHalf);
    let bestLow = sigAt(l);
    while (l > minK) {
      const nextV = sigAt(l - 1);
      if (nextV < thr) break;
      if (bestLow < 0.42 * coreMax && nextV > bestLow + Math.max(2.5, 0.06 * coreMax)) break;
      l--;
      if (nextV < bestLow) bestLow = nextV;
    }
    if (l > 0 && sigAt(l - 1) < thr && sigAt(l) >= thr) {
      const v0 = sigAt(l - 1);
      const v1 = sigAt(l);
      return l - (v1 - thr) / Math.max(1e-6, v1 - v0);
    }
    return l;
  };
  const walkFwdEdge = (start: number, thr: number): number => {
    let r = start;
    const maxK = Math.min(n - 1, start + maxHalf);
    while (r < maxK && sigAt(r + 1) >= thr) r++;
    if (r < n - 1 && sigAt(r + 1) < thr && sigAt(r) >= thr) {
      const v0 = sigAt(r);
      const v1 = sigAt(r + 1);
      return r + (v0 - thr) / Math.max(1e-6, v0 - v1);
    }
    return r;
  };

  const thr50 = 0.50 * coreMax;
  const thr64 = 0.64 * coreMax;
  const backEdge50 = walkBackEdge(pLo, thr50);
  const backEdge64 = walkBackEdge(pLo, thr64);
  const fwdEdge50 = walkFwdEdge(pHi, thr50);
  const fwdEdge64 = walkFwdEdge(pHi, thr64);

  const backSlope50 = Math.max(1.0, pLo - backEdge50);
  const fwdSlope50 = Math.max(1.0, fwdEdge50 - pHi);
  const backSlope64 = Math.max(0.8, pLo - backEdge64);
  const fwdSlope64 = Math.max(0.8, fwdEdge64 - pHi);

  // Measure sustained forward elution smear ahead of the clean back half of the core.
  const fwdProbeA = Math.min(n - 1, Math.round(pLo) + Math.max(12, Math.round(n * 0.024)));
  const fwdProbeB = Math.min(n - 1, fwdProbeA + Math.max(12, Math.round(n * 0.028)));
  const nearFwdMed = fwdProbeB >= fwdProbeA ? windowMedian(s, fwdProbeA, fwdProbeB, buf) : cleanFwdBg;
  const fwdTailSig = Math.max(0, sign * (nearFwdMed - bg));

  // Trim 1 (faint/moderate forward tail): solvent never elutes backward, so NEVER clamp
  // backEdge forward; trim ONLY an asymmetric forward slope tail beyond pHi.
  let usedFwd50 = fwdEdge50;
  let usedFwd64 = fwdEdge64;
  if (fwdSlope50 > 1.12 * backSlope50 + 0.5) {
    usedFwd50 = Math.min(usedFwd50, pHi + 1.10 * backSlope50 + 0.5);
  }
  if (fwdSlope64 > 1.12 * backSlope64 + 0.5) {
    usedFwd64 = Math.min(usedFwd64, pHi + 1.10 * backSlope64 + 0.5);
  }

  let isTailing =
    fwdTailSig > 0.20 * coreMax ||
    (fwdTailSig > 0.14 * coreMax && fwdSlope50 > 1.25 * backSlope50 + 2.5);

  // Trim 2 (heavy saturated comet tail where even pHi stretched forward):
  // Compare vertical span against the dot's 2D circular horizontal diameter (solvent elutes
  // vertically and does not widen the origin deposit sideways!).
  let cappedByCircular = false;
  if (opts?.metrics && opts.laneWidthPx && opts.laneWidthPx > 0) {
    const sw = opts.metrics.spotWidth;
    const swLo = Math.max(0, Math.round(backEdge50 + 1));
    const swHi = Math.min(
      sw.length - 1,
      Math.round(Math.min(hiConn, pLo + Math.max(6, backSlope50 * 1.6)))
    );
    let maxSw = 0;
    for (let k = swLo; k <= swHi; k++) {
      if (sw[k] > maxSw) maxSw = sw[k];
    }
    if (maxSw >= 0.12) {
      const dHorizPx = maxSw * (0.76 * opts.laneWidthPx);
      const diamFactor = maxSw >= 0.90 ? 1.18 : 1.08;
      const expectedVert50 = diamFactor * dHorizPx;
      if (
        dHorizPx >= 6 &&
        usedFwd50 - backEdge50 > 1.18 * expectedVert50 &&
        (fwdTailSig > 0.16 * coreMax || usedFwd50 - backEdge50 > 1.45 * dHorizPx)
      ) {
        usedFwd50 = Math.min(usedFwd50, backEdge50 + expectedVert50);
        usedFwd64 = Math.min(usedFwd64, backEdge64 + 0.92 * expectedVert50);
        isTailing = true;
        cappedByCircular = true;
      }
    }
  }

  // 1D-only fallback for heavy saturated comets when 2D metrics are unavailable.
  if (
    !cappedByCircular &&
    opts?.plateMedianDiam &&
    opts.plateMedianDiam >= 6 &&
    fwdTailSig > 0.30 * coreMax &&
    usedFwd50 - backEdge50 > Math.max(1.50 * opts.plateMedianDiam, 2.0 * backSlope50)
  ) {
    usedFwd50 = Math.min(usedFwd50, backEdge50 + 1.18 * opts.plateMedianDiam);
    usedFwd64 = Math.min(usedFwd64, backEdge64 + 1.05 * opts.plateMedianDiam);
    isTailing = true;
  }

  const mid50 = 0.5 * (backEdge50 + usedFwd50);
  const mid64 = 0.5 * (backEdge64 + usedFwd64);
  const fwhm = Math.max(0, usedFwd50 - backEdge50);

  let refinedFloat: number;
  if (isTailing) {
    refinedFloat = 0.55 * mid64 + 0.45 * mid50;
  } else {
    const lClamp = Math.max(0, Math.floor(backEdge64));
    const rClamp = Math.min(n - 1, Math.ceil(usedFwd64));
    let sumW = 0;
    let sumPos = 0;
    for (let k = lClamp; k <= rClamp; k++) {
      const w = Math.max(0, sigAt(k) - thr64);
      sumW += w;
      sumPos += k * w;
    }
    const centroid = sumW > 0 ? sumPos / sumW : mid64;
    refinedFloat = 0.50 * mid64 + 0.35 * mid50 + 0.15 * centroid;
  }

  const refined = Math.round(refinedFloat);
  if (Math.abs(refined - idx) > searchR || refined < 4 || refined >= n - 4) {
    return { pos: idx, fwhm, coreMax, isTailing, backEdge50, bg };
  }
  if (Math.abs(refined - idx) > Math.max(4, Math.round(n * 0.020))) {
    const aPath = Math.min(idx, refined);
    const bPath = Math.max(idx, refined);
    for (let k = aPath; k <= bPath; k++) {
      if (sigAt(k) < 0.22 * coreMax) return { pos: idx, fwhm, coreMax, isTailing, backEdge50, bg };
    }
  }
  return { pos: refined, fwhm, coreMax, isTailing, backEdge50, bg };
}

function refineOriginCoreCenter(
  s: number[],
  idx: number,
  sign: number,
  opts?: OriginRefineOptions
): number {
  return refineOriginCoreDetailed(s, idx, sign, opts).pos;
}

interface OriginCandidate extends FrontDetectionResult {
  feat: number;
  fwhm?: number;
  isTailing?: boolean;
}

// Detect up to `maxPeaks` separated compact deposit peaks in the lower 3%-25% of a lane.
function detectOriginCandidates(
  profile: number[],
  sign: number = -1,
  maxPeaks: number = 3,
  relaxed: boolean = false,
  histBgSigma?: number,
  refineOpts?: OriginRefineOptions
): OriginCandidate[] {
  const n = profile.length;
  if (n < 20) return [];

  const smWin = n >= 250 ? 5 : 3;
  const s = movingAvg(profile, smWin);
  const lo = Math.max(4, Math.floor(n * 0.055));
  const hi = Math.min(n - 5, Math.floor(n * 0.25));
  if (hi <= lo) return [];

  const rCore = Math.max(1, Math.round(n * 0.0025));
  const flankIn = Math.max(6, Math.round(n * 0.022));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));

  // Estimate high-frequency noise on `s` via second differences within lower 45% of lane
  const noiseEnd = Math.min(n - 2, Math.max(hi, Math.floor(n * 0.45)));
  const d2Arr = new Float64Array(Math.max(1, noiseEnd - lo));
  let d2Count = 0;
  for (let i = lo + 1; i <= noiseEnd - 1; i++) {
    d2Arr[d2Count++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  const d2Scale = smWin === 5 ? 1.0 : 0.866;
  const sigmaS = Math.max(0.8, 1.4826 * medianSortedBuf(d2Arr, d2Count) * d2Scale);

  const count = hi - lo + 1;
  const buf = new Float64Array(24);
  const feats = new Float64Array(count);

  for (let i = lo; i <= hi; i++) {
    if (i - flankIn < 1 || i + flankIn >= n - 1) continue;
    const c = windowMean(s, i - rCore, i + rCore);
    const mBelow = windowMedian(s, Math.max(0, i - flankOut), i - flankIn, buf);
    const mAbove = windowMedian(s, i + flankIn, Math.min(n - 1, i + flankOut), buf);
    const dBelow = sign * (c - mBelow);
    const dAbove = sign * (c - mAbove);

    let feat = 0;
    if (dBelow > 0 && dAbove > 0) {
      feat = 0.65 * Math.min(dBelow, dAbove) + 0.35 * 0.5 * (dBelow + dAbove);
    }
    feats[i - lo] = feat;
  }

  const featsSorted = new Float64Array(feats);
  const medFeat = medianSortedBuf(featsSorted, count);
  for (let j = 0; j < count; j++) featsSorted[j] = Math.abs(feats[j] - medFeat);
  const madFeat = 1.4826 * medianSortedBuf(featsSorted, count);
  const noiseFloor = Math.max(sigmaS, madFeat, histBgSigma != null ? Math.min(1.0, Math.max(0.55, histBgSigma)) : 1.0);

  const minCandFeat = relaxed
    ? histBgSigma != null
      ? Math.max(1.2, Math.min(1.8, 2.0 * histBgSigma))
      : 1.6
    : histBgSigma != null
    ? Math.max(1.8, Math.min(3.5, 2.4 * histBgSigma))
    : 3.0;
  const minCandSnr = relaxed ? 2.2 : MIN_ORIGIN_SNR;

  const localPeaks: Array<{ idx: number; feat: number }> = [];
  for (let i = lo; i <= hi; i++) {
    const f = feats[i - lo];
    if (f < minCandFeat || f / noiseFloor < minCandSnr) continue;
    const prev = i > lo ? feats[i - 1 - lo] : 0;
    const next = i < hi ? feats[i + 1 - lo] : 0;
    if (f >= prev && f >= next) {
      localPeaks.push({ idx: i, feat: f });
    }
  }
  localPeaks.sort((a, b) => b.feat - a.feat);

  const minSep = Math.max(12, Math.round(n * 0.04));
  const out: OriginCandidate[] = [];
  for (const pk of localPeaks) {
    if (out.some((kept) => Math.abs(kept.pos - pk.idx) < minSep)) continue;
    const ref = refineOriginCoreDetailed(s, pk.idx, sign, refineOpts);
    const pos = ref.pos;
    if (pos <= 0 || out.some((kept) => Math.abs(kept.pos - pos) < minSep)) continue;
    out.push({ pos, score: pk.feat / noiseFloor, feat: pk.feat, fwhm: ref.fwhm, isTailing: ref.isTailing });
    if (out.length >= maxPeaks) break;
  }
  return out;
}

// Detect spot origin from compact deposit peak in lower 3%-25% of the lane with bilateral silica contrast,
// rejecting monotonic dark plate borders and empty-lane noise.
export function detectOriginDetailed(
  profile: number[],
  sign: number = -1,
  hist?: ProfileHistogramStats
): FrontDetectionResult {
  const h = hist ?? analyzeProfileHistogram([profile], sign, 0.06, 0.90);
  const best = detectOriginCandidates(profile, sign, 1, false, h.sampleCount >= 16 ? h.bgSigma : undefined)[0];
  return best ? { pos: best.pos, score: best.score } : { pos: 0, score: 0 };
}

// Detect spot origin from baseline deposit peak in lower 3%-25% of the lane
export function detectOrigin(profile: number[], sign: number = -1): number {
  return detectOriginDetailed(profile, sign).pos;
}

export const tlcHalf = (lane: TlcLane): number => (lane.id < 27 ? 0 : 1);

export interface LaneBoundaryOccupancy {
  originOccupied: boolean;
  frontOccupied: boolean;
  originExcess: number; // 0..1 normalized excess above plate baseline
  frontExcess: number; // 0..1 normalized excess above plate meniscus
}

/**
 * Compares each lane's origin zone (Rf -0.01..0.055) and solvent-front zone (Rf 0.91..1.01)
 * against the quietest 25% of lanes on the same plate so compounds that sit on the baseline
 * or co-migrate into the solvent front are accounted for without mistaking uniform plate borders for spots.
 */
export function analyzeLaneBoundaryOccupancy(
  laneProfiles: Array<{ laneId: number; profile: number[]; origin: number; front: number; sign: number }>
): Map<number, LaneBoundaryOccupancy> {
  const out = new Map<number, LaneBoundaryOccupancy>();
  if (laneProfiles.length === 0) return out;

  interface RawBoundaryStat {
    laneId: number;
    originSig: number;
    frontSig: number;
    dynRange: number;
  }
  const stats: RawBoundaryStat[] = [];

  for (const item of laneProfiles) {
    const prof = item.profile;
    const n = prof.length;
    const span = item.front - item.origin;
    if (n < 20 || span < 20) continue;

    // Reference interior silica background (median of upper/lower quartiles in Rf 0.15..0.85)
    const intLo = Math.max(0, Math.round(item.origin + 0.12 * span));
    const intHi = Math.min(n - 1, Math.round(item.origin + 0.88 * span));
    const interior = prof.slice(intLo, intHi + 1);
    if (interior.length < 10) continue;
    const bgLevel = pctile(interior, item.sign < 0 ? 0.85 : 0.15);
    const quietSpan = Math.max(12, Math.abs(pctile(interior, 0.95) - pctile(interior, 0.05)));

    // Origin core window: [-0.015 .. +0.055] Rf
    const oStart = Math.max(0, Math.round(item.origin - Math.max(3, 0.015 * span)));
    const oEnd = Math.min(n - 1, Math.round(item.origin + Math.max(5, 0.055 * span)));
    let originPeak = 0;
    for (let i = oStart; i <= oEnd; i++) {
      const val = item.sign < 0 ? bgLevel - prof[i] : prof[i] - bgLevel;
      if (val > originPeak) originPeak = val;
    }

    // Solvent-front window: [0.91 .. 1.005] Rf (strictly inside/on meniscus, stopping before exterior dark border)
    const fStart = Math.max(0, Math.round(item.origin + 0.91 * span));
    const fEnd = Math.min(n - 1, Math.round(item.front + Math.max(2, 0.008 * span)));
    let frontPeak = 0;
    let frontSum = 0;
    let frontCnt = 0;
    for (let i = fStart; i <= fEnd; i++) {
      const val = Math.max(0, item.sign < 0 ? bgLevel - prof[i] : prof[i] - bgLevel);
      if (val > frontPeak) frontPeak = val;
      frontSum += val;
      frontCnt++;
    }
    const frontScore = 0.65 * frontPeak + 0.35 * (frontCnt > 0 ? frontSum / frontCnt : 0);

    stats.push({
      laneId: item.laneId,
      originSig: Math.max(0, originPeak),
      frontSig: Math.max(0, frontScore),
      dynRange: quietSpan,
    });
  }

  if (stats.length === 0) return out;

  // Baseline meniscus / blank-well origin mark estimated from quietest 25% of lanes (if >= 4 lanes)
  const originVals = stats.map((s) => s.originSig);
  const frontVals = stats.map((s) => s.frontSig);
  const refOrigin = stats.length >= 4 ? pctile(originVals, 0.25) : 0;
  const refFront = stats.length >= 4 ? pctile(frontVals, 0.25) : 0;
  const refNoise = stats.length >= 4 ? Math.max(6, pctile(frontVals, 0.35) - pctile(frontVals, 0.15)) : 8;

  for (const s of stats) {
    const oEx = Math.max(0, s.originSig - refOrigin);
    const fEx = Math.max(0, s.frontSig - refFront);
    const oThr = Math.max(12, 0.09 * s.dynRange, 1.8 * refNoise);
    const fThr = Math.max(10, 0.08 * s.dynRange, 1.8 * refNoise);
    out.set(s.laneId, {
      originOccupied: oEx >= oThr,
      frontOccupied: fEx >= fThr,
      originExcess: Math.min(1, +(oEx / Math.max(35, s.dynRange)).toFixed(3)),
      frontExcess: Math.min(1, +(fEx / Math.max(35, s.dynRange)).toFixed(3)),
    });
  }
  return out;
}

// Find spots in a lane profile using interior-clamped rolling percentile baseline, artifact guards, and prominence consolidation
export function findSpots(profile: number[], o: TlcProfileOptions): TlcSpot[] {
  const n = profile.length;
  if (n < 10) return [];
  const r = o.radius || 24;
  const span = Math.max(1, o.front - o.origin);
  const minProm = o.minProminence ?? 0.28;

  // Clamp outer plate bezels (< origin or > front) when smoothing chromatographic zone [origin, front]
  // so dark glass borders or outside background steps never bleed into near-origin or near-front peaks.
  const chromLo = Math.max(0, Math.round(o.origin));
  const chromHi = Math.min(n - 1, Math.round(o.front));
  const useChromClamp = chromHi - chromLo >= 20;
  const boundedProf = useChromClamp
    ? profile.map((v, i) => (i < chromLo ? profile[chromLo] : i > chromHi ? profile[chromHi] : v))
    : profile;

  const smWin = span < 450 ? 5 : 7;
  const sm1 = movingAvg(boundedProf, smWin);

  // Origin buffer: scale cleanly with lane span (~1.8% Rf, min 3 px) so high-res ~900px lanes clear
  // the origin dot radius while still resolving polar products from Rf ~0.025 upwards.
  const originBuffer = Math.max(
    3,
    Math.min(
      Math.round(0.022 * span),
      Math.max(Math.round(r * 0.20), Math.round(0.018 * span))
    )
  );

  // Restrict rolling baseline estimation strictly to chromatographic interior [origin + originBuffer, front]
  // so dark outer plate borders (< origin or > front) do not drag the baseline down near Rf ~0.04 or Rf ~0.95.
  const baseLo = Math.max(0, Math.round(o.origin + originBuffer));
  const baseHi = Math.min(n - 1, Math.round(o.front));
  const useRestrictedBase = baseHi - baseLo >= 16;

  const step = 5;
  // Scale rolling baseline half-window with span (~28% Rf, min 100 px) so a broad low-Rf doublet
  // (~120-180 px tall on a 900 px high-res camera lane) never traps the 90th-percentile baseline
  // inside dark spots and inverts/erases the lower spot.
  const win = Math.max(100, Math.round(0.28 * span));
  const base = new Array(n);
  const q = o.sign < 0 ? 0.9 : 0.1;
  const pts: [number, number][] = [];

  const effStart = useRestrictedBase ? baseLo : 0;
  const effEnd = useRestrictedBase ? baseHi : n - 1;

  for (let i = 0; i < n; i += step) {
    const cStart = Math.max(effStart, i - win);
    const cEnd = Math.min(effEnd, i + win);
    const sliceLo = cStart <= cEnd ? cStart : effStart;
    const sliceHi = cStart <= cEnd ? cEnd : effEnd;
    const chunk = sm1.slice(sliceLo, sliceHi + 1);
    pts.push([i, chunk.length > 0 ? pctile(chunk, q) : sm1[Math.min(n - 1, Math.max(0, i))]]);
  }
  pts.push([n - 1, pts[pts.length - 1][1]]);

  for (let j = 0, i = 0; i < n; i++) {
    while (j < pts.length - 2 && pts[j + 1][0] < i) j++;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    base[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
  }

  // Raw baseline-subtracted signal (zero outside [origin - 2, front] so outer steps don't bleed in)
  const rawDiff = sm1.map((v, i) => {
    if (useChromClamp && (i < chromLo - 1 || i > chromHi)) return 0;
    return o.sign < 0 ? base[i] - v : v - base[i];
  });

  // Continuous sensitivity: t = 0 (most sensitive, slider 8%) .. 1 (most merging, slider 70%).
  // Scale smoothing width gently with lane span and keep sensitivity high enough that peaks
  // visible in the 7px densitogram are not flattened before basin consolidation.
  const t = Math.min(1, Math.max(0, (minProm - 0.08) / 0.62));
  const spanScale = Math.min(1, Math.max(0.52, span / 520));
  const smoothHalf = Math.max(1, Math.round((1.0 + 5.2 * t) * spanScale));
  const d = movingAvg(rawDiff, smoothHalf * 2 + 1);

  const start = Math.round(o.origin + originBuffer);

  // Front buffer: extend reach up to Rf ~0.988 so fast nonpolar spots right before the solvent front are still detected
  const end = Math.round(o.origin + Math.min(span - 2, 0.988 * span));

  if (end <= start) return [];

  // Never mark spots on lanes sitting completely off the silica glass (pitch-black surround)
  // or straddling the vertical glass cut edge (where 1px edge wobble produces bogus ripple spots).
  if (o.lane2d?.offPlate || o.lane2d?.borderStraddle) return [];

  // Compute baseline noise & physical signal range specifically within the chromatographic migration window (chrom)
  const chrom = d.slice(Math.max(start, 0), Math.min(n, end));
  const dmax = chrom.length > 0 ? Math.max(...chrom, 1e-9) : Math.max(...d, 1e-9);
  const med = chrom.length > 0 ? pctile(chrom, 0.5) : pctile(d, 0.5);
  const rawMadNoise = chrom.length > 0
    ? 1.4826 * pctile(chrom.map((v) => Math.abs(v - med)), 0.5)
    : 1.4826 * pctile(d.map((v) => Math.abs(v - med)), 0.5);

  const profSlice = profile.slice(Math.max(0, start), Math.min(n, end));
  // 1D off-plate guard for UV254/White (bright-silica channels): pure pitch-black surround has no silica
  if (o.sign < 0 && profSlice.length >= 10 && pctile(profSlice, 0.80) < 35) return [];

  const dynSpan = profSlice.length > 4
    ? Math.abs(pctile(profSlice, 0.98) - pctile(profSlice, 0.02))
    : 100;
  const h = o.plateHistogram ?? analyzeProfileHistogram([profSlice], o.sign, 0, 1);
  // Prevent busy lanes (spots covering 35-60% of the lane) from inflating MAD noise into tens of counts;
  // quiet-side histogram bgSigma directly measures background noise uncontaminated by spots.
  const noise = h.sampleCount >= 16
    ? Math.min(rawMadNoise, Math.max(0.5, 1.35 * h.bgSigma))
    : rawMadNoise;
  // Histogram-calibrated physical minimum floor:
  // - On bright-silica channels (UV254/White, sign < 0), require a human-visible contrast floor so
  //   camera compression / silica grain (2-5 units on a 240-green plate) never triggers phantom spots.
  // - On dark-background UV366 (sign > 0), keep sensitive down to ~2.0 units for faint fluorophores.
  const histFloor =
    o.sign < 0
      ? h.sampleCount >= 8
        ? Math.max(4.0, 3.2 * h.bgSigma, 0.034 * h.contrastSpan)
        : 5.5
      : h.sampleCount >= 8
      ? Math.max(2.0, 2.8 * h.bgSigma, 0.016 * h.contrastSpan)
      : 4.5;
  const minAbsFloor = Math.max(histFloor, (o.sign < 0 ? 0.030 : 0.018) * dynSpan);

  // Robust chromatographic signal threshold
  const thr = Math.max(2.6 * noise, 0.035 * dmax, minAbsFloor);

  // Precompute lightly-smoothed 2D hourglass curves (rowMass & lateral spotWidth) when available
  const hasHourglass2d = Boolean(
    o.lane2d?.rowMass &&
      o.lane2d?.spotWidth &&
      o.lane2d.rowMass.length === n &&
      o.lane2d.spotWidth.length === n
  );
  const m2d = hasHourglass2d
    ? movingAvg(
        Array.from(o.lane2d!.rowMass!, (v, i) => (useChromClamp && (i < chromLo - 1 || i > chromHi) ? 0 : v)),
        5
      )
    : null;
  const w2d = hasHourglass2d
    ? movingAvg(
        Array.from(o.lane2d!.spotWidth!, (v, i) => (useChromClamp && (i < chromLo - 1 || i > chromHi) ? 0 : v)),
        5
      )
    : null;

  // 1. Initial Candidate Peaks via local maximum search
  const halfWin = Math.max(3, Math.round(r * (0.14 + 0.38 * t)));

  const candidates: Array<{ pos: number; val: number; extentStart: number; extentEnd: number }> = [];

  for (let i = Math.max(start, 1); i < Math.min(end, n - 1); i++) {
    if (d[i] < thr) continue;
    if (d[i] < d[i - 1] || d[i] < d[i + 1]) continue;
    let top = true;
    for (let k = Math.max(start, i - halfWin); k <= Math.min(end, i + halfWin); k++) {
      if (d[k] > d[i] || (d[k] === d[i] && k < i)) {
        top = false;
        break;
      }
    }
    if (top) {
      candidates.push({
        pos: i,
        val: d[i],
        extentStart: Math.max(start, i - halfWin),
        extentEnd: Math.min(end, i + halfWin),
      });
    }
  }

  // 1b. 2D Hourglass Doublet Lobe Rescue (Sensitive & Standard modes only, t < 0.72):
  //     When two dark circular/oval spots overlap closely (figure-8 silhouette), double 1D smoothing can
  //     smear across their lighter middle waist, hiding the secondary lobe from the 1D local-max scan.
  //     Scanning the 2D cross-lane integrated spot mass (m2d) rescues genuine bimodal lobes while
  //     ignoring monotonic streaks/tails and faint noise.
  if (hasHourglass2d && m2d && w2d && t < 0.72) {
    const mHalfWin = Math.max(3, Math.round(halfWin * 0.85));
    const minSepFromExisting = Math.max(5, Math.round(halfWin * 0.85));
    const minPairSep = Math.max(7, Math.round(0.022 * span));
    const maxPairSep = Math.max(24, Math.round(0.20 * span));
    const rescued: Array<{ pos: number; val: number; extentStart: number; extentEnd: number }> = [];

    for (let i = Math.max(start, 1); i < Math.min(end, n - 1); i++) {
      const peakAmp = Math.max(d[i], rawDiff[i]);
      if (peakAmp < Math.max(thr * 1.6, 22)) continue;
      if (m2d[i] < Math.max(12, 0.12 * dmax)) continue;
      if (m2d[i] < m2d[i - 1] || m2d[i] < m2d[i + 1]) continue;

      let mTop = true;
      for (let k = Math.max(start, i - mHalfWin); k <= Math.min(end, i + mHalfWin); k++) {
        if (m2d[k] > m2d[i] || (m2d[k] === m2d[i] && k < i)) {
          mTop = false;
          break;
        }
      }
      if (!mTop) continue;
      if (candidates.some((c) => Math.abs(c.pos - i) < minSepFromExisting)) continue;
      if (rescued.some((c) => Math.abs(c.pos - i) < minSepFromExisting)) continue;

      // Require a neighboring strong candidate separated by a genuine 2D hourglass waist
      let confirmedHourglass = false;
      for (const c of candidates) {
        const pairDist = Math.abs(c.pos - i);
        if (pairDist < minPairSep || pairDist > maxPairSep) continue;
        const lo = Math.min(c.pos, i);
        const hi = Math.max(c.pos, i);
        let mVMin = Infinity;
        let wVMin = Infinity;
        let rawVMin = Infinity;
        for (let k = lo; k <= hi; k++) {
          if (m2d[k] < mVMin) mVMin = m2d[k];
          if (w2d[k] < wVMin) wVMin = w2d[k];
          if (rawDiff[k] < rawVMin) rawVMin = rawDiff[k];
        }
        const mLower = Math.min(m2d[lo], m2d[hi]);
        const wLower = Math.min(w2d[lo], w2d[hi]);
        const rawLower = Math.min(rawDiff[lo], rawDiff[hi]);
        const mDrop = mLower > 0 ? (mLower - mVMin) / mLower : 0;
        const wPinch = wLower > 0 ? (wLower - wVMin) / wLower : 0;
        const rawDrop = rawLower - rawVMin;
        if (mDrop >= 0.10 + 0.12 * t && (rawDrop >= Math.max(4.5, 2.4 * noise) || wPinch >= 0.10 + 0.10 * t)) {
          confirmedHourglass = true;
          break;
        }
      }
      if (confirmedHourglass) {
        rescued.push({
          pos: i,
          val: peakAmp,
          extentStart: Math.max(start, i - mHalfWin),
          extentEnd: Math.min(end, i + mHalfWin),
        });
      }
    }

    // Also handle low-Rf spots that sit right on/touching the origin (Rf ~0.025..0.055) below a
    // distinct lighter waist and upper spot: unlike a decaying origin tail (which plunges >55% by
    // Rf ~0.035), a real saturated low-Rf spot maintains >=82% of origin darkness out to Rf ~0.035..0.05
    // before dropping cleanly into the lighter waist between the two spots.
    const firstCand = [...candidates, ...rescued].sort((a, b) => a.pos - b.pos)[0];
    const originAnchor = Math.max(0, Math.min(n - 1, Math.round(o.origin)));
    const originSig = Math.max(rawDiff[originAnchor], d[originAnchor], rawDiff[Math.min(n - 1, originAnchor + 2)]);
    const shelfLo = Math.max(start + 2, Math.round(o.origin + Math.max(8, 0.025 * span)));
    const shelfHi = Math.min(end - 2, Math.round(o.origin + Math.max(18, 0.065 * span)));
    if (
      firstCand &&
      firstCand.pos > shelfHi + 4 &&
      firstCand.pos <= o.origin + Math.max(32, Math.round(0.22 * span)) &&
      originSig >= 55 &&
      !candidates.some((c) => c.pos <= shelfHi + 3) &&
      !rescued.some((c) => c.pos <= shelfHi + 3)
    ) {
      let bestShelfPos = -1;
      let bestShelfVal = -Infinity;
      for (let k = shelfLo; k <= Math.min(shelfHi, firstCand.pos - 6); k++) {
        const sVal = rawDiff[k];
        if (sVal >= Math.max(55, 0.82 * originSig) && sVal >= bestShelfVal - 2) {
          // Prefer the outermost position still at >=82% of origin darkness (core of the low-Rf lobe)
          bestShelfPos = k;
          if (sVal > bestShelfVal) bestShelfVal = sVal;
        }
      }
      if (bestShelfPos >= shelfLo) {
        let rawVMin = Infinity;
        let mVMin = Infinity;
        for (let k = bestShelfPos; k <= firstCand.pos; k++) {
          if (rawDiff[k] < rawVMin) rawVMin = rawDiff[k];
          if (m2d[k] < mVMin) mVMin = m2d[k];
        }
        const upperAmp = Math.max(rawDiff[firstCand.pos], d[firstCand.pos]);
        const lowerAmp = Math.min(bestShelfVal, upperAmp);
        const waistDrop = lowerAmp - rawVMin;
        const mLower = Math.min(m2d[bestShelfPos], m2d[firstCand.pos]);
        const mDrop = mLower > 0 ? (mLower - mVMin) / mLower : 0;
        if (waistDrop >= Math.max(8, 3.5 * noise) && mDrop >= 0.065 + 0.10 * t) {
          rescued.push({
            pos: bestShelfPos,
            val: Math.max(d[bestShelfPos], bestShelfVal),
            extentStart: Math.max(start, bestShelfPos - mHalfWin),
            extentEnd: Math.min(end, bestShelfPos + mHalfWin),
          });
        }
      }
    }

    if (rescued.length > 0) {
      candidates.push(...rescued);
      candidates.sort((a, b) => a.pos - b.pos);
    }
  }

  // Failsafe Artifact Rejection Filters:
  // (a) Reject single-pixel dust specks (< 3 raw px persistence + smoothed support check)
  // (b) Near-origin: require clear chromatographic valley from o.origin (not an uneluted/tailing origin dot)
  // (c) Near-front (Rf >= 0.88): reject monotonic ramps climbing into dark plate borders/meniscus past o.front,
  //     and require a genuine left chromatographic valley separating the spot from baseline noise
  // (d) Interior: require bilateral local prominence on both sides so gentle illumination gradients don't trigger
  const nearOriginLimit = o.origin + Math.max(Math.round(0.055 * span), Math.round(r * 1.15));
  const originCoreStart = Math.max(0, Math.round(o.origin - 1));
  const nearFrontLimit = o.origin + Math.min(Math.round(0.90 * span), span - Math.max(6, Math.round(r * 0.45)));
  const frontCoreEnd = Math.min(n - 1, Math.round(o.front + Math.max(6, r * 0.35)));
  const flankRadius = Math.max(halfWin * 2, Math.round(0.10 * span));

  const hasLane2d = Boolean(o.lane2d && o.lane2d.lateralExcess.length === n && o.lane2d.edgeRatio.length === n);

  const filteredCandidates = candidates.filter((p) => {
    // (a0) 2D lateral verification (when 2D strip metrics are available):
    //      Rejects horizontal illumination/meniscus bands (spanning center + both flanks equally)
    //      and adjacent-lane spillover peaking at the outer lane edge, while preserving real
    //      centered spots even beside an identical co-migrating neighbor.
    if (hasLane2d && o.lane2d) {
      const l2Lo = Math.max(0, p.pos - 2);
      const l2Hi = Math.min(n - 1, p.pos + 2);
      let maxLat = -Infinity;
      let minEdge = Infinity;
      for (let k = l2Lo; k <= l2Hi; k++) {
        if (o.lane2d.lateralExcess[k] > maxLat) maxLat = o.lane2d.lateralExcess[k];
        if (o.lane2d.edgeRatio[k] < minEdge) minEdge = o.lane2d.edgeRatio[k];
      }
      // Adjacent-lane spillover: outer flank deviates much more than lane center on a weak invading shoulder
      if (minEdge > 1.55 && p.val < 42 && maxLat < Math.max(2.5, 0.25 * p.val)) {
        return false;
      }
      // Low-contrast horizontal illumination / wetness band: spans center + both flanks equally.
      // Strong dark UV-quenching / stained spots (p.val >= 38) are NEVER erased even when adjacent
      // HTE wells coalesce into a wide band touching both flanks of an interior lane.
      if (p.val < 38 && maxLat < Math.max(1.8, 0.16 * p.val)) {
        return false;
      }
    }

    // (a1) Raw pixel persistence check: a genuine chromatographic band spans >= 3 raw pixels,
    //      whereas dead pixels or dust specks are only 1-2 pixels wide even at extreme amplitude.
    const rWinLo = Math.max(Math.round(o.origin + 1), p.pos - 6);
    const rWinHi = Math.min(Math.round(o.front), p.pos + 6);
    let rawMaxDev = 0;
    for (let k = rWinLo; k <= rWinHi; k++) {
      const dev = o.sign < 0 ? base[k] - profile[k] : profile[k] - base[k];
      if (dev > rawMaxDev) rawMaxDev = dev;
    }
    const rawCut = Math.max(minAbsFloor * 0.65, 0.30 * rawMaxDev);
    let rawSupport = 0;
    for (let k = rWinLo; k <= rWinHi; k++) {
      const dev = o.sign < 0 ? base[k] - profile[k] : profile[k] - base[k];
      if (dev >= rawCut) rawSupport++;
    }
    if (rawSupport < 3) return false;

    // (a2) Smoothed half-height width check
    const halfHeight = med + 0.45 * (p.val - med);
    let supportPx = 0;
    for (let k = Math.max(start, p.pos - 4); k <= Math.min(end, p.pos + 4); k++) {
      if (d[k] >= halfHeight) supportPx++;
    }
    if (supportPx < 3 && p.val < Math.max(12, 5 * noise)) return false;

    // (b) Near-origin guard
    if (p.pos < nearOriginLimit) {
      const originCoreEnd = Math.min(p.pos - 1, Math.round(o.origin + originBuffer));
      if (originCoreEnd >= originCoreStart) {
        let originPeak = -Infinity;
        let originPeakIdx = originCoreStart;
        for (let k = originCoreStart; k <= originCoreEnd; k++) {
          if (d[k] > originPeak) {
            originPeak = d[k];
            originPeakIdx = k;
          }
        }
        // A monotonically decaying origin tail can never grow darker than the origin itself;
        // preserve low-Rf compounds that rise above originPeak OR form a full-darkness lobe (>=82%
        // of originPeak at Rf >=0.025) followed immediately by a sharp waist drop into an upper spot.
        const darkerThanOrigin = Math.max(p.val, rawDiff[p.pos]) >= originPeak + Math.max(2.0, noise);
        let strongLowRfLobe = false;
        if (
          !darkerThanOrigin &&
          hasHourglass2d &&
          p.pos >= o.origin + Math.max(8, Math.round(0.025 * span)) &&
          Math.max(p.val, rawDiff[p.pos]) >= Math.max(55, 0.82 * originPeak)
        ) {
          const lookHi = Math.min(end, p.pos + Math.max(14, Math.round(0.06 * span)));
          let afterMin = Infinity;
          for (let k = p.pos + 1; k <= lookHi; k++) {
            if (rawDiff[k] < afterMin) afterMin = rawDiff[k];
          }
          if (Math.max(p.val, rawDiff[p.pos]) - afterMin >= Math.max(12, 4 * noise)) {
            strongLowRfLobe = true;
          }
        }
        if (!darkerThanOrigin && !strongLowRfLobe && originPeak >= Math.max(thr, 0.45 * p.val)) {
          let valleyMin = Infinity;
          for (let k = originPeakIdx; k <= p.pos; k++) {
            if (d[k] < valleyMin) valleyMin = d[k];
          }
          const valleyDrop = p.val - valleyMin;
          const minOriginDrop = 0.14 + 0.22 * t;
          if (valleyDrop < Math.max(minOriginDrop * p.val, 2.5 * noise)) return false;
        }
      }
    }

    // (c) Near-front guard against exterior plate border & solvent-front meniscus artifacts
    if (p.pos >= nearFrontLimit) {
      // Check left chromatographic valley
      const lStart = Math.max(start, p.pos - flankRadius);
      let leftMin = Infinity;
      for (let k = lStart; k < p.pos; k++) {
        if (d[k] < leftMin) leftMin = d[k];
      }
      const leftDrop = p.val - leftMin;
      const minFrontDrop = 0.15 + 0.24 * t;
      if (leftDrop < Math.max(minFrontDrop * p.val, 2.6 * noise, minAbsFloor * 0.7)) {
        return false;
      }

      // Check raw profile at front edge: reject peaks sitting on a dark solvent-front meniscus or
      // dark glass cut gap that stays dark right into o.front without dipping cleanly back to silica.
      const outStart = Math.min(n - 1, Math.round(o.front + 2));
      if (p.pos > o.origin + 0.93 * span) {
        const refBase = base[chromHi];
        let minInsideDev = Infinity;
        for (let k = p.pos; k <= chromHi; k++) {
          const dev = o.sign < 0 ? refBase - profile[k] : profile[k] - refBase;
          if (dev < minInsideDev) minInsideDev = dev;
        }
        if (frontCoreEnd > outStart) {
          let outMaxDev = -Infinity;
          for (let k = outStart; k <= frontCoreEnd; k++) {
            const dev = o.sign < 0 ? refBase - profile[k] : profile[k] - refBase;
            if (dev > outMaxDev) outMaxDev = dev;
          }
          if (outMaxDev >= p.val * 0.65 && p.val - minInsideDev < Math.max(0.32 * p.val, 2.5 * noise)) {
            return false;
          }
        }
        // Full-width horizontal meniscus ridge pressed directly against the solvent front (Rf >= 0.94)
        if (hasLane2d && o.lane2d && p.pos >= o.origin + 0.94 * span) {
          const l2Lo = Math.max(0, p.pos - 2);
          const l2Hi = Math.min(n - 1, p.pos + 2);
          let maxLat = -Infinity;
          for (let k = l2Lo; k <= l2Hi; k++) {
            if (o.lane2d.lateralExcess[k] > maxLat) maxLat = o.lane2d.lateralExcess[k];
          }
          if (maxLat < Math.max(2.5, 0.14 * p.val) && p.val - minInsideDev < Math.max(0.45 * p.val, 3 * noise)) {
            return false;
          }
        }
      }
      return true;
    }

    // (d) Interior bilateral prominence check: avoid gentle illumination gradients
    if (p.pos >= nearOriginLimit) {
      const lStart = Math.max(start, p.pos - flankRadius);
      const rEnd = Math.min(end, p.pos + flankRadius);
      let lMin = Infinity;
      let rMin = Infinity;
      for (let k = lStart; k < p.pos; k++) {
        if (d[k] < lMin) lMin = d[k];
      }
      for (let k = p.pos + 1; k <= rEnd; k++) {
        if (d[k] < rMin) rMin = d[k];
      }
      const bilatProm = Math.min(p.val - lMin, p.val - rMin);
      if (bilatProm < Math.max(2.2 * noise, minAbsFloor * 0.55)) {
        return false;
      }
    }

    return true;
  });

  if (filteredCandidates.length === 0) return [];

  // 2. Iterative Chromatographic Basin & Prominence Consolidation
  // In chromatography, two peaks in the same continuous band only represent separate compounds
  // if the valley drops significantly towards baseline (achieving chromatographic resolution),
  // OR if 2D hourglass silhouette analysis confirms two touching round/oval spots getting lighter
  // and pinching narrower in the middle (figure-8 doublet, NOT a monotonic streak or flat dome).
  let merged = [...filteredCandidates];
  let changed = true;
  let iterations = 0;

  while (changed && merged.length > 1 && iterations < 30) {
    changed = false;
    iterations++;
    let bestPairIdx = -1;
    let minValleyRatio = 1.0;

    for (let i = 0; i < merged.length - 1; i++) {
      const p1 = merged[i];
      const p2 = merged[i + 1];
      const dist = p2.pos - p1.pos;

      // Minimum valley signal between the two peaks
      let vMin = Infinity;
      for (let k = p1.pos; k <= p2.pos; k++) {
        if (d[k] < vMin) vMin = d[k];
      }

      const lowerVal = Math.min(p1.val, p2.val);
      const valleyDrop = lowerVal - vMin;
      const dropRatio = lowerVal > 0 ? valleyDrop / lowerVal : 0;

      // 2D Hourglass Doublet check (Sensitive & Standard modes, t < 0.72):
      // Two strong touching spots get visibly lighter in the middle AND pinch inward in 2D mass/width.
      let isHourglassDoublet = false;
      if (
        hasHourglass2d &&
        m2d &&
        w2d &&
        t < 0.72 &&
        dist >= Math.max(7, Math.round(0.022 * span)) &&
        lowerVal >= Math.max(thr * 1.7, 20)
      ) {
        let rawVMin = Infinity;
        let mVMin = Infinity;
        let wVMin = Infinity;
        for (let k = p1.pos; k <= p2.pos; k++) {
          if (rawDiff[k] < rawVMin) rawVMin = rawDiff[k];
          if (m2d[k] < mVMin) mVMin = m2d[k];
          if (w2d[k] < wVMin) wVMin = w2d[k];
        }
        const rawLower = Math.min(rawDiff[p1.pos], rawDiff[p2.pos]);
        const rawDrop = rawLower - rawVMin;
        const rawDropRatio = rawLower > 0 ? rawDrop / rawLower : 0;

        const mLower = Math.min(m2d[p1.pos], m2d[p2.pos]);
        const mDropRatio = mLower > 0 ? (mLower - mVMin) / mLower : 0;

        const wLower = Math.min(w2d[p1.pos], w2d[p2.pos]);
        const wPinchRatio = wLower > 0 ? (wLower - wVMin) / wLower : 0;

        const reqMassDrop = 0.05 + 0.10 * t;
        const reqWidthPinch = 0.06 + 0.14 * t;
        const reqRawDropRatio = 0.036 + 0.07 * t;

        const clearLightWaist =
          rawDrop >= Math.max(6.5, 3.0 * noise) &&
          rawDropRatio >= reqRawDropRatio &&
          (mDropRatio >= reqMassDrop || wPinchRatio >= reqWidthPinch);
        const strongHourglassPinch =
          rawDrop >= Math.max(4.5, 2.4 * noise) &&
          rawDropRatio >= 0.030 + 0.05 * t &&
          mDropRatio >= reqMassDrop * 1.3 &&
          wPinchRatio >= reqWidthPinch * 1.2;

        if (clearLightWaist || strongHourglassPinch) {
          isHourglassDoublet = true;
        }
      }

      // Two adjacent peaks are one spot when the valley between them is shallow.
      // mergeDrop scales continuously with the slider (8% -> 0.13, 12% -> 0.17, 28% -> 0.31, 55% -> 0.56);
      // well-separated peaks (>= 0.075 Rf apart) with distinct height asymmetry (a genuine secondary band
      // beside a dominant band rather than ripples on one flat dome) stay resolved in Sensitive/Standard modes.
      const baseMergeDrop = Math.min(0.92, 0.06 + 0.90 * minProm);
      const higherVal = Math.max(p1.val, p2.val, 1e-6);
      const sep = Math.min(1, Math.max(0, (dist / span - 0.065) / 0.015));
      const asym = Math.min(1, Math.max(0, (1 - lowerVal / higherVal) / 0.22));
      const distDiscount = 1 - 0.85 * sep * asym * Math.max(0, 1 - t / 0.75);
      const mergeDrop = baseMergeDrop * distDiscount;
      const closeDist = Math.max(10, Math.round(span * (0.01 + 0.10 * t)));
      const shouldMerge =
        !isHourglassDoublet &&
        (dropRatio < mergeDrop ||
          (dist < closeDist && dropRatio < Math.min(0.95, baseMergeDrop + 0.15)) ||
          valleyDrop < Math.max(2.8 * noise, 0.60 * minAbsFloor));

      if (shouldMerge) {
        if (dropRatio < minValleyRatio) {
          minValleyRatio = dropRatio;
          bestPairIdx = i;
        }
      }
    }

    if (bestPairIdx >= 0) {
      const p1 = merged[bestPairIdx];
      const p2 = merged[bestPairIdx + 1];
      const extStart = Math.min(p1.extentStart, p2.extentStart);
      const extEnd = Math.max(p1.extentEnd, p2.extentEnd);

      // Unified centroid computed using square intensity weighting:
      // Weighting by d[k]^2 places the spot marker firmly in the densest, darkest core of the spot
      let sumWeight = 0;
      let sumWeightPos = 0;
      let maxVal = 0;

      for (let k = extStart; k <= extEnd; k++) {
        const val = d[k];
        if (val > maxVal) maxVal = val;
        const netVal = Math.max(0, val - thr * 0.5);
        const w = netVal * netVal;
        sumWeight += w;
        sumWeightPos += k * w;
      }

      const centroid = sumWeight > 0 ? Math.round(sumWeightPos / sumWeight) : Math.round((p1.pos + p2.pos) / 2);

      merged.splice(bestPairIdx, 2, {
        pos: Math.max(start, Math.min(end, centroid)),
        val: maxVal,
        extentStart: extStart,
        extentEnd: extEnd,
      });
      changed = true;
    }
  }

  // 3. Final formatted spots sorted by position
  merged.sort((a, b) => a.pos - b.pos);

  return merged.map((p) => ({
    pos: p.pos,
    rf: Math.max(0, Math.min(1, +((p.pos - o.origin) / span).toFixed(3))),
    strength: Math.min(1, Math.max(0, +(p.val / dmax).toFixed(3))),
    source: 'auto' as const,
  }));
}

// Get effective spots for a lane: prioritizes user-adjusted/manual custom spots over auto-detected spots
export function getEffectiveLaneSpots(lane: TlcLane, autoSpots: TlcSpot[]): TlcSpot[] {
  if (lane.customSpots !== undefined && Array.isArray(lane.customSpots)) {
    return lane.customSpots;
  }
  return autoSpots;
}

export const ALL_TLC_CHANNELS: TlcChannelKey[] = ['UV254', 'UV366', 'White'];

/**
 * Returns loaded TLC channels in canonical order (UV254, UV366, White).
 */
export function getLoadedTlcChannels(
  imgs?: Record<string, any> | null,
  requireBitmap: boolean = false
): TlcChannelKey[] {
  if (!imgs) return [];
  return ALL_TLC_CHANNELS.filter((k) => (requireBitmap ? Boolean(imgs[k]?.bmp) : Boolean(imgs[k])));
}

/**
 * Returns true when at least two TLC channels are loaded so a multi-channel composite can be formed.
 */
export function hasCompositeChannels(
  imgs?: Record<string, any> | null,
  requireBitmap: boolean = false
): boolean {
  return getLoadedTlcChannels(imgs, requireBitmap).length >= 2;
}

/**
 * Merges spot lists across multiple channels, deduplicating co-eluting peaks within rfMergeTolerance
 * while preserving channel provenance on each spot.
 */
export function mergeMultiChannelSpots(
  channelSpots: Partial<Record<TlcChannelKey, TlcSpot[]>>,
  rfMergeTolerance: number = 0.035
): TlcSpot[] {
  const merged: TlcSpot[] = [];

  for (const ch of ALL_TLC_CHANNELS) {
    const spots = channelSpots[ch];
    if (!spots || spots.length === 0) continue;

    for (const sp of spots) {
      const incomingChannels = sp.channels && sp.channels.length ? sp.channels : [ch];
      // Pick closest matching Rf within tolerance (never collapse two already-resolved spots from the same channel)
      let bestMatch: TlcSpot | null = null;
      let bestDelta = Infinity;
      for (const m of merged) {
        if (m.channels && incomingChannels.some((ic) => m.channels!.includes(ic))) continue;
        const d = Math.abs(m.rf - sp.rf);
        if (d < rfMergeTolerance && d < bestDelta) {
          bestDelta = d;
          bestMatch = m;
        }
      }
      if (!bestMatch) {
        merged.push({
          ...sp,
          channels: [...incomingChannels],
        });
      } else {
        const mergedChannels = bestMatch.channels ? [...bestMatch.channels] : [];
        for (const c of incomingChannels) {
          if (!mergedChannels.includes(c)) mergedChannels.push(c);
        }
        bestMatch.channels = mergedChannels;
        if (sp.strength > bestMatch.strength) {
          bestMatch.strength = sp.strength;
          bestMatch.pos = sp.pos;
          bestMatch.rf = sp.rf;
          if (sp.areaPct != null) bestMatch.areaPct = sp.areaPct;
          if (sp.rfRaw != null) bestMatch.rfRaw = sp.rfRaw;
        }
      }
    }
  }

  merged.sort((a, b) => a.rf - b.rf || a.pos - b.pos);
  return merged;
}

export interface MultiChannelSpotsOptions {
  profiles: Partial<Record<TlcChannelKey, number[]>>;
  origin: number;
  front: number;
  radius?: number;
  minProminence?: number;
  minDistance?: number;
  rfMergeTolerance?: number;
  histograms?: Partial<Record<TlcChannelKey, ProfileHistogramStats>>;
  lane2dByChannel?: Partial<Record<TlcChannelKey, Lane2dMetrics>>;
}

/**
 * Detects spots across all provided channels (UV254, UV366, White) using a shared origin & front
 * and merges co-eluting peaks while keeping channel-unique spots from all three channels.
 */
export function findMultiChannelSpots(options: MultiChannelSpotsOptions): TlcSpot[] {
  const {
    profiles,
    origin,
    front,
    radius = 24,
    minProminence,
    minDistance,
    rfMergeTolerance = 0.035,
    histograms,
    lane2dByChannel,
  } = options;

  const perChannel: Partial<Record<TlcChannelKey, TlcSpot[]>> = {};
  for (const ch of ALL_TLC_CHANNELS) {
    const prof = profiles[ch];
    if (!prof || prof.length < 10) continue;
    perChannel[ch] = findSpots(prof, {
      sign: TLC_SIGNAL[ch].sign,
      origin,
      front,
      radius,
      minProminence,
      minDistance,
      plateHistogram: histograms?.[ch],
      lane2d: lane2dByChannel?.[ch],
    });
  }

  return mergeMultiChannelSpots(perChannel, rfMergeTolerance);
}

/**
 * Convenience wrapper extracting multi-channel spots for a TLC lane across all loaded channels,
 * respecting custom/manual lane spot overrides.
 */
export function getLaneMultiChannelSpots(
  set: TlcSet,
  lane: TlcLane,
  getProfile: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[],
  options: {
    origin?: number;
    front?: number;
    minProminence?: number;
    minDistance?: number;
    rfMergeTolerance?: number;
    coreFraction?: number;
  } = {}
): TlcSpot[] {
  if (lane.customSpots !== undefined && Array.isArray(lane.customSpots)) {
    return lane.customSpots;
  }
  const channels = getLoadedTlcChannels(set.imgs, false);
  if (!channels.length) return [];

  const oVal = options.origin ?? tlcOrigin(set, lane, getProfile);
  const fVal = options.front ?? tlcFront(set, lane, getProfile);
  const profiles: Partial<Record<TlcChannelKey, number[]>> = {};
  const histograms: Partial<Record<TlcChannelKey, ProfileHistogramStats>> = {};
  const lane2dByChannel: Partial<Record<TlcChannelKey, Lane2dMetrics>> = {};
  const cf = options.coreFraction ?? 0.35;
  for (const ch of channels) {
    const p = getProfile(set, ch, lane);
    if (p && p.length >= 10) {
      profiles[ch] = p;
      const chHist = getChannelHistogram(set, ch, getProfile);
      if (chHist) histograms[ch] = chHist;
      const m2d = getLane2dMetrics(set, ch, lane, cf);
      if (m2d) lane2dByChannel[ch] = m2d;
    }
  }

  return findMultiChannelSpots({
    profiles,
    origin: oVal,
    front: fVal,
    radius: lane.spotRadius || 24,
    minProminence: options.minProminence ?? set.spotProminence,
    minDistance: options.minDistance,
    rfMergeTolerance: options.rfMergeTolerance,
    histograms,
    lane2dByChannel,
  });
}

// Complete 1D Densitometry extraction: returns profile curve, rolling baseline, baseline-subtracted signal & spots
export function extractDensitogram(
  profile: number[],
  o: TlcProfileOptions
): TlcDensitogramData {
  const n = profile.length;
  if (n < 10) {
    return {
      points: [],
      spots: [],
      origin: o.origin,
      front: o.front,
      maxSignal: 1,
      totalArea: 0,
    };
  }

  const sm = movingAvg(profile, 7);
  const step = 5;
  const win = 100;
  const base = new Array(n);
  const q = o.sign < 0 ? 0.9 : 0.1;
  const pts: [number, number][] = [];

  for (let i = 0; i < n; i += step) {
    const chunk = sm.slice(Math.max(0, i - win), Math.min(n, i + win + 1));
    pts.push([i, pctile(chunk, q)]);
  }
  pts.push([n - 1, pts[pts.length - 1][1]]);

  for (let j = 0, i = 0; i < n; i++) {
    while (j < pts.length - 2 && pts[j + 1][0] < i) j++;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    base[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
  }

  const span = Math.max(1, o.front - o.origin);
  const spots = findSpots(profile, o);

  const points: TlcDensitogramData['points'] = [];
  let totalArea = 0;
  let maxSignal = 0;

  for (let i = 0; i < n; i++) {
    const rawVal = profile[i];
    const smoothVal = sm[i];
    const baseVal = base[i];
    const sig = Math.max(0, o.sign < 0 ? baseVal - smoothVal : smoothVal - baseVal);
    const rf = (i - o.origin) / span;

    if (sig > maxSignal) maxSignal = sig;
    if (i >= o.origin && i <= o.front) {
      totalArea += sig;
    }

    points.push({
      pos: i,
      rf,
      raw: rawVal,
      smooth: smoothVal,
      baseline: baseVal,
      signal: sig,
    });
  }

  // Calculate area percentage for each spot with bounded chromatographic integration windows
  if (totalArea > 0 && spots.length > 0) {
    spots.forEach((sp, idx) => {
      const prevPos = idx > 0 ? spots[idx - 1].pos : o.origin;
      const nextPos = idx < spots.length - 1 ? spots[idx + 1].pos : o.front;
      const leftBound = Math.max(0, Math.floor((sp.pos + prevPos) / 2), sp.pos - 15);
      const rightBound = Math.min(n - 1, Math.ceil((sp.pos + nextPos) / 2), sp.pos + 15);
      let peakArea = 0;
      for (let k = leftBound; k <= rightBound; k++) {
        peakArea += points[k]?.signal || 0;
      }
      sp.areaPct = Math.min(100, Math.round((peakArea / totalArea) * 100));
    });
  }

  return {
    points,
    spots,
    origin: o.origin,
    front: o.front,
    maxSignal: Math.max(maxSignal, 1e-6),
    totalArea,
  };
}

function autoCacheSignature(set: TlcSet): string {
  const imgSig = Object.entries(set.imgs || {})
    .map(([k, im]) => `${k}:${im.name}`)
    .sort()
    .join(';');
  const preEnabled = set.preRunEnabled !== false;
  const preSig = preEnabled
    ? Object.entries(set.preRunImgs || {})
        .map(([k, im]) => `${k}:${im?.name || ''}`)
        .sort()
        .join(';')
    : 'off';
  const l0 = set.cfg?.lanes[0];
  const laneSig = set.cfg ? `${set.cfg.lanes.length}_${l0?.x0 ?? 0}_${l0?.y0 ?? 0}_${l0?.length ?? 0}` : 'none';
  return `${imgSig}|pre:${preSig}|${laneSig}|${getBlankSilicaSignature()}`;
}

function detectDiffuseChannelFront(
  medProfile: number[],
  profiles: number[][],
  sign: number,
  maxHi?: number
): FrontDetectionResult {
  const n = medProfile.length;
  if (n < 20 || profiles.length < 6) return { pos: 0, score: 0 };

  const s = movingAvg(medProfile, 5);
  const lo = Math.max(4, Math.floor(n * 0.80));
  const rawHi = Math.min(n - 4, Math.floor(n * 0.96));
  const hi = maxHi != null ? Math.min(rawHi, maxHi) : rawHi;
  if (hi <= lo) return { pos: 0, score: 0 };

  const rCore = Math.max(1, Math.round(n * 0.005));
  const sIn = Math.max(5, Math.round(n * 0.025));
  const sOut = sIn + Math.max(10, Math.round(n * 0.045));

  const buf = new Float64Array(40);
  const count = hi - lo + 1;
  const d2Arr = new Float64Array(Math.max(1, count - 2));
  let d2Count = 0;
  for (let i = lo + 1; i <= hi - 1; i++) {
    d2Arr[d2Count++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  const sigmaS = Math.max(0.8, 1.4826 * medianSortedBuf(d2Arr, d2Count));

  let bestIdx = 0;
  let bestFeat = 0;
  const feats = new Float64Array(count);
  for (let i = lo; i <= hi; i++) {
    const c = windowMean(s, i - rCore, i + rCore);
    const mL = windowMedian(s, i - sOut, i - sIn, buf);
    const mR = windowMedian(s, i + sIn, Math.min(n - 1, i + sOut), buf);
    const dL = sign * (c - mL);
    const dR = sign * (c - mR);
    let feat = 0;
    if (dL > 4.0 && dR > 4.0 && Math.min(dL, dR) >= 0.35 * Math.max(dL, dR)) {
      feat = 0.7 * Math.min(dL, dR) + 0.3 * 0.5 * (dL + dR);
    }
    feats[i - lo] = feat;
    if (feat > bestFeat) {
      bestFeat = feat;
      bestIdx = i;
    }
  }

  const featsSorted = new Float64Array(feats);
  const medFeat = medianSortedBuf(featsSorted, count);
  for (let j = 0; j < count; j++) featsSorted[j] = Math.abs(feats[j] - medFeat);
  const madFeat = 1.4826 * medianSortedBuf(featsSorted, count);
  const noiseFloor = Math.max(sigmaS, madFeat, 2.0);
  const snr = bestFeat / noiseFloor;
  if (snr < 4.5 || bestFeat < 10.0 || bestIdx <= 0) return { pos: 0, score: 0 };

  // Only accept a diffuse upper band as the solvent front if it spans >= 75% of all lanes
  // with consistent height and support across left, middle, and right thirds of the plate.
  const tol = Math.max(5, Math.round(n * 0.012));
  let supporting = 0;
  const thirdSupport = [0, 0, 0];
  const thirdTotal = [0, 0, 0];
  for (let li = 0; li < profiles.length; li++) {
    const p = profiles[li];
    const third = Math.min(2, Math.floor((li * 3) / profiles.length));
    thirdTotal[third]++;
    let maxL = 0;
    for (let k = Math.max(sIn, bestIdx - tol); k <= Math.min(p.length - sIn - 1, bestIdx + tol); k++) {
      const mL = windowMedian(p, k - sOut, k - sIn, buf);
      const mR = windowMedian(p, k + sIn, Math.min(p.length - 1, k + sOut), buf);
      const dL = sign * (p[k] - mL);
      const dR = sign * (p[k] - mR);
      const d = dL > 2.0 && dR > 2.0 ? 0.5 * (dL + dR) : 0;
      if (d > maxL) maxL = d;
    }
    if (maxL >= Math.max(6.0, 0.35 * bestFeat)) {
      supporting++;
      thirdSupport[third]++;
    }
  }
  const frac = supporting / profiles.length;
  const allThirds = thirdTotal.every((tot, t) => tot === 0 || thirdSupport[t] / tot >= 0.55);
  if (frac < 0.75 || !allThirds) return { pos: 0, score: 0 };
  return { pos: bestIdx, score: 0.5 * snr * (0.4 + 0.6 * frac) };
}

/**
 * Measure plate-wide horizontal continuity of a candidate front `pos` across all lanes using
 * immediate local contrast (immune to dark plate borders past the front, while rejecting spot rows
 * that leave blank/quiet lanes flat).
 */
function measureFrontContinuity(
  smoothed: number[][],
  pos: number,
  sign: number,
  laneLen: number,
  effEnd?: number
): { frac: number; allThirds: boolean } {
  const N = smoothed.length;
  if (N === 0 || pos <= 0) return { frac: 0, allThirds: false };
  const n = laneLen;
  const rCore = Math.max(0, Math.round(n * 0.0015));
  const tIn = Math.max(2, Math.round(n * 0.003));
  const tOut = tIn + Math.max(3, Math.round(n * 0.007));
  const bgNear = Math.max(3, Math.round(n * 0.008));
  const bgMid = Math.max(20, Math.round(n * 0.12));
  const eWin = Math.max(2, Math.round(n * 0.006));
  const dirSign = -Math.sign(sign || 1);
  const bowTol = Math.max(5, Math.round(n * 0.015));
  const buf = new Float64Array(36);

  let support = 0;
  const thirdSup = [0, 0, 0];
  const thirdTot = [0, 0, 0];

  for (let li = 0; li < N; li++) {
    const s = smoothed[li];
    const topLim = effEnd != null ? Math.min(s.length - 1, effEnd) : s.length - 1;
    const third = Math.min(2, Math.floor((li * 3) / N));
    thirdTot[third]++;
    const kLo = Math.max(tOut + 1, pos - bowTol);
    const kHi = Math.min(topLim - tOut - 1, pos + bowTol);
    let hit = false;
    for (let k = kLo; k <= kHi; k++) {
      const c = windowMean(s, k - rCore, Math.min(topLim, k + rCore));
      const mLT = windowMean(s, k - tOut, k - tIn);
      const mRT = windowMean(s, Math.min(topLim, k + tIn), Math.min(topLim, k + tOut));
      const dL = sign * (c - mLT);
      const dR = sign * (c - mRT);
      if (dL > 2.5 && dR > 2.5 && Math.min(dL, dR) >= 0.25 * Math.max(dL, dR)) {
        hit = true;
        break;
      }
      if (k + bgNear <= topLim && k - bgNear >= 0) {
        const edgeL = windowMean(s, Math.max(0, k - rCore - eWin), Math.max(0, k - rCore - 1));
        const edgeR = windowMean(s, Math.min(topLim, k + rCore + 1), Math.min(topLim, k + rCore + eWin));
        if ((edgeR - edgeL) * dirSign > 2.5) {
          const medAfter = windowMedian(s, k + bgNear, Math.min(topLim, k + bgMid), buf);
          const medBefore = windowMedian(s, Math.max(0, k - bgMid), k - bgNear, buf);
          if ((medAfter - medBefore) * dirSign > 4.0) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) {
      support++;
      thirdSup[third]++;
    }
  }
  const frac = support / N;
  const allThirds = thirdTot.every((tot, t) => tot === 0 || thirdSup[t] / tot >= 0.55);
  return { frac, allThirds };
}

function detectOtsuWetDryFront(
  medProfile: number[],
  profiles: number[][],
  sign: number,
  upperHist: ProfileHistogramStats,
  laneLen: number,
  maxHi?: number
): FrontDetectionResult {
  const n = medProfile.length;
  if (n < 20 || upperHist.otsuEta < 0.50) return { pos: 0, score: 0 };

  const lo = Math.max(4, Math.floor(n * 0.50));
  const rawHi = Math.min(n - 4, Math.floor(n * 0.96));
  const hi = maxHi != null ? Math.min(rawHi, maxHi) : rawHi;
  if (hi <= lo + 8) return { pos: 0, score: 0 };

  const s = movingAvg(medProfile, 5);
  const dirSign = -Math.sign(sign || 1);
  const thresh = upperHist.otsuThresh;

  // Maximize cumulative wet-vs-dry classification agreement around otsuThresh across [lo..hi]
  let bestPos = 0;
  let bestObj = -Infinity;
  const margin = Math.max(6, Math.round(n * 0.02));
  for (let i = lo + margin; i <= hi - margin; i++) {
    let wetOk = 0;
    let dryOk = 0;
    for (let k = lo; k < i; k++) {
      if ((thresh - s[k]) * dirSign > 0) wetOk++;
    }
    for (let k = i; k <= hi; k++) {
      if ((s[k] - thresh) * dirSign > 0) dryOk++;
    }
    const obj = wetOk + dryOk;
    if (obj > bestObj) {
      bestObj = obj;
      bestPos = i;
    }
  }
  const accuracy = bestObj / Math.max(1, hi - lo + 1);
  if (bestPos <= 0 || accuracy < 0.72) return { pos: 0, score: 0 };

  const wMeanBefore = windowMean(s, Math.max(lo, bestPos - Math.round(n * 0.14)), bestPos - 3);
  const wMeanAfter = windowMean(s, bestPos + 3, Math.min(hi, bestPos + Math.round(n * 0.14)));
  const stepGap = (wMeanAfter - wMeanBefore) * dirSign;
  if (stepGap < Math.max(2.0, 2.5 * upperHist.bgSigma)) return { pos: 0, score: 0 };

  if (profiles.length >= 6) {
    let support = 0;
    const thirdSup = [0, 0, 0];
    const thirdTot = [0, 0, 0];
    const win = Math.max(12, Math.round(laneLen * 0.08));
    for (let li = 0; li < profiles.length; li++) {
      const p = profiles[li];
      const third = Math.min(2, Math.floor((li * 3) / profiles.length));
      thirdTot[third]++;
      const pLo = Math.max(0, bestPos - win);
      const pHi = Math.min(p.length - 1, bestPos + win);
      if (bestPos - 3 >= pLo && pHi >= bestPos + 3) {
        const mB = windowMean(p, pLo, bestPos - 3);
        const mA = windowMean(p, bestPos + 3, pHi);
        if ((mA - mB) * dirSign >= Math.max(1.5, 0.45 * stepGap)) {
          support++;
          thirdSup[third]++;
        }
      }
    }
    const frac = support / profiles.length;
    const allThirds = thirdTot.every((tot, t) => tot === 0 || thirdSup[t] / tot >= 0.55);
    if (frac < 0.72 || !allThirds) return { pos: 0, score: 0 };
    return {
      pos: bestPos,
      score: Math.min(9, (stepGap / Math.max(0.8, upperHist.bgSigma)) * (0.4 + 0.6 * frac)),
    };
  }

  return {
    pos: bestPos,
    score: Math.min(8, 4.5 + upperHist.otsuEta * 3.5),
  };
}

function detectChannelFront(
  rawProfiles: number[][],
  sign: number,
  laneLen: number,
  dualHalfCeiling?: { maxFrontPos: number; effEndPos: number }
): FrontDetectionResult {
  if (!rawProfiles.length) return { pos: 0, score: 0 };

  // Filter out off-plate pitch-black profiles so unaligned outer lanes don't corrupt median/voting
  const onPlate = rawProfiles.filter((p) => isProfileOnPlate(p, sign));
  const profiles = onPlate.length >= Math.min(4, rawProfiles.length) ? onPlate : rawProfiles;
  if (!profiles.length) return { pos: 0, score: 0 };

  const minLen = Math.min(...profiles.map((p) => p.length));
  if (minLen < 20) return { pos: 0, score: 0 };

  // Clamp upper search ceiling strictly inside physical top glass edge and dual-half center gap
  const glassEdge = detectGlassTopEdge(profiles, sign);
  let maxHi = glassEdge < minLen - 4 ? Math.max(Math.floor(minLen * 0.55), glassEdge - 6) : undefined;
  let effEnd = glassEdge < minLen - 4 ? glassEdge - 2 : undefined;
  if (dualHalfCeiling) {
    const capHi = Math.max(Math.floor(minLen * 0.55), Math.min(minLen - 4, Math.round(dualHalfCeiling.maxFrontPos)));
    const capEnd = Math.max(Math.floor(minLen * 0.57), Math.min(minLen - 2, Math.round(dualHalfCeiling.effEndPos)));
    maxHi = maxHi != null ? Math.min(maxHi, capHi) : capHi;
    effEnd = effEnd != null ? Math.min(effEnd, capEnd) : capEnd;
  }

  let medProfile: number[];
  if (profiles.length === 1) {
    medProfile = profiles[0];
  } else {
    medProfile = new Array(minLen);
    const colBuf = new Float64Array(profiles.length);
    for (let i = 0; i < minLen; i++) {
      for (let j = 0; j < profiles.length; j++) colBuf[j] = profiles[j][i];
      medProfile[i] = medianSortedBuf(colBuf, profiles.length);
    }
  }

  const hiFrac = maxHi != null ? Math.min(0.95, maxHi / minLen) : 0.95;
  const plateHist = analyzeProfileHistogram(profiles, sign, 0.12, hiFrac);
  const upperHist = analyzeProfileHistogram(profiles, sign, 0.50, hiFrac);
  const otsuCandidate = detectOtsuWetDryFront(medProfile, profiles, sign, upperHist, laneLen, maxHi);

  let best = detectFrontDetailed(medProfile, sign, plateHist, maxHi);
  const smoothed = profiles.length >= 6 ? profiles.map((p) => movingAvg(p, 3)) : [];
  if (profiles.length >= 6 && best.pos > 0) {
    const cont = measureFrontContinuity(smoothed, best.pos, sign, laneLen, effEnd);
    if (cont.frac < 0.65 || !cont.allThirds) {
      best = { pos: 0, score: 0 };
    } else {
      best = { pos: best.pos, score: best.score * (0.3 + 0.7 * cont.frac) };
    }
  }

  // For multi-lane plates, aggregate clustered per-lane detections only when they form one continuous
  // line across the plate so high-Rf spot bands in a subset of wells cannot beat the real front.
  if (profiles.length >= 3) {
    const laneHits = profiles
      .map((p) => detectFrontDetailed(p, sign, plateHist, maxHi))
      .filter((r) => r.pos > 0);
    const minNeeded =
      profiles.length >= 6
        ? Math.max(3, Math.ceil(profiles.length * 0.55))
        : Math.max(2, Math.ceil(profiles.length * 0.50));
    if (laneHits.length >= minNeeded) {
      const tol = Math.max(12, Math.round(laneLen * 0.035));
      let bestCluster: FrontDetectionResult[] = [];
      let bestAgg = 0;
      for (const anchor of laneHits) {
        const cl = laneHits.filter((r) => Math.abs(r.pos - anchor.pos) <= tol);
        if (cl.length < minNeeded) continue;
        const cPos = cl.map((r) => r.pos).sort((a, b) => a - b);
        const clusterPos = cPos[cPos.length >> 1];
        let contFactor = 1;
        if (profiles.length >= 6) {
          const cont = measureFrontContinuity(smoothed, clusterPos, sign, laneLen, effEnd);
          if (cont.frac < 0.68 || !cont.allThirds) continue;
          contFactor = 0.3 + 0.7 * cont.frac;
        }
        const cScore = cl.map((r) => r.score).sort((a, b) => a - b);
        const medScore = cScore[cScore.length >> 1];
        const agreement = cl.length / profiles.length;
        // Histogram Otsu wet-vs-dry agreement reinforces true fronts over dry pencil marks
        const otsuConfirm =
          otsuCandidate.pos > 0 && Math.abs(clusterPos - otsuCandidate.pos) <= Math.max(16, laneLen * 0.04)
            ? 1.18
            : 1.0;
        const aggScore = medScore * (0.25 + 0.75 * agreement) * contFactor * otsuConfirm;
        if (aggScore > bestAgg) {
          bestAgg = aggScore;
          bestCluster = cl;
        }
      }
      if (bestCluster.length >= minNeeded && bestAgg > best.score) {
        const cPos = bestCluster.map((r) => r.pos).sort((a, b) => a - b);
        best = { pos: cPos[cPos.length >> 1], score: bestAgg };
      }
    }
  }

  if (best.pos === 0 && profiles.length >= 6) {
    best = detectDiffuseChannelFront(medProfile, profiles, sign, maxHi);
  }

  // Fallback to strong bimodal wet-vs-dry histogram transition if ridge/diffuse found nothing
  if (best.pos === 0 && profiles.length >= 6 && upperHist.otsuEta >= 0.62 && otsuCandidate.pos > 0) {
    best = otsuCandidate;
  }

  return best;
}

// Narrow pseudo-lanes centred half way between neighbouring lanes of one half (same axis and length).
export function gutterLanes(halfLanes: TlcLane[]): TlcLane[] {
  const sorted = halfLanes.slice().sort((a, b) => a.id - b.id);
  const out: TlcLane[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const dx = b.x0 - a.x0;
    const dy = b.y0 - a.y0;
    const pitch = Math.hypot(dx, dy);
    if (!(pitch > 4) || pitch > 5 * Math.max(a.width, 1)) continue;
    out.push({
      ...a,
      id: 1000 + a.id,
      x0: a.x0 + dx / 2,
      y0: a.y0 + dy / 2,
      width: Math.max(6, Math.round(pitch * 0.5)),
      zeroRf: null,
      customSpots: undefined,
    });
  }
  return out;
}

// Solvent front resolution: explicit side override -> explicit global manual override
// (preserving any detected 2D per-lane curve offset) -> 2D seam + clearest-channel detection -> fallback 93% of lane length
export function tlcFront(
  set: TlcSet,
  lane: TlcLane,
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): number {
  const h = tlcHalf(lane);
  const manualBase =
    set.frontHalfPx && set.frontHalfPx[h] != null && set.frontHalfPx[h]! > 0
      ? set.frontHalfPx[h]!
      : set.frontPx && set.frontPx > 0
      ? set.frontPx
      : null;
  if (manualBase != null) {
    const autoMed = set.frontAuto?.[h];
    const autoLane = set.frontAutoByLane?.[lane.id];
    if (autoMed != null && autoMed > 0 && autoLane != null && autoLane > 0) {
      const delta = autoLane - autoMed;
      if (delta !== 0) {
        return Math.round(Math.max(20, Math.min(lane.length - 2, manualBase + delta)));
      }
    }
    return manualBase;
  }

  const channels = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((k) => !!set.imgs?.[k]);
  if (!channels.length || !getProfile) return Math.round(lane.length * 0.93);

  const sig = autoCacheSignature(set);
  if ((set as any)._autoCacheSig !== sig) {
    set.frontAuto = {};
    set.frontAutoByLane = {};
    set.originAuto = {};
    set.originAutoByLane = {};
    set.autoConf = {};
    (set as any)._histCache = {};
    (set as any)._prof2d = {};
    (set as any)._autoCacheSig = sig;
  }

  set.frontAuto = set.frontAuto || {};
  set.frontAutoByLane = set.frontAutoByLane || {};
  if (set.frontAuto[h] == null && set.cfg) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h).sort((a, b) => a.id - b.id);
    const halfLaneIds = halfLanes.map((l) => l.id);
    const laneIndexById = new Map<number, number>();
    halfLanes.forEach((l, idx) => laneIndexById.set(l.id, idx));

    let bestFlat: FrontDetectionResult = { pos: 0, score: 0 };
    let bestSeam: CurvedFrontSeamResult = { medianPos: 0, byLane: {}, score: 0, isCurved: false };

    // Strips of bare silica between the lanes carry no spots or smears, so a front or meniscus
    // is far cleaner there than down the lanes; sample them first at their exact midpoint
    // coordinates (i + 0.5) and fall back to (or compete with) 2D-filtered reaction lanes.
    const gutters = gutterLanes(halfLanes);
    const laneSets: Array<{ lanes: TlcLane[]; isGutterSet: boolean }> =
      gutters.length >= 4
        ? [
            { lanes: gutters, isGutterSet: true },
            { lanes: halfLanes, isGutterSet: false },
          ]
        : [{ lanes: halfLanes, isGutterSet: false }];
    let physicalGlassCeiling = lane.length - 1;
    let saw2dMetrics = false;

    // On head-to-head dual-sided plates (e.g. 20x20 cm plates running from top & bottom toward a
    // 1 cm center writing gap), find the clean middle gap first so this half's search stops strictly
    // before the opposing half's solvent front and never wanders across the center handwriting strip.
    let dualHalfCeil: { maxFrontPos: number; effEndPos: number } | undefined;
    const otherHalfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) !== h);
    if (halfLanes.length >= 4 && otherHalfLanes.length >= 4) {
      const pairDists: number[] = [];
      for (const l of halfLanes) {
        const th = (l.angle * Math.PI) / 180;
        const dx = Math.sin(th);
        const dy = -Math.cos(th);
        const nx = Math.cos(th);
        const ny = Math.sin(th);
        let bestOther: TlcLane | null = null;
        let bestLat = Infinity;
        for (const o of otherHalfLanes) {
          const oth = (o.angle * Math.PI) / 180;
          const dot = dx * Math.sin(oth) + dy * -Math.cos(oth);
          if (dot > -0.5) continue; // must run opposite (head-to-head)
          const lat = Math.abs((o.x0 - l.x0) * nx + (o.y0 - l.y0) * ny);
          if (lat < bestLat) {
            bestLat = lat;
            bestOther = o;
          }
        }
        if (bestOther && bestLat <= Math.max(l.width * 3.5, 160)) {
          const d = (bestOther.x0 - l.x0) * dx + (bestOther.y0 - l.y0) * dy;
          if (d > 0) pairDists.push(d);
        }
      }
      if (pairDists.length >= 4) {
        pairDists.sort((a, b) => a - b);
        const medPairDist = pairDists[pairDists.length >> 1];
        const thisProbe = gutters.length >= 4 ? gutters : halfLanes;
        const otherGutters = gutterLanes(otherHalfLanes);
        const otherProbe = otherGutters.length >= 4 ? otherGutters : otherHalfLanes;
        const thisGapCh: Array<{ profiles: number[][]; sign: number }> = [];
        const otherGapCh: Array<{ profiles: number[][]; sign: number }> = [];
        let profScale = 1;
        for (const ch of channels) {
          const chSign = TLC_SIGNAL[ch]?.sign ?? 1;
          const tp = thisProbe.map((l) => getProfile(set, ch, l)).filter((p) => p && p.length > 0);
          const op = otherProbe.map((l) => getProfile(set, ch, l)).filter((p) => p && p.length > 0);
          if (tp.length >= 4) {
            if (lane.length > 0) profScale = tp[0].length / lane.length;
            thisGapCh.push({ profiles: tp, sign: chSign });
            otherGapCh.push({ profiles: op, sign: chSign });
          }
        }
        if (thisGapCh.length > 0) {
          const effLaneLen = Math.round(lane.length * profScale);
          const gapRes = findDualHalfGapCeiling(thisGapCh, otherGapCh, medPairDist * profScale, effLaneLen);
          if (gapRes) {
            dualHalfCeil = { maxFrontPos: gapRes.maxFrontPos, effEndPos: gapRes.effEndPos };
            physicalGlassCeiling = Math.min(physicalGlassCeiling, gapRes.maxFrontPos);
          }
        }
      }
    }
    const seamOpts: CurvedFrontSeamOptions | undefined = dualHalfCeil
      ? { maxFrontPos: dualHalfCeil.maxFrontPos, effEndPos: dualHalfCeil.effEndPos }
      : undefined;

    for (const { lanes: lanesToUse, isGutterSet } of laneSets) {
      const seamInputs: CurvedFrontChannelInput[] = [];
      for (const ch of channels) {
        const profiles: number[][] = [];
        const metricsArr: Array<Lane2dMetrics | undefined> = [];
        const colPositions: number[] = [];
        for (let i = 0; i < lanesToUse.length; i++) {
          const l = lanesToUse[i];
          const p = getProfile(set, ch, l);
          if (!p || !p.length) continue;
          profiles.push(p);
          const m = getCachedLane2dMetrics(set, ch, l);
          if (m) saw2dMetrics = true;
          metricsArr.push(m);
          if (isGutterSet) {
            const leftIdx = laneIndexById.get(l.id - 1000);
            colPositions.push(leftIdx != null ? leftIdx + 0.5 : i + 0.5);
          } else {
            const idx = laneIndexById.get(l.id);
            colPositions.push(idx != null ? idx : i);
          }
        }
        if (!profiles.length) continue;
        const chSign = TLC_SIGNAL[ch]?.sign ?? 1;
        if (chSign < 0) {
          const ge = detectGlassTopEdge(profiles, chSign);
          if (ge < lane.length - 4) {
            physicalGlassCeiling = Math.min(physicalGlassCeiling, ge - 8);
          }
        }
        const res = detectChannelFront(profiles, chSign, lane.length, dualHalfCeil);
        if (res.score > bestFlat.score && res.pos > 0) {
          bestFlat = res;
        }
        if (profiles.length >= 4) {
          const hasAnyMetrics = metricsArr.some((m) => m !== undefined);
          seamInputs.push({
            profiles,
            sign: chSign,
            channel: ch,
            metrics: hasAnyMetrics ? metricsArr : undefined,
            colPositions,
          });
        }
      }

      // 2D smooth curved solvent-front seam tracker (single-channel & multi-channel fused):
      // Uses 2D horizontal-continuity strip metrics, outer dry-side band edges, White-light pencil
      // suppression, and a penalized smoothing spline across exact lane/gutter coordinates so wavy
      // fronts, edge-curled aluminium plates, bows, and tilts are tracked per lane.
      if (seamInputs.length > 0 && halfLaneIds.length >= 4) {
        const fused = detectCurvedFrontSeam(seamInputs, halfLaneIds, lane.length, seamOpts);
        if (fused.medianPos > 0 && fused.score > bestSeam.score) {
          bestSeam = fused;
        }
        if (seamInputs.length > 1) {
          for (const single of seamInputs) {
            const singleRes = detectCurvedFrontSeam([single], halfLaneIds, lane.length, seamOpts);
            if (singleRes.medianPos > 0 && singleRes.score > bestSeam.score) {
              bestSeam = singleRes;
            }
          }
        }
      }

      // Stop after gutters if a confident front was found (or if no 2D metrics are loaded for lane competition)
      const gutterStrongEnough =
        bestSeam.medianPos > 0 && (bestSeam.score >= 5.5 || bestSeam.isCurved || !saw2dMetrics);
      if (gutterStrongEnough || (bestFlat.pos > 0 && !saw2dMetrics)) break;
    }

    // Prefer curved/outer-edge 2D seam whenever it finds a strong, continuous front (2D seam handles
    // wavy fronts, outer dry-side band edges, and pencil-line suppression far better than 1D flat median).
    const flatScoreCapped = Math.min(16, bestFlat.score);
    const sameFrontAsFlat =
      bestFlat.pos > 0 &&
      Math.abs(bestSeam.medianPos - bestFlat.pos) <= Math.max(35, lane.length * 0.06);
    const useSeam =
      bestSeam.medianPos > 0 &&
      (bestFlat.pos <= 0 ||
        bestSeam.score >= 8.0 ||
        (bestSeam.isCurved && sameFrontAsFlat && bestSeam.score >= 4.5) ||
        (bestSeam.isCurved && bestSeam.score >= Math.max(4.5, flatScoreCapped * 0.72)) ||
        bestSeam.score >= flatScoreCapped);

    const detected = useSeam || bestFlat.pos > 0;
    const defaultFront = Math.max(
      Math.round(lane.length * 0.55),
      Math.min(Math.round(lane.length * 0.93), physicalGlassCeiling)
    );
    const medianFront = useSeam
      ? bestSeam.medianPos
      : bestFlat.pos > 0
      ? bestFlat.pos
      : defaultFront;
    const chosenScore = useSeam ? bestSeam.score : bestFlat.pos > 0 ? bestFlat.score : 0;

    set.frontAuto[h] = medianFront;
    if (useSeam) {
      Object.assign(set.frontAutoByLane, bestSeam.byLane);
    } else {
      for (const l of halfLanes) {
        set.frontAutoByLane[l.id] = medianFront;
      }
    }
    set.autoConf = set.autoConf || {};
    set.autoConf[`front${h}`] = { detected, score: chosenScore };
  }
  return set.frontAutoByLane?.[lane.id] ?? set.frontAuto?.[h] ?? Math.round(lane.length * 0.93);
}

/**
 * Returns the canonical half-plate base (median) solvent-front coordinate in px for side-level
 * sliders and Vision QC shifts, so nudging a side slider shifts all lanes smoothly without
 * jumping to an edge-curled lane's offset.
 */
export function tlcHalfFrontBase(
  set: TlcSet,
  half: number,
  sampleLane: TlcLane | undefined,
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): number {
  if (set.frontHalfPx && set.frontHalfPx[half] != null && set.frontHalfPx[half]! > 0) {
    return Math.round(set.frontHalfPx[half]!);
  }
  if (set.frontPx && set.frontPx > 0) return Math.round(set.frontPx);
  if (sampleLane) {
    // Ensure auto-detection has populated frontAuto[half]
    const laneVal = tlcFront(set, sampleLane, getProfile);
    if (set.frontAuto?.[half] != null && set.frontAuto[half]! > 0) {
      return Math.round(set.frontAuto[half]!);
    }
    return Math.round(laneVal);
  }
  return 920;
}

export interface OriginLaneEntry {
  laneId: number;
  profile: number[];
  lane?: Pick<TlcLane, 'x0' | 'y0' | 'angle' | 'width' | 'length'>;
  metrics?: Lane2dMetrics;
}

interface ChannelOriginResult extends FrontDetectionResult {
  byLane?: Record<number, number>;
  lockedLanes?: number[];
  tailingLanes?: number[];
  validFrac?: number;
  medFeat?: number;
}

interface OriginPlateFrame {
  hasGeometry: boolean;
  uByLane: Map<number, number>;
  allLaneIds: number[];
  toPlatePos: (laneId: number, lanePos: number) => number;
  toLanePos: (laneId: number, platePos: number) => number;
}

function buildOriginPlateFrame(entries: OriginLaneEntry[], laneLen: number): OriginPlateFrame {
  const allLaneIds = entries.map((e) => e.laneId);
  const withGeom = entries.filter(
    (e): e is OriginLaneEntry & { lane: NonNullable<OriginLaneEntry['lane']> } =>
      !!e.lane && Math.abs(Math.cos((e.lane.angle * Math.PI) / 180)) > 0.3
  );
  if (withGeom.length < Math.min(3, entries.length) || withGeom.length === 0) {
    return {
      hasGeometry: false,
      uByLane: new Map(allLaneIds.map((id) => [id, ((id % 27) - 13) / 13])),
      allLaneIds,
      toPlatePos: (_id, pos) => pos,
      toLanePos: (_id, pos) => pos,
    };
  }

  const dyList = withGeom.map((e) => -Math.cos((e.lane.angle * Math.PI) / 180)).sort((a, b) => a - b);
  const y0List = withGeom.map((e) => e.lane.y0).sort((a, b) => a - b);
  const halfDirY = dyList[dyList.length >> 1];
  const sgn = halfDirY >= 0 ? 1 : -1;
  const refY0 = y0List[y0List.length >> 1];

  const approxOrigin = Math.max(12, laneLen * 0.12);
  const geomById = new Map<number, { x0: number; y0: number; dx: number; dy: number; maxLen: number; xOrig: number }>();
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const e of withGeom) {
    const th = (e.lane.angle * Math.PI) / 180;
    const dx = Math.sin(th);
    const dy = -Math.cos(th);
    const xOrig = e.lane.x0 + dx * approxOrigin;
    if (xOrig < xMin) xMin = xOrig;
    if (xOrig > xMax) xMax = xOrig;
    geomById.set(e.laneId, {
      x0: e.lane.x0,
      y0: e.lane.y0,
      dx,
      dy,
      maxLen: Math.max(20, e.profile.length || e.lane.length || laneLen),
      xOrig,
    });
  }

  const xMid = 0.5 * (xMin + xMax);
  const xHalfSpan = Math.max(1, 0.5 * (xMax - xMin));
  const uByLane = new Map<number, number>();
  for (const id of allLaneIds) {
    const g = geomById.get(id);
    if (g && xMax > xMin + 1) {
      uByLane.set(id, (g.xOrig - xMid) / xHalfSpan);
    } else {
      uByLane.set(id, ((id % 27) - 13) / 13);
    }
  }

  return {
    hasGeometry: true,
    uByLane,
    allLaneIds,
    toPlatePos: (laneId: number, lanePos: number) => {
      const g = geomById.get(laneId);
      if (!g) return lanePos;
      const yImg = g.y0 + g.dy * lanePos;
      return (yImg - refY0) * sgn;
    },
    toLanePos: (laneId: number, platePos: number) => {
      const g = geomById.get(laneId);
      if (!g) return platePos;
      const yImg = refY0 + platePos * sgn;
      const raw = (yImg - g.y0) / g.dy;
      return Math.max(4, Math.min(g.maxLen - 4, raw));
    },
  };
}

function fitOriginQuadCurve(
  hits: Array<{ laneId: number; pos: number }>,
  medPos: number,
  laneLen: number,
  uByLane?: Map<number, number>,
  targetLaneIds?: number[]
): Record<number, number> | undefined {
  if (hits.length < 4) return undefined;
  const uOf = (laneId: number) => uByLane?.get(laneId) ?? ((laneId % 27) - 13) / 13;
  const baseHalf = hits[0].laneId < 27 ? 0 : 27;
  const outIds =
    targetLaneIds && targetLaneIds.length > 0
      ? targetLaneIds
      : Array.from({ length: 27 }, (_, i) => baseHalf + i);
  const maxShift = Math.max(14, Math.round(laneLen * 0.05));

  const fitLinearFallback = (): { map: Record<number, number>; medRes: number } | undefined => {
    const slopes: number[] = [];
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const du = uOf(hits[j].laneId) - uOf(hits[i].laneId);
        if (Math.abs(du) > 0.2) slopes.push((hits[j].pos - hits[i].pos) / du);
      }
    }
    if (!slopes.length) return undefined;
    slopes.sort((a, b) => a - b);
    const c1Lin = slopes[slopes.length >> 1];
    if (Math.abs(c1Lin) > maxShift) return undefined;
    const icpts = hits.map((h) => h.pos - c1Lin * uOf(h.laneId)).sort((a, b) => a - b);
    const c0Lin = icpts[icpts.length >> 1];
    const tol = Math.max(8, laneLen * 0.022);
    const inliers = hits.filter((h) => Math.abs(h.pos - (c0Lin + c1Lin * uOf(h.laneId))) <= tol);
    if (inliers.length < 4) return undefined;
    const uVals = inliers.map((h) => uOf(h.laneId));
    if (Math.max(...uVals) - Math.min(...uVals) < 6 / 13) return undefined;
    const resSorted = hits.map((h) => Math.abs(h.pos - (c0Lin + c1Lin * uOf(h.laneId)))).sort((a, b) => a - b);
    const out: Record<number, number> = {};
    for (const id of outIds) {
      const pred = c0Lin + c1Lin * uOf(id);
      out[id] = Math.max(medPos - maxShift, Math.min(medPos + maxShift, pred));
    }
    return { map: out, medRes: resSorted[resSorted.length >> 1] };
  };

  const linFit = fitLinearFallback();
  if (hits.length < 10) return linFit?.map;

  let c0 = medPos;
  let c1 = 0;
  let c2 = 0;

  for (let iter = 0; iter < 5; iter++) {
    const cutoff = Math.max(8, laneLen * 0.016);
    let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
    let r0 = 0, r1 = 0, r2 = 0;
    for (const h of hits) {
      const u = uOf(h.laneId);
      const u2 = u * u;
      const err = Math.abs(h.pos - (c0 + c1 * u + c2 * u2));
      let w = 1;
      if (iter > 0) {
        if (err >= cutoff) w = 0;
        else {
          const t = err / cutoff;
          w = (1 - t * t) ** 2;
        }
      }
      if (w <= 0) continue;
      s00 += w; s01 += w * u; s02 += w * u2;
      s11 += w * u2; s12 += w * u * u2; s22 += w * u2 * u2;
      r0 += w * h.pos; r1 += w * u * h.pos; r2 += w * u2 * h.pos;
    }
    s22 += 0.25;
    const M = [
      [s00, s01, s02, r0],
      [s01, s11, s12, r1],
      [s02, s12, s22, r2],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let row = col + 1; row < 3; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[piv][col])) piv = row;
      }
      if (Math.abs(M[piv][col]) < 1e-9) return linFit?.map;
      if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
      const div = M[col][col];
      for (let j = col; j < 4; j++) M[col][j] /= div;
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const fac = M[row][col];
        for (let j = col; j < 4; j++) M[row][j] -= fac * M[col][j];
      }
    }
    c0 = M[0][3]; c1 = M[1][3]; c2 = M[2][3];
  }

  const tol = Math.max(7, laneLen * 0.012);
  const inliers = hits.filter((h) => {
    const u = uOf(h.laneId);
    return Math.abs(h.pos - (c0 + c1 * u + c2 * u2Or(u))) <= tol;
  });
  function u2Or(u: number) {
    return u * u;
  }
  if (inliers.length < 10) return linFit?.map;
  const uIn = inliers.map((h) => uOf(h.laneId));
  const minU = Math.min(...uIn);
  const maxU = Math.max(...uIn);
  if (maxU - minU < 18 / 13 || minU > -9 / 13 || maxU < 9 / 13) return linFit?.map;
  const nLeft = uIn.filter((u) => u < -4 / 13).length;
  const nMid = uIn.filter((u) => u >= -4 / 13 && u <= 4 / 13).length;
  const nRight = uIn.filter((u) => u > 4 / 13).length;
  if (nLeft < 2 || nMid < 2 || nRight < 2) return linFit?.map;

  const quadResSorted = hits
    .map((h) => {
      const u = uOf(h.laneId);
      return Math.abs(h.pos - (c0 + c1 * u + c2 * u * u));
    })
    .sort((a, b) => a - b);
  const quadMedRes = quadResSorted[quadResSorted.length >> 1];
  if (linFit && (quadMedRes >= 0.72 * linFit.medRes || linFit.medRes - quadMedRes < Math.max(1.2, 0.0015 * laneLen))) {
    return linFit.map;
  }

  const out: Record<number, number> = {};
  for (const id of outIds) {
    const u = uOf(id);
    const pred = c0 + c1 * u + c2 * u * u;
    out[id] = Math.max(medPos - maxShift, Math.min(medPos + maxShift, pred));
  }
  return out;
}

interface OriginNearResult {
  pos: number;
  isTailing: boolean;
  fwhm: number;
  rawFeat: number;
}

function detectOriginNearDetailed(
  profile: number[],
  sign: number,
  refPos: number,
  localRadius: number,
  minFeat: number = 3.0,
  minSnr: number = 3.2,
  minBi: number = 8.0,
  opts?: OriginRefineOptions
): OriginNearResult {
  const empty: OriginNearResult = { pos: 0, isTailing: false, fwhm: 0, rawFeat: 0 };
  const n = profile.length;
  if (n < 20) return empty;
  if (opts?.metrics?.offPlate || opts?.metrics?.borderStraddle) return empty;

  const smWin = n >= 250 ? 5 : 3;
  const s = movingAvg(profile, smWin);
  const loAll = Math.max(4, Math.floor(n * 0.03));
  const noiseEnd = Math.min(n - 2, Math.max(loAll + 10, Math.floor(n * 0.45)));
  const d2Arr = new Float64Array(Math.max(1, noiseEnd - loAll));
  let d2Count = 0;
  for (let i = loAll + 1; i <= noiseEnd - 1; i++) {
    d2Arr[d2Count++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  const d2Scale = smWin === 5 ? 1.0 : 0.866;
  const sigmaS = Math.max(0.8, 1.4826 * medianSortedBuf(d2Arr, d2Count) * d2Scale);

  const rCore = Math.max(1, Math.round(n * 0.0025));
  const flankIn = Math.max(6, Math.round(n * 0.022));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));

  const wLo = Math.max(4, Math.floor(n * 0.025), Math.round(refPos - localRadius));
  const wHi = Math.min(n - 5, Math.floor(n * 0.30), Math.round(refPos + localRadius));
  if (wHi <= wLo) return empty;

  const buf = new Float64Array(24);
  let bestIdx = 0;
  let bestScore = 0;
  let bestRawFeat = 0;
  let bestBilateral = 0;
  const biFloor = Math.max(2.0, Math.min(6.0, 0.75 * minBi));

  for (let i = wLo; i <= wHi; i++) {
    if (i - flankIn < 1 || i + flankIn >= n - 1) continue;
    const c = windowMean(s, i - rCore, i + rCore);
    const mBelow = windowMedian(s, Math.max(0, i - flankOut), i - flankIn, buf);
    const mAbove = windowMedian(s, i + flankIn, Math.min(n - 1, i + flankOut), buf);
    const dBelow = sign * (c - mBelow);
    const dAbove = sign * (c - mAbove);

    if (dBelow > 0 && dAbove > 0) {
      const rawFeat = 0.65 * Math.min(dBelow, dAbove) + 0.35 * 0.5 * (dBelow + dAbove);
      const biMin = Math.min(dBelow, dAbove);
      if (biMin < Math.max(biFloor, 0.32 * rawFeat)) continue;
      const distFrac = Math.abs(i - refPos) / Math.max(1, localRadius);
      // Stronger forward distance bias so elution smears/dust ahead of baseline cannot pull blank lanes
      const weight = 1 - (i > refPos ? 0.32 : 0.16) * distFrac;
      const sc = rawFeat * weight;
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
        bestRawFeat = rawFeat;
        bestBilateral = biMin;
      }
    }
  }

  const snr = bestRawFeat / Math.max(sigmaS, 1.0);
  if (snr < Math.max(minSnr, 5.5) || bestRawFeat < minFeat || bestBilateral < minBi || bestIdx <= 0) {
    return empty;
  }

  const refRes = refineOriginCoreDetailed(s, bestIdx, sign, opts);
  const refined = refRes.pos;

  // Reject tiny 1-3 px dust specks (real spotted origin deposits always have physical width >= 0.5% lane).
  const minFwhm = Math.max(3, Math.round(n * 0.005));
  if (refRes.fwhm < minFwhm) return empty;

  // 2D lateral centering & edge-speck guard: reject dust specks sitting on lane borders and
  // horizontal illumination/silica streaks that lack center-vs-flank contrast.
  if (opts?.metrics && refined >= 0 && refined < opts.metrics.edgeRatio.length) {
    const m = opts.metrics;
    const latMid = m.lateralExcess[refined];
    if (latMid < 900) {
      const erWin: number[] = [];
      const leWin: number[] = [];
      for (let k = Math.max(0, refined - 2); k <= Math.min(m.edgeRatio.length - 1, refined + 2); k++) {
        erWin.push(m.edgeRatio[k]);
        leWin.push(m.lateralExcess[k]);
      }
      erWin.sort((a, b) => a - b);
      leWin.sort((a, b) => a - b);
      const medEr = erWin[erWin.length >> 1];
      const medLe = leWin[leWin.length >> 1];
      if (medEr > 1.35) return empty;
      if (medLe < Math.max(2.0, 0.12 * bestRawFeat) && bestRawFeat < 45) return empty;
    }
  }

  const devFromRef = Math.abs(refined - refPos);
  const fwdShift = refined - refPos;
  // Faint / fuzzy halos have wide centering uncertainty and tend to peak on their upper rim:
  // reject weak or forward-drifting halos far from the smooth baseline while preserving strong
  // genuine spotted dots with experimental spotting error.
  if (
    devFromRef > 3 &&
    (bestRawFeat < Math.max(28, minFeat) ||
      bestBilateral < Math.max(16, minBi) ||
      snr < Math.max(7.5, minSnr) ||
      (bestRawFeat < 45 && bestBilateral < 0.58 * bestRawFeat))
  ) {
    return empty;
  }
  // Baseline-anchored broad halo / coffee-ring guard: if a peak sits forward of refPos (>4 px)
  // yet the same connected deposit already spans across & behind refPos with strong signal at
  // refPos, it is a wide halo/ring/smear rooted at the baseline whose upper rim peaked forward,
  // not a distinct dot spotted ahead of the baseline.
  if (fwdShift > 4 && refRes.coreMax > 0) {
    const refIdx = Math.max(0, Math.min(n - 1, Math.round(refPos)));
    const sigAtRef = Math.max(0, sign * (s[refIdx] - refRes.bg));
    if (
      refRes.backEdge50 <= refPos - 2 &&
      sigAtRef >= 0.62 * refRes.coreMax &&
      refRes.coreMax < 70
    ) {
      return empty;
    }
  }
  if (
    fwdShift > Math.max(5, 0.36 * localRadius) &&
    refRes.isTailing &&
    bestRawFeat < Math.max(45, minFeat * 1.2)
  ) {
    return empty;
  }
  return { pos: refined, isTailing: refRes.isTailing, fwhm: refRes.fwhm, rawFeat: bestRawFeat };
}

function detectOriginNear(
  profile: number[],
  sign: number,
  refPos: number,
  localRadius: number,
  minFeat: number = 3.0,
  minSnr: number = 3.2,
  minBi: number = 8.0,
  opts?: OriginRefineOptions
): number {
  return detectOriginNearDetailed(profile, sign, refPos, localRadius, minFeat, minSnr, minBi, opts).pos;
}

// Faint-origin fallback: when no dot passes normal thresholds, accept weaker features only if a
// substantial share of lanes agree on one height (a consistent row is strong evidence on its own).
function detectFaintOriginRow(
  laneEntries: OriginLaneEntry[],
  sign: number,
  laneLen: number,
  frame: OriginPlateFrame,
  histBgSigma?: number
): ChannelOriginResult {
  const hits: Array<{ laneId: number; pos: number; platePos: number; score: number }> = [];
  for (const e of laneEntries) {
    if (e.metrics?.offPlate || e.metrics?.borderStraddle) continue;
    for (const cand of detectOriginCandidates(e.profile, sign, 3, true, histBgSigma, {
      metrics: e.metrics,
      laneWidthPx: e.lane?.width,
    })) {
      if (cand.pos > laneLen * 0.06) {
        hits.push({
          laneId: e.laneId,
          pos: cand.pos,
          platePos: frame.toPlatePos(e.laneId, cand.pos),
          score: cand.score,
        });
      }
    }
  }
  const minNeeded = Math.max(3, Math.ceil(laneEntries.length * 0.4));
  if (hits.length < minNeeded) return { pos: 0, score: 0 };
  const tol = Math.max(10, Math.round(laneLen * 0.03));
  let chosen: { pos: number; cl: typeof hits; agg: number } | null = null;
  for (const anchor of hits) {
    const byLane = new Map<number, (typeof hits)[number]>();
    for (const r of hits) {
      if (Math.abs(r.platePos - anchor.platePos) > tol) continue;
      const prev = byLane.get(r.laneId);
      if (!prev || r.score > prev.score) byLane.set(r.laneId, r);
    }
    const cl = Array.from(byLane.values());
    if (cl.length < minNeeded) continue;
    const sortedPos = cl.map((r) => r.platePos).sort((a, b) => a - b);
    const pos = sortedPos[sortedPos.length >> 1];
    if (pos < laneLen * 0.06 || pos > laneLen * 0.30) continue;
    const agg = cl.length / laneEntries.length;
    // Prefer the better-supported row; on near ties take the outer (lower) one, which is the true origin
    if (!chosen || agg > chosen.agg + 0.08 || (agg >= chosen.agg - 0.08 && pos < chosen.pos)) {
      chosen = { pos, cl, agg };
    }
  }
  if (!chosen) return { pos: 0, score: 0 };
  const backbone = fitOriginQuadCurve(
    chosen.cl.map((r) => ({ laneId: r.laneId, pos: r.platePos })),
    chosen.pos,
    laneLen,
    frame.uByLane,
    frame.allLaneIds
  );
  const byLane: Record<number, number> = {};
  for (const e of laneEntries) {
    const own = chosen.cl.find((r) => r.laneId === e.laneId);
    byLane[e.laneId] = own
      ? own.pos
      : Math.round(frame.toLanePos(e.laneId, backbone?.[e.laneId] ?? chosen.pos));
  }
  const medScore = chosen.cl.map((r) => r.score).sort((a, b) => a - b)[chosen.cl.length >> 1];
  return {
    pos: Math.round(chosen.pos),
    // Deliberately modest so UI / multi-channel comparison still treats stronger channels as higher confidence
    score: Math.min(6, medScore) * (0.4 + 0.6 * chosen.agg),
    byLane,
    validFrac: chosen.cl.length / laneEntries.length,
    medFeat: 0,
  };
}

export function detectChannelOrigin(
  rawLaneEntries: OriginLaneEntry[],
  sign: number,
  laneLen: number,
  hist?: ProfileHistogramStats
): ChannelOriginResult {
  if (!rawLaneEntries.length) return { pos: 0, score: 0 };

  const onPlateEntries = rawLaneEntries.filter(
    (e) => !e.metrics?.offPlate && !e.metrics?.borderStraddle && isProfileOnPlate(e.profile, sign)
  );
  const laneEntries = onPlateEntries.length >= Math.min(3, rawLaneEntries.length) ? onPlateEntries : rawLaneEntries;
  const frame = buildOriginPlateFrame(rawLaneEntries, laneLen);

  const h = hist ?? analyzeProfileHistogram(laneEntries.map((e) => e.profile), sign, 0.06, 0.90);
  const histBgSigma = h.sampleCount >= 16 ? h.bgSigma : undefined;

  let medProfile: number[];
  if (laneEntries.length === 1) {
    medProfile = laneEntries[0].profile;
  } else {
    const minLen = Math.min(...laneEntries.map((e) => e.profile.length));
    if (minLen < 20) return { pos: 0, score: 0 };
    medProfile = new Array(minLen);
    const colBuf = new Float64Array(laneEntries.length);
    for (let i = 0; i < minLen; i++) {
      for (let j = 0; j < laneEntries.length; j++) colBuf[j] = laneEntries[j].profile[i];
      medProfile[i] = medianSortedBuf(colBuf, laneEntries.length);
    }
  }

  let best: ChannelOriginResult = detectOriginDetailed(medProfile, sign, h);

  if (laneEntries.length >= 3) {
    const laneHits: Array<{
      laneId: number;
      pos: number;
      platePos: number;
      score: number;
      feat: number;
      fwhm: number;
      isTailing: boolean;
    }> = [];
    for (const e of laneEntries) {
      for (const cand of detectOriginCandidates(e.profile, sign, 3, false, histBgSigma, {
        metrics: e.metrics,
        laneWidthPx: e.lane?.width,
      })) {
        if (cand.pos > 10) {
          laneHits.push({
            laneId: e.laneId,
            pos: cand.pos,
            platePos: frame.toPlatePos(e.laneId, cand.pos),
            score: cand.score,
            feat: cand.feat,
            fwhm: cand.fwhm ?? 0,
            isTailing: !!cand.isTailing,
          });
        }
      }
    }
    const minNeeded = Math.max(2, Math.ceil(laneEntries.length * 0.22));
    if (laneHits.length >= minNeeded) {
      const tol = Math.max(12, Math.round(laneLen * 0.04));
      const clusters: Array<{ pos: number; aggScore: number; inCluster: typeof laneHits }> = [];
      for (const anchor of laneHits) {
        const byLane = new Map<number, (typeof laneHits)[number]>();
        for (const r of laneHits) {
          if (Math.abs(r.platePos - anchor.platePos) > tol) continue;
          const prev = byLane.get(r.laneId);
          if (!prev || r.score > prev.score) byLane.set(r.laneId, r);
        }
        const cl = Array.from(byLane.values());
        if (cl.length < minNeeded) continue;
        const cPos = cl.map((r) => r.platePos).sort((a, b) => a - b);
        const cScore = cl.map((r) => r.score).sort((a, b) => a - b);
        const cPosMed = cPos[cPos.length >> 1];
        if (clusters.some((existing) => Math.abs(existing.pos - cPosMed) <= tol * 0.6)) continue;
        const medScore = cScore[cScore.length >> 1];
        const agreement = cl.length / laneEntries.length;
        const aggScore = medScore * (0.4 + 0.6 * agreement);
        clusters.push({ pos: cPosMed, aggScore, inCluster: cl });
      }
      if (clusters.length > 0) {
        let chosen = clusters.reduce((a, b) => (b.aggScore > a.aggScore ? b : a));
        const outerMin = Math.max(2, Math.ceil(laneEntries.length * 0.22));
        if (chosen.pos < laneLen * 0.08) {
          const validOriginCluster = clusters
            .filter(
              (c) =>
                c.pos >= laneLen * 0.08 &&
                c.pos <= laneLen * 0.20 &&
                c.inCluster.length >= outerMin &&
                c.aggScore >= 0.35 * chosen.aggScore
            )
            .sort((a, b) => b.aggScore - a.aggScore)[0];
          if (validOriginCluster) chosen = validOriginCluster;
        }
        const strongOuterMin = Math.max(outerMin, Math.ceil(laneEntries.length * 0.30));
        const scoreRatio = chosen.pos <= laneLen * 0.18 ? 0.72 : 0.52;
        const countReq = chosen.pos <= laneLen * 0.18 ? strongOuterMin : outerMin;
        const outerCandidates = clusters
          .filter(
            (c) =>
              c.pos >= laneLen * 0.08 &&
              c.pos <= laneLen * 0.18 &&
              c.inCluster.length >= countReq &&
              c.pos < chosen.pos - laneLen * 0.04 &&
              c.aggScore >= scoreRatio * chosen.aggScore
          )
          .sort((a, b) => a.pos - b.pos);
        if (outerCandidates.length > 0) {
          chosen = outerCandidates[0];
        }
        const pos = Math.round(chosen.pos);
        const inCluster = chosen.inCluster;
        const aggScore = chosen.aggScore;

        // Fit initial smooth plate-space baseline preferring non-tailing clean dots
        const cleanPass1 = inCluster.filter((r) => !r.isTailing);
        const fitSrc1 = cleanPass1.length >= 4 ? cleanPass1 : inCluster;
        const backbonePlate = fitOriginQuadCurve(
          fitSrc1.map((r) => ({ laneId: r.laneId, pos: r.platePos })),
          pos,
          laneLen,
          frame.uByLane,
          frame.allLaneIds
        );

        const cleanDiams = fitSrc1.map((r) => r.fwhm).filter((w) => w >= 5).sort((a, b) => a - b);
        const plateMedianDiam = cleanDiams.length ? cleanDiams[cleanDiams.length >> 1] : undefined;

        const cFeats = inCluster.map((r) => r.feat).sort((a, b) => a - b);
        const cScores = inCluster.map((r) => r.score).sort((a, b) => a - b);
        const medFeat = cFeats[cFeats.length >> 1] || 20;
        const medScore = cScores[cScores.length >> 1] || 10;
        // Histogram-scaled floor keeps low-exposure Merck Explorer dots valid without loosening high-contrast noise rejection
        const histFeatFloor =
          h.sampleCount >= 16
            ? Math.min(14.0, Math.max(4.5, 3.8 * h.bgSigma, 0.12 * h.contrastSpan))
            : 14.0;
        const histBiFloor = Math.min(8.0, Math.max(2.5, 0.55 * histFeatFloor));
        const minFeat = Math.max(histFeatFloor, 0.28 * medFeat);
        const minBi = Math.max(histBiFloor, Math.min(14.0, 0.14 * medFeat));
        const minSnr = Math.max(5.5, 0.25 * medScore);

        // Second pass: lock spotted lanes onto their sharp origin peak within experimental spotting
        // error around the smooth plate-space backbone; missing-spot lanes stay smoothly on the backbone.
        const localRadius = Math.max(12, Math.round(laneLen * 0.016));
        const sortedEntries = rawLaneEntries.slice().sort((a, b) => a.laneId - b.laneId);
        const detected = sortedEntries.map((e) => {
          const refPlatePos = backbonePlate?.[e.laneId] ?? pos;
          const refLanePos = frame.toLanePos(e.laneId, refPlatePos);
          const near = detectOriginNearDetailed(
            e.profile,
            sign,
            refLanePos,
            localRadius,
            minFeat,
            minSnr,
            minBi,
            {
              metrics: e.metrics,
              laneWidthPx: e.lane?.width,
              plateMedianDiam,
            }
          );
          return {
            laneId: e.laneId,
            refPlatePos,
            refLanePos,
            pos: near.pos,
            platePos: near.pos > 0 ? frame.toPlatePos(e.laneId, near.pos) : 0,
            isTailing: near.isTailing,
          };
        });

        const validDetected = detected.filter((d) => d.pos > 0);
        const cleanDetected = validDetected.filter((d) => !d.isTailing);
        const fitSrc2 = cleanDetected.length >= 4 ? cleanDetected : validDetected;
        const refinedBackbonePlate =
          fitSrc2.length >= 4
            ? fitOriginQuadCurve(
                fitSrc2.map((d) => ({ laneId: d.laneId, pos: d.platePos })),
                pos,
                laneLen,
                frame.uByLane,
                frame.allLaneIds
              ) ?? backbonePlate
            : backbonePlate;

        let validCount = 0;
        const byLane: Record<number, number> = {};
        const lockedLanes: number[] = [];
        const tailingLanes: number[] = [];
        const smearTol = Math.max(6, Math.round(laneLen * 0.010));
        const smFlankIn = Math.max(6, Math.round(laneLen * 0.022));
        const smFlankOut = smFlankIn + Math.max(8, Math.round(laneLen * 0.030));
        const smBuf = new Float64Array(24);
        const profileById = new Map<number, number[]>(sortedEntries.map((e) => [e.laneId, e.profile]));

        for (const entry of detected) {
          const refPlate = refinedBackbonePlate?.[entry.laneId] ?? entry.refPlatePos;
          const refLine = Math.round(frame.toLanePos(entry.laneId, refPlate));
          if (entry.pos > 0) {
            let finalPos = entry.pos;
            let flaggedTail = entry.isTailing;
            // Smear-proof upward-tailing guard: if a polar compound rooted at refLine tails forward
            // and drags the detected peak well ahead of the smooth plate backbone, snap back to refLine.
            if (finalPos > refLine + smearTol) {
              const prof = profileById.get(entry.laneId);
              if (prof && prof.length > refLine + smFlankOut + 1 && refLine - smFlankOut >= 0) {
                const mBelow = windowMedian(prof, refLine - smFlankOut, refLine - smFlankIn, smBuf);
                const mAbove = windowMedian(prof, refLine + smFlankIn, refLine + smFlankOut, smBuf);
                const sigAtRef = sign * (prof[refLine] - mBelow);
                // Positive upwardTail means the region ahead of refLine is stained/quenched relative to behind
                const upwardTail = sign * (mAbove - mBelow);
                if (upwardTail > Math.max(4.0, 0.14 * medFeat) && sigAtRef > Math.max(8.0, 0.25 * medFeat)) {
                  finalPos = refLine;
                  flaggedTail = true;
                }
              }
            }
            validCount++;
            byLane[entry.laneId] = finalPos;
            lockedLanes.push(entry.laneId);
            if (flaggedTail) tailingLanes.push(entry.laneId);
          } else {
            byLane[entry.laneId] = refLine;
          }
        }

        if (aggScore > best.score || validCount >= minNeeded) {
          best = {
            pos,
            score: Math.max(best.score, aggScore),
            byLane,
            lockedLanes,
            tailingLanes,
            validFrac: validCount / Math.max(1, laneEntries.length),
            medFeat,
          };
        }
      }
    }
  }

  if (best.pos <= 10 && laneEntries.length >= 6) {
    const faint = detectFaintOriginRow(laneEntries, sign, laneLen, frame, histBgSigma);
    if (faint.pos > 10) best = faint;
  }

  return best;
}

/**
 * Builds a normalized multi-channel composite origin dataset combining positive dot signals
 * across all supplied unclipped channels (UV254 darkening + UV366 fluorescence + White stain),
 * preserving dominant-channel 2D metrics so edge dust specks stay rejected in composite mode.
 */
function buildCompositeOriginEntries(
  halfLanes: TlcLane[],
  channelInputs: Array<{
    ch: TlcChannelKey;
    sign: number;
    entriesById: Map<number, OriginLaneEntry>;
    hist: ProfileHistogramStats;
  }>
): { entries: OriginLaneEntry[]; hist: ProfileHistogramStats } | null {
  if (channelInputs.length < 2) return null;
  const outEntries: OriginLaneEntry[] = [];

  for (const l of halfLanes) {
    const perCh: Array<{
      norm: Float32Array;
      metrics?: Lane2dMetrics;
    }> = [];
    let minLen = Infinity;

    for (const ci of channelInputs) {
      const e = ci.entriesById.get(l.id);
      if (!e || e.profile.length < 20) continue;
      if (e.profile.length < minLen) minLen = e.profile.length;
    }
    if (!Number.isFinite(minLen) || minLen < 20) continue;

    for (const ci of channelInputs) {
      const e = ci.entriesById.get(l.id);
      if (!e || e.profile.length < minLen) continue;
      // Estimate clean silica background in the origin region [3%..35%] using median-biased clean quantile
      const zLo = Math.max(2, Math.floor(minLen * 0.03));
      const zHi = Math.min(minLen - 2, Math.floor(minLen * 0.35));
      const zLen = Math.max(1, zHi - zLo + 1);
      const zBuf = new Float64Array(zLen);
      for (let k = 0; k < zLen; k++) zBuf[k] = e.profile[zLo + k];
      zBuf.sort();
      const bgIdx =
        ci.sign < 0
          ? Math.min(zLen - 1, Math.floor(zLen * 0.72))
          : Math.max(0, Math.floor(zLen * 0.28));
      const laneBg = zBuf[bgIdx];
      // Preserve real background noise floor and NEVER amplify low-contrast channels above 1.0x
      // so faint noisy UV366/White halos stay at their true physical contrast instead of getting
      // inflated into fake high-SNR dots.
      const bgSig = ci.hist.sampleCount >= 16 ? ci.hist.bgSigma : 1.5;
      const scale = Math.max(180, ci.hist.sampleCount >= 16 ? ci.hist.contrastSpan : 180);
      const gain = Math.min(1.0, 180 / scale);
      const negFloor = -3.0 * bgSig * gain;
      const norm = new Float32Array(minLen);
      for (let i = 0; i < minLen; i++) {
        const signedDev = ci.sign * (e.profile[i] - laneBg) * gain;
        norm[i] = Math.max(negFloor, Math.min(255, signedDev));
      }
      perCh.push({ norm, metrics: e.metrics });
    }
    if (perCh.length < 2) continue;

    const compProfile = new Array<number>(minLen);
    const has2d = perCh.some((c) => !!c.metrics);
    let compMetrics: Lane2dMetrics | undefined;
    const latArr = has2d ? new Float32Array(minLen) : undefined;
    const erArr = has2d ? new Float32Array(minLen) : undefined;
    const swArr = has2d ? new Float32Array(minLen) : undefined;
    const rmArr = has2d ? new Float32Array(minLen) : undefined;
    const fpArr = has2d ? new Float32Array(minLen) : undefined;
    const rgbArr = has2d ? new Float32Array(minLen * 3) : undefined;

    for (let i = 0; i < minLen; i++) {
      let max1 = -Infinity;
      let max2 = -Infinity;
      let domIdx = 0;
      for (let c = 0; c < perCh.length; c++) {
        const v = perCh[c].norm[i];
        if (v > max1) {
          max2 = max1;
          max1 = v;
          domIdx = c;
        } else if (v > max2) {
          max2 = v;
        }
      }
      const boost = max2 > 0 ? 0.25 * max2 : 0;
      compProfile[i] = Math.max(0, Math.min(255, 20 + max1 + boost));
      if (has2d && latArr && erArr && swArr && rmArr && fpArr) {
        const dm = perCh[domIdx].metrics ?? perCh.find((c) => c.metrics)?.metrics;
        if (dm && i < dm.edgeRatio.length) {
          latArr[i] = dm.lateralExcess[i];
          erArr[i] = dm.edgeRatio[i];
          swArr[i] = dm.spotWidth[i];
          rmArr[i] = dm.rowMass[i];
          fpArr[i] = dm.flankProfile[i];
        } else {
          latArr[i] = 999;
          erArr[i] = 0;
        }
      }
    }

    if (has2d && latArr && erArr && swArr && rmArr && fpArr && rgbArr) {
      const anyOff = perCh.every((c) => c.metrics?.offPlate);
      const anyStraddle = perCh.every((c) => c.metrics?.borderStraddle);
      compMetrics = {
        lateralExcess: latArr,
        edgeRatio: erArr,
        coreRgb: rgbArr,
        bgRgb: [0, 0, 0],
        offPlate: anyOff,
        borderStraddle: anyStraddle,
        rowMass: rmArr,
        spotWidth: swArr,
        flankProfile: fpArr,
      };
    }

    outEntries.push({
      laneId: l.id,
      profile: compProfile,
      lane: l,
      metrics: compMetrics,
    });
  }

  if (outEntries.length < 3) return null;
  const compHist = analyzeProfileHistogram(
    outEntries.map((e) => e.profile),
    1,
    0.06,
    0.90
  );
  return { entries: outEntries, hist: compHist };
}

interface MultiChannelOriginSolveResult {
  best: ChannelOriginResult;
  frame: OriginPlateFrame;
}

function solveMultiChannelHalfOrigin(
  set: TlcSet,
  halfLanes: TlcLane[],
  laneLen: number,
  channels: TlcChannelKey[],
  getProfile: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): MultiChannelOriginSolveResult {
  let best: ChannelOriginResult = { pos: 0, score: 0 };
  let bestClipped = false;
  let bestSourceId: string | null = null;

  interface OriginSourceData {
    id: string;
    sign: number;
    entries: OriginLaneEntry[];
    entriesById: Map<number, OriginLaneEntry>;
    hist: ProfileHistogramStats;
    clipped: boolean;
    isComposite: boolean;
    res: ChannelOriginResult;
  }

  const perSourceData: OriginSourceData[] = [];
  const singleUnclippedForComp: Array<{
    ch: TlcChannelKey;
    sign: number;
    entriesById: Map<number, OriginLaneEntry>;
    hist: ProfileHistogramStats;
  }> = [];

  const considerCandidate = (src: OriginSourceData) => {
    const res = src.res;
    if (res.pos <= 10) return;
    const bestSolid = best.pos > 10 && best.score >= 8 && (best.validFrac ?? 0) >= 0.22;
    if (!bestSolid) {
      if (res.score > best.score) {
        best = res;
        bestClipped = src.clipped;
        bestSourceId = src.id;
      }
    } else if (
      (bestClipped && !src.clipped && res.score >= 8 && (res.validFrac ?? 0) >= 0.22) ||
      ((res.validFrac ?? 0) > (best.validFrac ?? 0) + 0.15 &&
        (src.isComposite || (res.medFeat ?? 0) > (best.medFeat ?? 0) * 1.1) &&
        res.score >= (src.isComposite ? best.score * 0.85 : best.score * 1.25))
    ) {
      best = res;
      bestClipped = src.clipped;
      bestSourceId = src.id;
    }
  };

  for (const ch of channels) {
    const chSign = TLC_SIGNAL[ch]?.sign ?? -1;
    const entries: OriginLaneEntry[] = halfLanes
      .map((l) => ({
        laneId: l.id,
        profile: getProfile(set, ch, l),
        lane: l,
        metrics: getCachedLane2dMetrics(set, ch, l),
      }))
      .filter((e) => e.profile.length > 0);
    if (!entries.length) continue;
    const chHist =
      getChannelHistogram(set, ch, getProfile) ??
      analyzeProfileHistogram(entries.map((e) => e.profile), chSign, 0.06, 0.90);
    const resClipped = chSign < 0 ? chHist.clipHighFrac > 0.25 : chHist.clipLowFrac > 0.25;
    const res = detectChannelOrigin(entries, chSign, laneLen, chHist);
    const entriesById = new Map<number, OriginLaneEntry>(entries.map((e) => [e.laneId, e]));
    const src: OriginSourceData = {
      id: ch,
      sign: chSign,
      entries,
      entriesById,
      hist: chHist,
      clipped: resClipped,
      isComposite: false,
      res,
    };
    perSourceData.push(src);
    considerCandidate(src);
    if (!resClipped) {
      singleUnclippedForComp.push({ ch, sign: chSign, entriesById, hist: chHist });
    }
  }

  // Build and evaluate multi-channel composite origin views (all unclipped channels, plus UV-only
  // when UV254 + UV366 + White are all loaded) so split-channel plates & faint multi-channel dots
  // are detected just like the composite solvent front.
  const compositeGroups: Array<{ id: string; group: typeof singleUnclippedForComp }> = [];
  if (singleUnclippedForComp.length >= 2) {
    compositeGroups.push({ id: 'CompositeAll', group: singleUnclippedForComp });
    const uvOnly = singleUnclippedForComp.filter((c) => c.ch === 'UV254' || c.ch === 'UV366');
    if (singleUnclippedForComp.length >= 3 && uvOnly.length === 2) {
      compositeGroups.push({ id: 'CompositeUV', group: uvOnly });
    }
  }
  for (const cg of compositeGroups) {
    const built = buildCompositeOriginEntries(halfLanes, cg.group);
    if (!built) continue;
    const res = detectChannelOrigin(built.entries, 1, laneLen, built.hist);
    const src: OriginSourceData = {
      id: cg.id,
      sign: 1,
      entries: built.entries,
      entriesById: new Map(built.entries.map((e) => [e.laneId, e])),
      hist: built.hist,
      clipped: false,
      isComposite: true,
      res,
    };
    perSourceData.push(src);
    considerCandidate(src);
  }

  const fallbackEntries: OriginLaneEntry[] = halfLanes.map((l) => ({
    laneId: l.id,
    profile: [],
    lane: l,
  }));
  const primarySrc = perSourceData.find((s) => s.id === bestSourceId) ?? perSourceData[0];
  const frame = buildOriginPlateFrame(primarySrc?.entries?.length ? primarySrc.entries : fallbackEntries, laneLen);

  // Multi-channel & composite joint origin refinement (in physical plate-space!):
  // 1. Rescue UV-silent lanes from any agreeing unclipped secondary channel or composite.
  // 2. If a lane is heavily tailing on the primary channel, upgrade it if another unclipped
  //    channel shows a clean, non-tailing origin dot near the same position.
  // 3. Refit the smooth physical plate-space baseline across clean locked anchors so all blank
  //    lanes stay aligned on one smooth curve even when lane.y0 varies in a microadjusted CSV.
  if (best.pos > 10 && best.byLane && perSourceData.length > 1) {
    const agreeTol = Math.max(16, Math.round(laneLen * 0.035));
    const localRadius = Math.max(12, Math.round(laneLen * 0.016));
    const locked = new Set<number>(best.lockedLanes || []);
    const tailingSet = new Set<number>(best.tailingLanes || []);
    const fusedByLane: Record<number, number> = { ...best.byLane };

    const secondarySources = perSourceData.filter(
      (c) =>
        c.id !== bestSourceId &&
        !c.clipped &&
        (c.res.pos <= 10 || Math.abs(c.res.pos - best.pos) <= agreeTol)
    );

    let updatedAny = false;
    for (const l of halfLanes) {
      const refPos = fusedByLane[l.id] ?? Math.round(frame.toLanePos(l.id, best.pos));
      const isLocked = locked.has(l.id);
      const isTailing = tailingSet.has(l.id);

      if (isLocked && !isTailing) continue;

      for (const sec of secondarySources) {
        const secTailing = sec.res.tailingLanes?.includes(l.id) ?? false;
        // If the secondary channel/composite already locked this lane cleanly right on refPos:
        if (sec.res.lockedLanes?.includes(l.id) && sec.res.byLane?.[l.id]) {
          const secPos = sec.res.byLane[l.id];
          if (Math.abs(secPos - refPos) <= 3 && (!isLocked || !secTailing)) {
            fusedByLane[l.id] = secPos;
            locked.add(l.id);
            if (!secTailing) tailingSet.delete(l.id);
            updatedAny = true;
            break;
          }
        }
        // Otherwise probe strictly around refPos on the secondary source with blank-safe & halo-safe floors
        const entry = sec.entriesById.get(l.id);
        if (!entry) continue;
        const secFeatFloor =
          sec.hist.sampleCount >= 16
            ? Math.min(26.0, Math.max(16.0, 5.0 * sec.hist.bgSigma, 0.16 * sec.hist.contrastSpan))
            : 18.0;
        const secBiFloor = Math.min(15.0, Math.max(9.0, 0.55 * secFeatFloor));
        const near = detectOriginNearDetailed(
          entry.profile,
          sec.sign,
          refPos,
          localRadius,
          secFeatFloor,
          6.5,
          secBiFloor,
          {
            metrics: entry.metrics,
            laneWidthPx: l.width,
          }
        );
        if (near.pos > 0 && (!isLocked || !near.isTailing)) {
          fusedByLane[l.id] = near.pos;
          locked.add(l.id);
          if (!near.isTailing) tailingSet.delete(l.id);
          updatedAny = true;
          break;
        }
      }
    }

    if (updatedAny && locked.size >= 4) {
      const cleanIds = Array.from(locked).filter((id) => !tailingSet.has(id));
      const fitIds = cleanIds.length >= 4 ? cleanIds : Array.from(locked);
      const lockedPts = fitIds.map((id) => ({
        laneId: id,
        pos: frame.toPlatePos(id, fusedByLane[id]),
      }));
      const jointBackbonePlate = fitOriginQuadCurve(
        lockedPts,
        best.pos,
        laneLen,
        frame.uByLane,
        frame.allLaneIds
      );
      if (jointBackbonePlate) {
        for (const l of halfLanes) {
          if (!locked.has(l.id) && jointBackbonePlate[l.id] != null) {
            fusedByLane[l.id] = Math.round(frame.toLanePos(l.id, jointBackbonePlate[l.id]));
          }
        }
      }
    }
    best = {
      ...best,
      byLane: fusedByLane,
      lockedLanes: Array.from(locked),
      tailingLanes: Array.from(tailingSet),
      validFrac: halfLanes.length > 0 ? locked.size / halfLanes.length : best.validFrac,
    };
  }

  return { best, frame };
}

/**
 * Rigidly registers an undeveloped (pre-run) plate's clean origin row onto the developed plate
 * (handling small box-corner placement shift + tiny rotation via matched un-eluted anchor dots)
 * and merges per-lane origins so eluted, blank, faint-halo, and smearing lanes inherit their exact
 * pre-run spotting coordinates while clean developed dots contribute sub-pixel agreement.
 */
export function mergePreRunWithDevelopedOrigin(
  devRes: ChannelOriginResult,
  preRes: ChannelOriginResult,
  halfLanes: TlcLane[],
  laneLen: number,
  frame?: OriginPlateFrame
): { res: ChannelOriginResult; alignment: TlcPreRunAlignment } {
  const effFrame =
    frame ??
    buildOriginPlateFrame(
      halfLanes.map((l) => ({ laneId: l.id, profile: [], lane: l })),
      laneLen
    );

  const preLocked = new Set<number>(preRes.lockedLanes || []);
  const devLocked = new Set<number>(devRes.lockedLanes || []);
  const devTailing = new Set<number>(devRes.tailingLanes || []);
  const maxBoxShift = Math.max(55, Math.round(laneLen * 0.09)); // ±9% (~9 mm) box-corner tolerance

  // Collect clean matched anchor pairs (un-smeared dots detected on BOTH pre-run & developed photos)
  const anchors: Array<{ id: number; u: number; delta: number }> = [];
  if (devRes.pos > 10 && devRes.byLane && preRes.byLane) {
    for (const l of halfLanes) {
      if (!preLocked.has(l.id) || !devLocked.has(l.id) || devTailing.has(l.id)) continue;
      const preLanePos = preRes.byLane[l.id];
      const devLanePos = devRes.byLane[l.id];
      if (preLanePos == null || devLanePos == null) continue;
      const delta = effFrame.toPlatePos(l.id, devLanePos) - effFrame.toPlatePos(l.id, preLanePos);
      if (Math.abs(delta) <= maxBoxShift) {
        anchors.push({ id: l.id, u: effFrame.uByLane.get(l.id) ?? 0, delta });
      }
    }
  }

  let shiftA = 0;
  let tiltB = 0;
  let matchedAnchors = anchors.length;
  let residualPx = 0;
  let mode: 'rigid-merged' | 'direct-box' = 'direct-box';

  const maxTiltB = Math.max(18, Math.round(laneLen * 0.03)); // max ~1.8° placement tilt across plate

  if (anchors.length >= 4) {
    mode = 'rigid-merged';
    const deltas = anchors.map((a) => a.delta).sort((x, y) => x - y);
    const medDelta = deltas[deltas.length >> 1];
    const inlierTol = Math.max(maxTiltB + 6, Math.round(laneLen * 0.032));
    let inliers = anchors.filter((a) => Math.abs(a.delta - medDelta) <= inlierTol);
    if (inliers.length < 3) inliers = anchors;

    const fitLine = (pts: typeof anchors): { a: number; b: number } => {
      let n = pts.length;
      let su = 0;
      let sd = 0;
      let suu = 0;
      let sud = 0;
      for (const p of pts) {
        su += p.u;
        sd += p.delta;
        suu += p.u * p.u;
        sud += p.u * p.delta;
      }
      const denom = n * suu - su * su;
      if (denom < 1e-4) return { a: sd / Math.max(1, n), b: 0 };
      const bRaw = (n * sud - su * sd) / denom;
      const b = Math.max(-maxTiltB, Math.min(maxTiltB, bRaw));
      const a = (sd - b * su) / n;
      return { a, b };
    };

    let { a, b } = fitLine(inliers);
    // One robust IRLS trim pass to reject any single drifted developed dot
    const res1 = inliers.map((p) => Math.abs(p.delta - (a + b * p.u))).sort((x, y) => x - y);
    const mad1 = res1[res1.length >> 1] ?? 0;
    const trimThr = Math.max(4.0, 2.2 * mad1);
    const trimmed = inliers.filter((p) => Math.abs(p.delta - (a + b * p.u)) <= trimThr);
    if (trimmed.length >= 3) {
      ({ a, b } = fitLine(trimmed));
      inliers = trimmed;
    }
    shiftA = Math.max(-maxBoxShift, Math.min(maxBoxShift, a));
    tiltB = b;
    matchedAnchors = inliers.length;
    const finalRes = inliers.map((p) => Math.abs(p.delta - (shiftA + tiltB * p.u))).sort((x, y) => x - y);
    residualPx = finalRes[finalRes.length >> 1] ?? 0;
  } else if (anchors.length >= 2) {
    mode = 'rigid-merged';
    const deltas = anchors.map((a) => a.delta).sort((x, y) => x - y);
    shiftA = deltas[deltas.length >> 1];
    tiltB = 0;
    const finalRes = anchors.map((p) => Math.abs(p.delta - shiftA)).sort((x, y) => x - y);
    residualPx = finalRes[finalRes.length >> 1] ?? 0;
  } else if (devRes.pos > 10 && preRes.pos > 10) {
    const rawShift = devRes.pos - preRes.pos;
    if (Math.abs(rawShift) <= maxBoxShift) {
      mode = 'rigid-merged';
      shiftA = rawShift;
      tiltB = 0;
      matchedAnchors = anchors.length;
    }
  }

  // Merge rigidly aligned pre-run origins with developed-plate origins within percentage tolerance
  const mergeTol = Math.max(4, Math.round(laneLen * 0.006)); // ~0.6% (~6 px) agreement band
  const maxLocalRefine = Math.max(10, Math.round(laneLen * 0.014)); // ~1.4% max local warp pull
  const mergedByLane: Record<number, number> = {};
  const mergedLocked = new Set<number>(preLocked);
  const platePositions: number[] = [];

  for (const l of halfLanes) {
    const u = effFrame.uByLane.get(l.id) ?? 0;
    const preLanePos = preRes.byLane?.[l.id];
    const prePlate = preLanePos != null ? effFrame.toPlatePos(l.id, preLanePos) : preRes.pos;
    const alignedPlate = prePlate + shiftA + tiltB * u;

    const isDevClean = devLocked.has(l.id) && !devTailing.has(l.id) && devRes.byLane?.[l.id] != null;
    let finalPlate = alignedPlate;
    if (isDevClean) {
      const devPlate = effFrame.toPlatePos(l.id, devRes.byLane![l.id]);
      const diff = devPlate - alignedPlate;
      if (Math.abs(diff) <= mergeTol) {
        // Both pre-run and clean developed dot agree within tolerance: precision blend
        finalPlate = 0.55 * alignedPlate + 0.45 * devPlate;
        mergedLocked.add(l.id);
      } else if (Math.abs(diff) <= maxLocalRefine) {
        // Slight local warp: bounded gentle pull toward developed dot, capped at mergeTol
        finalPlate = alignedPlate + Math.sign(diff) * Math.min(mergeTol, 0.35 * Math.abs(diff));
        mergedLocked.add(l.id);
      }
      // Large outlier on developed plate (> maxLocalRefine) stays on aligned pre-run coordinate
    }

    platePositions.push(finalPlate);
    const localPos = Math.round(effFrame.toLanePos(l.id, finalPlate));
    mergedByLane[l.id] = Math.max(4, Math.min(laneLen - 4, localPos));
  }

  platePositions.sort((a, b) => a - b);
  const medPos = platePositions.length ? Math.round(platePositions[platePositions.length >> 1]) : Math.round(preRes.pos + shiftA);
  const laneSpanCount = Math.max(1, halfLanes.length - 1);
  const alignment: TlcPreRunAlignment = {
    dyPx: Math.round(shiftA * 10) / 10,
    slopePxPerLane: Math.round(((2 * tiltB) / laneSpanCount) * 100) / 100,
    matchedAnchors,
    residualPx: Math.round(residualPx * 10) / 10,
    mode,
  };

  return {
    res: {
      pos: medPos,
      score: Math.max(preRes.score, devRes.score),
      byLane: mergedByLane,
      lockedLanes: Array.from(mergedLocked),
      tailingLanes: [],
      validFrac: halfLanes.length > 0 ? mergedLocked.size / halfLanes.length : preRes.validFrac,
      medFeat: Math.max(preRes.medFeat ?? 0, devRes.medFeat ?? 0),
    },
    alignment,
  };
}

// Spot origin resolution: explicit microadjusted lane.zeroRf -> manual set.originPx override ->
// optional pre-run undeveloped plate registration merged with multi-channel developed origin ->
// multi-channel + composite joint origin peak fallback -> ~10% lane length
export function tlcOrigin(
  set: TlcSet,
  lane: TlcLane,
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): number {
  if (lane.zeroRf != null && lane.zeroRf > 0) return lane.zeroRf;
  if (set.originPx != null && set.originPx > 0) return set.originPx;

  const channels = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((k) => !!set.imgs?.[k]);
  const preChannels =
    set.preRunEnabled !== false
      ? (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((k) => !!set.preRunImgs?.[k])
      : [];
  if ((!channels.length && !preChannels.length) || !getProfile || !set.cfg) {
    return Math.max(20, Math.round(lane.length * 0.10));
  }

  const sig = autoCacheSignature(set);
  if ((set as any)._autoCacheSig !== sig) {
    set.frontAuto = {};
    set.frontAutoByLane = {};
    set.originAuto = {};
    set.originAutoByLane = {};
    set.preRunAlignment = {};
    set.autoConf = {};
    (set as any)._histCache = {};
    (set as any)._prof2d = {};
    (set as any)._autoCacheSig = sig;
  }

  set.originAuto = set.originAuto || {};
  set.originAutoByLane = set.originAutoByLane || {};
  const h = tlcHalf(lane);
  if (set.originAuto[h] == null) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    const devSolved = channels.length
      ? solveMultiChannelHalfOrigin(set, halfLanes, lane.length, channels, getProfile)
      : {
          best: { pos: 0, score: 0 } as ChannelOriginResult,
          frame: buildOriginPlateFrame(
            halfLanes.map((l) => ({ laneId: l.id, profile: [], lane: l })),
            lane.length
          ),
        };
    let best = devSolved.best;

    // If spotted-but-undeveloped pre-run reference photos are uploaded for this plate, detect
    // their clean un-eluted origin dots across all pre-run channels + composite and rigidly merge
    // them with the developed plate's origin anchors (falling back cleanly to devSolved if needed).
    if (preChannels.length > 0) {
      const preProbeSet: TlcSet = {
        ...set,
        imgs: (set.preRunImgs || {}) as Record<string, TlcImageEntry>,
        preRunImgs: undefined,
        preRunEnabled: false,
        prof: {},
        frontAuto: {},
        frontAutoByLane: {},
        originAuto: {},
        originAutoByLane: {},
        autoConf: {},
      };
      (preProbeSet as any)._isPreRunProbe = true;
      (preProbeSet as any)._prof2d = {};
      (preProbeSet as any)._histCache = {};
      const preSolved = solveMultiChannelHalfOrigin(preProbeSet, halfLanes, lane.length, preChannels, getProfile);
      if (preSolved.best.pos > 10 && preSolved.best.byLane) {
        const merged = mergePreRunWithDevelopedOrigin(
          devSolved.best,
          preSolved.best,
          halfLanes,
          lane.length,
          devSolved.frame
        );
        best = merged.res;
        set.preRunAlignment = set.preRunAlignment || {};
        set.preRunAlignment[h] = merged.alignment;
      } else if (set.preRunAlignment) {
        delete set.preRunAlignment[h];
      }
    } else if (set.preRunAlignment) {
      delete set.preRunAlignment[h];
    }

    set.autoConf = set.autoConf || {};
    set.autoConf[`origin${h}`] = { detected: best.pos > 10, score: best.pos > 10 ? best.score : 0 };
    if (best.pos > 10) {
      set.originAuto[h] = best.pos;
      if (best.byLane) {
        Object.assign(set.originAutoByLane, best.byLane);
      }
    }
  }

  return set.originAutoByLane?.[lane.id] ?? set.originAuto?.[h] ?? Math.max(20, Math.round(lane.length * 0.10));
}

export interface DetectionNote {
  label: string;
  source: 'detected' | 'default guess' | 'manual';
  score: number;
  warning?: string;
}

/** Plain-language confidence for auto front/origin of every half. */
export function tlcDetectionNotes(
  set: TlcSet,
  getProfile: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): DetectionNote[] {
  const lanes = set.cfg?.lanes ?? [];
  const notes: DetectionNote[] = [];
  const halves = Array.from(new Set(lanes.map((l) => tlcHalf(l)))).sort();
  const name = (h: number) => (halves.length > 1 ? (h === 0 ? ', lower half' : ', upper half') : '');
  const pos: Record<string, number> = {};
  for (const h of halves) {
    const lane = lanes.find((l) => tlcHalf(l) === h)!;
    const frontManual = (set.frontHalfPx?.[h] ?? 0) > 0 || (set.frontPx ?? 0) > 0;
    const originManual = (set.originPx ?? 0) > 0 || (lane.zeroRf ?? 0) > 0;
    const f = tlcFront(set, lane, getProfile);
    if (!originManual) tlcOrigin(set, lane, getProfile);
    pos[`f${h}`] = f / lane.length;
    const fc = set.autoConf?.[`front${h}`];
    const oc = set.autoConf?.[`origin${h}`];
    const fn: DetectionNote = frontManual
      ? { label: `Front${name(h)}`, source: 'manual', score: 0 }
      : { label: `Front${name(h)}`, source: fc?.detected ? 'detected' : 'default guess', score: fc?.score ?? 0 };
    if (fn.source === 'default guess') {
      fn.warning = 'No clear solvent front found; 93% of lane length is assumed. Rf values depend on it.';
    } else if (fn.source === 'detected' && fn.score < 6) {
      fn.warning = 'Weak front signal; check the line position.';
    }
    if (fn.source !== 'manual' && f / lane.length > 0.97) {
      fn.warning = 'Front is at the edge of the search window.';
    }
    const on: DetectionNote = originManual
      ? { label: `Origin${name(h)}`, source: 'manual', score: 0 }
      : { label: `Origin${name(h)}`, source: oc?.detected ? 'detected' : 'default guess', score: oc?.score ?? 0 };
    if (on.source === 'default guess') {
      on.warning = 'No clear origin spots found; 10% of lane length is assumed.';
    }
    notes.push(fn, on);
  }
  if (halves.length > 1 && Math.abs(pos[`f${halves[0]}`] - pos[`f${halves[1]}`]) > 0.06) {
    const fr = notes.find((n) => n.label.startsWith('Front'));
    if (fr) fr.warning = 'The two halves disagree on the front by more than 6% of lane length.';
  }
  return notes;
}

export interface TlcAnalysisExportOptions {
  set: TlcSet;
  sets?: TlcSet[];
  run?: RunResult | null;
  plateIndex?: number;
  getSpots: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => TlcSpot[] | null;
  getProfile?: (set: TlcSet, key: any, lane: TlcLane) => number[];
  spotProminence?: number;
  spotMode?: string;
  coreFraction?: number;
  scope?: 'current' | 'all';
}

// Export comprehensive TLC Plate Analysis Data as CSV spreadsheet
export function exportTlcAnalysisCsv(options: TlcAnalysisExportOptions): string {
  const {
    set,
    sets = [set],
    run,
    plateIndex = 0,
    getSpots,
    getProfile,
    scope = 'current',
  } = options;

  const targetSets = (scope === 'all' ? sets : [set]).map((s) =>
    s.plateData ? getTlcPlateSlice(s, plateIndex) : s
  );
  const codes = run?.reagents?.map((r) => r.code) || [];

  const rowsData: Array<{
    setName: string;
    plate: number;
    well: string;
    laneId: number;
    reactionIndex: string | number;
    reagentConcs: Record<string, string | number>;
    solventUl: string | number;
    channel: string;
    originPx: number;
    frontPx: number;
    spanPx: number;
    spots: TlcSpot[];
  }> = [];

  let maxSpotsCount = 0;

  for (const s of targetSets) {
    if (!s.cfg) continue;
    const availableChannels: TlcChannelKey[] = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter(
      (k) => !!s.imgs[k]
    );
    if (!availableChannels.length) continue;

    for (const l of [...s.cfg.lanes].sort((a, b) => a.id - b.id)) {
      if (l.id < 0 || l.id > 53) continue;
      const vialId = containerOfLane(l.id);
      const row = run?.rows?.find(
        (r) => r.plate_number === plateIndex && r.container_id === vialId
      );

      const originPx = Math.round(tlcOrigin(s, l, getProfile));
      const frontPx = tlcFront(s, l, getProfile);
      const spanPx = Math.max(1, frontPx - originPx);

      for (const ch of availableChannels) {
        const spots = getSpots(s, ch, l) || [];
        if (spots.length > maxSpotsCount) {
          maxSpotsCount = spots.length;
        }

        const concs: Record<string, string | number> = {};
        codes.forEach((c) => {
          const rc = row && row.recipe?.find((x: any) => x.code === c);
          concs[c] = rc ? +rc.target_concentration.toFixed(4) : '';
        });

        rowsData.push({
          setName: s.name,
          plate: plateIndex + 1,
          well: wellLabel(vialId),
          laneId: l.id,
          reactionIndex: row ? row.global_index + 1 : '',
          reagentConcs: concs,
          solventUl: row && row['vol#solvent'] != null ? +(+row['vol#solvent']).toFixed(2) : '',
          channel: TLC_SIGNAL[ch]?.label || ch,
          originPx,
          frontPx,
          spanPx,
          spots,
        });
      }
    }
  }

  // Ensure minimum 5 spot columns so format remains consistent
  const spotColsCount = Math.max(5, maxSpotsCount);

  // Build CSV header
  const head = [
    'plate',
    'set_name',
    'well',
    'tlc_lane',
    'reaction',
    ...codes.map((c) => `${c}_mM`),
    'solvent_uL',
    'channel',
    'origin_px',
    'front_px',
    'migration_span_px',
    'spot_count',
    'primary_rf',
    'delta_rf',
  ];

  for (let n = 1; n <= spotColsCount; n++) {
    head.push(`rf_${n}`, `strength_${n}`, `area_pct_${n}`, `pos_px_${n}`);
  }

  const csvRows: string[][] = [head];

  for (const item of rowsData) {
    const strongest = [...item.spots].sort((a, b) => b.strength - a.strength);
    const primaryRf = strongest.length > 0 ? +strongest[0].rf.toFixed(3) : '';
    let deltaRf: string | number = '';
    if (item.spots.length >= 2) {
      const sortedByRf = [...item.spots].sort((a, b) => a.rf - b.rf);
      deltaRf = +(sortedByRf[sortedByRf.length - 1].rf - sortedByRf[0].rf).toFixed(3);
    }

    const rowCells: (string | number)[] = [
      item.plate,
      item.setName,
      item.well,
      item.laneId,
      item.reactionIndex,
      ...codes.map((c) => item.reagentConcs[c] ?? ''),
      item.solventUl,
      item.channel,
      item.originPx,
      item.frontPx,
      item.spanPx,
      item.spots.length,
      primaryRf,
      deltaRf,
    ];

    for (let n = 0; n < spotColsCount; n++) {
      const sp = item.spots[n];
      if (sp) {
        rowCells.push(
          +sp.rf.toFixed(3),
          +sp.strength.toFixed(2),
          sp.areaPct != null ? sp.areaPct : '',
          Math.round(sp.pos)
        );
      } else {
        rowCells.push('', '', '', '');
      }
    }

    csvRows.push(rowCells.map((v) => (v === null || v === undefined ? '' : String(v))));
  }

  return csvText(csvRows);
}

// Export complete TLC Plate Analysis Data as structured JSON
export function exportTlcAnalysisJson(options: TlcAnalysisExportOptions): string {
  const {
    set,
    sets = [set],
    run,
    plateIndex = 0,
    getSpots,
    getProfile,
    spotProminence = 0.28,
    spotMode = 'standard',
    coreFraction = 0.40,
    scope = 'current',
  } = options;

  const targetSets = (scope === 'all' ? sets : [set]).map((s) =>
    s.plateData ? getTlcPlateSlice(s, plateIndex) : s
  );

  const exportPayload = {
    format: 'Robowski-TLC-Analysis-Export',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    scope,
    plateNumber: plateIndex + 1,
    analysisParameters: {
      spotProminence,
      spotMode,
      coreFraction,
    },
    runInfo: run
      ? {
          runName: run.runName,
          mode: run.mode,
          plates: run.plates,
          vialVolume: run.vialVolume,
          reagents: run.reagents.map((r) => ({
            code: r.code,
            name: r.name,
            stock: r.stock,
            solvent: r.solvent,
          })),
        }
      : null,
    plates: targetSets.map((s) => {
      const availableChannels: TlcChannelKey[] = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter(
        (k) => !!s.imgs[k]
      );

      const lanesData = (s.cfg?.lanes || [])
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((l) => {
          const vialId = containerOfLane(l.id);
          const row = run?.rows?.find(
            (r) => r.plate_number === plateIndex && r.container_id === vialId
          );

          const originPx = Math.round(tlcOrigin(s, l, getProfile));
          const frontPx = tlcFront(s, l, getProfile);
          const spanPx = Math.max(1, frontPx - originPx);

          const channelsData: Record<string, any> = {};

          availableChannels.forEach((ch) => {
            const spots = getSpots(s, ch, l) || [];
            const strongest = [...spots].sort((a, b) => b.strength - a.strength);
            const primaryRf = strongest.length > 0 ? +strongest[0].rf.toFixed(3) : null;
            let deltaRf: number | null = null;
            if (spots.length >= 2) {
              const sortedByRf = [...spots].sort((a, b) => a.rf - b.rf);
              deltaRf = +(sortedByRf[sortedByRf.length - 1].rf - sortedByRf[0].rf).toFixed(3);
            }

            channelsData[ch] = {
              channelKey: ch,
              channelLabel: TLC_SIGNAL[ch]?.label || ch,
              spotCount: spots.length,
              primaryRf,
              deltaRf,
              spots: spots.map((sp) => ({
                rf: +sp.rf.toFixed(3),
                posPx: Math.round(sp.pos),
                strength: +sp.strength.toFixed(2),
                areaPct: sp.areaPct != null ? sp.areaPct : undefined,
                label: sp.label,
              })),
            };
          });

          return {
            laneId: l.id,
            well: wellLabel(vialId),
            wellCoordinate: wellLabel(vialId),
            vialId,
            reactionNumber: row ? row.global_index + 1 : null,
            geometry: {
              x0: l.x0,
              y0: l.y0,
              length: l.length,
              width: l.width,
              angle: l.angle,
              spotRadius: l.spotRadius,
              zeroRf: l.zeroRf,
            },
            originPx,
            frontPx,
            migrationSpanPx: spanPx,
            reagents: row
              ? row.recipe
                  .filter((rc: any) => rc.target_concentration > 0)
                  .map((rc: any) => ({
                    code: rc.code,
                    targetConcentration_mM: +rc.target_concentration.toFixed(4),
                    dilutionLevel: rc.dilution_level,
                  }))
              : [],
            solventVolume_uL: row && row['vol#solvent'] != null ? +(+row['vol#solvent']).toFixed(2) : null,
            channels: channelsData,
          };
        });

      const totalSpots = lanesData.reduce((acc, l) => {
        return acc + Object.values(l.channels).reduce((cAcc: number, ch: any) => cAcc + ch.spotCount, 0);
      }, 0);

      const lanesWithSpots = lanesData.filter((l) =>
        Object.values(l.channels).some((ch: any) => ch.spotCount > 0)
      ).length;

      return {
        setName: s.name,
        setUid: s.uid,
        hasConfig: Boolean(s.cfg),
        channelsLoaded: availableChannels,
        summary: {
          totalLanes: lanesData.length,
          lanesWithSpots,
          totalSpotsDetected: totalSpots,
        },
        lanes: lanesData,
      };
    }),
  };

  return JSON.stringify(exportPayload, null, 2);
}

// Generate tlc_rf_table.csv (backward compatibility)
export function tlcRfCsv(
  sets: TlcSet[],
  run: RunResult,
  getSpots: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => TlcSpot[] | null,
  plateIndex: number = 0
): string {
  const codes = run?.reagents?.map((r) => r.code) || [];
  const head = [
    'plate',
    'set_name',
    'lane',
    'well',
    'reaction',
    ...codes.map((c) => `${c}_mM`),
    'solvent_uL',
  ];
  for (let n = 1; n <= 5; n++) {
    head.push(`rf_${n}`, `strength_${n}`);
  }
  head.push('edge_gain', 'edge_offset');
  for (let n = 1; n <= 5; n++) head.push(`rf_raw_${n}`);
  const rows = [head];

  for (const rawSet of sets) {
    const set = rawSet.plateData ? getTlcPlateSlice(rawSet, plateIndex) : rawSet;
    if (!set.cfg) continue;
    const ch = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).find((k) => !!set.imgs[k]);
    if (!ch) continue;
    for (const lane of [...set.cfg.lanes].sort((a, b) => a.id - b.id)) {
      if (lane.id < 0 || lane.id > 53) continue;
      const vialId = containerOfLane(lane.id);
      const row = run?.rows?.find(
        (r) => r.plate_number === plateIndex && r.container_id === vialId
      );
      const r: (string | number)[] = [
        plateIndex + 1,
        set.name,
        lane.id,
        wellLabel(vialId),
        row ? row.global_index + 1 : '',
        ...codes.map((c) => {
          const rc = row && row.recipe?.find((x: any) => x.code === c);
          return rc ? +rc.target_concentration.toFixed(4) : '';
        }),
        row && row['vol#solvent'] != null ? +(+row['vol#solvent']).toFixed(2) : '',
      ];
      const sp = getSpots(set, ch, lane) || [];
      for (let n = 0; n < 5; n++) {
        r.push(sp[n] ? +sp[n].rf.toFixed(3) : '', sp[n] ? +sp[n].strength.toFixed(2) : '');
      }
      // edge-effect correction: gain used for this lane, and the measured Rf before correction
      r.push(sp.length && sp[0].edgeGain ? sp[0].edgeGain : '', sp.length && sp[0].edgeGain ? sp[0].edgeOffset ?? 0 : '');
      for (let n = 0; n < 5; n++) {
        r.push(sp[n] ? +(sp[n].rfRaw ?? sp[n].rf).toFixed(3) : '');
      }
      rows.push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
    }
  }
  return csvText(rows);
}

/**
 * Computes isolated background-subtracted fluorescence pixel array.
 * Strips ambient dark background from UV366 so it doesn't wash out or overexpose the UV254 plate.
 */
export function extractFluorescenceOverlay(
  srcData: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number = 0.15,
  gain: number = 1.6
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(srcData.length);
  // Estimate background level from sample points
  let bgSum = 0;
  let bgCount = 0;
  const sampleStep = Math.max(1, Math.floor(width / 20));
  for (let y = 0; y < Math.min(height, 50); y += 4) {
    for (let x = 0; x < width; x += sampleStep) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * srcData[idx] + 0.587 * srcData[idx + 1] + 0.114 * srcData[idx + 2];
      bgSum += lum;
      bgCount++;
    }
  }
  const bgLevel = bgCount > 0 ? bgSum / bgCount : 30;
  const cutoff = Math.max(bgLevel + 6, threshold * 255);
  const denom = Math.max(1, 255 - cutoff);

  for (let i = 0; i < srcData.length; i += 4) {
    const r = srcData[i];
    const g = srcData[i + 1];
    const b = srcData[i + 2];
    const lum = 0.25 * r + 0.35 * g + 0.40 * b;

    if (lum <= cutoff) {
      // Background: totally transparent so it does NOT wash out UV254
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
    } else {
      const excess = (lum - cutoff) / denom;
      const alpha = Math.min(255, Math.round(Math.pow(excess, 0.85) * 255 * gain));
      out[i] = Math.min(255, Math.round(r * gain + 20));
      out[i + 1] = Math.min(255, Math.round(g * gain + 30));
      out[i + 2] = Math.min(255, Math.round(Math.max(b, 160) * gain));
      out[i + 3] = alpha;
    }
  }
  return out;
}

/**
 * Computes multi-channel false-color composite combining up to three TLC detection modes:
 * - UV 254 nm quenching = Gold / Amber
 * - UV 365 nm fluorescence = Laser Cyan
 * - Visible (White) stain/absorbance = Rose / Magenta
 */
export function computeFalseColorComposite(
  uv254Data: Uint8ClampedArray | null | undefined,
  uv366Data: Uint8ClampedArray | null | undefined,
  width: number,
  height: number,
  gain: number = 1.4,
  whiteData?: Uint8ClampedArray | null
): Uint8ClampedArray {
  const ref = uv254Data || uv366Data || whiteData;
  const byteLen = ref ? ref.length : Math.max(0, width * height * 4);
  const out = new Uint8ClampedArray(byteLen);
  if (!ref || byteLen === 0) return out;

  // Estimate UV254 bright phosphor baseline
  let baseG = 180;
  if (uv254Data && uv254Data.length === byteLen) {
    let gSum = 0;
    let gCount = 0;
    for (let i = 0; i < uv254Data.length; i += 16) {
      gSum += uv254Data[i + 1];
      gCount++;
    }
    baseG = Math.max(100, (gSum / Math.max(1, gCount)) * 1.05);
  }

  // Estimate Visible (White) bright silica plate baseline using upper-quartile luminance
  // so stained bands do not depress the background reference
  let baseW = 220;
  if (whiteData && whiteData.length === byteLen) {
    const pxCount = whiteData.length >> 2;
    const stride = Math.max(1, Math.floor(pxCount / 4096));
    const lumSamples: number[] = [];
    for (let p = 0; p < pxCount; p += stride) {
      const idx = p * 4;
      lumSamples.push(0.25 * whiteData[idx] + 0.45 * whiteData[idx + 1] + 0.30 * whiteData[idx + 2]);
    }
    baseW = Math.max(120, pctile(lumSamples, 0.80));
  }

  const whiteGainScale = gain / 1.4;

  for (let i = 0; i < byteLen; i += 4) {
    // 1. UV254 quenching signal (darkness in UV254 green channel)
    let q = 0;
    if (uv254Data && uv254Data.length === byteLen) {
      const g254 = uv254Data[i + 1];
      const qRaw = Math.max(0, (baseG - g254) / baseG);
      q = Math.min(1.0, Math.pow(qRaw, 0.9) * 1.6);
    }

    // 2. UV366 fluorescence signal (brightness in UV366)
    let f = 0;
    if (uv366Data && uv366Data.length === byteLen) {
      const lum366 = 0.25 * uv366Data[i] + 0.35 * uv366Data[i + 1] + 0.40 * uv366Data[i + 2];
      const fRaw = Math.max(0, (lum366 - 25) / 230);
      f = Math.min(1.0, Math.pow(fRaw, 0.85) * gain);
    }

    // 3. Visible (White) light absorbance/stain signal (darker than clean white silica)
    let v = 0;
    if (whiteData && whiteData.length === byteLen) {
      const lumW = 0.25 * whiteData[i] + 0.45 * whiteData[i + 1] + 0.30 * whiteData[i + 2];
      const wRaw = Math.max(0, (baseW - lumW) / baseW);
      const vNorm = Math.max(0, (wRaw - 0.08) / 0.92);
      v = Math.min(1.0, Math.pow(vNorm, 0.85) * 1.55 * whiteGainScale);
    }

    // Dark matrix background: [12, 18, 30]
    // Quenching (UV254): Gold/Amber [245, 158, 11]
    // Fluorescence (UV366): Laser Cyan [6, 182, 212]
    // Visible Stain (White): Rose/Magenta [250, 63, 175]
    out[i] = Math.min(255, Math.round(12 + q * 233 + f * 50 + v * 238));
    out[i + 1] = Math.min(255, Math.round(18 + q * 140 + f * 194 + v * 45));
    out[i + 2] = Math.min(255, Math.round(30 + q * 10 + f * 225 + v * 145));
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Renders an upright false-color composite lane canvas combining any 2 or all 3 loaded channels:
 * UV 254 nm quenching (gold/amber), UV 365 nm fluorescence (laser cyan), and Visible stain (rose/magenta).
 */
export function renderFalseColorLane(
  set: TlcSet,
  lane: TlcLane,
  width?: number,
  height?: number,
  gain: number = 1.4
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const im254 = set.imgs?.UV254;
  const im366 = set.imgs?.UV366;
  const imWhite = set.imgs?.White;
  const loadedCount = (im254?.bmp ? 1 : 0) + (im366?.bmp ? 1 : 0) + (imWhite?.bmp ? 1 : 0);
  if (loadedCount < 2) return null;

  const W = Math.max(1, Math.round(width || lane.width));
  const L = Math.max(1, Math.round(height || lane.length));

  const c1 = document.createElement('canvas');
  c1.width = W;
  c1.height = L;
  const ctx = c1.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const extractChannelBytes = (bmp: ImageBitmap): Uint8ClampedArray => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, L);
    const m = laneMatrix(lane, bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, W, L).data;
  };

  const data254 = im254?.bmp ? extractChannelBytes(im254.bmp) : null;
  const data366 = im366?.bmp ? extractChannelBytes(im366.bmp) : null;
  const dataWhite = imWhite?.bmp ? extractChannelBytes(imWhite.bmp) : null;

  const compositeBytes = computeFalseColorComposite(data254, data366, W, L, gain, dataWhite);
  const imgData = ctx.createImageData(W, L);
  imgData.data.set(compositeBytes);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(imgData, 0, 0);

  return c1;
}

