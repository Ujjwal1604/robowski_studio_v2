import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Compass,
  Droplets,
  FlaskConical,
  Grid3X3,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import { surfaceHeight } from '../../engine';
import type {
  RobotHardwareState,
  RobotTipRackSummary,
} from '../../engine/predictor/backendClient';
import type { RunResult } from '../../types';
import {
  buildPlateFormatOptions,
  buildTransferPairs,
  formatWellCode,
  resolvePlateFormat,
  rowLetter,
} from '../../utils/plateFormats';
import { PlateCalibrationPanel } from './PlateCalibrationPanel';

const TRANSFER_SOLVENTS = [
  'ethanol',
  'water',
  'DMF',
  'Dioxane',
  'DCE',
  'MeCN',
  'CHCl3',
  'DMSO',
  'glycerin',
  'TolueneMix',
] as const;

function maxSlotForNonVialPlate(plateId: number): number {
  return plateId <= 5 ? 7 : 1;
}

interface QuickTransferCardProps {
  run: RunResult | null;
  measuredSurfaceZ?: Record<string, number>;
  hw: RobotHardwareState | null;
  tipRacks?: RobotTipRackSummary[];
  cmdBusy: boolean;
  selectedPlate: number;
  selectedSlot: number;
  onRunCommand: (command: string, params?: Record<string, any>) => Promise<any>;
}

export const QuickTransferCard: React.FC<QuickTransferCardProps> = ({
  run,
  measuredSurfaceZ,
  hw,
  tipRacks = [],
  cmdBusy,
  selectedPlate,
  selectedSlot,
  onRunCommand,
}) => {
  const ptJob = hw?.plateTransfer || null;
  const ptActive = Boolean(ptJob?.active);
  const presets = hw?.platePresets || [];

  const [mode, setMode] = useState<'single' | 'plate' | 'calibrate'>('single');
  const [calibrateSlotHint, setCalibrateSlotHint] = useState<0 | 1 | 2>(1);

  // Auto-open Plate-to-Plate tab if a plate job is actively running
  useEffect(() => {
    if (ptActive) setMode('plate');
  }, [ptActive]);

  // --- Single Transfer state ---
  const [srcPlate, setSrcPlate] = useState<number>(3);
  const [srcPresetId, setSrcPresetId] = useState<string>('default_54');
  const [srcSlot, setSrcSlot] = useState<number>(0);
  const [srcZ, setSrcZ] = useState<number>(1900);

  const [dstPlate, setDstPlate] = useState<number>(0);
  const [dstPresetId, setDstPresetId] = useState<string>('default_54');
  const [dstSlot, setDstSlot] = useState<number>(0);
  const [dstZ, setDstZ] = useState<number>(2100);

  const [volumeUl, setVolumeUl] = useState<number>(150);
  const [solvent, setSolvent] = useState<string>('ethanol');
  const [tipType, setTipType] = useState<'auto' | '50ul' | '300ul' | '1000ul'>('auto');
  const [pickTip, setPickTip] = useState<boolean>(true);
  const [prewet, setPrewet] = useState<boolean>(false);
  const [mixAfter, setMixAfter] = useState<boolean>(false);
  const [dropTip, setDropTip] = useState<boolean>(true);

  // --- Plate-to-Plate Transfer state ---
  const [ptSrcPlate, setPtSrcPlate] = useState<0 | 1 | 2>(0);
  const [ptDstPlate, setPtDstPlate] = useState<0 | 1 | 2>(1);
  const [ptSrcPresetId, setPtSrcPresetId] = useState<string>('default_54');
  const [ptDstPresetId, setPtDstPresetId] = useState<string>('default_54');
  const [ptSelectedWells, setPtSelectedWells] = useState<number[]>(
    Array.from({ length: 54 }, (_, i) => i)
  );
  const [ptUseCustomOffset, setPtUseCustomOffset] = useState<boolean>(false);
  const [ptDstStartWell, setPtDstStartWell] = useState<number>(0);
  const [ptFillOrder, setPtFillOrder] = useState<'row' | 'col'>('row');
  const [ptRangeStart, setPtRangeStart] = useState<number>(0);
  const [ptRangeEnd, setPtRangeEnd] = useState<number>(53);
  const [ptVolumeUl, setPtVolumeUl] = useState<number>(50);
  const [ptSolvent, setPtSolvent] = useState<string>('ethanol');
  const [ptTipType, setPtTipType] = useState<'auto' | '50ul' | '300ul' | '1000ul'>('auto');
  const [ptSrcZ, setPtSrcZ] = useState<number>(2100);
  const [ptDstZ, setPtDstZ] = useState<number>(2100);
  const [ptChangeTipEach, setPtChangeTipEach] = useState<boolean>(true);
  const [ptPrewet, setPtPrewet] = useState<boolean>(false);
  const [ptMixAfter, setPtMixAfter] = useState<boolean>(false);
  const [ptDropAtEnd, setPtDropAtEnd] = useState<boolean>(true);
  const [ptConfirmStart, setPtConfirmStart] = useState<boolean>(false);

  useEffect(() => {
    if (!ptConfirmStart) return;
    const t = window.setTimeout(() => setPtConfirmStart(false), 7000);
    return () => window.clearTimeout(t);
  }, [ptConfirmStart]);

  // Resolve plate formats for Single Transfer
  const singleSrcOpts = useMemo(
    () => (srcPlate <= 2 ? buildPlateFormatOptions(srcPlate as 0 | 1 | 2, presets) : []),
    [srcPlate, presets]
  );
  const singleDstOpts = useMemo(
    () => (dstPlate <= 2 ? buildPlateFormatOptions(dstPlate as 0 | 1 | 2, presets) : []),
    [dstPlate, presets]
  );
  const singleSrcFmt = useMemo(
    () => (srcPlate <= 2 ? resolvePlateFormat(srcPlate as 0 | 1 | 2, srcPresetId, presets) : null),
    [srcPlate, srcPresetId, presets]
  );
  const singleDstFmt = useMemo(
    () => (dstPlate <= 2 ? resolvePlateFormat(dstPlate as 0 | 1 | 2, dstPresetId, presets) : null),
    [dstPlate, dstPresetId, presets]
  );
  const singleSrcMaxSlot = singleSrcFmt
    ? singleSrcFmt.rows * singleSrcFmt.cols - 1
    : maxSlotForNonVialPlate(srcPlate);
  const singleDstMaxSlot = singleDstFmt
    ? singleDstFmt.rows * singleDstFmt.cols - 1
    : maxSlotForNonVialPlate(dstPlate);

  // Resolve plate formats for Plate-to-Plate Transfer
  const ptSrcOpts = useMemo(
    () => buildPlateFormatOptions(ptSrcPlate, presets),
    [ptSrcPlate, presets]
  );
  const ptDstOpts = useMemo(
    () => buildPlateFormatOptions(ptDstPlate, presets),
    [ptDstPlate, presets]
  );
  const ptSrcFmt = useMemo(
    () => resolvePlateFormat(ptSrcPlate, ptSrcPresetId, presets),
    [ptSrcPlate, ptSrcPresetId, presets]
  );
  const ptDstFmt = useMemo(
    () => resolvePlateFormat(ptDstPlate, ptDstPresetId, presets),
    [ptDstPlate, ptDstPresetId, presets]
  );

  const srcTotalWells = ptSrcFmt.rows * ptSrcFmt.cols;
  const dstTotalWells = ptDstFmt.rows * ptDstFmt.cols;
  const sameShape = ptSrcFmt.rows === ptDstFmt.rows && ptSrcFmt.cols === ptDstFmt.cols;
  const showMixedMapping = !sameShape || ptUseCustomOffset;

  // Keep selected wells and destination start well clamped when plate format changes
  useEffect(() => {
    setPtSelectedWells((prev) => {
      const clamped = prev.filter((w) => w >= 0 && w < srcTotalWells);
      return clamped.length > 0 ? clamped : Array.from({ length: srcTotalWells }, (_, i) => i);
    });
    setPtRangeStart(0);
    setPtRangeEnd(Math.max(0, srcTotalWells - 1));
  }, [srcTotalWells, ptSrcFmt.id]);

  useEffect(() => {
    setPtDstStartWell((prev) => (prev >= 0 && prev < dstTotalWells ? prev : 0));
  }, [dstTotalWells, ptDstFmt.id]);

  // Keep single-transfer preset IDs valid when slots or presets change
  useEffect(() => {
    if (srcPlate <= 2 && singleSrcFmt && singleSrcFmt.id !== srcPresetId) {
      setSrcPresetId(singleSrcFmt.id);
    }
    setSrcSlot((s) => Math.min(singleSrcMaxSlot, s));
  }, [srcPlate, singleSrcFmt, srcPresetId, singleSrcMaxSlot]);

  useEffect(() => {
    if (dstPlate <= 2 && singleDstFmt && singleDstFmt.id !== dstPresetId) {
      setDstPresetId(singleDstFmt.id);
    }
    setDstSlot((s) => Math.min(singleDstMaxSlot, s));
  }, [dstPlate, singleDstFmt, dstPresetId, singleDstMaxSlot]);

  useEffect(() => {
    if (ptSrcFmt.id !== ptSrcPresetId) setPtSrcPresetId(ptSrcFmt.id);
  }, [ptSrcFmt.id, ptSrcPresetId]);

  useEffect(() => {
    if (ptDstFmt.id !== ptDstPresetId) setPtDstPresetId(ptDstFmt.id);
  }, [ptDstFmt.id, ptDstPresetId]);

  // Build exact [srcWell, dstWell] transfer pairs
  const { pairs: ptPairs, overflowCount: ptOverflowCount } = useMemo(
    () =>
      buildTransferPairs(
        ptSelectedWells,
        ptSrcFmt.rows,
        ptSrcFmt.cols,
        ptDstFmt.rows,
        ptDstFmt.cols,
        !ptUseCustomOffset,
        ptDstStartWell,
        ptFillOrder
      ),
    [
      ptSelectedWells,
      ptSrcFmt.rows,
      ptSrcFmt.cols,
      ptDstFmt.rows,
      ptDstFmt.cols,
      ptUseCustomOffset,
      ptDstStartWell,
      ptFillOrder,
    ]
  );

  const srcToDstMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const [sw, dw] of ptPairs) m.set(sw, dw);
    return m;
  }, [ptPairs]);

  const dstToSrcMap = useMemo(() => {
    const m = new Map<number, number>();
    for (const [sw, dw] of ptPairs) m.set(dw, sw);
    return m;
  }, [ptPairs]);

  const deckStocks = useMemo(() => {
    if (!run) return [];
    const list: Array<{
      key: string;
      label: string;
      plateId: number;
      slotId: number;
      z: number;
      measured: boolean;
      solvent: string;
    }> = [];

    if (run.deck) {
      const sKind = run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle';
      const sMl = Number(run.solventRecommendedMl) || 0;
      const saved = measuredSurfaceZ?.solvent;
      const estZ = Math.round(surfaceHeight(sKind, sMl * 1000));
      const z = typeof saved === 'number' && Number.isFinite(saved) ? Math.round(saved) : estZ;
      const matchedSolvent =
        TRANSFER_SOLVENTS.find(
          (sv) => sv.toLowerCase() === (run.reactionSolvent || '').toLowerCase()
        ) || 'ethanol';
      list.push({
        key: 'solvent',
        label: `Solvent (${run.reactionSolvent || 'solvent'})`,
        plateId: run.deck.solvent_plate,
        slotId: run.deck.solvent_container,
        z: Math.max(880, Math.min(2190, z)),
        measured: typeof saved === 'number' && Number.isFinite(saved),
        solvent: matchedSolvent,
      });
    }

    for (const [key, s] of Object.entries(run.stocks || {})) {
      if (s.source_only) continue;
      const plateId = s.breadboard_plate_id;
      const slotId = s.container_id;
      const kind = plateId >= 6 ? 'jar' : 'bottle';
      const ml = Number(s.prep_volume_ml) || 0;
      const saved = measuredSurfaceZ?.[key];
      const estZ = Math.round(surfaceHeight(kind, ml * 1000));
      const z = typeof saved === 'number' && Number.isFinite(saved) ? Math.round(saved) : estZ;
      const matchedSolvent =
        TRANSFER_SOLVENTS.find((sv) => sv.toLowerCase() === (s.solvent || '').toLowerCase()) ||
        'ethanol';
      list.push({
        key,
        label: s.substance || key,
        plateId,
        slotId,
        z: Math.max(880, Math.min(2190, z)),
        measured: typeof saved === 'number' && Number.isFinite(saved),
        solvent: matchedSolvent,
      });
    }

    return list.sort((a, b) => a.plateId - b.plateId || a.slotId - b.slotId);
  }, [run, measuredSurfaceZ]);

  const effectiveTip =
    tipType !== 'auto'
      ? tipType
      : volumeUl <= 50
      ? '50ul'
      : volumeUl <= 300
      ? '300ul'
      : '1000ul';

  const ptEffectiveTip: '50ul' | '300ul' | '1000ul' =
    ptTipType !== 'auto'
      ? ptTipType
      : ptVolumeUl <= 50
      ? '50ul'
      : ptVolumeUl <= 300
      ? '300ul'
      : '1000ul';

  const ptHas96OrDenser = srcTotalWells >= 96 || dstTotalWells >= 96;
  const ptTipsNeeded = ptPairs.length === 0 ? 0 : ptChangeTipEach ? ptPairs.length : 1;
  const ptMatchingRack = tipRacks.find((r) => r.tipType === ptEffectiveTip);
  const ptTipShortage = ptMatchingRack != null && ptTipsNeeded > ptMatchingRack.remaining;

  const ptEstSec =
    ptPairs.length * ((ptChangeTipEach ? 14 : 8) + (ptPrewet ? 4 : 0) + (ptMixAfter ? 4 : 0));
  const ptEstLabel = ptEstSec < 60 ? `~${ptEstSec}s` : `~${Math.round(ptEstSec / 60)} min`;

  const selectedSet = useMemo(() => new Set(ptSelectedWells), [ptSelectedWells]);
  const completedSrcSet = useMemo(
    () =>
      new Set(
        ptJob?.completedPairs
          ? ptJob.completedPairs.map((p) => p[0])
          : ptJob?.completedList || []
      ),
    [ptJob?.completedPairs, ptJob?.completedList]
  );
  const completedDstSet = useMemo(
    () =>
      new Set(
        ptJob?.completedPairs
          ? ptJob.completedPairs.map((p) => p[1])
          : ptJob?.completedList || []
      ),
    [ptJob?.completedPairs, ptJob?.completedList]
  );

  const toggleWell = (id: number) => {
    setPtSelectedWells((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].sort((a, b) => a - b)
    );
  };

  const toggleRow = (rowIdx: number) => {
    const rowWells = Array.from({ length: ptSrcFmt.cols }, (_, c) => rowIdx * ptSrcFmt.cols + c);
    const allIn = rowWells.every((w) => selectedSet.has(w));
    setPtSelectedWells((prev) => {
      const s = new Set(prev);
      for (const w of rowWells) {
        if (allIn) s.delete(w);
        else s.add(w);
      }
      return Array.from(s).sort((a, b) => a - b);
    });
  };

  const applyRange = () => {
    const maxIdx = Math.max(0, srcTotalWells - 1);
    const lo = Math.max(0, Math.min(maxIdx, Math.min(ptRangeStart, ptRangeEnd)));
    const hi = Math.max(0, Math.min(maxIdx, Math.max(ptRangeStart, ptRangeEnd)));
    const arr: number[] = [];
    for (let i = lo; i <= hi; i += 1) arr.push(i);
    setPtSelectedWells(arr);
  };

  const selectRemainingFromLastJob = () => {
    if (!ptJob) return;
    const doneSrc = new Set(
      ptJob.completedPairs ? ptJob.completedPairs.map((p) => p[0]) : ptJob.completedList || []
    );
    const allSrc = ptJob.pairs ? ptJob.pairs.map((p) => p[0]) : ptJob.wells || [];
    const remaining = allSrc.filter((w) => !doneSrc.has(w));
    if (remaining.length > 0) {
      setPtSrcPlate(ptJob.srcPlate as 0 | 1 | 2);
      setPtDstPlate(ptJob.dstPlate as 0 | 1 | 2);
      if (ptJob.srcPresetId) setPtSrcPresetId(ptJob.srcPresetId);
      if (ptJob.dstPresetId) setPtDstPresetId(ptJob.dstPresetId);
      setPtSelectedWells(remaining);
      setPtVolumeUl(ptJob.volumeUl);
      setPtSolvent(ptJob.solvent);
      if (ptJob.pairs && ptJob.completedPairs && ptJob.completedPairs.length < ptJob.pairs.length) {
        const nextPair = ptJob.pairs.find(([sw]) => !doneSrc.has(sw));
        if (nextPair) setPtDstStartWell(nextPair[1]);
      }
    }
  };

  const applyStockPreset = (st: (typeof deckStocks)[number]) => {
    setSrcPlate(st.plateId);
    setSrcSlot(st.slotId);
    setSrcZ(st.z);
    setSolvent(st.solvent);
  };

  const applySelectedDeckAs = (which: 'src' | 'dst') => {
    if (which === 'src') {
      setSrcPlate(selectedPlate);
      setSrcSlot(selectedSlot);
      const matched = deckStocks.find(
        (s) => s.plateId === selectedPlate && s.slotId === selectedSlot
      );
      if (matched) {
        setSrcZ(matched.z);
        setSolvent(matched.solvent);
      } else if (selectedPlate <= 2) {
        setSrcZ(2050);
      }
    } else {
      setDstPlate(selectedPlate);
      setDstSlot(selectedSlot);
      setDstZ(selectedPlate <= 2 ? 2100 : 1950);
    }
  };

  const formatSingleSlot = (plateId: number, slotId: number, fmt: ReturnType<typeof resolvePlateFormat> | null) => {
    if (plateId <= 2 && fmt) {
      return `${formatWellCode(slotId, fmt.cols)} (#${slotId})`;
    }
    return `pos ${slotId}`;
  };

  const handleRunSingle = () => {
    onRunCommand('single_transfer', {
      src_plate: srcPlate,
      src_slot: srcSlot,
      src_preset_id: srcPlate <= 2 ? srcPresetId : 'default_54',
      dst_plate: dstPlate,
      dst_slot: dstSlot,
      dst_preset_id: dstPlate <= 2 ? dstPresetId : 'default_54',
      volume_ul: Math.max(1, Math.min(2000, Number(volumeUl) || 100)),
      solvent,
      tip_type: tipType,
      src_z: Math.max(880, Math.min(2190, Math.round(srcZ))),
      dst_z: Math.max(880, Math.min(2190, Math.round(dstZ))),
      pick_tip: pickTip,
      prewet,
      mix_after: mixAfter,
      drop_tip: dropTip,
    });
  };

  const handleStartPlateTransfer = () => {
    if (ptPairs.length === 0) return;
    setPtConfirmStart(false);
    onRunCommand('plate_transfer_start', {
      src_plate: ptSrcPlate,
      dst_plate: ptDstPlate,
      src_preset_id: ptSrcFmt.id,
      dst_preset_id: ptDstFmt.id,
      wells: ptPairs.map((p) => p[0]),
      pairs: ptPairs,
      volume_ul: Math.max(1, Math.min(2000, Number(ptVolumeUl) || 50)),
      solvent: ptSolvent,
      tip_type: ptTipType,
      src_z: Math.max(880, Math.min(2190, Math.round(ptSrcZ))),
      dst_z: Math.max(880, Math.min(2190, Math.round(ptDstZ))),
      change_tip_each_vial: ptChangeTipEach,
      prewet: ptPrewet,
      mix_after: ptMixAfter,
      drop_tip_at_end: ptDropAtEnd,
    });
  };

  const openCalibrateForSlot = (slot: 0 | 1 | 2) => {
    setCalibrateSlotHint(slot);
    setMode('calibrate');
  };

  const ptRemainingUnfinished = ptJob
    ? (ptJob.pairs ? ptJob.pairs.length : (ptJob.wells || []).length) -
      (ptJob.completedPairs ? ptJob.completedPairs.length : (ptJob.completedList || []).length)
    : 0;

  return (
    <div
      style={{
        marginTop: '14px',
        padding: '14px',
        borderRadius: '10px',
        background: 'var(--soft)',
        border: '1px solid var(--line)',
      }}
    >
      {/* Header + 3-mode switcher */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '10px',
          flexWrap: 'wrap',
          marginBottom: '10px',
        }}
      >
        <div>
          <div
            style={{
              fontWeight: 700,
              fontSize: '13.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            {mode === 'plate' ? (
              <Grid3X3 size={15} />
            ) : mode === 'calibrate' ? (
              <Compass size={15} />
            ) : (
              <Droplets size={15} />
            )}
            <span>
              {mode === 'plate'
                ? 'Live Plate-to-Plate Transfer (54-Vial, 96-Well, 24-Well & Mixed)'
                : mode === 'calibrate'
                ? 'Plate Formats & 3-Corner Calibration'
                : 'Quick Single Transfer (No Excel Needed)'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
            {mode === 'plate'
              ? 'Transfer between matching or mixed plate formats (e.g., 54-vial → 96-well, 24-well → 96-well, or 96-well → 96-well) with live progress and safe stop/resume.'
              : mode === 'calibrate'
              ? 'Teach any 96-well, 24-well, 48-well, or custom plate once using just 3 corners—the robot calculates the exact well gap and plate tilt automatically.'
              : 'Top up a missed vial, make one blank, or move solvent from any bottle/jar to any vial or calibrated plate well.'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className={`btn sm${mode === 'single' ? ' pri' : ''}`}
            onClick={() => setMode('single')}
          >
            Single Transfer
          </button>
          <button
            type="button"
            className={`btn sm${mode === 'plate' ? ' pri' : ''}`}
            onClick={() => setMode('plate')}
          >
            Plate-to-Plate{ptActive ? ' (Running)' : ''}
          </button>
          <button
            type="button"
            className={`btn sm${mode === 'calibrate' ? ' pri' : ''}`}
            onClick={() => setMode('calibrate')}
          >
            Plate Setup{presets.length > 0 ? ` (${presets.length})` : ''}
          </button>
        </div>
      </div>

      {/* ==================== MODE A: SINGLE TRANSFER ==================== */}
      {mode === 'single' && (
        <>
          {deckStocks.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--mut)', marginBottom: '5px' }}>
                Quick-pick source from current run’s bottles:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {deckStocks.map((st) => {
                  const active = srcPlate === st.plateId && srcSlot === st.slotId;
                  return (
                    <button
                      key={st.key}
                      type="button"
                      className={`btn sm${active ? ' pri' : ''}`}
                      onClick={() => applyStockPreset(st)}
                      title={`plate${st.plateId} pos ${st.slotId} · ${st.solvent} · z=${st.z}${st.measured ? ' (measured)' : ' (estimated)'}`}
                    >
                      {st.label} · p{st.plateId}[{st.slotId}]
                      {st.measured ? ' ✓' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: '10px',
              marginBottom: '10px',
            }}
          >
            {/* Source */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '8px',
                  gap: '6px',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 700 }}>1. Aspirate From (Source)</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => applySelectedDeckAs('src')}
                  title={`Use currently selected deck map slot (plate${selectedPlate} pos ${selectedSlot})`}
                >
                  Use Map Slot
                </button>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  value={srcPlate}
                  onChange={(e) => {
                    const pl = Number(e.target.value);
                    setSrcPlate(pl);
                    setSrcPresetId('default_54');
                    setSrcSlot(0);
                  }}
                  style={{
                    flex: '1 1 130px',
                    height: '32px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value={3}>plate3 (Bottles 0–7)</option>
                  <option value={4}>plate4 (Bottles 0–7)</option>
                  <option value={5}>plate5 (Bottles 0–7)</option>
                  <option value={6}>plate6 (Jars 0–1)</option>
                  <option value={7}>plate7 (Jars 0–1)</option>
                  <option value={0}>plate0 (Plate A)</option>
                  <option value={1}>plate1 (Plate B)</option>
                  <option value={2}>plate2 (Plate C)</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={singleSrcMaxSlot}
                  value={srcSlot}
                  onChange={(e) =>
                    setSrcSlot(
                      Math.max(0, Math.min(singleSrcMaxSlot, Math.round(Number(e.target.value) || 0)))
                    )
                  }
                  className="mono"
                  aria-label="Source slot"
                  style={{
                    width: '66px',
                    height: '32px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                />
              </div>

              {srcPlate <= 2 && singleSrcOpts.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <select
                    value={srcPresetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setSrcPresetId(nextId);
                      const chosen = singleSrcOpts.find((o) => o.id === nextId);
                      if (chosen) {
                        setSrcZ(chosen.defaultZ);
                        setSrcSlot((s) => Math.min(chosen.rows * chosen.cols - 1, s));
                      }
                    }}
                    style={{
                      width: '100%',
                      height: '28px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11.5px',
                    }}
                  >
                    {singleSrcOpts.map((o) => (
                      <option key={o.id} value={o.id}>
                        Format: {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '8px',
                  fontSize: '11.5px',
                  color: 'var(--fg2)',
                }}
              >
                <label htmlFor="qt-src-z">
                  Liquid Z ({formatSingleSlot(srcPlate, srcSlot, singleSrcFmt)}):
                </label>
                <input
                  id="qt-src-z"
                  type="number"
                  min={880}
                  max={2190}
                  step={10}
                  value={srcZ}
                  onChange={(e) =>
                    setSrcZ(Math.max(880, Math.min(2190, Math.round(Number(e.target.value) || 1900))))
                  }
                  className="mono"
                  style={{
                    width: '84px',
                    height: '28px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                />
              </div>
            </div>

            {/* Destination */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '8px',
                  gap: '6px',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 700 }}>2. Dispense Into (Destination)</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => applySelectedDeckAs('dst')}
                  title={`Use currently selected deck map slot (plate${selectedPlate} pos ${selectedSlot})`}
                >
                  Use Map Slot
                </button>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  value={dstPlate}
                  onChange={(e) => {
                    const pl = Number(e.target.value);
                    setDstPlate(pl);
                    setDstPresetId('default_54');
                    setDstSlot(0);
                    setDstZ(pl <= 2 ? 2100 : 1950);
                  }}
                  style={{
                    flex: '1 1 130px',
                    height: '32px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value={0}>plate0 (Plate A)</option>
                  <option value={1}>plate1 (Plate B)</option>
                  <option value={2}>plate2 (Plate C)</option>
                  <option value={3}>plate3 (Bottles 0–7)</option>
                  <option value={4}>plate4 (Bottles 0–7)</option>
                  <option value={5}>plate5 (Bottles 0–7)</option>
                  <option value={6}>plate6 (Jars 0–1)</option>
                  <option value={7}>plate7 (Jars 0–1)</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={singleDstMaxSlot}
                  value={dstSlot}
                  onChange={(e) =>
                    setDstSlot(
                      Math.max(0, Math.min(singleDstMaxSlot, Math.round(Number(e.target.value) || 0)))
                    )
                  }
                  className="mono"
                  aria-label="Destination slot"
                  style={{
                    width: '66px',
                    height: '32px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                />
              </div>

              {dstPlate <= 2 && singleDstOpts.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <select
                    value={dstPresetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setDstPresetId(nextId);
                      const chosen = singleDstOpts.find((o) => o.id === nextId);
                      if (chosen) {
                        setDstZ(chosen.defaultZ);
                        setDstSlot((s) => Math.min(chosen.rows * chosen.cols - 1, s));
                      }
                    }}
                    style={{
                      width: '100%',
                      height: '28px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11.5px',
                    }}
                  >
                    {singleDstOpts.map((o) => (
                      <option key={o.id} value={o.id}>
                        Format: {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '8px',
                  fontSize: '11.5px',
                  color: 'var(--fg2)',
                }}
              >
                <label htmlFor="qt-dst-z">
                  Dispense Z ({formatSingleSlot(dstPlate, dstSlot, singleDstFmt)}):
                </label>
                <input
                  id="qt-dst-z"
                  type="number"
                  min={880}
                  max={2190}
                  step={10}
                  value={dstZ}
                  onChange={(e) =>
                    setDstZ(Math.max(880, Math.min(2190, Math.round(Number(e.target.value) || 2100))))
                  }
                  className="mono"
                  style={{
                    width: '84px',
                    height: '28px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                />
              </div>
            </div>

            {/* Volume, Solvent, Tip */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>
                3. Volume, Solvent &amp; Tip
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
                    Volume (µL)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    step={10}
                    value={volumeUl}
                    onChange={(e) =>
                      setVolumeUl(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))
                    }
                    className="mono"
                    style={{
                      width: '100%',
                      height: '32px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12.5px',
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
                    Solvent profile
                  </label>
                  <select
                    value={solvent}
                    onChange={(e) => setSolvent(e.target.value)}
                    style={{
                      width: '100%',
                      height: '32px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  >
                    {TRANSFER_SOLVENTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>Tip size:</span>
                <select
                  value={tipType}
                  onChange={(e) => setTipType(e.target.value as 'auto' | '50ul' | '300ul' | '1000ul')}
                  style={{
                    height: '28px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value="auto">Auto ({effectiveTip.replace('ul', ' µL')})</option>
                  <option value="50ul">50 µL tip</option>
                  <option value="300ul">300 µL tip</option>
                  <option value="1000ul">1000 µL tip</option>
                </select>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              paddingTop: '8px',
              borderTop: '1px solid var(--line2)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '12px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={pickTip} onChange={(e) => setPickTip(e.target.checked)} />
                <span>Pick fresh tip</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={prewet} onChange={(e) => setPrewet(e.target.checked)} />
                <span>Pre-wet tip</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={mixAfter} onChange={(e) => setMixAfter(e.target.checked)} />
                <span>Mix 3× after dispense</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={dropTip} onChange={(e) => setDropTip(e.target.checked)} />
                <span>Drop tip when done</span>
              </label>
            </div>

            <button
              type="button"
              className="btn sm pri"
              disabled={cmdBusy || ptActive}
              onClick={handleRunSingle}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Play size={13} />
              <span>Run Single Transfer</span>
            </button>
          </div>

          <div
            style={{
              marginTop: '8px',
              fontSize: '11.5px',
              color: 'var(--fg2)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
            }}
          >
            <FlaskConical size={12} style={{ color: 'var(--acc)', flexShrink: 0 }} />
            <span>
              Plan: draw <strong className="mono">{volumeUl} µL</strong> of <strong>{solvent}</strong> from{' '}
              <span className="mono">
                plate{srcPlate} {formatSingleSlot(srcPlate, srcSlot, singleSrcFmt)} (z={srcZ})
              </span>
            </span>
            <ArrowRight size={12} style={{ color: 'var(--mut)' }} />
            <span className="mono">
              plate{dstPlate} {formatSingleSlot(dstPlate, dstSlot, singleDstFmt)} (z={dstZ})
            </span>
            <span>
              with a <strong>{effectiveTip.replace('ul', ' µL')}</strong> tip (auto-probe OFF).
            </span>
          </div>
        </>
      )}

      {/* ==================== MODE B: PLATE-TO-PLATE TRANSFER ==================== */}
      {mode === 'plate' && (
        <div>
          {/* Live / Last Plate Transfer Progress Banner */}
          {ptJob && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                marginBottom: '12px',
                background:
                  ptJob.state === 'error'
                    ? 'color-mix(in srgb, var(--bad) 10%, var(--panel))'
                    : ptJob.state === 'completed'
                    ? 'color-mix(in srgb, var(--ok) 10%, var(--panel))'
                    : 'color-mix(in srgb, var(--acc) 10%, var(--panel))',
                border: `1px solid ${
                  ptJob.state === 'error'
                    ? 'var(--bad)'
                    : ptJob.state === 'completed'
                    ? 'var(--ok)'
                    : 'var(--acc)'
                }`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  marginBottom: '6px',
                }}
              >
                <div style={{ fontSize: '12.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {ptJob.state === 'completed' ? (
                    <CheckCircle2 size={15} style={{ color: 'var(--ok)' }} />
                  ) : ptJob.state === 'error' ? (
                    <AlertTriangle size={15} style={{ color: 'var(--bad)' }} />
                  ) : (
                    <FlaskConical size={15} style={{ color: 'var(--acc)' }} />
                  )}
                  <span>{ptJob.message}</span>
                </div>

                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: '12px', fontWeight: 700 }}>
                    {ptJob.completedWells} / {ptJob.totalWells} wells
                  </span>
                  {ptActive ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => onRunCommand('plate_transfer_stop')}
                      style={{
                        background: 'var(--bad)',
                        color: '#ffffff',
                        borderColor: 'var(--bad)',
                        fontWeight: 700,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                      }}
                    >
                      <Square size={12} />
                      <span>Stop After Current Well</span>
                    </button>
                  ) : (
                    ptRemainingUnfinished > 0 && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={selectRemainingFromLastJob}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      >
                        <RotateCcw size={12} />
                        <span>Select Remaining {ptRemainingUnfinished} Wells</span>
                      </button>
                    )
                  )}
                </div>
              </div>

              <div
                style={{
                  height: '7px',
                  borderRadius: '999px',
                  background: 'var(--bg)',
                  overflow: 'hidden',
                  border: '1px solid var(--line2)',
                }}
              >
                <div
                  style={{
                    width: `${
                      ptJob.totalWells > 0
                        ? Math.round((ptJob.completedWells / ptJob.totalWells) * 100)
                        : 0
                    }%`,
                    height: '100%',
                    background:
                      ptJob.state === 'error'
                        ? 'var(--bad)'
                        : ptJob.state === 'completed'
                        ? 'var(--ok)'
                        : 'var(--acc)',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Source & Destination Plates + Formats + Volume/Solvent/Tip */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: '10px',
              marginBottom: '10px',
            }}
          >
            {/* Source Plate & Format */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>1. Source Plate &amp; Format</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={ptActive}
                  onClick={() => openCalibrateForSlot(ptSrcPlate)}
                  style={{ fontSize: '10.5px', padding: '2px 7px' }}
                >
                  + Calibrate
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <select
                  value={ptSrcPlate}
                  disabled={ptActive}
                  onChange={(e) => {
                    const p = Number(e.target.value) as 0 | 1 | 2;
                    setPtSrcPlate(p);
                    setPtSrcPresetId('default_54');
                    if (p === ptDstPlate) {
                      setPtDstPlate(((p + 1) % 3) as 0 | 1 | 2);
                      setPtDstPresetId('default_54');
                    }
                  }}
                  style={{
                    width: '100%',
                    height: '30px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value={0}>plate0 (Plate A)</option>
                  <option value={1}>plate1 (Plate B)</option>
                  <option value={2}>plate2 (Plate C)</option>
                </select>
                <select
                  value={ptSrcFmt.id}
                  disabled={ptActive}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setPtSrcPresetId(nextId);
                    const chosen = ptSrcOpts.find((o) => o.id === nextId);
                    if (chosen) setPtSrcZ(chosen.defaultZ);
                  }}
                  style={{
                    width: '100%',
                    height: '30px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  {ptSrcOpts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Source liquid Z:</span>
                  <input
                    type="number"
                    min={880}
                    max={2190}
                    step={10}
                    disabled={ptActive}
                    value={ptSrcZ}
                    onChange={(e) =>
                      setPtSrcZ(Math.max(880, Math.min(2190, Math.round(Number(e.target.value) || 2100))))
                    }
                    className="mono"
                    style={{
                      width: '84px',
                      height: '28px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Destination Plate & Format */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>2. Destination Plate &amp; Format</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={ptActive}
                  onClick={() => openCalibrateForSlot(ptDstPlate)}
                  style={{ fontSize: '10.5px', padding: '2px 7px' }}
                >
                  + Calibrate
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <select
                  value={ptDstPlate}
                  disabled={ptActive}
                  onChange={(e) => {
                    const p = Number(e.target.value) as 0 | 1 | 2;
                    setPtDstPlate(p);
                    setPtDstPresetId('default_54');
                    if (p === ptSrcPlate) {
                      setPtSrcPlate(((p + 2) % 3) as 0 | 1 | 2);
                      setPtSrcPresetId('default_54');
                    }
                  }}
                  style={{
                    width: '100%',
                    height: '30px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value={0}>plate0 (Plate A)</option>
                  <option value={1}>plate1 (Plate B)</option>
                  <option value={2}>plate2 (Plate C)</option>
                </select>
                <select
                  value={ptDstFmt.id}
                  disabled={ptActive}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setPtDstPresetId(nextId);
                    const chosen = ptDstOpts.find((o) => o.id === nextId);
                    if (chosen) setPtDstZ(chosen.defaultZ);
                  }}
                  style={{
                    width: '100%',
                    height: '30px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  {ptDstOpts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Dest dispense Z:</span>
                  <input
                    type="number"
                    min={880}
                    max={2190}
                    step={10}
                    disabled={ptActive}
                    value={ptDstZ}
                    onChange={(e) =>
                      setPtDstZ(Math.max(880, Math.min(2190, Math.round(Number(e.target.value) || 2100))))
                    }
                    className="mono"
                    style={{
                      width: '84px',
                      height: '28px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Volume, Solvent, Tip */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>
                3. Per-Well Volume, Solvent &amp; Tip
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
                    Volume / well (µL)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    step={5}
                    disabled={ptActive}
                    value={ptVolumeUl}
                    onChange={(e) =>
                      setPtVolumeUl(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))
                    }
                    className="mono"
                    style={{
                      width: '100%',
                      height: '30px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
                    Solvent profile
                  </label>
                  <select
                    value={ptSolvent}
                    disabled={ptActive}
                    onChange={(e) => setPtSolvent(e.target.value)}
                    style={{
                      width: '100%',
                      height: '30px',
                      padding: '0 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '12px',
                    }}
                  >
                    {TRANSFER_SOLVENTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>Tip size:</span>
                <select
                  value={ptTipType}
                  disabled={ptActive}
                  onChange={(e) => setPtTipType(e.target.value as 'auto' | '50ul' | '300ul' | '1000ul')}
                  style={{
                    height: '28px',
                    padding: '0 8px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '12px',
                  }}
                >
                  <option value="auto">Auto ({ptEffectiveTip.replace('ul', ' µL')})</option>
                  <option value="50ul">50 µL tip</option>
                  <option value="300ul">300 µL tip</option>
                  <option value="1000ul">1000 µL tip</option>
                </select>
              </div>
              {ptHas96OrDenser && ptEffectiveTip === '1000ul' && (
                <div style={{ fontSize: '11px', color: 'var(--warn)', marginTop: '6px' }}>
                  Note: 96-well openings are narrow — 50 µL or 300 µL tips are safer than 1000 µL.
                </div>
              )}
            </div>
          </div>

          {/* Mapping Controls (Always visible for mixed-format, optional toggle for same-format) */}
          <div
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              marginBottom: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              flexWrap: 'wrap',
              fontSize: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700 }}>
                {sameShape ? 'Well Mapping:' : 'Mixed-Format Mapping:'}
              </span>
              {sameShape ? (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    disabled={ptActive}
                    checked={ptUseCustomOffset}
                    onChange={(e) => setPtUseCustomOffset(e.target.checked)}
                  />
                  <span>Shift destination starting well</span>
                </label>
              ) : (
                <span style={{ fontSize: '11.5px', color: 'var(--acc)', fontWeight: 600 }}>
                  {ptSrcFmt.rows}×{ptSrcFmt.cols} → {ptDstFmt.rows}×{ptDstFmt.cols}
                </span>
              )}
            </div>

            {showMixedMapping && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' }}>
                  <span>Start at dest well:</span>
                  <select
                    value={ptDstStartWell}
                    disabled={ptActive}
                    onChange={(e) => setPtDstStartWell(Number(e.target.value))}
                    className="mono"
                    style={{
                      height: '26px',
                      padding: '0 6px',
                      borderRadius: '5px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11.5px',
                    }}
                  >
                    {Array.from({ length: dstTotalWells }, (_, idx) => (
                      <option key={idx} value={idx}>
                        {formatWellCode(idx, ptDstFmt.cols)} (#{idx})
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' }}>
                  <span>Fill order:</span>
                  <select
                    value={ptFillOrder}
                    disabled={ptActive}
                    onChange={(e) => setPtFillOrder(e.target.value as 'row' | 'col')}
                    style={{
                      height: '26px',
                      padding: '0 6px',
                      borderRadius: '5px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11.5px',
                    }}
                  >
                    <option value="row">Across rows (A1 → A2…)</option>
                    <option value="col">Down columns (A1 → B1…)</option>
                  </select>
                </label>
              </div>
            )}
          </div>

          {ptOverflowCount > 0 && (
            <div
              style={{
                padding: '7px 10px',
                borderRadius: '7px',
                marginBottom: '10px',
                background: 'color-mix(in srgb, var(--warn) 14%, var(--panel))',
                border: '1px solid var(--warn)',
                fontSize: '11.5px',
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
              }}
            >
              <AlertTriangle size={14} style={{ color: 'var(--warn)', flexShrink: 0 }} />
              <span>
                <strong>{ptOverflowCount} selected source well(s)</strong> do not fit on the destination plate starting at{' '}
                <strong className="mono">{formatWellCode(ptDstStartWell, ptDstFmt.cols)}</strong>. Only the first{' '}
                <strong>{ptPairs.length}</strong> wells will be transferred—move the start well earlier or select fewer source wells.
              </span>
            </div>
          )}

          {/* Interactive Well Grid(s): single grid when 1-to-1, side-by-side grids when mixed/shifted */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: showMixedMapping
                ? 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))'
                : '1fr',
              gap: '10px',
              marginBottom: '10px',
            }}
          >
            {/* Source Plate Interactive Grid */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--panel)',
                border: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  marginBottom: '8px',
                }}
              >
                <div style={{ fontSize: '12px', fontWeight: 700 }}>
                  {showMixedMapping
                    ? `Source: plate${ptSrcPlate} (${ptSrcFmt.rows}×${ptSrcFmt.cols}) — ${ptSelectedWells.length}/${srcTotalWells} selected`
                    : `4. Wells to Transfer (${ptSelectedWells.length} / ${srcTotalWells} selected) — tap wells or rows`}
                </div>
                <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={ptActive}
                    onClick={() =>
                      setPtSelectedWells(Array.from({ length: srcTotalWells }, (_, i) => i))
                    }
                  >
                    All {srcTotalWells}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={ptActive}
                    onClick={() =>
                      setPtSelectedWells(
                        Array.from({ length: Math.ceil(srcTotalWells / 2) }, (_, i) => i)
                      )
                    }
                  >
                    First {Math.ceil(srcTotalWells / 2)}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={ptActive}
                    onClick={() => setPtSelectedWells([])}
                  >
                    Clear
                  </button>
                  <span style={{ fontSize: '11px', color: 'var(--mut)', marginLeft: '2px' }}>Range #:</span>
                  <input
                    type="number"
                    min={0}
                    max={srcTotalWells - 1}
                    disabled={ptActive}
                    value={ptRangeStart}
                    onChange={(e) => setPtRangeStart(Number(e.target.value) || 0)}
                    className="mono"
                    aria-label="Range start well index"
                    style={{
                      width: '48px',
                      height: '26px',
                      padding: '0 4px',
                      borderRadius: '5px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11px',
                    }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--mut)' }}>–</span>
                  <input
                    type="number"
                    min={0}
                    max={srcTotalWells - 1}
                    disabled={ptActive}
                    value={ptRangeEnd}
                    onChange={(e) => setPtRangeEnd(Number(e.target.value) || 0)}
                    className="mono"
                    aria-label="Range end well index"
                    style={{
                      width: '48px',
                      height: '26px',
                      padding: '0 4px',
                      borderRadius: '5px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--fg)',
                      fontSize: '11px',
                    }}
                  />
                  <button type="button" className="btn sm" disabled={ptActive} onClick={applyRange}>
                    Apply
                  </button>
                </div>
              </div>

              <div style={{ overflowX: 'auto', paddingBottom: '2px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `28px repeat(${ptSrcFmt.cols}, minmax(${ptSrcFmt.cols >= 12 ? '26px' : '32px'}, 1fr))`,
                    gap: '3px',
                    minWidth: `${28 + ptSrcFmt.cols * (ptSrcFmt.cols >= 12 ? 29 : 36)}px`,
                  }}
                >
                  {Array.from({ length: ptSrcFmt.rows }, (_, rIdx) => {
                    const rLbl = rowLetter(rIdx);
                    const rowWells = Array.from({ length: ptSrcFmt.cols }, (_, c) => rIdx * ptSrcFmt.cols + c);
                    const rowAllSelected = rowWells.every((w) => selectedSet.has(w));
                    return (
                      <React.Fragment key={rIdx}>
                        <button
                          type="button"
                          disabled={ptActive}
                          onClick={() => toggleRow(rIdx)}
                          title={`Toggle entire row ${rLbl}`}
                          style={{
                            height: '26px',
                            borderRadius: '4px',
                            border: '1px solid var(--line)',
                            background: rowAllSelected ? 'var(--acc)' : 'var(--bg)',
                            color: rowAllSelected ? '#ffffff' : 'var(--fg2)',
                            fontWeight: 700,
                            fontSize: '10.5px',
                            cursor: ptActive ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {rLbl}
                        </button>
                        {rowWells.map((wellId) => {
                          const isSel = selectedSet.has(wellId);
                          const mappedDst = srcToDstMap.get(wellId);
                          const isDroppedOverflow = isSel && mappedDst === undefined;
                          const isDone =
                            ptJob != null &&
                            ptJob.srcPlate === ptSrcPlate &&
                            completedSrcSet.has(wellId);
                          const isCurr =
                            ptActive &&
                            ptJob?.srcPlate === ptSrcPlate &&
                            ptJob?.currentWell === wellId;
                          const isFail =
                            ptJob?.state === 'error' &&
                            ptJob?.srcPlate === ptSrcPlate &&
                            ptJob?.failedWell === wellId;

                          let bg = 'var(--bg)';
                          let border = 'var(--line)';
                          let color = 'var(--mut)';
                          if (isFail) {
                            bg = 'color-mix(in srgb, var(--bad) 24%, var(--bg))';
                            border = 'var(--bad)';
                            color = 'var(--fg)';
                          } else if (isCurr) {
                            bg = 'var(--acc)';
                            border = 'var(--acc)';
                            color = '#ffffff';
                          } else if (isDone) {
                            bg = 'color-mix(in srgb, var(--ok) 22%, var(--bg))';
                            border = 'var(--ok)';
                            color = 'var(--fg)';
                          } else if (isDroppedOverflow) {
                            bg = 'color-mix(in srgb, var(--warn) 18%, var(--bg))';
                            border = 'var(--warn)';
                            color = 'var(--fg)';
                          } else if (isSel) {
                            bg = 'color-mix(in srgb, var(--acc) 18%, var(--bg))';
                            border = 'var(--acc)';
                            color = 'var(--fg)';
                          }

                          const code = formatWellCode(wellId, ptSrcFmt.cols);
                          const dstCode =
                            mappedDst !== undefined
                              ? formatWellCode(mappedDst, ptDstFmt.cols)
                              : 'overflow';

                          return (
                            <button
                              key={wellId}
                              type="button"
                              disabled={ptActive}
                              onClick={() => toggleWell(wellId)}
                              className="mono"
                              title={
                                isSel
                                  ? `${code} (#${wellId}) → plate${ptDstPlate} ${dstCode}`
                                  : `Click to select ${code} (#${wellId})`
                              }
                              style={{
                                height: '26px',
                                borderRadius: '4px',
                                border: `1px solid ${border}`,
                                background: bg,
                                color,
                                fontSize: ptSrcFmt.cols >= 12 ? '9.5px' : '10.5px',
                                fontWeight: isSel || isCurr || isDone ? 700 : 500,
                                cursor: ptActive ? 'not-allowed' : 'pointer',
                                padding: 0,
                              }}
                            >
                              {code}
                            </button>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Destination Preview Grid (shown when formats differ or offset is shifted) */}
            {showMixedMapping && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--panel)',
                  border: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                    marginBottom: '8px',
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: 700 }}>
                    Destination Preview: plate{ptDstPlate} ({ptDstFmt.rows}×{ptDstFmt.cols})
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--mut)' }}>
                    Tap any well to set starting position (currently{' '}
                    <strong className="mono">{formatWellCode(ptDstStartWell, ptDstFmt.cols)}</strong>)
                  </span>
                </div>

                <div style={{ overflowX: 'auto', paddingBottom: '2px' }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `24px repeat(${ptDstFmt.cols}, minmax(${ptDstFmt.cols >= 12 ? '26px' : '32px'}, 1fr))`,
                      gap: '3px',
                      minWidth: `${24 + ptDstFmt.cols * (ptDstFmt.cols >= 12 ? 29 : 36)}px`,
                    }}
                  >
                    {Array.from({ length: ptDstFmt.rows }, (_, rIdx) => {
                      const rLbl = rowLetter(rIdx);
                      return (
                        <React.Fragment key={rIdx}>
                          <div
                            style={{
                              height: '26px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10.5px',
                              fontWeight: 700,
                              color: 'var(--mut)',
                            }}
                          >
                            {rLbl}
                          </div>
                          {Array.from({ length: ptDstFmt.cols }, (_, cIdx) => {
                            const dstId = rIdx * ptDstFmt.cols + cIdx;
                            const mappedSrc = dstToSrcMap.get(dstId);
                            const isMapped = mappedSrc !== undefined;
                            const isStart = dstId === ptDstStartWell;
                            const isDone =
                              ptJob != null &&
                              ptJob.dstPlate === ptDstPlate &&
                              completedDstSet.has(dstId);
                            const isCurr =
                              ptActive &&
                              ptJob?.dstPlate === ptDstPlate &&
                              ptJob?.currentPair?.[1] === dstId;
                            const isFail =
                              ptJob?.state === 'error' &&
                              ptJob?.dstPlate === ptDstPlate &&
                              ptJob?.failedPair?.[1] === dstId;

                            let bg = 'var(--bg)';
                            let border = 'var(--line2)';
                            let color = 'var(--mut)';
                            if (isFail) {
                              bg = 'color-mix(in srgb, var(--bad) 24%, var(--bg))';
                              border = 'var(--bad)';
                              color = 'var(--fg)';
                            } else if (isCurr) {
                              bg = 'var(--acc)';
                              border = 'var(--acc)';
                              color = '#ffffff';
                            } else if (isDone) {
                              bg = 'color-mix(in srgb, var(--ok) 22%, var(--bg))';
                              border = 'var(--ok)';
                              color = 'var(--fg)';
                            } else if (isMapped) {
                              bg = 'color-mix(in srgb, var(--acc) 18%, var(--bg))';
                              border = isStart ? 'var(--fg)' : 'var(--acc)';
                              color = 'var(--fg)';
                            } else if (isStart) {
                              border = 'var(--acc)';
                            }

                            const dstCode = formatWellCode(dstId, ptDstFmt.cols);
                            const srcCode =
                              mappedSrc !== undefined
                                ? formatWellCode(mappedSrc, ptSrcFmt.cols)
                                : '';

                            return (
                              <button
                                key={dstId}
                                type="button"
                                disabled={ptActive}
                                onClick={() => setPtDstStartWell(dstId)}
                                className="mono"
                                title={
                                  isMapped
                                    ? `${dstCode} receives plate${ptSrcPlate} ${srcCode} (click to start here)`
                                    : `Click to start destination fill at ${dstCode}`
                                }
                                style={{
                                  height: '26px',
                                  borderRadius: '4px',
                                  border: `${isStart ? '1.5px' : '1px'} solid ${border}`,
                                  background: bg,
                                  color,
                                  fontSize: ptDstFmt.cols >= 12 ? '9.5px' : '10.5px',
                                  fontWeight: isMapped || isStart ? 700 : 400,
                                  cursor: ptActive ? 'not-allowed' : 'pointer',
                                  padding: 0,
                                }}
                              >
                                {dstCode}
                              </button>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Tip rack shortage warning */}
          {ptTipShortage && ptMatchingRack && (
            <div
              style={{
                padding: '8px 10px',
                borderRadius: '7px',
                marginBottom: '10px',
                background: 'color-mix(in srgb, var(--warn) 14%, var(--panel))',
                border: '1px solid var(--warn)',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertTriangle size={15} style={{ color: 'var(--warn)', flexShrink: 0 }} />
              <span>
                You selected <strong>{ptPairs.length} wells</strong> with fresh tips, which needs{' '}
                <strong>{ptTipsNeeded}</strong> {ptEffectiveTip.replace('ul', ' µL')} tips—your rack currently has{' '}
                <strong>{ptMatchingRack.remaining}</strong> left. Reload the tip rack first, or run in two batches using Stop / Resume.
              </span>
            </div>
          )}

          {/* Options + 2-step safe Start button */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              paddingTop: '8px',
              borderTop: '1px solid var(--line2)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '12px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  disabled={ptActive}
                  checked={ptChangeTipEach}
                  onChange={(e) => setPtChangeTipEach(e.target.checked)}
                />
                <span>
                  <strong>Fresh tip every well</strong> (no cross-contamination)
                </span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  disabled={ptActive}
                  checked={ptPrewet}
                  onChange={(e) => setPtPrewet(e.target.checked)}
                />
                <span>Pre-wet tips</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  disabled={ptActive}
                  checked={ptMixAfter}
                  onChange={(e) => setPtMixAfter(e.target.checked)}
                />
                <span>Mix 3× in dest</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  disabled={ptActive}
                  checked={ptDropAtEnd}
                  onChange={(e) => setPtDropAtEnd(e.target.checked)}
                />
                <span>Drop tip at end</span>
              </label>
            </div>

            {ptActive ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => onRunCommand('plate_transfer_stop')}
                style={{
                  background: 'var(--bad)',
                  color: '#ffffff',
                  borderColor: 'var(--bad)',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Square size={13} />
                <span>Stop After Current Well</span>
              </button>
            ) : !ptConfirmStart ? (
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy || ptPairs.length === 0}
                onClick={() => setPtConfirmStart(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <Play size={13} />
                <span>Start Transfer ({ptPairs.length} Wells)</span>
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setPtConfirmStart(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={cmdBusy || ptPairs.length === 0}
                  onClick={handleStartPlateTransfer}
                  style={{
                    background: 'var(--ok)',
                    color: '#ffffff',
                    borderColor: 'var(--ok)',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Play size={13} />
                  <span>Confirm: Move {ptPairs.length} Wells Now</span>
                </button>
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: '8px',
              fontSize: '11.5px',
              color: 'var(--fg2)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
            }}
          >
            <Grid3X3 size={12} style={{ color: 'var(--acc)', flexShrink: 0 }} />
            <span>
              Plan: copy <strong className="mono">{ptPairs.length}</strong> wells (<strong className="mono">{ptVolumeUl} µL</strong> {ptSolvent}) from{' '}
              <strong className="mono">plate{ptSrcPlate} ({ptSrcFmt.rows}×{ptSrcFmt.cols})</strong> →{' '}
              <strong className="mono">plate{ptDstPlate} ({ptDstFmt.rows}×{ptDstFmt.cols})</strong>
              {ptPairs.length > 0 && (
                <>
                  {' '}
                  (<span className="mono">
                    {formatWellCode(ptPairs[0][0], ptSrcFmt.cols)}→{formatWellCode(ptPairs[0][1], ptDstFmt.cols)}
                  </span>
                  {ptPairs.length > 1 && (
                    <>
                      {' … '}
                      <span className="mono">
                        {formatWellCode(ptPairs[ptPairs.length - 1][0], ptSrcFmt.cols)}→
                        {formatWellCode(ptPairs[ptPairs.length - 1][1], ptDstFmt.cols)}
                      </span>
                    </>
                  )}
                  )
                </>
              )}
              {' · '}Uses <strong>{ptTipsNeeded}</strong> {ptEffectiveTip.replace('ul', ' µL')} tip{ptTipsNeeded === 1 ? '' : 's'} · Est.{' '}
              <strong>{ptEstLabel}</strong>.
            </span>
          </div>
        </div>
      )}

      {/* ==================== MODE C: PLATE FORMATS & 3-CORNER CALIBRATION ==================== */}
      {mode === 'calibrate' && (
        <PlateCalibrationPanel
          hw={hw}
          cmdBusy={cmdBusy}
          ptActive={ptActive}
          initialSlot={calibrateSlotHint}
          onRunCommand={onRunCommand}
          onPresetSaved={(presetId, slot) => {
            if (slot === ptSrcPlate) setPtSrcPresetId(presetId);
            if (slot === ptDstPlate) setPtDstPresetId(presetId);
          }}
        />
      )}
    </div>
  );
};
