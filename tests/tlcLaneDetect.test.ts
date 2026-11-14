import { describe, it, expect } from 'vitest';
import { detectLaneRows, laneConfigFromDetection, LANES_PER_HALF } from '../src/engine/tlcLaneDetect';
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
  const x0 = 660 * s + (opt.offset ?? 0) * s;
  const truth: Record<string, { x0: number; y0: number }> = {};
  for (const [half, y] of [
    ['lower', opt.yLower ?? 2222],
    ['upper', opt.yUpper ?? 356],
  ] as const) {
    truth[half] = { x0, y0: y * s };
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
    expect(det.lower!.seen).toBeGreaterThanOrEqual(24);
    expect(Math.abs(det.lower!.x0 / k - 660 * (img.width / 3280) - pitch)).toBeLessThan(1.1 * pitch);
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
});
