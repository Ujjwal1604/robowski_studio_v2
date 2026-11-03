// Robowski Studio - TLC IndexedDB Image Store
// Stores high-resolution plate images keyed by Set UID and Channel (UV254, UV366, White)
// Fails soft if IndexedDB is unavailable or blocked (e.g., private browsing mode).

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
  return res !== null;
}

export async function getTlcImage(
  uid: string,
  key: string
): Promise<{ name: string; blob: Blob } | null> {
  const res = await runTlcDbTx<{ name: string; blob: Blob }>('readonly', (store) =>
    store.get(`${uid}/${key}`)
  );
  return res || null;
}

export async function deleteTlcSetImages(uid: string, keys: string[]): Promise<void> {
  await runTlcDbTx('readwrite', (store) => {
    keys.forEach((k) => store.delete(`${uid}/${k}`));
  });
}

export async function getAllSetImages(
  uid: string,
  keys: string[] = ['UV254', 'White', 'UV366']
): Promise<Array<{ uid: string; key: string; name: string; blob: Blob }>> {
  const list: Array<{ uid: string; key: string; name: string; blob: Blob }> = [];
  for (const k of keys) {
    const im = await getTlcImage(uid, k);
    if (im) {
      list.push({ uid, key: k, name: im.name, blob: im.blob });
    }
  }
  return list;
}

export async function getImagesForSets(
  sets: Array<{ uid: string }>
): Promise<Array<{ uid: string; key: string; name: string; blob: Blob }>> {
  const all: Array<{ uid: string; key: string; name: string; blob: Blob }> = [];
  for (const s of sets) {
    const imgs = await getAllSetImages(s.uid);
    all.push(...imgs);
  }
  return all;
}

