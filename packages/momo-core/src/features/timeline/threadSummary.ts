import {
  threadRollup,
  uuidEq,
  type Message,
  type ThreadReadState,
  type ThreadRollup,
} from "../../lib/api";
import type { MessageService } from "../../i18n/types";
import type { TimelineState } from "./model";

// =============================================================================
// 스레드 요약 줄의 표시 모델 (#4878, owner 10-31) — 웹·데스크탑·폰이 같은 규칙을 한 곳에서 받는다.
//
// 루트 메시지 아래 한 줄: 답글 단 사람 얼굴을 겹쳐 세우고 「답글 N개」를 쓴다. 안 읽은 답글이 있으면
// 줄을 강조하고 「새 답글 M」 칩을 붙인다. 화면은 이 파일이 낸 값을 **그리기만** 한다:
//
//   * 얼굴은 최대 `THREAD_FACE_MAX`(3). 4명 이상이어도 얼굴 뒤에 「+N」을 붙이지 않는다(「답글 N개」가 말한다).
//     서버가 참여자를 아직 안 주는 옛 서버(`participantIds` 없음·빈 배열)는 얼굴 없이 글만 선다.
//   * **「마지막 답글 X 전」은 없다.** owner가 뺐다(10-31 23:49): 시간 문구는 이 줄의 재료가 아니다.
//   * 칩은 `unreadReplyCount > 0`일 때만 선다. 값이 없다(따라가지 않는 스레드·옛 서버·에이전트 보기)는
//     「0」이 아니라 「말하지 않음」이고, 0은 「따라가고 있고 새 답글이 없다」다 — 둘 다 칩도 강조도 없다.
//   * 문구는 i18n 사전(`timeline.thread.*`) 한 곳에서 나온다. 접근성 라벨은 「스레드 열기, 답글 N개」
//     (안 읽은 답글이 있으면 「…, 새 답글 M개」).
// =============================================================================

/** 한 줄에 겹쳐 세우는 얼굴의 최대 수. 서버(`participant_ids`)도 3을 주지만 화면이 상한을 스스로 지킨다. */
export const THREAD_FACE_MAX = 3;

/** 얼굴 한 변. 웹 20px · 폰 22pt (owner 10-31 규격). 웹은 `--spacing-thread-face`가 이 숫자를 클래스로 옮긴다. */
export const THREAD_FACE_SIZE = { web: 20, phone: 22 } as const;

/** 옆 얼굴과 겹치는 폭(−6). 두 클라가 같다. 웹은 `--spacing-thread-face-overlap`. */
export const THREAD_FACE_OVERLAP = 6;

/** 겹친 얼굴을 바탕에서 도려내는 링의 두께(바탕색 2px). */
export const THREAD_FACE_RING = 2;

export interface ThreadSummary {
  replyCount: number;
  /** 얼굴로 세울 멤버 id — 가장 최근에 답글 단 사람 먼저, 서로 다르게, 최대 `THREAD_FACE_MAX`. 옛 서버면 빈 배열. */
  faces: readonly string[];
  /** 안 읽은 답글 수. 값이 없거나 0이면 0 — 칩 여부는 `hasUnread` 하나로 읽는다. */
  unreadReplyCount: number;
  hasUnread: boolean;
}

export function threadSummary(rollup: ThreadRollup): ThreadSummary {
  const seen = new Set<string>();
  const faces: string[] = [];
  // 문자열이 아니거나 빈 id는 건너뛴다. 대소문자만 다른 같은 id는 한 얼굴이다(uuid는 두 길로 오며 철자가 다르다).
  for (const id of rollup.participantIds ?? []) {
    if (typeof id !== "string" || id === "") continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    faces.push(id);
    if (faces.length === THREAD_FACE_MAX) break;
  }
  const raw = rollup.unreadReplyCount;
  // 깨진 값(음수·소수·문자열)은 칩에 NaN·음수를 그리지 않도록 「말하지 않음」으로 읽는다(`threadRollup`도 같은 규칙).
  const unreadReplyCount =
    typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
  return {
    replyCount: rollup.replyCount,
    faces,
    unreadReplyCount,
    hasUnread: unreadReplyCount > 0,
  };
}

export interface ThreadSummaryCopy {
  /** 「답글 N개」 */
  count: string;
  /** 「새 답글 M」 칩의 글. 안 읽은 답글이 없으면 `null`(칩을 그리지 않는다). */
  unreadChip: string | null;
  /** 줄 전체 버튼의 접근성 라벨 「스레드 열기, 답글 N개(, 새 답글 M개)」. */
  open: string;
  /** 행 하나를 한 번에 읽어 주는 낭독(폰의 행 라벨)에 끼우는 조각 「답글 N개, 새 답글 M」. */
  spoken: string;
}

export function threadSummaryCopy(
  summary: ThreadSummary,
  formatMessage: MessageService["formatMessage"]
): ThreadSummaryCopy {
  const count = formatMessage("timeline.thread.replyCount", { count: summary.replyCount });
  const unreadChip = summary.hasUnread
    ? formatMessage("timeline.thread.unreadChip", { count: summary.unreadReplyCount })
    : null;
  const open = summary.hasUnread
    ? formatMessage("timeline.thread.openUnread", {
        count: summary.replyCount,
        unread: summary.unreadReplyCount,
      })
    : formatMessage("timeline.thread.open", { count: summary.replyCount });
  return { count, unreadChip, open, spoken: unreadChip === null ? count : `${count}, ${unreadChip}` };
}

// ---- 안 읽은 수의 산수 ------------------------------------------------------------------------

/**
 * 서버가 기록 페이지에서 준 요약 위에, 이 화면이 **이미 들고 있는 답글**로 안 읽은 수를 더한다.
 *
 * 서버 값은 페이지를 읽은 때의 것이다. 그 뒤 실시간으로 들어온 남의 답글은 `lastReplySeq`(그 페이지의 머리)
 * 보다 큰 seq를 갖고, 그것을 세어 얹는다. 프레임마다 +1 하지 않는 이유는 되쏘기·재구독 복구가 같은 답글을
 * 두 번 배달하기 때문이다 — 든 답글 배열은 seq로 중복이 없으므로 **세는 쪽이 멱등**이다.
 *
 * 세는 것: 남(저자≠나)이 쓴, 지워지지 않은, `text` 줄. 서버 계약(`unread_reply_count`)과 같은 정의다 — 본인
 * 답글·지운 답글·카드 같은 text 아닌 줄은 안 읽은 것이 아니다.
 * 값이 없는 요약(따라가지 않는 스레드·옛 서버)은 **그대로 돌려준다**: 따라가는지 모르는데 칩을 세우면 거짓말이다.
 *
 * `replies`는 이 루트의 답글만이다(호출부가 루트별로 모은다).
 */
export function withLiveUnread(
  rollup: ThreadRollup,
  replies: readonly Message[],
  myMemberId: string
): ThreadRollup {
  const base = rollup.unreadReplyCount;
  if (base === undefined) return rollup;
  let beyond = 0;
  for (const reply of replies) {
    if (reply.seq <= rollup.lastReplySeq) continue;
    if (!countsAsReply(reply)) continue;
    if (uuidEq(reply.authorMemberId, myMemberId)) continue;
    beyond += 1;
  }
  return beyond === 0 ? rollup : { ...rollup, unreadReplyCount: base + beyond };
}

// ---- 실시간 답글이 루트 요약에 닿는 길 (#5008) --------------------------------------------------

/**
 * 요약에 한 줄로 치는 답글: 지우지 않은 `text` 줄. 서버 `unread_reply_count` 의 정의와 같고(`withLiveUnread`), 작업 세션
 * 이벤트·승인 카드 같은 `system` 등 text 아닌 줄은 대화의 답글이 아니라서 세지 않는다(서버도 그런 줄로는 요약을 올리지 않는다).
 */
function countsAsReply(reply: Message): boolean {
  return reply.type === "text" && reply.state !== "deleted";
}

/**
 * 머리(`head`) 뒤에 온, 요약에 한 줄로 치는 답글 — seq 오름차순, 같은 id는 한 번. 든 배열은 seq로 이미 중복이 없지만
 * (되쏘기·재구독 복구는 같은 답글을 두 번 배달한다) 여기서 id로 한 번 더 거른다: 개수는 **배달 횟수**가 아니라 **든 답글**에서
 * 나오므로 같은 입력은 늘 같은 답이다.
 */
function repliesBeyond(replies: readonly Message[], head: number): Message[] {
  const seen = new Set<string>();
  const beyond: Message[] = [];
  for (const reply of replies) {
    if (reply.seq <= head || !countsAsReply(reply)) continue;
    const key = reply.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    beyond.push(reply);
  }
  return beyond.sort((a, b) => a.seq - b.seq);
}

/**
 * 새 답글의 저자를 **가장 최근 먼저** 앞에 세우고 서버가 준 얼굴이 그 뒤를 잇는다. 서버 `participant_ids` 와 같은 규칙이다:
 * 다시 답한 사람은 맨 앞으로 옮겨 가고(`array_remove` + `array_append`) 한 사람은 한 번만 선다. 상한은 `THREAD_FACE_MAX`.
 */
function mergeFaces(fresh: readonly Message[], known: readonly string[]): string[] {
  const seen = new Set<string>();
  const faces: string[] = [];
  const add = (id: string) => {
    const key = id.toLowerCase();
    if (id === "" || seen.has(key)) return;
    seen.add(key);
    faces.push(id);
  };
  for (let index = fresh.length - 1; index >= 0; index -= 1) add(fresh[index].authorMemberId);
  for (const id of known) if (typeof id === "string") add(id);
  return faces.slice(0, THREAD_FACE_MAX);
}

/** `floor`와 답글들의 `createdAtMs` 중 가장 큰 값(펼침 인자 없이 — 답글이 아주 많은 스레드에서도 안전하다). */
function latestAtMs(replies: readonly Message[], floor: number): number {
  let latest = floor;
  for (const reply of replies) if (reply.createdAtMs > latest) latest = reply.createdAtMs;
  return latest;
}

/** 이 화면이 든 메시지에서 루트별 답글을 모은다(키는 소문자 루트 id). 목록이 루트마다 훑지 않고 한 번에 색인한다. */
export function groupRepliesByRoot(messages: readonly Message[]): Map<string, Message[]> {
  const byRoot = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.rootId === undefined) continue;
    const key = message.rootId.toLowerCase();
    const held = byRoot.get(key);
    if (held) held.push(message);
    else byRoot.set(key, [message]);
  }
  return byRoot;
}

/**
 * 루트 아래 요약 줄이 그릴 값 — 웹·데스크탑 타임라인이 부른다. (폰 `rollupFor`는 아직 자기 식으로 센다: 서버 수와 로컬 수의 `max`이고
 * 요청 묶음의 승인 카드 같은 text 아닌 답글도 센다. 합치려면 그 카드를 세는지부터 정해야 한다 — #5008 후속.)
 *
 * 서버가 기록 페이지에서 준 요약(`message.thread`)은 **페이지를 읽은 때의 스냅샷**이다. 그 뒤 실시간으로 들어온 답글은 스냅샷의
 * 머리(`lastReplySeq`)보다 큰 seq를 갖고, 이 함수가 그것을 든 답글(`replies` — 이 루트의 것만)에서 세어 **스냅샷 위에** 얹는다:
 *
 *   * 답글 수: 서버 수 + 머리 뒤 답글 수. (로컬로 센 수와 `max` 를 취하지 않는다 — 열어 보지 않은 스레드는 든 답글이 일부라
 *     서버가 5개인데 새 답글 하나를 `max(5, 1)` 로 두면 수가 영영 안 오른다.)
 *   * 얼굴: 새 답글의 저자가 가장 최근 먼저 앞에 서고 서버가 준 얼굴이 뒤를 잇는다(최대 3). 내 답글도 내 얼굴로 선다(서버
 *     `participant_ids` 도 저자를 넣는다). 서버가 얼굴을 안 주는 옛 서버(`participant_ids` 없음)는 얼굴을 지어내지 않는다.
 *   * 안 읽은 수: `withLiveUnread`(내 답글·지운 답글·text 아닌 줄은 안 센다). 값이 없으면(따라가지 않는 스레드) 없는 채다.
 *
 * 프레임마다 +1 이 아니라 **든 배열에서 파생**하므로 되쏘기·재구독 복구가 같은 답글을 두 번 배달해도 같은 답이다. 서버 요약이
 * 없는 루트(방금 달린 첫 답글)는 빈 스냅샷 위에 얹는다 — 개수와 얼굴은 서고, 따라가는지 모르니 안 읽은 수는 말하지 않는다.
 * 답글은 요약을 갖지 않는다(스레드는 한 단계다).
 */
export function liveThreadRollup(
  root: Message,
  replies: readonly Message[],
  myMemberId?: string
): ThreadRollup | null {
  if (root.rootId !== undefined) return null;
  const server = threadRollup(root);
  // 든 답글이 없는 루트(목록 대부분의 행)는 서버 값 그대로다 — 행마다 집합·배열을 만들지 않는다.
  if (replies.length === 0) return server;
  const fresh = repliesBeyond(replies, server === null ? 0 : server.lastReplySeq);

  if (server === null) {
    if (fresh.length === 0) return null;
    const participantIds = mergeFaces(fresh, []);
    return {
      replyCount: fresh.length,
      lastReplySeq: fresh[fresh.length - 1].seq,
      lastReplyAtMs: latestAtMs(fresh, 0),
      participantIds,
      participantCount: participantIds.length,
    };
  }

  const withUnread = myMemberId === undefined ? server : withLiveUnread(server, replies, myMemberId);
  if (fresh.length === 0) return withUnread;
  // 옛 서버(`participant_ids` 키 없음)는 얼굴을 모른다 — 새 답글의 저자만 세우면 새로 고침 때 얼굴이 사라진다.
  const participantIds = Array.isArray(root.thread?.participant_ids)
    ? mergeFaces(fresh, server.participantIds ?? [])
    : [];
  return {
    ...withUnread,
    replyCount: server.replyCount + fresh.length,
    lastReplySeq: Math.max(server.lastReplySeq, fresh[fresh.length - 1].seq),
    lastReplyAtMs: latestAtMs(fresh, server.lastReplyAtMs),
    participantIds,
    participantCount: Math.max(server.participantCount ?? 0, participantIds.length),
  };
}

/** 이 화면이 든 답글(지운 줄 포함 — 지웠다는 표시도 본 것이다) 중 가장 큰 seq. 답글이 없으면 `null`. */
export function readSignalSeq(replies: readonly Message[]): number | null {
  let head: number | null = null;
  for (const reply of replies) {
    if (head === null || reply.seq > head) head = reply.seq;
  }
  return head;
}

/**
 * 읽음 신호의 응답을 **든 루트**의 요약에 반영한다 — 요약을 읽는 길(`threadRollup(message)`)이 하나로 남게,
 * 루트의 `thread` 자체를 고친다.
 *
 *   * 따라가는 스레드면 `unread_reply_count`를 서버가 준 효과값으로 맞춘다(0이면 칩이 사라진다).
 *   * 따라가지 않는 스레드(`following: false`)면 값을 **지운다** — 값이 없는 것이 「말하지 않음」이다.
 *   * 비교 머리 `last_reply_seq`는 든 답글의 최대 seq까지만 **앞으로** 옮긴다(`withLiveUnread`가 그 뒤에 온
 *     답글만 세게). 뒤로 가거나 모르는 답글을 가리키지 않는다.
 *   * 머리가 지나간 답글은 스냅샷에 **접힌다**(#5008): 답글 수·얼굴·마지막 시각에 먼저 얹고 나서 머리를 옮긴다. 안
 *     그러면 `liveThreadRollup`이 머리 뒤만 얹으므로, 읽음 신호로 머리가 옮겨 간 순간 방금 올랐던 답글 수가 서버의
 *     옛 값으로 되돌아간다.
 *
 * 루트가 없거나(창 밖), 답글이 루트로 오거나, 요약이 없으면 상태를 그대로 돌려준다. 바뀐 것이 없으면 같은
 * 참조를 돌려줘 불필요한 재그림이 없다.
 */
export function applyThreadReadState(
  state: TimelineState,
  rootId: string,
  read: ThreadReadState
): TimelineState {
  const index = state.messages.findIndex((message) => uuidEq(message.id, rootId));
  if (index === -1) return state;
  const root = state.messages[index];
  const thread = root.thread;
  if (root.rootId !== undefined || !thread || !thread.reply_count) return state;

  const held = state.messages.filter(
    (message) => message.rootId !== undefined && uuidEq(message.rootId, rootId)
  );
  const head = readSignalSeq(held);
  const lastReplySeq = head === null ? thread.last_reply_seq : Math.max(thread.last_reply_seq, head);

  const next: NonNullable<Message["thread"]> = { ...thread, last_reply_seq: lastReplySeq };
  // 머리는 든 답글의 최대 seq까지 가므로, 옛 머리 뒤의 든 답글은 전부 이 신호로 접힌다.
  const folded = repliesBeyond(held, thread.last_reply_seq);
  if (folded.length > 0) {
    next.reply_count = thread.reply_count + folded.length;
    next.last_reply_at = latestAtMs(folded, thread.last_reply_at);
    // 옛 서버(`participant_ids` 키 없음)는 얼굴을 모른다 — 만들지 않는다(`liveThreadRollup`과 같은 규칙).
    if (Array.isArray(thread.participant_ids)) {
      next.participant_ids = mergeFaces(folded, thread.participant_ids);
      next.participant_count = Math.max(thread.participant_count ?? 0, next.participant_ids.length);
    }
  }
  if (!read.following) delete next.unread_reply_count;
  else if (read.unreadReplyCount !== undefined) next.unread_reply_count = read.unreadReplyCount;

  if (
    next.last_reply_seq === thread.last_reply_seq &&
    next.unread_reply_count === thread.unread_reply_count
  ) {
    return state;
  }
  const messages = state.messages.slice();
  messages[index] = { ...root, thread: next };
  return { ...state, messages };
}
