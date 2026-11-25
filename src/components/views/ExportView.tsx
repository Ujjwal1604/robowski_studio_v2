import React, { useEffect, useState } from 'react';
import { chooseSaveFolder, clearSaveFolder, folderSaveSupported, getSaveFolderName } from '../../utils/folderSave';
import { exportFilenameForKind } from '../../utils/exportFilename';
import { useApp } from '../../context/AppContext';
import { getImagesForSets } from '../../context/tlcStorage';
import { notebookCardSvg, localDate } from '../../engine';
import * as Core from '../../engine';

export const ExportView: React.FC = () => {
  const {
    state,
    setPath,
    run,
    err,
    openPreview,
    downloadExport,
    saveRun,
    setView,
    setVisited,
    toast,
    tlcSets,
    activeTlcStatus,
    exportRobowskiArchive,
    backendStatus,
    backendUrl,
    setBackendPanelOpen,
  } = useApp();

  const [descOpen, setDescOpen] = useState(false);
  const [labPcBusy, setLabPcBusy] = useState<'archive' | 'eln' | null>(null);
  const [saveFolder, setSaveFolder] = useState<string | null>(null);
  useEffect(() => {
    getSaveFolderName().then(setSaveFolder).catch(() => {});
  }, []);

  const blocked = !run || run.blockingIssues > 0;

  const runTitle = state.name || run?.runName;
  const exportDate = localDate();

  const handleSaveArchiveToLabPc = async () => {
    if (!run || run.blockingIssues > 0) return;
    setLabPcBusy('archive');
    try {
      const imageBlobs = await getImagesForSets(tlcSets);
      const archiveBytes = await Core.buildRobowskiArchive(state, run, tlcSets, imageBlobs);
      const filename = exportFilenameForKind('robowski', runTitle, exportDate);
      const res = await Core.saveArchiveToBackend(runTitle || 'run', filename, archiveBytes, backendUrl);
      if (res.success) {
        toast(`Saved archive directly to your Lab PC (${res.relativePath || filename}).`);
      } else {
        toast(res.error || 'Could not save archive to Lab PC.');
      }
    } catch (e: any) {
      toast('Archive save error: ' + (e?.message || e));
    } finally {
      setLabPcBusy(null);
    }
  };

  const handleExportIllustratedEln = async () => {
    if (!run) return;
    setLabPcBusy('eln');
    try {
      const cond = Core.getCanonicalRunConditions(state);
      const obsMap = state.eln?.wells || {};
      const observations = Object.entries(obsMap).map(([key, ob]: [string, any]) => {
        const [pStr, wStr] = key.split('-');
        const pIdx = Number(pStr) || 0;
        const wIdx = Number(wStr) || 0;
        return {
          plate: pIdx + 1,
          well: Core.wellLabel(wIdx),
          outcome: ob?.outcome || '',
          tags: Array.isArray(ob?.tags) ? ob.tags : [],
          notes: ob?.notes || '',
          components: '',
        };
      });
      const res = await Core.downloadIllustratedElnXlsx(
        {
          runName: runTitle || 'Robowski_Run',
          hood: state.hood,
          mode: state.mode,
          date: exportDate,
          conditions: {
            Solvent: cond.solvent,
            'Temperature (°C)': cond.temperatureC,
            'Base Water (%)': cond.baseWaterPct,
            'Reaction Time (h)': cond.reactionTimeHours,
            Atmosphere: cond.atmosphere,
            Agitation: cond.agitation,
          },
          reagents: state.reagents.map((r) => ({
            code: r.code,
            name: r.name,
            smiles: r.smiles,
            molarMass: r.molarMass,
            stock: r.stock,
            solvent: r.solvent,
          })),
          observations,
        },
        backendUrl
      );
      if (res.ok && res.blob) {
        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || `${runTitle || 'run'}_ELN_Illustrated.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast(`Downloaded ${res.filename} with embedded 2D structures.`);
      } else {
        toast(res.error || 'Could not generate illustrated Excel ELN.');
      }
    } finally {
      setLabPcBusy(null);
    }
  };

  const files = [
    [
      'robowski',
      exportFilenameForKind('robowski', runTitle, exportDate),
      'Complete self-contained experiment archive: reaction recipe, robot XLSX, hood bench sheet, and high-res TLC plate images + densitograms.',
    ],
    [
      'xlsx',
      exportFilenameForKind('xlsx', runTitle, exportDate),
      'The input workbook for the robot: reactions_with_run_info and stock_solutions sheets, plus reference sheets.',
    ],
    [
      'bench',
      exportFilenameForKind('bench', runTitle, exportDate),
      'One printable page for the hood: how to prepare each stock, where everything goes on the deck, tips to load, with tick boxes and room for notes.',
    ],
    [
      'stock',
      exportFilenameForKind('stock', runTitle, exportDate),
      'Stock preparation list with plain instructions (weigh X g, or take X mL and add Y mL), volumes and tick boxes. Opens in Excel.',
    ],
    [
      'load',
      exportFilenameForKind('load', runTitle, exportDate),
      'Deck loading checklist in the order you walk the deck: bottles, solvent, vial plates, tip racks.',
    ],
    [
      'tlc',
      exportFilenameForKind('tlc', runTitle, exportDate),
      'TLC lane mapping in column-by-column spotting order for the 6×9 plate with well coordinates, vial IDs, and reagent concentrations.',
    ],
    [
      'nb',
      exportFilenameForKind('nb', runTitle, exportDate),
      'The notebook card: conditions, reagents and stock volumes on one image, for the notebook or a slide.',
    ],
    [
      'zip',
      exportFilenameForKind('zip', runTitle, exportDate),
      'Everything above in one zip, plus the plate-layout picture and a manifest.',
    ],
  ];

  const descReagents = () => {
    const add =
      state.mode === 'triplet' ? (state.tri?.adds || []).map((a) => a.code) : [];
    return state.reagents
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !add.includes(r.code) && (r.name || r.stock !== ''));
  };

  const L = descReagents();
  const miss = L.filter((x) => !x.r.smiles).length;
  const pr = state.product || {};

  return (
    <div className="wrap">
      <div className="grid two">
        {/* Left Column: Export Files List */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2>Export</h2>
          <p className="sub">
            Files are generated here. Nothing is sent to the robot. Use Preview to inspect a file
            before downloading.
          </p>

          {blocked ? (
            <div className="issue bad" style={{ marginBottom: '14px' }}>
              <span>
                {err
                  ? err
                  : `${run?.blockingIssues || 1} blocking issue${
                      (run?.blockingIssues || 1) > 1 ? 's' : ''
                    } to fix before export.`}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setVisited((v) => ({ ...v, setup: true }));
                  setView('setup');
                }}
              >
                Open setup
              </button>
            </div>
          ) : (
            <div className="issue ok" style={{ marginBottom: '14px' }}>
              <span>
                Ready to export. All checks passed. Choose a file below to preview or save.
              </span>
            </div>
          )}

          {/* Full Experiment Archive Card */}
          <div
            style={{
              marginBottom: '16px',
              padding: '14px 16px',
              background: 'var(--subtle, rgba(0,0,0,0.02))',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 280px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                <b style={{ fontSize: '14px' }}>📦 Full Experiment Archive (.robowski)</b>
                <span
                  className="chip"
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    background: activeTlcStatus === 'ready' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: activeTlcStatus === 'ready' ? '#10b981' : '#d97706',
                    border: `1px solid ${activeTlcStatus === 'ready' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                  }}
                >
                  {activeTlcStatus === 'ready' ? '✓ TLC Ready' : '⚠️ TLC Pending'}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--mut)' }}>
                {activeTlcStatus === 'ready'
                  ? 'Includes complete reaction recipe, robot pipetting workbook, hood bench sheet, and all uploaded high-resolution TLC plate photos + densitometry traces.'
                  : 'Reaction conditions and robot workbooks are ready. TLC plate photos are not uploaded yet; you can export now for hood execution, and attach plate photos later in the TLC Map tab.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn pri"
                disabled={blocked}
                onClick={exportRobowskiArchive}
                title="Download complete .robowski experiment archive"
              >
                Export .robowski
              </button>
              {backendStatus?.connected && (
                <button
                  type="button"
                  className="btn"
                  disabled={blocked || labPcBusy !== null}
                  onClick={handleSaveArchiveToLabPc}
                  title="Save a permanent copy directly into python_backend/data/archives/ on your personal lab PC"
                >
                  {labPcBusy === 'archive' ? 'Saving…' : 'Save Copy to Lab PC'}
                </button>
              )}
            </div>
          </div>

          {/* Illustrated Excel ELN with RDKit 2D Structures (Lab PC Backend) */}
          <div
            style={{
              marginBottom: '16px',
              padding: '12px 16px',
              background: 'var(--subtle, rgba(0,0,0,0.02))',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 260px' }}>
              <b style={{ fontSize: '13.5px' }}>Illustrated Lab Notebook (.xlsx with 2D Structures)</b>
              <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
                {backendStatus?.connected
                  ? 'Uses your Lab PC Python RDKit to draw crisp 2D chemical structures directly inside Excel cells alongside reagent stocks and ELN observations.'
                  : 'Connect your personal Lab PC backend in the top bar to generate Excel notebooks with embedded 2D chemical structure drawings.'}
              </div>
            </div>
            {backendStatus?.connected ? (
              <button
                type="button"
                className="btn sm pri"
                disabled={blocked || labPcBusy !== null}
                onClick={handleExportIllustratedEln}
              >
                {labPcBusy === 'eln' ? 'Building .xlsx…' : 'Download Illustrated ELN'}
              </button>
            ) : (
              <button
                type="button"
                className="btn sm"
                onClick={() => setBackendPanelOpen(true)}
              >
                Connect Lab PC
              </button>
            )}
          </div>

          <div className="list">
            {files.map(([kind, filename, desc]) => (
              <div key={kind}>
                <b className="mono" style={{ minWidth: '190px', maxWidth: '280px', overflowWrap: 'anywhere', fontSize: '12px' }}>
                  {filename}
                </b>
                <span style={{ flex: '1 1 240px', color: 'var(--fg2)' }}>{desc}</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={blocked}
                    onClick={() => openPreview(kind)}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className="btn sm pri"
                    disabled={blocked}
                    onClick={() => downloadExport(kind)}
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: LIMS Barcode, Notebook Card, Description details & Save Run */}
        <div style={{ minWidth: 0 }}>
          {run && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 200px' }}>
                  <h2>LIMS Run Barcode</h2>
                  <p className="sub" style={{ margin: 0 }}>
                    Optical Code 128 barcode for handheld lab scanners, plate seals, and LIMS tracking.
                  </p>
                  <div style={{ marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--fg)', background: 'var(--soft)', padding: '3px 8px', borderRadius: '4px' }}>
                      {`ROB-${(run.runName || state.name || 'RUN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12)}-${localDate().replace(/-/g, '')}`}
                    </span>
                    <button
                      type="button"
                      className="btn sm"
                      style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}
                      onClick={() => {
                        const id = `ROB-${(run.runName || state.name || 'RUN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12)}-${localDate().replace(/-/g, '')}`;
                        navigator.clipboard.writeText(id);
                        toast(`Copied ${id} to clipboard`);
                      }}
                    >
                      Copy ID
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    background: '#ffffff',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--line)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                    maxWidth: '240px',
                  }}
                  dangerouslySetInnerHTML={{
                    __html: Core.generateCode128Svg(
                      `ROB-${(run.runName || state.name || 'RUN').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12)}-${localDate().replace(/-/g, '')}`,
                      36
                    ),
                  }}
                />
              </div>
            </div>
          )}

          {!blocked && run && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <h2>Notebook card</h2>
              <p className="sub">
                A one-page summary of the run for the lab notebook or a slide: conditions,
                reagents, stocks.
              </p>
              <div
                role="button"
                tabIndex={0}
                aria-label="Open the notebook card preview"
                title="Click to enlarge"
                style={{
                  cursor: 'zoom-in',
                  overflowX: 'auto',
                  border: '1px solid var(--line)',
                  borderRadius: '10px',
                  background: '#fff',
                  marginBottom: '12px',
                }}
                onClick={() => openPreview('nb')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') openPreview('nb');
                }}
              >
                <div
                  style={{ minWidth: '560px', pointerEvents: 'none' }}
                  dangerouslySetInnerHTML={{
                    __html: notebookCardSvg(run).replace(
                      /width="\d+" height="\d+" viewBox/,
                      'width="100%" viewBox'
                    ),
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button type="button" className="btn pri" onClick={() => openPreview('nb')}>
                  Preview and save image
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    if (!run) return;
                    const txt = Core.notebookText(run, localDate());
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
              </div>
            </div>
          )}

          {/* Description Sheet Details (Optional SMILES and IUPAC) */}
          <details
            className="card"
            style={{ marginBottom: '20px' }}
            open={descOpen}
            onToggle={(e) => setDescOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
              <h2 style={{ display: 'inline' }}>Description sheet details</h2>{' '}
              <span className="chip mut">optional</span>
            </summary>
            <p className="sub" style={{ marginTop: '8px' }}>
              Everything here is optional. The description sheet already lists each vial's
              substrates by name and code. Add IUPAC names, SMILES or a product only if you want them
              in the file; empty cells stay empty.{' '}
              {L.length ? `${L.length - miss} of ${L.length} SMILES filled.` : ''} The reagent
              library can store them too (smiles column).
            </p>

            {L.map(({ r, i }) => (
              <div
                key={r.code + i}
                style={{
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '8px 0',
                  borderTop: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'center',
                    flex: '1 1 100%',
                    minWidth: 0,
                  }}
                >
                  <span
                    className="rdot"
                    style={{ background: Core.PAL[i % Core.PAL.length] }}
                  >
                    {r.code}
                  </span>
                  <b style={{ overflowWrap: 'anywhere' }}>{r.name || 'no name yet'}</b>
                </div>
                <input
                  type="text"
                  className="f"
                  style={{ flex: '1 1 150px', minWidth: 0 }}
                  value={r.iupac || ''}
                  onChange={(e) => setPath(`reagents.${i}.iupac`, e.target.value)}
                  placeholder="IUPAC name (optional)"
                  aria-label={`${r.code} IUPAC name`}
                />
                <input
                  type="text"
                  className="f mono"
                  style={{ flex: '2 1 200px', minWidth: 0 }}
                  value={r.smiles || ''}
                  onChange={(e) => setPath(`reagents.${i}.smiles`, e.target.value)}
                  placeholder="SMILES"
                  aria-label={`${r.code} SMILES`}
                />
              </div>
            ))}

            <div className="lbl" style={{ margin: '14px 0 6px' }}>
              Product (same for every vial, optional)
            </div>
            <div className="pgrid">
              <div className="fld">
                <label className="lbl">Product name</label>
                <input
                  type="text"
                  className="f"
                  value={pr.name || ''}
                  onChange={(e) => setPath('product.name', e.target.value)}
                />
              </div>
              <div className="fld">
                <label className="lbl">Product code</label>
                <input
                  type="text"
                  className="f"
                  value={pr.code || ''}
                  onChange={(e) => setPath('product.code', e.target.value)}
                />
              </div>
              <div className="fld">
                <label className="lbl">Product SMILES</label>
                <input
                  type="text"
                  className="f mono"
                  value={pr.smiles || ''}
                  onChange={(e) => setPath('product.smiles', e.target.value)}
                />
              </div>
            </div>
          </details>

          {/* Save this run card */}
          <div className="card">
            <h2>Save this run</h2>
            <p className="sub">
              Keeps the settings, deck and tips as a card in the run library (this browser).
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn pri"
                onClick={() => saveRun(false)}
                disabled={!!err}
              >
                Save run
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => saveRun(true)}
                disabled={!!err}
              >
                Save as new
              </button>
            </div>
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--mut)' }}>
              {folderSaveSupported() ? (
                <>
                  Save folder (for example inside Dropbox):{' '}
                  <b>{saveFolder ?? 'not set'}</b>{' '}
                  <button
                    type="button"
                    className="btn sm"
                    onClick={async () => {
                      const res = await chooseSaveFolder();
                      if (res.name) {
                        setSaveFolder(res.name);
                        toast('Runs will also be written to "' + res.name + '" when you press Save.');
                      } else if (res.blockedReason === 'iframe-blocked') {
                        toast('Folder picker is blocked inside an embedded preview frame. Open in a standalone tab or export the .robowski archive.');
                      }
                    }}
                  >
                    {saveFolder ? 'Change folder' : 'Choose folder'}
                  </button>{' '}
                  {saveFolder && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={async () => {
                        await clearSaveFolder();
                        setSaveFolder(null);
                      }}
                    >
                      Stop
                    </button>
                  )}
                </>
              ) : (
                <>This browser cannot write to a folder directly. Use Chrome/Brave/Edge for folder auto-save, or export the .robowski archive and move it into Dropbox.</>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
