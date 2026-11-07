import {
  EXPRESSION_DISK_PREFIX,
  isExpressionDiskName,
  planTrim,
  shouldTouchLastRead,
  type DiskEntryMeta,
  type DiskImage,
  type ExpressionDiskBackend,
  type ExpressionDiskCompartment,
} from "./port";

// =============================================================================
// 이모티콘 그림의 기기 캐시: IndexedDB 구현 (ADR-0218 §14 M5 「웹 구현에서 정해진 값」, #5455 B-1).
//
// 보관 칸 하나 = DB 하나(`oort-expr-img-v1.<워크스페이스>.<멤버>`). 지우기는 `deleteDatabase` 한 번이라 키 접두어를 훑다 놓치는 일이 없다.
// object store 둘: `meta`(키 → `{mime, size, writtenAt, lastReadAt}`)와 `blobs`(키 → `ArrayBuffer`). 둘로 나눈 까닭은 읽을 때마다 하는
// 「마지막 읽은 시각」 갱신이 바이트를 다시 쓰지 않게 하려는 것이고, 상한·수명 청소가 메타만 훑게 하려는 것이다.
// 바이트는 `ArrayBuffer`다: WebKit의 IndexedDB `Blob` 저장이 파일 참조 때문에 깨진 전례가 있어(`design/wallpaper/idb.ts`) 가장 이식성 있는 형태를 쓴다.
//
// 이 파일은 **잎(leaf)**이다: 앱 모듈을 import하지 않는다(`lib/session.ts`의 `clearSession`이 로그아웃 때 `signOut.ts`를 거쳐 여기까지 온다).
// 포트의 계약대로 **던지는 것은 `write` 하나**다. 읽기·청소·지우기는 어떤 실패도 「캐시 없음」으로 삼킨다.
// 이 IndexedDB가 실제 Tauri WKWebView(macOS)에서 앱 재시작을 넘어 남는지는 이 PR이 재지 못했다 `runtime-unverified`(ADR §14 M5).
// =============================================================================

const DB_VERSION = 1;
const META = "meta";
const BLOBS = "blobs";
/** `indexedDB.databases()`가 없는 엔진(Firefox 125 이하)을 위한 칸 이름 장부. 비밀이 아니다(이름에는 id 둘뿐). */
const REGISTRY_KEY = "oort.expressions.disk.names.v1";
/** 다른 탭이 칸을 열어 둬 `deleteDatabase`가 막혀도 흐름이 이만큼 이상 기다리지 않는다. */
const DESTROY_WAIT_MS = 3000;

interface StoredMeta {
  mime: string;
  size: number;
  writtenAt: number;
  lastReadAt: number;
}

function isStoredMeta(value: unknown): value is StoredMeta {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.mime === "string" &&
    typeof record.size === "number" &&
    typeof record.writtenAt === "number" &&
    typeof record.lastReadAt === "number"
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb request"));
  });
}

/** 트랜잭션이 **끝난** 뒤에 풀린다(요청 성공과 디스크에 닿은 것은 다르다). */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb transaction"));
    tx.onabort = () => reject(tx.error ?? new Error("idb transaction aborted"));
  });
}

function readRegistry(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string" && isExpressionDiskName(name)) : [];
  } catch {
    return [];
  }
}

function writeRegistry(names: readonly string[]): void {
  try {
    if (names.length === 0) localStorage.removeItem(REGISTRY_KEY);
    else localStorage.setItem(REGISTRY_KEY, JSON.stringify([...new Set(names)]));
  } catch {
    // 장부는 선택 사항이다(`databases()`가 있는 엔진은 그것으로 센다).
  }
}

function remember(name: string): void {
  const names = readRegistry();
  if (!names.includes(name)) writeRegistry([...names, name]);
}

function forget(name: string): void {
  writeRegistry(readRegistry().filter((known) => known !== name));
}

export function indexedDbExpressionDisk(factory?: IDBFactory | null, clock: () => number = () => Date.now()): ExpressionDiskBackend {
  const idb = factory === undefined ? (typeof indexedDB === "undefined" ? null : indexedDB) : factory;
  /** 이름 → 열린 연결의 약속. 닫히거나 지워지면 비운다. */
  const connections = new Map<string, Promise<IDBDatabase>>();

  function connect(name: string): Promise<IDBDatabase> {
    if (idb === null) return Promise.reject(new Error("indexedDB unavailable"));
    let opened = connections.get(name);
    if (opened === undefined) {
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
          req = idb.open(name, DB_VERSION);
        } catch (error) {
          reject(error);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        };
        req.onsuccess = () => {
          const db = req.result;
          // 다른 탭이 칸을 지우려 하면(`deleteDatabase`) 연결을 놓아 준다. 막지 않는다.
          db.onversionchange = () => {
            db.close();
            connections.delete(name);
          };
          db.onclose = () => {
            connections.delete(name);
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error("idb open"));
        req.onblocked = () => reject(new Error("idb open blocked"));
      });
      connections.set(name, opened);
      // 실패한 열기를 기억하지 않는다: 다음 호출이 다시 시도한다.
      opened.catch(() => {
        if (connections.get(name) === opened) connections.delete(name);
      });
    }
    return opened;
  }

  async function removeKeys(name: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const db = await connect(name);
    const tx = db.transaction([META, BLOBS], "readwrite");
    for (const key of keys) {
      tx.objectStore(META).delete(key);
      tx.objectStore(BLOBS).delete(key);
    }
    await done(tx);
  }

  function compartment(name: string): ExpressionDiskCompartment {
    return {
      async read(key) {
        try {
          const db = await connect(name);
          const tx = db.transaction([META, BLOBS], "readonly");
          const metaRequest = tx.objectStore(META).get(key) as IDBRequest<unknown>;
          const blobRequest = tx.objectStore(BLOBS).get(key) as IDBRequest<unknown>;
          await done(tx);
          const meta = metaRequest.result;
          const bytes = blobRequest.result;
          if (meta === undefined && bytes === undefined) return null;
          if (!isStoredMeta(meta) || !(bytes instanceof ArrayBuffer)) {
            // 반쪽짜리 항목(메타만 있거나 바이트만 있다)은 읽을 수 없다. 치워서 같은 키가 영원히 막히지 않게 한다.
            await removeKeys(name, [key]).catch(() => undefined);
            return null;
          }
          const now = clock();
          if (shouldTouchLastRead(meta, now)) {
            // 바이트는 건드리지 않고 메타만 다시 쓴다. 실패해도 읽기는 성공이다.
            void (async () => {
              const touch = db.transaction([META], "readwrite");
              touch.objectStore(META).put({ ...meta, lastReadAt: now }, key);
              await done(touch);
            })().catch(() => undefined);
          }
          return { bytes, mime: meta.mime };
        } catch {
          return null;
        }
      },
      async write(key, image: DiskImage) {
        const db = await connect(name);
        const now = clock();
        const tx = db.transaction([META, BLOBS], "readwrite");
        const meta: StoredMeta = { mime: image.mime, size: image.bytes.byteLength, writtenAt: now, lastReadAt: now };
        tx.objectStore(META).put(meta, key);
        tx.objectStore(BLOBS).put(image.bytes, key);
        await done(tx);
        remember(name);
      },
      async keys() {
        try {
          const db = await connect(name);
          const tx = db.transaction([META], "readonly");
          const all = request(tx.objectStore(META).getAllKeys());
          await done(tx);
          return (await all).filter((key): key is string => typeof key === "string");
        } catch {
          return null;
        }
      },
      async remove(keys) {
        try {
          await removeKeys(name, keys);
        } catch {
          // 지우기 실패는 「캐시 없음」이 아니라 「다음 청소가 다시 지운다」이다.
        }
      },
      async removeIds(ids) {
        if (ids.length === 0) return;
        try {
          const db = await connect(name);
          const tx = db.transaction([META, BLOBS], "readwrite");
          for (const id of ids) {
            // 키는 `<id>:<size>:<sha>`라서 `<id>:` 로 시작하는 구간이 그 표현의 모든 항목이다.
            const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
            tx.objectStore(META).delete(range);
            tx.objectStore(BLOBS).delete(range);
          }
          await done(tx);
        } catch {
          // 위와 같다.
        }
      },
      async trim() {
        try {
          const db = await connect(name);
          const tx = db.transaction([META], "readonly");
          const entries = new Map<string, DiskEntryMeta>();
          await new Promise<void>((resolve, reject) => {
            const cursor = tx.objectStore(META).openCursor();
            cursor.onerror = () => reject(cursor.error ?? new Error("idb cursor"));
            cursor.onsuccess = () => {
              const at = cursor.result;
              if (at === null) {
                resolve();
                return;
              }
              if (typeof at.key === "string" && isStoredMeta(at.value)) {
                entries.set(at.key, { size: at.value.size, writtenAt: at.value.writtenAt, lastReadAt: at.value.lastReadAt });
              }
              at.continue();
            };
          });
          await removeKeys(name, planTrim(entries, clock()));
        } catch {
          // 청소 실패는 다음 쓰기·시작이 다시 한다.
        }
      },
      async destroy() {
        await destroyDatabase(name);
      },
    };
  }

  async function destroyDatabase(name: string): Promise<void> {
    forget(name);
    const opened = connections.get(name);
    connections.delete(name);
    if (opened !== undefined) {
      try {
        (await opened).close();
      } catch {
        // 열리지 못한 연결은 닫을 것이 없다.
      }
    }
    if (idb === null) return;
    await new Promise<void>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = idb.deleteDatabase(name);
      } catch {
        resolve();
        return;
      }
      // 다른 탭이 열어 두어 막혀도(`onblocked`) 그 탭이 `onversionchange`에서 놓으면 곧 지워진다. 그때까지 흐름을 붙들지 않는다.
      const timer = setTimeout(resolve, DESTROY_WAIT_MS);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      req.onsuccess = finish;
      req.onerror = finish;
    });
  }

  return {
    open(name) {
      if (idb === null || !isExpressionDiskName(name)) return null;
      return compartment(name);
    },
    async list() {
      const names = new Set(readRegistry());
      const databases = (idb as (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }) | null)?.databases;
      if (idb !== null && typeof databases === "function") {
        try {
          for (const database of await databases.call(idb)) {
            if (typeof database.name === "string" && database.name.startsWith(EXPRESSION_DISK_PREFIX)) names.add(database.name);
          }
        } catch {
          // 장부만으로 센다.
        }
      }
      return [...names];
    },
    destroy: destroyDatabase,
  };
}

let shared: ExpressionDiskBackend | null = null;
/** 앱이 쓰는 백엔드(전역 `indexedDB`). 없는 환경(시험의 node·사생활 보호 모드)에서는 `open`이 `null`이다. */
export function defaultExpressionDiskBackend(): ExpressionDiskBackend {
  shared ??= indexedDbExpressionDisk();
  return shared;
}
