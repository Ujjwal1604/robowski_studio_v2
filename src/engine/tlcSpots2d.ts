// Robowski Studio - Step 3: 2D Connected-Region & Watershed TLC Spot Segmentation Engine
//
// Provides:
//   1. Exact O(N) pentadiagonal arPLS (asymmetric reweighted penalized least squares) baseline,
//      shared identically by spot detection and densitometry (no window-mismatch drift).
//   2. Channel-calibrated 2D per-pixel spot-likelihood maps:
//      - UV254: F254 green-channel optical-density quenching
//      - UV366: dark-referenced full-spectrum RGB fluorescence excess
//      - White: perceptual CIELAB Delta-E76 + luminance darkening
//      Each with row-gutter horizontal-band suppression (killing solvent-front band & pencil false hits).
//   3. Intensity-guided marker-controlled 2D watershed segmentation with true 2D saddle merging,
//      neighbor-lane spillover rejection via horizontal centroid, origin-teardrop comet guards,
//      real segmented boundaries & 2D integrated areaPct, tailing asymmetry, and confidence scoring.

import type { LaneSpotMap2d, ProfileHistogramStats, TlcSpot } from '../types';

export type SpotVisionChannel = 'UV254' | 'UV366' | 'White';

// Precomputed sRGB [0..255] -> linear light [0..1] lookup table for fast perceptual CIELAB on White plates
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbByteToLin(v: number): number {
  const idx = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  return SRGB_TO_LIN[idx];
}

function labF(t: number): number {
  return t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
}

/**
 * Converts 8-bit sRGB (0..255) to D65 CIE L*a*b* coordinates.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbByteToLin(r);
  const gl = srgbByteToLin(g);
  const bl = srgbByteToLin(b);
  // sRGB -> CIE XYZ (D65 reference white: Xn=0.95047, Yn=1.00000, Zn=1.08883)
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Perceptual CIELAB Delta-E76 distance between two sRGB colors (0..~100+).
 */
export function rgbLabDeltaE(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const [l1, a1, bb1] = rgbToLab(r1, g1, b1);
  const [l2, a2, bb2] = rgbToLab(r2, g2, b2);
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = bb1 - bb2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

// ---- Exact O(N) Pentadiagonal Whittaker / arPLS Baseline Solver ----------------------------------

/**
 * Solves (diag(w) + lambda * D2^T D2) z = w .* y in O(N) time using symmetric banded LDL^T
 * factorization (bandwidth = 2). Numerically stable in Float64 for lambda up to ~1e8.
 */
function solveWhittakerD2(
  y: Float64Array,
  w: Float64Array,
  lambda: number,
  out: Float64Array
): void {
  const n = y.length;
  if (n < 4) {
    for (let i = 0; i < n; i++) out[i] = y[i];
    return;
  }

  const dd = new Float64Array(n);
  const l1 = new Float64Array(n);
  const l2 = new Float64Array(n);
  const u = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const c0 = i === 0 || i === n - 1 ? 1 : i === 1 || i === n - 2 ? 5 : 6;
    const d0 = Math.max(1e-9, w[i]) + lambda * c0;

    const l1Prev = i >= 1 ? l1[i - 1] : 0;
    const ddPrev = i >= 1 ? dd[i - 1] : 0;
    const l2Prev2 = i >= 2 ? l2[i - 2] : 0;
    const ddPrev2 = i >= 2 ? dd[i - 2] : 0;

    const diag = Math.max(1e-12, d0 - l1Prev * l1Prev * ddPrev - l2Prev2 * l2Prev2 * ddPrev2);
    dd[i] = diag;

    if (i + 1 < n) {
      const c1 = i === 0 || i === n - 2 ? -2 : -4;
      const d1 = lambda * c1;
      const l2Prev = i >= 1 ? l2[i - 1] : 0;
      l1[i] = (d1 - l2Prev * l1Prev * ddPrev) / diag;
    }
    if (i + 2 < n) {
      l2[i] = lambda / diag;
    }

    // Forward substitution L * u = w .* y
    const rhs = w[i] * y[i];
    u[i] = rhs - (i >= 1 ? l1Prev * u[i - 1] : 0) - (i >= 2 ? l2Prev2 * u[i - 2] : 0);
  }

  for (let i = 0; i < n; i++) u[i] /= dd[i];

  // Backward substitution L^T * out = u
  for (let i = n - 1; i >= 0; i--) {
    out[i] =
      u[i] -
      (i + 1 < n ? l1[i] * out[i + 1] : 0) -
      (i + 2 < n ? l2[i] * out[i + 2] : 0);
  }
}

/**
 * Computes an asymmetric reweighted penalized least-squares (arPLS) baseline constrained strictly
 * to the chromatographic span [origin, front] (flat-extended outside).
 *
 * - sign < 0 (UV254 / White): dark spots dip BELOW the bright silica baseline.
 * - sign > 0 (UV366): bright fluorescent spots rise ABOVE the dark silica baseline.
 *
 * Used identically by both spot detection and extractDensitogram() so plotted curves, baselines,
 * and integrated areas always agree 100%.
 */
export function computeArplsBaseline(
  profile: ArrayLike<number>,
  sign: number,
  origin: number,
  front: number,
  options?: { lambda?: number; iterations?: number }
): Float64Array {
  const n = profile.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n < 6) {
    for (let i = 0; i < n; i++) out[i] = profile[i];
    return out;
  }

  const span = Math.max(1, front - origin);
  const originBuf = Math.max(
    2,
    Math.min(Math.round(0.022 * span), Math.round(0.018 * span))
  );
  const rawLo = Math.max(0, Math.round(origin + originBuf));
  const rawHi = Math.min(n - 1, Math.round(front));
  const useChrom = rawHi - rawLo >= 12;
  const lo = useChrom ? rawLo : 0;
  const hi = useChrom ? rawHi : n - 1;
  const m = hi - lo + 1;

  // Orient interior slice so spots are ALWAYS positive excursions above the baseline
  const s = new Float64Array(m);
  const w = new Float64Array(m);
  const z = new Float64Array(m);
  const dir = sign < 0 ? -1 : 1;
  for (let i = 0; i < m; i++) {
    s[i] = dir * profile[lo + i];
    w[i] = 1;
  }

  // Smoothness lambda scaled so baseline follows linear & gentle illumination gradients
  // across the chromatographic span while bridging cleanly over wide spots and crowded bands.
  const autoLambda = Math.max(1500, Math.min(1.5e8, Math.pow(0.16 * m, 4)));
  const lambda = options?.lambda ?? autoLambda;
  const maxIter = options?.iterations ?? 12;

  // Phase 1: 4 fast Asymmetric Least Squares (AsLS) warm-start iterations so the baseline
  // immediately lifts to the true silica envelope even when spots cover >60% of the lane.
  const pAsym = 0.005;
  for (let iter = 0; iter < 4; iter++) {
    solveWhittakerD2(s, w, lambda, z);
    for (let i = 0; i < m; i++) {
      w[i] = s[i] > z[i] ? pAsym : 1 - pAsym;
    }
  }

  // Phase 2: Baek et al. arPLS noise-adaptive logistic refinement around the true silica noise floor.
  for (let iter = 0; iter < maxIter; iter++) {
    solveWhittakerD2(s, w, lambda, z);

    // Estimate mean & standard deviation of background (non-spot, d <= 0) residuals
    let negSum = 0;
    let negSqSum = 0;
    let negCnt = 0;
    for (let i = 0; i < m; i++) {
      const d = s[i] - z[i];
      if (d <= 0) {
        negSum += d;
        negSqSum += d * d;
        negCnt++;
      }
    }
    if (negCnt < 3) break;
    const meanNeg = negSum / negCnt;
    const varNeg = Math.max(0, negSqSum / negCnt - meanNeg * meanNeg);
    const stdNeg = Math.max(0.35, Math.sqrt(varNeg));

    let wDiff = 0;
    let wNorm = 0;
    // Cap -meanNeg contribution so broad spot clusters cannot pull the logistic pivot upward
    const pivot = Math.min(-meanNeg, 1.5 * stdNeg) + 2 * stdNeg;
    for (let i = 0; i < m; i++) {
      const d = s[i] - z[i];
      let nw = 1;
      if (d > 0) {
        const arg = Math.max(-40, Math.min(40, (2 * (d - pivot)) / stdNeg));
        nw = 1 / (1 + Math.exp(arg));
      }
      const dw = nw - w[i];
      wDiff += dw * dw;
      wNorm += w[i] * w[i];
      w[i] = nw;
    }
    if (wNorm > 0 && Math.sqrt(wDiff / wNorm) < 0.015) break;
  }

  // Re-orient baseline back to original intensity direction and flat-extend outside [lo, hi]
  for (let i = 0; i < m; i++) {
    out[lo + i] = dir * z[i];
  }
  const bLo = out[lo];
  const bHi = out[hi];
  for (let i = 0; i < lo; i++) out[i] = bLo;
  for (let i = hi + 1; i < n; i++) out[i] = bHi;

  return out;
}

// ---- Channel-Calibrated 2D Spot-Likelihood Map Builder -------------------------------------------

function quantileFloat(vals: Float32Array, len: number, q: number): number {
  if (len <= 0) return 0;
  const copy = vals.slice(0, len);
  copy.sort();
  return copy[Math.min(len - 1, Math.max(0, Math.round(q * (len - 1))))];
}

/**
 * Builds a compact, channel-calibrated 2D spot-likelihood map (<= 28 x 480 working grid) from a
 * straightened W x L RGBA lane strip (row 0 = top/front end, row L-1 = bottom/origin end).
 *
 * Output rows are indexed in chromatographic order (row 0 = origin end, row h-1 = front end),
 * matching 1D profile[0..L-1].
 */
export function buildLaneSpotMap2d(
  rgba: ArrayLike<number>,
  width: number,
  length: number,
  channel: SpotVisionChannel,
  bgRgb?: [number, number, number]
): LaneSpotMap2d | undefined {
  const W = Math.max(1, Math.round(width));
  const L = Math.max(1, Math.round(length));
  if (W < 3 || L < 12 || rgba.length < W * L * 4) return undefined;

  const w = Math.min(W, 28);
  const h = Math.min(L, 480);
  const map = new Float32Array(w * h);
  const localMap = new Float32Array(w * h);

  let resolvedBgRgb: [number, number, number];
  if (bgRgb) {
    resolvedBgRgb = bgRgb;
  } else {
    // Auto-estimate silica background RGB from flank columns in the interior 18%..82%
    const rSamples: number[] = [];
    const gSamples: number[] = [];
    const bSamples: number[] = [];
    const y0 = Math.floor(L * 0.18);
    const y1 = Math.ceil(L * 0.82);
    const stepY = Math.max(1, Math.floor((y1 - y0) / 80));
    const flankW = Math.max(1, Math.round(W * 0.15));
    for (let y = y0; y < y1; y += stepY) {
      const offRow = y * W * 4;
      for (let x = 0; x < flankW; x++) {
        const pL = offRow + x * 4;
        const pR = offRow + (W - 1 - x) * 4;
        rSamples.push(rgba[pL], rgba[pR]);
        gSamples.push(rgba[pL + 1], rgba[pR + 1]);
        bSamples.push(rgba[pL + 2], rgba[pR + 2]);
      }
    }
    const q = channel === 'UV366' ? 0.25 : 0.78;
    const pickQ = (arr: number[]) => {
      if (!arr.length) return channel === 'UV366' ? 15 : 220;
      arr.sort((a, b) => a - b);
      return arr[Math.min(arr.length - 1, Math.max(0, Math.round(q * (arr.length - 1))))];
    };
    resolvedBgRgb = [pickQ(rSamples), pickQ(gSamples), pickQ(bSamples)];
  }

  const [bgR, bgG, bgB] = resolvedBgRgb;
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const [bgLabL, bgLabA, bgLabB] = channel === 'White' ? rgbToLab(bgR, bgG, bgB) : [0, 0, 0];

  const flankCols = Math.max(1, Math.min(3, Math.round(w * 0.16)));

  // Box-average raw RGBA pixels into working (w x h) cells in chromatographic order (r=0 => origin)
  for (let r = 0; r < h; r++) {
    const iStart = Math.floor((r * L) / h);
    const iEnd = Math.max(iStart, Math.min(L - 1, Math.floor(((r + 1) * L) / h) - 1));
    const rowBase = r * w;

    for (let x = 0; x < w; x++) {
      const xStart = Math.floor((x * W) / w);
      const xEnd = Math.max(xStart, Math.min(W - 1, Math.floor(((x + 1) * W) / w) - 1));
      let sr = 0,
        sg = 0,
        sb = 0,
        cnt = 0;
      for (let i = iStart; i <= iEnd; i++) {
        const origY = L - 1 - i;
        const offRow = origY * W * 4;
        for (let ox = xStart; ox <= xEnd; ox++) {
          const p = offRow + ox * 4;
          sr += rgba[p] ?? 0;
          sg += rgba[p + 1] ?? 0;
          sb += rgba[p + 2] ?? 0;
          cnt++;
        }
      }
      if (cnt <= 0) cnt = 1;
      const pr = sr / cnt;
      const pg = sg / cnt;
      const pb = sb / cnt;

      let val = 0;
      if (channel === 'UV254') {
        // Unclipped inverted green intensity + gentle Beer-Lambert optical-density boost for dark cores.
        // Never clips against scalar bgG so faint spots in brighter plate zones keep 100% of their depth
        // before row-wise arPLS / flank subtraction removes smooth illumination drift.
        const invG = 255 - pg;
        const gDrop = Math.max(0, bgG - pg);
        const odBoost =
          gDrop > 0
            ? gDrop * 0.22 * Math.min(2.0, Math.log(Math.max(18, bgG) / Math.max(10, pg)))
            : 0;
        val = invG + odBoost;
      } else if (channel === 'UV366') {
        // Dark-referenced full-spectrum RGB fluorescence excess (blue/cyan/green/yellow/orange/red).
        // Shift reference slightly below median bgRgb (0.75x) so faint spots in darker plate corners
        // are not clipped to 0 before arPLS baseline removal.
        const dr = Math.max(0, pr - bgR * 0.75);
        const dg = Math.max(0, pg - bgG * 0.75);
        const db = Math.max(0, pb - bgB * 0.75);
        val = Math.max(dr, dg, db, Math.sqrt((dr * dr + dg * dg + db * db) / 2));
      } else {
        // White / visible stains: unclipped inverted luminance + perceptual CIELAB chroma Delta-E
        const invLuma = 255 - (0.299 * pr + 0.587 * pg + 0.114 * pb);
        const [l, a, b] = rgbToLab(pr, pg, pb);
        const da = a - bgLabA;
        const db = b - bgLabB;
        const chromaE = Math.sqrt(da * da + db * db);
        const dlDark = Math.max(0, bgLabL - l);
        const labBoost = Math.max(0, Math.sqrt(dlDark * dlDark + da * da + db * db) * 2.1 - Math.max(0, bgLuma - (255 - invLuma)));
        val = invLuma + Math.max(chromaE * 2.0, labBoost);
      }

      map[rowBase + x] = val;
    }

    // Shared horizontal background + band component at row r = min(leftFlankMean, rightFlankMean).
    // Because map is unclipped, subtracting sharedBand cancels BOTH the local silica illumination level
    // AND uniform full-width solvent-front bands / ruler lines, while preserving real spots (even with
    // neighbor spillover on ONE flank!).
    let leftSum = 0;
    let rightSum = 0;
    for (let fx = 0; fx < flankCols; fx++) {
      leftSum += map[rowBase + fx];
      rightSum += map[rowBase + (w - 1 - fx)];
    }
    const sharedBand = Math.min(leftSum / flankCols, rightSum / flankCols);
    for (let x = 0; x < w; x++) {
      localMap[rowBase + x] = Math.max(0, map[rowBase + x] - sharedBand);
    }
  }

  // Estimate 2D background pixel noise robustly from interior quiet-half vertical differences
  const rLo = Math.max(1, Math.floor(h * 0.12));
  const rHi = Math.min(h - 2, Math.ceil(h * 0.88));
  const diffSamples = new Float32Array(Math.min(400, (rHi - rLo + 1) * w));
  let dCnt = 0;
  const rStep = Math.max(1, Math.floor((rHi - rLo + 1) / 80));
  const xStep = Math.max(1, Math.floor(w / 5));
  for (let r = rLo; r <= rHi && dCnt < diffSamples.length; r += rStep) {
    for (let x = 0; x < w && dCnt < diffSamples.length; x += xStep) {
      diffSamples[dCnt++] = Math.abs(map[(r + 1) * w + x] - map[(r - 1) * w + x]);
    }
  }
  const medDiff = quantileFloat(diffSamples, dCnt, 0.45);
  const bgSigma = Math.max(0.6, (1.4826 * medDiff) / Math.SQRT2);

  return {
    w,
    h,
    origLen: L,
    map,
    localMap,
    bgSigma,
    channel,
  };
}

// ---- 2D Separable Light Smoothing ----------------------------------------------------------------

function smooth2dLight(src: Float32Array, w: number, h: number, rLo: number, rHi: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const lo = Math.max(0, rLo);
  const hi = Math.min(h - 1, rHi);

  // Horizontal 3-tap [0.22, 0.56, 0.22]
  for (let r = lo; r <= hi; r++) {
    const off = r * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x + 1 < w ? x + 1 : w - 1;
      tmp[off + x] = 0.22 * src[off + xm] + 0.56 * src[off + x] + 0.22 * src[off + xp];
    }
  }

  // Vertical 5-tap [0.10, 0.24, 0.32, 0.24, 0.10] clamped strictly within [lo, hi]
  for (let r = lo; r <= hi; r++) {
    const r2m = Math.max(lo, r - 2);
    const r1m = Math.max(lo, r - 1);
    const r1p = Math.min(hi, r + 1);
    const r2p = Math.min(hi, r + 2);
    const o = r * w;
    const o2m = r2m * w;
    const o1m = r1m * w;
    const o1p = r1p * w;
    const o2p = r2p * w;
    for (let x = 0; x < w; x++) {
      out[o + x] =
        0.10 * tmp[o2m + x] +
        0.24 * tmp[o1m + x] +
        0.32 * tmp[o + x] +
        0.24 * tmp[o1p + x] +
        0.10 * tmp[o2p + x];
    }
  }
  return out;
}

// ---- 2D Connected-Region & Marker-Controlled Watershed Spot Segmentation -------------------------

export interface SegmentSpots2dOptions {
  origin: number;
  front: number;
  minProminence?: number;
  minDistance?: number;
  radius?: number;
  plateHistogram?: ProfileHistogramStats;
  /** Optional raw 1D lateral metrics (for offPlate / borderStraddle checks) */
  offPlate?: boolean;
  borderStraddle?: boolean;
}

/**
 * Segments TLC spots directly in 2D using:
 *   1. arPLS vertical background drift removal inside [origin, front]
 *   2. 2D local-maxima seed extraction on the gutter-suppressed likelihood map
 *   3. Exact descending-intensity marker-controlled watershed flooding with saddle tracking
 *   4. Chromatographic 2D saddle & lateral-waist basin consolidation
 *   5. Physics-based 2D artifact rejection (neighbor spillover, horizontal front bands,
 *      origin-dot teardrops, dust specks) and real 2D geometry / areaPct / confidence scoring.
 */
export function segmentLaneSpots2d(
  spotMap: LaneSpotMap2d,
  opts: SegmentSpots2dOptions
): TlcSpot[] {
  if (opts.offPlate || opts.borderStraddle) return [];
  const { w, h, origLen, map, localMap, bgSigma, channel } = spotMap;
  if (w < 3 || h < 12 || origLen < 12) return [];

  const origSpan = Math.max(1, opts.front - opts.origin);
  const scaleY = (origLen - 1) / Math.max(1, h - 1);
  const invScaleY = 1 / scaleY;

  const originRow = Math.max(0, Math.min(h - 1, Math.round(opts.origin * invScaleY)));
  const frontRow = Math.max(0, Math.min(h - 1, Math.round(opts.front * invScaleY)));
  const spanRows = frontRow - originRow;
  if (spanRows < 10) return [];

  const minProm = opts.minProminence ?? 0.28;
  const t = Math.min(1, Math.max(0, (minProm - 0.08) / 0.62));
  const rOrig = opts.radius || 24;

  // Origin buffer (~1.8-2.2% Rf) and front reach (up to Rf 0.985)
  const originBufOrig = Math.max(
    3,
    Math.min(
      Math.round(0.022 * origSpan),
      Math.max(Math.round(rOrig * 0.20), Math.round(0.018 * origSpan))
    )
  );
  const startRow = Math.min(frontRow - 2, Math.max(1, Math.round((opts.origin + originBufOrig) * invScaleY)));
  const endRow = Math.min(
    h - 2,
    Math.max(startRow + 2, Math.round((opts.origin + Math.min(origSpan - 2, 0.985 * origSpan)) * invScaleY))
  );
  if (endRow <= startRow + 2) return [];

  // 1. Light 2D smoothing inside [originRow, frontRow] (preserves close doublets cleanly)
  const rawSm = smooth2dLight(map, w, h, originRow, frontRow);
  const locSm = smooth2dLight(localMap, w, h, originRow, frontRow);

  // 2. Remove smooth vertical illumination drift inside [originRow, frontRow] using arPLS
  //    computed on the interior lane core mean of rawSm and locSm.
  const cx0 = Math.max(0, Math.floor(w * 0.22));
  const cx1 = Math.min(w - 1, Math.ceil(w * 0.78) - 1);
  const cCount = Math.max(1, cx1 - cx0 + 1);
  const rawCoreProf = new Float64Array(h);
  const rawCoreForBase = new Float64Array(h);
  const locCoreProf = new Float64Array(h);
  const baseFlankCols = Math.max(1, Math.min(3, Math.round(w * 0.16)));
  const negPitTol = Math.max(4, 2.5 * bgSigma);
  for (let r = originRow; r <= frontRow; r++) {
    const off = r * w;
    let sR = 0,
      sL = 0;
    for (let x = cx0; x <= cx1; x++) {
      sR += rawSm[off + x];
      sL += locSm[off + x];
    }
    const coreMean = sR / cCount;
    rawCoreProf[r] = coreMean;
    locCoreProf[r] = sL / cCount;
    if (channel === 'UV254') {
      // Bright green fluorescence under UV254 drives invG strongly below silica background,
      // which would otherwise drag the lower-envelope arPLS baseline down and create phantom
      // dark spots on adjacent blank silica. Floor localized negative pits against the brighter flank.
      let leftSum = 0;
      let rightSum = 0;
      for (let fx = 0; fx < baseFlankCols; fx++) {
        leftSum += rawSm[off + fx];
        rightSum += rawSm[off + (w - 1 - fx)];
      }
      const flankSilica = Math.min(leftSum / baseFlankCols, rightSum / baseFlankCols);
      rawCoreForBase[r] = Math.max(coreMean, flankSilica - negPitTol);
    } else {
      rawCoreForBase[r] = coreMean;
    }
  }

  const rawBase = computeArplsBaseline(rawCoreForBase, 1, originRow, frontRow);
  const locBase = computeArplsBaseline(locCoreProf, 1, originRow, frontRow);

  // Precompute a smooth row-level lateral-peaking gate inside [originRow, frontRow] from the
  // inner lane-center (34%-66% width) smoothed 1D profiles. Measuring the true oval center avoids
  // diluting shared-Rf spots with their outer wings, while strictly zeroing flat horizontal bands.
  const icx0 = Math.max(cx0, Math.floor(w * 0.34));
  const icx1 = Math.min(cx1, Math.ceil(w * 0.66) - 1);
  const icCount = Math.max(1, icx1 - icx0 + 1);
  const rawCoreSub = new Float64Array(h);
  const locCoreSub = new Float64Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    const off = r * w;
    let sR = 0;
    let sL = 0;
    for (let x = icx0; x <= icx1; x++) {
      sR += rawSm[off + x];
      sL += locSm[off + x];
    }
    const rVal = Math.max(0, sR / icCount - rawBase[r]);
    const lVal = Math.max(0, Math.min(sL / icCount - locBase[r], rVal));
    rawCoreSub[r] = rVal;
    locCoreSub[r] = lVal;
  }
  const rowGate = new Float32Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    const r2m = Math.max(originRow, r - 2);
    const r1m = Math.max(originRow, r - 1);
    const r1p = Math.min(frontRow, r + 1);
    const r2p = Math.min(frontRow, r + 2);
    const rS =
      0.10 * rawCoreSub[r2m] +
      0.24 * rawCoreSub[r1m] +
      0.32 * rawCoreSub[r] +
      0.24 * rawCoreSub[r1p] +
      0.10 * rawCoreSub[r2p];
    const lS =
      0.10 * locCoreSub[r2m] +
      0.24 * locCoreSub[r1m] +
      0.32 * locCoreSub[r] +
      0.24 * locCoreSub[r1p] +
      0.10 * locCoreSub[r2p];
    if (rS > 1e-4) {
      const ratioTerm = Math.min(1, Math.max(0, (lS / rS - 0.08) / 0.14));
      const absTerm = Math.min(1, Math.max(0, (lS - 2.2) / 3.2));
      rowGate[r] = ratioTerm * absTerm;
    }
  }

  // Compute smoothed 1D lane-core profile across [cx0..cx1] (22%..78% width) inside [originRow, frontRow].
  // Averaging across the lane core suppresses mottled 2D silica/camera grain by ~4x so chromatographic
  // valley checks distinguish genuine vertically separated doublets from grainy monotonic tails.
  const wideCoreRaw = new Float64Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    wideCoreRaw[r] = Math.max(0, rawCoreProf[r] - rawBase[r]);
  }
  const wideCore1d = new Float64Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    const r2m = Math.max(originRow, r - 2);
    const r1m = Math.max(originRow, r - 1);
    const r1p = Math.min(frontRow, r + 1);
    const r2p = Math.min(frontRow, r + 2);
    wideCore1d[r] =
      0.10 * wideCoreRaw[r2m] +
      0.24 * wideCoreRaw[r1m] +
      0.32 * wideCoreRaw[r] +
      0.24 * wideCoreRaw[r1p] +
      0.10 * wideCoreRaw[r2p];
  }

  // Build baseline-corrected 2D fields inside [originRow, frontRow].
  // - Near the solvent front (rf >= 0.88): use strict gutter-subtracted localField to suppress
  //   uniform horizontal solvent-front bands & pencil marks.
  // - In the chromatographic interior (rf < 0.88): apply smooth rowGate[r] to raw darkness/fluorescence
  //   so faint & medium shared-Rf HTE spots recover clean single-peaked contrast while flat bands
  //   (rowGate = 0) stay completely suppressed, and strong coalesced spots (> ceil) pass directly.
  const interiorBandCeil = channel === 'UV366' ? 28 : 40;
  const frontBandStartRow = Math.round(originRow + 0.88 * spanRows);

  const rawField = new Float32Array(w * h);
  const F = new Float32Array(w * h);
  let fMax = 0;
  for (let r = originRow; r <= frontRow; r++) {
    const off = r * w;
    const rb = rawBase[r];
    const lb = locBase[r];
    const isNearFront = r >= frontBandStartRow;
    const gate = rowGate[r];
    for (let x = 0; x < w; x++) {
      const rv = Math.max(0, rawSm[off + x] - rb);
      const lvRaw = Math.max(0, locSm[off + x] - lb);
      // Local excess can never exceed true baseline-subtracted darkness/fluorescence (rv);
      // clamping prevents bright flank-noise specks from inventing fake signal on blank silica.
      const lv = Math.min(lvRaw, rv);
      const fv = isNearFront
        ? lv
        : Math.max(lv, rv * gate, Math.max(0, rv - interiorBandCeil));
      rawField[off + x] = rv;
      F[off + x] = fv;
      if (r >= startRow && r <= endRow && fv > fMax) fMax = fv;
    }
  }
  if (fMax <= 1e-4) return [];

  // 1D core profile of F across [cx0..cx1] (reflects gutter-gated chromatographic valleys cleanly)
  const fCoreRaw = new Float64Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    const off = r * w;
    let sum = 0;
    for (let x = cx0; x <= cx1; x++) sum += F[off + x];
    fCoreRaw[r] = sum / cCount;
  }
  const fCore1d = new Float64Array(h);
  for (let r = originRow; r <= frontRow; r++) {
    const r2m = Math.max(originRow, r - 2);
    const r1m = Math.max(originRow, r - 1);
    const r1p = Math.min(frontRow, r + 1);
    const r2p = Math.min(frontRow, r + 2);
    fCore1d[r] =
      0.10 * fCoreRaw[r2m] +
      0.24 * fCoreRaw[r1m] +
      0.32 * fCoreRaw[r] +
      0.24 * fCoreRaw[r1p] +
      0.10 * fCoreRaw[r2p];
  }
  const measureProfileValley = (prof: Float64Array, rowA: number, rowB: number) => {
    const rLo = Math.max(originRow, Math.min(frontRow, Math.min(rowA, rowB)));
    const rHi = Math.max(originRow, Math.min(frontRow, Math.max(rowA, rowB)));
    let idxLo = rLo;
    let pLo = prof[rLo];
    for (let r = Math.max(originRow, rLo - 1); r <= Math.min(rHi, rLo + 1); r++) {
      if (prof[r] > pLo) {
        pLo = prof[r];
        idxLo = r;
      }
    }
    let idxHi = rHi;
    let pHi = prof[rHi];
    for (let r = Math.max(idxLo, rHi - 1); r <= Math.min(frontRow, rHi + 1); r++) {
      if (prof[r] > pHi) {
        pHi = prof[r];
        idxHi = r;
      }
    }
    let valley = Infinity;
    for (let r = idxLo; r <= idxHi; r++) {
      if (prof[r] < valley) valley = prof[r];
    }
    if (!Number.isFinite(valley)) valley = 0;
    const lower1d = Math.min(pLo, pHi);
    const higher1d = Math.max(pLo, pHi);
    const valleyDrop1d = Math.max(0, lower1d - valley);
    const dropRatio1d = lower1d > 1e-4 ? valleyDrop1d / lower1d : 0;
    return { pLo, pHi, valley, lower1d, higher1d, valleyDrop1d, dropRatio1d };
  };
  const measure1dValley = (rowA: number, rowB: number) => {
    const rHi = Math.max(originRow, Math.min(frontRow, Math.max(rowA, rowB)));
    const vf = measureProfileValley(fCore1d, rowA, rowB);
    if (rHi >= frontBandStartRow) return vf;
    const vw = measureProfileValley(wideCore1d, rowA, rowB);
    // Keep both profiles' evidence: a genuine valley visible in gutter-gated F (e.g. two adjacent
    // UV254 spots bridged by a faint wide shadow) is preserved, while monotonic grain ripples on
    // a wide tailing streak lack a valley on BOTH profiles.
    return {
      pLo: vw.pLo,
      pHi: vw.pHi,
      valley: Math.min(vw.valley, vf.valley),
      rawValley: vw.valley,
      lower1d: vw.lower1d,
      higher1d: vw.higher1d,
      valleyDrop1d: Math.max(vw.valleyDrop1d, vf.valleyDrop1d),
      dropRatio1d: Math.max(vw.dropRatio1d, vf.dropRatio1d),
      rawDrop1d: vw.valleyDrop1d,
      rawDropRatio1d: vw.dropRatio1d,
    };
  };

  // 3. Robust 2D post-smoothing local-noise & physical minimum detection floor calibrated by channel + slider.
  //    Measure noise directly on continuous smoothed rawSm (lag-2 vertical differences) rather than raw
  //    8-bit integer map pixels (which quantize discontinuously to 1.05 / 2.10 / 3.15), and never use
  //    plate-wide vignette hist.bgSigma.
  const smDiffs = new Float32Array(320);
  let smDiffCnt = 0;
  const nLo = Math.max(originRow + 2, originRow + Math.round(spanRows * 0.14));
  const nHi = Math.min(frontRow - 2, originRow + Math.round(spanRows * 0.86));
  if (nHi > nLo + 2) {
    const nStepR = Math.max(1, Math.floor((nHi - nLo + 1) / 64));
    const nStepX = Math.max(1, Math.floor(w / 5));
    for (let r = nLo; r <= nHi && smDiffCnt < smDiffs.length; r += nStepR) {
      for (let x = 0; x < w && smDiffCnt < smDiffs.length; x += nStepX) {
        smDiffs[smDiffCnt++] = Math.abs(rawSm[(r + 2) * w + x] - rawSm[(r - 2) * w + x]);
      }
    }
  }
  const smoothedSigma =
    smDiffCnt >= 16 ? (1.4826 * quantileFloat(smDiffs, smDiffCnt, 0.45)) / Math.SQRT2 : bgSigma * 0.72;
  const hist = opts.plateHistogram;
  const effSigma = Math.max(0.65, Math.min(bgSigma, smoothedSigma));

  const isDarkSpotCh = channel !== 'UV366';
  const contrastFloor =
    hist && hist.sampleCount >= 8
      ? Math.min(isDarkSpotCh ? 7.5 : 4.6, (isDarkSpotCh ? 0.025 : 0.015) * hist.contrastSpan)
      : isDarkSpotCh
      ? 5.0
      : 3.0;
  const absFloor = isDarkSpotCh
    ? Math.max(6.8 + 4.8 * t, (4.8 + 1.8 * t) * effSigma, contrastFloor)
    : Math.max(3.4 + 3.0 * t, (3.8 + 1.6 * t) * effSigma, contrastFloor);

  // Cap relative-to-fMax floor so a single pitch-black saturated spot in the same lane
  // never blinds the detector to genuine faint spots (peakVal 10..20).
  const relFloor = Math.min(8.0 + 4.5 * t, (0.020 + 0.024 * t) * fMax);
  const peakThr = Math.max(absFloor, relFloor);
  // Foreground mask captures spot wings down to ~35% of peak floor (above noise)
  const fgThr = Math.max(1.8 * effSigma, Math.min(peakThr * 0.40, Math.max(1.6, 0.024 * fMax)));

  // 4. 2D Local-Maxima Seed Extraction inside [startRow .. endRow]
  const rY = Math.max(2, Math.round((rOrig * invScaleY) * (0.14 + 0.30 * t)));
  const rX = Math.max(1, Math.min(5, Math.round(w * 0.16)));

  interface Seed {
    id: number;
    x: number;
    y: number;
    val: number;
  }
  const seeds: Seed[] = [];

  for (let r = startRow; r <= endRow; r++) {
    const off = r * w;
    for (let x = 0; x < w; x++) {
      const v = F[off + x];
      if (v < peakThr) continue;
      // Quick 4-neighbor reject
      if (x > 0 && F[off + x - 1] > v) continue;
      if (x + 1 < w && F[off + x + 1] > v) continue;
      if (r > startRow && F[(r - 1) * w + x] > v) continue;
      if (r < endRow && F[(r + 1) * w + x] > v) continue;

      let isMax = true;
      const y0 = Math.max(startRow, r - rY);
      const y1 = Math.min(endRow, r + rY);
      const x0 = Math.max(0, x - rX);
      const x1 = Math.min(w - 1, x + rX);
      for (let yy = y0; yy <= y1 && isMax; yy++) {
        const ro = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const nv = F[ro + xx];
          if (nv > v || (nv === v && (yy < r || (yy === r && xx < x)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) {
        seeds.push({ id: seeds.length + 1, x, y: r, val: v });
      }
    }
  }

  if (seeds.length === 0) return [];

  // 5. Intensity-Guided Marker-Controlled 2D Watershed Flooding (descending order of F)
  const labels = new Int32Array(w * h);
  for (const s of seeds) {
    labels[s.y * w + s.x] = s.id;
  }

  const fgIndices: number[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const off = r * w;
    for (let x = 0; x < w; x++) {
      if (F[off + x] >= fgThr) fgIndices.push(off + x);
    }
  }
  fgIndices.sort((a, b) => F[b] - F[a]);

  // Track highest saddle height & saddle pixel coordinates between every pair of touching basins
  const saddleHeight = new Map<number, number>();
  const saddleRowSum = new Map<number, number>();
  const saddleCount = new Map<number, number>();
  const pairKey = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);

  const neighborLabels = new Int32Array(8);
  const dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];

  for (let idx = 0; idx < fgIndices.length; idx++) {
    const p = fgIndices[idx];
    const r = Math.floor(p / w);
    const x = p - r * w;
    const curVal = F[p];

    let nCnt = 0;
    let bestLab = labels[p];
    let bestNVal = -1;

    for (let k = 0; k < 8; k++) {
      const nx = x + dx8[k];
      const ny = r + dy8[k];
      if (nx < 0 || nx >= w || ny < startRow || ny > endRow) continue;
      const np = ny * w + nx;
      const nLab = labels[np];
      if (nLab > 0) {
        neighborLabels[nCnt++] = nLab;
        if (labels[p] === 0 && F[np] > bestNVal) {
          bestNVal = F[np];
          bestLab = nLab;
        }
      }
    }

    if (labels[p] === 0 && bestLab > 0) {
      labels[p] = bestLab;
    }

    const assigned = labels[p];
    if (assigned > 0 && nCnt > 0) {
      for (let k = 0; k < nCnt; k++) {
        const other = neighborLabels[k];
        if (other !== assigned) {
          const pk = pairKey(assigned, other);
          const prev = saddleHeight.get(pk) ?? -1;
          if (curVal > prev) saddleHeight.set(pk, curVal);
          saddleRowSum.set(pk, (saddleRowSum.get(pk) ?? 0) + r);
          saddleCount.set(pk, (saddleCount.get(pk) ?? 0) + 1);
        }
      }
    }
  }

  // 6. Iterative Chromatographic 2D Basin Merging (true 2D saddle resolution + lateral waist check)
  //    Merges horizontal same-Rf split lobes and shallow saddles without over-splitting broad ovals.
  interface BasinStats {
    id: number;
    peakVal: number;
    peakX: number;
    peakY: number;
    mass: number;
    sumY: number;
    sumX: number;
    minY: number;
    maxY: number;
    peakRowWidth: number;
  }

  const parent = new Int32Array(seeds.length + 1);
  for (let i = 0; i <= seeds.length; i++) parent[i] = i;
  const findRoot = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };

  // Precompute active width per row on foreground mask for 2D hourglass waist verification
  const rowFgWidth = new Float32Array(h);
  for (let r = startRow; r <= endRow; r++) {
    const off = r * w;
    let cnt = 0;
    for (let x = 0; x < w; x++) {
      if (F[off + x] >= Math.max(fgThr, 0.25 * peakThr)) cnt++;
    }
    rowFgWidth[r] = cnt;
  }

  const computeBasinStats = (): Map<number, BasinStats> => {
    const stats = new Map<number, BasinStats>();
    for (let idx = 0; idx < fgIndices.length; idx++) {
      const p = fgIndices[idx];
      const rawLab = labels[p];
      if (rawLab <= 0) continue;
      const root = findRoot(rawLab);
      const r = Math.floor(p / w);
      const x = p - r * w;
      const v = F[p];
      let st = stats.get(root);
      if (!st) {
        st = {
          id: root,
          peakVal: v,
          peakX: x,
          peakY: r,
          mass: 0,
          sumY: 0,
          sumX: 0,
          minY: r,
          maxY: r,
          peakRowWidth: rowFgWidth[r],
        };
        stats.set(root, st);
      }
      if (v > st.peakVal) {
        st.peakVal = v;
        st.peakX = x;
        st.peakY = r;
        st.peakRowWidth = rowFgWidth[r];
      }
      st.mass += v;
      st.sumY += r * v;
      st.sumX += x * v;
      if (r < st.minY) st.minY = r;
      if (r > st.maxY) st.maxY = r;
    }
    return stats;
  };

  const baseMergeDrop = Math.min(0.90, 0.06 + 0.88 * minProm);
  const sameRfVertTol = Math.max(2.5, spanRows * 0.018);
  const closeVertDist = Math.max(5, spanRows * (0.012 + 0.095 * t));

  for (let iter = 0; iter < 40; iter++) {
    const stats = computeBasinStats();
    if (stats.size <= 1) break;

    // Aggregate touching saddle heights across current merged root IDs
    const rootSaddle = new Map<number, { h: number; rowSum: number; cnt: number; a: number; b: number }>();
    for (const [pk, sH] of saddleHeight.entries()) {
      const a0 = Math.floor(pk / 65536);
      const b0 = pk - a0 * 65536;
      const ra = findRoot(a0);
      const rb = findRoot(b0);
      if (ra === rb) continue;
      if (!stats.has(ra) || !stats.has(rb)) continue;
      const rpk = pairKey(ra, rb);
      const prev = rootSaddle.get(rpk);
      const rSum = saddleRowSum.get(pk) ?? 0;
      const rCnt = saddleCount.get(pk) ?? 0;
      if (!prev) {
        rootSaddle.set(rpk, { h: sH, rowSum: rSum, cnt: rCnt, a: Math.min(ra, rb), b: Math.max(ra, rb) });
      } else {
        if (sH > prev.h) prev.h = sH;
        prev.rowSum += rSum;
        prev.cnt += rCnt;
      }
    }

    let bestMerge: { a: number; b: number; priority: number } | null = null;

    for (const entry of rootSaddle.values()) {
      const sa = stats.get(entry.a)!;
      const sb = stats.get(entry.b)!;
      const cyA = sa.sumY / Math.max(sa.mass, 1e-6);
      const cyB = sb.sumY / Math.max(sb.mass, 1e-6);
      const vertDist = Math.abs(cyA - cyB);

      const lowerPeak = Math.min(sa.peakVal, sb.peakVal);
      const higherPeak = Math.max(sa.peakVal, sb.peakVal, 1e-6);
      const saddleDrop = Math.max(0, lowerPeak - entry.h);
      const dropRatio = lowerPeak > 0 ? saddleDrop / lowerPeak : 0;

      // (a) Horizontally side-by-side lobes at the same Rf are ALWAYS one broad/crescent spot
      if (vertDist < sameRfVertTol) {
        const prio = -2 + dropRatio;
        if (!bestMerge || prio < bestMerge.priority) {
          bestMerge = { a: entry.a, b: entry.b, priority: prio };
        }
        continue;
      }

      // (a2) 1D chromatographic vertical-valley verification:
      //      In TLC, separation occurs strictly along the vertical migration axis (Rf). Two
      //      vertically stacked 2D basins sitting on a monotonic 1D slope (created by mottled
      //      silica/camera grain on a broad tailing band) lack a real 1D valley and MUST merge.
      const v1d = measure1dValley(sa.peakY, sb.peakY);
      const min1dValleyAbs = Math.max(2.6 * effSigma, isDarkSpotCh ? 3.5 : 3.0);
      const min1dDropRatio = 0.06 + 0.06 * t;
      const lacks1dValley =
        v1d.lower1d > 1e-4 &&
        (v1d.valleyDrop1d < min1dValleyAbs || v1d.dropRatio1d < min1dDropRatio);
      if (lacks1dValley) {
        const prio = -1 + v1d.dropRatio1d;
        if (!bestMerge || prio < bestMerge.priority) {
          bestMerge = { a: entry.a, b: entry.b, priority: prio };
        }
        continue;
      }

      // (b) 2D Hourglass doublet protection: two strong vertically stacked spots with BOTH a clear
      //     1D vertical valley AND a 2D saddle + narrower waist stay resolved in Sensitive/Standard modes
      const saddleRow = Math.round(entry.rowSum / Math.max(1, entry.cnt));
      const waistW = rowFgWidth[Math.max(startRow, Math.min(endRow, saddleRow))];
      const minLobeW = Math.min(sa.peakRowWidth, sb.peakRowWidth);
      const widthPinch = minLobeW > 0 ? (minLobeW - waistW) / minLobeW : 0;
      const isStrong2dDoublet =
        t < 0.72 &&
        vertDist >= Math.max(4, spanRows * 0.022) &&
        lowerPeak >= Math.max(peakThr * 1.5, 16) &&
        saddleDrop >= Math.max(4.5, 2.6 * effSigma) &&
        dropRatio >= 0.045 + 0.08 * t &&
        v1d.valleyDrop1d >= Math.max(4.2, 2.8 * effSigma) &&
        v1d.dropRatio1d >= 0.08 + 0.08 * t &&
        widthPinch >= 0.08;

      if (isStrong2dDoublet) continue;

      // (c) Chromatographic saddle resolution check (combining 2D saddle and 1D vertical valley)
      const effDropRatio = Math.min(dropRatio, v1d.dropRatio1d);
      const sep = Math.min(1, Math.max(0, (vertDist / spanRows - 0.065) / 0.015));
      const asym = Math.min(1, Math.max(0, (1 - lowerPeak / higherPeak) / 0.22));
      // Only grant the long-distance asymmetry discount when the minor peak is substantive and
      // separated by a genuine valley — never for tiny noise/halo ripples on a broad spot's skirt.
      const isSubstantiveMinor =
        lowerPeak >= Math.max(peakThr * 1.65, isDarkSpotCh ? 22 : 16) &&
        saddleDrop >= Math.max(3.6 * effSigma, 0.75 * absFloor) &&
        v1d.valleyDrop1d >= Math.max(3.6 * effSigma, 0.70 * absFloor);
      const distDiscount = isSubstantiveMinor
        ? 1 - 0.80 * sep * asym * Math.max(0, 1 - t / 0.75)
        : 1;
      const reqDrop = baseMergeDrop * distDiscount;

      // Faint shoulder/halo-rim ripple guard: a weak (<22% of parent peak) satellite touching a
      // broad primary spot without returning near background is a halo edge ripple, not a compound.
      const isFaintSkirtRipple =
        lowerPeak / higherPeak < 0.22 &&
        lowerPeak < (isDarkSpotCh ? 26 : 24) &&
        (effDropRatio < Math.max(baseMergeDrop, 0.48) ||
          saddleDrop < Math.max(4.2 * effSigma, 0.85 * absFloor, isDarkSpotCh ? 7.5 : 6.0));

      const shouldMerge =
        isFaintSkirtRipple ||
        effDropRatio < reqDrop ||
        (vertDist < closeVertDist && effDropRatio < Math.min(0.94, baseMergeDrop + 0.14)) ||
        saddleDrop < Math.max(2.4 * effSigma, 0.45 * absFloor);

      if (shouldMerge) {
        const prio = effDropRatio;
        if (!bestMerge || prio < bestMerge.priority) {
          bestMerge = { a: entry.a, b: entry.b, priority: prio };
        }
      }
    }

    if (!bestMerge) break;
    // Merge smaller peak into larger peak root
    const sa = stats.get(bestMerge.a)!;
    const sb = stats.get(bestMerge.b)!;
    if (sa.peakVal >= sb.peakVal) {
      parent[bestMerge.b] = bestMerge.a;
    } else {
      parent[bestMerge.a] = bestMerge.b;
    }
  }

  // Gather final pixel sets & geometry per surviving basin
  const finalMap = new Map<
    number,
    {
      pixels: number[];
      peakVal: number;
      rawPeakVal: number;
      peakRow: number;
      mass: number;
      localMass: number;
      rawMass: number;
      coreLocalMass: number;
      coreRawMass: number;
      sumY: number;
      sumY2: number;
      sumX: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      rowMass: Map<number, number>;
    }
  >();

  for (let idx = 0; idx < fgIndices.length; idx++) {
    const p = fgIndices[idx];
    const rawLab = labels[p];
    if (rawLab <= 0) continue;
    const root = findRoot(rawLab);
    const r = Math.floor(p / w);
    const x = p - r * w;
    const v = F[p];
    const rv = rawField[p];
    const lv = Math.max(0, Math.min(locSm[p] - locBase[r], rv));

    let reg = finalMap.get(root);
    if (!reg) {
      reg = {
        pixels: [],
        peakVal: v,
        rawPeakVal: rv,
        peakRow: r,
        mass: 0,
        localMass: 0,
        rawMass: 0,
        coreLocalMass: 0,
        coreRawMass: 0,
        sumY: 0,
        sumY2: 0,
        sumX: 0,
        minX: x,
        maxX: x,
        minY: r,
        maxY: r,
        rowMass: new Map(),
      };
      finalMap.set(root, reg);
    }
    reg.pixels.push(p);
    if (v > reg.peakVal) {
      reg.peakVal = v;
      reg.peakRow = r;
    }
    if (rv > reg.rawPeakVal) reg.rawPeakVal = rv;
    const wSq = v * v;
    reg.mass += v;
    reg.localMass += lv;
    reg.rawMass += rv;
    if (x >= icx0 && x <= icx1) {
      reg.coreLocalMass += lv;
      reg.coreRawMass += rv;
    }
    reg.sumY += r * wSq;
    reg.sumY2 += wSq;
    reg.sumX += x * v;
    if (x < reg.minX) reg.minX = x;
    if (x > reg.maxX) reg.maxX = x;
    if (r < reg.minY) reg.minY = r;
    if (r > reg.maxY) reg.maxY = r;
    reg.rowMass.set(r, (reg.rowMass.get(r) ?? 0) + v);
  }

  // 7. Measure true 2D spot geometry, apply physics-based artifact guards, & score confidence
  const minSpotArea = Math.max(4, Math.round(Math.max(2, w * 0.14) * Math.max(2, spanRows * 0.005)));
  const candidates: Array<{
    pos: number;
    rf: number;
    peakRow: number;
    peakVal: number;
    mass: number;
    extentStart: number;
    extentEnd: number;
    widthFrac: number;
    tailing: number;
    geomQuality: number;
    confidence: number;
  }> = [];

  // Precompute apples-to-apples per-row core peak (mean of top-3 pixels in lane core [cx0..cx1])
  // on rawField so origin-teardrop streak checks are immune to lane-width dilution and 1-2 px jitter.
  const rowCorePeakRaw = new Float32Array(h);
  for (let r = Math.max(0, originRow - 3); r <= frontRow; r++) {
    const off = r * w;
    let b1 = 0,
      b2 = 0,
      b3 = 0;
    const rb = rawBase[Math.max(originRow, Math.min(frontRow, r))];
    for (let x = cx0; x <= cx1; x++) {
      const val = Math.max(0, rawSm[off + x] - rb);
      if (val >= b1) {
        b3 = b2;
        b2 = b1;
        b1 = val;
      } else if (val >= b2) {
        b3 = b2;
        b2 = val;
      } else if (val > b3) {
        b3 = val;
      }
    }
    const topK = Math.min(3, cCount);
    rowCorePeakRaw[r] = topK === 1 ? b1 : topK === 2 ? (b1 + b2) * 0.5 : (b1 + b2 + b3) / 3;
  }

  let originPeakVal = 0;
  for (let r = Math.max(0, originRow - 2); r <= Math.min(startRow, originRow + 3); r++) {
    if (rowCorePeakRaw[r] > originPeakVal) originPeakVal = rowCorePeakRaw[r];
  }

  for (const reg of finalMap.values()) {
    const pxCount = reg.pixels.length;
    if (pxCount < minSpotArea) continue;
    if (reg.peakVal < peakThr) continue;

    // Sharp dust / pinhole / needle-splash artifact guard:
    // Real eluted TLC spots undergo lateral & longitudinal chromatographic diffusion, so their
    // 50%-height core spans >= 25-65% of lane width and >= 2.2-8% of migration span. Tiny sharp
    // dark specks / silica pinholes / splash droplets stay tightly pinpoint at 50% height even
    // when high contrast gives them wide low-level wings above fgThr.
    const halfCut = reg.peakVal * 0.50;
    let minX50 = w;
    let maxX50 = -1;
    let minY50 = h;
    let maxY50 = -1;
    let core50Count = 0;
    let sumY50 = 0;
    let sumY2_50 = 0;
    for (const p of reg.pixels) {
      const fv = F[p];
      if (fv >= halfCut) {
        const pr = Math.floor(p / w);
        const px = p - pr * w;
        core50Count++;
        const wSq = fv * fv;
        sumY50 += pr * wSq;
        sumY2_50 += wSq;
        if (px < minX50) minX50 = px;
        if (px > maxX50) maxX50 = px;
        if (pr < minY50) minY50 = pr;
        if (pr > maxY50) maxY50 = pr;
      }
    }
    if (core50Count > 0 && w >= 12 && spanRows >= 80) {
      const fwhmXFrac = (maxX50 - minX50 + 1) / w;
      const fwhmYFrac = (maxY50 - minY50 + 1) / spanRows;
      const coreArea50Frac = core50Count / (w * spanRows);
      // Reject pinpoint dust/pinhole specks (narrow in both X and Y at 50% height)
      if (fwhmXFrac < 0.22 && fwhmYFrac < 0.026) continue;
      // Reject compact high-contrast splash droplets lacking chromatographic diffusion
      if (fwhmXFrac < 0.26 && fwhmYFrac < 0.024 && coreArea50Frac < 0.0042 && reg.peakVal >= 35) {
        continue;
      }
    }

    // Square-intensity weighted vertical centroid over the 50%-height FWHM core so asymmetric
    // tails or shoulders never pull the reported Rf away from the visual spot apex.
    const cyRow =
      sumY2_50 > 0 ? sumY50 / sumY2_50 : reg.sumY2 > 0 ? reg.sumY / reg.sumY2 : reg.peakRow;
    const cxCol = reg.mass > 0 ? reg.sumX / reg.mass : (reg.minX + reg.maxX) * 0.5;
    const centroidXFrac = (cxCol + 0.5) / w;
    const widthFrac = (reg.maxX - reg.minX + 1) / w;

    // (a) Neighbor-lane spillover guard:
    //     Reject blobs centered strictly on the left/right lane border (bleeding from an adjacent lane)
    const borderSpan = Math.max(1, Math.round(w * 0.18));
    let borderPeak = 0;
    let corePeak = 0;
    for (const p of reg.pixels) {
      const r = Math.floor(p / w);
      const x = p - r * w;
      const v = F[p];
      if (x < borderSpan || x >= w - borderSpan) {
        if (v > borderPeak) borderPeak = v;
      } else {
        if (v > corePeak) corePeak = v;
      }
    }
    if (centroidXFrac < 0.16 || centroidXFrac > 0.84) continue;
    if ((centroidXFrac < 0.25 || centroidXFrac > 0.75) && borderPeak > Math.max(corePeak * 1.18, peakThr)) {
      continue;
    }

    const posOrig = Math.max(
      Math.round(opts.origin + 1),
      Math.min(Math.round(opts.front - 1), Math.round(cyRow * scaleY))
    );
    const rf = (posOrig - opts.origin) / origSpan;

    // (b) Horizontal solvent-front band / pencil line guard:
    //     Compare gutter-suppressed mass vs raw mass. A full-width horizontal band spans >= 80% of
    //     the lane width with very low center-vs-gutter contrast, EXCEPT strong coalesced interior
    //     compound spots (rf < 0.88 && rawPeakVal >= interiorBandCeil * 1.25). In the interior,
    //     also credit inner-core peaking (coreLocalRatio) so shared-Rf spots overlapping neighbor
    //     wings on both flanks pass while flat horizontal bands (coreLocalRatio ≈ 0) stay rejected.
    const localBandRatio = reg.rawMass > 1e-6 ? Math.min(1, reg.localMass / reg.rawMass) : 1;
    const coreLocalRatio = reg.coreRawMass > 1e-6 ? Math.min(1, reg.coreLocalMass / reg.coreRawMass) : localBandRatio;
    const effLocalRatio = rf >= 0.88 ? localBandRatio : Math.max(localBandRatio, coreLocalRatio);
    const isStrongCoalescedInterior = rf < 0.88 && reg.rawPeakVal >= interiorBandCeil * 1.25;
    if (!isStrongCoalescedInterior && widthFrac >= 0.80 && effLocalRatio < (rf >= 0.88 ? 0.36 : 0.11)) {
      continue;
    }
    // Reject solvent-front meniscus pressed directly against frontRow with no clean silica separation
    if (rf >= 0.935 && reg.maxY >= frontRow - 1 && localBandRatio < 0.48) {
      continue;
    }

    // (c) Consistent origin-dot teardrop / comet streak guard:
    //     For any low-Rf blob (Rf < 0.14) below a real origin dot, require a genuine return toward
    //     bright silica between originRow and peakRow. Continuous dark origin teardrops stay dark
    //     throughout the neck (neckMin / min(orig, spot) ~ 0.78–0.98 and > 25% of origin), whereas
    //     truly resolved low-Rf compounds show either a clean bright-silica gap (<= 25% of origin)
    //     or a deep >34% valley drop between the origin dot and the spot center.
    if (rf < 0.14 && originPeakVal >= Math.max(peakThr * 2.0, 20)) {
      const spotCorePeak = Math.max(rowCorePeakRaw[reg.peakRow], reg.rawPeakVal * 0.65);
      let neckMin = Infinity;
      for (let r = originRow; r <= reg.peakRow; r++) {
        if (rowCorePeakRaw[r] < neckMin) neckMin = rowCorePeakRaw[r];
      }
      const minAnchor = Math.max(1e-6, Math.min(originPeakVal, spotCorePeak));
      const neckVsAnchor = neckMin / minAnchor;
      const neckVsOrigin = neckMin / Math.max(1e-6, originPeakVal);

      // Reject continuous dark teardrop bridge attached to the origin dot (no genuine silica valley)
      if (neckVsOrigin > 0.25 && neckVsAnchor > 0.66) {
        continue;
      }
      // Reject weak monotonic origin-tail shoulder directly touching startRow without a real dip
      if (
        reg.minY <= startRow + 2 &&
        spotCorePeak - neckMin < Math.max(2.6 * effSigma, 0.16 * spotCorePeak)
      ) {
        continue;
      }
    }

    // Compute clean 10%-height vertical boundaries [extentStart, extentEnd] from segmented region rows
    let maxRowMass = 0;
    for (const rm of reg.rowMass.values()) {
      if (rm > maxRowMass) maxRowMass = rm;
    }
    const rowCut = maxRowMass * 0.10;
    let extMinRow = reg.peakRow;
    let extMaxRow = reg.peakRow;
    for (const [r, rm] of reg.rowMass.entries()) {
      if (rm >= rowCut) {
        if (r < extMinRow) extMinRow = r;
        if (r > extMaxRow) extMaxRow = r;
      }
    }
    const extentStart = Math.max(Math.round(opts.origin), Math.floor(extMinRow * scaleY));
    const extentEnd = Math.min(Math.round(opts.front), Math.ceil((extMaxRow + 1) * scaleY));

    // Chromatographic tailing asymmetry (upper half vs lower half around centroid)
    const upperHalf = Math.max(0.5, extMaxRow - cyRow);
    const lowerHalf = Math.max(0.5, cyRow - extMinRow);
    const tailing = +(Math.max(upperHalf / lowerHalf, lowerHalf / upperHalf)).toFixed(2);

    // Save raw geometry quality so confidence can be computed after post-watershed
    // monotonic-slope consolidation using effective prominence above any adjacent valley.
    const centerScore = Math.max(0, Math.min(1, 1 - Math.abs(centroidXFrac - 0.5) / 0.36));
    const localScore = isStrongCoalescedInterior
      ? 0.85
      : Math.max(0, Math.min(1, (effLocalRatio - 0.10) / 0.62));
    const sizeScore = Math.max(
      0,
      Math.min(1, (pxCount - minSpotArea * 0.6) / Math.max(6, minSpotArea * 2.5))
    );
    const geomQuality = 0.42 * centerScore + 0.34 * localScore + 0.24 * sizeScore;

    candidates.push({
      pos: posOrig,
      rf: +rf.toFixed(4),
      peakRow: reg.peakRow,
      peakVal: reg.peakVal,
      mass: reg.mass,
      extentStart,
      extentEnd,
      widthFrac: +Math.min(1, widthFrac).toFixed(2),
      tailing,
      geomQuality,
      confidence: 0.08,
    });
  }

  if (candidates.length === 0) return [];

  // Sort by Rf ascending and enforce minDistance (if explicitly requested by caller)
  candidates.sort((a, b) => a.pos - b.pos);
  const minDistPx = opts.minDistance ?? 0;
  const deduped: typeof candidates = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && c.pos - prev.pos < Math.max(minDistPx, Math.round(origSpan * 0.014))) {
      // Combine into stronger/merged spot
      const totalM = prev.mass + c.mass;
      prev.pos = Math.round((prev.pos * prev.mass + c.pos * c.mass) / Math.max(totalM, 1e-6));
      prev.rf = +((prev.pos - opts.origin) / origSpan).toFixed(4);
      if (c.peakVal > prev.peakVal) {
        prev.peakVal = c.peakVal;
        prev.peakRow = c.peakRow;
        prev.geomQuality = c.geomQuality;
      }
      prev.mass = totalM;
      prev.extentStart = Math.min(prev.extentStart, c.extentStart);
      prev.extentEnd = Math.max(prev.extentEnd, c.extentEnd);
      prev.widthFrac = Math.max(prev.widthFrac, c.widthFrac);
    } else {
      deduped.push({ ...c });
    }
  }

  // Post-watershed 1D monotonic-slope consolidation:
  // Even if two basins were disconnected in 2D F (e.g. a noisy lower tail below a bright UV366
  // streak where rv crosses interiorBandCeil), collapse any adjacent candidate sitting on the
  // same monotonic 1D slope (elevated valley on wideCore1d with no real dip on either profile)
  // into the stronger true peak without shifting its Rf or over-expanding its body extent.
  const minSlopeValleyAbs = Math.max(2.6 * effSigma, isDarkSpotCh ? 3.5 : 3.0);
  const minSlopeDropRatio = 0.06 + 0.06 * t;
  const elevatedFloor = Math.max(2.2 * effSigma, 4.0);
  let mergedAny = true;
  while (mergedAny && deduped.length > 1) {
    mergedAny = false;
    for (let i = 0; i < deduped.length - 1; i++) {
      const a = deduped[i];
      const b = deduped[i + 1];
      const v1d = measure1dValley(a.peakRow, b.peakRow);
      const rawVal = 'rawValley' in v1d ? v1d.rawValley : v1d.valley;
      const rawDrop = 'rawDrop1d' in v1d ? v1d.rawDrop1d : v1d.valleyDrop1d;
      const rawDropRatio = 'rawDropRatio1d' in v1d ? v1d.rawDropRatio1d : v1d.dropRatio1d;
      const isMonotonicTail =
        rawVal > elevatedFloor &&
        v1d.lower1d > 1e-4 &&
        (rawDrop < minSlopeValleyAbs || rawDropRatio < minSlopeDropRatio);
      if (isMonotonicTail) {
        // Keep the stronger peak's pos/rf/peakRow; only expand extent if loser is substantive
        // so weak absorbed lower tails do not stretch extentStart across half the plate.
        const keepA = a.peakVal >= b.peakVal;
        const winner = keepA ? a : b;
        const loser = keepA ? b : a;
        winner.mass += loser.mass;
        if (loser.peakVal >= winner.peakVal * 0.25) {
          winner.extentStart = Math.min(winner.extentStart, loser.extentStart);
          winner.extentEnd = Math.max(winner.extentEnd, loser.extentEnd);
        }
        winner.widthFrac = Math.max(winner.widthFrac, loser.widthFrac);
        deduped.splice(keepA ? i + 1 : i, 1);
        mergedAny = true;
        break;
      }
    }
  }

  // Quantitative spot confidence in [0.08..0.96] (multi-channel agreement can boost up to 0.99).
  // Use effective optical prominence above the higher adjacent valley (so a minor shoulder sitting
  // halfway up a tall peak's slope is scored by its real dip/prominence rather than its altitude
  // above blank silica), then modulate multiplicatively by geometry quality.
  const contrastFloor0 = isDarkSpotCh ? 6.5 : 4.5;
  const contrastHalf = isDarkSpotCh ? 38 : 30;
  for (let i = 0; i < deduped.length; i++) {
    const c = deduped[i];
    let adjValleyFloor = 0;
    let selfCore1d = 0;
    if (i > 0) {
      const vl = measure1dValley(deduped[i - 1].peakRow, c.peakRow);
      selfCore1d = Math.max(selfCore1d, vl.pHi);
      if (vl.valley > adjValleyFloor) adjValleyFloor = vl.valley;
    }
    if (i + 1 < deduped.length) {
      const vr = measure1dValley(c.peakRow, deduped[i + 1].peakRow);
      selfCore1d = Math.max(selfCore1d, vr.pLo);
      if (vr.valley > adjValleyFloor) adjValleyFloor = vr.valley;
    }

    let effPeakVal = c.peakVal;
    if (selfCore1d > 1e-4 && adjValleyFloor > 0.25 * selfCore1d) {
      const promRatio = Math.max(0, Math.min(1, (selfCore1d - adjValleyFloor) / selfCore1d));
      // Blend full peak with valley-prominence fraction so well-separated doublets keep strong
      // confidence while shallow shoulders on a parent's slope are honestly scored Low/Very Low.
      effPeakVal = Math.min(c.peakVal, c.peakVal * (0.15 + 0.85 * Math.sqrt(promRatio)));
    }

    const snr = effPeakVal / Math.max(effSigma, 1.0);
    const snrExcess = Math.max(0, snr - 3.0);
    const snrScore = Math.max(0, Math.min(1, (snrExcess / (snrExcess + 24)) * 1.12));
    const contrastExcess = Math.max(0, effPeakVal - contrastFloor0);
    const contrastScore = Math.max(
      0,
      Math.min(1, (contrastExcess / (contrastExcess + contrastHalf)) * 1.15)
    );
    const signalScore = 0.42 * snrScore + 0.58 * contrastScore;
    c.confidence = +Math.max(
      0.08,
      Math.min(0.96, signalScore * (0.48 + 0.52 * c.geomQuality))
    ).toFixed(2);
  }

  const maxPeak = Math.max(...deduped.map((c) => c.peakVal), 1e-6);
  const totalMass = Math.max(
    deduped.reduce((acc, c) => acc + c.mass, 0),
    1e-6
  );

  return deduped.map((c) => ({
    pos: c.pos,
    rf: c.rf,
    strength: +Math.min(1, c.peakVal / maxPeak).toFixed(3),
    areaPct: Math.max(1, Math.min(100, Math.round((c.mass / totalMass) * 100))),
    confidence: c.confidence,
    extentStart: c.extentStart,
    extentEnd: c.extentEnd,
    widthFrac: c.widthFrac,
    tailing: c.tailing,
    source: 'auto' as const,
    detector: '2d' as const,
  }));
}
