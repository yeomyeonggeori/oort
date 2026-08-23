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
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const selection = useRef<ComposerSelection>({ start: 0, end: 0 });

  const openPicker = (button: HTMLButtonElement) => {
    const input = inputRef.current;
    const fallback = value.length;
    selection.current = {
      start: input?.selectionStart ?? fallback,
      end: input?.selectionEnd ?? fallback,
    };
    setOpener(button);
    setOpen(true);
  };

  const pick = (emoji: string) => {
    const inserted = insertAtComposerSelection(value, selection.current, emoji);
    onValueChange(inserted.value, inserted.caret);
    // Radix가 닫히며 opener로 포커스를 먼저 돌린 뒤, 입력을 계속할 textarea가
    // 최종 목적지가 된다. Esc로 닫았을 때는 이 경로가 없어서 trigger에 남는다.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  return { open, setOpen, opener, openPicker, pick };
}
