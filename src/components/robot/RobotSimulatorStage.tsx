import React, { useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  SIM_DECK_LAYOUT,
  formatSimWellName,
  getDeckSlotXY,
  type SimSnapshot,
  type SimSpeed,
} from '../../engine/robotSimulator';
import { surfaceHeightExact } from '../../engine/deckTiming';
import type { RobotPlatePreset } from '../../engine/predictor/backendClient';

interface RobotSimulatorStageProps {
  snapshot: SimSnapshot;
  speed: SimSpeed;
  onChangeSpeed: (s: SimSpeed) => void;
  hasPlannedRun: boolean;
  replayingPlan: boolean;
  replayProgress: { done: number; total: number; label: string } | null;
  onStartPlanReplay: () => void;
  onStopPlanReplay: () => void;
  onResetDeck: () => void;
  onClearLog: () => void;
  onSelectDeckSlot?: (plateId: number, slotId: number) => void;
}

// Map Robowski#2 front-facing physical gantry mm (X: 0 left -> -510 right, Y: 0 back -> -415 front)
const SVG_W = 560;
const SVG_H = 472;
function toSvgX(mmX: number): number {
  return 24 - mmX;
}
function toSvgY(mmY: number): number {
  return 34 - mmY;
}

function tipColor(tip: string): string {
  if (tip === '50ul') return '#0ea5e9';
  if (tip === '300ul') return '#f59e0b';
  if (tip === '1000ul') return '#3b82f6';
  return '#64748b';
}

// Physical 3D-printed holder colors from Robowski#2 hood
const HOLDER_PALETTE: Record<number, { border: string; headerBg: string; headerText: string; badge?: string }> = {
  0: { border: '#16a34a', headerBg: '#16a34a22', headerText: '#15803d', badge: '0' }, // Green carrier #0
  1: { border: '#dc2626', headerBg: '#dc262620', headerText: '#b91c1c', badge: '1' }, // Red/green carrier #1
  2: { border: '#dc2626', headerBg: '#dc262620', headerText: '#b91c1c', badge: '2' }, // Red carrier #2
  3: { border: '#2563eb', headerBg: '#2563eb20', headerText: '#1d4ed8' }, // Blue/yellow 8-bottle holder
  4: { border: '#dc2626', headerBg: '#dc262620', headerText: '#b91c1c' }, // Red/green 8-bottle holder
  5: { border: '#475569', headerBg: '#33415524', headerText: '#334155' }, // Black/red 8-bottle holder
  6: { border: '#db2777', headerBg: '#f472b622', headerText: '#be185d' }, // White/pink 2-jar holder
  7: { border: '#d97706', headerBg: '#f59e0b24', headerText: '#b45309' }, // Yellow/red holder
};

export const RobotSimulatorStage: React.FC<RobotSimulatorStageProps> = ({
  snapshot,
  speed,
  onChangeSpeed,
  hasPlannedRun,
  replayingPlan,
  replayProgress,
  onStartPlanReplay,
  onStopPlanReplay,
  onResetDeck,
  onClearLog,
  onSelectDeckSlot,
}) => {
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'accidents' | 'warnings'>('all');

  const hw = snapshot.hardware;
  const presets = hw.platePresets || [];
  const presetBySlot = useMemo(() => {
    const m = new Map<number, RobotPlatePreset>();
    for (const p of presets) {
      if (!m.has(p.plateSlot)) m.set(p.plateSlot, p);
    }
    return m;
  }, [presets]);

  const activeKey = inspectedKey || snapshot.activeVesselKey || '3:0';
  const activeVessel = snapshot.containers[activeKey] || null;
  const activeSurfaceZ = activeVessel
    ? Math.round(surfaceHeightExact(activeVessel.kind, activeVessel.volumeUl))
    : null;

  const crashCount = useMemo(
    () => snapshot.accidents.filter((a) => a.severity === 'crash').length,
    [snapshot.accidents]
  );
  const hazardCount = useMemo(
    () => snapshot.accidents.filter((a) => a.severity === 'hazard').length,
    [snapshot.accidents]
  );
  const warningCount = useMemo(
    () => snapshot.accidents.filter((a) => a.severity === 'warning').length,
    [snapshot.accidents]
  );

  const headX = toSvgX(hw.currentXY?.[0] ?? 0);
  const headY = toSvgY(hw.currentXY?.[1] ?? 0);

  // Z-axis cross-section mapping: Z=500 -> y=20, Z=2250 -> y=220
  const zToBarY = (z: number) => {
    const clamped = Math.max(500, Math.min(2250, z));
    return 20 + ((clamped - 500) / (2250 - 500)) * 200;
  };
  const currentZ = hw.currentZ ?? 880;
  const tipBottomY = zToBarY(currentZ);
  const traverseY = zToBarY(880);
  const vesselFloorY = zToBarY(activeVessel?.bottomZ ?? 2180);
  const liquidTopY =
    activeVessel && activeVessel.volumeUl > 0 && activeSurfaceZ != null
      ? Math.max(zToBarY(1050), Math.min(vesselFloorY, zToBarY(activeSurfaceZ)))
      : vesselFloorY;

  const trailPoints = snapshot.trail
    .map((pt) => `${toSvgX(pt.xy[0]).toFixed(1)},${toSvgY(pt.xy[1]).toFixed(1)}`)
    .join(' ');

  const visibleLogItems = useMemo(() => {
    if (logFilter === 'accidents') {
      return snapshot.accidents
        .filter((a) => a.severity === 'crash' || a.severity === 'hazard')
        .map((a) => ({
          id: a.id,
          ts: a.ts,
          severity: a.severity,
          title: a.title,
          detail: a.detail,
        }));
    }
    if (logFilter === 'warnings') {
      return snapshot.accidents.map((a) => ({
        id: a.id,
        ts: a.ts,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
      }));
    }
    return snapshot.log.map((l) => ({
      id: l.id,
      ts: l.ts,
      severity: l.level === 'crash' ? 'crash' : l.level === 'warning' ? 'warning' : 'info',
      title: l.command.replace(/_/g, ' '),
      detail: l.message,
    }));
  }, [logFilter, snapshot.accidents, snapshot.log]);

  const handleVesselClick = (plateId: number, slotId: number) => {
    setInspectedKey(`${plateId}:${slotId}`);
    if (onSelectDeckSlot) onSelectDeckSlot(plateId, slotId);
  };

  return (
    <div
      className="card"
      style={{
        marginBottom: '20px',
        border: '1px solid color-mix(in srgb, var(--acc) 45%, var(--line))',
      }}
    >
      {/* Header & Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12px',
          flexWrap: 'wrap',
          paddingBottom: '12px',
          borderBottom: '1px solid var(--line)',
          marginBottom: '14px',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>
            Virtual Robot Simulator (1-to-1 Deck &amp; Safety Check)
          </h2>
          <div
            className="mono"
            style={{
              marginTop: '4px',
              fontSize: '12px',
              color: 'var(--mut)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}
          >
            <span>X {(hw.currentXY?.[0] ?? 0).toFixed(1)} mm</span>
            <span aria-hidden="true">·</span>
            <span>Y {(hw.currentXY?.[1] ?? 0).toFixed(1)} mm</span>
            <span aria-hidden="true">·</span>
            <span>Z {currentZ}</span>
            <span aria-hidden="true">·</span>
            <span>Tip {hw.currentTip ? hw.currentTip.replace('ul', ' µL') : 'None'}</span>
            <span aria-hidden="true">·</span>
            <span style={{ color: hw.homed ? 'var(--ok)' : 'var(--warn)', fontWeight: 600 }}>
              {hw.homed ? 'Homed' : hw.connected ? 'Not homed' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Speed Selector */}
          <div
            role="group"
            aria-label="Simulation speed"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px',
              borderRadius: '6px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            {([1, 5, 20, 0] as SimSpeed[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onChangeSpeed(s)}
                style={{
                  border: 'none',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontSize: '11.5px',
                  fontWeight: speed === s ? 700 : 500,
                  cursor: 'pointer',
                  background: speed === s ? 'var(--panel)' : 'transparent',
                  color: speed === s ? 'var(--fg)' : 'var(--mut)',
                }}
              >
                {s === 0 ? 'Instant' : `${s}×`}
              </button>
            ))}
          </div>

          {hasPlannedRun &&
            (!replayingPlan ? (
              <button
                type="button"
                className="btn sm pri"
                onClick={onStartPlanReplay}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                title="Replay every solvent and stock addition from your currently planned reaction on the virtual deck"
              >
                <Play size={13} />
                <span>Simulate Planned Run</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn sm"
                onClick={onStopPlanReplay}
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
                <span>Stop Replay</span>
              </button>
            ))}

          <button
            type="button"
            className="btn sm"
            onClick={onResetDeck}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <RotateCcw size={12} />
            <span>Reset Deck</span>
          </button>
        </div>
      </div>

      {/* Live Replay Progress Line */}
      {replayProgress && (
        <div
          style={{
            marginBottom: '12px',
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            fontSize: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <span>{replayProgress.label}</span>
          <span className="mono" style={{ fontWeight: 700 }}>
            {replayProgress.done} / {replayProgress.total} steps
          </span>
        </div>
      )}

      {/* Dual Visual Stage: Top-Down 1-to-1 Breadboard + Side Z-Axis Cross-Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(240px, 1fr)',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Left: Top-Down 1-to-1 Robowski Breadboard */}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '6px',
              fontSize: '12px',
              color: 'var(--mut)',
            }}
          >
            <strong style={{ color: 'var(--fg)', fontSize: '12.5px' }}>
              Top-Down Breadboard Map ({snapshot.hood === 'right' ? 'Robowski#1' : 'Robowski#2'})
            </strong>
            <span>Click any bottle, jar, or vial to inspect volume &amp; Z</span>
          </div>

          <div
            style={{
              borderRadius: '8px',
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              padding: '6px',
              overflow: 'hidden',
            }}
          >
            <svg
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="Top-down Robowski#2 breadboard simulation canvas matching physical hood layout"
            >
              {/* Stainless optical table surface (TMC CleanTop) */}
              <rect
                x="10"
                y="14"
                width={SVG_W - 20}
                height={SVG_H - 24}
                rx="8"
                fill="var(--bg)"
                stroke="var(--line)"
                strokeWidth="1"
              />

              {/* Subtle 50 mm breadboard grid */}
              {[0, -50, -100, -150, -200, -250, -300, -350, -400, -450, -500].map((gx) => (
                <line
                  key={`gx_${gx}`}
                  x1={toSvgX(gx)}
                  y1={24}
                  x2={toSvgX(gx)}
                  y2={SVG_H - 18}
                  stroke="var(--line)"
                  strokeWidth="0.5"
                  opacity="0.35"
                />
              ))}
              {[0, -50, -100, -150, -200, -250, -300, -350, -400].map((gy) => (
                <line
                  key={`gy_${gy}`}
                  x1={16}
                  y1={toSvgY(gy)}
                  x2={SVG_W - 16}
                  y2={toSvgY(gy)}
                  stroke="var(--line)"
                  strokeWidth="0.5"
                  opacity="0.35"
                />
              ))}

              {/* Back X-axis aluminum gantry rail + left stepper motor */}
              <rect x="18" y="21" width={SVG_W - 36} height="9" rx="2" fill="var(--soft)" stroke="var(--line)" strokeWidth="0.9" />
              <rect x="14" y="18" width="16" height="15" rx="2" fill="#334155" opacity="0.85" />
              <text x="540" y="18" textAnchor="end" fontSize="7.5" fontFamily="monospace" fill="var(--mut)">
                BACK GANTRY RAIL (Y=0)
              </text>

              {/* Front guide bar + pneumatic manifold accent */}
              <rect x="18" y="446" width={SVG_W - 36} height="5" rx="2" fill="var(--soft)" stroke="var(--line)" strokeWidth="0.8" />
              <path
                d="M 278 450 Q 345 466 438 408"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
                opacity="0.5"
              />
              <text x="280" y="464" textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill="var(--mut)">
                FRONT OF HOOD (TMC CleanTop)
              </text>

              {/* Home marker (0, 0) at back-left */}
              <g transform={`translate(${toSvgX(0)}, ${toSvgY(0)})`}>
                <circle r="4" fill="none" stroke="var(--acc)" strokeWidth="1.2" />
                <text x="7" y="9" textAnchor="start" fontSize="7.5" fontFamily="monospace" fill="var(--mut)">
                  Home (0,0)
                </text>
              </g>

              {/* Back Row: 3 Red Tip Rack Towers (left -> right: 1000 µL, 300 µL, 50 µL) */}
              {(['1000ul', '300ul', '50ul'] as const).map((tt) => {
                const box = SIM_DECK_LAYOUT[`rack_${tt}`];
                const rack = snapshot.tipRacks.find((r) => r.tipType === tt);
                const rem = rack?.remaining ?? 96;
                const pct = Math.max(0, Math.min(1, rem / 96));
                const x = toSvgX(box.x + box.w);
                const y = toSvgY(box.y + box.h);
                const shortBadge = tt.toUpperCase();
                return (
                  <g key={tt}>
                    <rect
                      x={x}
                      y={y}
                      width={box.w}
                      height={box.h}
                      rx="5"
                      fill="var(--soft)"
                      stroke={rem === 0 ? 'var(--bad)' : '#dc2626'}
                      strokeWidth={rem === 0 ? '1.8' : '1.2'}
                    />
                    {/* Red tower header strip with yellow tip label (matches photo) */}
                    <rect
                      x={x + 1}
                      y={y + 1}
                      width={box.w - 2}
                      height="16"
                      rx="4"
                      fill="#dc2626"
                      opacity="0.16"
                    />
                    <rect
                      x={x + 5}
                      y={y + 3.5}
                      width="36"
                      height="11"
                      rx="2"
                      fill="#facc15"
                      opacity="0.92"
                    />
                    <text
                      x={x + 23}
                      y={y + 11.5}
                      textAnchor="middle"
                      fontSize="7.5"
                      fontWeight="800"
                      fontFamily="monospace"
                      fill="#1e293b"
                    >
                      {shortBadge}
                    </text>
                    <text
                      x={x + box.w - 6}
                      y={y + 12}
                      textAnchor="end"
                      fontSize="8.5"
                      fontWeight="700"
                      fontFamily="monospace"
                      fill={rem <= 10 ? 'var(--bad)' : 'var(--fg)'}
                    >
                      {rem}/96
                    </text>
                    {/* Remaining tip bar */}
                    <rect
                      x={x + 7}
                      y={y + 22}
                      width={box.w - 14}
                      height="7"
                      rx="2.5"
                      fill="var(--panel)"
                      stroke="var(--line)"
                      strokeWidth="0.6"
                    />
                    <rect
                      x={x + 7}
                      y={y + 22}
                      width={Math.max(0, (box.w - 14) * pct)}
                      height="7"
                      rx="2.5"
                      fill={rem <= 10 ? 'var(--bad)' : tipColor(tt)}
                      opacity="0.9"
                    />
                    {/* Tip grid dots */}
                    {Array.from({ length: 24 }, (_, idx) => {
                      const col = idx % 8;
                      const row = Math.floor(idx / 8);
                      const filled = idx < Math.round(pct * 24);
                      return (
                        <circle
                          key={idx}
                          cx={x + 13 + col * 12.2}
                          cy={y + 38 + row * 10}
                          r="2.2"
                          fill={filled ? tipColor(tt) : 'var(--line)'}
                          opacity={filled ? 0.8 : 0.35}
                        />
                      );
                    })}
                  </g>
                );
              })}

              {/* Black Anodized Slotted Breadboard Bed under the 3x3 plate grid */}
              <rect
                x="46"
                y="144"
                width="380"
                height="290"
                rx="6"
                fill="#0f172a"
                fillOpacity="0.12"
                stroke="#334155"
                strokeWidth="1.2"
                strokeOpacity="0.45"
              />
              {/* Subtle horizontal rail slots matching the black anodized deck */}
              {[170, 200, 230, 265, 295, 325, 360, 390, 420].map((sy) => (
                <line
                  key={`slot_${sy}`}
                  x1="50"
                  y1={sy}
                  x2="422"
                  y2={sy}
                  stroke="#334155"
                  strokeWidth="1"
                  opacity="0.12"
                />
              ))}

              {/* Tip Trash (Black box in Row 3 Col 3, right in front of 50 µL tips) */}
              {(() => {
                const box = SIM_DECK_LAYOUT.trash;
                const x = toSvgX(box.x + box.w);
                const y = toSvgY(box.y + box.h);
                return (
                  <g>
                    <rect
                      x={x}
                      y={y}
                      width={box.w}
                      height={box.h}
                      rx="5"
                      fill="#1e293b"
                      fillOpacity="0.88"
                      stroke="#475569"
                      strokeWidth="1.2"
                    />
                    <rect
                      x={x + 10}
                      y={y + 22}
                      width={box.w - 20}
                      height={box.h - 34}
                      rx="3"
                      fill="#0f172a"
                      stroke="#334155"
                      strokeWidth="0.9"
                    />
                    <text x={x + 7} y={y + 13} fontSize="8.5" fontWeight="700" fill="#e2e8f0">
                      Tip Trash
                    </text>
                    <text
                      x={x + box.w / 2}
                      y={y + box.h / 2 + 8}
                      textAnchor="middle"
                      fontSize="8"
                      fontFamily="monospace"
                      fill="#94a3b8"
                    >
                      DROP CHUTE
                    </text>
                  </g>
                );
              })()}

              {/* Right-Side Instruments: Analytical Balance (back-right) & NanoDrop 2000c (front-right) */}
              {(() => {
                const bal = SIM_DECK_LAYOUT.balance;
                const bx = toSvgX(bal.x + bal.w);
                const by = toSvgY(bal.y + bal.h);
                const nd = SIM_DECK_LAYOUT.nanodrop;
                const nx = toSvgX(nd.x + nd.w);
                const ny = toSvgY(nd.y + nd.h);
                return (
                  <g>
                    {/* Analytical Balance (glass draft shield) */}
                    <rect
                      x={bx}
                      y={by}
                      width={bal.w}
                      height={bal.h}
                      rx="6"
                      fill="var(--soft)"
                      stroke="var(--line)"
                      strokeWidth="1.2"
                    />
                    <rect
                      x={bx + 8}
                      y={by + 20}
                      width={bal.w - 16}
                      height={bal.h - 32}
                      rx="4"
                      fill="#e0f2fe"
                      fillOpacity="0.22"
                      stroke="#94a3b8"
                      strokeWidth="1"
                      strokeDasharray="3 2"
                    />
                    <circle
                      cx={bx + bal.w / 2}
                      cy={by + bal.h / 2 + 4}
                      r="18"
                      fill="var(--panel)"
                      stroke="var(--line)"
                      strokeWidth="1.2"
                    />
                    <circle
                      cx={bx + bal.w / 2}
                      cy={by + bal.h / 2 + 4}
                      r="11"
                      fill="none"
                      stroke="var(--mut)"
                      strokeWidth="0.7"
                    />
                    <text x={bx + bal.w / 2} y={by + 13} textAnchor="middle" fontSize="8.5" fontWeight="700" fill="var(--fg2)">
                      Balance
                    </text>
                    <text x={bx + bal.w / 2} y={by + bal.h - 4} textAnchor="middle" fontSize="7" fontFamily="monospace" fill="var(--mut)">
                      DRAFT SHIELD
                    </text>

                    {/* NanoDrop 2000c (white instrument + pedestal + pneumatic arm) */}
                    <rect
                      x={nx}
                      y={ny}
                      width={nd.w}
                      height={nd.h}
                      rx="7"
                      fill="var(--panel)"
                      stroke="var(--line)"
                      strokeWidth="1.3"
                    />
                    <rect
                      x={nx + 8}
                      y={ny + 22}
                      width={nd.w - 16}
                      height="32"
                      rx="4"
                      fill="var(--soft)"
                      stroke="var(--line)"
                      strokeWidth="0.9"
                    />
                    <circle
                      cx={nx + nd.w / 2}
                      cy={ny + 74}
                      r="12"
                      fill="var(--soft)"
                      stroke="#38bdf8"
                      strokeWidth="1.4"
                    />
                    <circle cx={nx + nd.w / 2} cy={ny + 74} r="3.5" fill="#0ea5e9" />
                    <text x={nx + nd.w / 2} y={ny + 14} textAnchor="middle" fontSize="8.2" fontWeight="700" fill="var(--fg)">
                      NanoDrop
                    </text>
                    <text x={nx + nd.w / 2} y={ny + 41} textAnchor="middle" fontSize="7.2" fontFamily="monospace" fill="var(--mut)">
                      ARM LID
                    </text>
                    <text x={nx + nd.w / 2} y={ny + 102} textAnchor="middle" fontSize="7.2" fontFamily="monospace" fill="var(--mut)">
                      PEDESTAL
                    </text>
                    <text x={nx + nd.w / 2} y={ny + nd.h - 8} textAnchor="middle" fontSize="7" fontFamily="monospace" fill="#0284c7">
                      2000c · UV-Vis
                    </text>
                  </g>
                );
              })()}

              {/* Solvent Jars: Plate 6 (white/pink) & Plate 7 (yellow/red) */}
              {[6, 7].map((pid) => {
                const box = SIM_DECK_LAYOUT[`plate${pid}`];
                const pal = HOLDER_PALETTE[pid];
                const x = toSvgX(box.x + box.w);
                const y = toSvgY(box.y + box.h);
                return (
                  <g key={pid}>
                    <rect
                      x={x}
                      y={y}
                      width={box.w}
                      height={box.h}
                      rx="5"
                      fill="var(--panel)"
                      stroke={pal.border}
                      strokeWidth="1.4"
                    />
                    <rect
                      x={x + 1}
                      y={y + 1}
                      width={box.w - 2}
                      height="16"
                      rx="4"
                      fill={pal.headerBg}
                    />
                    <text x={x + 6} y={y + 12} fontSize="8.3" fontWeight="700" fill={pal.headerText}>
                      plate{pid} · Jars
                    </text>
                    {[0, 1].map((slot) => {
                      const [mx, my] = getDeckSlotXY(pid, slot);
                      const cx = toSvgX(mx);
                      const cy = toSvgY(my);
                      const c = snapshot.containers[`${pid}:${slot}`];
                      const vol = c?.volumeUl ?? 0;
                      const pct = c ? Math.min(1, vol / c.capacityUl) : 0;
                      const isSel = activeKey === `${pid}:${slot}`;
                      return (
                        <g
                          key={slot}
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleVesselClick(pid, slot)}
                        >
                          <circle
                            cx={cx}
                            cy={cy}
                            r="18"
                            fill="var(--bg)"
                            stroke={isSel ? 'var(--acc)' : 'var(--line)'}
                            strokeWidth={isSel ? '2' : '1.1'}
                          />
                          {pct > 0 && (
                            <circle
                              cx={cx}
                              cy={cy}
                              r={Math.max(4, 16 * Math.sqrt(pct))}
                              fill="#0ea5e9"
                              opacity="0.38"
                            />
                          )}
                          <text
                            x={cx}
                            y={cy + 3}
                            textAnchor="middle"
                            fontSize="8"
                            fontFamily="monospace"
                            fontWeight="600"
                            fill="var(--fg)"
                          >
                            {vol > 0 ? `${(vol / 1000).toFixed(0)}mL` : `J${slot}`}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {/* Stock Bottles: Plate 3 (blue/yellow), Plate 4 (red/green), Plate 5 (black/red) */}
              {[3, 4, 5].map((pid) => {
                const box = SIM_DECK_LAYOUT[`plate${pid}`];
                const pal = HOLDER_PALETTE[pid];
                const x = toSvgX(box.x + box.w);
                const y = toSvgY(box.y + box.h);
                return (
                  <g key={pid}>
                    <rect
                      x={x}
                      y={y}
                      width={box.w}
                      height={box.h}
                      rx="5"
                      fill="var(--panel)"
                      stroke={pal.border}
                      strokeWidth="1.4"
                    />
                    <rect
                      x={x + 1}
                      y={y + 1}
                      width={box.w - 2}
                      height="16"
                      rx="4"
                      fill={pal.headerBg}
                    />
                    <text x={x + 6} y={y + 12} fontSize="8.3" fontWeight="700" fill={pal.headerText}>
                      plate{pid} · Bottles
                    </text>
                    {Array.from({ length: 8 }, (_, slot) => {
                      const [mx, my] = getDeckSlotXY(pid, slot);
                      const cx = toSvgX(mx);
                      const cy = toSvgY(my);
                      const c = snapshot.containers[`${pid}:${slot}`];
                      const vol = c?.volumeUl ?? 0;
                      const pct = c ? Math.min(1, vol / Math.max(1, c.initialVolumeUl || 20000)) : 0;
                      const isSel = activeKey === `${pid}:${slot}`;
                      const isLow = c && vol > 0 && vol <= c.deadVolumeUl;
                      return (
                        <g
                          key={slot}
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleVesselClick(pid, slot)}
                        >
                          <circle
                            cx={cx}
                            cy={cy}
                            r="10.2"
                            fill="var(--bg)"
                            stroke={isSel ? 'var(--acc)' : isLow ? 'var(--bad)' : 'var(--line)'}
                            strokeWidth={isSel ? '1.9' : '1'}
                          />
                          {vol > 0 && (
                            <circle
                              cx={cx}
                              cy={cy}
                              r={Math.max(3, 8.8 * Math.sqrt(Math.max(0.1, pct)))}
                              fill={isLow ? 'var(--bad)' : '#3b82f6'}
                              opacity="0.42"
                            />
                          )}
                          <text
                            x={cx}
                            y={cy + 3}
                            textAnchor="middle"
                            fontSize="7.2"
                            fontFamily="monospace"
                            fontWeight="600"
                            fill="var(--fg)"
                          >
                            {slot}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {/* Reaction / Custom Plates: Plate 0 (green #0), Plate 1 (red #1), Plate 2 (red #2) */}
              {[0, 1, 2].map((pid) => {
                const box = SIM_DECK_LAYOUT[`plate${pid}`];
                const pal = HOLDER_PALETTE[pid];
                const preset = presetBySlot.get(pid) || null;
                const rows = preset ? preset.rows : 6;
                const cols = preset ? preset.cols : 9;
                const total = rows * cols;
                const x = toSvgX(box.x + box.w);
                const y = toSvgY(box.y + box.h);
                const rWell = total >= 96 ? 2.2 : 3.4;

                return (
                  <g key={pid}>
                    <rect
                      x={x}
                      y={y}
                      width={box.w}
                      height={box.h}
                      rx="5"
                      fill="var(--panel)"
                      stroke={pal.border}
                      strokeWidth="1.5"
                    />
                    <rect
                      x={x + 1}
                      y={y + 1}
                      width={box.w - 2}
                      height="15"
                      rx="4"
                      fill={pal.headerBg}
                    />
                    {/* Yellow plate number sticker (0, 1, 2) matching physical holders */}
                    {pal.badge && (
                      <>
                        <rect x={x + 4} y={y + 3} width="11" height="10.5" rx="2" fill="#facc15" />
                        <text
                          x={x + 9.5}
                          y={y + 11}
                          textAnchor="middle"
                          fontSize="7.5"
                          fontWeight="800"
                          fontFamily="monospace"
                          fill="#1e293b"
                        >
                          {pal.badge}
                        </text>
                      </>
                    )}
                    <text x={x + 19} y={y + 11.5} fontSize="8" fontWeight="700" fill={pal.headerText}>
                      plate{pid} · {preset ? `${rows}×${cols}` : '54 vials'}
                    </text>
                    {Array.from({ length: total }, (_, idx) => {
                      const [mx, my] = getDeckSlotXY(pid, idx, preset);
                      // If preset uses custom real-world coords outside the box, fall back cleanly inside box
                      const inside =
                        !preset && mx >= box.x - 2 && mx <= box.x + box.w + 2 && my >= box.y - 2 && my <= box.y + box.h + 2;
                      const r = Math.floor(idx / cols);
                      const col = idx % cols;
                      const wx = inside
                        ? toSvgX(mx)
                        : x + 10 + (cols > 1 ? (col / (cols - 1)) * (box.w - 20) : 0);
                      const wy = inside
                        ? toSvgY(my)
                        : y + 21 + (rows > 1 ? (r / (rows - 1)) * (box.h - 29) : 0);
                      const c = snapshot.containers[`${pid}:${idx}`];
                      const vol = c?.volumeUl ?? 0;
                      const overflow = c ? vol > c.capacityUl : false;
                      const isSel = activeKey === `${pid}:${idx}`;
                      return (
                        <circle
                          key={idx}
                          cx={wx}
                          cy={wy}
                          r={rWell}
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleVesselClick(pid, idx)}
                          fill={
                            overflow
                              ? 'var(--bad)'
                              : vol > 0
                              ? '#10b981'
                              : 'var(--bg)'
                          }
                          fillOpacity={vol > 0 ? Math.min(0.95, 0.35 + (vol / Math.max(1, c?.capacityUl || 1000)) * 0.65) : 1}
                          stroke={isSel ? 'var(--acc)' : 'var(--line)'}
                          strokeWidth={isSel ? '1.5' : '0.6'}
                        >
                          <title>
                            plate{pid} {formatSimWellName(idx, cols)} (#{idx}): {Math.round(vol)} µL
                          </title>
                        </circle>
                      );
                    })}
                  </g>
                );
              })}

              {/* Motion trail polyline */}
              {snapshot.trail.length > 1 && (
                <polyline
                  points={trailPoints}
                  fill="none"
                  stroke="var(--acc)"
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                  opacity="0.55"
                />
              )}

              {/* Last accident highlight marker */}
              {snapshot.lastAccidentXY && (
                <g
                  transform={`translate(${toSvgX(snapshot.lastAccidentXY[0])}, ${toSvgY(
                    snapshot.lastAccidentXY[1]
                  )})`}
                >
                  <circle r="11" fill="none" stroke="var(--bad)" strokeWidth="1.8" strokeDasharray="3 2" />
                </g>
              )}

              {/* Moving Y-Axis FUYU Linear Arm (slides left/right along back & front rails) */}
              <g style={{ transition: 'transform 140ms ease-out' }}>
                <rect
                  x={headX - 4}
                  y={22}
                  width="8"
                  height="428"
                  rx="2"
                  fill="var(--acc)"
                  opacity="0.12"
                />
                <line
                  x1={headX}
                  y1={22}
                  x2={headX}
                  y2={450}
                  stroke="var(--acc)"
                  strokeWidth="1.1"
                  opacity="0.45"
                />
                <line
                  x1={16}
                  y1={headY}
                  x2={SVG_W - 16}
                  y2={headY}
                  stroke="var(--acc)"
                  strokeWidth="0.8"
                  strokeDasharray="3 3"
                  opacity="0.3"
                />
              </g>

              {/* Animated Zeus R2 Pipetter Head Reticle */}
              <g
                transform={`translate(${headX}, ${headY})`}
                style={{ transition: 'transform 140ms ease-out' }}
              >
                <circle
                  r="9"
                  fill="var(--panel)"
                  stroke={snapshot.emergencyStopped ? 'var(--bad)' : 'var(--acc)'}
                  strokeWidth="2.2"
                />
                <circle
                  r="4"
                  fill={hw.currentTip ? tipColor(hw.currentTip) : 'var(--mut)'}
                />
              </g>
            </svg>
          </div>
        </div>

        {/* Right: Side-View Z-Axis Column & Active Vessel Inspector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--fg)' }}>
            Side-View Z-Axis &amp; Liquid Level
          </div>

          <div
            style={{
              borderRadius: '8px',
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              padding: '10px',
            }}
          >
            <svg
              viewBox="0 0 220 245"
              style={{ width: '100%', height: 'auto', display: 'block' }}
              role="img"
              aria-label="Side-view Z height and vessel liquid level"
            >
              {/* Z scale labels */}
              <text x="8" y={traverseY + 3} fontSize="9" fontFamily="monospace" fill="var(--ok)">
                Z=880
              </text>
              <line
                x1="46"
                y1={traverseY}
                x2="212"
                y2={traverseY}
                stroke="var(--ok)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text x="210" y={traverseY - 4} textAnchor="end" fontSize="8" fill="var(--ok)">
                Safe Traverse
              </text>

              {/* Vessel silhouette */}
              {activeVessel && (
                <g>
                  {/* Container walls */}
                  <rect
                    x="86"
                    y={zToBarY(1050)}
                    width={activeVessel.kind === 'jar' ? 80 : activeVessel.kind === 'bottle' ? 58 : 34}
                    height={Math.max(12, vesselFloorY - zToBarY(1050))}
                    rx="3"
                    fill="var(--panel)"
                    stroke="var(--line)"
                    strokeWidth="1.4"
                    transform={`translate(${
                      activeVessel.kind === 'jar' ? -16 : activeVessel.kind === 'bottle' ? -5 : 7
                    }, 0)`}
                  />
                  {/* Liquid fill inside container */}
                  {activeVessel.volumeUl > 0 && (
                    <rect
                      x="88"
                      y={liquidTopY}
                      width={
                        (activeVessel.kind === 'jar' ? 80 : activeVessel.kind === 'bottle' ? 58 : 34) - 4
                      }
                      height={Math.max(2, vesselFloorY - liquidTopY)}
                      fill={activeVessel.volumeUl > activeVessel.capacityUl ? 'var(--bad)' : '#0ea5e9'}
                      opacity="0.42"
                      transform={`translate(${
                        activeVessel.kind === 'jar' ? -16 : activeVessel.kind === 'bottle' ? -5 : 7
                      }, 0)`}
                    />
                  )}
                  {/* Vessel floor danger line */}
                  <line
                    x1="46"
                    y1={vesselFloorY}
                    x2="212"
                    y2={vesselFloorY}
                    stroke="var(--bad)"
                    strokeWidth="1.2"
                    strokeDasharray="4 2"
                  />
                  <text x="8" y={vesselFloorY + 3} fontSize="9" fontFamily="monospace" fill="var(--bad)">
                    Z={activeVessel.bottomZ}
                  </text>
                  <text x="210" y={vesselFloorY + 12} textAnchor="end" fontSize="8" fill="var(--bad)">
                    Bottom Floor
                  </text>
                </g>
              )}

              {/* Pipette shaft & tip */}
              <g style={{ transition: 'transform 140ms ease-out' }}>
                {/* Upper Zeus Z-drive shaft */}
                <rect x="106" y="6" width="8" height={Math.max(12, tipBottomY - 40)} fill="#64748b" rx="2" />
                {/* Tip cone (if mounted) */}
                {hw.currentTip ? (
                  <>
                    <polygon
                      points={`104,${Math.max(18, tipBottomY - 34)} 116,${Math.max(18, tipBottomY - 34)} 112,${tipBottomY} 108,${tipBottomY}`}
                      fill={tipColor(hw.currentTip)}
                      opacity="0.88"
                    />
                    {snapshot.tipLiquidUl > 0 && (
                      <polygon
                        points={`107,${Math.max(22, tipBottomY - 14)} 113,${Math.max(22, tipBottomY - 14)} 111.5,${tipBottomY} 108.5,${tipBottomY}`}
                        fill="#0284c7"
                      />
                    )}
                  </>
                ) : (
                  <rect x="103" y={Math.max(14, tipBottomY - 10)} width="14" height="8" rx="1.5" fill="#94a3b8" />
                )}
                {/* Current Z readout pointer */}
                <line x1="118" y1={tipBottomY} x2="146" y2={tipBottomY} stroke="var(--fg)" strokeWidth="1" />
                <text x="150" y={tipBottomY + 3} fontSize="9.5" fontFamily="monospace" fontWeight="700" fill="var(--fg)">
                  Z={currentZ}
                </text>
              </g>
            </svg>
          </div>

          {/* Inspected Vessel Details */}
          {activeVessel && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--fg)' }}>{activeVessel.label}</div>
              <div className="mono" style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                Volume: <strong>{Math.round(activeVessel.volumeUl)} µL</strong> / {activeVessel.capacityUl} µL
              </div>
              <div className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                Meniscus Z: {activeSurfaceZ ?? '—'} · Floor Z: {activeVessel.bottomZ}
              </div>
              <div className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                Dead vol: {activeVessel.deadVolumeUl} µL
              </div>
              {activeVessel.contaminants.length > 0 && (
                <div style={{ fontSize: '11.5px', color: 'var(--fg2)', marginTop: '2px' }}>
                  Contains: {activeVessel.contaminants.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Accident & Activity Log */}
      <div
        style={{
          marginTop: '14px',
          paddingTop: '12px',
          borderTop: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
            marginBottom: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '13px' }}>Accident &amp; Event Log</strong>
            <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
              <span style={{ color: crashCount > 0 ? 'var(--bad)' : 'var(--mut)', fontWeight: crashCount > 0 ? 700 : 400 }}>
                Crashes: {crashCount}
              </span>
              {' · '}
              <span style={{ color: hazardCount > 0 ? 'var(--bad)' : 'var(--mut)', fontWeight: hazardCount > 0 ? 700 : 400 }}>
                Hazards: {hazardCount}
              </span>
              {' · '}
              <span style={{ color: warningCount > 0 ? 'var(--warn)' : 'var(--mut)', fontWeight: warningCount > 0 ? 700 : 400 }}>
                Warnings: {warningCount}
              </span>
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <div
              role="group"
              aria-label="Filter simulation log"
              style={{
                display: 'inline-flex',
                padding: '2px',
                borderRadius: '6px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
              }}
            >
              {(
                [
                  ['all', 'All'],
                  ['accidents', `Accidents (${crashCount + hazardCount})`],
                  ['warnings', `Issues (${snapshot.accidents.length})`],
                ] as const
              ).map(([key, lbl]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLogFilter(key)}
                  style={{
                    border: 'none',
                    borderRadius: '4px',
                    padding: '3px 8px',
                    fontSize: '11.5px',
                    fontWeight: logFilter === key ? 700 : 500,
                    cursor: 'pointer',
                    background: logFilter === key ? 'var(--panel)' : 'transparent',
                    color: logFilter === key ? 'var(--fg)' : 'var(--mut)',
                  }}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={onClearLog}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <Trash2 size={12} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        <div
          style={{
            maxHeight: '180px',
            overflowY: 'auto',
            borderRadius: '6px',
            border: '1px solid var(--line)',
            background: 'var(--bg)',
          }}
        >
          {visibleLogItems.length === 0 ? (
            <div style={{ padding: '14px', fontSize: '12px', color: 'var(--mut)', textAlign: 'center' }}>
              {logFilter === 'all'
                ? 'No virtual actions yet — click Connect & Home or Simulate Planned Run to start.'
                : 'No accidents or warnings detected so far.'}
            </div>
          ) : (
            visibleLogItems.map((item) => {
              const isBad = item.severity === 'crash' || item.severity === 'hazard';
              const isWarn = item.severity === 'warning';
              return (
                <div
                  key={item.id}
                  style={{
                    padding: '7px 10px',
                    borderBottom: '1px solid var(--line2)',
                    fontSize: '12px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    background: isBad
                      ? 'color-mix(in srgb, var(--bad) 8%, transparent)'
                      : isWarn
                      ? 'color-mix(in srgb, var(--warn) 7%, transparent)'
                      : 'transparent',
                  }}
                >
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)', flexShrink: 0 }}>
                    {item.ts}
                  </span>
                  {isBad ? (
                    <AlertOctagon size={14} style={{ color: 'var(--bad)', flexShrink: 0, marginTop: '1px' }} />
                  ) : isWarn ? (
                    <AlertTriangle size={14} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: '1px' }} />
                  ) : null}
                  <div style={{ minWidth: 0 }}>
                    <strong
                      style={{
                        color: isBad ? 'var(--bad)' : isWarn ? 'var(--warn)' : 'var(--fg)',
                        marginRight: '6px',
                      }}
                    >
                      {item.title}
                    </strong>
                    <span style={{ color: 'var(--fg2)' }}>{item.detail}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
