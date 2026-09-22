// =============================================================================
// 명령 랭킹 — 최근 쓴 것이 먼저, 그다음 자주 쓴 것 (ADR-0186 D1 팔레트).
//
// 팔레트의 바닥 순서는 표가 적힌 순서다. 그 순서는 **아무도 쓴 적 없는 사람**의
// 순서로는 옳지만, 매일 인박스만 여는 사람에게는 매일 같은 만큼 틀린다.
//
// ## 시계를 쓰지 않는다
//
// 최근성을 타임스탬프로 저장하면 시험은 시계를 고정해야 하고, 기기 시계가
// 뒤로 가면(수동 변경·DST·NTP 보정) 순서가 뒤집힌다. 여기서는 **순서 자체를**
// 저장한다: `recent`는 최근 것이 앞인 id 목록이고, 그 목록이 곧 답이다. 잴 것이
// 목록의 모양뿐이라 시험에 시계가 없다.
//
// ## 저장은 부수적이다
//
// 이 파일은 문자열 ↔ 값 변환만 안다. 실제 `localStorage` 접근은 클라이언트가
// 한다(코어는 purity 게이트가 브라우저 전역을 막는다). 저장이 통째로 막힌
// 브라우저에서도 `parseCommandUsage(null)`이 빈 값을 주고 팔레트는 바닥 순서로
// 그려진다 — 사람에게 알릴 실패가 아니다.
// =============================================================================

/** 이 기기의 명령 사용 기록이 사는 자리. */
export const COMMAND_USAGE_STORAGE_KEY = "momo.web.commands.recent.v1";

/** 「최근」으로 쳐 주는 개수. 그 뒤는 빈도가 정한다. */
export const COMMAND_RECENT_LIMIT = 5;

export interface CommandUsage {
  /** 최근 것이 앞. 길이는 `COMMAND_RECENT_LIMIT` 이하. */
  readonly recent: readonly string[];
  /** id별 누적 실행 횟수. */
  readonly counts: Readonly<Record<string, number>>;
}

export const EMPTY_COMMAND_USAGE: CommandUsage = { recent: [], counts: {} };

interface StoredShape {
  readonly v?: unknown;
  readonly recent?: unknown;
  readonly counts?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 저장된 문자열을 값으로 읽는다. **무엇이 들어 있어도 던지지 않는다.**
 *
 * 남의 확장이 같은 키를 쓸 수도 있고, 옛 판이 다른 모양을 남겼을 수도 있다.
 * 읽기가 실패하면 랭킹이 없어질 뿐이므로 조용히 빈 값으로 떨어진다.
 */
export function parseCommandUsage(raw: string | null): CommandUsage {
  if (raw === null || raw === "") return EMPTY_COMMAND_USAGE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_COMMAND_USAGE;
  }
  if (!isRecord(parsed)) return EMPTY_COMMAND_USAGE;
  const shape = parsed as StoredShape;

  const recent = Array.isArray(shape.recent)
    ? shape.recent
        .filter((id): id is string => typeof id === "string" && id !== "")
        .slice(0, COMMAND_RECENT_LIMIT)
    : [];

  const counts: Record<string, number> = {};
  if (isRecord(shape.counts)) {
    for (const [id, value] of Object.entries(shape.counts)) {
      if (id === "") continue;
      if (typeof value !== "number") continue;
      if (!Number.isFinite(value) || value <= 0) continue;
      counts[id] = Math.floor(value);
    }
  }

  return { recent: dedupe(recent), counts };
}

export function serializeCommandUsage(usage: CommandUsage): string {
  return JSON.stringify({ v: 1, recent: usage.recent, counts: usage.counts });
}

function dedupe(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 한 번 실행했다. 최근 목록 맨 앞으로 올리고 횟수를 하나 올린다. */
export function recordCommandUse(
  usage: CommandUsage,
  id: string
): CommandUsage {
  if (id === "") return usage;
  const recent = dedupe([id, ...usage.recent]).slice(0, COMMAND_RECENT_LIMIT);
  const counts = { ...usage.counts, [id]: (usage.counts[id] ?? 0) + 1 };
  return { recent, counts };
}

/**
 * 랭킹을 얹는다.
 *
 * ① 최근 목록 순서 → ② 남은 것 중 빈도 높은 순 → ③ 그래도 같으면 **표의 바닥
 * 순서**. ③이 있어서 결과는 언제나 전순서이고, 같은 입력은 같은 출력을 준다.
 * 목록에 없는 id는 무시한다(레지스트리에서 사라진 명령의 기록).
 */
export function rankCommands<T extends { readonly id: string }>(
  commands: readonly T[],
  usage: CommandUsage
): readonly T[] {
  const baseOrder = new Map(commands.map((command, index) => [command.id, index]));
  const recentRank = new Map(usage.recent.map((id, index) => [id, index]));

  return [...commands].sort((left, right) => {
    const leftRecent = recentRank.get(left.id);
    const rightRecent = recentRank.get(right.id);
    if (leftRecent !== undefined || rightRecent !== undefined) {
      if (leftRecent === undefined) return 1;
      if (rightRecent === undefined) return -1;
      if (leftRecent !== rightRecent) return leftRecent - rightRecent;
    }
    const leftCount = usage.counts[left.id] ?? 0;
    const rightCount = usage.counts[right.id] ?? 0;
    if (leftCount !== rightCount) return rightCount - leftCount;
    return (baseOrder.get(left.id) ?? 0) - (baseOrder.get(right.id) ?? 0);
  });
}
