import { describe, it, expect } from 'vitest';
import {
  analyzeLaneStripRgb,
  buildLaneSpotMap2d,
  computeArplsBaseline,
  extractDensitogram,
  findMultiChannelSpots,
  findSpots,
  rgbLabDeltaE,
  segmentLaneSpots2d,
} from '../src/engine';
import { getSpotConfidenceStyle } from '../src/utils/spotConfidence';

type RgbaRect = {
  rgba: Uint8ClampedArray;
  width: number;
  length: number;
};

/**
 * Helper to synthesize a lane RGB strip (image coordinates: y = 0 is top/front, y = length-1 is bottom/origin).
 * Helper functions accept `pos` in chromatographic coordinates (0 = bottom/origin, length-1 = top/front).
 */
function makeLaneStrip(
  width: number,
  length: number,
  bgRgb: [number, number, number],
  slopeRgb: [number, number, number] = [0, 0, 0]
): RgbaRect {
  const rgba = new Uint8ClampedArray(width * length * 4);
  for (let pos = 0; pos < length; pos++) {
    const y = length - 1 - pos;
    const t = pos / Math.max(1, length - 1);
    const r = Math.max(0, Math.min(255, Math.round(bgRgb[0] + slopeRgb[0] * t)));
    const g = Math.max(0, Math.min(255, Math.round(bgRgb[1] + slopeRgb[1] * t)));
    const b = Math.max(0, Math.min(255, Math.round(bgRgb[2] + slopeRgb[2] * t)));
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  return { rgba, width, length };
}

/** Paints an elliptical Gaussian spot in chromatographic coordinates (pos from bottom, cxFrac in [0, 1]). */
function paintSpot(
  strip: RgbaRect,
  opts: {
    pos: number;
    cxFrac?: number;
    sigmaY: number;
    sigmaXFrac: number;
    deltaRgb: [number, number, number];
    power?: number; // > 2 creates a flat-topped saturated oval
  }
) {
  const { width, length, rgba } = strip;
  const cx = (opts.cxFrac ?? 0.5) * (width - 1);
  const sigmaX = Math.max(1.2, opts.sigmaXFrac * width);
  const pow = opts.power ?? 2;

  for (let pos = 0; pos < length; pos++) {
    const dy = (pos - opts.pos) / Math.max(1, opts.sigmaY);
    if (Math.abs(dy) > 4.2) continue;
    const y = length - 1 - pos;
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / sigmaX;
      if (Math.abs(dx) > 4.2) continue;
      const r2 = dx * dx + dy * dy;
      const w = Math.exp(-0.5 * Math.pow(r2, pow / 2));
      if (w < 1e-3) continue;
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(rgba[idx] + opts.deltaRgb[0] * w)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgba[idx + 1] + opts.deltaRgb[1] * w)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgba[idx + 2] + opts.deltaRgb[2] * w)));
    }
  }
}

/** Paints a full-width horizontal band (e.g., glowing UV366 solvent-front band) across the entire strip width. */
function paintHorizontalBand(
  strip: RgbaRect,
  posCenter: number,
  sigmaY: number,
  deltaRgb: [number, number, number]
) {
  const { width, length, rgba } = strip;
  for (let pos = 0; pos < length; pos++) {
    const dy = (pos - posCenter) / Math.max(1, sigmaY);
    if (Math.abs(dy) > 4) continue;
    const w = Math.exp(-0.5 * dy * dy);
    const y = length - 1 - pos;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(rgba[idx] + deltaRgb[0] * w)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgba[idx + 1] + deltaRgb[1] * w)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgba[idx + 2] + deltaRgb[2] * w)));
    }
  }
}

/** Extracts a 1D center-weighted profile matching TLC_SIGNAL channel convention. */
function extractSimple1dProfile(
  strip: RgbaRect,
  channel: 'UV254' | 'UV366' | 'White'
): number[] {
  const { width, length, rgba } = strip;
  const out = new Array<number>(length);
  const x0 = Math.floor(width * 0.32);
  const x1 = Math.max(x0 + 1, Math.ceil(width * 0.68));
  for (let pos = 0; pos < length; pos++) {
    const y = length - 1 - pos;
    let sum = 0;
    let n = 0;
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const v =
        channel === 'UV254'
          ? g
          : channel === 'UV366'
          ? 0.299 * r + 0.587 * g + 0.114 * b
          : 0.299 * r + 0.587 * g + 0.114 * b;
      sum += v;
      n++;
    }
    out[pos] = sum / Math.max(1, n);
  }
  return out;
}

describe('Step 3: arPLS Baseline, Channel-Calibrated 2D Maps & Watershed Spot Segmentation', () => {
  it('computeArplsBaseline tracks sloped silica cleanly even on a crowded lane with broad spots', () => {
    const N = 400;
    const origin = 50;
    const front = 350;
    const trueBg = new Array<number>(N);
    const profile = new Array<number>(N);

    for (let i = 0; i < N; i++) {
      // Smooth illumination drift from 175 -> 195 across the lane
      const bg = 175 + 20 * (i / (N - 1));
      trueBg[i] = bg;
      // Add 3 broad dark spots covering >45% of the chromatographic span
      const s1 = 90 * Math.exp(-0.5 * Math.pow((i - 120) / 22, 2));
      const s2 = 105 * Math.exp(-0.5 * Math.pow((i - 205) / 26, 2));
      const s3 = 85 * Math.exp(-0.5 * Math.pow((i - 285) / 20, 2));
      profile[i] = bg - s1 - s2 - s3;
    }

    const base = computeArplsBaseline(profile, -1, origin, front);
    expect(base.length).toBe(N);

    // At the apex of the broadest central spot (i = 205), the arPLS baseline must stay close to true silica (~185),
    // NOT dip down into the dark spot (profile[205] ≈ 80).
    expect(Math.abs(base[205] - trueBg[205])).toBeLessThan(8);
    expect(Math.abs(base[120] - trueBg[120])).toBeLessThan(8);
    expect(Math.abs(base[285] - trueBg[285])).toBeLessThan(8);
  });

  it('extractDensitogram and findSpots share the exact same arPLS baseline and spot positions', () => {
    const strip = makeLaneStrip(32, 360, [10, 185, 12], [0, 14, 0]);
    paintSpot(strip, { pos: 140, sigmaY: 10, sigmaXFrac: 0.22, deltaRgb: [0, -110, 0] });
    paintSpot(strip, { pos: 245, sigmaY: 12, sigmaXFrac: 0.24, deltaRgb: [0, -95, 0] });

    const prof = extractSimple1dProfile(strip, 'UV254');
    const lane2d = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35).metrics;
    const origin = 45;
    const front = 315;

    const spots = findSpots(prof, { sign: -1, origin, front, lane2d });
    const dens = extractDensitogram(prof, { sign: -1, origin, front, lane2d });
    const arpls = computeArplsBaseline(prof, -1, origin, front);

    expect(spots.length).toBe(2);
    expect(dens.spots.length).toBe(2);
    expect(dens.spots[0].pos).toBe(spots[0].pos);
    expect(dens.spots[1].pos).toBe(spots[1].pos);
    expect(dens.spots[0].areaPct).toBe(spots[0].areaPct);
    // Densitogram baseline point at every chromatographic position matches arPLS exactly
    expect(Math.abs(dens.points[140].baseline - arpls[140])).toBeLessThan(0.05);
    expect(Math.abs(dens.points[245].baseline - arpls[245])).toBeLessThan(0.05);
  });

  it('White channel CIELAB ΔE detects a faint colored stain even when grayscale luminance drop is tiny', () => {
    // Pale cream/white silica (235, 235, 232) vs pale yellow-pink stain (245, 234, 188)
    // Grayscale luminance difference is only ~2.6 units, yet perceptual CIELAB ΔE is > 20!
    const dE = rgbLabDeltaE(245, 234, 188, 235, 235, 232);
    expect(dE).toBeGreaterThan(18);

    const strip = makeLaneStrip(32, 360, [235, 235, 232]);
    paintSpot(strip, {
      pos: 195,
      sigmaY: 10,
      sigmaXFrac: 0.22,
      deltaRgb: [10, -1, -44],
    });
    const spotMap = buildLaneSpotMap2d(strip.rgba, strip.width, strip.length, 'White');
    const spots = segmentLaneSpots2d(spotMap, { origin: 45, front: 315, minProminence: 0.28 });

    expect(spots.length).toBe(1);
    expect(spots[0].detector).toBe('2d');
    expect(Math.abs(spots[0].pos - 195)).toBeLessThanOrEqual(4);
  });

  it('keeps a broad saturated oval spot as 1 spot and integrates its real >35px extent without ±15px capping', () => {
    const strip = makeLaneStrip(36, 400, [8, 190, 10]);
    // Very broad flat-topped saturated oval (sigmaY = 24, power = 4 -> ~55 px vertical extent)
    paintSpot(strip, {
      pos: 170,
      sigmaY: 24,
      sigmaXFrac: 0.28,
      deltaRgb: [0, -155, 0],
      power: 4,
    });
    // Compact narrow spot of similar peak depth (sigmaY = 5 -> ~14 px vertical extent)
    paintSpot(strip, {
      pos: 290,
      sigmaY: 5,
      sigmaXFrac: 0.18,
      deltaRgb: [0, -140, 0],
      power: 2,
    });

    const lane2d = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35).metrics;
    const prof = extractSimple1dProfile(strip, 'UV254');
    const spots = findSpots(prof, { sign: -1, origin: 45, front: 355, lane2d });

    expect(spots.length).toBe(2);
    const broad = spots[0];
    const narrow = spots[1];
    expect(Math.abs(broad.pos - 170)).toBeLessThanOrEqual(5);
    expect(Math.abs(narrow.pos - 290)).toBeLessThanOrEqual(4);

    // Broad oval MUST have real segmented vertical span well beyond the old 30 px (±15) cap
    const broadSpan = (broad.extentEnd ?? 0) - (broad.extentStart ?? 0);
    expect(broadSpan).toBeGreaterThan(36);
    // And because areaPct uses real 2D segmented mass (not ±15 px), broad oval dominates total area
    expect(broad.areaPct ?? 0).toBeGreaterThan(68);
    expect((broad.areaPct ?? 0) + (narrow.areaPct ?? 0)).toBe(100);
  });

  it('splits a touching vertical figure-8 doublet into 2 distinct watershed regions with clean boundaries', () => {
    const strip = makeLaneStrip(36, 400, [8, 192, 10]);
    // Two touching circular spots 24 px apart (radius ~11 px -> overlapping saddle + hourglass waist)
    paintSpot(strip, { pos: 185, sigmaY: 8.5, sigmaXFrac: 0.24, deltaRgb: [0, -135, 0] });
    paintSpot(strip, { pos: 212, sigmaY: 8.5, sigmaXFrac: 0.24, deltaRgb: [0, -125, 0] });

    const lane2d = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35).metrics;
    const prof = extractSimple1dProfile(strip, 'UV254');
    const spots = findSpots(prof, { sign: -1, origin: 45, front: 355, minProminence: 0.22, lane2d });

    expect(spots.length).toBe(2);
    expect(Math.abs(spots[0].pos - 185)).toBeLessThanOrEqual(4);
    expect(Math.abs(spots[1].pos - 212)).toBeLessThanOrEqual(4);
    expect(spots[0].extentEnd!).toBeLessThanOrEqual(spots[1].extentStart! + 2);
  });

  it('rejects neighbor-lane border spillover via horizontal centroid while preserving centered spots', () => {
    const strip = makeLaneStrip(36, 400, [8, 192, 10]);
    // Real spot centered in this lane
    paintSpot(strip, { pos: 180, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -125, 0] });
    // Strong neighbor spot spilling in from the right edge (centered outside right lane border)
    paintSpot(strip, { pos: 265, cxFrac: 1.06, sigmaY: 11, sigmaXFrac: 0.22, deltaRgb: [0, -150, 0] });

    const lane2d = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35).metrics;
    const prof = extractSimple1dProfile(strip, 'UV254');
    const spots = findSpots(prof, { sign: -1, origin: 45, front: 355, lane2d });

    expect(spots.length).toBe(1);
    expect(Math.abs(spots[0].pos - 180)).toBeLessThanOrEqual(4);
  });

  it('suppresses a glowing UV366 solvent-front band at Rf 0.96 while preserving a real high-Rf spot at Rf 0.85', () => {
    const strip = makeLaneStrip(36, 400, [5, 22, 14]);
    const origin = 45;
    const front = 355;
    const span = front - origin; // 310

    // Full-width glowing blue solvent-front impurity band at Rf 0.96 (like UJG-C0022 UV366)
    paintHorizontalBand(strip, origin + Math.round(0.96 * span), 7, [15, 65, 175]);
    // Real localized fluorescent compound spot at Rf 0.84
    paintSpot(strip, {
      pos: origin + Math.round(0.84 * span),
      cxFrac: 0.5,
      sigmaY: 8,
      sigmaXFrac: 0.22,
      deltaRgb: [20, 85, 165],
    });

    const lane2d = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV366', 0.35).metrics;
    const prof = extractSimple1dProfile(strip, 'UV366');
    const spots = findSpots(prof, { sign: 1, origin, front, lane2d });

    expect(spots.length).toBe(1);
    expect(spots[0].rf).toBeGreaterThan(0.80);
    expect(spots[0].rf).toBeLessThan(0.89);
  });

  it('rejects an elongated origin-teardrop comet shoulder at Rf 0.07 while keeping a resolved low-Rf product', () => {
    const origin = 50;
    const front = 350;
    const span = front - origin;

    // Case A: Heavily overloaded origin dot with continuous teardrop tail to Rf 0.07 (no clear valley)
    const cometStrip = makeLaneStrip(36, 400, [8, 192, 10]);
    paintSpot(cometStrip, { pos: origin, sigmaY: 11, sigmaXFrac: 0.24, deltaRgb: [0, -165, 0] });
    paintSpot(cometStrip, { pos: origin + Math.round(0.07 * span), sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -110, 0] });
    paintSpot(cometStrip, { pos: origin + Math.round(0.55 * span), sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -120, 0] });

    const comet2d = analyzeLaneStripRgb(cometStrip.rgba, cometStrip.width, cometStrip.length, 'UV254', 0.35).metrics;
    const cometSpots = findSpots(extractSimple1dProfile(cometStrip, 'UV254'), {
      sign: -1,
      origin,
      front,
      lane2d: comet2d,
    });
    expect(cometSpots.length).toBe(1);
    expect(Math.abs(cometSpots[0].rf - 0.55)).toBeLessThan(0.03);

    // Case B: Distinct low-Rf product at Rf 0.14 separated by a clean silica valley from a compact origin dot
    const cleanStrip = makeLaneStrip(36, 400, [8, 192, 10]);
    paintSpot(cleanStrip, { pos: origin, sigmaY: 6, sigmaXFrac: 0.22, deltaRgb: [0, -150, 0] });
    paintSpot(cleanStrip, { pos: origin + Math.round(0.14 * span), sigmaY: 7, sigmaXFrac: 0.22, deltaRgb: [0, -125, 0] });

    const clean2d = analyzeLaneStripRgb(cleanStrip.rgba, cleanStrip.width, cleanStrip.length, 'UV254', 0.35).metrics;
    const cleanSpots = findSpots(extractSimple1dProfile(cleanStrip, 'UV254'), {
      sign: -1,
      origin,
      front,
      lane2d: clean2d,
    });
    expect(cleanSpots.length).toBe(1);
    expect(Math.abs(cleanSpots[0].rf - 0.14)).toBeLessThan(0.03);
  });

  it('boosts confidence on multi-channel agreement and supports legacy 1D fallback via detectorMode', () => {
    const origin = 45;
    const front = 355;
    const spotPos = 215;

    const uv254 = makeLaneStrip(32, 400, [8, 190, 10]);
    paintSpot(uv254, { pos: spotPos, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -52, 0] });

    const uv366 = makeLaneStrip(32, 400, [6, 20, 14]);
    paintSpot(uv366, { pos: spotPos + 1, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [15, 55, 95] });

    const m254 = analyzeLaneStripRgb(uv254.rgba, uv254.width, uv254.length, 'UV254', 0.35).metrics;
    const m366 = analyzeLaneStripRgb(uv366.rgba, uv366.width, uv366.length, 'UV366', 0.35).metrics;
    const p254 = extractSimple1dProfile(uv254, 'UV254');
    const p366 = extractSimple1dProfile(uv366, 'UV366');

    const solo254 = findSpots(p254, { sign: -1, origin, front, lane2d: m254 });
    const solo366 = findSpots(p366, { sign: 1, origin, front, lane2d: m366 });
    const merged = findMultiChannelSpots({
      profiles: { UV254: p254, UV366: p366 },
      origin,
      front,
      lane2dByChannel: { UV254: m254, UV366: m366 },
    });

    expect(solo254.length).toBe(1);
    expect(solo366.length).toBe(1);
    expect(merged.length).toBe(1);
    expect(merged[0].channels).toEqual(expect.arrayContaining(['UV254', 'UV366']));
    expect(merged[0].confidence!).toBeGreaterThan(solo254[0].confidence!);
    expect(merged[0].confidence!).toBeGreaterThan(solo366[0].confidence!);
    expect(merged[0].detector).toBe('2d');

    // Legacy 1D fallback toggle must explicitly run the 1D detector
    const legacy = findSpots(p254, { sign: -1, origin, front, lane2d: m254, detectorMode: '1d' });
    expect(legacy.length).toBe(1);
    expect(legacy[0].detector).toBe('1d');
    expect(Math.abs(legacy[0].pos - spotPos)).toBeLessThanOrEqual(4);
  });

  it('detects faint UV254 spots in brighter plate zones even when plateHistogram has high 20cm vignette bgSigma (~9.5)', () => {
    // Reproduces real Merck TLC Explorer plate illumination shading:
    // - Lane background brightens from G=178 (origin) to G=206 (upper-middle)
    // - Plate-wide histogram bgSigma is ~9.5 due to 20 cm vignette across 54 lanes
    // - Lane contains one pitch-black strong spot (gDrop=145) AND two faint spots (gDrop=14 and gDrop=18)
    //   sitting in the brighter zone (G > lane-median bgG!)
    const strip = makeLaneStrip(32, 400, [8, 178, 10], [0, 28, 0]);
    paintSpot(strip, { pos: 115, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -145, 0] });
    paintSpot(strip, { pos: 215, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -16, 0] });
    paintSpot(strip, { pos: 285, sigmaY: 10, sigmaXFrac: 0.24, deltaRgb: [0, -20, 0] });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const vignetteHist = {
      bgMode: 182,
      bgSigma: 9.5,
      contrastSpan: 150,
      sigTail: 46,
      clipLowFrac: 0,
      clipHighFrac: 0,
      otsuThresh: 124,
      otsuEta: 0.72,
      sampleCount: 15000,
    };

    const spots = findSpots(profile, {
      sign: -1,
      origin: 45,
      front: 355,
      minProminence: 0.28,
      plateHistogram: vignetteHist,
      lane2d: metrics,
    });

    expect(spots.length).toBe(3);
    expect(Math.abs(spots[0].pos - 115)).toBeLessThanOrEqual(4);
    expect(Math.abs(spots[1].pos - 215)).toBeLessThanOrEqual(5);
    expect(Math.abs(spots[2].pos - 285)).toBeLessThanOrEqual(5);

    // Meanwhile, a blank silica lane with gentle camera grain (±2 counts) stays clean (0 false spots)
    const blank = makeLaneStrip(32, 400, [8, 182, 10], [0, 18, 0]);
    for (let i = 0; i < blank.rgba.length; i += 4) {
      const jitter = ((i * 73) % 5) - 2; // deterministic ±2 camera grain
      blank.rgba[i + 1] = Math.max(0, Math.min(255, blank.rgba[i + 1] + jitter));
    }
    const blankRes = analyzeLaneStripRgb(blank.rgba, blank.width, blank.length, 'UV254', 0.35);
    const blankSpots = findSpots(blankRes.profile, {
      sign: -1,
      origin: 45,
      front: 355,
      minProminence: 0.28,
      plateHistogram: vignetteHist,
      lane2d: blankRes.metrics,
    });
    expect(blankSpots.length).toBe(0);
  });

  it('consistently rejects dark origin-teardrop streaks with 5-18% neck ripples while keeping truly separated low-Rf spots', () => {
    const origin = 50;
    const front = 410;
    const span = front - origin;

    // 3 nearly identical dark elongated origin teardrops with subtle 5%, 12%, and 18% intensity ripples
    // (reproduces real HTE origin streaks where one lane previously fired inconsistently while adjacent lanes did not)
    for (const bellyBoost of [0, 12, 22]) {
      const strip = makeLaneStrip(34, 460, [8, 192, 10]);
      // Continuous dark teardrop from origin (pos=50) down to Rf 0.08 (pos=79)
      for (let pos = origin - 6; pos <= origin + 36; pos++) {
        const y = strip.length - 1 - pos;
        const rf = (pos - origin) / span;
        // Origin core at rf=0, slight neck at rf=0.025, dark belly at rf=0.055 (still >78% dark in neck!)
        const envelope =
          rf < 0
            ? Math.exp(-0.5 * Math.pow(rf / 0.015, 2))
            : rf <= 0.07
            ? 1 - (bellyBoost / 150) * Math.exp(-0.5 * Math.pow((rf - 0.028) / 0.012, 2))
            : Math.exp(-0.5 * Math.pow((rf - 0.07) / 0.015, 2));
        const depth = Math.min(155, 145 * envelope);
        for (let x = 0; x < strip.width; x++) {
          const dx = (x - (strip.width - 1) / 2) / (strip.width * 0.24);
          const w = Math.exp(-0.5 * dx * dx);
          const idx = (y * strip.width + x) * 4;
          strip.rgba[idx + 1] = Math.max(12, Math.round(192 - depth * w));
        }
      }
      // Plus one real product spot at Rf 0.65
      paintSpot(strip, { pos: origin + Math.round(0.65 * span), sigmaY: 10, sigmaXFrac: 0.22, deltaRgb: [0, -110, 0] });

      const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
      const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });
      expect(spots.filter((s) => s.rf < 0.14).length).toBe(0);
      expect(spots.length).toBe(1);
      expect(Math.abs(spots[0].rf - 0.65)).toBeLessThan(0.03);
    }

    // Contrast: genuinely separated low-Rf spot at Rf 0.08 with a real bright-silica valley (>50% drop) -> MUST detect
    const resolved = makeLaneStrip(34, 460, [8, 192, 10]);
    paintSpot(resolved, { pos: origin, sigmaY: 5, sigmaXFrac: 0.22, deltaRgb: [0, -155, 0] });
    paintSpot(resolved, { pos: origin + Math.round(0.08 * span), sigmaY: 6.5, sigmaXFrac: 0.22, deltaRgb: [0, -135, 0] });
    const res2d = analyzeLaneStripRgb(resolved.rgba, resolved.width, resolved.length, 'UV254', 0.35);
    const resSpots = findSpots(res2d.profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: res2d.metrics });
    expect(resSpots.length).toBe(1);
    expect(Math.abs(resSpots[0].rf - 0.08)).toBeLessThan(0.025);
  });

  it('recovers faint shared-Rf interior HTE spots flanked by neighbor wings while still rejecting flat horizontal bands', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const spotPos = origin + Math.round(0.72 * span);
    const flatBandPos = origin + Math.round(0.42 * span);

    const strip = makeLaneStrip(34, 420, [8, 190, 10]);
    // Faint/medium shared-Rf compound at Rf 0.72 spanning adjacent HTE lanes (true 1-pitch spacing at cx=-0.5, 0.5, 1.5
    // with wide sigmaXFrac=0.38 -> center drop ~36, both flanks darkened to ~28.5, local excess ~7.5 matching real HTE plates)
    paintSpot(strip, { pos: spotPos, cxFrac: 0.5, sigmaY: 10, sigmaXFrac: 0.38, deltaRgb: [0, -34, 0] });
    paintSpot(strip, { pos: spotPos, cxFrac: -0.5, sigmaY: 10, sigmaXFrac: 0.38, deltaRgb: [0, -34, 0] });
    paintSpot(strip, { pos: spotPos, cxFrac: 1.5, sigmaY: 10, sigmaXFrac: 0.38, deltaRgb: [0, -34, 0] });
    // Flat full-width horizontal artifact band at Rf 0.42 (zero center-vs-flank peaking -> must be rejected)
    paintHorizontalBand(strip, flatBandPos, 9, [0, -30, 0]);
    // Add realistic ±2 camera grain
    for (let i = 0; i < strip.rgba.length; i += 4) {
      const jitter = ((i * 37) % 5) - 2;
      strip.rgba[i + 1] = Math.max(0, Math.min(255, strip.rgba[i + 1] + jitter));
    }

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });

    expect(spots.some((s) => Math.abs(s.pos - spotPos) <= 6)).toBe(true);
    expect(spots.some((s) => Math.abs(s.pos - flatBandPos) <= 10)).toBe(false);
  });

  it('rejects sharp non-diffused dust / pinhole / splash-droplet specks while preserving real diffused TLC spots', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const pinholePos = origin + Math.round(0.32 * span);
    const splashPos = origin + Math.round(0.54 * span);
    const realSpotPos = origin + Math.round(0.74 * span);

    const strip = makeLaneStrip(34, 420, [8, 190, 10]);
    // Tiny pitch-black silica pinhole / dust speck (sigmaXFrac=0.055, sigmaY=1.8 -> sharp non-diffused pinpoint)
    paintSpot(strip, { pos: pinholePos, cxFrac: 0.5, sigmaY: 1.8, sigmaXFrac: 0.055, deltaRgb: [0, -175, 0] });
    // Compact dark splash droplet (sigmaXFrac=0.08, sigmaY=2.6 -> still far sharper than a chromatographically diffused spot)
    paintSpot(strip, { pos: splashPos, cxFrac: 0.5, sigmaY: 2.6, sigmaXFrac: 0.08, deltaRgb: [0, -160, 0] });
    // Genuine diffused TLC compound spot (sigmaXFrac=0.20, sigmaY=8.5)
    paintSpot(strip, { pos: realSpotPos, cxFrac: 0.5, sigmaY: 8.5, sigmaXFrac: 0.20, deltaRgb: [0, -55, 0] });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });

    expect(spots.some((s) => Math.abs(s.pos - pinholePos) <= 8)).toBe(false);
    expect(spots.some((s) => Math.abs(s.pos - splashPos) <= 8)).toBe(false);
    expect(spots.length).toBe(1);
    expect(Math.abs(spots[0].pos - realSpotPos)).toBeLessThanOrEqual(4);
  });

  it('segments a full 54-lane plate rapidly (< 1200 ms)', () => {
    const strip = makeLaneStrip(34, 420, [8, 190, 10]);
    paintSpot(strip, { pos: 145, sigmaY: 10, sigmaXFrac: 0.22, deltaRgb: [0, -120, 0] });
    paintSpot(strip, { pos: 265, sigmaY: 12, sigmaXFrac: 0.24, deltaRgb: [0, -105, 0] });
    const m = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35).metrics;

    const t0 = performance.now();
    for (let i = 0; i < 54; i++) {
      const res = segmentLaneSpots2d(m.spotMap2d!, { origin: 45, front: 375, minProminence: 0.28 });
      expect(res.length).toBe(2);
    }
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(1200);
  });

  it('produces a continuous multi-level confidence color gradient and monotonic scores across spot strengths', () => {
    // Verify 5 distinct named tiers and strictly unique interpolated hex colors across the scale
    const sampleLevels = [0.15, 0.30, 0.42, 0.56, 0.68, 0.78, 0.94];
    const styles = sampleLevels.map((c) => getSpotConfidenceStyle(c));
    const uniqueColors = new Set(styles.map((s) => s.color));
    expect(uniqueColors.size).toBe(sampleLevels.length);
    expect(styles.map((s) => s.label)).toEqual([
      'Very Low',
      'Very Low',
      'Low',
      'Medium',
      'Medium',
      'High',
      'Very High',
    ]);
    expect(styles[0].needsReview).toBe(true);
    expect(styles[3].needsReview).toBe(false);
    expect(styles[6].reviewRingAlpha).toBe(0);

    // Verify monotonic confidence spread from faint to medium to strong spots on a realistic UV254 lane
    const origin = 45;
    const front = 375;
    const measureConf = (deltaG: number) => {
      const strip = makeLaneStrip(34, 420, [8, 190, 10]);
      paintSpot(strip, { pos: 210, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, deltaG, 0] });
      const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
      const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });
      expect(spots.length).toBe(1);
      return spots[0].confidence!;
    };

    const cFaint = measureConf(-24);
    const cMed = measureConf(-55);
    const cStrong = measureConf(-135);
    expect(cFaint).toBeLessThan(cMed);
    expect(cMed).toBeLessThan(cStrong);
    expect(getSpotConfidenceStyle(cFaint).color).not.toBe(getSpotConfidenceStyle(cMed).color);
    expect(getSpotConfidenceStyle(cMed).color).not.toBe(getSpotConfidenceStyle(cStrong).color);
  });
});
