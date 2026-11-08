import {Directory, File, Paths} from 'expo-file-system';
import {
  EXPRESSION_DISK_BUDGET_BYTES,
  EXPRESSION_DISK_LIFETIME_MS,
  EXPRESSION_DISK_PREFIX,
  expressionIdOfDiskKey,
  isExpressionDiskName,
  planTrim,
  shouldTouchLastRead,
  type DiskEntryMeta,
  type DiskImage,
} from '@momo/core/features/expressions/diskCache';
import type {
  LocatedImage,
  PhoneDiskBackend,
  PhoneDiskCompartment,
} from './port';
import {toArrayBuffer} from './port';

// =============================================================================
// 폰의 보관 칸: `Paths.cache/<칸 이름>` 폴더 하나 = `(워크스페이스, 멤버)` 하나 (ADR-0218 §14 M2.7 「폰 저장 위치」, #5455 B-2).
//
// `Paths.cache` 아래에만 쓴다(iOS `Library/Caches`: 백업에서 빠지고 OS 가 비울 수 있다 — 비우면 캐시 없음으로 처리한다). MMKV 같은 백업되는 저장소에는 그림 바이트를
// 두지 않는다(MA13). 폴더 하나이므로 지우기는 「폴더째 삭제」 한 번이고 항목을 훑다 놓치는 일이 없다.
//
// 파일 이름 = `<id>_<size>_<sha256>.<png|gif>`. 코어 디스크 키 `<id>:<size>:<sha>` 의 `:` 를 `_` 로 바꾼 것이다(파일 이름에 `:` 를 두지 않는다. id 는 uuid, size 는 세 이름, sha 는 hex 라
// `_` 와 겹치지 않아 키로 되돌릴 수 있고 `expressionIdOfDiskKey` 의 뜻도 그대로다). **이름은 엄격한 모양(uuid·세 크기·hex 64)일 때만 만든다** — 목록이 이상한 값을 줘도 경로를 벗어나지 못한다.
// 쓰기는 임시 파일(`.t…`)에 쓰고 이름을 바꾼다(원자적): 죽어서 남은 임시 파일은 키로 보이지 않고 다음 청소가 지운다. 읽을 때 sha 는 다시 재지 않는다(M2.6) — 길이는 부르는 쪽이 본다.
//
// 「마지막 읽은 시각」은 폴더 안 `ledger.json`(이름 → [쓴 시각, 마지막 읽은 시각])에 둔다: 칸을 지우면 함께 사라진다. 읽을 때의 갱신은 1분 단위이고 한 틱의 갱신은 한 번에 모아 쓴다.
// 장부가 없거나 깨졌으면 파일의 수정 시각을 쓴 시각으로 본다(캐시 순서가 조금 달라질 뿐 정확성·보안에는 영향이 없다).
// =============================================================================

const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** 보관 칸 폴더 이름의 끝(접두어 뒤): `<워크스페이스 uuid>.<멤버 uuid>`. 이 모양이 아니면 열지도 지우지도 않는다. */
const COMPARTMENT_TAIL = new RegExp(`^${UUID_PART}\\.${UUID_PART}$`);
/** 항목 파일 이름: `<id>_<size>_<sha>.<png|gif>`. 세 크기 이름은 코어 `EXPRESSION_VARIANTS` 와 같다(시험이 맞춰 본다). */
const ENTRY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(small|large|thumb)_([0-9a-f]{64})\.(png|gif)$/;
/** 앱이 죽어 남은 옛 임시 자리: 옛 판의 세션 폴더와 받기 임시 파일(M2.5 시작 청소의 「고아」). 보관 칸(`oort-expr-img-v1.`)은 이 모양이 아니다. */
const ORPHAN = /^oort-expression(?:s-|-transfer-)/;
const TEMP_PREFIX = '.t';
const LEDGER_FILE = 'ledger.json';
const MIME_GIF = 'image/gif';
const MIMES = ['image/png', 'image/gif'] as const;

const extensionOf = (mime: string) => (mime === MIME_GIF ? '.gif' : '.png');

/** 디스크 키와 형식으로 파일 이름을 만든다(엄격한 모양이 아니면 `null`). */
export function diskFileName(key: string, mime: string): string | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const name = `${parts[0]}_${parts[1]}_${parts[2]}${extensionOf(mime)}`;
  return ENTRY.test(name) ? name : null;
}

/** 파일 이름에서 디스크 키(항목 파일이 아니면 `null`). */
export function diskKeyOfFileName(name: string): string | null {
  const match = ENTRY.exec(name);
  return match === null ? null : `${match[1]}:${match[2]}:${match[3]}`;
}

/** 보관 칸 폴더의 이름인가(접두어 + uuid 둘). */
export function isCompartmentName(name: string): boolean {
  return isExpressionDiskName(name) && COMPARTMENT_TAIL.test(name.slice(EXPRESSION_DISK_PREFIX.length));
}

/** 옛 판이 남긴 세션 폴더·받기 임시 파일의 이름인가. */
export function isOrphanName(name: string): boolean {
  return ORPHAN.test(name);
}

/** 폴더 목록의 한 항목의 이름(`name` 이 있으면 그것, 없으면 주소의 마지막 조각). */
function nameOf(item: Directory | File): string {
  const named = (item as {name?: unknown}).name;
  if (named === String(named) && named !== '') return String(named);
  const uri = item.uri.endsWith('/') ? item.uri.slice(0, -1) : item.uri;
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** `Paths.cache` 직속 항목들(읽을 수 없으면 빈 목록). */
function cacheItems(): Array<Directory | File> {
  try {
    return Paths.cache.list();
  } catch {
    return [];
  }
}

/** 지금 있는 모든 보관 칸 폴더의 이름(동기). 서명·정리가 쓴다. */
export function compartmentNamesSync(): string[] {
  return cacheItems()
    .map(nameOf)
    .filter(isCompartmentName);
}

/** 이 이름의 보관 칸을 폴더째 지운다(동기, 던지지 않는다). */
export function destroyCompartmentSync(name: string): void {
  if (!isCompartmentName(name)) return;
  try {
    const folder = new Directory(Paths.cache, name);
    if (folder.exists) folder.delete();
  } catch {
    // 못 지운 칸은 다음 시작 청소가 다시 지운다.
  }
}

/** 옛 판이 남긴 세션 폴더·받기 임시 파일을 모두 지운다(동기, 던지지 않는다). 지운 개수를 돌려준다. */
export function removeOrphansSync(): number {
  let removed = 0;
  for (const item of cacheItems()) {
    if (!isOrphanName(nameOf(item))) continue;
    try {
      item.delete();
      removed += 1;
    } catch {
      // 못 지운 것은 다음 시작이 다시 지운다.
    }
  }
  return removed;
}

export interface FileDiskOptions {
  now?: () => number;
  budgetBytes?: number;
  lifetimeMs?: number;
}

interface LedgerRow {
  /** 쓴 시각(ms). */
  w: number;
  /** 마지막으로 읽은 시각(ms). */
  r: number;
}

export function createFileDiskBackend(options: FileDiskOptions = {}): PhoneDiskBackend {
  const nowOf = options.now ?? (() => Date.now());
  const budget = options.budgetBytes ?? EXPRESSION_DISK_BUDGET_BYTES;
  const lifetime = options.lifetimeMs ?? EXPRESSION_DISK_LIFETIME_MS;
  return {
    open(name: string): PhoneDiskCompartment | null {
      if (!isCompartmentName(name)) return null;
      return createCompartment(name, nowOf, budget, lifetime);
    },
    async list() {
      return compartmentNamesSync();
    },
    async destroy(name: string) {
      destroyCompartmentSync(name);
    },
  };
}

function createCompartment(name: string, nowOf: () => number, budget: number, lifetime: number): PhoneDiskCompartment {
  const folder = () => new Directory(Paths.cache, name);
  const ledger = new Map<string, LedgerRow>();
  let loaded = false;
  let dirty = false;
  let scheduled = false;

  const loadLedger = () => {
    if (loaded) return;
    loaded = true;
    try {
      const file = new File(folder(), LEDGER_FILE);
      if (!file.exists) return;
      const parsed: unknown = JSON.parse(file.textSync());
      if (!(parsed instanceof Object)) return;
      for (const [entry, row] of Object.entries(parsed as Record<string, unknown>)) {
        if (!ENTRY.test(entry) || !Array.isArray(row)) continue;
        const [written, read] = row as unknown[];
        if (Number.isFinite(written) && Number.isFinite(read)) {
          ledger.set(entry, {w: written as number, r: read as number});
        }
      }
    } catch {
      // 장부가 깨졌으면 비어 있는 것으로 시작한다: 수정 시각이 쓴 시각을 대신한다.
    }
  };
  /** 장부를 폴더에 쓴다. **폴더가 없으면 만들지 않는다**(지워진 칸을 장부가 되살리지 않는다). */
  const flush = () => {
    scheduled = false;
    if (!dirty) return;
    dirty = false;
    try {
      const dir = folder();
      if (!dir.exists) return;
      const body = JSON.stringify(Object.fromEntries([...ledger].map(([entry, row]) => [entry, [row.w, row.r]])));
      new File(dir, LEDGER_FILE).write(body);
    } catch {
      // 읽은 시각을 못 남겨도 그림은 그대로다.
    }
  };
  /** 한 틱의 읽기가 남긴 갱신을 한 번에 쓴다(마이크로태스크). */
  const scheduleFlush = () => {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(flush);
  };
  const rowOf = (entry: string, file: File, now: number): LedgerRow => {
    let row = ledger.get(entry);
    if (row === undefined) {
      // 장부에 없는 파일(장부를 잃었다): 수정 시각을 쓴 시각으로 본다. 그것도 모르면 지금부터 센다.
      const modified = file.lastModified;
      const written = modified !== null && Number.isFinite(modified) ? modified : now;
      row = {w: written, r: written};
      ledger.set(entry, row);
      dirty = true;
    }
    return row;
  };
  const entryFiles = (): Array<{entry: string; key: string; file: File}> => {
    const dir = folder();
    if (!dir.exists) return [];
    const found: Array<{entry: string; key: string; file: File}> = [];
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue;
      const entry = nameOf(item);
      const key = diskKeyOfFileName(entry);
      if (key !== null) found.push({entry, key, file: item});
    }
    return found;
  };
  const deleteEntry = (entry: string, file: File) => {
    try {
      if (file.exists) file.delete();
    } catch {
      // 못 지운 파일은 다음 청소가 다시 센다.
    }
    if (ledger.delete(entry)) dirty = true;
  };

  return {
    uriOf(key, mime) {
      const entry = diskFileName(key, mime);
      if (entry === null) throw new Error('Invalid expression disk key');
      return new File(folder(), entry).uri;
    },
    async locate(key, mime): Promise<LocatedImage | null> {
      const entry = diskFileName(key, mime);
      if (entry === null) return null;
      try {
        const file = new File(folder(), entry);
        if (!file.exists) return null;
        const size = file.size;
        loadLedger();
        const now = nowOf();
        const row = rowOf(entry, file, now);
        if (shouldTouchLastRead({size, writtenAt: row.w, lastReadAt: row.r}, now)) {
          row.r = now;
          scheduleFlush();
        }
        return {uri: file.uri, bytes: size};
      } catch {
        return null;
      }
    },
    async read(key): Promise<DiskImage | null> {
      try {
        for (const mime of MIMES) {
          const entry = diskFileName(key, mime);
          if (entry === null) return null;
          const file = new File(folder(), entry);
          if (!file.exists) continue;
          const bytes = await file.bytes();
          loadLedger();
          const now = nowOf();
          const row = rowOf(entry, file, now);
          if (shouldTouchLastRead({size: bytes.byteLength, writtenAt: row.w, lastReadAt: row.r}, now)) {
            row.r = now;
            scheduleFlush();
          }
          return {bytes: toArrayBuffer(bytes), mime};
        }
      } catch {
        // 못 읽으면 캐시 없음이다.
      }
      return null;
    },
    async write(key, image) {
      const entry = diskFileName(key, image.mime);
      if (entry === null) throw new Error('Invalid expression disk key');
      const dir = folder();
      if (!dir.exists) dir.create({intermediates: true, idempotent: true});
      // 임시 파일에 쓰고 이름을 바꾼다(원자적): 쓰다 죽어도 `<id>_…` 이름의 반쪽 파일은 생기지 않는다.
      const temp = new File(dir, `${TEMP_PREFIX}${nowOf().toString(36)}-${Math.random().toString(36).slice(2)}`);
      try {
        temp.write(new Uint8Array(image.bytes));
        if (temp.size !== image.bytes.byteLength) throw new Error('Expression disk write was short');
        temp.moveSync(new File(dir, entry), {overwrite: true});
      } catch (error) {
        try {
          if (temp.exists) temp.delete();
        } catch {
          // 남은 임시 파일은 다음 청소가 지운다.
        }
        throw error;
      }
      loadLedger();
      const now = nowOf();
      ledger.set(entry, {w: now, r: now});
      dirty = true;
      flush();
    },
    async keys() {
      try {
        loadLedger();
        return entryFiles().map(found => found.key);
      } catch {
        return null;
      }
    },
    async remove(keys) {
      try {
        loadLedger();
        const gone = new Set(keys);
        for (const {entry, key, file} of entryFiles()) if (gone.has(key)) deleteEntry(entry, file);
        flush();
      } catch {
        // 못 지운 것은 다음 대조 청소가 다시 지운다.
      }
    },
    async removeIds(ids) {
      try {
        loadLedger();
        const gone = new Set(ids);
        for (const {entry, key, file} of entryFiles()) {
          const id = expressionIdOfDiskKey(key);
          if (id !== null && gone.has(id)) deleteEntry(entry, file);
        }
        flush();
      } catch {
        // 위와 같다.
      }
    },
    async trim(pinned) {
      try {
        const dir = folder();
        if (!dir.exists) return;
        loadLedger();
        const now = nowOf();
        // 쓰다 죽어 남은 임시 파일은 지운다. 장부와 모르는 파일은 건드리지 않는다.
        for (const item of dir.list()) {
          const entry = nameOf(item);
          if (item instanceof File && entry.startsWith(TEMP_PREFIX)) {
            try {
              item.delete();
            } catch {
              // 다음 청소가 다시 지운다.
            }
          }
        }
        const metas = new Map<string, DiskEntryMeta>();
        const found = new Map<string, {entry: string; file: File}>();
        for (const {entry, key, file} of entryFiles()) {
          const row = rowOf(entry, file, now);
          metas.set(key, {size: file.size, writtenAt: row.w, lastReadAt: Math.max(row.r, row.w)});
          found.set(key, {entry, file});
        }
        for (const key of planTrim(metas, now, budget, lifetime)) {
          if (pinned?.has(key)) continue;
          const target = found.get(key);
          if (target) deleteEntry(target.entry, target.file);
        }
        // 파일이 없어진 줄은 장부에서도 뺀다.
        const present = new Set([...found.values()].map(value => value.entry));
        for (const entry of [...ledger.keys()]) {
          if (!present.has(entry) && ledger.delete(entry)) dirty = true;
        }
        flush();
      } catch {
        // 청소가 못 돌면 다음 시작이 다시 한다.
      }
    },
    async destroy() {
      try {
        const dir = folder();
        if (dir.exists) dir.delete();
      } catch {
        // 못 지운 칸은 다음 시작 청소가 지운다.
      }
      ledger.clear();
      loaded = false;
      dirty = false;
    },
  };
}

let shared: PhoneDiskBackend | null = null;

/** 앱이 쓰는 보관 칸 저장소(`Paths.cache`). */
export function defaultPhoneDiskBackend(): PhoneDiskBackend {
  shared ??= createFileDiskBackend();
  return shared;
}
