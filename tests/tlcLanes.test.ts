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
  findSpots,
  extractDensitogram,
  computeLaneRowIntensity,
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
});
