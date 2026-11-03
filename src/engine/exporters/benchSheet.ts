// Robowski Studio - Bench Sheet HTML and Preparation Steps
import { RunResult } from '../../types';
import { localDate, benchNum } from '../constants';
import { xmlEsc } from './xlsx';
import { generateCode128Svg } from '../barcode';

export function stockSteps(run: RunResult) {
  const N = run.dilutionFactor;
  const nameOf: Record<string, string> = {};
  run.reagents.forEach((r) => (nameOf[r.code] = r.name || r.code));
  const list = Object.entries(run.stocks)
    .map(([key, s]) => ({ key, s, onDeck: true }))
    .concat((run.sourceOnlyStocks || []).map((s) => ({ key: s.substance, s, onDeck: false })));
  list.sort((a, b) => (a.s.dilution_level || 0) - (b.s.dilution_level || 0));

  return list.map(({ key, s, onDeck }, i) => {
    const lvl = s.dilution_level || 0;
    const rname = nameOf[s.source_reagent] || s.source_reagent;
    const parent = s.parent_stock_key || (lvl === 1 ? s.source_reagent : key.replace(/_N2$/, '_N'));
    const flask = s.flask_label || '';
    const conc = benchNum(s.concentration_mM);
    let how: string;
    if (lvl > 0) {
      const srcVol = s.parent_source_volume_ml ?? s.base_stock_volume_ml;
      how = `Take ${benchNum(srcVol)} mL of stock ${parent} and add ${benchNum(
        s.diluent_volume_ml
      )} mL ${s.solvent} (1:${benchNum(N)} dilution from ${parent}, ${flask}).`;
    } else if (s.mass_g != null) {
      how = `Weigh ${benchNum(s.mass_g)} g of ${rname}${
        s.chemical_volume_ml != null ? ' (about ' + benchNum(s.chemical_volume_ml, 3) + ' mL as a liquid)' : ''
      }, dissolve in ${s.solvent} and fill to the mark (${flask}).`;
    } else {
      how = `Prepare ${conc} mM ${rname} in ${s.solvent}, ${benchNum(
        s.prep_volume_ml
      )} mL (${flask}). Molar mass is missing, so the mass was not calculated.`;
    }
    const need = benchNum(s.required_mL);
    const place = onDeck
      ? `plate ${s.breadboard_plate_id}, position ${s.container_id}`
      : 'not on the robot deck (only used to make dilutions)';
    return {
      n: i + 1,
      key,
      reagent: rname,
      conc,
      how,
      prepare: benchNum(s.prep_volume_ml),
      need,
      left: benchNum(s.leftover_mL),
      place,
      onDeck,
      solvent: s.solvent,
    };
  });
}

export function deckSteps(run: RunResult) {
  const out: Array<{ where: string; item: string; container: string; fill: string }> = [];
  const onDeck = Object.entries(run.stocks)
    .map(([k, s]) => ({ k, s }))
    .sort(
      (a, b) =>
        a.s.breadboard_plate_id - b.s.breadboard_plate_id || a.s.container_id - b.s.container_id
    );
  const nameOf: Record<string, string> = {};
  run.reagents.forEach((r) => (nameOf[r.code] = r.name || r.code));

  out.push({
    where: `plate ${run.deck.solvent_plate}, position ${run.deck.solvent_container}`,
    item: `Reaction solvent: ${run.reactionSolvent}`,
    container: run.deck.solvent_kind === 'jar' ? 'jar (100 mL)' : 'bottle (20 mL)',
    fill: `at least ${benchNum(run.solventRecommendedMl)} mL`,
  });

  for (const { k, s } of onDeck) {
    out.push({
      where: `plate ${s.breadboard_plate_id}, position ${s.container_id}`,
      item: `Stock ${k}: ${nameOf[s.source_reagent] || s.source_reagent}, ${benchNum(s.concentration_mM)} mM`,
      container: 'bottle (20 mL)',
      fill: `${benchNum(s.prep_volume_ml)} mL prepared (robot uses ${benchNum(s.required_mL)} mL)`,
    });
  }

  const tc = run.tipCounts || ({} as any);
  for (let p = 0; p < run.plates; p++) {
    const used = Math.min(54, Math.max(0, run.reactions - p * 54));
    out.push({
      where: `reaction plate ${p}`,
      item: `54-vial plate, ${used} vial${used === 1 ? '' : 's'} used`,
      container: 'empty vials in place',
      fill: 'robot fills them',
    });
  }

  for (const sz of ['50', '300', '1000']) {
    if ((tc as any)[sz] > 0) {
      out.push({
        where: 'tip racks',
        item: `${sz} µL tips`,
        container: `${tc.racks ? tc.racks[sz] : Math.ceil((tc as any)[sz] / 96)} full rack(s) of 96`,
        fill: `${(tc as any)[sz]} tips needed`,
      });
    }
  }
  return out;
}

export function notebookSummary(run: RunResult, dateStr?: string) {
  const date = dateStr || localDate();
  const fmt = (x: any) => +Number(x).toPrecision(4);
  const modeName =
    ({ equivalence: 'Equivalence', triplet: 'Triplet plate' } as any)[run.modeLabel || run.mode] ||
    'Concentration';
  const seen: Record<string, { c: Set<number>; e: Set<number> }> = {};
  let wells = 0,
    blanks = 0;

  for (const row of run.rows) {
    let any = false;
    for (const rec of row.recipe || []) {
      if (rec.target_concentration > 0) {
        any = true;
        const o = seen[rec.code] || (seen[rec.code] = { c: new Set(), e: new Set() });
        o.c.add(fmt(rec.target_concentration));
        if (rec.equivalence != null) o.e.add(fmt(rec.equivalence));
      }
    }
    if (any) wells++;
    else blanks++;
  }

  const span = (set: Set<number>, unit: string) => {
    const a = [...set].sort((x, y) => x - y);
    if (!a.length) return 'not used';
    return a.length === 1 ? `${a[0]} ${unit}` : `${a[0]}–${a[a.length - 1]} ${unit} (${a.length} levels)`;
  };

  const direct = Object.values(run.stocks).filter((x) => x.dilution_level === 0);
  const diluted = Object.entries(run.stocks).filter(([, x]) => x.dilution_level > 0);
  const reagents = run.reagents
    .filter((r) => seen[r.code])
    .map((r) => {
      const o = seen[r.code] || { c: new Set(), e: new Set() };
      const st = direct.find((x) => x.source_reagent === r.code);
      return {
        code: r.code,
        name: r.name || r.code,
        mw: (r.molarMass as number) > 0 ? fmt(r.molarMass) : '',
        stock: st ? fmt(st.base_stock_concentration) : r.stock ? fmt(r.stock) : '',
        use:
          o.e.size && (run.modeLabel || run.mode) !== 'concentration'
            ? span(o.e, 'equiv')
            : span(o.c, 'mM'),
        need: st ? fmt(st.required_mL) + ' mL' : '',
        prep: st ? `${st.flask_label}${st.mass_g != null ? ', ' + fmt(st.mass_g) + ' g' : ''}` : '',
      };
    });

  const dil = diluted.map(
    ([k, x]) =>
      `${k} ${fmt(x.concentration_mM)} mM (1:${fmt(run.dilutionFactor ** x.dilution_level)} of ${
        x.source_reagent
      }; need ${fmt(x.required_mL)} mL, prepare ${fmt(x.prep_volume_ml)} mL)`
  );

  const meta = [
    modeName + ' mode',
    `${run.vialVolume} µL per vial`,
    run.reactionSolvent,
    `Robowski ${run.hood} hood`,
    `${wells} reactions${blanks ? ' + ' + blanks + ' blank' + (blanks > 1 ? 's' : '') : ''}`,
    `${run.plates} plate${run.plates > 1 ? 's' : ''}`,
    `threshold ${run.threshold} µL`,
    `N = ${run.dilutionFactor}`,
    run.randomize ? `shuffled, seed ${run.randomSeed}` : 'not shuffled',
    `est. ${run.runtime.label}`,
  ];
  return { title: run.runName, date, meta, reagents, dil, warnings: run.warningCount };
}

export function benchSheetParts(run: RunResult, dateStr?: string) {
  const n = notebookSummary(run, dateStr);
  const st = stockSteps(run);
  const dk = deckSteps(run);
  const e = xmlEsc;
  const runId = `ROB-${(run.runName || 'RUN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12)}-${(dateStr || localDate()).replace(/-/g, '')}`;
  const barcodeSvg = generateCode128Svg(runId, 30);
  const css = `.bs{font-family:Arial,Helvetica,sans-serif;color:#1b241f;font-size:13px;line-height:1.4}.bs h1{font-size:22px;margin:0 0 2px}.bs h2{font-size:15px;margin:20px 0 6px;padding-bottom:3px;border-bottom:2px solid #0E6F63;color:#0E6F63}.bs .meta{color:#435047;margin:0 0 4px}.bs table{border-collapse:collapse;width:100%}.bs th{text-align:left;background:#e8f1ee;color:#315e49;font-size:12px}.bs th,.bs td{border:1px solid #cfd6cd;padding:5px 7px;vertical-align:top;text-align:left;white-space:normal;font-weight:normal;font-size:13px;color:#1b241f;background:#fff}.bs th{font-weight:700;background:#e8f1ee;color:#315e49;font-size:12px}.bs td.c{width:22px;text-align:center;font-size:16px}.bs .mono{font-family:Consolas,Menlo,monospace}.bs .note{color:#5b655d;font-size:12px;margin-top:6px}.bs .lines td{height:26px}`;
  const body = `<div class="bs"><div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;"><div><h1>${e(n.title)}</h1><p class="meta">${e(n.date)} · ${e(
    n.meta.join(' · ')
  )}</p></div><div style="flex-shrink:0; text-align:right;">${barcodeSvg}</div></div>
<h2>1. Prepare the stocks</h2><table><thead><tr><th></th><th>Stock</th><th>How to prepare</th><th>Prepare</th><th>Robot uses</th><th>Put it at</th></tr></thead><tbody>${st
    .map(
      (x) =>
        `<tr><td class="c">☐</td><td><b>${e(x.key)}</b><br>${e(x.reagent)}<br>${e(x.conc)} mM</td><td>${e(
          x.how
        )}</td><td class="mono">${e(x.prepare)} mL</td><td class="mono">${e(x.need)} mL</td><td>${e(
          x.place
        )}</td></tr>`
    )
    .join('')}<tr><td class="c">☐</td><td><b>solvent</b><br>${e(
    run.reactionSolvent
  )}</td><td>Fill the ${run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle'} with at least ${e(
    benchNum(run.solventRecommendedMl)
  )} mL.</td><td class="mono">${e(benchNum(run.solventRecommendedMl))} mL</td><td class="mono">${e(
    benchNum(run.solventConsumptionMl)
  )} mL</td><td>plate ${run.deck.solvent_plate}, position ${run.deck.solvent_container}</td></tr></tbody></table>
<h2>2. Load the deck (${e(run.hood)} hood)</h2><table><thead><tr><th></th><th>Where</th><th>What</th><th>Container</th><th>Fill</th></tr></thead><tbody>${dk
    .map(
      (x) =>
        `<tr><td class="c">☐</td><td>${e(x.where)}</td><td>${e(x.item)}</td><td>${e(x.container)}</td><td>${e(
          x.fill
        )}</td></tr>`
    )
    .join('')}</tbody></table>
<h2>3. Run notes</h2><p class="note">${
    n.warnings ? n.warnings + ' warning(s) in the validation checks. ' : 'All validation checks passed. '
  }Estimated time ${e(run.runtime.label)}. Shuffle: ${run.randomize ? 'seed ' + run.randomSeed : 'off'}.</p><table class="lines"><tbody><tr><td>Start time:</td><td>End time:</td><td>Wells that failed:</td></tr><tr><td colspan="3">Notes:</td></tr><tr><td colspan="3">&nbsp;</td></tr></tbody></table>
<p class="note">Made with Robowski Studio. This page is a file only; nothing is sent to the robot.</p></div>`;
  return { css, body, title: n.title };
}

export function benchSheetHtml(run: RunResult, dateStr?: string): string {
  const p = benchSheetParts(run, dateStr);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xmlEsc(
    p.title
  )} bench sheet</title><style>body{margin:0;padding:24px;background:#fff}@page{margin:12mm}@media print{body{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}${
    p.css
  }</style></head><body>${p.body}</body></html>`;
}
