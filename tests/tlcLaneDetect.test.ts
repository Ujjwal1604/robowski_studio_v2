import { describe, it, expect } from 'vitest';
import { detectLaneRows, laneConfigFromDetection, findPlateExtent, LANES_PER_HALF } from '../src/engine/tlcLaneDetect';
import { LANE_FRAME_WIDTH } from '../src/engine/tlcLanes';

// Synthetic plate: green background with dark dots (UV 254), or dark background with bright dots (UV 366).
function plate(
  opt: {
    w?: number;
    tiltDeg?: number;
    missing?: number[];
    missingLower?: number[];
    missingUpper?: number[];
    noise?: number;
    offset?: number;
    yLower?: number;
    yUpper?: number;
    uv366?: boolean;
    /** dark background outside a plate that spans x = 480..2783 (3280 frame) */
    border?: boolean;
    /** dot-like artefacts next to the plate edge (what a dark/bright edge looks like to a blob filter) */
    edgeGhosts?: boolean;
  } = {}
) {
  const w = opt.w ?? 1640;
  const h = Math.round((w * 2464) / 3280);
  const s = w / 3280;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < w * h; i++) {
    const n = (rnd() - 0.5) * (opt.noise ?? 6);
    if (opt.uv366) {
      data[i * 4] = Math.max(0, 14 + n);
      data[i * 4 + 1] = Math.max(0, 12 + n);
      data[i * 4 + 2] = Math.max(0, 30 + n);
    } else {
      data[i * 4] = Math.max(0, 20 + n);
      data[i * 4 + 1] = Math.max(0, 170 + n);
      data[i * 4 + 2] = Math.max(0, 20 + n);
    }
    data[i * 4 + 3] = 255;
  }
  if (opt.border) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (x < 480 * s || x > 2783 * s) {
          const o = (y * w + x) * 4;
          data[o] = data[o + 2] = 4;
          data[o + 1] = 5;
        }
      }
  }
  const dot = (cx: number, cy: number, r: number, depth: number) => {
    const R = Math.ceil(r * 3);
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
        const k = depth * Math.exp(-d2 / 2);
        const o = (y * w + x) * 4;
        if (opt.uv366) {
          data[o + 1] = Math.min(255, data[o + 1] + k);
          data[o + 2] = Math.min(255, data[o + 2] + k * 1.15);
        } else {
          data[o + 1] = Math.max(0, data[o + 1] - k);
        }
      }
  };
  const t = Math.tan(((opt.tiltDeg ?? 0.4) * Math.PI) / 180);
  const pitch = 75.2 * s;
  const ghostsFor = (half: 'lower' | 'upper', y: number) => {
    if (!opt.edgeGhosts) return;
    const cy0 = y * s;
    dot(480 * s + 0.5 * pitch, cy0, 9 * s, 100); // right on the edge, upper and lower
    if (half === 'lower') dot(480 * s + 1.55 * pitch, cy0, 9 * s, 55); // a faint one 1.5 pitches in
  };
  const x0 = 660 * s + (opt.offset ?? 0) * s;
  const truth: Record<string, { x0: number; y0: number }> = {};
  for (const [half, y] of [
    ['lower', opt.yLower ?? 2222],
    ['upper', opt.yUpper ?? 356],
  ] as const) {
    truth[half] = { x0, y0: y * s };
    ghostsFor(half, y);
    const skip = new Set([
      ...(opt.missing ?? []),
      ...(half === 'lower' ? opt.missingLower ?? [] : opt.missingUpper ?? []),
    ]);
    for (let i = 0; i < LANES_PER_HALF; i++) {
      if (skip.has(i)) continue;
      const cx = x0 + i * pitch;
      const cy = y * s + t * (cx - x0);
      dot(cx, cy, 9 * s, opt.uv366 ? 130 : 110);
      // streak spots above/below with different strengths
      const dir = half === 'lower' ? -1 : 1;
      for (const [off, dep] of [
        [260, 70],
        [420, 40],
      ]) {
        dot(cx + (rnd() - 0.5) * 6, cy + dir * off * s, 12 * s, dep * (0.5 + rnd()));
      }
    }
  }
  return { img: { data, width: w, height: h }, truth, pitch, s };
}

describe('detectLaneRows', () => {
  it('finds both dot rows, spacing and tilt on a clean plate', () => {
    const { img, truth, pitch } = plate();
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(det.lower && det.upper).toBeTruthy();
    for (const half of ['lower', 'upper'] as const) {
      const r = det[half]!;
      expect(r.seen).toBeGreaterThanOrEqual(24);
      expect(Math.abs(r.pitch / k - pitch)).toBeLessThan(0.01 * pitch);
      expect(Math.abs(r.x0 / k - truth[half].x0)).toBeLessThan(0.1 * pitch);
      expect(Math.abs(r.y0 / k - truth[half].y0)).toBeLessThan(0.15 * pitch);
      expect(Math.abs(r.angleDeg - 0.4)).toBeLessThan(0.25);
    }
  });

  it('still places every lane when many dots are missing', () => {
    const missing = [0, 1, 2, 5, 9, 13, 14, 20, 26];
    const { img, truth, pitch } = plate({ missing });
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(det.lower!.seen).toBeLessThanOrEqual(LANES_PER_HALF - missing.length + 1);
    expect(Math.abs(det.lower!.x0 / k - truth.lower.x0)).toBeLessThan(0.15 * pitch);
  });

  it('keeps both halves aligned without a 1-column shift when lane 0 is a blank on one half', () => {
    // Plate sits 0.4 pitches right of center and lane 0 on the lower half has no dot.
    const { img, truth, pitch } = plate({ offset: 30, missingLower: [0] });
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(det.lower && det.upper).toBeTruthy();
    expect(Math.abs(det.lower!.x0 / k - truth.lower.x0)).toBeLessThan(0.2 * pitch);
    expect(Math.abs(det.upper!.x0 / k - truth.upper.x0)).toBeLessThan(0.2 * pitch);
    expect(Math.abs(det.lower!.x0 - det.upper!.x0)).toBeLessThan(0.25 * det.lower!.pitch);
  });

  it('detects bright-on-dark dots in UV 366 images', () => {
    const { img, truth, pitch } = plate({ uv366: true });
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(det.lower && det.upper).toBeTruthy();
    expect(Math.abs(det.lower!.x0 / k - truth.lower.x0)).toBeLessThan(0.15 * pitch);
  });

  it('scales blur sigma properly when a smaller workWidth is requested', () => {
    const { img, truth, pitch } = plate({ w: 960 });
    const det = detectLaneRows(img, 800);
    const k = det.workWidth / img.width;
    expect(det.workWidth).toBe(800);
    expect(det.ok).toBe(true);
    expect(Math.abs(det.lower!.x0 / k - truth.lower.x0)).toBeLessThan(0.15 * pitch);
  });

  it('copes with the whole column set sitting one pitch off the usual place', () => {
    const { img, pitch } = plate({ offset: 75.2 });
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.lower!.seen).toBeGreaterThanOrEqual(26);
    expect(Math.abs(det.lower!.x0 / k - 660 * (img.width / 3280) - pitch)).toBeLessThan(0.25 * pitch);
  });

  it('ignores a single stray border dot outside column 26 when column 0 is faint/missing', () => {
    const { img, truth, pitch } = plate({ missingLower: [0] });
    const s = img.width / 3280;
    const cx = 660 * s + 27 * pitch;
    const cy = 2222 * s + Math.tan((0.4 * Math.PI) / 180) * (cx - 660 * s);
    const r = 9 * s;
    const R = Math.ceil(r * 3);
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(img.height, cy + R); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(img.width, cx + R); x++) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
        const drop = 120 * Math.exp(-d2 / 2);
        const o = (y * img.width + x) * 4;
        img.data[o + 1] = Math.max(0, img.data[o + 1] - drop);
      }
    }
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(Math.abs(det.lower!.x0 / k - truth.lower.x0)).toBeLessThan(0.2 * pitch);
    expect(Math.abs(det.upper!.x0 / k - truth.upper.x0)).toBeLessThan(0.2 * pitch);
  });

  it('prefers the origin row height over a dense horizontal row of developed spots', () => {
    const { img, truth, pitch } = plate({ missing: [3, 18] });
    const s = img.width / 3280;
    const t = Math.tan((0.4 * Math.PI) / 180);
    // Inject a full 27-dot aligned spot row inside the plate at y = 1850 (~0.75 * h)
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = 660 * s + i * pitch;
      const cy = 1850 * s + t * (cx - 660 * s);
      const r = 10 * s;
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(img.height, cy + R); y++) {
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(img.width, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const drop = 135 * Math.exp(-d2 / 2);
          const o = (y * img.width + x) * 4;
          img.data[o + 1] = Math.max(0, img.data[o + 1] - drop);
        }
      }
    }
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(Math.abs(det.lower!.y0 / k - truth.lower.y0)).toBeLessThan(0.2 * pitch);
  });

  it('returns lanes with a check-by-eye warning when framing sits outside the usual band', () => {
    const { img } = plate({ yLower: 1960 });
    const det = detectLaneRows(img);
    expect(det.lower).toBeTruthy();
    expect(det.warnings.some((w) => /check/i.test(w))).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    expect(cfg.lanes).toHaveLength(54);
  });

  it('reports failure on an empty plate rather than inventing lanes', () => {
    const w = 1200;
    const h = 900;
    const data = new Uint8ClampedArray(w * h * 4).fill(120);
    const det = detectLaneRows({ data, width: w, height: h });
    expect(det.ok).toBe(false);
  });

  it('keeps the lower origin row centered on the dots even when a dark plate border sits right below them', () => {
    const { img, truth, pitch, s } = plate({ yLower: 2222 });
    // Paint a dark black plate holder/border right below the origin dots (~42 px below dot centers at 3280 scale)
    const borderStart = Math.round(2264 * s);
    for (let y = borderStart; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        img.data[o] = 8;
        img.data[o + 1] = 12;
        img.data[o + 2] = 8;
      }
    }
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    expect(det.ok).toBe(true);
    expect(det.lower).toBeTruthy();
    // Should stay tightly centered on the origin dots rather than shifting downward toward the dark border
    expect(Math.abs(det.lower!.y0 / k - truth.lower.y0)).toBeLessThan(0.08 * pitch);
  });

  it('finds sparse outer origin dots on a negatively tilted plate instead of a denser tilted spot band inward', () => {
    const w = 1300;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 8;
      data[i * 4 + 1] = 10;
      data[i * 4 + 2] = 8;
      data[i * 4 + 3] = 255;
    }
    const tilt = Math.tan((-0.9 * Math.PI) / 180);
    // Physical plate spans x = 480..2783, y = 140..2324 (tilted -0.9°)
    for (let y = 0; y < h; y++) {
      for (let x = Math.round(480 * s); x <= Math.round(2783 * s); x++) {
        const ty = (140 + tilt * (x / s - 1640)) * s;
        const by = (2324 + tilt * (x / s - 1640)) * s;
        if (y >= ty && y <= by) {
          const o = (y * w + x) * 4;
          data[o] = 10;
          data[o + 1] = 220;
          data[o + 2] = 10;
        }
      }
    }
    const dot = (cx: number, cy: number, r: number, depth: number) => {
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - depth * Math.exp(-d2 / 2));
        }
    };

    const x0 = 660 * s;
    // Upper origin sits ~1.5 pitches (112 frame px) below top edge, with only 11 visible dots
    const upperOrigCols = [1, 3, 4, 7, 9, 10, 11, 15, 16, 21, 22];
    const yUp = 252 * s;
    for (const i of upperOrigCols) {
      const cx = x0 + i * pitch;
      const cy = yUp + tilt * (cx - x0);
      dot(cx, cy, 8.5 * s, 160);
    }
    // Dense developed spot band 3 pitches further inward along a misleading +2.4° diagonal (20 spots)
    const spotSlope = Math.tan((2.4 * Math.PI) / 180);
    for (let i = 0; i < LANES_PER_HALF; i++) {
      if (i === 1 || i === 2 || i === 7 || i === 12 || i === 17 || i === 23 || i === 24) continue;
      const cx = x0 + i * pitch;
      const cy = 480 * s + spotSlope * (cx - w / 2);
      dot(cx, cy, 11 * s, 120);
    }
    // Lower origin at 2212 frame px with 18 dots parallel to plate (-0.9°)
    const yLo = 2212 * s;
    for (let i = 0; i < LANES_PER_HALF; i++) {
      if (i % 3 === 2) continue;
      const cx = x0 + i * pitch;
      const cy = yLo + tilt * (cx - x0);
      dot(cx, cy, 8.5 * s, 150);
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    const k = det.workWidth / w;
    expect(det.ok).toBe(true);
    expect(det.upper && det.lower).toBeTruthy();
    expect(Math.abs(det.upper!.y0 / k - yUp)).toBeLessThan(0.25 * pitch);
    expect(Math.abs(det.upper!.angleDeg - -0.9)).toBeLessThan(0.9);
    expect(Math.abs(det.lower!.x0 - det.upper!.x0)).toBeLessThan(0.25 * det.upper!.pitch);
  });

  it('detects lanes on a tightly cropped plate where the plate fills >90% of the image width', () => {
    const w = 1000;
    const h = 800;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 6;
      data[i * 4 + 1] = 8;
      data[i * 4 + 2] = 6;
      data[i * 4 + 3] = 255;
    }
    const xl = 30;
    const xr = 960;
    const plateW = xr - xl;
    const pitch = 0.0318 * plateW; // ~29.6 px => 0.0296 * w
    const tilt = Math.tan((-0.8 * Math.PI) / 180);
    for (let y = 0; y < h; y++) {
      for (let x = xl; x <= xr; x++) {
        const ty = 15 + tilt * (x - w / 2);
        const by = 785 + tilt * (x - w / 2);
        if (y >= ty && y <= by) {
          const o = (y * w + x) * 4;
          data[o] = 8;
          data[o + 1] = 225;
          data[o + 2] = 8;
        }
      }
    }
    const dot = (cx: number, cy: number, r: number, depth: number) => {
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - depth * Math.exp(-d2 / 2));
        }
    };
    const x0 = xl + 2.4 * pitch;
    const yUp = 15 + 1.5 * pitch;
    const yLo = 785 - 1.5 * pitch;
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      if (i % 2 === 0 || i % 6 === 3) dot(cx, yUp + tilt * (cx - w / 2), 0.14 * pitch, 160);
      dot(cx, yUp + 4.3 * pitch + 0.04 * (cx - w / 2), 0.18 * pitch, 120); // inner +2.3° spot band
      if (i % 3 !== 1) dot(cx, yLo + tilt * (cx - w / 2), 0.14 * pitch, 150);
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    expect(det.upper && det.lower).toBeTruthy();
    expect(Math.abs(det.upper!.pitch - pitch)).toBeLessThan(0.03 * pitch);
    expect(Math.abs(det.upper!.y0 - (yUp + tilt * (x0 - w / 2)))).toBeLessThan(0.3 * pitch);
  });

  it('detects narrow ~2% left/right borders and locks true cropped pitch when upper origin sits ~4.3 pitches inward', () => {
    const w = 1000;
    const h = 680;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 4;
      data[i * 4 + 1] = 8;
      data[i * 4 + 2] = 4;
      data[i * 4 + 3] = 255;
    }
    const xl = 20; // 2% left border
    const xr = 978; // 2.1% right border
    const plateW = xr - xl;
    const pitch = 0.0318 * plateW; // ~30.46 px (risking 3/4 subharmonic ~22.8 px without cropped pass)
    const tilt = Math.tan((-0.9 * Math.PI) / 180);
    const tyAt = (x: number) => 12 + tilt * (x - w / 2);
    const byAt = (x: number) => 664 + tilt * (x - w / 2);
    for (let y = 0; y < h; y++) {
      for (let x = xl; x <= xr; x++) {
        if (y >= tyAt(x) && y <= byAt(x)) {
          const o = (y * w + x) * 4;
          data[o] = 10;
          data[o + 1] = 228;
          data[o + 2] = 12;
        }
      }
    }
    const gCh = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) gCh[i] = data[i * 4 + 1];
    const extent = findPlateExtent([gCh, gCh, gCh], w, h);
    expect(extent.found).toBe(true);
    expect(Math.abs(extent.xl - xl)).toBeLessThanOrEqual(4);
    expect(Math.abs(extent.xr - xr)).toBeLessThanOrEqual(4);

    const dot = (cx: number, cy: number, r: number, depth: number) => {
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - depth * Math.exp(-d2 / 2));
        }
    };
    const x0 = xl + 2.1 * pitch;
    const yUp = 12 + 4.3 * pitch; // ~4.3 pitches inward from top edge
    const yLo = 664 - 1.6 * pitch;
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      if (i % 3 !== 2) dot(cx, yUp + tilt * (cx - w / 2), 0.14 * pitch, 155);
      if (i % 2 === 0 || i % 5 === 1) dot(cx, yLo + tilt * (cx - w / 2), 0.14 * pitch, 150);
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    expect(det.upper && det.lower).toBeTruthy();
    expect(Math.abs(det.upper!.pitch - pitch)).toBeLessThan(0.03 * pitch);
    expect(Math.abs(det.upper!.y0 - (yUp + tilt * (x0 - w / 2)))).toBeLessThan(0.3 * pitch);
  });
});

describe('laneConfigFromDetection', () => {
  it('builds 54 lanes with the lower half running up and the upper half running down', () => {
    const { img } = plate();
    const det = detectLaneRows(img);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    expect(cfg.lanes).toHaveLength(54);
    expect(cfg.hasZeroRf).toBe(true);
    const lo = cfg.lanes.filter((l) => l.id < 27);
    const up = cfg.lanes.filter((l) => l.id >= 27);
    for (const l of lo) expect(Math.abs(l.angle)).toBeLessThan(2);
    for (const l of up) expect(Math.abs(l.angle - 180)).toBeLessThan(2);
    const l0 = lo[0];
    const a = (l0.angle * Math.PI) / 180;
    const dotX = l0.x0 + Math.sin(a) * l0.zeroRf!;
    const dotY = l0.y0 - Math.cos(a) * l0.zeroRf!;
    expect(Math.abs(dotX - 660)).toBeLessThan(12);
    expect(Math.abs(dotY - 2222)).toBeLessThan(14);
    expect(Math.abs(lo[1].x0 - lo[0].x0 - 75.2)).toBeLessThan(3);
    const l27 = up[0];
    const a2 = (l27.angle * Math.PI) / 180;
    expect(Math.abs(l27.y0 - Math.cos(a2) * l27.zeroRf! - 356)).toBeLessThan(14);
  });

  it('scales to the frame width', () => {
    const { img } = plate();
    const det = detectLaneRows(img);
    const a = laneConfigFromDetection(det, 3280);
    const b = laneConfigFromDetection(det, 1640);
    expect(b.lanes[5].x0).toBeCloseTo(a.lanes[5].x0 / 2, 0);
    expect(b.lanes[5].width).toBeLessThan(a.lanes[5].width);
  });

  it('tracks gently bowed origin rows across all 27 lanes via per-lane baseline offsets', () => {
    const w = 1640;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const bowFrame = 15; // outer lanes sit ~15 frame px higher (smaller y) than center
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 19;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < w * h; i++) {
      const n = (rnd() - 0.5) * 5;
      data[i * 4] = 20 + n;
      data[i * 4 + 1] = 172 + n;
      data[i * 4 + 2] = 20 + n;
      data[i * 4 + 3] = 255;
    }
    const dot = (cx: number, cy: number, r: number, depth: number) => {
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const k = depth * Math.exp(-d2 / 2);
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - k);
        }
    };
    const expectedLowerY: number[] = [];
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const u = (i - 13) / 13;
      const cx = x0 + i * pitch;
      const cyFrame = 2222 - bowFrame * u * u;
      expectedLowerY.push(cyFrame);
      dot(cx, cyFrame * s, 9 * s, 115);
      dot(cx, 356 * s, 9 * s, 115);
    }
    // Dark bottom plate border below the origin dots
    const borderStart = Math.round(2265 * s);
    for (let y = borderStart; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        data[o] = 10;
        data[o + 1] = 14;
        data[o + 2] = 10;
      }
    }

    const det = detectLaneRows({ data, width: w, height: h });
    expect(det.ok).toBe(true);
    expect(det.lower?.yOffsets).toBeDefined();

    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    for (const idx of [0, 13, 26]) {
      const lane = cfg.lanes[idx];
      const a = (lane.angle * Math.PI) / 180;
      const dotY = lane.y0 - Math.cos(a) * lane.zeroRf!;
      expect(Math.abs(dotY - expectedLowerY[idx])).toBeLessThan(0.1 * 75.2);
    }
  });

  it('tracks irregular per-lane experimental spotting height error rather than forcing a single straight or smooth line', () => {
    const w = 1640;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 43;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < w * h; i++) {
      const n = (rnd() - 0.5) * 5;
      data[i * 4] = 20 + n;
      data[i * 4 + 1] = 172 + n;
      data[i * 4 + 2] = 20 + n;
      data[i * 4 + 3] = 255;
    }
    const dot = (cx: number, cy: number, r: number, depth: number) => {
      const R = Math.ceil(r * 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++)
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
          const k = depth * Math.exp(-d2 / 2);
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - k);
        }
    };
    // Individual lanes vary irregularly (+12, -10, +14, stepped middle, blank lane 8)
    const jitter = [10, 0, -8, 6, -4, 12, 0, -10, 0, 8, -6, 14, 10, -8, 12, 0, -6, 4, 10, -10, 8, -4, 12, -8, 6, 10, 0];
    const expectedY = jitter.map((j) => 2222 - j);
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      if (i !== 8) {
        dot(cx, expectedY[i] * s, 9 * s, 115);
      }
      dot(cx, 356 * s, 9 * s, 115);
    }

    const det = detectLaneRows({ data, width: w, height: h });
    expect(det.ok).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    for (const idx of [0, 5, 11, 14, 19, 22]) {
      const lane = cfg.lanes[idx];
      const a = (lane.angle * Math.PI) / 180;
      const dotY = lane.y0 - Math.cos(a) * lane.zeroRf!;
      expect(Math.abs(dotY - expectedY[idx])).toBeLessThan(4.5);
    }
  });

  it('centers accurately on saturated flat-core and tall upward-smearing origin dots', () => {
    const w = 1300;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 20;
      data[i * 4 + 1] = 185;
      data[i * 4 + 2] = 20;
      data[i * 4 + 3] = 255;
    }
    const trueY: number[] = [];
    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      const cyFrame = 2222 + (i % 4 === 0 ? -10 : i % 4 === 2 ? 10 : 0);
      trueY.push(cyFrame);
      const cy = cyFrame * s;
      const rx = (i % 2 === 0 ? 18 : 14) * s;
      const ry = (i % 2 === 0 ? 22 : 16) * s;
      for (let y = Math.floor(cy - 60 * s); y <= Math.ceil(cy + 35 * s); y++) {
        for (let x = Math.floor(cx - 30 * s); x <= Math.ceil(cx + 30 * s); x++) {
          if (y < 0 || y >= h || x < 0 || x >= w) continue;
          const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
          const t = (d - 0.6) / 0.35;
          let darkness = d < 0.6 ? 165 : d < 1.3 ? 165 * Math.exp(-(t * t)) : 0;
          if (i % 2 === 0 && y < cy) {
            const dx = (x - cx) / (11 * s);
            const dt = (cy - y) / (30 * s);
            darkness = Math.max(darkness, 110 * Math.exp(-(dx * dx)) * Math.exp(-dt));
          }
          data[(y * w + x) * 4 + 1] = Math.max(15, 185 - darkness);
        }
      }
      const cyU = 356 * s;
      for (let y = Math.floor(cyU - 25 * s); y <= Math.ceil(cyU + 25 * s); y++)
        for (let x = Math.floor(cx - 20 * s); x <= Math.ceil(cx + 20 * s); x++) {
          const d2 = ((x - cx) * (x - cx) + (y - cyU) * (y - cyU)) / (9 * s * (9 * s));
          data[(y * w + x) * 4 + 1] = Math.max(15, data[(y * w + x) * 4 + 1] - 130 * Math.exp(-d2 / 2));
        }
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    for (let i = 0; i < 12; i++) {
      const l = cfg.lanes[i];
      const a = (l.angle * Math.PI) / 180;
      const dotY = l.y0 - Math.cos(a) * l.zeroRf!;
      expect(Math.abs(dotY - trueY[i])).toBeLessThan(2.0);
    }
  });

  it('does not mistake the plate edge for origin dots when the outer dots are faint', () => {
    const { img, truth } = plate({ border: true, edgeGhosts: true, missing: [0, 1, 2, 4, 6, 7, 8, 9, 13, 14, 15, 17, 18, 19, 20, 21, 24, 25, 26] }) as any;
    const det = detectLaneRows(img);
    const k = det.workWidth / img.width;
    const pitch = 75.2 * (img.width / 3280);
    for (const half of ['lower', 'upper'] as const) {
      const row = det[half]!;
      expect(Math.abs(row.x0 / k - truth[half].x0)).toBeLessThan(0.25 * pitch);
    }
  });

  it('keeps missing-origin lanes smoothly on the plate baseline without zig-zagging toward faint smears', () => {
    const w = 1300;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 16;
      data[i * 4 + 1] = 225;
      data[i * 4 + 2] = 16;
      data[i * 4 + 3] = 255;
    }
    const dot = (cx: number, cy: number, rx: number, ry: number, depth: number) => {
      const Rx = Math.ceil(rx * 3);
      const Ry = Math.ceil(ry * 3);
      for (let y = Math.max(0, Math.floor(cy - Ry)); y < Math.min(h, cy + Ry); y++)
        for (let x = Math.max(0, Math.floor(cx - Rx)); x < Math.min(w, cx + Rx); x++) {
          const d2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          const o = (y * w + x) * 4;
          data[o + 1] = Math.max(0, data[o + 1] - depth * Math.exp(-d2 / 2));
        }
    };

    const tilt = Math.tan((-0.5 * Math.PI) / 180);
    const sharpCols = new Set([1, 3, 4, 7, 9, 10, 11, 15, 16, 21, 22, 23]);
    const jitter = new Map<number, number>([[4, 4], [10, -4], [16, 4], [22, 5]]);
    const trueBaseUp = (i: number) => 270 + (tilt * (x0 + i * pitch - w / 2)) / s;
    const missingWithSmear = new Set([0, 2, 13, 25]);

    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      const baseY = trueBaseUp(i) * s;
      if (sharpCols.has(i)) {
        const j = (jitter.get(i) ?? 0) * s;
        dot(cx, baseY + j, 9 * s, 9 * s, i === 7 || i === 11 ? 58 : 145);
      } else if (missingWithSmear.has(i)) {
        // Faint smear/noise 16-24 frame px inward without a sharp origin dot
        dot(cx, baseY + 20 * s, 11 * s, 14 * s, 18);
      }
      // Keep lower origin row well populated so both halves lock
      if (i % 2 === 0) dot(cx, (2210 + (tilt * (cx - w / 2)) / s) * s, 9 * s, 9 * s, 145);
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    const up = cfg.lanes.filter((l) => l.id >= 27);
    const detectedY = up.map((l) => {
      const a = (l.angle * Math.PI) / 180;
      return l.y0 - Math.cos(a) * l.zeroRf!;
    });

    // Missing lanes (especially outer edges 0, 24, 25, 26 and middle gap 12, 13, 14) stay within 5 frame px of true baseline
    for (const i of [0, 2, 5, 6, 8, 12, 13, 14, 17, 18, 19, 20, 24, 25, 26]) {
      expect(Math.abs(detectedY[i] - trueBaseUp(i))).toBeLessThan(5.0);
    }
    // No adjacent lane-to-lane zig-zag jumps across missing-spot regions
    for (const i of [12, 13, 24, 25]) {
      expect(Math.abs(detectedY[i + 1] - detectedY[i])).toBeLessThan(2.5);
    }
  });

  it('centers accurately on huge saturated origin dots while keeping alternating and trailing blanks collinear without zig-zag', () => {
    const w = 1200;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 10;
      data[i * 4 + 1] = 228;
      data[i * 4 + 2] = 18;
      data[i * 4 + 3] = 255;
    }

    const tilt = Math.tan((-0.4 * Math.PI) / 180);
    const trueBaseUp = (i: number) => 275 + (tilt * (x0 + i * pitch - w / 2)) / s;
    // Pattern modeled after plates with huge dark dots (L3, L9, L15, L21), medium/faint dots, and consecutive/alternating blanks
    const hugeCols = new Set([3, 9, 15, 21]);
    const medCols = new Set([1, 4, 10, 16, 22, 23]);
    const faintCols = new Set([7, 11]);
    const jitter = new Map<number, number>([[4, 4], [10, 3], [16, 4], [22, 4], [3, -2], [9, -2], [15, -2], [21, -2]]);

    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      const baseY = trueBaseUp(i) * s;
      const cy = baseY + (jitter.get(i) ?? 0) * s;

      if (hugeCols.has(i)) {
        // Huge flat-bottomed saturated dark dot (~50 frame px wide) plus downward elution smear
        const rx = 20 * s;
        const ry = 23 * s;
        for (let y = Math.floor(cy - 50 * s); y <= Math.ceil(cy + 75 * s); y++) {
          for (let x = Math.floor(cx - 32 * s); x <= Math.ceil(cx + 32 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
            let dark = d < 0.58 ? 175 : d < 1.3 ? 175 * Math.exp(-(((d - 0.58) / 0.36) ** 2)) : 0;
            if (y > cy) {
              const dx = (x - cx) / (12 * s);
              const dt = (y - cy) / (32 * s);
              dark = Math.max(dark, 95 * Math.exp(-(dx * dx)) * Math.exp(-dt));
            }
            data[(y * w + x) * 4 + 1] = Math.max(25, data[(y * w + x) * 4 + 1] - dark);
          }
        }
      } else if (medCols.has(i) || faintCols.has(i)) {
        const depth = faintCols.has(i) ? 55 : 120;
        const rx = 12 * s;
        const ry = 13 * s;
        for (let y = Math.floor(cy - 36 * s); y <= Math.ceil(cy + 36 * s); y++) {
          for (let x = Math.floor(cx - 26 * s); x <= Math.ceil(cx + 26 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
            data[(y * w + x) * 4 + 1] = Math.max(25, data[(y * w + x) * 4 + 1] - depth * Math.exp(-d2 / 2));
          }
        }
      }

      // Lower origin row populated for plate lock
      if (i % 3 !== 1) {
        const cyL = (2215 + (tilt * (cx - w / 2)) / s) * s;
        for (let y = Math.floor(cyL - 25 * s); y <= Math.ceil(cyL + 25 * s); y++) {
          for (let x = Math.floor(cx - 25 * s); x <= Math.ceil(cx + 25 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d2 = ((x - cx) ** 2 + (y - cyL) ** 2) / (9 * s * (9 * s));
            data[(y * w + x) * 4 + 1] = Math.max(20, data[(y * w + x) * 4 + 1] - 140 * Math.exp(-d2 / 2));
          }
        }
      }
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    const up = cfg.lanes.filter((l) => l.id >= 27);
    const detectedY = up.map((l) => {
      const a = (l.angle * Math.PI) / 180;
      return l.y0 - Math.cos(a) * l.zeroRf!;
    });

    // Huge dots (L3, L9, L15, L21) must not be ignored or rim-shifted
    for (const i of hugeCols) {
      const expectedY = trueBaseUp(i) + (jitter.get(i) ?? 0);
      expect(Math.abs(detectedY[i] - expectedY)).toBeLessThan(5.0);
    }

    // Blank lanes stay smoothly aligned with the tilted plate baseline (no alternating/edge zig-zag)
    const blankCols = [0, 2, 5, 6, 8, 12, 13, 14, 17, 18, 19, 20, 24, 25, 26];
    for (const i of blankCols) {
      expect(Math.abs(detectedY[i] - trueBaseUp(i))).toBeLessThan(4.0);
    }
    for (let k = 0; k < blankCols.length - 1; k++) {
      const a = blankCols[k];
      const b = blankCols[k + 1];
      if (b === a + 1) {
        expect(Math.abs(detectedY[b] - detectedY[a])).toBeLessThan(2.5);
      }
    }
  });

  it('prevents extended asymmetric elution smears (>0.4*pitch) and off-center saturated rims from pulling origin dots', () => {
    const w = 1300;
    const h = Math.round((w * 2464) / 3280);
    const s = w / 3280;
    const pitch = 75.2 * s;
    const x0 = 660 * s;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 8;
      data[i * 4 + 1] = 232;
      data[i * 4 + 2] = 16;
      data[i * 4 + 3] = 255;
    }

    const tilt = Math.tan((-0.5 * Math.PI) / 180);
    const baseUp = (i: number) => 330 + (tilt * (x0 + i * pitch - w / 2)) / s;
    const smearCols = new Set([4, 10, 16, 22]);
    const hugeCols = new Set([3, 9, 15, 21]);
    const cleanCols = new Set([1, 7, 11, 23]);
    const smearJitter = new Map<number, number>([[4, 6], [10, -5], [16, 6], [22, 5]]);

    for (let i = 0; i < LANES_PER_HALF; i++) {
      const cx = x0 + i * pitch;
      const cy = (baseUp(i) + (smearJitter.get(i) ?? 0)) * s;
      if (smearCols.has(i)) {
        // Upper dot with heavy downward elution tail extending >0.7*pitch inward
        const rx = 11 * s;
        const ry = 10 * s;
        for (let y = Math.floor(cy - 30 * s); y <= Math.ceil(cy + 80 * s); y++) {
          for (let x = Math.floor(cx - 26 * s); x <= Math.ceil(cx + 26 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
            let dark = 135 * Math.exp(-d2 / 2);
            if (y > cy) {
              const tail = 105 * Math.exp(-(((x - cx) / (9 * s)) ** 2)) * Math.exp(-(y - cy) / (42 * s));
              dark = Math.max(dark, tail);
            }
            data[(y * w + x) * 4 + 1] = Math.max(20, data[(y * w + x) * 4 + 1] - dark);
          }
        }
      } else if (hugeCols.has(i)) {
        const rx = 20 * s;
        const ry = 22 * s;
        for (let y = Math.floor(cy - 50 * s); y <= Math.ceil(cy + 65 * s); y++) {
          for (let x = Math.floor(cx - 34 * s); x <= Math.ceil(cx + 34 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
            let dark = d < 0.62 ? 185 : d < 1.3 ? 185 * Math.exp(-(((d - 0.62) / 0.34) ** 2)) : 0;
            if (y > cy) dark = Math.max(dark, 90 * Math.exp(-(((x - cx) / (11 * s)) ** 2)) * Math.exp(-(y - cy) / (30 * s)));
            data[(y * w + x) * 4 + 1] = Math.max(18, data[(y * w + x) * 4 + 1] - dark);
          }
        }
      } else if (cleanCols.has(i)) {
        const depth = i === 7 || i === 11 ? 60 : 120;
        for (let y = Math.floor(cy - 30 * s); y <= Math.ceil(cy + 30 * s); y++) {
          for (let x = Math.floor(cx - 24 * s); x <= Math.ceil(cx + 24 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d2 = ((x - cx) / (10 * s)) ** 2 + ((y - cy) / (10 * s)) ** 2;
            data[(y * w + x) * 4 + 1] = Math.max(20, data[(y * w + x) * 4 + 1] - depth * Math.exp(-d2 / 2));
          }
        }
      }
      // Clean lower origin dots
      if (i % 3 !== 1) {
        const cyL = (2210 + (tilt * (cx - w / 2)) / s) * s;
        for (let y = Math.floor(cyL - 25 * s); y <= Math.ceil(cyL + 25 * s); y++) {
          for (let x = Math.floor(cx - 25 * s); x <= Math.ceil(cx + 25 * s); x++) {
            if (y < 0 || y >= h || x < 0 || x >= w) continue;
            const d2 = ((x - cx) ** 2 + (y - cyL) ** 2) / (9 * s * (9 * s));
            data[(y * w + x) * 4 + 1] = Math.max(20, data[(y * w + x) * 4 + 1] - 140 * Math.exp(-d2 / 2));
          }
        }
      }
    }

    const det = detectLaneRows({ data, width: w, height: h }, w);
    expect(det.ok).toBe(true);
    const cfg = laneConfigFromDetection(det, LANE_FRAME_WIDTH);
    const up = cfg.lanes.filter((l) => l.id >= 27);
    const detectedY = up.map((l) => l.y0 - Math.cos((l.angle * Math.PI) / 180) * l.zeroRf!);

    for (const i of smearCols) {
      expect(Math.abs(detectedY[i] - (baseUp(i) + (smearJitter.get(i) ?? 0)))).toBeLessThan(3.5);
    }
    for (const i of hugeCols) {
      expect(Math.abs(detectedY[i] - baseUp(i))).toBeLessThan(3.5);
    }
    for (const i of [0, 5, 6, 12, 13, 14, 17, 18, 19, 20, 24, 25, 26]) {
      expect(Math.abs(detectedY[i] - baseUp(i))).toBeLessThan(3.0);
    }
    for (const i of [12, 13, 17, 18, 24, 25]) {
      expect(Math.abs(detectedY[i + 1] - detectedY[i])).toBeLessThan(1.5);
    }
  });
});


