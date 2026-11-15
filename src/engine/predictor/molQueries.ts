// Robowski Studio - RDKit substructure counting and step atom-balance helpers

const qmolCache = new WeakMap<object, Map<string, any>>();

function getQmol(rdkit: any, smarts: string): any | null {
  if (!rdkit || typeof rdkit.get_qmol !== 'function') return null;
  let m = qmolCache.get(rdkit);
  if (!m) {
    m = new Map();
    qmolCache.set(rdkit, m);
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

/** Number of distinct substructure matches of a SMARTS pattern in a molecule (0 on any failure). */
export function countSubstruct(rdkit: any, smiles: string, smarts: string): number {
  const q = getQmol(rdkit, smarts);
  if (!q) return 0;
  let mol: any = null;
  try {
    mol = rdkit.get_mol(smiles);
    if (!mol || !mol.is_valid()) return 0;
    const raw = mol.get_substruct_matches(q);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  } finally {
    try {
      mol?.delete?.();
    } catch {}
  }
}

/** Element counts from a Hill-style formula such as C13H11N or C27H22N6O. */
export function parseFormula(formula: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /([A-Z][a-z]?)(\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    if (!m[1]) continue;
    out[m[1]] = (out[m[1]] || 0) + (m[2] ? parseInt(m[2], 10) : 1);
  }
  return out;
}

/**
 * Atom bookkeeping for one reaction step. Hydrogen and oxygen may move (water, hydroxide), but every other
 * element must be conserved exactly (or, for steps that shed a leaving group, never increase), and oxygen
 * may never be created. Stops templates that silently delete unmapped atoms from entering the pool.
 */
export function stepIsAtomBalanced(
  reactantFormulas: string[],
  productFormulas: string[],
  allowLeavingGroup = false
): boolean {
  const sum = (fs: string[]) => {
    const t: Record<string, number> = {};
    for (const f of fs) {
      const p = parseFormula(f);
      for (const k of Object.keys(p)) t[k] = (t[k] || 0) + p[k];
    }
    return t;
  };
  const r = sum(reactantFormulas);
  const p = sum(productFormulas);
  const elements = new Set([...Object.keys(r), ...Object.keys(p)]);
  for (const el of elements) {
    if (el === 'H') continue;
    const a = r[el] || 0;
    const b = p[el] || 0;
    if (el === 'O') {
      if (b > a) return false;
      continue;
    }
    if (allowLeavingGroup ? b > a : a !== b) return false;
  }
  return true;
}
