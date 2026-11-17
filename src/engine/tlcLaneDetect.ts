// Robowski Studio - automatic TLC lane detection.
//
// The robot spots every lane at a fixed pitch, so each half of the plate carries a row of 27
// regularly spaced origin dots. Instead of trusting per-lane hand adjustments we find those two
// rows, fit one straight comb (position, pitch, tilt) jointly across both halves, and build all
// 54 lanes from it. Missing or faint dots do not matter: the comb is fitted to whichever dots
// are visible.
import { TlcLane, TlcLaneConfig } from '../types';
import { LANE_FRAME_WIDTH } from './tlcLanes';

export interface RasterImage {
  /** RGBA bytes (canvas ImageData layout). */
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface DetectedRow {
  half: 'lower' | 'upper';
  /** Position of lane 0's origin dot, in working-image pixels. */
  x0: number;
  y0: number;
  /** Spacing between neighbouring origin dots along the row (working pixels). */
  pitch: number;
  /** Row tilt in degrees (0 = level). */
  angleDeg: number;
  /** Number of the 27 dots that were actually seen. */
  seen: number;
  /** Which of the 27 comb positions had a visible dot. */
  present: boolean[];
  /** Median distance of the seen dots from the fitted comb, as a fraction of the pitch. */
  residual: number;
  /** Spread of the dots' strength (0 = all alike). */
  uniformity: number;
  /** Smooth per-lane vertical offset from the straight comb (working px, length 27) for bowed plates. */
  yOffsets?: number[];
}

export interface LaneDetection {
  ok: boolean;
  /** 0..1, how much the result should be trusted. */
  confidence: number;
  lower: DetectedRow | null;
  upper: DetectedRow | null;
  /** Working image size, so positions can be mapped back. */
  workWidth: number;
  workHeight: number;
  warnings: string[];
}

export const LANES_PER_HALF = 27;
// Typical geometry of the standard plate, relative to the 3280 px reference frame.
const PITCH_FRAC = 0.0229; // dot spacing / image width
const REF_PITCH = 75.2; // pitch in the 3280 px frame
const REF_ZERO_RF = 136;
const REF_LENGTH = 1073;
const REF_WIDTH = 72;
const REF_SPOT_RADIUS = 24;
const WORK_WIDTH = 1300;

// ---------------------------------------------------------------- image helpers

function downscale(img: RasterImage, workW: number) {
  const k = Math.min(1, workW / img.width);
  const w = Math.max(8, Math.round(img.width * k));
  const h = Math.max(8, Math.round(img.height * k));
  const ch = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];

  if (w === img.width && h === img.height) {
    const total = w * h;
    for (let o = 0, p = 0; o < total; o++, p += 4) {
      ch[0][o] = img.data[p];
      ch[1][o] = img.data[p + 1];
      ch[2][o] = img.data[p + 2];
    }
    return { ch, w, h };
  }

  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)));
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += img.data[p];
          g += img.data[p + 1];
          b += img.data[p + 2];
          n++;
        }
      }
      const o = y * w + x;
      ch[0][o] = r / n;
      ch[1][o] = g / n;
      ch[2][o] = b / n;
    }
  }
  return { ch, w, h };
}

function gaussKernel(sigma: number) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    s += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

function gaussBlur(src: Float32Array, w: number, h: number, sigma: number) {
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const xEnd = Math.max(r, w - r);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < r && x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
    for (let x = r; x < xEnd; x++) {
      let s = 0;
      const base = row + x;
      for (let i = -r; i <= r; i++) s += src[base + i] * k[i + r];
      tmp[base] = s;
    }
    for (let x = xEnd; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i >= w ? w - 1 : x + i;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const dstRow = y * w;
    for (let i = -r; i <= r; i++) {
      const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
      const srcRow = yy * w;
      const kv = k[i + r];
      for (let x = 0; x < w; x++) out[dstRow + x] += tmp[srcRow + x] * kv;
    }
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Round-blob strength, either polarity (dark or bright dot), strongest over the colour channels.
 * Straight edges give one Hessian eigenvalue near zero and so score low; dots score high.
 */
function blobResponse(ch: Float32Array[], w: number, h: number) {
  const out = new Float32Array(w * h);
  const sigma1 = Math.max(1.2, (w / 3280) * 7.5);
  const sigma2 = sigma1 * 1.9;
  const sigmaDelta = Math.sqrt(sigma2 * sigma2 - sigma1 * sigma1);
  const ya = Math.floor(h * 0.15);
  const yb = Math.max(ya + 1, Math.ceil(h * 0.85));
  const xa = Math.floor(w * 0.15);
  const xb = Math.max(xa + 1, Math.ceil(w * 0.85));
  const stepY = Math.max(1, Math.floor((yb - ya) / 25));
  const stepX = Math.max(1, Math.floor((xb - xa) / 25));
  const samp: number[] = [];

  const evalHessian = (g: Float32Array, m: Float32Array, mFloor: number, scaleFactor: number) => {
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const gxx = g[i + 1] - 2 * g[i] + g[i - 1];
        const gyy = g[i + w] - 2 * g[i] + g[i - w];
        const gxy = (g[i + w + 1] - g[i + w - 1] - g[i - w + 1] + g[i - w - 1]) * 0.25;
        if (gxx * gyy <= gxy * gxy) continue;
        const tr = (gxx + gyy) * 0.5;
        const d = Math.sqrt((gxx - gyy) * (gxx - gyy) * 0.25 + gxy * gxy);
        const l1 = tr + d;
        const l2 = tr - d;
        const v = l1 < 0 ? -l1 : l2 > 0 ? l2 : 0;
        if (v <= 0) continue;
        const denom = m[i] > mFloor ? m[i] : mFloor;
        const s = (v * scaleFactor) / (denom + 15);
        if (s > out[i]) out[i] = s;
      }
    }
  };

  for (const c of ch) {
    // Clamp local brightness denominator to a fraction of interior silica intensity so dark
    // plate borders right below the origin row cannot tilt blob peaks toward the border.
    samp.length = 0;
    for (let y = ya; y < yb; y += stepY) {
      const row = y * w;
      for (let x = xa; x < xb; x += stepX) samp.push(c[row + x]);
    }
    samp.sort((a, b) => a - b);
    const chanMed = samp.length ? samp[samp.length >> 1] : 0;
    const mFloor = 0.55 * chanMed;
    const m = boxBlur(c, w, h, Math.max(4, Math.round(sigma1 * 6)));

    const g1 = gaussBlur(c, w, h, sigma1);
    evalHessian(g1, m, mFloor, 1.0 * sigma1 * sigma1 * 100);
    const g2 = gaussBlur(g1, w, h, sigmaDelta);
    evalHessian(g2, m, mFloor, 0.9 * sigma2 * sigma2 * 100);
  }
  return out;
}

interface Cand {
  x: number;
  y: number;
  v: number;
}

function candidates(resp: Float32Array, w: number, h: number, y0: number, y1: number, max = 450) {
  const rad = Math.max(2, Math.round((w / 3280) * 9));
  const xa = Math.round(w * 0.06);
  const xb = Math.round(w * 0.94);
  const list: Cand[] = [];
  for (let y = Math.max(rad, Math.round(y0)); y < Math.min(h - rad, Math.round(y1)); y++) {
    for (let x = Math.max(rad, xa); x < Math.min(w - rad, xb); x++) {
      const v = resp[y * w + x];
      if (v <= 0) continue;
      let isMax = true;
      for (let dy = -rad; dy <= rad && isMax; dy++) {
        const row = (y + dy) * w + x;
        for (let dx = -rad; dx <= rad; dx++) {
          if (resp[row + dx] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) list.push({ x, y, v });
    }
  }
  list.sort((a, b) => b.v - a.v);
  return list.slice(0, max);
}

// ---------------------------------------------------------------- comb fitting

interface RowHyp {
  slope: number; // dy/dx
  yMid: number; // row y at x = w / 2
  weight: number;
}

/** Shear-histogram search for horizontal rows of candidates (a Hough transform for near-level lines). */
function rowHypotheses(c: Cand[], w: number, cap: number, want = 10): RowHyp[] {
  const binH = Math.max(2, (w / 3280) * 10);
  const slopes: number[] = [];
  for (let s = -0.05; s <= 0.05001; s += 0.005) slopes.push(s);
  const votes: { slope: number; y: number; wt: number }[] = [];
  for (const s of slopes) {
    const acc = new Map<number, number>();
    for (const p of c) {
      const yy = p.y - s * (p.x - w / 2);
      const b = Math.round(yy / binH);
      acc.set(b, (acc.get(b) || 0) + Math.min(p.v, cap));
    }
    for (const [b, wt] of acc) {
      const sm = wt + 0.5 * ((acc.get(b - 1) || 0) + (acc.get(b + 1) || 0));
      votes.push({ slope: s, y: b * binH, wt: sm });
    }
  }
  votes.sort((a, b) => b.wt - a.wt);
  const out: RowHyp[] = [];
  for (const v of votes) {
    if (out.length >= want) break;
    // Allow at most 2 distinct-slope hypotheses per vertical band so one dense band of developed
    // spots cannot crowd out a sparser true origin row at a different height.
    const sameBand = out.filter((o) => Math.abs(o.yMid - v.y) < binH * 3);
    if (sameBand.some((o) => Math.abs(o.slope - v.slope) < 0.015)) continue;
    if (sameBand.length >= 2) continue;
    out.push({ slope: v.slope, yMid: v.y, weight: v.wt });
  }
  return out;
}

interface CombDot {
  i: number;
  x: number;
  y: number;
  v: number;
}

interface CombLine {
  half: 'lower' | 'upper';
  ax: number;
  bx: number;
  ay: number;
  by: number;
  pitch: number;
  angleDeg: number;
  sel: CombDot[];
}

function fitCombLine(
  c: Cand[],
  w: number,
  hyp: RowHyp,
  cap: number,
  half: 'lower' | 'upper',
  range: number,
  pitchFrac: number = PITCH_FRAC
): CombLine | null {
  const near = c.filter((p) => Math.abs(p.y - (hyp.yMid + hyp.slope * (p.x - w / 2))) < w * 0.012);
  if (near.length < 5) return null;
  const wt = (p: Cand) => Math.min(p.v, cap);

  // 1. Periodicity: for each pitch and phase, how much dot strength lands on a comb tooth.
  let best = { s: -1, p: 0, phi: 0 };
  for (let p = pitchFrac * (1 - range) * w; p <= pitchFrac * (1 + range) * w; p += 0.0001 * w) {
    const tol = 0.18 * p;
    for (let k = 0; k < 40; k++) {
      const phi = (k / 40) * p;
      let s = 0;
      for (const q of near) {
        const t = (((q.x - phi) % p) + p) % p;
        const d = Math.min(t, p - t);
        if (d < tol) s += wt(q) * (1 - d / tol);
      }
      if (s > best.s) best = { s, p, phi };
    }
  }
  if (best.s <= 0) return null;

  // 2. Assign each dot to its comb index, then fit x(i), y(i) by least squares, tightening the
  //    acceptance distance each pass so streaks and stray spots drop out.
  let p = best.p;
  let sel: CombDot[] = [];
  let ax = p;
  let bx = best.phi;
  let ay = hyp.slope * p;
  let by = hyp.yMid + hyp.slope * (best.phi - w / 2);
  const tols = [0.2, 0.16, 0.13, 0.11, 0.11];
  for (let pass = 0; pass < tols.length; pass++) {
    const map = new Map<number, CombDot & { e: number }>();
    for (const q of c) {
      const i = Math.round((q.x - bx) / ax);
      const e = Math.hypot(q.x - (bx + ax * i), q.y - (by + ay * i));
      if (e > tols[pass] * p) continue;
      const cur = map.get(i);
      if (!cur || e < cur.e) map.set(i, { i, x: q.x, y: q.y, v: wt(q), e });
    }
    sel = [...map.values()].map(({ i, x, y, v }) => ({ i, x, y, v }));
    if (sel.length < 4) return null;
    const n = sel.length;
    let si = 0,
      sii = 0,
      sx = 0,
      sxi = 0,
      sy = 0,
      syi = 0;
    for (const q of sel) {
      si += q.i;
      sii += q.i * q.i;
      sx += q.x;
      sxi += q.x * q.i;
      sy += q.y;
      syi += q.y * q.i;
    }
    const den = n * sii - si * si;
    if (Math.abs(den) < 1e-9) return null;
    ax = (n * sxi - si * sx) / den;
    bx = (sx - ax * si) / n;
    ay = (n * syi - si * sy) / den;
    by = (sy - ay * si) / n;
    p = Math.hypot(ax, ay);
  }
  const dirx = ax / p;
  const diry = ay / p;
  const angleDeg = (Math.atan2(diry, dirx) * 180) / Math.PI;
  return { half, ax, bx, ay, by, pitch: p, angleDeg, sel };
}

function buildRowFromLine(line: CombLine, s0: number): { row: DetectedRow; score: number } {
  const present: boolean[] = new Array(LANES_PER_HALF).fill(false);
  const resid: number[] = [];
  const strengths: number[] = [];
  for (const q of line.sel) {
    if (q.i >= s0 && q.i < s0 + LANES_PER_HALF) {
      present[q.i - s0] = true;
      resid.push(Math.hypot(q.x - (line.bx + line.ax * q.i), q.y - (line.by + line.ay * q.i)) / line.pitch);
      strengths.push(q.v);
    }
  }
  resid.sort((a, b) => a - b);
  const sm = strengths.reduce((a, b) => a + b, 0) / Math.max(1, strengths.length);
  const sv = strengths.reduce((a, b) => a + (b - sm) ** 2, 0) / Math.max(1, strengths.length);
  const uniformity = sm > 0 ? Math.sqrt(sv) / sm : 1;
  const seen = present.filter(Boolean).length;
  return {
    score: seen,
    row: {
      half: line.half,
      x0: line.bx + line.ax * s0,
      y0: line.by + line.ay * s0,
      pitch: line.pitch,
      angleDeg: line.angleDeg,
      seen,
      present,
      residual: resid.length ? resid[Math.floor(resid.length / 2)] : 1,
      uniformity,
    },
  };
}

type PlateExtent = {
  xl: number;
  xr: number;
  found: boolean;
  topFound?: boolean;
  botFound?: boolean;
  ytMid?: number;
  ybMid?: number;
  slope?: number;
  angleDeg?: number;
};

/** Penalty when the 27 lanes would run closer than ~2 pitches to the plate edge (the real dots keep 2+ pitches). */
function edgePenalty(x: number, p: number, plate: PlateExtent | undefined): number {
  if (!plate || !plate.found) return 0;
  const m = Math.min(x - plate.xl, plate.xr - x) / p;
  return 1.5 * Math.max(0, 2.0 - m);
}

function pickSingleWindow(line: CombLine, w: number, plate?: PlateExtent): { s0: number; score: number; row: DetectedRow } {
  const idxs = line.sel.map((q) => q.i);
  const lo = Math.min(...idxs) - LANES_PER_HALF;
  const hi = Math.max(...idxs);
  const vmax = Math.max(...line.sel.map((q) => q.v), 1e-6);
  let best = { s0: lo, score: -Infinity };
  for (let s0 = lo; s0 <= hi; s0++) {
    let seen = 0;
    let strength = 0;
    for (const q of line.sel) {
      if (q.i >= s0 && q.i < s0 + LANES_PER_HALF) {
        seen++;
        strength += q.v / vmax;
      }
    }
    const centreX = line.bx + line.ax * (s0 + (LANES_PER_HALF - 1) / 2);
    const off = Math.min(2, Math.abs(centreX - w / 2) / line.pitch);
    // Keep centering penalty below a real single-dot score (~1.25) so symmetric blanks center
    // without dropping genuine shifted outer lanes.
    const firstX = line.bx + line.ax * s0;
    const lastX = line.bx + line.ax * (s0 + LANES_PER_HALF - 1);
    const score =
      seen + 0.25 * strength + 1 - 1.0 * off - edgePenalty(firstX, line.pitch, plate) - edgePenalty(lastX, line.pitch, plate);
    if (score > best.score) best = { s0, score };
  }
  const built = buildRowFromLine(line, best.s0);
  return { s0: best.s0, score: best.score, row: built.row };
}

/**
 * Pick one shared 27-column window `s0` across both lower and upper halves so a blank outer lane
 * on one half (e.g. Lane 0) cannot slide that half by 1 pitch relative to the other.
 */
function pickSharedWindow(
  loLine: CombLine,
  upLine: CombLine,
  w: number,
  plate?: PlateExtent
): { lower: DetectedRow; upper: DetectedRow; jointScore: number } | null {
  const dp = Math.abs(loLine.pitch - upLine.pitch) / Math.max(loLine.pitch, upLine.pitch);
  const da = Math.abs(loLine.angleDeg - upLine.angleDeg);
  if (dp >= 0.015 || da >= 1.8) return null;

  // Map upper dot index `iu` onto lower index frame `il`:
  // Find integer index shift so bxL + p*il aligns with bxU + p*(iu - shift).
  const p = (loLine.pitch + upLine.pitch) / 2;
  const shift = Math.round((loLine.bx - upLine.bx) / p);
  const phaseErr = Math.abs((loLine.bx - upLine.bx - shift * p) / p);
  if (phaseErr > 0.35) return null;

  const loIdxs = loLine.sel.map((q) => q.i);
  const upMapped = upLine.sel.map((q) => ({ ...q, alignedIdx: q.i - shift }));
  const allIdxs = [...loIdxs, ...upMapped.map((q) => q.alignedIdx)];
  const loBound = Math.min(...allIdxs) - LANES_PER_HALF;
  const hiBound = Math.max(...allIdxs);

  const vmaxL = Math.max(...loLine.sel.map((q) => q.v), 1e-6);
  const vmaxU = Math.max(...upLine.sel.map((q) => q.v), 1e-6);

  let best = { s0: loBound, score: -Infinity };
  for (let s0 = loBound; s0 <= hiBound; s0++) {
    let seen = 0;
    let strength = 0;
    for (const q of loLine.sel) {
      if (q.i >= s0 && q.i < s0 + LANES_PER_HALF) {
        seen++;
        strength += q.v / vmaxL;
      }
    }
    for (const q of upMapped) {
      if (q.alignedIdx >= s0 && q.alignedIdx < s0 + LANES_PER_HALF) {
        seen++;
        strength += q.v / vmaxU;
      }
    }
    const centreL = loLine.bx + loLine.ax * (s0 + (LANES_PER_HALF - 1) / 2);
    const centreU = upLine.bx + upLine.ax * (s0 + shift + (LANES_PER_HALF - 1) / 2);
    const centreX = (centreL + centreU) / 2;
    const off = Math.min(2, Math.abs(centreX - w / 2) / p);
    // 1.25 < 1.8 < 2.5: rejects a 1-dot spurious border artifact on one half without dropping
    // a genuine 2-half shifted outer column.
    const edge =
      edgePenalty(loLine.bx + loLine.ax * s0, p, plate) +
      edgePenalty(loLine.bx + loLine.ax * (s0 + LANES_PER_HALF - 1), p, plate) +
      edgePenalty(upLine.bx + upLine.ax * (s0 + shift), p, plate) +
      edgePenalty(upLine.bx + upLine.ax * (s0 + shift + LANES_PER_HALF - 1), p, plate);
    const score = seen + 0.25 * strength + 2 - 1.8 * off - edge;
    if (score > best.score) best = { s0, score };
  }

  const lower = buildRowFromLine(loLine, best.s0).row;
  const upper = buildRowFromLine(upLine, best.s0 + shift).row;
  if (Math.abs(lower.x0 - upper.x0) >= 0.5 * p) return null;
  return { lower, upper, jointScore: best.score };
}

interface RowOption {
  line: CombLine;
  row: DetectedRow;
  yMid: number;
  medV: number;
  priorFactor: number;
  adj: number;
  supersededByOuter?: boolean;
}

/** Every plausible dot row in one half of the plate, best first. */
function findRows(
  resp: Float32Array,
  w: number,
  h: number,
  half: 'lower' | 'upper',
  range: number,
  plate?: PlateExtent,
  pitchFrac: number = PITCH_FRAC
): RowOption[] {
  const band: [number, number] = half === 'lower' ? [h * 0.62, h * 0.99] : [h * 0.01, h * 0.38];
  const c = candidates(resp, w, h, band[0], band[1]);
  if (c.length < 6) return [];
  const sorted = c.map((p) => p.v).sort((a, b) => a - b);
  const p85 = sorted[Math.floor(sorted.length * 0.85)] || 1;
  const p96 = sorted[Math.floor(sorted.length * 0.96)] || p85;
  // Cap above the 85th-percentile speckle level so crisp origin dots keep their sharpness edge over diffuse spots,
  // while still bounding 1-2 extreme outlier artefacts.
  const cap = Math.max(p85 * 2.2, p96);
  const hyps = rowHypotheses(c, w, cap, 10);
  const out: RowOption[] = [];
  // The plate sits in a fixed holder, so the origin dots are expected near one height; use as a tie-breaker.
  const prior = half === 'lower' ? 0.9 : 0.145;
  for (const hyp of hyps) {
    const line = fitCombLine(c, w, hyp, cap, half, range, pitchFrac);
    if (!line) continue;
    const picked = pickSingleWindow(line, w, plate);
    if (picked.row.seen < 6) continue;
    const radA = (picked.row.angleDeg * Math.PI) / 180;
    const yMid = picked.row.y0 + Math.sin(radA) * picked.row.pitch * ((LANES_PER_HALF - 1) / 2);

    let miss = 0;
    if (half === 'upper' && plate?.topFound && plate.ytMid != null) {
      const edgeDist = (yMid - plate.ytMid) / picked.row.pitch;
      miss = edgeDist < 0.36 ? Math.min(1, (0.36 - edgeDist) / 0.36) : edgeDist > 4.8 ? Math.min(1, (edgeDist - 4.8) / 2.2) : 0;
    } else if (half === 'lower' && plate?.botFound && plate.ybMid != null) {
      const edgeDist = (plate.ybMid - yMid) / picked.row.pitch;
      miss = edgeDist < 0.36 ? Math.min(1, (0.36 - edgeDist) / 0.36) : edgeDist > 4.8 ? Math.min(1, (edgeDist - 4.8) / 2.2) : 0;
    } else {
      const diff = Math.abs(yMid / h - prior);
      miss = diff <= 0.06 ? 0 : Math.min(1, (diff - 0.06) / 0.07);
    }

    const dev = Math.abs(picked.row.pitch / w - pitchFrac) / pitchFrac;
    const tiltFactor =
      plate?.angleDeg != null
        ? 1 - 0.35 * Math.min(1, Math.max(0, (Math.abs(picked.row.angleDeg - plate.angleDeg) - 0.8) / 1.5))
        : 1;

    const winVs = line.sel
      .filter((q) => q.i >= picked.s0 && q.i < picked.s0 + LANES_PER_HALF)
      .map((q) => Math.min(q.v, cap))
      .sort((a, b) => a - b);
    const medV = winVs.length ? winVs[winVs.length >> 1] : 0;
    const qFactor = 1 + 0.35 * Math.min(1.5, Math.max(0, medV / Math.max(1e-6, p85) - 1));

    const priorFactor = (1 - 0.45 * miss) * (1 - 0.5 * Math.min(1, dev / 0.03)) * tiltFactor;
    const adj = picked.score * priorFactor * qFactor;
    out.push({ line, row: picked.row, yMid, medV, priorFactor, adj });
  }

  // TLC compounds migrate inward from the origin toward the solvent front, never outward.
  // When a crisp comb-aligned outer row sits at least 1.2 pitches closer to the plate edge than an inner row,
  // suppress the inner band so a dense row of eluted spots cannot outvote a sparser origin row.
  for (const inner of out) {
    const p = inner.row.pitch;
    const hasOuterOrigin = out.some((outer) => {
      if (outer === inner) return false;
      const isOuter = half === 'upper' ? outer.yMid < inner.yMid - 1.2 * p : outer.yMid > inner.yMid + 1.2 * p;
      if (!isOuter) return false;
      if (outer.row.seen < 7 || outer.row.residual >= 0.13) return false;
      if (Math.abs(outer.row.angleDeg) >= 3.5) return false;
      if (plate?.angleDeg != null && Math.abs(outer.row.angleDeg - plate.angleDeg) >= 1.8) return false;
      if (outer.medV < 0.55 * inner.medV) return false;
      if (half === 'upper' && plate?.topFound && plate.ytMid != null && (outer.yMid - plate.ytMid) / p < 0.36) return false;
      if (half === 'lower' && plate?.botFound && plate.ybMid != null && (plate.ybMid - outer.yMid) / p < 0.36) return false;
      return true;
    });
    if (hasOuterOrigin) {
      inner.supersededByOuter = true;
      inner.adj *= 0.45;
    }
  }

  out.sort((a, b) => b.adj - a.adj);
  return out;
}

/**
 * Fit a 3-parameter quadratic `dy(u) = c0 + c1*u + c2*u^2` via Huber/Tukey IRLS so smooth plate
 * or lens bow across the 27 lanes is followed without letting stray/tailing lanes pull the curve.
 */
function fitSmoothQuadOffsets(
  hits: Array<{ i: number; res: number }>,
  p: number
): { coeffs: [number, number, number]; medRes: number; agree: number } | null {
  if (hits.length < 10) return null;
  const uOf = (i: number) => (i - (LANES_PER_HALF - 1) / 2) / ((LANES_PER_HALF - 1) / 2);
  let c0 = 0,
    c1 = 0,
    c2 = 0;

  for (let iter = 0; iter < 6; iter++) {
    const absRes = hits.map((h) => Math.abs(h.res - (c0 + c1 * uOf(h.i) + c2 * uOf(h.i) ** 2))).sort((a, b) => a - b);
    const scale = Math.max(0.03 * p, 1.4826 * absRes[absRes.length >> 1]);
    const cutoff = Math.max(0.12 * p, 2.5 * scale);

    let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
    let r0 = 0, r1 = 0, r2 = 0;
    for (const h of hits) {
      const u = uOf(h.i);
      const u2 = u * u;
      const err = Math.abs(h.res - (c0 + c1 * u + c2 * u2));
      let w = 1;
      if (iter > 0) {
        if (err >= cutoff) w = 0;
        else {
          const t = err / cutoff;
          w = (1 - t * t) ** 2; // Tukey biweight
        }
      }
      if (w <= 0) continue;
      s00 += w;
      s01 += w * u;
      s02 += w * u2;
      s11 += w * u2;
      s12 += w * u * u2;
      s22 += w * u2 * u2;
      r0 += w * h.res;
      r1 += w * u * h.res;
      r2 += w * u2 * h.res;
    }

    // Ridge on quadratic term prevents sparse edge extrapolation blowup
    s22 += 0.25;
    // Solve 3x3 symmetric system via Gaussian elimination
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
      if (Math.abs(M[piv][col]) < 1e-9) return null;
      if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
      const div = M[col][col];
      for (let j = col; j < 4; j++) M[col][j] /= div;
      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const fac = M[row][col];
        for (let j = col; j < 4; j++) M[row][j] -= fac * M[col][j];
      }
    }
    c0 = M[0][3];
    c1 = M[1][3];
    c2 = M[2][3];
  }

  const inliers = hits.filter((h) => {
    const u = uOf(h.i);
    return Math.abs(h.res - (c0 + c1 * u + c2 * u * u)) < 0.18 * p;
  });
  if (inliers.length < 10) return null;
  const minI = Math.min(...inliers.map((h) => h.i));
  const maxI = Math.max(...inliers.map((h) => h.i));
  if (maxI - minI < 18 || minI > 4 || maxI < 22) return null;

  const linResSorted = hits.map((h) => Math.abs(h.res)).sort((a, b) => a - b);
  const linMedRes = linResSorted[linResSorted.length >> 1];

  const resSorted = hits
    .map((h) => {
      const u = uOf(h.i);
      return Math.abs(h.res - (c0 + c1 * u + c2 * u * u));
    })
    .sort((a, b) => a - b);
  const quadMedRes = resSorted[resSorted.length >> 1];
  if (quadMedRes >= 0.72 * linMedRes || linMedRes - quadMedRes < 0.025 * p) return null;

  return {
    coeffs: [c0, c1, c2],
    medRes: quadMedRes,
    agree: inliers.length,
  };
}

interface DotCoreInfo {
  y: number;
  contrast: number;
  bilateral: number;
}

/**
 * Refine a coarse blob peak `yHit` on the raw intensity strip along `(cx, y)` by finding the
 * symmetric 60%-peak connected dot core, returning refined center plus contrast & bilateral drop.
 */
function refineDotCoreInfo(
  ch: Float32Array[],
  w: number,
  h: number,
  cx: number,
  yHit: number,
  p: number,
  expectedSign?: -1 | 1
): DotCoreInfo | null {
  const halfH = Math.max(10, Math.round(0.95 * p));
  const yMin = Math.max(0, Math.round(yHit - halfH));
  const yMax = Math.min(h - 1, Math.round(yHit + halfH));
  const len = yMax - yMin + 1;
  if (len < 7) return null;

  const xA = Math.max(0, Math.round(cx - 0.14 * p));
  const xB = Math.min(w - 1, Math.round(cx + 0.14 * p));
  const xCount = Math.max(1, xB - xA + 1);
  const hitIdx = Math.max(1, Math.min(len - 2, Math.round(yHit) - yMin));
  // Outer background flanks stay outside even large saturated origin dots (radius up to ~0.40*p)
  const outerSpan = Math.max(3, Math.round(0.24 * p));
  const upEnd = Math.min(hitIdx - 1, outerSpan);
  const loStart = Math.max(hitIdx + 1, len - 1 - outerSpan);
  const peakR = Math.max(4, Math.round(0.38 * p));

  let bestChanProf: number[] | null = null;
  let bestSign: -1 | 1 = expectedSign ?? -1;
  let bestBg = 0;
  let bestMedUp = 0;
  let bestMedLo = 0;
  let bestPeakIdx = hitIdx;
  let bestScore = 0;

  for (const c of ch) {
    const raw = new Array<number>(len);
    for (let k = 0; k < len; k++) {
      const row = (yMin + k) * w;
      let sum = 0;
      for (let x = xA; x <= xB; x++) sum += c[row + x];
      raw[k] = sum / xCount;
    }
    // Gentle [0.25, 0.5, 0.25] smoothing to suppress single-pixel camera grain
    const sm = new Array<number>(len);
    for (let k = 0; k < len; k++) {
      const vm = raw[Math.max(0, k - 1)];
      const v0 = raw[k];
      const vp = raw[Math.min(len - 1, k + 1)];
      sm[k] = 0.25 * vm + 0.5 * v0 + 0.25 * vp;
    }

    const upperFlank = upEnd >= 0 ? sm.slice(0, upEnd + 1).sort((a, b) => a - b) : [sm[0]];
    const lowerFlank = loStart < len ? sm.slice(loStart).sort((a, b) => a - b) : [sm[len - 1]];
    const medUp = upperFlank[upperFlank.length >> 1];
    const medLo = lowerFlank[lowerFlank.length >> 1];

    const kLo = Math.max(1, hitIdx - peakR);
    const kHi = Math.min(len - 2, hitIdx + peakR);
    let minCore = Infinity;
    let minIdx = hitIdx;
    let maxCore = -Infinity;
    let maxIdx = hitIdx;
    for (let k = kLo; k <= kHi; k++) {
      if (sm[k] < minCore) {
        minCore = sm[k];
        minIdx = k;
      }
      if (sm[k] > maxCore) {
        maxCore = sm[k];
        maxIdx = k;
      }
    }

    const dUpDark = medUp - minCore;
    const dLoDark = medLo - minCore;
    const cDark = Math.max(dUpDark, dLoDark);
    const biDark = Math.min(dUpDark, dLoDark);

    const dUpBright = maxCore - medUp;
    const dLoBright = maxCore - medLo;
    const cBright = Math.max(dUpBright, dLoBright);
    const biBright = Math.min(dUpBright, dLoBright);

    if (expectedSign !== 1 && cDark > bestScore && biDark > 0) {
      bestScore = cDark;
      bestSign = -1;
      bestBg = Math.max(medUp, medLo);
      bestMedUp = medUp;
      bestMedLo = medLo;
      bestPeakIdx = minIdx;
      bestChanProf = sm;
    }
    if (expectedSign !== -1 && cBright > bestScore && biBright > 0) {
      bestScore = cBright;
      bestSign = 1;
      bestBg = Math.min(medUp, medLo);
      bestMedUp = medUp;
      bestMedLo = medLo;
      bestPeakIdx = maxIdx;
      bestChanProf = sm;
    }
  }

  if (!bestChanProf || bestScore < 8) return null;

  const sm = bestChanProf;
  const sigAt = (k: number) => Math.max(0, bestSign * (sm[k] - bestBg));
  const peakSig = sigAt(bestPeakIdx);
  const searchR = Math.max(5, Math.round(0.45 * p));

  let loConn = bestPeakIdx;
  while (loConn > Math.max(1, bestPeakIdx - searchR) && sigAt(loConn - 1) >= 0.45 * peakSig) loConn--;
  let hiConn = bestPeakIdx;
  while (hiConn < Math.min(len - 2, bestPeakIdx + searchR) && sigAt(hiConn + 1) >= 0.45 * peakSig) hiConn++;

  let coreMax = peakSig;
  for (let k = loConn; k <= hiConn; k++) {
    const v = sigAt(k);
    if (v > coreMax) coreMax = v;
  }
  if (coreMax < 8) return null;

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
  const seedFloat = pLo !== -1 ? 0.5 * (pLo + pHi) : bestPeakIdx;
  const seed = Math.round(seedFloat);
  const thr = 0.64 * coreMax;
  const maxHalf = Math.max(5, Math.round(0.48 * p));

  let l = seed;
  while (l > Math.max(0, seed - maxHalf) && sigAt(l - 1) >= thr) l--;
  let leftY = l;
  if (l > 0 && sigAt(l - 1) < thr && sigAt(l) >= thr) {
    const v0 = sigAt(l - 1);
    const v1 = sigAt(l);
    leftY = l - (v1 - thr) / Math.max(1e-6, v1 - v0);
  }

  let r = seed;
  while (r < Math.min(len - 1, seed + maxHalf) && sigAt(r + 1) >= thr) r++;
  let rightY = r;
  if (r < len - 1 && sigAt(r + 1) < thr && sigAt(r) >= thr) {
    const v0 = sigAt(r);
    const v1 = sigAt(r + 1);
    rightY = r + (v0 - thr) / Math.max(1e-6, v0 - v1);
  }

  // Clamp one-sided elution smear tails against the clean opposite flank's half-width
  // so tailing dots stay centered on their round deposit core rather than shifting toward the front.
  const rUp = Math.max(0.5, seedFloat - leftY);
  const rLo = Math.max(0.5, rightY - seedFloat);
  const nearA = Math.max(0, seed - Math.round(0.62 * p));
  const nearB = Math.max(0, seed - Math.round(0.28 * p));
  const nearC = Math.min(len - 1, seed + Math.round(0.28 * p));
  const nearD = Math.min(len - 1, seed + Math.round(0.62 * p));
  const nearUp = nearB >= nearA ? sm.slice(nearA, nearB + 1).sort((a, b) => a - b)[(nearB - nearA + 1) >> 1] : bestMedUp;
  const nearLo = nearD >= nearC ? sm.slice(nearC, nearD + 1).sort((a, b) => a - b)[(nearD - nearC + 1) >> 1] : bestMedLo;
  const flankAsym = bestSign < 0 ? 0.5 * ((bestMedUp - bestMedLo) + (nearUp - nearLo)) : 0.5 * ((bestMedLo - bestMedUp) + (nearLo - nearUp));

  let usedLeftY = leftY;
  let usedRightY = rightY;
  const cleanIsUp = flankAsym > 3 || (flankAsym >= -2 && rLo > 1.25 * rUp + 0.5);
  const cleanIsLo = flankAsym < -3 || (flankAsym <= 2 && rUp > 1.25 * rLo + 0.5);
  if (cleanIsUp && rLo > 1.12 * rUp + 0.3) {
    usedRightY = Math.min(rightY, seedFloat + Math.max(1.2, 1.12 * rUp + 0.3));
  } else if (cleanIsLo && rUp > 1.12 * rLo + 0.3) {
    usedLeftY = Math.max(leftY, seedFloat - Math.max(1.2, 1.12 * rLo + 0.3));
  }

  const lClamp = Math.max(0, Math.floor(usedLeftY));
  const rClamp = Math.min(len - 1, Math.ceil(usedRightY));
  const mid = 0.5 * (usedLeftY + usedRightY);
  let sumW = 0;
  let sumPos = 0;
  for (let k = lClamp; k <= rClamp; k++) {
    const wt = Math.max(0, sigAt(k) - thr);
    sumW += wt;
    sumPos += k * wt;
  }
  const centroid = sumW > 0 ? sumPos / sumW : mid;
  const refined = yMin + 0.65 * mid + 0.35 * centroid;
  const shift = Math.abs(refined - yHit);
  let y = refined;
  if (shift > 0.36 * p) {
    const refIdx = Math.max(0, Math.min(len - 1, Math.round(refined) - yMin));
    const aPath = Math.min(hitIdx, refIdx);
    const bPath = Math.max(hitIdx, refIdx);
    let minPathSig = Infinity;
    for (let k = aPath; k <= bPath; k++) {
      const sv = sigAt(k);
      if (sv < minPathSig) minPathSig = sv;
    }
    // Allow moving across a huge flat dot's connected core up to 0.48*p, only bouncing on disjoint jumps
    if (shift > 0.48 * p || minPathSig < 0.25 * coreMax) {
      y = yHit;
    }
  }

  // Measure true bilateral contrast cleanly outside the refined dot contour
  const flankGap = Math.max(2, Math.round(0.08 * p));
  const fUpEnd = Math.max(0, l - flankGap);
  const fUpStart = Math.max(0, fUpEnd - Math.max(3, Math.round(0.18 * p)));
  const fLoStart = Math.min(len - 1, r + flankGap);
  const fLoEnd = Math.min(len - 1, fLoStart + Math.max(3, Math.round(0.18 * p)));
  const upSlice = sm.slice(fUpStart, fUpEnd + 1).sort((a, b) => a - b);
  const loSlice = sm.slice(fLoStart, fLoEnd + 1).sort((a, b) => a - b);
  const fMedUp = upSlice.length ? upSlice[upSlice.length >> 1] : sm[0];
  const fMedLo = loSlice.length ? loSlice[loSlice.length >> 1] : sm[len - 1];
  const cVal = sm[Math.max(0, Math.min(len - 1, Math.round(mid)))];
  const dUp = bestSign * (cVal - fMedUp);
  const dLo = bestSign * (cVal - fMedLo);
  const contrast = Math.max(dUp, dLo);
  const bilateral = Math.min(dUp, dLo);

  return { y, contrast, bilateral };
}

function refineDotCoreY(
  ch: Float32Array[],
  w: number,
  h: number,
  cx: number,
  yHit: number,
  p: number
): number {
  return refineDotCoreInfo(ch, w, h, cx, yHit, p)?.y ?? yHit;
}

/**
 * Fit constrained Theil-Sen line (clamped tilt relative to a0) and optional smooth quadratic bow.
 */
function fitRowBaselineAndBow(
  pts: Array<{ i: number; x: number; y: number }>,
  x0: number,
  a0: number,
  p: number
): { y0: number; ang: number; medRes: number; agree: number; quad: ReturnType<typeof fitSmoothQuadOffsets> } {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[j].x - pts[i].x) > 5 * p) {
        slopes.push((pts[j].y - pts[i].y) / (pts[j].x - pts[i].x));
      }
    }
  }
  const rawSlope = slopes.length ? slopes.sort((a, b) => a - b)[Math.floor(slopes.length / 2)] : Math.tan(a0);
  const maxTiltRad = (0.8 * Math.PI) / 180;
  const ang = Math.max(a0 - maxTiltRad, Math.min(a0 + maxTiltRad, Math.atan(rawSlope)));
  const slope = Math.tan(ang);
  const icpt = pts.map((q) => q.y - slope * q.x).sort((a, b) => a - b);
  const b = icpt[Math.floor(icpt.length / 2)];
  const res = pts.map((q) => Math.abs(q.y - (b + slope * q.x))).sort((a, b) => a - b);
  const medRes = res[Math.floor(res.length / 2)];
  const agree = pts.filter((q) => Math.abs(q.y - (b + slope * q.x)) < 0.18 * p).length;
  const quad = fitSmoothQuadOffsets(
    pts.map((q) => ({ i: q.i, res: q.y - (b + slope * q.x) })),
    p
  );
  return { y0: b + slope * x0, ang, medRes, agree, quad };
}

/**
 * The comb gives reliable column positions, but several rows of similar dots (origin dots, streak
 * heads) can look alike. In each lane the origin is the outermost round dot, so look for it there,
 * refit the row's overall height, tilt, and gentle plate bow, and then lock each individual lane
 * onto its actual origin dot center to follow experimental spotting variation.
 */
function refineRowHeight(resp: Float32Array, ch: Float32Array[], w: number, h: number, row: DetectedRow): DetectedRow {
  const a0 = (row.angleDeg * Math.PI) / 180;
  const p = row.pitch;
  const outer = row.half === 'lower' ? 1 : -1; // direction towards the plate edge
  const hits: Array<{ i: number; x: number; y: number }> = [];
  // Strength of dots already on the comb, as a yardstick for "a real origin dot".
  const ref: number[] = [];
  for (let i = 0; i < LANES_PER_HALF; i++) {
    if (!row.present[i]) continue;
    const cx = Math.round(row.x0 + Math.cos(a0) * p * i);
    const cy = Math.round(row.y0 + Math.sin(a0) * p * i);
    if (cx > 0 && cx < w && cy > 0 && cy < h) ref.push(resp[cy * w + cx]);
  }
  ref.sort((a, b) => a - b);
  const medianRef = ref.length ? ref[Math.floor(ref.length / 2)] : 1;
  const thr = 0.42 * medianRef;
  const rad = Math.max(2, Math.round((w / 3280) * 9));
  for (let i = 0; i < LANES_PER_HALF; i++) {
    const px = row.x0 + Math.cos(a0) * p * i;
    const py = row.y0 + Math.sin(a0) * p * i;
    let bestX = -1;
    let bestY = NaN;
    let bestV = 0;
    const ya = Math.max(rad, Math.round(py - 0.7 * p));
    const yb = Math.min(h - rad - 1, Math.round(py + 0.7 * p));
    for (let y = ya; y <= yb; y++) {
      for (let x = Math.max(rad, Math.round(px - 0.2 * p)); x <= Math.min(w - rad - 1, Math.round(px + 0.2 * p)); x++) {
        const v = resp[y * w + x];
        if (v < thr) continue;
        let isMax = true;
        for (let dy = -rad; dy <= rad && isMax; dy++)
          for (let dx = -rad; dx <= rad; dx++)
            if (resp[(y + dy) * w + x + dx] > v) {
              isMax = false;
              break;
            }
        if (!isMax) continue;
        // Prefer a strong dot, with a mild tie-breaker towards the outermost dot when the comb
        // initially landed on a developed row instead of the origin.
        const score = v / medianRef + 0.15 * ((y - py) * outer) / p - 0.5 * Math.abs(y - py) / p;
        if (Number.isNaN(bestY) || score > bestV) {
          bestX = x;
          bestY = y;
          bestV = score;
        }
      }
    }
    if (!Number.isNaN(bestY)) {
      if (bestY > 1 && bestY < h - 2 && bestX >= 0) {
        const vm = resp[(bestY - 1) * w + bestX];
        const v0 = resp[bestY * w + bestX];
        const vp = resp[(bestY + 1) * w + bestX];
        const denom = vm - 2 * v0 + vp;
        if (denom < -1e-9) {
          bestY += Math.max(-0.5, Math.min(0.5, (0.5 * (vm - vp)) / denom));
        }
      }
      hits.push({ i, x: px, y: bestY });
    }
  }
  if (hits.length < 8) return row;

  const pass1Fit = fitRowBaselineAndBow(hits, row.x0, a0, p);
  const useQuad1 = pass1Fit.quad !== null && pass1Fit.quad.agree >= 10 && pass1Fit.quad.medRes <= 0.16 * p;
  if (!useQuad1 && (pass1Fit.agree < 10 || pass1Fit.medRes > 0.16 * p)) return row;

  let ang = pass1Fit.ang;
  const x0 = row.x0;
  let y0 = pass1Fit.y0;
  let cosA = Math.max(0.5, Math.cos(ang));
  const evalQuad = (qFit: ReturnType<typeof fitSmoothQuadOffsets>, i: number) => {
    if (!qFit) return 0;
    const u = (i - (LANES_PER_HALF - 1) / 2) / ((LANES_PER_HALF - 1) / 2);
    return (qFit.coeffs[0] + qFit.coeffs[1] * u + qFit.coeffs[2] * u * u) / cosA;
  };
  let backboneOff: number[] = Array.from({ length: LANES_PER_HALF }, (_, i) =>
    useQuad1 ? evalQuad(pass1Fit.quad, i) : 0
  );

  // Determine expected dot polarity from interior plate brightness so blank UV254 lanes
  // cannot latch onto tiny bright camera/channel speckles.
  const intSamp: number[] = [];
  const syA = Math.floor(h * 0.25);
  const syB = Math.max(syA + 1, Math.ceil(h * 0.75));
  const sxA = Math.floor(w * 0.2);
  const sxB = Math.max(sxA + 1, Math.ceil(w * 0.8));
  const sySt = Math.max(1, Math.floor((syB - syA) / 16));
  const sxSt = Math.max(1, Math.floor((sxB - sxA) / 16));
  for (let yy = syA; yy < syB; yy += sySt) {
    const rr = yy * w;
    for (let xx = sxA; xx < sxB; xx += sxSt) {
      intSamp.push(Math.max(ch[0][rr + xx], ch[1][rr + xx], ch[2][rr + xx]));
    }
  }
  intSamp.sort((a, b) => a - b);
  const expectedSign: -1 | 1 = (intSamp.length ? intSamp[intSamp.length >> 1] : 180) >= 80 ? -1 : 1;

  // Second pass: lock each lane that actually has a sharp origin dot onto its core within
  // experimental spotting error (+/-0.24*p) around the smooth backbone; missing-spot lanes stay
  // cleanly on the backbone rather than latching onto faint streaks or zig-zagging.
  const localThr = 0.28 * medianRef;
  const pass2Hits: Array<{ i: number; x: number; y: number; v: number; contrast: number; bilateral: number }> = [];

  for (let i = 0; i < LANES_PER_HALF; i++) {
    const px = x0 + Math.cos(ang) * p * i;
    const pyLine = y0 + Math.sin(ang) * p * i;
    const pyBackbone = pyLine + backboneOff[i] * cosA;
    const ya = Math.max(rad, Math.round(pyBackbone - 0.24 * p));
    const yb = Math.min(h - rad - 1, Math.round(pyBackbone + 0.24 * p));
    const xa = Math.max(rad, Math.round(px - 0.20 * p));
    const xb = Math.min(w - rad - 1, Math.round(px + 0.20 * p));

    let bestX = -1;
    let bestY = NaN;
    let bestV = 0;
    let bestS = -Infinity;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const v = resp[y * w + x];
        if (v < localThr) continue;
        let isMax = true;
        for (let dy = -rad; dy <= rad && isMax; dy++)
          for (let dx = -rad; dx <= rad; dx++)
            if (resp[(y + dy) * w + x + dx] > v) {
              isMax = false;
              break;
            }
        if (!isMax) continue;
        const sc = v / medianRef + 0.08 * ((y - pyBackbone) * outer) / p - 0.45 * Math.abs(y - pyBackbone) / p;
        if (sc > bestS) {
          bestX = x;
          bestY = y;
          bestV = v;
          bestS = sc;
        }
      }
    }
    let info: DotCoreInfo | null = null;
    let hitX = px;
    let hitY = pyBackbone;
    if (!Number.isNaN(bestY)) {
      if (bestY > 1 && bestY < h - 2 && bestX >= 0) {
        const vm = resp[(bestY - 1) * w + bestX];
        const v0 = resp[bestY * w + bestX];
        const vp = resp[(bestY + 1) * w + bestX];
        const denom = vm - 2 * v0 + vp;
        if (denom < -1e-9) {
          bestY += Math.max(-0.5, Math.min(0.5, (0.5 * (vm - vp)) / denom));
        }
      }
      hitX = bestX;
      hitY = bestY;
      info = refineDotCoreInfo(ch, w, h, hitX, hitY, p, expectedSign);
    } else {
      // Fallback: if blobResponse missed or weakened a wide/faint dot near pyBackbone, check raw strip directly
      const direct = refineDotCoreInfo(ch, w, h, px, pyBackbone, p, expectedSign);
      if (direct && direct.contrast >= 26 && direct.bilateral >= 18 && Math.abs(direct.y - pyBackbone) <= 0.18 * p) {
        info = direct;
        bestV = 0.5 * medianRef;
      }
    }
    if (info && info.bilateral >= 14 && info.contrast >= 20) {
      pass2Hits.push({
        i,
        x: px,
        y: info.y,
        v: bestV,
        contrast: info.contrast,
        bilateral: info.bilateral,
      });
    }
  }

  let finalMedRes = pass1Fit.medRes;
  let finalQuad = useQuad1 ? pass1Fit.quad : null;
  const acceptedHits: typeof pass2Hits = [];
  let medCon = 60;
  if (pass2Hits.length > 0) {
    const cSorted = pass2Hits.map((h2) => h2.contrast).sort((a, b) => a - b);
    medCon = cSorted[cSorted.length >> 1];
    const minCon = Math.max(20, 0.28 * medCon);
    const minBi = Math.max(14, 0.22 * medCon);
    for (const h2 of pass2Hits) {
      if (h2.contrast < minCon || h2.bilateral < minBi) continue;
      const pyBack = y0 + Math.sin(ang) * p * h2.i + backboneOff[h2.i] * cosA;
      const dev = Math.abs(h2.y - pyBack) / cosA;
      if (
        dev > 0.08 * p &&
        (h2.contrast < Math.max(24, 0.35 * medCon) ||
          h2.bilateral < Math.max(18, 0.28 * medCon) ||
          h2.bilateral < 0.45 * h2.contrast)
      ) {
        continue;
      }
      acceptedHits.push(h2);
    }
  }

  // Re-fit straight/bowed backbone directly to Pass 2's core-refined dot centers so blank
  // lanes sit dead-center along the real origin dots without inheriting Pass 1 rim offsets.
  if (acceptedHits.length >= 6) {
    const pass2Fit = fitRowBaselineAndBow(acceptedHits, x0, a0, p);
    const useQuad2 = pass2Fit.quad !== null && pass2Fit.quad.agree >= 10 && pass2Fit.quad.medRes <= 0.16 * p;
    if (useQuad2 || pass2Fit.agree >= 6) {
      ang = pass2Fit.ang;
      y0 = pass2Fit.y0;
      cosA = Math.max(0.5, Math.cos(ang));
      finalQuad = useQuad2 ? pass2Fit.quad : null;
      finalMedRes = pass2Fit.medRes;
      backboneOff = Array.from({ length: LANES_PER_HALF }, (_, i) => (finalQuad ? evalQuad(finalQuad, i) : 0));
    }
  }

  const perLaneOff: number[] = new Array(LANES_PER_HALF).fill(NaN);
  const perLaneCon: number[] = new Array(LANES_PER_HALF).fill(0);
  for (const h2 of acceptedHits) {
    const pyLine = y0 + Math.sin(ang) * p * h2.i;
    perLaneOff[h2.i] = (h2.y - pyLine) / cosA;
    perLaneCon[h2.i] = h2.contrast;
  }

  // Missing-spot or faint-smear lanes sit directly on the smooth tilted/bowed plate backbone
  // so missing origin dots never cause edge droop or neighboring zigzag ramps.
  const rawOffsets = Array.from({ length: LANES_PER_HALF }, (_, i) => {
    const off = Number.isNaN(perLaneOff[i]) ? backboneOff[i] : perLaneOff[i];
    const maxDev = perLaneCon[i] < 0.40 * medCon ? 0.09 * p : 0.22 * p;
    const rel = Math.max(-maxDev, Math.min(maxDev, off - backboneOff[i]));
    return Math.max(-0.45 * p, Math.min(0.45 * p, backboneOff[i] + rel));
  });

  const finalRes = finalQuad ? Math.min(finalMedRes, finalQuad.medRes) : finalMedRes;
  const maxAbs = Math.max(...rawOffsets.map(Math.abs));
  const yOffsets = maxAbs >= 0.015 * p ? rawOffsets : undefined;

  return {
    ...row,
    x0,
    y0,
    angleDeg: (ang * 180) / Math.PI,
    residual: Math.max(row.residual, finalRes / p),
    yOffsets,
  };
}

function fitPlateEdgeLine(
  pts: Array<{ x: number; y: number }>,
  w: number
): { yMid: number; slope: number; medRes: number } | null {
  if (pts.length < 10) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (Math.abs(dx) >= w * 0.12) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const slope = slopes[slopes.length >> 1];
  if (Math.abs(slope) > 0.08) return null;
  const icpts = pts.map((p) => p.y - slope * (p.x - w / 2)).sort((a, b) => a - b);
  const yMid = icpts[icpts.length >> 1];
  const res = pts.map((p) => Math.abs(p.y - (yMid + slope * (p.x - w / 2)))).sort((a, b) => a - b);
  const medRes = res[res.length >> 1];
  if (medRes > 0.008 * w) return null;
  return { yMid, slope, medRes };
}

/**
 * Left, right, top, and bottom edge of the bright plate against the dark background (working px),
 * or full bounds when the plate has no visible dark border.
 */
export function findPlateExtent(ch: Float32Array[], w: number, h: number): PlateExtent {
  const y0 = Math.round(h * 0.1);
  const y1 = Math.round(h * 0.9);
  const g = ch[1];
  const cols = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y += 2) sum += g[y * w + x];
    cols[x] = sum / Math.ceil((y1 - y0) / 2);
  }
  const sorted = Array.from(cols).sort((a, b) => a - b);
  const lo = sorted[Math.floor(w * 0.01)];
  const hi = sorted[Math.floor(w * 0.8)];
  let xl = 0;
  let xr = w - 1;
  let found = false;
  if (hi > 40 && (hi - lo) / hi >= 0.35) {
    const thr = lo + 0.5 * (hi - lo);
    while (xl < w && cols[xl] < thr) xl++;
    while (xr > 0 && cols[xr] < thr) xr--;
    if (xr - xl >= w * 0.4) {
      found = xl > 2 || xr < w - 3;
    } else {
      xl = 0;
      xr = w - 1;
    }
  }

  const xA = found ? Math.round(xl + 0.08 * (xr - xl)) : Math.round(0.15 * w);
  const xB = found ? Math.round(xr - 0.08 * (xr - xl)) : Math.round(0.85 * w);
  const midSamp: number[] = [];
  const sy0 = Math.round(h * 0.25);
  const sy1 = Math.round(h * 0.75);
  const syStep = Math.max(2, Math.floor((sy1 - sy0) / 20));
  const sxStep = Math.max(2, Math.floor((xB - xA) / 20));
  for (let y = sy0; y < sy1; y += syStep) {
    for (let x = xA; x <= xB; x += sxStep) midSamp.push(g[y * w + x]);
  }
  midSamp.sort((a, b) => a - b);
  const hiY = midSamp.length ? midSamp[midSamp.length >> 1] : 0;

  let topFit: { yMid: number; slope: number; medRes: number } | null = null;
  let botFit: { yMid: number; slope: number; medRes: number } | null = null;
  if (hiY > 45 && xB > xA + 10) {
    const topPts: Array<{ x: number; y: number }> = [];
    const botPts: Array<{ x: number; y: number }> = [];
    const nCols = 21;
    const bandRows = Math.max(2, Math.round(h * 0.02));
    for (let k = 0; k < nCols; k++) {
      const x = Math.round(xA + (k / (nCols - 1)) * (xB - xA));
      const topVals: number[] = [];
      for (let y = 0; y < bandRows; y++) topVals.push(g[y * w + x]);
      topVals.sort((a, b) => a - b);
      const topDark = topVals[topVals.length >> 1];
      if (topDark < 0.55 * hiY) {
        const thr = topDark + 0.5 * (hiY - topDark);
        for (let y = 1; y < Math.round(h * 0.35); y++) {
          if (g[y * w + x] >= thr) {
            if (y < h * 0.3) topPts.push({ x, y });
            break;
          }
        }
      }

      const botVals: number[] = [];
      for (let y = h - bandRows; y < h; y++) botVals.push(g[y * w + x]);
      botVals.sort((a, b) => a - b);
      const botDark = botVals[botVals.length >> 1];
      if (botDark < 0.55 * hiY) {
        const thr = botDark + 0.5 * (hiY - botDark);
        for (let y = h - 2; y >= Math.round(h * 0.65); y--) {
          if (g[y * w + x] >= thr) {
            if (y > h * 0.7) botPts.push({ x, y });
            break;
          }
        }
      }
    }
    topFit = fitPlateEdgeLine(topPts, w);
    botFit = fitPlateEdgeLine(botPts, w);
    if (topFit && botFit && botFit.yMid - topFit.yMid < h * 0.45) {
      topFit = null;
      botFit = null;
    }
  }

  let slope: number | undefined;
  if (topFit && botFit) {
    slope =
      Math.abs(topFit.slope - botFit.slope) < 0.02
        ? 0.5 * (topFit.slope + botFit.slope)
        : topFit.medRes <= botFit.medRes
        ? topFit.slope
        : botFit.slope;
  } else if (topFit) {
    slope = topFit.slope;
  } else if (botFit) {
    slope = botFit.slope;
  }

  return {
    xl,
    xr,
    found,
    topFound: !!topFit,
    botFound: !!botFit,
    ytMid: topFit?.yMid,
    ybMid: botFit?.yMid,
    slope,
    angleDeg: slope != null ? (Math.atan(slope) * 180) / Math.PI : undefined,
  };
}

export function detectLaneRows(img: RasterImage, workWidth: number = WORK_WIDTH): LaneDetection {
  const { ch, w, h } = downscale(img, workWidth);
  const resp = blobResponse(ch, w, h);
  const plate = findPlateExtent(ch, w, h);
  if (plate.found) {
    const margin = Math.round(0.9 * PITCH_FRAC * w);
    const a = plate.xl + margin;
    const b = plate.xr - margin;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) if (x < a || x > b) resp[row + x] = 0;
    }
  }
  if (plate.topFound && plate.ytMid != null) {
    const marginY = Math.round(0.35 * PITCH_FRAC * w);
    const s = plate.slope ?? 0;
    for (let x = 0; x < w; x++) {
      const yLim = Math.min(h, Math.ceil(plate.ytMid + s * (x - w / 2) + marginY));
      for (let y = 0; y < yLim; y++) resp[y * w + x] = 0;
    }
  }
  if (plate.botFound && plate.ybMid != null) {
    const marginY = Math.round(0.35 * PITCH_FRAC * w);
    const s = plate.slope ?? 0;
    for (let x = 0; x < w; x++) {
      const yLim = Math.max(0, Math.floor(plate.ybMid + s * (x - w / 2) - marginY));
      for (let y = yLim; y < h; y++) resp[y * w + x] = 0;
    }
  }
  // The robot's dot spacing is fixed, so look close to the usual spacing first and only widen the search
  // if that finds nothing convincing (cropped plate or shifted camera scale).
  const plateFrac = plate.found ? (plate.xr - plate.xl) / w : 0;
  const first = detectWith(resp, ch, w, h, 0.04, plate);
  let best = first;
  if (first.confidence < 0.4) {
    const wide = detectWith(resp, ch, w, h, 0.14, plate);
    if (wide.confidence > best.confidence) best = wide;
  }
  // When the user tightly crops the photo to the plate (>78% of frame width), the physical dot spacing
  // scales up with plateFrac, so always test the scaled pitch even if PITCH_FRAC matched a sub-harmonic.
  if (plateFrac > 0.78) {
    const estPitchFrac = 0.0322 * plateFrac;
    const cropped = detectWith(resp, ch, w, h, 0.08, plate, estPitchFrac);
    const bestSeen = (best.lower?.seen ?? 0) + (best.upper?.seen ?? 0);
    const cropSeen = (cropped.lower?.seen ?? 0) + (cropped.upper?.seen ?? 0);
    const fullSideBorders = plate.xl > 2 && plate.xr < w - 3;
    if (
      cropped.confidence > best.confidence + 0.05 ||
      (cropped.ok && cropped.confidence >= best.confidence - 0.03 && cropSeen > bestSeen) ||
      (fullSideBorders &&
        cropSeen >= Math.max(10, Math.round(bestSeen * 0.78)) &&
        cropped.confidence >= best.confidence - 0.05)
    ) {
      best = cropped;
    }
  }
  return best;
}

function detectWith(
  resp: Float32Array,
  ch: Float32Array[],
  w: number,
  h: number,
  range: number,
  plate?: PlateExtent,
  pitchFrac: number = PITCH_FRAC
): LaneDetection {
  const lowOpts = findRows(resp, w, h, 'lower', range, plate, pitchFrac).slice(0, 6);
  const upOpts = findRows(resp, w, h, 'upper', range, plate, pitchFrac).slice(0, 6);
  let lower: DetectedRow | null = lowOpts[0]?.row ?? null;
  let upper: DetectedRow | null = upOpts[0]?.row ?? null;
  let paired = false;
  let bestPairScore = -1;

  for (const lo of lowOpts) {
    for (const up of upOpts) {
      const shared = pickSharedWindow(lo.line, up.line, w, plate);
      if (!shared) continue;
      // Each row's height/pitch/outer-row prior must count in pairing, or a dense spot row can beat the origin row on dot count alone.
      const outerMult = (lo.supersededByOuter ? 0.45 : 1) * (up.supersededByOuter ? 0.45 : 1);
      const sc =
        (shared.jointScore * (0.5 + 0.5 * Math.min(lo.priorFactor, up.priorFactor)) + 0.15 * (lo.adj + up.adj)) * outerMult;
      if (sc > bestPairScore) {
        bestPairScore = sc;
        lower = shared.lower;
        upper = shared.upper;
        paired = true;
      }
    }
  }

  if (lower) lower = refineRowHeight(resp, ch, w, h, lower);
  if (upper) upper = refineRowHeight(resp, ch, w, h, upper);

  const warnings: string[] = [];
  const det: LaneDetection = { ok: false, confidence: 0, lower, upper, workWidth: w, workHeight: h, warnings };
  if (!lower && !upper) {
    warnings.push('No row of origin dots was found. Try the UV 254 image, which shows them best.');
    return det;
  }

  // Pool spacing across both halves when paired so both halves share one exact pitch.
  if (lower && upper) {
    const pl = lower.pitch;
    const pu = upper.pitch;
    if (Math.abs(pl - pu) / Math.max(pl, pu) < 0.02) {
      const pooled = (pl * lower.seen + pu * upper.seen) / Math.max(1, lower.seen + upper.seen);
      for (const r of [lower, upper]) {
        const mid = r.x0 + (r.pitch * (LANES_PER_HALF - 1)) / 2;
        r.pitch = pooled;
        r.x0 = mid - (pooled * (LANES_PER_HALF - 1)) / 2;
      }
    } else {
      warnings.push('The two dot rows have different spacing; check the result by eye.');
    }
  }

  if (lower && upper && !paired) {
    warnings.push('The two dot rows do not align within half a lane; check the result by eye.');
  }

  let conf = 0;
  const rows = [lower, upper].filter(Boolean) as DetectedRow[];
  for (const r of rows) {
    const cover = Math.min(1, r.seen / 18);
    const tight = Math.max(0, 1 - r.residual / 0.12);
    const pr = r.pitch / w;
    const sane =
      Math.abs(pr - pitchFrac) / pitchFrac < 0.1 &&
      Math.abs(r.angleDeg) < 4 &&
      (plate?.angleDeg == null || Math.abs(r.angleDeg - plate.angleDeg) < 2.2)
        ? 1
        : 0.4;
    conf += (cover * 0.6 + tight * 0.4) * sane;
    if (r.seen < 12) warnings.push(`Only ${r.seen} of 27 origin dots are visible on the ${r.half} half.`);
    if (Math.abs(r.angleDeg) >= 4) warnings.push(`The ${r.half} row is tilted by ${r.angleDeg.toFixed(1)}°.`);
  }
  conf /= 2; // a missing half counts against confidence

  if (lower && upper && !paired) conf = Math.min(conf, 0.3);
  if (!lower || !upper) warnings.push(`Found the ${lower ? 'lower' : 'upper'} dot row only.`);

  // Soft framing warning: if cropped/shifted outside usual holder position, warn and reduce confidence
  // without discarding the detected lanes.
  for (const r of rows) {
    const rRad = (r.angleDeg * Math.PI) / 180;
    const halfSpan = r.pitch * ((LANES_PER_HALF - 1) / 2);
    const xMid = r.x0 + Math.cos(rRad) * halfSpan;
    const yMid = r.y0 + Math.sin(rRad) * halfSpan;
    const yFrac = yMid / h;
    const pSlope = plate?.slope ?? 0;
    const ytAtX = plate?.ytMid != null ? plate.ytMid + pSlope * (xMid - w / 2) : null;
    const ybAtX = plate?.ybMid != null ? plate.ybMid + pSlope * (xMid - w / 2) : null;
    const okY =
      r.half === 'lower' && plate?.botFound && ybAtX != null
        ? (ybAtX - yMid) / r.pitch >= 0.36 && (ybAtX - yMid) / r.pitch <= 4.8
        : r.half === 'upper' && plate?.topFound && ytAtX != null
        ? (yMid - ytAtX) / r.pitch >= 0.36 && (yMid - ytAtX) / r.pitch <= 4.8
        : r.half === 'lower'
        ? yFrac > 0.85 && yFrac < 0.95
        : yFrac > 0.09 && yFrac < 0.2;
    const okX = Math.abs(xMid - w / 2) < 2 * r.pitch;
    if (!okY || !okX) {
      conf = Math.min(conf, 0.35);
      warnings.push(`The ${r.half} row sits outside the usual plate framing; check alignment by eye.`);
    }
  }

  det.confidence = Math.max(0, Math.min(1, conf));
  det.ok = det.confidence >= 0.45;
  return det;
}

// ---------------------------------------------------------------- lane config

/**
 * Build the lane table from a detection. Positions are returned in the lane-frame units used
 * everywhere else (frameWidth wide, normally 3280).
 */
export function laneConfigFromDetection(
  det: LaneDetection,
  frameWidth: number = LANE_FRAME_WIDTH
): TlcLaneConfig {
  const k = frameWidth / det.workWidth; // working px -> frame units
  const lanes: TlcLane[] = [];
  const warnings = [...det.warnings];
  const rows = { lower: det.lower, upper: det.upper };
  // Fall back to the other half, mirrored about the plate, when only one row was found.
  const pitchFrame = (det.lower ?? det.upper)!.pitch * k;
  const s = pitchFrame / REF_PITCH;
  for (const half of ['lower', 'upper'] as const) {
    let r = rows[half];
    const other = half === 'lower' ? rows.upper : rows.lower;
    let approx = false;
    if (!r && other) {
      r = { ...other, half };
      approx = true;
      warnings.push(`The ${half} half is a copy of the other half's column positions; its height is a guess.`);
    }
    if (!r) continue;
    const a = (r.angleDeg * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const theta = half === 'lower' ? r.angleDeg : 180 + r.angleDeg;
    // Lane axis: up for the lower half, down for the upper half.
    const dx = half === 'lower' ? Math.sin(a) : -Math.sin(a);
    const dy = half === 'lower' ? -Math.cos(a) : Math.cos(a);
    const baseZero = REF_ZERO_RF * s;
    const y0Row = approx ? (half === 'lower' ? det.workHeight * 0.9 : det.workHeight * 0.145) : r.y0;
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const dotX = (r.x0 + ux * r.pitch * i) * k;
      const dotY = (y0Row + uy * r.pitch * i) * k;
      const dyOff = !approx && r.yOffsets ? (r.yOffsets[i] ?? 0) * k : 0;
      const laneZero = Math.max(
        10,
        baseZero + ((half === 'lower' ? -1 : 1) * dyOff) / Math.max(0.5, Math.cos(a))
      );
      lanes.push({
        id: (half === 'lower' ? 0 : LANES_PER_HALF) + i,
        x0: Math.round((dotX - dx * baseZero) * 10) / 10,
        y0: Math.round((dotY - dy * baseZero) * 10) / 10,
        length: Math.round(REF_LENGTH * s),
        width: Math.round(REF_WIDTH * s),
        angle: Math.round(theta * 100) / 100,
        spotRadius: Math.round(REF_SPOT_RADIUS * s),
        zeroRf: Math.round(laneZero * 10) / 10,
      });
    }
  }
  lanes.sort((a, b) => a.id - b.id);
  return { lanes, hasZeroRf: true, warnings };
}

/** Convenience: detect and build in one call. */
export function autoDetectLanes(img: RasterImage, frameWidth: number = LANE_FRAME_WIDTH) {
  const det = detectLaneRows(img);
  if (!det.lower && !det.upper) return { det, cfg: null as TlcLaneConfig | null };
  return { det, cfg: laneConfigFromDetection(det, frameWidth) };
}
