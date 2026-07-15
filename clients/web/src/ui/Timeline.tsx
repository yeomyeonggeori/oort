import { useCallback, useEffect, useRef, useState } from "react";
import type { Channel, Message } from "../api/client";
import { fetchMessages } from "../api/client";
import type { MessageNewEvent, RealtimeHandle } from "../realtime/realtime";

interface TimelineProps {
  workspaceId: string;
  channel: Channel;
  channelLabel: string;
  displayNameFor: (memberId: string) => string;
  realtime: RealtimeHandle | null;
}

/** Normalized display message (REST camelCase + realtime snake_case unify). */
interface UiMessage {
  id: string;
  seq: number;
  type: string;
  body?: string;
  authorMemberId: string;
  createdAtMs: number;
}

const HEAD_PAGE_LIMIT = 50;
const BACKFILL_LIMIT = 200;
const MAX_BACKFILL_PAGES = 10;

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

function fromRest(message: Message): UiMessage {
  const ui: UiMessage = {
    id: message.id,
    seq: message.seq,
    type: message.type,
    authorMemberId: message.authorMemberId,
    createdAtMs: message.createdAtMs,
  };
  if (message.body !== undefined) ui.body = message.body;
  return ui;
}

function fromRealtime(event: MessageNewEvent): UiMessage {
  const payload = event.payload;
  const ui: UiMessage = {
    id: payload.id,
    seq: payload.seq,
    type: payload.type,
    authorMemberId: payload.author_member_id,
    // The realtime envelope has no created_at; hlc_ts is epoch-ms based and
    // close enough for display. REST reloads carry the authoritative value.
    createdAtMs: payload.hlc_ts,
  };
  if (payload.body !== undefined && payload.body !== null) {
    ui.body = payload.body;
  }
  return ui;
}

/** seq is the per-channel ordering authority; merge dedupes on it. */
function mergeMessages(
  existing: UiMessage[],
  incoming: UiMessage[]
): UiMessage[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, UiMessage>();
  for (const message of existing) bySeq.set(message.seq, message);
  for (const message of incoming) {
    if (!bySeq.has(message.seq)) bySeq.set(message.seq, message);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const timeFormat = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
});
const fullFormat = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export default function Timeline({
  workspaceId,
  channel,
  channelLabel,
  displayNameFor,
  realtime,
}: TimelineProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [oldestCursor, setOldestCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  // Highest seq we have; realtime gap detection and `?after=` catch-up
  // read it outside of React's render cycle.
  const lastSeqRef = useRef(0);
  const catchUpRunningRef = useRef(false);
  // Until the head page establishes a seq baseline, catch-up must not run:
  // `after=0` would page the whole channel history oldest-first (up to
  // MAX_BACKFILL_PAGES * BACKFILL_LIMIT) and can stop short, leaving a seq
  // hole. Requests arriving early are deferred and replayed once loaded.
  // (Refs reset per channel — Timeline is keyed by channel id in ChatPage.)
  const headLoadedRef = useRef(false);
  const pendingCatchUpRef = useRef(false);
  const channelId = channel.id;

  const appendMessages = useCallback((incoming: UiMessage[]) => {
    setMessages((current) => {
      const merged = mergeMessages(current, incoming);
      const last = merged[merged.length - 1];
      if (last && last.seq > lastSeqRef.current) {
        lastSeqRef.current = last.seq;
      }
      return merged;
    });
  }, []);

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
    if (catchUpRunningRef.current) return;
    catchUpRunningRef.current = true;
    try {
      for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
        const response = await fetchMessages(workspaceId, channelId, {
          after: lastSeqRef.current,
          limit: BACKFILL_LIMIT,
        });
        const incoming = response.messages.map(fromRest);
        if (incoming.length > 0) appendMessages(incoming);
        if (incoming.length < BACKFILL_LIMIT) break;
      }
    } catch {
      // Transient; the next subscribe/publication cycle retries.
    } finally {
      catchUpRunningRef.current = false;
    }
  }, [appendMessages, channelId, workspaceId]);

  // Initial head load: newest page (descending) rendered ascending.
  useEffect(() => {
    let cancelled = false;
    async function loadHead() {
      try {
        const response = await fetchMessages(workspaceId, channelId, {
          limit: HEAD_PAGE_LIMIT,
        });
        if (cancelled) return;
        appendMessages(response.messages.map(fromRest));
        setOldestCursor(response.nextBefore ?? null);
        setLoaded(true);
        setLoadError(null);
        // Baseline established (lastSeqRef set via appendMessages). Unblock
        // catch-up and replay one deferred request so the recovered:false /
        // gap fallback semantics survive the initial mount race.
        headLoadedRef.current = true;
        if (pendingCatchUpRef.current) {
          pendingCatchUpRef.current = false;
          void catchUp();
        }
      } catch {
        if (!cancelled) setLoadError("메시지를 불러오지 못했습니다.");
      }
    }
    void loadHead();
    return () => {
      cancelled = true;
    };
  }, [appendMessages, catchUp, channelId, workspaceId]);

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
        const incoming = fromRealtime(event);
        if (incoming.seq > lastSeqRef.current + 1) {
          // Gap: never render around a hole — REST backfill closes it first.
          void catchUp();
        }
        appendMessages([incoming]);
      },
    });
    return unsubscribe;
  }, [appendMessages, catchUp, channelId, realtime, workspaceId]);

  async function loadOlder() {
    if (oldestCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await fetchMessages(workspaceId, channelId, {
        before: oldestCursor,
        limit: HEAD_PAGE_LIMIT,
      });
      appendMessages(response.messages.map(fromRest));
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
  }, [messages]);

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

        {loadError !== null && <p className="load-error">{loadError}</p>}

        {loaded && messages.length === 0 && loadError === null && (
          <p className="muted timeline-empty">아직 메시지가 없습니다.</p>
        )}

        <ol className="message-list">
          {messages.map((message) => (
            <li
              key={message.seq}
              className="message-row"
              data-testid="timeline-message"
              data-seq={message.seq}
            >
              <div className="message-meta">
                <span className="message-author">
                  {displayNameFor(message.authorMemberId)}
                </span>
                <time
                  className="message-time"
                  title={fullFormat.format(new Date(message.createdAtMs))}
                >
                  {timeFormat.format(new Date(message.createdAtMs))}
                </time>
              </div>
              {message.type !== "text" && (
                <span className="message-type-badge">
                  {TYPE_LABEL[message.type] ?? message.type}
                </span>
              )}
              {message.body !== undefined && message.body !== "" ? (
                <p className="message-body">{message.body}</p>
              ) : (
                message.type !== "text" && (
                  <p className="message-body muted">에이전트 활동</p>
                )
              )}
            </li>
          ))}
        </ol>
      </div>

      <footer className="timeline-footer">
        <p className="muted">
          읽기 전용 미리보기입니다. 메시지 작성은 다음 업데이트에서 열립니다.
        </p>
      </footer>
    </div>
  );
}
