import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  FlaskConical,
  Lock,
  ShieldAlert,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { volumeFromSurfaceHeight } from '../../engine';
import type { RobotHardwareState } from '../../engine/predictor/backendClient';

export interface RemoteBottleItem {
  key: string;
  label: string;
  plateId: number;
  containerId: number;
  kind: 'bottle' | 'jar';
  prepMl: number;
  expectedZ: number;
  savedZ: number | null;
}

interface BenchsidePhoneRemoteProps {
  open: boolean;
  onClose: () => void;
  hw?: RobotHardwareState;
  controlPin: string;
  onControlPinChange: (pin: string) => void;
  cmdBusy: boolean;
  zStepUnits: 10 | 50 | 100;
  onChangeZStep: (step: 10 | 50 | 100) => void;
  bottles: RemoteBottleItem[];
  bottleIdx: number;
  onChangeBottleIdx: (idx: number) => void;
  onRunCommand: (command: string, params?: Record<string, any>) => Promise<any>;
  onSoftwareStop: () => Promise<any>;
  onSaveBottleZ: (bottle: RemoteBottleItem, zValue: number, autoAdvance: boolean) => Promise<void>;
  onCopyZ: (z: number) => void;
  lastFeedback?: string;
}

export const BenchsidePhoneRemote: React.FC<BenchsidePhoneRemoteProps> = ({
  open,
  onClose,
  hw,
  controlPin,
  onControlPinChange,
  cmdBusy,
  zStepUnits,
  onChangeZStep,
  bottles,
  bottleIdx,
  onChangeBottleIdx,
  onRunCommand,
  onSoftwareStop,
  onSaveBottleZ,
  onCopyZ,
  lastFeedback,
}) => {
  if (!open) return null;

  const safeIdx = bottles.length > 0 ? Math.min(bottleIdx, bottles.length - 1) : 0;
  const activeBottle = bottles[safeIdx] || null;
  const curZ = hw?.currentZ ?? null;
  const estMl =
    activeBottle && curZ != null
      ? Math.max(0, volumeFromSurfaceHeight(activeBottle.kind, curZ) / 1000).toFixed(1)
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Benchside Phone Remote"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--bg)',
        color: 'var(--fg)',
        overflowY: 'auto',
        padding: 'max(14px, env(safe-area-inset-top, 0px)) max(14px, env(safe-area-inset-right, 0px)) max(28px, env(safe-area-inset-bottom, 0px)) max(14px, env(safe-area-inset-left, 0px))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        touchAction: 'manipulation',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '460px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          paddingBottom: '24px',
        }}
      >
        {/* Top Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Smartphone size={18} style={{ color: 'var(--acc)' }} />
            <strong style={{ fontSize: '16px' }}>Benchside Remote</strong>
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={onClose}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '38px' }}
          >
            <X size={15} />
            <span>Close</span>
          </button>
        </div>

        {/* Compact PIN + Live Status Strip */}
        <div
          style={{
            padding: '12px',
            borderRadius: '10px',
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '8px',
            }}
          >
            <div>
              <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Current Tip Height</div>
              <div className="mono" style={{ fontSize: '26px', fontWeight: 800, lineHeight: 1.15 }}>
                {curZ != null ? `Z = ${curZ}` : 'Z = —'}
              </div>
              {estMl !== null && activeBottle && (
                <div style={{ fontSize: '12px', color: 'var(--mut)' }}>
                  ≈ {estMl} mL in {activeBottle.kind}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', fontSize: '12px', color: 'var(--fg2)' }}>
              <div>
                <strong>Tip:</strong> {hw?.currentTip ? hw.currentTip.replace('ul', ' µL') : 'None'}
              </div>
              <div>
                <strong>Arm:</strong> {hw?.currentPosition || 'Unknown'}
              </div>
              <div style={{ color: hw?.connected ? 'var(--ok)' : 'var(--mut)', fontWeight: 600 }}>
                {hw?.connected ? 'USB Connected' : 'USB Released'}
              </div>
            </div>
          </div>

          {/* Quick PIN input if lab uses PIN */}
          {hw?.pinProtected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={14} style={{ color: 'var(--mut)' }} />
              <input
                type="password"
                inputMode="numeric"
                value={controlPin}
                onChange={(e) => onControlPinChange(e.target.value)}
                placeholder="Enter Control PIN"
                autoComplete="off"
                style={{
                  flex: 1,
                  height: '38px',
                  padding: '0 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontSize: '15px',
                }}
              />
            </div>
          )}
        </div>

        {/* Bottle Stepper (if run has bottles) */}
        {activeBottle && (
          <div
            style={{
              padding: '12px',
              borderRadius: '10px',
              border: '1px solid var(--line)',
              background: 'var(--panel)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
              }}
            >
              <button
                type="button"
                className="btn"
                disabled={safeIdx <= 0}
                onClick={() => onChangeBottleIdx(Math.max(0, safeIdx - 1))}
                style={{ minHeight: '42px', padding: '0 12px' }}
                aria-label="Previous bottle"
              >
                <ChevronLeft size={18} />
              </button>
              <div style={{ textAlign: 'center', flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                  Bottle {safeIdx + 1} of {bottles.length} · P{activeBottle.plateId}:{activeBottle.containerId}
                </div>
                <div
                  style={{
                    fontSize: '14.5px',
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {activeBottle.label}
                </div>
                <div style={{ fontSize: '11.5px', color: activeBottle.savedZ ? 'var(--ok)' : 'var(--mut)' }}>
                  {activeBottle.savedZ != null
                    ? `Saved Z = ${activeBottle.savedZ}`
                    : `Expected Z ≈ ${activeBottle.expectedZ}`}
                </div>
              </div>
              <button
                type="button"
                className="btn"
                disabled={safeIdx >= bottles.length - 1}
                onClick={() => onChangeBottleIdx(Math.min(bottles.length - 1, safeIdx + 1))}
                style={{ minHeight: '42px', padding: '0 12px' }}
                aria-label="Next bottle"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button
                type="button"
                className="btn pri"
                disabled={cmdBusy}
                onClick={() =>
                  onRunCommand('move_to_container', {
                    plate_id: activeBottle.plateId,
                    container_id: activeBottle.containerId,
                  })
                }
                style={{ minHeight: '46px', fontSize: '13.5px', fontWeight: 700 }}
              >
                Move Over Bottle
              </button>
              <button
                type="button"
                className="btn"
                disabled={cmdBusy}
                onClick={() => {
                  const approachZ = Math.max(900, Math.min(2100, activeBottle.expectedZ - 150));
                  onRunCommand('move_z', { z: approachZ });
                }}
                style={{ minHeight: '46px', fontSize: '13.5px', fontWeight: 600 }}
              >
                Approach Top
              </button>
            </div>
          </div>
        )}

        {/* Giant Thumb-Friendly Z Controls */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <button
            type="button"
            className="btn"
            disabled={cmdBusy}
            onClick={() => onRunCommand('move_z_rel', { dz: -zStepUnits })}
            style={{
              minHeight: '68px',
              fontSize: '18px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              borderRadius: '10px',
              touchAction: 'manipulation',
              userSelect: 'none',
            }}
          >
            <ArrowUp size={22} />
            <span>RAISE {zStepUnits / 10} mm</span>
          </button>

          {/* Segmented Step Selector */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            {([10, 50, 100] as const).map((step) => (
              <button
                key={step}
                type="button"
                className={zStepUnits === step ? 'btn pri' : 'btn'}
                onClick={() => onChangeZStep(step)}
                style={{
                  minHeight: '46px',
                  fontSize: '14px',
                  fontWeight: 700,
                  borderRadius: '8px',
                  touchAction: 'manipulation',
                  userSelect: 'none',
                }}
              >
                {step / 10} mm
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn pri"
            disabled={cmdBusy}
            onClick={() => onRunCommand('move_z_rel', { dz: zStepUnits })}
            style={{
              minHeight: '76px',
              fontSize: '19px',
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              borderRadius: '10px',
              touchAction: 'manipulation',
              userSelect: 'none',
            }}
          >
            <ArrowDown size={24} />
            <span>LOWER {zStepUnits / 10} mm</span>
          </button>
        </div>

        {/* Save Height & Next / Copy Z */}
        {activeBottle ? (
          <button
            type="button"
            className="btn"
            disabled={cmdBusy || curZ == null}
            onClick={() => {
              if (curZ != null) onSaveBottleZ(activeBottle, curZ, true);
            }}
            style={{
              minHeight: '56px',
              borderRadius: '10px',
              background: curZ != null ? 'var(--ok)' : undefined,
              borderColor: curZ != null ? 'var(--ok)' : undefined,
              color: curZ != null ? '#ffffff' : undefined,
              fontSize: '15.5px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <Check size={19} />
            <span>
              Save Z={curZ ?? '—'} &amp; {safeIdx + 1 < bottles.length ? 'Next Bottle' : 'Finish'}
            </span>
          </button>
        ) : curZ != null ? (
          <button
            type="button"
            className="btn"
            onClick={() => onCopyZ(curZ)}
            style={{
              minHeight: '52px',
              borderRadius: '10px',
              fontSize: '15px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <ClipboardCopy size={18} />
            <span>Copy Z = {curZ}</span>
          </button>
        ) : null}

        {/* Utility Row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <button
            type="button"
            className="btn"
            disabled={cmdBusy}
            onClick={() => onRunCommand('move_z_traverse')}
            style={{ minHeight: '46px', fontWeight: 600 }}
          >
            Lift Arm Safe
          </button>
          <button
            type="button"
            className="btn"
            disabled={cmdBusy}
            onClick={() =>
              hw?.currentTip
                ? onRunCommand('discard_tip')
                : onRunCommand('pick_tip', { tip_type: '300ul' })
            }
            style={{
              minHeight: '46px',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            {hw?.currentTip ? <Trash2 size={15} /> : <FlaskConical size={15} />}
            <span>{hw?.currentTip ? 'Drop Tip' : 'Pick 300 µL Tip'}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={cmdBusy}
            onClick={() => onRunCommand(hw?.connected ? 'disconnect_hardware' : 'init_hardware')}
            style={{ minHeight: '46px', fontWeight: 600 }}
          >
            {hw?.connected ? 'Release USB' : 'Connect & Home'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onSoftwareStop()}
            title="Immediately sends Software Stop to Zeus — does not replace a physical E-stop switch"
            style={{
              minHeight: '46px',
              fontWeight: 800,
              background: 'var(--bad)',
              borderColor: 'var(--bad)',
              color: '#ffffff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <ShieldAlert size={16} />
            <span>Software Stop</span>
          </button>
        </div>

        {lastFeedback && (
          <div
            style={{
              padding: '9px 12px',
              borderRadius: '8px',
              border: '1px solid var(--line)',
              background: 'var(--soft)',
              fontSize: '12.5px',
              color: 'var(--fg2)',
              textAlign: 'center',
            }}
          >
            {lastFeedback}
          </div>
        )}

        <div style={{ fontSize: '11.5px', color: 'var(--mut)', textAlign: 'center', lineHeight: 1.4 }}>
          Works wirelessly over your Lab PC link — your phone sends taps to your Lab PC, which relays
          them to the Robot PC helper connected to the robot&apos;s USB cables.
        </div>
      </div>
    </div>
  );
};
