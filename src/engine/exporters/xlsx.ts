// Robowski Studio - OpenXML Spreadsheet (.xlsx) Generator
import { RunResult, RunRow } from '../../types';
import { num, round, SOLVENT_DENSITIES } from '../constants';
import { surfaceHeight } from '../deckTiming';
import { zipStore } from './zipStore';

export function xmlEsc(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellXml(v: any, ref: string, style?: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  const st = style ? ' s="1"' : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"${st}><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}

export function worksheetXml(rows: any[][], opts: { freeze?: string; filter?: boolean } = {}): string {
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 1);
  const maxRows = Math.max(1, rows.length);
  const last = `${colLetter(maxCols)}${maxRows}`;
  const cols = Array.from({ length: maxCols }, (_, i) => {
    const width = Math.max(
      12,
      Math.min(34, Math.max(0, ...rows.slice(0, 100).map((r) => String(r[i] ?? '').length)) + 2)
    );
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  let pane = '';
  if (opts.freeze) {
    const cell = opts.freeze === 'B3' ? 'B3' : 'A2';
    const x = opts.freeze === 'B3' ? 1 : 0;
    const y = opts.freeze === 'B3' ? 2 : 1;
    pane = `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="${x}" ySplit="${y}" topLeftCell="${cell}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`;
  } else {
    pane = '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
  }
  const data = rows
    .map(
      (row, ri) =>
        `<row r="${ri + 1}">${row
          .map((v, ci) => cellXml(v, `${colLetter(ci + 1)}${ri + 1}`, ri === 0))
          .join('')}</row>`
    )
    .join('');
  const filter = opts.filter ? `<autoFilter ref="A1:${colLetter(maxCols)}${maxRows}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/>${pane}<cols>${cols}</cols><sheetData>${data}</sheetData>${filter}<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`;
}

export function descChem(run: RunResult, row: RunRow): (string | null)[] {
  const m = run.descMeta || { product: {}, additives: [], chem: {} };
  const subs = row.recipe
    .filter((rec) => rec.target_concentration > 0 && !m.additives.includes(rec.code))
    .map((rec) => ({
      code: rec.code,
      ...(m.chem[rec.code] || { name: rec.code, iupac: '', smiles: '' }),
    }));
  const pr = subs.length ? m.product || {} : {};
  const join = (a: string[]) => a.join('; ');
  const allSmiles = subs.length && subs.every((x) => x.smiles);
  return [
    subs.length ? join(subs.map((x) => x.iupac || x.name)) : null,
    subs.length ? join(subs.map((x) => x.code)) : null,
    allSmiles ? join(subs.map((x) => x.smiles)) : null,
    pr.name || null,
    pr.code || null,
    pr.smiles || null,
  ];
}

export function workbookSheets(run: RunResult, data?: any): Array<{ name: string; rows: any[][] }> {
  if (run && run.blockingIssues > 0) {
    throw new Error(`Robot workbook blocked: resolve ${run.blockingIssues} blocking validation issue(s) before export.`);
  }
  const reagentCodes = run.reagents.map((r) => r.code);
  const stockKeys = Object.keys(run.stocks);
  const reactionHeaders = ['local_index', 'global_index'];
  const solventAt = run.solventAfter == null ? 0 : run.solventAfter;
  const addOrder: string[] = [];

  reagentCodes.forEach((code, ci) => {
    if (ci === solventAt) addOrder.push('solvent');
    for (const key of stockKeys) {
      if (run.stocks[key].source_reagent === code) addOrder.push(key);
    }
  });
  if (solventAt >= reagentCodes.length) addOrder.push('solvent');
  for (const k of addOrder) reactionHeaders.push(`vol#${k}`);

  const reactionRows = [
    reactionHeaders,
    ...run.rows.map((row) => [
      row.local_index,
      row.global_index,
      ...reactionHeaders.slice(2).map((h) => num(row[h], 0)),
    ]),
  ];

  const stockRows = [
    [
      'substance',
      'breadboard_plate_id',
      'container_id',
      'solvent',
      'density',
      'volume',
      'liquid_surface_height',
      'pipetting_mode',
    ],
    ...addOrder.map((k) => {
      if (k === 'solvent') {
        return [
          'solvent',
          run.deck.solvent_plate,
          run.deck.solvent_container,
          run.reactionSolvent,
          SOLVENT_DENSITIES[run.reactionSolvent] || 1,
          Math.round(run.solventRecommendedMl * 1000),
          surfaceHeight(run.deck.solvent_kind, run.solventRecommendedMl * 1000),
          'empty',
        ];
      }
      const s = run.stocks[k];
      return [
        s.substance,
        s.breadboard_plate_id,
        s.container_id,
        s.solvent,
        s.density,
        Math.round(s.prep_volume_ml * 1000),
        surfaceHeight('bottle', s.prep_volume_ml * 1000),
        s.pipetting_mode,
      ];
    }),
  ];

  const concRows = [
    ['Stock concentrations (mM; reference sheet)'],
    ['stock_solution', ...reagentCodes],
    ...Object.entries(run.stocks).map(([key, s]) => [
      key,
      ...reagentCodes.map((code) => (s.source_reagent === code ? round(s.concentration_mM, 8) : 0)),
    ]),
  ];

  const descRows = [
    [
      'reaction_code',
      'reaction_name',
      'conditions',
      'substrate_IUPAC_names',
      'substrate_code',
      'substrate_smiles',
      'product_IUPAC_names',
      'product_code',
      'products_smiles',
      'generator_combination_index',
    ],
    ...run.rows.map((row) => [
      row.global_index,
      row.label ? row.label.name : run.runName,
      row.label
        ? row.label.cond
        : row.recipe
            .map((rec) =>
              run.mode === 'equivalence' && rec.equivalence !== null
                ? `${rec.code} ${rec.equivalence} eq (${rec.target_concentration} mM)`
                : `${rec.code} ${rec.target_concentration} mM`
            )
            .join('; '),
      ...descChem(run, row),
      row.combo_index,
    ]),
  ];
  const detectedMode =
    data?.state?.mode ||
    data?.modeLabel ||
    (run.mode && run.mode !== 'concentration' ? run.mode : null) ||
    data?.mode ||
    run.mode ||
    'concentration';
  const verRows = [
    ['version', 1.03],
    ['mode', detectedMode],
    ['format', 'robowski-run-workbook'],
  ];

  const rawState = data?.state || data?.rawState || (data?.reagents ? data : null);
  const triData = data?.tri || data?.state?.tri || null;
  const metaRows = [
    ['key', 'value'],
    ['format', 'robowski-run-workbook'],
    ['version', 1.03],
    ['mode', detectedMode],
    ['run_name', run.runName || data?.name || ''],
    ['reactions', run.reactions],
    ['plates', run.plates],
    ['vial_volume_uL', run.vialVolume],
    ['dilution_factor', run.dilutionFactor],
    ['reaction_solvent', run.reactionSolvent],
    ['run_state_json', rawState ? JSON.stringify(rawState) : ''],
    ['tri_setup_json', triData ? JSON.stringify(triData) : ''],
  ];

  const names = [
    'reactions_with_run_info',
    'stock_solutions',
    'stock_solution_concentration',
    'description',
    'version',
    'robowski_meta',
  ];
  return names.map((n, i) => ({
    name: n,
    rows: [reactionRows, stockRows, concRows, descRows, verRows, metaRows][i],
  }));
}

export function workbookBytes(data: any, run: RunResult): Uint8Array {
  const sheetsData = workbookSheets(run, data);
  const names = sheetsData.map((s) => s.name);
  const sheets: Record<string, string> = {};
  sheetsData.forEach(
    (s, i) =>
      (sheets[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(s.rows, {
        freeze: i === 2 ? 'B3' : 'A2',
        filter: i < 2,
      }))
  );

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names
    .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
    .map(
      (n, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join(
      ''
    )}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF374151"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
    .map(
      (n, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join(
      ''
    )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': ct,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': rels,
    'xl/styles.xml': styles,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Robowski Studio run</dc:title><dc:creator>Robowski Studio</dc:creator></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Robowski Studio</Application></Properties>`,
    ...sheets,
  };
  return zipStore(files);
}
