import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Clock,
  Droplets,
  FlaskConical,
  Home,
  Keyboard,
  Lock,
  Move,
  PauseCircle,
  RefreshCw,
  Ruler,
  Scale,
  Server,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  DILUTER_SOLVENTS,
  calculateDiluterPlan,
  robotProfileForHood,
  surfaceHeight,
  volumeFromSurfaceHeight,
  type DiluterPlanInput,
} from '../../engine';
import {
  fetchRobotLiveStatus,
  sendRobotCommand,
  type RobotCommandResult,
  type RobotLiveStatus,
} from '../../engine/predictor/backendClient';
import { BenchsidePhoneRemote } from '../robot/BenchsidePhoneRemote';
import { ClickableDeckMap } from '../robot/ClickableDeckMap';
import { NanoDropPanel } from '../robot/NanoDropPanel';
import { PreRunChecklist } from '../robot/PreRunChecklist';
import { QuickTransferCard } from '../robot/QuickTransferCard';

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

function formatCountdown(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

const ALERTS_STORAGE_KEY = 'robowski.robotAlerts.v1';

interface AlertPrefs {
  enabled: boolean;
  sound: boolean;
}

function loadAlertPrefs(): AlertPrefs {
  try {
    const raw = window.localStorage.getItem(ALERTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { enabled: Boolean(parsed?.enabled), sound: parsed?.sound !== false };
    }
  } catch {}
  return { enabled: false, sound: true };
}

function playAlertChime(kind: 'done' | 'warn'): void {
  try {
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = kind === 'done' ? [587.33, 880.0] : [440.0, 349.23];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);
      gain.gain.setValueAtTime(0.001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.16 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.3);
    });
    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 900);
  } catch {}
}

interface CalibrationBottle {
  key: string;
  label: string;
  solvent: string;
  plateId: number;
  containerId: number;
  kind: 'bottle' | 'jar';
  prepMl: number;
  expectedZ: number;
  savedZ: number | null;
}

export const RobotView: React.FC = () => {
  const {
    state,
    setState,
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

  // Desktop & audio alert preferences
  const [alertPrefs, setAlertPrefs] = useState<AlertPrefs>(loadAlertPrefs);
  const prevAlertSnapshotRef = useRef<{
    seeded: boolean;
    state: RobotLiveStatus['state'] | null;
    percentComplete: number;
    runFile: string;
    lowRacks: Record<string, boolean>;
  }>({ seeded: false, state: null, percentComplete: 0, runFile: '', lowRacks: {} });

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

  // Guided Manual Liquid-Height Wizard + Keyboard Nudge Mode + Phone Remote
  const [wizardOpen, setWizardOpen] = useState<boolean>(false);
  const [wizardIdx, setWizardIdx] = useState<number>(0);
  const [wizardManualZ, setWizardManualZ] = useState<string>('');
  const [keyboardMode, setKeyboardMode] = useState<boolean>(false);
  const [remoteOpen, setRemoteOpen] = useState<boolean>(false);

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

  const runCommand = useCallback(
    async (command: string, params: Record<string, any> = {}): Promise<RobotCommandResult> => {
      setCmdBusy(true);
      setConfirmEstop(false);
      const res = await sendRobotCommand(command, params, backendUrl || undefined, controlPin || undefined);
      setLastCmdResult(res);
      setCmdBusy(false);
      if (res.ok) {
        if (res.hardware) {
          setLiveStatus((prev) => (prev ? { ...prev, hardware: res.hardware! } : prev));
        }
        toast(res.executed ? res.humanMessage : 'Preview snippet ready (read-only monitor mode).');
        if (res.executed) {
          refreshStatus(true);
        }
      } else {
        toast(res.humanMessage || 'Robot command failed.');
      }
      return res;
    },
    [backendUrl, controlPin, refreshStatus, toast]
  );

  // Persist alert preferences
  useEffect(() => {
    try {
      window.localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(alertPrefs));
    } catch {}
  }, [alertPrefs]);

  const fireRobotAlert = useCallback(
    (title: string, body: string, kind: 'done' | 'warn') => {
      if (alertPrefs.sound) {
        playAlertChime(kind);
      }
      toast(`${title}: ${body}`);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body });
        }
      } catch {}
    },
    [alertPrefs.sound, toast]
  );

  const toggleAlerts = async () => {
    if (alertPrefs.enabled) {
      setAlertPrefs((p) => ({ ...p, enabled: false }));
      toast('Robot alerts turned off.');
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {}
    }
    setAlertPrefs((p) => ({ ...p, enabled: true }));
    toast('Robot alerts ON — you will be notified when runs finish, pause, or tips run low.');
  };

  // Watch liveStatus transitions to fire one-shot alerts (never spamming)
  useEffect(() => {
    if (!liveStatus) return;
    const prev = prevAlertSnapshotRef.current;
    const curRunFile = liveStatus.activeRun?.relativePath || '';
    const curPct = liveStatus.activeRun?.percentComplete ?? 0;
    const curLowRacks: Record<string, boolean> = {};
    for (const r of liveStatus.tipRacks || []) {
      curLowRacks[r.tipType] = r.remaining <= 10;
    }

    if (!prev.seeded) {
      prevAlertSnapshotRef.current = {
        seeded: true,
        state: liveStatus.state,
        percentComplete: curPct,
        runFile: curRunFile,
        lowRacks: curLowRacks,
      };
      return;
    }

    if (alertPrefs.enabled) {
      if (
        curRunFile &&
        curRunFile === prev.runFile &&
        curPct >= 100 &&
        prev.percentComplete < 100
      ) {
        fireRobotAlert(
          'Robowski finished!',
          `All ${liveStatus.activeRun?.totalVials ?? ''} vials in ${liveStatus.activeRun?.fileName || 'your run'} are done.`,
          'done'
        );
      } else if (liveStatus.state === 'error' && prev.state !== 'error') {
        fireRobotAlert('Robowski needs attention', liveStatus.headline, 'warn');
      } else if (liveStatus.state === 'waiting_user' && prev.state !== 'waiting_user') {
        fireRobotAlert('Robowski is waiting for you', liveStatus.headline, 'warn');
      }

      for (const r of liveStatus.tipRacks || []) {
        if (curLowRacks[r.tipType] && !prev.lowRacks[r.tipType]) {
          fireRobotAlert(
            'Tip rack running low',
            `${r.tipType.replace('ul', ' µL')} rack has only ${r.remaining} tips left.`,
            'warn'
          );
        }
      }
    }

    prevAlertSnapshotRef.current = {
      seeded: true,
      state: liveStatus.state,
      percentComplete: curPct,
      runFile: curRunFile,
      lowRacks: curLowRacks,
    };
  }, [liveStatus, alertPrefs.enabled, fireRobotAlert]);

  // Build ordered list of bottles/jars in the current designed run for the Guided Manual Liquid-Height Wizard
  const calibrationBottles = useMemo<CalibrationBottle[]>(() => {
    if (!run) return [];
    const savedMap = state.measuredSurfaceZ || {};
    const list: CalibrationBottle[] = [];
    if (run.deck) {
      const sKind: 'bottle' | 'jar' = run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle';
      const sMl = Number(run.solventRecommendedMl) || 0;
      list.push({
        key: 'solvent',
        label: `Solvent (${run.reactionSolvent || 'reaction solvent'})`,
        solvent: run.reactionSolvent || '',
        plateId: run.deck.solvent_plate,
        containerId: run.deck.solvent_container,
        kind: sKind,
        prepMl: sMl,
        expectedZ: surfaceHeight(sKind, sMl * 1000),
        savedZ: typeof savedMap.solvent === 'number' ? savedMap.solvent : null,
      });
    }
    for (const [k, s] of Object.entries(run.stocks || {})) {
      if (s.source_only) continue;
      const ml = Number(s.prep_volume_ml) || 0;
      list.push({
        key: k,
        label: s.substance || k,
        solvent: s.solvent || '',
        plateId: s.breadboard_plate_id,
        containerId: s.container_id,
        kind: 'bottle',
        prepMl: ml,
        expectedZ: surfaceHeight('bottle', ml * 1000),
        savedZ: typeof savedMap[k] === 'number' ? savedMap[k] : null,
      });
    }
    return list;
  }, [run, state.measuredSurfaceZ]);

  const safeWizardIdx =
    calibrationBottles.length > 0 ? Math.min(wizardIdx, calibrationBottles.length - 1) : 0;
  const currentWizardBottle = calibrationBottles[safeWizardIdx] || null;
  const measuredBottleCount = calibrationBottles.filter((b) => b.savedZ !== null).length;

  const saveBottleZ = useCallback(
    async (bottle: CalibrationBottle, zValue: number, autoAdvance: boolean) => {
      const clamped = Math.max(500, Math.min(2200, Math.round(zValue)));
      setState((prev) => ({
        ...prev,
        measuredSurfaceZ: {
          ...(prev.measuredSurfaceZ || {}),
          [bottle.key]: clamped,
        },
      }));
      setWizardManualZ('');
      toast(`Saved ${bottle.label}: Z = ${clamped} (will export into Excel).`);

      if (!autoAdvance) return;

      // Find next unmeasured bottle (or next in list)
      const nextIdx = calibrationBottles.findIndex(
        (b, i) => i > safeWizardIdx && b.savedZ === null
      );
      const fallbackNext = safeWizardIdx + 1 < calibrationBottles.length ? safeWizardIdx + 1 : -1;
      const targetIdx = nextIdx !== -1 ? nextIdx : fallbackNext;

      if (targetIdx !== -1) {
        const nextBottle = calibrationBottles[targetIdx];
        setWizardIdx(targetIdx);
        if (isConnected && liveStatus?.hardware?.controlEnabled && liveStatus.hardware.connected) {
          // move_to_container automatically lifts arm to safe traverse height before moving XY
          await runCommand('move_to_container', {
            plate_id: nextBottle.plateId,
            container_id: nextBottle.containerId,
          });
        }
      } else {
        if (isConnected && liveStatus?.hardware?.controlEnabled && liveStatus.hardware.connected) {
          await runCommand('move_z_traverse');
        }
        toast('All bottle heights saved! Ready to export your Excel workbook.');
      }
    },
    [
      calibrationBottles,
      isConnected,
      liveStatus?.hardware?.connected,
      liveStatus?.hardware?.controlEnabled,
      runCommand,
      safeWizardIdx,
      setState,
      toast,
    ]
  );

  const clearSavedBottleZ = (key?: string) => {
    setState((prev) => {
      if (!key) {
        const next = { ...prev };
        delete next.measuredSurfaceZ;
        return next;
      }
      const nextMap = { ...(prev.measuredSurfaceZ || {}) };
      delete nextMap[key];
      return { ...prev, measuredSurfaceZ: nextMap };
    });
    toast(key ? 'Cleared saved height.' : 'Cleared all saved liquid heights.');
  };

  // Keyboard Nudge Mode listener (ArrowUp / ArrowDown / 1-2-3 / Space / Enter / Esc)
  useEffect(() => {
    if (!keyboardMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setKeyboardMode(false);
        toast('Keyboard Mode turned off.');
        return;
      }
      if (e.key === '1') {
        e.preventDefault();
        setZStepUnits(10);
        return;
      }
      if (e.key === '2') {
        e.preventDefault();
        setZStepUnits(50);
        return;
      }
      if (e.key === '3') {
        e.preventDefault();
        setZStepUnits(100);
        return;
      }
      if (e.repeat || cmdBusy) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === ' ') {
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        runCommand('move_z_rel', { dz: -zStepUnits });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        runCommand('move_z_rel', { dz: zStepUnits });
      } else if (e.key === ' ') {
        e.preventDefault();
        runCommand('move_z_traverse');
      } else if (
        e.key === 'Enter' &&
        wizardOpen &&
        currentWizardBottle &&
        liveStatus?.hardware?.currentZ != null
      ) {
        e.preventDefault();
        saveBottleZ(currentWizardBottle, liveStatus.hardware.currentZ, true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    keyboardMode,
    cmdBusy,
    zStepUnits,
    runCommand,
    wizardOpen,
    currentWizardBottle,
    liveStatus?.hardware?.currentZ,
    saveBottleZ,
    toast,
  ]);

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
    <div className="wrap robot-page">
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
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
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
          <div
            className="robot-banner-actions"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
          >
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
                  onClick={toggleAlerts}
                  title="Notify you on your desk PC when a run finishes, pauses, or tips run low"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    borderColor: alertPrefs.enabled
                      ? 'color-mix(in srgb, var(--ok) 55%, var(--line))'
                      : undefined,
                    color: alertPrefs.enabled ? 'var(--ok)' : undefined,
                  }}
                >
                  {alertPrefs.enabled ? <Bell size={13} /> : <BellOff size={13} />}
                  <span>Alerts {alertPrefs.enabled ? 'On' : 'Off'}</span>
                </button>

                {alertPrefs.enabled && (
                  <>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setAlertPrefs((p) => ({ ...p, sound: !p.sound }))}
                      title={alertPrefs.sound ? 'Mute alert chime' : 'Turn on alert chime'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      {alertPrefs.sound ? <Volume2 size={13} /> : <VolumeX size={13} />}
                      <span>{alertPrefs.sound ? 'Chime' : 'Muted'}</span>
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        fireRobotAlert(
                          'Robowski Alerts Ready',
                          'You will be alerted here when runs finish, pause, or tips run low.',
                          'done'
                        )
                      }
                      style={{ fontSize: '11.5px' }}
                    >
                      Test
                    </button>
                  </>
                )}

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
              className="mono robot-select-full"
              style={{
                width: '100%',
                maxWidth: '460px',
                minWidth: 0,
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

      {/* 2.5 READY FOR MAIN.PY PRE-RUN CHECKLIST */}
      <PreRunChecklist
        isConnected={isConnected}
        liveStatus={liveStatus}
        hw={hw}
        tipRacks={tipRacks}
        run={run}
        measuredBottleCount={measuredBottleCount}
        totalCalibrationBottles={calibrationBottles.length}
        cmdBusy={cmdBusy}
        onReleaseUsb={() => runCommand('disconnect_hardware')}
        onDropTip={() => runCommand('discard_tip')}
        onOpenHeightWizard={() => setWizardOpen(true)}
      />

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

          {/* Right side: Phone Remote launcher + Control PIN */}
          <div
            className="robot-pin-row"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
          >
            <button
              type="button"
              className="btn sm"
              onClick={() => setRemoteOpen(true)}
              title="Open large thumb-friendly remote for holding a phone at the fume hood"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Smartphone size={13} />
              <span>Phone Remote</span>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 150px' }}>
              <Lock size={14} style={{ color: 'var(--mut)', flexShrink: 0 }} />
              <input
                type="password"
                inputMode="numeric"
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
        </div>

        {/* 4 Command Groups in a clean responsive grid */}
        <div
          className="robot-cmd-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
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
              {hw?.connected && hw.idleSecondsRemaining != null && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11.5px',
                    color: 'var(--mut)',
                    padding: '0 4px',
                  }}
                  title="If no robot button is clicked before this timer reaches zero, USB ports are released automatically so main.py never hits a port-busy error."
                >
                  <Clock size={12} />
                  <span>Auto-free in {formatCountdown(hw.idleSecondsRemaining)}</span>
                </span>
              )}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setKeyboardMode((v) => !v)}
                  title="Use keyboard ↑ / ↓ arrow keys to nudge tip height while watching the vial"
                  style={{
                    fontSize: '11px',
                    padding: '2px 7px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    borderColor: keyboardMode ? 'var(--acc)' : undefined,
                    color: keyboardMode ? 'var(--acc)' : undefined,
                    background: keyboardMode
                      ? 'color-mix(in srgb, var(--acc) 10%, var(--panel))'
                      : undefined,
                  }}
                >
                  <Keyboard size={12} />
                  <span>{keyboardMode ? 'Keys ON' : 'Keyboard'}</span>
                </button>
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

        {/* Active Keyboard Mode Banner */}
        {keyboardMode && (
          <div
            style={{
              marginTop: '12px',
              padding: '9px 12px',
              borderRadius: '8px',
              background: 'color-mix(in srgb, var(--acc) 10%, var(--panel))',
              border: '1px solid color-mix(in srgb, var(--acc) 55%, var(--line))',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              fontSize: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <Keyboard size={15} style={{ color: 'var(--acc)' }} />
              <strong>Keyboard Mode ON</strong>
              <span style={{ color: 'var(--fg2)' }}>
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>↑</kbd>{' '}
                Raise ·{' '}
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>↓</kbd>{' '}
                Lower ({zStepUnits / 10} mm) ·{' '}
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>1</kbd>/
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>2</kbd>/
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>3</kbd>{' '}
                Step 1/5/10 mm ·{' '}
                <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>Space</kbd>{' '}
                Lift Safe
                {wizardOpen ? (
                  <>
                    {' '}·{' '}
                    <kbd style={{ padding: '1px 5px', border: '1px solid var(--line)', borderRadius: '4px', background: 'var(--panel)' }}>Enter</kbd>{' '}
                    Save Z &amp; Next
                  </>
                ) : null}
              </span>
            </div>
            <button
              type="button"
              className="btn sm"
              onClick={() => setKeyboardMode(false)}
              style={{ fontSize: '11.5px' }}
            >
              Turn Off (Esc)
            </button>
          </div>
        )}

        {/* Guided Manual Liquid-Height Wizard */}
        <div
          style={{
            marginTop: '14px',
            borderRadius: '8px',
            border: '1px solid var(--line)',
            background: 'var(--soft)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <Ruler size={15} style={{ color: 'var(--acc)' }} />
              <strong style={{ fontSize: '13px' }}>Guided Bottle Height Check</strong>
              <span style={{ fontSize: '12px', color: 'var(--mut)' }}>
                {calibrationBottles.length > 0
                  ? `${measuredBottleCount} of ${calibrationBottles.length} bottles measured · auto-fills Excel liquid_surface_height`
                  : 'Design a run in Reagents / Deck first to step through its bottles here'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {measuredBottleCount > 0 && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => clearSavedBottleZ()}
                  style={{ fontSize: '11.5px', color: 'var(--mut)' }}
                >
                  Clear Saved
                </button>
              )}
              <button
                type="button"
                className={wizardOpen ? 'btn sm' : 'btn sm pri'}
                disabled={calibrationBottles.length === 0}
                onClick={() => setWizardOpen((v) => !v)}
              >
                {wizardOpen ? 'Hide Wizard' : 'Start Height Check'}
              </button>
            </div>
          </div>

          {wizardOpen && currentWizardBottle && (
            <div
              style={{
                padding: '12px 14px 14px',
                borderTop: '1px solid var(--line)',
                background: 'var(--panel)',
              }}
            >
              {/* Bottle Selector Strip */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                  marginBottom: '12px',
                }}
              >
                {calibrationBottles.map((b, idx) => {
                  const isActive = idx === safeWizardIdx;
                  const isDone = b.savedZ !== null;
                  return (
                    <button
                      key={b.key}
                      type="button"
                      onClick={() => {
                        setWizardIdx(idx);
                        setWizardManualZ('');
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '5px 9px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        border: isActive
                          ? '1.5px solid var(--acc)'
                          : isDone
                          ? '1px solid color-mix(in srgb, var(--ok) 50%, var(--line))'
                          : '1px solid var(--line)',
                        background: isActive
                          ? 'color-mix(in srgb, var(--acc) 10%, var(--panel))'
                          : isDone
                          ? 'color-mix(in srgb, var(--ok) 8%, var(--panel))'
                          : 'var(--soft)',
                        color: 'var(--fg)',
                        fontWeight: isActive ? 700 : 500,
                      }}
                    >
                      {isDone && <Check size={12} style={{ color: 'var(--ok)' }} />}
                      <span>{b.label}</span>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--mut)' }}>
                        P{b.plateId}:{b.containerId}
                      </span>
                      {isDone && (
                        <span className="mono" style={{ fontSize: '11px', color: 'var(--ok)' }}>
                          Z={b.savedZ}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Active Bottle Step Controls */}
              <div
                style={{
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid var(--line)',
                  background: 'var(--soft)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '10px',
                    flexWrap: 'wrap',
                    marginBottom: '10px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '13.5px', fontWeight: 700 }}>
                      Bottle {safeWizardIdx + 1} of {calibrationBottles.length}:{' '}
                      {currentWizardBottle.label}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--fg2)', marginTop: '2px' }}>
                      Deck slot{' '}
                      <span className="mono" style={{ fontWeight: 600 }}>
                        plate{currentWizardBottle.plateId}, pos {currentWizardBottle.containerId}
                      </span>{' '}
                      · Planned fill{' '}
                      <span className="mono">{currentWizardBottle.prepMl.toFixed(1)} mL</span> ·
                      Expected Z ≈ <span className="mono">{currentWizardBottle.expectedZ}</span>
                      {currentWizardBottle.savedZ !== null && (
                        <>
                          {' '}·{' '}
                          <strong style={{ color: 'var(--ok)' }}>
                            Saved Z = {currentWizardBottle.savedZ}
                          </strong>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Live Z + implied mL readout */}
                  <div style={{ textAlign: 'right', fontSize: '12px' }}>
                    <div>
                      Current Tip Z:{' '}
                      <strong className="mono" style={{ fontSize: '14px' }}>
                        {hw?.currentZ != null ? hw.currentZ : '—'}
                      </strong>
                    </div>
                    {hw?.currentZ != null && (
                      <div style={{ color: 'var(--mut)', fontSize: '11.5px' }}>
                        ≈{' '}
                        {Math.max(
                          0,
                          volumeFromSurfaceHeight(currentWizardBottle.kind, hw.currentZ) / 1000
                        ).toFixed(1)}{' '}
                        mL in {currentWizardBottle.kind}
                      </div>
                    )}
                  </div>
                </div>

                {/* Guided Action Row */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  {!hw?.currentTip && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={cmdBusy}
                      onClick={() => runCommand('pick_tip', { tip_type: '300ul' })}
                    >
                      1. Pick 300 µL Tip
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm pri"
                    disabled={cmdBusy}
                    onClick={() =>
                      runCommand('move_to_container', {
                        plate_id: currentWizardBottle.plateId,
                        container_id: currentWizardBottle.containerId,
                      })
                    }
                  >
                    Move Over Bottle
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={cmdBusy}
                    onClick={() => {
                      const approachZ = Math.max(
                        900,
                        Math.min(2100, currentWizardBottle.expectedZ - 150)
                      );
                      runCommand('move_z', { z: approachZ });
                    }}
                    title="Move tip 15 mm above expected liquid level so you can step down gently"
                  >
                    Approach (Z={Math.max(900, Math.min(2100, currentWizardBottle.expectedZ - 150))})
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={cmdBusy}
                    onClick={() => runCommand('move_z_rel', { dz: -zStepUnits })}
                  >
                    <ArrowUp size={12} /> Raise
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={cmdBusy}
                    onClick={() => runCommand('move_z_rel', { dz: zStepUnits })}
                  >
                    <ArrowDown size={12} /> Lower
                  </button>
                  <select
                    aria-label="Wizard Z step size"
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
                    <option value={10}>1 mm</option>
                    <option value={50}>5 mm</option>
                    <option value={100}>10 mm</option>
                  </select>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setKeyboardMode((v) => !v)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      borderColor: keyboardMode ? 'var(--acc)' : undefined,
                      color: keyboardMode ? 'var(--acc)' : undefined,
                    }}
                  >
                    <Keyboard size={12} />
                    <span>{keyboardMode ? 'Keys ON' : 'Keyboard Mode'}</span>
                  </button>
                </div>

                {/* Save Height Row */}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                    alignItems: 'center',
                    marginTop: '10px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--line2)',
                  }}
                >
                  <button
                    type="button"
                    className="btn sm pri"
                    disabled={cmdBusy || hw?.currentZ == null}
                    onClick={() => {
                      if (hw?.currentZ != null) {
                        saveBottleZ(currentWizardBottle, hw.currentZ, true);
                      }
                    }}
                    style={{
                      background: 'var(--ok)',
                      borderColor: 'var(--ok)',
                      color: '#ffffff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <Check size={13} />
                    <span>
                      Save Z={hw?.currentZ ?? '—'} &amp;{' '}
                      {safeWizardIdx + 1 < calibrationBottles.length ? 'Move Next' : 'Finish'}
                    </span>
                  </button>

                  <span style={{ fontSize: '11.5px', color: 'var(--mut)' }}>or type Z:</span>
                  <input
                    type="number"
                    min={500}
                    max={2200}
                    placeholder={String(currentWizardBottle.savedZ ?? currentWizardBottle.expectedZ)}
                    value={wizardManualZ}
                    onChange={(e) => setWizardManualZ(e.target.value)}
                    className="mono"
                    style={{
                      width: '78px',
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
                    className="btn sm"
                    disabled={!wizardManualZ.trim()}
                    onClick={() => {
                      const val = Number(wizardManualZ);
                      if (Number.isFinite(val) && val >= 500 && val <= 2200) {
                        saveBottleZ(currentWizardBottle, val, false);
                      } else {
                        toast('Enter a Z height between 500 and 2200.');
                      }
                    }}
                  >
                    Save Typed Z
                  </button>
                  {currentWizardBottle.savedZ !== null && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => clearSavedBottleZ(currentWizardBottle.key)}
                      style={{ fontSize: '11.5px', color: 'var(--mut)' }}
                    >
                      Clear Bottle
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Clickable Breadboard Deck Map */}
        <ClickableDeckMap
          run={run}
          measuredSurfaceZ={state.measuredSurfaceZ}
          selectedPlate={targetPlate}
          selectedSlot={targetSlot}
          cmdBusy={cmdBusy}
          onSelectSlot={(plateId, slotId, moveImmediately) => {
            setTargetPlate(plateId);
            setTargetSlot(slotId);
            if (moveImmediately) {
              runCommand('move_to_container', { plate_id: plateId, container_id: slotId });
            }
          }}
          onMoveSelected={() =>
            runCommand('move_to_container', { plate_id: targetPlate, container_id: targetSlot })
          }
        />

        {/* Quick One-Off & Plate-to-Plate Liquid Transfer */}
        <QuickTransferCard
          run={run}
          measuredSurfaceZ={state.measuredSurfaceZ}
          hw={hw}
          tipRacks={tipRacks}
          cmdBusy={cmdBusy}
          selectedPlate={targetPlate}
          selectedSlot={targetSlot}
          onRunCommand={runCommand}
        />

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

      {/* 3.5 NANODROP UV-VIS STUDIO (HARDWARE + XML VIEWER & DECONVOLUTION) */}
      <NanoDropPanel
        hw={hw}
        cmdBusy={cmdBusy}
        onRunCommand={runCommand}
        onToast={toast}
      />

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
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 165px), 1fr))',
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

      {/* Mobile-only sticky benchside quick-dock (hidden on desktop PC) */}
      <div className="robot-mobile-dock" aria-label="Quick benchside mobile controls">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', lineHeight: 1.1 }}>Tip Height</div>
          <div className="mono" style={{ fontSize: '14px', fontWeight: 800 }}>
            {hw?.currentZ != null ? `Z=${hw.currentZ}` : 'Z=—'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap' }}>
          <button
            type="button"
            className="btn pri"
            onClick={() => setRemoteOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Smartphone size={14} />
            <span>Remote</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={cmdBusy}
            onClick={() => runCommand('move_z_traverse')}
          >
            Lift Safe
          </button>
          {hw?.connected && (
            <button
              type="button"
              className="btn"
              disabled={cmdBusy}
              onClick={() => runCommand('disconnect_hardware')}
              style={{
                color: 'var(--warn)',
                borderColor: 'color-mix(in srgb, var(--warn) 60%, var(--line))',
              }}
            >
              Free USB
            </button>
          )}
        </div>
      </div>

      {/* Full-screen Phone-Friendly Benchside Remote */}
      <BenchsidePhoneRemote
        open={remoteOpen}
        onClose={() => setRemoteOpen(false)}
        hw={hw}
        controlPin={controlPin}
        onControlPinChange={setControlPin}
        cmdBusy={cmdBusy}
        zStepUnits={zStepUnits}
        onChangeZStep={setZStepUnits}
        bottles={calibrationBottles}
        bottleIdx={safeWizardIdx}
        onChangeBottleIdx={setWizardIdx}
        onRunCommand={runCommand}
        onSaveBottleZ={(bottle, zVal, autoAdv) => {
          const full = calibrationBottles.find((b) => b.key === bottle.key);
          return full ? saveBottleZ(full, zVal, autoAdv) : Promise.resolve();
        }}
        onCopyZ={(z) => copyText(String(z), `Z = ${z}`)}
        lastFeedback={lastCmdResult?.humanMessage}
      />
    </div>
  );
};
