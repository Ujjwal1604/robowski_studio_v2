import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Grid3x3,
  Printer,
  Scale,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Upload,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  WellOutcomeStatus,
  WellObservation,
  HteElnRecord,
  RecipeItem,
} from '../../types';
import {
  PAL,
  elnObservationsCsv,
  elnObservationsXlsxBytes,
  parseElnSpreadsheet,
  readTableFile,
  tlcLane,
  wellLabel,
} from '../../engine';
import { AiSynthesisReport } from '../ui/AiSynthesisReport';
import { WellTlcPreview } from '../ui/WellTlcPreview';

const PLATE_SIZE = 54;
const ROWS = 6;
const COLS = 9;
const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const OBSERVATION_TAGS: {
  id: string;
  label: string;
  short: string;
  color: string;
  tint: string;
  desc: string;
  hotkey?: string;
}[] = [
  { id: 'polymerized', label: 'Polymerized', short: 'Poly', color: '#8b5cf6', tint: 'rgba(139, 92, 246, 0.14)', desc: 'Solid, rubbery plug, or cross-linked gel', hotkey: 'P' },
  { id: 'precipitated', label: 'Precipitated', short: 'Ppt', color: '#d97706', tint: 'rgba(217, 119, 6, 0.14)', desc: 'Solid precipitate, suspension, or flocculation', hotkey: 'C' },
  { id: 'volume_decreased', label: 'Volume Loss', short: 'Vol↓', color: '#0284c7', tint: 'rgba(2, 132, 199, 0.14)', desc: 'Evaporation, septum leak, or consumption', hotkey: 'V' },
  { id: 'gas_evolution', label: 'Gas Evolution', short: 'Gas', color: '#0891b2', tint: 'rgba(8, 145, 178, 0.14)', desc: 'Bubbling, foaming, or pressurization', hotkey: 'G' },
  { id: 'color_change', label: 'Color Change', short: 'Color', color: '#db2777', tint: 'rgba(219, 39, 119, 0.13)', desc: 'Significant color shift' },
  { id: 'biphasic', label: 'Biphasic / Oil', short: '2-Phase', color: '#ca8a04', tint: 'rgba(202, 138, 4, 0.13)', desc: 'Phase separation, oil droplets, or emulsion' },
  { id: 'viscous_gel', label: 'Viscous / Gelled', short: 'Gel', color: '#b45309', tint: 'rgba(180, 83, 9, 0.13)', desc: 'Thickened liquid or high viscosity' },
  { id: 'turbid', label: 'Turbid / Cloudy', short: 'Turbid', color: '#64748b', tint: 'rgba(100, 116, 139, 0.14)', desc: 'Hazy, colloidal suspension' },
  { id: 'homogeneous', label: 'Homogeneous', short: 'Clear', color: '#059669', tint: 'rgba(5, 150, 105, 0.13)', desc: 'Clear, single-phase solution' },
];

const OUTCOME_OPTIONS: {
  id: WellOutcomeStatus;
  label: string;
  short: string;
  color: string;
  bg: string;
  hotkey?: string;
}[] = [
  { id: 'hit', label: 'Top Hit', short: 'HIT', color: '#059669', bg: 'rgba(16, 185, 129, 0.14)', hotkey: '1' },
  { id: 'clean', label: 'Clean Conversion', short: 'OK', color: '#10b981', bg: 'rgba(16, 185, 129, 0.10)', hotkey: '2' },
  { id: 'partial', label: 'Partial Conversion', short: 'PART', color: '#d97706', bg: 'rgba(245, 158, 11, 0.12)', hotkey: '3' },
  { id: 'sm_only', label: 'Starting Material', short: 'SM', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.11)', hotkey: '4' },
  { id: 'decomp', label: 'Decomposition', short: 'DEC', color: '#dc2626', bg: 'rgba(239, 68, 68, 0.12)', hotkey: '5' },
  { id: 'precipitate', label: 'Precipitate / Clogged', short: 'PPT', color: '#d97706', bg: 'rgba(245, 158, 11, 0.14)' },
  { id: 'blank', label: 'Blank / Control', short: 'BLK', color: '#64748b', bg: 'rgba(148, 163, 184, 0.12)' },
];

const QUICK_SPREADSHEET_TAGS = ['polymerized', 'precipitated', 'volume_decreased', 'gas_evolution', 'homogeneous'];

function downloadBlob(filename: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = filename;
  document.body.appendChild(el);
  el.click();
  el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeSlug(name: string): string {
  return (name || 'robowski_run').replace(/[^A-Za-z0-9_-]+/g, '_');
}

export const ElnView: React.FC = () => {
  const {
    state,
    setState,
    run,
    rowsCache,
    triMeta,
    tlcSets,
    setView,
    setVisited,
    setTargetWell,
    toast,
  } = useApp();

  // Workspace organization state
  const [subTab, setSubTab] = useState<'observations' | 'scaleup' | 'synthesis'>('observations');
  const [workspaceMode, setWorkspaceMode] = useState<'matrix' | 'spreadsheet'>('matrix');
  const [conditionsOpen, setConditionsOpen] = useState<boolean>(false);

  // Matrix & selection state
  const [activePlate, setActivePlate] = useState<number>(0);
  const [selectedWellIdx, setSelectedWellIdx] = useState<number>(0);
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [batchSelection, setBatchSelection] = useState<number[]>([]);
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);

  // Spreadsheet state
  const [sheetScope, setSheetScope] = useState<'plate' | 'all'>('plate');
  const [sheetSearch, setSheetSearch] = useState<string>('');
  const [sheetDragOver, setSheetDragOver] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  const scrollToInspector = useCallback(() => {
    requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  // Scale-up state
  const [scaleUpScaleMmol, setScaleUpScaleMmol] = useState<number>(1.0);
  const [copiedProc, setCopiedProc] = useState<boolean>(false);

  // Safely get or initialize ELN record
  const eln: HteElnRecord = useMemo(() => {
    return (
      state.eln || {
        campaignTitle: state.name || '',
        objective: '',
        reactionClass: 'Cross-Coupling',
        temperatureC: 25,
        reactionTimeHours: 16,
        atmosphere: 'N2 Glovebox',
        agitation: 'Tumble stirrer 800 rpm',
        illumination: 'None',
        plateSealType: 'Teflon silicone bonded mat',
        postReactionNotes: '',
        wells: {},
        scaleUpMmol: 1.0,
      }
    );
  }, [state.eln, state.name]);

  const numPlates = run?.plates || Math.max(1, Math.ceil(rowsCache.length / PLATE_SIZE));
  const totalWellsCount = Math.max(run?.rows?.length || 0, numPlates * PLATE_SIZE);

  // Update top-level ELN fields
  const updateEln = useCallback(
    (patch: Partial<HteElnRecord>) => {
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.eln = { ...(next.eln || {}), ...patch };
        return next;
      });
    },
    [setState]
  );

  // Update a single well's observation
  const updateWell = useCallback(
    (pIdx: number, wIdx: number, patch: Partial<WellObservation>) => {
      const key = `${pIdx}-${wIdx}`;
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        const curWells = next.eln?.wells || {};
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: pIdx, status: 'none', tags: [] };
        curWells[key] = { ...cur, ...patch };
        next.eln = { ...(next.eln || {}), wells: curWells };
        return next;
      });
    },
    [setState]
  );

  // Toggle a physical observation tag on a single well
  const toggleWellTag = useCallback(
    (pIdx: number, wIdx: number, tagId: string) => {
      const key = `${pIdx}-${wIdx}`;
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        const curWells = next.eln?.wells || {};
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: pIdx, status: 'none', tags: [] };
        const tags: string[] = Array.isArray(cur.tags) ? [...cur.tags] : [];
        const exists = tags.includes(tagId);
        curWells[key] = {
          ...cur,
          tags: exists ? tags.filter((t) => t !== tagId) : [...tags, tagId],
        };
        next.eln = { ...(next.eln || {}), wells: curWells };
        return next;
      });
    },
    [setState]
  );

  // Batch update helpers
  const applyBatchObservation = (tag: string) => {
    if (!batchSelection.length) {
      toast('Select at least one well, row, or column first.');
      return;
    }
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const curWells = next.eln?.wells || {};
      batchSelection.forEach((wIdx) => {
        const key = `${activePlate}-${wIdx}`;
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: activePlate, status: 'none', tags: [] };
        const tags = cur.tags ? [...cur.tags] : [];
        if (!tags.includes(tag)) tags.push(tag);
        curWells[key] = { ...cur, tags };
      });
      next.eln = { ...(next.eln || {}), wells: curWells };
      return next;
    });
    toast(`Tagged ${batchSelection.length} well(s) as ${tag.replace('_', ' ')}.`);
  };

  const applyBatchStatus = (status: WellOutcomeStatus) => {
    if (!batchSelection.length) {
      toast('Select at least one well, row, or column first.');
      return;
    }
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const curWells = next.eln?.wells || {};
      batchSelection.forEach((wIdx) => {
        const key = `${activePlate}-${wIdx}`;
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: activePlate, status: 'none', tags: [] };
        curWells[key] = { ...cur, status, scaleUpSelected: status === 'hit' };
      });
      next.eln = { ...(next.eln || {}), wells: curWells };
      return next;
    });
    toast(`Set outcome to ${status.replace('_', ' ')} for ${batchSelection.length} well(s).`);
  };

  // Row / Column 1-click batch selection toggles
  const toggleLineSelection = (indices: number[], label: string) => {
    setBatchMode(true);
    setBatchSelection((prev) => {
      const allSelected = indices.every((idx) => prev.includes(idx));
      if (allSelected) {
        const next = prev.filter((idx) => !indices.includes(idx));
        if (next.length === 0) setBatchMode(false);
        return next;
      }
      const nextSet = new Set([...prev, ...indices]);
      toast(`Selected ${label} (${indices.length} wells)`);
      return Array.from(nextSet).sort((a, b) => a - b);
    });
  };

  // Map run.rows explicitly by (plate_number, container_id) for 100% consistent well-to-recipe lookup
  const rowByPlateWell = useMemo(() => {
    const map = new Map<string, any>();
    if (run?.rows) {
      run.rows.forEach((r: any, idx: number) => {
        const p = r.plate_number ?? Math.floor(idx / PLATE_SIZE);
        const w = r.container_id ?? (idx % PLATE_SIZE);
        map.set(`${p}-${w}`, r);
      });
    }
    return map;
  }, [run]);

  // Current selected well data
  const currentGlobalIdx = activePlate * PLATE_SIZE + selectedWellIdx;
  const currentWellKey = `${activePlate}-${selectedWellIdx}`;
  const currentWellObs: WellObservation = (eln.wells && eln.wells[currentWellKey]) || {
    wellIndex: selectedWellIdx,
    plateIndex: activePlate,
    status: 'none',
    tags: [],
    notes: '',
  };

  const currentRunRow =
    rowByPlateWell.get(`${activePlate}-${selectedWellIdx}`) ??
    (run && run.rows ? run.rows[currentGlobalIdx] : null);
  const currentRecipe: RecipeItem[] = currentRunRow ? currentRunRow.recipe : [];
  const currentTriIdx = currentRunRow?.global_index ?? currentGlobalIdx;
  const currentLabel =
    currentRunRow?.label ||
    (triMeta && triMeta[currentTriIdx]
      ? {
          name: triMeta[currentTriIdx].blank
            ? 'blank (solvent only)'
            : `${triMeta[currentTriIdx].group || 'Well'}`,
          cond: `Plate ${activePlate + 1}, Well ${wellLabel(selectedWellIdx)} · Section ${triMeta[currentTriIdx].section}`,
        }
      : null);

  const activeTlcSet = tlcSets && (tlcSets[activePlate] || tlcSets[0]);

  const assignOutcomeAndMaybeAdvance = useCallback(
    (status: WellOutcomeStatus, allowAutoAdvance: boolean) => {
      if (currentWellObs.status === status) {
        updateWell(activePlate, selectedWellIdx, {
          status: 'none',
          scaleUpSelected: false,
        });
        return;
      }
      updateWell(activePlate, selectedWellIdx, {
        status,
        scaleUpSelected: status === 'hit',
      });
      if (status === 'hit') {
        updateEln({ selectedHitWell: currentGlobalIdx });
      }
      if (allowAutoAdvance && autoAdvance && !batchMode) {
        setSelectedWellIdx((prev) => (prev + 1 < PLATE_SIZE ? prev + 1 : 0));
      }
    },
    [
      currentWellObs.status,
      activePlate,
      selectedWellIdx,
      currentGlobalIdx,
      autoAdvance,
      batchMode,
      updateWell,
      updateEln,
    ]
  );

  // Rapid Keyboard & Hotkey Navigation in Matrix View
  useEffect(() => {
    if (subTab !== 'observations' || workspaceMode !== 'matrix') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedWellIdx((prev) => (prev + 1) % PLATE_SIZE);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedWellIdx((prev) => (prev - 1 + PLATE_SIZE) % PLATE_SIZE);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedWellIdx((prev) => (prev + COLS) % PLATE_SIZE);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedWellIdx((prev) => (prev - COLS + PLATE_SIZE) % PLATE_SIZE);
      } else if (e.key === '1') {
        e.preventDefault();
        assignOutcomeAndMaybeAdvance('hit', true);
      } else if (e.key === '2') {
        e.preventDefault();
        assignOutcomeAndMaybeAdvance('clean', true);
      } else if (e.key === '3') {
        e.preventDefault();
        assignOutcomeAndMaybeAdvance('partial', true);
      } else if (e.key === '4') {
        e.preventDefault();
        assignOutcomeAndMaybeAdvance('sm_only', true);
      } else if (e.key === '5') {
        e.preventDefault();
        assignOutcomeAndMaybeAdvance('decomp', true);
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        toggleWellTag(activePlate, selectedWellIdx, 'polymerized');
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        toggleWellTag(activePlate, selectedWellIdx, 'precipitated');
      } else if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        toggleWellTag(activePlate, selectedWellIdx, 'volume_decreased');
      } else if (e.key.toLowerCase() === 'g') {
        e.preventDefault();
        toggleWellTag(activePlate, selectedWellIdx, 'gas_evolution');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    subTab,
    workspaceMode,
    activePlate,
    selectedWellIdx,
    assignOutcomeAndMaybeAdvance,
    toggleWellTag,
  ]);

  // Statistics across the campaign
  const stats = useMemo(() => {
    const allWells = Object.values(eln.wells || {});
    const hits = allWells.filter((w) => w.status === 'hit').length;
    const clean = allWells.filter((w) => w.status === 'clean').length;
    const scored = allWells.filter((w) => w.status && w.status !== 'none').length;
    const poly = allWells.filter((w) => w.tags?.includes('polymerized')).length;
    const precip = allWells.filter((w) => w.tags?.includes('precipitated')).length;
    const volLoss = allWells.filter(
      (w) => w.tags?.includes('volume_decreased') || w.tags?.includes('gas_evolution')
    ).length;
    return { hits, clean, scored, poly, precip, volLoss };
  }, [eln.wells]);

  const plateCounts = useMemo(() => {
    let unscored = 0;
    let hits = 0;
    let poly = 0;
    let precip = 0;
    let volLoss = 0;
    let notes = 0;
    for (let w = 0; w < PLATE_SIZE; w++) {
      const gIdx = activePlate * PLATE_SIZE + w;
      const isBlank = Boolean(triMeta && triMeta[gIdx]?.blank);
      const obs = eln.wells?.[`${activePlate}-${w}`];
      if ((!obs?.status || obs.status === 'none') && !isBlank) unscored++;
      if (obs?.status === 'hit') hits++;
      if (obs?.tags?.includes('polymerized')) poly++;
      if (obs?.tags?.includes('precipitated')) precip++;
      if (obs?.tags?.includes('volume_decreased') || obs?.tags?.includes('gas_evolution')) volLoss++;
      if ((obs?.notes || '').trim()) notes++;
    }
    return { unscored, hits, poly, precip, volLoss, notes };
  }, [activePlate, eln.wells, triMeta]);

  // Export Spreadsheet handlers
  const handleExportCsv = () => {
    try {
      const csv = elnObservationsCsv(state, run, tlcSets, triMeta);
      downloadBlob(`${safeSlug(state.name)}_eln_observations.csv`, csv, 'text/csv;charset=utf-8');
      toast('Exported ELN observations spreadsheet (.csv).');
    } catch (e: any) {
      toast('Could not export CSV: ' + e.message);
    }
  };

  const handleExportXlsx = () => {
    try {
      const bytes = elnObservationsXlsxBytes(state, run, tlcSets, triMeta);
      downloadBlob(
        `${safeSlug(state.name)}_eln_observations.xlsx`,
        bytes as BlobPart,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      toast('Exported ELN observations workbook (.xlsx).');
    } catch (e: any) {
      toast('Could not export XLSX: ' + e.message);
    }
  };

  // Import Spreadsheet handler
  const handleImportSpreadsheetFile = async (file: File) => {
    try {
      const sheets = await readTableFile(file);
      const res = parseElnSpreadsheet(sheets, eln.wells || {}, numPlates);
      updateEln({ wells: res.wells });
      toast(
        `Imported observations for ${res.updatedCount} well(s) from ${file.name}${
          res.skippedCount ? ` (${res.skippedCount} skipped)` : ''
        }.`
      );
    } catch (e: any) {
      toast('Import failed: ' + (e?.message || e));
    }
  };

  // Spreadsheet rows filtered by scope, tagFilter, and search query
  const spreadsheetRows = useMemo(() => {
    const startPlate = sheetScope === 'all' ? 0 : activePlate;
    const endPlate = sheetScope === 'all' ? numPlates - 1 : activePlate;
    const list: Array<{
      pIdx: number;
      wIdx: number;
      gIdx: number;
      coord: string;
      obs: WellObservation;
      recipeSummary: string;
      condLabel: string;
      isBlank: boolean;
      spotCount: number;
      mainRf: string;
    }> = [];

    const q = sheetSearch.trim().toLowerCase();

    for (let p = startPlate; p <= endPlate; p++) {
      const tlcSetForPlate = tlcSets?.[p] || tlcSets?.[0];
      for (let w = 0; w < PLATE_SIZE; w++) {
        const gIdx = p * PLATE_SIZE + w;
        if (gIdx >= totalWellsCount && p > 0) continue;

        const key = `${p}-${w}`;
        const obs: WellObservation = (eln.wells && eln.wells[key]) || {
          wellIndex: w,
          plateIndex: p,
          status: 'none',
          tags: [],
        };
        const isBlank = Boolean(triMeta && triMeta[gIdx]?.blank);

        const matchesChip =
          tagFilter === 'all' ||
          (tagFilter === 'unscored' && (!obs.status || obs.status === 'none') && !isBlank) ||
          (tagFilter === 'hit' && obs.status === 'hit') ||
          (tagFilter === 'polymerized' && obs.tags?.includes('polymerized')) ||
          (tagFilter === 'precipitated' && obs.tags?.includes('precipitated')) ||
          (tagFilter === 'volume_decreased' &&
            (obs.tags?.includes('volume_decreased') || obs.tags?.includes('gas_evolution'))) ||
          (tagFilter === 'has_notes' && Boolean((obs.notes || '').trim()));

        if (!matchesChip) continue;

        const rowData = run?.rows?.[gIdx];
        const recipeSummary = rowData?.recipe
          ? rowData.recipe
              .filter((r) => r.target_concentration > 0)
              .map((r) => `${r.code} ${+r.target_concentration.toFixed(1)} mM`)
              .join(', ')
          : '';
        const condLabel =
          rowData?.label?.name ||
          (isBlank ? 'blank (solvent only)' : triMeta?.[gIdx]?.group || '');
        const coord = wellLabel(w);

        if (q) {
          const haystack = `${coord} p${p + 1} ${condLabel} ${recipeSummary} ${obs.status || ''} ${(
            obs.tags || []
          ).join(' ')} ${obs.notes || ''} ${obs.colorAfter || ''}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        const laneId = tlcLane(w, 'column');
        const lane = tlcSetForPlate?.cfg?.lanes?.find((l) => l.id === laneId);
        const spots = lane?.customSpots || [];
        const mainRf = spots.length ? spots.map((s) => s.rf.toFixed(2)).join(', ') : '';

        list.push({
          pIdx: p,
          wIdx: w,
          gIdx,
          coord,
          obs,
          recipeSummary,
          condLabel,
          isBlank,
          spotCount: spots.length,
          mainRf,
        });
      }
    }
    return list;
  }, [
    sheetScope,
    activePlate,
    numPlates,
    totalWellsCount,
    eln.wells,
    triMeta,
    tagFilter,
    run,
    sheetSearch,
    tlcSets,
  ]);

  const handleSpreadsheetCellKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colKey: string
  ) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      const next = document.querySelector<HTMLInputElement>(
        `[data-sheet-cell="${colKey}-${rowIndex + 1}"]`
      );
      next?.focus();
      next?.select();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = document.querySelector<HTMLInputElement>(
        `[data-sheet-cell="${colKey}-${rowIndex - 1}"]`
      );
      prev?.focus();
      prev?.select();
    }
  };

  // Scale-up calculation
  const scaleUpHitWellIdx = eln.selectedHitWell != null ? eln.selectedHitWell : currentGlobalIdx;
  const scaleUpRow = run?.rows?.[scaleUpHitWellIdx] || null;
  const scaleUpRecipe = scaleUpRow?.recipe || [];

  const scaleUpWellOptions = useMemo(() => {
    const opts: Array<{ gIdx: number; label: string; isHit: boolean }> = [];
    for (let g = 0; g < Math.min(totalWellsCount, 54 * 4); g++) {
      const p = Math.floor(g / PLATE_SIZE);
      const w = g % PLATE_SIZE;
      const obs = eln.wells?.[`${p}-${w}`];
      const status = obs?.status || 'none';
      const isHit = status === 'hit' || status === 'clean';
      const tag =
        status === 'hit'
          ? 'Top Hit'
          : status === 'clean'
          ? 'Clean'
          : status === 'partial'
          ? 'Partial'
          : '';
      const convText = obs?.conversion != null ? ` · ${obs.conversion}% conv` : '';
      const platePrefix = numPlates > 1 ? `P${p + 1} ` : '';
      opts.push({
        gIdx: g,
        isHit,
        label: `${platePrefix}${wellLabel(w)} (#${g + 1})${tag ? ` — ${tag}` : ''}${convText}`,
      });
    }
    return opts.sort((a, b) => Number(b.isHit) - Number(a.isHit) || a.gIdx - b.gIdx);
  }, [totalWellsCount, eln.wells, numPlates]);

  const scaleUpCalculations = useMemo(() => {
    if (!scaleUpRecipe.length) return null;
    const activeComponents = scaleUpRecipe.filter((r) => r.target_concentration > 0);
    if (!activeComponents.length) return null;

    const baseComponent = activeComponents[0];
    const baseMm = baseComponent.target_concentration;

    return activeComponents.map((item) => {
      const equiv = baseMm > 0 ? item.target_concentration / baseMm : 1;
      const targetMmol = scaleUpScaleMmol * equiv;
      const mw = Number(item.molarMass) || 0;
      const massG = mw > 0 ? (targetMmol * mw) / 1000 : null;
      const density = Number(item.chemicalDensity) || 0;
      const volMl = density > 0 && massG != null ? massG / density : null;

      return {
        code: item.code,
        name: item.name || item.code,
        target_concentration: item.target_concentration,
        equiv: Math.round(equiv * 1000) / 1000,
        targetMmol: Math.round(targetMmol * 1000) / 1000,
        mw,
        massG: massG != null ? Math.round(massG * 1000) / 1000 : null,
        volMl: volMl != null ? Math.round(volMl * 1000) / 1000 : null,
      };
    });
  }, [scaleUpRecipe, scaleUpScaleMmol]);

  const generatedProcedure = useMemo(() => {
    if (!scaleUpCalculations || !scaleUpCalculations.length) return '';
    const solids = scaleUpCalculations.filter((c) => c.massG != null && (!c.volMl || c.volMl < 0.2));
    const liquids = scaleUpCalculations.filter((c) => c.volMl != null && c.volMl >= 0.2);
    const solv = state.reactionSolvent || 'solvent';
    const temp = eln.temperatureC ? `${eln.temperatureC} °C` : 'room temperature';
    const time = eln.reactionTimeHours ? `${eln.reactionTimeHours} h` : '16 h';
    const atm = eln.atmosphere || 'inert atmosphere';

    let txt = `Bench Scale Procedure (${scaleUpScaleMmol} mmol scale):\n\n`;
    txt += `An oven-dried reaction vial equipped with a magnetic stir bar was charged with `;
    txt += solids.map((s) => `${s.name} (${s.massG} g, ${s.targetMmol} mmol, ${s.equiv} eq)`).join(', ');
    if (liquids.length) {
      txt += ` followed by ${liquids
        .map((l) => `${l.name} (${l.volMl} mL, ${l.targetMmol} mmol, ${l.equiv} eq)`)
        .join(', ')}`;
    }
    const estSolvVolume = Math.round((scaleUpScaleMmol / 0.1) * 10) / 10;
    txt += ` and anhydrous ${solv} (~${estSolvVolume} mL) under ${atm}. `;
    txt += `The vial was sealed with a ${eln.plateSealType || 'septum cap'} and stirred at ${temp} for ${time}.`;

    const hitObs =
      eln.wells[`${Math.floor(scaleUpHitWellIdx / PLATE_SIZE)}-${scaleUpHitWellIdx % PLATE_SIZE}`];
    if (hitObs?.notes) {
      txt += `\n\n[HTE Screen Observation]: "${hitObs.notes}"`;
    }
    if (hitObs?.tags?.includes('polymerized')) {
      txt += `\n[HTE Caution]: Polymerization observed under screen conditions; monitor stirring and avoid overheating.`;
    }
    if (hitObs?.tags?.includes('precipitated')) {
      txt += `\n[HTE Caution]: Precipitate formed during reaction; ensure efficient agitation.`;
    }
    if (hitObs?.tags?.includes('gas_evolution')) {
      txt += `\n[HTE Caution]: Gas evolution noted; ensure adequate pressure venting.`;
    }

    return txt;
  }, [scaleUpCalculations, scaleUpScaleMmol, state.reactionSolvent, eln, scaleUpHitWellIdx]);

  // Aggregated data for AI Synthesis Report
  const aiReportData = useMemo(() => {
    const totalWells = rowsCache.length || 54;
    let hits = 0;
    let moderate = 0;
    let low = 0;
    let failed = 0;

    const topHitsList: any[] = [];
    const problemWellsList: any[] = [];

    const wellEntries = Object.entries(eln.wells || {});
    wellEntries.forEach(([key, obs]) => {
      const [pStr, wStr] = key.split('-');
      const pIdx = parseInt(pStr, 10);
      const wIdx = parseInt(wStr, 10);
      const globalIdx = pIdx * PLATE_SIZE + wIdx;
      const rowData = run?.rows ? run.rows[globalIdx] : null;
      const recipeStr =
        (rowData && 'recipe' in rowData
          ? rowData.recipe
              .filter((r) => r.target_concentration > 0)
              .map((r) => `${r.code} ${r.target_concentration}mM`)
              .join(', ')
          : '') || `Plate ${pIdx + 1} Well ${wellLabel(wIdx)}`;
      const conv =
        obs.conversion ?? (obs.status === 'hit' ? 95 : obs.status === 'clean' ? 85 : undefined);

      if (obs.status === 'hit' || (conv !== undefined && conv >= 75)) {
        hits++;
        if (topHitsList.length < 8) {
          topHitsList.push({
            well: `P${pIdx + 1}_${wellLabel(wIdx)}`,
            recipe: recipeStr,
            conversion: conv ?? undefined,
            yield: obs.yield ?? undefined,
            notes: obs.notes,
          });
        }
      } else if (obs.status === 'partial' || (conv !== undefined && conv >= 30 && conv < 75)) {
        moderate++;
      } else if (obs.status === 'sm_only' || (conv !== undefined && conv < 30)) {
        low++;
      } else if (
        obs.status === 'decomp' ||
        obs.status === 'precipitate' ||
        obs.tags?.includes('polymerized')
      ) {
        failed++;
        if (problemWellsList.length < 8) {
          problemWellsList.push({
            well: `P${pIdx + 1}_${wellLabel(wIdx)}`,
            recipe: recipeStr,
            notes: obs.notes || obs.tags?.join(', '),
          });
        }
      }
    });

    return {
      wellStats: {
        total: totalWells,
        hits,
        moderate,
        low,
        failed,
      },
      topHits: topHitsList,
      problemWells: problemWellsList,
    };
  }, [rowsCache, run, eln.wells]);

  const jumpToWellTlc = () => {
    setTargetWell({ wellIndex: selectedWellIdx, plateIndex: activePlate, source: 'palette' });
    setVisited((v) => ({ ...v, tlc: true }));
    setView('tlc');
  };

  const progressPct = totalWellsCount > 0 ? Math.min(100, Math.round((stats.scored / totalWellsCount) * 100)) : 0;
  const selectedCoord = `${ROW_LETTERS[Math.floor(selectedWellIdx / COLS)]}${(selectedWellIdx % COLS) + 1}`;
  const conditionSummary = [
    eln.temperatureC !== '' && eln.temperatureC != null ? `${eln.temperatureC} °C` : null,
    eln.reactionTimeHours !== '' && eln.reactionTimeHours != null ? `${eln.reactionTimeHours} h` : null,
    eln.atmosphere || null,
    eln.agitation || null,
    eln.illumination && eln.illumination !== 'None' ? eln.illumination : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="eln-shell">
      {/* Hidden file input for Spreadsheet CSV/XLSX import */}
      <input
        ref={importInputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xlsm"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImportSpreadsheetFile(f);
          e.target.value = '';
        }}
      />

      {/* Modern Compact Workbench Hero */}
      <section className="eln-hero">
        <div className="eln-hero-top">
          <div style={{ flex: '1 1 480px', minWidth: 0 }}>
            <input
              type="text"
              className="eln-title-input"
              placeholder="Untitled HTE Screening Campaign"
              value={eln.campaignTitle || ''}
              onChange={(e) => updateEln({ campaignTitle: e.target.value })}
              aria-label="Campaign Title"
            />
            <div className="eln-meta-line">
              <input
                type="text"
                className="eln-class-input"
                placeholder="Reaction class..."
                value={eln.reactionClass || ''}
                onChange={(e) => updateEln({ reactionClass: e.target.value })}
                aria-label="Reaction Class"
              />
              <span aria-hidden="true">·</span>
              <span className="mono">
                {run?.reactions || rowsCache.length || 54} wells
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {numPlates} plate{numPlates === 1 ? '' : 's'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <b className="mono" style={{ color: 'var(--fg)' }}>{stats.scored}</b> / {totalWellsCount} scored ({progressPct}%)
              </span>
            </div>
          </div>

          {/* Unboxed Tabular Campaign Metrics */}
          <div className="eln-kpi-row">
            <div className="eln-kpi">
              <span className="eln-kpi-val" style={{ color: '#059669' }}>{stats.hits}</span>
              <span className="eln-kpi-lbl">Top Hits</span>
            </div>
            <div className="eln-kpi">
              <span className="eln-kpi-val" style={{ color: '#10b981' }}>{stats.clean}</span>
              <span className="eln-kpi-lbl">Clean</span>
            </div>
            <div className="eln-kpi">
              <span className="eln-kpi-val" style={{ color: '#8b5cf6' }}>{stats.poly}</span>
              <span className="eln-kpi-lbl">Poly</span>
            </div>
            <div className="eln-kpi">
              <span className="eln-kpi-val" style={{ color: '#d97706' }}>{stats.precip}</span>
              <span className="eln-kpi-lbl">Precip</span>
            </div>
            <div className="eln-kpi">
              <span className="eln-kpi-val" style={{ color: '#0284c7' }}>{stats.volLoss}</span>
              <span className="eln-kpi-lbl">Vol Loss</span>
            </div>
          </div>
        </div>

        {/* Thin Progress Track */}
        <div className="eln-progress-track" aria-hidden="true">
          <div className="eln-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>

        {/* Compact Conditions Strip & Slide-Down Drawer */}
        <div
          style={{
            marginTop: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: '12.5px', color: 'var(--fg2)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Conditions</span>
            <span>{conditionSummary || 'Not specified'}</span>
            {eln.objective && (
              <>
                <span aria-hidden="true" style={{ color: 'var(--mut)' }}>·</span>
                <span style={{ color: 'var(--mut)', maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {eln.objective}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => setConditionsOpen((o) => !o)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <SlidersHorizontal size={12} />
            <span>{conditionsOpen ? 'Hide conditions' : 'Conditions & objective'}</span>
            {conditionsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>

        {conditionsOpen && (
          <div
            style={{
              marginTop: '14px',
              paddingTop: '14px',
              borderTop: '1px solid var(--line2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div>
              <label className="lbl">Campaign Objective &amp; Hypothesis</label>
              <input
                type="text"
                className="f"
                style={{ height: '36px', fontSize: '13px' }}
                placeholder="e.g. Evaluate steric bulk on Buchwald ligands across 3 inorganic bases at 60 °C..."
                value={eln.objective || ''}
                onChange={(e) => updateEln({ objective: e.target.value })}
              />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '10px',
              }}
            >
              <div>
                <label className="lbl">Temp (°C)</label>
                <input
                  type="number"
                  className="f mono"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.temperatureC ?? ''}
                  placeholder="60"
                  onChange={(e) => updateEln({ temperatureC: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Heating Apparatus</label>
                <input
                  type="text"
                  className="f"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.heatingApparatus ?? ''}
                  placeholder="Al block"
                  onChange={(e) => updateEln({ heatingApparatus: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Time (h)</label>
                <input
                  type="number"
                  className="f mono"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.reactionTimeHours ?? ''}
                  placeholder="16"
                  onChange={(e) => updateEln({ reactionTimeHours: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Atmosphere</label>
                <input
                  type="text"
                  className="f"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.atmosphere ?? ''}
                  placeholder="N2 Glovebox"
                  onChange={(e) => updateEln({ atmosphere: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Agitation</label>
                <input
                  type="text"
                  className="f"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.agitation ?? ''}
                  placeholder="Tumble 800 rpm"
                  onChange={(e) => updateEln({ agitation: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Illumination</label>
                <input
                  type="text"
                  className="f"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.illumination ?? ''}
                  placeholder="Blue LED 450nm"
                  onChange={(e) => updateEln({ illumination: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl">Plate Seal</label>
                <input
                  type="text"
                  className="f"
                  style={{ height: '34px', fontSize: '12.5px' }}
                  value={eln.plateSealType ?? ''}
                  placeholder="Teflon mat"
                  onChange={(e) => updateEln({ plateSealType: e.target.value })}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Modern Underline Workspace Sub-Bar */}
      <div className="eln-subbar">
        <div className="eln-tabs" role="tablist" aria-label="ELN Workspace Tabs">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'observations'}
            className={`eln-tab ${subTab === 'observations' ? 'on' : ''}`}
            onClick={() => setSubTab('observations')}
          >
            <Grid3x3 size={15} />
            <span>Well Observations</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'scaleup'}
            className={`eln-tab ${subTab === 'scaleup' ? 'on' : ''}`}
            onClick={() => setSubTab('scaleup')}
          >
            <Scale size={15} />
            <span>Scale-Up Calculator</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'synthesis'}
            className={`eln-tab ${subTab === 'synthesis' ? 'on' : ''}`}
            onClick={() => setSubTab('synthesis')}
          >
            <Sparkles size={15} />
            <span>Synthesis &amp; Notes</span>
          </button>
        </div>

        {/* Right Controls on Well Observations Tab */}
        {subTab === 'observations' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', paddingBottom: '6px' }}>
            <div className="seg" role="group" aria-label="Observation Entry Mode">
              <button
                type="button"
                className={workspaceMode === 'matrix' ? 'on' : ''}
                onClick={() => setWorkspaceMode('matrix')}
                title="Visual 6×9 plate grid with keyboard shortcuts and inspector"
                style={{ height: '30px', padding: '0 11px', fontSize: '12.5px', gap: '6px' }}
              >
                <Grid3x3 size={13} />
                <span>Plate Grid</span>
              </button>
              <button
                type="button"
                className={workspaceMode === 'spreadsheet' ? 'on' : ''}
                onClick={() => setWorkspaceMode('spreadsheet')}
                title="Editable spreadsheet table with CSV & XLSX export/import"
                style={{ height: '30px', padding: '0 11px', fontSize: '12.5px', gap: '6px' }}
              >
                <Table2 size={13} />
                <span>Spreadsheet</span>
              </button>
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={handleExportCsv}
              title="Download ELN observations table as CSV"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Download size={13} />
              <span>CSV</span>
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={handleExportXlsx}
              title="Download ELN observations workbook as Excel (.xlsx)"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Download size={13} />
              <span>XLSX</span>
            </button>
            <button
              type="button"
              className="btn sm pri"
              onClick={() => importInputRef.current?.click()}
              title="Import scored observations from CSV, TSV, or Excel (.xlsx)"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Upload size={13} />
              <span>Import</span>
            </button>
          </div>
        )}
      </div>

      {/* ======================================================================== */}
      {/* TAB 1A: TOP-AND-BOTTOM PLATE MATRIX & WELL INSPECTOR                     */}
      {/* ======================================================================== */}
      {subTab === 'observations' && workspaceMode === 'matrix' && (
        <div className="eln-split">
          {/* Top: Precision 54-Well Microplate */}
          <div className="eln-plate-card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                marginBottom: '12px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--fg)' }}>
                  54-Well Plate
                </span>
                {numPlates > 1 && (
                  <div className="seg" role="group" aria-label="Plate selection">
                    {Array.from({ length: numPlates }).map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        className={activePlate === i ? 'on' : ''}
                        style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
                        onClick={() => {
                          setActivePlate(i);
                          setBatchSelection([]);
                        }}
                      >
                        Plate {i + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button
                  type="button"
                  className={`btn sm ${batchMode ? 'pri' : ''}`}
                  aria-pressed={batchMode}
                  onClick={() => {
                    const next = !batchMode;
                    setBatchMode(next);
                    if (!next) setBatchSelection([]);
                  }}
                  title="Multi-well selection mode (or click any Row A–F or Column 1–9 header)"
                >
                  {batchMode ? `Batch (${batchSelection.length})` : 'Batch Select'}
                </button>
              </div>
            </div>

            {/* Clean Segmented Filter Bar */}
            <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px', marginBottom: '12px' }}>
              {[
                { id: 'all', label: `All (${PLATE_SIZE})` },
                { id: 'unscored', label: `Unscored (${plateCounts.unscored})` },
                { id: 'hit', label: `Hits (${plateCounts.hits})` },
                { id: 'polymerized', label: `Poly (${plateCounts.poly})` },
                { id: 'precipitated', label: `Precip (${plateCounts.precip})` },
                { id: 'volume_decreased', label: `Vol Loss (${plateCounts.volLoss})` },
                { id: 'has_notes', label: `Notes (${plateCounts.notes})` },
              ].map((f) => {
                const active = tagFilter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTagFilter(active && f.id !== 'all' ? 'all' : f.id)}
                    style={{
                      cursor: 'pointer',
                      border: active ? '1px solid var(--acc)' : '1px solid var(--line)',
                      borderRadius: '8px',
                      padding: '4px 10px',
                      fontSize: '12px',
                      fontWeight: active ? 600 : 500,
                      whiteSpace: 'nowrap',
                      background: active ? 'var(--accbg)' : 'var(--panel)',
                      color: active ? 'var(--accfg)' : 'var(--fg2)',
                      transition: 'all 0.14s ease',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            {/* Batch Action Bar */}
            {(batchMode || batchSelection.length > 0) && (
              <div
                style={{
                  marginBottom: '12px',
                  padding: '10px 12px',
                  background: 'color-mix(in srgb, var(--blue) 8%, var(--soft))',
                  borderRadius: '11px',
                  border: '1px solid color-mix(in srgb, var(--blue) 32%, var(--line))',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--fg)' }}>
                    <span className="mono">{batchSelection.length}</span> well{batchSelection.length === 1 ? '' : 's'} selected
                    <span style={{ fontWeight: 400, color: 'var(--mut)', marginLeft: '8px', fontSize: '12px' }}>
                      Click A–F or 1–9 headers to toggle lines
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        const all54 = Array.from({ length: PLATE_SIZE }, (_, i) => i);
                        setBatchSelection(batchSelection.length === 54 ? [] : all54);
                      }}
                    >
                      {batchSelection.length === 54 ? 'Deselect All' : 'Select All 54'}
                    </button>
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={() => {
                        setBatchSelection([]);
                        setBatchMode(false);
                      }}
                    >
                      Done
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {[
                    { label: 'Mark Hit', dot: '#059669', onClick: () => applyBatchStatus('hit') },
                    { label: 'Mark Clean', dot: '#10b981', onClick: () => applyBatchStatus('clean') },
                    { label: 'Mark Decomp', dot: '#dc2626', onClick: () => applyBatchStatus('decomp') },
                    { label: '+ Polymerized', dot: '#8b5cf6', onClick: () => applyBatchObservation('polymerized') },
                    { label: '+ Precipitated', dot: '#d97706', onClick: () => applyBatchObservation('precipitated') },
                    { label: '+ Vol Loss', dot: '#0284c7', onClick: () => applyBatchObservation('volume_decreased') },
                    { label: '+ Gas', dot: '#0891b2', onClick: () => applyBatchObservation('gas_evolution') },
                  ].map((act) => (
                    <button
                      key={act.label}
                      type="button"
                      className="eln-tag-btn"
                      onClick={act.onClick}
                    >
                      <span
                        style={{
                          width: '7px',
                          height: '7px',
                          borderRadius: '50%',
                          background: act.dot,
                          flexShrink: 0,
                        }}
                      />
                      <span>{act.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Recessed Microplate Tray */}
            <div className="eln-plate-tray">
              <div className="eln-plate-grid">
                {/* ALL corner toggle */}
                <button
                  type="button"
                  className={`eln-hdr-btn ${batchSelection.length === PLATE_SIZE ? 'on' : ''}`}
                  onClick={() =>
                    toggleLineSelection(
                      Array.from({ length: PLATE_SIZE }, (_, i) => i),
                      'All 54 Wells'
                    )
                  }
                  title="Select or clear all 54 wells"
                >
                  ALL
                </button>

                {/* Column Headers 1..9 */}
                {Array.from({ length: COLS }).map((_, c) => {
                  const colIndices = Array.from({ length: ROWS }, (_, r) => r * COLS + c);
                  const colSelected = colIndices.every((idx) => batchSelection.includes(idx));
                  return (
                    <button
                      key={c}
                      type="button"
                      className={`eln-hdr-btn ${colSelected ? 'on' : ''}`}
                      onClick={() => toggleLineSelection(colIndices, `Column ${c + 1}`)}
                      title={`Select Column ${c + 1}`}
                    >
                      {c + 1}
                    </button>
                  );
                })}

                {/* Rows A..F */}
                {Array.from({ length: ROWS }).map((_, r) => {
                  const rowLetter = ROW_LETTERS[r];
                  const rowIndices = Array.from({ length: COLS }, (_, c) => r * COLS + c);
                  const rowSelected = rowIndices.every((idx) => batchSelection.includes(idx));
                  return (
                    <React.Fragment key={r}>
                      <button
                        type="button"
                        className={`eln-hdr-btn row-hdr ${rowSelected ? 'on' : ''}`}
                        onClick={() => toggleLineSelection(rowIndices, `Row ${rowLetter}`)}
                        title={`Select Row ${rowLetter}`}
                      >
                        {rowLetter}
                      </button>

                      {Array.from({ length: COLS }).map((_, c) => {
                        const wIdx = r * COLS + c;
                        const gIdx = activePlate * PLATE_SIZE + wIdx;
                        const key = `${activePlate}-${wIdx}`;
                        const obs: WellObservation = (eln.wells && eln.wells[key]) || {
                          wellIndex: wIdx,
                          plateIndex: activePlate,
                          status: 'none',
                          tags: [],
                        };

                        const rowData = rowByPlateWell.get(key) ?? run?.rows?.[gIdx];
                        const rowGlobalIdx = rowData?.global_index ?? gIdx;
                        const isBlank =
                          Boolean(triMeta && triMeta[rowGlobalIdx]?.blank) ||
                          obs.status === 'blank' ||
                          Boolean(rowData?.label?.name && /^blank\b/i.test(rowData.label.name));
                        const activeRecipes: RecipeItem[] = rowData
                          ? (rowData.recipe || []).filter((rec: RecipeItem) => rec.target_concentration > 0)
                          : [];
                        const recipeTooltip = isBlank
                          ? 'Blank (solvent only)'
                          : activeRecipes
                              .map(
                                (rec) =>
                                  `${rec.code} ${rec.target_concentration} mM${
                                    rec.equivalence != null ? ` (${rec.equivalence} eq)` : ''
                                  }`
                              )
                              .join(', ');
                        const isSelected = selectedWellIdx === wIdx;
                        const isBatchSelected = batchSelection.includes(wIdx);

                        const matchesFilter =
                          tagFilter === 'all' ||
                          (tagFilter === 'unscored' && (!obs.status || obs.status === 'none') && !isBlank) ||
                          (tagFilter === 'hit' && obs.status === 'hit') ||
                          (tagFilter === 'polymerized' && obs.tags?.includes('polymerized')) ||
                          (tagFilter === 'precipitated' && obs.tags?.includes('precipitated')) ||
                          (tagFilter === 'volume_decreased' &&
                            (obs.tags?.includes('volume_decreased') || obs.tags?.includes('gas_evolution'))) ||
                          (tagFilter === 'has_notes' && Boolean((obs.notes || '').trim()));

                        let bg = 'var(--panel)';
                        let accentColor = '';
                        let statusCode = '';

                        if (obs.status === 'hit') {
                          bg = 'rgba(16, 185, 129, 0.14)';
                          accentColor = '#059669';
                          statusCode = 'HIT';
                        } else if (obs.status === 'clean') {
                          bg = 'rgba(16, 185, 129, 0.08)';
                          accentColor = '#10b981';
                          statusCode = 'OK';
                        } else if (obs.status === 'decomp') {
                          bg = 'rgba(239, 68, 68, 0.11)';
                          accentColor = '#dc2626';
                          statusCode = 'DEC';
                        } else if (obs.tags?.includes('polymerized')) {
                          bg = 'rgba(139, 92, 246, 0.12)';
                          accentColor = '#8b5cf6';
                          statusCode = 'POLY';
                        } else if (obs.tags?.includes('precipitated') || obs.status === 'precipitate') {
                          bg = 'rgba(245, 158, 11, 0.12)';
                          accentColor = '#d97706';
                          statusCode = 'PPT';
                        } else if (
                          obs.tags?.includes('volume_decreased') ||
                          obs.tags?.includes('gas_evolution')
                        ) {
                          bg = 'rgba(14, 165, 233, 0.11)';
                          accentColor = '#0284c7';
                          statusCode = obs.tags?.includes('gas_evolution') ? 'GAS' : 'VOL';
                        } else if (obs.status === 'partial') {
                          bg = 'rgba(245, 158, 11, 0.08)';
                          accentColor = '#d97706';
                          statusCode = 'PART';
                        } else if (obs.status === 'sm_only') {
                          bg = 'rgba(107, 114, 128, 0.08)';
                          accentColor = '#6b7280';
                          statusCode = 'SM';
                        } else if (isBlank) {
                          bg = 'color-mix(in srgb, var(--soft) 60%, var(--panel))';
                          accentColor = 'var(--mut)';
                          statusCode = 'BLK';
                        }

                        return (
                          <button
                            key={c}
                            type="button"
                            className={`eln-well ${isSelected ? 'sel' : ''} ${
                              isBatchSelected ? 'batch' : ''
                            } ${matchesFilter ? '' : 'dim'}`}
                            style={{ background: bg }}
                            onClick={(e) => {
                              if (batchMode || e.shiftKey) {
                                if (!batchMode) setBatchMode(true);
                                setBatchSelection((prev) =>
                                  prev.includes(wIdx) ? prev.filter((x) => x !== wIdx) : [...prev, wIdx]
                                );
                              } else {
                                setSelectedWellIdx(wIdx);
                                scrollToInspector();
                              }
                            }}
                            title={`Well ${rowLetter}${c + 1} (#${wIdx + 1})${
                              recipeTooltip ? ` · ${recipeTooltip}` : ''
                            } · Click to inspect, Shift+click to batch select`}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '2px' }}>
                              <span className="mono" style={{ fontSize: '10.5px', fontWeight: 600, color: isSelected ? 'var(--acc)' : 'var(--mut)' }}>
                                {rowLetter}
                                {c + 1}
                              </span>
                              {statusCode && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '9.5px',
                                    fontWeight: 700,
                                    color: accentColor,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                  }}
                                >
                                  {statusCode}
                                </span>
                              )}
                            </div>

                            <div
                              style={{
                                fontSize: '10px',
                                lineHeight: '1.2',
                                color: 'var(--fg2)',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {obs.tags && obs.tags.length > 0
                                ? obs.tags.map((t) => OBSERVATION_TAGS.find((o) => o.id === t)?.short || t).join(' · ')
                                : obs.notes
                                ? obs.notes
                                : isBlank
                                ? 'Blank'
                                : ''}
                            </div>

                            {/* Conversion bar or placeholder spacer */}
                            {obs.conversion != null ? (
                              <div>
                                <div
                                  className="mono"
                                  style={{ fontSize: '9.5px', fontWeight: 600, color: '#059669', textAlign: 'right', lineHeight: 1 }}
                                >
                                  {obs.conversion}%
                                </div>
                                <div className="eln-well-bar">
                                  <div
                                    style={{
                                      width: `${Math.max(0, Math.min(100, obs.conversion))}%`,
                                      height: '100%',
                                      background: obs.conversion >= 75 ? '#059669' : '#d97706',
                                      borderRadius: '99px',
                                    }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <div style={{ height: '6px' }} />
                            )}
                          </button>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {/* Clean Shortcut Legend */}
            <div
              style={{
                marginTop: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--mut)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span>Shortcuts:</span>
                <span><kbd className="eln-kbd">Arrows</kbd> move</span>
                <span><kbd className="eln-kbd">1</kbd>–<kbd className="eln-kbd">5</kbd> outcome</span>
                <span><kbd className="eln-kbd">P</kbd> <kbd className="eln-kbd">C</kbd> <kbd className="eln-kbd">V</kbd> <kbd className="eln-kbd">G</kbd> tags</span>
              </div>
              <span className="mono" style={{ fontSize: '11.5px' }}>
                Plate {activePlate + 1} / {numPlates}
              </span>
            </div>
          </div>

          {/* Bottom: Well Observation Inspector */}
          <aside ref={inspectorRef} className="eln-inspector">
            {/* Inspector Header + Recipe Summary */}
            <div className="eln-sec">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
                  <div
                    className="mono"
                    style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '11px',
                      background: 'var(--accbg)',
                      color: 'var(--accfg)',
                      fontWeight: 700,
                      fontSize: '15px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {selectedCoord}
                  </div>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--fg)', lineHeight: 1.2 }}>
                      Well {selectedCoord}
                    </div>
                    <div className="mono" style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
                      Reaction #{currentGlobalIdx + 1} · Plate {activePlate + 1}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '12px',
                      color: autoAdvance ? 'var(--acc)' : 'var(--mut)',
                      fontWeight: autoAdvance ? 600 : 500,
                      cursor: 'pointer',
                      marginRight: '4px',
                      userSelect: 'none',
                    }}
                    title="Automatically advance to the next well after scoring an outcome"
                  >
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                      style={{ accentColor: 'var(--acc)', width: '14px', height: '14px' }}
                    />
                    Auto-next
                  </label>
                  <button
                    type="button"
                    className="ib"
                    onClick={() => setSelectedWellIdx((prev) => (prev - 1 + PLATE_SIZE) % PLATE_SIZE)}
                    title="Previous well (Left arrow)"
                    aria-label="Previous well"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    type="button"
                    className="ib"
                    onClick={() => setSelectedWellIdx((prev) => (prev + 1) % PLATE_SIZE)}
                    title="Next well (Right arrow)"
                    aria-label="Next well"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>

              {/* Recipe Composition Summary */}
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 12px',
                  background: 'var(--soft)',
                  borderRadius: '10px',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--fg)' }}>
                  {currentLabel?.name || 'Reaction Well'}
                </div>
                {currentLabel?.cond && (
                  <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginTop: '2px' }}>
                    {currentLabel.cond}
                  </div>
                )}
                {currentRecipe.length > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                    {currentRecipe
                      .filter((rec) => rec.target_concentration > 0)
                      .map((rec, idx) => (
                        <div
                          key={rec.code + idx}
                          className="mono"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            fontSize: '11.5px',
                            color: 'var(--fg2)',
                          }}
                        >
                          <span
                            style={{
                              width: '7px',
                              height: '7px',
                              borderRadius: '50%',
                              background: PAL[idx % PAL.length],
                            }}
                          />
                          <b style={{ color: 'var(--fg)' }}>{rec.code}</b>
                          <span>{rec.target_concentration} mM</span>
                          {rec.equivalence != null && (
                            <span style={{ color: 'var(--mut)' }}>({rec.equivalence} eq)</span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>

            {/* 2-Column Inspector Body */}
            <div className="eln-inspector-grid">
              {/* Left Column: Scoring Controls */}
              <div className="eln-inspector-col">
                {/* Outcome Selection */}
                <div className="eln-sec">
                  <div className="eln-sec-lbl">
                    <span>Outcome Category</span>
                    {currentWellObs.status && currentWellObs.status !== 'none' && (
                      <button
                        type="button"
                        onClick={() => updateWell(activePlate, selectedWellIdx, { status: 'none', scaleUpSelected: false })}
                        style={{
                          background: 'none',
                          border: 0,
                          padding: 0,
                          fontSize: '11.5px',
                          color: 'var(--mut)',
                          fontWeight: 500,
                          cursor: 'pointer',
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' }}>
                    {OUTCOME_OPTIONS.map((opt) => {
                      const isSelected = currentWellObs.status === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={isSelected}
                          className="eln-outcome-btn"
                          onClick={() => assignOutcomeAndMaybeAdvance(opt.id, true)}
                          style={{
                            borderColor: isSelected ? opt.color : undefined,
                            background: isSelected ? opt.bg : undefined,
                            fontWeight: isSelected ? 600 : 500,
                            color: isSelected ? opt.color : undefined,
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
                            <span
                              style={{
                                width: '7px',
                                height: '7px',
                                borderRadius: '50%',
                                background: opt.color,
                                flexShrink: 0,
                              }}
                            />
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {opt.label}
                            </span>
                          </span>
                          {opt.hotkey && <kbd className="eln-kbd">{opt.hotkey}</kbd>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Physical Observation Tags */}
                <div className="eln-sec">
                  <div className="eln-sec-lbl">
                    <span>Physical Observations</span>
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--mut)' }}>Toggle multiple</span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {OBSERVATION_TAGS.map((t) => {
                      const active = Boolean(currentWellObs.tags?.includes(t.id));
                      return (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={active}
                          className="eln-tag-btn"
                          onClick={() => toggleWellTag(activePlate, selectedWellIdx, t.id)}
                          style={{
                            borderColor: active ? t.color : undefined,
                            background: active ? t.tint : undefined,
                            color: active ? t.color : undefined,
                            fontWeight: active ? 600 : 500,
                          }}
                          title={t.desc}
                        >
                          {active ? (
                            <Check size={12} strokeWidth={2.4} />
                          ) : (
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: t.color,
                                opacity: 0.75,
                              }}
                            />
                          )}
                          <span>{t.label}</span>
                          {t.hotkey && <kbd className="eln-kbd">{t.hotkey}</kbd>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Right Column: Metrics, Notes & TLC */}
              <div className="eln-inspector-col">
                {/* Quantitative Metrics */}
                <div className="eln-sec">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.35fr', gap: '8px' }}>
                    <div>
                      <label className="lbl" style={{ fontSize: '11px' }}>Conversion</label>
                      <div className="eln-metric-box">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          className="f mono"
                          style={{ height: '34px', fontSize: '12.5px' }}
                          placeholder="0–100"
                          value={currentWellObs.conversion ?? ''}
                          onChange={(e) =>
                            updateWell(activePlate, selectedWellIdx, {
                              conversion: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                        <span className="eln-metric-unit">%</span>
                      </div>
                    </div>
                    <div>
                      <label className="lbl" style={{ fontSize: '11px' }}>Assay Yield</label>
                      <div className="eln-metric-box">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          className="f mono"
                          style={{ height: '34px', fontSize: '12.5px' }}
                          placeholder="0–100"
                          value={currentWellObs.yield ?? ''}
                          onChange={(e) =>
                            updateWell(activePlate, selectedWellIdx, {
                              yield: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                        <span className="eln-metric-unit">%</span>
                      </div>
                    </div>
                    <div>
                      <label className="lbl" style={{ fontSize: '11px' }}>Appearance / Color</label>
                      <input
                        type="text"
                        className="f"
                        style={{ height: '34px', fontSize: '12.5px' }}
                        placeholder="e.g. Amber"
                        value={currentWellObs.colorAfter || ''}
                        onChange={(e) => updateWell(activePlate, selectedWellIdx, { colorAfter: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="eln-sec">
                  <label className="lbl" style={{ fontSize: '11.5px', fontWeight: 600 }}>
                    Well Notes
                  </label>
                  <textarea
                    className="f"
                    rows={2}
                    style={{ resize: 'vertical', fontSize: '12.5px' }}
                    placeholder="Observations, side reactions, viscosity, or TLC comments..."
                    value={currentWellObs.notes || ''}
                    onChange={(e) => updateWell(activePlate, selectedWellIdx, { notes: e.target.value })}
                  />
                </div>

                {/* Embedded TLC Preview */}
                <div className="eln-sec">
                  <WellTlcPreview
                    tlcSet={activeTlcSet}
                    wellIndex={selectedWellIdx}
                    plateIndex={activePlate}
                    onOpenTlcMap={jumpToWellTlc}
                  />
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* ======================================================================== */}
      {/* TAB 1B: EXPORTABLE & IMPORTABLE SPREADSHEET VIEW                         */}
      {/* ======================================================================== */}
      {subTab === 'observations' && workspaceMode === 'spreadsheet' && (
        <div
          className={`eln-sheet-wrap ${sheetDragOver ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setSheetDragOver(true);
          }}
          onDragLeave={() => setSheetDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setSheetDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleImportSpreadsheetFile(f);
          }}
        >
          {/* Toolbar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--fg)' }}>
                Observations Table
              </span>
              <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
                {spreadsheetRows.length} rows
              </span>
              {numPlates > 1 && (
                <div className="seg">
                  <button
                    type="button"
                    className={sheetScope === 'plate' ? 'on' : ''}
                    style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
                    onClick={() => setSheetScope('plate')}
                  >
                    Plate {activePlate + 1}
                  </button>
                  <button
                    type="button"
                    className={sheetScope === 'all' ? 'on' : ''}
                    style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
                    onClick={() => setSheetScope('all')}
                  >
                    All Plates ({numPlates})
                  </button>
                </div>
              )}
              {numPlates > 1 && sheetScope === 'plate' && (
                <div className="seg">
                  {Array.from({ length: numPlates }).map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={activePlate === i ? 'on' : ''}
                      style={{ height: '28px', padding: '0 9px', fontSize: '12px' }}
                      onClick={() => setActivePlate(i)}
                    >
                      P{i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className="searchwrap">
                <Search size={13} className="searchicon" />
                <input
                  type="text"
                  className="f"
                  style={{ width: '220px', height: '32px', paddingLeft: '28px', fontSize: '12.5px' }}
                  placeholder="Filter well, reagent, notes..."
                  value={sheetSearch}
                  onChange={(e) => setSheetSearch(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={handleExportCsv}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Download size={13} />
                <span>Download CSV</span>
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={handleExportXlsx}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Download size={13} />
                <span>Download XLSX</span>
              </button>
              <button
                type="button"
                className="btn sm pri"
                onClick={() => importInputRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Upload size={13} />
                <span>Import CSV / XLSX</span>
              </button>
            </div>
          </div>

          {/* Filter Bar & Navigation Tip */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
              {[
                { id: 'all', label: 'All Wells' },
                { id: 'unscored', label: 'Unscored' },
                { id: 'hit', label: 'Top Hits' },
                { id: 'polymerized', label: 'Polymerized' },
                { id: 'precipitated', label: 'Precipitated' },
                { id: 'volume_decreased', label: 'Volume Loss' },
                { id: 'has_notes', label: 'With Notes' },
              ].map((f) => {
                const active = tagFilter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTagFilter(active && f.id !== 'all' ? 'all' : f.id)}
                    style={{
                      cursor: 'pointer',
                      border: active ? '1px solid var(--acc)' : '1px solid var(--line)',
                      borderRadius: '8px',
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      fontWeight: active ? 600 : 500,
                      background: active ? 'var(--accbg)' : 'var(--panel)',
                      color: active ? 'var(--accfg)' : 'var(--fg2)',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
              <kbd className="eln-kbd">Enter</kbd> or <kbd className="eln-kbd">↑ / ↓</kbd> moves rows · Drop a <span className="mono">.csv</span> or <span className="mono">.xlsx</span> file anywhere here to import
            </div>
          </div>

          {/* Editable Data Grid */}
          <div className="eln-sheet-tbl">
            <table>
              <thead>
                <tr>
                  <th className="sticky-col" style={{ width: '82px' }}>Well</th>
                  <th style={{ minWidth: '185px' }}>Condition &amp; Recipe</th>
                  <th style={{ width: '165px' }}>Outcome</th>
                  <th style={{ width: '82px' }}>Conv %</th>
                  <th style={{ width: '82px' }}>Yield %</th>
                  <th style={{ minWidth: '220px' }}>Physical Tags</th>
                  <th style={{ width: '116px' }}>Color</th>
                  <th style={{ minWidth: '215px' }}>Notes</th>
                  <th style={{ width: '92px' }}>TLC Rf</th>
                </tr>
              </thead>
              <tbody>
                {spreadsheetRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '32px', color: 'var(--mut)' }}>
                      No wells match the current filter.
                    </td>
                  </tr>
                ) : (
                  spreadsheetRows.map((item, rIdx) => {
                    const { pIdx, wIdx, coord, obs, recipeSummary, condLabel, isBlank, mainRf } = item;
                    const activeStatus = obs.status || (isBlank ? 'blank' : 'none');

                    return (
                      <tr
                        key={`${pIdx}-${wIdx}`}
                        style={{
                          background:
                            activePlate === pIdx && selectedWellIdx === wIdx
                              ? 'color-mix(in srgb, var(--acc) 5%, transparent)'
                              : undefined,
                        }}
                      >
                        <td className="sticky-col">
                          <button
                            type="button"
                            onClick={() => {
                              setActivePlate(pIdx);
                              setSelectedWellIdx(wIdx);
                              setWorkspaceMode('matrix');
                              setTimeout(scrollToInspector, 60);
                            }}
                            title="Open well in Plate Grid & Inspector"
                            className="mono"
                            style={{
                              border: '1px solid var(--line)',
                              borderRadius: '6px',
                              padding: '3px 8px',
                              background: 'var(--soft)',
                              fontWeight: 600,
                              fontSize: '11.5px',
                              color: 'var(--fg)',
                            }}
                          >
                            {numPlates > 1 ? `P${pIdx + 1}-` : ''}
                            {coord}
                          </button>
                        </td>

                        <td>
                          <div style={{ fontWeight: 500, fontSize: '12px', color: 'var(--fg)' }}>
                            {condLabel || `Reaction #${item.gIdx + 1}`}
                          </div>
                          {recipeSummary && (
                            <div
                              className="mono"
                              style={{
                                fontSize: '10.5px',
                                color: 'var(--mut)',
                                maxWidth: '240px',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                              title={recipeSummary}
                            >
                              {recipeSummary}
                            </div>
                          )}
                        </td>

                        <td>
                          <select
                            className="f"
                            style={{ width: '100%', height: '30px', fontSize: '12px', padding: '0 24px 0 8px' }}
                            value={activeStatus}
                            onChange={(e) => {
                              const st = e.target.value as WellOutcomeStatus;
                              updateWell(pIdx, wIdx, {
                                status: st,
                                scaleUpSelected: st === 'hit',
                              });
                              if (st === 'hit') updateEln({ selectedHitWell: item.gIdx });
                            }}
                          >
                            <option value="none">Unscored</option>
                            {OUTCOME_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            data-sheet-cell={`conv-${rIdx}`}
                            className="f mono"
                            style={{ width: '100%', height: '30px', textAlign: 'right', padding: '0 6px', fontSize: '12px' }}
                            placeholder="—"
                            value={obs.conversion ?? ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'conv')}
                            onChange={(e) =>
                              updateWell(pIdx, wIdx, {
                                conversion: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            data-sheet-cell={`yield-${rIdx}`}
                            className="f mono"
                            style={{ width: '100%', height: '30px', textAlign: 'right', padding: '0 6px', fontSize: '12px' }}
                            placeholder="—"
                            value={obs.yield ?? ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'yield')}
                            onChange={(e) =>
                              updateWell(pIdx, wIdx, {
                                yield: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                            {OBSERVATION_TAGS.filter((t) => QUICK_SPREADSHEET_TAGS.includes(t.id)).map((t) => {
                              const active = obs.tags?.includes(t.id);
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() => toggleWellTag(pIdx, wIdx, t.id)}
                                  title={t.label}
                                  style={{
                                    padding: '3px 7px',
                                    borderRadius: '6px',
                                    fontSize: '10.5px',
                                    fontWeight: active ? 600 : 500,
                                    border: active ? `1px solid ${t.color}` : '1px solid var(--line)',
                                    background: active ? t.tint : 'var(--panel)',
                                    color: active ? t.color : 'var(--mut)',
                                  }}
                                >
                                  {t.short}
                                </button>
                              );
                            })}
                          </div>
                        </td>

                        <td>
                          <input
                            type="text"
                            data-sheet-cell={`color-${rIdx}`}
                            className="f"
                            style={{ width: '100%', height: '30px', padding: '0 8px', fontSize: '12px' }}
                            placeholder="Color..."
                            value={obs.colorAfter || ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'color')}
                            onChange={(e) => updateWell(pIdx, wIdx, { colorAfter: e.target.value })}
                          />
                        </td>

                        <td>
                          <input
                            type="text"
                            data-sheet-cell={`notes-${rIdx}`}
                            className="f"
                            style={{ width: '100%', height: '30px', padding: '0 8px', fontSize: '12px' }}
                            placeholder="Add note..."
                            value={obs.notes || ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'notes')}
                            onChange={(e) => updateWell(pIdx, wIdx, { notes: e.target.value })}
                          />
                        </td>

                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setTargetWell({ wellIndex: wIdx, plateIndex: pIdx, source: 'palette' });
                              setVisited((v) => ({ ...v, tlc: true }));
                              setView('tlc');
                            }}
                            className="mono"
                            style={{
                              border: 'none',
                              background: 'transparent',
                              padding: 0,
                              fontSize: '11.5px',
                              color: mainRf ? 'var(--acc)' : 'var(--mut)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px',
                            }}
                            title="Open lane in TLC Map"
                          >
                            <span>{mainRf || '—'}</span>
                            {mainRf && <ExternalLink size={10} />}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* TAB 2: SCALE-UP CALCULATOR                                               */}
      {/* ======================================================================== */}
      {subTab === 'scaleup' && (
        <div className="card" style={{ padding: '22px 24px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              gap: '16px',
              marginBottom: '20px',
              paddingBottom: '16px',
              borderBottom: '1px solid var(--line2)',
            }}
          >
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--fg)' }}>
                Scale-Up Recipe Calculator
              </h2>
              <p className="sub" style={{ margin: '4px 0 0' }}>
                Translates micro-scale screening molarities into preparative masses, volumes, and a bench procedure.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '14px', flexWrap: 'wrap' }}>
              <div>
                <label className="lbl">Source Well</label>
                <select
                  className="f"
                  style={{ height: '36px', minWidth: '220px', fontSize: '12.5px' }}
                  value={scaleUpHitWellIdx}
                  onChange={(e) => updateEln({ selectedHitWell: Number(e.target.value) })}
                >
                  {scaleUpWellOptions.map((opt) => (
                    <option key={opt.gIdx} value={opt.gIdx}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="lbl">Target Scale (mmol)</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div className="seg">
                    {[0.5, 1.0, 2.0, 5.0, 10.0].map((sc) => (
                      <button
                        key={sc}
                        type="button"
                        className={scaleUpScaleMmol === sc ? 'on' : ''}
                        style={{ height: '30px', padding: '0 11px', fontSize: '12.5px' }}
                        onClick={() => setScaleUpScaleMmol(sc)}
                      >
                        {sc}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    className="f mono"
                    style={{ width: '82px', height: '36px', fontSize: '12.5px' }}
                    value={scaleUpScaleMmol}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val > 0) setScaleUpScaleMmol(val);
                    }}
                    aria-label="Custom scale mmol"
                  />
                </div>
              </div>
            </div>
          </div>

          {scaleUpCalculations && scaleUpCalculations.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Reagent</th>
                      <th>Screen Conc</th>
                      <th>Equivalence</th>
                      <th>Scale Amount</th>
                      <th>Molar Mass</th>
                      <th>Mass to Weigh</th>
                      <th>Liquid Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scaleUpCalculations.map((c) => (
                      <tr key={c.code}>
                        <td>
                          <b>{c.name}</b>{' '}
                          <span className="mono" style={{ color: 'var(--mut)' }}>
                            ({c.code})
                          </span>
                        </td>
                        <td className="mono">{c.target_concentration} mM</td>
                        <td className="mono">{c.equiv} eq</td>
                        <td className="mono">
                          <b>{c.targetMmol} mmol</b>
                        </td>
                        <td className="mono">{c.mw > 0 ? `${c.mw} g/mol` : '—'}</td>
                        <td className="mono">
                          {c.massG != null ? (
                            <b style={{ color: 'var(--accfg)' }}>
                              {c.massG >= 1
                                ? `${c.massG.toFixed(3)} g`
                                : `${(c.massG * 1000).toFixed(1)} mg`}
                            </b>
                          ) : (
                            <span style={{ color: 'var(--mut)' }}>Missing MW</span>
                          )}
                        </td>
                        <td className="mono">
                          {c.volMl != null
                            ? c.volMl >= 1
                              ? `${c.volMl.toFixed(2)} mL`
                              : `${(c.volMl * 1000).toFixed(0)} µL`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <label className="lbl" style={{ margin: 0, fontWeight: 600, color: 'var(--fg)' }}>
                    Draft Experimental Procedure
                  </label>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    onClick={() => {
                      navigator.clipboard?.writeText(generatedProcedure);
                      setCopiedProc(true);
                      toast('Copied experimental procedure to clipboard.');
                      setTimeout(() => setCopiedProc(false), 2000);
                    }}
                  >
                    {copiedProc ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedProc ? 'Copied' : 'Copy Procedure'}</span>
                  </button>
                </div>
                <textarea
                  className="f mono"
                  rows={6}
                  readOnly
                  style={{ background: 'var(--soft)', fontSize: '12.5px', lineHeight: 1.6 }}
                  value={generatedProcedure}
                />
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: '32px 24px',
                textAlign: 'center',
                color: 'var(--mut)',
                background: 'var(--soft)',
                borderRadius: '12px',
              }}
            >
              Select a well with an active reaction recipe to calculate bench scale-up amounts.
            </div>
          )}
        </div>
      )}

      {/* ======================================================================== */}
      {/* TAB 3: CAMPAIGN SYNTHESIS & NOTES                                        */}
      {/* ======================================================================== */}
      {subTab === 'synthesis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <AiSynthesisReport
            campaignTitle={eln.campaignTitle}
            reactionClass={eln.reactionClass}
            objective={eln.objective}
            postReactionNotes={eln.postReactionNotes}
            reagents={state.reagents}
            wellStats={aiReportData.wellStats}
            topHits={aiReportData.topHits}
            problemWells={aiReportData.problemWells}
            onAppendNotes={(text) => {
              updateEln({
                postReactionNotes: (eln.postReactionNotes ? eln.postReactionNotes + '\n\n' : '') + text,
              });
              toast('Appended Synthesis Report to Campaign Notes.');
            }}
            onReplaceNotes={(text) => {
              updateEln({ postReactionNotes: text });
              toast('Updated Campaign Notes with Synthesis Report.');
            }}
          />

          <div className="card" style={{ padding: '20px 22px' }}>
            <div className="chead" style={{ marginBottom: '12px' }}>
              <div>
                <div className="ct">Campaign Post-Reaction Observations &amp; Notes</div>
                <div style={{ fontSize: '12.5px', color: 'var(--mut)', marginTop: '2px' }}>
                  Record SAR trends, solvent effects, seal performance, and follow-up experiments.
                </div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => window.print()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title="Print current ELN view via browser print dialog"
              >
                <Printer size={13} />
                <span>Print ELN</span>
              </button>
            </div>
            <textarea
              className="f"
              rows={7}
              style={{ resize: 'vertical', fontSize: '13.5px', lineHeight: 1.6 }}
              placeholder="Summarize ligand/base trends, unexpected side reactions, precipitation, or corner-well evaporation..."
              value={eln.postReactionNotes || ''}
              onChange={(e) => updateEln({ postReactionNotes: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
};
