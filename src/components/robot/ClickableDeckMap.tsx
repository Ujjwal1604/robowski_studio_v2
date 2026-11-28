import React, { useMemo, useState } from 'react';
import { Check, Grid3X3, Move } from 'lucide-react';
import type { RunResult } from '../../types';

interface ClickableDeckMapProps {
  run: RunResult | null;
  measuredSurfaceZ?: Record<string, number>;
  selectedPlate: number;
  selectedSlot: number;
  cmdBusy: boolean;
  onSelectSlot: (plateId: number, slotId: number, moveImmediately: boolean) => void;
  onMoveSelected: () => void;
}

interface SlotMeta {
  shortName: string;
  fullName: string;
  savedZ: number | null;
  isSolvent?: boolean;
}

const VIAL_ROWS = ['A', 'B', 'C', 'D', 'E', 'F'];

export const ClickableDeckMap: React.FC<ClickableDeckMapProps> = ({
  run,
  measuredSurfaceZ,
  selectedPlate,
  selectedSlot,
  cmdBusy,
  onSelectSlot,
  onMoveSelected,
}) => {
  const [open, setOpen] = useState<boolean>(false);
  const [clickMovesArm, setClickMovesArm] = useState<boolean>(false);
  const [activeVialPlate, setActiveVialPlate] = useState<0 | 1 | 2>(0);

  // Map "plate:slot" -> run reagent/solvent metadata
  const slotMap = useMemo(() => {
    const map = new Map<string, SlotMeta>();
    if (!run) return map;
    const saved = measuredSurfaceZ || {};
    if (run.deck) {
      map.set(`${run.deck.solvent_plate}:${run.deck.solvent_container}`, {
        shortName: 'Solvent',
        fullName: `Solvent (${run.reactionSolvent || 'solvent'})`,
        savedZ: typeof saved.solvent === 'number' ? saved.solvent : null,
        isSolvent: true,
      });
    }
    for (const [k, s] of Object.entries(run.stocks || {})) {
      if (s.source_only) continue;
      const name = s.substance || k;
      map.set(`${s.breadboard_plate_id}:${s.container_id}`, {
        shortName: name.length > 7 ? `${name.slice(0, 6)}…` : name,
        fullName: `${name} (${s.solvent || ''}, ${s.prep_volume_ml.toFixed(1)} mL)`,
        savedZ: typeof saved[k] === 'number' ? saved[k] : null,
      });
    }
    return map;
  }, [run, measuredSurfaceZ]);

  const handleTap = (plateId: number, slotId: number) => {
    onSelectSlot(plateId, slotId, clickMovesArm);
  };

  return (
    <div
      style={{
        marginTop: '14px',
        borderRadius: '8px',
        border: '1px solid var(--line)',
        background: 'var(--soft)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Grid3X3 size={15} style={{ color: 'var(--acc)' }} />
          <strong style={{ fontSize: '13px' }}>Clickable Deck Map</strong>
          <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
            Tap any bottle, jar, or vial instead of typing plate &amp; slot numbers
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {open && (
            <>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11.5px',
                  color: clickMovesArm ? 'var(--warn)' : 'var(--fg2)',
                  fontWeight: clickMovesArm ? 700 : 500,
                  cursor: 'pointer',
                }}
                title="When checked, clicking any slot moves the robot arm immediately"
              >
                <input
                  type="checkbox"
                  checked={clickMovesArm}
                  onChange={(e) => setClickMovesArm(e.target.checked)}
                />
                Click moves arm immediately
              </label>
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={onMoveSelected}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Move size={12} />
                <span>
                  Move to P{selectedPlate}:{selectedSlot}
                </span>
              </button>
            </>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide Map' : 'Open Deck Map'}
          </button>
        </div>
      </div>

      {open && (
        <div
          style={{
            padding: '14px',
            borderTop: '1px solid var(--line)',
            background: 'var(--panel)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: '14px',
          }}
        >
          {/* Left: Bottle Racks (plate3, plate4, plate5) + Solvent Jars (plate6, plate7) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--fg2)' }}>
              Stock Bottles (plate3–5) &amp; Solvent Jars (plate6–7)
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 145px), 1fr))',
                gap: '8px',
              }}
            >
              {[3, 4, 5].map((plateId) => (
                <div
                  key={plateId}
                  style={{
                    padding: '8px',
                    borderRadius: '7px',
                    border: '1px solid var(--line)',
                    background: 'var(--soft)',
                  }}
                >
                  <div
                    className="mono"
                    style={{ fontSize: '11px', fontWeight: 700, color: 'var(--mut)', marginBottom: '6px' }}
                  >
                    plate{plateId} (Bottles 0–7)
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                      gap: '5px',
                    }}
                  >
                    {Array.from({ length: 8 }, (_, slot) => {
                      const meta = slotMap.get(`${plateId}:${slot}`);
                      const isSel = selectedPlate === plateId && selectedSlot === slot;
                      const isMeasured = meta?.savedZ != null;
                      return (
                        <button
                          key={slot}
                          type="button"
                          disabled={cmdBusy && clickMovesArm}
                          onClick={() => handleTap(plateId, slot)}
                          title={
                            meta
                              ? `plate${plateId} pos ${slot}: ${meta.fullName}${
                                  meta.savedZ != null ? ` · Measured Z=${meta.savedZ}` : ''
                                }`
                              : `plate${plateId} pos ${slot} (empty)`
                          }
                          style={{
                            padding: '5px 2px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            textAlign: 'center',
                            minHeight: '42px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '1px',
                            border: isSel
                              ? '2px solid var(--acc)'
                              : isMeasured
                              ? '1.5px solid var(--ok)'
                              : meta
                              ? '1px solid color-mix(in srgb, var(--acc) 45%, var(--line))'
                              : '1px solid var(--line)',
                            background: isSel
                              ? 'color-mix(in srgb, var(--acc) 15%, var(--panel))'
                              : isMeasured
                              ? 'color-mix(in srgb, var(--ok) 12%, var(--panel))'
                              : meta
                              ? 'var(--panel)'
                              : 'transparent',
                            color: 'var(--fg)',
                          }}
                        >
                          <span className="mono" style={{ fontSize: '10.5px', fontWeight: 700 }}>
                            {slot}
                            {isMeasured ? (
                              <Check size={9} style={{ color: 'var(--ok)', marginLeft: '2px', verticalAlign: 'middle' }} />
                            ) : null}
                          </span>
                          <span
                            style={{
                              fontSize: '9.5px',
                              color: meta ? 'var(--fg2)' : 'var(--mut)',
                              maxWidth: '100%',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {meta ? meta.shortName : '—'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Jars plate6 & plate7 */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 135px), 1fr))',
                gap: '8px',
              }}
            >
              {[6, 7].map((plateId) => (
                <div
                  key={plateId}
                  style={{
                    padding: '8px',
                    borderRadius: '7px',
                    border: '1px solid var(--line)',
                    background: 'var(--soft)',
                  }}
                >
                  <div
                    className="mono"
                    style={{ fontSize: '11px', fontWeight: 700, color: 'var(--mut)', marginBottom: '6px' }}
                  >
                    plate{plateId} (Jars 0–1)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                    {[0, 1].map((slot) => {
                      const meta = slotMap.get(`${plateId}:${slot}`);
                      const isSel = selectedPlate === plateId && selectedSlot === slot;
                      const isMeasured = meta?.savedZ != null;
                      return (
                        <button
                          key={slot}
                          type="button"
                          disabled={cmdBusy && clickMovesArm}
                          onClick={() => handleTap(plateId, slot)}
                          title={
                            meta
                              ? `plate${plateId} pos ${slot}: ${meta.fullName}${
                                  meta.savedZ != null ? ` · Measured Z=${meta.savedZ}` : ''
                                }`
                              : `plate${plateId} jar ${slot}`
                          }
                          style={{
                            padding: '6px 4px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            textAlign: 'center',
                            border: isSel
                              ? '2px solid var(--acc)'
                              : isMeasured
                              ? '1.5px solid var(--ok)'
                              : meta
                              ? '1px solid color-mix(in srgb, var(--acc) 45%, var(--line))'
                              : '1px solid var(--line)',
                            background: isSel
                              ? 'color-mix(in srgb, var(--acc) 15%, var(--panel))'
                              : isMeasured
                              ? 'color-mix(in srgb, var(--ok) 12%, var(--panel))'
                              : meta
                              ? 'var(--panel)'
                              : 'transparent',
                            color: 'var(--fg)',
                            fontSize: '11px',
                          }}
                        >
                          <div className="mono" style={{ fontWeight: 700 }}>
                            Jar {slot}
                            {isMeasured ? (
                              <Check size={10} style={{ color: 'var(--ok)', marginLeft: '3px', verticalAlign: 'middle' }} />
                            ) : null}
                          </div>
                          <div style={{ fontSize: '10px', color: meta ? 'var(--fg2)' : 'var(--mut)' }}>
                            {meta ? meta.shortName : 'Empty'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: 54-Vial Reaction Plate Picker (plate0, plate1, plate2) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--fg2)' }}>
                Reaction Vials (0–53)
              </span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {([0, 1, 2] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={activeVialPlate === p ? 'btn sm pri' : 'btn sm'}
                    onClick={() => setActiveVialPlate(p)}
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                  >
                    plate{p}
                  </button>
                ))}
              </div>
            </div>

            <div
              style={{
                padding: '8px',
                borderRadius: '7px',
                border: '1px solid var(--line)',
                background: 'var(--soft)',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(9, minmax(0, 1fr))',
                  gap: '4px',
                }}
              >
                {Array.from({ length: 54 }, (_, idx) => {
                  const row = Math.floor(idx / 9);
                  const col = (idx % 9) + 1;
                  const well = `${VIAL_ROWS[row]}${col}`;
                  const isSel = selectedPlate === activeVialPlate && selectedSlot === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      disabled={cmdBusy && clickMovesArm}
                      onClick={() => handleTap(activeVialPlate, idx)}
                      title={`plate${activeVialPlate}, vial ${idx} (${well})`}
                      className="mono robot-vial-cell"
                      style={{
                        height: '28px',
                        padding: 0,
                        borderRadius: '5px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        touchAction: 'manipulation',
                        border: isSel ? '2px solid var(--acc)' : '1px solid var(--line)',
                        background: isSel
                          ? 'color-mix(in srgb, var(--acc) 18%, var(--panel))'
                          : 'var(--panel)',
                        color: isSel ? 'var(--acc)' : 'var(--fg)',
                        fontWeight: isSel ? 700 : 500,
                      }}
                    >
                      {well}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '6px' }}>
                Selected:{' '}
                <strong className="mono" style={{ color: 'var(--fg)' }}>
                  plate{selectedPlate}, pos {selectedSlot}
                </strong>{' '}
                · Green border = Z height measured &amp; saved
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
