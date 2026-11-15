import { ParsedSubstrate, PredictedSpecies, PredictionTier, StepEvent } from './types';

export type PathwayNodeRole = 'entry' | 'lead' | 'extension' | 'divergence' | 'tautomer';

export interface PathwaySpeciesNode {
  species: PredictedSpecies;
  globalRank: number; // 1-indexed rank in flat score-sorted species list
  depth: number; // tree depth inside this pathway family (0 = family root)
  parentKey: string | null;
  parentGlobalRank: number | null;
  isLead: boolean;
  isPureTautomer: boolean;
  roleInPathway: PathwayNodeRole;
  lastStepLabel: string;
  lastStepDescription: string;
  alsoViaLabels: string[];
}

export interface PathwayFamily {
  id: string;
  pathwayNumber: number; // 1-indexed after sorting descending by peakScore
  title: string; // e.g. "Amine addition to carbonyl"
  entryStepLabel: string; // e.g. "NA(N)"
  entrySubstrateCodes: string[]; // substrates entering step 1 productive channel
  allSubstrateCodes: string[]; // union of substrates across the family
  peakScore: number;
  peakTier: PredictionTier;
  leadSpecies: PredictedSpecies;
  leadGlobalRank: number;
  nodes: PathwaySpeciesNode[]; // all nodes in progression order
  primaryNodes: PathwaySpeciesNode[]; // High / Medium / Lead + all their mechanistic ancestors
  minorNodes: PathwaySpeciesNode[]; // Low / Speculative side-branches
}

export function isTautomerStep(step: StepEvent): boolean {
  return step.stepLabel === 'Tautomer' || /^TAUT_/i.test(step.ruleId);
}

interface EntryAnchor {
  rootKey: string;
  isPureTautomer: boolean;
  rootStep: StepEvent | null;
}

function getEntryAnchor(chain: StepEvent[], speciesKey: string): EntryAnchor {
  if (!chain || chain.length === 0) {
    return { rootKey: `DIRECT::${speciesKey}`, isPureTautomer: false, rootStep: null };
  }
  const firstProdIdx = chain.findIndex((st) => !isTautomerStep(st));
  if (firstProdIdx === -1) {
    const tStep = chain[0];
    const sorted = [...tStep.reactantSmiles].sort().join('+');
    return {
      rootKey: `TAUT::${tStep.ruleId}::${sorted}`,
      isPureTautomer: true,
      rootStep: tStep,
    };
  }
  const rootStep = chain[firstProdIdx];
  const sorted = [...rootStep.reactantSmiles].sort().join('+');
  return {
    rootKey: `${rootStep.ruleId}::${sorted}`,
    isPureTautomer: false,
    rootStep,
  };
}

function codesFromInventory(inventory: number[], substrates: ParsedSubstrate[]): string[] {
  const codes: string[] = [];
  for (let i = 0; i < substrates.length; i++) {
    if ((inventory[i] || 0) > 0) {
      codes.push(substrates[i].code);
    }
  }
  return codes;
}

/**
 * Groups score-ranked PredictedSpecies into mechanistic Pathway Families:
 * - Each family shares a productive entry channel (skipping leading tautomer pre-equilibria
 *   so isomerized intermediates stay unified with the pathway they feed).
 * - Families are ordered globally descending by Peak Confidence Score (highest-scoring
 *   species inside the family), so the strongest chemistry always appears first.
 * - Inside each family, species are linked parent -> child via reactantSmiles provenance and
 *   arranged in mechanistic progression order (entry intermediate -> lead sink / extensions
 *   -> divergent branches), separating Low/Speculative leaf branches into minorNodes while
 *   keeping any ancestor intermediates of High/Medium hits visible in primaryNodes.
 */
export function groupSpeciesByPathway(
  species: PredictedSpecies[],
  substrates: ParsedSubstrate[]
): PathwayFamily[] {
  if (!species || species.length === 0) return [];

  const rankByKey = new Map<string, number>();
  const speciesByKey = new Map<string, PredictedSpecies>();
  species.forEach((sp, idx) => {
    rankByKey.set(sp.key, idx + 1);
    speciesByKey.set(sp.key, sp);
  });

  // 1. Assign preliminary anchor per species
  const anchorByKey = new Map<string, EntryAnchor>();
  const productiveBuckets = new Map<string, { rootStep: StepEvent | null; members: PredictedSpecies[] }>();
  const pureTautomers: PredictedSpecies[] = [];

  for (const sp of species) {
    const anchor = getEntryAnchor(sp.bestChain, sp.key);
    anchorByKey.set(sp.key, anchor);
    if (anchor.isPureTautomer) {
      pureTautomers.push(sp);
    } else {
      let bucket = productiveBuckets.get(anchor.rootKey);
      if (!bucket) {
        bucket = { rootStep: anchor.rootStep, members: [] };
        productiveBuckets.set(anchor.rootKey, bucket);
      }
      bucket.members.push(sp);
    }
  }

  // 2. Attach pure tautomer species to the highest-scoring productive family that consumes them
  for (const taut of pureTautomers) {
    let bestBucketId: string | null = null;
    let bestBucketPeak = -1;

    for (const [bucketId, bucket] of productiveBuckets.entries()) {
      const consumed = bucket.members.some((m) =>
        m.bestChain.some((st) => st.reactantSmiles.includes(taut.smiles))
      );
      if (!consumed) continue;
      const peak = bucket.members.reduce((mx, m) => Math.max(mx, m.score), 0);
      if (peak > bestBucketPeak) {
        bestBucketPeak = peak;
        bestBucketId = bucketId;
      }
    }

    if (bestBucketId) {
      productiveBuckets.get(bestBucketId)!.members.push(taut);
    } else {
      const anchor = anchorByKey.get(taut.key)!;
      let bucket = productiveBuckets.get(anchor.rootKey);
      if (!bucket) {
        bucket = { rootStep: anchor.rootStep, members: [] };
        productiveBuckets.set(anchor.rootKey, bucket);
      }
      bucket.members.push(taut);
    }
  }

  // 3. Build family structures with internal parent-child DAG & progression order
  const rawFamilies: Array<Omit<PathwayFamily, 'pathwayNumber'>> = [];

  for (const [bucketId, bucket] of productiveBuckets.entries()) {
    const members = bucket.members;
    const memberKeys = new Set(members.map((m) => m.key));

    // Peak / lead species (highest score; tie-break sink > transient, lower steps, lower rank)
    const sortedByScore = [...members].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.status !== b.status) return a.status === 'sink' ? -1 : 1;
      if (a.stepsCount !== b.stepsCount) return a.stepsCount - b.stepsCount;
      return (rankByKey.get(a.key) ?? 9999) - (rankByKey.get(b.key) ?? 9999);
    });

    const leadSpecies = sortedByScore[0];
    const leadGlobalRank = rankByKey.get(leadSpecies.key) ?? 1;
    const peakScore = leadSpecies.score;
    const peakTier = leadSpecies.tier;

    // Resolve parentKey within this family by inspecting bestChain step reactants (latest step first)
    const parentByKey = new Map<string, string | null>();
    const childrenMap = new Map<string, PredictedSpecies[]>();
    for (const m of members) childrenMap.set(m.key, []);

    for (const m of members) {
      let foundParent: PredictedSpecies | null = null;
      for (let sIdx = m.bestChain.length - 1; sIdx >= 0; sIdx--) {
        const reactants = m.bestChain[sIdx].reactantSmiles;
        const candidateParents = reactants
          .map((smi) => speciesByKey.get(smi))
          .filter(
            (cand): cand is PredictedSpecies =>
              Boolean(cand && cand.key !== m.key && memberKeys.has(cand.key) && cand.stepsCount <= m.stepsCount)
          );
        if (candidateParents.length > 0) {
          candidateParents.sort((a, b) => b.score - a.score || b.stepsCount - a.stepsCount);
          foundParent = candidateParents[0];
          break;
        }
      }
      const pKey = foundParent ? foundParent.key : null;
      parentByKey.set(m.key, pKey);
      if (pKey) {
        childrenMap.get(pKey)!.push(m);
      }
    }

    // Compute max subtree score for clean branch ordering (strongest branch walks first)
    const subtreePeakMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const getSubtreePeak = (k: string): number => {
      if (subtreePeakMemo.has(k)) return subtreePeakMemo.get(k)!;
      if (visiting.has(k)) return speciesByKey.get(k)?.score ?? 0;
      visiting.add(k);
      let mx = speciesByKey.get(k)?.score ?? 0;
      for (const ch of childrenMap.get(k) || []) {
        mx = Math.max(mx, getSubtreePeak(ch.key));
      }
      visiting.delete(k);
      subtreePeakMemo.set(k, mx);
      return mx;
    };

    const roots = members
      .filter((m) => parentByKey.get(m.key) === null)
      .sort((a, b) => {
        const subDiff = getSubtreePeak(b.key) - getSubtreePeak(a.key);
        if (Math.abs(subDiff) > 1e-6) return subDiff;
        if (a.stepsCount !== b.stepsCount) return a.stepsCount - b.stepsCount;
        return b.score - a.score;
      });

    // DFS traversal producing progression order with depth & branch role
    const orderedEntries: Array<{ sp: PredictedSpecies; depth: number; role: PathwayNodeRole }> = [];
    const visited = new Set<string>();

    const walk = (sp: PredictedSpecies, depth: number, isSecondaryBranch: boolean) => {
      if (visited.has(sp.key)) return;
      visited.add(sp.key);

      const isPureTaut = anchorByKey.get(sp.key)?.isPureTautomer ?? false;
      let role: PathwayNodeRole;
      if (sp.key === leadSpecies.key) {
        role = 'lead';
      } else if (isPureTaut) {
        role = 'tautomer';
      } else if (depth === 0) {
        role = 'entry';
      } else if (isSecondaryBranch) {
        role = 'divergence';
      } else {
        role = 'extension';
      }

      orderedEntries.push({ sp, depth, role });

      const children = [...(childrenMap.get(sp.key) || [])].sort((a, b) => {
        const subDiff = getSubtreePeak(b.key) - getSubtreePeak(a.key);
        if (Math.abs(subDiff) > 1e-6) return subDiff;
        if (b.score !== a.score) return b.score - a.score;
        return a.stepsCount - b.stepsCount;
      });

      children.forEach((child, cIdx) => {
        walk(child, depth + 1, cIdx > 0 || (role === 'divergence'));
      });
    };

    roots.forEach((r, rIdx) => walk(r, 0, rIdx > 0));
    // Defensive fallback in case any cycle prevented visiting
    for (const m of sortedByScore) {
      if (!visited.has(m.key)) {
        walk(m, 0, true);
      }
    }

    const nodes: PathwaySpeciesNode[] = orderedEntries.map(({ sp, depth, role }) => {
      const pKey = parentByKey.get(sp.key) ?? null;
      const lastStep = sp.bestChain[sp.bestChain.length - 1];
      return {
        species: sp,
        globalRank: rankByKey.get(sp.key) ?? 0,
        depth,
        parentKey: pKey,
        parentGlobalRank: pKey ? rankByKey.get(pKey) ?? null : null,
        isLead: sp.key === leadSpecies.key,
        isPureTautomer: anchorByKey.get(sp.key)?.isPureTautomer ?? false,
        roleInPathway: role,
        lastStepLabel: lastStep?.stepLabel ?? '',
        lastStepDescription: lastStep?.description ?? '',
        alsoViaLabels: [],
      };
    });

    // Separate primaryNodes (High/Medium/Lead + all their ancestors) vs minorNodes (Low/Speculative leaves)
    const primaryKeySet = new Set<string>();
    for (const n of nodes) {
      if (n.isLead || n.species.tier === 'High' || n.species.tier === 'Medium') {
        let cur: string | null = n.species.key;
        const guard = new Set<string>();
        while (cur && !guard.has(cur)) {
          guard.add(cur);
          primaryKeySet.add(cur);
          cur = parentByKey.get(cur) ?? null;
        }
      }
    }

    const primaryNodes = nodes.filter((n) => primaryKeySet.has(n.species.key));
    const minorNodes = nodes.filter((n) => !primaryKeySet.has(n.species.key));

    // Collect substrate participation labels
    const nonTautMembers = members.filter((m) => !(anchorByKey.get(m.key)?.isPureTautomer));
    const minSteps = nonTautMembers.reduce((mn, m) => Math.min(mn, m.stepsCount), Infinity);
    const earliestNonTaut = nonTautMembers.filter((m) => m.stepsCount === minSteps);
    const entrySubSet = new Set<string>();
    for (const m of earliestNonTaut) {
      for (const code of codesFromInventory(m.inventory, substrates)) {
        entrySubSet.add(code);
      }
    }
    const allSubSet = new Set<string>();
    for (const m of members) {
      for (const code of codesFromInventory(m.inventory, substrates)) {
        allSubSet.add(code);
      }
    }
    const orderSubCodes = (set: Set<string>) =>
      substrates.map((s) => s.code).filter((c) => set.has(c));

    const rootStep = bucket.rootStep;
    const entryStepLabel = rootStep?.stepLabel || 'Step';
    const title = rootStep?.description || (pureTautomers.length > 0 ? 'Tautomer equilibrium' : 'Direct pathway');

    rawFamilies.push({
      id: bucketId,
      title,
      entryStepLabel,
      entrySubstrateCodes: orderSubCodes(entrySubSet.size > 0 ? entrySubSet : allSubSet),
      allSubstrateCodes: orderSubCodes(allSubSet),
      peakScore,
      peakTier,
      leadSpecies,
      leadGlobalRank,
      nodes,
      primaryNodes,
      minorNodes,
    });
  }

  // 4. Sort Pathway Families globally descending by peak confidence score
  rawFamilies.sort((a, b) => {
    if (b.peakScore !== a.peakScore) return b.peakScore - a.peakScore;
    if (a.leadSpecies.status !== b.leadSpecies.status) {
      return a.leadSpecies.status === 'sink' ? -1 : 1;
    }
    if (a.leadSpecies.stepsCount !== b.leadSpecies.stepsCount) {
      return a.leadSpecies.stepsCount - b.leadSpecies.stepsCount;
    }
    return a.leadGlobalRank - b.leadGlobalRank;
  });

  const families: PathwayFamily[] = rawFamilies.map((f, idx) => ({
    ...f,
    pathwayNumber: idx + 1,
  }));

  // 5. Annotate convergent cross-references (alternativeChains landing in another family)
  const familyById = new Map<string, PathwayFamily>();
  for (const fam of families) {
    familyById.set(fam.id, fam);
  }

  for (const fam of families) {
    for (const node of fam.nodes) {
      const labels = new Set<string>();
      for (const altChain of node.species.alternativeChains) {
        const altAnchor = getEntryAnchor(altChain, node.species.key);
        const other = familyById.get(altAnchor.rootKey);
        if (other && other.id !== fam.id) {
          const subsTxt = other.entrySubstrateCodes.length > 0 ? `: ${other.entrySubstrateCodes.join(' + ')}` : '';
          labels.add(`Pathway ${other.pathwayNumber} (${other.entryStepLabel}${subsTxt})`);
        }
      }
      node.alsoViaLabels = Array.from(labels);
    }
  }

  return families;
}
