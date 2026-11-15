import type { PredictedSpecies } from './types';

export interface LcmsTarget {
  mz: number;
  ion: string; // [M+H]+, [M+Na]+, [M-H]-, [M+H-H2O]+ ...
  kind: 'parent' | 'adduct' | 'in-source';
  speciesKey: string;
  formula: string;
  smiles: string;
  score: number;
  likelihood: number;
  persistence: number;
  /** other species (formula + ion) that could produce a peak within tolerance */
  sharedWith: string[];
}

export const MZ_TOLERANCE = 0.005; // Da, for "same peak" exact-mass collision grouping

/** Build every m/z worth checking in LC-MS and flag peaks explainable by more than one species. */
export function buildLcmsTargets(species: PredictedSpecies[], tol = MZ_TOLERANCE): LcmsTarget[] {
  const rows: LcmsTarget[] = [];
  for (const sp of species) {
    const base = {
      speciesKey: sp.key,
      formula: sp.formula,
      smiles: sp.smiles,
      score: sp.score,
      likelihood: sp.likelihood,
      persistence: sp.persistence,
      sharedWith: [] as string[],
    };
    rows.push({ ...base, mz: sp.mhPlus, ion: '[M+H]+', kind: 'parent' });
    rows.push({ ...base, mz: sp.mNaPlus, ion: '[M+Na]+', kind: 'adduct' });
    rows.push({ ...base, mz: sp.mHMinus, ion: '[M-H]-', kind: 'adduct' });
    for (const l of sp.lossIons ?? []) {
      rows.push({ ...base, mz: l.mz, ion: l.label, kind: 'in-source' });
    }
  }
  rows.sort((a, b) => a.mz - b.mz);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length && rows[j].mz - rows[i].mz <= tol; j++) {
      if (rows[i].speciesKey === rows[j].speciesKey) continue;
      const a = `${rows[j].formula} ${rows[j].ion}`;
      const b = `${rows[i].formula} ${rows[i].ion}`;
      if (!rows[i].sharedWith.includes(a)) rows[i].sharedWith.push(a);
      if (!rows[j].sharedWith.includes(b)) rows[j].sharedWith.push(b);
    }
  }
  return rows;
}

export function lcmsTargetsToCsv(targets: LcmsTarget[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    'm/z',
    'Ion',
    'Kind',
    'Formula',
    'Score',
    'Likelihood',
    'Persistence',
    'Ambiguous with',
    'SMILES',
  ];
  const lines = [head.join(',')];
  for (const t of targets) {
    lines.push(
      [
        t.mz.toFixed(4),
        t.ion,
        t.kind,
        t.formula,
        t.score.toFixed(3),
        t.likelihood.toFixed(3),
        t.persistence.toFixed(3),
        t.sharedWith.join('; '),
        t.smiles,
      ]
        .map(esc)
        .join(',')
    );
  }
  return lines.join('\n');
}
