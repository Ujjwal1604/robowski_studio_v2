import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Info,
  XCircle,
} from 'lucide-react';
import type { RunResult } from '../../types';
import type {
  RobotHardwareState,
  RobotLiveStatus,
  RobotTipRackSummary,
} from '../../engine/predictor/backendClient';

interface PreRunChecklistProps {
  isConnected: boolean;
  liveStatus: RobotLiveStatus | null;
  hw?: RobotHardwareState;
  tipRacks: RobotTipRackSummary[];
  run: RunResult | null;
  measuredBottleCount: number;
  totalCalibrationBottles: number;
  cmdBusy: boolean;
  onReleaseUsb: () => void;
  onDropTip: () => void;
  onOpenHeightWizard: () => void;
}

interface CheckItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'bad' | 'info';
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}

function formatIdleRem(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export const PreRunChecklist: React.FC<PreRunChecklistProps> = ({
  isConnected,
  liveStatus,
  hw,
  tipRacks,
  run,
  measuredBottleCount,
  totalCalibrationBottles,
  cmdBusy,
  onReleaseUsb,
  onDropTip,
  onOpenHeightWizard,
}) => {
  const items: CheckItem[] = [];

  // 1. USB Ports Free for main.py
  if (!isConnected) {
    items.push({
      id: 'usb',
      label: 'USB Ports',
      status: 'info',
      detail: 'Lab PC offline — connect to check helper USB lock.',
    });
  } else if (hw?.connected) {
    const rem = formatIdleRem(hw.idleSecondsRemaining);
    items.push({
      id: 'usb',
      label: 'USB Ports',
      status: 'warn',
      detail: rem
        ? `Helper is connected (auto-frees in ${rem}). Release before running main.py.`
        : 'Helper is connected — click Release USB before starting main.py.',
      actionLabel: 'Release USB',
      onAction: onReleaseUsb,
    });
  } else {
    items.push({
      id: 'usb',
      label: 'USB Ports',
      status: 'ok',
      detail: 'Free — main.py can connect without port-busy errors.',
    });
  }

  // 2. No Stray Tip Attached
  if (hw?.currentTip) {
    items.push({
      id: 'tip_head',
      label: 'Pipette Head',
      status: 'warn',
      detail: `A ${hw.currentTip.replace('ul', ' µL')} tip is still attached.`,
      actionLabel: 'Drop Tip',
      onAction: onDropTip,
    });
  } else {
    items.push({
      id: 'tip_head',
      label: 'Pipette Head',
      status: 'ok',
      detail: 'No tip attached — ready to start cleanly.',
    });
  }

  // 3. Tip Racks vs Current Run Requirement
  if (run?.tipCounts) {
    const needed: Array<{ key: '50ul' | '300ul' | '1000ul'; label: string; req: number }> = [
      { key: '50ul', label: '50 µL', req: run.tipCounts[50] || 0 },
      { key: '300ul', label: '300 µL', req: run.tipCounts[300] || 0 },
      { key: '1000ul', label: '1000 µL', req: run.tipCounts[1000] || 0 },
    ];
    const shortList: string[] = [];
    for (const n of needed) {
      if (n.req <= 0) continue;
      const liveRack = tipRacks.find((r) => r.tipType === n.key);
      if (liveRack && liveRack.remaining < n.req) {
        shortList.push(`${n.label} (need ${n.req}, have ${liveRack.remaining})`);
      }
    }
    if (shortList.length > 0) {
      items.push({
        id: 'tip_racks',
        label: 'Tip Racks',
        status: 'bad',
        detail: `Reload needed: ${shortList.join('; ')}.`,
      });
    } else {
      const totalReq = (run.tipCounts[50] || 0) + (run.tipCounts[300] || 0) + (run.tipCounts[1000] || 0);
      items.push({
        id: 'tip_racks',
        label: 'Tip Racks',
        status: 'ok',
        detail: `All racks cover this run's ${totalReq} tips.`,
      });
    }
  } else {
    const lowRacks = tipRacks.filter((r) => r.remaining <= 10);
    items.push({
      id: 'tip_racks',
      label: 'Tip Racks',
      status: lowRacks.length > 0 ? 'warn' : 'ok',
      detail:
        lowRacks.length > 0
          ? `Low tips: ${lowRacks.map((r) => `${r.tipType.replace('ul', ' µL')} (${r.remaining})`).join(', ')}.`
          : 'All 3 tip racks look healthy.',
    });
  }

  // 4. Manual Bottle Z Heights
  if (totalCalibrationBottles === 0) {
    items.push({
      id: 'heights',
      label: 'Bottle Heights',
      status: 'info',
      detail: 'Design a run first to track manual Z heights.',
    });
  } else if (measuredBottleCount >= totalCalibrationBottles) {
    items.push({
      id: 'heights',
      label: 'Bottle Heights',
      status: 'ok',
      detail: `All ${totalCalibrationBottles} bottle Z heights measured & saved for Excel.`,
    });
  } else {
    items.push({
      id: 'heights',
      label: 'Bottle Heights',
      status: 'warn',
      detail: `${measuredBottleCount} of ${totalCalibrationBottles} measured (rest use formula).`,
      actionLabel: 'Height Check',
      onAction: onOpenHeightWizard,
    });
  }

  // 5. Robot PC Helper & Error Status
  if (!isConnected) {
    items.push({
      id: 'helper',
      label: 'Robot Status',
      status: 'info',
      detail: 'Connect Lab PC to see live helper status.',
    });
  } else if (liveStatus?.state === 'error') {
    items.push({
      id: 'helper',
      label: 'Robot Status',
      status: 'bad',
      detail: liveStatus.headline || 'Active error reported in robot log.',
    });
  } else if (liveStatus?.relaySource === 'robot_pc_agent' && liveStatus.agentOnline === false) {
    items.push({
      id: 'helper',
      label: 'Robot Status',
      status: 'warn',
      detail: 'Robot PC helper is not sending updates right now.',
    });
  } else {
    items.push({
      id: 'helper',
      label: 'Robot Status',
      status: 'ok',
      detail: 'No errors — helper synced cleanly.',
    });
  }

  const attentionCount = items.filter((i) => i.status === 'warn' || i.status === 'bad').length;

  return (
    <div className="card" style={{ marginBottom: '20px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
          marginBottom: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ClipboardCheck size={17} style={{ color: attentionCount === 0 ? 'var(--ok)' : 'var(--warn)' }} />
          <h2 style={{ margin: 0, fontSize: '15.5px' }}>Ready for main.py?</h2>
        </div>
        <span
          style={{
            fontSize: '12.5px',
            fontWeight: 600,
            color: attentionCount === 0 ? 'var(--ok)' : 'var(--warn)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          {attentionCount === 0 ? (
            <>
              <CheckCircle2 size={14} />
              <span>All clear — ready to run main.py</span>
            </>
          ) : (
            <>
              <Clock size={14} />
              <span>
                {attentionCount} item{attentionCount === 1 ? '' : 's'} to check before starting
              </span>
            </>
          )}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))',
          gap: '10px',
        }}
      >
        {items.map((item) => {
          const borderColor =
            item.status === 'ok'
              ? 'color-mix(in srgb, var(--ok) 40%, var(--line))'
              : item.status === 'bad'
              ? 'color-mix(in srgb, var(--bad) 50%, var(--line))'
              : item.status === 'warn'
              ? 'color-mix(in srgb, var(--warn) 50%, var(--line))'
              : 'var(--line)';
          const bg =
            item.status === 'ok'
              ? 'color-mix(in srgb, var(--ok) 6%, var(--panel))'
              : item.status === 'bad'
              ? 'color-mix(in srgb, var(--bad) 8%, var(--panel))'
              : item.status === 'warn'
              ? 'color-mix(in srgb, var(--warn) 8%, var(--panel))'
              : 'var(--soft)';
          const iconColor =
            item.status === 'ok'
              ? 'var(--ok)'
              : item.status === 'bad'
              ? 'var(--bad)'
              : item.status === 'warn'
              ? 'var(--warn)'
              : 'var(--mut)';

          return (
            <div
              key={item.id}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1px solid ${borderColor}`,
                background: bg,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    marginBottom: '4px',
                  }}
                >
                  {item.status === 'ok' ? (
                    <CheckCircle2 size={14} style={{ color: iconColor, flexShrink: 0 }} />
                  ) : item.status === 'bad' ? (
                    <XCircle size={14} style={{ color: iconColor, flexShrink: 0 }} />
                  ) : item.status === 'warn' ? (
                    <AlertTriangle size={14} style={{ color: iconColor, flexShrink: 0 }} />
                  ) : (
                    <Info size={14} style={{ color: iconColor, flexShrink: 0 }} />
                  )}
                  <span>{item.label}</span>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--fg2)', lineHeight: 1.4 }}>
                  {item.detail}
                </div>
              </div>

              {item.actionLabel && item.onAction && (
                <div>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={cmdBusy}
                    onClick={item.onAction}
                    style={{ fontSize: '11.5px', padding: '3px 9px' }}
                  >
                    {item.actionLabel}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
