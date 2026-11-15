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
    const keys = Object.keys(sh);
    // Exact (normalized) match for any alias wins over a partial match
    for (const a of aliases) {
      const target = normKey(a);
      const k = keys.find((sheetName) => normKey(sheetName) === target);
      if (k && sh[k]) return sh[k];
    }
    for (const a of aliases) {
      const target = normKey(a);
      if (target.length < 5) continue; // too short to match partially ("meta", "desc")
      const k = keys.find((sheetName) => normKey(sheetName).includes(target));
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
    .map(([h, i]) => ({ key: h.slice(4).trim(), i }));

  // Find the header row of the concentration sheet instead of assuming it is row 2:
  // it is the first of the top rows that has text in 1+ cells after column A and is followed by a row
  // whose column A is non-empty and has at least one positive number.
  const isText = (x: any) => x != null && String(x).trim() !== '' && !Number.isFinite(Number(x));
  let hdrRow = -1;
  for (let i = 0; i < Math.min(6, cc.length - 1); i++) {
    const r = cc[i] || [];
    const nextR = cc[i + 1] || [];
    const texts = r.slice(1).filter(isText).length;
    const nextNums = nextR.slice(1).filter((x: any) => num(x) > 0).length;
    if (texts >= 1 && nextR[0] != null && String(nextR[0]).trim() !== '' && nextNums >= 1) {
      hdrRow = i;
      break;
    }
  }
  if (hdrRow < 0) hdrRow = 1; // legacy layout: title row, header row, then data
  const hdr = (cc[hdrRow] || []).map((x) => (x == null ? '' : String(x).trim()));
  const codes = hdr.slice(1).filter((x) => x);
  if (!codes.length) throw new Error('Could not read the reagent names from stock_solution_concentration.');

  const concOf: Record<string, number> = {};
  for (const row of cc.slice(hdrRow + 1)) {
    if (!row || row[0] == null) continue;
    const nm = String(row[0]).trim();
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
      sol[String(r[0]).trim()] = {
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
  // Order of trust: explicit workbook/saved mode > description text > plate layout > numbers.
  let detectedMode: 'concentration' | 'equivalence' | 'triplet' = 'concentration';
  let modeSource: 'workbook' | 'description' | 'layout' | 'numbers' | 'default' = 'default';
  if (metaObj['mode'] && ['concentration', 'equivalence', 'triplet'].includes(metaObj['mode'])) {
    detectedMode = metaObj['mode'] as any;
    modeSource = 'workbook';
  } else if (savedState?.mode) {
    detectedMode = savedState.mode;
    modeSource = 'workbook';
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
      modeSource = 'description';
    } else if (/\beq \(|\b\d+(\.\d+)?\s*eq\b/i.test(textAll)) {
      detectedMode = 'equivalence';
      modeSource = 'description';
    }
  }

  // Plate layout: a triplet plate is a whole number of 54-well plates in which some wells get no reagent
  // (blank, solvent only or nothing at all). Normal concentration/equivalence runs never contain such wells.
  if (modeSource === 'default') {
    const dataRows = rx.slice(1).filter((row) => row && !row.every((x) => x == null || String(x).trim() === ''));
    let emptyWells = 0;
    for (const row of dataRows) {
      const nonSolvent = volCols.filter((v) => v.key !== 'solvent').reduce((a, v) => a + num(row[v.i]), 0);
      if (!(nonSolvent > 0)) emptyWells++;
    }
    if (dataRows.length > 0 && dataRows.length % 54 === 0 && emptyWells > 0 && emptyWells < dataRows.length) {
      detectedMode = 'triplet';
      modeSource = 'layout';
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

  // Equivalence runs keep the first reagent at one fixed concentration while the others vary around it.
  // The sheets do not say so, so when nothing else decided the mode, look at the numbers.
  if (modeSource === 'default' && order.length >= 2) {
    const active = rows.filter((_, i) => !blankRows.has(i));
    if (active.length >= 3) {
      const first = active.map((r) => r[0]);
      const fixed = first[0] > 0 && first.every((x) => Math.abs(x - first[0]) <= 1e-6 * first[0]);
      const othersVary = order.slice(1).some((_, k) => new Set(active.map((r) => r[k + 1])).size > 1);
      if (fixed && othersVary) {
        detectedMode = 'equivalence';
        modeSource = 'numbers';
      }
    }
  }

  // Names and structures from the description sheet (substrate_code / substrate_IUPAC_names / substrate_smiles).
  const infoByCode: Record<string, { name?: string; smiles?: string }> = {};
  if (desc && desc.length > 1) {
    const dh = (desc[0] || []).map((x: any) => normKey(String(x || '')));
    const cCode = dh.indexOf('substratecode');
    const cName = dh.indexOf('substrateiupacnames');
    const cSmi = dh.indexOf('substratesmiles');
    const split = (v: any) =>
      String(v ?? '')
        .split(';')
        .map((x) => x.trim());
    if (cCode >= 0) {
      for (const r of desc.slice(1)) {
        if (!r) continue;
        const cs = split(r[cCode]);
        const ns = cName >= 0 ? split(r[cName]) : [];
        const ms = cSmi >= 0 ? split(r[cSmi]) : [];
        cs.forEach((c, i) => {
          if (!c) return;
          const info = (infoByCode[c] = infoByCode[c] || {});
          if (!info.name && ns.length === cs.length && ns[i] && ns[i] !== c) info.name = ns[i];
          if (!info.smiles && ms.length === cs.length && ms[i]) info.smiles = ms[i];
        });
      }
    }
  }

  // Triplet labels list "name conc mM; ..." in reagent order. Match them to the real concentrations to learn
  // which reagent code carries which name. The concentrations must agree, otherwise the row is ignored.
  const labelNameOf: Record<string, string> = {};
  if (detectedMode === 'triplet' && desc && desc.length > 1) {
    desc.slice(1).forEach((r, di) => {
      const ri = srcIdx.indexOf(di);
      if (ri < 0 || !r) return;
      const cond = String(r[2] || '');
      const tail = cond.split('|').pop() || '';
      const entries = tail
        .split(';')
        .map((e) => /^\s*(.*\S)\s+([\d.]+)\s*mM\s*$/.exec(e))
        .filter((m): m is RegExpExecArray => !!m);
      const present = order.map((b, k) => ({ b, c: rows[ri][k] })).filter((x) => x.c > 0);
      if (!entries.length || entries.length !== present.length) return;
      const agree = entries.every((m, k) => Math.abs(num(m[2]) - present[k].c) <= 0.01 * Math.max(1, present[k].c));
      if (!agree) return;
      entries.forEach((m, k) => {
        if (!labelNameOf[present[k].b]) labelNameOf[present[k].b] = m[1].trim();
      });
    });
  }
  const nameToCode: Record<string, string> = {};
  for (const b of order) {
    nameToCode[b] = b;
    const nm = labelNameOf[b] || infoByCode[b]?.name;
    if (nm && !(nm in nameToCode)) nameToCode[nm] = b;
  }

  const solv = sol['solvent'] || {};
  const reactionSolvent = canonicalSolvent(solv.solvent || 'ethanol');
  const reagents = order.map((b) => {
    const key = Object.keys(sol).find((k) => k === b) || Object.keys(sol).find((k) => stockOf(k).base === b);
    return {
      code: b,
      name: labelNameOf[b] || infoByCode[b]?.name || b,
      smiles: infoByCode[b]?.smiles || '',
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
    let baseFromData = 0;
    const addConc: Record<string, number> = {};

    desc.slice(1).forEach((r, di) => {
      if (!r) return;
      const ri = srcIdx.indexOf(di);
      const rxName = String(r[1] || '').trim();
      const cond = String(r[2] || '').trim();

      // Check group: e.g. "T1: A + B + C" or "Group 1: ReagentA + ReagentB + ReagentC"
      const grpMatch = /^([^:]+):\s*(.+)$/.exec(rxName);
      let groupId = '';
      if (grpMatch && !rxName.toLowerCase().startsWith('blank')) {
        const gName = grpMatch[1].trim();
        const members = grpMatch[2]
          .split(' + ')
          .map((m) => m.trim())
          .filter(Boolean)
          .map((m) => nameToCode[m] || nameToCode[m.replace(/\s+/g, ' ')] || m);
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
      const ratioPart = cond.split('|')[1] || '';
      const addMatch = /\+\s*([^\s|;]+)/.exec(ratioPart);

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
        const k = order.indexOf(code);
        if (code && k >= 0 && ri >= 0 && rows[ri][k] > 0 && !(code in addConc)) addConc[code] = rows[ri][k];
      }

      // Base concentration from the real numbers: first member's concentration divided by its ratio number.
      if (!baseFromData && rMatch && ri >= 0 && grpMatch) {
        const mem = groupByName[grpMatch[1].trim()]?.members || [];
        const k = order.indexOf(mem[0]);
        const r0 = num(rMatch[1].split(':')[0], 0);
        if (k >= 0 && r0 > 0 && rows[ri][k] > 0) baseFromData = Math.round((rows[ri][k] / r0) * 1e6) / 1e6;
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

    if (baseFromData > 0) detectedBase = baseFromData;
    for (const a of adds) {
      if (addConc[a.code] > 0 && detectedBase > 0) a.equiv = Math.round((addConc[a.code] / detectedBase) * 1000) / 1000;
    }

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
    modeSource,
    tri: triSetup,
    blankRows,
    savedState,
  };
}

export async function importRobotWorkbook(file: File | Blob): Promise<any> {
  const files = await readZipFile(file);
  return robotSheetsToRun(readAllSheets(files), (file as any).name);
}
