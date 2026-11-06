import React from 'react';
import { useApp } from '../../context/AppContext';

export const Header: React.FC = () => {
  const { state, setPath, view, setView, toggleTheme, theme, draftSavedAt } = useApp();

  return (
    <div className="top">
      <div className="topin">
        <h1 style={{ margin: 0, font: 'inherit', display: 'contents' }}>
          <button
            className="logo"
            onClick={() => setView('setup')}
            title="Back to the run"
          >
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <rect width="34" height="34" rx="9" fill="#15211E" />
              <g fill="#7FD1C2">
                <circle cx="10" cy="10" r="2.6" />
                <circle cx="17" cy="10" r="2.6" />
                <circle cx="24" cy="10" r="2.6" />
                <circle cx="10" cy="17" r="2.6" />
                <circle cx="24" cy="17" r="2.6" />
                <circle cx="10" cy="24" r="2.6" />
                <circle cx="17" cy="24" r="2.6" />
                <circle cx="24" cy="24" r="2.6" />
              </g>
              <circle cx="17" cy="17" r="3.4" fill="#FFC857" />
            </svg>
            Robowski Studio
          </button>
        </h1>

        <div className="seg" role="group" aria-label="Active hood">
          {(['left', 'right'] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setPath('hood', h);
                setPath('deckPlates', null);
              }}
              className={state.hood === h ? 'on' : ''}
            >
              <span
                className="hdot"
                style={{
                  background: state.hood === h ? '#1F9D6B' : '#AEB5AC',
                }}
              />
              {h === 'left' ? 'Left' : 'Right'} hood
            </button>
          ))}
        </div>

        <div className="topr">
          {/* Quick Search & Command Palette Button */}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
              );
            }}
            title="Search anything or jump to well (Ctrl+K / ⌘K)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              fontSize: '11px',
              background: 'var(--soft)',
              borderColor: 'var(--line)',
              color: 'var(--mut)',
            }}
          >
            <span>🔍 Search</span>
            <kbd
              style={{
                fontSize: '10px',
                padding: '1px 5px',
                background: 'var(--panel)',
                borderRadius: '3px',
                border: '1px solid var(--line)',
              }}
            >
              ⌘K
            </kbd>
          </button>

          <button
            type="button"
            className={`runsl ${view === 'runs' ? 'on' : ''}`}
            onClick={() => setView('runs')}
          >
            Runs &amp; library
          </button>

          <div className="rname">
            <div>{state.name}</div>
            <div className="hint" style={{ margin: 0 }}>
              {state.id ? 'Saved run' : 'Draft'} · this browser
              {draftSavedAt ? <span className="dsave"> · saved</span> : ''}
            </div>
          </div>

          <button
            type="button"
            className="avatar"
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
            title="Light / dark"
          >
            {theme === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M9 2a7 7 0 0 1 0 14z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M9 2a7 7 0 0 0 0 14z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
