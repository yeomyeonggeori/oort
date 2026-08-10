import { Menu } from "lucide-react";
import { useShellNav } from "@/app/shellNav";

/**
 * 표면 헤더의 첫 컨트롤 (폰 전용). 여는 것만 한다: 열려 있는 동안 이 버튼은
 * 서랍과 스크림 뒤에 있고 그 아래 표면 전체가 `inert`이므로, 누를 수 없는 상태를
 * 토글로 그리면 라벨만 바뀌고 아무 일도 일어나지 않는 컨트롤이 된다. 닫는 길은
 * 세 개다: 서랍 안의 닫기 버튼, 스크림 탭, Esc.
 *
 * 아이콘 하나짜리 컨트롤이므로 접근 이름과 툴팁이 같은 문장이다. 크기는 폰에서
 * 44px(`tap-target`), 그리는 글리프는 그대로 16px이다.
 */
export function SidebarDrawerToggle() {
  const { drawerOpen, openDrawer } = useShellNav();
  return (
    <button
      type="button"
      className="mobile-only tap-target -ml-2 flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
      onClick={(event) => openDrawer(event.currentTarget)}
      aria-label="채널 목록 열기"
      title="채널 목록 열기"
      aria-expanded={drawerOpen}
      aria-controls="sidebar-drawer"
      data-testid="open-sidebar-drawer"
    >
      <Menu className="size-4" aria-hidden="true" />
    </button>
  );
}
