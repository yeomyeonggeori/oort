// 시험 도구: 폰 저장소 수준 시험이 쓰는 가짜 세계(서버 목록 + 그림 바이트 + 앱 재시작을 흉내 내는 보관 칸). 앱 코드는 이 파일을 가져가지 않는다.
// 그림 바이트는 **진짜 PNG·GIF 머리와 실제 sha256** 을 가진다(저장소가 쓸 때 길이·형식을 목록과 대조하고, 주소 모양 검사가 64자 hex 를 요구한다).
// 웹의 `disk/testkit/world.ts`·`disk/memory.ts` 와 같은 모양이다(ADR-0218 §14 M5: 저장소의 읽기 함수를 직접 부르고 포트의 디스크 읽기 횟수를 센다).
import {createHash} from 'node:crypto';
import {
  EXPRESSION_DISK_BUDGET_BYTES,
  EXPRESSION_DISK_LIFETIME_MS,
  expressionDiskName,
  expressionIdOfDiskKey,
  isExpressionDiskName,
  planTrim,
  shouldTouchLastRead,
  type DiskEntryMeta,
  type DiskImage,
} from '@momo/core/features/expressions/diskCache';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {
  Expression,
  ExpressionImage,
  ExpressionList,
  ExpressionMedia,
} from '@momo/core/features/expressions/types';
import type {ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {openPhoneExpressionDisk} from '../../src/features/expressions/disk/open';
import type {
  LocatedImage,
  PhoneDiskBackend,
  PhoneDiskCompartment,
} from '../../src/features/expressions/disk/port';
import {
  createPhoneExpressionStore,
  type ExpressionShelfStorage,
  type PhoneExpressionStore,
} from '../../src/features/expressions/store';

export const WS = FIXTURE_WORKSPACE_ID;
export const ME = FIXTURE_MEMBER_ID;
export const OTHER_ME = '00000000-0000-4000-8000-0000000000aa';
export const OTHER_WS = '00000000-0000-4000-8000-0000000000bb';
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
export const diskName = (workspace = WS, member = ME) =>
  expressionDiskName(workspace, member)!;

export interface Pic {
  bytes: Uint8Array;
  sha: string;
  mime: 'image/png' | 'image/gif';
}
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_HEAD = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
export function pic(
  seed: string,
  length = 80,
  mime: Pic['mime'] = 'image/png',
): Pic {
  const head = mime === 'image/png' ? PNG_HEAD : GIF_HEAD;
  // 시드에서 정해지는 바이트(블록마다 sha256): 같은 시드는 늘 같은 그림이고, 시드가 다르면 해시가 다르다.
  const bytes = new Uint8Array(length);
  for (let block = 0; block * 32 < length; block += 1) {
    const digest = createHash('sha256').update(`${seed}:${block}`).digest();
    bytes.set(digest.subarray(0, Math.min(32, length - block * 32)), block * 32);
  }
  bytes.set(head.slice(0, Math.min(head.length, length)));
  return {
    bytes,
    sha: createHash('sha256').update(bytes).digest('hex'),
    mime,
  };
}
const imageMetaOf = (p: Pic): ExpressionImage => ({
  mime: p.mime,
  sha256: p.sha,
  bytes: p.bytes.length,
  width: 64,
  height: 64,
  frameCount: p.mime === 'image/gif' ? 2 : 1,
  durationMs: p.mime === 'image/gif' ? 200 : 0,
});

export type Size = 'small' | 'large' | 'thumb';
export const SIZES: Size[] = ['small', 'large', 'thumb'];

interface Reply {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
}

/** 서버가 가진 목록과 그림. `request` 가 폰 `ExpressionTransport` 이고, 부르는 횟수를 센다. */
export class World {
  version = 0;
  active = new Map<string, Expression>();
  hidden = new Map<string, Expression>();
  pics = new Map<string, Pic>();
  /** 그림 요청(경로) 기록. 시험이 비우며 센다. */
  imageCalls: string[] = [];
  /** 목록 읽기의 쿼리(`''` 은 `since` 없는 전체 읽기, `?since=6` 은 증분). */
  listCalls: string[] = [];
  /** 이 상태로 목록 읽기가 답한다(`null` 이면 정상). */
  failList: number | null = null;
  /** 이 상태로 그림 요청이 답한다(`null` 이면 정상, 숨김·없는 id 는 따로 404). */
  failImage: number | null = null;
  /** 초안 경로(`expression-drafts/…`)의 200 이 싣는 바이트. 안 정하면 서로 다른 PNG 하나. */
  draftBytes: ((path: string) => Uint8Array) | null = null;
  /** 초안 경로가 이 상태로 답한다(`null` 이면 200). */
  failDraft: number | null = null;
  /** 목록 읽기를 붙드는 줄: 붙든 읽기마다 풀어 주는 함수가 하나씩 쌓인다(`null` 이면 붙들지 않는다). */
  private listQueue: Array<() => void> | null = null;
  private imageGate: Promise<void> | null = null;
  private reportGate: Promise<void> | null = null;

  add(n: number, mime: Pic['mime'] = 'image/png', length = 80): Expression {
    this.version += 1;
    const media = Object.fromEntries(
      SIZES.map(size => {
        // 계약: 움직이는 항목도 `thumb` 은 정지 PNG 다(ADR-0218 D1).
        const p = pic(
          `${n}:${size}:${this.version}`,
          length + (size === 'large' ? 20 : 0),
          size === 'thumb' ? 'image/png' : mime,
        );
        this.pics.set(`${uuid(n)}:${size}`, p);
        return [size, imageMetaOf(p)];
      }),
    ) as unknown as ExpressionMedia;
    const item: Expression = {
      ...FIXTURE_EXPRESSIONS[0],
      id: uuid(n),
      workspaceId: WS,
      name: `expr_${n}`,
      displayName: `표현 ${n}`,
      kind: 'sticker',
      version: String(this.version),
      status: 'active',
      media,
    };
    this.active.set(item.id, item);
    this.hidden.delete(item.id);
    return item;
  }
  hide(n: number): void {
    const item = this.active.get(uuid(n));
    if (!item) throw new Error(`no active ${n}`);
    this.version += 1;
    this.active.delete(item.id);
    this.hidden.set(item.id, {
      ...item,
      version: String(this.version),
      status: 'hidden',
      media: null,
    });
  }
  /** 이 표현의 목록 항목(active 만). */
  item(n: number): Expression {
    const found = this.active.get(uuid(n));
    if (!found) throw new Error(`no active ${n}`);
    return found;
  }
  shaOf(n: number, size: Size): string {
    return this.pics.get(`${uuid(n)}:${size}`)!.sha;
  }
  bytesOf(n: number, size: Size): Uint8Array {
    return this.pics.get(`${uuid(n)}:${size}`)!.bytes;
  }
  /** 이 표현의 그림 주소(활성 경로). */
  pathOf(n: number, size: Size): string {
    return `/v1/workspaces/${WS}/expressions/${uuid(n)}/image?size=${size}&v=${this.shaOf(n, size)}`;
  }
  /**
   * 다음 목록 읽기부터 풀어 줄 때까지 붙든다. `next()` 는 가장 먼저 붙든 읽기 하나만, `all()` 은 붙든 읽기 전부를 풀고 더는 붙들지 않는다.
   * 붙든 읽기가 답할 목록은 **풀어 주는 순간**의 서버 상태로 만든다(그 사이 일어난 변경이 실린다).
   */
  holdLists(): {next(): void; all(): void; waiting(): number} {
    const queue: Array<() => void> = [];
    this.listQueue = queue;
    return {
      next: () => {
        queue.shift()?.();
      },
      all: () => {
        if (this.listQueue === queue) this.listQueue = null;
        for (const release of queue.splice(0)) release();
      },
      waiting: () => queue.length,
    };
  }
  /** 신고(`…/report`)는 서버에서 바로 처리되지만 **응답**은 풀어 줄 때까지 붙든다(내 응답이 알림보다 늦게 도착하는 장면). */
  holdReports(): () => void {
    let release!: () => void;
    this.reportGate = new Promise<void>(resolve => {
      release = () => {
        this.reportGate = null;
        resolve();
      };
    });
    return release;
  }
  holdImages(): () => void {
    let release!: () => void;
    this.imageGate = new Promise<void>(resolve => {
      release = () => {
        this.imageGate = null;
        resolve();
      };
    });
    return release;
  }

  full(): ExpressionList {
    return {
      workspaceId: WS,
      version: String(this.version),
      baseVersion: null,
      reset: true,
      addPolicy: 'members',
      items: [...this.active.values()],
    };
  }
  delta(since: string): ExpressionList {
    const changed = [...this.active.values(), ...this.hidden.values()].filter(
      item => Number(item.version) > Number(since),
    );
    return {
      workspaceId: WS,
      version: String(this.version),
      baseVersion: since,
      reset: false,
      addPolicy: 'members',
      items: changed,
    };
  }

  request = jest.fn(async (input: ExpressionFixtureRequest): Promise<Reply> => {
    const [pathname, query = ''] = input.path.split('?');
    if (input.method === 'GET' && /\/expressions$/.test(pathname)) {
      const queue = this.listQueue;
      this.listCalls.push(query === '' ? '' : `?${query}`);
      if (queue) await new Promise<void>(resolve => queue.push(resolve));
      if (this.failList !== null) return {status: this.failList};
      const since = new URLSearchParams(query).get('since');
      return {
        status: 200,
        json: JSON.parse(
          JSON.stringify(since === null ? this.full() : this.delta(since)),
        ),
      };
    }
    const report = /\/expressions\/([0-9a-f-]{36})\/report$/.exec(pathname);
    if (input.method === 'POST' && report) {
      const item = this.active.get(report[1]);
      if (!item) return {status: 404};
      this.version += 1;
      this.active.delete(item.id);
      const row: Expression = {
        ...item,
        version: String(this.version),
        status: 'hidden',
        media: null,
      };
      this.hidden.set(item.id, row);
      const gate = this.reportGate;
      if (gate) await gate;
      return {
        status: 200,
        json: JSON.parse(
          JSON.stringify({workspaceId: WS, version: String(this.version), expression: row}),
        ),
      };
    }
    if (pathname.includes('/expression-drafts/')) {
      this.imageCalls.push(input.path);
      if (this.failDraft !== null) return {status: this.failDraft};
      return {
        status: 200,
        bytes: this.draftBytes ? this.draftBytes(input.path) : pic(`draft:${input.path}`).bytes,
      };
    }
    const image = /\/expressions\/([0-9a-f-]{36})\/image$/.exec(pathname);
    if (input.method === 'GET' && image) {
      const gate = this.imageGate;
      this.imageCalls.push(input.path);
      if (gate) await gate;
      if (this.failImage !== null) return {status: this.failImage};
      const params = new URLSearchParams(query);
      const found = this.pics.get(`${image[1]}:${params.get('size')}`);
      // 서버의 설계된 응답: 숨김·없는 id·틀린 sha 는 모두 같은 404 다.
      if (!found || !this.active.has(image[1]) || found.sha !== params.get('v')) {
        return {status: 404};
      }
      return {status: 200, bytes: found.bytes};
    }
    throw new Error(`unexpected request ${input.method} ${input.path}`);
  });
  transport() {
    return {request: this.request};
  }
  resetCounts(): void {
    this.imageCalls.length = 0;
    this.listCalls.length = 0;
  }
}

// ------------------------------------------------------------------------------------------------ 보관 칸 가짜 (포트의 메모리 구현)
export interface MemoryDiskStats {
  /** 디스크에서 그림을 찾거나(`locate`) 바이트를 꺼내 달라는 요청 수(`read`). 읽기 문의 시험이 세는 값이다. */
  reads: number;
  /** 바이트를 쓰려는 시도 수(`write`; 던진 것 포함). */
  writes: number;
  /** 디스크 색인을 읽은 횟수(`keys`). */
  keyScans: number;
  /** 지운 키 수(`remove`·`removeIds`·`trim` 이 실제로 지운 것). */
  removed: number;
  /** 칸을 통째로 지운 횟수. */
  destroyed: number;
}
interface Row {
  image: DiskImage;
  meta: DiskEntryMeta;
}
export interface MemoryDiskBackend extends PhoneDiskBackend {
  readonly stats: MemoryDiskStats;
  now: () => number;
  /** 다음 쓰기부터 이 오류를 던진다(`null` 이면 정상). 디스크 가득 참을 흉내 낸다. */
  failWrites: Error | null;
  /** 색인 읽기(`keys`)를 풀어 줄 때까지 붙든다(대조 청소를 멈춘 채 읽기 문만 재려는 시험). 풀어 주는 함수를 돌려준다. */
  holdKeys(): () => void;
  /** 쓰기가 시작하기 **직전**에 불린다(로그아웃·`dispose` 가 쓰기 사이에 끼는 장면을 만든다). */
  beforeWrite: (() => void | Promise<void>) | null;
  keysOf(name: string): string[];
  metaOf(name: string, key: string): DiskEntryMeta | undefined;
  /** 항목 바이트를 직접 바꾼다(저장소가 오염됐다고 치고 읽기가 알아채는지 본다). */
  corrupt(name: string, key: string, bytes: ArrayBuffer): void;
  /** 항목을 직접 넣는다(앱 밖에서 오래된 것이 남아 있다고 치고 시작 청소를 본다). */
  plant(name: string, key: string, image: DiskImage, meta?: Partial<DiskEntryMeta>): void;
  names(): string[];
}
export function createMemoryDiskBackend(
  options: {now?: () => number; budgetBytes?: number; lifetimeMs?: number} = {},
): MemoryDiskBackend {
  const compartments = new Map<string, Map<string, Row>>();
  const stats: MemoryDiskStats = {reads: 0, writes: 0, keyScans: 0, removed: 0, destroyed: 0};
  const budget = options.budgetBytes ?? EXPRESSION_DISK_BUDGET_BYTES;
  const lifetime = options.lifetimeMs ?? EXPRESSION_DISK_LIFETIME_MS;
  const extension = (mime: string) => (mime === 'image/gif' ? '.gif' : '.png');
  let keysGate: Promise<void> | null = null;

  const backend: MemoryDiskBackend = {
    stats,
    now: options.now ?? (() => Date.now()),
    failWrites: null,
    beforeWrite: null,
    holdKeys() {
      let release!: () => void;
      keysGate = new Promise<void>(resolve => {
        release = () => {
          keysGate = null;
          resolve();
        };
      });
      return release;
    },
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
      const compartment: PhoneDiskCompartment = {
        uriOf: (key, mime) => `file:///fake/${name}/${key.replace(/:/g, '_')}${extension(mime)}`,
        async locate(key, mime): Promise<LocatedImage | null> {
          stats.reads += 1;
          const row = compartments.get(name)?.get(key);
          if (!row || row.image.mime !== mime) return null;
          const now = backend.now();
          if (shouldTouchLastRead(row.meta, now)) row.meta.lastReadAt = now;
          return {uri: compartment.uriOf(key, mime), bytes: row.image.bytes.byteLength};
        },
        async read(key) {
          stats.reads += 1;
          const row = compartments.get(name)?.get(key);
          if (!row) return null;
          const now = backend.now();
          if (shouldTouchLastRead(row.meta, now)) row.meta.lastReadAt = now;
          return {bytes: row.image.bytes.slice(0), mime: row.image.mime};
        },
        async write(key, image) {
          await backend.beforeWrite?.();
          stats.writes += 1;
          if (backend.failWrites) throw backend.failWrites;
          const now = backend.now();
          const map = rows();
          map.delete(key);
          map.set(key, {
            image: {bytes: image.bytes.slice(0), mime: image.mime},
            meta: {size: image.bytes.byteLength, writtenAt: now, lastReadAt: now},
          });
        },
        async keys() {
          stats.keyScans += 1;
          if (keysGate) await keysGate;
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
        async trim(pinned) {
          const map = compartments.get(name);
          if (!map) return;
          const metas = new Map([...map].map(([key, row]) => [key, row.meta] as const));
          for (const key of planTrim(metas, backend.now(), budget, lifetime)) {
            if (pinned?.has(key)) continue;
            if (map.delete(key)) stats.removed += 1;
          }
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
    keysOf: name => [...(compartments.get(name)?.keys() ?? [])],
    metaOf: (name, key) => compartments.get(name)?.get(key)?.meta,
    corrupt(name, key, bytes) {
      const row = compartments.get(name)?.get(key);
      if (!row) throw new Error(`no such entry ${key}`);
      row.image = {bytes, mime: row.image.mime};
    },
    plant(name, key, image, meta = {}) {
      let map = compartments.get(name);
      if (!map) {
        map = new Map();
        compartments.set(name, map);
      }
      const now = backend.now();
      map.set(key, {
        image,
        meta: {size: image.bytes.byteLength, writtenAt: now, lastReadAt: now, ...meta},
      });
    },
    names: () => [...compartments.keys()],
  };
  return backend;
}

// ------------------------------------------------------------------------------------------------ 저장소 만들기
export interface TestFiles {
  write: jest.Mock<string, [string, Uint8Array]>;
  remove: jest.Mock<void, [string]>;
  /** 지금 살아 있는 세션 임시 파일(주소 → 바이트). */
  live: Map<string, Uint8Array>;
}
export function makeFiles(): TestFiles {
  const live = new Map<string, Uint8Array>();
  return {
    live,
    write: jest.fn((name: string, bytes: Uint8Array) => {
      const uri = `file:///session/${name}`;
      live.set(uri, bytes);
      return uri;
    }),
    remove: jest.fn((uri: string) => {
      live.delete(uri);
    }),
  };
}

export interface BootOptions {
  member?: string;
  workspace?: string;
  files?: TestFiles;
  shelf?: ExpressionShelfStorage;
  /** `false` 면 보관 칸 없이(예전 모양) 만든다. */
  disk?: boolean;
}
export interface Booted {
  store: PhoneExpressionStore;
  files: TestFiles;
}
/** 저장소를 만든다. `backend` 를 같은 것으로 주면 그것이 「같은 디스크로 다시 켠 앱」이다. */
export function boot(world: World, backend: MemoryDiskBackend, options: BootOptions = {}): Booted {
  const workspace = options.workspace ?? WS;
  const member = options.member ?? ME;
  const files = options.files ?? makeFiles();
  const disk = options.disk === false ? null : openPhoneExpressionDisk(workspace, member, backend);
  if (options.disk !== false && disk === null) {
    throw new Error('the disk compartment should open in tests');
  }
  const store = createPhoneExpressionStore(
    workspace,
    member,
    world.transport(),
    files,
    undefined,
    options.shelf,
    disk,
  );
  store.start();
  return {store, files};
}
