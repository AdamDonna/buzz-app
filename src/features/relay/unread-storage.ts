import {
  THREAD_PARTICIPATION_LIMIT,
  type ThreadMark,
  type ThreadParticipation,
} from "./thread-participation";

/** What the Inbox keeps on this device between launches, per relay and
 * viewer: the threads the viewer is part of. A record is read whole or not at
 * all, so nothing starts from part of one. */
export type UnreadRecord = Readonly<{ participation: ThreadParticipation }>;
export type UnreadStorage = Readonly<{
  /** The saved record, or undefined when none is saved or it is unusable. */
  read(): Promise<UnreadRecord | undefined>;
  /** Replaces the record. One that would not read back is refused and the
   * saved one kept. */
  save(record: UnreadRecord): Promise<void>;
  close(): void;
}>;

const VERSION = 1;

type StoredMeta = {
  version: typeof VERSION;
  participation: {
    roots: ([string, number] | [string, number, string])[];
    walk?: { since: number };
  };
};

const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function parseRoot(entry: unknown): [string, ThreadMark] | undefined {
  if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) return;
  const [key, at, newestId] = entry as unknown[];
  if (typeof key !== "string" || key.length > 256 || !time(at)) return;
  if (newestId === undefined) return [key, { at }];
  if (typeof newestId === "string" && newestId.length <= 64)
    return [key, { at, newestId }];
}
/** Storage is untrusted: a meta of another version or any malformed part
 * reads as no record. */
function parse(raw: unknown): UnreadRecord | undefined {
  if (!raw || typeof raw !== "object") return;
  const meta = raw as { version?: unknown; participation?: unknown };
  if (meta.version !== VERSION) return;
  if (!meta.participation || typeof meta.participation !== "object") return;
  const { roots, walk } = meta.participation as {
    roots?: unknown;
    walk?: unknown;
  };
  if (!Array.isArray(roots) || roots.length > THREAD_PARTICIPATION_LIMIT)
    return;
  const marks = new Map<string, ThreadMark>();
  for (const entry of roots) {
    const root = parseRoot(entry);
    if (!root) return;
    marks.set(...root);
  }
  const since = (walk as { since?: unknown } | null | undefined)?.since;
  if (walk !== undefined && !time(since)) return;
  return {
    participation: time(since)
      ? { roots: marks, walk: { since } }
      : { roots: marks },
  };
}
/** The stored meta, refusing a record that would not read back. */
function stored({ participation }: UnreadRecord): StoredMeta {
  const meta: StoredMeta = {
    version: VERSION,
    participation: {
      roots: [...participation.roots].map(([key, { at, newestId }]) =>
        newestId === undefined ? [key, at] : [key, at, newestId],
      ),
      ...(participation.walk
        ? { walk: { since: participation.walk.since } }
        : {}),
    },
  };
  if (!parse(meta))
    throw new RangeError("Unread record exceeds its storage bounds");
  return meta;
}

export function memoryUnreadStorage(): UnreadStorage {
  let saved: UnreadRecord | undefined;
  return {
    read: async () => saved,
    save: async (record) => {
      stored(record);
      const { roots, walk } = record.participation;
      saved = {
        participation: { roots: new Map(roots), ...(walk ? { walk } : {}) },
      };
    },
    close() {},
  };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-unread-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta");
      // Signed evidence keyed by partition and ID, for a later build to
      // restore from; nothing writes it yet.
      request.result
        .createObjectStore("events", { keyPath: ["scope", "id"] })
        .createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to open saved unread state"));
  });
}
function settle(
  tx: IDBTransaction,
  resolve: () => void,
  reject: (cause: unknown) => void,
) {
  tx.oncomplete = () => resolve();
  tx.onabort = () =>
    reject(tx.error ?? new Error("Unread storage transaction aborted"));
  tx.onerror = () => reject(tx.error);
}
/** Device-local and partitioned by relay and viewer, like read state: one
 * meta entry per partition. A sibling database rather than more stores in
 * `buzz-read-state-v1`, so neither owner's schema version gates the other. */
export function browserUnreadStorage(scope: string): UnreadStorage {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  function open() {
    if (closed) return Promise.reject(new Error("Unread storage closed"));
    // A failed open is not held against the next read or save.
    database ??= openDatabase().catch((cause: unknown) => {
      database = undefined;
      throw cause;
    });
    return database;
  }
  return {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readonly");
        const meta = tx.objectStore("meta").get(scope);
        settle(tx, () => resolve(parse(meta.result)), reject);
      });
    },
    async save(record) {
      const meta = stored(record);
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(meta, scope);
        settle(tx, resolve, reject);
      });
    },
    close() {
      closed = true;
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
/** Forgets one partition's record once the viewer has left that community. */
export async function purgeUnreadStorage(scope: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").delete(scope);
      settle(tx, resolve, reject);
    });
  } finally {
    db.close();
  }
}
