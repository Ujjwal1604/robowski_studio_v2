// Robowski Studio - CSV Exporters with Formula Injection Prevention
import { RunResult } from '../../types';
import { benchNum } from '../constants';
import { stockSteps, deckSteps } from './benchSheet';

export function csvEscape(v: any): string {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !(s.trim() !== '' && isFinite(+s))) {
    s = "'" + s;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvText(rows: any[][]): string {
  return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export function stockCsv(run: RunResult, steps?: any[]): string {
  const st = steps || stockSteps(run);
  const rows: any[][] = [
    [
      'done',
      'step',
      'stock',
      'reagent',
      'concentration_mM',
      'how_to_prepare',
      'volume_to_prepare_mL',
      'robot_uses_mL',
      'left_over_mL',
      'put_it_at',
    ],
  ];
  for (const x of st) {
    rows.push(['☐', x.n, x.key, x.reagent, x.conc, x.how, x.prepare, x.need, x.left, x.place]);
  }
  rows.push([
    '☐',
    '',
    'solvent',
    run.reactionSolvent,
    '',
    `Fill the ${run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle'} with at least ${benchNum(
      run.solventRecommendedMl
    )} mL of ${run.reactionSolvent}.`,
    '',
    benchNum(run.solventConsumptionMl),
    '',
    `plate ${run.deck.solvent_plate}, position ${run.deck.solvent_container}`,
  ]);
  return csvText(rows);
}

export function loadCsv(runOrSteps: RunResult | any[]): string {
  const steps = Array.isArray(runOrSteps) ? runOrSteps : deckSteps(runOrSteps);
  const rows: any[][] = [['done', 'where', 'what', 'container', 'fill']];
  for (const x of steps) {
    rows.push(['☐', x.where, x.item, x.container, x.fill]);
  }
  return csvText(rows);
}
