// Robowski Studio - Live Dilution Tier Inspector
import { Reagent, VialSetItem } from '../types';

export interface DilutionTierInfo {
  tier: 'direct' | 'mixed' | 'dil1' | 'dil2' | 'sub';
  label: string;
  desc: string;
  minTransferUl: number;
  maxTransferUl: number;
}

export function computeDilutionTier(
  reagent: Reagent,
  item: VialSetItem | undefined,
  vialVolume: number,
  threshold: number,
  dilutionFactor: number,
  mode: 'concentration' | 'equivalence' | 'triplet',
  reagent0Range?: { min: number; max: number },
  reagentIndex = 0
): DilutionTierInfo | null {
  if (!item || !item.on) return null;
  const stock = +reagent.stock;
  if (!(stock > 0) || !(vialVolume > 0) || !(threshold > 0)) return null;

  let minConc = 0;
  let maxConc = 0;

  if (mode === 'equivalence' && reagentIndex > 0) {
    if (!reagent0Range || !(reagent0Range.min > 0) || !(reagent0Range.max > 0)) return null;
    const itemMin = +item.min;
    const itemMax = +item.max;
    if (!(itemMin >= 0) || !(itemMax >= itemMin)) return null;
    minConc = itemMin * reagent0Range.min;
    maxConc = itemMax * reagent0Range.max;
  } else {
    const itemMin = +item.min;
    const itemMax = +item.max;
    if (!(itemMin >= 0) || !(itemMax >= itemMin)) return null;
    minConc = itemMin;
    maxConc = itemMax;
  }

  if (minConc <= 0 && maxConc <= 0) return null;

  // Direct transfer volumes
  const minV = (minConc * vialVolume) / stock;
  const maxV = (maxConc * vialVolume) / stock;

  const N = dilutionFactor > 1 ? dilutionFactor : 5;
  const thr = threshold;

  // Case 1: Direct transfer
  if (minV >= thr - 1e-9) {
    return {
      tier: 'direct',
      label: 'Direct 1×',
      desc: `Direct pipetting from stock (${minV.toFixed(1)}–${maxV.toFixed(1)} µL)`,
      minTransferUl: minV,
      maxTransferUl: maxV,
    };
  }

  // Case 2: One-step dilution (N)
  const minV_N = minV * N;
  const maxV_N = maxV * N;

  if (maxV >= thr - 1e-9) {
    return {
      tier: 'mixed',
      label: `Mixed (1× & ${N}×)`,
      desc: `Higher amounts direct, lower amounts diluted ${N}×`,
      minTransferUl: minV_N,
      maxTransferUl: maxV,
    };
  }

  if (minV_N >= thr - 1e-9) {
    return {
      tier: 'dil1',
      label: `Dilution ${N}×`,
      desc: `Pipetted from 1 hand-diluted stock (${minV_N.toFixed(1)}–${maxV_N.toFixed(1)} µL)`,
      minTransferUl: minV_N,
      maxTransferUl: maxV_N,
    };
  }

  // Case 3: Two-step dilution (N^2)
  const minV_N2 = minV * N * N;
  const maxV_N2 = maxV * N * N;

  if (minV_N2 >= thr - 1e-9) {
    return {
      tier: 'dil2',
      label: `Dilution ${N * N}× (N²)`,
      desc: `Requires 2 hand dilutions to reach pipetting threshold (${minV_N2.toFixed(1)} µL)`,
      minTransferUl: minV_N2,
      maxTransferUl: maxV_N2,
    };
  }

  // Case 4: Sub-threshold
  return {
    tier: 'sub',
    label: 'Below Threshold',
    desc: `Transfer volume (${minV.toFixed(2)} µL) is too small even after 2 dilutions`,
    minTransferUl: minV,
    maxTransferUl: maxV,
  };
}
