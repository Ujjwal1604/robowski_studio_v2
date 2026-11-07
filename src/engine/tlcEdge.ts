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
export const PICK_MIN_SNR = 1.0;
export const PICK_MIN_COVERAGE = 0.5; // picked spots must span at least half of the plate width

/**
 * Fit from spots the user picked. Each inner array is one compound (spots that must have the same Rf).
 * laneXs are the lateral positions of all lanes of the half, which fix the width of the plate.
 */
export function fitEdgePicks(
  groups: EdgePoint[][],
  laneXs: number[],
  opt: { minShift?: number } = {}
): EdgeFit {
  const c = context(laneXs, true, PICK_MIN_SNR, opt.minShift ?? EDGE_MIN_SHIFT);
  const kept = groups
    .map((g) => g.filter((p) => p.h > 0 && isFinite(p.x)))
    .filter((g) => g.length >= 2 && new Set(g.map((p) => p.lane)).size >= 2);
  const rows: Row[] = [];
  kept.forEach((g, i) => g.forEach((p) => rows.push({ u: (p.x - c.xm) / c.hr, y: Math.log(p.h), g: i })));
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
  const fit = solve(rows, kept.length, c);
  if (coverage < PICK_MIN_COVERAGE) {
    return { ...fit, ok: false, reason: `The picked spots cover only ${Math.round(coverage * 100)} % of the plate width. Pick spots in lanes near both edges as well as the middle.` };
  }
  return fit;
}

/** Relative migration speed g at lateral position x. strength 0..1 scales ln g. */
export function edgeGain(fit: EdgeFit | null | undefined, x: number, strength = 1): number {
  if (!fit) return 1;
  const u = (x - fit.xm) / fit.hr;
  return Math.exp(strength * (fit.c1 * u + fit.c2 * u * u));
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
export function correctSpots<T extends { rf: number }>(spots: T[], gain: number): (T & { rfRaw?: number; edgeGain?: number })[] {
  if (!(gain > 0) || Math.abs(gain - 1) < 1e-6) return spots;
  return spots.map((sp) => ({
    ...sp,
    rfRaw: sp.rf,
    edgeGain: +gain.toFixed(4),
    rf: Math.max(0, Math.min(1.2, +(sp.rf / gain).toFixed(3))),
  }));
}
