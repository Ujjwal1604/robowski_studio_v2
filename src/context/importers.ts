// Robowski Studio - Library Spreadsheet and Backup Importers
import { LibraryReagent } from '../types';
import * as Core from '../engine';

export async function parseLibrarySpreadsheet(
  f: File,
  currentLib: LibraryReagent[]
): Promise<{ added: number; updated: number; nextLib: LibraryReagent[] } | null> {
  const sheets = await Core.readTableFile(f);
  let found: any = null;
  const LIBHDR: [string, RegExp][] = [
    ['cas', /^cas/],
    ['smiles', /smiles/],
    ['iupac', /iupac|systematic/],
    ['note', /^(note|comment|remark|description)/],
    ['stock', /stock.*(mm|conc|molar|mmol)|^stock$/],
    ['solv', /solvent/],
    ['dens', /dens|g ?ml|g ?cm/],
    ['mm', /(molar|molecular|formula|mol) ?(mass|weight|wt)|^(mw|fw|mr)( |$)|g ?mol/],
    ['name', /^(name|reagent|compound|chemical|substance|material)|name/],
  ];

  const mapCols = (row: any[]) => {
    const cols: Record<string, number> = {};
    row.forEach((h, ci) => {
      const n = String(h == null ? '' : h)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!n) return;
      for (const [k, re] of LIBHDR) {
        if (cols[k] == null && re.test(n)) {
          cols[k] = ci;
          break;
        }
      }
    });
    return cols;
  };

  const parseNumLoose = (v: any) => {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    let t = String(v).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (/^[-+]?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else t = t.replace(',', '.');
    const m = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(t);
    return m ? parseFloat(m[0]) : NaN;
  };

  for (const sh of sheets) {
    for (let ri = 0; ri < Math.min(15, sh.rows.length); ri++) {
      const cols = mapCols(sh.rows[ri] || []);
      if (cols.name != null && cols.mm != null) {
        found = { sh, ri, cols };
        break;
      }
    }
    if (found) break;
  }

  if (!found) return null;

  const { sh, ri, cols } = found;
  const byName = new Map(currentLib.map((l) => [String(l.name).trim().toLowerCase(), l]));
  let added = 0;
  let updated = 0;
  const nextLib = [...currentLib];

  for (let r = ri + 1; r < sh.rows.length; r++) {
    const row = sh.rows[r] || [];
    const name = String(row[cols.name] ?? '').trim();
    if (!name) continue;
    const mm = parseNumLoose(row[cols.mm]);
    if (!Number.isFinite(mm) || mm <= 0) continue;
    const dens = cols.dens != null ? parseNumLoose(row[cols.dens]) : NaN;
    const st = cols.stock != null ? parseNumLoose(row[cols.stock]) : NaN;
    const solv = cols.solv != null ? Core.canonicalSolvent(row[cols.solv]) : '';
    const item: any = {
      name,
      molarMass: mm,
      density: Number.isFinite(dens) && dens > 0 ? dens : 0,
    };
    if (cols.cas != null && row[cols.cas]) item.cas = String(row[cols.cas]).trim();
    if (cols.smiles != null && row[cols.smiles]) item.smiles = String(row[cols.smiles]).trim();
    if (cols.iupac != null && row[cols.iupac]) item.iupac = String(row[cols.iupac]).trim();
    if (cols.note != null && row[cols.note]) item.notes = String(row[cols.note]).trim();
    if (Number.isFinite(st) && st > 0) item.stock = st;
    if (solv) item.solvent = solv;

    const existing = byName.get(name.toLowerCase());
    if (existing) {
      Object.assign(existing, item);
      updated++;
    } else {
      item.id = 'lib_' + Math.random().toString(36).slice(2, 9);
      nextLib.push(item);
      byName.set(name.toLowerCase(), item);
      added++;
    }
  }

  return { added, updated, nextLib };
}
