import { useExpressions } from "@/features/expressions/context";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  pruneRecoveryMarkers,
  RECOVERY_MARKER_TTL_MS,
} from "@momo/core/features/timeline/divider";
import {
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  fetchChannelPins,
  fetchMessageUnfurls,
  fetchMessages,
  fetchReactionSnapshot,
  removeMessageUnfurls,
  sendMessage,
  setPin,
  setReaction,
  uuidEq,
  type Message,
  type MessageAttachment,
  type SendMessageOptions,
  type ThreadReadState,
} from "@momo/core/lib/api";
import {
  payloadToMessage,
  pinnedPayloadToWire,
  type RealtimeHandle,
} from "@/lib/realtime";
import { subscribeRestOutcome } from "@momo/core/lib/http";
import { causeOfFailure } from "@momo/core/features/connection/failure";
import type { ConnectionCause } from "@momo/core/features/connection/model";
import { deviceOnlineNow } from "@/lib/deviceOnline";
import {
  bundleCarriesOptions,
  bundleHead,
  bundleMayPost,
  failBundleTail,
  planSendBundle,
  postBundleInOrder,
  retryBundleTail,
  type BundlePoster,
} from "@momo/core/features/expressions/sendBundle";
import type { Expression } from "@momo/core/features/expressions/types";
import {
  BROWSER_ONLINE_EVENT,
  PAGE_LEAVE_EVENT,
  isFailedRow,
  isSendingRow,
  isServerAnswer,
  pickAutoResends,
  recordSendFailure,
  resendAllContinuesAfter,
  type SendFailureKind,
  type SendFailureRecord,
} from "@momo/core/features/connection/sendFailure";
import {
  forgetFailedSend,
  readFailedSends,
  rememberFailedSend,
} from "@/features/chat/draftStore";
import {
  addPending,
  applyEditedMessage,
  applyTombstone,
  discardPending,
  emptyTimeline,
  failPending,
  pinSettledEchoes,
  reconcileMessages,
  removePending,
  unsettledPending,
  type EchoPins,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineState,
} from "@momo/core/features/timeline/model";
import { observeServerClock, serverClockOffsetNowMs } from "@momo/core/features/timeline/serverClock";
import {
  MAX_CONSUMED_ARRIVAL_IDS,
  MAX_PENDING_ARRIVAL_GRANTS,
  capArrivalSet,
  takeArrivalPlay,
  type ArrivalEventType,
  type MessageArrivalProvenance,
} from "@momo/core/features/timeline/arrival";
import { createReplayGate } from "@momo/core/lib/realtimeEvents";
import {
  judgeRecoveryMarker,
  messageIdKey,
  NO_RECOVERY,
  type RecoveryMarkerVerdict,
} from "@momo/core/features/timeline/recoveryMarker";
import {
  runPersonalAgentCall,
  type PersonalCallSpec,
} from "@/features/work/personalAgentCalling";
import { prefersReducedMotion } from "@/app/sidebarPane";
import {
  applyReactionDelta,
  clearMessageReactions,
  emptyReactions,
  normalizeReactionSnapshot,
  toggleDirection,
  type ReactionMap,
} from "@momo/core/features/timeline/reactions";
import {
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  removePin,
  type PinListStatus,
  type PinMap,
} from "@momo/core/features/timeline/pins";
import { endedStreamRunIds } from "@momo/core/features/timeline/streamStop";
import { applyThreadReadState } from "@momo/core/features/timeline/threadSummary";
import { seedEndedRuns } from "@/features/agents/endedRuns";
import {
  clearMessageUnfurls,
  emptyUnfurls,
  mergeColdMessageUnfurls,
  messageMayHaveUnfurls,
  replaceMessageUnfurls,
  type MessageUnfurl,
  type UnfurlMap,
} from "@momo/core/features/timeline/unfurl";

/** Bottom-side pair of `MAX_PENDING_ARRIVAL_GRANTS` (scroll-up leftover cap 1).
 *  ADR-0179 D3 erratum: same-tick live arrivals at the bottom play at most 3;
 *  the rest settle immediately. Stagger is out of ladder. */
export const MAX_SIMULTANEOUS_ARRIVALS = 3;

const HEAD_LIMIT = 50;
const PAGE_LIMIT = 50;

/**
 * 옛 쪽 읽기가 `failures` 번 이어 실패한 뒤, 맨 위 닿음으로 다시 읽기까지 둘 간격(#5662): 1초에서 두 배씩, 30초에서 멈춘다.
 * 「다시 시도」 단추는 이 간격을 넘는다.
 */
export function olderRetryGapMs(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
}


export interface ResumeInfo {
  /** How the last (re)subscribe resolved. */
  lastRecovered: boolean | null;
  /** Messages recovered by the last REST `?after` backfill after a gap. */
  lastBackfillCount: number;
  resubscribeCount: number;
}

/**
 * 컴포저가 전송에 실을 수 있는 것들.
 *
 * 와이어의 `SendMessageOptions`와 한 자리만 다르다: 그쪽은 첨부를 **id 배열**로
 * 받고 이쪽은 **행 전체**를 받는다. 이유는 낙관적 echo 다 — id 만으로는 이름도
 * 크기도 없어서 카드를 그릴 수 없고, 그 값들은 컴포저가 이미 손에 들고 있다.
 * id 로 줄이는 것은 `post`가 요청을 만들 때 한 번 한다.
 */
export interface TimelineSendOptions
  extends Omit<SendMessageOptions, "attachmentIds"> {
  attachments?: MessageAttachment[];
  /**
   * 소유자가 자기 개인 에이전트를 불렀다(#3653). 같은 낙관적 echo로 메시지를 보낸 뒤,
   * 커밋된 메시지 id를 서명해 내 맥을 부른다. 재시도(`resend`)도 같은 갈래로 들어온다.
   */
  personalCall?: PersonalCallSpec;
  /**
   * #5453 - 입력창 위에서 미리 본 큰 표현(이모티콘·GIF). 있으면 이 보내기는 **메시지 둘**이다: 표현 메시지(`:이름:` 하나, ADR-0218 D1 그대로) 다음에 글
   * 메시지. 둘은 서로 다른 멱등 열쇠를 쓰고, 글 메시지는 표현 메시지가 확정되기 전에는 나가지 않는다(코어 `sendBundle.ts`). 인용·라우팅·첨부·링크
   * 미리보기 끄기·개인 에이전트 호출은 글 메시지가 나른다(글이 비면 표현 메시지가 나른다). 없으면 예전과 한 글자도 다르지 않다.
   */
  expression?: Expression;
}

export interface UseTimelineResult {
  state: TimelineState;
  status: "loading" | "ready" | "error";
  /**
   * 머리 읽기가 실패했을 때 그 실패가 말하는 원인(#5221). 연결 쪽 원인이 아니면(서버가 직접 거절했거나 알 수 없음) `null`.
   * `status`가 `error`가 아니면 항상 `null`이다.
   */
  loadCause: ConnectionCause | null;
  resume: ResumeInfo;
  /** Reconnect markers, rendered inline as "재연결됨, 여기까지 복구" — one per recovery that brought in someone else's new messages (#4328). */
  recoveryMarkers: RecoveryMarker[];
  /** Local echoes awaiting their server seq (M10). Never inside `state`. */
  pending: PendingMessage[];
  /** #5624 — 에코였던 확정본이 이 화면에서 이어 쓰는 에코의 시각. `buildTimelineItems`의 `echoPins`로 넘긴다. */
  echoPins: EchoPins;
  /** #5624 — 서버 시계와 이 기기 시계의 차이(ms). `buildTimelineItems`의 `serverOffsetMs`·에코의 시각 글자로 넘긴다. */
  serverOffsetMs: number;
  /**
   * The one send path: optimistic echo now, server seq when it lands.
   * `routing` is the composer's per-request override (ADR-0134 D1) and
   * `replyToId` is ADR-0148's quote binding; both ride the pending row so a
   * retry re-sends what the person actually chose rather than quietly falling
   * back to the inherited value or dropping the quote.
   */
  send: (body: string, options?: TimelineSendOptions) => Promise<void>;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  /**
   * 보내지 못한 메시지를 이 기기에서만 지운다(#5210). 판정은 코어 `discardPending` 이고
   * 서버로 가는 길이 없다. 지운 행을 돌려주고, 지우지 않았으면(보내는 중·이미 없음) null.
   */
  discard: (clientMsgId: string) => PendingMessage | null;
  /**
   * 실패한 모든 행을 보낸 순서대로 같은 키로 다시 보낸다(#5221). 손으로 누른 것이므로 서버가 거절했던 글도 포함한다.
   * 네트워크로 또 실패하면 멈춘다(뒤의 글이 앞의 글을 앞지르지 않게). 서버가 거절한 글은 건너뛰고 이어 간다.
   */
  resendAll: () => Promise<void>;
  /** 실패한 행마다 원인 한 줄의 종류(#5221). 알 수 없는 오류는 항목이 없다. 되살린 행도 남겨 둔 종류가 돌아온다. */
  failureKinds: ReadonlyMap<string, SendFailureKind>;
  /**
   * 맨 위에 닿았을 때의 옛 쪽 읽기. 거부하지 않는다(실패는 `olderFailed`). 이미 읽는 중이면 하나 더 내지 않고, 실패가 이어지면
   * 닿을 때마다 바로 다시 내지 않고 간격을 둔다(#5662).
   */
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /** 마지막 옛 쪽 읽기가 실패했다(#5662). 다음 읽기가 성공하거나 대화를 바꾸면 내려간다. */
  olderFailed: boolean;
  /** 실패 줄의 「다시 시도」(#5662): 연속 실패 간격 없이 바로 읽는다. 읽는 중이면 아무것도 하지 않는다. */
  retryOlder: () => void;
  /** B11 — `message id -> emoji -> member ids`, case-folded on ingest. */
  reactions: ReactionMap;
  /**
   * Toggle my reaction on one message. Optimistic, and reverted on failure —
   * the caller surfaces the refusal as a sentence.
   */
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
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
   * Pin or unpin one message. Optimistic only in the unpin direction — see the
   * implementation for why a pin waits for the server.
   */
  togglePin: (message: Message) => Promise<void>;
  /**
   * Rewrite my own message. The answer is an edit projection: it updates the row
   * I hold in place (the read decorations it does not carry stay) and is dropped
   * if I do not hold that row (#4450).
   */
  editMessage: (message: Message, body: string) => Promise<void>;
  /** Soft-delete my own message. The tombstone replaces the local row. */
  deleteMessage: (message: Message) => Promise<void>;
  /** ADR-0170 — author-only removal; success also tombstones regeneration. */
  removeUnfurls: (message: Message) => Promise<void>;
  /** Server projection keyed by case-folded message id. */
  unfurls: UnfurlMap;
  /** ADR-0179 D3 — live-arrival grant still waiting for first mount. */
  isPlayEntrance: (messageId: string) => boolean;
  consumeEntrance: (messageId: string) => void;
  /**
   * 스레드 패널이 보낸 「여기까지 읽었어요」의 응답을 **든 루트**의 요약에 반영한다(#4878, #4889 2단계) —
   * 따라가는 스레드면 안 읽은 수를 서버 값으로 맞춰 「새 답글 M」 칩이 사라지게 하고, 아니면 값을 지운다.
   */
  applyThreadRead: (rootId: string, read: ThreadReadState) => void;
  /**
   * Evict unmounted leftover grants (scrolled-up backlog). Timeline calls
   * this when the reader is not at the bottom. Mounted rows consume
   * themselves; a paint-tick cap would race virtuoso's later commit.
   */
  capUnmountedArrivals: () => void;
}

/**
 * Loads channel history head, subscribes the realtime rail, heals gaps via REST
 * `?after` backfill on a non-recovered resubscribe, and owns the send path.
 * `seq` is the sole ordering authority throughout (reconcileMessages).
 *
 * A heal that brought in other people's (or agents') new messages also records
 * a RecoveryMarker so the timeline can state exactly how far it was restored,
 * which is only possible because the server issues a monotonic seq (R-1 §3).
 * A heal that brought in nothing new from anyone else — an empty gap, only my
 * own lines, or lines the timeline already held — records no marker: there is
 * nothing to state, and the marker row would slide the list for 12 seconds and
 * back. The judgement is core's (`judgeRecoveryMarker`, #4328), shared with the
 * phone; this hook only keeps the ids it has held and the replay window.
 */
export function useTimeline(
  realtime: RealtimeHandle | null,
  workspaceId: string,
  channelId: string | null,
  authorMemberId: string
): UseTimelineResult {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<UseTimelineResult["status"]>("loading");
  const [loadCause, setLoadCause] = useState<ConnectionCause | null>(null);
  const [resume, setResume] = useState<ResumeInfo>({
    lastRecovered: null,
    lastBackfillCount: 0,
    resubscribeCount: 0,
  });
  const [recoveryMarkers, setRecoveryMarkers] = useState<RecoveryMarker[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  // #5624 — 에코였던 확정본이 묶음에 이어 쓸 에코의 시각(코어 `pinSettledEchoes`). 확정본이 들어오는 문(`applyBatch`)에서 적는다.
  const [echoPins, setEchoPins] = useState<EchoPins>(() => new Map());
  const echoPinsRef = useRef<EchoPins>(echoPins);
  // 서버 시계와 이 기기 시계의 차이(코어 `serverClock.ts`). 에코의 묶음·시각 글자가 이 값을 더해 서버 시각의 확정본과 견준다. 상태로
  // 두어 값이 바뀌면 화면이 다시 묶는다. ref는 「직전 렌더가 쓴 값」이다 — 장부는 그 값으로 적는다.
  const [serverOffsetMs, setServerOffsetMs] = useState(serverClockOffsetNowMs);
  const serverOffsetRef = useRef(serverOffsetMs);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  // 옛 쪽을 읽고 있는 대화(#5662). 상태(`loadingOlder`)의 클로저로 막으면 같은 틱의 두 부름(맨 위 닿음 · 다시 시도)이 둘 다 지나간다.
  const olderFlightRef = useRef<number | null>(null);
  // 방문 번호(#5662): 받아 둔 글을 비우고 대화를 새로 읽을 때마다 오른다. 옛 쪽 읽기는 낸 방문에서만 합치고, 읽는 중 막기도 방문별이다 —
  // 대화 id 만 보면 A → B → A 로 돌아온 A 에 앞 방문의 늦은 응답이 합쳐져 가운데가 비고, 돌아온 A 의 닿음은 그 읽기에 막힌다.
  const olderVisitRef = useRef(0);
  // 이어진 옛 쪽 실패 수와 마지막 실패 시각 — 맨 위 닿음으로 다시 읽을 때의 간격(`olderRetryGapMs`).
  const olderFailuresRef = useRef({ count: 0, atMs: 0 });
  const [reloadNonce, setReloadNonce] = useState(0);
  // B11. Kept beside the messages rather than inside them: a reaction changes
  // far more often than the message it annotates, and folding it into the row
  // would make every 👍 replace a `Message` object the virtualiser then has to
  // re-render in full.
  const [reactions, setReactions] = useState<ReactionMap>(emptyReactions);
  // Read by the optimistic toggle, which must know the current direction
  // without depending on the state it is about to change (that dependency would
  // rebuild every row's click handler on every reaction in the channel).
  const reactionsRef = useRef<ReactionMap>(reactions);
  // 이슈 #1112. Same shape and the same reason as `reactions` above: a pin is an
  // annotation on a message, not a field of it.
  const [pins, setPins] = useState<PinMap>(emptyPins);
  const pinsRef = useRef<PinMap>(pins);
  const applyPins = useCallback((next: PinMap) => {
    pinsRef.current = next;
    setPins(next);
  }, []);
  // 이슈 #1146 M2. The map alone cannot tell "nobody pinned anything" from
  // "we never found out", and the header list was printing the first sentence
  // for both.
  const [pinsStatus, setPinsStatus] = useState<PinListStatus>("loading");
  // ADR-0170. Absence and an explicit empty list differ while a cold request is
  // racing realtime: the latter is a live/remove tombstone and must win.
  const [unfurls, setUnfurls] = useState<UnfurlMap>(emptyUnfurls);
  const unfurlsRef = useRef<UnfurlMap>(unfurls);
  const unfurlReadsRef = useRef<Set<string>>(new Set());
  const applyUnfurls = useCallback((next: UnfurlMap) => {
    unfurlsRef.current = next;
    setUnfurls(next);
  }, []);
  // Which read owns the answer. A channel switch and a retry both bump it, so a
  // slow reply from the channel you just left cannot write over the one you are
  // in — the same hazard the `cancelled` flag guards in the effect, held in a
  // ref because the retry is called from outside that effect's closure.
  const pinReadRef = useRef(0);
  const loadPins = useCallback(
    (channel: string) => {
      const read = ++pinReadRef.current;
      setPinsStatus("loading");
      fetchChannelPins(workspaceId, channel)
        .then((wire) => {
          if (pinReadRef.current !== read) return;
          // Merge with the live map on the same side as the reaction snapshot:
          // a `message.pinned` that arrived while this was in flight wins, since
          // it is strictly newer than the read it raced.
          applyPins({ ...normalizePinList(wire), ...pinsRef.current });
          setPinsStatus("ready");
        })
        .catch(() => {
          if (pinReadRef.current !== read) return;
          // The channel stays fully usable — that judgement has not changed.
          // What changes is that the list now says so instead of claiming the
          // channel has no pins.
          setPinsStatus("failed");
        });
    },
    [workspaceId, applyPins]
  );
  const applyReaction = useCallback(
    (change: Parameters<typeof applyReactionDelta>[1]) => {
      reactionsRef.current = applyReactionDelta(reactionsRef.current, change);
      setReactions(reactionsRef.current);
    },
    []
  );

  // Authoritative newest-seq cursor, updated at merge time rather than at
  // render time, so a resubscribe firing between renders still reads truth.
  const newestSeqRef = useRef<number | null>(null);
  // 레일 없이 기록만 읽은 채널. 레일이 뒤늦게 와서 효과가 다시 돌 때 화면의 기록을 지우지 않는다.
  const restOnlyChannelRef = useRef<string | null>(null);
  // 받아 둔 글이 있으면(= 머리 읽기가 실패했어도 레일이 글을 줬다) 다시 읽기가 그 글을 비우지 않는다. 비우면 「받아 둔 글은
  // 유지」가 다시 시도를 누르는 순간 깨진다.
  const keepOnReloadRef = useRef(false);
  const firstSubscribeRef = useRef(true);
  const markerCounterRef = useRef(0);
  // 이 채널 방문에서 타임라인에 든 줄 id(접은 열쇠, `messageIdKey`). 줄을 들이는 길은 `applyBatch` 하나라
  // 위로 더 읽은 쪽·내 전송 확정·실시간·꼬리 읽기가 전부 여기에 등록된다. 도착 연출(`alreadyHeld`)과 복구
  // 표지의 「이미 든 줄」(#4328)이 같은 집합을 쓴다.
  const heldIdsRef = useRef(new Set<string>());
  // 복구 표지는 「복구가 **남의 새 메시지**를 들였다」는 말이다(#4328, 폰 #4292). 레일이 끊긴 구간을 되쏘는 동안
  // (`subscribed` 직후 동기 flush ~ 그 뒤 마이크로태스크)에는 되쏜 줄도 실시간 줄과 같은 문(`applyBatch`)을
  // 지나므로, 그 문이 코어 판정(`judgeRecoveryMarker`)을 이어 받는다. null 이면 세지 않는다.
  const replayWatchRef = useRef<{ verdict: RecoveryMarkerVerdict } | null>(null);
  const consumedArrivalIdsRef = useRef(new Set<string>());
  const playOnMountRef = useRef(new Set<string>());
  const pendingRef = useRef<PendingMessage[]>([]);

  const isPlayEntrance = useCallback(
    (messageId: string) => playOnMountRef.current.has(messageId.toLowerCase()),
    []
  );
  const consumeEntrance = useCallback((messageId: string) => {
    playOnMountRef.current.delete(messageId.toLowerCase());
  }, []);
  const applyThreadRead = useCallback((rootId: string, read: ThreadReadState) => {
    setState((s) => applyThreadReadState(s, rootId, read));
  }, []);
  const capUnmountedArrivals = useCallback(() => {
    capArrivalSet(playOnMountRef.current, MAX_PENDING_ARRIVAL_GRANTS);
  }, []);

  const applyBatch = useCallback(
    (
      batch: Message[],
      meta: {
        provenance: MessageArrivalProvenance;
        eventType: ArrivalEventType;
      } = { provenance: "rest", eventType: "rest" }
    ) => {
      if (batch.length === 0) return;
      // 복구 표지의 판정은 **병합 전에** 묻는다 — 아래 루프가 이 줄들의 id 를 든 줄로 등록하면 「새것」이
      // 사라진다.
      const watch = replayWatchRef.current;
      if (watch !== null) {
        watch.verdict = judgeRecoveryMarker(
          batch,
          heldIdsRef.current,
          authorMemberId,
          watch.verdict
        );
      }
      const reducedMotion = prefersReducedMotion();
      for (const message of batch) {
        if (
          newestSeqRef.current === null ||
          message.seq > newestSeqRef.current
        ) {
          newestSeqRef.current = message.seq;
        }
        const key = messageIdKey(message.id);
        const play = takeArrivalPlay(consumedArrivalIdsRef.current, {
          messageId: message.id,
          authorMemberId: message.authorMemberId,
          selfMemberId: authorMemberId,
          provenance: meta.provenance,
          eventType: meta.eventType,
          alreadyHeld: heldIdsRef.current.has(key),
          reducedMotion,
        });
        if (play === 1) playOnMountRef.current.add(key);
        heldIdsRef.current.add(key);
      }
      // Same-tick Centrifugo bursts call applyBatch once per publication
      // before React commits. Cap only live `message.new` batches — REST
      // head / load-more / backfill / own-send never issue grants (an edit
      // does not come through here at all: `applyEdited`, #4450) and must
      // not touch the grant set. Do not use
      // MAX_PENDING_ARRIVAL_GRANTS (1) here: that is the scrolled-up
      // leftover sweep. Consume evicts a grant on mount; Timeline sweeps
      // leftovers when the reader is scrolled up.
      const liveNew =
        meta.provenance === "live" && meta.eventType === "message.new";
      if (liveNew) {
        capArrivalSet(playOnMountRef.current, MAX_SIMULTANEOUS_ARRIVALS);
      }
      // N-1 / N-5: heldIdsRef is uncapped per channel visit and alreadyHeld
      // short-circuits takeArrivalPlay before this ledger is read. Replay
      // does not appear at MAX_CONSUMED_ARRIVAL_IDS 4, 1, or 0. The call
      // stays as a belt behind that lock; the constant is not the door.
      capArrivalSet(consumedArrivalIdsRef.current, MAX_CONSUMED_ARRIVAL_IDS);
      // #1166 — 종결 기록의 씨앗을 **머지 자리에서** 심는다. 페이지를 긷는 곳은
      // 셋(첫 화면·위로 더 읽기·재연결 백필)이고, 그 셋이 전부 이 문을 지난다.
      // 호출부마다 심게 두면 언젠가 한 곳이 빠지고, 그 한 곳으로 들어온 반쪽 답만
      // 조용히 완결 행세를 한다. 실시간으로 온 행은 `runEnded` 를 달고 오지
      // 않으므로 여기서 아무것도 내놓지 않는다.
      seedEndedRuns(endedStreamRunIds(batch));
      // #5624 — 이 배치가 정착시키는 에코의 시각을 확정본에 잇는다. 보내기 응답과 실시간 프레임 중 어느 쪽이 먼저 와도 이 문을
      // 지나므로, 확정본을 처음 그리는 렌더가 이미 장부를 본다(같은 틱의 두 상태 갱신은 한 렌더로 묶인다).
      const shownOffset = serverOffsetRef.current;
      const pinned = pinSettledEchoes(echoPinsRef.current, batch, pendingRef.current, shownOffset);
      if (pinned.pins !== echoPinsRef.current) {
        echoPinsRef.current = pinned.pins;
        setEchoPins(pinned.pins);
      }
      // 이은 짝마다 서버 시계를 잰다: 에코를 보낸 기기 시각과 지금 사이에 서버가 확정본을 찍었다(보내기 응답·실시간 프레임 모두).
      // 다시 보낸 글은 창이 첫 시도부터라 넓어지고, 너무 넓은 창은 코어가 버린다.
      const receivedAtMs = Date.now();
      for (const { message, pending: row } of pinned.settled) {
        observeServerClock({ sentAtMs: row.createdAtMs, receivedAtMs, serverAtMs: message.createdAtMs });
      }
      const measuredOffset = serverClockOffsetNowMs();
      if (measuredOffset !== shownOffset) {
        serverOffsetRef.current = measuredOffset;
        setServerOffsetMs(measuredOffset);
      }
      // 장부 ref 는 updater 밖에서 맞춘다 (`updatePending` 과 같은 이유:
      // React 는 updater 를 돌리고 결과를 버릴 수 있다).
      setState((s) => reconcileMessages(s, batch));
      // 복구 표지는 더 새로운 메시지가 오면 걷힌다(#4016). 표지는 배치 **뒤**에 서므로 방금 선 표지는 남는다.
      setRecoveryMarkers((markers) => pruneRecoveryMarkers(markers, batch));
    },
    [authorMemberId]
  );

  // 편집 투영(`message.edited` 프레임·PATCH 응답)은 도착이 아니다(#4450). 이미 든 줄을 다시
  // 투영할 뿐 줄을 들이지 않으므로 `applyBatch` 의 도착 장부(`newestSeqRef` 커서·든 줄 id·도착
  // 연출·복구 표지 판정)를 지나지 않는다. 지나면 못 찾은 줄의 편집이 꼬리 커서를 앞세우고 「든
  // 줄」로 등록된다. 든 줄에 대한 장부는 모두 이미 되어 있다. 판정은 코어 한 곳이다.
  const applyEdited = useCallback((edited: Message) => {
    setState((s) => applyEditedMessage(s, edited));
  }, []);

  const markerTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const addMarker = useCallback((source: RecoveryMarker["source"]) => {
    const seq = newestSeqRef.current;
    if (seq === null) return;
    markerCounterRef.current += 1;
    const id = `recovery-${markerCounterRef.current}`;
    setRecoveryMarkers((markers) => [...markers, { id, seq, source }]);
    // 새 메시지가 오지 않아도 일정 시간 뒤 스스로 걷힌다(#4016).
    const timer = setTimeout(() => {
      markerTimersRef.current.delete(timer);
      setRecoveryMarkers((markers) => markers.filter((m) => m.id !== id));
    }, RECOVERY_MARKER_TTL_MS);
    markerTimersRef.current.add(timer);
  }, []);
  useEffect(() => {
    const timers = markerTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // ---- optimistic send (M10) ------------------------------------------------
  // The pending list is mirrored in a ref so a retry can read the row it is
  // retrying without making the callbacks depend on the list (which would
  // rebuild the composer's handler on every keystroke of every other sender).
  const updatePending = useCallback(
    (fn: (list: PendingMessage[]) => PendingMessage[]) => {
      pendingRef.current = fn(pendingRef.current);
      setPending(pendingRef.current);
    },
    []
  );

  // 보내지 못한 글의 장부(#5221). 코어 `PendingMessage`는 폰과 나눠 쓰므로 건드리지 않고 행 곁에 clientMsgId로 둔다
  // (`callSpecsRef`와 같은 모양). 자동 재전송의 판정(어떤 실패를 몇 번 얼마 동안)은 코어 `pickAutoResends` 하나다.
  const failuresRef = useRef(new Map<string, SendFailureRecord>());
  const [failureKinds, setFailureKinds] = useState<ReadonlyMap<string, SendFailureKind>>(
    () => new Map()
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
    (row: Pick<PendingMessage, "clientMsgId" | "channelId">) => {
      orphansRef.current.delete(row.clientMsgId);
      forgetFailedSend(workspaceId, row.channelId, row.clientMsgId);
      if (failuresRef.current.delete(row.clientMsgId)) syncFailureKinds();
    },
    [workspaceId, syncFailureKinds]
  );

  // Which channel the hook is currently showing, read by in-flight sends that
  // resolved after the user moved on. Without it a POST for channel A could
  // merge its row into channel B's timeline.
  const channelRef = useRef<string | null>(null);

  /**
   * Accessory reads never hold up message history. Unsupported routes, server
   * off, and individual fetch failures all resolve to quiet absence; a later
   * live frame may still replace that local tombstone.
   */
  const hydrateUnfurls = useCallback(
    (messages: readonly Message[], channel: string) => {
      const candidates = messages.filter((message) => {
        const folded = message.id.toLowerCase();
        if (!messageMayHaveUnfurls(message.body)) return false;
        if (unfurlReadsRef.current.has(folded)) return false;
        unfurlReadsRef.current.add(folded);
        return true;
      });
      void Promise.all(
        candidates.map(async (message) => {
          let rows: MessageUnfurl[] = [];
          try {
            rows = await fetchMessageUnfurls(workspaceId, message.id);
          } catch {
            // Server disabled/old/unreachable means no accessory, not an error
            // state on a readable message (ADR-0170 D4/D5).
          }
          if (channelRef.current !== channel) return;
          applyUnfurls(
            mergeColdMessageUnfurls(unfurlsRef.current, message.id, rows)
          );
        })
      );
    },
    [workspaceId, applyUnfurls]
  );

  // 개인 에이전트를 부른 전송의 계획. 코어 `PendingMessage`는 폰과 나눠 쓰므로 건드리지
  // 않고 이 훅 안에 clientMsgId로 둔다. 메시지가 확정되면(= 호출까지 끝나면) 지운다.
  const callSpecsRef = useRef(new Map<string, PersonalCallSpec>());
  const { store: expressionStore } = useExpressions();

  const post = useCallback(
    /** 보냈으면 true, 실패했으면 false. */
    async (row: PendingMessage, automatic = false): Promise<boolean> => {
      try {
        const deliver = () =>
          sendMessage(
          workspaceId,
          row.channelId,
          row.clientMsgId,
          row.body,
          {
            ...(row.routing ? { routing: row.routing } : {}),
            ...(row.replyToId === undefined
              ? {}
              : { replyToId: row.replyToId }),
            // ADR-0151 — 재시도가 **같은 파일들**을 다시 묶는다. 서버는 이미
            // 묶인 첨부를 두 번 묶기를 거절하지만(`AlreadyLinked`), 같은 멱등키의
            // 재전송은 첫 요청이 만든 메시지를 그대로 돌려주므로 그 거절에
            // 닿지 않는다. 여기서 id 를 떨구면 재시도가 파일 없는 메시지를
            // 보내게 되고, 그것이 서버가 롤백으로까지 막는 바로 그 결과다.
            ...(row.attachments === undefined || row.attachments.length === 0
              ? {}
              : { attachmentIds: row.attachments.map((a) => a.id) }),
            // #5005 — 입력칸 ✕로 끈 채 보낸 메시지의 재시도도 **같은 요청**이다. 서버는 이미 저장된
            // 메시지의 재시도에서 이 필드를 다시 판단하지 않으므로, 첫 요청이 닿지 못했다면 여기서
            // 떨군 순간 사람이 끈 카드가 되살아난다.
            ...(row.suppressUnfurl === true ? { suppressUnfurl: true } : {}),
          }
        );
        const spec = callSpecsRef.current.get(row.clientMsgId);
        let confirmed: Message;
        let callResult: Awaited<ReturnType<typeof runPersonalAgentCall>> | null = null;
        if (spec) {
          callResult = await runPersonalAgentCall({
            workspaceId,
            channelId: row.channelId,
            clientMsgId: row.clientMsgId,
            text: row.body,
            spec,
            deliver,
          });
          confirmed = callResult.message;
        } else {
          confirmed = await deliver();
        }
        // The response IS the committed server echo (seq-authoritative), so
        // merging it is not optimistic rendering: it is the same reconcile the
        // realtime frame gets, and whichever arrives second dedupes by seq.
        expressionStore?.recordSuccess(row.body, confirmed.id);
        if (channelRef.current === row.channelId) applyBatch([confirmed]);
        updatePending((list) => removePending(list, row.clientMsgId));
        forgetRow(row);
        if (spec && callResult) {
          // 메시지는 확정됐다. 이후의 재시도는 메시지가 아니라 호출 쪽의 것이다.
          callSpecsRef.current.delete(row.clientMsgId);
          spec.onResult(callResult);
        }
        return true;
      } catch (error) {
        // The row stays where it is and states 전송 실패 with a retry (R-1 §3),
        // which is the same inline failure path a server-stored `failed`
        // message row uses. No toast, no banner far from the message.
        const record = recordSendFailure(
          failuresRef.current.get(row.clientMsgId),
          error,
          deviceOnlineNow(),
          Date.now(),
          automatic
        );
        const listed = pendingRef.current.some((p) => p.clientMsgId === row.clientMsgId);
        const orphan = orphansRef.current.delete(row.clientMsgId);
        // 목록에도 없고 떠난 채널의 고아도 아니면 서버의 echo 가 이미 정착시킨 행이다(응답만 늦게 실패했다):
        // 글은 서버에 있으므로 되살릴 것이 없다.
        if (listed || orphan) {
          failuresRef.current.set(row.clientMsgId, record);
          syncFailureKinds();
          if (listed) updatePending((list) => failPending(list, row.clientMsgId));
          // 개인 에이전트 호출의 계획은 함수를 들고 있어 남길 수 없다. 그런 전송만 메모리에 둔다(지금까지와 같다).
          if (!callSpecsRef.current.has(row.clientMsgId)) {
            rememberFailedSend(workspaceId, row, record.kind);
          }
        }
        return false;
      }
    },
    [workspaceId, applyBatch, updatePending, expressionStore, forgetRow, syncFailureKinds]
  );

  // 이모티콘 + 글 묶음의 앞 메시지가 나가지 못했다(#5453): 보내지 않은 뒤 메시지를 실패 모양으로 맞춘다. 글을 잃지 않게 행은 남기고, 이유 한 줄은 앞
  // 메시지와 같다(같은 실패다). 이 기기에도 남겨서 새로고침 뒤에도 같은 순서 규칙(`after`)이 돌아온다.
  const heldRows = useCallback(
    (rows: PendingMessage[], because: PendingMessage) => {
      const record = failuresRef.current.get(because.clientMsgId);
      updatePending((list) => failBundleTail(list, because.clientMsgId));
      for (const row of rows) {
        if (record !== undefined) {
          failuresRef.current.set(
            row.clientMsgId,
            recordSendFailure(failuresRef.current.get(row.clientMsgId), record.failure, deviceOnlineNow(), Date.now(), false)
          );
        }
        if (!callSpecsRef.current.has(row.clientMsgId)) rememberFailedSend(workspaceId, row, record?.kind ?? null);
      }
      syncFailureKinds();
    },
    [workspaceId, updatePending, syncFailureKinds]
  );

  /** 머리 행을 보내고, 묶음이면 뒤 행을 이어서 보낸다. 처음 보내기·다시·모두 다시·저절로 다시가 모두 이 한 길을 지난다(순서 문은 코어 `postBundleInOrder`). */
  const postChain = useCallback(
    (head: PendingMessage, automatic: boolean): Promise<boolean> => {
      const poster: BundlePoster = {
        list: () => pendingRef.current,
        post: (row) => post(row, automatic),
        held: heldRows,
      };
      return postBundleInOrder(head, poster);
    },
    [post, heldRows]
  );

  const send = useCallback(
    async (body: string, options?: TimelineSendOptions) => {
      const channel = channelId;
      // 파일만 보내는 메시지는 본문이 빈 문자열이다. 서버는 그것을 받고
      // (`SendMessageRequest.body` 는 필수가 아니다), mac 도 같은 문을 연다
      // (`guard !trimmed.isEmpty || !attachments.isEmpty`). 여기서 빈 본문을
      // 되돌려 보내면 사진 한 장만 붙이고 누른 전송이 아무 일도 하지 않는다.
      const attachments = options?.attachments ?? [];
      const expression = options?.expression ?? null;
      if (channel === null || (expression === null && body === "" && attachments.length === 0)) return;
      // 이모티콘과 글을 한 번에(#5453): 표현 메시지 → 글 메시지. 표현이 없으면 메시지 하나이고 아래 행은 예전과 한 글자도 다르지 않다.
      const bundle = expression === null ? null : planSendBundle({ expression, text: body, hasAttachments: attachments.length > 0, newId: () => crypto.randomUUID() });
      if (bundle !== null && !bundle.ok) return;
      // 인용·라우팅·첨부·링크 미리보기 끄기는 마지막 메시지(글)가 나른다. 표현 메시지는 `:이름:` 하나뿐이다(코어 `bundleCarriesOptions`).
      const makeRow = (clientMsgId: string, rowBody: string, carries: boolean, after?: string): PendingMessage => ({
        clientMsgId,
        channelId: channel,
        authorMemberId,
        body: rowBody,
        ...(carries && attachments.length > 0 ? { attachments } : {}),
        ...(carries && options?.routing ? { routing: options.routing } : {}),
        // ADR-0148 - the echo renders its own quote block from this, and a retry
        // must re-send the SAME request under the same idempotency key.
        ...(carries && options?.replyToId !== undefined ? { replyToId: options.replyToId } : {}),
        ...(carries && options?.suppressUnfurl === true ? { suppressUnfurl: true } : {}),
        ...(after === undefined ? {} : { after }),
        // Local clock. The timers compare it with this device's `Date.now()`;
        // grouping and the label add the server offset (#5624, `echoAtMs`).
        // Ordering still waits for seq.
        createdAtMs: Date.now(),
        sinceSeq: newestSeqRef.current,
        status: "sending",
      });
      const rows =
        bundle === null
          ? [makeRow(crypto.randomUUID(), body, true)]
          : bundle.messages.map((message, index) =>
              makeRow(message.clientMsgId, message.body, bundleCarriesOptions(bundle.messages, index), message.after)
            );
      if (options?.personalCall) {
        callSpecsRef.current.set(rows[rows.length - 1].clientMsgId, options.personalCall);
      }
      updatePending((list) => rows.reduce(addPending, list));
      await postChain(rows[0], false);
    },
    [channelId, authorMemberId, postChain, updatePending]
  );

  const resend = useCallback(
    async (clientMsgId: string) => {
      const row = pendingRef.current.find((p) => p.clientMsgId === clientMsgId);
      if (!row || isSendingRow(row)) return;
      // 이모티콘 + 글 묶음의 뒤 메시지에서 눌러도 앞 메시지부터다(#5453): 뒤가 앞지르지 못한다. 묶음이 아니면 머리는 이 행 자신이다.
      const head = bundleHead(pendingRef.current, row);
      if (isSendingRow(head)) return;
      updatePending((list) => retryBundleTail(list, head.clientMsgId));
      await postChain(head, false);
    },
    [postChain, updatePending]
  );

  const resendAll = useCallback(async () => {
    // 지금 실패한 행의 사본(보낸 순서). 도는 동안 정착·삭제된 행은 건너뛴다.
    const failed = pendingRef.current.filter(isFailedRow);
    for (const snapshot of failed) {
      const row = pendingRef.current.find((p) => p.clientMsgId === snapshot.clientMsgId);
      if (!row || !isFailedRow(row)) continue;
      // 묶음의 뒤 메시지는 앞 메시지의 차례에 함께 나간다(#5453). 앞이 서버에 거절돼 남아 있어도 뒤가 앞지르지 않는다.
      if (!bundleMayPost(row, pendingRef.current)) continue;
      updatePending((list) => retryBundleTail(list, row.clientMsgId));
      const sent = await postChain(row, false);
      // 네트워크로 또 실패하면 멈춘다(뒤의 글이 앞의 글을 앞지르지 않게). 서버가 거절한 글은 건너뛰고 이어 간다.
      if (!sent && !resendAllContinuesAfter(failuresRef.current.get(row.clientMsgId))) break;
    }
  }, [postChain, updatePending]);

  // 결정 ⑤: 네트워크로 못 보낸 글만 연결이 돌아오면 같은 멱등 키로 저절로 다시 보낸다(한 글 3회·5분). 한 번에 한
  // 행이고, 실패하면 다음 신호까지 쉰다. 기기가 꺼져 있다고 알면 신호(online)를 기다린다.
  const autoRunningRef = useRef(false);
  const autoResendPass = useCallback(async () => {
    if (autoRunningRef.current || deviceOnlineNow() === false) return;
    autoRunningRef.current = true;
    try {
      for (;;) {
        const [id] = pickAutoResends(pendingRef.current, failuresRef.current, Date.now());
        const row = id === undefined ? undefined : pendingRef.current.find((p) => p.clientMsgId === id);
        if (row === undefined) return;
        updatePending((list) => retryBundleTail(list, row.clientMsgId));
        if (!(await postChain(row, true))) return;
      }
    } finally {
      autoRunningRef.current = false;
    }
  }, [postChain, updatePending]);

  // 「연결이 돌아왔다」는 신호 둘: 브라우저가 온라인을 알렸다, 서버가 답했다(5xx 응답은 아니다). 실패한 행이 없으면
  // 콜백은 아무 일도 하지 않는다. S-A 모델이 「서버에 닿음」을 선언·해제하는 것과 같은 사실이다.
  useEffect(() => {
    const trigger = () => {
      void autoResendPass();
    };
    window.addEventListener(BROWSER_ONLINE_EVENT, trigger);
    const unsubscribe = subscribeRestOutcome((outcome) => {
      if (isServerAnswer(outcome)) trigger();
    });
    return () => {
      window.removeEventListener(BROWSER_ONLINE_EVENT, trigger);
      unsubscribe();
    };
  }, [autoResendPass]);

  const discard = useCallback(
    (clientMsgId: string): PendingMessage | null => {
      const result = discardPending(pendingRef.current, clientMsgId);
      if (result.discarded === null) return null;
      // 개인 에이전트 호출의 계획은 이 전송의 것이었다. 행이 사라지면 아무도 다시 읽지 않는다.
      callSpecsRef.current.delete(clientMsgId);
      forgetRow(result.discarded);
      updatePending(() => result.list);
      return result.discarded;
    },
    [updatePending, forgetRow]
  );

  // 이 채널을 떠날 때(채널 이동·화면 닫힘)와 페이지를 떠날 때(새로고침·창 닫기): 아직 날아가는 요청의 결과는 알 수
  // 없다. 그 글을 이 기기에 「못 보낸 글」로 남겨 돌아왔을 때 같은 키의 실패 행이 되게 한다(서버가 이미 받았다면
  // 채널을 열 때 확정 메시지와 만나 정리된다). 이미 실패한 행은 실패한 순간에 남겨 두었다.
  useEffect(() => {
    if (!channelId) return;
    // 장부는 한 번 만든 Map 하나를 끝까지 쓴다(다시 대입하지 않는다). 정리 함수가 같은 Map 을 읽는다.
    const failures = failuresRef.current;
    const keepInFlight = (leaving: boolean) => {
      for (const row of pendingRef.current) {
        if (row.channelId !== channelId || !isSendingRow(row)) continue;
        if (callSpecsRef.current.has(row.clientMsgId)) continue;
        if (leaving) orphansRef.current.add(row.clientMsgId);
        rememberFailedSend(workspaceId, row, null);
      }
    };
    const onPageHide = () => keepInFlight(false);
    window.addEventListener(PAGE_LEAVE_EVENT, onPageHide);
    return () => {
      window.removeEventListener(PAGE_LEAVE_EVENT, onPageHide);
      keepInFlight(true);
      // 떠난 채널 행의 기록은 더 읽는 곳이 없다(돌아오면 남겨 둔 저장본에서 새로 만든다).
      let changed = false;
      for (const row of pendingRef.current) {
        if (row.channelId === channelId && failures.delete(row.clientMsgId)) changed = true;
      }
      if (changed) syncFailureKinds();
    };
  }, [workspaceId, channelId, syncFailureKinds]);

  const backfillAfter = useCallback(
    async (channel: string, stillCurrent: () => boolean) => {
      let after = newestSeqRef.current ?? 0;
      let total = 0;
      // 이 읽기가 **새로** 들인 남의 줄에 대한 코어 판정(#4328). 읽는 사이 이미 들어온 줄(내 REST 응답,
      // 레일)과 내 줄은 복구한 것이 아니다 — 페이지마다 **병합 전에** 묻는다.
      let verdict = NO_RECOVERY;
      // Loop ascending pages until the server returns fewer than requested.
      for (;;) {
        const page = await fetchMessages(workspaceId, channel, {
          after,
          limit: PAGE_LIMIT,
        });
        // 답이 돌아온 **뒤에** 묻는다(#4438). 읽는 사이 채널을 옮겼다면(효과 정리) 이 페이지는 떠난 채널의 것이다 — 병합 문은 seq 로만
        // 맞추므로 들이면 옛 채널의 줄이 새 목록에 서거나 같은 seq 의 새 채널 줄을 갈아 끼우고, `newestSeqRef` 가 옛 채널의 값으로
        // 올라가 새 채널의 다음 꼬리 읽기가 그 아래 행을 건너뛴다. 읽기를 보내기 전이나 병합 뒤에 물으면 늦다. 폰
        // (`conversation/useTimeline.ts`)의 같은 가드와 같은 자리·같은 뜻이다. 인자가 필수인 것은 일부러다 — 빼먹을 수 있는 가드는
        // 가드가 아니다.
        if (!stillCurrent()) break;
        if (page.messages.length === 0) break;
        total += page.messages.length;
        verdict = judgeRecoveryMarker(
          page.messages,
          heldIdsRef.current,
          authorMemberId,
          verdict
        );
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channel);
        const maxSeq = page.messages.reduce((m, x) => Math.max(m, x.seq), after);
        if (maxSeq <= after) break;
        after = maxSeq;
        if (page.messages.length < PAGE_LIMIT) break;
      }
      return { fetched: total, verdict };
    },
    [workspaceId, applyBatch, hydrateUnfurls, authorMemberId]
  );

  useEffect(() => {
    channelRef.current = channelId;
  }, [channelId]);

  // Drop echoes whose confirmed twin has landed in the seq stream, even when
  // the POST that created them never resolved. That case is real: if the write
  // committed but the response was lost, the realtime frame delivers the row
  // and the echo is settled by content, while the request may hang forever.
  // The render fold already hides such a row; without this the entry would sit
  // in state for the rest of the session and be reported as still sending.
  useEffect(() => {
    const open = unsettledPending(state.messages, pendingRef.current);
    if (open.length !== pendingRef.current.length) {
      // 정착한 행은 이 기기의 저장본에서도 지운다(되살아난 실패 행이 사실은 서버에 있던 글인 경우가 이것이다).
      const keep = new Set(open.map((p) => p.clientMsgId));
      for (const row of pendingRef.current) if (!keep.has(row.clientMsgId)) forgetRow(row);
      updatePending(() => open);
    }
  }, [state.messages, updatePending, forgetRow]);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    // #3676: 기록(REST 머리)은 실시간 레일과 무관하게 읽을 수 있다. 레일이 아직 없거나 끝내 안 와도
    // 타임라인이 스켈레톤에 머물지 않고 ready/error 로 끝나야 한다. 레일이 나중에 오면 이 효과가
    // 다시 돌며 구독을 붙이는데, 그때 이미 화면에 있는 기록을 스켈레톤으로 되돌리지 않는다.
    // 다시 읽기(`reload`)가 받아 둔 글이 있는 채로 불렸다면 그 글을 비우지 않고 머리만 다시 읽는다(#5221).
    const keepLoaded = restOnlyChannelRef.current === channelId || keepOnReloadRef.current;
    keepOnReloadRef.current = false;
    restOnlyChannelRef.current = realtime ? null : channelId;
    setLoadCause(null);
    firstSubscribeRef.current = true;
    newestSeqRef.current = null;
    markerCounterRef.current = 0;
    heldIdsRef.current = new Set();
    replayWatchRef.current = null;
    consumedArrivalIdsRef.current = new Set();
    playOnMountRef.current = new Set();
    // 다른 채널의 행은 비우고, 이 채널의 행은 남긴다(같은 채널에서 이 효과만 다시 도는 경우: 레일이 늦게 와 구독을
    // 붙일 때). 여기에 이 기기가 남겨 둔 이 채널의 못 보낸 글을 더한다(#5221). 되살린 행은 자동 재전송 대상이
    // 아니다(처음 실패한 때를 몰라 5분을 셀 수 없다): 장부에는 원인 한 줄의 종류만 남긴다.
    const restored = readFailedSends(workspaceId, channelId, authorMemberId);
    updatePending((list) => {
      const mine = list.filter((p) => p.channelId === channelId);
      const have = new Set(mine.map((p) => p.clientMsgId));
      const back = restored.filter((r) => !have.has(r.row.clientMsgId));
      for (const { row, kind } of back) {
        if (!failuresRef.current.has(row.clientMsgId)) {
          failuresRef.current.set(row.clientMsgId, {
            failure: null,
            kind,
            firstFailedAt: row.createdAtMs,
            autoAttempts: 0,
          });
        }
      }
      return [...mine, ...back.map((r) => r.row)].sort((a, b) => a.createdAtMs - b.createdAtMs);
    });
    syncFailureKinds();
    if (!keepLoaded) {
      setState(emptyTimeline());
      setStatus("loading");
      setReachedStart(false);
      setOlderFailed(false);
      olderFailuresRef.current = { count: 0, atMs: 0 };
      olderVisitRef.current += 1;
    }
    setRecoveryMarkers([]);
    setResume({ lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 });
    reactionsRef.current = emptyReactions();
    setReactions(reactionsRef.current);
    applyPins(emptyPins());
    unfurlReadsRef.current = new Set();
    applyUnfurls(emptyUnfurls());

    // 1) REST head (descending page; merge is order-agnostic).
    fetchMessages(workspaceId, channelId, { limit: HEAD_LIMIT })
      .then((page) => {
        if (cancelled) return;
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channelId);
        setReachedStart(page.nextBefore === undefined);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadCause(causeOfFailure(error, deviceOnlineNow()));
        setStatus("error");
      });

    // 1b) The channel's reaction map, in parallel and deliberately not fatal.
    // A channel whose messages loaded but whose chips did not is a channel you
    // can still read and still send in; turning that into the error state would
    // trade the whole surface for an annotation.
    fetchReactionSnapshot(workspaceId, channelId)
      .then((wire) => {
        if (cancelled) return;
        // Merge rather than replace: a reaction that arrived on the realtime
        // rail while this request was in flight would otherwise be erased by an
        // older snapshot.
        const cold = normalizeReactionSnapshot(wire);
        reactionsRef.current = { ...cold, ...reactionsRef.current };
        setReactions(reactionsRef.current);
      })
      .catch(() => {
        /* chips stay empty; the channel is still fully usable */
      });

    // 1c) The channel's pins, on the same terms as the snapshot above: in
    // parallel, and not fatal. A header list that failed to load is an absent
    // accessory; a channel that refuses to open because of one is a broken app.
    // 이슈 #1146 M2 — "absent" is now something the list can say out loud.
    loadPins(channelId);

    // 2) Realtime rail with resume healing.
    if (!realtime) {
      return () => {
        cancelled = true;
      };
    }
    const replayGate = createReplayGate();
    const unsub = realtime.subscribeChannel(workspaceId, channelId, {
      onSubscribed: (ctx) => {
        if (cancelled) return;
        replayGate.onSubscribed(ctx);
        const recovered = ctx.recovered === true;
        const isFirst = firstSubscribeRef.current;
        firstSubscribeRef.current = false;
        setResume((r) => ({
          ...r,
          lastRecovered: recovered,
          resubscribeCount: r.resubscribeCount + (isFirst ? 0 : 1),
        }));
        if (!recovered) {
          // A non-recovered (re)subscribe may have missed publications: pull
          // the authoritative tail from PG. (Also safe on first subscribe.)
          backfillAfter(channelId, () => !cancelled).then(({ fetched, verdict }) => {
            if (cancelled || isFirst) return;
            setResume((r) => ({ ...r, lastBackfillCount: fetched }));
            // 표지는 「끊겼던 구간이 있었고, 다른 사람(또는 에이전트)의 새 메시지로 그것을 메웠다」는 말이다
            // (#4328). 꼬리를 읽었더니 빈손이거나 온 것이 전부 이미 든 줄·내 줄이면 메운 것이 없으므로 할 말도
            // 없다 — 읽어 온 수(`lastBackfillCount`)는 그대로 센다.
            if (verdict.show) addMarker("backfill");
          });
        } else if (!isFirst) {
          // The transport replayed the gap. Let the recovered publications
          // land, then state how far the timeline was restored.
          //
          // 되쏜 것이 **다른 사람(또는 에이전트)의 새 메시지**를 들여왔을 때만 선다(#4328). `recovered: true` 는
          // 「끊긴 구간을 이을 수 있었다」일 뿐 그 구간에 무엇이 있었다는 말이 아니다 — 비어 있던 구간의 복구에도
          // 참이다. centrifuge-js 는 되쏜 publication 을 `subscribed` 직후 **동기로** 흘리므로(`createReplayGate`
          // 와 같은 근거) 창은 다음 마이크로태스크까지다: 되쏜 줄만 덮고, 그 뒤에 닿는 실시간 줄은 덮지 않는다.
          const watch = { verdict: NO_RECOVERY };
          replayWatchRef.current = watch;
          queueMicrotask(() => {
            if (replayWatchRef.current === watch) replayWatchRef.current = null;
            if (!cancelled && watch.verdict.show) addMarker("replay");
          });
        }
      },
      onMessage: (event) => {
        if (cancelled) return;
        const message = payloadToMessage(event.payload);
        // 편집 투영은 든 줄만 갱신한다(#4450): `applyEdited` 가 코어 판정을 지난다.
        if (event.type === "message.edited") {
          applyEdited(message);
          return;
        }
        applyBatch([message], {
          provenance: replayGate.isReplaying() ? "replay" : "live",
          eventType: "message.new",
        });
      },
      // B11 — a tombstone marks the row it names in place. It cannot go through
      // `applyBatch`: the frame carries only an id (by design, so a delete
      // never re-broadcasts the body it erased), and the row must keep its seq.
      onMessageDeleted: (event) => {
        if (cancelled) return;
        const messageId = event.payload.message_id;
        setState((s) => applyTombstone(s, messageId, event.ts));
        // The server deleted the rows with the message; drop the chips so they
        // do not report counts for a body nobody can read.
        reactionsRef.current = clearMessageReactions(
          reactionsRef.current,
          messageId
        );
        setReactions(reactionsRef.current);
        // …and its pin, which the server swept with the message. No
        // `message.unpinned` is published for a delete, so this is the only
        // place the header list learns about it.
        applyPins(removePin(pinsRef.current, messageId));
        applyUnfurls(clearMessageUnfurls(unfurlsRef.current, messageId));
      },
      onReaction: (event) => {
        if (cancelled) return;
        // Idempotent both ways, which is what lets the echo of my own optimistic
        // click land harmlessly on top of it.
        applyReaction({
          messageId: event.payload.message_id,
          memberId: event.payload.member_id,
          emoji: event.payload.emoji,
          action: event.payload.action,
        });
      },
      // 이슈 #1112 — the header list stays live off these two frames alone. The
      // `message.pinned` payload IS the list entry, so nothing here re-reads
      // the list to find out what was pinned.
      onPin: (event) => {
        if (cancelled) return;
        if (event.type === "message.pinned") {
          applyPins(
            applyPinned(pinsRef.current, pinnedPayloadToWire(event.payload))
          );
        } else {
          applyPins(removePin(pinsRef.current, event.payload.message_id));
        }
      },
      onUnfurl: (event) => {
        if (cancelled) return;
        const messageId = event.payload.message_id;
        unfurlReadsRef.current.add(messageId.toLowerCase());
        applyUnfurls(
          event.type === "message.unfurl"
            ? replaceMessageUnfurls(
                unfurlsRef.current,
                messageId,
                event.payload.unfurls
              )
            : clearMessageUnfurls(unfurlsRef.current, messageId)
        );
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [
    realtime,
    workspaceId,
    channelId,
    backfillAfter,
    applyBatch,
    applyEdited,
    applyReaction,
    applyPins,
    applyUnfurls,
    hydrateUnfurls,
    loadPins,
    addMarker,
    updatePending,
    syncFailureKinds,
    authorMemberId,
    reloadNonce,
  ]);

  /**
   * Design-capture seam. The lane injects a live message through applyBatch,
   * the same path as message.new. Release builds skip this listener.
   */
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.MODE === "design")) return;
    if (!channelId) return;
    const onCapture = (event: Event) => {
      const detail = (event as CustomEvent<Message>).detail;
      if (!detail || typeof detail !== "object") return;
      if (typeof detail.id !== "string") return;
      if (detail.channelId && !uuidEq(detail.channelId, channelId)) return;
      applyBatch([detail], { provenance: "live", eventType: "message.new" });
    };
    window.addEventListener("oort.capture.message.new", onCapture);
    return () => {
      window.removeEventListener("oort.capture.message.new", onCapture);
    };
  }, [channelId, applyBatch]);

  /**
   * Read the list again (이슈 #1146 M2).
   *
   * Deliberately *not* `reload()`. That one re-runs the whole channel — history,
   * rail, subscription — and the person pressing this button is answering one
   * sentence about one accessory. Rebuilding the conversation under them to
   * refill a header list is the kind of over-reaction that loses their scroll
   * position.
   */
  const reloadPins = useCallback(() => {
    if (channelId) loadPins(channelId);
  }, [channelId, loadPins]);

  // 옛 쪽 읽기(#5662). 전에는 `catch` 가 없어 실패가 처리 안 된 거부로 사라지고 화면은 아무 말도 안 했다 — 그리고 가상 목록의
  // `startReached` 는 같은 첫 줄 번호로는 다시 나가지 않으므로 그 대화에서는 다시 읽지 않았다. 지금은 실패를 `olderFailed` 로
  // 알리고(목록 위 한 줄 + 「다시 시도」), 다시 맨 위에 닿으면(`Timeline` 의 닿음 확인) 다시 읽는다. 실패가 이어지면 닿을 때마다
  // 바로 내지 않고 간격을 둔다(망이 끊긴 채 맨 위에서 흔들리는 손가락이 읽기를 쏟아내지 않게). 「다시 시도」(`manual`)는 간격을 넘는다.
  const readOlder = useCallback(
    async (manual: boolean) => {
      const visit = olderVisitRef.current;
      if (!channelId || reachedStart || olderFlightRef.current === visit) return;
      const oldest = state.oldestSeq;
      if (oldest === null) return;
      const failures = olderFailuresRef.current;
      if (!manual && failures.count > 0 && Date.now() - failures.atMs < olderRetryGapMs(failures.count)) return;
      olderFlightRef.current = visit;
      setLoadingOlder(true);
      try {
        const page = await fetchMessages(workspaceId, channelId, {
          before: oldest,
          limit: PAGE_LIMIT,
        });
        // 떠난 대화의 쪽은 지금 대화에 합치지 않는다(합치면 앞 대화 줄이 섞이고, 가장 옛 줄이 내려가 지금 대화의 그 사이를 건너뛴다).
        if (channelRef.current !== channelId || olderVisitRef.current !== visit) return;
        applyBatch(page.messages);
        hydrateUnfurls(page.messages, channelId);
        if (page.nextBefore === undefined) setReachedStart(true);
        if (channelRef.current === channelId) {
          olderFailuresRef.current = { count: 0, atMs: 0 };
          setOlderFailed(false);
        }
      } catch {
        // 떠난 대화 · 지난 방문의 실패는 지금 대화에 말하지 않는다.
        if (channelRef.current === channelId && olderVisitRef.current === visit) {
          olderFailuresRef.current = { count: olderFailuresRef.current.count + 1, atMs: Date.now() };
          setOlderFailed(true);
        }
      } finally {
        if (olderFlightRef.current === visit) olderFlightRef.current = null;
        setLoadingOlder(false);
      }
    },
    [workspaceId, channelId, state.oldestSeq, reachedStart, applyBatch, hydrateUnfurls]
  );
  // 가상 목록이 `startReached(index)` 로 부르므로 인자는 받지 않는다.
  const loadOlder = useCallback(() => readOlder(false), [readOlder]);
  const retryOlder = useCallback(() => {
    void readOlder(true);
  }, [readOlder]);

  const reload = useCallback(() => {
    keepOnReloadRef.current = newestSeqRef.current !== null;
    setReloadNonce((n) => n + 1);
  }, []);

  // ---- message actions (B11) ------------------------------------------------

  /**
   * Toggle my reaction, optimistically.
   *
   * The direction is *derived* from the current map rather than passed in, so
   * the local update and the request can never disagree about which way the
   * toggle was going — a mismatch there is how a chip ends up showing the
   * opposite of what the server stored.
   *
   * On failure the optimistic change is reverted with its own inverse, which is
   * safe because `applyReactionDelta` is idempotent: if the realtime echo of a
   * *successful* twin already landed, the revert is a no-op rather than a second
   * wrong write.
   */
  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      const action = toggleDirection(
        reactionsRef.current,
        message.id,
        authorMemberId,
        emoji
      );
      const change = {
        messageId: message.id,
        memberId: authorMemberId,
        emoji,
        action,
      };
      applyReaction(change);
      try {
        await setReaction(workspaceId, message.id, emoji, action);
        if (action === "added") expressionStore?.recordSuccess(emoji, crypto.randomUUID());
      } catch (error) {
        applyReaction({
          ...change,
          action: action === "added" ? "removed" : "added",
        });
        throw error;
      }
    },
    [workspaceId, authorMemberId, applyReaction, expressionStore]
  );

  /**
   * Rewrite my own message. **Not optimistic**, unlike a reaction: the server
   * stamps `edited_at` and decides the resulting `state`, and showing the new
   * text before it is stored would leave the row claiming an edit that a 403
   * then took back. The round trip here is one request, and the editor says
   * "저장 중…" while it runs.
   */
  const editMessage = useCallback(
    async (message: Message, body: string) => {
      const updated = await editMessageRequest(workspaceId, message.id, body);
      // 응답은 편집 투영이다(롤업·풀린 인용·첨부가 없다). 든 줄만 갱신한다 — 방을 옮긴 뒤 도착한
      // 응답이 지금 방의 타임라인에 끼지 않는다(#4450).
      applyEdited(updated);
    },
    [workspaceId, applyEdited]
  );

  /** Soft-delete my own message; the returned tombstone replaces the row. */
  const deleteMessage = useCallback(
    async (message: Message) => {
      const tombstone = await deleteMessageRequest(workspaceId, message.id);
      applyBatch([tombstone]);
      reactionsRef.current = clearMessageReactions(
        reactionsRef.current,
        message.id
      );
      setReactions(reactionsRef.current);
      applyPins(removePin(pinsRef.current, message.id));
      applyUnfurls(clearMessageUnfurls(unfurlsRef.current, message.id));
    },
    [workspaceId, applyBatch, applyPins, applyUnfurls]
  );

  const removeUnfurls = useCallback(
    async (message: Message) => {
      await removeMessageUnfurls(workspaceId, message.id);
      applyUnfurls(clearMessageUnfurls(unfurlsRef.current, message.id));
    },
    [workspaceId, applyUnfurls]
  );

  /**
   * Pin or unpin one message (이슈 #1112).
   *
   * **Asymmetrically optimistic, and the asymmetry is the design.** An unpin is
   * applied immediately: the entry to remove is already in hand, so a revert is
   * exact. A pin is not, because the row a header list draws is the server's
   * projection — `pinnedAtMs` in particular is what the list sorts on, and a
   * locally invented one would put the entry in the wrong place until a reload,
   * which is a worse lie than a half-second wait. So the pin direction takes
   * the delta the server answers with, exactly as `editMessage` takes the row.
   *
   * Both directions are idempotent underneath, so the realtime echo of one's own
   * click lands harmlessly on top of whichever happened first.
   */
  const togglePin = useCallback(
    async (message: Message) => {
      if (isPinned(pinsRef.current, message.id)) {
        const previous = pinsRef.current;
        applyPins(removePin(previous, message.id));
        try {
          await setPin(workspaceId, message.id, "unpinned");
        } catch (error) {
          applyPins(previous);
          throw error;
        }
        return;
      }
      const delta = await setPin(workspaceId, message.id, "pinned");
      if (delta.pinned) applyPins(applyPinned(pinsRef.current, delta.pinned));
    },
    [workspaceId, applyPins]
  );

  return {
    state,
    status,
    loadCause,
    resume,
    recoveryMarkers,
    pending,
    echoPins,
    serverOffsetMs,
    send,
    resend,
    discard,
    resendAll,
    failureKinds,
    loadOlder,
    reload,
    loadingOlder,
    reachedStart,
    olderFailed,
    retryOlder,
    reactions,
    toggleReaction,
    pins,
    pinsStatus,
    reloadPins,
    togglePin,
    editMessage,
    deleteMessage,
    unfurls,
    removeUnfurls,
    isPlayEntrance,
    consumeEntrance,
    applyThreadRead,
    capUnmountedArrivals,
  };
}
