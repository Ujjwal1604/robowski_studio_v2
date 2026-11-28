// Robowski Studio - Whole-App Personal Lab PC Python Backend Client
import type { WellPredictionResult } from './types';

const STORAGE_KEY = 'robowski_python_rdkit_url';
const DISABLED_SENTINEL = '__OFF__';
export const DEFAULT_LAB_BACKEND_URL = String(
  (import.meta as any).env?.VITE_ROBOWSKI_BACKEND_URL || ''
)
  .trim()
  .replace(/\/+$/, '');

export interface PythonBackendStatus {
  connected: boolean;
  url: string;
  version?: string;
  rdkitVersion?: string;
  runsCount?: number;
  libraryCount?: number;
  tlcObservations?: number;
  tlcImagesCount?: number;
  archivesCount?: number;
  features?: string[];
  error?: string;
}

export interface ReagentInspectionResult {
  valid: boolean;
  canonicalSmiles?: string;
  formula?: string;
  exactMass?: number;
  molarMass?: number;
  parentMolarMass?: number;
  saltFragments?: string[];
  hasWater?: boolean;
  clogP?: number;
  tpsa?: number;
  error?: string;
}

export function getPythonBackendUrl(): string {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return '';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_LAB_BACKEND_URL;
    if (stored === DISABLED_SENTINEL) return '';
    return stored.trim().replace(/\/+$/, '');
  } catch {
    return DEFAULT_LAB_BACKEND_URL;
  }
}

export function normalizePythonBackendUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Shorthand Cloudflare tunnel words (e.g. "happy-blue-tiger" -> "https://happy-blue-tiger.trycloudflare.com")
  if (/^[a-z0-9]+(?:-[a-z0-9]+){1,}$/i.test(trimmed) && !/^localhost$/i.test(trimmed)) {
    return `https://${trimmed.toLowerCase()}.trycloudflare.com`;
  }
  // Localhost or raw IPv4 address -> http://
  if (/^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function setPythonBackendUrl(url: string): string {
  const clean = normalizePythonBackendUrl(url);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
      else window.localStorage.setItem(STORAGE_KEY, DISABLED_SENTINEL);
    }
  } catch {}
  return clean;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function testPythonBackend(rawUrl: string): Promise<PythonBackendStatus> {
  const url = normalizePythonBackendUrl(rawUrl);
  if (!url) {
    return { connected: false, url: '', error: 'No URL configured.' };
  }
  try {
    const resp = await fetchWithTimeout(`${url}/health`, { method: 'GET' }, 4000);
    if (!resp.ok) {
      return { connected: false, url, error: `Server responded with HTTP ${resp.status}` };
    }
    const data = await resp.json();
    if (!data?.ok) {
      return { connected: false, url, error: 'Unexpected health response.' };
    }
    return {
      connected: true,
      url,
      version: String(data.version || '1.0.0'),
      rdkitVersion: String(data.rdkitVersion || 'RDKit'),
      runsCount: Number(data.runsCount || 0),
      libraryCount: Number(data.libraryCount || 0),
      tlcObservations: Number(data.tlcObservations || 0),
      tlcImagesCount: Number(data.tlcImagesCount || 0),
      archivesCount: Number(data.archivesCount || 0),
      features: Array.isArray(data.features) ? data.features : [],
    };
  } catch (err: any) {
    const msg =
      err?.name === 'AbortError'
        ? 'Connection timed out (is uv run app.py running on your lab PC?)'
        : 'Could not reach Lab PC server (check URL or HTTPS tunnel).';
    return { connected: false, url, error: msg };
  }
}

// ---------------------------------------------------------------------------
// 1. Saved Runs Sync
// ---------------------------------------------------------------------------
export async function fetchBackendRuns<T = any>(overrideUrl?: string): Promise<T[] | null> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) return null;
  try {
    const resp = await fetchWithTimeout(`${url}/api/runs`, { method: 'GET' }, 8000);
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data?.runs) ? (data.runs as T[]) : null;
  } catch {
    return null;
  }
}

export async function saveBackendRun(runObj: { id: string; [k: string]: any }, overrideUrl?: string): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !runObj?.id) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/runs/${encodeURIComponent(runObj.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runObj),
      },
      8000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function bulkSaveBackendRuns(runs: any[], overrideUrl?: string): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || runs.length === 0) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/runs/bulk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs }),
      },
      12000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function deleteBackendRun(id: string, overrideUrl?: string): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !id) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/runs/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      5000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. Reagent Library Sync
// ---------------------------------------------------------------------------
export async function fetchBackendLibrary<T = any>(overrideUrl?: string): Promise<T[] | null> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) return null;
  try {
    const resp = await fetchWithTimeout(`${url}/api/library`, { method: 'GET' }, 8000);
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data?.items) ? (data.items as T[]) : null;
  } catch {
    return null;
  }
}

export async function saveBackendLibraryItem(
  item: { id: string; [k: string]: any },
  overrideUrl?: string
): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !item?.id) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/library/${encodeURIComponent(item.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      },
      6000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function bulkSaveBackendLibrary(items: any[], overrideUrl?: string): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || items.length === 0) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/library/bulk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      },
      10000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function deleteBackendLibraryItem(id: string, overrideUrl?: string): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !id) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/library/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      5000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. High-Res TLC Plate Image Disk Sync
// ---------------------------------------------------------------------------
export async function uploadBackendTlcImage(
  uid: string,
  key: string,
  name: string,
  blob: Blob,
  overrideUrl?: string
): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !uid || !key) return false;
  try {
    const form = new FormData();
    form.append('file', blob, name || 'plate.png');
    form.append('name', name || 'plate.png');
    const resp = await fetchWithTimeout(
      `${url}/api/tlc-images/${encodeURIComponent(uid)}/${encodeURIComponent(key)}`,
      { method: 'PUT', body: form },
      15000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function downloadBackendTlcImage(
  uid: string,
  key: string,
  overrideUrl?: string
): Promise<{ name: string; blob: Blob } | null> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !uid || !key) return null;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/tlc-images/${encodeURIComponent(uid)}/${encodeURIComponent(key)}`,
      { method: 'GET' },
      15000
    );
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const name = resp.headers.get('X-Robowski-Filename') || `${key}.png`;
    return { name, blob };
  } catch {
    return null;
  }
}

export async function deleteBackendTlcImage(
  uid: string,
  key: string,
  overrideUrl?: string
): Promise<boolean> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !uid || !key) return false;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/tlc-images/${encodeURIComponent(uid)}/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
      5000
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4. One-Click Archive Backup & RDKit-Illustrated Excel ELN Export
// ---------------------------------------------------------------------------
export async function saveArchiveToBackend(
  runName: string,
  filename: string,
  bytes: Uint8Array | Blob,
  overrideUrl?: string
): Promise<{ success: boolean; relativePath?: string; error?: string }> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) return { success: false, error: 'Lab PC server not connected.' };
  try {
    const blob =
      bytes instanceof Blob
        ? bytes
        : new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
            type: 'application/octet-stream',
          });
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('runName', runName || 'robowski_run');
    form.append('filename', filename);
    const resp = await fetchWithTimeout(
      `${url}/api/archives/save`,
      { method: 'POST', body: form },
      30000
    );
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { success: Boolean(data?.success), relativePath: data?.relativePath };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Archive upload failed.' };
  }
}

export interface IllustratedElnPayload {
  runName: string;
  hood: string;
  mode: string;
  date?: string;
  conditions: Record<string, any>;
  reagents: Array<{
    code?: string;
    name?: string;
    smiles?: string;
    molarMass?: number | string;
    stock?: number | string;
    solvent?: string;
  }>;
  observations: Array<{
    plate?: number;
    well?: string;
    outcome?: string;
    tags?: string[];
    notes?: string;
    components?: string;
  }>;
}

export async function downloadIllustratedElnXlsx(
  payload: IllustratedElnPayload,
  overrideUrl?: string
): Promise<{ ok: boolean; filename?: string; blob?: Blob; error?: string }> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'Lab PC server not connected.' };
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/export/eln-illustrated-xlsx`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      20000
    );
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const blob = await resp.blob();
    const disp = resp.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `${payload.runName || 'run'}_ELN_Illustrated.xlsx`;
    return { ok: true, filename, blob };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Could not generate illustrated Excel ELN.' };
  }
}

// ---------------------------------------------------------------------------
// 5. Reagent RDKit Inspection & 3D Reaction Predictor Refinement
// ---------------------------------------------------------------------------
export async function inspectReagentWithBackend(
  smiles: string,
  overrideUrl?: string
): Promise<ReagentInspectionResult | null> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !smiles.trim()) return null;
  try {
    const resp = await fetchWithTimeout(
      `${url}/api/chemistry/inspect-reagent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smiles: smiles.trim() }),
      },
      4500
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.success) return { valid: false, error: data?.error };
    return { valid: true, ...data };
  } catch {
    return null;
  }
}

export async function refineWellWithPythonBackend(
  wellResult: WellPredictionResult,
  overrideUrl?: string
): Promise<WellPredictionResult> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || !wellResult || wellResult.species.length === 0) return wellResult;

  try {
    const resp = await fetchWithTimeout(
      `${url}/api/chemistry/refine-well`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wellResult }),
      },
      6000
    );
    if (!resp.ok) return wellResult;
    const data = await resp.json();
    if (data?.success && data?.result) {
      return data.result as WellPredictionResult;
    }
  } catch {}
  return wellResult;
}

export async function refinePlateWithPythonBackend(
  wellResults: Record<string, WellPredictionResult>,
  overrideUrl?: string
): Promise<Record<string, WellPredictionResult>> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url || Object.keys(wellResults).length === 0) return wellResults;

  try {
    const resp = await fetchWithTimeout(
      `${url}/api/chemistry/refine-plate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wellResults }),
      },
      15000
    );
    if (!resp.ok) return wellResults;
    const data = await resp.json();
    if (data?.success && data?.results) {
      return data.results as Record<string, WellPredictionResult>;
    }
  } catch {}
  return wellResults;
}

export interface TlcFeedbackPayload {
  wellKey: string;
  ruleIds: string[];
  observedNewSpot: boolean;
  solventSystem?: string;
  measuredRf?: number;
  substrates?: string[];
  notes?: string;
}

export async function submitTlcFeedback(
  payload: TlcFeedbackPayload
): Promise<{ savedTo: 'python' | 'builtin' | 'failed'; totalObservations?: number }> {
  const pyUrl = getPythonBackendUrl();
  if (pyUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${pyUrl}/api/tlc/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        4000
      );
      if (resp.ok) {
        const data = await resp.json();
        return { savedTo: 'python', totalObservations: Number(data?.totalObservations || 0) };
      }
    } catch {}
  }

  try {
    const resp = await fetch('/api/predictor/tlc-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      const data = await resp.json();
      return { savedTo: 'builtin', totalObservations: Number(data?.totalObservations || 0) };
    }
  } catch {}

  return { savedTo: 'failed' };
}

// ---------------------------------------------------------------------------
// 6. Live Robot Status, Run Progress & Hardware Command Bridge
// ---------------------------------------------------------------------------
export interface RobotTipRackSummary {
  tipType: '50ul' | '300ul' | '1000ul';
  remaining: number;
  total: number;
  used: number;
}

export interface RobotActivityEntry {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  summary: string;
  raw: string;
}

export interface RobotSubstanceProgress {
  substance: string;
  completed: number;
  total: number;
  percent: number;
}

export interface RobotStockLiveLevel {
  substance: string;
  plate: number;
  containerId: number;
  solvent: string;
  initialVolumeUl: number;
  remainingVolumeUl: number;
  surfaceHeightZ: number | null;
  percentRemaining: number;
}

export interface RobotRunProgress {
  fileName: string;
  relativePath: string;
  updatedIso: string;
  totalVials: number;
  completedVials: number;
  inProgressVials: number;
  notStartedVials: number;
  percentComplete: number;
  plateBarcode?: string | null;
  dilutionBarcodes?: string[];
  reactionDurationHours?: number | null;
  substances: RobotSubstanceProgress[];
  wellStates: Array<'completed' | 'in_progress' | 'not_started'>;
  stocks: RobotStockLiveLevel[];
}

export interface RobotPlatePreset {
  id: string;
  name: string;
  plateSlot: 0 | 1 | 2;
  rows: number;
  cols: number;
  cornerA1: [number, number];
  cornerTopRight: [number, number];
  cornerBottomLeft: [number, number];
  defaultZ: number;
  colPitchMm: number;
  rowPitchMm: number;
  angleDeg: number;
  updatedAt?: string;
}

export interface RobotPlateTransferState {
  active: boolean;
  state: 'idle' | 'running' | 'completed' | 'stopped' | 'error';
  srcPlate: number;
  dstPlate: number;
  srcPresetId?: string;
  dstPresetId?: string;
  srcPresetName?: string;
  dstPresetName?: string;
  srcRows?: number;
  srcCols?: number;
  dstRows?: number;
  dstCols?: number;
  volumeUl: number;
  solvent: string;
  tipType: string;
  changeTipEachVial: boolean;
  totalWells: number;
  completedWells: number;
  currentWell: number | null;
  currentPair?: [number, number] | null;
  failedWell: number | null;
  failedPair?: [number, number] | null;
  wells: number[];
  pairs?: Array<[number, number]>;
  completedList: number[];
  completedPairs?: Array<[number, number]>;
  startedAt?: string | null;
  finishedAt?: string | null;
  message: string;
  error?: string | null;
}

export interface RobotHardwareState {
  controlEnabled: boolean;
  pinProtected?: boolean;
  relayTokenConfigured?: boolean;
  connected: boolean;
  homed?: boolean;
  nanodropConnected?: boolean;
  nanodropId?: string;
  nanodropLidClosed?: boolean;
  busy: boolean;
  currentTip: string;
  currentPosition: string;
  currentXY?: [number, number] | null;
  currentZ?: number | null;
  lastCommand?: string | null;
  lastCommandAt?: string | null;
  lastError?: string | null;
  idleReleaseSeconds?: number;
  idleSecondsRemaining?: number | null;
  plateTransfer?: RobotPlateTransferState | null;
  platePresets?: RobotPlatePreset[];
}

export interface RobotActiveCommandState {
  id: string;
  command: string;
  description: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt?: string | null;
  startedAt?: string | null;
}

export interface RobotLiveStatus {
  ok: boolean;
  robotName: string;
  state: 'running' | 'waiting_user' | 'idle' | 'error' | 'not_configured';
  headline: string;
  detail: string;
  lastUpdatedIso?: string | null;
  secondsAgo?: number | null;
  dataPathConfigured: boolean;
  logFileName?: string | null;
  tipRacks: RobotTipRackSummary[];
  activeRun: RobotRunProgress | null;
  availableRuns: Array<{ fileName: string; relativePath: string; updatedIso: string }>;
  recentActivity: RobotActivityEntry[];
  rawLogTail: string[];
  hardware: RobotHardwareState;
  activeCommand?: RobotActiveCommandState | null;
  relaySource?: string;
  agentOnline?: boolean;
  agentLastSeenSecondsAgo?: number;
}

export interface RobotCommandResult {
  ok: boolean;
  executed: boolean;
  pending?: boolean;
  commandId?: string;
  state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  command: string;
  humanMessage: string;
  pythonSnippet: string;
  data?: Record<string, any>;
  hardware?: RobotHardwareState;
  error?: string;
}

export async function fetchRobotLiveStatus(
  runPath?: string,
  overrideUrl?: string
): Promise<RobotLiveStatus | null> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) return null;
  try {
    const qs = runPath ? `?run_path=${encodeURIComponent(runPath)}` : '';
    const resp = await fetchWithTimeout(`${url}/api/robot/status${qs}`, { method: 'GET' }, 7000);
    if (!resp.ok) return null;
    return (await resp.json()) as RobotLiveStatus;
  } catch {
    return null;
  }
}

export async function sendRobotCommand(
  command: string,
  params: Record<string, any> = {},
  overrideUrl?: string,
  controlPin?: string
): Promise<RobotCommandResult> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) {
    return {
      ok: false,
      executed: false,
      command,
      humanMessage: 'Lab PC server is not connected. Connect it in the top bar first.',
      pythonSnippet: '',
      error: 'Not connected',
    };
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (controlPin) headers['X-Robowski-Pin'] = controlPin;
    const isLongCmd =
      command === 'nanodrop_wash_cycle' ||
      command === 'nanodrop_flush' ||
      command === 'nanodrop_dry' ||
      command === 'single_transfer';
    const resp = await fetchWithTimeout(
      `${url}/api/robot/command`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ command, params }),
      },
      isLongCmd ? 70000 : 25000
    );
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return {
        ok: false,
        executed: false,
        command,
        humanMessage: data?.detail || data?.humanMessage || `Command failed (HTTP ${resp.status}).`,
        pythonSnippet: data?.pythonSnippet || '',
        error: data?.detail || `HTTP ${resp.status}`,
      };
    }
    return data as RobotCommandResult;
  } catch (err: any) {
    return {
      ok: false,
      executed: false,
      command,
      humanMessage:
        err?.name === 'AbortError'
          ? 'The command may still be running on the Robot PC — check the live status banner instead of clicking again.'
          : 'Could not reach the Lab PC server.',
      pythonSnippet: '',
      error: err?.message || 'Request failed',
    };
  }
}

export async function cancelQueuedRobotCommand(
  commandId: string,
  overrideUrl?: string,
  controlPin?: string
): Promise<{ ok: boolean; cancelled?: boolean; humanMessage: string }> {
  const url = (overrideUrl ?? getPythonBackendUrl()).trim().replace(/\/+$/, '');
  if (!url) {
    return { ok: false, humanMessage: 'Lab PC server is not connected.' };
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (controlPin) headers['X-Robowski-Pin'] = controlPin;
    const resp = await fetchWithTimeout(
      `${url}/api/robot/command/${encodeURIComponent(commandId)}/cancel`,
      { method: 'POST', headers },
      8000
    );
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      return {
        ok: false,
        humanMessage: data?.detail || data?.humanMessage || `Could not cancel command (HTTP ${resp.status}).`,
      };
    }
    return {
      ok: true,
      cancelled: Boolean(data?.cancelled),
      humanMessage: data?.humanMessage || 'Cancelled queued command.',
    };
  } catch {
    return { ok: false, humanMessage: 'Could not reach the Lab PC server to cancel.' };
  }
}
