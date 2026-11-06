import React, { useState, useEffect } from 'react';
import { Reagent } from '../../types';

interface StockCalculatorModalProps {
  reagent: Reagent;
  reagentIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onApplyStock: (index: number, stockConcMm: number, solventVolMl?: number) => void;
}

export const StockCalculatorModal: React.FC<StockCalculatorModalProps> = ({
  reagent,
  reagentIndex,
  isOpen,
  onClose,
  onApplyStock,
}) => {
  // Calculation mode:
  // 'mass' -> Given Conc + Volume -> compute Mass to weigh
  // 'volume' -> Given Mass + Conc -> compute Solvent Volume to add
  // 'conc' -> Given Mass + Volume -> compute resulting Concentration
  const [calcMode, setCalcMode] = useState<'mass' | 'volume' | 'conc'>('mass');

  const mw = +reagent.molarMass || 0;
  const dens = +reagent.density || 0;

  const [targetConc, setTargetConc] = useState<string>(
    reagent.stock ? String(reagent.stock) : '50'
  );
  const [targetVolMl, setTargetVolMl] = useState<string>('2.0');
  const [weighedMassMg, setWeighedMassMg] = useState<string>('20.0');

  useEffect(() => {
    if (reagent.stock) {
      setTargetConc(String(reagent.stock));
    }
  }, [reagent.stock]);

  if (!isOpen) return null;

  const cMm = parseFloat(targetConc) || 0;
  const vMl = parseFloat(targetVolMl) || 0;
  const mMg = parseFloat(weighedMassMg) || 0;

  // Formulae:
  // mass_mg = conc_mM * vol_mL * mw_g_per_mol
  // vol_mL = mass_mg / (conc_mM * mw)
  // conc_mM = mass_mg / (vol_mL * mw)

  let calculatedMassMg = 0;
  let calculatedVolMl = 0;
  let calculatedConcMm = 0;

  if (mw > 0) {
    if (calcMode === 'mass') {
      calculatedMassMg = cMm * vMl * mw;
    } else if (calcMode === 'volume') {
      calculatedVolMl = cMm > 0 ? mMg / (cMm * mw) : 0;
    } else if (calcMode === 'conc') {
      calculatedConcMm = vMl > 0 ? mMg / (vMl * mw) : 0;
    }
  }

  // Liquid transfer volume (µL) if density is known
  const liquidVolUl = (massMg: number) => {
    if (dens > 0 && massMg > 0) {
      return (massMg / dens); // mg / (g/mL) = µL
    }
    return null;
  };

  const handleApply = () => {
    if (calcMode === 'mass' || calcMode === 'volume') {
      onApplyStock(reagentIndex, cMm, calcMode === 'volume' ? +calculatedVolMl.toFixed(3) : +vMl);
    } else {
      onApplyStock(reagentIndex, +calculatedConcMm.toFixed(2), +vMl);
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '520px',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '14px',
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          padding: '22px',
          color: 'var(--fg)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>🧮</span>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>
                Stock Solution &amp; Mass Calculator
              </h2>
            </div>
            <p className="sub" style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--mut)' }}>
              Reagent <b>{reagent.code}</b> {reagent.name ? `(${reagent.name})` : ''} · Molar Mass:{' '}
              <b>{mw > 0 ? `${mw.toFixed(2)} g/mol` : '⚠️ Missing MW'}</b>
            </p>
          </div>
          <button
            type="button"
            className="ib"
            onClick={onClose}
            style={{ fontSize: '18px', padding: '4px 8px' }}
            aria-label="Close calculator"
          >
            ✕
          </button>
        </div>

        {/* Mode Selector Tabs */}
        <div
          style={{
            display: 'flex',
            background: 'var(--soft)',
            padding: '3px',
            borderRadius: '8px',
            gap: '4px',
            marginBottom: '16px',
            border: '1px solid var(--line)',
          }}
        >
          <button
            type="button"
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '11px',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: calcMode === 'mass' ? 'var(--panel)' : 'transparent',
              color: calcMode === 'mass' ? 'var(--pri)' : 'var(--mut)',
              boxShadow: calcMode === 'mass' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
            onClick={() => setCalcMode('mass')}
          >
            Weigh Mass (mg)
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '11px',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: calcMode === 'volume' ? 'var(--panel)' : 'transparent',
              color: calcMode === 'volume' ? 'var(--pri)' : 'var(--mut)',
              boxShadow: calcMode === 'volume' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
            onClick={() => setCalcMode('volume')}
          >
            Solvent Vol (mL)
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '11px',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: calcMode === 'conc' ? 'var(--panel)' : 'transparent',
              color: calcMode === 'conc' ? 'var(--pri)' : 'var(--mut)',
              boxShadow: calcMode === 'conc' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
            onClick={() => setCalcMode('conc')}
          >
            Compute Conc (mM)
          </button>
        </div>

        {/* Missing MW Warning */}
        {mw <= 0 && (
          <div className="chip bad" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px', fontSize: '12px' }}>
            <span>⚠️</span>
            <span>Please enter a valid molar mass (g/mol) on Setup to compute stoichiometry.</span>
          </div>
        )}

        {/* Inputs based on Mode */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '18px' }}>
          {calcMode === 'mass' && (
            <>
              <div style={{ display: 'flex', gap: '12px' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Target Concentration (mM):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={targetConc}
                    onChange={(e) => setTargetConc(e.target.value)}
                    placeholder="e.g. 50"
                  />
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Stock Vial Volume (mL):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={targetVolMl}
                    onChange={(e) => setTargetVolMl(e.target.value)}
                    placeholder="e.g. 2.0"
                  />
                </label>
              </div>

              {/* Calculated Result Box */}
              <div
                style={{
                  background: 'var(--soft)',
                  border: '1px solid #10b981',
                  borderRadius: '10px',
                  padding: '12px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Mass to Weigh
                  </div>
                  <div className="mono" style={{ fontSize: '22px', fontWeight: 800, color: '#10b981' }}>
                    {mw > 0 ? `${calculatedMassMg.toFixed(2)} mg` : '—'}
                  </div>
                  {dens > 0 && (
                    <div style={{ fontSize: '11px', color: '#06b6d4', marginTop: '2px' }}>
                      Liquid pipette: <b>{liquidVolUl(calculatedMassMg)?.toFixed(1)} µL</b> (density {dens} g/mL)
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--mut)', textAlign: 'right', maxWidth: '180px' }}>
                  Dissolve in <b>{targetVolMl} mL</b> of {reagent.solvent || 'solvent'} to reach <b>{targetConc} mM</b>.
                </div>
              </div>
            </>
          )}

          {calcMode === 'volume' && (
            <>
              <div style={{ display: 'flex', gap: '12px' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Available Mass Weighed (mg):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={weighedMassMg}
                    onChange={(e) => setWeighedMassMg(e.target.value)}
                    placeholder="e.g. 15.4"
                  />
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Desired Concentration (mM):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={targetConc}
                    onChange={(e) => setTargetConc(e.target.value)}
                    placeholder="e.g. 50"
                  />
                </label>
              </div>

              {/* Calculated Result Box */}
              <div
                style={{
                  background: 'var(--soft)',
                  border: '1px solid #38bdf8',
                  borderRadius: '10px',
                  padding: '12px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Solvent Volume to Add
                  </div>
                  <div className="mono" style={{ fontSize: '22px', fontWeight: 800, color: '#38bdf8' }}>
                    {mw > 0 && cMm > 0 ? `${calculatedVolMl.toFixed(3)} mL` : '—'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                    (= <b>{(calculatedVolMl * 1000).toFixed(0)} µL</b>)
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--mut)', textAlign: 'right', maxWidth: '180px' }}>
                  Adding this volume to <b>{weighedMassMg} mg</b> yields exactly <b>{targetConc} mM</b>.
                </div>
              </div>
            </>
          )}

          {calcMode === 'conc' && (
            <>
              <div style={{ display: 'flex', gap: '12px' }}>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Mass Weighed (mg):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={weighedMassMg}
                    onChange={(e) => setWeighedMassMg(e.target.value)}
                    placeholder="e.g. 24.5"
                  />
                </label>
                <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 600 }}>Volume Dissolved Into (mL):</span>
                  <input
                    type="number"
                    step="any"
                    className="f mono"
                    value={targetVolMl}
                    onChange={(e) => setTargetVolMl(e.target.value)}
                    placeholder="e.g. 2.0"
                  />
                </label>
              </div>

              {/* Calculated Result Box */}
              <div
                style={{
                  background: 'var(--soft)',
                  border: '1px solid #facc15',
                  borderRadius: '10px',
                  padding: '12px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Resulting Stock Concentration
                  </div>
                  <div className="mono" style={{ fontSize: '22px', fontWeight: 800, color: '#facc15' }}>
                    {mw > 0 && vMl > 0 ? `${calculatedConcMm.toFixed(2)} mM` : '—'}
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--mut)', textAlign: 'right', maxWidth: '180px' }}>
                  Dissolving <b>{weighedMassMg} mg</b> in <b>{targetVolMl} mL</b> produces this stock.
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn sm pri"
            disabled={mw <= 0 || (calcMode === 'conc' ? calculatedConcMm <= 0 : cMm <= 0)}
            onClick={handleApply}
          >
            ✓ Apply to Stock ({calcMode === 'conc' ? `${calculatedConcMm.toFixed(1)} mM` : `${cMm} mM`})
          </button>
        </div>
      </div>
    </div>
  );
};
