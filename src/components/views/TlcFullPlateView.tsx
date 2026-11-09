import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TlcSet, TlcLane, TlcSpot } from '../../types';
import {
  containerOfLane,
  wellLabel,
  tlcFront,
  tlcOrigin,
  TlcChannelKey,
  findSpots,
  getEffectiveLaneSpots,
  TLC_SIGNAL,
  extractFluorescenceOverlay,
  computeFalseColorComposite,
} from '../../engine';
import { EdgeFit, EdgeSetting, EdgePick, edgeActive, edgeGain, edgeOffset, correctSpots, edgeSuggestion } from '../../engine/tlcEdge';
import { TlcEdgePanel } from './TlcEdgePanel';

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
  spotProminence?: number;
  // Edge-effect spot picking: clicking a detected spot adds it to the current compound group
  pickMode?: boolean;
  picks?: { lane: number; pos: number; group: number }[];
  onPickSpot?: (laneId: number, pos: number) => void;
  // Edge-effect fits & settings for HUD integration
  edgeFits?: (EdgeFit | null)[];
  edgeSettings?: EdgeSetting[];
  onEdgeSetting?: (half: number, s: EdgeSetting) => void;
  onPickMode?: (on: boolean) => void;
  pickGroup?: number;
  onPickGroup?: (g: number) => void;
  onClearPicks?: () => void;
}

const PICK_COLORS = ['#f59e0b', '#22c55e', '#a855f7', '#ef4444', '#06b6d4', '#eab308'];

export type HudModule = 'geometry' | 'baselines' | 'spots' | 'edge' | 'composite' | 'recipe' | 'tools' | 'none';
export type OverviewModule = 'fronts' | 'edge' | 'composite' | 'skew' | 'none';

// Explicit high-contrast button styling for the HUD dark theme (longhand border avoids React shorthand conflict)
const hudBtn: React.CSSProperties = {
  background: '#1e293b',
  color: '#f8fafc',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: '#475569',
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
  spotProminence = 0.28,
  pickMode = false,
  picks = [],
  onPickSpot,
  edgeFits,
  edgeSettings,
  onEdgeSetting,
  onPickMode,
  pickGroup = 0,
  onPickGroup,
  onClearPicks,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [hoveredLaneId, setHoveredLaneId] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<number | null>(0);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  // Preview of the edge-effect correction: re-stretch the photo so same-compound spots line up
  const [straighten, setStraighten] = useState(false);

  // Modular HUD state: only the selected module's drawer is expanded, keeping HUD ultra-compact
  const [activeHudModule, setActiveHudModule] = useState<HudModule>('geometry');
  const [overviewModule, setOverviewModule] = useState<OverviewModule>('none');

  const isEdgeActive = edgeFits && edgeSettings ? edgeFits.some((f, h) => edgeActive(f, edgeSettings[h])) : false;

  // Auto-switch to edge module when user enters reference spot pick mode
  useEffect(() => {
    if (pickMode) {
      if (selectedLaneId !== null) {
        setActiveHudModule('edge');
      } else {
        setOverviewModule('edge');
      }
    }
  }, [pickMode, selectedLaneId]);

  // HUD layout states: fixed sticky top or fixed bottom dock
  const [hudPosition, setHudPosition] = useState<'top' | 'bottom'>('top');

  // Dragging state for moving lanes directly on canvas
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; x0: number; y0: number } | null>(null);

  // Spot dragging & interaction state (direct on-canvas Rf adjustment)
  const [isDraggingSpot, setIsDraggingSpot] = useState(false);
  const dragSpotRef = useRef<{
    laneId: number;
    spotIndex: number;
    startPos: number;
    startRf: number;
    originDist: number;
    spanDist: number;
    initialSpots: TlcSpot[];
  } | null>(null);
  const [hoveredSpotInfo, setHoveredSpotInfo] = useState<{
    laneId: number;
    spotIndex: number;
    spot: TlcSpot;
  } | null>(null);

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

  // Helper to extract effective spots for any lane (respecting lane.customSpots override)
  const getLaneEffectiveSpots = useCallback(
    (l: TlcLane): {
      spots: TlcSpot[];
      originDist: number;
      frontDist: number;
      spanDist: number;
      isCorrecting: boolean;
      gain: number;
      offset: number;
    } => {
      const oVal = tlcOrigin(currentSet, l, getProfile as any);
      const fVal = tlcFront(currentSet, l, getProfile);
      const span = Math.max(1, fVal - oVal);
      const spotChannel: TlcChannelKey = isComposite
        ? (currentSet.imgs.UV254 ? 'UV254' : 'UV366')
        : (activeChannel as TlcChannelKey);
      let autoSpots: TlcSpot[] = [];
      if (getProfile && currentSet.imgs[spotChannel]) {
        const prof = getProfile(currentSet, spotChannel, l);
        if (prof && prof.length > 0) {
          autoSpots = findSpots(prof, {
            sign: TLC_SIGNAL[spotChannel]?.sign ?? -1,
            origin: oVal,
            front: fVal,
            radius: l.spotRadius || 24,
            minProminence: spotProminence,
          });
        }
      }
      const baseSpots = getEffectiveLaneSpots(l, autoSpots);
      const half = l.id < 27 ? 0 : 1;
      const fit = edgeFits ? edgeFits[half] : null;
      const setting = edgeSettings ? edgeSettings[half] : null;
      const isCorrecting = edgeActive(fit, setting);
      const gain = isCorrecting && fit ? edgeGain(fit, l.x0, setting?.strength ?? 1) : 1;
      const offset = isCorrecting && fit ? edgeOffset(fit, l.x0, setting?.strength ?? 1) : 0;
      const spots = isCorrecting ? correctSpots(baseSpots, gain, offset) : baseSpots;
      return {
        spots,
        originDist: oVal,
        frontDist: fVal,
        spanDist: span,
        isCorrecting,
        gain,
        offset,
      };
    },
    [currentSet, getProfile, isComposite, activeChannel, spotProminence, edgeFits, edgeSettings]
  );

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

    // Straightened preview: each half of the plate is re-stretched strip by strip about its origin
    // line, dividing the distance run by g(x). A spot at h*g(x) lands at h, so spots of one compound
    // line up in a row when the correction is right.
    const straightHalf = [0, 1].map((h) => {
      const fit = edgeFits ? edgeFits[h] : null;
      const st = edgeSettings ? edgeSettings[h] : null;
      return straighten && fit && st && edgeActive(fit, st) ? { fit, strength: st.strength } : null;
    });
    if (straightHalf.some(Boolean)) {
      const k = dpr * scale; // canvas px per image px
      const src = document.createElement('canvas');
      src.width = canvas.width;
      src.height = canvas.height;
      const sctx = src.getContext('2d');
      if (sctx) {
        sctx.drawImage(canvas, 0, 0);
        [0, 1].forEach((h) => {
          const sh = straightHalf[h];
          if (!sh) return;
          const hl = lanes.filter((l) => (l.id < 27 ? 0 : 1) === h);
          if (!hl.length) return;
          const xs = hl.map((l) => l.x0);
          const xLo = Math.min(...xs);
          const xHi = Math.max(...xs);
          // origin line (image px) of the lane nearest to a strip, and the run direction
          const originOf = (l: TlcLane) => {
            const th = (l.angle * Math.PI) / 180;
            const o = tlcOrigin(currentSet, l, getProfile as any);
            return { y: (l.y0 - o * Math.cos(th)) * imgScale, up: Math.cos(th) > 0, len: l.length * imgScale };
          };
          const strip = 4; // image px
          const x0px = (xLo - 70) * imgScale;
          const x1px = (xHi + 70) * imgScale;
          for (let xp = Math.max(0, x0px); xp < Math.min(bmp.width, x1px); xp += strip) {
            const xf = (xp + strip / 2) / imgScale;
            const near = hl.reduce((a, b) => (Math.abs(b.x0 - xf) < Math.abs(a.x0 - xf) ? b : a));
            const { y: oy, up, len } = originOf(near);
            const xc = Math.min(xHi, Math.max(xLo, xf));
            const g = edgeGain(sh.fit, xc, sh.strength);
            const bOff = edgeOffset(sh.fit, xc, sh.strength);
            if (!(g > 0) || (Math.abs(g - 1) < 1e-4 && Math.abs(bOff) < 1e-4)) continue;
            const spanPx = Math.max(1, tlcFront(currentSet, near, getProfile) - tlcOrigin(currentSet, near, getProfile as any)) * imgScale;
            const offPx = bOff * spanPx; // additive part, image px toward the front
            // A spot at distance t from the origin line in the corrected photo comes from distance
            // t*g + offset in the original. dir = +1 when the run goes down the image, -1 when up.
            const dir = up ? -1 : 1;
            const srcA = up ? oy - offPx - len * g : oy + offPx;
            const srcB = up ? oy - offPx : oy + offPx + len * g;
            const a = Math.max(0, srcA);
            const b = Math.min(bmp.height, srcB);
            if (b - a < 2) continue;
            const dest = (ys: number) => oy + dir * ((dir * (ys - oy) - offPx) / g);
            const dA = dest(a);
            const dB = dest(b);
            if (!(dB - dA > 0)) continue;
            ctx.drawImage(src, xp * k, a * k, strip * k, (b - a) * k, xp, dA, strip, dB - dA);
          }
        });
      }
    }

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

      // In-Plate Spot Centroids & Rf Annotations (Supports interactive drag, manual/adjusted styling)
      if (showRfBadges && getProfile) {
        const { spots, originDist, spanDist, isCorrecting, gain, offset } = getLaneEffectiveSpots(l);
        if (spots && spots.length > 0) {
          const straightHere = straighten && isCorrecting;
          spots.forEach((sp, spIdx) => {
            const isDragged = isDraggingSpot && dragSpotRef.current?.laneId === l.id && dragSpotRef.current?.spotIndex === spIdx;
            const isHoveredSpot = hoveredSpotInfo?.laneId === l.id && hoveredSpotInfo?.spotIndex === spIdx;

            const correctedSpotY = -(originDist + sp.rf * spanDist);
            // In the straightened photo the spot itself has moved, so the marker follows it
            const rawSpotY = straightHere ? correctedSpotY : -(originDist + (sp.rfRaw ?? sp.rf) * spanDist);
            const markerW = isDragged
              ? Math.max(w * 0.98, 48 / scale)
              : isSelected
              ? Math.min(w * 0.95, 36 / scale)
              : Math.min(w * 0.75, 22 / scale);

            // Determine spot color & styling based on source (manual vs adjusted vs auto)
            const spotSource = sp.source || 'auto';
            const baseColor = isDragged
              ? '#facc15'
              : spotSource === 'manual'
              ? '#f59e0b'
              : spotSource === 'adjusted'
              ? '#a855f7'
              : isSelected
              ? '#38bdf8'
              : isHovered
              ? '#ec4899'
              : 'rgba(56, 189, 248, 0.85)';

            // If edge correction is active, draw the leveled alignment tick in emerald
            if (isCorrecting && !straightHere && sp.rfRaw != null && (Math.abs(gain - 1) >= 0.003 || Math.abs(offset) >= 0.002)) {
              ctx.beginPath();
              ctx.setLineDash([3 / scale, 3 / scale]);
              ctx.moveTo(-markerW / 2, correctedSpotY);
              ctx.lineTo(markerW / 2, correctedSpotY);
              ctx.strokeStyle = '#10b981';
              ctx.lineWidth = (isSelected ? 2.5 : 1.5) / scale;
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // If spot is actively dragged, draw glowing full-width cross-lane indicator
            if (isDragged) {
              ctx.save();
              ctx.shadowColor = '#facc15';
              ctx.shadowBlur = 10 / scale;
              ctx.beginPath();
              ctx.moveTo(-w / 2, rawSpotY);
              ctx.lineTo(w / 2, rawSpotY);
              ctx.strokeStyle = '#facc15';
              ctx.lineWidth = 3 / scale;
              ctx.stroke();
              ctx.restore();
            } else {
              // Horizontal tick at physical spot location
              ctx.beginPath();
              ctx.moveTo(-markerW / 2, rawSpotY);
              ctx.lineTo(markerW / 2, rawSpotY);
              ctx.strokeStyle = baseColor;
              ctx.lineWidth = (isHoveredSpot || isSelected ? 2.5 : 1.5) / scale;
              ctx.stroke();
            }

            // Draggable Centroid Grab Handle: distinct ring + inner dot
            const handleRadius = isDragged
              ? 6.5 / scale
              : isHoveredSpot
              ? 6 / scale
              : isSelected
              ? 4.2 / scale
              : 2.8 / scale;

            if (spotSource === 'manual' || spotSource === 'adjusted' || isHoveredSpot || isDragged) {
              // Draw provenance aura / grab target halo
              ctx.beginPath();
              ctx.arc(0, rawSpotY, handleRadius + 3 / scale, 0, Math.PI * 2);
              ctx.fillStyle = isDragged
                ? 'rgba(250, 204, 21, 0.45)'
                : spotSource === 'manual'
                ? 'rgba(245, 158, 11, 0.32)'
                : spotSource === 'adjusted'
                ? 'rgba(168, 85, 247, 0.32)'
                : 'rgba(56, 189, 248, 0.28)';
              ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(0, rawSpotY, handleRadius, 0, Math.PI * 2);
            ctx.fillStyle = isDragged ? '#facc15' : baseColor;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.3 / scale;
            ctx.stroke();

            // Spots picked as 'same compound' for edge correction
            const pk = picks.find((q) => q.lane === l.id && Math.abs(q.pos - sp.pos) < 6);
            if (pk) {
              const col = PICK_COLORS[pk.group % PICK_COLORS.length];
              ctx.beginPath();
              ctx.arc(0, rawSpotY, 9 / scale, 0, Math.PI * 2);
              ctx.strokeStyle = col;
              ctx.lineWidth = 2.5 / scale;
              ctx.stroke();
              ctx.fillStyle = col;
              ctx.font = `bold ${Math.max(10, Math.round(13 / scale))}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(String(pk.group + 1), 0, rawSpotY - 15 / scale);
            }

            // High-contrast Rf badge on selected, hovered, or actively manipulated spot
            if (isSelected || isHovered || isDragged || isHoveredSpot) {
              const sourceBadge = spotSource === 'manual' ? ' ✋' : spotSource === 'adjusted' ? ' ✨' : '';
              const rfStr = isCorrecting && sp.rfRaw != null && (Math.abs(gain - 1) >= 0.003 || Math.abs(offset) >= 0.002)
                ? `Rf ${sp.rf.toFixed(2)} (${sp.rfRaw.toFixed(2)})${sourceBadge}`
                : `Rf ${sp.rf.toFixed(2)}${sourceBadge}`;
              ctx.font = `bold ${Math.max(10, Math.round(12 / scale))}px monospace`;
              const textMetrics = ctx.measureText(rfStr);
              const badgeW = textMetrics.width + 8 / scale;
              const badgeH = 15 / scale;
              const badgeX = w / 2 + 4 / scale;
              const badgeY = (isCorrecting ? correctedSpotY : rawSpotY) - badgeH / 2;

              ctx.fillStyle = isDragged
                ? '#facc15'
                : 'rgba(15, 23, 42, 0.94)';
              ctx.strokeStyle = isDragged
                ? '#eab308'
                : spotSource === 'manual'
                ? '#f59e0b'
                : spotSource === 'adjusted'
                ? '#a855f7'
                : isSelected
                ? (isCorrecting ? '#10b981' : '#38bdf8')
                : '#ec4899';
              ctx.lineWidth = (isDragged ? 2 : 1) / scale;
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
              ctx.moveTo(markerW / 2, isCorrecting ? correctedSpotY : rawSpotY);
              ctx.lineTo(badgeX, isCorrecting ? correctedSpotY : rawSpotY);
              ctx.strokeStyle = isDragged
                ? '#facc15'
                : spotSource === 'manual'
                ? 'rgba(245, 158, 11, 0.6)'
                : spotSource === 'adjusted'
                ? 'rgba(168, 85, 247, 0.6)'
                : isCorrecting
                ? 'rgba(16, 185, 129, 0.5)'
                : 'rgba(56, 189, 248, 0.4)';
              ctx.lineWidth = 1 / scale;
              ctx.stroke();

              // Text label
              ctx.fillStyle = isDragged
                ? '#0f172a'
                : spotSource === 'manual'
                ? '#fde68a'
                : spotSource === 'adjusted'
                ? '#e9d5ff'
                : isSelected
                ? (isCorrecting ? '#a7f3d0' : '#38bdf8')
                : '#f472b6';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(rfStr, badgeX + 4 / scale, isCorrecting ? correctedSpotY : rawSpotY);
            }
          });
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
    picks,
    straighten,
    edgeFits,
    edgeSettings,
    spotProminence,
    getLaneEffectiveSpots,
    isDraggingSpot,
    hoveredSpotInfo,
  ]);

  // Find spot collision at mouse coordinates (for dragging, Alt+Click deletion, or tooltip)
  const findSpotAtPoint = useCallback(
    (clientX: number, clientY: number): {
      laneId: number;
      spotIndex: number;
      spot: TlcSpot;
      lane: TlcLane;
      originDist: number;
      spanDist: number;
    } | null => {
      const canvas = canvasRef.current;
      if (!canvas || !imgEntry?.bmp) return null;

      const rect = canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const scale = rect.width / imgEntry.bmp.width;
      const imgScale = imgEntry.bmp.width / frameW;

      // Check selected lane first for responsive priority, then all lanes
      const targetLanes: TlcLane[] = [];
      if (selectedLaneId !== null) {
        const sel = lanes.find((l) => l.id === selectedLaneId);
        if (sel) targetLanes.push(sel);
      }
      for (const l of lanes) {
        if (l.id !== selectedLaneId) targetLanes.push(l);
      }

      for (const l of targetLanes) {
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

        // Skip if far outside lane bounding box
        if (localX < -w / 2 - 16 || localX > w / 2 + 16 || localY < -len - 16 || localY > 16) {
          continue;
        }

        const { spots, originDist, spanDist, isCorrecting } = getLaneEffectiveSpots(l);
        const straightHere = straighten && isCorrecting;

        for (let i = 0; i < spots.length; i++) {
          const sp = spots[i];
          const spotDist = straightHere ? (originDist + sp.rf * spanDist) : (sp.rfRaw != null ? originDist + sp.rfRaw * spanDist : sp.pos);
          const spotY = -spotDist * imgScale * scale;

          const distToSpot = Math.hypot(localX, localY - spotY);
          // Grab radius of 16px minimum on screen for easy click & drag
          if (distToSpot <= Math.max(16, w * 0.45)) {
            return { laneId: l.id, spotIndex: i, spot: sp, lane: l, originDist, spanDist };
          }
        }
      }
      return null;
    },
    [imgEntry, frameW, lanes, selectedLaneId, getLaneEffectiveSpots, straighten]
  );

  // Spot management callbacks: Add, Delete, Reset, and Nudge
  const handleAddSpotToLane = useCallback(
    (laneId: number, targetRf: number = 0.5) => {
      if (!onUpdateLane) return;
      const lane = lanes.find((l) => l.id === laneId);
      if (!lane) return;
      if (onSnapshotHistory) onSnapshotHistory();
      const { spots, originDist, spanDist } = getLaneEffectiveSpots(lane);
      const clampedRf = Math.max(0, Math.min(1.0, targetRf));
      const pos = Math.round(originDist + clampedRf * spanDist);
      const newSpot: TlcSpot = {
        pos,
        rf: +clampedRf.toFixed(3),
        rfRaw: +clampedRf.toFixed(3),
        strength: 0.5,
        areaPct: 20,
        source: 'manual',
      };
      const nextSpots = [...spots, newSpot].sort((a, b) => a.pos - b.pos);
      onUpdateLane(laneId, { customSpots: nextSpots });
      setSelectedLaneId(laneId);
    },
    [lanes, onUpdateLane, onSnapshotHistory, getLaneEffectiveSpots]
  );

  const handleDeleteSpotFromLane = useCallback(
    (laneId: number, spotIndex: number) => {
      if (!onUpdateLane) return;
      const lane = lanes.find((l) => l.id === laneId);
      if (!lane) return;
      if (onSnapshotHistory) onSnapshotHistory();
      const { spots } = getLaneEffectiveSpots(lane);
      const remaining = spots.filter((_, idx) => idx !== spotIndex);
      onUpdateLane(laneId, { customSpots: remaining });
    },
    [lanes, onUpdateLane, onSnapshotHistory, getLaneEffectiveSpots]
  );

  const handleResetLaneSpotsToAuto = useCallback(
    (laneId: number) => {
      if (!onUpdateLane) return;
      if (onSnapshotHistory) onSnapshotHistory();
      onUpdateLane(laneId, { customSpots: undefined });
    },
    [onUpdateLane, onSnapshotHistory]
  );

  const handleNudgeSpotRf = useCallback(
    (laneId: number, spotIndex: number, deltaRf: number) => {
      if (!onUpdateLane) return;
      const lane = lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const { spots, originDist, spanDist } = getLaneEffectiveSpots(lane);
      if (!spots[spotIndex]) return;
      if (onSnapshotHistory) onSnapshotHistory();
      const targetRf = Math.max(0, Math.min(1.0, +(spots[spotIndex].rf + deltaRf).toFixed(3)));
      const pos = Math.round(originDist + targetRf * spanDist);
      const updated = spots.map((s, idx) => {
        if (idx === spotIndex) {
          return {
            ...s,
            pos,
            rf: targetRf,
            rfRaw: targetRf,
            source: (s.source === 'manual' ? 'manual' : 'adjusted') as 'manual' | 'adjusted',
          };
        }
        return s;
      });
      onUpdateLane(laneId, { customSpots: updated });
    },
    [lanes, onUpdateLane, onSnapshotHistory, getLaneEffectiveSpots]
  );

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

  // Mouse Move: update hover, handle on-canvas lane drag & spot centroid drag
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setMousePos({ x: e.clientX, y: e.clientY });

    // Handle dragging the split-wipe comparison divider line
    if (isDraggingSplit && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseFrac = (e.clientX - rect.left) / rect.width;
      setSplitPos(Math.max(0.02, Math.min(0.98, +mouseFrac.toFixed(3))));
      return;
    }

    // Handle dragging a spot along the lane trajectory
    if (isDraggingSpot && dragSpotRef.current && onUpdateLane && imgEntry?.bmp) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / imgEntry.bmp.width;
      const imgScale = imgEntry.bmp.width / frameW;
      const targetLane = lanes.find((l) => l.id === dragSpotRef.current!.laneId);
      if (targetLane) {
        const th = (targetLane.angle * Math.PI) / 180;
        const dx = e.clientX - rect.left - targetLane.x0 * imgScale * scale;
        const dy = e.clientY - rect.top - targetLane.y0 * imgScale * scale;
        const localY = dx * Math.sin(-th) + dy * Math.cos(-th);
        const dist = -localY / (imgScale * scale);
        const { originDist, spanDist, initialSpots, spotIndex, laneId } = dragSpotRef.current;
        const clampedDist = Math.max(originDist * 0.4, Math.min(targetLane.length * 1.05, dist));
        const rf = Math.max(0, Math.min(1.0, (clampedDist - originDist) / spanDist));

        const updatedSpots = initialSpots.map((s, idx) => {
          if (idx === spotIndex) {
            return {
              ...s,
              pos: Math.round(clampedDist),
              rf: +rf.toFixed(3),
              rfRaw: +rf.toFixed(3),
              source: (s.source === 'manual' ? 'manual' : 'adjusted') as 'manual' | 'adjusted',
            };
          }
          return s;
        });
        onUpdateLane(laneId, { customSpots: updatedSpots });
      }
      return;
    }

    // Handle dragging whole lane bounding box
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

    // Hit testing for spots and lanes
    const spotHit = findSpotAtPoint(e.clientX, e.clientY);
    setHoveredSpotInfo(spotHit);

    const hit = findLaneAtPoint(e.clientX, e.clientY);
    setHoveredLaneId(hit);

    // Update dynamic cursor
    if (canvasRef.current) {
      if (spotHit) {
        canvasRef.current.style.cursor = e.altKey ? 'pointer' : 'ns-resize';
      } else if (e.shiftKey && hit !== null) {
        canvasRef.current.style.cursor = 'crosshair';
      } else if (hit !== null) {
        canvasRef.current.style.cursor = 'move';
      } else {
        canvasRef.current.style.cursor = 'default';
      }
    }
  };

  // Mouse Down: select lane, start spot drag, add spot (Shift), delete spot (Alt), or drag lane
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

    // Pick mode: a click picks the detected spot nearest to the click, and never moves a lane
    if (pickMode) {
      const l = hit !== null ? lanes.find((q) => q.id === hit) : undefined;
      const canvas = canvasRef.current;
      if (l && canvas && imgEntry?.bmp && getProfile && onPickSpot) {
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width / imgEntry.bmp.width;
        const imgScale = imgEntry.bmp.width / frameW;
        const th = (l.angle * Math.PI) / 180;
        const dx = e.clientX - rect.left - l.x0 * imgScale * scale;
        const dy = e.clientY - rect.top - l.y0 * imgScale * scale;
        const localY = dx * Math.sin(-th) + dy * Math.cos(-th);
        const dist = -localY / (imgScale * scale); // px along the lane, from its start
        const ch: TlcChannelKey = isComposite
          ? (currentSet.imgs.UV254 ? 'UV254' : 'UV366')
          : (activeChannel as TlcChannelKey);
        const prof = currentSet.imgs[ch] ? getProfile(currentSet, ch, l) : [];
        if (prof && prof.length) {
          const { spots } = getLaneEffectiveSpots(l);
          let best: (typeof spots)[number] | null = null;
          for (const sp of spots) {
            if (!best || Math.abs(sp.pos - dist) < Math.abs(best.pos - dist)) best = sp;
          }
          if (best && Math.abs(best.pos - dist) <= Math.max(20, (l.spotRadius || 24) * 0.9)) {
            onPickSpot(l.id, best.pos);
          }
        }
      }
      return;
    }

    // Spot-specific interactions when NOT in edge pick mode:
    const spotHit = findSpotAtPoint(e.clientX, e.clientY);
    if (spotHit) {
      if (e.altKey) {
        // Alt+Click: Delete this picked spot!
        handleDeleteSpotFromLane(spotHit.laneId, spotHit.spotIndex);
        setSelectedLaneId(spotHit.laneId);
        return;
      }

      // Click on spot centroid: start sliding / dragging spot along the lane
      if (onSnapshotHistory) onSnapshotHistory();
      setIsDraggingSpot(true);
      setSelectedLaneId(spotHit.laneId);
      const { spots, originDist, spanDist } = getLaneEffectiveSpots(spotHit.lane);
      dragSpotRef.current = {
        laneId: spotHit.laneId,
        spotIndex: spotHit.spotIndex,
        startPos: spotHit.spot.pos,
        startRf: spotHit.spot.rf,
        originDist,
        spanDist,
        initialSpots: [...spots],
      };
      return;
    }

    // Shift + Click on a lane: Drop a new manual spot at clicked location
    if (e.shiftKey && hit !== null && canvasRef.current && imgEntry?.bmp && onUpdateLane) {
      const target = lanes.find((l) => l.id === hit);
      if (target) {
        const rect = canvasRef.current.getBoundingClientRect();
        const scale = rect.width / imgEntry.bmp.width;
        const imgScale = imgEntry.bmp.width / frameW;
        const th = (target.angle * Math.PI) / 180;
        const dx = e.clientX - rect.left - target.x0 * imgScale * scale;
        const dy = e.clientY - rect.top - target.y0 * imgScale * scale;
        const localY = dx * Math.sin(-th) + dy * Math.cos(-th);
        const dist = -localY / (imgScale * scale);
        const { originDist, spanDist } = getLaneEffectiveSpots(target);
        const rf = Math.max(0, Math.min(1.0, (dist - originDist) / spanDist));
        handleAddSpotToLane(target.id, rf);
        setActiveHudModule('spots');
        return;
      }
    }

    // Standard lane selection and whole-lane dragging
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
    setIsDraggingSpot(false);
    dragStartRef.current = null;
    dragSpotRef.current = null;
  };

  const handleMouseLeave = () => {
    setHoveredLaneId(null);
    setHoveredSpotInfo(null);
    setMousePos(null);
    setIsDragging(false);
    setIsDraggingSplit(false);
    setIsDraggingSpot(false);
    dragStartRef.current = null;
    dragSpotRef.current = null;
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

  const selectedLaneEffective = selectedLane ? getLaneEffectiveSpots(selectedLane) : null;
  const selectedLaneSpots = selectedLaneEffective?.spots || [];
  const selectedLaneManualCount = selectedLaneSpots.filter((s) => s.source === 'manual').length;
  const selectedLaneAdjustedCount = selectedLaneSpots.filter((s) => s.source === 'adjusted').length;

  const cssFilter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) ${
    filters.invert ? 'invert(1)' : ''
  }`;

  return (
    <div ref={containerRef} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* FLOATING / PINNED ON-CANVAS HUD TOOLBAR WITH MODULAR PANELS & CONTINUOUS SLIDERS */}
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
            padding: activeHudModule === 'none' ? '6px 14px' : '10px 14px',
            background: 'rgba(15, 23, 42, 0.96)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderRadius: '10px',
            border: '2px solid #facc15',
            boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
            color: '#f8fafc',
            display: 'flex',
            flexDirection: 'column',
            gap: activeHudModule === 'none' ? '0px' : '8px',
            zIndex: 70,
            transition: 'padding 0.15s ease, gap 0.15s ease',
          }}
        >
          {/* Top Master Strip: Lane identity, module switcher tabs, quick action cluster */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            {/* Left: Lane Identity, Well Coordinates, Prev/Next Navigation */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span
                style={{
                  background: '#facc15',
                  color: '#0f172a',
                  fontWeight: 800,
                  fontSize: '12px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                🎯 L{selectedLane.id} ({wellLabel(selectedWell!)})
              </span>

              {/* Lane Switcher */}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                  onClick={() => {
                    const prevId = (selectedLane.id - 1 + lanes.length) % lanes.length;
                    setSelectedLaneId(prevId);
                  }}
                  title="Previous lane (A or PageUp)"
                >
                  ◀
                </button>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                  onClick={() => {
                    const nextId = (selectedLane.id + 1) % lanes.length;
                    setSelectedLaneId(nextId);
                  }}
                  title="Next lane (D or PageDown)"
                >
                  ▶
                </button>
              </div>

              {selectedRow ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: '#cbd5e1',
                    maxWidth: '190px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={selectedRow.recipe
                    .filter((rc: any) => rc.target_concentration > 0)
                    .map((rc: any) => `${rc.code} ${rc.target_concentration.toFixed(1)} mM`)
                    .join(' · ')}
                >
                  {selectedRow.recipe
                    .filter((rc: any) => rc.target_concentration > 0)
                    .map((rc: any) => `${rc.code} ${rc.target_concentration.toFixed(1)}mM`)
                    .join(' · ')}
                </span>
              ) : (
                <span style={{ fontSize: '11px', color: '#94a3b8' }}>Empty</span>
              )}
            </div>

            {/* Center: Modular Feature Tabs (Single-click switches active drawer) */}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#090d16', padding: '2px 3px', borderRadius: '6px', border: '1px solid #334155' }}>
              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 8px',
                  fontSize: '11px',
                  background: activeHudModule === 'geometry' ? '#facc15' : 'transparent',
                  color: activeHudModule === 'geometry' ? '#0f172a' : '#cbd5e1',
                  borderColor: activeHudModule === 'geometry' ? '#facc15' : 'transparent',
                  fontWeight: activeHudModule === 'geometry' ? 800 : 600,
                }}
                onClick={() => setActiveHudModule((m) => (m === 'geometry' ? 'none' : 'geometry'))}
                title="Lane position (X/Y), tilt angle, and width continuous sliders"
              >
                📐 Geometry
              </button>

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 8px',
                  fontSize: '11px',
                  background: activeHudModule === 'baselines' ? '#facc15' : 'transparent',
                  color: activeHudModule === 'baselines' ? '#0f172a' : '#cbd5e1',
                  borderColor: activeHudModule === 'baselines' ? '#facc15' : 'transparent',
                  fontWeight: activeHudModule === 'baselines' ? 800 : 600,
                }}
                onClick={() => setActiveHudModule((m) => (m === 'baselines' ? 'none' : 'baselines'))}
                title="Origin baseline and dual solvent front continuous sliders"
              >
                💧 Baselines
              </button>

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 8px',
                  fontSize: '11px',
                  background: activeHudModule === 'spots' ? '#f59e0b' : 'transparent',
                  color: activeHudModule === 'spots' ? '#0f172a' : '#cbd5e1',
                  borderColor: activeHudModule === 'spots' ? '#f59e0b' : 'transparent',
                  fontWeight: activeHudModule === 'spots' ? 800 : 600,
                }}
                onClick={() => setActiveHudModule((m) => (m === 'spots' ? 'none' : 'spots'))}
                title="Manage detected and custom spot picks (drag, add, delete, reset)"
              >
                🎯 Spots ({selectedLaneSpots.length})
                {selectedLane.customSpots !== undefined && (
                  <span style={{ marginLeft: '4px', background: '#d97706', color: '#fff', padding: '0 4px', borderRadius: '3px', fontSize: '9px', fontWeight: 700 }}>
                    Custom
                  </span>
                )}
              </button>

              {edgeFits && edgeSettings && onEdgeSetting && (() => {
                const h = selectedSide === 1 ? 1 : 0;
                const fit = edgeFits[h];
                const st = edgeSettings[h];
                const isThisSideActive = fit && st ? edgeActive(fit, st) : false;
                const hasThisSideSugg = fit && st ? edgeSuggestion(fit, st) : false;
                return (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        padding: '3px 8px',
                        fontSize: '11px',
                        background: activeHudModule === 'edge' ? '#ec4899' : pickMode ? '#831843' : isThisSideActive ? '#064e3b' : hasThisSideSugg ? '#78350f' : 'transparent',
                        color: activeHudModule === 'edge' ? '#ffffff' : pickMode ? '#f472b6' : isThisSideActive ? '#6ee7b7' : hasThisSideSugg ? '#fde047' : '#cbd5e1',
                        borderColor: activeHudModule === 'edge' ? '#db2777' : pickMode ? '#ec4899' : isThisSideActive ? '#059669' : hasThisSideSugg ? '#eab308' : 'transparent',
                        fontWeight: activeHudModule === 'edge' ? 800 : 600,
                      }}
                      onClick={() => setActiveHudModule((m) => (m === 'edge' ? 'none' : 'edge'))}
                      title={`Open Edge Leveling controls for Side ${h + 1} (Lane ${selectedLane.id})`}
                    >
                      🎛️ Side {h + 1} Edge {isThisSideActive ? '● ON' : hasThisSideSugg ? '⚡ Curve' : '○ OFF'}{pickMode ? ' (Pick)' : ''}
                    </button>
                    {!isThisSideActive && (hasThisSideSugg || (fit && fit.ok)) ? (
                      <button
                        type="button"
                        style={{
                          ...hudBtn,
                          padding: '2px 7px',
                          fontSize: '10px',
                          background: '#10b981',
                          color: '#022c22',
                          borderColor: '#34d399',
                          fontWeight: 800,
                        }}
                        onClick={() => onEdgeSetting(h, { ...st, mode: 'on' })}
                        title={`Apply detected leveling curve to Side ${h + 1} (Lanes ${h === 0 ? '0–26' : '27–53'})`}
                      >
                        ⚡ Level Side {h + 1}
                      </button>
                    ) : isThisSideActive ? (
                      <button
                        type="button"
                        style={{
                          ...hudBtn,
                          padding: '2px 6px',
                          fontSize: '10px',
                          background: '#334155',
                          color: '#f87171',
                          borderColor: '#475569',
                          fontWeight: 600,
                        }}
                        onClick={() => onEdgeSetting(h, { ...st, mode: 'off' })}
                        title={`Turn off edge leveling for Side ${h + 1}`}
                      >
                        Off
                      </button>
                    ) : null}
                  </div>
                );
              })()}

              {isComposite && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: activeHudModule === 'composite' ? '#14b8a6' : 'transparent',
                    color: activeHudModule === 'composite' ? '#042f2e' : '#5eead4',
                    borderColor: activeHudModule === 'composite' ? '#2dd4bf' : 'transparent',
                    fontWeight: activeHudModule === 'composite' ? 800 : 600,
                  }}
                  onClick={() => setActiveHudModule((m) => (m === 'composite' ? 'none' : 'composite'))}
                  title="Dual-channel composite blending (Glow overlay, False-color, Split wipe)"
                >
                  ✨ Composite
                </button>
              )}

              {selectedRow && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: activeHudModule === 'recipe' ? '#facc15' : 'transparent',
                    color: activeHudModule === 'recipe' ? '#0f172a' : '#cbd5e1',
                    borderColor: activeHudModule === 'recipe' ? '#facc15' : 'transparent',
                    fontWeight: activeHudModule === 'recipe' ? 800 : 600,
                  }}
                  onClick={() => setActiveHudModule((m) => (m === 'recipe' ? 'none' : 'recipe'))}
                  title="Detailed well formulation recipe and solvent volume"
                >
                  🧪 Recipe
                </button>
              )}

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 8px',
                  fontSize: '11px',
                  background: activeHudModule === 'tools' ? '#facc15' : 'transparent',
                  color: activeHudModule === 'tools' ? '#0f172a' : '#cbd5e1',
                  borderColor: activeHudModule === 'tools' ? '#facc15' : 'transparent',
                  fontWeight: activeHudModule === 'tools' ? 800 : 600,
                }}
                onClick={() => setActiveHudModule((m) => (m === 'tools' ? 'none' : 'tools'))}
                title="Global plate skew, lane resetting, and tier flipping"
              >
                ⚙️ Tools
              </button>

              {/* Minimize / Expand Drawer Toggle */}
              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 6px',
                  fontSize: '10px',
                  background: 'transparent',
                  color: '#94a3b8',
                  borderColor: 'transparent',
                }}
                onClick={() => setActiveHudModule((m) => (m === 'none' ? 'geometry' : 'none'))}
                title={activeHudModule === 'none' ? 'Open tool drawer' : 'Minimize drawer (view plate photo)'}
              >
                {activeHudModule === 'none' ? '▼' : '▲'}
              </button>
            </div>

            {/* Right: Channel Switcher, Rf Badges, Undo, Inspect, CSV, Dock, Done */}
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
              {renderChannelButtons()}

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 7px',
                  background: showRfBadges ? '#0284c7' : '#1e293b',
                  color: showRfBadges ? '#ffffff' : '#94a3b8',
                  borderColor: showRfBadges ? '#0369a1' : '#475569',
                }}
                onClick={() => setShowRfBadges((s) => !s)}
                title="Toggle on-plate spot centroid ticks and numerical Rf badges"
              >
                🏷️ {showRfBadges ? 'Rf ON' : 'Rf OFF'}
              </button>

              {onUndo && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 7px',
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
                  ↺
                </button>
              )}

              <button
                type="button"
                style={{ ...hudBtn, padding: '3px 8px', background: '#0284c7', color: '#ffffff', borderColor: '#0369a1' }}
                onClick={() => onOpenWellModal(selectedWell!)}
                title="Inspect densitogram and peaks (Enter)"
              >
                🔍 Inspect
              </button>

              {onExportLaneCsv && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 7px', background: '#059669', color: '#ffffff', borderColor: '#047857' }}
                  onClick={onExportLaneCsv}
                  title="Export corrected lane CSV file"
                >
                  💾 CSV
                </button>
              )}

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 6px',
                  background: hudPosition === 'bottom' ? '#0f766e' : '#1e293b',
                  color: hudPosition === 'bottom' ? '#a7f3d0' : '#cbd5e1',
                  borderColor: hudPosition === 'bottom' ? '#14b8a6' : '#475569',
                }}
                onClick={() => setHudPosition((pos) => (pos === 'top' ? 'bottom' : 'top'))}
                title={hudPosition === 'top' ? 'Dock HUD to bottom of screen' : 'Dock HUD to top of screen'}
              >
                📌 {hudPosition === 'top' ? 'Bottom' : 'Top'}
              </button>

              <button
                type="button"
                style={{ ...hudBtn, padding: '3px 8px', background: '#334155', color: '#cbd5e1', borderColor: '#475569' }}
                onClick={() => setSelectedLaneId(null)}
                title="Deselect lane (Esc)"
              >
                ✕ Done
              </button>
            </div>
          </div>

          {/* MODULAR DRAWER: Render only the active module */}
          {activeHudModule === 'none' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', fontSize: '11px', color: '#94a3b8', padding: '2px 4px' }}>
              <span>Shift: <b style={{ color: '#fff' }}>({Math.round(selectedLane.x0)}, {Math.round(selectedLane.y0)}) px</b></span>
              <span>Tilt: <b style={{ color: '#facc15' }}>{selectedLane.angle >= 0 ? '+' : ''}{selectedLane.angle.toFixed(1)}°</b></span>
              <span>Origin: <b style={{ color: '#fbbf24' }}>{currentOriginVal} px</b></span>
              <span>Front: <b style={{ color: '#38bdf8' }}>{selectedSide === 1 ? frontSide1Val : frontSide0Val} px</b></span>
              <span>Width: <b style={{ color: '#c084fc' }}>{Math.round(selectedLane.width)} px</b></span>
              <span style={{ color: '#38bdf8' }}>| Arrow keys or drag on canvas to adjust live</span>
            </div>
          )}

          {activeHudModule === 'geometry' && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: '8px',
                background: 'rgba(0,0,0,0.35)',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {/* Shift X */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift X:</span>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #334155' }}>
                    {Math.round(selectedLane.x0)} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { x0: selectedLane.x0 - 1 });
                    }}
                    title="Shift left 1px (←)"
                  >
                    -1
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { x0: selectedLane.x0 + 1 });
                    }}
                    title="Shift right 1px (→)"
                  >
                    +1
                  </button>
                </div>
              </div>

              {/* Shift Y */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift Y:</span>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #334155' }}>
                    {Math.round(selectedLane.y0)} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { y0: selectedLane.y0 - 1 });
                    }}
                    title="Shift up 1px (↑)"
                  >
                    -1
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { y0: selectedLane.y0 + 1 });
                    }}
                    title="Shift down 1px (↓)"
                  >
                    +1
                  </button>
                </div>
              </div>

              {/* Tilt Angle */}
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#facc15' }}>Tilt Angle:</span>
                        <button
                          type="button"
                          style={{
                            ...hudBtn,
                            padding: '1px 5px',
                            fontSize: '9px',
                            background: '#1e293b',
                            color: '#38bdf8',
                            borderColor: '#0284c7',
                          }}
                          onClick={handleFlipLane}
                          title="Flip lane direction 180°"
                        >
                          ↕ Flip 180°
                        </button>
                      </div>
                      <span className="mono" style={{ fontSize: '11px', fontWeight: 800, color: '#facc15', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #b45309' }}>
                        {selectedLane.angle >= 0 ? '+' : ''}{selectedLane.angle.toFixed(1)}°
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <button
                        type="button"
                        style={{ ...hudBtn, padding: '2px 4px', fontSize: '9px' }}
                        onClick={() => {
                          if (onSnapshotHistory) onSnapshotHistory();
                          onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle - 1.0).toFixed(2) });
                        }}
                        title="-1.0°"
                      >
                        -1°
                      </button>
                      <button
                        type="button"
                        style={{ ...hudBtn, padding: '2px 4px', fontSize: '9px' }}
                        onClick={() => {
                          if (onSnapshotHistory) onSnapshotHistory();
                          onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle - 0.2).toFixed(2) });
                        }}
                        title="-0.2°"
                      >
                        -0.2°
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
                      />
                      <button
                        type="button"
                        style={{ ...hudBtn, padding: '2px 4px', fontSize: '9px' }}
                        onClick={() => {
                          if (onSnapshotHistory) onSnapshotHistory();
                          onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle + 0.2).toFixed(2) });
                        }}
                        title="+0.2°"
                      >
                        +0.2°
                      </button>
                      <button
                        type="button"
                        style={{ ...hudBtn, padding: '2px 4px', fontSize: '9px' }}
                        onClick={() => {
                          if (onSnapshotHistory) onSnapshotHistory();
                          onUpdateLane(selectedLane.id, { angle: +(selectedLane.angle + 1.0).toFixed(2) });
                        }}
                        title="+1.0°"
                      >
                        +1°
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Lane Width */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc' }}>Lane Width:</span>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #6b21a8' }}>
                    {Math.round(selectedLane.width)} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
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
          )}

          {activeHudModule === 'baselines' && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '8px',
                background: 'rgba(0,0,0,0.35)',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {/* Origin Baseline */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>Origin (Rf = 0.00):</span>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #78350f' }}>
                    {currentOriginVal} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { zeroRf: Math.max(5, currentOriginVal - 1) });
                    }}
                    title="Lower origin 1px"
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      onUpdateLane(selectedLane.id, { zeroRf: currentOriginVal + 1 });
                    }}
                    title="Raise origin 1px"
                  >
                    +1
                  </button>
                </div>
              </div>

              {/* Solvent Front Side 1 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Front Side 1 (L0–26):</span>
                    {selectedSide === 0 && (
                      <span style={{ fontSize: '9px', background: '#0284c7', color: '#fff', padding: '1px 4px', borderRadius: '3px', fontWeight: 600 }}>
                        Active
                      </span>
                    )}
                  </div>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #0369a1' }}>
                    {frontSide0Val} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      const nextVal = Math.max(50, frontSide0Val - 1);
                      if (onUpdateSetFront) onUpdateSetFront(nextVal, 0);
                    }}
                    title="Lower Side 1 front 1px"
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      const nextVal = frontSide0Val + 1;
                      if (onUpdateSetFront) onUpdateSetFront(nextVal, 0);
                    }}
                    title="Raise Side 1 front 1px"
                  >
                    +1
                  </button>
                </div>
              </div>

              {/* Solvent Front Side 2 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4' }}>Front Side 2 (L27–53):</span>
                    {selectedSide === 1 && (
                      <span style={{ fontSize: '9px', background: '#0891b2', color: '#fff', padding: '1px 4px', borderRadius: '3px', fontWeight: 600 }}>
                        Active
                      </span>
                    )}
                  </div>
                  <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #0891b2' }}>
                    {frontSide1Val} px
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      const nextVal = Math.max(50, frontSide1Val - 1);
                      if (onUpdateSetFront) onUpdateSetFront(nextVal, 1);
                    }}
                    title="Lower Side 2 front 1px"
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
                  />
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '2px 6px', fontSize: '10px' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      const nextVal = frontSide1Val + 1;
                      if (onUpdateSetFront) onUpdateSetFront(nextVal, 1);
                    }}
                    title="Raise Side 2 front 1px"
                  >
                    +1
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeHudModule === 'spots' && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                background: 'rgba(0,0,0,0.35)',
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {/* Header row: title, counts, add button, reset button */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>
                    🎯 Spots on Lane {selectedLane.id}:
                  </span>
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                    {selectedLaneSpots.length} pick{selectedLaneSpots.length === 1 ? '' : 's'}
                    {selectedLaneManualCount > 0 && ` (${selectedLaneManualCount} manual)`}
                    {selectedLaneAdjustedCount > 0 && ` (${selectedLaneAdjustedCount} adjusted)`}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={{
                      ...hudBtn,
                      background: '#047857',
                      color: '#ffffff',
                      borderColor: '#10b981',
                      padding: '3px 8px',
                    }}
                    onClick={() => handleAddSpotToLane(selectedLane.id, 0.50)}
                    title="Add a new spot at Rf 0.50 (or Shift+Click anywhere on the lane)"
                  >
                    + Add Spot (Rf 0.50)
                  </button>

                  {selectedLane.customSpots !== undefined && (
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        background: '#334155',
                        color: '#fbbf24',
                        borderColor: '#78350f',
                        padding: '3px 8px',
                      }}
                      onClick={() => handleResetLaneSpotsToAuto(selectedLane.id)}
                      title="Clear custom adjustments and restore automated peak detection for this lane"
                    >
                      ↺ Reset to Auto Detection
                    </button>
                  )}
                </div>
              </div>

              {/* Spots list */}
              {selectedLaneSpots.length > 0 ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                    gap: '8px',
                    maxHeight: 'min(240px, 35vh)',
                    overflowY: 'auto',
                    padding: '2px',
                  }}
                >
                  {selectedLaneSpots.map((sp, idx) => {
                    const src = sp.source || 'auto';
                    const srcColor = src === 'manual' ? '#f59e0b' : src === 'adjusted' ? '#a855f7' : '#38bdf8';
                    const srcBg = src === 'manual' ? 'rgba(245, 158, 11, 0.15)' : src === 'adjusted' ? 'rgba(168, 85, 247, 0.15)' : 'rgba(56, 189, 248, 0.12)';
                    const srcBorder = src === 'manual' ? '#b45309' : src === 'adjusted' ? '#7e22ce' : '#0369a1';
                    return (
                      <div
                        key={idx}
                        style={{
                          background: 'rgba(15, 23, 42, 0.85)',
                          borderRadius: '6px',
                          border: `1px solid ${srcBorder}`,
                          padding: '6px 8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 800, fontSize: '11px', color: '#fff' }}>
                              #{idx + 1}
                            </span>
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                background: srcBg,
                                color: srcColor,
                                border: `1px solid ${srcBorder}`,
                                padding: '1px 5px',
                                borderRadius: '3px',
                              }}
                            >
                              {src === 'manual' ? '✋ Manual' : src === 'adjusted' ? '✨ Adjusted' : 'Auto'}
                            </span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: srcColor }}>
                              Rf {sp.rf.toFixed(2)}
                            </span>
                            <button
                              type="button"
                              style={{
                                ...hudBtn,
                                padding: '1px 5px',
                                fontSize: '10px',
                                background: 'transparent',
                                color: '#ef4444',
                                borderColor: 'rgba(239, 68, 68, 0.4)',
                              }}
                              onClick={() => handleDeleteSpotFromLane(selectedLane.id, idx)}
                              title="Delete this spot (or Alt+Click on the canvas)"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* Fine nudge controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <button
                            type="button"
                            style={{ ...hudBtn, padding: '1px 5px', fontSize: '9px' }}
                            onClick={() => handleNudgeSpotRf(selectedLane.id, idx, -0.05)}
                            title="Nudge Rf -0.05"
                          >
                            -0.05
                          </button>
                          <button
                            type="button"
                            style={{ ...hudBtn, padding: '1px 5px', fontSize: '9px' }}
                            onClick={() => handleNudgeSpotRf(selectedLane.id, idx, -0.01)}
                            title="Nudge Rf -0.01"
                          >
                            -0.01
                          </button>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(sp.rf * 100)}
                            onPointerDown={onSnapshotHistory}
                            onMouseDown={onSnapshotHistory}
                            onChange={(e) => {
                              const targetRf = +e.target.value / 100;
                              handleNudgeSpotRf(selectedLane.id, idx, targetRf - sp.rf);
                            }}
                            style={{ ...hudSliderTrack, flex: 1, accentColor: srcColor }}
                          />
                          <button
                            type="button"
                            style={{ ...hudBtn, padding: '1px 5px', fontSize: '9px' }}
                            onClick={() => handleNudgeSpotRf(selectedLane.id, idx, +0.01)}
                            title="Nudge Rf +0.01"
                          >
                            +0.01
                          </button>
                          <button
                            type="button"
                            style={{ ...hudBtn, padding: '1px 5px', fontSize: '9px' }}
                            onClick={() => handleNudgeSpotRf(selectedLane.id, idx, +0.05)}
                            title="Nudge Rf +0.05"
                          >
                            +0.05
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic', padding: '4px' }}>
                  No spots on this lane. Click "+ Add Spot" above or Shift+Click on the lane photograph to place a spot pick.
                </div>
              )}

              {/* Interaction Guide */}
              <div style={{ fontSize: '10px', color: '#38bdf8', display: 'flex', gap: '12px', flexWrap: 'wrap', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '4px' }}>
                <span>💡 <b>Interactive Controls:</b> Click &amp; drag any spot centroid ring on the photograph to slide its Rf</span>
                <span><b>Shift+Click</b> on lane to place new spot</span>
                <span><b>Alt+Click</b> on spot to delete</span>
              </div>
            </div>
          )}

          {activeHudModule === 'edge' && edgeFits && edgeSettings && onEdgeSetting && (
            <div style={{ marginTop: '2px', marginBottom: '2px', maxHeight: 'min(360px, 45vh)', overflowY: 'auto' }}>
              <TlcEdgePanel
                fits={edgeFits}
                settings={edgeSettings}
                onSetting={onEdgeSetting}
                picks={picks}
                pickMode={pickMode}
                onPickMode={onPickMode || (() => {})}
                pickGroup={pickGroup}
                onPickGroup={onPickGroup || (() => {})}
                onClearPicks={onClearPicks || (() => {})}
                darkTheme={true}
                defaultOpen={true}
                selectedLaneId={selectedLaneId}
                straighten={straighten}
                onToggleStraighten={setStraighten}
              />
            </div>
          )}

          {activeHudModule === 'composite' && isComposite && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(4, 47, 46, 0.85)',
                padding: '6px 10px',
                borderRadius: '8px',
                border: '1px solid #0f766e',
                flexWrap: 'wrap',
              }}
            >
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
                >
                  ✨ Glow
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
                >
                  ↔ Split Wipe
                </button>
              </div>

              {compositeSubMode === 'glow' && (
                <>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Cutoff:</span>
                    <input
                      type="range"
                      min={0.05}
                      max={0.4}
                      step={0.01}
                      value={fluoThreshold}
                      onChange={(e) => setFluoThreshold(+e.target.value)}
                      style={{ ...hudSliderTrack, width: '55px', accentColor: '#14b8a6' }}
                    />
                    <span className="mono" style={{ fontSize: '10px', color: '#5eead4' }}>{Math.round(fluoThreshold * 100)}%</span>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Boost:</span>
                    <input
                      type="range"
                      min={1.0}
                      max={2.8}
                      step={0.1}
                      value={fluoGain}
                      onChange={(e) => setFluoGain(+e.target.value)}
                      style={{ ...hudSliderTrack, width: '55px', accentColor: '#10b981' }}
                    />
                    <span className="mono" style={{ fontSize: '10px', color: '#34d399' }}>{fluoGain.toFixed(1)}×</span>
                  </div>
                </>
              )}

              {compositeSubMode === 'false-color' && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
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
                    style={{ ...hudSliderTrack, width: '55px', accentColor: '#06b6d4' }}
                  />
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
                    style={{ ...hudSliderTrack, width: '70px', accentColor: '#facc15' }}
                  />
                  <span className="mono" style={{ fontSize: '10px', color: '#fef08a' }}>{Math.round(splitPos * 100)}%</span>
                </div>
              )}
            </div>
          )}

          {activeHudModule === 'recipe' && selectedRow && (
            <div
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                padding: '6px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#facc15' }}>
                  🧪 Well {wellLabel(selectedWell!)} Recipe (Reaction #{selectedRow.global_index + 1})
                </span>
                {selectedRow['vol#solvent'] != null && (
                  <span style={{ fontSize: '11px', color: '#cbd5e1' }}>
                    Solvent Volume: <b style={{ color: '#38bdf8' }}>{Number(selectedRow['vol#solvent']).toFixed(1)} µL</b>
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
                {selectedRow.recipe
                  .filter((rc: any) => rc.target_concentration > 0)
                  .map((rc: any) => (
                    <div
                      key={rc.code}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: '#0f172a',
                        border: `1px solid ${rc.color || '#475569'}`,
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontSize: '10px',
                      }}
                    >
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: rc.color || '#38bdf8',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 700, color: '#f8fafc' }}>{rc.code}:</span>
                      <span style={{ color: '#cbd5e1' }}>{rc.name}</span>
                      <span className="mono" style={{ color: '#38bdf8', fontWeight: 700 }}>
                        {rc.target_concentration.toFixed(1)} mM
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {activeHudModule === 'tools' && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                flexWrap: 'wrap',
                background: 'rgba(0,0,0,0.3)',
                padding: '6px 10px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {/* Global Skew */}
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
                title="Rotate all 54 lanes uniformly"
              >
                <span style={{ fontSize: '10px', color: '#cbd5e1', fontWeight: 600 }}>Global Skew:</span>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 5px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(-0.2)}
                  title="Rotate all 54 lanes CCW by -0.2°"
                >
                  ↺ -0.2°
                </button>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 5px', fontSize: '10px' }}
                  onClick={() => handleApplyGlobalSkew(+0.2)}
                  title="Rotate all 54 lanes CW by +0.2°"
                >
                  +0.2° ↻
                </button>
              </div>

              {/* Invert Upper Tier */}
              {selectedSide === 1 && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#38bdf8', borderColor: '#0284c7' }}
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
                  title="Invert migration direction of all 27 upper tier lanes"
                >
                  ↕ Flip Upper Tier (L27–53)
                </button>
              )}

              {/* Reset Lane */}
              {onResetLane && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#fbbf24', borderColor: '#b45309' }}
                  onClick={() => onResetLane(selectedLane.id)}
                  title="Reset this lane to original template"
                >
                  ⟲ Reset Lane
                </button>
              )}

              {/* Reset All */}
              {onResetAllLanes && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#94a3b8', borderColor: '#475569' }}
                  onClick={onResetAllLanes}
                  title="Reset all 54 lanes to template"
                >
                  ⟲ Reset All Lanes
                </button>
              )}
            </div>
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
            padding: overviewModule === 'none' ? '6px 14px' : '10px 14px',
            background: 'rgba(15, 23, 42, 0.94)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderRadius: '8px',
            border: '1px solid #475569',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            color: '#f8fafc',
            display: 'flex',
            flexDirection: 'column',
            gap: overviewModule === 'none' ? '0px' : '8px',
            fontSize: '12px',
          }}
        >
          {/* Top Bar for Overview Mode */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <span style={{ color: '#e2e8f0', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span>💡</span>
              <span><b>Plate Overview:</b> Click any lane on the photograph to select &amp; align.</span>
            </span>

            {/* Modular Quick Tabs for Overview */}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#090d16', padding: '2px 3px', borderRadius: '6px', border: '1px solid #334155' }}>
              {lanes.length > 0 && onUpdateLane && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: '#1e293b',
                    color: '#facc15',
                    borderColor: '#475569',
                    fontWeight: 700,
                  }}
                  onClick={() => {
                    setSelectedLaneId(0);
                    setActiveHudModule('geometry');
                  }}
                  title="Open Lane Geometry controls (Shift X/Y, Tilt Angle, Lane Width)"
                >
                  📐 Geometry
                </button>
              )}

              {lanes.length > 0 && onUpdateSetFront && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: overviewModule === 'fronts' ? '#facc15' : 'transparent',
                    color: overviewModule === 'fronts' ? '#0f172a' : '#cbd5e1',
                    borderColor: overviewModule === 'fronts' ? '#facc15' : 'transparent',
                    fontWeight: overviewModule === 'fronts' ? 800 : 600,
                  }}
                  onClick={() => setOverviewModule((m) => (m === 'fronts' ? 'none' : 'fronts'))}
                  title="Solvent front continuous sliders"
                >
                  💧 Baselines ({frontSide0Val} / {frontSide1Val} px)
                </button>
              )}

              {edgeFits && edgeSettings && onEdgeSetting && (() => {
                const isSide0Active = edgeFits[0] && edgeSettings[0] ? edgeActive(edgeFits[0], edgeSettings[0]) : false;
                const isSide1Active = edgeFits[1] && edgeSettings[1] ? edgeActive(edgeFits[1], edgeSettings[1]) : false;
                const hasSide0Sugg = edgeFits[0] && edgeSettings[0] ? edgeSuggestion(edgeFits[0], edgeSettings[0]) : false;
                const hasSide1Sugg = edgeFits[1] && edgeSettings[1] ? edgeSuggestion(edgeFits[1], edgeSettings[1]) : false;
                return (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <button
                      type="button"
                      style={{
                        ...hudBtn,
                        padding: '3px 8px',
                        fontSize: '11px',
                        background: overviewModule === 'edge' ? '#ec4899' : (isSide0Active || isSide1Active) ? '#064e3b' : (hasSide0Sugg || hasSide1Sugg) ? '#78350f' : 'transparent',
                        color: overviewModule === 'edge' ? '#ffffff' : (isSide0Active || isSide1Active) ? '#6ee7b7' : (hasSide0Sugg || hasSide1Sugg) ? '#fde047' : '#cbd5e1',
                        borderColor: overviewModule === 'edge' ? '#db2777' : (isSide0Active || isSide1Active) ? '#059669' : (hasSide0Sugg || hasSide1Sugg) ? '#eab308' : 'transparent',
                        fontWeight: overviewModule === 'edge' ? 800 : 600,
                      }}
                      onClick={() => setOverviewModule((m) => (m === 'edge' ? 'none' : 'edge'))}
                      title="Open Edge Migration Leveling controls for Side 1 and Side 2"
                    >
                      🎛️ Edge: S1 {isSide0Active ? '● ON' : hasSide0Sugg ? '⚡' : '○'} | S2 {isSide1Active ? '● ON' : hasSide1Sugg ? '⚡' : '○'}{pickMode ? ' (Pick)' : ''}
                    </button>
                    {!isSide0Active && hasSide0Sugg && (
                      <button
                        type="button"
                        style={{
                          ...hudBtn,
                          padding: '2px 6px',
                          fontSize: '10px',
                          background: '#10b981',
                          color: '#022c22',
                          borderColor: '#34d399',
                          fontWeight: 800,
                        }}
                        onClick={() => onEdgeSetting(0, { ...edgeSettings[0], mode: 'on' })}
                        title="Apply detected leveling curve to Side 1 (Lanes 0–26)"
                      >
                        ⚡ S1
                      </button>
                    )}
                    {!isSide1Active && hasSide1Sugg && (
                      <button
                        type="button"
                        style={{
                          ...hudBtn,
                          padding: '2px 6px',
                          fontSize: '10px',
                          background: '#06b6d4',
                          color: '#042f2e',
                          borderColor: '#22d3ee',
                          fontWeight: 800,
                        }}
                        onClick={() => onEdgeSetting(1, { ...edgeSettings[1], mode: 'on' })}
                        title="Apply detected leveling curve to Side 2 (Lanes 27–53)"
                      >
                        ⚡ S2
                      </button>
                    )}
                  </div>
                );
              })()}

              {isComposite && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: overviewModule === 'composite' ? '#14b8a6' : 'transparent',
                    color: overviewModule === 'composite' ? '#042f2e' : '#5eead4',
                    borderColor: overviewModule === 'composite' ? '#2dd4bf' : 'transparent',
                    fontWeight: overviewModule === 'composite' ? 800 : 600,
                  }}
                  onClick={() => setOverviewModule((m) => (m === 'composite' ? 'none' : 'composite'))}
                  title="Dual-channel composite controls"
                >
                  ✨ Composite
                </button>
              )}

              {lanes.length > 0 && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: '#1e293b',
                    color: '#cbd5e1',
                    borderColor: '#475569',
                    fontWeight: 600,
                  }}
                  onClick={() => {
                    setSelectedLaneId(0);
                    setActiveHudModule('recipe');
                  }}
                  title="Detailed well formulation recipe"
                >
                  🧪 Recipe
                </button>
              )}

              {lanes.length > 0 && onUpdateLane && (
                <button
                  type="button"
                  style={{
                    ...hudBtn,
                    padding: '3px 8px',
                    fontSize: '11px',
                    background: overviewModule === 'skew' ? '#facc15' : 'transparent',
                    color: overviewModule === 'skew' ? '#0f172a' : '#cbd5e1',
                    borderColor: overviewModule === 'skew' ? '#facc15' : 'transparent',
                    fontWeight: overviewModule === 'skew' ? 800 : 600,
                  }}
                  onClick={() => setOverviewModule((m) => (m === 'skew' ? 'none' : 'skew'))}
                  title="Global plate tilt skew and alignment tools"
                >
                  ⚙️ Tools
                </button>
              )}
            </div>

            {/* Right Action Cluster */}
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
              {renderChannelButtons()}

              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '3px 7px',
                  background: showRfBadges ? '#0284c7' : '#1e293b',
                  color: showRfBadges ? '#ffffff' : '#94a3b8',
                  borderColor: showRfBadges ? '#0369a1' : '#475569',
                }}
                onClick={() => setShowRfBadges((s) => !s)}
                title="Toggle on-plate spot centroid ticks and numerical Rf badges"
              >
                🏷️ {showRfBadges ? 'Rf ON' : 'Rf OFF'}
              </button>

              {onUndo && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 7px', opacity: canUndo ? 1 : 0.5, cursor: canUndo ? 'pointer' : 'not-allowed' }}
                  onClick={onUndo}
                  disabled={!canUndo}
                  title="Undo last change (Ctrl+Z)"
                >
                  ↺ Undo
                </button>
              )}

              {lanes.length > 0 && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '3px 8px', background: '#facc15', color: '#0f172a', borderColor: '#eab308', fontWeight: 700 }}
                    onClick={() => {
                      setSelectedLaneId(0);
                      setActiveHudModule('geometry');
                    }}
                    title="Select Lane 0 and edit geometry"
                  >
                    Select Lane 0
                  </button>
                </div>
              )}

              {onExportLaneCsv && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 8px', background: '#059669', color: '#fff', borderColor: '#047857' }}
                  onClick={onExportLaneCsv}
                >
                  💾 CSV
                </button>
              )}
            </div>
          </div>

          {/* Overview Drawers */}
          {overviewModule === 'fronts' && lanes.length > 0 && onUpdateSetFront && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '8px',
                background: 'rgba(0,0,0,0.3)',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Front Side 1 (L0–26):</span>
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
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#38bdf8' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#06b6d4' }}>Front Side 2 (L27–53):</span>
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
                  style={{ ...hudSliderTrack, flex: 1, accentColor: '#06b6d4' }}
                />
              </div>
            </div>
          )}

          {overviewModule === 'edge' && edgeFits && edgeSettings && onEdgeSetting && (
            <div style={{ marginTop: '4px', maxHeight: 'min(360px, 45vh)', overflowY: 'auto' }}>
              <TlcEdgePanel
                fits={edgeFits}
                settings={edgeSettings}
                onSetting={onEdgeSetting}
                picks={picks}
                pickMode={pickMode}
                onPickMode={onPickMode || (() => {})}
                pickGroup={pickGroup}
                onPickGroup={onPickGroup || (() => {})}
                onClearPicks={onClearPicks || (() => {})}
                selectedLaneId={selectedLaneId}
                straighten={straighten}
                onToggleStraighten={setStraighten}
                darkTheme={true}
                defaultOpen={true}
              />
            </div>
          )}

          {overviewModule === 'composite' && isComposite && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(4, 47, 46, 0.85)',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #0f766e',
                flexWrap: 'wrap',
              }}
            >
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
                >
                  ✨ Glow
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
                >
                  ↔ Split Wipe
                </button>
              </div>

              {compositeSubMode === 'glow' && (
                <>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Cutoff:</span>
                    <input
                      type="range"
                      min={0.05}
                      max={0.4}
                      step={0.01}
                      value={fluoThreshold}
                      onChange={(e) => setFluoThreshold(+e.target.value)}
                      style={{ ...hudSliderTrack, width: '55px', accentColor: '#14b8a6' }}
                    />
                    <span className="mono" style={{ fontSize: '10px', color: '#5eead4' }}>{Math.round(fluoThreshold * 100)}%</span>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#a7f3d0' }}>Boost:</span>
                    <input
                      type="range"
                      min={1.0}
                      max={2.8}
                      step={0.1}
                      value={fluoGain}
                      onChange={(e) => setFluoGain(+e.target.value)}
                      style={{ ...hudSliderTrack, width: '55px', accentColor: '#10b981' }}
                    />
                    <span className="mono" style={{ fontSize: '10px', color: '#34d399' }}>{fluoGain.toFixed(1)}×</span>
                  </div>
                </>
              )}

              {compositeSubMode === 'false-color' && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
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
                    style={{ ...hudSliderTrack, width: '70px', accentColor: '#facc15' }}
                  />
                  <span className="mono" style={{ fontSize: '10px', color: '#fef08a' }}>{Math.round(splitPos * 100)}%</span>
                </div>
              )}
            </div>
          )}

          {overviewModule === 'skew' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Global Skew:</span>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 8px', fontSize: '11px' }}
                  onClick={() => handleApplyGlobalSkew(-0.2)}
                  title="Rotate all 54 lanes CCW by -0.2°"
                >
                  ↺ -0.2°
                </button>
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '2px 8px', fontSize: '11px' }}
                  onClick={() => handleApplyGlobalSkew(+0.2)}
                  title="Rotate all 54 lanes CW by +0.2°"
                >
                  +0.2° ↻
                </button>
              </div>

              {onUpdateLane && (
                <>
                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#38bdf8', borderColor: '#0284c7' }}
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
                    title="Invert migration direction of all 27 upper tier lanes"
                  >
                    ↕ Flip Upper Tier (L27–53)
                  </button>

                  <button
                    type="button"
                    style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#38bdf8', borderColor: '#0284c7' }}
                    onClick={() => {
                      if (onSnapshotHistory) onSnapshotHistory();
                      lanes.forEach((l) => {
                        if (l.id < 27) {
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
                    title="Invert migration direction of all 27 lower tier lanes"
                  >
                    ↕ Flip Lower Tier (L0–26)
                  </button>
                </>
              )}

              {onResetAllLanes && (
                <button
                  type="button"
                  style={{ ...hudBtn, padding: '3px 8px', background: '#1e293b', color: '#94a3b8', borderColor: '#475569' }}
                  onClick={onResetAllLanes}
                  title="Reset all 54 lanes to template"
                >
                  ⟲ Reset All Lanes
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Plate Image Display */}
      {imgEntry?.bmp ? (
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
          {pickMode && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                padding: '6px 12px',
                background: '#831843',
                color: '#fdf2f8',
                borderRadius: '6px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: '#ec4899',
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                marginBottom: '8px',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <span>🎯 <b>Picking Spots for Compound {pickGroup + 1}</b> ({picks.filter((q) => q.group === pickGroup).length} picked)</span>
                <span style={{ fontSize: '11px', color: '#fbcfe8' }}>— Click detected spots along lanes; click again to remove</span>
              </div>
              <button
                type="button"
                style={{
                  ...hudBtn,
                  padding: '2px 8px',
                  background: '#ec4899',
                  color: '#ffffff',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: '#f472b6',
                  fontWeight: 700,
                  fontSize: '11px',
                }}
                onClick={() => onPickMode && onPickMode(false)}
              >
                ✓ Done Picking
              </button>
            </div>
          )}
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
              cursor: pickMode ? 'copy' : isDragging ? 'grabbing' : hoveredLaneId !== null ? 'pointer' : 'crosshair',
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
              Auto Pick
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#f59e0b' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b', border: '1px solid #ffffff' }} />
              ✋ Manual Pick
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#c084fc' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#a855f7', border: '1px solid #ffffff' }} />
              ✨ User Adjusted (Drag along lane)
            </span>
            {isEdgeActive && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#10b981' }}>
                <span style={{ display: 'inline-block', width: '14px', height: '0px', borderTop: '2px dashed #10b981' }} />
                Leveled Spot Position (Emerald Dashed: Corrected Rf)
              </span>
            )}
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
