import type { FocusEventHandler, ReactNode, Ref } from "react";
import { PanelLeft } from "lucide-react";
import { IS_TAURI } from "@/lib/env";
import {
  sidebarPaneToggleCopy,
  sidebarToggleKeyHint,
  titlebarDragProps,
} from "@/app/sidebarPane";
import { keyPlatformOf } from "@momo/core/features/workbench/keymap";

/**
 * 앱 상단 줄 (#1864). 토글은 사이드바 안이 아니라 여기 한 자리에 산다: 접혀도
 * 입구가 사라지고, 펼쳐도 자리가 바뀌지 않는다. 렌더는 웹·Tauri가 같고,
 * `data-tauri-drag-region`만 셸일 때 붙는다. 버튼은 드래그에서 뺀다.
 *
 * 셸에서는 이 줄이 창 맨 위 **잡기 띠**다(#4591, Buzz 상단 띠 40px): 신호등 높이의 빈 줄이고 어디를
 * 눌러도 창이 움직이며, 본문 판은 그 아래에서 시작한다(`app-shell`의 `data-desktop-shell`, tokens.css).
 * 오른쪽 끝에는 상단 단추가 들어올 자리(`trailing`)가 선다. 웹에는 띠도 자리도 없다.
 */
export function AppTitlebar({
  collapsed,
  controls = "sidebar-channel-pane",
  onCollapsedChange,
  toggleRef,
  onToggleFocus,
  onToggleBlur,
  trailing,
}: {
  collapsed: boolean;
  /**
   * 이 단추가 여닫는 목록 열의 id(#3280). 레일은 접혀도 남으므로 서랍 전체가 아니라 목록 열이다.
   * 「내 작업」에서는 라우트 안의 세션 목록(`session-list-column`)이고, 접히면 언마운트된다.
   */
  controls?: string;
  onCollapsedChange: (collapsed: boolean) => void;
  toggleRef?: Ref<HTMLButtonElement>;
  onToggleFocus?: () => void;
  onToggleBlur?: FocusEventHandler<HTMLButtonElement>;
  /**
   * 줄 오른쪽 끝 자리에 놓을 것(#4591). 다운로드 단추(#4587)가 이 자리를 채운다. 셸일 때만 그린다:
   * 웹은 본문 판이 첫 행까지 올라와 이 자리를 덮는다. 단추는 끌기 속성을 갖지 않는다.
   */
  trailing?: ReactNode;
}) {
  const copy = sidebarPaneToggleCopy(collapsed);
  const platformIsMac =
    typeof navigator !== "undefined" &&
    keyPlatformOf(navigator.platform || navigator.userAgent) === "mac";
  const keyHint = sidebarToggleKeyHint(platformIsMac);
  const handleToggle = () => {
    onCollapsedChange(!collapsed);
  };

  return (
    <header
      className="app-titlebar"
      data-testid="app-titlebar"
      {...titlebarDragProps(IS_TAURI)}
    >
      {/* 접기 단추는 모든 탭에서 같은 자리·같은 모양이다(#3280): 「내 작업」에서 단추를 숨기던
          예외가 없다. 상태는 아이콘이 아니라 aria-expanded와 툴팁 문구가 말한다. */}
      <button
        ref={toggleRef}
        type="button"
        onClick={handleToggle}
        onFocus={onToggleFocus}
        onBlur={onToggleBlur}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={copy.label}
        aria-expanded={copy.expanded}
        aria-controls={controls}
        title={`${copy.label} (${keyHint})`}
        aria-keyshortcuts={platformIsMac ? "Meta+B" : "Control+B"}
        data-testid="sidebar-toggle"
        className="flex size-control-sm shrink-0 items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
      >
        <PanelLeft className="size-4" aria-hidden="true" />
      </button>
      {/* 오른쪽 끝 자리(#4591): 칸 자신도 끌기 영역이라 단추 사이 틈도 창을 옮긴다. 단추는 속성이 없다. */}
      {IS_TAURI && (
        <div
          className="app-titlebar-trailing"
          data-testid="app-titlebar-trailing"
          {...titlebarDragProps(true)}
        >
          {trailing}
        </div>
      )}
    </header>
  );
}
