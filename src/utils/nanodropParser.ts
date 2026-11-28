// Browser-native Thermo NanoDrop UV-Vis XML (SpreadsheetML) & CSV parser,
// clean CSV exporter (matching robowski/zeus-pipetter/misc/nanodrop_xml_to_csv_simplified.py),
// and exact multi-component non-negative least-squares (NNLS) spectral deconvolution
// (matching robowski/zeus-pipetter/misc/UV-Vis_deconvolute.py).

export interface ParsedSpectrum {
  id: string;
  name: string;
  originalName: string;
  isMarkedRemove: boolean;
  isDuplicate: boolean;
  timestamp?: string;
  values: number[];
}

export interface ParsedNanoDropDataset {
  fileName: string;
  format: 'xml' | 'csv';
  wavelengths: number[];
  spectra: ParsedSpectrum[];
  duplicateNames: string[];
  removedCount: number;
  warnings: string[];
}

export interface SpectrumPeak {
  wavelength: number;
  absorbance: number;
}

export interface DeconvolutionReference {
  id: string;
  name: string;
  values: number[];
  refConcMm?: number;
}

export interface DeconvolutionResult {
  weights: number[];
  concentrationsMm: Array<number | null>;
  fractionsPct: number[];
  baseline: number;
  r2: number;
  rmse: number;
  fitted: number[];
  residual: number[];
  wavelengths: number[];
  measured: number[];
}

function getDirectChildrenByLocalName(parent: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i];
    if (child.localName === localName || child.nodeName.endsWith(`:${localName}`) || child.nodeName === localName) {
      out.push(child);
    }
  }
  return out;
}

function getCellText(cell: Element | undefined): string {
  if (!cell) return '';
  const dataEls = getDirectChildrenByLocalName(cell, 'Data');
  if (dataEls.length > 0) {
    return (dataEls[0].textContent || '').trim();
  }
  return (cell.textContent || '').trim();
}

function parseNanoDropXml(fileName: string, content: string): ParsedNanoDropDataset {
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'application/xml');
  const parserErr = doc.getElementsByTagName('parsererror');
  if (parserErr && parserErr.length > 0) {
    throw new Error('This XML file could not be read. Make sure it is a Thermo NanoDrop .xml export.');
  }

  const root = doc.documentElement;
  if (!root) {
    throw new Error('XML file is empty.');
  }

  // Locate Worksheet elements (skip Styles, exact match to nanodrop_xml_to_csv_simplified.py)
  const worksheets = getDirectChildrenByLocalName(root, 'Worksheet');
  const warnings: string[] = [];

  if (worksheets.length === 0) {
    throw new Error('No NanoDrop worksheet data found in this XML file.');
  }

  const rawSamples: Array<{
    name: string;
    timestamp?: string;
    map: Map<number, number>;
  }> = [];
  const allWavelengthSet = new Set<number>();

  worksheets.forEach((ws, wsIdx) => {
    const tables = getDirectChildrenByLocalName(ws, 'Table');
    if (tables.length === 0) return;
    const rows = getDirectChildrenByLocalName(tables[0], 'Row');
    if (rows.length <= 5) return;

    const map = new Map<number, number>();
    let sampleTitle = '';
    let sampleTime = '';

    // Rows 0..4 are headers/empty in NanoDrop XML; data starts at row index 5
    for (let r = 5; r < rows.length; r += 1) {
      const cells = getDirectChildrenByLocalName(rows[r], 'Cell');
      if (cells.length < 2) continue;
      const wlRaw = getCellText(cells[0]);
      const absRaw = getCellText(cells[1]);
      const wl = Number(wlRaw);
      const abs = Number(absRaw);
      if (Number.isFinite(wl) && Number.isFinite(abs)) {
        map.set(wl, abs);
        allWavelengthSet.add(wl);
      }
      if (!sampleTitle && cells.length >= 3) {
        const t = getCellText(cells[2]);
        if (t) sampleTitle = t;
      }
      if (!sampleTime && cells.length >= 4) {
        const ts = getCellText(cells[3]);
        if (ts) sampleTime = ts;
      }
    }

    if (map.size > 0) {
      const wsNameAttr = ws.getAttribute('ss:Name') || ws.getAttribute('Name') || '';
      rawSamples.push({
        name: sampleTitle || wsNameAttr || `Sample_${wsIdx + 1}`,
        timestamp: sampleTime || undefined,
        map,
      });
    }
  });

  if (rawSamples.length === 0 || allWavelengthSet.size === 0) {
    throw new Error('No wavelength/absorbance rows found inside this NanoDrop XML file.');
  }

  const wavelengths = Array.from(allWavelengthSet).sort((a, b) => a - b);
  return finalizeDataset(fileName, 'xml', wavelengths, rawSamples, warnings);
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseNanoDropCsv(fileName: string, content: string): ParsedNanoDropDataset {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error('CSV file needs at least a header row and one wavelength row.');
  }

  const first = lines[0];
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const headers = splitCsvLine(first, delimiter);
  if (headers.length < 2) {
    throw new Error('CSV file must have wavelength in the first column and at least one sample column.');
  }

  const sampleMaps = headers.slice(1).map((h, i) => ({
    name: h || `Sample_${i + 1}`,
    timestamp: undefined as string | undefined,
    map: new Map<number, number>(),
  }));
  const wlSet = new Set<number>();

  for (let r = 1; r < lines.length; r += 1) {
    const cols = splitCsvLine(lines[r], delimiter);
    if (cols.length < 2) continue;
    const wl = Number(cols[0]);
    if (!Number.isFinite(wl)) continue;
    wlSet.add(wl);
    for (let c = 1; c < cols.length && c - 1 < sampleMaps.length; c += 1) {
      const val = Number(cols[c]);
      if (Number.isFinite(val)) {
        sampleMaps[c - 1].map.set(wl, val);
      }
    }
  }

  const nonEmpty = sampleMaps.filter((s) => s.map.size > 0);
  if (nonEmpty.length === 0 || wlSet.size === 0) {
    throw new Error('No numeric wavelength/absorbance data found in this CSV file.');
  }

  const wavelengths = Array.from(wlSet).sort((a, b) => a - b);
  return finalizeDataset(fileName, 'csv', wavelengths, nonEmpty, []);
}

function finalizeDataset(
  fileName: string,
  format: 'xml' | 'csv',
  wavelengths: number[],
  rawSamples: Array<{ name: string; timestamp?: string; map: Map<number, number> }>,
  warnings: string[]
): ParsedNanoDropDataset {
  const counts = new Map<string, number>();
  for (const s of rawSamples) {
    counts.set(s.name, (counts.get(s.name) || 0) + 1);
  }
  const duplicateNames = Array.from(counts.entries())
    .filter(([, cnt]) => cnt > 1)
    .map(([name]) => name);

  const seenPerName = new Map<string, number>();
  let removedCount = 0;

  const spectra: ParsedSpectrum[] = rawSamples.map((s, idx) => {
    const seen = (seenPerName.get(s.name) || 0) + 1;
    seenPerName.set(s.name, seen);
    const isDuplicate = (counts.get(s.name) || 0) > 1;
    const isMarkedRemove = s.name.toLowerCase().includes('remove');
    if (isMarkedRemove) removedCount += 1;

    const displayName = isDuplicate ? `${s.name} (#${seen})` : s.name;
    const values = wavelengths.map((wl) => {
      const v = s.map.get(wl);
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    });

    return {
      id: `sp_${idx}_${displayName}`,
      name: displayName,
      originalName: s.name,
      isMarkedRemove,
      isDuplicate,
      timestamp: s.timestamp,
      values,
    };
  });

  if (duplicateNames.length > 0) {
    warnings.push(
      `Found duplicate sample name(s): ${duplicateNames.join(', ')}. Numbered automatically so no spectra were lost.`
    );
  }

  return {
    fileName,
    format,
    wavelengths,
    spectra,
    duplicateNames,
    removedCount,
    warnings,
  };
}

export function parseNanoDropFile(fileName: string, content: string): ParsedNanoDropDataset {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('The selected file is empty.');
  }
  const looksXml = fileName.toLowerCase().endsWith('.xml') || trimmed.startsWith('<?xml') || trimmed.startsWith('<Workbook');
  return looksXml ? parseNanoDropXml(fileName, trimmed) : parseNanoDropCsv(fileName, trimmed);
}

export function subtractBlank(values: number[], blankValues: number[] | null): number[] {
  if (!blankValues || blankValues.length !== values.length) return values;
  return values.map((v, i) => v - blankValues[i]);
}

export function findSpectrumPeak(
  wavelengths: number[],
  values: number[],
  minNm: number,
  maxNm: number
): SpectrumPeak | null {
  let bestWl = -1;
  let bestAbs = -Infinity;
  for (let i = 0; i < wavelengths.length; i += 1) {
    const wl = wavelengths[i];
    if (wl < minNm || wl > maxNm) continue;
    const v = values[i];
    if (Number.isFinite(v) && v > bestAbs) {
      bestAbs = v;
      bestWl = wl;
    }
  }
  return bestWl >= 0 ? { wavelength: bestWl, absorbance: bestAbs } : null;
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function buildCleanNanoDropCsv(
  dataset: ParsedNanoDropDataset,
  options: {
    skipRemove: boolean;
    blankId: string;
    minNm: number;
    maxNm: number;
  }
): string {
  const blankSpec = options.blankId
    ? dataset.spectra.find((s) => s.id === options.blankId) || null
    : null;
  const kept = dataset.spectra.filter((s) => {
    if (options.skipRemove && s.isMarkedRemove) return false;
    if (blankSpec && s.id === blankSpec.id) return false;
    return true;
  });

  const header = ['wavelength', ...kept.map((s) => csvEscape(s.name))].join(',');
  const rows: string[] = [header];

  for (let i = 0; i < dataset.wavelengths.length; i += 1) {
    const wl = dataset.wavelengths[i];
    if (wl < options.minNm || wl > options.maxNm) continue;
    const cols = [String(wl)];
    for (const sp of kept) {
      const val = blankSpec ? sp.values[i] - blankSpec.values[i] : sp.values[i];
      cols.push(Number.isFinite(val) ? val.toFixed(5) : '');
    }
    rows.push(cols.join(','));
  }

  return rows.join('\n');
}

// Small exact linear system solver (Gaussian elimination with partial pivoting)
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(M[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const pivot = M[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = M[r][col] / pivot;
      for (let c = col; c <= n; c += 1) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = M[r][n];
    for (let c = r + 1; c < n; c += 1) {
      sum -= M[r][c] * x[c];
    }
    x[r] = sum / M[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

/**
 * Exact non-negative linear least squares for up to 4 reference spectra
 * plus an optional unconstrained baseline offset:
 *   y(λ) ≈ Σ_{j=1..k} w_j * R_j(λ) + baseline,  w_j >= 0
 */
export function deconvolveMixture(
  wavelengths: number[],
  mixtureValues: number[],
  references: DeconvolutionReference[],
  options: { minNm: number; maxNm: number; includeBaseline: boolean }
): DeconvolutionResult | null {
  if (references.length === 0 || references.length > 4) return null;

  const indices: number[] = [];
  for (let i = 0; i < wavelengths.length; i += 1) {
    if (wavelengths[i] >= options.minNm && wavelengths[i] <= options.maxNm) {
      indices.push(i);
    }
  }
  if (indices.length < 3) return null;

  const wls = indices.map((i) => wavelengths[i]);
  const y = indices.map((i) => mixtureValues[i]);
  const R = references.map((ref) => indices.map((i) => ref.values[i]));
  const k = references.length;
  const n = y.length;

  let bestSse = Infinity;
  let bestWeights = new Array<number>(k).fill(0);
  let bestBaseline = 0;

  // Evaluate all 2^k active reference subsets for exact global NNLS optimum
  const maskLimit = 1 << k;
  for (let mask = 0; mask < maskLimit; mask += 1) {
    const active: number[] = [];
    for (let j = 0; j < k; j += 1) {
      if ((mask & (1 << j)) !== 0) active.push(j);
    }
    const cols: number[][] = active.map((j) => R[j]);
    if (options.includeBaseline) {
      cols.push(new Array<number>(n).fill(1));
    }
    const p = cols.length;
    let sol: number[] = [];
    if (p > 0) {
      const ata: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
      const aty: number[] = new Array<number>(p).fill(0);
      for (let a = 0; a < p; a += 1) {
        let sY = 0;
        for (let i = 0; i < n; i += 1) sY += cols[a][i] * y[i];
        aty[a] = sY;
        for (let b = a; b < p; b += 1) {
          let sAB = 0;
          for (let i = 0; i < n; i += 1) sAB += cols[a][i] * cols[b][i];
          ata[a][b] = sAB;
          ata[b][a] = sAB;
        }
      }
      const solved = solveLinearSystem(ata, aty);
      if (!solved) continue;
      sol = solved;
    }

    // Check non-negativity on reference weights (baseline may be any sign)
    let feasible = true;
    const weights = new Array<number>(k).fill(0);
    for (let idx = 0; idx < active.length; idx += 1) {
      if (sol[idx] < -1e-9) {
        feasible = false;
        break;
      }
      weights[active[idx]] = Math.max(0, sol[idx]);
    }
    if (!feasible) continue;

    const baseline = options.includeBaseline ? sol[active.length] || 0 : 0;
    let sse = 0;
    for (let i = 0; i < n; i += 1) {
      let pred = baseline;
      for (let j = 0; j < k; j += 1) pred += weights[j] * R[j][i];
      const diff = y[i] - pred;
      sse += diff * diff;
    }

    if (sse < bestSse) {
      bestSse = sse;
      bestWeights = weights;
      bestBaseline = baseline;
    }
  }

  const fitted = new Array<number>(n);
  const residual = new Array<number>(n);
  let yMean = 0;
  for (let i = 0; i < n; i += 1) yMean += y[i];
  yMean /= n;

  let sst = 0;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    let pred = bestBaseline;
    for (let j = 0; j < k; j += 1) pred += bestWeights[j] * R[j][i];
    fitted[i] = pred;
    residual[i] = y[i] - pred;
    sse += residual[i] * residual[i];
    const dy = y[i] - yMean;
    sst += dy * dy;
  }

  const r2 = sst > 1e-12 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 1;
  const rmse = Math.sqrt(sse / n);

  const concentrationsMm = bestWeights.map((w, j) => {
    const rc = references[j].refConcMm;
    return typeof rc === 'number' && Number.isFinite(rc) && rc > 0 ? w * rc : null;
  });

  const weightSum = bestWeights.reduce((acc, w) => acc + w, 0);
  const fractionsPct = bestWeights.map((w) => (weightSum > 1e-9 ? (w / weightSum) * 100 : 0));

  return {
    weights: bestWeights,
    concentrationsMm,
    fractionsPct,
    baseline: bestBaseline,
    r2,
    rmse,
    fitted,
    residual,
    wavelengths: wls,
    measured: y,
  };
}
