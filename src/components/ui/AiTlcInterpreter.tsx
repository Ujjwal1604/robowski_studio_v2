import React, { useState } from 'react';
import { fetchAiTlcInterpretation, TlcInterpretationPayload } from '../../services/aiService';

interface AiTlcInterpreterProps {
  laneLabel: string;
  spots: Array<{ rf: number; intensity?: number; note?: string }>;
  wellRecipe?: any;
  mobilePhase?: string;
  stain?: string;
  onSaveToElnNotes?: (text: string) => void;
}

export const AiTlcInterpreter: React.FC<AiTlcInterpreterProps> = ({
  laneLabel,
  spots,
  wellRecipe,
  mobilePhase = '30% Ethyl Acetate / 70% Hexanes',
  stain = 'UV 254 nm / KMnO4 Stain',
  onSaveToElnNotes,
}) => {
  const [interpretation, setInterpretation] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [saved, setSaved] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  const handleInterpret = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: TlcInterpretationPayload = {
        laneLabel,
        spots,
        wellRecipe,
        mobilePhase,
        stain,
      };

      const result = await fetchAiTlcInterpretation(payload);
      setInterpretation(result);
      setIsExpanded(true);
    } catch (err: any) {
      console.error('TLC interpretation error:', err);
      setError(
        err?.message?.includes('API key')
          ? 'Gemini API key is not configured. Please ensure GEMINI_API_KEY is available in your environment.'
          : err?.message || 'Could not interpret TLC lane.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!interpretation) return;
    navigator.clipboard?.writeText(interpretation);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveNotes = () => {
    if (!interpretation || !onSaveToElnNotes) return;
    onSaveToElnNotes(interpretation);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div
      style={{
        marginTop: '12px',
        padding: '14px',
        background: 'var(--soft)',
        border: '1px solid var(--line)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '6px',
              background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 'bold',
            }}
          >
            ✦
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
                AI TLC Reaction & Spot Interpreter
              </span>
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  background: 'var(--panel)',
                  color: 'var(--acc)',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  border: '1px solid var(--line)',
                }}
              >
                Gemini
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--mut)', marginTop: '1px' }}>
              Assigns product vs SM spots, estimates reaction conversion, and suggests mobile phase tweaks.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {interpretation && (
            <button
              type="button"
              className="btn sm"
              style={{ fontSize: '11px', height: '28px' }}
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? 'Hide ▲' : 'Show Interpretation ▼'}
            </button>
          )}

          <button
            type="button"
            className="btn sm pri"
            disabled={loading || spots.length === 0}
            onClick={handleInterpret}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 10px',
              fontSize: '11px',
              fontWeight: 600,
            }}
            title={spots.length === 0 ? 'Pick at least one spot first' : 'Analyze this lane with Gemini AI'}
          >
            {loading ? (
              <>
                <span
                  style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.4)',
                    borderTopColor: '#fff',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                Interpreting Spots…
              </>
            ) : (
              <>
                <span>✦</span>
                {interpretation ? 'Re-analyze Lane' : 'AI Lane Interpretation'}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--warnbg, rgba(239, 68, 68, 0.08))',
            border: '1px solid var(--warn, #ef4444)',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'var(--fg)',
          }}
        >
          ⚠ {error}
        </div>
      )}

      {/* Rendered Interpretation */}
      {interpretation && isExpanded && (
        <div style={{ marginTop: '4px' }}>
          <div
            style={{
              background: 'var(--panel)',
              borderRadius: '6px',
              border: '1px solid var(--line)',
              padding: '14px 16px',
              fontSize: '12px',
              lineHeight: '1.6',
              color: 'var(--fg)',
              maxHeight: '360px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {interpretation}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '10px',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              {onSaveToElnNotes && (
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={handleSaveNotes}
                  style={{ fontSize: '11px', height: '26px' }}
                >
                  {saved ? '✓ Saved to ELN!' : 'Save to ELN Well Notes'}
                </button>
              )}
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={handleCopy}
              style={{ fontSize: '11px', height: '26px' }}
            >
              {copied ? 'Copied!' : 'Copy Analysis'}
            </button>
          </div>
        </div>
      )}

      {!interpretation && !loading && !error && (
        <div style={{ fontSize: '11px', color: 'var(--mut)', fontStyle: 'italic' }}>
          {spots.length > 0
            ? `Analyzes ${spots.length} picked spot(s) (${spots.map((s) => `Rf ${s.rf.toFixed(2)}`).join(', ')}) against the well recipe to evaluate reaction conversion and purity.`
            : 'Click on the TLC lane to pick chromatographic spots, then run AI interpretation.'}
        </div>
      )}
    </div>
  );
};
