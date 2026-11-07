import React from 'react';
import { EdgeFit, EdgePick, EdgeSetting, edgeActive, edgeGain, edgeSuggestion } from '../../engine/tlcEdge';

interface Props {
  fits: (EdgeFit | null)[]; // one per half (lanes 0-26, lanes 27-53)
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
}

const PICK_COLORS = ['#f59e0b', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#eab308'];

const HALF_NAME = ['Lanes 0–26', 'Lanes 27–53'];

function Diagnostic({ fit, strength, dark }: { fit: EdgeFit; strength: number; dark?: boolean }) {
  const w = 190, h = 56, pad = 4;
  const ys = fit.used.map((p) => p.y);
  const lim = Math.max(0.03, ...ys.map(Math.abs), fit.maxShift);
  const X = (u: number) => pad + ((u + 1) / 2) * (w - 2 * pad);
  const Y = (v: number) => h / 2 - (v / lim) * (h / 2 - pad);
  const path = Array.from({ length: 41 }, (_, i) => {
    const u = -1 + i / 20;
    return `${i ? 'L' : 'M'}${X(u).toFixed(1)},${Y(strength * (fit.c1 * u + fit.c2 * u * u)).toFixed(1)}`;
  }).join('');
  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label="Spot position against lane position, with the fitted curve"
      style={{
        background: dark ? '#0f172a' : 'var(--soft)',
        borderRadius: 4,
        flex: '0 0 auto',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: dark ? '#334155' : 'rgba(0,0,0,0.06)',
      }}
    >
      <line x1={pad} x2={w - pad} y1={h / 2} y2={h / 2} stroke={dark ? '#334155' : 'var(--line)'} />
      {fit.used.map((p, i) => (
        <circle key={i} cx={X(p.u)} cy={Y(p.y)} r={1.6} fill={dark ? '#94a3b8' : 'var(--mut)'} opacity={0.7} />
      ))}
      <path d={path} fill="none" stroke="#ec4899" strokeWidth={1.8} />
    </svg>
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
}) => {
  const groups = Math.max(pickGroup + 1, ...picks.map((q) => q.group + 1), 1);
  const isActive = fits.some((f, h) => edgeActive(f, settings[h]));

  const containerStyle: React.CSSProperties = darkTheme
    ? {
        fontSize: 12,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: '#334155',
        borderRadius: 8,
        padding: '8px 12px',
        background: 'rgba(15, 23, 42, 0.95)',
        color: '#f8fafc',
        width: '100%',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }
    : {
        fontSize: 12,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--line)',
        borderRadius: 6,
        padding: '6px 10px',
        background: 'var(--panel)',
      };

  const mutColor = darkTheme ? '#94a3b8' : 'var(--mut)';
  const selectBg = darkTheme ? '#1e293b' : undefined;
  const selectColor = darkTheme ? '#f8fafc' : undefined;

  return (
    <details style={containerStyle} open={defaultOpen || pickMode}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between', userSelect: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span>🎛️</span>
          <span>Edge-Effect Migration Correction</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {!isActive && fits.some((f, h) => edgeSuggestion(f, settings[h])) && (
            <button
              type="button"
              className="btn sm"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                fits.forEach((f, h) => {
                  if (f && f.ok) onSetting(h, { ...settings[h], mode: 'on' });
                });
              }}
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#10b981',
                color: '#022c22',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: '#34d399',
                cursor: 'pointer',
              }}
              title="Apply detected migration curvature across all halves"
            >
              ⚡ Apply Detected Curves
            </button>
          )}
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 4,
              background: isActive ? '#059669' : darkTheme ? '#334155' : 'var(--soft)',
              color: isActive ? '#ffffff' : mutColor,
            }}
          >
            {isActive ? '● Active' : '○ Off'}
          </span>
        </div>
      </summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn sm${pickMode ? ' pri' : ''}`}
            onClick={() => onPickMode(!pickMode)}
            style={darkTheme ? { background: pickMode ? '#ec4899' : '#1e293b', color: '#fff', borderWidth: '1px', borderStyle: 'solid', borderColor: pickMode ? '#db2777' : '#475569' } : undefined}
          >
            {pickMode ? '🎯 Picking spots… (click to stop)' : '🎯 Pick same-compound spots'}
          </button>
          <span style={{ color: mutColor }}>Compound:</span>
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
                fontWeight: pickGroup === g ? 700 : 400,
                outline: pickGroup === g ? `2px solid ${PICK_COLORS[g % PICK_COLORS.length]}` : undefined,
                background: darkTheme ? (pickGroup === g ? '#334155' : '#0f172a') : undefined,
                color: darkTheme ? '#f8fafc' : undefined,
              }}
              title={`Compound ${g + 1}`}
            >
              {g + 1} ({picks.filter((q) => q.group === g).length})
            </button>
          ))}
          <button
            type="button"
            className="btn sm"
            onClick={() => onPickGroup(groups)}
            title="Start another compound"
            style={darkTheme ? { background: '#1e293b', color: '#f8fafc', borderWidth: '1px', borderStyle: 'solid', borderColor: '#475569' } : undefined}
          >
            + new
          </button>
          {picks.length > 0 ? (
            <button
              type="button"
              className="btn sm"
              onClick={onClearPicks}
              style={darkTheme ? { background: '#1e293b', color: '#f87171', borderWidth: '1px', borderStyle: 'solid', borderColor: '#7f1d1d' } : undefined}
            >
              Clear picks
            </button>
          ) : null}
        </div>
        <div style={{ color: mutColor, fontSize: 11 }}>
          {pickMode
            ? 'In the Full plate view, click a detected spot to add it to the chosen compound; click it again to remove it. Pick the same compound in lanes near both edges and in the middle.'
            : 'Pick spots that must have the same Rf (for example a starting material or internal standard) and the lateral migration curvature is calculated directly from them.'}
        </div>
        {[0, 1].map((h) => {
          const fit = fits[h];
          const s = settings[h];
          const active = edgeActive(fit, s);
          const hasSuggestion = edgeSuggestion(fit, s);
          return (
            <div
              key={h}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
                background: darkTheme ? 'rgba(0,0,0,0.25)' : 'var(--soft)',
                padding: '6px 10px',
                borderRadius: 6,
                borderWidth: darkTheme ? '1px' : undefined,
                borderStyle: darkTheme ? 'solid' : undefined,
                borderColor: darkTheme ? 'rgba(255,255,255,0.06)' : undefined,
              }}
            >
              <div style={{ minWidth: 220, flex: '1 1 220px' }}>
                <b style={{ color: darkTheme ? '#38bdf8' : undefined }}>{HALF_NAME[h]}</b>{' '}
                {!fit ? (
                  <span style={{ color: mutColor }}>no data</span>
                ) : active ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ color: darkTheme ? '#a7f3d0' : '#047857' }}>
                      ✓ corrected: edge lanes {((edgeGain(fit, fit.xmin, s.strength) - 1) * 100).toFixed(1)} % /{' '}
                      {((edgeGain(fit, fit.xmax, s.strength) - 1) * 100).toFixed(1)} % ({fit.nClusters} compound group
                      {fit.nClusters === 1 ? '' : 's'}, {fit.nSpots} spots, scatter {(fit.scatter * 100).toFixed(1)} %)
                    </span>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => onSetting(h, { ...s, mode: 'off' })}
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: darkTheme ? '#334155' : '#f1f5f9',
                        color: darkTheme ? '#cbd5e1' : '#475569',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: darkTheme ? '#475569' : '#cbd5e1',
                        borderRadius: 3,
                      }}
                      title="Turn off edge correction for this plate half"
                    >
                      Turn off
                    </button>
                  </div>
                ) : hasSuggestion ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ color: darkTheme ? '#fde047' : '#b45309' }}>
                      ⚡ Curve detected: edge lanes {((edgeGain(fit, fit.xmin) - 1) * 100).toFixed(1)} % /{' '}
                      {((edgeGain(fit, fit.xmax) - 1) * 100).toFixed(1)} % ({fit.nClusters} compound groups).
                    </span>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => onSetting(h, { ...s, mode: 'on' })}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 7px',
                        background: '#10b981',
                        color: '#022c22',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: '#34d399',
                        borderRadius: 3,
                      }}
                      title="Apply this detected curvature to spots and Rf"
                    >
                      ⚡ Apply Detected Curve
                    </button>
                  </div>
                ) : (
                  <span style={{ color: mutColor }}>{s.mode === 'off' ? 'off' : `not applied. ${fit.reason}`}</span>
                )}
                {fit && fit.nSpots > 0 && !active && !hasSuggestion && s.mode !== 'off' ? (
                  <span style={{ color: mutColor }}> Measured curve {(fit.maxShift * 100).toFixed(1)} % at most.</span>
                ) : null}
              </div>
              <select
                className="f"
                value={s.mode}
                onChange={(e) => onSetting(h, { ...s, mode: e.target.value as EdgeSetting['mode'] })}
                aria-label={`${HALF_NAME[h]} edge correction mode`}
                style={{
                  background: selectBg,
                  color: selectColor,
                  borderWidth: darkTheme ? '1px' : undefined,
                  borderStyle: darkTheme ? 'solid' : undefined,
                  borderColor: darkTheme ? '#475569' : undefined,
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontSize: 11,
                }}
              >
                <option value="on">On (Apply curve)</option>
                <option value="auto">Auto (reference spots only)</option>
                <option value="off">Off</option>
              </select>
              <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <span style={{ color: mutColor }}>Strength</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={s.strength}
                  onChange={(e) => onSetting(h, { ...s, strength: parseFloat(e.target.value) })}
                  style={{ width: 70, accentColor: '#ec4899' }}
                />
                <span className="mono" style={{ minWidth: 30, color: darkTheme ? '#f8fafc' : undefined }}>
                  {Math.round(s.strength * 100)}%
                </span>
              </label>
              {fit && fit.used.length > 0 ? <Diagnostic fit={fit} strength={active ? s.strength : 1} dark={darkTheme} /> : null}
            </div>
          );
        })}
        <div style={{ color: mutColor, fontSize: 11 }}>
          Each half of the plate is fitted on its own from compounds that appear in many lanes. Raw Rf is kept next to the corrected Rf in the CSV.
        </div>
      </div>
    </details>
  );
};
