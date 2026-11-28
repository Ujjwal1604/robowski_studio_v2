// Robowski Studio - Deck Geometry, Pre-Flight Validation, Tip Counting, and Timing Models
// Synced with zeus-pipetter/breadboard.py, main.py, and main_auto_liquid_height.py
import {
  DeckConfig,
  DeckLayout,
  PreFlightContainerCheck,
  RunResult,
  RunRow,
  RuntimeEstimate,
  TipCounts,
} from '../types';
import {
  BOTTLE_CAPACITY_ML,
  BOTTLE_MAX_ML,
  CONTAINER_GEOMETRY,
  JAR_CAPACITY_ML,
  PLATE_CAPACITY,
  PREWET_MAX_DEPTH,
  TIP_RACK_CAPACITY,
  defaultPlates,
  num,
} from './constants';

export function assignDeckPositions(
  hood: 'left' | 'right',
  stocks: Record<string, any>,
  cfg?: Partial<DeckConfig> | null
): DeckLayout {
  const rawCfg = { ...defaultPlates(hood), ...(cfg || {}) };
  // Enforce physical deck holder type: plate3-5 hold 20/40 mL bottles, plate6-7 hold 100 mL jars.
  const normalizedSolventKind: 'jar' | 'bottle' =
    rawCfg.solventPlate >= 6 ? 'jar' : 'bottle';
  const normalizedSolventPos =
    normalizedSolventKind === 'jar'
      ? Math.max(0, Math.min(1, Number(rawCfg.solventPos) || 0))
      : Math.max(0, Math.min(7, Number(rawCfg.solventPos) || 0));
  const c = {
    ...rawCfg,
    solventKind: normalizedSolventKind,
    solventPos: normalizedSolventPos,
  };
  // Only allocate deck positions for stocks that the robot will actually aspirate from.
  const rows = Object.values(stocks).filter((s) => {
    if (
      s.direct_consumption_ml === 0 &&
      s.consumption_uL === 0 &&
      (s.additional_dilution_source_ml > 0 || s.source_only)
    ) {
      return false;
    }
    return true;
  });
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

/**
 * Exact Zeus z-coordinate (0.1 mm units) of the liquid surface from volume (µL),
 * matching main_auto_liquid_height.py liquid_surface_height_from_volume() and breadboard.py.
 */
export function surfaceHeight(kind: string, uL: number): number {
  const g =
    kind === 'jar'
      ? CONTAINER_GEOMETRY.jar
      : kind === 'vial'
      ? CONTAINER_GEOMETRY.vial
      : CONTAINER_GEOMETRY.bottle;
  return Math.round(g.bottom - (uL / g.area) * 10);
}

/** Exact float liquid surface height (0.1 mm units) */
export function surfaceHeightExact(kind: 'bottle' | 'jar' | 'vial', uL: number): number {
  const g = CONTAINER_GEOMETRY[kind];
  return g.bottom - (uL / g.area) * 10;
}

/** Inverse of surfaceHeightExact: volume in µL from Zeus z height (0.1 mm units) */
export function volumeFromSurfaceHeight(kind: 'bottle' | 'jar' | 'vial', heightZ: number): number {
  const g = CONTAINER_GEOMETRY[kind];
  return ((g.bottom - heightZ) / 10) * g.area;
}

/**
 * Matches main_auto_liquid_height.py prewet_volume_ul():
 * Caps prewet volume so the tip stays within PREWET_MAX_DEPTH (5.0 mm) below the surface.
 */
export function prewetVolumeUl(kind: 'bottle' | 'jar' | 'vial', tipVolumeUl: number): number {
  const g = CONTAINER_GEOMETRY[kind];
  const depthForVolume = PREWET_MAX_DEPTH - g.immersionDepth;
  if (depthForVolume <= 0) return 0;
  const volumeLimit = (depthForVolume / 10) * g.area;
  return Math.floor(Math.min(tipVolumeUl, volumeLimit));
}

/**
 * Builds the main_auto_liquid_height.py pre-flight confirmation table in plain English.
 */
export function computePreFlightChecks(
  run: Pick<
    RunResult,
    'stocks' | 'deck' | 'reactionSolvent' | 'solventConsumptionMl' | 'solventRecommendedMl'
  >
): PreFlightContainerCheck[] {
  const checks: PreFlightContainerCheck[] = [];

  const evaluateContainer = (
    substance: string,
    isSolvent: boolean,
    plate: number,
    containerId: number,
    kind: 'bottle' | 'jar',
    solvent: string,
    preparedUl: number,
    neededUl: number
  ): PreFlightContainerCheck => {
    const g = CONTAINER_GEOMETRY[kind];
    const notRequired = neededUl <= 0;
    const effectiveDeadUl = notRequired ? 0 : g.deadVolumeUl;
    const zExact = notRequired ? g.bottom : surfaceHeightExact(kind, preparedUl);
    const zRounded = Math.round(zExact);
    const topZ = surfaceHeightExact(kind, g.volumeMaxUl);
    const heightValid = notRequired
      ? true
      : preparedUl > 0 && preparedUl <= g.volumeMaxUl && zExact >= topZ - 1e-6 && zExact < g.bottom;
    const mmAboveBottom = notRequired ? 0 : Math.max(0, (g.bottom - zExact) / 10);
    const marginUl = notRequired ? Math.round(preparedUl) : Math.round(preparedUl - (neededUl + effectiveDeadUl));

    let bottleSizeLabel = notRequired ? 'Not needed' : '100 mL jar';
    if (!notRequired) {
      if (kind === 'bottle') {
        const ml = preparedUl / 1000;
        if (ml > BOTTLE_MAX_ML) bottleSizeLabel = 'Over 40 mL max!';
        else if (ml > BOTTLE_CAPACITY_ML) bottleSizeLabel = '40 mL bottle';
        else bottleSizeLabel = '20 mL bottle';
      } else if (preparedUl / 1000 > JAR_CAPACITY_ML) {
        bottleSizeLabel = 'Over 100 mL max!';
      }
    }

    let status: 'ok' | 'warn' | 'block' = 'ok';
    let summary = notRequired
      ? 'Not used in this run (0 mL needed) — dead volume does not apply and no container is required.'
      : `Ready (+${(marginUl / 1000).toFixed(2)} mL spare above ${(effectiveDeadUl / 1000).toFixed(1)} mL dead volume)`;

    if (!notRequired) {
      if (!heightValid || preparedUl > g.volumeMaxUl) {
        status = 'block';
        summary =
          preparedUl > g.volumeMaxUl
            ? `Too full (${(preparedUl / 1000).toFixed(1)} mL exceeds ${(g.volumeMaxUl / 1000).toFixed(0)} mL container max — robot will reject)`
            : `Empty or invalid liquid height (z=${zRounded}, bottom=${g.bottom})`;
      } else if (marginUl < 0) {
        status = 'warn';
        summary = `Short by ${(Math.abs(marginUl) / 1000).toFixed(2)} mL after ${(effectiveDeadUl / 1000).toFixed(1)} mL dead volume — add more liquid so the tip never sucks air`;
      } else if (kind === 'bottle' && preparedUl / 1000 > BOTTLE_CAPACITY_ML) {
        status = 'warn';
        summary = `Use a 40 mL bottle in this slot (+${(marginUl / 1000).toFixed(2)} mL spare above 1.0 mL dead volume)`;
      }
    }

    return {
      substance,
      isSolvent,
      plate,
      containerId,
      containerKind: kind,
      bottleSizeLabel,
      solvent,
      preparedUl: Math.round(preparedUl),
      neededUl: Math.round(neededUl),
      deadVolumeUl: effectiveDeadUl,
      deadVolumeMeasured: g.deadVolumeMeasured,
      marginUl,
      surfaceHeightZ: zRounded,
      bottomZ: g.bottom,
      mmAboveBottom: Number(mmAboveBottom.toFixed(1)),
      heightValid,
      prewetUlByTip: {
        50: prewetVolumeUl(kind, 50),
        300: prewetVolumeUl(kind, 300),
        1000: prewetVolumeUl(kind, 1000),
      },
      status,
      summary,
    };
  };

  // Solvent container first
  checks.push(
    evaluateContainer(
      'solvent',
      true,
      run.deck.solvent_plate,
      run.deck.solvent_container,
      run.deck.solvent_kind,
      run.reactionSolvent,
      run.solventRecommendedMl * 1000,
      run.solventConsumptionMl * 1000
    )
  );

  // Stock bottles on deck
  for (const s of Object.values(run.stocks)) {
    if (s.source_only || (s.direct_consumption_ml === 0 && s.consumption_uL === 0 && s.additional_dilution_source_ml > 0)) {
      continue;
    }
    checks.push(
      evaluateContainer(
        s.substance,
        false,
        s.breadboard_plate_id,
        s.container_id,
        'bottle',
        s.solvent,
        s.prep_volume_ml * 1000,
        s.consumption_uL
      )
    );
  }

  return checks;
}

export function tipSize(v: number): 50 | 300 | 1000 | null {
  if (v < 0.5) return null;
  if (v <= 50) return 50;
  if (v <= 300) return 300;
  if (v < 2000) return 1000;
  return null;
}

export interface TipAndRuntimeOptions {
  autoLiquidHeight?: boolean;
  pipettingStrategy?: 'by_solvent' | 'by_vial';
  substanceDelaySec?: number;
}

export function calculateTipCounts(
  rows: RunRow[],
  stocks: Record<string, any>,
  stockCheck = true,
  newTipEach = false,
  opts?: TipAndRuntimeOptions
): TipCounts {
  const autoLiquidHeight = opts?.autoLiquidHeight ?? false;
  const strategy = opts?.pipettingStrategy || 'by_solvent';
  const effectiveStockCheck = autoLiquidHeight ? false : stockCheck;

  const counts = { 50: 0, 300: 0, 1000: 0 };
  const perPlate: Array<{
    plate: number;
    counts: { 50: number; 300: number; 1000: number };
    transfers: number;
  }> = [];
  const stockKeys = Object.keys(stocks);
  const allKeys = [...stockKeys, 'solvent'];
  const plateCount = Math.ceil(rows.length / PLATE_CAPACITY);

  for (let p = 0; p < plateCount; p++) {
    const plateRows = rows.slice(p * PLATE_CAPACITY, (p + 1) * PLATE_CAPACITY);
    const detail = { 50: 0, 300: 0, 1000: 0 };

    if (strategy === 'by_vial') {
      // Vial-by-vial changes substance on every addition within each vial -> each active transfer needs a clean tip
      for (const row of plateRows) {
        for (const key of allKeys) {
          const col = key === 'solvent' ? 'vol#solvent' : `vol#${key}`;
          const v = num((row as any)[col]);
          const s = tipSize(v);
          if (s) detail[s]++;
        }
      }
    } else {
      for (const key of allKeys) {
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

  if (effectiveStockCheck) counts[300] += stockKeys.length + 1;

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
    stockCheck: effectiveStockCheck,
    newTipEach,
    stockCheckTips: effectiveStockCheck ? stockKeys.length + 1 : 0,
    autoLiquidHeight,
    pipettingStrategy: strategy,
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
  newTipEach = false,
  opts?: TipAndRuntimeOptions
): RuntimeEstimate {
  const autoLiquidHeight = opts?.autoLiquidHeight ?? tipCounts.autoLiquidHeight ?? false;
  const strategy = opts?.pipettingStrategy || tipCounts.pipettingStrategy || 'by_solvent';
  const delayPerSubstance = Math.max(0, num(opts?.substanceDelaySec, 0));
  const effectiveStockCheck = autoLiquidHeight ? false : stockCheck;

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
    tipChanges = 0,
    delaySeconds = 0;

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
    if (strategy === 'by_vial') {
      for (const row of plateRows) {
        for (const col of cols) {
          const v = num((row as any)[col]);
          if (v < 0.5) continue;
          const s = tipSize(v) || 1000;
          tipChanges++;
          for (let i = 0; i < 3; i++) t[i] += TC[i];
          const cyc = Math.max(1, Math.ceil(v / MAX[s] - 1e-9));
          transfers++;
          cycles += cyc;
          for (let i = 0; i < 3; i++) t[i] += TR[s][i] + (cyc - 1) * XC[i];
        }
      }
    } else {
      let activeSubstancesThisPlate = 0;
      for (const col of cols) {
        const vols = plateRows
          .map((r: any) => num(r[col]))
          .filter((v) => v >= 0.5)
          .sort((a, b) => b - a);
        if (!vols.length) continue;
        activeSubstancesThisPlate++;
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
      if (delayPerSubstance > 0 && activeSubstancesThisPlate > 1) {
        const d = delayPerSubstance * (activeSubstancesThisPlate - 1);
        delaySeconds += d;
        for (let i = 0; i < 3; i++) t[i] += d;
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
    stockBottles: effectiveStockCheck ? tipCounts.stockCheckTips : 0,
    delaySeconds,
    pipettingStrategy: strategy,
    calibrationNote:
      `Fitted to logged Robowski runs (~13 s/transfer + 30 s/tip change). Mode: ${
        strategy === 'by_vial' ? 'vial-by-vial' : 'by-reagent'
      }${autoLiquidHeight ? ', auto liquid height (0 probe tips)' : ''}${
        delaySeconds > 0 ? `, includes ${formatDuration(delaySeconds)} inter-reagent waits` : ''
      }.`,
  };
}
