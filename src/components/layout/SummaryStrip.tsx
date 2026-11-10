import React from 'react';
import { useApp } from '../../context/AppContext';
import { PAL } from '../../engine';

export const SummaryStrip: React.FC = () => {
  const { state, run, err, missing, allEmpty, triPending, triMeta, setView } = useApp();

  const bad = run ? run.blockingIssues : 0;
  const warn = run ? run.warningCount : 0;
  const blank = missing.length > 0;

  const renderChip = () => {
    if (triPending) {
      return <span className="chip mut">No groups placed yet</span>;
    }
    if (blank) {
      return allEmpty ? (
        <span className="chip mut">Not filled in yet</span>
      ) : (
        <span className="chip warn">
          {missing.length} to fill in
        </span>
      );
    }
    if (err) {
      return <span className="chip bad">Input error</span>;
    }
    if (bad) {
      return (
        <span className="chip bad">
          {bad} check{bad > 1 ? 's' : ''} failing
        </span>
      );
    }
    if (warn) {
      return (
        <span className="chip warn">
          {warn} warning{warn > 1 ? 's' : ''}
        </span>
      );
    }
    return <span className="chip ok">All checks pass</span>;
  };

  const tipsText = () => {
    if (!run) return '-';
    const t = run.tipCounts;
    return `${t[50]} / ${t[300]} / ${t[1000]}`;
  };

  const wellsCount = () => {
    if (!run) return '-';
    return state.mode === 'triplet'
      ? triMeta.filter((m) => !m.blank).length
      : run.reactions;
  };

  return (
    <div className="sband" id="strip">
      <div className="sbin">
        <span>
          Mode{' '}
          <b>
            {state.mode === 'equivalence'
              ? 'Equivalence'
              : state.mode === 'triplet'
              ? 'Triplet plate'
              : 'Concentration'}
          </b>
        </span>
        <span>
          Vial <b className="mono">{Number(state.vialVolume) || 0} µL</b>
        </span>
        <span>
          {state.mode === 'triplet' ? 'Wells' : 'Combinations'}{' '}
          <b className="mono">{wellsCount()}</b>
        </span>
        <span>
          Vial plates <b className="mono">{run ? run.plates : '-'}</b>
        </span>
        <span>
          Tips 50/300/1000 <b className="mono">{tipsText()}</b>
        </span>
        <span title={run ? run.runtime.calibrationNote : ''}>
          Est. time <b>{run ? run.runtime.label : '-'}</b>
        </span>
        <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
          {state.reagents.map((r, i) => (
            <span
              key={r.code + i}
              className="rdot"
              style={{ background: PAL[i % PAL.length] }}
              title={r.name ? `${r.code} · ${r.name}` : r.code}
            >
              {r.code}
            </span>
          ))}
        </span>
        {state.eln && Object.values(state.eln.wells || {}).some((w) => (w.tags && w.tags.length > 0) || Boolean(w.notes) || (w.status && w.status !== 'none')) && (
          <span
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            onClick={() => setView('eln')}
            title="View HTE Notebook observations and hit matrix"
          >
            📓 <b>{Object.values(state.eln.wells || {}).filter((w) => (w.tags && w.tags.length > 0) || Boolean(w.notes)).length}</b> obs
          </span>
        )}
        {renderChip()}
      </div>
    </div>
  );
};
