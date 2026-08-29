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
import type { ComposerFormatKind } from "./composerFormat";
import {
  clampFormatTrayPosition,
  getTextareaSelectionRect,
  type FormatTrayPosition,
} from "./composerFormatPosition";

// Custom rather than a Radix Popover: that primitive moves focus and would
// collapse the textarea selection this tray is formatting.

export const COMPOSER_FORMAT_ITEM_CLASS =
  "flex size-control-sm items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring";

const ACTIONS: ReadonlyArray<{
  kind: ComposerFormatKind;
  label: string;
  Icon: typeof Bold;
  suffix: string;
}> = [
  { kind: "bold", label: "굵게", Icon: Bold, suffix: "bold" },
  { kind: "italic", label: "기울임", Icon: Italic, suffix: "italic" },
  { kind: "code", label: "인라인 코드", Icon: Code, suffix: "code" },
  { kind: "link", label: "링크", Icon: Link, suffix: "link" },
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

export function ComposerFormatTray({
  open,
  inputRef,
  trayRef,
  onApply,
  onDismiss,
  testIdPrefix,
}: {
  open: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  trayRef: MutableRefObject<HTMLDivElement | null>;
  onApply: (kind: ComposerFormatKind) => void;
  onDismiss: () => void;
  testIdPrefix: string;
}) {
  const [position, setPosition] = useState<FormatTrayPosition | null>(null);
  const [trayWidth, setTrayWidth] = useState(0);

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
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const onViewport = () => updatePosition();
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    const textarea = inputRef.current;
    textarea?.addEventListener("scroll", onViewport);
    return () => {
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
      textarea?.removeEventListener("scroll", onViewport);
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
    if (event.key !== "Tab" || !event.shiftKey) return;
    const buttons = [
      ...(trayRef.current?.querySelectorAll("button") ?? []),
    ];
    if (buttons[0] !== document.activeElement) return;
    event.preventDefault();
    inputRef.current?.focus();
  };

  if (!open || typeof document === "undefined") return null;

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
      className={cn(
        "composer-format-tray flex max-w-full items-center gap-px rounded-md border border-line-strong bg-surface-raised p-px shadow-lg"
      )}
    >
      {ACTIONS.map(({ kind, label, Icon, suffix }) => (
        <button
          key={kind}
          type="button"
          aria-label={label}
          title={label}
          data-testid={`${testIdPrefix}-${suffix}`}
          className={COMPOSER_FORMAT_ITEM_CLASS}
          onClick={() => onApply(kind)}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>,
    document.body
  );
}
