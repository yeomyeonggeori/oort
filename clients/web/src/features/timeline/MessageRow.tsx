import { useState } from "react";
import { threadRollup, type Message, type RosterMember } from "@/lib/api";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { AgentCard } from "./AgentCard";
import { agentCardModel, cardKeepsBody } from "./agentCardModel";

// =============================================================================
// One message row (R-1 §3). Humans and agents share the SAME grid and the same
// typography: agent identity is carried only by the --agent token (predawn
// slate-blue) on the avatar and handle, plus the "managed by {owner}"
// attribution. No bubble shape, no row background tint (design-taste-web §9).
//
// --agent is a measured token (MOMO-597): >= 90 degrees of OKLab hue away from
// the human --accent, so the two identities can never converge by a tweak.
// =============================================================================

const AGENT_TEXT = "text-agent";

function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function relativeLabel(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

function Avatar({ member, name }: { member: RosterMember | null; name: string }) {
  const isAgent = member?.kind === "agent";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 items-center justify-center rounded-sm text-meta font-semibold",
        isAgent ? "bg-agent-soft text-agent" : "bg-surface-hover text-ink"
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

export function MessageRow({
  message,
  startsGroup,
  directory,
  onOpenThread,
  onResend,
}: {
  message: Message;
  startsGroup: boolean;
  directory: Directory;
  onOpenThread?: (message: Message) => void;
  /** Re-send a row the server marked `failed` (the composer's send path). */
  onResend?: (message: Message) => Promise<void> | void;
}) {
  const [resending, setResending] = useState(false);
  const author = memberFor(directory, message.authorMemberId);
  const isAgent = author?.kind === "agent";
  const name = author?.displayName ?? message.authorMemberId.slice(0, 8);
  const owner = isAgent ? memberFor(directory, author?.ownerHumanId) : null;
  const deleted = message.state === "deleted";
  const failed = message.state === "failed";
  const rollup = threadRollup(message);
  // Agent events render their structured body as a card in the SAME row (R-1
  // §4): tool runs, approvals and settled turn cost. Ordinary prose returns
  // null here and the row is untouched.
  const card = agentCardModel(message);

  return (
    <article
      data-testid="timeline-message"
      data-seq={message.seq}
      data-author-kind={author?.kind ?? "unknown"}
      className={cn(
        "flex gap-2 px-4 hover:bg-surface-hover",
        startsGroup ? "pt-3 pb-1" : "py-1"
      )}
    >
      <div className="w-6 shrink-0">
        {startsGroup && <Avatar member={author} name={name} />}
      </div>
      <div className="min-w-0 flex-1">
        {startsGroup && (
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={cn(
                "text-body font-semibold",
                isAgent ? AGENT_TEXT : "text-ink"
              )}
            >
              {isAgent ? `@${author?.handle ?? name}` : name}
            </span>
            {owner && (
              <span className="text-meta text-ink-muted">
                managed by {owner.displayName}
              </span>
            )}
            <time
              dateTime={new Date(message.createdAtMs).toISOString()}
              data-numeric
              className="text-timestamp text-ink-muted"
            >
              {timeLabel(message.createdAtMs)}
            </time>
          </div>
        )}
        {(card === null || cardKeepsBody(card)) && (
          <p
            className={cn(
              "whitespace-pre-wrap break-words text-body leading-relaxed",
              deleted && "text-ink-muted"
            )}
          >
            {deleted ? "삭제된 메시지" : message.body}
          </p>
        )}
        {card && <AgentCard card={card} directory={directory} />}
        {message.state === "edited" && (
          <span className="text-meta text-ink-muted">수정됨</span>
        )}
        {failed && (
          // The retry lives on the row, not in a banner far from it (R-1 §3
          // "전송 실패 [재시도]"). It runs the composer's send path, so a
          // resend is a new send with a fresh idempotency key, not a replay.
          <span
            className="flex flex-wrap items-center gap-2 text-meta text-danger"
            data-testid="message-failed"
          >
            전송 실패
            {message.body && onResend && (
              <button
                type="button"
                disabled={resending}
                data-testid="message-resend"
                onClick={() => {
                  setResending(true);
                  void Promise.resolve(onResend(message)).finally(() =>
                    setResending(false)
                  );
                }}
                className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {resending ? "보내는 중…" : "다시 보내기"}
              </button>
            )}
          </span>
        )}
        {rollup && (
          <button
            type="button"
            onClick={() => onOpenThread?.(message)}
            data-testid="thread-anchor"
            className="mt-1 rounded-sm text-meta text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            답글 {rollup.replyCount}개 · 마지막{" "}
            {relativeLabel(rollup.lastReplyAtMs, Date.now())}
          </button>
        )}
      </div>
    </article>
  );
}

/** Day separator. A rule with the date inline, not a centered pill. */
export function DayDivider({ atMs }: { atMs: number }) {
  const d = new Date(atMs);
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="day-divider">
      <span className="text-meta text-ink-muted" data-numeric>
        {d.getFullYear()}년 {d.getMonth() + 1}월 {d.getDate()}일
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Unread boundary. Count is server truth (P7), never a local tally. */
export function UnreadDivider({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2" data-testid="unread-divider">
      <span className="text-meta font-medium text-accent" data-numeric>
        새 메시지 {count}개, 여기까지 읽음
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-accent" />
    </div>
  );
}

/**
 * Reconnect marker. `seq` is exact because the server issues it, so the user is
 * told precisely how far the timeline was restored instead of being left to
 * wonder what a clock-skewed "since 5s ago" window missed (R-1 §3).
 */
export function RecoveryDivider({
  seq,
  source,
}: {
  seq: number;
  source: "replay" | "backfill";
}) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2"
      data-testid="recovery-divider"
      data-seq={seq}
      data-source={source}
    >
      <span className="text-meta text-ink-muted" data-numeric>
        재연결됨, seq {seq}까지 복구
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
