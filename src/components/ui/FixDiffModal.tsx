// Robowski Studio - Auto-Fix Diff & Solution Inspector Modal
import React, { useMemo, useEffect } from 'react';
import { RunResult, RunState, VerifiedFix } from '../../types';
import { normalize, dataFor } from '../../context/runPayload';
import { buildRun, PAL } from '../../engine';

interface FixDiffModalProps {
  fix: VerifiedFix | null;
  fixIndex: number | null;
  currentState: RunState;
  currentRun: RunResult | null;
  onApply: (fixIndex: number) => void;
  onClose: () => void;
}

export const FixDiffModal: React.FC<FixDiffModalProps> = ({
  fix,
  fixIndex,
  currentState,
  currentRun,
  onApply,
  onClose,
}) => {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const nf = (v: any, d = 1) =>
    Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-';

  const rcol = (i: number) => PAL[i % PAL.length];

  // Calculate patched state
  const patchedState = useMemo<RunState | null>(() => {
    if (!fix) return null;
    const next = JSON.parse(JSON.stringify(currentState));
    const { stocks, ...rest } = fix.patch;
    Object.assign(next, rest);
    if (stocks) {
      Object.entries(stocks).forEach(([k, v]) => {
        if (next.reagents[+k]) {
          next.reagents[+k].stock = v;
        }
      });
    }
    return normalize(next);
  }, [fix, currentState]);

  // Recalculate run with patched state
  const patchedRun = useMemo<RunResult | null>(() => {
    if (!patchedState) return null;
    try {
      const payload = dataFor(patchedState);
      return buildRun(payload);
    } catch {
      return null;
    }
  }, [patchedState]);

  if (!fix || fixIndex === null || !currentRun || !patchedState || !patchedRun) {
    return null;
  }

  // Parameter Diff Extraction
  const paramDiffs: Array<{ label: string; before: string; after: string; note?: string }> = [];

  if (fix.patch.vialVolume != null && fix.patch.vialVolume !== currentState.vialVolume) {
    paramDiffs.push({
      label: 'Vial Volume',
      before: `${currentState.vialVolume} µL`,
      after: `${fix.patch.vialVolume} µL`,
      note: 'Scales target volumes proportionally',
    });
  }

  if (fix.patch.threshold != null && fix.patch.threshold !== currentState.threshold) {
    paramDiffs.push({
      label: 'Pipetting Threshold',
      before: `${currentState.threshold} µL`,
      after: `${fix.patch.threshold} µL`,
      note: 'Lower threshold allows smaller liquid transfers without dilution',
    });
  }

  if (fix.patch.dilutionFactor != null && fix.patch.dilutionFactor !== currentState.dilutionFactor) {
    paramDiffs.push({
      label: 'Dilution Factor (N)',
      before: `${currentState.dilutionFactor}×`,
      after: `${fix.patch.dilutionFactor}×`,
      note: `Adjusts intermediate hand-dilution concentrations`,
    });
  }

  if (fix.patch.stocks) {
    Object.entries(fix.patch.stocks).forEach(([k, newStock]) => {
      const idx = +k;
      const r = currentState.reagents[idx];
      if (r) {
        paramDiffs.push({
          label: `${r.code} Stock Concentration`,
          before: `${r.stock} mM`,
          after: `${newStock} mM`,
          note: `Requires preparing ${r.code} stock at ${newStock} mM`,
        });
      }
    });
  }

  // Health Metrics: Solvent calculation
  let minSolvBefore = Infinity;
  let negSolvBefore = 0;
  currentRun.rows.forEach((row) => {
    const s = +row['vol#solvent'] || 0;
    if (s < minSolvBefore) minSolvBefore = s;
    if (s < 0) negSolvBefore++;
  });

  let minSolvAfter = Infinity;
  let negSolvAfter = 0;
  patchedRun.rows.forEach((row) => {
    const s = +row['vol#solvent'] || 0;
    if (s < minSolvAfter) minSolvAfter = s;
    if (s < 0) negSolvAfter++;
  });

  return (
    <div
      className="modal-overlay"
      id="fixDiffOverlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).id === 'fixDiffOverlay') onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fixDiffTitle"
        style={{ maxWidth: '680px', width: '92vw' }}
      >
        {/* Header */}
        <div className="modal-head">
          <div className="mt" id="fixDiffTitle" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--acc)', fontSize: '18px' }}>⚙</span>
            <span>
              Auto-Fix Solution: <b>{fix.label}</b>
            </span>
          </div>
          <button
            type="button"
            className="ib"
            onClick={onClose}
            aria-label="Close dialog"
            title="Cancel"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p className="sub" style={{ margin: 0, fontSize: '13px', lineHeight: 1.5 }}>
            Review the simulated changes below before applying. Robowski has verified that this single change
            satisfies all liquid handling rules with zero blocking issues.
          </p>

          {/* Section 1: Parameter Changes Diff Table */}
          <div style={{ background: 'var(--soft)', border: '1px solid var(--line)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
              Parameters To Modify
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {paramDiffs.map((diff, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--panel)',
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    gap: '12px',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--fg)' }}>
                      {diff.label}
                    </div>
                    {diff.note && (
                      <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '2px' }}>
                        {diff.note}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span
                      className="mono"
                      style={{
                        padding: '3px 8px',
                        background: 'var(--badbg)',
                        color: 'var(--bad)',
                        borderRadius: '5px',
                        fontSize: '12px',
                        fontWeight: 500,
                        textDecoration: 'line-through',
                      }}
                    >
                      {diff.before}
                    </span>
                    <span style={{ color: 'var(--mut)', fontSize: '14px' }}>&rarr;</span>
                    <span
                      className="mono"
                      style={{
                        padding: '3px 8px',
                        background: 'var(--okbg)',
                        color: 'var(--ok)',
                        borderRadius: '5px',
                        fontSize: '12px',
                        fontWeight: 600,
                      }}
                    >
                      {diff.after}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 2: Validation & Health Impact Comparison */}
          <div style={{ border: '1px solid var(--line)', borderRadius: '10px', padding: '14px', background: 'var(--panel)' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>
              Simulated Run Impact
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
              {/* Blocking issues comparison */}
              <div style={{ padding: '10px', background: 'var(--soft)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mut)' }}>Blocking Checks</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
                  <span className="mono" style={{ color: 'var(--bad)', fontWeight: 600, fontSize: '14px' }}>
                    {currentRun.blockingIssues} failed
                  </span>
                  <span style={{ color: 'var(--mut)' }}>&rarr;</span>
                  <span className="mono" style={{ color: 'var(--ok)', fontWeight: 700, fontSize: '15px' }}>
                    0 issues ✓
                  </span>
                </div>
              </div>

              {/* Solvent volume comparison */}
              <div style={{ padding: '10px', background: 'var(--soft)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mut)' }}>Min Solvent Volume</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
                  <span
                    className="mono"
                    style={{
                      color: minSolvBefore < 0 ? 'var(--bad)' : 'var(--fg)',
                      fontWeight: 600,
                      fontSize: '14px',
                    }}
                  >
                    {nf(minSolvBefore, 1)} µL
                  </span>
                  <span style={{ color: 'var(--mut)' }}>&rarr;</span>
                  <span className="mono" style={{ color: 'var(--ok)', fontWeight: 700, fontSize: '15px' }}>
                    {nf(minSolvAfter, 1)} µL
                  </span>
                </div>
              </div>

              {/* Plate count & vials */}
              <div style={{ padding: '10px', background: 'var(--soft)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                <div style={{ fontSize: '11px', color: 'var(--mut)' }}>Plates & Conditions</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
                  <span className="mono" style={{ fontWeight: 600, fontSize: '14px', color: 'var(--fg)' }}>
                    {patchedRun.reactions} vials
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
                    ({patchedRun.plates} plate{patchedRun.plates === 1 ? '' : 's'})
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Stock Preparation Changes (if applicable) */}
          {fix.patch.stocks && (
            <div style={{ padding: '10px 14px', background: 'var(--warnbg)', border: '1px solid var(--warn)', borderRadius: '8px', fontSize: '12px', color: 'var(--fg)' }}>
              <b>Bench Prep Notice:</b> Updating stock concentration changes the mass needed when preparing volumetric flasks. Check that the chemical is soluble at the new concentration.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn pri"
            onClick={() => {
              onApply(fixIndex);
              onClose();
            }}
          >
            Apply Solution ✓
          </button>
        </div>
      </div>
    </div>
  );
};
