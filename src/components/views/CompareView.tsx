import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Copy,
  Download,
  FlaskConical,
  Layers,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getImagesForSets } from '../../context/tlcStorage';
import { buildMultiRunExportFilename } from '../../utils/exportFilename';
import {
  CURRENT_RUN_ID,
  ComparableRun,
  LANE_FRAME_WIDTH,
  PAL,
  TLC_SIGNAL,
  TlcChannelKey,
  WellCompareSlotRef,
  WellPredictionResult,
  buildWellComparisonMatrix,
  compareRunsSummary,
  extractDensitogram,
  extractLaneProfile2d,
  extractWellSnapshot,
  findFirstOccupiedWell,
  findMultiChannelSpots,
  getChannelHistogram,
  getChannelFrontBandProfile,
  getEffectiveLaneSpots,
  getLane2dMetrics,
  predictWellReactions,
  tlcFront,
  tlcHalf,
  tlcOrigin,
  toComparableRunFromCurrent,
  toComparableRunFromSaved,
  updateTlcPlateSlice,
  wellLabel,
} from '../../engine';
import { TlcLane, TlcSet, TlcSpot } from '../../types';
import { getRDKitInstance } from '../../utils/rdkit';
import { ChemicalStructure } from '../ui/ChemicalStructure';
import { CompareLaneThumb } from '../ui/CompareLaneThumb';
import { CompareWellPicker } from '../ui/CompareWellPicker';

type AspectFilter = 'all' | 'recipe' | 'conditions' | 'predict' | 'tlc' | 'eln';

function extractLaneProfileOnce(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  return extractLaneProfile2d(set, key, lane, coreFraction);
}

function resolveSpotsForSnapshot(
  tlcSet: TlcSet | undefined,
  lane: TlcLane | null,
  preferredChannel: 'composite' | TlcChannelKey
): TlcSpot[] {
  if (!tlcSet || !lane) return [];
  if (Array.isArray(lane.customSpots) && lane.customSpots.length > 0) {
    return lane.customSpots;
  }
  const available: TlcChannelKey[] = [];
  if (tlcSet.imgs?.UV254?.bmp) available.push('UV254');
  if (tlcSet.imgs?.UV366?.bmp) available.push('UV366');
  if (tlcSet.imgs?.White?.bmp) available.push('White');
  if (!available.length) return [];

  const origin = tlcOrigin(tlcSet, lane, extractLaneProfileOnce);
  const front = tlcFront(tlcSet, lane, extractLaneProfileOnce);

  const profiles: Partial<Record<TlcChannelKey, number[]>> = {};
  const histograms: Partial<Record<TlcChannelKey, ReturnType<typeof getChannelHistogram>>> = {};
  const lane2dByChannel: Partial<Record<TlcChannelKey, ReturnType<typeof getLane2dMetrics>>> = {};
  const frontBandByChannel: Partial<Record<TlcChannelKey, number[]>> = {};
  const halfIdx = tlcHalf(lane);
  for (const ch of available) {
    const p = extractLaneProfileOnce(tlcSet, ch, lane);
    if (p.length) {
      profiles[ch] = p;
      const chHist = getChannelHistogram(tlcSet, ch, extractLaneProfileOnce);
      if (chHist) histograms[ch] = chHist;
      const m2d = getLane2dMetrics(tlcSet, ch, lane);
      if (m2d) lane2dByChannel[ch] = m2d;
      const fBg = getChannelFrontBandProfile(tlcSet, ch, halfIdx, extractLaneProfileOnce);
      if (fBg) frontBandByChannel[ch] = fBg;
    }
  }
  const merged = findMultiChannelSpots({
    profiles,
    origin,
    front,
    radius: lane.spotRadius ?? undefined,
    minProminence: tlcSet.spotProminence ?? 0.28,
    histograms,
    lane2dByChannel,
    frontBandByChannel,
    detectorMode: tlcSet.spotDetectorMode,
    minSpotWidthFrac: tlcSet.minSpotWidthFrac,
  });
  return getEffectiveLaneSpots(lane, merged);
}

function downloadCsvFile(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = filename;
  document.body.appendChild(el);
  el.click();
  el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csvEsc(val: unknown): string {
  const s = String(val ?? '');
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CompareView: React.FC = () => {
  const {
    state,
    run,
    triMeta,
    tlcSets,
    status,
    runsList,
    compareIds,
    setCompareIds,
    compareMode,
    setCompareMode,
    compareWells,
    setCompareWells,
    setView,
    toast,
  } = useApp();

  const [aspectFilter, setAspectFilter] = useState<AspectFilter>('all');
  const [diffsOnly, setDiffsOnly] = useState<boolean>(false);
  const [tlcChannel, setTlcChannel] = useState<'composite' | TlcChannelKey>('UV254');
  const [hydratedTlcMap, setHydratedTlcMap] = useState<Record<string, TlcSet[]>>({});
  const hydratedStartedRef = useRef<Set<string>>(new Set());

  // Reaction predictions keyed by slot UID + signature
  const [predictionsBySlot, setPredictionsBySlot] = useState<Record<string, WellPredictionResult>>({});
  const [predSignatureBySlot, setPredSignatureBySlot] = useState<Record<string, string>>({});
  const [predictBusy, setPredictBusy] = useState<boolean>(false);
  const [rdkit, setRdkit] = useState<any>(null);

  useEffect(() => {
    let active = true;
    getRDKitInstance().then((inst) => {
      if (active) setRdkit(inst);
    });
    return () => {
      active = false;
    };
  }, []);

  // Build catalog of all comparable runs: Current Workspace + every SavedRun
  const comparableRuns = useMemo<ComparableRun[]>(() => {
    const current = toComparableRunFromCurrent(state, run, triMeta, tlcSets, status);
    const saved = runsList.map((sr) => {
      const base = toComparableRunFromSaved(sr);
      if (hydratedTlcMap[sr.id]) {
        base.tlcSets = hydratedTlcMap[sr.id];
      }
      return base;
    });
    return [current, ...saved];
  }, [state, run, triMeta, tlcSets, status, runsList, hydratedTlcMap]);

  const runById = useMemo(() => {
    const map = new Map<string, ComparableRun>();
    comparableRuns.forEach((r) => map.set(r.id, r));
    return map;
  }, [comparableRuns]);

  // Ensure Runs Comparator has >= 2 runs selected whenever active or runs exist
  const selectedRunIds = useMemo<string[]>(() => {
    const valid = compareIds.filter((id) => runById.has(id));
    if (valid.length >= 2) return valid;
    const pool = comparableRuns.map((r) => r.id);
    const out = [...valid];
    for (const id of pool) {
      if (!out.includes(id)) out.push(id);
      if (out.length >= Math.min(2, pool.length)) break;
    }
    return out;
  }, [compareIds, runById, comparableRuns]);

  const selectedRuns = useMemo(
    () => selectedRunIds.map((id) => runById.get(id)).filter((r): r is ComparableRun => Boolean(r)),
    [selectedRunIds, runById]
  );

  // Initialize Well Comparator slots sensibly on first entry if empty or < 2 slots
  useEffect(() => {
    if (compareWells.length >= 2) return;
    const nextSlots: WellCompareSlotRef[] = [...compareWells];

    // If user selected 2+ runs in RunsView and jumped to Compare, prefill same occupied well across those runs
    if (compareIds.length >= 2 && nextSlots.length === 0) {
      const anchorRun = runById.get(compareIds[0]) || comparableRuns[0];
      const anchorCoord = anchorRun ? findFirstOccupiedWell(anchorRun) : { plateIndex: 0, wellIndex: 0 };
      compareIds.forEach((rid, idx) => {
        if (runById.has(rid)) {
          nextSlots.push({
            uid: `init_${idx}_${rid}`,
            runId: rid,
            plateIndex: anchorCoord.plateIndex,
            wellIndex: anchorCoord.wellIndex,
          });
        }
      });
    }

    // Otherwise fill within the current run (or available runs)
    if (nextSlots.length < 2) {
      const baseRun = runById.get(nextSlots[0]?.runId || CURRENT_RUN_ID) || comparableRuns[0];
      if (baseRun) {
        if (nextSlots.length === 0) {
          const first = findFirstOccupiedWell(baseRun);
          nextSlots.push({
            uid: `slot_0_${Math.random().toString(36).slice(2, 7)}`,
            runId: baseRun.id,
            plateIndex: first.plateIndex,
            wellIndex: first.wellIndex,
          });
        }
        const usedWell = nextSlots[0].wellIndex;
        const rows = baseRun.run?.rows || [];
        const secondRow =
          rows.find(
            (rw) =>
              !(rw.plate_number === nextSlots[0].plateIndex && rw.container_id === usedWell) &&
              !(baseRun.triMeta?.[rw.global_index]?.blank) &&
              rw.recipe.some((rc) => Number(rc.target_concentration) > 0)
          ) || null;
        nextSlots.push({
          uid: `slot_1_${Math.random().toString(36).slice(2, 7)}`,
          runId: baseRun.id,
          plateIndex: secondRow ? secondRow.plate_number : nextSlots[0].plateIndex,
          wellIndex: secondRow ? secondRow.container_id : (usedWell + 1) % 54,
        });
      }
    }

    if (nextSlots.length >= 2) {
      setCompareWells(nextSlots);
    }
  }, [compareWells, compareIds, comparableRuns, runById, setCompareWells]);

  // Hydrate IndexedDB TLC images on demand for any referenced saved run
  useEffect(() => {
    const referencedRunIds = new Set<string>([
      ...compareWells.map((s) => s.runId),
      ...selectedRunIds,
    ]);

    referencedRunIds.forEach((rid) => {
      if (rid === CURRENT_RUN_ID || hydratedStartedRef.current.has(rid)) return;
      const compRun = runById.get(rid);
      if (!compRun || !compRun.tlcSets.length) return;
      hydratedStartedRef.current.add(rid);

      getImagesForSets(compRun.tlcSets)
        .then(async (imgs) => {
          if (!imgs.length) return;
          const nextSets = await Promise.all(
            compRun.tlcSets.map(async (origSet) => {
              let updated = origSet;
              const matched = imgs.filter((im) => im.uid === origSet.uid);
              for (const entry of matched) {
                const match = /^p(\d+)_(.+)$/.exec(entry.key);
                const pIdx = match ? Number(match[1]) : 0;
                const ch = match ? match[2] : entry.key;
                try {
                  const bmp = await createImageBitmap(entry.blob);
                  updated = updateTlcPlateSlice(updated, pIdx, (slice) => ({
                    imgs: { ...slice.imgs, [ch]: { name: entry.name, bmp } },
                  }));
                } catch {
                  // ignore corrupt/unreadable image
                }
              }
              return updated;
            })
          );
          setHydratedTlcMap((prev) => ({ ...prev, [rid]: nextSets }));
        })
        .catch(() => {
          // soft fallback to spot metadata
        });
    });
  }, [compareWells, selectedRunIds, runById]);

  // Build normalized Well Snapshots + auto-extracted TLC spots for all active slots
  const wellSnapshots = useMemo(() => {
    return compareWells
      .map((slot) => {
        const compRun = runById.get(slot.runId) || comparableRuns[0];
        if (!compRun) return null;
        const snap = extractWellSnapshot(compRun, slot.plateIndex, slot.wellIndex, slot.uid);
        const resolvedSpots = resolveSpotsForSnapshot(snap.tlc.tlcSet, snap.tlc.lane, tlcChannel);
        if (resolvedSpots.length > 0 && snap.tlc.spots.length === 0) {
          snap.tlc.spots = resolvedSpots;
        }
        return snap;
      })
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
  }, [compareWells, runById, comparableRuns, tlcChannel]);

  // Signature helper for each snapshot's chemistry prediction inputs
  const slotPredSignatures = useMemo(() => {
    const out: Record<string, string> = {};
    wellSnapshots.forEach((s) => {
      if (!s.extraction) {
        out[s.slotUid] = '';
        return;
      }
      out[s.slotUid] = JSON.stringify({
        subs: s.extraction.substrates.map((x) => `${x.smiles}:${x.equivalents}`),
        cond: s.extraction.condition,
      });
    });
    return out;
  }, [wellSnapshots]);

  const activePredictions = useMemo(() => {
    const out: Record<string, WellPredictionResult> = {};
    wellSnapshots.forEach((s) => {
      const sig = slotPredSignatures[s.slotUid];
      if (sig && predSignatureBySlot[s.slotUid] === sig && predictionsBySlot[s.slotUid]) {
        out[s.slotUid] = predictionsBySlot[s.slotUid];
      }
    });
    return out;
  }, [wellSnapshots, slotPredSignatures, predSignatureBySlot, predictionsBySlot]);

  const runPredictionsForSlots = useCallback(async () => {
    if (!rdkit) {
      toast('RDKit chemistry engine is still initializing…');
      return;
    }
    setPredictBusy(true);
    try {
      const nextPreds: Record<string, WellPredictionResult> = { ...predictionsBySlot };
      const nextSigs: Record<string, string> = { ...predSignatureBySlot };

      for (const snap of wellSnapshots) {
        const sig = slotPredSignatures[snap.slotUid];
        if (!sig || !snap.extraction) continue;
        if (nextSigs[snap.slotUid] === sig && nextPreds[snap.slotUid]) continue;

        const validSubs = snap.extraction.substrates.filter((x) => x.smiles.trim().length > 0);
        if (validSubs.length === 0) continue;

        nextPreds[snap.slotUid] = predictWellReactions(rdkit, validSubs, snap.extraction.condition);
        nextSigs[snap.slotUid] = sig;
        // Yield briefly between slots so UI stays smooth
        await new Promise((r) => setTimeout(r, 0));
      }

      setPredictionsBySlot(nextPreds);
      setPredSignatureBySlot(nextSigs);
    } finally {
      setPredictBusy(false);
    }
  }, [rdkit, wellSnapshots, slotPredSignatures, predictionsBySlot, predSignatureBySlot, toast]);

  // Auto-run predictions lazily when RDKit becomes ready and user inspects Predict or All aspect with SMILES
  useEffect(() => {
    if (!rdkit || compareMode !== 'wells') return;
    if (aspectFilter !== 'predict' && aspectFilter !== 'all') return;
    const needsCompute = wellSnapshots.some((s) => {
      const sig = slotPredSignatures[s.slotUid];
      const hasSmiles = s.extraction?.substrates.some((x) => x.smiles.trim().length > 0);
      return sig && hasSmiles && predSignatureBySlot[s.slotUid] !== sig;
    });
    if (needsCompute && !predictBusy) {
      void runPredictionsForSlots();
    }
  }, [
    rdkit,
    compareMode,
    aspectFilter,
    wellSnapshots,
    slotPredSignatures,
    predSignatureBySlot,
    predictBusy,
    runPredictionsForSlots,
  ]);

  const wellMatrix = useMemo(
    () => buildWellComparisonMatrix(wellSnapshots, activePredictions),
    [wellSnapshots, activePredictions]
  );

  const runsComparison = useMemo(
    () => (selectedRuns.length >= 2 ? compareRunsSummary(selectedRuns) : null),
    [selectedRuns]
  );

  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '—';

  const fmt = (v: any) =>
    v == null || v === '' ? <span className="hint">—</span> : String(v);

  // Slot manipulation helpers
  const handleAddWellSlot = () => {
    const last = compareWells[compareWells.length - 1];
    const targetRun = runById.get(last?.runId || CURRENT_RUN_ID) || comparableRuns[0];
    if (!targetRun) return;
    const usedCoords = new Set(
      compareWells
        .filter((s) => s.runId === targetRun.id)
        .map((s) => `${s.plateIndex}-${s.wellIndex}`)
    );
    const candidate =
      targetRun.run?.rows.find(
        (rw) =>
          !usedCoords.has(`${rw.plate_number}-${rw.container_id}`) &&
          !(targetRun.triMeta?.[rw.global_index]?.blank) &&
          rw.recipe.some((rc) => Number(rc.target_concentration) > 0)
      ) || null;
    setCompareWells((prev) => [
      ...prev,
      {
        uid: `slot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        runId: targetRun.id,
        plateIndex: candidate ? candidate.plate_number : last?.plateIndex ?? 0,
        wellIndex: candidate ? candidate.container_id : ((last?.wellIndex ?? 0) + 1) % 54,
      },
    ]);
  };

  const handleDuplicateSlot = (slot: WellCompareSlotRef) => {
    setCompareWells((prev) => [
      ...prev,
      {
        uid: `slot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        runId: slot.runId,
        plateIndex: slot.plateIndex,
        wellIndex: slot.wellIndex,
      },
    ]);
  };

  const handleSyncCoordinateAcrossSlots = () => {
    if (!compareWells.length) return;
    const anchor = compareWells[0];
    setCompareWells((prev) =>
      prev.map((s, idx) =>
        idx === 0 ? s : { ...s, plateIndex: anchor.plateIndex, wellIndex: anchor.wellIndex }
      )
    );
    toast(`Synced all slots to P${anchor.plateIndex + 1} · ${wellLabel(anchor.wellIndex)}.`);
  };

  const handleCompareWellAcrossRuns = (plateIndex: number, wellIndex: number) => {
    const targetRuns = selectedRuns.length >= 2 ? selectedRuns : comparableRuns.slice(0, 4);
    setCompareWells(
      targetRuns.map((r, idx) => ({
        uid: `xrun_${idx}_${r.id}`,
        runId: r.id,
        plateIndex,
        wellIndex,
      }))
    );
    setCompareMode('wells');
    window.scrollTo(0, 0);
  };

  const handleAddRunToCompare = (runId: string) => {
    if (!runId || selectedRunIds.includes(runId)) return;
    setCompareIds([...selectedRunIds, runId]);
  };

  const handleRemoveRunFromCompare = (runId: string) => {
    if (selectedRunIds.length <= 2) return;
    setCompareIds(selectedRunIds.filter((id) => id !== runId));
  };

  const handleExportComparisonCsv = () => {
    if (compareMode === 'runs' && runsComparison) {
      const headers = ['Setting / Metric', ...runsComparison.runs.map((r) => r.name)];
      const rows = [
        headers,
        ...runsComparison.parameterRows.map((row) => [row.label, ...row.values]),
        ...runsComparison.reagentRows.map((rr) => [
          `Reagent: ${rr.displayName}`,
          ...rr.entries.map((e) =>
            e
              ? `${e.reagent.code} · ${e.reagent.molarMass || '-'} g/mol · ${e.reagent.stock || '-'} mM (${e.reagent.solvent || '-'})`
              : '—'
          ),
        ]),
      ];
      const csv = '\ufeff' + rows.map((r) => r.map(csvEsc).join(',')).join('\r\n');
      downloadCsvFile(
        buildMultiRunExportFilename(
          runsComparison.runs.map((r) => r.name),
          'run_comparison',
          'csv'
        ),
        csv
      );
      toast('Exported multi-run comparison CSV.');
      return;
    }

    if (compareMode === 'wells' && wellSnapshots.length >= 2) {
      const headers = [
        'Aspect / Parameter',
        ...wellSnapshots.map((s, i) => `Well ${i + 1}: ${s.runName} (P${s.plateIndex + 1} ${s.wellLabel})`),
      ];
      const rows: unknown[][] = [headers];
      wellMatrix.reagentRows.forEach((rr) => {
        rows.push([
          `Component: ${rr.displayName} (${rr.displayCode})`,
          ...rr.cells.map((c) =>
            c.present
              ? `${c.concMm.toFixed(2)} mM${c.equiv != null ? ` (${c.equiv.toFixed(2)} eq)` : ''} · ${c.transferUl.toFixed(1)} uL`
              : '—'
          ),
        ]);
      });
      wellMatrix.conditionRows.forEach((cr) => rows.push([cr.label, ...cr.values]));
      wellMatrix.elnRows.forEach((er) => rows.push([`ELN: ${er.label}`, ...er.values]));
      wellMatrix.rfBands.forEach((band) =>
        rows.push([
          `TLC Band ~Rf ${band.anchorRf.toFixed(2)}`,
          ...band.cells.map((c) =>
            c.matched && c.spot
              ? `Rf ${c.spot.rf.toFixed(2)}${c.spot.areaPct != null ? ` (${c.spot.areaPct}%)` : ''}`
              : '—'
          ),
        ])
      );
      wellMatrix.productRows.forEach((pr) =>
        rows.push([
          `Predicted ${pr.formula} [M+H]+ ${pr.mhPlus.toFixed(4)}`,
          ...pr.cells.map((c) => (c.present ? `#${c.rank} (${c.score?.toFixed(2)} · ${c.tier})` : '—')),
        ])
      );
      const csv = '\ufeff' + rows.map((r) => r.map(csvEsc).join(',')).join('\r\n');
      downloadCsvFile(
        buildMultiRunExportFilename(
          wellSnapshots.map((s) => s.runName),
          'well_comparison',
          'csv'
        ),
        csv
      );
      toast('Exported multi-well comparison CSV.');
    }
  };

  const showRecipe = aspectFilter === 'all' || aspectFilter === 'recipe';
  const showConditions = aspectFilter === 'all' || aspectFilter === 'conditions';
  const showPredict = aspectFilter === 'all' || aspectFilter === 'predict';
  const showTlc = aspectFilter === 'all' || aspectFilter === 'tlc';
  const showEln = aspectFilter === 'all' || aspectFilter === 'eln';

  const visibleConditionRows = diffsOnly
    ? wellMatrix.conditionRows.filter((r) => r.hasDiff)
    : wellMatrix.conditionRows;
  const visibleReagentRows = diffsOnly
    ? wellMatrix.reagentRows.filter((r) => r.hasDiff)
    : wellMatrix.reagentRows;
  const visibleElnRows = diffsOnly
    ? wellMatrix.elnRows.filter((r) => r.hasDiff)
    : wellMatrix.elnRows;

  return (
    <div className="wrap">
      {/* Top Studio Header Card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '14px',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>Compare Studio</h2>
              <div className="seg" role="group" aria-label="Comparison mode">
                <button
                  type="button"
                  className={compareMode === 'wells' ? 'on' : ''}
                  onClick={() => setCompareMode('wells')}
                >
                  Wells ({wellSnapshots.length})
                </button>
                <button
                  type="button"
                  className={compareMode === 'runs' ? 'on' : ''}
                  onClick={() => setCompareMode('runs')}
                >
                  Runs ({selectedRuns.length})
                </button>
              </div>
            </div>
            <p className="sub" style={{ margin: '6px 0 0' }}>
              {compareMode === 'wells' ? (
                <>
                  Compare 2 or more wells within a run or across saved runs · stoichiometry,
                  predicted products, TLC Rf bands &amp; ELN outcomes. Changes from{' '}
                  <b>Well 1</b> appear in{' '}
                  <span style={{ color: 'var(--acc)', fontWeight: 600 }}>accent colour</span>.
                </>
              ) : (
                <>
                  Compare 2 or more runs side by side · parameters, aligned reagents &amp; structures,
                  ELN hits, and jump straight to any well coordinate across runs.
                </>
              )}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12.5px',
                color: diffsOnly ? 'var(--acc)' : 'var(--fg2)',
                fontWeight: diffsOnly ? 600 : 500,
                cursor: 'pointer',
                padding: '0 8px',
              }}
            >
              <input
                type="checkbox"
                checked={diffsOnly}
                onChange={(e) => setDiffsOnly(e.target.checked)}
                style={{ accentColor: 'var(--acc)', width: '14px', height: '14px' }}
              />
              Differences only
            </label>

            <button
              type="button"
              className="btn sm"
              onClick={handleExportComparisonCsv}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Download size={13} />
              <span>Export CSV</span>
            </button>

            <button type="button" className="btn sm" onClick={() => setView('runs')}>
              Runs &amp; library
            </button>
            <button type="button" className="btn sm" onClick={() => setView('setup')}>
              Active run
            </button>
          </div>
        </div>

        {/* Aspect Filter Toolbar in Wells Mode */}
        {compareMode === 'wells' && (
          <div
            style={{
              marginTop: '14px',
              paddingTop: '12px',
              borderTop: '1px solid var(--line2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <div className="seg" role="group" aria-label="Comparison aspects">
              {(
                [
                  ['all', 'All aspects'],
                  ['recipe', 'Recipe & Stoich'],
                  ['conditions', 'Conditions'],
                  ['predict', 'Predicted Chemistry'],
                  ['tlc', 'TLC & Rf'],
                  ['eln', 'ELN Outcomes'],
                ] as Array<[AspectFilter, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={aspectFilter === id ? 'on' : ''}
                  onClick={() => setAspectFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm"
                onClick={handleSyncCoordinateAcrossSlots}
                disabled={compareWells.length < 2}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                title="Apply Well 1's plate & coordinate across every slot so you can compare the same well across runs"
              >
                <ArrowRightLeft size={13} />
                <span>Sync P{compareWells[0]?.plateIndex + 1 || 1}·{wellLabel(compareWells[0]?.wellIndex ?? 0)} across all</span>
              </button>

              <button
                type="button"
                className="btn sm pri"
                onClick={handleAddWellSlot}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <Plus size={13} />
                <span>Add well</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* MODE 1: MULTI-WELL COMPARATOR (Same Run OR Across 2+ Runs)            */}
      {/* ===================================================================== */}
      {compareMode === 'wells' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Slot Selector Cards */}
          <div
            style={{
              display: 'grid',
              gap: '12px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            }}
          >
            {compareWells.map((slot, idx) => {
              const compRun = runById.get(slot.runId) || comparableRuns[0];
              const snap = wellSnapshots.find((s) => s.slotUid === slot.uid);
              const slotColor = PAL[idx % PAL.length];
              return (
                <div
                  key={slot.uid}
                  className="card"
                  style={{
                    padding: '14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    borderColor: idx === 0 ? 'var(--acc)' : 'var(--line)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span
                        className="rdot"
                        style={{
                          background: slotColor,
                          minWidth: '24px',
                          height: '22px',
                          fontSize: '11px',
                          flexShrink: 0,
                        }}
                      >
                        W{idx + 1}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap' }}>
                        {idx === 0 ? 'Baseline' : `Well ${idx + 1}`}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => handleDuplicateSlot(slot)}
                        title="Duplicate this well slot"
                        style={{ height: '26px', padding: '0 7px' }}
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={compareWells.length <= 2}
                        onClick={() =>
                          setCompareWells((prev) => prev.filter((x) => x.uid !== slot.uid))
                        }
                        title="Remove slot (minimum 2 slots)"
                        style={{ height: '26px', padding: '0 7px' }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Run selector */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <select
                      className="f"
                      style={{ height: '32px', fontSize: '12.5px', padding: '0 8px' }}
                      value={compRun?.id || CURRENT_RUN_ID}
                      onChange={(e) => {
                        const newRunId = e.target.value;
                        const target = runById.get(newRunId);
                        const maxPlates = Math.max(1, target?.run?.plates || 1);
                        setCompareWells((prev) =>
                          prev.map((x) =>
                            x.uid === slot.uid
                              ? {
                                  ...x,
                                  runId: newRunId,
                                  plateIndex: Math.min(x.plateIndex, maxPlates - 1),
                                }
                              : x
                          )
                        );
                      }}
                      aria-label={`Select run for slot ${idx + 1}`}
                    >
                      {comparableRuns.map((cr) => (
                        <option key={cr.id} value={cr.id}>
                          {cr.name} ({cr.state.mode})
                        </option>
                      ))}
                    </select>

                    {/* Coordinate picker */}
                    {compRun && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                        }}
                      >
                        <CompareWellPicker
                          compRun={compRun}
                          plateIndex={slot.plateIndex}
                          wellIndex={slot.wellIndex}
                          accentColor={slotColor}
                          onChange={(pIdx, wIdx) => {
                            setCompareWells((prev) =>
                              prev.map((x) =>
                                x.uid === slot.uid
                                  ? { ...x, plateIndex: pIdx, wellIndex: wIdx }
                                  : x
                              )
                            );
                          }}
                        />
                        <span
                          className="hint"
                          style={{
                            margin: 0,
                            fontSize: '11.5px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={snap?.groupLabel}
                        >
                          {snap?.isBlank
                            ? 'Blank'
                            : snap?.substrates.length
                            ? `${snap.substrates.length} comp · ${nf(snap.totalVialUl, 0)} µL`
                            : 'Empty'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Section A: Substrates, Structures & Stoichiometry */}
          {showRecipe && (
            <div className="card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: '10px',
                  flexWrap: 'wrap',
                  marginBottom: '12px',
                }}
              >
                <div>
                  <h2 style={{ margin: 0 }}>Components, Structures &amp; Stoichiometry</h2>
                  <p className="sub" style={{ margin: '2px 0 0' }}>
                    Side-by-side molarity (mM), equivalents, transfer volume (µL), and dilution tier
                    for every component across the selected wells.
                  </p>
                </div>
              </div>

              {visibleReagentRows.length > 0 ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', minWidth: '210px' }}>Component</th>
                        {wellSnapshots.map((s, idx) => (
                          <th key={s.slotUid} style={{ textAlign: 'left', minWidth: '175px' }}>
                            <span
                              className="rdot"
                              style={{
                                background: PAL[idx % PAL.length],
                                height: '18px',
                                minWidth: '22px',
                                fontSize: '10px',
                                marginRight: '6px',
                              }}
                            >
                              W{idx + 1}
                            </span>
                            <span className="mono">
                              P{s.plateIndex + 1}·{s.wellLabel}
                            </span>{' '}
                            <span style={{ fontWeight: 400, color: 'var(--mut)', fontSize: '11.5px' }}>
                              · {s.runName.replace(' (Current)', '')}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleReagentRows.map((rr) => {
                        const baseCell = rr.cells[0];
                        return (
                          <tr key={rr.key} className="hov">
                            <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {rr.smiles && (
                                  <ChemicalStructure
                                    smiles={rr.smiles}
                                    name={rr.displayName}
                                    width={88}
                                    height={60}
                                    allowZoom={true}
                                  />
                                )}
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
                                    {rr.displayName}
                                  </div>
                                  <div className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                                    {rr.displayCode}
                                    {rr.isAdditive ? ' · additive' : ''}
                                  </div>
                                </div>
                              </div>
                            </td>

                            {rr.cells.map((cell, ci) => {
                              const changed =
                                ci > 0 &&
                                (cell.present !== baseCell.present ||
                                  cell.concMm.toFixed(3) !== baseCell.concMm.toFixed(3));
                              return (
                                <td
                                  key={ci}
                                  style={{
                                    textAlign: 'left',
                                    color: !cell.present
                                      ? 'var(--mut)'
                                      : changed
                                      ? 'var(--acc)'
                                      : 'var(--fg)',
                                    opacity: !cell.present ? 0.55 : 1,
                                    fontWeight: changed ? 600 : 400,
                                  }}
                                >
                                  {cell.present ? (
                                    <div>
                                      <div className="mono" style={{ fontSize: '12.5px' }}>
                                        {nf(cell.concMm, 2)} mM
                                        {cell.equiv != null && (
                                          <span style={{ color: 'var(--mut)', fontWeight: 400 }}>
                                            {' '}
                                            · {nf(cell.equiv, 2)} eq
                                          </span>
                                        )}
                                      </div>
                                      <div className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                                        {nf(cell.transferUl, 1)} µL
                                        {cell.dilutionLevel > 0 ? ` · dil ×${cell.dilutionLevel}` : ''}
                                      </div>
                                    </div>
                                  ) : (
                                    <span>Not added</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="hint" style={{ margin: 0 }}>
                  {diffsOnly
                    ? 'All selected wells have identical component concentrations and stoichiometry.'
                    : 'No active substrates in the selected wells.'}
                </div>
              )}
            </div>
          )}

          {/* Section B: Conditions Diff Table */}
          {showConditions && (
            <div className="card">
              <h2>Reaction Conditions &amp; Volumes</h2>
              <p className="sub">
                Solvent, acid/base medium, temperature, reaction duration, atmosphere, and pipetted makeup volume.
              </p>
              {visibleConditionRows.length > 0 ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', minWidth: '185px' }}>Condition</th>
                        {wellSnapshots.map((s, idx) => (
                          <th key={s.slotUid} style={{ textAlign: 'left', minWidth: '165px' }}>
                            <span className="mono">
                              W{idx + 1} · P{s.plateIndex + 1}·{s.wellLabel}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleConditionRows.map((row) => (
                        <tr key={row.key} className="hov">
                          <td style={{ textAlign: 'left', fontWeight: 500 }}>{row.label}</td>
                          {row.values.map((val, vi) => (
                            <td
                              key={vi}
                              style={{
                                textAlign: 'left',
                                whiteSpace: 'normal',
                                color: row.diffFromBaseline[vi] ? 'var(--acc)' : undefined,
                                fontWeight: row.diffFromBaseline[vi] ? 600 : undefined,
                              }}
                            >
                              {fmt(val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="hint" style={{ margin: 0 }}>
                  All reaction conditions are identical across the selected wells.
                </div>
              )}
            </div>
          )}

          {/* Section C: Predicted Chemistry & Shared/Unique Species Matrix */}
          {showPredict && (
            <div className="card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  marginBottom: '12px',
                }}
              >
                <div>
                  <h2 style={{ margin: 0 }}>Predicted Products &amp; LC-MS Comparison</h2>
                  <p className="sub" style={{ margin: '2px 0 0' }}>
                    Mechanistic RDKit product predictions aligned by canonical structure across wells —
                    spot shared targets vs condition-specific byproducts.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={runPredictionsForSlots}
                  disabled={predictBusy || !rdkit}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <Sparkles size={13} />
                  <span>
                    {predictBusy
                      ? 'Predicting…'
                      : !rdkit
                      ? 'Loading RDKit…'
                      : 'Refresh predictions'}
                  </span>
                </button>
              </div>

              {wellMatrix.productRows.length > 0 ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', minWidth: '250px' }}>
                          Predicted Species &amp; [M+H]⁺
                        </th>
                        <th style={{ textAlign: 'left' }}>Distribution</th>
                        {wellSnapshots.map((s, idx) => (
                          <th key={s.slotUid} style={{ textAlign: 'left', minWidth: '140px' }}>
                            <span className="mono">
                              W{idx + 1} · P{s.plateIndex + 1}·{s.wellLabel}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(diffsOnly
                        ? wellMatrix.productRows.filter((p) => p.presenceKind !== 'shared')
                        : wellMatrix.productRows
                      ).map((pr) => (
                        <tr key={pr.key} className="hov">
                          <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <ChemicalStructure
                                smiles={pr.smiles}
                                name={pr.formula}
                                width={104}
                                height={72}
                                allowZoom={true}
                              />
                              <div style={{ minWidth: 0 }}>
                                <div className="mono" style={{ fontWeight: 700, fontSize: '12.5px' }}>
                                  {pr.formula}
                                </div>
                                <div className="mono" style={{ fontSize: '11.5px', color: 'var(--acc)' }}>
                                  [M+H]⁺ {pr.mhPlus.toFixed(4)}
                                </div>
                                <div className="hint" style={{ margin: '2px 0 0', fontSize: '11px' }}>
                                  {pr.mechanismSummary}
                                </div>
                              </div>
                            </div>
                          </td>

                          <td style={{ textAlign: 'left' }}>
                            <span
                              style={{
                                fontSize: '11.5px',
                                fontWeight: 600,
                                color:
                                  pr.presenceKind === 'shared'
                                    ? 'var(--ok)'
                                    : pr.presenceKind === 'unique'
                                    ? 'var(--warn)'
                                    : 'var(--acc)',
                              }}
                            >
                              {pr.presenceKind === 'shared'
                                ? `All (${pr.presentCount}/${wellSnapshots.length})`
                                : pr.presenceKind === 'unique'
                                ? 'Unique (1 well)'
                                : `Subset (${pr.presentCount}/${wellSnapshots.length})`}
                            </span>
                          </td>

                          {pr.cells.map((c, ci) => (
                            <td key={ci} style={{ textAlign: 'left' }}>
                              {c.present ? (
                                <div>
                                  <div className="mono" style={{ fontWeight: 600, fontSize: '12.5px' }}>
                                    #{c.rank} · {c.score?.toFixed(2)}
                                  </div>
                                  <div className="hint" style={{ margin: 0, fontSize: '11px' }}>
                                    {c.tier} tier
                                  </div>
                                </div>
                              ) : (
                                <span className="hint">Not predicted</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '12.5px',
                    color: 'var(--mut)',
                  }}
                >
                  <FlaskConical size={16} />
                  <span>
                    {predictBusy
                      ? 'Computing mechanistic predictions for compared wells…'
                      : 'Add SMILES structures to reagents on Setup (or click Refresh predictions) to compare predicted reaction products & LC-MS masses.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Section D: TLC Plate Lanes, Rf Track Overlay & Rf Alignment Bands */}
          {showTlc && (
            <div className="card">
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
                <div>
                  <h2 style={{ margin: 0 }}>TLC Lane Strips &amp; Rf Alignment</h2>
                  <p className="sub" style={{ margin: '2px 0 0' }}>
                    Visual cropped lane strips paired with aligned Rf bands (origin 0.00 to front 1.00)
                    and ΔRf shifts relative to Baseline Well 1.
                  </p>
                </div>

                <div className="seg" role="group" aria-label="TLC Channel">
                  {(['composite', 'UV254', 'UV366', 'White'] as const).map((ch) => (
                    <button
                      key={ch}
                      type="button"
                      className={tlcChannel === ch ? 'on' : ''}
                      onClick={() => setTlcChannel(ch)}
                    >
                      {ch === 'composite' ? 'Composite' : ch === 'White' ? 'Vis' : ch}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side-by-side Lane Thumbnails */}
              <div
                style={{
                  display: 'grid',
                  gap: '12px',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
                  marginBottom: '16px',
                }}
              >
                {wellSnapshots.map((s, idx) => (
                  <div
                    key={s.slotUid}
                    style={{
                      padding: '12px',
                      borderRadius: '10px',
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
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
                        gap: '6px',
                      }}
                    >
                      <span className="mono" style={{ fontSize: '12px', fontWeight: 700 }}>
                        W{idx + 1} · P{s.plateIndex + 1}·{s.wellLabel}
                      </span>
                      <span className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                        Lane #{s.tlc.laneIndex + 1}
                      </span>
                    </div>

                    <CompareLaneThumb
                      tlcSet={s.tlc.tlcSet}
                      lane={s.tlc.lane}
                      preferredMode={tlcChannel}
                    />
                  </div>
                ))}
              </div>

              {/* Stacked Visual Rf Track Plot (0.00 -> 1.00) */}
              {wellSnapshots.some((s) => s.tlc.spots.length > 0) && (
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                    marginBottom: '14px',
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--fg2)' }}>
                    Rf Track Comparison (0.00 origin → 1.00 front)
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {wellSnapshots.map((s, idx) => (
                      <div
                        key={s.slotUid}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                      >
                        <div
                          className="mono"
                          style={{
                            width: '105px',
                            flexShrink: 0,
                            fontSize: '11.5px',
                            fontWeight: 600,
                            color: 'var(--fg2)',
                          }}
                        >
                          W{idx + 1} {s.wellLabel}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            position: 'relative',
                            height: '20px',
                            borderRadius: '5px',
                            background: 'var(--panel)',
                            border: '1px solid var(--line2)',
                          }}
                        >
                          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
                            <div
                              key={tick}
                              style={{
                                position: 'absolute',
                                left: `${tick * 100}%`,
                                top: 0,
                                bottom: 0,
                                borderLeft: '1px dashed var(--line)',
                                pointerEvents: 'none',
                              }}
                            />
                          ))}
                          {s.tlc.spots.map((sp, spIdx) => (
                            <div
                              key={spIdx}
                              title={`Rf ${sp.rf.toFixed(2)}${sp.areaPct != null ? ` · ${sp.areaPct}% area` : ''}`}
                              style={{
                                position: 'absolute',
                                left: `${Math.max(2, Math.min(98, sp.rf * 100))}%`,
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                width: `${Math.max(8, Math.round(7 + sp.strength * 7))}px`,
                                height: `${Math.max(8, Math.round(7 + sp.strength * 7))}px`,
                                borderRadius: '50%',
                                background: PAL[idx % PAL.length],
                                border: '1.5px solid var(--panel)',
                                opacity: 0.45 + 0.55 * sp.strength,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Aligned Rf Band Table */}
              {wellMatrix.rfBands.length > 0 ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>Rf Band</th>
                        {wellSnapshots.map((s, idx) => (
                          <th key={s.slotUid} style={{ textAlign: 'left' }}>
                            <span className="mono">
                              W{idx + 1} · P{s.plateIndex + 1}·{s.wellLabel}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {wellMatrix.rfBands.map((band) => (
                        <tr key={band.bandIndex} className="hov">
                          <td className="mono" style={{ textAlign: 'left', fontWeight: 600 }}>
                            Band #{band.bandIndex} (~{band.anchorRf.toFixed(2)})
                          </td>
                          {band.cells.map((c, ci) => (
                            <td key={ci} style={{ textAlign: 'left' }}>
                              {c.matched && c.spot ? (
                                <span className="mono">
                                  Rf <b>{c.spot.rf.toFixed(2)}</b>
                                  {c.spot.areaPct != null ? ` (${c.spot.areaPct}%)` : ''}
                                  {ci > 0 && c.deltaRf !== null && Math.abs(c.deltaRf) >= 0.005 && (
                                    <span
                                      style={{
                                        marginLeft: '6px',
                                        color: 'var(--acc)',
                                        fontSize: '11px',
                                      }}
                                    >
                                      {c.deltaRf > 0 ? `+${c.deltaRf.toFixed(2)}` : c.deltaRf.toFixed(2)}
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span className="hint">—</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '12.5px',
                    color: 'var(--mut)',
                  }}
                >
                  <Layers size={15} />
                  <span>
                    No TLC plate photos or spots loaded for these wells yet. Upload TLC images in TLC Map
                    to compare lane strips and Rf shifts here.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Section E: ELN Observations & Experimental Outcomes */}
          {showEln && (
            <div className="card">
              <h2>HTE Notebook Outcomes &amp; Notes</h2>
              <p className="sub">
                Experimental outcome status, conversion, assay yield, physical observations, and bench notes.
              </p>
              {visibleElnRows.length > 0 ? (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', minWidth: '175px' }}>Observation</th>
                        {wellSnapshots.map((s, idx) => (
                          <th key={s.slotUid} style={{ textAlign: 'left', minWidth: '165px' }}>
                            <span className="mono">
                              W{idx + 1} · P{s.plateIndex + 1}·{s.wellLabel}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleElnRows.map((row) => (
                        <tr key={row.key} className="hov">
                          <td style={{ textAlign: 'left', fontWeight: 500 }}>{row.label}</td>
                          {row.values.map((val, vi) => (
                            <td
                              key={vi}
                              style={{
                                textAlign: 'left',
                                whiteSpace: 'normal',
                                color: row.diffFromBaseline[vi] ? 'var(--acc)' : undefined,
                                fontWeight: row.diffFromBaseline[vi] ? 600 : undefined,
                              }}
                            >
                              {fmt(val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="hint" style={{ margin: 0 }}>
                  All ELN observations match across the selected wells.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODE 2: MULTI-RUN COMPARATOR (2+ Runs Side-by-Side)                   */}
      {/* ===================================================================== */}
      {compareMode === 'runs' && runsComparison && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Selected Runs Selector Strip */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                flexWrap: 'wrap',
                marginBottom: '12px',
              }}
            >
              <div>
                <h2 style={{ margin: 0 }}>Selected Runs ({selectedRuns.length})</h2>
                <p className="sub" style={{ margin: '2px 0 0' }}>
                  Compare the live workspace and any number of saved runs side by side.
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {comparableRuns.some((r) => !selectedRunIds.includes(r.id)) && (
                  <select
                    className="f"
                    style={{ height: '32px', fontSize: '12.5px', padding: '0 8px' }}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) handleAddRunToCompare(e.target.value);
                    }}
                    aria-label="Add another run to comparison"
                  >
                    <option value="">+ Add run to compare…</option>
                    {comparableRuns
                      .filter((r) => !selectedRunIds.includes(r.id))
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.state.mode})
                        </option>
                      ))}
                  </select>
                )}

                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => {
                    const firstOcc = findFirstOccupiedWell(selectedRuns[0]);
                    handleCompareWellAcrossRuns(firstOcc.plateIndex, firstOcc.wellIndex);
                  }}
                >
                  Compare well {wellLabel(findFirstOccupiedWell(selectedRuns[0]).wellIndex)} across these runs →
                </button>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gap: '12px',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              }}
            >
              {selectedRuns.map((cr, idx) => (
                <div
                  key={cr.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: 'var(--soft)',
                    border: `1px solid ${idx === 0 ? 'var(--acc)' : 'var(--line)'}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
                      <span
                        className="rdot"
                        style={{
                          background: PAL[idx % PAL.length],
                          minWidth: '24px',
                          height: '20px',
                          fontSize: '10.5px',
                          flexShrink: 0,
                        }}
                      >
                        R{idx + 1}
                      </span>
                      <b style={{ fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {cr.name}
                      </b>
                    </div>
                    {selectedRuns.length > 2 && (
                      <button
                        type="button"
                        className="btn sm"
                        style={{ height: '24px', padding: '0 6px' }}
                        onClick={() => handleRemoveRunFromCompare(cr.id)}
                        title="Remove run from comparison"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="hint mono" style={{ margin: 0, fontSize: '11.5px' }}>
                    {cr.state.mode} · {cr.run ? `${cr.run.reactions} wells · ${cr.run.plates} pl` : 'draft'} · TLC {cr.tlcStatus}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Parameters Diff Table Across All N Runs */}
          <div className="card">
            <h2>Parameters &amp; Campaign Setup</h2>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', minWidth: '185px' }}>Setting</th>
                    {runsComparison.runs.map((r, idx) => (
                      <th key={r.id} style={{ textAlign: 'left', minWidth: '155px' }}>
                        <span className="mono">R{idx + 1}</span> · {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(diffsOnly
                    ? runsComparison.parameterRows.filter((row) => row.hasDiff)
                    : runsComparison.parameterRows
                  ).map((row) => (
                    <tr key={row.key} className="hov">
                      <td style={{ textAlign: 'left', fontWeight: 500 }}>{row.label}</td>
                      {row.values.map((val, vi) => (
                        <td
                          key={vi}
                          style={{
                            textAlign: 'left',
                            color: row.diffFromBaseline[vi] ? 'var(--acc)' : undefined,
                            fontWeight: row.diffFromBaseline[vi] ? 600 : undefined,
                          }}
                        >
                          {fmt(val)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Aligned Reagents Table with 2D Structures */}
          <div className="card">
            <h2>Reagents &amp; Structures ({runsComparison.reagentRows.length})</h2>
            <p className="sub">
              Aligned across runs by SMILES / name · missing entries shown muted, changed stock/MM highlighted.
            </p>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', minWidth: '215px' }}>Reagent / Structure</th>
                    {runsComparison.runs.map((r, idx) => (
                      <th key={r.id} style={{ textAlign: 'left', minWidth: '175px' }}>
                        <span className="mono">R{idx + 1}</span> · {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(diffsOnly
                    ? runsComparison.reagentRows.filter((rr) => rr.hasDiff)
                    : runsComparison.reagentRows
                  ).map((rr) => (
                    <tr key={rr.key} className="hov">
                      <td style={{ textAlign: 'left', whiteSpace: 'normal' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          {rr.smiles && (
                            <ChemicalStructure
                              smiles={rr.smiles}
                              name={rr.displayName}
                              width={88}
                              height={60}
                              allowZoom={true}
                            />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{rr.displayName}</div>
                            <div className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                              {rr.displayCode}
                            </div>
                          </div>
                        </div>
                      </td>

                      {rr.entries.map((entry, ei) => (
                        <td
                          key={ei}
                          style={{
                            textAlign: 'left',
                            whiteSpace: 'normal',
                            color: !entry
                              ? 'var(--bad)'
                              : rr.hasDiff
                              ? 'var(--acc)'
                              : undefined,
                            opacity: !entry ? 0.65 : 1,
                          }}
                        >
                          {entry ? (
                            <div>
                              <div className="mono" style={{ fontSize: '12px', fontWeight: 600 }}>
                                {entry.reagent.code} · {nf(entry.reagent.stock, 1)} mM
                              </div>
                              <div className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                                MM {nf(entry.reagent.molarMass, 2)} · {entry.reagent.solvent || '—'}
                              </div>
                            </div>
                          ) : (
                            <span>Not present</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ELN Hits Rollup & Drill-Down */}
          <div className="card">
            <h2>ELN Hits &amp; Outcomes per Run</h2>
            <p className="sub">
              Click any top hit coordinate to compare that well across all selected runs.
            </p>
            <div
              style={{
                display: 'grid',
                gap: '12px',
                gridTemplateColumns: 'repeat(auto-fit, minmax(235px, 1fr))',
              }}
            >
              {runsComparison.runs.map((cr, idx) => {
                const summary = runsComparison.elnSummaries[idx];
                return (
                  <div
                    key={cr.id}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '10px',
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>
                      R{idx + 1} · {cr.name}
                    </div>
                    <div className="mono" style={{ fontSize: '12px', color: 'var(--fg2)' }}>
                      {summary.hits} hits · {summary.clean} clean · {summary.partial} partial ·{' '}
                      {summary.decomp} decomp
                    </div>
                    {summary.topHits.length > 0 ? (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {summary.topHits.map((hit) => (
                          <button
                            key={hit.label}
                            type="button"
                            className="btn sm mono"
                            style={{ height: '26px', padding: '0 8px', fontSize: '11.5px' }}
                            onClick={() =>
                              handleCompareWellAcrossRuns(hit.plateIndex, hit.wellIndex)
                            }
                            title={`Compare ${hit.label} across all selected runs`}
                          >
                            {hit.label}
                            {hit.yield != null
                              ? ` · ${hit.yield}%`
                              : hit.conversion != null
                              ? ` · ${hit.conversion}%`
                              : ''}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="hint" style={{ margin: 0 }}>
                        No hit wells recorded yet.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
