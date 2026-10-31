import type {
  Channel,
  Message,
  MessageAttachment,
  RequestRouting,
  RosterMember,
} from "../../lib/api";
import { threadRollup, uuidEq } from "../../lib/api";
import type { DmGroupFacts } from "../workspace/directory";

// =============================================================================
// Timeline ordering model (pure). `seq` is the ONLY ordering authority, never
// arrival time, never createdAtMs. Both REST history (descending pages) and
// realtime publications (best-effort, possibly out of order or duplicated) are
// folded into one strictly-ascending-by-seq array, deduped by seq.
//
// This module is shared by the UI (Timeline.tsx) and the seq gate
// (gates/gate-seq.mjs re-implements the identical fold in JS and asserts the
// invariant), so the gate proves the same ordering the user sees.
//
// R-1 §3 adds the render-side derivation on top of that fold: author grouping,
// day separators, the unread boundary, and the reconnect recovery marker. All
// of it is pure and keyed by seq, so tests assert it without mounting a DOM.
// =============================================================================

export interface TimelineState {
  /** Strictly ascending by seq, deduped. Oldest first (render top→bottom). */
  messages: Message[];
  /** Smallest seq loaded, pass as `before` for older history. */
  oldestSeq: number | null;
  /** Largest seq loaded, pass as `after` for realtime-gap backfill. */
  newestSeq: number | null;
}

export function emptyTimeline(): TimelineState {
  return { messages: [], oldestSeq: null, newestSeq: null };
}

// ---- empty surface copy (R-1 §3 빈 상태) ------------------------------------
//
// A channel and a DM are empty for different reasons, so they cannot share one
// line of copy. What they DO share is the first act, and that is what this
// section got wrong until #1536.
//
// 온보딩 실측 F5 (`docs/planning/research/2026-08-18-onboarding-first-success-benchmark.md`):
// 첫 로그인 직후 채널 2개 · 메시지 0 · 에이전트 0인 화면에서 채널 분기가 내놓는
// 유일한 행동이 `멤버 초대하기`였다. 첫 성공 경로의 마지막 마디에서 사람을 첫
// 메시지가 아니라 초대 다이얼로그로 보낸 것이다. `첫 메시지 쓰기`는 DM 분기에만
// 있었는데, 정작 **두 표면의 첫 행동은 같은 act**다: 아래 컴포저에 쓰는 것.
//
// 그래서 첫 행동은 이제 양쪽 다 쓰기이고, 멤버 추가는 지워지지 않고 **뒤로
// 물러난다.** 지우지 않는 이유는 취향이 아니라 이 클라의 사정이다: 빈 채널이
// 「채널에 멤버 추가」로 가는 **유일한 문**이다(`clients/web/src/app/AppShell.tsx`:
// "빈 채널의 멤버 추가 진입점이 이 하나를 열고, 헤더 메뉴가 생기면 그것도 같은
// 하나를 연다" — 그 헤더 메뉴는 아직 없다). 유일한 문을 지우는 것은 마찰 하나를 없애자고
// 기능 하나를 없애는 일이다.
//
// A 1:1 DM still gets exactly one action: the server fixes the participant pair
// by dmKey (openapi `openDm`), so offering 사람 추가 there would be an action the
// product does not have.
//
// 라벨이 여기 사는 이유: 같은 문장을 두 클라가 그리고, 게이트가 그 문장을 이
// 파일에서 읽어 자기 판정에 쓴다(`clients/web/gates/gate-composer.mjs` 11절 —
// 게이트가 문장을 손으로 베끼면 화면이 고쳐질 때 게이트가 그것을 막는 쪽이 된다).
//
// 이 버튼의 이름이 「추가」인 이유 (#1573, 한 동사=한 행위): 이 문이 여는 방이
// 「멤버 추가」 다이얼로그다(제목 「멤버 추가」, 행 버튼 「추가」 —
// `AddChannelMemberDialog.tsx`). 문이 방과 다른 동사를 달면, 혼자 있는 첫
// 사용자가 이 버튼(당시 「멤버 초대하기」)을 누르고 "다른 멤버가 없습니다" 화면에서
// **같은 이름의 다른 버튼**(워크스페이스 초대 → /settings)을 만난다 — F5 온보딩
// 상태에서 재현 보장(PR #1568 design-review Medium 2). 「초대」는 워크스페이스에
// 새 사람을 부르는 행위의 낱말로 예약한다(`DirectoryRoute` · 다이얼로그의
// 빈-워크스페이스 상태, 둘 다 /settings의 초대 링크 생성기로 간다).

/** 빈 대화가 내놓는 첫 행동의 이름. 정본은 이 두 상수다. */
export const EMPTY_WRITE_ACTION_LABEL = "첫 메시지 쓰기";
export const EMPTY_ADD_MEMBER_ACTION_LABEL = "멤버 추가하기";
/** 에이전트가 한 명도 없는 빈 채널의 세 번째 손잡이(#3697). 관리자에게만 선다. */
export const EMPTY_CONNECT_AGENT_ACTION_LABEL = "에이전트 연결";

export interface EmptyChannelAction {
  /** 무엇을 하는 손잡이인가. 표면은 이 값으로 자기 핸들러를 고른다. */
  kind: "write" | "add-member" | "connect-agent";
  label: string;
}

export interface EmptyChannelCopy {
  /** 무엇의 빈 상태인가. 웹의 `data-empty-kind`가 그대로 이 값이다. */
  surface: "channel" | "dm";
  headline: string;
  detail: string;
  /** 첫 행동. 채널이든 DM이든 같은 act다 — 아래 컴포저에 쓰는 것. */
  primary: EmptyChannelAction;
  /** 그다음 행동. 멤버를 더 받을 수 있는 표면(=채널)만 갖는다. */
  secondary: EmptyChannelAction | null;
}

const WRITE_ACTION: EmptyChannelAction = {
  kind: "write",
  label: EMPTY_WRITE_ACTION_LABEL,
};

const ADD_MEMBER_ACTION: EmptyChannelAction = {
  kind: "add-member",
  label: EMPTY_ADD_MEMBER_ACTION_LABEL,
};

/** 참여자가 정확히 둘인 DM의 안내. 셋 이상(`DmGroupFacts`)에는 쓰지 않는다. */
const DM_DETAIL = "여기 쓴 메시지는 둘만 봅니다. 참여자는 이 둘로 고정됩니다.";

/**
 * 셋 이상 DM의 안내(#4912, ADR-0217). 「둘만」·「고정」은 이 대화에서 사실이 아니다: 모든 사람의 허락으로 에이전트가
 * 들어와 있고 사람 누구나 내보낼 수 있다. 말하는 것은 둘이다. 이 대화에 있는 참여자 수(에이전트 포함, 머리의 「· N명」과
 * 같은 수)와, 에이전트가 있을 때 그 읽기 범위(착석 뒤에 쓴 글, D5). 에이전트가 있는지는 명부로 **아는 때만** 말한다.
 * 같은 블록의 「이 대화의 시작입니다.」·두 사람 DM 문장과 같은 합쇼체다.
 */
function groupDmDetail(group: DmGroupFacts): string {
  const sees = `여기 쓴 메시지는 이 대화에 있는 ${group.count}명이 함께 봅니다.`;
  return group.agentCount > 0
    ? `${sees} 에이전트는 이 대화에 들어온 뒤에 쓴 글만 봅니다.`
    : sees;
}

/**
 * `group`은 DM 참여자가 셋 이상일 때만 채운다(`dmGroupFacts`). `peer === null`은 「그룹」일 수도 「명부 대기」일 수도 있어서
 * 상대 한 명으로는 이 둘을 가를 수 없다. 생략하거나 둘 이하면 지금까지의 두 사람 DM 문장이다.
 */
export function emptyChannelCopy(
  kind: Channel["kind"] | null | undefined,
  peer: Pick<RosterMember, "displayName" | "kind"> | null,
  group?: DmGroupFacts | null
): EmptyChannelCopy {
  if (kind !== "dm") {
    // R-1 §3 asked for [사람 추가] and [에이전트 추가] as equal buttons, to say
    // that adding an agent is not the lesser path. Two buttons on one handler
    // said it twice and did it once, and this client has no agent-creation
    // surface to send the second one to, so the equality stayed in the copy.
    //
    // 그 문장이 이제 detail의 절반을 진다. 나머지 절반은 혼자 있는 사람이 실제로
    // 망설이는 지점에 답한다: **나 혼자인데 지금 써도 되나.** 답은 된다이고, 그
    // 근거는 서버에 있다 — 채널 히스토리 질의에 가입 시각 절이 없어서
    // (`server-rust/crates/momo-messaging/src/message.rs` `list_messages` /
    // `list_channel_page`: `WHERE channel_id = $1 AND deleted_at IS NULL`)
    // 나중에 들어온 멤버도 오늘 쓴 줄을 그대로 읽는다.
    return {
      surface: "channel",
      headline: "이 채널을 첫 메시지로 시작하세요.",
      detail:
        "지금 쓴 메시지는 나중에 들어올 사람과 에이전트도 같은 자격으로 읽습니다.",
      primary: WRITE_ACTION,
      secondary: ADD_MEMBER_ACTION,
    };
  }
  const detail = group && group.count > 2 ? groupDmDetail(group) : DM_DETAIL;
  if (!peer) {
    // 상대를 못 고른 DM: 명부를 아직 못 받았거나(이름을 지어내지 않는다) 셋 이상 그룹이다(`group`이 문구를 가른다).
    return {
      surface: "dm",
      headline: "다이렉트 메시지를 시작하세요.",
      detail,
      primary: WRITE_ACTION,
      secondary: null,
    };
  }
  return {
    surface: "dm",
    headline:
      peer.kind === "agent"
        ? `${peer.displayName}님에게 첫 일을 맡겨보세요.`
        : `${peer.displayName}님과의 대화를 시작하세요.`,
    detail,
    primary: WRITE_ACTION,
    secondary: null,
  };
}

/** Binary-search insertion index for `seq` in an ascending array. */
function lowerBound(messages: Message[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 같은 seq 의 옛 행 위로 새 행이 덮일 때, 새 행이 **말하지 않은** 읽기 장식을 옛 행에서
 * 잇는다 (#4441 첨부, #4450 롤업·인용·run 종결).
 *
 * ## 무엇을 말하지 않는가 — 서버 소스가 정한 허용목록 넷
 *
 * 편집이 내는 두 투영 — `message.edited` 프레임(`build_message_edited_payload`)과 `PATCH`
 * 응답(`routes/messages.rs` `edit` → `message_dto`) — 은 **행**을 다시 투영할 뿐 그 둘레의
 * 읽기 장식을 다시 만들지 않는다. 서버 주석: 「An edit re-projects the row, not the
 * conversation around it」. `MessageDto.run_ended` 주석은 이 넷을 한 부류로 묶는다: 「a
 * projection beside the message — the same shape `thread`, `replyTo` and `attachments`
 * already take, for the same reason: a reader needs it, the row does not own it」.
 *
 *   칸           message.edited 프레임      PATCH 응답           서버가 싣지 않는 이유
 *   attachments  키 없음                    `&[]` (키 생략)      편집은 묶인 첨부를 바꾸지 못한다
 *   thread       키 없음                    `None`               롤업은 읽을 때 붙는다(`PagedMessage`)
 *   replyTo      `reply_to_id` 만           `None`               「a rendered quote inside it would
 *                                                                be the snapshot 규칙 3 forbids」
 *   runEnded     키 없음                    `false` (키 생략)    페이지 읽기에만 실린다(#1166)
 *
 * 프레임이 싣는 나머지 — id·channel_id·seq·hlc_*·author_member_id·type·state·body·props·
 * root_id·reply_to_id·created_at_ms·edited_at_ms·deleted_at_ms — 는 프레임이 **직접 말한다**.
 * 말한 칸은 비어 있어도(`body: null`, `props: {}`) 프레임의 말이 이긴다. 그래서 이 규칙은
 * 「들어온 값이 undefined 면 든 것을 유지」가 아니라 위 넷만 고르는 허용목록이다. 일반 규칙으로
 * 쓰면 본문을 비우는 갱신(props 만 바꾼 `message.edited`)이 본문을 되살린다.
 *
 * 덮어쓰기가 그 침묵을 삭제로 읽어서, 첨부(#4441)는 사진 카드가, 롤업(#4450)은 루트 밑의
 * 「답글 N개」가, 풀린 인용은 인용 블록이 — 원본이 화면 창 밖이면 「불러오지 못함」으로 —
 * 고친 사람과 그 줄을 열어 둔 모든 화면에서 사라졌다(새로 고침하면 돌아온다 — 기록 페이지는
 * 넷을 싣는다).
 *
 * ## 칸마다 「말했다」의 뜻 — 들어온 행이 말하면 그 말이 이긴다. 합치지 않는다.
 * - attachments: 한 건 이상. 키가 없거나 빈 배열이면 침묵이다(서버는 빈 배열의 키를 뺀다).
 * - thread: `threadRollup(incoming) !== null`. 화면이 롤업을 읽는 그 함수와 같은 판정이라
 *   `reply_count` 가 0 인 롤업은 「답글 없음」이지 말한 것이 아니다. 서버는 `reply_count > 0`
 *   일 때만 싣는다. 서버에는 롤업을 줄이는 길도 없어서(`thread.reply_count` 는 +1 만 한다)
 *   기록 페이지가 침묵하는데 든 롤업이 남는 경로가 없다.
 * - replyTo: 있으면 말한 것이다. 침묵일 때 옛 행의 풀린 인용은 **이 행이 지금 가리키는 원본의
 *   것일 때만**(`replyToId`) 잇는다. 한 메시지의 인용 대상은 바뀌지 않으니 서버가 못 만드는
 *   입력이지만, 보존이 「든 것이 있으면 붙인다」가 아니라 「이 행이 가리키는 그 원본」임을 못 박는다.
 * - runEnded: `true`. 서버는 `true` 일 때만 싣는다. 끝난 run 은 다시 열리지 않는다. 화면은 이
 *   플래그를 행에서 다시 읽지 않고 도착 때 `endedStreamRunIds` 가 거두어 종결 기록에 심은 것을
 *   읽는다 — 그래도 허용목록을 서버의 「읽기 장식」 부류와 같게 두려고 잇는다.
 *
 * ## 편집이 아닌 투영에도 같다 — 일부러
 * 「편집인지」를 `state`·`editedAtMs` 로 가리지 않는다. 스트림 조각과 props 만 바꾼 갱신도 같은
 * `message.edited` 이고(프레임은 행의 현재 값을 그대로 싣는다 — 고친 적 없는 행이면 `state` 는
 * `sent`, `edited_at_ms` 는 null), `message.new`·전송 응답도 `replyTo` 와 롤업을 싣지 않는다
 * (ADR-0148, `MessageDto` 주석). 기록으로 읽은 줄 위에 같은 줄의 라이브 프레임이 겹쳐 와도(되쏘기·
 * 재구독) 같은 침묵이다.
 *
 * ## 묘비와 다른 메시지
 * - 묘비는 장식을 주고받지 않는다. 들어온 행이 묘비면 옛 장식을 잇지 않고, 든 행이 묘비면 그
 *   장식을 새 행에 잇지 않는다. 실시간 묘비(`applyTombstone`)와 기록 페이지의 묘비는 장식을 그대로
 *   들 수 있다(화면은 `deleted` 에서 그리지 않는다). 늦게 온 편집 프레임이 그것을 되살리면 안 된다.
 *   이 함수가 바꾸는 것은 「편집 투영의 침묵」 하나뿐이고, 묘비가 낀 길의 동작은 수리 전과 같다.
 *   (편집 프레임·PATCH 응답이 지나는 문 {@link applyEditedMessage} 는 한 걸음 더 간다 — 든 줄이
 *   묘비면 그 편집을 아예 받지 않는다. 그 가드는 이 병합이 아니라 그 문에만 있다.)
 * - seq 가 같아도 id 가 다르면 다른 메시지다. 물려받지 않는다.
 *
 * 이 규칙은 서버에 **살아 있는 메시지에서 이 넷을 떼는 길이 없다**는 사실에 서 있다(첨부 라우트는
 * uploads·complete·content 셋뿐이고, 삭제도 첨부 행은 건드리지 않으며, 롤업은 늘기만 하고, 인용
 * 대상은 불변이다). 그런 길이 생기면 「말하지 않음」과 「없어짐」을 가를 명시 신호가 필요하다.
 */
function keepHeldProjection(held: Message, incoming: Message): Message {
  if (incoming.state === "deleted" || held.state === "deleted") return incoming;
  if (!uuidEq(held.id, incoming.id)) return incoming;

  const kept: Partial<Message> = {};

  // `?.length ?? 0`·`!heldFiles`: 타입 밖 입력(null)에도 던지지 않는다. 모든 실시간
  // 프레임이 지나는 리듀서에 이 수리가 새 던질 자리를 만들지 않으려는 방어다.
  const heldFiles = held.attachments;
  if ((incoming.attachments?.length ?? 0) === 0 && heldFiles && heldFiles.length > 0) {
    kept.attachments = heldFiles;
  }
  if (threadRollup(incoming) === null && threadRollup(held) !== null) {
    kept.thread = held.thread;
  }
  const heldQuote = held.replyTo;
  if (
    !incoming.replyTo &&
    heldQuote &&
    incoming.replyToId !== undefined &&
    uuidEq(heldQuote.id, incoming.replyToId)
  ) {
    kept.replyTo = heldQuote;
  }
  if (incoming.runEnded !== true && held.runEnded === true) {
    kept.runEnded = true;
  }

  return Object.keys(kept).length === 0 ? incoming : { ...incoming, ...kept };
}

/**
 * Merge a batch (any order, may overlap existing) into ascending-by-seq order.
 * Last write wins per seq (realtime edits/tombstones replace history rows) —
 * except the four read decorations a projection may not carry: attachments,
 * thread rollup, resolved quote, run-ended ({@link keepHeldProjection}).
 *
 * This is the **upsert**: a row that is not held is inserted wherever its seq
 * falls. History pages, `?after` backfill, `message.new` and own-send echoes need
 * exactly that. An edit projection must not — it goes through
 * {@link applyEditedMessage}.
 *
 * Canonical name per R-1 §공통계약: history pages, realtime publications and
 * `?after` backfill all land here, so a reconnect reconciles by seq instead of
 * appending blindly.
 */
export function reconcileMessages(
  state: TimelineState,
  batch: Message[]
): TimelineState {
  if (batch.length === 0) return state;
  const next = state.messages.slice();
  for (const msg of batch) {
    const idx = lowerBound(next, msg.seq);
    if (idx < next.length && next[idx].seq === msg.seq) {
      // replace duplicate seq (edit/tombstone/re-fetch)
      next[idx] = keepHeldProjection(next[idx], msg);
    } else {
      next.splice(idx, 0, msg);
    }
  }
  return {
    messages: next,
    oldestSeq: next.length ? next[0].seq : null,
    newestSeq: next.length ? next[next.length - 1].seq : null,
  };
}

/** Live-append alias of {@link reconcileMessages} (R-1 §공통계약 vocabulary). */
export const mergeMessages = reconcileMessages;

/**
 * 편집 투영(`message.edited` 프레임·`PATCH` 응답)을 **이미 든 줄에만** 적용한다 (#4450).
 *
 * 편집은 줄을 다시 투영할 뿐 줄을 만들지 않는다. 그런데 `reconcileMessages` 는 seq 로 접는
 * 합류라서 없는 줄을 그 seq 자리에 끼워 넣는다. 서버는 이 클라가 들지 않은 줄의 편집도 알린다 —
 * 다른 기기의 승인 결정이 오래된 카드를 갈아 끼우고(#3771), 제어 창이 열리면 옛 로그인 카드의
 * props 를 갈아 끼우고(`emit_message_edited_in_tx`), 누군가 어제 쓴 글을 고친다. 그때 피해는 한
 * 줄이 아니라 **커서**다.
 * - 든 창보다 오래된 줄이 맨 위에 끼면 `oldestSeq` 가 내려가고, 「위로 더 읽기」(`before:
 *   oldestSeq`)가 그 사이 기록을 영영 건너뛴다.
 * - 든 창보다 새로운 줄이 끼면 `newestSeq`(꼬리 되읽기의 `after`)가 앞서가 그 앞을 건너뛴다.
 * - 끼어든 줄은 첨부·롤업·인용이 없는 반쪽이다. 편집 투영은 그것들을 싣지 않는다.
 *
 * 못 찾으면 **같은 state** 를 돌려준다(`applyTombstone` 과 같다 — 렌더가 없다). 버려도 잃는 것이
 * 없다: 그 줄이 창에 들어오는 길은 위로 더 읽기·꼬리 되읽기·`message.new` 이고, 앞의 둘은 기록
 * 페이지라 완전한 투영(첨부·롤업·인용)을 싣고 오며, `message.new` 는 막 만들어진 줄이다.
 *
 * 「든 줄」은 seq 와 id 가 **둘 다** 같은 줄이다. 다른 방의 같은 seq 가 든 줄을 덮으면 안 된다.
 * 편집인지는 줄의 모양(`state`·`editedAtMs`)으로 가릴 수 없다 — 고친 적 있는 오래된 줄도 기록
 * 페이지에는 그 표지를 달고 오고, 그 줄은 들어와야 한다. 그래서 가드는 `reconcileMessages` 가
 * 아니라 편집 투영만 지나는 이 문에 있다. 든 줄에 대한 적용은 `reconcileMessages` 그대로라
 * 보존 규칙({@link keepHeldProjection})이 같이 선다.
 *
 * ## 든 줄이 묘비면 묘비가 이긴다 (planner 결정, #4450)
 * 든 줄이 이미 지워졌다면(`state: "deleted"`) 늦게 온 편집은 무시한다 — 같은 state 를 돌려준다.
 * 서버는 지운 메시지를 사람이 고치게 두지 않는다: `PATCH` 는 `EditDeleted`(400)로 거절하고 스트림
 * 조각의 쓰기도 같은 가드를 지난다(`edit_message_in_tx`·`stream_message_body_in_tx`). 그러니
 * 「지운 뒤에 고친」 순서는 서버에 없고, 묘비 위에 편집 프레임이 도착한다면 재생·되쏘기 순서가
 * 어긋나 지우기 전의 프레임이 늦게 온 것이다. 그것이 마지막 쓰기 우선으로 본문을 되살리면 사람이
 * 지운 글이 화면에 다시 서는데, 무시해서 잃는 것은 없다 — 지운 줄은 그려지지 않는다. (서버가 스스로
 * 다시 쓴 카드를 알리는 props 프레임 `emit_message_edited_in_tx` 는 지워진 행도 현재 모양, 곧
 * `state: "deleted"` 로 싣는다. 든 줄이 이미 묘비라면 그것도 같은 말이다.)
 * 이 규칙도 편집 문에만 있다. `reconcileMessages`(기록 페이지·`message.new`·꼬리 되읽기)는 여전히
 * seq 로 접는 마지막 쓰기 우선이고, 묘비가 낀 그 길의 동작은 수리 전과 같다.
 */
export function applyEditedMessage(
  state: TimelineState,
  edited: Message
): TimelineState {
  const held = state.messages[lowerBound(state.messages, edited.seq)];
  if (held === undefined || held.seq !== edited.seq) return state;
  if (!uuidEq(held.id, edited.id)) return state;
  if (held.state === "deleted") return state;
  return reconcileMessages(state, [edited]);
}

/**
 * Mark one message as deleted **in place** (B11).
 *
 * Keyed by id, not by seq, because the id is all a `message.deleted` frame
 * carries — and it carries only that on purpose: a tombstone that re-broadcast
 * its body would put the erased text back on every connected client.
 *
 * The row stays in the array and keeps its seq. Removing it is the tempting
 * shortcut and the wrong one: `seq` is both the ordering authority and the
 * recovery cursor, so a message that vanishes leaves a gap indistinguishable
 * from one this client failed to receive, and the next reconnect would set out
 * to heal it.
 *
 * Returns the same state when nothing matched, so a tombstone for a message this
 * client never loaded costs no render.
 */
export function applyTombstone(
  state: TimelineState,
  messageId: string,
  deletedAtMs?: number
): TimelineState {
  const idx = state.messages.findIndex((msg) => uuidEq(msg.id, messageId));
  if (idx === -1) return state;
  const existing = state.messages[idx];
  if (existing.state === "deleted") return state;
  const next = state.messages.slice();
  next[idx] = {
    ...existing,
    state: "deleted",
    body: undefined,
    deletedAtMs: deletedAtMs ?? existing.deletedAtMs ?? Date.now(),
  };
  return { ...state, messages: next };
}

// ---- message action affordances (B11) --------------------------------------
//
// The server is the authority: it answers 403 to anyone but the author and 400
// on a tombstone. These predicates decide only what to *show*, and they are
// deliberately separate from the requests — an action that is visible but always
// fails teaches people to distrust the UI, and one that is hidden where the
// server would have allowed it is a feature nobody finds.

/**
 * A deleted or failed message is nobody's to act on, its author's included.
 * `failed` is a client-side state for a send that never landed, so there is no
 * server row behind it to edit.
 */
function isActionable(message: Message): boolean {
  return message.state !== "deleted" && message.state !== "failed";
}

/**
 * Only the author, and only while the message is live. Mirrors the server's
 * "only the message author may edit": an admin cannot rewrite what someone else
 * said, because a permission model that allowed it would make every quoted
 * message deniable.
 */
export function canEditMessage(
  message: Message,
  myMemberId: string | undefined
): boolean {
  if (!isActionable(message)) return false;
  // Only plain text has an editable body. A tool result or an artifact card is
  // a projection of something else, so "editing" it would edit nothing.
  if (message.type !== "text") return false;
  return uuidEq(message.authorMemberId, myMemberId);
}

/** The same authority as {@link canEditMessage}, without the text-only rule. */
export function canDeleteMessage(
  message: Message,
  myMemberId: string | undefined
): boolean {
  if (!isActionable(message)) return false;
  return uuidEq(message.authorMemberId, myMemberId);
}

/**
 * Anyone in the channel may react to a live message — no authorship gate, and no
 * agent branch: an agent member is reacted to exactly like a person.
 */
export function canReactToMessage(message: Message): boolean {
  return isActionable(message);
}

/**
 * Replies hang off a **root**, and momo threads are one level deep (Slack's
 * model): the server refuses a `rootId` that is itself a reply with "thread root
 * must be a top-level message". Offering 답글 on a reply would be an action that
 * always fails.
 */
export function canReplyToMessage(message: Message): boolean {
  return isActionable(message) && !message.rootId;
}

/**
 * 이슈 #1112 — anyone in the channel may pin a live message, and anyone may
 * unpin one. There is no authorship gate here at all: a pin is the channel's
 * fact rather than the pinner's, so tying "고정 해제" to whoever pressed 고정
 * would strand every pin whose author left the workspace.
 *
 * A tombstone is not pinnable (the server refuses with 400) and, since the
 * delete already swept the row, is never unpinnable either — so the single
 * `isActionable` gate is the whole rule.
 */
export function canPinMessage(message: Message): boolean {
  return isActionable(message);
}

/**
 * ADR-0175 — 나중에 알림. Anyone may remind themselves of a live message.
 * A tombstone or a failed send has no server row to hang a reminder on.
 */
export function canRemindMessage(message: Message): boolean {
  return isActionable(message);
}

/** ADR-0178. A live row with a seq. Tombstones and failed sends have none to mark from. */
export function canMarkUnreadMessage(message: Message): boolean {
  return isActionable(message);
}

/** What a row may offer, all six answers together. */
export interface MessageActionAvailability {
  reply: boolean;
  /**
   * ADR-0148 — 인용. `reply`와 **다른 축**이다: 스레드는 대화를 옆으로 치우고
   * 인용은 본류에 두면서 맥락만 끌어온다. 그래서 답글이 불가능한 행(이미 답글인
   * 행)도 인용은 가능하고, 둘을 하나로 접으면 ADR이 나눈 두 장치가 UI에서 다시
   * 합쳐진다. 판정은 `features/timeline/quote.ts` `canQuoteMessage`.
   */
  quote: boolean;
  react: boolean;
  /** 이슈 #1112 — 판정은 {@link canPinMessage}. */
  pin: boolean;
  /**
   * ADR-0175. Optional so a phone surface that has not consumed A-41 yet
   * still type-checks; missing is off.
   */
  remind?: boolean;
  /**
   * ADR-0178. Optional so a phone surface that has not consumed BT-6 yet
   * still type-checks; missing is off.
   */
  markUnread?: boolean;
  edit: boolean;
  delete: boolean;
}

/**
 * True when at least one action is on offer. A row with none gets no hover bar
 * and no long-press at all — an empty sheet is worse than no sheet, because it
 * costs the gesture and answers nothing.
 */
export function hasAnyAction(available: MessageActionAvailability): boolean {
  return (
    available.reply ||
    available.quote ||
    available.react ||
    available.pin ||
    available.remind === true ||
    available.markUnread === true ||
    available.edit ||
    available.delete
  );
}

/** True iff messages are strictly ascending by seq with no duplicates. */
export function isStrictlyOrdered(messages: Message[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].seq <= messages[i - 1].seq) return false;
  }
  return true;
}

// ---- render derivation (R-1 §3) --------------------------------------------

// -----------------------------------------------------------------------------
// 실기기 제약 (스파이크 #837 게이트 5, iPhone 17) — **타임라인에 `inverted` 를 쓰지
// 않는다.**
//
// 인버티드 리스트에서 읽던 중 새 메시지가 도착하면 읽던 위치가 46~91px 튀었다.
// 같은 데이터를 **정방향**으로 그리면 0px 이었다. 문제는 RN 의 가상화가 아니라
// 다른 채팅 클라에서 물려받은 `inverted` 전제였다(Mattermost 는 이걸 안고 가려고
// RN 코어 `RCTScrollViewComponentView.mm` 를 패치했다 — 우리는 그럴 필요가 없다).
//
// 아래 병합 규칙이 seq 오름차순을 정본으로 유지하는 이유이기도 하다: 뷰가 뒤집히지
// 않으므로 모델도 뒤집을 이유가 없다.
// -----------------------------------------------------------------------------

/** Author group window: a new header after 5 minutes of the same author. */
export const AUTHOR_GROUP_WINDOW_MS = 300_000;

/** The two fields grouping depends on; a pending row has them before it has a seq. */
export type GroupingRow = Pick<Message, "authorMemberId" | "createdAtMs">;

/** Local-day key, used for the day separator and to force a group break. */
export function dayKey(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * A message starts a new author group when the author changes, when more than
 * AUTHOR_GROUP_WINDOW_MS passed since the previous message, or across a day
 * boundary. Continuation rows drop the header for density (Slack convention).
 */
export function startsAuthorGroup(
  previous: GroupingRow | undefined,
  current: GroupingRow
): boolean {
  if (!previous) return true;
  if (!uuidEq(previous.authorMemberId, current.authorMemberId)) return true;
  if (current.createdAtMs - previous.createdAtMs > AUTHOR_GROUP_WINDOW_MS) {
    return true;
  }
  return dayKey(previous.createdAtMs) !== dayKey(current.createdAtMs);
}

// ---- 멈춘 에이전트 알림 접기 (goal P3 1-2) -----------------------------------
//
// 서버는 멈춘 에이전트를 부를 때마다 시스템 한 줄을 남긴다: `type: "system"`,
// `props.kind = "agent_paused"`, 그리고 그 줄을 부른 메시지의 id
// (MessageRoutes.swift `insertPausedMentionSystemLine` / mention.rs
// `paused_mention_props`). 1:1 DM에서는 사람이 쓰는 **모든** 메시지가 상대
// 에이전트를 부르므로, 다섯 번 말하면 똑같은 문장이 다섯 줄 쌓인다.
//
// 접는 것은 여기, 렌더 파생에서만 한다. 서버의 paused 경로도, `messages` 배열도
// 건드리지 않는다 — 배열에서 지우면 seq에 구멍이 생기고 그 구멍은 이 클라이언트가
// 받지 못한 것과 구별되지 않아 다음 재연결이 그것을 메우러 나선다(applyTombstone
// 주석과 같은 이유다).
//
// 없애는 것은 반복이지 정보가 아니다. 살아남는 줄은 **마지막** 것이라 사람이 방금
// 보낸 메시지 바로 밑에 앉고, 그래서 "왜 답이 없지"의 답은 언제나 가장 최근 질문
// 옆에 있다. 접힌 개수는 그 줄이 자기 옆에 적으므로 몇 번이 응답 없이 지나갔는지도
// 화면에 남는다.
//
// 접기를 멈추는 세 자리가 있고, 셋 다 "그 둘은 같은 말이 아니다"라는 한 가지
// 이유에서 나온다:
//   1. 사이에 그 에이전트가 **말했다** — 정지가 풀렸다가 다시 걸린 것이므로 뒤의
//      알림은 반복이 아니라 새 소식이다.
//   2. 두 알림을 부른 사람이 **다르다** — 채널에서 A와 B가 각각 멘션한 모양이다.
//      각 알림은 자기를 부른 멘션 옆에 남아야지, 남의 멘션 밑으로 끌려가면 안 된다.
//   3. 사이에 **날이 바뀌었다** — 접으면 알림이 다른 날짜 구분선 아래로 옮겨
//      앉는다. 타임라인이 이미 선을 그은 자리를 렌더 파생이 넘을 수는 없다.

/** 서버가 이 시스템 줄에 붙이는 표식 (Swift :1602 / mention.rs). */
export const PAUSED_NOTICE_KIND = "agent_paused";

function propString(
  props: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 이 행이 「에이전트 일시정지」 알림이면 그 에이전트의 member id, 아니면 null.
 *
 * `props.agent_member_id`가 정본이고 작성자는 대비책이다. 서버는 이 줄을 그
 * 에이전트 자신의 이름으로 쓰므로 둘은 같은 값이지만, 비교는 언제나 `uuidEq`가
 * 한다 — Swift는 UUID를 대문자로 내고 이 두 키만 소문자로 쓰기 때문에, 한 응답
 * 안에서도 대소문자가 갈린다.
 */
export function pausedNoticeAgentId(message: Message): string | null {
  if (message.type !== "system") return null;
  if (propString(message.props, "kind") !== PAUSED_NOTICE_KIND) return null;
  return propString(message.props, "agent_member_id") ?? message.authorMemberId;
}

/** 어떤 알림이 접혔고, 살아남은 알림이 몇 개를 대신하는가. */
export interface PausedNoticeFold {
  /** 접혀서 그려지지 않는 알림의 seq. */
  suppressed: Set<number>;
  /** 살아남은 알림의 seq → 그것이 대신하는 알림 수. 2 이상일 때만 들어 있다. */
  repeats: Map<number, number>;
}

export function emptyPausedNoticeFold(): PausedNoticeFold {
  return { suppressed: new Set(), repeats: new Map() };
}

/**
 * 알림을 부른 메시지의 작성자. 서버가 알림에 적어 둔 `source_message_id`가
 * 정본이고, 그 메시지가 아직 안 실린 페이지에 있으면 바로 윗행으로 물러선다
 * (서버는 멘션 바로 다음 seq에 알림을 쓴다).
 *
 * 못 찾으면 null이고, null은 "다른 사람"으로 친다 — 모르면 접지 않는 쪽이 안전한
 * 방향이다. 접기는 되돌릴 수 있지만 남의 멘션 밑으로 끌려간 알림은 오독이다.
 */
function noticeTriggerAuthor(
  notice: Message,
  previousRow: Message | undefined,
  bySourceId: Map<string, Message>
): string | null {
  const sourceId = propString(notice.props, "source_message_id");
  const source = sourceId ? bySourceId.get(sourceId.toLowerCase()) : undefined;
  if (source) return source.authorMemberId;
  return previousRow?.authorMemberId ?? null;
}

/**
 * 연속된 「일시정지」 알림을 마지막 하나로 접는다. 순수 함수이고, 입력 배열은
 * 그대로 둔다 — 접기는 {@link buildTimelineItems}가 그리는 순간에만 일어난다.
 */
export function foldPausedNotices(messages: Message[]): PausedNoticeFold {
  const fold = emptyPausedNoticeFold();
  if (messages.length === 0) return fold;

  const bySourceId = new Map<string, Message>();
  for (const message of messages) bySourceId.set(message.id.toLowerCase(), message);

  // 묶음을 먼저 **모으고**, 접는 것은 그다음이다. 세면서 접으면 "지금까지 몇
  // 개"가 진행 중인 묶음 안에 들어가야 하는데, 그 값이 다음 판단의 입력이 되는
  // 순간 읽기와 쓰기가 한 변수에서 만난다. 두 단계로 나누면 각 단계는 한 방향만
  // 본다: 위는 어디서 끊기는지만, 아래는 모인 것을 어떻게 그릴지만.
  const runs: Message[][] = [];
  let current: Message[] = [];
  /** 열린 묶음이 말하고 있는 에이전트와, 그를 부른 사람. */
  let runAgent: string | null = null;
  let runTrigger: string | null = null;
  let previousRow: Message | undefined;

  for (const message of messages) {
    const agentId = pausedNoticeAgentId(message);
    if (agentId === null) {
      // 그 에이전트가 말했다 → 정지가 풀렸던 것이므로 묶음을 끊는다 (①).
      if (runAgent !== null && uuidEq(message.authorMemberId, runAgent)) {
        runs.push(current);
        current = [];
        runAgent = null;
        runTrigger = null;
      }
      previousRow = message;
      continue;
    }

    const trigger = noticeTriggerAuthor(message, previousRow, bySourceId);
    const last = current[current.length - 1];
    const continues =
      last !== undefined &&
      runAgent !== null &&
      uuidEq(runAgent, agentId) &&
      runTrigger !== null &&
      trigger !== null &&
      uuidEq(runTrigger, trigger) && // ②
      dayKey(last.createdAtMs) === dayKey(message.createdAtMs); // ③

    if (!continues) {
      if (current.length > 0) runs.push(current);
      current = [];
      runAgent = agentId;
      runTrigger = trigger;
    }
    current.push(message);
    previousRow = message;
  }
  if (current.length > 0) runs.push(current);

  // 한 묶음에서 살아남는 것은 마지막 하나뿐이고, 그 하나가 묶음의 크기를 진다.
  // 혼자인 묶음은 접을 것이 없으므로 아무 표시도 남기지 않는다.
  for (const run of runs) {
    if (run.length < 2) continue;
    for (const notice of run.slice(0, -1)) fold.suppressed.add(notice.seq);
    fold.repeats.set(run[run.length - 1].seq, run.length);
  }
  return fold;
}

/**
 * A reconnect that healed a gap. `seq` is the newest seq confirmed present
 * after the heal, which is exactly what the marker states to the user: no
 * clock skew, no "since 5 seconds ago" guess (R-1 §3, momo 우위).
 */
export interface RecoveryMarker {
  /** Stable key, monotonic per session. */
  id: string;
  /** Newest seq confirmed present after the resubscribe healed the gap. */
  seq: number;
  /** Whether the transport replayed the gap, or REST `?after` backfill did. */
  source: "replay" | "backfill";
}

// ---- optimistic insert (M10, R-1 §3 "로컬 echo → seq 도착 시 reconcile") -----
//
// A message the user just sent has no seq yet: the server mints it inside the
// write transaction (REST -> PG -> outbox -> relay). Since seq is the ONLY
// ordering authority in this module, a local echo must never be given a fake
// one. Pending rows therefore live OUTSIDE the seq array, as a tail overlay
// appended after the confirmed stream, and the confirmed array keeps its
// strictly-ascending-by-seq invariant untouched (the seq gate re-implements
// that fold and would catch any violation).
//
// Settlement, i.e. how a pending row is replaced by its confirmed twin:
//   1. the POST response carries clientMsgId AND seq, so the sender always
//      learns the exact identity of its own message (the strong path);
//   2. but the realtime `message.new` frame does NOT carry client_msg_id
//      (MessageRoutes.broadcastPayload: id/seq/type/body/author/hlc/root only),
//      and it can beat the POST response back to this client. During that
//      window the confirmed row is already on screen while the pending row is
//      still waiting, which is exactly the duplicate this fold removes.
//
// So settlement is decided by the render fold, on content the realtime frame
// does carry: same author, same body, and a seq ABOVE the newest one that
// existed when the send started. That last clause is what keeps an older
// identical message ("네") from swallowing a fresh send. Each confirmed message
// settles at most one pending row, oldest first, so sending the same text twice
// still shows two rows and settles them one at a time.

export interface PendingMessage {
  /** Idempotency key (L4 §3.1). Stable across retries of the same attempt. */
  clientMsgId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  createdAtMs: number;
  /** newestSeq at the moment the send started; the echo must land above it. */
  sinceSeq: number | null;
  status: "sending" | "failed";
  /**
   * The composer's per-request model/effort override for THIS send (ADR-0134
   * D1). Absent for every send that inherits, which is every send that predates
   * this field. It rides the row so a retry replays the choice the person made:
   * dropping it would send a different request under the same idempotency key.
   */
  routing?: RequestRouting;
  /**
   * ADR-0148 — the message this send quotes. Rides the row for the same reason
   * `routing` does, and for one more: the echo renders its own quote block, so
   * without it the optimistic row would show no quote and then grow one the
   * instant its seq landed, moving the text under the reader's eye.
   */
  replyToId?: string;
  /**
   * ADR-0151 — 이 전송이 달고 나가는 첨부, **이미 업로드가 끝난 것들**.
   *
   * `routing`/`replyToId`와 같은 이유로 행을 타고 다닌다(재시도가 같은 멱등키로
   * 같은 요청을 다시 보내야 한다). 그리고 하나 더: echo 행이 자기 카드를 그린다.
   * 바이트는 이미 보관소에 있으므로 그 카드는 seq 가 도착하기 전에도 진짜다 —
   * mac 이 낙관적 행에 첨부를 실어 보내는 것과 같은 근거다.
   */
  attachments?: MessageAttachment[];
}

/** True when `message` is the server's echo of `pending`. */
export function confirmsPending(
  message: Message,
  pending: PendingMessage
): boolean {
  if (message.type !== "text") return false;
  if (message.state === "deleted") return false;
  if (pending.sinceSeq !== null && message.seq <= pending.sinceSeq) return false;
  if (!uuidEq(message.authorMemberId, pending.authorMemberId)) return false;
  if ((message.body ?? "") !== pending.body) return false;
  // 첨부가 붙은 전송에는 본문 대조만으로 부족하다. 파일만 보내는 메시지는 본문이
  // 빈 문자열이고, 그러면 이 술어는 "같은 사람이 sinceSeq 위에 쓴 아무 빈 메시지"를
  // 전부 자기 echo 로 읽는다 — 파일 셋을 잇달아 보내면 아무 카드나 아무 자리에서
  // 정착한다. 첨부 id 는 서버가 만든 것이고 전송 응답과 실시간 프레임 양쪽에 실려
  // 오므로, 그것이 이 자리에서 가장 강한 대조다.
  //
  // **집합으로** 대조한다 (리뷰 M-5). 위치로 맞추면 서버가 순서를 다르게 돌려주는
  // 날 낙관적 행이 영영 확정되지 않고 같은 메시지가 두 벌로 남는다 — 계약이
  // "만들어진 순서"라고 적은 것은 클라가 고른 순서와 같다는 보장이 아니다.
  // 순서 가정을 버려도 강도는 그대로다: id 는 서버가 만든 uuid 다.
  const expected = pending.attachments ?? [];
  if (expected.length === 0) return true;
  const actual = message.attachments ?? [];
  if (actual.length !== expected.length) return false;
  const arrived = new Set(actual.map((one) => one.id.toLowerCase()));
  return expected.every((want) => arrived.has(want.id.toLowerCase()));
}

/**
 * The pending rows that are still unconfirmed against this message array, in
 * send order. One confirmed message settles at most one pending row.
 */
export function unsettledPending(
  messages: Message[],
  pending: PendingMessage[]
): PendingMessage[] {
  if (pending.length === 0) return pending;
  const open = pending.slice();
  for (const message of messages) {
    const index = open.findIndex((p) => confirmsPending(message, p));
    if (index >= 0) open.splice(index, 1);
    if (open.length === 0) break;
  }
  return open;
}

// ---- pending list transitions (pure, so the hook holds no logic) ------------

export function addPending(
  list: PendingMessage[],
  pending: PendingMessage
): PendingMessage[] {
  return [...list, pending];
}

export function removePending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.filter((p) => p.clientMsgId !== clientMsgId);
}

/** The send attempt failed. The row stays put and offers a retry (R-1 §3). */
export function failPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "failed" } : p
  );
}

/**
 * Retry a failed row. The clientMsgId is deliberately REUSED: a failed POST
 * may still have committed on the server (a dropped response, a timeout), and
 * the idempotency key is exactly what turns that ambiguity into a guarantee.
 * Re-sending with the same key returns the original message instead of writing
 * a second one, which is what makes the duplicate count zero here.
 */
export function retryPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "sending" } : p
  );
}

export type TimelineItem =
  | { kind: "day"; key: string; atMs: number }
  | { kind: "unread"; key: string; count: number }
  | { kind: "recovery"; key: string; seq: number; source: "replay" | "backfill" }
  | {
      kind: "message";
      key: string;
      message: Message;
      startsGroup: boolean;
      /**
       * 이 행이 「일시정지」 알림이고 앞선 같은 알림들을 대신하고 있을 때, 자기를
       * 포함해 몇 개를 대신하는지 (2 이상). 그 외의 행에는 없다.
       */
      pausedRepeat?: number;
    }
  | { kind: "pending"; key: string; pending: PendingMessage; startsGroup: boolean };

export interface BuildItemsOptions {
  /** Server read cursor (P7). The divider sits above the first newer message. */
  lastReadSeq?: number | null;
  /** Server unread count for the channel; rendered on the divider. */
  unreadCount?: number;
  /** Reconnect markers, each anchored after the seq it recovered up to. */
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes of messages this client sent, still awaiting their seq. */
  pending?: PendingMessage[];
}

/**
 * Fold the ascending message array into the render stream: day separators, the
 * unread boundary, reconnect markers, and author-group flags.
 */
export function buildTimelineItems(
  messages: Message[],
  options: BuildItemsOptions = {}
): TimelineItem[] {
  const {
    lastReadSeq = null,
    unreadCount = 0,
    recoveryMarkers = [],
    pending = [],
  } = options;
  const items: TimelineItem[] = [];
  let previous: Message | undefined;
  // The newest `createdAtMs` among the rows laid so far — confirmed rows in the
  // loop below, echoes after it. The echo day line reads this and not `previous`:
  // an older echo sitting above a newer one must not lower the bar (#4749).
  let latestMs: number | undefined;
  let unreadPlaced = false;
  // A divider cuts the visual thread of an author group, so the row on the far
  // side of it must re-introduce its author. Without this the first row under
  // "새 메시지 3개" or "재연결됨" is anonymous whenever the same author happens
  // to continue across the line, which is exactly when the reader is least able
  // to infer who is speaking. Day dividers need no flag: a day boundary already
  // forces a group through startsAuthorGroup.
  let dividerAbove = false;

  // Markers anchor AFTER the newest loaded message at or below their seq, so
  // "seq N까지 복구" reads as a line drawn under everything it confirmed.
  const markersBySeq = new Map<number, RecoveryMarker[]>();
  for (const marker of recoveryMarkers) {
    let anchor: number | null = null;
    for (const message of messages) {
      if (message.seq <= marker.seq) anchor = message.seq;
      else break;
    }
    if (anchor === null) continue; // nothing loaded at or below it yet
    const list = markersBySeq.get(anchor);
    if (list) list.push(marker);
    else markersBySeq.set(anchor, [marker]);
  }

  // 반복된 「일시정지」 알림은 마지막 하나만 그린다. 배열이 아니라 이 스트림에서만
  // 빠지므로 seq도, 커서도, 재연결 복구도 접기를 모른다.
  const pausedFold = foldPausedNotices(messages);

  for (const message of messages) {
    // 그리지 않을 행은 날짜 구분선도 저자 묶음도 만들지 않는다: `previous`는
    // 언제나 **화면에 남은** 직전 행이어야 접힌 자리에 빈 헤더가 생기지 않는다.
    if (pausedFold.suppressed.has(message.seq)) continue;
    if (
      !previous ||
      dayKey(previous.createdAtMs) !== dayKey(message.createdAtMs)
    ) {
      items.push({
        kind: "day",
        key: `day-${dayKey(message.createdAtMs)}`,
        atMs: message.createdAtMs,
      });
    }
    if (
      !unreadPlaced &&
      lastReadSeq !== null &&
      unreadCount > 0 &&
      message.seq > lastReadSeq
    ) {
      items.push({
        kind: "unread",
        key: `unread-${lastReadSeq}`,
        count: unreadCount,
      });
      unreadPlaced = true;
      dividerAbove = true;
    }
    items.push({
      kind: "message",
      key: `m-${message.seq}`,
      message,
      startsGroup: dividerAbove || startsAuthorGroup(previous, message),
      pausedRepeat: pausedFold.repeats.get(message.seq),
    });
    dividerAbove = false;
    for (const marker of markersBySeq.get(message.seq) ?? []) {
      items.push({
        kind: "recovery",
        key: `r-${marker.id}`,
        seq: marker.seq,
        source: marker.source,
      });
      dividerAbove = true;
    }
    previous = message;
    latestMs =
      latestMs === undefined
        ? message.createdAtMs
        : Math.max(latestMs, message.createdAtMs);
  }

  // Pending rows close the stream: they are always the newest thing the user
  // did, and they carry no seq to be sorted by. A row whose confirmed twin is
  // already in `messages` is dropped here, which is where "중복 0" is enforced
  // regardless of whether the POST response or the realtime frame won the race.
  let previousRow: GroupingRow | undefined = previous;
  for (const row of unsettledPending(messages, pending)) {
    // The echo that opens a new local day carries the day line itself (#4749).
    // The confirmed twin gets one from the loop above (`day-<key>`, the same key
    // for the same day), so without this the line appeared only when the POST
    // answered: the row the person had just seen arrive was pushed down by the
    // line's height and the list had to travel a second time (SE, first send of
    // the day: content +78.5 at the echo, +44 at the swap, 33pt jump, two
    // glides). With the line already in place the swap changes nothing above the
    // row.
    //
    // Only when the echo is LATER than everything laid so far. The confirmed loop
    // can read "the day differs" as "a new day starts" because seq order keeps
    // time moving forward; an echo has no seq, and one can sit below a newer row
    // (a failed send left overnight, a reply that landed after midnight while the
    // POST was in flight) or below a newer echo. Judged against the row right
    // above it, an older echo would repeat a `day-<key>` already in the stream or
    // put yesterday's line under today's rows, and an echo after it would draw
    // today's line a second time.
    if (
      latestMs === undefined ||
      (row.createdAtMs > latestMs &&
        dayKey(latestMs) !== dayKey(row.createdAtMs))
    ) {
      items.push({
        kind: "day",
        key: `day-${dayKey(row.createdAtMs)}`,
        atMs: row.createdAtMs,
      });
    }
    items.push({
      kind: "pending",
      key: `p-${row.clientMsgId}`,
      pending: row,
      startsGroup: dividerAbove || startsAuthorGroup(previousRow, row),
    });
    dividerAbove = false;
    previousRow = row;
    latestMs =
      latestMs === undefined
        ? row.createdAtMs
        : Math.max(latestMs, row.createdAtMs);
  }

  return items;
}

// =============================================================================
// 답이 나타날 자리 (#999) — 그리고 왜 `TimelineItem` 이 **아닌가**
//
// 성재, 1차 검수: *"에이전트가 일하고 있는 상태인지도 잘 파악이 안 돼."*
//
// 이 칸은 위 스트림에 얹히지만 `TimelineItem` 유니온에는 들어가지 않는다. 이유는
// 취향이 아니라 기존 소비자다: 웹 클라이언트의 목록은 네 종류를 `if` 로 걷어낸
// 뒤 **남은 것을 메시지로 단정**해서 `item.message` 를 읽는다
// (`clients/web/src/features/timeline/Timeline.tsx:242-256`). 유니온을 넓히면
// 그 마지막 줄이 타입 오류가 되고, 그 파일은 이 goal 이 건드려서는 안 되는
// 표면이다. 유니온을 넓히지 않으면 웹은 이 변경을 **알지도 못한 채** 그대로다.
//
// 그래서 확장은 유니온이 아니라 한 겹 위에서 일어난다: 스트림을 그리는 표면이
// `TimelineStreamItem` 을 쓰고, 쓰지 않는 표면은 `TimelineItem` 을 그대로 쓴다.
// =============================================================================

/** 열린 턴 하나가 답을 놓을 자리. 메시지가 아니다 — seq 도 저자 묶음도 없다. */
export interface TurnPlaceholderItem {
  kind: "working";
  key: string;
  memberId: string;
}

/** 자리표시까지 포함한 렌더 스트림. */
export type TimelineStreamItem = TimelineItem | TurnPlaceholderItem;

/**
 * 자리표시를 스트림의 **맨 끝**에 붙인다 — 대기행보다도 뒤.
 *
 * 순서가 곧 이야기이기 때문이다: 「내가 물었다」 다음 칸이 「그가 작업 중」이고,
 * 답이 도착하면 그 칸이 답으로 바뀐다. 반대로 두면 자리표시가 자기가 기다리는
 * 메시지보다 위에 선다.
 *
 * 저자 묶음에는 끼지 않는다. 이 행은 메시지가 아니고, 뒤이어 도착할 진짜 메시지가
 * 자기 이름줄을 온전히 얻어야 한다 — 자리표시가 저자를 "이미 소개했다"고 주장하면
 * 그것이 사라지는 순간 이름 없는 행 하나가 남는다.
 *
 * 붙일 것이 없으면 **받은 배열을 그대로** 돌려준다. 동일성을 지키는 것이 곧
 * 호출자의 memo 를 지키는 것이다(#997).
 */
export function withTurnPlaceholders(
  items: TimelineItem[],
  working: readonly { memberId: string }[] = []
): TimelineStreamItem[] {
  if (working.length === 0) return items;
  const out: TimelineStreamItem[] = items.slice();
  for (const turn of working) {
    out.push({
      kind: "working",
      key: `w-${turn.memberId.toLowerCase()}`,
      memberId: turn.memberId,
    });
  }
  return out;
}
