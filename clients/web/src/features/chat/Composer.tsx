import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SendHorizontal } from "lucide-react";
import type { RosterMember } from "@/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import type { Directory } from "@/features/workspace/useWorkspace";
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

// =============================================================================
// Composer (R-1 §3). Send plus the @mention skeleton. ⌘↵ sends, ↵ is a line
// break, Esc dismisses the mention list.
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
  /** useTimeline's send: inserts the local echo, then reconciles by seq. */
  onSend: (body: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry, so there is nothing left for
    // the composer to hold on to.
    setText("");
    setMentionOpen(false);
    void onSend(body);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    submit(body);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showMentions) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) => (h + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(candidates[Math.min(highlight, candidates.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const body = text.trim();
      if (body) submit(body);
    }
  }

  return (
    <div className="border-t border-line">
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
          placeholder={`${channelLabel}에 메시지 보내기`}
          data-testid="composer-input"
          className="min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-transparent px-3 py-2 text-body leading-relaxed placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <Button
          type="submit"
          size="icon"
          disabled={text.trim().length === 0}
          aria-label="메시지 보내기"
          title="메시지 보내기 (⌘↵)"
          data-testid="composer-send"
        >
          <SendHorizontal />
        </Button>
      </form>

      <AgentActivityBar
        turns={turns}
        directory={directory}
        nowMs={nowMs}
        live={railLive}
      />
    </div>
  );
}
