// Robowski Studio - Whole-App Personal Lab PC Python Backend Client
import type { WellPredictionResult } from './types';

const STORAGE_KEY = 'robowski_python_rdkit_url';
const DISABLED_SENTINEL = '__OFF__';
export const DEFAULT_LAB_BACKEND_URL = 'https://91474-p02.tail4c9e6a.ts.net';

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
