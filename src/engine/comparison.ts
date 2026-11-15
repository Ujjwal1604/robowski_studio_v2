// Robowski Studio - Multi-Run & Multi-Well Comparison Engine
import {
  Reagent,
  RunResult,
  RunRow,
  RunState,
  SavedRun,
  TlcLane,
  TlcSet,
  TlcSpot,
  WellObservation,
  WellOutcomeStatus,
} from '../types';
import { PAL, canonicalSolvent } from './constants';
import { axisValues } from './combinations';
import { buildRun } from './dilution';
import { triBuildRows, triDefault, triSync } from './triplet';
import { TlcChannelKey, tlcLane, wellLabel } from './tlcLanes';
import { deserializeTlcSetMeta, resolveTlcSetForPlate } from './tlcPlateSlice';
import {
  WellExtractionResult,
  extractWellForPrediction,
  getSuggestedWellDisplay,
  isKnownAdditiveReagent,
} from './predictor/plateBridge';
import { PredictedSpecies, WellPredictionResult } from './predictor/types';

export const CURRENT_RUN_ID = '__current__';
const PLATE_SIZE = 54;

export interface ComparableRun {
  id: string;
  name: string;
  isCurrent: boolean;
  updated: number;
  status: 'draft' | 'exported';
  tlcStatus: 'ready' | 'pending';
  state: RunState;
  run: RunResult | null;
  triMeta: any[];
  tlcSets: TlcSet[];
  error?: string;
}

export interface WellCompareSlotRef {
  uid: string;
  runId: string;
  plateIndex: number;
  wellIndex: number;
}

export interface WellSnapshotSubstrate {
  code: string;
  name: string;
  smiles: string;
  concMm: number;
  equiv: number | null;
  transferUl: number;
  dilutionLevel: number;
  color: string;
  isAdditive: boolean;
}

export interface WellSnapshot {
  slotUid: string;
  runId: string;
  runName: string;
  isCurrentRun: boolean;
  plateIndex: number;
  wellIndex: number;
  wellLabel: string;
  globalIndex: number;
  groupLabel: string;
  isBlank: boolean;
  row: RunRow | null;
  substrates: WellSnapshotSubstrate[];
  solventTransferUl: number;
  totalVialUl: number;
  extraction: WellExtractionResult | null;
  eln: WellObservation | null;
  elnCampaign: {
    reactionClass?: string;
    temperatureC?: number | string;
    reactionTimeHours?: number | string;
    atmosphere?: string;
    illumination?: string;
    agitation?: string;
  };
  tlc: {
    tlcSet?: TlcSet;
    laneIndex: number;
    lane: TlcLane | null;
    spots: TlcSpot[];
    hasImages: boolean;
    channels: TlcChannelKey[];
  };
}

export interface RunComparisonParamRow {
  key: string;
  label: string;
  values: Array<string | number>;
  hasDiff: boolean;
  diffFromBaseline: boolean[];
}

export interface AlignedReagentEntry {
  reagent: Reagent;
  color: string;
  index: number;
}

export interface AlignedReagentRow {
  key: string;
  displayName: string;
  displayCode: string;
  smiles: string;
  entries: Array<AlignedReagentEntry | null>;
  hasDiff: boolean;
  diffFlags: {
    name: boolean;
    molarMass: boolean;
    density: boolean;
    stock: boolean;
    solvent: boolean;
    smiles: boolean;
    missingAny: boolean;
  };
}

export interface RunElnSummary {
  totalAnnotated: number;
  hits: number;
  clean: number;
  partial: number;
  smOnly: number;
  decomp: number;
  precipitate: number;
  blank: number;
  topHits: Array<{
    plateIndex: number;
    wellIndex: number;
    label: string;
    conversion: number | null;
    yield: number | null;
  }>;
}

export interface MultiRunComparisonResult {
  runs: ComparableRun[];
  parameterRows: RunComparisonParamRow[];
  reagentRows: AlignedReagentRow[];
  elnSummaries: RunElnSummary[];
}

export interface WellReagentComparisonRow {
  key: string;
  displayName: string;
  displayCode: string;
  smiles: string;
  isAdditive: boolean;
  cells: Array<{
    present: boolean;
    concMm: number;
    equiv: number | null;
    transferUl: number;
    dilutionLevel: number;
    color: string;
    code: string;
  }>;
  hasDiff: boolean;
}

export interface WellConditionComparisonRow {
  key: string;
  label: string;
  values: Array<string | number>;
  hasDiff: boolean;
  diffFromBaseline: boolean[];
}

export interface TlcRfBandRow {
  bandIndex: number;
  anchorRf: number;
  rfMin: number;
  rfMax: number;
  cells: Array<{
    matched: boolean;
    spot: TlcSpot | null;
    deltaRf: number | null;
  }>;
}

export interface ProductComparisonRow {
  key: string;
  smiles: string;
  formula: string;
  exactMass: number;
  mhPlus: number;
  mNaPlus: number;
  mHMinus: number;
  mechanismSummary: string;
  status: PredictedSpecies['status'];
  presenceKind: 'shared' | 'partial' | 'unique';
  presentCount: number;
  maxScore: number;
  cells: Array<{
    present: boolean;
    rank: number | null;
    score: number | null;
    tier: PredictedSpecies['tier'] | null;
  }>;
}

export interface MultiWellComparisonResult {
  snapshots: WellSnapshot[];
  reagentRows: WellReagentComparisonRow[];
  conditionRows: WellConditionComparisonRow[];
  elnRows: WellConditionComparisonRow[];
  rfBands: TlcRfBandRow[];
  productRows: ProductComparisonRow[];
}

function cloneStateNormalized(rawState: RunState): RunState {
  const st: RunState = JSON.parse(JSON.stringify(rawState));
  if (!st.sets || !st.sets.length) {
    st.sets = [
      {
        name: 'Set 1',
        items: (st.reagents || []).map((r) => ({
          on: true,
          min: r.min ?? 1,
          step: r.step ?? 1,
          max: r.max ?? 1,
        })),
      },
    ];
  }
  st.sets.forEach((set) => {
    while (set.items.length < (st.reagents || []).length) {
      set.items.push({ on: false, min: 1, step: 1, max: 2 });
    }
    set.items.length = (st.reagents || []).length;
  });
  if (!st.tri) st.tri = triDefault();
  if (!st.product) st.product = { name: '', code: '', smiles: '' };
  if (!st.eln) {
    st.eln = { wells: {} };
  } else if (!st.eln.wells) {
    st.eln.wells = {};
  }
  try {
    triSync(st);
  } catch {
    // preserve partial/draft triplet setup softly
  }
  return st;
}

function buildRowsFromState(st: RunState): { rows: number[][]; setOf: number[] } {
  if (st.imported?.rows?.length) {
    return { rows: st.imported.rows, setOf: st.imported.rows.map(() => 0) };
  }
  const n = st.reagents.length;
  const rows: number[][] = [];
  const setOf: number[] = [];
  const eq = st.mode === 'equivalence';
  const sets = st.sets || [];

  sets.forEach((set, si) => {
    const nm = set.name || `Set ${si + 1}`;
    const on = set.items.map((it, i) => (it.on ? i : -1)).filter((i) => i >= 0);
    if (!on.length) throw new Error(`${nm}: tick at least one reagent.`);
    if (eq && !on.includes(0)) {
      throw new Error(`${nm}: in Equivalence mode every set needs ${st.reagents[0]?.code || 'R1'}.`);
    }
    const axes = on.map((i) =>
      axisValues(
        set.items[i].min,
        set.items[i].step,
        set.items[i].max,
        `${nm} · ${st.reagents[i]?.code || `R${i + 1}`}`
      )
    );
    const total = axes.reduce((a, x) => a * x.length, 1);
    if (total > 20000) {
      throw new Error(`${nm} exceeds 20,000 combinations.`);
    }
    let combos: number[][] = [[]];
    for (const ax of axes) {
      const next: number[][] = [];
      for (const prefix of combos) {
        for (const v of ax) next.push([...prefix, v]);
      }
      combos = next;
    }
    combos.forEach((vals) => {
      const row = new Array(n).fill(0);
      on.forEach((i, k) => {
        row[i] = vals[k];
      });
      if (eq) {
        const aa = row[0];
        for (let i = 1; i < n; i++) row[i] = Math.round(row[i] * aa * 1e9) / 1e9;
      }
      rows.push(row);
      setOf.push(si);
    });
  });
  return { rows, setOf };
}

function buildPayloadFromState(
  st: RunState,
  rowsCache: number[][],
  triBlank: Set<number>,
  triMeta: any[]
): any {
  const d = JSON.parse(JSON.stringify(st));
  d.customRows = rowsCache;
  d.mode = 'concentration';
  delete d.sets;
  delete d.tri;

  if (st.mode === 'triplet') {
    d.randomize = false;
    d.blankRows = [...triBlank];
    d.additiveCodes = (st.tri?.adds || []).map((a) => a.code).filter(Boolean);
    d.rowLabels = triMeta.map((m, i) => {
      if (m.blank) {
        return {
          name: 'blank (solvent only)',
          cond: `plate ${m.plate + 1}, well ${m.well + 1} | blank`,
        };
      }
      const g = st.tri?.groups.find((x: any) => x.name === m.group);
      const mem = g ? g.members.filter(Boolean) : [];
      const conc = st.reagents
        .map((r, j) => ({ r, c: rowsCache[i]?.[j] ?? 0 }))
        .filter((x) => x.c > 0)
        .map((x) => `${x.r.name || x.r.code} ${+x.c.toFixed(3)} mM`);
      return {
        name: `${m.group}: ${mem
          .map((code: string) => st.reagents.find((x) => x.code === code)?.name || code)
          .join(' + ')}`,
        cond: `plate ${m.plate + 1}, well ${m.well + 1}, section ${m.section} | ratio ${m.cond} | ${conc.join('; ')}`,
      };
    });
    d.reagents.forEach((r: any) => {
      if (r.stock === '' || r.stock == null) r.stock = 1;
    });
  }

  d.runName = st.name || 'Untitled HTE run';
  d.modeLabel = st.mode;
  d.product = st.product || {};
  d.flaskSizes = String(st.flasksText || '2, 5, 10, 20, 50, 100')
    .split(/[,;\s]+/)
    .map(Number)
    .filter((x) => x > 0 && isFinite(x));
  delete d.flasksText;
  if (!d.deckPlates) delete d.deckPlates;
  d.reagents.forEach((r: any, i: number) => {
    r.molarMass = +r.molarMass || 0;
    r.density = +r.density || 0;
    r.color = PAL[i % PAL.length];
    r.prepareVolumeMl = 0;
    r.min = 0;
    r.step = 1;
    r.max = 0;
  });
  return d;
}

/**
 * Reconstructs a RunResult + triplet metadata directly from any RunState (for saved runs or tests).
 */
export function buildRunSnapshotFromState(rawState: RunState): {
  state: RunState;
  run: RunResult | null;
  triMeta: any[];
  error?: string;
} {
  const norm = cloneStateNormalized(rawState);
  try {
    let rows: number[][] = [];
    let triBlank = new Set<number>();
    let triMeta: any[] = [];

    if (norm.mode === 'triplet') {
      const tb = triBuildRows(norm);
      if (norm.imported?.rows?.length) {
        rows = norm.imported.rows;
        triBlank = tb
          ? tb.blank
          : new Set<number>(
              rows.map((r, i) => (r.every((c) => c === 0) ? i : -1)).filter((i) => i >= 0)
            );
        triMeta =
          tb && tb.meta.length === rows.length
            ? tb.meta
            : rows.map((r, i) => ({
                plate: Math.floor(i / PLATE_SIZE),
                well: i % PLATE_SIZE,
                blank: r.every((c) => c === 0),
              }));
      } else if (tb) {
        rows = tb.rows;
        triBlank = tb.blank;
        triMeta = tb.meta;
      } else {
        return {
          state: norm,
          run: null,
          triMeta: [],
          error: 'No triplet plate sections assigned.',
        };
      }
    } else {
      const built = buildRowsFromState(norm);
      rows = built.rows;
    }

    const payload = buildPayloadFromState(norm, rows, triBlank, triMeta);
    const run = buildRun(payload);
    return { state: norm, run, triMeta };
  } catch (e: any) {
    return {
      state: norm,
      run: null,
      triMeta: [],
      error: e?.message || String(e),
    };
  }
}

export function toComparableRunFromCurrent(
  state: RunState,
  run: RunResult | null,
  triMeta: any[],
  tlcSets: TlcSet[],
  status: 'draft' | 'exported'
): ComparableRun {
  const hasTlc = tlcSets.some(
    (s) =>
      Object.keys(s.imgs || {}).length > 0 ||
      Object.values(s.plateData || {}).some((pd) => Object.keys(pd?.imgs || {}).length > 0)
  );
  return {
    id: CURRENT_RUN_ID,
    name: `${state.name || 'Untitled run'} (Current)`,
    isCurrent: true,
    updated: Date.now(),
    status,
    tlcStatus: hasTlc ? 'ready' : 'pending',
    state,
    run,
    triMeta,
    tlcSets,
  };
}

export function toComparableRunFromSaved(saved: SavedRun): ComparableRun {
  const rebuilt = buildRunSnapshotFromState(saved.state);
  const tlcSets: TlcSet[] = Array.isArray(saved.tlc_sets)
    ? saved.tlc_sets.map((s) => deserializeTlcSetMeta(s))
    : [];
  const hasTlc =
    saved.tlc_status === 'ready' ||
    tlcSets.some(
      (s) =>
        (s.cfg?.lanes?.some((l) => (l.customSpots?.length || 0) > 0) ?? false) ||
        Object.keys(s.imgs || {}).length > 0
    );
  return {
    id: saved.id,
    name: saved.name,
    isCurrent: false,
    updated: saved.updated || 0,
    status: saved.status || 'draft',
    tlcStatus: hasTlc ? 'ready' : 'pending',
    state: rebuilt.state,
    run: rebuilt.run,
    triMeta: rebuilt.triMeta,
    tlcSets,
    error: rebuilt.error,
  };
}

export function findFirstOccupiedWell(compRun: ComparableRun): {
  plateIndex: number;
  wellIndex: number;
} {
  if (!compRun.run || !compRun.run.rows.length) {
    return { plateIndex: 0, wellIndex: 0 };
  }
  const firstNonBlank = compRun.run.rows.find((r) => {
    const m = compRun.triMeta?.[r.global_index];
    if (m?.blank) return false;
    return r.recipe.some((it) => Number(it.target_concentration) > 0);
  });
  const target = firstNonBlank || compRun.run.rows[0];
  return {
    plateIndex: target.plate_number ?? 0,
    wellIndex: target.container_id ?? 0,
  };
}

function getWellElnObservation(
  state: RunState,
  plateIndex: number,
  wellIndex: number,
  globalIndex: number
): WellObservation | null {
  const wells = state.eln?.wells;
  if (!wells) return null;
  const direct = wells[`${plateIndex}-${wellIndex}`];
  if (direct) return direct;
  if (globalIndex >= 0 && wells[String(globalIndex)]) {
    return wells[String(globalIndex)];
  }
  return null;
}

export function extractWellSnapshot(
  compRun: ComparableRun,
  plateIndex: number,
  wellIndex: number,
  slotUid: string
): WellSnapshot {
  const { state, run, triMeta, tlcSets } = compRun;
  const row: RunRow | null = run
    ? run.rows.find((r) => r.plate_number === plateIndex && r.container_id === wellIndex) ||
      run.rows[plateIndex * PLATE_SIZE + wellIndex] ||
      null
    : null;

  const globalIndex = row ? row.global_index : plateIndex * PLATE_SIZE + wellIndex;
  const meta = row ? triMeta?.[row.global_index] : null;
  const isBlank = Boolean(
    meta?.blank ||
      (row && row.recipe.every((it) => Number(it.target_concentration) <= 0))
  );

  const groupLabel = row
    ? isBlank
      ? 'Blank (Solvent only)'
      : getSuggestedWellDisplay(row, run, triMeta)
    : `Plate ${plateIndex + 1} · ${wellLabel(wellIndex)}`;

  const reagentByCode = new Map((state.reagents || []).map((r, idx) => [r.code, { r, idx }]));
  const activeItems = (row?.recipe || []).filter((it) => Number(it.target_concentration) > 0);

  // Compute reference concentration among organic substrates so concentration-mode wells still show meaningful eq
  const organicConcs: number[] = [];
  for (const it of activeItems) {
    const info = reagentByCode.get(it.code);
    if (!info) continue;
    if (!isKnownAdditiveReagent(info.r, state)) {
      organicConcs.push(Number(it.target_concentration));
    }
  }
  const minOrganicMm = organicConcs.length ? Math.min(...organicConcs) : 0;

  const substrates: WellSnapshotSubstrate[] = activeItems.map((it) => {
    const info = reagentByCode.get(it.code);
    const r = info?.r;
    const isAdd = r ? Boolean(isKnownAdditiveReagent(r, state)) : false;
    const conc = Number(it.target_concentration) || 0;
    const computedEq =
      it.equivalence != null && Number.isFinite(Number(it.equivalence))
        ? Number(it.equivalence)
        : minOrganicMm > 0
        ? Math.round((conc / minOrganicMm) * 100) / 100
        : null;
    return {
      code: it.code,
      name: r?.name || it.name || it.code,
      smiles: (r?.smiles || '').trim(),
      concMm: conc,
      equiv: computedEq,
      transferUl: Number(it.transfer_volume) || 0,
      dilutionLevel: Number(it.dilution_level) || 0,
      color: it.color || PAL[(info?.idx ?? 0) % PAL.length],
      isAdditive: isAdd,
    };
  });

  const extraction = row ? extractWellForPrediction(state, row) : null;
  const solventTransferUl = row ? Number(row['vol#solvent']) || 0 : 0;
  const totalVialUl =
    solventTransferUl + substrates.reduce((s, x) => s + (x.transferUl || 0), 0);

  const eln = getWellElnObservation(state, plateIndex, wellIndex, globalIndex);

  const resolvedSet = tlcSets.length ? resolveTlcSetForPlate(tlcSets, plateIndex) : undefined;
  const laneIndex = tlcLane(wellIndex, 'column');
  const lane = resolvedSet?.cfg?.lanes?.find((l) => l.id === laneIndex) || null;
  const channels: TlcChannelKey[] = [];
  if (resolvedSet?.imgs?.UV254?.bmp) channels.push('UV254');
  if (resolvedSet?.imgs?.UV366?.bmp) channels.push('UV366');
  if (resolvedSet?.imgs?.White?.bmp) channels.push('White');

  const spots: TlcSpot[] = Array.isArray(lane?.customSpots) ? lane!.customSpots! : [];

  return {
    slotUid,
    runId: compRun.id,
    runName: compRun.name,
    isCurrentRun: compRun.isCurrent,
    plateIndex,
    wellIndex,
    wellLabel: wellLabel(wellIndex),
    globalIndex,
    groupLabel,
    isBlank,
    row,
    substrates,
    solventTransferUl,
    totalVialUl,
    extraction,
    eln,
    elnCampaign: {
      reactionClass: state.eln?.reactionClass,
      temperatureC: state.eln?.temperatureC,
      reactionTimeHours: state.eln?.reactionTimeHours,
      atmosphere: state.eln?.atmosphere,
      illumination: state.eln?.illumination,
      agitation: state.eln?.agitation,
    },
    tlc: {
      tlcSet: resolvedSet,
      laneIndex,
      lane,
      spots,
      hasImages: channels.length > 0,
      channels,
    },
  };
}

function summarizeRunEln(run: ComparableRun): RunElnSummary {
  const wells = run.state.eln?.wells || {};
  let totalAnnotated = 0;
  let hits = 0;
  let clean = 0;
  let partial = 0;
  let smOnly = 0;
  let decomp = 0;
  let precipitate = 0;
  let blank = 0;
  const topHits: RunElnSummary['topHits'] = [];

  for (const [k, obs] of Object.entries(wells)) {
    if (!obs) continue;
    const st: WellOutcomeStatus | undefined = obs.status;
    const hasData =
      (st && st !== 'none') ||
      (obs.tags && obs.tags.length > 0) ||
      Boolean(obs.notes && obs.notes.trim()) ||
      obs.conversion != null ||
      obs.yield != null;
    if (!hasData) continue;
    totalAnnotated++;
    if (st === 'hit') hits++;
    else if (st === 'clean') clean++;
    else if (st === 'partial') partial++;
    else if (st === 'sm_only') smOnly++;
    else if (st === 'decomp') decomp++;
    else if (st === 'precipitate') precipitate++;
    else if (st === 'blank') blank++;

    if (st === 'hit' || st === 'clean') {
      const pIdx = Number.isFinite(Number(obs.plateIndex))
        ? Number(obs.plateIndex)
        : k.includes('-')
        ? Number(k.split('-')[0]) || 0
        : Math.floor((Number(k) || 0) / PLATE_SIZE);
      const wIdx = Number.isFinite(Number(obs.wellIndex))
        ? Number(obs.wellIndex)
        : k.includes('-')
        ? Number(k.split('-')[1]) || 0
        : (Number(k) || 0) % PLATE_SIZE;
      topHits.push({
        plateIndex: pIdx,
        wellIndex: wIdx,
        label: `P${pIdx + 1}-${wellLabel(wIdx)}`,
        conversion: obs.conversion ?? null,
        yield: obs.yield ?? null,
      });
    }
  }

  topHits.sort((a, b) => (b.yield ?? b.conversion ?? 0) - (a.yield ?? a.conversion ?? 0));

  return {
    totalAnnotated,
    hits,
    clean,
    partial,
    smOnly,
    decomp,
    precipitate,
    blank,
    topHits: topHits.slice(0, 5),
  };
}

function reagentMatchKey(r: { smiles?: string; name?: string; code?: string }, idx: number): string {
  const smi = (r.smiles || '').trim();
  if (smi) return `smi:${smi}`;
  const nm = (r.name || '').trim().toLowerCase();
  if (nm) return `name:${nm}`;
  const cd = (r.code || '').trim().toLowerCase();
  if (cd) return `code:${cd}`;
  return `idx:${idx}`;
}

export function compareRunsSummary(runs: ComparableRun[]): MultiRunComparisonResult {
  const elnSummaries = runs.map(summarizeRunEln);

  const rawParamSpecs: Array<{
    key: string;
    label: string;
    get: (r: ComparableRun, eln: RunElnSummary) => string | number;
  }> = [
    { key: 'mode', label: 'Screening mode', get: (r) => r.state.mode || '—' },
    { key: 'hood', label: 'Robot hood', get: (r) => r.state.hood || '—' },
    {
      key: 'vialVolume',
      label: 'Vial volume (µL)',
      get: (r) => (r.state.vialVolume !== '' && r.state.vialVolume != null ? Number(r.state.vialVolume) : '—'),
    },
    {
      key: 'threshold',
      label: 'Direct limit (µL)',
      get: (r) => (r.state.threshold !== '' && r.state.threshold != null ? Number(r.state.threshold) : '—'),
    },
    {
      key: 'dilutionFactor',
      label: 'Dilution factor',
      get: (r) => (r.state.dilutionFactor !== '' && r.state.dilutionFactor != null ? `${r.state.dilutionFactor}×` : '—'),
    },
    {
      key: 'solvent',
      label: 'Reaction solvent',
      get: (r) => canonicalSolvent(r.state.reactionSolvent || '') || r.state.reactionSolvent || '—',
    },
    {
      key: 'leftover',
      label: 'Leftover reserve (mL)',
      get: (r) => (r.state.leftoverMl !== '' && r.state.leftoverMl != null ? Number(r.state.leftoverMl) : '—'),
    },
    {
      key: 'reactions',
      label: 'Active wells / combos',
      get: (r) =>
        r.run
          ? r.state.mode === 'triplet'
            ? r.triMeta.filter((m) => !m?.blank).length
            : r.run.reactions
          : '—',
    },
    {
      key: 'plates',
      label: 'Plates',
      get: (r) => (r.run ? r.run.plates : '—'),
    },
    {
      key: 'stocks',
      label: 'Stock bottles',
      get: (r) => (r.run ? Object.keys(r.run.stocks).length : '—'),
    },
    {
      key: 'tips',
      label: 'Tips (50 / 300 / 1000)',
      get: (r) =>
        r.run ? `${r.run.tipCounts[50]} / ${r.run.tipCounts[300]} / ${r.run.tipCounts[1000]}` : '—',
    },
    {
      key: 'tlcStatus',
      label: 'TLC data',
      get: (r) => (r.tlcStatus === 'ready' ? 'Ready' : 'Pending'),
    },
    {
      key: 'elnTemp',
      label: 'ELN temperature (°C)',
      get: (r) => (r.state.eln?.temperatureC != null && r.state.eln?.temperatureC !== '' ? `${r.state.eln.temperatureC} °C` : '—'),
    },
    {
      key: 'elnTime',
      label: 'Reaction time (h)',
      get: (r) => (r.state.eln?.reactionTimeHours != null && r.state.eln?.reactionTimeHours !== '' ? `${r.state.eln.reactionTimeHours} h` : '—'),
    },
    {
      key: 'elnAtmosphere',
      label: 'Atmosphere',
      get: (r) => r.state.eln?.atmosphere || '—',
    },
    {
      key: 'elnOutcomes',
      label: 'ELN outcomes',
      get: (_r, eln) =>
        eln.totalAnnotated > 0
          ? `${eln.hits} hit · ${eln.clean} clean · ${eln.partial} partial (${eln.totalAnnotated} notes)`
          : 'No ELN notes',
    },
  ];

  const parameterRows: RunComparisonParamRow[] = rawParamSpecs.map((spec) => {
    const values = runs.map((r, i) => spec.get(r, elnSummaries[i]));
    const base = String(values[0] ?? '');
    const diffFromBaseline = values.map((v, i) => (i === 0 ? false : String(v ?? '') !== base));
    const hasDiff = new Set(values.map((v) => String(v ?? ''))).size > 1;
    return {
      key: spec.key,
      label: spec.label,
      values,
      hasDiff,
      diffFromBaseline,
    };
  });

  // Align reagents across all runs by SMILES > name > code
  const orderKeys: string[] = [];
  const runMaps = runs.map((comp) => {
    const map = new Map<string, AlignedReagentEntry>();
    const usedKeys = new Map<string, number>();
    (comp.state.reagents || []).forEach((r, idx) => {
      let baseKey = reagentMatchKey(r, idx);
      const seenCount = usedKeys.get(baseKey) || 0;
      usedKeys.set(baseKey, seenCount + 1);
      if (seenCount > 0) baseKey = `${baseKey}#${seenCount}`;
      if (!orderKeys.includes(baseKey)) orderKeys.push(baseKey);
      map.set(baseKey, {
        reagent: r,
        color: PAL[idx % PAL.length],
        index: idx,
      });
    });
    return map;
  });

  const reagentRows: AlignedReagentRow[] = orderKeys.map((key) => {
    const entries = runMaps.map((m) => m.get(key) || null);
    const present = entries.filter((e): e is AlignedReagentEntry => Boolean(e));
    const first = present[0]?.reagent;

    const uniq = (fn: (r: Reagent) => string) =>
      new Set(present.map((e) => fn(e.reagent))).size > 1;

    const missingAny = present.length < runs.length;
    const diffFlags = {
      name: uniq((r) => (r.name || '').trim()),
      molarMass: uniq((r) => String(Number(r.molarMass) || 0)),
      density: uniq((r) => String(Number(r.density) || 0)),
      stock: uniq((r) => String(Number(r.stock) || 0)),
      solvent: uniq((r) => canonicalSolvent(r.solvent || '')),
      smiles: uniq((r) => (r.smiles || '').trim()),
      missingAny,
    };

    const hasDiff = Object.values(diffFlags).some(Boolean);
    const firstWithSmi = present.find((e) => (e.reagent.smiles || '').trim());

    return {
      key,
      displayName: first?.name || first?.code || 'Unnamed reagent',
      displayCode: present.map((e) => e.reagent.code).filter((v, i, a) => a.indexOf(v) === i).join(' / '),
      smiles: (firstWithSmi?.reagent.smiles || '').trim(),
      entries,
      hasDiff,
      diffFlags,
    };
  });

  return {
    runs,
    parameterRows,
    reagentRows,
    elnSummaries,
  };
}

function formatParamRow(
  key: string,
  label: string,
  values: Array<string | number>
): WellConditionComparisonRow {
  const base = String(values[0] ?? '');
  const diffFromBaseline = values.map((v, i) => (i === 0 ? false : String(v ?? '') !== base));
  const hasDiff = new Set(values.map((v) => String(v ?? ''))).size > 1;
  return { key, label, values, hasDiff, diffFromBaseline };
}

export function buildWellComparisonMatrix(
  snapshots: WellSnapshot[],
  predictions: Record<string, WellPredictionResult> = {}
): MultiWellComparisonResult {
  // 1. Align substrates/reagents across selected wells
  const reagentKeys: string[] = [];
  const slotMaps = snapshots.map((snap) => {
    const m = new Map<string, WellSnapshotSubstrate>();
    snap.substrates.forEach((sub, idx) => {
      const k = reagentMatchKey({ smiles: sub.smiles, name: sub.name, code: sub.code }, idx);
      if (!reagentKeys.includes(k)) reagentKeys.push(k);
      m.set(k, sub);
    });
    return m;
  });

  const reagentRows: WellReagentComparisonRow[] = reagentKeys.map((key) => {
    const cells = slotMaps.map((m) => {
      const sub = m.get(key);
      if (!sub) {
        return {
          present: false,
          concMm: 0,
          equiv: null,
          transferUl: 0,
          dilutionLevel: 0,
          color: '#777',
          code: '',
        };
      }
      return {
        present: true,
        concMm: sub.concMm,
        equiv: sub.equiv,
        transferUl: sub.transferUl,
        dilutionLevel: sub.dilutionLevel,
        color: sub.color,
        code: sub.code,
      };
    });

    const firstPresent = snapshots
      .map((_s, i) => slotMaps[i].get(key))
      .find((x): x is WellSnapshotSubstrate => Boolean(x));

    const concs = new Set(cells.map((c) => (c.present ? c.concMm.toFixed(3) : 'absent')));
    const eqs = new Set(cells.map((c) => (c.present && c.equiv != null ? c.equiv.toFixed(2) : 'absent')));
    const hasDiff = concs.size > 1 || eqs.size > 1;

    return {
      key,
      displayName: firstPresent?.name || firstPresent?.code || 'Component',
      displayCode: firstPresent?.code || '',
      smiles: firstPresent?.smiles || '',
      isAdditive: Boolean(firstPresent?.isAdditive),
      cells,
      hasDiff,
    };
  });

  // 2. Conditions comparison rows
  const conditionRows: WellConditionComparisonRow[] = [
    formatParamRow(
      'group',
      'Reaction / Group',
      snapshots.map((s) => s.groupLabel || '—')
    ),
    formatParamRow(
      'solvent',
      'Reaction solvent',
      snapshots.map((s) => s.extraction?.condition.solvent || s.row ? (s.extraction?.condition.solvent || '—') : '—')
    ),
    formatParamRow(
      'medium',
      'Acid / Base regime',
      snapshots.map((s) => {
        const pred = predictions[s.slotUid];
        if (pred) return `${pred.acidBase.effectiveMedium} (pH ${pred.acidBase.effectivePhDmso.toFixed(1)})`;
        const c = s.extraction?.condition;
        if (!c) return '—';
        return c.additiveEquiv > 0 ? `${c.medium} (${c.additiveName} ${c.additiveEquiv} eq)` : c.medium;
      })
    ),
    formatParamRow(
      'temp',
      'Temperature',
      snapshots.map((s) => {
        const t = s.extraction?.condition.temperatureC ?? s.elnCampaign.temperatureC;
        return t != null && t !== '' ? `${t} °C` : '—';
      })
    ),
    formatParamRow(
      'time',
      'Reaction time',
      snapshots.map((s) =>
        s.elnCampaign.reactionTimeHours != null && s.elnCampaign.reactionTimeHours !== ''
          ? `${s.elnCampaign.reactionTimeHours} h`
          : '—'
      )
    ),
    formatParamRow(
      'atmosphere',
      'Atmosphere',
      snapshots.map((s) => s.elnCampaign.atmosphere || '—')
    ),
    formatParamRow(
      'illumination',
      'Illumination',
      snapshots.map((s) => s.elnCampaign.illumination || '—')
    ),
    formatParamRow(
      'solventVol',
      'Makeup solvent (µL)',
      snapshots.map((s) => (s.row ? `${s.solventTransferUl.toFixed(1)} µL` : '—'))
    ),
    formatParamRow(
      'totalVol',
      'Total vial volume (µL)',
      snapshots.map((s) => (s.row ? `${s.totalVialUl.toFixed(1)} µL` : '—'))
    ),
  ];

  // 3. ELN Outcomes comparison rows
  const statusDisplay: Record<string, string> = {
    hit: 'Top Hit',
    clean: 'Clean Conversion',
    partial: 'Partial Conversion',
    sm_only: 'Starting Material Only',
    decomp: 'Decomposition',
    precipitate: 'Precipitate / Clogged',
    blank: 'Blank / Control',
    none: 'Unassigned',
  };
  const elnRows: WellConditionComparisonRow[] = [
    formatParamRow(
      'status',
      'Outcome status',
      snapshots.map((s) => statusDisplay[s.eln?.status || 'none'] || 'Unassigned')
    ),
    formatParamRow(
      'conversion',
      'Conversion (%)',
      snapshots.map((s) => (s.eln?.conversion != null ? `${s.eln.conversion}%` : '—'))
    ),
    formatParamRow(
      'yield',
      'Yield (%)',
      snapshots.map((s) => (s.eln?.yield != null ? `${s.eln.yield}%` : '—'))
    ),
    formatParamRow(
      'tags',
      'Observation tags',
      snapshots.map((s) => (s.eln?.tags?.length ? s.eln.tags.join(', ') : '—'))
    ),
    formatParamRow(
      'notes',
      'Lab notes',
      snapshots.map((s) => (s.eln?.notes?.trim() ? s.eln.notes.trim() : '—'))
    ),
  ];

  // 4. TLC Spot / Rf alignment bands across wells (cluster spots within ±0.05 Rf)
  const allSpots: Array<{ slotIdx: number; spot: TlcSpot }> = [];
  snapshots.forEach((s, slotIdx) => {
    s.tlc.spots.forEach((sp) => {
      allSpots.push({ slotIdx, spot: sp });
    });
  });
  allSpots.sort((a, b) => a.spot.rf - b.spot.rf);

  const clusters: Array<{ spots: Array<{ slotIdx: number; spot: TlcSpot }> }> = [];
  for (const item of allSpots) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push({ spots: [item] });
      continue;
    }
    const meanRf = last.spots.reduce((acc, x) => acc + x.spot.rf, 0) / last.spots.length;
    const alreadyHasSlot = last.spots.some((x) => x.slotIdx === item.slotIdx);
    if (!alreadyHasSlot && Math.abs(item.spot.rf - meanRf) <= 0.05) {
      last.spots.push(item);
    } else {
      clusters.push({ spots: [item] });
    }
  }

  const rfBands: TlcRfBandRow[] = clusters.map((cl, bandIndex) => {
    const rfs = cl.spots.map((x) => x.spot.rf);
    const anchorRf = cl.spots.find((x) => x.slotIdx === 0)?.spot.rf ?? rfs[0];
    const cells = snapshots.map((_s, idx) => {
      const hit = cl.spots.find((x) => x.slotIdx === idx);
      if (!hit) return { matched: false, spot: null, deltaRf: null };
      const deltaRf = idx === 0 ? 0 : +(hit.spot.rf - anchorRf).toFixed(3);
      return { matched: true, spot: hit.spot, deltaRf };
    });
    return {
      bandIndex: bandIndex + 1,
      anchorRf: +(rfs.reduce((a, b) => a + b, 0) / rfs.length).toFixed(3),
      rfMin: Math.min(...rfs),
      rfMax: Math.max(...rfs),
      cells,
    };
  });

  // 5. Predicted products alignment matrix
  const predictedSlotCount = snapshots.filter((s) => Boolean(predictions[s.slotUid])).length;
  const speciesOrder: string[] = [];
  const speciesMeta = new Map<string, PredictedSpecies>();
  const speciesSlotCells = new Map<
    string,
    Map<number, { rank: number; score: number; tier: PredictedSpecies['tier'] }>
  >();

  snapshots.forEach((snap, sIdx) => {
    const res = predictions[snap.slotUid];
    if (!res) return;
    res.species.slice(0, 12).forEach((sp, rankIdx) => {
      const k = sp.smiles || sp.key;
      if (!speciesOrder.includes(k)) {
        speciesOrder.push(k);
        speciesMeta.set(k, sp);
        speciesSlotCells.set(k, new Map());
      }
      const m = speciesSlotCells.get(k)!;
      if (!m.has(sIdx)) {
        m.set(sIdx, { rank: rankIdx + 1, score: sp.score, tier: sp.tier });
      }
    });
  });

  const productRows: ProductComparisonRow[] = speciesOrder
    .map((k) => {
      const sp = speciesMeta.get(k)!;
      const slotMap = speciesSlotCells.get(k)!;
      const cells = snapshots.map((_s, sIdx) => {
        const hit = slotMap.get(sIdx);
        return hit
          ? { present: true, rank: hit.rank, score: hit.score, tier: hit.tier }
          : { present: false, rank: null, score: null, tier: null };
      });
      const presentCount = cells.filter((c) => c.present).length;
      const maxScore = Math.max(...cells.map((c) => c.score ?? 0));
      const presenceKind: ProductComparisonRow['presenceKind'] =
        predictedSlotCount > 1 && presentCount === predictedSlotCount
          ? 'shared'
          : presentCount > 1
          ? 'partial'
          : 'unique';
      return {
        key: k,
        smiles: sp.smiles,
        formula: sp.formula,
        exactMass: sp.exactMass,
        mhPlus: sp.mhPlus,
        mNaPlus: sp.mNaPlus,
        mHMinus: sp.mHMinus,
        mechanismSummary: sp.mechanismSummary,
        status: sp.status,
        presenceKind,
        presentCount,
        maxScore,
        cells,
      };
    })
    .sort((a, b) => b.presentCount - a.presentCount || b.maxScore - a.maxScore);

  return {
    snapshots,
    reagentRows,
    conditionRows,
    elnRows,
    rfBands,
    productRows,
  };
}
