import React from 'react';
import { useApp } from '../../context/AppContext';

const TABS: [string, string][] = [
  ['setup', 'Setup'],
  ['combos', 'Combinations'],
  ['deck', 'Deck'],
  ['tlc', 'TLC Map'],
  ['export', 'Export'],
];

export const StepsNav: React.FC = () => {
  const { view, setView, run, err, missing, triPending, visited, setVisited, status, platesOk } =
    useApp();

  const blank = missing.length > 0;

  const getStepState = (id: string): 'done' | 'warn' | 'lock' | '' => {
    if (id === 'setup') {
      return blank || triPending ? '' : err || (run && run.blockingIssues > 0) ? 'warn' : 'done';
    }
    if (id === 'combos') {
      return !run ? '' : run.blockingIssues > 0 ? 'warn' : visited.combos ? 'done' : '';
    }
    if (id === 'deck') {
      return !run ? '' : !run.deck.positions_fit ? 'warn' : visited.deck ? (platesOk() ? 'done' : 'warn') : '';
    }
    if (id === 'tlc') {
      return visited.tlc ? 'done' : '';
    }
    if (id === 'export') {
      return !run || run.blockingIssues > 0 ? 'lock' : status === 'exported' ? 'done' : '';
    }
    return '';
  };

  const handleTabClick = (tabId: string) => {
    const st = getStepState(tabId);
    if (st === 'lock') return;
    setVisited((prev) => ({ ...prev, [tabId]: true }));
    setView(tabId);
    window.scrollTo(0, 0);
  };

  return (
    <nav className="steps" id="stepsnav" role="tablist" aria-label="Run steps">
      {TABS.map(([tabId, label], i) => {
        const st = getStepState(tabId);
        const mark =
          st === 'done' ? (
            '✓'
          ) : st === 'warn' ? (
            '!'
          ) : st === 'lock' ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" />
              <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
            </svg>
          ) : (
            i + 1
          );

        return (
          <button
            key={tabId}
            type="button"
            className={`step ${view === tabId ? 'on' : ''} ${st}`}
            role="tab"
            aria-selected={view === tabId}
            tabIndex={view === tabId ? 0 : -1}
            onClick={() => handleTabClick(tabId)}
            title={st === 'lock' ? 'Fix the blocking checks first' : undefined}
          >
            <b>{mark}</b>
            {label}
          </button>
        );
      })}
    </nav>
  );
};
