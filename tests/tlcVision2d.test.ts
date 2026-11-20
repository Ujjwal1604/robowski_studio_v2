import { describe, it, expect } from 'vitest';
import {
  analyzeLaneStripRgb,
  applyFlatFieldCorrection,
  detectCurvedFrontSeam,
  detectGlassTopEdge,
  findDualHalfGapCeiling,
  findSimilarSpotsByColor,
  isProfileOnPlate,
  rescueSharedReagentSpots,
} from '../src/engine/tlcVision2d';
import {
  createDefaultLaneConfig,
  detectChannelOrigin,
  findSpots,
  tlcFront,
  tlcHalfFrontBase,
  tlcOrigin,
} from '../src/engine/tlcLanes';
import { parseTlcStorageKey, tlcPreRunStorageKey, tlcStorageKey } from '../src/engine/tlcPlateSlice';
import type { TlcLane, TlcSet } from '../src/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/**
 * Helper to synthesize a straightened W x L RGBA lane strip.
 * Remember chromatographic coordinate `pos = 0` is bottom (row y = L - 1) and `pos = L - 1` is top (row y = 0).
 */
function makeLaneStrip(
  W: number,
  L: number,
  bg: [number, number, number],
  paintPixel: (x: number, pos: number) => [number, number, number]
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * L * 4);
  for (let y = 0; y < L; y++) {
    const pos = L - 1 - y;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paintPixel(x, pos);
      const off = (y * W + x) * 4;
      rgba[off] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[off + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[off + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[off + 3] = 255;
    }
  }
  return rgba;
}

describe('tlcVision2d: full-RGB color perception', () => {
  it('detects yellow/orange UV366 fluorescent spots that have almost zero blue channel signal', () => {
    const W = 40;
    const L = 500;
    const rand = rng(101);
    const spotPos = 260;
    const cx = (W - 1) / 2;

    const rgba = makeLaneStrip(W, L, [18, 16, 22], (x, pos) => {
      const dx = (x - cx) / 7;
      const dy = (pos - spotPos) / 10;
      const g = Math.exp(-(dx * dx + dy * dy));
      const n = rand() * 1.2;
      // Yellow-orange fluorophore: strong R & G, almost zero B delta (+2)
      return [18 + 185 * g + n, 16 + 150 * g + n, 22 + 2 * g + n];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV366', 0.35, false);
    const spots = findSpots(profile, {
      sign: +1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.some((s) => Math.abs(s.pos - spotPos) <= 5)).toBe(true);
  });

  it('detects blue CAM/PMA spots on white silica AND yellow spots on purple KMnO4 plates in White channel', () => {
    const W = 40;
    const L = 500;
    const cx = (W - 1) / 2;

    // 1. Blue CAM spot on bright white silica (Blue channel barely changes: 235 -> 228)
    const r1 = rng(202);
    const camSpotPos = 210;
    const camRgba = makeLaneStrip(W, L, [235, 235, 235], (x, pos) => {
      const dx = (x - cx) / 7;
      const dy = (pos - camSpotPos) / 10;
      const g = Math.exp(-(dx * dx + dy * dy));
      const n = r1() * 1.2;
      return [235 - 140 * g + n, 235 - 75 * g + n, 235 - 7 * g + n];
    });
    const camRes = analyzeLaneStripRgb(camRgba, W, L, 'White', 0.35, false);
    const camSpots = findSpots(camRes.profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: camRes.metrics,
    });
    expect(camSpots.some((s) => Math.abs(s.pos - camSpotPos) <= 5)).toBe(true);

    // 2. Yellow spot on purple KMnO4 plate (spot is BRIGHTER than purple background!)
    const r2 = rng(203);
    const kmno4SpotPos = 315;
    const kmno4Rgba = makeLaneStrip(W, L, [160, 105, 168], (x, pos) => {
      const dx = (x - cx) / 7;
      const dy = (pos - kmno4SpotPos) / 10;
      const g = Math.exp(-(dx * dx + dy * dy));
      const n = r2() * 1.2;
      return [160 + 62 * g + n, 105 + 100 * g + n, 168 - 88 * g + n];
    });
    const kmno4Res = analyzeLaneStripRgb(kmno4Rgba, W, L, 'White', 0.35, false);
    const kmno4Spots = findSpots(kmno4Res.profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: kmno4Res.metrics,
    });
    expect(kmno4Spots.some((s) => Math.abs(s.pos - kmno4SpotPos) <= 5)).toBe(true);
  });

  it('keeps wet-vs-dry luminance step monotonic in White bare gutters (isGutter = true)', () => {
    const W = 24;
    const L = 400;
    const frontPos = 345;
    const rgba = makeLaneStrip(W, L, [180, 180, 180], (_x, pos) => {
      // Wet silica darker (180), dry silica brighter (204)
      return pos < frontPos ? [180, 180, 180] : [204, 204, 204];
    });
    const gutterRes = analyzeLaneStripRgb(rgba, W, L, 'White', 0.35, true);
    expect(gutterRes.profile[frontPos + 15]).toBeGreaterThan(gutterRes.profile[frontPos - 15] + 15);
  });
});

describe('tlcVision2d: 2D lateral verification (band & neighbor spillover rejection)', () => {
  const W = 44;
  const L = 500;
  const cx = (W - 1) / 2;

  it('rejects horizontal illumination / meniscus bands spanning full lane width while preserving centered spots', () => {
    const rand = rng(301);
    const bandPos = 220;
    const realSpotPos = 330;

    const rgba = makeLaneStrip(W, L, [195, 210, 195], (x, pos) => {
      const n = rand() * 1.0;
      // Full-width horizontal band (same across left flank, center, and right flank)
      const band = 32 * Math.exp(-Math.pow((pos - bandPos) / 9, 2));
      // Genuine centered spot confined to lane core
      const dx = (x - cx) / 7;
      const dy = (pos - realSpotPos) / 10;
      const spot = 55 * Math.exp(-(dx * dx + dy * dy));
      return [195 - band - spot + n, 210 - band - spot + n, 195 - band - spot + n];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    const spots = findSpots(profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.some((s) => Math.abs(s.pos - realSpotPos) <= 5)).toBe(true);
    expect(spots.some((s) => Math.abs(s.pos - bandPos) <= 10)).toBe(false);
  });

  it('rejects adjacent-lane spillover peaking at the outer flank while preserving a real spot beside a huge neighbor', () => {
    const rand = rng(302);
    const spilloverPos = 200;
    const coMigratingPos = 320;

    const rgba = makeLaneStrip(W, L, [195, 210, 195], (x, pos) => {
      const n = rand() * 1.0;
      // Massive spot centered OUTSIDE the right edge (x = W + 4) spilling its tail into this blank lane
      const dxSpill = (x - (W + 4)) / 14;
      const dySpill = (pos - spilloverPos) / 11;
      const spill = 165 * Math.exp(-(dxSpill * dxSpill + dySpill * dySpill));

      // Real medium spot centered in THIS lane next to a huge spot in the right neighbor
      const dxReal = (x - cx) / 7;
      const dyReal = (pos - coMigratingPos) / 10;
      const real = 55 * Math.exp(-(dxReal * dxReal + dyReal * dyReal));
      const dxNeighbor = (x - (W + 2)) / 12;
      const neighbor = 140 * Math.exp(-(dxNeighbor * dxNeighbor + dyReal * dyReal));

      const drop = spill + real + neighbor;
      return [195 - drop + n, 210 - drop + n, 195 - drop + n];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    const spots = findSpots(profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.some((s) => Math.abs(s.pos - spilloverPos) <= 10)).toBe(false);
    expect(spots.some((s) => Math.abs(s.pos - coMigratingPos) <= 6)).toBe(true);
  });
});

describe('tlcVision2d: 2D smooth curved solvent-front seam tracking', () => {
  it('tracks a smiling curved solvent front (+28 px higher at edges than center) lane-by-lane via tlcFront', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(401);
    const halfLanes = cfg.lanes.filter((l) => l.id < 27);
    const xMin = halfLanes[0].x0;
    const xMax = halfLanes[halfLanes.length - 1].x0;
    const trueFrontAtX = (x0: number) => {
      const u = (2 * (x0 - xMin)) / Math.max(1, xMax - xMin) - 1; // -1..+1
      return Math.round(845 + 28 * u * u); // 845 in middle, 873 at left & right edges
    };

    const set: TlcSet = {
      uid: 'smile-set',
      name: 'smiling-front',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      imgs: { UV254: { name: 'uv254.png', url: '', bmp: {} as any } },
      cfg,
    };

    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) => {
      const fp = trueFrontAtX(lane.x0);
      return Array.from({ length: lane.length }, (_, i) => {
        const wetDry = i < fp ? 175 : 186;
        const ridge = Math.abs(i - fp) <= 1 ? -14 : 0;
        return wetDry + ridge + rand() * 1.3;
      });
    };

    const fLeft = tlcFront(set, halfLanes[0], getProfile as any);
    const fMid = tlcFront(set, halfLanes[13], getProfile as any);
    const fRight = tlcFront(set, halfLanes[26], getProfile as any);

    expect(Math.abs(fLeft - trueFrontAtX(halfLanes[0].x0))).toBeLessThanOrEqual(4);
    expect(Math.abs(fMid - trueFrontAtX(halfLanes[13].x0))).toBeLessThanOrEqual(4);
    expect(Math.abs(fRight - trueFrontAtX(halfLanes[26].x0))).toBeLessThanOrEqual(4);
    expect(fLeft - fMid).toBeGreaterThanOrEqual(20);
    expect(fRight - fMid).toBeGreaterThanOrEqual(20);
  });

  it('fuses two faint agreeing channels (UV254 + White) into a confident tilted front seam', () => {
    const L = 700;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand1 = rng(402);
    const rand2 = rng(403);
    const trueY = (col: number) => {
      const u = (2 * col) / 26 - 1;
      return Math.round(605 + 18 * u); // tilted -18..+18 px across plate
    };

    const uvProfiles = laneIds.map((col) => {
      const fp = trueY(col);
      return Array.from({ length: L }, (_, i) => {
        const wetDry = i < fp ? 185 : 189;
        const ridge = Math.abs(i - fp) <= 1 ? -4.5 : 0;
        return wetDry + ridge + rand1() * 1.4;
      });
    });
    const whiteProfiles = laneIds.map((col) => {
      const fp = trueY(col);
      return Array.from({ length: L }, (_, i) => {
        const wetDry = i < fp ? 200 : 204.5;
        const ridge = Math.abs(i - fp) <= 1 ? -4.5 : 0;
        return wetDry + ridge + rand2() * 1.4;
      });
    });

    const seam = detectCurvedFrontSeam(
      [
        { profiles: uvProfiles, sign: -1 },
        { profiles: whiteProfiles, sign: -1 },
      ],
      laneIds,
      L
    );
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(seam.isCurved).toBe(true);
    expect(Math.abs(seam.byLane[0] - trueY(0))).toBeLessThanOrEqual(5);
    expect(Math.abs(seam.byLane[13] - trueY(13))).toBeLessThanOrEqual(5);
    expect(Math.abs(seam.byLane[26] - trueY(26))).toBeLessThanOrEqual(5);
  });

  it('tracks an aluminium-plate flat interior + sharp outer edge curl without bowing the center', () => {
    const L = 980;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(404);
    // Flat interior across lanes 4..22 at 860 px; outer 4 lanes curl upward by +4, +10, +17, +24 px
    const curlOffset = [24, 17, 10, 4];
    const trueY = (col: number) => {
      const distEdge = Math.min(col, 26 - col);
      return 860 + (distEdge < curlOffset.length ? curlOffset[distEdge] : 0);
    };

    const profiles = laneIds.map((col) => {
      const fp = trueY(col);
      return Array.from({ length: L }, (_, i) => {
        const wetDry = i < fp ? 178 : 189;
        const ridge = Math.abs(i - fp) <= 1 ? -13 : 0;
        return wetDry + ridge + rand() * 1.2;
      });
    });

    const seam = detectCurvedFrontSeam([{ profiles, sign: -1 }], laneIds, L);
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(seam.isCurved).toBe(true);
    // Interior lanes 5..21 must stay flat near 860 (a rigid global parabola would bow the center!)
    for (const midCol of [6, 10, 13, 16, 20]) {
      expect(Math.abs(seam.byLane[midCol] - 860)).toBeLessThanOrEqual(3);
    }
    // Outer curled edge lanes must track the +24 px edge upturn accurately
    expect(Math.abs(seam.byLane[0] - trueY(0))).toBeLessThanOrEqual(4);
    expect(Math.abs(seam.byLane[1] - trueY(1))).toBeLessThanOrEqual(4);
    expect(Math.abs(seam.byLane[25] - trueY(25))).toBeLessThanOrEqual(4);
    expect(Math.abs(seam.byLane[26] - trueY(26))).toBeLessThanOrEqual(4);
  });

  it('uses 2D horizontal continuity (core + flanks) to ignore strong aligned high-Rf spots and lock onto the true solvent front', () => {
    const W = 44;
    const L = 500;
    const cx = (W - 1) / 2;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(405);

    const trueFrontY = (col: number) => Math.round(442 + 10 * ((2 * col) / 26 - 1));
    const fakeSpotY = 392; // Strong center-peaked high-Rf spot present in EVERY lane!

    const profiles: number[][] = [];
    const metrics = [];
    for (let col = 0; col < 27; col++) {
      const fp = trueFrontY(col);
      const rgba = makeLaneStrip(W, L, [20, 210, 20], (x, pos) => {
        const n = rand() * 1.0;
        // Full-width faint solvent front (affects both core AND outer flanks identically)
        const wetDry = pos < fp ? 202 : 212;
        const frontRidge = Math.abs(pos - fp) <= 1 ? -11 : 0;
        // Center-peaked dark high-Rf spot (stronger than front in core, absent in outer flanks!)
        const dx = (x - cx) / 5.5;
        const dy = (pos - fakeSpotY) / 2.2;
        const spotDrop = 55 * Math.exp(-(dx * dx + dy * dy));
        const g = Math.max(0, Math.min(255, wetDry + frontRidge - spotDrop + n));
        return [20, g, 20];
      });
      const res = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
      profiles.push(res.profile);
      metrics.push(res.metrics);
    }

    const seam2d = detectCurvedFrontSeam(
      [{ profiles, sign: -1, metrics, colPositions: laneIds }],
      laneIds,
      L
    );
    expect(seam2d.medianPos).toBeGreaterThan(0);
    expect(Math.abs(seam2d.byLane[0] - trueFrontY(0))).toBeLessThanOrEqual(4);
    expect(Math.abs(seam2d.byLane[13] - trueFrontY(13))).toBeLessThanOrEqual(4);
    expect(Math.abs(seam2d.byLane[26] - trueFrontY(26))).toBeLessThanOrEqual(4);
  });

  it('aligns N-1 gutter midpoint coordinates accurately to lane 0 and lane N-1 without half-lane stretch error', () => {
    const L = 980;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(406);
    // Steep linear tilt: +2 px per lane (lane 0 = 830, lane 13 = 856, lane 26 = 882)
    const trueY = (x: number) => 830 + 2 * x;
    const gutterPositions = Array.from({ length: 26 }, (_, i) => i + 0.5);

    const profiles = gutterPositions.map((gx) => {
      const fp = Math.round(trueY(gx));
      return Array.from({ length: L }, (_, i) => {
        const wetDry = i < fp ? 176 : 188;
        const ridge = Math.abs(i - fp) <= 1 ? -14 : 0;
        return wetDry + ridge + rand() * 1.0;
      });
    });

    const seam = detectCurvedFrontSeam(
      [{ profiles, sign: -1, colPositions: gutterPositions }],
      laneIds,
      L
    );
    expect(seam.isCurved).toBe(true);
    expect(Math.abs(seam.byLane[0] - trueY(0))).toBeLessThanOrEqual(2);
    expect(Math.abs(seam.byLane[13] - trueY(13))).toBeLessThanOrEqual(2);
    expect(Math.abs(seam.byLane[26] - trueY(26))).toBeLessThanOrEqual(2);
  });

  it('preserves the 2D per-lane curved front shape when nudging manually via frontHalfPx / tlcHalfFrontBase', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(407);
    const halfLanes = cfg.lanes.filter((l) => l.id < 27);
    const xMin = halfLanes[0].x0;
    const xMax = halfLanes[halfLanes.length - 1].x0;
    const trueFrontAtX = (x0: number) => {
      const u = (2 * (x0 - xMin)) / Math.max(1, xMax - xMin) - 1;
      return Math.round(845 + 26 * u * u);
    };

    const set: TlcSet = {
      uid: 'nudge-curve-set',
      name: 'nudge-curve',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      imgs: { UV254: { name: 'uv254.png', bmp: {} as any } },
      cfg,
    };

    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) => {
      const fp = trueFrontAtX(lane.x0);
      return Array.from({ length: lane.length }, (_, i) => {
        const wetDry = i < fp ? 175 : 186;
        const ridge = Math.abs(i - fp) <= 1 ? -14 : 0;
        return wetDry + ridge + rand() * 1.1;
      });
    };

    const autoLeft = tlcFront(set, halfLanes[0], getProfile as any);
    const autoMid = tlcFront(set, halfLanes[13], getProfile as any);
    const autoRight = tlcFront(set, halfLanes[26], getProfile as any);
    const baseBefore = tlcHalfFrontBase(set, 0, halfLanes[0], getProfile as any);
    expect(Math.abs(baseBefore - (set.frontAuto?.[0] ?? 0))).toBeLessThanOrEqual(1);
    expect(autoLeft - autoMid).toBeGreaterThanOrEqual(18);

    // Manually nudge side 0 up by +12 px while preserving frontAuto / frontAutoByLane
    set.frontHalfPx = { 0: baseBefore + 12 };
    expect(tlcHalfFrontBase(set, 0, halfLanes[0], getProfile as any)).toBe(baseBefore + 12);
    expect(tlcFront(set, halfLanes[0], getProfile as any)).toBe(autoLeft + 12);
    expect(tlcFront(set, halfLanes[13], getProfile as any)).toBe(autoMid + 12);
    expect(tlcFront(set, halfLanes[26], getProfile as any)).toBe(autoRight + 12);
  });

  it('tracks a one-sided 4-lane right-edge bend (up to 97% of lane box) even on crisp high-contrast UV254 plates', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(408);
    const halfLanes = cfg.lanes.filter((l) => l.id < 27).sort((a, b) => a.id - b.id);
    const L = halfLanes[0].length;
    const baseY = Math.round(L * 0.935);
    const xMin = halfLanes[0].x0;
    const xMax = halfLanes[halfLanes.length - 1].x0;
    // Flat across 85% of the plate (lanes 0..22); ONLY the rightmost 4 lanes bend by +3, +8, +14, +20 px (reaching ~96.5%)
    const bendAtX = (x0: number) => {
      const colF = (26 * (x0 - xMin)) / Math.max(1, xMax - xMin);
      if (colF <= 22) return baseY;
      const t = (colF - 22) / 4; // 0..1 across last 4 lanes
      return Math.round(baseY + 20 * t * t);
    };

    const set: TlcSet = {
      uid: 'one-sided-bend',
      name: 'one-sided-bend',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      imgs: { UV254: { name: 'uv254.png', bmp: {} as any } },
      cfg,
    };

    // High-contrast crisp meniscus (produces bestFlat.score >> 30 on 26-gutter median!)
    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) => {
      const fp = bendAtX(lane.x0);
      return Array.from({ length: lane.length }, (_, i) => {
        const wetDry = i < fp ? 170 : 196;
        const ridge = -48 * Math.exp(-Math.pow((i - fp) / 2.2, 2));
        return wetDry + ridge + rand() * 0.8;
      });
    };

    const f0 = tlcFront(set, halfLanes[0], getProfile as any);
    const f13 = tlcFront(set, halfLanes[13], getProfile as any);
    const f24 = tlcFront(set, halfLanes[24], getProfile as any);
    const f25 = tlcFront(set, halfLanes[25], getProfile as any);
    const f26 = tlcFront(set, halfLanes[26], getProfile as any);

    expect(Math.abs(f0 - baseY)).toBeLessThanOrEqual(3);
    expect(Math.abs(f13 - baseY)).toBeLessThanOrEqual(3);
    expect(Math.abs(f24 - bendAtX(halfLanes[24].x0))).toBeLessThanOrEqual(4);
    expect(Math.abs(f25 - bendAtX(halfLanes[25].x0))).toBeLessThanOrEqual(4);
    expect(Math.abs(f26 - bendAtX(halfLanes[26].x0))).toBeLessThanOrEqual(5);
    expect(f26 - f13).toBeGreaterThanOrEqual(14);
  });

  it('stays cleanly flat when only a single isolated lane has an outlier front shift', () => {
    const L = 980;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(409);
    const profiles = laneIds.map((col) => {
      const fp = col === 26 ? 882 : 860; // single isolated outlier on last lane only
      return Array.from({ length: L }, (_, i) => {
        const wetDry = i < fp ? 178 : 189;
        const ridge = Math.abs(i - fp) <= 1 ? -14 : 0;
        return wetDry + ridge + rand() * 1.1;
      });
    });

    const seam = detectCurvedFrontSeam([{ profiles, sign: -1 }], laneIds, L);
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(seam.isCurved).toBe(false);
    expect(Math.abs(seam.byLane[26] - 860)).toBeLessThanOrEqual(2);
  });

  it('tracks a broad asymmetric dried-plate solvent-front accumulation band (4-5% width, no wet/dry step) bending on one side', () => {
    const W = 20;
    const L = 400;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(410);
    // Dried UV254 aluminium plate: same silica brightness before & after front (no wet-dry step),
    // asymmetric dark solvent-front band (gradual ~14 px wet-side tail, crisp ~4 px dry-side edge)
    // bending smoothly downward on the right half (360 -> 374 px).
    const trueY = (col: number) => (col <= 14 ? 360 : Math.round(360 + ((col - 14) / 12) * 14));

    const profiles: number[][] = [];
    const metrics = [];
    for (let col = 0; col < 27; col++) {
      const fp = trueY(col);
      const rgba = makeLaneStrip(W, L, [20, 178, 20], (_x, pos) => {
        const d = pos - fp;
        const sigma = d < 0 ? 6.5 : 2.5; // asymmetric broad wet-side tail + crisp dry-side edge
        const bandDrop = 85 * Math.exp(-0.5 * Math.pow(d / sigma, 2));
        const g = Math.max(0, Math.min(255, 178 - bandDrop + rand() * 2.5));
        return [20, g, 20];
      });
      const res = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, true);
      profiles.push(res.profile);
      metrics.push(res.metrics);
    }

    const seam = detectCurvedFrontSeam(
      [{ profiles, sign: -1, metrics, colPositions: laneIds }],
      laneIds,
      L
    );
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(seam.isCurved).toBe(true);
    expect(Math.abs(seam.byLane[2] - 360)).toBeLessThanOrEqual(3);
    expect(Math.abs(seam.byLane[13] - 360)).toBeLessThanOrEqual(3);
    expect(Math.abs(seam.byLane[25] - trueY(25))).toBeLessThanOrEqual(4);
    expect(seam.byLane[26] - seam.byLane[12]).toBeGreaterThanOrEqual(10);
  });

  it('tracks outer (dry-side) edge of wavy dark fronts on a 20x20 cm dual-half overlapping plate while ignoring 9.5/10.5 cm pencil lines, middle handwriting, high-Rf blobs, and drips', () => {
    // 20x20 cm head-to-head Merck plate geometry in 2000px vertical coordinates:
    // Lower half (ids 0..26, angle=0): starts at y0=1980 running UP (dy=-1), laneLen=1060 -> extends to y=920 (PAST the 10cm midline at y=1000!)
    // Upper half (ids 27..53, angle=180): starts at y0=20 running DOWN (dy=+1), laneLen=1060 -> extends to y=1080 (PAST the 10cm midline!)
    // Middle 1 cm gap sits between y=950 (9.5 cm pencil line) and y=1050 (10.5 cm pencil line) with handwritten label text.
    const L = 1060;
    const pairDist = 1960; // y0_lower (1980) - y0_upper (20) -> geometric midline at pos = 980 in each half
    const rand = rng(411);

    const lanes: TlcLane[] = [];
    for (let i = 0; i < 27; i++) {
      lanes.push({ id: i, x0: 260 + i * 100, y0: 1980, length: L, width: 64, angle: 0, zeroRf: null });
    }
    for (let i = 0; i < 27; i++) {
      lanes.push({ id: 27 + i, x0: 260 + i * 100, y0: 20, length: L, width: 64, angle: 180, zeroRf: null });
    }

    // True wavy OUTER (dry-side) edges in plate Y coordinates:
    // Upper half runs DOWN toward y~950 (with left wave dipping down to 964 on cols 0..2 and rising to 944 on cols 4..6)
    const upperOuterPlateY = (x: number) => {
      const col = (x - 260) / 100;
      const wave =
        col <= 2.5
          ? 14 * Math.cos((col / 2.5) * (Math.PI / 2))
          : col <= 6.5
          ? -8 * Math.sin(((col - 2.5) / 4) * Math.PI)
          : 4 * Math.sin(((col - 6.5) / 20) * Math.PI);
      return Math.round(952 + wave);
    };
    // Lower half runs UP toward y~1048 (wavy: higher at left ~1038, lower at right ~1056)
    const lowerOuterPlateY = (x: number) => {
      const col = (x - 260) / 100;
      const wave = -10 * Math.cos((col / 26) * Math.PI) + 5 * Math.sin((col / 5) * Math.PI);
      return Math.round(1047 + wave);
    };

    // Synthesize plate intensity at any (x, plateY): bright green silica (240)
    const plateValAt = (x: number, py: number): number => {
      let g = 240 + rand() * 1.6;
      const uEdge = upperOuterPlateY(x);
      const lEdge = lowerOuterPlateY(x);
      const col = Math.round((x - 260) / 100);

      // Upper dark solvent-front band (24 px thick behind its outer dry-side edge uEdge)
      if (py <= uEdge && py >= uEdge - 24) {
        const t = Math.min(1, (uEdge - py) / 3.5);
        g -= 185 * t;
      } else if (py > uEdge && py <= uEdge + 3) {
        g -= 185 * Math.max(0, 1 - (py - uEdge) / 3.5);
      }
      // High-Rf sample blobs piling up on the WET side of upper front (cols 11..13, 17..19)
      if (((col >= 11 && col <= 13) || (col >= 17 && col <= 19)) && py < uEdge - 18 && py >= uEdge - 48) {
        g -= 160;
      }

      // Lower dark solvent-front band (24 px thick behind its outer dry-side edge lEdge)
      if (py >= lEdge && py <= lEdge + 24) {
        const t = Math.min(1, (py - lEdge) / 3.5);
        g -= 185 * t;
      } else if (py < lEdge && py >= lEdge - 3) {
        g -= 185 * Math.max(0, 1 - (lEdge - py) / 3.5);
      }
      // Messy drips hanging off the WET side of lower front (cols 0..5, 22..26)
      if ((col <= 5 || col >= 22) && py > lEdge + 20 && py <= lEdge + 52) {
        g -= 140;
      }

      // Two razor-thin straight ruler pencil lines at y=935 and y=1065
      if (Math.abs(py - 935) <= 1 || Math.abs(py - 1065) <= 1) {
        g -= 155;
      }

      // Handwritten date/eluent text inside the 1 cm bright middle gap (y=985..1015, sparse across ~30% of columns)
      if (py >= 985 && py <= 1015 && (col % 3 === 1) && Math.abs(py - (995 + (col % 5) * 3)) <= 2) {
        g -= 130;
      }

      return Math.max(10, Math.min(250, g));
    };

    const set: TlcSet = {
      uid: 'dual-20x20',
      name: 'dual-20x20',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      imgs: { UV254: { name: 'uni_linint_corrected_uv254.png', url: '', bmp: {} as any } },
      cfg: { lanes, hasZeroRf: false, warnings: [] },
    };

    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) => {
      const th = (lane.angle * Math.PI) / 180;
      const dy = -Math.cos(th);
      return Array.from({ length: lane.length }, (_, pos) => plateValAt(lane.x0, Math.round(lane.y0 + dy * pos)));
    };

    // Confirm dual-half gap ceiling stays strictly inside the clean middle gap
    const lowerProfs = lanes.slice(0, 27).map((l) => getProfile(set, 'UV254', l));
    const upperProfs = lanes.slice(27, 54).map((l) => getProfile(set, 'UV254', l));
    const gapCeil = findDualHalfGapCeiling(
      [{ profiles: lowerProfs, sign: -1 }],
      [{ profiles: upperProfs, sign: -1 }],
      pairDist,
      L
    );
    expect(gapCeil?.gapConfirmed).toBe(true);
    // Lower half: outer edge is around pos = 1980 - 1047 = 933; opposing upper band starts around pos = 1980 - 952 = 1028
    expect(gapCeil!.maxFrontPos).toBeGreaterThan(950);
    expect(gapCeil!.maxFrontPos).toBeLessThan(1025);

    // Check LOWER half tracks wavy outer (dry-side) edge across left, middle, right
    for (const idx of [0, 3, 8, 13, 20, 26]) {
      const l = lanes[idx];
      const expectedPos = l.y0 - lowerOuterPlateY(l.x0);
      const detected = tlcFront(set, l, getProfile as any);
      expect(Math.abs(detected - expectedPos)).toBeLessThanOrEqual(6);
    }

    // Check UPPER half tracks wavy outer (dry-side) edge across left wave (cols 0, 5), high-Rf blob cols (12, 18), and right (26)
    for (const idx of [0, 5, 12, 18, 26]) {
      const l = lanes[27 + idx];
      const expectedPos = upperOuterPlateY(l.x0) - l.y0;
      const detected = tlcFront(set, l, getProfile as any);
      expect(Math.abs(detected - expectedPos)).toBeLessThanOrEqual(6);
    }
  });

  it('steps over a dark 2-px ruler pencil line ahead of the front and locks onto the outer edge of the real solvent-front band', () => {
    const L = 980;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(412);
    // Solvent stopped 24 px SHORT of the 9.5 cm ruler pencil line (pencil at 915, real front band 870..891)
    const pencilPos = 915;
    const trueOuterEdge = 891;

    const profiles = laneIds.map(() =>
      Array.from({ length: L }, (_, i) => {
        let v = 235 + rand() * 1.4;
        // Real dark solvent-front accumulation band (22 px wide, crisp outer edge at 891)
        if (i >= 869 && i <= trueOuterEdge) {
          v -= 110 * Math.min(1, (trueOuterEdge - i + 1) / 3);
        }
        // Stronger dark 2-px ruler pencil line sitting in dry silica 24 px ahead
        if (Math.abs(i - pencilPos) <= 1) {
          v -= 165;
        }
        return Math.max(10, v);
      })
    );

    const seam = detectCurvedFrontSeam([{ profiles, sign: -1, channel: 'UV254' }], laneIds, L);
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(Math.abs(seam.medianPos - trueOuterEdge)).toBeLessThanOrEqual(5);

    // Also verify a narrower 9-px medium solvent-front band still beats a heavier 2-px pencil line
    const mediumProfs = laneIds.map(() =>
      Array.from({ length: L }, (_, i) => {
        let v = 235 + rand() * 1.4;
        if (i >= trueOuterEdge - 9 && i <= trueOuterEdge) {
          v -= 95 * Math.min(1, (trueOuterEdge - i + 1) / 2.5);
        }
        if (Math.abs(i - pencilPos) <= 1) {
          v -= 165;
        }
        return Math.max(10, v);
      })
    );
    const mediumSeam = detectCurvedFrontSeam([{ profiles: mediumProfs, sign: -1, channel: 'UV254' }], laneIds, L);
    expect(mediumSeam.medianPos).toBeGreaterThan(0);
    expect(Math.abs(mediumSeam.medianPos - trueOuterEdge)).toBeLessThanOrEqual(5);
  });

  it('uses UV366 glowing wavy front band when UV254 is faint and suppresses White-light graphite pencil line', () => {
    const L = 900;
    const laneIds = Array.from({ length: 27 }, (_, i) => i);
    const rand = rng(413);
    const pencilPos = 825;
    const trueOuterEdge = (col: number) => Math.round(792 + 12 * Math.sin((col / 26) * Math.PI));

    // UV254: front invisible, only the ruler pencil line is dark
    const uv254Profs = laneIds.map(() =>
      Array.from({ length: L }, (_, i) => 220 - (Math.abs(i - pencilPos) <= 1 ? 95 : 0) + rand() * 1.5)
    );
    // White: ruler pencil line is strongly dark (no solvent front)
    const whiteProfs = laneIds.map(() =>
      Array.from({ length: L }, (_, i) => 230 - (Math.abs(i - pencilPos) <= 1 ? 120 : 0) + rand() * 1.5)
    );
    // UV366: bright glowing wavy solvent-front band (20 px wide behind trueOuterEdge)
    const uv366Profs = laneIds.map((col) => {
      const edge = trueOuterEdge(col);
      return Array.from({ length: L }, (_, i) => {
        let v = 18 + rand() * 1.0;
        if (i >= edge - 20 && i <= edge) {
          v += 95 * Math.min(1, (edge - i + 1) / 3);
        }
        return v;
      });
    });

    const seam = detectCurvedFrontSeam(
      [
        { profiles: uv254Profs, sign: -1, channel: 'UV254' },
        { profiles: uv366Profs, sign: +1, channel: 'UV366' },
        { profiles: whiteProfs, sign: -1, channel: 'White' },
      ],
      laneIds,
      L
    );
    expect(seam.medianPos).toBeGreaterThan(0);
    expect(Math.abs(seam.byLane[0] - trueOuterEdge(0))).toBeLessThanOrEqual(5);
    expect(Math.abs(seam.byLane[13] - trueOuterEdge(13))).toBeLessThanOrEqual(5);
    expect(Math.abs(seam.byLane[26] - trueOuterEdge(26))).toBeLessThanOrEqual(5);
  });
});

describe('tlcVision2d: multi-channel joint origin & smear-proof snapping', () => {
  it('rescues exact origin dot positions on UV254-silent lanes from White stain channel', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(501);
    const set: TlcSet = {
      uid: 'joint-origin',
      name: 'joint',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      originPx: null,
      originAuto: {},
      imgs: {
        UV254: { name: 'uv254.png', url: '', bmp: {} as any },
        White: { name: 'white.png', url: '', bmp: {} as any },
      },
      cfg,
    };

    // Lanes 0..19 have strong UV254 origin dots at y=110.
    // Lanes 20..26 are UV-silent (no UV254 dot), but have crisp White stain dots shifted to y=120!
    const getProfile = (_s: TlcSet, key: string, lane: TlcLane) => {
      const L = lane.length;
      if (key === 'UV254') {
        const hasUvDot = lane.id < 20;
        return Array.from({ length: L }, (_, i) => {
          const dot = hasUvDot ? 55 * Math.exp(-Math.pow((i - 110) / 5, 2)) : 0;
          return 210 - dot + rand() * 1.0;
        });
      }
      // White channel has strong stain dots on the UV-silent lanes (at 120) and faint/matching dots elsewhere
      const whitePos = lane.id >= 20 ? 120 : 110;
      const whiteAmp = lane.id >= 20 ? 48 : 22;
      return Array.from({ length: L }, (_, i) => {
        const dot = whiteAmp * Math.exp(-Math.pow((i - whitePos) / 5, 2));
        return 225 - dot + rand() * 1.0;
      });
    };

    const oUvLane = tlcOrigin(set, cfg.lanes[5], getProfile as any);
    const oSilentLane = tlcOrigin(set, cfg.lanes[23], getProfile as any);
    expect(Math.abs(oUvLane - 110)).toBeLessThanOrEqual(4);
    expect(Math.abs(oSilentLane - 120)).toBeLessThanOrEqual(4);
  });

  it('snaps upward-tailing polar origin smears back onto the smooth plate origin backbone', () => {
    const rand = rng(502);
    const L = 700;
    const entries = Array.from({ length: 27 }, (_, li) => {
      const profile = Array.from({ length: L }, (_, i) => {
        if (li === 12) {
          // Heavily overloaded polar origin blob smearing upward from 95 -> 135
          const deposit = i >= 95 && i <= 140 ? 60 * Math.exp(-Math.pow((i - 108) / 14, 2)) : 0;
          const tail = i > 108 ? 28 * Math.exp(-(i - 108) / 28) : 0;
          return 210 - Math.max(deposit, tail) + rand() * 1.0;
        }
        const dot = 55 * Math.exp(-Math.pow((i - 95) / 5, 2));
        return 210 - dot + rand() * 1.0;
      });
      return { laneId: li, profile };
    });

    const res = detectChannelOrigin(entries, -1, L);
    expect(res.byLane).toBeDefined();
    // Lane 12 should stay anchored near the true plate origin (95), not dragged upward to 108+
    expect(Math.abs((res.byLane?.[12] ?? 0) - 95)).toBeLessThanOrEqual(7);
  });
});

describe('tlcVision2d: 1-click color-signature matching & shared-reagent coherence', () => {
  it('findSimilarSpotsByColor matches all pale orange spots across lanes while ignoring blue spots', () => {
    const W = 40;
    const L = 450;
    const cx = (W - 1) / 2;
    const bg: [number, number, number] = [230, 230, 230];

    const makeLane = (seed: number, orangePos: number | null, bluePos: number | null) => {
      const r = rng(seed);
      const rgba = makeLaneStrip(W, L, bg, (x, pos) => {
        const n = r() * 0.8;
        let dr = 0,
          dg = 0,
          db = 0;
        if (orangePos != null) {
          const g = Math.exp(-(Math.pow((x - cx) / 7, 2) + Math.pow((pos - orangePos) / 10, 2)));
          // Pale orange spot: R stays high, G drops moderately, B drops strongly
          dr += -8 * g;
          dg += -42 * g;
          db += -95 * g;
        }
        if (bluePos != null) {
          const g = Math.exp(-(Math.pow((x - cx) / 7, 2) + Math.pow((pos - bluePos) / 10, 2)));
          // Blue spot: R drops strongly, G moderately, B stays high
          dr += -95 * g;
          dg += -40 * g;
          db += -6 * g;
        }
        return [bg[0] + dr + n, bg[1] + dg + n, bg[2] + db + n];
      });
      return analyzeLaneStripRgb(rgba, W, L, 'White', 0.35, false).metrics;
    };

    const m0 = makeLane(601, 210, null);
    const m1 = makeLane(602, 275, 160); // has BOTH an orange spot (at 275) and a blue spot (at 160)
    const m2 = makeLane(603, null, 240); // only blue spot -> must NOT match!

    const matches = findSimilarSpotsByColor(m0, 210, [
      { laneId: 0, origin: 45, front: 410, metrics: m0 },
      { laneId: 1, origin: 45, front: 410, metrics: m1 },
      { laneId: 2, origin: 45, front: 410, metrics: m2 },
    ]);

    const match1 = matches.find((m) => m.laneId === 1);
    const match2 = matches.find((m) => m.laneId === 2);
    expect(match1).toBeDefined();
    expect(match1!.spots.some((s) => Math.abs(s.pos - 275) <= 6)).toBe(true);
    expect(match1!.spots.some((s) => Math.abs(s.pos - 160) <= 10)).toBe(false);
    expect(match2).toBeUndefined();
  });

  it('rescueSharedReagentSpots promotes faint spots aligned across >= 3 wells sharing a starting material without promoting isolated noise', () => {
    const mkSpot = (rf: number) => ({
      pos: Math.round(50 + rf * 400),
      rf,
      strength: 0.12,
      source: 'auto' as const,
    });

    const rescued = rescueSharedReagentSpots([
      { laneId: 0, reagentCodes: ['A', 'X'], origin: 50, front: 450, soloSpots: [mkSpot(0.42)], relaxedCandidates: [] },
      { laneId: 1, reagentCodes: ['A', 'Y'], origin: 50, front: 450, soloSpots: [mkSpot(0.43)], relaxedCandidates: [] },
      { laneId: 2, reagentCodes: ['A', 'Z'], origin: 50, front: 450, soloSpots: [], relaxedCandidates: [mkSpot(0.415), mkSpot(0.77)] },
      { laneId: 3, reagentCodes: ['A', 'W'], origin: 50, front: 450, soloSpots: [], relaxedCandidates: [mkSpot(0.425)] },
    ]);

    // Lanes 2 & 3 should have their coherent Rf ~0.42 spot rescued, while lane 2's isolated Rf 0.77 speck is NOT rescued
    expect(rescued.get(2)?.some((s) => Math.abs(s.rf - 0.415) < 0.005)).toBe(true);
    expect(rescued.get(2)?.some((s) => Math.abs(s.rf - 0.77) < 0.01)).toBe(false);
    expect(rescued.get(3)?.some((s) => Math.abs(s.rf - 0.425) < 0.005)).toBe(true);
  });
});

describe('tlcVision2d: real-plate regressions (coalesced spots, off-plate/glass-edge, black top void)', () => {
  const W = 44;
  const L = 500;

  it('preserves strong wide/coalesced interior HTE spots (e.g. F7/D8/E3/F3) that touch BOTH left and right flanks', () => {
    const rand = rng(701);
    const spot1 = 180;
    const spot2 = 310;

    // Bright green F254 silica with TWO massive coalesced dark spots spanning the entire lane width (x = 0..W-1)
    const rgba = makeLaneStrip(W, L, [20, 225, 20], (_x, pos) => {
      const n = rand() * 1.2;
      const s1 = 140 * Math.exp(-Math.pow((pos - spot1) / 11, 2));
      const s2 = 115 * Math.exp(-Math.pow((pos - spot2) / 10, 2));
      const drop = s1 + s2;
      return [20, Math.max(0, 225 - drop + n), 20];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    expect(metrics.offPlate).toBe(false);
    expect(metrics.borderStraddle).toBe(false);
    const spots = findSpots(profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.some((s) => Math.abs(s.pos - spot1) <= 6)).toBe(true);
    expect(spots.some((s) => Math.abs(s.pos - spot2) <= 6)).toBe(true);
  });

  it('returns zero spots on pitch-black off-plate surround lanes (D5) even with cabinet reflections', () => {
    const rand = rng(702);
    const rgba = makeLaneStrip(W, L, [6, 10, 6], (_x, pos) => {
      const refl = 12 * Math.exp(-Math.pow((pos - 220) / 10, 2)) + 10 * Math.exp(-Math.pow((pos - 340) / 9, 2));
      const n = rand() * 1.0;
      return [6 + refl * 0.3 + n, 10 + refl + n, 6 + refl * 0.3 + n];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    expect(metrics.offPlate).toBe(true);
    const spots = findSpots(profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.length).toBe(0);
  });

  it('returns zero bogus ripple spots on lanes straddling the vertical glass plate cut edge (C1/F5/C9/F4)', () => {
    const rand = rng(703);
    const rgba = makeLaneStrip(W, L, [15, 220, 15], (x, pos) => {
      // Vertical glass edge runs down the middle of the lane box with ±2px wobble
      const edgeX = W / 2 + 2.2 * Math.sin(pos / 18) + 1.5 * Math.cos(pos / 9);
      const n = rand() * 1.2;
      if (x < edgeX) return [4 + n, 7 + n, 4 + n];
      return [15 + n, 220 + n, 15 + n];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    expect(metrics.borderStraddle).toBe(true);
    const spots = findSpots(profile, {
      sign: -1,
      origin: 55,
      front: 455,
      radius: 18,
      minProminence: 0.28,
      lane2d: metrics,
    });
    expect(spots.length).toBe(0);
  });

  it('ignores off-plate black lanes and stays strictly below physical top glass edge in tlcFront', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(704);
    const halfLanes = cfg.lanes.filter((l) => l.id < 27);
    const glassEdge = 855; // Top 125 px of every lane box extend into pitch-black void above glass!
    const trueFront = 808;

    const set: TlcSet = {
      uid: 'unaligned-upper',
      name: 'unaligned-upper',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      imgs: { UV254: { name: 'uv254.png', bmp: {} as any } },
      cfg,
    };

    // 5 outer lanes (0, 1, 24, 25, 26) sit completely off the glass plate in pitch-black surround
    const offPlateIds = new Set([0, 1, 24, 25, 26]);
    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) => {
      if (offPlateIds.has(lane.id)) {
        return Array.from({ length: lane.length }, () => 8 + rand() * 1.2);
      }
      return Array.from({ length: lane.length }, (_, i) => {
        if (i >= glassEdge) return 8 + rand() * 1.2; // black void above glass
        const wetDry = i < trueFront ? 195 : 210;
        const ridge = Math.abs(i - trueFront) <= 1 ? -14 : 0;
        return wetDry + ridge + rand() * 1.3;
      });
    };

    expect(isProfileOnPlate(getProfile(set, 'UV254', halfLanes[0]), -1)).toBe(false);
    expect(isProfileOnPlate(getProfile(set, 'UV254', halfLanes[10]), -1)).toBe(true);
    expect(
      detectGlassTopEdge(
        halfLanes.map((l) => getProfile(set, 'UV254', l)),
        -1
      )
    ).toBeCloseTo(glassEdge, -1);

    const detectedFront = tlcFront(set, halfLanes[13], getProfile as any);
    expect(detectedFront).toBeLessThan(glassEdge - 4);
    expect(Math.abs(detectedFront - trueFront)).toBeLessThanOrEqual(5);
  });

  it('blank silica flat-field calibration flattens UV254 lamp vignetting and subtracts UV366 corner glare', () => {
    const W = 40;
    const L = 400;
    const cx = (W - 1) / 2;
    const spotPos = 220;

    // 1. UV254 with heavy 35% top-to-bottom lamp shading + center hotspot
    const lampFactor = (pos: number) => 0.65 + 0.35 * Math.sin((pos / L) * Math.PI);
    const blankUv254 = makeLaneStrip(W, L, [0, 0, 0], (_x, pos) => {
      const g = 220 * lampFactor(pos);
      return [20 * lampFactor(pos), g, 20 * lampFactor(pos)];
    });
    const sampleUv254 = makeLaneStrip(W, L, [0, 0, 0], (x, pos) => {
      const f = lampFactor(pos);
      const dx = (x - cx) / 7;
      const dy = (pos - spotPos) / 10;
      const quench = 1 - 0.55 * Math.exp(-(dx * dx + dy * dy));
      return [20 * f, 220 * f * quench, 20 * f];
    });

    const flatUv254 = applyFlatFieldCorrection(sampleUv254, blankUv254, W, L, 'UV254');
    const { profile: flatProf } = analyzeLaneStripRgb(flatUv254, W, L, 'UV254', 0.35, false);
    // Clean silica at pos=60 vs pos=340 should now be nearly identical (< 4 counts diff despite 35% shading)
    expect(Math.abs(flatProf[60] - flatProf[340])).toBeLessThanOrEqual(4);
    // Spot at spotPos still drops strongly (> 90 counts below flat background)
    expect(flatProf[60] - flatProf[spotPos]).toBeGreaterThan(85);

    // 2. UV366 with strong +75 corner/bottom violet lamp glare
    const glareAt = (pos: number) => 75 * Math.exp(-pos / 65);
    const blankUv366 = makeLaneStrip(W, L, [14, 14, 20], (_x, pos) => [
      14 + glareAt(pos) * 0.4,
      14 + glareAt(pos) * 0.2,
      20 + glareAt(pos),
    ]);
    const sampleUv366 = makeLaneStrip(W, L, [14, 14, 20], (x, pos) => {
      const dx = (x - cx) / 7;
      const dy = (pos - spotPos) / 10;
      const fluor = 150 * Math.exp(-(dx * dx + dy * dy));
      return [
        14 + glareAt(pos) * 0.4 + fluor * 0.2,
        14 + glareAt(pos) * 0.2 + fluor * 0.8,
        20 + glareAt(pos) + fluor,
      ];
    });

    const flatUv366 = applyFlatFieldCorrection(sampleUv366, blankUv366, W, L, 'UV366');
    const { profile: flat366Prof } = analyzeLaneStripRgb(flatUv366, W, L, 'UV366', 0.35, false);
    // Glare near pos=20 should be removed down near clean dark silica baseline (pos=340)
    expect(Math.abs(flat366Prof[20] - flat366Prof[340])).toBeLessThanOrEqual(4);
    // Fluorescent spot at spotPos preserved at full strength
    expect(flat366Prof[spotPos] - flat366Prof[340]).toBeGreaterThan(120);
  });

  it('resolves touching figure-8 overlapping UV254 spots with lighter middle waist into 2 spots while keeping monotonic streaks as 1 spot', () => {
    const W = 32;
    const L = 460;
    const origin = 50;
    const front = 410; // span = 360
    const cx = (W - 1) / 2;

    // 1. Touching figure-8 doublet just above origin (matches real zoomed-in doublet geometry):
    //    Lower dark oval at pos=68 (Rf=0.050), upper dark oval at pos=95 (Rf=0.125),
    //    overlapping heavily so the middle waist at pos=82 only lightens by ~10-15% in 1D
    //    while pinching inward laterally in 2D.
    const doubletRgba = makeLaneStrip(W, L, [8, 240, 22], (x, pos) => {
      const dx = (x - cx) / 9.2;
      const dy1 = (pos - 68) / 11.5;
      const dy2 = (pos - 95) / 11.5;
      const s1 = 172 * Math.exp(-(dx * dx + dy1 * dy1));
      const s2 = 148 * Math.exp(-(dx * dx + dy2 * dy2));
      // Saturated UV254 quenching combines sub-additively like real dark overlapping spots
      const quench = Math.min(182, s1 + s2 - 0.35 * Math.min(s1, s2));
      return [8, Math.max(48, 240 - quench), 22];
    });
    const { profile: dProf, metrics: dMetrics } = analyzeLaneStripRgb(doubletRgba, W, L, 'UV254', 0.35, false);
    expect(dMetrics.rowMass).toBeDefined();
    expect(dMetrics.spotWidth).toBeDefined();

    const stdDoublet = findSpots(dProf, {
      sign: -1,
      origin,
      front,
      radius: 22,
      minProminence: 0.28,
      lane2d: dMetrics,
    });
    expect(stdDoublet.length).toBe(2);
    expect(Math.abs(stdDoublet[0].pos - 68)).toBeLessThanOrEqual(5);
    expect(Math.abs(stdDoublet[1].pos - 95)).toBeLessThanOrEqual(5);

    // Broad Spots mode (minProminence = 0.55) still respects user request to merge broad touching bands
    const broadDoublet = findSpots(dProf, {
      sign: -1,
      origin,
      front,
      radius: 22,
      minProminence: 0.55,
      lane2d: dMetrics,
    });
    expect(broadDoublet.length).toBe(1);

    // 2. Single monotonically tapering polar streak/tail with tiny noise ripples -> MUST remain 1 spot
    const rand = rng(912);
    const streakRgba = makeLaneStrip(W, L, [8, 240, 22], (x, pos) => {
      const dx = (x - cx) / 8.5;
      let quench = 0;
      if (pos >= 110 && pos <= 220) {
        const core = 155 * Math.exp(-(dx * dx + ((pos - 130) / 11) ** 2));
        const tail = pos > 130 ? 95 * Math.exp(-((pos - 130) / 38)) * Math.exp(-(dx * dx * 1.3)) : 0;
        quench = Math.max(core, tail) + (rand() - 0.5) * 4;
      }
      return [8, Math.max(45, Math.min(245, 240 - quench)), 22];
    });
    const { profile: sProf, metrics: sMetrics } = analyzeLaneStripRgb(streakRgba, W, L, 'UV254', 0.35, false);
    const streakSpots = findSpots(sProf, {
      sign: -1,
      origin,
      front,
      radius: 22,
      minProminence: 0.28,
      lane2d: sMetrics,
    });
    expect(streakSpots.length).toBe(1);
    expect(Math.abs(streakSpots[0].pos - 130)).toBeLessThanOrEqual(8);
  });

  it('rejects full-width dark solvent-front meniscus bands and tiny green-silica ripples while keeping real spots', () => {
    const W = 32;
    const L = 460;
    const origin = 50;
    const front = 410; // span = 360
    const cx = (W - 1) / 2;
    const rand = rng(913);

    const rgba = makeLaneStrip(W, L, [8, 240, 22], (x, pos) => {
      // Dark black glass gap / handwriting bar immediately past front (pos >= 402)
      if (pos >= 408) return [6, 35, 10];
      // Dark full-width solvent-front meniscus band right below front (pos 397..408, Rf ~ 0.965..0.995)
      if (pos >= 397) {
        const t = (pos - 397) / 11;
        return [8, Math.max(42, 240 - 165 * Math.min(1, t * 1.4)), 22];
      }
      // One genuine interior spot at pos = 230 (Rf = 0.50)
      const dx = (x - cx) / 7.5;
      const dy = (pos - 230) / 9;
      const realSpot = 135 * Math.exp(-(dx * dx + dy * dy));
      // Invisible 3.5-unit green-silica ripple at pos = 310
      const tinyRipple = 3.5 * Math.exp(-(((pos - 310) / 7) ** 2));
      const g = Math.max(40, Math.min(245, 240 - realSpot - tinyRipple + (rand() - 0.5) * 2.5));
      return [8, g, 22];
    });

    const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
    const spots = findSpots(profile, {
      sign: -1,
      origin,
      front,
      radius: 20,
      minProminence: 0.28,
      lane2d: metrics,
    });

    // Must detect ONLY the real interior spot at Rf = 0.50 (no meniscus fake at Rf ~0.97, no 3.5-unit green ripple)
    expect(spots.length).toBe(1);
    expect(spots[0].rf).toBeCloseTo(0.50, 2);
  });

  it('resolves wide low-Rf doublets (~150 px tall) at native high camera resolution (L=1000, span=850) without rolling-baseline collapse or origin-dot false positives', () => {
    const W = 60;
    const L = 1000;
    const origin = 50;
    const front = 900; // span = 850 (native 3280px plate camera scale)
    const cx = (W - 1) / 2;

    // 1. Native-scale low-Rf doublet spanning pos=50..185 (135 px tall — wider than legacy win=100!):
    //    Origin deposit at pos=50, lower dark spot at pos=90 (Rf=0.047), lighter waist at pos=128,
    //    upper dark spot at pos=158 (Rf=0.127).
    const doubletRgba = makeLaneStrip(W, L, [8, 244, 22], (x, pos) => {
      const dx = (x - cx) / 18;
      const orig = 152 * Math.exp(-(dx * dx + ((pos - 50) / 16) ** 2));
      const lo = 175 * Math.exp(-(dx * dx + ((pos - 90) / 24) ** 2));
      const hi = 156 * Math.exp(-(dx * dx + ((pos - 158) / 24) ** 2));
      const q = Math.min(182, Math.max(orig, lo + hi - 0.35 * Math.min(lo, hi)));
      return [8, Math.max(52, 244 - q), 22];
    });
    const { profile: dProf, metrics: dMetrics } = analyzeLaneStripRgb(doubletRgba, W, L, 'UV254', 0.35, false);
    const dSpots = findSpots(dProf, {
      sign: -1,
      origin,
      front,
      radius: 24,
      minProminence: 0.28,
      lane2d: dMetrics,
    });
    expect(dSpots.length).toBe(2);
    expect(Math.abs(dSpots[0].pos - 90)).toBeLessThanOrEqual(10);
    expect(Math.abs(dSpots[1].pos - 158)).toBeLessThanOrEqual(10);

    // 2. Native-scale single upper spot + uneluted origin dot (radius ~14 px) -> MUST NOT put a fake dot on origin
    const singleRgba = makeLaneStrip(W, L, [8, 244, 22], (x, pos) => {
      const dx = (x - cx) / 17;
      const orig = 100 * Math.exp(-(dx * dx + ((pos - 50) / 13) ** 2));
      const upper = 135 * Math.exp(-(dx * dx + ((pos - 165) / 22) ** 2));
      return [8, Math.max(55, 244 - orig - upper), 22];
    });
    const { profile: sProf, metrics: sMetrics } = analyzeLaneStripRgb(singleRgba, W, L, 'UV254', 0.35, false);
    const sSpots = findSpots(sProf, {
      sign: -1,
      origin,
      front,
      radius: 24,
      minProminence: 0.28,
      lane2d: sMetrics,
    });
    expect(sSpots.length).toBe(1);
    expect(Math.abs(sSpots[0].pos - 165)).toBeLessThanOrEqual(10);
  });
});

describe('tlcVision2d: Step 2 origin detection (plate-space CSV alignment, huge/tailing dots, dust specks, multi-channel composites)', () => {
  it('centers huge saturated dots, preserves experimental spotting jitter, and keeps blank lanes dead-smooth in plate-space even with uneven CSV y0 offsets', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const upperLanes = cfg.lanes.filter((l) => l.id >= 27);
    const y0Offsets = [
      -10, 4, -6, 2, -8, 6, 14, -4, 10, 0, -5, 3, 15, 6, -2, -4, 5, 11, -7, 4, -9, 2, 8, -3, 12, 16, -12,
    ];
    for (let col = 0; col < 27; col++) {
      upperLanes[col].angle = 180;
      upperLanes[col].y0 = 140 + y0Offsets[col];
    }

    const hugeCols = new Set([3, 9, 15, 21]);
    const medCols = new Set([1, 4, 10, 16, 22, 23]);
    const faintCols = new Set([7, 11]);
    const jitter = new Map<number, number>([
      [4, 3],
      [7, -2],
      [10, 2],
      [11, -5],
      [16, 3],
      [22, 2],
    ]);
    // Physical plate-space origin Y line (slight natural plate tilt)
    const truePlateY = (col: number) => 272 - 0.35 * col;

    const set: TlcSet = {
      uid: 'step2-plate-space-csv',
      name: 'Step 2 Plate-Space CSV',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      originAutoByLane: {},
      imgs: { UV254: { name: 'uv254.png', bmp: {} as any } },
      cfg,
    };

    const getProfile = (_s: TlcSet, _key: string, l: TlcLane) => {
      const col = l.id % 27;
      const dy = -Math.cos((l.angle * Math.PI) / 180); // +1 for upper half (angle=180)
      const dotY = truePlateY(col) + (jitter.get(col) ?? 0);
      const localC = (dotY - l.y0) / dy;
      return Array.from({ length: l.length }, (_, i) => {
        if (hugeCols.has(col)) {
          // Huge saturated black circular dot (radius ~22 px) + moderate downward elution smear
          const d = Math.abs(i - localC) / 22;
          let dark = d < 0.62 ? 240 : d < 1.3 ? 240 * Math.exp(-(((d - 0.62) / 0.32) ** 2)) : 0;
          if (i > localC) dark = Math.max(dark, 110 * Math.exp(-(i - localC) / 38));
          return Math.max(4, 248 - dark);
        }
        if (medCols.has(col) || faintCols.has(col)) {
          const depth = faintCols.has(col) ? 62 : 150;
          return 248 - depth * Math.exp(-(((i - localC) / 10) ** 2));
        }
        return 248;
      });
    };

    const detectedPlateY = upperLanes.map((l) => {
      const localOrigin = tlcOrigin(set, l, getProfile as any);
      const dy = -Math.cos((l.angle * Math.PI) / 180);
      return l.y0 + dy * localOrigin;
    });

    // Huge saturated dots stay dead-center on their circular core (not shifted forward!)
    for (const col of hugeCols) {
      expect(Math.abs(detectedPlateY[col] - truePlateY(col))).toBeLessThanOrEqual(3);
    }
    // Clean spotted lanes keep their individual experimental spotting deviation (e.g. col 11 at -5 px)
    expect(Math.abs(detectedPlateY[11] - (truePlateY(11) - 5))).toBeLessThanOrEqual(3);
    expect(Math.abs(detectedPlateY[4] - (truePlateY(4) + 3))).toBeLessThanOrEqual(3);

    // Blank lanes align smoothly in physical plate-space Y despite +/-16 px uneven CSV y0 offsets
    const blankCols = [0, 2, 5, 6, 8, 12, 13, 14, 17, 18, 19, 20, 24, 25, 26];
    for (const col of blankCols) {
      expect(Math.abs(detectedPlateY[col] - truePlateY(col))).toBeLessThanOrEqual(3);
    }
    for (let k = 0; k < blankCols.length - 1; k++) {
      const a = blankCols[k];
      const b = blankCols[k + 1];
      if (b === a + 1) {
        expect(Math.abs(detectedPlateY[b] - detectedPlateY[a])).toBeLessThanOrEqual(2);
      }
    }
  });

  it('centers 2D heavy vertical comets on their circular base and ignores lane-border dust specks on blank lanes', () => {
    const W = 64;
    const L = 800;
    const cx = (W - 1) / 2;
    const trueOrigin = 115;

    const entries = Array.from({ length: 16 }, (_, id) => {
      const rgba = makeLaneStrip(W, L, [10, 244, 18], (x, pos) => {
        if (id === 2) {
          // Heavy upward-tailing comet: round circular base (r=14 px) at pos=115 + saturated vertical streak up to 180
          const rBase = Math.hypot(x - cx, pos - trueOrigin) / 14;
          let dark = rBase < 0.65 ? 235 : rBase < 1.35 ? 235 * Math.exp(-(((rBase - 0.65) / 0.35) ** 2)) : 0;
          if (pos > trueOrigin) {
            const dx = (x - cx) / 11;
            const streak = 215 * Math.exp(-(dx * dx)) * Math.exp(-(pos - trueOrigin) / 42);
            dark = Math.max(dark, streak);
          }
          return [10, Math.max(5, 244 - dark), 18];
        }
        if (id === 5) {
          // Blank lane with a dark 3-px dust speck on the right lane border at pos=128 (like real plate!)
          const dSpeck = Math.hypot(x - (W - 4), pos - 128);
          const speck = dSpeck <= 3.5 ? 190 * Math.exp(-((dSpeck / 2.0) ** 2)) : 0;
          return [10, Math.max(5, 244 - speck), 18];
        }
        if (id === 8 || id === 12) {
          // Pure blank lanes
          return [10, 244, 18];
        }
        // Normal clean round origin dots with +/-2 px spotting jitter
        const c = trueOrigin + (id % 3 === 0 ? 2 : id % 3 === 1 ? -2 : 0);
        const r = Math.hypot(x - cx, pos - c) / 12;
        const dark = 175 * Math.exp(-(r * r) / 2);
        return [10, Math.max(10, 244 - dark), 18];
      });
      const { profile, metrics } = analyzeLaneStripRgb(rgba, W, L, 'UV254', 0.35, false);
      return {
        laneId: id,
        profile,
        lane: { x0: 500 + id * 76, y0: 2200, angle: 0, width: W, length: L },
        metrics,
      };
    });

    const res = detectChannelOrigin(entries, -1, L);
    expect(res.byLane).toBeDefined();
    // Lane 2 (heavy vertical comet) stays dead-center on its circular base (~115), NOT pulled up into the streak!
    expect(Math.abs((res.byLane?.[2] ?? 0) - trueOrigin)).toBeLessThanOrEqual(5);
    // Lane 5 (blank with right-border dust speck at 128) ignores the speck and stays strictly on baseline (~115)!
    expect(Math.abs((res.byLane?.[5] ?? 0) - trueOrigin)).toBeLessThanOrEqual(2);
    expect(Math.abs((res.byLane?.[8] ?? 0) - trueOrigin)).toBeLessThanOrEqual(2);
  });

  it('fuses UV254 + UV366 + White composites for split-channel plates, upgrades tailing lanes from clean channels, and keeps blanks flat despite White ripples', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(903);
    const basePos = 118;

    const set: TlcSet = {
      uid: 'step2-multichannel-composite',
      name: 'Step 2 Multi-Channel Composite',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      originAutoByLane: {},
      imgs: {
        UV254: { name: 'uv254.png', bmp: {} as any },
        UV366: { name: 'uv366.png', bmp: {} as any },
        White: { name: 'white.png', bmp: {} as any },
      },
      cfg,
    };

    // Split visibility across ALL 3 channels:
    // - Lanes 0..6: visible ONLY in UV254 (with lane 3 heavily smearing forward on UV254, but clean on White!)
    // - Lanes 7..13: visible ONLY in UV366 (bright fluorescent dots at basePos + 4)
    // - Lanes 14..20: visible ONLY in White (stained dots at basePos - 3)
    // - Lanes 21..26: BLANK in all channels, with weak White-light silica ripples (amp ~7) at basePos + 11
    const getProfile = (_s: TlcSet, key: string, l: TlcLane) => {
      const col = l.id % 27;
      const L = l.length;
      if (key === 'UV254') {
        return Array.from({ length: L }, (_, i) => {
          let dark = 0;
          if (col === 3) {
            const core = 180 * Math.exp(-(((i - (basePos + 8)) / 15) ** 2));
            const tail = i > basePos ? 130 * Math.exp(-(i - basePos) / 40) : 0;
            dark = Math.max(core, tail);
          } else if (col <= 6) {
            dark = 130 * Math.exp(-(((i - basePos) / 8) ** 2));
          }
          return Math.max(10, 235 - dark + rand() * 0.8);
        });
      }
      if (key === 'UV366') {
        return Array.from({ length: L }, (_, i) => {
          const glow = col >= 7 && col <= 13 ? 120 * Math.exp(-(((i - (basePos + 4)) / 8) ** 2)) : 0;
          return Math.min(255, 16 + glow + rand() * 0.8);
        });
      }
      // White channel
      return Array.from({ length: L }, (_, i) => {
        let drop = 0;
        if (col === 3) {
          // Clean un-smeared dot on White at exact true origin (basePos)
          drop = 75 * Math.exp(-(((i - basePos) / 7) ** 2));
        } else if (col >= 14 && col <= 20) {
          drop = 70 * Math.exp(-(((i - (basePos - 3)) / 8) ** 2));
        } else if (col >= 21) {
          // Weak paper/silica ripple on blank lanes -> must NOT pull blank lanes off baseline!
          drop = 7 * Math.exp(-(((i - (basePos + 11)) / 9) ** 2));
        }
        return Math.max(10, 225 - drop + rand() * 0.9);
      });
    };

    const oUv254 = tlcOrigin(set, cfg.lanes[1], getProfile as any);
    const oTailingUpgraded = tlcOrigin(set, cfg.lanes[3], getProfile as any);
    const oUv366 = tlcOrigin(set, cfg.lanes[10], getProfile as any);
    const oWhite = tlcOrigin(set, cfg.lanes[17], getProfile as any);
    const oBlank23 = tlcOrigin(set, cfg.lanes[23], getProfile as any);
    const oBlank25 = tlcOrigin(set, cfg.lanes[25], getProfile as any);

    expect(Math.abs(oUv254 - basePos)).toBeLessThanOrEqual(3);
    expect(Math.abs(oTailingUpgraded - basePos)).toBeLessThanOrEqual(3);
    expect(Math.abs(oUv366 - (basePos + 4))).toBeLessThanOrEqual(4);
    expect(Math.abs(oWhite - (basePos - 3))).toBeLessThanOrEqual(4);
    // Blank lanes must NOT jump to the +11 px White ripple!
    expect(Math.abs(oBlank23 - basePos)).toBeLessThanOrEqual(4);
    expect(Math.abs(oBlank25 - basePos)).toBeLessThanOrEqual(4);
  });

  it('keeps faint fuzzy UV366 halos centered/aligned on the baseline instead of jumping to their upper rim on noisy dark-teal backgrounds', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(1366);
    const basePos = 114;

    const set: TlcSet = {
      uid: 'step2-uv366-faint-halos',
      name: 'Step 2 UV366 Faint Halos',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      originAutoByLane: {},
      imgs: {
        UV366: { name: 'uv366.png', bmp: {} as any },
        UV254: { name: 'uv254.png', bmp: {} as any },
      },
      cfg,
    };

    const brightCols = new Set([0, 1, 6, 7, 10, 11, 14, 15, 19, 20, 24]);
    const faintHaloCols = new Set([2, 3, 4]);
    const coffeeRingCols = new Set([5, 9]); // col 5: dim ring (amp ~24), col 9: moderate ring (amp ~42) with brighter upper rim

    const getProfile = (_s: TlcSet, key: string, l: TlcLane) => {
      const col = l.id % 27;
      const L = l.length;
      if (key === 'UV366') {
        return Array.from({ length: L }, (_, i) => {
          const noise = (rand() - 0.5) * 7.5; // granular dark-teal camera noise
          let glow = 0;
          if (brightCols.has(col)) {
            const jitter = col === 1 ? 1 : col === 10 ? -2 : 0;
            glow = 135 * Math.exp(-(((i - (basePos + jitter)) / 11) ** 2));
            if (col === 1) {
              glow = Math.max(glow, 60 * Math.exp(-(((i - (basePos + 28)) / 5) ** 2)));
            }
          } else if (faintHaloCols.has(col)) {
            // Very faint broad fuzzy halo with slightly brighter upper rim (+13 px)
            const halo = 9.5 * Math.exp(-(((i - basePos) / 17) ** 2));
            const upperRim = 5.5 * Math.exp(-(((i - (basePos + 13)) / 6.5) ** 2));
            glow = halo + upperRim;
            if (col === 3) {
              glow = Math.max(glow, 115 * Math.exp(-(((i - (basePos + 52)) / 8) ** 2)));
            }
          } else if (coffeeRingCols.has(col)) {
            // Realistic UV366 coffee-ring halo centered on basePos (hollow middle, brighter upper rim at +14 px)
            const scale = col === 5 ? 24 : 42;
            const body = scale * 0.72 * Math.exp(-(((i - basePos) / 19) ** 2));
            const upperRim = scale * 0.42 * Math.exp(-(((i - (basePos + 14)) / 6.5) ** 2));
            const lowerRim = scale * 0.25 * Math.exp(-(((i - (basePos - 14)) / 6.5) ** 2));
            glow = body + upperRim + lowerRim;
          }
          return Math.max(2, Math.min(255, 68 + glow + noise));
        });
      }
      // UV254: silent on faintHaloCols & coffeeRingCols, clean dots on brightCols & extra lanes
      return Array.from({ length: L }, (_, i) => {
        const noise = (rand() - 0.5) * 3.0;
        let dark = 0;
        if (brightCols.has(col) || col === 8 || col === 17) {
          dark = 140 * Math.exp(-(((i - basePos) / 9) ** 2));
        }
        return Math.max(8, Math.min(255, 240 - dark + noise));
      });
    };

    const oBright1 = tlcOrigin(set, cfg.lanes[1], getProfile as any);
    const oHalo2 = tlcOrigin(set, cfg.lanes[2], getProfile as any);
    const oHalo3 = tlcOrigin(set, cfg.lanes[3], getProfile as any);
    const oHalo4 = tlcOrigin(set, cfg.lanes[4], getProfile as any);
    const oRing5 = tlcOrigin(set, cfg.lanes[5], getProfile as any);
    const oRing9 = tlcOrigin(set, cfg.lanes[9], getProfile as any);

    expect(Math.abs(oBright1 - (basePos + 1))).toBeLessThanOrEqual(3);
    expect(Math.abs(oHalo2 - basePos)).toBeLessThanOrEqual(4);
    expect(Math.abs(oHalo3 - basePos)).toBeLessThanOrEqual(4);
    expect(Math.abs(oHalo4 - basePos)).toBeLessThanOrEqual(4);
    // Coffee-ring halos must stay centered on basePos instead of locking onto their +14 px upper rim!
    expect(Math.abs(oRing5 - basePos)).toBeLessThanOrEqual(4);
    expect(Math.abs(oRing9 - basePos)).toBeLessThanOrEqual(4);
  });

  it('aligns pre-run undeveloped TLC origin dots (across UV254/UV366/White) to a shifted & slightly tilted developed plate and merges accurately', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(2026);
    const preBase = 104;
    const shiftPx = 14; // plate placed +14 px (~1.4 mm) higher in the box after running
    const tiltPerLane = 0.4; // slight ~0.4 px/lane box-corner tilt across 27 lanes (~10.4 px end-to-end)

    // Deterministic per-lane robot spotting jitter (±4 px) shared identically by pre-run and developed plate
    const jitterByCol = Array.from({ length: 27 }, (_, col) => {
      const pattern = [-3, 2, -4, 3, -1, 4, -2, 0, 3, -3, 2, -2, 4, -1, 1, -4, 2, 0, -2, 3, -1, 2, -3, 1, -2, 3, 0];
      return pattern[col] ?? 0;
    });

    const prePosFor = (col: number) => preBase + jitterByCol[col];
    const devTruePosFor = (col: number) => prePosFor(col) + shiftPx + tiltPerLane * (col - 13);

    const set: TlcSet = {
      uid: 'step2b-prerun-rigid-merge',
      name: 'Step 2B Pre-Run Rigid Merge',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      originAutoByLane: {},
      imgs: {
        UV254: { name: 'dev_uv254.png', bmp: {} as any },
        UV366: { name: 'dev_uv366.png', bmp: {} as any },
        White: { name: 'dev_white.png', bmp: {} as any },
      },
      preRunImgs: {
        UV254: { name: 'pre_uv254.png', bmp: {} as any },
        UV366: { name: 'pre_uv366.png', bmp: {} as any },
        White: { name: 'pre_white.png', bmp: {} as any },
      },
      preRunEnabled: true,
      cfg,
    };

    const elutedCols = new Set([2, 3, 15, 16]); // completely migrated away on developed plate
    const coffeeRingCols = new Set([5, 6]); // faint UV366 coffee-ring halo with misleading +15 px upper rim on developed plate
    const tailingCols = new Set([9, 10]); // heavy upward comet smear on developed plate

    const getProfile = (s: TlcSet, key: string, l: TlcLane) => {
      const col = l.id % 27;
      const L = l.length;
      const isPre = Boolean((s as any)._isPreRunProbe);

      if (isPre) {
        // Undeveloped plate: EVERY lane has a crisp, un-eluted spotted dot in at least one channel:
        // cols 0..11 in UV254, cols 12..19 in UV366, cols 20..26 in White
        const p0 = prePosFor(col);
        if (key === 'UV254') {
          return Array.from({ length: L }, (_, i) => {
            const dark = col <= 11 ? 155 * Math.exp(-(((i - p0) / 7) ** 2)) : 0;
            return Math.max(10, 238 - dark + rand() * 1.0);
          });
        }
        if (key === 'UV366') {
          return Array.from({ length: L }, (_, i) => {
            const glow = col >= 12 && col <= 19 ? 140 * Math.exp(-(((i - p0) / 7) ** 2)) : 0;
            return Math.min(255, 22 + glow + rand() * 1.0);
          });
        }
        return Array.from({ length: L }, (_, i) => {
          const drop = col >= 20 ? 95 * Math.exp(-(((i - p0) / 7) ** 2)) : 0;
          return Math.max(10, 228 - drop + rand() * 1.0);
        });
      }

      // Developed plate: shifted by shiftPx + tiltPerLane*(col-13), with eluted, coffee-ring, and tailing lanes
      const d0 = devTruePosFor(col);
      if (key === 'UV254') {
        return Array.from({ length: L }, (_, i) => {
          let dark = 0;
          if (elutedCols.has(col)) {
            // Eluted far up-lane (Rf ~ 0.65), nothing left at origin
            dark = 135 * Math.exp(-(((i - (d0 + 380)) / 14) ** 2));
          } else if (tailingCols.has(col)) {
            // Upward comet smear starting at d0
            const core = 175 * Math.exp(-(((i - (d0 + 11)) / 16) ** 2));
            const tail = i > d0 ? 125 * Math.exp(-(i - d0) / 48) : 0;
            dark = Math.max(core, tail);
          } else if (col <= 11 && !coffeeRingCols.has(col)) {
            dark = 135 * Math.exp(-(((i - d0) / 8) ** 2));
          }
          return Math.max(10, 236 - dark + rand() * 1.2);
        });
      }
      if (key === 'UV366') {
        return Array.from({ length: L }, (_, i) => {
          let glow = 0;
          if (coffeeRingCols.has(col)) {
            const body = 20 * Math.exp(-(((i - d0) / 18) ** 2));
            const upperRim = 14 * Math.exp(-(((i - (d0 + 15)) / 6) ** 2));
            glow = body + upperRim;
          } else if (col >= 12 && col <= 19 && !elutedCols.has(col)) {
            glow = 125 * Math.exp(-(((i - d0) / 8) ** 2));
          }
          return Math.min(255, 24 + glow + rand() * 1.5);
        });
      }
      // White channel
      return Array.from({ length: L }, (_, i) => {
        const drop = col >= 20 ? 80 * Math.exp(-(((i - d0) / 8) ** 2)) : 0;
        return Math.max(10, 226 - drop + rand() * 1.2);
      });
    };

    // Evaluate across eluted, coffee-ring, tailing, and clean lanes in all 3 channels
    const testCols = [0, 2, 3, 5, 6, 9, 10, 14, 15, 16, 22, 26];
    for (const col of testCols) {
      const got = tlcOrigin(set, cfg.lanes[col], getProfile as any);
      const expected = devTruePosFor(col);
      expect(Math.abs(got - expected), `col=${col} got=${got} expected=${expected}`).toBeLessThanOrEqual(3.0);
    }

    // Alignment diagnostics should reflect rigid-merged mode with recovered shift and tilt
    const align0 = set.preRunAlignment?.[0];
    expect(align0).toBeDefined();
    expect(align0!.mode).toBe('rigid-merged');
    expect(align0!.matchedAnchors).toBeGreaterThanOrEqual(10);
    expect(Math.abs(align0!.dyPx - shiftPx)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(align0!.slopePxPerLane - tiltPerLane)).toBeLessThanOrEqual(0.25);

    // Toggling preRunEnabled = false must cleanly fall back to developed-only origin detection
    set.preRunEnabled = false;
    set.originAuto = {};
    set.originAutoByLane = {};
    const fallbackClean = tlcOrigin(set, cfg.lanes[14], getProfile as any);
    expect(Math.abs(fallbackClean - devTruePosFor(14))).toBeLessThanOrEqual(4.0);
    expect(set.preRunAlignment?.[0]).toBeUndefined();
  });

  it('uses direct-box pre-run origin cleanly when all developed spots eluted away from the origin', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const rand = rng(9911);
    const preBase = 112;
    const jitter = (col: number) => ((col % 5) - 2) * 1.5;

    const set: TlcSet = {
      uid: 'step2b-direct-box-fallback',
      name: 'Step 2B Direct Box Fallback',
      frameW: 3280,
      frontPx: null,
      frontAuto: {},
      frontAutoByLane: {},
      originPx: null,
      originAuto: {},
      originAutoByLane: {},
      imgs: {
        UV254: { name: 'dev_uv254.png', bmp: {} as any },
      },
      preRunImgs: {
        UV254: { name: 'pre_uv254.png', bmp: {} as any },
      },
      preRunEnabled: true,
      cfg,
    };

    const getProfile = (s: TlcSet, _key: string, l: TlcLane) => {
      const col = l.id % 27;
      const L = l.length;
      const isPre = Boolean((s as any)._isPreRunProbe);
      if (isPre) {
        const p0 = preBase + jitter(col);
        return Array.from({ length: L }, (_, i) => {
          const dark = 150 * Math.exp(-(((i - p0) / 7) ** 2));
          return Math.max(10, 238 - dark + rand() * 0.8);
        });
      }
      // Developed plate: every compound eluted high up-lane (pos ~ 460), zero origin dots left
      return Array.from({ length: L }, (_, i) => {
        const dark = 130 * Math.exp(-(((i - 460) / 14) ** 2));
        return Math.max(10, 238 - dark + rand() * 0.8);
      });
    };

    const o0 = tlcOrigin(set, cfg.lanes[0], getProfile as any);
    const o12 = tlcOrigin(set, cfg.lanes[12], getProfile as any);
    expect(Math.abs(o0 - (preBase + jitter(0)))).toBeLessThanOrEqual(2.5);
    expect(Math.abs(o12 - (preBase + jitter(12)))).toBeLessThanOrEqual(2.5);
    expect(set.preRunAlignment?.[0]?.mode).toBe('direct-box');
    expect(set.preRunAlignment?.[0]?.matchedAnchors).toBe(0);
  });

  it('round-trips per-plate pre-run storage keys without colliding with developed image keys', () => {
    const k0Dev = tlcStorageKey('UV254', 0);
    const k0Pre = tlcPreRunStorageKey('UV254', 0);
    const k2Dev = tlcStorageKey('UV366', 2);
    const k2Pre = tlcPreRunStorageKey('UV366', 2);

    expect(k0Dev).not.toBe(k0Pre);
    expect(k2Dev).not.toBe(k2Pre);

    expect(parseTlcStorageKey(k0Dev)).toEqual({ plateIndex: 0, channel: 'UV254', isPreRun: false });
    expect(parseTlcStorageKey(k0Pre)).toEqual({ plateIndex: 0, channel: 'UV254', isPreRun: true });
    expect(parseTlcStorageKey(k2Dev)).toEqual({ plateIndex: 2, channel: 'UV366', isPreRun: false });
    expect(parseTlcStorageKey(k2Pre)).toEqual({ plateIndex: 2, channel: 'UV366', isPreRun: true });
  });
});





