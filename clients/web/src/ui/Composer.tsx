import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Message } from "../api/client";
import { sendMessage } from "../api/client";

interface ComposerProps {
  workspaceId: string;
  channelId: string;
  placeholder: string;
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
  onSent,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const clientMsgIdRef = useRef<string | null>(null);

  async function send() {
    const body = draft.trim();
    if (body === "" || sending) return;
    clientMsgIdRef.current ??= crypto.randomUUID();
    setSending(true);
    try {
      const message = await sendMessage(
        workspaceId,
        channelId,
        clientMsgIdRef.current,
        body
      );
      clientMsgIdRef.current = null;
      setDraft("");
      setSendFailed(false);
      onSent(message);
    } catch {
      // Keep the draft AND the clientMsgId: retry is idempotent.
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
    if (sendFailed) {
      // Edited after a failure: new attempt, new idempotency key (the failed
      // one may have committed the old body server-side).
      clientMsgIdRef.current = null;
      setSendFailed(false);
    }
    setDraft(value);
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
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
          onChange={(event) => handleDraftChange(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button composer-send"
          data-testid="composer-send"
          disabled={sending || draft.trim() === ""}
        >
          {sending ? "보내는 중…" : "보내기"}
        </button>
      </div>
    </form>
  );
}
