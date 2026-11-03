// Robowski Studio - Robot Workbook Importer
import { canonicalSolvent, num } from '../constants';
import { surfaceHeight } from '../deckTiming';
import { readAllSheets, readZipFile } from './tableReader';

export function robotSheetsToRun(sh: Record<string, any[][]>, fileName?: string): any {
  const rx = sh['reactions_with_run_info'];
  const ss = sh['stock_solutions'];
  const cc = sh['stock_solution_concentration'];
  if (!rx || !ss || !cc) {
    throw new Error(
      'This workbook needs the sheets reactions_with_run_info, stock_solutions and stock_solution_concentration.'
    );
  }
  const H = rx[0].map((x) => String(x || ''));
  const volCols = H.map((h, i) => [h, i] as [string, number])
    .filter(([h]) => h.startsWith('vol#'))
    .map(([h, i]) => ({ key: h.slice(4), i }));
  const hdr = (cc[1] || []).map((x) => (x == null ? '' : String(x)));
  const codes = hdr.slice(1).filter((x) => x);
  if (!codes.length) throw new Error('Could not read the reagent names from stock_solution_concentration.');
  const concOf: Record<string, number> = {};
  for (const row of cc.slice(2)) {
    if (!row || row[0] == null) continue;
    const nm = String(row[0]);
    hdr.forEach((h, j) => {
      if (j > 0 && h && num(row[j]) > 0) concOf[nm] = num(row[j]);
    });
  }

  const stockOf = (nm: string) => {
    const m = /^(.*?)(_N2?)$/.exec(nm);
    return m ? { base: m[1], level: m[2] === '_N' ? 1 : 2 } : { base: nm, level: 0 };
  };

  let factor = 0;
  for (const [nm, cv] of Object.entries(concOf)) {
    const { base, level } = stockOf(nm);
    if (level && concOf[base]) {
      const f = Math.pow(concOf[base] / cv, 1 / level);
      if (f > 1) factor = f;
    }
  }
  if (!factor) factor = 5;

  const baseStock: Record<string, number> = {};
  for (const [nm, cv] of Object.entries(concOf)) {
    const { base, level } = stockOf(nm);
    const b = cv * Math.pow(factor, level);
    if (!(base in baseStock) || level === 0) baseStock[base] = b;
  }

  const sol: Record<string, any> = {};
  for (const r of ss.slice(1)) {
    if (r && r[0] != null) {
      sol[String(r[0])] = {
        plate: num(r[1]),
        pos: num(r[2]),
        solvent: canonicalSolvent(r[3]),
        density: num(r[4]),
        vol: num(r[5]),
        h: num(r[6]),
        mode: r[7] || 'empty',
      };
    }
  }

  const order: string[] = [];
  for (const v of volCols) {
    if (v.key === 'solvent') continue;
    const b = stockOf(v.key).base;
    if (!order.includes(b)) order.push(b);
  }

  const solvIdx = volCols.findIndex((v) => v.key === 'solvent');
  let solventAfter = 0;
  if (solvIdx >= 0) {
    const before = new Set<string>();
    volCols.slice(0, solvIdx).forEach((v) => before.add(stockOf(v.key).base));
    solventAfter = [...before].filter((b) => order.includes(b)).length;
  }

  const rows: number[][] = [];
  const skipped: number[] = [];
  const fileRows: Record<string, number>[] = [];
  const srcIdx: number[] = [];
  const totals: number[] = [];

  rx.slice(1).forEach((row, ri) => {
    if (!row || row.every((x) => x == null)) return;
    let total = 0;
    for (const v of volCols) total += num(row[v.i]);
    const nonSolv = volCols.filter((v) => v.key !== 'solvent').reduce((a, v) => a + num(row[v.i]), 0);
    if (!(total > 0) || nonSolv === 0) {
      skipped.push(ri);
      return;
    }
    totals.push(total);
    srcIdx.push(ri);
    fileRows.push(Object.fromEntries(volCols.map((v) => [v.key, num(row[v.i])])));
    const conc = order.map((b) => {
      let c = 0;
      for (const v of volCols) {
        if (v.key === 'solvent') continue;
        if (stockOf(v.key).base !== b) continue;
        const cv = concOf[v.key];
        if (cv) c += (num(row[v.i]) * cv) / total;
      }
      return Math.round(c * 1e9) / 1e9;
    });
    rows.push(conc);
  });

  if (!rows.length) throw new Error('No vials with volumes were found in this workbook.');
  totals.sort((a, b) => a - b);
  const vial = Math.round(totals[Math.floor(totals.length / 2)] * 1000) / 1000;
  let minV = 1e18;
  rx.slice(1).forEach((row) => {
    if (!row) return;
    for (const v of volCols) {
      if (v.key === 'solvent') continue;
      const x = num(row[v.i]);
      if (x > 0) minV = Math.min(minV, x);
    }
  });

  const solv = sol['solvent'] || {};
  const reactionSolvent = canonicalSolvent(solv.solvent || 'ethanol');
  const reagents = order.map((b) => {
    const key = Object.keys(sol).find((k) => k === b) || Object.keys(sol).find((k) => stockOf(k).base === b);
    return {
      code: b,
      name: b,
      molarMass: 0,
      density: 0,
      stock: Math.round(baseStock[b] * 1e6) / 1e6,
      solvent: canonicalSolvent((sol[key || ''] || {}).solvent || reactionSolvent),
      pipettingMode: (sol[key || ''] || {}).mode || 'empty',
    };
  });

  const stockPlates = [
    ...new Set(Object.entries(sol).filter(([k]) => k !== 'solvent').map(([, v]) => v.plate)),
  ].sort((a, b) => a - b);

  const deckPlates =
    solv.plate != null
      ? {
          solventPlate: solv.plate,
          solventKind:
            solv.vol > 0 && solv.h > 0
              ? Math.abs(surfaceHeight('jar', solv.vol) - solv.h) <
                Math.abs(surfaceHeight('bottle', solv.vol) - solv.h)
                ? 'jar'
                : 'bottle'
              : stockPlates.includes(solv.plate)
              ? 'bottle'
              : 'jar',
          solventPos: solv.pos || 0,
          stockPlates: stockPlates.length ? stockPlates : [3],
        }
      : null;

  const solvAdj = Math.min(solventAfter, reagents.length);
  return {
    name: String(fileName || 'imported').replace(/\.xlsx$/i, ''),
    vialVolume: vial,
    threshold: Math.min(50, Math.floor(minV * 1000) / 1000 || 50),
    dilutionFactor: Math.round(factor * 1000) / 1000,
    reactionSolvent,
    reagents,
    rows,
    skipped: skipped.length,
    solventAfter: solvAdj,
    deckPlates,
    fileRows,
    srcIdx,
    desc: sh['description'] || null,
    volCols: volCols.map((v) => v.key),
  };
}

export async function importRobotWorkbook(file: File | Blob): Promise<any> {
  const files = await readZipFile(file);
  return robotSheetsToRun(readAllSheets(files), (file as any).name);
}
