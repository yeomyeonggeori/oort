import type { ReadState } from "@momo/core/lib/api";
import { ABSENT_STATUSES } from "@momo/core/features/capabilities/serverSurfaces";
import {
  dmVisibility,
  type DmCounterpart,
  type DmVisibilityInput,
  type DmVisibilityRule,
} from "@momo/core/features/sidebar/dmVisibility";
import type { GoneUnreadVerdict, ReadProjectionPhase } from "@momo/core/features/sidebar/goneDm";

// =============================================================================
// DM 닫기를 서버 상태로 읽는 순수 부분 (ADR-0177 증보 D8·D12, #4228). 훅(`useDmVisibility.ts`)과 시험이 같은 함수를 읽는다.
//
// ## 두 갈래, 한 판정
//
// 보임 판정은 코어 함수 하나(`dmVisibility`)이고, 이 파일은 그 **입력을 모으는 길**이 둘이다.
//
//   server  서버가 닫기를 기억한다(`GET read-state` 행이 `latestReadableSeq`·`closedAtSeq` 를 싣는다). 입력은 행 그대로다.
//           메시지를 다시 읽지 않는다 - 서버가 이미 아는 사실을 기기마다 다시 계산하면 판정이 어긋난다(#4142 의 원인).
//   legacy  서버가 아직 안 싣는다(옛 서버). **지금까지의 동작**을 지킨다: 닫기는 기기 로컬 원장(`sidebarDmClosure.ts`),
//           「사람이 읽을 메시지」는 닫은 뒤·안 읽은 쪽을 한 번 읽어 가른다(`dmRevival.ts`·`goneUnreadVerdicts.ts`). 그 결과를
//           서버가 줬을 법한 두 숫자(`closedAtSeq`·`latestReadableSeq`)로 접어 **같은 코어 함수**에 넣는다.
//
// 탐지는 읽음 투영이 한다: 새 서버는 `latest_readable_seq` 를 **모든 행**에 싣는다. 쓰기 없이, 첫 페인트 전에 안다.
// =============================================================================

export type DmClosureMode = "server" | "legacy" | "unknown";

/** 닫기 경로가 404/405/501 이라 이 세션에서 접은 워크스페이스(`serverSaysAbsent` 폴딩, 둘째 겹). */
const foldedAbsent = new Set<string>();

export function foldDmClosureAbsent(workspaceId: string): void {
  foldedAbsent.add(workspaceId.toLowerCase());
}

export function dmClosureFolded(workspaceId: string): boolean {
  return foldedAbsent.has(workspaceId.toLowerCase());
}

/** 시험 전용. */
export function resetDmClosureFoldForTest(): void {
  foldedAbsent.clear();
}

/** 이 상태 코드가 「그런 경로 없다」인가(`serverSaysAbsent` 와 같은 집합, 오류 객체 없이). */
export function isAbsentStatus(status: number): boolean {
  return ABSENT_STATUSES.includes(status);
}

/**
 * 읽음 투영 행들로 서버가 닫기를 싣는지 가른다.
 *
 *   * 행 중 하나라도 `latestReadableSeq`·`closedAtSeq` 를 말하면 **server** 다(새 서버는 모든 행에 싣는다).
 *   * 행이 있는데 아무도 말하지 않으면 **legacy**.
 *   * 투영이 없거나 행이 0 개면 **unknown** - 증거가 없다. 호출부가 캐시·원장으로 보충한다.
 *
 * 접힌 워크스페이스(`foldDmClosureAbsent`)는 투영이 뭐라 하든 legacy 다.
 */
export function dmClosureMode(input: {
  workspaceId: string;
  rows: readonly ReadState[] | undefined;
}): DmClosureMode {
  if (dmClosureFolded(input.workspaceId)) return "legacy";
  const rows = input.rows;
  if (rows === undefined || rows.length === 0) return "unknown";
  return rows.some((row) => row.latestReadableSeq !== undefined || row.closedAtSeq !== undefined)
    ? "server"
    : "legacy";
}

// ---- 첫 페인트 캐시 ------------------------------------------------------------

/** 마지막 투영의 한 행에서 보임 판정에 쓰는 것만: [closedAtSeq|null, latestReadableSeq, lastReadSeq, signal(0|1)]. */
export type CachedDmFacts = readonly [number | null, number, number, 0 | 1];

/** channelId(소문자) → 사실. 서버 사실의 **사본**이지 원장이 아니다: 투영이 오면 통째로 바뀐다. */
export type DmClosureCache = Readonly<Record<string, CachedDmFacts>>;

export const DM_CLOSURE_CACHE_KEY = "momo.web.dm-closure-cache.v1";

/** 워크스페이스마다 적어 두는 최대 행 수. 쓰레기가 영원히 자라지 않게 한다. */
export const DM_CLOSURE_CACHE_MAX = 500;

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 저장된 문자열 → 캐시. **던지지 않는다**: 못 읽은 것은 캐시가 없는 것과 같다(= 판정을 미룬다). */
export function parseDmClosureCache(raw: string | null, workspaceId: string): DmClosureCache | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entry = (parsed as Record<string, unknown>)[workspaceId.toLowerCase()];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const out: Record<string, CachedDmFacts> = {};
    for (const [channel, value] of Object.entries(entry)) {
      if (channel === "__proto__" || !Array.isArray(value) || value.length !== 4) continue;
      const [closed, readable, lastRead, signal] = value as unknown[];
      if (
        (closed === null || isSeq(closed)) &&
        isSeq(readable) &&
        isSeq(lastRead) &&
        (signal === 0 || signal === 1)
      ) {
        out[channel.toLowerCase()] = [closed, readable, lastRead, signal];
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** 투영 행들 → 캐시. `closedAtSeq` 를 말하지 않은 행(`undefined`)은 적지 않는다: 모르는 것을 「안 닫음」으로 적지 않는다. */
export function dmClosureCacheOf(rows: readonly ReadState[], dmIds: ReadonlySet<string>): DmClosureCache {
  const out: Record<string, CachedDmFacts> = {};
  for (const row of rows) {
    const id = row.channelId.toLowerCase();
    if (!dmIds.has(id) || row.closedAtSeq === undefined) continue;
    out[id] = [
      row.closedAtSeq,
      row.latestReadableSeq ?? row.latestSeq,
      row.lastReadSeq,
      row.markedUnreadBeforeSeq !== null || row.mentionCount > 0 ? 1 : 0,
    ];
  }
  const keys = Object.keys(out);
  for (const stale of keys.slice(0, Math.max(0, keys.length - DM_CLOSURE_CACHE_MAX))) delete out[stale];
  return out;
}

// ---- 한 DM 의 판정 입력 ---------------------------------------------------------

export type DmVisibilityState = "shown" | "hidden" | "pending";

export interface DmVerdict {
  state: DmVisibilityState;
  rule: DmVisibilityRule;
}

export interface DmFactsInput {
  mode: DmClosureMode;
  phase: ReadProjectionPhase;
  counterpart: DmCounterpart;
  starredOrSectioned: boolean;
  /** 이 DM 의 읽음 투영 행(없으면 메시지가 한 번도 없는 DM). */
  read: ReadState | undefined;
  /** server·loading 에서 쓰는 마지막 투영의 사본. `null` 이면 캐시가 없다(재설치). */
  cache: DmClosureCache | null;
  channelId: string;
  /** legacy: 원장이 적어 둔 닫을 때 seq. 닫은 적 없으면 `undefined`. */
  ledgerClosedAtSeq: number | undefined;
  /** legacy: 닫은 DM 의 되살림 판정이 가리는 최신 seq(`useDmRevival`). */
  revivalLatestSeq: number | undefined;
  /** legacy: 나간 멤버 DM 의 안 읽음이 사람이 읽을 것인지의 판정(`useGoneUnreadVerdicts`). */
  goneVerdict: GoneUnreadVerdict | undefined;
}

/**
 * 한 DM 의 보임 판정(열림 여부를 **빼고**). 열림은 호출부가 얹는다: 인덱스 폴백이 후보를 고를 때 열림은 이 판정의 입력이 아니라
 * 결과이기 때문이다(`indexFallbackChannelId`).
 *
 * `hold`(코어 3번, 직전 판정 유지)는 여기서 풀린다:
 *   * server·loading: 마지막 투영의 사본으로 다시 돌린 판정. 사본이 없으면(재설치 직후) **pending** - 투영이 올 때까지 미룬다.
 *   * server·ready 인데 이 행이 닫힘을 말하지 않았다: 사본이 있으면 사본의 판정, 없으면 보인다(모를 때 숨기는 쪽이 최악).
 *   * legacy·loading: 원장이 닫은 DM 과 나간 멤버 DM 은 숨은 채(옛 동작: 깜빡이며 나타났다 사라지지 않게).
 */
export function dmVerdict(input: DmFactsInput): DmVerdict {
  const facts = factsFor(input);
  if (facts === "pending") return { state: "pending", rule: 3 };
  const first = dmVisibility({ ...facts, isOpen: false });
  if (first.visibility !== "hold") return { state: first.visibility, rule: first.rule };
  // hold: 직전 판정으로 푼다.
  if (input.mode === "legacy" || input.mode === "unknown") {
    const hide =
      input.phase === "loading" &&
      (input.ledgerClosedAtSeq !== undefined || input.counterpart === "gone");
    return { state: hide ? "hidden" : "shown", rule: 3 };
  }
  const cached = input.cache?.[input.channelId.toLowerCase()];
  if (cached === undefined) {
    return input.phase === "loading" && input.cache === null
      ? { state: "pending", rule: 3 }
      : { state: "shown", rule: 3 };
  }
  const again = dmVisibility({
    ...cachedFacts(input, cached),
    phase: "ready",
    isOpen: false,
  });
  return { state: again.visibility === "hold" ? "shown" : again.visibility, rule: again.rule };
}

type Facts = Omit<DmVisibilityInput, "isOpen">;

function cachedFacts(input: DmFactsInput, cached: CachedDmFacts): Facts {
  return {
    starredOrSectioned: input.starredOrSectioned,
    closedAtSeq: cached[0],
    latestReadableSeq: cached[1],
    lastReadSeq: cached[2],
    // 신호는 「있다/없다」 한 비트만 적어 둔다: 값은 판정이 읽지 않는다(`!== null`).
    markedUnreadBeforeSeq: cached[3] === 1 ? 0 : null,
    mentionCount: 0,
    counterpart: input.counterpart,
    phase: input.phase,
  };
}

function factsFor(input: DmFactsInput): Facts | "pending" {
  const { read } = input;
  // 증거가 아무것도 없다: 투영이 오는 중이고, 마지막 투영의 사본도 이 기기의 원장도 없다(재설치·첫 실행). 닫은 대화를 가리지 못한 채
  // 그리면 투영이 도착하는 순간 사라지므로(D8) 투영이 올 때까지 판정을 미룬다.
  if (
    input.mode === "unknown" &&
    input.phase === "loading" &&
    input.cache === null &&
    input.ledgerClosedAtSeq === undefined
  ) {
    return "pending";
  }
  const base = {
    starredOrSectioned: input.starredOrSectioned,
    counterpart: input.counterpart,
    phase: input.phase,
  };
  if (input.mode === "legacy" || input.mode === "unknown") {
    const latest = read?.latestSeq ?? 0;
    const lastRead = read?.lastReadSeq ?? 0;
    const closedAt = input.ledgerClosedAtSeq ?? null;
    // 되살림 판정이 눌러 둔 값(기계 메시지뿐이면 닫을 때의 seq)이 이 DM 의 「읽을 seq」다.
    let readable = closedAt === null ? latest : (input.revivalLatestSeq ?? latest);
    // 나간 멤버 DM 의 안 읽음이 기계 메시지뿐이면(`ambient`) 아직 읽는 중이면(`pending`) 읽을 것이 없다 - 읽은 자리가 곧 읽을 자리.
    if (input.goneVerdict === "ambient" || input.goneVerdict === "pending") {
      readable = Math.min(readable, lastRead);
    }
    return {
      ...base,
      closedAtSeq: closedAt,
      latestReadableSeq: readable,
      lastReadSeq: lastRead,
      markedUnreadBeforeSeq: read?.markedUnreadBeforeSeq ?? null,
      mentionCount: read?.mentionCount ?? 0,
    };
  }
  // server
  if (input.phase === "loading") {
    const cached = input.cache?.[input.channelId.toLowerCase()];
    if (input.cache === null) return "pending";
    // 사본이 있는 워크스페이스에서 사본에 없는 DM 은 지난 세션 뒤에 생긴 DM 이다 - 안 닫았다.
    return cached === undefined
      ? { ...base, phase: "ready", closedAtSeq: null, latestReadableSeq: 0, lastReadSeq: 0, markedUnreadBeforeSeq: null, mentionCount: 0 }
      : { ...cachedFacts(input, cached), phase: "ready" };
  }
  if (read === undefined) {
    return { ...base, closedAtSeq: null, latestReadableSeq: 0, lastReadSeq: 0, markedUnreadBeforeSeq: null, mentionCount: 0 };
  }
  return {
    ...base,
    closedAtSeq: read.closedAtSeq,
    // 이 행이 읽을 seq 를 말하지 않았다(옛 행): 전체 seq 로 대신한다 - 더 많이 보이는 쪽이다.
    latestReadableSeq: read.latestReadableSeq ?? read.latestSeq,
    lastReadSeq: read.lastReadSeq,
    markedUnreadBeforeSeq: read.markedUnreadBeforeSeq,
    mentionCount: read.mentionCount,
  };
}

// ---- 로컬 원장 이전 (D12) --------------------------------------------------------

export const DM_CLOSURE_MIGRATED_KEY = "momo.web.dm-closure-migrated.v1";

export interface MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function migratedWorkspaces(storage: MigrationStorage | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DM_CLOSURE_MIGRATED_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

/** 이 (기기, 워크스페이스)의 이전이 끝났는가. */
export function dmLedgerMigrated(workspaceId: string, storage: MigrationStorage | null): boolean {
  return migratedWorkspaces(storage).has(workspaceId.toLowerCase());
}

export function markDmLedgerMigrated(workspaceId: string, storage: MigrationStorage | null): void {
  const done = migratedWorkspaces(storage);
  done.add(workspaceId.toLowerCase());
  try {
    storage?.setItem(DM_CLOSURE_MIGRATED_KEY, JSON.stringify([...done]));
  } catch {
    // 저장소 거부: 이 세션에서만 한 번이다. 다음 실행에 다시 하면 서버 쪽은 멱등이다(GREATEST).
  }
}

export interface MigrationResult {
  /** 서버가 받았거나(2xx) 그 DM 이 서버에 없다고 한(404) 항목 - 원장에서 지웠다. */
  settled: string[];
  /** 남긴 항목(실패). 다음 실행에 다시 한다. */
  kept: string[];
  /** 닫기 경로가 없다고 답했다(404 가 아니라 405/501): 이전을 멈췄고 표면을 접어야 한다. */
  absent: boolean;
  /** 이전이 끝났다(마커를 적었다). */
  done: boolean;
}

/**
 * 기기 로컬 원장을 서버로 옮긴다 (D12). **(기기, 워크스페이스)마다 한 번, 지금 숨은 항목만, 항목별로 2xx/404 뒤에만 지운다.**
 *
 *   * 숨은 항목 = 원장에 있고, 투영 행이 있고, 읽을 seq 가 닫을 때 seq 를 못 넘은 것. 되살아난 항목은 올리지 않는다.
 *   * 각 항목은 로컬 워터마크를 `seenSeq` 로 보낸다(D7). 서버가 채널 head 로 누른다.
 *   * 2xx·404(그 DM 이 서버에 없다) -> 그 항목만 원장에서 지운다. 그 밖의 오류 -> 남긴다(다음 실행에 다시).
 *   * 405/501 -> 경로가 없다. 멈추고 나머지는 건드리지 않는다(마커도 적지 않는다).
 *   * 다른 워크스페이스의 항목, 이 워크스페이스의 되살아난 항목은 건드리지 않는다.
 *   * 실패가 하나도 남지 않았을 때만 마커를 적는다. 실패가 남았으면 마커가 없어 다음 실행이 그 항목만 다시 시도한다.
 */
export async function migrateDmLedger(input: {
  workspaceId: string;
  /** 이 워크스페이스의 원장(채널 id 소문자 -> 닫을 때 seq). */
  ledger: Readonly<Record<string, number>>;
  rows: readonly ReadState[];
  put: (channelId: string, seenSeq: number) => Promise<void>;
  /** 원장에서 한 항목을 지운다. */
  forget: (channelId: string) => void;
  storage: MigrationStorage | null;
}): Promise<MigrationResult> {
  const result: MigrationResult = { settled: [], kept: [], absent: false, done: false };
  if (dmLedgerMigrated(input.workspaceId, input.storage)) {
    result.done = true;
    return result;
  }
  const rowById = new Map(input.rows.map((row) => [row.channelId.toLowerCase(), row]));
  for (const [channelId, closedAt] of Object.entries(input.ledger)) {
    const row = rowById.get(channelId.toLowerCase());
    if (row === undefined) continue;
    const readable = row.latestReadableSeq ?? row.latestSeq;
    if (readable > closedAt) continue; // 되살아난 항목
    try {
      await input.put(channelId, closedAt);
      input.forget(channelId);
      result.settled.push(channelId);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) {
        input.forget(channelId);
        result.settled.push(channelId);
      } else if (status !== null && isAbsentStatus(status)) {
        result.absent = true;
        result.kept.push(channelId);
        return result;
      } else {
        result.kept.push(channelId);
      }
    }
  }
  if (result.kept.length === 0) {
    markDmLedgerMigrated(input.workspaceId, input.storage);
    result.done = true;
  }
  return result;
}

function statusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}
