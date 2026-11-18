import { describe, it, expect } from 'vitest';
import {
  analyzeProfileHistogram,
  detectFrontDetailed,
  detectChannelOrigin,
  findSpots,
  gutterLanes,
  tlcFront,
  tlcOrigin,
  createDefaultLaneConfig,
  mergeMultiChannelSpots,
} from '../src/engine/tlcLanes';
import type { TlcSet, TlcLane } from '../src/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

describe('front: pencil line vs real front', () => {
  const N = 500;
  const make = (pencilAmp: number, frontRidge: number) => {
    const r = rng(7);
    const front = 440;
    const pencil = 350;
    return Array.from({ length: N }, (_, i) => {
      let v = i < front ? 100 : 109; // wet silica darker, dry silica brighter (UV254)
      if (Math.abs(i - front) <= 1) v -= frontRidge;
      if (Math.abs(i - pencil) <= 1) v -= pencilAmp;
      return v + r() * 1.5;
    });
  };

  it('prefers the line with a wet/dry step over a slightly stronger ridge-only pencil line', () => {
    const res = detectFrontDetailed(make(26, 20), -1);
    expect(res.pos).toBeGreaterThan(0);
    expect(Math.abs(res.pos - 440)).toBeLessThanOrEqual(3);
  });

  it('still finds a ridge-only front when there is no pencil line', () => {
    const r = rng(3);
    const prof = Array.from({ length: N }, (_, i) => 100 + (Math.abs(i - 440) <= 1 ? -20 : 0) + r() * 1.5);
    expect(Math.abs(detectFrontDetailed(prof, -1).pos - 440)).toBeLessThanOrEqual(3);
  });
});

describe('origin: faint dots', () => {
  it('finds a consistent faint origin row across lanes', () => {
    const r = rng(11);
    const entries = Array.from({ length: 27 }, (_, li) => {
      const centre = 90 + Math.round(Math.sin(li / 4) * 2);
      const profile = Array.from({ length: 600 }, (_, i) => {
        const d = (i - centre) / 6;
        return 200 - 3.2 * Math.exp(-d * d) + r() * 1.4;
      });
      return { laneId: li, profile };
    });
    const res = detectChannelOrigin(entries, -1, 600);
    expect(res.pos).toBeGreaterThan(10);
    expect(Math.abs(res.pos - 90)).toBeLessThanOrEqual(6);
  });

  it('does not invent an origin from pure noise', () => {
    const r = rng(5);
    const entries = Array.from({ length: 27 }, (_, li) => ({
      laneId: li,
      profile: Array.from({ length: 600 }, () => 200 + r() * 2.4),
    }));
    expect(detectChannelOrigin(entries, -1, 600).pos).toBeLessThanOrEqual(10);
  });
});

describe('gutter lanes', () => {
  it('sits half way between neighbouring lanes and gets distinct ids', () => {
    const lanes = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      x0: 100 + i * 80,
      y0: 900,
      length: 700,
      width: 70,
      angle: 0,
    }));
    const g = gutterLanes(lanes);
    expect(g).toHaveLength(4);
    expect(g[0].x0).toBeCloseTo(140);
    expect(g[0].id).toBe(1000);
    expect(g[0].width).toBeLessThan(lanes[0].width);
  });
});

describe('histogram calibration (Merck TLC Explorer uniform lighting)', () => {
  it('extracts clean silica mode and quiet-side sigma without spot contamination', () => {
    const r = rng(21);
    // Low-exposure UV366 profile: quiet background near 18 ± 0.4 with two bright spots (+95 and +70)
    const profiles = Array.from({ length: 12 }, () =>
      Array.from({ length: 500 }, (_, i) => {
        const d1 = (i - 180) / 10;
        const d2 = (i - 310) / 12;
        const s1 = 95 * Math.exp(-d1 * d1);
        const s2 = 70 * Math.exp(-d2 * d2);
        return 18 + s1 + s2 + r() * 0.8;
      })
    );
    const hist = analyzeProfileHistogram(profiles, +1, 0.06, 0.94);
    expect(Math.abs(hist.bgMode - 18)).toBeLessThanOrEqual(1);
    // Quiet-side sigma must stay tight despite +95 spots inflating overall variance
    expect(hist.bgSigma).toBeLessThanOrEqual(1.2);
    expect(hist.contrastSpan).toBeGreaterThan(25);
    expect(hist.clipLowFrac).toBe(0);
    expect(hist.clipHighFrac).toBe(0);
  });

  it('detects bimodal wet-vs-dry Otsu separability and recovers a ridgeless solvent front', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const r = rng(42);
    const frontPos = 860; // ~88% of 980px lane
    const set: TlcSet = {
      id: 's1',
      name: 'bimodal',
      imgs: { UV254: { name: 'uv254.png', url: '', bmp: {} as any } },
      cfg,
    };
    const getProfile = (_s: TlcSet, _key: string, lane: TlcLane) =>
      Array.from({ length: lane.length }, (_, i) => {
        // Pure step from wet silica (~160) to dry silica (~186) with no sharp meniscus ridge
        const base = i < frontPos ? 160 : 186;
        return base + r() * 1.4;
      });

    const upperProfiles = cfg.lanes.slice(0, 27).map((l) => getProfile(set, 'UV254', l));
    const upperHist = analyzeProfileHistogram(upperProfiles, -1, 0.5, 0.95);
    expect(upperHist.otsuEta).toBeGreaterThanOrEqual(0.62);

    const detected = tlcFront(set, cfg.lanes[0], getProfile as any);
    expect(Math.abs(detected - frontPos)).toBeLessThanOrEqual(8);
  });

  it('detects faint meniscus front and faint origin deposits on low-exposure quiet UV366 plates', () => {
    const r = rng(101);
    const prof = Array.from({ length: 600 }, (_, i) => {
      const wetDry = i <= 530 ? 0 : -1.5; // UV366 dry region slightly darker
      const ridge = Math.abs(i - 530) <= 1 ? 4.5 : 0; // below legacy hardcoded 5.0 floor
      return 18 + wetDry + ridge + r() * 0.5;
    });
    const frontRes = detectFrontDetailed(prof, +1);
    expect(frontRes.pos).toBeGreaterThan(0);
    expect(Math.abs(frontRes.pos - 530)).toBeLessThanOrEqual(4);

    // Faint origin deposits (+8 units above bg=18 with ±0.4 noise)
    const r2 = rng(102);
    const entries = Array.from({ length: 27 }, (_, li) => {
      const centre = 72 + Math.round(Math.cos(li / 5) * 2);
      return {
        laneId: li,
        profile: Array.from({ length: 600 }, (_, i) => {
          const d = (i - centre) / 5;
          return 18 + 8 * Math.exp(-d * d) + r2() * 0.7;
        }),
      };
    });
    const originRes = detectChannelOrigin(entries, +1, 600);
    expect(originRes.pos).toBeGreaterThan(10);
    expect(Math.abs(originRes.pos - 72)).toBeLessThanOrEqual(5);
  });

  it('avoids a heavily clipped channel in tlcOrigin when a clean unclipped channel shows the origin', () => {
    const cfg = createDefaultLaneConfig(3280, 'two-tier');
    cfg.lanes.forEach((l) => {
      l.zeroRf = null;
    });
    const r = rng(77);
    const set: TlcSet = {
      id: 's-clip',
      name: 'clipped-test',
      imgs: {
        UV254: { name: 'uv254.png', url: '', bmp: {} as any },
        UV366: { name: 'uv366.png', url: '', bmp: {} as any },
      },
      cfg,
    };
    // UV254 is overexposed (>30% pixels clipped at 255) with a false origin artifact at 135;
    // UV366 is cleanly exposed with the true origin at 98.
    const getProfile = (_s: TlcSet, key: string, lane: TlcLane) => {
      if (key === 'UV254') {
        return Array.from({ length: lane.length }, (_, i) => {
          if (i > 500) return 255;
          const d = (i - 135) / 5;
          return 235 - 50 * Math.exp(-d * d) + r() * 1.2;
        });
      }
      return Array.from({ length: lane.length }, (_, i) => {
        const d = (i - 98) / 5;
        return 22 + 45 * Math.exp(-d * d) + r() * 0.8;
      });
    };

    const resolvedOrigin = tlcOrigin(set, cfg.lanes[0], getProfile as any);
    expect(Math.abs(resolvedOrigin - 98)).toBeLessThanOrEqual(6);
  });

  it('resolves faint spot peaks on clean UV366 profiles while rejecting noisy blank lanes', () => {
    const r = rng(55);
    const spotPos = 280;
    const quietProf = Array.from({ length: 600 }, (_, i) => {
      const d = (i - spotPos) / 7;
      const peak = 4.2 * Math.exp(-d * d);
      return 18 + peak + r() * 0.4;
    });
    const histQuiet = analyzeProfileHistogram([quietProf], +1, 0.06, 0.94);
    const spots = findSpots(quietProf, {
      sign: +1,
      origin: 70,
      front: 530,
      radius: 18,
      minProminence: 0.25,
      plateHistogram: histQuiet,
    });
    expect(spots.some((sp) => Math.abs(sp.pos - spotPos) <= 6)).toBe(true);

    // Noisy blank lane (±3.2 noise) should still yield zero false spot peaks
    const rNoise = rng(56);
    const noisyBlank = Array.from({ length: 600 }, () => 140 + rNoise() * 6.4);
    const histNoisy = analyzeProfileHistogram([noisyBlank], -1, 0.06, 0.94);
    const blankSpots = findSpots(noisyBlank, {
      sign: -1,
      origin: 70,
      front: 530,
      radius: 18,
      minProminence: 0.28,
      plateHistogram: histNoisy,
    });
    expect(blankSpots).toHaveLength(0);
  });

  it('resolves separated overlapping bands (~18% dip) on busy multi-spot lanes at Standard sensitivity', () => {
    const r = rng(88);
    const origin = 80;
    const front = 780; // span = 700
    const sq = (x: number) => x * x;
    const busyProf = Array.from({ length: 860 }, (_, i) => {
      const originSpot = Math.min(165, 190 * Math.exp(-sq((i - 98) / 22)));
      const r08 = 75 * Math.exp(-sq((i - 138) / 10));
      const r29 = 88 * Math.exp(-sq((i - 278) / 22));
      const r37 = 145 * Math.exp(-sq((i - 333) / 24));
      return Math.max(15, 210 - Math.max(originSpot, r08) - r29 - r37 + r() * 1.2);
    });
    const hist = analyzeProfileHistogram([busyProf], -1, 0.06, 0.94);
    const spots = findSpots(busyProf, {
      sign: -1,
      origin,
      front,
      radius: 24,
      minProminence: 0.28,
      plateHistogram: hist,
    });
    expect(spots.some((sp) => Math.abs(sp.rf - 0.083) <= 0.02)).toBe(true);
    expect(spots.some((sp) => Math.abs(sp.rf - 0.283) <= 0.02)).toBe(true);
    expect(spots.some((sp) => Math.abs(sp.rf - 0.361) <= 0.02)).toBe(true);
  });

  it('preserves near-origin spots separated from origin deposit by a moderate valley and keeps same-channel doublet spots distinct in composite', () => {
    const origin = 60;
    const front = 560; // span = 500
    const sq = (x: number) => x * x;
    // Origin deposit at Rf=0.00 and distinct compound at Rf=0.046 (valley dips ~25%)
    const prof = Array.from({ length: 620 }, (_, i) => {
      const originPeak = 135 * Math.exp(-sq((i - 60) / 8));
      const nearSpot = 95 * Math.exp(-sq((i - 83) / 7));
      return Math.max(10, 210 - originPeak - nearSpot);
    });
    const hist = analyzeProfileHistogram([prof], -1, 0.06, 0.94);
    const spots = findSpots(prof, {
      sign: -1,
      origin,
      front,
      radius: 16,
      minProminence: 0.28,
      plateHistogram: hist,
    });
    expect(spots.some((sp) => Math.abs(sp.rf - 0.046) <= 0.015)).toBe(true);

    // Composite merge should never collapse two already-resolved UV366 spots into one UV254 peak
    const composite = mergeMultiChannelSpots({
      UV254: [{ pos: 240, rf: 0.36, strength: 1.0, source: 'auto' }],
      UV366: [
        { pos: 230, rf: 0.34, strength: 0.85, source: 'auto' },
        { pos: 250, rf: 0.38, strength: 0.95, source: 'auto' },
      ],
    });
    expect(composite.filter((s) => s.rf >= 0.32 && s.rf <= 0.40)).toHaveLength(2);
  });
});


