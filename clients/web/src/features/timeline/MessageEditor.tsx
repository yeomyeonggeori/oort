import { useEffect, useRef, useState } from "react";
import { MESSAGE_EDITOR_KEYS_HINT } from "@momo/core/features/chat/composerCopy";
import { isComposingEvent, keyKeepsCompositionGuard, messageEditorKeyIntent } from "@momo/core/features/chat/composerKeys";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { useAutoGrow } from "./useAutoGrow";

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
//
// 「입력칸 규칙과 같게」(#5191): 한글을 쓰는 중에는 Enter·Esc 가 IME 의 것이다. 조합을 끝내는 Enter 는 저장이 아니고
// (Chromium 은 `isComposing`, WebKit 은 `compositionend` 가 keydown 보다 먼저라 그 한 번의 키를 `justComposed` 로 잡는다),
// 후보 창을 닫는 Esc 는 편집을 버리지 않는다. 판정은 코어(`messageEditorKeyIntent`)가 컴포저와 한 벌로 갖는다.
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
  // 조합이 막 끝났고 아직 키가 떼어지지 않았다 — 다음 keydown 이 그 조합을 끝낸 바로 그 키일 수 있다(WebKit 순서). 컴포저와
  // 같은 세 줄이다: 조합 시작이 닫고, 조합 끝이 열고, 키를 떼면 닫는다.
  const justComposedRef = useRef(false);

  // 고치려는 글이 이미 세 줄이면 세 줄이 보여야 한다. R1은 `rows={2}` 고정이라
  // 수정이 두 줄짜리 창구를 스크롤하는 일이 됐다 (R2 M4). 여덟 줄에서 멈추는
  // 것은 편집기가 타임라인을 밀어내지 않게 하기 위해서다.
  useAutoGrow(ref, draft, { minRows: 2, maxRows: 8 });

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
        value={draft}
        disabled={pending}
        aria-label="메시지 고치기"
        data-testid="message-editor-input"
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          justComposedRef.current = false;
        }}
        onCompositionEnd={() => {
          justComposedRef.current = true;
        }}
        onKeyUp={() => {
          justComposedRef.current = false;
        }}
        onBlur={() => {
          justComposedRef.current = false;
        }}
        onKeyDown={(event) => {
          // 조합을 끝낼 수 없는 키는 조합이 끝났다는 증거다: 조합이 키 입력 없이 끝났다면(보내기를 누르는 중에 클릭) 깃발이 남아 다음 Enter 를 삼킨다.
          if (!keyKeepsCompositionGuard(event.key)) justComposedRef.current = false;
          const intent = messageEditorKeyIntent(
            {
              key: event.key,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              composing: isComposingEvent(event.nativeEvent),
            },
            { justComposed: justComposedRef.current }
          );
          if (intent === "cancel") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (intent === "save") {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full resize-none rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-body text-ink focus-visible:focus-ring disabled:opacity-50"
      />
      {error && (
        <InlineBanner
          message={error}
          separator={false}
          testId="message-editor-error"
        />
      )}
      {/* 폰에서 이 두 버튼은 시트의 「고치기」가 착지하는 자리다. R1은 28px
          짜리였다 (R2 H3): 손가락으로 열린 흐름이 손가락으로 누를 수 없는
          컨트롤에서 끝났다. `tap-target`은 폰에서만 44px로 자란다. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="tap-target"
          disabled={pending || empty}
          data-testid="message-editor-save"
          onClick={submit}
        >
          {pending ? "저장 중…" : "저장"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="tap-target"
          disabled={pending}
          data-testid="message-editor-cancel"
          onClick={onCancel}
        >
          취소
        </Button>
        {/* 키 힌트의 표기는 이 앱에 한 벌뿐이다 (#1384, 코어
            `composerCopy.ts` 의 「키보드 힌트의 표기법」). 이 줄이 고친 둘:
            문법이 「Enter 저장」이라 키와 동사가 조사 없이 나란히 서 있었고,
            크기가 `text-timestamp`(11px)라 같은 종류의 안내인 컴포저 힌트·
            사이드바 ⌘K(둘 다 12px)보다 한 단 작았다. 11px은 묘비의 크기다. */}
        <span className="wide-only text-meta text-ink-muted">
          {MESSAGE_EDITOR_KEYS_HINT}
        </span>
      </div>
    </div>
  );
}
