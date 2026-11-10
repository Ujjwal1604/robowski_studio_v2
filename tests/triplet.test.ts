import { describe, it, expect } from 'vitest';
import {
  triDefault,
  triGeom,
  triBuildRows,
  triDerive,
} from '../src/engine/triplet';
import { RunState } from '../src/types';
import { buildRun } from '../src/engine/dilution';
import { buildDataPayload } from '../src/context/runPayload';
import { workbookSheets } from '../src/engine/exporters/xlsx';
import { robotSheetsToRun } from '../src/engine/importers/robotParser';

describe('Triplet Plate Mode', () => {
  const makeTripletState = (): RunState => ({
    id: null,
    name: 'test-triplet',
    mode: 'triplet',
    hood: 'left',
    vialVolume: 500,
    threshold: 50,
    dilutionFactor: 5,
    reactionSolvent: 'ethanol',
    leftoverMl: 2,
    flasksText: '2, 5, 10, 20, 50, 100',
    randomize: false,
    randomSeed: 20261018,
    reagents: ['A', 'B', 'C', 'D', 'E', 'F', 'Ac', 'Ba'].map((code) => ({
      code,
      name: code,
      molarMass: 100,
      density: 1,
      stock: 100,
      solvent: 'ethanol',
    })),
    tri: triDefault(),
  });

  it('computes 6x9 geometry partitions correctly', () => {
    const st = makeTripletState();
    // Default: 3 ratios (across = 9/3 = 3) and 2 additives (down = 6/2 = 3) -> 3x3 = 9 sections
    const geom = triGeom(st);
    expect(geom.c).toBe(3);
    expect(geom.r).toBe(2);
    expect(geom.across).toBe(3);
    expect(geom.down).toBe(3);
    expect(geom.n).toBe(9);
    expect(geom.leftover).toBe(0); // 54 - 9 * 6 = 0
  });

  it('builds rows with assigned groups and additive rows', () => {
    const st = makeTripletState();
    st.tri!.groups = [
      { id: 'g1', name: 'T1', members: ['A', 'B', 'C'] },
    ];
    st.tri!.plates = [{ sections: ['g1', '', '', '', '', '', '', '', ''] }, null, null];

    const result = triBuildRows(st);
    expect(result).not.toBeNull();
    expect(result!.rows.length).toBe(54); // standard 54-well plate
    expect(result!.meta[0].group).toBe('T1');
    expect(result!.blank.size).toBe(54 - 6); // 1 section = 6 active reaction wells, 48 blanks
  });

  it('derives doublets and singlets with automated derivation', () => {
    const st = makeTripletState();
    st.tri!.groups = [
      { id: 'g1', name: 'T1', members: ['A', 'B', 'C'] },
    ];
    st.tri!.plates = [{ sections: ['g1', '', '', '', '', '', '', '', ''] }, null, null];

    // Derive controls on plate 1 from plate 0
    const derived = triDerive(1, 0, st);
    expect(derived).not.toBeNull();
    expect(derived!.counts[2]).toBe(3); // 3 doublets from ABC: AB, AC, BC
    expect(derived!.counts[1]).toBe(3); // 3 singlets from ABC: A, B, C
  });

  it('exports to Excel and imports back with full Triplet mode and 54-well plate geometry preserved', () => {
    const st = makeTripletState();
    st.tri!.base = 10; // 10 mM base concentration so total < 100 mM stocks
    st.reagents.forEach((r) => { r.stock = 200; }); // high enough stock so solvent is positive
    st.tri!.groups = [
      { id: 'g1', name: 'T1', members: ['A', 'B', 'C'] },
    ];
    st.tri!.plates = [{ sections: ['g1', '', '', '', '', '', '', '', ''] }, null, null];

    const tb = triBuildRows(st);
    expect(tb).not.toBeNull();
    expect(tb!.rows.length).toBe(54);

    const payload = buildDataPayload(st, tb!.rows, tb!.blank, tb!.meta);
    const run = buildRun(payload);
    expect(run.blockingIssues).toBe(0);

    const sheets = workbookSheets(run, { ...payload, state: st });
    expect(sheets.length).toBe(6);

    // 1. Full import with robowski_meta
    const importedWithMeta = robotSheetsToRun(sheets, 'triplet_run.xlsx');
    expect(importedWithMeta.mode).toBe('triplet');
    expect(importedWithMeta.rows.length).toBe(54); // All 54 wells preserved!
    expect(importedWithMeta.blankRows.size).toBe(48); // Blank control wells preserved as 0-concentration
    expect(importedWithMeta.savedState).not.toBeNull();
    expect(importedWithMeta.savedState.mode).toBe('triplet');

    // 2. Legacy / external import without robowski_meta (tests description parsing & mode detection)
    const sheetsWithoutMeta = sheets.filter((s) => s.name !== 'robowski_meta');
    const importedLegacy = robotSheetsToRun(sheetsWithoutMeta, 'legacy_triplet.xlsx');
    expect(importedLegacy.mode).toBe('triplet');
    expect(importedLegacy.rows.length).toBe(54);
    expect(importedLegacy.blankRows.size).toBe(48);
    expect(importedLegacy.tri).not.toBeNull();
    expect(importedLegacy.tri!.groups.length).toBeGreaterThanOrEqual(1);
  });
});
