// Robowski Studio - HTE Electronic Lab Notebook (ELN) Spreadsheet Export & Import
import {
  RunState,
  RunResult,
  TlcSet,
  WellObservation,
  WellOutcomeStatus,
} from '../types';
import { csvText } from './exporters/csv';
import { worksheetXml } from './exporters/xlsx';
import { zipStore } from './exporters/zipStore';
import { tlcLane, wellLabel } from './tlcLanes';

const PLATE_SIZE = 54;
const ROWS = 6;
const COLS = 9;

export const VALID_ELN_STATUSES: WellOutcomeStatus[] = [
  'none',
  'hit',
  'clean',
  'partial',
  'sm_only',
  'decomp',
  'precipitate',
  'blank',
];

export const VALID_ELN_TAGS: string[] = [
  'polymerized',
  'precipitated',
  'volume_decreased',
  'gas_evolution',
  'color_change',
  'biphasic',
  'viscous_gel',
  'turbid',
  'homogeneous',
];

export interface ElnSpreadsheetImportResult {
  wells: Record<string, WellObservation>;
  updatedCount: number;
  skippedCount: number;
  warnings: string[];
}

export const ELN_SHEET_HEADERS = [
  'plate',
  'well',
  'reaction',
  'tlc_lane',
  'condition',
  'recipe',
  'status',
  'conversion_pct',
  'yield_pct',
  'tags',
  'color_after',
  'notes',
  'tlc_spots_rf',
];

export function elnObservationsRows(
  state: RunState,
  run: RunResult | null,
  tlcSets: TlcSet[] = [],
  triMeta: any[] = []
): any[][] {
  const numPlates = run?.plates || Math.max(1, Math.ceil((run?.rows?.length || PLATE_SIZE) / PLATE_SIZE));
  const totalWells = Math.max(run?.rows?.length || 0, numPlates * PLATE_SIZE);
  const elnWells = state.eln?.wells || {};
  const rows: any[][] = [ELN_SHEET_HEADERS];

  for (let gIdx = 0; gIdx < totalWells; gIdx++) {
    const pIdx = Math.floor(gIdx / PLATE_SIZE);
    const wIdx = gIdx % PLATE_SIZE;
    const key = `${pIdx}-${wIdx}`;
    const obs: WellObservation | undefined = elnWells[key];
    const runRow = run?.rows?.[gIdx];
    const meta = triMeta?.[gIdx];
    const isBlank = Boolean(meta?.blank);

    const coord = wellLabel(wIdx);
    const laneIdx = tlcLane(wIdx, 'column');

    const condName = runRow?.label?.name
      ? `${runRow.label.name}${runRow.label.cond ? ` (${runRow.label.cond})` : ''}`
      : isBlank
      ? 'blank (solvent only)'
      : meta?.group
      ? `${meta.group} | section ${meta.section}`
      : `Plate ${pIdx + 1}, Well ${coord}`;

    const recipeText = runRow?.recipe
      ? runRow.recipe
          .filter((r) => r.target_concentration > 0)
          .map(
            (r) =>
              `${r.code}: ${+r.target_concentration.toFixed(2)} mM${
                r.equivalence != null ? ` (${r.equivalence} eq)` : ''
              }`
          )
          .join('; ')
      : '';

    const activeTlcSet = tlcSets?.[pIdx] || tlcSets?.[0];
    const activeLane = activeTlcSet?.cfg?.lanes?.find((l) => l.id === laneIdx);
    const spotsRf = activeLane?.customSpots?.length
      ? activeLane.customSpots.map((s) => s.rf.toFixed(2)).join(', ')
      : '';

    const status = obs?.status && obs.status !== 'none' ? obs.status : isBlank ? 'blank' : 'none';

    rows.push([
      pIdx + 1,
      coord,
      gIdx + 1,
      laneIdx,
      condName,
      recipeText,
      status,
      obs?.conversion != null ? obs.conversion : '',
      obs?.yield != null ? obs.yield : '',
      obs?.tags?.length ? obs.tags.join('; ') : '',
      obs?.colorAfter || '',
      obs?.notes || '',
      spotsRf,
    ]);
  }

  return rows;
}

export function elnObservationsCsv(
  state: RunState,
  run: RunResult | null,
  tlcSets: TlcSet[] = [],
  triMeta: any[] = []
): string {
  return csvText(elnObservationsRows(state, run, tlcSets, triMeta));
}

export function elnObservationsXlsxBytes(
  state: RunState,
  run: RunResult | null,
  tlcSets: TlcSet[] = [],
  triMeta: any[] = []
): Uint8Array {
  const obsRows = elnObservationsRows(state, run, tlcSets, triMeta);
  const refRows: any[][] = [
    ['field', 'accepted_values', 'notes'],
    [
      'status',
      VALID_ELN_STATUSES.join(', '),
      'Also accepts human labels on import (e.g. Top Hit, Clean, Partial, SM Only, Decomp, Precipitate, Blank)',
    ],
    [
      'tags',
      VALID_ELN_TAGS.join(', '),
      'Separate multiple tags with semicolons or commas (e.g. polymerized; gas_evolution)',
    ],
    ['conversion_pct', '0 to 100', 'Numeric percentage (leave empty if not measured)'],
    ['yield_pct', '0 to 100', 'Numeric assay yield percentage (leave empty if not measured)'],
    ['plate', '1, 2, ...', '1-indexed plate number'],
    ['well', 'A1 to F9', '6x9 well coordinate'],
  ];

  const names = ['eln_observations', 'reference_codes'];
  const sheetsData = [obsRows, refRows];
  const sheets: Record<string, string> = {};
  sheetsData.forEach((rows, i) => {
    sheets[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(rows, {
      freeze: 'A2',
      filter: i === 0,
    });
  });

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names
    .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join(
      ''
    )}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B6B5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join(
      ''
    )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

  return zipStore({
    '[Content_Types].xml': ct,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': rels,
    'xl/styles.xml': styles,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Robowski ELN Observations</dc:title><dc:creator>Robowski Studio</dc:creator></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Robowski Studio</Application></Properties>`,
    ...sheets,
  });
}

function normHeader(h: any): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[%()]/g, '')
    .trim()
    .replace(/[\s\-/]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeElnStatus(raw: any): WellOutcomeStatus {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_');

  if (!s || s === 'none' || s === 'unscored' || s === '-') return 'none';
  if (s === 'hit' || s === 'top_hit' || s === 'top_hit_candidate' || s === 'candidate' || s === 'star') {
    return 'hit';
  }
  if (s === 'clean' || s === 'clean_conversion' || s === 'ok' || s === 'product' || s === 'complete') {
    return 'clean';
  }
  if (s === 'partial' || s === 'partial_conversion' || s === 'moderate') {
    return 'partial';
  }
  if (
    s === 'sm_only' ||
    s === 'sm' ||
    s === 'starting_material' ||
    s === 'starting_material_only' ||
    s === 'no_reaction' ||
    s === 'nr'
  ) {
    return 'sm_only';
  }
  if (
    s === 'decomp' ||
    s === 'decomposition' ||
    s === 'decomposed' ||
    s === 'complex_mixture' ||
    s === 'failed'
  ) {
    return 'decomp';
  }
  if (
    s === 'precipitate' ||
    s === 'precipitated' ||
    s === 'precipitate_clogged' ||
    s === 'ppt' ||
    s === 'clogged' ||
    s === 'insoluble'
  ) {
    return 'precipitate';
  }
  if (s === 'blank' || s === 'control' || s === 'blank_control' || s === 'blk') {
    return 'blank';
  }
  return 'none';
}

export function normalizeElnTags(raw: any): string[] {
  if (raw == null || raw === '') return [];
  const parts = String(raw)
    .split(/[;,|]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const mapped: string[] = [];
  for (const p of parts) {
    const k = p
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, '_');
    let canonical = k;
    if (k === 'poly' || k === 'polymer' || k === 'polymerized') canonical = 'polymerized';
    else if (k === 'ppt' || k === 'precipitate' || k === 'precipitated') canonical = 'precipitated';
    else if (
      k === 'vol_loss' ||
      k === 'volume_loss' ||
      k === 'volume_decreased' ||
      k === 'evaporation' ||
      k === 'evaporated'
    ) {
      canonical = 'volume_decreased';
    } else if (k === 'gas' || k === 'gas_evolution' || k === 'bubbling') {
      canonical = 'gas_evolution';
    } else if (k === 'color' || k === 'color_change' || k === 'color_shift') {
      canonical = 'color_change';
    } else if (k === 'biphasic' || k === 'biphasic_oil' || k === 'oil' || k === 'emulsion') {
      canonical = 'biphasic';
    } else if (k === 'viscous' || k === 'gel' || k === 'gelled' || k === 'viscous_gel') {
      canonical = 'viscous_gel';
    } else if (k === 'turbid' || k === 'cloudy' || k === 'turbid_cloudy' || k === 'hazy') {
      canonical = 'turbid';
    } else if (k === 'homogeneous' || k === 'clear' || k === 'clear_solution') {
      canonical = 'homogeneous';
    }
    if (canonical && !mapped.includes(canonical)) {
      mapped.push(canonical);
    }
  }
  return mapped;
}

function parsePercentCell(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.max(0, Math.min(100, Math.round(raw * 100) / 100));
  }
  const cleaned = String(raw).trim().replace(/%$/, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

function parseWellCoordinate(raw: any): { wellIndex: number; plateIndex?: number } | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  const m = /^(?:P(?:LATE)?\s*(\d+)\s*[-_:\s]*)?([A-F])\s*([1-9])$/.exec(s);
  if (!m) return null;
  const rowIdx = m[2].charCodeAt(0) - 65;
  const colIdx = parseInt(m[3], 10) - 1;
  if (rowIdx < 0 || rowIdx >= ROWS || colIdx < 0 || colIdx >= COLS) return null;
  return {
    wellIndex: rowIdx * COLS + colIdx,
    plateIndex: m[1] ? Math.max(0, parseInt(m[1], 10) - 1) : undefined,
  };
}

export function parseElnSpreadsheet(
  sheets: Array<{ name: string; rows: any[][] }>,
  existingWells: Record<string, WellObservation> = {},
  numPlates: number = 1
): ElnSpreadsheetImportResult {
  if (!sheets || !sheets.length) {
    throw new Error('The file contains no readable sheets.');
  }

  // Prefer sheet named eln_observations, otherwise first sheet with a recognized well/reaction header
  let targetSheet = sheets.find((s) => s.name.toLowerCase() === 'eln_observations');
  if (!targetSheet) {
    targetSheet = sheets.find((s) => {
      const h = (s.rows?.[0] || []).map(normHeader);
      return h.some((c) => ['well', 'well_id', 'coord', 'coordinate', 'reaction', 'global_index'].includes(c));
    });
  }
  if (!targetSheet) targetSheet = sheets[0];

  const rawRows = (targetSheet.rows || []).filter((r) =>
    r.some((c) => c != null && String(c).trim() !== '')
  );
  if (rawRows.length < 2) {
    throw new Error('The spreadsheet needs a header row and at least one well row.');
  }

  const headers = rawRows[0].map(normHeader);
  const findCol = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));

  const cPlate = findCol(['plate', 'plate_number', 'plate_idx', 'plate_index']);
  const cWell = findCol(['well', 'well_id', 'coord', 'coordinate', 'well_coord']);
  const cReaction = findCol(['reaction', 'rxn', 'global_index', 'global_idx', 'vial']);
  const cStatus = findCol(['status', 'outcome', 'outcome_status', 'result', 'category']);
  const cConv = findCol(['conversion_pct', 'conversion', 'conv', 'conv_pct', 'conversion_']);
  const cYield = findCol(['yield_pct', 'yield', 'assay_yield', 'yield_', 'assay_yield_pct']);
  const cTags = findCol(['tags', 'physical_tags', 'observations', 'physical_observations']);
  const cColor = findCol(['color_after', 'color', 'color_post_reaction', 'post_color']);
  const cNotes = findCol(['notes', 'well_notes', 'comments', 'observation_notes', 'note']);

  if (cWell < 0 && cReaction < 0) {
    throw new Error(
      'Could not find a "well" (e.g. A1..F9) or "reaction" column in the spreadsheet header.'
    );
  }

  // Detect whether plate numbers in this sheet are 0-indexed or 1-indexed
  const plateValues =
    cPlate >= 0
      ? rawRows
          .slice(1)
          .map((r) => Number(r[cPlate]))
          .filter((n) => Number.isFinite(n))
      : [];
  const hasZeroPlate = plateValues.some((n) => n === 0);

  const mergedWells: Record<string, WellObservation> = { ...existingWells };
  let updatedCount = 0;
  let skippedCount = 0;
  const warnings: string[] = [];

  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    let pIdx: number | undefined;
    let wIdx: number | undefined;

    if (cPlate >= 0 && r[cPlate] != null && String(r[cPlate]).trim() !== '') {
      const pNum = Number(r[cPlate]);
      if (Number.isFinite(pNum) && pNum >= 0) {
        pIdx = hasZeroPlate ? Math.floor(pNum) : Math.max(0, Math.floor(pNum) - 1);
      }
    }

    if (cWell >= 0 && r[cWell] != null && String(r[cWell]).trim() !== '') {
      const parsed = parseWellCoordinate(r[cWell]);
      if (parsed) {
        wIdx = parsed.wellIndex;
        if (pIdx === undefined && parsed.plateIndex !== undefined) {
          pIdx = parsed.plateIndex;
        }
      }
    }

    if (wIdx === undefined && cReaction >= 0 && r[cReaction] != null && String(r[cReaction]).trim() !== '') {
      const rxn = Number(r[cReaction]);
      if (Number.isFinite(rxn) && rxn >= 1) {
        const gIdx = Math.floor(rxn) - 1;
        wIdx = gIdx % PLATE_SIZE;
        if (pIdx === undefined) pIdx = Math.floor(gIdx / PLATE_SIZE);
      }
    }

    if (wIdx === undefined) {
      skippedCount++;
      if (warnings.length < 5) {
        warnings.push(`Row ${i + 1}: could not determine well coordinate.`);
      }
      continue;
    }

    if (pIdx === undefined) pIdx = 0;
    if (pIdx >= numPlates) {
      // Allow multi-plate imports gracefully, or warn if beyond current plate count
      if (warnings.length < 5) {
        warnings.push(`Row ${i + 1}: Plate ${pIdx + 1} is outside current ${numPlates}-plate run (kept in ELN map).`);
      }
    }

    const key = `${pIdx}-${wIdx}`;
    const prev = mergedWells[key] || {
      wellIndex: wIdx,
      plateIndex: pIdx,
      status: 'none' as WellOutcomeStatus,
      tags: [],
    };

    const next: WellObservation = {
      ...prev,
      wellIndex: wIdx,
      plateIndex: pIdx,
    };

    if (cStatus >= 0 && r[cStatus] !== undefined) {
      next.status = normalizeElnStatus(r[cStatus]);
      next.scaleUpSelected = next.status === 'hit';
    }
    if (cConv >= 0 && r[cConv] !== undefined) {
      next.conversion = parsePercentCell(r[cConv]);
    }
    if (cYield >= 0 && r[cYield] !== undefined) {
      next.yield = parsePercentCell(r[cYield]);
    }
    if (cTags >= 0 && r[cTags] !== undefined) {
      next.tags = normalizeElnTags(r[cTags]);
    }
    if (cColor >= 0 && r[cColor] !== undefined) {
      next.colorAfter = String(r[cColor] ?? '').trim();
    }
    if (cNotes >= 0 && r[cNotes] !== undefined) {
      next.notes = String(r[cNotes] ?? '').trim();
    }

    mergedWells[key] = next;
    updatedCount++;
  }

  return {
    wells: mergedWells,
    updatedCount,
    skippedCount,
    warnings,
  };
}
