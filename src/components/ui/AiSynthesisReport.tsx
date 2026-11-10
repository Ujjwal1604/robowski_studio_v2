import React, { useState } from 'react';
import { fetchAiSynthesisReport, SynthesisReportPayload } from '../../services/aiService';

interface AiSynthesisReportProps {
  campaignTitle?: string;
  reactionClass?: string;
  objective?: string;
  postReactionNotes?: string;
  reagents: any[];
  wellStats: {
    total: number;
    hits: number;
    moderate: number;
    low: number;
    failed: number;
  };
  topHits: any[];
  problemWells: any[];
  onAppendNotes: (text: string) => void;
  onReplaceNotes: (text: string) => void;
}

export const AiSynthesisReport: React.FC<AiSynthesisReportProps> = ({
  campaignTitle,
  reactionClass,
  objective,
  postReactionNotes,
  reagents,
  wellStats,
  topHits,
  problemWells,
  onAppendNotes,
  onReplaceNotes,
}) => {
  const [reportText, setReportText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: SynthesisReportPayload = {
        campaignTitle,
        reactionClass,
        objective,
        postReactionNotes,
        reagents: reagents.map((r) => ({
          code: r.code,
          name: r.name,
          smiles: r.smiles,
          stock: r.stock,
          molarMass: r.molarMass,
          solvent: r.solvent,
        })),
        wellStats,
        topHits,
        problemWells,
      };

      const result = await fetchAiSynthesisReport(payload);
      setReportText(result);
      setIsExpanded(true);
    } catch (err: any) {
      console.error('Synthesis report error:', err);
      setError(
        err?.message?.includes('API key')
          ? 'Gemini API key is not configured. Please ensure GEMINI_API_KEY is available in your environment.'
          : err?.message || 'Could not generate report. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!reportText) return;
    navigator.clipboard?.writeText(reportText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div
      className="card pad"
      style={{
        marginTop: '20px',
        border: '1px solid var(--line)',
        background: 'var(--panel)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          paddingBottom: reportText ? '14px' : '0',
          borderBottom: reportText ? '1px solid var(--line)' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '15px',
              boxShadow: '0 2px 6px rgba(16, 185, 129, 0.25)',
            }}
          >
            ✦
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--fg)' }}>
                AI HTE Synthesis & Campaign Report
              </span>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  background: 'var(--soft)',
                  color: 'var(--acc)',
                  padding: '2px 7px',
                  borderRadius: '12px',
                  border: '1px solid var(--line)',
                }}
              >
                Gemini 3.8 Flash
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--mut)', marginTop: '2px' }}>
              Synthesizes screening matrix, chemical structures, conversion hits, and observations into executive SAR conclusions.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {reportText && (
            <button
              type="button"
              className="btn sm"
              style={{ fontSize: '11px', height: '30px' }}
              onClick={() => setIsExpanded((v) => !v)}
              title={isExpanded ? 'Collapse report' : 'Expand report'}
            >
              {isExpanded ? 'Hide Report ▲' : 'Show Report ▼'}
            </button>
          )}

          <button
            type="button"
            className="btn sm pri"
            disabled={loading}
            onClick={handleGenerate}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 12px',
              fontWeight: 600,
              fontSize: '12px',
            }}
          >
            {loading ? (
              <>
                <span
                  style={{
                    display: 'inline-block',
                    width: '12px',
                    height: '12px',
                    borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.4)',
                    borderTopColor: '#fff',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                Analyzing {wellStats.total} Screen Wells…
              </>
            ) : (
              <>
                <span>✦</span>
                {reportText ? 'Re-analyze Campaign' : 'Generate AI Synthesis Report'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          style={{
            marginTop: '14px',
            padding: '12px 14px',
            background: 'var(--warnbg, rgba(239, 68, 68, 0.08))',
            border: '1px solid var(--warn, #ef4444)',
            borderRadius: '8px',
            fontSize: '12px',
            color: 'var(--fg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          <span>⚠ {error}</span>
          <button
            type="button"
            className="btn sm"
            style={{ fontSize: '11px', height: '24px' }}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Generated Report Preview */}
      {reportText && isExpanded && (
        <div style={{ marginTop: '16px' }}>
          <div
            style={{
              background: 'var(--soft)',
              borderRadius: '8px',
              border: '1px solid var(--line)',
              padding: '16px 20px',
              fontSize: '13px',
              lineHeight: '1.6',
              color: 'var(--fg)',
              maxHeight: '480px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
            }}
          >
            {reportText}
          </div>

          {/* Action toolbar for report */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginTop: '12px',
              paddingTop: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className="btn sm pri"
                onClick={() => onAppendNotes(reportText)}
                title="Append this report to your Campaign Post-Reaction Observations below"
              >
                + Append to Notes
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => onReplaceNotes(reportText)}
                title="Overwrite your Campaign Post-Reaction Observations with this report"
              >
                Replace Notes
              </button>
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={handleCopy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5" />
              </svg>
              {copied ? 'Copied to Clipboard!' : 'Copy Markdown'}
            </button>
          </div>
        </div>
      )}

      {/* Empty State when no report has been generated */}
      {!reportText && !loading && (
        <div
          style={{
            marginTop: '14px',
            padding: '16px',
            background: 'var(--soft)',
            borderRadius: '8px',
            border: '1px dashed var(--line)',
            fontSize: '12px',
            color: 'var(--mut)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div>
            Click <b>Generate AI Synthesis Report</b> to have Gemini analyze your <b>{wellStats.total} screening wells</b>, correlate reagent structures with hit conversions ({wellStats.hits} top hits), extract SAR patterns, and draft ready-to-publish conclusions.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span className="mono" style={{ fontSize: '11px', background: 'var(--panel)', padding: '3px 8px', borderRadius: '4px' }}>
              ✓ SAR Trends
            </span>
            <span className="mono" style={{ fontSize: '11px', background: 'var(--panel)', padding: '3px 8px', borderRadius: '4px' }}>
              ✓ Hit Breakdown
            </span>
            <span className="mono" style={{ fontSize: '11px', background: 'var(--panel)', padding: '3px 8px', borderRadius: '4px' }}>
              ✓ Failure Modes
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
