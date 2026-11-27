import React, { useEffect, useState } from 'react';
import { Link2, RefreshCw, Server } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { DEFAULT_LAB_BACKEND_URL } from '../../engine/predictor/backendClient';

export const Header: React.FC = () => {
  const {
    state,
    setPath,
    view,
    setView,
    toggleTheme,
    theme,
    draftSavedAt,
    backendUrl,
    backendStatus,
    backendPanelOpen,
    setBackendPanelOpen,
    backendSyncing,
    connectBackend,
    disconnectBackend,
    syncWithBackend,
    toast,
  } = useApp();

  const [urlDraft, setUrlDraft] = useState<string>(() => backendUrl || DEFAULT_LAB_BACKEND_URL);
  const [testing, setTesting] = useState<boolean>(false);

  useEffect(() => {
    if (backendUrl) setUrlDraft(backendUrl);
  }, [backendUrl]);

  const handleTestAndSave = async (overrideUrl?: string) => {
    const trimmed = (overrideUrl ?? urlDraft).trim();
    if (!trimmed) {
      toast(`Enter your Lab PC server address first (e.g. ${DEFAULT_LAB_BACKEND_URL}).`);
      return;
    }
    setUrlDraft(trimmed);
    setTesting(true);
    const st = await connectBackend(trimmed);
    setTesting(false);
    if (st.connected) {
      setUrlDraft(st.url);
    }
  };

  const handleCopyConnectLink = async () => {
    const target = (backendUrl || urlDraft).trim();
    if (!target) return;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('lab', target);
      await navigator.clipboard.writeText(u.toString());
      toast('Copied 1-click bookmark link — open it on the robot PC to connect automatically.');
    } catch {
      toast('Could not copy link automatically.');
    }
  };

  const isConnected = Boolean(backendStatus?.connected && backendUrl);

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

        <div className="seg" role="group" aria-label="Active robot hood">
          {(['left', 'right'] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setPath('hood', h);
                setPath('deckPlates', null);
              }}
              className={state.hood === h ? 'on' : ''}
              title={
                h === 'left'
                  ? 'Robowski#2 (Left hood · 100 mL jar on plate6, bottles on plate3–5)'
                  : 'Roboski#1 (Right hood · 20/40 mL bottles on plate3–5)'
              }
            >
              <span
                className="hdot"
                style={{
                  background: state.hood === h ? '#1F9D6B' : '#AEB5AC',
                }}
              />
              {h === 'left' ? 'Robowski#2 (Left)' : 'Roboski#1 (Right)'}
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

          {/* Whole-App Personal Lab PC Backend Button */}
          <button
            type="button"
            className="btn sm"
            onClick={() => setBackendPanelOpen((v) => !v)}
            title="Connect your personal lab PC backend (syncs runs, reagent library, TLC photos, Excel ELN structures, and 3D RDKit predictor)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              fontSize: '11.5px',
              borderColor: isConnected
                ? 'color-mix(in srgb, var(--ok) 55%, var(--line))'
                : undefined,
              color: isConnected ? 'var(--ok)' : undefined,
            }}
          >
            <span
              className="hdot"
              style={{
                background: isConnected ? '#1F9D6B' : '#AEB5AC',
                marginRight: 0,
              }}
            />
            <Server size={12} />
            <span>{isConnected ? 'Lab PC' : 'Lab PC'}</span>
          </button>

          <button
            type="button"
            className={`runsl ${view === 'compare' ? 'on' : ''}`}
            onClick={() => setView('compare')}
            title="Compare multiple wells or runs side by side"
          >
            Compare
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
              {state.id ? 'Saved run' : 'Draft'} · {isConnected ? 'Lab PC synced' : 'this browser'}
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

      {backendPanelOpen && (
        <div
          style={{
            borderTop: '1px solid var(--line2)',
            background: 'var(--panel)',
            padding: '12px 20px',
          }}
        >
          <div
            style={{
              maxWidth: '1320px',
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '12.5px', color: 'var(--fg2)' }}>
                <strong>Personal Lab PC Backend:</strong> Syncs all your runs, ELN notes, reagent library, and TLC plate photos across PCs, exports Excel ELNs with 2D structures, and upgrades the predictor with 3D RDKit. Automatically falls back when your PC is off.
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() => setBackendPanelOpen(false)}
                style={{ padding: '2px 8px', fontSize: '11px' }}
              >
                Close
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="url"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTestAndSave();
                }}
                placeholder="Just the tunnel words (e.g. happy-blue-tiger), localhost:8000, or full URL"
                className="mono"
                style={{
                  flex: '1 1 280px',
                  minWidth: '220px',
                  height: '32px',
                  padding: '0 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                className="btn sm pri"
                disabled={testing}
                onClick={() => handleTestAndSave()}
              >
                {testing ? 'Connecting…' : 'Test & Save'}
              </button>
              {isConnected && (
                <>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={backendSyncing}
                    onClick={() => syncWithBackend()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <RefreshCw size={12} />
                    <span>{backendSyncing ? 'Syncing…' : 'Sync Now'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={handleCopyConnectLink}
                    title="Copy a 1-click auto-connect link to bookmark or send to the robot PC"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  >
                    <Link2 size={12} />
                    <span>Copy Link</span>
                  </button>
                </>
              )}
              {backendUrl && (
                <button type="button" className="btn sm" onClick={disconnectBackend}>
                  Disconnect
                </button>
              )}
            </div>

            {backendStatus && (
              <div
                style={{
                  fontSize: '12px',
                  color: backendStatus.connected ? 'var(--ok)' : 'var(--warn)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}
              >
                {backendStatus.connected ? (
                  <>
                    <span>
                      Connected · RDKit {backendStatus.rdkitVersion} · {backendStatus.runsCount ?? 0} runs ·{' '}
                      {backendStatus.libraryCount ?? 0} reagents · {backendStatus.tlcImagesCount ?? 0} TLC photos ·{' '}
                      {backendStatus.tlcObservations ?? 0} TLC checks
                    </span>
                    <a
                      href={`${backendStatus.url}/api/tlc/export.csv`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--acc)', textDecoration: 'underline' }}
                    >
                      Download TLC History CSV
                    </a>
                  </>
                ) : (
                  <span>{backendStatus.error || 'Lab PC server not reachable — using local browser storage.'}</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--mut)' }}>
              <span>Quick select:</span>
              <button
                type="button"
                className="btn sm"
                disabled={testing}
                onClick={() => handleTestAndSave(DEFAULT_LAB_BACKEND_URL)}
                style={{ padding: '2px 8px', fontSize: '11px' }}
              >
                Default ({DEFAULT_LAB_BACKEND_URL.replace(/^https?:\/\//, '')})
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={testing}
                onClick={() => handleTestAndSave('http://localhost:8000')}
                style={{ padding: '2px 8px', fontSize: '11px' }}
              >
                This PC (localhost:8000)
              </button>
              <span>· Or paste any custom URL / Cloudflare words to override.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
