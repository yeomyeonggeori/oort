import { forwardRef, type ReactNode } from "react";
import type { SettingsScope } from "../settingsNav";
import { ScopeChip } from "./ScopeChip";

// 페이지 머리 (#3578). 보이는 `h1` 하나가 그 페이지의 제목이다(옛 sr-only 「설정」 h1과
// 섹션마다의 h2를 이것 하나로 모은다). 제목은 표면당 하나뿐인 `text-display`다.
// 진입 포커스의 마지막 폴백이므로 `tabIndex={-1}`을 받는다.
//
// 설명(`description`)은 선택이다. S1은 옛 섹션 본문이 자기 설명 줄을 그대로 들고 있어서
// 비워 두고, S2~S5가 본문을 카드로 다시 짜면서 설명을 이 자리로 옮긴다.

export const SettingsPageHeader = forwardRef<
  HTMLHeadingElement,
  {
    title: string;
    description?: ReactNode;
    scope?: SettingsScope;
  }
>(function SettingsPageHeader({ title, description, scope }, ref) {
  return (
    <header className="flex min-w-0 flex-col gap-1" data-testid="settings-page-header">
      <h1
        ref={ref}
        tabIndex={-1}
        className="break-keep text-display font-bold text-ink focus-visible:focus-ring"
      >
        {title}
      </h1>
      {description ? (
        <p className="break-keep text-body text-ink-muted">{description}</p>
      ) : null}
      {scope ? (
        <div className="flex flex-wrap gap-2 pt-2">
          <ScopeChip scope={scope} />
        </div>
      ) : null}
    </header>
  );
});
