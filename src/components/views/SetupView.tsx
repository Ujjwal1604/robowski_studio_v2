import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import {
  PAL,
  SUPPORTED_SOLVENTS,
  axisValues,
  round,
  EXPERIMENT_PRESETS,
  applyPresetToState,
  computeDilutionTier,
  readTableFile,
} from '../../engine';
import * as Tri from '../../engine';
import { exampleState } from '../../context/runPayload';
import { FixDiffModal } from '../ui/FixDiffModal';
import { StockCalculatorModal } from '../ui/StockCalculatorModal';
import { AiDiagnosticsModal } from '../ui/AiDiagnosticsModal';
import { ChemicalStructure, resolveChemicalNameToSmiles } from '../ui/ChemicalStructure';
import { getRDKitInstance, computeMolecularWeightFromSmiles } from '../../utils/rdkit';

export const SetupView: React.FC = () => {
  const {
    state,
    setState,
    setPath,
    run,
    err,
    missing,
    invalid,
    allEmpty,
    triPending,
    triMeta,
    triBlank,
    rowsCache,
    setOf,
    fixes,
    fixesDone,
    fixesBusy,
    whyNot,
    findFixes,
    applyFix,
    lib,
    putLib,
    addReagent,
    removeReagent,
    moveReagent,
    renameReagent,
    addSet,
    dupSet,
    removeSet,
    unimport,
    saveRun,
    setView,
    setVialFocus,
    setVisited,
    inlineRanges,
    toast,
    importRobotFile,
  } = useApp();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [showStructures, setShowStructures] = useState(true);
  const [reagentViewMode, setReagentViewMode] = useState<'cards' | 'table'>('cards');
  const [resolvingStructures, setResolvingStructures] = useState(false);
  const [inspectFixIndex, setInspectFixIndex] = useState<number | null>(null);
  const [calcReagentIndex, setCalcReagentIndex] = useState<number | null>(null);
  const [aiDiagnosticsOpen, setAiDiagnosticsOpen] = useState(false);
  const libFileInputRef = React.useRef<HTMLInputElement>(null);
  const excelRunInputRef = React.useRef<HTMLInputElement>(null);

  const handleResolveAllStructures = async () => {
    const candidates = state.reagents
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => Boolean((r.name || r.iupac || '').trim()));

    if (!candidates.length) {
      toast('Add reagent chemical names first to resolve structures and properties.');
      return;
    }

    setResolvingStructures(true);
    toast(`Looking up chemical data for ${candidates.length} reagent(s)...`);
    let resolvedCount = 0;
    try {
      const rdkit = await getRDKitInstance();
      for (const { r, i } of candidates) {
        const q = (r.name || r.iupac || '').trim();
        const res = await resolveChemicalNameToSmiles(q);
        if (res?.smiles) {
          setState((prev) => {
            const next = JSON.parse(JSON.stringify(prev));
            const reg = next.reagents[i];
            reg.smiles = res.smiles;
            if (res.iupac) reg.iupac = res.iupac;
            if (res.mw) reg.molarMass = res.mw;
            if (res.density !== undefined) {
              reg.density = res.density;
            } else if (!reg.density) {
              reg.density = 0; // solid
            }
            return next;
          });
          resolvedCount++;
        } else if (/^[CNOPSFIBrclH0-9=\-#+()\[\]\\/@:]+$/.test(q) && q.length > 2) {
          // If the name itself is a SMILES string
          if (rdkit) {
            const mw = computeMolecularWeightFromSmiles(rdkit, q);
            setState((prev) => {
              const next = JSON.parse(JSON.stringify(prev));
              const reg = next.reagents[i];
              reg.smiles = q;
              if (mw) reg.molarMass = mw;
              return next;
            });
            resolvedCount++;
          }
        }
      }
      toast(
        resolvedCount > 0
          ? `Auto-resolved ${resolvedCount} reagent(s) with 2D structures, molar mass & density!`
          : `Could not find chemical data for these names on PubChem.`
      );
    } catch {
      toast(`Resolved ${resolvedCount} structure(s).`);
    } finally {
      setResolvingStructures(false);
    }
  };

  const handleImportLibraryFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const sheets = await readTableFile(file);
      if (!sheets.length || !sheets[0].rows.length) {
        toast('The file is empty or has no readable sheets.');
        return;
      }
      const rows = sheets[0].rows.filter((r) => r.some((c) => String(c).trim() !== ''));
      if (rows.length < 2) {
        toast('The table needs a header row and at least one reagent row.');
        return;
      }
      const headers = rows[0].map((h: any) => String(h || '').trim().toLowerCase());
      const findCol = (...names: string[]) =>
        headers.findIndex((h: string) => names.some((n) => h === n || h.includes(n)));

      const nameCol = findCol('name', 'reagent', 'compound', 'chemical');
      const mwCol = findCol('molar_mass', 'mw', 'molecular_weight', 'mol_weight', 'molweight', 'mass');
      const densCol = findCol('density', 'd');
      const solvCol = findCol('solvent');
      const stockCol = findCol('stock', 'conc');
      const casCol = findCol('cas');
      const smilesCol = findCol('smiles', 'structure', 'canonical_smiles', 'canonical smiles', 'isomeric_smiles');
      const iupacCol = findCol('iupac', 'iupac_name', 'systematic_name', 'chemical_name');
      const noteCol = findCol('note', 'notes');

      if (nameCol < 0) {
        toast('Could not find a "name" or "reagent" column in the table.');
        return;
      }

      let added = 0;
      let updated = 0;
      const importedMap = new Map<string, { smiles?: string; iupac?: string; molarMass?: number }>();

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = String(r[nameCol] || '').trim();
        if (!name) continue;

        const mwVal = mwCol >= 0 ? parseFloat(String(r[mwCol])) : NaN;
        const molarMass = Number.isFinite(mwVal) && mwVal > 0 ? mwVal : 0;
        const densVal = densCol >= 0 ? parseFloat(String(r[densCol])) : NaN;
        const density = Number.isFinite(densVal) && densVal > 0 ? densVal : undefined;
        const solvent = solvCol >= 0 && r[solvCol] ? String(r[solvCol]).trim() : undefined;
        const stockVal = stockCol >= 0 ? parseFloat(String(r[stockCol])) : NaN;
        const stock = Number.isFinite(stockVal) && stockVal > 0 ? stockVal : undefined;
        const cas = casCol >= 0 && r[casCol] ? String(r[casCol]).trim() : undefined;
        const smiles = smilesCol >= 0 && r[smilesCol] ? String(r[smilesCol]).trim() : undefined;
        const iupac = iupacCol >= 0 && r[iupacCol] ? String(r[iupacCol]).trim() : undefined;
        const note = noteCol >= 0 && r[noteCol] ? String(r[noteCol]).trim() : undefined;

        importedMap.set(name.toLowerCase(), { smiles, iupac, molarMass });

        const existing = lib.find((x) => x.name.toLowerCase() === name.toLowerCase());
        const id = existing ? existing.id : Math.random().toString(36).slice(2, 10);
        if (existing) updated++;
        else added++;

        await putLib({
          id,
          name,
          molarMass,
          density,
          solvent,
          stock,
          cas,
          smiles,
          iupac,
          note,
        });
      }

      // If active reagents match imported reagents by name, immediately populate their SMILES & structures!
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        let changed = false;
        next.reagents.forEach((rg: any) => {
          const match = importedMap.get(rg.name?.trim().toLowerCase());
          if (match) {
            if (match.smiles && !rg.smiles) {
              rg.smiles = match.smiles;
              changed = true;
            }
            if (match.iupac && !rg.iupac) {
              rg.iupac = match.iupac;
              changed = true;
            }
            if (match.molarMass && (!rg.molarMass || +rg.molarMass <= 0)) {
              rg.molarMass = match.molarMass;
              changed = true;
            }
          }
        });
        return changed ? next : prev;
      });

      toast(`Library import: ${added} added, ${updated} updated from ${file.name}.`);
    } catch (err: any) {
      toast(`Could not import library: ${err?.message || err}`);
    }
    e.target.value = '';
  };

  const handleLoadPreset = (presetId: string) => {
    if (presetId === 'blank') {
      setState((prev) => {
        const b = exampleState();
        return { ...b, hood: prev.hood };
      });
      toast('Loaded blank template (3 reagents).');
    } else {
      setState((prev) => applyPresetToState(presetId, prev));
      const p = EXPERIMENT_PRESETS.find((x) => x.id === presetId);
      toast(`Loaded preset: ${p?.name || presetId} (${p?.reactions} vials).`);
    }
    setPresetsOpen(false);
  };

  const blank = missing.length > 0;
  const pre = [500, 800];

  // Number formatting
  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const rcol = (i: number) => PAL[i % PAL.length];

  const handleNameSelect = async (i: number, nameVal: string) => {
    const trimmed = nameVal.trim();
    if (!trimmed) {
      setPath(`reagents.${i}.name`, '');
      return;
    }

    const item = lib.find((l) => l.name.trim().toLowerCase() === trimmed.toLowerCase());
    if (item) {
      setState((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        const r = next.reagents[i];
        r.name = item.name;
        r.molarMass = item.molarMass || '';
        r.density = item.density || 0;
        r.smiles = item.smiles || '';
        r.iupac = item.iupac || '';
        if (item.solvent && SUPPORTED_SOLVENTS.includes(item.solvent)) {
          r.solvent = item.solvent;
        }
        if (item.stock && item.stock > 0 && (r.stock === '' || r.stock == null)) {
          r.stock = item.stock;
        }
        return next;
      });
      toast(
        `Filled ${item.name} from the library: ${nf(item.molarMass, 3)} g/mol, ${
          item.density ? item.density + ' g/mL' : 'solid'
        }.`
      );
    } else {
      const prevReagent = state.reagents[i];
      const isNameChanged = (prevReagent?.name || '').trim().toLowerCase() !== trimmed.toLowerCase();

      // If user changed the name to something new, clear the old structure & properties immediately
      if (isNameChanged) {
        setState((prev) => {
          const next = JSON.parse(JSON.stringify(prev));
          const r = next.reagents[i];
          r.name = trimmed;
          r.smiles = '';
          r.iupac = '';
          return next;
        });
      } else {
        setPath(`reagents.${i}.name`, trimmed);
      }

      // Automatically query PubChem/NCI/RDKit to fetch SMILES, Molar Mass, and Density!
      toast(`Looking up chemical properties for "${trimmed}"...`);
      try {
        const res = await resolveChemicalNameToSmiles(trimmed);
        if (res?.smiles) {
          setState((prev) => {
            const next = JSON.parse(JSON.stringify(prev));
            const r = next.reagents[i];
            // Ensure the user hasn't edited the name again in the meantime
            if (r.name.trim().toLowerCase() === trimmed.toLowerCase()) {
              r.smiles = res.smiles;
              if (res.iupac) r.iupac = res.iupac;
              if (res.mw) r.molarMass = res.mw;
              if (res.density !== undefined) {
                r.density = res.density;
              } else {
                r.density = 0; // Solid
              }
            }
            return next;
          });
          toast(
            `Resolved "${trimmed}": ${res.mw ? nf(res.mw, 2) + ' g/mol' : ''}${
              res.density ? ' · ' + res.density + ' g/mL' : ' · solid'
            }`
          );
        } else {
          // Check if user entered a raw SMILES string into the name box
          if (/^[CNOPSFIBrclH0-9=\-#+()\[\]\\/@:]+$/.test(trimmed) && trimmed.length > 2) {
            setPath(`reagents.${i}.smiles`, trimmed);
            const rdkit = await getRDKitInstance();
            if (rdkit) {
              const mw = computeMolecularWeightFromSmiles(rdkit, trimmed);
              if (mw) {
                setPath(`reagents.${i}.molarMass`, mw);
                toast(`Calculated molecular weight from SMILES: ${nf(mw, 2)} g/mol`);
              }
            }
          }
        }
      } catch (err) {
        console.warn('Auto lookup failed:', err);
      }
    }
  };

  const dotsFor = (i: number) => {
    const r = state.reagents[i];
    if (!run) return null;
    const used = Object.keys(run.stocks).some(
      (k) => run.stocks[k].source_reagent === r.code && run.stocks[k].dilution_level > 0
    );
    if (!used) return null;
    let minT = 1e18,
      maxT = 0;
    rowsCache.forEach((row) => {
      const v = row[i];
      if (v > 0) {
        minT = Math.min(minT, v);
        maxT = Math.max(maxT, v);
      }
    });
    if (minT === 1e18) return null;
    const thr = Math.max(+state.threshold || 50, 1e-9);
    const ideal = (minT * +state.vialVolume) / thr;
    const mv = (maxT * +state.vialVolume) / ideal;
    return (
      <div className="hint">
        Needs hand dilutions at {nf(r.stock, 1)} mM. A stock of ≤{' '}
        <b className="mono">{nf(ideal, 1)} mM</b> would pipette the smallest amount directly, but
        then the largest is about <b className="mono">{nf(mv, 0)} µL</b>
        {mv >= 1000 ? ' (too big for one dispense)' : ''}.
      </div>
    );
  };

  const checks = () => {
    if (!run) return [];
    const out: Array<{
      code: string;
      i: number;
      min: number;
      max: number;
      okMin: boolean;
      okMax: boolean;
      neg?: number;
    }> = [];
    state.reagents.forEach((r, i) => {
      let min = 1e9,
        max = 0;
      const keys = Object.keys(run.stocks).filter((k) => run.stocks[k].source_reagent === r.code);
      run.rows.forEach((row: any) =>
        keys.forEach((k) => {
          const v = +row['vol#' + k] || 0;
          if (v > 0) {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        })
      );
      out.push({
        code: r.code,
        i,
        min: min === 1e9 ? 0 : min,
        max,
        okMin: min >= +state.threshold - 1e-9 || min === 1e9,
        okMax: max < 1000,
      });
    });
    let smin = 1e9,
      neg = 0;
    run.rows.forEach((row) => {
      const v = +row['vol#solvent'];
      if (v < 0) neg++;
      if (v > 0) smin = Math.min(smin, v);
    });
    out.push({
      code: 'solvent',
      i: -1,
      min: smin === 1e9 ? 0 : smin,
      max: 0,
      okMin: smin >= +state.threshold - 1e-9 || smin === 1e9,
      okMax: true,
      neg,
    });
    return out;
  };

  const cs = checks();
  const minOk = cs.length ? cs.every((c) => c.okMin) : false;
  const maxOk = cs.length ? cs.every((c) => c.okMax) : false;
  const negCount = (cs.find((c) => c.code === 'solvent') || {}).neg || 0;

  const ISSUE_NAMES: Record<string, string> = {
    'negative-solvent': 'Negative solvent',
    subminimum: 'Below 0.5 µL',
    'low-solvent': 'Solvent below threshold',
    'large-transfer': 'Transfer over 1000 µL',
    'n3-needed': 'Needs N³ dilution',
    'underprepared-stock': 'Stock under-prepared',
    'oversize-stock': 'Stock larger than a 20 mL bottle',
    'deck-capacity': 'Deck full',
    'requires-reload': 'More than 3 plates',
  };

  return (
    <div className="bodyw">
      <div className="lcol">
        {/* Run Parameters Card */}
        <div className="card pad">
          <div className="chead" style={{ flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="ct">Run parameters</div>
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
                  onClick={() => setPresetsOpen((v) => !v)}
                  aria-expanded={presetsOpen}
                  aria-haspopup="true"
                  title="Load a pre-configured reaction screen"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="12" height="10" rx="2" />
                    <line x1="2" y1="7" x2="14" y2="7" />
                  </svg>
                  <span>Templates ▾</span>
                </button>
                {presetsOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                      onClick={() => setPresetsOpen(false)}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 4px)',
                        left: 0,
                        zIndex: 50,
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        borderRadius: '10px',
                        boxShadow: 'var(--shadow-md)',
                        minWidth: '290px',
                        padding: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                      }}
                      role="menu"
                    >
                      <div style={{ padding: '6px 8px 4px', fontSize: '11px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        HTE Reaction Templates
                      </div>
                      {EXPERIMENT_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitem"
                          onClick={() => handleLoadPreset(p.id)}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            textAlign: 'left',
                            padding: '8px 10px',
                            border: 0,
                            background: 'transparent',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'background 0.15s ease',
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.background = 'var(--soft)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = 'transparent';
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--fg)' }}>
                            {p.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                            {p.description}
                          </div>
                        </button>
                      ))}
                      <div style={{ height: '1px', background: 'var(--line)', margin: '4px 0' }} />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleLoadPreset('blank')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '7px 10px',
                          border: 0,
                          background: 'transparent',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          color: 'var(--fg2)',
                          width: '100%',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.background = 'var(--soft)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background = 'transparent';
                        }}
                      >
                        <span>↺</span> Blank 3-Reagent Template
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="seg" role="group" aria-label="Generator mode">
              <button
                type="button"
                className={state.mode === 'concentration' ? 'on' : ''}
                onClick={() => setPath('mode', 'concentration')}
              >
                Concentration
              </button>
              <button
                type="button"
                className={state.mode === 'equivalence' ? 'on' : ''}
                onClick={() => setPath('mode', 'equivalence')}
              >
                Equivalence
              </button>
              <button
                type="button"
                className={state.mode === 'triplet' ? 'on' : ''}
                onClick={() => {
                  if (state.imported && state.mode !== 'triplet') {
                    unimport();
                    toast('Cleared imported concentration run for Triplet mode.');
                  }
                  if (state.reagents.every((r) => !r.name && (r.stock === '' || r.stock == null))) {
                    setState((prev) => {
                      const next = JSON.parse(JSON.stringify(prev));
                      next.reagents = Tri.triReagents();
                      delete next.sets;
                      Tri.triSync(next);
                      return next;
                    });
                  }
                  setPath('mode', 'triplet');
                }}
              >
                Triplet plate
              </button>
            </div>
          </div>

          <div className="pgrid">
            <div className="fld" style={{ gridColumn: 'span 2' }}>
              <label className="lbl" htmlFor="runname">
                Run name
              </label>
              <input
                type="text"
                className="f"
                id="runname"
                value={state.name}
                onChange={(e) => setPath('name', e.target.value)}
              />
            </div>

            <div className="fld">
              <label className="lbl">Total vol. per vial (µL)</label>
              <div className="seg full" role="group" aria-label="Vial volume presets">
                {pre.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={+state.vialVolume === p ? 'on' : ''}
                    onClick={() => setPath('vialVolume', p)}
                  >
                    {p}
                  </button>
                ))}
                <button
                  type="button"
                  className={pre.includes(+state.vialVolume) ? '' : 'on'}
                  onClick={() => {
                    if (pre.includes(+state.vialVolume)) {
                      setPath('vialVolume', +state.vialVolume + 100);
                    }
                  }}
                >
                  Custom
                </button>
              </div>
              {!pre.includes(+state.vialVolume) && (
                <input
                  type="number"
                  className={`f mono ${invalid.has('vialVolume') ? 'inv' : ''}`}
                  value={state.vialVolume}
                  onChange={(e) => setPath('vialVolume', e.target.value)}
                  style={{ marginTop: '6px' }}
                />
              )}
            </div>

            <div className="fld">
              <label className="lbl">Pipetting threshold (µL)</label>
              <input
                type="number"
                className={`f mono ${invalid.has('threshold') ? 'inv' : ''}`}
                value={state.threshold}
                onChange={(e) => setPath('threshold', e.target.value)}
              />
            </div>

            <div className="fld">
              <label className="lbl">Dilution factor (N)</label>
              <input
                type="number"
                className={`f mono ${invalid.has('dilutionFactor') ? 'inv' : ''}`}
                value={state.dilutionFactor}
                onChange={(e) => setPath('dilutionFactor', e.target.value)}
              />
            </div>

            <div className="fld">
              <label className="lbl">Solvent</label>
              <select
                className="f"
                value={state.reactionSolvent}
                onChange={(e) => setPath('reactionSolvent', e.target.value)}
              >
                {SUPPORTED_SOLVENTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="fld">
              <label className="lbl">Leftover per stock (mL)</label>
              <input
                type="number"
                step="any"
                className={`f mono ${invalid.has('leftoverMl') ? 'inv' : ''}`}
                value={state.leftoverMl}
                onChange={(e) => setPath('leftoverMl', e.target.value)}
              />
            </div>

            <div className="fld">
              <label className="lbl">Volumetric flasks (mL)</label>
              <input
                type="text"
                className={`f mono ${invalid.has('flasksText') ? 'inv' : ''}`}
                value={state.flasksText}
                onChange={(e) => setPath('flasksText', e.target.value)}
                placeholder="2, 5, 10, 20"
              />
              <div className="hint" style={{ margin: '4px 0 0' }}>
                Stocks are rounded up to the smallest flask that fits.
              </div>
            </div>

            <div className="fld">
              <label className="lbl">Solvent is added</label>
              <select
                className="f"
                value={state.solventAfter}
                onChange={(e) => setPath('solventAfter', +e.target.value)}
              >
                {state.reagents.map((r, i) => (
                  <option key={r.code + i} value={i}>
                    {i === 0 ? 'first' : 'after ' + (state.reagents[i - 1]?.code || '')}
                  </option>
                ))}
                <option value={state.reagents.length}>last</option>
              </select>
            </div>

            {state.mode !== 'triplet' && (
              <>
                <div className="fld">
                  <label className="lbl">Shuffle vial order</label>
                  <select
                    className="f"
                    value={String(state.randomize)}
                    onChange={(e) => setPath('randomize', e.target.value === 'true')}
                  >
                    <option value="true">On (random)</option>
                    <option value="false">Off (generator order)</option>
                  </select>
                </div>
                {state.randomize && (
                  <div className="fld">
                    <label className="lbl">Shuffle seed</label>
                    <input
                      type="number"
                      className="f mono"
                      value={state.randomSeed}
                      onChange={(e) => setPath('randomSeed', e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <div className="note">
            {state.mode === 'triplet'
              ? 'Triplet plate mode: reagents are mixed in fixed ratios of a base concentration, in sections of the plate (set up below).'
              : state.mode === 'equivalence'
              ? 'Equivalence mode: the first reagent is a concentration in mM; every other reagent is set as equivalents of it.'
              : 'Concentration mode: every reagent has its own range in mM.'}
          </div>
        </div>

        {/* Reagents Table / Studio Card */}
        <div className="card pad" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: reagentViewMode === 'table' ? '860px' : 'auto' }}>
            <div className="chead" style={{ flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
              <div className="ct">
                Reagents{' '}
                <span className="cnt">{state.reagents.length} of 12 · in order of addition</span>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto' }}>
                {/* View Mode Segmented Switcher */}
                <div style={{ display: 'inline-flex', background: 'var(--soft)', borderRadius: '8px', padding: '2px', border: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    className={`btn sm ${reagentViewMode === 'cards' ? 'pri' : ''}`}
                    style={{
                      height: '28px',
                      padding: '0 10px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      boxShadow: reagentViewMode === 'cards' ? 'var(--shadow-sm)' : 'none',
                    }}
                    onClick={() => setReagentViewMode('cards')}
                    title="Modern spacious reagent studio cards"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ marginRight: '5px' }}>
                      <rect x="2" y="2" width="5" height="5" rx="1" />
                      <rect x="9" y="2" width="5" height="5" rx="1" />
                      <rect x="2" y="9" width="5" height="5" rx="1" />
                      <rect x="9" y="9" width="5" height="5" rx="1" />
                    </svg>
                    Cards
                  </button>
                  <button
                    type="button"
                    className={`btn sm ${reagentViewMode === 'table' ? 'pri' : ''}`}
                    style={{
                      height: '28px',
                      padding: '0 10px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '12px',
                      boxShadow: reagentViewMode === 'table' ? 'var(--shadow-sm)' : 'none',
                    }}
                    onClick={() => setReagentViewMode('table')}
                    title="Compact spreadsheet table view"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ marginRight: '5px' }}>
                      <line x1="2" y1="4" x2="14" y2="4" />
                      <line x1="2" y1="8" x2="14" y2="8" />
                      <line x1="2" y1="12" x2="14" y2="12" />
                    </svg>
                    Table
                  </button>
                </div>

                <div style={{ width: '1px', height: '18px', background: 'var(--line)', margin: '0 2px' }} />

                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    libFileInputRef.current?.click();
                  }}
                  title="Fill the library from a CSV or Excel file"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ marginRight: '4px' }}>
                    <path d="M8 12V3M4 7l4-4 4 4M2 13h12" />
                  </svg>
                  Import library
                </button>
                <input
                  ref={libFileInputRef}
                  id="libfileinput"
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xlsm"
                  style={{ display: 'none' }}
                  onChange={handleImportLibraryFile}
                />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    excelRunInputRef.current?.click();
                  }}
                  title="Import a previous run or robot workbook from Excel (.xlsx)"
                >
                  Import Excel run
                </button>
                <input
                  ref={excelRunInputRef}
                  id="excelrunfileinput"
                  type="file"
                  accept=".xlsx,.xlsm"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) importRobotFile(file);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className={`btn sm ${showStructures ? 'pri' : ''}`}
                  onClick={() => setShowStructures((v) => !v)}
                  title="Toggle 2D chemical structure thumbnails"
                >
                  {showStructures ? 'Hide structures' : '2D structures'}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={handleResolveAllStructures}
                  disabled={resolvingStructures}
                  title="Auto-resolve SMILES and 2D structures from IUPAC or chemical names via PubChem"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ marginRight: '4px' }}>
                    <circle cx="8" cy="8" r="3" />
                    <circle cx="2" cy="5" r="1.5" />
                    <circle cx="14" cy="5" r="1.5" />
                    <circle cx="8" cy="14" r="1.5" />
                    <line x1="3.5" y1="5.5" x2="5.5" y2="7" />
                    <line x1="12.5" y1="5.5" x2="10.5" y2="7" />
                    <line x1="8" y1="11" x2="8" y2="12.5" />
                  </svg>
                  {resolvingStructures ? 'Resolving...' : 'Auto-resolve'}
                </button>
                {state.reagents.length < 12 && (
                  <button type="button" className="btn sm pri" onClick={addReagent}>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M7 2v10M2 7h10" />
                    </svg>
                    &nbsp;Add reagent
                  </button>
                )}
              </div>
            </div>

            <datalist id="libnames">
              {lib.map((x) => (
                <option key={x.id} value={x.name}>
                  {nf(x.molarMass, 3)} g/mol
                  {x.density ? ' · ' + x.density + ' g/mL' : ' · solid'}
                  {x.solvent ? ' · ' + x.solvent : ''}
                </option>
              ))}
            </datalist>

            {reagentViewMode === 'table' && (
              <div className={`rw th ${showStructures ? 'has-struct' : ''}`}>
                <div>Code</div>
                {showStructures && <div>Structure</div>}
                <div>Name &amp; formula</div>
                <div>Molar mass</div>
                <div>Density</div>
                <div>Stock (mM)</div>
                <div>Stock solvent</div>
                <div>Order · save</div>
              </div>
            )}

            {(() => {
              const reagent0Range = (() => {
                if (state.mode !== 'equivalence') return undefined;
                const it0 = state.sets?.[0]?.items[0];
                if (!it0) return undefined;
                return { min: +it0.min || 0, max: +it0.max || 0 };
              })();

              return state.reagents.map((r, i) => {
                const c = rcol(i);
                const it = inlineRanges && state.sets?.[0]?.items[i];
                const unit = state.mode === 'equivalence' && i > 0 ? 'equiv.' : 'mM';

                const dilutionTier = computeDilutionTier(
                  r,
                  it,
                  +state.vialVolume,
                  +state.threshold,
                  +state.dilutionFactor,
                  state.mode,
                  reagent0Range,
                  i
                );

                let axValues: number[] | null = null;
                let axError: string | null = null;
                if (inlineRanges && it) {
                  if ([it.min, it.step, it.max].every((v) => v !== '' && v != null)) {
                    try {
                      axValues = axisValues(it.min, it.step, it.max, r.code);
                    } catch (e: any) {
                      axError = `Error: ${e.message.replace(/^[^:]*: /, '')}`;
                    }
                  }
                }

                if (reagentViewMode === 'cards') {
                  return (
                    <div
                      key={r.code + i}
                      className="reagent-studio-card"
                      style={{
                        borderLeftColor: c,
                        borderLeftWidth: '4px',
                      }}
                    >
                      {/* Card Header: Reagent Code Badge, Name, SMILES preview, and Actions */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: '12px',
                          marginBottom: '14px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '260px' }}>
                          <input
                            type="text"
                            className="code code-in"
                            style={{
                              background: c,
                              width: '42px',
                              height: '42px',
                              borderRadius: '10px',
                              fontSize: r.code.length <= 4 ? 15 : r.code.length <= 6 ? 12 : 10,
                              fontWeight: 700,
                              color: '#fff',
                              flexShrink: 0,
                              boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
                            }}
                            defaultValue={r.code}
                            onBlur={(e) => renameReagent(i, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                renameReagent(i, (e.target as HTMLInputElement).value);
                              }
                            }}
                            maxLength={24}
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={`Reagent ${i + 1} code`}
                            title="Click to rename reagent code"
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input
                                type="text"
                                className="f"
                                list="libnames"
                                value={r.name}
                                onChange={(e) => setPath(`reagents.${i}.name`, e.target.value)}
                                onBlur={(e) => handleNameSelect(i, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleNameSelect(i, (e.target as HTMLInputElement).value);
                                  }
                                }}
                                placeholder="Reagent chemical name (e.g. p-toluic acid, Pd(OAc)2)"
                                aria-label={`${r.code} name`}
                                style={{
                                  fontSize: '15px',
                                  fontWeight: 600,
                                  height: '36px',
                                  flex: 1,
                                }}
                              />
                              {r.name && (
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{ height: '36px', padding: '0 10px', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  onClick={() => handleNameSelect(i, r.name)}
                                  title="Look up SMILES, 2D structure, molar mass, and density for this name via PubChem"
                                >
                                  Fetch info
                                </button>
                              )}
                            </div>
                            {r.smiles ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--mut)', flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 600, color: 'var(--fg)', letterSpacing: '0.02em' }}>SMILES:</span>
                                <span
                                  className="mono"
                                  style={{
                                    background: 'var(--soft)',
                                    padding: '2px 8px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--line)',
                                    maxWidth: '360px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={r.smiles}
                                >
                                  {r.smiles}
                                </span>
                                <button
                                  type="button"
                                  className="btn sm"
                                  style={{ height: '22px', padding: '0 6px', fontSize: '10px' }}
                                  onClick={() => {
                                    navigator.clipboard?.writeText(r.smiles || '');
                                    toast(`Copied ${r.code} SMILES to clipboard`);
                                  }}
                                  title="Copy SMILES string"
                                >
                                  Copy
                                </button>
                              </div>
                            ) : (
                              <div style={{ fontSize: '11px', color: 'var(--mut)', fontStyle: 'italic' }}>
                                {r.name ? 'Press Enter or click "Fetch info" to auto-fetch structure & properties' : 'Type a name or IUPAC to auto-resolve structure, molar mass, and density'}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="racts">
                          <button
                            type="button"
                            className="ib"
                            onClick={() => moveReagent(i, -1)}
                            disabled={i === 0}
                            title="Add earlier"
                            aria-label={`Move ${r.code} earlier`}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M8 12V4M4 8l4-4 4 4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="ib"
                            onClick={() => moveReagent(i, 1)}
                            disabled={i === state.reagents.length - 1}
                            title="Add later"
                            aria-label={`Move ${r.code} later`}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M8 4v8m-4-4 4 4 4-4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="ib"
                            onClick={async () => {
                              if (!r.name) {
                                toast('Give the reagent a name first.');
                                return;
                              }
                              await putLib({
                                id: Math.random().toString(36).slice(2, 10),
                                name: r.name,
                                molarMass: +r.molarMass || 0,
                                density: +r.density || 0,
                                smiles: r.smiles || undefined,
                                solvent: r.solvent || undefined,
                              });
                              toast(r.name + ' saved to library.');
                            }}
                            title="Save to library"
                            aria-label={`Save ${r.code} to library`}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <polygon points="8 2 10.3 6.6 15.3 7.3 11.6 10.9 12.5 15.8 8 13.4 3.5 15.8 4.4 10.9 0.7 7.3 5.7 6.6 8 2" />
                            </svg>
                          </button>
                          {state.reagents.length > 2 && (
                            <button
                              type="button"
                              className="ib"
                              style={{ color: 'var(--err, #ef4444)' }}
                              onClick={() => removeReagent(i)}
                              title="Remove reagent"
                              aria-label={`Remove ${r.code}`}
                            >
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="4" y1="4" x2="12" y2="12" />
                                <line x1="12" y1="4" x2="4" y2="12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Card Content Grid: Structure, Physical & Stock, Screening Range (if active) */}
                      {(() => {
                        const hasInlineRange = Boolean(inlineRanges && it);
                        const triRole = (() => {
                          if (state.mode !== 'triplet') return null;
                          const ai = (state.tri?.adds || []).findIndex((a) => a.code === r.code);
                          const gs = (state.tri?.groups || [])
                            .filter((g) => g.members.includes(r.code))
                            .map((g) => g.name);
                          if (ai >= 0) return { type: 'additive' as const, label: `Additive · ${nf(state.tri?.adds[ai].equiv, 3)} eq` };
                          if (gs.length) return { type: 'group' as const, label: `In ${gs.join(', ')}` };
                          return { type: 'unused' as const, label: 'Not assigned yet · configure in Triplet Pattern below' };
                        })();

                        return (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: showStructures
                                ? hasInlineRange
                                  ? '190px minmax(300px, 1.1fr) minmax(310px, 1.2fr)'
                                  : '220px 1fr'
                                : hasInlineRange
                                ? 'minmax(300px, 1fr) minmax(310px, 1.2fr)'
                                : '1fr',
                              gap: '16px',
                              alignItems: 'stretch',
                            }}
                          >
                            {/* Col 1: Chemical Structure Canvas (enlarged for high visual clarity) */}
                            {showStructures && (
                              <div
                                style={{
                                  background: 'var(--soft)',
                                  borderRadius: '8px',
                                  border: '1px solid var(--line)',
                                  padding: '10px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  minHeight: hasInlineRange ? '138px' : '148px',
                                  transition: 'border-color 0.15s ease, background 0.15s ease',
                                }}
                                title="Click to zoom, inspect, or edit 2D chemical structure"
                              >
                                <ChemicalStructure
                                  smiles={r.smiles}
                                  iupac={r.iupac || r.name}
                                  name={r.name}
                                  width={hasInlineRange ? 170 : 200}
                                  height={hasInlineRange ? 116 : 130}
                                  allowZoom={true}
                                  onResolvedSmiles={(smiles, mw, density, iupac) => {
                                    setState((prev) => {
                                      const next = JSON.parse(JSON.stringify(prev));
                                      const reg = next.reagents[i];
                                      reg.smiles = smiles;
                                      if (mw) reg.molarMass = mw;
                                      if (density !== undefined) reg.density = density;
                                      if (iupac) reg.iupac = iupac;
                                      return next;
                                    });
                                  }}
                                />
                                <span style={{ fontSize: '9px', color: 'var(--mut)', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  Inspect / Edit
                                </span>
                              </div>
                            )}

                            {/* Col 2: Physical & Stock Solution */}
                            <div
                              style={{
                                background: 'var(--soft)',
                                borderRadius: '8px',
                                border: '1px solid var(--line)',
                                padding: '12px 16px',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'space-between',
                              }}
                            >
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: hasInlineRange
                                    ? 'repeat(2, minmax(0, 1fr))'
                                    : 'repeat(auto-fit, minmax(170px, 1fr))',
                                  gap: '12px 16px',
                                }}
                              >
                                {/* Molar Mass */}
                                <div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>Molar Mass</label>
                                    <span style={{ fontSize: '10px', color: 'var(--mut)' }}>g/mol</span>
                                  </div>
                                  <input
                                    type="number"
                                    step="any"
                                    className="f mono"
                                    value={r.molarMass}
                                    onChange={(e) => setPath(`reagents.${i}.molarMass`, e.target.value)}
                                    aria-label={`${r.code} molar mass`}
                                    style={{ width: '100%', height: '34px' }}
                                    placeholder="e.g. 136.15"
                                  />
                                </div>

                                {/* Density */}
                                <div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>Density</label>
                                    <span style={{ fontSize: '10px', color: 'var(--mut)' }}>g/mL</span>
                                  </div>
                                  <input
                                    type="number"
                                    step="any"
                                    className="f mono"
                                    value={r.density || ''}
                                    onChange={(e) => setPath(`reagents.${i}.density`, e.target.value)}
                                    placeholder="solid"
                                    aria-label={`${r.code} density`}
                                    style={{ width: '100%', height: '34px' }}
                                  />
                                </div>

                                {/* Stock Conc */}
                                <div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>Stock Conc.</label>
                                    <span style={{ fontSize: '10px', color: 'var(--mut)' }}>mM</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <input
                                      type="number"
                                      step="any"
                                      className={`f mono ${invalid.has(`reagents.${i}.stock`) ? 'inv' : ''}`}
                                      value={r.stock}
                                      onChange={(e) => setPath(`reagents.${i}.stock`, e.target.value)}
                                      aria-label={`${r.code} stock`}
                                      style={{ flex: 1, minWidth: '60px', height: '34px' }}
                                      placeholder="e.g. 50"
                                    />
                                    <button
                                      type="button"
                                      className="ib"
                                      style={{ height: '34px', width: '34px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                      title={`Open mass & solution volume calculator for ${r.code}`}
                                      onClick={() => setCalcReagentIndex(i)}
                                    >
                                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <rect x="2" y="2" width="12" height="12" rx="2" />
                                        <line x1="5" y1="5" x2="11" y2="5" />
                                        <circle cx="5" cy="8.5" r="0.7" fill="currentColor" />
                                        <circle cx="8" cy="8.5" r="0.7" fill="currentColor" />
                                        <circle cx="11" cy="8.5" r="0.7" fill="currentColor" />
                                        <circle cx="5" cy="11.5" r="0.7" fill="currentColor" />
                                        <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
                                        <circle cx="11" cy="11.5" r="0.7" fill="currentColor" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>

                                {/* Stock Solvent */}
                                <div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}>Stock Solvent</label>
                                  </div>
                                  <select
                                    className="f"
                                    value={r.solvent}
                                    onChange={(e) => setPath(`reagents.${i}.solvent`, e.target.value)}
                                    aria-label={`${r.code} stock solvent`}
                                    style={{ width: '100%', height: '34px' }}
                                  >
                                    {SUPPORTED_SOLVENTS.map((s) => (
                                      <option key={s} value={s}>
                                        {s}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              {/* Mode-specific status summary strip when inline ranges are not active */}
                              {!hasInlineRange && (
                                <div style={{ marginTop: '12px' }}>
                                  {triRole ? (
                                    <div
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        background: 'var(--panel)',
                                        border: '1px solid var(--line)',
                                        borderRadius: '6px',
                                        padding: '6px 12px',
                                        fontSize: '12px',
                                      }}
                                    >
                                      <span style={{ fontWeight: 600, color: 'var(--fg)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                          <circle cx="8" cy="8" r="5" />
                                        </svg>
                                        Triplet role:
                                      </span>
                                      <span style={{ color: triRole.type === 'unused' ? 'var(--mut)' : 'var(--acc)', fontWeight: triRole.type === 'unused' ? 400 : 600 }}>
                                        {triRole.label}
                                      </span>
                                    </div>
                                  ) : (state.sets?.length || 0) > 1 ? (
                                    <div
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        background: 'var(--panel)',
                                        border: '1px solid var(--line)',
                                        borderRadius: '6px',
                                        padding: '6px 12px',
                                        fontSize: '12px',
                                      }}
                                    >
                                      <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Vial sets:</span>
                                      <span style={{ color: 'var(--mut)' }}>
                                        Concentration ranges managed per-set in the Vial Sets section below
                                      </span>
                                    </div>
                                  ) : null}
                                </div>
                              )}
                            </div>

                            {/* Col 3: Screening Range & Intervals (ONLY rendered when inline ranges exist) */}
                            {hasInlineRange && it && (
                              <div
                                style={{
                                  background: 'var(--soft)',
                                  borderRadius: '8px',
                                  border: '1px solid var(--line)',
                                  padding: '12px 14px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  justifyContent: 'space-between',
                                  gap: '10px',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                                    Screening Range <span style={{ color: 'var(--mut)', fontWeight: 400 }}>({unit})</span>
                                  </span>
                                  {dilutionTier && (
                                    <span
                                      className={`chip ${
                                        dilutionTier.tier === 'direct'
                                          ? 'ok'
                                          : dilutionTier.tier === 'sub'
                                          ? 'bad'
                                          : 'warn'
                                      }`}
                                      style={{ fontSize: '11px', height: '24px', padding: '0 8px' }}
                                      title={dilutionTier.desc}
                                    >
                                      {dilutionTier.tier === 'direct' ? '✓ ' : dilutionTier.tier === 'sub' ? '⚠ ' : '⚙ '}
                                      {dilutionTier.label}
                                    </span>
                                  )}
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                                  {(['min', 'step', 'max'] as const).map((f) => (
                                    <div key={f}>
                                      <label style={{ display: 'block', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: 'var(--mut)', marginBottom: '3px' }}>
                                        {f}
                                      </label>
                                      <input
                                        type="number"
                                        step="any"
                                        className={`f mono ${invalid.has(`sets.0.items.${i}.${f}`) ? 'inv' : ''}`}
                                        style={{ width: '100%', height: '32px' }}
                                        value={it[f]}
                                        onChange={(e) => setPath(`sets.0.items.${i}.${f}`, e.target.value)}
                                        aria-label={`${r.code} ${f}`}
                                        placeholder={f === 'min' ? '0' : f === 'step' ? '1' : '10'}
                                      />
                                    </div>
                                  ))}
                                </div>

                                {axValues && axValues.length > 0 ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
                                    <span style={{ fontSize: '10px', color: 'var(--mut)', fontWeight: 600, textTransform: 'uppercase' }}>
                                      {axValues.length} step{axValues.length === 1 ? '' : 's'}:
                                    </span>
                                    <div style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                                      {axValues.slice(0, 6).map((val, vi) => (
                                        <span
                                          key={vi}
                                          className="mono"
                                          style={{
                                            background: 'var(--panel)',
                                            border: '1px solid var(--line)',
                                            borderRadius: '4px',
                                            padding: '1px 6px',
                                            fontSize: '11px',
                                            color: 'var(--fg)',
                                            fontWeight: 500,
                                          }}
                                          title={`Condition step ${vi + 1}: ${nf(val, 3)} ${unit}`}
                                        >
                                          {nf(val, 2)}
                                        </span>
                                      ))}
                                      {axValues.length > 6 && (
                                        <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 500 }}>
                                          … {nf(axValues[axValues.length - 1], 2)} {unit}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ) : axError ? (
                                  <div style={{ fontSize: '11px', color: 'var(--err, #ef4444)' }}>{axError}</div>
                                ) : (
                                  <div style={{ fontSize: '11px', color: 'var(--mut)', fontStyle: 'italic' }}>
                                    Enter Min, Step, Max to generate screening axis
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {dotsFor(i)}
                    </div>
                  );
                }

                {/* Compact Table View */}
                return (
                  <div key={r.code + i} className="rrow" data-i={i}>
                    <div className={`rw ${showStructures ? 'has-struct' : ''}`}>
                      <input
                        type="text"
                        className="code code-in"
                        style={{
                          background: c,
                          fontSize:
                            r.code.length <= 4
                              ? 14
                              : r.code.length <= 6
                              ? 11
                              : r.code.length <= 10
                              ? 9
                              : 7,
                        }}
                        defaultValue={r.code}
                        onBlur={(e) => renameReagent(i, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameReagent(i, (e.target as HTMLInputElement).value);
                          }
                        }}
                        maxLength={24}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`Reagent ${i + 1} code`}
                        title="Click to rename this code (letters, numbers, _ and -)."
                      />
                      {showStructures && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <ChemicalStructure
                            smiles={r.smiles}
                            iupac={r.iupac || r.name}
                            name={r.name}
                            width={54}
                            height={38}
                            allowZoom={true}
                            onResolvedSmiles={(smiles, mw, density, iupac) => {
                              setState((prev) => {
                                const next = JSON.parse(JSON.stringify(prev));
                                const reg = next.reagents[i];
                                reg.smiles = smiles;
                                if (mw) reg.molarMass = mw;
                                if (density !== undefined) reg.density = density;
                                if (iupac) reg.iupac = iupac;
                                return next;
                              });
                            }}
                          />
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                        <input
                          type="text"
                          className="f"
                          list="libnames"
                          value={r.name}
                          onChange={(e) => setPath(`reagents.${i}.name`, e.target.value)}
                          onBlur={(e) => handleNameSelect(i, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleNameSelect(i, (e.target as HTMLInputElement).value);
                            }
                          }}
                          placeholder="name (library suggests)"
                          aria-label={`${r.code} name`}
                        />
                        {r.smiles && (
                          <div
                            style={{
                              fontSize: '10px',
                              color: 'var(--mut)',
                              fontFamily: 'monospace',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              paddingLeft: '2px',
                            }}
                            title={`SMILES: ${r.smiles}`}
                          >
                            {r.smiles}
                          </div>
                        )}
                      </div>
                      <input
                        type="number"
                        step="any"
                        className="f mono"
                        value={r.molarMass}
                        onChange={(e) => setPath(`reagents.${i}.molarMass`, e.target.value)}
                        aria-label={`${r.code} molar mass`}
                      />
                      <input
                        type="number"
                        step="any"
                        className="f mono"
                        value={r.density || ''}
                        onChange={(e) => setPath(`reagents.${i}.density`, e.target.value)}
                        placeholder="solid"
                        aria-label={`${r.code} density`}
                      />
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        <input
                          type="number"
                          step="any"
                          className={`f mono ${invalid.has(`reagents.${i}.stock`) ? 'inv' : ''}`}
                          value={r.stock}
                          onChange={(e) => setPath(`reagents.${i}.stock`, e.target.value)}
                          aria-label={`${r.code} stock`}
                          style={{ flex: 1, minWidth: '40px' }}
                        />
                        <button
                          type="button"
                          className="ib"
                          style={{ height: '32px', width: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          title={`Open mass & solution volume calculator for ${r.code}`}
                          onClick={() => setCalcReagentIndex(i)}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="2" y="2" width="12" height="12" rx="2" />
                            <line x1="5" y1="5" x2="11" y2="5" />
                            <circle cx="5" cy="8.5" r="0.7" fill="currentColor" />
                            <circle cx="8" cy="8.5" r="0.7" fill="currentColor" />
                            <circle cx="11" cy="8.5" r="0.7" fill="currentColor" />
                            <circle cx="5" cy="11.5" r="0.7" fill="currentColor" />
                            <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
                            <circle cx="11" cy="11.5" r="0.7" fill="currentColor" />
                          </svg>
                        </button>
                      </div>
                      <select
                        className="f"
                        value={r.solvent}
                        onChange={(e) => setPath(`reagents.${i}.solvent`, e.target.value)}
                        aria-label={`${r.code} stock solvent`}
                      >
                        {SUPPORTED_SOLVENTS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <div className="racts">
                        <button
                          type="button"
                          className="ib"
                          onClick={() => moveReagent(i, -1)}
                          disabled={i === 0}
                          title="Add earlier"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 12V4M4 8l4-4 4 4" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="ib"
                          onClick={() => moveReagent(i, 1)}
                          disabled={i === state.reagents.length - 1}
                          title="Add later"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 4v8m-4-4 4 4 4-4" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="ib"
                          onClick={async () => {
                            if (!r.name) {
                              toast('Give the reagent a name first.');
                              return;
                            }
                            await putLib({
                              id: Math.random().toString(36).slice(2, 10),
                              name: r.name,
                              molarMass: +r.molarMass || 0,
                              density: +r.density || 0,
                              smiles: r.smiles || undefined,
                              solvent: r.solvent || undefined,
                            });
                            toast(r.name + ' saved to the library.');
                          }}
                          title="Save to library"
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="8 2 10.3 6.6 15.3 7.3 11.6 10.9 12.5 15.8 8 13.4 3.5 15.8 4.4 10.9 0.7 7.3 5.7 6.6 8 2" />
                          </svg>
                        </button>
                        {state.reagents.length > 2 ? (
                          <button
                            type="button"
                            className="ib"
                            onClick={() => removeReagent(i)}
                            title="Remove"
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="4" y1="4" x2="12" y2="12" />
                              <line x1="12" y1="4" x2="4" y2="12" />
                            </svg>
                          </button>
                        ) : (
                          <span className="ib ph" />
                        )}
                      </div>
                    </div>

                    {inlineRanges && it && (
                      <div
                        className="rng"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'stretch',
                          gap: '8px',
                          background: 'var(--soft)',
                          border: '1px solid var(--line)',
                          borderRadius: '8px',
                          padding: '10px 14px',
                          marginTop: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className="l" style={{ fontWeight: 600 }}>Range in {unit}</span>
                          {(['min', 'step', 'max'] as const).map((f) => (
                            <label
                              key={f}
                              className="l"
                              style={{ display: 'flex', gap: '6px', alignItems: 'center' }}
                            >
                              <span style={{ textTransform: 'capitalize' }}>{f}</span>
                              <input
                                type="number"
                                step="any"
                                className={`f mono ${
                                  invalid.has(`sets.0.items.${i}.${f}`) ? 'inv' : ''
                                }`}
                                style={{ width: '84px' }}
                                value={it[f]}
                                onChange={(e) => setPath(`sets.0.items.${i}.${f}`, e.target.value)}
                                aria-label={`${r.code} ${f}`}
                              />
                            </label>
                          ))}
                          {dilutionTier && (
                            <span
                              className={`chip ${
                                dilutionTier.tier === 'direct'
                                  ? 'ok'
                                  : dilutionTier.tier === 'sub'
                                  ? 'bad'
                                  : 'warn'
                              }`}
                              style={{ fontSize: '11px', height: '26px', padding: '0 9px', marginLeft: 'auto' }}
                              title={dilutionTier.desc}
                            >
                              {dilutionTier.tier === 'direct' ? '✓ ' : dilutionTier.tier === 'sub' ? '⚠ ' : '⚙ '}
                              {dilutionTier.label}
                            </span>
                          )}
                        </div>

                        {/* Discrete Step Interval Preview */}
                        {axValues && axValues.length > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 500 }}>
                              {axValues.length} step{axValues.length === 1 ? '' : 's'}:
                            </span>
                            <div style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                              {axValues.slice(0, 8).map((val, vi) => (
                                <span
                                  key={vi}
                                  className="mono"
                                  style={{
                                    background: 'var(--panel)',
                                    border: '1px solid var(--line)',
                                    borderRadius: '4px',
                                    padding: '2px 7px',
                                    fontSize: '11px',
                                    color: 'var(--fg)',
                                    fontWeight: 500,
                                  }}
                                  title={`Condition step ${vi + 1}: ${nf(val, 3)} ${unit}`}
                                >
                                  {nf(val, 2)}
                                </span>
                              ))}
                              {axValues.length > 8 && (
                                <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 500 }}>
                                  … {nf(axValues[axValues.length - 1], 2)} {unit}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {axError && <span className="rp e">{axError}</span>}
                      </div>
                    )}

                    {state.mode === 'triplet' && (
                      <div className="hint">
                        {(() => {
                          const ai = (state.tri?.adds || []).findIndex((a) => a.code === r.code);
                          const gs = (state.tri?.groups || [])
                            .filter((g) => g.members.includes(r.code))
                            .map((g) => g.name);
                          return ai >= 0
                            ? `Additive · ${nf(state.tri?.adds[ai].equiv, 3)} eq`
                            : gs.length
                            ? 'In ' + gs.join(', ')
                            : 'Not used yet';
                        })()}
                      </div>
                    )}

                    {dotsFor(i)}
                  </div>
                );
              });
            })()}

            <div className="note" style={{ marginTop: '14px' }}>
              {state.mode === 'triplet'
                ? 'Give every reagent a code and a name (type a library name to fill molar mass and density). Additives are chosen in the plate pattern below.'
                : inlineRanges
                ? 'Define each reagent and its range on one row. Type a name from your library to fill molar mass and density.'
                : 'Define each reagent once; the vial sets below say where it is used and in what range.'}
            </div>

            {inlineRanges && (
              <div style={{ marginTop: '10px' }}>
                <button type="button" className="btn sm" onClick={addSet}>
                  Add a second vial set
                </button>{' '}
                <span className="hint">for vials that need different reagents or ranges</span>
              </div>
            )}
          </div>
        </div>

        {/* Mode Specific Sections */}
        {state.mode === 'triplet' ? (
          <TripletPatternEditor />
        ) : state.imported ? (
          <div className="card" style={{ marginTop: '20px' }}>
            <h2>Imported vials</h2>
            <p className="sub">
              {state.imported.rows.length} vials rebuilt from <b>{state.imported.name}</b>. Their
              concentrations are fixed; change reagents, stocks or run settings above and everything
              recalculates.
            </p>
            {state.imported.note && (
              <div className={`issue ${state.imported.differ ? 'warn' : 'ok'}`}>
                <span>{state.imported.note}</span>
              </div>
            )}
            <button type="button" className="btn" onClick={unimport}>
              Discard imported vials and use vial sets
            </button>
          </div>
        ) : !inlineRanges ? (
          <VialSetsCard />
        ) : null}
      </div>

      {/* Right Column: Live Panel */}
      <div className="rcol" id="live">
        <div className="card pad">
          <div className="lbl">THIS RUN</div>
          <div className="big">
            <b>
              {state.mode === 'triplet'
                ? triMeta.filter((m) => !m.blank).length
                : run
                ? run.reactions
                : '-'}
            </b>
            <span>
              {state.mode === 'triplet' ? 'wells' : 'vials'} · {run ? run.plates : '-'} plate
              {run?.plates === 1 ? '' : 's'}
            </span>
          </div>
          <div className="hr" />

          {blank ? (
            <div className="hint" style={{ marginTop: '8px', fontSize: '14px' }}>
              {err}
            </div>
          ) : err ? (
            <div className="issue bad">
              <span>{err}</span>
            </div>
          ) : run ? (
            <>
              <div className="crows">
                <div className="crow">
                  <span>All volumes ≥ {state.threshold} µL</span>
                  <span className={`chip ${minOk ? 'ok' : 'bad'}`}>
                    {minOk ? '✓ Yes' : '✗ No'}
                  </span>
                </div>
                <div className="crow">
                  <span>All volumes under 1000 µL</span>
                  <span className={`chip ${maxOk ? 'ok' : 'bad'}`}>
                    {maxOk ? '✓ Yes' : '✗ No'}
                  </span>
                </div>
                <div className="crow">
                  <span>Solvent never negative</span>
                  <span className={`chip ${!negCount ? 'ok' : 'bad'}`}>
                    {!negCount ? '✓ Yes' : `✗ No · ${negCount} vials`}
                  </span>
                </div>
              </div>

              {/* Issues Display */}
              <div style={{ marginTop: '14px' }}>
                {!run.issues.length ? (
                  <div className="issue ok">
                    <span>
                      All volumes are within limits: every transfer ≥ threshold, under 1000 µL,
                      solvent never negative.
                    </span>
                  </div>
                ) : (
                  (() => {
                    const groups: Record<string, typeof run.issues> = {};
                    run.issues.forEach((x) => {
                      (groups[x.type] = groups[x.type] || []).push(x);
                    });
                    return Object.entries(groups).map(([t, list]) => {
                      const sev = list.some((x) => x.severity === 'block') ? 'bad' : 'warn';
                      const rowsIx = [
                        ...new Set(list.map((x) => x.row).filter((x) => x != null)),
                      ] as number[];
                      return (
                        <div key={t} className={`issue ${sev}`}>
                          <span>
                            <b>{ISSUE_NAMES[t] || t}</b> ({list.length}) · {list[0].message}
                            {list.length > 1 && <i> +{list.length - 1} more</i>}
                          </span>
                          {rowsIx.length > 0 && (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                setVialFocus({
                                  label: ISSUE_NAMES[t] || t,
                                  rows: new Set(rowsIx),
                                });
                                setVisited((v) => ({ ...v, combos: true }));
                                setView('combos');
                                window.scrollTo(0, 0);
                              }}
                            >
                              Show {rowsIx.length} vial{rowsIx.length > 1 ? 's' : ''}
                            </button>
                          )}
                        </div>
                      );
                    });
                  })()
                )}

                {/* Verified Fixes */}
                {run.blockingIssues > 0 && fixes.length > 0 ? (
                  <div className="issue warn" role="status" aria-live="polite">
                    <span>
                      <b>Verified fixes</b> (each one was recalculated and clears every blocking
                      check)
                    </span>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                      {fixes.map((f, fi) => (
                        <button
                          key={fi}
                          type="button"
                          className="btn sm"
                          onClick={() => setInspectFixIndex(fi)}
                          title="Inspect solution diff and simulated impact before applying"
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {fixes.some((f) => f.kind === 'stock') && (
                      <span className="hint" style={{ flexBasis: '100%', marginTop: '4px' }}>
                        A stock change means preparing that stock at the new concentration. Check it
                        still dissolves.
                      </span>
                    )}
                  </div>
                ) : run.blockingIssues > 0 && run.reactions > 1500 ? (
                  <div className="hint" role="status" aria-live="polite">
                    This run has more than 1,500 vials, so fixes are not searched automatically.
                  </div>
                ) : run.blockingIssues > 0 && !fixesDone && run.reactions > 300 ? (
                  fixesBusy ? (
                    <div className="hint" role="status" aria-live="polite">
                      Searching for verified fixes… this can take a few seconds.
                    </div>
                  ) : (
                    <div className="issue warn" role="status" aria-live="polite">
                      <span>
                        This run has {run.reactions} vials, so fixes are searched on request.
                      </span>
                      <button type="button" className="btn sm" onClick={findFixes}>
                        Find verified fixes
                      </button>
                    </div>
                  )
                ) : run.blockingIssues > 0 && !fixesDone ? (
                  <div className="hint" role="status" aria-live="polite">
                    Looking for a verified fix…
                  </div>
                ) : run.blockingIssues > 0 && fixesDone && !fixes.length ? (
                  <>
                    <div className="issue warn" role="status" aria-live="polite">
                      <span>
                        <b>No single change fixes this</b>
                      </span>
                    </div>
                    {whyNot.length > 0 && (
                      <div className="issue warn" role="status" aria-live="polite">
                        <span>
                          <b>Why</b>
                          {whyNot.map((w, wi) => (
                            <React.Fragment key={wi}>
                              <br />
                              {w}
                            </React.Fragment>
                          ))}
                        </span>
                      </div>
                    )}
                  </>
                ) : null}

                {/* Stock hints */}
                {Tri.stockHints(state).map((x, xi) => (
                  <div key={xi} className="issue warn">
                    <span>{x}</span>
                  </div>
                ))}

                {/* Triplet warnings */}
                {state.mode === 'triplet' &&
                  Tri.triWarnings(state)
                    .filter((x) => !x.startsWith('No section'))
                    .map((x, xi) => (
                      <div key={xi} className="issue warn">
                        <span>{x}</span>
                      </div>
                    ))}
              </div>

              {/* Check table by reagent details */}
              <details
                className="det"
                open={detailsOpen}
                onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary>Check table by reagent</summary>
                <div className="tbl" style={{ marginTop: '8px' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Check</th>
                        {state.reagents.map((r, i) => (
                          <th key={r.code + i}>
                            <span className="rdot" style={{ background: rcol(i) }}>
                              {r.code}
                            </span>
                          </th>
                        ))}
                        <th>solvent</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>All volumes ≥ {state.threshold} µL</td>
                        {cs.map((c) => (
                          <td key={c.code}>
                            {c.okMin ? '✓' : <b style={{ color: 'var(--bad)' }}>✗ {nf(c.min, 1)}</b>}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td>All volumes &lt; 1000 µL</td>
                        {cs.map((c) => (
                          <td key={c.code}>
                            {c.okMax ? '✓' : <b style={{ color: 'var(--bad)' }}>✗ {nf(c.max, 0)}</b>}
                          </td>
                        ))}
                      </tr>
                      <tr>
                        <td>Solvent never negative</td>
                        {cs.map((c) =>
                          c.code === 'solvent' ? (
                            <td key={c.code}>
                              {c.neg ? (
                                <b style={{ color: 'var(--bad)' }}>✗ {c.neg}</b>
                              ) : (
                                '✓'
                              )}
                            </td>
                          ) : (
                            <td key={c.code} className="mono" style={{ color: 'var(--mut)' }}>
                              -
                            </td>
                          )
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </details>

              <div className="hint" style={{ marginTop: '12px' }}>
                Stock volume = total pipetted + {state.leftoverMl} mL leftover, rounded up to a
                volumetric flask. Total solvent {nf(run.solventRecommendedMl, 1)} mL.
              </div>
            </>
          ) : null}
        </div>

        {/* Stock Preparation Card */}
        {run && (
          <div className="card pad">
            <div className="ct" style={{ marginBottom: '10px' }}>
              Stock preparation
            </div>
            <div className="plist">
              {Object.entries(run.stocks)
                .filter(([, s]) => s.dilution_level === 0)
                .map(([, s]) => {
                  const i = state.reagents.findIndex((x) => x.code === s.source_reagent);
                  const sub = s.chemical_volume_ml
                    ? `${nf(s.chemical_volume_ml, 3)} mL liquid`
                    : 'weigh solid';
                  const need = Object.values(run.stocks)
                    .filter(
                      (t) => t.source_reagent === s.source_reagent && t.dilution_level > 0
                    )
                    .map((t) => `${(+state.dilutionFactor) ** t.dilution_level}× stock`);
                  return (
                    <div key={s.substance} className="prow">
                      <div className="code sm" style={{ background: rcol(i < 0 ? 0 : i) }}>
                        {s.source_reagent}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>
                          {nf(s.prep_volume_ml, 1)} mL at {nf(s.concentration_mM, 1)} mM ·{' '}
                          {s.flask_label}
                        </div>
                        <div className="hint" style={{ margin: 0 }}>
                          {sub}
                          {need.length ? ' · also hand-diluted to ' + need.join(', ') : ''} ·{' '}
                          {s.solvent}
                        </div>
                      </div>
                      <div className="mono pv">
                        {s.mass_g != null ? nf(s.mass_g, 3) + ' g' : nf(s.prep_volume_ml, 1) + ' mL'}
                      </div>
                    </div>
                  );
                })}
              {(run.sourceOnlyStocks || []).map((s) => {
                const i = state.reagents.findIndex((x) => x.code === s.source_reagent);
                return (
                  <div key={s.substance} className="prow">
                    <div className="code sm" style={{ background: rcol(i < 0 ? 0 : i) }}>
                      {s.source_reagent}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>
                        {nf(s.prep_volume_ml, 0)} mL source stock
                      </div>
                      <div className="hint" style={{ margin: 0 }}>
                        not on deck · for hand dilutions only
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Workflow Guidance Action Banner */}
        {run && (
          <div
            style={{
              background: run.blockingIssues === 0 ? 'var(--okbg)' : 'var(--warnbg)',
              border: `1px solid ${run.blockingIssues === 0 ? 'var(--ok)' : 'var(--warn)'}`,
              borderRadius: '12px',
              padding: '14px 16px',
              margin: '16px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div
                style={{
                  fontSize: '18px',
                  lineHeight: '1.2',
                  color: run.blockingIssues === 0 ? 'var(--ok)' : 'var(--warn)',
                  fontWeight: 'bold',
                }}
              >
                {run.blockingIssues === 0 ? '✓' : '⚠'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--fg)' }}>
                  {run.blockingIssues === 0
                    ? `Setup Ready · ${run.reactions} conditions validated`
                    : `${run.blockingIssues} blocking issue${run.blockingIssues > 1 ? 's' : ''} detected`}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px', lineHeight: '1.4' }}>
                  {run.blockingIssues === 0
                    ? `Fits across ${run.plates} plate${run.plates === 1 ? '' : 's'} · ${nf(run.solventRecommendedMl, 1)} mL ${state.reactionSolvent} required. Ready to review 2D conditions.`
                    : 'Adjust concentrations or apply verified fixes above to proceed.'}
                </div>
                {run.blockingIssues > 0 && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      marginTop: '8px',
                      fontSize: '11px',
                      height: '28px',
                      fontWeight: 600,
                    }}
                    onClick={() => setAiDiagnosticsOpen(true)}
                    title="Ask Gemini to diagnose robot volume and stock concentration errors"
                  >
                    <span>✦</span> AI Diagnostic Advisor
                  </button>
                )}
              </div>
            </div>
            {run.blockingIssues === 0 && (
              <button
                type="button"
                className="btn pri sm"
                style={{ alignSelf: 'stretch', justifyContent: 'center' }}
                onClick={() => {
                  setVisited((v) => ({ ...v, combos: true }));
                  setView('combos');
                  window.scrollTo(0, 0);
                }}
              >
                Next: Review Combinations →
              </button>
            )}
          </div>
        )}

        {/* Buttons at bottom of right column */}
        <div className="btns">
          <button type="button" className="btn lg" onClick={() => saveRun(false)} disabled={!!err}>
            Save draft
          </button>
          <button
            type="button"
            className="btn lg pri"
            onClick={() => {
              setVisited((v) => ({ ...v, combos: true }));
              setView('combos');
              window.scrollTo(0, 0);
            }}
          >
            Review combinations
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </button>
        </div>
      </div>

      <FixDiffModal
        fix={inspectFixIndex !== null ? fixes[inspectFixIndex] : null}
        fixIndex={inspectFixIndex}
        currentState={state}
        currentRun={run}
        onApply={(idx) => {
          applyFix(idx);
          setInspectFixIndex(null);
        }}
        onClose={() => setInspectFixIndex(null)}
      />

      <AiDiagnosticsModal
        isOpen={aiDiagnosticsOpen}
        onClose={() => setAiDiagnosticsOpen(false)}
        runName={state.name}
        totalVials={run?.reactions || 0}
        vialVolume={state.vialVolume}
        threshold={state.threshold}
        solvent={state.reactionSolvent}
        reagents={state.reagents}
        issues={run?.blockingIssues ? cs.filter((c) => !c.okMin || !c.okMax || c.neg) : []}
        deckWarnings={run?.deck?.positions_fit === false && run?.deck?.positions_message ? [run.deck.positions_message] : []}
      />

      {calcReagentIndex !== null && state.reagents[calcReagentIndex] && (
        <StockCalculatorModal
          reagent={state.reagents[calcReagentIndex]}
          reagentIndex={calcReagentIndex}
          isOpen={true}
          onClose={() => setCalcReagentIndex(null)}
          onApplyStock={(idx, conc) => {
            setPath(`reagents.${idx}.stock`, conc);
            toast(`Applied ${conc} mM stock concentration to Reagent ${state.reagents[idx].code}.`);
          }}
        />
      )}
    </div>
  );
};

// Vial Sets Editor (for non-inline ranges)
const VialSetsCard: React.FC = () => {
  const { state, setPath, addSet, dupSet, removeSet } = useApp();
  const eq = state.mode === 'equivalence';
  const sets = state.sets || [];

  const setCount = (set: (typeof sets)[0]) => {
    let t = 1,
      ok = true;
    for (const it of set.items) {
      if (!it.on) continue;
      const st = +it.step,
        mn = +it.min,
        mx = +it.max;
      if (!(st > 0) || mx < mn) {
        ok = false;
        break;
      }
      const k = (mx - mn) / st;
      if (Math.abs(k - Math.round(k)) > 1e-7) {
        ok = false;
        break;
      }
      t *= Math.round(k) + 1;
    }
    return ok && set.items.some((i) => i.on) ? t : -1;
  };

  return (
    <div className="card" style={{ marginTop: '20px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
          marginBottom: '8px',
        }}
      >
        <div>
          <h2>Vial sets</h2>
          <p className="sub" style={{ margin: 0 }}>
            Each set picks which reagents go in and their ranges. The vials of all sets are added
            together.
          </p>
        </div>
        <button type="button" className="btn" onClick={addSet}>
          Add set
        </button>
      </div>

      {sets.map((set, si) => {
        const sc = setCount(set);
        return (
          <div
            key={si}
            className="rcard"
            style={{ borderLeftColor: PAL[si % PAL.length] }}
          >
            <div className="rhead">
              <input
                type="text"
                value={set.name}
                onChange={(e) => setPath(`sets.${si}.name`, e.target.value)}
                style={{ width: '170px', height: '32px', fontWeight: 600 }}
              />
              <span className="chip mut">
                {sc < 0 ? 'check ranges' : sc + ' vial' + (sc === 1 ? '' : 's')}
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => dupSet(si)}>
                Duplicate
              </button>
              {sets.length > 1 && (
                <button type="button" className="btn sm" onClick={() => removeSet(si)}>
                  Remove
                </button>
              )}
            </div>

            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Reagent</th>
                    <th>Min</th>
                    <th>Step</th>
                    <th>Max</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.reagents.map((r, i) => {
                    const it = set.items[i] || { on: false, min: 1, step: 1, max: 2 };
                    const unit = eq && i > 0 ? 'equiv.' : 'mM';
                    return (
                      <tr key={r.code + i}>
                        <td>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="checkbox"
                              checked={it.on}
                              onChange={(e) =>
                                setPath(`sets.${si}.items.${i}.on`, e.target.checked)
                              }
                              style={{ width: '18px', height: '18px', accentColor: PAL[i % PAL.length] }}
                            />
                            <span className="rdot" style={{ background: PAL[i % PAL.length] }}>
                              {r.code}
                            </span>
                          </label>
                        </td>
                        {(['min', 'step', 'max'] as const).map((f) => (
                          <td key={f}>
                            <input
                              type="number"
                              step="any"
                              value={it[f]}
                              disabled={!it.on}
                              onChange={(e) =>
                                setPath(`sets.${si}.items.${i}.${f}`, e.target.value)
                              }
                              style={{ width: '84px', height: '30px' }}
                            />
                          </td>
                        ))}
                        <td className="hint" style={{ textAlign: 'left' }}>
                          {it.on ? unit : 'not in this set'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="hint">
        {eq
          ? 'Equivalence mode: the first reagent is a concentration in mM, the others are multiples of it.'
          : 'Concentration mode: every ticked reagent has its own range in mM.'}{' '}
        For a single amount, set min and max equal.
      </div>
    </div>
  );
};

// Triplet Pattern & Plates Editor
const TripletPatternEditor: React.FC = () => {
  const { state, setState, setPath, toast, unimport, importRobotFile } = useApp();
  const triExcelInputRef = React.useRef<HTMLInputElement>(null);
  const t = state.tri || Tri.triDefault();
  const g = Tri.triGeom(state);
  const size = Tri.triSize(state);
  const pre = Tri.triDetectPreset(state);
  const gn = Tri.triGroupName(state);

  const nf = (v: any, d = 2) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const cells = [];
  for (let rr = 0; rr < g.r; rr++) {
    for (let cc = 0; cc < g.c; cc++) {
      const a = t.adds[rr];
      cells.push(
        <div key={`${rr}-${cc}`} className="tcell">
          <b className="mono">{(t.ratios[cc] || []).join(':')}</b>
          <span>
            {a && a.code ? `${a.code} ${nf(a.equiv, 3)} eq` : 'no additive'}
          </span>
        </div>
      );
    }
  }

  return (
    <div style={{ marginTop: '20px' }}>
      {state.imported && (
        <div
          className="card pad"
          style={{
            marginBottom: '16px',
            background: 'var(--soft, rgba(59,130,246,0.06))',
            borderColor: 'var(--accent, #3b82f6)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--fg, #0f172a)' }}>
                📥 Imported Triplet Run: {state.imported.name}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--mut, #64748b)', marginTop: '2px' }}>
                {state.imported.rows.length} wells mapped from Excel with exact concentrations (including blank solvent wells).
              </div>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={unimport}
              title="Discard imported lock to edit pattern and regenerate combinations"
            >
              Discard lock & edit pattern
            </button>
          </div>
        </div>
      )}

      {/* Pattern Card */}
      <div className="card pad">
        <div className="chead">
          <div className="ct">Plate pattern</div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              onClick={() => triExcelInputRef.current?.click()}
              title="Import a Triplet run from Excel (.xlsx)"
            >
              📥 Import from Excel
            </button>
            <input
              ref={triExcelInputRef}
              type="file"
              accept=".xlsx,.xlsm"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importRobotFile(file);
                e.target.value = '';
              }}
            />
            <select
              className="f"
              style={{ width: 'auto' }}
              value={pre}
              onChange={(e) => {
                const val = e.target.value;
                if (val !== 'custom') {
                  setState((prev) => {
                    const next = JSON.parse(JSON.stringify(prev));
                    next.tri.ratios = Tri.triPresetData(val).ratios;
                    Tri.triSync(next);
                    return next;
                  });
                }
              }}
              aria-label="Pattern preset"
            >
              <option value="triplet">Triplet (3 reagents)</option>
              <option value="doublet">Doublet (2 reagents)</option>
              <option value="quartet">Quartet (4 reagents)</option>
              {pre === 'custom' && <option value="custom">Custom (edited)</option>}
            </select>
          </div>
        </div>
        <p className="sub" style={{ marginTop: '-8px' }}>
          Every section of the plate holds one {gn}. Its columns are the ratios, its rows the
          additives.
        </p>

        <div className="pgrid">
          <div className="fld">
            <label className="lbl">Base concentration, 1 eq (mM)</label>
            <input
              type="number"
              step="any"
              className="f mono"
              value={t.base}
              onChange={(e) => setPath('tri.base', e.target.value)}
            />
          </div>
          <div className="fld">
            <label className="lbl">Reagents per group</label>
            <div className="seg full" role="group" aria-label="Reagents per group">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={size === n ? 'on' : ''}
                  onClick={() => {
                    setState((prev) => {
                      const next = JSON.parse(JSON.stringify(prev));
                      if (Tri.triDetectPreset(next) !== 'custom') {
                        next.tri.ratios = Tri.triPresetData(
                          ({ 2: 'doublet', 3: 'triplet', 4: 'quartet' } as any)[n]
                        ).ratios;
                      } else {
                        next.tri.ratios = next.tri.ratios.map((vec: number[]) => {
                          const o = vec.slice(0, n);
                          while (o.length < n) o.push(1);
                          return o;
                        });
                      }
                      Tri.triSync(next);
                      return next;
                    });
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Ratios Table */}
        <div className="tbl" style={{ marginTop: '14px' }}>
          <table className="tri-tbl">
            <thead>
              <tr>
                <th>Ratio</th>
                {Array.from({ length: size }, (_, j) => (
                  <th key={j}>Reagent {j + 1}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {t.ratios.map((v, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  {v.map((x, j) => (
                    <td key={j}>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        className="f mono"
                        value={x}
                        onChange={(e) => setPath(`tri.ratios.${i}.${j}`, +e.target.value)}
                        style={{ width: '76px', height: '32px' }}
                      />
                    </td>
                  ))}
                  <td>
                    {t.ratios.length > 1 && (
                      <button
                        type="button"
                        className="ib"
                        onClick={() => {
                          setState((prev) => {
                            const next = JSON.parse(JSON.stringify(prev));
                            next.tri.ratios.splice(i, 1);
                            Tri.triSync(next);
                            return next;
                          });
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {t.ratios.length < 9 && (
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: '8px' }}
            onClick={() => {
              setState((prev) => {
                const next = JSON.parse(JSON.stringify(prev));
                const nv = Array(size).fill(1);
                nv[next.tri.ratios.length % size] = 2;
                next.tri.ratios.push(nv);
                Tri.triSync(next);
                return next;
              });
            }}
          >
            Add ratio
          </button>
        )}

        {/* Additives Table */}
        <div className="tbl" style={{ marginTop: '16px' }}>
          <table className="tri-tbl">
            <thead>
              <tr>
                <th>Additive (reagent)</th>
                <th>Equivalents</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {t.adds.map((a, i) => (
                <tr key={i}>
                  <td>
                    <select
                      className="f"
                      value={a.code}
                      onChange={(e) => setPath(`tri.adds.${i}.code`, e.target.value)}
                    >
                      <option value="">No additive</option>
                      {state.reagents.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.name ? `${r.code} · ${r.name}` : r.code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      className="f mono"
                      value={a.equiv}
                      onChange={(e) => setPath(`tri.adds.${i}.equiv`, +e.target.value)}
                      style={{ width: '84px', height: '32px' }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ib"
                      onClick={() => {
                        setState((prev) => {
                          const next = JSON.parse(JSON.stringify(prev));
                          next.tri.adds.splice(i, 1);
                          Tri.triSync(next);
                          return next;
                        });
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {t.adds.length < 6 && (
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: '8px' }}
            onClick={() => {
              setState((prev) => {
                const next = JSON.parse(JSON.stringify(prev));
                next.tri.adds.push({ code: '', equiv: 0.5 });
                Tri.triSync(next);
                return next;
              });
            }}
          >
            Add additive row
          </button>
        )}

        <div className="lbl" style={{ marginTop: '16px' }}>
          ONE SECTION
        </div>
        <div
          className="tri-prev"
          style={{
            gridTemplateColumns: `repeat(${g.c}, minmax(70px, 1fr))`,
            maxWidth: `${g.c * 120}px`,
          }}
        >
          {cells}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          {g.n
            ? `${g.across} × ${g.down} = ${g.n} sections per plate, ${g.c} × ${g.r} wells each${
                g.leftover ? `, ${g.leftover} wells left unused` : ''
              }.`
            : 'This pattern does not fit on a 6 × 9 plate.'}
        </div>
      </div>

      {/* Groups Card */}
      <div className="card pad" style={{ marginTop: '20px' }}>
        <div className="chead">
          <div className="ct">
            {gn[0].toUpperCase() + gn.slice(1)}s <span className="cnt">{t.groups.length}</span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setState((prev) => {
                const next = JSON.parse(JSON.stringify(prev));
                next.tri.groups.push(Tri.triNewGroup(next));
                Tri.triSync(next);
                return next;
              });
            }}
          >
            Add {gn}
          </button>
        </div>

        <div className="tbl">
          <table className="tri-tbl">
            <thead>
              <tr>
                <th>Name</th>
                {Array.from({ length: size }, (_, j) => (
                  <th key={j}>Reagent {j + 1}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {t.groups.map((grp, i) => (
                <tr key={grp.id}>
                  <td>
                    <input
                      type="text"
                      className="f"
                      value={grp.name}
                      onChange={(e) => setPath(`tri.groups.${i}.name`, e.target.value)}
                      style={{ width: '110px', height: '32px' }}
                    />
                    {grp.derived && <span className="chip mut">derived</span>}
                  </td>
                  {grp.members.map((m, j) => (
                    <td key={j}>
                      <select
                        className="f"
                        value={m}
                        onChange={(e) =>
                          setPath(`tri.groups.${i}.members.${j}`, e.target.value)
                        }
                      >
                        <option value="">{grp.derived ? '(solvent)' : 'Pick…'}</option>
                        {state.reagents.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.name ? `${r.code} · ${r.name}` : r.code}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="ib"
                      onClick={() => {
                        setState((prev) => {
                          const next = JSON.parse(JSON.stringify(prev));
                          next.tri.groups.splice(i, 1);
                          Tri.triSync(next);
                          return next;
                        });
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Plates Card */}
      <div className="card pad" style={{ marginTop: '20px' }}>
        <div className="chead">
          <div className="ct">Plates</div>
        </div>
        <p className="sub" style={{ marginTop: '-8px' }}>
          Pick a {gn} for each section. Empty sections stay unfilled (all volumes 0).
        </p>

        {/* Derived Switch */}
        <div
          style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            flexWrap: 'wrap',
            margin: '0 0 6px',
          }}
        >
          <span className="lbl" style={{ margin: 0 }}>
            Doublet / singlet amounts
          </span>
          <div className="seg" role="group" aria-label="Doublet and singlet amounts">
            <button
              type="button"
              className={t.derivedRatio !== 'equal' ? 'on' : ''}
              onClick={() => {
                setState((prev) => {
                  const next = JSON.parse(JSON.stringify(prev));
                  next.tri.derivedRatio = 'keep';
                  next.tri.plates.forEach((pl: any) => {
                    if (pl) pl.flat = false;
                  });
                  Tri.triSync(next);
                  return next;
                });
              }}
            >
              Triplet ratios
            </button>
            <button
              type="button"
              className={t.derivedRatio === 'equal' ? 'on' : ''}
              onClick={() => {
                setState((prev) => {
                  const next = JSON.parse(JSON.stringify(prev));
                  next.tri.derivedRatio = 'equal';
                  next.tri.plates.forEach((pl: any) => {
                    if (pl) {
                      pl.flat =
                        pl.sections.some(Boolean) &&
                        pl.sections.every(
                          (id: string) =>
                            !id || (next.tri.groups.find((x: any) => x.id === id) || {}).derived
                        );
                    }
                  });
                  Tri.triSync(next);
                  return next;
                });
              }}
            >
              Flat 1:1
            </button>
          </div>
        </div>

        {/* Plate 0, 1, 2 */}
        {t.plates.map((pl, p) => {
          const isFlat = Tri.triFlat(pl, state);
          const slotsCount = Tri.triSlots(pl, state);
          return (
            <div
              key={p}
              className="rcard"
              style={{ borderLeftColor: PAL[p % PAL.length], marginTop: '12px' }}
            >
              <div className="rhead">
                <b>plate{p}</b>
                <span className="chip mut">
                  {pl
                    ? `${pl.sections.filter(Boolean).length} of ${slotsCount} ${
                        isFlat ? 'vial blocks' : 'sections'
                      }`
                    : 'not used'}
                </span>
                <span style={{ flex: 1 }} />

                {pl && (
                  <select
                    className="f sm"
                    value=""
                    onChange={(e) => {
                      const src = +e.target.value;
                      if (!isNaN(src) && t.plates[src]) {
                        setState((prev) => {
                          const next = JSON.parse(JSON.stringify(prev));
                          next.tri.plates[p].sections = [...next.tri.plates[src].sections];
                          Tri.triSync(next);
                          return next;
                        });
                      }
                    }}
                  >
                    <option value="">Copy from…</option>
                    {t.plates.map(
                      (o, oi) =>
                        o &&
                        oi !== p && (
                          <option key={oi} value={oi}>
                            plate{oi}
                          </option>
                        )
                    )}
                  </select>
                )}

                {p > 0 && t.plates.some((o, oi) => o && oi !== p && o.sections.some(Boolean)) && (
                  <select
                    className="f sm"
                    value=""
                    onChange={(e) => {
                      const src = +e.target.value;
                      if (!isNaN(src)) {
                        setState((prev) => {
                          const next = JSON.parse(JSON.stringify(prev));
                          Tri.triDerive(p, src, next);
                          return next;
                        });
                        toast(`Derived doublets and singlets from plate${src}.`);
                      }
                    }}
                    title="Fills this plate with the sub-groups of the groups on another plate"
                  >
                    <option value="">Doublets + singlets from…</option>
                    {t.plates.map(
                      (o, oi) =>
                        o &&
                        oi !== p &&
                        o.sections.some(Boolean) && (
                          <option key={oi} value={oi}>
                            plate{oi}
                          </option>
                        )
                    )}
                  </select>
                )}

                {p > 0 && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setState((prev) => {
                        const next = JSON.parse(JSON.stringify(prev));
                        const r = Tri.triDeriveAll(p, next);
                        if (r) {
                          toast(
                            `Filled ${r.placed.map((x) => 'plate' + x).join(' and ')} with ${
                              r.pairs
                            } pairs and ${r.singles} singles.`
                          );
                        } else {
                          toast('Need at least two chemical reagents (not additives).');
                        }
                        return next;
                      });
                    }}
                  >
                    All pairs + singles ×1, ×2
                  </button>
                )}

                {(p > 0 || !pl || t.plates.some((o, oi) => o && oi !== p)) && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setState((prev) => {
                        const next = JSON.parse(JSON.stringify(prev));
                        next.tri.plates[p] = next.tri.plates[p] ? null : { sections: [] };
                        Tri.triSync(next);
                        return next;
                      });
                    }}
                  >
                    {pl ? 'Do not use' : 'Use this plate'}
                  </button>
                )}
              </div>

              {pl && g.n > 0 && (
                <div
                  className="tri-grid"
                  style={{
                    gridTemplateColumns: `repeat(${isFlat ? 3 : g.across}, minmax(0, 1fr))`,
                  }}
                >
                  {pl.sections.map((id, si) => (
                    <label key={si}>
                      <span className="l">
                        {isFlat
                          ? `Vials ${si * Tri.triBlock(state) + 1}–${Math.min(
                              54,
                              (si + 1) * Tri.triBlock(state)
                            )}`
                          : `Section ${si + 1}`}
                      </span>
                      <select
                        className="f"
                        value={id}
                        onChange={(e) => setPath(`tri.plates.${p}.sections.${si}`, e.target.value)}
                      >
                        <option value="">(empty)</option>
                        {t.groups.map((grp) => (
                          <option key={grp.id} value={grp.id}>
                            {grp.name}
                            {grp.derived && grp.name === grp.members.filter(Boolean).join('+')
                              ? ''
                              : ` (${
                                  grp.derived
                                    ? grp.members.filter(Boolean).join('+')
                                    : grp.members.map((m) => m || '?').join('+')
                                })`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
