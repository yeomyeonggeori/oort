import { useRef, useState, type RefObject } from "react";
import {
  insertAtComposerSelection,
  type ComposerSelection,
} from "./composerInsertion";

/** 컴포저 둘이 같은 방식으로 선택 범위를 기억하고 이모지를 삽입한다. */
export function useComposerEmoji({
  value,
  inputRef,
  onValueChange,
}: {
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string, caret: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const selection = useRef<ComposerSelection>({ start: 0, end: 0 });

  const openPicker = (button: HTMLButtonElement) => {
    const input = inputRef.current;
    const fallback = value.length;
    selection.current = {
      start: input?.selectionStart ?? fallback,
      end: input?.selectionEnd ?? fallback,
    };
    // Popover는 트리거 버튼에 붙는다. 닫힐 때 Radix onCloseAutoFocus는
    // textarea로 돌아가야, 이모지를 넣거나 Esc로 닫은 직후 바로 이어 쓸 수
    // 있다(gate-composer: 삽입 후 textarea가 focused여야 한다).
    setAnchor(button);
    setOpener(input ?? button);
    setOpen(true);
  };

  const pick = (emoji: string) => {
    const inserted = insertAtComposerSelection(value, selection.current, emoji);
    onValueChange(inserted.value, inserted.caret);
    // opener가 textarea이므로 Radix가 닫히며 그리로 포커스를 돌린다. rAF는 삽입
    // 위치로 캐럿을 옮겨, 넣은 이모지 바로 뒤에서 이어 쓰게 한다.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  return { open, setOpen, opener, anchor, openPicker, pick };
}
