import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SendHorizontal } from "lucide-react";
import type { RequestRouting, RosterMember } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
import { composerKeyIntent, isComposingEvent } from "@momo/core/features/chat/composerKeys";
import {
  agentTurnsInChannel,
  elapsedLabel,
  hasChannelTurn,
  useAgentWorkingSignals,
  useTickingNow,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import {
  activityLines,
  activitySuffix,
  activityText,
  agentLabelAsSubject,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
} from "@/features/agents/turnCopy";
import { memberFor, memberNameParts } from "@/features/workspace/useWorkspace";
import { openWorkPanel } from "@/features/agents/workLogStore";
import {
  MENTION_ROUTING_ROW_CLASS,
  MentionRoutingBar,
} from "@/features/routing/MentionRoutingBar";
import { useMentionRouting } from "@/features/routing/useMentionRouting";
import { mentionRoutingTarget } from "@momo/core/features/routing/mentionTargets";
import { routingPayload } from "@momo/core/features/routing/routingModel";
import type { QuoteDraft } from "@momo/core/features/timeline/quote";
import { QuoteChip } from "@/features/timeline/QuoteBlock";
import { TypingLine } from "@/features/chat/TypingLine";
import { useTypingSend } from "@/features/chat/useTyping";
import { useTypingThreshold, useTypists } from "@/features/chat/typingStore";

// =============================================================================
// Composer (R-1 §3). Send plus the @mention skeleton. ↵ sends, ⇧↵ is a line
// break, ⌘↵ still sends, Esc dismisses the mention list.
//
// ↵ was the line break until goal B8: every messenger a reader has used sends
// on it, so "왜 안 보내지" was the single most repeated moment of the QA sweep.
// The exception that makes the swap safe is the IME one, and it is big enough
// to live in its own tested file (composerKeys.ts): a 한글 sentence is composed
// before it is committed, and the Enter that commits it is the IME's keystroke,
// not a send.
//
// The mention list is hand-rolled rather than cmdk/Command: a Command popover
// owns its own input and would pull focus out of the textarea mid-sentence.
// This keeps the caret in the textarea and exposes a listbox for a11y.
//
// Sending is NOT owned here (M10): `onSend` is useTimeline's one send path, so
// the local echo, the seq reconcile and the failure state all live next to the
// timeline that renders them. The composer's job ends at clearing the input,
// which it does immediately: the message is already on screen as a pending row,
// and a composer that stays full while its message is visible below reads as if
// nothing happened.
// =============================================================================

const MAX_ROWS = 6;
const MENTION_LIMIT = 6;

interface MentionQuery {
  /** Index of the '@' that opened the query. */
  start: number;
  text: string;
}

/** The active @mention token at the caret, or null when there is none. */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // mid-word @ is not a mention
  const text = upto.slice(at + 1);
  if (/\s/.test(text)) return null;
  return { start: at, text };
}

export function matchMembers(
  members: RosterMember[],
  query: string,
  limit = MENTION_LIMIT
): RosterMember[] {
  const needle = query.trim().toLowerCase();
  const active = members.filter((m) => m.status === "active");
  const matched = needle
    ? active.filter(
        (m) =>
          m.handle.toLowerCase().includes(needle) ||
          m.displayName.toLowerCase().includes(needle)
      )
    : active;
  return matched.slice(0, limit);
}

/**
 * Composer activity bar (R-1 §3, mac AgentWorkingComposerBar). One flat meta
 * line per open turn, drawn from what the agent actually wrote, with its clock
 * beside its own label.
 *
 * It does NOT rotate. The mac bar cycles agent x headline pairs every five
 * seconds because a SwiftUI composer footer has one line to spend; on the web
 * that same loop is content that mutates on a timer, which needs a pause
 * control to meet WCAG 2.2.2, has no keyboard path when the pause is a hover,
 * and prints a "1/3" pager that reads as a slideshow inside a work tool. Two or
 * three stacked lines say more, sit still, and need no controls at all. Nothing
 * here animates, so there is no reduced-motion branch to diverge from.
 *
 * The bar states a turn even before a headline exists ("김인턴이 작업 중" plus a
 * clock is a true thing the reader wants) and states an approval wait as an
 * approval wait, never as work.
 *
 * OFFLINE (SKILL §5) is a state this bar has to SHOW, not merely encode. The
 * first cut expressed a dead rail by hiding the clock and rewriting an
 * aria-label, which for an awaiting_approval turn is a no-op on screen: the
 * line "Hermes가 승인을 기다립니다" was pixel-identical either way, so the app
 * kept asserting agent state on a socket that was gone. Now the agent token
 * comes off the name (the same demotion the sidebar pill makes: a remembered
 * claim must not look as confirmed as a live one) and one warn-colored line
 * says why, in place, which is what an offline banner is (§5) and not a toast.
 */
function AgentActivityBar({
  turns,
  directory,
  nowMs,
  live,
}: {
  turns: AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
  /** The realtime rail is connected, so a clock is measuring something. */
  live: boolean;
}) {
  const { lines, overflowCount, summary } = useMemo(
    () =>
      activityLines(turns, (memberId) =>
        memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME)
      ),
    [turns, directory]
  );

  if (lines.length === 0) return null;

  return (
    <ul
      className="flex flex-col gap-1 px-4 pb-2"
      // The offline sentence is a real list item below, so it is announced in
      // reading order rather than glued onto the list's name and read twice.
      aria-label={summary}
      data-testid="composer-working"
      data-live={live ? "" : undefined}
    >
      {lines.map((line) => {
        const turn = turns.find((t) => t.memberId === line.memberId);
        const runId = turn?.runId;
        const body = (
          <>
            <ActivityText line={line} live={live} />
            {live && line.state === "working" && line.startedAtMs !== undefined && (
              <span className="shrink-0 text-timestamp" data-numeric>
                {elapsedLabel(line.startedAtMs, nowMs)}
              </span>
            )}
          </>
        );
        return (
          <li key={line.key} className="flex text-meta text-ink-muted">
            {/* 작업 패널 진입점 ① (goal WEB-WP1). 이 줄은 이미 "지금 무슨 일이
                일어나고 있는가"이고, 그 과정을 펼쳐 보는 자리도 여기다.
                run을 특정하지 못한 턴은 버튼이 되지 않는다: 눌러도 아무 일이
                없는 컨트롤은 고장 난 버튼으로 읽힌다. */}
            {turn === undefined || runId === undefined ? (
              <span className="flex min-w-0 items-baseline gap-2">{body}</span>
            ) : (
              <button
                type="button"
                onClick={(event) =>
                  openWorkPanel(
                    {
                      runId,
                      memberId: turn.memberId,
                      channelId: turn.channelId,
                      origin: "activity",
                      // 이 줄이 이미 그리고 있는 시계와 같은 값이다. 패널이 자기
                      // 힘으로는 얻을 수 없는 유일한 값이라 여기서 넘겨준다.
                      ...(turn.startedAtMs !== undefined
                        ? { startedAtMs: turn.startedAtMs }
                        : {}),
                    },
                    // 닫을 때 캐럿이 돌아올 자리. WebKit은 클릭으로 버튼에
                    // 포커스를 주지 않으므로 추정에 맡기지 않는다.
                    event.currentTarget
                  )
                }
                // 이름을 명시한다. 자식에 맡기면 접근성 이름에 1초마다 바뀌는
                // 시계가 들어가고, 보조기술이 그 줄을 초당 한 번 다시 읽는다.
                aria-label={`${activityText(line)}. 진행 과정 열기`}
                data-testid="composer-working-open"
                className="flex min-w-0 items-baseline gap-2 rounded-sm text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
      {overflowCount > 0 && (
        <li className="text-meta text-ink-muted">
          외 <span data-numeric>{overflowCount}</span>명
        </li>
      )}
      {!live && (
        <li className="text-meta text-warn" data-testid="composer-working-stale">
          {TURN_STALE_SENTENCE}
        </li>
      )}
    </ul>
  );
}

/**
 * The line itself. `min-w-0 truncate` without `flex-1`, so the clock sits right
 * after the text it belongs to: a right-aligned number a screen away from its
 * label stops reading as a card and starts reading as a banner (tokens.md §4).
 */
function ActivityText({
  line,
  live,
}: {
  line: AgentActivityLine;
  live: boolean;
}) {
  return (
    <span className="min-w-0 truncate" title={activityText(line)}>
      {/* Offline the name drops to the row's own ink-muted: agent identity is a
          claim about who is acting right now, and nobody is acting right now. */}
      <span className={live ? "text-agent" : undefined}>{line.name.name}</span>
      {line.name.handle && (
        <span className="text-ink-muted">({line.name.handle})</span>
      )}
      {activitySuffix(line)}
    </span>
  );
}

export function Composer({
  workspaceId,
  channelId,
  directory,
  channelLabel,
  dmAgent,
  quote,
  onCancelQuote,
  onSend,
}: {
  /** ADR-0149 - 「작성 중」 발행은 워크스페이스로 스코프된 라우트다. */
  workspaceId: string;
  /** Scopes the agent working signal to this channel; sending goes via onSend. */
  channelId: string;
  directory: Directory;
  channelLabel: string;
  /**
   * The agent this channel answers without an @mention
   * (`dmAutoReplyAgent`), or null. Present only to decide one sentence of
   * hint copy: the routing decision is the server's and is never taken here.
   */
  dmAgent: RosterMember | null;
  /**
   * ADR-0148 - 이 글이 가리키는 메시지, 또는 null. 채널 표면이 들고 있는 이유는
   * 인용을 거는 행위가 **타임라인에서** 일어나고 컴포저는 마운트/언마운트되기
   * 때문이다: 여기 두면 스레드를 열었다 닫는 사이에 걸어 둔 인용이 사라진다.
   */
  quote: QuoteDraft | null;
  onCancelQuote: () => void;
  /**
   * useTimeline's send: inserts the local echo, then reconciles by seq.
   * `routing` is ADR-0134 D1's per-request override and is undefined for every
   * send that inherits, which is every send this ticket did not change.
   * `replyToId` is the quote binding and travels the same one write path.
   */
  onSend: (
    body: string,
    options?: { routing?: RequestRouting; replyToId?: string }
  ) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Raised by `compositionend`, lowered by the next `keyup` (composerKeys.ts).
  // In WebKit, which is the Tauri shell's engine, `compositionend` is dispatched
  // BEFORE the keydown of the Enter that committed the composition, so by the
  // time we see that keydown `isComposing` is already false. This ref is the
  // only thing standing between a 한글 sentence and being posted half-written.
  const justComposedRef = useRef(false);

  // The clock is mounted for THIS channel's turns, not the workspace's: the
  // store is workspace-wide, and gating on its size alone re-rendered the
  // composer once a second because an agent was busy in a channel nobody here
  // is looking at. The membership test is clock-free, so it can decide whether
  // to start the clock before there is one.
  //
  // `useTickingNow` returns the render's own clock whatever the argument says;
  // the argument only buys the 1Hz re-render. That is what makes the same
  // `nowMs` safe to hand to the staleness filter. Handing it a value the tick
  // captured meant that with the rail down (no tick) the clock froze at the
  // moment the socket died, `isStaleSignal` compared two fixed numbers, and the
  // 90s TTL could never fire on this surface at all. Now every render, from
  // whatever cause, re-reads the wall clock and drops what has gone quiet.
  const { session, connStatus } = useSession();
  // 폰에서는 Enter가 계속 줄바꿈이다 (goal B8 H4). 소프트 키보드에는 Shift+Enter가
  // 없어서, Enter를 전송으로 바꾸면 여러 줄 쓰기를 통째로 없애게 된다. 힌트 줄도
  // 같은 중단점에서 접히므로 화면과 키가 어긋나지 않는다.
  const isMobile = useIsMobileShell();
  const railLive = connStatus === "connected";
  const signals = useAgentWorkingSignals();

  // ── 「작성 중」 (ADR-0149) ────────────────────────────────────────────────
  //
  // 송신은 레일이 살아 있을 때만 한다. 소켓이 죽어 있으면 발행은 REST로 나가지만
  // 아무도 그것을 구독하고 있지 않으므로, 그 요청은 서버 rate limit만 먹는다.
  const me = session.member.id;
  const typing = useTypingSend(workspaceId, channelId, { enabled: railLive });
  const typists = useTypists({
    channelId,
    myMemberId: me,
    // 에이전트를 화면에서 떨군다. 서버가 403으로 막지만 이것은 화면의 방어다:
    // 그려지는 순간 「사람은 작성 중, 에이전트는 작업 중」이 화면에서 깨진다.
    // 명부에 없는 id도 떨군다 - 이름 없는 「누군가 작성 중」은 정보가 0이다.
    isEligible: (memberId) => memberFor(directory, memberId)?.kind === "human",
  });
  const typingThreshold = useTypingThreshold();
  const nowMs = useTickingNow(hasChannelTurn(signals, channelId) && railLive);
  const turns = agentTurnsInChannel(signals, channelId, nowMs);

  const query = mentionOpen ? mentionQueryAt(text, caret) : null;
  const candidates = useMemo(
    () => (query ? matchMembers(directory.members, query.text) : []),
    [query, directory.members]
  );
  const showMentions = candidates.length > 0;

  const rows = Math.min(MAX_ROWS, Math.max(1, text.split("\n").length));

  // 1회 오버라이드는 지금 이 글이 부르는 에이전트에 붙는다(ADR-0134 D1). 대상은
  // 확정된 멘션이 아니라 **텍스트에 남아 있는 멘션**에서 다시 계산한다: 사람이
  // 고른 뒤 그 핸들을 지웠다면 붙일 요청 자체가 없어졌기 때문이다.
  const routingTarget = useMemo(
    () => mentionRoutingTarget(text, directory.members),
    [text, directory.members]
  );
  const routing = useMentionRouting(routingTarget);

  // 줄이 한 번 생기면 이 글을 다 쓸 때까지 자리를 비워 둔다.
  //
  // 멘션을 확정했다 지웠다 하는 동안 줄이 붙었다 떨어지면 입력창이 캐럿 아래에서
  // 세로로 튄다(R1 M11). 한 번의 작성에서 이동은 한 번이면 충분하고, 그 한 번은
  // 사람이 에이전트를 부른 순간이다. 비어 있는 자리는 구분선 하나이고 아무것도
  // 주장하지 않는다. 글을 비우거나 보내면 자리도 함께 사라진다.
  const [rowReserved, setRowReserved] = useState(false);
  const hasTarget = routingTarget.kind !== "none";
  useEffect(() => {
    if (hasTarget) setRowReserved(true);
    else if (text.trim() === "") setRowReserved(false);
  }, [hasTarget, text]);

  function applyMention(member: RosterMember) {
    if (!query) return;
    const next = `${text.slice(0, query.start)}@${member.handle} ${text.slice(caret)}`;
    setText(next);
    setMentionOpen(false);
    const position = query.start + member.handle.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function submit(body: string) {
    // 오버라이드는 이 전송분과 함께 떠난다. 값을 먼저 읽어 두고 상태를 비우는
    // 순서인 이유는 "1회"라는 라벨이 지켜져야 하기 때문이다: 보낸 뒤에도 줄이
    // 켜져 있으면 다음 메시지가 고른 적 없는 강도로 나간다.
    const payload = routingPayload(routing.draft);
    // 인용도 같은 성질이다: 이 전송분과 함께 떠난다. 한 번 인용했다고 다음 글도
    // 같은 메시지를 가리키면, 사람이 고르지 않은 주장을 대화에 넣는 것이다.
    const replyToId = quote?.targetId;
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry, so there is nothing left for
    // the composer to hold on to.
    setText("");
    setMentionOpen(false);
    routing.reset();
    onCancelQuote();
    void onSend(body, {
      ...(payload ? { routing: payload } : {}),
      ...(replyToId === undefined ? {} : { replyToId }),
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    submit(body);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Self-healing: only Enter and Tab can be the key that commits a
    // composition, so any other key proves we are past one. Without this a
    // composition ended by something other than a keystroke (clicking send
    // mid-syllable) could leave the guard raised, and the next deliberate Enter
    // would be swallowed. `justComposed` is not read for these keys, so
    // clearing it before the decision changes nothing about this keystroke.
    if (event.key !== "Enter" && event.key !== "Tab") {
      justComposedRef.current = false;
    }
    const intent = composerKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        composing: isComposingEvent(event.nativeEvent),
      },
      {
        mentionsOpen: showMentions,
        justComposed: justComposedRef.current,
        enterSends: !isMobile,
        quoteOpen: quote !== null,
      }
    );

    switch (intent) {
      case "send": {
        event.preventDefault();
        const body = text.trim();
        if (body) submit(body);
        return;
      }
      case "mention-accept":
        event.preventDefault();
        applyMention(candidates[Math.min(highlight, candidates.length - 1)]);
        return;
      case "mention-next":
        event.preventDefault();
        setHighlight((h) => (h + 1) % candidates.length);
        return;
      case "mention-prev":
        event.preventDefault();
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
        return;
      case "mention-close":
        event.preventDefault();
        setMentionOpen(false);
        return;
      case "quote-cancel":
        // Esc는 「지금 열려 있는 것을 닫는다」이고, 멘션 목록이 닫혀 있을 때 이
        // 컴포저에 열려 있는 것은 인용이다. 취소 버튼과 같은 일을 하는 두 번째
        // 길이며, 키보드에만 있는 쪽이다 (ADR-0148 미결 3).
        event.preventDefault();
        onCancelQuote();
        return;
      // "newline" and "pass" are both the textarea's own behaviour, and that is
      // the point: an IME keystroke is never intercepted, not even to be
      // re-dispatched.
      case "newline":
      case "pass":
        return;
    }
  }

  return (
    // `safe-area-bottom` (goal B6): 폰에서 컴포저는 셸의 마지막 줄이고, 그 아래는
    // iOS 홈 인디케이터다. 안전 영역만큼 물러나지 않으면 전송 버튼의 아랫부분이
    // 시스템 제스처 영역에 들어가 눌리지 않는다.
    <div className="safe-area-bottom border-t border-line">
      {/* 인용 칩 (ADR-0148). 라우팅 줄보다 **위**에 온다: 라우팅은 "이 글이 어떻게
          처리되는가"고 인용은 "이 글이 무엇에 대한 것인가"라서, 읽는 순서가
          맥락 -> 처리 -> 입력이다. */}
      {quote && (
        <QuoteChip
          block={quote.block}
          directory={directory}
          onCancel={onCancelQuote}
        />
      )}
      {/* 입력창 바로 위: 이번 메시지에 무엇이 적용되는지가 글을 쓰는 자리에서
          보여야 한다. Cursor가 모델 피커를 입력창 하단 바에 둔 이유와 같고
          (레퍼런스 §2), 상속 상태에서도 사라지지 않는 이유는 "바꾸지 않으면
          무엇이 되는가"가 이 줄의 본래 내용이기 때문이다. */}
      {hasTarget ? (
        <MentionRoutingBar
          channelId={channelId}
          target={routingTarget}
          draft={routing.draft}
          onDraftChange={routing.setDraft}
        />
      ) : (
        rowReserved && (
          <div
            className={MENTION_ROUTING_ROW_CLASS}
            aria-hidden="true"
            data-testid="composer-routing-reserved"
          />
        )
      )}

      <form onSubmit={onSubmit} className="relative flex items-end gap-2 p-3">
        {showMentions && (
          <ul
            role="listbox"
            aria-label="멤버 언급"
            data-testid="mention-list"
            className="absolute bottom-full left-3 mb-2 w-pane-sm overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-lg"
          >
            {candidates.map((member, index) => (
              <li key={member.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  data-testid="mention-option"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(member);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body",
                    index === highlight
                      ? "bg-accent-soft text-ink"
                      : "text-ink"
                  )}
                >
                  <span className="truncate">@{member.handle}</span>
                  <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
                    {member.displayName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="sr-only" htmlFor="composer-input">
          {channelLabel}에 보낼 메시지
        </label>
        <textarea
          id="composer-input"
          ref={inputRef}
          value={text}
          rows={rows}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? 0);
            setMentionOpen(true);
            setHighlight(0);
            // 「작성 중」은 **키에서만** 나간다 (ADR-0149). 타이머가 없으므로 입력이
            // 멈추면 송신도 멈추고, 흐림·탭 전환·언마운트에 끌 것이 없다. 소멸은
            // TTL이 하고 「정지」 신호는 계약에 없다.
            typing.onInput();
          }}
          onSelect={(event) =>
            setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={onKeyDown}
          // The composition window, in three lines. `compositionstart` closes
          // the guard (a new session cannot be a stale commit), `compositionend`
          // opens it, and any key release closes it again, which bounds the
          // guard to the single keystroke that can sit between those two events.
          onCompositionStart={() => {
            justComposedRef.current = false;
          }}
          onCompositionEnd={() => {
            justComposedRef.current = true;
          }}
          onKeyUp={() => {
            justComposedRef.current = false;
          }}
          // A composition abandoned by clicking away leaves the guard raised;
          // it must not still be raised when the caret comes back.
          onBlur={() => {
            justComposedRef.current = false;
          }}
          placeholder={`${channelLabel}에 메시지 보내기`}
          aria-describedby="composer-hint"
          data-testid="composer-input"
          className="tap-target min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-transparent px-3 py-2 text-body leading-relaxed placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <Button
          type="submit"
          size="icon"
          className="tap-target"
          disabled={text.trim().length === 0}
          aria-label="메시지 보내기"
          title={isMobile ? "메시지 보내기" : "메시지 보내기 (Enter)"}
          data-testid="composer-send"
        >
          <SendHorizontal />
        </Button>
      </form>

      {/* Enter가 보내기가 된 이상, 줄바꿈이 어디로 갔는지 이 자리에서 말해야
          한다. 한 줄이고, 입력창 바로 아래이며, 조용하다: 이 힌트는 알림이
          아니라 키 배치의 설명이다. 폰에는 화면 키보드의 줄바꿈 키가 따로 있고
          ⌘도 없으므로 좁은 폭에서는 접는다.

          goal B13(QA H7): 에이전트와의 1:1 DM에서는 멘션 없이도 답한다는 사실이
          한 조각 더 붙는다. 새 줄이 아니라 같은 줄인 이유 — 둘 다 "이 입력창이
          어떻게 동작하는가"이고, 설명이 두 줄이 되는 순간 안내가 아니라 배너다.
          이쪽은 wide-only가 아니다: ⌘ 없는 기기에도 이 규칙은 그대로 있고,
          폰에서 멘션을 타이핑하는 수고는 오히려 더 크다. */}
      <p
        id="composer-hint"
        // px-6 = 폼의 p-3(12px) + 텍스트에어리어의 px-3(12px). 힌트의 첫 글자가
        // 플레이스홀더의 첫 글자와 같은 세로선에 선다. px-4는 어느 쪽 모서리와도
        // 맞지 않아 4px 어긋난 줄로 보였다.
        //
        // DM 문장이 없을 때는 줄 전체가 wide-only다(기존 동작 그대로). 안쪽
        // span에만 걸면 좁은 폭에서 빈 <p>의 pb-2가 남아 8px 죽은 공간이 된다.
        className={cn(
          "px-6 pb-2 text-meta text-ink-muted",
          !dmAgent && "wide-only"
        )}
        data-testid="composer-hint"
      >
        {dmAgent && (
          <span data-testid="composer-dm-hint">
            멘션 없이 바로 말하면{" "}
            {agentLabelAsSubject(
              memberNameParts(directory, dmAgent.id, dmAgent.displayName)
            )}{" "}
            답합니다
          </span>
        )}
        <span className="wide-only" data-testid="composer-keys-hint">
          {dmAgent ? " · " : ""}Enter로 보내기, Shift+Enter로 줄바꿈
        </span>
      </p>

      {/* 사람이 위, 에이전트가 아래. 같은 구역에 나란히 두는 것이 「작성 중」과
          「작업 중」을 사람이 배우는 유일한 자리다 (TypingLine의 머리 주석). */}
      <TypingLine
        memberIds={typists}
        threshold={typingThreshold}
        directory={directory}
      />

      <AgentActivityBar
        turns={turns}
        directory={directory}
        nowMs={nowMs}
        live={railLive}
      />
    </div>
  );
}
