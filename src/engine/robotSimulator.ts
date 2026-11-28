// Robowski Studio — 1-to-1 Virtual Robot Simulator & Accident Detector
// Mirrors robot_safety.py, robot_pc_agent.py, breadboard.py, and main_auto_liquid_height.py

import {
  CONTAINER_GEOMETRY,
  TIP_RACK_CAPACITY,
  robotProfileForHood,
} from './constants';
import { surfaceHeightExact } from './deckTiming';
import type { RunResult } from '../types';
import type {
  RobotCommandResult,
  RobotHardwareState,
  RobotLiveStatus,
  RobotPlatePreset,
  RobotPlateTransferState,
  RobotTipRackSummary,
} from './predictor/backendClient';

export type SimSpeed = 1 | 5 | 20 | 0; // 0 = instant

export type SimAccidentSeverity = 'crash' | 'hazard' | 'warning';

export interface SimAccident {
  id: string;
  ts: string;
  severity: SimAccidentSeverity;
  category:
    | 'xy_crash'
    | 'z_crash'
    | 'home_with_tip'
    | 'unhomed_move'
    | 'dry_aspiration'
    | 'overflow'
    | 'tip_mismatch'
    | 'double_tip'
    | 'rack_empty'
    | 'cross_contamination'
    | 'out_of_bounds'
    | 'validation';
  title: string;
  detail: string;
  command: string;
  plateId?: number;
  slotId?: number;
  xy?: [number, number];
}

export interface SimLogEntry {
  id: string;
  ts: string;
  level: 'info' | 'ok' | 'warning' | 'crash';
  command: string;
  message: string;
}

export interface SimContainerState {
  key: string; // "plate:slot"
  plateId: number;
  slotId: number;
  kind: 'vial' | 'bottle' | 'jar';
  label: string;
  solvent: string;
  volumeUl: number;
  initialVolumeUl: number;
  capacityUl: number;
  bottomZ: number;
  areaMm2: number;
  deadVolumeUl: number;
  contaminants: string[];
}

export interface SimTrailPoint {
  xy: [number, number];
  z: number;
  kind: 'move' | 'aspirate' | 'dispense' | 'crash';
}

export interface SimPlannedStep {
  label: string;
  srcPlate: number;
  srcSlot: number;
  dstPlate: number;
  dstSlot: number;
  volumeUl: number;
  solvent: string;
  tipType: 'auto' | '50ul' | '300ul' | '1000ul';
  srcZ: number;
  dstZ: number;
  substance: string;
  pickTip: boolean;
  dropTip: boolean;
}

export interface SimSnapshot {
  hood: 'left' | 'right';
  hardware: RobotHardwareState;
  tipRacks: RobotTipRackSummary[];
  containers: Record<string, SimContainerState>;
  activeVesselKey: string | null;
  activeLiquidPhase: 'idle' | 'moving' | 'aspirating' | 'dispensing' | 'tip_action';
  trail: SimTrailPoint[];
  accidents: SimAccident[];
  log: SimLogEntry[];
  tipContaminant: string | null;
  tipLiquidUl: number;
  balanceMassMg: number;
  emergencyStopped: boolean;
  lastAccidentXY: [number, number] | null;
  stepCount: number;
}

export const SIM_ALLOWED_SOLVENTS = new Set([
  'water',
  'ethanol',
  'DMF',
  'Dioxane',
  'DCE',
  'MeCN',
  'CHCl3',
  'DMSO',
  'glycerin',
  'TolueneMix',
  'serum',
  'hbrhac1v1',
  'waterft',
  'ethanolft',
]);

export const SIM_TIP_CAPACITY: Record<'50ul' | '300ul' | '1000ul', number> = {
  '50ul': 50,
  '300ul': 300,
  '1000ul': 1000,
};

const COMMANDS_ALLOWED_WITHOUT_HOMING = new Set([
  'init_hardware',
  'disconnect_hardware',
  'home_xy',
  'move_z_traverse',
  'kill_alarm',
  'emergency_stop',
  'discard_tip',
  'check_tip_status',
  'read_instrument_status',
  'read_xy_position',
  'reload_tip_rack',
  'mark_tips_used',
  'save_plate_preset',
  'delete_plate_preset',
  'plate_transfer_stop',
  'nanodrop_connect',
  'nanodrop_disconnect',
  'nanodrop_lid_open',
  'nanodrop_lid_close',
  'nanodrop_lid_half_open',
  'nanodrop_flush',
  'nanodrop_dry',
  'nanodrop_wash_cycle',
  'nanodrop_close_all',
]);

const ROW_LETTERS = 'ABCDEFGHIJKLMNOP';

export function formatSimWellName(wellIdx: number, cols: number): string {
  const safeCols = Math.max(1, cols);
  const r = Math.floor(wellIdx / safeCols);
  const c = (wellIdx % safeCols) + 1;
  const rowLbl = r >= 0 && r < ROW_LETTERS.length ? ROW_LETTERS[r] : `R${r + 1}`;
  return `${rowLbl}${c}`;
}

export const SIM_DECK_BOUNDS = {
  minX: -520,
  maxX: 15,
  minY: -425,
  maxY: 15,
};

export interface DeckRegionBox {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 1-to-1 Robowski#2 front-facing physical layout (matching hood optical breadboard):
 *   Back row (L -> R):  1000 µL tips | 300 µL tips | 50 µL tips
 *   Deck row 3 (back):  plate6 (2 jars, white/pink) | plate7 (2 jars, yellow/red) | Tip Trash (black box, [-380,-160])
 *   Deck row 2 (mid):   plate5 (8 bottles, black/red) | plate4 (8 bottles, red/green) | plate2 (54 vials, red #2)
 *   Deck row 1 (front): plate0 (54 vials, green #0) | plate1 (54 vials, red/green #1) | plate3 (8 bottles, blue/yellow)
 *   Right side (off rail): Balance (back-right) | NanoDrop 2000c (front-right)
 * Note: x is minX (right edge), x + w is maxX (left edge); y is minY (front edge), y + h is maxY (back edge).
 */
export const SIM_DECK_LAYOUT: Record<string, DeckRegionBox> = {
  // Back row: 3 red tip rack towers (left to right: 1000uL, 300uL, 50uL)
  rack_1000ul: { id: 'rack_1000ul', label: '1000 µL Tips', x: -144, y: -102, w: 112, h: 68 },
  rack_300ul: { id: 'rack_300ul', label: '300 µL Tips', x: -268, y: -102, w: 112, h: 68 },
  rack_50ul: { id: 'rack_50ul', label: '50 µL Tips', x: -392, y: -102, w: 112, h: 68 },

  // Row 3 (back of black slotted breadboard)
  plate6: { id: 'plate6', label: 'plate6 · Jars', x: -144, y: -202, w: 112, h: 82 },
  plate7: { id: 'plate7', label: 'plate7 · Jars', x: -268, y: -202, w: 112, h: 82 },
  trash: { id: 'trash', label: 'Tip Trash', x: -392, y: -202, w: 112, h: 82 },

  // Row 2 (middle of black slotted breadboard)
  plate5: { id: 'plate5', label: 'plate5 · Bottles', x: -144, y: -296, w: 112, h: 82 },
  plate4: { id: 'plate4', label: 'plate4 · Bottles', x: -268, y: -296, w: 112, h: 82 },
  plate2: { id: 'plate2', label: 'plate2 · 54 vials', x: -392, y: -296, w: 112, h: 82 },

  // Row 1 (front of black slotted breadboard)
  plate0: { id: 'plate0', label: 'plate0 · 54 vials', x: -144, y: -390, w: 112, h: 82 },
  plate1: { id: 'plate1', label: 'plate1 · 54 vials', x: -268, y: -390, w: 112, h: 82 },
  plate3: { id: 'plate3', label: 'plate3 · Bottles', x: -392, y: -390, w: 112, h: 82 },

  // Right side of stainless optical table
  balance: { id: 'balance', label: 'Balance', x: -510, y: -234, w: 96, h: 118 },
  nanodrop: { id: 'nanodrop', label: 'NanoDrop 2000c', x: -510, y: -390, w: 96, h: 132 },
};

export function getPresetWellXY(preset: RobotPlatePreset, wellIdx: number): [number, number] {
  const rows = Math.max(1, preset.rows);
  const cols = Math.max(1, preset.cols);
  const clamped = Math.max(0, Math.min(rows * cols - 1, wellIdx));
  const r = Math.floor(clamped / cols);
  const c = clamped % cols;
  const u = cols > 1 ? c / (cols - 1) : 0;
  const v = rows > 1 ? r / (rows - 1) : 0;
  const a1 = preset.cornerA1;
  const tr = preset.cornerTopRight;
  const bl = preset.cornerBottomLeft;
  const x = a1[0] + u * (tr[0] - a1[0]) + v * (bl[0] - a1[0]);
  const y = a1[1] + u * (tr[1] - a1[1]) + v * (bl[1] - a1[1]);
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

export function getDeckSlotXY(
  plateId: number,
  slotId: number,
  preset?: RobotPlatePreset | null
): [number, number] {
  if (plateId <= 2 && preset && preset.plateSlot === plateId) {
    return getPresetWellXY(preset, slotId);
  }
  const box = SIM_DECK_LAYOUT[`plate${plateId}`] || SIM_DECK_LAYOUT.plate0;
  if (plateId <= 2) {
    const cols = 9;
    const rows = 6;
    const idx = Math.max(0, Math.min(53, slotId));
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const padX = 11;
    const padTop = 21;
    const padBottom = 10;
    // Left-to-right on deck = maxX (box.x + box.w) down to minX (box.x)
    const x = box.x + box.w - padX - (c / (cols - 1)) * (box.w - padX * 2);
    // Back-to-front on deck = maxY (box.y + box.h) down to minY (box.y)
    const y = box.y + box.h - padTop - (r / (rows - 1)) * (box.h - padTop - padBottom);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  }
  if (plateId <= 5) {
    const cols = 4;
    const rows = 2;
    const idx = Math.max(0, Math.min(7, slotId));
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const padX = 16;
    const padTop = 30;
    const padBottom = 16;
    const x = box.x + box.w - padX - (c / (cols - 1)) * (box.w - padX * 2);
    const y = box.y + box.h - padTop - (r / (rows - 1)) * (box.h - padTop - padBottom);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  }
  const idx = Math.max(0, Math.min(1, slotId));
  // Left jar (0) near maxX, right jar (1) near minX
  const x = box.x + (idx === 0 ? box.w * 0.72 : box.w * 0.28);
  const y = box.y + box.h * 0.43;
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

function nowTimeLabel(): string {
  const d = new Date();
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function makeUid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function containerKindForPlate(plateId: number): 'vial' | 'bottle' | 'jar' {
  if (plateId <= 2) return 'vial';
  if (plateId <= 5) return 'bottle';
  return 'jar';
}

function capacityForPlate(plateId: number, preset?: RobotPlatePreset | null): number {
  if (plateId <= 2) {
    if (preset) {
      const total = preset.rows * preset.cols;
      if (total >= 384) return 80;
      if (total >= 96) return 300;
      if (total >= 48) return 1800;
      return 2500;
    }
    return 1800;
  }
  if (plateId <= 5) return 38000;
  return 95000;
}

export class RobotSimulator {
  private hood: 'left' | 'right' = 'left';
  private connected = false;
  private homed = false;
  private busy = false;
  private emergencyStopped = false;
  private currentTip: '' | '50ul' | '300ul' | '1000ul' = '';
  private tipContaminant: string | null = null;
  private tipLiquidUl = 0;
  private currentXY: [number, number] = [0, 0];
  private currentZ = 880;
  private currentPosition = 'Disconnected (Simulation Ready)';
  private activeVesselKey: string | null = null;
  private activeLiquidPhase: SimSnapshot['activeLiquidPhase'] = 'idle';
  private lastCommand: string | null = null;
  private lastCommandAt: string | null = null;
  private lastError: string | null = null;

  private nanodropConnected = false;
  private nanodropId = 'nd_2000c';
  private nanodropLidClosed = true;
  private balanceMassMg = 0;

  private tipRacks: Record<'50ul' | '300ul' | '1000ul', number> = {
    '50ul': TIP_RACK_CAPACITY,
    '300ul': TIP_RACK_CAPACITY,
    '1000ul': TIP_RACK_CAPACITY,
  };
  private containers: Map<string, SimContainerState> = new Map();
  private platePresets: RobotPlatePreset[] = [];
  private plateTransfer: RobotPlateTransferState | null = null;
  private plateTransferStopRequested = false;

  private trail: SimTrailPoint[] = [];
  private accidents: SimAccident[] = [];
  private log: SimLogEntry[] = [];
  private lastAccidentXY: [number, number] | null = null;
  private stepCount = 0;

  constructor(run: RunResult | null = null, hood: 'left' | 'right' = 'left') {
    this.reset(run, hood);
  }

  private cmdRes(
    ok: boolean,
    executed: boolean,
    command: string,
    humanMessage: string,
    extra?: { error?: string; data?: Record<string, any> }
  ): RobotCommandResult {
    return {
      ok,
      executed,
      command,
      humanMessage,
      pythonSnippet: `# Virtual simulation (${command})`,
      data: extra?.data,
      error: extra?.error,
      hardware: this.getHardwareSnapshot(),
    };
  }

  public reset(
    run: RunResult | null,
    hood: 'left' | 'right' = this.hood,
    preservePresets = true
  ): void {
    this.hood = hood;
    const prof = robotProfileForHood(hood);
    this.connected = false;
    this.homed = false;
    this.busy = false;
    this.emergencyStopped = false;
    this.currentTip = '';
    this.tipContaminant = null;
    this.tipLiquidUl = 0;
    this.currentXY = [0, 0];
    this.currentZ = prof.traverseZ;
    this.currentPosition = 'Disconnected (click Connect & Home)';
    this.activeVesselKey = null;
    this.activeLiquidPhase = 'idle';
    this.lastCommand = null;
    this.lastCommandAt = null;
    this.lastError = null;
    this.nanodropConnected = false;
    this.nanodropLidClosed = true;
    this.balanceMassMg = 0;
    this.plateTransfer = null;
    this.plateTransferStopRequested = false;
    this.trail = [];
    this.accidents = [];
    this.log = [];
    this.lastAccidentXY = null;
    this.stepCount = 0;
    if (!preservePresets) {
      this.platePresets = [];
    }

    this.tipRacks = {
      '50ul': TIP_RACK_CAPACITY,
      '300ul': TIP_RACK_CAPACITY,
      '1000ul': TIP_RACK_CAPACITY,
    };

    this.containers.clear();
    this.seedContainersFromRun(run);
    this.pushLog(
      'info',
      'reset',
      run
        ? `Virtual deck loaded from your current plan (${Object.keys(run.stocks || {}).length} stocks, ${run.reactions} planned vials).`
        : 'Virtual deck reset with standard bottles, jars, and empty reaction plates.'
    );
  }

  public syncPresetsFromExternal(presets: RobotPlatePreset[]): void {
    if (!Array.isArray(presets) || presets.length === 0) return;
    const byId = new Map(this.platePresets.map((p) => [p.id, p]));
    for (const p of presets) {
      if (p && p.id && !byId.has(p.id)) {
        byId.set(p.id, p);
      }
    }
    this.platePresets = Array.from(byId.values());
  }

  private seedContainersFromRun(run: RunResult | null): void {
    for (let p = 0; p <= 2; p += 1) {
      for (let s = 0; s < 54; s += 1) {
        this.ensureContainer(p, s, undefined, 0);
      }
    }
    for (let p = 3; p <= 5; p += 1) {
      for (let s = 0; s < 8; s += 1) {
        this.ensureContainer(p, s, undefined, p === 3 && s < 2 ? 12000 : 0);
      }
    }
    for (let p = 6; p <= 7; p += 1) {
      for (let s = 0; s < 2; s += 1) {
        this.ensureContainer(p, s, undefined, p === 6 && s === 0 ? 60000 : 0);
      }
    }

    if (!run) return;
    if (run.deck && (Number(run.solventConsumptionMl) || 0) > 0) {
      const sp = run.deck.solvent_plate;
      const sc = run.deck.solvent_container;
      const kind = run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle';
      const geom = CONTAINER_GEOMETRY[kind];
      const volUl = Math.max(1000, Math.round((Number(run.solventRecommendedMl) || 20) * 1000));
      const key = `${sp}:${sc}`;
      this.containers.set(key, {
        key,
        plateId: sp,
        slotId: sc,
        kind,
        label: `Solvent (${run.reactionSolvent || 'ethanol'})`,
        solvent: run.reactionSolvent || 'ethanol',
        volumeUl: volUl,
        initialVolumeUl: volUl,
        capacityUl: capacityForPlate(sp),
        bottomZ: geom.bottom,
        areaMm2: geom.area,
        deadVolumeUl: geom.deadVolumeUl,
        contaminants: [run.reactionSolvent || 'ethanol'],
      });
    }

    for (const [k, st] of Object.entries(run.stocks || {})) {
      if (st.source_only) continue;
      const p = st.breadboard_plate_id;
      const s = st.container_id;
      const kind = containerKindForPlate(p);
      const geom = CONTAINER_GEOMETRY[kind];
      const volUl = Math.max(500, Math.round((Number(st.prep_volume_ml) || 10) * 1000));
      const key = `${p}:${s}`;
      this.containers.set(key, {
        key,
        plateId: p,
        slotId: s,
        kind,
        label: st.substance || k,
        solvent: st.solvent || 'ethanol',
        volumeUl: volUl,
        initialVolumeUl: volUl,
        capacityUl: capacityForPlate(p),
        bottomZ: geom.bottom,
        areaMm2: geom.area,
        deadVolumeUl: geom.deadVolumeUl,
        contaminants: [st.substance || k],
      });
    }
  }

  private ensureContainer(
    plateId: number,
    slotId: number,
    preset?: RobotPlatePreset | null,
    defaultVolUl = 0
  ): SimContainerState {
    const key = `${plateId}:${slotId}`;
    const existing = this.containers.get(key);
    if (existing) {
      if (plateId <= 2 && preset) {
        existing.capacityUl = capacityForPlate(plateId, preset);
      }
      return existing;
    }
    const kind = containerKindForPlate(plateId);
    const geom = CONTAINER_GEOMETRY[kind];
    const label =
      plateId <= 2
        ? `P${plateId} ${formatSimWellName(slotId, preset?.cols || 9)}`
        : plateId <= 5
        ? `P${plateId} Bottle ${slotId}`
        : `P${plateId} Jar ${slotId}`;
    const created: SimContainerState = {
      key,
      plateId,
      slotId,
      kind,
      label,
      solvent: 'ethanol',
      volumeUl: defaultVolUl,
      initialVolumeUl: defaultVolUl,
      capacityUl: capacityForPlate(plateId, preset),
      bottomZ: geom.bottom,
      areaMm2: geom.area,
      deadVolumeUl: geom.deadVolumeUl,
      contaminants: [],
    };
    this.containers.set(key, created);
    return created;
  }

  private getPresetById(presetId?: string): RobotPlatePreset | null {
    const pid = (presetId || '').trim();
    if (!pid || pid === 'default_54') return null;
    return this.platePresets.find((p) => p.id === pid) || null;
  }

  public getActivePresetForPlate(plateId: number): RobotPlatePreset | null {
    return this.platePresets.find((p) => p.plateSlot === plateId) || null;
  }

  private pushLog(level: SimLogEntry['level'], command: string, message: string): void {
    this.log.unshift({
      id: makeUid('log'),
      ts: nowTimeLabel(),
      level,
      command,
      message,
    });
    if (this.log.length > 140) this.log.length = 140;
  }

  private recordAccident(
    severity: SimAccidentSeverity,
    category: SimAccident['category'],
    command: string,
    title: string,
    detail: string,
    extra?: { plateId?: number; slotId?: number; xy?: [number, number] }
  ): void {
    const xy = extra?.xy || (this.currentXY ? ([...this.currentXY] as [number, number]) : undefined);
    const acc: SimAccident = {
      id: makeUid('acc'),
      ts: nowTimeLabel(),
      severity,
      category,
      title,
      detail,
      command,
      plateId: extra?.plateId,
      slotId: extra?.slotId,
      xy,
    };
    this.accidents.unshift(acc);
    if (this.accidents.length > 100) this.accidents.length = 100;
    if (severity === 'crash' || severity === 'hazard') {
      this.lastAccidentXY = xy || null;
      if (xy) {
        this.addTrail(xy, this.currentZ, 'crash');
      }
    }
    this.pushLog(severity === 'warning' ? 'warning' : 'crash', command, `${title}: ${detail}`);
  }

  private addTrail(xy: [number, number], z: number, kind: SimTrailPoint['kind']): void {
    this.trail.push({ xy: [xy[0], xy[1]], z, kind });
    if (this.trail.length > 36) {
      this.trail.shift();
    }
  }

  public clearLogAndAccidents(): void {
    this.accidents = [];
    this.log = [];
    this.lastAccidentXY = null;
  }

  public isPlateTransferStopRequested(): boolean {
    return this.plateTransferStopRequested || this.emergencyStopped;
  }

  public requestEmergencyStop(): RobotCommandResult {
    this.emergencyStopped = true;
    this.plateTransferStopRequested = true;
    this.activeLiquidPhase = 'idle';
    this.busy = false;
    if (this.plateTransfer && this.plateTransfer.active) {
      this.plateTransfer = {
        ...this.plateTransfer,
        active: false,
        state: 'stopped',
        message: 'Software Stop triggered — virtual arm halted immediately.',
      };
    }
    this.lastCommand = 'emergency_stop';
    this.lastCommandAt = new Date().toISOString();
    this.pushLog('warning', 'emergency_stop', 'Software Stop triggered — virtual gantry and pipetter halted immediately.');
    return this.cmdRes(true, true, 'emergency_stop', '[SIM] Software Stop sent immediately — virtual arm halted.');
  }

  public getTipRackStatuses(): RobotTipRackSummary[] {
    return (['50ul', '300ul', '1000ul'] as const).map((tt) => {
      const rem = this.tipRacks[tt];
      const used = TIP_RACK_CAPACITY - rem;
      return {
        tipType: tt,
        remaining: rem,
        used,
        total: TIP_RACK_CAPACITY,
      };
    });
  }

  public getHardwareSnapshot(): RobotHardwareState {
    return {
      controlEnabled: true,
      pinProtected: false,
      relayTokenConfigured: true,
      connected: this.connected,
      homed: this.homed,
      nanodropConnected: this.nanodropConnected,
      nanodropId: this.nanodropId,
      nanodropLidClosed: this.nanodropLidClosed,
      busy: this.busy,
      currentTip: this.currentTip,
      currentPosition: this.currentPosition,
      currentXY: [...this.currentXY] as [number, number],
      currentZ: this.currentZ,
      lastCommand: this.lastCommand,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      idleReleaseSeconds: 300,
      idleSecondsRemaining: this.connected ? 300 : null,
      plateTransfer: this.plateTransfer ? { ...this.plateTransfer } : null,
      platePresets: [...this.platePresets],
    };
  }

  public getSnapshot(): SimSnapshot {
    const containersObj: Record<string, SimContainerState> = {};
    for (const [k, v] of this.containers.entries()) {
      containersObj[k] = { ...v, contaminants: [...v.contaminants] };
    }
    return {
      hood: this.hood,
      hardware: this.getHardwareSnapshot(),
      tipRacks: this.getTipRackStatuses(),
      containers: containersObj,
      activeVesselKey: this.activeVesselKey,
      activeLiquidPhase: this.activeLiquidPhase,
      trail: [...this.trail],
      accidents: [...this.accidents],
      log: [...this.log],
      tipContaminant: this.tipContaminant,
      tipLiquidUl: this.tipLiquidUl,
      balanceMassMg: this.balanceMassMg,
      emergencyStopped: this.emergencyStopped,
      lastAccidentXY: this.lastAccidentXY ? ([...this.lastAccidentXY] as [number, number]) : null,
      stepCount: this.stepCount,
    };
  }

  public toLiveStatus(): RobotLiveStatus {
    const hw = this.getHardwareSnapshot();
    const isWorking = Boolean(hw.busy || hw.plateTransfer?.active);
    const hasCrash = this.accidents.some((a) => a.severity === 'crash');
    return {
      ok: true,
      robotName: `${robotProfileForHood(this.hood).pipetterName} (Simulator)`,
      state: hasCrash && this.emergencyStopped ? 'error' : isWorking ? 'running' : 'idle',
      headline: isWorking
        ? hw.plateTransfer?.active
          ? hw.plateTransfer.message
          : `Simulating ${this.lastCommand || 'robot motion'}…`
        : this.homed
        ? 'Virtual robot homed and ready — click any command or transfer to test safely.'
        : 'Simulation Mode ready — click Connect & Home to start moving the virtual arm.',
      detail: 'Running on the 1-to-1 virtual deck with live liquid tracking and accident detection (zero hardware motion).',
      dataPathConfigured: true,
      lastUpdatedIso: new Date().toISOString(),
      secondsAgo: 0,
      activeRun: null,
      availableRuns: [],
      tipRacks: this.getTipRackStatuses(),
      recentActivity: this.log.slice(0, 20).map((entry) => ({
        timestamp: entry.ts,
        level: entry.level === 'crash' ? 'error' : entry.level === 'warning' ? 'warning' : 'info',
        summary: entry.message,
        raw: `[SIM] ${entry.command}: ${entry.message}`,
      })),
      rawLogTail: this.log.slice(0, 20).map((e) => `[SIM] ${e.ts} ${e.command}: ${e.message}`),
      hardware: hw,
      activeCommand: null,
    };
  }

  private moveXYTo(xy: [number, number], command: string, allowUnsafeZ = false): boolean {
    const prof = robotProfileForHood(this.hood);
    if (!allowUnsafeZ && this.currentZ > prof.traverseZ + 70) {
      this.recordAccident(
        'crash',
        'xy_crash',
        command,
        'Sideways XY collision prevented',
        `Arm attempted to move horizontally while Z=${this.currentZ} (below safe traverse height ${prof.traverseZ}). Lift the arm first to avoid snapping the tip against vials or bottles.`,
        { xy }
      );
      return false;
    }
    if (
      xy[0] < SIM_DECK_BOUNDS.minX ||
      xy[0] > SIM_DECK_BOUNDS.maxX ||
      xy[1] < SIM_DECK_BOUNDS.minY ||
      xy[1] > SIM_DECK_BOUNDS.maxY
    ) {
      this.recordAccident(
        'crash',
        'out_of_bounds',
        command,
        'Deck boundary collision',
        `Target (${xy[0].toFixed(1)}, ${xy[1].toFixed(1)} mm) is outside safe gantry travel bounds.`,
        { xy }
      );
      return false;
    }
    this.currentXY = [Number(xy[0].toFixed(2)), Number(xy[1].toFixed(2))];
    this.addTrail(this.currentXY, this.currentZ, 'move');
    return true;
  }

  private resolveAndCheckTipAndVolume(
    rawVol: number,
    rawTip: string,
    command: string
  ): { ok: true; volUl: number; resolvedTip: '50ul' | '300ul' | '1000ul' } | { ok: false; error: string } {
    const volUl = Number(rawVol);
    if (!Number.isFinite(volUl) || volUl < 1) {
      const msg = 'Transfer volume must be at least 1 µL.';
      this.recordAccident('warning', 'validation', command, 'Invalid volume', msg);
      return { ok: false, error: msg };
    }
    if (volUl > 1000) {
      const msg = `Requested ${volUl} µL exceeds the 1000 µL single-pass tip limit. Split larger volumes into two transfers.`;
      this.recordAccident('hazard', 'tip_mismatch', command, 'Volume exceeds 1000 µL single-pass cap', msg);
      return { ok: false, error: msg };
    }
    const tipSetting = (rawTip || 'auto').trim();
    if (!['auto', '50ul', '300ul', '1000ul'].includes(tipSetting)) {
      const msg = `Invalid tip size '${tipSetting}'.`;
      this.recordAccident('warning', 'validation', command, 'Invalid tip type', msg);
      return { ok: false, error: msg };
    }
    const resolvedTip: '50ul' | '300ul' | '1000ul' =
      tipSetting === 'auto'
        ? volUl <= 50
          ? '50ul'
          : volUl <= 300
          ? '300ul'
          : '1000ul'
        : (tipSetting as '50ul' | '300ul' | '1000ul');
    const cap = SIM_TIP_CAPACITY[resolvedTip];
    if (volUl > cap) {
      const msg = `Requested ${volUl} µL exceeds the capacity of a ${cap} µL tip. Pick a larger tip or Auto.`;
      this.recordAccident('hazard', 'tip_mismatch', command, 'Tip capacity overflow', msg);
      return { ok: false, error: msg };
    }
    return { ok: true, volUl: Number(volUl.toFixed(2)), resolvedTip };
  }

  private pickTipInternal(tipType: '50ul' | '300ul' | '1000ul', command: string): { ok: boolean; error?: string } {
    const prof = robotProfileForHood(this.hood);
    if (this.currentTip) {
      const msg = `A ${this.currentTip} tip is already mounted on Zeus — drop it first before picking a new tip.`;
      this.recordAccident('crash', 'double_tip', command, 'Double tip-pick collision', msg);
      return { ok: false, error: msg };
    }
    if (this.tipRacks[tipType] <= 0) {
      const msg = `The ${tipType.replace('ul', ' µL')} tip rack is empty (0 / ${TIP_RACK_CAPACITY} left). Reload the rack before continuing.`;
      this.recordAccident('hazard', 'rack_empty', command, 'Tip rack empty', msg);
      return { ok: false, error: msg };
    }
    const rackBox = SIM_DECK_LAYOUT[`rack_${tipType}`];
    this.currentZ = prof.traverseZ;
    this.activeLiquidPhase = 'tip_action';
    if (rackBox) {
      const usedIdx = TIP_RACK_CAPACITY - this.tipRacks[tipType];
      const r = Math.floor(usedIdx / 12);
      const c = usedIdx % 12;
      const rx = rackBox.x + 10 + (c / 11) * (rackBox.w - 20);
      const ry = rackBox.y + rackBox.h - 10 - (r / 7) * (rackBox.h - 20);
      this.moveXYTo([rx, ry], command);
    }
    this.tipRacks[tipType] -= 1;
    this.currentTip = tipType;
    this.tipContaminant = null;
    this.tipLiquidUl = 0;
    this.activeVesselKey = null;
    this.currentPosition = `${tipType.replace('ul', ' µL')} tip rack`;
    if (this.tipRacks[tipType] <= 10 && this.tipRacks[tipType] > 0) {
      this.recordAccident(
        'warning',
        'rack_empty',
        command,
        `${tipType.replace('ul', ' µL')} tip rack running low`,
        `Only ${this.tipRacks[tipType]} tips left in the ${tipType.replace('ul', ' µL')} rack.`
      );
    }
    this.activeLiquidPhase = 'idle';
    return { ok: true };
  }

  private discardTipInternal(command: string): void {
    const prof = robotProfileForHood(this.hood);
    this.currentZ = prof.traverseZ;
    this.activeLiquidPhase = 'tip_action';
    this.moveXYTo([prof.trashXy[0], prof.trashXy[1]], command);
    this.currentTip = '';
    this.tipContaminant = null;
    this.tipLiquidUl = 0;
    this.activeVesselKey = null;
    this.currentPosition = 'Trash bin';
    this.activeLiquidPhase = 'idle';
  }

  public executeSingleTransferStep(
    params: {
      src_plate: number;
      src_slot: number;
      src_preset_id?: string;
      dst_plate: number;
      dst_slot: number;
      dst_preset_id?: string;
      volume_ul: number;
      solvent: string;
      tip_type?: string;
      src_z: number;
      dst_z: number;
      pick_tip?: boolean;
      prewet?: boolean;
      mix_after?: boolean;
      drop_tip?: boolean;
    },
    commandName = 'single_transfer'
  ): { ok: boolean; message: string; error?: string } {
    const prof = robotProfileForHood(this.hood);
    const solvent = String(params.solvent || '').trim();
    if (!SIM_ALLOWED_SOLVENTS.has(solvent)) {
      const msg = `Unsupported solvent '${solvent || '(empty)'}'. Choose a supported liquid class.`;
      this.recordAccident('warning', 'validation', commandName, 'Unsupported solvent rejected', msg);
      return { ok: false, message: msg, error: msg };
    }

    const tv = this.resolveAndCheckTipAndVolume(params.volume_ul, params.tip_type || 'auto', commandName);
    if (tv.ok === false) {
      return { ok: false, message: tv.error, error: tv.error };
    }
    const { volUl } = tv;
    let tipType = tv.resolvedTip;

    const srcPreset = this.getPresetById(params.src_preset_id);
    const dstPreset = this.getPresetById(params.dst_preset_id);

    if (params.src_plate <= 2 && params.src_preset_id && params.src_preset_id !== 'default_54' && !srcPreset) {
      const msg = `Source plate preset '${params.src_preset_id}' not found.`;
      return { ok: false, message: msg, error: msg };
    }
    if (params.dst_plate <= 2 && params.dst_preset_id && params.dst_preset_id !== 'default_54' && !dstPreset) {
      const msg = `Destination plate preset '${params.dst_preset_id}' not found.`;
      return { ok: false, message: msg, error: msg };
    }

    const srcC = this.ensureContainer(params.src_plate, params.src_slot, srcPreset);
    const dstC = this.ensureContainer(params.dst_plate, params.dst_slot, dstPreset);
    const srcXY = getDeckSlotXY(params.src_plate, params.src_slot, srcPreset);
    const dstXY = getDeckSlotXY(params.dst_plate, params.dst_slot, dstPreset);

    const pickTip = params.pick_tip !== false;
    if (pickTip) {
      if (this.currentTip && this.currentTip !== tipType) {
        this.discardTipInternal(commandName);
      }
      if (!this.currentTip) {
        const picked = this.pickTipInternal(tipType, commandName);
        if (!picked.ok) return { ok: false, message: picked.error!, error: picked.error };
      }
    } else if (!this.currentTip) {
      const msg = 'No pipette tip attached. Enable "Pick fresh tip" or pick a tip first.';
      this.recordAccident('hazard', 'tip_mismatch', commandName, 'Transfer attempted without a tip', msg);
      return { ok: false, message: msg, error: msg };
    } else {
      tipType = this.currentTip;
      const attachedCap = SIM_TIP_CAPACITY[tipType];
      if (volUl > attachedCap) {
        const msg = `Attached ${attachedCap} µL tip cannot aspirate ${volUl} µL.`;
        this.recordAccident('hazard', 'tip_mismatch', commandName, 'Attached tip too small', msg);
        return { ok: false, message: msg, error: msg };
      }
    }

    const srcDense = srcPreset && srcPreset.rows * srcPreset.cols >= 96;
    const dstDense = dstPreset && dstPreset.rows * dstPreset.cols >= 96;
    if (tipType === '1000ul' && (srcDense || dstDense)) {
      this.recordAccident(
        'warning',
        'tip_mismatch',
        commandName,
        'Wide 1000 µL tip in narrow 96-well plate',
        `Dipping a 1000 µL tip into a dense plate (${srcDense ? srcPreset!.name : dstPreset!.name}) risks touching the well wall — prefer 50 µL or 300 µL tips.`,
        { plateId: dstDense ? params.dst_plate : params.src_plate, slotId: dstDense ? params.dst_slot : params.src_slot, xy: dstDense ? dstXY : srcXY }
      );
    }

    const srcTag = `${srcC.key}:${srcC.label}`;
    if (this.tipContaminant && this.tipContaminant !== srcTag) {
      this.recordAccident(
        'warning',
        'cross_contamination',
        commandName,
        'Cross-contamination risk',
        `Reusing the same ${tipType} tip (previously in ${this.tipContaminant.split(':').slice(2).join(':') || this.tipContaminant}) inside ${srcC.label} without changing tips.`,
        { plateId: params.src_plate, slotId: params.src_slot, xy: srcXY }
      );
    }

    this.currentZ = prof.traverseZ;
    this.activeLiquidPhase = 'moving';
    if (!this.moveXYTo(srcXY, commandName)) {
      return { ok: false, message: 'Source move blocked by safety boundary.', error: 'Boundary error' };
    }
    this.activeVesselKey = srcC.key;
    this.currentPosition = `${srcC.label} (aspirating)`;

    const srcZ = Math.round(params.src_z);
    if (srcZ > srcC.bottomZ) {
      this.recordAccident(
        'crash',
        'z_crash',
        commandName,
        'Source tip bottom-crash',
        `Aspiration Z=${srcZ} goes past the bottom of ${srcC.label} (floor Z=${srcC.bottomZ}).`,
        { plateId: params.src_plate, slotId: params.src_slot, xy: srcXY }
      );
      this.currentZ = srcC.bottomZ;
      return { ok: false, message: `Tip bottom-crash prevented at ${srcC.label} (Z=${srcZ} > floor ${srcC.bottomZ}).`, error: 'Z bottom crash' };
    }

    const actualSrcSurfaceZ = Math.round(surfaceHeightExact(srcC.kind, srcC.volumeUl));
    if (srcC.volumeUl < volUl) {
      this.recordAccident(
        'hazard',
        'dry_aspiration',
        commandName,
        'Dry aspiration — source empty',
        `${srcC.label} only has ${Math.round(srcC.volumeUl)} µL left, which is less than the requested ${volUl} µL.`,
        { plateId: params.src_plate, slotId: params.src_slot, xy: srcXY }
      );
    } else if (srcC.volumeUl - volUl < srcC.deadVolumeUl) {
      this.recordAccident(
        'hazard',
        'dry_aspiration',
        commandName,
        'Below dead volume — air bubble risk',
        `Drawing ${volUl} µL from ${srcC.label} leaves ${Math.round(srcC.volumeUl - volUl)} µL, below its ${srcC.deadVolumeUl} µL dead volume.`,
        { plateId: params.src_plate, slotId: params.src_slot, xy: srcXY }
      );
    } else if (srcZ < actualSrcSurfaceZ - 35) {
      this.recordAccident(
        'hazard',
        'dry_aspiration',
        commandName,
        'Dry aspiration — target Z above liquid meniscus',
        `Target src_z=${srcZ} stops above the actual liquid surface (Z=${actualSrcSurfaceZ} for ${Math.round(srcC.volumeUl)} µL in ${srcC.label}). Tip would draw air.`,
        { plateId: params.src_plate, slotId: params.src_slot, xy: srcXY }
      );
    }

    this.activeLiquidPhase = 'aspirating';
    this.currentZ = Math.min(srcC.bottomZ, srcZ + 20);
    const drawnUl = Math.min(volUl, srcC.volumeUl);
    srcC.volumeUl = Math.max(0, Number((srcC.volumeUl - drawnUl).toFixed(2)));
    this.tipLiquidUl = drawnUl;
    this.tipContaminant = srcTag;
    this.addTrail(srcXY, this.currentZ, 'aspirate');

    this.currentZ = prof.traverseZ;
    this.activeLiquidPhase = 'moving';
    if (!this.moveXYTo(dstXY, commandName)) {
      return { ok: false, message: 'Destination move blocked by safety boundary.', error: 'Boundary error' };
    }
    this.activeVesselKey = dstC.key;
    this.currentPosition = `${dstC.label} (dispensing)`;

    const dstZ = Math.round(params.dst_z);
    if (dstZ > dstC.bottomZ) {
      this.recordAccident(
        'crash',
        'z_crash',
        commandName,
        'Destination tip bottom-crash',
        `Dispense Z=${dstZ} goes past the bottom of ${dstC.label} (floor Z=${dstC.bottomZ}).`,
        { plateId: params.dst_plate, slotId: params.dst_slot, xy: dstXY }
      );
      this.currentZ = dstC.bottomZ;
      return { ok: false, message: `Tip bottom-crash prevented at ${dstC.label} (Z=${dstZ} > floor ${dstC.bottomZ}).`, error: 'Z bottom crash' };
    }

    const projectedDstUl = dstC.volumeUl + drawnUl;
    if (projectedDstUl > dstC.capacityUl) {
      this.recordAccident(
        'hazard',
        'overflow',
        commandName,
        'Container overflow',
        `Dispensing ${volUl} µL into ${dstC.label} reaches ${Math.round(projectedDstUl)} µL, exceeding its ${dstC.capacityUl} µL safe fill limit.`,
        { plateId: params.dst_plate, slotId: params.dst_slot, xy: dstXY }
      );
    }

    this.activeLiquidPhase = 'dispensing';
    this.currentZ = Math.min(dstC.bottomZ, dstZ);
    dstC.volumeUl = Number(projectedDstUl.toFixed(2));
    if (srcC.label && !dstC.contaminants.includes(srcC.label)) {
      dstC.contaminants.push(srcC.label);
    }
    this.tipLiquidUl = 0;
    this.addTrail(dstXY, this.currentZ, 'dispense');

    this.currentZ = prof.traverseZ;
    this.activeLiquidPhase = 'idle';

    if (params.drop_tip !== false) {
      this.discardTipInternal(commandName);
    }

    this.stepCount += 1;
    const msg = `[SIM] Transferred ${volUl} µL of ${solvent} (${srcC.label} → ${dstC.label}) with ${tipType.replace('ul', ' µL')} tip.`;
    this.pushLog('ok', commandName, msg.replace('[SIM] ', ''));
    return { ok: true, message: msg };
  }

  public executeCommand(command: string, rawParams: Record<string, any> = {}): RobotCommandResult {
    const prof = robotProfileForHood(this.hood);
    const params = rawParams || {};
    this.lastCommand = command;
    this.lastCommandAt = new Date().toISOString();
    this.lastError = null;

    if (command === 'emergency_stop') {
      return this.requestEmergencyStop();
    }

    if (command === 'plate_transfer_stop') {
      if (this.plateTransfer && this.plateTransfer.active) {
        this.plateTransferStopRequested = true;
        this.plateTransfer = {
          ...this.plateTransfer,
          message: 'Stop requested — finishing current virtual well cleanly…',
        };
        this.pushLog('warning', command, 'Graceful stop requested for virtual plate transfer.');
        return this.cmdRes(true, true, command, '[SIM] Stop requested — finishing current well cleanly.');
      }
      return this.cmdRes(true, true, command, '[SIM] No plate transfer is currently running.');
    }

    if (command === 'kill_alarm') {
      this.emergencyStopped = false;
      this.plateTransferStopRequested = false;
      this.pushLog('ok', command, 'Cleared virtual alarm / Software Stop state.');
      return this.cmdRes(true, true, command, '[SIM] Virtual alarm cleared — ready for motion.');
    }

    if (command === 'disconnect_hardware') {
      this.connected = false;
      this.homed = false;
      this.nanodropConnected = false;
      this.currentPosition = 'Disconnected (USB free)';
      this.activeVesselKey = null;
      this.pushLog('info', command, 'Disconnected virtual USB/CAN hardware (will require Connect & Home before moving).');
      return this.cmdRes(true, true, command, '[SIM] Virtual USB & CAN released.');
    }

    if (this.emergencyStopped && command !== 'init_hardware') {
      const msg = 'Virtual robot is halted by Software Stop. Click Clear Alarm before moving again.';
      return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
    }

    if (command === 'reload_tip_rack') {
      const tt = String(params.tip_type || '300ul') as '50ul' | '300ul' | '1000ul';
      if (!(tt in this.tipRacks)) {
        return this.cmdRes(false, false, command, '[SIM] Invalid tip_type.');
      }
      this.tipRacks[tt] = TIP_RACK_CAPACITY;
      this.pushLog('ok', command, `Reloaded ${tt.replace('ul', ' µL')} tip rack to ${TIP_RACK_CAPACITY}/${TIP_RACK_CAPACITY}.`);
      return this.cmdRes(true, true, command, `[SIM] Reloaded ${tt.replace('ul', ' µL')} tip rack to 96 tips.`);
    }

    if (command === 'mark_tips_used') {
      const tt = String(params.tip_type || '300ul') as '50ul' | '300ul' | '1000ul';
      const cnt = Math.max(1, Math.min(96, Number(params.count) || 1));
      if (!(tt in this.tipRacks)) {
        return this.cmdRes(false, false, command, '[SIM] Invalid tip_type.');
      }
      this.tipRacks[tt] = Math.max(0, this.tipRacks[tt] - cnt);
      this.pushLog('info', command, `Marked ${cnt} × ${tt.replace('ul', ' µL')} tip(s) used (${this.tipRacks[tt]} left).`);
      return this.cmdRes(true, true, command, `[SIM] Marked ${cnt} tip(s) used — ${this.tipRacks[tt]} left in ${tt.replace('ul', ' µL')} rack.`);
    }

    if (command === 'save_plate_preset') {
      const rows = Math.max(1, Math.min(16, Number(params.rows) || 8));
      const cols = Math.max(1, Math.min(24, Number(params.cols) || 12));
      const rawSlot = Number(params.plate_slot ?? 0);
      const slot = (rawSlot === 1 ? 1 : rawSlot === 2 ? 2 : 0) as 0 | 1 | 2;
      const a1 = params.corner_a1 as [number, number];
      const tr = params.corner_top_right as [number, number];
      const bl = params.corner_bottom_left as [number, number];
      if (!a1 || !tr || !bl) {
        return this.cmdRes(false, false, command, '[SIM] 3 corner coordinates required.');
      }
      const colPitch = cols > 1 ? Math.hypot(tr[0] - a1[0], tr[1] - a1[1]) / (cols - 1) : 0;
      const rowPitch = rows > 1 ? Math.hypot(bl[0] - a1[0], bl[1] - a1[1]) / (rows - 1) : 0;
      if ((cols > 1 && (colPitch < 2 || colPitch > 80)) || (rows > 1 && (rowPitch < 2 || rowPitch > 80))) {
        const msg = `Detected spacing (${colPitch.toFixed(1)} × ${rowPitch.toFixed(1)} mm) is outside safe 2–80 mm range.`;
        this.recordAccident('warning', 'validation', command, 'Invalid plate spacing', msg);
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
      const name = String(params.name || `${rows}×${cols} Plate`).trim();
      const id =
        String(params.id || '').trim() ||
        `p${slot}_${rows}x${cols}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28)}`;
      const preset: RobotPlatePreset = {
        id,
        name,
        plateSlot: slot,
        rows,
        cols,
        cornerA1: [Number(a1[0]), Number(a1[1])],
        cornerTopRight: [Number(tr[0]), Number(tr[1])],
        cornerBottomLeft: [Number(bl[0]), Number(bl[1])],
        defaultZ: Math.max(880, Math.min(2190, Number(params.default_z) || 1900)),
        colPitchMm: Number(colPitch.toFixed(2)),
        rowPitchMm: Number(rowPitch.toFixed(2)),
        angleDeg: 0,
        updatedAt: new Date().toISOString(),
      };
      this.platePresets = [...this.platePresets.filter((p) => p.id !== id), preset];
      this.pushLog('ok', command, `Saved virtual plate preset '${name}' (${rows}×${cols}) on plate${slot}.`);
      return this.cmdRes(true, true, command, `[SIM] Saved plate preset '${name}' on plate${slot}.`, {
        data: { preset, platePresets: [...this.platePresets] },
      });
    }

    if (command === 'delete_plate_preset') {
      const id = String(params.id || '').trim();
      this.platePresets = this.platePresets.filter((p) => p.id !== id);
      this.pushLog('info', command, `Deleted virtual plate preset '${id}'.`);
      return this.cmdRes(true, true, command, `[SIM] Deleted plate preset '${id}'.`, {
        data: { platePresets: [...this.platePresets] },
      });
    }

    if (command.startsWith('nanodrop_')) {
      if (command === 'nanodrop_disconnect') {
        this.nanodropConnected = false;
        this.nanodropLidClosed = true;
        this.pushLog('info', command, 'Disconnected virtual NanoDrop.');
        return this.cmdRes(true, true, command, '[SIM] NanoDrop disconnected.');
      }
      this.nanodropConnected = true;
      if (params.nd_id) this.nanodropId = String(params.nd_id);
      if (command === 'nanodrop_lid_open') this.nanodropLidClosed = false;
      if (command === 'nanodrop_lid_close' || command === 'nanodrop_close_all') this.nanodropLidClosed = true;
      this.pushLog('ok', command, `Executed virtual ${command.replace(/_/g, ' ')}.`);
      return this.cmdRes(true, true, command, `[SIM] Completed ${command.replace(/_/g, ' ')}.`);
    }

    if (command === 'init_hardware') {
      this.connected = true;
      this.emergencyStopped = false;
      this.currentZ = prof.traverseZ;
      if (this.currentTip) {
        this.homed = false;
        const msg = `Refused to home while a ${this.currentTip} tip is attached! Click Drop Tip first, then Connect & Home.`;
        this.recordAccident('crash', 'home_with_tip', command, 'Homing blocked with tip attached', msg);
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
      this.homed = true;
      this.currentXY = [0, 0];
      this.activeVesselKey = null;
      this.currentPosition = 'Home (0, 0)';
      this.addTrail([0, 0], this.currentZ, 'move');
      this.pushLog('ok', command, 'Connected virtual robot and homed X/Y cleanly at traverse height.');
      return this.cmdRes(true, true, command, '[SIM] Virtual robot connected and homed at (0, 0).');
    }

    if (!COMMANDS_ALLOWED_WITHOUT_HOMING.has(command)) {
      if (!this.connected || !this.homed) {
        const msg = !this.connected
          ? 'Virtual robot is disconnected. Confirm no tip is attached, then click Connect & Home first.'
          : 'Virtual robot is connected but not homed yet. Confirm no tip is attached, then click Home X/Y or Connect & Home first.';
        this.recordAccident('warning', 'unhomed_move', command, 'Move blocked before Connect & Home', msg);
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
    }

    if (command === 'home_xy') {
      this.connected = true;
      this.currentZ = prof.traverseZ;
      if (this.currentTip) {
        const msg = `Refused to home while a ${this.currentTip} tip is still attached! Click Drop Tip first.`;
        this.recordAccident('crash', 'home_with_tip', command, 'Homing blocked with tip attached', msg);
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
      this.homed = true;
      this.currentXY = [0, 0];
      this.activeVesselKey = null;
      this.currentPosition = 'Home (0, 0)';
      this.addTrail([0, 0], this.currentZ, 'move');
      this.pushLog('ok', command, 'Homed virtual gantry to (0, 0).');
      return this.cmdRes(true, true, command, '[SIM] Homed X/Y to (0, 0).');
    }

    if (command === 'move_z_traverse') {
      this.currentZ = prof.traverseZ;
      this.pushLog('ok', command, `Raised Z to safe traverse height (${prof.traverseZ}).`);
      return this.cmdRes(true, true, command, `[SIM] Arm raised to safe height (Z=${prof.traverseZ}).`);
    }

    if (command === 'move_idle') {
      this.currentZ = prof.traverseZ;
      if (!this.moveXYTo([prof.idleXy[0], prof.idleXy[1]], command)) {
        return this.cmdRes(false, false, command, '[SIM] Could not park arm.');
      }
      this.activeVesselKey = null;
      this.currentPosition = 'Parked (Idle)';
      this.pushLog('ok', command, `Parked virtual arm at (${prof.idleXy[0]}, ${prof.idleXy[1]}).`);
      return this.cmdRes(true, true, command, '[SIM] Arm parked at idle position.');
    }

    if (command === 'pick_tip') {
      const tt = String(params.tip_type || '300ul') as '50ul' | '300ul' | '1000ul';
      const r = this.pickTipInternal(tt, command);
      if (!r.ok) {
        return this.cmdRes(false, false, command, `[SIM] ${r.error}`, { error: r.error });
      }
      this.pushLog('ok', command, `Picked up a fresh ${tt.replace('ul', ' µL')} tip (${this.tipRacks[tt]} remaining).`);
      return this.cmdRes(true, true, command, `[SIM] Picked ${tt.replace('ul', ' µL')} tip.`);
    }

    if (command === 'discard_tip') {
      const hadTip = Boolean(this.currentTip);
      this.discardTipInternal(command);
      this.pushLog('ok', command, hadTip ? 'Dropped pipette tip into waste bin.' : 'Moved over trash bin (no tip was mounted).');
      return this.cmdRes(true, true, command, '[SIM] Tip dropped into waste bin.');
    }

    if (command === 'change_tip') {
      const tt = String(params.tip_type || '300ul') as '50ul' | '300ul' | '1000ul';
      if (this.currentTip) this.discardTipInternal(command);
      const r = this.pickTipInternal(tt, command);
      if (!r.ok) {
        return this.cmdRes(false, false, command, `[SIM] ${r.error}`, { error: r.error });
      }
      this.pushLog('ok', command, `Changed to a fresh ${tt.replace('ul', ' µL')} tip.`);
      return this.cmdRes(true, true, command, `[SIM] Changed to ${tt.replace('ul', ' µL')} tip.`);
    }

    if (command === 'check_tip_status') {
      const msg = this.currentTip
        ? `Tip sensor reports tip attached (${this.currentTip.replace('ul', ' µL')}).`
        : 'Tip sensor reports NO tip attached.';
      this.pushLog('info', command, msg);
      return this.cmdRes(true, true, command, `[SIM] ${msg}`, { data: { tipPresent: Boolean(this.currentTip) } });
    }

    if (command === 'move_to_container') {
      const plateId = Math.max(0, Math.min(7, Number(params.plate_id) || 0));
      const maxC = plateId <= 2 ? 53 : plateId <= 5 ? 7 : 1;
      const slotId = Math.max(0, Math.min(maxC, Number(params.container_id) || 0));
      this.currentZ = prof.traverseZ;
      const preset = plateId <= 2 ? this.getActivePresetForPlate(plateId) : null;
      const xy = getDeckSlotXY(plateId, slotId, preset);
      if (!this.moveXYTo(xy, command)) {
        return this.cmdRes(false, false, command, '[SIM] Move blocked.');
      }
      const c = this.ensureContainer(plateId, slotId, preset);
      this.activeVesselKey = c.key;
      this.currentPosition = `${c.label}`;
      this.pushLog('ok', command, `Moved arm over ${c.label} at (${xy[0]}, ${xy[1]} mm), Z=${this.currentZ}.`);
      return this.cmdRes(true, true, command, `[SIM] Moved over ${c.label}.`);
    }

    if (command === 'move_to_plate_well') {
      const rawPl = Number(params.plate_id) || 0;
      const plateId = (rawPl === 1 ? 1 : rawPl === 2 ? 2 : 0) as 0 | 1 | 2;
      const wi = Math.max(0, Math.min(383, Number(params.well_index) || 0));
      this.currentZ = prof.traverseZ;
      let xy: [number, number];
      let wellLbl: string;
      let preset: RobotPlatePreset | null = null;
      if (params.corner_a1 && params.corner_top_right && params.corner_bottom_left) {
        const rows = Number(params.rows) || 8;
        const cols = Number(params.cols) || 12;
        preset = {
          id: 'preview',
          name: 'Preview',
          plateSlot: plateId,
          rows,
          cols,
          cornerA1: params.corner_a1,
          cornerTopRight: params.corner_top_right,
          cornerBottomLeft: params.corner_bottom_left,
          defaultZ: Number(params.default_z) || 1900,
          colPitchMm: 9,
          rowPitchMm: 9,
          angleDeg: 0,
        };
        xy = getPresetWellXY(preset, wi);
        wellLbl = formatSimWellName(wi, cols);
      } else {
        preset = this.getPresetById(params.preset_id);
        xy = getDeckSlotXY(plateId, wi, preset);
        wellLbl = formatSimWellName(wi, preset?.cols || 9);
      }
      if (!this.moveXYTo(xy, command)) {
        return this.cmdRes(false, false, command, '[SIM] Move blocked.');
      }
      const c = this.ensureContainer(plateId, wi, preset);
      this.activeVesselKey = c.key;
      this.currentPosition = `plate${plateId} ${wellLbl}`;
      this.pushLog('ok', command, `Moved to plate${plateId} well ${wellLbl} (${xy[0]}, ${xy[1]} mm).`);
      return this.cmdRes(true, true, command, `[SIM] Moved safely over plate${plateId} well ${wellLbl} (X=${xy[0]}, Y=${xy[1]} mm).`);
    }

    if (command === 'move_to_trash') {
      this.currentZ = prof.traverseZ;
      this.moveXYTo([prof.trashXy[0], prof.trashXy[1]], command);
      this.activeVesselKey = null;
      this.currentPosition = 'Trash bin';
      this.pushLog('ok', command, 'Moved arm over trash bin.');
      return this.cmdRes(true, true, command, '[SIM] Moved over trash bin.');
    }

    if (command === 'move_to_balance') {
      const b = SIM_DECK_LAYOUT.balance;
      this.currentZ = prof.traverseZ;
      this.moveXYTo([b.x + b.w / 2, b.y + b.h / 2], command);
      this.activeVesselKey = null;
      this.currentPosition = 'Balance';
      this.pushLog('ok', command, 'Moved arm over analytical balance.');
      return this.cmdRes(true, true, command, '[SIM] Moved over balance.');
    }

    if (command === 'move_to_nanodrop') {
      const n = SIM_DECK_LAYOUT.nanodrop;
      this.currentZ = prof.traverseZ;
      this.moveXYTo([n.x + n.w / 2, n.y + n.h / 2], command);
      this.activeVesselKey = null;
      this.currentPosition = 'NanoDrop pedestal';
      this.pushLog('ok', command, 'Moved arm over NanoDrop pedestal.');
      return this.cmdRes(true, true, command, '[SIM] Moved over NanoDrop pedestal.');
    }

    if (command === 'move_xy_rel') {
      const dx = Math.max(-100, Math.min(100, Number(params.dx) || 0));
      const dy = Math.max(-100, Math.min(100, Number(params.dy) || 0));
      const nextXY: [number, number] = [this.currentXY[0] + dx, this.currentXY[1] + dy];
      if (!this.moveXYTo(nextXY, command)) {
        return this.cmdRes(
          false,
          false,
          command,
          '[SIM] XY jog blocked — see Accident Log (raise Z to safe height or stay within deck limits).',
          { error: 'XY jog blocked' }
        );
      }
      this.currentPosition = `Jog (${this.currentXY[0].toFixed(1)}, ${this.currentXY[1].toFixed(1)} mm)`;
      this.pushLog('ok', command, `Jogged XY by (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}) mm → (${this.currentXY[0]}, ${this.currentXY[1]}).`);
      return this.cmdRes(true, true, command, `[SIM] Jogged to (${this.currentXY[0]}, ${this.currentXY[1]} mm).`);
    }

    if (command === 'move_z' || command === 'move_z_rel') {
      const targetZ =
        command === 'move_z'
          ? Math.round(Number(params.z) || 880)
          : Math.round(this.currentZ + (Number(params.dz) || 0));
      if (targetZ < 500 || targetZ > 2200) {
        const msg = `Z=${targetZ} is outside safe 500–2200 range.`;
        this.recordAccident('crash', 'z_crash', command, 'Z-limit exceeded', msg);
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
      const vessel = this.activeVesselKey ? this.containers.get(this.activeVesselKey) : null;
      if (vessel && targetZ > vessel.bottomZ) {
        this.currentZ = vessel.bottomZ;
        const msg = `Tip bottom-crash! Z=${targetZ} exceeds ${vessel.label} floor (Z=${vessel.bottomZ}). Stopped at floor.`;
        this.recordAccident('crash', 'z_crash', command, 'Tip crashed into container bottom', msg, {
          plateId: vessel.plateId,
          slotId: vessel.slotId,
        });
        return this.cmdRes(false, false, command, `[SIM] ${msg}`, { error: msg });
      }
      this.currentZ = targetZ;
      this.pushLog('ok', command, `Moved Z to ${this.currentZ}${vessel ? ` inside ${vessel.label}` : ''}.`);
      return this.cmdRes(true, true, command, `[SIM] Moved Z to ${this.currentZ}.`);
    }

    if (command === 'read_xy_position' || command === 'read_instrument_status') {
      return this.cmdRes(
        true,
        true,
        command,
        `[SIM] Position X=${this.currentXY[0].toFixed(2)} mm, Y=${this.currentXY[1].toFixed(2)} mm, Z=${this.currentZ}.`,
        { data: { xy: [...this.currentXY], zPosition: this.currentZ } }
      );
    }

    if (command === 'check_liquid_level') {
      const plateId = Math.max(0, Math.min(7, Number(params.plate_id) || 0));
      const slotId = Math.max(0, Number(params.container_id) || 0);
      const c = this.ensureContainer(plateId, slotId);
      const surfaceZ = Math.round(surfaceHeightExact(c.kind, c.volumeUl));
      this.pushLog('info', command, `${c.label}: ${Math.round(c.volumeUl)} µL (true meniscus Z=${surfaceZ}).`);
      return this.cmdRes(
        true,
        true,
        command,
        `[SIM] ${c.label}: ${Math.round(c.volumeUl)} µL remaining → surface height Z = ${surfaceZ}.`,
        { data: { zHeight: surfaceZ, volumeUl: c.volumeUl } }
      );
    }

    if (command === 'balance_tare') {
      this.balanceMassMg = 0;
      this.pushLog('ok', command, 'Tared virtual balance to 0.0 mg.');
      return this.cmdRes(true, true, command, '[SIM] Balance tared to 0.0 mg.');
    }

    if (command === 'balance_read') {
      return this.cmdRes(true, true, command, `[SIM] Balance reading: ${this.balanceMassMg.toFixed(1)} mg.`);
    }

    if (command === 'balance_door_open' || command === 'balance_door_close') {
      this.pushLog('ok', command, command === 'balance_door_open' ? 'Opened balance door.' : 'Closed balance door.');
      return this.cmdRes(true, true, command, `[SIM] ${command === 'balance_door_open' ? 'Opened' : 'Closed'} balance door.`);
    }

    if (command === 'single_transfer') {
      const res = this.executeSingleTransferStep(params as any, 'single_transfer');
      return this.cmdRes(res.ok, res.ok, command, res.message, { error: res.error });
    }

    return this.cmdRes(false, false, command, `[SIM] Unsupported command '${command}'.`);
  }

  public initPlateTransferJob(params: Record<string, any>): {
    ok: boolean;
    error?: string;
    pairs?: Array<[number, number]>;
    config?: any;
  } {
    if (!this.connected || !this.homed) {
      const msg = 'Virtual robot is not connected & homed yet. Click Connect & Home first.';
      this.recordAccident('warning', 'unhomed_move', 'plate_transfer_start', 'Plate transfer blocked before homing', msg);
      return { ok: false, error: msg };
    }
    const srcPlate = Number(params.src_plate ?? 0);
    const dstPlate = Number(params.dst_plate ?? 1);
    if (srcPlate === dstPlate) {
      return { ok: false, error: 'Source plate and destination plate must be different.' };
    }
    const solvent = String(params.solvent || '').trim();
    if (!SIM_ALLOWED_SOLVENTS.has(solvent)) {
      const msg = `Unsupported solvent '${solvent}'.`;
      this.recordAccident('warning', 'validation', 'plate_transfer_start', 'Unsupported solvent', msg);
      return { ok: false, error: msg };
    }
    const tv = this.resolveAndCheckTipAndVolume(Number(params.volume_ul || 50), String(params.tip_type || 'auto'), 'plate_transfer_start');
    if (tv.ok === false) return { ok: false, error: tv.error };

    const pairs: Array<[number, number]> =
      Array.isArray(params.pairs) && params.pairs.length > 0
        ? params.pairs.map((p: [number, number]) => [Number(p[0]), Number(p[1])])
        : (Array.isArray(params.wells) ? params.wells : [0]).map((w: number) => [Number(w), Number(w)]);

    const srcPreset = this.getPresetById(params.src_preset_id);
    const dstPreset = this.getPresetById(params.dst_preset_id);

    const anySourceHasLiquid = pairs.some(([sw]) => (this.containers.get(`${srcPlate}:${sw}`)?.volumeUl || 0) > 0);
    if (!anySourceHasLiquid) {
      for (const [sw] of pairs) {
        const c = this.ensureContainer(srcPlate, sw, srcPreset);
        c.volumeUl = Math.min(c.capacityUl, Math.max(400, tv.volUl * 2));
        c.initialVolumeUl = c.volumeUl;
        c.solvent = solvent;
      }
      this.pushLog('info', 'plate_transfer_start', `Auto-filled virtual source plate${srcPlate} wells so you can observe real meniscus drop.`);
    }

    this.plateTransferStopRequested = false;
    this.emergencyStopped = false;
    this.busy = true;
    this.plateTransfer = {
      active: true,
      state: 'running',
      srcPlate,
      dstPlate,
      srcPresetId: params.src_preset_id || 'default_54',
      dstPresetId: params.dst_preset_id || 'default_54',
      srcPresetName: srcPreset ? srcPreset.name : '54-vial (6×9)',
      dstPresetName: dstPreset ? dstPreset.name : '54-vial (6×9)',
      srcRows: srcPreset?.rows ?? 6,
      srcCols: srcPreset?.cols ?? 9,
      dstRows: dstPreset?.rows ?? 6,
      dstCols: dstPreset?.cols ?? 9,
      volumeUl: tv.volUl,
      solvent,
      tipType: tv.resolvedTip,
      changeTipEachVial: params.change_tip_each_vial !== false,
      totalWells: pairs.length,
      completedWells: 0,
      currentWell: pairs[0]?.[0] ?? null,
      currentPair: pairs[0] ?? null,
      failedWell: null,
      failedPair: null,
      wells: pairs.map((p) => p[0]),
      pairs,
      completedList: [],
      completedPairs: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: `[SIM] Starting plate${srcPlate} → plate${dstPlate} (${pairs.length} wells)…`,
      error: null,
    };
    return {
      ok: true,
      pairs,
      config: {
        srcPlate,
        dstPlate,
        srcPresetId: params.src_preset_id || 'default_54',
        dstPresetId: params.dst_preset_id || 'default_54',
        volumeUl: tv.volUl,
        solvent,
        tipType: tv.resolvedTip,
        srcZ: Number(params.src_z ?? 2100),
        dstZ: Number(params.dst_z ?? 2100),
        changeTipEachVial: params.change_tip_each_vial !== false,
        prewet: Boolean(params.prewet),
        mixAfter: Boolean(params.mix_after),
        dropTipAtEnd: params.drop_tip_at_end !== false,
      },
    };
  }

  public advancePlateTransferPair(
    pair: [number, number],
    idx: number,
    total: number,
    config: any
  ): { continueJob: boolean } {
    if (!this.plateTransfer) return { continueJob: false };
    if (this.isPlateTransferStopRequested()) {
      this.finishPlateTransfer('stopped', `Stopped cleanly after ${this.plateTransfer.completedWells}/${total} wells.`);
      return { continueJob: false };
    }
    const [sw, dw] = pair;
    this.plateTransfer.currentWell = sw;
    this.plateTransfer.currentPair = [sw, dw];
    this.plateTransfer.message = `[SIM] Transferring well ${idx + 1}/${total} (P${config.srcPlate}:#${sw} → P${config.dstPlate}:#${dw})…`;

    const res = this.executeSingleTransferStep(
      {
        src_plate: config.srcPlate,
        src_slot: sw,
        src_preset_id: config.srcPresetId,
        dst_plate: config.dstPlate,
        dst_slot: dw,
        dst_preset_id: config.dstPresetId,
        volume_ul: config.volumeUl,
        solvent: config.solvent,
        tip_type: config.tipType,
        src_z: config.srcZ,
        dst_z: config.dstZ,
        pick_tip: config.changeTipEachVial || idx === 0,
        prewet: config.prewet,
        mix_after: config.mixAfter,
        drop_tip: config.changeTipEachVial || (idx === total - 1 && config.dropTipAtEnd),
      },
      'plate_transfer_start'
    );

    if (res.ok) {
      this.plateTransfer.completedWells += 1;
      this.plateTransfer.completedList.push(sw);
      this.plateTransfer.completedPairs = [...(this.plateTransfer.completedPairs || []), [sw, dw]];
      return { continueJob: true };
    } else {
      this.plateTransfer.failedWell = sw;
      this.plateTransfer.failedPair = [sw, dw];
      this.plateTransfer.error = res.error || res.message;
      this.finishPlateTransfer('error', `[SIM] Halted at well #${sw}: ${res.error || res.message}`);
      return { continueJob: false };
    }
  }

  public finishPlateTransfer(state: RobotPlateTransferState['state'], message: string): void {
    this.busy = false;
    this.activeLiquidPhase = 'idle';
    if (this.plateTransfer) {
      this.plateTransfer = {
        ...this.plateTransfer,
        active: false,
        state,
        currentWell: null,
        currentPair: null,
        finishedAt: new Date().toISOString(),
        message,
      };
    }
    this.pushLog(state === 'completed' ? 'ok' : state === 'stopped' ? 'warning' : 'crash', 'plate_transfer_start', message);
  }
}

function requiredTipForVolume(volUl: number): '50ul' | '300ul' | '1000ul' {
  if (volUl <= 50) return '50ul';
  if (volUl <= 300) return '300ul';
  return '1000ul';
}

function splitIntoTipPasses(volUl: number): number[] {
  if (volUl <= 1000) return [volUl];
  const passes = Math.ceil(volUl / 1000);
  const each = Number((volUl / passes).toFixed(2));
  const result: number[] = [];
  let rem = volUl;
  for (let i = 0; i < passes; i += 1) {
    const v = i === passes - 1 ? Number(rem.toFixed(2)) : each;
    result.push(v);
    rem -= v;
  }
  return result;
}

export function buildPlannedReactionSteps(
  run: RunResult,
  measuredSurfaceZ?: Record<string, number>
): SimPlannedStep[] {
  const steps: SimPlannedStep[] = [];
  if (!run || !Array.isArray(run.rows) || run.rows.length === 0) return steps;

  const saved = measuredSurfaceZ || {};
  const solventName = SIM_ALLOWED_SOLVENTS.has(run.reactionSolvent || '')
    ? run.reactionSolvent
    : 'ethanol';

  // Helper: emits steps for one reagent across its plates, sorted largest -> smallest volume
  // per plate, automatically dropping & picking a new tip whenever the tip tier (1000/300/50 µL) changes.
  const appendReagentSchedule = (opts: {
    substance: string;
    srcPlate: number;
    srcSlot: number;
    kind: 'bottle' | 'jar';
    solvent: string;
    initialUl: number;
    measuredZ?: number;
    dstZ: number;
    items: Array<{ dstPlate: number; dstSlot: number; vol: number }>;
  }) => {
    if (opts.items.length === 0) return;

    let runningUl = Math.max(0, opts.initialUl);
    const measuredOffset =
      typeof opts.measuredZ === 'number'
        ? Math.round(opts.measuredZ) - Math.round(surfaceHeightExact(opts.kind, runningUl))
        : 0;

    // Group by destination plate (0, 1, 2) just like Robowski executes plate-by-plate
    const plates = [...new Set(opts.items.map((x) => x.dstPlate))].sort((a, b) => a - b);

    for (const plateId of plates) {
      // Real Robowski behavior: sort largest volume first, then by well index
      const plateItems = opts.items
        .filter((x) => x.dstPlate === plateId)
        .sort((a, b) => b.vol - a.vol || a.dstSlot - b.dstSlot);

      // Expand any > 1000 µL transfer into explicit multi-pass steps
      const expanded: Array<{
        dstPlate: number;
        dstSlot: number;
        vol: number;
        tipType: '50ul' | '300ul' | '1000ul';
        passLabel: string;
      }> = [];
      for (const item of plateItems) {
        const passes = splitIntoTipPasses(item.vol);
        passes.forEach((pVol, pIdx) => {
          expanded.push({
            dstPlate: item.dstPlate,
            dstSlot: item.dstSlot,
            vol: pVol,
            tipType: requiredTipForVolume(pVol),
            passLabel: passes.length > 1 ? ` [${pIdx + 1}/${passes.length}]` : '',
          });
        });
      }

      // Emit steps with automatic tip switching whenever tipType changes
      for (let i = 0; i < expanded.length; i += 1) {
        const cur = expanded[i];
        const prev = i > 0 ? expanded[i - 1] : null;
        const next = i < expanded.length - 1 ? expanded[i + 1] : null;

        const pickTip = !prev || prev.tipType !== cur.tipType;
        const dropTip = !next || next.tipType !== cur.tipType;

        const curZ = Math.round(surfaceHeightExact(opts.kind, runningUl)) + measuredOffset;
        runningUl = Math.max(0, runningUl - cur.vol);

        steps.push({
          label: `${opts.substance} → P${cur.dstPlate} ${formatSimWellName(cur.dstSlot, 9)} (${cur.vol.toFixed(1)} µL${cur.passLabel})`,
          srcPlate: opts.srcPlate,
          srcSlot: opts.srcSlot,
          dstPlate: cur.dstPlate,
          dstSlot: cur.dstSlot,
          volumeUl: cur.vol,
          solvent: opts.solvent,
          tipType: cur.tipType,
          srcZ: Math.max(880, Math.min(CONTAINER_GEOMETRY[opts.kind].bottom, curZ)),
          dstZ: opts.dstZ,
          substance: opts.substance,
          pickTip,
          dropTip,
        });
      }
    }
  };

  if (run.deck) {
    const sp = run.deck.solvent_plate;
    const sc = run.deck.solvent_container;
    const sKind = run.deck.solvent_kind === 'jar' ? 'jar' : 'bottle';
    const solventVials = run.rows
      .map((row, idx) => ({
        dstPlate: Math.max(0, Math.min(2, Number(row.plate_number) || Math.floor(idx / 54))),
        dstSlot: Number.isFinite(row.container_id) ? row.container_id : idx % 54,
        vol: Number(row['vol#solvent']) || 0,
      }))
      .filter((x) => x.vol >= 0.5);

    if (solventVials.length > 0) {
      appendReagentSchedule({
        substance: 'Solvent',
        srcPlate: sp,
        srcSlot: sc,
        kind: sKind,
        solvent: solventName,
        initialUl: Math.max(0, (Number(run.solventRecommendedMl) || 20) * 1000),
        measuredZ: saved.solvent,
        dstZ: 2100,
        items: solventVials,
      });
    }
  }

  for (const [stockKey, stock] of Object.entries(run.stocks || {})) {
    if (stock.source_only) continue;
    const sp = stock.breadboard_plate_id;
    const sc = stock.container_id;
    const kind = sp >= 6 ? 'jar' : 'bottle';
    const solv = SIM_ALLOWED_SOLVENTS.has(stock.solvent || '') ? stock.solvent : 'ethanol';
    const colName = stock.substance || stockKey;

    const matchingRows = run.rows
      .map((row, idx) => {
        const vol =
          Number(row[`vol#${stockKey}`]) ||
          Number(row[`vol#${colName}`]) ||
          0;
        return {
          dstPlate: Math.max(0, Math.min(2, Number(row.plate_number) || Math.floor(idx / 54))),
          dstSlot: Number.isFinite(row.container_id) ? row.container_id : idx % 54,
          vol,
        };
      })
      .filter((x) => x.vol >= 0.5);

    appendReagentSchedule({
      substance: colName,
      srcPlate: sp,
      srcSlot: sc,
      kind,
      solvent: solv,
      initialUl: Math.max(0, (Number(stock.prep_volume_ml) || 10) * 1000),
      measuredZ: saved[stockKey],
      dstZ: 2050,
      items: matchingRows,
    });
  }

  return steps;
}
