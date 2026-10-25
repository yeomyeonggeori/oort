// =============================================================================
// 보낸 메시지 등장 애니메이션의 「한 번만」 장부 (#4383).
//
// 보낸 행은 **낙관적 메아리(`PendingRow`)가 마운트되는 한 번**만 올라온다. 서버 사본이 그 행을
// 대체할 때는(`MessageRow`) 움직이지 않는다 — 같은 자리에 같은 모양으로 이어서 서므로 두 번째
// 움직임은 곧 깜빡임이다. 그런데 목록이 가상화되면 화면 밖으로 나갔다 돌아온 메아리가
// **다시 마운트**되어 또 올라올 수 있다. 그래서 이미 올라온 `clientMsgId` 를 여기 적어 두고 두 번째
// 마운트는 곧바로 자리에 앉힌다.
//
// 상한이 있는 이유: 앱이 사는 동안 쌓이면 새는 것이다. 메아리는 서버 사본이 오면 사라지므로 오래된
// 것부터 잊어도 다시 마운트될 일이 없다.
//
// ## 자격 창 (#4455, Buzz `isRecentLocalMessageSendAnimation`)
//
// 「한 번만」은 두 번째 마운트를 막는다. 첫 마운트가 **너무 늦은** 경우는 다른 물음이다 — 복원된
// 전송이나 방을 늦게 열어 처음 그려진 내 메시지가 방금 보낸 것처럼 올라오면 안 된다. 그래서 보낸
// 지 `SEND_ARRIVE_WINDOW_MS` 안에 그려진 메아리만 움직인다. 기준은 마운트 시각이 아니라 **보낸
// 시각**(`PendingMessage.createdAtMs`)이다 — 마운트 시각을 기준으로 삼으면 늦게 그려진 행도 그려진
// 순간부터 세어 항상 자격이 있다.
//
// ## 확정본이 등장 도중에 와도 메아리를 자리에 둔다 (#4455, design-review r1 H1)
//
// 오름은 메아리 자신의 transform 이다. 서버 사본이 오면 키가 `p-<clientMsgId>` → `m-<seq>` 로 바뀌어 메아리가
// 언마운트되고 transform 이 한 번에 사라진다. 등장이 끝나기 전에 확정본이 오면(POST 응답이든 그것을 앞지른 실시간
// 프레임이든 — 코어 `model.ts` 가 「실시간 프레임이 POST 응답을 앞설 수 있다」고 적는다) **남은 오름 = 남은 비율 ×
// 시작 거리**(긴 글·사진 행은 수십~수백 pt)가 한 번에 뛴다. 이전의 180ms·14pt 는 확정(≈250ms)보다 먼저 끝나서 이
// 면이 없었고, 300ms·배수 × 높이로 늘린 이 변경이 연 면이다.
//
// 그래서 **등장이 도는 동안은 확정본 자리에 메아리를 그대로 둔다.** 메아리가 마운트돼 오름을 시작하면 여기 적어 두고
// (`holdArrival`), `Timeline` 이 확정본 항목을 같은 키(`p-<clientMsgId>`)의 메아리 항목으로 바꿔 그린다
// (`holdSettledArrivals`). 같은 컴포넌트 인스턴스가 이어지므로 오름이 끊기지 않고, 끝난 뒤(`untilMs`)에 확정본으로
// 바뀔 때는 transform 이 이미 0 이라 위치 변화가 없다 — 메아리와 서버 사본은 높이·색·모양이 같다(위 수리).
//
// 짝은 코어의 `confirmsPending`(같은 사람·같은 글·`sinceSeq` 위·첨부 id)이 정한다. 훅의 pending 목록에 기대지
// 않는다: 실시간 프레임에는 `client_msg_id` 가 없고, `useTimeline.post` 는 확정본(`applyBatch`)과 `removePending` 을
// 같은 틱에 처리해서 그 렌더의 폴드가 이미 짝을 못 본다. 이 장부는 메아리가 마운트될 때 **자기 사본을 따로 쥔다**.
//
// 보류는 시간으로만 끝난다(`SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS`). 메아리가 가상화로 언마운트돼도, 실패해도
// 끝나므로 확정본이 영영 가려지지 않는다.
// =============================================================================

import {
  confirmsPending,
  type PendingMessage,
  type TimelineItem,
} from '@momo/core/features/timeline/model';
import {uuidEq} from '@momo/core/lib/api';
import {
  SEND_ARRIVE_HOLD_SLACK_MS,
  SEND_ARRIVE_MS,
  SEND_ARRIVE_WINDOW_MS,
} from '../../design/motion';

const MAX_REMEMBERED = 256;

const arrived = new Set<string>();

/** 이 메아리가 이미 올라온 적이 있는가. 읽기만 한다(렌더 중에 불러도 안전). */
export function hasArrived(clientMsgId: string): boolean {
  return arrived.has(clientMsgId);
}

/** 올라왔다고(또는 올라오지 않기로 했다고) 적는다. 효과에서 부른다. */
export function markArrived(clientMsgId: string): void {
  if (arrived.has(clientMsgId)) return;
  arrived.add(clientMsgId);
  if (arrived.size > MAX_REMEMBERED) {
    const oldest = arrived.values().next().value;
    if (oldest !== undefined) arrived.delete(oldest);
  }
}

/**
 * 보낸 지 자격 창 안인가. 보낸 시각을 알 수 없으면(유한한 수가 아니면) **아니오** — 모르는 행을
 * 방금 보낸 것으로 읽어 움직이느니 가만히 서는 쪽이 안전하다. `nowMs` 는 시험이 시계를 고정하려고 받는다.
 */
export function withinArrivalWindow(
  createdAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= SEND_ARRIVE_WINDOW_MS;
}

// ---- 등장이 도는 메아리 (확정본이 와도 자리에 둔다) -------------------------------------------

/** 오름이 도는 중인 메아리의 사본. `PendingRow` 가 마운트 때 적는다. */
export interface ArrivalInFlight {
  readonly pending: PendingMessage;
  /** 메아리가 마운트될 때의 머리 행 여부 — 보류 중에도 같은 모양으로 그려야 레이아웃이 안 바뀐다. */
  readonly startsGroup: boolean;
  /** 이 시각(벽시계 ms)까지는 확정본이 와도 메아리를 둔다. */
  readonly untilMs: number;
}

const NO_ARRIVALS: readonly ArrivalInFlight[] = [];
const inFlight = new Map<string, ArrivalInFlight>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` 가 읽는 값. 적거나 풀릴 때만 새 배열이다(그 사이엔 같은 참조). */
let snapshot: readonly ArrivalInFlight[] = NO_ARRIVALS;

function publish(): void {
  snapshot = inFlight.size === 0 ? NO_ARRIVALS : Array.from(inFlight.values());
  listeners.forEach(listener => listener());
}

function releaseArrival(clientMsgId: string): void {
  releaseTimers.delete(clientMsgId);
  if (inFlight.delete(clientMsgId)) publish();
}

/**
 * 오름이 시작된 메아리를 적는다 — 효과에서 부른다. 같은 `clientMsgId` 를 다시 적으면 시계가 새로 시작한다.
 * `nowMs` 는 시험이 시계를 고정하려고 받는다.
 */
export function holdArrival(
  pending: PendingMessage,
  startsGroup: boolean,
  nowMs: number = Date.now(),
): void {
  const id = pending.clientMsgId;
  const holdMs = SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS;
  const earlier = releaseTimers.get(id);
  if (earlier !== undefined) clearTimeout(earlier);
  inFlight.set(id, {pending, startsGroup, untilMs: nowMs + holdMs});
  releaseTimers.set(
    id,
    setTimeout(() => releaseArrival(id), holdMs),
  );
  publish();
}

/** `useSyncExternalStore` 의 구독. */
export function subscribeArrivals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 지금 오름이 도는 메아리들(보낸 순서). 바뀌지 않으면 같은 참조다. */
export function arrivalsInFlight(): readonly ArrivalInFlight[] {
  return snapshot;
}

/** 확정본이 몇 번째 뒤까지 거슬러 찾을지. 새로 온 확정본은 항상 꼬리 근처에 선다. */
const HOLD_LOOKBACK = 64;

/**
 * 확정본이 이미 와서 폴드가 메아리를 걷은 자리에, 오름이 아직 도는 메아리를 **같은 키로** 되돌려 세운다.
 *
 * - 메아리 하나는 확정본 하나만 대신한다(코어 `unsettledPending` 과 같은 규칙: 보낸 순서대로, 한 번씩).
 * - 이미 자기 키로 서 있는 메아리(아직 미정착)는 건드리지 않는다.
 * - 바꿀 것이 없으면 **받은 배열을 그대로** 돌려준다(호출자의 memo 를 지킨다 — `withTurnPlaceholders` 와 같다).
 */
export function holdSettledArrivals(
  items: TimelineItem[],
  arrivals: readonly ArrivalInFlight[],
): TimelineItem[] {
  if (arrivals.length === 0) return items;
  let out: TimelineItem[] | null = null;
  const taken = new Set<number>();
  for (const arrival of arrivals) {
    const key = `p-${arrival.pending.clientMsgId}`;
    if (items.some(item => item.key === key)) continue;
    const lowest = Math.max(0, items.length - HOLD_LOOKBACK);
    let at = -1;
    // 오래된 확정본부터(= 보낸 순서대로) 짝을 찾는다.
    for (let index = lowest; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== 'message' || taken.has(index)) continue;
      if (!uuidEq(item.message.channelId, arrival.pending.channelId)) continue;
      if (confirmsPending(item.message, arrival.pending)) {
        at = index;
        break;
      }
    }
    if (at < 0) continue;
    taken.add(at);
    if (out === null) out = items.slice();
    out[at] = {
      kind: 'pending',
      key,
      pending: arrival.pending,
      startsGroup: arrival.startsGroup,
    };
  }
  return out ?? items;
}

/** 시험 전용. */
export function resetArrivedForTest(): void {
  arrived.clear();
  releaseTimers.forEach(timer => clearTimeout(timer));
  releaseTimers.clear();
  inFlight.clear();
  snapshot = NO_ARRIVALS;
}
