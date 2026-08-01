import { useEffect, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";

// =============================================================================
// Editing a sent message in place (B11).
//
// In place, not in a dialog: the thing being changed is a line of a conversation
// and it has to be read in the conversation it belongs to. A modal would hide
// the messages around it — which is exactly the context that tells you what to
// write.
//
// Two keyboard shortcuts, both the ones people already have in their fingers
// from the composer: Enter saves, Shift+Enter is a newline, Esc cancels.
// =============================================================================

export function MessageEditor({
  initialBody,
  pending,
  error,
  onSave,
  onCancel,
}: {
  initialBody: string;
  pending: boolean;
  /** A user-facing Korean sentence, never the wire message (B8). */
  error: string | null;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Focus with the caret at the end rather than selecting everything: an edit is
  // almost always an addition or a fix at the end, and a full selection means
  // the first keystroke destroys the message.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  // Unchanged text is not a save: sending it would stamp `edited_at` and put
  // "수정됨" on a message nobody edited.
  const changed = draft !== initialBody;
  const empty = draft.trim().length === 0;

  const submit = () => {
    if (pending || empty) return;
    if (!changed) {
      onCancel();
      return;
    }
    onSave(draft);
  };

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="message-editor">
      <textarea
        ref={ref}
        rows={2}
        value={draft}
        disabled={pending}
        aria-label="메시지 고치기"
        data-testid="message-editor-input"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full resize-y rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      />
      {error && (
        <InlineBanner
          message={error}
          separator={false}
          testId="message-editor-error"
        />
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending || empty}
          data-testid="message-editor-save"
          onClick={submit}
        >
          {pending ? "저장 중…" : "저장"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          data-testid="message-editor-cancel"
          onClick={onCancel}
        >
          취소
        </Button>
        <span className="text-timestamp text-ink-muted">
          Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소
        </span>
      </div>
    </div>
  );
}
