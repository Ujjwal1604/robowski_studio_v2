// Robowski Studio - Run State Validation, Normalization, and Payload Preparation
import { RunState } from '../types';
import * as Core from '../engine';

export function exampleState(): RunState {
  const blankR = (code: string) => ({
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
  });
  return {
    id: null,
    name: 'new-run',
    mode: 'equivalence',
    hood: 'left',
    vialVolume: 500,
    threshold: 50,
    dilutionFactor: 5,
    reactionSolvent: 'ethanol',
    leftoverMl: 2,
    flasksText: '2, 5, 10, 20, 50, 100',
    randomize: true,
    randomSeed: 20261018,
    solventAfter: 0,
    deckPlates: null,
    stockVolumeCheck: true,
    newTipEveryTransfer: false,
    reagents: [blankR('AA'), blankR('BB'), blankR('CC')],
    eln: {
      campaignTitle: '',
      objective: '',
      reactionClass: '',
      temperatureC: 25,
      reactionTimeHours: 16,
      atmosphere: 'N2 Glovebox',
      agitation: 'Tumble stirrer 800 rpm',
      illumination: 'None',
      plateSealType: 'Teflon silicone bonded mat',
      postReactionNotes: '',
      wells: {},
    },
  };
}

export function normalize(st: RunState): RunState {
  if (!st.sets || !st.sets.length) {
    st.sets = [
      {
        name: 'Set 1',
        items: st.reagents.map((r) => ({
          on: true,
          min: r.min ?? 1,
          step: r.step ?? 1,
          max: r.max ?? 1,
        })),
      },
    ];
  }
  st.sets.forEach((set) => {
    while (set.items.length < st.reagents.length) {
      set.items.push({ on: false, min: 1, step: 1, max: 2 });
    }
    set.items.length = st.reagents.length;
  });
  st.reagents.forEach((r) => {
    delete r.min;
    delete r.step;
    delete r.max;
  });
  if (!st.tri) st.tri = Core.triDefault();
  if (!st.product) st.product = { name: '', code: '', smiles: '' };
  if (!st.eln) {
    st.eln = {
      campaignTitle: '',
      objective: '',
      reactionClass: '',
      temperatureC: 25,
      reactionTimeHours: 16,
      atmosphere: 'N2 Glovebox',
      agitation: 'Tumble stirrer 800 rpm',
      illumination: 'None',
      plateSealType: 'Teflon silicone bonded mat',
      postReactionNotes: '',
      wells: {},
    };
  } else if (!st.eln.wells) {
    st.eln.wells = {};
  }
  Core.triSync(st);
  return st;
}

export function flaskList(st: RunState): number[] {
  return String(st.flasksText == null ? '2, 5, 10, 20, 50, 100' : st.flasksText)
    .split(/[,;\s]+/)
    .map(Number)
    .filter((x) => x > 0 && isFinite(x));
}

export function validate(st: RunState): { m: string[]; inv: Set<string> } {
  const m: string[] = [];
  const inv = new Set<string>();
  const isn = (v: any) => v !== '' && v != null && Number.isFinite(+v);
  const chk = (k: string, label: string, ok: boolean) => {
    if (!ok) {
      m.push(label);
      inv.add(k);
    }
  };

  chk('vialVolume', 'vial volume', isn(st.vialVolume) && +st.vialVolume > 0);
  chk('threshold', 'threshold', isn(st.threshold) && +st.threshold > 0);
  chk('dilutionFactor', 'dilution factor', isn(st.dilutionFactor) && +st.dilutionFactor > 1);
  chk('flasksText', 'volumetric flasks', flaskList(st).length > 0);
  chk('leftoverMl', 'leftover volume', isn(st.leftoverMl) && +st.leftoverMl >= 0);

  const need = st.mode === 'triplet' ? Core.triUsedCodes(st) : null;
  st.reagents.forEach((r, i) => {
    if (need && !need.has(r.code)) return;
    chk(`reagents.${i}.stock`, r.code + ' stock', isn(r.stock) && +r.stock > 0);
  });

  if (st.mode === 'triplet' && st.tri) {
    const t = st.tri;
    chk('tri.base', 'base concentration', isn(t.base) && +t.base > 0);
    t.ratios.forEach((v, i) =>
      v.forEach((x, j) => chk(`tri.ratios.${i}.${j}`, 'ratios', isn(x) && +x >= 0))
    );
    t.adds.forEach((a, i) =>
      chk(`tri.adds.${i}.equiv`, 'additive equivalents', isn(a.equiv) && +a.equiv >= 0)
    );
  }

  if (!st.imported && st.mode !== 'triplet' && st.sets) {
    st.sets.forEach((set, si) =>
      set.items.forEach((it, i) => {
        if (!it.on) return;
        const p = `sets.${si}.items.${i}.`;
        const code = st.reagents[i]?.code || `R${i + 1}`;
        chk(p + 'min', code + ' range', isn(it.min) && +it.min >= 0);
        chk(p + 'max', code + ' range', isn(it.max) && +it.max >= 0);
        chk(p + 'step', code + ' range', isn(it.step) && +it.step > 0);
      })
    );
  }

  return { m: [...new Set(m)], inv };
}

export function buildRows(st: RunState): { rows: number[][]; setOf: number[] } {
  if (st.imported) {
    return { rows: st.imported.rows, setOf: st.imported.rows.map(() => 0) };
  }
  const n = st.reagents.length;
  const rows: number[][] = [];
  const so: number[] = [];
  const eq = st.mode === 'equivalence';
  const sets = st.sets || [];

  sets.forEach((set, si) => {
    const nm = set.name || 'Set ' + (si + 1);
    const on = set.items.map((it, i) => (it.on ? i : -1)).filter((i) => i >= 0);
    if (!on.length) throw new Error(nm + ': tick at least one reagent.');
    if (eq && !on.includes(0)) {
      throw new Error(
        nm +
          ': in Equivalence mode every set needs ' +
          st.reagents[0].code +
          ' (equivalents are relative to it). Tick it, or switch to Concentration mode.'
      );
    }
    const axes = on.map((i) =>
      Core.axisValues(set.items[i].min, set.items[i].step, set.items[i].max, nm + ' · ' + st.reagents[i].code)
    );
    const total = axes.reduce((a, x) => a * x.length, 1);
    if (total > 20000) {
      throw new Error(nm + ' would have ' + total.toLocaleString() + ' vials. Narrow a range.');
    }
    let combos: number[][] = [[]];
    for (const ax of axes) {
      const nx: number[][] = [];
      for (const p of combos) {
        for (const v of ax) nx.push([...p, v]);
      }
      combos = nx;
    }
    combos.forEach((vals) => {
      const row = new Array(n).fill(0);
      on.forEach((i, k) => {
        row[i] = vals[k];
      });
      if (eq) {
        const aa = row[0];
        for (let i = 1; i < n; i++) row[i] = Math.round(row[i] * aa * 1e9) / 1e9;
      }
      rows.push(row);
      so.push(si);
    });
  });

  if (rows.length > 60000) throw new Error('More than 60,000 vials. Narrow the sets.');
  return { rows, setOf: so };
}

export function buildDataPayload(
  st: RunState,
  rowsCache: number[][],
  triBlank: Set<number>,
  triMeta: any[]
): any {
  const d = JSON.parse(JSON.stringify(st));
  d.customRows = rowsCache;
  d.mode = 'concentration';
  delete d.sets;
  delete d.tri;

  if (st.mode === 'triplet') {
    d.randomize = false;
    d.blankRows = [...triBlank];
    d.additiveCodes = (st.tri?.adds || []).map((a) => a.code).filter(Boolean);
    d.rowLabels = triMeta.map((m, i) => {
      if (m.blank) {
        return {
          name: 'blank (solvent only)',
          cond: `plate ${m.plate + 1}, well ${m.well + 1} | blank`,
        };
      }
      const g = st.tri?.groups.find((x: any) => x.name === m.group);
      const mem = g ? g.members.filter(Boolean) : [];
      const conc = st.reagents
        .map((r, j) => ({ r, c: rowsCache[i][j] }))
        .filter((x) => x.c > 0)
        .map((x) => `${x.r.name || x.r.code} ${+x.c.toFixed(3)} mM`);
      return {
        name: `${m.group}: ${mem.map((code: string) => st.reagents.find((x) => x.code === code)?.name || code).join(' + ')}`,
        cond: `plate ${m.plate + 1}, well ${m.well + 1}, section ${m.section} | ratio ${m.cond} | ${conc.join('; ')}`,
      };
    });
    d.reagents.forEach((r: any) => {
      if (r.stock === '' || r.stock == null) r.stock = 1;
    });
  }

  d.runName = st.name || 'Untitled HTE run';
  d.modeLabel = st.mode;
  d.product = st.product || {};
  d.flaskSizes = flaskList(st);
  delete d.flasksText;
  if (!d.deckPlates) delete d.deckPlates;
  d.reagents.forEach((r: any, i: number) => {
    r.molarMass = +r.molarMass || 0;
    r.density = +r.density || 0;
    r.color = Core.PAL[i % Core.PAL.length];
    r.prepareVolumeMl = 0;
    r.min = 0;
    r.step = 1;
    r.max = 0;
  });
  return d;
}

export function dataFor(st: RunState): any {
  const norm = normalize(JSON.parse(JSON.stringify(st)));
  if (norm.mode === 'triplet') {
    const tb = Core.triBuildRows(norm);
    if (norm.imported && norm.imported.rows && norm.imported.rows.length) {
      const rows = norm.imported.rows;
      const blank = tb ? tb.blank : new Set<number>(rows.map((r, i) => r.every((c) => c === 0) ? i : -1).filter((i) => i >= 0));
      const meta = tb && tb.meta.length === rows.length ? tb.meta : rows.map((r, i) => ({
        plate: Math.floor(i / 54),
        well: i % 54,
        blank: r.every((c) => c === 0),
      }));
      return buildDataPayload(norm, rows, blank, meta);
    }
    if (tb) {
      return buildDataPayload(norm, tb.rows, tb.blank, tb.meta);
    }
    return buildDataPayload(norm, [], new Set(), []);
  } else {
    const b = buildRows(norm);
    return buildDataPayload(norm, b.rows, new Set(), []);
  }
}
