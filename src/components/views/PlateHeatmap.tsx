// Robowski Studio - Precision Laboratory 2D Microplate Heatmap
// Aesthetic & Functional Architecture:
// - Authentic SBS microplate frame with A1 orientation notch
// - Clean, flat, calibrated well design with disciplined typography
// - High-contrast, scientifically validated color mappings (clean neutral 1x with intentional dilution tiers)
// - Subtle interactive crosshair axis highlights
// - Integrated live well HUD with instant reaction parameters
import React, { useState, useMemo } from 'react';
import { RunResult, RunState, TlcSet, TlcSpot, TlcLane } from '../../types';
import {
  PAL,
  findSpots,
  tlcOrigin,
  tlcFront,
  TLC_SIGNAL,
  TlcChannelKey,
  wellLabel,
  containerOfLane,
  tlcLane,
} from '../../engine';
import { extractLaneProfile } from './TlcView';
import { useApp } from '../../context/AppContext';

interface PlateHeatmapProps {
  run: RunResult;
  state: RunState;
  triMeta: any[];
  blockSet: Set<number>;
  filterMode: 'all' | 'diluted' | 'high_solvent' | 'low_solvent' | 'bad';
  selectedVial: number | null;
  onSelectVial: (globalIndex: number | null) => void;
  metric: string;
  onMetricChange: (m: string) => void;
  plateIndex: number;
  onPlateChange: (p: number) => void;
  onNavigateTlc?: (vialIndex: number) => void;
  tlcSets?: TlcSet[];
}

export const PlateHeatmap: React.FC<PlateHeatmapProps> = ({
  run,
  state,
  triMeta,
  blockSet,
  filterMode,
  selectedVial,
  onSelectVial,
  metric,
  onMetricChange,
  plateIndex,
  onPlateChange,
  onNavigateTlc,
  tlcSets,
}) => {
  const { spotProminence } = useApp();
  const PLATE_SIZE = 54;
  const COLS = 9;
  const ROWS = 6;
  const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const factor = +state.dilutionFactor || 5;
  const vialVol = +state.vialVolume || 500;

  // Visual customization state
  const [wellShape, setWellShape] = useState<'circular' | 'rounded'>('circular');
  const [hoveredVial, setHoveredVial] = useState<number | null>(null);

  // Active well focus (hover takes temporary preview priority over selection)
  const activeFocusVial = hoveredVial !== null ? hoveredVial : selectedVial;
  const activeHoverRow = activeFocusVial !== null ? Math.floor((activeFocusVial % PLATE_SIZE) / COLS) : null;
  const activeHoverCol = activeFocusVial !== null ? (activeFocusVial % PLATE_SIZE) % COLS : null;

  // Derive TLC spot data for each lane on this plate
  const activeTlcSet = (tlcSets && (tlcSets[plateIndex] || tlcSets[0])) || null;
  const tlcLanes = activeTlcSet?.cfg?.lanes || [];
  const hasTlcImages = Boolean(
    activeTlcSet?.imgs.UV254?.bmp ||
    activeTlcSet?.imgs.UV366?.bmp ||
    activeTlcSet?.imgs.White?.bmp
  );
  const hasDualChannels = Boolean(activeTlcSet?.imgs.UV254?.bmp && activeTlcSet?.imgs.UV366?.bmp);

  // TLC Channel filter for Heatmap (all/merged by default so no peaks are missed)
  const [tlcChannelFilter, setTlcChannelFilter] = useState<'all' | 'UV254' | 'UV366'>('all');

  // Map each well container index (k = 0..53) to its detected spots
  const wellTlcData = useMemo(() => {
    const map = new Map<number, { count: number; spots: TlcSpot[]; mainRf: number | null; deltaRf: number | null; laneId: number }>();
    if (!activeTlcSet || !hasTlcImages || tlcLanes.length === 0) return map;

    const getProf = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, 0.35);

    tlcLanes.forEach((lane) => {
      try {
        const oVal = tlcOrigin(activeTlcSet, lane, getProf);
        const fVal = tlcFront(activeTlcSet, lane, getProf as any);

        const channelsToCheck: TlcChannelKey[] = [];
        if (tlcChannelFilter === 'all') {
          if (activeTlcSet.imgs.UV254?.bmp) channelsToCheck.push('UV254');
          if (activeTlcSet.imgs.UV366?.bmp) channelsToCheck.push('UV366');
          if (activeTlcSet.imgs.White?.bmp && channelsToCheck.length === 0) channelsToCheck.push('White');
        } else {
          if (activeTlcSet.imgs[tlcChannelFilter]?.bmp) {
            channelsToCheck.push(tlcChannelFilter);
          } else if (activeTlcSet.imgs.UV254?.bmp) {
            channelsToCheck.push('UV254');
          } else if (activeTlcSet.imgs.UV366?.bmp) {
            channelsToCheck.push('UV366');
          }
        }

        let mergedSpots: TlcSpot[] = [];

        for (const ch of channelsToCheck) {
          const prof = getProf(activeTlcSet, ch, lane);
          if (prof && prof.length > 0) {
            const chSpots = findSpots(prof, {
              sign: TLC_SIGNAL[ch]?.sign ?? -1,
              origin: oVal,
              front: fVal,
              radius: lane.spotRadius || 24,
              minProminence: spotProminence,
            });

            if (chSpots && chSpots.length > 0) {
              if (mergedSpots.length === 0) {
                mergedSpots = [...chSpots];
              } else {
                for (const sp of chSpots) {
                  const match = mergedSpots.find((m) => Math.abs(m.rf - sp.rf) < 0.04);
                  if (!match) {
                    mergedSpots.push(sp);
                  } else if (sp.strength > match.strength) {
                    match.strength = sp.strength;
                    match.pos = sp.pos;
                  }
                }
              }
            }
          }
        }

        mergedSpots.sort((a, b) => a.rf - b.rf);
        const strongest = [...mergedSpots].sort((a, b) => b.strength - a.strength);
        const mainRf = strongest.length > 0 ? strongest[0].rf : null;
        let deltaRf: number | null = null;
        if (mergedSpots.length >= 2) {
          deltaRf = +(mergedSpots[mergedSpots.length - 1].rf - mergedSpots[0].rf).toFixed(2);
        }

        // CRITICAL FIX: TLC lanes are indexed 0..53 column-major.
        // Container index k on the 54-well microplate (0..53) is row-major.
        // containerOfLane(lane.id) transforms lane -> well container index!
        const wellIdx = containerOfLane(lane.id);

        map.set(wellIdx, {
          count: mergedSpots.length,
          spots: mergedSpots,
          mainRf,
          deltaRf,
          laneId: lane.id,
        });
      } catch {
        // Skip corrupted lane
      }
    });

    return map;
  }, [activeTlcSet, hasTlcImages, tlcLanes, tlcChannelFilter, spotProminence]);

  const rcol = (i: number) => PAL[i % PAL.length];

  // Number formatting
  const nf = (v: any, d = 1) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  // Compute stats and bounds for current metric across the run
  const activeReagentIndex = metric.startsWith('reagent:')
    ? parseInt(metric.split(':')[1], 10)
    : -1;
  const activeEquivIndex = metric.startsWith('reagent_equiv:')
    ? parseInt(metric.split(':')[1], 10)
    : -1;

  let minMetric = Infinity;
  let maxMetric = -Infinity;

  run.rows.forEach((row) => {
    if (activeReagentIndex >= 0) {
      const conc = row.recipe[activeReagentIndex]?.target_concentration || 0;
      minMetric = Math.min(minMetric, conc);
      maxMetric = Math.max(maxMetric, conc);
    } else if (activeEquivIndex >= 0) {
      const eq = row.recipe[activeEquivIndex]?.value || 0;
      minMetric = Math.min(minMetric, eq);
      maxMetric = Math.max(maxMetric, eq);
    } else if (metric === 'solvent') {
      const solv = +row['vol#solvent'] || 0;
      minMetric = Math.min(minMetric, solv);
      maxMetric = Math.max(maxMetric, solv);
    } else if (metric === 'total_vol') {
      const tot = run.vialVolume || 500;
      minMetric = Math.min(minMetric, tot);
      maxMetric = Math.max(maxMetric, tot);
    }
  });

  if (minMetric === Infinity) minMetric = 0;
  if (maxMetric === -Infinity) maxMetric = 1;

  const startIdx = plateIndex * PLATE_SIZE;
  const endIdx = Math.min(run.rows.length, startIdx + PLATE_SIZE);
  const plateRows = run.rows.slice(startIdx, endIdx);

  // Check if a row matches the active filter
  const matchesFilter = (ri: number) => {
    const row = run.rows[ri];
    if (!row) return false;
    const isBad = blockSet.has(ri);
    if (filterMode === 'bad') return isBad;
    if (filterMode === 'diluted') {
      return row.recipe.some((rc) => rc.dilution_level > 0);
    }
    if (filterMode === 'high_solvent') {
      return +row['vol#solvent'] >= vialVol * 0.75;
    }
    if (filterMode === 'low_solvent') {
      return +row['vol#solvent'] < vialVol * 0.3;
    }
    return true;
  };

  // Metric options
  const metricOptions: Array<{ id: string; label: string }> = [
    { id: 'dilution', label: '💧 Dilution Level (1× / 5× / 25×)' },
    { id: 'solvent', label: '🧪 Solvent Volume (µL)' },
    { id: 'issues', label: '⚠️ Issue Flags & Thresholds' },
    { id: 'tlc_spots', label: hasTlcImages ? '🔬 TLC Detected Spots (Outcome)' : '🔬 TLC Spots (Load Photos)' },
    ...(hasTlcImages
      ? [
          { id: 'tlc_rf', label: '🔬 TLC Primary Spot Rf (Migration)' },
          { id: 'tlc_resolution', label: '🔬 TLC Spot Separation (ΔRf)' },
        ]
      : []),
    ...state.reagents.map((r, i) => ({
      id: `reagent:${i}`,
      label: `Concentration: ${r.code} (mM)`,
    })),
    ...(state.mode === 'equivalence'
      ? state.reagents.map((r, i) => ({
          id: `reagent_equiv:${i}`,
          label: `Equivalents: ${r.code} (eq)`,
        }))
      : []),
  ];

  // Plate stats for summary strip
  const plateDilutedCount = plateRows.filter((r) => r.recipe.some((rc) => rc.dilution_level > 0)).length;
  const plateBadCount = plateRows.filter((_, idx) => blockSet.has(startIdx + idx)).length;
  const plateAvgSolvent = plateRows.length
    ? Math.round(plateRows.reduce((acc, r) => acc + (+r['vol#solvent'] || 0), 0) / plateRows.length)
    : 0;

  // Active inspect well details
  const activeDetailWell = activeFocusVial !== null && activeFocusVial < run.rows.length ? run.rows[activeFocusVial] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Top Toolbar: Plate Switcher, Metric Selector & View Shape */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          background: 'var(--panel)',
          padding: '8px 14px',
          borderRadius: '8px',
          border: '1px solid var(--line)',
        }}
      >
        {/* Left: Plate Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Plate:
          </span>
          <div className="seg" role="tablist">
            {Array.from({ length: run.plates }, (_, p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={plateIndex === p}
                className={plateIndex === p ? 'on' : ''}
                onClick={() => onPlateChange(p)}
                style={{ fontSize: '12px', padding: '0 12px', height: '26px' }}
              >
                Plate {p + 1}
              </button>
            ))}
          </div>
        </div>

        {/* Center: Metric Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <label htmlFor="heatmap-metric-select" style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
            Heatmap Metric:
          </label>
          <select
            id="heatmap-metric-select"
            value={metric}
            onChange={(e) => onMetricChange(e.target.value)}
            style={{
              height: '28px',
              fontSize: '12px',
              padding: '0 26px 0 8px',
              borderRadius: '6px',
              border: '1px solid var(--line)',
              background: 'var(--soft)',
              color: 'var(--fg)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            {metricOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* TLC Multi-Channel Filter (Merged vs UV254 vs UV366) */}
          {metric.startsWith('tlc_') && hasDualChannels && (
            <div
              style={{
                display: 'inline-flex',
                background: 'var(--soft)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                gap: '2px',
                marginLeft: '4px',
              }}
              title="Filter TLC spots by detection wavelength or show combined/merged spots"
            >
              {(['all', 'UV254', 'UV366'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTlcChannelFilter(mode)}
                  style={{
                    fontSize: '11px',
                    padding: '2px 7px',
                    border: 'none',
                    background: tlcChannelFilter === mode ? 'var(--panel)' : 'transparent',
                    color: tlcChannelFilter === mode ? 'var(--fg)' : 'var(--mut)',
                    borderRadius: '4px',
                    fontWeight: tlcChannelFilter === mode ? 600 : 400,
                    cursor: 'pointer',
                    boxShadow: tlcChannelFilter === mode ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  {mode === 'all' ? 'Merged' : mode}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Well Shape Toggle (Circular Wells vs Tiles) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              display: 'inline-flex',
              background: 'var(--soft)',
              padding: '2px',
              borderRadius: '6px',
              border: '1px solid var(--line)',
            }}
            role="group"
            aria-label="Well visualization shape"
          >
            <button
              type="button"
              className={wellShape === 'circular' ? 'on' : ''}
              onClick={() => setWellShape('circular')}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                border: 'none',
                background: wellShape === 'circular' ? 'var(--panel)' : 'transparent',
                color: wellShape === 'circular' ? 'var(--fg)' : 'var(--mut)',
                borderRadius: '4px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                boxShadow: wellShape === 'circular' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}
              title="Circular wells (standard microplate format)"
            >
              <span>⭕</span> Wells
            </button>
            <button
              type="button"
              className={wellShape === 'rounded' ? 'on' : ''}
              onClick={() => setWellShape('rounded')}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                border: 'none',
                background: wellShape === 'rounded' ? 'var(--panel)' : 'transparent',
                color: wellShape === 'rounded' ? 'var(--fg)' : 'var(--mut)',
                borderRadius: '4px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                boxShadow: wellShape === 'rounded' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}
              title="Compact rectangular matrix tile layout"
            >
              <span>▦</span> Grid
            </button>
          </div>
        </div>
      </div>

      {/* Laboratory Microplate Chassis (54-Well 6x9 Format) */}
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '12px',
          boxShadow: 'var(--shadow)',
          padding: '16px 20px',
          position: 'relative',
        }}
      >
        {/* Microplate Header: Orientation Notch + Plate Info */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                background: 'var(--line)',
                borderRadius: '2px',
              }}
              title="A1 orientation notch"
            />
            <span className="mono" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--fg)', letterSpacing: '0.02em' }}>
              Plate {plateIndex + 1}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--mut)' }}>·</span>
            <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
              54-Well Standard Microplate (6 Rows × 9 Columns)
            </span>
          </div>

          {/* Quiet Plate Overview KPI Strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--mut)' }}>
            <span>Wells: <b className="mono" style={{ color: 'var(--fg)' }}>{plateRows.length}</b></span>
            <span>Avg Solv: <b className="mono" style={{ color: 'var(--fg)' }}>{plateAvgSolvent} µL</b></span>
            {plateDilutedCount > 0 ? (
              <span>Diluted: <b className="mono" style={{ color: '#d97706' }}>{plateDilutedCount}</b></span>
            ) : (
              <span>100% Direct</span>
            )}
            {plateBadCount > 0 && (
              <span style={{ color: 'var(--bad)', fontWeight: 600 }}>
                ⚠️ {plateBadCount} Flagged
              </span>
            )}
          </div>
        </div>

        {/* Recessed Plate Well Bed */}
        <div
          style={{
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            padding: '14px 16px',
            overflowX: 'auto',
          }}
        >
          <div style={{ minWidth: '600px' }}>
            {/* Column Headers (1..9) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '28px repeat(9, 1fr)',
                gap: '8px',
                textAlign: 'center',
                marginBottom: '8px',
              }}
            >
              <div />
              {Array.from({ length: COLS }, (_, c) => {
                const isColActive = activeHoverCol === c;
                return (
                  <div
                    key={c}
                    className="mono"
                    style={{
                      fontSize: '11px',
                      fontWeight: isColActive ? 700 : 500,
                      color: isColActive ? 'var(--fg)' : 'var(--mut)',
                      background: isColActive ? 'var(--panel)' : 'transparent',
                      borderRadius: '4px',
                      padding: '2px 0',
                      transition: 'all 0.1s ease',
                      border: isColActive ? '1px solid var(--line)' : '1px solid transparent',
                    }}
                  >
                    {c + 1}
                  </div>
                );
              })}
            </div>

            {/* Rows A through F */}
            {Array.from({ length: ROWS }, (_, r) => {
              const isRowActive = activeHoverRow === r;
              return (
                <div
                  key={r}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '28px repeat(9, 1fr)',
                    gap: '8px',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  {/* Row Letter */}
                  <div
                    className="mono"
                    style={{
                      fontSize: '11px',
                      fontWeight: isRowActive ? 700 : 500,
                      color: isRowActive ? 'var(--fg)' : 'var(--mut)',
                      background: isRowActive ? 'var(--panel)' : 'transparent',
                      borderRadius: '4px',
                      textAlign: 'center',
                      padding: '3px 0',
                      transition: 'all 0.1s ease',
                      border: isRowActive ? '1px solid var(--line)' : '1px solid transparent',
                    }}
                  >
                    {ROW_LETTERS[r]}
                  </div>

                  {/* 9 Wells in this Row */}
                  {Array.from({ length: COLS }, (_, c) => {
                    const k = r * COLS + c;
                    const ri = startIdx + k;
                    const rowData = run.rows[ri];
                    const exists = ri < run.rows.length;
                    const isBlank = state.mode === 'triplet' && triMeta[ri] && triMeta[ri].blank;
                    const isBad = exists && blockSet.has(ri);
                    const isSelected = selectedVial === ri;
                    const isHovered = hoveredVial === ri;
                    const matches = exists && matchesFilter(ri);

                    if (!exists || isBlank) {
                      return (
                        <div
                          key={c}
                          style={{
                            aspectRatio: '1',
                            borderRadius: wellShape === 'circular' ? '50%' : '6px',
                            border: '1px dashed var(--line)',
                            background: 'transparent',
                            opacity: 0.35,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <span className="mono" style={{ fontSize: '9px', color: 'var(--mut)' }}>
                            {ROW_LETTERS[r]}{c + 1}
                          </span>
                        </div>
                      );
                    }

                    // Calibrated, elegant styling based on metric
                    let bg = 'var(--panel)';
                    let border = '1px solid var(--line)';
                    let valueTextCol = 'var(--fg)';
                    let coordTextCol = 'var(--mut)';
                    let valueLabel = '';

                    if (metric === 'dilution') {
                      const maxDil = Math.max(...rowData.recipe.map((rc) => rc.dilution_level || 0));
                      if (maxDil === 0) {
                        // 1x Direct: Clean, calm, professional neutral laboratory well
                        bg = 'var(--panel)';
                        border = '1px solid var(--line)';
                        valueTextCol = 'var(--fg)';
                        coordTextCol = 'var(--mut)';
                        valueLabel = '1×';
                      } else if (maxDil === 1) {
                        // 5x Diluted: Clear, warm amber highlight
                        bg = 'rgba(245, 158, 11, 0.15)';
                        border = '1.5px solid #f59e0b';
                        valueTextCol = '#b45309';
                        coordTextCol = '#d97706';
                        valueLabel = `${factor}×`;
                      } else {
                        // 25x Diluted: Clear royal violet highlight
                        bg = 'rgba(168, 85, 247, 0.16)';
                        border = '1.5px solid #a855f7';
                        valueTextCol = '#7e22ce';
                        coordTextCol = '#9333ea';
                        valueLabel = `${factor * factor}×`;
                      }
                    } else if (metric === 'solvent') {
                      // Calibrated Oceanic Blue ramp: more volume = deeper blue
                      const solv = +rowData['vol#solvent'] || 0;
                      const ratio = Math.max(0, Math.min(1, solv / vialVol));
                      if (ratio < 0.3) {
                        bg = 'rgba(14, 165, 233, 0.10)';
                        border = '1px solid rgba(14, 165, 233, 0.3)';
                        valueTextCol = '#0369a1';
                      } else if (ratio < 0.65) {
                        bg = 'rgba(2, 132, 199, 0.22)';
                        border = '1px solid rgba(2, 132, 199, 0.45)';
                        valueTextCol = '#0284c7';
                      } else {
                        bg = 'rgba(29, 78, 216, 0.38)';
                        border = '1.5px solid rgba(29, 78, 216, 0.65)';
                        valueTextCol = '#1d4ed8';
                      }
                      coordTextCol = 'var(--mut)';
                      valueLabel = `${Math.round(solv)}`;
                    } else if (metric === 'issues') {
                      if (isBad) {
                        bg = 'rgba(239, 68, 68, 0.16)';
                        border = '2px solid #ef4444';
                        valueTextCol = '#ef4444';
                        coordTextCol = '#dc2626';
                        valueLabel = '⚠️';
                      } else {
                        bg = 'var(--panel)';
                        border = '1px solid var(--line)';
                        valueTextCol = '#10b981';
                        coordTextCol = 'var(--mut)';
                        valueLabel = '✓';
                      }
                    } else if (activeReagentIndex >= 0) {
                      const conc = rowData.recipe[activeReagentIndex]?.target_concentration || 0;
                      const span = maxMetric - minMetric || 1;
                      const ratio = Math.max(0, Math.min(1, (conc - minMetric) / span));
                      const baseCol = rcol(activeReagentIndex);
                      if (conc === 0) {
                        bg = 'var(--panel)';
                        border = '1px dashed var(--line)';
                        valueTextCol = 'var(--mut)';
                        valueLabel = '0';
                      } else {
                        bg = `color-mix(in srgb, ${baseCol} ${Math.round(15 + ratio * 65)}%, var(--panel))`;
                        border = `1.5px solid color-mix(in srgb, ${baseCol} 70%, var(--line))`;
                        valueTextCol = ratio > 0.6 ? '#ffffff' : 'var(--fg)';
                        valueLabel = `${nf(conc, 1)}`;
                      }
                      coordTextCol = 'var(--mut)';
                    } else if (activeEquivIndex >= 0) {
                      const eq = rowData.recipe[activeEquivIndex]?.value || 0;
                      const span = maxMetric - minMetric || 1;
                      const ratio = Math.max(0, Math.min(1, (eq - minMetric) / span));
                      const baseCol = rcol(activeEquivIndex);
                      if (eq === 0) {
                        bg = 'var(--panel)';
                        border = '1px dashed var(--line)';
                        valueTextCol = 'var(--mut)';
                        valueLabel = '0';
                      } else {
                        bg = `color-mix(in srgb, ${baseCol} ${Math.round(15 + ratio * 65)}%, var(--panel))`;
                        border = `1.5px solid color-mix(in srgb, ${baseCol} 70%, var(--line))`;
                        valueTextCol = ratio > 0.6 ? '#ffffff' : 'var(--fg)';
                        valueLabel = `${nf(eq, 2)}`;
                      }
                      coordTextCol = 'var(--mut)';
                    } else if (metric === 'tlc_spots') {
                      const tlc = wellTlcData.get(k);
                      if (!hasTlcImages) {
                        bg = 'var(--panel)';
                        border = '1px dashed var(--line)';
                        valueTextCol = 'var(--mut)';
                        valueLabel = '—';
                      } else if (!tlc || tlc.count === 0) {
                        bg = 'var(--panel)';
                        border = '1px solid var(--line)';
                        valueTextCol = 'var(--mut)';
                        valueLabel = '0';
                      } else if (tlc.count === 1) {
                        bg = 'rgba(245, 158, 11, 0.16)';
                        border = '1.5px solid #f59e0b';
                        valueTextCol = '#b45309';
                        valueLabel = '1';
                      } else if (tlc.count === 2) {
                        bg = 'rgba(16, 185, 129, 0.20)';
                        border = '1.5px solid #10b981';
                        valueTextCol = '#047857';
                        valueLabel = '2';
                      } else {
                        bg = 'rgba(168, 85, 247, 0.22)';
                        border = '1.5px solid #a855f7';
                        valueTextCol = '#7e22ce';
                        valueLabel = `${tlc.count}`;
                      }
                      coordTextCol = 'var(--mut)';
                    } else if (metric === 'tlc_rf') {
                      const tlc = wellTlcData.get(k);
                      if (tlc && tlc.mainRf !== null) {
                        const ratio = Math.max(0, Math.min(1, tlc.mainRf));
                        bg = `rgba(14, 165, 233, ${0.15 + ratio * 0.45})`;
                        border = '1.5px solid rgba(14, 165, 233, 0.7)';
                        valueTextCol = ratio > 0.5 ? '#0369a1' : 'var(--fg)';
                        valueLabel = `${tlc.mainRf.toFixed(2)}`;
                      } else {
                        bg = 'var(--panel)';
                        border = '1px solid var(--line)';
                        valueTextCol = 'var(--mut)';
                        valueLabel = '—';
                      }
                      coordTextCol = 'var(--mut)';
                    }

                    // Selection & Warning accents
                    if (isBad) {
                      border = '2px solid var(--bad)';
                    }
                    if (isSelected) {
                      border = '2px solid var(--acc)';
                    }

                    return (
                      <div
                        key={c}
                        style={{
                          aspectRatio: '1',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectVial(isSelected ? null : ri)}
                          onMouseEnter={() => setHoveredVial(ri)}
                          onMouseLeave={() => setHoveredVial(null)}
                          style={{
                            width: '100%',
                            height: '100%',
                            borderRadius: wellShape === 'circular' ? '50%' : '6px',
                            background: bg,
                            border,
                            boxShadow: isSelected
                              ? '0 0 0 3px rgba(11, 107, 95, 0.35), 0 2px 6px rgba(0,0,0,0.1)'
                              : isHovered
                              ? '0 2px 8px rgba(0,0,0,0.12)'
                              : '0 1px 2px rgba(0,0,0,0.03)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: '1px',
                            padding: '2px',
                            cursor: 'pointer',
                            transition: 'all 0.12s ease',
                            opacity: matches ? 1 : 0.25,
                            transform: isSelected ? 'scale(1.06)' : isHovered ? 'translateY(-1px)' : 'none',
                            position: 'relative',
                            zIndex: isSelected ? 5 : isHovered ? 4 : 1,
                          }}
                          title={`Well ${ROW_LETTERS[r]}${c + 1} (Rxn #${ri + 1})`}
                        >
                          {/* Well Coordinate (Quiet, 9px monospace) */}
                          <span
                            className="mono"
                            style={{
                              fontSize: '9px',
                              fontWeight: 600,
                              color: coordTextCol,
                              lineHeight: 1,
                            }}
                          >
                            {ROW_LETTERS[r]}{c + 1}
                          </span>

                          {/* Significant Primary Metric Value */}
                          <span
                            className="mono"
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              color: valueTextCol,
                              lineHeight: 1.1,
                            }}
                          >
                            {valueLabel}
                          </span>

                          {/* Flag dot if bad */}
                          {isBad && (
                            <span
                              style={{
                                position: 'absolute',
                                top: '2px',
                                right: '4px',
                                fontSize: '8px',
                                color: 'var(--bad)',
                              }}
                            >
                              ●
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Live Well Inspection HUD Card (Appears whenever a well is hovered or selected) */}
      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '10px',
          padding: '10px 14px',
          boxShadow: 'var(--shadow)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          minHeight: '48px',
        }}
      >
        {activeDetailWell ? (
          <>
            {/* Active Well Details */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--soft)',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                }}
              >
                <span className="mono" style={{ fontSize: '13px', fontWeight: 800, color: 'var(--fg)' }}>
                  Well {wellLabel(activeDetailWell.container_id)}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--mut)' }}>·</span>
                <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                  Rxn #{activeDetailWell.global_index + 1}
                </span>
              </div>

              {/* Solvent & Dilution chips */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                <span style={{ color: 'var(--mut)' }}>
                  Solvent: <b className="mono" style={{ color: 'var(--fg)' }}>{Math.round(+activeDetailWell['vol#solvent'] || 0)} µL</b> ({state.reactionSolvent})
                </span>

                {/* Recipe concentrations */}
                {activeDetailWell.recipe
                  .filter((rc) => rc.target_concentration > 0)
                  .map((rc, rci) => (
                    <span
                      key={rc.code}
                      className="mono"
                      style={{
                        fontSize: '11px',
                        background: 'var(--soft)',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        border: '1px solid var(--line)',
                      }}
                    >
                      <span className="rdot" style={{ background: rcol(rci), width: '6px', height: '6px', display: 'inline-block', marginRight: '4px' }} />
                      {rc.code}: <b>{rc.target_concentration.toFixed(1)} mM</b>
                    </span>
                  ))}

                {/* TLC Spot readout for active well */}
                {hasTlcImages && activeDetailWell && (() => {
                  const tlc = wellTlcData.get(activeDetailWell.container_id);
                  if (!tlc) return null;
                  const hasSpots = tlc.count > 0;
                  return (
                    <span
                      className="mono"
                      style={{
                        fontSize: '11px',
                        background: hasSpots ? 'rgba(16, 185, 129, 0.12)' : 'var(--soft)',
                        color: hasSpots ? '#047857' : 'var(--mut)',
                        padding: '1px 7px',
                        borderRadius: '4px',
                        border: `1px solid ${hasSpots ? 'rgba(16, 185, 129, 0.35)' : 'var(--line)'}`,
                      }}
                      title={`TLC Lane ${tlc.laneId}`}
                    >
                      🔬 TLC Lane {tlc.laneId}: <b>{hasSpots ? `${tlc.count} spot${tlc.count === 1 ? '' : 's'}` : '0 spots'}</b>
                      {hasSpots && (
                        <span style={{ marginLeft: '4px', opacity: 0.9 }}>
                          (Rf {tlc.spots.map((s) => s.rf.toFixed(2)).join(', ')})
                        </span>
                      )}
                    </span>
                  );
                })()}

                {blockSet.has(activeDetailWell.global_index) && (
                  <span className="chip bad" style={{ fontSize: '10px', padding: '1px 6px' }}>
                    ⚠️ Flagged
                  </span>
                )}
              </div>
            </div>

            {/* Quick Actions for this well */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {onNavigateTlc && (
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => onNavigateTlc(activeDetailWell.global_index)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', height: '26px' }}
                  title="Open enlarged 1D TLC Densitometer modal for this lane"
                >
                  <span>🔬</span> Inspect TLC Lane
                </button>
              )}
              {selectedVial !== null && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => onSelectVial(null)}
                  style={{ fontSize: '11px', height: '26px' }}
                >
                  Deselect
                </button>
              )}
            </div>
          </>
        ) : (
          /* Default state when no well is focused */
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', fontSize: '12px', color: 'var(--mut)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>👆</span>
              <span>Hover or click any well to inspect pipetted concentrations and TLC outcome.</span>
            </div>
            <div className="mono" style={{ fontSize: '11px' }}>
              Plate {plateIndex + 1} of {run.plates} · 54 Positions
            </div>
          </div>
        )}
      </div>

      {/* Heatmap Legend */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          padding: '8px 12px',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '8px',
          fontSize: '12px',
        }}
      >
        {metric === 'dilution' ? (
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)', fontSize: '11px', textTransform: 'uppercase' }}>Legend:</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: wellShape === 'circular' ? '50%' : '3px',
                  background: 'var(--panel)',
                  border: '1px solid var(--line)',
                }}
              />
              1× Direct (Standard)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: wellShape === 'circular' ? '50%' : '3px',
                  background: 'rgba(245, 158, 11, 0.2)',
                  border: '1.5px solid #f59e0b',
                }}
              />
              {factor}× Hand-Diluted (N)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: wellShape === 'circular' ? '50%' : '3px',
                  background: 'rgba(168, 85, 247, 0.2)',
                  border: '1.5px solid #a855f7',
                }}
              />
              {factor * factor}× Hand-Diluted (N²)
            </span>
          </div>
        ) : metric === 'solvent' ? (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)', fontSize: '11px', textTransform: 'uppercase' }}>Solvent Fill:</span>
            <span className="mono">{nf(minMetric, 0)} µL (Low)</span>
            <div
              style={{
                width: '140px',
                height: '8px',
                borderRadius: '4px',
                background: 'linear-gradient(to right, rgba(14, 165, 233, 0.15), rgba(2, 132, 199, 0.4), rgba(29, 78, 216, 0.75))',
              }}
            />
            <span className="mono">{nf(maxMetric, 0)} µL (High)</span>
          </div>
        ) : metric === 'tlc_spots' ? (
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)', fontSize: '11px', textTransform: 'uppercase' }}>TLC Outcome:</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--panel)', border: '1px solid var(--line)' }} />
              0 (unreacted)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.3)', border: '1px solid #f59e0b' }} />
              1 (single)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.35)', border: '1px solid #10b981' }} />
              2 (product)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'rgba(168, 85, 247, 0.35)', border: '1px solid #a855f7' }} />
              3+ (multi)
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)', fontSize: '11px', textTransform: 'uppercase' }}>Concentration Scale:</span>
            <span className="mono">{nf(minMetric, 1)} mM</span>
            <div
              style={{
                width: '140px',
                height: '8px',
                borderRadius: '4px',
                background: `linear-gradient(to right, color-mix(in srgb, ${rcol(activeReagentIndex >= 0 ? activeReagentIndex : 0)} 15%, var(--panel)), color-mix(in srgb, ${rcol(activeReagentIndex >= 0 ? activeReagentIndex : 0)} 85%, var(--panel)))`,
              }}
            />
            <span className="mono">{nf(maxMetric, 1)} mM</span>
          </div>
        )}

        <div className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
          Click well to select or inspect
        </div>
      </div>
    </div>
  );
};
