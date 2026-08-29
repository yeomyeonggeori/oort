import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { isComposingEvent } from "@momo/core/features/chat/composerKeys";
import {
  shouldShowComposerFormatTray,
  toggleComposerFormat,
  type ComposerFormatKind,
} from "./composerFormat";

/**
 * 채널·스레드 컴포저가 같은 선택 서식 상태를 쓴다. 값 반영은 호출측
 * `onValueChange`(채널은 draftStore 가 붙은 mentions.replaceValue)에 맡긴다.
 */
export function useComposerFormat({
  value,
  inputRef,
  mentionVisible,
  onValueChange,
  enabled = true,
  surfaceKey,
}: {
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mentionVisible: boolean;
  onValueChange: (value: string, caret: number) => void;
  enabled?: boolean;
  /** 채널·스레드 전환에 트레이를 접는다. */
  surfaceKey: string;
}) {
  const [open, setOpen] = useState(false);
  const trayRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const mentionVisibleRef = useRef(mentionVisible);
  const enabledRef = useRef(enabled);
  const openRef = useRef(open);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(
    null
  );
  valueRef.current = value;
  mentionVisibleRef.current = mentionVisible;
  enabledRef.current = enabled;
  openRef.current = open;

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!el || !enabledRef.current) {
      setOpen(false);
      return;
    }
    setOpen(
      shouldShowComposerFormatTray({
        value: valueRef.current,
        start: el.selectionStart ?? 0,
        end: el.selectionEnd ?? 0,
        mentionVisible: mentionVisibleRef.current,
      })
    );
  }, [inputRef]);

  useEffect(() => {
    setOpen(false);
  }, [surfaceKey]);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending) {
      pendingSelectionRef.current = null;
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pending.start, pending.end);
      }
      setOpen(
        shouldShowComposerFormatTray({
          value,
          start: pending.start,
          end: pending.end,
          mentionVisible: mentionVisibleRef.current,
        })
      );
      return;
    }
    sync();
  }, [value, mentionVisible, inputRef, sync]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (inputRef.current && document.activeElement === inputRef.current) {
        sync();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [inputRef, sync]);

  const apply = useCallback(
    (kind: ComposerFormatKind) => {
      const el = inputRef.current;
      if (!el || !enabledRef.current) return;
      const result = toggleComposerFormat(
        valueRef.current,
        {
          start: el.selectionStart ?? 0,
          end: el.selectionEnd ?? 0,
        },
        kind
      );
      if (!result) return;
      pendingSelectionRef.current = { start: result.start, end: result.end };
      onValueChange(result.value, result.start);
    },
    [inputRef, onValueChange]
  );

  const dismiss = useCallback(() => setOpen(false), []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (isComposingEvent(event.nativeEvent)) return false;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "b") {
          apply("bold");
          return true;
        }
        if (key === "i") {
          apply("italic");
          return true;
        }
      }
      if (
        event.key === "Tab" &&
        !mod &&
        !event.altKey &&
        !event.shiftKey &&
        openRef.current &&
        !mentionVisibleRef.current
      ) {
        const first = trayRef.current?.querySelector<HTMLButtonElement>("button");
        if (first) {
          first.focus();
          return true;
        }
      }
      return false;
    },
    [apply]
  );

  const onBlur = useCallback((event: FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && trayRef.current?.contains(next)) return;
    setOpen(false);
  }, []);

  return {
    open,
    trayRef,
    apply,
    dismiss,
    handleKeyDown,
    onSelect: sync,
    onBlur,
  };
}
