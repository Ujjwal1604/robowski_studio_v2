// Robowski Studio - 2D Physics-Driven TLC Vision Engine
//
// Upgrades 1D single-channel heuristics with full-RGB color perception, 2D lane-vs-gutter lateral
// verification (eliminating horizontal illumination bands and adjacent-lane spillover), 2D smooth
// curved solvent-front seam tracking (handling smiling/tilted fronts across 27 lanes), shared-reagent
// cross-lane coherence, and 1-click color-signature plate-wide spot matching.
import type { Lane2dMetrics, TlcSpot } from '../types';
import { buildLaneSpotMap2d } from './tlcSpots2d';

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
  isGutter: boolean = false,
  centerOffsets?: Float32Array
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
  const useOffsets = Boolean(centerOffsets && centerOffsets.length === L);

  // Precompute cosine weights for the static center core (fast path when automiddle is off)
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
    if (useOffsets) {
      const rc = Math.max(0, Math.min(W - 1, centerOffsets![idx]));
      const r0 = Math.max(0, Math.floor(rc - halfSpan));
      const r1 = Math.min(W - 1, Math.ceil(rc + halfSpan));
      let rWSum = 0;
      for (let x = r0; x <= r1; x++) {
        const dist = Math.abs(x - rc);
        if (dist > halfSpan) continue;
        const w = Math.cos((dist / halfSpan) * (Math.PI / 2));
        const p = rowOff + x * 4;
        sr += (rgba[p] ?? 0) * w;
        sg += (rgba[p + 1] ?? 0) * w;
        sb += (rgba[p + 2] ?? 0) * w;
        rWSum += w;
      }
      if (rWSum <= 0) rWSum = 1;
      coreR[idx] = sr / rWSum;
      coreG[idx] = sg / rWSum;
      coreB[idx] = sb / rWSum;
    } else {
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
    }

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
  const rowMass = new Float32Array(L);
  const spotWidth = new Float32Array(L);
  const flankProfile = new Float32Array(L);

  // Interior 76% of lane width for 2D hourglass silhouette (rowMass & lateral spotWidth)
  const mx0 = W >= 6 ? Math.floor(W * 0.12) : 0;
  const mx1 = W >= 6 ? Math.ceil(W * 0.88) - 1 : W - 1;
  const mCount = Math.max(1, mx1 - mx0 + 1);

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

  // Precompute center deviation across the lane so spotWidth uses a FIXED lane-scale threshold
  // (scaling the threshold by row-local cDev would measure constant relative FWHM and cancel hourglass waists).
  const coreDevArr = new Float32Array(L);
  const cDevSamples: number[] = [];
  const dLo = Math.max(0, Math.floor(L * 0.10));
  const dHi = Math.min(L - 1, Math.ceil(L * 0.90));
  const dStep = Math.max(1, Math.floor((dHi - dLo + 1) / 120));
  for (let i = 0; i < L; i++) {
    const cd = devFromBg(coreR[i], coreG[i], coreB[i]);
    coreDevArr[i] = cd;
    if (i >= dLo && i <= dHi && (i - dLo) % dStep === 0) cDevSamples.push(cd);
  }
  const lanePeakDev = Math.max(25, quantileOfArray(cDevSamples, 0.98));
  const fixedLoCut = Math.max(12, 0.42 * lanePeakDev);
  const fixedHiCut = Math.max(24, 0.78 * lanePeakDev);
  const fixedCutSpan = Math.max(8, fixedHiCut - fixedLoCut);

  for (let i = 0; i < L; i++) {
    const cr = coreR[i];
    const cg = coreG[i];
    const cb = coreB[i];
    coreRgb[i * 3] = cr;
    coreRgb[i * 3 + 1] = cg;
    coreRgb[i * 3 + 2] = cb;

    profile[i] = scalarFor(cr, cg, cb);

    const cDev = coreDevArr[i];

    // 2D cross-lane integrated spot mass & fixed-threshold lateral width fraction (detects hourglass waists)
    const y = L - 1 - i;
    const rowOff = y * W * 4;
    let massSum = 0;
    let widthSum = 0;
    for (let x = mx0; x <= mx1; x++) {
      const p = rowOff + x * 4;
      const pxDev = devFromBg(rgba[p] ?? 0, rgba[p + 1] ?? 0, rgba[p + 2] ?? 0);
      massSum += pxDev;
      if (pxDev > fixedLoCut) {
        widthSum += pxDev >= fixedHiCut ? 1 : (pxDev - fixedLoCut) / fixedCutSpan;
      }
    }
    rowMass[i] = massSum / mCount;
    spotWidth[i] = widthSum / mCount;

    if (flankW > 0) {
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
      flankProfile[i] =
        0.5 *
        (scalarFor(leftR[i], leftG[i], leftB[i]) + scalarFor(rightR[i], rightG[i], rightB[i]));
    } else {
      lateralExcess[i] = 999; // Narrow synthetic strips without flanks skip lateral rejection
      edgeRatio[i] = 0;
      flankProfile[i] = profile[i];
    }
  }

  let automiddleOffsets: Float32Array | undefined;
  if (useOffsets && centerOffsets) {
    automiddleOffsets = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      automiddleOffsets[i] = centerOffsets[i] - center;
    }
  }

  const spotMap2d = !isGutter && !offPlate && !borderStraddle
    ? buildLaneSpotMap2d(rgba, W, L, channel, [bgR, bgG, bgB])
    : undefined;

  return {
    profile,
    metrics: {
      lateralExcess,
      edgeRatio,
      coreRgb,
      bgRgb: [bgR, bgG, bgB],
      offPlate,
      borderStraddle,
      rowMass,
      spotWidth,
      flankProfile,
      ...(automiddleOffsets ? { automiddleOffsets } : {}),
      ...(spotMap2d ? { spotMap2d } : {}),
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
  /** Optional channel identity for multi-channel graphite pencil suppression (White vs UV) */
  channel?: VisionChannelKey;
  /** Optional per-column 2D lateral strip metrics (enables 2D horizontal-continuity front scoring & spot rejection) */
  metrics?: Array<Lane2dMetrics | undefined>;
  /** Optional fractional lane coordinates in [0..laneIds.length-1] for each column (e.g. [0.5, 1.5, ...] for gutters) */
  colPositions?: number[];
}

export interface CurvedFrontSeamOptions {
  /** Hard upper search bound in lane px (e.g. dual-half center gap ceiling so search never crosses into opposite half) */
  maxFrontPos?: number;
  /** Safe upper silica reference bound in lane px (just before opposing half's dark front band) */
  effEndPos?: number;
  /** Optional sibling channels (e.g. UV366, White) for cross-channel graphite pencil-line confirmation during single-channel seam runs */
  referenceChannels?: CurvedFrontChannelInput[];
}

export interface DualHalfGapCeilingResult {
  /** Safe upper search ceiling in current half's lane px (inside clean middle gap) */
  maxFrontPos: number;
  /** Safe dry-silica reference end in current half's lane px (strictly before opposing half's front band) */
  effEndPos: number;
  /** Whether two opposing front bands framing a clean center gap were explicitly confirmed */
  gapConfirmed: boolean;
}

export interface CurvedFrontSeamResult {
  /** Median front position across the half-plate (0 if not detected) */
  medianPos: number;
  /** Per-lane curved front positions keyed by laneId */
  byLane: Record<number, number>;
  /** Overall front confidence score (comparable to SNR units) */
  score: number;
  /** Whether a meaningful tilt, edge-curl, or bow was fitted (vs flat line) */
  isCurved: boolean;
  /** True when the seam is backed by a sustained capillary front band or wet/dry step (not a thin pencil-only ridge) */
  bandOrStepBacked?: boolean;
  /** Median positions of straight ruler graphite pencil lines that were confirmed & erased */
  suppressedPencilPositions?: number[];
}

function medianFilter1d(src: Float64Array, win: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  const w = Math.max(1, win | 1);
  const h = w >> 1;
  const buf = new Float64Array(w);
  for (let i = 0; i < n; i++) {
    let k = 0;
    const lo = Math.max(0, i - h);
    const hi = Math.min(n - 1, i + h);
    for (let j = lo; j <= hi; j++) buf[k++] = src[j];
    out[i] = medianOfSorted(buf, k);
  }
  return out;
}

/**
 * Locates the clean bright silica center gap between two head-to-head halves on a dual-sided plate
 * (e.g. 20x20 cm Merck plate with 9.5 cm & 10.5 cm pencil lines and handwritten middle annotation).
 * Uses cross-plate 75th/25th percentiles (erasing broken handwriting strokes) + vertical median
 * filtering (erasing 1-3 px ruler pencil lines) so each half's front search stops cleanly inside
 * the middle gap and never wanders into the opposite half's solvent front.
 */
export function findDualHalfGapCeiling(
  thisHalfChannels: Array<{ profiles: number[][]; sign: number }>,
  otherHalfChannels: Array<{ profiles: number[][]; sign: number }>,
  pairDistancePx: number,
  laneLen: number
): DualHalfGapCeilingResult | null {
  if (!thisHalfChannels.length || laneLen < 40 || !(pairDistancePx > 0)) return null;
  const midDist = pairDistancePx * 0.5;
  if (midDist < laneLen * 0.55 || midDist > laneLen * 1.15) return null;

  const corLo = Math.max(Math.floor(laneLen * 0.62), Math.floor(midDist - laneLen * 0.16));
  const corHi = Math.min(Math.ceil(pairDistancePx - laneLen * 0.45), Math.ceil(midDist + laneLen * 0.16));
  const span = corHi - corLo + 1;
  if (span < 20) return null;

  const medWin = Math.max(5, Math.min(11, Math.round(laneLen * 0.007) | 1));
  let bestGap: { score: number; gapLo: number; gapHi: number } | null = null;

  for (let cIdx = 0; cIdx < thisHalfChannels.length; cIdx++) {
    const thisCh = thisHalfChannels[cIdx];
    const otherCh = otherHalfChannels[cIdx];
    const sign = thisCh.sign;
    const activeThis = thisCh.profiles.filter((p) => p.length >= 20 && isProfileOnPlate(p, sign));
    const activeOther = otherCh
      ? otherCh.profiles.filter((p) => p.length >= 20 && isProfileOnPlate(p, sign))
      : [];
    if (activeThis.length < 4) continue;

    // Cross-plate clean-silica envelope: 75th percentile (sign < 0) or 25th percentile (sign > 0)
    // completely rejects sparse handwriting letters while preserving plate-wide front bands.
    const rawEnv = new Float64Array(span);
    const validRow = new Uint8Array(span);
    const colBuf = new Float64Array(Math.max(activeThis.length, activeOther.length) + 4);
    const qFrac = sign < 0 ? 0.75 : 0.25;

    for (let k = 0; k < span; k++) {
      const p = corLo + k;
      let cnt = 0;
      for (let j = 0; j < activeThis.length; j++) {
        if (p >= 0 && p < activeThis[j].length) colBuf[cnt++] = activeThis[j][p];
      }
      // Beyond this half's box end, bridge seamlessly into the opposing half's profile in shared plate coords
      if (cnt < Math.ceil(activeThis.length * 0.5) && activeOther.length >= 4) {
        const q = Math.round(pairDistancePx - p);
        cnt = 0;
        for (let j = 0; j < activeOther.length; j++) {
          if (q >= 0 && q < activeOther[j].length) colBuf[cnt++] = activeOther[j][q];
        }
      }
      if (cnt >= 3) {
        const view = colBuf.subarray(0, cnt);
        view.sort();
        const idx = Math.min(cnt - 1, Math.max(0, Math.round(qFrac * (cnt - 1))));
        rawEnv[k] = view[idx];
        validRow[k] = 1;
      }
    }

    // Fill any unmeasured edge rows from nearest valid row before vertical median filtering
    let firstValid = -1;
    let lastValid = -1;
    for (let k = 0; k < span; k++) {
      if (validRow[k]) {
        if (firstValid === -1) firstValid = k;
        lastValid = k;
      }
    }
    if (firstValid === -1 || lastValid - firstValid < 16) continue;
    for (let k = 0; k < firstValid; k++) rawEnv[k] = rawEnv[firstValid];
    for (let k = lastValid + 1; k < span; k++) rawEnv[k] = rawEnv[lastValid];

    // Vertical median erases 1-3 px ruler pencil lines while keeping sustained dark/glowing front bands
    const env = medianFilter1d(rawEnv, medWin);

    // Estimate clean dry silica level in the center corridor
    const envSort = new Float64Array(lastValid - firstValid + 1);
    for (let k = firstValid; k <= lastValid; k++) envSort[k - firstValid] = env[k];
    envSort.sort();
    const bgClean = envSort[Math.min(envSort.length - 1, Math.max(0, Math.round((sign < 0 ? 0.88 : 0.12) * (envSort.length - 1))))];

    const depth = new Float64Array(span);
    for (let k = 0; k < span; k++) {
      depth[k] = Math.max(0, sign * (env[k] - bgClean));
    }

    // Search for the cleanest center gap point within ±8% of geometric plate midline
    // that is flanked on BOTH sides by sustained front bands (this half < pGap < other half).
    const gLo = Math.max(firstValid + 6, Math.round(midDist - laneLen * 0.08) - corLo);
    const gHi = Math.min(lastValid - 6, Math.round(midDist + laneLen * 0.08) - corLo);
    if (gHi <= gLo) continue;

    // Precompute max band depth on left (this half) and right (other half) for every candidate gap index
    const maxLeft = new Float64Array(span);
    let runL = 0;
    for (let k = firstValid; k <= lastValid; k++) {
      if (depth[k] > runL) runL = depth[k];
      maxLeft[k] = runL;
    }
    const maxRight = new Float64Array(span);
    let runR = 0;
    for (let k = lastValid; k >= firstValid; k--) {
      if (depth[k] > runR) runR = depth[k];
      maxRight[k] = runR;
    }

    let bestK = -1;
    let bestChScore = 0;
    for (let k = gLo; k <= gHi; k++) {
      const sideMin = Math.min(maxLeft[k - 1], maxRight[k + 1]);
      if (sideMin < 14) continue;
      const gapClear = sideMin - depth[k];
      if (gapClear < 10 || depth[k] > Math.max(8, 0.30 * sideMin)) continue;
      // Mild preference for sitting near geometric midline when inside a flat bright gap plateau
      const midProx = 1 - 0.12 * Math.abs(corLo + k - midDist) / Math.max(1, laneLen * 0.08);
      const sc = gapClear * midProx;
      if (sc > bestChScore) {
        bestChScore = sc;
        bestK = k;
      }
    }

    if (bestK === -1) continue;
    const sideMin = Math.min(maxLeft[bestK - 1], maxRight[bestK + 1]);
    const gapThr = Math.max(8, 0.32 * sideMin);
    let gapLo = bestK;
    while (gapLo > firstValid && depth[gapLo - 1] <= gapThr) gapLo--;
    let gapHi = bestK;
    while (gapHi < lastValid && depth[gapHi + 1] <= gapThr) gapHi++;

    const gapWidth = gapHi - gapLo + 1;
    if (gapWidth < 4) continue;
    if (!bestGap || bestChScore > bestGap.score) {
      bestGap = { score: bestChScore, gapLo: corLo + gapLo, gapHi: corLo + gapHi };
    }
  }

  if (bestGap) {
    const gapW = bestGap.gapHi - bestGap.gapLo;
    // Allow searching into the clean gap far enough to capture wavy/slightly-overrun outer edges
    // on this half, while stopping strictly before the opposing half's front band (and never crossing
    // past ~6.5% beyond the 10 cm plate midline even if the opposing half's real front is very faint).
    const safetyMargin = Math.max(4, Math.min(10, Math.round(gapW * 0.22)));
    const midHardCap = Math.round(midDist + laneLen * 0.065);
    const rawEffEnd = Math.min(laneLen - 2, bestGap.gapHi - 2, midHardCap + 6);
    const rawMaxFront = Math.min(
      laneLen - 4,
      midHardCap,
      Math.max(
        bestGap.gapLo + Math.round(gapW * 0.5),
        bestGap.gapHi - safetyMargin
      )
    );
    return {
      maxFrontPos: Math.max(Math.floor(laneLen * 0.62), rawMaxFront),
      effEndPos: Math.max(Math.floor(laneLen * 0.64), rawEffEnd),
      gapConfirmed: true,
    };
  }

  // Soft fallback ceiling on head-to-head plates with faint/invisible opposing bands:
  // permit up to ~5% overrun past the 10 cm midline while blocking the opposite half's 10.5+ cm zone.
  const fallbackCap = Math.min(laneLen - 4, Math.round(midDist + laneLen * 0.055));
  return {
    maxFrontPos: Math.max(Math.floor(laneLen * 0.62), fallbackCap),
    effEndPos: Math.min(laneLen - 2, Math.max(Math.floor(laneLen * 0.64), fallbackCap + 4)),
    gapConfirmed: false,
  };
}

function movingAvgLocal(a: ArrayLike<number>, w: number): Float64Array {
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

function winQuantF(a: Float64Array, s: number, e: number, q: number, buf: Float64Array): number {
  const a0 = Math.max(0, s);
  const a1 = Math.min(a.length - 1, e);
  if (a1 < a0) return 0;
  const span = a1 - a0 + 1;
  const step = span <= buf.length ? 1 : Math.ceil(span / buf.length);
  let k = 0;
  for (let i = a0; i <= a1 && k < buf.length; i += step) buf[k++] = a[i];
  if (k <= 0) return 0;
  const view = buf.subarray(0, k);
  view.sort();
  return view[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))];
}

function measureLocalRidgeAndStep(
  s: Float64Array,
  i: number,
  n: number,
  topLim: number,
  sign: number,
  dirSign: number,
  rCore: number,
  tIn: number,
  tOut: number,
  mIn: number,
  mOut: number,
  bPreIn: number,
  bPreOut: number,
  bPostIn: number,
  bPostOut: number,
  bgNear: number,
  bgMid: number,
  bgFarLo: number,
  eWin: number,
  dryEdgeWin: number,
  bandInNear: number,
  bandDeepStart: number,
  bandInFar: number,
  dryOutNear: number,
  dryOutFar: number,
  wetBackNear: number,
  wetBackFar: number,
  sigmaS: number,
  buf: Float64Array
): { ridgeAmp: number; bandAmp: number; dryEdgeAmp: number; stepAmp: number } {
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

  // Broad chromatographic solvent-front band interior score (fallback for very diffuse bands)
  let bandAmp = 0;
  const effPostIn = Math.min(bPostIn, Math.max(3, topLim - i));
  if (i - bPreIn >= 0 && topLim - i >= 3) {
    const bPre = winMedF(s, Math.max(0, i - bPreOut), i - bPreIn, buf);
    const bPost = winMedF(s, Math.min(topLim, i + effPostIn), Math.min(topLim, i + bPostOut), buf);
    const dPre = sign * (c - bPre);
    const dPost = sign * (c - bPost);
    if (dPre > 2.5 && dPost > 2.5 && Math.min(dPre, dPost) >= 0.25 * Math.max(dPre, dPost)) {
      bandAmp = 0.7 * Math.min(dPre, dPost) + 0.3 * 0.5 * (dPre + dPost);
    }
  }

  // Outer (dry-side) leading edge of a sustained solvent-front accumulation band:
  // Requires BOTH near-inside [i-bandDeepStart .. i-bandInNear] AND deep-inside [i-bandInFar .. i-bandDeepStart]
  // to remain strongly elevated above dry & wet silica. This mathematically rejects 1-3 px ruler pencil lines
  // and narrow hairline menisci (whose deep slice is already clean silica) while locking onto the exact outer
  // dry-side edge of any 8-40+ px solvent-front band, immune to wet-side high-Rf blobs and drips.
  let dryEdgeAmp = 0;
  if (i - bandInFar >= 1 && topLim - i >= 3) {
    const cleanQ = sign < 0 ? 0.75 : 0.25;
    const effDryNear = Math.min(dryOutNear, Math.max(1, topLim - i - 2));
    const dryBg = winQuantF(s, Math.min(topLim, i + effDryNear), Math.min(topLim, i + dryOutFar), cleanQ, buf);
    const bandNearVal = winMedF(s, Math.max(0, i - bandDeepStart), Math.max(0, i - bandInNear), buf);
    const bandDeepVal = winMedF(s, Math.max(0, i - bandInFar), Math.max(0, i - bandDeepStart - 1), buf);
    const wetBg = winQuantF(s, Math.max(0, i - wetBackFar), Math.max(0, i - wetBackNear), cleanQ, buf);
    const nearDepthDry = sign * (bandNearVal - dryBg);
    const deepDepthDry = sign * (bandDeepVal - dryBg);
    const nearDepthWet = sign * (bandNearVal - wetBg);
    const deepDepthWet = sign * (bandDeepVal - wetBg);
    const edgeInIdx = Math.max(0, i - Math.max(1, bandInNear));
    const nearEdgeDepth = sign * (s[edgeInIdx] - dryBg);

    // Reject razor-sharp 2-4 px pencil spikes sitting right at the dry edge even if a very faint
    // band happens to lie just behind them (a real sustained front band doesn't spike >2.6x deeper
    // in its outermost 3 px than in its interior slice).
    let nearPeakDepth = nearDepthDry;
    for (let k = Math.max(0, i - bandDeepStart); k <= i; k++) {
      const d = sign * (s[k] - dryBg);
      if (d > nearPeakDepth) nearPeakDepth = d;
    }
    const notSharpEdgeSpike = nearPeakDepth <= Math.max(deepDepthDry * 2.5, deepDepthDry + 10);

    const minNearDry = Math.max(2.0, 1.9 * sigmaS);
    const minDeepDry = Math.max(1.6, 1.5 * sigmaS);
    const minNearWet = Math.max(1.6, 1.5 * sigmaS);
    const minDeepWet = Math.max(1.3, 1.2 * sigmaS);
    const minLocalDrop = Math.max(1.0, 0.95 * sigmaS);

    if (
      notSharpEdgeSpike &&
      nearDepthDry > minNearDry &&
      deepDepthDry > minDeepDry &&
      deepDepthDry >= 0.45 * nearDepthDry &&
      nearEdgeDepth >= 0.50 * Math.max(nearDepthDry, deepDepthDry) &&
      nearDepthWet > minNearWet &&
      deepDepthWet > minDeepWet
    ) {
      const bandDepthDry = Math.min(nearDepthDry, deepDepthDry);
      const bandDepthWet = Math.min(nearDepthWet, deepDepthWet);
      const justIn = winMeanF(s, Math.max(0, i - dryEdgeWin), Math.max(0, i - 1));
      const justOut = winMeanF(s, Math.min(topLim, i + 1), Math.min(topLim, i + dryEdgeWin));
      const localDrop = sign * (justIn - justOut);
      if (
        localDrop > minLocalDrop &&
        Math.min(bandDepthDry, bandDepthWet) >= 0.25 * Math.max(bandDepthDry, bandDepthWet)
      ) {
        const sustained = Math.min(bandDepthDry, bandDepthWet);
        // Pinpoint right at the transition slope (downweight if still deep inside flat band or far out in dry gap)
        const midTarget = 0.5 * (bandNearVal + dryBg);
        const halfSpan = Math.max(3, 0.5 * nearDepthDry);
        const slopeCentering = Math.max(0.25, 1 - 0.55 * Math.min(1.3, Math.abs(c - midTarget) / halfSpan));
        dryEdgeAmp = (0.55 * Math.min(sustained, localDrop) + 0.45 * Math.sqrt(sustained * localDrop)) * slopeCentering;
      }
    }
  }

  let stepAmp = 0;
  const effBgNearAfter = Math.min(bgNear, Math.max(3, topLim - i));
  if (i + effBgNearAfter <= topLim && i - bgNear >= 0) {
    const cleanQ = sign < 0 ? 0.75 : 0.25;
    const medAfter = winMedF(s, i + effBgNearAfter, Math.min(topLim, i + bgMid), buf);
    const medBefore = winMedF(s, Math.max(0, i - bgMid), i - bgNear, buf);
    const farBefore =
      i - Math.round(n * 0.06) >= 3
        ? winMedF(s, Math.max(0, i - bgFarLo), i - Math.max(bgNear + 2, Math.round(n * 0.06)), buf)
        : medBefore;
    const nearBeforeSpan = Math.max(12, Math.round(n * 0.045));
    const nearBeforeClean = winQuantF(s, Math.max(0, i - nearBeforeSpan), i - bgNear, cleanQ, buf);
    const edgeL = winMeanF(s, Math.max(0, i - rCore - eWin), Math.max(0, i - rCore - 1));
    const edgeR = winMeanF(s, Math.min(topLim, i + rCore + 1), Math.min(topLim, i + rCore + eWin));
    const macroDelta = medAfter - medBefore;
    const farDelta = medAfter - farBefore;
    const nearDelta = medAfter - nearBeforeClean;
    const edgeLeftBelowDry = medAfter - edgeL;
    const localDelta = edgeR - edgeL;
    // Guard against dark 2-4 px graphite pencil lines or handwriting strokes sitting in/near the dry gap:
    // exiting a deep thin trough creates a huge fake localDelta even though edgeL plunged far below the
    // wet background (medBefore or farBefore). Checking farBefore prevents a dark solvent-front band
    // 10-30 px behind the pencil line from corrupting medBefore and hiding the trough exit.
    const troughDepthMed = sign * (edgeL - medBefore);
    const troughDepthFar = sign * (edgeL - farBefore);
    const pencilTroughExit =
      dryEdgeAmp <= 0 &&
      (troughDepthMed > Math.max(6.0, 1.5 * Math.abs(macroDelta)) ||
        troughDepthFar > Math.max(6.0, 1.5 * Math.abs(farDelta)));
    if (
      !pencilTroughExit &&
      macroDelta * dirSign > 0 &&
      farDelta * dirSign > 0 &&
      nearDelta * dirSign > 0 &&
      edgeLeftBelowDry * dirSign > 0 &&
      localDelta * dirSign > 0 &&
      Math.abs(macroDelta) >= 0.38 * Math.abs(farDelta)
    ) {
      stepAmp = Math.min(
        Math.abs(macroDelta),
        Math.abs(farDelta),
        Math.abs(nearDelta),
        Math.abs(edgeLeftBelowDry),
        Math.abs(localDelta)
      );
    }
  }

  return { ridgeAmp, bandAmp, dryEdgeAmp, stepAmp };
}

/**
 * Computes per-pixel front evidence (in SNR units) along a single lane/gutter strip
 * across [lo..hi], combining:
 *   - Outer (dry-side) leading edge of sustained solvent-front accumulation bands (`dryEdgeAmp`),
 *     which steps cleanly over 1-3 px ruler pencil lines and ignores wet-side high-Rf blobs/drips,
 *   - Persistent wet-vs-dry silica background step (`stepAmp`), and
 *   - Thin meniscus hairline ridge (`ridgeAmp`).
 * When 2D lateral strip metrics are available, enforces 2D horizontal continuity across
 * core + outer flanks so horizontally continuous solvent fronts are rewarded while
 * center-peaked high-Rf spots and neighbor-lane spillover are sharply suppressed.
 */
function computeFrontEvidenceStrip(
  profile: number[],
  sign: number,
  lo: number,
  hi: number,
  effEnd?: number,
  metrics?: Lane2dMetrics
): { snr: Float32Array; hasStep: Uint8Array; hasBand: Uint8Array; isThinPencilLike: Uint8Array } {
  const n = profile.length;
  const topLim = effEnd != null ? Math.min(n - 1, effEnd) : n - 1;
  const count = hi - lo + 1;
  const snr = new Float32Array(count);
  const hasStep = new Uint8Array(count);
  const hasBand = new Uint8Array(count);
  const isThinPencilLike = new Uint8Array(count);
  if (n < 20 || count <= 4) return { snr, hasStep, hasBand, isThinPencilLike };
  if (metrics?.offPlate || metrics?.borderStraddle) return { snr, hasStep, hasBand, isThinPencilLike };

  const s = movingAvgLocal(profile, 3);
  const has2dFlanks =
    !!metrics?.flankProfile &&
    metrics.flankProfile.length === n &&
    metrics.lateralExcess.length === n &&
    metrics.lateralExcess[lo] < 500;
  const sf = has2dFlanks ? movingAvgLocal(metrics!.flankProfile!, 3) : null;

  const rCore = Math.max(0, Math.round(n * 0.0015));
  const tIn = Math.max(2, Math.round(n * 0.003));
  const tOut = tIn + Math.max(3, Math.round(n * 0.007));
  const mIn = tOut + 1;
  const mOut = mIn + Math.max(8, Math.round(n * 0.025));

  const bPreIn = Math.max(6, Math.round(n * 0.025));
  const bPreOut = bPreIn + Math.max(12, Math.round(n * 0.065));
  const bPostIn = Math.max(5, Math.round(n * 0.018));
  const bPostOut = bPostIn + Math.max(12, Math.round(n * 0.055));

  const bgNear = Math.max(3, Math.round(n * 0.008));
  const bgMid = Math.max(24, Math.round(n * 0.14));
  const bgFarLo = Math.max(36, Math.round(n * 0.22));
  const eWin = Math.max(2, Math.round(n * 0.006));
  const dryEdgeWin = Math.max(2, Math.min(8, Math.round(n * 0.0045)));
  const bandInNear = Math.max(2, Math.round(n * 0.002));
  const bandDeepStart = Math.max(5, Math.round(n * 0.006));
  const bandInFar = bandDeepStart + Math.max(4, Math.round(n * 0.005));
  const dryOutNear = Math.max(2, Math.round(n * 0.004));
  const dryOutFar = dryOutNear + Math.max(8, Math.round(n * 0.026));
  const wetBackNear = Math.max(14, Math.round(n * 0.045));
  const wetBackFar = wetBackNear + Math.max(18, Math.round(n * 0.075));
  const dirSign = -Math.sign(sign || 1);

  const d2Arr = new Float64Array(Math.max(1, count - 2));
  let d2Cnt = 0;
  for (let i = lo + 1; i <= hi - 1; i++) {
    d2Arr[d2Cnt++] = Math.abs(s[i + 1] - 2 * s[i] + s[i - 1]);
  }
  let sigmaS = Math.max(0.65, 1.4826 * medianOfSorted(d2Arr, d2Cnt) * 0.866);
  if (sf) {
    let fCnt = 0;
    for (let i = lo + 1; i <= hi - 1; i++) {
      d2Arr[fCnt++] = Math.abs(sf[i + 1] - 2 * sf[i] + sf[i - 1]);
    }
    const sigmaF = Math.max(0.65, 1.4826 * medianOfSorted(d2Arr, fCnt) * 0.866);
    sigmaS = Math.max(0.65, 0.5 * (sigmaS + sigmaF));
  }

  const buf = new Float64Array(40);
  const feats = new Float64Array(count);
  const ranks = new Float64Array(count);

  const apply2dContinuity = (coreVal: number, flankVal: number, i: number): number => {
    const joint = Math.min(coreVal, flankVal);
    if (!metrics || metrics.edgeRatio[i] > 1.35) {
      return joint;
    }
    const lat = Math.max(0, metrics.lateralExcess[i]);
    const flankSupport = Math.min(1, flankVal / Math.max(coreVal * 0.45, 1e-6));
    const spotPenalty =
      lat > Math.max(4, 0.45 * coreVal)
        ? Math.max(0.08, 1 - (lat - 0.35 * coreVal) / Math.max(coreVal, 6))
        : 1;
    return joint + 0.35 * Math.max(0, coreVal - joint) * flankSupport * spotPenalty;
  };

  for (let i = lo; i <= hi; i++) {
    const core = measureLocalRidgeAndStep(
      s,
      i,
      n,
      topLim,
      sign,
      dirSign,
      rCore,
      tIn,
      tOut,
      mIn,
      mOut,
      bPreIn,
      bPreOut,
      bPostIn,
      bPostOut,
      bgNear,
      bgMid,
      bgFarLo,
      eWin,
      dryEdgeWin,
      bandInNear,
      bandDeepStart,
      bandInFar,
      dryOutNear,
      dryOutFar,
      wetBackNear,
      wetBackFar,
      sigmaS,
      buf
    );

    let ridgeAmp = core.ridgeAmp;
    let bandAmp = core.bandAmp;
    let dryEdgeAmp = core.dryEdgeAmp;
    let stepAmp = core.stepAmp;

    if (sf && metrics) {
      const flank = measureLocalRidgeAndStep(
        sf,
        i,
        n,
        topLim,
        sign,
        dirSign,
        rCore,
        tIn,
        tOut,
        mIn,
        mOut,
        bPreIn,
        bPreOut,
        bPostIn,
        bPostOut,
        bgNear,
        bgMid,
        bgFarLo,
        eWin,
        dryEdgeWin,
        bandInNear,
        bandDeepStart,
        bandInFar,
        dryOutNear,
        dryOutFar,
        wetBackNear,
        wetBackFar,
        sigmaS,
        buf
      );
      ridgeAmp = apply2dContinuity(core.ridgeAmp, flank.ridgeAmp, i);
      bandAmp = apply2dContinuity(core.bandAmp, flank.bandAmp, i);
      dryEdgeAmp = apply2dContinuity(core.dryEdgeAmp, flank.dryEdgeAmp, i);

      const minStep = Math.min(core.stepAmp, flank.stepAmp);
      const maxStep = Math.max(core.stepAmp, flank.stepAmp);
      stepAmp = minStep + 0.30 * (maxStep - minStep) * (minStep > 0.5 ? 1 : 0.35);
    }

    // Prioritize the crisp outer (dry-side) edge of sustained solvent-front bands over band center
    // and over thin ridge-only pencil lines. Keep diffuse band center (0.45x) as gentle fallback.
    const dryEdgeWeight = sf ? 1.15 : 1.05;
    const bandCenterWeight = sf ? 0.48 : 0.38;
    const bandBacked = dryEdgeAmp >= Math.max(1.8, 2.0 * sigmaS);
    const rawStepBacked = stepAmp >= Math.max(1.0, 1.3 * sigmaS);
    // Do not let a tiny background drift right underneath a razor-sharp graphite pencil line
    // (ridgeAmp >> stepAmp, no sustained front band) grant full step-backed rank to the pencil line.
    const pencilDominatedRidge = !bandBacked && ridgeAmp >= Math.max(4.0, 3.0 * sigmaS) && ridgeAmp > 2.2 * stepAmp;
    const stepBacked = rawStepBacked && !pencilDominatedRidge;
    const effectiveLine = Math.max(dryEdgeAmp * dryEdgeWeight, ridgeAmp, bandAmp * bandCenterWeight);
    const feat = effectiveLine + 0.65 * stepAmp;
    feats[i - lo] = feat;
    if (stepBacked) hasStep[i - lo] = 1;
    if (bandBacked) hasBand[i - lo] = 1;

    // A sharp thin dark ridge with neither a sustained front band behind it nor a genuine wet/dry step
    // behaves like a dry graphite ruler pencil line or handwriting stroke.
    const thinPencil = pencilDominatedRidge || (!bandBacked && !stepBacked && ridgeAmp >= Math.max(4.0, 3.0 * sigmaS));
    if (thinPencil) isThinPencilLike[i - lo] = 1;

    // Step-backed and sustained band-edge fronts receive full rank; ridge-only marks are attenuated
    // so heavy ruler pencil lines lose cleanly to real solvent-front bands.
    ranks[i - lo] = stepBacked || bandBacked ? feat : feat * 0.65;
  }

  const fSort = new Float64Array(feats);
  const medF = medianOfSorted(fSort, count);
  for (let j = 0; j < count; j++) fSort[j] = Math.abs(feats[j] - medF);
  const madF = 1.4826 * medianOfSorted(fSort, count);
  const noiseFloor = Math.max(sigmaS, madF, 0.75);

  for (let j = 0; j < count; j++) {
    const rawSnr = ranks[j] / noiseFloor;
    if (hasStep[j] || hasBand[j]) {
      // Sustained band-edge and wet-dry step fronts can reach ~14.5 SNR asymptotically
      snr[j] = rawSnr <= 10 ? rawSnr : 10 + 4.5 * ((rawSnr - 10) / (rawSnr - 10 + 10));
    } else {
      // Ridge-only marks (including heavy graphite pencil lines) saturate below 9.2 so they can
      // never outrank a real continuous solvent-front band, while still passing >= 4.2 on clean
      // ridge-only plates with no pencil line.
      snr[j] = rawSnr <= 6.5 ? rawSnr : 6.5 + 2.7 * ((rawSnr - 6.5) / (rawSnr - 6.5 + 8));
    }
  }
  return { snr, hasStep, hasBand, isThinPencilLike };
}

function evalPiecewiseLinear(laneY: Float64Array, x: number): number {
  const n = laneY.length;
  if (n <= 0) return 0;
  if (n === 1) return laneY[0];
  const clamped = Math.max(0, Math.min(n - 1, x));
  const k = Math.min(n - 2, Math.floor(clamped));
  const b = clamped - k;
  return (1 - b) * laneY[k] + b * laneY[k + 1];
}

function solveSymmetricLinear(A: Float64Array[], rhs: Float64Array): Float64Array | null {
  const n = rhs.length;
  const M = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n + 1);
    row.set(A[i]);
    row[n] = rhs[i];
    return row;
  });

  for (let col = 0; col < n; col++) {
    let piv = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxAbs) {
        maxAbs = v;
        piv = row;
      }
    }
    if (maxAbs < 1e-10) return null;
    if (piv !== col) {
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
    }
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const fac = M[row][col];
      if (fac === 0) continue;
      for (let j = col; j <= n; j++) M[row][j] -= fac * M[col][j];
    }
  }

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = M[i][n];
  return out;
}

/**
 * Fits a smooth per-lane front curve y[0..numLanes-1] via nested physical model selection:
 *   1. Flat constant baseline
 *   2. Robust linear tilt (Theil-Sen median slope)
 *   3. Robust IRLS 2nd-difference penalized smoothing spline (Whittaker smoother with Tukey biweight
 *      outlier rejection) — handles flat-center + curled-edge aluminium plates, classic parabolic
 *      smiles/frowns, bent corners, and gentle S-waves while staying immune to isolated outlier lanes.
 */
function fitSmoothFrontSpline(
  points: Array<{ x: number; y: number; w: number }>,
  numLanes: number,
  laneLen: number
): { laneY: Float64Array; isCurved: boolean } | null {
  if (points.length < 4 || numLanes < 4) return null;

  const sortedPts = points.slice().sort((a, b) => a.x - b.x);
  const spanX = Math.max(1, numLanes - 1);
  const toU = (x: number) => (2 * x) / spanX - 1;

  // 1. Flat median baseline
  const ys = sortedPts.map((p) => p.y).sort((a, b) => a - b);
  const flatY = ys[ys.length >> 1];
  const flatLaneY = new Float64Array(numLanes).fill(flatY);

  // 2. Robust linear tilt (Theil-Sen median slope)
  const slopes: number[] = [];
  for (let i = 0; i < sortedPts.length; i++) {
    for (let j = i + 1; j < sortedPts.length; j++) {
      const du = toU(sortedPts[j].x) - toU(sortedPts[i].x);
      if (Math.abs(du) > 0.25) slopes.push((sortedPts[j].y - sortedPts[i].y) / du);
    }
  }
  let linC0 = flatY;
  let linC1 = 0;
  if (slopes.length > 0) {
    slopes.sort((a, b) => a - b);
    linC1 = slopes[slopes.length >> 1];
    const icpts = sortedPts.map((p) => p.y - linC1 * toU(p.x)).sort((a, b) => a - b);
    linC0 = icpts[icpts.length >> 1];
  }
  const linLaneY = new Float64Array(numLanes);
  for (let i = 0; i < numLanes; i++) linLaneY[i] = linC0 + linC1 * toU(i);

  const huberCap = Math.max(10, laneLen * 0.025);
  const huberError = (modelY: Float64Array): number => {
    let sum = 0;
    for (const p of sortedPts) {
      sum += Math.min(huberCap, Math.abs(p.y - evalPiecewiseLinear(modelY, p.x)));
    }
    return sum / sortedPts.length;
  };
  const medianError = (modelY: Float64Array): number => {
    const errs = sortedPts
      .map((p) => Math.abs(p.y - evalPiecewiseLinear(modelY, p.x)))
      .sort((a, b) => a - b);
    return errs[errs.length >> 1];
  };

  const flatHuber = huberError(flatLaneY);
  const linHuber = huberError(linLaneY);
  const linMedRes = medianError(linLaneY);

  // 3. Robust IRLS 2nd-difference penalized smoothing spline (Whittaker smoother)
  let splineY: Float64Array | null = null;
  if (sortedPts.length >= 8) {
    // Running 3-point local reference kills isolated 1-lane outliers on iteration 0
    // while preserving genuine 3-4 lane aluminium edge curls cleanly
    const localRef = new Float64Array(sortedPts.length);
    for (let idx = 0; idx < sortedPts.length; idx++) {
      if (idx === 0 && sortedPts.length >= 3) {
        // Linear extrapolation from neighbors 1 & 2 protects genuine outer-edge curl
        const m1 = sortedPts[1].y;
        const m2 = sortedPts[2].y;
        const dx12 = Math.max(0.25, sortedPts[2].x - sortedPts[1].x);
        const dx01 = sortedPts[1].x - sortedPts[0].x;
        localRef[idx] = m1 - ((m2 - m1) / dx12) * dx01;
      } else if (idx === sortedPts.length - 1 && sortedPts.length >= 3) {
        const m1 = sortedPts[idx - 1].y;
        const m2 = sortedPts[idx - 2].y;
        const dx21 = Math.max(0.25, sortedPts[idx - 1].x - sortedPts[idx - 2].x);
        const dx10 = sortedPts[idx].x - sortedPts[idx - 1].x;
        localRef[idx] = m1 + ((m1 - m2) / dx21) * dx10;
      } else {
        const a = sortedPts[Math.max(0, idx - 1)].y;
        const b = sortedPts[idx].y;
        const c = sortedPts[Math.min(sortedPts.length - 1, idx + 1)].y;
        localRef[idx] = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
      }
    }

    const meanW =
      sortedPts.reduce((acc, p) => acc + Math.max(0.1, p.w), 0) / Math.max(1, sortedPts.length);
    // Scale-invariant 2nd-difference penalty: zero penalty on flat or tilted fronts,
    // tracks gentle multi-lane solvent waves & aluminium edge bends while crushing 1-lane outliers
    const lambda = 2.0 * Math.pow(Math.max(8, numLanes) / 27, 2);
    const initCutoff = Math.max(14, laneLen * 0.032);
    const irlsCutoff = Math.max(8, laneLen * 0.018);

    let currY: Float64Array | null = null;
    for (let iter = 0; iter < 6; iter++) {
      const A = Array.from({ length: numLanes }, () => new Float64Array(numLanes));
      const rhs = new Float64Array(numLanes);

      for (let idx = 0; idx < sortedPts.length; idx++) {
        const p = sortedPts[idx];
        let w = Math.max(0.1, p.w) / meanW;
        if (iter === 0) {
          const err = Math.abs(p.y - localRef[idx]);
          if (err >= initCutoff) w = 0;
          else {
            const t = err / initCutoff;
            w *= (1 - t * t) ** 2;
          }
        } else if (currY) {
          const err = Math.abs(p.y - evalPiecewiseLinear(currY, p.x));
          if (err >= irlsCutoff) w = 0;
          else {
            const t = err / irlsCutoff;
            w *= (1 - t * t) ** 2;
          }
        }
        if (w <= 0) continue;

        const cx = Math.max(0, Math.min(numLanes - 1, p.x));
        const k = Math.min(numLanes - 2, Math.floor(cx));
        const b = cx - k;
        const a = 1 - b;
        A[k][k] += w * a * a;
        A[k][k + 1] += w * a * b;
        A[k + 1][k] += w * a * b;
        A[k + 1][k + 1] += w * b * b;
        rhs[k] += w * a * p.y;
        rhs[k + 1] += w * b * p.y;
      }

      // Add lambda * D2^T D2 (2nd-difference curvature penalty)
      for (let i = 1; i < numLanes - 1; i++) {
        const idxs = [i - 1, i, i + 1];
        const coeffs = [1, -2, 1];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            A[idxs[r]][idxs[c]] += lambda * coeffs[r] * coeffs[c];
          }
        }
      }
      // Tiny diagonal ridge for guaranteed numerical stability
      for (let i = 0; i < numLanes; i++) A[i][i] += 1e-6;

      const solved = solveSymmetricLinear(A, rhs);
      if (!solved) {
        currY = null;
        break;
      }
      currY = solved;
    }
    splineY = currY;
  }

  const maxAllowedShift = Math.max(24, laneLen * 0.11);
  const maxAllowedSlope = Math.max(10, laneLen * 0.022);
  const minCurveAmp = Math.max(3.5, laneLen * 0.004);
  const minSplineDev = Math.max(1.8, laneLen * 0.0026);

  if (splineY) {
    let maxDevFromLin = 0;
    let maxDevFromFlat = 0;
    let maxStepDiff = 0;
    for (let i = 0; i < numLanes; i++) {
      maxDevFromLin = Math.max(maxDevFromLin, Math.abs(splineY[i] - linLaneY[i]));
      maxDevFromFlat = Math.max(maxDevFromFlat, Math.abs(splineY[i] - flatY));
      if (i > 0) {
        maxStepDiff = Math.max(maxStepDiff, Math.abs(splineY[i] - splineY[i - 1]));
      }
    }
    const splineHuber = huberError(splineY);
    const splineMedRes = medianError(splineY);
    const improvesHuber =
      splineHuber < 0.84 * linHuber &&
      linHuber - splineHuber >= Math.max(0.55, laneLen * 0.0009);
    const improvesMed =
      splineMedRes < 0.82 * linMedRes &&
      linMedRes - splineMedRes >= Math.max(0.9, laneLen * 0.0015);

    // Detect localized coherent bends/waves (e.g. wavy left/right edge or 3-5 lane bend on an
    // otherwise flat plate) while still rejecting isolated single-lane outliers.
    const localDevMin = Math.max(2.2, laneLen * 0.003);
    const improvedPts: Array<{ x: number; sign: number }> = [];
    for (const p of sortedPts) {
      const linVal = evalPiecewiseLinear(linLaneY, p.x);
      const splVal = evalPiecewiseLinear(splineY, p.x);
      const linErr = p.y - linVal;
      const splErr = p.y - splVal;
      const splShift = splVal - linVal;
      if (
        Math.abs(linErr) >= localDevMin &&
        Math.abs(splShift) >= localDevMin * 0.65 &&
        Math.sign(linErr) === Math.sign(splShift) &&
        Math.abs(splErr) <= 0.48 * Math.abs(linErr)
      ) {
        improvedPts.push({ x: p.x, sign: Math.sign(splShift) });
      }
    }
    let maxCoherentRun = 0;
    let run = 0;
    for (let idx = 0; idx < improvedPts.length; idx++) {
      if (
        idx > 0 &&
        improvedPts[idx].sign === improvedPts[idx - 1].sign &&
        improvedPts[idx].x - improvedPts[idx - 1].x <= 2.5
      ) {
        run++;
      } else {
        run = 1;
      }
      if (run > maxCoherentRun) maxCoherentRun = run;
    }
    const improvesLocalBend =
      maxCoherentRun >= 2 &&
      splineHuber < linHuber - Math.max(0.18, laneLen * 0.00022);

    if (
      maxDevFromLin >= minSplineDev &&
      maxDevFromFlat <= maxAllowedShift &&
      maxStepDiff <= maxAllowedSlope &&
      (improvesHuber || improvesMed || improvesLocalBend)
    ) {
      return { laneY: splineY, isCurved: true };
    }
  }

  // Accept linear tilt when meaningfully better than flat
  if (
    Math.abs(linC1) >= minCurveAmp &&
    Math.abs(linC1) <= maxAllowedShift &&
    linHuber < 0.80 * flatHuber &&
    flatHuber - linHuber >= Math.max(1.0, laneLen * 0.0015)
  ) {
    return { laneY: linLaneY, isCurved: true };
  }

  return { laneY: flatLaneY, isCurved: false };
}

interface StraightPencilLine {
  a: number;
  b: number;
  inlierFrac: number;
  maxHalfW: number;
  graphiteConfirmed: boolean;
}

/**
 * Detects a razor-thin, ruler-straight graphite pencil line (e.g. 9.5/10.5 cm target line)
 * across the outer ruler zone [78% .. hi] of dark-polarity channels (UV254/White).
 * Uses 3 independent physical signatures:
 *   1. Razor-sharp narrow V-trough cross-section (FWHM <= 0.8% of laneLen, strong bilateral drop),
 *   2. Ruler-straight linear geometry across >= 65% of columns and all 3 thirds (median residual <= 1.2 px),
 *   3. Cross-channel graphite optics (White sharp dark line OR UV366 negative dark dip — graphite
 *      absorbs UV366 and never glows brightly like a real fluorescent solvent front).
 */
function detectStraightPencilLine(
  channels: CurvedFrontChannelInput[],
  referenceChannels: CurvedFrontChannelInput[] | undefined,
  activeCols: number[],
  colToLaneX: (origCol: number) => number,
  lo: number,
  hi: number,
  minLen: number,
  numLanes: number
): StraightPencilLine | null {
  const darkChannels = channels.filter((ch) => ch.sign < 0);
  if (!darkChannels.length || activeCols.length < 4) return null;

  // Scale ruler-line width to native camera resolution (on a 20 cm plate at 3280 px, a 0.5-0.7 mm
  // graphite pencil line is ~6-10 px FWHM; a blunt wooden pencil is up to ~13 px FWHM, whereas a
  // real capillary solvent front band is typically ~20-65 px wide).
  const pencilLo = Math.max(lo + 4, Math.floor(minLen * 0.78));
  const maxHalfW = Math.max(3, Math.round(minLen * 0.0085));
  const maxFwhmConfirmed = Math.max(6, Math.round(minLen * 0.013));
  const maxFwhmUnconfirmed = Math.max(5, Math.round(minLen * 0.0105));
  const searchHi = Math.min(hi + Math.max(4, Math.round(minLen * 0.006)), minLen - 4);
  if (searchHi <= pencilLo + 4) return null;

  const numActive = activeCols.length;
  const buf = new Float64Array(24);
  const medRange = (p: number[], sIdx: number, eIdx: number): number => {
    const a = Math.max(0, sIdx);
    const b = Math.min(p.length - 1, eIdx);
    if (b < a) return p[Math.max(0, Math.min(p.length - 1, a))];
    let k = 0;
    for (let idx = a; idx <= b && k < buf.length; idx++) buf[k++] = p[idx];
    return medianOfSorted(buf, k);
  };

  const allRefChannels = referenceChannels && referenceChannels.length > channels.length ? referenceChannels : channels;
  const detectDarkChannels = allRefChannels.filter((ch) => ch.sign < 0);

  // Gather razor-thin bilateral dark-trough peaks per column across dark channels (UV254/White)
  const colPeaks: Array<
    Array<{ y: number; depth: number; fwhm: number; fromWhite: boolean; fromUv254: boolean }>
  > = Array.from({ length: numActive }, () => []);

  for (const ch of detectDarkChannels) {
    const isWhite = ch.channel === 'White';
    const isUv254 = ch.channel === 'UV254';
    for (let aIdx = 0; aIdx < numActive; aIdx++) {
      const col = activeCols[aIdx];
      const m = ch.metrics?.[col];
      if (m?.offPlate || m?.borderStraddle) continue;
      const p = ch.profiles[col];
      if (!p || p.length < minLen || !isProfileOnPlate(p, ch.sign)) continue;

      // Estimate per-column noise from 2nd differences
      const nD2 = Math.min(120, Math.max(10, searchHi - pencilLo));
      const d2 = new Float64Array(nD2);
      let d2Cnt = 0;
      const stepD2 = Math.max(1, Math.floor((searchHi - pencilLo) / nD2));
      for (let y = pencilLo + 1; y < searchHi && d2Cnt < nD2; y += stepD2) {
        d2[d2Cnt++] = Math.abs(p[y + 1] - 2 * p[y] + p[y - 1]);
      }
      const sigmaCol = Math.max(0.7, 1.4826 * medianOfSorted(d2, d2Cnt) * 0.408);
      const minDrop = Math.max(8, 4.5 * sigmaCol);
      const shSpan = Math.max(4, Math.round(minLen * 0.006));

      const localCands: Array<{ y: number; depth: number; fwhm: number }> = [];
      for (let y = pencilLo; y <= searchHi; y++) {
        // Local dark minimum
        if (p[y] > p[y - 1] || p[y] > p[y + 1]) continue;
        const shL = medRange(p, y - maxHalfW - shSpan, y - maxHalfW);
        const shR = medRange(p, y + maxHalfW, y + maxHalfW + shSpan);
        const dropL = shL - p[y];
        const dropR = shR - p[y];
        const minSide = Math.min(dropL, dropR);
        const maxSide = Math.max(dropL, dropR);
        if (minSide < minDrop || minSide < 0.35 * maxSide) continue;

        // Verify narrow ruler-line FWHM (0.3-0.85 mm graphite stroke, never a broad solvent band)
        const halfThr = Math.min(shL, shR) - 0.5 * minSide;
        let wL = 0;
        while (wL <= maxFwhmConfirmed && y - wL - 1 >= 0 && p[y - wL - 1] <= halfThr) wL++;
        let wR = 0;
        while (wR <= maxFwhmConfirmed && y + wR + 1 < minLen && p[y + wR + 1] <= halfThr) wR++;
        const fwhm = wL + wR + 1;
        if (fwhm > maxFwhmConfirmed) continue;

        localCands.push({ y, depth: minSide, fwhm });
      }
      // Prefer narrowest, deepest dark troughs first so a razor-sharp pencil line beats any nearby band
      localCands.sort((u, v) => v.depth / (v.fwhm + 2) - u.depth / (u.fwhm + 2));
      const kept: Array<{ y: number; depth: number; fwhm: number }> = [];
      for (const c of localCands) {
        if (kept.some((k) => Math.abs(k.y - c.y) < Math.max(7, maxHalfW + 2))) continue;
        kept.push(c);
        const existing = colPeaks[aIdx].find((pk) => Math.abs(pk.y - c.y) <= 2);
        if (existing) {
          existing.depth = Math.max(existing.depth, c.depth);
          existing.fwhm = Math.min(existing.fwhm, c.fwhm);
          existing.fromWhite = existing.fromWhite || isWhite;
          existing.fromUv254 = existing.fromUv254 || isUv254;
        } else {
          colPeaks[aIdx].push({
            y: c.y,
            depth: c.depth,
            fwhm: c.fwhm,
            fromWhite: isWhite,
            fromUv254: isUv254,
          });
        }
        if (kept.length >= 2) break;
      }
    }
  }

  // Fit a ruler-straight line y(x) = a + b * x using deterministic pair consensus across well-separated columns
  const flatPts: Array<{ aIdx: number; x: number; y: number; depth: number; fwhm: number }> = [];
  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const x = colToLaneX(activeCols[aIdx]);
    for (const pk of colPeaks[aIdx]) {
      flatPts.push({ aIdx, x, y: pk.y, depth: pk.depth, fwhm: pk.fwhm });
    }
  }
  if (flatPts.length < Math.max(4, Math.ceil(numActive * 0.65))) return null;

  const maxSlope = (minLen * 0.045) / Math.max(1, numLanes - 1);
  const inlierTol = Math.max(2.2, minLen * 0.003);
  const thirdTot = [0, 0, 0];
  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    thirdTot[Math.min(2, Math.floor((aIdx * 3) / numActive))]++;
  }

  let bestLine: {
    a: number;
    b: number;
    inliers: Array<{ aIdx: number; x: number; y: number }>;
    score: number;
  } | null = null;

  // Deterministic pair sampling from left-half and right-half peaks for fast exact ruler fit
  const rawLeft = flatPts.filter((p) => p.aIdx < Math.ceil(numActive * 0.45));
  const rawRight = flatPts.filter((p) => p.aIdx >= Math.floor(numActive * 0.55));
  const leftStep = Math.max(1, Math.ceil(rawLeft.length / 22));
  const rightStep = Math.max(1, Math.ceil(rawRight.length / 22));
  const leftPts = leftStep > 1 ? rawLeft.filter((_, idx) => idx % leftStep === 0) : rawLeft;
  const rightPts = rightStep > 1 ? rawRight.filter((_, idx) => idx % rightStep === 0) : rawRight;
  for (let i = 0; i < leftPts.length; i++) {
    const p1 = leftPts[i];
    for (let j = 0; j < rightPts.length; j++) {
      const p2 = rightPts[j];
      const dx = p2.x - p1.x;
      if (Math.abs(dx) < Math.max(2, (numLanes - 1) * 0.25)) continue;
      const b = (p2.y - p1.y) / dx;
      if (Math.abs(b) > maxSlope) continue;
      const a = p1.y - b * p1.x;

      const inliers: Array<{ aIdx: number; x: number; y: number }> = [];
      let sumDepth = 0;
      let sumFwhm = 0;
      let whiteHits = 0;
      let sumY = 0;
      for (let aIdx = 0; aIdx < numActive; aIdx++) {
        const pks = colPeaks[aIdx];
        if (!pks.length) continue;
        const x = colToLaneX(activeCols[aIdx]);
        const pred = a + b * x;
        let bestPk: { y: number; depth: number; fwhm: number; fromWhite: boolean } | null = null;
        let bestErr = inlierTol;
        let hasWhite = false;
        for (const pk of pks) {
          const err = Math.abs(pk.y - pred);
          if (err <= bestErr) {
            bestErr = err;
            bestPk = pk;
          }
          if (pk.fromWhite && err <= inlierTol + 1.2) hasWhite = true;
        }
        if (bestPk) {
          inliers.push({ aIdx, x, y: bestPk.y });
          sumDepth += Math.min(60, bestPk.depth);
          sumFwhm += bestPk.fwhm;
          sumY += bestPk.y;
          if (hasWhite) whiteHits++;
        }
      }
      if (inliers.length < Math.max(4, Math.ceil(numActive * 0.55))) continue;
      const meanFwhm = sumFwhm / inliers.length;
      const meanY = sumY / inliers.length;
      // Strongly prefer full-width, White-confirmed, razor-thin, outermost ruler lines
      const sc =
        inliers.length * 100 +
        whiteHits * 60 -
        meanFwhm * 18 +
        (meanY / minLen) * 20 +
        sumDepth * 0.05;
      if (!bestLine || sc > bestLine.score) {
        bestLine = { a, b, inliers, score: sc };
      }
    }
  }

  if (!bestLine) return null;

  // Refine line via ordinary least squares on inliers and re-evaluate tight residuals
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const pt of bestLine.inliers) {
    sx += pt.x;
    sy += pt.y;
    sxx += pt.x * pt.x;
    sxy += pt.x * pt.y;
  }
  const mCnt = bestLine.inliers.length;
  const denom = mCnt * sxx - sx * sx;
  const refB = Math.abs(denom) > 1e-6 ? (mCnt * sxy - sx * sy) / denom : bestLine.b;
  const refA = (sy - refB * sx) / Math.max(1, mCnt);

  const thirdIn = [0, 0, 0];
  const residuals: number[] = [];
  const fwhmVals: number[] = [];
  let whiteInliers = 0;
  let uv254Inliers = 0;
  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const pks = colPeaks[aIdx];
    if (!pks.length) continue;
    const x = colToLaneX(activeCols[aIdx]);
    const pred = refA + refB * x;
    let bestErr = inlierTol;
    let bestFwhm = maxFwhmConfirmed;
    let matched = false;
    let matchedWhite = false;
    let matchedUv254 = false;
    for (const pk of pks) {
      const err = Math.abs(pk.y - pred);
      if (err <= bestErr) {
        bestErr = err;
        bestFwhm = pk.fwhm;
        matched = true;
      }
      if (pk.fromWhite && err <= inlierTol + 1.2) matchedWhite = true;
      if (pk.fromUv254 && err <= inlierTol + 1.2) matchedUv254 = true;
    }
    if (matched) {
      thirdIn[Math.min(2, Math.floor((aIdx * 3) / numActive))]++;
      residuals.push(bestErr);
      fwhmVals.push(bestFwhm);
    }
    if (matchedWhite) whiteInliers++;
    if (matchedUv254) uv254Inliers++;
  }

  const inlierFrac = residuals.length / numActive;
  const allThirdsOk = thirdTot.every((tot, t) => tot === 0 || thirdIn[t] / tot >= 0.50);
  if (inlierFrac < 0.65 || !allThirdsOk || residuals.length < 4) return null;

  residuals.sort((u, v) => u - v);
  const medRes = residuals[residuals.length >> 1];
  if (medRes > Math.max(1.25, minLen * 0.0018)) return null;

  fwhmVals.sort((u, v) => u - v);
  const medFwhm = fwhmVals[fwhmVals.length >> 1];

  // Cross-channel graphite confirmation using all available sibling channels:
  // (a) White channel shows the exact same razor-thin dark ruler line (especially alongside UV254/UV366), OR
  // (b) UV366 shows a consistent negative (dark) dip along the line (graphite blocks UV366 and never glows).
  const hasUvRef = allRefChannels.some((ch) => ch.channel === 'UV254' || ch.channel === 'UV366');
  let graphiteConfirmed =
    (whiteInliers / numActive >= 0.50 && hasUvRef) ||
    (whiteInliers / numActive >= 0.55 && uv254Inliers / numActive >= 0.50);
  if (!graphiteConfirmed) {
    const uv366Ch = allRefChannels.find((ch) => ch.sign > 0);
    if (uv366Ch) {
      const uv366Dips: number[] = [];
      const shSpan = Math.max(4, Math.round(minLen * 0.006));
      for (let aIdx = 0; aIdx < numActive; aIdx++) {
        const col = activeCols[aIdx];
        const p = uv366Ch.profiles[col];
        if (!p || p.length < minLen) continue;
        const yp = Math.round(refA + refB * colToLaneX(col));
        if (yp - maxHalfW - shSpan < 0 || yp + 3 >= minLen) continue;
        let minVal = p[yp];
        for (let dy = -3; dy <= 3; dy++) {
          const idx = yp + dy;
          if (idx >= 0 && idx < minLen && p[idx] < minVal) minVal = p[idx];
        }
        const shL = medRange(p, yp - maxHalfW - shSpan, yp - maxHalfW);
        const shR = medRange(p, yp + maxHalfW, yp + maxHalfW + shSpan);
        // Positive value means UV366 dipped DARKER than its shoulders at the pencil line
        uv366Dips.push(0.5 * (shL + shR) - minVal);
      }
      if (uv366Dips.length >= 4) {
        const negCnt = uv366Dips.filter((d) => d > 0.5).length;
        uv366Dips.sort((u, v) => u - v);
        const medDip = uv366Dips[uv366Dips.length >> 1];
        if (medDip >= 1.5 || (medDip >= 1.0 && negCnt / uv366Dips.length >= 0.65)) {
          graphiteConfirmed = true;
        }
      }
    }
  }

  // Without cross-channel graphite proof (White dark line or UV366 negative dip), require a razor-sharp
  // mechanical-pencil FWHM so a medium-width straight solvent front band is never misclassified.
  if (!graphiteConfirmed && medFwhm > maxFwhmUnconfirmed) return null;

  return { a: refA, b: refB, inlierFrac, maxHalfW, graphiteConfirmed };
}

/**
 * Surgically bridges across a detected straight graphite ruler pencil line on dark-polarity
 * profiles (and their 2D flank profiles if present), preserving adjacent faint solvent fronts.
 */
function erasePencilLineFromChannels(
  channels: CurvedFrontChannelInput[],
  pencil: StraightPencilLine,
  colToLaneX: (origCol: number) => number,
  minLen: number
): CurvedFrontChannelInput[] {
  const hw = pencil.maxHalfW;
  const shSpan = Math.max(4, Math.round(minLen * 0.006));
  const buf = new Float64Array(24);
  const medArr = (arr: ArrayLike<number>, sIdx: number, eIdx: number): number => {
    const a = Math.max(0, sIdx);
    const b = Math.min(arr.length - 1, eIdx);
    if (b < a) return arr[Math.max(0, Math.min(arr.length - 1, a))];
    let k = 0;
    for (let idx = a; idx <= b && k < buf.length; idx++) buf[k++] = arr[idx];
    return medianOfSorted(buf, k);
  };

  const eraseInPlace = (arr: number[] | Float32Array, yp: number): void => {
    const n = arr.length;
    if (yp - hw - shSpan < 0 || yp + 2 >= n) return;
    let yMin = yp;
    for (let dy = -3; dy <= 3; dy++) {
      const idx = yp + dy;
      if (idx >= 0 && idx < n && arr[idx] < arr[yMin]) yMin = idx;
    }
    const shL = medArr(arr, yMin - hw - shSpan, yMin - hw);
    const shR = medArr(arr, yMin + hw, yMin + hw + shSpan);
    const depthL = shL - arr[yMin];
    const depthR = shR - arr[yMin];
    if (depthL < 4 || depthR < 4) return;

    // Walk all the way out to the clean shoulder baseline (within ~1.5 gray levels of shL/shR)
    // so deep graphite troughs leave zero residual flat-bottomed trench after bridging.
    const tolL = Math.min(1.5, 0.03 * depthL);
    const tolR = Math.min(1.5, 0.03 * depthR);
    const maxSpan = Math.max(hw + shSpan + 2, Math.round(hw * 1.8) + 4);

    let yL = yMin - 1;
    const limL = Math.max(0, yMin - maxSpan);
    while (yL > limL && arr[yL] < shL - tolL) {
      // Stop at a local shoulder crest if an adjacent darker front sits immediately behind the pencil line
      if (yMin - yL >= hw && arr[yL] >= shL - 0.12 * depthL && yL > 1 && arr[yL - 1] < arr[yL] - 1.5) {
        break;
      }
      yL--;
    }

    let yR = yMin + 1;
    const limR = Math.min(n - 1, yMin + maxSpan);
    while (yR < limR && arr[yR] < shR - tolR) {
      if (yR - yMin >= hw && arr[yR] >= shR - 0.12 * depthR && yR + 1 < n && arr[yR + 1] < arr[yR] - 1.5) {
        break;
      }
      yR++;
    }

    if (yR - yL <= 1) return;
    // Anchor bridge endpoints to local shoulder medians when they didn't fully clear a deep tail
    const vL = Math.max(arr[yL], shL - tolL);
    const vR = Math.max(arr[yR], shR - tolR);
    const span = yR - yL;
    for (let k = yL + 1; k < yR; k++) {
      arr[k] = vL + ((vR - vL) * (k - yL)) / span;
    }
  };

  return channels.map((ch) => {
    if (ch.sign >= 0) return ch;
    const profiles = ch.profiles.map((prof, col) => {
      if (!prof || prof.length < minLen) return prof;
      const copy = prof.slice();
      const yp = Math.round(pencil.a + pencil.b * colToLaneX(col));
      eraseInPlace(copy, yp);
      return copy;
    });
    const metrics = ch.metrics
      ? ch.metrics.map((m, col) => {
          if (!m || !m.flankProfile || m.flankProfile.length < minLen) return m;
          const flankCopy = new Float32Array(m.flankProfile);
          const yp = Math.round(pencil.a + pencil.b * colToLaneX(col));
          eraseInPlace(flankCopy, yp);
          return { ...m, flankProfile: flankCopy };
        })
      : undefined;
    return { ...ch, profiles, metrics };
  });
}

/**
 * 2D Curved Solvent-Front Seam Tracker:
 * Tracks a single continuous smooth curve y_front(x) across all columns (gutters or lanes)
 * simultaneously via dynamic programming, optionally using 2D horizontal-continuity strip
 * metrics (suppressing high-Rf spots while rewarding full-width meniscus lines) and fusing
 * evidence across multiple loaded channels (UV254 + UV366 + White). Fits a robust IRLS
 * penalized smoothing spline so flat-center + curled-edge aluminium plates, smiling/frowning
 * bows, and tilted fronts are tracked lane-by-lane.
 */
export function detectCurvedFrontSeam(
  channels: CurvedFrontChannelInput[],
  laneIds: number[],
  laneLen: number,
  options?: CurvedFrontSeamOptions
): CurvedFrontSeamResult {
  return detectCurvedFrontSeamCore(channels, laneIds, laneLen, options, 2);
}

function detectCurvedFrontSeamCore(
  channels: CurvedFrontChannelInput[],
  laneIds: number[],
  laneLen: number,
  options: CurvedFrontSeamOptions | undefined,
  pencilPassesLeft: number
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
  const hasDarkFrontCh = channels.some((ch) => ch.sign < 0);
  let hi = Math.min(minLen - 4, Math.floor(minLen * (hasDarkFrontCh ? 0.982 : 0.955)));

  const sortedIds = laneIds.slice().sort((a, b) => a - b);
  const numLanes = sortedIds.length;
  const colPositionsRef = channels.find(
    (c) => c.colPositions && c.colPositions.length >= numCols
  )?.colPositions;
  const colToLaneX = (origCol: number): number => {
    if (colPositionsRef && colPositionsRef[origCol] != null) {
      return Math.max(0, Math.min(numLanes - 1, colPositionsRef[origCol]));
    }
    return numCols > 1 ? (origCol * (numLanes - 1)) / (numCols - 1) : 0;
  };

  // Filter out off-plate pitch-black columns and glass/aluminium cut-edge straddling columns
  const activeCols: number[] = [];
  for (let col = 0; col < numCols; col++) {
    const anyOnPlate = channels.some((ch) => {
      const m = ch.metrics?.[col];
      if (m?.offPlate || m?.borderStraddle) return false;
      return isProfileOnPlate(ch.profiles[col], ch.sign);
    });
    if (anyOnPlate) activeCols.push(col);
  }
  if (activeCols.length < 4) return empty;

  // Clamp upper search ceiling strictly inside the physical top edge of the silica plate
  // and (for head-to-head dual-half plates) strictly inside the clean middle gap before the opposing half.
  let effEnd = minLen - 1;
  if (options?.maxFrontPos != null && options.maxFrontPos > lo + 8) {
    hi = Math.min(hi, Math.round(options.maxFrontPos));
  }
  if (options?.effEndPos != null && options.effEndPos > lo + 8) {
    effEnd = Math.min(effEnd, Math.round(options.effEndPos));
  }
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

  // Ruler pencil-line removal: if a razor-thin, ruler-straight dark line sits in the outer 78%..hi zone,
  // erase it (up to 2 parallel lines, e.g. 9.5 & 10.5 cm marks) and re-run front tracking whenever either
  // (a) White/UV366 confirms graphite optics or (b) erasing it reveals a genuine sustained band/step-backed
  // solvent front. Leaves thin hairline-meniscus-only plates (no sustained band behind them) untouched.
  if (pencilPassesLeft > 0 && hasDarkFrontCh) {
    const pencil = detectStraightPencilLine(
      channels,
      options?.referenceChannels,
      activeCols,
      colToLaneX,
      lo,
      hi,
      minLen,
      numLanes
    );
    if (pencil) {
      const cleanedChannels = erasePencilLineFromChannels(channels, pencil, colToLaneX, minLen);
      const nextOpts =
        options?.referenceChannels && options.referenceChannels.length > 0
          ? {
              ...options,
              referenceChannels: erasePencilLineFromChannels(
                options.referenceChannels,
                pencil,
                colToLaneX,
                minLen
              ),
            }
          : options;
      const cleanedRes = detectCurvedFrontSeamCore(
        cleanedChannels,
        laneIds,
        laneLen,
        nextOpts,
        pencilPassesLeft - 1
      );
      if (pencil.graphiteConfirmed || (cleanedRes.medianPos > 0 && cleanedRes.bandOrStepBacked)) {
        const medPencilPos = Math.round(pencil.a + pencil.b * (numLanes - 1) * 0.5);
        const prevSuppressed = cleanedRes.suppressedPencilPositions ?? [];
        return {
          ...cleanedRes,
          suppressedPencilPositions: [...prevSuppressed, medPencilPos],
        };
      }
    }
  }

  const H = hi - lo + 1;
  if (H <= 8) return empty;

  const numActive = activeCols.length;
  const hasUvChannel = channels.some((ch) => ch.channel === 'UV254' || ch.channel === 'UV366');
  // Build fused 2D SNR evidence map E[aIdx][yIdx] over active on-plate columns
  const E: Float32Array[] = Array.from({ length: numActive }, () => new Float32Array(H));
  const stepMap: Uint8Array[] = Array.from({ length: numActive }, () => new Uint8Array(H));

  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const col = activeCols[aIdx];
    const colChEntries: Array<{
      channel?: VisionChannelKey;
      snr: Float32Array;
      hasStep: Uint8Array;
      hasBand: Uint8Array;
      isThinPencilLike: Uint8Array;
    }> = [];
    for (const ch of channels) {
      const m = ch.metrics?.[col];
      if (m?.offPlate || m?.borderStraddle) continue;
      if (!isProfileOnPlate(ch.profiles[col], ch.sign)) continue;
      const { snr, hasStep, hasBand, isThinPencilLike } = computeFrontEvidenceStrip(
        ch.profiles[col],
        ch.sign,
        lo,
        hi,
        effEnd,
        m
      );
      // Guard UV366 bright top-edge chamber glare (> 95.5% of lane length)
      if (ch.sign > 0) {
        const uv366Hi = Math.floor(minLen * 0.955);
        for (let j = Math.max(0, uv366Hi - lo + 1); j < H; j++) {
          snr[j] = 0;
          hasStep[j] = 0;
          hasBand[j] = 0;
          isThinPencilLike[j] = 0;
        }
      }
      colChEntries.push({ channel: ch.channel, snr, hasStep, hasBand, isThinPencilLike });
      for (let j = 0; j < H; j++) {
        if (hasStep[j] || hasBand[j]) stepMap[aIdx][j] = 1;
      }
    }
    if (!colChEntries.length) continue;
    const dst = E[aIdx];
    if (colChEntries.length === 1) {
      dst.set(colChEntries[0].snr);
    } else {
      // Multi-channel White-light graphite pencil suppression:
      // If White light shows a razor-thin dark ridge (no sustained band, no wet/dry step) while a UV
      // channel is present, treat that pixel as a likely graphite pencil mark/handwriting stroke:
      // do not let White boost it, and mildly damp ridge-only UV hits at the exact same pixel.
      const whitePencilMask = hasUvChannel ? new Uint8Array(H) : null;
      if (whitePencilMask) {
        for (const entry of colChEntries) {
          if (entry.channel === 'White') {
            for (let j = 0; j < H; j++) {
              if (entry.isThinPencilLike[j] && entry.snr[j] >= 4.0) {
                whitePencilMask[j] = 1;
              }
            }
          }
        }
      }

      for (let j = 0; j < H; j++) {
        let maxV = 0;
        let sumV = 0;
        for (let k = 0; k < colChEntries.length; k++) {
          const e = colChEntries[k];
          let v = e.snr[j];
          if (whitePencilMask && whitePencilMask[j]) {
            if (e.channel === 'White' && e.isThinPencilLike[j]) {
              v *= 0.25;
            } else if (!e.hasBand[j] && !e.hasStep[j] && e.isThinPencilLike[j]) {
              v *= 0.60;
            }
          }
          if (v > maxV) maxV = v;
          sumV += Math.min(6, v);
        }
        // Best channel dominates; agreeing secondary channels reinforce weak fronts without drowning a clean channel
        dst[j] = maxV + 0.35 * Math.max(0, sumV - Math.min(6, maxV));
      }
    }
  }

  // Dynamic Programming seam solver over an arbitrary vertical slice [jStart..jEnd] of evidenceGrid
  const baseMaxStep = Math.max(2, Math.min(12, Math.round(minLen * 0.008)));
  const baseStepPenalty = 0.22 / Math.max(1, (baseMaxStep / 3) * (baseMaxStep / 3));
  const seamTol = Math.max(2, Math.round(minLen * 0.004));
  const curveTol = Math.max(5, Math.round(minLen * 0.012));

  const solveSeam = (
    dpGrid: Float32Array[],
    supportGrid: Float32Array[],
    jStart: number,
    jEnd: number,
    minColSnr: number,
    minMedSnr: number,
    minSupportFrac: number,
    minThirdFrac: number
  ): (CurvedFrontSeamResult & { laneY?: Float64Array }) => {
    const sliceH = jEnd - jStart + 1;
    if (sliceH <= 4) return empty;

    // Continuity-aware per-column DP gain: preserves full linear SNR sharpness on supported
    // columns (zero wave flattening) while penalizing missing-evidence columns so a 100%-coverage
    // continuous front outscores a 60%-coverage patchy spot row during dynamic programming.
    const colGain = (v: number): number => (v < minColSnr ? v - 1.8 * minColSnr : v);

    const dpPrev = new Float64Array(sliceH);
    const dpCurr = new Float64Array(sliceH);
    const backPtr = new Int16Array(numActive * sliceH);

    for (let u = 0; u < sliceH; u++) dpPrev[u] = colGain(dpGrid[0][jStart + u]);

    for (let aIdx = 1; aIdx < numActive; aIdx++) {
      const eCol = dpGrid[aIdx];
      const ptrOff = aIdx * sliceH;
      const dx = Math.max(
        1,
        Math.min(4, Math.abs(colToLaneX(activeCols[aIdx]) - colToLaneX(activeCols[aIdx - 1])))
      );
      const maxStep = Math.min(Math.round(minLen * 0.03), Math.round(baseMaxStep * dx));
      const stepPenalty = baseStepPenalty / dx;
      for (let u = 0; u < sliceH; u++) {
        const kLo = Math.max(0, u - maxStep);
        const kHi = Math.min(sliceH - 1, u + maxStep);
        let bestVal = -Infinity;
        let bestPrev = u;
        for (let k = kLo; k <= kHi; k++) {
          const dy = u - k;
          const val = dpPrev[k] - stepPenalty * dy * dy;
          if (val > bestVal) {
            bestVal = val;
            bestPrev = k;
          }
        }
        dpCurr[u] = bestVal + colGain(eCol[jStart + u]);
        backPtr[ptrOff + u] = bestPrev;
      }
      dpPrev.set(dpCurr);
    }

    let endU = 0;
    let bestTotal = -Infinity;
    for (let u = 0; u < sliceH; u++) {
      if (dpPrev[u] > bestTotal) {
        bestTotal = dpPrev[u];
        endU = u;
      }
    }

    const seamIdx = new Int32Array(numActive);
    seamIdx[numActive - 1] = jStart + endU;
    for (let aIdx = numActive - 1; aIdx >= 1; aIdx--) {
      seamIdx[aIdx - 1] = jStart + backPtr[aIdx * sliceH + (seamIdx[aIdx] - jStart)];
    }

    const supportPts: Array<{ x: number; y: number; w: number; third: number; snr: number }> = [];
    const thirdTot = [0, 0, 0];
    const thirdSup = [0, 0, 0];
    let stepBackedCols = 0;

    for (let aIdx = 0; aIdx < numActive; aIdx++) {
      const origCol = activeCols[aIdx];
      const third = Math.min(2, Math.floor((aIdx * 3) / numActive));
      thirdTot[third]++;
      const j0 = seamIdx[aIdx];
      let localPeakSnr = supportGrid[aIdx][j0];
      let localPeakJ = j0;
      let localStep = stepMap[aIdx][j0] > 0;
      for (let j = Math.max(jStart, j0 - seamTol); j <= Math.min(jEnd, j0 + seamTol); j++) {
        if (supportGrid[aIdx][j] > localPeakSnr) {
          localPeakSnr = supportGrid[aIdx][j];
          localPeakJ = j;
        }
        if (stepMap[aIdx][j] > 0) localStep = true;
      }
      if (localPeakSnr >= minColSnr) {
        thirdSup[third]++;
        if (localStep) stepBackedCols++;
        supportPts.push({
          x: colToLaneX(origCol),
          y: lo + localPeakJ,
          w: Math.min(10, localPeakSnr),
          third,
          snr: localPeakSnr,
        });
      }
    }

    const supportFrac = supportPts.length / numActive;
    const allThirds = thirdTot.every((tot, t) => tot === 0 || thirdSup[t] / tot >= minThirdFrac);
    if (supportFrac < minSupportFrac || !allThirds) return empty;

    const curve = fitSmoothFrontSpline(supportPts, numLanes, minLen);
    if (!curve) return empty;

    let curveSupport = 0;
    let curveStepCols = 0;
    const curveThirdSup = [0, 0, 0];
    const curveSnrs: number[] = [];

    for (let aIdx = 0; aIdx < numActive; aIdx++) {
      const origCol = activeCols[aIdx];
      const x = colToLaneX(origCol);
      const predY = Math.round(evalPiecewiseLinear(curve.laneY, x));
      const jCenter = predY - lo;
      const jLo = Math.max(jStart, jCenter - curveTol);
      const jHi = Math.min(jEnd, jCenter + curveTol);
      let maxSnr = 0;
      let hasLocalStep = false;
      for (let j = jLo; j <= jHi; j++) {
        if (supportGrid[aIdx][j] > maxSnr) maxSnr = supportGrid[aIdx][j];
        if (stepMap[aIdx][j] > 0) hasLocalStep = true;
      }
      if (maxSnr >= minColSnr) {
        curveSupport++;
        if (hasLocalStep) curveStepCols++;
        curveThirdSup[Math.min(2, Math.floor((aIdx * 3) / numActive))]++;
        curveSnrs.push(maxSnr);
      }
    }

    const curveFrac = curveSupport / numActive;
    const curveThirdsOk = thirdTot.every((tot, t) => tot === 0 || curveThirdSup[t] / tot >= minThirdFrac);
    if (curveFrac < minSupportFrac || !curveThirdsOk || curveSnrs.length < 3) return empty;

    curveSnrs.sort((a, b) => a - b);
    const medSnr = curveSnrs[curveSnrs.length >> 1];
    if (medSnr < minMedSnr) return empty;

    const byLane: Record<number, number> = {};
    const lanePositions: number[] = [];
    for (let i = 0; i < numLanes; i++) {
      const yPred = Math.round(Math.max(lo + jStart, Math.min(lo + jEnd, curve.laneY[i])));
      byLane[sortedIds[i]] = yPred;
      lanePositions.push(yPred);
    }
    lanePositions.sort((a, b) => a - b);
    const medianPos = lanePositions[lanePositions.length >> 1];

    const bandOrStepBacked = Math.max(stepBackedCols, curveStepCols) / numActive >= 0.45;
    const stepBonus = bandOrStepBacked ? 1.15 : 0.92;
    const score = medSnr * (0.3 + 0.7 * curveFrac) * stepBonus;

    return {
      medianPos,
      byLane,
      score,
      isCurved: curve.isCurved,
      bandOrStepBacked,
      laneY: curve.laneY,
    };
  };

  // Shift-aligned cross-plate median + 85%-coverage quantile stack verification for very light outer fronts:
  // Aligns all active columns onto `laneY`, checks BOTH the cross-plate median (cuts camera noise by ~sqrt(N))
  // AND the coverage quantile (p85 for dark UV254/White fronts, p15 for bright UV366 fronts), which stays clean
  // on any true plate-wide solvent front (~95-100% continuity) while rejecting patchy compound spot bands
  // and middle-gap handwriting (which always leave word/letter/margin gaps across >= 15-20% of columns).
  const verifyAlignedBandStack = (
    laneY: Float64Array,
    anchorPos: number
  ): { confirmed: boolean; stackSnr: number } => {
    const anchorIdx = Math.max(lo, Math.min(hi, Math.round(anchorPos)));
    const stackBuf = new Float64Array(numActive + 2);
    const checkTol = Math.max(4, Math.round(minLen * 0.008));
    let bestStackSnr = 0;

    for (const ch of channels) {
      if (ch.sign > 0 && anchorIdx > Math.floor(minLen * 0.955)) continue;
      const validCols: Array<{ prof: number[]; shift: number }> = [];
      for (let aIdx = 0; aIdx < numActive; aIdx++) {
        const origCol = activeCols[aIdx];
        const m = ch.metrics?.[origCol];
        if (m?.offPlate || m?.borderStraddle) continue;
        const prof = ch.profiles[origCol];
        if (!prof || prof.length < minLen || !isProfileOnPlate(prof, ch.sign)) continue;
        const predY = Math.round(evalPiecewiseLinear(laneY, colToLaneX(origCol)));
        validCols.push({ prof, shift: predY - anchorIdx });
      }
      if (validCols.length < 4) continue;

      const stackedMed = new Array<number>(minLen);
      const stackedCov = new Array<number>(minLen);
      const covQ = ch.sign < 0 ? 0.85 : 0.15;
      for (let y = 0; y < minLen; y++) {
        let cnt = 0;
        for (let k = 0; k < validCols.length; k++) {
          const sy = Math.max(0, Math.min(minLen - 1, y + validCols[k].shift));
          stackBuf[cnt++] = validCols[k].prof[sy];
        }
        const view = stackBuf.subarray(0, cnt);
        view.sort();
        stackedMed[y] = cnt & 1 ? view[cnt >> 1] : 0.5 * (view[(cnt >> 1) - 1] + view[cnt >> 1]);
        stackedCov[y] = view[Math.min(cnt - 1, Math.max(0, Math.round(covQ * (cnt - 1))))];
      }

      const stMed = computeFrontEvidenceStrip(stackedMed, ch.sign, lo, hi, effEnd);
      const stCov = computeFrontEvidenceStrip(stackedCov, ch.sign, lo, hi, effEnd);
      const jA = Math.max(0, anchorIdx - lo - checkTol);
      const jB = Math.min(H - 1, anchorIdx - lo + checkTol);
      let localMedSnr = 0;
      let localCovSnr = 0;
      for (let j = jA; j <= jB; j++) {
        if ((stMed.hasBand[j] || stMed.hasStep[j]) && !stMed.isThinPencilLike[j] && stMed.snr[j] > localMedSnr) {
          localMedSnr = stMed.snr[j];
        }
        if ((stCov.hasBand[j] || stCov.hasStep[j]) && !stCov.isThinPencilLike[j] && stCov.snr[j] > localCovSnr) {
          localCovSnr = stCov.snr[j];
        }
      }
      // Require BOTH the cross-plate median (>= 4.5 SNR) AND the 85%-coverage quantile (>= 3.0 SNR)
      // to confirm a sustained plate-wide band/step so patchy spot bands and handwriting are strictly rejected.
      if (localMedSnr >= 4.5 && localCovSnr >= 3.0 && localMedSnr > bestStackSnr) {
        bestStackSnr = localMedSnr;
      }
    }

    return { confirmed: bestStackSnr >= 4.5, stackSnr: bestStackSnr };
  };

  // Band/step-only evidence grids for outer-most real front promotion & faint-front rescue
  // (strictly zeros out thin ruler pencil lines where stepMap === 0).
  // `bandPooled` gently pools neighbor columns for smooth DP tracing across very light center lanes,
  // while `bandOnly` is used unblurred for column support counting so checkerboard spots never bleed across blanks.
  const buildBandGrids = (): { bandOnly: Float32Array[]; bandPooled: Float32Array[] } => {
    const bandOnly: Float32Array[] = Array.from({ length: numActive }, (_, aIdx) => {
      const dst = new Float32Array(H);
      const src = E[aIdx];
      const sm = stepMap[aIdx];
      for (let j = 0; j < H; j++) {
        if (sm[j] > 0) dst[j] = src[j];
      }
      return dst;
    });
    const bandPooled: Float32Array[] = Array.from({ length: numActive }, (_, aIdx) => {
      const dst = new Float32Array(H);
      const cur = bandOnly[aIdx];
      const prev = aIdx > 0 ? bandOnly[aIdx - 1] : cur;
      const next = aIdx < numActive - 1 ? bandOnly[aIdx + 1] : cur;
      for (let j = 0; j < H; j++) {
        dst[j] = 0.25 * Math.min(6, prev[j]) + 0.50 * cur[j] + 0.25 * Math.min(6, next[j]);
      }
      return dst;
    });
    return { bandOnly, bandPooled };
  };

  let chosen = solveSeam(E, E, 0, H - 1, 3.2, 4.2, 0.65, 0.55);
  const minOuterGap = Math.max(18, Math.round(minLen * 0.035));
  let bandGrids: { bandOnly: Float32Array[]; bandPooled: Float32Array[] } | null = null;

  // Chromatography physics: nothing can elute past the solvent front.
  // If a bright/dark high-Rf compound spot row won the primary pass, check strictly ahead of it
  // (still inside maxFrontPos and glassEdge) for a genuine continuous, non-pencil capillary front band.
  if (chosen.medianPos > 0) {
    for (let pass = 0; pass < 2; pass++) {
      const outerJStart = Math.round(chosen.medianPos - lo) + minOuterGap;
      if (outerJStart > H - 8) break;
      if (!bandGrids) bandGrids = buildBandGrids();
      const outerCand = solveSeam(bandGrids.bandPooled, bandGrids.bandOnly, outerJStart, H - 1, 2.0, 2.6, 0.50, 0.35);
      if (outerCand.medianPos <= 0 || !outerCand.laneY) break;
      const stackCheck = verifyAlignedBandStack(outerCand.laneY, outerCand.medianPos);
      if (!stackCheck.confirmed) break;
      chosen = {
        medianPos: outerCand.medianPos,
        byLane: outerCand.byLane,
        score: Math.max(outerCand.score, Math.min(12.5, stackCheck.stackSnr * 0.90)),
        isCurved: outerCand.isCurved,
        bandOrStepBacked: true,
        laneY: outerCand.laneY,
      };
    }
  } else {
    // Faint-front rescue on very light plates where single columns fall below 4.2 SNR but the
    // cross-plate aligned median + 70%-coverage stack reveals a crisp sustained capillary front band.
    bandGrids = buildBandGrids();
    const faintCand = solveSeam(bandGrids.bandPooled, bandGrids.bandOnly, 0, H - 1, 2.0, 2.6, 0.50, 0.35);
    if (faintCand.medianPos > 0 && faintCand.laneY) {
      const stackCheck = verifyAlignedBandStack(faintCand.laneY, faintCand.medianPos);
      if (stackCheck.confirmed) {
        chosen = {
          medianPos: faintCand.medianPos,
          byLane: faintCand.byLane,
          score: Math.max(faintCand.score, Math.min(11.0, stackCheck.stackSnr * 0.85)),
          isCurved: faintCand.isCurved,
          bandOrStepBacked: true,
          laneY: faintCand.laneY,
        };
      }
    }
  }

  if (chosen.medianPos <= 0) return empty;
  return {
    medianPos: chosen.medianPos,
    byLane: chosen.byLane,
    score: chosen.score,
    isCurved: chosen.isCurved,
    bandOrStepBacked: chosen.bandOrStepBacked,
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
      // Never cross-lane promote solvent-front meniscus artifacts or ultra-weak noise ghosts
      if (anchor.spot.rf >= 0.92) continue;
      if (typeof anchor.spot.confidence === 'number' && anchor.spot.confidence < 0.18) continue;
      const agreeingLanes = new Set<number>();
      let soloAgreeCount = 0;
      for (const other of allObs) {
        if (Math.abs(other.spot.rf - anchor.spot.rf) <= rfTol) {
          agreeingLanes.add(other.laneId);
          if (other.isSolo) soloAgreeCount++;
        }
      }
      // Require >= 1 genuine solo detection in the reagent group so correlated plate noise/bands
      // cannot bootstrap themselves solely from relaxed candidates.
      if (soloAgreeCount >= 1 && agreeingLanes.size >= minAgree) {
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
