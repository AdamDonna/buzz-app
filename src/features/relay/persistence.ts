import { byteSize } from "./budget";
import type { SidebarPreferences } from "./sidebar-preferences";
/** Device-local resume data, never proof of current access or permission to write. */
export type SavedStartup = {
  discovery?: {
    savedAt: number;
    relayAuthor: string;
    events: unknown[];
    profiles?: unknown[];
  };
  preferences?: { savedAt: number; data: SidebarPreferences };
};
/** Signed wire records only. The owner re-verifies before displaying cached history.
 * A cache hit is never authority for current membership or freshness. No keys/tokens are persisted. */
export type SavedHead = {
  channelId: string;
  savedAt: number;
  events: unknown[];
  profiles: unknown[];
};
export interface HeadPersistence {
  read(): Promise<SavedHead[]>;
  readStartup?(): Promise<SavedStartup | undefined>;
  writeStartup?(patch: SavedStartup): Promise<void>;
  write(head: SavedHead): Promise<void>;
  remove(channelId: string): Promise<void>;
  retain(channelIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}
const DB = "buzz-channel-heads-v1";
const STORE = "heads";
const STARTUP = "startup";
const budgetStore = (name: string) => `${name}-budget`;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_HEADS = 64;
const MAX_AGE = 24 * 60 * 60 * 1000;
type Record = SavedHead & { key: string; scope: string; bytes: number };
type Budget = { key: string; bytes: number; savedAt: number };

export function createHeadPersistence(
  viewer: string,
  relay: string,
): HeadPersistence {
  const scope = `${viewer}:${relay}`;
  let closed = false;
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (closed || typeof indexedDB === "undefined")
      return Promise.reject(new Error("Cache unavailable"));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 3);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(new Error("Cache open timed out"));
      }, 1500);
      request.onupgradeneeded = () => {
        const tx = request.transaction;
        if (!tx) throw new Error("Cache upgrade transaction unavailable");
        for (const name of [STORE, STARTUP]) {
          const store = request.result.objectStoreNames.contains(name)
            ? tx.objectStore(name)
            : request.result.createObjectStore(name, { keyPath: "key" });
          if (request.result.objectStoreNames.contains(budgetStore(name)))
            continue;
          const budget = request.result.createObjectStore(budgetStore(name), {
            keyPath: "key",
          });
          // Read existing payloads once at upgrade, never on each budget scan.
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const { key, bytes, savedAt } = cursor.value as Budget;
            budget.put({ key, bytes, savedAt });
            cursor.continue();
          };
        }
      };
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error);
      };
      request.onblocked = () => {
        expired = true;
        clearTimeout(timeout);
        reject(new Error("Cache blocked"));
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (closed || expired) {
          request.result.close();
          reject(new Error("Cache closed"));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return opening;
  }
  /** `handler` must issue follow-up requests synchronously (IDB auto-commits). */
  type Then = <R>(request: IDBRequest<R>, handler: (result: R) => void) => void;
  async function transact<T>(
    mode: IDBTransactionMode,
    work: (
      store: IDBObjectStore,
      done: (value: T) => void,
      then: Then,
      budget: IDBObjectStore,
    ) => void,
    name = STORE,
  ): Promise<T> {
    const db = await database();
    if (closed) throw new Error("Cache closed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([name, budgetStore(name)], mode);
      let result: T;
      let ended = false;
      const timeout = setTimeout(() => {
        ended = true;
        try {
          tx.abort();
        } catch (error) {
          // Native completion can precede its queued event. Let that event
          // settle the operation when the transaction can no longer abort.
          if (
            !(
              error instanceof DOMException &&
              error.name === "InvalidStateError"
            )
          )
            reject(error);
        }
      }, 2000);
      tx.oncomplete = () => {
        clearTimeout(timeout);
        resolve(result);
      };
      tx.onabort = tx.onerror = () => {
        ended = true;
        clearTimeout(timeout);
        reject(tx.error ?? new Error("Cache transaction aborted"));
      };
      work(
        tx.objectStore(name),
        (value) => {
          result = value;
        },
        (request, handler) => {
          request.onsuccess = () => {
            if (ended) return;
            try {
              handler(request.result);
            } catch (error) {
              // WebKit delivers a queued success after a browser-initiated abort.
              if (
                !(
                  error instanceof DOMException &&
                  error.name === "TransactionInactiveError"
                )
              )
                throw error;
              ended = true;
            }
          };
        },
        tx.objectStore(budgetStore(name)),
      );
    });
  }
  return {
    readStartup: () =>
      transact(
        "readonly",
        (store, done, then) => then(store.get(scope), (row) => done(row?.data)),
        STARTUP,
      ),
    writeStartup: (patch) =>
      transact(
        "readwrite",
        (store, done, then, budget) =>
          then(store.get(scope), (row) => {
            const data = { ...row?.data, ...patch };
            const bytes = byteSize(data);
            if (bytes <= MAX_BYTES) {
              const entry = { key: scope, bytes, savedAt: Date.now() };
              store.put({ ...entry, data });
              budget.put(entry);
              then(budget.getAll(), (rows: Budget[]) => {
                let total = 0;
                for (const row of rows.sort((a, b) => b.savedAt - a.savedAt)) {
                  total += row.bytes;
                  if (total > MAX_BYTES) {
                    store.delete(row.key);
                    budget.delete(row.key);
                  }
                }
              });
            }
            done(undefined);
          }),
        STARTUP,
      ),
    read: () =>
      transact("readonly", (store, done, then) =>
        then(store.getAll(), (rows: Record[]) =>
          done(
            rows
              .filter(
                (row) =>
                  row.scope === scope && Date.now() - row.savedAt < MAX_AGE,
              )
              .sort((a, b) => b.savedAt - a.savedAt)
              .slice(0, MAX_HEADS),
          ),
        ),
      ),
    write: (head) =>
      transact("readwrite", (store, done, then, budget) => {
        const bytes = byteSize(head);
        if (bytes > MAX_BYTES) {
          done(undefined);
          return;
        }
        const row: Record = {
          ...head,
          scope,
          key: `${scope}:${head.channelId}`,
          bytes,
        };
        store.put(row);
        budget.put({ key: row.key, bytes, savedAt: head.savedAt });
        then(budget.getAll(), (rows: Budget[]) => {
          // Global disk budget across identities; scope is still required for every read.
          let total = 0,
            count = 0;
          for (const entry of rows.sort((a, b) => b.savedAt - a.savedAt)) {
            total += entry.bytes;
            count++;
            if (
              total > MAX_BYTES ||
              count > MAX_HEADS ||
              Date.now() - entry.savedAt >= MAX_AGE
            ) {
              store.delete(entry.key);
              budget.delete(entry.key);
            }
          }
          done(undefined);
        });
      }),
    remove: (channelId) =>
      transact("readwrite", (store, done, _then, budget) => {
        store.delete(`${scope}:${channelId}`);
        budget.delete(`${scope}:${channelId}`);
        done(undefined);
      }),
    retain: (ids) =>
      transact("readwrite", (store, done, then, budget) => {
        const allowed = new Set(ids);
        then(store.getAll(), (rows: Record[]) => {
          for (const row of rows)
            if (row.scope === scope && !allowed.has(row.channelId)) {
              store.delete(row.key);
              budget.delete(row.key);
            }
          done(undefined);
        });
      }),
    clear: async () => {
      await transact(
        "readwrite",
        (store, done, _then, budget) => {
          store.delete(scope);
          budget.delete(scope);
          done(undefined);
        },
        STARTUP,
      );
      await transact("readwrite", (store, done, then, budget) =>
        then(store.getAll(), (rows: Record[]) => {
          for (const row of rows)
            if (row.scope === scope) {
              store.delete(row.key);
              budget.delete(row.key);
            }
          done(undefined);
        }),
      );
    },
    close() {
      closed = true;
      void opening?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
