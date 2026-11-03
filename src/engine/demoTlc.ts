// Robowski Studio - Synthetic Demo TLC Plate Generator
// Generates realistic laboratory TLC plate bitmaps for UV254 quenching and UV365 fluorescence
import { LANE_FRAME_WIDTH, createDefaultLaneConfig } from './tlcLanes';
import { TlcLaneConfig } from '../types';

export interface DemoTlcData {
  config: TlcLaneConfig;
  configName: string;
  uv254Blob: Blob;
  uv366Blob: Blob;
}

export async function generateDemoTlcPlate(
  channel: 'UV254' | 'UV366',
  width: number = 2400,
  height: number = 1800
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D canvas context');

  // Background: Realistic silica gel plate under UV lamp
  if (channel === 'UV254') {
    // Fluorescent indicator F254 glow (bright green-yellow phosphor emission)
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#36aa52');
    bgGrad.addColorStop(0.5, '#42bf60');
    bgGrad.addColorStop(1, '#34a04d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Subtle silica gel plate noise / texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    for (let i = 0; i < 25000; i++) {
      const rx = Math.random() * width;
      const ry = Math.random() * height;
      ctx.fillRect(rx, ry, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  } else {
    // UV 365 nm dark room background with deep indigo/violet luminescence
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#0d0b1a');
    bgGrad.addColorStop(0.5, '#16122e');
    bgGrad.addColorStop(1, '#0e0b1c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);
  }

  // Draw Two-Tier TLC development lanes
  const cfg = createDefaultLaneConfig(width, 'two-tier');

  // Solvent front lines (irregular meniscus)
  for (const tierY of [cfg.lanes[0].y0 - cfg.lanes[0].length * 0.92, cfg.lanes[27].y0 - cfg.lanes[27].length * 0.92]) {
    ctx.beginPath();
    ctx.strokeStyle = channel === 'UV254' ? 'rgba(30, 80, 40, 0.7)' : 'rgba(168, 85, 247, 0.6)';
    ctx.lineWidth = 3;
    ctx.moveTo(cfg.lanes[0].x0 - 50, tierY);
    for (let x = cfg.lanes[0].x0 - 40; x <= cfg.lanes[26].x0 + 50; x += 30) {
      const wobble = Math.sin(x * 0.02) * 5 + Math.cos(x * 0.05) * 3;
      ctx.lineTo(x, tierY + wobble);
    }
    ctx.stroke();
  }

  // Spot Origin Line (pencil line on silica)
  for (const originY of [cfg.lanes[0].y0 - (cfg.lanes[0].zeroRf || 120), cfg.lanes[27].y0 - (cfg.lanes[27].zeroRf || 120)]) {
    ctx.beginPath();
    ctx.strokeStyle = channel === 'UV254' ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(cfg.lanes[0].x0 - 40, originY);
    ctx.lineTo(cfg.lanes[26].x0 + 40, originY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw chromatographic spots for each of the 54 reaction conditions
  cfg.lanes.forEach((lane, laneIdx) => {
    const originY = lane.y0 - (lane.zeroRf || 120);
    const frontY = lane.y0 - lane.length * 0.92;
    const travelDistance = originY - frontY;

    // Spot 1: Unreacted starting material (Rf ~ 0.20 - 0.28)
    const rf1 = 0.24 + Math.sin(laneIdx * 0.5) * 0.03;
    const spot1Y = originY - travelDistance * rf1;
    const spot1Intensity = 0.5 + Math.cos(laneIdx * 0.8) * 0.25;

    // Spot 2: Cross-coupling product (Rf ~ 0.52 - 0.65)
    const rf2 = 0.58 + Math.cos(laneIdx * 0.4) * 0.04;
    const spot2Y = originY - travelDistance * rf2;
    const spot2Intensity = 0.4 + Math.sin(laneIdx * 1.2) * 0.35;

    // Spot 3: Fast-moving byproduct or non-polar ligand (Rf ~ 0.82)
    const rf3 = 0.82 + Math.sin(laneIdx * 0.3) * 0.02;
    const spot3Y = originY - travelDistance * rf3;
    const spot3Intensity = (laneIdx % 3 === 0) ? 0.3 : 0.05;

    const spots = [
      { y: spot1Y, rf: rf1, intensity: spot1Intensity, rx: lane.width * 0.45, ry: 16 },
      { y: spot2Y, rf: rf2, intensity: spot2Intensity, rx: lane.width * 0.5, ry: 20 },
    ];
    if (spot3Intensity > 0.1) {
      spots.push({ y: spot3Y, rf: rf3, intensity: spot3Intensity, rx: lane.width * 0.35, ry: 12 });
    }

    spots.forEach((sp) => {
      ctx.save();
      const grad = ctx.createRadialGradient(lane.x0, sp.y, 1, lane.x0, sp.y, sp.ry);
      if (channel === 'UV254') {
        // Quenching spot: UV absorption extinguishes green phosphor glow (dark purple/black band)
        grad.addColorStop(0, `rgba(18, 28, 20, ${0.85 * sp.intensity})`);
        grad.addColorStop(0.6, `rgba(28, 48, 30, ${0.5 * sp.intensity})`);
        grad.addColorStop(1, 'rgba(40, 160, 60, 0)');
      } else {
        // Fluorescence spot: Glowing cyan / violet fluorescent band under 365nm
        grad.addColorStop(0, `rgba(168, 85, 247, ${0.9 * sp.intensity})`);
        grad.addColorStop(0.5, `rgba(56, 189, 248, ${0.6 * sp.intensity})`);
        grad.addColorStop(1, 'rgba(22, 18, 46, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(lane.x0, sp.y, sp.rx, sp.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Failed to generate TLC plate image blob'));
    }, 'image/png');
  });
}

export async function createDemoTlcDataSet(): Promise<DemoTlcData> {
  const [uv254Blob, uv366Blob] = await Promise.all([
    generateDemoTlcPlate('UV254'),
    generateDemoTlcPlate('UV366'),
  ]);
  const config = createDefaultLaneConfig(2400, 'two-tier');
  return {
    config,
    configName: 'Standard 6×9 Screen Layout (2400px)',
    uv254Blob,
    uv366Blob,
  };
}
