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
} from '../types';
import { parseDelimited } from './importers/tableReader';
import { csvText } from './exporters/csv';

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

// Detect solvent front from thin meniscus line (sharp local ridge) and/or persistent wet-vs-dry background step
// across 50%-96% of the lane. Returns { pos: 0, score: 0 } when no reliable front signal is found.
export function detectFrontDetailed(profile: number[], sign: number = 1): FrontDetectionResult {
  const n = profile.length;
  if (n < 20) return { pos: 0, score: 0 };

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
  const sigmaS = Math.max(0.8, 1.4826 * medianSortedBuf(d2Arr, d2Count) * 0.866);

  const buf = new Float64Array(36);
  const feats = new Float64Array(count);
  let bestIdx = lo;
  let bestFeat = 0;
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
      const mRM = windowMedian(s, i + mIn, i + mOut, buf);
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
    if (feat > bestFeat) {
      bestFeat = feat;
      bestIdx = i;
    }
  }

  const featsSorted = new Float64Array(feats);
  const medFeat = medianSortedBuf(featsSorted, count);
  for (let j = 0; j < count; j++) featsSorted[j] = Math.abs(feats[j] - medFeat);
  const madFeat = 1.4826 * medianSortedBuf(featsSorted, count);

  const noiseFloor = Math.max(sigmaS, madFeat, 1.6);
  const snr = bestFeat / noiseFloor;
  if (snr < MIN_FRONT_SNR || bestFeat < 5.0) {
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

  const flankIn = Math.max(5, Math.round(n * 0.016));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));
  const buf = new Float64Array(24);
  const mBelow = windowMedian(s, Math.max(0, idx - flankOut), Math.max(0, idx - flankIn), buf);
  const mAbove = windowMedian(s, Math.min(n - 1, idx + flankIn), Math.min(n - 1, idx + flankOut), buf);
  const bg = sign < 0 ? Math.max(mBelow, mAbove) : Math.min(mBelow, mAbove);

  const sigAt = (k: number) => Math.max(0, sign * (s[k] - bg));
  const idxSig = sigAt(idx);
  const searchR = Math.max(4, Math.round(n * 0.015));

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

  // Pick midpoint of the >=88% top plateau so flat saturated dots start in their geometric middle
  let pLo = -1;
  let pHi = -1;
  for (let k = loConn; k <= hiConn; k++) {
    if (sigAt(k) >= 0.88 * coreMax) {
      if (pLo === -1) pLo = k;
      pHi = k;
    }
  }
  const seed = pLo !== -1 ? Math.round(0.5 * (pLo + pHi)) : idx;

  // Walk outward to the 60% peak contour so moderate upward tailing is cleanly excluded
  const thr = 0.60 * coreMax;
  const maxHalf = Math.max(10, Math.round(n * 0.025));

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

  const mid = 0.5 * (leftX + rightX);
  let sumW = 0;
  let sumPos = 0;
  for (let k = l; k <= r; k++) {
    const w = Math.max(0, sigAt(k) - thr);
    sumW += w;
    sumPos += k * w;
  }
  const centroid = sumW > 0 ? sumPos / sumW : mid;
  const refined = Math.round(0.65 * mid + 0.35 * centroid);
  if (Math.abs(refined - idx) > searchR || refined < 4 || refined >= n - 4) return idx;
  return refined;
}

// Detect spot origin from compact deposit peak in lower 3%-25% of the lane with bilateral silica contrast,
// rejecting monotonic dark plate borders and empty-lane noise.
export function detectOriginDetailed(profile: number[], sign: number = -1): FrontDetectionResult {
  const n = profile.length;
  if (n < 20) return { pos: 0, score: 0 };

  const smWin = n >= 250 ? 5 : 3;
  const s = movingAvg(profile, smWin);
  const lo = Math.max(4, Math.floor(n * 0.03));
  const hi = Math.min(n - 5, Math.floor(n * 0.25));
  if (hi <= lo) return { pos: 0, score: 0 };

  const rCore = Math.max(1, Math.round(n * 0.0025));
  const flankIn = Math.max(5, Math.round(n * 0.016));
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
  let bestIdx = 0;
  let bestFeat = 0;

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
    if (feat > bestFeat) {
      bestFeat = feat;
      bestIdx = i;
    }
  }

  const featsSorted = new Float64Array(feats);
  const medFeat = medianSortedBuf(featsSorted, count);
  for (let j = 0; j < count; j++) featsSorted[j] = Math.abs(feats[j] - medFeat);
  const madFeat = 1.4826 * medianSortedBuf(featsSorted, count);

  const noiseFloor = Math.max(sigmaS, madFeat, 1.0);
  const snr = bestFeat / noiseFloor;
  if (snr < MIN_ORIGIN_SNR || bestFeat < 3.0 || bestIdx <= 0) {
    return { pos: 0, score: 0 };
  }
  return { pos: refineOriginCoreCenter(s, bestIdx, sign), score: snr };
}

// Detect spot origin from baseline deposit peak in lower 3%-25% of the lane
export function detectOrigin(profile: number[], sign: number = -1): number {
  return detectOriginDetailed(profile, sign).pos;
}

export const tlcHalf = (lane: TlcLane): number => (lane.id < 27 ? 0 : 1);

// Find spots in a lane profile using rolling percentile baseline subtraction and chromatographic prominence consolidation
export function findSpots(profile: number[], o: TlcProfileOptions): TlcSpot[] {
  const n = profile.length;
  if (n < 10) return [];
  const sm1 = movingAvg(profile, 7);
  const step = 5;
  const win = 100;
  const base = new Array(n);
  const q = o.sign < 0 ? 0.9 : 0.1;
  const pts: [number, number][] = [];

  for (let i = 0; i < n; i += step) {
    const chunk = sm1.slice(Math.max(0, i - win), Math.min(n, i + win + 1));
    pts.push([i, pctile(chunk, q)]);
  }
  pts.push([n - 1, pts[pts.length - 1][1]]);

  for (let j = 0, i = 0; i < n; i++) {
    while (j < pts.length - 2 && pts[j + 1][0] < i) j++;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    base[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
  }

  // Raw baseline-subtracted signal
  const rawDiff = sm1.map((v, i) => (o.sign < 0 ? base[i] - v : v - base[i]));

  const r = o.radius || 24;
  const span = Math.max(1, o.front - o.origin);
  const minProm = o.minProminence ?? 0.28;

  // Continuous sensitivity: t = 0 (most sensitive, slider 8%) .. 1 (most merging, slider 70%).
  // Every knob below scales smoothly with it, so each slider step changes the result.
  const t = Math.min(1, Math.max(0, (minProm - 0.08) / 0.62));
  const smoothHalf = Math.round(3 + 8 * t);
  const d = movingAvg(rawDiff, smoothHalf * 2 + 1);

  // Origin buffer: allow detecting polar products from Rf ~0.04 upwards
  const originBuffer = Math.max(4, Math.min(10, Math.round(r * 0.25)));
  const start = Math.round(o.origin + originBuffer);

  // Front buffer: allow detecting fast-eluting nonpolar spots up to Rf ~0.975 while excluding the solvent front boundary
  const end = Math.round(o.origin + Math.min(span - 3, 0.975 * span));

  if (end <= start) return [];

  // Compute baseline noise specifically within the chromatographic migration window (chrom)
  const chrom = d.slice(Math.max(start, 0), Math.min(n, end));
  const dmax = chrom.length > 0 ? Math.max(...chrom, 1e-9) : Math.max(...d, 1e-9);
  const med = chrom.length > 0 ? pctile(chrom, 0.5) : pctile(d, 0.5);
  const noise = chrom.length > 0
    ? 1.4826 * pctile(chrom.map((v) => Math.abs(v - med)), 0.5)
    : 1.4826 * pctile(d.map((v) => Math.abs(v - med)), 0.5);

  // Robust chromatographic signal threshold
  const thr = Math.max(2.4 * noise, 0.035 * dmax);

  // 1. Initial Candidate Peaks via local maximum search
  // halfWin scales dynamically with minProminence to avoid fracturing broad spots
  const halfWin = Math.max(4, Math.round(r * (0.2 + 0.55 * t)));

  const candidates: Array<{ pos: number; val: number; extentStart: number; extentEnd: number }> = [];

  for (let i = Math.max(start, 1); i < Math.min(end, n - 1); i++) {
    if (d[i] < thr) continue;
    let top = true;
    for (let k = Math.max(0, i - halfWin); k <= Math.min(n - 1, i + halfWin); k++) {
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

  // Filter out candidates that are just the upper rim or monotonic tail of an uneluted origin dot:
  // a genuine low-Rf spot close to the origin has a clear chromatographic valley separating it from o.origin.
  const nearOriginLimit = o.origin + Math.max(Math.round(0.055 * span), Math.round(r * 1.15));
  const originCoreStart = Math.max(0, Math.round(o.origin - r * 0.35));
  const filteredCandidates = candidates.filter((p) => {
    if (p.pos >= nearOriginLimit) return true;
    const originCoreEnd = Math.min(p.pos - 1, Math.round(o.origin + originBuffer));
    if (originCoreEnd < originCoreStart) return true;
    let originPeak = -Infinity;
    let originPeakIdx = originCoreStart;
    for (let k = originCoreStart; k <= originCoreEnd; k++) {
      if (d[k] > originPeak) {
        originPeak = d[k];
        originPeakIdx = k;
      }
    }
    if (originPeak < Math.max(thr, 0.45 * p.val)) return true;
    let valleyMin = Infinity;
    for (let k = originPeakIdx; k <= p.pos; k++) {
      if (d[k] < valleyMin) valleyMin = d[k];
    }
    const valleyDrop = p.val - valleyMin;
    return valleyDrop >= Math.max(0.35 * p.val, 2.5 * noise);
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
      // mergeDrop grows continuously with the slider (8% -> 0.19, 28% -> 0.35, 55% -> 0.57, 70% -> 0.69);
      // peaks that are also physically close (distance scales with the slider) merge a little more readily.
      const mergeDrop = Math.min(0.92, 0.12 + 0.82 * minProm);
      const closeDist = Math.max(10, Math.round(span * (0.01 + 0.10 * t)));
      const shouldMerge =
        dropRatio < mergeDrop ||
        (dist < closeDist && dropRatio < Math.min(0.95, mergeDrop + 0.15)) ||
        valleyDrop < 2.5 * noise;

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

  // Only accept a diffuse upper band as the solvent front if it spans >= 70% of all lanes
  const tol = Math.max(8, Math.round(n * 0.025));
  let supporting = 0;
  for (const p of profiles) {
    let maxL = 0;
    for (let k = Math.max(sIn, bestIdx - tol); k <= Math.min(p.length - sIn - 1, bestIdx + tol); k++) {
      const mL = windowMedian(p, k - sOut, k - sIn, buf);
      const mR = windowMedian(p, k + sIn, Math.min(p.length - 1, k + sOut), buf);
      const d = sign * (p[k] - 0.5 * (mL + mR));
      if (d > maxL) maxL = d;
    }
    if (maxL >= Math.max(6.0, 0.35 * bestFeat)) supporting++;
  }
  const frac = supporting / profiles.length;
  if (frac < 0.70) return { pos: 0, score: 0 };
  return { pos: bestIdx, score: 0.5 * snr * (0.4 + 0.6 * frac) };
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

  let best = detectFrontDetailed(medProfile, sign);

  // For multi-lane plates, aggregate clustered per-lane detections only with clear majority agreement
  // so gently bowed fronts retain full sharpness while high-Rf spot bands in <55% of wells are ignored.
  if (profiles.length >= 3) {
    const laneHits = profiles
      .map((p) => detectFrontDetailed(p, sign))
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
        const cScore = cl.map((r) => r.score).sort((a, b) => a - b);
        const medScore = cScore[cScore.length >> 1];
        const agreement = cl.length / profiles.length;
        const aggScore = medScore * (0.25 + 0.75 * agreement);
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

  return best;
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
    (set as any)._autoCacheSig = sig;
  }

  set.frontAuto = set.frontAuto || {};
  if (set.frontAuto[h] == null && set.cfg) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    let best: FrontDetectionResult = { pos: 0, score: 0 };
    for (const ch of channels) {
      const profiles = halfLanes.map((l) => getProfile(set, ch, l)).filter((p) => p.length > 0);
      if (!profiles.length) continue;
      const res = detectChannelFront(profiles, TLC_SIGNAL[ch]?.sign ?? 1, lane.length);
      if (res.score > best.score && res.pos > 0) {
        best = res;
      }
    }
    set.frontAuto[h] = best.pos > 0 ? best.pos : Math.round(lane.length * 0.93);
  }
  return set.frontAuto[h] ?? Math.round(lane.length * 0.93);
}

interface ChannelOriginResult extends FrontDetectionResult {
  byLane?: Record<number, number>;
}

function fitOriginQuadCurve(
  hits: Array<{ laneId: number; pos: number }>,
  medPos: number,
  laneLen: number
): Record<number, number> | undefined {
  if (hits.length < 10) return undefined;
  const uOf = (laneId: number) => ((laneId % 27) - 13) / 13;
  let c0 = medPos;
  let c1 = 0;
  let c2 = 0;

  for (let iter = 0; iter < 5; iter++) {
    const cutoff = Math.max(8, laneLen * 0.03);
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
    s22 += 0.05;
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
      if (Math.abs(M[piv][col]) < 1e-9) return undefined;
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

  const tol = Math.max(8, laneLen * 0.022);
  const inliers = hits.filter((h) => {
    const u = uOf(h.laneId);
    return Math.abs(h.pos - (c0 + c1 * u + c2 * u * u)) <= tol;
  });
  if (inliers.length < 10) return undefined;
  const cols = inliers.map((h) => h.laneId % 27);
  if (Math.max(...cols) - Math.min(...cols) < 12) return undefined;

  const baseHalf = hits[0].laneId < 27 ? 0 : 27;
  const maxShift = Math.max(14, Math.round(laneLen * 0.05));
  const out: Record<number, number> = {};
  for (let i = 0; i < 27; i++) {
    const u = (i - 13) / 13;
    const pred = Math.round(c0 + c1 * u + c2 * u * u);
    out[baseHalf + i] = Math.max(medPos - maxShift, Math.min(medPos + maxShift, pred));
  }
  return out;
}

function detectOriginNear(profile: number[], sign: number, refPos: number, localRadius: number): number {
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
  const flankIn = Math.max(5, Math.round(n * 0.016));
  const flankOut = flankIn + Math.max(8, Math.round(n * 0.030));

  const wLo = Math.max(4, Math.floor(n * 0.025), Math.round(refPos - localRadius));
  const wHi = Math.min(n - 5, Math.floor(n * 0.30), Math.round(refPos + localRadius));
  if (wHi <= wLo) return 0;

  const buf = new Float64Array(24);
  let bestIdx = 0;
  let bestScore = 0;
  let bestRawFeat = 0;

  for (let i = wLo; i <= wHi; i++) {
    if (i - flankIn < 1 || i + flankIn >= n - 1) continue;
    const c = windowMean(s, i - rCore, i + rCore);
    const mBelow = windowMedian(s, Math.max(0, i - flankOut), i - flankIn, buf);
    const mAbove = windowMedian(s, i + flankIn, Math.min(n - 1, i + flankOut), buf);
    const dBelow = sign * (c - mBelow);
    const dAbove = sign * (c - mAbove);

    if (dBelow > 0 && dAbove > 0) {
      const rawFeat = 0.65 * Math.min(dBelow, dAbove) + 0.35 * 0.5 * (dBelow + dAbove);
      const distFrac = Math.abs(i - refPos) / Math.max(1, localRadius);
      // Mild preference for staying close to backbone & outer edge so a low-Rf spot doesn't steal an origin dot
      const weight = 1 - (i > refPos ? 0.18 : 0.08) * distFrac;
      const sc = rawFeat * weight;
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
        bestRawFeat = rawFeat;
      }
    }
  }

  const snr = bestRawFeat / Math.max(sigmaS, 1.0);
  if (snr < 3.2 || bestRawFeat < 3.0 || bestIdx <= 0) return 0;
  return refineOriginCoreCenter(s, bestIdx, sign);
}

function detectChannelOrigin(
  laneEntries: Array<{ laneId: number; profile: number[] }>,
  sign: number,
  laneLen: number
): ChannelOriginResult {
  if (!laneEntries.length) return { pos: 0, score: 0 };

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

  let best: ChannelOriginResult = detectOriginDetailed(medProfile, sign);

  if (laneEntries.length >= 3) {
    const laneHits = laneEntries
      .map((e) => ({ laneId: e.laneId, ...detectOriginDetailed(e.profile, sign) }))
      .filter((r) => r.pos > 10);
    const minNeeded = Math.max(2, Math.ceil(laneEntries.length * 0.25));
    if (laneHits.length >= minNeeded) {
      const sortedByPos = laneHits.slice().sort((a, b) => a.pos - b.pos);
      const medPos = sortedByPos[sortedByPos.length >> 1].pos;
      const tol = Math.max(12, Math.round(laneLen * 0.04));
      const inCluster = laneHits.filter((r) => Math.abs(r.pos - medPos) <= tol);
      if (inCluster.length >= minNeeded) {
        const cPos = inCluster.map((r) => r.pos).sort((a, b) => a - b);
        const cScore = inCluster.map((r) => r.score).sort((a, b) => a - b);
        const pos = cPos[cPos.length >> 1];
        const medScore = cScore[cScore.length >> 1];
        const agreement = inCluster.length / laneEntries.length;
        const aggScore = medScore * (0.4 + 0.6 * agreement);
        const backbone = fitOriginQuadCurve(inCluster, pos, laneLen);

        // Second pass: lock each lane onto its own origin peak within experimental spotting error around backbone
        const localRadius = Math.max(14, Math.round(laneLen * 0.028));
        const sortedEntries = laneEntries.slice().sort((a, b) => a.laneId - b.laneId);
        const detected = sortedEntries.map((e) => {
          const refPos = backbone?.[e.laneId] ?? pos;
          const p = detectOriginNear(e.profile, sign, refPos, localRadius);
          return { laneId: e.laneId, refPos, pos: p };
        });

        const validIdx: number[] = [];
        for (let k = 0; k < detected.length; k++) {
          if (detected[k].pos > 0) validIdx.push(k);
        }

        const byLane: Record<number, number> = {};
        for (let k = 0; k < detected.length; k++) {
          const entry = detected[k];
          if (entry.pos > 0) {
            byLane[entry.laneId] = entry.pos;
          } else if (validIdx.length > 0) {
            let left = -1;
            let right = -1;
            for (const vi of validIdx) {
              if (vi < k) left = vi;
              else if (vi > k && right === -1) right = vi;
            }
            if (left !== -1 && right !== -1) {
              const dL = detected[left].pos - detected[left].refPos;
              const dR = detected[right].pos - detected[right].refPos;
              const f = (k - left) / (right - left);
              byLane[entry.laneId] = Math.round(entry.refPos + dL + (dR - dL) * f);
            } else {
              const near = left !== -1 ? left : right;
              const dist = Math.abs(k - near);
              const dN = detected[near].pos - detected[near].refPos;
              byLane[entry.laneId] = Math.round(entry.refPos + dN * Math.exp(-dist / 2));
            }
          } else {
            byLane[entry.laneId] = entry.refPos;
          }
        }

        if (aggScore > best.score || validIdx.length >= minNeeded) {
          best = { pos, score: Math.max(best.score, aggScore), byLane };
        }
      }
    }
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
    (set as any)._autoCacheSig = sig;
  }

  set.originAuto = set.originAuto || {};
  set.originAutoByLane = set.originAutoByLane || {};
  const h = tlcHalf(lane);
  if (set.originAuto[h] == null) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    let best: ChannelOriginResult = { pos: 0, score: 0 };
    for (const ch of channels) {
      const entries = halfLanes
        .map((l) => ({ laneId: l.id, profile: getProfile(set, ch, l) }))
        .filter((e) => e.profile.length > 0);
      if (!entries.length) continue;
      const res = detectChannelOrigin(entries, TLC_SIGNAL[ch]?.sign ?? -1, lane.length);
      if (res.score > best.score && res.pos > 10) {
        best = res;
      }
    }
    if (best.pos > 10) {
      set.originAuto[h] = best.pos;
      if (best.byLane) {
        Object.assign(set.originAutoByLane, best.byLane);
      }
    }
  }

  return set.originAutoByLane?.[lane.id] ?? set.originAuto?.[h] ?? Math.max(20, Math.round(lane.length * 0.10));
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

  const targetSets = scope === 'all' ? sets : [set];
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

  const targetSets = scope === 'all' ? sets : [set];

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

  for (const set of sets) {
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
 * Computes false-color dual channel composite (UV254 Quenching = Amber/Red, UV366 Fluorescence = Cyan).
 */
export function computeFalseColorComposite(
  uv254Data: Uint8ClampedArray,
  uv366Data: Uint8ClampedArray,
  width: number,
  height: number,
  gain: number = 1.4
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(uv254Data.length);

  // Estimate UV254 bright phosphor baseline
  let gSum = 0;
  for (let i = 0; i < uv254Data.length; i += 16) {
    gSum += uv254Data[i + 1];
  }
  const baseG = Math.max(100, (gSum / (uv254Data.length / 16)) * 1.05);

  for (let i = 0; i < uv254Data.length; i += 4) {
    // 1. Quenching signal (darkness in UV254 green channel)
    const g254 = uv254Data[i + 1];
    const qRaw = Math.max(0, (baseG - g254) / baseG);
    const q = Math.min(1.0, Math.pow(qRaw, 0.9) * 1.6);

    // 2. Fluorescence signal (brightness in UV366)
    const lum366 = 0.25 * uv366Data[i] + 0.35 * uv366Data[i + 1] + 0.40 * uv366Data[i + 2];
    const fRaw = Math.max(0, (lum366 - 25) / 230);
    const f = Math.min(1.0, Math.pow(fRaw, 0.85) * gain);

    // Dark matrix background: [12, 18, 30]
    // Quenching: Gold/Amber [245, 158, 11]
    // Fluorescence: Laser Cyan [6, 182, 212]
    out[i] = Math.min(255, Math.round(12 + q * 233 + f * 50));
    out[i + 1] = Math.min(255, Math.round(18 + q * 140 + f * 194));
    out[i + 2] = Math.min(255, Math.round(30 + q * 10 + f * 225));
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Renders an upright false-color composite lane canvas combining UV 254 nm quenching (gold/amber)
 * and UV 365 nm fluorescence (laser cyan).
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
  if (!im254?.bmp || !im366?.bmp) return null;

  const W = Math.max(1, Math.round(width || lane.width));
  const L = Math.max(1, Math.round(height || lane.length));

  const c1 = document.createElement('canvas');
  c1.width = W;
  c1.height = L;
  const ctx = c1.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // 1. Render UV254 lane upright
  const m254 = laneMatrix(lane, im254.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
  ctx.setTransform(m254[0], m254[1], m254[2], m254[3], m254[4], m254[5]);
  ctx.drawImage(im254.bmp, 0, 0);
  const data254 = ctx.getImageData(0, 0, W, L);

  // 2. Render UV366 lane upright
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, L);
  const m366 = laneMatrix(lane, im366.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
  ctx.setTransform(m366[0], m366[1], m366[2], m366[3], m366[4], m366[5]);
  ctx.drawImage(im366.bmp, 0, 0);
  const data366 = ctx.getImageData(0, 0, W, L);

  // 3. Compute composite pixels
  const compositeBytes = computeFalseColorComposite(data254.data, data366.data, W, L, gain);
  const imgData = ctx.createImageData(W, L);
  imgData.data.set(compositeBytes);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(imgData, 0, 0);

  return c1;
}

