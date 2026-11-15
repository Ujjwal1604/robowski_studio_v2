import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAiSolventSystems,
  SolventAdvisorPayload,
  SolventSuggestionResponse,
  SolventSystemRecommendation,
} from '../../services/aiService';
import { useApp } from '../../context/AppContext';
import {
  containerOfLane,
  isKnownAdditiveReagent,
  LANE_FRAME_WIDTH,
  optimizePlateTlcSolvents,
  PlateSolventPlanResult,
  RecommendedPlateSolvent,
  SimulatedWellLane,
  SolventPoolMode,
  tlcLane,
  TlcStationaryPhasePreference,
  WellConditionConfig,
  WellPredictionResult,
} from '../../engine';
import { getRDKitInstance } from '../../utils/rdkit';
import { ChemicalStructure } from './ChemicalStructure';

interface SubstrateItem {
  code?: string;
  name: string;
  smiles?: string;
  role?: string;
}

interface AiSolventAdvisorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSubstrates?: SubstrateItem[];
  reactionClass?: string;
  onApplyToCurrentSet?: (systemName: string) => void;
  onCreateNewSet?: (systemName: string) => void;
  toast: (msg: string) => void;
  cachedPlatePredictions?: Record<string, WellPredictionResult>;
  initialPlateIndex?: number;
  conditionOverrides?: Partial<WellConditionConfig>;
}

const COMMON_REACTIONS = [
  'Amide Coupling',
  'Suzuki-Miyaura Cross-Coupling',
  'Buchwald-Hartwig Amination',
  'Esterification',
  'Nucleophilic Aromatic Substitution (SNAr)',
  'Reductive Amination',
  'Click Reaction (CuAAC / Triazole)',
  'Alkylation',
  'General Organic Transformation',
];

const STATIONARY_PHASES = [
  'Silica Gel (SiO2 - Normal Phase)',
  'Neutral Alumina (Al2O3)',
  'Basic Alumina (Al2O3)',
  'Reverse Phase (C18)',
];

function laneScoreColor(score: number): string {
  if (score >= 0.72) return '#10b981';
  if (score >= 0.48) return '#38bdf8';
  if (score >= 0.25) return '#f59e0b';
  return '#ef4444';
}

function stationaryPhaseBadge(
  sysPhase: 'SiO2' | 'C18',
  pref: TlcStationaryPhasePreference
): { short: string; full: string; isC18: boolean; isAlumina: boolean } {
  if (sysPhase === 'C18') {
    return { short: 'C18 RP', full: 'Reverse-Phase C18', isC18: true, isAlumina: false };
  }
  if (pref === 'Al2O3_neutral') {
    return { short: 'Neutral Al₂O₃', full: 'Neutral Alumina (Al₂O₃)', isC18: false, isAlumina: true };
  }
  if (pref === 'Al2O3_basic') {
    return { short: 'Basic Al₂O₃', full: 'Basic Alumina (Al₂O₃)', isC18: false, isAlumina: true };
  }
  return { short: 'SiO₂', full: 'Normal-Phase SiO₂', isC18: false, isAlumina: false };
}

function formatTlcTabName(baseName: string, pref: TlcStationaryPhasePreference): string {
  if (pref === 'Al2O3_neutral' && !baseName.includes('Al₂O₃')) {
    return `${baseName} (Neutral Al₂O₃)`;
  }
  if (pref === 'Al2O3_basic' && !baseName.includes('Al₂O₃')) {
    return `${baseName} (Basic Al₂O₃)`;
  }
  return baseName;
}

export const AiSolventAdvisorModal: React.FC<AiSolventAdvisorModalProps> = ({
  isOpen,
  onClose,
  initialSubstrates = [],
  reactionClass = 'Amide Coupling',
  onApplyToCurrentSet,
  onCreateNewSet,
  toast,
  cachedPlatePredictions,
  initialPlateIndex = 0,
  conditionOverrides,
}) => {
  const { state, run, triMeta, setTlcSets, view, setView } = useApp();
  const hasPlateRun = Boolean(run && run.rows && run.rows.length > 0);

  const [advisorMode, setAdvisorMode] = useState<'plate54' | 'singleAi'>(
    hasPlateRun ? 'plate54' : 'singleAi'
  );

  // =========================================================================
  // MODE 1: 54-WELL PLATE SOLVENT SET OPTIMIZER & SIMULATOR
  // =========================================================================
  const [plateIdx, setPlateIdx] = useState<number>(initialPlateIndex);
  const [numSystems, setNumSystems] = useState<number>(3);
  const [poolMode, setPoolMode] = useState<SolventPoolMode>('prefer_primary');
  const [stationaryPhasePref, setStationaryPhasePref] = useState<TlcStationaryPhasePreference>('auto');
  const [includeSpeculative, setIncludeSpeculative] = useState<boolean>(false);
  const [plateLoading, setPlateLoading] = useState<boolean>(false);
  const [plateProgress, setPlateProgress] = useState<{ done: number; total: number }>({ done: 0, total: 54 });
  const [platePlan, setPlatePlan] = useState<PlateSolventPlanResult | null>(null);
  const [selectedSystemId, setSelectedSystemId] = useState<string>('');
  const [selectedLaneIdx, setSelectedLaneIdx] = useState<number>(0);
  const [plateError, setPlateError] = useState<string | null>(null);
  const [showOtherSystems, setShowOtherSystems] = useState<boolean>(true);

  // =========================================================================
  // MODE 2: SINGLE-REACTION AI SOLVENT ADVISOR (EXISTING GEMINI ADVISOR)
  // =========================================================================
  const [substrates, setSubstrates] = useState<SubstrateItem[]>([]);
  const [newSubstrateName, setNewSubstrateName] = useState<string>('');
  const [expectedProduct, setExpectedProduct] = useState<string>('');
  const [selectedReaction, setSelectedReaction] = useState<string>(reactionClass);
  const [stationaryPhase, setStationaryPhase] = useState<string>('Silica Gel (SiO2 - Normal Phase)');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SolventSuggestionResponse | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef<number>(0);
  const predCacheRef = useRef<{
    sig: string;
    preds: Record<string, WellPredictionResult>;
  }>({ sig: '', preds: {} });

  const cacheSignature = useMemo(() => {
    const reagentSig = (state.reagents || [])
      .map((r) => `${r.code}:${r.smiles || ''}:${r.molarMass || ''}:${r.name || ''}`)
      .join('|');
    const condSig = `${state.reactionSolvent || ''}:${state.temperatureC ?? state.eln?.temperatureC ?? 25}:${state.waterPct ?? state.eln?.waterPct ?? 2}`;
    const ovSig = conditionOverrides
      ? `${conditionOverrides.medium || ''}:${conditionOverrides.temperatureC ?? ''}:${conditionOverrides.waterPct ?? ''}`
      : '';
    return `${run?.rows?.length || 0}::${state.mode}::${condSig}::${reagentSig}::${ovSig}::spec=${includeSpeculative}`;
  }, [run?.rows?.length, state.mode, state.reactionSolvent, state.temperatureC, state.waterPct, state.eln?.temperatureC, state.eln?.waterPct, state.reagents, conditionOverrides, includeSpeculative]);

  useEffect(() => {
    if (isOpen && hasPlateRun) {
      setAdvisorMode('plate54');
    } else if (isOpen && !hasPlateRun) {
      setAdvisorMode('singleAi');
    }
  }, [isOpen, hasPlateRun]);

  useEffect(() => {
    setPlateIdx(initialPlateIndex);
  }, [initialPlateIndex]);

  const initSubsSig = useMemo(
    () =>
      initialSubstrates
        .map((s) => `${s.code || ''}:${s.name}:${s.smiles || ''}`)
        .join('|'),
    [initialSubstrates]
  );

  useEffect(() => {
    if (initialSubstrates.length > 0) {
      const reagentMap = new Map((state.reagents || []).map((r) => [r.code, r]));
      const tagged = initialSubstrates.map((s) => {
        const reg = s.code ? reagentMap.get(s.code) : undefined;
        const isAdd = reg
          ? Boolean(isKnownAdditiveReagent(reg, state))
          : /\b(TsOH|TFA|HCl|AcOH|DBU|Et3N|DIPEA|K2CO3|Cs2CO3|DMAP|Pyridine|NaOH|KOtBu)\b/i.test(s.name);
        return isAdd ? { ...s, role: 'Additive' } : s;
      });
      setSubstrates(tagged);
      if (!expectedProduct) {
        const names = tagged.filter((s) => s.role !== 'Additive').map((s) => s.name).filter(Boolean);
        if (names.length >= 2) {
          setExpectedProduct(`Coupling product of ${names[0]} and ${names[1]}`);
        } else if (names.length === 1) {
          setExpectedProduct(`Reaction product of ${names[0]}`);
        } else {
          setExpectedProduct('Target reaction product');
        }
      }
    } else {
      setSubstrates([
        { code: 'AA', name: 'p-toluic acid', smiles: 'Cc1ccc(cc1)C(=O)O' },
        { code: 'BB', name: 'benzylamine', smiles: 'NCc1ccccc1' },
      ]);
      if (!expectedProduct) {
        setExpectedProduct('N-benzyl-4-methylbenzamide (amide product)');
      }
    }
  }, [initSubsSig]);

  const run54WellOptimization = useCallback(async () => {
    if (!run || !run.rows.length) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++runSeqRef.current;

    setPlateLoading(true);
    setPlateError(null);
    setPlateProgress({ done: 0, total: Math.min(54, run.rows.length) });

    try {
      const rdkit = await getRDKitInstance();
      if (controller.signal.aborted || runSeqRef.current !== seq) return;
      if (!rdkit) {
        setPlateError('Chemistry engine is still initializing — please try again in a moment.');
        return;
      }

      if (predCacheRef.current.sig !== cacheSignature) {
        predCacheRef.current = { sig: cacheSignature, preds: {} };
      }

      const mergedCached: Record<string, WellPredictionResult> = {
        ...predCacheRef.current.preds,
        ...(cachedPlatePredictions || {}),
      };

      const plan = await optimizePlateTlcSolvents(rdkit, state, run, triMeta, {
        plateIndex: plateIdx,
        maxSystems: numSystems,
        poolMode,
        stationaryPhase: stationaryPhasePref,
        conditionOverrides,
        cachedPredictions: mergedCached,
        includeSpeculative,
        signal: controller.signal,
        onProgress: (done, total) => {
          if (runSeqRef.current === seq) {
            setPlateProgress({ done, total });
          }
        },
      });

      if (controller.signal.aborted || runSeqRef.current !== seq) return;

      // Save computed well predictions into session cache so toggling 2/3/4 Systems, Preference, or Stationary Phase is instant
      if (plan.wellPredictions) {
        for (const [wIdxStr, wp] of Object.entries(plan.wellPredictions)) {
          predCacheRef.current.preds[`${plateIdx}-${wIdxStr}`] = wp;
        }
      }

      setPlatePlan(plan);
      const firstSys = plan.recommendedSystems[0];
      if (firstSys) {
        setSelectedSystemId(firstSys.system.id);
        const firstAssigned =
          firstSys.assignedWellIndices[0] ??
          firstSys.lanes.find((l) => !l.isBlank)?.wellIndex ??
          0;
        setSelectedLaneIdx(firstAssigned);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted || runSeqRef.current !== seq) {
        return;
      }
      setPlateError(e?.message || 'Failed to compute 54-well TLC optimization.');
    } finally {
      if (runSeqRef.current === seq) {
        setPlateLoading(false);
      }
    }
  }, [
    run,
    state,
    triMeta,
    plateIdx,
    numSystems,
    poolMode,
    stationaryPhasePref,
    conditionOverrides,
    cachedPlatePredictions,
    includeSpeculative,
    cacheSignature,
  ]);

  // Auto-run 54-well optimizer when modal opens in 54-well mode cleanly, and abort on close/change
  useEffect(() => {
    if (!isOpen || advisorMode !== 'plate54' || !hasPlateRun) {
      abortRef.current?.abort();
      return;
    }
    run54WellOptimization();
    return () => {
      abortRef.current?.abort();
    };
  }, [isOpen, advisorMode, hasPlateRun, run54WellOptimization]);

  const activeSystemPlan: RecommendedPlateSolvent | null = useMemo(() => {
    if (!platePlan) return null;
    const all = [...platePlan.recommendedSystems, ...(platePlan.otherSystems || [])];
    return all.find((x) => x.system.id === selectedSystemId) || platePlan.recommendedSystems[0] || null;
  }, [platePlan, selectedSystemId]);

  const inspectedLane: SimulatedWellLane | null = useMemo(() => {
    if (!activeSystemPlan) return null;
    return (
      activeSystemPlan.lanes[selectedLaneIdx] ||
      activeSystemPlan.lanes.find((l) => !l.isBlank) ||
      null
    );
  }, [activeSystemPlan, selectedLaneIdx]);

  if (!isOpen) return null;

  const numPlates = run?.plates || 1;
  const substratesWithSmilesCount = (state.reagents || []).filter((r) => (r.smiles || '').trim().length > 0).length;

  const handleApplyAllSystemsAsTlcTabs = () => {
    if (!platePlan || platePlan.recommendedSystems.length === 0) return;
    const planPhase = platePlan.stationaryPhase || stationaryPhasePref;
    const sysNames = platePlan.recommendedSystems.map((r) => formatTlcTabName(r.system.name, planPhase));
    setTlcSets((prev) => {
      const existingNames = new Set(prev.map((s) => s.name.trim().toLowerCase()));
      const next = [...prev];
      let startIdx = 0;
      if (
        next.length === 1 &&
        /^Set 1$/i.test(next[0].name.trim()) &&
        Object.keys(next[0].imgs || {}).length === 0
      ) {
        next[0] = { ...next[0], name: sysNames[0] };
        existingNames.add(sysNames[0].trim().toLowerCase());
        startIdx = 1;
      }
      for (let i = startIdx; i < sysNames.length; i++) {
        const name = sysNames[i];
        if (existingNames.has(name.trim().toLowerCase())) continue;
        existingNames.add(name.trim().toLowerCase());
        next.push({
          uid: 'set_' + Math.random().toString(36).slice(2, 10),
          name,
          cfg: null,
          cfgName: '',
          frameW: LANE_FRAME_WIDTH,
          frontPx: null,
          frontAuto: {},
          originPx: null,
          originAuto: {},
          imgs: {},
        });
      }
      return next;
    });
    toast(`Created ${sysNames.length} TLC plate tabs (${sysNames.join(', ')}).`);
    if (view !== 'tlc') {
      setView('tlc');
      onClose();
    }
  };

  const handleAddSubstrate = () => {
    if (!newSubstrateName.trim()) return;
    setSubstrates((prev) => [
      ...prev,
      { code: `S${prev.length + 1}`, name: newSubstrateName.trim() },
    ]);
    setNewSubstrateName('');
  };

  const handleRemoveSubstrate = (index: number) => {
    setSubstrates((prev) => prev.filter((_, i) => i !== index));
  };

  const handleGenerateSingleAi = async () => {
    if (substrates.length === 0) {
      setError('Please provide at least one starting material / substrate.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: SolventAdvisorPayload = {
        substrates,
        expectedProduct: expectedProduct.trim() || 'Target reaction product',
        reactionClass: selectedReaction,
        stationaryPhase,
      };
      const result = await fetchAiSolventSystems(payload);
      setResponse(result);
    } catch (err: any) {
      console.error('Error fetching solvent recommendations:', err);
      setError(err?.message || 'Could not generate solvent recommendations.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRecipe = (system: SolventSystemRecommendation, index: number) => {
    const text = `TLC Mobile Phase: ${system.name}\nRatio: ${system.ratio}\nChamber Prep: ${system.chamberPrep}\nModifiers: ${system.modifiers || 'None'}\nRationale: ${system.rationale}`;
    navigator.clipboard?.writeText(text);
    setCopiedIndex(index);
    toast(`Copied "${system.name}" recipe to clipboard.`);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '14px',
          width: '100%',
          maxWidth: advisorMode === 'plate54' ? '1140px' : '920px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 56px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          color: 'var(--fg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            background: 'var(--soft)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 'bold',
                fontSize: '16px',
              }}
            >
              ✦
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
                TLC Solvent System &amp; 54-Well Plate Advisor
              </h3>
              <p style={{ margin: '1px 0 0', fontSize: '12px', color: 'var(--mut)' }}>
                {advisorMode === 'plate54'
                  ? 'Selects a finite set of mobile phases across all 54 wells (prioritizing High & Medium ranked products).'
                  : 'AI single-reaction mobile phase recommender.'}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Solvent advisor mode">
              <button
                type="button"
                className={advisorMode === 'plate54' ? 'on' : ''}
                disabled={!hasPlateRun}
                onClick={() => setAdvisorMode('plate54')}
                title={hasPlateRun ? 'Optimize 2–4 eluents across all 54 plate wells' : 'Configure a plate run first'}
              >
                ▦ 54-Well Optimizer
              </button>
              <button
                type="button"
                className={advisorMode === 'singleAi' ? 'on' : ''}
                onClick={() => setAdvisorMode('singleAi')}
              >
                ✦ Single-Reaction AI
              </button>
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={onClose}
              style={{ fontSize: '14px', width: '30px', height: '30px', padding: 0 }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div
          style={{
            padding: '18px 20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {/* =============================================================== */}
          {/* MODE 1: 54-WELL FINITE ELUENT OPTIMIZER & VISUAL PLATE SIMULATOR */}
          {/* =============================================================== */}
          {advisorMode === 'plate54' && (
            <>
              {/* Controls Bar */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '10px',
                  padding: '10px 14px',
                  background: 'var(--soft)',
                  border: '1px solid var(--line2)',
                  borderRadius: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  {numPlates > 1 && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                      <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Plate</span>
                      <select
                        className="f"
                        style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                        value={plateIdx}
                        onChange={(e) => setPlateIdx(Number(e.target.value))}
                      >
                        {Array.from({ length: numPlates }, (_, p) => (
                          <option key={p} value={p}>
                            Plate {p + 1}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                    <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Finite Eluent Count</span>
                    <div className="seg">
                      {[2, 3, 4].map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={numSystems === k ? 'on' : ''}
                          onClick={() => setNumSystems(k)}
                        >
                          {k} Systems
                        </button>
                      ))}
                    </div>
                  </label>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                    <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Stationary Phase</span>
                    <select
                      className="f"
                      style={{ height: '28px', fontSize: '12px', padding: '0 8px' }}
                      value={stationaryPhasePref}
                      onChange={(e) => setStationaryPhasePref(e.target.value as TlcStationaryPhasePreference)}
                      title="Choose the TLC plate stationary phase for retention modeling and solvent selection"
                    >
                      <option value="auto">Auto (SiO₂ Primary + C18 Fallback)</option>
                      <option value="SiO2">Silica Gel (SiO₂ — Normal Phase)</option>
                      <option value="C18">Reverse Phase (C18)</option>
                      <option value="Al2O3_neutral">Neutral Alumina (Al₂O₃)</option>
                      <option value="Al2O3_basic">Basic Alumina (Al₂O₃)</option>
                    </select>
                  </label>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                    <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Preference</span>
                    <select
                      className="f"
                      disabled={stationaryPhasePref === 'C18'}
                      style={{
                        height: '28px',
                        fontSize: '12px',
                        padding: '0 8px',
                        opacity: stationaryPhasePref === 'C18' ? 0.55 : 1,
                      }}
                      value={poolMode}
                      onChange={(e) => setPoolMode(e.target.value as SolventPoolMode)}
                      title={
                        stationaryPhasePref === 'C18'
                          ? 'Reverse-phase C18 evaluates all aqueous MeCN/MeOH mobile phases'
                          : 'Prefer EtOAc/Hexanes & MeOH/DCM (±Et3N / 2M NH3-MeOH) while keeping Acetone/Hex, MeOH/EtOAc, MeOH/Toluene & C18 available'
                      }
                    >
                      <option value="prefer_primary">Prefer EtOAc/Hex &amp; MeOH/DCM (±Et₃N/NH₃)</option>
                      <option value="primary_only">Workhorses Only (EtOAc/Hex &amp; MeOH/DCM)</option>
                      <option value="balanced">All Systems Equal (incl. Acetone / Toluene)</option>
                    </select>
                  </label>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeSpeculative}
                      onChange={(e) => setIncludeSpeculative(e.target.checked)}
                    />
                    <span>Include Low/Speculative</span>
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {platePlan && platePlan.recommendedSystems.length > 0 && (
                    <button
                      type="button"
                      className="btn sm pri"
                      style={{ background: '#10b981', borderColor: '#059669' }}
                      onClick={handleApplyAllSystemsAsTlcTabs}
                      title="Create one TLC plate tab per recommended solvent system inside TLC Inspector"
                    >
                      {view !== 'tlc'
                        ? `+ Create ${platePlan.recommendedSystems.length} TLC Tabs →`
                        : `+ Create ${platePlan.recommendedSystems.length} TLC Tabs`}
                    </button>
                  )}
                </div>
              </div>

              {substratesWithSmilesCount === 0 && (
                <div className="issue warn" style={{ padding: '10px 14px', fontSize: '12.5px' }}>
                  <span>
                    None of your Setup reagents have SMILES structures yet — add SMILES on Setup or Predict so the advisor can evaluate products across all 54 wells.
                  </span>
                </div>
              )}

              {plateError && (
                <div className="issue warn" style={{ padding: '10px 14px', fontSize: '12.5px' }}>
                  <span>{plateError}</span>
                </div>
              )}

              {plateLoading && (
                <div
                  style={{
                    padding: '28px 16px',
                    textAlign: 'center',
                    background: 'var(--soft)',
                    borderRadius: '10px',
                    border: '1px solid var(--line2)',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
                    Predicting products &amp; simulating{' '}
                    {stationaryPhasePref === 'C18'
                      ? 'reverse-phase C18'
                      : stationaryPhasePref === 'Al2O3_neutral'
                      ? 'neutral alumina (Al₂O₃)'
                      : stationaryPhasePref === 'Al2O3_basic'
                      ? 'basic alumina (Al₂O₃)'
                      : 'TLC stationary-phase'}{' '}
                    retention across Plate {plateIdx + 1}…
                  </div>
                  <div className="mono" style={{ fontSize: '12px', color: 'var(--acc)' }}>
                    {plateProgress.done} / {plateProgress.total} active wells evaluated
                  </div>
                </div>
              )}

              {!plateLoading && platePlan && (
                <>
                  {/* Finite Solvent Set Selector Cards */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                      gap: '10px',
                    }}
                  >
                    {platePlan.recommendedSystems.map((rec) => {
                      const isSel = activeSystemPlan?.system.id === rec.system.id;
                      const badge = stationaryPhaseBadge(
                        rec.system.stationaryPhase,
                        platePlan.stationaryPhase || stationaryPhasePref
                      );
                      const tabName = formatTlcTabName(
                        rec.system.name,
                        platePlan.stationaryPhase || stationaryPhasePref
                      );
                      return (
                        <div
                          key={rec.system.id}
                          onClick={() => {
                            setSelectedSystemId(rec.system.id);
                            if (rec.assignedWellIndices.length > 0) {
                              setSelectedLaneIdx(rec.assignedWellIndices[0]);
                            }
                          }}
                          style={{
                            cursor: 'pointer',
                            padding: '12px 14px',
                            borderRadius: '10px',
                            background: isSel ? 'color-mix(in srgb, #10b981 9%, var(--panel))' : 'var(--panel)',
                            border: isSel ? '2px solid #10b981' : '1px solid var(--line)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            transition: 'border-color 0.15s ease',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                              <span
                                className="mono"
                                style={{
                                  fontSize: '11px',
                                  fontWeight: 700,
                                  padding: '2px 7px',
                                  borderRadius: '5px',
                                  background: isSel ? '#10b981' : 'var(--soft)',
                                  color: isSel ? '#fff' : 'var(--fg2)',
                                }}
                              >
                                #{rec.rank} · {rec.assignedWellIndices.length} wells
                              </span>
                              <span
                                className="mono"
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  padding: '2px 5px',
                                  borderRadius: '4px',
                                  background: badge.isC18
                                    ? 'color-mix(in srgb, #38bdf8 16%, transparent)'
                                    : badge.isAlumina
                                    ? 'color-mix(in srgb, #a855f7 16%, transparent)'
                                    : 'var(--soft)',
                                  color: badge.isC18 ? '#38bdf8' : badge.isAlumina ? '#c084fc' : 'var(--mut)',
                                }}
                              >
                                {badge.short}
                              </span>
                              {(rec.system.baseModifier || rec.system.acidModifier) && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    background: rec.system.baseModifier
                                      ? 'color-mix(in srgb, #38bdf8 14%, transparent)'
                                      : 'color-mix(in srgb, #f59e0b 14%, transparent)',
                                    color: rec.system.baseModifier ? '#38bdf8' : '#f59e0b',
                                  }}
                                >
                                  + {rec.system.baseModifier || rec.system.acidModifier}
                                </span>
                              )}
                            </div>
                            <span className="mono" style={{ fontSize: '11.5px', fontWeight: 700, color: '#10b981' }}>
                              {rec.wellCoveragePct}% resolved
                            </span>
                          </div>

                          <div style={{ fontSize: '15px', fontWeight: 700 }}>{rec.system.name}</div>

                          <div className="mono" style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                            20 mL: {rec.system.chamberPrep20mL}
                          </div>

                          <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                            {rec.system.bestFor}
                          </div>

                          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }} onClick={(e) => e.stopPropagation()}>
                            {onApplyToCurrentSet && (
                              <button
                                type="button"
                                className="btn sm"
                                style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                                onClick={() => {
                                  onApplyToCurrentSet(tabName);
                                  toast(`Applied "${tabName}" to active TLC tab.`);
                                }}
                              >
                                Apply to Tab
                              </button>
                            )}
                            {onCreateNewSet && (
                              <button
                                type="button"
                                className="btn sm"
                                style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                                onClick={() => {
                                  onCreateNewSet(tabName);
                                  toast(`Created TLC tab "${tabName}".`);
                                }}
                              >
                                + Tab
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Summary Coverage Bar */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                      padding: '8px 12px',
                      background: 'var(--soft)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  >
                    <div>
                      <strong>Plate {plateIdx + 1} Set Coverage:</strong>{' '}
                      <span className="mono" style={{ color: '#10b981', fontWeight: 700 }}>
                        {platePlan.resolvedWellCount} / {platePlan.activeWellCount} active wells ({platePlan.totalCoveragePct}%)
                      </span>
                      {platePlan.highRankedWellCount > 0 && (
                        <span style={{ color: 'var(--mut)', marginLeft: '8px' }}>
                          ({platePlan.highRankedWellCount} wells with High/Medium products prioritized)
                        </span>
                      )}
                    </div>
                    {platePlan.summaryNotes.length > 1 && (
                      <span style={{ color: 'var(--warn)', fontSize: '11.5px' }}>
                        {platePlan.summaryNotes.slice(1).join(' · ')}
                      </span>
                    )}
                  </div>

                  {/* Visual Simulated 54-Well TLC Plate (Upper 1-27 & Lower 28-54) */}
                  {activeSystemPlan && (
                    <div
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: '10px',
                        padding: '12px 14px',
                        background: 'var(--bg)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700 }}>
                            Simulated 54-Well TLC Plate — <span style={{ color: '#10b981' }}>{activeSystemPlan.system.name}</span>
                          </div>
                          <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                            {stationaryPhaseBadge(activeSystemPlan.system.stationaryPhase, platePlan.stationaryPhase || stationaryPhasePref).full} · 20 mL: {activeSystemPlan.system.chamberPrep20mL}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--mut)', flexWrap: 'wrap' }}>
                          <span><span style={{ color: '#10b981', fontWeight: 700 }}>●</span> High/Top Product</span>
                          <span><span style={{ color: '#38bdf8', fontWeight: 700 }}>●</span> Side Product</span>
                          <span><span style={{ color: '#f59e0b', fontWeight: 700 }}>○</span> Starting Material</span>
                          <span style={{ borderBottom: '2px solid #10b981' }}>Green column = Best eluent</span>
                          <button
                            type="button"
                            className="btn sm"
                            style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                            onClick={() => {
                              const name = formatTlcTabName(
                                activeSystemPlan.system.name,
                                platePlan.stationaryPhase || stationaryPhasePref
                              );
                              setTlcSets((prev) => {
                                if (prev.some((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase())) {
                                  return prev;
                                }
                                return [
                                  ...prev,
                                  {
                                    uid: 'set_' + Math.random().toString(36).slice(2, 10),
                                    name,
                                    cfg: null,
                                    cfgName: '',
                                    frameW: LANE_FRAME_WIDTH,
                                    frontPx: null,
                                    frontAuto: {},
                                    originPx: null,
                                    originAuto: {},
                                    imgs: {},
                                  },
                                ];
                              });
                              toast(`Added "${name}" tab to TLC Inspector.`);
                            }}
                          >
                            + Add Tab
                          </button>
                        </div>
                      </div>

                      {/* Render Plate Half 1 (Spotter Lanes 1-27: A1, B1, C1, D1, E1, F1, A2..C5) & Half 2 (Lanes 28-54: D5..F9) */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: '12px' }}>
                        {[
                          {
                            title: 'Plate Half 1 (A1–C5 · Lanes 1–27 · Column-Spotted)',
                            slice: Array.from({ length: 27 }, (_, spotIdx) => ({
                              spotIdx,
                              lane: activeSystemPlan.lanes[containerOfLane(spotIdx)],
                            })).filter((x) => Boolean(x.lane)),
                          },
                          {
                            title: 'Plate Half 2 (D5–F9 · Lanes 28–54 · Column-Spotted)',
                            slice: Array.from({ length: 27 }, (_, i) => {
                              const spotIdx = 27 + i;
                              return {
                                spotIdx,
                                lane: activeSystemPlan.lanes[containerOfLane(spotIdx)],
                              };
                            }).filter((x) => Boolean(x.lane)),
                          },
                        ].map((half, hIdx) => (
                          <div
                            key={hIdx}
                            style={{
                              background: 'var(--panel)',
                              border: '1px solid var(--line2)',
                              borderRadius: '8px',
                              padding: '8px 10px',
                            }}
                          >
                            <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)', marginBottom: '6px', fontWeight: 600 }}>
                              {half.title}
                            </div>

                            {/* 27 Vertical Lanes */}
                            <div
                              style={{
                                position: 'relative',
                                height: '160px',
                                display: 'grid',
                                gridTemplateColumns: 'repeat(27, minmax(0, 1fr))',
                                border: '1px solid var(--line2)',
                                borderRadius: '6px',
                                overflow: 'hidden',
                                background: 'var(--soft)',
                              }}
                            >
                              {/* Ideal Analytical Window Band (Rf 0.22 - 0.68) */}
                              <div
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  right: 0,
                                  top: `${(1 - 0.68) * 100}%`,
                                  height: `${(0.68 - 0.22) * 100}%`,
                                  background: 'color-mix(in srgb, #10b981 9%, transparent)',
                                  borderTop: '1px dashed color-mix(in srgb, #10b981 30%, transparent)',
                                  borderBottom: '1px dashed color-mix(in srgb, #10b981 30%, transparent)',
                                  pointerEvents: 'none',
                                }}
                              />

                              {half.slice.map(({ spotIdx, lane }) => {
                                const isSelLane = lane.wellIndex === selectedLaneIdx;
                                return (
                                  <button
                                    key={lane.wellIndex}
                                    type="button"
                                    onClick={() => !lane.isBlank && setSelectedLaneIdx(lane.wellIndex)}
                                    disabled={lane.isBlank}
                                    title={
                                      lane.isBlank
                                        ? `Lane ${spotIdx + 1} · ${lane.wellCoord} (Blank)`
                                        : `Lane ${spotIdx + 1} · ${lane.wellCoord}: Score ${Math.round(lane.resolutionScore * 100)}% · ΔRf ${lane.deltaRf.toFixed(2)}`
                                    }
                                    style={{
                                      position: 'relative',
                                      height: '100%',
                                      padding: 0,
                                      border: 'none',
                                      borderRight: '1px solid color-mix(in srgb, var(--line) 45%, transparent)',
                                      cursor: lane.isBlank ? 'default' : 'pointer',
                                      background: isSelLane
                                        ? 'color-mix(in srgb, var(--acc) 18%, transparent)'
                                        : lane.isAssignedHere
                                        ? 'color-mix(in srgb, #10b981 7%, transparent)'
                                        : 'transparent',
                                      boxShadow: isSelLane ? 'inset 0 0 0 1.5px var(--acc)' : 'none',
                                    }}
                                  >
                                    {lane.isAssignedHere && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          bottom: 0,
                                          left: 0,
                                          right: 0,
                                          height: '3px',
                                          background: '#10b981',
                                        }}
                                      />
                                    )}
                                    {!lane.isBlank &&
                                      lane.spots.slice(0, 6).map((spot, spIdx) => {
                                        const topPct = Math.max(4, Math.min(95, (1 - spot.rf) * 100));
                                        const isProd = spot.kind === 'product';
                                        const isPrimaryProd = isProd && spIdx === lane.spots.findIndex((s) => s.kind === 'product');
                                        const color = isProd
                                          ? spot.tier === 'High' || isPrimaryProd
                                            ? '#10b981'
                                            : '#38bdf8'
                                          : '#f59e0b';
                                        const size = isPrimaryProd ? 8 : isProd ? 6 : 6;
                                        return (
                                          <div
                                            key={spIdx}
                                            style={{
                                              position: 'absolute',
                                              left: '50%',
                                              top: `${topPct}%`,
                                              transform: 'translate(-50%, -50%)',
                                              width: `${size}px`,
                                              height: spot.tailing ? `${size + 7}px` : `${size}px`,
                                              borderRadius: spot.tailing ? '4px' : '50%',
                                              background: isProd ? color : 'transparent',
                                              border: isProd ? 'none' : `1.6px solid ${color}`,
                                              opacity: isProd ? (isPrimaryProd ? 1 : 0.7) : 0.9,
                                              zIndex: isPrimaryProd ? 4 : isProd ? 3 : 2,
                                            }}
                                          />
                                        );
                                      })}
                                  </button>
                                );
                              })}
                            </div>

                            {/* Lane Coordinate Labels */}
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(27, minmax(0, 1fr))',
                                marginTop: '3px',
                              }}
                            >
                              {half.slice.map(({ lane }) => (
                                <div
                                  key={lane.wellIndex}
                                  className="mono"
                                  style={{
                                    fontSize: '8px',
                                    textAlign: 'center',
                                    color:
                                      lane.wellIndex === selectedLaneIdx
                                        ? 'var(--acc)'
                                        : lane.isBlank
                                        ? 'var(--mut)'
                                        : laneScoreColor(lane.resolutionScore),
                                    fontWeight: lane.wellIndex === selectedLaneIdx || lane.isAssignedHere ? 700 : 400,
                                    opacity: lane.isBlank ? 0.35 : 1,
                                  }}
                                >
                                  {lane.wellCoord}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Clicked Well Visual Structure + Rf Inspector */}
                      {inspectedLane && !inspectedLane.isBlank && (
                        <div
                          style={{
                            borderTop: '1px solid var(--line2)',
                            paddingTop: '10px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                            <div className="mono" style={{ fontSize: '12.5px', fontWeight: 700 }}>
                              Well {inspectedLane.wellCoord} (Spotter Lane {tlcLane(inspectedLane.wellIndex) + 1}) in {activeSystemPlan.system.shortLabel} · ΔRf = {inspectedLane.deltaRf.toFixed(2)} · Separation{' '}
                              <span style={{ color: laneScoreColor(inspectedLane.resolutionScore) }}>
                                {Math.round(inspectedLane.resolutionScore * 100)}%
                              </span>
                            </div>
                            <span style={{ fontSize: '11px', color: 'var(--mut)' }}>
                              Click any lane above to inspect its spots &amp; structures
                            </span>
                          </div>

                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
                              gap: '10px',
                            }}
                          >
                            {inspectedLane.spots.slice(0, 6).map((spot, idx) => (
                              <div
                                key={idx}
                                style={{
                                  padding: '8px',
                                  borderRadius: '8px',
                                  background: 'var(--panel)',
                                  border:
                                    spot.kind === 'product'
                                      ? '1px solid color-mix(in srgb, #10b981 45%, var(--line))'
                                      : '1px solid var(--line2)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  gap: '5px',
                                }}
                              >
                                <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                                  <span
                                    className="mono"
                                    style={{
                                      fontWeight: 700,
                                      color: spot.kind === 'product' ? '#10b981' : '#f59e0b',
                                    }}
                                  >
                                    {spot.kind === 'product' ? `Prod ${spot.code}` : `SM ${spot.code}`}
                                  </span>
                                  <span className="mono" style={{ fontWeight: 700 }}>
                                    Rf {spot.rf.toFixed(2)}
                                  </span>
                                </div>
                                <ChemicalStructure smiles={spot.smiles} name={spot.label} width={155} height={102} />
                                <div style={{ fontSize: '11px', textAlign: 'center', color: 'var(--fg2)', lineHeight: 1.2 }}>
                                  {spot.kind === 'product'
                                    ? `${spot.formula}${spot.tier ? ` · ${spot.tier} (${spot.score?.toFixed(2)})` : ''}`
                                    : spot.label}
                                </div>
                                {spot.tailing && (
                                  <div style={{ fontSize: '10px', color: 'var(--warn)', textAlign: 'center' }}>
                                    {spot.tailingReason}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Other Available Complementary Systems (C18 RP, Acetone/Hexanes, MeOH/EtOAc, MeOH/Toluene, etc.) */}
                  {platePlan.otherSystems && platePlan.otherSystems.length > 0 && (
                    <div
                      style={{
                        border: '1px solid var(--line2)',
                        borderRadius: '10px',
                        padding: '10px 14px',
                        background: 'var(--soft)',
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
                        <div style={{ fontSize: '12.5px', fontWeight: 700 }}>
                          Other Available Systems (Click any to preview simulated 54-well plate)
                        </div>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                          onClick={() => setShowOtherSystems((s) => !s)}
                        >
                          {showOtherSystems ? 'Hide List' : `Show (${platePlan.otherSystems.length})`}
                        </button>
                      </div>

                      {showOtherSystems && (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))',
                            gap: '8px',
                          }}
                        >
                          {platePlan.otherSystems.map((rec) => {
                            const isSel = activeSystemPlan?.system.id === rec.system.id;
                            const badge = stationaryPhaseBadge(
                              rec.system.stationaryPhase,
                              platePlan.stationaryPhase || stationaryPhasePref
                            );
                            return (
                              <button
                                key={rec.system.id}
                                type="button"
                                onClick={() => {
                                  setSelectedSystemId(rec.system.id);
                                  const bestLane = rec.lanes
                                    .filter((l) => !l.isBlank)
                                    .sort((a, b) => b.resolutionScore - a.resolutionScore)[0];
                                  if (bestLane) setSelectedLaneIdx(bestLane.wellIndex);
                                }}
                                style={{
                                  textAlign: 'left',
                                  padding: '8px 10px',
                                  borderRadius: '8px',
                                  cursor: 'pointer',
                                  background: isSel ? 'color-mix(in srgb, var(--acc) 12%, var(--panel))' : 'var(--panel)',
                                  border: isSel ? '1.5px solid var(--acc)' : '1px solid var(--line2)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '3px',
                                  color: 'var(--fg)',
                                }}
                                title={`${rec.system.chamberPrep20mL} — ${rec.system.bestFor}`}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                                  <span style={{ fontSize: '12px', fontWeight: 700 }}>{rec.system.shortLabel}</span>
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: '10px',
                                      fontWeight: 700,
                                      color: badge.isC18 ? '#38bdf8' : badge.isAlumina ? '#c084fc' : '#10b981',
                                    }}
                                  >
                                    {badge.isC18 ? 'C18 · ' : badge.isAlumina ? `${badge.short} · ` : ''}{rec.wellCoveragePct}%
                                  </span>
                                </div>
                                <div style={{ fontSize: '10.5px', color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {rec.system.chamberPrep20mL}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* =============================================================== */}
          {/* MODE 2: SINGLE-REACTION AI SOLVENT ADVISOR (EXISTING GEMINI)    */}
          {/* =============================================================== */}
          {advisorMode === 'singleAi' && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: '14px',
                  padding: '14px',
                  background: 'var(--soft)',
                  borderRadius: '8px',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600 }}>
                    Substrates / Starting Materials ({substrates.length}):
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px',
                      minHeight: '36px',
                      padding: '6px',
                      background: 'var(--panel)',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                    }}
                  >
                    {substrates.map((sub, i) => (
                      <span
                        key={i}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: 'rgba(16, 185, 129, 0.12)',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          borderRadius: '4px',
                          padding: '2px 6px',
                          fontSize: '11px',
                        }}
                      >
                        {sub.code && <strong>{sub.code}:</strong>}
                        <span>{sub.name}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSubstrate(i)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--mut)',
                            cursor: 'pointer',
                            padding: '0 2px',
                            fontSize: '10px',
                          }}
                          title="Remove substrate"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      placeholder="Add another starting material or reagent…"
                      value={newSubstrateName}
                      onChange={(e) => setNewSubstrateName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddSubstrate()}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        fontSize: '12px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        background: 'var(--panel)',
                        color: 'var(--fg)',
                      }}
                    />
                    <button
                      type="button"
                      className="btn sm"
                      onClick={handleAddSubstrate}
                      style={{ fontSize: '11px', height: '30px' }}
                    >
                      + Add
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                      Expected / Possible Product:
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Amide product, Biaryl ester, Secondary amine…"
                      value={expectedProduct}
                      onChange={(e) => setExpectedProduct(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '6px 10px',
                        fontSize: '12px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                        background: 'var(--panel)',
                        color: 'var(--fg)',
                      }}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                        Reaction Type:
                      </label>
                      <select
                        value={selectedReaction}
                        onChange={(e) => setSelectedReaction(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '5px 8px',
                          fontSize: '11px',
                          borderRadius: '4px',
                          border: '1px solid var(--line)',
                          background: 'var(--panel)',
                          color: 'var(--fg)',
                        }}
                      >
                        {COMMON_REACTIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label style={{ fontSize: '11px', fontWeight: 600, display: 'block', marginBottom: '3px' }}>
                        Stationary Phase:
                      </label>
                      <select
                        value={stationaryPhase}
                        onChange={(e) => setStationaryPhase(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '5px 8px',
                          fontSize: '11px',
                          borderRadius: '4px',
                          border: '1px solid var(--line)',
                          background: 'var(--panel)',
                          color: 'var(--fg)',
                        }}
                      >
                        {STATIONARY_PHASES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px' }}>
                <button
                  type="button"
                  className="btn pri"
                  disabled={loading || substrates.length === 0}
                  onClick={handleGenerateSingleAi}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 18px',
                    fontSize: '12px',
                    fontWeight: 600,
                    background: '#10b981',
                    borderColor: '#059669',
                  }}
                >
                  {loading ? 'Calculating Solvent Polarities…' : '✦ Suggest TLC Solvent Systems'}
                </button>
              </div>

              {error && (
                <div
                  style={{
                    padding: '12px 14px',
                    background: 'var(--warnbg, rgba(239, 68, 68, 0.08))',
                    border: '1px solid var(--warn, #ef4444)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'var(--fg)',
                  }}
                >
                  ⚠ {error}
                </div>
              )}

              {response && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '6px' }}>
                  <div
                    style={{
                      padding: '12px 16px',
                      background: 'rgba(16, 185, 129, 0.08)',
                      border: '1px solid rgba(16, 185, 129, 0.25)',
                      borderRadius: '8px',
                      fontSize: '12px',
                      lineHeight: '1.5',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: '#10b981', marginBottom: '2px' }}>
                      Chemical Separation Strategy:
                    </div>
                    <div>{response.reactionSummary}</div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
                      gap: '12px',
                    }}
                  >
                    {response.systems.map((sys, idx) => (
                      <div
                        key={idx}
                        style={{
                          background: 'var(--panel)',
                          border: sys.isBest ? '2px solid #10b981' : '1px solid var(--line)',
                          borderRadius: '10px',
                          padding: '14px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          gap: '12px',
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px', marginBottom: '6px' }}>
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                padding: '2px 8px',
                                borderRadius: '6px',
                                background: sys.isBest ? '#10b981' : 'var(--soft)',
                                color: sys.isBest ? '#fff' : 'var(--fg)',
                                border: sys.isBest ? 'none' : '1px solid var(--line)',
                              }}
                            >
                              {sys.isBest ? '★ Best Recommended' : sys.tag || `Option ${idx + 1}`}
                            </span>
                            <span style={{ fontSize: '10px', color: 'var(--mut)', fontFamily: 'monospace' }}>
                              {sys.polarityRating}
                            </span>
                          </div>

                          <div
                            style={{
                              fontSize: '14px',
                              fontWeight: 700,
                              fontFamily: 'var(--font-mono, monospace)',
                              color: sys.isBest ? '#10b981' : 'var(--fg)',
                              marginBottom: '4px',
                            }}
                          >
                            {sys.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--mut)', fontFamily: 'monospace', marginBottom: '8px' }}>
                            {sys.ratio}
                          </div>

                          <div style={{ margin: '8px 0', padding: '8px', background: 'var(--soft)', borderRadius: '6px', border: '1px solid var(--line)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--mut)', marginBottom: '4px' }}>
                              <span>Origin</span>
                              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{sys.resolutionDelta}</span>
                              <span>Front</span>
                            </div>
                            <div
                              style={{
                                position: 'relative',
                                height: '18px',
                                background: 'rgba(255,255,255,0.06)',
                                borderRadius: '9px',
                                border: '1px solid var(--line)',
                                overflow: 'hidden',
                              }}
                            >
                              {sys.predictedRf.product !== undefined && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: `${Math.min(96, Math.max(4, sys.predictedRf.product * 100))}%`,
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: '12px',
                                    height: '12px',
                                    borderRadius: '50%',
                                    background: '#10b981',
                                    zIndex: 3,
                                  }}
                                />
                              )}
                              {sys.predictedRf.substrateA?.rf !== undefined && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: `${Math.min(96, Math.max(4, sys.predictedRf.substrateA.rf * 100))}%`,
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    background: '#38bdf8',
                                    zIndex: 2,
                                  }}
                                />
                              )}
                              {sys.predictedRf.substrateB?.rf !== undefined && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: `${Math.min(96, Math.max(4, sys.predictedRf.substrateB.rf * 100))}%`,
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    background: '#f59e0b',
                                    zIndex: 2,
                                  }}
                                />
                              )}
                            </div>
                          </div>

                          <div style={{ fontSize: '11px', padding: '6px 8px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontFamily: 'monospace', marginBottom: '6px' }}>
                            {sys.chamberPrep}
                          </div>
                          {sys.modifiers && !/^(none|none required|n\/a|-)$/i.test(sys.modifiers.trim()) && (
                            <div
                              className="mono"
                              style={{
                                fontSize: '11px',
                                padding: '4px 8px',
                                marginBottom: '6px',
                                borderRadius: '4px',
                                background: 'color-mix(in srgb, #38bdf8 10%, transparent)',
                                border: '1px solid color-mix(in srgb, #38bdf8 25%, transparent)',
                                color: '#38bdf8',
                              }}
                            >
                              Modifier in system: {sys.modifiers}
                            </div>
                          )}
                          <p style={{ fontSize: '11px', color: 'var(--mut)', lineHeight: '1.45', margin: 0 }}>
                            {sys.rationale}
                          </p>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
                          {(() => {
                            const mod = (sys.modifiers || '').trim();
                            const hasRealMod = Boolean(mod) && !/^(none|none required|n\/a|-)$/i.test(mod);
                            const fullSystemName =
                              hasRealMod && !sys.name.toLowerCase().includes(mod.toLowerCase())
                                ? `${sys.name} + ${mod}`
                                : sys.name;
                            return (
                              <>
                                {onApplyToCurrentSet && (
                                  <button
                                    type="button"
                                    className="btn sm pri"
                                    style={{ flex: 1, fontSize: '11px', height: '28px', background: sys.isBest ? '#10b981' : undefined }}
                                    onClick={() => {
                                      onApplyToCurrentSet(fullSystemName);
                                      toast(`Applied "${fullSystemName}" to current TLC Plate set.`);
                                    }}
                                  >
                                    Apply to Plate
                                  </button>
                                )}
                                {onCreateNewSet && (
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '11px', height: '28px' }}
                                    onClick={() => {
                                      onCreateNewSet(fullSystemName);
                                      toast(`Created new TLC plate set for "${fullSystemName}".`);
                                    }}
                                  >
                                    + New TLC Tab
                                  </button>
                                )}
                              </>
                            );
                          })()}
                          <button
                            type="button"
                            className="btn sm"
                            style={{ fontSize: '11px', height: '28px' }}
                            onClick={() => handleCopyRecipe(sys, idx)}
                          >
                            {copiedIndex === idx ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
