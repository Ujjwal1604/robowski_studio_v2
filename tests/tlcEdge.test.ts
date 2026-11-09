import { describe, it, expect } from 'vitest';
import { tlcRfCsv } from '../src/engine/tlcLanes';
import { fitEdgeCurve, fitEdgePicks, edgeOffset, edgeGain, edgeActive, edgeSuggestion, correctSpots, DEFAULT_EDGE_SETTING } from '../src/engine/tlcEdge';
import type { EdgePoint } from '../src/engine/tlcEdge';

// A half plate with 27 lanes; several compounds (true heights) turn up in many lanes.
function half(gFn: (x: number) => number, sd = 0.01, seed = 1): EdgePoint[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const heights = [180, 330, 470, 610, 760];
  const pts: EdgePoint[] = [];
  for (let i = 0; i < 27; i++) {
    const x = 150 + i * 110;
    heights.forEach((h, k) => {
      if ((i + k) % 3 === 0 && k % 2 === 0 && i % 5 === 4) return; // some lanes miss some compounds
      if ((i * 7 + k * 3) % 4 === 0) return;
      pts.push({ lane: i, x, h: h * gFn(x) * (1 + sd * 2 * rnd()) });
    });
  }
  return pts;
}
const XM = 150 + 13 * 110;
const curve = (a: number) => (x: number) => 1 + a * ((x - XM) / 1430) ** 2;

describe('edge-effect correction', () => {
  it('recovers a plate whose edges lag and one whose edges run ahead', () => {
    for (const a of [-0.04, 0.04]) {
      const fit = fitEdgeCurve(half(curve(a)));
      expect(fit.ok).toBe(true);
      const est = edgeGain(fit, fit.xmax) - 1;
      expect(Math.sign(est)).toBe(Math.sign(a));
      expect(Math.abs(est - a)).toBeLessThan(0.01);
      expect(edgeGain(fit, fit.xm)).toBeCloseTo(1, 9);
    }
  });

  it('can follow a lopsided curve (one edge more than the other)', () => {
    const g = (x: number) => Math.exp(0.05 * ((x - XM) / 1430) + 0.03 * ((x - XM) / 1430) ** 2);
    const fit = fitEdgeCurve(half(g));
    expect(edgeGain(fit, fit.xmax)).toBeGreaterThan(edgeGain(fit, fit.xmin));
    expect(Math.abs(edgeGain(fit, fit.xmax) - g(fit.xmax))).toBeLessThan(0.01);
  });

  it('switches itself off on a flat half and keeps the raw Rf', () => {
    const fit = fitEdgeCurve(half(() => 1, 0.012, 7));
    expect(fit.ok).toBe(false);
    expect(edgeActive(fit, DEFAULT_EDGE_SETTING)).toBe(false);
    expect(edgeActive(fit, { mode: 'on', strength: 1 })).toBe(true);
    expect(edgeActive(fit, { mode: 'off', strength: 1 })).toBe(false);
  });

  it('refuses when there are no repeated compounds', () => {
    const pts: EdgePoint[] = [];
    for (let i = 0; i < 27; i++) pts.push({ lane: i, x: i * 100, h: 100 + i * 23 });
    const fit = fitEdgeCurve(pts);
    expect(fit.ok).toBe(false);
    expect(fit.reason).toMatch(/repeated/);
  });

  it('correction divides Rf by g; strength scales it; strength 0 and gain 1 change nothing', () => {
    const fit = fitEdgeCurve(half(curve(0.05)));
    const g = edgeGain(fit, fit.xmax);
    const sp = [{ pos: 500, rf: 0.5, strength: 1 }];
    const c = correctSpots(sp, g)[0];
    expect(c.rfRaw).toBe(0.5);
    expect(c.rf).toBeCloseTo(0.5 / g, 3);
    expect(edgeGain(fit, fit.xmax, 0)).toBe(1);
    expect(edgeGain(fit, fit.xmax, 0.5)).toBeCloseTo(Math.sqrt(g), 6);
    expect(correctSpots(sp, 1)).toBe(sp);
  });

  it('after correction the same compound agrees across lanes much better', () => {
    const pts = half(curve(0.05), 0.008, 3);
    const fit = fitEdgeCurve(pts);
    const hs = pts.filter((p) => Math.abs(p.h / edgeGain(null, p.x) - 470) < 40);
    const raw = pts.filter((p) => p.h > 420 && p.h < 560).map((p) => p.h);
    const cor = pts.filter((p) => p.h > 420 && p.h < 560).map((p) => p.h / edgeGain(fit, p.x));
    const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(hs.length).toBeGreaterThan(5);
    expect(spread(cor)).toBeLessThan(spread(raw) * 0.4);
  });
});

describe('edge-effect gating and reference lanes', () => {
  it('stays off when the curve is smaller than the scatter, even if a fit exists', () => {
    const fit = fitEdgeCurve(half(curve(0.015), 0.05, 11));
    expect(fit.ok).toBe(false);
    expect(fit.reason).toMatch(/scatter|negligible|sign/);
  });
  it('fits spots the user picked, and Auto applies that fit', () => {
    const g = curve(0.05);
    const xs = Array.from({ length: 27 }, (_, i) => 150 + i * 110);
    const mk = (h: number, lanes: number[]): EdgePoint[] =>
      lanes.map((i, k) => ({ lane: i, x: xs[i], h: h * g(xs[i]) * (1 + 0.004 * ((k % 3) - 1)) }));
    const fit = fitEdgePicks([mk(420, [0, 5, 10, 13, 16, 21, 26]), mk(250, [2, 8, 13, 19, 24])], xs);
    expect(fit.ok).toBe(true);
    expect(fit.fromPicks).toBe(true);
    expect(edgeActive(fit, DEFAULT_EDGE_SETTING)).toBe(true);
    expect(Math.abs(edgeGain(fit, fit.xmax) - g(fit.xmax))).toBeLessThan(0.01);
    expect(Math.abs(edgeGain(fit, fit.xmin) - g(fit.xmin))).toBeLessThan(0.01);
  });
  it('asks for more picks, and for picks near both edges', () => {
    const xs = Array.from({ length: 27 }, (_, i) => 150 + i * 110);
    const mk = (h: number, lanes: number[]): EdgePoint[] => lanes.map((i) => ({ lane: i, x: xs[i], h }));
    const few = fitEdgePicks([mk(400, [3, 20])], xs);
    expect(few.ok).toBe(false);
    expect(few.reason).toMatch(/Pick at least/);
    const middle = fitEdgePicks([mk(400, [10, 11, 12, 13, 14, 15])], xs);
    expect(middle.ok).toBe(false);
    expect(middle.reason).toMatch(/cover only/);
  });
  it('a fit from mixed compounds is only a suggestion in Auto, and applies when forced on', () => {
    const fit = fitEdgeCurve(half(curve(0.05)));
    expect(fit.ok).toBe(true);
    expect(edgeSuggestion(fit, DEFAULT_EDGE_SETTING)).toBe(true);
    expect(edgeActive(fit, DEFAULT_EDGE_SETTING)).toBe(false);
    expect(edgeActive(fit, { mode: 'on', strength: 1 })).toBe(true);
  });
});

describe('picked spots that do not agree', () => {
  it('is not applied when the picked spots are scattered (not one compound)', () => {
    const xs = Array.from({ length: 27 }, (_, i) => 150 + i * 110);
    const lanes = [0, 3, 6, 9, 12, 15, 18, 21, 24, 26];
    const pts: EdgePoint[] = lanes.map((i, k) => ({ lane: i, x: xs[i], h: 300 + ((k * 137) % 400) }));
    const fit = fitEdgePicks([pts], xs);
    expect(fit.ok).toBe(false);
    expect(fit.reason).toMatch(/do not agree|not clearly larger/);
    expect(edgeActive(fit, DEFAULT_EDGE_SETTING)).toBe(false);
  });
});

describe('Rf CSV with edge correction', () => {
  it('writes the gain and the raw Rf next to the corrected Rf', () => {
    const lane = { id: 0, x0: 100, y0: 2000, length: 1000, width: 72, angle: 0, zeroRf: 100 };
    const set: any = { name: 'A', uid: 'u', imgs: { UV254: {} }, cfg: { lanes: [lane] }, frontPx: 900 };
    const run: any = {
      reagents: [{ code: 'X' }],
      rows: [{ plate_number: 0, container_id: 0, global_index: 0, recipe: [{ code: 'X', target_concentration: 1 }], 'vol#solvent': 10 }],
    };
    const getSpots = () =>
      correctSpots([{ pos: 500, rf: 0.5, strength: 1 }, { pos: 300, rf: 0.25, strength: 0.5 }], 1.05);
    const csv = tlcRfCsv([set], run, getSpots as any, 0);
    const [head, row] = csv.split('\n');
    const cols = head.split(',');
    const cells = row.split(',');
    const at = (name: string) => cells[cols.indexOf(name)];
    expect(cols).toContain('edge_gain');
    expect(at('edge_gain')).toBe('1.05');
    expect(at('rf_1')).toBe((0.5 / 1.05).toFixed(3));
    expect(at('rf_raw_1')).toBe('0.5');
    expect(at('rf_raw_2')).toBe('0.25');
  });
});

describe('picked-spot model selection', () => {
  const xs = Array.from({ length: 27 }, (_, i) => 150 + i * 110);
  const XMID = (xs[0] + xs[26]) / 2;
  const U = (x: number) => (x - XMID) / ((xs[26] - xs[0]) / 2);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  // measured Rf = true * (1 + s(u)) + b(u)
  const picks = (trues: number[], lanesOf: (k: number) => number[], s: (u: number) => number, b: (u: number) => number, sd = 0.004) =>
    trues.map((r, k) =>
      lanesOf(k).map((i) => ({ lane: i, x: xs[i], h: 1, rf: (r * (1 + s(U(xs[i]))) + b(U(xs[i]))) * (1 + sd * rnd()) } as EdgePoint))
    );
  const laneSets = [[0, 1, 4, 7, 10, 13, 16, 19, 22, 25, 26], [0, 2, 5, 8, 12, 14, 18, 21, 24, 26], [1, 3, 6, 9, 13, 17, 20, 23, 25]];

  it('keeps the parabola when the data are a parabola', () => {
    const fit = fitEdgePicks(picks([0.62, 0.38, 0.2], (k) => laneSets[k], (u) => 0.05 * u * u, () => 0), xs);
    expect(fit.ok).toBe(true);
    expect(fit.model).toBe('parabola');
    expect(Math.abs(edgeGain(fit, xs[26]) - 1.05)).toBeLessThan(0.008);
  });

  it('switches to sharper edges when only the outer lanes bend', () => {
    const s = (u: number) => 0.07 * u ** 4;
    const fit = fitEdgePicks(picks([0.62, 0.38, 0.2], (k) => laneSets[k], s, () => 0, 0.002), xs);
    expect(fit.model).toMatch(/sharper/);
    for (const i of [0, 3, 13, 22, 26]) expect(Math.abs(edgeGain(fit, xs[i]) - (1 + s(U(xs[i]))))).toBeLessThan(0.012);
  });

  it('finds an offset that a pure height-proportional model cannot', () => {
    const b = (u: number) => 0.02 * u * u;
    const fit = fitEdgePicks(picks([0.7, 0.45, 0.2], (k) => laneSets[k], (u) => 0.03 * u * u, b, 0.002), xs);
    expect(fit.model).toMatch(/offset/);
    // corrected Rf of a high and a low spot at an edge lane both land on the truth
    const x = xs[26];
    for (const r of [0.7, 0.2]) {
      const meas = r * (1 + 0.03) + b(U(x));
      expect(Math.abs((meas - edgeOffset(fit, x)) / edgeGain(fit, x) - r)).toBeLessThan(0.006);
    }
  });

  it('does not add an offset with compounds at nearly the same height', () => {
    const fit = fitEdgePicks(picks([0.5, 0.52], (k) => laneSets[k], (u) => 0.04 * u * u, () => 0), xs);
    expect(fit.model).not.toMatch(/offset/);
  });

  it('correctSpots applies gain and offset and keeps the raw value', () => {
    const c = correctSpots([{ rf: 0.5 }], 1.04, 0.01)[0];
    expect(c.rfRaw).toBe(0.5);
    expect(c.rf).toBeCloseTo((0.5 - 0.01) / 1.04, 3);
    expect(c.edgeOffset).toBe(0.01);
  });
});
