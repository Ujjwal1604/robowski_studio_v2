import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TlcSet, TlcLane } from '../../types';
import {
  containerOfLane,
  wellLabel,
  tlcFront,
  tlcOrigin,
  TlcChannelKey,
  findSpots,
  TLC_SIGNAL,
  extractFluorescenceOverlay,
  computeFalseColorComposite,
} from '../../engine';

export type CompositeSubMode = 'glow' | 'false-color' | 'split';

interface TlcFullPlateViewProps {
  currentSet: TlcSet;
  activeChannel: TlcChannelKey | 'composite';
  onSelectChannel: (key: TlcChannelKey | 'composite') => void;
  filters: { brightness: number; contrast: number; invert: boolean };
  onOpenWellModal: (wellIndex: number) => void;
  run?: any;
  plate?: number;
  getProfile?: (set: TlcSet, key: any, lane: any) => number[];
  onUpdateLane?: (laneId: number, patch: Partial<TlcLane>) => void;
  onUpdateSetFront?: (frontPx: number | null, side?: number) => void;
  onSnapshotHistory?: () => void;
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
  onSnapshotHistory,
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

  // HUD layout states: fixed sticky top or fixed bottom dock, and collapsible
  const [hudPosition, setHudPosition] = useState<'top' | 'bottom'>('top');
  const [isHudCollapsed, setIsHudCollapsed] = useState(false);

  // Dragging state for moving lanes directly on canvas
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; x0: number; y0: number } | null>(null);

  // Rf Badges & Spot Annotations toggle
  const [showRfBadges, setShowRfBadges] = useState(true);

  // Dual-channel composite sub-mode: 'glow' (isolated fluorescence overlay) | 'false-color' | 'split' (interactive curtain)
  const [compositeSubMode, setCompositeSubMode] = useState<CompositeSubMode>('glow');
  const [compositeBlend, setCompositeBlend] = useState(0.85);
  const [fluoThreshold, setFluoThreshold] = useState<number>(0.18);
  const [fluoGain, setFluoGain] = useState<number>(1.6);
  const [splitPos, setSplitPos] = useState<number>(0.50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);

  // Offscreen canvas cache for background-subtracted fluorescence and false-color composite
  const compositeCacheCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeCacheKeyRef = useRef<string>('');

  const isComposite = activeChannel === 'composite';
  const imgEntry = isComposite
    ? (currentSet.imgs.UV254 || currentSet.imgs.UV366 || currentSet.imgs.White)
    : currentSet.imgs[activeChannel as TlcChannelKey];
  const lanes = currentSet.cfg?.lanes || [];
  const frameW = currentSet.frameW || 3280;

  // Global Plate Skew / Tilt: apply delta angle uniformly across all 54 lanes
  const handleApplyGlobalSkew = useCallback(
    (deltaDeg: number) => {
      if (!onUpdateLane) return;
      if (onSnapshotHistory) onSnapshotHistory();
      lanes.forEach((l) => {
        onUpdateLane(l.id, { angle: +(l.angle + deltaDeg).toFixed(2) });
      });
    },
    [lanes, onUpdateLane, onSnapshotHistory]
  );

  // Selected lane object
  const selectedLane = selectedLaneId !== null ? lanes.find((l) => l.id === selectedLaneId) || null : null;

  // Stable anchor coordinates for Shift X and Shift Y sliders (prevents range shifting under thumb during drag)
  const laneAnchorRef = useRef<{ id: number; x0: number; y0: number } | null>(null);
  if (selectedLane && (!laneAnchorRef.current || laneAnchorRef.current.id !== selectedLane.id)) {
    laneAnchorRef.current = { id: selectedLane.id, x0: selectedLane.x0, y0: selectedLane.y0 };
  } else if (!selectedLane) {
    laneAnchorRef.current = null;
  }

  // Auto-expand anchor if position nudged far outside initial window
  if (selectedLane && laneAnchorRef.current) {
    if (selectedLane.x0 < laneAnchorRef.current.x0 - 280) {
      laneAnchorRef.current.x0 = selectedLane.x0 + 200;
    } else if (selectedLane.x0 > laneAnchorRef.current.x0 + 280) {
      laneAnchorRef.current.x0 = selectedLane.x0 - 200;
    }
    if (selectedLane.y0 < laneAnchorRef.current.y0 - 280) {
      laneAnchorRef.current.y0 = selectedLane.y0 + 200;
    } else if (selectedLane.y0 > laneAnchorRef.current.y0 + 280) {
      laneAnchorRef.current.y0 = selectedLane.y0 - 200;
    }
  }

  const anchorX = laneAnchorRef.current ? laneAnchorRef.current.x0 : (selectedLane?.x0 ?? 0);
  const anchorY = laneAnchorRef.current ? laneAnchorRef.current.y0 : (selectedLane?.y0 ?? 0);

  const minX = Math.max(0, Math.round(anchorX - 320));
  const maxX = Math.min(frameW, Math.round(anchorX + 320));
  const minY = Math.max(0, Math.round(anchorY - 320));
  const maxY = Math.min(3500, Math.round(anchorY + 320));

  // High-contrast wavelength channel selector embedded directly into plate toolbar and HUD
  const renderChannelButtons = () => {
    const has254 = Boolean(currentSet.imgs.UV254?.bmp);
    const has366 = Boolean(currentSet.imgs.UV366?.bmp);
    const hasWhite = Boolean(currentSet.imgs.White?.bmp);
    const canComposite = Boolean(has254 && has366);

    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          background: '#090d16',
          padding: '2px 4px',
          borderRadius: '6px',
          border: '1px solid #334155',
        }}
        title="Switch active plate wavelength channel"
      >
        <span style={{ fontSize: '10px', color: '#94a3b8', padding: '0 4px', fontWeight: 700 }}>
          Channel:
        </span>
        <button
          type="button"
          style={{
            ...hudBtn,
            padding: '3px 8px',
            fontSize: '11px',
            background: activeChannel === 'UV254' ? '#10b981' : has254 ? '#1e293b' : 'transparent',
            color: activeChannel === 'UV254' ? '#042f2e' : has254 ? '#e2e8f0' : '#64748b',
            borderColor: activeChannel === 'UV254' ? '#34d399' : '#475569',
            fontWeight: activeChannel === 'UV254' ? 800 : 600,
            opacity: has254 ? 1 : 0.45,
            cursor: has254 ? 'pointer' : 'not-allowed',
          }}
          onClick={() => has254 && onSelectChannel('UV254')}
          title={has254 ? 'Short-wave UV 254 nm (Phosphor quenching with dark bands)' : 'UV 254 nm not loaded'}
          disabled={!has254}
        >
          🟢 UV 254 nm
        </button>
        <button
          type="button"
          style={{
            ...hudBtn,
            padding: '3px 8px',
            fontSize: '11px',
            background: activeChannel === 'UV366' ? '#8b5cf6' : has366 ? '#1e293b' : 'transparent',
            color: activeChannel === 'UV366' ? '#ffffff' : has366 ? '#e2e8f0' : '#64748b',
            borderColor: activeChannel === 'UV366' ? '#a78bfa' : '#475569',
            fontWeight: activeChannel === 'UV366' ? 800 : 600,
            opacity: has366 ? 1 : 0.45,
            cursor: has366 ? 'pointer' : 'not-allowed',
          }}
          onClick={() => has366 && onSelectChannel('UV366')}
          title={has366 ? 'Long-wave UV 365 nm (Direct fluorescence emission glow)' : 'UV 365 nm not loaded'}
          disabled={!has366}
        >
          🟣 UV 365 nm (Fluo)
        </button>
        {hasWhite && (
          <button
            type="button"
            style={{
              ...hudBtn,
              padding: '3px 8px',
              fontSize: '11px',
              background: activeChannel === 'White' ? '#e2e8f0' : '#1e293b',
              color: activeChannel === 'White' ? '#0f172a' : '#e2e8f0',
              borderColor: activeChannel === 'White' ? '#cbd5e1' : '#475569',
              fontWeight: activeChannel === 'White' ? 800 : 600,
            }}
            onClick={() => onSelectChannel('White')}
            title="Visible white light photograph"
          >
            ⚪ Visible
          </button>
        )}
        {canComposite && (
          <button
            type="button"
            style={{
              ...hudBtn,
              padding: '3px 8px',
              fontSize: '11px',
              background: activeChannel === 'composite' ? '#0d9488' : '#134e4a',
              color: activeChannel === 'composite' ? '#ffffff' : '#5eead4',
              borderColor: activeChannel === 'composite' ? '#14b8a6' : '#0f766e',
              fontWeight: activeChannel === 'composite' ? 800 : 600,
            }}
            onClick={() => onSelectChannel('composite')}
            title="Dual-Channel Composite (blends UV254 quenching with UV365 fluorescence)"
          >
            ✨ Dual Composite
          </button>
        )}
      </div>
    );
  };

  // Render Full Plate Canvas (clears context, resets transform, and ensures leak-free drawing)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. Always reset any lingering transform to identity and clear the entire backing buffer
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!imgEntry?.bmp) {
      compositeCacheKeyRef.current = '';
      return;
    }

    const bmp = imgEntry.bmp;
    const maxDisplayW = Math.min(1200, containerRef.current?.clientWidth || 1000);
    const scale = maxDisplayW / bmp.width;
    const displayH = Math.round(bmp.height * scale);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(maxDisplayW * dpr);
    const targetH = Math.round(displayH * dpr);

    // Only resize canvas backing buffer if display width or DPR actually changes
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${maxDisplayW}px`;
      canvas.style.height = `${displayH}px`;
      // Resizing canvas resets 2D context; ensure transform is clean
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    ctx.save();
    try {
      ctx.scale(dpr * scale, dpr * scale);

      // Draw full plate bitmap with advanced dual composite rendering
      if (isComposite && currentSet.imgs.UV254?.bmp && currentSet.imgs.UV366?.bmp) {
        const bmp254 = currentSet.imgs.UV254.bmp;
        const bmp366 = currentSet.imgs.UV366.bmp;

        if (compositeSubMode === 'split') {
          // Mode 1: Split-Wavelength Wipe (Interactive Comparison Curtain)
          const splitX = Math.round(bmp254.width * splitPos);
          // Draw UV254 on left
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, splitX, bmp254.height);
          ctx.clip();
          ctx.drawImage(bmp254, 0, 0);
          ctx.restore();

          // Draw UV366 on right, normalized to bmp254 dimensions
          ctx.save();
          ctx.beginPath();
          ctx.rect(splitX, 0, bmp254.width - splitX, bmp254.height);
          ctx.clip();
          ctx.drawImage(bmp366, 0, 0, bmp254.width, bmp254.height);
          ctx.restore();

          // Draw vertical divider line & handle
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 2.5 / scale;
          ctx.moveTo(splitX, 0);
          ctx.lineTo(splitX, bmp254.height);
          ctx.stroke();

          const handleY = bmp254.height / 2;
          ctx.fillStyle = '#0f172a';
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.arc(splitX, handleY, 18 / scale, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#facc15';
          ctx.font = `bold ${Math.max(10, Math.round(13 / scale))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('◀ 254 | 365 ▶', splitX, handleY - 26 / scale);
          ctx.fillText('↔', splitX, handleY);
          ctx.restore();
        } else if (compositeSubMode === 'false-color') {
          // Mode 2: Multi-channel False Color (Amber = UV254 Quenching, Cyan = UV365 Fluorescence)
          const cacheKey = `${currentSet.uid}_fc_${bmp254.width}_${bmp254.height}_${fluoGain.toFixed(2)}`;
          if (compositeCacheKeyRef.current !== cacheKey || !compositeCacheCanvasRef.current) {
            if (!compositeCacheCanvasRef.current) {
              compositeCacheCanvasRef.current = document.createElement('canvas');
            }
            const cCanvas = compositeCacheCanvasRef.current;
            cCanvas.width = bmp254.width;
            cCanvas.height = bmp254.height;
            const cCtx = cCanvas.getContext('2d');
            if (cCtx) {
              cCtx.clearRect(0, 0, bmp254.width, bmp254.height);
              cCtx.drawImage(bmp254, 0, 0);
              const d254 = cCtx.getImageData(0, 0, bmp254.width, bmp254.height);
              cCtx.clearRect(0, 0, bmp254.width, bmp254.height);
              cCtx.drawImage(bmp366, 0, 0, bmp254.width, bmp254.height);
              const d366 = cCtx.getImageData(0, 0, bmp254.width, bmp254.height);

              const fcData = computeFalseColorComposite(d254.data, d366.data, bmp254.width, bmp254.height, fluoGain);
              const outImg = cCtx.createImageData(bmp254.width, bmp254.height);
              outImg.data.set(fcData);
              cCtx.putImageData(outImg, 0, 0);
              compositeCacheKeyRef.current = cacheKey;
            }
          }
          if (compositeCacheCanvasRef.current) {
            ctx.drawImage(compositeCacheCanvasRef.current, 0, 0);
          }
        } else {
          // Mode 3: Isolated Fluorescence Glow Overlay (Smart Background Subtraction)
          // 1. Draw the pure UV254 plate (green phosphor with dark quenching spots)
          ctx.drawImage(bmp254, 0, 0);

          // 2. Compute or retrieve background-subtracted fluorescent layer
          const cacheKey = `${currentSet.uid}_glow_${bmp254.width}_${bmp254.height}_${fluoThreshold.toFixed(2)}_${fluoGain.toFixed(2)}`;
          if (compositeCacheKeyRef.current !== cacheKey || !compositeCacheCanvasRef.current) {
            if (!compositeCacheCanvasRef.current) {
              compositeCacheCanvasRef.current = document.createElement('canvas');
            }
            const cCanvas = compositeCacheCanvasRef.current;
            cCanvas.width = bmp254.width;
            cCanvas.height = bmp254.height;
            const cCtx = cCanvas.getContext('2d');
            if (cCtx) {
              cCtx.clearRect(0, 0, bmp254.width, bmp254.height);
              cCtx.drawImage(bmp366, 0, 0, bmp254.width, bmp254.height);
              const d366 = cCtx.getImageData(0, 0, bmp254.width, bmp254.height);
              const glowData = extractFluorescenceOverlay(d366.data, bmp254.width, bmp254.height, fluoThreshold, fluoGain);
              const outImg = cCtx.createImageData(bmp254.width, bmp254.height);
              outImg.data.set(glowData);
              cCtx.putImageData(outImg, 0, 0);
              compositeCacheKeyRef.current = cacheKey;
            }
          }

          // 3. Overlay isolated fluorescence with screen blend without touching dark quenching spots
          if (compositeCacheCanvasRef.current) {
            ctx.save();
            ctx.globalAlpha = compositeBlend;
            ctx.globalCompositeOperation = 'screen';
            ctx.drawImage(compositeCacheCanvasRef.current, 0, 0);
            ctx.restore();
          }
        }
      } else {
        compositeCacheKeyRef.current = '';
        ctx.drawImage(bmp, 0, 0);
      }

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

      // In-Plate Spot Centroids & Rf Annotations
      if (showRfBadges && getProfile) {
        const spotChannel: TlcChannelKey = isComposite
          ? (currentSet.imgs.UV254 ? 'UV254' : 'UV366')
          : (activeChannel as TlcChannelKey);
        if (currentSet.imgs[spotChannel]) {
          const prof = getProfile(currentSet, spotChannel, l);
          if (prof && prof.length > 0) {
            const oVal = tlcOrigin(currentSet, l, getProfile as any);
            const fVal = tlcFront(currentSet, l, getProfile);
            const spots = findSpots(prof, {
              sign: TLC_SIGNAL[spotChannel]?.sign ?? -1,
              origin: oVal,
              front: fVal,
              radius: l.spotRadius || 24,
            });

            if (spots && spots.length > 0) {
              const spanDist = frontDist - originDist;
              spots.forEach((sp) => {
                const spotY = -(originDist + sp.rf * spanDist);
                const markerW = isSelected ? Math.min(w * 0.95, 34 / scale) : Math.min(w * 0.75, 20 / scale);

                // Horizontal centerline tick
                ctx.beginPath();
                ctx.moveTo(-markerW / 2, spotY);
                ctx.lineTo(markerW / 2, spotY);
                ctx.strokeStyle = isSelected ? '#38bdf8' : isHovered ? '#ec4899' : 'rgba(56, 189, 248, 0.75)';
                ctx.lineWidth = (isSelected ? 2.5 : 1.5) / scale;
                ctx.stroke();

                // Centroid micro-dot
                ctx.beginPath();
                ctx.arc(0, spotY, (isSelected ? 3.5 : 2) / scale, 0, Math.PI * 2);
                ctx.fillStyle = isSelected ? '#38bdf8' : isHovered ? '#ec4899' : '#38bdf8';
                ctx.fill();

                // High-contrast Rf badge on selected or hovered lane
                if (isSelected || isHovered) {
                  const rfStr = `Rf ${sp.rf.toFixed(2)}`;
                  ctx.font = `bold ${Math.max(10, Math.round(12 / scale))}px monospace`;
                  const textMetrics = ctx.measureText(rfStr);
                  const badgeW = textMetrics.width + 8 / scale;
                  const badgeH = 15 / scale;
                  const badgeX = w / 2 + 4 / scale;
                  const badgeY = spotY - badgeH / 2;

                  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
                  ctx.strokeStyle = isSelected ? '#38bdf8' : '#ec4899';
                  ctx.lineWidth = 1 / scale;
                  ctx.beginPath();
                  if ((ctx as any).roundRect) {
                    (ctx as any).roundRect(badgeX, badgeY, badgeW, badgeH, 3 / scale);
                  } else {
                    ctx.rect(badgeX, badgeY, badgeW, badgeH);
                  }
                  ctx.fill();
                  ctx.stroke();

                  // Connecting guide line
                  ctx.beginPath();
                  ctx.moveTo(markerW / 2, spotY);
                  ctx.lineTo(badgeX, spotY);
                  ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
                  ctx.lineWidth = 1 / scale;
                  ctx.stroke();

                  // Text label
                  ctx.fillStyle = isSelected ? '#38bdf8' : '#f472b6';
                  ctx.textAlign = 'left';
                  ctx.textBaseline = 'middle';
                  ctx.fillText(rfStr, badgeX + 4 / scale, spotY);
                }
              });
            }
          }
        }
      }

      ctx.restore();
    });
    } finally {
      ctx.restore();
    }
  }, [
    imgEntry,
    lanes,
    frameW,
    hoveredLaneId,
    selectedLaneId,
    currentSet,
    getProfile,
    showRfBadges,
    isComposite,
    compositeBlend,
    compositeSubMode,
    fluoThreshold,
    fluoGain,
    splitPos,
    activeChannel,
  ]);

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

    // Handle dragging the split-wipe comparison divider line
    if (isDraggingSplit && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseFrac = (e.clientX - rect.left) / rect.width;
      setSplitPos(Math.max(0.02, Math.min(0.98, +mouseFrac.toFixed(3))));
      return;
    }

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
    // Check if user clicked near the split wipe curtain handle
    if (isComposite && compositeSubMode === 'split' && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseFrac = (e.clientX - rect.left) / rect.width;
      if (Math.abs(mouseFrac - splitPos) < 0.05 || e.altKey) {
        setIsDraggingSplit(true);
        setSplitPos(Math.max(0.02, Math.min(0.98, +mouseFrac.toFixed(3))));
        return;
      }
    }

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
    setIsDraggingSplit(false);
    dragStartRef.current = null;
  };

  const handleMouseLeave = () => {
    setHoveredLaneId(null);
    setMousePos(null);
    setIsDragging(false);
    setIsDraggingSplit(false);
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
            position: hudPosition === 'top' ? 'sticky' : 'fixed',
            top: hudPosition === 'top' ? '56px' : undefined,
            bottom: hudPosition === 'bottom' ? '14px' : undefined,
            left: hudPosition === 'bottom' ? '50%' : undefined,
            transform: hudPosition === 'bottom' ? 'translateX(-50%)' : undefined,
            width: hudPosition === 'bottom' ? 'min(1200px, calc(100vw - 32px))' : '100%',
            maxWidth: '1200px',
            marginBottom: hudPosition === 'top' ? '12px' : '0px',
            padding: isHudCollapsed ? '10px 16px' : '14px 18px',
            background: 'rgba(15, 23, 42, 0.96)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderRadius: '12px',
            border: '2px solid #facc15',
            boxShadow: '0 12px 36px rgba(0,0,0,0.65)',
            color: '#f8fafc',
            display: 'flex',
            flexDirection: 'column',
            gap: isHudCollapsed ? '0px' : '12px',
            zIndex: 70,
            transition: 'padding 0.15s ease',
          }}
        >
          {/* Top Bar: Lane Identity, Well Formula, Dock/Collapse & Actions */}
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

            {/* Right Action Cluster: Channel Switcher, Dock toggle, Collapse, Undo, Reset Lane, Reset All, Inspect Modal, Export, Done */}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Channel Selector */}
              {renderChannelButtons()}

              {/* Dock Position Toggle */}
              <button
                type="button"
                style={{
                  ...hudBtn,
                  background: hudPosition === 'bottom' ? '#0f766e' : '#1e293b',
                  color: hudPosition === 'bottom' ? '#a7f3d0' : '#cbd5e1',
                  borderColor: hudPosition === 'bottom' ? '#14b8a6' : '#475569',
                }}
                onClick={() => setHudPosition((pos) => (pos === 'top' ? 'bottom' : 'top'))}
                title={hudPosition === 'top' ? 'Pin HUD to bottom of screen' : 'Pin HUD to top of screen'}
              >
                {hudPosition === 'top' ? '📌 Dock Bottom' : '📌 Dock Top'}
              </button>

              {/* Rf Badges & Spot Annotations Toggle */}
              <button
                type="button"
                style={{
                  ...hudBtn,
                  background: showRfBadges ? '#0284c7' : '#1e293b',
                  color: showRfBadges ? '#ffffff' : '#94a3b8',
                  borderColor: showRfBadges ? '#0369a1' : '#475569',
                }}
                onClick={() => setShowRfBadges((s) => !s)}
                title="Toggle on-plate spot centroid ticks and numerical Rf badges"
              >
                {showRfBadges ? '🏷️ Rf Badges ON' : '🏷️ Rf Badges OFF'}
              </button>

              {/* Global Skew (All 54 Lanes) */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  background: '#0f172a',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid #334155',
                }}
                title="Rotate all 54 lanes uniformly (e.g. for slightly tilted physical plates)"
              >
                <span style={{ fontSize: '10px', color: '#cbd5e1', fontWeight: 600 }}>Global Skew:</span>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 5px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(-0.2)}
                  title="Rotate all 54 lanes counter-clockwise by -0.2°"
                >
                  ↺ -0.2°
                </button>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 5px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(+0.2)}
                  title="Rotate all 54 lanes clockwise by +0.2°"
                >
                  +0.2° ↻
                </button>
              </div>

              {/* Dual-Channel Multi-Mode Composite Controls */}
              {isComposite && (
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: '#042f2e',
                    padding: '3px 8px',
                    borderRadius: '6px',
                    border: '1px solid #0f766e',
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Mode Tabs */}
                  <div style={{ display: 'inline-flex', gap: '2px', background: '#0f172a', padding: '2px', borderRadius: '4px' }}>
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        padding: '2px 6px',
                        fontSize: '10px',
                        background: compositeSubMode === 'glow' ? '#0d9488' : 'transparent',
                        borderColor: compositeSubMode === 'glow' ? '#14b8a6' : 'transparent',
                        color: compositeSubMode === 'glow' ? '#fff' : '#94a3b8',
                      }}
                      onClick={() => setCompositeSubMode('glow')}
                      title="Background-subtracted fluorescence glow overlaid on UV254 quenching plate"
                    >
                      ✨ Glow Overlay
                    </button>
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        padding: '2px 6px',
                        fontSize: '10px',
                        background: compositeSubMode === 'false-color' ? '#0d9488' : 'transparent',
                        borderColor: compositeSubMode === 'false-color' ? '#14b8a6' : 'transparent',
                        color: compositeSubMode === 'false-color' ? '#fff' : '#94a3b8',
                      }}
                      onClick={() => setCompositeSubMode('false-color')}
                      title="False-color dual channel (Amber = UV254 Quenching, Cyan = UV365 Fluorescence)"
                    >
                      🔬 False-Color
                    </button>
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        padding: '2px 6px',
                        fontSize: '10px',
                        background: compositeSubMode === 'split' ? '#0d9488' : 'transparent',
                        borderColor: compositeSubMode === 'split' ? '#14b8a6' : 'transparent',
                        color: compositeSubMode === 'split' ? '#fff' : '#94a3b8',
                      }}
                      onClick={() => setCompositeSubMode('split')}
                      title="Interactive draggable comparison curtain comparing UV254 and UV365 side-by-side"
                    >
                      ↔ Split Wipe
                    </button>
                  </div>

                  {/* Mode-Specific Fine Controls */}
                  {compositeSubMode === 'glow' && (
                    <>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Ambient background cutoff: filters out chamber light so only true fluorescence is overlaid">
                        <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Cutoff:</span>
                        <input
                          type="range"
                          min={0.05}
                          max={0.40}
                          step={0.01}
                          value={fluoThreshold}
                          onChange={(e) => setFluoThreshold(+e.target.value)}
                          style={{ ...hudSliderTrack, width: '45px', accentColor: '#14b8a6' }}
                        />
                        <span className="mono" style={{ fontSize: '10px', color: '#5eead4' }}>{Math.round(fluoThreshold * 100)}%</span>
                      </div>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Fluorescence glow intensity boost">
                        <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Boost:</span>
                        <input
                          type="range"
                          min={1.0}
                          max={2.8}
                          step={0.1}
                          value={fluoGain}
                          onChange={(e) => setFluoGain(+e.target.value)}
                          style={{ ...hudSliderTrack, width: '45px', accentColor: '#10b981' }}
                        />
                        <span className="mono" style={{ fontSize: '10px', color: '#34d399' }}>{fluoGain.toFixed(1)}×</span>
                      </div>
                    </>
                  )}

                  {compositeSubMode === 'false-color' && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '10px', color: '#fbbf24' }}>🟡 Quench</span>
                      <span style={{ fontSize: '10px', color: '#38bdf8' }}>🔵 Fluo</span>
                      <span style={{ fontSize: '10px', color: '#a7f3d0', marginLeft: '4px' }}>Gain:</span>
                      <input
                        type="range"
                        min={0.8}
                        max={2.5}
                        step={0.1}
                        value={fluoGain}
                        onChange={(e) => setFluoGain(+e.target.value)}
                        style={{ ...hudSliderTrack, width: '45px', accentColor: '#06b6d4' }}
                      />
                    </div>
                  )}

                  {compositeSubMode === 'split' && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Wipe divider position (or click & drag the divider line on the canvas)">
                      <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Wipe:</span>
                      <input
                        type="range"
                        min={0.02}
                        max={0.98}
                        step={0.01}
                        value={splitPos}
                        onChange={(e) => setSplitPos(+e.target.value)}
                        style={{ ...hudSliderTrack, width: '55px', accentColor: '#facc15' }}
                      />
                      <span className="mono" style={{ fontSize: '10px', color: '#fef08a' }}>{Math.round(splitPos * 100)}%</span>
                    </div>
                  )}
                </div>
              )}

              {/* Collapse / Expand Toggle */}
              <button
                type="button"
                style={{ ...hudBtn, background: '#1e293b', color: '#cbd5e1', borderColor: '#475569' }}
                onClick={() => setIsHudCollapsed((c) => !c)}
                title={isHudCollapsed ? 'Expand all sliders' : 'Minimize to compact toolbar'}
              >
                {isHudCollapsed ? '▲ Expand Sliders' : '▼ Minimize'}
              </button>

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

              {/* Invert All Upper Tier Lanes (Side 2) */}
              {selectedSide === 1 && (
                <button
                  type="button"
                  style={{ ...hudBtn, background: '#1e293b', color: '#38bdf8', borderColor: '#0284c7' }}
                  onClick={() => {
                    if (onSnapshotHistory) onSnapshotHistory();
                    lanes.forEach((l) => {
                      if (l.id >= 27) {
                        const th = (l.angle * Math.PI) / 180;
                        const endX = Math.round(l.x0 + l.length * Math.sin(th));
                        const endY = Math.round(l.y0 - l.length * Math.cos(th));
                        const isOpp = Math.abs(l.angle) > 90;
                        const newAngle = isOpp
                          ? +((l.angle - (l.angle > 0 ? 180 : -180))).toFixed(2)
                          : +((l.angle + 180)).toFixed(2);
                        onUpdateLane(l.id, { x0: endX, y0: endY, angle: newAngle });
                      }
                    });
                  }}
                  title="Invert migration direction of all 27 upper tier lanes (Side 2) together"
                >
                  ↕ Flip Upper Side (L27–53)
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

          {/* Minimized Quick Summary Bar */}
          {isHudCollapsed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
              <span>Shift X: <b style={{ color: '#fff' }}>{Math.round(selectedLane.x0)} px</b></span>
              <span>Shift Y: <b style={{ color: '#fff' }}>{Math.round(selectedLane.y0)} px</b></span>
              <span>Tilt: <b style={{ color: '#facc15' }}>{selectedLane.angle.toFixed(1)}°</b></span>
              <span>Origin: <b style={{ color: '#fbbf24' }}>{currentOriginVal} px</b></span>
              <span>Front: <b style={{ color: '#38bdf8' }}>{selectedSide === 1 ? frontSide1Val : frontSide0Val} px</b></span>
              <span>Width: <b style={{ color: '#c084fc' }}>{Math.round(selectedLane.width)} px</b></span>
              <span style={{ color: '#38bdf8' }}>| Arrow keys or drag on canvas to adjust live</span>
            </div>
          ) : (
            <>
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
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { x0: selectedLane.x0 - 1 });
                      }}
                      title="Shift left 1px (←)"
                    >
                      ◀ -1
                    </button>
                    <input
                      type="range"
                      min={minX}
                      max={maxX}
                      step={1}
                      value={Math.round(selectedLane.x0)}
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
                      onChange={(e) => onUpdateLane(selectedLane.id, { x0: +e.target.value })}
                      style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                      title="Smooth continuous Shift X slider"
                    />
                    <button
                      type="button"
                      style={hudBtn}
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { x0: selectedLane.x0 + 1 });
                      }}
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
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { y0: selectedLane.y0 - 1 });
                      }}
                      title="Shift up 1px (↑)"
                    >
                      ▲ -1
                    </button>
                    <input
                      type="range"
                      min={minY}
                      max={maxY}
                      step={1}
                      value={Math.round(selectedLane.y0)}
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
                      onChange={(e) => onUpdateLane(selectedLane.id, { y0: +e.target.value })}
                      style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                      title="Smooth continuous Shift Y slider"
                    />
                    <button
                      type="button"
                      style={hudBtn}
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { y0: selectedLane.y0 + 1 });
                      }}
                      title="Shift down 1px (↓)"
                    >
                      +1 ▼
                    </button>
                  </div>
                </div>

                {/* Tilt Angle Continuous Slider */}
                {(() => {
                  const isOpposingTilt = Math.abs(selectedLane.angle) > 90;
                  const baseAngle = isOpposingTilt ? (selectedLane.angle < 0 ? -180 : 180) : 0;
                  const tiltMin = +(baseAngle - 30).toFixed(1);
                  const tiltMax = +(baseAngle + 30).toFixed(1);

                  const handleFlipLane = () => {
                    if (onSnapshotHistory) onSnapshotHistory();
                    const th = (selectedLane.angle * Math.PI) / 180;
                    const endX = Math.round(selectedLane.x0 + selectedLane.length * Math.sin(th));
                    const endY = Math.round(selectedLane.y0 - selectedLane.length * Math.cos(th));
                    const newAngle = isOpposingTilt
                      ? +((selectedLane.angle - (selectedLane.angle > 0 ? 180 : -180))).toFixed(2)
                      : +((selectedLane.angle + 180)).toFixed(2);
                    onUpdateLane(selectedLane.id, {
                      x0: endX,
                      y0: endY,
                      angle: newAngle,
                    });
                  };

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#facc15', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <span>Tilt Angle:</span>
                          <span style={{ fontSize: '9px', background: isOpposingTilt ? '#7c2d12' : '#1e3a5f', color: isOpposingTilt ? '#fdba74' : '#93c5fd', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                            {isOpposingTilt ? '↕ Inverted / Downward' : '↑ Upward'}
                          </span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <button
                            type="button"
                            style={{
                              ...hudBtn,
                              padding: '1px 6px',
                              fontSize: '10px',
                              background: '#1e293b',
                              color: '#38bdf8',
                              borderColor: '#0284c7',
                            }}
                            onClick={handleFlipLane}
                            title="Flip lane direction 180° (flips between upward and downward development without shifting lane)"
                          >
                            ↕ Flip 180°
                          </button>
                          <span className="mono" style={{ fontSize: '12px', fontWeight: 800, color: '#facc15', background: '#0f172a', padding: '1px 6px', borderRadius: '3px', border: '1px solid #b45309' }}>
                            {selectedLane.angle >= 0 ? '+' : ''}{selectedLane.angle.toFixed(1)}°
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <button
                          type="button"
                          style={{ ...hudBtn, padding: '3px 5px', fontSize: '10px' }}
                          onClick={() => {
                            if (onSnapshotHistory) onSnapshotHistory();
                            onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle - 1.0).toFixed(2) });
                          }}
                          title="Rotate counter-clockwise 1.0° (Shift+Q)"
                        >
                          -1°
                        </button>
                        <button
                          type="button"
                          style={hudBtn}
                          onClick={() => {
                            if (onSnapshotHistory) onSnapshotHistory();
                            onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle - 0.2).toFixed(2) });
                          }}
                          title="Rotate counter-clockwise 0.2° (Q)"
                        >
                          ↺ -0.2°
                        </button>
                        <input
                          type="range"
                          min={tiltMin}
                          max={tiltMax}
                          step={0.1}
                          value={selectedLane.angle}
                          onPointerDown={onSnapshotHistory}
                          onMouseDown={onSnapshotHistory}
                          onChange={(e) => onUpdateLane(selectedLane.id, { angle: parseFloat((+e.target.value).toFixed(2)) })}
                          style={{ ...hudSliderTrack, flex: 1, accentColor: '#facc15' }}
                          title={`Smooth continuous Tilt Angle slider (${tiltMin}° to ${tiltMax}°)`}
                        />
                        <button
                          type="button"
                          style={hudBtn}
                          onClick={() => {
                            if (onSnapshotHistory) onSnapshotHistory();
                            onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle + 0.2).toFixed(2) });
                          }}
                          title="Rotate clockwise 0.2° (E)"
                        >
                          +0.2° ↻
                        </button>
                        <button
                          type="button"
                          style={{ ...hudBtn, padding: '3px 5px', fontSize: '10px' }}
                          onClick={() => {
                            if (onSnapshotHistory) onSnapshotHistory();
                            onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle + 1.0).toFixed(2) });
                          }}
                          title="Rotate clockwise 1.0° (Shift+E)"
                        >
                          +1°
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* ROW 2: Chromatography Dimensions & Meniscus Sliders */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
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
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { zeroRf: Math.max(5, currentOriginVal - 1) });
                      }}
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
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
                      onChange={(e) => onUpdateLane(selectedLane.id, { zeroRf: +e.target.value })}
                      style={{ ...hudSliderTrack, flex: 1, accentColor: '#fbbf24' }}
                      title="Smooth continuous Origin Baseline slider"
                    />
                    <button
                      type="button"
                      style={hudBtn}
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { zeroRf: currentOriginVal + 1 });
                      }}
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
                        if (onSnapshotHistory) onSnapshotHistory();
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
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
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
                        if (onSnapshotHistory) onSnapshotHistory();
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
                        if (onSnapshotHistory) onSnapshotHistory();
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
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
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
                        if (onSnapshotHistory) onSnapshotHistory();
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
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { width: Math.max(8, selectedLane.width - 1) });
                      }}
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
                      onPointerDown={onSnapshotHistory}
                      onMouseDown={onSnapshotHistory}
                      onChange={(e) => onUpdateLane(selectedLane.id, { width: +e.target.value })}
                      style={{ ...hudSliderTrack, flex: 1, accentColor: '#c084fc' }}
                      title="Smooth continuous Lane Width slider"
                    />
                    <button
                      type="button"
                      style={hudBtn}
                      onClick={() => {
                        if (onSnapshotHistory) onSnapshotHistory();
                        onUpdateLane(selectedLane.id, { width: selectedLane.width + 1 });
                      }}
                      title="Widen lane 1px"
                    >
                      +1
                    </button>
                  </div>
                </div>
              </div>

              {/* Interactive Well Recipe Preview Card */}
              {selectedRow ? (
                <div
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: '#facc15' }}>
                        🧪 Well {wellLabel(selectedWell!)} Recipe
                      </span>
                      <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                        (Reaction #{selectedRow.global_index + 1})
                      </span>
                    </div>
                    {selectedRow['vol#solvent'] != null && (
                      <span style={{ fontSize: '11px', color: '#cbd5e1' }}>
                        Solvent Volume: <b style={{ color: '#38bdf8' }}>{Number(selectedRow['vol#solvent']).toFixed(1)} µL</b>
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {selectedRow.recipe
                      .filter((rc: any) => rc.target_concentration > 0)
                      .map((rc: any) => (
                        <div
                          key={rc.code}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            background: '#0f172a',
                            border: `1px solid ${rc.color || '#475569'}`,
                            borderRadius: '4px',
                            padding: '3px 8px',
                            fontSize: '11px',
                          }}
                        >
                          <span
                            style={{
                              width: '7px',
                              height: '7px',
                              borderRadius: '50%',
                              background: rc.color || '#38bdf8',
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ fontWeight: 700, color: '#f8fafc' }}>{rc.code}:</span>
                          <span style={{ color: '#cbd5e1', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rc.name}>
                            {rc.name}
                          </span>
                          <span className="mono" style={{ color: '#38bdf8', fontWeight: 700 }}>
                            {rc.target_concentration.toFixed(1)} mM
                          </span>
                          {rc.transfer_volume != null && (
                            <span style={{ color: '#94a3b8', fontSize: '10px' }}>
                              ({Number(rc.transfer_volume).toFixed(1)} µL)
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {/* Keyboard & Mouse Guide */}
              <div style={{ fontSize: '11px', color: '#94a3b8', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
                <span>⚡ <b>Controls:</b> Drag continuous sliders for smooth real-time scrubbing</span>
                <span>⌨️ Arrow keys (<span className="mono">← → ↑ ↓</span>) nudge position</span>
                <span><span className="mono">Q / E</span> tilt angle</span>
                <span><span className="mono">Shift</span> 5× step</span>
                <span><span className="mono">Ctrl+Z</span> undo</span>
                <span style={{ color: '#38bdf8' }}>🖱️ Or click &amp; drag the lane directly on the canvas!</span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            position: 'sticky',
            top: '56px',
            zIndex: 40,
            width: '100%',
            maxWidth: '1200px',
            marginBottom: '10px',
            padding: '10px 16px',
            background: 'rgba(15, 23, 42, 0.94)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderRadius: '8px',
            border: '1px solid #475569',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            color: '#f8fafc',
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

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Channel Selector */}
            {renderChannelButtons()}

            {/* Rf Badges Toggle */}
            <button
              type="button"
              style={{
                ...hudBtn,
                background: showRfBadges ? '#0284c7' : '#1e293b',
                color: showRfBadges ? '#ffffff' : '#94a3b8',
                borderColor: showRfBadges ? '#0369a1' : '#475569',
              }}
              onClick={() => setShowRfBadges((s) => !s)}
              title="Toggle on-plate spot centroid ticks and numerical Rf badges"
            >
              {showRfBadges ? '🏷️ Rf Badges ON' : '🏷️ Rf Badges OFF'}
            </button>

            {/* Global Skew Controls */}
            {lanes.length > 0 && onUpdateLane && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  background: 'rgba(0,0,0,0.25)',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
                title="Rotate all 54 lanes uniformly (e.g. for slightly tilted physical plates)"
              >
                <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Global Skew:</span>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(-0.2)}
                  title="Rotate all 54 lanes counter-clockwise by -0.2°"
                >
                  ↺ -0.2°
                </button>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(+0.2)}
                  title="Rotate all 54 lanes clockwise by +0.2°"
                >
                  +0.2° ↻
                </button>
              </div>
            )}

            {/* Dual-Channel Multi-Mode Composite Controls */}
            {isComposite && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'rgba(4, 47, 46, 0.85)',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  border: '1px solid #0f766e',
                  flexWrap: 'wrap',
                }}
              >
                {/* Mode Tabs */}
                <div style={{ display: 'inline-flex', gap: '2px', background: '#0f172a', padding: '2px', borderRadius: '4px' }}>
                  <button
                    type="button"
                    style={{
                      ...hudBtn,
                      padding: '2px 6px',
                      fontSize: '10px',
                      background: compositeSubMode === 'glow' ? '#0d9488' : 'transparent',
                      borderColor: compositeSubMode === 'glow' ? '#14b8a6' : 'transparent',
                      color: compositeSubMode === 'glow' ? '#fff' : '#94a3b8',
                    }}
                    onClick={() => setCompositeSubMode('glow')}
                    title="Background-subtracted fluorescence glow overlaid on UV254 quenching plate"
                  >
                    ✨ Glow Overlay
                  </button>
                  <button
                    type="button"
                    style={{
                      ...hudBtn,
                      padding: '2px 6px',
                      fontSize: '10px',
                      background: compositeSubMode === 'false-color' ? '#0d9488' : 'transparent',
                      borderColor: compositeSubMode === 'false-color' ? '#14b8a6' : 'transparent',
                      color: compositeSubMode === 'false-color' ? '#fff' : '#94a3b8',
                    }}
                    onClick={() => setCompositeSubMode('false-color')}
                    title="False-color dual channel (Amber = UV254 Quenching, Cyan = UV365 Fluorescence)"
                  >
                    🔬 False-Color
                  </button>
                  <button
                    type="button"
                    style={{
                      ...hudBtn,
                      padding: '2px 6px',
                      fontSize: '10px',
                      background: compositeSubMode === 'split' ? '#0d9488' : 'transparent',
                      borderColor: compositeSubMode === 'split' ? '#14b8a6' : 'transparent',
                      color: compositeSubMode === 'split' ? '#fff' : '#94a3b8',
                    }}
                    onClick={() => setCompositeSubMode('split')}
                    title="Interactive comparison curtain comparing UV254 and UV365 side-by-side"
                  >
                    ↔ Split Wipe
                  </button>
                </div>

                {/* Sub-mode Controls */}
                {compositeSubMode === 'glow' && (
                  <>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Ambient background cutoff: filters out chamber light so only true fluorescence is overlaid">
                      <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Cutoff:</span>
                      <input
                        type="range"
                        min={0.05}
                        max={0.40}
                        step={0.01}
                        value={fluoThreshold}
                        onChange={(e) => setFluoThreshold(+e.target.value)}
                        style={{ ...hudSliderTrack, width: '45px', accentColor: '#14b8a6' }}
                      />
                      <span className="mono" style={{ fontSize: '10px', color: '#5eead4' }}>{Math.round(fluoThreshold * 100)}%</span>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="Fluorescence glow intensity boost">
                      <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Boost:</span>
                      <input
                        type="range"
                        min={1.0}
                        max={2.8}
                        step={0.1}
                        value={fluoGain}
                        onChange={(e) => setFluoGain(+e.target.value)}
                        style={{ ...hudSliderTrack, width: '45px', accentColor: '#10b981' }}
                      />
                      <span className="mono" style={{ fontSize: '10px', color: '#34d399' }}>{fluoGain.toFixed(1)}×</span>
                    </div>
                  </>
                )}

                {compositeSubMode === 'false-color' && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#fbbf24' }}>🟡 Quench</span>
                    <span style={{ fontSize: '10px', color: '#38bdf8' }}>🔵 Fluo</span>
                  </div>
                )}

                {compositeSubMode === 'split' && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Wipe:</span>
                    <input
                      type="range"
                      min={0.02}
                      max={0.98}
                      step={0.01}
                      value={splitPos}
                      onChange={(e) => setSplitPos(+e.target.value)}
                      style={{ ...hudSliderTrack, width: '55px', accentColor: '#facc15' }}
                    />
                    <span className="mono" style={{ fontSize: '10px', color: '#fef08a' }}>{Math.round(splitPos * 100)}%</span>
                  </div>
                )}
              </div>
            )}

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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8' }} />
              Spot Centroid &amp; Rf Badge
            </span>
            {isComposite && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#10b981' }}>
                <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: '#10b981' }} />
                {compositeSubMode === 'split'
                  ? 'Dual Split-Wavelength Wipe (◀ UV254 | UV365 ▶)'
                  : compositeSubMode === 'false-color'
                  ? 'Dual False-Color (🟡 Quenching + 🔵 Fluorescence)'
                  : 'Dual Isolated Glow (Background-Subtracted Fluorescence)'}
              </span>
            )}
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
            No {activeChannel === 'composite' ? 'Dual Composite (UV254 + UV365)' : activeChannel} Plate Image Loaded
          </div>
          <p style={{ fontSize: '13px', color: 'var(--mut)', margin: '0 0 16px' }}>
            Upload your laboratory TLC plate photograph (PNG, JPEG, WebP) or click below to load a synthetic demonstration plate.
          </p>
        </div>
      )}
    </div>
  );
};
