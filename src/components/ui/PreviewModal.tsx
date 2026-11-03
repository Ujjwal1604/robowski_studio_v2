import React, { useState, useEffect } from 'react';
import { useApp, buildDataPayload } from '../../context/AppContext';
import * as Core from '../../engine';

export const PreviewModal: React.FC = () => {
  const { previewModal, closePreview, run, state, rowsCache, triBlank, triMeta, downloadExport, toast } =
    useApp();
  const [activeSheet, setActiveSheet] = useState<number>(0);
  const [xlsxSheets, setXlsxSheets] = useState<Array<{ name: string; rows: any[][] }> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const kind = previewModal?.kind;

  // Use run from data if passed, else current run
  const activeRun = previewModal?.data?.run || run;
  const activeDate = previewModal?.data?.dateStr || Core.localDate();
  const activeName = previewModal?.data?.name || state.name;

  useEffect(() => {
    setActiveSheet(0);
    setLoading(true);
    setPreviewError(null);

    if (kind === 'xlsx' && activeRun) {
      try {
        const payload = buildDataPayload(state, rowsCache, triBlank, triMeta);
        const wb = Core.workbookBytes(payload, activeRun);
        Core.readTableFile(new File([wb as BlobPart], 'robowski_run.xlsx'))
          .then((sheets) => {
            setXlsxSheets(sheets);
            setLoading(false);
          })
          .catch((e) => {
            setPreviewError(e.message);
            setLoading(false);
          });
      } catch (e: any) {
        setPreviewError(e.message);
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, [kind, activeRun, state, rowsCache, triBlank, triMeta]);

  if (!previewModal || !activeRun) return null;

  const colLetter = (i: number) => {
    let n = '',
      k = i + 1;
    while (k > 0) {
      const m = (k - 1) % 26;
      n = String.fromCharCode(65 + m) + n;
      k = Math.floor((k - 1) / 26);
    }
    return n;
  };

  const showVal = (v: any) =>
    v == null ? '' : typeof v === 'number' ? String(Number.parseFloat(v.toPrecision(11))) : String(v);

  return (
    <div
      className="modal-overlay"
      id="previewModal"
      onClick={(e) => {
        if ((e.target as HTMLElement).id === 'previewModal') closePreview();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="modal-head">
          <div className="mt" id="pvTitle">
            {kind === 'nb' ? (
              <>
                Notebook card <b>{activeName}</b>
              </>
            ) : (
              <>
                Preview{' '}
                <b>
                  {kind === 'xlsx'
                    ? 'robowski_run.xlsx'
                    : kind === 'bench'
                    ? 'bench_sheet.html'
                    : kind === 'stock'
                    ? 'stock_preparation.csv'
                    : kind === 'load'
                    ? 'deck_load_checklist.csv'
                    : kind === 'tlc'
                    ? 'tlc_lane_map.csv'
                    : kind === 'png'
                    ? 'run_card.png'
                    : 'robowski_package.zip'}
                </b>
              </>
            )}
          </div>
          <button
            type="button"
            className="ib"
            onClick={closePreview}
            aria-label="Close preview"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {previewError ? (
            <div className="issue bad">
              <span>Could not build preview: {previewError}</span>
            </div>
          ) : loading ? (
            <div style={{ padding: '20px', textAlign: 'center' }}>Generating preview…</div>
          ) : kind === 'nb' ? (
            <div
              style={{
                overflowX: 'auto',
                border: '1px solid var(--line)',
                borderRadius: '10px',
                background: '#fff',
              }}
            >
              <div
                style={{ minWidth: '640px' }}
                dangerouslySetInnerHTML={{
                  __html: Core.notebookCardSvg(activeRun, activeDate).replace(
                    /width="\d+" height="\d+" viewBox/,
                    'width="100%" viewBox'
                  ),
                }}
              />
            </div>
          ) : kind === 'stock' || kind === 'load' || kind === 'tlc' ? (
            (() => {
              const text =
                kind === 'stock'
                  ? Core.stockCsv(activeRun)
                  : kind === 'load'
                  ? Core.loadCsv(activeRun)
                  : Core.tlcLaneCsv(activeRun);
              const rows = Core.parseDelimited(text).filter((r) => r.some((c) => c !== ''));
              const head = rows[0] || [];
              const previewRows = rows.slice(1, 201);
              return (
                <>
                  <div className="preview-meta">
                    <span>
                      <b>
                        {kind === 'stock'
                          ? 'Stock preparation'
                          : kind === 'load'
                          ? 'Deck load checklist'
                          : 'TLC lane map (column-order)'}
                      </b>
                    </span>
                    <span>CSV · comma-separated</span>
                    <span>
                      <b>{rows.length - 1}</b> rows
                    </span>
                  </div>
                  <div className="tbl" style={{ maxHeight: '58vh', overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          {head.map((h, i) => (
                            <th key={i}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((r, ri) => (
                          <tr key={ri}>
                            {head.map((_, ci) => (
                              <td key={ci}>{r[ci] ?? ''}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rows.length > 201 && (
                    <div className="hint" style={{ marginTop: '10px' }}>
                      Showing 200 of {rows.length - 1} rows. Download to see all.
                    </div>
                  )}
                </>
              );
            })()
          ) : kind === 'xlsx' ? (
            xlsxSheets ? (
              <>
                <div className="preview-meta">
                  <span>
                    <b>Excel workbook</b>
                  </span>
                  <span>Binary · {xlsxSheets.length} sheets</span>
                </div>
                <div className="hint" style={{ marginBottom: '8px' }}>
                  This view is read back from the generated file itself, laid out like Excel (row
                  numbers, column letters).
                </div>
                <div className="sheettabs" role="tablist">
                  {xlsxSheets.map((sh, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`sheettab ${activeSheet === i ? 'on' : ''}`}
                      onClick={() => setActiveSheet(i)}
                      role="tab"
                      aria-selected={activeSheet === i}
                    >
                      {sh.name}
                    </button>
                  ))}
                </div>
                {xlsxSheets[activeSheet] && (
                  <div className="sheetpane">
                    <div className="tbl" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            <th />
                            {Array.from(
                              {
                                length: Math.max(
                                  1,
                                  ...xlsxSheets[activeSheet].rows.map((r) => r.length)
                                ),
                              },
                              (_, c) => (
                                <th key={c}>{colLetter(c)}</th>
                              )
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {xlsxSheets[activeSheet].rows.slice(0, 200).map((r, ri) => (
                            <tr key={ri}>
                              <th>{ri + 1}</th>
                              {Array.from(
                                {
                                  length: Math.max(
                                    1,
                                    ...xlsxSheets[activeSheet].rows.map((row) => row.length)
                                  ),
                                },
                                (_, c) => (
                                  <td
                                    key={c}
                                    style={{
                                      textAlign: typeof r[c] === 'number' ? 'right' : 'left',
                                    }}
                                  >
                                    {showVal(r[c])}
                                  </td>
                                )
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="hint" style={{ marginTop: '8px' }}>
                      {xlsxSheets[activeSheet].rows.length} rows including the header
                      {xlsxSheets[activeSheet].rows.length > 200
                        ? '; showing the first 200. Download to see all.'
                        : '.'}
                    </div>
                  </div>
                )}
              </>
            ) : null
          ) : kind === 'bench' ? (
            (() => {
              const bp = Core.benchSheetParts(activeRun, activeDate);
              return (
                <>
                  <div className="preview-meta">
                    <span>
                      <b>Bench sheet</b>
                    </span>
                    <span>HTML · prints on 1-2 pages</span>
                  </div>
                  <style>{bp.css}</style>
                  <div
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: '10px',
                      background: '#fff',
                      padding: '18px',
                      maxHeight: '58vh',
                      overflow: 'auto',
                    }}
                    dangerouslySetInnerHTML={{ __html: bp.body }}
                  />
                  <div className="hint" style={{ marginTop: '8px' }}>
                    Open the downloaded file in any browser and print it (Ctrl+P / Cmd+P) for the
                    hood.
                  </div>
                </>
              );
            })()
          ) : kind === 'png' ? (
            <div className="preview-svg" style={{ textAlign: 'center' }}>
              <div
                style={{
                  maxWidth: '100%',
                  borderRadius: '10px',
                  boxShadow: 'var(--shadow-md)',
                  background: '#fff',
                  overflow: 'hidden',
                }}
                dangerouslySetInnerHTML={{
                  __html: Core.runCardSvg(activeRun).replace(
                    /width="\d+" height="\d+" viewBox/,
                    'width="100%" viewBox'
                  ),
                }}
              />
            </div>
          ) : kind === 'zip' ? (
            (() => {
              const items = [
                ['robowski_run.xlsx', 'Excel workbook with robot instructions and stocks'],
                ['bench_sheet.html', 'Printable sheet for hood setup'],
                ['stock_preparation.csv', 'Stock preparation instructions and volumes'],
                ['deck_load_checklist.csv', 'Checklist for loading bottles, solvent, tips'],
                ['run_card.svg', 'Plate layout visual vector card'],
                ['run_card.png', 'Plate layout visual raster card (PNG)'],
                ['manifest.json', 'Run parameters, seed, calibration note, and metadata'],
              ];
              return (
                <>
                  <div className="preview-meta">
                    <span>
                      <b>Complete package</b>
                    </span>
                    <span>ZIP · 7 files bundled</span>
                  </div>
                  <div className="list">
                    {items.map(([f, d], i) => (
                      <div key={i}>
                        <b className="mono" style={{ minWidth: '220px' }}>
                          {f}
                        </b>
                        <span style={{ color: 'var(--fg2)' }}>{d}</span>
                      </div>
                    ))}
                  </div>
                  <div className="hint" style={{ marginTop: '12px' }}>
                    The workbook, both CSVs, the plate-layout card (SVG and PNG) and a manifest with
                    the seed and assumptions, in one zip.
                  </div>
                </>
              );
            })()
          ) : null}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={closePreview}>
            Close
          </button>
          {kind === 'nb' ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const txt = Core.notebookText(activeRun, activeDate);
                  try {
                    await navigator.clipboard.writeText(txt);
                    toast('Copied. Paste into your notebook or slide notes.');
                  } catch (e) {
                    toast('Could not copy to clipboard.');
                  }
                }}
              >
                Copy as text
              </button>
              <button
                type="button"
                className="btn pri"
                onClick={async () => {
                  try {
                    const pngBytes = await Core.notebookCardPngBytes(activeRun, activeDate);
                    const blob = new Blob([pngBytes as BlobPart], { type: 'image/png' });
                    const url = URL.createObjectURL(blob);
                    const el = document.createElement('a');
                    el.href = url;
                    el.download = `notebook_card_${activeName.replace(/[^A-Za-z0-9_-]+/g, '_')}.png`;
                    document.body.appendChild(el);
                    el.click();
                    el.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 4000);
                    closePreview();
                    toast('Saved image (PNG).');
                  } catch (e: any) {
                    toast('Could not make image: ' + e.message);
                  }
                }}
              >
                Save image (PNG)
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                closePreview();
                downloadExport(kind!);
              }}
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
