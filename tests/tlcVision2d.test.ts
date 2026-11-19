import { describe, it, expect } from 'vitest';
import {
  analyzeLaneStripRgb,
  applyFlatFieldCorrection,
  detectCurvedFrontSeam,
  detectGlassTopEdge,
  findSimilarSpotsByColor,
  isProfileOnPlate,
  rescueSharedReagentSpots,
} from '../src/engine/tlcVision2d';
import {
  createDefaultLaneConfig,
  detectChannelOrigin,
  findSpots,
  tlcFront,
  tlcOrigin,
} from '../src/engine/tlcLanes';
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
});

