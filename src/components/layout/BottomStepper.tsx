import React from 'react';
import { useApp } from '../../context/AppContext';

interface StepDef {
  id: string;
  label: string;
  shortDesc: string;
}

const STEPS: StepDef[] = [
  { id: 'setup', label: '1. Setup', shortDesc: 'Reagents & Ranges' },
  { id: 'combos', label: '2. Combinations', shortDesc: '54-Well Recipe Matrix' },
  { id: 'deck', label: '3. Deck Layout', shortDesc: 'Hood Positions & Tip Racks' },
  { id: 'tlc', label: '4. TLC Map', shortDesc: 'Plate Photos & Spot Densitometry' },
  { id: 'export', label: '5. Export Package', shortDesc: 'Robot XLSX & Bench Sheets' },
];

export const BottomStepper: React.FC = () => {
  const { view, setView, setVisited, run, missing, err, triPending, platesOk, status } = useApp();

  const currentIndex = STEPS.findIndex((s) => s.id === view);
  if (currentIndex === -1) return null; // Don't show in runs or compare views

  const prevStep = currentIndex > 0 ? STEPS[currentIndex - 1] : null;
  const nextStep = currentIndex < STEPS.length - 1 ? STEPS[currentIndex + 1] : null;

  const navigateTo = (tabId: string) => {
    setVisited((prev) => ({ ...prev, [tabId]: true }));
    setView(tabId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const hasIssues = run && run.blockingIssues > 0;
  const isSetupIncomplete = missing.length > 0 || triPending || Boolean(err);

  return (
    <footer
      aria-label="Workflow Navigation"
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 50,
        width: '100%',
        background: 'var(--panel)',
        borderTop: '1px solid var(--line)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        padding: '10px 16px',
        boxShadow: '0 -4px 20px rgba(0,0,0,0.18)',
      }}
    >
      <div
        style={{
          maxWidth: '1240px',
          margin: '0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        {/* Left: Previous Step Button */}
        <div>
          {prevStep ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => navigateTo(prevStep.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 600,
                padding: '6px 14px',
              }}
              title={`Go back to ${prevStep.label}`}
            >
              <span>←</span>
              <span>{prevStep.label}</span>
            </button>
          ) : (
            <div style={{ width: '100px' }} />
          )}
        </div>

        {/* Center: Step Flow Indicator Dots & Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {STEPS.map((s, i) => {
            const isCurrent = s.id === view;
            const isPast = i < currentIndex;

            return (
              <button
                key={s.id}
                type="button"
                onClick={() => navigateTo(s.id)}
                style={{
                  background: isCurrent ? 'var(--pri)' : isPast ? 'var(--soft)' : 'transparent',
                  color: isCurrent ? 'var(--acc-fg)' : isPast ? 'var(--fg)' : 'var(--mut)',
                  border: isCurrent
                    ? '1px solid var(--pri)'
                    : isPast
                    ? '1px solid var(--line)'
                    : '1px dashed var(--line)',
                  borderRadius: '20px',
                  padding: '3px 10px',
                  fontSize: '11px',
                  fontWeight: isCurrent ? 700 : 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  transition: 'all 0.15s ease',
                }}
                title={`${s.label}: ${s.shortDesc}`}
              >
                <span>{isPast ? '✓' : i + 1}</span>
                <span className="mono">{s.id.toUpperCase()}</span>
              </button>
            );
          })}

          {/* Quick status pill */}
          <div style={{ marginLeft: '6px', fontSize: '11px' }}>
            {hasIssues ? (
              <span className="chip bad" style={{ padding: '2px 8px', fontSize: '11px' }}>
                ⚠️ {run.blockingIssues} issue{run.blockingIssues > 1 ? 's' : ''}
              </span>
            ) : isSetupIncomplete ? (
              <span className="chip warn" style={{ padding: '2px 8px', fontSize: '11px' }}>
                Setup In Progress
              </span>
            ) : (
              <span className="chip ok" style={{ padding: '2px 8px', fontSize: '11px' }}>
                ✓ {run?.reactions || 54} Wells Ready
              </span>
            )}
          </div>
        </div>

        {/* Right: Next Step Button */}
        <div>
          {nextStep ? (
            <button
              type="button"
              className="btn sm pri"
              onClick={() => navigateTo(nextStep.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 700,
                padding: '6px 14px',
              }}
              title={`Proceed forward to ${nextStep.label}`}
            >
              <span>Proceed to {nextStep.label}</span>
              <span>→</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn sm pri"
              onClick={() => {
                const el = document.getElementById('robowski-archive-btn');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 700,
                padding: '6px 14px',
                background: '#059669',
                borderColor: '#047857',
              }}
            >
              <span>📦 Download Package</span>
              <span>✓</span>
            </button>
          )}
        </div>
      </div>
    </footer>
  );
};
