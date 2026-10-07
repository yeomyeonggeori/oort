import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

// 설정 셸의 두 열 (#3578 S1): 왼쪽에 목록(`nav`), 오른쪽에 떠 있는 본문 판. 창 바닥은
// `app-shell`의 그라데이션이 그대로이고(tokens.css `data-settings-surface`) 목록은 그
// 위에 선다. 판은 `settings-pane`(반경 18, rest 그림자, 면 `--sheet`)이고 그 안의 스크롤
// 영역이 `data-settings-scroll-viewport`(스크롤 위치 복원·게이트가 이 속성을 읽는다)다.
// 본문은 읽는 폭(`--w-settings-content`)에 가운데 정렬한다.

export function SettingsShell({
  nav,
  children,
  className,
  wide = false,
}: {
  nav: ReactNode;
  children: ReactNode;
  className?: string;
  /** 읽는 폭 제한을 푼다. 곁판이 있는 옛 AI 연결 화면(`?section=ai`)만 쓴다. */
  wide?: boolean;
}) {
  return (
    <div className={cn("settings-layout", className)}>
      {nav}
      <div data-testid="settings-pane" className="settings-pane">
        <div
          className="min-w-0 flex-1 overflow-y-auto px-6 py-8"
          data-settings-scroll-viewport
        >
          <div className="settings-page" data-wide={wide ? "" : undefined}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
