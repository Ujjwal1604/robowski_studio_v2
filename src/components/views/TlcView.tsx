// Robowski Studio - Advanced TLC Map & Parallel Lane Densitometer
// Features: Center-weighted core lane sampling (suppressing neighbor bleed),
// pixel-matched parallel densitograms (base origin to solvent front),
// multi-channel UV254 (absorbance) vs UV365 (fluorescence) traces with dual overlay,
// and automated peak finding + separation metrics.
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
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
  findSpots,
  extractDensitogram,
  computeLaneRowIntensity,
  tlcHalf,
  tlcFront,
  tlcOrigin,
  tlcRfCsv,
  exportTlcAnalysisCsv,
  exportTlcAnalysisJson,
  TlcAnalysisExportOptions,
  createDefaultLaneConfig,
  createDemoTlcDataSet,
  exportLaneConfigCsv,
  getEffectiveLaneSpots,
} from '../../engine';
import {
  fitEdgeCurve,
  fitEdgePicks,
  edgeGain,
  edgeOffset,
  edgeActive,
  correctSpots,
  DEFAULT_EDGE_SETTING,
  EdgeFit,
  EdgeSetting,
  EdgePoint,
  EdgePick,
} from '../../engine/tlcEdge';
import {
  TlcSet,
  TlcLane,
  TlcLaneConfig,
  TlcImageEntry,
  TlcSpot,
  TlcDensitogramData,
} from '../../types';
import { putTlcImage, getTlcImage, deleteTlcSetImages } from '../../context/tlcStorage';
import { TlcFullPlateView } from './TlcFullPlateView';
import { parseWellQuery } from '../ui/CommandPalette';
import { AiTlcInterpreter } from '../ui/AiTlcInterpreter';

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
    originPx: null,
    originAuto: {},
    imgs: {},
  };
}

function tlcKeyOf(name: string, assigned: Record<string, any>): TlcChannelKey | null {
  if (/(?:^|[^0-9])254(?:[^0-9]|$)/i.test(name)) return 'UV254';
  if (/(?:^|[^0-9])36[56](?:[^0-9]|$)|uv.?3/i.test(name)) return 'UV366';
  if (/(?:^|[^a-z])(?:white|visible|vis)(?:[^a-z]|$)/i.test(name)) return 'White';
  return (TLC_KEYS as TlcChannelKey[]).find((k) => !assigned[k]) || null;
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

// Off-screen canvas scratchpad for sampling lane pixels
let tlcScratchCanvas: HTMLCanvasElement | null = null;

// Center-weighted lane extraction to suppress edge bleeding from neighboring wells
export function extractLaneProfile(
  set: TlcSet,
  key: TlcChannelKey,
  lane: TlcLane,
  coreFraction: number = 0.35
): number[] {
  const ck = `${key}:${lane.id}:${coreFraction.toFixed(2)}`;
  if (set.prof && set.prof[ck]) return set.prof[ck];

  const im = set.imgs[key];
  if (!im || !im.bmp) return [];

  const W = Math.max(1, Math.round(lane.width));
  const L = Math.max(1, Math.round(lane.length));

  if (!tlcScratchCanvas) {
    tlcScratchCanvas = document.createElement('canvas');
  }
  tlcScratchCanvas.width = W;
  tlcScratchCanvas.height = L;

  const ctx = tlcScratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, L);

  const m = laneMatrix(lane, im.bmp.width / (set.frameW || LANE_FRAME_WIDTH), 1);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(im.bmp, 0, 0);

  const imgData = ctx.getImageData(0, 0, W, L);
  const data = imgData.data;
  const ch = TLC_SIGNAL[key].ch;
  const out = new Array(L);

  for (let y = 0; y < L; y++) {
    const rowOffset = y * W * 4;
    const rowSlice = data.subarray(rowOffset, rowOffset + W * 4);
    // Center-weighted cosine sampling: isolates the true middle trajectory and ignores edge spillover
    out[L - 1 - y] = computeLaneRowIntensity(rowSlice, W, ch, coreFraction);
  }

  set.prof = set.prof || {};
  set.prof[ck] = out;
  return out;
}

// Draw lane panels upright with origin ticks and pink spot ticks
function drawLanePanels(
  canvas: HTMLCanvasElement,
  panels: LanePanel[],
  k: number,
  filters?: ImageFilters,
  showSpots: boolean = true
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
    const m = laneMatrix(l, im.bmp.width / (p.s.frameW || LANE_FRAME_WIDTH), k);
    const top = ph - k * l.length;
    const w = ws[j];

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(x, top, w, k * l.length);
    ctx.clip();

    ctx.setTransform(
      dpr * m[0],
      dpr * m[1],
      dpr * m[2],
      dpr * m[3],
      dpr * (m[4] + x),
      dpr * (m[5] + top)
    );

    ctx.drawImage(im.bmp, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Yellow ticks where spot origin was applied (Rf = 0)
    const origPx = tlcOrigin(p.s, l);
    ctx.strokeStyle = '#FFC857';
    ctx.lineWidth = 1.5;
    const y = top + k * (l.length - origPx);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5, y);
    ctx.moveTo(x + w - 5, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();

    // Ticks at spots with provenance coloring
    if (showSpots && p.spots && p.spots.length) {
      for (const sp of p.spots) {
        const y = top + k * (l.length - sp.pos);
        ctx.strokeStyle = sp.source === 'manual' ? '#f59e0b' : sp.source === 'adjusted' ? '#a855f7' : '#FF4D8D';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x + w - 8, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
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
      drawLanePanels(canvasRef.current, panels, zoom, undefined, markSpots);
    }
  }, [panels, zoom, markSpots]);

  const nf = (v: any, d = 1) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const rcol = (i: number) => PAL[i % PAL.length];

  // Primary panel spots for summary label below cell
  const primarySpots = panels[0]?.spots;

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
    run,
    toast,
    tlcSets: sets,
    setTlcSets: setSets,
    activeTlcStatus,
    targetWell,
    setTargetWell,
    view,
    spotProminence,
    setSpotProminence,
    setState,
  } = useApp();

  const [cur, setCur] = useState<number>(0);
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
      if (targetWell.plateIndex !== undefined) {
        setPlate(targetWell.plateIndex);
      }
      setInspectWell(targetWell.wellIndex);
      const timer = setTimeout(() => {
        setTargetWell(null);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [targetWell, view, setTargetWell]);

  // Multi-Channel Densitometry Data Dictionary
  const [channelDensitograms, setChannelDensitograms] = useState<{
    UV254?: TlcDensitogramData;
    UV366?: TlcDensitogramData;
    White?: TlcDensitogramData;
  }>({});

  const fileCsvRef = useRef<HTMLInputElement>(null);
  const fileImgRef = useRef<HTMLInputElement>(null);
  const bigCanvasRef = useRef<HTMLCanvasElement>(null);

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
  const isMultiSet = sets.length > 1;

  // Restore saved images from IndexedDB on initial mount
  useEffect(() => {
    let cancelled = false;
    const restoreCachedImages = async () => {
      let anyLoaded = false;
      const loadedBySet: Record<number, Partial<Record<TlcChannelKey, TlcImageEntry>>> = {};

      for (let sIdx = 0; sIdx < sets.length; sIdx++) {
        const s = sets[sIdx];
        for (const k of TLC_KEYS) {
          if (!s.imgs[k]) {
            try {
              const cached = await getTlcImage(s.uid, k);
              if (cached && !cancelled) {
                const bmp = await createImageBitmap(cached.blob);
                if (!cancelled) {
                  if (!loadedBySet[sIdx]) loadedBySet[sIdx] = {};
                  loadedBySet[sIdx][k] = { name: cached.name, bmp };
                  anyLoaded = true;
                }
              }
            } catch {
              // soft fail
            }
          }
        }
      }

      if (anyLoaded && !cancelled) {
        setSets((prev) => {
          const next = [...prev];
          for (const [idxStr, imgs] of Object.entries(loadedBySet)) {
            const idx = Number(idxStr);
            if (next[idx]) {
              next[idx] = {
                ...next[idx],
                imgs: { ...next[idx].imgs, ...imgs },
              };
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
  }, [sets.length, setSets]);

  // Load Lane Config CSV
  const handleLoadCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const cfg = parseLaneConfig(text);
      setSets((prev) => {
        const next = [...prev];
        next[cur] = {
          ...next[cur],
          cfg,
          cfgName: file.name,
          cfgText: text,
          prof: {},
          frontAuto: {},
        };
        return next;
      });
      toast(
        `Read ${cfg.lanes.length} lanes from ${file.name}.${
          cfg.warnings.length ? ' ' + cfg.warnings[0] : ''
        }`
      );
    } catch (err: any) {
      toast('Could not read lane CSV: ' + err.message);
    }
    e.target.value = '';
  };

  // Load Plate Images (UV254, White, UV366)
  const handleLoadImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;
    toast('Reading plate images…');

    let loadedCount = 0;
    const newImgs: Record<string, TlcImageEntry> = { ...currentSet.imgs };

    for (const f of files) {
      const key = tlcKeyOf(f.name, newImgs);
      if (!key) {
        toast(`Could not allocate channel for ${f.name}. All 3 channels (UV254, UV366, White) are already filled.`);
        continue;
      }
      try {
        const bmp = await createImageBitmap(f);
        if (newImgs[key]?.bmp?.close) {
          newImgs[key].bmp.close();
        }
        newImgs[key] = { name: f.name, bmp };
        loadedCount++;
        // Persist to IndexedDB
        putTlcImage(currentSet.uid, key, f.name, f);
      } catch (err: any) {
        toast(`Could not open ${f.name}: ${err.message || err}`);
      }
    }

    if (loadedCount > 0) {
      setSets((prev) => {
        const next = [...prev];
        next[cur] = {
          ...next[cur],
          imgs: newImgs,
          prof: {},
          frontAuto: {},
        };
        return next;
      });
      setShow((prev) => ({ ...prev, UV254: true, UV366: true, White: true }));
      toast(
        currentSet.cfg
          ? `Loaded ${loadedCount} plate image${loadedCount === 1 ? '' : 's'}.`
          : `Loaded ${loadedCount} plate image${loadedCount === 1 ? '' : 's'}. Choose a Lane CSV to view sliced lanes and calculate Rf.`
      );
    }
    e.target.value = '';
  };

  // Apply Default Standard 54-Lane 6x9 Grid
  const handleApplyDefaultGrid = () => {
    const frameW = currentSet.frameW || LANE_FRAME_WIDTH;
    const cfg = createDefaultLaneConfig(frameW, 'two-tier');
    setSets((prev) => {
      const next = [...prev];
      next[cur] = {
        ...next[cur],
        cfg,
        cfgName: 'Standard 6×9 Grid (54 Lanes)',
        prof: {},
        frontAuto: {},
      };
      return next;
    });
    toast('Applied standard 54-lane TLC grid (27 + 27 two-tier layout).');
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
    Object.values(setToRemove.imgs).forEach((im) => im.bmp?.close && im.bmp.close());
    deleteTlcSetImages(setToRemove.uid, Object.keys(setToRemove.imgs));

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

  // Remove individual channel image from current set
  const handleRemoveImage = (key: TlcChannelKey) => {
    const im = currentSet.imgs[key];
    if (im?.bmp?.close) im.bmp.close();
    deleteTlcSetImages(currentSet.uid, [key]);
    setSets((prev) => {
      const next = [...prev];
      const newImgs = { ...next[cur].imgs };
      delete newImgs[key];
      next[cur] = {
        ...next[cur],
        imgs: newImgs,
        prof: {},
        frontAuto: {},
        originAuto: {},
      };
      return next;
    });
    toast(`Removed ${TLC_LABEL[key]} image.`);
  };

  // ---- Edge-effect correction (fitted per half of every set) ----
  const [edgeSettings, setEdgeSettings] = useState<Record<string, EdgeSetting>>(() => {
    const init: Record<string, EdgeSetting> = {};
    for (const s of sets) {
      if (s.edgeSettings) {
        if (s.edgeSettings[0]) init[`${s.uid}:0`] = s.edgeSettings[0];
        if (s.edgeSettings[1]) init[`${s.uid}:1`] = s.edgeSettings[1];
      }
    }
    return init;
  });
  // Spots picked as 'same compound' per set; group = which compound
  const [edgePicks, setEdgePicks] = useState<Record<string, EdgePick[]>>(() => {
    const init: Record<string, EdgePick[]> = {};
    for (const s of sets) {
      if (s.edgePicks) init[s.uid] = s.edgePicks;
    }
    return init;
  });
  const [pickMode, setPickMode] = useState(false);
  const [pickGroup, setPickGroup] = useState(0);
  const edgeCache = useRef(new WeakMap<TlcSet, { key: string; fits: (EdgeFit | null)[] }>());

  const detectOptsFor = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane) => {
      const prof = extractLaneProfile(set, key, lane, coreFraction);
      if (!prof.length) return null;
      const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
      const origin = tlcOrigin(set, lane, get);
      const front = tlcFront(set, lane, get);
      return {
        prof,
        origin,
        opts: {
          sign: TLC_SIGNAL[key].sign,
          origin,
          front,
          radius: lane.spotRadius || 24,
          minProminence: spotProminence,
        },
      };
    },
    [coreFraction, spotProminence]
  );

  const getEdgeFits = useCallback(
    (set: TlcSet): (EdgeFit | null)[] => {
      const picks = edgePicks[set.uid] || [];
      const key = `${spotProminence}|${coreFraction}|${JSON.stringify(picks)}|${Object.keys(set.imgs).join()}`;
      const hit = edgeCache.current.get(set);
      if (hit && hit.key === key) return hit.fits;
      const ch = (['UV254', 'UV366', 'White'] as TlcChannelKey[]).find((k) => !!set.imgs[k]);
      let fits: (EdgeFit | null)[] = [null, null];
      if (ch && set.cfg) {
        const get = (s: TlcSet, k: TlcChannelKey, l: TlcLane) => extractLaneProfile(s, k, l, coreFraction);
        const auto: EdgePoint[][] = [[], []];
        for (const lane of set.cfg.lanes) {
          if (lane.id < 0 || lane.id > 53) continue;
          const d = detectOptsFor(set, ch, lane);
          if (!d) continue;
          const laneSpots = (lane.customSpots && lane.customSpots.length > 0)
            ? lane.customSpots
            : findSpots(d.prof, d.opts);
          for (const sp of laneSpots) {
            if (sp.rf > 0.05 && sp.rf < 0.98 && (sp.source === 'manual' || sp.source === 'adjusted' || sp.strength > 0.15)) {
              auto[tlcHalf(lane)].push({ lane: lane.id, x: lane.x0, h: sp.pos - d.origin });
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
      edgeCache.current.set(set, { key, fits });
      return fits;
    },
    [spotProminence, coreFraction, edgePicks, detectOptsFor]
  );

  const handlePickSpot = useCallback(
    (laneId: number, pos: number) => {
      const uid = currentSet.uid;
      const cur = edgePicks[uid] || [];
      const same = cur.findIndex((q) => q.lane === laneId && Math.abs(q.pos - pos) < 6);
      let updated: EdgePick[];
      // clicking a picked spot again removes it
      if (same >= 0) {
        updated = cur.filter((_, i) => i !== same);
      } else {
        // one pick per lane and compound
        const rest = cur.filter((q) => !(q.lane === laneId && q.group === pickGroup));
        updated = [...rest, { lane: laneId, pos, group: pickGroup }];
      }
      setEdgePicks((prev) => ({ ...prev, [uid]: updated }));
      setSets((allSets) =>
        allSets.map((s) => (s.uid === uid ? { ...s, edgePicks: updated } : s))
      );
    },
    [currentSet.uid, edgePicks, pickGroup, setSets]
  );

  const handleEdgeSetting = useCallback(
    (h: number, st: EdgeSetting) => {
      const uid = currentSet.uid;
      setEdgeSettings((prev) => ({ ...prev, [`${uid}:${h}`]: st }));
      setSets((prev) =>
        prev.map((s) =>
          s.uid === uid
            ? { ...s, edgeSettings: { ...(s.edgeSettings || {}), [h]: st } }
            : s
        )
      );
    },
    [currentSet.uid, setSets]
  );

  const handleClearPicks = useCallback(() => {
    const uid = currentSet.uid;
    setEdgePicks((prev) => ({ ...prev, [uid]: [] }));
    setSets((prev) =>
      prev.map((s) => (s.uid === uid ? { ...s, edgePicks: [] } : s))
    );
  }, [currentSet.uid, setSets]);

  const edgeSettingFor = useCallback(
    (set: TlcSet, half: number): EdgeSetting => edgeSettings[`${set.uid}:${half}`] || DEFAULT_EDGE_SETTING,
    [edgeSettings]
  );

  // Get Spots helper for a set, channel, and lane with center-weighted core sampling.
  // When the edge-effect correction is active for the lane's half, Rf is corrected and the
  // measured value is kept in rfRaw.
  const getSpotsForLane = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane): TlcSpot[] | null => {
      if (!set.imgs[key]) return null;
      const d = detectOptsFor(set, key, lane);
      if (!d) return null;
      const autoSpots = findSpots(d.prof, d.opts);
      const spots = getEffectiveLaneSpots(lane, autoSpots);
      if (!spots.length) return spots;
      const h = tlcHalf(lane);
      const setting = edgeSettingFor(set, h);
      if (setting.mode === 'off') return spots;
      const fit = getEdgeFits(set)[h];
      if (!edgeActive(fit, setting)) return spots;
      return correctSpots(spots, edgeGain(fit, lane.x0, setting.strength), edgeOffset(fit, lane.x0, setting.strength));
    },
    [detectOptsFor, edgeSettingFor, getEdgeFits]
  );

  // Helper to extract panels for lane t
  const getPanelsForLane = useCallback(
    (t: number): LanePanel[] => {
      if (compare && isMultiSet) {
        return sets
          .map((s, idx): LanePanel | null => {
            const lane = s.cfg?.lanes.find((l) => l.id === t);
            if (!lane || !s.imgs[cmpKey]) return null;
            const spots = markSpots ? getSpotsForLane(s, cmpKey, lane) : null;
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

      const s = currentSet;
      return TLC_KEYS.filter((k) => s.imgs[k] && show[k])
        .map((k): LanePanel | null => {
          const lane = s.cfg?.lanes.find((l) => l.id === t);
          if (!lane) return null;
          const spots = markSpots ? getSpotsForLane(s, k, lane) : null;
          return {
            s,
            i: cur,
            key: k,
            lane,
            label: '',
            spots,
          };
        })
        .filter((p): p is LanePanel => p !== null);
    },
    [compare, isMultiSet, sets, cmpKey, currentSet, cur, show, markSpots, getSpotsForLane]
  );

  // Big modal inspection drawing & multi-channel densitogram calculation
  const inspectPanels = useMemo(() => {
    if (inspectWell === null) return [];
    const t = tlcLane(inspectWell, 'column');
    return getPanelsForLane(t);
  }, [inspectWell, getPanelsForLane]);

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
      drawLanePanels(bigCanvasRef.current, inspectPanels, 1.0, filters, markSpots);

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
            const span = Math.max(1, front - origin);
            const minDistance = Math.max(
              10,
              Math.round(span * (spotProminence >= 0.45 ? 0.14 : spotProminence <= 0.15 ? 0.025 : 0.07))
            );
            const rawDens = extractDensitogram(prof, {
              sign: TLC_SIGNAL[k].sign,
              origin,
              front,
              radius: l.spotRadius || 24,
              minProminence: spotProminence,
              minDistance,
            });
            const baseSpots = getEffectiveLaneSpots(l, rawDens.spots);
            const corrSpots = isCorr ? correctSpots(baseSpots, gain, offset) : baseSpots;
            newDens[k] = { ...rawDens, spots: corrSpots };
          }
        }
      }
      setChannelDensitograms(newDens);
    }
  }, [inspectWell, inspectPanels, filters, markSpots, coreFraction, spotProminence, edgeSettingFor, getEdgeFits]);

  // Keyboard listener inside well inspection modal for instant nudging and tilt
  useEffect(() => {
    if (inspectWell === null || !currentSet.cfg) return;
    const laneId = tlcLane(inspectWell, 'column');
    const targetLane = currentSet.cfg.lanes.find((l) => l.id === laneId);
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
  }, [inspectWell, currentSet.cfg]);

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
    const spots = targetPanel.spots || activeDens?.spots || [];
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
      const prof = extractLaneProfile(targetPanel.s, targetPanel.key, l, coreFraction);
      const sg = TLC_SIGNAL[targetPanel.key].sign;
      let best = Math.round(rawPos);
      for (let d = -10; d <= 10; d++) {
        const x = Math.round(rawPos) + d;
        if (
          x >= 0 &&
          x < prof.length &&
          sg * prof[x] > sg * prof[Math.max(0, Math.min(prof.length - 1, best))]
        ) {
          best = x;
        }
      }
      activePos = Math.max(0, Math.min(prof.length - 1, best));
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
    const spots = primary.spots || activeDens?.spots || [];

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
    if (hoverRf === null || hoverY === null || !inspectPanels[0]) return;
    // Shift + Click: Add manual spot at exact hover Rf
    if (e.shiftKey) {
      handleAddSpotInModal(hoverRf);
      return;
    }
    // Alt + Click: Delete spot if near
    if (e.altKey) {
      const spots = inspectPanels[0]?.spots || activeDens?.spots || [];
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
    if (!currentSet.cfg && !hasConfig) {
      toast('Please configure or generate lane grid before exporting analysis.');
      return;
    }
    try {
      const opts: TlcAnalysisExportOptions = {
        set: currentSet,
        sets,
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
      const scopeSuffix = scope === 'all' ? 'all_sets' : `plate_${plate + 1}`;
      a.download = `tlc_analysis_${baseName}_${scopeSuffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported TLC plate analysis (${ext.toUpperCase()}).`);
    } catch (err: any) {
      toast(`Export failed: ${err.message || err}`);
    }
  };

  // Download Batch tlc_rf_table.csv
  const handleDownloadRfCsv = () => handleExportAnalysis('csv', 'current');

  // Undo history stack for lane configurations
  const [cfgHistory, setCfgHistory] = useState<TlcLaneConfig[]>([]);
  const originalCfgRef = useRef<Record<string, TlcLaneConfig>>({});

  // Capture original configuration for resetting
  useEffect(() => {
    if (currentSet?.cfg && !originalCfgRef.current[currentSet.uid]) {
      originalCfgRef.current[currentSet.uid] = JSON.parse(JSON.stringify(currentSet.cfg));
    }
  }, [currentSet?.uid, currentSet?.cfg]);

  const lastHistorySnapshotRef = useRef<number>(0);

  // Take explicit undo history snapshot (e.g. on slider grab or key press)
  const handleSnapshotHistory = useCallback(() => {
    if (!currentSet?.cfg) return;
    setCfgHistory((h) => [...h.slice(-39), JSON.parse(JSON.stringify(currentSet.cfg!))]);
    lastHistorySnapshotRef.current = Date.now();
  }, [currentSet?.cfg]);

  // Real-time micro-adjustment of lane coordinates with smart debounced Undo history
  const handleUpdateLane = (laneId: number, patch: Partial<TlcLane>, forceSnapshot: boolean = false) => {
    if (!currentSet?.cfg) return;
    const now = Date.now();
    // Snapshot history once at the start of a slide or after 500ms pause, or if forced
    if (forceSnapshot || now - lastHistorySnapshotRef.current > 500) {
      const currentCfg = currentSet.cfg;
      setCfgHistory((h) => [...h.slice(-39), JSON.parse(JSON.stringify(currentCfg))]);
      lastHistorySnapshotRef.current = now;
    }
    setSets((prev) => {
      const next = [...prev];
      const cfg = next[cur]?.cfg;
      if (!cfg) return next;
      const newLanes = cfg.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l));
      next[cur] = {
        ...next[cur],
        cfg: { ...cfg, lanes: newLanes },
        prof: {}, // invalidate cached sampled profile so it re-slices at new coordinates
        frontAuto: {},
        originAuto: {},
      };
      return next;
    });
  };

  // Revert last adjustment
  const handleUndo = () => {
    if (cfgHistory.length === 0) return;
    const prevCfg = cfgHistory[cfgHistory.length - 1];
    setCfgHistory((h) => h.slice(0, -1));
    setSets((prev) => {
      const next = [...prev];
      next[cur] = {
        ...next[cur],
        cfg: prevCfg,
        prof: {},
        frontAuto: {},
        originAuto: {},
      };
      return next;
    });
    toast('Reverted last adjustment (Undo).');
  };

  // Reset single lane to its original template configuration
  const handleResetLane = (laneId: number) => {
    const origSetCfg = originalCfgRef.current[currentSet.uid];
    if (!origSetCfg) {
      toast('No original lane template recorded.');
      return;
    }
    const origLane = origSetCfg.lanes.find((l) => l.id === laneId);
    if (!origLane) return;
    handleUpdateLane(laneId, { ...origLane });
    toast(`Reset Lane ${laneId} to original template.`);
  };

  // Reset all lanes in the set to their original template configuration
  const handleResetAllLanes = () => {
    const origSetCfg = originalCfgRef.current[currentSet.uid];
    if (!origSetCfg) {
      toast('No original lane template recorded.');
      return;
    }
    if (currentSet.cfg) {
      setCfgHistory((h) => [...h.slice(-39), JSON.parse(JSON.stringify(currentSet.cfg))]);
    }
    setSets((prev) => {
      const next = [...prev];
      next[cur] = {
        ...next[cur],
        cfg: JSON.parse(JSON.stringify(origSetCfg)),
        prof: {},
        frontAuto: {},
        originAuto: {},
      };
      return next;
    });
    toast('Reset all lanes to original configuration.');
  };

  // Solvent front update (moves meniscus baseline across the plate or for a specific side)
  const handleUpdateSetFront = (frontPx: number | null, side?: number) => {
    setSets((prev) => {
      const next = [...prev];
      const target = next[cur];
      if (!target) return next;
      if (side !== undefined) {
        const nextHalfFront = { ...(target.frontHalfPx || {}) };
        if (frontPx != null && frontPx > 0) {
          nextHalfFront[side] = frontPx;
        } else {
          delete nextHalfFront[side];
        }
        next[cur] = {
          ...target,
          frontHalfPx: nextHalfFront,
          prof: {},
          frontAuto: {},
        };
      } else {
        next[cur] = {
          ...target,
          frontPx: frontPx != null && frontPx > 0 ? frontPx : null,
          prof: {},
          frontAuto: {},
        };
      }
      return next;
    });
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
    if (!currentSet.cfg) {
      toast('No lane configuration to export.');
      return;
    }
    try {
      const csvContent = exportLaneConfigCsv(currentSet.cfg);
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lane_config_${currentSet.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_corrected.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Exported corrected lane CSV.');
    } catch (err: any) {
      toast('Error exporting lane CSV: ' + err.message);
    }
  };

  const hasConfig = Boolean(currentSet.cfg);
  const hasImages = TLC_KEYS.some((k) => Boolean(currentSet.imgs[k]));

  // Active Densitogram(s) for the modal
  const activeDens = useMemo(() => {
    if (densViewMode === 'overlay') {
      return channelDensitograms.UV254 || channelDensitograms.UV366 || channelDensitograms.White || null;
    }
    return channelDensitograms[densViewMode] || null;
  }, [channelDensitograms, densViewMode]);

  // Separation calculations between detected spots
  const separationMetrics = useMemo(() => {
    if (!activeDens || activeDens.spots.length < 2) return null;
    const sorted = [...activeDens.spots].sort((a, b) => a.rf - b.rf);
    const deltas: Array<{ s1: TlcSpot; s2: TlcSpot; delta: number; status: 'good' | 'fair' | 'poor' }> = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const s1 = sorted[i];
      const s2 = sorted[i + 1];
      const delta = Number(Math.abs(s2.rf - s1.rf).toFixed(3));
      const status = delta >= 0.15 ? 'good' : delta >= 0.05 ? 'fair' : 'poor';
      deltas.push({ s1, s2, delta, status });
    }
    return deltas;
  }, [activeDens]);

  // Spot management callbacks for the zoomed-in lane modal
  const handleAddSpotInModal = useCallback(
    (targetRf: number = 0.5) => {
      if (inspectWell === null || !currentSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const lane = currentSet.cfg.lanes.find((l) => l.id === laneId);
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
      const currentSpots = inspectPanels[0]?.spots || activeDens?.spots || [];
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
    [inspectWell, currentSet.cfg, inspectPanels, activeDens, coreFraction, handleSnapshotHistory]
  );

  const handleDeleteSpotInModal = useCallback(
    (spotIndex: number) => {
      if (inspectWell === null || !currentSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const currentSpots = inspectPanels[0]?.spots || activeDens?.spots || [];
      if (!currentSpots[spotIndex]) return;
      handleSnapshotHistory();
      const remaining = currentSpots.filter((_, idx) => idx !== spotIndex);
      handleUpdateLane(laneId, { customSpots: remaining }, true);
      toast(`Removed spot #${spotIndex + 1}.`);
    },
    [inspectWell, currentSet.cfg, inspectPanels, activeDens, handleSnapshotHistory]
  );

  const handleNudgeSpotInModal = useCallback(
    (spotIndex: number, deltaRf: number) => {
      if (inspectWell === null || !currentSet.cfg) return;
      const laneId = tlcLane(inspectWell, 'column');
      const lane = currentSet.cfg.lanes.find((l) => l.id === laneId);
      if (!lane) return;
      const currentSpots = inspectPanels[0]?.spots || activeDens?.spots || [];
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
    [inspectWell, currentSet.cfg, inspectPanels, activeDens, coreFraction, handleSnapshotHistory]
  );

  const handleResetLaneSpotsInModal = useCallback(() => {
    if (inspectWell === null || !currentSet.cfg) return;
    const laneId = tlcLane(inspectWell, 'column');
    handleSnapshotHistory();
    handleUpdateLane(laneId, { customSpots: undefined }, true);
    toast('Reset lane spots back to automated detection.');
  }, [inspectWell, currentSet.cfg, handleSnapshotHistory]);

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
      if (drag && currentSet?.cfg) {
        const lane = currentSet.cfg.lanes.find((l) => l.id === drag.laneId);
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
  }, [isDraggingModalSpot, currentSet?.cfg]);

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
                    color: 'var(--mut)',
                    padding: '2px 4px',
                    fontSize: '12px',
                    lineHeight: 1,
                    borderRadius: '3px',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--mut)')}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className="btn sm" onClick={handleAddSet}>
            + Add Solvent Set
          </button>
        </div>

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
            onClick={() => handleRemoveSetIndex(cur)}
            title={sets.length > 1 ? `Delete "${currentSet.name}"` : 'Clear images and reset this set'}
          >
            {sets.length > 1 ? '🗑️ Delete Set' : '🗑️ Clear Set'}
          </button>

          <div style={{ height: '20px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

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

          <button type="button" className="btn pri" onClick={() => fileImgRef.current?.click()}>
            {hasImages ? 'Add / Replace Plate Photos' : 'Upload Plate Photos'}
          </button>
          <input
            ref={fileImgRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={handleLoadImages}
          />

          <button
            type="button"
            className="btn"
            onClick={handleLoadDemoTlc}
            title="Generate and display sample UV 254 nm and 365 nm TLC plate images with spots and densitograms"
            style={{ background: 'rgba(16, 185, 129, 0.15)', borderColor: '#10b981', color: '#10b981', fontWeight: 600 }}
          >
            🧪 Try Demo Plate
          </button>

          <div style={{ height: '20px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          {/* View Mode Switcher */}
          <div
            style={{
              display: 'inline-flex',
              background: 'var(--soft)',
              padding: '2px',
              borderRadius: '6px',
              border: '1px solid var(--line)',
            }}
          >
            <button
              type="button"
              className={`btn sm ${viewMode === 'grid' ? 'pri' : ''}`}
              onClick={() => setViewMode('grid')}
              style={{ fontSize: '11px', padding: '3px 8px' }}
            >
              🔲 54-Well Sliced Grid
            </button>
            <button
              type="button"
              className={`btn sm ${viewMode === 'full-plate' ? 'pri' : ''}`}
              onClick={() => setViewMode('full-plate')}
              style={{ fontSize: '11px', padding: '3px 8px' }}
            >
              📷 Full Plate Photo
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
                <span style={{ fontSize: '10px', color: 'var(--mut)', whiteSpace: 'nowrap' }}>Merge:</span>
                <input
                  type="range"
                  min="0.08"
                  max="0.70"
                  step="0.02"
                  value={spotProminence}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSpotProminence(v);
                    if (v >= 0.45) setSpotMode('broad');
                    else if (v <= 0.16) setSpotMode('sensitive');
                    else setSpotMode('standard');
                  }}
                  style={{ width: '60px', height: '14px', cursor: 'pointer' }}
                  title={`Valley Prominence Threshold: ${Math.round(spotProminence * 100)}% (higher = merges broad/tailing bands; lower = detects fine trace spots)`}
                />
                <span className="mono" style={{ fontSize: '10px', minWidth: '26px', color: 'var(--fg)', fontWeight: 700 }}>
                  {Math.round(spotProminence * 100)}%
                </span>
              </div>
            </div>
          )}

          {platesCount > 1 && (
            <label className="tlcz" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <span>Plate:</span>
              <select
                className="f"
                value={plate}
                onChange={(e) => setPlate(parseInt(e.target.value, 10))}
              >
                {Array.from({ length: platesCount }, (_, idx) => (
                  <option key={idx} value={idx}>Plate {idx + 1}</option>
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
                const parsed = parseWellQuery(val, platesCount);
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
          {hasConfig ? (
            <span className="chip ok" style={{ fontSize: '11px' }}>
              ✓ {currentSet.cfg?.lanes.length} lanes · {currentSet.cfgName}
              {currentSet.cfg?.hasZeroRf
                ? ' · microadjusted origins'
                : currentSet.originPx
                ? ` · manual origin (${currentSet.originPx} px)`
                : ' · auto-detected baseline'}
            </span>
          ) : (
            <span className="chip warn" style={{ fontSize: '11px' }}>
              ⚠️ No lane CSV loaded yet
            </span>
          )}

          {TLC_KEYS.map((k) => {
            const hasImg = Boolean(currentSet.imgs[k]);
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
                  {currentSet.imgs[k].name.length > 20
                    ? '…' + currentSet.imgs[k].name.slice(-18)
                    : currentSet.imgs[k].name}
                </span>
                <button
                  type="button"
                  title={`Remove ${TLC_LABEL[k]} photo`}
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
              ⚠️ No plate images loaded yet
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
                // Clear cached profiles and auto-detected fronts to recompute with new core corridor
                setSets((prev) =>
                  prev.map((s) => ({
                    ...s,
                    prof: {},
                    frontAuto: {},
                  }))
                );
              }}
            />
            <span className="mono" style={{ fontSize: '11px', width: '32px' }}>
              {Math.round(coreFraction * 100)}%
            </span>
          </label>

          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFilters({ brightness: 100, contrast: 100, invert: false });
              setCoreFraction(0.35);
              setSets((prev) => prev.map((s) => ({ ...s, prof: {}, frontAuto: {} })));
            }}
            style={{ marginLeft: 'auto', fontSize: '11px' }}
          >
            Reset
          </button>
        </div>

        {/* Collapsible Image & Meniscus Front Settings */}
        <details className="det" style={{ marginTop: '10px', fontSize: '12px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--fg)' }}>
            ⚙️ Advanced Image &amp; Solvent Front Calibration ({currentSet.name})
          </summary>
          <div style={{ padding: '8px 12px', background: 'var(--soft)', borderRadius: '6px', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span>Reference Frame Width (px):</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '90px' }}
                  value={currentSet.frameW || LANE_FRAME_WIDTH}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 100) {
                      setSets((prev) => {
                        const next = [...prev];
                        next[cur] = { ...next[cur], frameW: v, prof: {}, frontAuto: {}, originAuto: {} };
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
                  value={currentSet.originPx || ''}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setSets((prev) => {
                      const next = [...prev];
                      next[cur] = { ...next[cur], originPx: v > 0 ? v : null, prof: {}, originAuto: {} };
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
                  value={currentSet.frontPx || ''}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setSets((prev) => {
                      const next = [...prev];
                      next[cur] = { ...next[cur], frontPx: v > 0 ? v : null, prof: {}, frontAuto: {} };
                      return next;
                    });
                  }}
                />
              </label>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
              Spot origin baseline (Rf = 0.00) and solvent front meniscus (Rf = 1.00) are automatically resolved from your lane profiles or microadjusted CSV. You can also specify manual overrides above.
              {currentSet.cfg && (
                <span style={{ color: 'var(--pri)', marginLeft: '6px' }}>
                  (Current baseline: {Math.round(tlcOrigin(currentSet, currentSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px · Solvent front: {tlcFront(currentSet, currentSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction))} px)
                </span>
              )}
            </div>
          </div>
        </details>
      </div>

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
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)' }}>Plate Channel:</span>
            {TLC_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={`btn sm ${fullPlateChannel === k ? 'pri' : ''}`}
                onClick={() => setFullPlateChannel(k)}
                disabled={!currentSet.imgs[k]}
                style={{ fontSize: '11px', padding: '4px 10px' }}
              >
                {TLC_LABEL[k]} {currentSet.imgs[k] ? '✓' : '(empty)'}
              </button>
            ))}
            {currentSet.imgs.UV254 && currentSet.imgs.UV366 && (
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
                title="Dual-channel overlay blending UV254 quenching with UV365 fluorescence"
              >
                ✨ Dual Composite (254+365) ✓
              </button>
            )}
          </div>

          <TlcFullPlateView
            currentSet={currentSet}
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
            onUpdateLane={handleUpdateLane}
            onUpdateSetFront={handleUpdateSetFront}
            onSnapshotHistory={handleSnapshotHistory}
            onUndo={handleUndo}
            canUndo={cfgHistory.length > 0}
            onResetLane={handleResetLane}
            onResetAllLanes={handleResetAllLanes}
            onExportLaneCsv={handleExportLaneCsv}
            spotProminence={spotProminence}
            pickMode={pickMode}
            picks={edgePicks[currentSet.uid] || []}
            onPickSpot={handlePickSpot}
            edgeFits={getEdgeFits(currentSet)}
            edgeSettings={[edgeSettingFor(currentSet, 0), edgeSettingFor(currentSet, 1)]}
            onEdgeSetting={handleEdgeSetting}
            onPickMode={setPickMode}
            pickGroup={pickGroup}
            onPickGroup={setPickGroup}
            onClearPicks={handleClearPicks}
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
                No Plate Photographs Loaded
              </div>
              <div style={{ fontSize: '12px', color: 'var(--mut)', maxWidth: '520px', margin: '0 auto 12px' }}>
                Upload your laboratory TLC plate photographs using the <b>Upload Plate Photos</b> button, or test the live densitometer with realistic synthetic data below.
              </div>
              <button
                type="button"
                className="btn pri sm"
                onClick={handleLoadDemoTlc}
              >
                🧪 Try Demo TLC Plate
              </button>
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
                className="ib"
                onClick={() => setInspectWell(null)}
                title="Close"
              >
                ✕
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
                      <span style={{ fontWeight: 600 }}>Densitogram Channel:</span>
                      <div className="tlcsets" style={{ display: 'inline-flex', gap: '4px', margin: 0 }}>
                        {channelDensitograms.UV254 && channelDensitograms.UV366 && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'overlay' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('overlay')}
                            style={{ fontSize: '11px', padding: '3px 8px' }}
                          >
                            Dual Overlay (254 + 365 nm)
                          </button>
                        )}
                        {channelDensitograms.UV254 && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'UV254' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('UV254')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#10b981' }}
                          >
                            ● UV 254 nm (Quenching)
                          </button>
                        )}
                        {channelDensitograms.UV366 && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'UV366' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('UV366')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#a855f7' }}
                          >
                            ● UV 365 nm (Fluorescence)
                          </button>
                        )}
                        {channelDensitograms.White && (
                          <button
                            type="button"
                            className={`tlcsetbtn ${densViewMode === 'White' ? 'on' : ''}`}
                            onClick={() => setDensViewMode('White')}
                            style={{ fontSize: '11px', padding: '3px 8px', color: '#f59e0b' }}
                          >
                            ● Visible (Stain)
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
                              ? `Peak Apex: Rf ${hoverSpot.rf.toFixed(2)}${hoverSpot.rfRaw != null && Math.abs(hoverSpot.rf - hoverSpot.rfRaw) >= 0.005 ? ` (${hoverSpot.rfRaw.toFixed(2)} raw)` : ''} (${hoverSpot.strength > 0.5 ? 'strong' : hoverSpot.strength > 0.2 ? 'medium' : 'weak'}, ${hoverSpot.areaPct || 0}% area)`
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
                    {/* Left Sticky Column: Physical Canvas & Densitometer (Always in View!) */}
                    <div
                      style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 10,
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
                    {/* Enlarged Physical TLC Canvas */}
                    <div>
                      <div
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#94a3b8',
                          marginBottom: '4px',
                          textAlign: 'center',
                          textTransform: 'uppercase',
                        }}
                      >
                        TLC Plate Lane
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
                          const spots = primary?.spots || activeDens?.spots || [];
                          if (!primary || !spots.length) return null;
                          const l = primary.lane;
                          const ph = inspectHeight;

                          return spots.map((sp, idx) => {
                            const y = ph - sp.pos;
                            const isHovered = hoveredModalSpotIdx === idx;
                            const isDragged = isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                            const spotColor = isDragged
                              ? '#facc15'
                              : sp.source === 'manual'
                              ? '#f59e0b'
                              : sp.source === 'adjusted'
                              ? '#a855f7'
                              : '#38bdf8';

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
                                  title={`Spot #${idx + 1} (${sp.source || 'auto'}): Rf ${sp.rf.toFixed(2)}\n• Drag vertically to slide Rf\n• Alt+Click to remove spot`}
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
                                    color: isDragged || isHovered || sp.source === 'manual' ? '#000000' : '#ffffff',
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
                            padding: '3px 8px 1px',
                            textAlign: 'center',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            borderBottom: '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          Parallel 1D Densitogram (Base ➔ Front)
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
                              width="320"
                              height={ph}
                              viewBox={`0 0 320 ${ph}`}
                              style={{
                                display: 'block',
                                background: '#020403',
                                cursor: 'crosshair',
                              }}
                              onMouseMove={handleCanvasMouseMove}
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

                              {/* Render UV 254 nm Densitogram Trace (Quenching / Absorbance) */}
                              {(densViewMode === 'overlay' || densViewMode === 'UV254') &&
                                channelDensitograms.UV254 &&
                                (() => {
                                  const d = channelDensitograms.UV254;
                                  const pts = d.points;
                                  if (!pts.length) return null;
                                  const dStr = pts
                                    .map((p) => {
                                      const y = ph - p.pos;
                                      const x = 40 + Math.min(230, (p.signal / d.maxSignal) * 230);
                                      return `${y === ph - pts[0].pos ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                                    })
                                    .join(' ');
                                  return (
                                    <g key="uv254">
                                      <path d={dStr} fill="none" stroke="#10b981" strokeWidth="2" />
                                      {/* Detected Peak Apex Dots with Provenance Styling */}
                                      {d.spots.map((sp, idx) => {
                                        const y = ph - sp.pos;
                                        const pt = pts[sp.pos];
                                        const x = 40 + Math.min(230, ((pt?.signal || 0) / d.maxSignal) * 230);
                                        const isDragged = isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                                        const spotColor = isDragged
                                          ? '#facc15'
                                          : sp.source === 'manual'
                                          ? '#f59e0b'
                                          : sp.source === 'adjusted'
                                          ? '#a855f7'
                                          : '#34d399';
                                        return (
                                          <g key={idx}>
                                            <circle
                                              cx={x}
                                              cy={y}
                                              r={isDragged ? '5' : '3.5'}
                                              fill={spotColor}
                                              stroke="#ffffff"
                                              strokeWidth={isDragged ? '2' : '1'}
                                            />
                                            <text
                                              x={Math.min(270, x + 6)}
                                              y={y + 3}
                                              fill={spotColor}
                                              fontSize="9"
                                              fontWeight="bold"
                                              fontFamily="monospace"
                                            >
                                              {sp.source === 'manual' ? '✋ ' : sp.source === 'adjusted' ? '✨ ' : ''}
                                              Rf {sp.rf.toFixed(2)}{sp.rfRaw != null && Math.abs(sp.rf - sp.rfRaw) >= 0.005 ? ` (${sp.rfRaw.toFixed(2)})` : ''}
                                            </text>
                                          </g>
                                        );
                                      })}
                                    </g>
                                  );
                                })()}

                              {/* Render UV 365 nm Densitogram Trace (Intrinsic Fluorescence) */}
                              {(densViewMode === 'overlay' || densViewMode === 'UV366') &&
                                channelDensitograms.UV366 &&
                                (() => {
                                  const d = channelDensitograms.UV366;
                                  const pts = d.points;
                                  if (!pts.length) return null;
                                  const dStr = pts
                                    .map((p) => {
                                      const y = ph - p.pos;
                                      const x = 40 + Math.min(230, (p.signal / d.maxSignal) * 230);
                                      return `${y === ph - pts[0].pos ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                                    })
                                    .join(' ');
                                  return (
                                    <g key="uv366">
                                      <path d={dStr} fill="none" stroke="#a855f7" strokeWidth="2" strokeDasharray={densViewMode === 'overlay' ? '4,2' : undefined} />
                                      {/* Detected Peak Apex Dots with Provenance Styling */}
                                      {d.spots.map((sp, idx) => {
                                        const y = ph - sp.pos;
                                        const pt = pts[sp.pos];
                                        const x = 40 + Math.min(230, ((pt?.signal || 0) / d.maxSignal) * 230);
                                        const isDragged = isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                                        const spotColor = isDragged
                                          ? '#facc15'
                                          : sp.source === 'manual'
                                          ? '#f59e0b'
                                          : sp.source === 'adjusted'
                                          ? '#c084fc'
                                          : '#a855f7';
                                        return (
                                          <g key={idx}>
                                            <circle
                                              cx={x}
                                              cy={y}
                                              r={isDragged ? '5' : '3.5'}
                                              fill={spotColor}
                                              stroke="#ffffff"
                                              strokeWidth={isDragged ? '2' : '1'}
                                            />
                                            <text
                                              x={Math.min(270, x + 6)}
                                              y={y + 3}
                                              fill={spotColor}
                                              fontSize="9"
                                              fontWeight="bold"
                                              fontFamily="monospace"
                                            >
                                              {sp.source === 'manual' ? '✋ ' : sp.source === 'adjusted' ? '✨ ' : ''}
                                              Rf {sp.rf.toFixed(2)}{sp.rfRaw != null && Math.abs(sp.rf - sp.rfRaw) >= 0.005 ? ` (${sp.rfRaw.toFixed(2)})` : ''}
                                            </text>
                                          </g>
                                        );
                                      })}
                                    </g>
                                  );
                                })()}

                              {/* Render Visible Densitogram Trace */}
                              {densViewMode === 'White' &&
                                channelDensitograms.White &&
                                (() => {
                                  const d = channelDensitograms.White;
                                  const pts = d.points;
                                  if (!pts.length) return null;
                                  const dStr = pts
                                    .map((p) => {
                                      const y = ph - p.pos;
                                      const x = 40 + Math.min(230, (p.signal / d.maxSignal) * 230);
                                      return `${y === ph - pts[0].pos ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                                    })
                                    .join(' ');
                                  return (
                                    <g key="white">
                                      <path d={dStr} fill="none" stroke="#f59e0b" strokeWidth="2" />
                                      {d.spots.map((sp, idx) => {
                                        const y = ph - sp.pos;
                                        const pt = pts[sp.pos];
                                        const x = 40 + Math.min(230, ((pt?.signal || 0) / d.maxSignal) * 230);
                                        const isDragged = isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx;
                                        const spotColor = isDragged
                                          ? '#facc15'
                                          : sp.source === 'manual'
                                          ? '#f59e0b'
                                          : sp.source === 'adjusted'
                                          ? '#a855f7'
                                          : '#fbbf24';
                                        return (
                                          <g key={idx}>
                                            <circle
                                              cx={x}
                                              cy={y}
                                              r={isDragged ? '5' : '3.5'}
                                              fill={spotColor}
                                              stroke="#ffffff"
                                              strokeWidth={isDragged ? '2' : '1'}
                                            />
                                            <text
                                              x={Math.min(270, x + 6)}
                                              y={y + 3}
                                              fill={spotColor}
                                              fontSize="9"
                                              fontWeight="bold"
                                              fontFamily="monospace"
                                            >
                                              {sp.source === 'manual' ? '✋ ' : sp.source === 'adjusted' ? '✨ ' : ''}
                                              Rf {sp.rf.toFixed(2)}{sp.rfRaw != null && Math.abs(sp.rf - sp.rfRaw) >= 0.005 ? ` (${sp.rfRaw.toFixed(2)})` : ''}
                                            </text>
                                          </g>
                                        );
                                      })}
                                    </g>
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
                  {currentSet.cfg && (() => {
                    const laneId = tlcLane(inspectWell, 'column');
                    const targetLane = currentSet.cfg.lanes.find((l) => l.id === laneId);
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
                                max={Math.min(currentSet.frameW || 3280, Math.round(targetLane.x0 + 120))}
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
                                {Math.round(tlcOrigin(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcOrigin(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
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
                                value={Math.round(tlcOrigin(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))}
                                onChange={(e) => handleUpdateLane(laneId, { zeroRf: +e.target.value })}
                                style={{ flex: 1, accentColor: '#fbbf24', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcOrigin(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
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
                                {Math.round(tlcFront(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))} px
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcFront(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
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
                                value={Math.round(tlcFront(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)))}
                                onChange={(e) => handleUpdateSetFront(+e.target.value)}
                                style={{ flex: 1, accentColor: '#38bdf8', height: '5px', cursor: 'ew-resize' }}
                              />
                              <button
                                type="button"
                                style={{ background: '#1e293b', color: '#fff', border: '1px solid #475569', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                onClick={() => {
                                  const curr = Math.round(tlcFront(currentSet, targetLane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction)));
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
                        {currentSet.cfg && (() => {
                          const lId = tlcLane(inspectWell, 'column');
                          const lObj = currentSet.cfg.lanes.find((l) => l.id === lId);
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
                        {activeDens?.spots.length ? (
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                            {activeDens.spots.length} peak{activeDens.spots.length === 1 ? '' : 's'} identified
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {activeDens?.spots.length ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {/* Interactive Peak Adjustment Cards */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {activeDens.spots.map((sp, idx) => {
                            const isSelected = hoveredModalSpotIdx === idx || (isDraggingModalSpot && dragModalSpotRef.current?.spotIndex === idx);
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
                              : 'rgba(255, 255, 255, 0.12)';

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
                                      color: '#ffffff',
                                      background: sp.source === 'manual' ? '#b45309' : sp.source === 'adjusted' ? '#7e22ce' : '#0284c7',
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
                                      color: sp.source === 'manual' ? '#fbbf24' : sp.source === 'adjusted' ? '#d8b4fe' : '#38bdf8',
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
                                  {(sp.source === 'auto' || !sp.source) && (
                                    <span style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid #0284c7', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 600 }}>
                                      Auto
                                    </span>
                                  )}
                                  <span style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'capitalize' }}>
                                    ({sp.strength > 0.5 ? 'strong' : sp.strength > 0.2 ? 'medium' : 'weak'} · {sp.areaPct || 0}% area)
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
                    spots={activeDens?.spots ? activeDens.spots.map((s) => ({ rf: s.rf, intensity: s.strength, note: s.source })) : []}
                    wellRecipe={(() => {
                      const row = run?.rows?.find(
                        (r: any) => r.plate_number === plate && r.container_id === inspectWell
                      );
                      return row ? row.recipe : undefined;
                    })()}
                    mobilePhase="30% EtOAc / 70% Hexanes"
                    stain={densViewMode === 'White' ? 'Visible Stain' : 'UV 254 nm'}
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

            <div className="modal-foot" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
    </div>
  );
};
