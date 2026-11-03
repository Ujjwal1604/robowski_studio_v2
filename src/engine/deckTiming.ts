// Robowski Studio - Deck Geometry, Tip Counting, and Timing Models
import { DeckConfig, DeckLayout, RunRow, RuntimeEstimate, TipCounts } from '../types';
import { num, defaultPlates, PLATE_CAPACITY, TIP_RACK_CAPACITY } from './constants';

export function assignDeckPositions(
  hood: 'left' | 'right',
  stocks: Record<string, any>,
  cfg?: Partial<DeckConfig> | null
): DeckLayout {
  const c = { ...defaultPlates(hood), ...(cfg || {}) };
  const rows = Object.values(stocks);
  const base = rows.filter((s) => s.dilution_level === 0);
  const diluted = rows.filter((s) => s.dilution_level > 0);
  const all = [...base, ...diluted];
  const slots: [number, number][] = [];
  for (const p of c.stockPlates) {
    if (c.solventKind === 'jar' && p === c.solventPlate) continue;
    for (let k = 0; k < 8; k++) {
      if (c.solventKind === 'bottle' && p === c.solventPlate && k === c.solventPos) continue;
      slots.push([p, k]);
    }
  }
  all.forEach((s, i) => {
    const sl = slots[Math.min(i, slots.length - 1)] || [c.stockPlates[0], 0];
    s.breadboard_plate_id = sl[0];
    s.container_id = sl[1];
    s.deck_overflow = i >= slots.length;
  });
  const cap = slots.length;
  const fit = all.length <= cap;
  return {
    hood,
    plates: c.stockPlates,
    stock_plate: c.stockPlates[0],
    dilution_plate: c.stockPlates[1] != null ? c.stockPlates[1] : c.stockPlates[0],
    solvent_plate: c.solventPlate,
    solvent_kind: c.solventKind as 'jar' | 'bottle',
    solvent_container: c.solventPos,
    stock_capacity: cap,
    dilution_capacity: cap,
    positions_fit: fit,
    positions_message: fit
      ? ''
      : `${
          c.solventKind === 'jar' && c.stockPlates.includes(c.solventPlate)
            ? 'The solvent jar takes all of plate ' + c.solventPlate + ', so no stock bottles can sit there. '
            : ''
        }The chosen plates have ${cap} free bottle positions; this run needs ${all.length} stock positions (${base.length} direct + ${diluted.length} hand-diluted).`,
    solvent_location: `plate${c.solventPlate}, position ${c.solventPos}`,
  };
}

export function surfaceHeight(kind: string, uL: number): number {
  const g = kind === 'jar' ? { bottom: 2120, area: 2123.7 } : { bottom: 2190, area: 512.8205 };
  return Math.round(g.bottom - (uL / g.area) * 10);
}

export function tipSize(v: number): 50 | 300 | 1000 | null {
  if (v < 0.5) return null;
  if (v <= 50) return 50;
  if (v <= 300) return 300;
  if (v < 2000) return 1000;
  return null;
}

export function calculateTipCounts(
  rows: RunRow[],
  stocks: Record<string, any>,
  stockCheck = true,
  newTipEach = false
): TipCounts {
  const counts = { 50: 0, 300: 0, 1000: 0 };
  const perPlate: Array<{
    plate: number;
    counts: { 50: number; 300: number; 1000: number };
    transfers: number;
  }> = [];
  const stockKeys = Object.keys(stocks);
  const plateCount = Math.ceil(rows.length / PLATE_CAPACITY);

  for (let p = 0; p < plateCount; p++) {
    const plateRows = rows.slice(p * PLATE_CAPACITY, (p + 1) * PLATE_CAPACITY);
    const detail = { 50: 0, 300: 0, 1000: 0 };
    for (const key of [...stockKeys, 'solvent']) {
      const col = key === 'solvent' ? 'vol#solvent' : `vol#${key}`;
      const volumes = plateRows.map((r: any) => num(r[col])).filter((v) => v >= 0.5);
      if (!volumes.length) continue;
      if (newTipEach) {
        for (const v of volumes) {
          const s = tipSize(v);
          if (s) detail[s]++;
        }
      } else {
        for (const s of [...new Set(volumes.map(tipSize).filter(Boolean))].sort(
          (a, b) => (a as number) - (b as number)
        )) {
          if (s) detail[s as 50 | 300 | 1000]++;
        }
      }
    }
    perPlate.push({
      plate: p,
      counts: detail,
      transfers: plateRows.reduce(
        (n, row: any) =>
          n +
          stockKeys.reduce((m, key) => m + (num(row[`vol#${key}`]) >= 0.5 ? 1 : 0), 0) +
          (num(row['vol#solvent']) >= 0.5 ? 1 : 0),
        0
      ),
    });
    for (const size of [50, 300, 1000] as const) counts[size] += detail[size];
  }

  if (stockCheck) counts[300] += stockKeys.length + 1;

  return {
    50: counts[50],
    300: counts[300],
    1000: counts[1000],
    rackCapacity: TIP_RACK_CAPACITY,
    racks: {
      50: Math.ceil(counts[50] / TIP_RACK_CAPACITY),
      300: Math.ceil(counts[300] / TIP_RACK_CAPACITY),
      1000: Math.ceil(counts[1000] / TIP_RACK_CAPACITY),
    },
    perPlate,
    stockCheck,
    newTipEach,
    stockCheckTips: stockCheck ? stockKeys.length + 1 : 0,
  };
}

export function formatDuration(seconds: number): string {
  seconds = Math.max(0, Math.round(seconds));
  const mins = Math.floor(seconds / 60);
  const sec = seconds % 60;
  const hours = Math.floor(mins / 60);
  const mm = mins % 60;
  return hours
    ? `${hours} h ${String(mm).padStart(2, '0')} min`
    : mins
    ? `${mins} min ${String(sec).padStart(2, '0')} s`
    : `${sec} s`;
}

export function estimateRuntime(
  rows: RunRow[],
  tipCounts: TipCounts,
  stockCheck = true,
  newTipEach = false
): RuntimeEstimate {
  const TR: Record<number, [number, number, number]> = {
    50: [12.8, 12, 15],
    300: [13, 12, 14],
    1000: [13.8, 13, 15],
  };
  const TC = [30, 28, 33];
  const XC = [9, 6, 13];
  const PE = 2;
  const MAX: Record<number, number> = { 50: 50, 300: 300, 1000: 1000 };
  const t = [0, 0, 0];
  let transfers = 0,
    cycles = 0,
    tipChanges = 0;
  const colSet = new Set<string>();
  rows.forEach((r: any) =>
    Object.keys(r).forEach((k) => {
      if (k.startsWith('vol#')) colSet.add(k);
    })
  );
  const cols = [...colSet];
  const plates = Math.ceil(rows.length / PLATE_CAPACITY);

  for (let p = 0; p < plates; p++) {
    const plateRows = rows.slice(p * PLATE_CAPACITY, (p + 1) * PLATE_CAPACITY);
    for (const col of cols) {
      const vols = plateRows
        .map((r: any) => num(r[col]))
        .filter((v) => v >= 0.5)
        .sort((a, b) => b - a);
      let cur: number | null = null;
      for (const v of vols) {
        const s = tipSize(v) || 1000;
        if (newTipEach || s !== cur) {
          tipChanges++;
          for (let i = 0; i < 3; i++) t[i] += TC[i];
          cur = s;
        }
        const cyc = Math.max(1, Math.ceil(v / MAX[s] - 1e-9));
        transfers++;
        cycles += cyc;
        for (let i = 0; i < 3; i++) t[i] += TR[s][i] + (cyc - 1) * XC[i];
      }
    }
    for (let i = 0; i < 3; i++) t[i] += PE;
  }

  return {
    lowSeconds: Math.round(t[1]),
    highSeconds: Math.round(t[2]),
    seconds: Math.round(t[0]),
    label: `${formatDuration(t[0])} (${formatDuration(t[1])} to ${formatDuration(t[2])})`,
    events: transfers,
    transfers,
    cycles,
    tipChanges,
    plates,
    stockBottles: stockCheck ? tipCounts.stockCheckTips : 0,
    calibrationNote:
      'Fitted to three logged runs of 2026-10-12 (about 13 s per transfer plus 30 s per tip change). The 9 s per extra aspirate/dispense cycle is an assumption. Homing, rack reloads, manual pauses and the optional stock-volume check are not included.',
  };
}
