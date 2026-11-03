// Robowski Studio - Combination Generation & Grid Sweeps
import { num, round, truthy, seededShuffle } from './constants';

export function axisValues(minimum: any, step: any, maximum: any, label: string): number[] {
  const mn = num(minimum);
  const st = num(step);
  const mx = num(maximum);
  if (st <= 0) throw new Error(`${label}: step must be greater than zero.`);
  if (mx < mn) throw new Error(`${label}: maximum must be greater than or equal to minimum.`);
  const intervals = (mx - mn) / st;
  const nearest = Math.round(intervals);
  if (Math.abs(intervals - nearest) > 1e-7) {
    throw new Error(
      `${label}: maximum ${mx} is not reached by minimum ${mn} and step ${st}. Adjust the step or maximum so the range lands exactly on the maximum.`
    );
  }
  const n = nearest + 1;
  if (n > 120000) throw new Error(`${label}: range has too many points.`);
  return Array.from({ length: n }, (_, i) => round(mn + i * st, 10));
}

export function targetCombinations(data: any): {
  indexed: Array<{ globalIndex: number; values: number[] }>;
  axes: number[][];
  seed: number;
} {
  const reagents = data.reagents || [];
  if (reagents.length < 2 || reagents.length > 12) {
    throw new Error('Use between 2 and 12 reagents.');
  }
  if (Array.isArray(data.customRows)) {
    if (!data.customRows.length) throw new Error('Add at least one vial.');
    let ix = data.customRows.map((values: number[], i: number) => ({ globalIndex: i, values }));
    const sd = Math.floor(num(data.randomSeed, 20261018));
    if (truthy(data.randomize ?? true)) ix = seededShuffle(ix, sd);
    return { indexed: ix, axes: [], seed: sd };
  }
  const mode = data.mode || 'concentration';
  if (!['concentration', 'equivalence'].includes(mode)) {
    throw new Error('Choose Concentration or Equivalence mode.');
  }
  const axes = reagents.map((r: any, i: number) =>
    axisValues(r.min ?? 0, r.step ?? 1, r.max ?? 0, (r.code || r.name || `R${i + 1}`).trim())
  );
  const total = axes.reduce((a: number, x: number[]) => a * x.length, 1);
  const max = Math.floor(num(data.maxCombinations, 120000));
  if (total > max) {
    throw new Error(
      `This run would contain ${total.toLocaleString()} combinations, over the configured ${max.toLocaleString()} limit. Narrow a range or raise the limit deliberately.`
    );
  }
  let combos: number[][] = [[]];
  for (const axis of axes) {
    const next: number[][] = [];
    for (const prefix of combos) {
      for (const v of axis) next.push([...prefix, v]);
    }
    combos = next;
  }
  let indexed = combos.map((values, i) => ({ globalIndex: i, values }));
  const seed = Math.floor(num(data.randomSeed, 20261018));
  if (truthy(data.randomize ?? true)) indexed = seededShuffle(indexed, seed);
  return { indexed, axes, seed };
}
