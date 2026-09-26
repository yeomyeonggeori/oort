import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Columns2, Info, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  WORKBENCH_GUTTER,
  WORKBENCH_NUDGE_STEP,
  canSplitPane,
  closePane,
  focusCycle,
  focusDirection,
  focusIndex,
  focusPane,
  nudgeSplit,
  paneIds,
  ratioBounds,
  resizeSplit,
  splitPane,
  toggleMaximize,
  toggleSplitRatio,
  type LayoutNode,
  type LayoutRefusal,
  type LayoutResult,
  type PaneId,
  type Size,
  type SplitAxis,
  type SplitNode,
  type WorkbenchLayout,
} from "@momo/core/features/workbench/layoutTree";
import {
  keyPlatformOf,
  resolveWorkbenchKey,
  type KeyPlatform,
  type WorkbenchCommand,
} from "@momo/core/features/workbench/keymap";
import type { LayoutStorageStatus } from "./useWorkbenchLayout";
import "./workbench.css";

// Reading this as: 작업 공간 격자(파워 개발자 워크벤치) for internal team users on
// web+Tauri, density 7/10, motion 1/10.
//
// 격자는 트리를 그대로 그린다. 분할 하나 = flex 상자 하나(두 몫 + 경계). 최대화는
// 칸을 트리에서 빼지 않고 격자 전체를 덮게 한다. 다른 칸은 `invisible` + `inert`로
// 남아, 나중에 붙을 터미널(#2774)이 최대화 때문에 떨어졌다 붙지 않는다.

export interface WorkbenchPaneInfo {
  id: PaneId;
  /** 1부터. ⌃1..9의 번호와 같다. */
  index: number;
  focused: boolean;
  maximized: boolean;
}

export interface WorkbenchGridProps {
  layout: WorkbenchLayout;
  onLayoutChange: (next: WorkbenchLayout) => void;
  /** 칸 안의 내용. 없으면 빈 칸 안내를 그린다. 터미널은 #2774가 여기 넣는다. */
  renderPane?: (pane: WorkbenchPaneInfo) => ReactNode;
  /** 칸 머리 제목. 없으면 「칸 N」. */
  paneTitle?: (pane: WorkbenchPaneInfo) => string;
  storage?: LayoutStorageStatus;
  /** 기본은 `navigator.platform`으로 판정한다. */
  platform?: KeyPlatform;
  /** 격자 크기를 재지 않고 이 값을 쓴다(시험·캡처용). */
  size?: Size;
  /** 마지막 칸에서 닫기를 누르면 부른다. 없으면 거부 문구를 보인다. */
  onCloseLastPane?: () => void;
  /**
   * 칸을 닫기 전에 묻는다(#2774: 실행 중인 로컬 칸은 확인). 있으면 격자는
   * 닫지 않고 이것을 부르고, 호스트가 `close()`를 부를 때 닫는다. 마지막 칸이면
   * `close()`가 `onCloseLastPane`으로 간다.
   */
  onRequestClose?: (paneId: PaneId, close: () => void) => void;
  label?: string;
  className?: string;
}

const REFUSAL_COPY: Partial<Record<LayoutRefusal, string>> = {
  "too-small": "칸이 좁아 더 나눌 수 없습니다. 칸을 닫거나 창을 넓히세요.",
  limit: "칸은 16개까지 둘 수 있습니다. 칸을 닫은 뒤 나누세요.",
  "last-pane": "마지막 칸이라 닫지 않았습니다.",
  "single-pane": "칸이 하나라 최대화할 칸이 없습니다. 먼저 칸을 나누세요.",
};

const STORAGE_COPY =
  "이 기기에 배치를 저장하지 못했습니다. 지금 배치는 쓸 수 있지만, 다시 열면 칸 하나로 돌아갑니다.";

const IDLE_HINT = "⌘D 오른쪽으로 분할 · ⌘⇧D 아래로 분할 · ⌘⌥화살표 칸 이동 · ⌘] 다음 칸 · ⌘⇧↵ 최대화";

function maximizedHint(index: number, hidden: number): string {
  return `${index}번 칸 최대화, 칸 ${hidden}개가 가려져 있습니다 · ⌘⇧↵ 되돌리기`;
}

function detectPlatform(): KeyPlatform {
  if (typeof navigator === "undefined") return "other";
  return keyPlatformOf(navigator.platform || navigator.userAgent);
}

/** `aria-keyshortcuts` 표기(「Meta+Shift+D」). */
function ariaKeys(platform: KeyPlatform, mac: string): string {
  const parts: string[] = [];
  if (mac.includes("⌘")) parts.push(platform === "mac" ? "Meta" : "Control");
  if (mac.includes("⌥")) parts.push("Alt");
  if (mac.includes("⇧")) parts.push("Shift");
  const last = mac.replace(/[⌘⌥⇧]/g, "");
  parts.push(last === "↵" ? "Enter" : last);
  return parts.join("+");
}

function modLabel(platform: KeyPlatform, mac: string): string {
  if (platform === "mac") return mac;
  return mac
    .replace(/⌘/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+")
    .replace(/↵/g, "Enter");
}

/** 격자 영역의 실제 크기. ResizeObserver가 없는 환경(jsdom)에서는 0×0. */
function useMeasuredSize(ref: RefObject<HTMLElement>, override: Size | undefined): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (override) return;
    const node = ref.current;
    if (!node) return;
    const read = () => {
      const rect = node.getBoundingClientRect();
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height }
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, override]);
  return override ?? size;
}

export function WorkbenchGrid({
  layout,
  onLayoutChange,
  renderPane,
  paneTitle,
  storage = "ok",
  platform: platformProp,
  size: sizeOverride,
  onCloseLastPane,
  onRequestClose,
  label = "작업 공간 격자",
  className,
}: WorkbenchGridProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const size = useMeasuredSize(areaRef, sizeOverride);
  const platform = platformProp ?? detectPlatform();
  const [notice, setNotice] = useState<string | null>(null);

  // 끌기 중 pointermove는 최신 배치를 봐야 한다(렌더를 기다리지 않는다).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const apply = useCallback(
    (result: LayoutResult, speak = true) => {
      if (result.ok) {
        setNotice(null);
        if (result.layout !== layoutRef.current) onLayoutChange(result.layout);
        return;
      }
      if (!speak) return;
      setNotice(REFUSAL_COPY[result.reason] ?? null);
    },
    [onLayoutChange]
  );

  const closeNow = useCallback(
    (id: PaneId) => {
      const result = closePane(layoutRef.current, id);
      if (!result.ok && result.reason === "last-pane" && onCloseLastPane) {
        onCloseLastPane();
        return;
      }
      apply(result);
    },
    [apply, onCloseLastPane]
  );

  const requestClose = useCallback(
    (id: PaneId) => {
      if (onRequestClose) onRequestClose(id, () => closeNow(id));
      else closeNow(id);
    },
    [closeNow, onRequestClose]
  );

  const run = useCallback(
    (command: WorkbenchCommand) => {
      const current = layoutRef.current;
      const s = sizeRef.current;
      switch (command.type) {
        case "split":
          return apply(splitPane(current, current.focused, command.axis, s));
        case "close":
          return requestClose(current.focused);
        case "toggle-maximize":
          return apply(toggleMaximize(current));
        case "focus-cycle":
          return apply(focusCycle(current, command.delta), false);
        case "focus-index":
          return apply(focusIndex(current, command.index), false);
        case "focus-direction":
          return apply(focusDirection(current, command.direction, s), false);
      }
    },
    [apply, requestClose]
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const command = resolveWorkbenchKey(event, platform);
    if (command === null) return;
    // ⌘⇧↵는 앱의 「보내기」(⌘↵)와, ⌘D는 브라우저 북마크와 겹친다. 격자가 받은 키는
    // 여기서 끝낸다.
    event.preventDefault();
    event.stopPropagation();
    run(command);
  };

  // 포커스 칸이 바뀌면 DOM 포커스도 그 칸으로 옮긴다. 키가 계속 격자로 오고,
  // 화면 낭독기가 어느 칸인지 읽는다. 칸 안에 이미 포커스가 있으면 건드리지 않는다.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedOnce = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!focusedOnce.current) {
      focusedOnce.current = true;
      return;
    }
    const pane = Array.from(root.querySelectorAll<HTMLElement>("[data-pane-id]")).find(
      (node) => node.dataset.paneId === layout.focused
    );
    if (pane && !pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
  }, [layout.focused, layout.maximized]);

  const ids = paneIds(layout.root);
  const single = layout.root.kind === "pane";
  const message = notice ?? (storage === "unavailable" ? STORAGE_COPY : null);
  const hint =
    layout.maximized !== null
      ? maximizedHint(ids.indexOf(layout.maximized) + 1, ids.length - 1)
      : IDLE_HINT;

  const ctx: RenderContext = {
    layout,
    ids,
    size,
    platform,
    single,
    renderPane,
    paneTitle,
    onFocusPane: (id) => apply(focusPane(layoutRef.current, id), false),
    onSplit: (id, axis) => apply(splitPane(layoutRef.current, id, axis, sizeRef.current)),
    onClose: requestClose,
    onMaximize: (id) => apply(toggleMaximize(layoutRef.current, id)),
    onResize: (splitId, ratio) => apply(resizeSplit(layoutRef.current, splitId, ratio, sizeRef.current), false),
    onNudge: (splitId, delta) => apply(nudgeSplit(layoutRef.current, splitId, delta, sizeRef.current), false),
    onToggleRatio: (splitId) => apply(toggleSplitRatio(layoutRef.current, splitId, sizeRef.current), false),
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      data-testid="workbench-grid"
      onKeyDown={onKeyDown}
      className={cn("group/wb flex h-full min-h-0 flex-col gap-2", className)}
    >
      <div
        ref={areaRef}
        data-testid="workbench-area"
        data-maximized={layout.maximized ?? undefined}
        className="relative isolate flex min-h-0 min-w-0 flex-1"
      >
        <NodeView node={layout.root} ctx={ctx} />
      </div>
      {/* 알림(거부·저장 실패)만 live 영역에 둔다. 단축키 안내는 알림이 사라질
          때마다 다시 읽히지 않게 밖에 둔다. */}
      <div
        data-testid="workbench-status"
        className={cn(
          "flex min-h-control-sm items-center gap-2 px-2 text-meta",
          message ? "text-ink" : "text-ink-muted"
        )}
      >
        {message ? <Info aria-hidden className="size-4 shrink-0 text-icon" /> : null}
        <p role="status" aria-live="polite" className={cn("min-w-0 truncate", !message && "sr-only")}>
          {message ?? ""}
        </p>
        {message ? null : <p className="min-w-0 truncate">{modLabel(platform, hint)}</p>}
      </div>
    </div>
  );
}

interface RenderContext {
  layout: WorkbenchLayout;
  ids: PaneId[];
  size: Size;
  platform: KeyPlatform;
  single: boolean;
  renderPane?: (pane: WorkbenchPaneInfo) => ReactNode;
  paneTitle?: (pane: WorkbenchPaneInfo) => string;
  onFocusPane: (id: PaneId) => void;
  onSplit: (id: PaneId, axis: SplitAxis) => void;
  onClose: (id: PaneId) => void;
  onMaximize: (id: PaneId) => void;
  onResize: (splitId: string, ratio: number) => void;
  onNudge: (splitId: string, delta: number) => void;
  onToggleRatio: (splitId: string) => void;
}

function NodeView({ node, ctx }: { node: LayoutNode; ctx: RenderContext }) {
  if (node.kind === "pane") return <PaneView id={node.id} ctx={ctx} />;
  return <SplitView split={node} ctx={ctx} />;
}

/** 몫을 `--wb-share`로 건다. style 속성 대신 CSSOM(SKILL §1). */
function useShare(ref: RefObject<HTMLElement>, share: number) {
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--wb-share", String(share));
  }, [ref, share]);
}

function SplitView({ split, ctx }: { split: SplitNode; ctx: RenderContext }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  useShare(firstRef, split.ratio);
  useShare(secondRef, 1 - split.ratio);
  return (
    <div ref={boxRef} className="wb-split" data-axis={split.axis} data-split-id={split.id}>
      <div ref={firstRef} className="wb-share">
        <NodeView node={split.first} ctx={ctx} />
      </div>
      <Splitter split={split} boxRef={boxRef} ctx={ctx} />
      <div ref={secondRef} className="wb-share">
        <NodeView node={split.second} ctx={ctx} />
      </div>
    </div>
  );
}

/**
 * 경계 손잡이. Radix에 창 분할 프리미티브가 없어 손으로 그린다(끌기, 더블클릭
 * 두 단계 토글, 화살표 키 조절). WAI-ARIA 창 분할자(focusable separator) 모양이다.
 */
function Splitter({
  split,
  boxRef,
  ctx,
}: {
  split: SplitNode;
  boxRef: RefObject<HTMLDivElement>;
  ctx: RenderContext;
}) {
  const row = split.axis === "row";
  const bounds = ratioBounds(ctx.layout, split.id, ctx.size);
  const [dragging, setDragging] = useState(false);
  const hidden = ctx.layout.maximized !== null;

  const ratioAt = (event: ReactPointerEvent<HTMLDivElement>): number | null => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return null;
    const length = (row ? box.width : box.height) - WORKBENCH_GUTTER;
    if (length <= 0) return null;
    const offset = (row ? event.clientX - box.left : event.clientY - box.top) - WORKBENCH_GUTTER / 2;
    return offset / length;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const ratio = ratioAt(event);
    if (ratio !== null) ctx.onResize(split.id, ratio);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return; // 격자 키에 넘긴다
    const back = row ? "ArrowLeft" : "ArrowUp";
    const forward = row ? "ArrowRight" : "ArrowDown";
    if (event.key === back || event.key === forward) {
      event.preventDefault();
      event.stopPropagation();
      ctx.onNudge(split.id, event.key === back ? -WORKBENCH_NUDGE_STEP : WORKBENCH_NUDGE_STEP);
    } else if (event.key === "Home" && bounds) {
      event.preventDefault();
      ctx.onResize(split.id, bounds.min);
    } else if (event.key === "End" && bounds) {
      event.preventDefault();
      ctx.onResize(split.id, bounds.max);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      ctx.onToggleRatio(split.id);
    }
  };

  return (
    <div
      role="separator"
      tabIndex={hidden ? -1 : 0}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "왼쪽과 오른쪽 칸 크기 조절" : "위와 아래 칸 크기 조절"}
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-valuemin={bounds ? Math.round(bounds.min * 100) : undefined}
      aria-valuemax={bounds ? Math.round(bounds.max * 100) : undefined}
      data-testid="workbench-splitter"
      data-split-id={split.id}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => ctx.onToggleRatio(split.id)}
      onKeyDown={onKeyDown}
      className={cn(
        "group flex shrink-0 touch-none select-none items-center justify-center rounded-full focus-visible:focus-ring",
        row ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        hidden && "invisible"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-line transition-colors group-hover:bg-line-strong",
          row ? "h-8 w-px" : "h-px w-8",
          dragging && "bg-line-strong"
        )}
      />
    </div>
  );
}

function PaneView({ id, ctx }: { id: PaneId; ctx: RenderContext }) {
  const { layout, platform } = ctx;
  const index = ctx.ids.indexOf(id) + 1;
  const focused = layout.focused === id;
  const maximized = layout.maximized === id;
  const covered = layout.maximized !== null && !maximized;
  const info: WorkbenchPaneInfo = { id, index, focused, maximized };
  const title = ctx.paneTitle?.(info) ?? `칸 ${index}`;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (covered) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [covered]);

  const canRight = canSplitPane(layout, id, "row", ctx.size).ok;
  const canDown = canSplitPane(layout, id, "column", ctx.size).ok;

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={`${index}번 칸, ${title}`}
      data-pane-id={id}
      data-testid="workbench-pane"
      data-focused={focused ? "" : undefined}
      data-maximized={maximized ? "" : undefined}
      onPointerDownCapture={() => {
        if (!focused) ctx.onFocusPane(id);
      }}
      onFocusCapture={() => {
        if (!focused) ctx.onFocusPane(id);
      }}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-surface",
        // 신호색 링은 「키가 여기로 간다」는 뜻이다. 격자가 실제로 포커스를 가질
        // 때만 그린다. 아니면 활성 칸은 진한 테두리와 머리 채움으로만 조용히 표시한다.
        focused ? "border-line-strong group-focus-within/wb:focus-ring" : "border-line",
        maximized && "wb-maximized",
        covered && "invisible"
      )}
    >
      <header
        className={cn(
          "@container flex h-control shrink-0 items-center gap-2 border-b border-line pl-3 pr-1",
          focused ? "bg-surface" : "bg-surface-muted"
        )}
      >
        <span
          data-numeric
          className={cn(
            "font-mono text-meta",
            focused ? "text-ink" : "text-ink-muted"
          )}
        >
          {index}
        </span>
        <span
          title={title}
          className={cn(
            "min-w-0 flex-1 truncate text-meta",
            focused ? "font-medium text-ink" : "text-ink-muted"
          )}
        >
          {title}
        </span>
        <PaneButton
          label="오른쪽으로 분할"
          platform={platform}
          keycap="⌘D"
          narrowHidden
          disabled={!canRight}
          onClick={() => ctx.onSplit(id, "row")}
        >
          <Columns2 />
        </PaneButton>
        <PaneButton
          label="아래로 분할"
          platform={platform}
          keycap="⌘⇧D"
          narrowHidden
          disabled={!canDown}
          onClick={() => ctx.onSplit(id, "column")}
        >
          <Rows2 />
        </PaneButton>
        <PaneButton
          label={maximized ? "최대화 끄기" : "칸 최대화"}
          platform={platform}
          keycap="⌘⇧↵"
          disabled={ctx.single}
          pressed={maximized}
          onClick={() => ctx.onMaximize(id)}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </PaneButton>
        <PaneButton
          label="칸 닫기"
          platform={platform}
          disabled={ctx.single}
          onClick={() => ctx.onClose(id)}
        >
          <X />
        </PaneButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {ctx.renderPane ? ctx.renderPane(info) : <EmptyPane />}
      </div>
    </section>
  );
}

function PaneButton({
  label,
  platform,
  keycap,
  disabled,
  pressed,
  narrowHidden,
  onClick,
  children,
}: {
  label: string;
  platform: KeyPlatform;
  /**
   * macOS 표기. 다른 플랫폼은 Ctrl로 바꿔 보인다. 칸 닫기(⌘W)는 적지 않는다:
   * 브라우저와 Tauri 기본 메뉴가 ⌘W를 먼저 가져가서, 그 키가 칸을 닫는다고
   * 약속할 수 없다(#2774가 셸 메뉴를 정리할 때 붙인다).
   */
  keycap?: string;
  disabled?: boolean;
  /** 좁은 칸(머리 폭 20rem 미만)에서는 숨겨 제목 자리를 남긴다. 키는 그대로 된다. */
  narrowHidden?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    // 꺼진 버튼도 누를 수 있게 둔다(aria-disabled). 누르면 연산이 거부 이유를
    // 상태 줄에 말한다. `disabled`는 포인터를 막아 툴팁도 이유도 보이지 않는다.
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keycap ? ariaKeys(platform, keycap) : undefined}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      title={keycap ? `${label} (${modLabel(platform, keycap)})` : label}
      onClick={onClick}
      className={cn(
        "inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted [&_svg]:size-4",
        narrowHidden && "hidden @xs:inline-flex"
      )}
    >
      {children}
    </button>
  );
}

function EmptyPane() {
  return (
    <div className="flex flex-1 items-start p-4">
      <p className="text-body text-ink-muted">빈 칸입니다. 세션을 열면 여기 보입니다.</p>
    </div>
  );
}
