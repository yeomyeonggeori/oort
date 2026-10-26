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
//
// ## 보류는 메아리를 그린 표면에서만 읽는다 (#4455, design-review r2 M4)
//
// 장부는 모듈 전역이고 `Timeline` 은 여럿이다(채널 목록 하나, 그 위에 얹힌 스레드 패널 하나). 스레드 답글은 **스레드 목록에만**
// 메아리가 서고(코어 `useTimeline` 의 `channelPending` 이 채널 목록에서 거른다) 확정되면 채널 목록에도 평범한 행으로 선다 — 그런데
// 보류가 표면을 가리지 않으면 스레드에서 적힌 항목을 채널 목록도 읽어서, 확정된 답글을 약 360ms 동안 메아리로 한 번 더 그린다.
// 패널 뒤라 안 보이지만 코어가 지킨다고 적은 불변식(「채널 목록은 답글의 메아리를 그리지 않는다」)을 깨고, 패널을 360ms 안에
// 닫으면 채널 꼬리에서 답글 표식 줄이 생기는 높이 변화가 보일 수 있다.
//
// 그래서 항목에 **그린 표면**을 적는다(채널 목록 `'channel'`, 스레드는 루트마다 `'thread:<루트 id>'`). 메아리가 마운트될 때 자기를
// 그리는 `Timeline` 의 표면을 받아 적고, `Timeline` 은 **자기 표면의 항목만** 읽는다(`holdSettledArrivals` 의 세 번째 인자).
//
// ## 사진은 서버 사본을 **먼저 마운트해 두고** 메아리를 잠깐 더 남긴다 (#4455, design-review r3 H3)
//
// 위 보류는 위치(transform)의 연속을 지킨다. 그런데 사진 행은 칠에 한 가지가 더 있다: 서버 사본은 **새 마운트**라 사진 타일의
// `<Image>` 도 새로 만들어지고, 새 네이티브 이미지 뷰는 첫 프레임에 아직 안 그려진 채 서서(8~23ms, 한 프레임) 타일이 중립 면으로
// 한 번 번쩍인다. 크기·자리는 맞아서(H2 수리) 레이아웃 지표는 0 이고 칠만 비는 사건이다. 글자 행에는 없다. JS 에서 첫 페인트를
// 앞당길 길은 없으므로, **새 뷰가 보이기 전에 미리 마운트해 그려 둔다**.
//
// 서 있던 사진 메아리가 사라지면(`holdSettledArrivals` 가 보류를 풀거나, 보류 없이 확정본이 오거나) 그 메아리를 **확정본의 자리에 그대로**
// (같은 키·같은 인덱스 — 인스턴스와 그 안의 `<Image>` 가 손도 안 닿는다) `ECHO_LINGER_MS` 동안 더 남기고, 확정본(서버 사본)은 **스트림
// 맨 끝**에 **대기 상태**(`standby`: 높이 0 · 투명 · 눌림·낭독 없음 — `MessageRow`)로 미리 마운트한다. 서버 사본의 이미지가 그동안 눈에
// 안 보이는 채 그려지고, 창이 끝나는 **한 커밋**에서 메아리가 걷히며 서버 사본이 제 자리로 드러난다 — 같은 키(`m-<seq>`)가 끝에서 제 자리로
// 옮겨 갈 뿐이라 React 가 인스턴스를 그대로 잇는다. 같은 내용·같은 크기·같은 자리라 눈에는 아무 일도 안 일어난다. 사진이 없는 행(글자·
// 파일 카드)은 이 일이 없으므로 대기도 없다.
//
// **왜 맨 끝인가.** 대기 사본을 메아리 바로 뒤에 끼우면 목록이 한 칸 늘면서 **메아리 뒤에 서 있던 행들의 인덱스가 한 칸씩 밀린다**
// (에이전트 「작업 중」 자리는 항상 스트림 맨 끝에 붙고, 사진 뒤에 이어 보낸 메아리도 뒤에 선다). `VirtualizedList` 는 항목이 늘어난 커밋에서
// 렌더 창의 끝을 그대로 두므로 가장 뒤 행이 창 밖으로 나갔다가 새 인스턴스로 다시 선다 — 아래 「유령」을 버리게 한 바로 그 기전이 메아리
// 셀에서 꼬리 셀로 옮겨 간다(design-review r4 H4). 맨 끝에 새로 느는 쪽을 서버 사본으로 하면 기존 행의 인덱스가 하나도 안 바뀐다.
//
// (처음에는 메아리를 서버 사본 **위에** 겹쳐 두는 쪽을 시도했다. 그 길은 목록이 한 칸 늘면서 메아리 셀의 인덱스가 밀리는데,
// `VirtualizedList` 는 늘어난 꼬리의 렌더 창을 다음 업데이트에서야 넓혀서 그 커밋에 메아리 셀이 창 밖으로 나가 언마운트됐다가 한
// 프레임 뒤 **새 인스턴스**로 다시 섰다 — 옛 이미지 뷰를 이어 가려던 목적이 사라졌다. 메아리는 가만히 두고 새로 느는 쪽을 서버 사본으로
// 하면 메아리 셀의 인덱스가 안 변한다.)
//
// 이 상태는 장부가 아니라 **그 `Timeline` 의 렌더 중 파생 상태**다 — 「서 있던 사진 메아리가 사라졌고 그 확정본이 이미 목록에 있다」를
// 같은 렌더에서 알아야 서버 사본이 마운트되는 바로 그 커밋에 메아리가 함께 남는다(효과에서 정하면 한 프레임 늦는다). 장부에 기대지
// 않으므로 보류가 없는 경로(동작 줄이기·자격 창 밖·확정이 늦은 느린 전송)에서도 같다.
// =============================================================================

import {showsInlinePreview} from '@momo/core/features/attachments/model';
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

/** 메아리를 그린 표면의 이름 — 채널 목록. 안 정하면 이 표면이다(메아리가 서는 `Timeline` 의 기본). */
export const ARRIVAL_SURFACE_CHANNEL = 'channel';

/** 스레드 패널의 표면. 루트 하나가 표면 하나다 — 두 스레드가 같은 보류를 읽지 않는다. */
export function threadArrivalSurface(rootId: string): string {
  return `thread:${rootId}`;
}

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
  /** 메아리를 그린 표면(`ARRIVAL_SURFACE_CHANNEL` · `threadArrivalSurface`). 같은 표면의 `Timeline` 만 이 항목을 읽는다. */
  readonly surface: string;
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
 * `nowMs` 는 시험이 시계를 고정하려고 받는다. `surface` 는 이 메아리를 그리는 `Timeline` 의 표면이다(기본: 채널 목록).
 */
export function holdArrival(
  pending: PendingMessage,
  startsGroup: boolean,
  nowMs: number = Date.now(),
  surface: string = ARRIVAL_SURFACE_CHANNEL,
): void {
  const id = pending.clientMsgId;
  const holdMs = SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS;
  const earlier = releaseTimers.get(id);
  if (earlier !== undefined) clearTimeout(earlier);
  inFlight.set(id, {pending, startsGroup, untilMs: nowMs + holdMs, surface});
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
 * - **자기 표면의 항목만** 읽는다(`surface`, 기본: 채널 목록) — 스레드에서 적힌 메아리를 채널 목록이 또 그리지 않는다(M4).
 * - 바꿀 것이 없으면 **받은 배열을 그대로** 돌려준다(호출자의 memo 를 지킨다 — `withTurnPlaceholders` 와 같다).
 */
export function holdSettledArrivals(
  items: TimelineItem[],
  arrivals: readonly ArrivalInFlight[],
  surface: string = ARRIVAL_SURFACE_CHANNEL,
): TimelineItem[] {
  if (arrivals.length === 0) return items;
  let out: TimelineItem[] | null = null;
  const taken = new Set<number>();
  for (const arrival of arrivals) {
    if (arrival.surface !== surface) continue;
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

// ---- 사진: 메아리를 남기고 서버 사본을 대기시킨다 -----------------------------------------------

/** 메아리가 더 남는 시간(ms) = 서버 사본이 눈에 안 보이는 채 마운트돼 그려지는 시간. 새 `<Image>` 의 첫 페인트(한 프레임 — 시뮬레이터 8~23ms)보다 한참 길다. */
export const ECHO_LINGER_MS = 150;

/** 메아리 항목 — 코어 `TimelineItem` 의 `pending` 갈래. */
export type EchoItem = Extract<TimelineItem, {kind: 'pending'}>;

/** 대기 중인 서버 사본 — 같은 메시지 항목에 `standby` 표지 하나만 더한다. */
export type StandbyItem = Extract<TimelineItem, {kind: 'message'}> & {readonly standby: true};

/** 이 메아리가 인라인 사진을 달고 있는가 — 서버 사본이 새 `<Image>` 를 마운트하는 행이다(파일 카드는 이미지 뷰가 없다). */
export function carriesInlinePhoto(pending: PendingMessage): boolean {
  return (pending.attachments ?? []).some(showsInlinePreview);
}

/** 이 항목이 대기 중인 서버 사본인가. */
export function isStandbyItem(item: unknown): boolean {
  return (item as {standby?: unknown} | null)?.standby === true;
}

/**
 * 지금 서 있는 사진 메아리들. **실패한 메아리는 뺀다**(design-review r4 L15) — 실패 메아리는 흐린 본문 + 「전송 실패」 줄이라 서버 사본과 모양이
 * 달라서 겹쳐 둘 이유가 없고, 150ms 더 남으면 이미 처리된 전송에 「다시 보내기」가 더 서 있게 된다.
 */
export function photoEchoesOf(items: readonly TimelineItem[]): EchoItem[] {
  const out: EchoItem[] = [];
  for (const item of items) {
    if (item.kind === 'pending' && item.pending.status !== 'failed' && carriesInlinePhoto(item.pending)) out.push(item);
  }
  return out;
}

/** 같은 메아리 목록인가(키와 보낸 사본의 동일성). 렌더마다 새 배열이 나와도 상태가 매번 갱신되지 않게 한다. */
export function sameEchoes(a: readonly EchoItem[], b: readonly EchoItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.key === b[index].key && item.pending === b[index].pending);
}

/** `pending` 의 확정본이 `items` 안에서 몇 번째인가. `taken` 은 이미 다른 메아리가 짝지은 자리다. 없으면 -1. */
function twinIndex(items: readonly TimelineItem[], pending: PendingMessage, taken: ReadonlySet<number>): number {
  const lowest = Math.max(0, items.length - HOLD_LOOKBACK);
  for (let index = lowest; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'message' || taken.has(index)) continue;
    if (!uuidEq(item.message.channelId, pending.channelId)) continue;
    if (confirmsPending(item.message, pending)) return index;
  }
  return -1;
}

/**
 * 사라진 사진 메아리 중 **확정본이 이미 `items` 에 서 있는 것**만 — 그것이 서버 사본에 자리를 내주는 메아리다. 확정본이 없는 채
 * 사라진 것(방을 옮김·전송이 지워짐)은 대기시킬 서버 사본이 없으니 남기지 않는다.
 */
export function settledEchoes(departed: readonly EchoItem[], items: readonly TimelineItem[]): EchoItem[] {
  const taken = new Set<number>();
  const out: EchoItem[] = [];
  for (const echo of departed) {
    const at = twinIndex(items, echo.pending, taken);
    if (at < 0) continue;
    taken.add(at);
    out.push(echo);
  }
  return out;
}

/** `swapLingeringEchoes` 의 결과 — 메아리를 확정본의 자리에 둔 목록과, 맨 끝에 붙일 대기 서버 사본들. */
export interface LingeringSplit {
  /** 확정본이 있던 자리에 메아리를 **그대로** 둔 목록(길이는 받은 목록과 같다 — 어떤 행의 인덱스도 안 바뀐다). */
  readonly items: TimelineItem[];
  /** 스트림 **맨 끝**(자리표시 뒤)에 붙일 대기 서버 사본들 — 확정본에 `standby` 표지만 더한 것. */
  readonly standby: readonly StandbyItem[];
}

const NO_STANDBY: readonly StandbyItem[] = [];

/**
 * 남기는 메아리를 각자의 확정본 **자리에 그대로** 놓고(같은 키·같은 항목 — 보류 중 그 자리에 있던 그 인덱스다), 확정본은 `standby` 를 붙여
 * 따로 돌려준다 — 호출자가 스트림 **맨 끝**에 붙인다(`Timeline`, 위 「왜 맨 끝인가」). 확정본을 못 찾은 메아리는 버린다. 바꿀 것이 없으면
 * **받은 배열을 그대로** 돌려준다(호출자의 memo 를 지킨다).
 */
export function swapLingeringEchoes(items: TimelineItem[], lingering: readonly EchoItem[]): LingeringSplit {
  if (lingering.length === 0) return {items, standby: NO_STANDBY};
  const taken = new Set<number>();
  const swapped = new Map<number, EchoItem>();
  for (const echo of lingering) {
    const at = twinIndex(items, echo.pending, taken);
    if (at < 0) continue;
    taken.add(at);
    swapped.set(at, echo);
  }
  if (swapped.size === 0) return {items, standby: NO_STANDBY};
  const out = items.slice();
  const standby: StandbyItem[] = [];
  swapped.forEach((echo, at) => {
    standby.push({...(items[at] as Extract<TimelineItem, {kind: 'message'}>), standby: true} as StandbyItem);
    out[at] = echo;
  });
  return {items: out, standby};
}

/** 시험 전용. */
export function resetArrivedForTest(): void {
  arrived.clear();
  releaseTimers.forEach(timer => clearTimeout(timer));
  releaseTimers.clear();
  inFlight.clear();
  snapshot = NO_ARRIVALS;
}
