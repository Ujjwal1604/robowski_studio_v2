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
    // on this half, while stopping strictly before the opposing half's front band.
    const safetyMargin = Math.max(4, Math.min(10, Math.round(gapW * 0.22)));
    const rawEffEnd = Math.min(laneLen - 2, bestGap.gapHi - 2);
    const rawMaxFront = Math.min(
      laneLen - 4,
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
    const bandDeepVal = winMedF(s, Math.max(0, i - bandInFar), Math.max(0, i - bandDeepStart), buf);
    const wetBg = winQuantF(s, Math.max(0, i - wetBackFar), Math.max(0, i - wetBackNear), cleanQ, buf);
    const nearDepthDry = sign * (bandNearVal - dryBg);
    const deepDepthDry = sign * (bandDeepVal - dryBg);
    const nearDepthWet = sign * (bandNearVal - wetBg);
    const deepDepthWet = sign * (bandDeepVal - wetBg);
    const edgeInIdx = Math.max(0, i - Math.max(1, bandInNear));
    const nearEdgeDepth = sign * (s[edgeInIdx] - dryBg);

    if (
      nearDepthDry > 5.0 &&
      deepDepthDry > 4.5 &&
      deepDepthDry >= 0.45 * nearDepthDry &&
      nearEdgeDepth >= 0.55 * Math.max(nearDepthDry, deepDepthDry) &&
      nearDepthWet > 4.0 &&
      deepDepthWet > 3.5
    ) {
      const bandDepthDry = Math.min(nearDepthDry, deepDepthDry);
      const bandDepthWet = Math.min(nearDepthWet, deepDepthWet);
      const justIn = winMeanF(s, Math.max(0, i - dryEdgeWin), Math.max(0, i - 1));
      const justOut = winMeanF(s, Math.min(topLim, i + 1), Math.min(topLim, i + dryEdgeWin));
      const localDrop = sign * (justIn - justOut);
      if (localDrop > 2.8 && Math.min(bandDepthDry, bandDepthWet) >= 0.28 * Math.max(bandDepthDry, bandDepthWet)) {
        const sustained = Math.min(bandDepthDry, bandDepthWet);
        // Pinpoint right at the transition slope (downweight if still deep inside flat band or far out in dry gap)
        const midTarget = 0.5 * (bandNearVal + dryBg);
        const halfSpan = Math.max(4, 0.5 * nearDepthDry);
        const slopeCentering = Math.max(0.25, 1 - 0.55 * Math.min(1.3, Math.abs(c - midTarget) / halfSpan));
        dryEdgeAmp = (0.55 * Math.min(sustained, localDrop) + 0.45 * Math.sqrt(sustained * localDrop)) * slopeCentering;
      }
    }
  }

  let stepAmp = 0;
  const effBgNearAfter = Math.min(bgNear, Math.max(3, topLim - i));
  if (i + effBgNearAfter <= topLim && i - bgNear >= 0) {
    const medAfter = winMedF(s, i + effBgNearAfter, Math.min(topLim, i + bgMid), buf);
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
  const dryEdgeWin = Math.max(2, Math.min(5, Math.round(n * 0.004)));
  const bandInNear = Math.max(2, Math.round(n * 0.002));
  const bandDeepStart = Math.max(4, Math.round(n * 0.006));
  const bandInFar = bandDeepStart + Math.max(3, Math.round(n * 0.005));
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
    const bandBacked = dryEdgeAmp >= Math.max(4.5, 3.2 * sigmaS);
    const stepBacked = stepAmp >= Math.max(1.0, 1.3 * sigmaS);
    const effectiveLine = Math.max(dryEdgeAmp * dryEdgeWeight, ridgeAmp, bandAmp * bandCenterWeight);
    const feat = effectiveLine + 0.65 * stepAmp;
    feats[i - lo] = feat;
    if (stepBacked) hasStep[i - lo] = 1;
    if (bandBacked) hasBand[i - lo] = 1;

    // A sharp thin dark ridge with neither a sustained front band behind it nor a wet/dry step
    // behaves like a dry graphite ruler pencil line or handwriting stroke.
    const thinPencil = !bandBacked && !stepBacked && ridgeAmp >= Math.max(4.0, 3.0 * sigmaS);
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

  // Dynamic Programming across active on-plate columns to find the optimal continuous front seam
  const baseMaxStep = Math.max(2, Math.min(12, Math.round(minLen * 0.008)));
  const baseStepPenalty = 0.22 / Math.max(1, (baseMaxStep / 3) * (baseMaxStep / 3));

  const dpPrev = new Float64Array(H);
  const dpCurr = new Float64Array(H);
  const backPtr = new Int16Array(numActive * H);

  for (let j = 0; j < H; j++) dpPrev[j] = E[0][j];

  for (let aIdx = 1; aIdx < numActive; aIdx++) {
    const eCol = E[aIdx];
    const ptrOff = aIdx * H;
    const dx = Math.max(
      1,
      Math.min(4, Math.abs(colToLaneX(activeCols[aIdx]) - colToLaneX(activeCols[aIdx - 1])))
    );
    const maxStep = Math.min(Math.round(minLen * 0.03), Math.round(baseMaxStep * dx));
    const stepPenalty = baseStepPenalty / dx;
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

  // Gather supported points along the seam in exact lane index coordinates x ∈ [0..numLanes-1]
  const supportPts: Array<{ x: number; y: number; w: number; third: number; snr: number }> = [];
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
        x: colToLaneX(origCol),
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

  const curve = fitSmoothFrontSpline(supportPts, numLanes, minLen);
  if (!curve) return empty;

  // Re-verify support along the smooth fitted curve itself (rejecting jagged paths through unrelated spots)
  const curveTol = Math.max(5, Math.round(minLen * 0.012));
  let curveSupport = 0;
  const curveThirdSup = [0, 0, 0];
  const curveSnrs: number[] = [];

  for (let aIdx = 0; aIdx < numActive; aIdx++) {
    const origCol = activeCols[aIdx];
    const x = colToLaneX(origCol);
    const predY = Math.round(evalPiecewiseLinear(curve.laneY, x));
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
  const byLane: Record<number, number> = {};
  const lanePositions: number[] = [];
  for (let i = 0; i < numLanes; i++) {
    const yPred = Math.round(Math.max(lo, Math.min(hi, curve.laneY[i])));
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
