import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import {
  WellOutcomeStatus,
  WellObservation,
  HteElnRecord,
  RecipeItem,
} from '../../types';
import {
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
  desc: string;
  hotkey?: string;
}[] = [
  { id: 'polymerized', label: 'Polymerized', short: 'Poly', color: '#8b5cf6', desc: 'Solid, rubbery plug, or cross-linked gel', hotkey: 'P' },
  { id: 'precipitated', label: 'Precipitated', short: 'Ppt', color: '#d97706', desc: 'Solid precipitate, suspension, or flocculation', hotkey: 'C' },
  { id: 'volume_decreased', label: 'Volume Loss', short: 'Vol↓', color: '#0284c7', desc: 'Evaporation, septum leak, or consumption', hotkey: 'V' },
  { id: 'gas_evolution', label: 'Gas Evolution', short: 'Gas', color: '#0891b2', desc: 'Bubbling, foaming, or pressurization', hotkey: 'G' },
  { id: 'color_change', label: 'Color Change', short: 'Color', color: '#db2777', desc: 'Significant color shift' },
  { id: 'biphasic', label: 'Biphasic / Oil', short: '2-Phase', color: '#ca8a04', desc: 'Phase separation, oil droplets, or emulsion' },
  { id: 'viscous_gel', label: 'Viscous / Gelled', short: 'Gel', color: '#b45309', desc: 'Thickened liquid or high viscosity' },
  { id: 'turbid', label: 'Turbid / Cloudy', short: 'Turbid', color: '#64748b', desc: 'Hazy, colloidal suspension' },
  { id: 'homogeneous', label: 'Homogeneous', short: 'Clear', color: '#059669', desc: 'Clear, single-phase solution' },
];

const OUTCOME_OPTIONS: {
  id: WellOutcomeStatus;
  label: string;
  short: string;
  color: string;
  bg: string;
  hotkey?: string;
}[] = [
  { id: 'hit', label: 'Top Hit', short: 'HIT', color: '#059669', bg: 'rgba(16, 185, 129, 0.16)', hotkey: '1' },
  { id: 'clean', label: 'Clean Conversion', short: 'OK', color: '#10b981', bg: 'rgba(16, 185, 129, 0.10)', hotkey: '2' },
  { id: 'partial', label: 'Partial Conversion', short: 'PART', color: '#d97706', bg: 'rgba(245, 158, 11, 0.13)', hotkey: '3' },
  { id: 'sm_only', label: 'Starting Material Only', short: 'SM', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.11)', hotkey: '4' },
  { id: 'decomp', label: 'Decomposition', short: 'DEC', color: '#dc2626', bg: 'rgba(239, 68, 68, 0.13)', hotkey: '5' },
  { id: 'precipitate', label: 'Precipitate / Clogged', short: 'PPT', color: '#d97706', bg: 'rgba(245, 158, 11, 0.15)' },
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
  const [viewMode, setViewMode] = useState<'observations' | 'recipes'>('observations');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [batchSelection, setBatchSelection] = useState<number[]>([]);
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);

  // Spreadsheet state
  const [sheetScope, setSheetScope] = useState<'plate' | 'all'>('plate');
  const [sheetSearch, setSheetSearch] = useState<string>('');
  const [sheetDragOver, setSheetDragOver] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Scale-up state
  const [scaleUpScaleMmol, setScaleUpScaleMmol] = useState<number>(1.0);

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
      toast(`Selected ${label} (${indices.length} wells) for batch tagging`);
      return Array.from(nextSet).sort((a, b) => a - b);
    });
  };

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

  const currentRunRow = run && run.rows ? run.rows[currentGlobalIdx] : null;
  const currentRecipe: RecipeItem[] = currentRunRow ? currentRunRow.recipe : [];
  const currentLabel =
    currentRunRow?.label ||
    (triMeta && triMeta[currentGlobalIdx]
      ? {
          name: triMeta[currentGlobalIdx].blank
            ? 'blank (solvent only)'
            : `${triMeta[currentGlobalIdx].group || 'Well'}`,
          cond: `Plate ${activePlate + 1}, Well ${wellLabel(selectedWellIdx)} | section ${triMeta[currentGlobalIdx].section}`,
        }
      : null);

  // TLC correlation data for active plate
  const activeTlcSet = tlcSets && (tlcSets[activePlate] || tlcSets[0]);

  // Helper to assign outcome & optionally advance to next well
  const assignOutcomeAndMaybeAdvance = useCallback(
    (status: WellOutcomeStatus, allowAutoAdvance: boolean) => {
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
    [activePlate, selectedWellIdx, currentGlobalIdx, autoAdvance, batchMode, updateWell, updateEln]
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

        // Filter chip match
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

  // Keyboard navigation across Spreadsheet rows (ArrowUp / ArrowDown / Enter in numeric or text cells)
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

  // Scale-up calculation for selected or designated hit well
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
    txt += ` and anhydrous ${solv} (~${estSolvVolume} mL) under a ${atm}. `;
    txt += `The vial was sealed with a ${eln.plateSealType || 'septum cap'} and stirred at ${temp} for ${time}. `;

    const hitObs =
      eln.wells[`${Math.floor(scaleUpHitWellIdx / PLATE_SIZE)}-${scaleUpHitWellIdx % PLATE_SIZE}`];
    if (hitObs?.notes) {
      txt += `\n\n[HTE Screen Observation]: "${hitObs.notes}"`;
    }
    if (hitObs?.tags?.includes('polymerized')) {
      txt += `\n[HTE Caution]: Polymerization was observed under related screen conditions; monitor stirring and avoid overheating.`;
    }
    if (hitObs?.tags?.includes('precipitated')) {
      txt += `\n[HTE Caution]: Precipitate formed during reaction. Ensure efficient agitation.`;
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

  return (
    <div className="wrap" style={{ maxWidth: '1400px', margin: '0 auto', padding: '16px 20px 80px' }}>
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

      {/* Compact Campaign Header Card */}
      <div className="card" style={{ marginBottom: '14px', padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '14px',
          }}
        >
          <div style={{ flex: '1 1 440px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--fg)' }}>
                HTE Electronic Lab Notebook
              </h2>
              <span style={{ color: 'var(--mut)', fontSize: '12px' }}>
                · {run?.reactions || rowsCache.length || 54} wells · {numPlates} plate
                {numPlates === 1 ? '' : 's'} · {stats.scored}/{totalWellsCount} scored
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="f"
                style={{ fontWeight: 600, fontSize: '14px', flex: '1 1 260px' }}
                placeholder="Campaign Title (e.g. Buchwald Ligand & Base 54-Well Screen)"
                value={eln.campaignTitle || ''}
                onChange={(e) => updateEln({ campaignTitle: e.target.value })}
              />
              <input
                type="text"
                className="f"
                style={{ flex: '1 1 180px' }}
                placeholder="Reaction Class (e.g. C-N Coupling)"
                value={eln.reactionClass || ''}
                onChange={(e) => updateEln({ reactionClass: e.target.value })}
              />
            </div>
            <textarea
              className="f"
              rows={1}
              style={{ marginTop: '8px', width: '100%', resize: 'vertical', fontSize: '12px' }}
              placeholder="Campaign objective & hypothesis..."
              value={eln.objective || ''}
              onChange={(e) => updateEln({ objective: e.target.value })}
            />
          </div>

          {/* Clean Unboxed Stats Strip */}
          <div
            style={{
              display: 'flex',
              gap: '14px',
              flexWrap: 'wrap',
              background: 'var(--soft)',
              padding: '10px 16px',
              borderRadius: '10px',
              border: '1px solid var(--line)',
              alignItems: 'center',
            }}
          >
            <div style={{ textAlign: 'center', minWidth: '52px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: '#059669' }}>
                {stats.hits}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Hits
              </div>
            </div>
            <div style={{ width: '1px', height: '26px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '52px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: '#10b981' }}>
                {stats.clean}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Clean
              </div>
            </div>
            <div style={{ width: '1px', height: '26px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '52px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: '#8b5cf6' }}>
                {stats.poly}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Poly
              </div>
            </div>
            <div style={{ width: '1px', height: '26px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '52px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: '#d97706' }}>
                {stats.precip}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Precip
              </div>
            </div>
            <div style={{ width: '1px', height: '26px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '52px' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'monospace', color: '#0284c7' }}>
                {stats.volLoss}
              </div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase' }}>
                Vol Loss
              </div>
            </div>
          </div>
        </div>

        {/* Collapsible Reaction Execution Conditions Strip */}
        <div
          style={{
            marginTop: '10px',
            paddingTop: '10px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ fontSize: '12px', color: 'var(--fg2)' }}>
              <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Conditions:</span>{' '}
              {[
                eln.temperatureC !== '' && eln.temperatureC != null ? `${eln.temperatureC} °C` : null,
                eln.reactionTimeHours !== '' && eln.reactionTimeHours != null ? `${eln.reactionTimeHours} h` : null,
                eln.atmosphere || null,
                eln.agitation || null,
                eln.illumination && eln.illumination !== 'None' ? eln.illumination : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Not specified'}
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => setConditionsOpen((o) => !o)}
              style={{ fontSize: '11px', height: '26px', padding: '0 10px' }}
            >
              {conditionsOpen ? 'Hide conditions ▲' : 'Edit conditions ▼'}
            </button>
          </div>

          {conditionsOpen && (
            <div
              style={{
                marginTop: '10px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
                gap: '8px',
              }}
            >
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Temp (°C)</label>
                <input
                  type="number"
                  className="f sm mono"
                  value={eln.temperatureC ?? ''}
                  placeholder="e.g. 60"
                  onChange={(e) => updateEln({ temperatureC: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Heating Apparatus</label>
                <input
                  type="text"
                  className="f sm"
                  value={eln.heatingApparatus ?? ''}
                  placeholder="e.g. Al block"
                  onChange={(e) => updateEln({ heatingApparatus: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Reaction Time (h)</label>
                <input
                  type="number"
                  className="f sm mono"
                  value={eln.reactionTimeHours ?? ''}
                  placeholder="e.g. 16"
                  onChange={(e) => updateEln({ reactionTimeHours: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Atmosphere</label>
                <input
                  type="text"
                  className="f sm"
                  value={eln.atmosphere ?? ''}
                  placeholder="e.g. N2 Glovebox"
                  onChange={(e) => updateEln({ atmosphere: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Agitation</label>
                <input
                  type="text"
                  className="f sm"
                  value={eln.agitation ?? ''}
                  placeholder="e.g. Tumble 800 rpm"
                  onChange={(e) => updateEln({ agitation: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Illumination</label>
                <input
                  type="text"
                  className="f sm"
                  value={eln.illumination ?? ''}
                  placeholder="e.g. Blue LED 450nm"
                  onChange={(e) => updateEln({ illumination: e.target.value })}
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Plate Seal</label>
                <input
                  type="text"
                  className="f sm"
                  value={eln.plateSealType ?? ''}
                  placeholder="e.g. Teflon mat"
                  onChange={(e) => updateEln({ plateSealType: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Focused ELN Workspace Sub-Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '14px',
          flexWrap: 'wrap',
        }}
      >
        <div className="seg" role="tablist" aria-label="ELN Workspace Tabs">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'observations'}
            className={subTab === 'observations' ? 'on' : ''}
            onClick={() => setSubTab('observations')}
          >
            1. Well Observations &amp; Scoring
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'scaleup'}
            className={subTab === 'scaleup' ? 'on' : ''}
            onClick={() => setSubTab('scaleup')}
          >
            2. Scale-Up Calculator
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'synthesis'}
            className={subTab === 'synthesis' ? 'on' : ''}
            onClick={() => setSubTab('synthesis')}
          >
            3. Campaign Synthesis &amp; Notes
          </button>
        </div>

        {/* Spreadsheet Export / Import Quick Bar (always handy on Observations tab) */}
        {subTab === 'observations' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Observation Entry Mode">
              <button
                type="button"
                className={workspaceMode === 'matrix' ? 'on' : ''}
                onClick={() => setWorkspaceMode('matrix')}
                title="Visual 6×9 plate grid with keyboard shortcuts and inspector"
              >
                Plate Grid
              </button>
              <button
                type="button"
                className={workspaceMode === 'spreadsheet' ? 'on' : ''}
                onClick={() => setWorkspaceMode('spreadsheet')}
                title="Excel-style editable spreadsheet for bulk scoring and CSV/XLSX import-export"
              >
                Spreadsheet View
              </button>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={handleExportCsv}
              title="Download ELN observations table as CSV"
            >
              Export CSV
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={handleExportXlsx}
              title="Download ELN observations workbook as Excel (.xlsx)"
            >
              Export XLSX
            </button>
            <button
              type="button"
              className="btn sm pri"
              onClick={() => importInputRef.current?.click()}
              title="Import scored observations from CSV, TSV, or Excel (.xlsx)"
            >
              Import Sheet
            </button>
          </div>
        )}
      </div>

      {/* ======================================================================== */}
      {/* TAB 1: WELL OBSERVATIONS & SCORING                                       */}
      {/* ======================================================================== */}
      {subTab === 'observations' && workspaceMode === 'matrix' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
            gap: '16px',
            alignItems: 'start',
          }}
        >
          {/* Left Column: 54-Well Plate Matrix */}
          <div className="card" style={{ padding: '16px 18px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '10px',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div className="ct" style={{ fontWeight: 600 }}>54-Well Plate Matrix</div>
                {numPlates > 1 && (
                  <div className="seg" role="group" aria-label="Plate selection">
                    {Array.from({ length: numPlates }).map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        className={activePlate === i ? 'on' : ''}
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
                  onClick={() => {
                    const next = !batchMode;
                    setBatchMode(next);
                    if (!next) setBatchSelection([]);
                  }}
                  title="Multi-well selection mode (or click any Row A–F or Column 1–9 header)"
                >
                  {batchMode ? `Batch Mode (${batchSelection.length})` : 'Batch Select'}
                </button>
                <div className="seg">
                  <button
                    type="button"
                    className={viewMode === 'observations' ? 'on' : ''}
                    onClick={() => setViewMode('observations')}
                  >
                    Observations
                  </button>
                  <button
                    type="button"
                    className={viewMode === 'recipes' ? 'on' : ''}
                    onClick={() => setViewMode('recipes')}
                  >
                    Recipe / mM
                  </button>
                </div>
              </div>
            </div>

            {/* Quick Filter Strip */}
            <div style={{ display: 'flex', gap: '5px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '10px' }}>
              {[
                { id: 'all', label: 'All Wells (54)', bg: 'var(--fg)', fg: 'var(--panel)' },
                { id: 'unscored', label: 'Unscored', bg: '#475569', fg: '#fff' },
                { id: 'hit', label: 'Top Hits', bg: '#059669', fg: '#fff' },
                { id: 'polymerized', label: 'Polymerized', bg: '#8b5cf6', fg: '#fff' },
                { id: 'precipitated', label: 'Precipitated', bg: '#d97706', fg: '#fff' },
                { id: 'volume_decreased', label: 'Volume Loss', bg: '#0284c7', fg: '#fff' },
                { id: 'has_notes', label: 'With Notes', bg: 'var(--acc)', fg: '#fff' },
              ].map((f) => {
                const active = tagFilter === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setTagFilter(f.id)}
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--line)',
                      borderRadius: '6px',
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 500,
                      whiteSpace: 'nowrap',
                      background: active ? f.bg : 'var(--soft)',
                      color: active ? f.fg : 'var(--fg2)',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>

            {/* Batch Action Toolbar when Batch Mode is active or wells are selected */}
            {(batchMode || batchSelection.length > 0) && (
              <div
                style={{
                  marginBottom: '10px',
                  padding: '8px 12px',
                  background: 'var(--soft)',
                  borderRadius: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  border: '1px dashed var(--acc)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600 }}>
                    {batchSelection.length} well{batchSelection.length === 1 ? '' : 's'} selected
                    <span style={{ fontWeight: 400, color: 'var(--mut)', marginLeft: '6px' }}>
                      (click A–F or 1–9 headers to select entire rows/columns)
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
                      className="btn sm"
                      onClick={() => {
                        setBatchSelection([]);
                        setBatchMode(false);
                      }}
                    >
                      Done
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#059669', color: '#fff', borderColor: '#059669', fontSize: '11px' }}
                    onClick={() => applyBatchStatus('hit')}
                  >
                    Mark Hit
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#10b981', color: '#fff', borderColor: '#10b981', fontSize: '11px' }}
                    onClick={() => applyBatchStatus('clean')}
                  >
                    Mark Clean
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#dc2626', color: '#fff', borderColor: '#dc2626', fontSize: '11px' }}
                    onClick={() => applyBatchStatus('decomp')}
                  >
                    Mark Decomp
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#8b5cf6', color: '#fff', borderColor: '#8b5cf6', fontSize: '11px' }}
                    onClick={() => applyBatchObservation('polymerized')}
                  >
                    + Polymerized
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#d97706', color: '#fff', borderColor: '#d97706', fontSize: '11px' }}
                    onClick={() => applyBatchObservation('precipitated')}
                  >
                    + Precipitated
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#0284c7', color: '#fff', borderColor: '#0284c7', fontSize: '11px' }}
                    onClick={() => applyBatchObservation('volume_decreased')}
                  >
                    + Vol Loss
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ background: '#0891b2', color: '#fff', borderColor: '#0891b2', fontSize: '11px' }}
                    onClick={() => applyBatchObservation('gas_evolution')}
                  >
                    + Gas
                  </button>
                </div>
              </div>
            )}

            {/* 6x9 Plate Grid with Clickable Row/Col Batch Headers */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '28px repeat(9, 1fr)',
                gap: '4px',
                userSelect: 'none',
              }}
            >
              {/* Top-left corner: Select all 54 */}
              <button
                type="button"
                onClick={() =>
                  toggleLineSelection(
                    Array.from({ length: PLATE_SIZE }, (_, i) => i),
                    'All 54 Wells'
                  )
                }
                title="Click to select or clear all 54 wells"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  background: batchSelection.length === PLATE_SIZE ? 'var(--acc)' : 'var(--soft)',
                  color: batchSelection.length === PLATE_SIZE ? 'var(--acc-fg)' : 'var(--mut)',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: 0,
                  height: '22px',
                }}
              >
                ALL
              </button>

              {/* Clickable Column Headers 1..9 */}
              {Array.from({ length: COLS }).map((_, c) => {
                const colIndices = Array.from({ length: ROWS }, (_, r) => r * COLS + c);
                const colSelected = colIndices.every((idx) => batchSelection.includes(idx));
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleLineSelection(colIndices, `Column ${c + 1}`)}
                    title={`Click to select all 6 wells in Column ${c + 1}`}
                    style={{
                      height: '22px',
                      borderRadius: '4px',
                      border: colSelected ? '1px solid var(--blue)' : '1px solid transparent',
                      background: colSelected ? 'rgba(58, 111, 214, 0.16)' : 'transparent',
                      color: colSelected ? 'var(--blue)' : 'var(--mut)',
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: 0,
                    }}
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
                    {/* Clickable Row Letter Header */}
                    <button
                      type="button"
                      onClick={() => toggleLineSelection(rowIndices, `Row ${rowLetter}`)}
                      title={`Click to select all 9 wells in Row ${rowLetter}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        fontWeight: 700,
                        borderRadius: '4px',
                        border: rowSelected ? '1px solid var(--blue)' : '1px solid transparent',
                        background: rowSelected ? 'rgba(58, 111, 214, 0.16)' : 'transparent',
                        color: rowSelected ? 'var(--blue)' : 'var(--mut)',
                        padding: 0,
                      }}
                    >
                      {rowLetter}
                    </button>

                    {/* 9 Wells in this Row */}
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

                      const rowData = run?.rows?.[gIdx];
                      const isBlank = triMeta && triMeta[gIdx]?.blank;
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
                      let border = isSelected ? '2px solid var(--acc)' : '1px solid var(--line)';
                      let badgeIcon = '';

                      if (obs.status === 'hit') {
                        bg = 'rgba(16, 185, 129, 0.22)';
                        border = isSelected ? '2px solid #059669' : '1px solid #10b981';
                        badgeIcon = 'HIT';
                      } else if (obs.tags?.includes('polymerized')) {
                        bg = 'rgba(139, 92, 246, 0.16)';
                        border = isSelected ? '2px solid #7c3aed' : '1px solid #8b5cf6';
                        badgeIcon = 'POLY';
                      } else if (obs.tags?.includes('precipitated')) {
                        bg = 'rgba(245, 158, 11, 0.16)';
                        border = isSelected ? '2px solid #d97706' : '1px solid #f59e0b';
                        badgeIcon = 'PPT';
                      } else if (
                        obs.tags?.includes('volume_decreased') ||
                        obs.tags?.includes('gas_evolution')
                      ) {
                        bg = 'rgba(14, 165, 233, 0.16)';
                        border = isSelected ? '2px solid #0284c7' : '1px solid #0ea5e9';
                        badgeIcon = obs.tags?.includes('gas_evolution') ? 'GAS' : 'VOL';
                      } else if (obs.status === 'clean') {
                        bg = 'rgba(16, 185, 129, 0.10)';
                        badgeIcon = 'OK';
                      } else if (obs.status === 'partial') {
                        bg = 'rgba(245, 158, 11, 0.08)';
                        badgeIcon = 'PART';
                      } else if (obs.status === 'sm_only') {
                        bg = 'rgba(107, 114, 128, 0.08)';
                        badgeIcon = 'SM';
                      } else if (obs.status === 'decomp') {
                        bg = 'rgba(239, 68, 68, 0.13)';
                        badgeIcon = 'DEC';
                      } else if (isBlank) {
                        bg = 'var(--soft)';
                        badgeIcon = 'BLK';
                      }

                      if (isBatchSelected) {
                        border = '2px solid var(--blue)';
                      }

                      return (
                        <div
                          key={c}
                          onClick={(e) => {
                            if (batchMode || e.shiftKey) {
                              if (!batchMode) setBatchMode(true);
                              setBatchSelection((prev) =>
                                prev.includes(wIdx) ? prev.filter((x) => x !== wIdx) : [...prev, wIdx]
                              );
                            } else {
                              setSelectedWellIdx(wIdx);
                            }
                          }}
                          style={{
                            height: '58px',
                            borderRadius: '6px',
                            background: bg,
                            border,
                            padding: '4px',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            position: 'relative',
                            opacity: matchesFilter ? 1 : 0.25,
                            transition: 'all 0.12s ease',
                            boxShadow: isSelected ? '0 0 0 1px var(--acc)' : 'none',
                          }}
                          title={`Well ${rowLetter}${c + 1} (#${wIdx + 1}) - Click to inspect, Shift+click to batch select`}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--mut)' }}>
                              {rowLetter}
                              {c + 1}
                            </span>
                            <span style={{ fontSize: '9px', fontWeight: 700 }}>{badgeIcon}</span>
                          </div>

                          {viewMode === 'observations' ? (
                            <div style={{ fontSize: '9px', lineHeight: '1.1', color: 'var(--fg)', overflow: 'hidden' }}>
                              {obs.tags && obs.tags.length > 0 ? (
                                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--fg2)' }}>
                                  {obs.tags.map((t) => t.replace('_', ' ')).join(', ')}
                                </div>
                              ) : obs.notes ? (
                                <div
                                  style={{
                                    fontStyle: 'italic',
                                    color: 'var(--mut)',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {obs.notes}
                                </div>
                              ) : isBlank ? (
                                <span style={{ color: 'var(--mut)' }}>Blank</span>
                              ) : (
                                <span style={{ color: 'var(--mut)' }}>—</span>
                              )}
                            </div>
                          ) : (
                            <div style={{ fontSize: '9px', lineHeight: '1.1', color: 'var(--fg)', overflow: 'hidden' }}>
                              {rowData ? (
                                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {rowData.recipe
                                    .filter((rec) => rec.target_concentration > 0)
                                    .slice(0, 2)
                                    .map((rec) => `${rec.code} ${+rec.target_concentration.toFixed(1)}`)
                                    .join(', ')}
                                </div>
                              ) : (
                                '-'
                              )}
                            </div>
                          )}

                          {obs.conversion != null && (
                            <div style={{ fontSize: '8px', fontWeight: 700, color: '#059669', textAlign: 'right' }}>
                              {obs.conversion}%
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Keyboard & Mouse Shortcut Guide */}
            <div
              style={{
                marginTop: '12px',
                paddingTop: '10px',
                borderTop: '1px solid var(--line)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                fontSize: '11px',
                color: 'var(--mut)',
              }}
            >
              <div>
                <b>Keys:</b> Arrows move · <span className="mono">1–5</span> outcome ·{' '}
                <span className="mono">P/C/V/G</span> tags · Click <span className="mono">A–F / 1–9</span> batch
              </div>
              <div>
                Plate {activePlate + 1} of {numPlates}
              </div>
            </div>
          </div>

          {/* Right Column: Selected Well Observation Inspector */}
          <div className="card" style={{ padding: '16px 18px', borderTop: '3px solid var(--acc)' }}>
            {/* Inspector Header with Prev/Next and Auto-advance */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '10px',
                marginBottom: '10px',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    color: 'var(--mut)',
                    letterSpacing: '0.04em',
                  }}
                >
                  Well Inspector &amp; Observations
                </div>
                <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0 0', color: 'var(--fg)' }}>
                  Well {ROW_LETTERS[Math.floor(selectedWellIdx / COLS)]}
                  {(selectedWellIdx % COLS) + 1}
                  <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--mut)', marginLeft: '8px' }}>
                    #{currentGlobalIdx + 1} · Plate {activePlate + 1}
                  </span>
                </h2>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11px',
                    color: 'var(--mut)',
                    cursor: 'pointer',
                    marginRight: '4px',
                  }}
                  title="Automatically step to the next well after scoring an outcome"
                >
                  <input
                    type="checkbox"
                    checked={autoAdvance}
                    onChange={(e) => setAutoAdvance(e.target.checked)}
                  />
                  Auto-next
                </label>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setSelectedWellIdx((prev) => (prev - 1 + PLATE_SIZE) % PLATE_SIZE)}
                  title="Previous well (Left arrow)"
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setSelectedWellIdx((prev) => (prev + 1) % PLATE_SIZE)}
                  title="Next well (Right arrow)"
                >
                  Next →
                </button>
              </div>
            </div>

            {/* Condition description & recipe */}
            <div
              style={{
                padding: '8px 10px',
                background: 'var(--soft)',
                borderRadius: '6px',
                marginBottom: '12px',
                fontSize: '12px',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
                {currentLabel?.name || 'Reaction condition'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                {currentLabel?.cond || 'Plate coordinates'}
              </div>
              {currentRecipe.length > 0 && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--fg2)', fontFamily: 'monospace' }}>
                  {currentRecipe
                    .filter((rec) => rec.target_concentration > 0)
                    .map(
                      (rec) =>
                        `${rec.code}: ${rec.target_concentration} mM${
                          rec.equivalence != null ? ` (${rec.equivalence} eq)` : ''
                        }`
                    )
                    .join(' · ') || 'Solvent only'}
                </div>
              )}
            </div>

            {/* 1. Outcome Status Picker */}
            <div style={{ marginBottom: '12px' }}>
              <label className="lbl" style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', display: 'block' }}>
                Screening Outcome / Category
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                {OUTCOME_OPTIONS.map((opt) => {
                  const isSelected = currentWellObs.status === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => assignOutcomeAndMaybeAdvance(opt.id, true)}
                      style={{
                        textAlign: 'left',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: isSelected ? `2px solid ${opt.color}` : '1px solid var(--line)',
                        background: isSelected ? opt.bg : 'var(--panel)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                        fontSize: '11px',
                        fontWeight: isSelected ? 700 : 500,
                        color: isSelected ? opt.color : 'var(--fg)',
                      }}
                    >
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {opt.label}
                      </span>
                      {opt.hotkey && (
                        <kbd
                          style={{
                            fontSize: '9px',
                            padding: '1px 4px',
                            borderRadius: '3px',
                            background: 'var(--soft)',
                            border: '1px solid var(--line)',
                            color: 'var(--mut)',
                          }}
                        >
                          {opt.hotkey}
                        </kbd>
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => updateWell(activePlate, selectedWellIdx, { status: 'none', scaleUpSelected: false })}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: 'var(--mut)',
                  }}
                >
                  Clear Outcome
                </button>
              </div>
            </div>

            {/* 2. Physical Observations Quick Chips */}
            <div style={{ marginBottom: '12px' }}>
              <label
                className="lbl"
                style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}
              >
                <span>Physical Observations</span>
                <span style={{ fontSize: '10px', color: 'var(--mut)', fontWeight: 400 }}>Click to toggle</span>
              </label>
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                {OBSERVATION_TAGS.map((t) => {
                  const active = currentWellObs.tags?.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleWellTag(activePlate, selectedWellIdx, t.id)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: '6px',
                        border: active ? `1.5px solid ${t.color}` : '1px solid var(--line)',
                        background: active ? t.color : 'var(--panel)',
                        color: active ? '#ffffff' : 'var(--fg)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                      title={t.desc}
                    >
                      <span>{t.label}</span>
                      {t.hotkey && (
                        <span style={{ fontSize: '9px', opacity: active ? 0.9 : 0.6 }}>[{t.hotkey}]</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 3. Quantitative Conversion, Yield & Color */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>% Conversion</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  className="f sm mono"
                  placeholder="0–100"
                  value={currentWellObs.conversion ?? ''}
                  onChange={(e) =>
                    updateWell(activePlate, selectedWellIdx, {
                      conversion: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>% Assay Yield</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  className="f sm mono"
                  placeholder="0–100"
                  value={currentWellObs.yield ?? ''}
                  onChange={(e) =>
                    updateWell(activePlate, selectedWellIdx, {
                      yield: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className="lbl" style={{ fontSize: '10px' }}>Color Post-Reaction</label>
                <input
                  type="text"
                  className="f sm"
                  placeholder="e.g. Amber"
                  value={currentWellObs.colorAfter || ''}
                  onChange={(e) => updateWell(activePlate, selectedWellIdx, { colorAfter: e.target.value })}
                />
              </div>
            </div>

            {/* 4. Detailed Well Notes */}
            <div style={{ marginBottom: '12px' }}>
              <label className="lbl" style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
                Detailed Well Notes
              </label>
              <textarea
                className="f"
                rows={2}
                style={{ width: '100%', resize: 'vertical', fontSize: '12px', lineHeight: '1.4' }}
                placeholder="e.g. Polymerized into rubbery solid after 2h; volume decreased by ~30%..."
                value={currentWellObs.notes || ''}
                onChange={(e) => updateWell(activePlate, selectedWellIdx, { notes: e.target.value })}
              />
            </div>

            {/* 5. Embedded TLC Lane & Densitogram Preview */}
            <WellTlcPreview
              tlcSet={activeTlcSet}
              wellIndex={selectedWellIdx}
              plateIndex={activePlate}
              onOpenTlcMap={jumpToWellTlc}
            />
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* TAB 1B: EXPORTABLE & IMPORTABLE SPREADSHEET VIEW                         */}
      {/* ======================================================================== */}
      {subTab === 'observations' && workspaceMode === 'spreadsheet' && (
        <div
          className="card"
          style={{
            padding: '16px 18px',
            border: sheetDragOver ? '2px dashed var(--acc)' : '1px solid var(--line)',
            transition: 'border-color 0.15s ease',
          }}
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
          {/* Spreadsheet Toolbar */}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className="ct" style={{ fontWeight: 600 }}>
                Observations Spreadsheet ({spreadsheetRows.length} rows)
              </div>
              {numPlates > 1 && (
                <div className="seg">
                  <button
                    type="button"
                    className={sheetScope === 'plate' ? 'on' : ''}
                    onClick={() => setSheetScope('plate')}
                  >
                    Plate {activePlate + 1}
                  </button>
                  <button
                    type="button"
                    className={sheetScope === 'all' ? 'on' : ''}
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
                      onClick={() => setActivePlate(i)}
                    >
                      P{i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="f sm"
                style={{ width: '210px' }}
                placeholder="Filter well, reagent, notes..."
                value={sheetSearch}
                onChange={(e) => setSheetSearch(e.target.value)}
              />
              <button
                type="button"
                className="btn sm"
                onClick={handleExportCsv}
              >
                Download CSV
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={handleExportXlsx}
              >
                Download XLSX
              </button>
              <button
                type="button"
                className="btn sm pri"
                onClick={() => importInputRef.current?.click()}
              >
                Import CSV / XLSX
              </button>
            </div>
          </div>

          {/* Filter Strip + Hint */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '10px',
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
                    onClick={() => setTagFilter(f.id)}
                    style={{
                      cursor: 'pointer',
                      border: '1px solid var(--line)',
                      borderRadius: '6px',
                      padding: '3px 9px',
                      fontSize: '11px',
                      fontWeight: active ? 600 : 500,
                      background: active ? 'var(--acc)' : 'var(--soft)',
                      color: active ? 'var(--acc-fg)' : 'var(--fg2)',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
              Tip: Press <span className="mono">Enter</span> or <span className="mono">↑ / ↓</span> to jump rows · Drag &amp; drop a `.csv` or `.xlsx` file here to import
            </div>
          </div>

          {/* Editable Table */}
          <div className="tbl" style={{ maxHeight: '64vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--soft)' }}>
                <tr>
                  <th style={{ width: '76px' }}>Well</th>
                  <th style={{ minWidth: '170px' }}>Condition / Recipe</th>
                  <th style={{ width: '155px' }}>Outcome</th>
                  <th style={{ width: '76px' }}>Conv %</th>
                  <th style={{ width: '76px' }}>Yield %</th>
                  <th style={{ minWidth: '210px' }}>Physical Tags</th>
                  <th style={{ width: '110px' }}>Color</th>
                  <th style={{ minWidth: '210px' }}>Notes</th>
                  <th style={{ width: '88px' }}>TLC Rf</th>
                </tr>
              </thead>
              <tbody>
                {spreadsheetRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '28px', color: 'var(--mut)' }}>
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
                              ? 'rgba(11, 107, 95, 0.06)'
                              : undefined,
                        }}
                      >
                        {/* Well Coord */}
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setActivePlate(pIdx);
                              setSelectedWellIdx(wIdx);
                              setWorkspaceMode('matrix');
                            }}
                            title="Open well in Plate Grid & Inspector"
                            style={{
                              border: '1px solid var(--line)',
                              borderRadius: '5px',
                              padding: '2px 7px',
                              background: 'var(--soft)',
                              fontWeight: 700,
                              fontFamily: 'monospace',
                              fontSize: '11px',
                            }}
                          >
                            {numPlates > 1 ? `P${pIdx + 1}-` : ''}
                            {coord}
                          </button>
                        </td>

                        {/* Condition / Recipe */}
                        <td>
                          <div style={{ fontWeight: 500, fontSize: '11px', color: 'var(--fg)' }}>
                            {condLabel || `Reaction #${item.gIdx + 1}`}
                          </div>
                          {recipeSummary && (
                            <div
                              className="mono"
                              style={{
                                fontSize: '10px',
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

                        {/* Outcome Select */}
                        <td>
                          <select
                            className="f sm"
                            style={{ width: '100%', fontSize: '11px', padding: '3px 6px' }}
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

                        {/* Conv % */}
                        <td>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            data-sheet-cell={`conv-${rIdx}`}
                            className="f sm mono"
                            style={{ width: '100%', textAlign: 'right', padding: '3px 5px', fontSize: '11px' }}
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

                        {/* Yield % */}
                        <td>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            data-sheet-cell={`yield-${rIdx}`}
                            className="f sm mono"
                            style={{ width: '100%', textAlign: 'right', padding: '3px 5px', fontSize: '11px' }}
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

                        {/* Physical Tags Inline Toggles */}
                        <td>
                          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                            {OBSERVATION_TAGS.filter((t) => QUICK_SPREADSHEET_TAGS.includes(t.id)).map((t) => {
                              const active = obs.tags?.includes(t.id);
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() => toggleWellTag(pIdx, wIdx, t.id)}
                                  title={t.label}
                                  style={{
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    fontSize: '10px',
                                    fontWeight: 600,
                                    border: active ? `1px solid ${t.color}` : '1px solid var(--line)',
                                    background: active ? t.color : 'var(--panel)',
                                    color: active ? '#fff' : 'var(--mut)',
                                  }}
                                >
                                  {t.short}
                                </button>
                              );
                            })}
                          </div>
                        </td>

                        {/* Color */}
                        <td>
                          <input
                            type="text"
                            data-sheet-cell={`color-${rIdx}`}
                            className="f sm"
                            style={{ width: '100%', padding: '3px 6px', fontSize: '11px' }}
                            placeholder="Color..."
                            value={obs.colorAfter || ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'color')}
                            onChange={(e) => updateWell(pIdx, wIdx, { colorAfter: e.target.value })}
                          />
                        </td>

                        {/* Notes */}
                        <td>
                          <input
                            type="text"
                            data-sheet-cell={`notes-${rIdx}`}
                            className="f sm"
                            style={{ width: '100%', padding: '3px 6px', fontSize: '11px' }}
                            placeholder="Add note..."
                            value={obs.notes || ''}
                            onKeyDown={(e) => handleSpreadsheetCellKeyDown(e, rIdx, 'notes')}
                            onChange={(e) => updateWell(pIdx, wIdx, { notes: e.target.value })}
                          />
                        </td>

                        {/* TLC Rf */}
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setTargetWell({ wellIndex: wIdx, plateIndex: pIdx, source: 'palette' });
                              setVisited((v) => ({ ...v, tlc: true }));
                              setView('tlc');
                            }}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              padding: 0,
                              fontSize: '11px',
                              fontFamily: 'monospace',
                              color: mainRf ? 'var(--acc)' : 'var(--mut)',
                              textDecoration: mainRf ? 'underline' : 'none',
                            }}
                            title="Open lane in TLC Map"
                          >
                            {mainRf || '—'}
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
        <div className="card" style={{ padding: '18px 20px', borderTop: '3px solid #059669' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px',
              marginBottom: '16px',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  fontWeight: 700,
                  color: '#059669',
                  letterSpacing: '0.04em',
                }}
              >
                HTE Hit Translation
              </div>
              <h2 style={{ fontSize: '17px', fontWeight: 700, margin: '2px 0 0', color: 'var(--fg)' }}>
                Scale-Up Recipe Calculator
              </h2>
              <p className="sub" style={{ margin: '2px 0 0' }}>
                Translates micro-scale screening concentrations into grams, milliliters, and a draft notebook procedure.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <label className="lbl" style={{ fontSize: '10px', marginBottom: '2px' }}>Source Well</label>
                <select
                  className="f sm"
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
                <label className="lbl" style={{ fontSize: '10px', marginBottom: '2px' }}>Target Scale (mmol)</label>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <div className="seg">
                    {[0.5, 1.0, 2.0, 5.0, 10.0].map((sc) => (
                      <button
                        key={sc}
                        type="button"
                        className={scaleUpScaleMmol === sc ? 'on' : ''}
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
                    className="f sm mono"
                    style={{ width: '74px' }}
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
            <div>
              <div className="tbl" style={{ marginBottom: '16px' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Reagent</th>
                      <th>Screen conc (mM)</th>
                      <th>Equiv (eq)</th>
                      <th>Scale (mmol)</th>
                      <th>MW (g/mol)</th>
                      <th>Mass to weigh</th>
                      <th>Liquid Vol</th>
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
                        <td className="mono">{c.mw > 0 ? c.mw : '-'}</td>
                        <td className="mono">
                          {c.massG != null ? (
                            <b>
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
                            : '-'}
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
                    marginBottom: '6px',
                  }}
                >
                  <label className="lbl" style={{ margin: 0, fontSize: '11px', fontWeight: 600 }}>
                    Generated Experimental Procedure (Ready for Laboratory Notebook / SI)
                  </label>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedProcedure);
                      toast('Copied experimental procedure to clipboard!');
                    }}
                  >
                    Copy Procedure
                  </button>
                </div>
                <textarea
                  className="f mono"
                  rows={5}
                  readOnly
                  style={{ width: '100%', fontSize: '12px', lineHeight: '1.5', background: 'var(--soft)' }}
                  value={generatedProcedure}
                />
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: '24px',
                textAlign: 'center',
                color: 'var(--mut)',
                background: 'var(--soft)',
                borderRadius: '8px',
              }}
            >
              Select a well with an active reaction recipe to calculate bench scale-up reagents.
            </div>
          )}
        </div>
      )}

      {/* ======================================================================== */}
      {/* TAB 3: CAMPAIGN SYNTHESIS & NOTES                                        */}
      {/* ======================================================================== */}
      {subTab === 'synthesis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
              toast('Appended AI Synthesis Report to Campaign Notes.');
            }}
            onReplaceNotes={(text) => {
              updateEln({ postReactionNotes: text });
              toast('Updated Campaign Notes with AI Synthesis Report.');
            }}
          />

          <div className="card" style={{ padding: '18px 20px' }}>
            <div className="chead">
              <div className="ct">Campaign Post-Reaction Observations &amp; Synthesis Notes</div>
              <button
                type="button"
                className="btn sm"
                onClick={() => window.print()}
                title="Print current ELN page via browser print dialog"
              >
                Print ELN View
              </button>
            </div>
            <textarea
              className="f"
              rows={5}
              style={{ width: '100%', resize: 'vertical', fontSize: '13px', marginTop: '8px' }}
              placeholder="Overall campaign conclusions: e.g. Ligands L1 and L2 showed complete conversion across all 3 bases; base B3 caused severe polymerization at 60 °C; volume loss occurred in corner wells A1 and F9 due to edge seal relaxation..."
              value={eln.postReactionNotes || ''}
              onChange={(e) => updateEln({ postReactionNotes: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
};
