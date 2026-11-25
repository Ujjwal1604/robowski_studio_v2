import { describe, it, expect } from 'vitest';
import { exampleState, normalize, dataFor } from '../src/context/runPayload';
import { buildRun } from '../src/engine/dilution';
import { workbookSheets } from '../src/engine/exporters/xlsx';
import { robotSheetsToRun } from '../src/engine/importers/robotParser';
import { triDefault, triBuildRows } from '../src/engine/triplet';

const reagents = (n: number, named: boolean) =>
  Array.from({ length: n }, (_, i) => ({
    code: ['A', 'B', 'C', 'D', 'E', 'F', 'Ac', 'Ba'][i],
    name: named ? `compound-${i + 1}` : '',
    molarMass: 100,
    density: 1,
    stock: 200,
    solvent: 'ethanol',
    min: 1,
    step: 1,
    max: 2,
    pipettingMode: 'empty',
  }));

function exportSheets(st: any) {
  const n = normalize(st);
  const payload = dataFor(n);
  const run = buildRun(payload);
  expect(run.blockingIssues).toBe(0);
  return workbookSheets(run, { ...payload, state: n });
}
const without = (sheets: any[], ...names: string[]) => sheets.filter((s) => !names.includes(s.name));

function tripletState(named: boolean, addEquiv = 0.5): any {
  const st: any = exampleState();
  st.mode = 'triplet';
  st.randomize = false;
  st.reagents = reagents(8, named);
  st.tri = triDefault();
  st.tri.base = 10;
  st.tri.adds = [
    { code: 'Ac', equiv: addEquiv },
    { code: 'Ba', equiv: addEquiv },
  ];
  st.tri.groups = [
    { id: 'g1', name: 'T1', members: ['A', 'B', 'C'] },
    { id: 'g2', name: 'T2', members: ['D', 'E', 'F'] },
  ];
  st.tri.plates = [{ sections: ['g1', 'g2', '', '', '', '', '', '', ''] }, null, null];
  expect(triBuildRows(normalize(st))).not.toBeNull();
  return st;
}

describe('robot workbook import hardening', () => {
  it('detects triplet from the plate layout when no sheet says so', () => {
    const sheets = without(exportSheets(tripletState(false)), 'robowski_meta', 'version', 'description');
    const d = robotSheetsToRun(sheets, 'robot.xlsx');
    expect(d.mode).toBe('triplet');
    expect(d.modeSource).toBe('layout');
    expect(d.rows.length).toBe(54);
    expect(d.blankRows.size).toBe(42);
  });

  it('rebuilds groups with real codes, names, base and additive equivalents from description text', () => {
    const sheets = without(exportSheets(tripletState(true, 1)), 'robowski_meta', 'version');
    const d = robotSheetsToRun(sheets, 'robot.xlsx');
    expect(d.mode).toBe('triplet');
    expect(d.tri!.groups.map((g: any) => g.members)).toEqual([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
    ]);
    expect(d.tri!.base).toBe(10);
    expect(d.tri!.adds.find((a: any) => a.code === 'Ac')!.equiv).toBe(1);
    expect(d.reagents.find((r: any) => r.code === 'A')!.name).toBe('compound-1');
  });

  it('guesses equivalence mode from the numbers and keeps concentration mode for a free grid', () => {
    const eq: any = exampleState();
    eq.mode = 'equivalence';
    eq.randomize = false;
    eq.reagents = reagents(3, false);
    eq.sets = [
      {
        name: 'Set 1',
        items: [
          { on: true, min: 20, step: 1, max: 20 },
          { on: true, min: 1, step: 0.5, max: 2 },
          { on: true, min: 1, step: 1, max: 2 },
        ],
      },
    ];
    const d1 = robotSheetsToRun(without(exportSheets(eq), 'robowski_meta', 'version'), 'eq.xlsx');
    expect(d1.mode).toBe('equivalence');
    expect(d1.modeSource).toBe('numbers');

    const c: any = exampleState();
    c.mode = 'concentration';
    c.randomize = false;
    c.reagents = reagents(3, false);
    c.sets = [{ name: 'Set 1', items: c.reagents.map(() => ({ on: true, min: 10, step: 10, max: 30 })) }];
    const d2 = robotSheetsToRun(without(exportSheets(c), 'robowski_meta', 'version'), 'c.xlsx');
    expect(d2.mode).toBe('concentration');
    expect(d2.rows.length).toBe(27);
  });

  it('finds the concentration header whatever row it is on', () => {
    const c: any = exampleState();
    c.mode = 'concentration';
    c.randomize = false;
    c.reagents = reagents(3, false);
    c.sets = [{ name: 'Set 1', items: c.reagents.map(() => ({ on: true, min: 10, step: 10, max: 30 })) }];
    const sheets = without(exportSheets(c), 'robowski_meta', 'version');
    const ref = robotSheetsToRun(sheets, 'a.xlsx');
    const noTitle = sheets.map((s) => (s.name === 'stock_solution_concentration' ? { ...s, rows: s.rows.slice(1) } : s));
    const twoTitles = sheets.map((s) =>
      s.name === 'stock_solution_concentration' ? { ...s, rows: [['x'], ...s.rows] } : s
    );
    for (const variant of [noTitle, twoTitles]) {
      const d = robotSheetsToRun(variant, 'b.xlsx');
      expect(d.reagents.map((r: any) => r.stock)).toEqual(ref.reagents.map((r: any) => r.stock));
      expect(d.rows).toEqual(ref.rows);
    }
  });

  it('does not mistake an unrelated sheet containing "meta" for the metadata sheet', () => {
    const sheets = exportSheets(tripletState(false));
    const renamed = sheets.map((s) => (s.name === 'robowski_meta' ? { ...s, name: 'metadata_notes' } : s));
    const extra = [...without(renamed, 'metadata_notes'), { name: 'metadata_notes', rows: [['mode', 'equivalence']] }];
    const d = robotSheetsToRun(extra, 'x.xlsx');
    expect(d.mode).toBe('triplet'); // from the version sheet, not the unrelated one
  });

  it('a layout-detected triplet import rebuilds the same volumes through the app path (no description)', () => {
    const orig = tripletState(false);
    const sheets = exportSheets(orig);
    const origRun = buildRun(dataFor(normalize(JSON.parse(JSON.stringify(orig)))));
    const d: any = robotSheetsToRun(without(sheets, 'robowski_meta', 'version', 'description'), 'r.xlsx');
    const st: any = exampleState();
    Object.assign(st, {
      name: d.name, mode: d.mode, vialVolume: d.vialVolume, threshold: d.threshold, dilutionFactor: d.dilutionFactor,
      reactionSolvent: d.reactionSolvent, randomize: false, solventAfter: d.solventAfter, reagents: d.reagents,
      imported: { name: d.name, rows: d.rows, skipped: d.skipped },
    });
    delete st.sets;
    const run2 = buildRun(dataFor(normalize(st)));
    expect(run2.rows.length).toBe(origRun.rows.length);
    const keys = Object.keys(origRun.rows[0]).filter((k) => k.startsWith('vol#'));
    origRun.rows.forEach((r: any, i: number) => {
      for (const k of keys) expect(Math.abs((r[k] || 0) - ((run2.rows[i] as any)[k] || 0))).toBeLessThan(0.01);
    });
  });

  it('restores temperatureC and exportDate from the description sheet even without robowski_meta', () => {
    const c: any = exampleState();
    c.mode = 'concentration';
    c.temperatureC = 80;
    c.eln = { ...c.eln, temperatureC: 80 };
    c.randomize = false;
    c.reagents = reagents(2, false);
    c.sets = [{ name: 'Set 1', items: c.reagents.map(() => ({ on: true, min: 10, step: 10, max: 20 })) }];
    const sheets = without(exportSheets(c), 'robowski_meta', 'version');
    const d: any = robotSheetsToRun(sheets, 'heated.xlsx');
    expect(d.temperatureC).toBe(80);
    expect(d.exportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
