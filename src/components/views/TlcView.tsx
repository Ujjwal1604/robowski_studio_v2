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
  tlcRfCsv,
  createDefaultLaneConfig,
  createDemoTlcDataSet,
} from '../../engine';
import {
  TlcSet,
  TlcLane,
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
    imgs: {},
  };
}

function tlcKeyOf(name: string, set: TlcSet): TlcChannelKey | null {
  if (/254/.test(name)) return 'UV254';
  if (/36[56]|uv.?3/i.test(name)) return 'UV366';
  if (/white|visible|vis\b|day/i.test(name)) return 'White';
  return (TLC_KEYS as TlcChannelKey[]).find((k) => !set.imgs[k]) || null;
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

    if (filters) {
      const parts = [];
      if (filters.invert) parts.push('invert(1)');
      if (filters.brightness !== 100) parts.push(`brightness(${filters.brightness}%)`);
      if (filters.contrast !== 100) parts.push(`contrast(${filters.contrast}%)`);
      ctx.filter = parts.length ? parts.join(' ') : 'none';
    }

    ctx.drawImage(im.bmp, 0, 0);
    ctx.filter = 'none';
    ctx.restore();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Yellow ticks where spot origin was applied (Rf = 0)
    if (l.zeroRf != null) {
      ctx.strokeStyle = '#FFC857';
      ctx.lineWidth = 1.5;
      const y = top + k * (l.length - l.zeroRf);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 5, y);
      ctx.moveTo(x + w - 5, y);
      ctx.lineTo(x + w, y);
      ctx.stroke();
    }

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
      style={{ textAlign: 'left' }}
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
            fontSize: '10px',
            fontFamily: 'monospace',
            color: '#ec4899',
            marginTop: '2px',
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
          {primarySpots.length
            ? primarySpots
                .slice(0, 3)
                .map((s) => `Rf ${s.rf.toFixed(2)}`)
                .join(' · ')
            : 'Rf —'}
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
  const [fullPlateChannel, setFullPlateChannel] = useState<TlcChannelKey>('UV254');

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
      let key = tlcKeyOf(f.name, currentSet);
      if (!key) {
        // Fallback: assign to first unoccupied channel, or default to UV254
        key = !newImgs.UV254 ? 'UV254' : !newImgs.UV366 ? 'UV366' : !newImgs.White ? 'White' : 'UV254';
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
        const s = next[cur];
        let cfg = s.cfg;
        let cfgName = s.cfgName;
        // Auto-assign standard 54-lane grid if no lane configuration has been uploaded yet!
        if (!cfg) {
          const frameW = s.frameW || LANE_FRAME_WIDTH;
          cfg = createDefaultLaneConfig(frameW, 'two-tier');
          cfgName = 'Standard 6×9 Grid (Auto)';
        }
        next[cur] = {
          ...s,
          cfg,
          cfgName,
          imgs: newImgs,
          prof: {},
          frontAuto: {},
        };
        return next;
      });
      setShow((prev) => ({ ...prev, UV254: true, UV366: true, White: true }));
      toast(`Loaded ${loadedCount} plate image${loadedCount === 1 ? '' : 's'}. Standard 54-lane grid activated.`);
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

  // Load Synthetic Demo TLC Plate (UV 254 nm & 365 nm)
  const handleLoadDemoTlc = async () => {
    try {
      toast('Generating realistic demonstration TLC plate…');
      const demo = await createDemoTlcDataSet();
      const uv254Bmp = await createImageBitmap(demo.uv254Blob);
      const uv366Bmp = await createImageBitmap(demo.uv366Blob);

      // Persist to IndexedDB
      await putTlcImage(currentSet.uid, 'UV254', 'demo_plate_UV254.png', demo.uv254Blob);
      await putTlcImage(currentSet.uid, 'UV366', 'demo_plate_UV366.png', demo.uv366Blob);

      setSets((prev) => {
        const next = [...prev];
        next[cur] = {
          ...next[cur],
          cfg: demo.config,
          cfgName: demo.configName,
          frameW: 2400,
          imgs: {
            UV254: { name: 'demo_plate_UV254.png', bmp: uv254Bmp },
            UV366: { name: 'demo_plate_UV366.png', bmp: uv366Bmp },
          },
          prof: {},
          frontAuto: {},
        };
        return next;
      });
      setShow((prev) => ({ ...prev, UV254: true, UV366: true }));
      setFullPlateChannel('UV254');
      toast('Loaded sample TLC plate (UV 254 nm & 365 nm) with 54-lane grid!');
    } catch (err: any) {
      toast('Could not generate demo TLC plate: ' + (err.message || err));
    }
  };

  // Add new TLC Set
  const handleAddSet = () => {
    setSets((prev) => [...prev, tlcNewSet(prev.length + 1)]);
    setCur(sets.length);
  };

  // Remove current TLC Set
  const handleRemoveSet = () => {
    if (sets.length <= 1) return;
    const removedSet = currentSet;
    Object.values(removedSet.imgs).forEach((im) => im.bmp?.close && im.bmp.close());
    deleteTlcSetImages(removedSet.uid, Object.keys(removedSet.imgs));
    setSets((prev) => prev.filter((_, i) => i !== cur));
    setCur((prev) => Math.max(0, prev - 1));
    if (sets.length - 1 < 2) setCompare(false);
    toast(`Removed "${removedSet.name}".`);
  };

  // Get Spots helper for a set, channel, and lane with center-weighted core sampling
  const getSpotsForLane = useCallback(
    (set: TlcSet, key: TlcChannelKey, lane: TlcLane): TlcSpot[] | null => {
      if (lane.zeroRf == null || !set.imgs[key]) return null;
      const prof = extractLaneProfile(set, key, lane, coreFraction);
      if (!prof.length) return null;
      const front = tlcFront(set, lane, (s, k, l) => extractLaneProfile(s, k, l, coreFraction));
      return findSpots(prof, {
        sign: TLC_SIGNAL[key].sign,
        origin: lane.zeroRf,
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

  // Memoized panels for all 54 wells in the plate grid
  const allPanels = useMemo(() => {
    return Array.from({ length: 54 }, (_, wellIndex) => {
      const laneId = tlcLane(wellIndex, 'column');
      return getPanelsForLane(laneId);
    });
  }, [getPanelsForLane]);

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

      if (primary && primary.lane.zeroRf != null) {
        const s = primary.s;
        const l = primary.lane;
        const front = tlcFront(s, l, (st, k, ln) => extractLaneProfile(st, k, ln, coreFraction));

        for (const k of TLC_KEYS) {
          if (s.imgs[k]) {
            const prof = extractLaneProfile(s, k, l, coreFraction);
            newDens[k] = extractDensitogram(prof, {
              sign: TLC_SIGNAL[k].sign,
              origin: l.zeroRf,
              front,
              radius: l.spotRadius || 24,
            });
          }
        }
      }
      setChannelDensitograms(newDens);
    }
  }, [inspectWell, inspectPanels, filters, markSpots, coreFraction]);

  // Handle Mouse Move on Enlarged Canvas or Densitometer with Intelligent Peak Snapping
  const handleCanvasMouseMove = (e: React.MouseEvent<any>) => {
    if (!bigCanvasRef.current || inspectPanels.length === 0) return;
    const rect = bigCanvasRef.current.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const primary = inspectPanels[0];
    const l = primary.lane;
    const ph = 1.0 * l.length;
    const zeroDist = l.zeroRf != null ? l.zeroRf : 0;
    const frontPos = tlcFront(primary.s, l, (s, k, ln) => extractLaneProfile(s, k, ln, coreFraction));
    const span = Math.max(1, frontPos - zeroDist);

    // Unconstrained pos from bottom (0 = bottom, ph = top)
    const rawPos = ph - mouseY;

    // Check if cursor is within 16px of a detected spot apex
    const spots = primary.spots || [];
    const nearSpot = spots.find((sp) => Math.abs(sp.pos - rawPos) <= 16);

    let activePos = rawPos;
    let activeSpot: TlcSpot | null = null;

    if (nearSpot) {
      activePos = nearSpot.pos;
      activeSpot = nearSpot;
    } else {
      // Local maximum check in profile within ±10 px
      const prof = extractLaneProfile(primary.s, primary.key, l, coreFraction);
      const sg = TLC_SIGNAL[primary.key].sign;
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

    const calculatedRf = Math.max(0, Math.min(1, (activePos - zeroDist) / span));
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
      const csvContent = tlcRfCsv(sets, run, getSpotsForLane, plate);
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
              optical densitograms, solvent front meniscuses, retention factors ($R_f$), and
              separation resolution ($\Delta R_f$) with edge-bleed suppression.
            </p>
          </div>

          {hasConfig && currentSet.cfg?.hasZeroRf && (
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
            <button
              key={x.uid}
              type="button"
              className={`tlcsetbtn ${i === cur ? 'on' : ''}`}
              onClick={() => setCur(i)}
              aria-pressed={i === cur}
            >
              {isMultiSet ? <b>{tlcLetter(i)} </b> : null}
              {x.name}
            </button>
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

          {isMultiSet && (
            <button type="button" className="btn sm bad" onClick={handleRemoveSet}>
              Remove Set
            </button>
          )}

          <div style={{ height: '20px', width: '1px', background: 'var(--line)', margin: '0 4px' }} />

          <button
            type="button"
            className="btn"
            onClick={handleApplyDefaultGrid}
            title="Auto-apply standard 54-lane two-tier TLC grid (27 + 27 lanes) without needing a custom CSV file"
          >
            Auto 6×9 Grid
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
              {currentSet.cfg?.hasZeroRf ? ' · microadjusted' : ''}
            </span>
          ) : (
            <span className="chip warn" style={{ fontSize: '11px' }}>
              ⚠️ No lane CSV loaded yet
            </span>
          )}

          {hasConfig && !currentSet.cfg?.hasZeroRf && (
            <span className="chip warn" style={{ fontSize: '11px' }} title="Rf calculations need the px_location_of_zero_rf column">
              ⚠️ Rf calculation requires microadjusted lane CSV with spot origin
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
                // Clear cached profiles to recompute with new core corridor
                setSets((prev) =>
                  prev.map((s) => ({
                    ...s,
                    prof: {},
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
              setSets((prev) => prev.map((s) => ({ ...s, prof: {} })));
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
                  style={{ width: '100px' }}
                  value={currentSet.frameW || LANE_FRAME_WIDTH}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 100) {
                      setSets((prev) => {
                        const next = [...prev];
                        next[cur] = { ...next[cur], frameW: v, prof: {} };
                        return next;
                      });
                    }
                  }}
                />
              </label>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span>Manual Solvent Front (px from lane start):</span>
                <input
                  type="number"
                  className="f mono"
                  style={{ width: '100px' }}
                  placeholder="auto"
                  value={currentSet.frontPx || ''}
                  onChange={(e) => {
                    const v = e.target.value ? parseInt(e.target.value, 10) : null;
                    setSets((prev) => {
                      const next = [...prev];
                      next[cur] = { ...next[cur], frontPx: v > 0 ? v : null, prof: {} };
                      return next;
                    });
                  }}
                />
              </label>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
              Leave blank to automatically detect the solvent front from the UV 365 nm liquid meniscus peak in the upper 30% of each lane.
              {currentSet.cfg && currentSet.imgs.UV366 && !currentSet.frontPx && (
                <span style={{ color: 'var(--pri)', marginLeft: '6px' }}>
                  (Auto-detected front: {tlcFront(currentSet, currentSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction))} px for first half,{' '}
                  {tlcFront(currentSet, currentSet.cfg.lanes.find((l) => l.id >= 27) || currentSet.cfg.lanes[0], (s, k, l) => extractLaneProfile(s, k, l, coreFraction))} px for second half)
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
              maxWidth: '1020px',
              width: '95%',
              maxHeight: '94vh',
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

                  {/* Main Visualizer: Side-by-Side TLC Strip & Pixel-Matched Parallel Densitometer */}
                  <div
                    style={{
                      display: 'flex',
                      gap: '0px',
                      justifyContent: 'center',
                      alignItems: 'stretch',
                      background: '#090d0c',
                      padding: '24px 20px',
                      borderRadius: '8px',
                      overflowX: 'auto',
                    }}
                  >
                    {/* Enlarged Physical TLC Canvas */}
                    <div style={{ position: 'relative', display: 'inline-block' }}>
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
                        }}
                      />

                      {/* Live Cursor Crosshair Bar across lane */}
                      {hoverY !== null && (
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: `${hoverY + 18}px`, // +18 for title header
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
                            top: `${m.y + 18}px`,
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
                          const originY = ph - (l.zeroRf != null ? l.zeroRf : 0);
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
