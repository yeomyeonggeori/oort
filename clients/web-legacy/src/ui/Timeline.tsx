import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel } from "../api/client";
import {
  fetchMessages,
  fetchReactionSnapshot,
  fetchThreadReplies,
} from "../api/client";
import type {
  ChannelRealtimeEvent,
  MessageEditedEvent,
  MessageNewEvent,
  RealtimeHandle,
} from "../realtime/realtime";
import type { ApprovalsStore } from "../state/approvals";
import {
  approvalCardModel,
  resolveApprovalStatus,
} from "../state/approvalModel";
import { highestVisibleSequence } from "../state/readStates";
import {
  applyReactionDelta,
  fromRestMessage,
  isSameLocalDate,
  mentionsMember,
  reconcileMessages,
  removeMessageReactions,
  startsAuthorGroup,
  type ReactionSnapshot,
  type TimelineMessage,
} from "../timeline/model";
import { resolveArtifact } from "../timeline/artifacts";
import ApprovalCard from "./ApprovalCard";
import ArtifactCard from "./ArtifactCard";
import Composer from "./Composer";
import MessageContent from "./MessageContent";

interface TimelineProps {
  workspaceId: string;
  channel: Channel;
  channelLabel: string;
  currentMemberId: string;
  displayNameFor: (memberId: string) => string;
  realtime: RealtimeHandle | null;
  approvals: ApprovalsStore;
  /** Highest committed seq rendered — drives the read-state cursor PUT. */
  onLatestSeq: (channelId: string, seq: number) => void;
  online: boolean;
  /** Work observer mode: reuse the timeline for one root and remove writes. */
  focusRootMessageId?: string;
  readOnly?: boolean;
}

const HEAD_PAGE_LIMIT = 200;
const BACKFILL_LIMIT = 200;
const MAX_BACKFILL_PAGES = 10;
const MAX_THREAD_PAGES = 20;

// ADR-0112 basic mode: non-text message types render as a one-line summary
// label; tool JSON / props / cost details are intentionally not shown.
const TYPE_LABEL: Record<string, string> = {
  tool_call: "도구 호출",
  tool_result: "도구 결과",
  diff: "변경 제안",
  artifact: "산출물",
  approval_request: "승인 요청",
  system: "시스템",
};

function fromRealtime(
  event: MessageNewEvent | MessageEditedEvent
): TimelineMessage {
  const payload = event.payload;
  const ui: TimelineMessage = {
    id: payload.id,
    seq: payload.seq,
    type: payload.type,
    authorMemberId: payload.author_member_id,
    // The realtime envelope has no created_at; hlc_ts is epoch-ms based and
    // close enough for display. REST reloads carry the authoritative value.
    createdAtMs: payload.created_at_ms ?? payload.hlc_ts,
  };
  if (payload.body !== undefined && payload.body !== null) {
    ui.body = payload.body;
  }
  if (payload.props !== undefined && payload.props !== null) {
    ui.props = payload.props;
  }
  if (payload.state !== undefined) ui.state = payload.state;
  if (payload.edited_at_ms !== undefined && payload.edited_at_ms !== null) {
    ui.editedAtMs = payload.edited_at_ms;
  }
  if (payload.deleted_at_ms !== undefined && payload.deleted_at_ms !== null) {
    ui.deletedAtMs = payload.deleted_at_ms;
  }
  return ui;
}

const timeFormat = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
});
const fullFormat = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "medium",
});
const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

export default function Timeline({
  workspaceId,
  channel,
  channelLabel,
  currentMemberId,
  displayNameFor,
  realtime,
  approvals,
  onLatestSeq,
  online,
  focusRootMessageId,
  readOnly = false,
}: TimelineProps) {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [reactions, setReactions] = useState<ReactionSnapshot>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [oldestCursor, setOldestCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  // Highest seq we have; realtime gap detection and `?after=` catch-up
  // read it outside of React's render cycle.
  const lastSeqRef = useRef(0);
  const catchUpRunningRef = useRef(false);
  const recoveryEventsRef = useRef<ChannelRealtimeEvent[]>([]);
  // Until the head page establishes a seq baseline, catch-up must not run:
  // `after=0` would page the whole channel history oldest-first (up to
  // MAX_BACKFILL_PAGES * BACKFILL_LIMIT) and can stop short, leaving a seq
  // hole. Requests arriving early are deferred and replayed once loaded.
  // (Refs reset per channel — Timeline is keyed by channel id in ChatPage.)
  const headLoadedRef = useRef(false);
  const pendingCatchUpRef = useRef(false);
  const loadingProjectionRef = useRef(true);
  const bufferedEventsRef = useRef<ChannelRealtimeEvent[]>([]);
  const channelId = channel.id;
  const applyApprovalRealtimeStatus = approvals.applyRealtimeStatus;
  const visibleMessages = useMemo(
    () =>
      focusRootMessageId === undefined
        ? messages
        : messages.filter(
            (message) =>
              message.id.toLowerCase() === focusRootMessageId.toLowerCase() ||
              message.rootId?.toLowerCase() === focusRootMessageId.toLowerCase()
          ),
    [focusRootMessageId, messages]
  );

  const appendMessages = useCallback((incoming: TimelineMessage[]) => {
    for (const message of incoming) {
      lastSeqRef.current = Math.max(lastSeqRef.current, message.seq);
    }
    setMessages((current) => {
      return reconcileMessages(current, incoming);
    });
  }, []);

  const applyRealtimeEvent = useCallback(
    (event: ChannelRealtimeEvent) => {
      if (
        event.type === "approval.decided" ||
        event.type === "approval.approved" ||
        event.type === "approval.rejected" ||
        event.type === "approval.expired"
      ) {
        applyApprovalRealtimeStatus(
          event.payload.approval_id,
          event.payload.status
        );
        return;
      }
      if (event.type === "message.new" || event.type === "message.edited") {
        appendMessages([fromRealtime(event)]);
        return;
      }
      if (event.type === "message.deleted") {
        const messageId = event.payload.message_id;
        setMessages((current) =>
          current.map((message) => {
            if (message.id.toLowerCase() !== messageId.toLowerCase()) return message;
            const tombstone: TimelineMessage = {
              ...message,
              state: "deleted",
              deletedAtMs: event.ts,
            };
            delete tombstone.body;
            return tombstone;
          })
        );
        setReactions((current) => removeMessageReactions(current, messageId));
        return;
      }
      const delta = event.payload;
      setReactions((current) =>
        applyReactionDelta(current, {
          action: delta.action,
          messageId: delta.message_id,
          memberId: delta.member_id,
          emoji: delta.emoji,
        })
      );
    },
    [appendMessages, applyApprovalRealtimeStatus]
  );

  /**
   * REST `?after=<seq>` backfill (ascending) — the recovery authority.
   * Runs after every non-recovered (re)subscribe and on publication gaps;
   * Centrifugo history is a convenience, Postgres seq is the truth.
   */
  const catchUp = useCallback(async () => {
    if (!headLoadedRef.current) {
      // No baseline yet (initial mount race: onSubscribed/publication gap can
      // fire before the head page lands). Defer — loadHead replays it.
      pendingCatchUpRef.current = true;
      return;
    }
    if (catchUpRunningRef.current) {
      pendingCatchUpRef.current = true;
      return;
    }
    catchUpRunningRef.current = true;
    let recovered = false;
    try {
      let cursor = lastSeqRef.current;
      for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
        const response = await fetchMessages(workspaceId, channelId, {
          after: cursor,
          limit: BACKFILL_LIMIT,
        });
        const incoming = response.messages.map(fromRestMessage);
        if (incoming.length > 0) {
          appendMessages(incoming);
          cursor = Math.max(cursor, ...incoming.map((message) => message.seq));
        }
        if (incoming.length < BACKFILL_LIMIT) break;
      }
      recovered = true;
    } catch {
      // Transient; the next subscribe/publication cycle retries.
    } finally {
      catchUpRunningRef.current = false;
    }
    if (recovered) {
      const queued = recoveryEventsRef.current;
      recoveryEventsRef.current = [];
      for (const event of queued) {
        if (
          focusRootMessageId !== undefined &&
          (event.type === "message.new" || event.type === "message.edited")
        ) {
          continue;
        }
        applyRealtimeEvent(event);
      }
    }
    if (pendingCatchUpRef.current) {
      pendingCatchUpRef.current = false;
      void catchUp();
    }
  }, [appendMessages, applyRealtimeEvent, channelId, focusRootMessageId, workspaceId]);

  // Initial head load: history and reactions establish one cold-load baseline.
  // Publications received before both snapshots land are buffered, matching
  // IOSTimelineModel.load(), then replayed in transport order.
  useEffect(() => {
    let cancelled = false;
    loadingProjectionRef.current = true;
    bufferedEventsRef.current = [];
    async function loadHead() {
      try {
        const threadPromise = (async () => {
          if (focusRootMessageId === undefined) return [];
          const replies: TimelineMessage[] = [];
          let cursor: number | undefined;
          const seen = new Set<number>();
          for (let pageIndex = 0; pageIndex < MAX_THREAD_PAGES; pageIndex += 1) {
            const page = await fetchThreadReplies(
              workspaceId,
              channelId,
              focusRootMessageId,
              cursor,
              HEAD_PAGE_LIMIT
            );
            replies.push(...page.messages.map(fromRestMessage));
            if (
              page.nextCursor === undefined ||
              page.nextCursor === cursor ||
              seen.has(page.nextCursor)
            ) {
              break;
            }
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
          }
          return replies;
        })();
        const [response, reactionSnapshot, threadReplies] = await Promise.all([
          fetchMessages(workspaceId, channelId, { limit: HEAD_PAGE_LIMIT }),
          fetchReactionSnapshot(workspaceId, channelId),
          threadPromise,
        ]);
        if (cancelled) return;
        appendMessages([
          ...response.messages.map(fromRestMessage),
          ...threadReplies,
        ]);
        setReactions(reactionSnapshot);
        setOldestCursor(response.nextBefore ?? null);
        setLoaded(true);
        setLoadError(null);
        // Baseline established (lastSeqRef set via appendMessages). Unblock
        // catch-up and replay one deferred request so the recovered:false /
        // gap fallback semantics survive the initial mount race.
        headLoadedRef.current = true;
        loadingProjectionRef.current = false;
        const buffered = bufferedEventsRef.current;
        bufferedEventsRef.current = [];
        const needsRecovery =
          pendingCatchUpRef.current ||
          buffered.some(
            (event) =>
              event.type === "message.new" &&
              event.payload.seq > lastSeqRef.current + 1
          );
        if (needsRecovery) {
          recoveryEventsRef.current.push(...buffered);
          pendingCatchUpRef.current = false;
          void catchUp();
        } else {
          for (const event of buffered) applyRealtimeEvent(event);
        }
      } catch {
        if (!cancelled) {
          loadingProjectionRef.current = false;
          setLoaded(true);
          setLoadError("메시지와 반응을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.");
        }
      }
    }
    void loadHead();
    return () => {
      cancelled = true;
    };
  }, [appendMessages, applyRealtimeEvent, catchUp, channelId, focusRootMessageId, loadAttempt, workspaceId]);

  // Realtime subscription; server-side subscribe proxy authorizes it.
  useEffect(() => {
    if (!realtime) return;
    const unsubscribe = realtime.subscribeChannel(workspaceId, channelId, {
      onSubscribed: (recovered) => {
        // recovered:false => Centrifugo could not replay what we missed;
        // heal through REST (also covers the initial subscribe race).
        if (!recovered) void catchUp();
      },
      onPublication: (event) => {
        if (loadingProjectionRef.current) {
          bufferedEventsRef.current.push(event);
          return;
        }
        if (catchUpRunningRef.current) {
          recoveryEventsRef.current.push(event);
          return;
        }
        // Realtime message envelopes do not project rootId. In focused Work
        // threads, heal every message event through REST before rendering so
        // replies are never misclassified or leaked from adjacent threads.
        if (
          focusRootMessageId !== undefined &&
          (event.type === "message.new" || event.type === "message.edited")
        ) {
          recoveryEventsRef.current.push(event);
          void catchUp();
          return;
        }
        if (recoveryEventsRef.current.length > 0) {
          recoveryEventsRef.current.push(event);
          void catchUp();
          return;
        }
        if (
          event.type === "message.new" &&
          event.payload.seq > lastSeqRef.current + 1
        ) {
          // Queue the publication until REST closes the hole. Existing rows
          // remain rendered throughout recovery.
          recoveryEventsRef.current.push(event);
          void catchUp();
          return;
        }
        applyRealtimeEvent(event);
      },
    });
    return unsubscribe;
  }, [applyRealtimeEvent, catchUp, channelId, focusRootMessageId, realtime, workspaceId]);

  async function loadOlder() {
    if (oldestCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await fetchMessages(workspaceId, channelId, {
        before: oldestCursor,
        limit: HEAD_PAGE_LIMIT,
      });
      appendMessages(response.messages.map(fromRestMessage));
      setOldestCursor(response.nextBefore ?? null);
    } catch {
      // Keep the cursor; the button retries.
    } finally {
      setLoadingOlder(false);
    }
  }

  // Pin to bottom while the reader is at the bottom (new arrivals follow).
  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [visibleMessages]);

  // A message counts as read only after at least half of its row enters the
  // scroll viewport. Visibility churn is debounced by the read-state store.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sequence = Number(
            (entry.target as HTMLElement).dataset["seq"] ?? "0"
          );
          if (sequence <= 0) continue;
          if (entry.isIntersecting) visible.add(sequence);
          else visible.delete(sequence);
        }
        const highest = highestVisibleSequence(visible);
        if (online && highest > 0) onLatestSeq(channelId, highest);
      },
      { root: list, threshold: 0.5 }
    );
    for (const row of list.querySelectorAll<HTMLElement>("[data-seq]")) {
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, [channelId, onLatestSeq, online, visibleMessages.length]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    stickToBottomRef.current = distance < 80;
  }

  return (
    <div className="timeline" data-testid="timeline">
      <header className="timeline-header">
        <h1 className="timeline-title">{channelLabel}</h1>
        {channel.topic !== undefined && channel.topic !== "" && (
          <p className="timeline-topic">{channel.topic}</p>
        )}
      </header>

      <div
        className="timeline-scroll"
        ref={listRef}
        onScroll={handleScroll}
        data-testid="timeline-scroll"
      >
        {oldestCursor !== null && (messages[0]?.seq ?? 0) > 1 && (
          <button
            type="button"
            className="ghost-button load-older"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
          >
            {loadingOlder ? "불러오는 중…" : "이전 메시지 더 보기"}
          </button>
        )}

        {loadError !== null && (
          <div className="inline-state" role="alert">
            <p className="load-error">{loadError}</p>
            <button type="button" className="ghost-button" onClick={() => setLoadAttempt((value) => value + 1)}>
              타임라인 다시 불러오기
            </button>
          </div>
        )}

        {!loaded && <p className="muted timeline-empty">메시지 불러오는 중…</p>}

        {loaded && visibleMessages.length === 0 && loadError === null && (
          <p className="muted timeline-empty">아직 메시지가 없습니다.</p>
        )}

        <ol className="message-list">
          {visibleMessages.map((message, index) => {
            const previous = visibleMessages[index - 1];
            const startsGroup = startsAuthorGroup(previous, message);
            const showDate = previous === undefined || !isSameLocalDate(previous.createdAtMs, message.createdAtMs);
            const mentioned = mentionsMember(message.props, currentMemberId);
            const reactionEntries = Object.entries(
              Object.entries(reactions).find(([messageId]) => messageId.toLowerCase() === message.id.toLowerCase())?.[1] ?? {}
            );
            const approvalCard = approvalCardModel(message);
            const artifact = resolveArtifact(message);
            return (
              <Fragment key={message.seq}>
              {showDate && <li className="date-divider"><span>{dateFormat.format(new Date(message.createdAtMs))}</span></li>}
              <li
                key={message.seq}
                className={`message-row${startsGroup ? " message-group-start" : " message-group-continuation"}${mentioned ? " message-mentioned" : ""}`}
                data-testid="timeline-message"
                data-seq={message.seq}
              >
                {startsGroup && <div className="message-meta">
                  <span className="message-author">
                    {displayNameFor(message.authorMemberId)}
                  </span>
                  <time
                    className="message-time"
                    title={fullFormat.format(new Date(message.createdAtMs))}
                  >
                    {timeFormat.format(new Date(message.createdAtMs))}
                  </time>
                </div>}
                {!startsGroup && <time className="message-time message-time-continuation">{timeFormat.format(new Date(message.createdAtMs))}</time>}
                {message.state === "deleted" || message.deletedAtMs !== undefined ? (
                  <p className="message-body message-tombstone">메시지 삭제됨</p>
                ) : approvalCard !== null ? (
                  <ApprovalCard
                    approvalId={approvalCard.approvalId ?? message.id}
                    title={approvalCard.title}
                    summary={approvalCard.summary}
                    requesterName={displayNameFor(message.authorMemberId)}
                    status={resolveApprovalStatus(
                      approvalCard.approvalId === null
                        ? null
                        : approvals.statusFor(approvalCard.approvalId),
                      approvalCard.status
                    )}
                    isResumeOffer={approvalCard.isResumeOffer}
                    decide={approvals.decide}
                  />
                ) : artifact !== null ? (
                  <ArtifactCard presentation={artifact} />
                ) : (
                  <>
                    {message.type !== "text" && (
                      <span className="message-type-badge">
                        {TYPE_LABEL[message.type] ?? message.type}
                      </span>
                    )}
                    {message.body !== undefined && message.body !== "" ? (
                      <MessageContent body={message.body} />
                    ) : (
                      message.type !== "text" && (
                        <p className="message-body muted">에이전트 활동</p>
                      )
                    )}
                    {(message.state === "edited" || message.editedAtMs !== undefined) && <span className="edited-badge">수정됨</span>}
                  </>
                )}
                {reactionEntries.length > 0 && (
                  <div className="reaction-list" aria-label="반응">
                    {reactionEntries.map(([emoji, members]) => (
                      <span className="reaction-pill" key={emoji}>{emoji} {members.length}</span>
                    ))}
                  </div>
                )}
              </li>
              </Fragment>
            );
          })}
        </ol>
      </div>

      {readOnly ? (
        <footer className="timeline-footer timeline-read-only" role="status">
          관전 모드 · 메시지와 터미널 입력은 보낼 수 없습니다.
        </footer>
      ) : (
        <footer className="timeline-footer">
          <Composer
            workspaceId={workspaceId}
            channelId={channelId}
            placeholder={`${channelLabel}에 메시지 보내기`}
            online={online}
            onSent={(message) => appendMessages([fromRestMessage(message)])}
          />
        </footer>
      )}
    </div>
  );
}
