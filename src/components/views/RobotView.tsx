import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Droplets,
  FlaskConical,
  Home,
  Lock,
  Move,
  PauseCircle,
  RefreshCw,
  Scale,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  DILUTER_SOLVENTS,
  calculateDiluterPlan,
  robotProfileForHood,
  type DiluterPlanInput,
} from '../../engine';
import {
  fetchRobotLiveStatus,
  sendRobotCommand,
  type RobotCommandResult,
  type RobotLiveStatus,
} from '../../engine/predictor/backendClient';

const STATUS_META: Record<
  RobotLiveStatus['state'] | 'disconnected',
  {
    label: string;
    color: string;
    bg: string;
    border: string;
  }
> = {
  running: {
    label: 'Working now',
    color: 'var(--ok)',
    bg: 'color-mix(in srgb, var(--ok) 10%, var(--panel))',
    border: 'color-mix(in srgb, var(--ok) 45%, var(--line))',
  },
  waiting_user: {
    label: 'Waiting for you',
    color: 'var(--warn)',
    bg: 'color-mix(in srgb, var(--warn) 12%, var(--panel))',
    border: 'color-mix(in srgb, var(--warn) 50%, var(--line))',
  },
  idle: {
    label: 'Idle & ready',
    color: 'var(--acc)',
    bg: 'color-mix(in srgb, var(--acc) 9%, var(--panel))',
    border: 'color-mix(in srgb, var(--acc) 40%, var(--line))',
  },
  error: {
    label: 'Needs attention',
    color: 'var(--bad)',
    bg: 'color-mix(in srgb, var(--bad) 10%, var(--panel))',
    border: 'color-mix(in srgb, var(--bad) 50%, var(--line))',
  },
  not_configured: {
    label: 'Waiting for Robot PC',
    color: 'var(--mut)',
    bg: 'var(--soft)',
    border: 'var(--line)',
  },
  disconnected: {
    label: 'Lab PC offline',
    color: 'var(--mut)',
    bg: 'var(--soft)',
    border: 'var(--line)',
  },
};

function formatTimeAgo(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'just now';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export const RobotView: React.FC = () => {
  const {
    state,
    run,
    backendUrl,
    backendStatus,
    setBackendPanelOpen,
    toast,
  } = useApp();

  const isConnected = Boolean(backendStatus?.connected && backendUrl);
  const profile = robotProfileForHood(state.hood);

  // Live monitor state
  const [liveStatus, setLiveStatus] = useState<RobotLiveStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [selectedRunPath, setSelectedRunPath] = useState<string>('');

  // Hardware command controls state
  const [controlPin, setControlPin] = useState<string>('');
  const [cmdBusy, setCmdBusy] = useState<boolean>(false);
  const [lastCmdResult, setLastCmdResult] = useState<RobotCommandResult | null>(null);
  const [confirmEstop, setConfirmEstop] = useState<boolean>(false);
  const [targetPlate, setTargetPlate] = useState<number>(3);
  const [targetSlot, setTargetSlot] = useState<number>(0);
  const [jogStepMm, setJogStepMm] = useState<5 | 20>(5);
  const [zStepUnits, setZStepUnits] = useState<10 | 50 | 100>(50); // 1 mm, 5 mm, 10 mm
  const [targetZInput, setTargetZInput] = useState<number>(1700);
  const [skipTipType, setSkipTipType] = useState<'50ul' | '300ul' | '1000ul'>('300ul');
  const [skipTipCount, setSkipTipCount] = useState<number>(1);

  // diluter.py planner state (synced strictly with zeus-pipetter/diluter.py)
  const [diluterInput, setDiluterInput] = useState<DiluterPlanInput>(() => ({
    vialCount: Math.min(54, run?.reactions || 54),
    crudeVolumeUl: Math.max(50, Math.round(Number(state.vialVolume) || 500)),
    solvent0: 'ethanol',
    solvent0JarPlate: 6,
    solvent0JarPos: 0,
    volSolventToA: 0,
    volAToB: 50,
    volSolventToB: 950,
    enableSecondStage: false,
    solvent1: 'ethanol',
    solvent1JarPlate: 6,
    solvent1JarPos: 1,
    volSolventToBExtra: 0,
    volBToC: 50,
    volSolventToC: 950,
  }));

  const diluterPlan = useMemo(() => calculateDiluterPlan(diluterInput), [diluterInput]);

  const maxSlotForPlate = targetPlate <= 2 ? 53 : targetPlate <= 5 ? 7 : 1;

  useEffect(() => {
    if (targetSlot > maxSlotForPlate) {
      setTargetSlot(0);
    }
  }, [maxSlotForPlate, targetSlot]);

  const refreshStatus = useCallback(
    async (silent = false) => {
      if (!isConnected || !backendUrl) {
        setLiveStatus(null);
        return;
      }
      if (!silent) setLoadingStatus(true);
      const data = await fetchRobotLiveStatus(selectedRunPath || undefined, backendUrl);
      if (data) {
        setLiveStatus(data);
        if (!selectedRunPath && data.activeRun?.relativePath) {
          setSelectedRunPath(data.activeRun.relativePath);
        }
      }
      if (!silent) setLoadingStatus(false);
    },
    [isConnected, backendUrl, selectedRunPath]
  );

  useEffect(() => {
    refreshStatus(false);
  }, [refreshStatus]);

  useEffect(() => {
    if (!isConnected || !autoRefresh) return;
    const id = window.setInterval(() => {
      refreshStatus(true);
    }, 5000);
    return () => window.clearInterval(id);
  }, [isConnected, autoRefresh, refreshStatus]);

  const runCommand = async (command: string, params: Record<string, any> = {}) => {
    setCmdBusy(true);
    setConfirmEstop(false);
    const res = await sendRobotCommand(command, params, backendUrl || undefined, controlPin || undefined);
    setLastCmdResult(res);
    setCmdBusy(false);
    if (res.ok) {
      toast(res.executed ? res.humanMessage : 'Preview snippet ready (read-only monitor mode).');
      if (res.executed) {
        refreshStatus(true);
      }
    } else {
      toast(res.humanMessage || 'Robot command failed.');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${label}.`);
    } catch {
      toast('Could not copy automatically.');
    }
  };

  const stateKey: RobotLiveStatus['state'] | 'disconnected' = !isConnected
    ? 'disconnected'
    : liveStatus?.state || 'idle';
  const statusStyle = STATUS_META[stateKey];

  const headline = !isConnected
    ? 'Connect your Lab PC to watch the robot live'
    : liveStatus?.headline || 'Checking robot status…';

  const detail = !isConnected
    ? 'The Dilution Planner below still works offline. Click "Connect Lab PC" to see live progress, remaining tips, and send commands.'
    : liveStatus?.detail || 'Reading the latest run spreadsheet, tip racks, and activity log from your Lab PC.';

  const activeRun = liveStatus?.activeRun || null;
  const hw = liveStatus?.hardware;
  const tipRacks = liveStatus?.tipRacks || [
    { tipType: '50ul' as const, remaining: 96, total: 96, used: 0 },
    { tipType: '300ul' as const, remaining: 96, total: 96, used: 0 },
    { tipType: '1000ul' as const, remaining: 96, total: 96, used: 0 },
  ];

  const diluterPythonSnippet = useMemo(() => {
    const lines = [
      `# Paste into zeus-pipetter/diluter.py (${diluterInput.vialCount} vials, ${diluterInput.crudeVolumeUl} µL crude in Plate A)`,
      diluterPlan.pythonVolumesLine,
      `solvent0 = '${diluterInput.solvent0}'  # jar on plate${diluterInput.solvent0JarPlate}, pos ${diluterInput.solvent0JarPos} (fill >= ${diluterPlan.solvent0WithDeadMl} mL)`,
    ];
    if (diluterInput.enableSecondStage) {
      lines.push(
        `solvent1 = '${diluterInput.solvent1}'  # jar on plate${diluterInput.solvent1JarPlate}, pos ${diluterInput.solvent1JarPos} (fill >= ${diluterPlan.solvent1WithDeadMl} mL)`
      );
    }
    lines.push(
      `# Result: Plate B = ${diluterPlan.totalFactorB}x diluted (${diluterPlan.plateBFinalUl} µL/vial)` +
        (diluterInput.enableSecondStage
          ? ` | Plate C = ${diluterPlan.totalFactorC}x diluted (${diluterPlan.plateCFinalUl} µL/vial)`
          : '')
    );
    return lines.join('\n');
  }, [diluterInput, diluterPlan]);

  return (
    <div className="wrap">
      {/* 1. ALWAYS-VISIBLE PLAIN-ENGLISH LIVE STATUS BANNER */}
      <div
        className="card"
        style={{
          marginBottom: '20px',
          background: statusStyle.bg,
          borderColor: statusStyle.border,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 380px', minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12.5px',
                fontWeight: 700,
                color: statusStyle.color,
                marginBottom: '4px',
              }}
            >
              {stateKey === 'running' ? (
                <Activity size={16} />
              ) : stateKey === 'waiting_user' ? (
                <PauseCircle size={16} />
              ) : stateKey === 'error' ? (
                <AlertOctagon size={16} />
              ) : stateKey === 'idle' ? (
                <CheckCircle2 size={16} />
              ) : (
                <Server size={16} />
              )}
              <span>{statusStyle.label}</span>
              <span style={{ color: 'var(--mut)', fontWeight: 500 }}>
                · {liveStatus?.robotName || profile.pipetterName}
                {liveStatus?.relaySource === 'robot_pc_agent'
                  ? liveStatus.agentOnline
                    ? ' · Live from Robot PC helper'
                    : ' · Robot PC helper paused'
                  : ''}
              </span>
              {liveStatus?.lastUpdatedIso && (
                <span style={{ color: 'var(--mut)', fontWeight: 400 }}>
                  · updated {formatTimeAgo(liveStatus.secondsAgo)}
                </span>
              )}
            </div>

            <h2 style={{ margin: '0 0 4px 0', fontSize: '20px' }}>{headline}</h2>
            <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--fg2)', lineHeight: 1.45 }}>
              {detail}
            </p>

            {/* Plain-language at-a-glance facts strip */}
            <div
              style={{
                marginTop: '10px',
                fontSize: '12.5px',
                color: 'var(--fg2)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px 14px',
              }}
            >
              <span>
                <strong>Tip on arm:</strong>{' '}
                {hw?.currentTip ? hw.currentTip.replace('ul', ' µL') : 'None'}
              </span>
              <span>·</span>
              <span>
                <strong>Arm position:</strong> {hw?.currentPosition || 'Unknown / parked'}
              </span>
              <span>·</span>
              <span>
                <strong>Control mode:</strong>{' '}
                {hw?.controlEnabled
                  ? hw?.pinProtected
                    ? 'PIN-protected live buttons'
                    : 'Live buttons enabled'
                  : 'Safe read-only monitor'}
              </span>
              {activeRun && (
                <>
                  <span>·</span>
                  <span>
                    <strong>Vials done:</strong>{' '}
                    <span className="mono">
                      {activeRun.completedVials} / {activeRun.totalVials} ({activeRun.percentComplete}
                      %)
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right side quick actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {!isConnected ? (
              <button
                type="button"
                className="btn pri"
                onClick={() => setBackendPanelOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <Server size={14} />
                <span>Connect Lab PC</span>
              </button>
            ) : (
              <>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    color: 'var(--fg2)',
                    cursor: 'pointer',
                    marginRight: '4px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  Auto-refresh (5s)
                </label>

                <button
                  type="button"
                  className="btn sm"
                  disabled={loadingStatus}
                  onClick={() => refreshStatus(false)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <RefreshCw size={13} />
                  <span>{loadingStatus ? 'Checking…' : 'Refresh'}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Run file selector when multiple run spreadsheets exist in ROBOCHEM_DATA_PATH */}
        {isConnected && liveStatus && liveStatus.availableRuns.length > 0 && (
          <div
            style={{
              marginTop: '12px',
              paddingTop: '10px',
              borderTop: '1px solid var(--line2)',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              fontSize: '12.5px',
            }}
          >
            <label htmlFor="robot-run-picker" style={{ fontWeight: 600, color: 'var(--fg2)' }}>
              Watching experiment file:
            </label>
            <select
              id="robot-run-picker"
              value={selectedRunPath}
              onChange={(e) => setSelectedRunPath(e.target.value)}
              className="mono"
              style={{
                maxWidth: '460px',
                height: '30px',
                fontSize: '12px',
                padding: '0 8px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                background: 'var(--panel)',
                color: 'var(--fg)',
              }}
            >
              {liveStatus.availableRuns.map((r) => (
                <option key={r.relativePath} value={r.relativePath}>
                  {r.relativePath}
                </option>
              ))}
            </select>
            {activeRun?.plateBarcode && (
              <span className="mono" style={{ color: 'var(--mut)', fontSize: '12px' }}>
                Barcode: {activeRun.plateBarcode}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 2. LIVE EXPERIMENT PROGRESS & TIP RACKS */}
      <div className="grid eq" style={{ marginBottom: '20px' }}>
        {/* Left: Live Plate & Stock Progress */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={18} />
            Live experiment progress
          </h2>
          {activeRun ? (
            <>
              <p className="sub" style={{ marginBottom: '12px' }}>
                Reading <span className="mono">{activeRun.fileName}</span> directly from your
                Robowski data folder.
              </p>

              {/* Overall progress bar */}
              <div style={{ marginBottom: '14px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '12.5px',
                    marginBottom: '5px',
                  }}
                >
                  <span>
                    <strong>{activeRun.completedVials}</strong> finished ·{' '}
                    <strong>{activeRun.inProgressVials}</strong> in progress ·{' '}
                    <strong>{activeRun.notStartedVials}</strong> waiting
                  </span>
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {activeRun.percentComplete}%
                  </span>
                </div>
                <div
                  style={{
                    height: '10px',
                    borderRadius: '999px',
                    background: 'var(--soft)',
                    overflow: 'hidden',
                    border: '1px solid var(--line2)',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, activeRun.percentComplete)}%`,
                      height: '100%',
                      background: 'var(--ok)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>

              {/* 54-vial live map */}
              {activeRun.wellStates.length > 0 && (
                <div style={{ marginBottom: '14px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '11.5px',
                      color: 'var(--mut)',
                      marginBottom: '6px',
                    }}
                  >
                    <span>Plate vials ({activeRun.wellStates.length} shown)</span>
                    <span>Green = done · Amber = working · Grey = waiting</span>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(9, minmax(0, 1fr))',
                      gap: '4px',
                    }}
                  >
                    {activeRun.wellStates.slice(0, 54).map((ws, idx) => {
                      const bg =
                        ws === 'completed'
                          ? 'var(--ok)'
                          : ws === 'in_progress'
                          ? 'var(--warn)'
                          : 'var(--soft)';
                      const fg =
                        ws === 'completed' || ws === 'in_progress' ? '#ffffff' : 'var(--mut)';
                      return (
                        <div
                          key={idx}
                          title={`Vial ${idx}: ${
                            ws === 'completed'
                              ? 'Finished'
                              : ws === 'in_progress'
                              ? 'Currently being pipetted'
                              : 'Waiting'
                          }`}
                          className="mono"
                          style={{
                            height: '22px',
                            borderRadius: '4px',
                            background: bg,
                            color: fg,
                            border: '1px solid var(--line2)',
                            fontSize: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 600,
                          }}
                        >
                          {idx}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Per-reagent bars */}
              {activeRun.substances.length > 0 && (
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
                    Reagent dispensing progress
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeRun.substances.map((sub) => (
                      <div key={sub.substance} style={{ fontSize: '12px' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: '2px',
                          }}
                        >
                          <span>{sub.substance}</span>
                          <span className="mono" style={{ color: 'var(--mut)' }}>
                            {sub.completed}/{sub.total} ({sub.percent}%)
                          </span>
                        </div>
                        <div
                          style={{
                            height: '6px',
                            borderRadius: '999px',
                            background: 'var(--soft)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, sub.percent)}%`,
                              height: '100%',
                              background: sub.percent >= 100 ? 'var(--ok)' : 'var(--acc)',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Live bottle remaining volumes */}
              {activeRun.stocks.length > 0 && (
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
                    Live liquid left in deck bottles
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {activeRun.stocks.map((st) => (
                      <div
                        key={`${st.substance}-${st.plate}-${st.containerId}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '12px',
                          padding: '5px 0',
                          borderTop: '1px solid var(--line2)',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{st.substance}</span>
                        <span className="mono" style={{ color: 'var(--mut)' }}>
                          plate{st.plate} · pos {st.containerId}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontWeight: 600,
                            color: st.percentRemaining < 15 ? 'var(--bad)' : 'var(--fg)',
                          }}
                        >
                          {(st.remainingVolumeUl / 1000).toFixed(1)} /{' '}
                          {(st.initialVolumeUl / 1000).toFixed(1)} mL
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: '13px', color: 'var(--fg2)', lineHeight: 1.5 }}>
              <p style={{ margin: '0 0 8px 0' }}>
                No live robot update received yet. Copy <span className="mono">robot_pc_agent.py</span>{' '}
                and <span className="mono">start_robot_helper_windows.bat</span> onto the Robot PC and
                double-click the <span className="mono">.bat</span> file — it reads your robot folder
                automatically and streams every finished vial, remaining bottle volume, and tip count
                straight here.
              </p>
              <div className="hint" style={{ margin: 0 }}>
                You do not need to install Tailscale or type any folder paths on the Robot PC.
              </div>
            </div>
          )}

          {/* Plain-English Recent Activity Feed */}
          {liveStatus && liveStatus.recentActivity.length > 0 && (
            <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--line2)' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '8px' }}>
                What the robot just did
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {liveStatus.recentActivity.slice(0, 8).map((ev, i) => (
                  <div
                    key={`${ev.timestamp}-${i}`}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      alignItems: 'baseline',
                      fontSize: '12.5px',
                      color:
                        ev.level === 'error'
                          ? 'var(--bad)'
                          : ev.level === 'warning'
                          ? 'var(--warn)'
                          : 'var(--fg2)',
                    }}
                  >
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)', minWidth: '62px' }}>
                      {ev.timestamp || 'recent'}
                    </span>
                    <span>{ev.summary}</span>
                  </div>
                ))}
              </div>

              {liveStatus.rawLogTail.length > 0 && (
                <details style={{ marginTop: '10px' }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontSize: '11.5px',
                      color: 'var(--mut)',
                    }}
                  >
                    Show technical robot log ({liveStatus.rawLogTail.length} lines)
                  </summary>
                  <pre
                    className="mono"
                    style={{
                      marginTop: '6px',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'var(--soft)',
                      border: '1px solid var(--line)',
                      fontSize: '11px',
                      overflowX: 'auto',
                      maxHeight: '180px',
                    }}
                  >
                    {liveStatus.rawLogTail.join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        {/* Right: Tip Racks Live Counter & Quick Refill */}
        <div className="card" style={{ minWidth: 0 }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sparkles size={18} />
            Tip racks on the deck
          </h2>
          <p className="sub">
            Live count from <span className="mono">tip_rack.json</span>. Click{' '}
            <strong>Mark Full</strong> right after snapping in a fresh rack of 96 tips.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
            {tipRacks.map((rack) => {
              const pct = rack.total > 0 ? Math.round((100 * rack.remaining) / rack.total) : 0;
              const barColor =
                rack.remaining <= 10
                  ? 'var(--bad)'
                  : rack.remaining <= 25
                  ? 'var(--warn)'
                  : 'var(--ok)';
              return (
                <div
                  key={rack.tipType}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'var(--soft)',
                    border: '1px solid var(--line)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '10px',
                      marginBottom: '6px',
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>
                        {rack.tipType.replace('ul', ' µL')} rack
                      </span>
                      <span
                        className="mono"
                        style={{ marginLeft: '10px', fontSize: '13px', color: 'var(--fg2)' }}
                      >
                        <strong>{rack.remaining}</strong> / {rack.total} tips left
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={cmdBusy}
                      onClick={() => runCommand('reload_tip_rack', { tip_type: rack.tipType })}
                      title={`Reset ${rack.tipType} rack to 96/96 full`}
                    >
                      Mark Full (96)
                    </button>
                  </div>

                  <div
                    style={{
                      height: '8px',
                      borderRadius: '999px',
                      background: 'var(--panel)',
                      overflow: 'hidden',
                      border: '1px solid var(--line2)',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: barColor,
                        transition: 'width 0.25s ease',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Mark partial rack used */}
          <div
            style={{
              marginTop: '14px',
              paddingTop: '12px',
              borderTop: '1px solid var(--line2)',
            }}
          >
            <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>
              Loaded a partially used rack? Skip missing tips
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={skipTipType}
                onChange={(e) => setSkipTipType(e.target.value as '50ul' | '300ul' | '1000ul')}
                style={{
                  height: '32px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontSize: '12.5px',
                }}
              >
                <option value="50ul">50 µL rack</option>
                <option value="300ul">300 µL rack</option>
                <option value="1000ul">1000 µL rack</option>
              </select>
              <input
                type="number"
                min={1}
                max={96}
                value={skipTipCount}
                onChange={(e) =>
                  setSkipTipCount(Math.max(1, Math.min(96, Math.round(Number(e.target.value) || 1))))
                }
                className="mono"
                style={{
                  width: '72px',
                  height: '32px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  fontSize: '12.5px',
                }}
              />
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() =>
                  runCommand('mark_tips_used', { tip_type: skipTipType, count: skipTipCount })
                }
              >
                Mark {skipTipCount} tip{skipTipCount === 1 ? '' : 's'} used
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 3. REPLICATED PYTHON ROBOT COMMANDS */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
            flexWrap: 'wrap',
            marginBottom: '12px',
          }}
        >
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Wrench size={18} />
              Robot Commands
            </h2>
            <p className="sub" style={{ margin: '2px 0 0 0' }}>
              Everyday controls replicated from <span className="mono">pipetter.py</span>,{' '}
              <span className="mono">zeus.py</span>, and <span className="mono">breadboard.py</span>
              .{' '}
              {hw?.controlEnabled
                ? hw?.pinProtected
                  ? 'Live buttons are ready — enter your PIN on the right to move the robot.'
                  : 'Live hardware mode is ON — buttons move the robot immediately.'
                : 'Currently in safe monitor mode — save a PIN in robot_pin.txt on the Robot PC to unlock live buttons.'}
            </p>
          </div>

          {/* Optional PIN input when lab uses ROBOWSKI_CONTROL_PIN */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Lock size={14} style={{ color: 'var(--mut)' }} />
            <input
              type="password"
              value={controlPin}
              onChange={(e) => setControlPin(e.target.value)}
              placeholder="Control PIN (if set)"
              autoComplete="off"
              style={{
                width: '150px',
                height: '30px',
                padding: '0 8px',
                borderRadius: '6px',
                border: '1px solid var(--line)',
                background: 'var(--bg)',
                color: 'var(--fg)',
                fontSize: '12px',
              }}
            />
          </div>
        </div>

        {/* 4 Command Groups in a clean 2x2 grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '14px',
          }}
        >
          {/* Group A: Safety & Homing */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Home size={14} />
              <span>Safety, Homing &amp; Parking</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={() => runCommand('init_hardware')}
              >
                Connect &amp; Home
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('disconnect_hardware')}
                title="Close the helper's USB & CAN connection so main.py or diluter.py can use the robot without a COM port busy error"
                style={
                  hw?.connected
                    ? {
                        borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line))',
                        color: 'var(--warn)',
                        fontWeight: 600,
                      }
                    : undefined
                }
              >
                Release USB (for main.py)
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('home_xy')}
              >
                Home X/Y
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_z_traverse')}
              >
                Lift Arm Safe
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_idle')}
              >
                Park Arm
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('kill_alarm')}
              >
                Clear Alarm
              </button>
              {!confirmEstop ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={cmdBusy}
                  onClick={() => setConfirmEstop(true)}
                  style={{
                    color: 'var(--bad)',
                    borderColor: 'color-mix(in srgb, var(--bad) 55%, var(--line))',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <ShieldAlert size={13} />
                  <span>Emergency Stop</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm"
                  disabled={cmdBusy}
                  onClick={() => runCommand('emergency_stop')}
                  style={{
                    background: 'var(--bad)',
                    color: '#ffffff',
                    borderColor: 'var(--bad)',
                    fontWeight: 700,
                  }}
                >
                  Confirm STOP Now
                </button>
              )}
            </div>
          </div>

          {/* Group B: Tips */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FlaskConical size={14} />
              <span>Pipette Tips</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {(['50ul', '300ul', '1000ul'] as const).map((tt) => (
                <button
                  key={tt}
                  type="button"
                  className="btn sm"
                  disabled={cmdBusy}
                  onClick={() => runCommand('pick_tip', { tip_type: tt })}
                >
                  Pick {tt.replace('ul', ' µL')}
                </button>
              ))}
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('discard_tip')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Trash2 size={13} />
                <span>Drop Tip</span>
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('check_tip_status')}
              >
                Check Tip Sensor
              </button>
            </div>
          </div>

          {/* Group C: Move to Deck Position + Jog */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Move size={14} />
              <span>Move Arm to Deck &amp; Jog</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
              <select
                value={targetPlate}
                onChange={(e) => setTargetPlate(Number(e.target.value))}
                style={{
                  height: '30px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              >
                <option value={0}>plate0 (Vials 0–53)</option>
                <option value={1}>plate1 (Vials 0–53)</option>
                <option value={2}>plate2 (Vials 0–53)</option>
                <option value={3}>plate3 (Bottles 0–7)</option>
                <option value={4}>plate4 (Bottles 0–7)</option>
                <option value={5}>plate5 (Bottles 0–7)</option>
                <option value={6}>plate6 (Jars 0–1)</option>
                <option value={7}>plate7 (Jars 0–1)</option>
              </select>
              <input
                type="number"
                min={0}
                max={maxSlotForPlate}
                value={targetSlot}
                onChange={(e) =>
                  setTargetSlot(
                    Math.max(0, Math.min(maxSlotForPlate, Math.round(Number(e.target.value) || 0)))
                  )
                }
                className="mono"
                title={`Slot 0 to ${maxSlotForPlate}`}
                style={{
                  width: '62px',
                  height: '30px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={() =>
                  runCommand('move_to_container', { plate_id: targetPlate, container_id: targetSlot })
                }
              >
                Move Here
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_to_trash')}
              >
                Trash
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_to_balance')}
              >
                Balance
              </button>
            </div>

            {/* Relative XY Jog */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Nudge:</span>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_xy_rel', { dx: -jogStepMm, dy: 0 })}
                title={`Move X -${jogStepMm} mm`}
              >
                <ArrowLeft size={12} /> X-
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_xy_rel', { dx: jogStepMm, dy: 0 })}
                title={`Move X +${jogStepMm} mm`}
              >
                X+ <ArrowRight size={12} />
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_xy_rel', { dx: 0, dy: jogStepMm })}
                title={`Move Y +${jogStepMm} mm`}
              >
                <ArrowUp size={12} /> Y+
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_xy_rel', { dx: 0, dy: -jogStepMm })}
                title={`Move Y -${jogStepMm} mm`}
              >
                <ArrowDown size={12} /> Y-
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => setJogStepMm((s) => (s === 5 ? 20 : 5))}
                style={{ fontSize: '11px' }}
              >
                Step: {jogStepMm} mm
              </button>
            </div>
          </div>

          {/* Group D: Manual Z Height & Balance */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: '13px',
                marginBottom: '8px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Scale size={14} />
                <span>Manual Z Height &amp; Balance</span>
              </span>
              {hw?.currentZ != null && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => copyText(String(hw.currentZ), `Z = ${hw.currentZ}`)}
                  title="Click to copy current Z height for Excel"
                  style={{ fontSize: '11px', padding: '2px 7px' }}
                >
                  Z = <span className="mono">{hw.currentZ}</span> · Copy
                </button>
              )}
            </div>

            {/* Gradual Z Up / Down buttons for touching liquid surface manually */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_z_rel', { dz: -zStepUnits })}
                title={`Raise tip up by ${zStepUnits / 10} mm`}
              >
                <ArrowUp size={12} /> Raise
              </button>
              <button
                type="button"
                className="btn sm pri"
                disabled={cmdBusy}
                onClick={() => runCommand('move_z_rel', { dz: zStepUnits })}
                title={`Lower tip down toward liquid by ${zStepUnits / 10} mm`}
              >
                <ArrowDown size={12} /> Lower
              </button>
              <select
                aria-label="Z step size"
                value={zStepUnits}
                onChange={(e) => setZStepUnits(Number(e.target.value) as 10 | 50 | 100)}
                style={{
                  height: '30px',
                  padding: '0 6px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              >
                <option value={10}>Step: 1 mm (10)</option>
                <option value={50}>Step: 5 mm (50)</option>
                <option value={100}>Step: 10 mm (100)</option>
              </select>
              <input
                aria-label="Go to Z height"
                type="number"
                min={500}
                max={2200}
                step={10}
                value={targetZInput}
                onChange={(e) =>
                  setTargetZInput(Math.max(500, Math.min(2200, Math.round(Number(e.target.value) || 880))))
                }
                className="mono"
                title="Target Z height (880 = safe travel, 2180 = bottle bottom)"
                style={{
                  width: '70px',
                  height: '30px',
                  padding: '0 6px',
                  borderRadius: '6px',
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--fg)',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('move_z', { z: targetZInput })}
              >
                Go Z
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('read_instrument_status')}
              >
                Read Z &amp; Status
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('balance_door_open')}
              >
                Open Door
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('balance_door_close')}
              >
                Close Door
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('balance_tare')}
              >
                Tare
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={cmdBusy}
                onClick={() => runCommand('balance_read')}
              >
                Read Weight
              </button>
            </div>
          </div>
        </div>

        {/* Latest Command Feedback Box */}
        {lastCmdResult && (
          <div
            style={{
              marginTop: '14px',
              padding: '10px 12px',
              borderRadius: '8px',
              background: lastCmdResult.ok
                ? 'color-mix(in srgb, var(--acc) 7%, var(--panel))'
                : 'color-mix(in srgb, var(--bad) 10%, var(--panel))',
              border: `1px solid ${lastCmdResult.ok ? 'var(--line)' : 'var(--bad)'}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600 }}>
                {lastCmdResult.humanMessage}
              </div>
              {lastCmdResult.pythonSnippet && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => copyText(lastCmdResult.pythonSnippet, 'Python command')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                >
                  <ClipboardCopy size={12} />
                  <span>Copy Python</span>
                </button>
              )}
            </div>
            {lastCmdResult.pythonSnippet && (
              <pre
                className="mono"
                style={{
                  margin: '8px 0 0 0',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'var(--bg)',
                  border: '1px solid var(--line2)',
                  fontSize: '11.5px',
                  overflowX: 'auto',
                }}
              >
                {lastCmdResult.pythonSnippet}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* 4. POST-REACTION DILUTION PLANNER (diluter.py ONLY) */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '12px',
            flexWrap: 'wrap',
            marginBottom: '12px',
          }}
        >
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Droplets size={18} />
              Post-Reaction Dilution Planner (<span className="mono">diluter.py</span>)
            </h2>
            <p className="sub" style={{ margin: '2px 0 0 0' }}>
              Plans the exact 6-volume routine in <span className="mono">zeus-pipetter/diluter.py</span>{' '}
              for transferring crude reactions from Plate A (plate0) into Plate B (plate1) and
              optionally Plate C (plate2).
            </p>
          </div>
          <button
            type="button"
            className="btn sm pri"
            onClick={() => copyText(diluterPythonSnippet, 'diluter.py volumes')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <ClipboardCopy size={13} />
            <span>Copy diluter.py snippet</span>
          </button>
        </div>

        {/* Plate A baseline row */}
        <div className="row" style={{ marginBottom: '12px' }}>
          <div className="fld">
            <label className="lbl">Vials to dilute (1–54)</label>
            <input
              type="number"
              min={1}
              max={54}
              className="mono"
              value={diluterInput.vialCount}
              onChange={(e) =>
                setDiluterInput((p) => ({
                  ...p,
                  vialCount: Math.max(1, Math.min(54, Math.round(Number(e.target.value) || 1))),
                }))
              }
            />
          </div>
          <div className="fld">
            <label className="lbl">Crude volume in Plate A (µL)</label>
            <input
              type="number"
              min={0}
              max={2000}
              step={50}
              className="mono"
              value={diluterInput.crudeVolumeUl}
              onChange={(e) =>
                setDiluterInput((p) => ({
                  ...p,
                  crudeVolumeUl: Math.max(0, Number(e.target.value) || 0),
                }))
              }
            />
          </div>
          <div className="fld">
            <label className="lbl">Stage 1 solvent (A → B)</label>
            <select
              value={diluterInput.solvent0}
              onChange={(e) => setDiluterInput((p) => ({ ...p, solvent0: e.target.value }))}
            >
              {DILUTER_SOLVENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label className="lbl">Stage 1 jar location</label>
            <select
              value={`${diluterInput.solvent0JarPlate}:${diluterInput.solvent0JarPos}`}
              onChange={(e) => {
                const [pl, pos] = e.target.value.split(':').map(Number);
                setDiluterInput((p) => ({
                  ...p,
                  solvent0JarPlate: pl as 6 | 7,
                  solvent0JarPos: pos as 0 | 1,
                }));
              }}
            >
              <option value="6:0">plate6 · jar 0</option>
              <option value="6:1">plate6 · jar 1</option>
              <option value="7:0">plate7 · jar 0</option>
              <option value="7:1">plate7 · jar 1</option>
            </select>
          </div>
        </div>

        {/* Stage 1 volumes[0..2] */}
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '8px',
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            marginBottom: '12px',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>
            Stage 1: Plate A (plate0) → Plate B (plate1)
          </div>
          <div className="row">
            <div className="fld">
              <label className="lbl">Step 0 · Solvent → Plate A (µL)</label>
              <input
                type="number"
                min={0}
                max={1999}
                step={50}
                className="mono"
                value={diluterInput.volSolventToA}
                onChange={(e) =>
                  setDiluterInput((p) => ({
                    ...p,
                    volSolventToA: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </div>
            <div className="fld">
              <label className="lbl">Step 1 · Sample A → B (µL)</label>
              <input
                type="number"
                min={0}
                max={1999}
                step={10}
                className="mono"
                value={diluterInput.volAToB}
                onChange={(e) =>
                  setDiluterInput((p) => ({
                    ...p,
                    volAToB: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </div>
            <div className="fld">
              <label className="lbl">Step 2 · Solvent → Plate B (µL)</label>
              <input
                type="number"
                min={0}
                max={1999}
                step={50}
                className="mono"
                value={diluterInput.volSolventToB}
                onChange={(e) =>
                  setDiluterInput((p) => ({
                    ...p,
                    volSolventToB: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </div>
          </div>
        </div>

        {/* Optional Stage 2 toggle */}
        <label
          className="chk"
          style={{ display: 'flex', gap: '8px', cursor: 'pointer', marginBottom: '10px' }}
        >
          <input
            type="checkbox"
            checked={diluterInput.enableSecondStage}
            onChange={(e) =>
              setDiluterInput((p) => ({ ...p, enableSecondStage: e.target.checked }))
            }
          />
          <span>Add Stage 2 serial dilution: Plate B (plate1) → Plate C (plate2)</span>
        </label>

        {diluterInput.enableSecondStage && (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: 'var(--soft)',
              border: '1px solid var(--line)',
              marginBottom: '12px',
            }}
          >
            <div className="row" style={{ marginBottom: '8px' }}>
              <div className="fld">
                <label className="lbl">Stage 2 solvent (B → C)</label>
                <select
                  value={diluterInput.solvent1}
                  onChange={(e) => setDiluterInput((p) => ({ ...p, solvent1: e.target.value }))}
                >
                  {DILUTER_SOLVENTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label className="lbl">Stage 2 jar location</label>
                <select
                  value={`${diluterInput.solvent1JarPlate}:${diluterInput.solvent1JarPos}`}
                  onChange={(e) => {
                    const [pl, pos] = e.target.value.split(':').map(Number);
                    setDiluterInput((p) => ({
                      ...p,
                      solvent1JarPlate: pl as 6 | 7,
                      solvent1JarPos: pos as 0 | 1,
                    }));
                  }}
                >
                  <option value="6:0">plate6 · jar 0</option>
                  <option value="6:1">plate6 · jar 1</option>
                  <option value="7:0">plate7 · jar 0</option>
                  <option value="7:1">plate7 · jar 1</option>
                </select>
              </div>
            </div>

            <div className="row">
              <div className="fld">
                <label className="lbl">Step 3 · Extra solvent → B (µL)</label>
                <input
                  type="number"
                  min={0}
                  max={1999}
                  step={50}
                  className="mono"
                  value={diluterInput.volSolventToBExtra}
                  onChange={(e) =>
                    setDiluterInput((p) => ({
                      ...p,
                      volSolventToBExtra: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                />
              </div>
              <div className="fld">
                <label className="lbl">Step 4 · Sample B → C (µL)</label>
                <input
                  type="number"
                  min={0}
                  max={1999}
                  step={10}
                  className="mono"
                  value={diluterInput.volBToC}
                  onChange={(e) =>
                    setDiluterInput((p) => ({
                      ...p,
                      volBToC: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                />
              </div>
              <div className="fld">
                <label className="lbl">Step 5 · Solvent → Plate C (µL)</label>
                <input
                  type="number"
                  min={0}
                  max={1999}
                  step={50}
                  className="mono"
                  value={diluterInput.volSolventToC}
                  onChange={(e) =>
                    setDiluterInput((p) => ({
                      ...p,
                      volSolventToC: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* Warnings */}
        {diluterPlan.warnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {diluterPlan.warnings.map((w, idx) => (
              <div key={idx} className="issue bad">
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Summary metrics bar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: '10px',
            marginBottom: '14px',
          }}
        >
          <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--soft)', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Plate B dilution</div>
            <div className="mono" style={{ fontSize: '18px', fontWeight: 700 }}>
              {diluterPlan.totalFactorB}×
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
              {diluterPlan.plateBFinalUl} µL/vial final
            </div>
          </div>

          {diluterInput.enableSecondStage && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--soft)', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Plate C dilution</div>
              <div className="mono" style={{ fontSize: '18px', fontWeight: 700 }}>
                {diluterPlan.totalFactorC}×
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
                {diluterPlan.plateCFinalUl} µL/vial final
              </div>
            </div>
          )}

          <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--soft)', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Solvent jar fill</div>
            <div className="mono" style={{ fontSize: '18px', fontWeight: 700 }}>
              {diluterPlan.solvent0WithDeadMl} mL
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
              {diluterInput.solvent0} (incl. 7.4 mL dead)
              {diluterInput.enableSecondStage && diluterPlan.solvent1TotalMl > 0
                ? ` · Stage 2: ${diluterPlan.solvent1WithDeadMl} mL`
                : ''}
            </div>
          </div>

          <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--soft)', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11.5px', color: 'var(--mut)' }}>Tips &amp; run time</div>
            <div className="mono" style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Clock size={15} />
              <span>{diluterPlan.estimatedLabel}</span>
            </div>
            <div className="mono" style={{ fontSize: '11.5px', color: 'var(--fg2)' }}>
              50µL: {diluterPlan.tips[50]} · 300µL: {diluterPlan.tips[300]} · 1000µL:{' '}
              {diluterPlan.tips[1000]}
            </div>
          </div>
        </div>

        {/* Step breakdown table */}
        <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)', textAlign: 'left', color: 'var(--mut)', fontSize: '11.5px' }}>
                <th style={{ padding: '7px 10px 7px 0' }}>Stage</th>
                <th style={{ padding: '7px 10px' }}>Action</th>
                <th style={{ padding: '7px 10px', textAlign: 'right' }}>Per Vial</th>
                <th style={{ padding: '7px 10px', textAlign: 'right' }}>Total Liquid</th>
                <th style={{ padding: '7px 10px', textAlign: 'right' }}>Tips Needed</th>
              </tr>
            </thead>
            <tbody>
              {diluterPlan.steps
                .filter((s) => s.stage === 'A->B' || diluterInput.enableSecondStage)
                .map((s) => (
                  <tr
                    key={`${s.stage}-${s.stepId}`}
                    style={{
                      borderBottom: '1px solid var(--line2)',
                      opacity: s.active ? 1 : 0.45,
                    }}
                  >
                    <td className="mono" style={{ padding: '7px 10px 7px 0' }}>
                      {s.stage} #{s.stepId}
                    </td>
                    <td style={{ padding: '7px 10px' }}>{s.label}</td>
                    <td className="mono" style={{ padding: '7px 10px', textAlign: 'right' }}>
                      {s.active ? `${s.volumeUl} µL` : 'Skipped'}
                    </td>
                    <td className="mono" style={{ padding: '7px 10px', textAlign: 'right' }}>
                      {s.active ? `${s.totalVolumeMl} mL` : '—'}
                    </td>
                    <td className="mono" style={{ padding: '7px 10px', textAlign: 'right' }}>
                      {s.active && s.tipType
                        ? `${s.tipsNeeded} × ${s.tipType.replace('ul', ' µL')}`
                        : '0'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Ready-to-copy Python snippet */}
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'var(--soft)',
            border: '1px solid var(--line)',
            fontSize: '12px',
            overflowX: 'auto',
          }}
        >
          {diluterPythonSnippet}
        </pre>
      </div>
    </div>
  );
};
