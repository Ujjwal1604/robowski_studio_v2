import React, { useEffect, useMemo, useState } from 'react';
import { RunResult, RunRow, RunState } from '../../types';
import {
  WellPredictionResult,
  computeSpeciesHighlightBonds,
  extractWellForPrediction,
  getCanonicalRunConditions,
  predictWellReactions,
  wellLabel,
} from '../../engine';
import { getRDKitInstance } from '../../utils/rdkit';
import { ChemicalStructure } from './ChemicalStructure';

interface WellPredictedProductsPanelProps {
  state: RunState;
  run: RunResult | null;
  plate: number;
  wellIndex: number;
  onOpenFullPredictor: () => void;
}

export const WellPredictedProductsPanel: React.FC<WellPredictedProductsPanelProps> = ({
  state,
  run,
  plate,
  wellIndex,
  onOpenFullPredictor,
}) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WellPredictionResult | null>(null);
  const [rdkitInst, setRdkitInst] = useState<any>(null);
  const [missingCodes, setMissingCodes] = useState<string[]>([]);

  const activeRow: RunRow | undefined = useMemo(
    () =>
      run?.rows.find((r) => r.plate_number === plate && r.container_id === wellIndex) ||
      run?.rows[plate * 54 + wellIndex],
    [run, plate, wellIndex]
  );

  const wellChemSig = useMemo(() => {
    if (!activeRow) return '';
    const canon = getCanonicalRunConditions(state);
    const rSig = (state.reagents || [])
      .map((r) => `${r.code}:${r.name || ''}:${r.iupac || ''}:${r.smiles || ''}`)
      .join('|');
    const recSig = (activeRow.recipe || [])
      .filter((it) => Number(it.target_concentration) > 0)
      .map((it) => `${it.code}=${Number(it.target_concentration)}:${it.equivalence ?? ''}`)
      .join(';');
    return `${plate}-${wellIndex}::${canon.solvent}:${canon.temperatureC}:${canon.baseWaterPct}::${rSig}::${recSig}`;
  }, [activeRow, plate, wellIndex, state.reagents, state.reactionSolvent, state.temperatureC, state.waterPct, state.eln?.temperatureC, state.eln?.waterPct]);

  useEffect(() => {
    setResult(null);
    setMissingCodes([]);
  }, [wellChemSig]);

  useEffect(() => {
    if (!open || !activeRow || !wellChemSig) return;

    const ext = extractWellForPrediction(state, activeRow);
    setMissingCodes(ext.missingSmilesCodes);
    const validSubs = ext.substrates.filter((s) => s.smiles.trim().length > 0);
    if (validSubs.length === 0) {
      setResult(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getRDKitInstance()
      .then((rdkit) => {
        if (cancelled || !rdkit) return;
        setRdkitInst(rdkit);
        const pred = predictWellReactions(rdkit, validSubs, ext.condition);
        if (!cancelled) setResult(pred);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wellChemSig]);

  const highlightByKey = useMemo(() => {
    const map = new Map<string, number[]>();
    if (!rdkitInst || !result) return map;
    for (const sp of result.species.slice(0, 6)) {
      const hl = computeSpeciesHighlightBonds(rdkitInst, sp);
      if (hl.allNewBonds.length > 0) map.set(sp.key, hl.allNewBonds);
    }
    return map;
  }, [rdkitInst, result]);

  return (
    <div
      style={{
        marginTop: '10px',
        padding: '10px 14px',
        background: 'var(--soft)',
        border: '1px solid var(--line)',
        borderRadius: '8px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => setOpen((o) => !o)}
          style={{ fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <span>{open ? '▾' : '▸'}</span>
          <span>Predicted Products &amp; LC-MS Masses (Well {wellLabel(wellIndex)})</span>
        </button>

        <button
          type="button"
          className="btn sm"
          onClick={onOpenFullPredictor}
          style={{ fontSize: '11.5px', height: '26px', padding: '0 10px' }}
        >
          Open in Full Predictor →
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '10px' }}>
          {missingCodes.length > 0 && (
            <div style={{ fontSize: '12px', color: 'var(--warn)', marginBottom: '8px' }}>
              Missing SMILES for reagent{missingCodes.length > 1 ? 's' : ''}:{' '}
              <span className="mono">{missingCodes.join(', ')}</span>. Open Full Predictor or Setup to add structures.
            </div>
          )}

          {loading ? (
            <div style={{ fontSize: '12px', color: 'var(--mut)', padding: '6px 0' }}>
              Running local mechanistic prediction…
            </div>
          ) : result && result.species.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="mono" style={{ fontSize: '11.5px', color: 'var(--mut)' }}>
                {result.acidBase.effectiveMedium} · pH {result.acidBase.effectivePhDmso.toFixed(1)} ·{' '}
                {result.condition.solvent} · {result.condition.temperatureC} °C ·{' '}
                {result.condition.waterPct.toFixed(2)}% H₂O
                {(result.condition.hydrateWaterPct || 0) > 0
                  ? ` (+${(result.condition.hydrateWaterPct || 0).toFixed(2)}% hydrate)`
                  : ''}{' '}
                · Top {Math.min(6, result.species.length)} of {result.species.length}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(225px, 1fr))', gap: '10px' }}>
                {result.species.slice(0, 6).map((sp, idx) => (
                  <div
                    key={sp.key}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '10px',
                      background: 'var(--panel)',
                      border: '1px solid var(--line2)',
                      borderRadius: '9px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                      <span className="mono" style={{ fontSize: '12px', fontWeight: 700 }}>
                        #{idx + 1} · {sp.score.toFixed(2)} ({sp.tier})
                      </span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        {sp.formula}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <ChemicalStructure
                        smiles={sp.smiles}
                        name={sp.formula}
                        width={205}
                        height={138}
                        highlightBonds={highlightByKey.get(sp.key)}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: '12px', color: 'var(--acc)', fontWeight: 700 }}>
                        [M+H]⁺ {sp.mhPlus.toFixed(4)}
                      </span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        {sp.mechanismSummary}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--mut)' }}>
              {missingCodes.length > 0
                ? 'Cannot predict until missing substrate SMILES are provided.'
                : 'No reactive products predicted above threshold for this well.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
