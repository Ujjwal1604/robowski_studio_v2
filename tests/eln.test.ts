import { describe, it, expect } from 'vitest';
import { normalize, exampleState } from '../src/context/runPayload';
import { buildRun } from '../src/engine/dilution';
import { workbookSheets } from '../src/engine/exporters/xlsx';
import { robotSheetsToRun } from '../src/engine/importers/robotParser';
import {
  elnObservationsCsv,
  elnObservationsXlsxBytes,
  parseElnSpreadsheet,
} from '../src/engine/elnSpreadsheet';
import { parseDelimited, readZipFile } from '../src/engine/importers/tableReader';
import { elnObservationsRows } from '../src/engine/elnSpreadsheet';
import { WellObservation } from '../src/types';

describe('HTE Electronic Lab Notebook (ELN)', () => {
  it('initializes and normalizes eln structure on RunState', () => {
    const st = exampleState();
    expect(st.eln).toBeDefined();
    expect(st.eln!.wells).toEqual({});
    expect(st.eln!.atmosphere).toBe('N2 Glovebox');

    const normalized = normalize(st);
    expect(normalized.eln).toBeDefined();
    expect(normalized.eln!.wells).toBeDefined();
  });

  it('stores and retrieves physical observations (polymerized, precipitated, volume_decreased, gas)', () => {
    const st = exampleState();
    const obs: WellObservation = {
      wellIndex: 12, // Well B4
      plateIndex: 0,
      status: 'precipitate',
      tags: ['precipitated', 'polymerized', 'gas_evolution'],
      notes: 'Well polymerized into a solid plug with significant gas evolution',
      conversion: 45,
      yield: 30,
      colorAfter: 'Dark brown solid',
    };

    st.eln!.wells['0-12'] = obs;
    expect(st.eln!.wells['0-12'].tags).toContain('polymerized');
    expect(st.eln!.wells['0-12'].tags).toContain('gas_evolution');
    expect(st.eln!.wells['0-12'].notes).toContain('solid plug');
  });

  it('preserves HTE-ELN observations through Excel export and import round-trip', () => {
    const st = exampleState();
    st.name = 'HTE-Screen-Buchwald';
    st.eln!.campaignTitle = 'Buchwald Ligand Matrix';
    st.eln!.temperatureC = 80;
    st.eln!.reactionTimeHours = 18;
    st.eln!.wells['0-4'] = {
      wellIndex: 4,
      plateIndex: 0,
      status: 'hit',
      tags: ['homogeneous'],
      notes: 'Clean solution, excellent conversion, no precipitation',
      conversion: 94,
    };
    st.eln!.wells['0-5'] = {
      wellIndex: 5,
      plateIndex: 0,
      status: 'decomp',
      tags: ['polymerized', 'volume_decreased'],
      notes: 'This well polymerized and volume decreased by ~30%',
    };

    st.reagents = [
      { code: 'R1', name: 'Substrate', molarMass: 150, density: 1.1, stock: 200, solvent: 'ethanol' },
      { code: 'R2', name: 'Ligand', molarMass: 300, density: 1.2, stock: 200, solvent: 'ethanol' },
      { code: 'R3', name: 'Base', molarMass: 100, density: 1.0, stock: 200, solvent: 'ethanol' },
    ];
    st.sets = [
      {
        name: 'Set 1',
        items: [
          { on: true, min: 20, step: 10, max: 20 },
          { on: true, min: 10, step: 10, max: 10 },
          { on: true, min: 20, step: 10, max: 20 },
        ],
      },
    ];

    const norm = normalize(st);
    const run = buildRun(norm);
    expect(run.blockingIssues).toBe(0);

    const sheets = workbookSheets(run, { ...norm, state: norm });
    expect(sheets.some((s) => s.name === 'robowski_meta')).toBe(true);

    const imported = robotSheetsToRun(sheets, 'hte_run.xlsx');
    expect(imported.savedState).toBeDefined();
    expect(imported.savedState.eln).toBeDefined();
    expect(imported.savedState.eln.campaignTitle).toBe('Buchwald Ligand Matrix');
    expect(imported.savedState.eln.wells['0-5'].tags).toContain('polymerized');
    expect(imported.savedState.eln.wells['0-5'].tags).toContain('volume_decreased');
    expect(imported.savedState.eln.wells['0-5'].notes).toContain('volume decreased');
  });

  it('exports ELN spreadsheet as CSV and re-imports well scores and tags cleanly', () => {
    const st = normalize(exampleState());
    st.reagents = [
      { code: 'R1', name: 'Substrate', molarMass: 150, density: 1.1, stock: 200, solvent: 'ethanol' },
      { code: 'R2', name: 'Ligand', molarMass: 300, density: 1.2, stock: 200, solvent: 'ethanol' },
      { code: 'R3', name: 'Base', molarMass: 100, density: 1.0, stock: 200, solvent: 'ethanol' },
    ];
    st.sets = [
      {
        name: 'Set 1',
        items: [
          { on: true, min: 20, step: 10, max: 20 },
          { on: true, min: 10, step: 10, max: 10 },
          { on: true, min: 20, step: 10, max: 20 },
        ],
      },
    ];
    st.eln!.wells['0-0'] = {
      wellIndex: 0,
      plateIndex: 0,
      status: 'hit',
      conversion: 96,
      yield: 88,
      tags: ['homogeneous'],
      colorAfter: 'Pale yellow',
      notes: 'Best ligand hit',
    };
    st.eln!.wells['0-10'] = {
      wellIndex: 10,
      plateIndex: 0,
      status: 'decomp',
      conversion: 12,
      tags: ['polymerized', 'gas_evolution'],
      notes: 'Gel plug formed',
    };

    const run = buildRun(st);
    const csv = elnObservationsCsv(st, run, [], []);
    const parsedRows = parseDelimited(csv);
    const imported = parseElnSpreadsheet([{ name: 'eln.csv', rows: parsedRows }], {}, run.plates);

    expect(imported.updatedCount).toBe(54);
    expect(imported.wells['0-0'].status).toBe('hit');
    expect(imported.wells['0-0'].conversion).toBe(96);
    expect(imported.wells['0-0'].yield).toBe(88);
    expect(imported.wells['0-0'].colorAfter).toBe('Pale yellow');
    expect(imported.wells['0-0'].notes).toBe('Best ligand hit');
    expect(imported.wells['0-10'].status).toBe('decomp');
    expect(imported.wells['0-10'].tags).toEqual(['polymerized', 'gas_evolution']);
  });

  it('exports ELN spreadsheet as XLSX and imports human-edited labels cleanly', async () => {
    const st = normalize(exampleState());
    st.reagents = [
      { code: 'R1', name: 'Substrate', molarMass: 150, density: 1.1, stock: 200, solvent: 'ethanol' },
      { code: 'R2', name: 'Ligand', molarMass: 300, density: 1.2, stock: 200, solvent: 'ethanol' },
      { code: 'R3', name: 'Base', molarMass: 100, density: 1.0, stock: 200, solvent: 'ethanol' },
    ];
    st.sets = [
      {
        name: 'Set 1',
        items: [
          { on: true, min: 20, step: 10, max: 20 },
          { on: true, min: 10, step: 10, max: 10 },
          { on: true, min: 20, step: 10, max: 20 },
        ],
      },
    ];
    st.eln!.wells['0-2'] = {
      wellIndex: 2,
      plateIndex: 0,
      status: 'clean',
      conversion: 84,
      tags: ['precipitated'],
      notes: 'White solid filtered',
    };

    const run = buildRun(st);
    const xlsxBytes = elnObservationsXlsxBytes(st, run, [], []);
    expect(xlsxBytes[0]).toBe(0x50);
    expect(xlsxBytes[1]).toBe(0x4b);

    const zipFiles = await readZipFile(new Blob([xlsxBytes as BlobPart]));
    const wbXml = new TextDecoder().decode(zipFiles['xl/workbook.xml']);
    const sheet1Xml = new TextDecoder().decode(zipFiles['xl/worksheets/sheet1.xml']);
    expect(wbXml).toContain('eln_observations');
    expect(wbXml).toContain('reference_codes');
    expect(sheet1Xml).toContain('White solid filtered');
    expect(sheet1Xml).toContain('precipitated');

    const rows = elnObservationsRows(st, run, [], []);
    const imported = parseElnSpreadsheet([{ name: 'eln_observations', rows }], {}, run.plates);
    expect(imported.wells['0-2'].status).toBe('clean');
    expect(imported.wells['0-2'].conversion).toBe(84);
    expect(imported.wells['0-2'].tags).toContain('precipitated');
    expect(imported.wells['0-2'].notes).toBe('White solid filtered');

    // Also test friendly human-edited spreadsheet import
    const customSheet = [
      ['Well', 'Outcome', 'Conv %', 'Yield %', 'Tags', 'Notes'],
      ['B4', 'Top Hit', '91%', '85%', 'Clear, Volume Loss', 'Great conversion'],
      ['F9', 'Decomposition', '5', '0', 'poly; gas', 'Polymerized'],
    ];
    const customImported = parseElnSpreadsheet([{ name: 'Sheet1', rows: customSheet }], {}, 1);
    expect(customImported.updatedCount).toBe(2);
    expect(customImported.wells['0-12'].status).toBe('hit'); // B4 -> row 1 * 9 + 3 = 12
    expect(customImported.wells['0-12'].conversion).toBe(91);
    expect(customImported.wells['0-12'].yield).toBe(85);
    expect(customImported.wells['0-12'].tags).toEqual(['homogeneous', 'volume_decreased']);
    expect(customImported.wells['0-53'].status).toBe('decomp'); // F9 -> row 5 * 9 + 8 = 53
    expect(customImported.wells['0-53'].tags).toEqual(['polymerized', 'gas_evolution']);
  });
});
