import React, { useEffect, useRef, useState } from 'react';
import { ComparableRun, wellLabel } from '../../engine';

const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

interface CompareWellPickerProps {
  compRun: ComparableRun;
  plateIndex: number;
  wellIndex: number;
  accentColor?: string;
  onChange: (plateIndex: number, wellIndex: number) => void;
}

export const CompareWellPicker: React.FC<CompareWellPickerProps> = ({
  compRun,
  plateIndex,
  wellIndex,
  accentColor = 'var(--acc)',
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const platesCount = Math.max(1, compRun.run?.plates || 1);
  const coord = wellLabel(wellIndex);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={popRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn sm mono"
        onClick={() => setOpen((o) => !o)}
        style={{
          height: '30px',
          padding: '0 10px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          borderColor: open ? accentColor : 'var(--line)',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
        title="Click to pick a well visually from the 6×9 plate map"
      >
        <span>
          P{plateIndex + 1} · {coord}
        </span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{open ? '▲' : '▾'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 60,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: '11px',
            padding: '10px',
            boxShadow: 'var(--shadow-lg)',
            minWidth: '286px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginBottom: '8px',
            }}
          >
            <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--fg2)' }}>
              Select Well
            </span>
            {platesCount > 1 && (
              <div className="seg" style={{ padding: '2px' }}>
                {Array.from({ length: platesCount }, (_, p) => (
                  <button
                    key={p}
                    type="button"
                    className={plateIndex === p ? 'on' : ''}
                    style={{ height: '22px', padding: '0 8px', fontSize: '11px' }}
                    onClick={() => onChange(p, wellIndex)}
                  >
                    P{p + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '16px repeat(9, minmax(24px, 1fr))',
              gap: '3px',
              alignItems: 'center',
            }}
          >
            <div />
            {Array.from({ length: 9 }, (_, c) => (
              <div
                key={c}
                className="mono"
                style={{ fontSize: '10px', color: 'var(--mut)', textAlign: 'center' }}
              >
                {c + 1}
              </div>
            ))}

            {ROW_LETTERS.map((letter, r) => (
              <React.Fragment key={letter}>
                <div
                  className="mono"
                  style={{ fontSize: '10px', color: 'var(--mut)', textAlign: 'center' }}
                >
                  {letter}
                </div>
                {Array.from({ length: 9 }, (_, c) => {
                  const wIdx = r * 9 + c;
                  const row =
                    compRun.run?.rows.find(
                      (rw) => rw.plate_number === plateIndex && rw.container_id === wIdx
                    ) || compRun.run?.rows[plateIndex * 54 + wIdx];
                  const gIdx = row?.global_index ?? plateIndex * 54 + wIdx;
                  const isBlank =
                    !row ||
                    Boolean(compRun.triMeta?.[gIdx]?.blank) ||
                    row.recipe.every((rc) => Number(rc.target_concentration) <= 0);
                  const obs = compRun.state.eln?.wells?.[`${plateIndex}-${wIdx}`];
                  const isSel = wellIndex === wIdx;
                  const label = `${letter}${c + 1}`;

                  let bg = 'var(--soft)';
                  let fg = 'var(--fg)';
                  if (obs?.status === 'hit') {
                    bg = 'var(--okbg)';
                    fg = 'var(--ok)';
                  } else if (obs?.status === 'clean') {
                    bg = 'color-mix(in srgb, var(--ok) 14%, var(--panel))';
                  } else if (obs?.status === 'decomp') {
                    bg = 'var(--badbg)';
                    fg = 'var(--bad)';
                  } else if (isBlank) {
                    bg = 'var(--panel)';
                    fg = 'var(--mut)';
                  }

                  return (
                    <button
                      key={c}
                      type="button"
                      className="mono"
                      onClick={() => {
                        onChange(plateIndex, wIdx);
                        setOpen(false);
                      }}
                      style={{
                        height: '24px',
                        padding: 0,
                        borderRadius: '5px',
                        border: isSel
                          ? `2px solid ${accentColor}`
                          : '1px solid var(--line2)',
                        background: isSel ? 'var(--accbg)' : bg,
                        color: isSel ? 'var(--accfg)' : fg,
                        fontSize: '10px',
                        fontWeight: isSel ? 700 : 500,
                        opacity: isBlank && !isSel ? 0.52 : 1,
                        cursor: 'pointer',
                      }}
                      title={
                        isBlank
                          ? `${label} (Blank / Empty)`
                          : `${label}${obs?.status && obs.status !== 'none' ? ` · ${obs.status}` : ''}`
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
