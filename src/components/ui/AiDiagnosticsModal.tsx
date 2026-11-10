import React, { useState } from 'react';
import { fetchAiDiagnostics, DiagnosticsPayload } from '../../services/aiService';

interface AiDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  runName?: string;
  totalVials: number;
  vialVolume: number | string;
  threshold: number | string;
  solvent?: string;
  reagents: any[];
  issues: any[];
  deckWarnings?: any[];
}

export const AiDiagnosticsModal: React.FC<AiDiagnosticsModalProps> = ({
  isOpen,
  onClose,
  runName,
  totalVials,
  vialVolume,
  threshold,
  solvent,
  reagents,
  issues,
  deckWarnings,
}) => {
  const [advice, setAdvice] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleRunDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: DiagnosticsPayload = {
        runName,
        totalVials,
        vialVolume,
        threshold,
        solvent,
        reagents: reagents.map((r) => ({
          code: r.code,
          name: r.name,
          stock: r.stock,
          molarMass: r.molarMass,
          solvent: r.solvent,
        })),
        issues,
        deckWarnings,
      };

      const result = await fetchAiDiagnostics(payload);
      setAdvice(result);
    } catch (err: any) {
      console.error('AI Diagnostics error:', err);
      setError(
        err?.message?.includes('API key')
          ? 'Gemini API key is not configured. Please ensure GEMINI_API_KEY is available in your environment.'
          : err?.message || 'Could not analyze run constraints.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!advice) return;
    navigator.clipboard?.writeText(advice);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        className="card pad"
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: '14px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingBottom: '14px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: '15px',
              }}
            >
              ✦
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '16px', color: 'var(--fg)' }}>
                  AI Liquid Handling Diagnostics Advisor
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: 'var(--soft)',
                    color: 'var(--acc)',
                    padding: '2px 6px',
                    borderRadius: '10px',
                  }}
                >
                  Gemini
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
                Explains robot volume & stock concentration constraints and recommends quantitative fixes.
              </div>
            </div>
          </div>

          <button
            type="button"
            className="ib"
            onClick={onClose}
            aria-label="Close modal"
            style={{ fontSize: '18px' }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0', minHeight: '200px' }}>
          {/* Issue summary badge */}
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--soft)',
              borderRadius: '8px',
              border: '1px solid var(--line)',
              marginBottom: '14px',
              fontSize: '12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <b>{issues.length} Robot Issue(s) Detected</b> across {totalVials} vials (target volume {vialVolume} µL).
            </div>
            {!advice && (
              <button
                type="button"
                className="btn sm pri"
                disabled={loading}
                onClick={handleRunDiagnostics}
                style={{ fontSize: '12px', height: '28px' }}
              >
                {loading ? 'Analyzing Pipetting Math…' : '✦ Run Diagnostics'}
              </button>
            )}
          </div>

          {error && (
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--warnbg, rgba(239, 68, 68, 0.08))',
                border: '1px solid var(--warn, #ef4444)',
                borderRadius: '8px',
                fontSize: '12px',
                color: 'var(--fg)',
                marginBottom: '14px',
              }}
            >
              ⚠ {error}
            </div>
          )}

          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--mut)' }}>
              <div
                style={{
                  display: 'inline-block',
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  border: '3px solid var(--line)',
                  borderTopColor: 'var(--acc)',
                  animation: 'spin 0.8s linear infinite',
                  marginBottom: '12px',
                }}
              />
              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--fg)' }}>
                Gemini is analyzing robot constraints, dilution splits, and stock concentrations…
              </div>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>
                Evaluating physical pipette bounds (≥ {threshold} µL and &lt; 1000 µL) and solvent balance.
              </div>
            </div>
          )}

          {advice && (
            <div
              style={{
                background: 'var(--soft)',
                borderRadius: '8px',
                border: '1px solid var(--line)',
                padding: '16px',
                fontSize: '13px',
                lineHeight: '1.6',
                color: 'var(--fg)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {advice}
            </div>
          )}

          {!advice && !loading && !error && (
            <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--mut)', fontSize: '13px' }}>
              Click <b>Run Diagnostics</b> to have Gemini diagnose why this run failed robot pipetting bounds, explain solvent exhaustion, and calculate exact stock concentration solutions.
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: '14px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <div style={{ fontSize: '11px', color: 'var(--mut)' }}>
            Robowski Pipetting Physics Engine · Powered by Gemini
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {advice && (
              <button type="button" className="btn sm" onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy Advice'}
              </button>
            )}
            <button type="button" className="btn sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
