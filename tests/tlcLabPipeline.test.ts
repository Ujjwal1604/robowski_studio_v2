import { describe, it, expect, afterEach } from 'vitest';
import {
  inspectLabTlcFilename,
  encodeNpyFloat32,
  parseNpyBuffer,
  npyToRgbaAndFloatRgb,
  sampleFloatRgbLaneStrip,
  enhanceWhiteLightRgba,
  computeAutomiddleOffsets,
  LAB_UNI_SCALE_FACTORS,
} from '../src/engine/tlcLabPipeline';
import {
  parseLaneConfig,
  extractLaneProfile2d,
  getLane2dMetrics,
  setAutomiddleEnabled,
  containerOfLane,
  wellLabel,
  LANE_FRAME_WIDTH,
} from '../src/engine/tlcLanes';
import type { TlcLane, TlcSet } from '../src/types';

afterEach(() => {
  setAutomiddleEnabled(false);
});

describe('Merck TLC Explorer Lab PC Pipeline Integration', () => {
  it('recognizes uni_linint_corrected, linint_corrected, and corrected_EXP filenames', () => {
    const u = inspectLabTlcFilename('uni_linint_corrected_2026-02-05_03-07-02_UV254.npy');
    expect(u.isNpy).toBe(true);
    expect(u.isPreFlatFielded).toBe(true);
    expect(u.isLinearized).toBe(true);
    expect(u.detectedChannel).toBe('UV254');
    expect(u.scaleFactor).toBe(LAB_UNI_SCALE_FACTORS.UV254);

    const l = inspectLabTlcFilename('linint_corrected_2026-02-05_03-07-02_White.png');
    expect(l.isNpy).toBe(false);
    expect(l.isPreFlatFielded).toBe(false);
    expect(l.isLinearized).toBe(true);
    expect(l.detectedChannel).toBe('White');
    expect(l.scaleFactor).toBe(2300);

    const e = inspectLabTlcFilename('corrected_2026-02-05_03-07-02_EXP750_UV366.png');
    expect(e.isUndistorted).toBe(true);
    expect(e.isLinearized).toBe(false);
    expect(e.exposureMs).toBe(750);
    expect(e.detectedChannel).toBe('UV366');
  });

  it('parses OpenCV BGR float32 .npy arrays, swaps BGR->RGB, and preserves unclipped >255 UV366 fluorescence', () => {
    const H = 16;
    const W = 20;
    const bgr = new Float32Array(H * W * 3);
    // Background radiance = 0.0002 (scaled by 60000 -> 12)
    // Bright UV366 fluorescent spot at (x=10, y=8): Blue=0.0070 (420 -> clipped in 8-bit PNG!), Green=0.0020 (120), Red=0.0005 (30)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const off = (y * W + x) * 3;
        if (x === 10 && y === 8) {
          bgr[off] = 0.007;     // OpenCV B -> RGB B
          bgr[off + 1] = 0.002; // OpenCV G -> RGB G
          bgr[off + 2] = 0.0005; // OpenCV R -> RGB R
        } else {
          bgr[off] = 0.0002;
          bgr[off + 1] = 0.0002;
          bgr[off + 2] = 0.0002;
        }
      }
    }

    const buf = encodeNpyFloat32(bgr, [H, W, 3]);
    const parsed = parseNpyBuffer(buf);
    expect(parsed.dtype).toBe('<f4');
    expect(parsed.shape).toEqual([H, W, 3]);

    const decoded = npyToRgbaAndFloatRgb(
      parsed,
      'UV366',
      'uni_linint_corrected_2026-02-05_UV366.npy',
      true
    );
    expect(decoded.scaleFactorUsed).toBe(60000);

    const idx = 8 * W + 10;
    // 8-bit display canvas clips B at 255, R=30, G=120
    expect(decoded.rgba8[idx * 4]).toBe(30);
    expect(decoded.rgba8[idx * 4 + 1]).toBe(120);
    expect(decoded.rgba8[idx * 4 + 2]).toBe(255);
    // Unclipped floatRgb keeps full 420.0 radiance!
    expect(decoded.floatRgb[idx * 3]).toBeCloseTo(30, 1);
    expect(decoded.floatRgb[idx * 3 + 1]).toBeCloseTo(120, 1);
    expect(decoded.floatRgb[idx * 3 + 2]).toBeCloseTo(420, 1);
  });

  it('auto-detects and remaps lab PC alternating Hamilton Vantage lane CSV numbering (even=A1..C5, odd=D5..F9)', () => {
    const lines = ['id,x0,y0,length,width,direction_angle,spot_radius_px,px_location_of_zero_rf'];
    for (let col = 0; col < 27; col++) {
      const x = 500 + col * 80;
      // Even ID = bottom half (A1..C5), pointing UP (angle ≈ 0°)
      lines.push(`${col * 2},${x},2200,900,56,0.2,16,140`);
      // Odd ID = top half (D5..F9), pointing DOWN (angle ≈ 180°)
      lines.push(`${col * 2 + 1},${x},200,900,56,179.8,15,145`);
    }

    const cfg = parseLaneConfig(lines.join('\n'));
    expect(cfg.lanes).toHaveLength(54);
    expect(cfg.hasZeroRf).toBe(true);
    expect(cfg.warnings.some((w) => /alternating lane numbering/i.test(w))).toBe(true);

    // Lane 0 must map to A1 (bottom half, x0=500, angle≈0°)
    expect(cfg.lanes[0].id).toBe(0);
    expect(cfg.lanes[0].x0).toBe(500);
    expect(Math.abs(cfg.lanes[0].angle)).toBeLessThan(5);
    expect(wellLabel(containerOfLane(cfg.lanes[0].id))).toBe('A1');

    // Lane 26 must map to C5 (bottom half rightmost, x0=500+26*80)
    expect(cfg.lanes[26].id).toBe(26);
    expect(cfg.lanes[26].x0).toBe(500 + 26 * 80);
    expect(wellLabel(containerOfLane(cfg.lanes[26].id))).toBe('C5');

    // Lane 27 must map to D5 (top half leftmost, x0=500, angle≈180°)
    expect(cfg.lanes[27].id).toBe(27);
    expect(cfg.lanes[27].x0).toBe(500);
    expect(Math.abs(cfg.lanes[27].angle - 180)).toBeLessThan(5);
    expect(wellLabel(containerOfLane(cfg.lanes[27].id))).toBe('D5');

    // Lane 53 must map to F9 (top half rightmost)
    expect(cfg.lanes[53].id).toBe(53);
    expect(cfg.lanes[53].x0).toBe(500 + 26 * 80);
    expect(wellLabel(containerOfLane(cfg.lanes[53].id))).toBe('F9');
  });

  it('does NOT alter standard grouped lane CSVs (0..26 bottom, 27..53 top)', () => {
    const lines = ['id,x0,y0,length,width,direction_angle'];
    for (let i = 0; i < 27; i++) lines.push(`${i},${500 + i * 80},2200,900,56,0`);
    for (let i = 0; i < 27; i++) lines.push(`${27 + i},${500 + i * 80},200,900,56,180`);

    const cfg = parseLaneConfig(lines.join('\n'));
    expect(cfg.warnings).toHaveLength(0);
    expect(cfg.lanes[0].y0).toBe(2200);
    expect(cfg.lanes[27].y0).toBe(200);
  });

  it('enhances faint colored visible-light spots while keeping white silica background clean', () => {
    const W = 80;
    const H = 80;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        // Dark tray border on outermost 4px
        if (x < 4 || x >= W - 4 || y < 4 || y >= H - 4) {
          rgba[p] = 10;
          rgba[p + 1] = 10;
          rgba[p + 2] = 10;
          rgba[p + 3] = 255;
          continue;
        }
        // Slightly cream white silica (242, 244, 236)
        let r = 242;
        let g = 244;
        let b = 236;
        // Faint yellow spot at (40, 40) radius 7: only -12 blue channel drop!
        const dist = Math.hypot(x - 40, y - 40);
        if (dist < 7) {
          b -= Math.round(12 * Math.exp(-0.5 * (dist / 4) ** 2));
          g -= Math.round(3 * Math.exp(-0.5 * (dist / 4) ** 2));
        }
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = 255;
      }
    }

    const boosted = enhanceWhiteLightRgba(rgba, W, H, { gain: 4.6, smoothRadius: 1 });
    const bgOff = (20 * W + 20) * 4;
    const spotOff = (40 * W + 40) * 4;

    // Clean silica stays bright white (~240..255)
    expect(boosted[bgOff]).toBeGreaterThan(230);
    expect(boosted[bgOff + 1]).toBeGreaterThan(230);
    expect(boosted[bgOff + 2]).toBeGreaterThan(230);

    // Faint yellow spot blue-channel contrast increases dramatically (from ~12 to >40)
    const rawDrop = rgba[bgOff + 2] - rgba[spotOff + 2];
    const boostedDrop = boosted[bgOff + 2] - boosted[spotOff + 2];
    expect(rawDrop).toBeLessThan(15);
    expect(boostedDrop).toBeGreaterThan(rawDrop * 2.5);
  });

  it('tracks a gently drifting/curving lane centerline (savgol_automiddle) and improves core spot recovery', () => {
    const W = 40;
    const L = 240;
    const center = (W - 1) / 2;
    const rgba = new Uint8ClampedArray(W * L * 4);

    // True lane trajectory gently curves to the right by +6 px as elution rises
    const trueCenter = (idx: number) => {
      if (idx < 30) return center;
      const t = (idx - 30) / (L - 30);
      return center + 6.0 * t;
    };

    const spotRows = [60, 120, 180];
    for (let y = 0; y < L; y++) {
      const idx = L - 1 - y;
      const cx = trueCenter(idx);
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        let g = 210;
        // Origin dot at idx=20 centered at lane center
        const dOrig = Math.hypot(x - center, idx - 20);
        if (dOrig < 10) g -= 140 * Math.exp(-0.5 * (dOrig / 4) ** 2);
        // Drifting reaction spots along the curved path
        for (const sr of spotRows) {
          const d = Math.hypot((x - cx) / 4.2, (idx - sr) / 7.5);
          if (d < 3.5) g -= 120 * Math.exp(-0.5 * d * d);
        }
        rgba[p] = 15;
        rgba[p + 1] = Math.max(0, Math.round(g));
        rgba[p + 2] = 15;
        rgba[p + 3] = 255;
      }
    }

    const offsets = computeAutomiddleOffsets(rgba, W, L, 'UV254', {
      originPx: 20,
      spotRadiusPx: 8,
    });

    // Anchored at origin zone
    expect(offsets[15]).toBeCloseTo(center, 2);
    // Smoothly follows the rightward curve at spot 2 (idx=120) and spot 3 (idx=180)
    expect(offsets[120]).toBeGreaterThan(center + 1.5);
    expect(offsets[180]).toBeGreaterThan(offsets[120]);
    expect(Math.abs(offsets[180] - trueCenter(180))).toBeLessThan(2.2);

    // End-to-end extractLaneProfile2d using floatRgb + automiddle
    const floatRgb = new Float32Array(W * L * 3);
    for (let i = 0; i < W * L; i++) {
      floatRgb[i * 3] = rgba[i * 4];
      floatRgb[i * 3 + 1] = rgba[i * 4 + 1];
      floatRgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const lane: TlcLane = {
      id: 0,
      x0: W / 2,
      y0: L,
      length: L,
      width: W,
      angle: 0,
      spotRadius: 8,
      zeroRf: 20,
    };
    const fakeSet: TlcSet = {
      uid: 'test_npy_set',
      name: 'Lab NPY Test',
      cfg: { lanes: [lane], hasZeroRf: true, warnings: [] },
      cfgName: 'microadjusted_lane_config.csv',
      frameW: W,
      imgs: {
        UV254: {
          name: 'uni_linint_corrected_2026-02-05_UV254.npy',
          bmp: null as any,
          preFlatFielded: true,
          linearized: true,
          floatRgb,
          floatWidth: W,
          floatHeight: L,
        },
      },
    };

    // Straight centerline misses part of the drifted top spot (idx=180)
    setAutomiddleEnabled(false);
    const straightProf = extractLaneProfile2d(fakeSet, 'UV254', lane, 0.35);

    // Curved-lane tracking centers right on the drifted spot (darker green = lower value = stronger signal)
    setAutomiddleEnabled(true);
    const curvedProf = extractLaneProfile2d(fakeSet, 'UV254', lane, 0.35);
    const metrics = getLane2dMetrics(fakeSet, 'UV254', lane, 0.35);

    expect(curvedProf[180]).toBeLessThan(straightProf[180] - 25);
    expect(metrics?.automiddleOffsets).toBeDefined();
    expect(metrics!.automiddleOffsets![180]).toBeGreaterThan(2.0);

    // Also verify sampleFloatRgbLaneStrip preserves unclipped >255 values along a vertical lane
    const hiFloat = new Float32Array(W * L * 3);
    hiFloat[(10 * W + Math.floor(W / 2)) * 3 + 2] = 480;
    const strip = sampleFloatRgbLaneStrip(hiFloat, W, L, lane, 1, W, L);
    const sampledVal = strip[(10 * W + Math.floor(W / 2)) * 4 + 2];
    expect(sampledVal).toBeGreaterThan(400);
    expect(LANE_FRAME_WIDTH).toBe(3280);
  });
});
