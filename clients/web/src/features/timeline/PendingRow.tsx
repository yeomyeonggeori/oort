import { useState } from "react";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { Avatar } from "./MessageRow";
import type { PendingMessage } from "./model";

// =============================================================================
// Optimistic echo row (M10, R-1 §3 "내 메시지는 seq 미확정이어도 로컬 echo").
//
// Its own component rather than a variant of MessageRow, because the two rows
// differ in what they can honestly claim: this one has no seq, no thread
// rollup, no server state and no permanence. It borrows MessageRow's grid
// (same padding, same 24px avatar column, same body type) so the row does not
// twitch into place when the server echo replaces it.
//
// Delivery status is stated in words, not with a decorative dot or a spinner:
// "전송 중" while the write path is running, "전송 실패" plus a retry when it
// is not. That retry re-sends with the SAME idempotency key, which is what the
// server's exactly-once write path is for (model.ts retryPending).
// =============================================================================

export function PendingRow({
  pending,
  startsGroup,
  directory,
  onResend,
}: {
  pending: PendingMessage;
  startsGroup: boolean;
  directory: Directory;
  onResend?: (clientMsgId: string) => Promise<void> | void;
}) {
  const [resending, setResending] = useState(false);
  const author = memberFor(directory, pending.authorMemberId);
  const name = author?.displayName ?? "나";
  const failed = pending.status === "failed";

  return (
    <article
      data-testid="timeline-pending"
      data-client-msg-id={pending.clientMsgId}
      data-status={pending.status}
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
            <span className="text-body font-semibold text-ink">{name}</span>
            {/* No timestamp: the message has no server time yet, and printing
                the local clock beside confirmed server times would invent an
                ordering the timeline does not have. */}
          </div>
        )}
        <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-ink-muted">
          {pending.body}
        </p>
        {failed ? (
          <span
            className="flex flex-wrap items-center gap-2 text-meta text-danger"
            data-testid="pending-failed"
          >
            전송 실패
            {onResend && (
              <button
                type="button"
                disabled={resending}
                data-testid="pending-resend"
                onClick={() => {
                  setResending(true);
                  void Promise.resolve(onResend(pending.clientMsgId)).finally(
                    () => setResending(false)
                  );
                }}
                className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {resending ? "보내는 중…" : "다시 보내기"}
              </button>
            )}
          </span>
        ) : (
          <span className="text-meta text-ink-muted" data-testid="pending-sending">
            전송 중
          </span>
        )}
      </div>
    </article>
  );
}
