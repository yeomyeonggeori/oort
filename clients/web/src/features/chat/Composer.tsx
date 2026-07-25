import {
  useEffect,
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
import { useReducedMotion } from "@/design/lib/useReducedMotion";
import type { Directory } from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useAgentWorkingSignals,
  useTickingNow,
  workingInChannel,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import {
  activitySuffix,
  activityText,
  rotatingActivityLines,
  staticActivityLines,
  type AgentActivityLine,
} from "@/features/agents/activityLine";
import { memberFor } from "@/features/workspace/useWorkspace";

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

/**
 * Headline dwell in the activity bar. Short enough that a second agent's line is
 * not hidden behind the first one for long, and pausable: the pointer resting on
 * the bar holds the current line, so a reader who wants to finish one is not
 * raced by the next.
 */
const HEADLINE_ROTATION_MS = 2_200;

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
 * Composer activity bar (R-1 §3, mac AgentWorkingComposerBar). One line at a
 * time, drawn from what the agent actually wrote, plus the turn clock.
 *
 * The bar states the turn even before a headline exists, because "김인턴이(가)
 * 작업 중" plus a clock is a true thing the reader wants; what it never does is
 * rotate through nothing. Rotation is the only motion here and it is content
 * motion, so `prefers-reduced-motion` does not slow it down, it removes it:
 * every working agent gets its own static line instead.
 */
function AgentActivityBar({
  working,
  directory,
  nowMs,
}: {
  working: AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
}) {
  const reducedMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const lines = useMemo(() => {
    const nameFor = (memberId: string) =>
      memberFor(directory, memberId)?.displayName ?? null;
    return {
      rotating: rotatingActivityLines(working, nameFor),
      static: staticActivityLines(working, nameFor),
    };
  }, [working, directory]);

  const rotatingCount = lines.rotating.length;
  useEffect(() => {
    if (reducedMotion || paused || rotatingCount < 2) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % rotatingCount),
      HEADLINE_ROTATION_MS
    );
    return () => clearInterval(id);
  }, [reducedMotion, paused, rotatingCount]);

  // A turn that ends shortens the list; the cursor must not point past its end.
  useEffect(() => {
    setIndex((i) => (rotatingCount === 0 ? 0 : i % rotatingCount));
  }, [rotatingCount]);

  if (working.length === 0) return null;

  if (reducedMotion) {
    const summary =
      working.length > 1
        ? `에이전트 ${working.length}명이 작업 중`
        : "에이전트가 작업 중";
    return (
      <ul
        className="flex flex-col gap-1 px-4 pb-2"
        aria-label={summary}
        data-testid="composer-working"
      >
        {lines.static.map((line) => (
          <li
            key={line.key}
            className="flex items-baseline gap-2 text-meta text-ink-muted"
          >
            <ActivityText line={line} />
            <ActivityElapsed startedAtMs={line.startedAtMs} nowMs={nowMs} />
          </li>
        ))}
      </ul>
    );
  }

  // No aria-label and no live region on the rotating form: a paragraph is not
  // reliably named by one, and announcing a new line every 2.2s would be noise
  // rather than information. Its own text is the accessible content, and a
  // reader who has reduced motion on gets the named static list above.
  const current = lines.rotating[index % rotatingCount];
  return (
    <p
      className="flex items-baseline gap-2 px-4 pb-2 text-meta text-ink-muted"
      data-testid="composer-working"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <ActivityText line={current} />
      {rotatingCount > 1 && (
        <span
          className="shrink-0 text-timestamp"
          data-numeric
          aria-hidden="true"
        >
          {index % rotatingCount + 1}/{rotatingCount}
        </span>
      )}
      <ActivityElapsed startedAtMs={current.startedAtMs} nowMs={nowMs} />
    </p>
  );
}

function ActivityText({ line }: { line: AgentActivityLine }) {
  return (
    <span className="min-w-0 flex-1 truncate" title={activityText(line)}>
      <span className="text-agent">{line.agentName}</span>
      {activitySuffix(line)}
    </span>
  );
}

function ActivityElapsed({
  startedAtMs,
  nowMs,
}: {
  startedAtMs?: number;
  nowMs: number;
}) {
  if (startedAtMs === undefined) return null;
  return (
    <span className="shrink-0 text-timestamp" data-numeric>
      {elapsedLabel(startedAtMs, nowMs)}
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

  const signals = useAgentWorkingSignals();
  const nowMs = useTickingNow(signals.size > 0);
  const working = workingInChannel(signals, channelId, nowMs);

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

      <AgentActivityBar working={working} directory={directory} nowMs={nowMs} />
    </div>
  );
}
