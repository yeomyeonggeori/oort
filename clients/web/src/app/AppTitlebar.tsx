import type { FocusEventHandler, Ref } from "react";
import { PanelLeft } from "lucide-react";
import { IS_TAURI } from "@/lib/env";
import { sidebarPaneToggleCopy, titlebarDragProps } from "@/app/sidebarPane";

/**
 * 앱 상단 줄 (#1864). 토글은 사이드바 안이 아니라 여기 한 자리에 산다: 접혀도
 * 입구가 사라지고, 펼쳐도 자리가 바뀌지 않는다. 렌더는 웹·Tauri가 같고,
 * `data-tauri-drag-region`만 셸일 때 붙는다. 버튼은 드래그에서 뺀다.
 */
export function AppTitlebar({
  hideToggle = false,
  collapsed,
  onCollapsedChange,
  toggleRef,
  onToggleFocus,
  onToggleBlur,
}: {
  /**
   * 「내 작업」 레일(#2854)에서는 접기 단추를 세우지 않는다. 레일이 곧 접힌 모양이고,
   * 그 자리(인셋 80)는 레일 폭(64) 밖의 판 위다. 줄 자체(드래그 영역)는 남는다.
   */
  hideToggle?: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  toggleRef?: Ref<HTMLButtonElement>;
  onToggleFocus?: () => void;
  onToggleBlur?: FocusEventHandler<HTMLButtonElement>;
}) {
  const copy = sidebarPaneToggleCopy(collapsed);
  const handleToggle = () => {
    onCollapsedChange(!collapsed);
  };

  return (
    <header
      className="app-titlebar"
      data-testid="app-titlebar"
      {...titlebarDragProps(IS_TAURI)}
    >
      {hideToggle ? null : (
      <button
        ref={toggleRef}
        type="button"
        onClick={handleToggle}
        onFocus={onToggleFocus}
        onBlur={onToggleBlur}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={copy.label}
        aria-expanded={copy.expanded}
        aria-controls="sidebar-drawer"
        title={copy.label}
        data-testid="sidebar-toggle"
        className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
      >
        <PanelLeft className="size-4" aria-hidden="true" />
      </button>
      )}
    </header>
  );
}
