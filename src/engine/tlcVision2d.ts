// Robowski Studio - 2D Physics-Driven TLC Vision Engine
//
// Upgrades 1D single-channel heuristics with full-RGB color perception, 2D lane-vs-gutter lateral
// verification (eliminating horizontal illumination bands and adjacent-lane spillover), 2D smooth
// curved solvent-front seam tracking (handling smiling/tilted fronts across 27 lanes), shared-reagent
// cross-lane coherence, and 1-click color-signature plate-wide spot matching.
import type { Lane2dMetrics, TlcSpot } from '../types';

export type VisionChannelKey = 'UV254' | 'UV366' | 'White';

export interface LaneStripAnalysisResult {
  profile: number[];
  metrics: Lane2dMetrics;
}

function medianOfSorted(arr: Float64Array, len: number): number {
  if (len <= 0) return 0;
  const view = arr.subarray(0, len);
  view.sort();
  const mid = len >> 1;
  return len % 2 === 1 ? view[mid] : 0.5 * (view[mid - 1] + view[mid]);
}

function quantileOfArray(vals: number[], q: number): number {
  if (!vals.length) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

function rgbLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Achromatic-removed chromatic distance between two RGB colors.
 * Pure grayscale brightness changes (like wet-vs-dry silica) return 0; colored spots on white
 * or yellow spots on purple KMnO4 return strong positive values.
 */
export function rgbChromaDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const l1 = rgbLuma(r1, g1, b1);
  const l2 = rgbLuma(r2, g2, b2);
  const dr = r1 - l1 - (r2 - l2);
  const dg = g1 - l1 - (g2 - l2);
  const db = b1 - l1 - (b2 - l2);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Full-RGB Euclidean color distance scaled to match grayscale intensity units (0..255).
 */
export function rgbColorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/**
 * Blank-Silica Flat-Field Illumination & Glare Calibration.
 * - UV254 / White: multiplicative flat-field division (removes uneven UV lamps, lens vignetting,
 *   and fixed camera/glass shading while preserving spot quenching contrast everywhere on silica).
 * - UV366: additive excess stray-light subtraction (removes UV366 chamber-wall glare without
 *   clipping or attenuating genuine fluorescent spots).
 */
export function applyFlatFieldCorrection(
  sampleRgba: ArrayLike<number>,
  blankRgba: ArrayLike<number>,
  width: number,
  length: number,
  channel: VisionChannelKey
): Uint8ClampedArray {
  const W = Math.max(1, Math.round(width));
  const L = Math.max(1, Math.round(length));
  const total = W * L * 4;
  const out = new Uint8ClampedArray(total);
  if (blankRgba.length < total || sampleRgba.length < total) {
    for (let i = 0; i < Math.min(total, sampleRgba.length); i++) out[i] = sampleRgba[i] ?? 0;
    return out;
  }

  // Sample interior (12%..88%) of the blank plate to estimate reference silica illumination
  const yLo = Math.max(0, Math.floor(L * 0.12));
  const yHi = Math.min(L - 1, Math.ceil(L * 0.88));
  const yStep = Math.max(1, Math.floor((yHi - yLo + 1) / 48));
  const xStep = Math.max(1, Math.floor(W / 12));
  const rVals: number[] = [];
  const gVals: number[] = [];
  const bVals: number[] = [];
  for (let y = yLo; y <= yHi; y += yStep) {
    for (let x = 0; x < W; x += xStep) {
      const off = (y * W + x) * 4;
      const br = blankRgba[off] ?? 0;
      const bg = blankRgba[off + 1] ?? 0;
      const bb = blankRgba[off + 2] ?? 0;
      if (channel !== 'UV366' && rgbLuma(br, bg, bb) < 38) continue;
      rVals.push(br);
      gVals.push(bg);
      bVals.push(bb);
    }
  }

  if (rVals.length < 4) {
    for (let i = 0; i < total; i++) out[i] = sampleRgba[i] ?? 0;
    return out;
  }

  const refQ = channel === 'UV366' ? 0.22 : 0.70;
  const refR = quantileOfArray(rVals, refQ);
  const refG = quantileOfArray(gVals, refQ);
  const refB = quantileOfArray(bVals, refQ);

  if (channel === 'UV366') {
    for (let off = 0; off < total; off += 4) {
      const exR = Math.max(0, (blankRgba[off] ?? 0) - refR);
      const exG = Math.max(0, (blankRgba[off + 1] ?? 0) - refG);
      const exB = Math.max(0, (blankRgba[off + 2] ?? 0) - refB);
      out[off] = Math.max(0, Math.min(255, Math.round((sampleRgba[off] ?? 0) - exR)));
      out[off + 1] = Math.max(0, Math.min(255, Math.round((sampleRgba[off + 1] ?? 0) - exG)));
      out[off + 2] = Math.max(0, Math.min(255, Math.round((sampleRgba[off + 2] ?? 0) - exB)));
      out[off + 3] = sampleRgba[off + 3] ?? 255;
    }
    return out;
  }

  // UV254 / White: smooth multiplicative flat-fielding (leave off-plate dark surround untouched)
  const clampGain = (g: number) => Math.max(0.5, Math.min(2.2, g));
  for (let off = 0; off < total; off += 4) {
    const br = blankRgba[off] ?? 0;
    const bg = blankRgba[off + 1] ?? 0;
    const bb = blankRgba[off + 2] ?? 0;
    const sr = sampleRgba[off] ?? 0;
    const sg = sampleRgba[off + 1] ?? 0;
    const sb = sampleRgba[off + 2] ?? 0;
    if (rgbLuma(br, bg, bb) < 35) {
      out[off] = sr;
      out[off + 1] = sg;
      out[off + 2] = sb;
      out[off + 3] = sampleRgba[off + 3] ?? 255;
      continue;
    }
    const gR = refR > 15 ? clampGain(refR / Math.max(25, br)) : 1;
    const gG = refG > 15 ? clampGain(refG / Math.max(25, bg)) : 1;
    const gB = refB > 15 ? clampGain(refB / Math.max(25, bb)) : 1;
    out[off] = Math.max(0, Math.min(255, Math.round(sr * gR)));
    out[off + 1] = Math.max(0, Math.min(255, Math.round(sg * gG)));
    out[off + 2] = Math.max(0, Math.min(255, Math.round(sb * gB)));
    out[off + 3] = sampleRgba[off + 3] ?? 255;
  }
  return out;
}

/**
 * Extracts a full-RGB 1D chromatographic profile AND 2D lateral strip metrics from a straightened
 * W x L RGBA lane image (row 0 = top / front end, row L-1 = bottom / origin end).
 *
 * - UV254: primary F254 green quenching + full-RGB lateral contrast.
 * - UV366: full-spectrum fluorescence max(R, G, B) so blue, cyan, green, yellow, orange, and red
 *   fluorophores are all captured at full SNR (not just blue).
 * - White: luminance + achromatic-removed chroma distance so yellow, brown, blue/green (CAM/PMA),
 *   pink (ninhydrin), and yellow-on-purple (KMnO4) spots all produce strong peaks while preserving
 *   wet-vs-dry brightness steps for front detection.
 */
export function analyzeLaneStripRgb(
  rgba: ArrayLike<number>,
  width: number,
  length: number,
  channel: VisionChannelKey,
  coreFraction: number = 0.35,
  isGutter: boolean = false
): LaneStripAnalysisResult {
  const W = Math.max(1, Math.round(width));
  const L = Math.max(1, Math.round(length));

  const coreR = new Float32Array(L);
  const coreG = new Float32Array(L);
  const coreB = new Float32Array(L);
  const leftR = new Float32Array(L);
  const leftG = new Float32Array(L);
  const leftB = new Float32Array(L);
  const rightR = new Float32Array(L);
  const rightG = new Float32Array(L);
  const rightB = new Float32Array(L);

  const center = (W - 1) / 2;
  const halfSpan = Math.max(1, (W * coreFraction) / 2);
  const cx0 = Math.max(0, Math.floor(center - halfSpan));
  const cx1 = Math.min(W - 1, Math.ceil(center + halfSpan));

  // Precompute cosine weights for the center core
  const coreWeights = new Float32Array(cx1 - cx0 + 1);
  let coreWSum = 0;
  for (let x = cx0; x <= cx1; x++) {
    const dist = Math.abs(x - center);
    const w = Math.cos((dist / halfSpan) * (Math.PI / 2));
    coreWeights[x - cx0] = w;
    coreWSum += w;
  }
  if (coreWSum <= 0) coreWSum = 1;

  // Outer left/right gutter margins inside the lane strip (~18% on each edge, at least 2px when W >= 8)
  const flankW = W >= 8 ? Math.max(2, Math.round(W * 0.18)) : 0;
  const lx1 = Math.max(0, flankW - 1);
  const rx0 = Math.min(W - 1, W - flankW);

  for (let y = 0; y < L; y++) {
    const idx = L - 1 - y; // chromatographic coordinate: 0 = bottom, L-1 = top
    const rowOff = y * W * 4;

    let sr = 0,
      sg = 0,
      sb = 0;
    for (let x = cx0; x <= cx1; x++) {
      const p = rowOff + x * 4;
      const w = coreWeights[x - cx0];
      sr += (rgba[p] ?? 0) * w;
      sg += (rgba[p + 1] ?? 0) * w;
      sb += (rgba[p + 2] ?? 0) * w;
    }
    coreR[idx] = sr / coreWSum;
    coreG[idx] = sg / coreWSum;
    coreB[idx] = sb / coreWSum;

    if (flankW > 0) {
      let lr = 0,
        lg = 0,
        lb = 0;
      const ln = lx1 + 1;
      for (let x = 0; x <= lx1; x++) {
        const p = rowOff + x * 4;
        lr += rgba[p] ?? 0;
        lg += rgba[p + 1] ?? 0;
        lb += rgba[p + 2] ?? 0;
      }
      leftR[idx] = lr / ln;
      leftG[idx] = lg / ln;
      leftB[idx] = lb / ln;

      let rr = 0,
        rg = 0,
        rb = 0;
      const rn = W - rx0;
      for (let x = rx0; x < W; x++) {
        const p = rowOff + x * 4;
        rr += rgba[p] ?? 0;
        rg += rgba[p + 1] ?? 0;
        rb += rgba[p + 2] ?? 0;
      }
      rightR[idx] = rr / rn;
      rightG[idx] = rg / rn;
      rightB[idx] = rb / rn;
    } else {
      leftR[idx] = rightR[idx] = coreR[idx];
      leftG[idx] = rightG[idx] = coreG[idx];
      leftB[idx] = rightB[idx] = coreB[idx];
    }
  }

  // Estimate clean silica RGB background from interior (12%..88%) flank pixels
  const sLo = Math.max(0, Math.floor(L * 0.12));
  const sHi = Math.min(L - 1, Math.ceil(L * 0.88));
  const sampleStep = Math.max(1, Math.floor((sHi - sLo + 1) / 80));
  const rSamples: number[] = [];
  const gSamples: number[] = [];
  const bSamples: number[] = [];
  const leftScalarSamples: number[] = [];
  const coreScalarSamples: number[] = [];
  const rightScalarSamples: number[] = [];
  const rawBrightness = (r: number, g: number, b: number) =>
    channel === 'UV254' ? g : rgbLuma(r, g, b);

  for (let i = sLo; i <= sHi; i += sampleStep) {
    coreScalarSamples.push(rawBrightness(coreR[i], coreG[i], coreB[i]));
    if (flankW > 0) {
      rSamples.push(leftR[i], rightR[i]);
      gSamples.push(leftG[i], rightG[i]);
      bSamples.push(leftB[i], rightB[i]);
      leftScalarSamples.push(rawBrightness(leftR[i], leftG[i], leftB[i]));
      rightScalarSamples.push(rawBrightness(rightR[i], rightG[i], rightB[i]));
    } else {
      rSamples.push(coreR[i]);
      gSamples.push(coreG[i]);
      bSamples.push(coreB[i]);
    }
  }

  // UV366 clean silica is dark (low quantile); UV254/White clean silica is bright/mode (median-upper quantile)
  const bgQ = channel === 'UV366' ? 0.25 : channel === 'UV254' ? 0.72 : 0.55;
  const bgR = quantileOfArray(rSamples, bgQ);
  const bgG = quantileOfArray(gSamples, bgQ);
  const bgB = quantileOfArray(bSamples, bgQ);
  const bgLuma = rgbLuma(bgR, bgG, bgB);

  // Detect lanes sitting off the physical silica glass (pitch-black surround) or straddling the vertical glass cut edge.
  // Only applies to bright-silica channels (UV254 / White); UV366 silica is naturally dark.
  let offPlate = false;
  let borderStraddle = false;
  if (channel === 'UV254' || channel === 'White') {
    const bgScalar = channel === 'UV254' ? bgG : bgLuma;
    const medCore = quantileOfArray(coreScalarSamples, 0.70);
    if (medCore < 42 && bgScalar < 45) {
      offPlate = true;
    } else if (flankW > 0 && leftScalarSamples.length >= 4) {
      const medLeft = quantileOfArray(leftScalarSamples, 0.55);
      const medRight = quantileOfArray(rightScalarSamples, 0.55);
      if (
        Math.min(medLeft, medRight) < 42 &&
        Math.max(medLeft, medRight) > 85 &&
        Math.abs(medLeft - medRight) > 55
      ) {
        borderStraddle = true;
      }
    }
  }

  const profile = new Array<number>(L);
  const lateralExcess = new Float32Array(L);
  const edgeRatio = new Float32Array(L);
  const coreRgb = new Float32Array(L * 3);

  const scalarFor = (r: number, g: number, b: number): number => {
    if (channel === 'UV254') return g;
    if (channel === 'UV366') return Math.max(r, g, b);
    // White: for bare gutters preserve pure luminance so wet-vs-dry brightness steps stay monotonic;
    // for reaction lanes combine darkening + chromatic distance so ANY stain color (blue, green,
    // pink, yellow-on-purple KMnO4, brown) forms a strong dip below bgLuma.
    const luma = rgbLuma(r, g, b);
    if (isGutter) return luma;
    const chroma = rgbChromaDistance(r, g, b, bgR, bgG, bgB);
    const signedDrop = bgLuma - luma;
    const effectiveDrop = Math.max(signedDrop, chroma * 0.72);
    return Math.max(0, Math.min(255, bgLuma - effectiveDrop));
  };

  // Directional deviation from clean silica background (positive = spot-like signal)
  const devFromBg = (r: number, g: number, b: number): number => {
    if (channel === 'UV254') {
      return Math.max(0, bgG - g);
    }
    if (channel === 'UV366') {
      const dr = Math.max(0, r - bgR);
      const dg = Math.max(0, g - bgG);
      const db = Math.max(0, b - bgB);
      return Math.max(dr, dg, db, Math.sqrt((dr * dr + dg * dg + db * db) / 2));
    }
    // White: both luminance drop AND full-RGB chromatic distance count as spot deviation
    const lumaDrop = Math.max(0, bgLuma - rgbLuma(r, g, b));
    const chroma = rgbChromaDistance(r, g, b, bgR, bgG, bgB) * 0.72;
    return Math.max(lumaDrop, chroma);
  };

  // Direct center-vs-flank contrast at the EXACT same height y (cancels horizontal bands & gradients)
  const centerVsFlankContrast = (
    cr: number,
    cg: number,
    cb: number,
    fr: number,
    fg: number,
    fb: number
  ): number => {
    if (channel === 'UV254') {
      return fg - cg; // positive when center is darker than flank
    }
    if (channel === 'UV366') {
      const dr = cr - fr;
      const dg = cg - fg;
      const db = cb - fb;
      const posMax = Math.max(dr, dg, db);
      return posMax;
    }
    // White: signed luminance darkening OR chromatic contrast between center and flank at height y
    const lDrop = rgbLuma(fr, fg, fb) - rgbLuma(cr, cg, cb);
    const cDist = rgbChromaDistance(cr, cg, cb, fr, fg, fb) * 0.72;
    const fDist = rgbColorDistance(cr, cg, cb, fr, fg, fb);
    return Math.max(lDrop, Math.min(cDist, fDist * 1.1));
  };

  for (let i = 0; i < L; i++) {
    const cr = coreR[i];
    const cg = coreG[i];
    const cb = coreB[i];
    coreRgb[i * 3] = cr;
    coreRgb[i * 3 + 1] = cg;
    coreRgb[i * 3 + 2] = cb;

    profile[i] = scalarFor(cr, cg, cb);

    if (flankW > 0) {
      const cDev = devFromBg(cr, cg, cb);
      const lDev = devFromBg(leftR[i], leftG[i], leftB[i]);
      const rDev = devFromBg(rightR[i], rightG[i], rightB[i]);

      // Compare center against the cleaner flank so a co-migrating spot in ONE neighbor never masks a real spot,
      // while a horizontal illumination/wetness band (equal in BOTH flanks and center) cancels to ~0.
      const cleanIsLeft = lDev <= rDev;
      const cleanExcess = cleanIsLeft
        ? centerVsFlankContrast(cr, cg, cb, leftR[i], leftG[i], leftB[i])
        : centerVsFlankContrast(cr, cg, cb, rightR[i], rightG[i], rightB[i]);
      const dirtyExcess = cleanIsLeft
        ? centerVsFlankContrast(cr, cg, cb, rightR[i], rightG[i], rightB[i])
        : centerVsFlankContrast(cr, cg, cb, leftR[i], leftG[i], leftB[i]);

      // Blend clean flank (0.7) + stronger flank (0.3):
      // - Real isolated spot: both high -> high lateralExcess
      // - Real spot beside identical neighbor: clean flank high, saddle flank positive -> still high lateralExcess
      // - Neighbor spillover on empty lane: dirtyExcess strongly negative, edgeRatio >> 1
      // - Horizontal band/meniscus: both ~0 -> lateralExcess ~0
      lateralExcess[i] = 0.7 * cleanExcess + 0.3 * dirtyExcess;

      const maxEdgeDev = Math.max(lDev, rDev);
      edgeRatio[i] = maxEdgeDev > 2.5 ? maxEdgeDev / Math.max(cDev, 0.5) : 0;
    } else {
      lateralExcess[i] = 999; // Narrow synthetic strips without flanks skip lateral rejection
      edgeRatio[i] = 0;
    }
  }

  return {
    profile,
    metrics: {
      lateralExcess,
      edgeRatio,
      coreRgb,
      bgRgb: [bgR, bgG, bgB],
      offPlate,
      borderStraddle,
    },
  };
}

/**
 * Returns true if a 1D chromatographic profile sits on the physical silica plate.
 * In UV254 / White (sign < 0), off-plate lanes on pitch-black cabinet background stay < 42.
 * In UV366 (sign > 0), clean silica is naturally dark so all lanes are treated as on-plate.
 */
export function isProfileOnPlate(profile: number[], sign: number): boolean {
  if (!profile || profile.length < 10) return false;
  if (sign >= 0) return true;
  const lo = Math.floor(profile.length * 0.15);
  const hi = Math.ceil(profile.length * 0.85);
  if (hi <= lo) return true;
  const step = Math.max(1, Math.floor((hi - lo) / 40));
  const vals: number[] = [];
  for (let i = lo; i < hi; i += step) vals.push(profile[i]);
  return quantileOfArray(vals, 0.65) >= 42;
}

/**
 * Detects the physical top edge of the bright silica glass plate when lane boxes extend upward
 * into a pitch-black off-plate surround (sign < 0). Returns `minLen - 1` if no black top void exists.
 */
export function detectGlassTopEdge(profiles: number[][], sign: number): number {
  if (!profiles.length) return 0;
  const minLen = Math.min(...profiles.map((p) => p.length));
  if (minLen < 20 || sign >= 0) return Math.max(0, minLen - 1);

  const onPlate = profiles.filter((p) => isProfileOnPlate(p, sign));
  if (!onPlate.length) return Math.max(0, minLen - 1);

  const colBuf = new Float64Array(onPlate.length);
  const medAt = (i: number): number => {
    for (let j = 0; j < onPlate.length; j++) colBuf[j] = onPlate[j][i];
    return medianOfSorted(colBuf, onPlate.length);
  };

  // Only trigger if the very top rows of the lane boxes sit in a dark off-plate void (< 45)
  let darkRun = 0;
  let edge = minLen - 1;
  const minFloor = Math.floor(minLen * 0.45);
  for (let i = minLen - 1; i >= minFloor; i--) {
    if (medAt(i) < 45) {
      darkRun++;
      edge = i;
    } else {
      break;
    }
  }
  if (darkRun < 4) return minLen - 1;

  // Confirm genuine bright silica (>= 80) just below the glass edge
  const checkLo = Math.max(minFloor, edge - Math.max(12, Math.round(minLen * 0.08)));
  const silicaVals: number[] = [];
  for (let i = checkLo; i < edge; i += 2) silicaVals.push(medAt(i));
  if (silicaVals.length >= 3 && quantileOfArray(silicaVals, 0.70) >= 80) {
    return edge;
  }
  return minLen - 1;
}

// ---- 2D Curved Solvent Front Seam Tracker ---------------------------------------------------------

export interface CurvedFrontChannelInput {
  /** Profiles ordered left-to-right across the half-plate (gutters or lanes) */
  profiles: number[][];
  /** -1 for UV254/White (dark line / bright dry top), +1 for UV366 */
  sign: number;
}

export interface CurvedFrontSeamResult {
  /** Median front position across the half-plate (0 if not detected) */
  medianPos: number;
  /** Per-lane curved front positions keyed by laneId */
  byLane: Record<number, number>;
  /** Overall front confidence score (comparable to SNR units) */
  score: number;
  /** Whether a meaningful tilt or bow was fitted (vs flat line) */
  isCurved: boolean;
}

function movingAvgLocal(a: number[], w: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  const h = w >> 1;
  let s = 0,
    cnt = 0,
    lo = 0,
    hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + h)) {
      hi++;
      s += a[hi];
      cnt++;
    }
    while (lo < i - h) {
      s -= a[lo];
      lo++;
      cnt--;
    }
    out[i] = cnt > 0 ? s / cnt : a[i];
  }
  return out;
}

function winMeanF(a: Float64Array, s: number, e: number): number {
  const a0 = Math.max(0, s);
  const a1 = Math.min(a.length - 1, e);
  if (a1 < a0) return 0;
  let sum = 0;
  for (let i = a0; i <= a1; i++) sum += a[i];
  return sum / (a1 - a0 + 1);
}

function winMedF(a: Float64Array, s: number, e: number, buf: Float64Array): number {
  const a0 = Math.max(0, s);
  const a1 = Math.min(a.length - 1, e);
  if (a1 < a0) return 0;
  const span = a1 - a0 + 1;
  const step = span <= buf.length ? 1 : Math.ceil(span / buf.length);
  let k = 0;
  for (let i = a0; i <= a1 && k < buf.length; i += step) buf[k++] = a[i];
  return medianOfSorted(buf, k);
}

/**
 * Computes per-pixel front evidence (in SNR units) along a single 1D lane/gutter profile
 * across [lo..hi], combining thin meniscus ridge + persistent wet-vs-dry background step.
 */
function computeFrontEvidenceStrip(
  profile: number[],
  sign: number,
  lo: number,
  hi: number,
  effEnd?: number
): { snr: Float32Array; hasStep: Uint8Array } {
  const n = profile.length;
  const topLim = effEnd != null ? Math.min(n - 1, effEnd) : n - 1;
  const count = hi - lo + 1;
  const snr = new Float32Array(count);
  const hasStep = new Uint8Array(count);
  if (n < 20 || count <= 4) return { snr, hasStep };

  const s = movingAvgLocal(profile, 3);
  const rCore = Math.max(0, Math.round(n * 0.0015));
  const tIn = Math.max(2, Math.round(n * 0.003));
  const tOut = tIn + Math.max(3, Math.round(n * 0.007));
  const mIn = tOut + 1;
  const mOut = mIn + Math.max(8, Math.round(n * 0.025));

  const bgNear = Math.max(3, Math.round(n * 0.008));
  const bgMid = Math.max(24, Math.round(n * 0.14));
  const bgFarLo = Math.max(36, Math.round(n * 0.22));
  const eWin = Math.max(2, Math.round(n * 0.006));
  const dirSign = -Math.sign(sign || 1);

  const d2Arr = new Float64Array(Math.max(1, count - 2));
  let d2Cnt = 0;
  for (let i = lo + 1; i <= hi - 1; i++) {
    d2Arr[d2Cnt++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  const sigmaS = Math.max(0.65, 1.4826 * medianOfSorted(d2Arr, d2Cnt) * 0.866);

  const buf = new Float64Array(36);
  const feats = new Float64Array(count);
  const ranks = new Float64Array(count);

  for (let i = lo; i <= hi; i++) {
    const c = winMeanF(s, i - rCore, Math.min(topLim, i + rCore));
    const mLT = winMeanF(s, i - tOut, i - tIn);
    const mRT = winMeanF(s, Math.min(topLim, i + tIn), Math.min(topLim, i + tOut));
    const dL = sign * (c - mLT);
    const dR = sign * (c - mRT);

    let ridgeAmp = 0;
    if (dL > 0.9 && dR > 0.9 && Math.min(dL, dR) >= 0.28 * Math.max(dL, dR)) {
      const tightRidge = 0.7 * Math.min(dL, dR) + 0.3 * 0.5 * (dL + dR);
      const mLM = winMedF(s, i - mOut, i - mIn, buf);
      const mRM = winMedF(s, Math.min(topLim, i + mIn), Math.min(topLim, i + mOut), buf);
      const dLM = sign * (c - mLM);
      const dRM = sign * (c - mRM);
      if (dLM > 0.9 && dRM > 0.9 && Math.min(dLM, dRM) >= 0.24 * Math.max(dLM, dRM)) {
        const medRidge = 0.7 * Math.min(dLM, dRM) + 0.3 * 0.5 * (dLM + dRM);
        const sharpness = tightRidge / Math.max(tightRidge, medRidge, 1e-6);
        ridgeAmp = tightRidge * (sharpness * sharpness);
      }
    }

    let stepAmp = 0;
    if (i + bgNear <= topLim && i - bgNear >= 0) {
      const medAfter = winMedF(s, i + bgNear, Math.min(topLim, i + bgMid), buf);
      const medBefore = winMedF(s, Math.max(0, i - bgMid), i - bgNear, buf);
      const farBefore =
        i - Math.round(n * 0.06) >= 3
          ? winMedF(s, Math.max(0, i - bgFarLo), i - Math.max(bgNear + 2, Math.round(n * 0.06)), buf)
          : medBefore;
      const edgeL = winMeanF(s, Math.max(0, i - rCore - eWin), Math.max(0, i - rCore - 1));
      const edgeR = winMeanF(s, Math.min(topLim, i + rCore + 1), Math.min(topLim, i + rCore + eWin));
      const macroDelta = medAfter - medBefore;
      const farDelta = medAfter - farBefore;
      const localDelta = edgeR - edgeL;
      if (
        macroDelta * dirSign > 0 &&
        farDelta * dirSign > 0 &&
        localDelta * dirSign > 0 &&
        Math.abs(macroDelta) >= 0.38 * Math.abs(farDelta)
      ) {
        stepAmp = Math.min(Math.abs(macroDelta), Math.abs(farDelta), Math.abs(localDelta));
      }
    }

    const feat = ridgeAmp + 0.65 * stepAmp;
    feats[i - lo] = feat;
    const stepBacked = stepAmp >= Math.max(1.0, 1.3 * sigmaS);
    if (stepBacked) hasStep[i - lo] = 1;
    // Preserve pencil-line suppression: step-backed fronts outrank ridge-only marks
    ranks[i - lo] = stepBacked ? feat : feat * 0.75;
  }

  const fSort = new Float64Array(feats);
  const medF = medianOfSorted(fSort, count);
  for (let j = 0; j < count; j++) fSort[j] = Math.abs(feats[j] - medF);
  const madF = 1.4826 * medianOfSorted(fSort, count);
  const noiseFloor = Math.max(sigmaS, madF, 0.75);

  for (let j = 0; j < count; j++) {
    // Cap individual column SNR at 14 so one extreme dust/ink artifact cannot bend the whole plate seam
    snr[j] = Math.min(14, ranks[j] / noiseFloor);
  }
  return { snr, hasStep };
}

function fitRobustFrontCurve(
  points: Array<{ u: number; y: number; w: number }>,
  laneLen: number
): { c0: number; c1: number; c2: number; isCurved: boolean } | null {
  if (points.length < 4) return null;

  // Flat median baseline
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  const flatY = ys[ys.length >> 1];
  const flatRes = points.map((p) => Math.abs(p.y - flatY)).sort((a, b) => a - b)[points.length >> 1];

  // Robust linear (Theil-Sen median slope)
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const du = points[j].u - points[i].u;
      if (Math.abs(du) > 0.25) slopes.push((points[j].y - points[i].y) / du);
    }
  }
  let linC0 = flatY;
  let linC1 = 0;
  let linRes = flatRes;
  if (slopes.length > 0) {
    slopes.sort((a, b) => a - b);
    linC1 = slopes[slopes.length >> 1];
    const icpts = points.map((p) => p.y - linC1 * p.u).sort((a, b) => a - b);
    linC0 = icpts[icpts.length >> 1];
    linRes = points.map((p) => Math.abs(p.y - (linC0 + linC1 * p.u))).sort((a, b) => a - b)[points.length >> 1];
  }

  // IRLS quadratic y(u) = c0 + c1*u + c2*u^2 (handles classic smiling/frowning chamber edge bow)
  let c0 = linC0;
  let c1 = linC1;
  let c2 = 0;
  let quadOk = points.length >= 8;
  if (quadOk) {
    const cutoff = Math.max(8, laneLen * 0.018);
    for (let iter = 0; iter < 5; iter++) {
      let s00 = 0,
        s01 = 0,
        s02 = 0,
        s11 = 0,
        s12 = 0,
        s22 = 0;
      let r0 = 0,
        r1 = 0,
        r2 = 0;
      for (const p of points) {
        const u = p.u;
        const u2 = u * u;
        const err = Math.abs(p.y - (c0 + c1 * u + c2 * u2));
        let w = p.w;
        if (iter > 0) {
          if (err >= cutoff) w = 0;
          else {
            const t = err / cutoff;
            w *= (1 - t * t) ** 2;
          }
        }
        if (w <= 0) continue;
        s00 += w;
        s01 += w * u;
        s02 += w * u2;
        s11 += w * u2;
        s12 += w * u * u2;
        s22 += w * u2 * u2;
        r0 += w * p.y;
        r1 += w * u * p.y;
        r2 += w * u2 * p.y;
      }
      // Gentle shrinkage on c2 so flat/linear fronts never wiggle
      s22 += 0.35;
      const M = [
        [s00, s01, s02, r0],
        [s01, s11, s12, r1],
        [s02, s12, s22, r2],
      ];
      let singular = false;
      for (let col = 0; col < 3; col++) {
        let piv = col;
        for (let row = col + 1; row < 3; row++) {
          if (Math.abs(M[row][col]) > Math.abs(M[piv][col])) piv = row;
        }
        if (Math.abs(M[piv][col]) < 1e-9) {
          singular = true;
          break;
        }
        if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
        const div = M[col][col];
        for (let j = col; j < 4; j++) M[col][j] /= div;
        for (let row = 0; row < 3; row++) {
          if (row === col) continue;
          const fac = M[row][col];
          for (let j = col; j < 4; j++) M[row][j] -= fac * M[col][j];
        }
      }
      if (singular) {
        quadOk = false;
        break;
      }
      c0 = M[0][3];
      c1 = M[1][3];
      c2 = M[2][3];
    }
  }

  const maxAllowedShift = Math.max(18, laneLen * 0.10);
  const quadRes = quadOk
    ? points.map((p) => Math.abs(p.y - (c0 + c1 * p.u + c2 * p.u * p.u))).sort((a, b) => a - b)[points.length >> 1]
    : Infinity;

  const minCurveAmp = Math.max(4, laneLen * 0.005);
  // Accept quadratic only when it genuinely reduces residuals AND has physically plausible bow
  if (
    quadOk &&
    Math.abs(c2) >= minCurveAmp &&
    Math.abs(c2) <= maxAllowedShift &&
    Math.abs(c1) <= maxAllowedShift &&
    quadRes < 0.78 * linRes &&
    linRes - quadRes >= Math.max(1.2, laneLen * 0.002)
  ) {
    return { c0, c1, c2, isCurved: true };
  }
  // Accept linear tilt when meaningfully better than flat
  if (
    Math.abs(linC1) >= minCurveAmp &&
    Math.abs(linC1) <= maxAllowedShift &&
    linRes < 0.80 * flatRes &&
    flatRes - linRes >= Math.max(1.2, laneLen * 0.002)
  ) {
    return { c0: linC0, c1: linC1, c2: 0, isCurved: true };
  }
  return { c0: flatY, c1: 0, c2: 0, isCurved: false };
}

/**
 * 2D Curved Solvent-Front Seam Tracker:
 * Tracks a single continuous smooth curve y_front(x) across all columns (gutters or lanes)
 * simultaneously via dynamic programming, optionally fusing evidence across multiple loaded
 * channels (UV254 + UV366 + White). Handles curved ("smiling"/"frowning") and tilted fronts
 * that smear out under 1D flat-line median aggregation.
 */
export function detectCurvedFrontSeam(
  channels: CurvedFrontChannelInput[],
  laneIds: number[],
  laneLen: number
): CurvedFrontSeamResult {
  const empty: CurvedFrontSeamResult = { medianPos: 0, byLane: {}, score: 0, isCurved: false };
  if (!channels.length || laneIds.length < 4 || laneLen < 20) return empty;

  const numCols = Math.min(...channels.map((c) => c.profiles.length));
  if (numCols < 4) return empty;

  const minLen = Math.min(
    laneLen,
    ...channels.flatMap((c) => c.profiles.slice(0, numCols).map((p) => p.length))
  );
  if (minLen < 20) return empty;

  const lo = Math.max(4, Math.floor(minLen * 0.50));
  let hi = Math.min(minLen - 4, Math.floor(minLen * 0.96));

  // Filter out off-plate pitch-black columns so unaligned outer lanes (e.g. D5/E5/D9/E9/F9)
  // never poison left/right third voting or pull the front line into the black surround.
  const activeCols: number[] = [];
  for (let col = 0; col < numCols; col++) {
    if (channels.some((ch) => isProfileOnPlate(ch.profiles[col], ch.sign))) {
      activeCols.push(col);
    }
  }
  if (activeCols.length < 4) return empty;

  // Clamp upper search ceiling strictly inside the physical top edge of the silica glass
  let effEnd = minLen - 1;
  for (const ch of channels) {
    if (ch.sign < 0) {
      const glassEdge = detectGlassTopEdge(
        activeCols.map((c) => ch.profiles[c]),
        ch.sign
      );
      if (glassEdge < minLen - 4) {
        hi = Math.min(hi, glassEdge - 6);
        effEnd = Math.min(effEnd, glassEdge - 2);
      }
    }
  }

  const H = hi - lo + 1;
  if (H <= 8) return empty;

  const numActive = activeCols.length;
  // Build fused 2D SNR evidence map E[aIdx][yIdx] over active on-plate columns
  const E: Float32Array[] = Array.from({ length: numActive }, () => new Float32Array(H));
  const stepMap: Uint8Array[] = Array.from({ length: numActive }, () => new Uint8Array(H));

  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const col = activeCols[aIdx];
    const colChSnrs: Float32Array[] = [];
    for (const ch of channels) {
      if (!isProfileOnPlate(ch.profiles[col], ch.sign)) continue;
      const { snr, hasStep } = computeFrontEvidenceStrip(ch.profiles[col], ch.sign, lo, hi, effEnd);
      colChSnrs.push(snr);
      for (let j = 0; j < H; j++) {
        if (hasStep[j]) stepMap[aIdx][j] = 1;
      }
    }
    if (!colChSnrs.length) continue;
    const dst = E[aIdx];
    if (colChSnrs.length === 1) {
      dst.set(colChSnrs[0]);
    } else {
      for (let j = 0; j < H; j++) {
        let maxV = 0;
        let sumV = 0;
        for (let k = 0; k < colChSnrs.length; k++) {
          const v = colChSnrs[k][j];
          if (v > maxV) maxV = v;
          sumV += Math.min(6, v);
        }
        // Best channel dominates; agreeing secondary channels reinforce weak fronts without drowning a clean channel
        dst[j] = maxV + 0.35 * Math.max(0, sumV - Math.min(6, maxV));
      }
    }
  }

  // Dynamic Programming across active on-plate columns to find the optimal continuous front seam
  const maxStep = Math.max(2, Math.min(12, Math.round(minLen * 0.008)));
  const stepPenalty = 0.22 / Math.max(1, (maxStep / 3) * (maxStep / 3));

  const dpPrev = new Float64Array(H);
  const dpCurr = new Float64Array(H);
  const backPtr = new Int16Array(numActive * H);

  for (let j = 0; j < H; j++) dpPrev[j] = E[0][j];

  for (let aIdx = 1; aIdx < numActive; aIdx++) {
    const eCol = E[aIdx];
    const ptrOff = aIdx * H;
    for (let j = 0; j < H; j++) {
      const kLo = Math.max(0, j - maxStep);
      const kHi = Math.min(H - 1, j + maxStep);
      let bestVal = -Infinity;
      let bestPrev = j;
      for (let k = kLo; k <= kHi; k++) {
        const dy = j - k;
        const val = dpPrev[k] - stepPenalty * dy * dy;
        if (val > bestVal) {
          bestVal = val;
          bestPrev = k;
        }
      }
      dpCurr[j] = bestVal + eCol[j];
      backPtr[ptrOff + j] = bestPrev;
    }
    dpPrev.set(dpCurr);
  }

  // Backtrack best seam
  let endIdx = 0;
  let bestTotal = -Infinity;
  for (let j = 0; j < H; j++) {
    if (dpPrev[j] > bestTotal) {
      bestTotal = dpPrev[j];
      endIdx = j;
    }
  }

  const seamIdx = new Int32Array(numActive);
  seamIdx[numActive - 1] = endIdx;
  for (let aIdx = numActive - 1; aIdx >= 1; aIdx--) {
    seamIdx[aIdx - 1] = backPtr[aIdx * H + seamIdx[aIdx]];
  }

  // Gather supported points along the seam (in original plate u ∈ [-1, 1] coordinates)
  const colToU = (origCol: number) => (numCols > 1 ? (2 * origCol) / (numCols - 1) - 1 : 0);
  const supportPts: Array<{ u: number; y: number; w: number; third: number; snr: number }> = [];
  const thirdTot = [0, 0, 0];
  const thirdSup = [0, 0, 0];
  let stepBackedCols = 0;

  const seamTol = Math.max(2, Math.round(minLen * 0.004));
  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const origCol = activeCols[aIdx];
    const third = Math.min(2, Math.floor((aIdx * 3) / numActive));
    thirdTot[third]++;
    const j0 = seamIdx[aIdx];
    let localPeakSnr = E[aIdx][j0];
    let localPeakJ = j0;
    let localStep = stepMap[aIdx][j0] > 0;
    for (let j = Math.max(0, j0 - seamTol); j <= Math.min(H - 1, j0 + seamTol); j++) {
      if (E[aIdx][j] > localPeakSnr) {
        localPeakSnr = E[aIdx][j];
        localPeakJ = j;
      }
      if (stepMap[aIdx][j] > 0) localStep = true;
    }
    if (localPeakSnr >= 3.2) {
      thirdSup[third]++;
      if (localStep) stepBackedCols++;
      supportPts.push({
        u: colToU(origCol),
        y: lo + localPeakJ,
        w: Math.min(10, localPeakSnr),
        third,
        snr: localPeakSnr,
      });
    }
  }

  const supportFrac = supportPts.length / numActive;
  const allThirds = thirdTot.every((tot, t) => tot === 0 || thirdSup[t] / tot >= 0.55);
  if (supportFrac < 0.65 || !allThirds) return empty;

  const curve = fitRobustFrontCurve(supportPts, minLen);
  if (!curve) return empty;

  // Re-verify support along the smooth fitted curve itself (rejecting jagged paths through unrelated spots)
  const curveTol = Math.max(5, Math.round(minLen * 0.012));
  let curveSupport = 0;
  const curveThirdSup = [0, 0, 0];
  const curveSnrs: number[] = [];

  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const origCol = activeCols[aIdx];
    const u = colToU(origCol);
    const predY = Math.round(curve.c0 + curve.c1 * u + curve.c2 * u * u);
    const jCenter = predY - lo;
    const jLo = Math.max(0, jCenter - curveTol);
    const jHi = Math.min(H - 1, jCenter + curveTol);
    let maxSnr = 0;
    for (let j = jLo; j <= jHi; j++) {
      if (E[aIdx][j] > maxSnr) maxSnr = E[aIdx][j];
    }
    if (maxSnr >= 3.2) {
      curveSupport++;
      curveThirdSup[Math.min(2, Math.floor((aIdx * 3) / numActive))]++;
      curveSnrs.push(maxSnr);
    }
  }

  const curveFrac = curveSupport / numActive;
  const curveThirdsOk = thirdTot.every((tot, t) => tot === 0 || curveThirdSup[t] / tot >= 0.55);
  if (curveFrac < 0.65 || !curveThirdsOk || curveSnrs.length < 3) return empty;

  curveSnrs.sort((a, b) => a - b);
  const medSnr = curveSnrs[curveSnrs.length >> 1];
  if (medSnr < 4.2) return empty;

  // Map smooth curve to every laneId in the half-plate
  const sortedIds = laneIds.slice().sort((a, b) => a - b);
  const byLane: Record<number, number> = {};
  const lanePositions: number[] = [];
  for (let i = 0; i < sortedIds.length; i++) {
    const u = sortedIds.length > 1 ? (2 * i) / (sortedIds.length - 1) - 1 : 0;
    const yPred = Math.round(
      Math.max(lo, Math.min(hi, curve.c0 + curve.c1 * u + curve.c2 * u * u))
    );
    byLane[sortedIds[i]] = yPred;
    lanePositions.push(yPred);
  }
  lanePositions.sort((a, b) => a - b);
  const medianPos = lanePositions[lanePositions.length >> 1];

  // Small bonus when step-backed across >= 45% of active columns so real wet-dry fronts outrank dry marks
  const stepBonus = stepBackedCols / numActive >= 0.45 ? 1.15 : 0.92;
  const score = medSnr * (0.3 + 0.7 * curveFrac) * stepBonus;

  return {
    medianPos,
    byLane,
    score,
    isCurved: curve.isCurved,
  };
}

// ---- 1-Click Color-Signature "Find Similar Spots Across Plate" ------------------------------------

export interface SimilarSpotLaneInput {
  laneId: number;
  origin: number;
  front: number;
  metrics: Lane2dMetrics;
  existingSpots?: TlcSpot[];
}

export interface SimilarSpotMatch {
  laneId: number;
  spots: TlcSpot[];
}

/**
 * Samples the RGB color signature (ΔR, ΔG, ΔB relative to clean silica) at `(refLane, refPos)`
 * and scans every lane on the plate for 2D-centered spots with matching chromatic direction and
 * comparable contrast. Lets a chemist find all pale/unusual stained or fluorescent spots across
 * 54 lanes with a single click instead of tedious manual labeling.
 */
export function findSimilarSpotsByColor(
  refMetrics: Lane2dMetrics,
  refPos: number,
  lanes: SimilarSpotLaneInput[],
  options: { minCosine?: number; minRelAmp?: number; minDistancePx?: number } = {}
): SimilarSpotMatch[] {
  const minCosine = options.minCosine ?? 0.86;
  const minRelAmp = options.minRelAmp ?? 0.38;
  const minDistancePx = options.minDistancePx ?? 16;

  const refLen = refMetrics.coreRgb.length / 3;
  if (refLen < 10) return [];
  const pCenter = Math.max(1, Math.min(refLen - 2, Math.round(refPos)));

  // Average 3px core around clicked spot for clean noise-free color vector
  let rAvg = 0,
    gAvg = 0,
    bAvg = 0,
    cnt = 0;
  for (let i = Math.max(0, pCenter - 1); i <= Math.min(refLen - 1, pCenter + 1); i++) {
    rAvg += refMetrics.coreRgb[i * 3];
    gAvg += refMetrics.coreRgb[i * 3 + 1];
    bAvg += refMetrics.coreRgb[i * 3 + 2];
    cnt++;
  }
  rAvg /= cnt;
  gAvg /= cnt;
  bAvg /= cnt;

  const refDr = rAvg - refMetrics.bgRgb[0];
  const refDg = gAvg - refMetrics.bgRgb[1];
  const refDb = bAvg - refMetrics.bgRgb[2];
  const refMag = Math.hypot(refDr, refDg, refDb);
  if (refMag < 4.5) return [];

  const uR = refDr / refMag;
  const uG = refDg / refMag;
  const uB = refDb / refMag;
  const minAmp = Math.max(4.5, refMag * minRelAmp);

  const results: SimilarSpotMatch[] = [];

  for (const lane of lanes) {
    const m = lane.metrics;
    if (m.offPlate || m.borderStraddle) continue;
    const L = m.coreRgb.length / 3;
    const span = Math.max(1, lane.front - lane.origin);
    const start = Math.max(3, Math.round(lane.origin + Math.max(4, 0.03 * span)));
    const end = Math.min(L - 4, Math.round(lane.origin + Math.min(span - 3, 0.97 * span)));
    if (end <= start + 4) continue;

    // Matched-filter projection along reference color vector (uR, uG, uB), gated by cosine similarity
    // and 2D center dominance (rejects neighbor spillover and weak horizontal illumination bands).
    const rawResp = new Float32Array(L);
    const [bgR, bgG, bgB] = m.bgRgb;
    for (let i = start; i <= end; i++) {
      const dr = m.coreRgb[i * 3] - bgR;
      const dg = m.coreRgb[i * 3 + 1] - bgG;
      const db = m.coreRgb[i * 3 + 2] - bgB;
      const mag = Math.hypot(dr, dg, db);
      if (mag < minAmp * 0.5) continue;
      const proj = dr * uR + dg * uG + db * uB;
      const cos = proj / mag;
      if (cos < minCosine) continue;
      // 2D spillover / weak horizontal band guard (never erases strong coalesced spots)
      if (m.edgeRatio[i] > 1.55 && proj < 42 && m.lateralExcess[i] < Math.max(2.5, 0.25 * proj)) continue;
      if (proj < 38 && m.lateralExcess[i] < Math.max(2.0, 0.16 * proj)) continue;
      rawResp[i] = proj * cos;
    }

    // Light 5-px smoothing
    const sm = new Float32Array(L);
    for (let i = start; i <= end; i++) {
      let s = 0,
        c = 0;
      for (let k = Math.max(start, i - 2); k <= Math.min(end, i + 2); k++) {
        s += rawResp[k];
        c++;
      }
      sm[i] = c > 0 ? s / c : 0;
    }

    // Find local maxima separated by >= minDistancePx
    const peaks: Array<{ pos: number; val: number }> = [];
    const halfW = Math.max(4, Math.round(minDistancePx / 2));
    for (let i = start + 1; i < end; i++) {
      const v = sm[i];
      if (v < minAmp) continue;
      if (v < sm[i - 1] || v < sm[i + 1]) continue;
      let isMax = true;
      for (let k = Math.max(start, i - halfW); k <= Math.min(end, i + halfW); k++) {
        if (sm[k] > v || (sm[k] === v && k < i)) {
          isMax = false;
          break;
        }
      }
      if (isMax) peaks.push({ pos: i, val: v });
    }

    if (peaks.length > 0) {
      const spots: TlcSpot[] = peaks.map((pk) => ({
        pos: pk.pos,
        rf: Math.max(0, Math.min(1, +((pk.pos - lane.origin) / span).toFixed(3))),
        strength: Math.min(1, Math.max(0.15, +(pk.val / Math.max(refMag, pk.val)).toFixed(3))),
        source: 'auto',
      }));
      results.push({ laneId: lane.laneId, spots });
    }
  }

  return results;
}

// ---- Experiment-Aware Shared-Reagent Cross-Lane Spot Coherence ------------------------------------

export interface CrossLaneCoherenceInput {
  laneId: number;
  /** Reagent codes present in this well (from the run recipe) */
  reagentCodes: string[];
  origin: number;
  front: number;
  /** Standard spots already detected by solo lane findSpots */
  soloSpots: TlcSpot[];
  /** Relaxed candidate spots (e.g. from lower prominence) eligible for cross-lane promotion */
  relaxedCandidates: TlcSpot[];
}

/**
 * Uses the known HTE plate layout to rescue faint real spots that appear consistently at the
 * same smooth Rf (±rfTol) across >= 3 wells sharing a common starting material, without raising
 * false positives on isolated lanes.
 */
export function rescueSharedReagentSpots(
  lanes: CrossLaneCoherenceInput[],
  rfTol: number = 0.025
): Map<number, TlcSpot[]> {
  const promoted = new Map<number, TlcSpot[]>();
  const byReagent = new Map<string, CrossLaneCoherenceInput[]>();

  for (const lane of lanes) {
    for (const code of lane.reagentCodes) {
      if (!code) continue;
      const arr = byReagent.get(code) || [];
      arr.push(lane);
      byReagent.set(code, arr);
    }
  }

  for (const groupLanes of byReagent.values()) {
    if (groupLanes.length < 3) continue;

    // Collect every spot (solo + relaxed) across lanes sharing this reagent
    const allObs: Array<{ laneId: number; spot: TlcSpot; isSolo: boolean }> = [];
    for (const gl of groupLanes) {
      for (const sp of gl.soloSpots) allObs.push({ laneId: gl.laneId, spot: sp, isSolo: true });
      for (const sp of gl.relaxedCandidates) {
        if (!gl.soloSpots.some((s) => Math.abs(s.rf - sp.rf) < rfTol)) {
          allObs.push({ laneId: gl.laneId, spot: sp, isSolo: false });
        }
      }
    }

    const minAgree = Math.max(3, Math.ceil(groupLanes.length * 0.45));
    for (const anchor of allObs) {
      if (anchor.isSolo) continue; // only need to decide whether to promote relaxed candidates
      const agreeingLanes = new Set<number>();
      for (const other of allObs) {
        if (Math.abs(other.spot.rf - anchor.spot.rf) <= rfTol) {
          agreeingLanes.add(other.laneId);
        }
      }
      if (agreeingLanes.size >= minAgree) {
        const list = promoted.get(anchor.laneId) || [];
        if (!list.some((s) => Math.abs(s.rf - anchor.spot.rf) < rfTol)) {
          list.push(anchor.spot);
          promoted.set(anchor.laneId, list);
        }
      }
    }
  }

  return promoted;
}
