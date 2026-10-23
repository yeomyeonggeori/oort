// =============================================================================
// 배경 사진이 사는 IndexedDB 한 칸 (ADR-0189 증보 3 D4, 결정 5, AP-4 #4191).
//
// DB `momo-appearance`, 스토어 `blobs`, 키 `wallpaper`: 사진은 **한 장**이다. 바꾸면 덮어쓰고, 「기본으로」나
// 다른 배경을 고르면 지우고, 로그아웃·세션 경계에서도 지운다(`signOut.ts`).
//
// ## 왜 localStorage가 아닌가
//
// 배포 CSP와 Tauri CSP가 `img-src 'self' data:`라 `blob:` URL을 못 쓰고(`avatarImageStore.ts`가 같은 이유로
// `data:`를 쓴다), 1.5MB 사진은 `data:` 문자열이 약 2MB라서 localStorage 5MB 한도에서 외양 레코드·테마 캐시와
// 합치면 빠듯하고 동기 읽기가 첫 페인트를 막는다. IndexedDB는 이진 그대로 두고 비동기다. 프로덕션 코드의
// IndexedDB 전례는 이 파일이 처음이다(Tauri 웹뷰의 영속성·쿼터는 AP-4가 실측한다, PR 본문).
//
// ## 이 파일은 잎(leaf)이다
//
// 앱 모듈을 하나도 import하지 않는다. `lib/session.ts`의 `clearSession`이 로그아웃 때 이 파일의 `clear`를
// 부르는데(`signOut.ts`), 세션 저장소가 테마·Tauri 모듈 사슬을 끌고 오면 그것을 부분 모의한 시험들이 로드
// 중에 터지기 때문이다. 바이트는 `ArrayBuffer`로 둔다: WebKit의 IndexedDB `Blob` 저장은 과거에 파일 참조
// 때문에 깨진 전례가 있어서 가장 이식성 있는 형태를 쓴다.
//
// 네트워크 호출은 0이다. 이 모듈에는 `fetch`·`XMLHttpRequest`·업로드 경로가 없고, 시험이 소스를 읽어 단정한다.
// =============================================================================

export const WALLPAPER_DB = "momo-appearance";
export const WALLPAPER_STORE = "blobs";
export const WALLPAPER_KEY = "wallpaper";
const DB_VERSION = 1;

export interface StoredPhoto {
  v: 1;
  /** 사진을 바꿀 때마다 올리는 번호(외양 레코드의 `rev`와 같다). */
  rev: number;
  type: "image/jpeg";
  bytes: ArrayBuffer;
  width: number;
  height: number;
  /** 설정 화면의 작은 미리보기(`data:` URL). 못 만들었으면 `null`. */
  thumb: string | null;
}

/** 저장소의 포트. 시험은 메모리 구현으로 바꿔 끼우고, 앱은 아래 IndexedDB 구현을 쓴다. */
export interface PhotoStore {
  /** 저장된 사진. 없거나 읽을 수 없으면 `null`(던지지 않는다). */
  read(): Promise<StoredPhoto | null>;
  /** 사진 한 장을 덮어쓴다. 저장되지 못하면 던진다(호출부가 「저장하지 못했어요」를 말한다). */
  write(photo: StoredPhoto): Promise<void>;
  /** 지운다. 어떤 실패도 던지지 않는다: 지우는 일이 흐름(로그아웃)을 막으면 안 된다. */
  clear(): Promise<void>;
}

function isStoredPhoto(value: unknown): value is StoredPhoto {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.rev === "number" &&
    record.type === "image/jpeg" &&
    record.bytes instanceof ArrayBuffer &&
    record.bytes.byteLength > 0 &&
    typeof record.width === "number" &&
    typeof record.height === "number" &&
    (record.thumb === null || typeof record.thumb === "string")
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb request"));
  });
}

/** 트랜잭션이 **끝난** 뒤에 풀린다(요청이 성공했다는 것과 디스크에 닿았다는 것은 다르다). */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb transaction"));
    tx.onabort = () => reject(tx.error ?? new Error("idb transaction aborted"));
  });
}

export function indexedDbPhotoStore(factory?: IDBFactory | null): PhotoStore {
  const idb = factory === undefined ? (typeof indexedDB === "undefined" ? null : indexedDB) : factory;
  let opened: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (idb === null) return Promise.reject(new Error("indexedDB unavailable"));
    if (opened === null) {
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
          request = idb.open(WALLPAPER_DB, DB_VERSION);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(WALLPAPER_STORE)) db.createObjectStore(WALLPAPER_STORE);
        };
        request.onsuccess = () => {
          const db = request.result;
          // 다른 탭이 버전을 올리거나 DB를 지우려 하면 연결을 놓아 준다(막지 않는다).
          db.onversionchange = () => {
            db.close();
            opened = null;
          };
          db.onclose = () => {
            opened = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error("idb open"));
        request.onblocked = () => reject(new Error("idb open blocked"));
      });
      // 실패한 열기를 기억하지 않는다: 다음 호출이 다시 시도한다.
      opened.catch(() => {
        opened = null;
      });
    }
    return opened;
  }

  return {
    async read() {
      try {
        const db = await open();
        const tx = db.transaction(WALLPAPER_STORE, "readonly");
        const value = await requestToPromise(tx.objectStore(WALLPAPER_STORE).get(WALLPAPER_KEY));
        return isStoredPhoto(value) ? value : null;
      } catch {
        return null;
      }
    },
    async write(photo) {
      const db = await open();
      const tx = db.transaction(WALLPAPER_STORE, "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(WALLPAPER_STORE).put(photo, WALLPAPER_KEY);
      await done;
    },
    async clear() {
      try {
        const db = await open();
        const tx = db.transaction(WALLPAPER_STORE, "readwrite");
        const done = transactionDone(tx);
        tx.objectStore(WALLPAPER_STORE).clear();
        await done;
      } catch {
        // 열 수 없는 저장소에는 지울 것도 없다. 로그아웃은 이 실패를 몰라도 된다.
      }
    },
  };
}

let shared: PhotoStore | null = null;

/** 앱이 쓰는 한 벌. 연결을 하나만 들고 있으려고 모듈 하나에 한 인스턴스다. */
export function defaultPhotoStore(): PhotoStore {
  if (shared === null) shared = indexedDbPhotoStore();
  return shared;
}
