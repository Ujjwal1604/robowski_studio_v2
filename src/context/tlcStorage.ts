// Robowski Studio - TLC IndexedDB Image Store
// Stores high-resolution plate images keyed by Set UID and Channel (UV254, UV366, White)
// Fails soft if IndexedDB is unavailable or blocked (e.g., private browsing mode).
import {
  deleteBackendTlcImage,
  downloadBackendTlcImage,
  getPythonBackendUrl,
  uploadBackendTlcImage,
} from '../engine/predictor/backendClient';

let tlcDbPromise: Promise<IDBDatabase | null> | null = null;

function getTlcDb(): Promise<IDBDatabase | null> {
  if (tlcDbPromise) return tlcDbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  tlcDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('robowski-tlc', 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains('img')) {
            req.result.createObjectStore('img');
          }
        } catch {
          // ignore
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    } catch {
      resolve(null);
    }
  });

  return tlcDbPromise;
}

async function runTlcDbTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | null> {
  const db = await getTlcDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    try {
      const tx = db.transaction('img', mode);
      const req = fn(tx.objectStore('img'));
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(req && 'result' in req ? (req.result as T) : (true as unknown as T));
      };
      tx.onerror = tx.onabort = () => {
        clearTimeout(timer);
        resolve(null);
      };
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function putTlcImage(
  uid: string,
  key: string,
  name: string,
  blob: Blob
): Promise<boolean> {
  const res = await runTlcDbTx('readwrite', (store) =>
    store.put({ name, blob }, `${uid}/${key}`)
  );
  if (getPythonBackendUrl()) {
    void uploadBackendTlcImage(uid, key, name, blob);
  }
  return res !== null;
}

export async function getTlcImage(
  uid: string,
  key: string
): Promise<{ name: string; blob: Blob } | null> {
  const res = await runTlcDbTx<{ name: string; blob: Blob }>('readonly', (store) =>
    store.get(`${uid}/${key}`)
  );
  if (res) return res;
  if (getPythonBackendUrl()) {
    const remote = await downloadBackendTlcImage(uid, key);
    if (remote) {
      await runTlcDbTx('readwrite', (store) => store.put(remote, `${uid}/${key}`));
      return remote;
    }
  }
  return null;
}

export async function deleteTlcSetImages(uid: string, keys: string[]): Promise<void> {
  await runTlcDbTx('readwrite', (store) => {
    keys.forEach((k) => store.delete(`${uid}/${k}`));
  });
  if (getPythonBackendUrl()) {
    keys.forEach((k) => {
      void deleteBackendTlcImage(uid, k);
    });
  }
}

export async function deleteAllSetImages(uid: string): Promise<void> {
  const prefix = `${uid}/`;
  const allKeys = await runTlcDbTx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  const keysToDelete: string[] = [];
  if (Array.isArray(allKeys)) {
    for (const k of allKeys) {
      const str = String(k);
      if (str.startsWith(prefix)) keysToDelete.push(str.slice(prefix.length));
    }
  }
  const fallback = ['UV254', 'White', 'UV366', 'p1_UV254', 'p1_White', 'p1_UV366', 'p2_UV254', 'p2_White', 'p2_UV366'];
  const unique = Array.from(new Set([...keysToDelete, ...fallback]));
  await deleteTlcSetImages(uid, unique);
}

export async function getAllSetImages(
  uid: string,
  extraKeys: string[] = []
): Promise<Array<{ uid: string; key: string; name: string; blob: Blob }>> {
  const prefix = `${uid}/`;
  const discovered = await runTlcDbTx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  const keysSet = new Set<string>(extraKeys);

  if (Array.isArray(discovered) && discovered.length > 0) {
    for (const fullKey of discovered) {
      const str = String(fullKey);
      if (str.startsWith(prefix)) {
        keysSet.add(str.slice(prefix.length));
      }
    }
  } else {
    for (const k of ['UV254', 'White', 'UV366', 'p1_UV254', 'p1_White', 'p1_UV366', 'p2_UV254', 'p2_White', 'p2_UV366']) {
      keysSet.add(k);
    }
  }

  const list: Array<{ uid: string; key: string; name: string; blob: Blob }> = [];
  for (const k of keysSet) {
    const im = await getTlcImage(uid, k);
    if (im) {
      list.push({ uid, key: k, name: im.name, blob: im.blob });
    }
  }
  return list;
}

export async function getImagesForSets(
  sets: Array<{ uid: string; plateData?: Record<number, { imgs?: Record<string, any> }>; imgs?: Record<string, any> }>
): Promise<Array<{ uid: string; key: string; name: string; blob: Blob }>> {
  const all: Array<{ uid: string; key: string; name: string; blob: Blob }> = [];
  for (const s of sets) {
    const knownKeys: string[] = [];
    for (const ch of Object.keys(s.imgs || {})) knownKeys.push(ch);
    if (s.plateData) {
      for (const [pStr, pd] of Object.entries(s.plateData)) {
        const p = Number(pStr);
        if (Number.isFinite(p) && p > 0 && pd?.imgs) {
          for (const ch of Object.keys(pd.imgs)) knownKeys.push(`p${p}_${ch}`);
        }
      }
    }
    const imgs = await getAllSetImages(s.uid, knownKeys);
    all.push(...imgs);
  }
  return all;
}

