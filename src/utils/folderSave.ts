// Optional auto-save of run records into a user-selected folder (e.g. Dropbox).
// Uses the File System Access API (Chromium browsers). Gracefully reports iframe/browser blocks.

const DB = 'robowski-folder';
const STORE = 'handles';
const KEY = 'autosave';

export function folderSaveSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<any | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(value: any | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value == null) tx.objectStore(STORE).delete(KEY);
    else tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface ChooseFolderResult {
  name: string | null;
  blockedReason?: 'unsupported' | 'iframe-blocked' | 'cancelled';
}

/** Ask the user for a folder (must be called from a click). */
export async function chooseSaveFolder(): Promise<ChooseFolderResult> {
  if (!folderSaveSupported()) {
    return { name: null, blockedReason: 'unsupported' };
  }
  try {
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'robowski-runs' });
    await idbSet(handle);
    return { name: handle.name as string };
  } catch (err: any) {
    if (err?.name === 'SecurityError') {
      return { name: null, blockedReason: 'iframe-blocked' };
    }
    return { name: null, blockedReason: 'cancelled' };
  }
}

export async function clearSaveFolder(): Promise<void> {
  try {
    await idbSet(null);
  } catch {}
}

export async function getSaveFolderName(): Promise<string | null> {
  const h = await idbGet();
  return h?.name ?? null;
}

/**
 * Write a file into the chosen folder. Returns 'saved', 'no-folder', or 'needs-permission'.
 */
export async function writeToSaveFolder(
  filename: string,
  data: string | Blob | Uint8Array
): Promise<'saved' | 'no-folder' | 'needs-permission'> {
  if (!folderSaveSupported()) return 'no-folder';
  const h = await idbGet();
  if (!h) return 'no-folder';
  try {
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await h.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
    }
    if (perm !== 'granted') return 'needs-permission';
    const fh = await h.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(data as any);
    await w.close();
    return 'saved';
  } catch {
    return 'needs-permission';
  }
}
