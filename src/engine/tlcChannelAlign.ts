// Automatic multi-channel TLC plate image registration.
//
// Aligns secondary channel images (e.g. UV366, White) onto the canonical reference channel
// (UV254 when loaded, otherwise White, otherwise UV366) using:
//  1. High-resolution local-texture noise gating + bezel-bounded silica plate detection so bright
//     salt-and-pepper flat-field division margins (`uni_linint_corrected_*`) outside the glass plate
//     never bias alignment.
//  2. Polarity-invariant 2D feature maps (clean interior silica silhouette + Sobel edges +
//     step-edge-immune opposite-neighbor spot blobs).
//  3. Multi-hypothesis coarse-to-fine 2D normalized cross-correlation (NCC) combining direct
//     silica-plate bounding-box seeds, wide +/-22% translation search, and aspect-aware scale
//     refinement with sub-pixel parabolic interpolation.
//
// This eliminates cross-channel baseline/Rf offsets and false-color composite ghosting when
// channel photos have camera shifts, crop differences, or differing image dimensions/margins.

import { TlcChannelAlignment, TlcChannelKey, TlcImageEntry, TlcSet } from '../types';

export interface AlignRaster {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

const REG_WIDTH = 192;
const SAMPLE_WIDTH = 384;
const IDENTITY_EPS_SHIFT = 0.004;
const IDENTITY_EPS_SCALE = 0.008;

export function identityAlignment(refChannel: TlcChannelKey): TlcChannelAlignment {
  return { sx: 1, sy: 1, dx: 0, dy: 0, confidence: 1, refChannel };
}

export function isIdentityAlignment(a: TlcChannelAlignment | null | undefined): boolean {
  if (!a) return true;
  return (
    Math.abs(a.sx - 1) < 1e-4 &&
    Math.abs(a.sy - 1) < 1e-4 &&
    Math.abs(a.dx) < 1e-5 &&
    Math.abs(a.dy) < 1e-5
  );
}

/**
 * Picks the canonical reference channel & pixel dimensions for a TLC plate set.
 * Priority matches lane detection & rendering: UV254 -> White -> UV366.
 */
export function getReferenceChannel(set: TlcSet): TlcChannelKey | null {
  const imgs = set.imgs;
  if (!imgs) return null;
  if (imgs.UV254?.bmp || imgs.UV254?.floatRgb) return 'UV254';
  if (imgs.White?.bmp || imgs.White?.floatRgb) return 'White';
  if (imgs.UV366?.bmp || imgs.UV366?.floatRgb) return 'UV366';
  return null;
}

export function getImageEntrySize(entry: TlcImageEntry | undefined): { width: number; height: number } | null {
  if (!entry) return null;
  if (entry.bmp && entry.bmp.width > 0 && entry.bmp.height > 0) {
    return { width: entry.bmp.width, height: entry.bmp.height };
  }
  if (entry.floatRgb && entry.floatWidth && entry.floatHeight) {
    return { width: entry.floatWidth, height: entry.floatHeight };
  }
  return null;
}

export function getReferenceDimensions(
  set: TlcSet,
  fallbackKey?: TlcChannelKey
): { width: number; height: number; refChannel: TlcChannelKey } | null {
  const refKey = getReferenceChannel(set) ?? fallbackKey ?? null;
  if (!refKey) return null;
  const sz = getImageEntrySize(set.imgs?.[refKey]);
  if (!sz) return null;
  return { width: sz.width, height: sz.height, refChannel: refKey };
}

// ------------------------------------------------------------------ feature extraction & plate bounds

interface PlateBoundsNorm {
  left: number;
  right: number;
  top: number;
  bottom: number;
  hasLeft: boolean;
  hasRight: boolean;
  hasTop: boolean;
  hasBottom: boolean;
  valid: boolean;
}

function channelScalar(
  data: ArrayLike<number>,
  offset: number,
  key: TlcChannelKey
): number {
  const r = data[offset] ?? 0;
  const g = data[offset + 1] ?? 0;
  const b = data[offset + 2] ?? 0;
  if (key === 'UV254') return g;
  if (key === 'UV366') return 0.35 * r + 0.5 * g + 0.15 * b;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function channelPlateBrightness(
  data: ArrayLike<number>,
  offset: number,
  key: TlcChannelKey
): number {
  const r = data[offset] ?? 0;
  const g = data[offset + 1] ?? 0;
  const b = data[offset + 2] ?? 0;
  if (key === 'UV254') return g;
  if (key === 'UV366') return Math.max(b, 0.5 * g + 0.5 * b);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function smooth3x3(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      tmp[r + x] = 0.25 * src[r + xm] + 0.5 * src[r + x] + 0.25 * src[r + xp];
    }
  }
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = 0.25 * tmp[ym * w + x] + 0.5 * tmp[y * w + x] + 0.25 * tmp[yp * w + x];
    }
  }
  return out;
}

function quantile(arr: Float32Array, q: number): number {
  const n = arr.length;
  if (!n) return 1;
  const step = Math.max(1, Math.floor(n / 4096));
  const samp: number[] = [];
  for (let i = 0; i < n; i += step) samp.push(arr[i]);
  samp.sort((a, b) => a - b);
  return samp[Math.max(0, Math.min(samp.length - 1, Math.floor(q * (samp.length - 1))))];
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const copy = values.slice().sort((a, b) => a - b);
  return copy[Math.floor(copy.length * 0.5)];
}

/**
 * Downsamples an RGBA raster onto `(tw, th)` while simultaneously extracting:
 *  - `scalar`: channel intensity
 *  - `bright`: plate-presence brightness
 *  - `noise`: high-resolution pixel-to-pixel RGB jitter (exposes flat-field division noise
 *             outside the black bezel, which is 5-10x grainier than the smooth silica plate)
 *  - `neutralWhite`: fraction of bright neutral/lavender pixels (UV366 flat-field surround cue)
 */
function downsampleImageStats(
  img: AlignRaster,
  key: TlcChannelKey,
  tw: number,
  th: number
): {
  scalar: Float32Array;
  bright: Float32Array;
  noise: Float32Array;
  neutralWhite: Float32Array;
} {
  const n = tw * th;
  const scalar = new Float32Array(n);
  const bright = new Float32Array(n);
  const noise = new Float32Array(n);
  const neutralWhite = new Float32Array(n);
  const sw = img.width;
  const sh = img.height;
  const data = img.data;
  const sx = sw / tw;
  const sy = sh / th;

  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * sx)));
      let sSum = 0;
      let bSum = 0;
      let nSum = 0;
      let nwSum = 0;
      let cnt = 0;

      // Sample up to 4x4 pixels per output bin for O(1) speed even on full-res rasters
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));

      for (let yy = y0; yy < y1; yy += stepY) {
        const yPrev = yy > 0 ? yy - 1 : yy;
        const yNext = yy + 1 < sh ? yy + 1 : yy;
        for (let xx = x0; xx < x1; xx += stepX) {
          const xPrev = xx > 0 ? xx - 1 : xx;
          const xNext = xx + 1 < sw ? xx + 1 : xx;
          const o = (yy * sw + xx) * 4;
          const oL = (yy * sw + xPrev) * 4;
          const oR = (yy * sw + xNext) * 4;
          const oU = (yPrev * sw + xx) * 4;
          const oD = (yNext * sw + xx) * 4;
          const r = data[o] ?? 0;
          const g = data[o + 1] ?? 0;
          const b = data[o + 2] ?? 0;

          sSum += channelScalar(data, o, key);
          bSum += channelPlateBrightness(data, o, key);

          // Sign-reversing local oscillation (salt-and-pepper noise): strictly 0 on monotonic
          // plate edges and smooth spot slopes, large ONLY on high-frequency flat-field grain.
          const osc = (c: number, a: number, d: number): number => {
            const d1 = c - a;
            const d2 = c - d;
            return d1 * d2 > 0 ? Math.min(Math.abs(d1), Math.abs(d2)) : 0;
          };
          const jitter =
            (osc(r, data[oL] ?? r, data[oR] ?? r) +
              osc(g, data[oL + 1] ?? g, data[oR + 1] ?? g) +
              osc(b, data[oL + 2] ?? b, data[oR + 2] ?? b) +
              osc(r, data[oU] ?? r, data[oD] ?? r) +
              osc(g, data[oU + 1] ?? g, data[oD + 1] ?? g) +
              osc(b, data[oU + 2] ?? b, data[oD + 2] ?? b)) /
            6;
          nSum += jitter;

          // Neutral bright white/lavender surround cue (common in flat-fielded UV366 borders)
          if (r > 135 && g > 155 && b > 200 && b - r < 110) {
            nwSum += 1;
          }
          cnt++;
        }
      }
      const idx = y * tw + x;
      const inv = cnt > 0 ? 1 / cnt : 0;
      scalar[idx] = sSum * inv;
      bright[idx] = bSum * inv;
      noise[idx] = nSum * inv;
      neutralWhite[idx] = nwSum * inv;
    }
  }
  return { scalar, bright, noise, neutralWhite };
}

/**
 * Detects the clean interior silica plate bounding rectangle `(left, right, top, bottom)`
 * by scanning outward from the central plate interior until hitting either:
 *  - the dark camera bezel, OR
 *  - high-frequency salt-and-pepper flat-field division noise (`uni_linint_corrected_*` margins).
 */
function buildCleanPlateMaskAndBounds(
  stats: ReturnType<typeof downsampleImageStats>,
  key: TlcChannelKey,
  tw: number,
  th: number
): { plate: Float32Array; bounds: PlateBoundsNorm } {
  const { bright, noise, neutralWhite } = stats;

  // Estimate clean interior silica brightness and baseline noise from central 44% box
  const intBright: number[] = [];
  const intNoise: number[] = [];
  const xA = Math.floor(tw * 0.28);
  const xB = Math.ceil(tw * 0.72);
  const yA = Math.floor(th * 0.2);
  const yB = Math.ceil(th * 0.8);
  for (let y = yA; y < yB; y += 2) {
    if (y > th * 0.44 && y < th * 0.56) continue;
    for (let x = xA; x < xB; x += 2) {
      const idx = y * tw + x;
      intBright.push(bright[idx]);
      intNoise.push(noise[idx]);
    }
  }
  const bgBright = Math.max(80, medianOf(intBright) || 180);
  const bgNoise = medianOf(intNoise);
  // True camera bezel is dark (< 48); capping darkThresh prevents dark origin dots or strong
  // UV254/White spots from punching holes in the silica mask near the top/bottom plate border.
  const darkThresh = Math.max(22, Math.min(48, bgBright * 0.22));
  // Sign-reversing oscillation on flat-field division noise is 4x-10x higher than smooth silica
  // (~8-25 vs ~0-2 on silica), while strictly 0 on sharp monotonic plate edges and spot slopes.
  const noiseHard = Math.max(8, bgNoise * 3.5 + 5);
  const noiseSoft = Math.max(4, bgNoise * 2.2 + 2.5);

  const rawMask = new Float32Array(tw * th);
  for (let i = 0; i < rawMask.length; i++) {
    const bVal = bright[i];
    const nVal = noise[i];
    if (bVal < darkThresh) {
      rawMask[i] = 0;
      continue;
    }
    // Suppress bright salt-and-pepper flat-field division noise (all channels)
    let smoothWt = 1;
    if (nVal > noiseSoft) {
      smoothWt = Math.max(0, 1 - (nVal - noiseSoft) / Math.max(2, noiseHard - noiseSoft));
    }
    // On UV366, bright neutral/white/lavender surround with elevated noise is never silica
    if (key === 'UV366' && neutralWhite[i] > 0.35 && nVal > Math.max(3, bgNoise * 1.6 + 1.5)) {
      smoothWt *= 0.1;
    }
    const bScore = Math.min(1, Math.max(0, (bVal - darkThresh * 0.85) / Math.max(30, bgBright * 0.55)));
    rawMask[i] = bScore * smoothWt;
  }

  // Compute 1D interior silica support along columns and rows using the 75th percentile of rawMask
  // so dense rows of dark UV254 origin dots (which still have bright silica gutters between lanes)
  // never falsely trigger the plate-edge scan before the true camera bezel or noisy margin.
  const percentile75 = (vals: number[]): number => {
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))];
  };

  const colSupport = new Float32Array(tw);
  const yLo = Math.floor(th * 0.14);
  const yHi = Math.ceil(th * 0.86);
  const colTmp: number[] = [];
  for (let x = 0; x < tw; x++) {
    colTmp.length = 0;
    for (let y = yLo; y < yHi; y++) {
      if (y > th * 0.43 && y < th * 0.57) continue;
      colTmp.push(rawMask[y * tw + x]);
    }
    colSupport[x] = percentile75(colTmp);
  }

  const rowSupport = new Float32Array(th);
  const xLo = Math.floor(tw * 0.18);
  const xHi = Math.ceil(tw * 0.82);
  const rowTmp: number[] = [];
  for (let y = 0; y < th; y++) {
    rowTmp.length = 0;
    for (let x = xLo; x < xHi; x++) {
      rowTmp.push(rawMask[y * tw + x]);
    }
    rowSupport[y] = percentile75(rowTmp);
  }

  // Smooth 1D profiles slightly (3-tap) so single dark spots/labels never break a scan
  const smooth1d = (arr: Float32Array): Float32Array => {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const a = arr[Math.max(0, i - 1)];
      const b = arr[i];
      const c = arr[Math.min(arr.length - 1, i + 1)];
      out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
    }
    return out;
  };
  const colS = smooth1d(colSupport);

  const midColSup = medianOf(Array.from(colS.slice(Math.floor(tw * 0.25), Math.floor(tw * 0.75))));
  const edgeThresh = Math.max(0.28, midColSup * 0.5);

  // Scan outward from plate interior center for Left & Right edges
  const cx = Math.floor(tw * 0.5);
  let leftPx = 0;
  let hasLeft = false;
  for (let x = cx; x >= 0; x--) {
    if (colS[x] < edgeThresh) {
      leftPx = x + 1;
      hasLeft = true;
      break;
    }
  }
  let rightPx = tw - 1;
  let hasRight = false;
  for (let x = cx; x < tw; x++) {
    if (colS[x] < edgeThresh) {
      rightPx = x - 1;
      hasRight = true;
      break;
    }
  }

  // Recompute row support strictly inside [leftPx..rightPx] for razor-sharp Top & Bottom edges
  const rx0 = Math.max(0, Math.min(tw - 2, leftPx + Math.round((rightPx - leftPx) * 0.08)));
  const rx1 = Math.max(rx0 + 1, Math.min(tw - 1, rightPx - Math.round((rightPx - leftPx) * 0.08)));
  for (let y = 0; y < th; y++) {
    rowTmp.length = 0;
    for (let x = rx0; x <= rx1; x++) {
      rowTmp.push(rawMask[y * tw + x]);
    }
    rowSupport[y] = percentile75(rowTmp);
  }
  const rowS2 = smooth1d(rowSupport);

  // Scan outward from top-half interior (~25%) and bottom-half interior (~75%) so middle gap doesn't trigger
  let topStart = Math.floor(th * 0.25);
  while (topStart < Math.floor(th * 0.42) && rowS2[topStart] < edgeThresh) topStart++;
  let topPx = 0;
  let hasTop = false;
  for (let y = topStart; y >= 0; y--) {
    if (rowS2[y] < edgeThresh) {
      topPx = y + 1;
      hasTop = true;
      break;
    }
  }

  let botStart = Math.floor(th * 0.75);
  while (botStart > Math.floor(th * 0.58) && rowS2[botStart] < edgeThresh) botStart--;
  let botPx = th - 1;
  let hasBottom = false;
  for (let y = botStart; y < th; y++) {
    if (rowS2[y] < edgeThresh) {
      botPx = y - 1;
      hasBottom = true;
      break;
    }
  }

  const plateWFrac = (rightPx - leftPx + 1) / tw;
  const plateHFrac = (botPx - topPx + 1) / th;
  const valid =
    plateWFrac >= 0.42 &&
    plateHFrac >= 0.42 &&
    (hasLeft || hasRight || hasTop || hasBottom);

  // Zero out everything strictly outside the detected silica plate bounds (with 1-px soft margin)
  // so flat-field noise bands beyond the black bezel can NEVER leak into the registration map.
  if (valid) {
    const padX = 1;
    const padY = 1;
    const minX = hasLeft ? Math.max(0, leftPx - padX) : 0;
    const maxX = hasRight ? Math.min(tw - 1, rightPx + padX) : tw - 1;
    const minY = hasTop ? Math.max(0, topPx - padY) : 0;
    const maxY = hasBottom ? Math.min(th - 1, botPx + padY) : th - 1;
    for (let y = 0; y < th; y++) {
      const outsideY = y < minY || y > maxY;
      const rowOff = y * tw;
      for (let x = 0; x < tw; x++) {
        if (outsideY || x < minX || x > maxX) {
          rawMask[rowOff + x] = 0;
        }
      }
    }
  }

  // Refine sub-pixel boundary position using half-threshold crossing on colS / rowS2
  const refineLeft = (): number => {
    if (!hasLeft || leftPx <= 0) return 0;
    const a = colS[leftPx - 1];
    const b = colS[leftPx];
    const frac = b > a + 1e-4 ? Math.max(0, Math.min(1, (edgeThresh - a) / (b - a))) : 0.5;
    return (leftPx - 1 + frac) / tw;
  };
  const refineRight = (): number => {
    if (!hasRight || rightPx >= tw - 1) return 1;
    const a = colS[rightPx];
    const b = colS[rightPx + 1];
    const frac = a > b + 1e-4 ? Math.max(0, Math.min(1, (a - edgeThresh) / (a - b))) : 0.5;
    return (rightPx + frac) / tw;
  };
  const refineTop = (): number => {
    if (!hasTop || topPx <= 0) return 0;
    const a = rowS2[topPx - 1];
    const b = rowS2[topPx];
    const frac = b > a + 1e-4 ? Math.max(0, Math.min(1, (edgeThresh - a) / (b - a))) : 0.5;
    return (topPx - 1 + frac) / th;
  };
  const refineBottom = (): number => {
    if (!hasBottom || botPx >= th - 1) return 1;
    const a = rowS2[botPx];
    const b = rowS2[botPx + 1];
    const frac = a > b + 1e-4 ? Math.max(0, Math.min(1, (a - edgeThresh) / (a - b))) : 0.5;
    return (botPx + frac) / th;
  };

  return {
    plate: smooth3x3(rawMask, tw, th),
    bounds: {
      left: refineLeft(),
      right: refineRight(),
      top: refineTop(),
      bottom: refineBottom(),
      hasLeft,
      hasRight,
      hasTop,
      hasBottom,
      valid,
    },
  };
}

/**
 * Builds a polarity-invariant 2D registration feature map combining:
 *  - Clean bezel-bounded silica plate silhouette (with noisy flat-field margins stripped)
 *  - Sobel gradient magnitude (sharpens plate edges, middle gap, solvent fronts, and spot rims)
 *  - Step-edge-immune opposite-neighbor spot activity (captures origin dots & shared spots
 *    positively regardless of dark-on-bright UV254/White vs bright-on-dark UV366).
 */
function buildFeatureMap(
  img: AlignRaster,
  key: TlcChannelKey,
  tw: number,
  th: number
): { feat: Float32Array; bounds: PlateBoundsNorm } {
  const stats = downsampleImageStats(img, key, tw, th);
  const { plate, bounds } = buildCleanPlateMaskAndBounds(stats, key, tw, th);

  // Zero out scalar signal strictly outside the plate boundary (leaving a 3-px rim for plate-edge Sobel)
  const cleanScalar = new Float32Array(stats.scalar.length);
  const minX = bounds.valid && bounds.hasLeft ? Math.max(0, Math.floor(bounds.left * tw) - 3) : 0;
  const maxX = bounds.valid && bounds.hasRight ? Math.min(tw - 1, Math.ceil(bounds.right * tw) + 3) : tw - 1;
  const minY = bounds.valid && bounds.hasTop ? Math.max(0, Math.floor(bounds.top * th) - 3) : 0;
  const maxY = bounds.valid && bounds.hasBottom ? Math.min(th - 1, Math.ceil(bounds.bottom * th) + 3) : th - 1;

  for (let y = 0; y < th; y++) {
    const outY = y < minY || y > maxY;
    const rowOff = y * tw;
    for (let x = 0; x < tw; x++) {
      cleanScalar[rowOff + x] = outY || x < minX || x > maxX ? 0 : stats.scalar[rowOff + x];
    }
  }

  const sm = smooth3x3(cleanScalar, tw, th);
  const edge = new Float32Array(tw * th);
  const spot = new Float32Array(tw * th);
  const sign = key === 'UV366' ? 1 : -1;
  const rSmall = Math.max(2, Math.round(Math.min(tw, th) * 0.018));
  const rMed = Math.max(4, Math.round(Math.min(tw, th) * 0.036));

  for (let y = 1; y < th - 1; y++) {
    const r0 = (y - 1) * tw;
    const r1 = y * tw;
    const r2 = (y + 1) * tw;
    const ym1 = Math.max(0, y - rSmall) * tw;
    const yp1 = Math.min(th - 1, y + rSmall) * tw;
    const ym2 = Math.max(0, y - rMed) * tw;
    const yp2 = Math.min(th - 1, y + rMed) * tw;
    const inBoundsY = y >= minY && y <= maxY;
    for (let x = 1; x < tw - 1; x++) {
      const gx =
        -sm[r0 + x - 1] +
        sm[r0 + x + 1] -
        2 * sm[r1 + x - 1] +
        2 * sm[r1 + x + 1] -
        sm[r2 + x - 1] +
        sm[r2 + x + 1];
      const gy =
        -sm[r0 + x - 1] -
        2 * sm[r0 + x] -
        sm[r0 + x + 1] +
        sm[r2 + x - 1] +
        2 * sm[r2 + x] +
        sm[r2 + x + 1];
      const pgx =
        -plate[r0 + x - 1] +
        plate[r0 + x + 1] -
        2 * plate[r1 + x - 1] +
        2 * plate[r1 + x + 1] -
        plate[r2 + x - 1] +
        plate[r2 + x + 1];
      const pgy =
        -plate[r0 + x - 1] -
        2 * plate[r0 + x] -
        plate[r0 + x + 1] +
        plate[r2 + x - 1] +
        2 * plate[r2 + x] +
        plate[r2 + x + 1];

      const inBounds = inBoundsY && x >= minX && x <= maxX;
      edge[r1 + x] = inBounds ? Math.hypot(gx, gy) + 220 * Math.hypot(pgx, pgy) : 0;

      // Step-edge-immune opposite-neighbor blob detector at two radii:
      // Positive ONLY when the center pixel stands out relative to BOTH opposite sides
      const c = sm[r1 + x];
      const xl1 = Math.max(0, x - rSmall);
      const xr1 = Math.min(tw - 1, x + rSmall);
      const xl2 = Math.max(0, x - rMed);
      const xr2 = Math.min(tw - 1, x + rMed);

      const h1 = Math.min(sign * (c - sm[r1 + xl1]), sign * (c - sm[r1 + xr1]));
      const v1 = Math.min(sign * (c - sm[ym1 + x]), sign * (c - sm[yp1 + x]));
      const h2 = Math.min(sign * (c - sm[r1 + xl2]), sign * (c - sm[r1 + xr2]));
      const v2 = Math.min(sign * (c - sm[ym2 + x]), sign * (c - sm[yp2 + x]));

      const blob1 = Math.max(0, h1) + Math.max(0, v1);
      const blob2 = Math.max(0, h2) + Math.max(0, v2);
      // Strictly gate spot signal to pixels cleanly inside the silica plate
      const onPlateWt = plate[r1 + x] > 0.25 ? 1 : 0;
      spot[r1 + x] = onPlateWt * Math.max(blob1, 0.85 * blob2);
    }
  }

  const edgeScale = Math.max(1e-3, quantile(edge, 0.97));
  const spotScale = Math.max(1e-3, quantile(spot, 0.97));
  const feat = new Float32Array(tw * th);
  for (let i = 0; i < feat.length; i++) {
    const e = Math.min(1.5, edge[i] / edgeScale);
    const s = Math.min(1.5, spot[i] / spotScale);
    feat[i] = 0.45 * plate[i] + 0.35 * e + 0.2 * s;
  }
  return { feat, bounds };
}

// ------------------------------------------------------------------ 2D NCC registration

function downsampleFeature2x(
  src: Float32Array,
  w: number,
  h: number
): { data: Float32Array; w: number; h: number } {
  const nw = Math.max(16, Math.floor(w / 2));
  const nh = Math.max(16, Math.floor(h / 2));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.min(h - 1, y * 2);
    const sy1 = Math.min(h - 1, sy0 + 1);
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.min(w - 1, x * 2);
      const sx1 = Math.min(w - 1, sx0 + 1);
      out[y * nw + x] =
        0.25 *
        (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1]);
    }
  }
  return { data: smooth3x3(out, nw, nh), w: nw, h: nh };
}

function evalNcc(
  fRef: Float32Array,
  fSrc: Float32Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  dxPx: number,
  dyPx: number,
  stride: number
): number {
  const invSx = 1 / sx;
  const invSy = 1 / sy;
  // Keep full silica plate edges while trimming extreme 2% outer pixels
  const mx = Math.max(2, Math.round(w * 0.02));
  const my = Math.max(2, Math.round(h * 0.02));

  let n = 0;
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;

  for (let y = my; y < h - my; y += stride) {
    const syF = (y - dyPx) * invSy;
    if (syF < 1 || syF >= h - 2) continue;
    const y0 = Math.floor(syF);
    const fy = syF - y0;
    const wy0 = 1 - fy;
    const rowRef = y * w;
    const rowS0 = y0 * w;
    const rowS1 = (y0 + 1) * w;

    for (let x = mx; x < w - mx; x += stride) {
      const sxF = (x - dxPx) * invSx;
      if (sxF < 1 || sxF >= w - 2) continue;
      const x0 = Math.floor(sxF);
      const fx = sxF - x0;
      const wx0 = 1 - fx;

      const a = fRef[rowRef + x];
      const b =
        wy0 * (wx0 * fSrc[rowS0 + x0] + fx * fSrc[rowS0 + x0 + 1]) +
        fy * (wx0 * fSrc[rowS1 + x0] + fx * fSrc[rowS1 + x0 + 1]);

      sumA += a;
      sumB += b;
      sumAA += a * a;
      sumBB += b * b;
      sumAB += a * b;
      n++;
    }
  }

  const maxSamples = Math.ceil((w - 2 * mx) / stride) * Math.ceil((h - 2 * my) / stride);
  if (n < maxSamples * 0.55 || n < 64) return -1;

  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumAA / n - meanA * meanA;
  const varB = sumBB / n - meanB * meanB;
  if (varA <= 1e-8 || varB <= 1e-8) return 0;
  const cov = sumAB / n - meanA * meanB;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Estimates the 2D registration transform `(sx, sy, dx, dy)` mapping `srcImg` onto `refImg`.
 * Works on raw RGBA rasters (pure math, zero DOM dependency).
 */
export function estimateChannelAlignment(
  refImg: AlignRaster,
  refKey: TlcChannelKey,
  srcImg: AlignRaster,
  srcKey: TlcChannelKey
): TlcChannelAlignment {
  if (
    refKey === srcKey ||
    refImg.width < 16 ||
    refImg.height < 16 ||
    srcImg.width < 16 ||
    srcImg.height < 16
  ) {
    return identityAlignment(refKey);
  }

  const tw = Math.min(REG_WIDTH, refImg.width);
  const th = Math.max(64, Math.min(256, Math.round((tw * refImg.height) / refImg.width)));

  const { feat: fRef, bounds: refBounds } = buildFeatureMap(refImg, refKey, tw, th);
  const { feat: fSrc, bounds: srcBounds } = buildFeatureMap(srcImg, srcKey, tw, th);
  const cRef = downsampleFeature2x(fRef, tw, th);
  const cSrc = downsampleFeature2x(fSrc, tw, th);

  const idCorr = evalNcc(fRef, fSrc, tw, th, 1, 1, 0, 0, 1);

  // Physical camera aspect ratio factor: if two channel photos were cropped to different
  // pixel aspect ratios, a uniform physical zoom of the glass TLC plate satisfies
  // sx / sy ~= (srcW / srcH) / (refW / refH).
  const rawAspect = (srcImg.width / srcImg.height) / (refImg.width / refImg.height);
  const expectedAspect = Math.max(0.62, Math.min(1.65, rawAspect));
  const aspectDiffers = Math.abs(expectedAspect - 1) > 0.015;

  const MIN_SX = 0.6;
  const MAX_SX = 1.7;
  const MIN_SY = 0.72;
  const MAX_SY = 1.4;

  // Stage 1: Wide coarse translation grid over +/-22% on half-res smoothed pyramid
  const cMaxDx = Math.round(cRef.w * 0.22);
  const cMaxDy = Math.round(cRef.h * 0.22);
  const coarseHits: Array<{ dx: number; dy: number; corr: number }> = [];

  for (let dy = -cMaxDy; dy <= cMaxDy; dy += 2) {
    for (let dx = -cMaxDx; dx <= cMaxDx; dx += 2) {
      const c = evalNcc(cRef.data, cSrc.data, cRef.w, cRef.h, 1, 1, dx, dy, 1);
      if (c > 0.05) coarseHits.push({ dx: dx * 2, dy: dy * 2, corr: c });
    }
  }
  coarseHits.sort((a, b) => b.corr - a.corr);

  const transSeeds: Array<{ dx: number; dy: number }> = [{ dx: 0, dy: 0 }];
  for (const h of coarseHits) {
    if (transSeeds.every((s) => Math.hypot(s.dx - h.dx, s.dy - h.dy) >= 6)) {
      transSeeds.push({ dx: h.dx, dy: h.dy });
      if (transSeeds.length >= 5) break;
    }
  }

  // Stage 2: Fine 1-px pure-translation refinement around each seed at full resolution
  let bestSx = 1;
  let bestSy = 1;
  let bestDx = 0;
  let bestDy = 0;
  let bestCorr = idCorr;

  for (const seed of transSeeds) {
    let curDx = seed.dx;
    let curDy = seed.dy;
    let curCorr = evalNcc(fRef, fSrc, tw, th, 1, 1, curDx, curDy, 1);
    for (let dy = seed.dy - 4; dy <= seed.dy + 4; dy++) {
      for (let dx = seed.dx - 4; dx <= seed.dx + 4; dx++) {
        const c = evalNcc(fRef, fSrc, tw, th, 1, 1, dx, dy, 1);
        if (c > curCorr) {
          curCorr = c;
          curDx = dx;
          curDy = dy;
        }
      }
    }
    if (curCorr > bestCorr) {
      bestCorr = curCorr;
      bestDx = curDx;
      bestDy = curDy;
    }
  }

  const transCorr = bestCorr;
  const transDx = bestDx;
  const transDy = bestDy;

  // Stage 3: Multi-hypothesis affine-scale + translation candidates:
  //  (a) Direct analytical silica-plate bounding-box alignment (handles arbitrary asymmetric crops
  //      and large aspect-ratio differences immediately in one shot)
  //  (b) Aspect-preserving zoom + translation search around both plate-box center & pure-trans peak
  interface ScaleSeed {
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    fromBox?: boolean;
  }
  const scaleSeeds: ScaleSeed[] = [];

  let boxHasScaleChange = false;
  if (
    refBounds.valid &&
    srcBounds.valid &&
    refBounds.hasLeft &&
    refBounds.hasRight &&
    srcBounds.hasLeft &&
    srcBounds.hasRight &&
    refBounds.hasTop &&
    refBounds.hasBottom &&
    srcBounds.hasTop &&
    srcBounds.hasBottom
  ) {
    const refPW = Math.max(0.1, refBounds.right - refBounds.left);
    const refPH = Math.max(0.1, refBounds.bottom - refBounds.top);
    const srcPW = Math.max(0.1, srcBounds.right - srcBounds.left);
    const srcPH = Math.max(0.1, srcBounds.bottom - srcBounds.top);

    const sxBox = refPW / srcPW;
    const syBox = refPH / srcPH;
    if (sxBox >= MIN_SX && sxBox <= MAX_SX && syBox >= MIN_SY && syBox <= MAX_SY) {
      const dxBox = (refBounds.left - srcBounds.left * sxBox) * tw;
      const dyBox = (refBounds.top - srcBounds.top * syBox) * th;
      scaleSeeds.push({ sx: sxBox, sy: syBox, dx: dxBox, dy: dyBox, fromBox: true });

      // Also add physically aspect-locked zoom seed centered on plate centers
      const zMean = 0.5 * (syBox + sxBox / expectedAspect);
      const sxIso = zMean * expectedAspect;
      const syIso = zMean;
      if (sxIso >= MIN_SX && sxIso <= MAX_SX && syIso >= MIN_SY && syIso <= MAX_SY) {
        const refCx = 0.5 * (refBounds.left + refBounds.right);
        const refCy = 0.5 * (refBounds.top + refBounds.bottom);
        const srcCx = 0.5 * (srcBounds.left + srcBounds.right);
        const srcCy = 0.5 * (srcBounds.top + srcBounds.bottom);
        scaleSeeds.push({
          sx: sxIso,
          sy: syIso,
          dx: (refCx - srcCx * sxIso) * tw,
          dy: (refCy - srcCy * syIso) * th,
          fromBox: true,
        });
      }

      if (Math.abs(sxBox - 1) > 0.025 || Math.abs(syBox - 1) > 0.025) {
        boxHasScaleChange = true;
      }

      // Also add pure-translation plate-center seed in case translation search missed a large shift
      const refCx = 0.5 * (refBounds.left + refBounds.right);
      const refCy = 0.5 * (refBounds.top + refBounds.bottom);
      const srcCx = 0.5 * (srcBounds.left + srcBounds.right);
      const srcCy = 0.5 * (srcBounds.top + srcBounds.bottom);
      if (Math.abs(sxBox - 1) <= 0.03 && Math.abs(syBox - 1) <= 0.03) {
        const bDx = Math.round((refCx - srcCx) * tw);
        const bDy = Math.round((refCy - srcCy) * th);
        let curDx = bDx;
        let curDy = bDy;
        let curCorr = evalNcc(fRef, fSrc, tw, th, 1, 1, curDx, curDy, 1);
        for (let dy = bDy - 4; dy <= bDy + 4; dy++) {
          for (let dx = bDx - 4; dx <= bDx + 4; dx++) {
            const c = evalNcc(fRef, fSrc, tw, th, 1, 1, dx, dy, 1);
            if (c > curCorr) {
              curCorr = c;
              curDx = dx;
              curDy = dy;
            }
          }
        }
        if (curCorr > bestCorr) {
          bestCorr = curCorr;
          bestDx = curDx;
          bestDy = curDy;
        }
      }
    }
  }

  // Run scale search when pure translation isn't near-perfect, aspect differs, or plate-box sees scale diff
  if (bestCorr < 0.88 || aspectDiffers || boxHasScaleChange) {
    const ccx = cRef.w * 0.5;
    const ccy = cRef.h * 0.5;
    const baseCDx = transDx * 0.5;
    const baseCDy = transDy * 0.5;
    const baseCCorr = evalNcc(cRef.data, cSrc.data, cRef.w, cRef.h, 1, 1, baseCDx, baseCDy, 1);

    const scaleCands: Array<{ sx: number; sy: number; dx: number; dy: number; corr: number }> = [];
    const zooms = [0.82, 0.86, 0.9, 0.94, 0.97, 1.0, 1.03, 1.06, 1.1, 1.15, 1.2];
    const searchRad = aspectDiffers ? 10 : 7;

    for (const z of zooms) {
      const sx = z * expectedAspect;
      const sy = z;
      if (!aspectDiffers && z === 1.0) continue;
      if (sx < MIN_SX || sx > MAX_SX || sy < MIN_SY || sy > MAX_SY) continue;
      const predDx = baseCDx + ccx * (1 - sx);
      const predDy = baseCDy + ccy * (1 - sy);
      let bestForZ = { sx, sy, dx: predDx * 2, dy: predDy * 2, corr: -1 };
      for (let ddy = -searchRad; ddy <= searchRad; ddy += 2) {
        for (let ddx = -searchRad; ddx <= searchRad; ddx += 2) {
          const c = evalNcc(
            cRef.data,
            cSrc.data,
            cRef.w,
            cRef.h,
            sx,
            sy,
            predDx + ddx,
            predDy + ddy,
            1
          );
          if (c > bestForZ.corr) {
            bestForZ = {
              sx,
              sy,
              dx: (predDx + ddx) * 2,
              dy: (predDy + ddy) * 2,
              corr: c,
            };
          }
        }
      }
      if (bestForZ.corr > baseCCorr + 0.01) {
        scaleCands.push(bestForZ);
      }
    }

    scaleCands.sort((a, b) => b.corr - a.corr);
    let addedGrid = 0;
    for (const sc of scaleCands) {
      if (scaleSeeds.every((t) => Math.hypot((t.sx - sc.sx) * 10, (t.sy - sc.sy) * 10) >= 0.35)) {
        scaleSeeds.push({ sx: sc.sx, sy: sc.sy, dx: sc.dx, dy: sc.dy });
        addedGrid++;
        if (addedGrid >= 2) break;
      }
    }

    const cx = tw * 0.5;
    const cy = th * 0.5;

    for (const cand of scaleSeeds) {
      let rSx = cand.sx;
      let rSy = cand.sy;
      let rDx = Math.round(cand.dx);
      let rDy = Math.round(cand.dy);
      let rCorr = evalNcc(fRef, fSrc, tw, th, rSx, rSy, rDx, rDy, 1);

      const refineTrans = (rad: number, step: number) => {
        let bestLocalDx = rDx;
        let bestLocalDy = rDy;
        for (let dy = rDy - rad; dy <= rDy + rad; dy += step) {
          for (let dx = rDx - rad; dx <= rDx + rad; dx += step) {
            const c = evalNcc(fRef, fSrc, tw, th, rSx, rSy, dx, dy, 1);
            if (c > rCorr) {
              rCorr = c;
              bestLocalDx = dx;
              bestLocalDy = dy;
            }
          }
        }
        rDx = bestLocalDx;
        rDy = bestLocalDy;
      };

      const refineScale = (ds: number) => {
        const aspectStepX = ds * expectedAspect;
        for (const [dSx, dSy] of [
          [-aspectStepX, -ds],
          [aspectStepX, ds],
          [-ds, 0],
          [ds, 0],
          [0, -ds],
          [0, ds],
        ]) {
          const nSx = rSx + dSx;
          const nSy = rSy + dSy;
          if (nSx < MIN_SX || nSx > MAX_SX || nSy < MIN_SY || nSy > MAX_SY) continue;
          // Keep physical aspect ratio within +/-6% of expectedAspect
          if (Math.abs(nSx / nSy - expectedAspect) > 0.06 * expectedAspect) continue;
          const nDx = rDx - cx * dSx;
          const nDy = rDy - cy * dSy;
          const c = evalNcc(fRef, fSrc, tw, th, nSx, nSy, nDx, nDy, 1);
          if (c > rCorr + 1e-4) {
            rCorr = c;
            rSx = nSx;
            rSy = nSy;
            rDx = nDx;
            rDy = nDy;
          }
        }
      };

      refineTrans(5, 1);
      for (const ds of [0.02, 0.01, 0.005, 0.002]) {
        refineScale(ds);
        refineTrans(2, 1);
      }

      // Require clear full-res NCC gain over pure translation before applying non-unit scale
      // (smaller threshold when image aspect ratios or plate box sizes genuinely differ)
      const minGain = aspectDiffers || boxHasScaleChange ? 0.015 : 0.035;
      if (rCorr > transCorr + minGain && rCorr > bestCorr) {
        bestCorr = rCorr;
        bestSx = rSx;
        bestSy = rSy;
        bestDx = rDx;
        bestDy = rDy;
      }
    }
  }

  // Stage 4: Sub-pixel parabolic refinement on dx and dy
  const cXm = evalNcc(fRef, fSrc, tw, th, bestSx, bestSy, bestDx - 1, bestDy, 1);
  const cXp = evalNcc(fRef, fSrc, tw, th, bestSx, bestSy, bestDx + 1, bestDy, 1);
  const denomX = cXm - 2 * bestCorr + cXp;
  const subDx = denomX < -1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cXm - cXp)) / denomX)) : 0;

  const cYm = evalNcc(fRef, fSrc, tw, th, bestSx, bestSy, bestDx, bestDy - 1, 1);
  const cYp = evalNcc(fRef, fSrc, tw, th, bestSx, bestSy, bestDx, bestDy + 1, 1);
  const denomY = cYm - 2 * bestCorr + cYp;
  const subDy = denomY < -1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cYm - cYp)) / denomY)) : 0;

  const finalDx = (bestDx + subDx) / tw;
  const finalDy = (bestDy + subDy) / th;
  const finalSx = Math.abs(bestSx - 1) < IDENTITY_EPS_SCALE ? 1 : bestSx;
  const finalSy = Math.abs(bestSy - 1) < IDENTITY_EPS_SCALE ? 1 : bestSy;

  // Identity deadzone & confidence guard: never disturb already-registered images or apply noisy shifts
  const tinyMove =
    Math.abs(finalDx) < IDENTITY_EPS_SHIFT &&
    Math.abs(finalDy) < IDENTITY_EPS_SHIFT &&
    finalSx === 1 &&
    finalSy === 1;
  if (bestCorr < 0.22 || tinyMove || bestCorr < idCorr + 0.02) {
    return {
      sx: 1,
      sy: 1,
      dx: 0,
      dy: 0,
      confidence: Math.max(0, idCorr),
      refChannel: refKey,
    };
  }

  return {
    sx: Math.round(finalSx * 10000) / 10000,
    sy: Math.round(finalSy * 10000) / 10000,
    dx: Math.round(finalDx * 10000) / 10000,
    dy: Math.round(finalDy * 10000) / 10000,
    confidence: Math.round(bestCorr * 1000) / 1000,
    refChannel: refKey,
  };
}

// ------------------------------------------------------------------ cached browser integration

let regScratchCanvas: HTMLCanvasElement | null = null;

function rasterFromImageEntry(entry: TlcImageEntry, targetW: number): AlignRaster | null {
  if (entry.bmp && entry.bmp.width > 0 && entry.bmp.height > 0 && typeof document !== 'undefined') {
    const w = Math.min(targetW, entry.bmp.width);
    const h = Math.max(1, Math.round((entry.bmp.height * w) / entry.bmp.width));
    if (!regScratchCanvas) {
      regScratchCanvas = document.createElement('canvas');
    }
    regScratchCanvas.width = w;
    regScratchCanvas.height = h;
    const ctx = regScratchCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(entry.bmp, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  }
  if (entry.floatRgb && entry.floatWidth && entry.floatHeight) {
    const sw = entry.floatWidth;
    const sh = entry.floatHeight;
    const w = Math.min(targetW, sw);
    const h = Math.max(1, Math.round((sh * w) / sw));
    const rgba = new Uint8ClampedArray(w * h * 4);
    const sx = sw / w;
    const sy = sh / h;
    for (let y = 0; y < h; y++) {
      const yy = Math.min(sh - 1, Math.floor((y + 0.5) * sy));
      for (let x = 0; x < w; x++) {
        const xx = Math.min(sw - 1, Math.floor((x + 0.5) * sx));
        const so = (yy * sw + xx) * 3;
        const doff = (y * w + x) * 4;
        rgba[doff] = Math.max(0, Math.min(255, Math.round(entry.floatRgb[so] ?? 0)));
        rgba[doff + 1] = Math.max(0, Math.min(255, Math.round(entry.floatRgb[so + 1] ?? 0)));
        rgba[doff + 2] = Math.max(0, Math.min(255, Math.round(entry.floatRgb[so + 2] ?? 0)));
        rgba[doff + 3] = 255;
      }
    }
    return { data: rgba, width: w, height: h };
  }
  return null;
}

/**
 * Returns the cached (or freshly estimated) alignment transform mapping channel `key`
 * into the canonical reference channel's coordinate frame for `set`.
 */
export function getChannelAlignment(
  set: TlcSet,
  key: TlcChannelKey
): TlcChannelAlignment {
  const refKey = getReferenceChannel(set) ?? key;
  if (key === refKey) return identityAlignment(refKey);

  const refEntry = set.imgs?.[refKey];
  const srcEntry = set.imgs?.[key];
  const refSz = getImageEntrySize(refEntry);
  const srcSz = getImageEntrySize(srcEntry);
  if (!refEntry || !srcEntry || !refSz || !srcSz) {
    return identityAlignment(refKey);
  }

  const sig = `${refKey}:${refEntry.name}:${refSz.width}x${refSz.height}|${key}:${srcEntry.name}:${srcSz.width}x${srcSz.height}`;
  const cache: Record<string, { sig: string; align: TlcChannelAlignment }> =
    ((set as any)._channelAlignCache = (set as any)._channelAlignCache || {});
  if (cache[key]?.sig === sig) {
    return cache[key].align;
  }

  // Sample at SAMPLE_WIDTH (384px) so pixel-to-pixel flat-field division noise is preserved
  // for the noise gate before downsampling to REG_WIDTH (192px).
  const refRaster = rasterFromImageEntry(refEntry, SAMPLE_WIDTH);
  const srcRaster = rasterFromImageEntry(srcEntry, SAMPLE_WIDTH);
  const align =
    refRaster && srcRaster
      ? estimateChannelAlignment(refRaster, refKey, srcRaster, key)
      : identityAlignment(refKey);

  cache[key] = { sig, align };
  set.channelAlign = set.channelAlign || {};
  set.channelAlign[key] = align;
  return align;
}

/**
 * Computes the destination rectangle `(dx, dy, dw, dh)` for drawing a channel image
 * onto a reference-sized `(refW, refH)` canvas so it aligns pixel-for-pixel with the reference channel.
 */
export function getChannelDrawRect(
  set: TlcSet,
  key: TlcChannelKey,
  refW: number,
  refH: number
): { x: number; y: number; w: number; h: number; align: TlcChannelAlignment } {
  const align = getChannelAlignment(set, key);
  return {
    x: align.dx * refW,
    y: align.dy * refH,
    w: align.sx * refW,
    h: align.sy * refH,
    align,
  };
}

/**
 * Draws a channel bitmap/canvas into reference-channel coordinates `(0..refW, 0..refH)`
 * using its automatic multi-channel registration transform.
 */
export function drawAlignedChannelImage(
  ctx: CanvasRenderingContext2D,
  set: TlcSet,
  key: TlcChannelKey,
  source: CanvasImageSource,
  refW: number,
  refH: number
): TlcChannelAlignment {
  const { x, y, w, h, align } = getChannelDrawRect(set, key, refW, refH);
  ctx.drawImage(source, x, y, w, h);
  return align;
}

/** Stable cache key suffix capturing active multi-channel alignments for canvas caches. */
export function channelAlignCacheSuffix(set: TlcSet, keys: TlcChannelKey[]): string {
  return keys
    .map((k) => {
      const a = getChannelAlignment(set, k);
      return `${k}:${a.sx.toFixed(4)},${a.sy.toFixed(4)},${a.dx.toFixed(4)},${a.dy.toFixed(4)}`;
    })
    .join('|');
}
