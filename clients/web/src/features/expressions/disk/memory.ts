import {
  EXPRESSION_DISK_BUDGET_BYTES,
  EXPRESSION_DISK_LIFETIME_MS,
  expressionIdOfDiskKey,
  isExpressionDiskName,
  planTrim,
  shouldTouchLastRead,
  type DiskEntryMeta,
  type DiskImage,
  type ExpressionDiskBackend,
  type ExpressionDiskCompartment,
} from "./port";

// =============================================================================
// 메모리 가짜 저장소 (ADR-0218 §14 M5, #5455 B-1): 시험이 「앱을 다시 켠 뒤」를 흉내 내는 데 쓴다.
//
// 저장소 **인스턴스가 죽어도 이 백엔드는 남는다**(진짜 IndexedDB가 앱 재시작을 넘어 남는 것과 같다). 같은 백엔드를 새 `ExpressionStore`에 넘기면
// 그것이 곧 같은 디스크로 다시 켠 앱이다. 앱 코드는 이 파일을 가져가지 않는다(프로덕션 포트는 `idb.ts`).
// 규칙(수명·상한 청소, 마지막 읽은 시각 1분 단위)은 진짜 구현과 같은 순수 함수(`port.ts`)를 부르므로 두 구현이 어긋나지 않는다.
// =============================================================================

export interface MemoryDiskStats {
  /** 디스크에서 바이트를 꺼내 달라는 요청 수(`read`). 읽기 문의 시험이 세는 값이다. */
  reads: number;
  /** 바이트를 쓰려는 시도 수(`write`; 던진 것 포함). */
  writes: number;
  /** 디스크 색인을 읽은 횟수(`keys`). */
  keyScans: number;
  /** 지운 키 수(`remove`·`removeIds`·`trim`이 실제로 지운 것). */
  removed: number;
  /** 칸을 통째로 지운 횟수. */
  destroyed: number;
}

export interface MemoryDiskOptions {
  now?: () => number;
  budgetBytes?: number;
  lifetimeMs?: number;
}

interface Row {
  image: DiskImage;
  meta: DiskEntryMeta;
}

export interface MemoryDiskBackend extends ExpressionDiskBackend {
  readonly stats: MemoryDiskStats;
  /** 시험의 시계. 기본은 `Date.now`. */
  now: () => number;
  /** 다음 쓰기부터 이 오류를 던진다(`null`이면 정상). 용량 초과·디스크 가득 참을 흉내 낸다. */
  failWrites: Error | null;
  /** 이 칸에 지금 들어 있는 키(순서는 쓴 순서). 칸이 없으면 빈 목록. */
  keysOf(name: string): string[];
  /** 이 칸에 들어 있는 항목의 메타. */
  metaOf(name: string, key: string): DiskEntryMeta | undefined;
  /** 이 칸의 항목 바이트를 직접 바꾼다(저장소가 오염됐다고 치고 읽기가 알아채는지 본다). */
  corrupt(name: string, key: string, bytes: ArrayBuffer): void;
  /** 이 칸에 항목을 직접 넣는다(앱 밖에서 오래된 것이 남아 있다고 치고 시작 청소를 본다). */
  plant(name: string, key: string, image: DiskImage, meta?: Partial<DiskEntryMeta>): void;
  /** 모든 칸의 이름. */
  names(): string[];
}

export function createMemoryDiskBackend(options: MemoryDiskOptions = {}): MemoryDiskBackend {
  const compartments = new Map<string, Map<string, Row>>();
  const stats: MemoryDiskStats = { reads: 0, writes: 0, keyScans: 0, removed: 0, destroyed: 0 };
  const budget = options.budgetBytes ?? EXPRESSION_DISK_BUDGET_BYTES;
  const lifetime = options.lifetimeMs ?? EXPRESSION_DISK_LIFETIME_MS;

  const backend: MemoryDiskBackend = {
    stats,
    now: options.now ?? (() => Date.now()),
    failWrites: null,
    open(name) {
      if (!isExpressionDiskName(name)) return null;
      const rows = () => {
        let found = compartments.get(name);
        if (!found) {
          found = new Map();
          compartments.set(name, found);
        }
        return found;
      };
      const compartment: ExpressionDiskCompartment = {
        async read(key) {
          stats.reads += 1;
          const row = compartments.get(name)?.get(key);
          if (!row) return null;
          const now = backend.now();
          if (shouldTouchLastRead(row.meta, now)) row.meta.lastReadAt = now;
          return { bytes: row.image.bytes.slice(0), mime: row.image.mime };
        },
        async write(key, image) {
          stats.writes += 1;
          if (backend.failWrites) throw backend.failWrites;
          const now = backend.now();
          const map = rows();
          map.delete(key);
          map.set(key, { image: { bytes: image.bytes.slice(0), mime: image.mime }, meta: { size: image.bytes.byteLength, writtenAt: now, lastReadAt: now } });
        },
        async keys() {
          stats.keyScans += 1;
          return [...(compartments.get(name)?.keys() ?? [])];
        },
        async remove(keys) {
          const map = compartments.get(name);
          if (!map) return;
          for (const key of keys) if (map.delete(key)) stats.removed += 1;
        },
        async removeIds(ids) {
          const map = compartments.get(name);
          if (!map) return;
          const gone = new Set(ids);
          for (const key of [...map.keys()]) {
            const id = expressionIdOfDiskKey(key);
            if (id !== null && gone.has(id) && map.delete(key)) stats.removed += 1;
          }
        },
        async trim() {
          const map = compartments.get(name);
          if (!map) return;
          const metas = new Map([...map].map(([key, row]) => [key, row.meta] as const));
          for (const key of planTrim(metas, backend.now(), budget, lifetime)) if (map.delete(key)) stats.removed += 1;
        },
        async destroy() {
          if (compartments.delete(name)) stats.destroyed += 1;
        },
      };
      return compartment;
    },
    async list() {
      return [...compartments.keys()];
    },
    async destroy(name) {
      if (compartments.delete(name)) stats.destroyed += 1;
    },
    keysOf: (name) => [...(compartments.get(name)?.keys() ?? [])],
    metaOf: (name, key) => compartments.get(name)?.get(key)?.meta,
    corrupt(name, key, bytes) {
      const row = compartments.get(name)?.get(key);
      if (!row) throw new Error(`no such entry ${key}`);
      row.image = { bytes, mime: row.image.mime };
    },
    plant(name, key, image, meta = {}) {
      let map = compartments.get(name);
      if (!map) {
        map = new Map();
        compartments.set(name, map);
      }
      const now = backend.now();
      map.set(key, { image, meta: { size: image.bytes.byteLength, writtenAt: now, lastReadAt: now, ...meta } });
    },
    names: () => [...compartments.keys()],
  };
  return backend;
}
