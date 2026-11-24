import { describe, it, expect } from 'vitest';
import {
  FRONT_BAND_BINS,
  FRONT_BAND_RF_MIN,
  analyzeLaneStripRgb,
  buildLaneSpotMap2d,
  computeArplsBaseline,
  extractDensitogram,
  findMultiChannelSpots,
  findSpots,
  mergeMultiChannelSpots,
  rescueSharedReagentSpots,
  rgbLabDeltaE,
  segmentLaneSpots2d,
  spotProminenceForDensitogramCutoff,
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

  it('produces 5 maximally distinct discrete confidence categories and monotonic scores across spot strengths', () => {
    // Verify 5 distinct named tiers, tier keys, and strongly separated hex colors across the scale
    const sampleLevels = [0.20, 0.42, 0.60, 0.78, 0.94];
    const styles = sampleLevels.map((c) => getSpotConfidenceStyle(c));
    const uniqueColors = new Set(styles.map((s) => s.color));
    expect(uniqueColors.size).toBe(5);
    expect(styles.map((s) => s.tier)).toEqual([
      'very-low',
      'low',
      'medium',
      'high',
      'very-high',
    ]);
    expect(styles.map((s) => s.label)).toEqual([
      'Very Low',
      'Low',
      'Medium',
      'High',
      'Very High',
    ]);
    // Every pair of tiers must be strongly separated in RGB space (Euclidean dist >= 95)
    for (let i = 0; i < styles.length; i++) {
      for (let j = i + 1; j < styles.length; j++) {
        const [r1, g1, b1] = styles[i].rgb;
        const [r2, g2, b2] = styles[j].rgb;
        expect(Math.hypot(r1 - r2, g1 - g2, b1 - b2)).toBeGreaterThanOrEqual(95);
      }
    }
    expect(styles[0].needsReview).toBe(true);
    expect(styles[1].needsReview).toBe(true);
    expect(styles[2].needsReview).toBe(false);
    expect(styles[4].reviewRingAlpha).toBe(0);

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

    const cFaint = measureConf(-18);
    const cMed = measureConf(-55);
    const cStrong = measureConf(-145);
    expect(cFaint).toBeLessThan(cMed);
    expect(cMed).toBeLessThan(cStrong);
    expect(getSpotConfidenceStyle(cFaint).tier).not.toBe(getSpotConfidenceStyle(cStrong).tier);
  });

  it('merges multi-channel confidence via calibrated noisy-OR without inflating weak hits or inventing missing scores', () => {
    // Two weak 0.15 detections should combine to ~0.28 (still Very Low), never jump to ~0.53 (Medium)
    const weakMerged = mergeMultiChannelSpots({
      UV254: [{ pos: 200, rf: 0.5, strength: 0.2, confidence: 0.15 }],
      UV366: [{ pos: 201, rf: 0.503, strength: 0.18, confidence: 0.15 }],
    });
    expect(weakMerged.length).toBe(1);
    expect(weakMerged[0].confidence).toBeCloseTo(0.28, 2);
    expect(getSpotConfidenceStyle(weakMerged[0].confidence).label).toBe('Very Low');

    // Two spots with missing confidence should remain undefined rather than fabricating 0.92
    const missingMerged = mergeMultiChannelSpots({
      UV254: [{ pos: 200, rf: 0.5, strength: 0.5 }],
      UV366: [{ pos: 200, rf: 0.5, strength: 0.4 }],
    });
    expect(missingMerged.length).toBe(1);
    expect(missingMerged[0].confidence).toBeUndefined();

    // One defined + one missing keeps the defined score without fabrication
    const partialMerged = mergeMultiChannelSpots({
      UV254: [{ pos: 200, rf: 0.5, strength: 0.5 }],
      UV366: [{ pos: 200, rf: 0.5, strength: 0.6, confidence: 0.62 }],
    });
    expect(partialMerged.length).toBe(1);
    expect(partialMerged[0].confidence).toBe(0.62);
  });

  it('keeps barely-visible low-contrast spots below Medium confidence instead of inflating them via geometry', () => {
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

    // A barely-perceptible deltaG=-14 smudge must remain Very Low / Low (< 0.45), never Medium/High (>= 0.52)
    const cWhisper = measureConf(-14);
    const cMedium = measureConf(-55);
    const cStrong = measureConf(-145);
    expect(cWhisper).toBeLessThan(0.45);
    expect(getSpotConfidenceStyle(cWhisper).needsReview).toBe(true);
    expect(cMedium).toBeGreaterThanOrEqual(0.55);
    expect(cStrong).toBeGreaterThanOrEqual(0.86);
  });

  it('merges faint upper-skirt shoulder ripples on broad spots (C3 regression) without losing resolved faint spots', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin; // 330
    const mainPos = origin + Math.round(0.71 * span); // ~279
    const skirtPos = origin + Math.round(0.81 * span); // ~312

    // UV366 broad bright fluorescent band at Rf 0.71 with a small ripple riding on its decaying upper halo at Rf 0.81
    const uv366 = makeLaneStrip(34, 420, [4, 60, 56]);
    paintSpot(uv366, { pos: mainPos, cxFrac: 0.5, sigmaY: 22, sigmaXFrac: 0.32, deltaRgb: [10, 75, 170], power: 3 });
    paintSpot(uv366, { pos: skirtPos, cxFrac: 0.5, sigmaY: 4, sigmaXFrac: 0.22, deltaRgb: [0, 4, 12] });
    const res366 = analyzeLaneStripRgb(uv366.rgba, uv366.width, uv366.length, 'UV366', 0.35);
    const spots366 = findSpots(res366.profile, { sign: 1, origin, front, minProminence: 0.28, lane2d: res366.metrics });
    expect(spots366.length).toBe(1);
    expect(Math.abs(spots366[0].rf - 0.71)).toBeLessThan(0.03);

    // UV254 broad quenching spot at Rf 0.71 with a tiny -7 shoulder ripple at Rf 0.81
    const uv254 = makeLaneStrip(34, 420, [2, 189, 3]);
    paintSpot(uv254, { pos: mainPos, cxFrac: 0.5, sigmaY: 20, sigmaXFrac: 0.28, deltaRgb: [0, -85, 0], power: 3 });
    paintSpot(uv254, { pos: skirtPos, cxFrac: 0.5, sigmaY: 4, sigmaXFrac: 0.22, deltaRgb: [0, -7, 0] });
    const res254 = analyzeLaneStripRgb(uv254.rgba, uv254.width, uv254.length, 'UV254', 0.35);
    const spots254 = findSpots(res254.profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: res254.metrics });
    expect(spots254.length).toBe(1);
    expect(Math.abs(spots254[0].rf - 0.71)).toBeLessThan(0.03);
  });

  it('prevents bright green fluorescence under UV254 from dragging arPLS down and fabricating phantom dark spots on blank silica', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const strip = makeLaneStrip(34, 420, [4, 185, 4]);
    // Bright fluorescent spot under UV254 (brighter than F254 silica: G goes UP by +55!)
    paintSpot(strip, {
      pos: origin + Math.round(0.68 * span),
      cxFrac: 0.5,
      sigmaY: 16,
      sigmaXFrac: 0.26,
      deltaRgb: [0, 55, 0],
    });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });
    expect(spots.length).toBe(0);
  });

  it('suppresses weak single-channel halo/rim ghosts on a strong spot boundary while preserving real doublets and manual picks', () => {
    // Strong UV254+UV366 primary spot at Rf 0.71 spanning pos [230..295], plus weak single-channel rim ghost at pos 300 (Rf 0.81)
    const suppressed = mergeMultiChannelSpots({
      UV254: [
        { pos: 265, rf: 0.71, strength: 1.0, confidence: 0.88, extentStart: 240, extentEnd: 285, source: 'auto' },
        { pos: 300, rf: 0.81, strength: 0.14, confidence: 0.34, extentStart: 294, extentEnd: 306, source: 'auto' },
      ],
      UV366: [
        { pos: 266, rf: 0.712, strength: 1.0, confidence: 0.94, extentStart: 230, extentEnd: 296, source: 'auto' },
      ],
    });
    expect(suppressed.length).toBe(1);
    expect(suppressed[0].rf).toBeCloseTo(0.71, 2);

    // Weak UV254-only dark rim on a strong UV366-only fluorescent band (no UV254 hit at center) is suppressed
    const fluorRim = mergeMultiChannelSpots({
      UV254: [
        { pos: 298, rf: 0.81, strength: 1.0, confidence: 0.54, extentStart: 292, extentEnd: 304, source: 'auto' },
      ],
      UV366: [
        { pos: 265, rf: 0.71, strength: 1.0, confidence: 0.92, extentStart: 230, extentEnd: 295, source: 'auto' },
      ],
    });
    expect(fluorRim.length).toBe(1);
    expect(fluorRim[0].channels).toEqual(['UV366']);

    // Genuine separated faint spot well outside the rim (pos 330) is preserved
    const separated = mergeMultiChannelSpots({
      UV254: [
        { pos: 265, rf: 0.71, strength: 1.0, confidence: 0.88, extentStart: 240, extentEnd: 285, source: 'auto' },
        { pos: 330, rf: 0.90, strength: 0.14, confidence: 0.34, extentStart: 324, extentEnd: 336, source: 'auto' },
      ],
      UV366: [
        { pos: 266, rf: 0.712, strength: 1.0, confidence: 0.94, extentStart: 230, extentEnd: 296, source: 'auto' },
      ],
    });
    expect(separated.length).toBe(2);

    // Genuine visible Medium/High second compound right at the boundary (confidence 0.68) is preserved
    const realDoublet = mergeMultiChannelSpots({
      UV254: [
        { pos: 265, rf: 0.71, strength: 1.0, confidence: 0.88, extentStart: 240, extentEnd: 285, source: 'auto' },
        { pos: 300, rf: 0.81, strength: 0.55, confidence: 0.68, extentStart: 292, extentEnd: 308, source: 'auto' },
      ],
      UV366: [
        { pos: 266, rf: 0.712, strength: 1.0, confidence: 0.94, extentStart: 230, extentEnd: 296, source: 'auto' },
      ],
    });
    expect(realDoublet.length).toBe(2);

    // Manual picks are never suppressed even on a strong spot rim
    const manualKept = mergeMultiChannelSpots({
      UV254: [
        { pos: 300, rf: 0.81, strength: 0.12, confidence: 0.20, extentStart: 294, extentEnd: 306, source: 'manual' },
      ],
      UV366: [
        { pos: 265, rf: 0.71, strength: 1.0, confidence: 0.94, extentStart: 230, extentEnd: 296, source: 'auto' },
      ],
    });
    expect(manualKept.length).toBe(2);
  });

  it('does not stair-step over-split a broad grainy UV366 fluorescent tailing band into multiple Rf picks', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin; // 330
    const peakPos = origin + Math.round(0.72 * span); // ~283

    // Wide full-width UV366 fluorescent band at Rf 0.72 with a long asymmetric monotonic tail down to Rf 0.42
    const strip = makeLaneStrip(36, 420, [8, 42, 62]);
    for (let pos = 0; pos < strip.length; pos++) {
      const y = strip.length - 1 - pos;
      const dy = pos - peakPos;
      // Asymmetric longitudinal profile: faster upper decay (sigma 18), long monotonic lower tail (sigma 46)
      const sigmaY = dy >= 0 ? 18 : 46;
      const yEnv = Math.exp(-0.5 * (dy / sigmaY) ** 2);
      for (let x = 0; x < strip.width; x++) {
        const xNorm = (x + 0.5) / strip.width - 0.5;
        // Very wide lateral fill spanning nearly full lane width (like a bright UV366 streak)
        const xEnv = Math.exp(-0.5 * (xNorm / 0.58) ** 2);
        const amp = yEnv * xEnv;
        // Deterministic mottled 2D camera/silica grain (±12 amplitude, multi-frequency spatial speckles)
        const h1 = Math.sin(x * 1.9 + pos * 0.73) * Math.cos(x * 0.87 - pos * 1.31);
        const h2 = Math.sin(x * 0.61 - pos * 0.37) * Math.cos(x * 1.43 + pos * 0.49);
        const grain = Math.round((h1 * 8 + h2 * 6) * (0.45 + 0.55 * amp));
        const idx = (y * strip.width + x) * 4;
        strip.rgba[idx] = Math.max(0, Math.min(255, Math.round(strip.rgba[idx] + 18 * amp + grain * 0.4)));
        strip.rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(strip.rgba[idx + 1] + 95 * amp + grain)));
        strip.rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(strip.rgba[idx + 2] + 165 * amp + grain)));
      }
    }

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV366', 0.35);
    const spots = findSpots(profile, { sign: 1, origin, front, minProminence: 0.28, lane2d: metrics });

    // Must consolidate into a single true peak near Rf 0.72 instead of 5-8 stair-step slope slices
    expect(spots.length).toBe(1);
    expect(Math.abs(spots[0].rf - 0.72)).toBeLessThanOrEqual(0.05);
    expect(spots[0].confidence!).toBeGreaterThanOrEqual(0.75);
  });

  it('consolidates grainy monotonic UV254 tailing shoulders into one spot while still splitting true touching doublets', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const peakPos = origin + Math.round(0.72 * span);

    // Broad UV254 quenching spot at Rf 0.72 with asymmetric tail + mottled 2D grain
    const strip = makeLaneStrip(36, 420, [6, 190, 8]);
    for (let pos = 0; pos < strip.length; pos++) {
      const y = strip.length - 1 - pos;
      const dy = pos - peakPos;
      const sigmaY = dy >= 0 ? 15 : 36;
      const yEnv = Math.exp(-0.5 * (dy / sigmaY) ** 2);
      for (let x = 0; x < strip.width; x++) {
        const xNorm = (x + 0.5) / strip.width - 0.5;
        const xEnv = Math.exp(-0.5 * (xNorm / 0.45) ** 2);
        const amp = yEnv * xEnv;
        const grain = Math.round(
          (Math.sin(x * 1.7 + pos * 0.83) * 6 + Math.cos(x * 0.91 - pos * 0.41) * 5) * (0.4 + 0.6 * amp)
        );
        const idx = (y * strip.width + x) * 4;
        strip.rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(strip.rgba[idx + 1] - 115 * amp + grain)));
      }
    }

    const resTailed = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const tailedSpots = findSpots(resTailed.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: resTailed.metrics,
    });
    expect(tailedSpots.length).toBe(1);
    expect(Math.abs(tailedSpots[0].rf - 0.72)).toBeLessThanOrEqual(0.05);

    // Genuine touching figure-8 doublet with a real chromatographic dip still resolves as 2 spots
    const doublet = makeLaneStrip(36, 420, [6, 190, 8]);
    const posA = origin + Math.round(0.50 * span);
    const posB = origin + Math.round(0.59 * span);
    paintSpot(doublet, { pos: posA, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.24, deltaRgb: [0, -105, 0] });
    paintSpot(doublet, { pos: posB, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.24, deltaRgb: [0, -95, 0] });
    const resDbl = analyzeLaneStripRgb(doublet.rgba, doublet.width, doublet.length, 'UV254', 0.35);
    const dblSpots = findSpots(resDbl.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: resDbl.metrics,
    });
    expect(dblSpots.length).toBe(2);
    expect(Math.abs(dblSpots[0].pos - posA)).toBeLessThanOrEqual(5);
    expect(Math.abs(dblSpots[1].pos - posB)).toBeLessThanOrEqual(5);
  });

  it('scores a minor peak sitting on an elevated parent slope lower than an equal-altitude isolated spot', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const minorPos = origin + Math.round(0.54 * span);
    const parentPos = origin + Math.round(0.72 * span);

    // Isolated spot of depth -70 on blank silica
    const isoStrip = makeLaneStrip(36, 420, [6, 190, 8]);
    paintSpot(isoStrip, { pos: minorPos, cxFrac: 0.5, sigmaY: 10, sigmaXFrac: 0.25, deltaRgb: [0, -70, 0] });
    const isoRes = analyzeLaneStripRgb(isoStrip.rgba, isoStrip.width, isoStrip.length, 'UV254', 0.35);
    const isoSpots = findSpots(isoRes.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: isoRes.metrics,
    });
    expect(isoSpots.length).toBe(1);

    // Same-altitude (~ -70 total depth) minor peak sitting on an elevated tail shelf from a large parent at Rf 0.72
    const shelfStrip = makeLaneStrip(36, 420, [6, 190, 8]);
    paintSpot(shelfStrip, { pos: parentPos, cxFrac: 0.5, sigmaY: 28, sigmaXFrac: 0.28, deltaRgb: [0, -145, 0] });
    paintSpot(shelfStrip, { pos: minorPos, cxFrac: 0.5, sigmaY: 8.5, sigmaXFrac: 0.24, deltaRgb: [0, -45, 0] });
    const shelfRes = analyzeLaneStripRgb(shelfStrip.rgba, shelfStrip.width, shelfStrip.length, 'UV254', 0.35);
    const shelfSpots = findSpots(shelfRes.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: shelfRes.metrics,
    });

    expect(shelfSpots.length).toBe(2);
    const minorOnShelf = shelfSpots[0];
    const parentSpot = shelfSpots[1];
    expect(Math.abs(minorOnShelf.pos - minorPos)).toBeLessThanOrEqual(7);
    expect(parentSpot.confidence!).toBeGreaterThan(minorOnShelf.confidence!);
    // Prominence-gated confidence on the elevated shelf must be meaningfully lower than the equal-altitude isolated spot
    expect(minorOnShelf.confidence!).toBeLessThan(isoSpots[0].confidence! - 0.08);
  });

  it('keeps adjacent UV254 spots bridged by a wide shadow split and centers Rf on the 50%-height visual apex', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const lowerPos = origin + Math.round(0.63 * span);
    const upperPos = origin + Math.round(0.74 * span);

    const strip = makeLaneStrip(32, 420, [4, 188, 5]);
    // Strong lower dark spot centered at Rf 0.63
    paintSpot(strip, { pos: lowerPos, cxFrac: 0.5, sigmaY: 11, sigmaXFrac: 0.28, deltaRgb: [0, -115, 0] });
    // Wider upper dark band centered at Rf 0.74 plus a faint shared full-width background shadow bridging them
    paintSpot(strip, { pos: upperPos, cxFrac: 0.5, sigmaY: 10, sigmaXFrac: 0.36, deltaRgb: [0, -68, 0] });
    paintHorizontalBand(strip, Math.round((lowerPos + upperPos) * 0.5), 18, [0, -32, 0]);

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    const spots = findSpots(profile, { sign: -1, origin, front, minProminence: 0.28, lane2d: metrics });

    // Must remain split as 2 distinct spots and place the lower spot squarely on its visual center (Rf ~0.63),
    // never merged into one blob dragged up to Rf ~0.67
    expect(spots.length).toBe(2);
    expect(Math.abs(spots[0].rf - 0.63)).toBeLessThanOrEqual(0.025);
    expect(Math.abs(spots[1].rf - 0.74)).toBeLessThanOrEqual(0.03);
  });

  it('never deletes real separated UV254 spots under a wide UV366 tail or real UV366 spots near a UV254 anchor', () => {
    // Separated UV254 dark spot at Rf 0.50 (conf 0.47) under a broad UV366 tailing band centered at Rf 0.71
    // whose extentStart reaches Rf 0.44 must NEVER be deleted as a rim ghost (ΔRf = 0.21 > 0.115).
    const uv254UnderTail = mergeMultiChannelSpots({
      UV254: [
        { pos: 210, rf: 0.50, strength: 0.55, confidence: 0.47, extentStart: 196, extentEnd: 224, source: 'auto' },
      ],
      UV366: [
        { pos: 280, rf: 0.71, strength: 1.0, confidence: 0.94, extentStart: 190, extentEnd: 308, source: 'auto' },
      ],
    });
    expect(uv254UnderTail.length).toBe(2);
    expect(uv254UnderTail.some((s) => Math.abs(s.rf - 0.50) < 0.01)).toBe(true);

    // Real UV366 fluorescent spot at Rf 0.57 (conf 0.50) near a strong UV254-only dark spot at Rf 0.66
    // must NEVER be deleted by a UV254 anchor (dark quenching cannot cause fake UV366 fluorescence).
    const uv366NearUv254 = mergeMultiChannelSpots({
      UV254: [
        { pos: 263, rf: 0.66, strength: 1.0, confidence: 0.89, extentStart: 230, extentEnd: 300, source: 'auto' },
      ],
      UV366: [
        { pos: 233, rf: 0.57, strength: 0.60, confidence: 0.50, extentStart: 218, extentEnd: 248, source: 'auto' },
      ],
    });
    expect(uv366NearUv254.length).toBe(2);
    expect(uv366NearUv254.some((s) => Math.abs(s.rf - 0.57) < 0.01 && s.channels?.includes('UV366'))).toBe(true);
  });

  it('detects concentrated low-Rf spots (Rf ~0.09–0.10) bridging a saturated origin dot in both Standard and Sensitive modes', () => {
    const origin = 30;
    const front = 320;
    const span = front - origin; // 290
    const strip = makeLaneStrip(26, 330, [8, 182, 10]);

    // Heavy saturated origin dot centered slightly above origin (Rf ~0.025)
    paintSpot(strip, { pos: origin + Math.round(0.022 * span), cxFrac: 0.5, sigmaY: 6.5, sigmaXFrac: 0.24, deltaRgb: [0, -142, 0] });
    // Large concentrated eluted low-Rf spot centered at Rf 0.098 whose lower edge overlaps the origin dot
    // (creating a saturated neck around Rf 0.06 where G only rises from ~44 to ~66, while the eluted head
    // diffuses laterally wider and extends up to Rf 0.145)
    paintSpot(strip, { pos: origin + Math.round(0.098 * span), cxFrac: 0.5, sigmaY: 8.0, sigmaXFrac: 0.30, deltaRgb: [0, -138, 0] });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);

    for (const prom of [0.28, 0.08]) {
      const spots = findSpots(profile, { sign: -1, origin, front, minProminence: prom, lane2d: metrics });
      expect(spots.length).toBe(1);
      expect(Math.abs(spots[0].rf - 0.098)).toBeLessThanOrEqual(0.02);
      expect(spots[0].confidence!).toBeGreaterThanOrEqual(0.70);
    }
  });

  it('eliminates wavy/tilted UV254 solvent-front meniscus bands at Rf 0.95–0.99 while keeping isolated high-Rf spots', () => {
    const origin = 32;
    const front = 318;
    const span = front - origin; // 286
    const strip = makeLaneStrip(28, 330, [8, 180, 10]);

    // Tilted/wavy dark solvent-front accumulation band right against front (Rf ~0.96–1.00):
    // Slightly higher/brighter on the right flank than the left flank so min-flank localMap retains
    // residual darkness, matching real uneven TLC solvent fronts.
    for (let pos = origin + Math.round(0.92 * span); pos <= front + 4; pos++) {
      const y = strip.length - 1 - pos;
      for (let x = 0; x < strip.width; x++) {
        const tilt = (x / Math.max(1, strip.width - 1)) * 3.5; // tilted 3.5 px across lane
        const bandCenter = origin + 0.978 * span + tilt;
        const dy = (pos - bandCenter) / 5.5;
        const drop = 88 * Math.exp(-0.5 * dy * dy);
        const idx = (y * strip.width + x) * 4;
        strip.rgba[idx + 1] = Math.max(20, Math.round(strip.rgba[idx + 1] - drop));
      }
    }

    // Real isolated high-Rf compound spot cleanly below the front at Rf 0.88
    paintSpot(strip, {
      pos: origin + Math.round(0.88 * span),
      cxFrac: 0.5,
      sigmaY: 7,
      sigmaXFrac: 0.22,
      deltaRgb: [0, -75, 0],
    });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);
    for (const prom of [0.28, 0.08]) {
      const spots = findSpots(profile, { sign: -1, origin, front, minProminence: prom, lane2d: metrics });
      expect(spots.filter((s) => s.rf >= 0.93).length).toBe(0);
      expect(spots.length).toBe(1);
      expect(Math.abs(spots[0].rf - 0.88)).toBeLessThanOrEqual(0.025);
    }
  });

  it('suppresses ultra-low-confidence (<14%) noise ghosts in Sensitive mode across UV254 and UV366 without losing real faint spots', () => {
    const origin = 40;
    const front = 350;

    // Noisy blank UV366 lane with subtle ±4 camera sensor mottling (no real compound)
    const blank366 = makeLaneStrip(30, 390, [6, 22, 18]);
    for (let pos = 0; pos < blank366.length; pos++) {
      const y = blank366.length - 1 - pos;
      for (let x = 0; x < blank366.width; x++) {
        const mottle = Math.round(
          2.2 * Math.sin(pos * 0.11 + x * 0.25) + 1.8 * Math.cos(pos * 0.23 - x * 0.19)
        );
        const idx = (y * blank366.width + x) * 4;
        blank366.rgba[idx + 1] = Math.max(0, Math.min(255, blank366.rgba[idx + 1] + mottle));
        blank366.rgba[idx + 2] = Math.max(0, Math.min(255, blank366.rgba[idx + 2] + mottle));
      }
    }
    const res366 = analyzeLaneStripRgb(blank366.rgba, blank366.width, blank366.length, 'UV366', 0.35);
    const ghostSpots366 = findSpots(res366.profile, {
      sign: 1,
      origin,
      front,
      minProminence: 0.08,
      lane2d: res366.metrics,
    });
    expect(ghostSpots366.length).toBe(0);

    // Noisy blank UV254 lane with gentle illumination mottle + real faint spot (-15 counts)
    const faint254 = makeLaneStrip(30, 390, [8, 186, 10]);
    for (let pos = 0; pos < faint254.length; pos++) {
      const y = faint254.length - 1 - pos;
      for (let x = 0; x < faint254.width; x++) {
        const mottle = Math.round(2.5 * Math.sin(pos * 0.09 + x * 0.21) + (((pos * 31 + x * 17) % 5) - 2));
        const idx = (y * faint254.width + x) * 4;
        faint254.rgba[idx + 1] = Math.max(0, Math.min(255, faint254.rgba[idx + 1] + mottle));
      }
    }
    paintSpot(faint254, { pos: 195, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.22, deltaRgb: [0, -16, 0] });
    const res254 = analyzeLaneStripRgb(faint254.rgba, faint254.width, faint254.length, 'UV254', 0.35);
    const faintSpots = findSpots(res254.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.08,
      lane2d: res254.metrics,
    });
    expect(faintSpots.length).toBe(1);
    expect(Math.abs(faintSpots[0].pos - 195)).toBeLessThanOrEqual(5);
    expect(faintSpots[0].confidence!).toBeGreaterThanOrEqual(0.14);
  });

  it('rescueSharedReagentSpots refuses to self-bootstrap relaxed-only noise, sub-18% ghosts, or near-front band hits', () => {
    const mk = (rf: number, confidence: number) => ({
      pos: Math.round(50 + rf * 350),
      rf,
      strength: 0.15,
      confidence,
      source: 'auto' as const,
    });

    const rescued = rescueSharedReagentSpots([
      // Correlated relaxed-only noise at Rf 0.30 across 4 wells (ZERO solo anchors) -> must NOT rescue
      // Near-front band at Rf 0.96 even with solo anchors -> must NOT rescue
      // Ultra-weak ghost (conf 0.11) at Rf 0.50 even with solo anchors -> must NOT rescue
      { laneId: 0, reagentCodes: ['A'], origin: 50, front: 400, soloSpots: [mk(0.50, 0.85), mk(0.96, 0.45)], relaxedCandidates: [mk(0.30, 0.25)] },
      { laneId: 1, reagentCodes: ['A'], origin: 50, front: 400, soloSpots: [mk(0.50, 0.80), mk(0.96, 0.42)], relaxedCandidates: [mk(0.30, 0.24)] },
      { laneId: 2, reagentCodes: ['A'], origin: 50, front: 400, soloSpots: [], relaxedCandidates: [mk(0.30, 0.23), mk(0.50, 0.11), mk(0.96, 0.35)] },
      { laneId: 3, reagentCodes: ['A'], origin: 50, front: 400, soloSpots: [], relaxedCandidates: [mk(0.30, 0.22), mk(0.50, 0.28)] },
    ]);

    expect(rescued.get(2) ?? []).toEqual([]);
    // Lane 3's valid Rf 0.50 candidate (conf 0.28, backed by 2 solo anchors) IS rescued, but NOT Rf 0.30
    expect(rescued.get(3)?.length).toBe(1);
    expect(rescued.get(3)?.[0].rf).toBeCloseTo(0.50, 2);
  });

  it('recovers real high-Rf spots sitting against a solvent-front meniscus when plate frontBandBg confirms they exceed the plate-wide meniscus (both 2D Seg and Densitogram)', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    // Build a plate-wide front-band background profile (Rf 0.80..1.00):
    // clean green silica through Rf 0.95, dark plate-wide solvent-front meniscus at Rf 0.97..1.00 (~38 counts)
    const frontBandBg = Array.from({ length: FRONT_BAND_BINS }, (_, b) => {
      const rf = FRONT_BAND_RF_MIN + (b / (FRONT_BAND_BINS - 1)) * (1 - FRONT_BAND_RF_MIN);
      const meniscus = 38 * Math.exp(-0.5 * Math.pow((rf - 0.985) / 0.014, 2));
      return meniscus;
    });

    // Lane A: REAL high-Rf spot at Rf 0.935 sitting in a 3-adjacent-lane shared cluster (wings darken flanks)
    // directly adjacent to the dark Rf 0.985 solvent-front meniscus band
    const laneWithSpot = makeLaneStrip(34, 420, [8, 192, 10]);
    const spotPos = Math.round(origin + 0.935 * span);
    const frontBandPos = Math.round(origin + 0.985 * span);
    // Neighboring shared spots darken the left and right flanks at the same Rf 0.935
    paintSpot(laneWithSpot, { pos: spotPos, cxFrac: 0.5, sigmaY: 6.5, sigmaXFrac: 0.36, deltaRgb: [0, -72, 0] });
    paintSpot(laneWithSpot, { pos: spotPos, cxFrac: 0.02, sigmaY: 6.5, sigmaXFrac: 0.26, deltaRgb: [0, -48, 0] });
    paintSpot(laneWithSpot, { pos: spotPos, cxFrac: 0.98, sigmaY: 6.5, sigmaXFrac: 0.26, deltaRgb: [0, -48, 0] });
    // Plate-wide horizontal meniscus right behind it at Rf 0.985
    for (let pos = frontBandPos - 8; pos <= front; pos++) {
      const rf = (pos - origin) / span;
      const dG = -Math.round(38 * Math.exp(-0.5 * Math.pow((rf - 0.985) / 0.014, 2)));
      const y = laneWithSpot.length - 1 - pos;
      if (y < 0 || y >= laneWithSpot.length) continue;
      for (let x = 0; x < laneWithSpot.width; x++) {
        const idx = (y * laneWithSpot.width + x) * 4;
        laneWithSpot.rgba[idx + 1] = Math.max(0, laneWithSpot.rgba[idx + 1] + dG);
      }
    }

    const resSpot = analyzeLaneStripRgb(laneWithSpot.rgba, laneWithSpot.width, laneWithSpot.length, 'UV254', 0.35);

    // 2D Seg with frontBandBg MUST detect the Rf 0.935 compound spot and NOT the Rf 0.985 meniscus
    const spots2d = findSpots(resSpot.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: resSpot.metrics,
      frontBandBg,
      detectorMode: '2d',
    });
    expect(spots2d.some((s) => Math.abs(s.rf - 0.935) < 0.025)).toBe(true);
    expect(spots2d.some((s) => s.rf >= 0.975)).toBe(false);

    // Densitogram mode with frontBandBg MUST also detect Rf 0.935 and ignore the Rf 0.985 meniscus
    const spotsDens = findSpots(resSpot.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: resSpot.metrics,
      frontBandBg,
      detectorMode: 'densitogram',
    });
    expect(spotsDens.length).toBe(1);
    expect(spotsDens[0].rf).toBeCloseTo(0.935, 1);
    expect(spotsDens[0].detector).toBe('densitogram');

    // Lane B: EMPTY lane that ONLY has the plate-wide Rf 0.985 solvent-front meniscus -> 0 spots in BOTH modes
    const emptyLane = makeLaneStrip(34, 420, [8, 192, 10]);
    for (let pos = frontBandPos - 8; pos <= front; pos++) {
      const rf = (pos - origin) / span;
      const dG = -Math.round(38 * Math.exp(-0.5 * Math.pow((rf - 0.985) / 0.014, 2)));
      const y = emptyLane.length - 1 - pos;
      if (y < 0 || y >= emptyLane.length) continue;
      for (let x = 0; x < emptyLane.width; x++) {
        const idx = (y * emptyLane.width + x) * 4;
        emptyLane.rgba[idx + 1] = Math.max(0, emptyLane.rgba[idx + 1] + dG);
      }
    }
    const resEmpty = analyzeLaneStripRgb(emptyLane.rgba, emptyLane.width, emptyLane.length, 'UV254', 0.35);
    expect(
      findSpots(resEmpty.profile, {
        sign: -1,
        origin,
        front,
        minProminence: 0.28,
        lane2d: resEmpty.metrics,
        frontBandBg,
        detectorMode: '2d',
      })
    ).toEqual([]);
    expect(
      findSpots(resEmpty.profile, {
        sign: -1,
        origin,
        front,
        minProminence: 0.28,
        lane2d: resEmpty.metrics,
        frontBandBg,
        detectorMode: 'densitogram',
      })
    ).toEqual([]);
  });

  it('Densitogram cutoff mode picks peaks strictly inside [origin..front], splits doublets, rejects origin tails, and exposes live densitogramCutoff', () => {
    const origin = 45;
    const front = 375;
    const strip = makeLaneStrip(34, 420, [8, 194, 10]);
    // Heavy origin dot with monotonically falling shoulder
    paintSpot(strip, { pos: origin, cxFrac: 0.5, sigmaY: 11, sigmaXFrac: 0.28, deltaRgb: [0, -145, 0] });
    // Close doublet at pos 180 and 205 (Rf ~0.41 and ~0.48)
    paintSpot(strip, { pos: 180, cxFrac: 0.5, sigmaY: 6.5, sigmaXFrac: 0.22, deltaRgb: [0, -78, 0] });
    paintSpot(strip, { pos: 205, cxFrac: 0.5, sigmaY: 6.5, sigmaXFrac: 0.22, deltaRgb: [0, -68, 0] });
    // Faint-medium spot at pos 300 (Rf ~0.77)
    paintSpot(strip, { pos: 300, cxFrac: 0.5, sigmaY: 7, sigmaXFrac: 0.22, deltaRgb: [0, -24, 0] });
    // Handwriting / smudge ABOVE solvent front (pos 402) must be ignored
    paintSpot(strip, { pos: 402, cxFrac: 0.5, sigmaY: 6, sigmaXFrac: 0.3, deltaRgb: [0, -90, 0] });

    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);

    const densDefault = extractDensitogram(profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: metrics,
      detectorMode: 'densitogram',
    });
    expect(densDefault.densitogramCutoff).toBeGreaterThan(4);
    expect(densDefault.spots.length).toBe(3);
    expect(densDefault.spots.every((s) => s.pos > origin && s.pos < front)).toBe(true);
    expect(Math.abs(densDefault.spots[0].pos - 180)).toBeLessThanOrEqual(4);
    expect(Math.abs(densDefault.spots[1].pos - 205)).toBeLessThanOrEqual(4);
    expect(Math.abs(densDefault.spots[2].pos - 300)).toBeLessThanOrEqual(4);

    // Raising the Cutoff slider to 65% filters out the fainter -24 spot while keeping the two strong spots
    const densStrict = extractDensitogram(profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.65,
      lane2d: metrics,
      detectorMode: 'densitogram',
    });
    expect(densStrict.densitogramCutoff!).toBeGreaterThan(densDefault.densitogramCutoff!);
    expect(densStrict.spots.length).toBe(2);

    // Round-trip inverse math for dragging the Cutoff guide line on the SVG densitogram
    const roundTrip = spotProminenceForDensitogramCutoff(
      densDefault.densitogramCutoff!,
      densDefault.densitogramPlateSpan!,
      densDefault.densitogramNoiseFloor!
    );
    expect(roundTrip).toBeCloseTo(0.28, 2);
  });

  it('Densitogram mode rejects spotter microdroplets and their narrow vertical runs while keeping normal eluted spots', () => {
    const origin = 50;
    const front = 370;

    // Lane A: pure spotter microdroplet at origin (FWHM ~ 0.15W) + narrow elongated vertical run (FWHM ~ 0.22W)
    const microStrip = makeLaneStrip(40, 420, [8, 185, 8]);
    paintSpot(microStrip, { pos: origin, cxFrac: 0.45, sigmaY: 6.5, sigmaXFrac: 0.065, deltaRgb: [0, -92, 0] });
    paintSpot(microStrip, { pos: 215, cxFrac: 0.43, sigmaY: 32, sigmaXFrac: 0.095, deltaRgb: [0, -72, 0] });

    const { profile: microProf, metrics: microMetrics } = analyzeLaneStripRgb(
      microStrip.rgba,
      microStrip.width,
      microStrip.length,
      'UV254',
      0.35
    );

    // Default Min W (28%) rejects the narrow microdroplet run and records it for UI transparency
    const densFiltered = extractDensitogram(microProf, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: microMetrics,
      detectorMode: 'densitogram',
    });
    expect(densFiltered.spots).toEqual([]);
    expect(densFiltered.rejectedNarrowPeaks?.length).toBeGreaterThanOrEqual(1);
    expect(densFiltered.rejectedNarrowPeaks![0].reason).toBe('microdroplet-run');
    expect(densFiltered.rejectedNarrowPeaks![0].widthFrac).toBeLessThan(0.28);

    // Disabling Min W (0 = Off) restores the peak if the user explicitly wants to see microdroplet streaks
    const densOff = extractDensitogram(microProf, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: microMetrics,
      detectorMode: 'densitogram',
      minSpotWidthFrac: 0,
    });
    expect(densOff.spots.length).toBe(1);
    expect(Math.abs(densOff.spots[0].pos - 215)).toBeLessThanOrEqual(8);

    // Lane B: normal eluted spot (FWHM ~ 0.52W) + a narrow mid-lane microdroplet streak (FWHM ~ 0.19W)
    const mixedStrip = makeLaneStrip(40, 420, [8, 185, 8]);
    paintSpot(mixedStrip, { pos: origin, cxFrac: 0.5, sigmaY: 8, sigmaXFrac: 0.22, deltaRgb: [0, -110, 0] });
    paintSpot(mixedStrip, { pos: 155, cxFrac: 0.46, sigmaY: 22, sigmaXFrac: 0.08, deltaRgb: [0, -68, 0] });
    paintSpot(mixedStrip, { pos: 275, cxFrac: 0.5, sigmaY: 11, sigmaXFrac: 0.22, deltaRgb: [0, -62, 0] });

    const { profile: mixedProf, metrics: mixedMetrics } = analyzeLaneStripRgb(
      mixedStrip.rgba,
      mixedStrip.width,
      mixedStrip.length,
      'UV254',
      0.35
    );
    const densMixed = extractDensitogram(mixedProf, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: mixedMetrics,
      detectorMode: 'densitogram',
    });
    expect(densMixed.spots.length).toBe(1);
    expect(Math.abs(densMixed.spots[0].pos - 275)).toBeLessThanOrEqual(5);
    expect(densMixed.spots[0].widthFrac).toBeGreaterThan(0.40);
    expect(densMixed.rejectedNarrowPeaks?.length).toBe(1);
    expect(Math.abs(densMixed.rejectedNarrowPeaks![0].pos - 155)).toBeLessThanOrEqual(8);
  });

  it('2D Seg mode rejects tall narrow microdroplet runs while keeping normal eluted spots', () => {
    const origin = 50;
    const front = 370;

    const strip = makeLaneStrip(40, 420, [8, 185, 8]);
    // Tiny microdroplet at origin + tall narrow vertical run
    paintSpot(strip, { pos: origin, cxFrac: 0.45, sigmaY: 6.5, sigmaXFrac: 0.065, deltaRgb: [0, -92, 0] });
    paintSpot(strip, { pos: 215, cxFrac: 0.43, sigmaY: 32, sigmaXFrac: 0.095, deltaRgb: [0, -72, 0] });
    const { profile, metrics } = analyzeLaneStripRgb(strip.rgba, strip.width, strip.length, 'UV254', 0.35);

    const spots2d = findSpots(profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: metrics,
      detectorMode: '2d',
    });
    expect(spots2d).toEqual([]);

    // With minSpotWidthFrac disabled (0), 2D Seg detects the elongated run
    const spots2dOff = findSpots(profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: metrics,
      detectorMode: '2d',
      minSpotWidthFrac: 0,
    });
    expect(spots2dOff.length).toBe(1);
  });

  it('Densitogram mode never rejects wide full-lane UV254 or tilted UV366 bands as narrow microdroplets or edge spillover', () => {
    const origin = 45;
    const front = 375;
    const span = front - origin;
    const posHigh = origin + Math.round(0.72 * span);
    const posLow = origin + Math.round(0.55 * span);

    // 1. Wide full-lane UV254 band spanning 100% of lane width with a small central dome (previously collapsed to ~26% width when same-row flanks were subtracted)
    const uv254Strip = makeLaneStrip(38, 420, [8, 192, 10]);
    paintSpot(uv254Strip, { pos: posHigh, cxFrac: 0.5, sigmaY: 16, sigmaXFrac: 1.4, deltaRgb: [0, -42, 0] });
    paintSpot(uv254Strip, { pos: posHigh, cxFrac: 0.5, sigmaY: 14, sigmaXFrac: 0.11, deltaRgb: [0, -8, 0] });
    const uv254 = analyzeLaneStripRgb(uv254Strip.rgba, uv254Strip.width, uv254Strip.length, 'UV254', 0.35);
    const dens254 = extractDensitogram(uv254.profile, {
      sign: -1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: uv254.metrics,
      detectorMode: 'densitogram',
    });
    expect(dens254.spots.length).toBe(1);
    expect(Math.abs(dens254.spots[0].pos - posHigh)).toBeLessThanOrEqual(5);
    expect(dens254.spots[0].widthFrac).toBeGreaterThanOrEqual(0.85);
    expect(dens254.rejectedNarrowPeaks ?? []).toEqual([]);

    // 2. Wide full-lane slightly right-tilted UV366 fluorescent band above a lower spot at Rf 0.55
    const uv366Strip = makeLaneStrip(38, 420, [10, 14, 24]);
    paintSpot(uv366Strip, { pos: posLow, cxFrac: 0.5, sigmaY: 9, sigmaXFrac: 0.45, deltaRgb: [10, 35, 65] });
    paintSpot(uv366Strip, { pos: posHigh, cxFrac: 0.62, sigmaY: 22, sigmaXFrac: 1.3, deltaRgb: [25, 85, 165] });
    const uv366 = analyzeLaneStripRgb(uv366Strip.rgba, uv366Strip.width, uv366Strip.length, 'UV366', 0.35);
    const dens366 = extractDensitogram(uv366.profile, {
      sign: 1,
      origin,
      front,
      minProminence: 0.28,
      lane2d: uv366.metrics,
      detectorMode: 'densitogram',
    });
    expect(dens366.spots.some((s) => Math.abs(s.pos - posHigh) <= 6)).toBe(true);
    const highSpot = dens366.spots.find((s) => Math.abs(s.pos - posHigh) <= 6)!;
    expect(highSpot.widthFrac).toBeGreaterThanOrEqual(0.85);
    expect(dens366.rejectedNarrowPeaks ?? []).toEqual([]);
  });

  it('mergeMultiChannelSpots keeps closely-spaced UV254 and UV366 peaks distinct when one sits in the other channel valley', () => {
    // Exact scenario: UV254 peaks at Rf 0.02 (pos 52) & Rf 0.093 (pos 76, valley at pos 65 / Rf 0.06),
    // while UV366 peaks right in that UV254 valley at Rf 0.06 (pos 65).
    const interleaved = mergeMultiChannelSpots({
      UV254: [
        { pos: 52, rf: 0.02, strength: 1.0, confidence: 0.96, extentStart: 45, extentEnd: 65, source: 'auto' },
        { pos: 76, rf: 0.093, strength: 0.92, confidence: 0.94, extentStart: 65, extentEnd: 92, source: 'auto' },
      ],
      UV366: [
        { pos: 65, rf: 0.06, strength: 1.0, confidence: 0.96, extentStart: 56, extentEnd: 74, source: 'auto' },
      ],
    });
    expect(interleaved.length).toBe(3);
    expect(interleaved.map((s) => +s.rf.toFixed(3))).toEqual([0.02, 0.06, 0.093]);

    // Even when ΔRf = 0.020 (< 0.024), a peak sitting right on the other peak's valley boundary must NOT merge
    const valleyEdge = mergeMultiChannelSpots({
      UV254: [
        { pos: 72, rf: 0.08, strength: 0.9, confidence: 0.92, extentStart: 65, extentEnd: 84, source: 'auto' },
      ],
      UV366: [
        { pos: 65, rf: 0.06, strength: 1.0, confidence: 0.95, extentStart: 56, extentEnd: 71, source: 'auto' },
      ],
    });
    expect(valleyEdge.length).toBe(2);

    // Genuinely co-eluting UV254 + UV366 peaks whose apexes sit inside each other's bodies still merge
    const coEluting = mergeMultiChannelSpots({
      UV254: [
        { pos: 66, rf: 0.062, strength: 0.9, confidence: 0.90, extentStart: 56, extentEnd: 76, source: 'auto' },
      ],
      UV366: [
        { pos: 65, rf: 0.06, strength: 1.0, confidence: 0.95, extentStart: 55, extentEnd: 75, source: 'auto' },
      ],
    });
    expect(coEluting.length).toBe(1);
    expect(coEluting[0].channels).toEqual(['UV254', 'UV366']);
  });
});




