// Robowski Studio - TLC Lane Mathematics, Signal Densitometry & Coordinate Transforms
import {
  RunResult,
  TlcLane,
  TlcLaneConfig,
  TlcLaneRow,
  TlcSpot,
  TlcProfileOptions,
  TlcDensitogramData,
  TlcSet,
} from '../types';
import { parseDelimited } from './importers/tableReader';
import { csvText } from './exporters/csv';

export const LANE_FRAME_WIDTH = 3280;
export const TLC_ROWS = 6;
export const TLC_COLS = 9;
export const TLC_ORDER = 'column';

export const TLC_SIGNAL = {
  UV254: { ch: 1, sign: -1, label: 'UV 254 nm' },
  UV366: { ch: 2, sign: 1, label: 'UV 365 nm' },
  White: { ch: 2, sign: -1, label: 'Visible' },
} as const;

export type TlcChannelKey = keyof typeof TLC_SIGNAL;

export function parseLaneConfig(text: string): TlcLaneConfig {
  const rows = parseDelimited(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (rows.length < 2) throw new Error('The lane file has no rows.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const n of ['id', 'x0', 'y0', 'length', 'width', 'direction_angle']) {
    if (col(n) < 0) {
      throw new Error(
        `The lane file needs a "${n}" column (found: ${head.filter(Boolean).join(', ') || 'none'}).`
      );
    }
  }
  const num = (r: any[], n: string, i: number) => {
    const k = col(n);
    if (k < 0) return null;
    const v = r[k] === '' || r[k] == null ? NaN : +r[k];
    if (!isFinite(v)) {
      if (n === 'spot_radius_px' || n === 'px_location_of_zero_rf') return null;
      throw new Error(`Row ${i + 2}: "${n}" is not a number.`);
    }
    return v;
  };
  const lanes: TlcLane[] = rows.slice(1).map((r, i) => ({
    id: num(r, 'id', i) as number,
    x0: num(r, 'x0', i) as number,
    y0: num(r, 'y0', i) as number,
    length: num(r, 'length', i) as number,
    width: num(r, 'width', i) as number,
    angle: num(r, 'direction_angle', i) as number,
    spotRadius: num(r, 'spot_radius_px', i),
    zeroRf: num(r, 'px_location_of_zero_rf', i),
  }));
  if (lanes.some((l) => l.length <= 0 || l.width <= 0)) {
    throw new Error('Every lane needs a length and width above zero.');
  }
  return {
    lanes,
    hasZeroRf: lanes.every((l) => l.zeroRf != null),
    warnings:
      lanes.length > 54 ? [`${lanes.length} lanes found; only the first 54 fit a 6 x 9 plate.`] : [],
  };
}

export function tlcLane(container: number, order: string = TLC_ORDER): number {
  const r = Math.floor(container / TLC_COLS);
  const c = container % TLC_COLS;
  return order === 'row' ? container : c * TLC_ROWS + r;
}

export function containerOfLane(t: number): number {
  const c = Math.floor(t / TLC_ROWS);
  const r = t % TLC_ROWS;
  return r * TLC_COLS + c;
}

export function wellLabel(container: number): string {
  return 'ABCDEF'[Math.floor(container / TLC_COLS)] + ((container % TLC_COLS) + 1);
}

export function laneMatrix(l: TlcLane, imgScale: number, k: number): number[] {
  const th = (l.angle * Math.PI) / 180;
  const dx = Math.sin(th);
  const dy = -Math.cos(th);
  const nx = Math.cos(th);
  const ny = Math.sin(th);
  const kk = k / imgScale;
  const ox = imgScale * l.x0;
  const oy = imgScale * l.y0;
  return [
    kk * nx,
    -kk * dx,
    kk * ny,
    -kk * dy,
    (k * l.width) / 2 - kk * (nx * ox + ny * oy),
    k * l.length + kk * (dx * ox + dy * oy),
  ];
}

export function tlcLaneRows(run: RunResult, order: string = TLC_ORDER): TlcLaneRow[] {
  return run.rows
    .map((r) => ({
      plate: r.plate_number,
      lane: tlcLane(r.container_id, order),
      half: tlcLane(r.container_id, order) < 27 ? 1 : 2,
      well: wellLabel(r.container_id),
      vial: r.container_id,
      reaction: r.global_index + 1,
      row: r,
    }))
    .sort((a, b) => a.plate - b.plate || a.lane - b.lane);
}

export function tlcLaneCsv(run: RunResult, order: string = TLC_ORDER): string {
  const benchNum = (v: any) =>
    Number.isFinite(+v) ? String(Number.parseFloat((+v).toPrecision(8))) : '';
  const codes = run.rows[0] ? run.rows[0].recipe.map((x) => x.code) : [];
  const rows = [
    [
      'plate',
      'tlc_lane',
      'tlc_half',
      'well',
      'robot_vial_index',
      'reaction',
      ...codes.map((c) => c + '_mM'),
      'solvent_uL',
    ],
  ];
  for (const x of tlcLaneRows(run, order)) {
    rows.push([
      String(x.plate),
      String(x.lane),
      String(x.half),
      x.well,
      String(x.vial),
      String(x.reaction),
      ...x.row.recipe.map((rc: any) => benchNum(rc.target_concentration)),
      benchNum(x.row['vol#solvent']),
    ]);
  }
  return csvText(rows);
}

// ---- Spots and Rf from a lane brightness profile ---------------------------------------------------------

// Center-weighted lane row sampling: isolates the central trajectory of the lane and
// applies a cosine window tapering to zero at the margins to suppress spillover from adjacent lanes.
export function computeLaneRowIntensity(
  rowData: Uint8ClampedArray | number[],
  width: number,
  channel: number,
  coreWidthFraction: number = 0.40
): number {
  if (width <= 0) return 0;
  const center = (width - 1) / 2;
  const halfSpan = Math.max(1, (width * coreWidthFraction) / 2);
  const x0 = Math.max(0, Math.floor(center - halfSpan));
  const x1 = Math.min(width - 1, Math.ceil(center + halfSpan));

  let sum = 0;
  let weightSum = 0;

  for (let x = x0; x <= x1; x++) {
    const dist = Math.abs(x - center);
    // Cosine taper: 1.0 at center, 0.0 at margins
    const weight = Math.cos((dist / halfSpan) * (Math.PI / 2));
    const val = rowData[x * 4 + channel] ?? 0;
    sum += val * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? sum / weightSum : 0;
}

// Moving average box filter for signal smoothing
export function movingAvg(a: number[], w: number): number[] {
  const h = w >> 1;
  const out = new Array(a.length);
  let s = 0;
  let n = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < a.length; i++) {
    while (hi < Math.min(a.length - 1, i + h)) {
      hi++;
      s += a[hi];
      n++;
    }
    while (lo < i - h) {
      s -= a[lo];
      lo++;
      n--;
    }
    out[i] = n > 0 ? s / n : a[i];
  }
  return out;
}

// Percentile calculation
export function pctile(a: ArrayLike<number>, p: number): number {
  if (!a.length) return 0;
  const b = Array.from(a).sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))];
}

// Detect solvent front from the bright meniscus band near the far end of the lane (top 30%)
export function detectFront(profile: number[]): number {
  if (!profile.length) return 0;
  const sm = movingAvg(profile, 9);
  const lo = Math.floor(profile.length * 0.7);
  let best = lo;
  for (let i = lo; i < sm.length; i++) {
    if (sm[i] > sm[best]) best = i;
  }
  return best;
}

export const tlcHalf = (lane: TlcLane): number => (lane.id < 27 ? 0 : 1);

// Find spots in a lane profile using rolling percentile baseline subtraction
export function findSpots(profile: number[], o: TlcProfileOptions): TlcSpot[] {
  const n = profile.length;
  if (n < 10) return [];
  const sm = movingAvg(profile, 7);
  const step = 5;
  const win = 100;
  const base = new Array(n);
  const q = o.sign < 0 ? 0.9 : 0.1;
  const pts: [number, number][] = [];

  for (let i = 0; i < n; i += step) {
    const chunk = sm.slice(Math.max(0, i - win), Math.min(n, i + win + 1));
    pts.push([i, pctile(chunk, q)]);
  }
  pts.push([n - 1, pts[pts.length - 1][1]]);

  for (let j = 0, i = 0; i < n; i++) {
    while (j < pts.length - 2 && pts[j + 1][0] < i) j++;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    base[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
  }

  const d = sm.map((v, i) => (o.sign < 0 ? base[i] - v : v - base[i]));
  const r = o.radius || 24;
  const from = Math.round(o.origin - r);
  const start = Math.round(o.origin + r * 1.2);
  const span = Math.max(1, o.front - o.origin);
  const end = Math.round(o.origin + 0.93 * span);

  const all = d.slice(Math.max(0, from), Math.min(n, end));
  const dmax = Math.max(...all, 1e-9);
  const med = pctile(d, 0.5);
  const noise = 1.4826 * pctile(d.map((v) => Math.abs(v - med)), 0.5);
  const thr = Math.max(4 * noise, 0.06 * dmax);
  const spots: TlcSpot[] = [];

  for (let i = Math.max(start, 1); i < Math.min(end, n - 1); i++) {
    if (d[i] < thr) continue;
    let top = true;
    for (let k = Math.max(0, i - 12); k <= Math.min(n - 1, i + 12); k++) {
      if (d[k] > d[i] || (d[k] === d[i] && k < i)) {
        top = false;
        break;
      }
    }
    if (top) {
      spots.push({
        pos: i,
        rf: Math.max(0, Math.min(1, (i - o.origin) / span)),
        strength: Math.min(1, Math.max(0, d[i] / dmax)),
      });
    }
  }
  return spots;
}

// Complete 1D Densitometry extraction: returns profile curve, rolling baseline, baseline-subtracted signal & spots
export function extractDensitogram(
  profile: number[],
  o: TlcProfileOptions
): TlcDensitogramData {
  const n = profile.length;
  if (n < 10) {
    return {
      points: [],
      spots: [],
      origin: o.origin,
      front: o.front,
      maxSignal: 1,
      totalArea: 0,
    };
  }

  const sm = movingAvg(profile, 7);
  const step = 5;
  const win = 100;
  const base = new Array(n);
  const q = o.sign < 0 ? 0.9 : 0.1;
  const pts: [number, number][] = [];

  for (let i = 0; i < n; i += step) {
    const chunk = sm.slice(Math.max(0, i - win), Math.min(n, i + win + 1));
    pts.push([i, pctile(chunk, q)]);
  }
  pts.push([n - 1, pts[pts.length - 1][1]]);

  for (let j = 0, i = 0; i < n; i++) {
    while (j < pts.length - 2 && pts[j + 1][0] < i) j++;
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    base[i] = x1 === x0 ? y0 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
  }

  const span = Math.max(1, o.front - o.origin);
  const spots = findSpots(profile, o);

  const points: TlcDensitogramData['points'] = [];
  let totalArea = 0;
  let maxSignal = 0;

  for (let i = 0; i < n; i++) {
    const rawVal = profile[i];
    const smoothVal = sm[i];
    const baseVal = base[i];
    const sig = Math.max(0, o.sign < 0 ? baseVal - smoothVal : smoothVal - baseVal);
    const rf = (i - o.origin) / span;

    if (sig > maxSignal) maxSignal = sig;
    if (i >= o.origin && i <= o.front) {
      totalArea += sig;
    }

    points.push({
      pos: i,
      rf,
      raw: rawVal,
      smooth: smoothVal,
      baseline: baseVal,
      signal: sig,
    });
  }

  // Calculate area percentage for each spot
  if (totalArea > 0) {
    spots.forEach((sp) => {
      let peakArea = 0;
      for (let k = Math.max(0, sp.pos - 15); k <= Math.min(n - 1, sp.pos + 15); k++) {
        peakArea += points[k]?.signal || 0;
      }
      sp.areaPct = Math.min(100, Math.round((peakArea / totalArea) * 100));
    });
  }

  return {
    points,
    spots,
    origin: o.origin,
    front: o.front,
    maxSignal: Math.max(maxSignal, 1e-6),
    totalArea,
  };
}

// Solvent front resolution: explicit manual override -> UV366 meniscus detection -> fallback 93% of lane length
export function tlcFront(
  set: TlcSet,
  lane: TlcLane,
  getProfile?: (set: TlcSet, key: 'UV366', lane: TlcLane) => number[]
): number {
  if (set.frontPx && set.frontPx > 0) return set.frontPx;
  if (!set.imgs.UV366 || !getProfile) return Math.round(lane.length * 0.93);

  set.frontAuto = set.frontAuto || {};
  const h = tlcHalf(lane);
  if (set.frontAuto[h] == null && set.cfg) {
    const halfLanes = set.cfg.lanes.filter((l) => tlcHalf(l) === h);
    const fronts = halfLanes
      .map((l) => detectFront(getProfile(set, 'UV366', l)))
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    set.frontAuto[h] = fronts.length ? fronts[fronts.length >> 1] : Math.round(lane.length * 0.93);
  }
  return set.frontAuto[h] ?? Math.round(lane.length * 0.93);
}

// Generate tlc_rf_table.csv: one line per lane of every set, with vial recipe, front, origin, and up to 5 spots
export function tlcRfCsv(
  sets: TlcSet[],
  run: RunResult,
  getSpots: (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => TlcSpot[] | null,
  plateIndex: number = 0
): string {
  const codes = run.reagents.map((r) => r.code);
  const head = [
    'set',
    'plate',
    'well',
    'tlc_lane',
    'reaction',
    ...codes.map((c) => c + '_mM'),
    'solvent_uL',
    'image',
    'origin_px',
    'front_px',
    'spots',
  ];
  for (let n = 1; n <= 5; n++) {
    head.push(`rf_${n}`, `strength_${n}`);
  }
  const rows = [head];

  for (const set of sets) {
    const key: TlcChannelKey | undefined = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).find(
      (k) => !!set.imgs[k]
    );
    if (!set.cfg || !key) continue;

    for (const l of [...set.cfg.lanes].sort((a, b) => a.id - b.id)) {
      if (l.id < 0 || l.id > 53) continue;
      const vialId = containerOfLane(l.id);
      const row = run.rows.find(
        (r) => r.plate_number === plateIndex && r.container_id === vialId
      );
      const sp = getSpots(set, key, l);
      if (!sp) continue;

      const r: (string | number)[] = [
        set.name,
        plateIndex,
        wellLabel(vialId),
        l.id,
        row ? row.global_index + 1 : '',
        ...codes.map((c) => {
          const rc = row && row.recipe.find((x: any) => x.code === c);
          return rc ? +rc.target_concentration.toFixed(4) : '';
        }),
        row ? +(+row['vol#solvent']).toFixed(2) : '',
        TLC_SIGNAL[key].label,
        l.zeroRf != null ? Math.round(l.zeroRf) : '',
        tlcFront(set, l),
        sp.length,
      ];
      for (let n = 0; n < 5; n++) {
        r.push(sp[n] ? +sp[n].rf.toFixed(3) : '', sp[n] ? +sp[n].strength.toFixed(2) : '');
      }
      rows.push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
    }
  }

  return csvText(rows);
}
