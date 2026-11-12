import React, { useState, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { SavedRun } from '../../types';
import { buildRun, localDate } from '../../engine';
import { dataFor } from '../../context/AppContext';
import { ChemicalStructure, resolveChemicalNameToSmiles } from '../ui/ChemicalStructure';
import { GroupMeetingSlideModal } from '../ui/GroupMeetingSlideModal';

export const RunsView: React.FC = () => {
  const {
    runsList,
    delRun,
    openRun,
    dupRun,
    startNewRun,
    lib,
    putLib,
    delLib,
    runFilter,
    setRunFilter,
    runSearch,
    setRunSearch,
    compareIds,
    setCompareIds,
    setView,
    openPreview,
    importRobotFile,
    importGeneratorFile,
    importLibraryFile,
    restoreBackupFile,
    importRobowskiArchiveFile,
    exportRobowskiArchive,
    toast,
  } = useApp();

  const [newName, setNewName] = useState('');
  const [newMm, setNewMm] = useState('');
  const [newDens, setNewDens] = useState('');
  const [newSmiles, setNewSmiles] = useState('');
  const [newIupac, setNewIupac] = useState('');
  const [showSlideModal, setShowSlideModal] = useState<boolean>(false);
  const [selectedForSlide, setSelectedForSlide] = useState<SavedRun[]>([]);

  const robotFileInputRef = useRef<HTMLInputElement>(null);
  const genFileInputRef = useRef<HTMLInputElement>(null);
  const libFileInputRef = useRef<HTMLInputElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const archiveFileInputRef = useRef<HTMLInputElement>(null);

  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const shown = runsList.filter((r) => {
    if (runFilter !== 'all') {
      if (runFilter === 'exported' && r.status !== 'exported') return false;
      if (runFilter === 'draft' && r.status === 'exported') return false;
    }
    if (runSearch) {
      const q = runSearch.toLowerCase();
      const codes = (r.codes || []).join(' ').toLowerCase();
      const names = (
        (r.summary || []).map((x) => x.text).join(' ') +
        (r.state ? r.state.reagents.map((x) => x.name || '').join(' ') : '')
      ).toLowerCase();
      return r.name.toLowerCase().includes(q) || codes.includes(q) || names.includes(q);
    }
    return true;
  });

  const handleAddLib = async () => {
    if (!newName.trim()) return;
    let smiles = newSmiles.trim();
    let iupac = newIupac.trim();
    let mm = parseFloat(newMm) || 0;

    // If SMILES was not supplied but name or IUPAC was, try resolving via PubChem
    if (!smiles && (iupac || newName.trim())) {
      try {
        const resolved = await resolveChemicalNameToSmiles(iupac || newName.trim());
        if (resolved?.smiles) {
          smiles = resolved.smiles;
          if (!mm && resolved.mw) mm = resolved.mw;
          if (!iupac && resolved.iupac) iupac = resolved.iupac;
        }
      } catch {}
    }

    await putLib({
      id: Math.random().toString(36).slice(2, 10),
      name: newName.trim(),
      molarMass: mm,
      density: parseFloat(newDens) || 0,
      smiles: smiles || undefined,
      iupac: iupac || undefined,
    });
    setNewName('');
    setNewMm('');
    setNewDens('');
    setNewSmiles('');
    setNewIupac('');
    toast(`Added "${newName.trim()}" to the library.`);
  };

  const handleBackup = () => {
    const pack = {
      format: 'robowski-studio-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      runs: runsList,
      library: lib,
    };
    const blob = new Blob([JSON.stringify(pack, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `robowski_backup_${localDate()}.json`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    try {
      localStorage.setItem('rs.lastBackup', String(Date.now()));
    } catch (e) {}
    toast('Backed up all runs and library to JSON.');
  };

  const handleLibTemplate = () => {
    const rows = [
      ['name', 'molar_mass_g_mol', 'density_g_mL', 'stock_solvent', 'stock_mM', 'cas', 'smiles', 'iupac_name', 'notes'],
      ['ethyl acetoacetate', '130.14', '1.03', 'ethanol', '', '141-97-9', 'CCOC(=O)CC(=O)C', 'ethyl 3-oxobutanoate', 'liquid: give density'],
      ['p-toluic acid', '136.15', '', 'ethanol', '', '99-94-5', 'Cc1ccc(C(=O)O)cc1', '4-methylbenzoic acid', 'solid: leave density empty'],
    ];
    const csv = '\ufeff' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = 'reagent_library_template.csv';
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Downloaded reagent library template.');
  };

  const handleLibExport = () => {
    const rows = [
      ['name', 'molar_mass_g_mol', 'density_g_mL', 'stock_solvent', 'stock_mM', 'cas', 'notes', 'smiles', 'iupac_name'],
      ...lib.map((x) => [
        x.name,
        x.molarMass,
        x.density || '',
        x.solvent || '',
        x.stock || '',
        x.cas || '',
        x.notes || x.note || '',
        x.smiles || '',
        x.iupac || '',
      ]),
    ];
    const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = 'reagent_library.csv';
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Exported reagent library.');
  };

  const lastBackupTime = Number(localStorage.getItem('rs.lastBackup')) || 0;
  const backupDays = lastBackupTime
    ? Math.floor((Date.now() - lastBackupTime) / 864e5)
    : null;

  return (
    <div className="wrap">
      {/* Hidden file inputs */}
      <input
        type="file"
        ref={robotFileInputRef}
        accept=".xlsx"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) {
            toast('Reading robot file…');
            importRobotFile(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />
      <input
        type="file"
        ref={genFileInputRef}
        accept=".xlsx"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) {
            toast('Reading generator file…');
            importGeneratorFile(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />
      <input
        type="file"
        ref={libFileInputRef}
        accept=".csv,.tsv,.txt,.xlsx"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) {
            toast('Reading library file…');
            importLibraryFile(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />
      <input
        type="file"
        ref={backupFileInputRef}
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) {
            toast('Restoring backup…');
            restoreBackupFile(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />
      <input
        type="file"
        ref={archiveFileInputRef}
        accept=".robowski,.zip"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) {
            importRobowskiArchiveFile(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />

      <div className="bodyw" style={{ paddingLeft: 0, paddingRight: 0 }}>
        {/* Left Column: Runs list */}
        <div className="lcol" style={{ gap: '20px' }}>
          <div className="phead">
            <div>
              <div className="ptl">Runs</div>
              <div className="psub">
                Every run is saved with its deck, plates and tips (in this browser). Open one to
                edit it, or duplicate it as a starting point.
              </div>
            </div>
            <div className="pr">
              <div className="seg" role="group" aria-label="Filter runs">
                {(['all', 'draft', 'exported'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={runFilter === f ? 'on' : ''}
                    onClick={() => setRunFilter(f)}
                  >
                    {f === 'all' ? 'All' : f === 'draft' ? 'Drafts' : 'Exported'}
                  </button>
                ))}
              </div>

              <div className="searchwrap">
                <svg
                  className="searchicon"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="7" cy="7" r="5" />
                  <path d="M11 11l3 3" />
                </svg>
                <input
                  type="text"
                  className="f"
                  placeholder="Search runs…"
                  value={runSearch}
                  onChange={(e) => setRunSearch(e.target.value)}
                  style={{ width: '170px', height: '34px', paddingLeft: '30px' }}
                  aria-label="Search runs by reagent or name"
                />
              </div>

              <button
                type="button"
                className="btn"
                onClick={() => archiveFileInputRef.current?.click()}
                title="Open a self-contained .robowski experiment archive package"
              >
                📂 Open .robowski archive
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => robotFileInputRef.current?.click()}
              >
                Open robot .xlsx
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => genFileInputRef.current?.click()}
              >
                Import generator .xlsx
              </button>
              <button
                type="button"
                className="btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  color: '#0284c7',
                  borderColor: 'rgba(2, 132, 199, 0.4)',
                  background: 'rgba(2, 132, 199, 0.08)',
                  fontWeight: 600,
                }}
                onClick={() => {
                  const toUse = compareIds.length > 0
                    ? (compareIds.map((id) => runsList.find((r) => r.id === id)).filter(Boolean) as SavedRun[])
                    : (shown.slice(0, 3) || runsList.slice(0, 3));
                  if (toUse.length === 0) {
                    toast('No runs available to export slide.');
                    return;
                  }
                  setSelectedForSlide(toUse);
                  setShowSlideModal(true);
                }}
                title="Export high-resolution 16:9 presentation slide of selected or recent runs for weekly group meeting"
              >
                📊 Group Meeting Slide Export
              </button>
              <button type="button" className="btn pri" onClick={startNewRun}>
                New run
              </button>
            </div>
          </div>

          {/* Selection & Group Meeting Export banner */}
          {compareIds.length > 0 && (
            <div
              className="cmp-bar"
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px',
                padding: '10px 16px',
                marginBottom: '6px',
                background: 'var(--soft)',
                border: '1px solid var(--line)',
                borderRadius: '8px',
              }}
            >
              <b style={{ color: 'var(--fg)', fontSize: '13px' }}>
                {compareIds.length} run{compareIds.length === 1 ? '' : 's'} selected
              </b>

              <button
                type="button"
                className="btn sm pri"
                style={{
                  background: '#0284c7',
                  borderColor: '#0369a1',
                  color: '#fff',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontWeight: 600,
                }}
                onClick={() => {
                  const toUse = compareIds
                    .map((id) => runsList.find((r) => r.id === id))
                    .filter(Boolean) as SavedRun[];
                  setSelectedForSlide(toUse);
                  setShowSlideModal(true);
                }}
                title="Export 16:9 presentation slide for selected runs to paste directly into PowerPoint or Google Slides"
              >
                📊 Export Group Meeting Slide ({compareIds.length})
              </button>

              {compareIds.length === 2 && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setView('compare');
                    window.scrollTo(0, 0);
                  }}
                >
                  Compare them
                </button>
              )}

              <button
                type="button"
                className="btn sm"
                onClick={() => setCompareIds([])}
              >
                Clear Selection
              </button>
            </div>
          )}

          {/* Runs Grid or Empty State */}
          {shown.length ? (
            <div className="runs">
              {shown.map((r) => {
                const sel = compareIds.includes(r.id);
                return (
                  <div
                    key={r.id}
                    className="card runcard"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '14px',
                      padding: '16px',
                      borderColor: sel ? 'var(--acc)' : undefined,
                      boxShadow: sel ? '0 0 0 2px var(--acc)' : undefined,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '8px',
                        alignItems: 'flex-start',
                      }}
                    >
                      <b style={{ fontSize: '15px', minWidth: 0, overflowWrap: 'anywhere' }}>
                        {r.name}
                      </b>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span
                          className="chip"
                          style={{
                            fontSize: '11px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontWeight: 600,
                            background: r.tlc_status === 'ready' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                            color: r.tlc_status === 'ready' ? '#10b981' : '#d97706',
                            border: `1px solid ${r.tlc_status === 'ready' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                          }}
                          title={
                            r.tlc_status === 'ready'
                              ? 'TLC plate images and densitogram curves attached'
                              : 'TLC data is not uploaded yet. Reaction was planned/pipetted, but plate photos are pending.'
                          }
                        >
                          {r.tlc_status === 'ready' ? '✓ TLC Ready' : '⚠️ TLC Pending'}
                        </span>
                        <span className={`chip ${r.status === 'exported' ? 'ok' : 'mut'}`}>
                          {r.status || 'draft'}
                        </span>
                      </div>
                    </div>

                    <div className="hint" style={{ margin: 0 }}>
                      {r.mode} · {r.hood} hood · {new Date(r.updated || 0).toLocaleDateString()}
                    </div>

                    {r.exports && r.exports.length > 0 && (
                      <div className="hint" style={{ margin: 0, color: 'var(--acc)' }}>
                        Exported {r.exports.length} time{r.exports.length === 1 ? '' : 's'} · last{' '}
                        {new Date(r.exports[r.exports.length - 1].t).toLocaleDateString()}
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                      {r.summary && r.summary.length ? (
                        <>
                          {r.summary
                            .filter((x) => !x.text.includes('not used'))
                            .slice(0, 6)
                            .map((x, xi) => {
                              const i = (r.codes || []).indexOf(x.code);
                              return (
                                <div
                                  key={xi}
                                  style={{
                                    display: 'flex',
                                    gap: '8px',
                                    alignItems: 'baseline',
                                    minWidth: 0,
                                  }}
                                >
                                  <span
                                    className="rdot"
                                    style={{
                                      background: (r.colors || [])[i] || '#777',
                                      flex: 'none',
                                    }}
                                  >
                                    {x.code}
                                  </span>
                                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                                    {x.text}
                                  </span>
                                </div>
                              );
                            })}
                          {r.summary.length > 6 && (
                            <div className="hint" style={{ margin: 0 }}>
                              + {r.summary.length - 6} more
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {(r.codes || []).map((c, i) => (
                            <span
                              key={c + i}
                              className="rdot"
                              style={{ background: (r.colors || [])[i] || '#777' }}
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ fontSize: '13px' }}>
                      <b className="mono">{r.reactions}</b> combinations ·{' '}
                      <b className="mono">{r.plates}</b> plate{r.plates === 1 ? '' : 's'}
                      <br />
                      <span className="hint">
                        Tips 50/300/1000: <span className="mono">{r.tips}</span>
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        marginTop: 'auto',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ flex: 1 }}
                          onClick={() => openRun(r.id)}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ flex: 1 }}
                          onClick={() => dupRun(r.id)}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => delRun(r.id)}
                          aria-label="Delete run"
                        >
                          ✕
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ flex: 1 }}
                          onClick={() => {
                            setSelectedForSlide([r]);
                            setShowSlideModal(true);
                          }}
                          title="Export 16:9 presentation slide for this run to paste into PowerPoint or Google Slides"
                        >
                          📊 Slide
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ flex: 1 }}
                          onClick={() => {
                            try {
                              const calc = buildRun(dataFor(r.state));
                              openPreview('nb', {
                                run: calc,
                                dateStr: localDate(r.updated || Date.now()),
                                name: r.name,
                              });
                            } catch (e: any) {
                              toast('Could not draw notebook card: ' + e.message);
                            }
                          }}
                        >
                          Notebook
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          style={{
                            flex: 1,
                            background: sel ? 'rgba(2, 132, 199, 0.15)' : undefined,
                            borderColor: sel ? '#0284c7' : undefined,
                            color: sel ? '#0284c7' : undefined,
                            fontWeight: sel ? 600 : 400,
                          }}
                          onClick={() => {
                            setCompareIds((prev) => {
                              const idx = prev.indexOf(r.id);
                              if (idx >= 0) return prev.filter((x) => x !== r.id);
                              return [...prev, r.id];
                            });
                          }}
                          title={sel ? 'Unselect this run' : 'Select run for group meeting slide export or comparison'}
                        >
                          {sel ? '✓ Selected' : 'Select'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="card empty-state">
              <div className="empty-icon">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 48 48"
                  fill="none"
                  stroke="var(--mut)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.5"
                >
                  <rect x="8" y="6" width="32" height="36" rx="4" />
                  <path d="M14 18h20M14 26h20M14 34h12" />
                </svg>
              </div>
              <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '4px' }}>
                {runSearch
                  ? 'No runs match your search'
                  : runsList.length
                  ? 'No runs in this filter'
                  : 'No saved runs yet'}
              </div>
              <div className="hint" style={{ margin: '0 0 16px' }}>
                {runSearch
                  ? 'Try a different reagent name or code, or clear the search.'
                  : 'Set up reagents and ranges, then save your run from the Export step to see it here.'}
              </div>
              {!runSearch && (
                <button type="button" className="btn pri" onClick={startNewRun}>
                  Start a new run
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Backup and Reagent library */}
        <div className="rcol">
          {/* Backup Card */}
          <div className="card pad" style={{ marginBottom: '20px' }}>
            <div className="ct">Backup</div>
            <div className="psub" style={{ marginBottom: '8px' }}>
              One file with all runs and the reagent library. Keep a copy in your lab folder or
              drive; runs kept only in a browser can be lost.
            </div>
            {backupDays !== null && backupDays >= 14 && (
              <div className="issue warn" style={{ marginBottom: '10px' }}>
                <span>The last backup is {backupDays} days old.</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn sm pri"
                onClick={handleBackup}
                disabled={!runsList.length && !lib.length}
              >
                Back up everything
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => backupFileInputRef.current?.click()}
              >
                Restore from backup
              </button>
            </div>
            <div className="hint" style={{ marginTop: '8px' }}>
              {backupDays === null
                ? 'No backup made yet.'
                : backupDays === 0
                ? 'Last backup: today.'
                : `Last backup: ${backupDays} day${backupDays > 1 ? 's' : ''} ago.`}{' '}
              Restoring adds missing runs and keeps the newer copy of any run in both.
            </div>
          </div>

          {/* Reagent Library Card */}
          <div className="card pad">
            <div className="ct">Reagent library</div>
            <div className="psub" style={{ marginBottom: '8px' }}>
              Saved once. Type a name on the Setup screen and it fills molar mass and density.
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <button
                type="button"
                className="btn sm pri"
                onClick={() => libFileInputRef.current?.click()}
              >
                Import CSV / Excel
              </button>
              <button type="button" className="btn sm" onClick={handleLibTemplate}>
                Template
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={handleLibExport}
                disabled={!lib.length}
              >
                Export
              </button>
            </div>

            <div className="list" style={{ maxHeight: '340px', overflowY: 'auto' }}>
              {lib.length ? (
                lib.map((x) => (
                  <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--line, rgba(0,0,0,0.06))' }}>
                    <ChemicalStructure
                      smiles={x.smiles}
                      iupac={x.iupac || x.name}
                      name={x.name}
                      width={56}
                      height={40}
                      allowZoom={true}
                      onResolvedSmiles={(smiles, mw) => {
                        putLib({
                          ...x,
                          smiles,
                          molarMass: (!x.molarMass || +x.molarMass <= 0) && mw ? mw : x.molarMass,
                        });
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <b>{x.name}</b>
                        {x.smiles && (
                          <span
                            className="chip mut"
                            style={{ fontSize: '10px', height: '18px', padding: '0 6px', fontFamily: 'monospace' }}
                            title={x.smiles}
                          >
                            SMILES
                          </span>
                        )}
                        {x.iupac && (
                          <span
                            style={{ fontSize: '10px', color: 'var(--mut)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={x.iupac}
                          >
                            {x.iupac}
                          </span>
                        )}
                      </div>
                      <div className="hint mono" style={{ margin: 0, fontSize: '11px' }}>
                        {nf(x.molarMass, 3)} g/mol · {x.density ? x.density + ' g/mL' : 'solid'}
                        {x.solvent ? ` · ${x.solvent}` : ''}
                        {x.cas ? ` · CAS ${x.cas}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => delLib(x.id)}
                      aria-label={`Delete ${x.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-note">Empty.</div>
              )}
            </div>

            <h3 style={{ marginTop: '16px' }}>Add</h3>
            <div className="row">
              <div className="fld" style={{ gridColumn: 'span 2' }}>
                <label className="lbl">Name</label>
                <input
                  type="text"
                  className="f"
                  placeholder="e.g. Benzaldehyde"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="fld">
                <label className="lbl">g/mol</label>
                <input
                  type="number"
                  step="any"
                  className="f mono"
                  value={newMm}
                  onChange={(e) => setNewMm(e.target.value)}
                />
              </div>
              <div className="fld">
                <label className="lbl">g/mL (liquid)</label>
                <input
                  type="number"
                  step="any"
                  className="f mono"
                  value={newDens}
                  onChange={(e) => setNewDens(e.target.value)}
                />
              </div>
              <div className="fld" style={{ gridColumn: 'span 2' }}>
                <label className="lbl">SMILES (optional)</label>
                <input
                  type="text"
                  className="f mono"
                  placeholder="e.g. c1ccccc1C=O"
                  value={newSmiles}
                  onChange={(e) => setNewSmiles(e.target.value)}
                />
              </div>
              <div className="fld" style={{ gridColumn: 'span 2' }}>
                <label className="lbl">IUPAC name (optional)</label>
                <input
                  type="text"
                  className="f"
                  placeholder="e.g. benzaldehyde"
                  value={newIupac}
                  onChange={(e) => setNewIupac(e.target.value)}
                />
              </div>
            </div>
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: '10px' }}
              onClick={handleAddLib}
            >
              Add to library
            </button>
          </div>
        </div>
      </div>

      <GroupMeetingSlideModal
        isOpen={showSlideModal}
        onClose={() => setShowSlideModal(false)}
        selectedRuns={selectedForSlide}
        toast={toast}
      />
    </div>
  );
};
