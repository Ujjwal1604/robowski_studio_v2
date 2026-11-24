// Robowski Studio - Advanced TLC Map & Parallel Lane Densitometer
// Features: Center-weighted core lane sampling (suppressing neighbor bleed),
// pixel-matched parallel densitograms (base origin to solvent front),
// multi-channel UV254 (absorbance) vs UV365 (fluorescence) traces with dual overlay,
// and automated peak finding + separation metrics.
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { getSpotConfidenceStyle } from '../../utils/spotConfidence';
import {
  LANE_FRAME_WIDTH,
  tlcLane,
  containerOfLane,
  wellLabel,
  laneMatrix,
  parseLaneConfig,
  PAL,
  TLC_SIGNAL,
  TlcChannelKey,
  movingAvg,
  pctile,
  detectFront,
  tlcDetectionNotes,
  findSpots,
  findMultiChannelSpots,
  mergeMultiChannelSpots,
  getLoadedTlcChannels,
  getChannelHistogram,
  getChannelFrontBandProfile,
  getLane2dMetrics,
  extractLaneProfile2d,
  setBlankSilicaRef,
  clearBlankSilicaRef,
  getBlankSilicaMeta,
  setBlankSilicaEnabled,
  isBlankSilicaEnabled,
  setAutomiddleEnabled,
  isAutomiddleEnabled,
  inspectLabTlcFilename,
  parseNpyBuffer,
  npyToRgbaAndFloatRgb,
  enhanceWhiteLightRgba,
  findSimilarSpotsByColor,
  rescueSharedReagentSpots,
  hasCompositeChannels,
  extractDensitogram,
  DEFAULT_MIN_SPOT_WIDTH_FRAC,
  spotProminenceForDensitogramCutoff,
  tlcHalf,
  tlcFront,
  tlcHalfFrontBase,
  tlcOrigin,
  tlcRfCsv,
  exportTlcAnalysisCsv,
  exportTlcAnalysisJson,
  TlcAnalysisExportOptions,
  createDefaultLaneConfig,
  createDemoTlcDataSet,
  exportLaneConfigCsv,
  getEffectiveLaneSpots,
  renderFalseColorLane,
  getTlcPlateSlice,
  updateTlcPlateSlice,
  tlcStorageKey,
  tlcPreRunStorageKey,
  parseTlcStorageKey,
  tlcSetPlateImageCount,
  tlcSetPlateHasImages,
} from '../../engine';
import {
  fitEdgeCurve,
  fitEdgePicks,
  edgeGain,
  edgeOffset,
  edgeActive,
  DEFAULT_EDGE_SETTING,
  EdgeFit,
  EdgeSetting,
  EdgePoint,
  EdgePick,
  correctSpots,
} from '../../engine/tlcEdge';
import {
  TlcSet,
  TlcLane,
  TlcLaneConfig,
  TlcImageEntry,
  TlcSpot,
  TlcDensitogramData,
} from '../../types';
import { putTlcImage, getTlcImage, deleteTlcSetImages, deleteAllSetImages, getAllSetImages } from '../../context/tlcStorage';
import { detectLaneRows, laneConfigFromDetection } from '../../engine/tlcLaneDetect';
import { fetchAiTlcVisionQc, TlcVisionQcResult, TlcVisionQcLaneSummary } from '../../services/aiService';
import { TlcFullPlateView } from './TlcFullPlateView';
import { parseWellQuery } from '../ui/CommandPalette';
import { AiTlcInterpreter } from '../ui/AiTlcInterpreter';
import { AiSolventAdvisorModal } from '../ui/AiSolventAdvisorModal';
import { WellPredictedProductsPanel } from '../ui/WellPredictedProductsPanel';

const BLANK_SILICA_UID = '__blank_silica__';
const TLC_KEYS: TlcChannelKey[] = ['UV254', 'White', 'UV366'];

const TLC_LABEL: Record<TlcChannelKey, string> = {
  UV254: 'UV 254 nm (Quenching)',
  White: 'Visible (Stain)',
  UV366: 'UV 365 nm (Fluorescence)',
};

const CHANNEL_COLORS: Record<TlcChannelKey, { trace: string; bg: string; dot: string }> = {
  UV254: { trace: '#10b981', bg: 'rgba(16, 185, 129, 0.15)', dot: '#34d399' }, // Emerald green for F254 quenching
  UV366: { trace: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)', dot: '#c084fc' }, // Violet purple for 365nm fluorescence
  White: { trace: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', dot: '#fbbf24' }, // Amber for visible
};

function tlcLetter(i: number): string {
  return String.fromCharCode(65 + i);
}

function tlcNewSet(n: number): TlcSet {
  return {
    uid: 'set_' + Math.random().toString(36).slice(2, 10),
    name: 'Set ' + n,
    cfg: null,
    cfgName: '',
    frameW: LANE_FRAME_WIDTH,
    frontPx: null,
    frontAuto: {},
    frontAutoByLane: {},
    originPx: null,
    originAuto: {},
    imgs: {},
  };
}

function tlcKeyOf(name: string, assigned: Record<string, any>): TlcChannelKey | null {
  const lab = inspectLabTlcFilename(name);
  if (lab.detectedChannel) return lab.detectedChannel;
  return (TLC_KEYS as TlcChannelKey[]).find((k) => !assigned[k]) || null;
}

/**
 * Decodes either a standard image (PNG/JPEG/WebP) OR a Merck TLC Explorer NumPy `.npy` float32 file
 * into a TlcImageEntry, automatically tagging `preFlatFielded` (uni_linint_corrected_*) and `linearized`.
 */
async function decodeTlcImageBlob(
  blob: Blob,
  name: string,
  channelHint?: TlcChannelKey
): Promise<TlcImageEntry> {
  const meta = inspectLabTlcFilename(name);
  if (meta.isNpy) {
    const buf = await blob.arrayBuffer();
    const parsed = parseNpyBuffer(buf);
    const decoded = npyToRgbaAndFloatRgb(parsed, channelHint ?? meta.detectedChannel, name, true);
    const cv = document.createElement('canvas');
    cv.width = decoded.width;
    cv.height = decoded.height;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('Could not initialize 2D canvas for .npy decoding.');
    const imgData = ctx.createImageData(decoded.width, decoded.height);
    imgData.data.set(decoded.rgba8);
    ctx.putImageData(imgData, 0, 0);
    const bmp = await createImageBitmap(cv);
    return {
      name,
      bmp,
      preFlatFielded: meta.isPreFlatFielded,
      linearized: meta.isLinearized || true,
      floatRgb: decoded.floatRgb,
      floatWidth: decoded.width,
      floatHeight: decoded.height,
    };
  }
  const bmp = await createImageBitmap(blob);
  return {
    name,
    bmp,
    preFlatFielded: meta.isPreFlatFielded,
    linearized: meta.isLinearized,
  };
}

// Per-ImageBitmap cache for contrast-boosted White-light canvas (computed once per plate photo)
const boostedWhiteCanvasCache = new WeakMap<ImageBitmap, HTMLCanvasElement>();

function getBoostedWhiteCanvas(bmp: ImageBitmap): HTMLCanvasElement | ImageBitmap {
  const cached = boostedWhiteCanvasCache.get(bmp);
  if (cached) return cached;
  if (typeof document === 'undefined') return bmp;
  const wbW = Math.min(bmp.width, 1600);
  const wbH = Math.max(1, Math.round((bmp.height * wbW) / bmp.width));
  const cv = document.createElement('canvas');
  cv.width = wbW;
  cv.height = wbH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return bmp;
  ctx.drawImage(bmp, 0, 0, wbW, wbH);
  const raw = ctx.getImageData(0, 0, wbW, wbH);
  const enhanced = enhanceWhiteLightRgba(raw.data, wbW, wbH, { gain: 4.6, smoothRadius: 1 });
  const out = ctx.createImageData(wbW, wbH);
  out.data.set(enhanced);
  ctx.putImageData(out, 0, 0);
  boostedWhiteCanvasCache.set(bmp, cv);
  return cv;
}

export interface ImageFilters {
  brightness: number;
  contrast: number;
  invert: boolean;
}

export interface LanePanel {
  s: TlcSet;
  i: number;
  key: TlcChannelKey;
  lane: TlcLane;
  label: string;
  spots?: TlcSpot[] | null;
}

export interface RfMarker {
  id: number;
  rf: number;
  label: string;
  y: number;
}

// Full-RGB 2D lane extraction: computes 1D profile + caches 2D lateral metrics & RGB core vectors
export function extractLaneProfile(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  return extractLaneProfile2d(set, key, lane, coreFraction);
}

// Draw lane panels upright with origin ticks and pink spot ticks
function drawLanePanels(
  canvas: HTMLCanvasElement,
  panels: LanePanel[],
  k: number,
  filters?: ImageFilters,
  showSpots: boolean = true,
  compositeFalseColor: boolean = false,
  boostWhiteSpots: boolean = false
) {
  if (!panels.length) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const gap = Math.max(3, Math.round(k * 6));
  const ph = Math.round(Math.max(...panels.map((p) => k * p.lane.length)));
  const ws = panels.map((p) => Math.round(k * p.lane.width));
  const cssW = ws.reduce((a, b) => a + b, 0) + gap * (panels.length - 1);

  canvas.width = cssW * dpr;
  canvas.height = ph * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${ph}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingQuality = 'high';
  let x = 0;

  panels.forEach((p, j) => {
    const im = p.s.imgs[p.key];
    const l = p.lane;
    const top = ph - k * l.length;
    const w = ws[j];
    const h = k * l.length;

    // Check if multi-channel false color composite can be rendered (any 2+ of UV254, UV366, White)
    let renderedFalseColor = false;
    const isExplicitComposite = (p as any).isComposite || (compositeFalseColor && panels.length === 1);
    if (isExplicitComposite && hasCompositeChannels(p.s.imgs, true)) {
      const fc = renderFalseColorLane(p.s, l, w, h);
      if (fc) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(fc, x, top, w, h);
        ctx.restore();
        renderedFalseColor = true;
      }
    }

    if (!renderedFalseColor && im?.bmp) {
      const srcImg = p.key === 'White' && boostWhiteSpots ? getBoostedWhiteCanvas(im.bmp) : im.bmp;
      const m = laneMatrix(l, srcImg.width / (p.s.frameW || LANE_FRAME_WIDTH), k);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(x, top, w, h);
      ctx.clip();

      ctx.setTransform(
        dpr * m[0],
        dpr * m[1],
        dpr * m[2],
        dpr * m[3],
        dpr * (m[4] + x),
        dpr * (m[5] + top)
      );

      ctx.drawImage(srcImg, 0, 0);
      ctx.restore();
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Yellow ticks where spot origin was applied (Rf = 0)
    const origPx = tlcOrigin(p.s, l, (s, k, ln) => extractLaneProfile(s, k, ln, 0.35));
    ctx.strokeStyle = '#FFC857';
    ctx.lineWidth = 1.5;
    const y = top + k * (l.length - origPx);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5, y);
    ctx.moveTo(x + w - 5, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();

    // Ticks at spots with provenance & continuous multi-level confidence coloring
    if (showSpots && p.spots && p.spots.length) {
      for (const sp of p.spots) {
        const y = top + k * (l.length - sp.pos);
        const isAuto = !sp.source || sp.source === 'auto';
        const confStyle = getSpotConfidenceStyle(sp.confidence);
        ctx.strokeStyle =
          sp.source === 'manual'
            ? '#f59e0b'
            : sp.source === 'adjusted'
            ? '#a855f7'
            : confStyle.color;
        ctx.lineWidth = 2.0;
        ctx.setLineDash(isAuto && confStyle.needsReview ? [2, 2] : []);
        ctx.beginPath();
        ctx.moveTo(x + w - 8, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Set comparison badge (A, B, etc.)
    if (p.label) {
      ctx.font = '600 11px sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(x, 0, 16, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.label, x + 4, 12);
    }
    ctx.restore();
    x += w + gap;
  });
}

// Well cell component for the 6x9 plate grid
interface TlcWellCellProps {
  wellIndex: number;
  run: any;
  plate: number;
  panels: LanePanel[];
  zoom: number;
  hasCfg: boolean;
  filters: ImageFilters;
  markSpots: boolean;
  boostWhiteSpots?: boolean;
  onOpenModal: (wellIndex: number) => void;
}

const TlcWellCell: React.FC<TlcWellCellProps> = React.memo(({
  wellIndex,
  run,
  plate,
  panels,
  zoom,
  hasCfg,
  filters,
  markSpots,
  boostWhiteSpots = false,
  onOpenModal,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const t = tlcLane(wellIndex, 'column');
  const label = wellLabel(wellIndex);
  const row = run?.rows?.find(
    (r: any) => r.plate_number === plate && r.container_id === wellIndex
  );

  useEffect(() => {
    if (canvasRef.current && panels.length > 0) {
      drawLanePanels(canvasRef.current, panels, zoom, undefined, markSpots, false, boostWhiteSpots);
    }
  }, [panels, zoom, markSpots, boostWhiteSpots]);

  const nf = (v: any, d = 1) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const rcol = (i: number) => PAL[i % PAL.length];

  // Merge detected spots across all displayed channel panels for the cell's Rf summary
  const primarySpots = useMemo(() => {
    const withSpots = panels.filter((p) => Array.isArray(p.spots));
    if (!withSpots.length) return undefined;
    if (withSpots.length === 1) return withSpots[0].spots;
    const byCh: Partial<Record<TlcChannelKey, TlcSpot[]>> = {};
    for (const p of withSpots) {
      if (p.spots) byCh[p.key] = p.spots;
    }
    return mergeMultiChannelSpots(byCh);
  }, [panels]);

  const cssFilter =
    filters.invert || filters.brightness !== 100 || filters.contrast !== 100
      ? `brightness(${filters.brightness}%) contrast(${filters.contrast}%) ${
          filters.invert ? 'invert(1)' : ''
        }`
      : undefined;

  return (
    <button
      type="button"
      className="tlccell"
      onClick={() => onOpenModal(wellIndex)}
      title={`Inspect Well ${label} (TLC lane ${t})`}
      style={{ textAlign: 'left', minWidth: 0, width: '100%', overflow: 'hidden' }}
    >
      <div className="tch" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>{label}</b>
        <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>lane {t}</span>
      </div>

      {panels.length > 0 ? (
        <canvas
          ref={canvasRef}
          style={{ display: 'block', margin: '4px auto', filter: cssFilter }}
        />
      ) : (
        <div className="tcempty">{hasCfg ? 'no image' : 'no lane'}</div>
      )}

      {row ? (
        <div className="tcr">
          {row.recipe
            .filter((rc: any) => rc.target_concentration > 0)
            .map((rc: any, ri: number) => (
              <span key={ri} title={`${rc.code}: ${nf(rc.target_concentration, 2)} mM`}>
                <i style={{ background: rcol(ri) }} />
                <b>{rc.code}</b>
                <span className="mono">{nf(rc.target_concentration, 1)}</span>
              </span>
            ))}
        </div>
      ) : (
        <div className="tcr" style={{ color: 'var(--mut)', fontStyle: 'italic' }}>
          Unused
        </div>
      )}

      {/* Rf values summary */}
      {markSpots && primarySpots && (
        <div
          style={{
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            fontSize: '10px',
            fontFamily: 'monospace',
            marginTop: '4px',
            padding: '2px 4px',
            background: 'rgba(236, 72, 153, 0.08)',
            border: '1px solid rgba(236, 72, 153, 0.22)',
            borderRadius: '4px',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={
            primarySpots.length
              ? `Detected Spots: ${primarySpots.map((s) => `Rf ${s.rf.toFixed(2)}`).join(', ')}`
              : 'No spots detected'
          }
        >
          {primarySpots.length ? (
            <span>
              <b style={{ color: '#ec4899', marginRight: '3px' }}>Rf</b>
              <span style={{ color: '#be185d' }}>
                {primarySpots.slice(0, 4).map((s) => s.rf.toFixed(2)).join(', ')}
              </span>
            </span>
          ) : (
            <span style={{ color: 'var(--mut)' }}>Rf —</span>
          )}
        </div>
      )}
    </button>
  );
});

export const TlcView: React.FC = () => {
  const {
    state,
    run,
    toast,
    tlcSets: sets,
    setTlcSets: setSets,
    activeTlcStatus,
    targetWell,
    setTargetWell,
    view,
    setView,
    setVisited,
    spotProminence,
    setSpotProminence,
    setState,
  } = useApp();

  const [cur, setCur] = useState<number>(0);
  const [showSolventAdvisor, setShowSolventAdvisor] = useState<boolean>(false);
  const [compare, setCompare] = useState<boolean>(false);
  const [cmpKey, setCmpKey] = useState<TlcChannelKey>('UV254');
  const [zoom, setZoom] = useState<number>(0.45);
  const [plate, setPlate] = useState<number>(0);
  const [markSpots, setMarkSpots] = useState<boolean>(true);
  const [show, setShow] = useState<Record<TlcChannelKey, boolean>>({
    UV254: true,
    White: true,
    UV366: true,
  });

  // Display Mode: 54-Well Sliced Grid vs Full Plate Photograph Overview
  const [viewMode, setViewMode] = useState<'grid' | 'full-plate'>('grid');
  const [fullPlateChannel, setFullPlateChannel] = useState<TlcChannelKey | 'composite'>('UV254');

  // Sampling Corridor Core Fraction: default 35% to stop edge spillover
  const [coreFraction, setCoreFraction] = useState<number>(0.35);

  // Modal Visualizer: Channel View ('overlay' = 254+365 side-by-side/overlaid, or individual)
  const [densViewMode, setDensViewMode] = useState<'overlay' | 'UV254' | 'UV366' | 'White'>('overlay');

  // Image Adjustment Filters
  const [filters, setFilters] = useState<ImageFilters>({
    brightness: 100,
    contrast: 100,
    invert: false,
  });

  // Modal Inspector State
  const [inspectWell, setInspectWell] = useState<number | null>(null);
  const [hoverRf, setHoverRf] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const [hoverSpot, setHoverSpot] = useState<TlcSpot | null>(null);
  const [pinnedMarkers, setPinnedMarkers] = useState<RfMarker[]>([]);
  const [tlcQuickJump, setTlcQuickJump] = useState<string>('');
  const [spotMode, setSpotMode] = useState<'standard' | 'broad' | 'sensitive'>('standard');

  // Handle external well jump commands directed to TLC Map
  useEffect(() => {
    if (targetWell && view === 'tlc') {
      if (targetWell.setUid) {
        const idx = sets.findIndex((s) => s.uid === targetWell.setUid);
        if (idx >= 0) setCur(idx);
      }
      if (targetWell.plateIndex !== undefined) {
        setPlate(targetWell.plateIndex);
      }
      setInspectWell(targetWell.wellIndex);
      const timer = setTimeout(() => {
        setTargetWell(null);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [targetWell, view, sets, setTargetWell]);

  // Multi-Channel Densitometry Data Dictionary
  const [channelDensitograms, setChannelDensitograms] = useState<{
    UV254?: TlcDensitogramData;
    UV366?: TlcDensitogramData;
    White?: TlcDensitogramData;
  }>({});

  const fileCsvRef = useRef<HTMLInputElement>(null);
  const fileImgRef = useRef<HTMLInputElement>(null);
  const fileBlankRef = useRef<HTMLInputElement>(null);
  const filePreRunRef = useRef<HTMLInputElement>(null);
  const bigCanvasRef = useRef<HTMLCanvasElement>(null);
  const densSvgRef = useRef<SVGSVGElement>(null);
  const [draggingCutoff, setDraggingCutoff] = useState(false);
  const cutoffDragRef = useRef<{
    scaleMax: number;
    plateSpan: number;
    noiseFloor: number;
  } | null>(null);
  const justDraggedCutoffRef = useRef(false);

  // Live horizontal pointer-drag for the Densitogram Cutoff guide line
  useEffect(() => {
    if (!draggingCutoff) return;
    const handlePointerMove = (e: PointerEvent) => {
      const drag = cutoffDragRef.current;
      const svg = densSvgRef.current;
      if (!drag || !svg) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const svgX = ((e.clientX - rect.left) / rect.width) * 320;
      const clampedX = Math.max(40, Math.min(270, svgX));
      const targetCutoff = ((clampedX - 40) / 230) * drag.scaleMax;
      const nextProm = spotProminenceForDensitogramCutoff(
        targetCutoff,
        drag.plateSpan,
        drag.noiseFloor
      );
      setSpotProminence(nextProm);
      if (nextProm >= 0.45) setSpotMode('broad');
      else if (nextProm <= 0.16) setSpotMode('sensitive');
      else setSpotMode('standard');
    };
    const handlePointerUp = () => {
      setDraggingCutoff(false);
      cutoffDragRef.current = null;
      justDraggedCutoffRef.current = true;
      window.setTimeout(() => {
        justDraggedCutoffRef.current = false;
      }, 120);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [draggingCutoff, setSpotProminence]);

  // Blank Silica Flat-Field Calibration (persisted once per camera/channel in IndexedDB)
  const [blankMeta, setBlankMeta] = useState<Partial<Record<TlcChannelKey, { name: string }>>>(() =>
    getBlankSilicaMeta()
  );
  const [blankEnabled, setBlankEnabled] = useState<boolean>(() => isBlankSilicaEnabled());
  // Lab PC pipeline toggles: curved-lane tracking (savgol_automiddle) & White-light faint-spot boost (saturate_white)
  const [automiddle, setAutomiddle] = useState<boolean>(() => isAutomiddleEnabled());
  const [boostWhiteSpots, setBoostWhiteSpots] = useState<boolean>(false);

  // AI Vision Final Plate QC Audit state
  const [qcLoading, setQcLoading] = useState(false);
  const [qcError, setQcError] = useState<string | null>(null);
  const [qcResult, setQcResult] = useState<TlcVisionQcResult | null>(null);
  const [qcChannel, setQcChannel] = useState<TlcChannelKey>('UV254');
  const [qcSelectedSpots, setQcSelectedSpots] = useState<Record<number, boolean>>({});
  const [qcSelectedFront, setQcSelectedFront] = useState<Record<number, boolean>>({});
  const [qcSelectedOrigin, setQcSelectedOrigin] = useState<Record<number, boolean>>({});

  // Modal spot dragging & fine interaction state for zoomed-in lane
  const [isDraggingModalSpot, setIsDraggingModalSpot] = useState(false);
  const dragModalSpotRef = useRef<{
    laneId: number;
    spotIndex: number;
    startPos: number;
    startRf: number;
    originDist: number;
    spanDist: number;
    laneLength: number;
    initialSpots: TlcSpot[];
  } | null>(null);
  const [hoveredModalSpotIdx, setHoveredModalSpotIdx] = useState<number | null>(null);

  const currentSet = sets[cur] || sets[0];
  const platesCount = run?.plates || 1;
  const selectablePlatesCount = useMemo(() => {
    let maxStored = 0;
    for (const s of sets) {
      if (s.plateData) {
        for (const k of Object.keys(s.plateData)) {
          const p = Number(k);
          if (Number.isFinite(p) && p > maxStored) maxStored = p;
        }
      }
    }
    return Math.max(platesCount, maxStored + 1);
  }, [platesCount, sets]);
  const isMultiSet = sets.length > 1;

  useEffect(() => {
    if (plate >= selectablePlatesCount) {
      setPlate(0);
    }
  }, [plate, selectablePlatesCount]);

  const activePlateSet = useMemo(
    () => getTlcPlateSlice(currentSet, plate),
    [currentSet, plate]
  );

  const plateSets = useMemo(
    () => sets.map((s) => getTlcPlateSlice(s, plate)),
    [sets, plate]
  );

  useEffect(() => {
    if (fullPlateChannel === 'composite') {
      if (!hasCompositeChannels(activePlateSet.imgs, false)) {
        const firstAvail = TLC_KEYS.find((k) => Boolean(activePlateSet.imgs?.[k]));
        if (firstAvail) setFullPlateChannel(firstAvail);
      }
    } else if (!activePlateSet.imgs?.[fullPlateChannel]) {
      const firstAvail = TLC_KEYS.find((k) => Boolean(activePlateSet.imgs?.[k]));
      if (firstAvail) setFullPlateChannel(firstAvail);
    }
  }, [activePlateSet, fullPlateChannel]);

  const setUidsKey = sets.map((s) => s.uid).join('|');

  // Restore saved images from IndexedDB (all plates) on mount or when run/set UIDs change
  useEffect(() => {
    let cancelled = false;
    const restoreCachedImages = async () => {
      let anyLoaded = false;
      const loadedBySetPlate: Array<{
        sIdx: number;
        pIdx: number;
        channel: string;
        isPreRun: boolean;
        entry: TlcImageEntry;
      }> = [];

      for (let sIdx = 0; sIdx < sets.length; sIdx++) {
        const s = sets[sIdx];
        try {
          const cachedAll = await getAllSetImages(s.uid);
          for (const cached of cachedAll) {
            if (cancelled) return;
            const { plateIndex: pIdx, channel, isPreRun } = parseTlcStorageKey(cached.key);
            const slice = getTlcPlateSlice(s, pIdx);
            const targetMap = isPreRun ? slice.preRunImgs : slice.imgs;
            if (!targetMap?.[channel]) {
              try {
                const entry = await decodeTlcImageBlob(
                  cached.blob,
                  cached.name,
                  channel as TlcChannelKey
                );
                if (!cancelled) {
                  loadedBySetPlate.push({
                    sIdx,
                    pIdx,
                    channel,
                    isPreRun,
                    entry,
                  });
                  anyLoaded = true;
                }
              } catch {
                // soft fail
              }
            }
          }
        } catch {
          // soft fail
        }
      }

      if (anyLoaded && !cancelled) {
        setSets((prev) => {
          const next = [...prev];
          for (const item of loadedBySetPlate) {
            if (next[item.sIdx]) {
              next[item.sIdx] = updateTlcPlateSlice(next[item.sIdx], item.pIdx, (slice) =>
                item.isPreRun
                  ? { preRunImgs: { ...(slice.preRunImgs || {}), [item.channel]: item.entry } }
                  : { imgs: { ...(slice.imgs || {}), [item.channel]: item.entry } }
              );
            }
          }
          return next;
        });
      }
    };
    restoreCachedImages();
    return () => {
      cancelled = true;
    };
  }, [setUidsKey, setSets]);

  // Clear cached 1D/2D profiles and auto front/origin across all sets & plates (e.g. when blank flat-field changes)
  const invalidateAllPlateCaches = useCallback(() => {
    setSets((prev) =>
      prev.map((s) => {
        const nextPlateData = s.plateData
          ? Object.fromEntries(
              Object.entries(s.plateData).map(([pK, pd]) => [
                pK,
                { ...pd, prof: {}, frontAuto: {}, frontAutoByLane: {}, originAuto: {}, originAutoByLane: {} },
              ])
            )
          : undefined;
        return {
          ...s,
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
          ...(nextPlateData ? { plateData: nextPlateData } : {}),
        };
      })
    );
  }, [setSets]);

  // Hydrate persisted Blank Silica Flat-Field reference photos from IndexedDB on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loadedAny = false;
      for (const ch of TLC_KEYS) {
        try {
          const rec = await getTlcImage(BLANK_SILICA_UID, ch);
          if (rec && !cancelled) {
            const bmp = await createImageBitmap(rec.blob);
            if (!cancelled) {
              setBlankSilicaRef(ch, { name: rec.name, bmp });
              loadedAny = true;
            }
          }
        } catch {
          // soft fail
        }
      }
      if (loadedAny && !cancelled) {
        setBlankMeta(getBlankSilicaMeta());
        invalidateAllPlateCaches();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invalidateAllPlateCaches]);

  const handleLoadBlankSilica = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    const assigned: string[] = [];
    const usedThisBatch: Record<string, TlcImageEntry> = {};
    for (const f of files) {
      const detected =
        tlcKeyOf(f.name, usedThisBatch) ||
        (fullPlateChannel !== 'composite' ? fullPlateChannel : 'UV254');
      try {
        const bmp = await createImageBitmap(f);
        setBlankSilicaRef(detected, { name: f.name, bmp });
        usedThisBatch[detected] = { name: f.name, bmp };
        await putTlcImage(BLANK_SILICA_UID, detected, f.name, f);
        assigned.push(detected);
      } catch (err: any) {
        toast(`Could not load blank silica photo ${f.name}: ${err?.message || err}`);
      }
    }
    if (assigned.length > 0) {
      setBlankSilicaEnabled(true);
      setBlankEnabled(true);
      setBlankMeta(getBlankSilicaMeta());
      invalidateAllPlateCaches();
      toast(
        `Calibrated blank silica flat-field reference for ${assigned.join(', ')}. Lamp shading & glare will now divide out automatically.`
      );
    }
    e.target.value = '';
  };

  const handleClearBlankSilica = async (key?: TlcChannelKey) => {
    clearBlankSilicaRef(key);
    await deleteTlcSetImages(BLANK_SILICA_UID, key ? [key] : TLC_KEYS);
    setBlankMeta(getBlankSilicaMeta());
    invalidateAllPlateCaches();
    toast(key ? `Removed blank silica reference for ${key}.` : 'Cleared all blank silica flat-field references.');
  };

  const handleToggleBlankSilica = (enabled: boolean) => {
    setBlankSilicaEnabled(enabled);
    setBlankEnabled(enabled);
    invalidateAllPlateCaches();
  };

  const handleToggleAutomiddle = (enabled: boolean) => {
    setAutomiddleEnabled(enabled);
    setAutomiddle(enabled);
    invalidateAllPlateCaches();
  };

  // Upload spotted-but-undeveloped pre-run reference photos (UV254, UV366, White) for the active plate.
  // Used to detect clean un-eluted origin dots and rigidly merge them with the developed plate.
  const handleLoadPreRunImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    toast(`Reading Plate ${plate + 1} undeveloped origin reference…`);

    const assigned: TlcChannelKey[] = [];
    const nextPre: Record<string, TlcImageEntry> = { ...(activePlateSet.preRunImgs || {}) };
    const usedThisBatch: Record<string, TlcImageEntry> = {};

    for (const f of files) {
      const detected =
        tlcKeyOf(f.name, usedThisBatch) ||
        (fullPlateChannel !== 'composite' ? fullPlateChannel : 'UV254');
      try {
        const entry = await decodeTlcImageBlob(f, f.name, detected);
        if (nextPre[detected]?.bmp?.close) {
          nextPre[detected].bmp.close();
        }
        nextPre[detected] = entry;
        usedThisBatch[detected] = entry;
        await putTlcImage(currentSet.uid, tlcPreRunStorageKey(detected, plate), f.name, f);
        if (!assigned.includes(detected)) assigned.push(detected);
      } catch (err: any) {
        toast(`Could not open undeveloped photo ${f.name}: ${err?.message || err}`);
      }
    }

    if (assigned.length > 0) {
      setSets((prev) => {
        const next = [...prev];
        if (!next[cur]) return next;
        next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => ({
          preRunImgs: nextPre,
          preRunEnabled: true,
          preRunAlignment: {},
          cfg: slice.cfg
            ? {
                ...slice.cfg,
                hasZeroRf: false,
                lanes: slice.cfg.lanes.map((l) => ({ ...l, zeroRf: null })),
              }
            : slice.cfg,
          originPx: null,
          originAuto: {},
          originAutoByLane: {},
        }));
        return next;
      });
      toast(
        `Loaded Plate ${plate + 1} undeveloped origin reference (${assigned.join(', ')}). Merging with developed plate origins automatically.`
      );
    }
    e.target.value = '';
  };

  const handleClearPreRunImage = async (key?: TlcChannelKey) => {
    const keysToDelete = key
      ? [tlcPreRunStorageKey(key, plate)]
      : TLC_KEYS.map((k) => tlcPreRunStorageKey(k, plate));
    await deleteTlcSetImages(currentSet.uid, keysToDelete);
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        const updatedPre: Record<string, TlcImageEntry> = { ...(slice.preRunImgs || {}) };
        if (key) {
          if (updatedPre[key]?.bmp?.close) updatedPre[key].bmp.close();
          delete updatedPre[key];
        } else {
          Object.values(updatedPre).forEach((im) => im?.bmp?.close?.());
          for (const k of Object.keys(updatedPre)) delete updatedPre[k];
        }
        return {
          preRunImgs: updatedPre,
          preRunAlignment: {},
          originAuto: {},
          originAutoByLane: {},
        };
      });
      return next;
    });
    toast(
      key
        ? `Removed Plate ${plate + 1} undeveloped ${key} reference (using developed-plate fallback).`
        : `Cleared Plate ${plate + 1} undeveloped origin references.`
    );
  };

  const handleTogglePreRun = (enabled: boolean) => {
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => ({
        preRunEnabled: enabled,
        preRunAlignment: {},
        cfg: slice.cfg
          ? {
              ...slice.cfg,
              hasZeroRf: false,
              lanes: slice.cfg.lanes.map((l) => ({ ...l, zeroRf: null })),
            }
          : slice.cfg,
        originPx: null,
        originAuto: {},
        originAutoByLane: {},
      }));
      return next;
    });
  };

  // Load Lane Config CSV (scoped to active plate)
  const handleLoadCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const cfg = parseLaneConfig(text);
      setSets((prev) => {
        const next = [...prev];
        next[cur] = updateTlcPlateSlice(next[cur], plate, {
          cfg,
          cfgName: file.name,
          cfgText: text,
          prof: {},
          frontAuto: {},
          originAuto: {},
          originAutoByLane: {},
        });
        return next;
      });
      toast(
        `Read ${cfg.lanes.length} lanes for Plate ${plate + 1} from ${file.name}.${
          cfg.warnings.length ? ' ' + cfg.warnings[0] : ''
        }`
      );
    } catch (err: any) {
      toast('Could not read lane CSV: ' + err.message);
    }
    e.target.value = '';
  };

  // Load Plate Images (UV254, White, UV366 — PNG/JPEG/WebP or lab PC .npy float32, plus optional lane CSV)
  const handleLoadImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    toast(`Reading Plate ${plate + 1} files…`);

    let loadedCount = 0;
    let npyCount = 0;
    let preFlatCount = 0;
    let loadedCfg: { cfg: TlcLaneConfig; name: string; text: string } | null = null;
    const newImgs: Record<string, TlcImageEntry> = { ...activePlateSet.imgs };

    for (const f of files) {
      // Allow dropping microadjusted_lane_config.csv / lane_config.csv right alongside plate images!
      if (/\.csv$/i.test(f.name)) {
        try {
          const text = await f.text();
          const cfg = parseLaneConfig(text);
          loadedCfg = { cfg, name: f.name, text };
        } catch (err: any) {
          toast(`Could not read lane CSV ${f.name}: ${err.message || err}`);
        }
        continue;
      }

      const key = tlcKeyOf(f.name, newImgs);
      if (!key) {
        toast(`Could not allocate channel for ${f.name}. All 3 channels (UV254, UV366, White) are already filled on Plate ${plate + 1}.`);
        continue;
      }
      try {
        const entry = await decodeTlcImageBlob(f, f.name, key);
        if (newImgs[key]?.bmp?.close) {
          newImgs[key].bmp.close();
        }
        newImgs[key] = entry;
        loadedCount++;
        if (entry.floatRgb) npyCount++;
        if (entry.preFlatFielded) preFlatCount++;
        // Persist to IndexedDB under plate-scoped key
        putTlcImage(currentSet.uid, tlcStorageKey(key, plate), f.name, f);
      } catch (err: any) {
        toast(`Could not open ${f.name}: ${err.message || err}`);
      }
    }

    if (loadedCount > 0 || loadedCfg) {
      setSets((prev) => {
        const next = [...prev];
        next[cur] = updateTlcPlateSlice(next[cur], plate, {
          ...(loadedCount > 0 ? { imgs: newImgs } : {}),
          ...(loadedCfg ? { cfg: loadedCfg.cfg, cfgName: loadedCfg.name, cfgText: loadedCfg.text } : {}),
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
        });
        return next;
      });
      setShow((prev) => ({ ...prev, UV254: true, UV366: true, White: true }));
      const notes: string[] = [];
      if (loadedCount > 0) {
        notes.push(`Loaded ${loadedCount} ${npyCount === loadedCount ? '.npy float32' : 'plate'} file${loadedCount === 1 ? '' : 's'} into Plate ${plate + 1}`);
      }
      if (preFlatCount > 0) {
        notes.push('already flat-fielded (skipped duplicate blank-silica correction)');
      }
      if (loadedCfg) {
        notes.push(
          `${loadedCfg.cfg.lanes.length} lanes from ${loadedCfg.name}${
            loadedCfg.cfg.warnings.length ? ' — ' + loadedCfg.cfg.warnings[0] : ''
          }`
        );
      } else if (!activePlateSet.cfg && loadedCount > 0) {
        notes.push('run Auto-detect lanes or load a Lane CSV');
      }
      toast(notes.join(' · ') + '.');
    }
    e.target.value = '';
  };

  // Find the lanes automatically from the two rows of origin dots (scoped to active plate).
  const handleAutoDetectLanes = () => {
    const keys = TLC_KEYS.filter((k) => activePlateSet.imgs[k]?.bmp);
    if (!keys.length) {
      toast(`Load a Plate ${plate + 1} image first.`);
      return;
    }
    try {
      let best: { det: ReturnType<typeof detectLaneRows>; label: string } | null = null;
      const renderedImages: Array<{ key: TlcChannelKey; img: ImageData }> = [];
      let compW = 0;
      let compH = 0;

      for (const k of keys) {
        const bmp = activePlateSet.imgs[k]!.bmp;
        const w = compW || Math.min(bmp.width, 1300);
        const h = compH || Math.max(1, Math.round((bmp.height * w) / bmp.width));
        if (!compW) {
          compW = w;
          compH = h;
        }
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        ctx.drawImage(bmp, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        renderedImages.push({ key: k, img: imgData });
        const det = detectLaneRows(imgData, w);
        if (!best || det.confidence > best.det.confidence) {
          best = { det, label: TLC_LABEL[k] };
        }
      }

      // Also test a fused multi-channel Composite image (UV254 + UV366 + White) so plates whose
      // origin dots are split across channels still get full comb & origin detection.
      if (renderedImages.length >= 2 && compW > 0 && compH > 0) {
        const nPx = compW * compH;
        const compData = new Uint8ClampedArray(nPx * 4);
        const chNorms = renderedImages.map(({ key, img }) => {
          const d = img.data;
          // Estimate clean plate background from interior samples
          const samples: number[] = [];
          const yA = Math.floor(compH * 0.2);
          const yB = Math.ceil(compH * 0.8);
          const xA = Math.floor(compW * 0.2);
          const xB = Math.ceil(compW * 0.8);
          const st = Math.max(1, Math.floor((yB - yA) / 24));
          const sx = Math.max(1, Math.floor((xB - xA) / 24));
          for (let y = yA; y < yB; y += st) {
            for (let x = xA; x < xB; x += sx) {
              const o = (y * compW + x) * 4;
              const v =
                key === 'UV254'
                  ? d[o + 1]
                  : key === 'UV366'
                  ? Math.max(d[o], d[o + 1], d[o + 2])
                  : 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
              samples.push(v);
            }
          }
          samples.sort((a, b) => a - b);
          const bg =
            key === 'UV366'
              ? samples[Math.floor(samples.length * 0.25)] ?? 18
              : samples[Math.floor(samples.length * 0.75)] ?? 220;
          return { key, data: d, bg };
        });

        for (let i = 0; i < nPx; i++) {
          const o = i * 4;
          let max1 = 0;
          let max2 = 0;
          for (let c = 0; c < chNorms.length; c++) {
            const cn = chNorms[c];
            let dev = 0;
            if (cn.key === 'UV254') {
              dev = Math.max(0, cn.bg - cn.data[o + 1]);
            } else if (cn.key === 'UV366') {
              dev = Math.max(0, Math.max(cn.data[o], cn.data[o + 1], cn.data[o + 2]) - cn.bg);
            } else {
              const luma = 0.299 * cn.data[o] + 0.587 * cn.data[o + 1] + 0.114 * cn.data[o + 2];
              dev = Math.max(0, cn.bg - luma);
            }
            if (dev > max1) {
              max2 = max1;
              max1 = dev;
            } else if (dev > max2) {
              max2 = dev;
            }
          }
          const fusedDrop = Math.min(220, max1 + 0.25 * max2);
          compData[o] = 18;
          compData[o + 1] = Math.max(0, Math.round(230 - fusedDrop));
          compData[o + 2] = 18;
          compData[o + 3] = 255;
        }

        const compDet = detectLaneRows({ data: compData, width: compW, height: compH }, compW);
        const compSeen = (compDet.lower?.seen ?? 0) + (compDet.upper?.seen ?? 0);
        const bestSeen = best ? (best.det.lower?.seen ?? 0) + (best.det.upper?.seen ?? 0) : 0;
        if (
          !best ||
          compDet.confidence > best.det.confidence ||
          (compDet.ok && compSeen > bestSeen + 2 && compDet.confidence >= best.det.confidence - 0.05)
        ) {
          best = { det: compDet, label: 'Composite' };
        }
      }

      if (!best || (!best.det.lower && !best.det.upper)) {
        toast('Could not find the origin dots. Try a plate image where they show clearly (UV 254 works best).');
        return;
      }
      const frameW = activePlateSet.frameW || LANE_FRAME_WIDTH;
      let cfg = laneConfigFromDetection(best.det, frameW);

      // When multiple channels OR pre-run undeveloped photos are loaded, let multi-channel + composite
      // (and pre-run merged) tlcOrigin refine the origin line across all loaded channels.
      const hasActivePreRun =
        activePlateSet.preRunEnabled !== false &&
        TLC_KEYS.some((k) => Boolean(activePlateSet.preRunImgs?.[k]?.bmp || activePlateSet.preRunImgs?.[k]?.floatRgb));
      if (keys.length >= 2 || hasActivePreRun) {
        const probeCfg = { ...cfg, lanes: cfg.lanes.map((l) => ({ ...l, zeroRf: null })) };
        const probeSet: TlcSet = {
          ...activePlateSet,
          cfg: probeCfg,
          frontPx: null,
          frontHalfPx: undefined,
          originPx: null,
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
          autoConf: {},
        };
        const getProf = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
        const halfMultiOk = new Set<number>();
        for (const hIdx of [0, 1]) {
          const sample = probeCfg.lanes.find((l) => tlcHalf(l) === hIdx);
          if (!sample) continue;
          tlcOrigin(probeSet, sample, getProf);
          if (probeSet.autoConf?.[`origin${hIdx}`]?.detected && (probeSet.originAuto?.[hIdx] ?? 0) > 10) {
            halfMultiOk.add(hIdx);
          }
        }
        if (halfMultiOk.size > 0) {
          cfg = {
            ...cfg,
            hasZeroRf: false,
            lanes: cfg.lanes.map((l) => (halfMultiOk.has(tlcHalf(l)) ? { ...l, zeroRf: null } : l)),
          };
        }
      }

      const prev = activePlateSet.cfg;
      const pKey = `${currentSet.uid}:p${plate}`;
      if (prev) {
        setCfgHistoryByPlate((m) => ({
          ...m,
          [pKey]: [...(m[pKey] || []).slice(-39), JSON.parse(JSON.stringify(prev))],
        }));
      }
      originalCfgRef.current[pKey] = JSON.parse(JSON.stringify(cfg));
      setSets((all) => {
        const next = [...all];
        next[cur] = updateTlcPlateSlice(next[cur], plate, {
          cfg,
          cfgName: 'Auto-detected lanes',
          cfgText: undefined,
          frontPx: null,
          frontHalfPx: undefined,
          originPx: null,
          edgePicks: undefined,
          edgeSettings: undefined,
          prof: {},
          frontAuto: {},
          originAuto: {},
          originAutoByLane: {},
        });
        return next;
      });
      const pct = Math.round(best.det.confidence * 100);
      const note = best.det.warnings[0] ? ' ' + best.det.warnings[0] : '';
      toast(
        best.det.ok
          ? `Plate ${plate + 1} lanes detected from ${best.label} (confidence ${pct}%).${note}`
          : `Plate ${plate + 1} lanes placed from ${best.label}, but confidence is low (${pct}%). Check them by eye.${note}`
      );
    } catch (err: any) {
      toast('Lane detection failed: ' + (err?.message || err));
    }
  };

  // Apply Default Standard 54-Lane 6x9 Grid (scoped to active plate)
  const handleApplyDefaultGrid = () => {
    const frameW = activePlateSet.frameW || LANE_FRAME_WIDTH;
    const cfg = createDefaultLaneConfig(frameW, 'two-tier');
    setSets((prev) => {
      const next = [...prev];
      next[cur] = updateTlcPlateSlice(next[cur], plate, {
        cfg,
        cfgName: 'Standard 6×9 Grid (54 Lanes)',
        prof: {},
        frontAuto: {},
        originAuto: {},
        originAutoByLane: {},
      });
      return next;
    });
    toast(`Applied standard 54-lane TLC grid to Plate ${plate + 1}.`);
  };

  // Copy calibrated lane geometry from Plate 1 to current plate
  const handleCopyLanesFromPlate1 = () => {
    const p1 = getTlcPlateSlice(currentSet, 0);
    if (!p1.cfg || plate === 0) return;
    const clonedCfg: TlcLaneConfig = JSON.parse(JSON.stringify(p1.cfg));
    const pKey = `${currentSet.uid}:p${plate}`;
    originalCfgRef.current[pKey] = JSON.parse(JSON.stringify(clonedCfg));
    setSets((prev) => {
      const next = [...prev];
      next[cur] = updateTlcPlateSlice(next[cur], plate, {
        cfg: clonedCfg,
        cfgName: `${p1.cfgName || 'Lanes'} (from Plate 1)`,
        cfgText: p1.cfgText,
        frameW: p1.frameW || LANE_FRAME_WIDTH,
        prof: {},
        frontAuto: {},
        originAuto: {},
        originAutoByLane: {},
      });
      return next;
    });
    toast(`Copied Plate 1 lane geometry to Plate ${plate + 1}.`);
  };

  // Load Synthetic Demo TLC Plate as a new, separate set
  const handleLoadDemoTlc = async () => {
    try {
      toast('Generating demonstration TLC plate…');
      const demo = await createDemoTlcDataSet();
      const uv254Bmp = await createImageBitmap(demo.uv254Blob);
      const uv366Bmp = await createImageBitmap(demo.uv366Blob);

      const demoUid = 'demo_' + Math.random().toString(36).slice(2, 10);
      const demoSet: TlcSet = {
        uid: demoUid,
        name: `Demo Set ${sets.length + 1}`,
        cfg: demo.config,
        cfgName: demo.configName,
        frameW: LANE_FRAME_WIDTH,
        frontPx: null,
        frontAuto: {},
        imgs: {
          UV254: { name: 'demo_UV254.png', bmp: uv254Bmp },
          UV366: { name: 'demo_UV366.png', bmp: uv366Bmp },
        },
        prof: {},
      };

      // Persist demo images to IndexedDB
      await putTlcImage(demoUid, 'UV254', 'demo_UV254.png', demo.uv254Blob);
      await putTlcImage(demoUid, 'UV366', 'demo_UV366.png', demo.uv366Blob);

      setSets((prev) => [...prev, demoSet]);
      setCur(sets.length);
      setShow((prev) => ({ ...prev, UV254: true, UV366: true }));
      setFullPlateChannel('UV254');
      toast('Created new demo set with sample UV 254 nm & 365 nm plates.');
    } catch (err: any) {
      toast('Could not generate demo TLC plate: ' + (err.message || err));
    }
  };

  // Add new TLC Set
  const handleAddSet = () => {
    setSets((prev) => [...prev, tlcNewSet(prev.length + 1)]);
    setCur(sets.length);
  };

  // Remove or clear TLC Set
  const handleRemoveSetIndex = (indexToRemove: number) => {
    const setToRemove = sets[indexToRemove];
    if (!setToRemove) return;
    Object.values(setToRemove.imgs || {}).forEach((im) => im.bmp?.close && im.bmp.close());
    if (setToRemove.plateData) {
      Object.values(setToRemove.plateData).forEach((pd) => {
        Object.values(pd?.imgs || {}).forEach((im) => im.bmp?.close && im.bmp.close());
      });
    }
    deleteAllSetImages(setToRemove.uid);

    if (sets.length > 1) {
      setSets((prev) => prev.filter((_, i) => i !== indexToRemove));
      setCur((prev) => {
        if (prev === indexToRemove) {
          return Math.max(0, prev - 1);
        }
        return prev > indexToRemove ? prev - 1 : prev;
      });
      if (sets.length - 1 < 2) setCompare(false);
      toast(`Removed "${setToRemove.name}".`);
    } else {
      // If it's the only set, reset it to a clean blank default
      setSets([tlcNewSet(1)]);
      setCur(0);
      setCompare(false);
      toast(`Cleared "${setToRemove.name}".`);
    }
  };

  // Remove individual channel image from active plate of current set
  const handleRemoveImage = (key: TlcChannelKey) => {
    const im = activePlateSet.imgs[key];
    if (im?.bmp?.close) im.bmp.close();
    deleteTlcSetImages(currentSet.uid, [tlcStorageKey(key, plate)]);
    setSets((prev) => {
      const next = [...prev];
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        const newImgs = { ...slice.imgs };
        delete newImgs[key];
        return {
          imgs: newImgs,
          prof: {},
          frontAuto: {},
          originAuto: {},
          originAutoByLane: {},
        };
      });
      return next;
    });
    toast(`Removed ${TLC_LABEL[key]} image from Plate ${plate + 1}.`);
  };

  // ---- Edge-effect correction (fitted per half of each plate inside every set) ----
  const [pickMode, setPickMode] = useState(false);
  const [pickGroup, setPickGroup] = useState(0);
  const edgeCache = useRef(new Map<string, { key: string; fits: (EdgeFit | null)[] }>());

  const detectOptsFor = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => {
      const prof = extractLaneProfile(set, key, lane, coreFraction);
      if (!prof.length) return null;
      const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
      const origin = tlcOrigin(set, lane, get);
      const front = tlcFront(set, lane, get);
      const plateHistogram = getChannelHistogram(set, key, get);
      const lane2d = getLane2dMetrics(set, key, lane, coreFraction);
      const frontBandBg = getChannelFrontBandProfile(set, key, tlcHalf(lane), get);
      return {
        prof,
        origin,
        opts: {
          sign: TLC_SIGNAL[key].sign,
          origin,
          front,
          radius: lane.spotRadius || 24,
          minProminence: spotProminence,
          plateHistogram,
          lane2d,
          frontBandBg,
          detectorMode: set.spotDetectorMode,
          minSpotWidthFrac: set.minSpotWidthFrac,
        },
      };
    },
    [coreFraction, spotProminence]
  );

  // Plate-wide shared-reagent cross-lane coherence cache: rescues faint spots that appear
  // consistently at the same Rf across >= 3 wells sharing a starting material from the run recipe.
  const coherenceCache = useRef(new Map<string, { key: string; map: Map<number, TlcSpot[]> }>());
  const getCoherenceRescuedMap = useCallback(
    (set: TlcSet, key: TlcChannelKey): Map<number, TlcSpot[]> => {
      const emptyMap = new Map<number, TlcSpot[]>();
      if (!run?.rows?.length || !set.cfg?.lanes?.length || !set.imgs?.[key]?.bmp) return emptyMap;
      const cacheId = `${set.uid}:p${plate}:${key}`;
      const sig = `${spotProminence}|${coreFraction}|${set.spotDetectorMode || '2d'}|${set.minSpotWidthFrac ?? DEFAULT_MIN_SPOT_WIDTH_FRAC}|${set.imgs[key]?.name || ''}|${set.cfg.lanes.length}|${run.rows.length}|${set.frontPx ?? ''}|${JSON.stringify(set.frontHalfPx || '')}|${set.originPx ?? ''}`;
      const hit = coherenceCache.current.get(cacheId);
      if (hit && hit.key === sig) return hit.map;

      const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
      const plateHistogram = getChannelHistogram(set, key, get);
      const relaxedProm = Math.max(0.08, +(spotProminence * 0.52).toFixed(3));
      const plateRowsByVial = new Map<number, string[]>();
      for (const row of run.rows) {
        if (row.plate_number !== plate) continue;
        const codes = (row.recipe || [])
          .filter((rc) => Number(rc.target_concentration) > 0)
          .map((rc) => rc.code);
        if (codes.length > 0) plateRowsByVial.set(row.container_id, codes);
      }

      const inputs: Parameters<typeof rescueSharedReagentSpots>[0] = [];
      for (const l of set.cfg.lanes) {
        if (l.id < 0 || l.id > 53) continue;
        const vialId = containerOfLane(l.id);
        const reagentCodes = plateRowsByVial.get(vialId);
        if (!reagentCodes || reagentCodes.length === 0) continue;
        const prof = get(set, key, l);
        if (!prof.length) continue;
        const oVal = tlcOrigin(set, l, get);
        const fVal = tlcFront(set, l, get);
        const lane2d = getLane2dMetrics(set, key, l, coreFraction);
        const frontBandBg = getChannelFrontBandProfile(set, key, tlcHalf(l), get);
        const soloSpots = findSpots(prof, {
          sign: TLC_SIGNAL[key].sign,
          origin: oVal,
          front: fVal,
          radius: l.spotRadius || 24,
          minProminence: spotProminence,
          plateHistogram,
          lane2d,
          frontBandBg,
          detectorMode: set.spotDetectorMode,
          minSpotWidthFrac: set.minSpotWidthFrac,
        });
        const relaxedCandidates =
          relaxedProm < spotProminence - 0.02
            ? findSpots(prof, {
                sign: TLC_SIGNAL[key].sign,
                origin: oVal,
                front: fVal,
                radius: l.spotRadius || 24,
                minProminence: relaxedProm,
                plateHistogram,
                lane2d,
                frontBandBg,
                detectorMode: set.spotDetectorMode,
                minSpotWidthFrac: set.minSpotWidthFrac,
              })
            : [];
        inputs.push({
          laneId: l.id,
          reagentCodes,
          origin: oVal,
          front: fVal,
          soloSpots,
          relaxedCandidates,
        });
      }

      const rescued = inputs.length >= 3 ? rescueSharedReagentSpots(inputs, 0.025) : emptyMap;
      if (coherenceCache.current.size > 30) coherenceCache.current.clear();
      coherenceCache.current.set(cacheId, { key: sig, map: rescued });
      return rescued;
    },
    [run, plate, spotProminence, coreFraction]
  );

  const getEdgeFits = useCallback(
    (set: TlcSet): (EdgeFit | null)[] => {
      const picks = set.edgePicks || [];
      const cacheMapKey = `${set.uid}:p${plate}`;
      const key = `${spotProminence}|${coreFraction}|${set.spotDetectorMode || '2d'}|${set.minSpotWidthFrac ?? DEFAULT_MIN_SPOT_WIDTH_FRAC}|${JSON.stringify(picks)}|${Object.keys(set.imgs || {}).join()}|${set.cfg?.lanes?.length || 0}`;
      const hit = edgeCache.current.get(cacheMapKey);
      if (hit && hit.key === key) return hit.fits;
      const loadedChs = getLoadedTlcChannels(set.imgs, false);
      let fits: (EdgeFit | null)[] = [null, null];
      if (loadedChs.length > 0 && set.cfg) {
        const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
        const auto: EdgePoint[][] = [[], []];
        for (const lane of set.cfg.lanes) {
          if (lane.id < 0 || lane.id > 53) continue;
          const oVal = tlcOrigin(set, lane, get);
          const fVal = tlcFront(set, lane, get);
          let laneSpots: TlcSpot[];
          if (lane.customSpots && lane.customSpots.length > 0) {
            laneSpots = lane.customSpots;
          } else {
            const profiles: Partial<Record<TlcChannelKey, number[]>> = {};
            const histograms: Partial<Record<TlcChannelKey, ReturnType<typeof getChannelHistogram>>> = {};
            const lane2dByChannel: Partial<Record<TlcChannelKey, ReturnType<typeof getLane2dMetrics>>> = {};
            const frontBandByChannel: Partial<Record<TlcChannelKey, number[]>> = {};
            const halfIdx = tlcHalf(lane);
            for (const ch of loadedChs) {
              const p = get(set, ch, lane);
              if (p && p.length >= 10) {
                profiles[ch] = p;
                const chHist = getChannelHistogram(set, ch, get);
                if (chHist) histograms[ch] = chHist;
                const m2d = getLane2dMetrics(set, ch, lane, coreFraction);
                if (m2d) lane2dByChannel[ch] = m2d;
                const fBg = getChannelFrontBandProfile(set, ch, halfIdx, get);
                if (fBg) frontBandByChannel[ch] = fBg;
              }
            }
            laneSpots = findMultiChannelSpots({
              profiles,
              origin: oVal,
              front: fVal,
              radius: lane.spotRadius || 24,
              minProminence: spotProminence,
              histograms,
              lane2dByChannel,
              frontBandByChannel,
              detectorMode: set.spotDetectorMode,
              minSpotWidthFrac: set.minSpotWidthFrac,
            });
          }
          for (const sp of laneSpots) {
            if (sp.rf > 0.05 && sp.rf < 0.98 && (sp.source === 'manual' || sp.source === 'adjusted' || sp.strength > 0.15)) {
              auto[tlcHalf(lane)].push({ lane: lane.id, x: lane.x0, h: sp.pos - oVal });
            }
          }
        }
        fits = [0, 1].map((h) => {
          const mine = picks.filter((q) => (q.lane < 27 ? 0 : 1) === h);
          if (mine.length) {
            const groups = new Map<number, EdgePoint[]>();
            for (const q of mine) {
              const lane = set.cfg!.lanes.find((l) => l.id === q.lane);
              if (!lane) continue;
              const o = tlcOrigin(set, lane, get);
              const span = Math.max(1, tlcFront(set, lane, get) - o);
              const pt = { lane: q.lane, x: lane.x0, h: q.pos - o, rf: (q.pos - o) / span };
              groups.set(q.group, [...(groups.get(q.group) || []), pt]);
            }
            const laneXs = set.cfg!.lanes.filter((l) => tlcHalf(l) === h).map((l) => l.x0);
            return fitEdgePicks([...groups.values()], laneXs);
          }
          return auto[h].length ? fitEdgeCurve(auto[h]) : null;
        });
      }
      if (edgeCache.current.size > 40) edgeCache.current.clear();
      edgeCache.current.set(cacheMapKey, { key, fits });
      return fits;
    },
    [plate, spotProminence, coreFraction]
  );

  const handlePickSpot = useCallback(
    (laneId: number, pos: number) => {
      const uid = currentSet.uid;
      const curPicks = activePlateSet.edgePicks || [];
      const same = curPicks.findIndex((q) => q.lane === laneId && Math.abs(q.pos - pos) < 6);
      let updated: EdgePick[];
      // clicking a picked spot again removes it
      if (same >= 0) {
        updated = curPicks.filter((_, i) => i !== same);
      } else {
        // one pick per lane and compound
        const rest = curPicks.filter((q) => !(q.lane === laneId && q.group === pickGroup));
        updated = [...rest, { lane: laneId, pos, group: pickGroup }];
      }
      setSets((allSets) =>
        allSets.map((s) =>
          s.uid === uid ? updateTlcPlateSlice(s, plate, { edgePicks: updated }) : s
        )
      );
    },
    [currentSet.uid, activePlateSet.edgePicks, pickGroup, plate, setSets]
  );

  const handleEdgeSetting = useCallback(
    (h: number, st: EdgeSetting) => {
      const uid = currentSet.uid;
      setSets((prev) =>
        prev.map((s) =>
          s.uid === uid
            ? updateTlcPlateSlice(s, plate, (slice) => ({
                edgeSettings: { ...(slice.edgeSettings || {}), [h]: st },
              }))
            : s
        )
      );
    },
    [currentSet.uid, plate, setSets]
  );

  const handleClearPicks = useCallback(() => {
    const uid = currentSet.uid;
    setSets((prev) =>
      prev.map((s) => (s.uid === uid ? updateTlcPlateSlice(s, plate, { edgePicks: [] }) : s))
    );
  }, [currentSet.uid, plate, setSets]);

  const edgeSettingFor = useCallback(
    (set: TlcSet, half: number): EdgeSetting => set.edgeSettings?.[half] || DEFAULT_EDGE_SETTING,
    []
  );

  // Get Spots helper for a set, channel, and lane with center-weighted core sampling.
  // When the edge-effect correction is active for the lane's half, Rf is corrected and the
  // measured value is kept in rfRaw.
  const getSpotsForLane = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane): TlcSpot[] | null => {
      if (!set.imgs[key]) return null;
      const d = detectOptsFor(set, key, lane);
      if (!d) return null;
      let autoSpots = findSpots(d.prof, d.opts);
      const rescued = getCoherenceRescuedMap(set, key).get(lane.id);
      if (rescued && rescued.length > 0) {
        const merged = [...autoSpots];
        for (const sp of rescued) {
          if (!merged.some((m) => Math.abs(m.rf - sp.rf) < 0.025)) {
            merged.push(sp);
          }
        }
        merged.sort((a, b) => a.pos - b.pos);
        autoSpots = merged;
      }
      const spots = getEffectiveLaneSpots(lane, autoSpots);
      if (!spots.length) return spots;
      const h = tlcHalf(lane);
      const setting = edgeSettingFor(set, h);
      if (setting.mode === 'off') return spots;
      const fit = getEdgeFits(set)[h];
      if (!edgeActive(fit, setting)) return spots;
      return correctSpots(spots, edgeGain(fit, lane.x0, setting.strength), edgeOffset(fit, lane.x0, setting.strength));
    },
    [detectOptsFor, getCoherenceRescuedMap, edgeSettingFor, getEdgeFits]
  );

  // Unified 3-channel spot detection across UV254, UV366, and White for Composite mode
  const getCompositeSpotsForLane = useCallback(
    (set: TlcSet, lane: TlcLane): TlcSpot[] | null => {
      const loaded = getLoadedTlcChannels(set.imgs, false);
      if (!loaded.length) return null;
      const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
      const origin = tlcOrigin(set, lane, get);
      const front = tlcFront(set, lane, get);
      const profiles: Partial<Record<TlcChannelKey, number[]>> = {};
      const histograms: Partial<Record<TlcChannelKey, ReturnType<typeof getChannelHistogram>>> = {};
      const lane2dByChannel: Partial<Record<TlcChannelKey, ReturnType<typeof getLane2dMetrics>>> = {};
      const frontBandByChannel: Partial<Record<TlcChannelKey, number[]>> = {};
      const halfIdx = tlcHalf(lane);
      for (const ch of loaded) {
        const p = get(set, ch, lane);
        if (p && p.length >= 10) {
          profiles[ch] = p;
          const chHist = getChannelHistogram(set, ch, get);
          if (chHist) histograms[ch] = chHist;
          const m2d = getLane2dMetrics(set, ch, lane, coreFraction);
          if (m2d) lane2dByChannel[ch] = m2d;
          const fBg = getChannelFrontBandProfile(set, ch, halfIdx, get);
          if (fBg) frontBandByChannel[ch] = fBg;
        }
      }
      let autoSpots = findMultiChannelSpots({
        profiles,
        origin,
        front,
        radius: lane.spotRadius || 24,
        minProminence: spotProminence,
        histograms,
        lane2dByChannel,
        frontBandByChannel,
        detectorMode: set.spotDetectorMode,
        minSpotWidthFrac: set.minSpotWidthFrac,
      });
      // Include cross-lane shared-reagent rescued spots from any loaded channel
      const rescuedByCh: Partial<Record<TlcChannelKey, TlcSpot[]>> = {};
      let hasRescued = false;
      for (const ch of loaded) {
        const r = getCoherenceRescuedMap(set, ch).get(lane.id);
        if (r && r.length > 0) {
          rescuedByCh[ch] = r;
          hasRescued = true;
        }
      }
      if (hasRescued) {
        const mergedRescued = mergeMultiChannelSpots(rescuedByCh, 0.024);
        const combined = [...autoSpots];
        for (const sp of mergedRescued) {
          if (!combined.some((m) => Math.abs(m.rf - sp.rf) < 0.024)) {
            combined.push(sp);
          }
        }
        combined.sort((a, b) => a.rf - b.rf || a.pos - b.pos);
        autoSpots = combined;
      }
      const spots = getEffectiveLaneSpots(lane, autoSpots);
      if (!spots.length) return spots;
      const h = tlcHalf(lane);
      const setting = edgeSettingFor(set, h);
      if (setting.mode === 'off') return spots;
      const fit = getEdgeFits(set)[h];
      if (!edgeActive(fit, setting)) return spots;
      return correctSpots(spots, edgeGain(fit, lane.x0, setting.strength), edgeOffset(fit, lane.x0, setting.strength));
    },
    [coreFraction, spotProminence, getCoherenceRescuedMap, edgeSettingFor, getEdgeFits]
  );

  // Helper to extract panels for lane t (always using unified multi-channel spots so Grid, Full Plate, and Modal agree 1-to-1)
  const getPanelsForLane = useCallback(
    (t: number): LanePanel[] => {
      if (compare && isMultiSet) {
        return plateSets
          .map((s, idx): LanePanel | null => {
            const lane = s.cfg?.lanes.find((l) => l.id === t);
            if (!lane || !s.imgs[cmpKey]) return null;
            const spots = markSpots ? getCompositeSpotsForLane(s, lane) : null;
            return {
              s,
              i: idx,
              key: cmpKey,
              lane,
              label: tlcLetter(idx),
              spots,
            };
          })
          .filter((p): p is LanePanel => p !== null);
      }

      const s = activePlateSet;
      const lane = s.cfg?.lanes.find((l) => l.id === t);
      if (!lane) return [];
      const unifiedSpots = markSpots ? getCompositeSpotsForLane(s, lane) : null;
      return TLC_KEYS.filter((k) => s.imgs[k] && show[k])
        .map((k): LanePanel => ({
          s,
          i: cur,
          key: k,
          lane,
          label: '',
          spots: unifiedSpots,
        }));
    },
    [compare, isMultiSet, plateSets, cmpKey, activePlateSet, cur, show, markSpots, getCompositeSpotsForLane]
  );

  // Big modal inspection drawing: UV 254, UV 365 Fluorescence, and Composite side by side
  const inspectPanels = useMemo(() => {
    if (inspectWell === null || !activePlateSet.cfg) return [];
    const t = tlcLane(inspectWell, 'column');
    const lane = activePlateSet.cfg.lanes.find((l) => l.id === t);
    if (!lane) return [];

    const unifiedSpots = markSpots ? getCompositeSpotsForLane(activePlateSet, lane) : null;

    // Individual channel view (if user explicitly chooses only one channel photo)
    if (densViewMode === 'UV254' && activePlateSet.imgs.UV254) {
      return [{
        s: activePlateSet,
        i: cur,
        key: 'UV254' as TlcChannelKey,
        lane,
        label: 'UV 254 nm',
        channelTitle: 'UV 254 (Absorbance)',
        spots: unifiedSpots,
      }];
    }
    if (densViewMode === 'UV366' && activePlateSet.imgs.UV366) {
      return [{
        s: activePlateSet,
        i: cur,
        key: 'UV366' as TlcChannelKey,
        lane,
        label: 'UV 365 nm',
        channelTitle: 'UV 365 (Fluorescence)',
        spots: unifiedSpots,
      }];
    }
    if (densViewMode === 'White' && activePlateSet.imgs.White) {
      return [{
        s: activePlateSet,
        i: cur,
        key: 'White' as TlcChannelKey,
        lane,
        label: 'Visible',
        channelTitle: 'Visible Stain',
        spots: unifiedSpots,
      }];
    }

    // Default Side-by-Side: UV 254 (Absorbance), UV 365 (Fluorescence), and Composite
    const panels: Array<LanePanel & { isComposite?: boolean; channelTitle?: string }> = [];

    // 1. UV 254 nm Absorbance (Quenching)
    if (activePlateSet.imgs.UV254) {
      panels.push({
        s: activePlateSet,
        i: cur,
        key: 'UV254',
        lane,
        label: 'UV 254 nm',
        channelTitle: 'UV 254 (Absorbance)',
        spots: unifiedSpots,
      });
    }

    // 2. UV 365 nm Fluorescence
    if (activePlateSet.imgs.UV366) {
      panels.push({
        s: activePlateSet,
        i: cur,
        key: 'UV366',
        lane,
        label: 'UV 365 nm',
        channelTitle: 'UV 365 (Fluorescence)',
        spots: unifiedSpots,
      });
    }

    // 3. Multi-Channel False-Color Composite Overlay (any 2+ of UV254, UV366, White)
    if (hasCompositeChannels(activePlateSet.imgs, false)) {
      const compositeBaseKey = getLoadedTlcChannels(activePlateSet.imgs, false)[0] || 'UV254';
      panels.push({
        s: activePlateSet,
        i: cur,
        key: compositeBaseKey,
        lane,
        label: '✨ Composite',
        channelTitle: '✨ Composite (All Channels)',
        isComposite: true,
        spots: unifiedSpots,
      });
    }

    // 4. Visible Light / Stain (if present)
    if (activePlateSet.imgs.White) {
      panels.push({
        s: activePlateSet,
        i: cur,
        key: 'White',
        lane,
        label: 'Visible',
        channelTitle: 'Visible (Stain)',
        spots: unifiedSpots,
      });
    }

    return panels.length > 0 ? panels : getPanelsForLane(t);
  }, [inspectWell, activePlateSet, cur, densViewMode, markSpots, getCompositeSpotsForLane, getPanelsForLane]);

  // Memoized panels for all 54 wells in the plate grid (only computed when viewing 54-well grid)
  const allPanels = useMemo(() => {
    if (viewMode !== 'grid') return [];
    return Array.from({ length: 54 }, (_, wellIndex) => {
      const laneId = tlcLane(wellIndex, 'column');
      return getPanelsForLane(laneId);
    });
  }, [viewMode, getPanelsForLane]);

  // Exact vertical height of the enlarged TLC lane canvas (1:1 pixel scale)
  const inspectHeight = useMemo(() => {
    if (!inspectPanels.length) return 380;
    return Math.round(Math.max(...inspectPanels.map((p) => 1.0 * p.lane.length)));
  }, [inspectPanels]);

  useEffect(() => {
    if (inspectWell !== null && bigCanvasRef.current && inspectPanels.length > 0) {
      // Omit raw per-channel canvas tick marks in the zoomed modal because the interactive
      // full-width guidelines above render the canonical unified modalActiveSpots 1-to-1.
      drawLanePanels(bigCanvasRef.current, inspectPanels, 1.0, filters, false, false, boostWhiteSpots);

      // Extract distinct densitograms for all available channels
      const newDens: { UV254?: TlcDensitogramData; UV366?: TlcDensitogramData; White?: TlcDensitogramData } = {};
      const primary = inspectPanels[0];

      if (primary) {
        const s = primary.s;
        const l = primary.lane;
        const origin = tlcOrigin(s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
        const front = tlcFront(s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
        const h = tlcHalf(l);
        const setting = edgeSettingFor(s, h);
        const fit = getEdgeFits(s)[h];
        const isCorr = edgeActive(fit, setting);
        const gain = isCorr && fit ? edgeGain(fit, l.x0, setting.strength) : 1;
        const offset = isCorr && fit ? edgeOffset(fit, l.x0, setting.strength) : 0;

        for (const k of TLC_KEYS) {
          if (s.imgs[k]) {
            const prof = extractLaneProfile(s, k, l, coreFraction);
            const getDensProf = (st: TlcSet, ck: TlcChannelKey, ln: TlcLane) =>
              extractLaneProfile(st, ck, ln, coreFraction);
            const rawDens = extractDensitogram(prof, {
              sign: TLC_SIGNAL[k].sign,
              origin,
              front,
              radius: l.spotRadius || 24,
              minProminence: spotProminence,
              plateHistogram: getChannelHistogram(s, k, getDensProf),
              lane2d: getLane2dMetrics(s, k, l, coreFraction),
              frontBandBg: getChannelFrontBandProfile(s, k, h, getDensProf),
              detectorMode: s.spotDetectorMode,
              minSpotWidthFrac: s.minSpotWidthFrac,
            });
            const baseSpots = getEffectiveLaneSpots(l, rawDens.spots);
            const corrSpots = isCorr ? correctSpots(baseSpots, gain, offset) : baseSpots;
            newDens[k] = { ...rawDens, spots: corrSpots };
          }
        }
      }
      setChannelDensitograms(newDens);
    }
  }, [inspectWell, inspectPanels, filters, markSpots, coreFraction, spotProminence, edgeSettingFor, getEdgeFits, boostWhiteSpots]);

  // Keyboard listener inside well inspection modal for instant nudging and tilt
  useEffect(() => {
    if (inspectWell === null || !activePlateSet.cfg) return;
    const laneId = tlcLane(inspectWell, 'column');
    const targetLane = activePlateSet.cfg.lanes.find((l) => l.id === laneId);
    if (!targetLane) return;

    const handleModalKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const step = e.shiftKey ? 5 : 1;
      const angleStep = e.shiftKey ? 1.0 : 0.2;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          handleUpdateLane(laneId, { x0: Math.round(targetLane.x0 - step) });
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleUpdateLane(laneId, { x0: Math.round(targetLane.x0 + step) });
          break;
        case 'ArrowUp':
          e.preventDefault();
          handleUpdateLane(laneId, { y0: Math.round(targetLane.y0 - step) });
          break;
        case 'ArrowDown':
          e.preventDefault();
          handleUpdateLane(laneId, { y0: Math.round(targetLane.y0 + step) });
          break;
        case 'q':
        case 'Q':
        case '[':
          e.preventDefault();
          handleUpdateLane(laneId, { angle: +(targetLane.angle - angleStep).toFixed(2) });
          break;
        case 'e':
        case 'E':
        case ']':
          e.preventDefault();
          handleUpdateLane(laneId, { angle: +(targetLane.angle + angleStep).toFixed(2) });
          break;
        case '-':
        case '_':
          e.preventDefault();
          handleUpdateLane(laneId, { width: Math.max(8, Math.round(targetLane.width - (e.shiftKey ? 4 : 2))) });
          break;
        case '=':
        case '+':
          e.preventDefault();
          handleUpdateLane(laneId, { width: Math.round(targetLane.width + (e.shiftKey ? 4 : 2)) });
          break;
        case 'Escape':
          e.preventDefault();
          setInspectWell(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleModalKeyDown);
    return () => window.removeEventListener('keydown', handleModalKeyDown);
  }, [inspectWell, activePlateSet.cfg]);

  // Handle Mouse Move on Enlarged Canvas or Densitometer with Intelligent Peak Snapping
  const handleCanvasMouseMove = (e: React.MouseEvent<any>) => {
    if (isDraggingModalSpot) return;
    if (!bigCanvasRef.current || inspectPanels.length === 0) return;
    const rect = bigCanvasRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Detect which specific panel the cursor is over in multi-channel/compare mode
    let panelIdx = 0;
    let currX = 0;
    const gap = Math.max(3, Math.round(1.0 * 6));
    for (let j = 0; j < inspectPanels.length; j++) {
      const pw = Math.round(1.0 * inspectPanels[j].lane.width);
      if (mouseX >= currX && mouseX <= currX + pw + gap) {
        panelIdx = j;
        break;
      }
      currX += pw + gap;
    }
    const targetPanel = inspectPanels[panelIdx] || inspectPanels[0];
    const l = targetPanel.lane;
    const ph = 1.0 * l.length;
    const zeroDist = tlcOrigin(targetPanel.s, l, (s, k, ln) => extractLaneProfile(s, k, ln, coreFraction));
    const frontPos = tlcFront(targetPanel.s, l, (s, k, ln) => extractLaneProfile(s, k, ln, coreFraction));
    const span = Math.max(1, frontPos - zeroDist);

    // Unconstrained pos from bottom (0 = bottom, ph = top)
    const rawPos = ph - mouseY;

    // Check if cursor is within 16px of a detected spot apex on this target panel
    const spots = targetPanel.spots || modalActiveSpots;
    const nearSpotIdx = spots.findIndex((sp) => Math.abs(sp.pos - rawPos) <= 16);
    const nearSpot = nearSpotIdx >= 0 ? spots[nearSpotIdx] : null;

    let activePos = rawPos;
    let activeSpot: TlcSpot | null = null;

    if (nearSpot) {
      activePos = nearSpot.pos;
      activeSpot = nearSpot;
      setHoveredModalSpotIdx(nearSpotIdx);
    } else {
      setHoveredModalSpotIdx(null);
      // Local maximum check in profile within ±10 px
      const snapKeys: TlcChannelKey[] = (targetPanel as any).isComposite
        ? getLoadedTlcChannels(targetPanel.s.imgs, false)
        : [targetPanel.key];
      let best = Math.round(rawPos);
      let bestNorm = -Infinity;
      for (const sk of snapKeys) {
        const prof = extractLaneProfile(targetPanel.s, sk, l, coreFraction);
        if (!prof.length) continue;
        const sg = TLC_SIGNAL[sk].sign;
        let chBest = Math.round(rawPos);
        for (let d = -10; d <= 10; d++) {
          const x = Math.round(rawPos) + d;
          if (
            x >= 0 &&
            x < prof.length &&
            sg * prof[x] > sg * prof[Math.max(0, Math.min(prof.length - 1, chBest))]
          ) {
            chBest = x;
          }
        }
        const score = sg * (prof[Math.max(0, Math.min(prof.length - 1, chBest))] - prof[Math.max(0, Math.min(prof.length - 1, Math.round(rawPos)))]);
        if (score > bestNorm) {
          bestNorm = score;
          best = chBest;
        }
      }
      const refProf = extractLaneProfile(targetPanel.s, snapKeys[0] || targetPanel.key, l, coreFraction);
      activePos = Math.max(0, Math.min(Math.max(0, refProf.length - 1), best));
    }

    // Compute Rf (unclamped at top so positions beyond front aren't falsely reported as exactly 1.00)
    const rawRf = Math.max(0, (activePos - zeroDist) / span);
    const snappedY = ph - activePos;

    const h = tlcHalf(l);
    const setting = edgeSettingFor(targetPanel.s, h);
    const fit = getEdgeFits(targetPanel.s)[h];
    const isCorr = edgeActive(fit, setting);
    const gain = isCorr && fit ? edgeGain(fit, l.x0, setting.strength) : 1;
    const offset = isCorr && fit ? edgeOffset(fit, l.x0, setting.strength) : 0;
    const corrRf = isCorr && gain > 0 ? Math.max(0, Math.min(1.2, (rawRf - offset) / gain)) : rawRf;

    const finalRf = activeSpot ? activeSpot.rf : corrRf;
    setHoverRf(Number(finalRf.toFixed(3)));
    setHoverY(snappedY);
    setHoverSpot(
      activeSpot ||
        (isCorr && (Math.abs(gain - 1) >= 0.003 || Math.abs(offset) >= 0.002)
          ? { pos: activePos, rf: corrRf, strength: 0, rfRaw: rawRf }
          : null)
    );
  };

  // Canvas Mouse Down: Start spot dragging or handle Alt-delete
  const handleCanvasMouseDown = (e: React.MouseEvent<any>) => {
    if (e.shiftKey || inspectPanels.length === 0 || !bigCanvasRef.current) return;
    const primary = inspectPanels[0];
    const l = primary.lane;
    const ph = 1.0 * l.length;
    const rect = bigCanvasRef.current.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const spots = modalActiveSpots;

    // Check if mouse clicked near a spot line (within 10px)
    const hitIdx = spots.findIndex((sp) => Math.abs(ph - sp.pos - mouseY) <= 10);
    if (hitIdx >= 0) {
      if (e.altKey) {
        handleDeleteSpotInModal(hitIdx);
        return;
      }
      const zeroDist = tlcOrigin(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
      const frontPos = tlcFront(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
      const span = Math.max(1, frontPos - zeroDist);
      dragModalSpotRef.current = {
        laneId: l.id,
        spotIndex: hitIdx,
        startPos: spots[hitIdx].pos,
        startRf: spots[hitIdx].rf,
        originDist: zeroDist,
        spanDist: span,
        laneLength: ph,
        initialSpots: JSON.parse(JSON.stringify(spots)),
      };
      setIsDraggingModalSpot(true);
      handleSnapshotHistory();
      e.preventDefault();
    }
  };

  // Click on Canvas to Pin a Spot Marker, Shift+Click to Add Spot, Alt+Click to Delete Spot
  const handleCanvasClick = (e: React.MouseEvent<any>) => {
    if (justDraggedCutoffRef.current || draggingCutoff) {
      justDraggedCutoffRef.current = false;
      return;
    }
    if (hoverRf === null || hoverY === null || !inspectPanels[0]) return;
    // Shift + Click: Add manual spot at exact hover Rf
    if (e.shiftKey) {
      handleAddSpotInModal(hoverRf);
      return;
    }
    // Alt + Click: Delete spot if near
    if (e.altKey) {
      const spots = modalActiveSpots;
      const ph = 1.0 * inspectPanels[0].lane.length;
      const clickedIdx = spots.findIndex((sp) => Math.abs(ph - sp.pos - hoverY) <= 12);
      if (clickedIdx >= 0) {
        handleDeleteSpotInModal(clickedIdx);
        return;
      }
    }
    // Default: Pin / unpin marker
    const existingIdx = pinnedMarkers.findIndex((m) => Math.abs(m.rf - hoverRf) < 0.02);
    if (existingIdx >= 0) {
      setPinnedMarkers((prev) => prev.filter((_, idx) => idx !== existingIdx));
    } else {
      const nextId = Date.now();
      const label = `Spot ${pinnedMarkers.length + 1}`;
      setPinnedMarkers((prev) => [...prev, { id: nextId, rf: hoverRf, label, y: hoverY }]);
    }
  };

  // Export current TLC plate analysis data as CSV or JSON
  const handleExportAnalysis = (format: 'csv' | 'json', scope: 'current' | 'all' = 'current') => {
    if (!activePlateSet.cfg && !hasConfig) {
      toast('Please configure or generate lane grid before exporting analysis.');
      return;
    }
    try {
      const opts: TlcAnalysisExportOptions = {
        set: activePlateSet,
        sets: plateSets,
        run,
        plateIndex: plate,
        getSpots: getSpotsForLane,
        getProfile: (s, k, ln) => extractLaneProfile(s, k, ln, coreFraction),
        spotProminence,
        spotMode,
        coreFraction,
        scope,
      };

      const content = format === 'csv' ? exportTlcAnalysisCsv(opts) : exportTlcAnalysisJson(opts);
      const mime = format === 'csv' ? 'text/csv;charset=utf-8;' : 'application/json;charset=utf-8;';
      const ext = format === 'csv' ? 'csv' : 'json';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = (run?.runName || currentSet.name || 'tlc_plate')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_');
      const scopeSuffix = scope === 'all' ? `plate_${plate + 1}_all_sets` : `plate_${plate + 1}`;
      a.download = `tlc_analysis_${baseName}_${scopeSuffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported Plate ${plate + 1} TLC analysis (${ext.toUpperCase()}).`);
    } catch (err: any) {
      toast(`Export failed: ${err.message || err}`);
    }
  };

  // Download Batch tlc_rf_table.csv
  const handleDownloadRfCsv = () => handleExportAnalysis('csv', 'current');

  // Undo history stack for lane configurations (per set + plate)
  const [cfgHistoryByPlate, setCfgHistoryByPlate] = useState<Record<string, TlcLaneConfig[]>>({});
  const originalCfgRef = useRef<Record<string, TlcLaneConfig>>({});
  const plateCfgKey = `${currentSet.uid}:p${plate}`;
  const cfgHistory = cfgHistoryByPlate[plateCfgKey] || [];

  // Capture original configuration for resetting
  useEffect(() => {
    if (activePlateSet?.cfg && !originalCfgRef.current[plateCfgKey]) {
      originalCfgRef.current[plateCfgKey] = JSON.parse(JSON.stringify(activePlateSet.cfg));
    }
  }, [plateCfgKey, activePlateSet?.cfg]);

  const lastHistorySnapshotRef = useRef<number>(0);

  // Take explicit undo history snapshot (e.g. on slider grab or key press)
  const handleSnapshotHistory = useCallback(() => {
    if (!activePlateSet?.cfg) return;
    const snapCfg = JSON.parse(JSON.stringify(activePlateSet.cfg));
    setCfgHistoryByPlate((m) => ({
      ...m,
      [plateCfgKey]: [...(m[plateCfgKey] || []).slice(-39), snapCfg],
    }));
    lastHistorySnapshotRef.current = Date.now();
  }, [activePlateSet?.cfg, plateCfgKey]);

  // Real-time micro-adjustment of lane coordinates with smart debounced Undo history
  const handleUpdateLane = (laneId: number, patch: Partial<TlcLane>, forceSnapshot: boolean = false) => {
    if (!activePlateSet?.cfg) return;
    const now = Date.now();
    // Snapshot history once at the start of a slide or after 500ms pause, or if forced
    if (forceSnapshot || now - lastHistorySnapshotRef.current > 500) {
      const currentCfg = JSON.parse(JSON.stringify(activePlateSet.cfg));
      setCfgHistoryByPlate((m) => ({
        ...m,
        [plateCfgKey]: [...(m[plateCfgKey] || []).slice(-39), currentCfg],
      }));
      lastHistorySnapshotRef.current = now;
    }
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        if (!slice.cfg) return {};
        const newLanes = slice.cfg.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l));
        return {
          cfg: { ...slice.cfg, lanes: newLanes },
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
        };
      });
      return next;
    });
  };

  // Atomic batch lane update (e.g. 1-click removal of a confidence category across the plate)
  // Snapshots Undo history once and keeps profile/front/origin caches intact when only spots change.
  const handleUpdateLanesBatch = (
    patches: Record<number, Partial<TlcLane>>,
    options?: { keepCaches?: boolean; toastMessage?: string }
  ) => {
    if (!activePlateSet?.cfg) return;
    const laneIds = Object.keys(patches);
    if (laneIds.length === 0) return;

    const currentCfg = JSON.parse(JSON.stringify(activePlateSet.cfg));
    setCfgHistoryByPlate((m) => ({
      ...m,
      [plateCfgKey]: [...(m[plateCfgKey] || []).slice(-39), currentCfg],
    }));
    lastHistorySnapshotRef.current = Date.now();

    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        if (!slice.cfg) return {};
        const newLanes = slice.cfg.lanes.map((l) =>
          patches[l.id] ? { ...l, ...patches[l.id] } : l
        );
        if (options?.keepCaches) {
          return { cfg: { ...slice.cfg, lanes: newLanes } };
        }
        return {
          cfg: { ...slice.cfg, lanes: newLanes },
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
        };
      });
      return next;
    });
    if (options?.toastMessage) {
      toast(options.toastMessage);
    }
  };

  // Revert last adjustment
  const handleUndo = () => {
    if (cfgHistory.length === 0) return;
    const prevCfg = cfgHistory[cfgHistory.length - 1];
    setCfgHistoryByPlate((m) => ({
      ...m,
      [plateCfgKey]: (m[plateCfgKey] || []).slice(0, -1),
    }));
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, {
        cfg: prevCfg,
        prof: {},
        frontAuto: {},
        frontAutoByLane: {},
        originAuto: {},
        originAutoByLane: {},
      });
      return next;
    });
    toast('Reverted last adjustment (Undo).');
  };

  // Reset single lane to its original template configuration
  const handleResetLane = (laneId: number) => {
    const origSetCfg = originalCfgRef.current[plateCfgKey];
    if (!origSetCfg) {
      toast('No original lane template recorded.');
      return;
    }
    const origLane = origSetCfg.lanes.find((l) => l.id === laneId);
    if (!origLane) return;
    handleUpdateLane(laneId, { ...origLane });
    toast(`Reset Lane ${laneId} to original template.`);
  };

  // Reset all lanes in the current plate to their original template configuration
  const handleResetAllLanes = () => {
    const origSetCfg = originalCfgRef.current[plateCfgKey];
    if (!origSetCfg) {
      toast('No original lane template recorded.');
      return;
    }
    if (activePlateSet.cfg) {
      const snapCfg = JSON.parse(JSON.stringify(activePlateSet.cfg));
      setCfgHistoryByPlate((m) => ({
        ...m,
        [plateCfgKey]: [...(m[plateCfgKey] || []).slice(-39), snapCfg],
      }));
    }
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, {
        cfg: JSON.parse(JSON.stringify(origSetCfg)),
        prof: {},
        frontAuto: {},
        frontAutoByLane: {},
        originAuto: {},
        originAutoByLane: {},
      });
      return next;
    });
    toast(`Reset all Plate ${plate + 1} lanes to original configuration.`);
  };

  // Solvent front update (shifts meniscus baseline across the plate or for a specific side while preserving any 2D per-lane curve shape)
  const handleUpdateSetFront = (frontPx: number | null, side?: number) => {
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        if (side !== undefined) {
          const nextHalfFront = { ...(slice.frontHalfPx || {}) };
          if (frontPx != null && frontPx > 0) {
            nextHalfFront[side] = frontPx;
            return {
              frontHalfPx: nextHalfFront,
            };
          }
          delete nextHalfFront[side];
          const nextFrontAuto = { ...(slice.frontAuto || {}) };
          delete nextFrontAuto[side];
          const nextFrontAutoByLane = { ...(slice.frontAutoByLane || {}) };
          for (const k of Object.keys(nextFrontAutoByLane)) {
            const lid = Number(k);
            if ((lid < 27 ? 0 : 1) === side) delete nextFrontAutoByLane[lid];
          }
          return {
            frontHalfPx: nextHalfFront,
            frontAuto: nextFrontAuto,
            frontAutoByLane: nextFrontAutoByLane,
          };
        }
        if (frontPx != null && frontPx > 0) {
          return {
            frontPx,
          };
        }
        return {
          frontPx: null,
          frontAuto: {},
          frontAutoByLane: {},
        };
      });
      return next;
    });
  };

  // Re-detect both origin baseline and solvent front across all lanes from the plate photos
  const handleAutoDetectBaselines = () => {
    if (!hasImages) {
      toast('Load a plate photo first.');
      return;
    }
    if (activePlateSet.cfg) {
      const snapCfg = JSON.parse(JSON.stringify(activePlateSet.cfg));
      setCfgHistoryByPlate((m) => ({
        ...m,
        [plateCfgKey]: [...(m[plateCfgKey] || []).slice(-39), snapCfg],
      }));
    }
    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        const nextCfg = slice.cfg
          ? {
              ...slice.cfg,
              hasZeroRf: false,
              lanes: slice.cfg.lanes.map((l) => ({ ...l, zeroRf: null })),
            }
          : slice.cfg;
        return {
          cfg: nextCfg,
          originPx: null,
          frontPx: null,
          frontHalfPx: undefined,
          prof: {},
          frontAuto: {},
          frontAutoByLane: {},
          originAuto: {},
          originAutoByLane: {},
        };
      });
      return next;
    });
    toast(`Re-detected Plate ${plate + 1} origin baseline and solvent front from plate photos.`);
  };

  // Global Ctrl+Z / Cmd+Z shortcut for Undo
  useEffect(() => {
    const handleGlobalUndoKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        if (cfgHistory.length > 0) {
          e.preventDefault();
          handleUndo();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalUndoKey);
    return () => window.removeEventListener('keydown', handleGlobalUndoKey);
  }, [cfgHistory]);

  // Export current (or corrected) Lane CSV
  const handleExportLaneCsv = () => {
    if (!activePlateSet.cfg) {
      toast('No lane configuration to export.');
      return;
    }
    try {
      const csvContent = exportLaneConfigCsv(activePlateSet.cfg);
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const plateTag = selectablePlatesCount > 1 ? `_plate_${plate + 1}` : '';
      a.download = `lane_config_${currentSet.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}${plateTag}_corrected.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported Plate ${plate + 1} corrected lane CSV.`);
    } catch (err: any) {
      toast('Error exporting lane CSV: ' + err.message);
    }
  };

  const hasConfig = Boolean(activePlateSet.cfg);
  const hasImages = TLC_KEYS.some((k) => Boolean(activePlateSet.imgs[k]));

  // Active Densitogram(s) for the modal
  const activeDens = useMemo(() => {
    if (densViewMode === 'overlay') {
      return channelDensitograms.UV254 || channelDensitograms.UV366 || channelDensitograms.White || null;
    }
    return channelDensitograms[densViewMode] || null;
  }, [channelDensitograms, densViewMode]);

  // Unified canonical modal peak list: always identical across Full Plate View, 54-Well Grid,
  // Zoomed Inspection strips, Densitogram, and Peak Deconvolution list (always respecting lane.customSpots).
  const modalActiveSpots = useMemo<TlcSpot[]>(() => {
    if (inspectWell !== null && activePlateSet.cfg) {
      const laneId = tlcLane(inspectWell, 'column');
      const lane = activePlateSet.cfg.lanes.find((l) => l.id === laneId);
      if (lane) {
        const unified = getCompositeSpotsForLane(activePlateSet, lane);
        if (unified) return unified;
      }
    }
    return inspectPanels[0]?.spots || activeDens?.spots || [];
  }, [inspectWell, activePlateSet, getCompositeSpotsForLane, inspectPanels, activeDens]);

  // Separation calculations between detected spots
  const separationMetrics = useMemo(() => {
    if (modalActiveSpots.length < 2) return null;
    const sorted = [...modalActiveSpots].sort((a, b) => a.rf - b.rf);
    const deltas: Array<{ s1: TlcSpot; s2: TlcSpot; delta: number; status: 'good' | 'fair' | 'poor' }> = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const s1 = sorted[i];
      const s2 = sorted[i + 1];
      const delta = Number(Math.abs(s2.rf - s1.rf).toFixed(3));
      const status = delta >= 0.15 ? 'good' : delta >= 0.05 ? 'fair' : 'poor';
      deltas.push({ s1, s2, delta, status });
    }
    return deltas;
  }, [modalActiveSpots]);

  // Spot management callbacks for the zoomed-in lane modal
  const handleAddSpotInModal = useCallback(
    (targetRf: number = 0.5) => {
      if (inspectWell === null || !activePlateSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const lane = activePlateSet.cfg.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      handleSnapshotHistory();
      const primary = inspectPanels[0];
      const originDist = primary
        ? tlcOrigin(primary.s, lane, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction))
        : lane.length * 0.1;
      const frontPos = primary
        ? tlcFront(primary.s, lane, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction))
        : lane.length * 0.9;
      const spanDist = Math.max(1, frontPos - originDist);
      const currentSpots = modalActiveSpots;
      const clampedRf = Math.max(0, Math.min(1.0, +targetRf.toFixed(3)));
      const pos = Math.round(originDist + clampedRf * spanDist);
      const newSpot: TlcSpot = {
        pos,
        rf: clampedRf,
        rfRaw: clampedRf,
        strength: 0.5,
        areaPct: 20,
        source: 'manual',
      };
      const nextSpots = [...currentSpots, newSpot].sort((a, b) => a.pos - b.pos);
      handleUpdateLane(laneId, { customSpots: nextSpots }, true);
      toast(`Added manual spot at Rf ${clampedRf.toFixed(2)}.`);
    },
    [inspectWell, activePlateSet.cfg, inspectPanels, modalActiveSpots, coreFraction, handleSnapshotHistory]
  );

  const handleDeleteSpotInModal = useCallback(
    (spotIndex: number) => {
      if (inspectWell === null || !activePlateSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const currentSpots = modalActiveSpots;
      if (!currentSpots[spotIndex]) return;
      handleSnapshotHistory();
      const remaining = currentSpots.filter((_, idx) => idx !== spotIndex);
      handleUpdateLane(laneId, { customSpots: remaining }, true);
      toast(`Removed spot #${spotIndex + 1}.`);
    },
    [inspectWell, activePlateSet.cfg, modalActiveSpots, handleSnapshotHistory]
  );

  const handleNudgeSpotInModal = useCallback(
    (spotIndex: number, deltaRf: number) => {
      if (inspectWell === null || !activePlateSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const lane = activePlateSet.cfg.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const currentSpots = modalActiveSpots;
      if (!currentSpots[spotIndex]) return;
      handleSnapshotHistory();
      const primary = inspectPanels[0];
      const originDist = primary
        ? tlcOrigin(primary.s, lane, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction))
        : lane.length * 0.1;
      const frontPos = primary
        ? tlcFront(primary.s, lane, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction))
        : lane.length * 0.9;
      const spanDist = Math.max(1, frontPos - originDist);
      const targetRf = Math.max(0, Math.min(1.0, +(currentSpots[spotIndex].rf + deltaRf).toFixed(3)));
      const pos = Math.round(originDist + targetRf * spanDist);
      const updated = currentSpots.map((s, idx) => {
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
      handleUpdateLane(laneId, { customSpots: updated }, true);
    },
    [inspectWell, activePlateSet.cfg, inspectPanels, modalActiveSpots, coreFraction, handleSnapshotHistory]
  );

  const handleResetLaneSpotsInModal = useCallback(() => {
    if (inspectWell === null || !activePlateSet.cfg) return;
    const laneId = tlcLane(inspectWell, 'column');
    handleSnapshotHistory();
    handleUpdateLane(laneId, { customSpots: undefined }, true);
    toast('Reset lane spots back to automated detection.');
  }, [inspectWell, activePlateSet.cfg, handleSnapshotHistory]);

  // 1-Click Color-Signature Plate-Wide Spot Finder:
  // Samples the RGB color vector (ΔR, ΔG, ΔB) of a clicked spot and scans all 54 lanes on the
  // active plate for 2D-centered spots with matching chromatic direction and contrast.
  const handleFindSimilarSpotsOnPlate = useCallback(
    (refSpot: TlcSpot) => {
      if (inspectWell === null || !activePlateSet.cfg) return;
      const refLaneId = tlcLane(inspectWell, 'column');
      const refLane = activePlateSet.cfg.lanes.find((l) => l.id === refLaneId);
      if (!refLane) return;

      const loaded = getLoadedTlcChannels(activePlateSet.imgs, true);
      if (!loaded.length) {
        toast('Load a plate photo first to match spots by color.');
        return;
      }

      // Pick the best channel for sampling this spot's color vector
      let targetCh: TlcChannelKey = loaded[0];
      if (densViewMode !== 'overlay' && loaded.includes(densViewMode)) {
        targetCh = densViewMode;
      } else {
        let bestMag = -1;
        const preferredOrder: TlcChannelKey[] = refSpot.channels?.length
          ? [
              ...refSpot.channels.filter((c): c is TlcChannelKey => loaded.includes(c as TlcChannelKey)),
              ...loaded.filter((c) => !refSpot.channels?.includes(c)),
            ]
          : loaded;
        for (const ch of preferredOrder) {
          const m = getLane2dMetrics(activePlateSet, ch, refLane, coreFraction);
          if (!m) continue;
          const idx = Math.max(0, Math.min(m.coreRgb.length / 3 - 1, Math.round(refSpot.pos)));
          const mag = Math.hypot(
            m.coreRgb[idx * 3] - m.bgRgb[0],
            m.coreRgb[idx * 3 + 1] - m.bgRgb[1],
            m.coreRgb[idx * 3 + 2] - m.bgRgb[2]
          );
          if (mag > bestMag) {
            bestMag = mag;
            targetCh = ch;
          }
        }
      }

      const refMetrics = getLane2dMetrics(activePlateSet, targetCh, refLane, coreFraction);
      if (!refMetrics) {
        toast('Could not sample spot color from the plate image.');
        return;
      }

      const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
      const plateLanes = activePlateSet.cfg.lanes.filter((l) => l.id >= 0 && l.id <= 53);
      const laneInputs = plateLanes
        .map((l) => {
          const metrics = getLane2dMetrics(activePlateSet, targetCh, l, coreFraction);
          if (!metrics) return null;
          return {
            laneId: l.id,
            origin: tlcOrigin(activePlateSet, l, get),
            front: tlcFront(activePlateSet, l, get),
            metrics,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const matches = findSimilarSpotsByColor(refMetrics, refSpot.pos, laneInputs);
      if (!matches.length) {
        toast('No additional spots matched that color signature on this plate.');
        return;
      }

      const updatesByLane = new Map<number, TlcSpot[]>();
      let addedCount = 0;
      let lanesTouched = 0;

      for (const m of matches) {
        const laneObj = plateLanes.find((l) => l.id === m.laneId);
        if (!laneObj) continue;
        const baseSpots =
          laneObj.customSpots !== undefined
            ? [...laneObj.customSpots]
            : [...(getCompositeSpotsForLane(activePlateSet, laneObj) || [])];

        let laneAdded = 0;
        for (const cand of m.spots) {
          if (!baseSpots.some((ex) => Math.abs(ex.rf - cand.rf) < 0.035)) {
            baseSpots.push({
              ...cand,
              channels: [targetCh],
              source: 'auto',
            });
            laneAdded++;
            addedCount++;
          }
        }
        if (laneAdded > 0) {
          baseSpots.sort((a, b) => a.pos - b.pos);
          updatesByLane.set(m.laneId, baseSpots);
          lanesTouched++;
        }
      }

      if (addedCount === 0) {
        toast(`All matching spots (${TLC_LABEL[targetCh]}) are already marked on this plate.`);
        return;
      }

      handleSnapshotHistory();
      setSets((prev) => {
        const next = [...prev];
        if (!next[cur]) return next;
        next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
          if (!slice.cfg) return {};
          return {
            cfg: {
              ...slice.cfg,
              lanes: slice.cfg.lanes.map((l) =>
                updatesByLane.has(l.id) ? { ...l, customSpots: updatesByLane.get(l.id) } : l
              ),
            },
          };
        });
        return next;
      });
      toast(
        `Matched ${addedCount} similar spot${addedCount === 1 ? '' : 's'} across ${lanesTouched} lane${lanesTouched === 1 ? '' : 's'} (${TLC_LABEL[targetCh]} · Ctrl+Z to undo).`
      );
    },
    [
      inspectWell,
      activePlateSet,
      densViewMode,
      coreFraction,
      getCompositeSpotsForLane,
      getSpotsForLane,
      handleSnapshotHistory,
      setSets,
      cur,
      plate,
      toast,
    ]
  );

  // Render an annotated JPEG of the active plate (lane boxes, well labels, yellow origin, cyan front,
  // magenta spot ticks, and Rf scale ruler) for Gemini Vision Final Plate QC Audit.
  const renderAnnotatedPlateForQc = useCallback(
    (
      targetCh: TlcChannelKey
    ): { imageBase64: string; lanesSummary: TlcVisionQcLaneSummary[]; warnings: string[] } | null => {
      const im = activePlateSet.imgs?.[targetCh];
      const cfg = activePlateSet.cfg;
      if (!im?.bmp || !cfg?.lanes?.length) return null;

      const bmp = im.bmp;
      const maxW = 1400;
      const scale = bmp.width > maxW ? maxW / bmp.width : 1;
      const cw = Math.max(1, Math.round(bmp.width * scale));
      const ch = Math.max(1, Math.round(bmp.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.drawImage(bmp, 0, 0, cw, ch);

      const frameScale = (bmp.width / (activePlateSet.frameW || LANE_FRAME_WIDTH)) * scale;
      const get = (s: TlcSet, k: TlcChannelKey, ln: TlcLane) => extractLaneProfile(s, k, ln, coreFraction);
      const lanesSummary: TlcVisionQcLaneSummary[] = [];

      const lanePoint = (l: TlcLane, alongPx: number, acrossPx: number): [number, number] => {
        const th = (l.angle * Math.PI) / 180;
        const dx = Math.sin(th);
        const dy = -Math.cos(th);
        const nx = Math.cos(th);
        const ny = Math.sin(th);
        return [
          (l.x0 + alongPx * dx + acrossPx * nx) * frameScale,
          (l.y0 + alongPx * dy + acrossPx * ny) * frameScale,
        ];
      };

      for (const lane of cfg.lanes) {
        const half = tlcHalf(lane);
        const well = wellLabel(containerOfLane(lane.id));
        const origin = tlcOrigin(activePlateSet, lane, get);
        const front = tlcFront(activePlateSet, lane, get);
        const spots = getCompositeSpotsForLane(activePlateSet, lane) || [];

        lanesSummary.push({
          well,
          laneId: lane.id,
          half,
          spots: spots.map((s) => +s.rf.toFixed(3)),
        });

        const hw = lane.width / 2;
        const pBL = lanePoint(lane, 0, -hw);
        const pBR = lanePoint(lane, 0, hw);
        const pTR = lanePoint(lane, lane.length, hw);
        const pTL = lanePoint(lane, lane.length, -hw);

        // Teal lane outline
        ctx.strokeStyle = 'rgba(20, 184, 166, 0.78)';
        ctx.lineWidth = Math.max(1, 1.3 * scale);
        ctx.beginPath();
        ctx.moveTo(pBL[0], pBL[1]);
        ctx.lineTo(pBR[0], pBR[1]);
        ctx.lineTo(pTR[0], pTR[1]);
        ctx.lineTo(pTL[0], pTL[1]);
        ctx.closePath();
        ctx.stroke();

        // Yellow origin line (Rf = 0.0)
        const oL = lanePoint(lane, origin, -hw);
        const oR = lanePoint(lane, origin, hw);
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = Math.max(1.5, 2.2 * scale);
        ctx.beginPath();
        ctx.moveTo(oL[0], oL[1]);
        ctx.lineTo(oR[0], oR[1]);
        ctx.stroke();

        // Cyan solvent front line (Rf = 1.0)
        const fL = lanePoint(lane, front, -hw);
        const fR = lanePoint(lane, front, hw);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = Math.max(1.5, 2.2 * scale);
        ctx.beginPath();
        ctx.moveTo(fL[0], fL[1]);
        ctx.lineTo(fR[0], fR[1]);
        ctx.stroke();

        // Bright magenta circles + horizontal ticks on currently detected spots
        for (const sp of spots) {
          const [sx, sy] = lanePoint(lane, sp.pos, 0);
          ctx.strokeStyle = '#ff2bd6';
          ctx.fillStyle = '#ff2bd6';
          ctx.lineWidth = Math.max(1.4, 2 * scale);
          ctx.beginPath();
          ctx.moveTo(sx - 6, sy);
          ctx.lineTo(sx + 6, sy);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(3, 3.8 * scale), 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Crisp well label below lane base
        const [lx, ly] = lanePoint(lane, -16, 0);
        const fontSize = Math.max(9, Math.min(13, Math.round(lane.width * frameScale * 0.42)));
        ctx.font = `700 ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
        const tw = ctx.measureText(well).width;
        ctx.fillRect(lx - tw / 2 - 2, ly - 1, tw + 4, fontSize + 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(well, lx, ly);
      }

      // Draw Rf scale ticks (0.0 .. 1.0) on left & right of each tier so Vision AI reads exact Rf
      for (const halfIdx of [0, 1]) {
        const tierLanes = cfg.lanes.filter((l) => tlcHalf(l) === halfIdx).sort((a, b) => a.id - b.id);
        if (!tierLanes.length) continue;
        const leftLane = tierLanes[0];
        const o0 = tlcOrigin(activePlateSet, leftLane, get);
        const f0 = tlcFront(activePlateSet, leftLane, get);
        const span0 = Math.max(1, f0 - o0);
        ctx.font = '700 11px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const rfTick of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
          const [tx, ty] = lanePoint(leftLane, o0 + rfTick * span0, -leftLane.width * 0.8);
          const lbl = rfTick.toFixed(1);
          const xDraw = Math.max(24, tx);
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.fillRect(xDraw - 22, ty - 7, 24, 14);
          ctx.fillStyle = rfTick === 0 ? '#facc15' : rfTick === 1 ? '#22d3ee' : '#e2e8f0';
          ctx.fillText(lbl, xDraw, ty);
        }
      }

      const notes = tlcDetectionNotes(activePlateSet, get)
        .filter((n) => n.warning)
        .map((n) => `${n.label}: ${n.warning}`);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      return {
        imageBase64: dataUrl.replace(/^data:image\/jpeg;base64,/, ''),
        lanesSummary,
        warnings: notes,
      };
    },
    [activePlateSet, coreFraction, getSpotsForLane]
  );

  const handleRunVisionQc = useCallback(async () => {
    if (!activePlateSet.cfg?.lanes?.length) {
      toast('Load or auto-detect lanes before running AI Vision QC.');
      return;
    }
    const targetCh: TlcChannelKey | undefined =
      fullPlateChannel !== 'composite' && activePlateSet.imgs?.[fullPlateChannel]?.bmp
        ? fullPlateChannel
        : TLC_KEYS.find((k) => Boolean(activePlateSet.imgs?.[k]?.bmp));
    if (!targetCh) {
      toast('Upload at least one TLC plate photo first.');
      return;
    }

    const rendered = renderAnnotatedPlateForQc(targetCh);
    if (!rendered) {
      toast('Could not render annotated plate snapshot for Vision QC.');
      return;
    }

    setQcChannel(targetCh);
    setQcLoading(true);
    setQcError(null);
    try {
      const result = await fetchAiTlcVisionQc({
        imageBase64: rendered.imageBase64,
        mimeType: 'image/jpeg',
        channelLabel: TLC_LABEL[targetCh],
        plateNumber: plate + 1,
        lanesSummary: rendered.lanesSummary,
        warnings: rendered.warnings,
      });
      setQcResult(result);

      const spotChecks: Record<number, boolean> = {};
      result.spotCorrections.forEach((c, idx) => {
        spotChecks[idx] = c.confidence === 'high';
      });
      setQcSelectedSpots(spotChecks);

      const frontChecks: Record<number, boolean> = {};
      result.frontAudit.forEach((f) => {
        if (f.status === 'shift' && Math.abs(f.suggestedShiftRf) >= 0.025) {
          frontChecks[f.half] = true;
        }
      });
      setQcSelectedFront(frontChecks);

      const originChecks: Record<number, boolean> = {};
      result.originAudit.forEach((o) => {
        if (o.status === 'shift' && Math.abs(o.suggestedShiftRf) >= 0.025) {
          originChecks[o.half] = true;
        }
      });
      setQcSelectedOrigin(originChecks);
    } catch (err: any) {
      setQcError(err?.message || 'AI Vision QC failed.');
    } finally {
      setQcLoading(false);
    }
  }, [activePlateSet, fullPlateChannel, plate, renderAnnotatedPlateForQc, toast]);

  const handleApplyVisionQcFixes = useCallback(() => {
    if (!qcResult || !activePlateSet.cfg?.lanes?.length) return;
    const get = (s: TlcSet, k: TlcChannelKey, ln: TlcLane) => extractLaneProfile(s, k, ln, coreFraction);

    const frontShifts = qcResult.frontAudit.filter(
      (f) => f.status === 'shift' && Math.abs(f.suggestedShiftRf) >= 0.015 && qcSelectedFront[f.half]
    );
    const originShifts = qcResult.originAudit.filter(
      (o) => o.status === 'shift' && Math.abs(o.suggestedShiftRf) >= 0.015 && qcSelectedOrigin[o.half]
    );
    const chosenSpots = qcResult.spotCorrections.filter((_c, idx) => qcSelectedSpots[idx]);

    if (!frontShifts.length && !originShifts.length && !chosenSpots.length) {
      toast('Select at least one Vision QC fix to apply.');
      return;
    }

    handleSnapshotHistory();

    // Compute updated frontHalfPx
    const nextFrontHalf: Record<number, number> = { ...(activePlateSet.frontHalfPx || {}) };
    for (const fs of frontShifts) {
      const sampleLane = activePlateSet.cfg.lanes.find((l) => tlcHalf(l) === fs.half);
      if (!sampleLane) continue;
      const curO = tlcOrigin(activePlateSet, sampleLane, get);
      const curF = tlcHalfFrontBase(activePlateSet, fs.half, sampleLane, get);
      const span = Math.max(20, curF - curO);
      const nextF = Math.round(
        Math.max(sampleLane.length * 0.50, Math.min(sampleLane.length * 0.98, curF + fs.suggestedShiftRf * span))
      );
      nextFrontHalf[fs.half] = nextF;
    }

    // Group spot corrections by laneId
    const corrByLane = new Map<number, typeof chosenSpots>();
    for (const c of chosenSpots) {
      const arr = corrByLane.get(c.laneId) || [];
      arr.push(c);
      corrByLane.set(c.laneId, arr);
    }

    let spotsAdded = 0;
    let spotsRemoved = 0;

    setSets((prev) => {
      const next = [...prev];
      if (!next[cur]) return next;
      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
        if (!slice.cfg) return {};
        const updatedLanes = slice.cfg.lanes.map((lane) => {
          const half = tlcHalf(lane);
          let nextLane = lane;

          const oShift = originShifts.find((o) => o.half === half);
          const baseOrigin = tlcOrigin(activePlateSet, lane, get);
          const baseFront = nextFrontHalf[half] ?? tlcFront(activePlateSet, lane, get);
          const baseSpan = Math.max(20, baseFront - baseOrigin);

          let effOrigin = baseOrigin;
          if (oShift) {
            effOrigin = Math.round(
              Math.max(lane.length * 0.03, Math.min(lane.length * 0.30, baseOrigin + oShift.suggestedShiftRf * baseSpan))
            );
            nextLane = { ...nextLane, zeroRf: effOrigin };
          }

          const laneCorrs = corrByLane.get(lane.id);
          if (laneCorrs && laneCorrs.length > 0) {
            const effSpan = Math.max(20, baseFront - effOrigin);
            const baseSpots =
              lane.customSpots !== undefined
                ? [...lane.customSpots]
                : [...(getCompositeSpotsForLane(activePlateSet, lane) || [])];

            for (const c of laneCorrs) {
              if (c.action === 'add') {
                if (!baseSpots.some((ex) => Math.abs(ex.rf - c.rf) < 0.032)) {
                  const pos = Math.round(effOrigin + c.rf * effSpan);
                  baseSpots.push({
                    pos,
                    rf: c.rf,
                    strength: 0.65,
                    source: 'manual',
                    channels: [qcChannel],
                  });
                  spotsAdded++;
                }
              } else if (c.action === 'remove') {
                let bestIdx = -1;
                let bestDist = 0.065;
                baseSpots.forEach((ex, i) => {
                  const d = Math.abs(ex.rf - c.rf);
                  if (d < bestDist) {
                    bestDist = d;
                    bestIdx = i;
                  }
                });
                if (bestIdx >= 0) {
                  baseSpots.splice(bestIdx, 1);
                  spotsRemoved++;
                }
              }
            }
            baseSpots.sort((a, b) => a.pos - b.pos);
            nextLane = { ...nextLane, customSpots: baseSpots };
          }
          return nextLane;
        });

        return {
          cfg: {
            ...slice.cfg,
            hasZeroRf: originShifts.length > 0 ? true : slice.cfg.hasZeroRf,
            lanes: updatedLanes,
          },
          ...(frontShifts.length > 0 ? { frontHalfPx: nextFrontHalf } : {}),
        };
      });
      return next;
    });

    const parts: string[] = [];
    if (frontShifts.length) parts.push(`${frontShifts.length} front shift`);
    if (originShifts.length) parts.push(`${originShifts.length} origin shift`);
    if (spotsAdded) parts.push(`+${spotsAdded} missed spot${spotsAdded === 1 ? '' : 's'}`);
    if (spotsRemoved) parts.push(`−${spotsRemoved} false spot${spotsRemoved === 1 ? '' : 's'}`);
    toast(`Applied AI Vision QC fixes (${parts.join(', ') || 'updated'} · Ctrl+Z to undo).`);
    setQcResult(null);
  }, [
    qcResult,
    activePlateSet,
    coreFraction,
    qcSelectedFront,
    qcSelectedOrigin,
    qcSelectedSpots,
    handleSnapshotHistory,
    setSets,
    cur,
    plate,
    getSpotsForLane,
    qcChannel,
    toast,
  ]);

  // Window mousemove and mouseup listeners for continuous dragging across canvas & densitometer
  useEffect(() => {
    if (!isDraggingModalSpot) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const drag = dragModalSpotRef.current;
      if (!drag || !bigCanvasRef.current) return;
      const rect = bigCanvasRef.current.getBoundingClientRect();
      const mouseY = e.clientY - rect.top;
      const rawPos = drag.laneLength - mouseY;
      const clampedPos = Math.max(drag.originDist * 0.4, Math.min(drag.laneLength * 1.05, rawPos));
      const rawRf = (clampedPos - drag.originDist) / drag.spanDist;
      const clampedRf = Math.max(0, Math.min(1.0, +rawRf.toFixed(3)));

      const updated = drag.initialSpots.map((s, idx) => {
        if (idx === drag.spotIndex) {
          return {
            ...s,
            pos: Math.round(clampedPos),
            rf: clampedRf,
            rfRaw: clampedRf,
            source: (s.source === 'manual' ? 'manual' : 'adjusted') as 'manual' | 'adjusted',
          };
        }
        return s;
      });

      handleUpdateLane(drag.laneId, { customSpots: updated }, false);
      setHoverRf(clampedRf);
      setHoverY(Math.round(drag.laneLength - clampedPos));
    };

    const handleWindowMouseUp = () => {
      const drag = dragModalSpotRef.current;
      if (drag && activePlateSet?.cfg) {
        const lane = activePlateSet.cfg.lanes.find((l) => l.id === drag.laneId);
        if (lane && lane.customSpots) {
          handleUpdateLane(drag.laneId, { customSpots: lane.customSpots }, true);
        }
      }
      dragModalSpotRef.current = null;
      setIsDraggingModalSpot(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDraggingModalSpot, activePlateSet?.cfg]);

  return (
    <div className="tab-pane" style={{ padding: '16px' }}>
      {activeTlcStatus === 'pending' && (
        <div
          className="issue warn"
          style={{
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '12px 16px',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            borderRadius: '8px',
            color: 'var(--fg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, color: '#d97706', fontSize: '13px' }}>
                TLC Analytical Data Pending
              </div>
              <div style={{ fontSize: '12px', opacity: 0.85 }}>
                Reaction conditions and robot workbooks are ready. When you photograph your plate in the lab, upload your UV 254 nm, UV 365 nm, or visible photos here to generate densitograms and complete the experiment archive.
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn sm pri"
            onClick={() => fileImgRef.current?.click()}
          >
            Upload Plate Photos
          </button>
        </div>
      )}

      {/* Control Card */}
      <div className="card tlcctl" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '18px', fontWeight: 700 }}>
              Thin-Layer Chromatography (TLC) Map &amp; Lane Densitometer
            </h2>
            <p className="sub" style={{ margin: '0 0 10px 0', fontSize: '12px', color: 'var(--mut)', maxWidth: '850px' }}>
              Each well is aligned with its TLC lane. Automated computer vision calculates
              optical densitograms, solvent front meniscuses, retention factors (Rf), and
              separation resolution (ΔRf) with edge-bleed suppression.
            </p>
          </div>

          {hasConfig && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div
                style={{
                  display: 'inline-flex',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--card-bg, #ffffff)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <button
                  type="button"
                  className="btn pri sm"
                  onClick={() => handleExportAnalysis('csv', 'current')}
                  title="Export TLC analysis data including Rf values, peak strengths, and well coords as CSV"
                  style={{ borderRadius: '5px 0 0 5px', margin: 0, fontWeight: 600 }}
                >
                  📥 Export CSV
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => handleExportAnalysis('json', 'current')}
                  title="Export full TLC plate analysis data as structured JSON"
                  style={{ borderRadius: '0 5px 5px 0', margin: 0, borderLeft: '1px solid var(--border)', fontWeight: 600 }}
                >
                  📦 Export JSON
                </button>
              </div>

              {sets.length > 1 && (
                <div
                  style={{
                    display: 'inline-flex',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    background: 'var(--soft, #f8fafc)',
                  }}
                >
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => handleExportAnalysis('csv', 'all')}
                    title="Export TLC analysis across all plate sets as CSV"
                    style={{ borderRadius: '5px 0 0 5px', margin: 0, fontSize: '11px', padding: '4px 8px' }}
                  >
                    CSV (All {sets.length} Sets)
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => handleExportAnalysis('json', 'all')}
                    title="Export TLC analysis across all plate sets as JSON"
                    style={{ borderRadius: '0 5px 5px 0', margin: 0, fontSize: '11px', padding: '4px 8px', borderLeft: '1px solid var(--border)' }}
                  >
                    JSON (All {sets.length} Sets)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Set Tabs */}
        <div className="tlcsets" role="group" aria-label="TLC sets" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
          {sets.map((x, i) => (
            <div
              key={x.uid}
              className={`tlcsetbtn ${i === cur ? 'on' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 4px 0 10px',
                gap: '4px',
              }}
            >
              <button
                type="button"
                onClick={() => setCur(i)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  padding: '6px 0',
                  color: 'inherit',
                  font: 'inherit',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {isMultiSet ? <b>{tlcLetter(i)} </b> : null}
                <span>{x.name}</span>
              </button>
              {sets.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveSetIndex(i);
                  }}
                  title={`Delete ${x.name}`}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'inherit',
                    opacity: i === cur ? 0.82 : 0.65,
                    padding: '2px 4px',
                    fontSize: '12px',
                    lineHeight: 1,
                    borderRadius: '4px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.opacity = '1';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.opacity = i === cur ? '0.82' : '0.65';
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn sm" onClick={handleAddSet}>
            + Add Solvent Set
          </button>
          <button
            type="button"
            className="btn sm pri"
            onClick={() => setShowSolventAdvisor(true)}
            style={{
              background: '#10b981',
              borderColor: '#059669',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontWeight: 600,
            }}
            title="Suggest a finite set of TLC solvent systems for all 54 wells (prioritizing High & Medium predicted products) or run a single-reaction query"
          >
            ✦ 54-Well / AI Solvent Advisor
          </button>
        </div>

        {/* Prominent Plate Selector Bar (when experiment uses 2 or 3 plates) */}
        {selectablePlatesCount > 1 && (
          <div
            role="group"
            aria-label="Experiment Plates"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              padding: '8px 12px',
              marginBottom: '10px',
              background: 'var(--soft)',
              borderRadius: '10px',
              border: '1px solid var(--line)',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--fg)', marginRight: '2px' }}>
              Active Plate:
            </span>
            <div className="seg" style={{ background: 'transparent', border: 'none', padding: 0 }}>
              {Array.from({ length: selectablePlatesCount }, (_, pIdx) => {
                const imgCount = tlcSetPlateImageCount(currentSet, pIdx);
                const slice = getTlcPlateSlice(currentSet, pIdx);
                const hasLanes = Boolean(slice.cfg?.lanes?.length);
                const isActive = pIdx === plate;
                return (
                  <button
                    key={pIdx}
                    type="button"
                    className={isActive ? 'on' : ''}
                    style={!isActive ? { borderColor: 'var(--line)', background: 'var(--panel)' } : undefined}
                    onClick={() => {
                      setPlate(pIdx);
                      setHoverRf(null);
                      setHoverY(null);
                      setHoverSpot(null);
                    }}
                    title={`Switch to Plate ${pIdx + 1} (${imgCount} photo${imgCount === 1 ? '' : 's'}, ${hasLanes ? `${slice.cfg?.lanes.length} lanes` : 'no lanes'})`}
                  >
                    <span>Plate {pIdx + 1}</span>
                    <span className={`seg-badge ${!isActive && imgCount > 0 ? 'ok' : ''}`}>
                      {imgCount > 0 ? `${imgCount} img${imgCount === 1 ? '' : 's'}${hasLanes ? ' ✓' : ''}` : hasLanes ? 'lanes ✓' : 'empty'}
                    </span>
                  </button>
                );
              })}
            </div>
            <span style={{ fontSize: '11.5px', color: 'var(--mut)', marginLeft: 'auto' }}>
              Each plate stores its own photos, lane grid &amp; Rf data independently.
            </span>
          </div>
        )}

        {/* Current Set Configuration & Action Buttons */}
        <div className="tlcbtns" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <label className="tlcz" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
            <span>Set Name:</span>
            <input
              type="text"
              className="f"
              value={currentSet.name}
              onChange={(e) => {
                const val = e.target.value;
                setSets((prev) => {
                  const next = [...prev];
                  next[cur] = { ...next[cur], name: val };
                  return next;
                });
              }}
              maxLength={40}
              style={{ width: '190px' }}
              placeholder="e.g. 30% EtOAc in Hexanes"
            />
          </label>

          <button
            type="button"
            className="btn sm bad"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            onClick={() => handleRemoveSetIndex(cur)}
            title={sets.length > 1 ? `Delete "${currentSet.name}"` : 'Clear images and reset this set'}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" />
            </svg>
            {sets.length > 1 ? 'Delete Set' : 'Clear Set'}
          </button>

          <div style={{ height: '20px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          <button
            type="button"
            className="btn pri"
            onClick={handleAutoDetectLanes}
            disabled={!hasImages}
            title="Find the two rows of origin dots in the plate photo and place all 54 lanes from them."
          >
            Auto-detect lanes
          </button>

          {plate > 0 && !hasConfig && Boolean(currentSet.cfg) && (
            <button
              type="button"
              className="btn"
              onClick={handleCopyLanesFromPlate1}
              title="Copy the calibrated 54-lane geometry from Plate 1 to this plate"
            >
              Copy Lanes from Plate 1
            </button>
          )}

          <button
            type="button"
            className="btn"
            onClick={handleApplyDefaultGrid}
            title="Apply standard geometric 54-lane template for preview. For real laboratory plate analysis, load your calibrated Lane CSV."
          >
            Standard 6×9 Template (Demo)
          </button>

          <button type="button" className="btn" onClick={() => fileCsvRef.current?.click()}>
            {hasConfig ? 'Replace Lane CSV' : 'Custom Lane CSV'}
          </button>
          <input
            ref={fileCsvRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: 'none' }}
            onChange={handleLoadCsv}
          />

          {hasConfig && (
            <button
              type="button"
              className="btn"
              onClick={handleExportLaneCsv}
              title="Download current lane configuration CSV with any micro-adjustments you made"
            >
              Export Lane CSV
            </button>
          )}

          <button
            type="button"
            className="btn pri"
            onClick={() => fileImgRef.current?.click()}
            title="Upload PNG/JPEG photos, Merck TLC Explorer .npy float32 files (uni_linint_corrected_*), or select microadjusted_lane_config.csv together with your images"
          >
            {hasImages
              ? selectablePlatesCount > 1
                ? `Add / Replace Plate ${plate + 1} Photos / .npy`
                : 'Add / Replace Plate Photos / .npy'
              : selectablePlatesCount > 1
              ? `Upload Plate ${plate + 1} Photos / .npy`
              : 'Upload Plate Photos / .npy'}
          </button>
          <input
            ref={fileImgRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.npy,.csv"
            multiple
            style={{ display: 'none' }}
            onChange={handleLoadImages}
          />

          <button
            type="button"
            className="btn"
            onClick={handleRunVisionQc}
            disabled={!hasImages || !hasConfig || qcLoading}
            title="Send an annotated snapshot of this plate to Gemini Vision AI to audit origin, solvent front, missed coalesced spots, and false-positive markers."
            style={{
              background: 'rgba(139, 92, 246, 0.14)',
              borderColor: 'rgba(139, 92, 246, 0.5)',
              color: '#a78bfa',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
            {qcLoading ? 'Auditing Plate…' : 'AI Vision QC'}
          </button>

          <button
            type="button"
            className="btn"
            onClick={handleLoadDemoTlc}
            title="Generate and display sample UV 254 nm and 365 nm TLC plate images with spots and densitograms"
            style={{
              background: 'rgba(16, 185, 129, 0.12)',
              borderColor: 'rgba(16, 185, 129, 0.5)',
              color: '#10b981',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 2v4l-3.5 6.5A1.2 1.2 0 0 0 3.6 14h8.8a1.2 1.2 0 0 0 1.1-1.5L10 6V2M4.5 2h7" />
            </svg>
            Try Demo Plate
          </button>

          <div style={{ height: '20px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* View Mode Switcher */}
          <div className="seg sm" role="group" aria-label="TLC view mode">
            <button
              type="button"
              className={viewMode === 'grid' ? 'on' : ''}
              onClick={() => setViewMode('grid')}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="9" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="5" rx="1" />
                <rect x="9" y="9" width="5" height="5" rx="1" />
              </svg>
              54-Well Sliced Grid
            </button>
            <button
              type="button"
              className={viewMode === 'full-plate' ? 'on' : ''}
              onClick={() => setViewMode('full-plate')}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <circle cx="5.5" cy="6.5" r="1" />
                <path d="M2.5 11.5l3-3 2.5 2.5 2.5-2 3 2.5" />
              </svg>
              Full Plate Photo
            </button>
          </div>

          {viewMode === 'grid' && (
            <label className="tlcz" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <span>Zoom:</span>
              <input
                type="range"
                min="0.25"
                max="0.85"
                step="0.05"
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                aria-label="Zoom scale"
              />
              <span className="mono" style={{ fontSize: '11px' }}>{Math.round(zoom * 100)}%</span>
            </label>
          )}

          <label className="tlcz" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={markSpots}
              onChange={(e) => setMarkSpots(e.target.checked)}
            />
            <span>Auto-detect spots &amp; show Rf</span>
          </label>

          {markSpots && (
            <div
              style={{
                display: 'inline-flex',
                background: 'var(--soft)',
                padding: '2px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                gap: '2px',
                fontSize: '11px',
              }}
              title="Chromatographic Peak Filter: 'Broad Spots' consolidates wide/tailing bands into 1 clean centroid; 'Standard' is calibrated for normal reaction spots; 'Sensitive' picks up trace impurities."
            >
              <button
                type="button"
                onClick={() => {
                  setSpotMode('standard');
                  setSpotProminence(0.28);
                }}
                style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  border: 'none',
                  background: spotMode === 'standard' ? 'var(--panel)' : 'transparent',
                  color: spotMode === 'standard' ? 'var(--fg)' : 'var(--mut)',
                  borderRadius: '4px',
                  fontWeight: spotMode === 'standard' ? 600 : 400,
                  cursor: 'pointer',
                  boxShadow: spotMode === 'standard' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                Standard
              </button>
              <button
                type="button"
                onClick={() => {
                  setSpotMode('broad');
                  setSpotProminence(0.55);
                }}
                style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  border: 'none',
                  background: spotMode === 'broad' ? 'var(--panel)' : 'transparent',
                  color: spotMode === 'broad' ? '#ec4899' : 'var(--mut)',
                  borderRadius: '4px',
                  fontWeight: spotMode === 'broad' ? 700 : 400,
                  cursor: 'pointer',
                  boxShadow: spotMode === 'broad' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                }}
                title="Consolidates wide tailing bands and saturated spots into 1 clean Rf centroid"
              >
                Broad Spots
              </button>
              <button
                type="button"
                onClick={() => {
                  setSpotMode('sensitive');
                  setSpotProminence(0.12);
                }}
                style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  border: 'none',
                  background: spotMode === 'sensitive' ? 'var(--panel)' : 'transparent',
                  color: spotMode === 'sensitive' ? 'var(--fg)' : 'var(--mut)',
                  borderRadius: '4px',
                  fontWeight: spotMode === 'sensitive' ? 600 : 400,
                  cursor: 'pointer',
                  boxShadow: spotMode === 'sensitive' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                }}
                title="Detects faint trace impurities and close doublets"
              >
                Sensitive
              </button>

              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  paddingLeft: '6px',
                  borderLeft: '1px solid var(--line)',
                  marginLeft: '2px',
                }}
              >
                <span style={{ fontSize: '10px', color: 'var(--mut)', whiteSpace: 'nowrap' }}>
                  {activePlateSet.spotDetectorMode === 'densitogram' ? 'Cutoff:' : 'Merge:'}
                </span>
                <input
                  type="range"
                  min={activePlateSet.spotDetectorMode === 'densitogram' ? '0.04' : '0.08'}
                  max={activePlateSet.spotDetectorMode === 'densitogram' ? '0.95' : '0.70'}
                  step="0.01"
                  value={spotProminence}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSpotProminence(v);
                    if (v >= 0.45) setSpotMode('broad');
                    else if (v <= 0.16) setSpotMode('sensitive');
                    else setSpotMode('standard');
                  }}
                  style={{ width: '60px', height: '14px', cursor: 'pointer' }}
                  title={
                    activePlateSet.spotDetectorMode === 'densitogram'
                      ? `Densitogram Intensity Cutoff: ${Math.round(spotProminence * 100)}% (higher = only stronger peaks above the dashed cutoff line; lower = catches fainter spots)`
                      : `Valley Prominence Threshold: ${Math.round(spotProminence * 100)}% (higher = merges broad/tailing bands; lower = detects fine trace spots)`
                  }
                />
                <span className="mono" style={{ fontSize: '10px', minWidth: '26px', color: 'var(--fg)', fontWeight: 700 }}>
                  {Math.round(spotProminence * 100)}%
                </span>
              </div>

              {(activePlateSet.spotDetectorMode ?? '2d') !== '1d' && (() => {
                const minW = activePlateSet.minSpotWidthFrac ?? DEFAULT_MIN_SPOT_WIDTH_FRAC;
                return (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      paddingLeft: '6px',
                      borderLeft: '1px solid var(--line)',
                      marginLeft: '2px',
                    }}
                  >
                    <span style={{ fontSize: '10px', color: 'var(--mut)', whiteSpace: 'nowrap' }}>
                      Min W:
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="0.56"
                      step="0.02"
                      value={minW}
                      onChange={(e) => {
                        const v = Math.round(parseFloat(e.target.value) * 100) / 100;
                        const uid = currentSet.uid;
                        setSets((prev) =>
                          prev.map((s) =>
                            s.uid === uid
                              ? updateTlcPlateSlice(s, plate, { minSpotWidthFrac: v })
                              : s
                          )
                        );
                      }}
                      style={{ width: '52px', height: '14px', cursor: 'pointer' }}
                      title={
                        minW <= 0
                          ? 'Microdroplet Filter: OFF (accepts all narrow vertical streaks & microdroplets)'
                          : `Microdroplet Filter (2D Min Spot Width): ${Math.round(minW * 100)}% of lane width — ignores narrow spotter microdroplets & their skinny eluted runs (drag to 0% to disable)`
                      }
                    />
                    <span
                      className="mono"
                      style={{
                        fontSize: '10px',
                        minWidth: '26px',
                        color: minW > 0 ? 'var(--fg)' : 'var(--mut)',
                        fontWeight: minW > 0 ? 700 : 500,
                      }}
                    >
                      {minW <= 0 ? 'Off' : `${Math.round(minW * 100)}%`}
                    </span>
                  </div>
                );
              })()}

              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '2px',
                  paddingLeft: '6px',
                  borderLeft: '1px solid var(--line)',
                  marginLeft: '2px',
                }}
              >
                {(['2d', 'densitogram', '1d'] as const).map((mode) => {
                  const isActive = (activePlateSet.spotDetectorMode ?? '2d') === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        const uid = currentSet.uid;
                        setSets((prev) =>
                          prev.map((s) =>
                            s.uid === uid
                              ? updateTlcPlateSlice(s, plate, { spotDetectorMode: mode })
                              : s
                          )
                        );
                      }}
                      style={{
                        border: 'none',
                        background: isActive ? 'var(--bg)' : 'transparent',
                        color: isActive ? 'var(--pri)' : 'var(--mut)',
                        fontSize: '10px',
                        fontWeight: isActive ? 700 : 500,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                      }}
                      title={
                        mode === '2d'
                          ? '2D Region & Watershed Segmentation (default) — segments real 2D spot boundaries and compares near-front spots against the plate-wide meniscus'
                          : mode === 'densitogram'
                          ? 'Direct Densitogram Cutoff — picks local peaks directly from the core densitogram above the Cutoff line between origin and solvent front'
                          : 'Legacy 1D Profile Peak Detector — fallback for A/B comparison'
                      }
                    >
                      {mode === '2d' ? '2D Seg' : mode === 'densitogram' ? 'Densitogram' : '1D Legacy'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectablePlatesCount > 1 && (
            <label className="tlcz" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <span>Plate:</span>
              <select
                className="f"
                value={plate}
                onChange={(e) => setPlate(parseInt(e.target.value, 10))}
              >
                {Array.from({ length: selectablePlatesCount }, (_, idx) => (
                  <option key={idx} value={idx}>
                    Plate {idx + 1}{tlcSetPlateHasImages(currentSet, idx) ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Quick Well Jump in TLC View */}
          <div
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: 'var(--soft)',
              padding: '2px 8px',
              borderRadius: '6px',
              border: '1px solid var(--line)',
            }}
          >
            <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 600 }}>Jump to well:</span>
            <input
              type="text"
              placeholder="A1, B4, F9..."
              value={tlcQuickJump}
              onChange={(e) => {
                const val = e.target.value;
                setTlcQuickJump(val);
                const parsed = parseWellQuery(val, selectablePlatesCount);
                if (parsed) {
                  setPlate(parsed.plateIndex);
                  setInspectWell(parsed.wellIndex);
                  toast(`Inspecting Well ${parsed.label} in TLC Lane ${parsed.laneIndex}`);
                }
              }}
              style={{
                width: '85px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: '11px',
                color: 'var(--fg)',
                fontFamily: 'monospace',
                textTransform: 'uppercase',
              }}
            />
            {tlcQuickJump && (
              <button
                type="button"
                onClick={() => setTlcQuickJump('')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--mut)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: 0,
                }}
                title="Clear jump"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Status Chips */}
        <div className="tlcstat" style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {selectablePlatesCount > 1 && (
            <span className="chip" style={{ fontSize: '11px', fontWeight: 700, background: 'var(--soft)' }}>
              Plate {plate + 1} of {selectablePlatesCount}
            </span>
          )}
          {hasConfig ? (
            <span className="chip ok" style={{ fontSize: '11px' }}>
              ✓ {activePlateSet.cfg?.lanes.length} lanes · {activePlateSet.cfgName}
              {activePlateSet.cfg?.hasZeroRf
                ? ' · microadjusted origins'
                : activePlateSet.originPx
                ? ` · manual origin (${activePlateSet.originPx} px)`
                : ' · auto-detected baseline'}
            </span>
          ) : (
            <span className="chip warn" style={{ fontSize: '11px' }}>
              ⚠️ No lane CSV loaded for Plate {plate + 1} yet
            </span>
          )}

          {TLC_KEYS.map((k) => {
            const hasImg = Boolean(activePlateSet.imgs[k]);
            return hasImg ? (
              <label
                key={k}
                className="chip"
                style={{
                  fontSize: '11px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: 'pointer',
                  background: 'var(--soft)',
                }}
              >
                <input
                  type="checkbox"
                  checked={show[k]}
                  onChange={(e) => setShow((prev) => ({ ...prev, [k]: e.target.checked }))}
                />
                <b>{TLC_LABEL[k]}</b>
                <span className="mono" style={{ color: 'var(--mut)', fontSize: '10px' }}>
                  {activePlateSet.imgs[k].name.length > 20
                    ? '…' + activePlateSet.imgs[k].name.slice(-18)
                    : activePlateSet.imgs[k].name}
                </span>
                {activePlateSet.imgs[k].floatRgb && (
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      color: '#38bdf8',
                      background: 'rgba(56, 189, 248, 0.14)',
                      padding: '0 4px',
                      borderRadius: '3px',
                    }}
                    title="Loaded directly from float32 .npy radiance array (unclipped precision)"
                  >
                    .npy
                  </span>
                )}
                {activePlateSet.imgs[k].preFlatFielded && (
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      color: '#10b981',
                      background: 'rgba(16, 185, 129, 0.14)',
                      padding: '0 4px',
                      borderRadius: '3px',
                    }}
                    title="Already lighting-corrected by your lab PC (uni_linint_corrected); duplicate blank-silica correction is skipped automatically"
                  >
                    Flat ✓
                  </span>
                )}
                <button
                  type="button"
                  title={`Remove ${TLC_LABEL[k]} photo from Plate ${plate + 1}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRemoveImage(k);
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'var(--mut)',
                    marginLeft: '4px',
                    padding: '0 2px',
                    fontSize: '12px',
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--mut)')}
                >
                  ✕
                </button>
              </label>
            ) : null;
          })}

          {!hasImages && (
            <span className="chip warn" style={{ fontSize: '11px' }}>
              ⚠️ No Plate {plate + 1} images loaded yet
            </span>
          )}
        </div>

        {/* Image Adjustment Filters & Sampling Corridor Bar */}
        <div
          className="tlcfilt"
          style={{
            marginTop: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: 'var(--soft)',
            borderRadius: '6px',
            border: '1px solid var(--line)',
            fontSize: '12px',
          }}
        >
          <span style={{ fontWeight: 600 }}>Plate Filter:</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span>Brightness:</span>
            <input
              type="range"
              min="25"
              max="300"
              step="5"
              value={filters.brightness}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, brightness: parseInt(e.target.value, 10) }))
              }
            />
            <span className="mono" style={{ width: '36px', fontSize: '11px' }}>{filters.brightness}%</span>
          </label>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span>Contrast:</span>
            <input
              type="range"
              min="25"
              max="300"
              step="5"
              value={filters.contrast}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, contrast: parseInt(e.target.value, 10) }))
              }
            />
            <span className="mono" style={{ width: '36px', fontSize: '11px' }}>{filters.contrast}%</span>
          </label>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filters.invert}
              onChange={(e) => setFilters((prev) => ({ ...prev, invert: e.target.checked }))}
            />
            <span>Invert</span>
          </label>

          <div style={{ height: '16px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* Edge Spillover Rejection Slider */}
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
            title="Sampling corridor width for the lane. Narrower values (e.g. 30%) completely reject neighbor spot bleed."
          >
            <span style={{ fontWeight: 600, color: 'var(--pri)' }}>🛡️ Core Sampling Width:</span>
            <input
              type="range"
              min="0.20"
              max="0.60"
              step="0.05"
              value={coreFraction}
              onChange={(e) => {
                const cf = parseFloat(e.target.value);
                setCoreFraction(cf);
                // Clear cached profiles and auto-detected fronts across all plates to recompute with new core corridor
                setSets((prev) =>
                  prev.map((s) => {
                    const nextPlateData = s.plateData
                      ? Object.fromEntries(
                          Object.entries(s.plateData).map(([pK, pd]) => [
                            pK,
                            { ...pd, prof: {}, frontAuto: {}, frontAutoByLane: {}, originAuto: {}, originAutoByLane: {} },
                          ])
                        )
                      : undefined;
                    return {
                      ...s,
                      prof: {},
                      frontAuto: {},
                      frontAutoByLane: {},
                      originAuto: {},
                      originAutoByLane: {},
                      ...(nextPlateData ? { plateData: nextPlateData } : {}),
                    };
                  })
                );
              }}
            />
            <span className="mono" style={{ fontSize: '11px', width: '32px' }}>
              {Math.round(coreFraction * 100)}%
            </span>
          </label>

          <div style={{ height: '16px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* Once-per-camera Blank Silica Flat-Field Calibration */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => fileBlankRef.current?.click()}
              title="Upload a photo of a blank unspotted silica plate (once per camera/channel) to divide out uneven UV lamps, lens vignetting, and UV365 glare across all plates."
              style={{ fontSize: '11px' }}
            >
              Blank Silica Flat-Field
            </button>
            <input
              ref={fileBlankRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              style={{ display: 'none' }}
              onChange={handleLoadBlankSilica}
            />
            {Object.keys(blankMeta).length > 0 && (
              <>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '11px' }}>
                  <input
                    type="checkbox"
                    checked={blankEnabled}
                    onChange={(e) => handleToggleBlankSilica(e.target.checked)}
                  />
                  <span style={{ color: blankEnabled ? '#10b981' : 'var(--mut)', fontWeight: 600 }}>
                    Active
                  </span>
                </label>
                {TLC_KEYS.filter((k) => Boolean(blankMeta[k])).map((k) => (
                  <span
                    key={k}
                    className="chip"
                    style={{
                      fontSize: '10px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '1px 6px',
                      background: blankEnabled ? 'rgba(16, 185, 129, 0.14)' : 'var(--panel)',
                      borderColor: blankEnabled ? 'rgba(16, 185, 129, 0.4)' : 'var(--line)',
                    }}
                    title={`Flat-field reference for ${k}: ${blankMeta[k]?.name}`}
                  >
                    <span>{k}</span>
                    <button
                      type="button"
                      onClick={() => handleClearBlankSilica(k)}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--mut)', padding: 0, fontSize: '11px' }}
                      title={`Remove ${k} blank silica reference`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>

          <div style={{ height: '16px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* Per-Plate Spotted Undeveloped Reference (exact origin registration merged with developed plate) */}
          {(() => {
            const loadedPreKeys = TLC_KEYS.filter((k) =>
              Boolean(activePlateSet.preRunImgs?.[k]?.bmp || activePlateSet.preRunImgs?.[k]?.floatRgb)
            );
            const preOn = activePlateSet.preRunEnabled !== false;
            const align0 = activePlateSet.preRunAlignment?.[0];
            const align1 = activePlateSet.preRunAlignment?.[1];
            const alignSummary = [align0, align1]
              .map((a, idx) =>
                a
                  ? `${idx === 0 ? 'Lower' : 'Upper'}: ${a.dyPx >= 0 ? '+' : ''}${a.dyPx} px shift (${a.matchedAnchors} anchors)`
                  : null
              )
              .filter(Boolean)
              .join(' · ');
            return (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => filePreRunRef.current?.click()}
                  title={`Upload spotted-but-undeveloped pre-run photos (UV254, UV366, White) for Plate ${plate + 1}. Origins are detected cleanly before elution and rigidly aligned with your developed plate.`}
                  style={{ fontSize: '11px' }}
                >
                  Undeveloped Origin Ref
                </button>
                <input
                  ref={filePreRunRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,.npy"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleLoadPreRunImages}
                />
                {loadedPreKeys.length > 0 && (
                  <>
                    <label
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', fontSize: '11px' }}
                      title={alignSummary || 'Toggle merging undeveloped pre-run origins with the developed plate'}
                    >
                      <input
                        type="checkbox"
                        checked={preOn}
                        onChange={(e) => handleTogglePreRun(e.target.checked)}
                      />
                      <span style={{ color: preOn ? '#f59e0b' : 'var(--mut)', fontWeight: 600 }}>
                        Active
                      </span>
                    </label>
                    {loadedPreKeys.map((k) => (
                      <span
                        key={k}
                        className="chip"
                        style={{
                          fontSize: '10px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '1px 6px',
                          background: preOn ? 'rgba(245, 158, 11, 0.14)' : 'var(--panel)',
                          borderColor: preOn ? 'rgba(245, 158, 11, 0.45)' : 'var(--line)',
                        }}
                        title={`Plate ${plate + 1} undeveloped ${k} reference: ${activePlateSet.preRunImgs?.[k]?.name || k}${alignSummary ? ' — ' + alignSummary : ''}`}
                      >
                        <span>{k}</span>
                        <button
                          type="button"
                          onClick={() => handleClearPreRunImage(k)}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--mut)', padding: 0, fontSize: '11px' }}
                          title={`Remove Plate ${plate + 1} undeveloped ${k} reference`}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </>
                )}
              </div>
            );
          })()}

          <div style={{ height: '16px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* Lab PC Pipeline Toggles: Curved-Lane Tracking & Faint White-Spot Boost */}
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '11px' }}
            title="Follow gently curving or drifting lanes automatically using a smooth centerline spline (from your lab PC's savgol_automiddle method)"
          >
            <input
              type="checkbox"
              checked={automiddle}
              onChange={(e) => handleToggleAutomiddle(e.target.checked)}
            />
            <span style={{ fontWeight: automiddle ? 700 : 500, color: automiddle ? '#f59e0b' : 'var(--fg)' }}>
              Follow curved lanes
            </span>
          </label>

          {Boolean(activePlateSet.imgs?.White?.bmp) && (
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '11px' }}
              title="Subtract white silica background and boost contrast so very pale colored spots on the White-light image pop out clearly"
            >
              <input
                type="checkbox"
                checked={boostWhiteSpots}
                onChange={(e) => setBoostWhiteSpots(e.target.checked)}
              />
              <span style={{ fontWeight: boostWhiteSpots ? 700 : 500, color: boostWhiteSpots ? '#f59e0b' : 'var(--fg)' }}>
                Boost faint White spots
              </span>
            </label>
          )}

          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFilters({ brightness: 100, contrast: 100, invert: false });
              setCoreFraction(0.35);
              setBoostWhiteSpots(false);
              if (automiddle) handleToggleAutomiddle(false);
              else invalidateAllPlateCaches();
            }}
            style={{ marginLeft: 'auto', fontSize: '11px' }}
          >
            Reset
          </button>
        </div>

        {/* Collapsible Image & Meniscus Front Settings */}
        <details className="det" style={{ marginTop: '10px', fontSize: '12px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--fg)' }}>
            ⚙️ Advanced Image &amp; Solvent Front Calibration ({currentSet.name}{selectablePlatesCount > 1 ? ` · Plate ${plate + 1}` : ''})
          </summary>
          <div style={{ padding: '8px 12px', background: 'var(--soft)', borderRadius: '6px', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span>Reference Frame Width (px):</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '90px' }}
                  value={activePlateSet.frameW || LANE_FRAME_WIDTH}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 100) {
                      setSets((prev) => {
                        const next = [...prev];
                        if (!next[cur]) return next;
                        next[cur] = updateTlcPlateSlice(next[cur], plate, {
                          frameW: v,
                          prof: {},
                          frontAuto: {},
                          frontAutoByLane: {},
                          originAuto: {},
                          originAutoByLane: {},
                        });
                        return next;
                      });
                    }
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span>Spot Origin Baseline (px from start):</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '90px' }}
                  placeholder="auto"
                  value={activePlateSet.originPx || ''}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setSets((prev) => {
                      const next = [...prev];
                      if (!next[cur]) return next;
                      next[cur] = updateTlcPlateSlice(next[cur], plate, (slice) => {
                        const nextCfg = slice.cfg
                          ? {
                              ...slice.cfg,
                              hasZeroRf: false,
                              lanes: slice.cfg.lanes.map((l) => ({ ...l, zeroRf: null })),
                            }
                          : slice.cfg;
                        return {
                          cfg: nextCfg,
                          originPx: v && v > 0 ? v : null,
                          prof: {},
                          originAuto: {},
                          originAutoByLane: {},
                        };
                      });
                      return next;
                    });
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span>Solvent Front (px from start):</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '90px' }}
                  placeholder="auto"
                  value={activePlateSet.frontPx || ''}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setSets((prev) => {
                      const next = [...prev];
                      if (!next[cur]) return next;
                      next[cur] = updateTlcPlateSlice(next[cur], plate, {
                        frontPx: v && v > 0 ? v : null,
                        prof: {},
                        frontAuto: {},
                        frontAutoByLane: {},
                      });
                      return next;
                    });
                  }}
                />
              </label>

              <button
                type="button"
                className="btn sm"
                onClick={handleAutoDetectBaselines}
                disabled={!hasImages || !hasConfig}
                title="Re-detect the origin baseline and solvent front directly from your plate photos without moving lane boxes"
              >
                Auto-detect Origin &amp; Front
              </button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
              Spot origin baseline (Rf = 0.00) and solvent front meniscus (Rf = 1.00) are automatically resolved from your lane profiles or microadjusted CSV. You can also specify manual overrides above.
              {activePlateSet.cfg && activePlateSet.cfg.lanes.length > 0 && hasImages && (
                <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {tlcDetectionNotes(activePlateSet, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)).map((n) => (
                    <div key={n.label} style={{ color: n.warning ? 'var(--warn)' : 'var(--mut)' }}>
                      {n.label}: {n.source}
                      {n.source === 'detected' ? ` (strength ${n.score.toFixed(1)})` : ''}
                      {n.warning ? ` — ${n.warning}` : ''}
                    </div>
                  ))}
                </div>
              )}
              {activePlateSet.cfg && activePlateSet.cfg.lanes.length > 0 && (
                <span style={{ color: 'var(--pri)', marginLeft: '6px' }}>
                  (Current baseline: {Math.round(tlcOrigin(activePlateSet, activePlateSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px · Solvent front: {tlcFront(activePlateSet, activePlateSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction))} px)
                </span>
              )}
            </div>
          </div>
        </details>
      </div>

      {/* Gemini Vision AI Final Plate QC Report Card */}
      {(qcLoading || qcError || qcResult) && (
        <div
          className="card"
          style={{
            marginBottom: '14px',
            borderColor: qcError
              ? 'rgba(239, 68, 68, 0.5)'
              : qcResult?.overallVerdict === 'good'
              ? 'rgba(16, 185, 129, 0.45)'
              : 'rgba(139, 92, 246, 0.45)',
            background: 'var(--panel)',
            padding: '12px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '13px' }}>AI Vision Plate QC ({TLC_LABEL[qcChannel]})</strong>
              {qcLoading && (
                <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
                  Inspecting annotated plate image for missed spots, false positives, and front/origin drift…
                </span>
              )}
              {!qcLoading && qcResult && (
                <span
                  className={`chip ${qcResult.overallVerdict === 'good' ? 'ok' : 'warn'}`}
                  style={{ fontSize: '11px', fontWeight: 600 }}
                >
                  {qcResult.overallVerdict === 'good'
                    ? 'Looks Clean'
                    : qcResult.overallVerdict === 'minor_fixes'
                    ? 'Minor Fixes Suggested'
                    : 'Needs Attention'}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setQcResult(null);
                setQcError(null);
              }}
              style={{ fontSize: '11px' }}
            >
              Dismiss
            </button>
          </div>

          {qcError && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#ef4444' }}>{qcError}</div>
          )}

          {!qcLoading && qcResult && (
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
              <div style={{ color: 'var(--fg)', lineHeight: 1.45 }}>{qcResult.summary}</div>

              {qcResult.laneAlignmentWarning && (
                <div
                  style={{
                    padding: '7px 10px',
                    borderRadius: '6px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>
                    Lane Alignment: {qcResult.laneAlignmentWarning}
                  </span>
                  <button
                    type="button"
                    className="btn sm pri"
                    onClick={() => {
                      setQcResult(null);
                      handleAutoDetectLanes();
                    }}
                    style={{ fontSize: '11px' }}
                  >
                    Auto-detect lanes
                  </button>
                </div>
              )}

              {/* Front & Origin Shift Audits */}
              {(qcResult.frontAudit.some((f) => f.status === 'shift') ||
                qcResult.originAudit.some((o) => o.status === 'shift')) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {qcResult.frontAudit
                    .filter((f) => f.status === 'shift' && Math.abs(f.suggestedShiftRf) >= 0.015)
                    .map((f) => (
                      <label
                        key={`front-${f.half}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 8px',
                          background: 'var(--soft)',
                          borderRadius: '6px',
                          border: '1px solid var(--line)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(qcSelectedFront[f.half])}
                          onChange={(e) =>
                            setQcSelectedFront((prev) => ({ ...prev, [f.half]: e.target.checked }))
                          }
                        />
                        <span style={{ color: '#22d3ee', fontWeight: 600 }}>
                          {f.half === 0 ? 'Lower' : 'Upper'} Front {f.suggestedShiftRf > 0 ? '+' : ''}
                          {Math.round(f.suggestedShiftRf * 100)}%
                        </span>
                        <span style={{ color: 'var(--mut)', fontSize: '11px' }}>— {f.note}</span>
                      </label>
                    ))}
                  {qcResult.originAudit
                    .filter((o) => o.status === 'shift' && Math.abs(o.suggestedShiftRf) >= 0.015)
                    .map((o) => (
                      <label
                        key={`origin-${o.half}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 8px',
                          background: 'var(--soft)',
                          borderRadius: '6px',
                          border: '1px solid var(--line)',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(qcSelectedOrigin[o.half])}
                          onChange={(e) =>
                            setQcSelectedOrigin((prev) => ({ ...prev, [o.half]: e.target.checked }))
                          }
                        />
                        <span style={{ color: '#facc15', fontWeight: 600 }}>
                          {o.half === 0 ? 'Lower' : 'Upper'} Origin {o.suggestedShiftRf > 0 ? '+' : ''}
                          {Math.round(o.suggestedShiftRf * 100)}%
                        </span>
                        <span style={{ color: 'var(--mut)', fontSize: '11px' }}>— {o.note}</span>
                      </label>
                    ))}
                </div>
              )}

              {/* Spot Additions & False-Positive Removals */}
              {qcResult.spotCorrections.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                    gap: '6px',
                    maxHeight: '210px',
                    overflowY: 'auto',
                    padding: '4px 2px',
                  }}
                >
                  {qcResult.spotCorrections.map((c, idx) => (
                    <div
                      key={`${c.laneId}-${c.action}-${c.rf}-${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '5px 8px',
                        background: 'var(--soft)',
                        borderRadius: '6px',
                        border: '1px solid var(--line)',
                        fontSize: '11.5px',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(qcSelectedSpots[idx])}
                        onChange={(e) =>
                          setQcSelectedSpots((prev) => ({ ...prev, [idx]: e.target.checked }))
                        }
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setInspectWell(containerOfLane(c.laneId));
                          setPinnedMarkers([]);
                          setHoverRf(null);
                          setHoverY(null);
                          setHoverSpot(null);
                        }}
                        className="mono"
                        style={{
                          border: 'none',
                          background: 'var(--panel)',
                          color: 'var(--fg)',
                          fontWeight: 700,
                          padding: '1px 5px',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                        title={`Inspect Well ${c.well}`}
                      >
                        {c.well}
                      </button>
                      <span
                        style={{
                          fontWeight: 700,
                          color: c.action === 'add' ? '#10b981' : '#f43f5e',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.action === 'add' ? '+ Add' : '− Remove'}
                      </span>
                      <span className="mono" style={{ color: 'var(--fg)' }}>
                        Rf {c.rf.toFixed(2)}
                      </span>
                      <span
                        style={{
                          color: 'var(--mut)',
                          fontSize: '10.5px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                        title={c.reason}
                      >
                        {c.reason}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(qcResult.spotCorrections.length > 0 ||
                qcResult.frontAudit.some((f) => f.status === 'shift') ||
                qcResult.originAudit.some((o) => o.status === 'shift')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <button
                    type="button"
                    className="btn sm pri"
                    onClick={handleApplyVisionQcFixes}
                  >
                    Apply Checked Fixes (
                    {Object.values(qcSelectedSpots).filter(Boolean).length +
                      Object.values(qcSelectedFront).filter(Boolean).length +
                      Object.values(qcSelectedOrigin).filter(Boolean).length}
                    )
                  </button>
                  <span style={{ fontSize: '11px', color: 'var(--mut)' }}>
                    Applies cleanly with Ctrl+Z undo support.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* View Mode: Full Plate Photo vs 54-Well Sliced Grid */}
      {viewMode === 'full-plate' ? (
        <div style={{ marginBottom: '16px' }}>
          {/* Channel selector for Full Plate view */}
          <div
            style={{
              display: 'flex',
              gap: '6px',
              justifyContent: 'center',
              marginBottom: '12px',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)' }}>Plate {plate + 1} Channel:</span>
            {TLC_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={`btn sm ${fullPlateChannel === k ? 'pri' : ''}`}
                onClick={() => setFullPlateChannel(k)}
                disabled={!activePlateSet.imgs[k]}
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                {TLC_LABEL[k]} {activePlateSet.imgs[k] ? '✓' : '(empty)'}
              </button>
            ))}
            {hasCompositeChannels(activePlateSet.imgs, false) && (
              <button
                type="button"
                className={`btn sm ${fullPlateChannel === 'composite' ? 'pri' : ''}`}
                onClick={() => setFullPlateChannel('composite')}
                style={{
                  fontSize: '11px',
                  padding: '4px 10px',
                  background: fullPlateChannel === 'composite' ? '#0f766e' : undefined,
                  borderColor: fullPlateChannel === 'composite' ? '#14b8a6' : undefined,
                  color: fullPlateChannel === 'composite' ? '#ffffff' : undefined,
                  fontWeight: 700,
                }}
                title="False-Color composite across all loaded channels (UV254, UV365, Visible)"
              >
                ✨ Composite ({getLoadedTlcChannels(activePlateSet.imgs, false).map((c) => (c === 'UV254' ? '254' : c === 'UV366' ? '365' : 'Vis')).join('+')}) ✓
              </button>
            )}
          </div>

          <TlcFullPlateView
            currentSet={activePlateSet}
            activeChannel={fullPlateChannel}
            onSelectChannel={setFullPlateChannel}
            filters={filters}
            onOpenWellModal={(w) => {
              setInspectWell(w);
              setPinnedMarkers([]);
              setHoverRf(null);
              setHoverY(null);
              setHoverSpot(null);
            }}
            run={run}
            plate={plate}
            getProfile={(s, k, ln) => extractLaneProfile(s, k, ln, coreFraction)}
            getCanonicalSpots={(ln) => getCompositeSpotsForLane(activePlateSet, ln)}
            onUpdateLane={handleUpdateLane}
            onUpdateLanesBatch={handleUpdateLanesBatch}
            onUpdateSetFront={handleUpdateSetFront}
            onAutoDetectBaselines={handleAutoDetectBaselines}
            onSnapshotHistory={handleSnapshotHistory}
            onUndo={handleUndo}
            canUndo={cfgHistory.length > 0}
            onResetLane={handleResetLane}
            onResetAllLanes={handleResetAllLanes}
            onExportLaneCsv={handleExportLaneCsv}
            spotProminence={spotProminence}
            pickMode={pickMode}
            picks={activePlateSet.edgePicks || []}
            onPickSpot={handlePickSpot}
            edgeFits={getEdgeFits(activePlateSet)}
            edgeSettings={[edgeSettingFor(activePlateSet, 0), edgeSettingFor(activePlateSet, 1)]}
            onEdgeSetting={handleEdgeSetting}
            onPickMode={setPickMode}
            pickGroup={pickGroup}
            onPickGroup={setPickGroup}
            onClearPicks={handleClearPicks}
            boostWhiteSpots={boostWhiteSpots}
            onToggleBoostWhiteSpots={setBoostWhiteSpots}
            automiddleEnabled={automiddle}
          />
        </div>
      ) : (
        /* 6x9 Plate Grid View */
        <div className="tlcwrap" style={{ overflowX: 'auto', paddingBottom: '16px' }}>
          {!hasImages && (
            <div
              style={{
                textAlign: 'center',
                padding: '32px 16px',
                background: 'var(--soft)',
                borderRadius: '8px',
                border: '1px dashed var(--line)',
                marginBottom: '16px',
              }}
            >
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>📷</div>
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
                No Plate {selectablePlatesCount > 1 ? `${plate + 1} ` : ''}Photographs Loaded
              </div>
              <div style={{ fontSize: '12px', color: 'var(--mut)', maxWidth: '520px', margin: '0 auto 12px' }}>
                Upload your laboratory Plate {plate + 1} TLC photographs using <b>{selectablePlatesCount > 1 ? `Upload Plate ${plate + 1} Photos` : 'Upload Plate Photos'}</b>{plate === 0 ? ', or test the live densitometer with realistic synthetic data below.' : '.'}
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn pri sm"
                  onClick={() => fileImgRef.current?.click()}
                >
                  📷 Upload Plate {plate + 1} Photos
                </button>
                {plate === 0 && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={handleLoadDemoTlc}
                  >
                    🧪 Try Demo TLC Plate
                  </button>
                )}
              </div>
            </div>
          )}

          <div
            className="tlcgrid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(9, minmax(100px, 1fr))',
              gap: '8px',
            }}
          >
            {allPanels.map((panels, wellIndex) => (
              <TlcWellCell
                key={wellIndex}
                wellIndex={wellIndex}
                run={run}
                plate={plate}
                panels={panels}
                zoom={zoom}
                hasCfg={hasConfig}
                filters={filters}
                markSpots={markSpots}
                boostWhiteSpots={boostWhiteSpots}
                onOpenModal={(w) => {
                  setInspectWell(w);
                  setPinnedMarkers([]);
                  setHoverRf(null);
                  setHoverY(null);
                  setHoverSpot(null);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Enlarged Inspection Modal with Pixel-Matched Parallel 1D Densitometer */}
      {inspectWell !== null && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setInspectWell(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal"
            style={{
              maxWidth: '1440px',
              width: '96vw',
              maxHeight: '96vh',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Modal Header */}
            <div className="modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>
                  Well <b>{wellLabel(inspectWell)}</b> · TLC Lane {tlcLane(inspectWell, 'column')} · Plate {plate + 1}
                </h3>
                {run?.rows && (
                  <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'var(--mut)' }}>
                    {(() => {
                      const row = run.rows.find(
                        (r: any) => r.plate_number === plate && r.container_id === inspectWell
                      );
                      if (!row) return 'No reaction vial allocated in this well.';
                      const parts = row.recipe
                        .filter((rc: any) => rc.target_concentration > 0)
                        .map((rc: any) => `${rc.code} ${rc.target_concentration.toFixed(2)} mM`);
                      parts.push(`solvent ${row['vol#solvent']?.toFixed(0)} µL`);
                      return `Rxn ${row.global_index + 1} · ${parts.join(' · ')}`;
                    })()}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => setInspectWell(null)}
                title="Close modal (Esc)"
                style={{
                  background: 'var(--soft)',
                  border: '1px solid var(--line)',
                  color: 'var(--fg)',
                  fontWeight: 600,
                  fontSize: '12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: 'pointer',
                }}
              >
                ✕ Close (Esc)
              </button>
            </div>

            {/* Modal Body */}
            <div className="modal-body" style={{ overflowY: 'auto', padding: '16px' }}>
              {inspectPanels.length > 0 ? (
                <div>
                  {/* Status & Channel Selector Bar */}
                  <div
                    style={{
                      background: 'var(--soft)',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      marginBottom: '12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600 }}>Channel View:</span>
                      <div className="tlcsets" style={{ display: 'inline-flex', gap: '4px', margin: 0 }}>
                        {hasCompositeChannels(activePlateSet.imgs, false) && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'overlay' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('overlay')}
                            style={{ fontSize: '11px', padding: '3px 8px' }}
                            title="Show loaded channels and False-Color Composite side by side with 3-channel peak detection"
                          >
                            Side-by-Side + Composite
                          </button>
                        )}
                        {channelDensitograms.UV254 && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'UV254' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('UV254')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#10b981' }}
                            title="Show UV 254 nm strip only"
                          >
                            ● UV 254 Only
                          </button>
                        )}
                        {channelDensitograms.UV366 && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'UV366' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('UV366')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#c084fc' }}
                            title="Show UV 365 nm fluorescence strip only"
                          >
                            ● UV 365 Only
                          </button>
                        )}
                        {channelDensitograms.White && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'White' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('White')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#f59e0b' }}
                            title="Show Visible stain strip only"
                          >
                            ● Visible Only
                          </button>
                        )}
                      </div>
                    </div>

                    {hoverRf !== null && (
                      <span
                        className="mono"
                        style={{
                          background: hoverSpot ? '#f43f5e' : 'var(--pri)',
                          color: '#fff',
                          padding: '3px 10px',
                          borderRadius: '4px',
                          fontWeight: 700,
                          fontSize: '12px',
                        }}
                      >
                        {hoverSpot
                          ? (hoverSpot.strength > 0
                              ? `Peak Apex: Rf ${hoverSpot.rf.toFixed(2)}${hoverSpot.rfRaw != null && Math.abs(hoverSpot.rf - hoverSpot.rfRaw) >= 0.005 ? ` (${hoverSpot.rfRaw.toFixed(2)} raw)` : ''} (${hoverSpot.strength > 0.5 ? 'strong' : hoverSpot.strength > 0.2 ? 'medium' : 'weak'}, ${hoverSpot.areaPct || 0}% area${typeof hoverSpot.confidence === 'number' ? `, ${Math.round(hoverSpot.confidence * 100)}% conf` : ''}${typeof hoverSpot.tailing === 'number' && hoverSpot.tailing > 1.6 ? `, tail ${hoverSpot.tailing.toFixed(1)}×` : ''})`
                              : `Rf: ${hoverSpot.rf.toFixed(2)}${hoverSpot.rfRaw != null && Math.abs(hoverSpot.rf - hoverSpot.rfRaw) >= 0.005 ? ` (${hoverSpot.rfRaw.toFixed(2)} raw)` : ''}`)
                          : `Rf: ${hoverRf.toFixed(2)}`}
                      </span>
                    )}
                  </div>

                  {/* Side-by-Side Split View: Visualizer on Left (Sticky), Micro-Adjust & Findings on Right */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '20px',
                      alignItems: 'flex-start',
                    }}
                  >
                    {/* Left Column: Physical Canvas & Densitometer */}
                    <div
                      style={{
                        position: 'relative',
                        flex: '0 0 auto',
                        maxWidth: '100%',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: '0px',
                          justifyContent: 'center',
                          alignItems: 'stretch',
                          background: '#090d0c',
                          padding: '20px 16px',
                          borderRadius: '8px',
                          border: '1px solid rgba(255,255,255,0.12)',
                          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                          overflowX: 'auto',
                        }}
                      >
                    {/* Enlarged Physical TLC Canvas: Side-by-Side Channels */}
                    <div>
                      {/* Side-by-side Channel Header Badges */}
                      <div
                        style={{
                          display: 'flex',
                          gap: '6px',
                          marginBottom: '6px',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {inspectPanels.map((p, idx) => {
                          const isComp = (p as any).isComposite;
                          const title = (p as any).channelTitle || p.label || p.key;
                          const color = isComp
                            ? '#22d3ee'
                            : p.key === 'UV254'
                            ? '#10b981'
                            : p.key === 'UV366'
                            ? '#c084fc'
                            : '#fbbf24';
                          const bg = isComp
                            ? 'rgba(34, 211, 238, 0.15)'
                            : p.key === 'UV254'
                            ? 'rgba(16, 185, 129, 0.15)'
                            : p.key === 'UV366'
                            ? 'rgba(192, 132, 252, 0.15)'
                            : 'rgba(251, 191, 36, 0.15)';
                          const border = isComp
                            ? 'rgba(34, 211, 238, 0.35)'
                            : p.key === 'UV254'
                            ? 'rgba(16, 185, 129, 0.35)'
                            : p.key === 'UV366'
                            ? 'rgba(192, 132, 252, 0.35)'
                            : 'rgba(251, 191, 36, 0.35)';
                          const pw = Math.round(1.0 * p.lane.width);
                          return (
                            <div
                              key={idx}
                              style={{
                                width: `${pw}px`,
                                minWidth: '40px',
                                textAlign: 'center',
                                padding: '3px 2px',
                                background: bg,
                                border: `1px solid ${border}`,
                                borderRadius: '4px',
                                fontSize: '10px',
                                fontWeight: 700,
                                color,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={title}
                            >
                              {title}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ position: 'relative', display: 'inline-block' }}>
                        <canvas
                          ref={bigCanvasRef}
                          onMouseMove={handleCanvasMouseMove}
                          onMouseDown={handleCanvasMouseDown}
                          onMouseLeave={() => {
                            if (!isDraggingModalSpot) {
                              setHoverRf(null);
                              setHoverY(null);
                              setHoverSpot(null);
                              setHoveredModalSpotIdx(null);
                            }
                          }}
                          onClick={handleCanvasClick}
                          style={{
                            cursor: isDraggingModalSpot ? 'ns-resize' : hoveredModalSpotIdx !== null ? 'ns-resize' : 'crosshair',
                            display: 'block',
                            boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
                            borderRadius: '3px 0 0 3px',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRight: 'none',
                            filter: `brightness(${filters.brightness}%) contrast(${filters.contrast}%) ${
                              filters.invert ? 'invert(1)' : ''
                            }`,
                          }}
                        />

                        {/* Interactive Spot Guide Lines & Drag Grab Handles */}
                        {(() => {
                          const primary = inspectPanels[0];
                          const spots = modalActiveSpots;
                          if (!primary || !spots.length) return null;
                          const l = primary.lane;
                          const ph = inspectHeight;

                          return spots.map((sp, idx) => {
                            const y = ph - sp.pos;
                            const isHovered = hoveredModalSpotIdx === idx;
                            const isDragged = isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                            const confStyle = getSpotConfidenceStyle(sp.confidence);
                            const spotColor = isDragged
                              ? '#facc15'
                              : sp.source === 'manual'
                              ? '#f59e0b'
                              : sp.source === 'adjusted'
                              ? '#a855f7'
                              : confStyle.color;

                            return (
                              <div
                                key={idx}
                                onMouseEnter={() => setHoveredModalSpotIdx(idx)}
                                onMouseLeave={() => setHoveredModalSpotIdx((prev) => (prev === idx ? null : prev))}
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  right: 0,
                                  top: `${y}px`,
                                  height: '0px',
                                  zIndex: isDragged ? 25 : isHovered ? 20 : 15,
                                  pointerEvents: 'none',
                                }}
                              >
                                {/* Full-width spot horizontal guideline */}
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    top: '-1px',
                                    height: isDragged || isHovered ? '2.5px' : '1.5px',
                                    background: spotColor,
                                    boxShadow: isDragged
                                      ? '0 0 10px #facc15, 0 0 4px #000'
                                      : isHovered
                                      ? `0 0 6px ${spotColor}`
                                      : '0 0 2px rgba(0,0,0,0.8)',
                                    pointerEvents: 'none',
                                  }}
                                />

                                {/* Grab Handle / Pill at Center */}
                                <div
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    if (e.altKey) {
                                      handleDeleteSpotInModal(idx);
                                      return;
                                    }
                                    const zeroDist = tlcOrigin(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
                                    const frontPos = tlcFront(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
                                    const span = Math.max(1, frontPos - zeroDist);
                                    dragModalSpotRef.current = {
                                      laneId: l.id,
                                      spotIndex: idx,
                                      startPos: sp.pos,
                                      startRf: sp.rf,
                                      originDist: zeroDist,
                                      spanDist: span,
                                      laneLength: ph,
                                      initialSpots: JSON.parse(JSON.stringify(spots)),
                                    };
                                    setIsDraggingModalSpot(true);
                                    handleSnapshotHistory();
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (e.altKey) {
                                      handleDeleteSpotInModal(idx);
                                    }
                                  }}
                                  title={`Spot #${idx + 1} (${sp.source || 'auto'}${(!sp.source || sp.source === 'auto') && typeof sp.confidence === 'number' ? `, ${confStyle.pct}% ${confStyle.label}` : ''}): Rf ${sp.rf.toFixed(2)}\n• Drag vertically to slide Rf\n• Alt+Click to remove spot`}
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '-8px',
                                    transform: 'translateX(-50%)',
                                    height: '16px',
                                    minWidth: '28px',
                                    padding: '0 5px',
                                    borderRadius: '8px',
                                    background: isDragged ? '#facc15' : isHovered ? '#ffffff' : spotColor,
                                    color: isDragged || isHovered || sp.source === 'manual' || ((!sp.source || sp.source === 'auto') && (confStyle.tier === 'medium' || confStyle.tier === 'very-high' || confStyle.tier === 'low')) ? '#0f172a' : '#ffffff',
                                    boxShadow: '0 2px 6px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4)',
                                    cursor: 'ns-resize',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '9px',
                                    fontWeight: 800,
                                    fontFamily: 'monospace',
                                    userSelect: 'none',
                                    pointerEvents: 'auto',
                                  }}
                                >
                                  {sp.source === 'manual' ? '✋' : sp.source === 'adjusted' ? '✨' : '●'}
                                </div>

                                {/* Rf Tag on Left edge */}
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: '2px',
                                    top: '-16px',
                                    background: 'rgba(0,0,0,0.85)',
                                    border: `1px solid ${spotColor}`,
                                    color: spotColor,
                                    fontSize: '9px',
                                    fontWeight: 700,
                                    fontFamily: 'monospace',
                                    padding: '0 4px',
                                    borderRadius: '2px',
                                    pointerEvents: 'none',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  #{idx + 1} Rf {sp.rf.toFixed(2)}
                                  {(!sp.source || sp.source === 'auto') && typeof sp.confidence === 'number'
                                    ? ` · ${confStyle.pct}%`
                                    : ''}
                                </div>
                              </div>
                            );
                          });
                        })()}

                        {/* Live Cursor Crosshair Bar across lane */}
                        {hoverY !== null && (
                          <div
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: 0,
                              top: `${hoverY}px`,
                              height: '1px',
                              background: isDraggingModalSpot ? '#facc15' : hoverSpot ? '#f43f5e' : '#38bdf8',
                              boxShadow: isDraggingModalSpot ? '0 0 8px #facc15' : hoverSpot ? '0 0 6px #f43f5e' : '0 0 4px #38bdf8',
                              pointerEvents: 'none',
                              zIndex: 30,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                left: '4px',
                                top: '-16px',
                                background: 'rgba(0,0,0,0.85)',
                                color: isDraggingModalSpot ? '#facc15' : hoverSpot ? '#f43f5e' : '#38bdf8',
                                fontSize: '10px',
                                fontWeight: 700,
                                fontFamily: 'monospace',
                                padding: '1px 4px',
                                borderRadius: '2px',
                              }}
                            >
                              {isDraggingModalSpot ? `Dragging Spot: Rf ${hoverRf?.toFixed(2)}` : hoverSpot && hoverSpot.rfRaw != null && Math.abs(hoverSpot.rf - hoverSpot.rfRaw) >= 0.005
                                ? `${hoverSpot.rf.toFixed(2)} (${hoverSpot.rfRaw.toFixed(2)})`
                                : `Rf ${hoverRf?.toFixed(2)}`}
                            </span>
                          </div>
                        )}

                        {/* Render Pinned Markers on Canvas */}
                        {pinnedMarkers.map((m) => (
                          <div
                            key={m.id}
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: 0,
                              top: `${m.y}px`,
                              height: '2px',
                              background: '#7CFC9A',
                              boxShadow: '0 0 4px #7CFC9A',
                              pointerEvents: 'none',
                              zIndex: 9,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                left: '4px',
                                top: '-16px',
                                background: 'rgba(0,0,0,0.85)',
                                color: '#7CFC9A',
                                fontSize: '10px',
                                fontWeight: 700,
                                fontFamily: 'monospace',
                                padding: '1px 4px',
                                borderRadius: '2px',
                              }}
                            >
                              {m.label}: Rf {m.rf.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Multi-Channel False-Color Legend */}
                      {densViewMode === 'overlay' && hasCompositeChannels(activePlateSet.imgs, true) && (
                        <div
                          style={{
                            marginTop: '8px',
                            padding: '6px 10px',
                            background: 'rgba(0, 0, 0, 0.45)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '12px',
                            fontSize: '10px',
                            fontFamily: 'monospace',
                            flexWrap: 'wrap',
                          }}
                        >
                          {activePlateSet.imgs?.UV254?.bmp && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#fbbf24', fontWeight: 600 }}>
                              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#fbbf24' }} />
                              Amber: UV 254 (Quenching)
                            </span>
                          )}
                          {activePlateSet.imgs?.UV366?.bmp && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#22d3ee', fontWeight: 600 }}>
                              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22d3ee' }} />
                              Cyan: UV 365 (Fluorescent)
                            </span>
                          )}
                          {activePlateSet.imgs?.White?.bmp && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#f472b6', fontWeight: 600 }}>
                              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#f472b6' }} />
                              Rose: Visible (Stain)
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Pixel-Matched Parallel Densitometer SVG (Base to Solvent Front) */}
                    {activeDens && inspectPanels[0] && (
                      <div
                        style={{
                          width: '320px',
                          display: 'flex',
                          flexDirection: 'column',
                          background: '#040605',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '0 3px 3px 0',
                          position: 'relative',
                        }}
                      >
                        <div
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            color: '#94a3b8',
                            padding: '3px 8px 3px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '6px',
                            borderBottom: '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <span style={{ textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                            Densitogram
                            {activePlateSet.spotDetectorMode === 'densitogram' && (
                              <span style={{ color: '#fbbf24', marginLeft: '5px', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
                                · Drag Cutoff ↔
                              </span>
                            )}
                          </span>
                          {(activePlateSet.spotDetectorMode ?? '2d') !== '1d' && (() => {
                            const minW = activePlateSet.minSpotWidthFrac ?? DEFAULT_MIN_SPOT_WIDTH_FRAC;
                            return (
                              <label
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  fontWeight: 600,
                                  color: '#cbd5e1',
                                  cursor: 'pointer',
                                }}
                                title="Microdroplet Filter (2D Min Spot Width): rejects narrow spotter microdroplets & skinny vertical runs narrower than X% of lane width (0% = Off)"
                              >
                                <span style={{ fontSize: '9.5px', color: '#94a3b8' }}>Min W</span>
                                <input
                                  type="range"
                                  min="0"
                                  max="0.56"
                                  step="0.02"
                                  value={minW}
                                  onChange={(e) => {
                                    const v = Math.round(parseFloat(e.target.value) * 100) / 100;
                                    const uid = currentSet.uid;
                                    setSets((prev) =>
                                      prev.map((s) =>
                                        s.uid === uid
                                          ? updateTlcPlateSlice(s, plate, { minSpotWidthFrac: v })
                                          : s
                                      )
                                    );
                                  }}
                                  style={{ width: '46px', height: '12px', cursor: 'pointer' }}
                                />
                                <span className="mono" style={{ fontSize: '9.5px', minWidth: '24px', textAlign: 'right', color: minW > 0 ? '#38bdf8' : '#64748b' }}>
                                  {minW <= 0 ? 'Off' : `${Math.round(minW * 100)}%`}
                                </span>
                              </label>
                            );
                          })()}
                        </div>

                        {/* Interactive Pixel-Matched SVG Densitogram */}
                        {(() => {
                          const primary = inspectPanels[0];
                          const l = primary.lane;
                          const ph = inspectHeight;
                          const originY = ph - tlcOrigin(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));
                          const frontY = ph - tlcFront(primary.s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));

                          return (
                            <svg
                              ref={densSvgRef}
                              width="320"
                              height={ph}
                              viewBox={`0 0 320 ${ph}`}
                              style={{
                                display: 'block',
                                background: '#020403',
                                cursor: draggingCutoff ? 'ew-resize' : 'crosshair',
                                userSelect: 'none',
                              }}
                              onMouseMove={draggingCutoff ? undefined : handleCanvasMouseMove}
                              onMouseLeave={() => {
                                setHoverRf(null);
                                setHoverY(null);
                                setHoverSpot(null);
                              }}
                              onClick={handleCanvasClick}
                            >
                              <defs>
                                <linearGradient id="uv254Grad" x1="0" y1="0" x2="1" y2="0">
                                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.05" />
                                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.4" />
                                </linearGradient>
                                <linearGradient id="uv366Grad" x1="0" y1="0" x2="1" y2="0">
                                  <stop offset="0%" stopColor="#a855f7" stopOpacity="0.05" />
                                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0.4" />
                                </linearGradient>
                              </defs>

                              {/* Origin (Base) Line (Rf = 0.00) matching yellow ticks on lane */}
                              <line
                                x1="0"
                                y1={originY}
                                x2="310"
                                y2={originY}
                                stroke="#FFC857"
                                strokeWidth="1.5"
                                strokeDasharray="3,3"
                              />
                              <text x="312" y={originY + 3} fill="#FFC857" fontSize="9" fontFamily="monospace" textAnchor="end">
                                Origin (Rf 0.00)
                              </text>

                              {/* Solvent Front Line (Rf = 1.00) matching meniscus */}
                              <line
                                x1="0"
                                y1={frontY}
                                x2="310"
                                y2={frontY}
                                stroke="#38bdf8"
                                strokeWidth="1.5"
                                strokeDasharray="3,3"
                              />
                              <text x="312" y={frontY + 3} fill="#38bdf8" fontSize="9" fontFamily="monospace" textAnchor="end">
                                Front (Rf 1.00)
                              </text>

                              {/* Intermediate Rf tick lines (0.25, 0.50, 0.75) */}
                              {[0.25, 0.5, 0.75].map((rfVal) => {
                                const y = originY - rfVal * (originY - frontY);
                                return (
                                  <g key={rfVal}>
                                    <line x1="0" y1={y} x2="310" y2={y} stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
                                    <text x="312" y={y + 3} fill="#64748b" fontSize="8" fontFamily="monospace" textAnchor="end">
                                      Rf {rfVal.toFixed(2)}
                                    </text>
                                  </g>
                                );
                              })}

                              {/* Baseline Reference Axis (X = 40) */}
                              <line x1="40" y1="0" x2="40" y2={ph} stroke="rgba(255,255,255,0.12)" strokeWidth="1" />

                              {/* Render Channel Densitogram Traces & Unified Modal Spot Markers */}
                              {(() => {
                                const visibleChannels: TlcChannelKey[] =
                                  densViewMode === 'overlay'
                                    ? (['UV254', 'UV366', 'White'] as TlcChannelKey[]).filter((ch) => Boolean(channelDensitograms[ch]))
                                    : channelDensitograms[densViewMode]
                                    ? [densViewMode]
                                    : [];

                                const channelMeta: Record<
                                  TlcChannelKey,
                                  { stroke: string; fill: string; dash?: string }
                                > = {
                                  UV254: { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.18)' },
                                  UV366: {
                                    stroke: '#a855f7',
                                    fill: 'rgba(168, 85, 247, 0.18)',
                                    dash: densViewMode === 'overlay' ? '4,2' : undefined,
                                  },
                                  White: {
                                    stroke: '#f59e0b',
                                    fill: 'rgba(245, 158, 11, 0.18)',
                                    dash: densViewMode === 'overlay' ? '2,2' : undefined,
                                  },
                                };

                                const getScaleMax = (d: TlcDensitogramData, hasChannelSpots: boolean) => {
                                  if (draggingCutoff && cutoffDragRef.current) {
                                    return cutoffDragRef.current.scaleMax;
                                  }
                                  const baseMax = hasChannelSpots ? d.maxSignal : Math.max(d.maxSignal, 28);
                                  return d.densitogramCutoff != null
                                    ? Math.max(baseMax, d.densitogramCutoff * 1.25)
                                    : baseMax;
                                };

                                const curveXAtPos = (d: TlcDensitogramData, pos: number, scaleMax: number) => {
                                  const clamped = Math.max(0, Math.min(d.points.length - 1, Math.round(pos)));
                                  const pt = d.points[clamped];
                                  return 40 + Math.min(230, ((pt?.signal || 0) / Math.max(1e-6, scaleMax)) * 230);
                                };

                                // Match canonical modalActiveSpots to each channel for shading so the densitogram
                                // never shades or plots unmerged/suppressed duplicate spots that aren't in the list.
                                const channelSpotMap: Partial<Record<TlcChannelKey, TlcSpot[]>> = {};
                                const channelScaleMap: Partial<Record<TlcChannelKey, number>> = {};
                                for (const ch of visibleChannels) {
                                  const d = channelDensitograms[ch]!;
                                  const chSpots = modalActiveSpots.filter(
                                    (sp) =>
                                      !sp.channels ||
                                      sp.channels.length === 0 ||
                                      sp.channels.includes(ch) ||
                                      densViewMode === ch
                                  );
                                  channelSpotMap[ch] = chSpots;
                                  channelScaleMap[ch] = getScaleMax(d, chSpots.length > 0);
                                }

                                return (
                                  <>
                                    {visibleChannels.map((ch) => {
                                      const d = channelDensitograms[ch]!;
                                      const pts = d.points;
                                      if (!pts.length) return null;
                                      const scaleMax = channelScaleMap[ch] ?? Math.max(d.maxSignal, 28);
                                      const chSpots = channelSpotMap[ch] ?? [];
                                      const meta = channelMeta[ch];
                                      const dStr = pts
                                        .map((p) => {
                                          const y = ph - p.pos;
                                          const x = 40 + Math.min(230, (p.signal / Math.max(1e-6, scaleMax)) * 230);
                                          return `${y === ph - pts[0].pos ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                                        })
                                        .join(' ');
                                      const showCutoff =
                                        d.densitogramCutoff != null &&
                                        (densViewMode !== 'overlay' || ch === visibleChannels[0]);
                                      const cutoffX =
                                        showCutoff && d.densitogramCutoff != null
                                          ? 40 + Math.min(230, (d.densitogramCutoff / Math.max(1e-6, scaleMax)) * 230)
                                          : null;

                                      return (
                                        <g key={ch}>
                                          {chSpots.map((sp, idx) => {
                                            // Prefer this channel's closest matching segmented extent (never steal an adjacent doublet's fill)
                                            let rawMatch: TlcSpot | undefined;
                                            let bestMatchDiff = 0.026;
                                            for (const rs of d.spots) {
                                              const diff = Math.abs(rs.rf - sp.rf);
                                              if (diff < bestMatchDiff) {
                                                bestMatchDiff = diff;
                                                rawMatch = rs;
                                              }
                                            }
                                            const lo = Math.max(0, rawMatch?.extentStart ?? sp.extentStart ?? sp.pos - 8);
                                            const hi = Math.min(pts.length - 1, rawMatch?.extentEnd ?? sp.extentEnd ?? sp.pos + 8);
                                            if (hi <= lo) return null;
                                            const segPts: string[] = [`M 40.0 ${(ph - lo).toFixed(1)}`];
                                            for (let pIdx = lo; pIdx <= hi; pIdx++) {
                                              const pt = pts[pIdx];
                                              if (!pt) continue;
                                              const px = 40 + Math.min(230, (pt.signal / Math.max(1e-6, scaleMax)) * 230);
                                              segPts.push(`L ${px.toFixed(1)} ${(ph - pt.pos).toFixed(1)}`);
                                            }
                                            segPts.push(`L 40.0 ${(ph - hi).toFixed(1)} Z`);
                                            return (
                                              <path
                                                key={`fill-${ch}-${idx}`}
                                                d={segPts.join(' ')}
                                                fill={meta.fill}
                                                stroke="none"
                                              />
                                            );
                                          })}
                                          <path
                                            d={dStr}
                                            fill="none"
                                            stroke={meta.stroke}
                                            strokeWidth="2"
                                            strokeDasharray={meta.dash}
                                          />
                                          {cutoffX !== null && (
                                            <g
                                              style={{ cursor: 'ew-resize' }}
                                              onPointerDown={(e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                cutoffDragRef.current = {
                                                  scaleMax,
                                                  plateSpan: d.densitogramPlateSpan ?? Math.max(45, scaleMax),
                                                  noiseFloor: d.densitogramNoiseFloor ?? 4.5,
                                                };
                                                setDraggingCutoff(true);
                                              }}
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              {/* Wide invisible grab corridor along the full Cutoff line */}
                                              <rect
                                                x={Math.max(32, cutoffX - 9)}
                                                y={Math.min(originY, frontY)}
                                                width="18"
                                                height={Math.max(12, Math.abs(originY - frontY))}
                                                fill="transparent"
                                              />
                                              <line
                                                x1={cutoffX.toFixed(1)}
                                                y1={Math.min(originY, frontY)}
                                                x2={cutoffX.toFixed(1)}
                                                y2={Math.max(originY, frontY)}
                                                stroke={draggingCutoff ? '#fde047' : '#f59e0b'}
                                                strokeWidth={draggingCutoff ? '2' : '1.4'}
                                                strokeDasharray="4,3"
                                                strokeOpacity={draggingCutoff ? '1' : '0.9'}
                                              />
                                              {/* Draggable top pill handle */}
                                              <rect
                                                x={Math.max(42, Math.min(220, cutoffX - 34))}
                                                y={Math.min(originY, frontY) + 3}
                                                width="68"
                                                height="15"
                                                rx="4"
                                                fill={draggingCutoff ? 'rgba(245,158,11,0.95)' : 'rgba(15,23,42,0.88)'}
                                                stroke="#f59e0b"
                                                strokeWidth="1"
                                              />
                                              <text
                                                x={Math.max(42, Math.min(220, cutoffX - 34)) + 34}
                                                y={Math.min(originY, frontY) + 13}
                                                textAnchor="middle"
                                                fill={draggingCutoff ? '#020403' : '#fbbf24'}
                                                fontSize="8.5"
                                                fontFamily="ui-monospace, monospace"
                                                fontWeight="700"
                                                style={{ pointerEvents: 'none' }}
                                              >
                                                ↔ {Math.round(spotProminence * 100)}%
                                              </text>
                                              {/* Bottom grab diamond */}
                                              <polygon
                                                points={`${cutoffX.toFixed(1)},${Math.max(originY, frontY) - 9} ${(cutoffX + 4.5).toFixed(1)},${Math.max(originY, frontY) - 4.5} ${cutoffX.toFixed(1)},${Math.max(originY, frontY)} ${(cutoffX - 4.5).toFixed(1)},${Math.max(originY, frontY) - 4.5}`}
                                                fill={draggingCutoff ? '#fde047' : '#f59e0b'}
                                              />
                                            </g>
                                          )}
                                        </g>
                                      );
                                    })}

                                    {/* Filtered Narrow Microdroplet Markers (subtle slate × on the curve) */}
                                    {visibleChannels.map((ch) => {
                                      const d = channelDensitograms[ch];
                                      if (!d?.rejectedNarrowPeaks?.length) return null;
                                      const scaleMax = channelScaleMap[ch] ?? Math.max(d.maxSignal, 28);
                                      const activeMinW = activePlateSet.minSpotWidthFrac ?? DEFAULT_MIN_SPOT_WIDTH_FRAC;
                                      return (
                                        <g key={`rejected-narrow-${ch}`}>
                                          {d.rejectedNarrowPeaks.map((rej, rIdx) => {
                                            const rx = curveXAtPos(d, rej.pos, scaleMax);
                                            const ry = ph - rej.pos;
                                            return (
                                              <g key={`rej-${ch}-${rIdx}`} opacity="0.82">
                                                <title>
                                                  {`Filtered ${rej.reason === 'microdroplet-run' ? 'microdroplet run' : 'narrow peak'} at Rf ${rej.rf.toFixed(2)} (2D width ${Math.round(rej.widthFrac * 100)}% < min ${Math.round(activeMinW * 100)}%)`}
                                                </title>
                                                <line x1={rx - 3.5} y1={ry - 3.5} x2={rx + 3.5} y2={ry + 3.5} stroke="#94a3b8" strokeWidth="1.6" />
                                                <line x1={rx + 3.5} y1={ry - 3.5} x2={rx - 3.5} y2={ry + 3.5} stroke="#94a3b8" strokeWidth="1.6" />
                                                <text
                                                  x={Math.min(266, rx + 6)}
                                                  y={ry + 3}
                                                  fill="#94a3b8"
                                                  fontSize="8"
                                                  fontFamily="monospace"
                                                >
                                                  × W{Math.round(rej.widthFrac * 100)}%
                                                </text>
                                              </g>
                                            );
                                          })}
                                        </g>
                                      );
                                    })}

                                    {/* Unified Peak Apex Dots matching modalActiveSpots 1-to-1 */}
                                    <g key="unified-spot-markers">
                                      {modalActiveSpots.map((sp, idx) => {
                                        const preferredChannels =
                                          sp.channels && sp.channels.length > 0
                                            ? visibleChannels.filter((ch) => sp.channels!.includes(ch))
                                            : visibleChannels;
                                        const candidateChannels =
                                          preferredChannels.length > 0 ? preferredChannels : visibleChannels;
                                        if (!candidateChannels.length) return null;

                                        // Place the marker on the strongest visible trace at sp.pos
                                        let bestX = 40;
                                        for (const ch of candidateChannels) {
                                          const d = channelDensitograms[ch];
                                          if (!d || !d.points.length) continue;
                                          const scaleMax = channelScaleMap[ch] ?? Math.max(d.maxSignal, 28);
                                          const cx = curveXAtPos(d, sp.pos, scaleMax);
                                          if (cx > bestX) bestX = cx;
                                        }

                                        const y = ph - sp.pos;
                                        const isHovered = hoveredModalSpotIdx === idx;
                                        const isDragged =
                                          isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                                        const isAuto = !sp.source || sp.source === 'auto';
                                        const confStyle = getSpotConfidenceStyle(sp.confidence);
                                        const isLowConf = isAuto && confStyle.needsReview;
                                        const spotColor = isDragged
                                          ? '#facc15'
                                          : sp.source === 'manual'
                                          ? '#f59e0b'
                                          : sp.source === 'adjusted'
                                          ? '#a855f7'
                                          : confStyle.color;

                                        return (
                                          <g key={`spot-marker-${idx}`}>
                                            <circle
                                              cx={bestX}
                                              cy={y}
                                              r={isDragged || isHovered ? '5' : '3.8'}
                                              fill={spotColor}
                                              stroke="#ffffff"
                                              strokeWidth={isDragged || isHovered ? '2' : '1.2'}
                                              strokeDasharray={isLowConf && !isDragged ? '2,1.5' : undefined}
                                            />
                                            <text
                                              x={Math.min(268, bestX + 6)}
                                              y={y + 3}
                                              fill={spotColor}
                                              fontSize="9"
                                              fontWeight="bold"
                                              fontFamily="monospace"
                                            >
                                              {sp.source === 'manual' ? '✋ ' : sp.source === 'adjusted' ? '✨ ' : ''}
                                              Rf {sp.rf.toFixed(2)}
                                              {sp.rfRaw != null && Math.abs(sp.rf - sp.rfRaw) >= 0.005
                                                ? ` (${sp.rfRaw.toFixed(2)})`
                                                : ''}
                                              {isLowConf ? '?' : ''}
                                            </text>
                                          </g>
                                        );
                                      })}
                                    </g>
                                  </>
                                );
                              })()}

                              {/* Synchronized Hover / Drag Crosshair on Densitometer */}
                              {hoverY !== null && (
                                <line
                                  x1="0"
                                  y1={hoverY}
                                  x2="320"
                                  y2={hoverY}
                                  stroke={isDraggingModalSpot ? '#facc15' : hoverSpot ? '#f43f5e' : '#38bdf8'}
                                  strokeWidth={isDraggingModalSpot ? '2' : '1.5'}
                                  strokeDasharray={isDraggingModalSpot ? '4,2' : '3,3'}
                                />
                              )}
                            </svg>
                          );
                        })()}

                        {/* Wavelength Legend */}
                        <div
                          style={{
                            padding: '6px 10px',
                            background: 'rgba(0,0,0,0.5)',
                            borderTop: '1px solid rgba(255,255,255,0.08)',
                            fontSize: '10px',
                            color: '#94a3b8',
                            display: 'flex',
                            gap: '12px',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                          }}
                        >
                          {(densViewMode === 'overlay' || densViewMode === 'UV254') && channelDensitograms.UV254 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#34d399' }}>
                              <span style={{ width: '10px', height: '2px', background: '#10b981' }} />
                              UV 254 nm (Quenching)
                            </span>
                          )}
                          {(densViewMode === 'overlay' || densViewMode === 'UV366') && channelDensitograms.UV366 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#c084fc' }}>
                              <span style={{ width: '10px', height: '2px', background: '#a855f7', borderTop: densViewMode === 'overlay' ? '1px dashed #a855f7' : undefined }} />
                              UV 365 nm (Fluorescence)
                            </span>
                          )}
                          {(densViewMode === 'overlay' || densViewMode === 'White') && channelDensitograms.White && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#fbbf24' }}>
                              <span style={{ width: '10px', height: '2px', background: '#f59e0b', borderTop: densViewMode === 'overlay' ? '1px dotted #f59e0b' : undefined }} />
                              Visible (Stain)
                            </span>
                          )}
                          {(['UV254', 'UV366', 'White'] as const).some(
                            (ch) => (densViewMode === 'overlay' || densViewMode === ch) && (channelDensitograms[ch]?.rejectedNarrowPeaks?.length ?? 0) > 0
                          ) && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#94a3b8' }}>
                              <span style={{ fontWeight: 700 }}>×</span>
                              Filtered microdroplet
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Live Keyboard Guide Bar underneath TLC Strip */}
                  <div
                    style={{
                      marginTop: '8px',
                      padding: '6px 12px',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: '6px',
                      border: '1px solid rgba(255,255,255,0.08)',
                      fontSize: '11px',
                      color: '#94a3b8',
                      textAlign: 'center',
                      display: 'flex',
                      justifyContent: 'center',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>⌨️ <b>Live Keyboard:</b> <span className="mono">← → ↑ ↓</span> nudge</span>
                    <span><span className="mono">Q / E</span> tilt</span>
                    <span><span className="mono">Shift</span> 5×</span>
                    <span><span className="mono">- / +</span> width</span>
                  </div>
                </div>

                {/* Right Column: Micro-Adjustment Controls & Analysis */}
                <div
                  style={{
                    flex: '1 1 420px',
                    minWidth: '320px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  {/* Real-Time Micro-Adjustment of This Lane (Prominently displayed right next to canvas!) */}
                  {activePlateSet.cfg && (() => {
                    const laneId = tlcLane(inspectWell, 'column');
                    const targetLane = activePlateSet.cfg.lanes.find((l) => l.id === laneId);
                    if (!targetLane) return null;

                    return (
                      <div
                        style={{
                          padding: '14px 16px',
                          background: '#0f172a',
                          borderRadius: '10px',
                          border: '2px solid #facc15',
                          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                          color: '#f8fafc',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          fontSize: '12px',
                        }}
                      >
                        {/* Header with identity and action buttons */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                          <span style={{ fontWeight: 800, fontSize: '13px', color: '#facc15', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <span>📐</span>
                            <span>Micro-Adjust Lane {laneId} ({wellLabel(inspectWell)})</span>
                          </span>

                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              style={{
                                background: cfgHistory.length > 0 ? '#334155' : '#1e293b',
                                color: cfgHistory.length > 0 ? '#38bdf8' : '#64748b',
                                border: '1px solid ' + (cfgHistory.length > 0 ? '#0284c7' : '#334155'),
                                borderRadius: '4px',
                                padding: '3px 8px',
                                fontSize: '11px',
                                fontWeight: 600,
                                cursor: cfgHistory.length > 0 ? 'pointer' : 'not-allowed',
                                opacity: cfgHistory.length > 0 ? 1 : 0.6,
                              }}
                              onClick={handleUndo}
                              disabled={cfgHistory.length === 0}
                              title="Undo last adjustment (Ctrl+Z)"
                            >
                              ↺ Undo
                            </button>
                            <button
                              type="button"
                              style={{
                                background: '#1e293b',
                                color: '#fbbf24',
                                border: '1px solid #b45309',
                                borderRadius: '4px',
                                padding: '3px 8px',
                                fontSize: '11px',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                              onClick={() => handleResetLane(laneId)}
                              title="Reset this lane to original template"
                            >
                              ⟲ Reset Lane
                            </button>
                            <button
                              type="button"
                              style={{
                                background: '#059669',
                                color: '#ffffff',
                                border: '1px solid #047857',
                                borderRadius: '4px',
                                padding: '3px 8px',
                                fontSize: '11px',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                              onClick={handleExportLaneCsv}
                              title="Download corrected CSV"
                            >
                              💾 Export CSV
                            </button>
                          </div>
                        </div>

                        {/* Continuous Sliders Grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
                          {/* Shift X Slider */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift X:</span>
                              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #334155' }}>
                                {Math.round(targetLane.x0)} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { x0: targetLane.x0 - 1 })}
                              >
                                ◀ -1
                              </button>
                              <input
                                type="range"
                                min={Math.max(0, Math.round(targetLane.x0 - 120))}
                                max={Math.min(activePlateSet.frameW || 3280, Math.round(targetLane.x0 + 120))}
                                step={1}
                                value={Math.round(targetLane.x0)}
                                onChange={(e) => handleUpdateLane(laneId, { x0: +e.target.value })}
                                style={{ flex: 1, accentColor: '#38bdf8', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { x0: targetLane.x0 + 1 })}
                              >
                                +1 ▶
                              </button>
                            </div>
                          </div>

                          {/* Shift Y Slider */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Shift Y:</span>
                              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fff', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #334155' }}>
                                {Math.round(targetLane.y0)} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { y0: targetLane.y0 - 1 })}
                              >
                                ▲ -1
                              </button>
                              <input
                                type="range"
                                min={Math.max(50, Math.round(targetLane.y0 - 120))}
                                max={Math.min(3200, Math.round(targetLane.y0 + 120))}
                                step={1}
                                value={Math.round(targetLane.y0)}
                                onChange={(e) => handleUpdateLane(laneId, { y0: +e.target.value })}
                                style={{ flex: 1, accentColor: '#38bdf8', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { y0: targetLane.y0 + 1 })}
                              >
                                +1 ▼
                              </button>
                            </div>
                          </div>

                          {/* Tilt Angle Slider */}
                          {(() => {
                            const isOpposingModal = Math.abs(targetLane.angle) > 90;
                            const baseAngleModal = isOpposingModal ? (targetLane.angle < 0 ? -180 : 180) : 0;
                            const tiltMinModal = +(baseAngleModal - 30).toFixed(1);
                            const tiltMaxModal = +(baseAngleModal + 30).toFixed(1);

                            const handleFlipModalLane = () => {
                              const th = (targetLane.angle * Math.PI) / 180;
                              const endX = Math.round(targetLane.x0 + targetLane.length * Math.sin(th));
                              const endY = Math.round(targetLane.y0 - targetLane.length * Math.cos(th));
                              const newAngle = isOpposingModal
                                ? +((targetLane.angle - (targetLane.angle > 0 ? 180 : -180))).toFixed(2)
                                : +((targetLane.angle + 180)).toFixed(2);
                              handleUpdateLane(laneId, { x0: endX, y0: endY, angle: newAngle });
                            };

                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#facc15', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                    <span>Tilt Angle:</span>
                                    <span style={{ fontSize: '9px', background: isOpposingModal ? '#7c2d12' : '#1e3a5f', color: isOpposingModal ? '#fdba74' : '#93c5fd', padding: '1px 5px', borderRadius: '3px', fontWeight: 600 }}>
                                      {isOpposingModal ? '↕ Downward' : '↑ Upward'}
                                    </span>
                                  </span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <button
                                      type="button"
                                      style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #0284c7', borderRadius: '4px', padding: '1px 6px', fontSize: '10px', cursor: 'pointer' }}
                                      onClick={handleFlipModalLane}
                                      title="Flip lane direction 180°"
                                    >
                                      ↕ Flip 180°
                                    </button>
                                    <span className="mono" style={{ fontSize: '11px', fontWeight: 800, color: '#facc15', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #b45309' }}>
                                      {targetLane.angle >= 0 ? '+' : ''}{targetLane.angle.toFixed(1)}°
                                    </span>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <button
                                    type="button"
                                    style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 5px', fontSize: '10px', cursor: 'pointer' }}
                                    onClick={() => handleUpdateLane(laneId, { angle: +(targetLane.angle - 1.0).toFixed(2) })}
                                    title="Rotate counter-clockwise 1.0°"
                                  >
                                    -1°
                                  </button>
                                  <button
                                    type="button"
                                    style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 5px', fontSize: '10px', cursor: 'pointer' }}
                                    onClick={() => handleUpdateLane(laneId, { angle: +(targetLane.angle - 0.2).toFixed(2) })}
                                    title="Rotate counter-clockwise 0.2°"
                                  >
                                    ↺ -0.2°
                                  </button>
                                  <input
                                    type="range"
                                    min={tiltMinModal}
                                    max={tiltMaxModal}
                                    step={0.1}
                                    value={targetLane.angle}
                                    onChange={(e) => handleUpdateLane(laneId, { angle: parseFloat((+e.target.value).toFixed(2)) })}
                                    style={{ flex: 1, accentColor: '#facc15', height: '5px', cursor: 'ew-resize' }}
                                    title={`Continuous Tilt Angle slider (${tiltMinModal}° to ${tiltMaxModal}°)`}
                                  />
                                  <button
                                    type="button"
                                    style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 5px', fontSize: '10px', cursor: 'pointer' }}
                                    onClick={() => handleUpdateLane(laneId, { angle: +(targetLane.angle + 0.2).toFixed(2) })}
                                    title="Rotate clockwise 0.2°"
                                  >
                                    +0.2° ↻
                                  </button>
                                  <button
                                    type="button"
                                    style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 5px', fontSize: '10px', cursor: 'pointer' }}
                                    onClick={() => handleUpdateLane(laneId, { angle: +(targetLane.angle + 1.0).toFixed(2) })}
                                    title="Rotate clockwise 1.0°"
                                  >
                                    +1°
                                  </button>
                                </div>
                              </div>
                            );
                          })()}

                          {/* Origin Baseline (Rf = 0) Slider */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24' }}>Origin (Rf=0):</span>
                              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#fbbf24', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #78350f' }}>
                                {Math.round(tlcOrigin(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcOrigin(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
                                  handleUpdateLane(laneId, { zeroRf: Math.max(5, curr - 1) });
                                }}
                              >
                                -1
                              </button>
                              <input
                                type="range"
                                min={5}
                                max={Math.round(targetLane.length * 0.45)}
                                step={1}
                                value={Math.round(tlcOrigin(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))}
                                onChange={(e) => handleUpdateLane(laneId, { zeroRf: +e.target.value })}
                                style={{ flex: 1, accentColor: '#fbbf24', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcOrigin(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
                                  handleUpdateLane(laneId, { zeroRf: curr + 1 });
                                }}
                              >
                                +1
                              </button>
                            </div>
                          </div>

                          {/* Solvent Front (Rf = 1) Slider */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>Front (Rf=1):</span>
                              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #0369a1' }}>
                                {Math.round(tlcFront(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcFront(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
                                  handleUpdateSetFront(Math.max(50, curr - 1));
                                }}
                              >
                                -1
                              </button>
                              <input
                                type="range"
                                min={50}
                                max={Math.round(targetLane.length * 1.05)}
                                step={1}
                                value={Math.round(tlcFront(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))}
                                onChange={(e) => handleUpdateSetFront(+e.target.value)}
                                style={{ flex: 1, accentColor: '#38bdf8', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcFront(activePlateSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
                                  handleUpdateSetFront(curr + 1);
                                }}
                              >
                                +1
                              </button>
                            </div>
                          </div>

                          {/* Lane Width Slider */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc' }}>Lane Width:</span>
                              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#c084fc', background: '#0f172a', padding: '1px 5px', borderRadius: '3px', border: '1px solid #6b21a8' }}>
                                {Math.round(targetLane.width)} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { width: Math.max(8, targetLane.width - 1) })}
                              >
                                -1
                              </button>
                              <input
                                type="range"
                                min={8}
                                max={120}
                                step={1}
                                value={Math.round(targetLane.width)}
                                onChange={(e) => handleUpdateLane(laneId, { width: +e.target.value })}
                                style={{ flex: 1, accentColor: '#c084fc', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => handleUpdateLane(laneId, { width: targetLane.width + 1 })}
                              >
                                +1
                              </button>
                            </div>
                          </div>
                        </div>

                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                          ⚡ Instant Redraw: Drag sliders for continuous scrubbing, or use keyboard arrow keys (<span className="mono">← → ↑ ↓</span>) and <span className="mono">Q / E</span>.
                        </div>
                      </div>
                    );
                  })()}

                  {/* Automated Peak Findings & Chromatographic Separation (ΔRf) */}
                  <div
                    style={{
                      marginTop: '16px',
                      padding: '12px 16px',
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <span>🎯 Chromatographic Peak Deconvolution &amp; Resolution:</span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{
                            fontSize: '11px',
                            height: '24px',
                            padding: '0 8px',
                            background: '#0284c7',
                            color: '#ffffff',
                            border: '1px solid #0369a1',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontWeight: 600,
                          }}
                          onClick={() => handleAddSpotInModal(0.50)}
                          title="Add a new custom/manual spot pick at Rf 0.50 (or Shift+Click anywhere on the TLC lane)"
                        >
                          + Add Spot (Rf 0.50)
                        </button>
                        {activePlateSet.cfg && (() => {
                          const lId = tlcLane(inspectWell, 'column');
                          const lObj = activePlateSet.cfg.lanes.find((l) => l.id === lId);
                          if (lObj?.customSpots !== undefined) {
                            return (
                              <button
                                type="button"
                                className="btn sm"
                                style={{
                                  fontSize: '11px',
                                  height: '24px',
                                  padding: '0 8px',
                                  background: '#334155',
                                  color: '#fbbf24',
                                  border: '1px solid #78350f',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  fontWeight: 600,
                                }}
                                onClick={handleResetLaneSpotsInModal}
                                title="Reset manual and adjusted spots back to auto-detected peaks"
                              >
                                ↺ Reset to Auto Picks
                              </button>
                            );
                          }
                          return null;
                        })()}
                        {modalActiveSpots.length ? (
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                            {modalActiveSpots.length} peak{modalActiveSpots.length === 1 ? '' : 's'} identified
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {modalActiveSpots.length ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {/* Interactive Peak Adjustment Cards */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {modalActiveSpots.map((sp, idx) => {
                            const isSelected = hoveredModalSpotIdx === idx || (isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx);
                            const isAuto = !sp.source || sp.source === 'auto';
                            const confStyle = getSpotConfidenceStyle(sp.confidence);
                            const cardBg = sp.source === 'manual'
                              ? 'rgba(245, 158, 11, 0.08)'
                              : sp.source === 'adjusted'
                              ? 'rgba(168, 85, 247, 0.08)'
                              : 'rgba(255, 255, 255, 0.03)';
                            const cardBorder = isSelected
                              ? '#facc15'
                              : sp.source === 'manual'
                              ? '#f59e0b'
                              : sp.source === 'adjusted'
                              ? '#a855f7'
                              : confStyle.border;

                            return (
                              <div
                                key={idx}
                                onMouseEnter={() => setHoveredModalSpotIdx(idx)}
                                onMouseLeave={() => setHoveredModalSpotIdx((prev) => (prev === idx ? null : prev))}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '8px 12px',
                                  background: cardBg,
                                  border: `1px solid ${cardBorder}`,
                                  borderRadius: '6px',
                                  gap: '12px',
                                  flexWrap: 'wrap',
                                  boxShadow: isSelected ? '0 0 8px rgba(250, 204, 21, 0.25)' : 'none',
                                  transition: 'border-color 0.15s, box-shadow 0.15s',
                                }}
                              >
                                {/* Left Side: Index, Rf value, Provenance Tag, Signal Strength */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  <span
                                    style={{
                                      fontWeight: 800,
                                      fontSize: '11px',
                                      color: isAuto && (confStyle.tier === 'medium' || confStyle.tier === 'very-high' || confStyle.tier === 'low') ? '#0f172a' : '#ffffff',
                                      background: sp.source === 'manual' ? '#b45309' : sp.source === 'adjusted' ? '#7e22ce' : confStyle.color,
                                      borderRadius: '4px',
                                      padding: '2px 6px',
                                    }}
                                  >
                                    #{idx + 1}
                                  </span>
                                  <span
                                    className="mono"
                                    style={{
                                      fontWeight: 700,
                                      fontSize: '13px',
                                      color: sp.source === 'manual' ? '#b45309' : sp.source === 'adjusted' ? '#9333ea' : 'var(--ink)',
                                    }}
                                  >
                                    Rf {sp.rf.toFixed(2)}
                                    {sp.rfRaw != null && Math.abs(sp.rf - sp.rfRaw) >= 0.005 ? ` (${sp.rfRaw.toFixed(2)} raw)` : ''}
                                  </span>
                                  {sp.source === 'manual' && (
                                    <span style={{ background: '#f59e0b', color: '#000000', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 700 }}>
                                      ✋ Manual
                                    </span>
                                  )}
                                  {sp.source === 'adjusted' && (
                                    <span style={{ background: '#a855f7', color: '#ffffff', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 700 }}>
                                      ✨ Adjusted
                                    </span>
                                  )}
                                  {isAuto && (
                                    <span
                                      style={{
                                        background: confStyle.color,
                                        color: confStyle.tier === 'medium' || confStyle.tier === 'very-high' || confStyle.tier === 'low' ? '#0f172a' : '#ffffff',
                                        border: `1px ${confStyle.needsReview ? 'dashed' : 'solid'} ${confStyle.border}`,
                                        padding: '1px 6px',
                                        borderRadius: '3px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                      }}
                                      title={
                                        typeof sp.confidence === 'number'
                                          ? `Detection confidence: ${confStyle.pct}% (${confStyle.label})${confStyle.needsReview ? ' — verify visually' : ''}`
                                          : 'Auto-detected spot'
                                      }
                                    >
                                      {typeof sp.confidence === 'number'
                                        ? `${confStyle.pct}% ${confStyle.label}${confStyle.needsReview ? ' ?' : ''}`
                                        : 'Auto'}
                                    </span>
                                  )}
                                  {sp.channels && sp.channels.length > 0 && sp.channels.map((ch) => (
                                    <span
                                      key={ch}
                                      style={{
                                        background: ch === 'UV254' ? 'rgba(16, 185, 129, 0.16)' : ch === 'UV366' ? 'rgba(6, 182, 212, 0.16)' : 'rgba(244, 114, 182, 0.16)',
                                        color: ch === 'UV254' ? '#34d399' : ch === 'UV366' ? '#22d3ee' : '#f472b6',
                                        border: `1px solid ${ch === 'UV254' ? 'rgba(16, 185, 129, 0.4)' : ch === 'UV366' ? 'rgba(6, 182, 212, 0.4)' : 'rgba(244, 114, 182, 0.4)'}`,
                                        padding: '1px 5px',
                                        borderRadius: '3px',
                                        fontSize: '9.5px',
                                        fontWeight: 700,
                                      }}
                                    >
                                      {ch === 'UV254' ? '254' : ch === 'UV366' ? '365' : 'Vis'}
                                    </span>
                                  ))}
                                  {(() => {
                                    if (channelDensitograms.UV366 && (!sp.channels || !sp.channels.includes('UV366'))) {
                                      const pts = channelDensitograms.UV366.points;
                                      const pt = pts[sp.pos];
                                      const emSignal = pt?.signal || 0;
                                      if (emSignal > 30) {
                                        return (
                                          <span
                                            style={{
                                              background: 'rgba(6, 182, 212, 0.2)',
                                              color: '#22d3ee',
                                              border: '1px solid rgba(6, 182, 212, 0.5)',
                                              padding: '1px 5px',
                                              borderRadius: '3px',
                                              fontSize: '10px',
                                              fontWeight: 700,
                                            }}
                                            title="Strong UV 365 nm fluorescent emission detected at this peak"
                                          >
                                            ✨ Fluorescent
                                          </span>
                                        );
                                      }
                                    }
                                    return null;
                                  })()}
                                  <span style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'capitalize' }}>
                                    ({sp.strength > 0.5 ? 'strong' : sp.strength > 0.2 ? 'medium' : 'weak'} · {sp.areaPct || 0}% area
                                    {typeof sp.tailing === 'number' && sp.tailing > 1.6 ? ` · tail ${sp.tailing.toFixed(1)}×` : ''})
                                  </span>
                                </div>

                                {/* Right Side: Fine Nudge Buttons, Continuous Slider, Delete Button */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '10px', padding: '2px 6px', height: '22px', background: '#1e293b', color: '#ffffff', border: '1px solid #475569', borderRadius: '3px', cursor: 'pointer' }}
                                    onClick={() => handleNudgeSpotInModal(idx, -0.05)}
                                    title="Nudge Rf -0.05"
                                  >
                                    -0.05
                                  </button>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '10px', padding: '2px 6px', height: '22px', background: '#1e293b', color: '#ffffff', border: '1px solid #475569', borderRadius: '3px', cursor: 'pointer' }}
                                    onClick={() => handleNudgeSpotInModal(idx, -0.01)}
                                    title="Nudge Rf -0.01"
                                  >
                                    -0.01
                                  </button>
                                  <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.005"
                                    value={sp.rf}
                                    onChange={(e) => {
                                      const targetRf = parseFloat(e.target.value);
                                      if (!isNaN(targetRf)) {
                                        handleNudgeSpotInModal(idx, targetRf - sp.rf);
                                      }
                                    }}
                                    style={{
                                      width: '90px',
                                      height: '5px',
                                      accentColor: sp.source === 'manual' ? '#f59e0b' : sp.source === 'adjusted' ? '#a855f7' : '#38bdf8',
                                      cursor: 'ew-resize',
                                    }}
                                    title={`Continuous Rf slider: ${sp.rf.toFixed(2)}`}
                                  />
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '10px', padding: '2px 6px', height: '22px', background: '#1e293b', color: '#ffffff', border: '1px solid #475569', borderRadius: '3px', cursor: 'pointer' }}
                                    onClick={() => handleNudgeSpotInModal(idx, +0.01)}
                                    title="Nudge Rf +0.01"
                                  >
                                    +0.01
                                  </button>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '10px', padding: '2px 6px', height: '22px', background: '#1e293b', color: '#ffffff', border: '1px solid #475569', borderRadius: '3px', cursor: 'pointer' }}
                                    onClick={() => handleNudgeSpotInModal(idx, +0.05)}
                                    title="Nudge Rf +0.05"
                                  >
                                    +0.05
                                  </button>
                                  <button
                                    type="button"
                                    className="btn sm"
                                    style={{ fontSize: '10px', padding: '2px 7px', height: '22px', background: '#0f172a', color: '#38bdf8', border: '1px solid #0284c7', borderRadius: '3px', cursor: 'pointer', fontWeight: 600 }}
                                    onClick={() => handleFindSimilarSpotsOnPlate(sp)}
                                    title="Sample this spot's RGB color signature and mark all matching spots across the 54 lanes on this plate"
                                  >
                                    Find similar
                                  </button>
                                  <button
                                    type="button"
                                    className="ib sm"
                                    style={{ color: '#ef4444', fontSize: '12px', padding: '2px 6px', cursor: 'pointer', background: 'transparent', border: 'none' }}
                                    onClick={() => handleDeleteSpotInModal(idx)}
                                    title="Delete this spot pick (Alt+Click on lane also deletes)"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Separation Resolution Metrics */}
                        {separationMetrics && (
                          <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {separationMetrics.map((sm, idx) => (
                              <span
                                key={idx}
                                className={`chip ${sm.status === 'good' ? 'ok' : sm.status === 'fair' ? 'warn' : 'bad'}`}
                                style={{ fontSize: '11px', fontWeight: 600 }}
                              >
                                {sm.status === 'good' && '✓ Baseline Separated: '}
                                {sm.status === 'fair' && '⚠️ Partial Separation: '}
                                {sm.status === 'poor' && '❌ Co-Eluting / Overlapping: '}
                                ΔRf (P{idx + 1}–P{idx + 2}) = {sm.delta.toFixed(2)}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Interactive Workflow Hint Bar */}
                        <div
                          style={{
                            marginTop: '6px',
                            padding: '6px 10px',
                            background: 'rgba(255,255,255,0.02)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            borderRadius: '4px',
                            fontSize: '11px',
                            color: '#94a3b8',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ color: '#facc15', fontWeight: 700 }}>💡 Controls:</span>
                          <span>• <strong>Drag</strong> spot handle or line vertically on the TLC lane to slide Rf in real time</span>
                          <span>• <strong>Shift+Click</strong> on lane to drop a new manual spot</span>
                          <span>• <strong>Alt+Click</strong> on spot to delete</span>
                          <span>• All custom picks persist across views, heatmap, and CSV/JSON exports</span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ padding: '12px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                        <p style={{ fontSize: '12px', color: 'var(--mut)', marginBottom: '8px' }}>
                          No chromatographic peaks currently picked for this lane.
                        </p>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ fontSize: '11px', background: '#0284c7', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer' }}
                          onClick={() => handleAddSpotInModal(0.50)}
                        >
                          + Add Spot at Rf 0.50
                        </button>
                      </div>
                    )}
                  </div>

                  {/* AI TLC Reaction & Spot Interpreter (Option 4) */}
                  <AiTlcInterpreter
                    laneLabel={`Well ${wellLabel(inspectWell)} (Lane ${tlcLane(inspectWell, 'column')}) · Plate ${plate + 1}`}
                    spots={modalActiveSpots.map((s) => ({ rf: s.rf, intensity: s.strength, note: s.source }))}
                    wellRecipe={(() => {
                      const row = run?.rows?.find(
                        (r: any) => r.plate_number === plate && r.container_id === inspectWell
                      );
                      return row ? row.recipe : undefined;
                    })()}
                    mobilePhase={currentSet.name || '30% EtOAc / 70% Hexanes'}
                    stain={densViewMode === 'White' ? 'Visible Stain' : densViewMode === 'overlay' ? 'Multi-Channel Composite' : 'UV 254 nm'}
                    onSaveToElnNotes={(analysisText) => {
                      if (inspectWell === null) return;
                      const key = `${plate}-${inspectWell}`;
                      setState((prev) => {
                        const next = JSON.parse(JSON.stringify(prev));
                        const curWells = next.eln?.wells || {};
                        const curObs = curWells[key] || { wellIndex: inspectWell, plateIndex: plate, status: 'none', tags: [] };
                        curObs.notes = (curObs.notes ? curObs.notes + '\n\n' : '') + `[TLC AI Analysis]:\n${analysisText}`;
                        curWells[key] = curObs;
                        next.eln = { ...(next.eln || {}), wells: curWells };
                        return next;
                      });
                      toast(`Saved TLC AI interpretation to Well ${wellLabel(inspectWell)} in ELN.`);
                    }}
                  />

                  <WellPredictedProductsPanel
                    state={state}
                    run={run}
                    plate={plate}
                    wellIndex={inspectWell}
                    onOpenFullPredictor={() => {
                      const wIdx = inspectWell;
                      setInspectWell(null);
                      setTargetWell({ wellIndex: wIdx, plateIndex: plate, source: 'palette' });
                      setVisited((v) => ({ ...v, predict: true }));
                      setView('predict');
                    }}
                  />

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setShowSolventAdvisor(true)}
                      style={{
                        fontSize: '11px',
                        color: '#10b981',
                        borderColor: 'rgba(16, 185, 129, 0.4)',
                        background: 'rgba(16, 185, 129, 0.08)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        cursor: 'pointer',
                      }}
                      title="Ask AI to recommend 2-3 solvent systems for separating the product from the substrates in this well"
                    >
                      ✦ Suggest Best Solvent Systems for this Well / Reaction
                    </button>
                  </div>

                  {/* Custom Pinned Markers Bar */}
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '10px 14px',
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
                      borderRadius: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600 }}>
                        Manual Pin Markers (Click on lane or densitometer to add / remove):
                      </span>
                      {pinnedMarkers.length > 0 && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => setPinnedMarkers([])}
                          style={{ fontSize: '11px', height: '24px' }}
                        >
                          Clear Pins
                        </button>
                      )}
                    </div>

                    {pinnedMarkers.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                        {pinnedMarkers.map((m) => (
                          <span
                            key={m.id}
                            className="chip"
                            style={{ background: '#fef9c3', color: '#854d0e', fontWeight: 600 }}
                          >
                            {m.label}: Rf = {m.rf.toFixed(2)}
                            <button
                              type="button"
                              onClick={() => setPinnedMarkers((prev) => prev.filter((p) => p.id !== m.id))}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                marginLeft: '4px',
                                color: '#a16207',
                                fontWeight: 'bold',
                              }}
                              title="Delete marker"
                            >
                              ✕
                            </button>
                          </span>
                        ))}

                        {pinnedMarkers.length >= 2 && (
                          <span className="chip ok" style={{ fontWeight: 700, marginLeft: 'auto' }}>
                            ΔRf = {Math.abs(pinnedMarkers[1].rf - pinnedMarkers[0].rf).toFixed(2)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        Click anywhere on the TLC strip or densitogram to pin custom reference spots.
                      </div>
                    )}
                  </div>

                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--mut)' }}>
                  <p style={{ margin: '0 0 14px', fontSize: '13px' }}>
                    No sliced lane image or grid configuration available for Well <b>{wellLabel(inspectWell)}</b> yet.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={handleApplyDefaultGrid}
                    >
                      Apply Standard 54-Lane Grid
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={handleLoadDemoTlc}
                    >
                      Load Demonstration Plate
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div
              className="modal-foot"
              style={{
                position: 'sticky',
                bottom: 0,
                zIndex: 35,
                background: 'var(--panel)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                borderTop: '1px solid var(--line2)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxShadow: '0 -4px 14px rgba(0,0,0,0.18)',
                padding: '12px 20px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => handleExportAnalysis('csv', 'current')}
                  title="Export TLC analysis data for this plate as CSV"
                >
                  📥 Export Plate CSV
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => handleExportAnalysis('json', 'current')}
                  title="Export full TLC plate analysis data as JSON"
                >
                  📦 Export Plate JSON
                </button>
              </div>
              <button type="button" className="btn pri" onClick={() => setInspectWell(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI TLC Solvent System Advisor Modal */}
      <AiSolventAdvisorModal
        isOpen={showSolventAdvisor}
        onClose={() => setShowSolventAdvisor(false)}
        initialSubstrates={(state?.reagents || [])
          .filter((r) => r.name && r.name.trim() !== '')
          .map((r) => ({
            code: r.code,
            name: r.name,
            smiles: r.smiles,
            role: r.code,
          }))}
        reactionClass={state?.name || 'Amide Coupling'}
        onApplyToCurrentSet={(systemName) => {
          setSets((prev) => {
            const next = [...prev];
            if (next[cur]) {
              next[cur] = { ...next[cur], name: systemName };
            }
            return next;
          });
        }}
        onCreateNewSet={(systemName) => {
          const newSet = tlcNewSet(sets.length + 1);
          newSet.name = systemName;
          setSets((prev) => [...prev, newSet]);
          setCur(sets.length);
        }}
        toast={toast}
      />
    </div>
  );
};
