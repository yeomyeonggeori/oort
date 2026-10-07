import { MonitorSmartphone, Users, UserRound, type LucideIcon } from "lucide-react";
import { SCOPE_LABELS, type SettingsScope } from "../settingsNav";

// 범위 칩 (#3578). 「이 설정이 나만 보는 것인가, 이 기기에만 걸리는가, 워크스페이스 전체인가」를
// 페이지 머리에서 글자로 말한다. 장식 상태점이 아니라 **사실**이다(SKILL §8): 값은
// `settingsNav.ts`의 `scope`가 정한다. 아이콘은 범위의 종류를 돕고 의미는 글자가 진다.

const ICONS: Record<SettingsScope, LucideIcon> = {
  "workspace-member": Users,
  device: MonitorSmartphone,
  "account-device": MonitorSmartphone,
  account: UserRound,
  workspace: Users,
  "workspace-mixed": Users,
  "workspace-readable": Users,
};

export function ScopeChip({ scope }: { scope: SettingsScope }) {
  const Icon = ICONS[scope];
  return (
    <span
      data-testid="settings-scope-chip"
      data-scope={scope}
      className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-px text-meta text-ink-muted ring-1 ring-line"
    >
      <Icon aria-hidden className="size-3" />
      {SCOPE_LABELS[scope]}
    </span>
  );
}
