import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAiSolventSystems,
  SolventAdvisorPayload,
  SolventSuggestionResponse,
  SolventSystemRecommendation,
} from '../../services/aiService';
import { useApp } from '../../context/AppContext';
import {
  calibrateTlcModelFromCampaign,
  CalibratedLaneComparison,
  chamberPrepForNh3Stock,
  containerOfLane,
  extractLaneProfile2d,
  isKnownAdditiveReagent,
  LANE_FRAME_WIDTH,
  optimizePlateTlcSolvents,
  PlateSolventPlanResult,
  RecommendedPlateSolvent,
  RESOLVED_SCORE,
  rfShiftAtMidplate,
  SimulatedWellLane,
  SolventPoolMode,
  ALL_KNOWN_SOLVENT_SYSTEMS,
  TLC_SIGNAL,
  TlcCalibrationModel,
  TlcCalibrationSpotPair,
  TlcChannelKey,
  tlcLane,
  TlcStationaryPhasePreference,
  WellConditionConfig,
  WellPredictionResult,
} from '../../engine';
import { TlcLane, TlcSet } from '../../types';
import { getRDKitInstance } from '../../utils/rdkit';
import { ChemicalStructure } from './ChemicalStructure';

function extractLaneProfileForCalibration(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  return extractLaneProfile2d(set, key, lane, coreFraction);
}

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
  if (score >= RESOLVED_SCORE) return '#38bdf8';
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
  const { state, run, triMeta, tlcSets, setTlcSets, spotProminence, view, setView } = useApp();
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
  const [lowWeightPct, setLowWeightPct] = useState<number>(20);
  // NH3/MeOH stock on the bench. Same final chamber composition; only the 50 mL recipe changes.
  const [nh3StockM, setNh3StockM] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('rs.nh3StockM'));
      return v === 7 ? 7 : 2;
    } catch {
      return 2;
    }
  });
  const chooseNh3Stock = (m: number) => {
    setNh3StockM(m);
    try {
      localStorage.setItem('rs.nh3StockM', String(m));
    } catch {
      /* storage unavailable */
    }
  };
  const prepOf = (sys: any): string => chamberPrepForNh3Stock(sys, nh3StockM);
  const [calibrationEnabled, setCalibrationEnabled] = useState<boolean>(true);
  const [showCalibVisuals, setShowCalibVisuals] = useState<boolean>(true);
  const [setSolventOverrides, setSetSolventOverrides] = useState<Record<string, string>>({});
  const [calibrationModel, setCalibrationModel] = useState<TlcCalibrationModel | null>(null);
  const [hoveredCalibPair, setHoveredCalibPair] = useState<TlcCalibrationSpotPair | null>(null);
  const [selectedComparePlateKey, setSelectedComparePlateKey] = useState<string>('');
  const [inspectedCompWellIdx, setInspectedCompWellIdx] = useState<number | null>(null);
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
    const triAddSig = (state.tri?.adds || [])
      .map((a) => `${a.code}:${a.equiv}`)
      .join('|');
    const condSig = `${state.reactionSolvent || ''}:${state.temperatureC ?? state.eln?.temperatureC ?? 25}:${state.waterPct ?? state.eln?.waterPct ?? 2}`;
    const ovSig = conditionOverrides
      ? `${conditionOverrides.medium || ''}:${conditionOverrides.additiveName || ''}:${conditionOverrides.additiveEquiv ?? ''}:${conditionOverrides.temperatureC ?? ''}:${conditionOverrides.waterPct ?? ''}`
      : '';
    return `${run?.rows?.length || 0}::${state.mode}::${condSig}::${reagentSig}::${triAddSig}::${ovSig}::spec=${includeSpeculative}`;
  }, [run?.rows?.length, state.mode, state.reactionSolvent, state.temperatureC, state.waterPct, state.eln?.temperatureC, state.eln?.waterPct, state.reagents, state.tri?.adds, conditionOverrides, includeSpeculative]);

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

      // Pre-fit empirical calibration from any already-measured TLC plates in the campaign
      const calibFit = calibrateTlcModelFromCampaign({
        rdkit,
        state,
        run,
        triMeta,
        tlcSets: tlcSets || [],
        cachedPredictions: mergedCached,
        spotProminence,
        getProfile: (s, k, l) => extractLaneProfileForCalibration(s, k, l, 0.35),
        setSolventOverrides,
        conditionOverrides,
      });

      if (controller.signal.aborted || runSeqRef.current !== seq) return;

      for (const [key, wp] of Object.entries(calibFit.newlyComputedPredictions)) {
        mergedCached[key] = wp;
        predCacheRef.current.preds[key] = wp;
      }
      setCalibrationModel(calibFit.model);

      const plan = await optimizePlateTlcSolvents(rdkit, state, run, triMeta, {
        plateIndex: plateIdx,
        maxSystems: numSystems,
        poolMode,
        stationaryPhase: stationaryPhasePref,
        conditionOverrides,
        cachedPredictions: mergedCached,
        includeSpeculative,
        lowTierWeight: lowWeightPct / 100,
        calibration: calibrationEnabled ? calibFit.model : undefined,
        signal: controller.signal,
        onProgress: (done, total) => {
          if (runSeqRef.current === seq) {
            setPlateProgress({ done, total });
          }
        },
      });

      if (controller.signal.aborted || runSeqRef.current !== seq) return;

      // Save computed well predictions into session cache so toggling options or Calibration ON/OFF is instant
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
    tlcSets,
    spotProminence,
    setSolventOverrides,
    calibrationEnabled,
    plateIdx,
    numSystems,
    poolMode,
    stationaryPhasePref,
    conditionOverrides,
    cachedPlatePredictions,
    includeSpeculative,
    lowWeightPct,
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
    const all = [
      ...platePlan.recommendedSystems,
      ...(platePlan.otherGroups || []).flatMap((g) => g.systems),
      ...(platePlan.otherSystems || []),
    ];
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

                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
                    title="Names stay in 2 M-equivalent terms. With a 7 M stock the 50 mL recipe uses 2/7 of the volume and adds the missing MeOH, so the chamber is identical."
                  >
                    <span style={{ color: 'var(--mut)', fontWeight: 600 }}>NH₃/MeOH stock</span>
                    <select value={nh3StockM} onChange={(e) => chooseNh3Stock(Number(e.target.value))}>
                      <option value={2}>2 M</option>
                      <option value={7}>7 M</option>
                    </select>
                  </label>

                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: includeSpeculative ? 1 : 0.5 }}
                    title="How much Low-confidence products count compared with High/Medium ones when choosing eluents"
                  >
                    <span style={{ color: 'var(--mut)', fontWeight: 600 }}>Low weight</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={lowWeightPct}
                      disabled={!includeSpeculative}
                      onChange={(e) => setLowWeightPct(Number(e.target.value))}
                    />
                    <span className="mono" style={{ minWidth: '32px' }}>{lowWeightPct}%</span>
                  </label>

                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '12px',
                      cursor: 'pointer',
                      padding: '3px 8px',
                      borderRadius: '6px',
                      border: calibrationEnabled
                        ? '1px solid color-mix(in srgb, #10b981 45%, var(--line))'
                        : '1px solid var(--line)',
                      background: calibrationEnabled
                        ? 'color-mix(in srgb, #10b981 10%, var(--panel))'
                        : 'var(--panel)',
                    }}
                    title="Fit predicted Rf shift and uncertainty from already-measured TLC plates in this campaign"
                  >
                    <input
                      type="checkbox"
                      checked={calibrationEnabled}
                      onChange={(e) => setCalibrationEnabled(e.target.checked)}
                    />
                    <span style={{ fontWeight: 600 }}>Self-Calibrate from Measured TLCs</span>
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

              {/* Visual Self-Calibration Panel (parity plot, Rf shift meter, per-plate breakdown & OFF toggle) */}
              {calibrationModel &&
                (calibrationModel.plates.length > 0 || calibrationModel.unmatchedSets.length > 0) &&
                (() => {
                  const targetPhaseKey: TlcStationaryPhasePreference =
                    stationaryPhasePref === 'C18'
                      ? 'C18'
                      : stationaryPhasePref === 'Al2O3_neutral'
                      ? 'Al2O3_neutral'
                      : stationaryPhasePref === 'Al2O3_basic'
                      ? 'Al2O3_basic'
                      : 'SiO2';
                  const phaseFit = calibrationModel.byPhase[targetPhaseKey];
                  const matchedPhasePlates = calibrationModel.plates.filter(
                    (p) => p.stationaryPhase === targetPhaseKey
                  );
                  const allPairs = matchedPhasePlates.flatMap((p) => p.pairs);
                  const censTotal = (phaseFit?.frontCensoredCount ?? 0) + (phaseFit?.baselineCensoredCount ?? 0);
                  const evidenceCount = (phaseFit?.pairedSpotCount ?? 0) + censTotal;
                  const isActive = calibrationEnabled && Boolean(phaseFit && evidenceCount > 0);
                  const shiftSigned = phaseFit
                    ? `${phaseFit.midplateRfShift >= 0 ? '+' : ''}${phaseFit.midplateRfShift.toFixed(2)}`
                    : '+0.00';

                  return (
                    <div
                      style={{
                        border: isActive
                          ? '1px solid color-mix(in srgb, #10b981 40%, var(--line))'
                          : '1px solid var(--line)',
                        borderRadius: '10px',
                        background: 'var(--soft)',
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      {/* Header Strip */}
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
                          <span
                            className="mono"
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 700,
                              padding: '2px 7px',
                              borderRadius: '5px',
                              background: isActive
                                ? '#10b981'
                                : !calibrationEnabled
                                ? 'var(--panel)'
                                : 'color-mix(in srgb, #f59e0b 20%, var(--panel))',
                              color: isActive ? '#fff' : !calibrationEnabled ? 'var(--mut)' : '#f59e0b',
                              border: isActive ? 'none' : '1px solid var(--line)',
                            }}
                          >
                            {!calibrationEnabled
                              ? 'CALIBRATION OFF'
                              : isActive
                              ? `CALIBRATED (${targetPhaseKey})`
                              : 'NEEDS SOLVENT TAG'}
                          </span>

                          {!calibrationEnabled ? (
                            <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
                              Using uncalibrated theoretical Rf predictions
                              {phaseFit && evidenceCount > 0
                                ? ` (${phaseFit.pairedSpotCount} paired + ${censTotal} boundary spots available · ${shiftSigned} Rf shift)`
                                : ''}.
                            </span>
                          ) : phaseFit && evidenceCount > 0 ? (
                            <span style={{ fontSize: '12px' }}>
                              Fitted from <strong>{matchedPhasePlates.length}</strong> measured plate
                              {matchedPhasePlates.length > 1 ? 's' : ''} (
                              <span className="mono" style={{ fontWeight: 700 }}>
                                {phaseFit.pairedSpotCount} spots · {phaseFit.matchedLaneCount} lanes
                                {censTotal > 0 ? ` + ${phaseFit.frontCensoredCount ?? 0}▲/${phaseFit.baselineCensoredCount ?? 0}▼ bounds` : ''}
                              </span>
                              ) · Mid-plate Rf shift{' '}
                              <span
                                className="mono"
                                style={{
                                  fontWeight: 700,
                                  color: Math.abs(phaseFit.midplateRfShift) >= 0.02 ? '#10b981' : 'var(--fg)',
                                }}
                              >
                                {shiftSigned}
                              </span>
                              {phaseFit.demandSlope !== undefined && Math.abs(phaseFit.demandSlope - 1) >= 0.03 && (
                                <span className="mono" style={{ color: 'var(--mut)', marginLeft: '4px' }}>
                                  (spread ×{phaseFit.demandSlope.toFixed(2)})
                                </span>
                              )}
                              {phaseFit.featureWeights &&
                                Object.keys(phaseFit.featureWeights).length > 0 && (
                                  <span
                                    className="mono"
                                    style={{ color: '#10b981', marginLeft: '6px', fontWeight: 700 }}
                                    title={`Learned L2 Ridge descriptor offsets: ${Object.entries(phaseFit.featureWeights)
                                      .map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${Number(v).toFixed(3)}`)
                                      .join(', ')}`}
                                  >
                                    · Ridge 5D
                                  </span>
                                )}{' '}
                              · RMSE{' '}
                              <span className="mono" style={{ fontWeight: 700 }}>
                                ±{phaseFit.rmseBefore.toFixed(2)} → ±{phaseFit.rmseAfter.toFixed(2)}
                              </span>
                            </span>
                          ) : (
                            <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
                              Measured TLC tabs detected below — assign their mobile phase to calibrate {targetPhaseKey} predictions.
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <button
                            type="button"
                            className="btn sm"
                            style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                            onClick={() => setCalibrationEnabled((v) => !v)}
                          >
                            {calibrationEnabled ? 'Turn Calibration Off' : 'Turn Calibration On'}
                          </button>
                          {(allPairs.length > 0 || calibrationModel.unmatchedSets.length > 0) && (
                            <button
                              type="button"
                              className="btn sm"
                              style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                              onClick={() => setShowCalibVisuals((v) => !v)}
                            >
                              {showCalibVisuals ? 'Hide Fit Visuals ▲' : 'Show Fit Visuals ▾'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Unmatched Plate Solvent Assigner */}
                      {calibrationEnabled && calibrationModel.unmatchedSets.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '8px',
                            alignItems: 'center',
                            padding: '6px 10px',
                            borderRadius: '6px',
                            background: 'color-mix(in srgb, #f59e0b 10%, var(--panel))',
                            border: '1px solid color-mix(in srgb, #f59e0b 35%, var(--line))',
                            fontSize: '11.5px',
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>Unrecognized TLC tab:</span>
                          {calibrationModel.unmatchedSets.map((u) => (
                            <label
                              key={u.key}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                            >
                              <span>
                                “{u.name}” (Plate {u.plateIndex + 1}, {u.laneCountWithSpots} lanes):
                              </span>
                              <select
                                className="f"
                                style={{ height: '24px', fontSize: '11px', padding: '0 6px' }}
                                value={setSolventOverrides[u.key] || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setSetSolventOverrides((prev) => ({
                                    ...prev,
                                    [u.key]: val,
                                  }));
                                }}
                              >
                                <option value="">Select solvent ran on this plate…</option>
                                {ALL_KNOWN_SOLVENT_SYSTEMS.map((sys) => (
                                  <option key={sys.id} value={sys.id}>
                                    {sys.name}
                                  </option>
                                ))}
                                <option value="ignore">Ignore this plate</option>
                              </select>
                            </label>
                          ))}
                        </div>
                      )}

                      {/* Expanded Visual Calibration Diagnostics */}
                      {showCalibVisuals && phaseFit && allPairs.length > 0 && (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(270px, 310px) 1fr',
                            gap: '14px',
                            alignItems: 'stretch',
                            opacity: calibrationEnabled ? 1 : 0.55,
                          }}
                        >
                          {/* 1. Parity Plot: Predicted Rf (Before & After) vs Measured Rf */}
                          <div
                            style={{
                              background: 'var(--panel)',
                              border: '1px solid var(--line2)',
                              borderRadius: '8px',
                              padding: '8px 10px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                              <strong>Measured vs Predicted Rf</strong>
                              <span style={{ color: 'var(--mut)', fontSize: '10px' }}>
                                ○ Raw → ● Calibrated
                              </span>
                            </div>

                            {(() => {
                              const W = 270;
                              const H = 200;
                              const padL = 28;
                              const padR = 10;
                              const padT = 10;
                              const padB = 24;
                              const pw = W - padL - padR;
                              const ph = H - padT - padB;
                              const xOf = (rf: number) => padL + Math.max(0, Math.min(1, rf)) * pw;
                              const yOf = (rf: number) => padT + (1 - Math.max(0, Math.min(1, rf))) * ph;
                              const sigBand = phaseFit.calibratedSigma || 0.12;
                              // Shaded +-sigma band polygon inside [0, 1]^2
                              const polyPts = [
                                `${xOf(0)},${yOf(Math.min(1, sigBand))}`,
                                `${xOf(Math.max(0, 1 - sigBand))},${yOf(1)}`,
                                `${xOf(1)},${yOf(1)}`,
                                `${xOf(1)},${yOf(Math.max(0, 1 - sigBand))}`,
                                `${xOf(Math.min(1, sigBand))},${yOf(0)}`,
                                `${xOf(0)},${yOf(0)}`,
                              ].join(' ');

                              return (
                                <svg
                                  viewBox={`0 0 ${W} ${H}`}
                                  style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
                                >
                                  {/* +/- sigma uncertainty band */}
                                  <polygon points={polyPts} fill="rgba(16, 185, 129, 0.09)" />

                                  {/* Grid & ticks */}
                                  {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                                    <g key={t}>
                                      <line
                                        x1={xOf(t)}
                                        y1={padT}
                                        x2={xOf(t)}
                                        y2={padT + ph}
                                        stroke="var(--line2)"
                                        strokeWidth={0.7}
                                      />
                                      <line
                                        x1={padL}
                                        y1={yOf(t)}
                                        x2={padL + pw}
                                        y2={yOf(t)}
                                        stroke="var(--line2)"
                                        strokeWidth={0.7}
                                      />
                                      <text
                                        x={xOf(t)}
                                        y={padT + ph + 11}
                                        textAnchor="middle"
                                        fontSize="8.5"
                                        fill="var(--mut)"
                                      >
                                        {t.toFixed(2)}
                                      </text>
                                      <text
                                        x={padL - 4}
                                        y={yOf(t) + 3}
                                        textAnchor="end"
                                        fontSize="8.5"
                                        fill="var(--mut)"
                                      >
                                        {t.toFixed(2)}
                                      </text>
                                    </g>
                                  ))}

                                  {/* Plot border */}
                                  <rect
                                    x={padL}
                                    y={padT}
                                    width={pw}
                                    height={ph}
                                    fill="none"
                                    stroke="var(--line)"
                                    strokeWidth={1}
                                  />

                                  {/* Ideal y = x diagonal */}
                                  <line
                                    x1={xOf(0)}
                                    y1={yOf(0)}
                                    x2={xOf(1)}
                                    y2={yOf(1)}
                                    stroke="var(--mut)"
                                    strokeWidth={1}
                                    strokeDasharray="4 3"
                                  />

                                  {/* Before -> After horizontal shift lines & points */}
                                  {allPairs.slice(0, 500).map((pair, idx) => {
                                    const xB = xOf(pair.predictedRfBefore);
                                    const xA = xOf(pair.predictedRfAfter);
                                    const yO = yOf(pair.observedRf);
                                    const withinBand = Math.abs(pair.observedRf - pair.predictedRfAfter) <= sigBand;
                                    const dotColor = withinBand ? '#10b981' : '#f59e0b';
                                    const isHov = hoveredCalibPair === pair;
                                    return (
                                      <g
                                        key={idx}
                                        onMouseEnter={() => setHoveredCalibPair(pair)}
                                        onMouseLeave={() => setHoveredCalibPair((cur) => (cur === pair ? null : cur))}
                                        style={{ cursor: 'pointer' }}
                                      >
                                        {Math.abs(xA - xB) >= 1.5 && (
                                          <line
                                            x1={xB}
                                            y1={yO}
                                            x2={xA}
                                            y2={yO}
                                            stroke="rgba(16, 185, 129, 0.45)"
                                            strokeWidth={1.1}
                                          />
                                        )}
                                        <circle
                                          cx={xB}
                                          cy={yO}
                                          r={2.4}
                                          fill="none"
                                          stroke="var(--mut)"
                                          strokeWidth={1}
                                          opacity={0.75}
                                        />
                                        <circle
                                          cx={xA}
                                          cy={yO}
                                          r={isHov ? 4.4 : 3.0}
                                          fill={dotColor}
                                          stroke={isHov ? '#fff' : 'none'}
                                          strokeWidth={1}
                                          opacity={0.9}
                                        />
                                      </g>
                                    );
                                  })}

                                  <text
                                    x={padL + pw / 2}
                                    y={H - 2}
                                    textAnchor="middle"
                                    fontSize="9"
                                    fill="var(--mut)"
                                  >
                                    Predicted Rf
                                  </text>
                                </svg>
                              );
                            })()}

                            <div className="mono" style={{ fontSize: '10px', color: 'var(--fg2)', minHeight: '14px' }}>
                              {hoveredCalibPair
                                ? `${hoveredCalibPair.wellCoord} (${hoveredCalibPair.speciesKind === 'product' ? 'Prod' : 'SM'}): Obs ${hoveredCalibPair.observedRf.toFixed(2)} | Raw ${hoveredCalibPair.predictedRfBefore.toFixed(2)} → Cal ${hoveredCalibPair.predictedRfAfter.toFixed(2)}`
                                : 'Hover any point to inspect well, measured Rf & shift'}
                            </div>
                          </div>

                          {/* 2. Shift Meter, Family Offsets & Plate Breakdown */}
                          <div
                            style={{
                              background: 'var(--panel)',
                              border: '1px solid var(--line2)',
                              borderRadius: '8px',
                              padding: '10px 12px',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'space-between',
                              gap: '10px',
                            }}
                          >
                            {/* Global Shift Gauge */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' }}>
                                <strong>Global Plate Calibration Shift</strong>
                                <span className="mono" style={{ fontWeight: 700, color: '#10b981' }}>
                                  {shiftSigned} Rf at mid-plate (Δdemand {phaseFit.globalDemandShift >= 0 ? '+' : ''}
                                  {phaseFit.globalDemandShift.toFixed(3)})
                                </span>
                              </div>
                              {(() => {
                                const maxRange = 0.22;
                                const pct = Math.max(-1, Math.min(1, phaseFit.midplateRfShift / maxRange));
                                const leftPct = pct < 0 ? 50 + pct * 50 : 50;
                                const widthPct = Math.abs(pct) * 50;
                                return (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                    <div
                                      style={{
                                        position: 'relative',
                                        height: '12px',
                                        borderRadius: '6px',
                                        background: 'var(--soft)',
                                        border: '1px solid var(--line2)',
                                        overflow: 'hidden',
                                      }}
                                    >
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: '50%',
                                          top: 0,
                                          bottom: 0,
                                          width: '1.5px',
                                          background: 'var(--mut)',
                                          zIndex: 2,
                                        }}
                                      />
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: `${leftPct}%`,
                                          width: `${Math.max(2, widthPct)}%`,
                                          top: '1px',
                                          bottom: '1px',
                                          borderRadius: '4px',
                                          background: pct >= 0 ? '#10b981' : '#38bdf8',
                                        }}
                                      />
                                    </div>
                                    <div
                                      className="mono"
                                      style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        fontSize: '9.5px',
                                        color: 'var(--mut)',
                                      }}
                                    >
                                      <span>-0.22 Rf (more retained)</span>
                                      <span>0 (raw model)</span>
                                      <span>+0.22 Rf (elutes higher)</span>
                                    </div>
                                  </div>
                                );
                              })()}
                              <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                                {Math.abs(phaseFit.midplateRfShift) < 0.015
                                  ? 'Measured plates closely match baseline predictions.'
                                  : phaseFit.midplateRfShift > 0
                                  ? 'Measured spots ran higher Rf than raw model — recommendations shifted up to stay in 0.22–0.68 window.'
                                  : 'Measured spots ran lower Rf than raw model — stronger eluent ratios favored automatically.'}
                              </div>
                            </div>

                            {/* RMSE & Uncertainty + Family Offsets */}
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                                gap: '8px',
                              }}
                            >
                              <div
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  background: 'var(--soft)',
                                  border: '1px solid var(--line2)',
                                  fontSize: '11px',
                                }}
                              >
                                <div style={{ color: 'var(--mut)', fontSize: '10px' }}>Rf Fit Error (RMSE)</div>
                                <div className="mono" style={{ fontWeight: 700, marginTop: '2px' }}>
                                  ±{phaseFit.rmseBefore.toFixed(2)} →{' '}
                                  <span style={{ color: phaseFit.rmseAfter <= phaseFit.rmseBefore ? '#10b981' : '#f59e0b' }}>
                                    ±{phaseFit.rmseAfter.toFixed(2)} Rf
                                  </span>
                                </div>
                                <div style={{ color: 'var(--mut)', fontSize: '10px', marginTop: '3px' }}>
                                  {phaseFit.validated && phaseFit.cvRmse !== undefined
                                    ? `Held-out compounds: ±${phaseFit.cvRmse.toFixed(2)} vs ±${(phaseFit.cvRmseBaseline ?? 0).toFixed(2)} uncalibrated`
                                    : 'Not validated: too few distinct compounds'}
                                  {phaseFit.plateCvRmse !== undefined
                                    ? ` · Held-out plates: ±${phaseFit.plateCvRmse.toFixed(2)}${phaseFit.plateCvRmseBaseline !== undefined ? ` vs ±${phaseFit.plateCvRmseBaseline.toFixed(2)}` : ''}`
                                    : ''}
                                  {' · '}
                                  {phaseFit.uniqueCompounds ?? '?'} distinct compounds
                                  {phaseFit.calibrationApplied === false ? ' · correction switched off (no held-out gain)' : ''}
                                </div>
                              </div>
                              <div
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  background: 'var(--soft)',
                                  border: '1px solid var(--line2)',
                                  fontSize: '11px',
                                }}
                              >
                                <div style={{ color: 'var(--mut)', fontSize: '10px' }}>Separation Uncertainty (σ)</div>
                                <div className="mono" style={{ fontWeight: 700, marginTop: '2px' }}>
                                  ±0.12 → <span style={{ color: '#38bdf8' }}>±{phaseFit.calibratedSigma.toFixed(2)} Rf</span>
                                </div>
                              </div>
                              {(Object.keys(phaseFit.familyDemandShifts).length > 0 ||
                                (phaseFit.familyStats && Object.keys(phaseFit.familyStats).length > 0)) && (
                                <div
                                  style={{
                                    padding: '6px 8px',
                                    borderRadius: '6px',
                                    background: 'var(--soft)',
                                    border: '1px solid var(--line2)',
                                    fontSize: '11px',
                                  }}
                                >
                                  <div style={{ color: 'var(--mut)', fontSize: '10px' }}>Solvent-Family Performance</div>
                                  <div className="mono" style={{ fontWeight: 700, marginTop: '2px', fontSize: '10.5px' }}>
                                    {phaseFit.familyStats && Object.keys(phaseFit.familyStats).length > 0
                                      ? Object.entries(phaseFit.familyStats)
                                          .map(([fam, st]) => {
                                            const d = phaseFit.familyDemandShifts[fam as keyof typeof phaseFit.familyDemandShifts];
                                            const rfD = d !== undefined ? rfShiftAtMidplate(d, targetPhaseKey === 'C18') : null;
                                            const shiftStr = rfD !== null ? ` (${rfD >= 0 ? '+' : ''}${rfD.toFixed(2)})` : '';
                                            return `${fam}: ±${(st?.rmseAfter ?? 0).toFixed(2)} [n=${st?.pairedCount ?? 0}]${shiftStr}`;
                                          })
                                          .join(', ')
                                      : Object.entries(phaseFit.familyDemandShifts)
                                          .map(([fam, d]) => {
                                            const rfD = rfShiftAtMidplate(d || 0, targetPhaseKey === 'C18');
                                            return `${fam}: ${rfD >= 0 ? '+' : ''}${rfD.toFixed(2)}`;
                                          })
                                          .join(', ')}
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Contributing Measured Plates */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ fontSize: '11px', fontWeight: 700 }}>
                                Measured Plates Used ({matchedPhasePlates.length}):
                              </div>
                              {matchedPhasePlates.map((mp) => {
                                const overrideKey = `${mp.setUid}:${mp.plateIndex}`;
                                return (
                                  <div
                                    key={overrideKey}
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '8px',
                                      flexWrap: 'nowrap',
                                      padding: '4px 8px',
                                      borderRadius: '6px',
                                      background: 'var(--soft)',
                                      fontSize: '11px',
                                    }}
                                  >
                                    <div style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      <strong>{mp.setName}</strong>{' '}
                                      <span style={{ color: 'var(--mut)' }}>
                                        (Plate {mp.plateIndex + 1} · {mp.pairedCount} pairs · bias{' '}
                                        <span className="mono">
                                          {mp.meanRfResidual >= 0 ? '+' : ''}
                                          {mp.meanRfResidual.toFixed(2)} Rf
                                        </span>
                                        )
                                      </span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                                      <select
                                        className="f"
                                        style={{ height: '22px', fontSize: '10.5px', padding: '0 6px', maxWidth: '175px' }}
                                        value={setSolventOverrides[overrideKey] || mp.matchedSystemId}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setSetSolventOverrides((prev) => {
                                            const next = { ...prev };
                                            if (
                                              val === mp.matchedSystemId &&
                                              !ALL_KNOWN_SOLVENT_SYSTEMS.some((s) => s.id === val)
                                            ) {
                                              delete next[overrideKey];
                                            } else {
                                              next[overrideKey] = val;
                                            }
                                            return next;
                                          });
                                        }}
                                        title="Override matched solvent system for this measured TLC plate"
                                      >
                                        {!ALL_KNOWN_SOLVENT_SYSTEMS.some((s) => s.id === mp.matchedSystemId) && (
                                          <option value={mp.matchedSystemId}>
                                            {mp.matchedSystem?.shortLabel || mp.matchedSystemName}
                                          </option>
                                        )}
                                        {ALL_KNOWN_SOLVENT_SYSTEMS.map((sys) => (
                                          <option key={sys.id} value={sys.id}>
                                            {sys.shortLabel}
                                          </option>
                                        ))}
                                        <option value="ignore">Exclude from calibration</option>
                                      </select>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Measured vs Predicted 54-Well Plate Overlay: What Was Found vs Missing vs Unexpected */}
                      {showCalibVisuals &&
                        phaseFit &&
                        matchedPhasePlates.length > 0 &&
                        (() => {
                          const activeCompPlate =
                            matchedPhasePlates.find((mp) => `${mp.setUid}:${mp.plateIndex}` === selectedComparePlateKey) ||
                            matchedPhasePlates[0];
                          if (!activeCompPlate || !activeCompPlate.lanes || activeCompPlate.lanes.length === 0) {
                            return null;
                          }
                          const plateKey = `${activeCompPlate.setUid}:${activeCompPlate.plateIndex}`;

                          let foundProdCount = 0;
                          let foundSmCount = 0;
                          let frontSatCount = 0;
                          let basePinCount = 0;
                          let missingProdCount = 0;
                          let consumedSmCount = 0;
                          let extraSpotCount = 0;
                          for (const lane of activeCompPlate.lanes) {
                            if (lane.isBlank) continue;
                            for (const p of lane.predictedSpots) {
                              if (p.boundaryStatus === 'front_saturated') {
                                frontSatCount++;
                              } else if (p.boundaryStatus === 'baseline_pinned') {
                                basePinCount++;
                              } else if (p.kind === 'product') {
                                if (p.found) foundProdCount++;
                                else missingProdCount++;
                              } else {
                                if (p.found) foundSmCount++;
                                else consumedSmCount++;
                              }
                            }
                            for (const m of lane.measuredSpots) {
                              if (!m.matchedLabel) extraSpotCount++;
                            }
                          }

                          const activeWells = activeCompPlate.lanes.filter((l) => !l.isBlank);
                          const fallbackWell =
                            activeWells.find(
                              (l) =>
                                l.predictedSpots.some((p) => p.found || p.boundaryStatus === 'front_saturated' || p.boundaryStatus === 'baseline_pinned') ||
                                l.predictedSpots.some((p) => !p.found) ||
                                l.measuredSpots.length > 0
                            ) || activeWells[0];
                          const resolvedCompWellIdx =
                            inspectedCompWellIdx !== null &&
                            activeCompPlate.lanes[inspectedCompWellIdx] &&
                            !activeCompPlate.lanes[inspectedCompWellIdx].isBlank
                              ? inspectedCompWellIdx
                              : fallbackWell?.wellIndex ?? 0;
                          const inspectedCompLane: CalibratedLaneComparison | undefined =
                            activeCompPlate.lanes[resolvedCompWellIdx];

                          return (
                            <div
                              style={{
                                background: 'var(--panel)',
                                border: '1px solid var(--line2)',
                                borderRadius: '8px',
                                padding: '10px 12px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '10px',
                                opacity: calibrationEnabled ? 1 : 0.72,
                              }}
                            >
                              {/* Title, Plate Selector Tabs & Legend */}
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                  gap: '8px',
                                }}
                              >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                  <div style={{ fontSize: '12px', fontWeight: 700 }}>
                                    Measured vs Predicted Plate Map — What Was Found vs Boundary vs Missing
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                                    Solid spots show resolved TLC bands; triangles (▲/▼) flag solvent-front or origin-pinned saturation; dashed rings show predicted spots not seen.
                                  </div>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '10.5px' }}>
                                  <span title="Predicted Product matched to a measured spot on the TLC plate">
                                    <span style={{ color: '#10b981', fontWeight: 700 }}>●</span> Found Prod ({foundProdCount})
                                  </span>
                                  <span title="Remaining Starting Material matched on the TLC plate">
                                    <span style={{ color: '#f59e0b', fontWeight: 700 }}>●</span> Found SM ({foundSmCount})
                                  </span>
                                  <span title="Predicted fast spot matched excess solvent-front absorption/bleed (Rf ≥ 0.92) rather than disappearing">
                                    <span style={{ color: '#38bdf8', fontWeight: 700 }}>▲</span> Front-Sat ({frontSatCount})
                                  </span>
                                  <span title="Predicted polar spot matched residual origin/baseline deposit (Rf ≤ 0.05)">
                                    <span style={{ color: '#fb7185', fontWeight: 700 }}>▼</span> Base-Pin ({basePinCount})
                                  </span>
                                  <span title="Candidate predicted products (may not have formed) or starting materials (consumed / baseline-pinned) with no matching TLC spot within ±0.24 Rf">
                                    <span style={{ color: '#10b981', fontWeight: 700 }}>◌</span> Not seen ({missingProdCount}P / {consumedSmCount}SM)
                                  </span>
                                  <span title="Measured TLC spot with no predicted SM or High/Med candidate product within ±0.24 Rf">
                                    <span style={{ color: '#c084fc', fontWeight: 700 }}>◆</span> Unmatched ({extraSpotCount})
                                  </span>
                                </div>
                              </div>

                              {/* Measured Plate Switcher */}
                              {matchedPhasePlates.length > 1 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 600 }}>Inspect Plate:</span>
                                  {matchedPhasePlates.map((mp) => {
                                    const k = `${mp.setUid}:${mp.plateIndex}`;
                                    const isSel = k === plateKey;
                                    let pFound = 0;
                                    let pFront = 0;
                                    let pMiss = 0;
                                    let pExtra = 0;
                                    for (const l of mp.lanes || []) {
                                      if (l.isBlank) continue;
                                      for (const pr of l.predictedSpots) {
                                        if (pr.boundaryStatus === 'front_saturated') pFront++;
                                        else if (pr.kind === 'product') {
                                          if (pr.found) pFound++;
                                          else pMiss++;
                                        }
                                      }
                                      for (const ms of l.measuredSpots) {
                                        if (!ms.matchedLabel) pExtra++;
                                      }
                                    }
                                    return (
                                      <button
                                        key={k}
                                        type="button"
                                        onClick={() => setSelectedComparePlateKey(k)}
                                        style={{
                                          cursor: 'pointer',
                                          padding: '4px 9px',
                                          borderRadius: '6px',
                                          fontSize: '11px',
                                          fontWeight: isSel ? 700 : 500,
                                          border: isSel ? '1.5px solid #10b981' : '1px solid var(--line)',
                                          background: isSel ? 'color-mix(in srgb, #10b981 12%, var(--soft))' : 'var(--soft)',
                                          color: 'var(--fg)',
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: '6px',
                                        }}
                                      >
                                        <span>{mp.setName}</span>
                                        <span className="mono" style={{ fontSize: '10px', color: 'var(--mut)' }}>
                                          ({pFound}✓{pFront > 0 ? ` / ${pFront}▲` : ''} / {pMiss}◌ / {pExtra}◆)
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {/* 2x27 Column-Spotted Measured vs Predicted Plate Halves */}
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '10px' }}>
                                {[
                                  {
                                    title: 'Plate Half 1 (A1–C5 · Lanes 1–27)',
                                    slice: Array.from({ length: 27 }, (_, spotIdx) => ({
                                      spotIdx,
                                      lane: activeCompPlate.lanes[containerOfLane(spotIdx)],
                                    })).filter((x) => Boolean(x.lane)),
                                  },
                                  {
                                    title: 'Plate Half 2 (D5–F9 · Lanes 28–54)',
                                    slice: Array.from({ length: 27 }, (_, i) => {
                                      const spotIdx = 27 + i;
                                      return {
                                        spotIdx,
                                        lane: activeCompPlate.lanes[containerOfLane(spotIdx)],
                                      };
                                    }).filter((x) => Boolean(x.lane)),
                                  },
                                ].map((half, hIdx) => (
                                  <div
                                    key={hIdx}
                                    style={{
                                      background: 'var(--soft)',
                                      border: '1px solid var(--line2)',
                                      borderRadius: '7px',
                                      padding: '7px 9px',
                                    }}
                                  >
                                    <div className="mono" style={{ fontSize: '10.5px', color: 'var(--mut)', marginBottom: '5px', fontWeight: 600 }}>
                                      {half.title}
                                    </div>
                                    <div
                                      style={{
                                        position: 'relative',
                                        height: '138px',
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(27, minmax(0, 1fr))',
                                        border: '1px solid var(--line2)',
                                        borderRadius: '5px',
                                        overflow: 'hidden',
                                        background: 'var(--panel)',
                                      }}
                                    >
                                      {/* Reference mid-plate zone 0.22 - 0.68 */}
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: 0,
                                          right: 0,
                                          top: `${(1 - 0.68) * 100}%`,
                                          height: `${(0.68 - 0.22) * 100}%`,
                                          background: 'color-mix(in srgb, #10b981 6%, transparent)',
                                          borderTop: '1px dashed color-mix(in srgb, var(--line) 55%, transparent)',
                                          borderBottom: '1px dashed color-mix(in srgb, var(--line) 55%, transparent)',
                                          pointerEvents: 'none',
                                        }}
                                      />

                                      {half.slice.map(({ spotIdx, lane }) => {
                                        const isSelLane = lane.wellIndex === resolvedCompWellIdx;
                                        const hasFoundProd = lane.predictedSpots.some((p) => p.kind === 'product' && p.found);
                                        const hasMissingProd = lane.predictedSpots.some((p) => p.kind === 'product' && !p.found);
                                        const hasExtra = lane.measuredSpots.some((m) => !m.matchedLabel);

                                        const nFound = lane.predictedSpots.filter(
                                          (p) =>
                                            p.found &&
                                            p.boundaryStatus !== 'front_saturated' &&
                                            p.boundaryStatus !== 'baseline_pinned'
                                        ).length;
                                        const nBoundary = lane.predictedSpots.filter(
                                          (p) =>
                                            p.boundaryStatus === 'front_saturated' ||
                                            p.boundaryStatus === 'baseline_pinned'
                                        ).length;
                                        const nSmNotSeen = lane.predictedSpots.filter(
                                          (p) =>
                                            !p.found &&
                                            p.kind === 'substrate' &&
                                            p.boundaryStatus !== 'front_saturated' &&
                                            p.boundaryStatus !== 'baseline_pinned'
                                        ).length;
                                        const nProdNotSeen = lane.predictedSpots.filter(
                                          (p) =>
                                            !p.found &&
                                            p.kind === 'product' &&
                                            p.boundaryStatus !== 'front_saturated' &&
                                            p.boundaryStatus !== 'baseline_pinned'
                                        ).length;
                                        const nExtra = lane.measuredSpots.filter((m) => !m.matchedLabel).length;
                                        const tipParts: string[] = [`${nFound} matched`];
                                        if (nBoundary > 0) tipParts.push(`${nBoundary} at front/base`);
                                        if (nSmNotSeen > 0) tipParts.push(`${nSmNotSeen} SM not seen`);
                                        if (nProdNotSeen > 0) tipParts.push(`${nProdNotSeen} cand. prod not seen`);
                                        tipParts.push(`${nExtra} unmatched TLC spot(s)`);

                                        return (
                                          <button
                                            key={lane.wellIndex}
                                            type="button"
                                            disabled={lane.isBlank}
                                            onClick={() => !lane.isBlank && setInspectedCompWellIdx(lane.wellIndex)}
                                            title={
                                              lane.isBlank
                                                ? `Lane ${spotIdx + 1} · ${lane.wellCoord} (Blank / No Well)`
                                                : `Lane ${spotIdx + 1} · ${lane.wellCoord}: ${tipParts.join(' · ')} (click to inspect)`
                                            }
                                            style={{
                                              position: 'relative',
                                              height: '100%',
                                              padding: 0,
                                              border: 'none',
                                              borderRight: '1px solid color-mix(in srgb, var(--line) 42%, transparent)',
                                              cursor: lane.isBlank ? 'default' : 'pointer',
                                              background: isSelLane
                                                ? 'color-mix(in srgb, var(--acc) 18%, transparent)'
                                                : hasFoundProd
                                                ? 'color-mix(in srgb, #10b981 6%, transparent)'
                                                : 'transparent',
                                              boxShadow: isSelLane ? 'inset 0 0 0 1.5px var(--acc)' : 'none',
                                            }}
                                          >
                                            {!lane.isBlank && (
                                              <>
                                                {/* Connector between matched obs Rf and predicted Rf if >= 0.03 apart */}
                                                {lane.measuredSpots.map((m, mi) => {
                                                  if (m.matchedPredRfAfter === undefined) return null;
                                                  const predRf = calibrationEnabled ? m.matchedPredRfAfter : (m.matchedPredRfBefore ?? m.matchedPredRfAfter);
                                                  if (Math.abs(m.rf - predRf) < 0.03) return null;
                                                  const y1 = Math.max(4, Math.min(95, (1 - m.rf) * 100));
                                                  const y2 = Math.max(4, Math.min(95, (1 - predRf) * 100));
                                                  const top = Math.min(y1, y2);
                                                  const height = Math.max(2, Math.abs(y1 - y2));
                                                  return (
                                                    <div
                                                      key={`conn-${mi}`}
                                                      style={{
                                                        position: 'absolute',
                                                        left: '50%',
                                                        top: `${top}%`,
                                                        height: `${height}%`,
                                                        width: '1px',
                                                        transform: 'translateX(-50%)',
                                                        borderLeft: '1px dotted rgba(148, 163, 184, 0.7)',
                                                        zIndex: 1,
                                                      }}
                                                    />
                                                  );
                                                })}

                                                {/* BOUNDARY SATURATION MARKERS: Front-Saturated (▲) & Baseline-Pinned (▼) */}
                                                {lane.predictedSpots
                                                  .filter((p) => p.boundaryStatus === 'front_saturated')
                                                  .slice(0, 3)
                                                  .map((_p, bi) => (
                                                    <div
                                                      key={`fsat-${bi}`}
                                                      style={{
                                                        position: 'absolute',
                                                        left: '50%',
                                                        top: '5%',
                                                        transform: 'translate(-50%, -50%)',
                                                        width: 0,
                                                        height: 0,
                                                        borderLeft: '4px solid transparent',
                                                        borderRight: '4px solid transparent',
                                                        borderBottom: '7px solid #38bdf8',
                                                        zIndex: 4,
                                                      }}
                                                    />
                                                  ))}
                                                {lane.predictedSpots
                                                  .filter((p) => p.boundaryStatus === 'baseline_pinned')
                                                  .slice(0, 3)
                                                  .map((_p, bi) => (
                                                    <div
                                                      key={`bpin-${bi}`}
                                                      style={{
                                                        position: 'absolute',
                                                        left: '50%',
                                                        top: '94%',
                                                        transform: 'translate(-50%, -50%)',
                                                        width: 0,
                                                        height: 0,
                                                        borderLeft: '4px solid transparent',
                                                        borderRight: '4px solid transparent',
                                                        borderTop: '7px solid #fb7185',
                                                        zIndex: 4,
                                                      }}
                                                    />
                                                  ))}

                                                {/* Predicted but NOT FOUND & NOT BOUNDARY SATURATED (dashed hollow rings) */}
                                                {lane.predictedSpots
                                                  .filter(
                                                    (p) =>
                                                      !p.found &&
                                                      p.boundaryStatus !== 'front_saturated' &&
                                                      p.boundaryStatus !== 'baseline_pinned'
                                                  )
                                                  .slice(0, 8)
                                                  .map((p, pi) => {
                                                    const rfVal = calibrationEnabled ? p.rfAfter : p.rfBefore;
                                                    const topPct = Math.max(5, Math.min(95, (1 - rfVal) * 100));
                                                    const col = p.kind === 'product' ? '#10b981' : '#f59e0b';
                                                    return (
                                                      <div
                                                        key={`miss-${pi}`}
                                                        style={{
                                                          position: 'absolute',
                                                          left: '50%',
                                                          top: `${topPct}%`,
                                                          transform: 'translate(-50%, -50%)',
                                                          width: p.kind === 'product' ? '8px' : '7px',
                                                          height: p.kind === 'product' ? '8px' : '7px',
                                                          borderRadius: '50%',
                                                          background: 'transparent',
                                                          border: `1.5px dashed ${col}`,
                                                          opacity: 0.78,
                                                          zIndex: 2,
                                                        }}
                                                      />
                                                    );
                                                  })}

                                                {/* EXTRA / UNPREDICTED MEASURED SPOTS (purple diamonds) */}
                                                {lane.measuredSpots
                                                  .filter((m) => !m.matchedLabel)
                                                  .slice(0, 6)
                                                  .map((m, mi) => {
                                                    const topPct = Math.max(5, Math.min(95, (1 - m.rf) * 100));
                                                    return (
                                                      <div
                                                        key={`ext-${mi}`}
                                                        style={{
                                                          position: 'absolute',
                                                          left: '50%',
                                                          top: `${topPct}%`,
                                                          transform: 'translate(-50%, -50%) rotate(45deg)',
                                                          width: '6px',
                                                          height: '6px',
                                                          borderRadius: '1px',
                                                          background: '#c084fc',
                                                          border: '1px solid var(--panel)',
                                                          opacity: 0.92,
                                                          zIndex: 3,
                                                        }}
                                                      />
                                                    );
                                                  })}

                                                {/* CONFIRMED / FOUND MEASURED SPOTS (solid green/amber dots; boundary peaks render as ▲/▼ triangles) */}
                                                {lane.measuredSpots
                                                  .filter((m) => Boolean(m.matchedLabel) && m.rf > 0.05 && m.rf < 0.92)
                                                  .slice(0, 6)
                                                  .map((m, mi) => {
                                                    const topPct = Math.max(5, Math.min(95, (1 - m.rf) * 100));
                                                    const isProd = m.matchedKind === 'product';
                                                    return (
                                                      <div
                                                        key={`fnd-${mi}`}
                                                        style={{
                                                          position: 'absolute',
                                                          left: '50%',
                                                          top: `${topPct}%`,
                                                          transform: 'translate(-50%, -50%)',
                                                          width: isProd ? '8px' : '6.5px',
                                                          height: isProd ? '8px' : '6.5px',
                                                          borderRadius: '50%',
                                                          background: isProd ? '#10b981' : '#f59e0b',
                                                          boxShadow: '0 0 0 1px rgba(0,0,0,0.2)',
                                                          zIndex: isProd ? 5 : 4,
                                                        }}
                                                      />
                                                    );
                                                  })}
                                              </>
                                            )}
                                            {/* Tiny bottom status indicator bar */}
                                            {!lane.isBlank && (hasFoundProd || hasMissingProd || hasExtra) && (
                                              <div
                                                style={{
                                                  position: 'absolute',
                                                  bottom: 0,
                                                  left: 0,
                                                  right: 0,
                                                  height: '2.5px',
                                                  background: hasFoundProd
                                                    ? '#10b981'
                                                    : hasExtra
                                                    ? '#c084fc'
                                                    : '#f59e0b',
                                                  opacity: 0.85,
                                                }}
                                              />
                                            )}
                                          </button>
                                        );
                                      })}
                                    </div>

                                    {/* Lane Coordinates */}
                                    <div
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(27, minmax(0, 1fr))',
                                        marginTop: '3px',
                                      }}
                                    >
                                      {half.slice.map(({ lane }) => {
                                        const isSel = lane.wellIndex === resolvedCompWellIdx;
                                        const hasFoundProd = lane.predictedSpots.some((p) => p.kind === 'product' && p.found);
                                        const hasExtra = lane.measuredSpots.some((m) => !m.matchedLabel);
                                        return (
                                          <div
                                            key={lane.wellIndex}
                                            className="mono"
                                            style={{
                                              fontSize: '7.5px',
                                              textAlign: 'center',
                                              color: isSel
                                                ? 'var(--acc)'
                                                : lane.isBlank
                                                ? 'var(--mut)'
                                                : hasFoundProd
                                                ? '#10b981'
                                                : hasExtra
                                                ? '#c084fc'
                                                : 'var(--mut)',
                                              fontWeight: isSel || hasFoundProd ? 700 : 400,
                                              opacity: lane.isBlank ? 0.35 : 1,
                                            }}
                                          >
                                            {lane.wellCoord}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ))}
                              </div>

                              {/* Clicked Well Detailed Comparison Inspector */}
                              {inspectedCompLane && !inspectedCompLane.isBlank && (
                                <div
                                  style={{
                                    borderTop: '1px solid var(--line2)',
                                    paddingTop: '8px',
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
                                      flexWrap: 'wrap',
                                      gap: '8px',
                                    }}
                                  >
                                    <div className="mono" style={{ fontSize: '11.5px', fontWeight: 700 }}>
                                      Well {inspectedCompLane.wellCoord} (Lane {tlcLane(inspectedCompLane.wellIndex) + 1}) on {activeCompPlate.setName}
                                    </div>
                                    <span style={{ fontSize: '10.5px', color: 'var(--mut)' }}>
                                      Click any lane above to compare measured spots vs predicted products &amp; starting materials
                                    </span>
                                  </div>

                                  <div
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                      gap: '8px',
                                    }}
                                  >
                                    {/* Bucket 1: Confirmed Resolved Interior Found */}
                                    {(() => {
                                      const confirmedInterior = inspectedCompLane.predictedSpots.filter(
                                        (p) =>
                                          p.found &&
                                          p.boundaryStatus !== 'front_saturated' &&
                                          p.boundaryStatus !== 'baseline_pinned'
                                      );
                                      const boundaryOrMissing = inspectedCompLane.predictedSpots.filter(
                                        (p) =>
                                          !p.found ||
                                          p.boundaryStatus === 'front_saturated' ||
                                          p.boundaryStatus === 'baseline_pinned'
                                      );
                                      return (
                                        <>
                                          <div
                                            style={{
                                              padding: '7px 9px',
                                              borderRadius: '6px',
                                              background: 'var(--soft)',
                                              border: '1px solid color-mix(in srgb, #10b981 30%, var(--line2))',
                                              fontSize: '11px',
                                            }}
                                          >
                                            <div style={{ fontWeight: 700, color: '#10b981', marginBottom: '4px' }}>
                                              ● Found on TLC ({confirmedInterior.length})
                                            </div>
                                            {confirmedInterior.length === 0 ? (
                                              <div style={{ color: 'var(--mut)', fontSize: '10.5px' }}>
                                                No predicted SM/product resolved cleanly in the interior of this lane.
                                              </div>
                                            ) : (
                                              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                                {confirmedInterior.map((p, i) => {
                                                  const predRf = calibrationEnabled ? p.rfAfter : p.rfBefore;
                                                  return (
                                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        <strong style={{ color: p.kind === 'product' ? '#10b981' : '#f59e0b' }}>
                                                          {p.kind === 'product' ? 'Prod' : 'SM'}
                                                        </strong>{' '}
                                                        {p.label}
                                                      </span>
                                                      <span className="mono" style={{ flexShrink: 0, color: 'var(--fg2)' }}>
                                                        Obs {p.matchedObsRf?.toFixed(2)} (Pred {predRf.toFixed(2)})
                                                      </span>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                          </div>

                                          {/* Bucket 2: Boundary-Saturated or Predicted Not Seen */}
                                          <div
                                            style={{
                                              padding: '7px 9px',
                                              borderRadius: '6px',
                                              background: 'var(--soft)',
                                              border: '1px solid color-mix(in srgb, #f59e0b 30%, var(--line2))',
                                              fontSize: '11px',
                                            }}
                                          >
                                            <div style={{ fontWeight: 700, color: '#f59e0b', marginBottom: '4px' }}>
                                              ▲/◌ Boundary-Saturated or Not Seen ({boundaryOrMissing.length})
                                            </div>
                                            {boundaryOrMissing.length === 0 ? (
                                              <div style={{ color: 'var(--mut)', fontSize: '10.5px' }}>
                                                All predicted species in this well were resolved inside the plate window.
                                              </div>
                                            ) : (
                                              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                                {boundaryOrMissing.map((p, i) => {
                                                  const predRf = calibrationEnabled ? p.rfAfter : p.rfBefore;
                                                  const isFrontSat = p.boundaryStatus === 'front_saturated';
                                                  const isBasePin = p.boundaryStatus === 'baseline_pinned';
                                                  return (
                                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        <strong style={{ color: isFrontSat ? '#38bdf8' : isBasePin ? '#fb7185' : p.kind === 'product' ? '#10b981' : '#f59e0b' }}>
                                                          {isFrontSat
                                                            ? `▲ Front-Sat (${p.kind === 'product' ? 'Prod' : 'SM'})`
                                                            : isBasePin
                                                            ? `▼ Base-Pin (${p.kind === 'product' ? 'Prod' : 'SM'})`
                                                            : p.kind === 'product'
                                                            ? `◌ Prod (${p.tier || 'Med'})`
                                                            : '◌ SM (Consumed?)'}
                                                        </strong>{' '}
                                                        {p.label}
                                                      </span>
                                                      <span className="mono" style={{ flexShrink: 0, color: isFrontSat ? '#38bdf8' : isBasePin ? '#fb7185' : 'var(--mut)' }}>
                                                        {isFrontSat
                                                          ? p.matchedObsRf !== undefined
                                                            ? `Obs ${p.matchedObsRf.toFixed(2)} ≥0.92 (exp ${predRf.toFixed(2)})`
                                                            : `Rf ≥ 0.92 (exp ${predRf.toFixed(2)})`
                                                          : isBasePin
                                                          ? p.matchedObsRf !== undefined
                                                            ? `Obs ${p.matchedObsRf.toFixed(2)} ≤0.05 (exp ${predRf.toFixed(2)})`
                                                            : `Rf ≤ 0.05 (exp ${predRf.toFixed(2)})`
                                                          : `exp. Rf ${predRf.toFixed(2)}`}
                                                      </span>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            )}
                                          </div>
                                        </>
                                      );
                                    })()}

                                    {/* Bucket 3: Extra / Unpredicted Spots */}
                                    <div
                                      style={{
                                        padding: '7px 9px',
                                        borderRadius: '6px',
                                        background: 'var(--soft)',
                                        border: '1px solid color-mix(in srgb, #c084fc 30%, var(--line2))',
                                        fontSize: '11px',
                                      }}
                                    >
                                      <div style={{ fontWeight: 700, color: '#c084fc', marginBottom: '4px' }}>
                                        ◆ Extra / Unpredicted Spots ({inspectedCompLane.measuredSpots.filter((m) => !m.matchedLabel).length})
                                      </div>
                                      {inspectedCompLane.measuredSpots.filter((m) => !m.matchedLabel).length === 0 ? (
                                        <div style={{ color: 'var(--mut)', fontSize: '10.5px' }}>
                                          No unexpected spots detected in this lane.
                                        </div>
                                      ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                          {inspectedCompLane.measuredSpots
                                            .filter((m) => !m.matchedLabel)
                                            .map((m, i) => (
                                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                                                <span style={{ color: 'var(--fg2)' }}>Unassigned TLC spot #{i + 1}</span>
                                                <span className="mono" style={{ flexShrink: 0 }}>
                                                  Obs Rf {m.rf.toFixed(2)} · str {m.strength.toFixed(2)}
                                                </span>
                                              </div>
                                            ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                    </div>
                  );
                })()}

              {/* Follow-Up / Rescue Solvent Suggestions Driven by Measured Plate Failures */}
              {!plateLoading &&
                platePlan?.followUpPlan &&
                (platePlan.followUpPlan.recommendations.length > 0 ||
                  platePlan.followUpPlan.summary.frontCrowdedWells.length > 0 ||
                  platePlan.followUpPlan.summary.baselinePinnedWells.length > 0 ||
                  platePlan.followUpPlan.summary.tailingWells.length > 0) && (
                  <div
                    style={{
                      border: '1px solid color-mix(in srgb, #38bdf8 45%, var(--line))',
                      borderRadius: '10px',
                      background: 'color-mix(in srgb, #38bdf8 7%, var(--soft))',
                      padding: '10px 14px',
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
                        flexWrap: 'wrap',
                        gap: '8px',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '12.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                          <span
                            className="mono"
                            style={{
                              fontSize: '10px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: '#38bdf8',
                              color: '#06131f',
                              fontWeight: 700,
                            }}
                          >
                            NEXT SOLVENT FROM RESULTS
                          </span>
                          <span>Follow-Up / Rescue Eluents for Unresolved Measured Wells</span>
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginTop: '2px' }}>
                          Measured so far: <strong style={{ color: '#10b981' }}>{platePlan.followUpPlan.summary.resolvedWellCount}</strong>/{platePlan.followUpPlan.summary.measuredWellCount} resolved
                          {platePlan.followUpPlan.summary.frontCrowdedWells.length > 0 && (
                            <> · <strong style={{ color: '#38bdf8' }}>{platePlan.followUpPlan.summary.frontCrowdedWells.length} front-crowded</strong></>
                          )}
                          {platePlan.followUpPlan.summary.baselinePinnedWells.length > 0 && (
                            <> · <strong style={{ color: '#fb7185' }}>{platePlan.followUpPlan.summary.baselinePinnedWells.length} baseline-pinned</strong></>
                          )}
                          {platePlan.followUpPlan.summary.coelutedWells.length > 0 && (
                            <> · <strong>{platePlan.followUpPlan.summary.coelutedWells.length} co-eluted</strong></>
                          )}
                          {platePlan.followUpPlan.summary.tailingWells.length > 0 && (
                            <> · <strong style={{ color: '#f59e0b' }}>{platePlan.followUpPlan.summary.tailingWells.length} tailing/streaking</strong></>
                          )}
                          {' '}— run a suggested rescue tab and re-load to refine the fit.
                        </div>
                        {platePlan.followUpPlan.summary.plateProgressionNote && (
                          <div style={{ fontSize: '11px', color: '#10b981', marginTop: '2px', fontWeight: 600 }}>
                            {platePlan.followUpPlan.summary.plateProgressionNote}
                          </div>
                        )}
                      </div>
                    </div>

                    {platePlan.followUpPlan.recommendations.length > 0 ? (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
                          gap: '8px',
                        }}
                      >
                        {platePlan.followUpPlan.recommendations.map((opt) => {
                          const tabName = formatTlcTabName(
                            opt.system.name,
                            platePlan.stationaryPhase || stationaryPhasePref
                          );
                          const isPreview = activeSystemPlan?.system.id === opt.system.id;
                          return (
                            <div
                              key={opt.system.id}
                              style={{
                                padding: '9px 11px',
                                borderRadius: '8px',
                                background: 'var(--panel)',
                                border: isPreview ? '1.5px solid #38bdf8' : '1px solid var(--line2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '5px',
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                                <strong style={{ fontSize: '13px' }}>{opt.system.name}</strong>
                                <span className="mono" style={{ fontSize: '10.5px', fontWeight: 700, color: '#38bdf8' }}>
                                  +{opt.rescuedWellIndices.length} wells
                                </span>
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--fg2)' }}>{opt.reason}</div>
                              <div className="mono" style={{ fontSize: '10px', color: 'var(--mut)' }}>
                                50 mL: {prepOf(opt.system)} · Wells: {opt.rescuedWellCoords.slice(0, 8).join(', ')}
                                {opt.rescuedWellCoords.length > 8 ? ` +${opt.rescuedWellCoords.length - 8} more` : ''}
                              </div>
                              <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{ height: '22px', fontSize: '10.5px', padding: '0 7px' }}
                                  onClick={() => {
                                    setSelectedSystemId(opt.system.id);
                                    if (opt.rescuedWellIndices.length > 0) {
                                      setSelectedLaneIdx(opt.rescuedWellIndices[0]);
                                    }
                                  }}
                                >
                                  Preview Plate
                                </button>
                                {onCreateNewSet && (
                                  <button
                                    type="button"
                                    className="btn sm pri"
                                    style={{ height: '22px', fontSize: '10.5px', padding: '0 7px', background: '#38bdf8', borderColor: '#0284c7', color: '#06131f' }}
                                    onClick={() => {
                                      onCreateNewSet(tabName);
                                      toast(`Added follow-up TLC tab "${tabName}".`);
                                    }}
                                  >
                                    + Add Follow-Up Tab
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                        No single untested normal-phase eluent rescues those remaining boundary wells cleanly — consider switching Stationary Phase to <strong>Reverse Phase (C18)</strong> for ultra-polar/ionizable wells.
                      </div>
                    )}
                  </div>
                )}

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
                      const alt = rec.alternatives?.[0];
                      const altSel = alt ? activeSystemPlan?.system.id === alt.id : false;
                      const altTabName = alt
                        ? formatTlcTabName(alt.name, platePlan.stationaryPhase || stationaryPhasePref)
                        : '';
                      return (
                        <div key={rec.system.id} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div
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
                              {rec.system.family === 'prisma_ternary' && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    background: 'color-mix(in srgb, #a855f7 16%, transparent)',
                                    color: '#c084fc',
                                  }}
                                  title={rec.system.synthesisNote || 'Nyiredy PRISMA selectivity-triangle ternary eluent'}
                                >
                                  PRISMA Ternary
                                </span>
                              )}
                              {rec.system.isSynthesized && rec.system.family !== 'prisma_ternary' && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    background: 'color-mix(in srgb, #10b981 15%, transparent)',
                                    color: '#10b981',
                                  }}
                                  title={rec.system.synthesisNote || 'Composed dynamically from plate target elution strength & acid stress'}
                                >
                                  Plate-Tuned
                                </span>
                              )}
                            </div>
                            <span
                              className="mono"
                              style={{ fontSize: '11.5px', fontWeight: 700, color: '#10b981' }}
                              title={
                                rec.resolvedWellCount < rec.assignedWellIndices.length
                                  ? `Solo plate resolves ${rec.wellCoveragePct}%; assigned ${rec.assignedWellIndices.length}/${platePlan.activeWellCount} wells via cross-plate SM + product coverage`
                                  : `Single-plate estimated well coverage`
                              }
                            >
                              {rec.resolvedWellCount < rec.assignedWellIndices.length && platePlan.activeWellCount > 0
                                ? `est. ${Math.round((rec.assignedWellIndices.length / platePlan.activeWellCount) * 100)}% set-share`
                                : `est. ${rec.wellCoveragePct}% resolved`}
                            </span>
                          </div>

                          <div style={{ fontSize: '15px', fontWeight: 700 }}>{rec.system.name}</div>

                          <div className="mono" style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                            50 mL: {prepOf(rec.system)}
                          </div>

                          {/* Explainability metrics: Unique coverage, Rf uncertainty, Separation quality */}
                          <div
                            className="mono"
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '6px',
                              fontSize: '10.5px',
                              alignItems: 'center',
                            }}
                          >
                            {rec.uniqueWellIndices.length > 0 && (
                              <span
                                style={{
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'color-mix(in srgb, #10b981 14%, transparent)',
                                  color: '#10b981',
                                  fontWeight: 700,
                                }}
                                title={`Wells uniquely resolved by this system in the recommended set: ${rec.uniqueWellCoords.join(', ')}`}
                              >
                                +{rec.uniqueWellIndices.length} unique
                              </span>
                            )}
                            <span
                              style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'var(--soft)',
                                color: 'var(--fg2)',
                              }}
                              title="Mean per-spot Rf prediction uncertainty (±1σ) across active wells"
                            >
                              ±{rec.meanRfSigma.toFixed(2)} Rf
                            </span>
                            <span
                              style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'var(--soft)',
                                color: 'var(--fg2)',
                              }}
                              title="Mean predicted product–substrate separation across assigned wells"
                            >
                              avg ΔRf {rec.meanProductDeltaRf.toFixed(2)}
                            </span>
                            {rec.system.descriptors?.practicalityNote && (
                              <span
                                style={{
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
                                  color: '#f59e0b',
                                }}
                              >
                                {rec.system.descriptors.practicalityNote}
                              </span>
                            )}
                          </div>

                          {/* Failure risk summary */}
                          {(() => {
                            const rk = rec.riskSummary;
                            const items: Array<{ label: string; color: string }> = [];
                            if (rk.reactiveWells > 0) items.push({ label: `${rk.reactiveWells} reactive eluent`, color: '#ef4444' });
                            if (rk.tailingWells > 0) items.push({ label: `${rk.tailingWells} tailing`, color: '#f59e0b' });
                            if (rk.baselineWells > 0) items.push({ label: `${rk.baselineWells} baseline`, color: '#fb7185' });
                            if (rk.frontWells > 0) items.push({ label: `${rk.frontWells} front`, color: '#38bdf8' });
                            if (rk.coelutedWells > 0) items.push({ label: `${rk.coelutedWells} co-elution`, color: '#a78bfa' });
                            if (rk.stainOnlyWells > 0) items.push({ label: `${rk.stainOnlyWells} stain-only`, color: '#94a3b8' });
                            if (items.length === 0) return null;
                            return (
                              <div
                                className="mono"
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '5px',
                                  fontSize: '10px',
                                  alignItems: 'center',
                                }}
                              >
                                <span style={{ color: 'var(--mut)' }}>Risks:</span>
                                {items.map((it) => (
                                  <span
                                    key={it.label}
                                    style={{
                                      padding: '1px 5px',
                                      borderRadius: '4px',
                                      border: `1px solid color-mix(in srgb, ${it.color} 40%, transparent)`,
                                      color: it.color,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {it.label}
                                  </span>
                                ))}
                              </div>
                            );
                          })()}

                          {rec.system.descriptors && (
                            <div
                              className="mono"
                              style={{
                                fontSize: '10.5px',
                                color: 'var(--fg2)',
                                background: 'var(--soft)',
                                padding: '3px 7px',
                                borderRadius: '5px',
                                display: 'inline-flex',
                                flexWrap: 'wrap',
                                gap: '6px',
                              }}
                              title="Empirical mixture parameters computed via Langmuir silanol saturation, Kamlet-Taft blending & Geiss secondary front demixing"
                            >
                              <span>ε⁰ {rec.system.descriptors.strength.toFixed(2)}</span>
                              <span>· α {rec.system.descriptors.alphaMix.toFixed(2)}</span>
                              <span>· β {rec.system.descriptors.betaMix.toFixed(2)}</span>
                              <span>· π* {rec.system.descriptors.piStarMix.toFixed(2)}</span>
                              {rec.system.descriptors.aromaticMix > 0 && (
                                <span style={{ color: '#c084fc', fontWeight: 700 }}>
                                  · Ar-π {rec.system.descriptors.aromaticMix.toFixed(2)}
                                </span>
                              )}
                              {rec.system.descriptors.betaFrontCeiling !== undefined && (
                                <span
                                  style={{ color: '#f59e0b', fontWeight: 700 }}
                                  title="Geiss secondary solvent front (β-front) demixing ceiling on dry SiO2"
                                >
                                  · β-front ≤{rec.system.descriptors.betaFrontCeiling.toFixed(2)}
                                </span>
                              )}
                              {rec.system.descriptors.modifierCapacity > 0 && (
                                <span style={{ color: '#38bdf8', fontWeight: 700 }}>
                                  · Cap {rec.system.descriptors.modifierCapacity.toFixed(2)} eq
                                </span>
                              )}
                            </div>
                          )}

                          <div style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                            {rec.rationale || (rec.system.synthesisNote ? `${rec.system.synthesisNote} — ${rec.system.bestFor}` : rec.system.bestFor)}
                          </div>
                          <div style={{ fontSize: '10.5px', color: 'var(--mut)' }}>
                            Evidence: {rec.evidenceSummary}
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
                        {alt && (
                          <div
                            onClick={() => {
                              setSelectedSystemId(alt.id);
                              if (rec.assignedWellIndices.length > 0) setSelectedLaneIdx(rec.assignedWellIndices[0]);
                            }}
                            style={{
                              cursor: 'pointer',
                              padding: '10px 14px',
                              borderRadius: '10px',
                              background: altSel ? 'color-mix(in srgb, #10b981 9%, var(--panel))' : 'var(--panel)',
                              border: altSel ? '2px dashed #10b981' : '1px dashed var(--line)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                            }}
                          >
                            <div style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--mut)' }}>
                              {rec.alternativeNote ? 'OR · same wells, less streaking' : 'OR · same wells, other base'}
                            </div>
                            <div style={{ fontSize: '13px', fontWeight: 700 }}>{alt.name}</div>
                            <div className="mono" style={{ fontSize: '11px', color: 'var(--fg2)' }}>
                              50 mL: {prepOf(alt)}
                            </div>
                            {rec.alternativeNote && (
                              <div style={{ fontSize: '11px', color: 'var(--fg2)' }}>{rec.alternativeNote}</div>
                            )}
                            <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }} onClick={(e) => e.stopPropagation()}>
                              {onApplyToCurrentSet && (
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                                  onClick={() => {
                                    onApplyToCurrentSet(altTabName);
                                    toast(`Applied "${altTabName}" to active TLC tab.`);
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
                                    onCreateNewSet(altTabName);
                                    toast(`Created TLC tab "${altTabName}".`);
                                  }}
                                >
                                  + Tab
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Summary Coverage Bar + Empirical Solvent Physics Diagnostics */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      padding: '9px 12px',
                      background: 'var(--soft)',
                      borderRadius: '8px',
                      fontSize: '12px',
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
                      <div>
                        <strong>Plate {plateIdx + 1} Set Coverage:</strong>{' '}
                        <span className="mono" style={{ color: '#10b981', fontWeight: 700 }}>
                          est. {platePlan.resolvedWellCount} / {platePlan.activeWellCount} active wells resolved ({platePlan.totalCoveragePct}%)
                          {platePlan.unresolvedWellIndices.length > 0 && ` · ${platePlan.unresolvedWellIndices.length} unresolved`}
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

                    {platePlan.empiricalProfile && (
                      <div
                        className="mono"
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: '8px',
                          paddingTop: '6px',
                          borderTop: '1px solid var(--line)',
                          fontSize: '11px',
                          color: 'var(--fg2)',
                        }}
                      >
                        <span>
                          <strong>Empirical Rules:</strong> Target ε⁰ {platePlan.empiricalProfile.targetStrengthMin.toFixed(2)}–{platePlan.empiricalProfile.targetStrengthMax.toFixed(2)}
                          {' · '}Avg aromatic rings {platePlan.empiricalProfile.meanAromaticRings.toFixed(1)}
                          {' · '}Avg HBD {platePlan.empiricalProfile.meanHbd.toFixed(1)}
                          {platePlan.empiricalProfile.maxAcidStress > 0 &&
                            ` · Max acid stress ${platePlan.empiricalProfile.maxAcidStress.toFixed(2)} eq (${platePlan.empiricalProfile.acidLabel || 'acid'}) → min base cap ${platePlan.empiricalProfile.recommendedMinBaseCap.toFixed(2)} eq`}
                          {platePlan.empiricalProfile.synthesizedCandidateCount > 0 &&
                            ` · ${platePlan.empiricalProfile.synthesizedCandidateCount} Langmuir plate-tuned candidates evaluated`}
                          {(platePlan.empiricalProfile.prismaCandidateCount ?? 0) > 0 &&
                            ` (+ ${platePlan.empiricalProfile.prismaCandidateCount} PRISMA ternary)`}
                        </span>
                        {platePlan.empiricalProfile.tolueneRecommended &&
                          platePlan.empiricalProfile.topTolueneCandidate &&
                          poolMode === 'prefer_primary' &&
                          !platePlan.recommendedSystems.some((r) => (r.system.descriptors?.aromaticMix ?? 0) >= 0.25) && (
                            <button
                              type="button"
                              className="btn sm"
                              style={{
                                height: '22px',
                                fontSize: '10.5px',
                                padding: '0 8px',
                                color: '#c084fc',
                                borderColor: 'color-mix(in srgb, #c084fc 40%, transparent)',
                              }}
                              onClick={() => setPoolMode('balanced')}
                              title="Toluene π-π competition matches or beats workhorse blends on this aromatic plate; switch Preference to All Systems Equal to promote it"
                            >
                              Ar-π alternative: {platePlan.empiricalProfile.topTolueneCandidate.name} ({platePlan.empiricalProfile.topTolueneCandidate.coveragePct}% · score {platePlan.empiricalProfile.topTolueneCandidate.meanScore.toFixed(2)}) — Try All Systems →
                            </button>
                          )}
                      </div>
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
                          <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span>
                              Simulated 54-Well TLC Plate — <span style={{ color: '#10b981' }}>{activeSystemPlan.system.name}</span>
                            </span>
                            {platePlan.calibrationApplied?.active && (
                              <span
                                className="mono"
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  background: 'color-mix(in srgb, #10b981 16%, transparent)',
                                  color: '#10b981',
                                }}
                              >
                                Calibrated ({platePlan.calibrationApplied.midplateRfShift >= 0 ? '+' : ''}
                                {platePlan.calibrationApplied.midplateRfShift.toFixed(2)} Rf
                                {platePlan.calibrationApplied.hasFeatureWeights ? ' · Ridge 5D' : ''})
                              </span>
                            )}
                          </div>
                          <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                            {stationaryPhaseBadge(activeSystemPlan.system.stationaryPhase, platePlan.stationaryPhase || stationaryPhasePref).full} · 50 mL: {prepOf(activeSystemPlan.system)}
                            {activeSystemPlan.system.descriptors && (
                              <>
                                {' · '}ε⁰ {activeSystemPlan.system.descriptors.strength.toFixed(2)} · α {activeSystemPlan.system.descriptors.alphaMix.toFixed(2)} · β {activeSystemPlan.system.descriptors.betaMix.toFixed(2)} · π* {activeSystemPlan.system.descriptors.piStarMix.toFixed(2)}
                                {activeSystemPlan.system.descriptors.aromaticMix > 0 && ` · Ar-π ${activeSystemPlan.system.descriptors.aromaticMix.toFixed(2)}`}
                                {activeSystemPlan.system.descriptors.betaFrontCeiling !== undefined && ` · β-front ≤${activeSystemPlan.system.descriptors.betaFrontCeiling.toFixed(2)}`}
                                {activeSystemPlan.system.descriptors.modifierCapacity > 0 && ` · Cap ${activeSystemPlan.system.descriptors.modifierCapacity.toFixed(2)} eq`}
                              </>
                            )}
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
                          {(() => {
                            const recList = platePlan.recommendedSystems || [];
                            const uvSubs = inspectedLane.spots.filter(
                              (s) => s.kind === 'substrate' && s.uvActive !== false
                            );
                            const trackedCount = uvSubs.filter((sub) =>
                              recList.some((rec) => {
                                const match = rec.lanes[inspectedLane.wellIndex]?.spots.find(
                                  (rs) => rs.kind === 'substrate' && rs.code === sub.code
                                );
                                return match ? match.rf >= 0.10 && match.rf <= 0.84 : false;
                              })
                            ).length;
                            return (
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                                <div className="mono" style={{ fontSize: '12.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  <span>
                                    Well {inspectedLane.wellCoord} (Spotter Lane {tlcLane(inspectedLane.wellIndex) + 1}) in {activeSystemPlan.system.shortLabel} · ΔRf = {inspectedLane.deltaRf.toFixed(2)} · Separation{' '}
                                    <span style={{ color: laneScoreColor(inspectedLane.resolutionScore) }}>
                                      {Math.round(inspectedLane.resolutionScore * 100)}%
                                    </span>
                                  </span>
                                  {recList.length >= 2 && uvSubs.length > 0 && (
                                    <span
                                      style={{
                                        fontSize: '10.5px',
                                        padding: '1px 6px',
                                        borderRadius: '4px',
                                        background:
                                          trackedCount === uvSubs.length
                                            ? 'color-mix(in srgb, #10b981 15%, transparent)'
                                            : 'color-mix(in srgb, #f59e0b 16%, transparent)',
                                        color: trackedCount === uvSubs.length ? '#10b981' : '#f59e0b',
                                      }}
                                      title="Starting materials clearly readable (Rf 0.10–0.84) on at least one recommended sister plate"
                                    >
                                      Set SM Tracking {trackedCount}/{uvSubs.length}
                                    </span>
                                  )}
                                </div>
                                <span style={{ fontSize: '11px', color: 'var(--mut)' }}>
                                  Click any lane above to inspect its spots &amp; structures
                                </span>
                              </div>
                            );
                          })()}

                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
                              gap: '10px',
                            }}
                          >
                            {inspectedLane.spots.slice(0, 6).map((spot, idx) => {
                              const isOffWindowHere = spot.rf > 0.84 || spot.rf < 0.09;
                              let bestSister: { rank: number; label: string; rf: number } | null = null;
                              if (isOffWindowHere) {
                                let bestMidDist = Infinity;
                                for (const rec of platePlan.recommendedSystems) {
                                  if (rec.system.id === activeSystemPlan.system.id) continue;
                                  const match = rec.lanes[inspectedLane.wellIndex]?.spots.find(
                                    (rs) => rs.kind === spot.kind && rs.code === spot.code
                                  );
                                  if (match && match.rf >= 0.10 && match.rf <= 0.84) {
                                    const d = Math.abs(match.rf - 0.45);
                                    if (d < bestMidDist) {
                                      bestMidDist = d;
                                      bestSister = {
                                        rank: rec.rank,
                                        label: rec.system.shortLabel,
                                        rf: match.rf,
                                      };
                                    }
                                  }
                                }
                              }
                              return (
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
                                {bestSister && (
                                  <div style={{ fontSize: '10px', color: '#10b981', textAlign: 'center', fontWeight: 600 }}>
                                    ✓ Clear on #{bestSister.rank} {bestSister.label} (Rf {bestSister.rf.toFixed(2)})
                                  </div>
                                )}
                                {!bestSister && isOffWindowHere && spot.kind === 'substrate' && spot.uvActive !== false && (
                                  <div style={{ fontSize: '10px', color: '#f59e0b', textAlign: 'center' }}>
                                    ⚠ {spot.rf > 0.84 ? 'Near front' : 'Near baseline'} across recommended set
                                  </div>
                                )}
                                {spot.tailing && (
                                  <div style={{ fontSize: '10px', color: 'var(--warn)', textAlign: 'center' }}>
                                    {spot.tailingReason}
                                  </div>
                                )}
                                {!spot.tailing && spot.mildStreak && spot.tailingReason && (
                                  <div style={{ fontSize: '10px', color: 'var(--warn)', opacity: 0.85, textAlign: 'center' }}>
                                    {spot.tailingReason}
                                  </div>
                                )}
                                {spot.uvActive === false && (
                                  <div style={{ fontSize: '10px', color: 'var(--warn)', textAlign: 'center' }}>
                                    No chromophore: not visible under UV, use a stain
                                  </div>
                                )}
                                {spot.mayDecompose && (
                                  <div style={{ fontSize: '10px', color: 'var(--warn)', textAlign: 'center' }}>
                                    Reversible product: may decompose on silica
                                  </div>
                                )}
                              </div>
                              );
                            })}
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
                          Other Available Systems, grouped into complementary sets (click any to preview the simulated 54-well plate)
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

                      {showOtherSystems &&
                        (() => {
                          const renderCard = (rec: RecommendedPlateSolvent) => {
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
                                title={`${prepOf(rec.system)} — ${rec.system.bestFor}`}
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
                                  {prepOf(rec.system)}
                                </div>
                              </button>
                            );
                          };
                          const groups = platePlan.otherGroups || [];
                          const groupedIds = new Set(groups.flatMap((g) => g.systems.map((e) => e.system.id)));
                          const leftovers = platePlan.otherSystems.filter((r) => !groupedIds.has(r.system.id));
                          const gridStyle = {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))',
                            gap: '8px',
                          } as const;
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                              {groups.map((grp) => (
                                <div key={grp.label} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  <div style={{ fontSize: '12px', fontWeight: 700 }}>
                                    {grp.label}{' '}
                                    <span className="mono" style={{ fontWeight: 600, color: 'var(--mut)' }}>
                                      · est. {grp.resolvedWellCount}/{platePlan.activeWellCount} wells resolved ({grp.coveragePct}%) as a set
                                    </span>
                                  </div>
                                  <div style={gridStyle}>{grp.systems.map((rec) => renderCard(rec))}</div>
                                </div>
                              ))}
                              {leftovers.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  <div style={{ fontSize: '12px', fontWeight: 700 }}>
                                    Other single systems{' '}
                                    <span style={{ fontWeight: 400, color: 'var(--mut)' }}>(not part of a set)</span>
                                  </div>
                                  <div style={gridStyle}>{leftovers.map((rec) => renderCard(rec))}</div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
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
