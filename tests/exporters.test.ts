import { describe, it, expect } from 'vitest';
import { csvEscape, csvText } from '../src/engine/exporters/csv';
import { workbookSheets, workbookBytes } from '../src/engine/exporters/xlsx';
import { benchSheetHtml } from '../src/engine/exporters/benchSheet';
import { buildRun } from '../src/engine/dilution';

describe('Exporters & Safety', () => {
  it('neutralizes spreadsheet formula injection in CSV cells', () => {
    // Leading =, +, -, @ should be prefixed with ' if not a standard number
    expect(csvEscape('=CMD|calc!A0')).toBe("'=CMD|calc!A0");
    expect(csvEscape('+SUM(A1:A10)')).toBe("'+SUM(A1:A10)");
    expect(csvEscape('-DANGEROUS')).toBe("'-DANGEROUS");
    expect(csvEscape('@IMPORT')).toBe("'@IMPORT");

    // Standard numbers should NOT be prefixed
    expect(csvEscape(-42)).toBe('-42');
    expect(csvEscape('+12.5')).toBe('+12.5');
    expect(csvEscape('100')).toBe('100');
  });

  it('escapes quotes and delimiters in CSV rows', () => {
    const rows = [
      ['Name', 'Formula'],
      ['Reagent "A"', 'C6H12O6'],
      ['Solvent, dry', 'ethanol'],
    ];
    const text = csvText(rows);
    expect(text).toContain('"Reagent ""A"""');
    expect(text).toContain('"Solvent, dry"');
    expect(text.startsWith('\ufeff')).toBe(true); // UTF-8 BOM
  });

  it('generates five standard worksheets for a valid run', () => {
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 20, step: 1, max: 20 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20 },
      ],
    });

    const sheets = workbookSheets(run);
    expect(sheets.length).toBe(5);
    expect(sheets.map((s) => s.name)).toEqual([
      'reactions_with_run_info',
      'stock_solutions',
      'stock_solution_concentration',
      'description',
      'version',
    ]);
  });

  it('generates non-empty ZIP bytes for Excel workbook package', () => {
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', stock: 100, min: 20, step: 1, max: 20 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20 },
      ],
    });

    const bytes = workbookBytes({}, run);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);
    // Standard ZIP signature: 0x04034b50 (PK..)
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('renders bench sheet HTML containing the preparation checklist', () => {
    const run = buildRun({
      runName: 'Catalyst Optimization',
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      reagents: [
        { code: 'R1', name: 'Starting Material', stock: 100, min: 20, step: 1, max: 20 },
        { code: 'R2', name: 'Coupling Partner', stock: 100, min: 20, step: 1, max: 20 },
      ],
    });

    const html = benchSheetHtml(run, '2026-11-01');
    expect(html).toContain('Catalyst Optimization');
    expect(html).toContain('1. Prepare the stocks');
    expect(html).toContain('2. Load the deck');
    expect(html).toContain('Starting Material');
    expect(html).toContain('Coupling Partner');
  });

  it('renders serial dilution bench sheet instructions taking from the immediate parent stock', () => {
    const run = buildRun({
      vialVolume: 500,
      threshold: 50,
      dilutionFactor: 5,
      reactionSolvent: 'ethanol',
      leftoverMl: 2,
      flaskSizes: [10],
      reagents: [
        { code: 'R1', name: 'Starting Material', stock: 100, min: 0.5, step: 1, max: 0.5 },
        { code: 'R2', stock: 100, min: 20, step: 1, max: 20 },
      ],
    });

    const html = benchSheetHtml(run);
    // N2 should instruct taking 2 mL from R1_N, NOT 0.4 mL
    expect(html).toContain('Take 2 mL of stock R1_N and add 8 mL ethanol (1:5 dilution from R1_N');
  });
});
