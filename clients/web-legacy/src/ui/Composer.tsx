import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Message } from "../api/client";
import { sendMessage } from "../api/client";

interface ComposerProps {
  workspaceId: string;
  channelId: string;
  placeholder: string;
  online: boolean;
  /** Server echo (committed message with authoritative seq). */
  onSent: (message: Message) => void;
}

/**
 * Message composer (MOMO-400). v0 renders from the SERVER ECHO only — the
 * POST response / broadcast / backfill, all seq-authoritative. There is no
 * optimistic row: nothing appears until the server has committed.
 *
 * Idempotency: one clientMsgId per DRAFT ATTEMPT. A retry after a failure
 * reuses the same id, so a send whose response was lost (but whose insert
 * committed) can never duplicate — the server returns the original message.
 * Editing the text after a failure discards that id: the failed attempt may
 * have committed server-side with the OLD body, and reusing its id would
 * silently swallow the edit.
 */
export default function Composer({
  workspaceId,
  channelId,
  placeholder,
  online,
  onSent,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  // The idempotency key is BOUND to the exact body it was minted for: an
  // unchanged retry reuses it (idempotent re-send), while any edited text
  // gets a fresh key — the failed attempt may have committed the OLD body
  // server-side, and reusing its key would silently swallow the edit.
  const attemptRef = useRef<{ clientMsgId: string; body: string } | null>(
    null
  );

  async function send() {
    const body = draft.trim();
    if (body === "" || sending || !online) return;
    if (attemptRef.current === null || attemptRef.current.body !== body) {
      attemptRef.current = { clientMsgId: crypto.randomUUID(), body };
    }
    const attempt = attemptRef.current;
    setSending(true);
    try {
      const message = await sendMessage(
        workspaceId,
        channelId,
        attempt.clientMsgId,
        body
      );
      if (attemptRef.current === attempt) attemptRef.current = null;
      // Clear only what was sent — keep anything typed while in flight.
      setDraft((current) => (current.trim() === body ? "" : current));
      setSendFailed(false);
      onSent(message);
    } catch {
      // Keep the draft AND the attempt: retry is idempotent.
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  function handleDraftChange(value: string) {
    if (sendFailed) setSendFailed(false);
    setDraft(value);
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {!online && (
        <p className="composer-offline" data-testid="composer-offline" role="status">
          연결을 확인하세요. 오프라인에서는 메시지를 보낼 수 없습니다.
        </p>
      )}
      {sendFailed && (
        <p className="composer-error" data-testid="composer-error" role="alert">
          메시지를 보내지 못했습니다. 네트워크 상태를 확인해 주세요.
          <button
            type="button"
            className="ghost-button composer-retry"
            data-testid="composer-retry"
            onClick={() => void send()}
            disabled={sending}
          >
            다시 보내기
          </button>
        </p>
      )}
      <div className="composer-row">
        <input
          className="composer-input"
          data-testid="composer-input"
          type="text"
          value={draft}
          placeholder={placeholder}
          maxLength={4000}
          disabled={!online || sending}
          onChange={(event) => handleDraftChange(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button composer-send"
          data-testid="composer-send"
          disabled={!online || sending || draft.trim() === ""}
        >
          {sending ? "보내는 중…" : "보내기"}
        </button>
      </div>
    </form>
  );
}
