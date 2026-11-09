// Robowski Studio - TLC edge-effect (lateral migration speed) correction.
//
// Model: a spot that has run a true distance h in a lane at lateral position x ends up at
// h * g(x). g(x) is the relative migration speed (1 at the middle of the plate). Taking logs,
//   ln(position) = ln(h) + ln g(x)
// so the same compound (same Rf) found in many lanes lines up on a curve across the plate.
//
// g is fitted separately for every half of a plate:
//   1. spots from all lanes of the half are grouped by Rf (same compound -> same group),
//   2. within each group the group's own mean is removed (this removes the compound's true Rf),
//   3. what is left, ln g(x), is a quadratic in the lateral position, fitted by least squares
//      over all groups at once, with g = 1 at the middle of the half.
// The correction is only switched on when the fit is stable (it must survive dropping any
// single group) and large enough to matter.

export interface EdgePoint {
  rf?: number; // measured Rf of the spot (used by the picked-spot fit; derived from h when absent)
  lane: number;
  x: number; // lateral position of the lane (any consistent unit, e.g. frame px)
  h: number; // distance of the spot from the origin line (px)
}

/** A spot the user picked as 'same compound': lane, position along the lane (px), compound group. */
export interface EdgePick {
  lane: number;
  pos: number;
  group: number;
}

export interface EdgeFit {
  ok: boolean;
  reason: string;
  xm: number; // middle of the half, g = 1 here
  hr: number; // half range of the lane positions
  c1: number; // ln g(u) = c1*u + c2*u^2 with u = (x - xm) / hr
  c2: number;
  nClusters: number;
  nSpots: number;
  maxShift: number; // largest |g - 1| inside the half
  scatter: number; // residual SD of ln position (fraction)
  stable: boolean;
  fromPicks: boolean; // fitted on spots the user picked (the only case Auto applies)
  xmin: number;
  xmax: number;
  // for the diagnostic plot: lateral position (u) and ln-position residual of every used spot
  used: { u: number; y: number }[];
  // Picked-spot model: measured Rf = true Rf * (1 + s(u)) + b(u), with s and b polynomials in u (no constant).
  sCoef?: number[]; // coefficients of u^1..u^D
  bCoef?: number[]; // coefficients of u^1..u^Db, in Rf units (offset)
  model?: string; // which model cross-validation chose
  rbar?: number; // mean Rf of the picked spots (for drawing the curve)
}

export const EDGE_CLUSTER_TOL = 0.04; // spots closer than 4 % in position are the same group
export const EDGE_MIN_GROUP_SPOTS = 5;
export const EDGE_MIN_GROUP_LANES = 5;
export const EDGE_MIN_CLUSTERS = 3;
export const EDGE_MIN_SPOTS = 20;
export const EDGE_MIN_SHIFT = 0.01;
export const EDGE_MIN_SNR = 1.5; // curve at the edges must exceed 1.5x the scatter between lanes

interface Row {
  u: number;
  y: number;
  g: number; // group index
}

/** Least squares for y = c1*u + c2*u^2 after removing each group's own mean. */
function withinFit(rows: Row[], skipGroup = -1): { c1: number; c2: number; resid: number; n: number } {
  const byG = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.g === skipGroup) continue;
    if (!byG.has(r.g)) byG.set(r.g, []);
    byG.get(r.g)!.push(r);
  }
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0, n = 0;
  const dm: { a: number; b: number; y: number }[] = [];
  for (const rs of byG.values()) {
    const mu = rs.reduce((p, r) => p + r.u, 0) / rs.length;
    const mu2 = rs.reduce((p, r) => p + r.u * r.u, 0) / rs.length;
    const my = rs.reduce((p, r) => p + r.y, 0) / rs.length;
    for (const r of rs) {
      const a = r.u - mu;
      const b = r.u * r.u - mu2;
      const y = r.y - my;
      s11 += a * a; s12 += a * b; s22 += b * b; t1 += a * y; t2 += b * y; n++;
      dm.push({ a, b, y });
    }
  }
  const det = s11 * s22 - s12 * s12;
  if (n < 4 || Math.abs(det) < 1e-12) return { c1: 0, c2: 0, resid: NaN, n };
  const c1 = (t1 * s22 - t2 * s12) / det;
  const c2 = (t2 * s11 - t1 * s12) / det;
  let rss = 0;
  for (const d of dm) rss += (d.y - c1 * d.a - c2 * d.b) ** 2;
  return { c1, c2, resid: Math.sqrt(rss / Math.max(1, n - byG.size - 2)), n };
}

const shiftAt = (c1: number, c2: number, u: number) => Math.expm1(c1 * u + c2 * u * u);
function maxShiftOf(c1: number, c2: number): number {
  let m = 0;
  for (let t = 0; t <= 20; t++) m = Math.max(m, Math.abs(shiftAt(c1, c2, -1 + t / 10)));
  return m;
}

interface Ctx {
  xm: number;
  hr: number;
  xmin: number;
  xmax: number;
  fromPicks: boolean;
  snr: number;
  minShift: number;
}

function emptyFit(c: Ctx, reason: string, extra: Partial<EdgeFit> = {}): EdgeFit {
  return {
    ok: false,
    reason,
    xm: c.xm,
    hr: c.hr,
    c1: 0,
    c2: 0,
    nClusters: 0,
    nSpots: 0,
    maxShift: 0,
    scatter: 0,
    stable: false,
    fromPicks: c.fromPicks,
    xmin: c.xmin,
    xmax: c.xmax,
    used: [],
    ...extra,
  };
}

/** Fit ln g(u) = c1*u + c2*u^2 from rows (one group = one compound) and judge whether to trust it. */
function solve(rows: Row[], gi: number, c: Ctx): EdgeFit {
  const f = withinFit(rows);
  if (!isFinite(f.resid)) {
    return emptyFit(c, 'The spots are too close together across the plate to fit a curve.', { nClusters: gi, nSpots: rows.length });
  }
  const full = maxShiftOf(f.c1, f.c2);
  let stable = true;
  for (let g = 0; g < gi && gi >= 2; g++) {
    const fg = withinFit(rows, g);
    if (!isFinite(fg.resid)) { stable = false; break; }
    const sg = maxShiftOf(fg.c1, fg.c2);
    const sameSign = Math.sign(fg.c2) === Math.sign(f.c2) || Math.abs(fg.c2) < 1e-3;
    if (!sameSign || sg < 0.5 * full) { stable = false; break; }
  }
  const mean = new Map<number, { s: number; n: number }>();
  for (const r of rows) {
    const m = mean.get(r.g) || { s: 0, n: 0 };
    m.s += r.y; m.n++;
    mean.set(r.g, m);
  }
  const used = rows.map((r) => ({ u: r.u, y: r.y - mean.get(r.g)!.s / mean.get(r.g)!.n }));
  const base: EdgeFit = {
    ok: true,
    reason: '',
    xm: c.xm,
    hr: c.hr,
    c1: f.c1,
    c2: f.c2,
    nClusters: gi,
    nSpots: rows.length,
    maxShift: full,
    scatter: f.resid,
    stable,
    fromPicks: c.fromPicks,
    xmin: c.xmin,
    xmax: c.xmax,
    used,
  };
  if (!stable) return { ...base, ok: false, reason: 'The curve changes sign or size when one compound is left out, so it is not reliable.' };
  if (c.fromPicks && f.resid > PICK_MAX_SCATTER) {
    return { ...base, ok: false, reason: `The picked spots do not agree with each other (scatter ${(f.resid * 100).toFixed(1)} %, limit ${(PICK_MAX_SCATTER * 100).toFixed(0)} %). Are they really the same compound?` };
  }
  if (full < c.snr * f.resid) {
    return { ...base, ok: false, reason: `The curve (${(full * 100).toFixed(1)} % at the edges) is not clearly larger than the scatter between ${c.fromPicks ? 'the picked spots' : 'lanes'} (${(f.resid * 100).toFixed(1)} %).${c.fromPicks ? '' : ' Picking spots of the same compound would settle it.'}` };
  }
  if (full < c.minShift) {
    return { ...base, ok: false, reason: `The curve is negligible (${(full * 100).toFixed(1)} % at the edges).` };
  }
  return base;
}

function context(xsAll: number[], fromPicks: boolean, snr: number, minShift: number): Ctx {
  const xmin = xsAll.length ? Math.min(...xsAll) : 0;
  const xmax = xsAll.length ? Math.max(...xsAll) : 0;
  return { xm: (xmin + xmax) / 2, hr: Math.max(1e-9, (xmax - xmin) / 2), xmin, xmax, fromPicks, snr, minShift };
}

/**
 * Automatic estimate: spots from every lane are grouped by position, hoping that the same compound
 * lines up across lanes. This is only a suggestion; Auto does not apply it (see edgeActive).
 */
export function fitEdgeCurve(
  points: EdgePoint[],
  opt: { tol?: number; minClusters?: number; minSpots?: number; minShift?: number; snr?: number } = {}
): EdgeFit {
  const tol = opt.tol ?? EDGE_CLUSTER_TOL;
  const minClusters = opt.minClusters ?? EDGE_MIN_CLUSTERS;
  const minSpots = opt.minSpots ?? EDGE_MIN_SPOTS;
  const pts = points.filter((p) => p.h > 0 && isFinite(p.x));
  const c = context(pts.map((p) => p.x), false, opt.snr ?? EDGE_MIN_SNR, opt.minShift ?? EDGE_MIN_SHIFT);

  const sorted = pts.map((p) => ({ ...p, y: Math.log(p.h) })).sort((a, b) => a.y - b.y);
  const groups: (typeof sorted)[] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && p.y - g[g.length - 1].y < tol) g.push(p);
    else groups.push([p]);
  }
  const rows: Row[] = [];
  let gi = 0;
  for (const g of groups) {
    const lanes = new Set(g.map((p) => p.lane));
    const spread = g[g.length - 1].y - g[0].y;
    if (g.length >= EDGE_MIN_GROUP_SPOTS && lanes.size >= EDGE_MIN_GROUP_LANES && spread < 0.25) {
      for (const p of g) rows.push({ u: (p.x - c.xm) / c.hr, y: p.y, g: gi });
      gi++;
    }
  }
  if (gi < minClusters || rows.length < minSpots) {
    return emptyFit(
      c,
      `Not enough repeated compounds to measure the curve (${gi} group(s) over ${rows.length} spots; need ${minClusters} over ${minSpots}).`,
      { nClusters: gi, nSpots: rows.length }
    );
  }
  return solve(rows, gi, c);
}

export const PICK_MIN_SPOTS = 4;
export const PICK_MIN_LANES = 3;
export const PICK_MAX_SCATTER = 0.06; // picked spots must agree within 6 % after the curve is removed
export const PICK_MIN_SNR = 1.5; // the curve must be at least 1.5x the scatter of the picked spots
export const PICK_MIN_F = 6; // F statistic of the curve against no curve
export const PICK_MIN_COVERAGE = 0.5; // picked spots must span at least half of the plate width

interface PRow {
  u: number;
  y: number; // measured Rf / group mean Rf
  g: number;
  r: number; // group mean Rf
}

interface ModelSpec {
  D: number; // degree of the multiplicative part s(u)
  Db: number; // degree of the offset part b(u)
  name: string;
}

const MODELS: ModelSpec[] = [
  { D: 2, Db: 0, name: 'parabola' },
  { D: 4, Db: 0, name: 'sharper edges' },
  { D: 2, Db: 2, name: 'parabola + offset' },
  { D: 4, Db: 2, name: 'sharper edges + offset' },
];

function features(r: PRow, m: ModelSpec): number[] {
  const f: number[] = [];
  for (let k = 1; k <= m.D; k++) f.push(r.u ** k);
  for (let k = 1; k <= m.Db; k++) f.push(r.u ** k / r.r);
  return f;
}

/** Solve a small ridge-regularised normal system by Gaussian elimination. */
function solveSystem(A: number[][], bvec: number[]): number[] | null {
  const n = bvec.length;
  const M = A.map((row, i) => [...row, bvec[i]]);
  for (let i = 0; i < n; i++) M[i][i] += 1e-9 * (1 + Math.abs(M[i][i]));
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    if (Math.abs(M[piv][i]) < 1e-14) return null;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let v = M[i][n];
    for (let c = i + 1; c < n; c++) v -= M[i][c] * x[c];
    x[i] = v / M[i][i];
  }
  return x;
}

/** Within-group least squares. Returns coefficients and the group means (needed to predict). */
function fitRows(rows: PRow[], m: ModelSpec, skip = -1, skipGroup = -1) {
  const p = m.D + m.Db;
  const idx = rows.map((_, i) => i).filter((i) => i !== skip && rows[i].g !== skipGroup);
  const byG = new Map<number, number[]>();
  for (const i of idx) byG.set(rows[i].g, [...(byG.get(rows[i].g) || []), i]);
  const means = new Map<number, { f: number[]; y: number }>();
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const bv = new Array(p).fill(0);
  let n = 0;
  for (const [g, is] of byG) {
    if (is.length < 2) continue;
    const F = is.map((i) => features(rows[i], m));
    const mf = new Array(p).fill(0);
    let my = 0;
    F.forEach((f, k) => {
      f.forEach((v, j) => (mf[j] += v / is.length));
      my += rows[is[k]].y / is.length;
    });
    means.set(g, { f: mf, y: my });
    F.forEach((f, k) => {
      const d = f.map((v, j) => v - mf[j]);
      const yy = rows[is[k]].y - my;
      for (let a = 0; a < p; a++) {
        bv[a] += d[a] * yy;
        for (let b = 0; b < p; b++) A[a][b] += d[a] * d[b];
      }
      n++;
    });
  }
  const coef = n > p ? solveSystem(A, bv) : null;
  return { coef, means, n, groups: means.size };
}

function predictDev(row: PRow, m: ModelSpec, coef: number[], mean: { f: number[]; y: number }): number {
  const f = features(row, m);
  let v = row.y - mean.y;
  for (let j = 0; j < coef.length; j++) v -= coef[j] * (f[j] - mean.f[j]);
  return v;
}

function looRmse(rows: PRow[], m: ModelSpec): number {
  let ss = 0;
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const fit = fitRows(rows, m, i);
    const mean = fit.means.get(rows[i].g);
    if (!fit.coef || !mean) continue; // group would drop below two spots: cannot validate this point
    const e = predictDev(rows[i], m, fit.coef, mean);
    ss += e * e;
    n++;
  }
  return n >= 6 ? Math.sqrt(ss / n) : NaN;
}

function curveMax(sc: number[], bc: number[], rbar: number): number {
  let mx = 0;
  for (let t = 0; t <= 40; t++) {
    const u = -1 + t / 20;
    mx = Math.max(mx, Math.abs(poly(sc, u)) + Math.abs(poly(bc, u)) / Math.max(0.2, rbar));
  }
  return mx;
}

/**
 * Fit from spots the user picked. Each inner array is one compound (spots that must have the same Rf).
 * laneXs are the lateral positions of all lanes of the half, which fix the width of the plate.
 *
 * Model: measured Rf = true Rf * (1 + s(u)) + b(u), s and b polynomials in the lateral position u.
 * Complexity (parabola, sharper edges, + offset) is chosen by leave-one-out cross-validation and
 * only increased when it clearly predicts left-out spots better, so few picks fall back to the parabola.
 */
export function fitEdgePicks(
  groups: EdgePoint[][],
  laneXs: number[],
  opt: { minShift?: number; span?: number } = {}
): EdgeFit {
  const c = context(laneXs, true, PICK_MIN_SNR, opt.minShift ?? EDGE_MIN_SHIFT);
  const span = opt.span ?? 900;
  const kept = groups
    .map((g) => g.filter((p) => p.h > 0 && isFinite(p.x)))
    .filter((g) => g.length >= 2 && new Set(g.map((p) => p.lane)).size >= 2);
  const lanes = new Set(kept.flat().map((p) => p.lane));
  const picked = kept.flat().length;
  if (picked < PICK_MIN_SPOTS || lanes.size < PICK_MIN_LANES) {
    return emptyFit(
      c,
      `Pick at least ${PICK_MIN_SPOTS} spots in ${PICK_MIN_LANES} different lanes, two or more per compound (now ${picked} spots in ${lanes.size} lanes).`,
      { nClusters: kept.length, nSpots: picked }
    );
  }
  const xs = kept.flat().map((p) => p.x);
  const coverage = c.xmax > c.xmin ? (Math.max(...xs) - Math.min(...xs)) / (c.xmax - c.xmin) : 0;

  const rows: PRow[] = [];
  kept.forEach((g, gi) => {
    const rfs = g.map((p) => p.rf ?? p.h / span);
    const r = rfs.reduce((a, b) => a + b, 0) / rfs.length;
    if (!(r > 0.03)) return;
    g.forEach((p, i) => rows.push({ u: (p.x - c.xm) / c.hr, y: rfs[i] / r, g: gi, r }));
  });
  const nGroups = new Set(rows.map((r) => r.g)).size;
  const rbar = rows.reduce((a, r) => a + r.r, 0) / Math.max(1, rows.length);

  // offset needs compounds at clearly different heights, otherwise it cannot be told from the multiplicative part
  const gr = [...new Set(rows.map((r) => r.g))].map((g) => rows.find((r) => r.g === g)!.r);
  const heightSpread = gr.length >= 2 ? Math.max(...gr) - Math.min(...gr) : 0;
  const feasible = (m: ModelSpec) => {
    const p = m.D + m.Db;
    if (rows.length < p + nGroups + 3) return false;
    if (m.Db > 0 && (heightSpread < 0.12 || rows.length < 10 || nGroups < 2)) return false;
    return true;
  };

  let best = MODELS[0];
  let bestCv = looRmse(rows, best);
  for (const m of MODELS.slice(1)) {
    if (!feasible(m) || !isFinite(bestCv)) continue;
    const cv = looRmse(rows, m);
    if (isFinite(cv) && cv < 0.9 * bestCv) {
      best = m;
      bestCv = cv;
    }
  }

  const f = fitRows(rows, best);
  if (!f.coef) {
    return emptyFit(c, 'The picked spots are too close together across the plate to fit a curve.', { nClusters: nGroups, nSpots: rows.length });
  }
  const sCoef = f.coef.slice(0, best.D);
  const bCoef = f.coef.slice(best.D); // in units of Rf / r_c -> multiply back below
  // features for b were u^k / r_c, so the coefficient is already in Rf units
  const full = curveMax(sCoef, bCoef, rbar);

  // residual scatter (relative) and plot points
  let rss = 0;
  let ss0 = 0; // variation left when no curve is fitted at all
  const used: { u: number; y: number }[] = [];
  const byG = new Map<number, PRow[]>();
  rows.forEach((r) => byG.set(r.g, [...(byG.get(r.g) || []), r]));
  for (const [g, rs] of byG) {
    const mean = f.means.get(g);
    if (!mean) continue;
    for (const r of rs) {
      const e = predictDev(r, best, f.coef, mean);
      rss += e * e;
      ss0 += (r.y - mean.y) ** 2;
      const model = features(r, best).reduce((a, v, j) => a + f.coef![j] * v, 0);
      used.push({ u: r.u, y: model + e });
    }
  }
  const dof = Math.max(1, rows.length - f.groups - f.coef.length);
  const scatter = Math.sqrt(rss / dof);
  // F test: does the curve explain clearly more than no curve at all?
  const Fstat = rss > 0 ? (Math.max(0, ss0 - rss) / f.coef.length) / (rss / dof) : 1e6;

  // stability: the shape must survive leaving out any one compound
  let stable = true;
  if (nGroups >= 2) {
    for (const g of byG.keys()) {
      if (!stable) break;
      const fg = fitRows(rows, best, -1, g);
      if (!fg.coef) { stable = false; break; }
      const sg = fg.coef.slice(0, best.D);
      for (const u of [-1, 1]) {
        const a = poly(sCoef, u);
        const b = poly(sg, u);
        if (Math.abs(a) >= 0.01 && (Math.sign(a) !== Math.sign(b) || Math.abs(b) < 0.3 * Math.abs(a))) stable = false;
      }
    }
  }

  const base: EdgeFit = {
    ok: true,
    reason: '',
    xm: c.xm,
    hr: c.hr,
    c1: 0,
    c2: 0,
    nClusters: nGroups,
    nSpots: rows.length,
    maxShift: full,
    scatter,
    stable,
    fromPicks: true,
    xmin: c.xmin,
    xmax: c.xmax,
    used,
    sCoef,
    bCoef,
    model: best.name,
    rbar,
  };
  if (coverage < PICK_MIN_COVERAGE) {
    return { ...base, ok: false, reason: `The picked spots cover only ${Math.round(coverage * 100)} % of the plate width. Pick spots in lanes near both edges as well as the middle.` };
  }
  if (!stable) return { ...base, ok: false, reason: 'The curve changes sign or size when one compound is left out, so it is not reliable.' };
  if (scatter > PICK_MAX_SCATTER) {
    return { ...base, ok: false, reason: `The picked spots do not agree with each other (scatter ${(scatter * 100).toFixed(1)} %, limit ${(PICK_MAX_SCATTER * 100).toFixed(0)} %). Are they really the same compound?` };
  }
  if (Fstat < PICK_MIN_F) {
    return { ...base, ok: false, reason: `The curve cannot be told apart from random scatter between the picked spots (F = ${Fstat.toFixed(1)}, need ${PICK_MIN_F}). More picks, especially near the edges, would help.` };
  }
  if (full < c.snr * scatter) {
    return { ...base, ok: false, reason: `The curve (${(full * 100).toFixed(1)} % at the edges) is not clearly larger than the scatter between the picked spots (${(scatter * 100).toFixed(1)} %).` };
  }
  if (full < c.minShift) {
    return { ...base, ok: false, reason: `The curve is negligible (${(full * 100).toFixed(1)} % at the edges).` };
  }
  return base;
}

const poly = (c: number[], u: number) => c.reduce((acc, ck, k) => acc + ck * u ** (k + 1), 0);

/** Relative migration speed g at lateral position x (the multiplicative part). strength 0..1 scales the effect. */
export function edgeGain(fit: EdgeFit | null | undefined, x: number, strength = 1): number {
  if (!fit) return 1;
  const u = (x - fit.xm) / fit.hr;
  if (fit.sCoef) return 1 + strength * poly(fit.sCoef, u);
  return Math.exp(strength * (fit.c1 * u + fit.c2 * u * u));
}

/** Constant-in-height shift of the Rf (an additive part of the effect, e.g. late solvent entry at an edge). */
export function edgeOffset(fit: EdgeFit | null | undefined, x: number, strength = 1): number {
  if (!fit || !fit.bCoef || !fit.bCoef.length) return 0;
  return strength * poly(fit.bCoef, (x - fit.xm) / fit.hr);
}

/** Relative shift of a spot at the typical picked Rf, across the plate (u = -1 .. 1); for the diagnostic plot. */
export function edgeCurve(fit: EdgeFit, u: number, strength = 1): number {
  const g = edgeGain(fit, fit.xm + u * fit.hr, strength) - 1;
  const o = edgeOffset(fit, fit.xm + u * fit.hr, strength);
  return fit.sCoef ? g + o / (fit.rbar || 0.5) : g;
}

export type EdgeMode = 'auto' | 'on' | 'off';
export interface EdgeSetting {
  mode: EdgeMode;
  strength: number; // 0..1
}
export const DEFAULT_EDGE_SETTING: EdgeSetting = { mode: 'auto', strength: 1 };

export function edgeActive(fit: EdgeFit | null | undefined, s: EdgeSetting): boolean {
  if (!fit || s.mode === 'off' || s.strength <= 0) return false;
  if (s.mode === 'on') return fit.nSpots > 0;
  // Auto applies only when the curve was measured on spots the user picked. A fit from mixed compounds
  // is shown as a suggestion, because which compounds sit in which lane follows the reaction design.
  return fit.ok && fit.fromPicks;
}

/** A usable fit that Auto does not apply because it did not come from reference lanes. */
export function edgeSuggestion(fit: EdgeFit | null | undefined, s: EdgeSetting): boolean {
  return !!fit && s.mode === 'auto' && fit.ok && !fit.fromPicks;
}

/** Corrected copy of the spots of a lane; keeps the measured value in rfRaw. */
export function correctSpots<T extends { rf: number }>(
  spots: T[],
  gain: number,
  offset = 0
): (T & { rfRaw?: number; edgeGain?: number; edgeOffset?: number })[] {
  if (!(gain > 0) || (Math.abs(gain - 1) < 1e-6 && Math.abs(offset) < 1e-6)) return spots;
  return spots.map((sp) => ({
    ...sp,
    rfRaw: sp.rf,
    edgeGain: +gain.toFixed(4),
    edgeOffset: +offset.toFixed(4),
    rf: Math.max(0, Math.min(1.2, +((sp.rf - offset) / gain).toFixed(3))),
  }));
}
