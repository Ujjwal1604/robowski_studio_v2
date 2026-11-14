import React, { useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FilePlus2,
  Loader2,
  Replace,
  Sparkles,
} from 'lucide-react';
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
    <div className="card" style={{ padding: '20px 22px' }}>
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
          paddingBottom: reportText ? '16px' : '0',
          borderBottom: reportText ? '1px solid var(--line2)' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'var(--accbg)',
              color: 'var(--accfg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Sparkles size={17} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: '15px', color: 'var(--fg)' }}>
              Campaign Synthesis &amp; SAR Summary
            </div>
            <div style={{ fontSize: '12.5px', color: 'var(--mut)', marginTop: '2px' }}>
              Synthesizes screening wells, reagent structures, conversion hits, and physical tags into concise SAR conclusions.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {reportText && (
            <button
              type="button"
              className="btn sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              onClick={() => setIsExpanded((v) => !v)}
              title={isExpanded ? 'Collapse report' : 'Expand report'}
            >
              {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span>{isExpanded ? 'Hide' : 'Show'}</span>
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
              gap: '7px',
              height: '34px',
              padding: '0 14px',
            }}
          >
            {loading ? (
              <>
                <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
                <span>Analyzing {wellStats.total} wells…</span>
              </>
            ) : (
              <>
                <Sparkles size={14} />
                <span>{reportText ? 'Re-analyze Campaign' : 'Generate Synthesis Report'}</span>
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
            background: 'var(--badbg)',
            border: '1px solid color-mix(in srgb, var(--bad) 25%, transparent)',
            borderRadius: '10px',
            fontSize: '12.5px',
            color: 'var(--bad)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
            <AlertTriangle size={14} />
            {error}
          </span>
          <button
            type="button"
            className="btn sm"
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
              borderRadius: '11px',
              border: '1px solid var(--line)',
              padding: '16px 18px',
              fontSize: '13.5px',
              lineHeight: '1.65',
              color: 'var(--fg)',
              maxHeight: '460px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {reportText}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginTop: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                className="btn sm pri"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                onClick={() => onAppendNotes(reportText)}
                title="Append this report to Campaign Notes below"
              >
                <FilePlus2 size={13} />
                <span>Append to Notes</span>
              </button>
              <button
                type="button"
                className="btn sm"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                onClick={() => onReplaceNotes(reportText)}
                title="Overwrite Campaign Notes with this report"
              >
                <Replace size={13} />
                <span>Replace Notes</span>
              </button>
            </div>

            <button
              type="button"
              className="btn sm"
              onClick={handleCopy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? 'Copied' : 'Copy Markdown'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Clean Empty State */}
      {!reportText && !loading && (
        <div
          style={{
            marginTop: '14px',
            padding: '14px 16px',
            background: 'var(--soft)',
            borderRadius: '11px',
            fontSize: '12.5px',
            color: 'var(--fg2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <span>
            Analyze <b>{wellStats.total} screening wells</b> and <b>{wellStats.hits} top hits</b> into structured SAR trends, yield patterns, and failure modes.
          </span>
          <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
            SAR Trends · Hit Breakdown · Failure Modes
          </span>
        </div>
      )}
    </div>
  );
};
