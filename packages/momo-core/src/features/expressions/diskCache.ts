// =============================================================================
// 이모티콘 그림의 기기 캐시: 플랫폼에 기대지 않는 규칙과 포트 (ADR-0218 §14·증보 8, #5455 B-1).
//
// 칸 이름·키 모양·그림 주소 읽기·청소 계획·상한·수명·목록 대조는 웹(IndexedDB)과 폰(`Paths.cache` 폴더, B-2)이 **같은 규칙**을 쓰도록 코어에 둔다.
// 바이트를 어디에 두는지(저장소 구현)는 각 클라이언트가 하고, 이 파일은 그 구현이 따르는 포트(`ExpressionDiskCompartment`)와 순수 함수만 든다.
// 읽기 문·대조 청소·알림 규칙(M2.4)은 여기가 아니라 각 클라이언트의 저장소 한 곳(웹 `ExpressionStore`)에 있다 — 포트는 어떤 항목이 지금 그려도 되는지 모른다.
// =============================================================================
import type { Expression, ExpressionImage } from "./types";

/** 그림의 세 크기. 목록 항목의 `media` 가 이 이름으로 가진다. */
export const EXPRESSION_VARIANTS = ["small", "large", "thumb"] as const;

/** 보관 칸 하나(= `(워크스페이스, 멤버)` 하나)의 바이트 상한. 넘으면 오래 읽지 않은 것부터 버린다(ADR §14 M2.7, 저장 바이트). */
export const EXPRESSION_DISK_BUDGET_BYTES = 128 * 1024 * 1024;
/** 마지막으로 읽거나 쓴 뒤 이만큼 지난 항목은 지운다(7일). 대조가 닿지 못한 기기(오래 안 연 앱)에 옛 항목이 남는 기간의 상한이다. */
export const EXPRESSION_DISK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** 「마지막으로 읽은 시각」은 이 단위로만 갱신한다: 한 채널을 열 때마다 항목 수십 개의 메타를 다시 쓰지 않으려는 것이다. */
export const EXPRESSION_DISK_LAST_READ_GRANULARITY_MS = 60 * 1000;
/** 칸 이름 접두어. 서비스 워커(`sw.js`)가 지우는 `oort-shell-`로 시작하지 않는다. */
export const EXPRESSION_DISK_PREFIX = "oort-expr-img-v1.";

/** 디스크에 두는 그림 하나: 받은 그대로의 바이트와 그 MIME. */
export interface DiskImage {
  bytes: ArrayBuffer;
  mime: string;
}

/** 한 항목의 메타(바이트 없음). 상한·수명 청소가 이것만 훑는다. */
export interface DiskEntryMeta {
  /** 저장 바이트(= `bytes.byteLength`). */
  size: number;
  /** 쓴 시각(ms). */
  writtenAt: number;
  /** 마지막으로 읽은 시각(ms). 쓸 때는 쓴 시각과 같다. */
  lastReadAt: number;
}

/**
 * 한 보관 칸. **던지는 쪽은 `write` 하나뿐이다**: 읽기·청소·지우기의 실패는 「캐시 없음」이지 흐름을 멈출 이유가 아니다
 * (저장소는 선택 사항이다). 쓰기 실패는 호출부가 그 세션의 쓰기를 쉬게 하려고 던진다.
 */
export interface ExpressionDiskCompartment {
  /** 그 키의 그림. 없거나 읽을 수 없으면 `null`. 읽으면 마지막 읽은 시각을 갱신한다(1분 단위). */
  read(key: string): Promise<DiskImage | null>;
  /** 쓴다(같은 키는 덮어쓴다). 저장하지 못하면 던진다. */
  write(key: string, image: DiskImage): Promise<void>;
  /** 디스크 **색인**: 지금 들어 있는 모든 키. 읽을 수 없으면 `null`(대조 청소를 돌리지 않는다). */
  keys(): Promise<string[] | null>;
  /** 이 키들을 지운다. */
  remove(keys: readonly string[]): Promise<void>;
  /** 이 표현 id 들의 모든 항목(어느 크기·어느 sha든)을 지운다. */
  removeIds(ids: readonly string[]): Promise<void>;
  /** 수명이 지난 항목을 지우고, 바이트 상한을 넘으면 오래 읽지 않은 것부터 버린다. */
  trim(): Promise<void>;
  /** 이 칸을 통째로 지운다. */
  destroy(): Promise<void>;
}

/** 칸을 열고·세고·지우는 저장소 쪽(IndexedDB 또는 시험의 메모리 가짜). */
export interface ExpressionDiskBackend {
  /** 이 이름의 칸을 연다. 저장소를 쓸 수 없으면 `null`(호출부는 메모리만 쓰는 모양으로 떨어진다). */
  open(name: string): ExpressionDiskCompartment | null;
  /** 지금 있는 모든 칸의 이름(접두어가 맞는 것만). 읽을 수 없으면 빈 목록. */
  list(): Promise<string[]>;
  /** 이름으로 칸 하나를 통째로 지운다. 던지지 않는다. */
  destroy(name: string): Promise<void>;
}

/** 소문자 uuid 한 개(서버가 주는 id의 모양). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 칸 이름: 워크스페이스와 멤버가 모두 uuid일 때만 만든다(모양이 다르면 디스크를 쓰지 않는다). */
export function expressionDiskName(workspaceId: string, memberId: string): string | null {
  const workspace = workspaceId.toLowerCase();
  const member = memberId.toLowerCase();
  return UUID.test(workspace) && UUID.test(member) ? `${EXPRESSION_DISK_PREFIX}${workspace}.${member}` : null;
}

/** 이 이름이 이 모듈이 만든 보관 칸의 이름인가. */
export function isExpressionDiskName(name: string): boolean {
  return name.startsWith(EXPRESSION_DISK_PREFIX);
}

export type ExpressionDiskSize = (typeof EXPRESSION_VARIANTS)[number];

/** 디스크 키: `(id, size, sha)` 한 벌. 칸이 이미 `(워크스페이스, 멤버)`를 담고 있으므로 키에는 그것을 또 넣지 않는다. */
export function expressionDiskKey(id: string, size: ExpressionDiskSize, sha: string): string {
  return `${id}:${size}:${sha}`;
}

/** 키에서 표현 id(없으면 `null`). */
export function expressionIdOfDiskKey(key: string): string | null {
  const id = key.split(":", 1)[0];
  return UUID.test(id) ? id : null;
}

export interface ParsedImagePath {
  id: string;
  size: ExpressionDiskSize;
  sha: string;
  key: string;
}

/**
 * 활성 표현의 그림 주소(`…/expressions/{id}/image?size=…&v=…`)를 읽는다. **초안 미리보기(`expression-drafts/…`)와 그 밖의 모양은 `null`**이라
 * 디스크를 아예 보지 않는다(ADR §14 M2.3: 초안·후보 그림은 기기에 남기지 않는다, MA12).
 */
export function parseExpressionImagePath(path: string): ParsedImagePath | null {
  const match = /\/expressions\/([0-9a-f-]{36})\/image\?(.*)$/.exec(path);
  if (!match || !UUID.test(match[1])) return null;
  const query = new URLSearchParams(match[2]);
  const size = query.get("size");
  const sha = query.get("v");
  if (!EXPRESSION_VARIANTS.some((variant) => variant === size) || sha === null || !SHA256.test(sha)) return null;
  return { id: match[1], size: size as ExpressionDiskSize, sha, key: expressionDiskKey(match[1], size as ExpressionDiskSize, sha) };
}

/**
 * 청소 계획(순수 함수, 시험이 직접 잰다): 수명이 지난 항목과, 상한을 넘는 만큼의 **오래 읽지 않은 것**을 고른다.
 * 수명은 `max(마지막 읽은 시각, 쓴 시각)`에서 센다. 상한은 **바이트**로 센다(개수가 아니다).
 */
export function planTrim(
  entries: ReadonlyMap<string, DiskEntryMeta>,
  now: number,
  budgetBytes: number = EXPRESSION_DISK_BUDGET_BYTES,
  lifetimeMs: number = EXPRESSION_DISK_LIFETIME_MS,
): string[] {
  const doomed: string[] = [];
  const kept: Array<[string, DiskEntryMeta]> = [];
  for (const [key, meta] of entries) {
    if (now - Math.max(meta.lastReadAt, meta.writtenAt) > lifetimeMs) doomed.push(key);
    else kept.push([key, meta]);
  }
  let total = kept.reduce((sum, [, meta]) => sum + meta.size, 0);
  if (total > budgetBytes) {
    kept.sort((a, b) => a[1].lastReadAt - b[1].lastReadAt || a[1].writtenAt - b[1].writtenAt);
    for (const [key, meta] of kept) {
      if (total <= budgetBytes) break;
      doomed.push(key);
      total -= meta.size;
    }
  }
  return doomed;
}

/** 읽기 성공 때 마지막 읽은 시각을 다시 쓸지(1분 단위). */
export function shouldTouchLastRead(meta: DiskEntryMeta, now: number): boolean {
  return now - meta.lastReadAt >= EXPRESSION_DISK_LAST_READ_GRANULARITY_MS;
}

// ------------------------------------------------------------------------------------------------ 목록과의 대조 (읽기 문 3번, 대조 청소)
/** 목록이 말하는 지금 그려도 되는 항목인가(`active`). */
export const isActiveExpression = (item: Expression): boolean => item.status === "active";

/** 디스크 대상: 주소가 가리키는 `(id, size, sha)` 와 **목록이 말하는 그 그림의 메타**(정확한 길이·MIME 대조에 쓴다). */
export interface ListedDiskTarget extends ParsedImagePath {
  media: ExpressionImage;
}

/**
 * 읽기 문의 조건 3(M2.4-1): 주소의 `(id, size, sha)` 가 **확인된 목록의 active 항목**의 `media.<size>.sha256` 과 같을 때만 대상이다. 초안 미리보기 주소·그 밖의 모양·
 * 목록에 없는(숨김·삭제·교체된) 그림은 `null` 이라 디스크를 아예 읽지도 쓰지도 않는다.
 */
export function listedDiskTarget(items: readonly Expression[], path: string): ListedDiskTarget | null {
  const parsed = parseExpressionImagePath(path);
  if (parsed === null) return null;
  const media = items.find((item) => item.id === parsed.id && isActiveExpression(item))?.media?.[parsed.size];
  return media !== undefined && media.sha256 === parsed.sha ? { ...parsed, media } : null;
}

/** 이 대상이 지금 목록에도 active 로 있는가(받는 도중·해시를 재는 동안 목록이 바뀌었을 수 있다). */
export function isListedDiskTarget(items: readonly Expression[], target: ParsedImagePath): boolean {
  return items.find((item) => item.id === target.id && isActiveExpression(item))?.media?.[target.size]?.sha256 === target.sha;
}

/** 목록이 말하는 지금 유효한 디스크 키 전부(active 항목의 세 크기). 대조 청소가 「목록에 없는 키」를 가르는 기준이다. */
export function activeDiskKeys(items: readonly Expression[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (!isActiveExpression(item) || item.media === null) continue;
    for (const size of EXPRESSION_VARIANTS) keys.add(expressionDiskKey(item.id, size, item.media[size].sha256));
  }
  return keys;
}

// ------------------------------------------------------------------------------------------------ 웹 저장소(IndexedDB)의 모양
/** object store 이름. 메타(`meta`)와 바이트(`blobs`)를 나눠, 읽을 때마다 하는 「마지막 읽은 시각」 갱신이 바이트를 다시 쓰지 않게 한다. */
export const EXPRESSION_DISK_STORES = { meta: "meta", blobs: "blobs" } as const;
/** 트랜잭션 모드 둘. */
export const EXPRESSION_DISK_ACCESS = { read: "readonly", write: "readwrite" } as const;

/** 저장된 메타: 바이트 없이 항목 하나가 어떤 그림이고 언제 쓰이고 읽혔는지. */
export interface StoredDiskMeta extends DiskEntryMeta {
  mime: string;
}
export const isText = (value: unknown): value is string => typeof value === "string";
export function isStoredDiskMeta(value: unknown): value is StoredDiskMeta {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isText(record.mime) && Number.isFinite(record.size) && Number.isFinite(record.writtenAt) && Number.isFinite(record.lastReadAt);
}
/** 칸 이름 장부(JSON 배열)에서 이 모듈이 만든 칸 이름만. */
export function registeredDiskNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => isText(name) && isExpressionDiskName(name)) : [];
}
