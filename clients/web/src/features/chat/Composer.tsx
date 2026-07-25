import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SendHorizontal } from "lucide-react";
import { sendMessage, type Message, type RosterMember } from "@/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import type { Directory } from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useAgentWorkingSignals,
  workingInChannel,
} from "@/features/agents/agentWorkingSignal";
import { memberFor } from "@/features/workspace/useWorkspace";

// =============================================================================
// Composer (R-1 §3). Send plus the @mention skeleton. ⌘↵ sends, ↵ is a line
// break, Esc dismisses the mention list.
//
// The mention list is hand-rolled rather than cmdk/Command: a Command popover
// owns its own input and would pull focus out of the textarea mid-sentence.
// This keeps the caret in the textarea and exposes a listbox for a11y.
// =============================================================================

const MAX_ROWS = 6;
const MENTION_LIMIT = 6;

/**
 * The one send path. The composer's first attempt, its own retry, and the
 * inline retry on a failed timeline row all go through here, so "다시 보내기"
 * can never drift from "보내기".
 *
 * clientMsgId is the idempotency key (L4 §3.1) and a retry mints a NEW one: the
 * failed attempt was never accepted, so reusing its key would be a lie. The
 * message returns over the realtime rail and merges by seq, so there is no
 * optimistic insert to reconcile.
 */
export function sendComposerMessage(
  workspaceId: string,
  channelId: string,
  body: string
): Promise<Message> {
  return sendMessage(workspaceId, channelId, crypto.randomUUID(), body);
}

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

export function Composer({
  workspaceId,
  channelId,
  directory,
  channelLabel,
}: {
  workspaceId: string;
  channelId: string;
  directory: Directory;
  channelLabel: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const signals = useAgentWorkingSignals();
  const working = workingInChannel(signals, channelId);

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

  async function submit(body: string) {
    setBusy(true);
    setFailed(null);
    try {
      await sendComposerMessage(workspaceId, channelId, body);
      setText("");
    } catch {
      setFailed(body);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    void submit(body);
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
      if (body && !busy) void submit(body);
    }
  }

  return (
    <div className="border-t border-line">
      {failed !== null && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 text-body text-danger"
          role="alert"
          data-testid="composer-failed"
        >
          <span className="min-w-0 flex-1 truncate">
            메시지를 보내지 못했습니다. 연결을 확인하고 다시 보내세요.
          </span>
          <Button variant="outline" size="sm" onClick={() => void submit(failed)}>
            다시 보내기
          </Button>
        </div>
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
          placeholder={`${channelLabel}에 메시지 보내기`}
          data-testid="composer-input"
          className="min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-transparent px-3 py-2 text-body leading-relaxed placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <Button
          type="submit"
          size="icon"
          disabled={busy || text.trim().length === 0}
          aria-label="메시지 보내기"
          title="메시지 보내기 (⌘↵)"
          data-testid="composer-send"
        >
          <SendHorizontal />
        </Button>
      </form>

      {working.length > 0 && (
        <p
          className="px-4 pb-2 text-meta text-ink-muted"
          data-testid="composer-working"
        >
          {memberFor(directory, working[0].memberId)?.displayName ?? "에이전트"}
          이(가) 작업 중 · {elapsedLabel(working[0].startedAtMs, Date.now())}
        </p>
      )}
    </div>
  );
}
