import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  Layers,
  LayoutGrid,
  List,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  MediumMode,
  PredictedSpecies,
  PredictorSubstrateInput,
  WellConditionConfig,
  WellPredictionResult,
  exportLcmsTargetListCsv,
  extractWellForPrediction,
  getSuggestedWellDisplay,
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
    toast,
  } = useApp();

  const [rdkit, setRdkit] = useState<any>(null);
  const [rdkitLoading, setRdkitLoading] = useState<boolean>(true);
  const [mode, setMode] = useState<'plate' | 'sandbox'>(run && run.rows.length > 0 ? 'plate' : 'sandbox');

  // Plate mode states
  const [activePlate, setActivePlate] = useState<number>(0);
  const [selectedWellIdx, setSelectedWellIdx] = useState<number>(0);
  const [plateTempC, setPlateTempC] = useState<number>(() => {
    const t = Number(state.eln?.temperatureC);
    return Number.isFinite(t) && t > 0 ? t : 80;
  });
  const [plateWaterPct, setPlateWaterPct] = useState<number>(2.0);
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

  const currentExtraction = useMemo(() => {
    if (!currentRow) return null;
    return extractWellForPrediction(state, currentRow, conditionOverrides);
  }, [state, currentRow, conditionOverrides]);

  const activeWellResult = useMemo<WellPredictionResult | null>(() => {
    if (!rdkit || !currentExtraction || mode !== 'plate') return null;
    const validSubs = currentExtraction.substrates.filter((s) => s.smiles.trim().length > 0);
    if (validSubs.length === 0) return null;
    try {
      return predictWellReactions(rdkit, validSubs, currentExtraction.condition, {
        includeSpeculative,
      });
    } catch {
      return null;
    }
  }, [rdkit, currentExtraction, mode, includeSpeculative]);

  // Cache single-well calculation back into plateResults map for matrix badges & CSV export
  const activeKey = `${activePlate}-${selectedWellIdx}`;
  useEffect(() => {
    if (activeWellResult) {
      setPlateResults((prev) => {
        if (prev[activeKey] === activeWellResult) return prev;
        return { ...prev, [activeKey]: activeWellResult };
      });
    }
  }, [activeKey, activeWellResult]);

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

  // Batch analyze active plate cleanly without freezing UI
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
      const ext = extractWellForPrediction(state, row, conditionOverrides);
      const validSubs = ext.substrates.filter((s) => s.smiles.trim().length > 0);
      if (validSubs.length > 0) {
        try {
          accumulated[key] = predictWellReactions(rdkit, validSubs, ext.condition, {
            includeSpeculative,
          });
        } catch {}
      }
      setBatchProgress({ running: true, done: i + 1, total: wellsToRun.length });
      if ((i + 1) % 3 === 0 || i === wellsToRun.length - 1) {
        setPlateResults({ ...accumulated });
        await new Promise((res) => setTimeout(res, 0));
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
                ▦ Plate &amp; Well Mode
              </button>
              <button
                type="button"
                className={mode === 'sandbox' ? 'on' : ''}
                onClick={() => setMode('sandbox')}
                title="Test any arbitrary 1 to N substrates, salts, and conditions"
              >
                ⚗ Any-Component Sandbox
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
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Temp (°C)</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '72px', height: '30px', fontSize: '12px' }}
                  value={plateTempC}
                  onChange={(e) => {
                    setPlateTempC(Number(e.target.value) || 25);
                    setPlateResults({});
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Water</span>
                <select
                  className="f"
                  style={{ height: '30px', fontSize: '12px', padding: '0 8px' }}
                  value={String(plateWaterPct)}
                  onChange={(e) => {
                    setPlateWaterPct(Number(e.target.value));
                    setPlateResults({});
                  }}
                >
                  <option value="0.2">Dry (0.2%)</option>
                  <option value="2">Ambient (2%)</option>
                  <option value="10">Wet (10%)</option>
                </select>
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
                <span style={{ color: 'var(--mut)', fontWeight: 500 }}>Water %</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="50"
                  className="f mono"
                  style={{ width: '62px', height: '30px', fontSize: '12px' }}
                  value={sandboxCond.waterPct}
                  onChange={(e) => setSandboxCond((c) => ({ ...c, waterPct: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>

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
  const [viewLayout, setViewLayout] = useState<'grid' | 'list'>('grid');
  const [showEquilibriumDetails, setShowEquilibriumDetails] = useState<boolean>(false);
  const [expandedTrails, setExpandedTrails] = useState<Record<string, boolean>>({});
  const { acidBase, species, releasedFragments, alerts, substrates, stats, condition } = result;

  const toggleTrail = (key: string) => {
    setExpandedTrails((prev) => ({ ...prev, [key]: !prev[key] }));
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
            </div>
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: '4px', color: 'var(--acc)' }}>
              <div style={{ flex: 1, height: '2px', background: 'currentColor', borderRadius: '2px' }} />
              <ArrowRight size={18} strokeWidth={2.2} />
            </div>
            <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)', textAlign: 'center' }}>
              {mediumLabel(acidBase.effectiveMedium)} · pH {acidBase.effectivePhDmso.toFixed(1)} · {condition.waterPct.toFixed(1)}% H₂O
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
            <div className="seg" role="group" aria-label="Product card layout">
              <button
                type="button"
                className={viewLayout === 'grid' ? 'on' : ''}
                onClick={() => setViewLayout('grid')}
                title="Structure-first visual grid"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <LayoutGrid size={12} />
                <span>Visual Grid</span>
              </button>
              <button
                type="button"
                className={viewLayout === 'list' ? 'on' : ''}
                onClick={() => setViewLayout('list')}
                title="Detailed side-by-side list"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <List size={12} />
                <span>List</span>
              </button>
            </div>
          )}
        </div>

        {activeTab === 'products' ? (
          species.length > 0 ? (
            viewLayout === 'grid' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: '14px',
                }}
              >
                {species.map((sp, idx) => {
                  const tc = tierColor(sp.tier);
                  const isOpen = Boolean(expandedTrails[sp.key]);
                  const stoichLabel = substrates
                    .map((s, sIdx) => (sp.inventory[sIdx] > 0 ? `${sp.inventory[sIdx] > 1 ? sp.inventory[sIdx] : ''}${s.code}` : null))
                    .filter(Boolean)
                    .join(' + ');

                  return (
                    <div
                      key={sp.key}
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: '12px',
                        padding: '12px 14px',
                        background: 'var(--panel)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        minWidth: 0,
                      }}
                    >
                      {/* Slim Top Strip */}
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
                            #{idx + 1}
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
                            {sp.status === 'sink' ? 'Stable' : 'Equil.'}
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

                      {/* Large Hero 2D Chemical Structure */}
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
                        />
                      </div>

                      {/* Compact 4-Column Quantitative Strip */}
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

                      {/* Compact Pathway & Trail Toggle */}
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
                })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {species.map((sp, idx) => {
                  const tc = tierColor(sp.tier);
                  const isOpen = Boolean(expandedTrails[sp.key]);
                  const stoichLabel = substrates
                    .map((s, sIdx) => (sp.inventory[sIdx] > 0 ? `${sp.inventory[sIdx] > 1 ? sp.inventory[sIdx] : ''}${s.code}` : null))
                    .filter(Boolean)
                    .join(' + ');

                  return (
                    <div
                      key={sp.key}
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: '10px',
                        padding: '12px 14px',
                        background: 'var(--panel)',
                        display: 'grid',
                        gridTemplateColumns: 'minmax(240px, 268px) minmax(0, 1fr)',
                        gap: '16px',
                        alignItems: 'center',
                      }}
                    >
                      {/* Left: Larger 2D Structure */}
                      <ChemicalStructure
                        smiles={sp.smiles}
                        name={`${stoichLabel || 'Product'} (${sp.formula})`}
                        width={260}
                        height={175}
                      />

                      {/* Right: Masses, Score, Pathway */}
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span className="mono" style={{ fontWeight: 700, fontSize: '13.5px' }}>
                              #{idx + 1}
                            </span>
                            <span
                              className="mono"
                              style={{
                                fontSize: '12px',
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
                            <span style={{ fontSize: '12.5px', fontWeight: 600 }}>
                              {sp.status === 'sink' ? 'Stable Product' : 'Equilibrium'}
                            </span>
                            {stoichLabel && (
                              <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
                                · {stoichLabel}
                              </span>
                            )}
                            <span className="mono" style={{ fontSize: '12px', color: 'var(--fg2)' }}>
                              · {sp.formula}
                            </span>
                          </div>

                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              className="btn sm"
                              style={{ height: '26px', fontSize: '11px', padding: '0 8px' }}
                              onClick={() => {
                                navigator.clipboard.writeText(sp.smiles);
                                toast('Copied product SMILES.');
                              }}
                              title="Copy canonical SMILES"
                            >
                              <Copy size={11} />
                              <span style={{ marginLeft: '4px' }}>SMILES</span>
                            </button>
                            <button
                              type="button"
                              className="btn sm"
                              style={{ height: '26px', fontSize: '11px', padding: '0 8px' }}
                              onClick={() => {
                                navigator.clipboard.writeText(sp.mhPlus.toFixed(4));
                                toast(`Copied [M+H]+ = ${sp.mhPlus.toFixed(4)}`);
                              }}
                              title="Copy [M+H]+ exact mass"
                            >
                              Copy [M+H]⁺
                            </button>
                          </div>
                        </div>

                        {/* Tabular LC-MS & Chromatography Metrics */}
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(95px, 1fr))',
                            gap: '8px',
                            padding: '8px 10px',
                            borderRadius: '7px',
                            background: 'var(--soft)',
                            marginBottom: '8px',
                          }}
                        >
                          <div>
                            <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>Exact Mass</div>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                              {sp.exactMass.toFixed(4)}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>[M+H]⁺</div>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--acc)' }}>
                              {sp.mhPlus.toFixed(4)}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>[M+Na]⁺</div>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                              {sp.mNaPlus.toFixed(4)}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>[M−H]⁻</div>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                              {sp.mHMinus.toFixed(4)}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>cLogP / TPSA</div>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                              {sp.clogP.toFixed(1)} · {sp.tpsa.toFixed(0)} Å²
                            </div>
                          </div>
                        </div>

                        {/* Mechanism Summary & Expandable Steps */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ fontSize: '12px', color: 'var(--fg2)' }}>
                            <span className="mono" style={{ fontWeight: 600 }}>
                              {sp.mechanismSummary}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="btn sm"
                            style={{ height: '24px', fontSize: '11px', padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                            onClick={() => toggleTrail(sp.key)}
                          >
                            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            <span>Steps ({sp.stepsCount})</span>
                          </button>
                        </div>

                        {sp.alerts.length > 0 && (
                          <div style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--warn)' }}>
                            {sp.alerts.map((a) => a.message).join(' · ')}
                          </div>
                        )}

                        {isOpen && (
                          <div
                            style={{
                              marginTop: '8px',
                              padding: '8px 10px',
                              background: 'var(--bg)',
                              borderRadius: '6px',
                              border: '1px solid var(--line2)',
                              fontSize: '11.5px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '5px',
                            }}
                          >
                            {sp.bestChain.map((st, sIdx) => (
                              <div key={sIdx} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                                <span>
                                  <b className="mono">{sIdx + 1}. {st.stepLabel}</b> — {st.description}
                                  {st.releasedFragment ? ` (releases ${st.releasedFragment})` : ''}
                                  {st.releasedGas ? ` (releases ${st.releasedGas})` : ''}
                                </span>
                                <span className="mono" style={{ color: 'var(--mut)' }}>
                                  w={st.stepWeight.toFixed(2)} · pH×{st.conditionFactor.toFixed(2)} · T×{st.tempFactor.toFixed(2)}
                                  {st.ringFactor > 1.05 ? ` · ring×${st.ringFactor.toFixed(2)}` : ''}
                                </span>
                              </div>
                            ))}
                            {sp.alternativeChains.length > 0 && (
                              <div style={{ color: 'var(--mut)', paddingTop: '4px', borderTop: '1px dashed var(--line)' }}>
                                Alternative route{sp.alternativeChains.length > 1 ? 's' : ''}:{' '}
                                {sp.alternativeChains.map((ac) => ac.map((x) => x.stepLabel).join(' → ')).join(' | ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
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
