// Robowski Studio - Merck TLC Explorer Lab Pipeline Integration
// Supports:
// 1. Lab PC filename detection (uni_linint_corrected_*, linint_corrected_*, corrected_*_EXP*)
// 2. Direct browser parsing of NumPy .npy float32/float64/uint8/uint16 radiance arrays (BGR -> RGB)
// 3. Unclipped float32 bilinear lane strip extraction (preserving >255 UV366 peaks & dark UV254 cores)
// 4. White-light faint-spot contrast enhancement (browser adaptation of saturate_white.py)
// 5. Curved/wandering-lane centerline tracking (browser adaptation of savgol_automiddle in get_lanes.py)

import type { TlcLane } from '../types';
import type { VisionChannelKey } from './tlcVision2d';

export const LAB_UNI_SCALE_FACTORS: Record<VisionChannelKey, number> = {
  White: 2100,
  UV254: 11000,
  UV366: 60000,
};

export const LAB_LININT_SCALE_FACTORS: Record<VisionChannelKey, number> = {
  White: 2300,
  UV254: 12000,
  UV366: 60000,
};

export interface LabFilenameMeta {
  isNpy: boolean;
  isPreFlatFielded: boolean;
  isLinearized: boolean;
  isUndistorted: boolean;
  detectedChannel: VisionChannelKey | null;
  exposureMs: number | null;
  scaleFactor: number | null;
}

/**
 * Inspects a TLC file name from the Merck TLC Explorer / autocapture.py pipeline.
 * - `uni_linint_corrected_*_<ch>.(png|npy)` -> already undistorted, CRF-linearized, AND flat-fielded
 * - `linint_corrected_*_<ch>.(png|npy)` -> undistorted & CRF-linearized (not yet flat-fielded)
 * - `corrected_*_EXP<ms>_<ch>.png` -> undistorted single exposure
 */
export function inspectLabTlcFilename(name: string): LabFilenameMeta {
  const clean = String(name || '').trim();
  const lower = clean.toLowerCase();
  const isNpy = lower.endsWith('.npy');
  const isPreFlatFielded = /(?:^|[\\/])uni_linint_corrected_/i.test(clean);
  const isLinearized = isPreFlatFielded || /(?:^|[\\/])linint_corrected_/i.test(clean);
  const isUndistorted = isLinearized || /(?:^|[\\/])corrected_/i.test(clean);

  let detectedChannel: VisionChannelKey | null = null;
  if (/(?:^|[^0-9])254(?:[^0-9]|$)|_uvc(?:[^a-z]|$)/i.test(clean)) {
    detectedChannel = 'UV254';
  } else if (/(?:^|[^0-9])36[56](?:[^0-9]|$)|uv.?3|_uva(?:[^a-z]|$)/i.test(clean)) {
    detectedChannel = 'UV366';
  } else if (/(?:^|[^a-z])(?:white|visible|vis)(?:[^a-z]|$)/i.test(clean)) {
    detectedChannel = 'White';
  }

  const expMatch = /_EXP(\d+)_/i.exec(clean);
  const exposureMs = expMatch ? parseInt(expMatch[1], 10) : null;

  let scaleFactor: number | null = null;
  if (detectedChannel) {
    if (isPreFlatFielded) {
      scaleFactor = LAB_UNI_SCALE_FACTORS[detectedChannel];
    } else if (isLinearized) {
      scaleFactor = LAB_LININT_SCALE_FACTORS[detectedChannel];
    }
  }

  return {
    isNpy,
    isPreFlatFielded,
    isLinearized,
    isUndistorted,
    detectedChannel,
    exposureMs,
    scaleFactor,
  };
}

// ---- NumPy .npy binary parser & encoder ----------------------------------------------------------

export type NpyTypedArray = Float32Array | Float64Array | Uint8Array | Uint16Array;

export interface ParsedNpyArray {
  dtype: '<f4' | '<f8' | '|u1' | '<u2';
  fortranOrder: boolean;
  shape: number[];
  data: NpyTypedArray;
}

/**
 * Parses a NumPy `.npy` v1.0 / v2.0 / v3.0 binary buffer into a typed array + shape.
 */
export function parseNpyBuffer(buffer: ArrayBuffer): ParsedNpyArray {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x93 ||
    bytes[1] !== 0x4e || // 'N'
    bytes[2] !== 0x55 || // 'U'
    bytes[3] !== 0x4d || // 'M'
    bytes[4] !== 0x50 || // 'P'
    bytes[5] !== 0x59    // 'Y'
  ) {
    throw new Error('Not a valid NumPy .npy file (missing \\x93NUMPY header).');
  }

  const major = bytes[6];
  const view = new DataView(buffer);
  let headerLen = 0;
  let headerOffset = 0;
  if (major === 1) {
    headerLen = view.getUint16(8, true);
    headerOffset = 10;
  } else if (major === 2 || major === 3) {
    headerLen = view.getUint32(8, true);
    headerOffset = 12;
  } else {
    throw new Error(`Unsupported .npy format version ${major}.`);
  }

  const dataOffset = headerOffset + headerLen;
  if (dataOffset > bytes.length) {
    throw new Error('Truncated .npy header.');
  }

  const headerText = new TextDecoder('latin1').decode(bytes.subarray(headerOffset, dataOffset));
  const descrMatch = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(headerText);
  const fortranMatch = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(headerText);
  const shapeMatch = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(headerText);

  if (!descrMatch || !shapeMatch) {
    throw new Error('Could not parse .npy header metadata (descr/shape).');
  }

  const rawDescr = descrMatch[1];
  const fortranOrder = fortranMatch ? fortranMatch[1] === 'True' : false;
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10));

  if (!shape.length || shape.some((d) => !Number.isFinite(d) || d <= 0)) {
    throw new Error(`Invalid .npy shape: (${shapeMatch[1]})`);
  }

  const totalElements = shape.reduce((a, b) => a * b, 1);
  const normalizedDescr = rawDescr === '=f4' ? '<f4' : rawDescr === '=f8' ? '<f8' : rawDescr === '=u2' ? '<u2' : rawDescr === 'u1' || rawDescr === '<u1' ? '|u1' : rawDescr;

  let elemBytes = 0;
  let dtype: ParsedNpyArray['dtype'];
  if (normalizedDescr === '<f4' || normalizedDescr === '>f4') {
    dtype = '<f4';
    elemBytes = 4;
  } else if (normalizedDescr === '<f8' || normalizedDescr === '>f8') {
    dtype = '<f8';
    elemBytes = 8;
  } else if (normalizedDescr === '|u1') {
    dtype = '|u1';
    elemBytes = 1;
  } else if (normalizedDescr === '<u2' || normalizedDescr === '>u2') {
    dtype = '<u2';
    elemBytes = 2;
  } else {
    throw new Error(`Unsupported .npy data type "${rawDescr}". Expected float32, float64, uint8, or uint16.`);
  }

  const neededBytes = totalElements * elemBytes;
  if (dataOffset + neededBytes > bytes.length) {
    throw new Error('Truncated .npy payload.');
  }

  const bigEndian = normalizedDescr.startsWith('>');
  let data: NpyTypedArray;

  if (dtype === '|u1') {
    data = new Uint8Array(buffer.slice(dataOffset, dataOffset + neededBytes));
  } else if (!bigEndian && dataOffset % elemBytes === 0) {
    // Fast aligned copy
    const slice = buffer.slice(dataOffset, dataOffset + neededBytes);
    data =
      dtype === '<f4'
        ? new Float32Array(slice)
        : dtype === '<f8'
        ? new Float64Array(slice)
        : new Uint16Array(slice);
  } else {
    // Unaligned or big-endian read
    if (dtype === '<f4') {
      const arr = new Float32Array(totalElements);
      for (let i = 0; i < totalElements; i++) arr[i] = view.getFloat32(dataOffset + i * 4, !bigEndian);
      data = arr;
    } else if (dtype === '<f8') {
      const arr = new Float64Array(totalElements);
      for (let i = 0; i < totalElements; i++) arr[i] = view.getFloat64(dataOffset + i * 8, !bigEndian);
      data = arr;
    } else {
      const arr = new Uint16Array(totalElements);
      for (let i = 0; i < totalElements; i++) arr[i] = view.getUint16(dataOffset + i * 2, !bigEndian);
      data = arr;
    }
  }

  return { dtype, fortranOrder, shape, data };
}

/**
 * Encodes a Float32Array + shape into a standard NumPy v1.0 `.npy` ArrayBuffer (useful for tests & exports).
 */
export function encodeNpyFloat32(data: Float32Array, shape: number[]): ArrayBuffer {
  const shapeStr = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shapeStr}), }`;
  const preambleLen = 10;
  const padNeeded = (64 - ((preambleLen + header.length + 1) % 64)) % 64;
  header = header + ' '.repeat(padNeeded) + '\n';

  const headerBytes = new TextEncoder().encode(header);
  const totalBytes = preambleLen + headerBytes.length + data.byteLength;
  const out = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(out);
  u8.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(out).setUint16(8, headerBytes.length, true);
  u8.set(headerBytes, preambleLen);
  u8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), preambleLen + headerBytes.length);
  return out;
}

export interface DecodedNpyImage {
  width: number;
  height: number;
  rgba8: Uint8ClampedArray;
  /** Unclipped interleaved RGB float32 scaled to ~0..255+ display radiance units */
  floatRgb: Float32Array;
  scaleFactorUsed: number;
  clippedPixelFraction: number;
}

/**
 * Converts a parsed `.npy` TLC image (OpenCV BGR `(H, W, 3)` float32 from `autocapture.py` /
 * `flatness_correction.py`, or 2D `(H, W)` grayscale) into both:
 *  - an 8-bit `rgba8` buffer for Canvas/ImageBitmap rendering
 *  - an unclipped `floatRgb` (RGB float32, scaled to ~0..255+ units) for high-dynamic-range densitometry
 */
export function npyToRgbaAndFloatRgb(
  npy: ParsedNpyArray,
  channelHint: VisionChannelKey | null = null,
  filename: string = '',
  assumeBgr: boolean = true
): DecodedNpyImage {
  const { shape, data, fortranOrder, dtype } = npy;
  if (shape.length !== 2 && shape.length !== 3) {
    throw new Error(`Expected a 2D (H, W) or 3D (H, W, C) .npy image, got shape (${shape.join(', ')}).`);
  }
  const height = shape[0];
  const width = shape[1];
  const channels = shape.length === 3 ? shape[2] : 1;
  if (channels !== 1 && channels !== 3 && channels !== 4) {
    throw new Error(`Unsupported channel count ${channels} in .npy image.`);
  }

  const meta = inspectLabTlcFilename(filename);
  const effChannel = channelHint || meta.detectedChannel;

  // Helper to index (y, x, c)
  const at = (y: number, x: number, c: number): number => {
    if (channels === 1) {
      return fortranOrder ? data[x * height + y] : data[y * width + x];
    }
    return fortranOrder
      ? data[(c * width + x) * height + y]
      : data[(y * width + x) * channels + c];
  };

  // Determine display radiance scale factor
  let scale = 1;
  if (dtype === '|u1') {
    scale = 1;
  } else if (dtype === '<u2') {
    scale = 255 / 65535;
  } else if (meta.scaleFactor != null) {
    scale = meta.scaleFactor;
  } else if (effChannel) {
    // Check if values are in lab linear radiance range (typically 0..0.25) vs already 0..255
    const sampleStepY = Math.max(1, Math.floor(height / 48));
    const sampleStepX = Math.max(1, Math.floor(width / 48));
    const samples: number[] = [];
    for (let y = Math.floor(height * 0.15); y < Math.ceil(height * 0.85); y += sampleStepY) {
      for (let x = Math.floor(width * 0.15); x < Math.ceil(width * 0.85); x += sampleStepX) {
        const v = at(y, x, channels >= 3 ? 1 : 0);
        if (Number.isFinite(v) && v > 0) samples.push(v);
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples.length ? samples[Math.floor(samples.length * 0.95)] : 0;
    if (p95 > 0 && p95 < 1.5) {
      scale = LAB_UNI_SCALE_FACTORS[effChannel];
    } else if (p95 > 260) {
      scale = 240 / p95;
    } else {
      scale = 1;
    }
  } else {
    // Unknown channel float array: scale 98th interior percentile to 235
    const sampleStepY = Math.max(1, Math.floor(height / 48));
    const sampleStepX = Math.max(1, Math.floor(width / 48));
    const samples: number[] = [];
    for (let y = Math.floor(height * 0.15); y < Math.ceil(height * 0.85); y += sampleStepY) {
      for (let x = Math.floor(width * 0.15); x < Math.ceil(width * 0.85); x += sampleStepX) {
        const v = at(y, x, 0);
        if (Number.isFinite(v) && v > 0) samples.push(v);
      }
    }
    samples.sort((a, b) => a - b);
    const p98 = samples.length ? samples[Math.floor(samples.length * 0.98)] : 1;
    scale = p98 > 0 && (p98 < 2 || p98 > 260) ? 235 / p98 : 1;
  }

  const nPx = width * height;
  const rgba8 = new Uint8ClampedArray(nPx * 4);
  const floatRgb = new Float32Array(nPx * 3);
  let clippedCount = 0;

  if (!fortranOrder && channels === 3) {
    // Fast path for standard OpenCV C-contiguous (H, W, 3) float32 BGR arrays
    const rIdx = assumeBgr ? 2 : 0;
    const gIdx = 1;
    const bIdx = assumeBgr ? 0 : 2;
    for (let i = 0; i < nPx; i++) {
      const sOff = i * 3;
      const d4 = i * 4;
      let r = data[sOff + rIdx] * scale;
      let g = data[sOff + gIdx] * scale;
      let b = data[sOff + bIdx] * scale;
      if (!Number.isFinite(r) || r < 0) r = 0;
      if (!Number.isFinite(g) || g < 0) g = 0;
      if (!Number.isFinite(b) || b < 0) b = 0;

      // Guard extreme tray-edge division spikes from target / (baseline + 1e-14)
      if (r > 2048) r = 2048;
      if (g > 2048) g = 2048;
      if (b > 2048) b = 2048;

      if (r > 255 || g > 255 || b > 255) clippedCount++;

      floatRgb[sOff] = r;
      floatRgb[sOff + 1] = g;
      floatRgb[sOff + 2] = b;

      rgba8[d4] = r >= 255 ? 255 : Math.round(r);
      rgba8[d4 + 1] = g >= 255 ? 255 : Math.round(g);
      rgba8[d4 + 2] = b >= 255 ? 255 : Math.round(b);
      rgba8[d4 + 3] = 255;
    }
  } else {
    const rIdx = channels >= 3 && assumeBgr ? 2 : 0;
    const gIdx = channels >= 3 ? 1 : 0;
    const bIdx = channels >= 3 && assumeBgr ? 0 : channels >= 3 ? 2 : 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const sOff = i * 3;
        const d4 = i * 4;
        let r = at(y, x, rIdx) * scale;
        let g = at(y, x, gIdx) * scale;
        let b = at(y, x, bIdx) * scale;
        if (!Number.isFinite(r) || r < 0) r = 0;
        if (!Number.isFinite(g) || g < 0) g = 0;
        if (!Number.isFinite(b) || b < 0) b = 0;
        if (r > 2048) r = 2048;
        if (g > 2048) g = 2048;
        if (b > 2048) b = 2048;
        if (r > 255 || g > 255 || b > 255) clippedCount++;

        floatRgb[sOff] = r;
        floatRgb[sOff + 1] = g;
        floatRgb[sOff + 2] = b;

        rgba8[d4] = r >= 255 ? 255 : Math.round(r);
        rgba8[d4 + 1] = g >= 255 ? 255 : Math.round(g);
        rgba8[d4 + 2] = b >= 255 ? 255 : Math.round(b);
        rgba8[d4 + 3] = 255;
      }
    }
  }

  return {
    width,
    height,
    rgba8,
    floatRgb,
    scaleFactorUsed: scale,
    clippedPixelFraction: nPx > 0 ? clippedCount / nPx : 0,
  };
}

/**
 * Samples an unclipped float32 RGB image into a straightened W x L RGBA Float32Array lane strip
 * using the exact same lane coordinate convention as `laneMatrix(lane, imgScale, 1)` + Canvas drawImage.
 * Row 0 = front end, Row L-1 = origin end.
 */
export function sampleFloatRgbLaneStrip(
  floatRgb: Float32Array,
  imgW: number,
  imgH: number,
  lane: TlcLane,
  imgScale: number,
  stripW: number,
  stripL: number,
  align?: { sx: number; sy: number; dx: number; dy: number; refW: number; refH: number }
): Float32Array {
  const W = Math.max(1, Math.round(stripW));
  const L = Math.max(1, Math.round(stripL));
  const out = new Float32Array(W * L * 4);

  const th = (lane.angle * Math.PI) / 180;
  const dx = Math.sin(th);
  const dy = -Math.cos(th);
  const nx = Math.cos(th);
  const ny = Math.sin(th);
  const ox = imgScale * lane.x0;
  const oy = imgScale * lane.y0;
  const halfW = W / 2;

  const maxX = imgW - 1;
  const maxY = imgH - 1;
  const useAlign =
    align != null &&
    align.refW > 0 &&
    align.refH > 0 &&
    align.sx > 1e-4 &&
    align.sy > 1e-4;
  const invSxW = useAlign ? imgW / align!.sx : 1;
  const invSyH = useAlign ? imgH / align!.sy : 1;
  const invRefW = useAlign ? 1 / align!.refW : 1;
  const invRefH = useAlign ? 1 / align!.refH : 1;
  const alignDx = useAlign ? align!.dx : 0;
  const alignDy = useAlign ? align!.dy : 0;

  for (let sy = 0; sy < L; sy++) {
    const v = (L - (sy + 0.5)) * imgScale;
    const baseX = ox + v * dx;
    const baseY = oy + v * dy;
    const rowOut = sy * W * 4;

    for (let sx = 0; sx < W; sx++) {
      const u = (sx + 0.5 - halfW) * imgScale;
      const refX = baseX + u * nx;
      const refY = baseY + u * ny;
      const ix = (useAlign ? (refX * invRefW - alignDx) * invSxW : refX) - 0.5;
      const iy = (useAlign ? (refY * invRefH - alignDy) * invSyH : refY) - 0.5;

      const x0 = ix < 0 ? 0 : ix > maxX ? maxX : Math.floor(ix);
      const y0 = iy < 0 ? 0 : iy > maxY ? maxY : Math.floor(iy);
      const x1 = x0 < maxX ? x0 + 1 : maxX;
      const y1 = y0 < maxY ? y0 + 1 : maxY;
      const fx = Math.max(0, Math.min(1, ix - x0));
      const fy = Math.max(0, Math.min(1, iy - y0));

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * imgW + x0) * 3;
      const i10 = (y0 * imgW + x1) * 3;
      const i01 = (y1 * imgW + x0) * 3;
      const i11 = (y1 * imgW + x1) * 3;

      const o = rowOut + sx * 4;
      out[o] =
        floatRgb[i00] * w00 + floatRgb[i10] * w10 + floatRgb[i01] * w01 + floatRgb[i11] * w11;
      out[o + 1] =
        floatRgb[i00 + 1] * w00 +
        floatRgb[i10 + 1] * w10 +
        floatRgb[i01 + 1] * w01 +
        floatRgb[i11 + 1] * w11;
      out[o + 2] =
        floatRgb[i00 + 2] * w00 +
        floatRgb[i10 + 2] * w10 +
        floatRgb[i01 + 2] * w01 +
        floatRgb[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }

  return out;
}

// ---- White-light faint-spot contrast enhancement (browser port of saturate_white.py) -------------

export interface WhiteEnhanceOptions {
  /** Net contrast multiplier on background-subtracted inverted channels (default 4.6, similar to 2.8*1.8 in saturate_white.py) */
  gain?: number;
  /** Smoothing radius in pixels (0 = skip smoothing, 1 = 3x3 edge-preserving, 2 = 5x5) */
  smoothRadius?: number;
}

/**
 * Enhances faint visible-light colored spots on a White-channel TLC image:
 *  1. Estimates per-channel silica background mode from bright interior plate pixels (ignoring dark/noisy tray edges).
 *  2. Inverts (255 - c), subtracts (bgInvMode - 3) clamped at 0 so clean silica maps near 0.
 *  3. Applies a fast separable noise smoothing pass to suppress silica grain before amplifying contrast.
 *  4. Boosts contrast by `gain` and re-inverts (255 - c) so faint colored spots stand out vividly on crisp white silica.
 */
export function enhanceWhiteLightRgba(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  options: WhiteEnhanceOptions = {}
): Uint8ClampedArray {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const gain = options.gain ?? 4.6;
  const smoothRadius = options.smoothRadius ?? 1;
  const nPx = W * H;
  const out = new Uint8ClampedArray(nPx * 4);

  // 1. Histogram mode of inverted RGB inside the bright silica interior (skip dark/rainbow tray borders)
  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  const y0 = Math.floor(H * 0.14);
  const y1 = Math.ceil(H * 0.86);
  const x0 = Math.floor(W * 0.16);
  const x1 = Math.ceil(W * 0.84);
  const stepY = Math.max(1, Math.floor((y1 - y0) / 180));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 180));
  let validCount = 0;

  for (let y = y0; y < y1; y += stepY) {
    const rowOff = y * W * 4;
    for (let x = x0; x < x1; x += stepX) {
      const p = rowOff + x * 4;
      const r = rgba[p] ?? 0;
      const g = rgba[p + 1] ?? 0;
      const b = rgba[p + 2] ?? 0;
      // Ignore pitch-black tray borders or saturated rainbow tray artifacts
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (luma < 90 || chroma > 45) continue;
      histR[255 - Math.min(255, Math.max(0, Math.round(r)))]++;
      histG[255 - Math.min(255, Math.max(0, Math.round(g)))]++;
      histB[255 - Math.min(255, Math.max(0, Math.round(b)))]++;
      validCount++;
    }
  }

  // Fallback to entire image if cropped plate strip is very small or already bright
  if (validCount < 16) {
    for (let i = 0; i < nPx; i += Math.max(1, Math.floor(nPx / 4000))) {
      const p = i * 4;
      histR[255 - Math.min(255, Math.max(0, Math.round(rgba[p] ?? 0)))]++;
      histG[255 - Math.min(255, Math.max(0, Math.round(rgba[p + 1] ?? 0)))]++;
      histB[255 - Math.min(255, Math.max(0, Math.round(rgba[p + 2] ?? 0)))]++;
    }
  }

  const findMode = (hist: Uint32Array): number => {
    let bestIdx = 0;
    let bestCnt = -1;
    for (let i = 0; i < 256; i++) {
      if (hist[i] > bestCnt) {
        bestCnt = hist[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const subR = Math.max(0, findMode(histR) - 3);
  const subG = Math.max(0, findMode(histG) - 3);
  const subB = Math.max(0, findMode(histB) - 3);

  // 2. Invert & background-subtract into compact uint8 scratch buffers
  const invR = new Uint8Array(nPx);
  const invG = new Uint8Array(nPx);
  const invB = new Uint8Array(nPx);
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    const ir = 255 - (rgba[p] ?? 0) - subR;
    const ig = 255 - (rgba[p + 1] ?? 0) - subG;
    const ib = 255 - (rgba[p + 2] ?? 0) - subB;
    invR[i] = ir > 0 ? (ir > 255 ? 255 : ir) : 0;
    invG[i] = ig > 0 ? (ig > 255 ? 255 : ig) : 0;
    invB[i] = ib > 0 ? (ib > 255 ? 255 : ib) : 0;
  }

  // 3. Fast separable box-denoise on background-subtracted inverted signal (suppresses silica grain)
  let srcR = invR;
  let srcG = invG;
  let srcB = invB;
  if (smoothRadius >= 1 && W >= 3 && H >= 3) {
    const rad = Math.min(2, smoothRadius);
    const tmpR = new Uint8Array(nPx);
    const tmpG = new Uint8Array(nPx);
    const tmpB = new Uint8Array(nPx);
    const dstR = new Uint8Array(nPx);
    const dstG = new Uint8Array(nPx);
    const dstB = new Uint8Array(nPx);

    // Horizontal pass
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const lx = x > rad ? x - rad : 0;
        const rx = x + rad < W ? x + rad : W - 1;
        const cnt = rx - lx + 1;
        let sr = 0, sg = 0, sb = 0;
        for (let k = lx; k <= rx; k++) {
          sr += invR[row + k];
          sg += invG[row + k];
          sb += invB[row + k];
        }
        tmpR[row + x] = (sr / cnt) | 0;
        tmpG[row + x] = (sg / cnt) | 0;
        tmpB[row + x] = (sb / cnt) | 0;
      }
    }
    // Vertical pass
    for (let y = 0; y < H; y++) {
      const ty = y > rad ? y - rad : 0;
      const by = y + rad < H ? y + rad : H - 1;
      const cnt = by - ty + 1;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let sr = 0, sg = 0, sb = 0;
        for (let ky = ty; ky <= by; ky++) {
          const idx = ky * W + x;
          sr += tmpR[idx];
          sg += tmpG[idx];
          sb += tmpB[idx];
        }
        dstR[row + x] = (sr / cnt) | 0;
        dstG[row + x] = (sg / cnt) | 0;
        dstB[row + x] = (sb / cnt) | 0;
      }
    }
    srcR = dstR;
    srcG = dstG;
    srcB = dstB;
  }

  // 4. Amplify contrast and re-invert back to white-silica appearance
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    const br = Math.min(255, Math.round(srcR[i] * gain));
    const bg = Math.min(255, Math.round(srcG[i] * gain));
    const bb = Math.min(255, Math.round(srcB[i] * gain));
    out[p] = 255 - br;
    out[p + 1] = 255 - bg;
    out[p + 2] = 255 - bb;
    out[p + 3] = rgba[p + 3] ?? 255;
  }

  return out;
}

// ---- Curved / Wandering-Lane Centerline Tracking (port of savgol_automiddle in get_lanes.py) -----

export interface AutomiddleOptions {
  /** Optional UV366 RGBA strip of identical W x L for joint UV254 + UV366 synthetic tracking */
  uv366Rgba?: ArrayLike<number>;
  /** Approximate origin position in chromatographic pixels (0 = bottom); rows below origin + spotRadius are anchored to center */
  originPx?: number;
  /** Approximate origin spot radius in pixels */
  spotRadiusPx?: number;
  /** Rows near the far/solvent-front end to ignore during spline fitting (default ~6% of length, max 50) */
  tailIgnorePx?: number;
  /** Maximum allowed lateral deviation as a fraction of lane width (default 0.28) */
  maxDriftFraction?: number;
}

/**
 * Computes a smooth, outlier-resistant per-row horizontal center coordinate `centerX[idx]`
 * (in `[0 .. W-1]` pixel units, indexed by chromatographic coordinate `idx = 0` at origin end
 * to `L-1` at front end), following gently curved or drifting lanes.
 *
 * Adapted from `compute_lane_offsets` (`savgol_automiddle`) in the lab PC's `get_lanes.py`:
 *  1. Builds a per-row lateral contrast profile across the lane interior (joint UV254 green - UV366 RGB
 *     when both channels are present, or single-channel quenching/fluorescence/chroma otherwise).
 *  2. Smooths laterally with a cubic Savitzky-Golay kernel and locates each row's spot-core extremum,
 *     gating out featureless background rows (where signal contrast is weak) so blank silica never yanks the centerline.
 *  3. Anchors the origin zone to lane center and ignores the noisy solvent-front tail.
 *  4. Fits a robust Huber/soft-L1 IRLS smooth 2nd-difference spline over the full lane length.
 */
export function computeAutomiddleOffsets(
  primaryRgba: ArrayLike<number>,
  width: number,
  length: number,
  channel: VisionChannelKey,
  options: AutomiddleOptions = {}
): Float32Array {
  const W = Math.max(1, Math.round(width));
  const L = Math.max(1, Math.round(length));
  const center = (W - 1) / 2;
  const result = new Float32Array(L);
  result.fill(center);

  if (W < 7 || L < 24) return result;

  const uv366 = options.uv366Rgba && options.uv366Rgba.length >= W * L * 4 ? options.uv366Rgba : null;
  const originPx = options.originPx ?? Math.round(L * 0.08);
  const spotRadiusPx = options.spotRadiusPx ?? Math.max(6, Math.round(L * 0.02));
  const maskEnd = Math.min(L - 1, Math.max(0, Math.round(originPx + spotRadiusPx)));
  const tailIgnore = options.tailIgnorePx ?? Math.min(50, Math.max(8, Math.round(L * 0.06)));
  const fitEnd = Math.max(maskEnd + 6, L - tailIgnore);
  const maxDrift = Math.max(1.5, W * (options.maxDriftFraction ?? 0.28));

  // Search strictly inside the lane interior (keep 16% margin on each side so neighbor spillover never hijacks)
  const margin = Math.max(2, Math.round(W * 0.16));
  const xLo = Math.min(Math.floor(center), margin);
  const xHi = Math.max(Math.ceil(center), W - 1 - margin);
  if (xHi <= xLo) return result;

  // Compute row-wise smoothed lateral signal S(x) where LOWER value = stronger spot core
  const rawX = new Float64Array(L);
  const rowContrast = new Float64Array(L);
  const rowBuf = new Float64Array(W);
  const smoothBuf = new Float64Array(W);

  // 7-point Savitzky-Golay cubic weights: [-2, 3, 6, 7, 6, 3, -2] / 21 (or 5-point [-3, 12, 17, 12, -3] / 35)
  const use7 = W >= 11;

  for (let y = 0; y < L; y++) {
    const idx = L - 1 - y; // chromatographic coordinate: 0 = bottom, L-1 = top
    const rowOff = y * W * 4;

    for (let x = 0; x < W; x++) {
      const p = rowOff + x * 4;
      const r = primaryRgba[p] ?? 0;
      const g = primaryRgba[p + 1] ?? 0;
      const b = primaryRgba[p + 2] ?? 0;

      if (channel === 'UV254') {
        // Synthetic S matching get_lanes.py: darker UV254 green AND brighter UV366 emission both pull S lower
        let s = g;
        if (uv366) {
          const uSum = ((uv366[p] ?? 0) + (uv366[p + 1] ?? 0) + (uv366[p + 2] ?? 0)) / 3;
          s -= uSum;
        }
        rowBuf[x] = s;
      } else if (channel === 'UV366') {
        rowBuf[x] = -Math.max(r, g, b);
      } else {
        // White: darker luma pulls S lower
        rowBuf[x] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    // Savitzky-Golay smoothing across width with mirror boundary
    const atMirror = (k: number): number => {
      if (k < 0) return rowBuf[Math.min(W - 1, -k)];
      if (k >= W) return rowBuf[Math.max(0, 2 * W - 2 - k)];
      return rowBuf[k];
    };
    if (use7) {
      for (let x = 0; x < W; x++) {
        smoothBuf[x] =
          (-2 * atMirror(x - 3) +
            3 * atMirror(x - 2) +
            6 * atMirror(x - 1) +
            7 * atMirror(x) +
            6 * atMirror(x + 1) +
            3 * atMirror(x + 2) -
            2 * atMirror(x + 3)) /
          21;
      }
    } else {
      for (let x = 0; x < W; x++) {
        smoothBuf[x] =
          (-3 * atMirror(x - 2) +
            12 * atMirror(x - 1) +
            17 * atMirror(x) +
            12 * atMirror(x + 1) -
            3 * atMirror(x + 2)) /
          35;
      }
    }

    // Compare interior argmin vs outer flank baseline to measure genuine spot presence at this row
    const flankVal = 0.5 * (smoothBuf[Math.max(0, xLo - 1)] + smoothBuf[Math.min(W - 1, xHi + 1)]);
    let bestX = center;
    let bestVal = Infinity;
    for (let x = xLo; x <= xHi; x++) {
      if (smoothBuf[x] < bestVal) {
        bestVal = smoothBuf[x];
        bestX = x;
      }
    }

    // Parabolic subpixel refinement around bestX
    if (bestX > xLo && bestX < xHi) {
      const yL = smoothBuf[bestX - 1];
      const yC = smoothBuf[bestX];
      const yR = smoothBuf[bestX + 1];
      const denom = yL - 2 * yC + yR;
      if (denom > 1e-6) {
        const shift = Math.max(-0.5, Math.min(0.5, 0.5 * (yL - yR) / denom));
        bestX += shift;
      }
    }

    rawX[idx] = bestX;
    rowContrast[idx] = Math.max(0, flankVal - bestVal);
  }

  // Estimate noise floor of rowContrast over the unmasked active region
  const activeContrasts: number[] = [];
  for (let i = maskEnd + 1; i < fitEnd; i++) {
    activeContrasts.push(rowContrast[i]);
  }
  if (activeContrasts.length < 6) return result;
  activeContrasts.sort((a, b) => a - b);
  const p50 = activeContrasts[Math.floor(activeContrasts.length * 0.5)];
  const p90 = activeContrasts[Math.floor(activeContrasts.length * 0.9)];
  // If the entire lane is blank (no real spots), keep the straight centerline
  if (p90 < 6) return result;
  const sigThresh = Math.max(4.5, p50 + 0.35 * (p90 - p50));

  // Subsample onto K evenly spaced spline control knots (K = 16..24) and solve a robust Huber IRLS
  // 2nd-difference penalized smoothing spline (super fast O(K^3) with K <= 24, smooth, extrapolates linearly)
  const K = Math.min(22, Math.max(10, Math.round(L / 24)));
  const knotStep = (L - 1) / (K - 1);

  // Aggregate per-knot observations (weighted by spot contrast; masked origin rows strongly anchored to center)
  const knotY = new Float64Array(K);
  const knotW = new Float64Array(K);
  const fScale = Math.max(2.5, W * 0.18);

  // Build weighted observations at knot indices
  for (let k = 0; k < K; k++) {
    const iCenter = Math.round(k * knotStep);
    const iLo = Math.max(0, Math.floor((k - 0.5) * knotStep));
    const iHi = Math.min(L - 1, Math.ceil((k + 0.5) * knotStep));

    if (iCenter <= maskEnd) {
      knotY[k] = center;
      knotW[k] = 4.0; // Anchor origin region to center (matching get_lanes.py step 2 & 5)
      continue;
    }
    if (iCenter >= fitEnd) {
      knotY[k] = center;
      knotW[k] = 0.0; // Ignore solvent-front tail; let spline extrapolate cleanly
      continue;
    }

    let wSum = 0;
    let xSum = 0;
    for (let i = iLo; i <= iHi; i++) {
      if (i <= maskEnd || i >= fitEnd) continue;
      if (rowContrast[i] < sigThresh) continue;
      // Only trust rows whose minimum is genuinely interior (not pinned to search edge by neighbor bleed)
      if (rawX[i] <= xLo + 0.25 || rawX[i] >= xHi - 0.25) continue;
      const w = Math.min(4.0, (rowContrast[i] - sigThresh + 1) / Math.max(6, p90 - sigThresh + 1));
      xSum += rawX[i] * w;
      wSum += w;
    }
    if (wSum > 0.25) {
      knotY[k] = xSum / wSum;
      knotW[k] = Math.min(3.0, wSum * 0.25);
    } else {
      // Gentle prior toward center on empty background stretches so the spline doesn't drift wildly
      knotY[k] = center;
      knotW[k] = 0.04;
    }
  }

  // Solve (diag(w) + lambda * D2^T D2) c = w * knotY with 5 Huber IRLS iterations
  const lambda = 18.0; // Strong smoothness so centerline bends gently like a 2-interior-knot cubic B-spline
  const coeffs = new Float64Array(K);
  coeffs.fill(center);
  const effW = new Float64Array(K);

  for (let iter = 0; iter < 5; iter++) {
    for (let k = 0; k < K; k++) {
      if (iter === 0 || knotW[k] <= 0.05 || k * knotStep <= maskEnd) {
        effW[k] = knotW[k];
      } else {
        const res = Math.abs(coeffs[k] - knotY[k]);
        const huber = res <= fScale ? 1.0 : fScale / res;
        effW[k] = knotW[k] * huber;
      }
    }

    // Build K x K SPD matrix A = diag(effW) + lambda * (D2^T D2)
    const A: number[][] = Array.from({ length: K }, () => new Array<number>(K).fill(0));
    const b = new Array<number>(K).fill(0);
    for (let k = 0; k < K; k++) {
      A[k][k] += effW[k] + 1e-6;
      b[k] = effW[k] * knotY[k] + 1e-6 * center;
    }
    for (let k = 1; k < K - 1; k++) {
      // D2 row at k: [1, -2, 1] at (k-1, k, k+1)
      A[k - 1][k - 1] += lambda;
      A[k - 1][k] -= 2 * lambda;
      A[k - 1][k + 1] += lambda;
      A[k][k - 1] -= 2 * lambda;
      A[k][k] += 4 * lambda;
      A[k][k + 1] -= 2 * lambda;
      A[k + 1][k - 1] += lambda;
      A[k + 1][k] -= 2 * lambda;
      A[k + 1][k + 1] += lambda;
    }

    // Gaussian elimination with partial pivoting (K <= 22, takes <0.02 ms)
    for (let i = 0; i < K; i++) {
      let piv = i;
      for (let r = i + 1; r < K; r++) {
        if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      }
      if (piv !== i) {
        const tmpRow = A[i];
        A[i] = A[piv];
        A[piv] = tmpRow;
        const tmpB = b[i];
        b[i] = b[piv];
        b[piv] = tmpB;
      }
      const diag = A[i][i];
      if (Math.abs(diag) < 1e-12) continue;
      for (let r = i + 1; r < K; r++) {
        const f = A[r][i] / diag;
        if (f === 0) continue;
        for (let c = i; c < K; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    for (let i = K - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < K; c++) s -= A[i][c] * coeffs[c];
      coeffs[i] = Math.abs(A[i][i]) > 1e-12 ? s / A[i][i] : center;
    }
  }

  // Evaluate piecewise-smooth spline over all rows, clamp drift, and smoothly transition out of masked origin zone
  const minAllowed = Math.max(0, center - maxDrift);
  const maxAllowed = Math.min(W - 1, center + maxDrift);
  for (let i = 0; i < L; i++) {
    if (i <= maskEnd) {
      result[i] = center;
      continue;
    }
    const u = i / knotStep;
    const k0 = Math.min(K - 2, Math.max(0, Math.floor(u)));
    const t = Math.max(0, Math.min(1, u - k0));
    const val = coeffs[k0] * (1 - t) + coeffs[k0 + 1] * t;
    // Smooth ramp over 8 rows right above origin mask so there is no abrupt kink
    const ramp = i < maskEnd + 8 ? (i - maskEnd) / 8 : 1;
    const blended = center + (val - center) * ramp;
    result[i] = Math.max(minAllowed, Math.min(maxAllowed, blended));
  }

  return result;
}
