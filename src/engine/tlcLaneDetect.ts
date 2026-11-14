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
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        s += src[row + xx] * k[i + r];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        s += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = s;
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
  const sigma = Math.max(1.2, (w / 3280) * 7.5);
  const ya = Math.floor(h * 0.15);
  const yb = Math.max(ya + 1, Math.ceil(h * 0.85));
  const xa = Math.floor(w * 0.15);
  const xb = Math.max(xa + 1, Math.ceil(w * 0.85));
  const stepY = Math.max(1, Math.floor((yb - ya) / 25));
  const stepX = Math.max(1, Math.floor((xb - xa) / 25));
  const samp: number[] = [];

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

    const g = gaussBlur(c, w, h, sigma);
    const m = boxBlur(c, w, h, Math.max(4, Math.round(sigma * 6)));
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gxx = g[i + 1] - 2 * g[i] + g[i - 1];
        const gyy = g[i + w] - 2 * g[i] + g[i - w];
        const gxy = (g[i + w + 1] - g[i + w - 1] - g[i - w + 1] + g[i - w - 1]) / 4;
        const tr = (gxx + gyy) / 2;
        const d = Math.sqrt(((gxx - gyy) / 2) ** 2 + gxy * gxy);
        const l1 = tr + d; // larger eigenvalue
        const l2 = tr - d;
        const v = Math.max(l1 < 0 ? -l1 : 0, l2 > 0 ? l2 : 0); // both negative or both positive
        const s = ((v * sigma * sigma) / (Math.max(m[i], mFloor) + 15)) * 100;
        if (s > out[i]) out[i] = s;
      }
    }
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
function rowHypotheses(c: Cand[], w: number, cap: number, want = 5): RowHyp[] {
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
    // Skip near-duplicates of a row we already have.
    if (out.some((o) => Math.abs(o.yMid - v.y) < binH * 3 && Math.abs(o.slope - v.slope) < 0.012)) continue;
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
  range: number
): CombLine | null {
  const near = c.filter((p) => Math.abs(p.y - (hyp.yMid + hyp.slope * (p.x - w / 2))) < w * 0.012);
  if (near.length < 5) return null;
  const wt = (p: Cand) => Math.min(p.v, cap);

  // 1. Periodicity: for each pitch and phase, how much dot strength lands on a comb tooth.
  let best = { s: -1, p: 0, phi: 0 };
  for (let p = PITCH_FRAC * (1 - range) * w; p <= PITCH_FRAC * (1 + range) * w; p += 0.0001 * w) {
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

function pickSingleWindow(line: CombLine, w: number): { s0: number; score: number; row: DetectedRow } {
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
    const score = seen + 0.25 * strength + 1 - 1.0 * off;
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
  w: number
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
    const score = seen + 0.25 * strength + 2 - 1.8 * off;
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
  priorFactor: number;
  adj: number;
}

/** Every plausible dot row in one half of the plate, best first. */
function findRows(resp: Float32Array, w: number, h: number, half: 'lower' | 'upper', range: number): RowOption[] {
  const band: [number, number] = half === 'lower' ? [h * 0.62, h * 0.985] : [h * 0.015, h * 0.38];
  const c = candidates(resp, w, h, band[0], band[1]);
  if (c.length < 6) return [];
  const sorted = c.map((p) => p.v).sort((a, b) => a - b);
  const cap = sorted[Math.floor(sorted.length * 0.85)] || 1;
  const hyps = rowHypotheses(c, w, cap, 6);
  const out: RowOption[] = [];
  // The plate sits in a fixed holder, so the origin dots are expected near one height; use as a tie-breaker.
  const prior = half === 'lower' ? 0.9 : 0.145;
  for (const hyp of hyps) {
    const line = fitCombLine(c, w, hyp, cap, half, range);
    if (!line) continue;
    const picked = pickSingleWindow(line, w);
    if (picked.row.seen < 6) continue;
    const miss = Math.min(1, Math.abs(picked.row.y0 / h - prior) / 0.08);
    const dev = Math.abs(picked.row.pitch / w - PITCH_FRAC) / PITCH_FRAC;
    const priorFactor = (1 - 0.4 * miss) * (1 - 0.5 * Math.min(1, dev / 0.03));
    const adj = picked.score * priorFactor;
    out.push({ line, row: picked.row, priorFactor, adj });
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

    // Tiny ridge on quadratic term keeps sparse edge extrapolation stable
    s22 += 0.05;
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
  if (maxI - minI < 12) return null;

  const resSorted = hits
    .map((h) => {
      const u = uOf(h.i);
      return Math.abs(h.res - (c0 + c1 * u + c2 * u * u));
    })
    .sort((a, b) => a - b);
  return {
    coeffs: [c0, c1, c2],
    medRes: resSorted[resSorted.length >> 1],
    agree: inliers.length,
  };
}

/**
 * Refine a coarse blob peak `yHit` on the raw intensity strip along `(cx, y)` by finding the
 * symmetric 60%-peak connected dot core, removing Hessian curvature drift on flat-topped or
 * slightly tailing origin deposits.
 */
function refineDotCoreY(
  ch: Float32Array[],
  w: number,
  h: number,
  cx: number,
  yHit: number,
  p: number
): number {
  const halfH = Math.max(6, Math.round(0.55 * p));
  const yMin = Math.max(0, Math.round(yHit - halfH));
  const yMax = Math.min(h - 1, Math.round(yHit + halfH));
  const len = yMax - yMin + 1;
  if (len < 7) return yHit;

  const xA = Math.max(0, Math.round(cx - 0.14 * p));
  const xB = Math.min(w - 1, Math.round(cx + 0.14 * p));
  const xCount = Math.max(1, xB - xA + 1);
  const hitIdx = Math.max(1, Math.min(len - 2, Math.round(yHit) - yMin));
  const flankLo = Math.max(0, hitIdx - Math.max(3, Math.round(0.24 * p)));
  const flankHi = Math.min(len - 1, hitIdx + Math.max(3, Math.round(0.24 * p)));

  let bestChanProf: number[] | null = null;
  let bestSign = -1;
  let bestBg = 0;
  let bestContrast = 0;

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

    const coreVal = (sm[hitIdx - 1] + sm[hitIdx] + sm[hitIdx + 1]) / 3;
    const upperFlank = sm.slice(0, flankLo + 1).sort((a, b) => a - b);
    const lowerFlank = sm.slice(flankHi).sort((a, b) => a - b);
    const medUp = upperFlank.length ? upperFlank[upperFlank.length >> 1] : coreVal;
    const medLo = lowerFlank.length ? lowerFlank[lowerFlank.length >> 1] : coreVal;

    const bgDark = Math.max(medUp, medLo);
    const bgBright = Math.min(medUp, medLo);
    const cDark = bgDark - coreVal;
    const cBright = coreVal - bgBright;

    if (cDark > bestContrast) {
      bestContrast = cDark;
      bestSign = -1;
      bestBg = bgDark;
      bestChanProf = sm;
    }
    if (cBright > bestContrast) {
      bestContrast = cBright;
      bestSign = 1;
      bestBg = bgBright;
      bestChanProf = sm;
    }
  }

  if (!bestChanProf || bestContrast < 8) return yHit;

  const sm = bestChanProf;
  const sigAt = (k: number) => Math.max(0, bestSign * (sm[k] - bestBg));
  const hitSig = sigAt(hitIdx);
  const searchR = Math.max(3, Math.round(0.24 * p));

  let loConn = hitIdx;
  while (loConn > Math.max(1, hitIdx - searchR) && sigAt(loConn - 1) >= 0.45 * hitSig) loConn--;
  let hiConn = hitIdx;
  while (hiConn < Math.min(len - 2, hitIdx + searchR) && sigAt(hiConn + 1) >= 0.45 * hitSig) hiConn++;

  let coreMax = hitSig;
  for (let k = loConn; k <= hiConn; k++) {
    const v = sigAt(k);
    if (v > coreMax) coreMax = v;
  }
  if (coreMax < 8) return yHit;

  let pLo = -1;
  let pHi = -1;
  for (let k = loConn; k <= hiConn; k++) {
    if (sigAt(k) >= 0.88 * coreMax) {
      if (pLo === -1) pLo = k;
      pHi = k;
    }
  }
  const seed = pLo !== -1 ? Math.round(0.5 * (pLo + pHi)) : hitIdx;
  const thr = 0.60 * coreMax;
  const maxHalf = Math.max(4, Math.round(0.32 * p));

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

  const mid = 0.5 * (leftY + rightY);
  let sumW = 0;
  let sumPos = 0;
  for (let k = l; k <= r; k++) {
    const wt = Math.max(0, sigAt(k) - thr);
    sumW += wt;
    sumPos += k * wt;
  }
  const centroid = sumW > 0 ? sumPos / sumW : mid;
  const refined = yMin + 0.65 * mid + 0.35 * centroid;
  if (Math.abs(refined - yHit) > 0.28 * p) return yHit;
  return refined;
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
  const thr = 0.45 * medianRef;
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
  // Theil-Sen line through (x, y): median of pairwise slopes, then median intercept.
  const slopes: number[] = [];
  for (let i = 0; i < hits.length; i++)
    for (let j = i + 1; j < hits.length; j++)
      if (Math.abs(hits[j].x - hits[i].x) > 5 * p) slopes.push((hits[j].y - hits[i].y) / (hits[j].x - hits[i].x));
  slopes.sort((a, b) => a - b);
  const slope = slopes.length ? slopes[Math.floor(slopes.length / 2)] : Math.tan(a0);
  const icpt = hits.map((q) => q.y - slope * q.x).sort((a, b) => a - b);
  const b = icpt[Math.floor(icpt.length / 2)];
  const res = hits.map((q) => Math.abs(q.y - (b + slope * q.x))).sort((a, b) => a - b);
  const medRes = res[Math.floor(res.length / 2)];
  const agree = hits.filter((q) => Math.abs(q.y - (b + slope * q.x)) < 0.18 * p).length;

  // Also check if a gentle smooth quadratic bow explains the residuals even more tightly.
  const quad = fitSmoothQuadOffsets(
    hits.map((q) => ({ i: q.i, res: q.y - (b + slope * q.x) })),
    p
  );
  const useQuad = quad !== null && quad.agree >= 10 && quad.medRes <= 0.16 * p;
  if (!useQuad && (agree < 10 || medRes > 0.16 * p)) return row;

  const ang = Math.atan(slope);
  const x0 = row.x0;
  const y0 = b + slope * x0;
  const cosA = Math.max(0.5, Math.cos(ang));
  const backboneOf = (i: number) => {
    if (!useQuad || !quad) return 0;
    const u = (i - (LANES_PER_HALF - 1) / 2) / ((LANES_PER_HALF - 1) / 2);
    return (quad.coeffs[0] + quad.coeffs[1] * u + quad.coeffs[2] * u * u) / cosA;
  };

  // Second pass: lock each individual lane onto its own origin dot center within +/-0.30*p of
  // the row backbone so non-straight experimental spotting variation across lanes is preserved.
  const localThr = 0.35 * medianRef;
  const perLaneOff: number[] = new Array(LANES_PER_HALF).fill(NaN);
  const backboneOff: number[] = Array.from({ length: LANES_PER_HALF }, (_, i) => backboneOf(i));

  for (let i = 0; i < LANES_PER_HALF; i++) {
    const px = x0 + Math.cos(ang) * p * i;
    const pyLine = y0 + Math.sin(ang) * p * i;
    const pyBackbone = pyLine + backboneOff[i] * cosA;
    const ya = Math.max(rad, Math.round(pyBackbone - 0.30 * p));
    const yb = Math.min(h - rad - 1, Math.round(pyBackbone + 0.30 * p));
    const xa = Math.max(rad, Math.round(px - 0.22 * p));
    const xb = Math.min(w - rad - 1, Math.round(px + 0.22 * p));

    let bestX = -1;
    let bestY = NaN;
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
        const sc = v / medianRef + 0.18 * ((y - pyBackbone) * outer) / p - 0.30 * Math.abs(y - pyBackbone) / p;
        if (sc > bestS) {
          bestX = x;
          bestY = y;
          bestS = sc;
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
        bestY = refineDotCoreY(ch, w, h, bestX, bestY, p);
      }
      perLaneOff[i] = (bestY - pyLine) / cosA;
    }
  }

  // Interpolate deviations across blank/unspotted wells cleanly relative to the backbone.
  const validIndices: number[] = [];
  for (let i = 0; i < LANES_PER_HALF; i++) {
    if (!Number.isNaN(perLaneOff[i])) validIndices.push(i);
  }

  const rawOffsets = Array.from({ length: LANES_PER_HALF }, (_, i) => {
    let off = perLaneOff[i];
    if (Number.isNaN(off)) {
      if (validIndices.length === 0) {
        off = backboneOff[i];
      } else {
        let left = -1;
        let right = -1;
        for (const k of validIndices) {
          if (k < i) left = k;
          else if (k > i && right === -1) right = k;
        }
        if (left !== -1 && right !== -1) {
          const dL = perLaneOff[left] - backboneOff[left];
          const dR = perLaneOff[right] - backboneOff[right];
          const f = (i - left) / (right - left);
          off = backboneOff[i] + dL + (dR - dL) * f;
        } else {
          const near = left !== -1 ? left : right;
          const dist = Math.abs(i - near);
          const dN = perLaneOff[near] - backboneOff[near];
          off = backboneOff[i] + dN * Math.exp(-dist / 2);
        }
      }
    }
    return Math.max(-0.45 * p, Math.min(0.45 * p, off));
  });

  const finalRes = useQuad && quad ? Math.min(medRes, quad.medRes) : medRes;
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

export function detectLaneRows(img: RasterImage, workWidth: number = WORK_WIDTH): LaneDetection {
  const { ch, w, h } = downscale(img, workWidth);
  const resp = blobResponse(ch, w, h);
  // The robot's dot spacing is fixed, so look close to the usual spacing first and only widen the search
  // if that finds nothing convincing (cropped plate or shifted camera scale).
  const first = detectWith(resp, ch, w, h, 0.04);
  if (first.confidence >= 0.4) return first;
  const wide = detectWith(resp, ch, w, h, 0.14);
  return wide.confidence > first.confidence ? wide : first;
}

function detectWith(resp: Float32Array, ch: Float32Array[], w: number, h: number, range: number): LaneDetection {
  const lowOpts = findRows(resp, w, h, 'lower', range).slice(0, 4);
  const upOpts = findRows(resp, w, h, 'upper', range).slice(0, 4);
  let lower: DetectedRow | null = lowOpts[0]?.row ?? null;
  let upper: DetectedRow | null = upOpts[0]?.row ?? null;
  let paired = false;
  let bestPairScore = -1;

  for (const lo of lowOpts) {
    for (const up of upOpts) {
      const shared = pickSharedWindow(lo.line, up.line, w);
      if (!shared) continue;
      // Each row's height/pitch prior must count in pairing, or a dense spot row can beat the origin row on dot count alone.
      const sc = shared.jointScore * (0.5 + 0.5 * Math.min(lo.priorFactor, up.priorFactor)) + 0.15 * (lo.adj + up.adj);
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
    const sane = Math.abs(pr - PITCH_FRAC) / PITCH_FRAC < 0.1 && Math.abs(r.angleDeg) < 4 ? 1 : 0.4;
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
    const yFrac = r.y0 / h;
    const okY = r.half === 'lower' ? yFrac > 0.85 && yFrac < 0.95 : yFrac > 0.09 && yFrac < 0.2;
    const centre = r.x0 + (r.pitch * (LANES_PER_HALF - 1)) / 2;
    const okX = Math.abs(centre - w / 2) < 2 * r.pitch;
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
