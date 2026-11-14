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
            <img
              src="./favicon.svg"
              alt=""
              width={34}
              height={34}
              aria-hidden="true"
              className="logo-mark"
            />
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
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="5" />
              <path d="M11 11l3 3" />
            </svg>
            <span>Search</span>
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
