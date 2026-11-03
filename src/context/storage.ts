// Robowski Studio - Storage Persistence Helpers
import { LibraryReagent, RunState, SavedRun } from '../types';
import { normalize, exampleState } from './runPayload';

const RUNS_KEY = 'rs.runs';
const LIB_KEY = 'rs.lib';
const PLATES_OK_KEY = 'rs.platesOk';
const DRAFT_KEY = 'rs.draft2';
const THEME_KEY = 'rs.theme';

export function loadSavedRuns(): SavedRun[] {
  try {
    return JSON.parse(localStorage.getItem(RUNS_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

export function saveSavedRuns(runs: SavedRun[]): void {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch (e) {}
}

export const DEFAULT_LIBRARY: LibraryReagent[] = [
  { id: 'l1', name: 'amine', molarMass: 211.26, density: 0 },
  { id: 'l2', name: 'ethyl acetoacetate', molarMass: 130.14, density: 1.03 },
  { id: 'l3', name: 'iodine', molarMass: 253.81, density: 0 },
  { id: 'l4', name: 'indene oxide', molarMass: 132.162, density: 0 },
  { id: 'l5', name: 'p-toluic acid', molarMass: 136.15, density: 0 },
];

export function loadSavedLib(): LibraryReagent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    if (parsed.length) return parsed;
  } catch (e) {}
  return DEFAULT_LIBRARY;
}

export function saveSavedLib(lib: LibraryReagent[]): void {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch (e) {}
}

export function loadConfirmedPlates(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PLATES_OK_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

export function saveConfirmedPlates(signatures: string[]): void {
  try {
    localStorage.setItem(PLATES_OK_KEY, JSON.stringify(signatures));
  } catch (e) {}
}

export function loadDraftState(): RunState {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      const d = JSON.parse(saved);
      if (d && d.reagents && d.reagents.length >= 2) return normalize(d);
    }
  } catch (e) {}
  return normalize(exampleState());
}

export function saveDraftState(st: RunState): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(st));
  } catch (e) {}
}

export function loadSavedTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (e) {}
  return 'light';
}

export function saveTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (e) {}
}
