import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import {
  WellOutcomeStatus,
  WellObservation,
  HteElnRecord,
  RecipeItem,
} from '../../types';
import { AiSynthesisReport } from '../ui/AiSynthesisReport';

const PLATE_SIZE = 54;
const ROWS = 6;
const COLS = 9;
const ROW_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const OBSERVATION_TAGS: { id: string; label: string; icon: string; color: string; desc: string }[] = [
  { id: 'polymerized', label: 'Polymerized', icon: '🧪', color: '#8b5cf6', desc: 'Solid, rubbery plug, or cross-linked gel' },
  { id: 'precipitated', label: 'Precipitated', icon: '❄️', color: '#f59e0b', desc: 'Solid precipitate, suspension, or flocculation' },
  { id: 'volume_decreased', label: 'Volume Decreased', icon: '📉', color: '#0ea5e9', desc: 'Evaporation, septum leak, or consumption' },
  { id: 'gas_evolution', label: 'Gas Evolution', icon: '💨', color: '#06b6d4', desc: 'Bubbling, foaming, or pressurization' },
  { id: 'color_change', label: 'Color Change', icon: '🎨', color: '#ec4899', desc: 'Significant color shift (e.g. yellow to black)' },
  { id: 'biphasic', label: 'Biphasic / Oil', icon: '💧', color: '#eab308', desc: 'Phase separation, oil droplets, or emulsion' },
  { id: 'viscous_gel', label: 'Viscous / Gelled', icon: '🍯', color: '#d97706', desc: 'Thickened liquid or high viscosity' },
  { id: 'turbid', label: 'Turbid / Cloudy', icon: '☁️', color: '#64748b', desc: 'Hazy, colloidal suspension' },
  { id: 'homogeneous', label: 'Homogeneous', icon: '✨', color: '#10b981', desc: 'Clear, single-phase solution' },
];

const OUTCOME_OPTIONS: { id: WellOutcomeStatus; label: string; icon: string; color: string; bg: string }[] = [
  { id: 'hit', label: 'Top Hit (Candidate)', icon: '⭐', color: '#059669', bg: 'rgba(16, 185, 129, 0.15)' },
  { id: 'clean', label: 'Clean Conversion', icon: '🟢', color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
  { id: 'partial', label: 'Partial Conversion', icon: '🟡', color: '#d97706', bg: 'rgba(245, 158, 11, 0.12)' },
  { id: 'sm_only', label: 'Starting Material Only', icon: '⚪', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.1)' },
  { id: 'decomp', label: 'Decomposition', icon: '🔴', color: '#dc2626', bg: 'rgba(239, 68, 68, 0.12)' },
  { id: 'precipitate', label: 'Precipitate / Clogged', icon: '⚠️', color: '#d97706', bg: 'rgba(245, 158, 11, 0.15)' },
  { id: 'blank', label: 'Blank / Control', icon: '🔘', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.1)' },
];

export const ElnView: React.FC = () => {
  const { state, setState, setPath, run, rowsCache, triMeta, tlcSets, setView, toast } = useApp();

  const [activePlate, setActivePlate] = useState<number>(0);
  const [selectedWellIdx, setSelectedWellIdx] = useState<number>(0);
  const [viewMode, setViewMode] = useState<'observations' | 'recipes'>('observations');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [batchSelection, setBatchSelection] = useState<number[]>([]);
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [scaleUpScaleMmol, setScaleUpScaleMmol] = useState<number>(1.0);

  // Safely get or initialize ELN record
  const eln: HteElnRecord = useMemo(() => {
    return state.eln || {
      campaignTitle: state.name || '',
      objective: '',
      reactionClass: 'Cross-Coupling',
      temperatureC: 25,
      reactionTimeHours: 16,
      atmosphere: 'N2 Glovebox',
      agitation: 'Tumble stirrer 800 rpm',
      illumination: 'None',
      plateSealType: 'Teflon silicone bonded mat',
      postReactionNotes: '',
      wells: {},
      scaleUpMmol: 1.0,
    };
  }, [state.eln, state.name]);

  const numPlates = run?.plates || Math.max(1, Math.ceil(rowsCache.length / PLATE_SIZE));

  // Helper to update top-level ELN fields
  const updateEln = (patch: Partial<HteElnRecord>) => {
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.eln = { ...(next.eln || {}), ...patch };
      return next;
    });
  };

  // Helper to update a well's observation
  const updateWell = (pIdx: number, wIdx: number, patch: Partial<WellObservation>) => {
    const key = `${pIdx}-${wIdx}`;
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const curWells = next.eln?.wells || {};
      const cur = curWells[key] || { wellIndex: wIdx, plateIndex: pIdx, status: 'none', tags: [] };
      curWells[key] = { ...cur, ...patch };
      next.eln = { ...(next.eln || {}), wells: curWells };
      return next;
    });
  };

  // Helper to batch update selected wells
  const applyBatchObservation = (tag: string) => {
    if (!batchSelection.length) {
      toast('Select at least one well first.');
      return;
    }
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const curWells = next.eln?.wells || {};
      batchSelection.forEach((wIdx) => {
        const key = `${activePlate}-${wIdx}`;
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: activePlate, status: 'none', tags: [] };
        const tags = cur.tags ? [...cur.tags] : [];
        if (!tags.includes(tag)) tags.push(tag);
        curWells[key] = { ...cur, tags };
      });
      next.eln = { ...(next.eln || {}), wells: curWells };
      return next;
    });
    toast(`Tagged ${batchSelection.length} well(s) as ${tag.replace('_', ' ')}.`);
  };

  const applyBatchStatus = (status: WellOutcomeStatus) => {
    if (!batchSelection.length) {
      toast('Select at least one well first.');
      return;
    }
    setState((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      const curWells = next.eln?.wells || {};
      batchSelection.forEach((wIdx) => {
        const key = `${activePlate}-${wIdx}`;
        const cur = curWells[key] || { wellIndex: wIdx, plateIndex: activePlate, status: 'none', tags: [] };
        curWells[key] = { ...cur, status };
      });
      next.eln = { ...(next.eln || {}), wells: curWells };
      return next;
    });
    toast(`Set outcome to ${status} for ${batchSelection.length} well(s).`);
  };

  // Current selected well data
  const currentGlobalIdx = activePlate * PLATE_SIZE + selectedWellIdx;
  const currentWellKey = `${activePlate}-${selectedWellIdx}`;
  const currentWellObs: WellObservation = (eln.wells && eln.wells[currentWellKey]) || {
    wellIndex: selectedWellIdx,
    plateIndex: activePlate,
    status: 'none',
    tags: [],
    notes: '',
  };

  const currentRunRow = run && run.rows ? run.rows[currentGlobalIdx] : null;
  const currentRecipe: RecipeItem[] = currentRunRow ? currentRunRow.recipe : [];
  const currentLabel = currentRunRow?.label || (triMeta && triMeta[currentGlobalIdx] ? {
    name: triMeta[currentGlobalIdx].blank ? 'blank (solvent only)' : `${triMeta[currentGlobalIdx].group || 'Well'}`,
    cond: `Plate ${activePlate + 1}, Well ${selectedWellIdx + 1} | section ${triMeta[currentGlobalIdx].section}`,
  } : null);

  // TLC correlation data for active well
  const activeTlcSet = tlcSets && (tlcSets[activePlate] || tlcSets[0]);
  const activeTlcLane = activeTlcSet?.cfg?.lanes?.find((l) => l.id === selectedWellIdx || l.id === selectedWellIdx + 1);

  // Statistics across the current plate or entire campaign
  const stats = useMemo(() => {
    const allWells = Object.values(eln.wells || {});
    const hits = allWells.filter((w) => w.status === 'hit').length;
    const clean = allWells.filter((w) => w.status === 'clean').length;
    const partial = allWells.filter((w) => w.status === 'partial').length;
    const poly = allWells.filter((w) => w.tags?.includes('polymerized')).length;
    const precip = allWells.filter((w) => w.tags?.includes('precipitated')).length;
    const volLoss = allWells.filter((w) => w.tags?.includes('volume_decreased') || w.tags?.includes('gas_evolution')).length;
    const withNotes = allWells.filter((w) => (w.notes || '').trim().length > 0).length;
    return { hits, clean, partial, poly, precip, volLoss, withNotes, totalObs: allWells.length };
  }, [eln.wells]);

  // Scale-up calculation for the selected well (or designated hit well)
  const scaleUpHitWellIdx = eln.selectedHitWell != null ? eln.selectedHitWell : currentGlobalIdx;
  const scaleUpRow = run?.rows?.[scaleUpHitWellIdx] || null;
  const scaleUpRecipe = scaleUpRow?.recipe || [];

  const scaleUpCalculations = useMemo(() => {
    if (!scaleUpRecipe.length) return null;
    // Base scale is calculated relative to 1st non-solvent reagent with non-zero concentration
    const activeComponents = scaleUpRecipe.filter((r) => r.target_concentration > 0);
    if (!activeComponents.length) return null;

    const baseComponent = activeComponents[0];
    const baseMm = baseComponent.target_concentration; // in mM = mmol/L

    return activeComponents.map((item) => {
      const equiv = baseMm > 0 ? item.target_concentration / baseMm : 1;
      const targetMmol = scaleUpScaleMmol * equiv;
      const mw = Number(item.molarMass) || 0;
      const massG = mw > 0 ? (targetMmol * mw) / 1000 : null;
      const density = Number(item.chemicalDensity) || 0;
      const volMl = density > 0 && massG != null ? massG / density : null;

      return {
        code: item.code,
        name: item.name || item.code,
        target_concentration: item.target_concentration,
        equiv: Math.round(equiv * 1000) / 1000,
        targetMmol: Math.round(targetMmol * 1000) / 1000,
        mw,
        massG: massG != null ? Math.round(massG * 1000) / 1000 : null,
        volMl: volMl != null ? Math.round(volMl * 1000) / 1000 : null,
      };
    });
  }, [scaleUpRecipe, scaleUpScaleMmol]);

  // Generate synthetic procedure write-up
  const generatedProcedure = useMemo(() => {
    if (!scaleUpCalculations || !scaleUpCalculations.length) return '';
    const solids = scaleUpCalculations.filter((c) => c.massG != null && (!c.volMl || c.volMl < 0.2));
    const liquids = scaleUpCalculations.filter((c) => c.volMl != null && c.volMl >= 0.2);
    const solv = state.reactionSolvent || 'solvent';
    const temp = eln.temperatureC ? `${eln.temperatureC} °C` : 'room temperature';
    const time = eln.reactionTimeHours ? `${eln.reactionTimeHours} h` : '16 h';
    const atm = eln.atmosphere || 'inert atmosphere';

    let txt = `Bench Scale Procedure (${scaleUpScaleMmol} mmol scale):\n\n`;
    txt += `An oven-dried reaction vial equipped with a magnetic stir bar was charged with `;
    txt += solids.map((s) => `${s.name} (${s.massG} g, ${s.targetMmol} mmol, ${s.equiv} eq)`).join(', ');
    if (liquids.length) {
      txt += ` followed by ${liquids.map((l) => `${l.name} (${l.volMl} mL, ${l.targetMmol} mmol, ${l.equiv} eq)`).join(', ')}`;
    }
    const estSolvVolume = Math.round((scaleUpScaleMmol / 0.1) * 10) / 10; // ~0.1 M concentration
    txt += ` and anhydrous ${solv} (~${estSolvVolume} mL) under a ${atm}. `;
    txt += `The vial was sealed with a ${eln.plateSealType || 'septum cap'} and stirred at ${temp} for ${time}. `;

    // Include observed physical caveats from HTE
    const hitObs = eln.wells[`${Math.floor(scaleUpHitWellIdx / PLATE_SIZE)}-${scaleUpHitWellIdx % PLATE_SIZE}`];
    if (hitObs?.notes) {
      txt += `\n\n[HTE Screen Observation]: "${hitObs.notes}"`;
    }
    if (hitObs?.tags?.includes('polymerized')) {
      txt += `\n[HTE Caution]: Polymerization was observed under some related screen conditions; monitor stirring and avoid overheating.`;
    }
    if (hitObs?.tags?.includes('precipitated')) {
      txt += `\n[HTE Caution]: Precipitate formed during reaction. Ensure efficient agitation.`;
    }
    if (hitObs?.tags?.includes('gas_evolution')) {
      txt += `\n[HTE Caution]: Gas evolution noted; ensure adequate pressure venting.`;
    }

    return txt;
  }, [scaleUpCalculations, scaleUpScaleMmol, state.reactionSolvent, eln, scaleUpHitWellIdx]);

  // Aggregated data for AI Synthesis Report
  const aiReportData = useMemo(() => {
    const totalWells = rowsCache.length || 54;
    let hits = 0;
    let moderate = 0;
    let low = 0;
    let failed = 0;

    const topHitsList: any[] = [];
    const problemWellsList: any[] = [];

    const wellEntries = Object.entries(eln.wells || {});
    wellEntries.forEach(([key, obs]) => {
      const [pStr, wStr] = key.split('-');
      const pIdx = parseInt(pStr, 10);
      const wIdx = parseInt(wStr, 10);
      const globalIdx = pIdx * PLATE_SIZE + wIdx;
      const rowData = run?.rows ? run.rows[globalIdx] : null;
      const recipeStr = (rowData && 'recipe' in rowData ? (rowData as any).recipe : '') || `Plate ${pIdx + 1} Well ${wIdx + 1}`;
      const conv =
        obs.conversion ??
        (obs.status === 'hit' ? 95 : obs.status === 'clean' ? 85 : undefined);

      if (obs.status === 'hit' || (conv !== undefined && conv >= 75)) {
        hits++;
        if (topHitsList.length < 8) {
          topHitsList.push({
            well: `P${pIdx + 1}_${ROW_LETTERS[Math.floor(wIdx / COLS)]}${(wIdx % COLS) + 1}`,
            recipe: recipeStr,
            conversion: conv ?? undefined,
            yield: obs.yield ?? undefined,
            notes: obs.notes,
          });
        }
      } else if (obs.status === 'partial' || (conv !== undefined && conv >= 30 && conv < 75)) {
        moderate++;
      } else if (obs.status === 'sm_only' || (conv !== undefined && conv < 30)) {
        low++;
      } else if (
        obs.status === 'decomp' ||
        obs.status === 'precipitate' ||
        obs.tags?.includes('polymerized')
      ) {
        failed++;
        if (problemWellsList.length < 8) {
          problemWellsList.push({
            well: `P${pIdx + 1}_${ROW_LETTERS[Math.floor(wIdx / COLS)]}${(wIdx % COLS) + 1}`,
            recipe: recipeStr,
            notes: obs.notes || obs.tags?.join(', '),
          });
        }
      }
    });

    return {
      wellStats: {
        total: totalWells,
        hits,
        moderate,
        low,
        failed,
      },
      topHits: topHitsList,
      problemWells: problemWellsList,
    };
  }, [rowsCache, run, eln.wells]);

  return (
    <div className="wrap" style={{ maxWidth: '1360px', margin: '0 auto', padding: '16px 20px 80px' }}>
      {/* Campaign Header Card */}
      <div className="card pad" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px' }}>
          <div style={{ flex: '1 1 400px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                HTE Electronic Lab Notebook
              </h1>
              <span style={{ color: 'var(--mut)', fontSize: '12px' }}>
                · {run?.reactions || rowsCache.length || 54} Wells · {numPlates} Plate{numPlates === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="f"
                style={{ fontWeight: 600, fontSize: '14px', flex: '1 1 260px' }}
                placeholder="Campaign Title (e.g. Buchwald Ligand & Base 54-Well Screen)"
                value={eln.campaignTitle || ''}
                onChange={(e) => updateEln({ campaignTitle: e.target.value })}
              />
              <input
                type="text"
                className="f"
                style={{ flex: '1 1 200px' }}
                placeholder="Reaction Class (e.g. Photoredox, C-N Coupling)"
                value={eln.reactionClass || ''}
                onChange={(e) => updateEln({ reactionClass: e.target.value })}
              />
            </div>
            <textarea
              className="f"
              rows={2}
              style={{ marginTop: '8px', width: '100%', resize: 'vertical', fontSize: '12px' }}
              placeholder="Campaign Objective & Hypothesis (e.g. Test 6 phosphine ligands vs 3 inorganic bases to overcome low conversion on chloropyridine substrate)..."
              value={eln.objective || ''}
              onChange={(e) => updateEln({ objective: e.target.value })}
            />
          </div>

          {/* Quick Statistics Banner */}
          <div
            style={{
              display: 'flex',
              gap: '14px',
              flexWrap: 'wrap',
              background: 'var(--soft)',
              padding: '10px 18px',
              borderRadius: '9px',
              border: '1px solid var(--line)',
            }}
          >
            <div style={{ textAlign: 'center', minWidth: '60px' }}>
              <div style={{ fontSize: '19px', fontWeight: 700, fontFamily: 'monospace', color: '#059669' }}>{stats.hits}</div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Hits</div>
            </div>
            <div style={{ width: '1px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '60px' }}>
              <div style={{ fontSize: '19px', fontWeight: 700, fontFamily: 'monospace', color: '#10b981' }}>{stats.clean}</div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Clean</div>
            </div>
            <div style={{ width: '1px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '60px' }}>
              <div style={{ fontSize: '19px', fontWeight: 700, fontFamily: 'monospace', color: '#8b5cf6' }}>{stats.poly}</div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Polymer</div>
            </div>
            <div style={{ width: '1px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '60px' }}>
              <div style={{ fontSize: '19px', fontWeight: 700, fontFamily: 'monospace', color: '#d97706' }}>{stats.precip}</div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Precip</div>
            </div>
            <div style={{ width: '1px', background: 'var(--line)' }} />
            <div style={{ textAlign: 'center', minWidth: '60px' }}>
              <div style={{ fontSize: '19px', fontWeight: 700, fontFamily: 'monospace', color: '#0284c7' }}>{stats.volLoss}</div>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Vol Loss</div>
            </div>
          </div>
        </div>

        {/* Reaction Execution Conditions Strip */}
        <div
          style={{
            marginTop: '12px',
            paddingTop: '10px',
            borderTop: '1px solid var(--line)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '8px',
          }}
        >
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Temp (°C)</label>
            <input
              type="number"
              className="f sm mono"
              value={eln.temperatureC ?? ''}
              placeholder="e.g. 60"
              onChange={(e) => updateEln({ temperatureC: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Heating Apparatus</label>
            <input
              type="text"
              className="f sm"
              value={eln.heatingApparatus ?? ''}
              placeholder="e.g. Al block"
              onChange={(e) => updateEln({ heatingApparatus: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Reaction Time (h)</label>
            <input
              type="number"
              className="f sm mono"
              value={eln.reactionTimeHours ?? ''}
              placeholder="e.g. 16"
              onChange={(e) => updateEln({ reactionTimeHours: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Atmosphere</label>
            <input
              type="text"
              className="f sm"
              value={eln.atmosphere ?? ''}
              placeholder="e.g. N2 Glovebox"
              onChange={(e) => updateEln({ atmosphere: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Agitation</label>
            <input
              type="text"
              className="f sm"
              value={eln.agitation ?? ''}
              placeholder="e.g. Tumble 800 rpm"
              onChange={(e) => updateEln({ agitation: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Illumination</label>
            <input
              type="text"
              className="f sm"
              value={eln.illumination ?? ''}
              placeholder="e.g. Blue LED 450nm"
              onChange={(e) => updateEln({ illumination: e.target.value })}
            />
          </div>
          <div>
            <label className="lbl" style={{ fontSize: '10px' }}>Plate Seal</label>
            <input
              type="text"
              className="f sm"
              value={eln.plateSealType ?? ''}
              placeholder="e.g. Teflon mat"
              onChange={(e) => updateEln({ plateSealType: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Main Grid & Well Inspector Columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: '16px', alignItems: 'start' }}>
        {/* Left Column: 54-Well Hit & Observation Matrix */}
        <div className="card pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="ct">54-Well Plate Matrix</div>
              {numPlates > 1 && (
                <div className="seg" role="group" aria-label="Plate selection">
                  {Array.from({ length: numPlates }).map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={activePlate === i ? 'on' : ''}
                      onClick={() => {
                        setActivePlate(i);
                        setBatchSelection([]);
                      }}
                    >
                      Plate {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Display toggle & batch mode */}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                type="button"
                className={`btn sm ${batchMode ? 'on' : ''}`}
                style={{ background: batchMode ? 'var(--acc)' : 'transparent', color: batchMode ? 'var(--acc-fg)' : 'inherit' }}
                onClick={() => {
                  setBatchMode(!batchMode);
                  if (batchMode) setBatchSelection([]);
                }}
                title="Enable multi-well selection to tag physical observations (polymerized, precipitated) in batch"
              >
                {batchMode ? '✓ Batch Mode On' : '☑ Batch Select'}
              </button>
              <div className="seg">
                <button
                  type="button"
                  className={viewMode === 'observations' ? 'on' : ''}
                  onClick={() => setViewMode('observations')}
                >
                  Observations
                </button>
                <button
                  type="button"
                  className={viewMode === 'recipes' ? 'on' : ''}
                  onClick={() => setViewMode('recipes')}
                >
                  Recipe / mM
                </button>
              </div>
            </div>
          </div>

          {/* Quick Filter Strip */}
          <div style={{ display: 'flex', gap: '5px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '10px' }}>
            <button
              type="button"
              className={`pill ${tagFilter === 'all' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'all' ? 'var(--fg)' : 'var(--soft)', color: tagFilter === 'all' ? 'var(--panel)' : 'inherit' }}
              onClick={() => setTagFilter('all')}
            >
              All Wells (54)
            </button>
            <button
              type="button"
              className={`pill ${tagFilter === 'hit' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'hit' ? '#059669' : 'var(--soft)', color: tagFilter === 'hit' ? '#fff' : 'inherit' }}
              onClick={() => setTagFilter('hit')}
            >
              Top Hits
            </button>
            <button
              type="button"
              className={`pill ${tagFilter === 'polymerized' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'polymerized' ? '#8b5cf6' : 'var(--soft)', color: tagFilter === 'polymerized' ? '#fff' : 'inherit' }}
              onClick={() => setTagFilter('polymerized')}
            >
              Polymerized
            </button>
            <button
              type="button"
              className={`pill ${tagFilter === 'precipitated' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'precipitated' ? '#d97706' : 'var(--soft)', color: tagFilter === 'precipitated' ? '#fff' : 'inherit' }}
              onClick={() => setTagFilter('precipitated')}
            >
              Precipitated
            </button>
            <button
              type="button"
              className={`pill ${tagFilter === 'volume_decreased' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'volume_decreased' ? '#0284c7' : 'var(--soft)', color: tagFilter === 'volume_decreased' ? '#fff' : 'inherit' }}
              onClick={() => setTagFilter('volume_decreased')}
            >
              Volume Loss
            </button>
            <button
              type="button"
              className={`pill ${tagFilter === 'has_notes' ? 'on' : ''}`}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: tagFilter === 'has_notes' ? 'var(--acc)' : 'var(--soft)', color: tagFilter === 'has_notes' ? '#fff' : 'inherit' }}
              onClick={() => setTagFilter('has_notes')}
            >
              With Notes
            </button>
          </div>

          {/* Batch Action Toolbar when Batch Mode is active */}
          {batchMode && (
            <div
              style={{
                marginBottom: '10px',
                padding: '8px 12px',
                background: 'var(--soft)',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                border: '1px dashed var(--line)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600 }}>
                {batchSelection.length} well{batchSelection.length === 1 ? '' : 's'} selected:
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: '#8b5cf6', color: '#fff', fontSize: '11px' }}
                  onClick={() => applyBatchObservation('polymerized')}
                >
                  Tag Polymerized
                </button>
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: '#d97706', color: '#fff', fontSize: '11px' }}
                  onClick={() => applyBatchObservation('precipitated')}
                >
                  Tag Precipitated
                </button>
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: '#0284c7', color: '#fff', fontSize: '11px' }}
                  onClick={() => applyBatchObservation('volume_decreased')}
                >
                  Tag Volume Loss
                </button>
                <button
                  type="button"
                  className="btn sm"
                  style={{ background: '#059669', color: '#fff', fontSize: '11px' }}
                  onClick={() => applyBatchStatus('hit')}
                >
                  Mark as Hits
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    const all54 = Array.from({ length: PLATE_SIZE }, (_, i) => i);
                    setBatchSelection(batchSelection.length === 54 ? [] : all54);
                  }}
                >
                  {batchSelection.length === 54 ? 'Deselect All' : 'Select All 54'}
                </button>
              </div>
            </div>
          )}

          {/* 6x9 Plate Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '24px repeat(9, 1fr)',
              gap: '4px',
              userSelect: 'none',
            }}
          >
            {/* Column Headers 1..9 */}
            <div />
            {Array.from({ length: COLS }).map((_, c) => (
              <div key={c} style={{ textAlign: 'center', fontSize: '11px', fontWeight: 700, color: 'var(--mut)' }}>
                {c + 1}
              </div>
            ))}

            {/* Rows A..F */}
            {Array.from({ length: ROWS }).map((_, r) => {
              const rowLetter = ROW_LETTERS[r];
              return (
                <React.Fragment key={r}>
                  {/* Row Letter Header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 700,
                      color: 'var(--mut)',
                    }}
                  >
                    {rowLetter}
                  </div>

                  {/* 9 Wells in this Row */}
                  {Array.from({ length: COLS }).map((_, c) => {
                    const wIdx = r * COLS + c;
                    const gIdx = activePlate * PLATE_SIZE + wIdx;
                    const key = `${activePlate}-${wIdx}`;
                    const obs: WellObservation = (eln.wells && eln.wells[key]) || {
                      wellIndex: wIdx,
                      plateIndex: activePlate,
                      status: 'none',
                      tags: [],
                    };

                    const rowData = run?.rows?.[gIdx];
                    const isBlank = triMeta && triMeta[gIdx]?.blank;
                    const isSelected = selectedWellIdx === wIdx;
                    const isBatchSelected = batchSelection.includes(wIdx);

                    // Filter matching
                    const matchesFilter =
                      tagFilter === 'all' ||
                      (tagFilter === 'hit' && obs.status === 'hit') ||
                      (tagFilter === 'polymerized' && obs.tags?.includes('polymerized')) ||
                      (tagFilter === 'precipitated' && obs.tags?.includes('precipitated')) ||
                      (tagFilter === 'volume_decreased' && (obs.tags?.includes('volume_decreased') || obs.tags?.includes('gas_evolution'))) ||
                      (tagFilter === 'has_notes' && Boolean((obs.notes || '').trim()));

                    // Determine styling based on outcome & tags
                    let bg = 'var(--panel)';
                    let border = isSelected ? '2px solid var(--acc)' : '1px solid var(--line)';
                    let badgeIcon = '';

                    if (obs.status === 'hit') {
                      bg = 'rgba(16, 185, 129, 0.2)';
                      border = isSelected ? '2px solid #059669' : '1px solid #10b981';
                      badgeIcon = 'HIT';
                    } else if (obs.tags?.includes('polymerized')) {
                      bg = 'rgba(139, 92, 246, 0.16)';
                      border = isSelected ? '2px solid #7c3aed' : '1px solid #8b5cf6';
                      badgeIcon = 'POLY';
                    } else if (obs.tags?.includes('precipitated')) {
                      bg = 'rgba(245, 158, 11, 0.16)';
                      border = isSelected ? '2px solid #d97706' : '1px solid #f59e0b';
                      badgeIcon = 'PPT';
                    } else if (obs.tags?.includes('volume_decreased') || obs.tags?.includes('gas_evolution')) {
                      bg = 'rgba(14, 165, 233, 0.16)';
                      border = isSelected ? '2px solid #0284c7' : '1px solid #0ea5e9';
                      badgeIcon = obs.tags?.includes('gas_evolution') ? 'GAS' : 'VOL';
                    } else if (obs.status === 'clean') {
                      bg = 'rgba(16, 185, 129, 0.1)';
                      badgeIcon = 'OK';
                    } else if (obs.status === 'decomp') {
                      bg = 'rgba(239, 68, 68, 0.12)';
                      badgeIcon = 'DEC';
                    } else if (isBlank) {
                      bg = 'var(--soft)';
                      badgeIcon = 'BLK';
                    }

                    if (isBatchSelected) {
                      border = '2px solid var(--blue)';
                    }

                    return (
                      <div
                        key={c}
                        onClick={() => {
                          if (batchMode) {
                            setBatchSelection((prev) =>
                              prev.includes(wIdx) ? prev.filter((x) => x !== wIdx) : [...prev, wIdx]
                            );
                          } else {
                            setSelectedWellIdx(wIdx);
                          }
                        }}
                        style={{
                          height: '56px',
                          borderRadius: '6px',
                          background: bg,
                          border,
                          padding: '4px',
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          position: 'relative',
                          opacity: matchesFilter ? 1 : 0.25,
                          transition: 'all 0.12s ease',
                          boxShadow: isSelected ? '0 0 0 1px var(--acc)' : 'none',
                        }}
                        title={`Well ${rowLetter}${c + 1} (#${wIdx + 1}) - Click to inspect or tag`}
                      >
                        {/* Top bar: well coord + status icon */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--mut)' }}>
                            {rowLetter}{c + 1}
                          </span>
                          <span style={{ fontSize: '11px' }}>{badgeIcon}</span>
                        </div>

                        {/* Middle content: Observations vs Recipe */}
                        {viewMode === 'observations' ? (
                          <div style={{ fontSize: '9px', lineHeight: '1.1', color: 'var(--fg)', overflow: 'hidden' }}>
                            {obs.tags && obs.tags.length > 0 ? (
                              <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
                                {obs.tags.slice(0, 2).map((t) => (
                                  <span key={t} style={{ fontSize: '8px', padding: '1px 3px', borderRadius: '3px', background: 'rgba(0,0,0,0.06)' }}>
                                    {t.replace('_', ' ')}
                                  </span>
                                ))}
                                {obs.tags.length > 2 && <span style={{ fontSize: '8px' }}>+{obs.tags.length - 2}</span>}
                              </div>
                            ) : obs.notes ? (
                              <div style={{ fontStyle: 'italic', color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                📝 {obs.notes}
                              </div>
                            ) : isBlank ? (
                              <span style={{ color: 'var(--mut)' }}>Blank</span>
                            ) : (
                              <span style={{ color: 'var(--mut)' }}>Unscored</span>
                            )}
                          </div>
                        ) : (
                          <div style={{ fontSize: '9px', lineHeight: '1.1', color: 'var(--fg)', overflow: 'hidden' }}>
                            {rowData ? (
                              <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {rowData.recipe
                                  .filter((r) => r.target_concentration > 0)
                                  .slice(0, 2)
                                  .map((r) => `${r.code} ${+r.target_concentration.toFixed(1)}`)
                                  .join(', ')}
                              </div>
                            ) : (
                              '-'
                            )}
                          </div>
                        )}

                        {/* Bottom: Conversion / Yield badge if available */}
                        {obs.conversion != null && (
                          <div style={{ fontSize: '8px', fontWeight: 700, color: '#059669', textAlign: 'right' }}>
                            {obs.conversion}% conv
                          </div>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>

          <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--mut)' }}>
            <div>Click any well to log observations, precipitate, polymerization, or gas evolution.</div>
            <div>Plate {activePlate + 1} of {numPlates}</div>
          </div>
        </div>

        {/* Right Column: Selected Well Observation Inspector */}
        <div className="card pad" style={{ borderTop: '3px solid var(--acc)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 700, color: 'var(--mut)', letterSpacing: '0.04em' }}>
                WELL INSPECTOR & OBSERVATIONS
              </div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0 0', color: 'var(--fg)' }}>
                Well {ROW_LETTERS[Math.floor(selectedWellIdx / COLS)]}{(selectedWellIdx % COLS) + 1}
                <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--mut)', marginLeft: '8px' }}>
                  (Global #{currentGlobalIdx + 1} · Plate {activePlate + 1})
                </span>
              </h2>
            </div>

            {/* Top Hit toggle */}
            <button
              type="button"
              className="btn sm"
              style={{
                background: currentWellObs.status === 'hit' ? '#059669' : 'transparent',
                color: currentWellObs.status === 'hit' ? '#fff' : 'inherit',
                border: '1px solid #059669',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
              onClick={() => {
                const nextStatus: WellOutcomeStatus = currentWellObs.status === 'hit' ? 'clean' : 'hit';
                updateWell(activePlate, selectedWellIdx, {
                  status: nextStatus,
                  scaleUpSelected: nextStatus === 'hit',
                });
                if (nextStatus === 'hit') {
                  updateEln({ selectedHitWell: currentGlobalIdx });
                  toast(`Marked Well ${ROW_LETTERS[Math.floor(selectedWellIdx / COLS)]}${(selectedWellIdx % COLS) + 1} as Top Hit!`);
                }
              }}
            >
              {currentWellObs.status === 'hit' ? 'Top Hit Selected' : 'Mark as Top Hit'}
            </button>
          </div>

          {/* Condition description & recipe badge */}
          <div style={{ padding: '8px 10px', background: 'var(--soft)', borderRadius: '6px', marginBottom: '14px', fontSize: '12px' }}>
            <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {currentLabel?.name || 'Reaction condition'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
              {currentLabel?.cond || 'Plate coordinates'}
            </div>
            {currentRecipe.length > 0 && (
              <div style={{ marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {currentRecipe.map((rec) => (
                  <span
                    key={rec.code}
                    className="pill mono"
                    style={{
                      fontSize: '10px',
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      color: rec.target_concentration > 0 ? 'var(--fg)' : 'var(--mut)',
                    }}
                  >
                    {rec.code}: <b>{rec.target_concentration} mM</b>
                    {rec.equivalence != null && ` (${rec.equivalence} eq)`}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 1. Outcome Status Picker */}
          <div style={{ marginBottom: '14px' }}>
            <label className="lbl" style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', display: 'block' }}>
              Screening Outcome / Conversion Category
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
              {OUTCOME_OPTIONS.map((opt) => {
                const isSelected = currentWellObs.status === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => updateWell(activePlate, selectedWellIdx, { status: opt.id })}
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      border: isSelected ? `2px solid ${opt.color}` : '1px solid var(--line)',
                      background: isSelected ? opt.bg : 'var(--panel)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11px',
                      fontWeight: isSelected ? 700 : 500,
                      color: isSelected ? opt.color : 'var(--fg)',
                    }}
                  >
                    <span>{opt.icon}</span>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Physical Observations Quick Chips (Polymerized, Precipitated, Volume Decreased, Gas) */}
          <div style={{ marginBottom: '14px' }}>
            <label className="lbl" style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
              <span>Physical Observations & Behaviors</span>
              <span style={{ fontSize: '10px', color: 'var(--mut)', fontWeight: 400 }}>Click chips to toggle</span>
            </label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {OBSERVATION_TAGS.map((t) => {
                const active = currentWellObs.tags?.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      const tags = currentWellObs.tags ? [...currentWellObs.tags] : [];
                      const nextTags = active ? tags.filter((x) => x !== t.id) : [...tags, t.id];
                      updateWell(activePlate, selectedWellIdx, { tags: nextTags });
                    }}
                    style={{
                      padding: '4px 8px',
                      borderRadius: '16px',
                      border: active ? `1.5px solid ${t.color}` : '1px solid var(--line)',
                      background: active ? t.color : 'var(--panel)',
                      color: active ? '#ffffff' : 'var(--fg)',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      boxShadow: active ? '0 1px 4px rgba(0,0,0,0.15)' : 'none',
                    }}
                    title={t.desc}
                  >
                    <span>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Detailed Freeform Well Notes (User Requirement Highlight) */}
          <div style={{ marginBottom: '14px' }}>
            <label className="lbl" style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', display: 'block' }}>
              Detailed Well Notes & Observations
            </label>
            <textarea
              className="f"
              rows={3}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px', lineHeight: '1.4' }}
              placeholder="e.g. Well polymerized into a rubbery solid after 2h at 60 °C; volume decreased by ~30%, possible gas conversion or leak..."
              value={currentWellObs.notes || ''}
              onChange={(e) => updateWell(activePlate, selectedWellIdx, { notes: e.target.value })}
            />
          </div>

          {/* 4. Quantitative Conversion & Color */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: '8px', marginBottom: '14px' }}>
            <div>
              <label className="lbl" style={{ fontSize: '10px' }}>% Conversion</label>
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                className="f sm mono"
                placeholder="e.g. 85"
                value={currentWellObs.conversion ?? ''}
                onChange={(e) =>
                  updateWell(activePlate, selectedWellIdx, {
                    conversion: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <label className="lbl" style={{ fontSize: '10px' }}>% Assay Yield</label>
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                className="f sm mono"
                placeholder="e.g. 72"
                value={currentWellObs.yield ?? ''}
                onChange={(e) =>
                  updateWell(activePlate, selectedWellIdx, {
                    yield: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <label className="lbl" style={{ fontSize: '10px' }}>Color Post-Reaction</label>
              <input
                type="text"
                className="f sm"
                placeholder="e.g. Amber with black solid"
                value={currentWellObs.colorAfter || ''}
                onChange={(e) => updateWell(activePlate, selectedWellIdx, { colorAfter: e.target.value })}
              />
            </div>
          </div>

          {/* 5. TLC Densitometry Bridge */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '6px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>📷</span> TLC Correlation (Lane #{selectedWellIdx + 1})
              </div>
              <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                {activeTlcLane?.customSpots?.length ? (
                  <span>
                    {activeTlcLane.customSpots.length} spot(s) picked · Main Rf:{' '}
                    {activeTlcLane.customSpots[0]?.rf?.toFixed(2) || '-'}
                  </span>
                ) : (
                  <span>No custom spots detected for this lane yet</span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => setView('tlc')}
              title="Jump to TLC view to examine spot densitometry and Rf values"
            >
              Open in TLC Map ➔
            </button>
          </div>
        </div>
      </div>

      {/* Scale-Up Calculator Section */}
      <div className="card pad" style={{ marginTop: '20px', borderTop: '3px solid #059669' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
          <div>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', fontWeight: 700, color: '#059669', letterSpacing: '0.04em' }}>
              HTE HIT TRANSLATION
            </div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '2px 0 0', color: 'var(--fg)' }}>
              Scale-Up Recipe Calculator (HTE Well ➔ Bench Scale)
            </h2>
            <p className="sub" style={{ margin: '2px 0 0' }}>
              Translates the winning micro-scale conditions from Well #{scaleUpHitWellIdx + 1} into grams and milliliters for analytical flask synthesis.
            </p>
          </div>

          {/* Target scale selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>Target Scale:</span>
            <div className="seg">
              {[0.5, 1.0, 2.0, 5.0, 10.0].map((sc) => (
                <button
                  key={sc}
                  type="button"
                  className={scaleUpScaleMmol === sc ? 'on' : ''}
                  onClick={() => setScaleUpScaleMmol(sc)}
                >
                  {sc} mmol
                </button>
              ))}
            </div>
          </div>
        </div>

        {scaleUpCalculations && scaleUpCalculations.length > 0 ? (
          <div>
            {/* Reagents Table */}
            <div className="tbl" style={{ marginBottom: '16px' }}>
              <table>
                <thead>
                  <tr>
                    <th>Reagent</th>
                    <th>Screen conc (mM)</th>
                    <th>Equiv (eq)</th>
                    <th>Scale (mmol)</th>
                    <th>MW (g/mol)</th>
                    <th>Mass to weigh (g / mg)</th>
                    <th>Liquid Vol (mL)</th>
                  </tr>
                </thead>
                <tbody>
                  {scaleUpCalculations.map((c) => (
                    <tr key={c.code}>
                      <td>
                        <b>{c.name}</b> <span className="mono" style={{ color: 'var(--mut)' }}>({c.code})</span>
                      </td>
                      <td className="mono">{c.target_concentration} mM</td>
                      <td className="mono">{c.equiv} eq</td>
                      <td className="mono"><b>{c.targetMmol} mmol</b></td>
                      <td className="mono">{c.mw > 0 ? c.mw : '-'}</td>
                      <td className="mono">
                        {c.massG != null ? (
                          <b>{c.massG >= 1 ? `${c.massG.toFixed(3)} g` : `${(c.massG * 1000).toFixed(1)} mg`}</b>
                        ) : (
                          <span style={{ color: 'var(--mut)' }}>Missing MW</span>
                        )}
                      </td>
                      <td className="mono">
                        {c.volMl != null ? (
                          `${c.volMl >= 1 ? c.volMl.toFixed(2) + ' mL' : (c.volMl * 1000).toFixed(0) + ' µL'}`
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Generated Synthetic Writeup */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label className="lbl" style={{ margin: 0, fontSize: '11px', fontWeight: 600 }}>
                  Generated Experimental Procedure (Ready for Laboratory Notebook / SI)
                </label>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    navigator.clipboard.writeText(generatedProcedure);
                    toast('Copied experimental procedure to clipboard!');
                  }}
                >
                  📋 Copy Procedure
                </button>
              </div>
              <textarea
                className="f mono"
                rows={5}
                readOnly
                style={{ width: '100%', fontSize: '12px', lineHeight: '1.5', background: 'var(--soft)' }}
                value={generatedProcedure}
              />
            </div>
          </div>
        ) : (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--mut)', background: 'var(--soft)', borderRadius: '6px' }}>
            Select a well with an active reaction recipe above to calculate bench scale-up reagents.
          </div>
        )}
      </div>

      {/* AI Synthesis & Campaign Executive Report (Option 5) */}
      <AiSynthesisReport
        campaignTitle={eln.campaignTitle}
        reactionClass={eln.reactionClass}
        objective={eln.objective}
        postReactionNotes={eln.postReactionNotes}
        reagents={state.reagents}
        wellStats={aiReportData.wellStats}
        topHits={aiReportData.topHits}
        problemWells={aiReportData.problemWells}
        onAppendNotes={(text) => {
          updateEln({
            postReactionNotes: (eln.postReactionNotes ? eln.postReactionNotes + '\n\n' : '') + text,
          });
          toast('Appended AI Synthesis Report to Campaign Notes.');
        }}
        onReplaceNotes={(text) => {
          updateEln({ postReactionNotes: text });
          toast('Updated Campaign Notes with AI Synthesis Report.');
        }}
      />

      {/* Campaign Post-Reaction Summary Notes */}
      <div className="card pad" style={{ marginTop: '20px' }}>
        <div className="chead">
          <div className="ct">Campaign Post-Reaction Observations & Synthesis Notes</div>
          <button
            type="button"
            className="btn sm"
            onClick={() => window.print()}
            title="Print or export a PDF summary report of this HTE screen"
          >
            🖨️ Print / Export ELN Report
          </button>
        </div>
        <textarea
          className="f"
          rows={3}
          style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
          placeholder="Overall campaign conclusions: e.g. Ligands L1 and L2 showed complete conversion across all 3 bases; base B3 caused severe polymerization at 60 °C; volume loss occurred in corner wells A1 and F9 due to edge seal relaxation..."
          value={eln.postReactionNotes || ''}
          onChange={(e) => updateEln({ postReactionNotes: e.target.value })}
        />
      </div>
    </div>
  );
};
