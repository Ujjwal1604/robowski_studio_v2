// Robowski Studio - 2D Plate Heatmap Matrix Component
import React, { useMemo } from 'react';
import { RunResult, RunState, TlcSet, TlcSpot } from '../../types';
import {
  PAL,
  getVialTipHtml,
  findSpots,
  tlcOrigin,
  tlcFront,
  TLC_SIGNAL,
  TlcChannelKey,
} from '../../engine';
import { extractLaneProfile } from './TlcView';

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
  const PLATE_SIZE = 54;
  const COLS = 9;
  const ROWS = 6;
  const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const factor = +state.dilutionFactor || 5;
  const vialVol = +state.vialVolume || 500;

  // Derive TLC spot data for each lane on this plate
  const activeTlcSet = (tlcSets && (tlcSets[plateIndex] || tlcSets[0])) || null;
  const tlcLanes = activeTlcSet?.cfg?.lanes || [];
  const tlcChannel: TlcChannelKey = activeTlcSet?.imgs.UV254 ? 'UV254' : 'UV366';
  const hasTlcImages = Boolean(activeTlcSet?.imgs[tlcChannel]?.bmp);

  // Map each well index (k = 0..53) to its detected spots
  const wellTlcData = useMemo(() => {
    const map = new Map<number, { count: number; spots: TlcSpot[]; mainRf: number | null; deltaRf: number | null }>();
    if (!activeTlcSet || !hasTlcImages || tlcLanes.length === 0) return map;

    tlcLanes.forEach((lane) => {
      try {
        const prof = extractLaneProfile(activeTlcSet, tlcChannel, lane, 0.35);
        if (prof && prof.length > 0) {
          const oVal = tlcOrigin(activeTlcSet, lane);
          const fVal = tlcFront(activeTlcSet, lane);
          const spots = findSpots(prof, {
            sign: TLC_SIGNAL[tlcChannel]?.sign ?? -1,
            origin: oVal,
            front: fVal,
            radius: lane.spotRadius || 24,
          });

          const sorted = [...spots].sort((a, b) => b.strength - a.strength);
          const mainRf = sorted.length > 0 ? sorted[0].rf : null;
          let deltaRf: number | null = null;
          if (spots.length >= 2) {
            const rfs = spots.map((s) => s.rf).sort((a, b) => a - b);
            deltaRf = +(rfs[rfs.length - 1] - rfs[0]).toFixed(2);
          }

          map.set(lane.id, {
            count: spots.length,
            spots,
            mainRf,
            deltaRf,
          });
        }
      } catch {
        // Skip corrupted lane
      }
    });

    return map;
  }, [activeTlcSet, hasTlcImages, tlcLanes, tlcChannel]);

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
    { id: 'dilution', label: 'Dilution Level (1× vs 5× vs 25×)' },
    { id: 'solvent', label: 'Solvent Volume (µL)' },
    { id: 'issues', label: '⚠️ Issue Flags & Threshold Warnings' },
    { id: 'tlc_spots', label: hasTlcImages ? '🔬 TLC Detected Spots (Reaction Outcome)' : '🔬 TLC Spots (Load Plate Photo)' },
    ...(hasTlcImages
      ? [
          { id: 'tlc_rf', label: '🔬 TLC Primary Spot Rf (Migration)' },
          { id: 'tlc_resolution', label: '🔬 TLC Spot Separation (ΔRf)' },
        ]
      : []),
    ...state.reagents.map((r, i) => ({
      id: `reagent:${i}`,
      label: `${r.code} Concentration (mM)`,
    })),
    ...(state.mode === 'equivalence'
      ? state.reagents.map((r, i) => ({
          id: `reagent_equiv:${i}`,
          label: `${r.code} Equivalents (eq)`,
        }))
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Controls Bar: Plate Switcher + Metric Selector */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        {/* Plate Switcher Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)' }}>Plate:</span>
          <div className="seg" role="tablist">
            {Array.from({ length: run.plates }, (_, p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={plateIndex === p}
                className={plateIndex === p ? 'on' : ''}
                onClick={() => onPlateChange(p)}
                style={{ fontSize: '12px', padding: '0 10px' }}
              >
                Plate {p + 1}
              </button>
            ))}
          </div>
        </div>

        {/* Heatmap Metric Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label htmlFor="heatmap-metric" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--mut)' }}>
            Heatmap by:
          </label>
          <select
            id="heatmap-metric"
            value={metric}
            onChange={(e) => onMetricChange(e.target.value)}
            style={{ height: '32px', fontSize: '12px', padding: '0 28px 0 8px', maxWidth: '240px' }}
          >
            {metricOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 2D Plate Matrix Grid (6 rows x 9 cols) */}
      <div
        style={{
          background: 'var(--soft)',
          border: '1px solid var(--line)',
          borderRadius: '12px',
          padding: '14px',
          overflowX: 'auto',
        }}
      >
        <div style={{ minWidth: '580px' }}>
          {/* Column Header (1..9) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '32px repeat(9, 1fr)',
              gap: '6px',
              textAlign: 'center',
              marginBottom: '6px',
            }}
          >
            <div />
            {Array.from({ length: COLS }, (_, c) => (
              <div
                key={c}
                className="mono"
                style={{ fontSize: '11px', fontWeight: 600, color: 'var(--mut)' }}
              >
                {c + 1}
              </div>
            ))}
          </div>

          {/* Rows A..F */}
          {Array.from({ length: ROWS }, (_, r) => (
            <div
              key={r}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px repeat(9, 1fr)',
                gap: '6px',
                alignItems: 'center',
                marginBottom: '6px',
              }}
            >
              {/* Row Letter */}
              <div
                className="mono"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--mut)',
                  textAlign: 'center',
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
                const isBlank =
                  state.mode === 'triplet' && triMeta[ri] && triMeta[ri].blank;
                const isBad = exists && blockSet.has(ri);
                const isSelected = selectedVial === ri;
                const matches = exists && matchesFilter(ri);

                if (!exists || isBlank) {
                  return (
                    <div
                      key={c}
                      style={{
                        aspectRatio: '1.2 / 1',
                        borderRadius: '8px',
                        border: '1px dashed var(--line)',
                        background: 'transparent',
                        opacity: 0.35,
                      }}
                      title="Empty / unused well"
                    />
                  );
                }

                // Compute color styling for this well based on active metric
                let bg = 'var(--panel)';
                let border = '1px solid var(--line)';
                let valueLabel = '';

                if (metric === 'dilution') {
                  const maxDil = Math.max(
                    ...rowData.recipe.map((rc) => rc.dilution_level || 0)
                  );
                  if (maxDil === 0) {
                    bg = 'rgba(16, 185, 129, 0.16)';
                    border = '1px solid rgba(16, 185, 129, 0.45)';
                    valueLabel = '1×';
                  } else if (maxDil === 1) {
                    bg = 'rgba(245, 158, 11, 0.22)';
                    border = '1px solid rgba(245, 158, 11, 0.55)';
                    valueLabel = `${factor}×`;
                  } else {
                    bg = 'rgba(168, 85, 247, 0.25)';
                    border = '1px solid rgba(168, 85, 247, 0.55)';
                    valueLabel = `${factor * factor}×`;
                  }
                } else if (metric === 'solvent') {
                  const solv = +rowData['vol#solvent'] || 0;
                  const ratio = Math.max(0, Math.min(1, solv / vialVol));
                  // Cyan / blue when high solvent, amber when low solvent
                  const hue = 180 - ratio * 140; // 40 (amber) to 180 (cyan)
                  bg = `hsla(${hue}, 70%, 50%, 0.22)`;
                  border = `1px solid hsla(${hue}, 70%, 45%, 0.5)`;
                  valueLabel = `${Math.round(solv)}µL`;
                } else if (metric === 'issues') {
                  if (isBad) {
                    bg = 'rgba(239, 68, 68, 0.25)';
                    border = '2px solid var(--bad)';
                    valueLabel = '⚠️ Issue';
                  } else {
                    bg = 'rgba(16, 185, 129, 0.12)';
                    border = '1px solid rgba(16, 185, 129, 0.35)';
                    valueLabel = '✓ Pass';
                  }
                } else if (activeEquivIndex >= 0) {
                  const eq = rowData.recipe[activeEquivIndex]?.value || 0;
                  const span = maxMetric - minMetric || 1;
                  const ratio = Math.max(0, Math.min(1, (eq - minMetric) / span));
                  const baseCol = rcol(activeEquivIndex);
                  bg = `color-mix(in srgb, ${baseCol} ${Math.round(15 + ratio * 70)}%, var(--panel))`;
                  border = `1px solid color-mix(in srgb, ${baseCol} 60%, var(--line))`;
                  valueLabel = `${nf(eq, 2)} eq`;
                } else if (activeReagentIndex >= 0) {
                  const conc =
                    rowData.recipe[activeReagentIndex]?.target_concentration || 0;
                  const span = maxMetric - minMetric || 1;
                  const ratio = Math.max(0, Math.min(1, (conc - minMetric) / span));
                  const baseCol = rcol(activeReagentIndex);
                  bg = `color-mix(in srgb, ${baseCol} ${Math.round(15 + ratio * 70)}%, var(--panel))`;
                  border = `1px solid color-mix(in srgb, ${baseCol} 60%, var(--line))`;
                  valueLabel = `${nf(conc, 1)}`;
                } else if (metric === 'tlc_spots') {
                  const tlc = wellTlcData.get(k);
                  if (!hasTlcImages) {
                    bg = 'rgba(100, 116, 139, 0.15)';
                    border = '1px dashed var(--line)';
                    valueLabel = 'No TLC';
                  } else if (!tlc || tlc.count === 0) {
                    bg = 'rgba(71, 85, 105, 0.22)';
                    border = '1px solid rgba(100, 116, 139, 0.45)';
                    valueLabel = '0 spots';
                  } else if (tlc.count === 1) {
                    bg = 'rgba(245, 158, 11, 0.25)';
                    border = '1px solid rgba(245, 158, 11, 0.7)';
                    valueLabel = `1 spot (${tlc.mainRf?.toFixed(2)})`;
                  } else if (tlc.count === 2) {
                    bg = 'rgba(16, 185, 129, 0.28)';
                    border = '1px solid rgba(16, 185, 129, 0.75)';
                    valueLabel = `2 spots (Δ${tlc.deltaRf?.toFixed(2)})`;
                  } else {
                    bg = 'rgba(168, 85, 247, 0.32)';
                    border = '1px solid rgba(168, 85, 247, 0.75)';
                    valueLabel = `${tlc.count} spots`;
                  }
                } else if (metric === 'tlc_rf') {
                  const tlc = wellTlcData.get(k);
                  if (tlc && tlc.mainRf !== null) {
                    const hue = Math.round(tlc.mainRf * 200);
                    bg = `hsla(${hue}, 75%, 50%, 0.26)`;
                    border = `1px solid hsla(${hue}, 75%, 45%, 0.65)`;
                    valueLabel = `Rf ${tlc.mainRf.toFixed(2)}`;
                  } else {
                    bg = 'rgba(71, 85, 105, 0.15)';
                    border = '1px solid var(--line)';
                    valueLabel = '—';
                  }
                } else if (metric === 'tlc_resolution') {
                  const tlc = wellTlcData.get(k);
                  if (tlc && tlc.deltaRf !== null) {
                    bg = 'rgba(6, 182, 212, 0.26)';
                    border = '1px solid rgba(6, 182, 212, 0.65)';
                    valueLabel = `ΔRf ${tlc.deltaRf.toFixed(2)}`;
                  } else {
                    bg = 'rgba(71, 85, 105, 0.15)';
                    border = '1px solid var(--line)';
                    valueLabel = '—';
                  }
                }

                if (isBad) {
                  border = '2px solid var(--bad)';
                }
                if (isSelected) {
                  border = '2px solid var(--acc)';
                }

                const tipHtml = getVialTipHtml(
                  plateIndex,
                  k,
                  ri,
                  run,
                  state,
                  triMeta,
                  blockSet
                );

                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onSelectVial(isSelected ? null : ri)}
                    data-tip={tipHtml}
                    style={{
                      aspectRatio: '1.2 / 1',
                      borderRadius: '8px',
                      background: bg,
                      border,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      padding: '4px 6px',
                      cursor: 'pointer',
                      transition: 'transform 0.12s ease, opacity 0.15s ease',
                      opacity: matches ? 1 : 0.22,
                      transform: isSelected ? 'scale(1.06)' : 'none',
                      boxShadow: isSelected ? 'var(--shadow-md)' : 'none',
                      position: 'relative',
                    }}
                    title={`Well ${ROW_LETTERS[r]}${c + 1} (Reaction ${ri + 1})`}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: '9px',
                          fontWeight: 600,
                          color: 'var(--mut)',
                        }}
                      >
                        {ROW_LETTERS[r]}
                        {c + 1}
                      </span>
                      {isBad && (
                        <span
                          style={{
                            fontSize: '10px',
                            color: 'var(--bad)',
                            lineHeight: 1,
                          }}
                        >
                          ●
                        </span>
                      )}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--fg)',
                        textAlign: 'center',
                        width: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {valueLabel}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
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
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>Legend:</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '3px',
                  background: 'rgba(16, 185, 129, 0.4)',
                  border: '1px solid rgba(16, 185, 129, 0.8)',
                }}
              />
              Direct 1×
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '3px',
                  background: 'rgba(245, 158, 11, 0.4)',
                  border: '1px solid rgba(245, 158, 11, 0.8)',
                }}
              />
              Dilution {factor}× (N)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '3px',
                  background: 'rgba(168, 85, 247, 0.4)',
                  border: '1px solid rgba(168, 85, 247, 0.8)',
                }}
              />
              Dilution {factor * factor}× (N²)
            </span>
          </div>
        ) : metric === 'tlc_spots' ? (
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>TLC Spot Outcome:</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'rgba(71, 85, 105, 0.4)', border: '1px solid #64748b' }} />
              0 Spots (No conversion)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'rgba(245, 158, 11, 0.4)', border: '1px solid #f59e0b' }} />
              1 Spot (Single component)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'rgba(16, 185, 129, 0.4)', border: '1px solid #10b981' }} />
              2 Spots (Reaction product formed)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: 'rgba(168, 85, 247, 0.4)', border: '1px solid #a855f7' }} />
              3+ Spots (Multicomponent)
            </span>
          </div>
        ) : metric === 'tlc_rf' ? (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>Primary Rf Migration:</span>
            <span className="mono">Rf 0.00 (Origin)</span>
            <div
              style={{
                width: '120px',
                height: '8px',
                borderRadius: '4px',
                background: 'linear-gradient(to right, hsla(0, 75%, 50%, 0.6), hsla(120, 75%, 50%, 0.6), hsla(200, 75%, 50%, 0.6))',
              }}
            />
            <span className="mono">Rf 1.00 (Solvent Front)</span>
          </div>
        ) : metric === 'tlc_resolution' ? (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>Separation Resolution (ΔRf):</span>
            <span className="mono">ΔRf = Spot₂ - Spot₁ separation span (larger is better resolved)</span>
          </div>
        ) : metric === 'solvent' ? (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>Solvent Ramp:</span>
            <span className="mono">{nf(minMetric, 0)} µL (Low)</span>
            <div
              style={{
                width: '120px',
                height: '8px',
                borderRadius: '4px',
                background:
                  'linear-gradient(to right, hsla(40, 75%, 50%, 0.6), hsla(180, 75%, 45%, 0.6))',
              }}
            />
            <span className="mono">{nf(maxMetric, 0)} µL (High)</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--mut)' }}>Concentration Ramp:</span>
            <span className="mono">{nf(minMetric, 2)} mM (Min)</span>
            <div
              style={{
                width: '120px',
                height: '8px',
                borderRadius: '4px',
                background: `linear-gradient(to right, color-mix(in srgb, ${rcol(
                  activeReagentIndex
                )} 15%, var(--panel)), color-mix(in srgb, ${rcol(
                  activeReagentIndex
                )} 85%, var(--panel)))`,
              }}
            />
            <span className="mono">{nf(maxMetric, 2)} mM (Max)</span>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: '8px', borderTop: '1px solid var(--line)', paddingTop: '8px' }}>
          <div style={{ color: 'var(--mut)', fontSize: '11px' }}>
            Plate {plateIndex + 1}: {plateRows.length} wells · Click any well to view chemical recipe
          </div>
          {selectedVial !== null && onNavigateTlc && (
            <button
              type="button"
              className="btn sm"
              onClick={() => onNavigateTlc(selectedVial)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', height: '26px' }}
              title="Switch to TLC Map and inspect this well's TLC lane"
            >
              🔬 Inspect Well {ROW_LETTERS[Math.floor((selectedVial % 54) / 9)]}{(selectedVial % 9) + 1} in TLC Map
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
