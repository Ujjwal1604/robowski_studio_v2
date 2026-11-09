import React, { useState } from 'react';
import { EdgeFit, EdgePick, EdgeSetting, edgeActive, edgeCurve, edgeGain, edgeOffset, edgeSuggestion } from '../../engine/tlcEdge';

interface Props {
  fits: (EdgeFit | null)[]; // one per half: [0] = Lanes 0-26 (Side 1), [1] = Lanes 27-53 (Side 2)
  settings: EdgeSetting[];
  onSetting: (half: number, s: EdgeSetting) => void;
  picks: EdgePick[];
  pickMode: boolean;
  onPickMode: (on: boolean) => void;
  pickGroup: number;
  onPickGroup: (g: number) => void;
  onClearPicks: () => void;
  darkTheme?: boolean;
  defaultOpen?: boolean;
  selectedLaneId?: number | null;
  straighten?: boolean;
  onToggleStraighten?: (on: boolean) => void;
}

const PICK_COLORS = ['#f59e0b', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#eab308'];

const SIDE_INFO = [
  {
    index: 0,
    title: 'Side 1 (Lanes 0–26)',
    tier: 'Lower Tier',
    wells: 'Wells A1–C9',
    laneRange: '0 to 26',
  },
  {
    index: 1,
    title: 'Side 2 (Lanes 27–53)',
    tier: 'Upper Tier',
    wells: 'Wells D1–F9',
    laneRange: '27 to 53',
  },
];

function DiagnosticPlot({
  fit,
  strength,
  dark,
}: {
  fit: EdgeFit;
  strength: number;
  dark?: boolean;
}) {
  const w = 220;
  const h = 64;
  const padX = 8;
  const padY = 6;
  const ys = fit.used.map((p) => p.y);
  const lim = Math.max(0.04, ...ys.map(Math.abs), fit.maxShift * strength, 0.05);

  const X = (u: number) => padX + ((u + 1) / 2) * (w - 2 * padX);
  const Y = (v: number) => h / 2 - (v / lim) * (h / 2 - padY);

  const path = Array.from({ length: 45 }, (_, i) => {
    const u = -1 + i / 22;
    return `${i ? 'L' : 'M'}${X(u).toFixed(1)},${Y(edgeCurve(fit, u, strength)).toFixed(1)}`;
  }).join(' ');

  const leftShiftPct = ((edgeGain(fit, fit.xmin, strength) - 1) * 100);
  const rightShiftPct = ((edgeGain(fit, fit.xmax, strength) - 1) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: dark ? '#94a3b8' : 'var(--mut)', padding: '0 2px' }}>
        <span>Left ({leftShiftPct >= 0 ? '+' : ''}{leftShiftPct.toFixed(1)}%)</span>
        <span style={{ color: dark ? '#38bdf8' : 'var(--pri)', fontWeight: 600 }}>Center (1.00)</span>
        <span>Right ({rightShiftPct >= 0 ? '+' : ''}{rightShiftPct.toFixed(1)}%)</span>
      </div>
      <svg
        width={w}
        height={h}
        role="img"
        aria-label="Lateral migration curvature plot across plate width"
        style={{
          background: dark ? '#090d16' : 'var(--soft)',
          borderRadius: '4px',
          flex: '0 0 auto',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: dark ? '#334155' : 'rgba(0,0,0,0.1)',
        }}
      >
        {/* Zero baseline (Center baseline) */}
        <line x1={padX} x2={w - padX} y1={h / 2} y2={h / 2} stroke={dark ? '#334155' : 'var(--line)'} strokeDasharray="3,3" />
        <line x1={w / 2} x2={w / 2} y1={padY} y2={h - padY} stroke={dark ? '#1e293b' : 'rgba(0,0,0,0.06)'} />

        {/* Residual spot dots */}
        {fit.used.map((p, i) => (
          <circle key={i} cx={X(p.u)} cy={Y(p.y)} r={1.6} fill={dark ? '#64748b' : '#94a3b8'} opacity={0.65} />
        ))}

        {/* Leveling Fit Curve */}
        <path d={path} fill="none" stroke="#ec4899" strokeWidth={2} />
      </svg>
    </div>
  );
}

export const TlcEdgePanel: React.FC<Props> = ({
  fits,
  settings,
  onSetting,
  picks,
  pickMode,
  onPickMode,
  pickGroup,
  onPickGroup,
  onClearPicks,
  darkTheme = false,
  defaultOpen = false,
  selectedLaneId,
  straighten,
  onToggleStraighten,
}) => {
  const [showGuide, setShowGuide] = useState(false);
  const [selectedSideTab, setSelectedSideTab] = useState<'both' | 0 | 1>('both');

  const groups = Math.max(pickGroup + 1, ...picks.map((q) => q.group + 1), 1);
  const isAnyActive = fits.some((f, h) => edgeActive(f, settings[h]));

  const mutColor = darkTheme ? '#94a3b8' : 'var(--mut)';
  const selectedLaneSide = selectedLaneId !== null && selectedLaneId !== undefined ? (selectedLaneId < 27 ? 0 : 1) : null;

  const picksSide0 = picks.filter((q) => q.lane < 27);
  const picksSide1 = picks.filter((q) => q.lane >= 27);

  const containerStyle: React.CSSProperties = darkTheme
    ? {
        fontSize: '12px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: '#334155',
        borderRadius: '8px',
        padding: '10px 14px',
        background: 'rgba(15, 23, 42, 0.98)',
        color: '#f8fafc',
        width: '100%',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        boxSizing: 'border-box',
      }
    : {
        fontSize: '12px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--line)',
        borderRadius: '8px',
        padding: '10px 14px',
        background: 'var(--panel)',
        boxSizing: 'border-box',
      };

  return (
    <div style={containerStyle}>
      {/* Top Header Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '10px',
          paddingBottom: '8px',
          borderBottom: darkTheme ? '1px solid #1e293b' : '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '15px' }}>🎛️</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>TLC Edge Migration Leveling</span>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: '3px',
                  background: isAnyActive ? '#059669' : darkTheme ? '#334155' : 'var(--soft)',
                  color: isAnyActive ? '#ffffff' : mutColor,
                }}
              >
                {isAnyActive ? '● Leveling Active' : '○ Leveling Off'}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: mutColor }}>
              Independent lateral curvature correction for Side 1 and Side 2
            </div>
          </div>
        </div>

        {/* Header Actions: Side Scope Selector, Straighten Photo, and Help Guide */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {onToggleStraighten && (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                color: straighten ? '#38bdf8' : '#cbd5e1',
                background: straighten ? 'rgba(2, 132, 199, 0.2)' : darkTheme ? '#1e293b' : 'var(--soft)',
                padding: '3px 8px',
                borderRadius: '4px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: straighten ? '#0284c7' : darkTheme ? '#334155' : 'var(--line)',
                cursor: 'pointer',
                fontWeight: straighten ? 700 : 500,
              }}
              title="Digitally de-warps the plate photo along the fitted curve so identical spots form a dead-straight horizontal line"
            >
              <input
                type="checkbox"
                checked={Boolean(straighten)}
                onChange={(e) => onToggleStraighten(e.target.checked)}
                style={{ accentColor: '#0284c7' }}
              />
              <span>Straighten Photo</span>
            </label>
          )}

          {/* View Filter: All Sides, Side 1 Only, Side 2 Only */}
          <div
            style={{
              display: 'inline-flex',
              background: darkTheme ? '#090d16' : 'var(--soft)',
              padding: '2px',
              borderRadius: '5px',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: darkTheme ? '#334155' : 'var(--line)',
            }}
          >
            <button
              type="button"
              onClick={() => setSelectedSideTab('both')}
              style={{
                background: selectedSideTab === 'both' ? (darkTheme ? '#334155' : '#ffffff') : 'transparent',
                color: selectedSideTab === 'both' ? '#f8fafc' : mutColor,
                border: 'none',
                padding: '2px 8px',
                borderRadius: '3px',
                fontSize: '10px',
                fontWeight: selectedSideTab === 'both' ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              Both Sides
            </button>
            <button
              type="button"
              onClick={() => setSelectedSideTab(0)}
              style={{
                background: selectedSideTab === 0 ? '#0284c7' : 'transparent',
                color: selectedSideTab === 0 ? '#ffffff' : mutColor,
                border: 'none',
                padding: '2px 8px',
                borderRadius: '3px',
                fontSize: '10px',
                fontWeight: selectedSideTab === 0 ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              Side 1 Only
            </button>
            <button
              type="button"
              onClick={() => setSelectedSideTab(1)}
              style={{
                background: selectedSideTab === 1 ? '#0891b2' : 'transparent',
                color: selectedSideTab === 1 ? '#ffffff' : mutColor,
                border: 'none',
                padding: '2px 8px',
                borderRadius: '3px',
                fontSize: '10px',
                fontWeight: selectedSideTab === 1 ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              Side 2 Only
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowGuide((g) => !g)}
            style={{
              background: showGuide ? '#facc15' : darkTheme ? '#1e293b' : 'var(--soft)',
              color: showGuide ? '#0f172a' : darkTheme ? '#cbd5e1' : 'var(--fg)',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: showGuide ? '#facc15' : darkTheme ? '#334155' : 'var(--line)',
              borderRadius: '4px',
              padding: '3px 8px',
              fontSize: '11px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
            title="Learn how TLC edge effect happens and how Robowski corrects it"
          >
            {showGuide ? '✕ Hide Guide' : '💡 What is This?'}
          </button>
        </div>
      </div>

      {/* Educational Explainer Banner */}
      {showGuide && (
        <div
          style={{
            marginTop: '10px',
            padding: '10px 14px',
            background: darkTheme ? 'rgba(2, 132, 199, 0.12)' : '#f0f9ff',
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: darkTheme ? '#0284c7' : '#bae6fd',
            borderRadius: '6px',
            fontSize: '11px',
            lineHeight: 1.5,
            color: darkTheme ? '#e0f2fe' : '#0369a1',
          }}
        >
          <div style={{ fontWeight: 800, marginBottom: '4px', fontSize: '12px' }}>
            🔬 Why Do TLC Plates Have Curved "Smiles" at the Edges?
          </div>
          <p style={{ margin: '0 0 6px 0' }}>
            In TLC chambers, solvent evaporates faster along the outer edges of the silica plate than in the center.
            This causes the solvent meniscus to curve (the "smile" effect), making identical compounds migrate faster or slower near the left and right margins than in the center.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px', marginTop: '6px' }}>
            <div style={{ background: darkTheme ? 'rgba(0,0,0,0.3)' : '#ffffff', padding: '6px 8px', borderRadius: '4px' }}>
              <b>1. Separate Halves:</b> Side 1 (Lanes 0–26) and Side 2 (Lanes 27–53) have independent flow paths and meniscus shapes. They are modeled and leveled independently.
            </div>
            <div style={{ background: darkTheme ? 'rgba(0,0,0,0.3)' : '#ffffff', padding: '6px 8px', borderRadius: '4px' }}>
              <b>2. Visual Indicators:</b> On the plate photograph, <b>solid cyan ticks</b> indicate raw measured spots; <b>dashed emerald lines</b> show leveled true positions.
            </div>
            <div style={{ background: darkTheme ? 'rgba(0,0,0,0.3)' : '#ffffff', padding: '6px 8px', borderRadius: '4px' }}>
              <b>3. Reference Spot Calibration:</b> If you spotted an internal standard or reagent across multiple lanes, pick those spots to compute a high-precision custom curve.
            </div>
          </div>
        </div>
      )}

      {/* INDEPENDENT SIDE CARDS */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: selectedSideTab === 'both' ? 'repeat(auto-fit, minmax(340px, 1fr))' : '1fr',
          gap: '12px',
          marginTop: '12px',
        }}
      >
        {SIDE_INFO.map((info) => {
          const h = info.index;
          if (selectedSideTab !== 'both' && selectedSideTab !== h) return null;

          const fit = fits[h];
          const s = settings[h];
          const active = edgeActive(fit, s);
          const hasSuggestion = edgeSuggestion(fit, s);
          const isSelectedInThisSide = selectedLaneSide === h;

          const leftShiftPct = fit ? (edgeGain(fit, fit.xmin, s.strength) - 1) * 100 : 0;
          const rightShiftPct = fit ? (edgeGain(fit, fit.xmax, s.strength) - 1) * 100 : 0;

          return (
            <div
              key={h}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                background: darkTheme ? 'rgba(0, 0, 0, 0.35)' : 'var(--soft)',
                padding: '10px 12px',
                borderRadius: '8px',
                borderWidth: '2px',
                borderStyle: 'solid',
                borderColor: isSelectedInThisSide
                  ? '#facc15'
                  : active
                  ? '#059669'
                  : darkTheme
                  ? 'rgba(255,255,255,0.08)'
                  : 'var(--line)',
                boxShadow: isSelectedInThisSide ? '0 0 10px rgba(250, 204, 21, 0.2)' : undefined,
              }}
            >
              {/* Card Header: Side Name, Active Lane Tag, and Status */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '6px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 800, fontSize: '13px', color: h === 0 ? '#38bdf8' : '#06b6d4' }}>
                      {info.title}
                    </span>
                    <span style={{ fontSize: '10px', color: mutColor }}>
                      ({info.tier} · {info.wells})
                    </span>
                    {isSelectedInThisSide && (
                      <span
                        style={{
                          fontSize: '9px',
                          fontWeight: 700,
                          background: '#facc15',
                          color: '#0f172a',
                          padding: '1px 5px',
                          borderRadius: '3px',
                        }}
                      >
                        Lane {selectedLaneId} Selected
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', marginTop: '2px', color: active ? (darkTheme ? '#6ee7b7' : '#047857') : mutColor }}>
                    {active ? (
                      <span>
                        ✓ <b>Leveled:</b> Edge deviation scaled by {Math.round(s.strength * 100)}% strength
                      </span>
                    ) : hasSuggestion ? (
                      <span style={{ color: darkTheme ? '#fde047' : '#b45309' }}>
                        ⚡ <b>Smile Curve Detected:</b> Ready to apply ({((fit?.maxShift || 0) * 100).toFixed(1)}% maximum edge deviation)
                      </span>
                    ) : (
                      <span>○ <b>Raw $R_f$:</b> No leveling applied to this side</span>
                    )}
                  </div>
                </div>

                {/* Primary 1-Click Action for this Side */}
                <div>
                  {active ? (
                    <button
                      type="button"
                      onClick={() => onSetting(h, { ...s, mode: 'off' })}
                      style={{
                        padding: '3px 9px',
                        fontSize: '11px',
                        fontWeight: 700,
                        background: darkTheme ? '#334155' : '#e2e8f0',
                        color: darkTheme ? '#f87171' : '#b91c1c',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: darkTheme ? '#475569' : '#cbd5e1',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                      title={`Turn off edge leveling for ${info.title}`}
                    >
                      ✕ Turn Off {h === 0 ? 'Side 1' : 'Side 2'}
                    </button>
                  ) : hasSuggestion || (fit && fit.ok) ? (
                    <button
                      type="button"
                      onClick={() => onSetting(h, { ...s, mode: 'on' })}
                      style={{
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: 800,
                        background: '#10b981',
                        color: '#022c22',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: '#34d399',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                      title={`Apply detected leveling curve to ${info.title}`}
                    >
                      ⚡ Level {h === 0 ? 'Side 1' : 'Side 2'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSetting(h, { ...s, mode: 'on' })}
                      disabled={!fit || fit.nSpots === 0}
                      style={{
                        padding: '3px 9px',
                        fontSize: '11px',
                        fontWeight: 600,
                        background: darkTheme ? '#1e293b' : '#f1f5f9',
                        color: darkTheme ? '#cbd5e1' : '#64748b',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: darkTheme ? '#475569' : '#cbd5e1',
                        borderRadius: '4px',
                        cursor: fit && fit.nSpots > 0 ? 'pointer' : 'not-allowed',
                        opacity: fit && fit.nSpots > 0 ? 1 : 0.5,
                      }}
                    >
                      Turn On
                    </button>
                  )}
                </div>
              </div>

              {/* Side Controls & Curve Visualizer */}
              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  background: darkTheme ? '#090d16' : 'rgba(255,255,255,0.6)',
                  borderRadius: '6px',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: darkTheme ? '#1e293b' : 'rgba(0,0,0,0.06)',
                }}
              >
                {/* Left: Mode Switcher & Strength Slider */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 180px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '10px', color: mutColor, fontWeight: 700 }}>Mode:</span>
                    <div
                      style={{
                        display: 'inline-flex',
                        background: darkTheme ? '#1e293b' : '#e2e8f0',
                        padding: '1px',
                        borderRadius: '4px',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => onSetting(h, { ...s, mode: 'off' })}
                        style={{
                          background: s.mode === 'off' ? (darkTheme ? '#475569' : '#ffffff') : 'transparent',
                          color: s.mode === 'off' ? '#ffffff' : mutColor,
                          border: 'none',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontSize: '10px',
                          fontWeight: s.mode === 'off' ? 700 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        Off
                      </button>
                      <button
                        type="button"
                        onClick={() => onSetting(h, { ...s, mode: 'auto' })}
                        style={{
                          background: s.mode === 'auto' ? '#0284c7' : 'transparent',
                          color: s.mode === 'auto' ? '#ffffff' : mutColor,
                          border: 'none',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontSize: '10px',
                          fontWeight: s.mode === 'auto' ? 700 : 500,
                          cursor: 'pointer',
                        }}
                        title="Auto applies when reference spots are picked"
                      >
                        Auto (Picks)
                      </button>
                      <button
                        type="button"
                        onClick={() => onSetting(h, { ...s, mode: 'on' })}
                        style={{
                          background: s.mode === 'on' ? '#059669' : 'transparent',
                          color: s.mode === 'on' ? '#ffffff' : mutColor,
                          border: 'none',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontSize: '10px',
                          fontWeight: s.mode === 'on' ? 700 : 500,
                          cursor: 'pointer',
                        }}
                        title="Always apply the calculated curve"
                      >
                        Manual ON
                      </button>
                    </div>
                  </div>

                  {/* Leveling Strength Slider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '10px', color: mutColor, fontWeight: 700 }}>Strength:</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={s.strength}
                      onChange={(e) => onSetting(h, { ...s, strength: parseFloat(e.target.value) })}
                      style={{ flex: 1, accentColor: '#ec4899', height: '14px', cursor: 'pointer' }}
                    />
                    <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: darkTheme ? '#f472b6' : '#db2777', minWidth: '34px' }}>
                      {Math.round(s.strength * 100)}%
                    </span>
                  </div>

                  {/* Curvature Summary */}
                  {fit && (
                    <div style={{ fontSize: '10px', color: mutColor, lineHeight: 1.3 }}>
                      Left: <b style={{ color: darkTheme ? '#f8fafc' : undefined }}>{leftShiftPct >= 0 ? '+' : ''}{leftShiftPct.toFixed(1)}%</b> ·{' '}
                      Right: <b style={{ color: darkTheme ? '#f8fafc' : undefined }}>{rightShiftPct >= 0 ? '+' : ''}{rightShiftPct.toFixed(1)}%</b>
                      {fit.model && <span style={{ color: '#38bdf8' }}> ({fit.model})</span>}
                    </div>
                  )}
                </div>

                {/* Right: SVG Diagnostic Plot */}
                {fit && fit.used.length > 0 ? (
                  <div style={{ flex: '0 0 auto' }}>
                    <DiagnosticPlot fit={fit} strength={active ? s.strength : 1} dark={darkTheme} />
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: mutColor, fontStyle: 'italic', padding: '12px' }}>
                    {fit?.reason || 'No curvature fit calculated for this side yet.'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* REFERENCE SPOT CALIBRATOR SECTION */}
      <div
        style={{
          marginTop: '12px',
          padding: '10px 12px',
          background: darkTheme ? 'rgba(0, 0, 0, 0.25)' : 'var(--soft)',
          borderRadius: '8px',
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: darkTheme ? 'rgba(255,255,255,0.06)' : 'var(--line)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🎯 Custom Calibration with Reference Spots</span>
              <span style={{ fontSize: '10px', color: mutColor }}>
                (Side 1: <b>{picksSide0.length}</b> picks · Side 2: <b>{picksSide1.length}</b> picks)
              </span>
            </div>
            <div style={{ fontSize: '11px', color: mutColor }}>
              {pickMode
                ? 'Click detected spots along lanes across the plate to mark your standard compound; click again to remove.'
                : 'Have starting material or an internal standard across multiple wells? Pick them to measure the exact curve.'}
            </div>
          </div>

          {/* Pick Mode Toggle Button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              type="button"
              className={`btn sm${pickMode ? ' pri' : ''}`}
              onClick={() => onPickMode(!pickMode)}
              style={
                darkTheme
                  ? {
                      background: pickMode ? '#ec4899' : '#1e293b',
                      color: '#ffffff',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: pickMode ? '#db2777' : '#475569',
                      fontWeight: 700,
                      padding: '4px 12px',
                    }
                  : undefined
              }
            >
              {pickMode ? '🎯 Done Picking' : '🎯 Pick Reference Spots'}
            </button>
            {picks.length > 0 && (
              <button
                type="button"
                className="btn sm"
                onClick={onClearPicks}
                style={
                  darkTheme
                    ? {
                        background: '#1e293b',
                        color: '#f87171',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: '#7f1d1d',
                        fontSize: '11px',
                      }
                    : { fontSize: '11px' }
                }
              >
                Clear All Picks ({picks.length})
              </button>
            )}
          </div>
        </div>

        {/* Compound Selector Chips (when pickMode or picks exist) */}
        {(pickMode || picks.length > 0) && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
            <span style={{ fontSize: '11px', color: mutColor }}>Select Compound:</span>
            {Array.from({ length: groups }, (_, g) => (
              <button
                key={g}
                type="button"
                className="btn sm"
                onClick={() => onPickGroup(g)}
                aria-pressed={pickGroup === g}
                style={{
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: PICK_COLORS[g % PICK_COLORS.length],
                  fontWeight: pickGroup === g ? 800 : 500,
                  outline: pickGroup === g ? `2px solid ${PICK_COLORS[g % PICK_COLORS.length]}` : undefined,
                  background: darkTheme ? (pickGroup === g ? '#334155' : '#0f172a') : undefined,
                  color: darkTheme ? '#f8fafc' : undefined,
                  fontSize: '11px',
                  padding: '2px 8px',
                }}
                title={`Compound ${g + 1}`}
              >
                Compound {g + 1} ({picks.filter((q) => q.group === g).length} spots)
              </button>
            ))}
            <button
              type="button"
              className="btn sm"
              onClick={() => onPickGroup(groups)}
              title="Add another reference compound"
              style={
                darkTheme
                  ? {
                      background: '#1e293b',
                      color: '#f8fafc',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: '#475569',
                      fontSize: '11px',
                      padding: '2px 6px',
                    }
                  : { fontSize: '11px', padding: '2px 6px' }
              }
            >
              + New Compound
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
