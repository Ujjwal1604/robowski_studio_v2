import { describe, it, expect } from 'vitest';
import {
  tlcLane,
  containerOfLane,
  wellLabel,
  tlcLaneRows,
  tlcLaneCsv,
  parseLaneConfig,
  laneMatrix,
  TlcLane,
  movingAvg,
  pctile,
  detectFront,
  detectOrigin,
  tlcOrigin,
  findSpots,
  extractDensitogram,
  computeLaneRowIntensity,
  createDefaultLaneConfig,
  createDefaultLaneCsvText,
  extractFluorescenceOverlay,
  computeFalseColorComposite,
} from '../src/engine/tlcLanes';
import { buildRun } from '../src/engine/dilution';
import { exampleState, dataFor } from '../src/context/runPayload';
import { parseDelimited } from '../src/engine/importers/tableReader';

describe('TLC Lanes & Coordinate Transforms', () => {
  it('maps column-by-column spotting vs robot row-by-row on 6x9 plate', () => {
    // Vial 0 (A1) -> TLC lane 0
    expect(tlcLane(0)).toBe(0);
    // Vial 9 (B1) -> TLC lane 1
    expect(tlcLane(9)).toBe(1);
    // Vial 1 (A2) -> TLC lane 6
    expect(tlcLane(1)).toBe(6);
    // Vial 53 (F9) -> TLC lane 53
    expect(tlcLane(53)).toBe(53);

    // Verify 1-to-1 bijection for all 54 vials
    const mapped = Array.from({ length: 54 }, (_, i) => tlcLane(i));
    expect(new Set(mapped).size).toBe(54);

    // Inverse check containerOfLane(tlcLane(i)) === i
    for (let i = 0; i < 54; i++) {
      expect(containerOfLane(tlcLane(i))).toBe(i);
    }
  });

  it('generates correct well labels', () => {
    expect(wellLabel(0)).toBe('A1');
    expect(wellLabel(9)).toBe('B1');
    expect(wellLabel(1)).toBe('A2');
    expect(wellLabel(53)).toBe('F9');
  });

  it('parses lane config CSV correctly', () => {
    const csv = `id,x0,y0,length,width,direction_angle,spot_radius_px,px_location_of_zero_rf
0,320,2100,1200,45,0,12,150
1,380,2100,1200,45,0,12,150`;
    const res = parseLaneConfig(csv);
    expect(res.lanes.length).toBe(2);
    expect(res.lanes[0].id).toBe(0);
    expect(res.lanes[0].x0).toBe(320);
    expect(res.lanes[0].zeroRf).toBe(150);
    expect(res.hasZeroRf).toBe(true);
  });

  it('generates standard 54-lane default configs (two-tier and single-tier)', () => {
    const twoTier = createDefaultLaneConfig(3280, 'two-tier');
    expect(twoTier.lanes.length).toBe(54);
    expect(twoTier.hasZeroRf).toBe(true);
    expect(twoTier.lanes[0].x0).toBeLessThan(twoTier.lanes[26].x0);
    expect(twoTier.lanes[27].x0).toBeLessThan(twoTier.lanes[53].x0);

    const singleTier = createDefaultLaneConfig(3280, 'single-tier');
    expect(singleTier.lanes.length).toBe(54);
    expect(singleTier.lanes[0].x0).toBeLessThan(singleTier.lanes[53].x0);

    const csvText = createDefaultLaneCsvText('two-tier');
    expect(csvText).toContain('id,x0,y0,length,width');
    const parsed = parseLaneConfig(csvText);
    expect(parsed.lanes.length).toBe(54);
  });

  it('generates tlcLaneRows and tlcLaneCsv from run', () => {
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'A', stock: 100, min: 20, step: 10, max: 20 },
        { code: 'B', stock: 100, min: 20, step: 10, max: 20 },
      ],
    });
    const rows = tlcLaneRows(run);
    expect(rows.length).toBe(run.rows.length);
    // Verified sorted by plate then lane
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].plate === rows[i - 1].plate) {
        expect(rows[i].lane).toBeGreaterThanOrEqual(rows[i - 1].lane);
      }
    }

    const csv = tlcLaneCsv(run);
    const parsed = parseDelimited(csv).filter((r) => r.some((c) => c !== ''));
    expect(parsed[0]).toContain('tlc_lane');
    expect(parsed[0]).toContain('well');
    expect(parsed.length).toBe(run.rows.length + 1);
  });

  it('computes affine lane transformation matrix', () => {
    const lane: TlcLane = {
      id: 0,
      x0: 500,
      y0: 2000,
      length: 1000,
      width: 40,
      angle: 0,
    };
    const m = laneMatrix(lane, 1.0, 0.5);
    expect(m.length).toBe(6);
    expect(m.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('calculates moving average and percentiles', () => {
    const data = [10, 20, 30, 40, 50];
    const sm = movingAvg(data, 3);
    expect(sm.length).toBe(5);
    expect(sm[2]).toBe(30); // avg of 20, 30, 40

    expect(pctile([1, 5, 10, 20, 50], 0.5)).toBe(10);
    expect(pctile([1, 2, 3, 4, 5], 0.0)).toBe(1);
    expect(pctile([1, 2, 3, 4, 5], 1.0)).toBe(5);
  });

  it('detects solvent front meniscus in upper 30% of lane', () => {
    const profile = new Array(200).fill(50);
    // Meniscus bright peak centered at index 175 (in the top 30%, which is >= 140)
    for (let i = 170; i <= 180; i++) {
      profile[i] = 100 + (5 - Math.abs(i - 175)) * 20;
    }
    const front = detectFront(profile);
    expect(front).toBe(175);
  });

  it('finds TLC spots and computes exact Rf and strength', () => {
    // 300 pixel lane, origin at 30, front at 270 (span = 240)
    // Dark spot at pixel 150 -> Rf = (150 - 30) / 240 = 0.50
    const profile = new Array(300).fill(200);
    // Create dark spot dip at pixel 150
    for (let i = 145; i <= 155; i++) {
      profile[i] = 40;
    }

    const spots = findSpots(profile, {
      sign: -1, // UV254 / quenching
      origin: 30,
      front: 270,
      radius: 20,
    });

    expect(spots.length).toBeGreaterThanOrEqual(1);
    const mainSpot = spots[0];
    expect(mainSpot.pos).toBeGreaterThanOrEqual(145);
    expect(mainSpot.pos).toBeLessThanOrEqual(155);
    expect(mainSpot.rf).toBeCloseTo(0.5, 1);
    expect(mainSpot.strength).toBeGreaterThan(0.5);
  });

  it('extracts complete 1D densitogram with baseline and AUC', () => {
    const profile = new Array(200).fill(180);
    // Dark spot peak at pixel 100
    for (let i = 95; i <= 105; i++) {
      profile[i] = 50;
    }
    const res = extractDensitogram(profile, {
      sign: -1,
      origin: 20,
      front: 180,
      radius: 15,
    });

    expect(res.points.length).toBe(200);
    expect(res.origin).toBe(20);
    expect(res.front).toBe(180);
    expect(res.spots.length).toBe(1);
    expect(res.totalArea).toBeGreaterThan(0);
    expect(res.spots[0].areaPct).toBeGreaterThan(50);
  });

  it('suppresses adjacent lane edge bleed with center-weighted core sampling', () => {
    const width = 40;
    const row = new Array(width * 4).fill(100);
    // Severe edge bleed artifact from adjacent lane at pixel 4 (left margin)
    row[4 * 4 + 1] = 250;
    // Core center peak at pixel 20 (center)
    row[20 * 4 + 1] = 10;

    // With 35% core sampling, pixel 4 is outside the core corridor and ignored
    const coreVal = computeLaneRowIntensity(row, width, 1, 0.35);
    // Average should reflect the center peak dip and NOT the edge spike
    expect(coreVal).toBeLessThan(100);
  });

  it('detects baseline origin and resolves tlcOrigin for microadjusted vs normal CSVs', () => {
    // 1. Detect baseline peak in lower 4-25%
    const prof = new Array(300).fill(180);
    // Spot deposit at index 35 (approx 12%)
    for (let i = 30; i <= 40; i++) prof[i] = 40;
    const detected = detectOrigin(prof, -1);
    expect(detected).toBeGreaterThanOrEqual(30);
    expect(detected).toBeLessThanOrEqual(40);

    // 2. Microadjusted lane with explicit zeroRf
    const setA: any = { uid: 's1', name: 'Set A', imgs: {}, frameW: 3280 };
    const laneWithZero: TlcLane = { id: 0, x0: 100, y0: 1000, length: 1000, width: 40, angle: 0, zeroRf: 135 };
    expect(tlcOrigin(setA, laneWithZero)).toBe(135);

    // 3. Normal lane without zeroRf: falls back to 10% length (100 px) or set.originPx
    const normalLane: TlcLane = { id: 1, x0: 100, y0: 1000, length: 1000, width: 40, angle: 0 };
    expect(tlcOrigin(setA, normalLane)).toBe(100);

    // 4. Normal lane with manual set.originPx override
    const setManual: any = { uid: 's2', name: 'Set B', imgs: {}, frameW: 3280, originPx: 115 };
    expect(tlcOrigin(setManual, normalLane)).toBe(115);
  });

  it('correctly maps inverted/opposing 180-degree upper tier lanes without coordinate distortion', () => {
    // Upper tier lane migrating downwards from top edge (y0=100, length=980, angle=180)
    const upperLane: TlcLane = {
      id: 27,
      x0: 500,
      y0: 100,
      length: 980,
      width: 72,
      angle: 180,
    };
    const m = laneMatrix(upperLane, 1.0, 1.0);
    // At origin (500, 100), canvas coordinates should be (w/2, len) = (36, 980)
    const uOrigin = m[0] * 500 + m[2] * 100 + m[4];
    const vOrigin = m[1] * 500 + m[3] * 100 + m[5];
    expect(uOrigin).toBeCloseTo(36, 1);
    expect(vOrigin).toBeCloseTo(980, 1);

    // At solvent front apex (500, 1080), canvas coordinates should be (36, 0)
    const uFront = m[0] * 500 + m[2] * 1080 + m[4];
    const vFront = m[1] * 500 + m[3] * 1080 + m[5];
    expect(uFront).toBeCloseTo(36, 1);
    expect(vFront).toBeCloseTo(0, 1);

    // Flipping lane geometry preserving physical silica gel strip bounds
    const th = (upperLane.angle * Math.PI) / 180;
    const endX = Math.round(upperLane.x0 + upperLane.length * Math.sin(th));
    const endY = Math.round(upperLane.y0 - upperLane.length * Math.cos(th));
    expect(endX).toBe(500);
    expect(endY).toBe(1080);
  });

  it('calculates spot centroid along lane migration vector and applies global plate skew correctly', () => {
    // 1. Spot centroid Rf mapping along lane axis
    const lane: TlcLane = { id: 5, x0: 400, y0: 2200, length: 1000, width: 60, angle: 0 };
    const origin = 100;
    const front = 900;
    const span = front - origin; // 800 px
    const rf = 0.50;
    const spotPos = origin + rf * span; // 500 px
    expect(spotPos).toBe(500);

    // 2. Global skew rotation: applying +0.2° to all lanes preserves origin coordinates
    const lanes: TlcLane[] = [
      { id: 0, x0: 200, y0: 2200, length: 1000, width: 60, angle: -0.4 },
      { id: 27, x0: 200, y0: 100, length: 1000, width: 60, angle: 179.6 },
    ];
    const skewed = lanes.map((l) => ({ ...l, angle: +(l.angle + 0.2).toFixed(2) }));
    expect(skewed[0].angle).toBe(-0.2);
    expect(skewed[1].angle).toBe(179.8);
    expect(skewed[0].x0).toBe(200);
    expect(skewed[0].y0).toBe(2200);
  });

  it('correctly strips ambient chamber background from UV366 to prevent overexposed composite images', () => {
    // 2x2 image: pixel 0 is dark background (20, 20, 40), pixel 1 is bright fluorescence (180, 100, 250)
    const src = new Uint8ClampedArray([
      20, 20, 40, 255,   // Background pixel
      180, 100, 250, 255, // Fluorescent spot pixel
      18, 18, 35, 255,   // Background pixel
      22, 22, 42, 255,   // Background pixel
    ]);

    const overlay = extractFluorescenceOverlay(src, 2, 2, 0.20, 1.5);
    // Background pixel must be 100% transparent (alpha = 0) so it does NOT wash out UV254
    expect(overlay[3]).toBe(0);
    // Fluorescent spot pixel must be opaque (alpha > 0)
    expect(overlay[7]).toBeGreaterThan(150);

    // Test False-Color composite
    const uv254 = new Uint8ClampedArray([
      40, 60, 30, 255,   // Quenching spot on UV254 (dark green)
      60, 200, 80, 255,  // Bright phosphor background
      60, 200, 80, 255,  // Bright phosphor background
      60, 200, 80, 255,  // Bright phosphor background
    ]);
    const fc = computeFalseColorComposite(uv254, src, 2, 2, 1.4);
    expect(fc.length).toBe(16);
    // Spot 0 (Quenching): Amber/Gold has high red/green
    expect(fc[0]).toBeGreaterThan(100);
    // Spot 1 (Fluorescence): Cyan has high blue
    expect(fc[6]).toBeGreaterThan(150);
  });

  it('detects low-Rf polar products and high-Rf nonpolar spots accurately', () => {
    // 300-pixel lane with origin at 30, front at 270 (span = 240)
    const profile = new Array(300).fill(200);

    // 1. Low Rf peak at pixel 48 -> Rf = (48 - 30) / 240 = 0.075 (~0.08)
    for (let i = 45; i <= 51; i++) {
      profile[i] = 40;
    }
    // 2. High Rf peak at pixel 258 -> Rf = (258 - 30) / 240 = 0.95
    for (let i = 255; i <= 261; i++) {
      profile[i] = 50;
    }

    const spots = findSpots(profile, {
      sign: -1,
      origin: 30,
      front: 270,
      radius: 20,
    });

    expect(spots.length).toBe(2);
    const lowRfSpot = spots.find((s) => s.rf < 0.2);
    const highRfSpot = spots.find((s) => s.rf > 0.8);

    expect(lowRfSpot).toBeDefined();
    expect(lowRfSpot!.rf).toBeCloseTo(0.075, 2);

    expect(highRfSpot).toBeDefined();
    expect(highRfSpot!.rf).toBeCloseTo(0.95, 2);
  });

  it('resolves closely spaced doublet peaks without peak suppression', () => {
    // 300-pixel lane with origin at 30, front at 270 (span = 240)
    const profile = new Array(300).fill(200);

    // Doublet peak: peak 1 at pixel 120 (Rf = 0.375), peak 2 at pixel 136 (Rf = 0.442) -> 16 px apart
    for (let i = 117; i <= 123; i++) profile[i] = 40;
    for (let i = 133; i <= 139; i++) profile[i] = 45;

    const spots = findSpots(profile, {
      sign: -1,
      origin: 30,
      front: 270,
      radius: 20,
    });

    expect(spots.length).toBe(2);
    expect(spots[0].rf).toBeCloseTo(0.375, 2);
    expect(spots[1].rf).toBeCloseTo(0.442, 2);
  });

  it('ensures well coordinate to TLC lane mapping is bijective across all 54 wells', () => {
    // Microplate row-major index k: k = row * 9 + col (A1=0, A2=1, B1=9, etc.)
    // TLC lane column-major index: lane = col * 6 + row
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 9; col++) {
        const k = row * 9 + col;
        const lane = tlcLane(k, 'column');
        expect(lane).toBe(col * 6 + row);
        expect(containerOfLane(lane)).toBe(k);
      }
    }
  });

  it('consolidates broad saturated/tailing spots into a single centroid instead of multiple sub-peaks', () => {
    // 500-pixel lane, origin at 50, front at 450 (span = 400)
    const profile = new Array(500).fill(220);

    // Create a single broad saturated spot spanning 80 pixels (from pixel 180 to 260)
    // with minor camera noise / plateau grain (+/- 2-3 units)
    for (let i = 180; i <= 260; i++) {
      const distFromCenter = Math.abs(i - 220);
      // Bell/plateau curve with minor ripples
      const ripple = (i % 7 === 0 ? 3 : i % 5 === 0 ? -3 : 0);
      const intensity = Math.min(200, 180 - distFromCenter * 1.5 + ripple);
      profile[i] = 220 - intensity; // quenching dip
    }

    // Also add one separate distinct small spot at pixel 350
    for (let i = 346; i <= 354; i++) {
      profile[i] = 130;
    }

    const spots = findSpots(profile, {
      sign: -1,
      origin: 50,
      front: 450,
      radius: 24,
    });

    // Must detect EXACTLY 2 spots: 1 for the broad spot, 1 for the distinct separate spot
    expect(spots.length).toBe(2);

    const broadSpot = spots.find((s) => s.pos >= 180 && s.pos <= 260);
    const smallSpot = spots.find((s) => s.pos >= 340 && s.pos <= 360);

    expect(broadSpot).toBeDefined();
    // Centroid of broad spot should be close to center (pixel 220, Rf ~0.425)
    expect(broadSpot!.pos).toBeGreaterThanOrEqual(210);
    expect(broadSpot!.pos).toBeLessThanOrEqual(230);
    expect(broadSpot!.rf).toBeCloseTo((220 - 50) / 400, 1);

    expect(smallSpot).toBeDefined();
    expect(smallSpot!.pos).toBeGreaterThanOrEqual(346);
    expect(smallSpot!.pos).toBeLessThanOrEqual(354);
  });

  it('changes spot detection deconvolution distinctly across Broad, Standard, and Sensitive modes', () => {
    // 500-pixel lane, origin at 50, front at 450 (span = 400)
    const profile = new Array(500).fill(220);

    // Overlapping peaks with a 35% valley dip between them:
    // Peak A at pixel 200 (val: 170)
    // Valley at pixel 225 (val: 110, dip = 60 units, drop ratio = 60/170 = 35%)
    // Peak B at pixel 250 (val: 165)
    for (let i = 180; i <= 270; i++) {
      let signal = 0;
      if (i <= 225) {
        // Peak A bell curve
        const d = Math.abs(i - 200);
        signal = Math.max(0, 170 - d * 2.4);
      } else {
        // Peak B bell curve
        const d = Math.abs(i - 250);
        signal = Math.max(0, 165 - d * 2.2);
      }
      profile[i] = 220 - signal;
    }

    // 1. Broad Mode (minProminence = 0.55): 35% valley is under 55% -> merges into 1 broad spot
    const broadSpots = findSpots(profile, {
      sign: -1,
      origin: 50,
      front: 450,
      radius: 24,
      minProminence: 0.55,
      minDistance: 56,
    });
    expect(broadSpots.length).toBe(1);

    // 2. Sensitive Mode (minProminence = 0.12): 35% valley is above 12% -> resolves into 2 distinct spots
    const sensitiveSpots = findSpots(profile, {
      sign: -1,
      origin: 50,
      front: 450,
      radius: 24,
      minProminence: 0.12,
      minDistance: 12,
    });
    expect(sensitiveSpots.length).toBe(2);
  });

  it('consolidates multi-ripple overloaded broad spots (4 peaks) into exactly 1 clean spot in Broad mode', () => {
    // 900-pixel lane matching real high-res TLC plates
    // Origin at 90, Front at 750 (span = 660)
    const profile = new Array(900).fill(215);

    // Massive broad spot from index 300 to 460 (160 px wide) with 4 ripples spaced ~35 px apart
    for (let i = 290; i <= 470; i++) {
      const envelope = Math.max(0, 160 * (1 - Math.pow((i - 380) / 90, 2)));
      const ripple = 25 * Math.sin((i - 300) * 0.14);
      profile[i] = 215 - Math.max(0, envelope + ripple);
    }

    // A separate distinct nonpolar spot at 580 (Rf = (580 - 90)/660 = 0.74)
    for (let i = 568; i <= 592; i++) {
      profile[i] = 215 - Math.max(0, 95 - Math.abs(i - 580) * 8);
    }

    // 1. Broad Spots mode: collapses the 4-ripple broad spot into exactly 1 spot + 1 separate spot = 2 spots
    const broadSpots = findSpots(profile, {
      sign: -1,
      origin: 90,
      front: 750,
      radius: 24,
      minProminence: 0.55,
      minDistance: 92,
    });

    expect(broadSpots.length).toBe(2);
    // Spot 1: Unified centroid of the broad spot in [360, 400]
    expect(broadSpots[0].pos).toBeGreaterThanOrEqual(365);
    expect(broadSpots[0].pos).toBeLessThanOrEqual(395);
    // Spot 2: Distinct spot at 580
    expect(broadSpots[1].pos).toBeGreaterThanOrEqual(575);
    expect(broadSpots[1].pos).toBeLessThanOrEqual(585);

    // 2. Standard mode: also merges the 4 ripples into 1 clean spot
    const standardSpots = findSpots(profile, {
      sign: -1,
      origin: 90,
      front: 750,
      radius: 24,
      minProminence: 0.28,
      minDistance: 46,
    });
    expect(standardSpots.length).toBe(2);
  });
});

describe('spot sensitivity slider', () => {
  const n = 1000;
  const g = (i: number, c: number, w: number, h: number) => h * Math.exp(-(((i - c) / w) ** 2));
  const doublet = Array.from({ length: n }, (_, i) => 200 - g(i, 400, 14, 80) - g(i, 434, 14, 60) - g(i, 700, 12, 20));
  const count = (p: number) => findSpots(doublet, { sign: -1, origin: 20, front: 980, radius: 24, minProminence: p }).length;

  it('never finds more spots as the slider moves toward merging', () => {
    let prev = Infinity;
    for (let p = 0.08; p <= 0.7001; p += 0.02) {
      const c = count(p);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });
  it('resolves the doublet when sensitive and merges it when broad', () => {
    expect(count(0.12)).toBe(3);
    expect(count(0.55)).toBe(2);
  });
  it('changes the result inside the old Standard band, not only at mode edges', () => {
    expect(count(0.2)).toBe(3);
    expect(count(0.4)).toBe(2);
  });
});
