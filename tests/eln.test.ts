import { describe, it, expect } from 'vitest';
import { normalize, exampleState, buildDataPayload } from '../src/context/runPayload';
import { buildRun } from '../src/engine/dilution';
import { workbookSheets } from '../src/engine/exporters/xlsx';
import { robotSheetsToRun } from '../src/engine/importers/robotParser';
import { RunState, WellObservation } from '../src/types';

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

    // Ensure valid reagents with high enough stocks
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

    // Export with embedded state
    const sheets = workbookSheets(run, { ...norm, state: norm });
    expect(sheets.some((s) => s.name === 'robowski_meta')).toBe(true);

    // Import back
    const imported = robotSheetsToRun(sheets, 'hte_run.xlsx');
    expect(imported.savedState).toBeDefined();
    expect(imported.savedState.eln).toBeDefined();
    expect(imported.savedState.eln.campaignTitle).toBe('Buchwald Ligand Matrix');
    expect(imported.savedState.eln.wells['0-5'].tags).toContain('polymerized');
    expect(imported.savedState.eln.wells['0-5'].tags).toContain('volume_decreased');
    expect(imported.savedState.eln.wells['0-5'].notes).toContain('volume decreased');
  });
});
