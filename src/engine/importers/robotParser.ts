// Robowski Studio - Robot Workbook Importer
import { canonicalSolvent, num } from '../constants';
import { surfaceHeight } from '../deckTiming';
import { readAllSheets, readZipFile } from './tableReader';
import { TripletSetup, TripletGroup } from '../../types';

export function robotSheetsToRun(
  input: Record<string, any[][]> | Array<{ name: string; rows: any[][] }>,
  fileName?: string
): any {
  const sh: Record<string, any[][]> = Array.isArray(input)
    ? Object.fromEntries(input.map((s) => [s.name, s.rows]))
    : input || {};
  const normKey = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const findSheet = (...aliases: string[]): any[][] | null => {
    for (const a of aliases) {
      const target = normKey(a);
      const k = Object.keys(sh).find(
        (sheetName) => normKey(sheetName) === target || normKey(sheetName).includes(target)
      );
      if (k && sh[k]) return sh[k];
    }
    return null;
  };

  // Inspect robowski_meta sheet if present
  const metaSheet = findSheet('robowski_meta', 'robowskimeta', 'meta');
  const metaObj: Record<string, string> = {};
  if (metaSheet) {
    for (const row of metaSheet) {
      if (row && row[0] != null) {
        metaObj[String(row[0]).trim().toLowerCase()] = String(row[1] ?? '').trim();
      }
    }
  }

  // Inspect version sheet if present
  const verSheet = findSheet('version');
  if (verSheet) {
    for (const row of verSheet) {
      if (row && row[0] != null && row[1] != null) {
        metaObj[String(row[0]).trim().toLowerCase()] = String(row[1]).trim();
      }
    }
  }

  let savedState: any = null;
  if (metaObj['run_state_json']) {
    try {
      savedState = JSON.parse(metaObj['run_state_json']);
    } catch (e) {}
  }

  let triSetupFromMeta: TripletSetup | null = null;
  if (metaObj['tri_setup_json']) {
    try {
      triSetupFromMeta = JSON.parse(metaObj['tri_setup_json']);
    } catch (e) {}
  }

  const rx = findSheet(
    'reactions_with_run_info',
    'reactionswithruninfo',
    'reactions_info',
    'reactions',
    'reactionswithinfo'
  );
  const ss = findSheet(
    'stock_solutions',
    'stocksolutions',
    'stocks',
    'stock_solution',
    'stocksolution'
  );
  const cc = findSheet(
    'stock_solution_concentration',
    'stocksolutionconcentration',
    'stock_concentration',
    'stockconcentrations',
    'concentrations'
  );
  const desc = findSheet('description', 'descriptions', 'desc');

  if (!rx || !ss || !cc) {
    throw new Error(
      'This workbook needs the sheets reactions_with_run_info, stock_solutions and stock_solution_concentration.'
    );
  }

  const H = (rx[0] || []).map((x) => String(x || ''));
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

  // Detect mode: 'triplet' | 'equivalence' | 'concentration'
  let detectedMode: 'concentration' | 'equivalence' | 'triplet' = 'concentration';
  if (metaObj['mode'] && ['concentration', 'equivalence', 'triplet'].includes(metaObj['mode'])) {
    detectedMode = metaObj['mode'] as any;
  } else if (savedState?.mode) {
    detectedMode = savedState.mode;
  } else if (desc && desc.length > 1) {
    const textAll = desc
      .slice(1)
      .map((r: any[]) => (r ? r.slice(0, 4).join(' ') : ''))
      .join(' ');
    if (
      /section \d+/i.test(textAll) ||
      /ratio \d+/i.test(textAll) ||
      /Group \d+:/i.test(textAll) ||
      /\bT\d+:/i.test(textAll) ||
      /blank \(solvent only\)/i.test(textAll) ||
      /plate \d+, well \d+/i.test(textAll)
    ) {
      detectedMode = 'triplet';
    } else if (/\beq \(|\b\d+(\.\d+)?\s*eq\b/i.test(textAll)) {
      detectedMode = 'equivalence';
    }
  }

  const rows: number[][] = [];
  const skipped: number[] = [];
  const fileRows: Record<string, number>[] = [];
  const srcIdx: number[] = [];
  const totals: number[] = [];
  const blankRows = new Set<number>();

  rx.slice(1).forEach((row, ri) => {
    if (!row || row.every((x) => x == null || String(x).trim() === '')) return;
    let total = 0;
    for (const v of volCols) total += num(row[v.i]);
    const nonSolv = volCols
      .filter((v) => v.key !== 'solvent')
      .reduce((a, v) => a + num(row[v.i]), 0);

    // If completely zero transfer volume
    if (!(total > 0)) {
      if (detectedMode === 'triplet') {
        totals.push(0);
        srcIdx.push(ri);
        fileRows.push(Object.fromEntries(volCols.map((v) => [v.key, 0])));
        rows.push(order.map(() => 0));
        blankRows.add(rows.length - 1);
        return;
      }
      skipped.push(ri);
      return;
    }

    totals.push(total);
    srcIdx.push(ri);
    fileRows.push(Object.fromEntries(volCols.map((v) => [v.key, num(row[v.i])])));

    // If solvent only (e.g. blank control well on a triplet plate)
    if (nonSolv === 0) {
      rows.push(order.map(() => 0));
      blankRows.add(rows.length - 1);
      return;
    }

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
  const positiveTotals = totals.filter((t) => t > 0);
  positiveTotals.sort((a, b) => a - b);
  const vial = positiveTotals.length
    ? Math.round(positiveTotals[Math.floor(positiveTotals.length / 2)] * 1000) / 1000
    : 500;
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

  // Triplet setup reconstruction if mode is triplet and no savedState.tri
  let triSetup: TripletSetup | null = triSetupFromMeta || savedState?.tri || null;
  if (detectedMode === 'triplet' && !triSetup && desc && desc.length > 1) {
    const groups: TripletGroup[] = [];
    const groupByName: Record<string, TripletGroup> = {};
    const ratios: number[][] = [];
    const adds: Array<{ code: string; equiv: number }> = [];
    const plates: Array<{ sections: string[]; flat?: boolean } | null> = [
      { sections: [] },
      null,
      null,
    ];

    let detectedBase = 50;

    desc.slice(1).forEach((r) => {
      if (!r) return;
      const rxName = String(r[1] || '').trim();
      const cond = String(r[2] || '').trim();

      // Check group: e.g. "T1: A + B + C" or "Group 1: ReagentA + ReagentB + ReagentC"
      const grpMatch = /^([^:]+):\s*(.+)$/.exec(rxName);
      let groupId = '';
      if (grpMatch && !rxName.toLowerCase().startsWith('blank')) {
        const gName = grpMatch[1].trim();
        const members = grpMatch[2].split('+').map((m) => m.trim()).filter(Boolean);
        if (!groupByName[gName]) {
          groupId = Math.random().toString(36).slice(2, 8);
          const grp: TripletGroup = { id: groupId, name: gName, members };
          groupByName[gName] = grp;
          groups.push(grp);
        } else {
          groupId = groupByName[gName].id;
        }
      }

      // Check conditions: "plate 1, well 1, section 1 | ratio 2:1:1 | A 20 mM; B 10 mM; C 10 mM" or "... + Ac"
      const pMatch = /plate\s*(\d+)/i.exec(cond);
      const sMatch = /section\s*(\d+)/i.exec(cond);
      const rMatch = /ratio\s*([\d.:]+)/i.exec(cond);
      const addMatch = /\+\s*([A-Za-z0-9_-]+)/.exec(cond);

      if (pMatch && sMatch) {
        const pIdx = Math.max(0, parseInt(pMatch[1], 10) - 1);
        const sIdx = Math.max(0, parseInt(sMatch[1], 10) - 1);
        if (pIdx < 3) {
          if (!plates[pIdx]) plates[pIdx] = { sections: [] };
          while (plates[pIdx]!.sections.length <= sIdx) plates[pIdx]!.sections.push('');
          if (groupId) plates[pIdx]!.sections[sIdx] = groupId;
        }
      }

      if (rMatch) {
        const vec = rMatch[1].split(':').map((x) => num(x, 1));
        if (
          vec.length > 0 &&
          !ratios.some((v) => v.length === vec.length && v.every((val, i) => val === vec[i]))
        ) {
          ratios.push(vec);
        }
      }

      if (addMatch) {
        const code = addMatch[1].trim();
        if (code && !adds.some((a) => a.code === code)) {
          adds.push({ code, equiv: 0.5 });
        }
      }

      // Extract concentration / base if present
      const concMatch = /([A-Za-z0-9_-]+)\s*([\d.]+)\s*mM/.exec(cond);
      if (concMatch && num(concMatch[2]) > 0) {
        const cVal = num(concMatch[2]);
        if (rMatch) {
          const firstRatio = num(rMatch[1].split(':')[0], 1);
          if (firstRatio > 0) detectedBase = Math.round((cVal / firstRatio) * 100) / 100;
        }
      }
    });

    triSetup = {
      base: detectedBase,
      ratios: ratios.length ? ratios : [[2, 1, 1], [1, 2, 1], [1, 1, 2]],
      adds: adds.length ? adds : [{ code: '', equiv: 0.5 }],
      groups,
      plates: [plates[0] || { sections: [] }, plates[1] || null, plates[2] || null],
    };
  }

  return {
    name: String(metaObj['run_name'] || fileName || 'imported').replace(/\.xlsx$/i, ''),
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
    desc: desc || null,
    volCols: volCols.map((v) => v.key),
    mode: detectedMode,
    tri: triSetup,
    blankRows,
    savedState,
  };
}

export async function importRobotWorkbook(file: File | Blob): Promise<any> {
  const files = await readZipFile(file);
  return robotSheetsToRun(readAllSheets(files), (file as any).name);
}
