import type { KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Bot,
  Brain,
  Building2,
  ChartColumn,
  Download,
  Keyboard,
  MonitorSmartphone,
  Palette,
  Server,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  SETTINGS_GROUPS,
  type SettingsSectionId,
  type SettingsSectionMeta,
} from "../settingsNav";

// 설정 목록 (#3578 S1). 앱 사이드바와 **같은 행 문법**이다(`sidebar-row` ·
// `sidebar-row-selected`: 34px, 아이콘 18, 선택은 흰 면 + rest 그림자). 그룹은 라벨과
// 위 여백뿐이고 선·상자가 없다(앞 판의 세로선·구분 상자가 허공에 떴다).
//
// 아이콘은 lucide 정적 named import다(ADR-0172). 의미는 라벨이 지고 아이콘은 훑어
// 찾는 것을 돕는 장식이므로 `aria-hidden`이다.

const ICONS: Record<SettingsSectionId, LucideIcon> = {
  profile: UserRound,
  appearance: Palette,
  notifications: Bell,
  shortcuts: Keyboard,
  devices: MonitorSmartphone,
  workspace: Building2,
  members: UsersRound,
  memory: Brain,
  usage: ChartColumn,
  code: Server,
  updates: Download,
  ai: Bot,
};

const ROW_CLASS =
  "settings-nav-item sidebar-row tap-target text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring";

export function SettingsNav({
  sections,
  current,
  onSelect,
  onBack,
  onKeyDown,
  registerRef,
}: {
  sections: SettingsSectionMeta[];
  current: SettingsSectionId;
  onSelect: (item: SettingsSectionMeta) => void;
  onBack: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  registerRef: (id: SettingsSectionId, el: HTMLButtonElement | null) => void;
}) {
  return (
    <nav
      aria-label="설정 섹션"
      onKeyDown={onKeyDown}
      className="settings-nav p-2"
      data-testid="settings-nav"
    >
      <div className="settings-nav-group first:pt-0">
        <button
          type="button"
          onClick={onBack}
          data-testid="settings-back-to-app"
          className={ROW_CLASS}
        >
          <span data-row-icon>
            <ArrowLeft aria-hidden />
          </span>
          앱으로 돌아가기
        </button>
      </div>
      {SETTINGS_GROUPS.map((group) => {
        const items = sections.filter((item) => item.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} role="group" aria-label={group} className="settings-nav-group">
            <p aria-hidden="true" className="settings-nav-label">
              {group}
            </p>
            <ul className="settings-nav-list">
              {items.map((item) => {
                const Icon = ICONS[item.id];
                const active = current === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      ref={(el) => registerRef(item.id, el)}
                      onClick={() => onSelect(item)}
                      aria-current={active ? "page" : undefined}
                      data-testid={`settings-nav-${item.id}`}
                      data-link={item.link}
                      className={cn(ROW_CLASS, active && "sidebar-row-selected")}
                    >
                      <span data-row-icon>
                        <Icon aria-hidden />
                      </span>
                      {item.label}
                      {item.link ? (
                        <span data-row-icon className="ms-auto">
                          <ArrowUpRight aria-hidden />
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
