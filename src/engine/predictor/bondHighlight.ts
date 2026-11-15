import { REACTION_RULES, ReactionRuleDef } from './rules';
import { TAUTOMER_RULES } from './engine';
import { stripStereoFromSmiles } from './saltAndSites';
import { PredictedSpecies, StepEvent } from './types';

interface ParsedSmartsAtom {
  idx: number;
  mapNum: number | null;
  isAromatic: boolean;
}

interface ParsedSmartsBond {
  a: number;
  b: number;
  order: number;
}

interface RuleBondDiff {
  rhsClean: string;
  newRhsBonds: Array<[number, number]>; // [rhsAtomIdxA, rhsAtomIdxB]
}

export interface SpeciesBondHighlights {
  allNewBonds: number[];
  lastStepBonds: number[];
}

const ruleByIdCache = new Map<string, ReactionRuleDef>();
function getRuleById(ruleId: string): ReactionRuleDef | undefined {
  if (ruleByIdCache.size === 0) {
    for (const r of REACTION_RULES) ruleByIdCache.set(r.id, r);
    for (const r of TAUTOMER_RULES) ruleByIdCache.set(r.id, r);
  }
  return ruleByIdCache.get(ruleId);
}

export function parseSmartsBonds(side: string): {
  atoms: ParsedSmartsAtom[];
  bonds: ParsedSmartsBond[];
} {
  let s = side.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);

  const atoms: ParsedSmartsAtom[] = [];
  const bonds: ParsedSmartsBond[] = [];
  const stack: Array<number | null> = [];
  const rings = new Map<string, { atom: number; order: number }>();

  let prev: number | null = null;
  let pendingOrder = 1;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      prev = null;
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === '(') {
      stack.push(prev);
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === ')') {
      prev = stack.pop() ?? null;
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === '-') {
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === '=') {
      pendingOrder = 2;
      i++;
      continue;
    }
    if (ch === '#') {
      pendingOrder = 3;
      i++;
      continue;
    }
    if (ch === ':') {
      pendingOrder = 1.5;
      i++;
      continue;
    }
    if (ch >= '1' && ch <= '9' && prev !== null) {
      if (rings.has(ch)) {
        const other = rings.get(ch)!;
        const order =
          pendingOrder === 1 && atoms[other.atom]?.isAromatic && atoms[prev]?.isAromatic
            ? 1.5
            : Math.max(other.order, pendingOrder);
        bonds.push({ a: other.atom, b: prev, order });
        rings.delete(ch);
      } else {
        rings.set(ch, { atom: prev, order: pendingOrder });
      }
      pendingOrder = 1;
      i++;
      continue;
    }
    if (ch === '[') {
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        j++;
      }
      const token = s.slice(i, j);
      const mapMatch = token.match(/:(\d+)\]$/);
      const mapNum = mapMatch ? parseInt(mapMatch[1], 10) : null;
      const isAromatic = /^\[[cnos]/.test(token);
      const idx = atoms.length;
      atoms.push({ idx, mapNum, isAromatic });
      if (prev !== null) {
        const order =
          pendingOrder === 1 && atoms[prev].isAromatic && isAromatic ? 1.5 : pendingOrder;
        bonds.push({ a: prev, b: idx, order });
      }
      prev = idx;
      pendingOrder = 1;
      i = j;
      continue;
    }

    let sym = ch;
    if ((ch === 'C' || ch === 'B') && (s[i + 1] === 'l' || s[i + 1] === 'r')) {
      sym = s.slice(i, i + 2);
    }
    const idx = atoms.length;
    const isAromatic = sym === sym.toLowerCase() && sym !== sym.toUpperCase();
    atoms.push({ idx, mapNum: null, isAromatic });
    if (prev !== null) {
      const order =
        pendingOrder === 1 && atoms[prev].isAromatic && isAromatic ? 1.5 : pendingOrder;
      bonds.push({ a: prev, b: idx, order });
    }
    prev = idx;
    pendingOrder = 1;
    i += sym.length;
  }

  return { atoms, bonds };
}

const ruleDiffCache = new Map<string, RuleBondDiff | null>();
function getRuleBondDiff(rule: ReactionRuleDef): RuleBondDiff | null {
  if (ruleDiffCache.has(rule.id)) return ruleDiffCache.get(rule.id) || null;
  const parts = rule.smarts.split('>>');
  if (parts.length !== 2) {
    ruleDiffCache.set(rule.id, null);
    return null;
  }
  const [lhs, rhsAll] = parts;
  const rhs = rhsAll.split('.')[0];
  const L = parseSmartsBonds(lhs);
  const R = parseSmartsBonds(rhs);

  const lBonds = new Map<string, number>();
  for (const b of L.bonds) {
    const m1 = L.atoms[b.a]?.mapNum;
    const m2 = L.atoms[b.b]?.mapNum;
    if (m1 != null && m2 != null) {
      const k = m1 < m2 ? `${m1}:${m2}` : `${m2}:${m1}`;
      lBonds.set(k, b.order);
    }
  }

  const newRhsBonds: Array<[number, number]> = [];
  for (const b of R.bonds) {
    const m1 = R.atoms[b.a]?.mapNum;
    const m2 = R.atoms[b.b]?.mapNum;
    if (m1 == null || m2 == null) {
      // Unmapped newly formed ring/bridge bonds (e.g. azide-alkyne triazole, disulfide S-S)
      newRhsBonds.push([b.a, b.b]);
      continue;
    }
    const k = m1 < m2 ? `${m1}:${m2}` : `${m2}:${m1}`;
    const oldOrder = lBonds.get(k);
    if (oldOrder === undefined || b.order > oldOrder) {
      newRhsBonds.push([b.a, b.b]);
    }
  }

  const diff: RuleBondDiff = {
    rhsClean: rhs.replace(/:\d+(?=\])/g, ''),
    newRhsBonds,
  };
  ruleDiffCache.set(rule.id, diff);
  return diff;
}

function addSequentialAtomMaps(rdkit: any, smiles: string, offset: number): any | null {
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return null;
    const mb = mol.get_molblock();
    mol.delete();
    mol = null;
    const lines = mb.split('\n');
    const nAtoms = parseInt((lines[3] || '').slice(0, 3).trim(), 10);
    if (!Number.isFinite(nAtoms) || nAtoms <= 0) return null;
    for (let i = 0; i < nAtoms; i++) {
      const line = (lines[4 + i] || '').padEnd(69, ' ');
      const mapStr = String(offset + i).padStart(3, ' ');
      lines[4 + i] = line.slice(0, 60) + mapStr + line.slice(63);
    }
    return rdkit.get_mol(lines.join('\n'));
  } catch {
    return null;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

function stripMolblockAtomMaps(rdkit: any, mol: any): any | null {
  try {
    const mbLines = mol.get_molblock().split('\n');
    const nAtoms = parseInt((mbLines[3] || '').slice(0, 3).trim(), 10);
    if (!Number.isFinite(nAtoms) || nAtoms <= 0) return null;
    for (let i = 0; i < nAtoms; i++) {
      const line = (mbLines[4 + i] || '').padEnd(69, ' ');
      mbLines[4 + i] = line.slice(0, 60) + '  0' + line.slice(63);
    }
    return rdkit.get_mol(mbLines.join('\n'));
  } catch {
    return null;
  }
}

function getAtomMapsFromMol(mol: any): number[] {
  const lines = mol.get_molblock().split('\n');
  const nAtoms = parseInt((lines[3] || '').slice(0, 3).trim(), 10);
  if (!Number.isFinite(nAtoms) || nAtoms <= 0) return [];
  const maps: number[] = [];
  for (let i = 0; i < nAtoms; i++) {
    const s = (lines[4 + i] || '').slice(60, 63).trim();
    maps.push(s ? parseInt(s, 10) : 0);
  }
  return maps;
}

function buildAdj(bonds: Array<{ atoms: [number, number] }>): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const b of bonds) {
    const [u, v] = b.atoms;
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  }
  return adj;
}

function buildBondOrderMap(
  bonds: Array<{ atoms: [number, number]; bo?: number }>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const b of bonds) {
    const [u, v] = b.atoms;
    const k = u < v ? `${u}:${v}` : `${v}:${u}`;
    map.set(k, b.bo ?? 1);
  }
  return map;
}

function resolveReactantAtomInProd(
  atomIdx: number,
  rAdj: Map<number, Set<number>>,
  offset: number,
  mapToProd: Map<number, number>,
  pMaps: number[],
  pAdj: Map<number, Set<number>>
): number | null {
  const direct = mapToProd.get(offset + atomIdx);
  if (direct != null) return direct;
  const specMaps = [...(rAdj.get(atomIdx) || [])]
    .map((nb) => offset + nb)
    .filter((m) => mapToProd.has(m));
  if (specMaps.length === 0) return null;
  const firstProd = mapToProd.get(specMaps[0])!;
  const cands = [...(pAdj.get(firstProd) || [])].filter(
    (pa) => pMaps[pa] === 0 && specMaps.every((sm) => pAdj.get(pa)?.has(mapToProd.get(sm)!))
  );
  return cands.length === 1 ? cands[0] : null;
}

interface StepHighlightResult {
  allPairs: Array<[number, number]>;
  stepPairs: Array<[number, number]>;
}

function traceSingleStepPairs(
  rdkit: any,
  step: StepEvent,
  targetProdSmiles: string,
  prevPairsBySmiles: Map<string, Array<[number, number]>>
): StepHighlightResult {
  const rule = getRuleById(step.ruleId);
  if (!rule) return { allPairs: [], stepPairs: [] };
  const diff = getRuleBondDiff(rule);
  if (!diff) return { allPairs: [], stepPairs: [] };

  let rxn: any = null;
  let ml: any = null;
  let out: any = null;
  let canonTarget: any = null;
  let rhsQ: any = null;
  let bestUnmapped: any = null;
  const mappedReactants: any[] = [];
  const productSetsToFree: any[] = [];

  try {
    rxn = rdkit.get_rxn(rule.smarts);
    canonTarget = rdkit.get_mol(targetProdSmiles);
    if (!rxn || !canonTarget || !canonTarget.is_valid()) return { allPairs: [], stepPairs: [] };
    const canonSmi = stripStereoFromSmiles(rdkit, canonTarget.get_smiles());

    const offsets = [100, 550];
    ml = new rdkit.MolList();
    const rAdjs: Array<Map<number, Set<number>>> = [];
    const rBondOrders: Array<Map<string, number>> = [];

    for (let i = 0; i < step.reactantSmiles.length && i < 2; i++) {
      const rm = addSequentialAtomMaps(rdkit, step.reactantSmiles[i], offsets[i]);
      if (!rm) return { allPairs: [], stepPairs: [] };
      mappedReactants.push(rm);
      ml.append(rm);
      const rJson = JSON.parse(rm.get_json()).molecules?.[0];
      const rBonds = rJson?.bonds || [];
      rAdjs.push(buildAdj(rBonds));
      rBondOrders.push(buildBondOrderMap(rBonds));
    }

    out = rxn.run_reactants(ml, 12);
    if (!out) return { allPairs: [], stepPairs: [] };

    let bestPMol: any = null;
    const nProds = out.size();
    for (let i = 0; i < nProds; i++) {
      const pList = out.get(i);
      if (!pList) continue;
      productSetsToFree.push(pList);
      if (bestPMol) continue;
      const p = pList.at(0);
      if (!p) continue;
      const cleanRaw = p.get_smiles().replace(/:\d+(?=\])/g, '');
      const strippedSmi = stripStereoFromSmiles(rdkit, cleanRaw);
      if (strippedSmi === canonSmi) {
        bestPMol = p;
      }
    }

    if (!bestPMol) return { allPairs: [], stepPairs: [] };

    const pMaps = getAtomMapsFromMol(bestPMol);
    const pJson = JSON.parse(bestPMol.get_json()).molecules?.[0];
    if (!pJson) return { allPairs: [], stepPairs: [] };
    const pBonds = pJson.bonds || [];
    const pAdj = buildAdj(pBonds);
    const pBondOrders = buildBondOrderMap(pBonds);
    const mapToP = new Map<number, number>();
    pMaps.forEach((mp, idx) => {
      if (mp > 0) mapToP.set(mp, idx);
    });

    const pAllPairs: Array<[number, number]> = [];
    const pStepPairs: Array<[number, number]> = [];

    // 1. Carry forward earlier newly formed cascade bonds across this step
    for (let rIdx = 0; rIdx < step.reactantSmiles.length; rIdx++) {
      const rSmi = step.reactantSmiles[rIdx];
      const prev =
        prevPairsBySmiles.get(rSmi) ??
        prevPairsBySmiles.get(stripStereoFromSmiles(rdkit, rSmi)) ??
        [];
      if (prev.length === 0) continue;
      const rAdj = rAdjs[rIdx] || new Map<number, Set<number>>();
      const off = offsets[rIdx];
      for (const [u, v] of prev) {
        const pu = resolveReactantAtomInProd(u, rAdj, off, mapToP, pMaps, pAdj);
        const pv = resolveReactantAtomInProd(v, rAdj, off, mapToP, pMaps, pAdj);
        if (pu != null && pv != null && pAdj.get(pu)?.has(pv)) {
          pAllPairs.push([pu, pv]);
        }
      }
    }

    // Score whether a bond [pa, pb] in bestPMol is genuinely newly forged or upgraded
    const bondNoveltyScore = (pa: number, pb: number): number => {
      const ma = pMaps[pa];
      const mb = pMaps[pb];
      if (ma === 0 || mb === 0) return 100;
      const raIdx = ma >= offsets[1] ? 1 : 0;
      const rbIdx = mb >= offsets[1] ? 1 : 0;
      if (raIdx !== rbIdx) return 100;
      const ua = ma - offsets[raIdx];
      const ub = mb - offsets[rbIdx];
      const rKey = ua < ub ? `${ua}:${ub}` : `${ub}:${ua}`;
      const oldBo = rBondOrders[raIdx]?.get(rKey);
      const pKey = pa < pb ? `${pa}:${pb}` : `${pb}:${pa}`;
      const newBo = pBondOrders.get(pKey) ?? 1;
      if (oldBo === undefined) return 90; // Intramolecular ring-closure bond
      if (newBo > oldBo) return 80; // Bond-order upgrade (e.g. C-N -> C=N)
      return -50; // Pre-existing spectator bond
    };

    // 2. Pinpoint this step's new bonds on bestPMol via RHS substructure scored by bond novelty
    let foundStepBonds = false;
    if (diff.newRhsBonds.length > 0 && diff.rhsClean) {
      rhsQ = rdkit.get_qmol(diff.rhsClean);
      if (rhsQ) {
        const rawMatches: Array<{ atoms: number[] }> = JSON.parse(
          bestPMol.get_substruct_matches(rhsQ) || '[]'
        );
        if (rawMatches.length > 0) {
          let bestAtoms = rawMatches[0].atoms;
          let bestScore = -Infinity;
          for (const m of rawMatches) {
            let score = m.atoms.filter((a) => pMaps[a] === 0).length * 20;
            for (const [ra, rb] of diff.newRhsBonds) {
              const pa = m.atoms[ra];
              const pb = m.atoms[rb];
              if (pa != null && pb != null && pAdj.get(pa)?.has(pb)) {
                score += bondNoveltyScore(pa, pb);
              }
            }
            if (score > bestScore) {
              bestScore = score;
              bestAtoms = m.atoms;
            }
          }
          for (const [ra, rb] of diff.newRhsBonds) {
            const pa = bestAtoms[ra];
            const pb = bestAtoms[rb];
            if (pa != null && pb != null && pAdj.get(pa)?.has(pb)) {
              pStepPairs.push([pa, pb]);
              pAllPairs.push([pa, pb]);
              foundStepBonds = true;
            }
          }
        }
      }
    }

    // Fallback: if RHS query missed, recover mapped cross-reactant or newly formed/upgraded bonds directly
    if (!foundStepBonds && diff.newRhsBonds.length > 0) {
      for (const b of pBonds) {
        const [pa, pb] = b.atoms;
        if (bondNoveltyScore(pa, pb) > 0) {
          pStepPairs.push([pa, pb]);
          pAllPairs.push([pa, pb]);
        }
      }
    }

    // 3. Re-index from bestPMol atom order onto canonical targetProdSmiles atom order
    bestUnmapped = stripMolblockAtomMaps(rdkit, bestPMol);
    if (!bestUnmapped) return { allPairs: [], stepPairs: [] };
    const matchObj = JSON.parse(canonTarget.get_substruct_match(bestUnmapped) || '{}');
    const mapping: number[] = matchObj.atoms || [];
    if (mapping.length === 0) return { allPairs: [], stepPairs: [] };

    const mapPairs = (pairs: Array<[number, number]>) => {
      const seen = new Set<string>();
      const outPairs: Array<[number, number]> = [];
      for (const [u, v] of pairs) {
        const cu = mapping[u];
        const cv = mapping[v];
        if (cu != null && cv != null) {
          const k = cu < cv ? `${cu}:${cv}` : `${cv}:${cu}`;
          if (!seen.has(k)) {
            seen.add(k);
            outPairs.push([cu, cv]);
          }
        }
      }
      return outPairs;
    };

    return {
      allPairs: mapPairs(pAllPairs),
      stepPairs: mapPairs(pStepPairs),
    };
  } catch {
    return { allPairs: [], stepPairs: [] };
  } finally {
    try {
      bestUnmapped?.delete?.();
      rhsQ?.delete?.();
      canonTarget?.delete?.();
      for (const pl of productSetsToFree) pl?.delete?.();
      out?.delete?.();
      ml?.delete?.();
      for (const rm of mappedReactants) rm?.delete?.();
      rxn?.delete?.();
    } catch {}
  }
}

function pairsToBondIndices(
  rdkit: any,
  smiles: string,
  pairs: Array<[number, number]>
): number[] {
  if (pairs.length === 0) return [];
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return [];
    const mJson = JSON.parse(mol.get_json()).molecules?.[0];
    if (!mJson?.bonds) return [];
    const pairKeys = new Set(
      pairs.map(([u, v]) => (u < v ? `${u}:${v}` : `${v}:${u}`))
    );
    const indices: number[] = [];
    mJson.bonds.forEach((b: { atoms: [number, number] }, idx: number) => {
      const [u, v] = b.atoms;
      const k = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (pairKeys.has(k)) indices.push(idx);
    });
    return indices;
  } catch {
    return [];
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

const speciesHighlightCache = new WeakMap<object, Map<string, SpeciesBondHighlights>>();

/**
 * Computes exact RDKit bond indices for newly formed (or bond-order-upgraded) bonds
 * across a PredictedSpecies' mechanistic cascade.
 */
export function computeSpeciesHighlightBonds(
  rdkit: any,
  species: PredictedSpecies
): SpeciesBondHighlights {
  if (!rdkit || !species || !species.bestChain || species.bestChain.length === 0) {
    return { allNewBonds: [], lastStepBonds: [] };
  }

  let cache = speciesHighlightCache.get(rdkit);
  if (!cache) {
    cache = new Map();
    speciesHighlightCache.set(rdkit, cache);
  }

  const cacheKey = `${species.smiles}::${species.bestChain
    .map((s) => `${s.ruleId}:${s.reactantSmiles.join('+')}`)
    .join('>')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prevPairsBySmiles = new Map<string, Array<[number, number]>>();
  let finalAllPairs: Array<[number, number]> = [];
  let finalStepPairs: Array<[number, number]> = [];

  for (let i = 0; i < species.bestChain.length; i++) {
    const step = species.bestChain[i];
    const isLast = i === species.bestChain.length - 1;
    let prodSmiles = isLast ? species.smiles : step.productSmiles;

    // Legacy fallback: infer intermediate product SMILES from next step's reactants if omitted
    if (!prodSmiles && !isLast) {
      const nextStep = species.bestChain[i + 1];
      const nextReacts = nextStep?.reactantSmiles || [];
      for (const cand of nextReacts) {
        const resCand = traceSingleStepPairs(rdkit, step, cand, prevPairsBySmiles);
        if (resCand.stepPairs.length > 0 || resCand.allPairs.length > 0) {
          prodSmiles = cand;
          prevPairsBySmiles.set(cand, resCand.allPairs);
          prevPairsBySmiles.set(stripStereoFromSmiles(rdkit, cand), resCand.allPairs);
          break;
        }
      }
      continue;
    }

    if (!prodSmiles) {
      if (isLast) {
        const res = traceSingleStepPairs(rdkit, step, species.smiles, prevPairsBySmiles);
        finalAllPairs = res.allPairs;
        finalStepPairs = res.stepPairs;
      }
      continue;
    }

    const res = traceSingleStepPairs(rdkit, step, prodSmiles, prevPairsBySmiles);
    prevPairsBySmiles.set(prodSmiles, res.allPairs);
    prevPairsBySmiles.set(stripStereoFromSmiles(rdkit, prodSmiles), res.allPairs);
    if (isLast) {
      finalAllPairs = res.allPairs;
      finalStepPairs = res.stepPairs;
    }
  }

  const result: SpeciesBondHighlights = {
    allNewBonds: pairsToBondIndices(rdkit, species.smiles, finalAllPairs),
    lastStepBonds: pairsToBondIndices(rdkit, species.smiles, finalStepPairs),
  };

  cache.set(cacheKey, result);
  return result;
}
