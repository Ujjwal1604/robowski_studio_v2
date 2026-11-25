// Robowski Studio - RDKit Graph-Level Intelligence (Local Sterics, Hammett Electronics, Anti-Bredt & pKa Shifts)

export interface ParsedAtom {
  idx: number;
  z: number; // atomic number
  chg: number;
  impHs: number;
  isAromatic: boolean;
}

export interface ParsedBond {
  idx: number;
  a: number;
  b: number;
  bo: number; // 1, 2, 3
  isAromatic: boolean;
}

export interface MolGraph {
  smiles: string;
  atoms: ParsedAtom[];
  bonds: ParsedBond[];
  adj: Array<Array<{ to: number; bo: number; isAromatic: boolean; bondIdx: number }>>;
  atomRings: number[][]; // SSSR rings directly from RDKit CommonChem extensions
  ringIndicesByAtom: number[][]; // indices into atomRings containing each atom
  numBridgeheadAtoms: number;
  numAromaticRings: number;
}

const graphCache = new WeakMap<object, Map<string, MolGraph | null>>();
const qmolLocalCache = new WeakMap<object, Map<string, any>>();

function getCachedQmol(rdkit: any, smarts: string): any | null {
  if (!rdkit || typeof rdkit.get_qmol !== 'function') return null;
  let m = qmolLocalCache.get(rdkit);
  if (!m) {
    m = new Map();
    qmolLocalCache.set(rdkit, m);
  }
  if (m.has(smarts)) return m.get(smarts);
  let q: any = null;
  try {
    q = rdkit.get_qmol(smarts) || null;
  } catch {
    q = null;
  }
  m.set(smarts, q);
  return q;
}

/** Parse and cache a molecule's atom/bond/ring graph via RDKit CommonChem JSON + descriptors. */
export function parseMolGraph(rdkit: any, smiles: string): MolGraph | null {
  if (!rdkit || !smiles) return null;
  let cache = graphCache.get(rdkit);
  if (!cache) {
    cache = new Map();
    graphCache.set(rdkit, cache);
  }
  if (cache.has(smiles)) return cache.get(smiles) || null;
  if (cache.size > 1500) {
    let count = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++count >= 400) break;
    }
  }

  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) {
      cache.set(smiles, null);
      return null;
    }
    const rawJson = mol.get_json();
    const rawDesc = mol.get_descriptors();
    const parsed = JSON.parse(rawJson || '{}');
    const desc = JSON.parse(rawDesc || '{}');
    const molObj = parsed?.molecules?.[0];
    if (!molObj || !Array.isArray(molObj.atoms)) {
      cache.set(smiles, null);
      return null;
    }

    const repExt = Array.isArray(molObj.extensions)
      ? molObj.extensions.find((e: any) => e?.name === 'rdkitRepresentation') || molObj.extensions[0]
      : null;

    const aromAtomSet = new Set<number>(Array.isArray(repExt?.aromaticAtoms) ? repExt.aromaticAtoms : []);
    const aromBondSet = new Set<number>(Array.isArray(repExt?.aromaticBonds) ? repExt.aromaticBonds : []);
    const atomRings: number[][] = Array.isArray(repExt?.atomRings) ? repExt.atomRings : [];

    const atoms: ParsedAtom[] = molObj.atoms.map((a: any, idx: number) => ({
      idx,
      z: Number(a.z ?? 6),
      chg: Number(a.chg ?? 0),
      impHs: Number(a.impHs ?? 0),
      isAromatic: aromAtomSet.has(idx),
    }));

    const bonds: ParsedBond[] = (molObj.bonds || []).map((b: any, idx: number) => ({
      idx,
      a: Number(b.atoms?.[0] ?? 0),
      b: Number(b.atoms?.[1] ?? 0),
      bo: Number(b.bo ?? 1),
      isAromatic: aromBondSet.has(idx),
    }));

    const adj: MolGraph['adj'] = Array.from({ length: atoms.length }, () => []);
    for (const b of bonds) {
      if (atoms[b.a] && atoms[b.b]) {
        adj[b.a].push({ to: b.b, bo: b.bo, isAromatic: b.isAromatic, bondIdx: b.idx });
        adj[b.b].push({ to: b.a, bo: b.bo, isAromatic: b.isAromatic, bondIdx: b.idx });
      }
    }

    const ringIndicesByAtom: number[][] = Array.from({ length: atoms.length }, () => []);
    for (let ri = 0; ri < atomRings.length; ri++) {
      for (const atomIdx of atomRings[ri]) {
        if (ringIndicesByAtom[atomIdx]) ringIndicesByAtom[atomIdx].push(ri);
      }
    }

    const graph: MolGraph = {
      smiles,
      atoms,
      bonds,
      adj,
      atomRings,
      ringIndicesByAtom,
      numBridgeheadAtoms: Number(desc.NumBridgeheadAtoms) || 0,
      numAromaticRings: Number(desc.NumAromaticRings) || 0,
    };
    cache.set(smiles, graph);
    return graph;
  } catch {
    cache.set(smiles, null);
    return null;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

/**
 * Rejects physically impossible anti-Bredt bridgehead double bonds (double bond at a non-aromatic bridged
 * bicyclic bridgehead where the bridged cage rings are <= 7 atoms).
 */
export function hasAntiBredtDoubleBond(rdkit: any, smiles: string): boolean {
  const g = parseMolGraph(rdkit, smiles);
  if (!g || g.numBridgeheadAtoms === 0) return false;

  for (const atom of g.atoms) {
    if (atom.isAromatic) continue;
    const rIdxs = g.ringIndicesByAtom[atom.idx];
    if (!rIdxs || rIdxs.length < 2) continue;

    // Check if any pair of rings through this atom share >= 3 atoms (true bridged system, not simple fused/spiro)
    let isBridgedSmallCage = false;
    for (let i = 0; i < rIdxs.length; i++) {
      for (let j = i + 1; j < rIdxs.length; j++) {
        const r1 = g.atomRings[rIdxs[i]];
        const r2 = g.atomRings[rIdxs[j]];
        const set1 = new Set(r1);
        let shared = 0;
        for (const a of r2) if (set1.has(a)) shared++;
        if (shared >= 3 && Math.max(r1.length, r2.length) <= 7) {
          isBridgedSmallCage = true;
          break;
        }
      }
      if (isBridgedSmallCage) break;
    }
    if (!isBridgedSmallCage) continue;

    // A bridgehead atom in a bridged cage has >= 3 ring neighbors; check if it carries an endocyclic double bond
    const ringNeighbors = g.adj[atom.idx].filter((e) => (g.ringIndicesByAtom[e.to]?.length || 0) > 0);
    if (ringNeighbors.length < 3) continue;

    const hasEndoDouble = ringNeighbors.some((e) => e.bo === 2 && !e.isAromatic);
    if (hasEndoDouble) {
      return true;
    }
  }

  return false;
}

export interface LocalRingSubstituents {
  ewgStrength: number; // positive = electron-withdrawing (ortho/para NO2, CN, CF3, C=O, SO2, ring-N, halogens)
  edgStrength: number; // positive = electron-donating (ortho/para NR2, OR, OH, alkyl)
  orthoBlockers: number; // weighted count of non-H substituents at ortho positions
}

function classifyRingSubstituent(
  g: MolGraph,
  ringAtomIdx: number,
  subIdx: number
): { ewg: number; edg: number; bulky: number } {
  const atom = g.atoms[subIdx];
  if (!atom) return { ewg: 0, edg: 0, bulky: 0 };
  const neighbors = g.adj[subIdx].filter((e) => e.to !== ringAtomIdx);

  if (atom.z === 9) return { ewg: 0.35, edg: 0, bulky: 0.3 };
  if (atom.z === 17 || atom.z === 35 || atom.z === 53) return { ewg: 0.45, edg: 0, bulky: 0.85 };

  if (atom.z === 7) {
    const oxyCount = neighbors.filter((e) => g.atoms[e.to]?.z === 8).length;
    if (oxyCount >= 2) return { ewg: 1.4, edg: 0, bulky: 1.0 };
    const hasAcyl = neighbors.some((e) => {
      const nz = g.atoms[e.to]?.z;
      return (nz === 6 || nz === 16) && g.adj[e.to].some((ee) => ee.bo === 2 && g.atoms[ee.to]?.z === 8);
    });
    if (hasAcyl) return { ewg: 0, edg: 0.35, bulky: 1.0 };
    return { ewg: 0, edg: 1.15, bulky: neighbors.length >= 2 ? 1.1 : 0.7 };
  }

  if (atom.z === 8) {
    const hasAcyl = neighbors.some(
      (e) => g.atoms[e.to]?.z === 6 && g.adj[e.to].some((ee) => ee.bo === 2 && g.atoms[ee.to]?.z === 8)
    );
    if (hasAcyl) return { ewg: 0.15, edg: 0.1, bulky: 1.0 };
    return { ewg: 0, edg: 0.85, bulky: neighbors.length > 0 ? 0.85 : 0.55 };
  }

  if (atom.z === 16) {
    const dblO = neighbors.filter((e) => e.bo === 2 && g.atoms[e.to]?.z === 8).length;
    if (dblO >= 2) return { ewg: 1.15, edg: 0, bulky: 1.15 };
    return { ewg: 0, edg: 0.25, bulky: 0.9 };
  }

  if (atom.z === 6) {
    if (neighbors.some((e) => e.bo === 3 && g.atoms[e.to]?.z === 7)) {
      return { ewg: 1.1, edg: 0, bulky: 0.5 };
    }
    const haloCount = neighbors.filter((e) => g.atoms[e.to]?.z === 9 || g.atoms[e.to]?.z === 17).length;
    if (haloCount >= 2) {
      return { ewg: 0.9, edg: 0, bulky: 1.1 };
    }
    if (neighbors.some((e) => e.bo === 2 && g.atoms[e.to]?.z === 8)) {
      return { ewg: 0.85, edg: 0, bulky: 0.95 };
    }
    const heavyDeg = neighbors.length;
    return { ewg: 0, edg: 0.25, bulky: heavyDeg >= 3 ? 1.5 : heavyDeg === 2 ? 1.1 : 0.85 };
  }

  return { ewg: 0, edg: 0, bulky: 0.7 };
}

/**
 * Inspects the 6-membered aromatic ring containing `anchorRingAtomIdx` directly from RDKit's SSSR `atomRings`
 * and computes strictly local ortho/para Hammett electronics and ortho steric crowding.
 */
export function inspectAromaticRingAtAtom(g: MolGraph, anchorRingAtomIdx: number): LocalRingSubstituents {
  const out: LocalRingSubstituents = { ewgStrength: 0, edgStrength: 0, orthoBlockers: 0 };
  const anchor = g.atoms[anchorRingAtomIdx];
  if (!anchor || !anchor.isAromatic) return out;

  const rIdxs = g.ringIndicesByAtom[anchorRingAtomIdx] || [];
  let ring6: number[] | null = null;
  for (const ri of rIdxs) {
    const r = g.atomRings[ri];
    if (r && r.length === 6 && r.every((a) => g.atoms[a]?.isAromatic)) {
      ring6 = r;
      break;
    }
  }
  if (!ring6) return out;

  const anchorPos = ring6.indexOf(anchorRingAtomIdx);
  if (anchorPos < 0) return out;

  // Rotate ring6 so anchorRingAtomIdx is at index 0
  const ordered = [...ring6.slice(anchorPos), ...ring6.slice(0, anchorPos)];
  const ringSet = new Set(ordered);

  for (let pos = 1; pos <= 5; pos++) {
    const atomIdx = ordered[pos];
    const isOrtho = pos === 1 || pos === 5;
    const isPara = pos === 3;
    const isMeta = pos === 2 || pos === 4;

    if (g.atoms[atomIdx].z === 7 && g.atoms[atomIdx].impHs === 0) {
      out.ewgStrength += isOrtho || isPara ? 0.9 : 0.45;
    }

    const exoNeighbors = g.adj[atomIdx].filter((e) => !ringSet.has(e.to));
    for (const edge of exoNeighbors) {
      const cls = classifyRingSubstituent(g, atomIdx, edge.to);
      if (isOrtho) {
        out.orthoBlockers += cls.bulky;
        out.ewgStrength += cls.ewg * 0.95;
        out.edgStrength += cls.edg * 0.85;
      } else if (isPara) {
        out.ewgStrength += cls.ewg * 1.0;
        out.edgStrength += cls.edg * 1.0;
      } else if (isMeta) {
        out.ewgStrength += cls.ewg * 0.4;
      }
    }
  }

  return out;
}

const siteMatchCache = new WeakMap<object, Map<string, {
  matched: boolean;
  localAlphaBranching: number;
  localTertButylCount: number;
  ring: LocalRingSubstituents | null;
}>>();

/**
 * Evaluates local steric crowding & electronic score around the first matched atom of `smarts` in `smiles`.
 */
export function inspectMatchedSite(
  rdkit: any,
  smiles: string,
  smarts: string
): {
  matched: boolean;
  localAlphaBranching: number;
  localTertButylCount: number;
  ring: LocalRingSubstituents | null;
} {
  const empty = { matched: false, localAlphaBranching: 0, localTertButylCount: 0, ring: null };
  if (!rdkit || !smiles) return empty;

  let mCache = siteMatchCache.get(rdkit);
  if (!mCache) {
    mCache = new Map();
    siteMatchCache.set(rdkit, mCache);
  }
  const key = `${smiles}::${smarts}`;
  const cached = mCache.get(key);
  if (cached) return cached;
  if (mCache.size > 3000) mCache.clear();

  const q = getCachedQmol(rdkit, smarts);
  if (!q) {
    mCache.set(key, empty);
    return empty;
  }

  let mol: any = null;
  let atomIdx = -1;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) {
      mCache.set(key, empty);
      return empty;
    }
    const raw = mol.get_substruct_match(q);
    if (!raw || raw === '{}') {
      mCache.set(key, empty);
      return empty;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.atoms) || parsed.atoms.length === 0) {
      mCache.set(key, empty);
      return empty;
    }
    atomIdx = Number(parsed.atoms[0]);
  } catch {
    mCache.set(key, empty);
    return empty;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }

  const g = parseMolGraph(rdkit, smiles);
  if (!g || atomIdx < 0 || !g.atoms[atomIdx]) {
    mCache.set(key, empty);
    return empty;
  }

  let ring: LocalRingSubstituents | null = null;
  if (g.atoms[atomIdx].isAromatic) {
    ring = inspectAromaticRingAtAtom(g, atomIdx);
  } else {
    const aromNbr = g.adj[atomIdx].find((e) => g.atoms[e.to]?.isAromatic);
    if (aromNbr) {
      ring = inspectAromaticRingAtAtom(g, aromNbr.to);
    }
  }

  let localAlphaBranching = 0;
  let localTertButylCount = 0;
  const seenTbu = new Set<number>();

  const isTertButylCenter = (idx: number) => {
    const a = g.atoms[idx];
    if (!a || a.z !== 6 || a.isAromatic || a.impHs !== 0) return false;
    const methyls = g.adj[idx].filter(
      (e) => g.atoms[e.to]?.z === 6 && g.atoms[e.to]?.impHs === 3 && g.adj[e.to].length === 1
    );
    return methyls.length >= 3;
  };

  for (const e1 of g.adj[atomIdx]) {
    const n1 = g.atoms[e1.to];
    if (!n1 || n1.z !== 6 || n1.isAromatic) continue;
    const heavyDeg = g.adj[e1.to].filter((ee) => ee.to !== atomIdx && g.atoms[ee.to]?.z !== 1).length;
    localAlphaBranching = Math.max(localAlphaBranching, heavyDeg);
    if (isTertButylCenter(e1.to) && !seenTbu.has(e1.to)) {
      seenTbu.add(e1.to);
      localTertButylCount++;
    }
    for (const e2 of g.adj[e1.to]) {
      if (e2.to === atomIdx) continue;
      if (isTertButylCenter(e2.to) && !seenTbu.has(e2.to)) {
        seenTbu.add(e2.to);
        localTertButylCount++;
      }
    }
  }

  const out = { matched: true, localAlphaBranching, localTertButylCount, ring };
  mCache.set(key, out);
  return out;
}

/**
 * Computes a substituent-aware DMSO pKa shift for an ionizable site at `atomIdx` (for anilines, phenols,
 * pyridines, and carboxylic acids) using local aromatic/inductive neighbors.
 */
export function computeLocalPkaShift(
  rdkit: any,
  smiles: string,
  atomIdx: number,
  siteId: string
): number {
  const g = parseMolGraph(rdkit, smiles);
  if (!g || !g.atoms[atomIdx]) return 0;

  if (siteId === 'site_aniline' || siteId === 'site_phenol') {
    const aromNbr = g.adj[atomIdx].find((e) => g.atoms[e.to]?.isAromatic);
    if (!aromNbr) return 0;
    const ring = inspectAromaticRingAtAtom(g, aromNbr.to);
    const ewgSlope = siteId === 'site_phenol' ? -4.2 : -2.2;
    const edgSlope = siteId === 'site_phenol' ? 1.4 : 1.1;
    const delta = ring.ewgStrength * ewgSlope + ring.edgStrength * edgSlope;
    return Math.max(-7.5, Math.min(2.5, Math.round(delta * 10) / 10));
  }

  if (siteId === 'site_pyridine') {
    const ring = inspectAromaticRingAtAtom(g, atomIdx);
    const delta = ring.ewgStrength * -2.0 + ring.edgStrength * 1.4;
    return Math.max(-4.5, Math.min(3.0, Math.round(delta * 10) / 10));
  }

  if (siteId === 'site_carboxylic_acid') {
    const alphaC = g.adj[atomIdx].find((e) => g.atoms[e.to]?.z === 6);
    if (!alphaC) return 0;
    if (g.atoms[alphaC.to].isAromatic) {
      const ring = inspectAromaticRingAtAtom(g, alphaC.to);
      const delta = ring.ewgStrength * -1.4 + ring.edgStrength * 0.7;
      return Math.max(-3.5, Math.min(1.5, Math.round(delta * 10) / 10));
    }
    const alphaHalos = g.adj[alphaC.to].filter(
      (e) => e.to !== atomIdx && (g.atoms[e.to]?.z === 9 || g.atoms[e.to]?.z === 17 || g.atoms[e.to]?.z === 35)
    ).length;
    if (alphaHalos > 0) {
      return Math.max(-9.0, -2.8 * alphaHalos);
    }
  }

  return 0;
}
