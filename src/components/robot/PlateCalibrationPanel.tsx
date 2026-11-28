import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Compass,
  Crosshair,
  Edit3,
  Navigation,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import type {
  RobotHardwareState,
  RobotPlatePreset,
} from '../../engine/predictor/backendClient';
import {
  analyzeThreeCorners,
  rowLetter,
} from '../../utils/plateFormats';

interface PlateCalibrationPanelProps {
  hw: RobotHardwareState | null;
  cmdBusy: boolean;
  ptActive: boolean;
  initialSlot?: 0 | 1 | 2;
  onRunCommand: (command: string, params?: Record<string, any>) => Promise<any>;
  onPresetSaved?: (presetId: string, slot: 0 | 1 | 2) => void;
}

const TEMPLATES = [
  { label: '96-well (8×12)', name: '96-well microplate', rows: 8, cols: 12, defaultZ: 1850, pitch: 9.0 },
  { label: '24-well (4×6)', name: '24-well plate', rows: 4, cols: 6, defaultZ: 1950, pitch: 19.3 },
  { label: '48-well (6×8)', name: '48-well plate', rows: 6, cols: 8, defaultZ: 1900, pitch: 13.08 },
] as const;

export const PlateCalibrationPanel: React.FC<PlateCalibrationPanelProps> = ({
  hw,
  cmdBusy,
  ptActive,
  initialSlot = 1,
  onRunCommand,
  onPresetSaved,
}) => {
  const presets = hw?.platePresets || [];
  const liveXY = hw?.currentXY || null;
  const liveZ = hw?.currentZ ?? null;

  const [editingId, setEditingId] = useState<string>('');
  const [name, setName] = useState<string>('96-well microplate');
  const [plateSlot, setPlateSlot] = useState<0 | 1 | 2>(initialSlot);
  const [rows, setRows] = useState<number>(8);
  const [cols, setCols] = useState<number>(12);
  const [defaultZ, setDefaultZ] = useState<number>(1850);

  const [a1X, setA1X] = useState<number>(0);
  const [a1Y, setA1Y] = useState<number>(0);
  const [trX, setTrX] = useState<number>(99);
  const [trY, setTrY] = useState<number>(0);
  const [blX, setBlX] = useState<number>(0);
  const [blY, setBlY] = useState<number>(63);
  const [capturedFlags, setCapturedFlags] = useState<{ a1: boolean; tr: boolean; bl: boolean }>({
    a1: false,
    tr: false,
    bl: false,
  });

  const [jogStepMm, setJogStepMm] = useState<number>(2);
  const [jogStepZ, setJogStepZ] = useState<number>(10);
  const [localHint, setLocalHint] = useState<string>('');

  useEffect(() => {
    setPlateSlot(initialSlot);
  }, [initialSlot]);

  const topRightLabel = `A${cols}`;
  const bottomLeftLabel = `${rowLetter(rows - 1)}1`;
  const oppositeWellIdx = rows * cols - 1;

  const geometry = useMemo(
    () => analyzeThreeCorners(rows, cols, [a1X, a1Y], [trX, trY], [blX, blY]),
    [rows, cols, a1X, a1Y, trX, trY, blX, blY]
  );

  const applyTemplate = (tpl: (typeof TEMPLATES)[number]) => {
    setEditingId('');
    setName(tpl.name);
    setRows(tpl.rows);
    setCols(tpl.cols);
    setDefaultZ(tpl.defaultZ);
    // Keep current A1 if already captured and preview standard span
    const baseX = capturedFlags.a1 ? a1X : 0;
    const baseY = capturedFlags.a1 ? a1Y : 0;
    setTrX(Number((baseX + (tpl.cols - 1) * tpl.pitch).toFixed(2)));
    setTrY(baseY);
    setBlX(baseX);
    setBlY(Number((baseY + (tpl.rows - 1) * tpl.pitch).toFixed(2)));
    setCapturedFlags((prev) => ({ a1: prev.a1, tr: false, bl: false }));
  };

  const loadPresetForEdit = (p: RobotPlatePreset) => {
    setEditingId(p.id);
    setName(p.name);
    setPlateSlot(p.plateSlot);
    setRows(p.rows);
    setCols(p.cols);
    setDefaultZ(p.defaultZ);
    setA1X(p.cornerA1[0]);
    setA1Y(p.cornerA1[1]);
    setTrX(p.cornerTopRight[0]);
    setTrY(p.cornerTopRight[1]);
    setBlX(p.cornerBottomLeft[0]);
    setBlY(p.cornerBottomLeft[1]);
    setCapturedFlags({ a1: true, tr: true, bl: true });
    setLocalHint(`Editing '${p.name}' on plate${p.plateSlot}.`);
  };

  const readAndCapture = async (corner: 'a1' | 'tr' | 'bl', includeZ = false) => {
    const res = await onRunCommand('read_xy_position');
    const xy: [number, number] | null =
      Array.isArray(res?.data?.xy) && res.data.xy.length === 2
        ? [Number(res.data.xy[0]), Number(res.data.xy[1])]
        : Array.isArray(res?.hardware?.currentXY) && res.hardware.currentXY.length === 2
        ? [Number(res.hardware.currentXY[0]), Number(res.hardware.currentXY[1])]
        : liveXY;
    const zVal =
      typeof res?.data?.zPosition === 'number'
        ? res.data.zPosition
        : typeof res?.hardware?.currentZ === 'number'
        ? res.hardware.currentZ
        : liveZ;

    if (!xy) {
      setLocalHint('Click "Jump to plate A1" or Home first so the robot reports its current X, Y.');
      return;
    }

    if (corner === 'a1') {
      setA1X(Number(xy[0].toFixed(2)));
      setA1Y(Number(xy[1].toFixed(2)));
      if (includeZ && typeof zVal === 'number' && zVal >= 880 && zVal <= 2190) {
        setDefaultZ(Math.round(zVal));
      }
      setCapturedFlags((prev) => ({ ...prev, a1: true }));
      setLocalHint(`Captured A1 at (${xy[0].toFixed(2)}, ${xy[1].toFixed(2)} mm)${includeZ && zVal ? ` · Z=${zVal}` : ''}.`);
    } else if (corner === 'tr') {
      setTrX(Number(xy[0].toFixed(2)));
      setTrY(Number(xy[1].toFixed(2)));
      setCapturedFlags((prev) => ({ ...prev, tr: true }));
      setLocalHint(`Captured ${topRightLabel} at (${xy[0].toFixed(2)}, ${xy[1].toFixed(2)} mm).`);
    } else {
      setBlX(Number(xy[0].toFixed(2)));
      setBlY(Number(xy[1].toFixed(2)));
      setCapturedFlags((prev) => ({ ...prev, bl: true }));
      setLocalHint(`Captured ${bottomLeftLabel} at (${xy[0].toFixed(2)}, ${xy[1].toFixed(2)} mm).`);
    }
  };

  const handleDryRunOppositeCorner = async () => {
    await onRunCommand('move_to_plate_well', {
      plate_id: plateSlot,
      well_index: oppositeWellIdx,
      rows,
      cols,
      corner_a1: [a1X, a1Y],
      corner_top_right: [trX, trY],
      corner_bottom_left: [blX, blY],
      default_z: defaultZ,
    });
  };

  const handleSavePreset = async () => {
    const cleanName = name.trim();
    if (!cleanName || !geometry.valid) return;
    const res = await onRunCommand('save_plate_preset', {
      ...(editingId ? { id: editingId } : {}),
      name: cleanName,
      plate_slot: plateSlot,
      rows,
      cols,
      corner_a1: [a1X, a1Y],
      corner_top_right: [trX, trY],
      corner_bottom_left: [blX, blY],
      default_z: Math.max(880, Math.min(2190, Math.round(defaultZ))),
    });
    if (res?.ok && res?.data?.preset?.id) {
      setEditingId(res.data.preset.id);
      setLocalHint(`Saved '${cleanName}' — now available in Single Transfer and Plate-to-Plate dropdowns.`);
      onPresetSaved?.(res.data.preset.id, plateSlot);
    }
  };

  const handleDeletePreset = async (p: RobotPlatePreset) => {
    const res = await onRunCommand('delete_plate_preset', { id: p.id });
    if (res?.ok && editingId === p.id) {
      setEditingId('');
    }
  };

  const disabled = cmdBusy || ptActive;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Saved Plate Presets List */}
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
          <span style={{ fontSize: '12px', fontWeight: 700 }}>
            Saved Calibrated Plates ({presets.length})
          </span>
          <span style={{ fontSize: '11px', color: 'var(--mut)' }}>
            54-vial (6×9) is built into plate0, plate1 &amp; plate2 automatically.
          </span>
        </div>

        {presets.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--mut)', padding: '4px 0' }}>
            No 96-well or 24-well plates calibrated yet. Use the 3-corner wizard below to teach a plate once—the robot remembers the exact well gap and angle for that slot.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {presets.map((p) => {
              const farIdx = p.rows * p.cols - 1;
              const farLabel = `${rowLetter(p.rows - 1)}${p.cols}`;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                    padding: '8px 10px',
                    borderRadius: '7px',
                    background: 'var(--soft)',
                    border: editingId === p.id ? '1.5px solid var(--acc)' : '1px solid var(--line2)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 700 }}>
                      {p.name}{' '}
                      <span className="mono" style={{ fontSize: '11.5px', color: 'var(--acc)' }}>
                        · plate{p.plateSlot} · {p.rows}×{p.cols} ({p.rows * p.cols} wells)
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                      Gap: <span className="mono">{p.colPitchMm.toFixed(2)} × {p.rowPitchMm.toFixed(2)} mm</span> ·
                      Tilt: <span className="mono">{p.angleDeg.toFixed(2)}°</span> ·
                      Safe Z: <span className="mono">{p.defaultZ}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={disabled}
                      onClick={() =>
                        onRunCommand('move_to_plate_well', {
                          plate_id: p.plateSlot,
                          preset_id: p.id,
                          well_index: 0,
                        })
                      }
                      title="Dry-run move safely over A1 at travel height"
                    >
                      Test A1
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={disabled}
                      onClick={() =>
                        onRunCommand('move_to_plate_well', {
                          plate_id: p.plateSlot,
                          preset_id: p.id,
                          well_index: farIdx,
                        })
                      }
                      title={`Dry-run move safely over ${farLabel} at travel height`}
                    >
                      Test {farLabel}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={disabled}
                      onClick={() => loadPresetForEdit(p)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <Edit3 size={12} />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={disabled}
                      onClick={() => handleDeletePreset(p)}
                      style={{ color: 'var(--bad)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      title="Delete this plate preset"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3-Corner Calibration Wizard */}
      <div
        style={{
          padding: '12px',
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
            marginBottom: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '12.5px' }}>
            <Compass size={15} style={{ color: 'var(--acc)' }} />
            <span>
              {editingId ? `Editing Calibration (${name})` : 'Teach a New Plate (3-Corner Auto-Gap Calibration)'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                type="button"
                className={`btn sm${rows === tpl.rows && cols === tpl.cols && !editingId ? ' pri' : ''}`}
                disabled={disabled}
                onClick={() => applyTemplate(tpl)}
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        {/* Step 1: Plate identity & size */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))',
            gap: '8px',
            marginBottom: '10px',
          }}
        >
          <div style={{ gridColumn: 'span 2' }}>
            <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
              Plate name
            </label>
            <input
              type="text"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 96-well microplate"
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
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
              Deck slot
            </label>
            <select
              value={plateSlot}
              onChange={(e) => setPlateSlot(Number(e.target.value) as 0 | 1 | 2)}
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
              <option value={0}>plate0 (Plate A)</option>
              <option value={1}>plate1 (Plate B)</option>
              <option value={2}>plate2 (Plate C)</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
              Rows (A–{rowLetter(rows - 1)})
            </label>
            <input
              type="number"
              min={1}
              max={16}
              value={rows}
              onChange={(e) => setRows(Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1))))}
              className="mono"
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
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
              Columns (1–{cols})
            </label>
            <input
              type="number"
              min={1}
              max={24}
              value={cols}
              onChange={(e) => setCols(Math.max(1, Math.min(24, Math.round(Number(e.target.value) || 1))))}
              className="mono"
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
            />
          </div>
          <div>
            <label style={{ fontSize: '11px', color: 'var(--mut)', display: 'block', marginBottom: '2px' }}>
              Safe Bottom Z (0.1 mm)
            </label>
            <input
              type="number"
              min={880}
              max={2190}
              step={10}
              value={defaultZ}
              onChange={(e) => setDefaultZ(Math.max(880, Math.min(2190, Math.round(Number(e.target.value) || 1850))))}
              className="mono"
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
            />
          </div>
        </div>

        {/* Built-in Fine Jog Bar */}
        <div
          style={{
            padding: '10px',
            borderRadius: '8px',
            background: 'var(--soft)',
            border: '1px solid var(--line2)',
            marginBottom: '10px',
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
            <div style={{ fontSize: '11.5px', fontWeight: 700 }}>
              Live Gantry Position:{' '}
              <span className="mono" style={{ color: 'var(--acc)' }}>
                {liveXY ? `X=${liveXY[0].toFixed(2)}, Y=${liveXY[1].toFixed(2)} mm` : 'Move to plate slot first'}
                {liveZ != null ? ` · Z=${liveZ}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_to_container', { plate_id: plateSlot, container_id: 0 })}
                title={`Jump close to plate${plateSlot}'s corner A1 at travel height`}
              >
                Jump to plate{plateSlot} A1
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('read_xy_position')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <RefreshCw size={11} />
                <span>Read XY/Z</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_z_traverse')}
              >
                Raise Z Safe
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            {/* XY jog controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--mut)' }}>XY step:</span>
              {[10, 2, 0.5, 0.1].map((st) => (
                <button
                  key={st}
                  type="button"
                  className={`btn sm${jogStepMm === st ? ' pri' : ''}`}
                  onClick={() => setJogStepMm(st)}
                  style={{ padding: '2px 7px', minWidth: '38px' }}
                >
                  {st}
                </button>
              ))}
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_xy_rel', { dx: -jogStepMm, dy: 0 })}
                title={`Move X -${jogStepMm} mm`}
              >
                <ArrowLeft size={12} /> X-
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_xy_rel', { dx: jogStepMm, dy: 0 })}
                title={`Move X +${jogStepMm} mm`}
              >
                X+ <ArrowRight size={12} />
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_xy_rel', { dx: 0, dy: -jogStepMm })}
                title={`Move Y -${jogStepMm} mm`}
              >
                <ArrowUp size={12} /> Y-
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_xy_rel', { dx: 0, dy: jogStepMm })}
                title={`Move Y +${jogStepMm} mm`}
              >
                Y+ <ArrowDown size={12} />
              </button>
            </div>

            {/* Z jog controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--mut)' }}>Z step:</span>
              {[50, 10, 2].map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={`btn sm${jogStepZ === sz ? ' pri' : ''}`}
                  onClick={() => setJogStepZ(sz)}
                  style={{ padding: '2px 6px' }}
                >
                  {(sz / 10).toFixed(1)}mm
                </button>
              ))}
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_z_rel', { dz: -jogStepZ })}
                title="Raise tip"
              >
                Z Up
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => onRunCommand('move_z_rel', { dz: jogStepZ })}
                title="Lower tip carefully"
              >
                Z Down
              </button>
            </div>
          </div>
          {localHint && (
            <div style={{ fontSize: '11px', color: 'var(--acc)', marginTop: '6px' }}>{localHint}</div>
          )}
        </div>

        {/* 3 Corner Capture Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))',
            gap: '8px',
            marginBottom: '10px',
          }}
        >
          {/* Corner 1: A1 */}
          <div
            style={{
              padding: '9px 10px',
              borderRadius: '7px',
              background: 'var(--bg)',
              border: capturedFlags.a1 ? '1px solid var(--ok)' : '1px solid var(--line)',
            }}
          >
            <div style={{ fontSize: '11.5px', fontWeight: 700, marginBottom: '6px' }}>
              1. Top-Left Well (A1)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '6px' }}>
              <input
                type="number"
                step={0.1}
                value={a1X}
                onChange={(e) => setA1X(Number(e.target.value) || 0)}
                className="mono"
                aria-label="A1 X mm"
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
              <input
                type="number"
                step={0.1}
                value={a1Y}
                onChange={(e) => setA1Y(Number(e.target.value) || 0)}
                className="mono"
                aria-label="A1 Y mm"
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => readAndCapture('a1', false)}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
              >
                <Crosshair size={11} />
                <span>Capture A1 XY</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={disabled}
                onClick={() => readAndCapture('a1', true)}
                title="Capture A1 X, Y and also save current Z height as this plate's Safe Bottom Z"
              >
                + Z
              </button>
            </div>
          </div>

          {/* Corner 2: Top-Right */}
          <div
            style={{
              padding: '9px 10px',
              borderRadius: '7px',
              background: 'var(--bg)',
              border: capturedFlags.tr ? '1px solid var(--ok)' : '1px solid var(--line)',
            }}
          >
            <div style={{ fontSize: '11.5px', fontWeight: 700, marginBottom: '6px' }}>
              2. Top-Right Well ({topRightLabel})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '6px' }}>
              <input
                type="number"
                step={0.1}
                value={trX}
                onChange={(e) => setTrX(Number(e.target.value) || 0)}
                className="mono"
                aria-label={`${topRightLabel} X mm`}
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
              <input
                type="number"
                step={0.1}
                value={trY}
                onChange={(e) => setTrY(Number(e.target.value) || 0)}
                className="mono"
                aria-label={`${topRightLabel} Y mm`}
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={disabled}
              onClick={() => readAndCapture('tr', false)}
              style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            >
              <Crosshair size={11} />
              <span>Capture {topRightLabel} XY</span>
            </button>
          </div>

          {/* Corner 3: Bottom-Left */}
          <div
            style={{
              padding: '9px 10px',
              borderRadius: '7px',
              background: 'var(--bg)',
              border: capturedFlags.bl ? '1px solid var(--ok)' : '1px solid var(--line)',
            }}
          >
            <div style={{ fontSize: '11.5px', fontWeight: 700, marginBottom: '6px' }}>
              3. Bottom-Left Well ({bottomLeftLabel})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '6px' }}>
              <input
                type="number"
                step={0.1}
                value={blX}
                onChange={(e) => setBlX(Number(e.target.value) || 0)}
                className="mono"
                aria-label={`${bottomLeftLabel} X mm`}
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
              <input
                type="number"
                step={0.1}
                value={blY}
                onChange={(e) => setBlY(Number(e.target.value) || 0)}
                className="mono"
                aria-label={`${bottomLeftLabel} Y mm`}
                style={{
                  width: '100%',
                  height: '28px',
                  padding: '0 6px',
                  borderRadius: '5px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '11.5px',
                }}
              />
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={disabled}
              onClick={() => readAndCapture('bl', false)}
              style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            >
              <Crosshair size={11} />
              <span>Capture {bottomLeftLabel} XY</span>
            </button>
          </div>
        </div>

        {/* Auto-Detected Well Gap & Sanity Check + Dry-Run & Save */}
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '7px',
            background:
              geometry.pitchStatus === 'ok'
                ? 'color-mix(in srgb, var(--ok) 10%, var(--bg))'
                : geometry.pitchStatus === 'warn'
                ? 'color-mix(in srgb, var(--warn) 12%, var(--bg))'
                : 'color-mix(in srgb, var(--bad) 10%, var(--bg))',
            border: `1px solid ${
              geometry.pitchStatus === 'ok'
                ? 'var(--ok)'
                : geometry.pitchStatus === 'warn'
                ? 'var(--warn)'
                : 'var(--bad)'
            }`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: '11.5px', lineHeight: 1.45, flex: '1 1 260px' }}>
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
              {geometry.pitchStatus === 'ok' ? (
                <CheckCircle2 size={14} style={{ color: 'var(--ok)' }} />
              ) : (
                <AlertTriangle size={14} style={{ color: geometry.pitchStatus === 'warn' ? 'var(--warn)' : 'var(--bad)' }} />
              )}
              <span>{geometry.pitchNote}</span>
            </div>
            {geometry.valid && (
              <div style={{ color: 'var(--fg2)', marginTop: '2px' }}>
                Detected tilt: <strong className="mono">{geometry.angleDeg.toFixed(2)}°</strong> ·
                Predicted far corner <strong className="mono">{geometry.oppositeLabel}</strong>:{' '}
                <span className="mono">
                  ({geometry.oppositeCornerXY[0].toFixed(2)}, {geometry.oppositeCornerXY[1].toFixed(2)} mm)
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn sm"
              disabled={disabled || !geometry.valid}
              onClick={handleDryRunOppositeCorner}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              title={`Move arm safely at travel height over calculated ${geometry.oppositeLabel} to visually confirm alignment before saving`}
            >
              <Navigation size={12} />
              <span>Dry-Run {geometry.oppositeLabel}</span>
            </button>
            <button
              type="button"
              className="btn sm pri"
              disabled={disabled || !geometry.valid || !name.trim()}
              onClick={handleSavePreset}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Save size={12} />
              <span>{editingId ? 'Update Plate Preset' : 'Save Plate Preset'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
