import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SendHorizontal } from "lucide-react";
import type { RequestRouting, RosterMember } from "@/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
import { composerKeyIntent, isComposingEvent } from "@/features/chat/composerKeys";
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
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
} from "@/features/agents/turnCopy";
import { memberNameParts } from "@/features/workspace/useWorkspace";
import {
  MENTION_ROUTING_ROW_CLASS,
  MentionRoutingBar,
} from "@/features/routing/MentionRoutingBar";
import { useMentionRouting } from "@/features/routing/useMentionRouting";
import { mentionRoutingTarget } from "@/features/routing/mentionTargets";
import { routingPayload } from "@/features/routing/routingModel";

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
      {lines.map((line) => (
        <li
          key={line.key}
          className="flex items-baseline gap-2 text-meta text-ink-muted"
        >
          <ActivityText line={line} live={live} />
          {live && line.state === "working" && line.startedAtMs !== undefined && (
            <span className="shrink-0 text-timestamp" data-numeric>
              {elapsedLabel(line.startedAtMs, nowMs)}
            </span>
          )}
        </li>
      ))}
      {overflowCount > 0 && (
        <li className="text-meta text-ink-muted">
          외 <span data-numeric>{overflowCount}</span>명
        </li>
      )}
      {!live && (
        <li className="text-meta text-warn" data-testid="composer-working-stale">
          연결이 끊겨 갱신이 멈췄습니다. 마지막으로 확인된 상태입니다.
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
  channelId,
  directory,
  channelLabel,
  onSend,
}: {
  /** Scopes the agent working signal to this channel; sending goes via onSend. */
  channelId: string;
  directory: Directory;
  channelLabel: string;
  /**
   * useTimeline's send: inserts the local echo, then reconciles by seq.
   * `routing` is ADR-0134 D1's per-request override and is undefined for every
   * send that inherits, which is every send this ticket did not change.
   */
  onSend: (body: string, routing?: RequestRouting) => Promise<void> | void;
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
  const { connStatus } = useSession();
  // 폰에서는 Enter가 계속 줄바꿈이다 (goal B8 H4). 소프트 키보드에는 Shift+Enter가
  // 없어서, Enter를 전송으로 바꾸면 여러 줄 쓰기를 통째로 없애게 된다. 힌트 줄도
  // 같은 중단점에서 접히므로 화면과 키가 어긋나지 않는다.
  const isMobile = useIsMobileShell();
  const railLive = connStatus === "connected";
  const signals = useAgentWorkingSignals();
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
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry, so there is nothing left for
    // the composer to hold on to.
    setText("");
    setMentionOpen(false);
    routing.reset();
    void onSend(body, payload);
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
          ⌘도 없으므로 좁은 폭에서는 접는다. */}
      <p
        id="composer-hint"
        className="wide-only px-4 pb-2 text-meta text-ink-muted"
        data-testid="composer-hint"
      >
        Enter로 보내기, Shift+Enter로 줄바꿈
      </p>

      <AgentActivityBar
        turns={turns}
        directory={directory}
        nowMs={nowMs}
        live={railLive}
      />
    </div>
  );
}
