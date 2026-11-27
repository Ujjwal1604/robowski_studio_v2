// Robowski Studio - Constants & Physical Chemistry Data
// Synced with zeus-pipetter/breadboard.py, config.py, config/roboski1, config/roboski2, and main_auto_liquid_height.py
import { DeckConfig, RobotProfile, RobotProfileId } from '../types';

export const PLATE_CAPACITY = 54;
export const MAX_REACTION_SLOTS = 3;
export const BOTTLE_CAPACITY_ML = 20;
/** 40 mL bottles share the exact 24.6 mm inner diameter and fit the same bottle_20ml rack positions */
export const BOTTLE_MAX_ML = 40;
export const JAR_CAPACITY_ML = 100;
export const VIAL_CAPACITY_UL = 2000;
export const TIP_RACK_CAPACITY = 96;

/** Exact breadboard.py & main_auto_liquid_height.py container geometry (Zeus z in 0.1 mm units, area in mm^2) */
export const PREWET_MAX_DEPTH = 50; // 5.0 mm below liquid surface (0.1 mm units)
export const TIP_MIN_CLEARANCE_FROM_BOTTOM = 5; // 0.5 mm above container floor (0.1 mm units)

export interface ContainerGeometrySpec {
  name: string;
  bottom: number;
  area: number;
  volumeMaxUl: number;
  immersionDepth: number;
  deadVolumeUl: number;
  deadVolumeMeasured: boolean;
}

export const CONTAINER_GEOMETRY: Record<'bottle' | 'jar' | 'vial', ContainerGeometrySpec> = {
  bottle: {
    name: 'bottle_20ml',
    bottom: 2180,
    area: (24.6 ** 2 * 3.14) / 4, // 475.0506 mm^2 (bottle_20ml_inner_diameter = 246)
    volumeMaxUl: 40000, // holds 20 mL or 40 mL bottles with same 24.6 mm ID
    immersionDepth: 30,
    deadVolumeUl: 1000, // confirmed manually for both 20 mL and 40 mL bottles
    deadVolumeMeasured: true,
  },
  jar: {
    name: 'jar_100ml',
    bottom: 2120,
    area: 2122, // breadboard.py jar_100ml.area
    volumeMaxUl: 100000,
    immersionDepth: 30,
    deadVolumeUl: Math.round(((30 + TIP_MIN_CLEARANCE_FROM_BOTTOM) / 10) * 2122), // 7427 uL estimated
    deadVolumeMeasured: false,
  },
  vial: {
    name: 'vial_2ml',
    bottom: 2190,
    area: 75, // breadboard.py vial_2ml.area
    volumeMaxUl: 2000,
    immersionDepth: 20,
    deadVolumeUl: 50, // measured on robot
    deadVolumeMeasured: true,
  },
};

export const ROBOT_PROFILES: Record<RobotProfileId, RobotProfile> = {
  roboski2: {
    id: 'roboski2',
    pipetterName: 'Robowski#2',
    label: 'Robowski#2 (Left hood)',
    hood: 'left',
    arduinoPort: 'COM5',
    balancePort: 'COM4',
    trashXy: [-380, -160],
    idleXy: [-300, -390],
    traverseZ: 880,
    tipPickZ: 1230,
    tipDepositZ: 1350,
    corruptedLiquidClasses: [],
    notes: 'Primary pipetter (config/roboski2). Plates 0–2 hold 54-vial racks, plates 3–5 hold 20/40 mL bottles, plates 6–7 hold 100 mL jars.',
  },
  roboski1: {
    id: 'roboski1',
    pipetterName: 'Roboski#1',
    label: 'Roboski#1 (Right hood)',
    hood: 'right',
    arduinoPort: 'COM5',
    balancePort: 'COM6',
    trashXy: [-400, -160],
    idleXy: [-400, -300],
    traverseZ: 880,
    tipPickZ: 1500,
    tipDepositZ: 1600,
    corruptedLiquidClasses: [0],
    notes: 'Legacy pipetter (config/roboski1). Liquid class 0 (water/DMSO 50 µL empty) is corrupted on Zeus and must map to class 21.',
  },
};

export function robotProfileForHood(hood: 'left' | 'right'): RobotProfile {
  return hood === 'right' ? ROBOT_PROFILES.roboski1 : ROBOT_PROFILES.roboski2;
}

export const SUPPORTED_SOLVENTS = [
  'ethanol',
  'water',
  'DMF',
  'Dioxane',
  'DCE',
  'MeCN',
  'glycerin',
  'serum',
  'DMSO',
  'CHCl3',
  'TolueneMix',
  'hbrhac1v1',
  'waterft',
  'ethanolft',
  'TestSolvent',
];

export const ROBOT_SOLVENTS = new Set(SUPPORTED_SOLVENTS);

export const ROBOT_LIQUID_MODES: Record<string, string[]> = {
  water: ['empty', 'part'],
  serum: ['empty', 'part'],
  ethanol: ['empty'],
  glycerin: ['empty'],
  DMF: ['empty'],
  Dioxane: ['empty'],
  DCE: ['empty'],
  MeCN: ['empty'],
  DMSO: ['empty'],
  CHCl3: ['empty'],
  TolueneMix: ['empty'],
  hbrhac1v1: ['empty'],
  waterft: ['empty'],
  ethanolft: ['empty'],
  TestSolvent: ['empty'],
};

export const SOLVENT_DENSITIES: Record<string, number> = {
  ethanol: 0.789,
  water: 0.998,
  DMF: 0.944,
  Dioxane: 1.033,
  DCE: 1.253,
  MeCN: 0.786,
  glycerin: 1.261,
  serum: 1,
  DMSO: 1.102,
  CHCl3: 1.489,
  TolueneMix: 0.867,
  hbrhac1v1: 1.25,
  waterft: 0.998,
  ethanolft: 0.789,
  TestSolvent: 1.0,
};

export const SOLVENT_ALIASES: Record<string, string> = {
  EtOH: 'ethanol',
  Ethanol: 'ethanol',
  Water: 'water',
  Glycerin: 'glycerin',
  Serum: 'serum',
  chcl3: 'CHCl3',
  chloroform: 'CHCl3',
  toluenemix: 'TolueneMix',
  TolueneMix: 'TolueneMix',
  hbrhac1v1: 'hbrhac1v1',
  waterft: 'waterft',
  ethanolft: 'ethanolft',
  testsolvent: 'TestSolvent',
};

export const COLORS = [
  '#0E6F63',
  '#A94A12',
  '#5B3FA8',
  '#1F6AA5',
  '#8A2D5B',
  '#4A6B1F',
  '#B07D12',
  '#286C8B',
  '#A13B6B',
  '#6B6B6B',
  '#2F7D32',
  '#B3261E',
];

export const PAL = COLORS;

export const num = (v: any, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const truthy = (v: any): boolean =>
  v === true || ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());

export const canonicalSolvent = (v: any): string => {
  const raw = String(v || 'water').trim();
  return SOLVENT_ALIASES[raw] || SOLVENT_ALIASES[raw.toLowerCase()] || raw;
};

export const round = (n: number, d = 10): number => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = mulberry32(seed >>> 0);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(a() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Breadboard plate mapping from zeus-pipetter/breadboard.py:
 * - plate0, plate1, plate2: 54-well vial_2ml (6x9)
 * - plate3, plate4, plate5: 8-slot bottle_20ml (2x4, accepts 20 mL or 40 mL bottles)
 * - plate6, plate7: 2-slot jar_100ml (1x2)
 */
export function defaultPlates(hood: 'left' | 'right'): DeckConfig {
  return hood === 'left'
    ? { solventPlate: 6, solventKind: 'jar', solventPos: 0, stockPlates: [3, 4, 5] }
    : { solventPlate: 3, solventKind: 'bottle', solventPos: 0, stockPlates: [3, 4, 5] };
}

export function benchNum(x: any, d = 4): string | number {
  return x == null || x === '' || !isFinite(+x) ? '' : +(+x).toPrecision(d);
}

export function localDate(t?: any): string {
  const d = t ? new Date(t) : new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
