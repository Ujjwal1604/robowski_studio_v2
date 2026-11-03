// Robowski Studio - Constants & Physical Chemistry Data
import { DeckConfig } from '../types';

export const PLATE_CAPACITY = 54;
export const MAX_REACTION_SLOTS = 3;
export const BOTTLE_CAPACITY_ML = 20;
export const JAR_CAPACITY_ML = 100;
export const TIP_RACK_CAPACITY = 96;

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
];

export const ROBOT_SOLVENTS = new Set([
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
]);

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
};

export const SOLVENT_ALIASES: Record<string, string> = {
  EtOH: 'ethanol',
  Ethanol: 'ethanol',
  Water: 'water',
  Glycerin: 'glycerin',
  Serum: 'serum',
  chcl3: 'CHCl3',
  chloroform: 'CHCl3',
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

export function defaultPlates(hood: 'left' | 'right'): DeckConfig {
  return hood === 'left'
    ? { solventPlate: 4, solventKind: 'jar', solventPos: 0, stockPlates: [3, 5, 6] }
    : { solventPlate: 3, solventKind: 'bottle', solventPos: 0, stockPlates: [4, 5] };
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
