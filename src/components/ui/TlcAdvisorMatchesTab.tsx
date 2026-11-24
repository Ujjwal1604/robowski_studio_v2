import React, { useEffect, useMemo, useState } from 'react';
import {
  ALL_KNOWN_SOLVENT_SYSTEMS,
  CalibratedLaneComparison,
  CalibratedPlateSummary,
  getTlcPlateSlice,
  PredictionTier,
  TlcCalibrationModel,
  TlcChannelKey,
  tlcLane,
  wellLabel,
} from '../../engine';
import { TlcLane, TlcSet } from '../../types';
import { ChemicalStructure } from './ChemicalStructure';
import { CompareLaneThumb } from './CompareLaneThumb';

interface TlcAdvisorMatchesTabProps {
  calibrationModel: TlcCalibrationModel | null;
  tlcSets: TlcSet[];
  plateLoading: boolean;
  setSolventOverrides: Record<string, string>;
  onSetSolventOverride: (key: string, solventId: string) => void;
  onInspectWellInTlc: (args: { setUid: string; plateIndex: number; wellIndex: number }) => void;
  onSwitchToOptimizer: () => void;
  toast: (msg: string) => void;
}

type MatchStatus = 'found' | 'coeluted' | 'inconsistent' | 'front_saturated' | 'baseline_pinned' | 'missing';
type FilterMode = 'all' | 'products_found' | 'reactants_found' | 'coeluted' | 'inconsistent' | 'boundary' | 'missing';
type SortMode = 'found_wells' | 'products_first' | 'rf_asc' | 'shift_desc';

const ALL_PLATES_KEY = '__ALL__';

interface PerPlateWellEvidence {
  plateKey: string;
  setUid: string;
  plateIndex: number;
  setName: string;
  solventName: string;
  status: MatchStatus;
  rfBefore: number;
  rfAfter: number;
  matchedObsRf?: number;
  matchMethod?: 'consensus' | 'per_well';
  coelutedWith?: string[];
  conflictPlates?: string[];
  spotStrength?: number;
  spotTailing?: number;
}

interface CompoundWellEntry {
  wellIndex: number;
  wellCoord: string;
  laneNumber: number;
  status: MatchStatus;
  rfBefore: number;
  rfAfter: number;
  matchedObsRf?: number;
  matchMethod?: 'consensus' | 'per_well';
  coelutedWith?: string[];
  conflictPlates?: string[];
  tier?: PredictionTier;
  spotStrength?: number;
  spotTailing?: number;
  bestPlateKey: string;
  bestSolventName: string;
  bestSetName: string;
  resolvedSystemCount: number;
  perPlate: PerPlateWellEvidence[];
}

interface SystemHitSummary {
  plateKey: string;
  setName: string;
  solventName: string;
  wellsFound: number;
  obsRfMean: number | null;
  matchMethod: 'consensus' | 'per_well';
}

interface CompoundMatchRecord {
  key: string;
  label: string;
  smiles?: string;
  kind: 'substrate' | 'product';
  bestTier?: PredictionTier;
  wells: CompoundWellEntry[];
  wellsByIndex: Map<number, CompoundWellEntry>;
  foundCount: number;
  coelutedCount: number;
  inconsistentCount: number;
  frontCount: number;
  baselineCount: number;
  missingCount: number;
  totalWells: number;
  observedRfMean: number | null;
  observedRfSpread: number;
  predRfBeforeMean: number;
  predRfAfterMean: number;
  rfShift: number | null;
  matchMethod: 'consensus' | 'per_well' | 'none';
  statusBucket: 'found' | 'coeluted' | 'inconsistent' | 'boundary' | 'missing';
  resolvedBySystem: SystemHitSummary[];
}

const TIER_RANK: Record<string, number> = { High: 4, Medium: 3, Low: 2, Speculative: 1 };
const STATUS_PRIORITY: Record<MatchStatus, number> = {
  found: 5,
  coeluted: 4,
  inconsistent: 3,
  front_saturated: 2,
  baseline_pinned: 2,
  missing: 1,
};
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F'];
const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function plateKeyOf(p: CalibratedPlateSummary): string {
  return `${p.setUid}::${p.plateIndex}`;
}

function evidenceRank(ev: PerPlateWellEvidence): number {
  let score = STATUS_PRIORITY[ev.status] * 100;
  if (ev.status === 'found') {
    if (ev.matchMethod === 'consensus') score += 30;
    if (ev.matchedObsRf !== undefined) {
      // Prefer mid-plate resolved spots (closest to Rf 0.45) over near-boundary spots
      score += Math.max(0, 20 - Math.abs(ev.matchedObsRf - 0.45) * 35);
    }
  }
  return score;
}

function statusMeta(status: MatchStatus): {
  label: string;
  short: string;
  fg: string;
  bg: string;
  border: string;
} {
  switch (status) {
    case 'found':
      return {
        label: 'Found on TLC',
        short: 'Found',
        fg: '#10b981',
        bg: 'rgba(16, 185, 129, 0.14)',
        border: 'rgba(16, 185, 129, 0.45)',
      };
    case 'coeluted':
      return {
        label: 'Co-elutes / Ambiguous',
        short: 'Co-elutes',
        fg: '#8b5cf6',
        bg: 'rgba(139, 92, 246, 0.14)',
        border: 'rgba(139, 92, 246, 0.48)',
      };
    case 'inconsistent':
      return {
        label: 'Cross-Plate Conflict',
        short: 'Conflict',
        fg: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.13)',
        border: 'rgba(239, 68, 68, 0.48)',
      };
    case 'front_saturated':
      return {
        label: 'At Solvent Front',
        short: 'Front',
        fg: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.14)',
        border: 'rgba(56, 189, 248, 0.45)',
      };
    case 'baseline_pinned':
      return {
        label: 'Pinned at Baseline',
        short: 'Baseline',
        fg: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.14)',
        border: 'rgba(245, 158, 11, 0.45)',
      };
    default:
      return {
        label: 'Not Seen / Consumed',
        short: 'Not seen',
        fg: 'var(--mut)',
        bg: 'rgba(148, 163, 184, 0.08)',
        border: 'var(--line)',
      };
  }
}

function tierBadgeStyle(tier?: PredictionTier): {
  label: string;
  fg: string;
  bg: string;
  border: string;
} | null {
  if (tier === 'High') {
    return {
      label: 'High tier',
      fg: '#10b981',
      bg: 'rgba(16, 185, 129, 0.12)',
      border: 'rgba(16, 185, 129, 0.35)',
    };
  }
  if (tier === 'Medium') {
    return {
      label: 'Med tier',
      fg: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.12)',
      border: 'rgba(56, 189, 248, 0.35)',
    };
  }
  if (tier === 'Low') {
    return {
      label: 'Low tier',
      fg: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.35)',
    };
  }
  if (tier === 'Speculative') {
    return {
      label: 'Speculative',
      fg: 'var(--mut)',
      bg: 'rgba(148, 163, 184, 0.12)',
      border: 'var(--line)',
    };
  }
  return null;
}

export const TlcAdvisorMatchesTab: React.FC<TlcAdvisorMatchesTabProps> = ({
  calibrationModel,
  tlcSets,
  plateLoading,
  setSolventOverrides,
  onSetSolventOverride,
  onInspectWellInTlc,
  onSwitchToOptimizer,
  toast,
}) => {
  const plates = calibrationModel?.plates || [];
  const unmatchedSets = calibrationModel?.unmatchedSets || [];

  const [selectedPlateKey, setSelectedPlateKey] = useState<string>('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('found_wells');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCompoundKey, setSelectedCompoundKey] = useState<string>('');
  const [selectedWellIndex, setSelectedWellIndex] = useState<number | null>(null);
  const [inspectedPlateKey, setInspectedPlateKey] = useState<string>('');
  const [channelMode, setChannelMode] = useState<'composite' | TlcChannelKey>('UV254');

  // Default to ALL uploaded solvent systems when >= 2 plates are matched; single plate when 1 is matched
  useEffect(() => {
    if (!plates.length) {
      setSelectedPlateKey('');
      return;
    }
    if (plates.length >= 2) {
      if (
        !selectedPlateKey ||
        (selectedPlateKey !== ALL_PLATES_KEY && !plates.some((p) => plateKeyOf(p) === selectedPlateKey))
      ) {
        setSelectedPlateKey(ALL_PLATES_KEY);
      }
    } else {
      const onlyKey = plateKeyOf(plates[0]);
      if (selectedPlateKey !== onlyKey) {
        setSelectedPlateKey(onlyKey);
      }
    }
  }, [plates, selectedPlateKey]);

  const isCombinedAllMode = selectedPlateKey === ALL_PLATES_KEY && plates.length >= 2;

  const scopedPlates: CalibratedPlateSummary[] = useMemo(() => {
    if (!plates.length) return [];
    if (selectedPlateKey === ALL_PLATES_KEY && plates.length >= 2) return plates;
    const found = plates.find((p) => plateKeyOf(p) === selectedPlateKey);
    return found ? [found] : [plates[0]];
  }, [plates, selectedPlateKey]);

  const plateByKey = useMemo(() => {
    const m = new Map<string, CalibratedPlateSummary>();
    for (const p of plates) m.set(plateKeyOf(p), p);
    return m;
  }, [plates]);

  // Identify uploaded TLC tabs that aren't in `plates` or `unmatchedSets` (e.g., no lanes/spots yet or ignored)
  const skippedUploadedSets = useMemo(() => {
    const matchedUids = new Set(plates.map((p) => p.setUid));
    const unmatchedUids = new Set(unmatchedSets.map((u) => u.uid));
    return (tlcSets || [])
      .filter((s) => !matchedUids.has(s.uid) && !unmatchedUids.has(s.uid))
      .map((s) => {
        const hasImgs = Boolean(
          s.imgs?.UV254?.bmp || s.imgs?.UV366?.bmp || s.imgs?.White?.bmp || Object.keys(s.plateData || {}).length > 0
        );
        const hasLanes = Boolean(s.cfg?.lanes && s.cfg.lanes.length > 0);
        const overrideKey = `${s.uid}:0`;
        const isIgnored =
          setSolventOverrides[overrideKey] === 'ignore' || setSolventOverrides[s.uid] === 'ignore';
        return {
          uid: s.uid,
          name: s.name,
          overrideKey,
          hasImgs,
          hasLanes,
          isIgnored,
        };
      })
      .filter((x) => x.hasImgs || x.hasLanes || x.isIgnored);
  }, [tlcSets, plates, unmatchedSets, setSolventOverrides]);

  // Aggregate compounds across ALL scoped uploaded plates (either all uploaded plates combined, or one chosen plate)
  const { compounds, lanesByPlateAndWell, kpis } = useMemo(() => {
    const laneLookup = new Map<string, Map<number, CalibratedLaneComparison>>();
    const compMap = new Map<
      string,
      {
        key: string;
        label: string;
        smiles?: string;
        kind: 'substrate' | 'product';
        bestTier?: PredictionTier;
        wellsMap: Map<
          number,
          {
            wellIndex: number;
            wellCoord: string;
            laneNumber: number;
            tier?: PredictionTier;
            perPlate: PerPlateWellEvidence[];
          }
        >;
      }
    >();

    if (!scopedPlates.length) {
      return {
        compounds: [] as CompoundMatchRecord[],
        lanesByPlateAndWell: laneLookup,
        kpis: {
          reactantsFound: 0,
          reactantsTotal: 0,
          productsFound: 0,
          productsTotal: 0,
          productsHighMedFound: 0,
          wellsWithMatches: 0,
          nonBlankWells: 0,
          unmatchedSpotCount: 0,
          unmatchedSpotWells: 0,
          totalPairedSpots: 0,
        },
      };
    }

    const nonBlankWellSet = new Set<number>();
    const wellsWithMatchSet = new Set<number>();
    const wellsWithUnmatchedSpotSet = new Set<number>();
    let unmatchedSpotCount = 0;
    let totalPairedSpots = 0;

    for (const plate of scopedPlates) {
      const pKey = plateKeyOf(plate);
      const laneMap = new Map<number, CalibratedLaneComparison>();
      laneLookup.set(pKey, laneMap);
      totalPairedSpots += plate.pairedCount;

      const summaryByKey = new Map(
        (plate.compoundSummaries || []).map((cs) => [cs.compoundKey, cs])
      );

      for (const lane of plate.lanes) {
        laneMap.set(lane.wellIndex, lane);
        if (lane.isBlank) continue;
        nonBlankWellSet.add(lane.wellIndex);

        let laneHasMatch = false;
        let laneUnmatched = 0;
        for (const ms of lane.measuredSpots) {
          if (ms.matchedLabel) laneHasMatch = true;
          else laneUnmatched++;
        }
        if (laneHasMatch) wellsWithMatchSet.add(lane.wellIndex);
        if (laneUnmatched > 0) {
          unmatchedSpotCount += laneUnmatched;
          wellsWithUnmatchedSpotSet.add(lane.wellIndex);
        }

        const seenInLane = new Set<string>();
        for (const ps of lane.predictedSpots) {
          const key = ps.compoundKey || `${ps.kind}:${ps.label}`;
          if (seenInLane.has(key)) continue;
          seenInLane.add(key);

          const status: MatchStatus =
            ps.boundaryStatus || (ps.found ? 'found' : 'missing');

          let spotStrength: number | undefined;
          let spotTailing: number | undefined;
          if (
            (status === 'found' || status === 'coeluted' || status === 'inconsistent') &&
            ps.matchedObsRf !== undefined
          ) {
            let bestSpot: CalibratedLaneComparison['measuredSpots'][number] | undefined;
            let bestDist = Infinity;
            for (const ms of lane.measuredSpots) {
              const d = Math.abs(ms.rf - ps.matchedObsRf);
              if (d < bestDist && d <= 0.02) {
                bestDist = d;
                bestSpot = ms;
              }
            }
            if (bestSpot) {
              spotStrength = bestSpot.strength;
              spotTailing = bestSpot.tailing;
            }
          }

          let rec = compMap.get(key);
          if (!rec) {
            const sum = summaryByKey.get(key);
            rec = {
              key,
              label: ps.label,
              smiles: ps.smiles || sum?.smiles,
              kind: ps.kind,
              bestTier: ps.tier,
              wellsMap: new Map(),
            };
            compMap.set(key, rec);
          } else {
            if (!rec.smiles && ps.smiles) rec.smiles = ps.smiles;
            if (
              ps.tier &&
              (!rec.bestTier || (TIER_RANK[ps.tier] || 0) > (TIER_RANK[rec.bestTier] || 0))
            ) {
              rec.bestTier = ps.tier;
            }
            if (ps.kind === 'product' && rec.kind !== 'product') {
              rec.kind = 'product';
            }
          }

          let wellAgg = rec.wellsMap.get(lane.wellIndex);
          if (!wellAgg) {
            wellAgg = {
              wellIndex: lane.wellIndex,
              wellCoord: lane.wellCoord,
              laneNumber: tlcLane(lane.wellIndex) + 1,
              tier: ps.tier,
              perPlate: [],
            };
            rec.wellsMap.set(lane.wellIndex, wellAgg);
          } else if (
            ps.tier &&
            (!wellAgg.tier || (TIER_RANK[ps.tier] || 0) > (TIER_RANK[wellAgg.tier] || 0))
          ) {
            wellAgg.tier = ps.tier;
          }

          wellAgg.perPlate.push({
            plateKey: pKey,
            setUid: plate.setUid,
            plateIndex: plate.plateIndex,
            setName: plate.setName,
            solventName: plate.matchedSystemName,
            status,
            rfBefore: ps.rfBefore,
            rfAfter: ps.rfAfter,
            matchedObsRf: ps.matchedObsRf,
            matchMethod: ps.matchMethod,
            coelutedWith: ps.coelutedWith,
            conflictPlates: ps.conflictPlates,
            spotStrength,
            spotTailing,
          });
        }
      }
    }

    const records: CompoundMatchRecord[] = [];
    for (const rec of compMap.values()) {
      const wellEntries: CompoundWellEntry[] = [];
      const wellsByIndex = new Map<number, CompoundWellEntry>();
      let foundCount = 0;
      let coelutedCount = 0;
      let inconsistentCount = 0;
      let frontCount = 0;
      let baselineCount = 0;
      let missingCount = 0;

      const obsRfs: number[] = [];
      let sumPredBefore = 0;
      let sumPredAfter = 0;
      let hasConsensus = false;
      let hasPerWell = false;

      // Track per-solvent-system hit counts for this compound
      const sysHitMap = new Map<
        string,
        {
          plateKey: string;
          setName: string;
          solventName: string;
          wellsFound: number;
          obsRfs: number[];
          hasConsensus: boolean;
        }
      >();

      const sortedWellAggs = [...rec.wellsMap.values()].sort((a, b) => a.wellIndex - b.wellIndex);
      for (const wa of sortedWellAggs) {
        // Choose the best uploaded plate evidence for this well
        const ranked = [...wa.perPlate].sort((a, b) => evidenceRank(b) - evidenceRank(a));
        const best = ranked[0];
        const resolvedCountHere = wa.perPlate.filter((e) => e.status === 'found').length;

        for (const ev of wa.perPlate) {
          if (ev.status === 'found') {
            let sh = sysHitMap.get(ev.plateKey);
            if (!sh) {
              sh = {
                plateKey: ev.plateKey,
                setName: ev.setName,
                solventName: ev.solventName,
                wellsFound: 0,
                obsRfs: [],
                hasConsensus: false,
              };
              sysHitMap.set(ev.plateKey, sh);
            }
            sh.wellsFound++;
            if (ev.matchedObsRf !== undefined) sh.obsRfs.push(ev.matchedObsRf);
            if (ev.matchMethod === 'consensus') sh.hasConsensus = true;
          }
        }

        const entry: CompoundWellEntry = {
          wellIndex: wa.wellIndex,
          wellCoord: wa.wellCoord,
          laneNumber: wa.laneNumber,
          status: best.status,
          rfBefore: best.rfBefore,
          rfAfter: best.rfAfter,
          matchedObsRf: best.matchedObsRf,
          matchMethod: best.matchMethod,
          coelutedWith: best.coelutedWith,
          conflictPlates: best.conflictPlates,
          tier: wa.tier,
          spotStrength: best.spotStrength,
          spotTailing: best.spotTailing,
          bestPlateKey: best.plateKey,
          bestSolventName: best.solventName,
          bestSetName: best.setName,
          resolvedSystemCount: resolvedCountHere,
          perPlate: wa.perPlate,
        };
        wellEntries.push(entry);
        wellsByIndex.set(entry.wellIndex, entry);

        sumPredBefore += entry.rfBefore;
        sumPredAfter += entry.rfAfter;

        if (entry.status === 'found') {
          foundCount++;
          if (entry.matchedObsRf !== undefined) obsRfs.push(entry.matchedObsRf);
          if (entry.matchMethod === 'consensus') hasConsensus = true;
          else hasPerWell = true;
        } else if (entry.status === 'coeluted') {
          coelutedCount++;
        } else if (entry.status === 'inconsistent') {
          inconsistentCount++;
        } else if (entry.status === 'front_saturated') {
          frontCount++;
        } else if (entry.status === 'baseline_pinned') {
          baselineCount++;
        } else {
          missingCount++;
        }
      }

      const n = Math.max(1, wellEntries.length);
      const predRfBeforeMean = sumPredBefore / n;
      const predRfAfterMean = sumPredAfter / n;

      let observedRfMean: number | null = null;
      let observedRfSpread = 0;
      if (obsRfs.length > 0) {
        observedRfMean = obsRfs.reduce((a, b) => a + b, 0) / obsRfs.length;
        observedRfSpread = (Math.max(...obsRfs) - Math.min(...obsRfs)) / 2;
      }

      const rfShift =
        !isCombinedAllMode && observedRfMean !== null ? observedRfMean - predRfBeforeMean : null;

      const statusBucket: 'found' | 'coeluted' | 'inconsistent' | 'boundary' | 'missing' =
        foundCount > 0
          ? 'found'
          : coelutedCount > 0
          ? 'coeluted'
          : inconsistentCount > 0
          ? 'inconsistent'
          : frontCount + baselineCount > 0
          ? 'boundary'
          : 'missing';

      const resolvedBySystem: SystemHitSummary[] = [...sysHitMap.values()]
        .map((sh) => ({
          plateKey: sh.plateKey,
          setName: sh.setName,
          solventName: sh.solventName,
          wellsFound: sh.wellsFound,
          obsRfMean:
            sh.obsRfs.length > 0
              ? sh.obsRfs.reduce((a, b) => a + b, 0) / sh.obsRfs.length
              : null,
          matchMethod: sh.hasConsensus ? ('consensus' as const) : ('per_well' as const),
        }))
        .sort((a, b) => b.wellsFound - a.wellsFound);

      records.push({
        key: rec.key,
        label: rec.label,
        smiles: rec.smiles,
        kind: rec.kind,
        bestTier: rec.bestTier,
        wells: wellEntries,
        wellsByIndex,
        foundCount,
        coelutedCount,
        inconsistentCount,
        frontCount,
        baselineCount,
        missingCount,
        totalWells: wellEntries.length,
        observedRfMean,
        observedRfSpread,
        predRfBeforeMean,
        predRfAfterMean,
        rfShift,
        matchMethod: hasConsensus ? 'consensus' : hasPerWell ? 'per_well' : 'none',
        statusBucket,
        resolvedBySystem,
      });
    }

    const reactants = records.filter((r) => r.kind === 'substrate');
    const products = records.filter((r) => r.kind === 'product');
    const reactantsFound = reactants.filter((r) => r.foundCount > 0).length;
    const productsFound = products.filter((r) => r.foundCount > 0).length;
    const productsHighMedFound = products.filter(
      (r) => r.foundCount > 0 && (r.bestTier === 'High' || r.bestTier === 'Medium')
    ).length;

    return {
      compounds: records,
      lanesByPlateAndWell: laneLookup,
      kpis: {
        reactantsFound,
        reactantsTotal: reactants.length,
        productsFound,
        productsTotal: products.length,
        productsHighMedFound,
        wellsWithMatches: wellsWithMatchSet.size,
        nonBlankWells: nonBlankWellSet.size,
        unmatchedSpotCount,
        unmatchedSpotWells: wellsWithUnmatchedSpotSet.size,
        totalPairedSpots,
      },
    };
  }, [scopedPlates, isCombinedAllMode]);

  // Filter counts for segmented tabs
  const filterCounts = useMemo(() => {
    let productsFound = 0;
    let reactantsFound = 0;
    let coeluted = 0;
    let inconsistent = 0;
    let boundary = 0;
    let missing = 0;
    for (const c of compounds) {
      if (c.kind === 'product' && c.foundCount > 0) productsFound++;
      if (c.kind === 'substrate' && c.foundCount > 0) reactantsFound++;
      if (c.coelutedCount > 0) coeluted++;
      if (c.inconsistentCount > 0) inconsistent++;
      if (c.statusBucket === 'boundary') boundary++;
      if (c.statusBucket === 'missing') missing++;
    }
    return {
      all: compounds.length,
      products_found: productsFound,
      reactants_found: reactantsFound,
      coeluted,
      inconsistent,
      boundary,
      missing,
    };
  }, [compounds]);

  // Filtered + sorted compounds list
  const visibleCompounds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = compounds.filter((c) => {
      if (filterMode === 'products_found' && !(c.kind === 'product' && c.foundCount > 0)) {
        return false;
      }
      if (filterMode === 'reactants_found' && !(c.kind === 'substrate' && c.foundCount > 0)) {
        return false;
      }
      if (filterMode === 'coeluted' && c.coelutedCount === 0) {
        return false;
      }
      if (filterMode === 'inconsistent' && c.inconsistentCount === 0) {
        return false;
      }
      if (filterMode === 'boundary' && c.statusBucket !== 'boundary') {
        return false;
      }
      if (filterMode === 'missing' && c.statusBucket !== 'missing') {
        return false;
      }
      if (q) {
        const hitLabel = c.label.toLowerCase().includes(q);
        const hitSmiles = (c.smiles || '').toLowerCase().includes(q);
        const hitWell = c.wells.some(
          (w) => w.wellCoord.toLowerCase() === q || w.wellCoord.toLowerCase().includes(q)
        );
        const hitSystem = c.resolvedBySystem.some(
          (s) => s.solventName.toLowerCase().includes(q) || s.setName.toLowerCase().includes(q)
        );
        if (!hitLabel && !hitSmiles && !hitWell && !hitSystem) return false;
      }
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === 'found_wells') {
        if (b.foundCount !== a.foundCount) return b.foundCount - a.foundCount;
        if (a.statusBucket !== b.statusBucket) {
          const rank = { found: 0, coeluted: 1, inconsistent: 2, boundary: 3, missing: 4 };
          return rank[a.statusBucket] - rank[b.statusBucket];
        }
        if (a.kind !== b.kind) return a.kind === 'product' ? -1 : 1;
        return b.totalWells - a.totalWells;
      }
      if (sortMode === 'products_first') {
        if (a.kind !== b.kind) return a.kind === 'product' ? -1 : 1;
        if (b.foundCount !== a.foundCount) return b.foundCount - a.foundCount;
        const ta = TIER_RANK[a.bestTier || ''] || 0;
        const tb = TIER_RANK[b.bestTier || ''] || 0;
        if (tb !== ta) return tb - ta;
        return a.label.localeCompare(b.label);
      }
      if (sortMode === 'rf_asc') {
        const ra = a.observedRfMean ?? a.predRfAfterMean;
        const rb = b.observedRfMean ?? b.predRfAfterMean;
        return ra - rb;
      }
      const sa = a.rfShift !== null ? Math.abs(a.rfShift) : -1;
      const sb = b.rfShift !== null ? Math.abs(b.rfShift) : -1;
      if (sb !== sa) return sb - sa;
      return b.foundCount - a.foundCount;
    });
    return sorted;
  }, [compounds, filterMode, sortMode, searchQuery]);

  // Keep selectedCompoundKey valid
  useEffect(() => {
    if (!visibleCompounds.length) {
      setSelectedCompoundKey('');
      return;
    }
    if (!selectedCompoundKey || !visibleCompounds.some((c) => c.key === selectedCompoundKey)) {
      setSelectedCompoundKey(visibleCompounds[0].key);
    }
  }, [visibleCompounds, selectedCompoundKey]);

  const selectedCompound: CompoundMatchRecord | null = useMemo(() => {
    if (!visibleCompounds.length) return null;
    return visibleCompounds.find((c) => c.key === selectedCompoundKey) || visibleCompounds[0];
  }, [visibleCompounds, selectedCompoundKey]);

  // Keep selectedWellIndex valid for selectedCompound
  useEffect(() => {
    if (!selectedCompound) {
      setSelectedWellIndex(null);
      return;
    }
    if (selectedWellIndex !== null && selectedCompound.wellsByIndex.has(selectedWellIndex)) {
      return;
    }
    const firstFound = selectedCompound.wells.find((w) => w.status === 'found');
    const firstCoeluted = selectedCompound.wells.find((w) => w.status === 'coeluted');
    const firstConflict = selectedCompound.wells.find((w) => w.status === 'inconsistent');
    const firstBoundary = selectedCompound.wells.find(
      (w) => w.status === 'front_saturated' || w.status === 'baseline_pinned'
    );
    const fallback = selectedCompound.wells[0];
    setSelectedWellIndex(
      (firstFound || firstCoeluted || firstConflict || firstBoundary || fallback)?.wellIndex ?? null
    );
  }, [selectedCompound, selectedWellIndex]);

  const selectedWellEntry =
    selectedCompound && selectedWellIndex !== null
      ? selectedCompound.wellsByIndex.get(selectedWellIndex) || null
      : null;

  // Keep inspectedPlateKey (the specific uploaded TLC strip displayed in the Well Close-Up) synced
  useEffect(() => {
    if (!selectedWellEntry) {
      setInspectedPlateKey(scopedPlates[0] ? plateKeyOf(scopedPlates[0]) : '');
      return;
    }
    const validKeys = new Set(selectedWellEntry.perPlate.map((p) => p.plateKey));
    if (!inspectedPlateKey || !validKeys.has(inspectedPlateKey)) {
      setInspectedPlateKey(selectedWellEntry.bestPlateKey);
    }
  }, [selectedWellEntry, scopedPlates, inspectedPlateKey]);

  const activeInspectedPlate: CalibratedPlateSummary | null = useMemo(() => {
    if (!scopedPlates.length) return null;
    return plateByKey.get(inspectedPlateKey) || scopedPlates[0];
  }, [scopedPlates, plateByKey, inspectedPlateKey]);

  const activeInspectedEvidence: PerPlateWellEvidence | null = useMemo(() => {
    if (!selectedWellEntry) return null;
    return (
      selectedWellEntry.perPlate.find((e) => e.plateKey === inspectedPlateKey) ||
      selectedWellEntry.perPlate[0] ||
      null
    );
  }, [selectedWellEntry, inspectedPlateKey]);

  const activeTlcSlice: TlcSet | undefined = useMemo(() => {
    if (!activeInspectedPlate) return undefined;
    const rawSet = tlcSets.find((s) => s.uid === activeInspectedPlate.setUid);
    if (!rawSet) return undefined;
    return getTlcPlateSlice(rawSet, activeInspectedPlate.plateIndex);
  }, [activeInspectedPlate, tlcSets]);

  const availableChannels = useMemo<Array<'composite' | TlcChannelKey>>(() => {
    const imgs = activeTlcSlice?.imgs || {};
    const chs: TlcChannelKey[] = [];
    if (imgs.UV254?.bmp) chs.push('UV254');
    if (imgs.UV366?.bmp) chs.push('UV366');
    if (imgs.White?.bmp) chs.push('White');
    const out: Array<'composite' | TlcChannelKey> = [...chs];
    if (chs.length >= 2) out.push('composite');
    return out;
  }, [activeTlcSlice]);

  useEffect(() => {
    if (availableChannels.length > 0 && !availableChannels.includes(channelMode)) {
      setChannelMode(availableChannels[0]);
    }
  }, [availableChannels, channelMode]);

  const inspectedLaneComparison: CalibratedLaneComparison | null = useMemo(() => {
    if (selectedWellIndex === null || !activeInspectedPlate) return null;
    return lanesByPlateAndWell.get(plateKeyOf(activeInspectedPlate))?.get(selectedWellIndex) || null;
  }, [selectedWellIndex, activeInspectedPlate, lanesByPlateAndWell]);

  const inspectedTlcLane: TlcLane | null = useMemo(() => {
    if (selectedWellIndex === null || !activeTlcSlice?.cfg?.lanes?.length) return null;
    const laneIdx = tlcLane(selectedWellIndex);
    return activeTlcSlice.cfg.lanes[laneIdx] || null;
  }, [selectedWellIndex, activeTlcSlice]);

  const handleSelectCompoundAndWell = (compoundKey: string, wellIdx?: number) => {
    setSelectedCompoundKey(compoundKey);
    const comp = compounds.find((c) => c.key === compoundKey);
    if (wellIdx !== undefined) {
      setSelectedWellIndex(wellIdx);
      const entry = comp?.wellsByIndex.get(wellIdx);
      if (entry) setInspectedPlateKey(entry.bestPlateKey);
    } else if (comp) {
      const best =
        comp.wells.find((w) => w.status === 'found') ||
        comp.wells.find((w) => w.status === 'coeluted') ||
        comp.wells.find((w) => w.status === 'inconsistent') ||
        comp.wells.find(
          (w) => w.status === 'front_saturated' || w.status === 'baseline_pinned'
        ) ||
        comp.wells[0];
      setSelectedWellIndex(best?.wellIndex ?? null);
      if (best) setInspectedPlateKey(best.bestPlateKey);
    }
  };

  const handleCopySmiles = (smiles: string, label: string) => {
    navigator.clipboard?.writeText(smiles);
    toast(`Copied SMILES for "${label}".`);
  };

  // Inline banner for unrecognized or skipped uploaded TLC tabs (always shown whenever any exist)
  const renderUnassignedBanner = () => {
    if (unmatchedSets.length === 0 && skippedUploadedSets.length === 0) return null;
    return (
      <div
        style={{
          padding: '9px 12px',
          background: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.38)',
          borderRadius: '9px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          fontSize: '11.5px',
        }}
      >
        {unmatchedSets.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <strong style={{ color: '#d97706' }}>
              {unmatchedSets.length} uploaded TLC tab{unmatchedSets.length === 1 ? '' : 's'} not yet included (solvent name not recognized):
            </strong>
            {unmatchedSets.map((u) => (
              <label
                key={u.key}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <span style={{ fontWeight: 600 }}>
                  “{u.name}” ({u.laneCountWithSpots} lanes):
                </span>
                <select
                  className="f"
                  style={{
                    height: '24px',
                    fontSize: '11px',
                    padding: '0 6px',
                    borderRadius: '6px',
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    color: 'var(--fg)',
                  }}
                  value={setSolventOverrides[u.key] || ''}
                  onChange={(e) => onSetSolventOverride(u.key, e.target.value)}
                >
                  <option value="">Assign mobile phase to include…</option>
                  {ALL_KNOWN_SOLVENT_SYSTEMS.map((sys) => (
                    <option key={sys.id} value={sys.id}>
                      {sys.name}
                    </option>
                  ))}
                  <option value="ignore">Ignore this plate</option>
                </select>
              </label>
            ))}
          </div>
        )}

        {skippedUploadedSets.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '11px',
              color: 'var(--mut)',
            }}
          >
            <span>Other uploaded TLC tabs not yet checked:</span>
            {skippedUploadedSets.map((sk) => (
              <span
                key={sk.uid}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '2px 7px',
                  borderRadius: '5px',
                  background: 'var(--panel)',
                  border: '1px solid var(--line2)',
                  color: 'var(--fg)',
                }}
              >
                <strong>{sk.name}</strong>
                <span style={{ color: 'var(--mut)' }}>
                  {sk.isIgnored
                    ? '(ignored)'
                    : !sk.hasLanes
                    ? '(no lanes configured yet)'
                    : '(no spots detected yet)'}
                </span>
                {sk.isIgnored && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ height: '18px', fontSize: '10px', padding: '0 5px' }}
                    onClick={() => onSetSolventOverride(sk.overrideKey, '')}
                  >
                    Include
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Loading state
  if (plateLoading && !calibrationModel) {
    return (
      <div
        style={{
          padding: '44px 20px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '10px',
          background: 'var(--soft)',
          border: '1px solid var(--line2)',
          borderRadius: '10px',
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 700 }}>
          Matching predicted reactants &amp; products against all uploaded TLC plates…
        </div>
        <div style={{ fontSize: '12px', color: 'var(--mut)' }}>
          Running cross-well calibration and collecting per-well Rf detections.
        </div>
      </div>
    );
  }

  // Empty state (no calibrated TLC plates available)
  if (!calibrationModel || plates.length === 0) {
    return (
      <div
        style={{
          padding: '24px',
          background: 'var(--soft)',
          border: '1px solid var(--line2)',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          alignItems: 'flex-start',
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 700 }}>
          No Real TLC Plates Matched Yet
        </div>
        <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--mut)', lineHeight: 1.55, maxWidth: '680px' }}>
          To inspect which starting materials and predicted products appear on your real TLC plates,
          upload one or more TLC plate images with detected lanes/spots and assign each tab’s mobile
          phase below (or name the tab after its solvent system, e.g. <code>25% EtOAc / Hexanes</code>).
        </p>
        {renderUnassignedBanner()}
        <button
          type="button"
          className="btn pri"
          onClick={onSwitchToOptimizer}
          style={{ fontSize: '12.5px', height: '32px' }}
        >
          Go to 54-Well Optimizer →
        </button>
      </div>
    );
  }

  const singleScopedPlate = scopedPlates.length === 1 ? scopedPlates[0] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Always-visible Uploaded Solvent Systems Checked Bar */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '10px 12px',
          background: 'var(--soft)',
          border: '1px solid var(--line2)',
          borderRadius: '10px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--fg)' }}>
              Uploaded TLC Solvent Systems Checked ({plates.length}):
            </span>

            {plates.length >= 2 && (
              <button
                type="button"
                className={`btn sm ${selectedPlateKey === ALL_PLATES_KEY ? 'pri' : ''}`}
                onClick={() => setSelectedPlateKey(ALL_PLATES_KEY)}
                style={{ height: '28px', fontSize: '11.5px', fontWeight: 700 }}
                title="Combine matches across all uploaded TLC solvent systems (shows best system for each well)"
              >
                All Uploaded ({plates.length} systems)
              </button>
            )}

            {plates.map((p) => {
              const pk = plateKeyOf(p);
              const active = selectedPlateKey === pk;
              const multiPlateSameTab = plates.some(
                (o) => o.setUid === p.setUid && o.plateIndex !== p.plateIndex
              );
              const showSeparateTabLabel =
                p.setName.trim().toLowerCase() !== p.matchedSystemName.trim().toLowerCase();
              return (
                <button
                  key={pk}
                  type="button"
                  className={`btn sm ${active ? 'pri' : ''}`}
                  onClick={() => setSelectedPlateKey(pk)}
                  style={{
                    height: '28px',
                    fontSize: '11.5px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  title={`Tab "${p.setName}" → calibrated as ${p.matchedSystemName} (${p.stationaryPhase})`}
                >
                  {showSeparateTabLabel && <span style={{ opacity: 0.85 }}>{p.setName}</span>}
                  {multiPlateSameTab && (
                    <span className="mono" style={{ opacity: 0.8, fontSize: '10.5px' }}>
                      P{p.plateIndex + 1}
                    </span>
                  )}
                  <span
                    style={{
                      fontWeight: 700,
                      borderLeft: showSeparateTabLabel ? '1px solid currentColor' : 'none',
                      paddingLeft: showSeparateTabLabel ? '6px' : 0,
                    }}
                  >
                    {p.matchedSystemName}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            className="mono"
            style={{ fontSize: '11px', color: 'var(--mut)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}
          >
            {singleScopedPlate ? (
              <>
                <span>Phase: {singleScopedPlate.stationaryPhase}</span>
                <span>
                  RMSE: {singleScopedPlate.rmseBefore.toFixed(2)} →{' '}
                  <strong style={{ color: 'var(--fg)' }}>{singleScopedPlate.rmseAfter.toFixed(2)}</strong>
                </span>
                <span>
                  Shift: {singleScopedPlate.midplateRfShift >= 0 ? '+' : ''}
                  {singleScopedPlate.midplateRfShift.toFixed(2)} Rf
                </span>
              </>
            ) : (
              <span>
                Cross-checking all {plates.length} uploaded solvent systems together (wells must be
                physically consistent across plates — single-plate contradictions are flagged as
                Conflicts)
              </span>
            )}
          </div>
        </div>

        {/* Inline Unrecognized / Skipped Uploaded TLC Tabs Banner */}
        {renderUnassignedBanner()}
      </div>

      {/* Summary KPI Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
          gap: '8px',
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--soft)',
            border: '1px solid var(--line2)',
            borderRadius: '9px',
          }}
        >
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', fontWeight: 600 }}>
            Predicted Products Found
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
            <strong className="mono" style={{ fontSize: '18px', color: '#10b981' }}>
              {kpis.productsFound}
            </strong>
            <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
              / {kpis.productsTotal}
            </span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: '2px' }}>
            {kpis.productsHighMedFound} High/Med-ranked detected
            {isCombinedAllMode ? ` across ${plates.length} systems` : ''}
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--soft)',
            border: '1px solid var(--line2)',
            borderRadius: '9px',
          }}
        >
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', fontWeight: 600 }}>
            Starting Materials Found
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
            <strong className="mono" style={{ fontSize: '18px', color: '#38bdf8' }}>
              {kpis.reactantsFound}
            </strong>
            <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
              / {kpis.reactantsTotal}
            </span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: '2px' }}>
            Remaining / unreacted starting material spots
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--soft)',
            border: '1px solid var(--line2)',
            borderRadius: '9px',
          }}
        >
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', fontWeight: 600 }}>
            Wells with Real Matches
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
            <strong className="mono" style={{ fontSize: '18px', color: 'var(--fg)' }}>
              {kpis.wellsWithMatches}
            </strong>
            <span className="mono" style={{ fontSize: '12px', color: 'var(--mut)' }}>
              / {kpis.nonBlankWells}
            </span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: '2px' }}>
            {kpis.totalPairedSpots} matched spot{kpis.totalPairedSpots === 1 ? '' : 's'} total
          </div>
        </div>

        <div
          style={{
            padding: '10px 12px',
            background: 'var(--soft)',
            border: '1px solid var(--line2)',
            borderRadius: '9px',
          }}
        >
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', fontWeight: 600 }}>
            Extra Unassigned Real Spots
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
            <strong
              className="mono"
              style={{ fontSize: '18px', color: kpis.unmatchedSpotCount > 0 ? '#f59e0b' : 'var(--mut)' }}
            >
              {kpis.unmatchedSpotCount}
            </strong>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: '2px' }}>
            Across {kpis.unmatchedSpotWells} well{kpis.unmatchedSpotWells === 1 ? '' : 's'} (inspect per well)
          </div>
        </div>
      </div>

      {/* Filter, Search & Sort Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div className="seg" role="group" aria-label="Filter detected compounds">
          <button
            type="button"
            className={filterMode === 'all' ? 'on' : ''}
            onClick={() => setFilterMode('all')}
          >
            All ({filterCounts.all})
          </button>
          <button
            type="button"
            className={filterMode === 'products_found' ? 'on' : ''}
            onClick={() => setFilterMode('products_found')}
          >
            Products Found ({filterCounts.products_found})
          </button>
          <button
            type="button"
            className={filterMode === 'reactants_found' ? 'on' : ''}
            onClick={() => setFilterMode('reactants_found')}
          >
            Reactants Found ({filterCounts.reactants_found})
          </button>
          <button
            type="button"
            className={filterMode === 'coeluted' ? 'on' : ''}
            onClick={() => setFilterMode('coeluted')}
          >
            Co-eluted ({filterCounts.coeluted})
          </button>
          {filterCounts.inconsistent > 0 && (
            <button
              type="button"
              className={filterMode === 'inconsistent' ? 'on' : ''}
              onClick={() => setFilterMode('inconsistent')}
              style={filterMode === 'inconsistent' ? undefined : { color: '#ef4444' }}
            >
              Conflicts ({filterCounts.inconsistent})
            </button>
          )}
          <button
            type="button"
            className={filterMode === 'boundary' ? 'on' : ''}
            onClick={() => setFilterMode('boundary')}
          >
            Front / Baseline ({filterCounts.boundary})
          </button>
          <button
            type="button"
            className={filterMode === 'missing' ? 'on' : ''}
            onClick={() => setFilterMode('missing')}
          >
            Not Seen ({filterCounts.missing})
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search name, SMILES, solvent, or well (e.g. B4)…"
            style={{
              height: '28px',
              padding: '0 10px',
              borderRadius: '7px',
              border: '1px solid var(--line)',
              background: 'var(--panel)',
              color: 'var(--fg)',
              fontSize: '12px',
              minWidth: '225px',
            }}
          />
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            style={{
              height: '28px',
              padding: '0 8px',
              borderRadius: '7px',
              border: '1px solid var(--line)',
              background: 'var(--panel)',
              color: 'var(--fg)',
              fontSize: '12px',
            }}
            aria-label="Sort compounds"
          >
            <option value="found_wells">Sort: Most wells found</option>
            <option value="products_first">Sort: Products first</option>
            <option value="rf_asc">Sort: Rf (low → high)</option>
            <option value="shift_desc">Sort: Largest Rf shift</option>
          </select>
        </div>
      </div>

      {/* Master-Detail Split Layout */}
      {visibleCompounds.length === 0 ? (
        <div
          style={{
            padding: '28px',
            textAlign: 'center',
            background: 'var(--soft)',
            border: '1px dashed var(--line)',
            borderRadius: '10px',
            color: 'var(--mut)',
            fontSize: '12.5px',
          }}
        >
          No compounds match the current filter or search query.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(330px, 0.95fr) minmax(420px, 1.2fr)',
            gap: '12px',
            alignItems: 'start',
          }}
        >
          {/* LEFT PANE: Compound Cards with Structures, Solvent Badges & Well Chips */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              maxHeight: '610px',
              overflowY: 'auto',
              paddingRight: '4px',
            }}
          >
            {visibleCompounds.map((comp) => {
              const isSelected = selectedCompound?.key === comp.key;
              const primaryStatus: MatchStatus =
                comp.foundCount > 0
                  ? 'found'
                  : comp.coelutedCount > 0
                  ? 'coeluted'
                  : comp.inconsistentCount > 0
                  ? 'inconsistent'
                  : comp.frontCount > 0
                  ? 'front_saturated'
                  : comp.baselineCount > 0
                  ? 'baseline_pinned'
                  : 'missing';
              const sm = statusMeta(primaryStatus);
              const tb = comp.kind === 'product' ? tierBadgeStyle(comp.bestTier) : null;

              return (
                <div
                  key={comp.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelectCompoundAndWell(comp.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectCompoundAndWell(comp.key);
                    }
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '102px 1fr',
                    gap: '10px',
                    padding: '10px',
                    borderRadius: '10px',
                    border: isSelected
                      ? '1.5px solid var(--acc)'
                      : '1px solid var(--line2)',
                    background: isSelected ? 'var(--soft)' : 'var(--panel)',
                    boxShadow: isSelected
                      ? '0 0 0 2px color-mix(in srgb, var(--acc) 22%, transparent)'
                      : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  {/* 2D Chemical Structure Tile */}
                  <div
                    style={{
                      width: '102px',
                      height: '78px',
                      borderRadius: '7px',
                      background: '#ffffff',
                      border: '1px solid var(--line2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    {comp.smiles ? (
                      <ChemicalStructure smiles={comp.smiles} width={98} height={74} />
                    ) : (
                      <span style={{ fontSize: '10px', color: '#64748b', textAlign: 'center', padding: '4px' }}>
                        No SMILES
                      </span>
                    )}
                  </div>

                  {/* Compound Metadata & Well Chips */}
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6px' }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: '12.5px',
                          lineHeight: 1.25,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                        title={comp.label}
                      >
                        {comp.label}
                      </div>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '5px',
                          color: sm.fg,
                          background: sm.bg,
                          border: `1px solid ${sm.border}`,
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        {comp.foundCount > 0
                          ? `Found (${comp.foundCount}/${comp.totalWells})`
                          : sm.short}
                      </span>
                    </div>

                    {/* Role / Tier / Method line */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background:
                            comp.kind === 'product'
                              ? 'rgba(168, 85, 247, 0.14)'
                              : 'rgba(56, 189, 248, 0.14)',
                          color: comp.kind === 'product' ? '#c084fc' : '#38bdf8',
                        }}
                      >
                        {comp.kind === 'product' ? 'Product' : 'Starting Material'}
                      </span>
                      {tb && (
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '1px 5px',
                            borderRadius: '4px',
                            color: tb.fg,
                            background: tb.bg,
                            border: `1px solid ${tb.border}`,
                          }}
                        >
                          {tb.label}
                        </span>
                      )}
                      {comp.matchMethod === 'consensus' && (
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            color: '#10b981',
                          }}
                          title="Confirmed across multiple wells containing this compound"
                        >
                          ✓ Plate consensus
                        </span>
                      )}
                    </div>

                    {/* Which solvent system(s) found it (especially clear in All Uploaded mode!) */}
                    {comp.resolvedBySystem.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {comp.resolvedBySystem.map((sys) => (
                          <span
                            key={sys.plateKey}
                            className="mono"
                            style={{
                              fontSize: '10px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'rgba(16, 185, 129, 0.1)',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                              color: 'var(--fg)',
                            }}
                            title={`Found in ${sys.wellsFound} well(s) on ${sys.setName} (${sys.solventName})`}
                          >
                            <strong style={{ color: '#10b981' }}>{sys.solventName}</strong>
                            {sys.obsRfMean !== null ? ` · Rf ${sys.obsRfMean.toFixed(2)}` : ''}
                            {isCombinedAllMode ? ` (${sys.wellsFound}w)` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div
                        className="mono"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          flexWrap: 'wrap',
                          fontSize: '11px',
                          color: 'var(--mut)',
                        }}
                      >
                        <span>
                          Pred: {comp.predRfBeforeMean.toFixed(2)}→
                          <span style={{ color: 'var(--fg)' }}>{comp.predRfAfterMean.toFixed(2)}</span>
                        </span>
                        {singleScopedPlate && (
                          <span>on {singleScopedPlate.matchedSystemName}</span>
                        )}
                      </div>
                    )}

                    {/* Clickable Well Chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '1px' }}>
                      {comp.wells.slice(0, 12).map((w) => {
                        const wsm = statusMeta(w.status);
                        const chipActive = isSelected && selectedWellIndex === w.wellIndex;
                        return (
                          <button
                            key={w.wellIndex}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectCompoundAndWell(comp.key, w.wellIndex);
                            }}
                            title={`${w.wellCoord} (Lane ${w.laneNumber}): ${wsm.label}${
                              w.matchedObsRf !== undefined ? ` · Rf ${w.matchedObsRf.toFixed(2)}` : ''
                            } (${w.bestSolventName})`}
                            className="mono"
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              color: chipActive ? 'var(--acc-fg)' : wsm.fg,
                              background: chipActive ? 'var(--acc)' : wsm.bg,
                              border: `1px solid ${chipActive ? 'var(--acc)' : wsm.border}`,
                              lineHeight: 1.4,
                            }}
                          >
                            {w.wellCoord}
                          </button>
                        );
                      })}
                      {comp.wells.length > 12 && (
                        <span className="mono" style={{ fontSize: '10px', color: 'var(--mut)', padding: '2px 3px' }}>
                          +{comp.wells.length - 12} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* RIGHT PANE: Close-Inspection Workbench */}
          {selectedCompound && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                padding: '12px 14px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
                borderRadius: '12px',
                maxHeight: '610px',
                overflowY: 'auto',
              }}
            >
              {/* 1. Large Structure + Compound Identity Header */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '176px 1fr',
                  gap: '12px',
                  alignItems: 'center',
                  paddingBottom: '10px',
                  borderBottom: '1px solid var(--line2)',
                }}
              >
                <div
                  style={{
                    width: '176px',
                    height: '124px',
                    borderRadius: '9px',
                    background: '#ffffff',
                    border: '1px solid var(--line2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {selectedCompound.smiles ? (
                    <ChemicalStructure smiles={selectedCompound.smiles} width={170} height={118} />
                  ) : (
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Structure unavailable</span>
                  )}
                </div>

                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontSize: '10.5px',
                        fontWeight: 700,
                        padding: '2px 7px',
                        borderRadius: '5px',
                        background:
                          selectedCompound.kind === 'product'
                            ? 'rgba(168, 85, 247, 0.16)'
                            : 'rgba(56, 189, 248, 0.16)',
                        color: selectedCompound.kind === 'product' ? '#c084fc' : '#38bdf8',
                      }}
                    >
                      {selectedCompound.kind === 'product' ? 'Predicted Product' : 'Starting Material'}
                    </span>
                    {selectedCompound.kind === 'product' && tierBadgeStyle(selectedCompound.bestTier) && (
                      <span
                        style={{
                          fontSize: '10.5px',
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: '5px',
                          color: tierBadgeStyle(selectedCompound.bestTier)!.fg,
                          background: tierBadgeStyle(selectedCompound.bestTier)!.bg,
                          border: `1px solid ${tierBadgeStyle(selectedCompound.bestTier)!.border}`,
                        }}
                      >
                        {tierBadgeStyle(selectedCompound.bestTier)!.label}
                      </span>
                    )}
                    {selectedCompound.matchMethod === 'consensus' && (
                      <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#10b981' }}>
                        ✓ Plate consensus
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>
                    {selectedCompound.label}
                  </div>

                  {selectedCompound.smiles && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <code
                        className="mono"
                        style={{
                          fontSize: '10.5px',
                          color: 'var(--mut)',
                          background: 'var(--panel)',
                          border: '1px solid var(--line2)',
                          borderRadius: '5px',
                          padding: '2px 6px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '240px',
                        }}
                        title={selectedCompound.smiles}
                      >
                        {selectedCompound.smiles}
                      </code>
                      <button
                        type="button"
                        className="btn sm"
                        style={{ height: '22px', fontSize: '10.5px', padding: '0 7px' }}
                        onClick={() => handleCopySmiles(selectedCompound.smiles!, selectedCompound.label)}
                      >
                        Copy SMILES
                      </button>
                    </div>
                  )}

                  {/* Quick numeric telemetry */}
                  <div
                    className="mono"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                      gap: '6px',
                      marginTop: '2px',
                    }}
                  >
                    <div
                      style={{
                        padding: '5px 7px',
                        background: 'var(--panel)',
                        border: '1px solid var(--line2)',
                        borderRadius: '6px',
                      }}
                    >
                      <div style={{ fontSize: '9.5px', color: 'var(--mut)' }}>
                        {selectedCompound.coelutedCount +
                          selectedCompound.inconsistentCount +
                          selectedCompound.frontCount +
                          selectedCompound.baselineCount >
                        0
                          ? 'Resolved / Expected'
                          : 'Wells Found'}
                      </div>
                      <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'baseline', gap: '4px', flexWrap: 'wrap' }}>
                        <span>
                          {selectedCompound.foundCount}/{selectedCompound.totalWells}
                        </span>
                        {selectedCompound.coelutedCount > 0 && (
                          <span style={{ fontSize: '9.5px', fontWeight: 600, color: '#8b5cf6' }}>
                            +{selectedCompound.coelutedCount} co-elut.
                          </span>
                        )}
                        {selectedCompound.inconsistentCount > 0 && (
                          <span style={{ fontSize: '9.5px', fontWeight: 600, color: '#ef4444' }}>
                            +{selectedCompound.inconsistentCount} conflict
                          </span>
                        )}
                        {selectedCompound.baselineCount > 0 && (
                          <span style={{ fontSize: '9.5px', fontWeight: 600, color: '#d97706' }}>
                            +{selectedCompound.baselineCount} base
                          </span>
                        )}
                        {selectedCompound.frontCount > 0 && (
                          <span style={{ fontSize: '9.5px', fontWeight: 600, color: '#0284c7' }}>
                            +{selectedCompound.frontCount} front
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '5px 7px',
                        background: 'var(--panel)',
                        border: '1px solid var(--line2)',
                        borderRadius: '6px',
                      }}
                    >
                      <div style={{ fontSize: '9.5px', color: 'var(--mut)' }}>
                        {isCombinedAllMode ? 'Best Measured Rf' : 'Measured Rf'}
                      </div>
                      <div style={{ fontSize: '12.5px', fontWeight: 700 }}>
                        {selectedCompound.observedRfMean !== null
                          ? selectedCompound.observedRfMean.toFixed(2)
                          : '—'}
                        {!isCombinedAllMode &&
                        selectedCompound.observedRfMean !== null &&
                        selectedCompound.observedRfSpread >= 0.005 ? (
                          <span style={{ fontSize: '10px', color: 'var(--mut)', fontWeight: 400 }}>
                            {' '}
                            ±{selectedCompound.observedRfSpread.toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '5px 7px',
                        background: 'var(--panel)',
                        border: '1px solid var(--line2)',
                        borderRadius: '6px',
                      }}
                    >
                      <div style={{ fontSize: '9.5px', color: 'var(--mut)' }}>
                        {isCombinedAllMode ? 'Systems Found' : 'Pred (Raw→Cal)'}
                      </div>
                      <div style={{ fontSize: '12px', fontWeight: 700 }}>
                        {isCombinedAllMode ? (
                          <span>
                            {selectedCompound.resolvedBySystem.length}/{plates.length}
                          </span>
                        ) : (
                          <>
                            <span style={{ color: 'var(--mut)', fontWeight: 500 }}>
                              {selectedCompound.predRfBeforeMean.toFixed(2)}→
                            </span>
                            {selectedCompound.predRfAfterMean.toFixed(2)}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. Interactive 54-Well (6x9) Microplate Hit Map */}
              <div
                style={{
                  background: 'var(--panel)',
                  border: '1px solid var(--line2)',
                  borderRadius: '9px',
                  padding: '9px 11px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '6px',
                  }}
                >
                  <strong style={{ fontSize: '11.5px' }}>
                    54-Well Plate Presence Map{' '}
                    <span style={{ color: 'var(--mut)', fontWeight: 500 }}>
                      ({isCombinedAllMode ? `All ${plates.length} uploaded systems` : singleScopedPlate?.matchedSystemName})
                    </span>
                  </strong>
                  <div style={{ display: 'flex', gap: '8px', fontSize: '10px', color: 'var(--mut)', flexWrap: 'wrap' }}>
                    <span style={{ color: '#10b981' }} title="Unambiguously resolved mid-plate spot (0.05 < Rf < 0.92)">
                      ■ Resolved ({selectedCompound.foundCount})
                    </span>
                    {selectedCompound.coelutedCount > 0 && (
                      <span
                        style={{ color: '#8b5cf6' }}
                        title="Overlaps another predicted compound (e.g. SM & Product) within ±0.05 Rf on a single spot"
                      >
                        ■ Co-elutes ({selectedCompound.coelutedCount})
                      </span>
                    )}
                    {selectedCompound.inconsistentCount > 0 && (
                      <span
                        style={{ color: '#ef4444' }}
                        title="Matched a spot on one uploaded solvent system, but absent on another system where this compound should be visible"
                      >
                        ■ Conflict ({selectedCompound.inconsistentCount})
                      </span>
                    )}
                    {selectedCompound.frontCount > 0 && (
                      <span style={{ color: '#38bdf8' }} title="Spot at solvent front (Rf ≥ 0.92)">
                        ■ Front ({selectedCompound.frontCount})
                      </span>
                    )}
                    {selectedCompound.baselineCount > 0 && (
                      <span style={{ color: '#f59e0b' }} title="Spot pinned at baseline / origin (Rf ≤ 0.05)">
                        ■ Base ≤0.05 ({selectedCompound.baselineCount})
                      </span>
                    )}
                    <span>□ Not seen ({selectedCompound.missingCount})</span>
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '18px repeat(9, minmax(0, 1fr))',
                    gap: '3px',
                    alignItems: 'center',
                  }}
                >
                  <div />
                  {COLS.map((c) => (
                    <div
                      key={c}
                      className="mono"
                      style={{
                        textAlign: 'center',
                        fontSize: '9.5px',
                        color: 'var(--mut)',
                        fontWeight: 600,
                      }}
                    >
                      {c}
                    </div>
                  ))}

                  {ROWS.map((rLabel, rIdx) => (
                    <React.Fragment key={rLabel}>
                      <div
                        className="mono"
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: 'var(--mut)',
                          textAlign: 'center',
                        }}
                      >
                        {rLabel}
                      </div>
                      {COLS.map((cNum, cIdx) => {
                        const wIdx = rIdx * 9 + cIdx;
                        const entry = selectedCompound.wellsByIndex.get(wIdx);
                        const isSelectedWell = selectedWellIndex === wIdx;
                        if (!entry) {
                          return (
                            <div
                              key={wIdx}
                              title={`${wellLabel(wIdx)}: compound not expected in this well`}
                              style={{
                                height: '24px',
                                borderRadius: '4px',
                                background: 'var(--soft)',
                                border: '1px solid var(--line2)',
                                opacity: 0.35,
                              }}
                            />
                          );
                        }
                        const sm = statusMeta(entry.status);
                        const multiTip = entry.perPlate
                          .map((ev) => {
                            const esm = statusMeta(ev.status);
                            return `${ev.solventName}: ${esm.short}${
                              ev.matchedObsRf !== undefined ? ` (Rf ${ev.matchedObsRf.toFixed(2)})` : ''
                            }`;
                          })
                          .join(' | ');
                        return (
                          <button
                            key={wIdx}
                            type="button"
                            onClick={() => {
                              setSelectedWellIndex(wIdx);
                              setInspectedPlateKey(entry.bestPlateKey);
                            }}
                            title={`${entry.wellCoord} (Lane ${entry.laneNumber}) — ${multiTip}`}
                            className="mono"
                            style={{
                              height: '24px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              padding: 0,
                              fontSize: '9.5px',
                              fontWeight: 700,
                              color: sm.fg,
                              background: sm.bg,
                              border: isSelectedWell
                                ? '2px solid var(--acc)'
                                : `1px solid ${sm.border}`,
                              boxShadow: isSelectedWell
                                ? '0 0 0 2px color-mix(in srgb, var(--acc) 30%, transparent)'
                                : 'none',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {entry.matchedObsRf !== undefined
                              ? entry.matchedObsRf.toFixed(2).replace(/^0/, '')
                              : entry.status === 'front_saturated'
                              ? 'Fr'
                              : entry.status === 'baseline_pinned'
                              ? 'Bl'
                              : '·'}
                          </button>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {/* 3. Selected Well Real TLC Strip + Per-Solvent-System Switcher + All Spots Breakdown */}
              {selectedWellIndex !== null && inspectedLaneComparison && activeInspectedPlate && (
                <div
                  style={{
                    background: 'var(--panel)',
                    border: '1px solid var(--line2)',
                    borderRadius: '9px',
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      <strong className="mono" style={{ fontSize: '12.5px' }}>
                        Well {inspectedLaneComparison.wellCoord}
                      </strong>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        Lane {tlcLane(selectedWellIndex) + 1} · {activeInspectedPlate.matchedSystemName}
                      </span>
                      {activeInspectedEvidence && (() => {
                        const sm = statusMeta(activeInspectedEvidence.status);
                        return (
                          <span
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              color: sm.fg,
                              background: sm.bg,
                              border: `1px solid ${sm.border}`,
                            }}
                          >
                            {sm.label}
                          </span>
                        );
                      })()}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {availableChannels.length > 1 && (
                        <div className="seg" style={{ height: '24px' }}>
                          {availableChannels.map((ch) => (
                            <button
                              key={ch}
                              type="button"
                              className={channelMode === ch ? 'on' : ''}
                              onClick={() => setChannelMode(ch)}
                              style={{ fontSize: '10px', padding: '0 6px', height: '22px' }}
                            >
                              {ch === 'composite' ? 'RGB' : ch}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn sm pri"
                        style={{ height: '25px', fontSize: '11px', padding: '0 9px' }}
                        onClick={() =>
                          onInspectWellInTlc({
                            setUid: activeInspectedPlate.setUid,
                            plateIndex: activeInspectedPlate.plateIndex,
                            wellIndex: selectedWellIndex,
                          })
                        }
                      >
                        Open Well &amp; Densitogram →
                      </button>
                    </div>
                  </div>

                  {/* Per-Uploaded-Solvent-System Verdict Switcher for this Well (when multiple uploaded plates) */}
                  {selectedWellEntry && selectedWellEntry.perPlate.length > 1 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '5px',
                        padding: '6px 8px',
                        borderRadius: '7px',
                        background: 'var(--soft)',
                        border: '1px solid var(--line2)',
                      }}
                    >
                      <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--mut)', marginRight: '2px' }}>
                        Compare across uploaded systems:
                      </span>
                      {selectedWellEntry.perPlate.map((ev) => {
                        const esm = statusMeta(ev.status);
                        const isActivePlate = ev.plateKey === inspectedPlateKey;
                        return (
                          <button
                            key={ev.plateKey}
                            type="button"
                            onClick={() => setInspectedPlateKey(ev.plateKey)}
                            className="mono"
                            style={{
                              fontSize: '10.5px',
                              padding: '3px 7px',
                              borderRadius: '5px',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              background: isActivePlate ? 'var(--panel)' : 'transparent',
                              border: isActivePlate
                                ? '1.5px solid var(--acc)'
                                : `1px solid ${esm.border}`,
                              color: 'var(--fg)',
                              fontWeight: isActivePlate ? 700 : 500,
                            }}
                          >
                            <span>{ev.solventName}</span>
                            <span style={{ color: esm.fg, fontWeight: 700 }}>
                              {ev.matchedObsRf !== undefined
                                ? `${esm.short} ${ev.matchedObsRf.toFixed(2)}`
                                : esm.short}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Strip Preview + Spot List */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: '12px',
                      alignItems: 'start',
                    }}
                  >
                    <div style={{ minWidth: '72px' }}>
                      <CompareLaneThumb
                        tlcSet={activeTlcSlice}
                        lane={inspectedTlcLane}
                        preferredMode={channelMode}
                        height={180}
                      />
                    </div>

                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {activeInspectedEvidence?.status === 'inconsistent' && (
                        <div
                          style={{
                            padding: '6px 8px',
                            borderRadius: '6px',
                            background: 'rgba(239, 68, 68, 0.11)',
                            border: '1px solid rgba(239, 68, 68, 0.42)',
                            fontSize: '11px',
                            color: 'var(--fg)',
                            lineHeight: 1.4,
                          }}
                        >
                          <strong style={{ color: '#ef4444' }}>Cross-plate conflict:</strong>{' '}
                          {activeInspectedEvidence.matchedObsRf !== undefined
                            ? `Matched a spot at Rf ${activeInspectedEvidence.matchedObsRf.toFixed(2)} on ${activeInspectedPlate.matchedSystemName}, `
                            : `Matched on ${activeInspectedPlate.matchedSystemName}, `}
                          but not seen on{' '}
                          <strong>
                            {activeInspectedEvidence.conflictPlates?.join(', ') || 'another uploaded plate'}
                          </strong>{' '}
                          for the same well (where this compound should be visible). Downgraded from
                          Found so a single-plate coincidence cannot pass as confirmed.
                        </div>
                      )}

                      {activeInspectedEvidence?.coelutedWith &&
                        activeInspectedEvidence.coelutedWith.length > 0 && (
                          <div
                            style={{
                              padding: '6px 8px',
                              borderRadius: '6px',
                              background: 'rgba(139, 92, 246, 0.12)',
                              border: '1px solid rgba(139, 92, 246, 0.4)',
                              fontSize: '11px',
                              color: 'var(--fg)',
                              lineHeight: 1.4,
                            }}
                          >
                            <strong style={{ color: '#8b5cf6' }}>
                              {activeInspectedEvidence.status === 'coeluted'
                                ? 'Co-eluting / Ambiguous spot:'
                                : 'Co-elution overlap note:'}
                            </strong>{' '}
                            {activeInspectedEvidence.matchedObsRf !== undefined
                              ? `Single spot at Rf ${activeInspectedEvidence.matchedObsRf.toFixed(2)} overlaps with `
                              : 'Predicted Rf overlaps with '}
                            <strong>{activeInspectedEvidence.coelutedWith.join(', ')}</strong>. Cannot
                            distinguish separately on {activeInspectedPlate.matchedSystemName}.
                          </div>
                        )}

                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--mut)' }}>
                        Real Detected Spots in Well {inspectedLaneComparison.wellCoord} on{' '}
                        {activeInspectedPlate.matchedSystemName} (
                        {inspectedLaneComparison.measuredSpots.length})
                      </div>

                      {inspectedLaneComparison.measuredSpots.length === 0 ? (
                        <div
                          style={{
                            fontSize: '11.5px',
                            color: 'var(--mut)',
                            padding: '10px',
                            background: 'var(--soft)',
                            borderRadius: '6px',
                            border: '1px dashed var(--line)',
                          }}
                        >
                          No spots detected in this lane (or spots are only at origin/front).
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {[...inspectedLaneComparison.measuredSpots]
                            .sort((a, b) => b.rf - a.rf)
                            .map((sp, i) => {
                              const isCurrentCompound =
                                activeInspectedEvidence?.matchedObsRf !== undefined &&
                                Math.abs(sp.rf - activeInspectedEvidence.matchedObsRf) <= 0.015;
                              const isCurrentCoeluted =
                                isCurrentCompound && activeInspectedEvidence?.status === 'coeluted';
                              const isCurrentConflict =
                                isCurrentCompound && activeInspectedEvidence?.status === 'inconsistent';
                              const hasCoeluters = Boolean(
                                sp.coelutedLabels && sp.coelutedLabels.length > 0
                              );
                              const isMatched = Boolean(sp.matchedLabel);
                              return (
                                <div
                                  key={`${sp.rf.toFixed(3)}-${i}`}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '8px',
                                    padding: '5px 8px',
                                    borderRadius: '6px',
                                    background: isCurrentConflict
                                      ? 'rgba(239, 68, 68, 0.13)'
                                      : isCurrentCoeluted
                                      ? 'rgba(139, 92, 246, 0.14)'
                                      : isCurrentCompound
                                      ? 'rgba(16, 185, 129, 0.14)'
                                      : 'var(--soft)',
                                    border: isCurrentConflict
                                      ? '1px solid rgba(239, 68, 68, 0.5)'
                                      : isCurrentCoeluted
                                      ? '1px solid rgba(139, 92, 246, 0.5)'
                                      : isCurrentCompound
                                      ? '1px solid rgba(16, 185, 129, 0.5)'
                                      : '1px solid var(--line2)',
                                    fontSize: '11px',
                                  }}
                                >
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
                                      <span
                                        className="mono"
                                        style={{
                                          fontWeight: 700,
                                          color: isCurrentConflict
                                            ? '#ef4444'
                                            : isCurrentCoeluted
                                            ? '#8b5cf6'
                                            : isCurrentCompound
                                            ? '#10b981'
                                            : isMatched
                                            ? 'var(--fg)'
                                            : '#f59e0b',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        Rf {sp.rf.toFixed(2)}
                                      </span>
                                      <span
                                        style={{
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                          fontWeight: isCurrentCompound ? 700 : 500,
                                          color: isMatched ? 'var(--fg)' : 'var(--mut)',
                                        }}
                                        title={sp.matchedLabel || 'Unassigned real TLC spot'}
                                      >
                                        {sp.matchedLabel || 'Unassigned spot (possible byproduct/impurity)'}
                                      </span>
                                    </div>
                                    {hasCoeluters && (
                                      <div
                                        style={{
                                          fontSize: '10px',
                                          color: '#8b5cf6',
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                        title={`Overlaps with: ${sp.coelutedLabels!.join(', ')}`}
                                      >
                                        ≈ Co-elutes with {sp.coelutedLabels!.join(', ')} (1 spot)
                                      </div>
                                    )}
                                  </div>

                                  <div
                                    className="mono"
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      fontSize: '10px',
                                      color: 'var(--mut)',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {sp.matchedKind && (
                                      <span
                                        style={{
                                          color:
                                            sp.matchedKind === 'product' ? '#c084fc' : '#38bdf8',
                                          fontWeight: 700,
                                        }}
                                      >
                                        {sp.matchedKind === 'product' ? 'Prod' : 'SM'}
                                      </span>
                                    )}
                                    <span>{Math.round(sp.strength * 100)}%</span>
                                    {sp.tailing !== undefined && sp.tailing >= 1.45 && (
                                      <span style={{ color: '#f59e0b' }} title="Detected streaking/tailing">
                                        tail
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}

                      {(() => {
                        const missingHere = inspectedLaneComparison.predictedSpots.filter(
                          (ps) => !ps.found && ps.boundaryStatus === 'missing'
                        );
                        if (!missingHere.length) return null;
                        return (
                          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: '2px' }}>
                            <strong>Not seen on {activeInspectedPlate.matchedSystemName}:</strong>{' '}
                            {missingHere
                              .slice(0, 4)
                              .map((m) => `${m.label} (pred ${m.rfAfter.toFixed(2)})`)
                              .join(', ')}
                            {missingHere.length > 4 ? ` +${missingHere.length - 4} more` : ''}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {/* 4. Per-Well Table for Selected Compound */}
              <div
                style={{
                  background: 'var(--panel)',
                  border: '1px solid var(--line2)',
                  borderRadius: '9px',
                  padding: '9px 11px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <strong style={{ fontSize: '11.5px' }}>
                  All Wells Containing This Compound ({selectedCompound.totalWells})
                </strong>
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: '11px',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          borderBottom: '1px solid var(--line)',
                          color: 'var(--mut)',
                          fontSize: '10px',
                          textAlign: 'left',
                        }}
                      >
                        <th style={{ padding: '4px 6px 5px 0' }}>Well</th>
                        <th style={{ padding: '4px 6px 5px' }}>Status</th>
                        {isCombinedAllMode && <th style={{ padding: '4px 6px 5px' }}>Best Solvent System</th>}
                        <th style={{ padding: '4px 6px 5px', textAlign: 'right' }}>Measured Rf</th>
                        <th style={{ padding: '4px 6px 5px', textAlign: 'right' }}>Pred (Cal.)</th>
                        <th style={{ padding: '4px 6px 5px', textAlign: 'right' }}>ΔRf</th>
                        <th style={{ padding: '4px 0 5px 6px', textAlign: 'right' }}>TLC View</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCompound.wells.map((w) => {
                        const sm = statusMeta(w.status);
                        const isRowActive = selectedWellIndex === w.wellIndex;
                        const delta =
                          w.matchedObsRf !== undefined ? w.matchedObsRf - w.rfAfter : null;
                        const targetPlate = plateByKey.get(w.bestPlateKey) || scopedPlates[0];
                        return (
                          <tr
                            key={w.wellIndex}
                            onClick={() => {
                              setSelectedWellIndex(w.wellIndex);
                              setInspectedPlateKey(w.bestPlateKey);
                            }}
                            style={{
                              borderBottom: '1px solid var(--line2)',
                              background: isRowActive ? 'var(--soft)' : 'transparent',
                              cursor: 'pointer',
                            }}
                          >
                            <td className="mono" style={{ padding: '5px 6px 5px 0', fontWeight: 700 }}>
                              {w.wellCoord}{' '}
                              <span style={{ color: 'var(--mut)', fontWeight: 400, fontSize: '10px' }}>
                                L{w.laneNumber}
                              </span>
                            </td>
                            <td style={{ padding: '5px 6px' }}>
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 600,
                                  color: sm.fg,
                                }}
                                title={
                                  w.status === 'inconsistent' && w.conflictPlates?.length
                                    ? `Absent on: ${w.conflictPlates.join(', ')}`
                                    : w.coelutedWith?.length
                                    ? `Overlaps with: ${w.coelutedWith.join(', ')}`
                                    : undefined
                                }
                              >
                                {sm.label}
                                {w.status === 'coeluted' && w.coelutedWith?.length
                                  ? ` (${w.coelutedWith[0]})`
                                  : w.status === 'inconsistent' && w.conflictPlates?.length
                                  ? ` (absent on ${w.conflictPlates.join(', ')})`
                                  : ''}
                              </span>
                            </td>
                            {isCombinedAllMode && (
                              <td style={{ padding: '5px 6px', fontSize: '10.5px', color: 'var(--fg)' }}>
                                <span>{w.bestSolventName}</span>
                                {w.resolvedSystemCount > 1 && (
                                  <span style={{ color: '#10b981', fontWeight: 700, marginLeft: '4px' }}>
                                    +{w.resolvedSystemCount - 1}
                                  </span>
                                )}
                              </td>
                            )}
                            <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700 }}>
                              {w.matchedObsRf !== undefined ? w.matchedObsRf.toFixed(2) : '—'}
                            </td>
                            <td className="mono" style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--mut)' }}>
                              {w.rfAfter.toFixed(2)}
                            </td>
                            <td
                              className="mono"
                              style={{
                                padding: '5px 6px',
                                textAlign: 'right',
                                color:
                                  delta !== null && Math.abs(delta) >= 0.15
                                    ? '#f59e0b'
                                    : 'var(--mut)',
                              }}
                            >
                              {delta !== null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}` : '—'}
                            </td>
                            <td style={{ padding: '4px 0 4px 6px', textAlign: 'right' }}>
                              <button
                                type="button"
                                className="btn sm"
                                style={{ height: '21px', fontSize: '10px', padding: '0 7px' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (targetPlate) {
                                    onInspectWellInTlc({
                                      setUid: targetPlate.setUid,
                                      plateIndex: targetPlate.plateIndex,
                                      wellIndex: w.wellIndex,
                                    });
                                  }
                                }}
                              >
                                Open →
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
