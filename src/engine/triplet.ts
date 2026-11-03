// Robowski Studio - Triplet Plate Mode Logic
import { Reagent, RunState, TripletPlate, TripletSetup, TripletGroup } from '../types';

export function triPresetData(key: string): { size: number; ratios: number[][] } {
  const rot = (n: number, hi: number) =>
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? hi : 1)));
  if (key === 'doublet') return { size: 2, ratios: rot(2, 2) };
  if (key === 'quartet') return { size: 4, ratios: rot(4, 2) };
  return { size: 3, ratios: rot(3, 2) };
}

export function triDefault(): TripletSetup {
  return {
    base: 50,
    ratios: triPresetData('triplet').ratios,
    adds: [
      { code: 'Ac', equiv: 0.5 },
      { code: 'Ba', equiv: 0.5 },
    ],
    groups: [],
    plates: [{ sections: [] }, null, null],
  };
}

export function triReagents(): Reagent[] {
  return ['A', 'B', 'C', 'D', 'E', 'F', 'Ac', 'Ba'].map((code) => ({
    code,
    name: '',
    molarMass: '',
    density: '',
    stock: '',
    solvent: 'ethanol',
    min: '',
    step: '',
    max: '',
    pipettingMode: 'empty',
  }));
}

export function triSize(st: RunState): number {
  const t = st.tri;
  if (!t) return 3;
  return t.ratios.length ? t.ratios[0].length : 3;
}

export function triGeom(st: RunState) {
  const t = st.tri || triDefault();
  const c = Math.max(1, t.ratios.length);
  const r = Math.max(1, t.adds.length);
  const across = Math.floor(9 / c);
  const down = Math.floor(6 / r);
  return {
    c,
    r,
    across,
    down,
    n: across * down,
    leftover: 54 - across * down * c * r,
  };
}

export function triFlat(pl: TripletPlate | null | undefined, st: RunState): boolean {
  return !!(pl && pl.flat && st.tri && st.tri.derivedRatio === 'equal');
}

export function triReps(_st?: RunState): number {
  return 1;
}

export function triBlock(st: RunState): number {
  const adds = st.tri?.adds || [];
  return Math.max(1, adds.length) * triReps(st);
}

export function triSlots(pl: TripletPlate | null | undefined, st: RunState): number {
  return triFlat(pl, st) ? Math.floor(54 / triBlock(st)) : triGeom(st).n;
}

export function triSync(st: RunState): void {
  if (!st.tri) st.tri = triDefault();
  const t = st.tri;
  const size = triSize(st);
  const codes = new Set(st.reagents.map((r) => r.code));
  if (t.derivedRatio !== 'equal') t.derivedRatio = 'keep';

  t.ratios.forEach((v) => {
    while (v.length < size) v.push(1);
    v.length = size;
  });

  t.adds.forEach((a) => {
    if (a.code && !codes.has(a.code)) a.code = '';
  });

  t.groups.forEach((g) => {
    g.members = (g.members || []).slice(0, size);
    while (g.members.length < size) g.members.push('');
    g.members = g.members.map((m) => (codes.has(m) ? m : ''));
  });

  const ids = new Set(t.groups.map((g) => g.id));
  t.plates = [
    t.plates[0] === undefined ? { sections: [] } : t.plates[0],
    t.plates[1] || null,
    t.plates[2] || null,
  ];

  t.plates.forEach((p) => {
    if (!p) return;
    const n = triSlots(p, st);
    p.sections = (p.sections || []).slice(0, n);
    while (p.sections.length < n) p.sections.push('');
    p.sections = p.sections.map((x) => (ids.has(x) ? x : ''));
  });
}

export function triUsedCodes(st: RunState): Set<string> {
  const u = new Set<string>();
  if (!st.tri) return u;
  st.tri.adds.forEach((a) => {
    if (a.code) u.add(a.code);
  });
  st.tri.groups.forEach((g) =>
    g.members.forEach((m) => {
      if (m) u.add(m);
    })
  );
  return u;
}

export function triStats(st: RunState) {
  const g = triGeom(st);
  const used = (st.tri?.plates || [])
    .map((p, i) => (p ? { i, filled: p.sections.filter(Boolean).length } : null))
    .filter(Boolean) as Array<{ i: number; filled: number }>;
  const sections = used.reduce((a, u) => a + u.filled, 0);
  const wells = used.reduce(
    (a, u) =>
      a + u.filled * (triFlat(st.tri?.plates[u.i], st) ? triBlock(st) : g.c * g.r),
    0
  );
  return { g, used, plates: used.length, sections, wells };
}

export function triGroupName(st: RunState): string {
  return (
    ({ 2: 'doublet', 3: 'triplet', 4: 'quartet' } as Record<number, string>)[
      triSize(st)
    ] || 'group'
  );
}

export function triDetectPreset(st: RunState): string {
  const t = st.tri;
  if (!t) return 'triplet';
  const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of ['triplet', 'doublet', 'quartet']) {
    if (same(t.ratios, triPresetData(k).ratios)) return k;
  }
  return 'custom';
}

export function triNewGroup(st: RunState): TripletGroup {
  const size = triSize(st);
  const t = st.tri || triDefault();
  const add = new Set(t.adds.map((a) => a.code));
  const chems = st.reagents.map((r) => r.code).filter((c) => !add.has(c));
  const taken = new Set(t.groups.map((g) => g.members.join('|')));
  let pick: string[] | null = null;

  (function rec(start: number, cur: string[]) {
    if (pick) return;
    if (cur.length === size) {
      if (!taken.has(cur.join('|'))) pick = [...cur];
      return;
    }
    for (let i = start; i < chems.length && !pick; i++) rec(i + 1, [...cur, chems[i]]);
  })(0, []);

  if (!pick) pick = chems.slice(0, size);
  while ((pick as string[]).length < size) (pick as string[]).push('');

  const pre = ({ 2: 'D', 3: 'T', 4: 'Q' } as Record<number, string>)[size] || 'G';
  const names = new Set(t.groups.map((g) => g.name));
  let k = 1;
  while (names.has(pre + k)) k++;
  return {
    id: Math.random().toString(36).slice(2, 8),
    name: pre + k,
    members: pick as string[],
  };
}

export function triColumnFor(g: TripletGroup, c: number, st: RunState): number[] {
  const base = (st.tri?.ratios || [])[c] || [];
  if (!g.derived) return base;
  const eq = st.tri?.derivedRatio === 'equal';
  return g.members.map((m, j) => (m ? (eq ? 1 : base[j] ?? 1) : 0));
}

export function triCombos(n: number, k: number): number[][] {
  const out: number[][] = [];
  (function rec(st: number, cur: number[]) {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = st; i < n; i++) rec(i + 1, [...cur, i]);
  })(0, []);
  return out;
}

export function triDerive(
  p: number,
  src: number,
  st: RunState
): { counts: Record<number, number>; placed: number[]; overflow: number } | null {
  const t = st.tri;
  if (!t) return null;
  const g = triGeom(st);
  const size = triSize(st);
  const sp = t.plates[src];
  if (!sp || !g.n) return null;

  const base: TripletGroup[] = [];
  const seenG = new Set<string>();
  sp.sections.forEach((id) => {
    if (!id || seenG.has(id)) return;
    seenG.add(id);
    const gr = t.groups.find((x) => x.id === id);
    if (gr && !gr.derived && gr.members.every(Boolean)) base.push(gr);
  });
  if (!base.length) return null;

  const seen = new Set(base.map((gr) => [...gr.members].sort().join('|')));
  const made: string[] = [];
  const counts: Record<number, number> = {};

  for (let keep = size - 1; keep >= 1; keep--) {
    base.forEach((gr) =>
      triCombos(size, keep).forEach((idx) => {
        const key = idx.map((i) => gr.members[i]).sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        const members = Array(size).fill('');
        idx.forEach((i) => {
          members[i] = gr.members[i];
        });
        let grp = t.groups.find((x) => x.derived && x.members.join('|') === members.join('|'));
        if (!grp) {
          const names = new Set(t.groups.map((x) => x.name));
          let nm = members.filter(Boolean).join('+');
          let k = 2;
          while (names.has(nm)) nm = members.filter(Boolean).join('+') + ' #' + k++;
          grp = { id: Math.random().toString(36).slice(2, 8), name: nm, members, derived: true };
          t.groups.push(grp);
        }
        made.push(grp.id);
        counts[keep] = (counts[keep] || 0) + 1;
      })
    );
  }

  let k = 0;
  const placed: number[] = [];
  for (let pp = p; pp <= 2 && k < made.length; pp++) {
    if (pp === src) continue;
    if (!t.plates[pp]) t.plates[pp] = { sections: [] };
    t.plates[pp]!.flat = t.derivedRatio === 'equal';
    const nsl = triSlots(t.plates[pp], st);
    const secs = Array(nsl).fill('');
    for (let i = 0; i < nsl && k < made.length; i++) secs[i] = made[k++];
    t.plates[pp]!.sections = secs;
    placed.push(pp);
  }
  triSync(st);
  return { counts, placed, overflow: made.length - k };
}

export function triDeriveAll(
  p: number,
  st: RunState
): { pairs: number; singles: number; pool: string[]; placed: number[]; overflow: number } | null {
  const t = st.tri;
  if (!t) return null;
  const size = triSize(st);
  const add = new Set(t.adds.map((a) => a.code));
  const chem = st.reagents.filter((r) => !add.has(r.code));
  const used = chem.filter((r) => r.name || (r.stock !== '' && r.stock != null));
  const pool = (used.length >= 2 ? used : chem).map((r) => r.code);
  if (pool.length < 2 || size < 2) return null;

  const mk = (codes: string[], scale: number) => {
    const members = Array(size).fill('');
    codes.forEach((c, i) => {
      members[i] = c;
    });
    const key = [...codes].sort().join('|') + '#' + scale;
    let grp = t.groups.find(
      (x) => x.derived && [...x.members].filter(Boolean).sort().join('|') + '#' + (x.scale || 1) === key
    );
    if (!grp) {
      const names = new Set(t.groups.map((x) => x.name));
      let nm = codes.join('+') + (scale > 1 ? ' (' + scale + ' eq)' : '');
      let k = 2;
      const b0 = nm;
      while (names.has(nm)) nm = b0 + ' #' + k++;
      grp = { id: Math.random().toString(36).slice(2, 8), name: nm, members, derived: true };
      if (scale > 1) grp.scale = scale;
      t.groups.push(grp);
    }
    return grp.id;
  };

  const made: string[] = [];
  let pairs = 0,
    singles = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      made.push(mk([pool[i], pool[j]], 1));
      pairs++;
    }
  }
  for (const sc of [1, 2]) {
    pool.forEach((c) => {
      made.push(mk([c], sc));
      singles++;
    });
  }

  t.derivedRatio = 'equal';
  let k = 0;
  const placed: number[] = [];
  for (let pp = p; pp <= 2 && k < made.length; pp++) {
    if (!t.plates[pp]) t.plates[pp] = { sections: [] };
    t.plates[pp]!.flat = true;
    const n = triSlots(t.plates[pp], st);
    const secs = Array(n).fill('');
    for (let i = 0; i < n && k < made.length; i++) secs[i] = made[k++];
    t.plates[pp]!.sections = secs;
    placed.push(pp);
  }
  t.plates.forEach((pl) => {
    if (pl && !pl.flat) pl.flat = false;
  });
  triSync(st);
  return { pairs, singles, pool, placed, overflow: made.length - k };
}

export function triBuildRows(st: RunState): {
  rows: number[][];
  blank: Set<number>;
  meta: Array<{ plate: number; well: number; section?: number; group?: string; cond?: string; blank: boolean }>;
} | null {
  const t = st.tri;
  if (!t) return null;
  const g = triGeom(st);
  if (!g.n) throw new Error('This pattern does not fit on a 6 × 9 plate. Use fewer ratios or additive rows.');
  const idxOf = (code: string) => st.reagents.findIndex((r) => r.code === code);
  const base = +t.base;
  const rows: number[][] = [];
  const blank = new Set<number>();
  const meta: Array<{
    plate: number;
    well: number;
    section?: number;
    group?: string;
    cond?: string;
    blank: boolean;
  }> = [];

  t.plates.forEach((pl, p) => {
    if (!pl) return;
    if (triFlat(pl, st)) {
      const reps = triReps(st);
      const nad = Math.max(1, t.adds.length);
      const blockN = nad * reps;
      const wells: Array<{
        plate: number;
        well: number;
        section?: number;
        group?: string;
        cond?: string;
        blank: boolean;
      }> = Array.from({ length: 54 }, (_, w) => ({ plate: p, well: w, blank: true }));
      const vecs: (number[] | null)[] = Array(54).fill(null);

      pl.sections.forEach((id, si) => {
        const grp = id && t.groups.find((x) => x.id === id);
        if (!grp) return;
        for (let a = 0; a < nad; a++) {
          for (let rp = 0; rp < reps; rp++) {
            const w = si * blockN + a * reps + rp;
            if (w >= 54) continue;
            const vec = new Array(st.reagents.length).fill(0);
            const ratios = triColumnFor(grp, 0, st);
            const ad = t.adds[a];
            grp.members.forEach((m, j) => {
              if (!m) return;
              const i = idxOf(m);
              if (i < 0) throw new Error(`${grp.name}: reagent ${m} does not exist.`);
              vec[i] += ratios[j] * (grp.scale || 1) * base;
            });
            if (ad && ad.code) {
              const i = idxOf(ad.code);
              if (i >= 0) vec[i] += +ad.equiv * base;
            }
            vecs[w] = vec;
            wells[w] = {
              plate: p,
              well: w,
              section: si + 1,
              group: grp.name,
              cond:
                ratios
                  .filter((_, j) => grp.members[j])
                  .map((v) => v * (grp.scale || 1))
                  .join(':') + (ad && ad.code ? ' + ' + ad.code : ''),
              blank: false,
            };
          }
        }
      });
      for (let w = 0; w < 54; w++) {
        rows.push((vecs[w] || new Array(st.reagents.length).fill(0)).map((v) => Math.round(v * 1e9) / 1e9));
        if (wells[w].blank) blank.add(rows.length - 1);
        meta.push(wells[w]);
      }
      return;
    }

    for (let w = 0; w < 54; w++) {
      const row = Math.floor(w / 9);
      const col = w % 9;
      const vec = new Array(st.reagents.length).fill(0);
      const sr = Math.floor(row / g.r);
      const sc = Math.floor(col / g.c);
      let info: {
        plate: number;
        well: number;
        section?: number;
        group?: string;
        cond?: string;
        blank: boolean;
      } = { plate: p, well: w, blank: true };

      if (sr < g.down && sc < g.across) {
        const si = sr * g.across + sc;
        const id = pl.sections[si];
        const grp = id && t.groups.find((x) => x.id === id);
        if (grp) {
          if (!grp.derived && grp.members.some((m) => !m)) {
            throw new Error(`${grp.name}: pick a reagent for every position.`);
          }
          const c = col % g.c;
          const a = row % g.r;
          const ratios = triColumnFor(grp, c, st);
          const ad = t.adds[a];
          grp.members.forEach((m, j) => {
            if (!m) return;
            const i = idxOf(m);
            if (i < 0) throw new Error(`${grp.name}: reagent ${m} does not exist.`);
            vec[i] += ratios[j] * base;
          });
          if (ad && ad.code) {
            const i = idxOf(ad.code);
            if (i >= 0) vec[i] += +ad.equiv * base;
          }
          info = {
            plate: p,
            well: w,
            section: si + 1,
            group: grp.name,
            cond:
              ratios.filter((_, j) => grp.members[j]).join(':') + (ad && ad.code ? ' + ' + ad.code : ''),
            blank: false,
          };
        }
      }
      rows.push(vec.map((v) => Math.round(v * 1e9) / 1e9));
      if (info.blank) blank.add(rows.length - 1);
      meta.push(info);
    }
  });

  if (!meta.some((m) => !m.blank)) return null;
  const usedIdx = t.plates.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  meta.forEach((m) => {
    m.plate = usedIdx.indexOf(m.plate);
  });
  return { rows, blank, meta };
}

export function triWarnings(st: RunState): string[] {
  const w: string[] = [];
  const t = st.tri;
  if (!t) return w;
  const rName = (c: string) => {
    const r = st.reagents.find((x) => x.code === c);
    return r ? r.name || r.code : '?';
  };
  const adds = t.adds.map((a) => a.code).filter(Boolean);
  const key = (g: TripletGroup) => [...g.members].sort().join('|');

  t.groups.forEach((g) => {
    if (g.derived ? !g.members.some(Boolean) : g.members.some((m) => !m)) {
      w.push(`${g.name}: pick a reagent for every position.`);
    } else if (new Set(g.members.filter(Boolean)).size < g.members.filter(Boolean).length) {
      w.push(`${g.name}: ${g.members.map(rName).join(' + ')} uses the same reagent more than once.`);
    }
    if (g.members.some((m) => adds.includes(m))) {
      w.push(`${g.name}: contains an additive reagent.`);
    }
  });

  const by: Record<string, TripletGroup[]> = {};
  t.groups.forEach((g) => {
    if (g.members.every(Boolean)) (by[key(g)] = by[key(g)] || []).push(g);
  });
  Object.values(by).forEach((l) => {
    if (l.length > 1) {
      w.push(`${l.map((g) => g.name).join(' / ')} are the same reaction (${l[0].members.map(rName).join(' + ')}), only the order differs.`);
    }
  });

  t.plates.forEach((p, pi) => {
    if (!p) return;
    const seen: Record<string, number[]> = {};
    p.sections.forEach((id, si) => {
      const g = t.groups.find((x) => x.id === id);
      if (g && g.members.every(Boolean)) {
        (seen[key(g)] = seen[key(g)] || []).push(si + 1);
      }
    });
    Object.entries(seen).forEach(([k, secs]) => {
      if (secs.length > 1) {
        w.push(`plate${pi}: sections ${secs.join(', ')} run the same reaction (${k.split('|').map(rName).join(' + ')}), a duplicate.`);
      }
    });
  });

  if (t.plates[2] && !t.plates[1]) {
    w.push('plate2 is used but plate1 is not. The robot fills plates 0, 1, 2 in order, so leave no gap.');
  }
  if (!triStats(st).sections) {
    w.push('No section has a group yet. Assign groups to sections below.');
  }
  const g = triGeom(st);
  if (g.n < 1) {
    w.push('This pattern does not fit on a 6 × 9 plate. Use fewer ratios or additive rows.');
  }
  return w;
}

export function stockHints(st: RunState): string[] {
  return st.reagents
    .filter((r) => r.stock !== '' && +r.stock > 0 && +r.stock < 5)
    .map(
      (r) =>
        `Stock ${r.name || r.code} is ${+r.stock} mM. Did you mean ${+(+r.stock * 1000).toPrecision(
          6
        )} mM? The field is in mM (0.225 mol/L = 225 mM).`
    );
}
