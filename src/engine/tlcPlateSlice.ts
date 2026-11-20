// Robowski Studio - Per-Plate TLC State Slicing, Storage Key Mapping & Serialization
import { TlcPlateData, TlcSet } from '../types';
import { LANE_FRAME_WIDTH } from './tlcLanes';

export function emptyTlcPlateData(frameW: number = LANE_FRAME_WIDTH): TlcPlateData {
  return {
    cfg: null,
    cfgName: '',
    frameW,
    frontPx: null,
    frontAuto: {},
    frontAutoByLane: {},
    originPx: null,
    originAuto: {},
    imgs: {},
    preRunImgs: {},
    preRunEnabled: true,
  };
}

/**
 * IndexedDB / .robowski storage key for a (channel, plateIndex) pair.
 * Plate 1 (index 0) uses bare channel names ('UV254', 'UV366', 'White') for full backwards compatibility.
 * Plates 2+ (index > 0) use 'p1_UV254', 'p2_UV366', etc. (no double-underscore so archive splitting on '__' stays exact).
 */
export function tlcStorageKey(channel: string, plateIndex: number = 0): string {
  const p = Math.max(0, Math.floor(plateIndex || 0));
  return p === 0 ? channel : `p${p}_${channel}`;
}

export function tlcPreRunStorageKey(channel: string, plateIndex: number = 0): string {
  const p = Math.max(0, Math.floor(plateIndex || 0));
  return p === 0 ? `pre_${channel}` : `p${p}_pre_${channel}`;
}

export function parseTlcStorageKey(storageKey: string): {
  plateIndex: number;
  channel: string;
  isPreRun: boolean;
} {
  const raw = String(storageKey || '');
  const mp = /^p(\d+)_pre_(.+)$/.exec(raw);
  if (mp) {
    return { plateIndex: parseInt(mp[1], 10), channel: mp[2], isPreRun: true };
  }
  const p0Pre = /^pre_(.+)$/.exec(raw);
  if (p0Pre) {
    return { plateIndex: 0, channel: p0Pre[1], isPreRun: true };
  }
  const m = /^p(\d+)_(.+)$/.exec(raw);
  if (m) {
    return { plateIndex: parseInt(m[1], 10), channel: m[2], isPreRun: false };
  }
  return { plateIndex: 0, channel: raw, isPreRun: false };
}

/**
 * Returns a view of `set` scoped to `plateIndex` (0 = Plate 1, 1 = Plate 2, 2 = Plate 3).
 * Plate 0 returns top-level fields; Plate > 0 reads `set.plateData?.[plateIndex]`.
 */
export function getTlcPlateSlice(set: TlcSet, plateIndex: number = 0): TlcSet {
  const p = Math.max(0, Math.floor(plateIndex || 0));
  if (p === 0) return set;

  const existing = set.plateData?.[p];
  if (!existing) {
    return {
      uid: set.uid,
      name: set.name,
      ...emptyTlcPlateData(set.frameW || LANE_FRAME_WIDTH),
    };
  }
  return {
    uid: set.uid,
    name: set.name,
    ...existing,
  };
}

/**
 * Immutably updates the plate slice `plateIndex` inside `set`.
 */
export function updateTlcPlateSlice(
  set: TlcSet,
  plateIndex: number,
  patch: Partial<TlcPlateData> | ((cur: TlcPlateData) => Partial<TlcPlateData>)
): TlcSet {
  const p = Math.max(0, Math.floor(plateIndex || 0));
  const curSlice = getTlcPlateSlice(set, p);
  const resolved = typeof patch === 'function' ? patch(curSlice) : patch;

  if (p === 0) {
    return { ...set, ...resolved };
  }

  const prevPlate = set.plateData?.[p] || emptyTlcPlateData(set.frameW || LANE_FRAME_WIDTH);
  return {
    ...set,
    plateData: {
      ...(set.plateData || {}),
      [p]: {
        ...prevPlate,
        ...resolved,
      },
    },
  };
}

export function tlcSetPlateImageCount(set: TlcSet, plateIndex: number = 0): number {
  const slice = getTlcPlateSlice(set, plateIndex);
  return Object.values(slice.imgs || {}).filter((im) => Boolean(im?.bmp || im?.name)).length;
}

export function tlcSetPlateHasImages(set: TlcSet, plateIndex: number = 0): boolean {
  return tlcSetPlateImageCount(set, plateIndex) > 0;
}

export function tlcSetHasAnyImages(set: TlcSet): boolean {
  if (Object.values(set.imgs || {}).some((im) => Boolean(im?.bmp || im?.name))) {
    return true;
  }
  if (set.plateData) {
    for (const pd of Object.values(set.plateData)) {
      if (pd?.imgs && Object.values(pd.imgs).some((im) => Boolean(im?.bmp || im?.name))) {
        return true;
      }
    }
  }
  return false;
}

export function getAllTlcImageKeysForSet(set: TlcSet): string[] {
  const keys: string[] = [];
  for (const ch of Object.keys(set.imgs || {})) {
    keys.push(tlcStorageKey(ch, 0));
  }
  for (const ch of Object.keys(set.preRunImgs || {})) {
    keys.push(tlcPreRunStorageKey(ch, 0));
  }
  if (set.plateData) {
    for (const [pStr, pd] of Object.entries(set.plateData)) {
      const p = Number(pStr);
      if (!Number.isFinite(p) || p <= 0 || !pd) continue;
      for (const ch of Object.keys(pd.imgs || {})) {
        keys.push(tlcStorageKey(ch, p));
      }
      for (const ch of Object.keys(pd.preRunImgs || {})) {
        keys.push(tlcPreRunStorageKey(ch, p));
      }
    }
  }
  return keys;
}

function serializePlateData(pd: TlcPlateData, defaultProminence?: number) {
  return {
    cfg: pd.cfg ?? null,
    cfgName: pd.cfgName || '',
    cfgText: pd.cfgText,
    frameW: pd.frameW || LANE_FRAME_WIDTH,
    frontPx: pd.frontPx ?? null,
    frontHalfPx: pd.frontHalfPx,
    frontAuto: pd.frontAuto || {},
    frontAutoByLane: pd.frontAutoByLane || {},
    originPx: pd.originPx ?? null,
    originAuto: pd.originAuto || {},
    originAutoByLane: pd.originAutoByLane || {},
    edgePicks: pd.edgePicks || [],
    edgeSettings: pd.edgeSettings || {},
    spotProminence: pd.spotProminence ?? defaultProminence,
    ...(pd.spotDetectorMode ? { spotDetectorMode: pd.spotDetectorMode } : {}),
    imgMeta: Object.entries(pd.imgs || {}).map(([k, im]) => ({
      key: k,
      name: im.name,
    })),
    preRunEnabled: pd.preRunEnabled !== false,
    preRunImgMeta: Object.entries(pd.preRunImgs || {}).map(([k, im]) => ({
      key: k,
      name: im.name,
    })),
  };
}

function deserializePlateData(raw: any): TlcPlateData {
  return {
    cfg: raw?.cfg ?? null,
    cfgName: raw?.cfgName || '',
    cfgText: raw?.cfgText,
    frameW: raw?.frameW || LANE_FRAME_WIDTH,
    frontPx: raw?.frontPx ?? null,
    frontHalfPx: raw?.frontHalfPx,
    frontAuto: raw?.frontAuto || {},
    frontAutoByLane: raw?.frontAutoByLane || {},
    originPx: raw?.originPx ?? null,
    originAuto: raw?.originAuto || {},
    originAutoByLane: raw?.originAutoByLane || {},
    edgePicks: raw?.edgePicks || [],
    edgeSettings: raw?.edgeSettings || {},
    spotProminence: raw?.spotProminence,
    spotDetectorMode: raw?.spotDetectorMode === '1d' ? '1d' : raw?.spotDetectorMode === '2d' ? '2d' : undefined,
    imgs: {},
    preRunImgs: {},
    preRunEnabled: raw?.preRunEnabled !== false,
    prof: {},
  };
}

/**
 * Strips non-serializable ImageBitmap instances while keeping all per-plate metadata.
 */
export function serializeTlcSet(s: TlcSet, defaultProminence?: number) {
  const plateDataOut: Record<number, ReturnType<typeof serializePlateData>> = {};
  if (s.plateData) {
    for (const [pStr, pd] of Object.entries(s.plateData)) {
      const p = Number(pStr);
      if (Number.isFinite(p) && p > 0 && pd) {
        plateDataOut[p] = serializePlateData(pd, defaultProminence);
      }
    }
  }
  return {
    uid: s.uid,
    name: s.name,
    ...serializePlateData(s, defaultProminence),
    ...(Object.keys(plateDataOut).length > 0 ? { plateData: plateDataOut } : {}),
  };
}

export function deserializeTlcSetMeta(raw: any): TlcSet {
  const plateData: Record<number, TlcPlateData> = {};
  if (raw?.plateData && typeof raw.plateData === 'object') {
    for (const [pStr, pd] of Object.entries(raw.plateData)) {
      const p = Number(pStr);
      if (Number.isFinite(p) && p > 0 && pd) {
        plateData[p] = deserializePlateData(pd);
      }
    }
  }
  return {
    uid: raw.uid,
    name: raw.name,
    ...deserializePlateData(raw),
    ...(Object.keys(plateData).length > 0 ? { plateData } : {}),
  };
}

function hasAnyImgBitmapOrMeta(s: TlcSet | null | undefined): boolean {
  if (!s?.imgs) return false;
  return Object.values(s.imgs).some((im) => Boolean(im?.bmp));
}

function hasCustomSpots(s: TlcSet | null | undefined): boolean {
  return Boolean(s?.cfg?.lanes?.some((l) => l.customSpots && l.customSpots.length > 0));
}

/**
 * Resolves the appropriate sliced TlcSet for a given plateIndex across all solvent sets.
 * Handles both multi-plate-per-set (new) and 1-tab-per-plate (legacy workaround) setups.
 */
export function resolveTlcSetForPlate(
  tlcSets: TlcSet[] | undefined,
  plateIndex: number
): TlcSet | null {
  if (!tlcSets || tlcSets.length === 0) return null;
  const p = Math.max(0, Math.floor(plateIndex || 0));

  // 1. Prefer a set whose slice for `p` has both loaded plate images AND a lane config
  for (const s of tlcSets) {
    const slice = getTlcPlateSlice(s, p);
    if (hasAnyImgBitmapOrMeta(slice) && slice.cfg?.lanes?.length) {
      return slice;
    }
  }

  // 2. Otherwise any set whose slice for `p` has images or manually curated spots
  for (const s of tlcSets) {
    const slice = getTlcPlateSlice(s, p);
    if (hasAnyImgBitmapOrMeta(slice) || hasCustomSpots(slice)) {
      return slice;
    }
  }

  // 3. Legacy fallback: user created separate tabs (Set 2 = Plate 2, Set 3 = Plate 3) with Plate 0 images
  if (p > 0 && tlcSets[p]) {
    if (hasAnyImgBitmapOrMeta(tlcSets[p]) || hasCustomSpots(tlcSets[p])) {
      return tlcSets[p];
    }
  }

  // 4. Default to Plate `p` slice of first set
  return getTlcPlateSlice(tlcSets[0], p);
}
