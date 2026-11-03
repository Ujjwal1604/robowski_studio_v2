// Robowski Studio - TLC Full Plate Overview & Interactive Lane Map
import React, { useRef, useEffect, useState } from 'react';
import { TlcSet, TlcSpot } from '../../types';
import { containerOfLane, wellLabel, tlcFront, TlcChannelKey } from '../../engine';

interface TlcFullPlateViewProps {
  currentSet: TlcSet;
  activeChannel: TlcChannelKey;
  onSelectChannel: (key: TlcChannelKey) => void;
  filters: { brightness: number; contrast: number; invert: boolean };
  onOpenWellModal: (wellIndex: number) => void;
  run?: any;
  plate?: number;
}

export const TlcFullPlateView: React.FC<TlcFullPlateViewProps> = ({
  currentSet,
  activeChannel,
  onSelectChannel,
  filters,
  onOpenWellModal,
  run,
  plate = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredLaneId, setHoveredLaneId] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const imgEntry = currentSet.imgs[activeChannel];
  const lanes = currentSet.cfg?.lanes || [];
  const frameW = currentSet.frameW || 3280;

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

    // Draw Lane Overlays
    const imgScale = bmp.width / frameW;

    lanes.forEach((l) => {
      const isHovered = l.id === hoveredLaneId;
      const ox = l.x0 * imgScale;
      const oy = l.y0 * imgScale;
      const w = l.width * imgScale;
      const len = l.length * imgScale;
      const th = (l.angle * Math.PI) / 180;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(th);

      // Lane Bounding Box: from bottom (0, 0) upwards to (0, -len)
      ctx.beginPath();
      ctx.rect(-w / 2, -len, w, len);
      ctx.fillStyle = isHovered
        ? 'rgba(236, 72, 153, 0.35)'
        : 'rgba(16, 185, 129, 0.15)';
      ctx.fill();
      ctx.strokeStyle = isHovered ? '#ec4899' : 'rgba(16, 185, 129, 0.7)';
      ctx.lineWidth = isHovered ? 3 / scale : 1.5 / scale;
      ctx.stroke();

      // Spot Origin marker (zeroRf)
      if (l.zeroRf != null) {
        const originY = -l.zeroRf * imgScale;
        ctx.beginPath();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2 / scale;
        ctx.moveTo(-w / 2, originY);
        ctx.lineTo(w / 2, originY);
        ctx.stroke();
      }

      // Solvent front marker
      const frontDist = tlcFront(currentSet, l) * imgScale;
      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2 / scale;
      ctx.moveTo(-w / 2, -frontDist);
      ctx.lineTo(w / 2, -frontDist);
      ctx.stroke();

      // Lane label (Well & Lane ID)
      const wellIdx = containerOfLane(l.id);
      const label = wellLabel(wellIdx);
      ctx.fillStyle = isHovered ? '#ec4899' : '#ffffff';
      ctx.font = `bold ${Math.max(12, Math.round(18 / scale))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(label, 0, 24 / scale);

      ctx.restore();
    });

    ctx.restore();
  }, [imgEntry, lanes, frameW, hoveredLaneId]);

  // Mouse move over canvas to identify hovered lane
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEntry?.bmp) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    setMousePos({ x: e.clientX, y: e.clientY });

    const scale = rect.width / imgEntry.bmp.width;
    const imgScale = imgEntry.bmp.width / frameW;

    // Check collision with any lane
    let hitLaneId: number | null = null;
    for (const l of lanes) {
      const ox = l.x0 * imgScale * scale;
      const oy = l.y0 * imgScale * scale;
      const w = l.width * imgScale * scale;
      const len = l.length * imgScale * scale;

      // Approximate bounding box check in canvas space
      if (
        mouseX >= ox - w / 2 - 4 &&
        mouseX <= ox + w / 2 + 4 &&
        mouseY >= oy - len - 4 &&
        mouseY <= oy + 12
      ) {
        hitLaneId = l.id;
        break;
      }
    }
    setHoveredLaneId(hitLaneId);
  };

  const handleMouseLeave = () => {
    setHoveredLaneId(null);
    setMousePos(null);
  };

  const handleClick = () => {
    if (hoveredLaneId !== null) {
      const wellIdx = containerOfLane(hoveredLaneId);
      onOpenWellModal(wellIdx);
    }
  };

  // Find info about hovered well
  const hoveredWell = hoveredLaneId !== null ? containerOfLane(hoveredLaneId) : null;
  const hoveredRow = hoveredWell !== null && run?.rows
    ? run.rows.find((r: any) => r.plate_number === plate && r.container_id === hoveredWell)
    : null;

  const cssFilter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) ${
    filters.invert ? 'invert(1)' : ''
  }`;

  return (
    <div ref={containerRef} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Plate Image Display */}
      {imgEntry?.bmp ? (
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            style={{
              display: 'block',
              maxWidth: '100%',
              borderRadius: '8px',
              border: '1px solid var(--line)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              cursor: hoveredLaneId !== null ? 'pointer' : 'crosshair',
              filter: cssFilter,
            }}
          />

          {/* Hover Lane Floating Tooltip */}
          {hoveredLaneId !== null && mousePos && (
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
                border: '1px solid #ec4899',
                backdropFilter: 'blur(6px)',
              }}
            >
              <div style={{ fontWeight: 700, color: '#ec4899' }}>
                Well {wellLabel(hoveredWell!)} · Lane {hoveredLaneId}
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
                Click to inspect lane densitogram &amp; peaks
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
              Lane Bounding Box (54 Total)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '3px', background: '#fbbf24' }} />
              Spotting Origin ($R_f = 0$)
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '12px', height: '3px', background: '#38bdf8' }} />
              Solvent Front ($R_f = 1$)
            </span>
            <span style={{ color: 'var(--pri)' }}>
              💡 Click any lane on the plate to view its individual profile
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
