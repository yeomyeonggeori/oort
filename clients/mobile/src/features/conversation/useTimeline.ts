import {useExpressionStore} from '../expressions/ExpressionProvider';
import {
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  fetchChannelPins,
  fetchMessages,
  fetchReactionSnapshot,
  fetchThreadReplies,
  sendMessage,
  sendThreadReply,
  setPin,
  setReaction,
  uuidEq,
  type Message,
  type MessageAttachment,
  type ThreadReadState,
} from '@momo/core/lib/api';
import {
  payloadToMessage,
  pinnedPayloadToWire,
  type MessageNewEvent,
} from '@momo/core/lib/realtimeEvents';
import {
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  removePin,
  type PinListStatus,
  type PinMap,
} from '@momo/core/features/timeline/pins';
import {applyThreadReadState} from '@momo/core/features/timeline/threadSummary';
import {
  pruneRecoveryMarkers,
  RECOVERY_MARKER_TTL_MS,
} from '@momo/core/features/timeline/divider';
import {
  judgeRecoveryMarker,
  messageIdKey,
  NO_RECOVERY,
  type RecoveryMarkerVerdict,
} from '@momo/core/features/timeline/recoveryMarker';
import {subscribeRestOutcome} from '@momo/core/lib/http';
import {
  isFailedRow,
  isSendingRow,
  isServerAnswer,
  pickAutoResends,
  recordSendFailure,
  resendAllContinuesAfter,
  type SendFailureKind,
  type SendFailureRecord,
} from '@momo/core/features/connection/sendFailure';
import NetInfo from '@react-native-community/netinfo';
import {isOnlineFromNetInfo} from '../../query/queryClient';
import {onAppBackground} from '../connection/appBackground';
import {deviceOnlineNow} from '../connection/deviceOnline';
import {
  bundleCarriesOptions,
  bundleHead,
  bundleMayPost,
  failBundleTail,
  planSendBundle,
  postBundleInOrder,
  retryBundleTail,
  type BundlePoster,
} from '@momo/core/features/expressions/sendBundle';
import type {Expression} from '@momo/core/features/expressions/types';
import {forgetFailedSend, readFailedSends, rememberFailedSend} from './failedSends';
import {SEEK_MAX_PAGES, seekPageLimit, SeekOutcome} from './jumpSeek';
import {
  addPending,
  applyEditedMessage,
  applyTombstone,
  discardPending,
  emptyTimeline,
  failPending,
  isChannelListEcho,
  reconcileMessages,
  removePending,
  unsettledPending,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineState,
} from '@momo/core/features/timeline/model';
import {
  applyReactionDelta,
  clearMessageReactions,
  emptyReactions,
  normalizeReactionSnapshot,
  toggleDirection,
  type ReactionChange,
  type ReactionMap,
} from '@momo/core/features/timeline/reactions';
import {endedStreamRunIds} from '@momo/core/features/timeline/streamStop';
import type {UnfurlMap} from '@momo/core/features/timeline/unfurl';
import {seedEndedRuns} from '../agents/endedRuns';
import {useMessageUnfurls} from './useMessageUnfurls';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {ChannelRail} from '../../realtime/channelRail';
import {hapticScope} from '../../lib/haptics';

// =============================================================================
// One channel's messages: load, receive, send.
//
// The RN sibling of `clients/web/src/features/timeline/useTimeline.ts`, and
// deliberately the same shape — same merge point, same settlement rule, same
// resume healing. ADR-0137 D3 keeps react hooks in the HOST rather than the
// core, so this is host wiring; every decision it wires is the core's.
//
// ## Why this is not react-query, when everything else on this client is
//
// `features/workspace/queries.ts` and `features/inbox/useInbox.ts` are both
// react-query, and messages deliberately are not. A channel's message array is
// merged from three sources that disagree about order (a descending REST page,
// a realtime publication, an ascending `?after` backfill), paginates in both
// directions, and is keyed by `seq` rather than by a cache key. react-query's
// cache models none of that, and expressing it through `setQueryData` would put
// the fold — the one thing the seq gate re-implements and checks — inside a
// cache callback where no test can reach it. The web client made the same split
// for the same reason.
//
// ## The write side (goal RN-C5), and the one asymmetry inside it
//
// RN-C4 left this file read-only on purpose and said so here. The actions are
// now wired, and they keep the split the web client measured its way to:
//
//   반응    **낙관적**. The direction is DERIVED from the map rather than passed
//           in (`toggleDirection`), so the local update and the request cannot
//           disagree about which way the toggle was going. On failure the change
//           is undone with its own inverse — safe because `applyReactionDelta`
//           is idempotent, so if the realtime echo of a SUCCESSFUL twin already
//           landed, the revert is a no-op rather than a second wrong write.
//
//   고치기·지우기  **낙관적이 아니다.** The server stamps `edited_at` and decides
//           the resulting `state`; showing the new text first would leave the row
//           claiming an edit that a 403 then took back. One request, and the
//           editor says 저장 중… while it runs.
//
// Every one of these THROWS on failure rather than swallowing. The sentence a
// person reads is chosen at the row (`actionCopy`), because that is where the
// failure belongs — B8's rule that the server's wire sentence never reaches the
// screen, and B11's that the reason sits on the row rather than in a toast.
//
// The read-side asymmetry RN-C4 noted still holds and is still deliberate: a
// tombstone that ARRIVES is handled (`onMessageDeleted`), because receiving a
// delete someone else made is reading, not acting.
//
// ## Replies are channel messages, and that is why there is no second hook
//
// A reply is a message in this channel with `rootId` set — the same write path
// (`sendThreadReply` posts to the same endpoint), the same `seq`, and the server
// does NOT filter replies out of channel history (`list_channel_page` has no
// `root_id IS NULL` predicate). So a thread is a VIEW over this state, not a
// second store: `loadReplies` merges through the same `applyBatch`, the rail
// delivers replies to the same `onMessage`, and the thread surface filters by
// `rootId`. A separate hook would have meant a second copy of the seq fold, the
// settle rule and the reaction map — three things that must not be able to
// disagree with what the channel is showing one screen away.
//
// Echoes carry their root (`PendingMessage.rootId`) with them, so one settle effect still covers both surfaces and the
// channel list can draw a FAILED reply's echo with its 「↳ ○○님 스레드에 답글」 line (#4888, #5324).
// =============================================================================

const HEAD_LIMIT = 50;
const PAGE_LIMIT = 50;

export interface ResumeInfo {
  /** How the last (re)subscribe resolved. Null before the first one. */
  lastRecovered: boolean | null;
  /** Messages recovered by the last REST `?after` backfill after a gap. */
  lastBackfillCount: number;
  resubscribeCount: number;
}

/** `loadReplies` 가 돌려주는 값 — 서버가 알려 준 내 따라가기 상태(#4890). */
export interface ThreadRepliesLoad {
  following: boolean;
}

/**
 * 보낼 때 한 번 정해지는 선택(#5016). 켠 때만 있다 — 요청은 closed-world라 켜지 않은 전송은 이 필드 이전과
 * 바이트 단위로 같은 요청이어야 한다.
 */
export interface TimelineSendFlags {
  /** 입력칸의 ✕로 이 메시지의 링크 미리보기를 끄고 보낸다(ADR-0170 증보 2026-11-01). */
  suppressUnfurl?: boolean;
  /**
   * 입력창 위 미리 보기에 올라 있던 이모티콘·GIF(#5452). 있으면 **큰 표현 메시지 → 글 메시지** 두 개를 한 묶음으로 보낸다(코어 `planSendBundle`, 웹 #5453 과 같은 와이어):
   * 메시지마다 다른 `client_msg_id` 를 쓰고, 첫째가 확정되기 전에는 둘째가 나가지 않고, 첫째가 실패하면 둘째는 보내지 않은 채 실패한 행으로 남는다. 다시 보내기는 어느 행에서든 첫째부터다.
   * 글이 비어 있으면 표현 메시지 하나다. 인용·첨부·링크 미리보기 끄기는 마지막 메시지가 나른다.
   * 스레드 답글(`sendReply`: 밀어서 보낸 답글과 스레드 입력창, #5490)도 같은 묶음이다. 다른 점은 **두 메시지 모두** 같은 스레드의 답글이라는 것 하나다 - 답글 대상(`rootId`)은 옵션이 아니라
   * 메시지가 어디에 달리는가의 주소라서 마지막 메시지만 나르면 큰 그림만 본류에 홀로 남는다.
   */
  expression?: Expression;
}

export interface UseTimelineResult {
  state: TimelineState;
  status: 'loading' | 'ready' | 'error';
  /**
   * The channel whose head page `state` holds, or null while one is being read
   * (#2569).
   *
   * `status` cannot say this on its own. This hook keeps its state across a
   * channel switch until its effect runs, so on the render where `channelId`
   * changes `status` is still the PREVIOUS channel's 'ready' and `state` still
   * holds that channel's rows. A caller that acts once "the timeline is ready" —
   * a notification landing on one message — would act on the wrong room.
   */
  loadedChannelId: string | null;
  /**
   * Read this channel's tail from Postgres **now** — everything after the newest
   * row held (#2584 design-review R2 H-1).
   *
   * The rail is transport, not truth. A conversation left open in the background
   * keeps its rows while the socket is dropped (ADR-0137 D4), and nothing re-reads
   * them when the same room is shown again: a notification tap for that room lands
   * on rows read before the tap. A caller that must judge "is this message here?"
   * against the server's present — the notification landing — reads first.
   *
   * Rejects when the read fails. Rows that arrive after the person moved to
   * another channel are dropped, not merged into the one now on screen.
   */
  catchUp: () => Promise<void>;
  resume: ResumeInfo;
  recoveryMarkers: RecoveryMarker[];
  /** Channel-level echoes awaiting their server seq. Never inside `state`. */
  pending: PendingMessage[];
  /**
   * The one send path: optimistic echo now, server seq when it lands.
   *
   * `replyToId` is ADR-0148 인용 — a column on the same write, never a second
   * path. It rides the pending row (core `PendingMessage.replyToId`), as `rootId`
   * does, because the echo has to draw its own quote
   * block: without it the optimistic row shows no quote and then grows one the
   * instant its seq lands, moving the text under the reader's eye.
   */
  send: (
    body: string,
    replyToId?: string,
    attachments?: MessageAttachment[],
    /** 호출 경로가 이미 한 번 시도한 글의 키(#3638) — 같은 키라야 서버가 중복을 접는다. */
    clientMsgId?: string,
    /**
     * #5016 — 입력칸의 ✕로 이 메시지의 링크 미리보기를 끄고 보낸다. 켠 때만 요청에 키가 간다
     * (`SendMessageOptions.suppressUnfurl`). 행이 들고 다니므로 「다시 보내기」도 같은 요청이다.
     */
    options?: TimelineSendFlags,
  ) => Promise<void>;
  /**
   * A message the caller already sent through another path (#3638: 개인 에이전트 호출은
   * 코어 `callPersonalAgent`가 보낸다). 서버가 확정한 줄이라 실시간 프레임과 같은 합류로
   * 들어가고, 다른 방으로 옮겨 간 뒤에 도착한 것은 버린다. 두 번 보내지 않는다.
   */
  ingest: (message: Message) => void;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  /**
   * 실패한 글 전부를 같은 멱등 키로 한 번씩 다시 보낸다(#5222). 보낸 순서대로 하나씩이고, 네트워크로 또 실패하면 멈춘다
   * (서버가 거절한 글은 건너뛰고 이어 간다).
   */
  resendAll: () => Promise<void>;
  /**
   * 못 보낸 글마다 원인 한 줄의 종류(#5222, 코어 `sendFailureKind`): 오프라인 · 서버에 닿지 못함 · 서버가 거절. 원인을 모르는 행(알 수 없는
   * 오류, 이 기기에 남은 것을 되살렸고 종류가 안 적힌 행)은 키가 없다 - 화면은 그때 「전송 실패」만 말한다.
   */
  failureKinds: ReadonlyMap<string, SendFailureKind>;
  /**
   * 보내지 못한 메시지를 이 기기에서만 지운다(#5210). 판정은 코어 `discardPending` 이고 서버로 가는 길이
   * 없다. 지운 행을 돌려주고, 지우지 않았으면(보내는 중·이미 없음) null.
   */
  discard: (clientMsgId: string) => PendingMessage | null;
  /**
   * Toggle my reaction, optimistically. **Throws** on failure, after having put
   * the chip back where it was — the caller turns the error into the sentence.
   */
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
  /** Rewrite my own message. Not optimistic; throws on failure. */
  editBody: (message: Message, body: string) => Promise<void>;
  /** Soft-delete my own message; the returned tombstone replaces the row. */
  removeMessage: (message: Message) => Promise<void>;
  /** One page of a root's replies, merged into the same seq-ordered state. */
  /**
   * 스레드의 답글을 끝까지 받아 같은 상태에 합친다. 돌려주는 값은 서버가 알려 준 **내 따라가기 상태**(#4890, ADR-0206 증보 1 F8:
   * 스레드 열기 응답의 `following` — 마지막 쪽의 값, 키가 없는 옛 서버는 `false`).
   */
  loadReplies: (rootId: string) => Promise<ThreadRepliesLoad>;
  /**
   * The answer to a thread's 「read up to here」 signal (#4878, #4889 stage 2), folded into the HELD root's summary: a followed
   * thread's unread count becomes the server's (0 clears the 「새 답글 M」 chip), an unfollowed one loses the value.
   */
  applyThreadRead: (rootId: string, read: ThreadReadState) => void;
  /** Reply into a thread. Same echo machinery as `send`, tagged with its root. */
  sendReply: (
    rootId: string,
    body: string,
    attachments?: MessageAttachment[],
    /** `send`의 같은 이름 인자와 같다(#5016). 답글 요청(`sendThreadReply`)에도 같은 규칙으로 실린다. */
    options?: TimelineSendFlags,
  ) => Promise<void>;
  /** The echoes belonging to one thread (never shown in the channel list). */
  repliesPending: (rootId: string) => PendingMessage[];
  loadOlder: () => Promise<void>;
  /**
   * 점프의 목적지(`untilSeq`)가 불러온 범위 위에 있을 때, 그 seq 에 닿을 때까지 `before` 쪽 넘김을 **이어서** 읽는다 (#5383).
   *
   * `loadOlder` 와 다른 점 셋. ① 실패를 말한다(`loadOlder` 는 조용히 삼킨다 - 손으로 다시 올리면 되기 때문이다). ② 쪽을 읽는 동안
   * 목록에 합치지 않고 모았다가 **닿았을 때 한 번에** 합친다 - 사람은 바닥에 서 있고, 위에 쪽이 하나씩 붙을 때마다 목록이 흔들릴
   * 이유가 없다. 닿지 못한 끝(상한·실패·접음)은 아무것도 합치지 않아 화면이 읽기 전 그대로다. ③ 사람이 접을 수 있다
   * (`isCancelled` 가 참이 되면 다음 쪽을 읽지 않고, 늦게 온 답은 버린다).
   *
   * 수치(쪽 크기·쪽 상한·맥락 줄)와 그 이유는 `jumpSeek.ts` 머리말이다. 읽는 동안 `loadingOlder` 가 서서 손으로 올리는 읽기와 겹치지 않는다.
   */
  seekOlder: (untilSeq: number, isCancelled: () => boolean) => Promise<SeekOutcome>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /** `message id -> emoji -> member ids`, case-folded on ingest. Display only. */
  reactions: ReactionMap;
  /** 이슈 #1112 — `message id -> the pin`, case-folded on ingest. */
  pins: PinMap;
  /**
   * 이슈 #1146 M2 — where the cold read of `pins` stands. An empty map means
   * two different things and only this says which.
   */
  pinsStatus: PinListStatus;
  /** Read the channel's pins again. The retry behind the failure sentence. */
  reloadPins: () => void;
  /**
   * Pin or unpin one message. **Throws** on failure, after having put the list
   * back where it was — the caller turns the error into the sentence.
   */
  togglePin: (message: Message) => Promise<void>;
  /**
   * 링크 카드(ADR-0170 D5, #4883) — `message id(소문자) -> 서버 투영`. 빈 목록은 묘비다. 메시지 줄이 아니라
   * 곁가지라 `state` 에 들어 있지 않다.
   */
  unfurls: UnfurlMap;
  /** 작성자가 이 메시지의 링크 미리보기를 모두에게서 지운다. **던진다** — 문장은 부른 쪽이 고른다. */
  removeUnfurls: (message: Message) => Promise<void>;
}

export {RECOVERY_MARKER_TTL_MS};

export function useTimeline(
  rail: ChannelRail | null,
  workspaceId: string,
  channelId: string | null,
  authorMemberId: string,
): UseTimelineResult {
  const expressionStore = useExpressionStore();
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<UseTimelineResult['status']>('loading');
  const [loadedChannelId, setLoadedChannelId] = useState<string | null>(null);
  const [resume, setResume] = useState<ResumeInfo>({
    lastRecovered: null,
    lastBackfillCount: 0,
    resubscribeCount: 0,
  });
  const [recoveryMarkers, setRecoveryMarkers] = useState<RecoveryMarker[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [reactions, setReactions] = useState<ReactionMap>(emptyReactions);
  const reactionsRef = useRef<ReactionMap>(reactions);
  // 이슈 #1112. Same shape and the same reason as `reactions`: a pin annotates a
  // message rather than being a field of it.
  const [pins, setPins] = useState<PinMap>(emptyPins);
  const pinsRef = useRef<PinMap>(pins);
  // 이슈 #1146 M2. The map alone cannot tell 「nobody pinned anything」 from
  // 「we never found out」, and the list was printing the first sentence for both.
  const [pinsStatus, setPinsStatus] = useState<PinListStatus>('loading');
  /** Which read owns the answer. See `loadPins`. */
  const pinReadRef = useRef(0);

  // Authoritative newest-seq cursor, updated at MERGE time rather than at render
  // time, so a resubscribe firing between renders still reads truth. A send that
  // read it from `state` would stamp `sinceSeq` from a stale render and let an
  // older identical message settle the echo.
  const newestSeqRef = useRef<number | null>(null);
  const firstSubscribeRef = useRef(true);
  const markerCounterRef = useRef(0);

  // 복구 표지는 「복구가 **다른 사람(또는 에이전트)의 새 메시지**를 들여왔다」는 말이다(#4292). 그러니 「새것」은 seq 가 아니라 **id** 로,
  // 「남」은 작성자로 가린다 — seq 로 가리면 REST 응답이 먼저 들어와 seq 를 올려 둔 내 줄과, 더 작은 seq 로 뒤늦게 닿은 남의 줄을
  // 구별하지 못한다. 내가 방금 보낸 줄은 되쏘기·꼬리 읽기에도 실려 오지만(내 REST 응답보다 먼저 올 수도, 뒤에 올 수도 있다) 복구한 것이
  // 아니다. 판정은 코어의 것이고(#4328 — 웹·데스크탑과 같은 함수) 이 훅은 이미 든 줄 id 의 집합과 복구를 지켜보는 창만 쥔다.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const authorRef = useRef(authorMemberId);
  authorRef.current = authorMemberId;
  /**
   * 레일이 끊긴 구간을 되쏘는 동안(`subscribed` 직후 동기 flush ~ 그 뒤 마이크로태스크) 병합되는 「남이 새로 보낸 줄」에 대한 코어 판정.
   * null 이면 세지 않는다. 되쏜 줄도 실시간 줄과 같은 문(`applyBatch`)을 지나므로 그 문이 이어 받는다.
   */
  const replayWatchRef = useRef<{verdict: RecoveryMarkerVerdict} | null>(null);

  const applyBatch = useCallback((batch: Message[]) => {
    if (batch.length === 0) return;
    // 판정은 **병합 전에** 묻는다 — 아래 루프가 이 줄들의 id 를 든 줄로 등록하면 「새것」이 사라진다.
    const watch = replayWatchRef.current;
    if (watch !== null) {
      watch.verdict = judgeRecoveryMarker(
        batch,
        knownIdsRef.current,
        authorRef.current,
        watch.verdict,
      );
    }
    for (const message of batch) {
      if (newestSeqRef.current === null || message.seq > newestSeqRef.current) {
        newestSeqRef.current = message.seq;
      }
      knownIdsRef.current.add(messageIdKey(message.id));
    }
    // #1166 — 종결 기록의 씨앗을 **머지 자리에서** 심는다. 페이지를 긷는 곳은
    // 넷(첫 화면·위로 더 읽기·재연결 백필·스레드 답글)이고, 그 넷이 전부 이 문을
    // 지난다. 호출부마다 심게 두면 언젠가 한 곳이 빠지고, 그 한 곳으로 들어온
    // 반쪽 답만 조용히 완결 행세를 한다. 실시간으로 온 행은 `runEnded` 를 달고
    // 오지 않으므로 여기서 아무것도 내놓지 않는다.
    seedEndedRuns(endedStreamRunIds(batch));
    setState(s => reconcileMessages(s, batch));
    // 복구 표지는 「여기까지 복구했다」는 한 번의 알림이다(#4016). 표지보다 새 메시지가 오면 그 알림은
    // 할 일을 마쳤으므로 걷는다 — 상시로 남으면 지난 일을 계속 말하는 줄이 된다. 같은 배치로 표지가
    // 서는 순서는 `addMarker` 가 배치 **뒤**에 부르므로 이 줄이 방금 선 표지를 지우지 않는다.
    setRecoveryMarkers(markers => pruneRecoveryMarkers(markers, batch));
  }, []);

  // 편집 투영(`message.edited` 프레임·PATCH 응답)은 도착이 아니다(#4450). 이미 든 줄을 다시 투영할 뿐
  // 줄을 들이지 않으므로 `applyBatch` 의 도착 장부(`newestSeqRef` 커서·든 줄 id·복구 표지 판정)를
  // 지나지 않는다. 지나면 못 찾은 줄의 편집이 꼬리 커서를 앞세우고 「든 줄」로 등록된다. 든 줄에 대한
  // 장부는 모두 이미 되어 있다. 판정은 코어 한 곳이다.
  const applyEdited = useCallback((edited: Message) => {
    setState(s => applyEditedMessage(s, edited));
  }, []);

  // 새 메시지가 오지 않아도 표지는 오래 남지 않는다 — 일정 시간 뒤에 스스로 걷힌다.
  const markerTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = markerTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const addMarker = useCallback((source: RecoveryMarker['source']) => {
    const seq = newestSeqRef.current;
    if (seq === null) return;
    markerCounterRef.current += 1;
    const id = `recovery-${markerCounterRef.current}`;
    setRecoveryMarkers(markers => [...markers, {id, seq, source}]);
    const timer = setTimeout(() => {
      markerTimersRef.current.delete(timer);
      setRecoveryMarkers(markers => markers.filter(marker => marker.id !== id));
    }, RECOVERY_MARKER_TTL_MS);
    markerTimersRef.current.add(timer);
  }, []);

  // ---- optimistic send ------------------------------------------------------
  // Mirrored in a ref so a retry can read the row it is retrying without making
  // the callbacks depend on the list — a dependency there would rebuild the
  // composer's send handler on every keystroke, and this is the one file where
  // that matters most: the composer's `value` must stay synchronous (spike #837
  // gate 1), and a handler identity that churns per keystroke is the first step
  // toward someone "fixing" it with a queue.
  const pendingRef = useRef<PendingMessage[]>([]);
  const updatePending = useCallback(
    (fn: (list: PendingMessage[]) => PendingMessage[]) => {
      pendingRef.current = fn(pendingRef.current);
      setPending(pendingRef.current);
    },
    [],
  );

  // Which channel is on screen, read by in-flight sends that resolved after the
  // person moved on. Without it a POST for channel A merges into channel B.
  const channelRef = useRef<string | null>(null);
  const sendEpochRef = useRef(0);
  // 링크 카드(#4883). 읽기 답이 방을 옮긴 뒤에 오면 버리도록 지금 방을 묻는 함수를 넘긴다.
  const currentChannel = useCallback(() => channelRef.current, []);
  const {
    unfurls,
    hydrate: hydrateUnfurls,
    reset: resetUnfurls,
    applyFrame: applyUnfurlFrame,
    clear: clearUnfurls,
    remove: removeUnfurls,
  } = useMessageUnfurls(workspaceId, currentChannel);

  // Which echoes are thread replies: the echo carries its own `rootId`, the way `replyToId` rides the row — the channel
  // list needs it to draw a failed reply with its 「↳ ○○님 스레드에 답글」 line (#4888), and both surfaces still share
  // one array and one settle effect.

  // 보내지 못한 글의 장부(#5222). 코어 `PendingMessage` 는 웹과 나눠 쓰므로 건드리지 않고 행 곁에 clientMsgId 로 둔다(`replyToId` 같은 칸과 달리
  // 행에 싣지 않는다). 자동 재전송의 판정(어떤 실패를 몇 번 얼마 동안)은 코어 `pickAutoResends` 하나다 - 웹 `useTimeline` 과 같은 길이다.
  const failuresRef = useRef(new Map<string, SendFailureRecord>());
  const [failureKinds, setFailureKinds] = useState<ReadonlyMap<string, SendFailureKind>>(
    () => new Map(),
  );
  const syncFailureKinds = useCallback(() => {
    const next = new Map<string, SendFailureKind>();
    for (const [id, record] of failuresRef.current) {
      if (record.kind !== null) next.set(id, record.kind);
    }
    setFailureKinds(next);
  }, []);
  // 채널을 떠날 때 아직 날아가던 요청의 열쇠. 그 요청이 실패로 끝나면 이 기기에 남겨 돌아왔을 때 실패 행이 되게 한다.
  const orphansRef = useRef(new Set<string>());
  /** 이 글은 끝났다(보냈다·지웠다·서버가 이미 받았다): 장부와 이 기기의 저장본에서 지운다. */
  const forgetRow = useCallback(
    (row: Pick<PendingMessage, 'clientMsgId' | 'channelId'>) => {
      orphansRef.current.delete(row.clientMsgId);
      forgetFailedSend(workspaceId, row.channelId, row.clientMsgId);
      if (failuresRef.current.delete(row.clientMsgId)) syncFailureKinds();
    },
    [workspaceId, syncFailureKinds],
  );

  const post = useCallback(
    async (row: PendingMessage, automatic = false): Promise<boolean> => {
      const epoch = sendEpochRef.current;
      const feedback = hapticScope(() =>
        sendEpochRef.current === epoch && channelRef.current === row.channelId,
      );
      try {
        const rootId = row.rootId;
        const attachmentIds = row.attachments?.map(attachment => attachment.id);
        // 입력칸 ✕로 끈 채 보낸 메시지의 재시도도 **같은 요청**이다(#5016). 서버는 이미 저장된 메시지의 재시도에서 이
        // 필드를 다시 판단하지 않으므로, 여기서 떨구는 순간 사람이 끈 카드가 되살아난다. 켠 때만 키가 간다.
        const suppress = row.suppressUnfurl === true ? {suppressUnfurl: true as const} : {};
        const attached =
          attachmentIds === undefined || attachmentIds.length === 0 ? {} : {attachmentIds};
        const replyOptions = {...attached, ...suppress};
        const confirmed = await (rootId === undefined
          ? sendMessage(workspaceId, row.channelId, row.clientMsgId, row.body, {
              ...(row.replyToId === undefined
                ? {}
                : {replyToId: row.replyToId}),
              ...attached,
              ...suppress,
            })
          : sendThreadReply(
              workspaceId,
              row.channelId,
              rootId,
              row.clientMsgId,
              row.body,
              // 아무것도 싣지 않는 답글은 예전과 같은 호출(옵션 자리가 비어 있음)이다.
              Object.keys(replyOptions).length === 0 ? undefined : replyOptions,
            ));
        // The response IS the committed server echo (seq-authoritative), so
        // merging it is not optimistic rendering: it is the same reconcile the
        // realtime frame gets, and whichever arrives second dedupes by seq.
        if (channelRef.current === row.channelId) applyBatch([confirmed]);
        expressionStore?.recordSuccess(`message:${row.clientMsgId}`, row.body);
        updatePending(list => removePending(list, row.clientMsgId));
        forgetRow(row);
        return true;
      } catch (error: unknown) {
        // The row stays where it is and states 전송 실패 with a retry, in place.
        // No toast: a failure reported far from the message it belongs to makes
        // the person hunt for which message failed.
        const record = recordSendFailure(
          failuresRef.current.get(row.clientMsgId),
          error,
          deviceOnlineNow(),
          Date.now(),
          automatic,
        );
        const listed = pendingRef.current.some(p => p.clientMsgId === row.clientMsgId);
        const orphan = orphansRef.current.delete(row.clientMsgId);
        // 목록에도 없고 떠난 채널의 고아도 아니면 서버의 echo 가 이미 정착시킨 행이다(응답만 늦게 실패했다): 글은 서버에 있으므로
        // 되살릴 것이 없다.
        if (listed || orphan) {
          failuresRef.current.set(row.clientMsgId, record);
          syncFailureKinds();
          if (listed) updatePending(list => failPending(list, row.clientMsgId));
          // 스레드 답글(`rootId` 가 있는 행)도 대화의 글과 똑같이 남긴다(#5262): 행이 뿌리(`rootId`)를 싣고 다녀서
          // 되살린 행이 스스로 어느 스레드의 답글인지 안다. 돌아온 행은 스레드 화면(`repliesPending`)과 대화 목록(실패한 답글은 목록에도
          // 선다, `isChannelListEcho`) 어느 쪽에서나 기존 실패 행 그대로 그려지고, 다시 보내기는 `post` 가 뿌리로 답글 길을 탄다.
          rememberFailedSend(workspaceId, row, record.kind);
        }
        // 저절로 다시 보낸 시도가 실패한 것은 소리 없이 지나간다: 사람이 누르지 않은 일에 진동을 주지 않는다.
        if (!automatic) feedback('actionFailed');
        return false;
      }
    },
    [workspaceId, applyBatch, updatePending, expressionStore, forgetRow, syncFailureKinds],
  );

  // 이모티콘 + 글 묶음의 앞 메시지가 나가지 못했다(#5452): 보내지 않은 뒤 메시지를 실패 모양으로 맞춘다. 글을 잃지 않게 행은 남기고, 이유 한 줄은 앞 메시지와 같다(같은 실패다).
  // 이 기기에도 남겨서 앱을 다시 켠 뒤에도 같은 순서 규칙(`after`)이 돌아온다.
  const heldRows = useCallback(
    (rows: PendingMessage[], because: PendingMessage) => {
      const record = failuresRef.current.get(because.clientMsgId);
      updatePending(list => failBundleTail(list, because.clientMsgId));
      for (const row of rows) {
        if (record !== undefined) {
          failuresRef.current.set(
            row.clientMsgId,
            recordSendFailure(
              failuresRef.current.get(row.clientMsgId),
              record.failure,
              deviceOnlineNow(),
              Date.now(),
              false,
            ),
          );
        }
        rememberFailedSend(workspaceId, row, record?.kind ?? null);
      }
      syncFailureKinds();
    },
    [workspaceId, updatePending, syncFailureKinds],
  );

  /** 머리 행을 보내고, 묶음이면 뒤 행을 이어서 보낸다. 처음 보내기·다시·모두 다시·저절로 다시가 모두 이 한 길을 지난다(순서 문은 코어 `postBundleInOrder`). */
  const postChain = useCallback(
    (head: PendingMessage, automatic: boolean): Promise<boolean> => {
      const poster: BundlePoster = {
        list: () => pendingRef.current,
        post: row => post(row, automatic),
        held: heldRows,
      };
      return postBundleInOrder(head, poster);
    },
    [post, heldRows],
  );

  /**
   * 보내기의 한 길: 행을 대기 목록에 세우고 머리 행부터 보낸다. 채널 글(`send`)과 스레드 답글(`sendReply`)이 같은 길이다(#5490) - 표현이 있으면 행이 둘이고 순서·멱등·실패 규칙은 둘 다 코어 묶음 규칙 하나다.
   * 답글이면 **모든 행이** `rootId` 를 싣는다(큰 그림도 같은 스레드에 달린다). 인용·첨부·링크 미리보기 끄기는 마지막 행만 나른다.
   */
  const sendRows = useCallback(
    async (
      target: {rootId?: string; replyToId?: string; reuseClientMsgId?: string},
      body: string,
      attachments?: MessageAttachment[],
      flags?: TimelineSendFlags,
    ) => {
      const {rootId, replyToId, reuseClientMsgId} = target;
      const channel = channelId;
      const expression = flags?.expression ?? null;
      if (
        channel === null ||
        (expression === null && body === '' && (attachments?.length ?? 0) === 0)
      ) {
        return;
      }
      // 이모티콘과 글을 한 번에(#5452): 표현 메시지 → 글 메시지. 표현이 없으면 메시지 하나이고 아래 행은 예전과 한 글자도 다르지 않다.
      const bundle =
        expression === null
          ? null
          : planSendBundle({
              expression,
              text: body,
              hasAttachments: (attachments?.length ?? 0) > 0,
              newId: () => crypto.randomUUID(),
            });
      if (bundle !== null && !bundle.ok) return;
      // 인용·첨부·링크 미리보기 끄기는 마지막 메시지(글)가 나른다. 표현 메시지는 `:이름:` 하나뿐이다(코어 `bundleCarriesOptions`).
      const makeRow = (
        clientMsgId: string,
        rowBody: string,
        carries: boolean,
        after?: string,
      ): PendingMessage => ({
        // `crypto.randomUUID()` — React Native has no `crypto` global at all, so
        // this call lands on the polyfill installed by `src/boot/polyfills.ts`
        // (RFC 4122 v4 over the platform CSPRNG). Without that import first,
        // every send would throw `ReferenceError` here.
        clientMsgId,
        channelId: channel,
        authorMemberId,
        body: rowBody,
        // Local clock, used only for grouping and the label on a row that has
        // not been ordered yet. Ordering still waits for seq.
        createdAtMs: Date.now(),
        sinceSeq: newestSeqRef.current,
        status: 'sending',
        ...(rootId === undefined ? {} : {rootId}),
        ...(carries && replyToId !== undefined ? {replyToId} : {}),
        ...(carries && attachments !== undefined && attachments.length > 0
          ? {attachments}
          : {}),
        ...(carries && flags?.suppressUnfurl === true ? {suppressUnfurl: true} : {}),
        ...(after === undefined ? {} : {after}),
      });
      const rows =
        bundle === null
          ? [makeRow(reuseClientMsgId ?? crypto.randomUUID(), body, true)]
          : bundle.messages.map((message, index) =>
              makeRow(
                message.clientMsgId,
                message.body,
                bundleCarriesOptions(bundle.messages, index),
                message.after,
              ),
            );
      updatePending(list => rows.reduce(addPending, list));
      await postChain(rows[0], false);
    },
    [channelId, authorMemberId, postChain, updatePending],
  );

  const send = useCallback(
    (
      body: string,
      replyToId?: string,
      attachments?: MessageAttachment[],
      reuseClientMsgId?: string,
      flags?: TimelineSendFlags,
    ) => sendRows({replyToId, reuseClientMsgId}, body, attachments, flags),
    [sendRows],
  );

  const ingest = useCallback(
    (message: Message) => {
      if (uuidEq(channelRef.current ?? undefined, message.channelId)) {
        applyBatch([message]);
      }
    },
    [applyBatch],
  );

  const resend = useCallback(
    async (clientMsgId: string) => {
      const row = pendingRef.current.find(p => p.clientMsgId === clientMsgId);
      if (!row || isSendingRow(row)) return;
      // 이모티콘 + 글 묶음의 뒤 메시지에서 눌러도 앞 메시지부터다(#5452): 뒤가 앞지르지 못한다. 묶음이 아니면 머리는 이 행 자신이다.
      const head = bundleHead(pendingRef.current, row);
      if (isSendingRow(head)) return;
      // The key is REUSED on purpose: a failed POST may still have committed
      // (a dropped response, a timeout), and the idempotency key is exactly what
      // turns that ambiguity into "the server returns the original message".
      updatePending(list => retryBundleTail(list, head.clientMsgId));
      await postChain(head, false);
    },
    [postChain, updatePending],
  );

  // 「모두 다시 보내기」(#5222): 이 대화의 실패한 글 전부를, 보낸 순서대로, 각자 **같은 멱등 키로 한 번씩**, 앞의 글이 끝난 뒤에 다음
  // 글을 보낸다(서버가 도착 순서로 seq 를 매기므로 뒤의 글이 앞서 나가지 않게). 네트워크로 또 실패하면 멈춘다: 서버에 닿지 못하는데 뒤의
  // 글을 계속 두드려도 같은 실패만 쌓인다. 서버가 거절한 글은 그 글만 실패로 남기고 이어 간다(`resendAllContinuesAfter`, 웹과 같은 판정).
  // 도는 동안 사람이 한 줄을 지웠거나 이미 나간 줄은 건너뛴다(그때그때 지금의 행을 다시 읽는다). 대상은 대화 화면 목록이 그리는 실패 행 전부다
  // (`isChannelListEcho`: 밀어서 보낸 답글의 실패 행도 목록에 서므로 포함한다, #4888) - 단추가 센 수와 보내는 수가 같다. 답글은 `post` 가 행의 `rootId` 로 답글 길을 탄다.
  const resendAll = useCallback(async () => {
    const failed = pendingRef.current.filter(
      row => isFailedRow(row) && isChannelListEcho(row),
    );
    for (const snapshot of failed) {
      const row = pendingRef.current.find(p => p.clientMsgId === snapshot.clientMsgId);
      if (!row || !isFailedRow(row)) continue;
      // 묶음의 뒤 메시지는 앞 메시지의 차례에 함께 나간다(#5452). 앞이 서버에 거절돼 남아 있어도 뒤가 앞지르지 않는다.
      if (!bundleMayPost(row, pendingRef.current)) continue;
      updatePending(list => retryBundleTail(list, row.clientMsgId));
      const sent = await postChain(row, false);
      if (!sent && !resendAllContinuesAfter(failuresRef.current.get(row.clientMsgId))) break;
    }
  }, [postChain, updatePending]);

  // 결정 ⑤: 네트워크로 못 보낸 글만 연결이 돌아오면 같은 멱등 키로 저절로 다시 보낸다(한 글 3회·5분). 한 번에 한 행이고, 실패하면
  // 다음 신호까지 쉰다. 기기가 꺼져 있다고 알면 신호를 기다린다. 판정은 코어 `pickAutoResends`(→ `judgeAutoResend`) 하나다.
  const autoRunningRef = useRef(false);
  const autoResendPass = useCallback(async () => {
    if (autoRunningRef.current || deviceOnlineNow() === false) return;
    autoRunningRef.current = true;
    try {
      for (;;) {
        const [id] = pickAutoResends(pendingRef.current, failuresRef.current, Date.now());
        const row = id === undefined ? undefined : pendingRef.current.find(p => p.clientMsgId === id);
        if (row === undefined) return;
        updatePending(list => retryBundleTail(list, row.clientMsgId));
        if (!(await postChain(row, true))) return;
      }
    } finally {
      autoRunningRef.current = false;
    }
  }, [postChain, updatePending]);

  // 「연결이 돌아왔다」는 신호 둘: 기기가 꺼졌다 켜졌다(NetInfo), 서버가 답했다(5xx 응답은 아니다). 실패한 행이 없으면 콜백은 아무 일도
  // 하지 않는다. S-A 모델이 「서버에 닿음」을 선언·해제하는 것과 같은 사실이다.
  useEffect(() => {
    const trigger = () => {
      void autoResendPass();
    };
    let wasOnline: boolean | null = null;
    const unsubscribeNet = NetInfo.addEventListener(netState => {
      const online = isOnlineFromNetInfo(netState);
      if (wasOnline === false && online) trigger();
      wasOnline = online;
    });
    const unsubscribeRest = subscribeRestOutcome(outcome => {
      if (isServerAnswer(outcome)) trigger();
    });
    return () => {
      unsubscribeNet();
      unsubscribeRest();
    };
  }, [autoResendPass]);

  const discard = useCallback(
    (clientMsgId: string): PendingMessage | null => {
      const result = discardPending(pendingRef.current, clientMsgId);
      if (result.discarded === null) return null;
      updatePending(() => result.list);
      // 지운 글은 이 기기의 저장본과 장부에서도 지운다(#5222): 지우지 않으면 다음에 이 채널을 열 때 되살아난다.
      forgetRow(result.discarded);
      return result.discarded;
    },
    [updatePending, forgetRow],
  );

  // 이 채널을 떠날 때(채널 이동·화면 닫힘)와 앱이 뒤로 갈 때(프로세스가 죽을 수 있다): 아직 날아가는 요청의 결과는 알 수 없다. 그 글을
  // 이 기기에 「못 보낸 글」로 남겨 돌아왔을 때 같은 키의 실패 행이 되게 한다(서버가 이미 받았다면 채널을 열 때 확정 메시지와 만나 정리된다).
  // 이미 실패한 행은 실패한 순간에 남겨 두었다. 스레드 답글의 행도 같다(#5262, `post` 의 같은 이유).
  useEffect(() => {
    if (!channelId) return;
    // 장부는 한 번 만든 Map 하나를 끝까지 쓴다(다시 대입하지 않는다). 정리 함수가 같은 Map 을 읽는다.
    const failures = failuresRef.current;
    const keepInFlight = (leaving: boolean) => {
      for (const row of pendingRef.current) {
        if (row.channelId !== channelId || !isSendingRow(row)) continue;
        if (leaving) orphansRef.current.add(row.clientMsgId);
        rememberFailedSend(workspaceId, row, null);
      }
    };
    const stopWatching = onAppBackground(() => keepInFlight(false));
    return () => {
      stopWatching();
      keepInFlight(true);
      // 떠난 채널 행의 기록은 더 읽는 곳이 없다(돌아오면 남겨 둔 저장본에서 새로 만든다).
      let changed = false;
      for (const row of pendingRef.current) {
        if (row.channelId === channelId && failures.delete(row.clientMsgId)) changed = true;
      }
      if (changed) syncFailureKinds();
    };
  }, [workspaceId, channelId, syncFailureKinds]);

  // ---- message actions (goal RN-C5) -----------------------------------------

  const applyReaction = useCallback((change: ReactionChange) => {
    reactionsRef.current = applyReactionDelta(reactionsRef.current, change);
    setReactions(reactionsRef.current);
  }, []);

  const applyPins = useCallback((next: PinMap) => {
    pinsRef.current = next;
    setPins(next);
  }, []);

  /**
   * Read the channel's pins (이슈 #1146 M2).
   *
   * The read is here rather than inline in the channel effect because the
   * failure now has a retry behind it, and that retry is pressed from outside
   * that effect's closure. `pinReadRef` is what the effect's `cancelled` flag
   * was doing for it: a slow reply from the channel you just left, or from the
   * read a retry superseded, must not write over the one you are in.
   */
  const loadPins = useCallback(
    (channel: string) => {
      const read = ++pinReadRef.current;
      setPinsStatus('loading');
      fetchChannelPins(workspaceId, channel)
        .then(wire => {
          if (pinReadRef.current !== read) return;
          // Merge on the same side as the reaction snapshot: a `message.pinned`
          // that arrived while this was in flight is strictly newer than the
          // read it raced, so it wins.
          applyPins({...normalizePinList(wire), ...pinsRef.current});
          setPinsStatus('ready');
        })
        .catch(() => {
          if (pinReadRef.current !== read) return;
          // The channel stays fully usable — that judgement has not changed.
          // What changes is that the list now says so instead of claiming the
          // channel has no pins.
          setPinsStatus('failed');
        });
    },
    [workspaceId, applyPins],
  );

  /**
   * Pin or unpin one message (이슈 #1112).
   *
   * **Asymmetrically optimistic, and the asymmetry is the design.** An unpin is
   * applied at once — the entry to remove is already in hand, so the revert is
   * exact. A pin is not: the row the list draws is the server's projection, and
   * `pinnedAtMs` in particular is what the list sorts on, so a locally invented
   * one would seat the entry in the wrong place until a reload. That is a worse
   * lie than a half-second wait, and it is why this direction takes the delta
   * the server answers with, exactly as `editBody` takes the row.
   */
  const togglePin = useCallback(
    async (message: Message) => {
      if (isPinned(pinsRef.current, message.id)) {
        const previous = pinsRef.current;
        applyPins(removePin(previous, message.id));
        try {
          await setPin(workspaceId, message.id, 'unpinned');
        } catch (error) {
          applyPins(previous);
          throw error;
        }
        return;
      }
      const delta = await setPin(workspaceId, message.id, 'pinned');
      if (delta.pinned) applyPins(applyPinned(pinsRef.current, delta.pinned));
    },
    [workspaceId, applyPins],
  );

  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      // Derived, never remembered: the optimistic write and the request read the
      // same map at the same instant, so they cannot disagree about direction.
      const action = toggleDirection(
        reactionsRef.current,
        message.id,
        authorMemberId,
        emoji,
      );
      const change: ReactionChange = {
        messageId: message.id,
        memberId: authorMemberId,
        emoji,
        action,
      };
      applyReaction(change);
      try {
        await setReaction(workspaceId, message.id, emoji, action);
        if (action === 'added') expressionStore?.recordSuccess(`reaction:${message.id}:${emoji}:${Date.now()}`, emoji);
      } catch (error) {
        // Put it back, and say so on the row. The inverse is safe even if the
        // realtime echo of a successful twin already landed: the delta is
        // idempotent, so an unnecessary revert is a no-op rather than a second
        // wrong write.
        applyReaction({
          ...change,
          action: action === 'added' ? 'removed' : 'added',
        });
        throw error;
      }
    },
    [workspaceId, authorMemberId, applyReaction, expressionStore],
  );

  const editBody = useCallback(
    async (message: Message, body: string) => {
      const updated = await editMessageRequest(workspaceId, message.id, body);
      // 응답은 편집 투영이다(롤업·풀린 인용·첨부가 없다). 든 줄만 갱신한다 — 방을 옮긴 뒤 도착한
      // 응답이 지금 방의 타임라인에 끼지 않는다(#4450).
      applyEdited(updated);
    },
    [workspaceId, applyEdited],
  );

  const removeMessage = useCallback(
    async (message: Message) => {
      const tombstone = await deleteMessageRequest(workspaceId, message.id);
      applyBatch([tombstone]);
      // The server deletes the reaction rows with the message, so chips for a
      // tombstone would be counts for rows that no longer exist.
      reactionsRef.current = clearMessageReactions(
        reactionsRef.current,
        message.id,
      );
      setReactions(reactionsRef.current);
      applyPins(removePin(pinsRef.current, message.id));
      clearUnfurls(message.id);
    },
    [workspaceId, applyBatch, applyPins, clearUnfurls],
  );

  const loadReplies = useCallback(
    async (rootId: string): Promise<ThreadRepliesLoad> => {
      const channel = channelRef.current;
      if (channel === null) return {following: false};
      let cursor: number | undefined;
      let following = false;
      // Ascending pages until the server stops offering one. Replies are ordinary
      // channel messages, so every page lands in the same seq-ordered state the
      // channel is drawn from — loading a thread also heals the channel.
      for (;;) {
        const page = await fetchThreadReplies(
          workspaceId,
          channel,
          rootId,
          cursor,
        );
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channel);
        // 모든 쪽이 내 따라가기 상태를 싣는다. 가장 나중에 읽은 쪽의 값이 가장 새 값이다.
        following = page.following === true;
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
      return {following};
    },
    [workspaceId, applyBatch, hydrateUnfurls],
  );

  const sendReply = useCallback(
    (rootId: string, body: string, attachments?: MessageAttachment[], flags?: TimelineSendFlags) =>
      sendRows({rootId}, body, attachments, flags),
    [sendRows],
  );

  const repliesPending = useCallback(
    (rootId: string) => pending.filter(row => row.rootId === rootId),
    [pending],
  );

  // The channel list shows a reply's echo only where the reply is (or will be) a main-flow row, or where its failure
  // has nowhere else to be seen (#4888). A thread-only reply in flight belongs to the thread that is open over it — a
  // row in both places would be the same message told twice — but a reply sent from the swipe never opens a thread,
  // so when it FAILS the person must hear it here, with the same retry (same `client_msg_id`) and ✕ (#5210).
  // An also-sent reply's echo stands in the channel from the start, so the confirmed row does not pop in.
  const channelPending = useMemo(() => pending.filter(isChannelListEcho), [pending]);

  const backfillAfter = useCallback(
    async (
      channel: string,
      stillCurrent: () => boolean = () => true,
      // 어디서부터 메우는가. 주지 않으면 지금 든 가장 새 행 뒤다. 머리 페이지를
      // 기다린 역채움은 **머리의 끝**을 준다(#2633) — 그 사이 레일이 가져온 행 뒤에서
      // 시작하면, 머리와 레일 사이에 커밋된 행을 영영 건너뛴다. `null` 은 빈 방이다.
      from?: number | null,
    ) => {
      let after =
        from === undefined ? (newestSeqRef.current ?? 0) : (from ?? 0);
      let total = 0;
      let verdict = NO_RECOVERY;
      for (;;) {
        const page = await fetchMessages(workspaceId, channel, {
          after,
          limit: PAGE_LIMIT,
        });
        if (!stillCurrent()) break;
        if (page.messages.length === 0) break;
        total += page.messages.length;
        // 이 읽기가 **새로** 들여온 남의 줄 — 병합 **전**에 코어가 판정한다. 읽는 사이 이미 들어온 줄(내 REST 응답, 레일)과 내 줄은
        // 복구한 것이 아니다(#4292).
        verdict = judgeRecoveryMarker(
          page.messages,
          knownIdsRef.current,
          authorRef.current,
          verdict,
        );
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channel);
        const maxSeq = page.messages.reduce((m, x) => Math.max(m, x.seq), after);
        if (maxSeq <= after) break;
        after = maxSeq;
        if (page.messages.length < PAGE_LIMIT) break;
      }
      return {fetched: total, verdict};
    },
    [workspaceId, applyBatch, hydrateUnfurls],
  );

  useEffect(() => {
    channelRef.current = channelId;
    return () => {
      sendEpochRef.current += 1;
    };
  }, [channelId, workspaceId]);

  const catchUp = useCallback(async () => {
    const channel = channelRef.current;
    if (!channel) return;
    await backfillAfter(channel, () => channelRef.current === channel);
  }, [backfillAfter]);

  // Drop echoes whose confirmed twin has landed in the seq stream even though
  // the POST that created them never resolved. That case is real: if the write
  // committed but the response was lost, the realtime frame delivers the row and
  // the echo is settled by content, while the request may hang until its
  // deadline. The render fold already hides such a row; without this the entry
  // would sit in state for the rest of the session, reported as still sending.
  useEffect(() => {
    const open = unsettledPending(state.messages, pendingRef.current);
    if (open.length !== pendingRef.current.length) {
      // 정착한 행은 이 기기의 저장본에서도 지운다(되살아난 실패 행이 사실은 서버에 있던 글인 경우가 이것이다, #5222).
      const keep = new Set(open.map(p => p.clientMsgId));
      for (const row of pendingRef.current) {
        if (!keep.has(row.clientMsgId)) forgetRow(row);
      }
      updatePending(() => open);
    }
  }, [state.messages, updatePending, forgetRow]);

  useEffect(() => {
    if (!channelId || !rail) return;
    let cancelled = false;
    firstSubscribeRef.current = true;
    newestSeqRef.current = null;
    knownIdsRef.current = new Set();
    replayWatchRef.current = null;
    markerCounterRef.current = 0;
    // 이 기기가 남겨 둔 이 채널의 못 보낸 글을 실패 행으로 되살린다(#5222). 되살린 행은 자동 재전송 대상이 아니다(처음 실패한 때를 몰라
    // 5분을 셀 수 없다): 장부에는 원인 한 줄의 종류만 남긴다. 다른 채널·지난 목록의 기록은 걷는다.
    const restored = readFailedSends(workspaceId, channelId, authorMemberId);
    const restoredIds = new Set(restored.map(r => r.row.clientMsgId));
    for (const id of [...failuresRef.current.keys()]) {
      if (!restoredIds.has(id)) failuresRef.current.delete(id);
    }
    for (const {row, kind} of restored) {
      if (!failuresRef.current.has(row.clientMsgId)) {
        failuresRef.current.set(row.clientMsgId, {
          failure: null,
          kind,
          firstFailedAt: row.createdAtMs,
          autoAttempts: 0,
        });
      }
    }
    syncFailureKinds();
    updatePending(() => restored.map(r => r.row));
    setState(emptyTimeline());
    setStatus('loading');
    setLoadedChannelId(null);
    setReachedStart(false);
    setRecoveryMarkers([]);
    setResume({lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0});
    reactionsRef.current = emptyReactions();
    setReactions(reactionsRef.current);
    applyPins(emptyPins());
    resetUnfurls();

    // 복구되지 않은 (재)구독은 REST 로 꼬리를 메운다. 머리 페이지가 이미 왔으면
    // 곧바로, 아직이면 **머리가 온 뒤** 그 끝에서(#2633).
    //
    // 레일의 답(웹소켓 한 왕복)은 머리 읽기(HTTP·DB 한 왕복)보다 먼저 오기 쉽다. 그때
    // 곧바로 메우면 기준 seq 가 없어(`newestSeqRef` = null) `after=0` 에서 시작하고,
    // 가득 찬 페이지가 오는 동안 계속 읽는다 — 방을 열 때마다 방의 처음부터
    // 끝까지다(#2584 R3 관찰 1). 머리를 기다려도 잃는 것은 없다: 머리가 나간 뒤
    // 커밋된 행은 머리의 끝 뒤를 읽는 이 한 번이 가져오고, 구독 뒤의 행은 레일이
    // 가져온다. 머리 읽기가 실패하면 메우지 않는다 — 다시 읽기가 처음부터 다시 한다.
    let headLanded = false;
    let backfillOnHead: 'first' | 'resubscribe' | null = null;
    const healTail = (isFirst: boolean, from?: number | null) => {
      backfillAfter(channelId, () => !cancelled, from)
        .then(({fetched, verdict}) => {
          if (cancelled || isFirst) return;
          setResume(r => ({...r, lastBackfillCount: fetched}));
          // 표지는 「끊겼던 구간이 있었고, 다른 사람(또는 에이전트)의 새 메시지로 그것을 메웠다」는 말이다. 꼬리를 읽었더니 빈손이거나
          // 온 것이 전부 이미 든 줄·내 줄이면 메운 것이 없으므로 할 말도 없다 — 그 줄을 세우면 메시지가 하나도 안 왔는데(또는 방금 내가
          // 보낸 줄 아래에) 행이 붙었다 12초 뒤 걷히며 목록이 그만큼 미끄러졌다 돌아온다. 소켓이 흔들리는 서버 쪽 사고는 모든 기기에
          // **한꺼번에** 닿으므로, 같은 DM 을 연 두 사람이 같은 시각에 대화 화면이 흔들리는 것을 본다(#4292).
          if (verdict.show) addMarker('backfill');
        })
        .catch(() => {
          /* the rail is live again; the next resubscribe heals it */
        });
    };

    // 1) REST head (descending page; the merge is order-agnostic).
    fetchMessages(workspaceId, channelId, {limit: HEAD_LIMIT})
      .then(page => {
        if (cancelled) return;
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channelId);
        setReachedStart(page.nextBefore === undefined);
        setStatus('ready');
        setLoadedChannelId(channelId);
        headLanded = true;
        if (backfillOnHead !== null) {
          const isFirst = backfillOnHead === 'first';
          backfillOnHead = null;
          const headEnd = page.messages.reduce<number | null>(
            (max, message) =>
              max === null || message.seq > max ? message.seq : max,
            null,
          );
          healTail(isFirst, headEnd);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    // 1b) The channel's reaction map, in parallel and deliberately not fatal. A
    // channel whose messages loaded but whose chips did not is one you can still
    // read and still send in; failing the whole surface would trade it for an
    // annotation.
    fetchReactionSnapshot(workspaceId, channelId)
      .then(wire => {
        if (cancelled) return;
        // Merge rather than replace: a reaction that arrived on the rail while
        // this request was in flight would otherwise be erased by an older
        // snapshot.
        const cold = normalizeReactionSnapshot(wire);
        reactionsRef.current = {...cold, ...reactionsRef.current};
        setReactions(reactionsRef.current);
      })
      .catch(() => {
        /* chips stay empty; the channel is still fully usable */
      });

    // 1c) The channel's pins, on the same terms: in parallel, and not fatal. A
    // pin list that failed to load is an absent accessory; a channel that
    // refuses to open because of one is a broken app.
    // 이슈 #1146 M2 — 「absent」 is now something the list can say out loud.
    loadPins(channelId);

    // 2) The realtime rail, with resume healing.
    const unsub = rail.subscribeChannel(workspaceId, channelId, {
      onSubscribed: ctx => {
        if (cancelled) return;
        const recovered = ctx.recovered === true;
        const isFirst = firstSubscribeRef.current;
        firstSubscribeRef.current = false;
        setResume(r => ({
          ...r,
          lastRecovered: recovered,
          resubscribeCount: r.resubscribeCount + (isFirst ? 0 : 1),
        }));
        if (!recovered) {
          // A non-recovered (re)subscribe may have missed publications: pull the
          // authoritative tail from Postgres. Safe on first subscribe too — but
          // only from a known baseline: before the head has landed there is none,
          // so the heal waits for it (#2633, above).
          if (headLanded) {
            healTail(isFirst);
          } else {
            backfillOnHead =
              isFirst && backfillOnHead !== 'resubscribe' ? 'first' : 'resubscribe';
          }
        } else if (!isFirst) {
          // The transport replayed the gap. centrifuge-js flushes recovered
          // publications synchronously right after `subscribed`, so the marker
          // is queued behind that flush to state how far the timeline was
          // restored rather than how far it had got before it.
          //
          // 되쏜 것이 **다른 사람(또는 에이전트)의 새 메시지**를 들여왔을 때만 선다(#4292). `recovered: true` 는 「끊긴 구간을 이을 수
          // 있었다」일 뿐 그 구간에 무엇이 있었다는 말이 아니다 — 비어 있던 구간(아무도 말하지 않았다)의 복구에도 참이다. 되쏜 것이
          // 전부 이미 든 줄(내 REST 응답이 먼저 왔다)이거나 내 줄뿐이어도 복구한 것이 없다. 그때 표지를 세우면 행이 하나 붙었다 걷힌다.
          // 되쏜 줄은 이 동기 flush 안에서 `applyBatch` 를 지나므로 그 문이 센다.
          const watch = {verdict: NO_RECOVERY};
          replayWatchRef.current = watch;
          queueMicrotask(() => {
            if (replayWatchRef.current === watch) replayWatchRef.current = null;
            if (cancelled) return;
            if (watch.verdict.show) addMarker('replay');
          });
        }
      },
      onMessage: (event: MessageNewEvent) => {
        if (cancelled) return;
        const message = payloadToMessage(event.payload);
        // 편집 투영은 든 줄만 갱신한다(#4450): `applyEdited` 가 코어 판정을 지난다.
        if (event.type === 'message.edited') {
          applyEdited(message);
          return;
        }
        applyBatch([message]);
      },
      // A tombstone marks the row it names in place. It cannot go through
      // `applyBatch`: the frame carries only an id (by design, so a delete never
      // re-broadcasts the body it erased) and the row must keep its seq.
      onMessageDeleted: event => {
        if (cancelled) return;
        const messageId = event.payload.message_id;
        setState(s => applyTombstone(s, messageId, event.ts));
        reactionsRef.current = clearMessageReactions(
          reactionsRef.current,
          messageId,
        );
        setReactions(reactionsRef.current);
        // …and its pin, which the server swept with the message. No
        // `message.unpinned` is published for a delete, so this is the only
        // place the pin list learns about it.
        applyPins(removePin(pinsRef.current, messageId));
        clearUnfurls(messageId);
      },
      onReaction: event => {
        if (cancelled) return;
        reactionsRef.current = applyReactionDelta(reactionsRef.current, {
          messageId: event.payload.message_id,
          memberId: event.payload.member_id,
          emoji: event.payload.emoji,
          action: event.payload.action,
        });
        setReactions(reactionsRef.current);
      },
      // 이슈 #1112 — the pin list stays live off these two frames alone. The
      // `message.pinned` payload IS the list entry, so nothing here re-reads
      // the list to find out what was pinned.
      onPin: event => {
        if (cancelled) return;
        if (event.type === 'message.pinned') {
          applyPins(
            applyPinned(pinsRef.current, pinnedPayloadToWire(event.payload)),
          );
        } else {
          applyPins(removePin(pinsRef.current, event.payload.message_id));
        }
      },
      // ADR-0170 D5 — 서버가 만든 카드(또는 작성자의 지우기)가 같은 레일로 온다. 전체 투영이라 통째로 바꾼다.
      onUnfurl: event => {
        if (cancelled) return;
        applyUnfurlFrame(event);
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [
    rail,
    workspaceId,
    channelId,
    backfillAfter,
    applyBatch,
    applyEdited,
    applyPins,
    loadPins,
    addMarker,
    updatePending,
    hydrateUnfurls,
    resetUnfurls,
    applyUnfurlFrame,
    clearUnfurls,
    reloadNonce,
    authorMemberId,
    syncFailureKinds,
  ]);

  /**
   * Read the list again (이슈 #1146 M2).
   *
   * Deliberately **not** `reload()`. That one re-runs the whole channel —
   * history, rail, subscription — and the person pressing this button is
   * answering one sentence about one accessory. Rebuilding the conversation
   * under them to refill a list would throw away their scroll position, which
   * on a phone is the thing hardest to get back.
   */
  const reloadPins = useCallback(() => {
    if (channelId) loadPins(channelId);
  }, [channelId, loadPins]);

  const loadOlder = useCallback(async () => {
    if (!channelId || loadingOlder || reachedStart) return;
    const oldest = state.oldestSeq;
    if (oldest === null) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(workspaceId, channelId, {
        before: oldest,
        limit: PAGE_LIMIT,
      });
      // 위로 읽은 쪽은 `applyBatch` 를 지나지 않는다 — 그 줄의 id 도 「이미 든 줄」이다(끊긴 사이 그 오래된 줄이 수정돼 되쏘기로 오면 새 줄이 아니다).
      for (const message of page.messages) knownIdsRef.current.add(messageIdKey(message.id));
      setState(s => reconcileMessages(s, page.messages));
      hydrateUnfurls(page.messages, channelId);
      if (page.nextBefore === undefined) setReachedStart(true);
    } catch {
      // Silent: the rows already on screen are still true, and the person can
      // pull again. Replacing a readable timeline with an error because its
      // NEXT page failed is the trade `status: "error"` is reserved for.
    } finally {
      setLoadingOlder(false);
    }
  }, [
    workspaceId,
    channelId,
    state.oldestSeq,
    loadingOlder,
    reachedStart,
    hydrateUnfurls,
  ]);

  const seekOlder = useCallback(
    async (untilSeq: number, isCancelled: () => boolean): Promise<SeekOutcome> => {
      const startedIn = channelId;
      const from = state.oldestSeq;
      if (!startedIn || from === null) return SeekOutcome.Failed;
      if (reachedStart) return SeekOutcome.Start;
      // 읽는 동안 손으로 올리는 읽기(`loadOlder`)가 같은 쪽을 또 읽지 않게 한다.
      setLoadingOlder(true);
      try {
        const pages: Message[] = [];
        let cursor = from;
        let outcome: SeekOutcome = SeekOutcome.Capped;
        let atStart = false;
        for (let turn = 0; turn < SEEK_MAX_PAGES; turn += 1) {
          if (isCancelled() || channelRef.current !== startedIn) return SeekOutcome.Cancelled;
          const page = await fetchMessages(workspaceId, startedIn, {
            before: cursor,
            limit: seekPageLimit(cursor, untilSeq),
          });
          // 늦게 온 답은 버린다: 접었거나 방을 옮겼다.
          if (isCancelled() || channelRef.current !== startedIn) return SeekOutcome.Cancelled;
          pages.push(...page.messages);
          const lowest = page.messages.reduce<number | null>(
            (min, message) => (min === null || message.seq < min ? message.seq : min),
            null,
          );
          // 서버는 비어 있지 않은 쪽에는 언제나 `nextBefore`(그 쪽의 가장 작은 seq)를 싣는다. 없으면 더 오래된 줄이 없다(`loadOlder` 와 같은 판정).
          atStart = page.nextBefore === undefined;
          if (lowest !== null && lowest <= untilSeq) {
            outcome = SeekOutcome.Arrived;
            break;
          }
          if (atStart) {
            outcome = SeekOutcome.Start;
            break;
          }
          cursor = page.nextBefore ?? cursor;
        }
        if (outcome === SeekOutcome.Arrived || outcome === SeekOutcome.Start) {
          // 닿은 끝만 합친다. 위로 읽은 쪽은 `applyBatch` 를 지나지 않는다 - `loadOlder` 와 같은 이유다.
          for (const message of pages) knownIdsRef.current.add(messageIdKey(message.id));
          setState(s => reconcileMessages(s, pages));
          hydrateUnfurls(pages, startedIn);
          if (atStart) setReachedStart(true);
        }
        return outcome;
      } catch {
        return SeekOutcome.Failed;
      } finally {
        setLoadingOlder(false);
      }
    },
    [workspaceId, channelId, state.oldestSeq, reachedStart, hydrateUnfurls],
  );

  const reload = useCallback(() => setReloadNonce(n => n + 1), []);

  const applyThreadRead = useCallback((rootId: string, read: ThreadReadState) => {
    setState(s => applyThreadReadState(s, rootId, read));
  }, []);

  return {
    state,
    status,
    loadedChannelId,
    catchUp,
    resume,
    recoveryMarkers,
    pending: channelPending,
    send,
    ingest,
    resend,
    resendAll,
    failureKinds,
    discard,
    toggleReaction,
    editBody,
    removeMessage,
    loadReplies,
    applyThreadRead,
    sendReply,
    repliesPending,
    loadOlder,
    seekOlder,
    reload,
    loadingOlder,
    reachedStart,
    reactions,
    pins,
    pinsStatus,
    reloadPins,
    togglePin,
    unfurls,
    removeUnfurls,
  };
}
