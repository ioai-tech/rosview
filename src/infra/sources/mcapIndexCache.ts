import type { McapIndexCache, SerializedMcapIndex } from './McapUnindexedIterableSource';

const DB_NAME = 'rosview-mcap-index';
const STORE = 'indexes';
/** Indexes are small (tens of bytes per message); keep the most recent few files. */
const MAX_ENTRIES = 16;

interface Entry {
  key: string;
  updatedAt: number;
  index: SerializedMcapIndex;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const req = factory.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('updatedAt', 'updatedAt');
  };
  return request(req);
}

/**
 * Persists unindexed-MCAP scan results in IndexedDB so reopening the same
 * recording (notably over HTTP, where a scan downloads the whole file) is
 * instant. Returns `undefined` where IndexedDB isn't available.
 */
export function createIndexedDbMcapIndexCache(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): McapIndexCache | undefined {
  if (!factory) return undefined;
  let db: Promise<IDBDatabase> | undefined;
  const store = async (mode: IDBTransactionMode) => {
    db ??= openDb(factory);
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };

  return {
    async get(key) {
      const entry = (await request((await store('readonly')).get(key))) as Entry | undefined;
      return entry?.index;
    },
    async set(key, index) {
      const objectStore = await store('readwrite');
      await request(objectStore.put({ key, updatedAt: Date.now(), index } satisfies Entry));
      const keys = (await request(objectStore.index('updatedAt').getAllKeys())) as string[];
      // Oldest first; drop everything beyond the cap.
      for (const staleKey of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
        await request(objectStore.delete(staleKey));
      }
    },
  };
}
