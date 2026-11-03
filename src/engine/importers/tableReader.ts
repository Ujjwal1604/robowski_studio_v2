// Robowski Studio - Table & Archive Reader for CSV, TSV, and XLSX

export async function readZipFile(file: File | Blob): Promise<Record<string, Uint8Array>> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a readable XLSX/ZIP archive.');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const files: Record<string, Uint8Array> = {};
  let ptr = cdOffset;
  let totalU = 0;

  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Invalid XLSX central directory.');
    const method = view.getUint16(ptr + 10, true);
    const csize = view.getUint32(ptr + 20, true);
    const usize = view.getUint32(ptr + 24, true);

    if (usize > 64e6 || (totalU += usize) > 200e6) {
      throw new Error(
        'This archive expands to more than 200 MB, so it was not opened. A real run file is far smaller.'
      );
    }
    const nlen = view.getUint16(ptr + 28, true);
    const elen = view.getUint16(ptr + 30, true);
    const clen = view.getUint16(ptr + 32, true);
    const loff = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.slice(ptr + 46, ptr + 46 + nlen));
    const lnl = view.getUint16(loff + 26, true);
    const lel = view.getUint16(loff + 28, true);
    const start = loff + 30 + lnl + lel;
    const packed = bytes.slice(start, start + csize);
    let data: Uint8Array;

    if (method === 0) {
      data = packed;
    } else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error(
          'This browser cannot read compressed XLSX files; try the current version of Chrome or Edge.'
        );
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([packed]).stream().pipeThrough(ds);
      const rd = stream.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        got += value.length;
        if (got > usize) {
          try {
            await rd.cancel();
          } catch (e) {}
          throw new Error('Could not decompress ' + name + ': it is larger than the archive says.');
        }
        parts.push(value);
      }
      data = new Uint8Array(got);
      let off = 0;
      for (const x of parts) {
        data.set(x, off);
        off += x.length;
      }
    } else {
      throw new Error(`Unsupported XLSX compression method ${method}.`);
    }

    if (data.length !== usize) throw new Error(`Could not decompress ${name}.`);
    files[name] = data;
    ptr += 46 + nlen + elen + clen;
  }
  return files;
}

export function parseXml(bytes: Uint8Array): Document {
  const str = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XLSX contains invalid XML.');
  return doc;
}

export function readAllSheets(files: Record<string, Uint8Array>): Record<string, any[][]> {
  const shared = files['xl/sharedStrings.xml']
    ? Array.from(parseXml(files['xl/sharedStrings.xml']).getElementsByTagNameNS('*', 'si')).map((si) =>
        Array.from(si.getElementsByTagNameNS('*', 't'))
          .map((t) => t.textContent)
          .join('')
      )
    : [];
  const wb = parseXml(files['xl/workbook.xml']);
  const rels = parseXml(files['xl/_rels/workbook.xml.rels']);
  const out: Record<string, any[][]> = {};
  const relOf = Object.fromEntries(
    Array.from(rels.getElementsByTagNameNS('*', 'Relationship')).map((r) => [
      r.getAttribute('Id'),
      r.getAttribute('Target'),
    ])
  );

  for (const sh of Array.from(wb.getElementsByTagNameNS('*', 'sheet'))) {
    const rid =
      sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
      sh.getAttribute('r:id');
    const target = relOf[rid || ''];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    if (!files[path]) continue;
    const sheet = parseXml(files[path]);
    const rows: any[][] = [];

    for (const c of Array.from(sheet.getElementsByTagNameNS('*', 'c'))) {
      const ref = c.getAttribute('r') || '';
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      let col = 0;
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const r = Number(m[2]) - 1;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagNameNS('*', 'v')[0];
      const inl = c.getElementsByTagNameNS('*', 'is')[0];
      let value: any = null;
      if (type === 'inlineStr' && inl) {
        value = Array.from(inl.getElementsByTagNameNS('*', 't'))
          .map((t) => t.textContent)
          .join('');
      } else if (v) {
        const txt = v.textContent || '';
        if (type === 's') value = shared[Number(txt)] ?? '';
        else if (type === 'str') value = txt;
        else if (type === 'b') value = txt === '1';
        else value = txt === '' ? null : Number.isFinite(Number(txt)) ? Number(txt) : txt;
      }
      (rows[r] = rows[r] || [])[col] = value;
    }
    out[sh.getAttribute('name') || ''] = Array.from(rows, (r) => r || []);
  }
  return out;
}

export function parseDelimited(text: string): string[][] {
  text = text.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const d = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const delim = counts[d] ? d : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inq = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inq) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inq = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inq = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export async function readTableFile(file: File): Promise<Array<{ name: string; rows: any[][] }>> {
  const name = file.name || '';
  if (/\.xls$/i.test(name)) {
    throw new Error('Old .xls files are not supported. Save the file as .xlsx or .csv.');
  }
  if (/\.xls[xm]$/i.test(name)) {
    const sheets = readAllSheets(await readZipFile(file));
    return Object.entries(sheets).map(([n, rows]) => ({ name: n, rows }));
  }
  return [{ name, rows: parseDelimited(await file.text()) }];
}
