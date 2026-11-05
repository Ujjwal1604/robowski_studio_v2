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
  createDefaultLaneConfig,
  createDemoTlcDataSet,
  exportLaneConfigCsv,
} from '../../engine';
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

    // Pink ticks at detected spots
    if (showSpots && p.spots && p.spots.length) {
      ctx.strokeStyle = '#FF4D8D';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const sp of p.spots.slice(0, 6)) {
        const y = top + k * (l.length - sp.pos);
        ctx.moveTo(x + w - 7, y);
        ctx.lineTo(x + w, y);
      }
      ctx.stroke();
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
  const { run, toast, tlcSets: sets, setTlcSets: setSets, activeTlcStatus } = useApp();

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

  // Multi-Channel Densitometry Data Dictionary
  const [channelDensitograms, setChannelDensitograms] = useState<{
    UV254?: TlcDensitogramData;
    UV366?: TlcDensitogramData;
    White?: TlcDensitogramData;
  }>({});

  const fileCsvRef = useRef<HTMLInputElement>(null);
  const fileImgRef = useRef<HTMLInputElement>(null);
  const bigCanvasRef = useRef<HTMLCanvasElement>(null);

  const currentSet = sets[cur] || sets[0];
  const platesCount = run?.plates || 1;
  const isMultiSet = sets.length > 1;

  // Restore saved images from IndexedDB on initial mount
  useEffect(() => {
    let cancelled = false;
    const restoreCachedImages = async () => {
      for (let sIdx = 0; sIdx < sets.length; sIdx++) {
        const s = sets[sIdx];
        for (const k of TLC_KEYS) {
          if (!s.imgs[k]) {
            const cached = await getTlcImage(s.uid, k);
            if (cached && !cancelled) {
              try {
                const bmp = await createImageBitmap(cached.blob);
                if (!cancelled) {
                  setSets((prev) => {
                    const next = [...prev];
                    if (next[sIdx]) {
                      next[sIdx] = {
                        ...next[sIdx],
                        imgs: { ...next[sIdx].imgs, [k]: { name: cached.name, bmp } },
                      };
                    }
                    return next;
                  });
                }
              } catch {
                // soft fail
              }
            }
          }
        }
      }
    };
    restoreCachedImages();
    return () => {
      cancelled = true;
    };
  }, [sets.length]);

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

  // Get Spots helper for a set, channel, and lane with center-weighted core sampling
  const getSpotsForLane = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane): TlcSpot[] | null => {
      if (!set.imgs[key]) return null;
      const prof = extractLaneProfile(set, key, lane, coreFraction);
      if (!prof.length) return null;
      const origin = tlcOrigin(set, lane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction));
      const front = tlcFront(set, lane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction));
      return findSpots(prof, {
        sign: TLC_SIGNAL[key].sign,
        origin,
        front,
        radius: lane.spotRadius || 24,
      });
    },
    [coreFraction]
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

        for (const k of TLC_KEYS) {
          if (s.imgs[k]) {
            const prof = extractLaneProfile(s, k, l, coreFraction);
            newDens[k] = extractDensitogram(prof, {
              sign: TLC_SIGNAL[k].sign,
              origin,
              front,
              radius: l.spotRadius || 24,
            });
          }
        }
      }
      setChannelDensitograms(newDens);
    }
  }, [inspectWell, inspectPanels, filters, markSpots, coreFraction]);

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
    const spots = targetPanel.spots || [];
    const nearSpot = spots.find((sp) => Math.abs(sp.pos - rawPos) <= 16);

    let activePos = rawPos;
    let activeSpot: TlcSpot | null = null;

    if (nearSpot) {
      activePos = nearSpot.pos;
      activeSpot = nearSpot;
    } else {
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
    const calculatedRf = Math.max(0, (activePos - zeroDist) / span);
    const snappedY = ph - activePos;

    setHoverRf(Number(calculatedRf.toFixed(3)));
    setHoverY(snappedY);
    setHoverSpot(activeSpot);
  };

  // Click on Canvas to Pin a Spot Marker
  const handleCanvasClick = () => {
    if (hoverRf === null || hoverY === null) return;
    const existingIdx = pinnedMarkers.findIndex((m) => Math.abs(m.rf - hoverRf) < 0.02);
    if (existingIdx >= 0) {
      setPinnedMarkers((prev) => prev.filter((_, idx) => idx !== existingIdx));
    } else {
      const nextId = Date.now();
      const label = `Spot ${pinnedMarkers.length + 1}`;
      setPinnedMarkers((prev) => [...prev, { id: nextId, rf: hoverRf, label, y: hoverY }]);
    }
  };

  // Download Batch tlc_rf_table.csv
  const handleDownloadRfCsv = () => {
    if (!run) {
      toast('No active run data.');
      return;
    }
    try {
      const csvContent = tlcRfCsv(
        sets,
        run,
        getSpotsForLane,
        plate,
        (s, k, ln) => extractLaneProfile(s, k, ln, coreFraction)
      );
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tlc_rf_table_${run.runName.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Exported TLC Rf table CSV.');
    } catch (err: any) {
      toast('Error exporting Rf table: ' + err.message);
    }
  };

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

          {Boolean(run?.rows?.length) && hasConfig && (
            <button
              type="button"
              className="btn pri"
              onClick={handleDownloadRfCsv}
              title="Export complete 54-well spreadsheet with recipes, solvent front, and detected spots"
            >
              📥 Download Rf Table (CSV)
            </button>
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
                          ? `Peak Apex: Rf ${hoverRf.toFixed(2)} (${hoverSpot.strength > 0.5 ? 'strong' : hoverSpot.strength > 0.2 ? 'medium' : 'weak'}, ${hoverSpot.areaPct || 0}% area)`
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
                          onMouseLeave={() => {
                            setHoverRf(null);
                            setHoverY(null);
                            setHoverSpot(null);
                          }}
                          onClick={handleCanvasClick}
                          style={{
                            cursor: 'crosshair',
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

                        {/* Live Cursor Crosshair Bar across lane */}
                        {hoverY !== null && (
                          <div
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: 0,
                              top: `${hoverY}px`,
                              height: '1px',
                              background: hoverSpot ? '#f43f5e' : '#38bdf8',
                              boxShadow: hoverSpot ? '0 0 6px #f43f5e' : '0 0 4px #38bdf8',
                              pointerEvents: 'none',
                              zIndex: 10,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                left: '4px',
                                top: '-16px',
                                background: 'rgba(0,0,0,0.85)',
                                color: hoverSpot ? '#f43f5e' : '#38bdf8',
                                fontSize: '10px',
                                fontWeight: 700,
                                fontFamily: 'monospace',
                                padding: '1px 4px',
                                borderRadius: '2px',
                              }}
                            >
                              Rf {hoverRf?.toFixed(2)}
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
                                      {/* Detected Peak Apex Dots */}
                                      {d.spots.map((sp, idx) => {
                                        const y = ph - sp.pos;
                                        const pt = pts[sp.pos];
                                        const x = 40 + Math.min(230, ((pt?.signal || 0) / d.maxSignal) * 230);
                                        return (
                                          <g key={idx}>
                                            <circle cx={x} cy={y} r="3.5" fill="#34d399" stroke="#ffffff" strokeWidth="1" />
                                            <text x={Math.min(270, x + 6)} y={y + 3} fill="#34d399" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                              Rf {sp.rf.toFixed(2)}
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
                                      {/* Detected Peak Apex Dots */}
                                      {d.spots.map((sp, idx) => {
                                        const y = ph - sp.pos;
                                        const pt = pts[sp.pos];
                                        const x = 40 + Math.min(230, ((pt?.signal || 0) / d.maxSignal) * 230);
                                        return (
                                          <g key={idx}>
                                            <circle cx={x} cy={y} r="3.5" fill="#c084fc" stroke="#ffffff" strokeWidth="1" />
                                            <text x={Math.min(270, x + 6)} y={y + 3} fill="#c084fc" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                              Rf {sp.rf.toFixed(2)}
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
                                        return (
                                          <g key={idx}>
                                            <circle cx={x} cy={y} r="3.5" fill="#fbbf24" stroke="#ffffff" strokeWidth="1" />
                                            <text x={Math.min(270, x + 6)} y={y + 3} fill="#fbbf24" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                              Rf {sp.rf.toFixed(2)}
                                            </text>
                                          </g>
                                        );
                                      })}
                                    </g>
                                  );
                                })()}

                              {/* Synchronized Hover Crosshair on Densitometer */}
                              {hoverY !== null && (
                                <line
                                  x1="0"
                                  y1={hoverY}
                                  x2="320"
                                  y2={hoverY}
                                  stroke={hoverSpot ? '#f43f5e' : '#38bdf8'}
                                  strokeWidth="1.5"
                                  strokeDasharray="3,3"
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }}>
                        Chromatographic Peak Deconvolution &amp; Resolution:
                      </span>
                      {activeDens?.spots.length ? (
                        <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                          {activeDens.spots.length} peak{activeDens.spots.length === 1 ? '' : 's'} identified
                        </span>
                      ) : null}
                    </div>

                    {activeDens?.spots.length ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                          {activeDens.spots.map((sp, idx) => (
                            <span
                              key={idx}
                              className="chip"
                              style={{
                                background: '#fdf2f8',
                                color: '#be185d',
                                border: '1px solid #fbcfe8',
                                fontWeight: 600,
                                fontSize: '12px',
                              }}
                            >
                              Peak {idx + 1}: Rf {sp.rf.toFixed(2)}
                              <span style={{ marginLeft: '6px', fontSize: '10px', color: '#9d174d', textTransform: 'capitalize' }}>
                                ({sp.strength > 0.5 ? 'strong' : sp.strength > 0.2 ? 'medium' : 'weak'} · {sp.areaPct || 0}% area)
                              </span>
                            </span>
                          ))}
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
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: 'var(--mut)' }}>
                        No peaks detected above noise threshold.
                      </div>
                    )}
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
                <p style={{ textAlign: 'center', padding: '24px 0', color: 'var(--mut)' }}>
                  No lane image available for this well yet. Load a lane CSV and plate images above.
                </p>
              )}
            </div>

            <div className="modal-foot">
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
