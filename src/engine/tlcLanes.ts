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
  ProfileHistogramStats,
} from '../types';
export type { ProfileHistogramStats };
import { parseDelimited } from './importers/tableReader';
import { csvText } from './exporters/csv';
import { getTlcPlateSlice } from './tlcPlateSlice';

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
  return {
    lanes,
    hasZeroRf: lanes.every((l) => l.zeroRf != null),
    warnings:
      lanes.length > 54 ? [`${lanes.length} lanes found; only the first 54 fit a 6 x 9 plate.`] : [],
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
    set.originAuto = {};
    set.originAutoByLane = {};
    set.autoConf = {};
    (set as any)._histCache = {};
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
  hist?: ProfileHistogramStats
): FrontDetectionResult {
  const n = profile.length;
  if (n < 20) return { pos: 0, score: 0 };

  const h = hist ?? analyzeProfileHistogram([profile], sign, 0.10, 0.95);
  const minStepAmp = h.sampleCount >= 16 ? Math.max(0.8, Math.min(1.5, 1.4 * h.bgSigma)) : 1.5;
  const minFeatFloor = h.sampleCount >= 16 ? Math.max(2.2, Math.min(5.0, 3.2 * h.bgSigma)) : 5.0;

  const s = movingAvg(profile, 3);
  const lo = Math.max(4, Math.floor(n * 0.50));
  const hi = Math.min(n - 4, Math.floor(n * 0.96));
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
    const c = windowMean(s, i - rCore, i + rCore);
    const mLT = windowMean(s, i - tOut, i - tIn);
    const mRT = windowMean(s, i + tIn, i + tOut);
    const dL = sign * (c - mLT);
    const dR = sign * (c - mRT);

    let ridgeAmp = 0;
    if (dL > 1.0 && dR > 1.0 && Math.min(dL, dR) >= 0.30 * Math.max(dL, dR)) {
      const tightRidge = 0.7 * Math.min(dL, dR) + 0.3 * 0.5 * (dL + dR);
      const mLM = windowMedian(s, i - mOut, i - mIn, buf);
      let mRM = windowMedian(s, i + mIn, i + mOut, buf);
      // Near the far end of the lane (e.g. half-plate edge / midline divider), a dark gap or label strip
      // just beyond the dry front rim can drop into `i + mIn .. i + mOut` and invert `dRM`.
      if (i >= n * 0.78 && sign * (c - mRM) < 0.35 * dR) {
        const tailEnd = windowMean(s, Math.min(n - 1, i + mOut - 4), Math.min(n - 1, i + mOut + 12));
        if (sign * (tailEnd - mRT) > 2.0) {
          const shelf = windowQuantile(s, i + mIn, i + mOut, buf, sign < 0 ? 0.80 : 0.20);
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
    if (i + bgNear <= n - 1 && i - bgNear >= 0) {
      const medAfter = windowMedian(s, i + bgNear, Math.min(n - 1, i + bgMid), buf);
      const medBefore = windowMedian(s, Math.max(0, i - bgMid), i - bgNear, buf);
      const farBefore =
        i - Math.round(n * 0.06) >= 3
          ? windowMedian(s, Math.max(0, i - bgFarLo), i - Math.max(bgNear + 2, Math.round(n * 0.06)), buf)
          : medBefore;
      const edgeL = windowMean(s, Math.max(0, i - rCore - eWin), Math.max(0, i - rCore - 1));
      const edgeR = windowMean(s, Math.min(n - 1, i + rCore + 1), Math.min(n - 1, i + rCore + eWin));
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

function refineOriginCoreCenter(s: number[], idx: number, sign: number): number {
  const n = s.length;
  if (idx <= 2 || idx >= n - 3) return idx;

  const flankIn = Math.max(6, Math.round(n * 0.024));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));
  const buf = new Float64Array(32);
  const mBelow = windowMedian(s, Math.max(0, idx - flankOut), Math.max(0, idx - flankIn), buf);
  const mAbove = windowMedian(s, Math.min(n - 1, idx + flankIn), Math.min(n - 1, idx + flankOut), buf);
  const bg = sign < 0 ? Math.max(mBelow, mAbove) : Math.min(mBelow, mAbove);

  const sigAt = (k: number) => Math.max(0, sign * (s[k] - bg));
  const idxSig = sigAt(idx);
  const searchR = Math.max(8, Math.round(n * 0.032));

  // Stay connected to `idx` so a nearby eluted spot or dark border cannot hijack centering.
  let loConn = idx;
  while (loConn > Math.max(1, idx - searchR) && sigAt(loConn - 1) >= 0.45 * idxSig) loConn--;
  let hiConn = idx;
  while (hiConn < Math.min(n - 2, idx + searchR) && sigAt(hiConn + 1) >= 0.45 * idxSig) hiConn++;

  let coreMax = idxSig;
  for (let k = loConn; k <= hiConn; k++) {
    const v = sigAt(k);
    if (v > coreMax) coreMax = v;
  }
  if (coreMax < 4) return idx;

  // Pick midpoint of the >=90% top plateau so flat saturated dots start in their geometric middle
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
      if (sigAt(k) >= 0.86 * coreMax) {
        if (pLo === -1) pLo = k;
        pHi = k;
      }
    }
  }
  const seedFloat = pLo !== -1 ? 0.5 * (pLo + pHi) : idx;
  const seed = Math.round(seedFloat);

  // Walk outward to the 64% peak contour, then clamp the smeared flank against the clean flank
  // so tailing dots stay centered on their round deposit core rather than shifting toward the front.
  const thr = 0.64 * coreMax;
  const maxHalf = Math.max(14, Math.round(n * 0.042));

  let l = seed;
  while (l > Math.max(0, seed - maxHalf) && sigAt(l - 1) >= thr) l--;
  let leftX = l;
  if (l > 0 && sigAt(l - 1) < thr && sigAt(l) >= thr) {
    const v0 = sigAt(l - 1);
    const v1 = sigAt(l);
    leftX = l - (v1 - thr) / Math.max(1e-6, v1 - v0);
  }

  let r = seed;
  while (r < Math.min(n - 1, seed + maxHalf) && sigAt(r + 1) >= thr) r++;
  let rightX = r;
  if (r < n - 1 && sigAt(r + 1) < thr && sigAt(r) >= thr) {
    const v0 = sigAt(r);
    const v1 = sigAt(r + 1);
    rightX = r + (v0 - thr) / Math.max(1e-6, v0 - v1);
  }

  const rBelow = Math.max(1, seedFloat - leftX);
  const rAbove = Math.max(1, rightX - seedFloat);
  const nearIn = Math.max(4, Math.round(n * 0.014));
  const nearOut = nearIn + Math.max(6, Math.round(n * 0.018));
  const nearBelow = windowMedian(s, Math.max(0, seed - nearOut), Math.max(0, seed - nearIn), buf);
  const nearAbove = windowMedian(s, Math.min(n - 1, seed + nearIn), Math.min(n - 1, seed + nearOut), buf);
  const flankAsym =
    sign < 0
      ? 0.5 * (mBelow - mAbove + (nearBelow - nearAbove))
      : 0.5 * (mAbove - mBelow + (nearAbove - nearBelow));

  let usedLeftX = leftX;
  let usedRightX = rightX;
  const cleanIsBelow = flankAsym > 2.5 || (flankAsym >= -2 && rAbove > 1.22 * rBelow + 1);
  const cleanIsAbove = flankAsym < -2.5 || (flankAsym <= 2 && rBelow > 1.22 * rAbove + 1);
  if (cleanIsBelow && rAbove > 1.12 * rBelow + 0.5) {
    usedRightX = Math.min(rightX, seedFloat + Math.max(3, 1.12 * rBelow + 0.6));
  } else if (cleanIsAbove && rBelow > 1.12 * rAbove + 0.5) {
    usedLeftX = Math.max(leftX, seedFloat - Math.max(3, 1.12 * rAbove + 0.6));
  }

  const lClamp = Math.max(0, Math.floor(usedLeftX));
  const rClamp = Math.min(n - 1, Math.ceil(usedRightX));
  const mid = 0.5 * (usedLeftX + usedRightX);
  let sumW = 0;
  let sumPos = 0;
  for (let k = lClamp; k <= rClamp; k++) {
    const w = Math.max(0, sigAt(k) - thr);
    sumW += w;
    sumPos += k * w;
  }
  const centroid = sumW > 0 ? sumPos / sumW : mid;
  const refined = Math.round(0.65 * mid + 0.35 * centroid);
  if (Math.abs(refined - idx) > searchR || refined < 4 || refined >= n - 4) return idx;
  if (Math.abs(refined - idx) > Math.max(4, Math.round(n * 0.020))) {
    const aPath = Math.min(idx, refined);
    const bPath = Math.max(idx, refined);
    for (let k = aPath; k <= bPath; k++) {
      if (sigAt(k) < 0.25 * coreMax) return idx;
    }
  }
  return refined;
}

interface OriginCandidate extends FrontDetectionResult {
  feat: number;
}

// Detect up to `maxPeaks` separated compact deposit peaks in the lower 3%-25% of a lane.
function detectOriginCandidates(
  profile: number[],
  sign: number = -1,
  maxPeaks: number = 3,
  relaxed: boolean = false,
  histBgSigma?: number
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
    const pos = refineOriginCoreCenter(s, pk.idx, sign);
    if (pos <= 0 || out.some((kept) => Math.abs(kept.pos - pos) < minSep)) continue;
    out.push({ pos, score: pk.feat / noiseFloor, feat: pk.feat });
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

  // Restrict rolling baseline estimation strictly to chromatographic interior [origin + 3, front]
  // so dark outer plate borders (< origin or > front) do not drag the baseline down near Rf ~0.04 or Rf ~0.95.
  const baseLo = Math.max(0, Math.round(o.origin + Math.max(3, Math.min(8, r * 0.18))));
  const baseHi = Math.min(n - 1, Math.round(o.front));
  const useRestrictedBase = baseHi - baseLo >= 16;

  const step = 5;
  const win = 100;
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

  // Origin buffer: allow detecting resolved polar products from Rf ~0.025 upwards
  const originBuffer = Math.max(3, Math.min(8, Math.round(r * 0.18)));
  const start = Math.round(o.origin + originBuffer);

  // Front buffer: extend reach up to Rf ~0.988 so fast nonpolar spots right before the solvent front are still detected
  const end = Math.round(o.origin + Math.min(span - 2, 0.988 * span));

  if (end <= start) return [];

  // Compute baseline noise & physical signal range specifically within the chromatographic migration window (chrom)
  const chrom = d.slice(Math.max(start, 0), Math.min(n, end));
  const dmax = chrom.length > 0 ? Math.max(...chrom, 1e-9) : Math.max(...d, 1e-9);
  const med = chrom.length > 0 ? pctile(chrom, 0.5) : pctile(d, 0.5);
  const rawMadNoise = chrom.length > 0
    ? 1.4826 * pctile(chrom.map((v) => Math.abs(v - med)), 0.5)
    : 1.4826 * pctile(d.map((v) => Math.abs(v - med)), 0.5);

  const profSlice = profile.slice(Math.max(0, start), Math.min(n, end));
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
  // - Adapts to quiet-side silica noise (2.8 * bgSigma) & plate dynamic range (0.016 * contrastSpan)
  // - Lets faint spots on clean, low-exposure Merck TLC Explorer plates resolve down to ~2.0 units
  // - Prevents blank-well camera noise from triggering when plate contrast is high
  const histFloor = h.sampleCount >= 8 ? Math.max(2.0, 2.8 * h.bgSigma, 0.016 * h.contrastSpan) : 4.5;
  const minAbsFloor = Math.max(histFloor, 0.018 * dynSpan);

  // Robust chromatographic signal threshold
  const thr = Math.max(2.6 * noise, 0.035 * dmax, minAbsFloor);

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

  // Failsafe Artifact Rejection Filters:
  // (a) Reject single-pixel dust specks (< 3 raw px persistence + smoothed support check)
  // (b) Near-origin: require clear chromatographic valley from o.origin (not an uneluted/tailing origin dot)
  // (c) Near-front (Rf >= 0.88): reject monotonic ramps climbing into dark plate borders past o.front,
  //     and require a genuine left chromatographic valley separating the spot from baseline noise
  // (d) Interior: require bilateral local prominence on both sides so gentle illumination gradients don't trigger
  const nearOriginLimit = o.origin + Math.max(Math.round(0.055 * span), Math.round(r * 1.15));
  const originCoreStart = Math.max(0, Math.round(o.origin - 1));
  const nearFrontLimit = o.origin + Math.min(Math.round(0.90 * span), span - Math.max(6, Math.round(r * 0.45)));
  const frontCoreEnd = Math.min(n - 1, Math.round(o.front + Math.max(6, r * 0.35)));
  const flankRadius = Math.max(halfWin * 2, Math.round(0.10 * span));

  const filteredCandidates = candidates.filter((p) => {
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
        if (originPeak >= Math.max(thr, 0.45 * p.val)) {
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

    // (c) Near-front guard against exterior plate border artifacts & baseline drift
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

      // Check raw profile at front edge: only reject if a dark glass border continues monotonically from p.pos past o.front without dipping back toward baseline
      const outStart = Math.min(n - 1, Math.round(o.front + 2));
      if (frontCoreEnd > outStart && p.pos > o.origin + 0.93 * span) {
        const refBase = base[chromHi];
        let minInsideDev = Infinity;
        for (let k = p.pos; k <= chromHi; k++) {
          const dev = o.sign < 0 ? refBase - profile[k] : profile[k] - refBase;
          if (dev < minInsideDev) minInsideDev = dev;
        }
        let outMaxDev = -Infinity;
        for (let k = outStart; k <= frontCoreEnd; k++) {
          const dev = o.sign < 0 ? refBase - profile[k] : profile[k] - refBase;
          if (dev > outMaxDev) outMaxDev = dev;
        }
        if (outMaxDev > p.val * 1.15 && p.val - minInsideDev < Math.max(0.25 * p.val, 2 * noise)) {
          return false;
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
      if (bilatProm < Math.max(2.0 * noise, minAbsFloor * 0.45)) {
        return false;
      }
    }

    return true;
  });

  if (filteredCandidates.length === 0) return [];

  // 2. Iterative Chromatographic Basin & Prominence Consolidation
  // In chromatography, two peaks in the same continuous band only represent separate compounds
  // if the valley drops significantly towards baseline (achieving chromatographic resolution).
  // If the valley is shallow or the peaks are physically close, they MUST be merged into one single spot.
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
        dropRatio < mergeDrop ||
        (dist < closeDist && dropRatio < Math.min(0.95, baseMergeDrop + 0.15)) ||
        valleyDrop < Math.max(2.5 * noise, 0.45 * minAbsFloor);

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
  for (const ch of channels) {
    const p = getProfile(set, ch, lane);
    if (p && p.length >= 10) {
      profiles[ch] = p;
      const chHist = getChannelHistogram(set, ch, getProfile);
      if (chHist) histograms[ch] = chHist;
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
  const l0 = set.cfg?.lanes[0];
  const laneSig = set.cfg ? `${set.cfg.lanes.length}_${l0?.x0 ?? 0}_${l0?.y0 ?? 0}_${l0?.length ?? 0}` : 'none';
  return `${imgSig}|${laneSig}`;
}

function detectDiffuseChannelFront(
  medProfile: number[],
  profiles: number[][],
  sign: number
): FrontDetectionResult {
  const n = medProfile.length;
  if (n < 20 || profiles.length < 6) return { pos: 0, score: 0 };

  const s = movingAvg(medProfile, 5);
  const lo = Math.max(4, Math.floor(n * 0.80));
  const hi = Math.min(n - 4, Math.floor(n * 0.96));
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
  laneLen: number
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
    const third = Math.min(2, Math.floor((li * 3) / N));
    thirdTot[third]++;
    const kLo = Math.max(tOut + 1, pos - bowTol);
    const kHi = Math.min(s.length - tOut - 2, pos + bowTol);
    let hit = false;
    for (let k = kLo; k <= kHi; k++) {
      const c = windowMean(s, k - rCore, k + rCore);
      const mLT = windowMean(s, k - tOut, k - tIn);
      const mRT = windowMean(s, k + tIn, k + tOut);
      const dL = sign * (c - mLT);
      const dR = sign * (c - mRT);
      if (dL > 2.5 && dR > 2.5 && Math.min(dL, dR) >= 0.25 * Math.max(dL, dR)) {
        hit = true;
        break;
      }
      if (k + bgNear <= s.length - 1 && k - bgNear >= 0) {
        const edgeL = windowMean(s, Math.max(0, k - rCore - eWin), Math.max(0, k - rCore - 1));
        const edgeR = windowMean(s, Math.min(s.length - 1, k + rCore + 1), Math.min(s.length - 1, k + rCore + eWin));
        if ((edgeR - edgeL) * dirSign > 2.5) {
          const medAfter = windowMedian(s, k + bgNear, Math.min(s.length - 1, k + bgMid), buf);
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
  laneLen: number
): FrontDetectionResult {
  const n = medProfile.length;
  if (n < 20 || upperHist.otsuEta < 0.50) return { pos: 0, score: 0 };

  const lo = Math.max(4, Math.floor(n * 0.50));
  const hi = Math.min(n - 4, Math.floor(n * 0.96));
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

function detectChannelFront(profiles: number[][], sign: number, laneLen: number): FrontDetectionResult {
  if (!profiles.length) return { pos: 0, score: 0 };

  let medProfile: number[];
  if (profiles.length === 1) {
    medProfile = profiles[0];
  } else {
    const minLen = Math.min(...profiles.map((p) => p.length));
    if (minLen < 20) return { pos: 0, score: 0 };
    medProfile = new Array(minLen);
    const colBuf = new Float64Array(profiles.length);
    for (let i = 0; i < minLen; i++) {
      for (let j = 0; j < profiles.length; j++) colBuf[j] = profiles[j][i];
      medProfile[i] = medianSortedBuf(colBuf, profiles.length);
    }
  }

  const plateHist = analyzeProfileHistogram(profiles, sign, 0.12, 0.95);
  const upperHist = analyzeProfileHistogram(profiles, sign, 0.50, 0.95);
  const otsuCandidate = detectOtsuWetDryFront(medProfile, profiles, sign, upperHist, laneLen);

  let best = detectFrontDetailed(medProfile, sign, plateHist);
  const smoothed = profiles.length >= 6 ? profiles.map((p) => movingAvg(p, 3)) : [];
  if (profiles.length >= 6 && best.pos > 0) {
    const cont = measureFrontContinuity(smoothed, best.pos, sign, laneLen);
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
      .map((p) => detectFrontDetailed(p, sign, plateHist))
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
          const cont = measureFrontContinuity(smoothed, clusterPos, sign, laneLen);
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
    best = detectDiffuseChannelFront(medProfile, profiles, sign);
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

// Solvent front resolution: explicit side override -> explicit global manual override -> clearest-channel detection -> fallback 93% of lane length
export function tlcFront(
  set: TlcSet,
  lane: TlcLane,
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): number {
  const h = tlcHalf(lane);
  if (set.frontHalfPx && set.frontHalfPx[h] != null && set.frontHalfPx[h]! > 0) {
    return set.frontHalfPx[h]!;
  }
  if (set.frontPx && set.frontPx > 0) return set.frontPx;

  const channels = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((k) => !!set.imgs?.[k]);
  if (!channels.length || !getProfile) return Math.round(lane.length * 0.93);

  const sig = autoCacheSignature(set);
  if ((set as any)._autoCacheSig !== sig) {
    set.frontAuto = {};
    set.originAuto = {};
    set.originAutoByLane = {};
    set.autoConf = {};
    (set as any)._histCache = {};
    (set as any)._autoCacheSig = sig;
  }

  set.frontAuto = set.frontAuto || {};
  if (set.frontAuto[h] == null && set.cfg) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    let best: FrontDetectionResult = { pos: 0, score: 0 };
    // Strips of bare silica between the lanes carry no spots or smears, so a front or pencil line is
    // far cleaner there than down the lanes; sample them first and fall back to the lane centres.
    const gutters = gutterLanes(halfLanes);
    const laneSets = gutters.length >= 4 ? [gutters, halfLanes] : [halfLanes];
    for (const lanesToUse of laneSets) {
      for (const ch of channels) {
        const profiles = lanesToUse.map((l) => getProfile(set, ch, l)).filter((p) => p.length > 0);
        if (!profiles.length) continue;
        const res = detectChannelFront(profiles, TLC_SIGNAL[ch]?.sign ?? 1, lane.length);
        if (res.score > best.score && res.pos > 0) {
          best = res;
        }
      }
      if (best.pos > 0) break;
    }
    set.frontAuto[h] = best.pos > 0 ? best.pos : Math.round(lane.length * 0.93);
    set.autoConf = set.autoConf || {};
    set.autoConf[`front${h}`] = { detected: best.pos > 0, score: best.pos > 0 ? best.score : 0 };
  }
  return set.frontAuto[h] ?? Math.round(lane.length * 0.93);
}

interface ChannelOriginResult extends FrontDetectionResult {
  byLane?: Record<number, number>;
  validFrac?: number;
  medFeat?: number;
}

function fitOriginQuadCurve(
  hits: Array<{ laneId: number; pos: number }>,
  medPos: number,
  laneLen: number
): Record<number, number> | undefined {
  if (hits.length < 4) return undefined;
  const uOf = (laneId: number) => ((laneId % 27) - 13) / 13;
  const baseHalf = hits[0].laneId < 27 ? 0 : 27;
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
    const cols = inliers.map((h) => h.laneId % 27);
    if (Math.max(...cols) - Math.min(...cols) < 6) return undefined;
    const resSorted = hits.map((h) => Math.abs(h.pos - (c0Lin + c1Lin * uOf(h.laneId)))).sort((a, b) => a - b);
    const out: Record<number, number> = {};
    for (let i = 0; i < 27; i++) {
      const pred = Math.round(c0Lin + c1Lin * ((i - 13) / 13));
      out[baseHalf + i] = Math.max(medPos - maxShift, Math.min(medPos + maxShift, pred));
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
    return Math.abs(h.pos - (c0 + c1 * u + c2 * u * u)) <= tol;
  });
  if (inliers.length < 10) return linFit?.map;
  const cols = inliers.map((h) => h.laneId % 27);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  if (maxCol - minCol < 18 || minCol > 4 || maxCol < 22) return linFit?.map;
  const nLeft = cols.filter((c) => c < 9).length;
  const nMid = cols.filter((c) => c >= 9 && c <= 17).length;
  const nRight = cols.filter((c) => c > 17).length;
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
  for (let i = 0; i < 27; i++) {
    const u = (i - 13) / 13;
    const pred = Math.round(c0 + c1 * u + c2 * u * u);
    out[baseHalf + i] = Math.max(medPos - maxShift, Math.min(medPos + maxShift, pred));
  }
  return out;
}

function detectOriginNear(
  profile: number[],
  sign: number,
  refPos: number,
  localRadius: number,
  minFeat: number = 3.0,
  minSnr: number = 3.2,
  minBi: number = 8.0
): number {
  const n = profile.length;
  if (n < 20) return 0;

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
  if (wHi <= wLo) return 0;

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
      // Stronger distance bias so stray smears/grain far from the baseline cannot pull missing-dot lanes
      const weight = 1 - (i > refPos ? 0.30 : 0.16) * distFrac;
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
    return 0;
  }
  const refined = refineOriginCoreCenter(s, bestIdx, sign);
  if (
    Math.abs(refined - refPos) > 0.45 * localRadius &&
    (bestRawFeat < Math.max(22, 1.55 * minFeat) || snr < Math.max(7.0, 1.35 * minSnr))
  ) {
    return 0;
  }
  return refined;
}

// Faint-origin fallback: when no dot passes normal thresholds, accept weaker features only if a
// substantial share of lanes agree on one height (a consistent row is strong evidence on its own).
function detectFaintOriginRow(
  laneEntries: Array<{ laneId: number; profile: number[] }>,
  sign: number,
  laneLen: number,
  histBgSigma?: number
): ChannelOriginResult {
  const hits: Array<{ laneId: number; pos: number; score: number }> = [];
  for (const e of laneEntries) {
    for (const cand of detectOriginCandidates(e.profile, sign, 3, true, histBgSigma)) {
      if (cand.pos > laneLen * 0.06) hits.push({ laneId: e.laneId, pos: cand.pos, score: cand.score });
    }
  }
  const minNeeded = Math.max(3, Math.ceil(laneEntries.length * 0.4));
  if (hits.length < minNeeded) return { pos: 0, score: 0 };
  const tol = Math.max(10, Math.round(laneLen * 0.03));
  let chosen: { pos: number; cl: typeof hits; agg: number } | null = null;
  for (const anchor of hits) {
    const byLane = new Map<number, (typeof hits)[number]>();
    for (const r of hits) {
      if (Math.abs(r.pos - anchor.pos) > tol) continue;
      const prev = byLane.get(r.laneId);
      if (!prev || r.score > prev.score) byLane.set(r.laneId, r);
    }
    const cl = Array.from(byLane.values());
    if (cl.length < minNeeded) continue;
    const sortedPos = cl.map((r) => r.pos).sort((a, b) => a - b);
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
    chosen.cl.map((r) => ({ laneId: r.laneId, pos: r.pos })),
    chosen.pos,
    laneLen
  );
  const byLane: Record<number, number> = {};
  for (const e of laneEntries) {
    const own = chosen.cl.find((r) => r.laneId === e.laneId);
    byLane[e.laneId] = own ? own.pos : Math.round(backbone?.[e.laneId] ?? chosen.pos);
  }
  const medScore = chosen.cl.map((r) => r.score).sort((a, b) => a - b)[chosen.cl.length >> 1];
  return {
    pos: chosen.pos,
    // Deliberately modest so UI / multi-channel comparison still treats stronger channels as higher confidence
    score: Math.min(6, medScore) * (0.4 + 0.6 * chosen.agg),
    byLane,
    validFrac: chosen.cl.length / laneEntries.length,
    medFeat: 0,
  };
}

export function detectChannelOrigin(
  laneEntries: Array<{ laneId: number; profile: number[] }>,
  sign: number,
  laneLen: number,
  hist?: ProfileHistogramStats
): ChannelOriginResult {
  if (!laneEntries.length) return { pos: 0, score: 0 };

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
    const laneHits: Array<{ laneId: number; pos: number; score: number; feat: number }> = [];
    for (const e of laneEntries) {
      for (const cand of detectOriginCandidates(e.profile, sign, 3, false, histBgSigma)) {
        if (cand.pos > 10) laneHits.push({ laneId: e.laneId, pos: cand.pos, score: cand.score, feat: cand.feat });
      }
    }
    const minNeeded = Math.max(2, Math.ceil(laneEntries.length * 0.22));
    if (laneHits.length >= minNeeded) {
      const tol = Math.max(12, Math.round(laneLen * 0.04));
      const clusters: Array<{ pos: number; aggScore: number; inCluster: typeof laneHits }> = [];
      for (const anchor of laneHits) {
        const byLane = new Map<number, (typeof laneHits)[number]>();
        for (const r of laneHits) {
          if (Math.abs(r.pos - anchor.pos) > tol) continue;
          const prev = byLane.get(r.laneId);
          if (!prev || r.score > prev.score) byLane.set(r.laneId, r);
        }
        const cl = Array.from(byLane.values());
        if (cl.length < minNeeded) continue;
        const cPos = cl.map((r) => r.pos).sort((a, b) => a - b);
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
        const pos = chosen.pos;
        const inCluster = chosen.inCluster;
        const aggScore = chosen.aggScore;
        const backbone = fitOriginQuadCurve(inCluster, pos, laneLen);

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
        const minSnr = Math.max(5.5, 0.25 * medScore);

        // Second pass: lock spotted lanes onto their sharp origin peak within experimental spotting
        // error around the smooth backbone; missing-spot lanes stay smoothly on the backbone.
        const localRadius = Math.max(12, Math.round(laneLen * 0.016));
        const sortedEntries = laneEntries.slice().sort((a, b) => a.laneId - b.laneId);
        const detected = sortedEntries.map((e) => {
          const refPos = backbone?.[e.laneId] ?? pos;
          const p = detectOriginNear(e.profile, sign, refPos, localRadius, minFeat, minSnr, histBiFloor);
          return { laneId: e.laneId, refPos, pos: p };
        });

        const validDetected = detected.filter((d) => d.pos > 0);
        const refinedBackbone =
          validDetected.length >= 4
            ? fitOriginQuadCurve(
                validDetected.map((d) => ({ laneId: d.laneId, pos: d.pos })),
                pos,
                laneLen
              ) ?? backbone
            : backbone;

        let validCount = 0;
        const byLane: Record<number, number> = {};
        for (const entry of detected) {
          if (entry.pos > 0) {
            validCount++;
            byLane[entry.laneId] = entry.pos;
          } else {
            byLane[entry.laneId] = Math.round(refinedBackbone?.[entry.laneId] ?? entry.refPos);
          }
        }

        if (aggScore > best.score || validCount >= minNeeded) {
          best = {
            pos,
            score: Math.max(best.score, aggScore),
            byLane,
            validFrac: validCount / laneEntries.length,
            medFeat,
          };
        }
      }
    }
  }

  if (best.pos <= 10 && laneEntries.length >= 6) {
    const faint = detectFaintOriginRow(laneEntries, sign, laneLen, histBgSigma);
    if (faint.pos > 10) best = faint;
  }

  return best;
}

// Spot origin resolution: explicit microadjusted lane.zeroRf -> manual set.originPx override -> clearest-channel origin peak -> fallback ~10% lane length
export function tlcOrigin(
  set: TlcSet,
  lane: TlcLane,
  getProfile?: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => number[]
): number {
  if (lane.zeroRf != null && lane.zeroRf > 0) return lane.zeroRf;
  if (set.originPx != null && set.originPx > 0) return set.originPx;

  const channels = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((k) => !!set.imgs?.[k]);
  if (!channels.length || !getProfile || !set.cfg) {
    return Math.max(20, Math.round(lane.length * 0.10));
  }

  const sig = autoCacheSignature(set);
  if ((set as any)._autoCacheSig !== sig) {
    set.frontAuto = {};
    set.originAuto = {};
    set.originAutoByLane = {};
    set.autoConf = {};
    (set as any)._histCache = {};
    (set as any)._autoCacheSig = sig;
  }

  set.originAuto = set.originAuto || {};
  set.originAutoByLane = set.originAutoByLane || {};
  const h = tlcHalf(lane);
  if (set.originAuto[h] == null) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    let best: ChannelOriginResult = { pos: 0, score: 0 };
    let bestClipped = false;
    for (const ch of channels) {
      const chSign = TLC_SIGNAL[ch]?.sign ?? -1;
      const entries = halfLanes
        .map((l) => ({ laneId: l.id, profile: getProfile(set, ch, l) }))
        .filter((e) => e.profile.length > 0);
      if (!entries.length) continue;
      const chHist =
        getChannelHistogram(set, ch, getProfile) ??
        analyzeProfileHistogram(entries.map((e) => e.profile), chSign, 0.06, 0.90);
      const resClipped = chSign < 0 ? chHist.clipHighFrac > 0.25 : chHist.clipLowFrac > 0.25;
      const res = detectChannelOrigin(entries, chSign, lane.length, chHist);
      if (res.pos <= 10) continue;
      const bestSolid = best.pos > 10 && best.score >= 8 && (best.validFrac ?? 0) >= 0.22;
      if (!bestSolid) {
        if (res.score > best.score) {
          best = res;
          bestClipped = resClipped;
        }
      } else if (
        (bestClipped && !resClipped && res.score >= 8 && (res.validFrac ?? 0) >= 0.22) ||
        ((res.validFrac ?? 0) > (best.validFrac ?? 0) + 0.15 &&
          (res.medFeat ?? 0) > (best.medFeat ?? 0) * 1.1 &&
          res.score > best.score * 1.25)
      ) {
        best = res;
        bestClipped = resClipped;
      }
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

