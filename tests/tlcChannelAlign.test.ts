import { describe, it, expect } from 'vitest';
import {
  AlignRaster,
  estimateChannelAlignment,
  isIdentityAlignment,
} from '../src/engine/tlcChannelAlign';
import { sampleFloatRgbLaneStrip } from '../src/engine/tlcLabPipeline';
import { TlcLane } from '../src/types';

/**
 * Renders a realistic synthetic two-tier 27-lane TLC plate raster in either UV254, UV366, or White
 * light, with an optional geometric shift/scale applied to the plate in source-image coordinates.
 *
 * A point `(u_ref, v_ref)` on the canonical plate appears at:
 *   `u_src = u_ref * plateScale + shiftU`
 *   `v_src = v_ref * plateScale + shiftV`
 * so the inverse registration transform mapping `src -> ref` should recover:
 *   `sx = 1 / plateScale, sy = 1 / plateScale, dx = -shiftU / plateScale, dy = -shiftV / plateScale`.
 */
function renderSyntheticPlate(
  channel: 'UV254' | 'UV366' | 'White',
  width: number,
  height: number,
  opts: { shiftU?: number; shiftV?: number; plateScale?: number; whiteNoisySurround?: boolean } = {}
): AlignRaster {
  const shiftU = opts.shiftU ?? 0;
  const shiftV = opts.shiftV ?? 0;
  const plateScale = opts.plateScale ?? 1;
  const whiteNoisySurround = opts.whiteNoisySurround ?? channel === 'UV366';

  const data = new Uint8ClampedArray(width * height * 4);

  // Deterministic pseudo-random noise for camera surround
  let seed = channel === 'UV254' ? 11 : channel === 'UV366' ? 29 : 53;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  // Canonical plate geometry in normalized [0..1] coordinates
  const plateX0 = 0.08;
  const plateX1 = 0.92;
  const plateY0 = 0.05;
  const plateY1 = 0.95;
  const midGapY0 = 0.475;
  const midGapY1 = 0.525;
  const topOriginV = 0.095;
  const botOriginV = 0.895;

  // Deterministic 27 lanes + representative eluted spots
  const lanes = 27;
  const laneU = (i: number) => plateX0 + 0.04 + (i / (lanes - 1)) * (plateX1 - plateX0 - 0.08);
  const spots: Array<{ u: number; v: number; ru: number; rv: number; strength: number }> = [];
  for (let i = 0; i < lanes; i++) {
    const u = laneU(i);
    // Top & bottom origin dots
    spots.push({ u, v: topOriginV, ru: 0.008, rv: 0.009, strength: 1.0 });
    spots.push({ u, v: botOriginV, ru: 0.008, rv: 0.009, strength: 1.0 });
    // Eluted spots with varied Rf across lanes
    if (i % 2 === 0) {
      spots.push({ u, v: topOriginV + 0.14 + (i % 5) * 0.015, ru: 0.009, rv: 0.022, strength: 0.85 });
      spots.push({ u, v: botOriginV - 0.16 - (i % 4) * 0.018, ru: 0.009, rv: 0.022, strength: 0.85 });
    }
    if (i % 3 === 1) {
      spots.push({ u, v: topOriginV + 0.27, ru: 0.008, rv: 0.014, strength: 0.7 });
      spots.push({ u, v: botOriginV - 0.29, ru: 0.008, rv: 0.014, strength: 0.7 });
    }
  }

  for (let y = 0; y < height; y++) {
    const vSrc = (y + 0.5) / height;
    const vRef = (vSrc - shiftV) / plateScale;
    for (let x = 0; x < width; x++) {
      const uSrc = (x + 0.5) / width;
      const uRef = (uSrc - shiftU) / plateScale;
      const o = (y * width + x) * 4;

      const onPlate =
        uRef >= plateX0 && uRef <= plateX1 && vRef >= plateY0 && vRef <= plateY1;

      if (!onPlate) {
        if (whiteNoisySurround && (uSrc < plateX0 - 0.01 || uSrc > plateX1 + 0.01)) {
          // Bright noisy UV366 camera surround like in real box photos
          const n = 215 + Math.round(rand() * 35);
          data[o] = n;
          data[o + 1] = n;
          data[o + 2] = Math.min(255, n + 15);
        } else {
          // Black camera mat border
          data[o] = 6;
          data[o + 1] = 8;
          data[o + 2] = 10;
        }
        data[o + 3] = 255;
        continue;
      }

      const inGap = vRef >= midGapY0 && vRef <= midGapY1;
      // Evaluate nearest spot intensity
      let spotAmt = 0;
      for (let s = 0; s < spots.length; s++) {
        const sp = spots[s];
        const du = (uRef - sp.u) / sp.ru;
        if (du < -2.6 || du > 2.6) continue;
        const dv = (vRef - sp.v) / sp.rv;
        if (dv < -2.6 || dv > 2.6) continue;
        const val = sp.strength * Math.exp(-0.5 * (du * du + dv * dv));
        if (val > spotAmt) spotAmt = val;
      }

      if (channel === 'UV254') {
        // Saturated green fluorescent silica with dark quenching spots & dark middle gap
        const baseG = inGap ? 140 : 255;
        const g = Math.max(12, Math.round(baseG * (1 - 0.85 * spotAmt)));
        data[o] = Math.round(g * 0.06);
        data[o + 1] = g;
        data[o + 2] = Math.round(g * 0.04);
      } else if (channel === 'UV366') {
        // Dark blue plate with bright cyan/white fluorescent spots & slightly dimmer gap
        const baseR = inGap ? 14 : 20;
        const baseG = inGap ? 75 : 105;
        const baseB = inGap ? 135 : 185;
        data[o] = Math.min(255, Math.round(baseR + 215 * spotAmt));
        data[o + 1] = Math.min(255, Math.round(baseG + 145 * spotAmt));
        data[o + 2] = Math.min(255, Math.round(baseB + 70 * spotAmt));
      } else {
        // White visible light: bright cream silica with darker stained spots & darker gap
        const base = inGap ? 185 : 238;
        const v = Math.max(30, Math.round(base - 155 * spotAmt));
        data[o] = v;
        data[o + 1] = Math.max(25, v - Math.round(25 * spotAmt));
        data[o + 2] = Math.max(20, v - Math.round(45 * spotAmt));
      }
      data[o + 3] = 255;
    }
  }

  return { data, width, height };
}

describe('tlcChannelAlign: automatic multi-channel TLC plate registration', () => {
  it('recovers a ~24 px (+3.1%) downward UV366 shift relative to UV254 despite opposite spot polarity and noisy bright surround', () => {
    const W = 256;
    const H = 256;
    const shiftV = 24 / 768; // +0.03125 downward in UV366 source image
    const ref254 = renderSyntheticPlate('UV254', W, H);
    const src366 = renderSyntheticPlate('UV366', W, H, { shiftV, whiteNoisySurround: true });

    const align = estimateChannelAlignment(ref254, 'UV254', src366, 'UV366');

    expect(align.refChannel).toBe('UV254');
    expect(align.confidence).toBeGreaterThan(0.5);
    expect(Math.abs(align.dx)).toBeLessThan(0.005);
    // Drawing UV366 back onto UV254 requires shifting UV366 UP by -shiftV
    expect(Math.abs(align.dy - -shiftV)).toBeLessThan(0.004);
    expect(Math.abs(align.sx - 1)).toBeLessThan(0.02);
    expect(Math.abs(align.sy - 1)).toBeLessThan(0.02);
  });

  it('recovers combined horizontal and vertical shifts between UV254 and White-light plate photos', () => {
    const W = 256;
    const H = 256;
    const shiftU = -0.025;
    const shiftV = 0.035;
    const ref254 = renderSyntheticPlate('UV254', W, H);
    const srcWhite = renderSyntheticPlate('White', W, H, { shiftU, shiftV });

    const align = estimateChannelAlignment(ref254, 'UV254', srcWhite, 'White');

    expect(align.confidence).toBeGreaterThan(0.5);
    expect(Math.abs(align.dx - -shiftU)).toBeLessThan(0.005);
    expect(Math.abs(align.dy - -shiftV)).toBeLessThan(0.005);
  });

  it('compensates for a differently cropped/scaled UV366 photo so plate coordinates align onto UV254', () => {
    const W = 256;
    const H = 256;
    const plateScale = 0.94;
    const shiftU = 0.03;
    const shiftV = 0.05;
    const ref254 = renderSyntheticPlate('UV254', W, H);
    const src366 = renderSyntheticPlate('UV366', W, H, {
      plateScale,
      shiftU,
      shiftV,
      whiteNoisySurround: true,
    });

    const align = estimateChannelAlignment(ref254, 'UV254', src366, 'UV366');

    expect(align.confidence).toBeGreaterThan(0.45);
    // Verify top & bottom origin positions (v_ref = 0.095 and 0.895) map back within ~1% of reference
    for (const vRef of [0.095, 0.5, 0.895]) {
      const vSrc = vRef * plateScale + shiftV;
      const vMapped = align.sy * vSrc + align.dy;
      expect(Math.abs(vMapped - vRef)).toBeLessThan(0.012);
    }
    const uCenterSrc = 0.5 * plateScale + shiftU;
    const uCenterMapped = align.sx * uCenterSrc + align.dx;
    expect(Math.abs(uCenterMapped - 0.5)).toBeLessThan(0.012);
  });

  it('preserves exact identity when UV254 and UV366 are already pixel-registered', () => {
    const W = 256;
    const H = 256;
    const ref254 = renderSyntheticPlate('UV254', W, H);
    const src366 = renderSyntheticPlate('UV366', W, H, { shiftU: 0, shiftV: 0 });

    const align = estimateChannelAlignment(ref254, 'UV254', src366, 'UV366');

    expect(isIdentityAlignment(align)).toBe(true);
    expect(align.dx).toBe(0);
    expect(align.dy).toBe(0);
    expect(align.sx).toBe(1);
    expect(align.sy).toBe(1);
  });

  it('aligns float32 .npy lane strip sampling so shifted UV366 spots land at the same lane index as UV254', () => {
    const imgW = 200;
    const imgH = 200;
    const shiftPx = 12; // UV366 spot appears 12 px lower in source image
    const shiftV = shiftPx / imgH;

    // Put a bright spot at (x=100, y=140) in reference space -> (x=100, y=152) in shifted UV366 floatRgb
    const floatRgb = new Float32Array(imgW * imgH * 3);
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const d2 = (x - 100) * (x - 100) + (y - (140 + shiftPx)) * (y - (140 + shiftPx));
        const val = 20 + 220 * Math.exp(-d2 / 8);
        const o = (y * imgW + x) * 3;
        floatRgb[o] = val;
        floatRgb[o + 1] = val;
        floatRgb[o + 2] = val;
      }
    }

    // Upright lane starting at (x0=100, y0=180), running upward (angle=0) for length=120
    // Reference y=140 corresponds to along-lane distance 180 - 140 = 40 -> row sy = 120 - 40 = 80
    const lane: TlcLane = {
      id: 0,
      x0: 100,
      y0: 180,
      angle: 0,
      width: 10,
      length: 120,
    };

    const alignedStrip = sampleFloatRgbLaneStrip(floatRgb, imgW, imgH, lane, 1, 10, 120, {
      sx: 1,
      sy: 1,
      dx: 0,
      dy: -shiftV,
      refW: imgW,
      refH: imgH,
    });

    // Find peak row along the centerline of the sampled strip
    let peakRow = -1;
    let peakVal = -1;
    for (let row = 0; row < 120; row++) {
      const val = alignedStrip[(row * 10 + 5) * 4];
      if (val > peakVal) {
        peakVal = val;
        peakRow = row;
      }
    }
    // Expected row = 120 - 40 - 0.5 ≈ 79..80 (within 1 px of reference y=140, NOT shifted by 12 px!)
    expect(Math.abs(peakRow - 79.5)).toBeLessThanOrEqual(1);
    expect(peakVal).toBeGreaterThan(200);
  });

  it('registers UV366 onto UV254 even when interior chemical spots do not overlap and image aspect ratios differ', () => {
    // Reference UV254: 256 x 240, UV366: 292 x 248 (wider frame with bright noisy white side margins + downward plate shift)
    const ref254 = renderSyntheticPlate('UV254', 256, 240);
    const srcW = 292;
    const srcH = 248;
    const shiftV = 0.032; // +8 px downward in UV366
    const raw366 = renderSyntheticPlate('UV366', srcW, srcH, {
      shiftV,
      whiteNoisySurround: true,
    });
    // Overwrite interior of UV366 with strong fluorescent streaks in different lanes/Rf positions
    // so interior spots do not coincide with UV254 dark ovals
    for (let y = Math.round(srcH * 0.16); y < Math.round(srcH * 0.44); y++) {
      for (let x = Math.round(srcW * 0.15); x < Math.round(srcW * 0.85); x++) {
        if (((x * 11) % 37) < 5) {
          const o = (y * srcW + x) * 4;
          raw366.data[o] = 200;
          raw366.data[o + 1] = 245;
          raw366.data[o + 2] = 255;
        }
      }
    }

    const align = estimateChannelAlignment(ref254, 'UV254', raw366, 'UV366');
    expect(align.confidence).toBeGreaterThan(0.4);
    // Top & bottom plate edges (v_ref = 0.05 and 0.95) should map back within ~1% of reference
    for (const vRef of [0.05, 0.5, 0.95]) {
      const vSrc = vRef + shiftV;
      const vMapped = align.sy * vSrc + align.dy;
      expect(Math.abs(vMapped - vRef)).toBeLessThan(0.012);
    }
  });

  it('ignores bright salt-and-pepper flat-field division noise on both UV254 and UV366 during asymmetric crop registration', () => {
    // Reproduces real Merck TLC Explorer uni_linint_corrected_* PNGs where UV254 has bright
    // noisy green margins on the right only (narrower aspect ~1.05) while UV366 has bright
    // noisy cyan/lavender/white margins on BOTH left & right (wider 4:3 aspect ~1.33) and a ~3% Y shift.
    const refW = 320;
    const refH = 304;
    const srcW = 416;
    const srcH = 312;

    const makeFlatFieldPlate = (
      w: number,
      h: number,
      key: 'UV254' | 'UV366' | 'White',
      px0: number,
      px1: number,
      py0: number,
      py1: number
    ): AlignRaster => {
      const data = new Uint8ClampedArray(w * h * 4);
      let seed = key === 'UV254' ? 101 : key === 'UV366' ? 211 : 307;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };
      const midY = 0.5 * (py0 + py1);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const inPlate = x >= px0 && x <= px1 && y >= py0 && y <= py1;
          const inBezel =
            !inPlate && x >= px0 - 6 && x <= px1 + 6 && y >= py0 - 10 && y <= py1 + 10;
          if (inBezel) {
            data[o] = 4;
            data[o + 1] = 5;
            data[o + 2] = 6;
          } else if (!inPlate) {
            // High-frequency salt-and-pepper flat-field division noise outside bezel
            if (key === 'UV254') {
              data[o] = Math.round(45 + rand() * 120);
              data[o + 1] = Math.round(160 + rand() * 95);
              data[o + 2] = Math.round(45 + rand() * 120);
            } else if (key === 'UV366') {
              data[o] = Math.round(90 + rand() * 165);
              data[o + 1] = Math.round(160 + rand() * 95);
              data[o + 2] = Math.round(230 + rand() * 25);
            } else {
              const n = Math.round(180 + rand() * 75);
              data[o] = n;
              data[o + 1] = n;
              data[o + 2] = n;
            }
          } else {
            const inGap = Math.abs(y - midY) < 7;
            if (key === 'UV254') {
              data[o] = 5;
              data[o + 1] = inGap ? 140 : 245;
              data[o + 2] = 6;
            } else if (key === 'UV366') {
              data[o] = 18;
              data[o + 1] = inGap ? 90 : 145;
              data[o + 2] = inGap ? 175 : 230;
            } else {
              const v = inGap ? 175 : 235;
              data[o] = v;
              data[o + 1] = v;
              data[o + 2] = v - 4;
            }
          }
          data[o + 3] = 255;
        }
      }
      // Draw 26 origin dots top & bottom
      for (let i = 0; i < 26; i++) {
        const cx = px0 + 14 + (i / 25) * (px1 - px0 - 28);
        for (const cy of [py0 + 12, py1 - 12]) {
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              if (dx * dx + dy * dy > 9) continue;
              const x = Math.round(cx + dx);
              const y = Math.round(cy + dy);
              if (x < 0 || x >= w || y < 0 || y >= h) continue;
              const o = (y * w + x) * 4;
              if (key === 'UV254') {
                data[o] = 6;
                data[o + 1] = 35;
                data[o + 2] = 6;
              } else if (key === 'UV366') {
                data[o] = 225;
                data[o + 1] = 250;
                data[o + 2] = 255;
              } else {
                data[o] = 140;
                data[o + 1] = 132;
                data[o + 2] = 125;
              }
            }
          }
        }
      }
      return { data, width: w, height: h };
    };

    // UV254: plate at x=8..288 (w=280, almost zero left margin, green noise on right), y=12..282 (h=270)
    const ref254 = makeFlatFieldPlate(refW, refH, 'UV254', 8, 288, 12, 282);
    // UV366: plate at x=72..352 (w=280, wide noisy margins on BOTH left & right!), y=24..294 (h=270, +12px down)
    const src366 = makeFlatFieldPlate(srcW, srcH, 'UV366', 72, 352, 24, 294);
    const srcWhite = makeFlatFieldPlate(srcW, srcH, 'White', 72, 352, 24, 294);

    for (const [key, src] of [
      ['UV366', src366],
      ['White', srcWhite],
    ] as const) {
      const align = estimateChannelAlignment(ref254, 'UV254', src, key);
      expect(align.confidence).toBeGreaterThan(0.6);

      // Verify all 4 plate edges map accurately into UV254's coordinate space (within ~1.5%)
      const leftMapped = (align.dx + (72 / srcW) * align.sx) * refW;
      const rightMapped = (align.dx + (352 / srcW) * align.sx) * refW;
      const topMapped = (align.dy + (24 / srcH) * align.sy) * refH;
      const botMapped = (align.dy + (294 / srcH) * align.sy) * refH;

      expect(Math.abs(leftMapped - 8)).toBeLessThan(5);
      expect(Math.abs(rightMapped - 288)).toBeLessThan(5);
      expect(Math.abs(topMapped - 12)).toBeLessThan(5);
      expect(Math.abs(botMapped - 282)).toBeLessThan(5);
    }
  });
});

