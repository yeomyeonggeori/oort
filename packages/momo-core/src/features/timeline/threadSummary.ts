import { uuidEq, type Message, type ThreadReadState, type ThreadRollup } from "../../lib/api";
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
    if (reply.state === "deleted") continue;
    if (reply.type !== "text") continue;
    if (uuidEq(reply.authorMemberId, myMemberId)) continue;
    beyond += 1;
  }
  return beyond === 0 ? rollup : { ...rollup, unreadReplyCount: base + beyond };
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
