import {
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Bold, Code, Italic, Link } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import {
  composerFormatItemState,
  type ComposerFormatKind,
} from "./composerFormat";
import {
  clampFormatTrayPosition,
  getTextareaSelectionRect,
  type FormatTrayPosition,
} from "./composerFormatPosition";
import { nextComposerTabStop } from "./useComposerFormat";

// Custom rather than a Radix Popover: that primitive moves focus and would
// collapse the textarea selection this tray is formatting.

export const COMPOSER_FORMAT_ITEM_CLASS =
  "flex size-control-sm items-center justify-center rounded-sm focus-visible:focus-ring";

const ACTIONS: ReadonlyArray<{
  kind: ComposerFormatKind;
  label: string;
  shortcut: string | null;
  Icon: typeof Bold;
  suffix: string;
}> = [
  { kind: "bold", label: "굵게", shortcut: "⌘B", Icon: Bold, suffix: "bold" },
  {
    kind: "italic",
    label: "기울임",
    shortcut: "⌘I",
    Icon: Italic,
    suffix: "italic",
  },
  { kind: "code", label: "인라인 코드", shortcut: null, Icon: Code, suffix: "code" },
  { kind: "link", label: "링크", shortcut: null, Icon: Link, suffix: "link" },
];

function applyTrayVars(
  node: HTMLDivElement,
  position: FormatTrayPosition
): void {
  node.style.setProperty(
    "--composer-format-left",
    `${Math.round(position.left)}px`
  );
  node.style.setProperty(
    "--composer-format-top",
    `${Math.round(position.top)}px`
  );
  node.style.setProperty(
    "--composer-format-shift",
    position.placement === "top" ? "-100%" : "0%"
  );
}

function itemTitle(
  label: string,
  shortcut: string | null,
  disabledReason: string | null
): string {
  if (disabledReason) return disabledReason;
  return shortcut ? `${label} (${shortcut})` : label;
}

export function ComposerFormatTray({
  open,
  value,
  selectionEpoch,
  inputRef,
  trayRef,
  onApply,
  onDismiss,
  testIdPrefix,
}: {
  open: boolean;
  value: string;
  selectionEpoch: number;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  trayRef: MutableRefObject<HTMLDivElement | null>;
  onApply: (kind: ComposerFormatKind) => void;
  onDismiss: () => void;
  testIdPrefix: string;
}) {
  const [position, setPosition] = useState<FormatTrayPosition | null>(null);
  const [trayWidth, setTrayWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const updatePosition = useCallback(() => {
    const textarea = inputRef.current;
    if (!open || !textarea) {
      setPosition(null);
      return;
    }
    const rect =
      getTextareaSelectionRect(textarea) ?? textarea.getBoundingClientRect();
    const next = clampFormatTrayPosition(rect, trayWidth, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPosition((current) => {
      if (
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.placement === next.placement
      ) {
        return current;
      }
      return next;
    });
    if (trayRef.current) applyTrayVars(trayRef.current, next);
  }, [inputRef, open, trayRef, trayWidth]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, selectionEpoch]);

  useLayoutEffect(() => {
    if (!open) return;
    const onViewport = () => updatePosition();
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    const textarea = inputRef.current;
    textarea?.addEventListener("scroll", onViewport);
    document.addEventListener("selectionchange", onViewport);
    return () => {
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      textarea?.removeEventListener("scroll", onViewport);
      document.removeEventListener("selectionchange", onViewport);
    };
  }, [inputRef, open, updatePosition]);

  useLayoutEffect(() => {
    const node = trayRef.current;
    if (!open || !node) return;
    const updateWidth = () => {
      const nextWidth = node.getBoundingClientRect().width;
      setTrayWidth((current) =>
        Math.abs(current - nextWidth) > 1 ? nextWidth : current
      );
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, trayRef, position]);

  useLayoutEffect(() => {
    if (open) setActiveIndex(0);
  }, [open]);

  const onEscape = useCallback(() => {
    onDismiss();
    inputRef.current?.focus();
  }, [inputRef, onDismiss]);
  useEscapeLayer(open, onEscape);

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    // textarea 포커스·선택을 유지한다. 클릭이 blur 를 내면 트레이가 접힌다.
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [
      ...(trayRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const index = buttons.findIndex((button) => button === document.activeElement);

    if (
      event.key === "ArrowRight" ||
      event.key === "ArrowLeft" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      if (buttons.length === 0) return;
      let next = index < 0 ? 0 : index;
      if (event.key === "ArrowRight") next = (index + 1 + buttons.length) % buttons.length;
      if (event.key === "ArrowLeft") {
        next = (index - 1 + buttons.length) % buttons.length;
      }
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = buttons.length - 1;
      setActiveIndex(next);
      buttons[next]?.focus();
      return;
    }

    if (event.key !== "Tab") return;
    event.preventDefault();
    if (event.shiftKey) {
      inputRef.current?.focus();
      return;
    }
    nextComposerTabStop(inputRef.current)?.focus();
  };

  if (!open || typeof document === "undefined") return null;

  const textarea = inputRef.current;
  const selection = {
    start: textarea?.selectionStart ?? 0,
    end: textarea?.selectionEnd ?? 0,
  };

  return createPortal(
    <div
      ref={(node) => {
        trayRef.current = node;
        if (node && position) applyTrayVars(node, position);
      }}
      role="toolbar"
      aria-label="선택 서식"
      aria-orientation="horizontal"
      data-testid={`${testIdPrefix}-tray`}
      data-placement={position?.placement ?? "top"}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className="composer-format-tray flex items-center gap-px rounded-md border border-line-strong bg-surface-raised p-px shadow-lg"
    >
      {ACTIONS.map(({ kind, label, shortcut, Icon, suffix }, index) => {
        const item = composerFormatItemState(value, selection, kind);
        const title = itemTitle(label, shortcut, item.disabledReason);
        return (
          <button
            key={kind}
            type="button"
            data-toolbar-item=""
            aria-label={label}
            aria-pressed={item.pressed}
            aria-disabled={item.disabled ? true : undefined}
            title={title}
            tabIndex={index === activeIndex ? 0 : -1}
            data-testid={`${testIdPrefix}-${suffix}`}
            className={cn(
              COMPOSER_FORMAT_ITEM_CLASS,
              item.pressed ? "bg-accent-soft text-ink" : "text-ink-muted",
              !item.disabled && !item.pressed && "press hover:bg-surface-hover hover:text-ink",
              item.disabled && "opacity-50"
            )}
            onClick={() => {
              if (item.disabled) return;
              onApply(kind);
            }}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>,
    document.body
  );
}
