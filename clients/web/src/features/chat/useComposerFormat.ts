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

/** 행 툴바와 같은 축. OS 선택 콜아웃이 같은 자리를 쓰므로 트레이를 그리지 않는다. */
export const COMPOSER_FORMAT_TOUCH_QUERY = "(hover: none), (pointer: coarse)";

function useOsSelectionCallout(): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(COMPOSER_FORMAT_TOUCH_QUERY).matches
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const query = window.matchMedia(COMPOSER_FORMAT_TOUCH_QUERY);
    const sync = () => setMatches(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return matches;
}

export function nextComposerTabStop(
  textarea: HTMLTextAreaElement | null
): HTMLElement | null {
  if (!textarea) return null;
  const shell = textarea.closest("[data-composer-shell]");
  if (!shell) return null;
  const candidates = [
    ...shell.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((node) => node.tabIndex >= 0 && node.getAttribute("aria-hidden") !== "true");
  const index = candidates.indexOf(textarea);
  if (index < 0) return null;
  return candidates[index + 1] ?? null;
}

export function focusComposerFormatTray(
  tray: HTMLDivElement | null
): HTMLButtonElement | null {
  const active =
    tray?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ??
    tray?.querySelector<HTMLButtonElement>("button");
  active?.focus();
  return active ?? null;
}

/**
 * 채널·스레드 컴포저가 같은 선택 서식 상태를 쓴다. 값 반영은 호출측
 * `onValueChange`(채널은 draftStore 가 붙은 autocomplete.replaceValue)에 맡긴다.
 */
export function useComposerFormat({
  value,
  inputRef,
  autocompleteVisible,
  onValueChange,
  enabled = true,
  surfaceKey,
}: {
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  autocompleteVisible: boolean;
  onValueChange: (value: string, caret: number) => void;
  enabled?: boolean;
  /** 채널·스레드 전환에 트레이를 접는다. */
  surfaceKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const trayRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const autocompleteVisibleRef = useRef(autocompleteVisible);
  const enabledRef = useRef(enabled);
  const openRef = useRef(open);
  const dismissedRangeRef = useRef<string | null>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(
    null
  );
  const hideForTouch = useOsSelectionCallout();
  valueRef.current = value;
  autocompleteVisibleRef.current = autocompleteVisible;
  enabledRef.current = enabled;
  openRef.current = open;

  const rangeKey = (start: number, end: number) => `${start}:${end}`;

  const sync = useCallback(() => {
    const el = inputRef.current;
    if (!el || !enabledRef.current || hideForTouch) {
      setOpen(false);
      return;
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const key = rangeKey(start, end);
    if (dismissedRangeRef.current !== null) {
      if (dismissedRangeRef.current === key) {
        setOpen(false);
        return;
      }
      dismissedRangeRef.current = null;
    }
    const show = shouldShowComposerFormatTray({
      value: valueRef.current,
      start,
      end,
      autocompleteVisible: autocompleteVisibleRef.current,
    });
    setOpen(show);
    if (show) setSelectionEpoch((n) => n + 1);
  }, [hideForTouch, inputRef]);

  useEffect(() => {
    dismissedRangeRef.current = null;
    setOpen(false);
  }, [surfaceKey]);

  useEffect(() => {
    if (!enabled || hideForTouch) setOpen(false);
  }, [enabled, hideForTouch]);

  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending) {
      pendingSelectionRef.current = null;
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pending.start, pending.end);
      }
      const show = shouldShowComposerFormatTray({
        value,
        start: pending.start,
        end: pending.end,
        autocompleteVisible: autocompleteVisibleRef.current,
      });
      setOpen(show && !hideForTouch);
      if (show && !hideForTouch) setSelectionEpoch((n) => n + 1);
      return;
    }
    sync();
  }, [value, autocompleteVisible, hideForTouch, inputRef, sync]);

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

  useEffect(() => {
    if (!open) return;
    const onFocusIn = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const el = inputRef.current;
      if (el === target || el?.contains(target)) return;
      if (trayRef.current?.contains(target)) return;
      const shell = el?.closest("[data-composer-shell]");
      if (shell?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [inputRef, open]);

  useEffect(() => {
    if (!open) return;
    const textarea = inputRef.current;
    const shell = textarea?.closest("[data-composer-shell]");
    if (!textarea || !shell) return;
    const onKeyDown = (event: Event) => {
      const keyEvent = event as globalThis.KeyboardEvent;
      if (keyEvent.key !== "Tab" || !keyEvent.shiftKey) return;
      const firstAction = nextComposerTabStop(textarea);
      if (keyEvent.target !== firstAction) return;
      keyEvent.preventDefault();
      focusComposerFormatTray(trayRef.current);
    };
    shell.addEventListener("keydown", onKeyDown);
    return () => shell.removeEventListener("keydown", onKeyDown);
  }, [inputRef, open]);

  const apply = useCallback(
    (kind: ComposerFormatKind) => {
      const el = inputRef.current;
      if (!el || !enabledRef.current) return;
      dismissedRangeRef.current = null;
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

  const dismiss = useCallback(() => {
    const el = inputRef.current;
    dismissedRangeRef.current = el
      ? rangeKey(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      : "";
    setOpen(false);
  }, [inputRef]);

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
        !autocompleteVisibleRef.current
      ) {
        const first = focusComposerFormatTray(trayRef.current);
        if (first) return true;
      }
      return false;
    },
    [apply]
  );

  const onBlur = useCallback((event: FocusEvent<HTMLTextAreaElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node) {
      if (trayRef.current?.contains(next)) return;
      const shell = inputRef.current?.closest("[data-composer-shell]");
      if (shell?.contains(next)) return;
    }
    setOpen(false);
  }, [inputRef]);

  return {
    open,
    selectionEpoch,
    trayRef,
    apply,
    dismiss,
    handleKeyDown,
    onSelect: sync,
    onBlur,
  };
}
