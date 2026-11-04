// Robowski Studio - TLC Full Plate Overview & Live On-Canvas Interactive Lane Editor
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TlcSet, TlcLane } from '../../types';
import { containerOfLane, wellLabel, tlcFront, tlcOrigin, TlcChannelKey } from '../../engine';

interface TlcFullPlateViewProps {
  currentSet: TlcSet;
  activeChannel: TlcChannelKey;
  onSelectChannel: (key: TlcChannelKey) => void;
  filters: { brightness: number; contrast: number; invert: boolean };
  onOpenWellModal: (wellIndex: number) => void;
  run?: any;
  plate?: number;
  getProfile?: (set: TlcSet, key: 'UV366', lane: any) => number[];
  onUpdateLane?: (laneId: number, patch: Partial<TlcLane>) => void;
  onUpdateSetFront?: (frontPx: number | null, side?: number) => void;
  onUndo?: () => void;
  canUndo?: boolean;
  onResetLane?: (laneId: number) => void;
  onResetAllLanes?: () => void;
  onExportLaneCsv?: () => void;
}

// Explicit high-contrast button styling for the HUD dark theme
const hudBtn: React.CSSProperties = {
  background: '#1e293b',
  color: '#f8fafc',
  border: '1px solid #475569',
  borderRadius: '4px',
  padding: '4px 8px',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
  lineHeight: 1.2,
  transition: 'background 0.15s, border-color 0.15s',
};

const hudSliderTrack: React.CSSProperties = {
  cursor: 'ew-resize',
  height: '6px',
  borderRadius: '3px',
  outline: 'none',
  background: '#334155',
};

export const TlcFullPlateView: React.FC<TlcFullPlateViewProps> = ({
  currentSet,
  activeChannel,
  onSelectChannel,
  filters,
  onOpenWellModal,
  run,
  plate = 0,
  getProfile,
  onUpdateLane,
  onUpdateSetFront,
  onUndo,
  canUndo = false,
  onResetLane,
  onResetAllLanes,
  onExportLaneCsv,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [hoveredLaneId, setHoveredLaneId] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // Dragging state for moving lanes directly on canvas
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; x0: number; y0: number } | null>(null);

  const imgEntry = currentSet.imgs[activeChannel];
  const lanes = currentSet.cfg?.lanes || [];
  const frameW = currentSet.frameW || 3280;

  // Selected lane object
  const selectedLane = selectedLaneId !== null ? lanes.find((l) => l.id === selectedLaneId) || null : null;

  // Render Full Plate Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEntry?.bmp) return;

    const bmp = imgEntry.bmp;
    const maxDisplayW = Math.min(1200, containerRef.current?.clientWidth || 1000);
    const scale = maxDisplayW / bmp.width;
    const displayH = Math.round(bmp.height * scale);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = maxDisplayW * dpr;
    canvas.height = displayH * dpr;
    canvas.style.width = `${maxDisplayW}px`;
    canvas.style.height = `${displayH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr * scale, dpr * scale);

    // Draw full plate bitmap
    ctx.drawImage(bmp, 0, 0);

    const imgScale = bmp.width / frameW;

    // Draw All Lanes
    lanes.forEach((l) => {
      const isSelected = l.id === selectedLaneId;
      const isHovered = l.id === hoveredLaneId && !isSelected;

      const ox = l.x0 * imgScale;
      const oy = l.y0 * imgScale;
      const w = l.width * imgScale;
      const len = l.length * imgScale;
      const th = (l.angle * Math.PI) / 180;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(th);

      // Spot Origin marker (baseline Rf = 0)
      const originDist = tlcOrigin(currentSet, l, getProfile as any) * imgScale;
      // Solvent front marker (Rf = 1.0)
      const frontDist = tlcFront(currentSet, l, getProfile) * imgScale;

      if (isSelected) {
        // Prominent glowing bounding box for active editing
        ctx.shadowColor = '#facc15';
        ctx.shadowBlur = 12 / scale;

        ctx.beginPath();
        ctx.rect(-w / 2, -len, w, len);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.24)';
        ctx.fill();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 3.5 / scale;
        ctx.stroke();

        ctx.shadowBlur = 0; // reset shadow

        // Centerline with directional migration vector
        ctx.beginPath();
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2 / scale;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -len);
        ctx.stroke();
        ctx.setLineDash([]);

        // Direction Arrowhead at solvent front apex (0, -len)
        const arrowSize = Math.max(8 / scale, w * 0.28);
        ctx.beginPath();
        ctx.moveTo(0, -len);
        ctx.lineTo(-arrowSize, -len + arrowSize * 1.5);
        ctx.lineTo(arrowSize, -len + arrowSize * 1.5);
        ctx.closePath();
        ctx.fillStyle = '#facc15';
        ctx.fill();

        // Origin baseline marker with distinct yellow handles
        ctx.beginPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5 / scale;
        ctx.moveTo(-w / 2, -originDist);
        ctx.lineTo(w / 2, -originDist);
        ctx.stroke();

        // Anchor handles at origin ends
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(-w / 2, -originDist, 4 / scale, 0, Math.PI * 2);
        ctx.arc(w / 2, -originDist, 4 / scale, 0, Math.PI * 2);
        ctx.fill();

        // Solvent front marker (cyan line)
        ctx.beginPath();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5 / scale;
        ctx.moveTo(-w / 2, -frontDist);
        ctx.lineTo(w / 2, -frontDist);
        ctx.stroke();

        // Solvent front anchor handles
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(-w / 2, -frontDist, 4 / scale, 0, Math.PI * 2);
        ctx.arc(w / 2, -frontDist, 4 / scale, 0, Math.PI * 2);
        ctx.fill();

        // Origin Anchor circle at bottom center (0, 0)
        ctx.beginPath();
        ctx.arc(0, 0, 4.5 / scale, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 / scale;
        ctx.fill();
        ctx.stroke();

        // Selected Lane Badge (Well & Angle)
        const wellIdx = containerOfLane(l.id);
        const label = `${wellLabel(wellIdx)} · ${l.angle >= 0 ? '+' : ''}${l.angle.toFixed(1)}°`;
        ctx.fillStyle = '#facc15';
        ctx.font = `bold ${Math.max(13, Math.round(20 / scale))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, 24 / scale);
      } else {
        // Standard Lane Bounding Box
        ctx.beginPath();
        ctx.rect(-w / 2, -len, w, len);
        ctx.fillStyle = isHovered
          ? 'rgba(236, 72, 153, 0.35)'
          : 'rgba(16, 185, 129, 0.14)';
        ctx.fill();
        ctx.strokeStyle = isHovered ? '#ec4899' : 'rgba(16, 185, 129, 0.65)';
        ctx.lineWidth = isHovered ? 2.5 / scale : 1.5 / scale;
        ctx.stroke();

        // Origin marker
        ctx.beginPath();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5 / scale;
        ctx.moveTo(-w / 2, -originDist);
        ctx.lineTo(w / 2, -originDist);
        ctx.stroke();

        // Front marker
        ctx.beginPath();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5 / scale;
        ctx.moveTo(-w / 2, -frontDist);
        ctx.lineTo(w / 2, -frontDist);
        ctx.stroke();

        // Lane label
        const wellIdx = containerOfLane(l.id);
        const label = wellLabel(wellIdx);
        ctx.fillStyle = isHovered ? '#ec4899' : '#ffffff';
        ctx.font = `bold ${Math.max(12, Math.round(17 / scale))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, 22 / scale);
      }

      ctx.restore();
    });

    ctx.restore();
  }, [imgEntry, lanes, frameW, hoveredLaneId, selectedLaneId, currentSet, getProfile]);

  // Find lane collision at mouse coordinates
  const findLaneAtPoint = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas || !imgEntry?.bmp) return null;

      const rect = canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const scale = rect.width / imgEntry.bmp.width;
      const imgScale = imgEntry.bmp.width / frameW;

      for (const l of lanes) {
        const ox = l.x0 * imgScale * scale;
        const oy = l.y0 * imgScale * scale;
        const w = l.width * imgScale * scale;
        const len = l.length * imgScale * scale;
        const th = (l.angle * Math.PI) / 180;

        const dx = mouseX - ox;
        const dy = mouseY - oy;

        const cos = Math.cos(-th);
        const sin = Math.sin(-th);
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;

        if (
          localX >= -w / 2 - 6 &&
          localX <= w / 2 + 6 &&
          localY >= -len - 8 &&
          localY <= 18
        ) {
          return l.id;
        }
      }
      return null;
    },
    [imgEntry, frameW, lanes]
  );

  // Mouse Move: update hover and handle on-canvas dragging
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setMousePos({ x: e.clientX, y: e.clientY });

    if (isDragging && dragStartRef.current && selectedLane && onUpdateLane && imgEntry?.bmp) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / imgEntry.bmp.width;
      const imgScale = imgEntry.bmp.width / frameW;

      const deltaX = (e.clientX - dragStartRef.current.mouseX) / (scale * imgScale);
      const deltaY = (e.clientY - dragStartRef.current.mouseY) / (scale * imgScale);

      onUpdateLane(selectedLane.id, {
        x0: Math.round(dragStartRef.current.x0 + deltaX),
        y0: Math.round(dragStartRef.current.y0 + deltaY),
      });
      return;
    }

    const hit = findLaneAtPoint(e.clientX, e.clientY);
    setHoveredLaneId(hit);
  };

  // Mouse Down: select lane or initiate drag
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = findLaneAtPoint(e.clientX, e.clientY);
    if (hit !== null) {
      setSelectedLaneId(hit);
      const target = lanes.find((l) => l.id === hit);
      if (target) {
        setIsDragging(true);
        dragStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          x0: target.x0,
          y0: target.y0,
        };
      }
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  const handleMouseLeave = () => {
    setHoveredLaneId(null);
    setMousePos(null);
    setIsDragging(false);
    dragStartRef.current = null;
  };

  // Double click on canvas lane opens detailed well inspection modal
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = findLaneAtPoint(e.clientX, e.clientY);
    if (hit !== null) {
      const wellIdx = containerOfLane(hit);
      onOpenWellModal(wellIdx);
    }
  };

  // Real-time Keyboard Nudge Shortcuts on window
  useEffect(() => {
    if (selectedLaneId === null || !onUpdateLane) return;
    const targetLane = lanes.find((l) => l.id === selectedLaneId);
    if (!targetLane) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const step = e.shiftKey ? 5 : 1;
      const angleStep = e.shiftKey ? 1.0 : 0.2;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          onUpdateLane(targetLane.id, { x0: Math.round(targetLane.x0 - step) });
          break;
        case 'ArrowRight':
          e.preventDefault();
          onUpdateLane(targetLane.id, { x0: Math.round(targetLane.x0 + step) });
          break;
        case 'ArrowUp':
          e.preventDefault();
          onUpdateLane(targetLane.id, { y0: Math.round(targetLane.y0 - step) });
          break;
        case 'ArrowDown':
          e.preventDefault();
          onUpdateLane(targetLane.id, { y0: Math.round(targetLane.y0 + step) });
          break;
        case 'q':
        case 'Q':
        case '[':
          e.preventDefault();
          onUpdateLane(targetLane.id, { angle: +(targetLane.angle - angleStep).toFixed(2) });
          break;
        case 'e':
        case 'E':
        case ']':
          e.preventDefault();
          onUpdateLane(targetLane.id, { angle: +(targetLane.angle + angleStep).toFixed(2) });
          break;
        case '-':
        case '_':
          e.preventDefault();
          onUpdateLane(targetLane.id, { width: Math.max(8, Math.round(targetLane.width - (e.shiftKey ? 4 : 2))) });
          break;
        case '=':
        case '+':
          e.preventDefault();
          onUpdateLane(targetLane.id, { width: Math.round(targetLane.width + (e.shiftKey ? 4 : 2)) });
          break;
        case 'PageUp':
        case 'a':
        case 'A': {
          e.preventDefault();
          const prevId = (targetLane.id - 1 + lanes.length) % lanes.length;
          setSelectedLaneId(prevId);
          break;
        }
        case 'PageDown':
        case 'd':
        case 'D': {
          e.preventDefault();
          const nextId = (targetLane.id + 1) % lanes.length;
          setSelectedLaneId(nextId);
          break;
        }
        case 'Enter':
          e.preventDefault();
          onOpenWellModal(containerOfLane(targetLane.id));
          break;
        case 'Escape':
          e.preventDefault();
          setSelectedLaneId(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedLaneId, lanes, onUpdateLane, onOpenWellModal]);

  // Hovered Well details for tooltip
  const hoveredWell = hoveredLaneId !== null ? containerOfLane(hoveredLaneId) : null;
  const hoveredRow = hoveredWell !== null && run?.rows
    ? run.rows.find((r: any) => r.plate_number === plate && r.container_id === hoveredWell)
    : null;

  // Selected Well details for HUD
  const selectedWell = selectedLane ? containerOfLane(selectedLane.id) : null;
  const selectedRow = selectedWell !== null && run?.rows
    ? run.rows.find((r: any) => r.plate_number === plate && r.container_id === selectedWell)
    : null;

  const sampleLaneSide0 = lanes.find((l) => l.id < 27) || lanes[0];
  const sampleLaneSide1 = lanes.find((l) => l.id >= 27) || lanes[Math.min(27, lanes.length - 1)];

  const frontSide0Val = sampleLaneSide0
    ? Math.round(tlcFront(currentSet, sampleLaneSide0, getProfile))
    : 920;
  const frontSide1Val = sampleLaneSide1
    ? Math.round(tlcFront(currentSet, sampleLaneSide1, getProfile))
    : 920;

  const selectedSide = selectedLane ? (selectedLane.id < 27 ? 0 : 1) : null;

  const currentOriginVal = selectedLane
    ? Math.round(tlcOrigin(currentSet, selectedLane, getProfile as any))
    : 100;
  const currentFrontVal = selectedLane
    ? Math.round(tlcFront(currentSet, selectedLane, getProfile))
    : (selectedSide === 1 ? frontSide1Val : frontSide0Val);

  const cssFilter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) ${
    filters.invert ? 'invert(1)' : ''
  }`;

  return (
    <div ref={containerRef} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* FLOATING / PINNED ON-CANVAS HUD TOOLBAR WITH CONTINUOUS SLIDERS & UNDO/RESET */}
      {selectedLane && onUpdateLane ? (
        <div
          style={{
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '12px',
            padding: '14px 18px',
            background: 'rgba(15, 23, 42, 0.96)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            border: '2px solid #facc15',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            color: '#f8fafc',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            zIndex: 30,
          }}
        >
          {/* Top Bar: Lane Identity, Well Formula, Undo/Reset & Actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span
                style={{
                  background: '#facc15',
                  color: '#0f172a',
                  fontWeight: 800,
                  fontSize: '13px',
                  padding: '3px 10px',
                  borderRadius: '4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                🎯 Lane {selectedLane.id} (Well {wellLabel(selectedWell!)})
              </span>

              {selectedRow ? (
                <span style={{ fontSize: '12px', color: '#cbd5e1' }}>
                  {selectedRow.recipe
                    .filter((rc: any) => rc.target_concentration > 0)
                    .map((rc: any) => `${rc.code} ${rc.target_concentration.toFixed(1)} mM`)
                    .join(' · ')}
                </span>
              ) : (
                <span style={{ fontSize: '11px', color: '#94a3b8' }}>Unused / empty well</span>
              )}

              {/* Lane Switcher */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const prevId = (selectedLane.id - 1 + lanes.length) % lanes.length;
                    setSelectedLaneId(prevId);
                  }}
                  title="Previous lane (A or PageUp)"
                >
                  ◀ Prev
                </button>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const nextId = (selectedLane.id + 1) % lanes.length;
                    setSelectedLaneId(nextId);
                  }}
                  title="Next lane (D or PageDown)"
                >
                  Next ▶
                </button>
              </div>
            </div>

            {/* Right Action Cluster: Undo, Reset Lane, Reset All, Inspect Modal, Export, Done */}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Undo Button */}
              {onUndo && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    background: canUndo ? '#334155' : '#1e293b',
                    color: canUndo ? '#38bdf8' : '#64748b',
                    borderColor: canUndo ? '#0284c7' : '#334155',
                    cursor: canUndo ? 'pointer' : 'not-allowed',
                    opacity: canUndo ? 1 : 0.6,
                  }}
                  onClick={onUndo}
                  disabled={!canUndo}
                  title="Undo last change (Ctrl+Z)"
                >
                  ↺ Undo
                </button>
              )}

              {/* Reset This Lane */}
              {onResetLane && (
                <button
                  type="button"
                  style={{ ...hudBtn, background: '#1e293b', color: '#fbbf24', borderColor: '#b45309' }}
                  onClick={() => onResetLane(selectedLane.id)}
                  title="Reset this lane to original template"
                >
                  ⟲ Reset Lane
                </button>
              )}

              {/* Reset All Lanes */}
              {onResetAllLanes && (
                <button
                  type="button"
                  style={{ ...hudBtn, background: '#1e293b', color: '#94a3b8', borderColor: '#475569' }}
                  onClick={onResetAllLanes}
                  title="Reset all 54 lanes to template"
                >
                  ⟲ Reset All
                </button>
              )}

              {/* Inspect Well Modal */}
              <button
                type="button"
                style={{ ...hudBtn, background: '#0284c7', color: '#ffffff', borderColor: '#0369a1' }}
                onClick={() => onOpenWellModal(selectedWell!)}
                title="Inspect densitogram and peaks (Enter)"
              >
                🔍 Inspect Densitogram
              </button>

              {/* Export CSV */}
              {onExportLaneCsv && (
                <button
                  type="button"
                  style={{ ...hudBtn, background: '#059669', color: '#ffffff', borderColor: '#047857' }}
                  onClick={onExportLaneCsv}
                  title="Export corrected lane CSV file"
                >
                  💾 Export CSV
                </button>
              )}

              {/* Done */}
              <button
                type="button"
                style={{ ...hudBtn, background: '#334155', color: '#cbd5e1', borderColor: '#475569' }}
                onClick={() => setSelectedLaneId(null)}
                title="Deselect lane (Esc)"
              >
                ✕ Done
              </button>
            </div>
          </div>

          {/* ROW 1: Position & Orientation Continuous Sliders */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '12px',
              background: 'rgba(0,0,0,0.35)',
              padding: '10px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {/* Shift X Continuous Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift X (Position):</span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #334155' }}>
                  {Math.round(selectedLane.x0)} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { x0: selectedLane.x0 - 1 })}
                  title="Shift left 1px (←)"
                >
                  ◀ -1
                </button>
                <input
                  type="range"
                  min={Math.max(0, Math.round(selectedLane.x0 - 120))}
                  max={Math.min(frameW, Math.round(selectedLane.x0 + 120))}
                  step={1}
                  value={Math.round(selectedLane.x0)}
                  onChange={(e) => onUpdateLane(selectedLane.id, { x0: +e.target.value })}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                  title="Smooth continuous Shift X slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { x0: selectedLane.x0 + 1 })}
                  title="Shift right 1px (→)"
                >
                  +1 ▶
                </button>
              </div>
            </div>

            {/* Shift Y Continuous Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift Y (Position):</span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #334155' }}>
                  {Math.round(selectedLane.y0)} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { y0: selectedLane.y0 - 1 })}
                  title="Shift up 1px (↑)"
                >
                  ▲ -1
                </button>
                <input
                  type="range"
                  min={Math.max(50, Math.round(selectedLane.y0 - 120))}
                  max={Math.min(3200, Math.round(selectedLane.y0 + 120))}
                  step={1}
                  value={Math.round(selectedLane.y0)}
                  onChange={(e) => onUpdateLane(selectedLane.id, { y0: +e.target.value })}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                  title="Smooth continuous Shift Y slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { y0: selectedLane.y0 + 1 })}
                  title="Shift down 1px (↓)"
                >
                  +1 ▼
                </button>
              </div>
            </div>

            {/* Tilt Angle Continuous Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#facc15' }}>Tilt Angle (Orientation):</span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 800, color: '#facc15', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #b45309' }}>
                  {selectedLane.angle.toFixed(1)}°
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle - 0.2).toFixed(2) })}
                  title="Rotate counter-clockwise 0.2° (Q)"
                >
                  ↺ -0.2°
                </button>
                <input
                  type="range"
                  min={Math.abs(selectedLane.angle) > 90 ? 150 : -30}
                  max={Math.abs(selectedLane.angle) > 90 ? 210 : 30}
                  step={0.1}
                  value={selectedLane.angle}
                  onChange={(e) => onUpdateLane(selectedLane.id, { angle: parseFloat((+e.target.value).toFixed(2)) })}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#facc15' }}
                  title="Smooth continuous Tilt Angle slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle + 0.2).toFixed(2) })}
                  title="Rotate clockwise 0.2° (E)"
                >
                  +0.2° ↻
                </button>
              </div>
            </div>
          </div>

          {/* ROW 2: Chromatography Dimensions & Meniscus Sliders */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '12px',
              background: 'rgba(0,0,0,0.35)',
              padding: '10px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {/* Origin Baseline (Rf = 0.00) Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>Origin Baseline (Rf = 0.00):</span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#fbbf24', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #78350f' }}>
                  {currentOriginVal} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { zeroRf: Math.max(5, currentOriginVal - 1) })}
                  title="Lower origin baseline 1px"
                >
                  -1
                </button>
                <input
                  type="range"
                  min={5}
                  max={Math.round(selectedLane.length * 0.45)}
                  step={1}
                  value={currentOriginVal}
                  onChange={(e) => onUpdateLane(selectedLane.id, { zeroRf: +e.target.value })}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#fbbf24' }}
                  title="Smooth continuous Origin Baseline slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { zeroRf: currentOriginVal + 1 })}
                  title="Raise origin baseline 1px"
                >
                  +1
                </button>
              </div>
            </div>

            {/* Solvent Front - Side 1 (Lanes 0–26 / Half 1) Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span>Front Side 1 (L0–26):</span>
                  {selectedSide === 0 && (
                    <span style={{ fontSize: '9px', background: '#0284c7', color: '#fff', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                      Active
                    </span>
                  )}
                </span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #0369a1' }}>
                  {frontSide0Val} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const nextVal = Math.max(50, frontSide0Val - 1);
                    if (onUpdateSetFront) onUpdateSetFront(nextVal, 0);
                  }}
                  title="Lower Side 1 solvent front meniscus 1px"
                >
                  -1
                </button>
                <input
                  type="range"
                  min={50}
                  max={Math.round((sampleLaneSide0?.length || 980) * 1.1)}
                  step={1}
                  value={frontSide0Val}
                  onChange={(e) => {
                    const val = +e.target.value;
                    if (onUpdateSetFront) onUpdateSetFront(val, 0);
                  }}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                  title="Side 1 (Lanes 0-26 / Lower Tier) Solvent Front continuous slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const nextVal = frontSide0Val + 1;
                    if (onUpdateSetFront) onUpdateSetFront(nextVal, 0);
                  }}
                  title="Raise Side 1 solvent front meniscus 1px"
                >
                  +1
                </button>
              </div>
            </div>

            {/* Solvent Front - Side 2 (Lanes 27–53 / Half 2) Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <span>Front Side 2 (L27–53):</span>
                  {selectedSide === 1 && (
                    <span style={{ fontSize: '9px', background: '#0891b2', color: '#fff', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                      Active
                    </span>
                  )}
                </span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#06b6d4', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #0891b2' }}>
                  {frontSide1Val} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const nextVal = Math.max(50, frontSide1Val - 1);
                    if (onUpdateSetFront) onUpdateSetFront(nextVal, 1);
                  }}
                  title="Lower Side 2 solvent front meniscus 1px"
                >
                  -1
                </button>
                <input
                  type="range"
                  min={50}
                  max={Math.round((sampleLaneSide1?.length || 980) * 1.1)}
                  step={1}
                  value={frontSide1Val}
                  onChange={(e) => {
                    const val = +e.target.value;
                    if (onUpdateSetFront) onUpdateSetFront(val, 1);
                  }}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#06b6d4' }}
                  title="Side 2 (Lanes 27-53 / Upper Tier) Solvent Front continuous slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => {
                    const nextVal = frontSide1Val + 1;
                    if (onUpdateSetFront) onUpdateSetFront(nextVal, 1);
                  }}
                  title="Raise Side 2 solvent front meniscus 1px"
                >
                  +1
                </button>
              </div>
            </div>

            {/* Lane Width Slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc' }}>Lane Width:</span>
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#c084fc', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #6b21a8' }}>
                  {Math.round(selectedLane.width)} px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { width: Math.max(8, selectedLane.width - 1) })}
                  title="Narrow lane 1px"
                >
                  -1
                </button>
                <input
                  type="range"
                  min={8}
                  max={120}
                  step={1}
                  value={Math.round(selectedLane.width)}
                  onChange={(e) => onUpdateLane(selectedLane.id, { width: +e.target.value })}
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#c084fc' }}
                  title="Smooth continuous Lane Width slider"
                />
                <button
                  type="button"
                  style={hudBtn}
                  onClick={() => onUpdateLane(selectedLane.id, { width: selectedLane.width + 1 })}
                  title="Widen lane 1px"
                >
                  +1
                </button>
              </div>
            </div>
          </div>

          {/* Keyboard & Mouse Guide */}
          <div style={{ fontSize: '11px', color: '#94a3b8', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>⚡ <b>Controls:</b> Drag continuous sliders for smooth real-time scrubbing</span>
            <span>⌨️ Arrow keys (<span className="mono">← → ↑ ↓</span>) nudge position</span>
            <span><span className="mono">Q / E</span> tilt angle</span>
            <span><span className="mono">Shift</span> 5× step</span>
            <span><span className="mono">Ctrl+Z</span> undo</span>
            <span style={{ color: '#38bdf8' }}>🖱️ Or click &amp; drag the lane directly on the canvas!</span>
          </div>
        </div>
      ) : (
        <div
          style={{
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '10px',
            padding: '10px 16px',
            background: 'var(--soft)',
            borderRadius: '8px',
            border: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
            fontSize: '12px',
          }}
        >
          <span style={{ color: 'var(--fg)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span>💡</span>
            <span><b>Direct Lane Alignment:</b> Click any lane on the physical plate photograph below to open the continuous sliders for position, tilt, baseline origin, and dual solvent fronts.</span>
          </span>

          {/* Dual Solvent Front Quick Sliders for both sides of the plate */}
          {lanes.length > 0 && onUpdateSetFront && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', background: 'rgba(0,0,0,0.2)', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
              {/* Side 1 Front */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Front Side 1:</span>
                <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #0369a1' }}>
                  {frontSide0Val} px
                </span>
                <input
                  type="range"
                  min={50}
                  max={Math.round((sampleLaneSide0?.length || 980) * 1.1)}
                  step={1}
                  value={frontSide0Val}
                  onChange={(e) => onUpdateSetFront(+e.target.value, 0)}
                  style={{ ...hudSliderTrack, width: '80px', accentColor: '#38bdf8' }}
                  title="Side 1 (Lanes 0-26 / Lower Tier) continuous Solvent Front slider"
                />
              </div>

              {/* Side 2 Front */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4' }}>Front Side 2:</span>
                <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #0891b2' }}>
                  {frontSide1Val} px
                </span>
                <input
                  type="range"
                  min={50}
                  max={Math.round((sampleLaneSide1?.length || 980) * 1.1)}
                  step={1}
                  value={frontSide1Val}
                  onChange={(e) => onUpdateSetFront(+e.target.value, 1)}
                  style={{ ...hudSliderTrack, width: '80px', accentColor: '#06b6d4' }}
                  title="Side 2 (Lanes 27-53 / Upper Tier) continuous Solvent Front slider"
                />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {onUndo && (
              <button
                type="button"
                style={{ ...hudBtn, opacity: canUndo ? 1 : 0.5, cursor: canUndo ? 'pointer' : 'not-allowed' }}
                onClick={onUndo}
                disabled={!canUndo}
                title="Undo last change (Ctrl+Z)"
              >
                ↺ Undo
              </button>
            )}
            {lanes.length > 0 && (
              <button
                type="button"
                style={hudBtn}
                onClick={() => setSelectedLaneId(0)}
              >
                Select Lane 0 (A1)
              </button>
            )}
            {onExportLaneCsv && (
              <button
                type="button"
                style={{ ...hudBtn, background: '#059669', color: '#fff', borderColor: '#047857' }}
                onClick={onExportLaneCsv}
              >
                💾 Export Lane CSV
              </button>
            )}
          </div>
        </div>
      )}

      {/* Plate Image Display */}
      {imgEntry?.bmp ? (
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onDoubleClick={handleDoubleClick}
            style={{
              display: 'block',
              maxWidth: '100%',
              borderRadius: '8px',
              border: selectedLaneId !== null ? '2px solid #facc15' : '1px solid var(--line)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              cursor: isDragging ? 'grabbing' : hoveredLaneId !== null ? 'pointer' : 'crosshair',
              filter: cssFilter,
            }}
          />

          {/* Hover Lane Floating Tooltip (shown when not dragging) */}
          {hoveredLaneId !== null && mousePos && !isDragging && (
            <div
              style={{
                position: 'fixed',
                left: mousePos.x + 16,
                top: mousePos.y - 40,
                zIndex: 9999,
                background: 'rgba(15, 23, 42, 0.95)',
                color: '#fff',
                padding: '8px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                pointerEvents: 'none',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                border: hoveredLaneId === selectedLaneId ? '1px solid #facc15' : '1px solid #ec4899',
                backdropFilter: 'blur(6px)',
              }}
            >
              <div style={{ fontWeight: 700, color: hoveredLaneId === selectedLaneId ? '#facc15' : '#ec4899' }}>
                Well {wellLabel(hoveredWell!)} · Lane {hoveredLaneId}
                {hoveredLaneId === selectedLaneId && ' (Active for Editing)'}
              </div>
              {hoveredRow ? (
                <div style={{ fontSize: '11px', marginTop: '3px', opacity: 0.9 }}>
                  {hoveredRow.recipe
                    .filter((rc: any) => rc.target_concentration > 0)
                    .map((rc: any) => `${rc.code} ${rc.target_concentration.toFixed(1)} mM`)
                    .join(' · ')}
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Unused / empty well</div>
              )}
              <div style={{ fontSize: '10px', color: '#38bdf8', marginTop: '4px' }}>
                Click to select &amp; open continuous sliders · Double-click to inspect densitogram
              </div>
            </div>
          )}

          {/* Legend Overlay at bottom */}
          <div
            style={{
              display: 'flex',
              gap: '16px',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              marginTop: '8px',
              fontSize: '11px',
              color: 'var(--mut)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '12px', background: 'rgba(16, 185, 129, 0.6)', border: '1px solid #10b981' }} />
              Lane Bounding Box ({lanes.length} Total)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '12px', background: 'rgba(250, 204, 21, 0.6)', border: '1px solid #facc15' }} />
              Active Lane (Live Micro-Adjust)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '3px', background: '#fbbf24' }} />
              Spotting Origin (Rf = 0)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '3px', background: '#38bdf8' }} />
              Solvent Front (Rf = 1)
            </span>
          </div>
        </div>
      ) : (
        <div
          style={{
            textAlign: 'center',
            padding: '48px 24px',
            background: 'var(--soft)',
            borderRadius: '8px',
            border: '2px dashed var(--line)',
            width: '100%',
            maxWidth: '640px',
          }}
        >
          <div style={{ fontSize: '36px', marginBottom: '8px' }}>📷</div>
          <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '6px' }}>
            No {activeChannel} Plate Image Loaded
          </div>
          <p style={{ fontSize: '13px', color: 'var(--mut)', margin: '0 0 16px' }}>
            Upload your laboratory TLC plate photograph (PNG, JPEG, WebP) or click below to load a synthetic demonstration plate.
          </p>
        </div>
      )}
    </div>
  );
};
