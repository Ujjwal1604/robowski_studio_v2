// Robowski Studio - Legacy Generator Spreadsheet Importer
import { canonicalSolvent, num, SOLVENT_DENSITIES } from '../constants';
import { parseXml, readZipFile } from './tableReader';

export function parseGeneratorSheet(files: Record<string, Uint8Array>): any {
  const shared = files['xl/sharedStrings.xml']
    ? Array.from(parseXml(files['xl/sharedStrings.xml']).getElementsByTagNameNS('*', 'si')).map((si) =>
        Array.from(si.getElementsByTagNameNS('*', 't'))
          .map((t) => t.textContent)
          .join('')
      )
    : [];
  const wb = parseXml(files['xl/workbook.xml']);
  const rels = parseXml(files['xl/_rels/workbook.xml.rels']);
  const sheetEl = wb.getElementsByTagNameNS('*', 'sheet')[0];
  if (!sheetEl) throw new Error('No worksheet was found in this generator workbook.');
  const rid =
    sheetEl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
    sheetEl.getAttribute('r:id');
  const rel = Array.from(rels.getElementsByTagNameNS('*', 'Relationship')).find(
    (x) => x.getAttribute('Id') === rid
  );
  if (!rel) throw new Error('Could not resolve the first generator worksheet.');
  const target = rel.getAttribute('Target') || '';
  const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const sheet = parseXml(files[path]);
  const values: Record<string, any> = {};

  for (const c of Array.from(sheet.getElementsByTagNameNS('*', 'c'))) {
    const ref = c.getAttribute('r');
    const type = c.getAttribute('t');
    const v = c.getElementsByTagNameNS('*', 'v')[0];
    const inline = c.getElementsByTagNameNS('*', 'is')[0];
    let value: any = null;
    if (type === 'inlineStr' && inline) {
      value = Array.from(inline.getElementsByTagNameNS('*', 't'))
        .map((t) => t.textContent)
        .join('');
    } else if (v) {
      const txt = v.textContent || '';
      if (type === 's') value = shared[Number(txt)] ?? '';
      else if (type === 'str') value = txt;
      else if (type === 'b') value = txt === '1';
      else value = txt === '' ? null : Number.isFinite(Number(txt)) ? Number(txt) : txt;
    }
    if (ref) values[ref] = value;
  }

  const val = (a: string) => values[a] ?? null;
  const mode = (() => {
    const label = String(val('A18') || '').toLowerCase();
    return label.includes('equiv') || label.includes('eqiv') ? 'equivalence' : 'concentration';
  })();
  const solvent = canonicalSolvent(val('C4') || 'ethanol');
  const reagents: any[] = [];

  for (let i = 0; i < 6; i++) {
    const col = 'CDEFGH'[i];
    const code = val(`${col}6`);
    if (!code || typeof code !== 'string' || code.trim().toLowerCase() === 'solvent') continue;
    const points = Math.max(1, Math.floor(num(val(`${col}12`), 1)));
    let min: number, step: number, max: number;
    if (mode === 'equivalence' && i > 0) {
      min = num(val(`${col}18`));
      step = num(val(`${col}19`), 1);
      max = num(val(`${col}20`), min);
    } else {
      min = num(val(`${col}15`));
      step = num(val(`${col}16`), 1);
      max = num(val(`${col}17`), min + (points - 1) * step);
    }
    reagents.push({
      code: code.trim(),
      name: String(val(`${col}7`) || code).trim(),
      molarMass: num(val(`${col}9`)),
      density: num(val(`${col}10`)),
      liquidDensity: SOLVENT_DENSITIES[solvent] || 1,
      stock: num(val(`${col}11`), 100),
      solvent,
      points,
      min,
      step: step > 0 ? step : 1,
      max,
      prepareVolumeMl: 0,
      pipettingMode: 'empty',
    });
  }

  if (reagents.length < 2) {
    throw new Error('Could not detect at least two reagent columns in this generator workbook.');
  }

  return {
    runName: 'Imported generator',
    mode,
    vialVolume: num(val('C1'), 500),
    threshold: num(val('C2'), 50),
    dilutionFactor: num(val('C3'), 5),
    reactionSolvent: solvent,
    reagents,
    randomize: true,
    randomSeed: 20261018,
    leftoverMl: 2,
    hood: 'left',
  };
}

export async function importGenerator(file: File | Blob): Promise<any> {
  const files = await readZipFile(file);
  return parseGeneratorSheet(files);
}
