import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  GitBranch,
  Layers,
  LayoutGrid,
  List,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  MediumMode,
  PathwayFamily,
  PathwaySpeciesNode,
  PredictedSpecies,
  PredictorSubstrateInput,
  SpeciesBondHighlights,
  WellConditionConfig,
  WellPredictionResult,
  applyRunConditionsPatch,
  computeSpeciesHighlightBonds,
  exportLcmsTargetListCsv,
  extractWellForPrediction,
  getCanonicalRunConditions,
  getSuggestedWellDisplay,
  groupSpeciesByPathway,
  predictWellReactions,
  wellLabel,
} from '../../engine';
import { getRDKitInstance } from '../../utils/rdkit';
import { ChemicalStructure, resolveChemicalNameToSmiles } from '../ui/ChemicalStructure';
import { AiSolventAdvisorModal } from '../ui/AiSolventAdvisorModal';

const PLATE_SIZE = 54;
const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

interface SandboxPreset {
  id: string;
  title: string;
  subtitle: string;
  substrates: PredictorSubstrateInput[];
  condition: WellConditionConfig;
}

const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: 'ade_freebase',
    title: 'A + D + E (Free-base Guanidine)',
    subtitle: '4-Fluorobenzaldehyde + Boc-protected amino-guanidine + chalcone with 0.5 eq TsOH',
    substrates: [
      { id: 'A', code: 'A', name: '4-Fluorobenzaldehyde', smiles: 'O=Cc1ccc(F)cc1', equivalents: 1.0 },
      { id: 'D', code: 'D', name: 'N-Boc aminoethylguanidine', smiles: 'CC(C)(C)OC(=O)NCCN=C(N)N', equivalents: 1.0 },
      { id: 'E', code: 'E', name: 'Chalcone enone', smiles: 'O=C(C=Cc1ccccc1)c1ccccc1', equivalents: 1.0 },
    ],
    condition: {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 2.0,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    },
  },
  {
    id: 'ade_hcl',
    title: 'A + D·HCl + E (.Cl Salt)',
    subtitle: 'Same mixture when D is weighed as its monohydrochloride salt in SMILES',
    substrates: [
      { id: 'A', code: 'A', name: '4-Fluorobenzaldehyde', smiles: 'O=Cc1ccc(F)cc1', equivalents: 1.0 },
      { id: 'D', code: 'D', name: 'N-Boc aminoethylguanidine HCl', smiles: 'CC(C)(C)OC(=O)NCCN=C(N)N.Cl', equivalents: 1.0 },
      { id: 'E', code: 'E', name: 'Chalcone enone', smiles: 'O=C(C=Cc1ccccc1)c1ccccc1', equivalents: 1.0 },
    ],
    condition: {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 80,
      waterPct: 2.0,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    },
  },
  {
    id: 'knoevenagel_cascade',
    title: 'Aldehyde + Malononitrile + Aniline',
    subtitle: '3-component Knoevenagel → Michael → nitrile heterocyclization cascade',
    substrates: [
      { id: 'A', code: 'A', name: 'Benzaldehyde', smiles: 'O=Cc1ccccc1', equivalents: 1.0 },
      { id: 'B', code: 'B', name: 'Malononitrile', smiles: 'N#CCC#N', equivalents: 1.0 },
      { id: 'C', code: 'C', name: 'Aniline', smiles: 'Nc1ccccc1', equivalents: 1.0 },
    ],
    condition: {
      medium: 'base',
      additiveName: 'DBU',
      additiveEquiv: 0.3,
      additivePka: 13.9,
      temperatureC: 80,
      waterPct: 2.0,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    },
  },
  {
    id: 'hantzsch_thiazole',
    title: 'Hantzsch Thiazole (2-Component)',
    subtitle: '2-Bromoacetophenone + thiourea forming 4-phenylthiazol-2-amine',
    substrates: [
      { id: 'A', code: 'A', name: '2-Bromoacetophenone', smiles: 'O=C(CBr)c1ccccc1', equivalents: 1.0 },
      { id: 'B', code: 'B', name: 'Thiourea', smiles: 'NC(=S)N', equivalents: 1.0 },
    ],
    condition: {
      medium: 'neutral',
      additiveName: 'None (Neutral)',
      additiveEquiv: 0,
      additivePka: 7.0,
      temperatureC: 80,
      waterPct: 1.0,
      solvent: 'EtOH',
      equivBasis: 'limiting',
    },
  },
  {
    id: 'ester_fragment_cascade',
    title: 'Ester + Amine + Aldehyde (Fragment Reuse)',
    subtitle: 'Amidation releases MeOH back into the well pool for downstream esterification/acetal chemistry',
    substrates: [
      { id: 'A', code: 'A', name: 'Methyl benzoate', smiles: 'COC(=O)c1ccccc1', equivalents: 1.0 },
      { id: 'B', code: 'B', name: 'Benzylamine', smiles: 'NCc1ccccc1', equivalents: 1.0 },
      { id: 'C', code: 'C', name: '3-Bromopropionic acid', smiles: 'O=C(O)CCBr', equivalents: 1.0 },
    ],
    condition: {
      medium: 'acid',
      additiveName: 'TsOH',
      additiveEquiv: 0.5,
      additivePka: 0.9,
      temperatureC: 90,
      waterPct: 0.5,
      solvent: 'DMSO',
      equivBasis: 'limiting',
    },
  },
];

function downloadCsv(filename: string, csvText: string) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function tierColor(tier: PredictedSpecies['tier']): { fg: string; bg: string; bd: string } {
  if (tier === 'High') return { fg: 'var(--ok)', bg: 'var(--okbg)', bd: 'color-mix(in srgb, var(--ok) 35%, transparent)' };
  if (tier === 'Medium') return { fg: 'var(--blue)', bg: 'color-mix(in srgb, var(--blue) 12%, transparent)', bd: 'color-mix(in srgb, var(--blue) 35%, transparent)' };
  if (tier === 'Low') return { fg: 'var(--warn)', bg: 'var(--warnbg)', bd: 'color-mix(in srgb, var(--warn) 35%, transparent)' };
  return { fg: 'var(--mut)', bg: 'var(--soft)', bd: 'var(--line)' };
}

function mediumLabel(m: string): string {
  if (m === 'free_acid') return 'Free Acid';
  if (m === 'free_base') return 'Free Base';
  if (m === 'buffered') return 'Buffered';
  return 'Neutral';
}

export const PredictionView: React.FC = () => {
  const {
    state,
    setState,
    run,
    triMeta,
    targetWell,
    setTargetWell,
    addWellToCompare,
    toast,
  } = useApp();

  const [rdkit, setRdkit] = useState<any>(null);
  const [rdkitLoading, setRdkitLoading] = useState<boolean>(true);
  const [mode, setMode] = useState<'plate' | 'sandbox'>(run && run.rows.length > 0 ? 'plate' : 'sandbox');

  // Plate mode states (Temperature & Base Water read/write directly to canonical RunState so Setup/ELN/TLC/Compare stay synced)
  const [activePlate, setActivePlate] = useState<number>(0);
  const [selectedWellIdx, setSelectedWellIdx] = useState<number>(0);
  const canonicalCond = useMemo(() => getCanonicalRunConditions(state), [state]);
  const plateTempC = canonicalCond.temperatureC;
  const plateWaterPct = canonicalCond.baseWaterPct;
  const [mediumOverride, setMediumOverride] = useState<'auto' | 'acid' | 'base' | 'neutral'>('auto');
  const [includeSpeculative, setIncludeSpeculative] = useState<boolean>(false);

  // Batch prediction state for current plate
  const [plateResults, setPlateResults] = useState<Record<string, WellPredictionResult>>({});
  const [batchProgress, setBatchProgress] = useState<{ running: boolean; done: number; total: number }>({
    running: false,
    done: 0,
    total: 0,
  });
  const batchCancelRef = useRef<boolean>(false);
  const [showSolventAdvisor, setShowSolventAdvisor] = useState<boolean>(false);

  // Sandbox mode states
  const [sandboxSubs, setSandboxSubs] = useState<PredictorSubstrateInput[]>(() =>
    JSON.parse(JSON.stringify(SANDBOX_PRESETS[0].substrates))
  );
  const [sandboxCond, setSandboxCond] = useState<WellConditionConfig>(() =>
    JSON.parse(JSON.stringify(SANDBOX_PRESETS[0].condition))
  );
  const [sandboxResult, setSandboxResult] = useState<WellPredictionResult | null>(null);
  const [resolvingCode, setResolvingCode] = useState<string | null>(null);

  // Initialize RDKit WebAssembly once
  useEffect(() => {
    let active = true;
    getRDKitInstance().then((inst) => {
      if (!active) return;
      setRdkit(inst);
      setRdkitLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  // Honor navigation targetWell from Combinations / ELN / TLC / Palette
  useEffect(() => {
    if (!targetWell) return;
    setMode('plate');
    setActivePlate(targetWell.plateIndex ?? 0);
    setSelectedWellIdx(targetWell.wellIndex ?? 0);
    setTargetWell(null);
  }, [targetWell, setTargetWell]);

  // Keep plate vs sandbox synced when run changes
  useEffect(() => {
    if (!run || run.rows.length === 0) {
      setMode('sandbox');
    }
  }, [run]);

  // Map run rows cleanly by (plate_number, container_id)
  const rowByPlateWell = useMemo(() => {
    const map = new Map<string, any>();
    if (run?.rows) {
      run.rows.forEach((r, idx) => {
        const p = r.plate_number ?? Math.floor(idx / PLATE_SIZE);
        const w = r.container_id ?? idx % PLATE_SIZE;
        map.set(`${p}-${w}`, r);
      });
    }
    return map;
  }, [run]);

  const numPlates = run?.plates || 1;
  const currentRow =
    rowByPlateWell.get(`${activePlate}-${selectedWellIdx}`) ??
    run?.rows?.[activePlate * PLATE_SIZE + selectedWellIdx] ??
    null;

  const conditionOverrides = useMemo<Partial<WellConditionConfig>>(() => {
    const ov: Partial<WellConditionConfig> = {
      temperatureC: plateTempC,
      waterPct: plateWaterPct,
    };
    if (mediumOverride === 'acid') {
      ov.medium = 'acid';
      ov.additiveName = 'TsOH (override)';
      ov.additiveEquiv = 0.5;
      ov.additivePka = 0.9;
    } else if (mediumOverride === 'base') {
      ov.medium = 'base';
      ov.additiveName = 'DBU (override)';
      ov.additiveEquiv = 0.5;
      ov.additivePka = 13.9;
    } else if (mediumOverride === 'neutral') {
      ov.medium = 'neutral';
      ov.additiveName = 'Neutral (override)';
      ov.additiveEquiv = 0;
      ov.additivePka = 7.0;
    }
    return ov;
  }, [plateTempC, plateWaterPct, mediumOverride]);

  const rowRecipeSig = useCallback((row: any): string => {
    if (!row?.recipe) return '';
    return (row.recipe as any[])
      .filter((it) => Number(it.target_concentration) > 0)
      .map((it) => `${it.code}=${Number(it.target_concentration)}:${it.equivalence ?? ''}`)
      .join(';');
  }, []);

  const plateChemSig = useMemo(() => {
    const reagentSig = (state.reagents || [])
      .map((r) => `${r.code}:${r.name || ''}:${r.iupac || ''}:${r.smiles || ''}`)
      .join('|');
    const triAddSig = (state.tri?.adds || [])
      .map((a) => `${a.code}:${a.equiv}`)
      .join('|');
    return [
      state.mode,
      canonicalCond.solvent,
      canonicalCond.temperatureC,
      canonicalCond.baseWaterPct,
      canonicalCond.reactionTimeHours,
      canonicalCond.atmosphere,
      canonicalCond.agitation,
      mediumOverride,
      includeSpeculative ? '1' : '0',
      reagentSig,
      triAddSig,
    ].join('::');
  }, [
    state.mode,
    state.reagents,
    state.tri?.adds,
    canonicalCond.solvent,
    canonicalCond.temperatureC,
    canonicalCond.baseWaterPct,
    canonicalCond.reactionTimeHours,
    canonicalCond.atmosphere,
    canonicalCond.agitation,
    mediumOverride,
    includeSpeculative,
  ]);

  const currentRowSig = useMemo(() => rowRecipeSig(currentRow), [rowRecipeSig, currentRow]);
  const wellPredCacheRef = useRef<Map<string, WellPredictionResult>>(new Map());
  const plateResultSigRef = useRef<Record<string, string>>({});

  const currentExtraction = useMemo(() => {
    if (!currentRow) return null;
    return extractWellForPrediction(state, currentRow, conditionOverrides);
    // Only re-extract when chemical composition, row recipe concentrations, or reaction conditions change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plateChemSig, currentRowSig, activePlate, selectedWellIdx]);

  const activeWellInputSig = currentRow ? `${plateChemSig}::${currentRowSig}` : '';

  const activeWellResult = useMemo<WellPredictionResult | null>(() => {
    if (!rdkit || !currentExtraction || mode !== 'plate' || !activeWellInputSig) return null;
    const validSubs = currentExtraction.substrates.filter((s) => s.smiles.trim().length > 0);
    if (validSubs.length === 0) return null;

    const cached = wellPredCacheRef.current.get(activeWellInputSig);
    if (cached) return cached;

    try {
      const res = predictWellReactions(rdkit, validSubs, currentExtraction.condition, {
        includeSpeculative,
      });
      if (wellPredCacheRef.current.size > 600) {
        const firstKey = wellPredCacheRef.current.keys().next().value;
        if (firstKey !== undefined) wellPredCacheRef.current.delete(firstKey);
      }
      wellPredCacheRef.current.set(activeWellInputSig, res);
      return res;
    } catch {
      return null;
    }
  }, [rdkit, currentExtraction, mode, activeWellInputSig, includeSpeculative]);

  // Synchronize plateResults matrix badges when chemistry/conditions/recipes change, hydrating immediately from cache when available
  const prevChemSigRef = useRef<string>(plateChemSig);
  useEffect(() => {
    const chemChanged = prevChemSigRef.current !== plateChemSig;
    prevChemSigRef.current = plateChemSig;

    if (!chemChanged) {
      let anyWellChanged = false;
      for (const [key, prevSig] of Object.entries(plateResultSigRef.current)) {
        const [pStr, wStr] = key.split('-');
        const p = Number(pStr);
        const w = Number(wStr);
        const r = rowByPlateWell.get(key) ?? run?.rows?.[p * PLATE_SIZE + w];
        const curSig = r ? `${plateChemSig}::${rowRecipeSig(r)}` : '';
        if (prevSig !== curSig) {
          anyWellChanged = true;
          break;
        }
      }
      if (!anyWellChanged) return;
    }

    const nextMap: Record<string, WellPredictionResult> = {};
    const nextSigs: Record<string, string> = {};
    if (run?.rows) {
      for (let p = 0; p < numPlates; p++) {
        for (let w = 0; w < PLATE_SIZE; w++) {
          const key = `${p}-${w}`;
          const r = rowByPlateWell.get(key) ?? run.rows[p * PLATE_SIZE + w];
          if (!r) continue;
          const sig = `${plateChemSig}::${rowRecipeSig(r)}`;
          const hit = wellPredCacheRef.current.get(sig);
          if (hit) {
            nextMap[key] = hit;
            nextSigs[key] = sig;
          }
        }
      }
    }
    plateResultSigRef.current = nextSigs;
    setPlateResults(nextMap);
  }, [plateChemSig, run, numPlates, rowByPlateWell, rowRecipeSig]);

  // Cache single-well calculation back into plateResults map for matrix badges & CSV export
  const activeKey = `${activePlate}-${selectedWellIdx}`;
  useEffect(() => {
    if (activeWellResult && activeWellInputSig) {
      plateResultSigRef.current[activeKey] = activeWellInputSig;
      setPlateResults((prev) => {
        if (prev[activeKey] === activeWellResult) return prev;
        return { ...prev, [activeKey]: activeWellResult };
      });
    }
  }, [activeKey, activeWellResult, activeWellInputSig]);

  // Run Sandbox prediction automatically when RDKit ready and inputs update
  const runSandboxNow = useCallback(() => {
    if (!rdkit) return;
    const valid = sandboxSubs.filter((s) => s.smiles.trim().length > 0 && s.equivalents > 0);
    if (valid.length === 0) {
      setSandboxResult(null);
      return;
    }
    try {
      const res = predictWellReactions(rdkit, valid, sandboxCond, { includeSpeculative });
      setSandboxResult(res);
    } catch (e: any) {
      toast('Prediction error: ' + (e?.message || e));
    }
  }, [rdkit, sandboxSubs, sandboxCond, includeSpeculative, toast]);

  useEffect(() => {
    if (mode === 'sandbox' && rdkit) {
      runSandboxNow();
    }
  }, [mode, rdkit, runSandboxNow]);

  // Batch analyze active plate cleanly without freezing UI (reusing cached & identical replicate wells)
  const runPlateBatch = async () => {
    if (!rdkit || !run) return;
    batchCancelRef.current = false;
    const wellsToRun: Array<{ key: string; wIdx: number; row: any }> = [];
    for (let w = 0; w < PLATE_SIZE; w++) {
      const r = rowByPlateWell.get(`${activePlate}-${w}`) ?? run.rows[activePlate * PLATE_SIZE + w];
      if (!r) continue;
      const gIdx = r.global_index ?? activePlate * PLATE_SIZE + w;
      if (state.mode === 'triplet' && triMeta[gIdx]?.blank) continue;
      wellsToRun.push({ key: `${activePlate}-${w}`, wIdx: w, row: r });
    }
    if (wellsToRun.length === 0) return;

    setBatchProgress({ running: true, done: 0, total: wellsToRun.length });
    const accumulated: Record<string, WellPredictionResult> = { ...plateResults };

    for (let i = 0; i < wellsToRun.length; i++) {
      if (batchCancelRef.current) break;
      const { key, row } = wellsToRun[i];
      const sig = `${plateChemSig}::${rowRecipeSig(row)}`;
      const cached = wellPredCacheRef.current.get(sig);
      if (cached) {
        accumulated[key] = cached;
        plateResultSigRef.current[key] = sig;
      } else {
        const ext = extractWellForPrediction(state, row, conditionOverrides);
        const validSubs = ext.substrates.filter((s) => s.smiles.trim().length > 0);
        if (validSubs.length > 0) {
          try {
            const res = predictWellReactions(rdkit, validSubs, ext.condition, {
              includeSpeculative,
            });
            if (wellPredCacheRef.current.size > 600) {
              const firstKey = wellPredCacheRef.current.keys().next().value;
              if (firstKey !== undefined) wellPredCacheRef.current.delete(firstKey);
            }
            wellPredCacheRef.current.set(sig, res);
            accumulated[key] = res;
            plateResultSigRef.current[key] = sig;
          } catch {}
        }
      }
      setBatchProgress({ running: true, done: i + 1, total: wellsToRun.length });
      if ((i + 1) % 3 === 0 || i === wellsToRun.length - 1) {
        setPlateResults({ ...accumulated });
        if (!cached) {
          await new Promise((res) => setTimeout(res, 0));
        }
      }
    }
    setBatchProgress({ running: false, done: wellsToRun.length, total: wellsToRun.length });
    toast(`Analyzed ${wellsToRun.length} wells on Plate ${activePlate + 1}.`);
  };

  // Resolve reagent SMILES from PubChem directly inside Plate Predictor and save to Setup state
  const handleSaveReagentSmiles = (code: string, newSmiles: string) => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const idx = next.reagents.findIndex((r: any) => r.code === code);
      if (idx >= 0) {
        next.reagents[idx].smiles = newSmiles.trim();
      }
      return next;
    });
    setPlateResults({});
    toast(`Saved structure for ${code}.`);
  };

  const handleLookupReagentSmiles = async (code: string, name: string) => {
    const q = (name || '').trim();
    if (!q) {
      toast(`Enter a chemical name for ${code} first or paste SMILES directly.`);
      return;
    }
    setResolvingCode(code);
    try {
      const res = await resolveChemicalNameToSmiles(q);
      if (res?.smiles) {
        handleSaveReagentSmiles(code, res.smiles);
      } else {
        toast(`Could not resolve "${q}" automatically — paste SMILES directly.`);
      }
    } finally {
      setResolvingCode(null);
    }
  };

  const handleExportCurrentWellCsv = (res: WellPredictionResult, label: string, group: string) => {
    const csv = exportLcmsTargetListCsv([{ wellLabel: label, groupLabel: group, result: res }]);
    downloadCsv(`${(state.name || 'robowski').replace(/[^A-Za-z0-9_-]+/g, '_')}_${label}_lcms_targets.csv`, csv);
    toast(`Exported ${res.species.length} predicted LC-MS targets for ${label}.`);
  };

  const handleExportAnalyzedPlateCsv = () => {
    const entries: Array<{ wellLabel: string; groupLabel: string; result: WellPredictionResult }> = [];
    for (let w = 0; w < PLATE_SIZE; w++) {
      const key = `${activePlate}-${w}`;
      const res = plateResults[key];
      if (!res) continue;
      const r = rowByPlateWell.get(key) ?? run?.rows?.[activePlate * PLATE_SIZE + w];
      const groupLabel = r ? getSuggestedWellDisplay(r, run, triMeta) : `Well ${wellLabel(w)}`;
      entries.push({
        wellLabel: `P${activePlate + 1}_${wellLabel(w)}`,
        groupLabel,
        result: res,
      });
    }
    if (entries.length === 0) {
      toast('Analyze the plate or open wells first before exporting.');
      return;
    }
    const csv = exportLcmsTargetListCsv(entries);
    downloadCsv(`${(state.name || 'robowski').replace(/[^A-Za-z0-9_-]+/g, '_')}_plate${activePlate + 1}_lcms_targets.csv`, csv);
    toast(`Exported LC-MS target list for ${entries.length} wells on Plate ${activePlate + 1}.`);
  };

  const selectedWellTitle = currentRow ? getSuggestedWellDisplay(currentRow, run, triMeta) : `Well ${wellLabel(selectedWellIdx)}`;
  const activeCoord = wellLabel(selectedWellIdx);

  return (
    <div className="wrap">
      {/* Top Bar: Mode Switcher + Global Status */}
      <div className="card" style={{ marginBottom: '16px', padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FlaskConical size={18} style={{ color: 'var(--acc)' }} />
              <span>Reaction &amp; LC-MS Mass Predictor</span>
            </h2>
            <p className="sub" style={{ margin: '3px 0 0' }}>
              Visual reaction schemes, predicted products, and exact LC-MS adduct masses.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Predictor workspace mode">
              <button
                type="button"
                className={mode === 'plate' ? 'on' : ''}
                disabled={!run || run.rows.length === 0}
                onClick={() => setMode('plate')}
                title={run && run.rows.length > 0 ? 'Predict reactions directly inside your designed HTE plate wells' : 'Configure a run on Setup first to inspect plate wells'}
              >
                <LayoutGrid size={13} />
                <span>Plate &amp; Well Mode</span>
              </button>
              <button
                type="button"
                className={mode === 'sandbox' ? 'on' : ''}
                onClick={() => setMode('sandbox')}
                title="Test any arbitrary 1 to N substrates, salts, and conditions"
              >
                <FlaskConical size={13} />
                <span>Any-Component Sandbox</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {rdkitLoading && (
        <div className="card" style={{ textAlign: 'center', padding: '32px', color: 'var(--mut)' }}>
          Initializing local chemistry engine…
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODE 1: PLATE & WELL PREDICTOR                                         */}
      {/* ===================================================================== */}
      {!rdkitLoading && mode === 'plate' && run && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Plate Well Picker + Condition Controls */}
          <div className="card" style={{ padding: '16px 20px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
                marginBottom: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {numPlates > 1 && (
                  <div className="seg">
                    {Array.from({ length: numPlates }, (_, p) => (
                      <button
                        key={p}
                        type="button"
                        className={activePlate === p ? 'on' : ''}
                        onClick={() => setActivePlate(p)}
                      >
                        Plate {p + 1}
                      </button>
                    ))}
                  </div>
                )}
                <span style={{ fontSize: '13px', fontWeight: 600 }}>
                  Select Well · <span className="mono" style={{ color: 'var(--acc)' }}>{activeCoord}</span>
                </span>
                <span style={{ fontSize: '12.5px', color: 'var(--mut)' }}>{selectedWellTitle}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {batchProgress.running ? (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      batchCancelRef.current = true;
                    }}
                  >
                    Stop ({batchProgress.done}/{batchProgress.total})
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn sm pri"
                    onClick={runPlateBatch}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Play size={12} />
                    <span>Analyze Plate {activePlate + 1}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="btn sm"
                  onClick={handleExportAnalyzedPlateCsv}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  title="Download predicted LC-MS target list (.csv) for all analyzed wells on this plate"
                >
                  <Download size={12} />
                  <span>Plate LC-MS CSV</span>
                </button>

                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setShowSolventAdvisor(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    borderColor: 'color-mix(in srgb, #10b981 45%, var(--line))',
                    color: '#10b981',
                    fontWeight: 600,
                  }}
                  title="Evaluate all 54 wells (especially High & Medium ranked products) and suggest a finite set of TLC solvent systems"
                >
                  <span>✦ 54-Well TLC Solvents</span>
                </button>
              </div>
            </div>

            {/* Compact 6x9 Well Selector Grid */}
            <div className="pred-plate-grid">
              <div className="pred-plate-corner" />
              {Array.from({ length: 9 }, (_, c) => (
                <div key={c} className="pred-col-hdr mono">
                  {c + 1}
                </div>
              ))}
              {ROW_LETTERS.map((letter, r) => (
                <React.Fragment key={letter}>
                  <div className="pred-row-hdr mono">{letter}</div>
                  {Array.from({ length: 9 }, (_, c) => {
                    const wIdx = r * 9 + c;
                    const key = `${activePlate}-${wIdx}`;
                    const rowData = rowByPlateWell.get(key) ?? run.rows[activePlate * PLATE_SIZE + wIdx];
                    const gIdx = rowData?.global_index ?? activePlate * PLATE_SIZE + wIdx;
                    const isBlank =
                      !rowData ||
                      (state.mode === 'triplet' && triMeta[gIdx]?.blank) ||
                      rowData.recipe.every((rc: any) => rc.target_concentration <= 0);
                    const isSel = selectedWellIdx === wIdx;
                    const pred = plateResults[key];
                    const topScore = pred?.species?.[0]?.score;
                    const badge =
                      isBlank
                        ? 'BLK'
                        : pred
                        ? topScore != null
                          ? topScore.toFixed(2)
                          : '0.00'
                        : '';
                    const tone =
                      isBlank
                        ? 'blank'
                        : pred
                        ? pred.stats.highCount > 0
                          ? 'high'
                          : pred.stats.mediumCount > 0
                          ? 'med'
                          : 'low'
                        : 'idle';

                    return (
                      <button
                        key={c}
                        type="button"
                        className={`pred-well ${tone} ${isSel ? 'sel' : ''}`}
                        disabled={isBlank}
                        onClick={() => setSelectedWellIdx(wIdx)}
                        title={
                          isBlank
                            ? `Well ${letter}${c + 1}: Blank`
                            : `Well ${letter}${c + 1}${pred ? ` · Top score ${topScore?.toFixed(2) || '0'} · ${pred.species.length} species` : ''}`
                        }
                      >
                        <span className="mono" style={{ fontSize: '10px', fontWeight: 600 }}>
                          {letter}
                          {c + 1}
                        </span>
                        {badge && (
                          <span className="mono" style={{ fontSize: '9.5px', opacity: 0.85 }}>
                            {badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>

            {/* Condition What-If Bar */}
            <div
              style={{
                marginTop: '14px',
                paddingTop: '12px',
                borderTop: '1px solid var(--line2)',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                flexWrap: 'wrap',
                fontSize: '12.5px',
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }} title="Synced with Setup & ELN reaction conditions">
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Solvent</span>
                <span className="mono" style={{ fontWeight: 600, color: 'var(--fg2)' }}>
                  {canonicalCond.solvent}
                </span>
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Temp (°C)</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '72px', height: '30px', fontSize: '12px' }}
                  value={plateTempC}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '' || val === '-') return;
                    const num = Number(val);
                    if (!Number.isFinite(num)) return;
                    setState((prev) => applyRunConditionsPatch(prev, { temperatureC: num }));
                    setPlateResults({});
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Base Water (%)</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  className="f mono"
                  style={{ width: '66px', height: '30px', fontSize: '12px' }}
                  value={plateWaterPct}
                  onChange={(e) => {
                    const num = Math.max(0, Number(e.target.value) || 0);
                    setState((prev) => applyRunConditionsPatch(prev, { baseWaterPct: num }));
                    setPlateResults({});
                  }}
                />
                <select
                  className="f"
                  aria-label="Base water preset"
                  style={{ height: '30px', fontSize: '12px', padding: '0 6px' }}
                  value={[0.2, 2, 10].some((x) => Math.abs(plateWaterPct - x) < 0.01) ? String(plateWaterPct === 2 ? 2 : plateWaterPct) : 'custom'}
                  onChange={(e) => {
                    if (e.target.value === 'custom') return;
                    setState((prev) => applyRunConditionsPatch(prev, { baseWaterPct: Number(e.target.value) }));
                    setPlateResults({});
                  }}
                >
                  <option value="0.2">Dry (0.2%)</option>
                  <option value="2">Ambient (2%)</option>
                  <option value="10">Wet (10%)</option>
                  {![0.2, 2, 10].some((x) => Math.abs(plateWaterPct - x) < 0.01) && (
                    <option value="custom">Custom ({plateWaterPct.toFixed(1)}%)</option>
                  )}
                </select>
                {(currentExtraction?.condition.hydrateWaterPct || 0) > 0 && (
                  <span
                    className="mono"
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--acc)',
                      background: 'color-mix(in srgb, var(--acc) 10%, var(--soft))',
                      padding: '2px 7px',
                      borderRadius: '5px',
                      border: '1px solid color-mix(in srgb, var(--acc) 30%, var(--line))',
                    }}
                    title={(currentExtraction?.condition.hydrateSources || []).join(', ')}
                  >
                    +{(currentExtraction?.condition.hydrateWaterPct || 0).toFixed(2)}% hydrate ={' '}
                    {currentExtraction?.condition.waterPct.toFixed(2)}% H₂O
                  </span>
                )}
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Condition</span>
                <select
                  className="f"
                  style={{ height: '30px', fontSize: '12px', padding: '0 8px' }}
                  value={mediumOverride}
                  onChange={(e) => {
                    setMediumOverride(e.target.value as any);
                    setPlateResults({});
                  }}
                >
                  <option value="auto">Auto from well recipe</option>
                  <option value="acid">Force 0.5 eq TsOH</option>
                  <option value="base">Force 0.5 eq DBU</option>
                  <option value="neutral">Force Neutral</option>
                </select>
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--fg2)' }}>
                <input
                  type="checkbox"
                  checked={includeSpeculative}
                  onChange={(e) => {
                    setIncludeSpeculative(e.target.checked);
                    setPlateResults({});
                  }}
                />
                <span>Include speculative candidates</span>
              </label>

              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: 'auto', height: '28px', padding: '0 10px', fontSize: '12px' }}
                onClick={() =>
                  addWellToCompare({ plateIndex: activePlate, wellIndex: selectedWellIdx })
                }
                title="Queue this well into Compare Studio"
              >
                + Compare Well {activeCoord}
              </button>
            </div>
          </div>

          {/* Missing SMILES Inline Quick-Entry (when reagents in well have no SMILES yet) */}
          {currentExtraction && currentExtraction.missingSmilesCodes.length > 0 && (
            <MissingSmilesInlineEditor
              codes={currentExtraction.missingSmilesCodes}
              reagents={state.reagents}
              resolvingCode={resolvingCode}
              onLookup={handleLookupReagentSmiles}
              onSave={handleSaveReagentSmiles}
            />
          )}

          {/* Well Prediction Result Panel */}
          {activeWellResult ? (
            <WellResultsDisplay
              result={activeWellResult}
              title={`Well ${activeCoord} · ${selectedWellTitle}`}
              onExportCsv={() =>
                handleExportCurrentWellCsv(activeWellResult, `P${activePlate + 1}_${activeCoord}`, selectedWellTitle)
              }
              toast={toast}
            />
          ) : (
            <div className="card" style={{ padding: '28px', textAlign: 'center', color: 'var(--mut)' }}>
              {currentExtraction?.inactiveAdditiveOnly
                ? 'This well only contains solvent or buffer/additive. Select a well containing substrates.'
                : 'Add chemical structures (SMILES) to the reagents in this well above to predict its products.'}
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODE 2: ANY-COMPONENT SANDBOX (1..N SUBSTRATES)                       */}
      {/* ===================================================================== */}
      {!rdkitLoading && mode === 'sandbox' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Sandbox Builder Card */}
          <div className="card" style={{ padding: '18px 20px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
                marginBottom: '12px',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
                  Mixture Builder ({sandboxSubs.length} {sandboxSubs.length === 1 ? 'Component' : 'Components'})
                </h3>
                <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
                  Include salts in SMILES (e.g. <span className="mono">.Cl</span> or <span className="mono">.O=C(O)C(F)(F)F</span>) to model exact proton balance.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <select
                  className="f"
                  style={{ height: '32px', fontSize: '12px', maxWidth: '280px' }}
                  defaultValue=""
                  onChange={(e) => {
                    const p = SANDBOX_PRESETS.find((x) => x.id === e.target.value);
                    if (!p) return;
                    setSandboxSubs(JSON.parse(JSON.stringify(p.substrates)));
                    setSandboxCond(JSON.parse(JSON.stringify(p.condition)));
                    e.target.value = '';
                  }}
                >
                  <option value="" disabled>
                    Load worked example…
                  </option>
                  {SANDBOX_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    const nextCode = String.fromCharCode(65 + (sandboxSubs.length % 26));
                    setSandboxSubs((prev) => [
                      ...prev,
                      {
                        id: `${nextCode}_${Date.now()}`,
                        code: nextCode,
                        name: '',
                        smiles: '',
                        equivalents: 1.0,
                      },
                    ]);
                  }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <Plus size={13} />
                  <span>Add Component</span>
                </button>

                <button
                  type="button"
                  className="btn sm pri"
                  onClick={runSandboxNow}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <Sparkles size={13} />
                  <span>Run Prediction</span>
                </button>
              </div>
            </div>

            {/* Component Rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {sandboxSubs.map((sub, idx) => (
                <div
                  key={sub.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '144px 62px minmax(120px, 0.9fr) minmax(180px, 1.8fr) 74px 36px',
                    gap: '10px',
                    alignItems: 'center',
                    padding: '8px 10px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line2)',
                    borderRadius: '10px',
                  }}
                >
                  <ChemicalStructure
                    smiles={sub.smiles}
                    name={sub.name}
                    width={136}
                    height={92}
                    onResolvedSmiles={(smi) => {
                      setSandboxSubs((prev) => prev.map((x, j) => (j === idx ? { ...x, smiles: smi } : x)));
                    }}
                  />
                  <input
                    type="text"
                    className="f mono"
                    value={sub.code}
                    placeholder="Code"
                    style={{ height: '32px', fontSize: '12px', textAlign: 'center', fontWeight: 600 }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSandboxSubs((prev) => prev.map((x, j) => (j === idx ? { ...x, code: val } : x)));
                    }}
                  />
                  <input
                    type="text"
                    className="f"
                    value={sub.name}
                    placeholder="Compound name (optional)"
                    style={{ height: '32px', fontSize: '12.5px' }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSandboxSubs((prev) => prev.map((x, j) => (j === idx ? { ...x, name: val } : x)));
                    }}
                  />
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="f mono"
                      value={sub.smiles}
                      placeholder="SMILES (e.g. O=Cc1ccccc1)"
                      style={{ height: '32px', fontSize: '12px', flex: 1 }}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSandboxSubs((prev) => prev.map((x, j) => (j === idx ? { ...x, smiles: val } : x)));
                      }}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      title="Look up SMILES from compound name"
                      disabled={resolvingCode === sub.id}
                      style={{ height: '32px', padding: '0 8px' }}
                      onClick={async () => {
                        const q = sub.name.trim();
                        if (!q) {
                          toast('Enter a chemical name first.');
                          return;
                        }
                        setResolvingCode(sub.id);
                        try {
                          const r = await resolveChemicalNameToSmiles(q);
                          if (r?.smiles) {
                            setSandboxSubs((prev) =>
                              prev.map((x, j) => (j === idx ? { ...x, smiles: r.smiles } : x))
                            );
                          } else {
                            toast(`Could not resolve "${q}".`);
                          }
                        } finally {
                          setResolvingCode(null);
                        }
                      }}
                    >
                      <Search size={12} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      className="f mono"
                      value={sub.equivalents}
                      style={{ height: '32px', fontSize: '12px', width: '54px' }}
                      onChange={(e) => {
                        const val = Math.max(0.05, Number(e.target.value) || 1);
                        setSandboxSubs((prev) =>
                          prev.map((x, j) => (j === idx ? { ...x, equivalents: val } : x))
                        );
                      }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--mut)' }}>eq</span>
                  </div>
                  <button
                    type="button"
                    className="ib"
                    disabled={sandboxSubs.length <= 1}
                    title="Remove component"
                    onClick={() => setSandboxSubs((prev) => prev.filter((_, j) => j !== idx))}
                    style={{ width: '30px', height: '30px', opacity: sandboxSubs.length <= 1 ? 0.35 : 1 }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            {/* Condition Controls */}
            <div
              style={{
                marginTop: '12px',
                paddingTop: '12px',
                borderTop: '1px solid var(--line2)',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                flexWrap: 'wrap',
                fontSize: '12.5px',
              }}
            >
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Additive / Medium</span>
                <select
                  className="f"
                  style={{ height: '30px', fontSize: '12px', padding: '0 8px' }}
                  value={sandboxCond.medium === 'neutral' ? 'neutral' : `${sandboxCond.medium}:${sandboxCond.additiveName}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    const presets: Record<string, { medium: MediumMode; additiveName: string; additivePka: number; additiveEquiv: number }> = {
                      neutral: { medium: 'neutral', additiveName: 'None (Neutral)', additivePka: 7.0, additiveEquiv: 0 },
                      'acid:TsOH': { medium: 'acid', additiveName: 'TsOH', additivePka: 0.9, additiveEquiv: sandboxCond.additiveEquiv || 0.5 },
                      'acid:TFA': { medium: 'acid', additiveName: 'TFA', additivePka: 3.45, additiveEquiv: sandboxCond.additiveEquiv || 1.0 },
                      'acid:HCl': { medium: 'acid', additiveName: 'HCl', additivePka: 1.8, additiveEquiv: sandboxCond.additiveEquiv || 1.0 },
                      'acid:AcOH': { medium: 'acid', additiveName: 'AcOH', additivePka: 12.6, additiveEquiv: sandboxCond.additiveEquiv || 1.0 },
                      'base:DBU': { medium: 'base', additiveName: 'DBU', additivePka: 13.9, additiveEquiv: sandboxCond.additiveEquiv || 0.5 },
                      'base:TEA': { medium: 'base', additiveName: 'TEA', additivePka: 9.0, additiveEquiv: sandboxCond.additiveEquiv || 1.0 },
                    };
                    const picked = presets[v] || presets.neutral;
                    setSandboxCond((c) => ({ ...c, ...picked }));
                  }}
                >
                  <option value="neutral">None (Neutral)</option>
                  <option value="acid:TsOH">TsOH (pKa 0.9 DMSO)</option>
                  <option value="acid:HCl">HCl (pKa 1.8 DMSO)</option>
                  <option value="acid:TFA">TFA (pKa 3.45 DMSO)</option>
                  <option value="acid:AcOH">AcOH (pKa 12.6 DMSO)</option>
                  <option value="base:DBU">DBU (pKaH 13.9 DMSO)</option>
                  <option value="base:TEA">TEA / DIPEA (pKaH 9.0 DMSO)</option>
                </select>
              </label>

              {sandboxCond.medium !== 'neutral' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Additive eq</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    className="f mono"
                    style={{ width: '64px', height: '30px', fontSize: '12px' }}
                    value={sandboxCond.additiveEquiv}
                    onChange={(e) =>
                      setSandboxCond((c) => ({ ...c, additiveEquiv: Math.max(0, Number(e.target.value) || 0) }))
                    }
                  />
                </label>
              )}

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Temp (°C)</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '68px', height: '30px', fontSize: '12px' }}
                  value={sandboxCond.temperatureC}
                  onChange={(e) => setSandboxCond((c) => ({ ...c, temperatureC: Number(e.target.value) || 25 }))}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Base Water %</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  className="f mono"
                  style={{ width: '62px', height: '30px', fontSize: '12px' }}
                  value={sandboxCond.waterPct}
                  onChange={(e) => setSandboxCond((c) => ({ ...c, waterPct: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>

              <button
                type="button"
                className="btn sm"
                style={{ height: '28px', padding: '0 9px', fontSize: '11.5px' }}
                onClick={() => {
                  setSandboxCond((c) => ({
                    ...c,
                    solvent: canonicalCond.solvent,
                    temperatureC: canonicalCond.temperatureC,
                    waterPct: canonicalCond.baseWaterPct,
                  }));
                  toast(`Applied Setup conditions (${canonicalCond.solvent}, ${canonicalCond.temperatureC} °C, ${canonicalCond.baseWaterPct}% H₂O).`);
                }}
                title="Copy solvent, temperature, and base water % from Run Setup"
              >
                Use Setup ({canonicalCond.temperatureC} °C · {canonicalCond.solvent})
              </button>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--fg2)' }}>
                <input
                  type="checkbox"
                  checked={includeSpeculative}
                  onChange={(e) => setIncludeSpeculative(e.target.checked)}
                />
                <span>Include speculative</span>
              </label>
            </div>
          </div>

          {sandboxResult ? (
            <WellResultsDisplay
              result={sandboxResult}
              title={`Custom Mixture (${sandboxResult.substrates.filter((s) => s.valid).map((s) => s.code).join(' + ')})`}
              onExportCsv={() => handleExportCurrentWellCsv(sandboxResult, 'Sandbox', sandboxResult.substrates.map((s) => s.code).join('+'))}
              toast={toast}
            />
          ) : (
            <div className="card" style={{ padding: '24px', textAlign: 'center', color: 'var(--mut)' }}>
              Enter valid SMILES strings above to predict reaction products.
            </div>
          )}
        </div>
      )}

      <AiSolventAdvisorModal
        isOpen={showSolventAdvisor}
        onClose={() => setShowSolventAdvisor(false)}
        initialSubstrates={(state.reagents || [])
          .filter((r) => r.name && r.name.trim() !== '')
          .map((r) => ({
            code: r.code,
            name: r.name,
            smiles: r.smiles,
            role: r.code,
          }))}
        reactionClass={state.name || 'HTE Reaction Screen'}
        cachedPlatePredictions={plateResults}
        initialPlateIndex={activePlate}
        conditionOverrides={conditionOverrides}
        toast={toast}
      />
    </div>
  );
};

// =============================================================================
// SUBCOMPONENT: Missing SMILES Inline Resolver
// =============================================================================
interface MissingSmilesProps {
  codes: string[];
  reagents: any[];
  resolvingCode: string | null;
  onLookup: (code: string, name: string) => void;
  onSave: (code: string, smi: string) => void;
}

const MissingSmilesInlineEditor: React.FC<MissingSmilesProps> = ({
  codes,
  reagents,
  resolvingCode,
  onLookup,
  onSave,
}) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <div className="card" style={{ padding: '14px 18px', borderColor: 'color-mix(in srgb, var(--warn) 45%, var(--line))' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--warn)', marginBottom: '8px' }}>
        Missing chemical structures (SMILES) for substrates in this well
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {codes.map((code) => {
          const r = reagents.find((x) => x.code === code);
          const val = drafts[code] ?? r?.smiles ?? '';
          return (
            <div
              key={code}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
            >
              <span className="mono" style={{ fontWeight: 700, minWidth: '32px' }}>
                {code}
              </span>
              <span style={{ fontSize: '12.5px', color: 'var(--fg2)', minWidth: '140px' }}>
                {r?.name || code}
              </span>
              <input
                type="text"
                className="f mono"
                style={{ flex: '1 1 220px', height: '30px', fontSize: '12px' }}
                placeholder="Paste SMILES (salts OK, e.g. .Cl)"
                value={val}
                onChange={(e) => setDrafts((d) => ({ ...d, [code]: e.target.value }))}
              />
              <button
                type="button"
                className="btn sm"
                disabled={resolvingCode === code}
                onClick={() => onLookup(code, r?.name || '')}
              >
                {resolvingCode === code ? 'Looking up…' : 'Lookup by Name'}
              </button>
              <button
                type="button"
                className="btn sm pri"
                disabled={!val.trim()}
                onClick={() => onSave(code, val)}
              >
                Save to Setup
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// =============================================================================
// SUBCOMPONENT: Well Prediction Results (Equilibrium, Alerts, Cards, Fragments)
// =============================================================================
interface WellResultsDisplayProps {
  result: WellPredictionResult;
  title: string;
  onExportCsv: () => void;
  toast: (msg: string) => void;
}

const WellResultsDisplay: React.FC<WellResultsDisplayProps> = ({
  result,
  title,
  onExportCsv,
  toast,
}) => {
  const [activeTab, setActiveTab] = useState<'products' | 'fragments'>('products');
  const [groupMode, setGroupMode] = useState<'pathway' | 'score'>('pathway');
  const [viewLayout, setViewLayout] = useState<'flow' | 'table' | 'cards'>('flow');
  const [tierFilter, setTierFilter] = useState<'all' | 'major' | 'equil'>('all');
  const [massQuery, setMassQuery] = useState<string>('');
  const [showEquilibriumDetails, setShowEquilibriumDetails] = useState<boolean>(false);
  const [expandedTrails, setExpandedTrails] = useState<Record<string, boolean>>({});
  const [expandedMinorFamilies, setExpandedMinorFamilies] = useState<Record<string, boolean>>({});
  const [expandedSideRoutes, setExpandedSideRoutes] = useState<Record<string, boolean>>({});
  const [familyOpenOverrides, setFamilyOpenOverrides] = useState<Record<string, boolean>>({});
  const [inspectedByFamily, setInspectedByFamily] = useState<Record<string, string | null>>({});
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);
  const [highlightBondsMode, setHighlightBondsMode] = useState<'all' | 'last' | 'off'>('all');
  const [pulsedTileKey, setPulsedTileKey] = useState<string | null>(null);
  const [rdkitInst, setRdkitInst] = useState<any>(null);
  const tileRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const pulseTimerRef = useRef<number | null>(null);
  const { acidBase, species, releasedFragments, alerts, substrates, stats, condition } = result;

  useEffect(() => {
    let alive = true;
    getRDKitInstance().then((inst) => {
      if (alive && inst) setRdkitInst(inst);
    });
    return () => {
      alive = false;
      if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    };
  }, []);

  const highlightBySpeciesKey = useMemo(() => {
    const map = new Map<string, SpeciesBondHighlights>();
    if (!rdkitInst || highlightBondsMode === 'off') return map;
    for (const sp of species) {
      map.set(sp.key, computeSpeciesHighlightBonds(rdkitInst, sp));
    }
    return map;
  }, [rdkitInst, species, highlightBondsMode]);

  const getHighlightsFor = (sp: PredictedSpecies): number[] | undefined => {
    if (highlightBondsMode === 'off') return undefined;
    const h = highlightBySpeciesKey.get(sp.key);
    if (!h) return undefined;
    const arr = highlightBondsMode === 'last' ? h.lastStepBonds : h.allNewBonds;
    return arr.length > 0 ? arr : undefined;
  };

  const jumpToBranchParent = (famId: string, branchKey: string | null) => {
    if (!branchKey) return;
    setExpandedSideRoutes((prev) => ({ ...prev, [famId]: true }));
    setExpandedMinorFamilies((prev) => ({ ...prev, [famId]: true }));
    setInspectedByFamily((prev) => ({ ...prev, [famId]: branchKey }));
    const refKey = `${famId}::${branchKey}`;
    setPulsedTileKey(refKey);
    if (pulseTimerRef.current) window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => {
      setPulsedTileKey((cur) => (cur === refKey ? null : cur));
    }, 1800);
    window.setTimeout(() => {
      const el = tileRefs.current.get(refKey);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 55);
  };

  const filteredSpecies = useMemo(() => {
    let list = species;
    if (tierFilter === 'major') {
      list = list.filter((sp) => sp.tier === 'High' || sp.tier === 'Medium');
    } else if (tierFilter === 'equil') {
      list = list.filter((sp) => sp.status === 'transient');
    }
    const q = massQuery.trim().toLowerCase();
    if (q) {
      const numericMz = /^\d+(\.\d+)?$/.test(q) ? parseFloat(q) : NaN;
      list = list.filter((sp) => {
        if (
          sp.formula.toLowerCase().includes(q) ||
          sp.mechanismSummary.toLowerCase().includes(q) ||
          sp.smiles.toLowerCase().includes(q) ||
          sp.mhPlus.toFixed(4).includes(q) ||
          sp.mNaPlus.toFixed(3).includes(q) ||
          sp.bestChain.some((st) => st.description.toLowerCase().includes(q)) ||
          (sp.lossIons ?? []).some(
            (l) => l.label.toLowerCase().includes(q) || l.mz.toFixed(4).includes(q)
          )
        ) {
          return true;
        }
        if (Number.isFinite(numericMz) && numericMz >= 20) {
          const masses = [
            sp.mhPlus,
            sp.mNaPlus,
            sp.mHMinus,
            sp.exactMass,
            ...(sp.lossIons ?? []).map((l) => l.mz),
          ];
          return masses.some((m) => Math.abs(m - numericMz) <= 0.6);
        }
        return false;
      });
    }
    return list;
  }, [species, tierFilter, massQuery]);

  const rankLookup = useMemo(() => {
    const map = new Map<string, number>();
    species.forEach((sp, idx) => map.set(sp.key, idx + 1));
    return map;
  }, [species]);

  const families: PathwayFamily[] = useMemo(() => {
    const allFams = groupSpeciesByPathway(species, substrates);
    if (filteredSpecies.length === species.length) return allFams;
    const allowed = new Set(filteredSpecies.map((s) => s.key));
    return allFams
      .map((f) => {
        const primaryNodes = f.primaryNodes.filter((n) => allowed.has(n.species.key));
        const minorNodes = f.minorNodes.filter((n) => allowed.has(n.species.key));
        const nodes = f.nodes.filter((n) => allowed.has(n.species.key));
        const primaryRoutes = f.primaryRoutes
          .map((r) => ({ ...r, nodes: r.nodes.filter((n) => allowed.has(n.species.key)) }))
          .filter((r) => r.nodes.length > 0);
        return { ...f, nodes, primaryNodes, minorNodes, primaryRoutes };
      })
      .filter((f) => f.nodes.length > 0);
  }, [species, filteredSpecies, substrates]);

  // Default open state: expand up to top 3 High/Medium pathways (or top 1 if all are Low);
  // auto-expand all matching pathways when the user filters/searches.
  const isFamilyOpen = (fam: PathwayFamily, idx: number): boolean => {
    if (massQuery.trim() || tierFilter !== 'all') return true;
    if (fam.id in familyOpenOverrides) return familyOpenOverrides[fam.id];
    const hasMajor = fam.peakScore >= 0.28;
    return hasMajor ? idx < 3 : idx === 0;
  };

  const toggleFamilyOpen = (fam: PathwayFamily, idx: number) => {
    const cur = isFamilyOpen(fam, idx);
    setFamilyOpenOverrides((prev) => ({ ...prev, [fam.id]: !cur }));
  };

  const toggleTrail = (key: string) => {
    setExpandedTrails((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleMinorFamily = (familyId: string) => {
    setExpandedMinorFamilies((prev) => ({ ...prev, [familyId]: !prev[familyId] }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Visual Reaction Scheme Header: [Struct A] + [Struct B] + ... --(Conditions)--> */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
            flexWrap: 'wrap',
            marginBottom: '12px',
          }}
        >
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700 }}>{title}</div>
            <div className="mono" style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
              {stats.highCount} High · {stats.mediumCount} Medium · {stats.lowCount} Low
            </div>
          </div>

          <button
            type="button"
            className="btn sm"
            onClick={onExportCsv}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Download size={12} />
            <span>Export Well LC-MS CSV</span>
          </button>
        </div>

        {/* Visual Reaction Scheme */}
        <div className="pred-scheme" style={{ marginBottom: '12px' }}>
          {substrates.map((sub, idx) => (
            <React.Fragment key={sub.id}>
              {idx > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    fontSize: '20px',
                    fontWeight: 500,
                    color: 'var(--mut)',
                    padding: '0 2px',
                    userSelect: 'none',
                  }}
                >
                  +
                </span>
              )}
              <div className="pred-sub-tile">
                <ChemicalStructure smiles={sub.neutralSmiles} name={sub.name} width={190} height={130} />
                <div
                  style={{
                    width: '100%',
                    textAlign: 'center',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    lineHeight: 1.25,
                    wordBreak: 'break-word',
                  }}
                >
                  <span className="mono" style={{ color: 'var(--acc)' }}>{sub.code}</span> · {sub.name || sub.code}
                </div>
                <div className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                  {sub.equivalents.toFixed(2)} eq
                  {sub.concentrationMm != null ? ` · ${sub.concentrationMm.toFixed(1)} mM` : ''}
                  {sub.saltDetected ? ` · ${sub.saltDetected}` : ''}
                </div>
              </div>
            </React.Fragment>
          ))}

          {/* Reaction Arrow & Conditions */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '8px 14px',
              gap: '4px',
              minWidth: '150px',
            }}
          >
            <div className="mono" style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--fg2)', textAlign: 'center' }}>
              {condition.solvent} · {condition.temperatureC} °C
              {condition.reactionTimeHours ? ` · ${condition.reactionTimeHours} h` : ''}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 0, color: 'var(--acc)' }}>
              <div style={{ flex: 1, height: '2px', background: 'currentColor', borderRadius: '2px 0 0 2px', marginRight: '-1px' }} />
              <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>
                <polygon points="0,1 10,6 0,11" fill="currentColor" />
              </svg>
            </div>
            <div
              className="mono"
              style={{ fontSize: '11px', color: 'var(--mut)', textAlign: 'center' }}
              title={
                (condition.hydrateWaterPct || 0) > 0
                  ? `Base ${Number(condition.baseWaterPct ?? condition.waterPct).toFixed(2)}% + Hydrate +${Number(condition.hydrateWaterPct).toFixed(2)}% (${(condition.hydrateSources || []).join(', ')})`
                  : undefined
              }
            >
              {mediumLabel(acidBase.effectiveMedium)} · pH {acidBase.effectivePhDmso.toFixed(1)} ·{' '}
              {(condition.hydrateWaterPct || 0) > 0
                ? `${condition.waterPct.toFixed(2)}% H₂O (+${Number(condition.hydrateWaterPct).toFixed(2)}% hydrate)`
                : `${condition.waterPct.toFixed(1)}% H₂O`}
            </div>
          </div>
        </div>

        {/* Compact One-Line Equilibrium Strip + Optional Ionization Disclosure */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
            padding: '8px 12px',
            background: 'var(--bg)',
            border: '1px solid var(--line2)',
            borderRadius: '8px',
            fontSize: '12px',
          }}
        >
          <div className="mono" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', color: 'var(--fg2)' }}>
            <span>
              <strong style={{ color: 'var(--fg)' }}>{mediumLabel(acidBase.effectiveMedium)}</strong> · pH(DMSO) {acidBase.effectivePhDmso.toFixed(2)}
            </span>
            <span>
              H⁺/Base: +{acidBase.totalAddedAcidEq.toFixed(2)} / -{acidBase.totalAddedBaseEq.toFixed(2)}
            </span>
            <span>
              Free H⁺ {acidBase.freeAcidEq.toFixed(2)} eq · Free Base {acidBase.freeBaseEq.toFixed(2)} eq
            </span>
          </div>

          {(acidBase.notes.length > 0 || substrates.some((s) => s.sites.length > 0)) && (
            <button
              type="button"
              className="btn sm"
              style={{ height: '24px', fontSize: '11px', padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              onClick={() => setShowEquilibriumDetails((v) => !v)}
            >
              {showEquilibriumDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>Ionization sites</span>
            </button>
          )}
        </div>

        {showEquilibriumDetails && (
          <div style={{ marginTop: '8px', padding: '8px 12px', background: 'var(--soft)', borderRadius: '7px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {substrates.flatMap((s) =>
              s.sites.map((st) => ({
                code: s.code,
                label: st.label,
                pka: st.pka,
                pctFree: Math.round(st.freeFraction * 100),
                kind: st.kind,
              }))
            ).map((ss, idx) => (
              <div key={idx} style={{ color: 'var(--fg2)' }}>
                <span className="mono" style={{ fontWeight: 600 }}>{ss.code}</span> · {ss.label} (pKa {ss.pka.toFixed(1)}):{' '}
                <span className="mono">
                  {ss.kind === 'base' ? `${ss.pctFree}% free base` : `${ss.pctFree}% deprotonated`}
                </span>
              </div>
            ))}
            {acidBase.notes.map((note, idx) => (
              <div key={`n-${idx}`} style={{ color: 'var(--mut)' }}>
                {note}
              </div>
            ))}
          </div>
        )}

        {alerts.length > 0 && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {alerts.map((al, idx) => (
              <div
                key={idx}
                className={`issue ${al.severity === 'warn' ? 'warn' : 'ok'}`}
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                <span>{al.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Product Candidates & Released Fragments Tabs */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            marginBottom: '14px',
          }}
        >
          <div className="seg">
            <button
              type="button"
              className={activeTab === 'products' ? 'on' : ''}
              onClick={() => setActiveTab('products')}
            >
              Predicted Products ({species.length})
            </button>
            <button
              type="button"
              className={activeTab === 'fragments' ? 'on' : ''}
              onClick={() => setActiveTab('fragments')}
            >
              <Layers size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Released Fragments ({releasedFragments.length})
            </button>
          </div>

          {activeTab === 'products' && species.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {viewLayout !== 'table' && (
                <div className="seg" role="group" aria-label="Product grouping mode">
                  <button
                    type="button"
                    className={groupMode === 'pathway' ? 'on' : ''}
                    onClick={() => setGroupMode('pathway')}
                    title="Group products by shared mechanistic pathway, sorted by peak confidence score"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <GitBranch size={12} />
                    <span>By Pathway ({families.length})</span>
                  </button>
                  <button
                    type="button"
                    className={groupMode === 'score' ? 'on' : ''}
                    onClick={() => setGroupMode('score')}
                    title="Flat list ranked strictly by individual confidence score"
                  >
                    <span>By Confidence</span>
                  </button>
                </div>
              )}

              <div className="seg" role="group" aria-label="Product arrangement">
                <button
                  type="button"
                  className={viewLayout === 'flow' ? 'on' : ''}
                  onClick={() => {
                    setViewLayout('flow');
                    setGroupMode('pathway');
                  }}
                  title="Compact horizontal pathway strips with collapsible secondary pathways"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <GitBranch size={12} />
                  <span>Cascade</span>
                </button>
                <button
                  type="button"
                  className={viewLayout === 'table' ? 'on' : ''}
                  onClick={() => setViewLayout('table')}
                  title="Compact LC-MS peak table + side structure inspector (no scrolling)"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <List size={12} />
                  <span>LC-MS Table</span>
                </button>
                <button
                  type="button"
                  className={viewLayout === 'cards' ? 'on' : ''}
                  onClick={() => setViewLayout('cards')}
                  title="Full-size structure cards"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <LayoutGrid size={12} />
                  <span>Cards</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Smart Tier Filter & LC-MS m/z Search Strip */}
        {activeTab === 'products' && species.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              flexWrap: 'wrap',
              padding: '8px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--line2)',
              borderRadius: '8px',
              marginBottom: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className="seg" role="group" aria-label="Confidence filter">
                <button
                  type="button"
                  className={tierFilter === 'all' ? 'on' : ''}
                  onClick={() => setTierFilter('all')}
                >
                  All ({species.length})
                </button>
                <button
                  type="button"
                  className={tierFilter === 'major' ? 'on' : ''}
                  onClick={() => setTierFilter('major')}
                >
                  High + Med ({stats.highCount + stats.mediumCount})
                </button>
                <button
                  type="button"
                  className={tierFilter === 'equil' ? 'on' : ''}
                  onClick={() => setTierFilter('equil')}
                >
                  Equil. / Imine ({stats.transientCount})
                </button>
              </div>

              <div className="seg" role="group" aria-label="New bond highlighting" title="Highlight newly formed bonds on predicted structures">
                <button
                  type="button"
                  className={highlightBondsMode === 'all' ? 'on' : ''}
                  onClick={() => setHighlightBondsMode('all')}
                >
                  New Bonds: All
                </button>
                <button
                  type="button"
                  className={highlightBondsMode === 'last' ? 'on' : ''}
                  onClick={() => setHighlightBondsMode('last')}
                >
                  Last Step
                </button>
                <button
                  type="button"
                  className={highlightBondsMode === 'off' ? 'on' : ''}
                  onClick={() => setHighlightBondsMode('off')}
                >
                  Off
                </button>
              </div>

              {viewLayout !== 'table' && groupMode === 'pathway' && families.length > 1 && (
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                    onClick={() => {
                      const next: Record<string, boolean> = {};
                      families.forEach((f) => {
                        next[f.id] = true;
                      });
                      setFamilyOpenOverrides(next);
                    }}
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                    onClick={() => {
                      const next: Record<string, boolean> = {};
                      families.forEach((f) => {
                        next[f.id] = false;
                      });
                      setFamilyOpenOverrides(next);
                    }}
                  >
                    Collapse all
                  </button>
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: '7px',
                padding: '0 8px',
                height: '28px',
                minWidth: '230px',
                flex: '0 1 280px',
              }}
            >
              <Search size={12} style={{ color: 'var(--mut)', flexShrink: 0 }} />
              <input
                type="text"
                value={massQuery}
                onChange={(e) => setMassQuery(e.target.value)}
                placeholder="Find m/z (e.g. 246.1), formula, step..."
                style={{
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--fg)',
                  fontSize: '12px',
                  width: '100%',
                }}
              />
              {massQuery && (
                <button
                  type="button"
                  onClick={() => setMassQuery('')}
                  aria-label="Clear filter"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--mut)',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'inline-flex',
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab === 'products' ? (
          filteredSpecies.length > 0 ? (
            (() => {
              const stoichOf = (sp: PredictedSpecies) =>
                substrates
                  .map((s, sIdx) =>
                    sp.inventory[sIdx] > 0 ? `${sp.inventory[sIdx] > 1 ? sp.inventory[sIdx] : ''}${s.code}` : null
                  )
                  .filter(Boolean)
                  .join(' + ');

              const formatLineageText = (node?: PathwaySpeciesNode): string | null => {
                if (!node) return null;
                if (node.isPureTautomer) return 'Pre-tautomer · feeds pathway';
                if (node.parentGlobalRank != null) {
                  const verb = node.roleInPathway === 'divergence' ? 'Diverges from' : 'Extends';
                  const prefix = node.isLead ? 'Lead · ' : '';
                  return `${prefix}↳ ${verb} #${node.parentGlobalRank} via ${node.lastStepLabel}`;
                }
                if (node.isLead) return `Lead · Step 1 (${node.lastStepLabel})`;
                return `Step 1 entry (${node.lastStepLabel})`;
              };

              const renderFullInspector = (sp: PredictedSpecies, rankNum: number, node?: PathwaySpeciesNode) => {
                const tc = tierColor(sp.tier);
                const stoichLabel = stoichOf(sp);
                const lineageText = formatLineageText(node);
                return (
                  <div
                    style={{
                      border: '1px solid color-mix(in srgb, var(--acc) 35%, var(--line))',
                      borderRadius: '10px',
                      padding: '12px 14px',
                      background: 'var(--panel)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontWeight: 700, fontSize: '13.5px' }}>
                          #{rankNum}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '6px',
                            color: tc.fg,
                            background: tc.bg,
                            border: `1px solid ${tc.bd}`,
                          }}
                        >
                          {sp.score.toFixed(2)} · {sp.tier}
                        </span>
                        <span className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                          {sp.status === 'sink' ? 'Stable' : 'Equil.'} · L {sp.likelihood.toFixed(2)} · P{' '}
                          {sp.persistence.toFixed(2)}
                          {sp.reversibleEnd ? ' · reversible' : ''}
                          {sp.tautomerForms > 1 ? ` · ${sp.tautomerForms} tautomer forms` : ''}
                        </span>
                        {stoichLabel && (
                          <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg2)' }}>
                            · {stoichLabel}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                          onClick={() => {
                            navigator.clipboard.writeText(sp.smiles);
                            toast('Copied product SMILES.');
                          }}
                        >
                          <Copy size={11} />
                          <span style={{ marginLeft: '4px' }}>SMILES</span>
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                          onClick={() => {
                            navigator.clipboard.writeText(sp.mhPlus.toFixed(4));
                            toast(`Copied [M+H]+ = ${sp.mhPlus.toFixed(4)}`);
                          }}
                        >
                          Copy [M+H]⁺
                        </button>
                      </div>
                    </div>

                    {lineageText && (
                      <div
                        className="mono"
                        style={{
                          fontSize: '11.5px',
                          fontWeight: node?.isLead ? 700 : 500,
                          color: node?.isLead ? 'var(--acc)' : 'var(--fg2)',
                          marginTop: '-4px',
                        }}
                      >
                        {lineageText}
                      </div>
                    )}

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))',
                        gap: '8px',
                        padding: '8px 10px',
                        borderRadius: '7px',
                        background: 'var(--soft)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>[M+H]⁺</div>
                        <div className="mono" style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--acc)' }}>
                          {sp.mhPlus.toFixed(4)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>[M+Na]⁺</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.mNaPlus.toFixed(4)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>[M−H]⁻</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.mHMinus.toFixed(4)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>Formula</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.formula}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>cLogP · TPSA</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.clogP.toFixed(1)} · {sp.tpsa.toFixed(0)} Å²
                        </div>
                      </div>
                    </div>

                    {sp.lossIons && sp.lossIons.length > 0 && (
                      <div className="mono" style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                        In-source LC-MS:{' '}
                        {sp.lossIons.map((l) => `${l.label} ${l.mz.toFixed(4)} (${l.note})`).join(' · ')}
                      </div>
                    )}

                    {node && node.alsoViaLabels.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                        Convergent: also reached via {node.alsoViaLabels.join(', ')}
                      </div>
                    )}

                    {sp.alerts.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)' }}>
                        {sp.alerts.map((a) => a.message).join(' · ')}
                      </div>
                    )}

                    <div
                      style={{
                        padding: '8px 10px',
                        background: 'var(--bg)',
                        borderRadius: '6px',
                        border: '1px solid var(--line2)',
                        fontSize: '11.5px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      }}
                    >
                      <div className="mono" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg2)' }}>
                        {sp.mechanismSummary} · {sp.stepsCount} step{sp.stepsCount === 1 ? '' : 's'}
                      </div>
                      {sp.bestChain.map((st, sIdx) => (
                        <div key={sIdx} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <span>
                            <b className="mono">{sIdx + 1}. {st.stepLabel}</b> — {st.description}
                            {st.releasedFragment ? ` (${st.releasedFragment})` : ''}
                            {st.releasedGas ? ` (${st.releasedGas})` : ''}
                          </span>
                          <span className="mono" style={{ color: 'var(--mut)' }}>
                            w={st.stepWeight.toFixed(2)} · pH×{st.conditionFactor.toFixed(2)} · T×{st.tempFactor.toFixed(2)}
                            {st.ringFactor > 1.05 ? ` · ring×${st.ringFactor.toFixed(2)}` : ''}
                          </span>
                        </div>
                      ))}
                      {sp.alternativeChains.length > 0 && (
                        <div style={{ color: 'var(--mut)', paddingTop: '4px', borderTop: '1px dashed var(--line)' }}>
                          Alt:{' '}
                          {sp.alternativeChains.map((ac) => ac.map((x) => x.stepLabel).join(' → ')).join(' | ')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              };

              // Roomy 288px horizontal tile with crisp 264x172 SVG structure for Cascade mode
              const renderCascadeTile = (
                sp: PredictedSpecies,
                rankNum: number,
                familyId: string,
                node?: PathwaySpeciesNode
              ) => {
                const tc = tierColor(sp.tier);
                const stoichLabel = stoichOf(sp);
                const isSelected = inspectedByFamily[familyId] === sp.key;
                const refKey = `${familyId}::${sp.key}`;
                const isPulsed = pulsedTileKey === refKey;
                const shortRole = node
                  ? node.isPureTautomer
                    ? 'Pre-taut'
                    : node.parentGlobalRank != null
                    ? `${node.roleInPathway === 'divergence' ? '⑂' : '↳'} #${node.parentGlobalRank} · ${node.lastStepLabel}`
                    : `Step 1 · ${node.lastStepLabel}`
                  : sp.mechanismSummary;

                return (
                  <div
                    key={sp.key}
                    ref={(el) => {
                      if (el) tileRefs.current.set(refKey, el);
                      else tileRefs.current.delete(refKey);
                    }}
                    onClick={() =>
                      setInspectedByFamily((prev) => ({
                        ...prev,
                        [familyId]: prev[familyId] === sp.key ? null : sp.key,
                      }))
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setInspectedByFamily((prev) => ({
                          ...prev,
                          [familyId]: prev[familyId] === sp.key ? null : sp.key,
                        }));
                      }
                    }}
                    title="Click tile to inspect LC-MS ions & mechanism steps (click structure to zoom)"
                    style={{
                      flex: '0 0 288px',
                      border: isPulsed
                        ? '2px solid var(--acc)'
                        : isSelected
                        ? '1.5px solid var(--acc)'
                        : node?.isLead
                        ? '1px solid color-mix(in srgb, var(--acc) 45%, var(--line))'
                        : '1px solid var(--line)',
                      boxShadow: isPulsed
                        ? '0 0 0 4px color-mix(in srgb, var(--acc) 22%, transparent)'
                        : undefined,
                      borderRadius: '10px',
                      padding: '10px 11px',
                      background: isPulsed || isSelected
                        ? 'color-mix(in srgb, var(--acc) 7%, var(--panel))'
                        : 'var(--panel)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '7px',
                      transition: 'border-color 0.18s ease, box-shadow 0.25s ease',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                      <span className="mono" style={{ fontWeight: 700, fontSize: '12.5px' }}>
                        #{rankNum}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '1px 7px',
                          borderRadius: '5px',
                          color: tc.fg,
                          background: tc.bg,
                          border: `1px solid ${tc.bd}`,
                        }}
                      >
                        {sp.score.toFixed(2)} · {sp.tier}
                      </span>
                      {stoichLabel && (
                        <span className="mono" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg2)' }}>
                          {stoichLabel}
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--soft)',
                        borderRadius: '8px',
                        padding: '4px',
                        height: '182px',
                      }}
                    >
                      <ChemicalStructure
                        smiles={sp.smiles}
                        name={`${stoichLabel || 'Product'} (${sp.formula})`}
                        width={264}
                        height={172}
                        highlightBonds={getHighlightsFor(sp)}
                      />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px' }}>
                      <span
                        className="mono"
                        style={{ fontSize: '12px', fontWeight: 700, color: 'var(--acc)' }}
                      >
                        [M+H]⁺ {sp.mhPlus.toFixed(4)}
                      </span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--fg2)' }}>
                        {sp.formula}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: '10.5px',
                          color: node?.isLead ? 'var(--acc)' : 'var(--mut)',
                          fontWeight: node?.isLead ? 700 : 500,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {node?.isLead ? `★ Lead · ${shortRole}` : shortRole}
                      </span>
                      <span className="mono" style={{ fontSize: '10px', color: 'var(--mut)', flexShrink: 0 }}>
                        {sp.status === 'transient' ? 'Equil.' : 'Stable'}
                      </span>
                    </div>
                  </div>
                );
              };

              const renderGridCard = (
                sp: PredictedSpecies,
                rankNum: number,
                node?: PathwaySpeciesNode,
                familyId?: string
              ) => {
                const tc = tierColor(sp.tier);
                const isOpen = Boolean(expandedTrails[sp.key]);
                const stoichLabel = stoichOf(sp);
                const lineageText = formatLineageText(node);
                const refKey = familyId ? `${familyId}::${sp.key}` : null;
                const isPulsed = refKey != null && pulsedTileKey === refKey;

                return (
                  <div
                    key={sp.key}
                    ref={(el) => {
                      if (!refKey) return;
                      if (el) tileRefs.current.set(refKey, el);
                      else tileRefs.current.delete(refKey);
                    }}
                    style={{
                      border: isPulsed
                        ? '2px solid var(--acc)'
                        : node?.isLead
                        ? '1px solid color-mix(in srgb, var(--acc) 45%, var(--line))'
                        : '1px solid var(--line)',
                      boxShadow: isPulsed
                        ? '0 0 0 4px color-mix(in srgb, var(--acc) 22%, transparent)'
                        : undefined,
                      borderRadius: '12px',
                      padding: '12px 14px',
                      background: 'var(--panel)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      minWidth: 0,
                      transition: 'border-color 0.18s ease, box-shadow 0.25s ease',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '6px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span className="mono" style={{ fontWeight: 700, fontSize: '13px' }}>
                          #{rankNum}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: '11.5px',
                            fontWeight: 700,
                            padding: '2px 7px',
                            borderRadius: '6px',
                            color: tc.fg,
                            background: tc.bg,
                            border: `1px solid ${tc.bd}`,
                          }}
                        >
                          {sp.score.toFixed(2)} · {sp.tier}
                        </span>
                        {stoichLabel && (
                          <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg2)' }}>
                            {stoichLabel}
                          </span>
                        )}
                        <span style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                          {sp.status === 'sink' ? 'Stable' : 'Equil.'} · L {sp.likelihood.toFixed(2)} · P {sp.persistence.toFixed(2)}
                          {sp.reversibleEnd ? ' · reversible' : ''}
                          {sp.tautomerForms > 1 ? ` · ${sp.tautomerForms} tautomer forms` : ''}
                        </span>
                      </div>

                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ height: '24px', fontSize: '11px', padding: '0 7px' }}
                          onClick={() => {
                            navigator.clipboard.writeText(sp.smiles);
                            toast('Copied product SMILES.');
                          }}
                          title="Copy canonical SMILES"
                        >
                          <Copy size={11} />
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ height: '24px', fontSize: '11px', padding: '0 7px' }}
                          onClick={() => {
                            navigator.clipboard.writeText(sp.mhPlus.toFixed(4));
                            toast(`Copied [M+H]+ = ${sp.mhPlus.toFixed(4)}`);
                          }}
                          title="Copy [M+H]+ exact mass"
                        >
                          [M+H]⁺
                        </button>
                      </div>
                    </div>

                    {lineageText && (
                      <div
                        className="mono"
                        style={{
                          fontSize: '11px',
                          fontWeight: node?.isLead ? 700 : 500,
                          color: node?.isLead ? 'var(--acc)' : 'var(--fg2)',
                          marginTop: '-4px',
                        }}
                      >
                        {lineageText}
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--soft)',
                        borderRadius: '9px',
                        padding: '6px',
                        minHeight: '208px',
                      }}
                    >
                      <ChemicalStructure
                        smiles={sp.smiles}
                        name={`${stoichLabel || 'Product'} (${sp.formula})`}
                        width={310}
                        height={196}
                        highlightBonds={getHighlightsFor(sp)}
                      />
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                        gap: '6px',
                        padding: '7px 9px',
                        borderRadius: '7px',
                        background: 'var(--soft)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>[M+H]⁺</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--acc)' }}>
                          {sp.mhPlus.toFixed(4)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>[M+Na]⁺</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.mNaPlus.toFixed(3)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>Formula</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {sp.formula}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--mut)' }}>cLogP · TPSA</div>
                        <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                          {sp.clogP.toFixed(1)} · {sp.tpsa.toFixed(0)}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span className="mono" style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--fg2)' }}>
                        {sp.mechanismSummary}
                      </span>
                      <button
                        type="button"
                        className="btn sm"
                        style={{ height: '22px', fontSize: '11px', padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                        onClick={() => toggleTrail(sp.key)}
                      >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span>Steps ({sp.stepsCount})</span>
                      </button>
                    </div>

                    {node && node.alsoViaLabels.length > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        Convergent: also reached via {node.alsoViaLabels.join(', ')}
                      </div>
                    )}

                    {sp.lossIons && sp.lossIons.length > 0 && (
                      <div
                        className="mono"
                        style={{ fontSize: '11px', color: 'var(--fg2)' }}
                        title={sp.lossIons.map((l) => `${l.label}: ${l.note}`).join(' | ')}
                      >
                        In-source: {sp.lossIons.map((l) => `${l.label} ${l.mz.toFixed(4)}`).join(' · ')}
                      </div>
                    )}

                    {sp.alerts.length > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--warn)' }}>
                        {sp.alerts.map((a) => a.message).join(' · ')}
                      </div>
                    )}

                    {isOpen && (
                      <div
                        style={{
                          padding: '8px 10px',
                          background: 'var(--bg)',
                          borderRadius: '6px',
                          border: '1px solid var(--line2)',
                          fontSize: '11.5px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                          Exact {sp.exactMass.toFixed(4)} · [M−H]⁻ {sp.mHMinus.toFixed(4)}
                        </div>
                        {sp.bestChain.map((st, sIdx) => (
                          <div key={sIdx} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                            <span>
                              <b className="mono">{sIdx + 1}. {st.stepLabel}</b> — {st.description}
                              {st.releasedFragment ? ` (${st.releasedFragment})` : ''}
                              {st.releasedGas ? ` (${st.releasedGas})` : ''}
                            </span>
                            <span className="mono" style={{ color: 'var(--mut)' }}>
                              w={st.stepWeight.toFixed(2)}
                            </span>
                          </div>
                        ))}
                        {sp.alternativeChains.length > 0 && (
                          <div style={{ color: 'var(--mut)', paddingTop: '4px', borderTop: '1px dashed var(--line)' }}>
                            Alt:{' '}
                            {sp.alternativeChains.map((ac) => ac.map((x) => x.stepLabel).join(' → ')).join(' | ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              };

              // 1. LC-MS TABLE + STICKY STRUCTURE INSPECTOR (Zero page scroll!)
              if (viewLayout === 'table') {
                const activeKey =
                  selectedTableKey && filteredSpecies.some((s) => s.key === selectedTableKey)
                    ? selectedTableKey
                    : filteredSpecies[0].key;
                const activeSp = filteredSpecies.find((s) => s.key === activeKey) || filteredSpecies[0];
                const activeRank = rankLookup.get(activeSp.key) ?? 1;
                const activeNode = families
                  .flatMap((f) => f.nodes)
                  .find((n) => n.species.key === activeSp.key);

                return (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                      gap: '14px',
                      alignItems: 'start',
                    }}
                  >
                    {/* Left: Compact Scrollable Peak Table */}
                    <div
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: '10px',
                        overflow: 'auto',
                        maxHeight: '560px',
                        background: 'var(--bg)',
                      }}
                    >
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead
                          style={{
                            position: 'sticky',
                            top: 0,
                            background: 'var(--soft)',
                            zIndex: 1,
                            borderBottom: '1px solid var(--line)',
                          }}
                        >
                          <tr style={{ textAlign: 'left', color: 'var(--mut)', fontSize: '11px' }}>
                            <th style={{ padding: '8px 10px' }}>#</th>
                            <th style={{ padding: '8px 8px' }}>Score (L·P)</th>
                            <th style={{ padding: '8px 8px' }}>[M+H]⁺</th>
                            <th style={{ padding: '8px 8px' }}>Formula</th>
                            <th style={{ padding: '8px 8px' }}>Pathway / Route</th>
                            <th style={{ padding: '8px 10px' }}>State</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredSpecies.map((sp) => {
                            const rankNum = rankLookup.get(sp.key) ?? 1;
                            const tc = tierColor(sp.tier);
                            const sel = sp.key === activeSp.key;
                            const lossHint = sp.lossIons?.[0]
                              ? `${sp.lossIons[0].label} ${sp.lossIons[0].mz.toFixed(2)}`
                              : '';

                            return (
                              <tr
                                key={sp.key}
                                onClick={() => setSelectedTableKey(sp.key)}
                                style={{
                                  cursor: 'pointer',
                                  borderBottom: '1px solid var(--line2)',
                                  background: sel
                                    ? 'color-mix(in srgb, var(--acc) 10%, var(--panel))'
                                    : 'transparent',
                                }}
                              >
                                <td className="mono" style={{ padding: '7px 10px', fontWeight: 700 }}>
                                  #{rankNum}
                                </td>
                                <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      padding: '1px 6px',
                                      borderRadius: '5px',
                                      color: tc.fg,
                                      background: tc.bg,
                                      border: `1px solid ${tc.bd}`,
                                    }}
                                  >
                                    {sp.score.toFixed(2)} · {sp.tier}
                                  </span>
                                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--mut)', marginLeft: '5px' }}>
                                    {sp.likelihood.toFixed(2)}/{sp.persistence.toFixed(2)}
                                  </span>
                                </td>
                                <td className="mono" style={{ padding: '7px 8px', fontWeight: 700, color: 'var(--acc)' }}>
                                  {sp.mhPlus.toFixed(4)}
                                  {lossHint && (
                                    <div style={{ fontSize: '10px', color: 'var(--mut)', fontWeight: 400 }}>
                                      {lossHint}
                                    </div>
                                  )}
                                </td>
                                <td className="mono" style={{ padding: '7px 8px' }}>
                                  {sp.formula}
                                  {stoichOf(sp) && (
                                    <div style={{ fontSize: '10px', color: 'var(--mut)' }}>{stoichOf(sp)}</div>
                                  )}
                                </td>
                                <td className="mono" style={{ padding: '7px 8px', fontSize: '11px', color: 'var(--fg2)' }}>
                                  {sp.mechanismSummary}
                                </td>
                                <td style={{ padding: '7px 10px', fontSize: '11px', color: 'var(--mut)' }}>
                                  {sp.status === 'sink' ? 'Stable' : 'Equil.'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Right: Sticky Structure & Mechanism Inspector */}
                    <div style={{ position: 'sticky', top: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'var(--soft)',
                          borderRadius: '10px',
                          border: '1px solid var(--line)',
                          padding: '10px',
                          minHeight: '220px',
                        }}
                      >
                        <ChemicalStructure
                          smiles={activeSp.smiles}
                          name={`${stoichOf(activeSp) || 'Product'} (${activeSp.formula})`}
                          width={340}
                          height={210}
                          highlightBonds={getHighlightsFor(activeSp)}
                        />
                      </div>
                      {renderFullInspector(activeSp, activeRank, activeNode)}
                    </div>
                  </div>
                );
              }

              // 2. FLAT BY CONFIDENCE IN CASCADE OR CARDS
              if (groupMode === 'score') {
                if (viewLayout === 'flow') {
                  const selScoreKey =
                    inspectedByFamily['__flat__'] &&
                    filteredSpecies.some((s) => s.key === inspectedByFamily['__flat__'])
                      ? inspectedByFamily['__flat__']!
                      : null;
                  const selSp = selScoreKey ? filteredSpecies.find((s) => s.key === selScoreKey) || null : null;

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(276px, 1fr))',
                          gap: '12px',
                        }}
                      >
                        {filteredSpecies.map((sp) =>
                          renderCascadeTile(sp, rankLookup.get(sp.key) ?? 1, '__flat__')
                        )}
                      </div>
                      {selSp && renderFullInspector(selSp, rankLookup.get(selSp.key) ?? 1)}
                    </div>
                  );
                }
                return (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                      gap: '14px',
                    }}
                  >
                    {filteredSpecies.map((sp) => renderGridCard(sp, rankLookup.get(sp.key) ?? 1))}
                  </div>
                );
              }

              // 3. BY PATHWAY (CAUSAL CASCADE ROUTES INSIDE COLLAPSIBLE PATHWAY ACCORDIONS)
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {families.map((fam, famIdx) => {
                    const famTc = tierColor(fam.peakTier);
                    const open = isFamilyOpen(fam, famIdx);
                    const showMinor = Boolean(expandedMinorFamilies[fam.id]) || fam.primaryRoutes.length === 0;
                    const showAllSideRoutes =
                      Boolean(expandedSideRoutes[fam.id]) || Boolean(massQuery.trim()) || tierFilter !== 'all';
                    const extraCodes = fam.allSubstrateCodes.filter(
                      (c) => !fam.entrySubstrateCodes.includes(c)
                    );
                    const substrateRoute =
                      fam.entrySubstrateCodes.join(' + ') +
                      (extraCodes.length > 0 ? ` → +${extraCodes.join(' + ')}` : '');
                    const minorPeak = fam.minorNodes.reduce((mx, n) => Math.max(mx, n.species.score), 0);
                    const inspectedKey = inspectedByFamily[fam.id] || null;
                    const inspectedMinorNode = inspectedKey
                      ? fam.minorNodes.find((n) => n.species.key === inspectedKey) || null
                      : null;

                    const allRoutes = fam.primaryRoutes;
                    const visibleRoutes = showAllSideRoutes
                      ? allRoutes
                      : allRoutes.filter(
                          (r, rIdx) =>
                            r.isLeadRoute ||
                            r.peakTier === 'High' ||
                            r.peakTier === 'Medium' ||
                            rIdx < 3
                        );
                    const hiddenRoutes = showAllSideRoutes
                      ? []
                      : allRoutes.filter((r) => !visibleRoutes.includes(r));
                    const hiddenPeak = hiddenRoutes.reduce((mx, r) => Math.max(mx, r.peakScore), 0);
                    const hasMultiRoutes = allRoutes.length > 1;

                    return (
                      <section
                        key={fam.id}
                        style={{
                          border: '1px solid var(--line)',
                          borderRadius: '11px',
                          background: 'var(--bg)',
                          overflow: 'hidden',
                        }}
                      >
                        {/* Clickable 1-Line Pathway Accordion Header */}
                        <button
                          type="button"
                          onClick={() => toggleFamilyOpen(fam, famIdx)}
                          style={{
                            width: '100%',
                            border: 'none',
                            background: open ? 'var(--panel)' : 'var(--bg)',
                            borderBottom: open ? '1px solid var(--line2)' : 'none',
                            padding: '10px 14px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '10px',
                            flexWrap: 'wrap',
                            cursor: 'pointer',
                            textAlign: 'left',
                            color: 'inherit',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span style={{ fontWeight: 700, fontSize: '13.5px', color: 'var(--fg)' }}>
                              Pathway {fam.pathwayNumber}
                            </span>
                            <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--fg2)' }}>
                              {fam.entryStepLabel} — {fam.title}
                            </span>
                            {substrateRoute && (
                              <span
                                className="mono"
                                style={{
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  color: 'var(--acc)',
                                  padding: '1px 6px',
                                  borderRadius: '5px',
                                  background: 'var(--soft)',
                                  border: '1px solid var(--line2)',
                                }}
                              >
                                {substrateRoute}
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span
                              className="mono"
                              style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                padding: '2px 7px',
                                borderRadius: '6px',
                                color: famTc.fg,
                                background: famTc.bg,
                                border: `1px solid ${famTc.bd}`,
                              }}
                            >
                              Peak {fam.peakScore.toFixed(2)} · {fam.peakTier}
                            </span>
                            <span className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                              Lead #{fam.leadGlobalRank} · [M+H]⁺ {fam.leadSpecies.mhPlus.toFixed(4)} ·{' '}
                              {hasMultiRoutes ? `${allRoutes.length} routes · ` : ''}
                              {fam.nodes.length} species
                            </span>
                          </div>
                        </button>

                        {open && (
                          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {viewLayout === 'flow' && visibleRoutes.length > 0 && (
                              <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                                {hasMultiRoutes
                                  ? 'Each row groups consecutive products along one cascade route; click any tile for full LC-MS ions & step weights.'
                                  : 'Click any tile below for full LC-MS ions & step weights.'}
                              </div>
                            )}

                            {visibleRoutes.map((route) => {
                              const rTc = tierColor(route.peakTier);
                              const inspectedInRoute = inspectedKey
                                ? route.nodes.find((n) => n.species.key === inspectedKey) || null
                                : null;

                              const routeContent =
                                viewLayout === 'flow' ? (
                                  <>
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'stretch',
                                        gap: '8px',
                                        overflowX: 'auto',
                                        paddingBottom: '4px',
                                      }}
                                    >
                                      {route.branchFromRank != null && (
                                        <div
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            flexShrink: 0,
                                          }}
                                        >
                                          <button
                                            type="button"
                                            className="btn sm"
                                            title={
                                              route.branchFromFormula
                                                ? `Scroll to #${route.branchFromRank} (${route.branchFromFormula}) and inspect its structure`
                                                : `Scroll to #${route.branchFromRank}`
                                            }
                                            onClick={() => jumpToBranchParent(fam.id, route.branchFromKey)}
                                            style={{
                                              height: 'auto',
                                              padding: '6px 9px',
                                              fontSize: '11px',
                                              color: 'var(--fg2)',
                                              background: 'var(--soft)',
                                              borderColor: 'var(--line)',
                                            }}
                                          >
                                            <span className="mono">
                                              ↳ from #{route.branchFromRank}
                                              {route.branchFromFormula ? ` (${route.branchFromFormula})` : ''}
                                            </span>
                                          </button>
                                          <ArrowRight size={14} style={{ color: 'var(--mut)' }} />
                                        </div>
                                      )}
                                      {route.nodes.map((n, nIdx) => (
                                        <React.Fragment key={n.species.key}>
                                          {nIdx > 0 && (
                                            <div
                                              aria-hidden="true"
                                              style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                color: 'var(--mut)',
                                                flexShrink: 0,
                                              }}
                                            >
                                              <ArrowRight size={14} />
                                            </div>
                                          )}
                                          {renderCascadeTile(n.species, n.globalRank, fam.id, n)}
                                        </React.Fragment>
                                      ))}
                                    </div>

                                    {inspectedInRoute &&
                                      renderFullInspector(
                                        inspectedInRoute.species,
                                        inspectedInRoute.globalRank,
                                        inspectedInRoute
                                      )}
                                  </>
                                ) : (
                                  <div
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
                                      gap: '12px',
                                    }}
                                  >
                                    {route.nodes.map((n) => renderGridCard(n.species, n.globalRank, n, fam.id))}
                                  </div>
                                );

                              if (!hasMultiRoutes) {
                                return (
                                  <div
                                    key={route.id}
                                    style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                                  >
                                    {routeContent}
                                  </div>
                                );
                              }

                              return (
                                <div
                                  key={route.id}
                                  style={{
                                    border: route.isLeadRoute
                                      ? '1px solid color-mix(in srgb, var(--acc) 35%, var(--line))'
                                      : '1px solid var(--line2)',
                                    borderRadius: '9px',
                                    padding: '10px 12px',
                                    background: 'color-mix(in srgb, var(--panel) 65%, var(--bg))',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '8px',
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '8px',
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                                      <span
                                        className="mono"
                                        style={{
                                          fontSize: '11.5px',
                                          fontWeight: 700,
                                          color: route.isLeadRoute ? 'var(--acc)' : 'var(--fg)',
                                        }}
                                      >
                                        {route.isLeadRoute
                                          ? `Route ${route.routeNumber} · Lead Cascade`
                                          : `Route ${route.routeNumber}`}
                                      </span>
                                      {route.branchFromRank != null && (
                                        <button
                                          type="button"
                                          onClick={() => jumpToBranchParent(fam.id, route.branchFromKey)}
                                          title={`Scroll to #${route.branchFromRank}`}
                                          className="mono"
                                          style={{
                                            border: 'none',
                                            background: 'transparent',
                                            padding: 0,
                                            cursor: route.branchFromKey ? 'pointer' : 'default',
                                            fontSize: '11px',
                                            color: 'var(--acc)',
                                            textDecoration: 'underline',
                                          }}
                                        >
                                          · diverges at #{route.branchFromRank}
                                          {route.branchFromStepLabel ? ` (${route.branchFromStepLabel})` : ''}
                                        </button>
                                      )}
                                      {route.substrateCodes.length > 0 && (
                                        <span
                                          className="mono"
                                          style={{
                                            fontSize: '10.5px',
                                            color: 'var(--fg2)',
                                            padding: '1px 5px',
                                            borderRadius: '4px',
                                            background: 'var(--soft)',
                                          }}
                                        >
                                          {route.substrateCodes.join(' + ')}
                                        </span>
                                      )}
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <span
                                        className="mono"
                                        style={{
                                          fontSize: '10.5px',
                                          fontWeight: 700,
                                          padding: '1px 6px',
                                          borderRadius: '5px',
                                          color: rTc.fg,
                                          background: rTc.bg,
                                          border: `1px solid ${rTc.bd}`,
                                        }}
                                      >
                                        Peak {route.peakScore.toFixed(2)} · {route.peakTier}
                                      </span>
                                      <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                                        {route.nodes.length} product{route.nodes.length === 1 ? '' : 's'}
                                      </span>
                                    </div>
                                  </div>

                                  {routeContent}
                                </div>
                              );
                            })}

                            {hiddenRoutes.length > 0 && (
                              <div>
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{
                                    height: '24px',
                                    fontSize: '11px',
                                    padding: '0 9px',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    color: 'var(--fg2)',
                                  }}
                                  onClick={() =>
                                    setExpandedSideRoutes((prev) => ({
                                      ...prev,
                                      [fam.id]: !prev[fam.id],
                                    }))
                                  }
                                >
                                  <ChevronRight size={12} />
                                  <span>
                                    + Show {hiddenRoutes.length} lower-scoring side route
                                    {hiddenRoutes.length > 1 ? 's' : ''} (max {hiddenPeak.toFixed(2)})
                                  </span>
                                </button>
                              </div>
                            )}

                            {showAllSideRoutes && allRoutes.length > 3 && expandedSideRoutes[fam.id] && (
                              <div>
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{
                                    height: '24px',
                                    fontSize: '11px',
                                    padding: '0 9px',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    color: 'var(--mut)',
                                  }}
                                  onClick={() =>
                                    setExpandedSideRoutes((prev) => ({
                                      ...prev,
                                      [fam.id]: false,
                                    }))
                                  }
                                >
                                  <ChevronDown size={12} />
                                  <span>Collapse lower-scoring side routes</span>
                                </button>
                              </div>
                            )}

                            {fam.minorNodes.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{
                                      height: '24px',
                                      fontSize: '11px',
                                      padding: '0 9px',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      color: 'var(--fg2)',
                                    }}
                                    onClick={() => toggleMinorFamily(fam.id)}
                                  >
                                    {showMinor ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                    <span>
                                      {showMinor
                                        ? `Hide ${fam.minorNodes.length} speculative branch${fam.minorNodes.length > 1 ? 'es' : ''}`
                                        : `+ Show ${fam.minorNodes.length} speculative branch${fam.minorNodes.length > 1 ? 'es' : ''} (max ${minorPeak.toFixed(2)})`}
                                    </span>
                                  </button>
                                </div>

                                {showMinor &&
                                  (viewLayout === 'flow' ? (
                                    <>
                                      <div
                                        style={{
                                          display: 'flex',
                                          alignItems: 'stretch',
                                          gap: '8px',
                                          overflowX: 'auto',
                                          paddingBottom: '4px',
                                        }}
                                      >
                                        {fam.minorNodes.map((n) =>
                                          renderCascadeTile(n.species, n.globalRank, fam.id, n)
                                        )}
                                      </div>
                                      {inspectedMinorNode &&
                                        renderFullInspector(
                                          inspectedMinorNode.species,
                                          inspectedMinorNode.globalRank,
                                          inspectedMinorNode
                                        )}
                                    </>
                                  ) : (
                                    <div
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
                                        gap: '12px',
                                      }}
                                    >
                                      {fam.minorNodes.map((n) => renderGridCard(n.species, n.globalRank, n, fam.id))}
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              );
            })()
          ) : species.length > 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--mut)', fontSize: '13px' }}>
              No products match the current filter or m/z query.
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--mut)', fontSize: '13px' }}>
              No reactive products predicted under these conditions (adjust temperature, pH/additive, or enable speculative candidates).
            </div>
          )
        ) : releasedFragments.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '12px' }}>
            {releasedFragments.map((fr) => (
              <div
                key={fr.key}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px',
                  border: '1px solid var(--line2)',
                  borderRadius: '10px',
                  background: 'var(--soft)',
                }}
              >
                <ChemicalStructure smiles={fr.smiles} name={fr.releasedFragmentName} width={175} height={118} />
                <div style={{ width: '100%', textAlign: 'center' }}>
                  <div style={{ fontWeight: 700, fontSize: '13px' }}>
                    {fr.releasedFragmentName || fr.formula}
                  </div>
                  <div className="mono" style={{ fontSize: '11.5px', color: 'var(--acc)', fontWeight: 600 }}>
                    [M+H]⁺ {fr.mhPlus.toFixed(4)}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                    {fr.mechanismSummary}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--mut)', fontSize: '13px' }}>
            No small reactive fragments released in this reaction network.
          </div>
        )}
      </div>
    </div>
  );
};
