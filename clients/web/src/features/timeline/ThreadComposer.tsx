import { useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { sendThreadReply } from "@/lib/api";
import { InlineBanner } from "@/features/common/States";
import { replyFailureMessage } from "./actionCopy";

// =============================================================================
// Writing a reply, from inside the thread (B11).
//
// The thread panel could read replies before this and not write them, which
// made 답글 a link to a transcript rather than an action. This is the other
// half.
//
// **The same write path as a channel send**, with `rootId` set — server
// `SendMessageRequest.rootId`, which is exactly how the mac client shares a
// work excerpt into a session thread. There is no reply endpoint and inventing
// one client-side would be a second write path into the same ledger.
//
// Deliberately simpler than the channel composer: no mention autocomplete, no
// model/effort selector, no attachments. Those belong to the surface where a
// conversation starts; a reply is a follow-up, and every control added here is
// one more thing between reading the thread and answering it.
// =============================================================================

export function ThreadComposer({
  workspaceId,
  channelId,
  rootId,
  onSent,
}: {
  workspaceId: string;
  channelId: string;
  rootId: string;
  /** Refetch the thread; the reply also arrives on the realtime rail. */
  onSent: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const submit = () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    // A fresh idempotency key per attempt, like the channel send: a retry after
    // a failure is a new send, not a replay of one that may already have
    // landed.
    sendThreadReply(workspaceId, channelId, rootId, crypto.randomUUID(), body)
      .then(() => {
        setDraft("");
        onSent();
        ref.current?.focus();
      })
      .catch((cause: unknown) => setError(replyFailureMessage(cause)))
      .finally(() => setSending(false));
  };

  return (
    <div className="safe-area-bottom border-t border-line p-3">
      {error && (
        <InlineBanner
          message={error}
          separator={false}
          testId="thread-composer-error"
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          disabled={sending}
          placeholder="답글 쓰기"
          aria-label="답글 쓰기"
          data-testid="thread-composer-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="tap-target min-h-control w-full resize-y rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        />
        <button
          type="button"
          disabled={sending || draft.trim().length === 0}
          onClick={submit}
          aria-label="답글 보내기"
          title="답글 보내기"
          data-testid="thread-composer-send"
          className="tap-target flex size-control shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <SendHorizontal className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
