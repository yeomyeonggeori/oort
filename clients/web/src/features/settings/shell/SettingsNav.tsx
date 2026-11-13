import type { KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Brain,
  Building2,
  ChartColumn,
  Download,
  Keyboard,
  MonitorSmartphone,
  Newspaper,
  Palette,
  Server,
  Sparkles,
  Terminal,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { UpdateButton } from "@/features/updates/UpdateButton";
import { useUpdateState } from "@/features/updates/store";
import { cn } from "@/design/lib/cn";
import { useMessages } from "@/i18n/useMessages";
import {
  SETTINGS_GROUPS,
  settingsSectionLabel,
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
  releaseNotes: Newspaper,
  devTools: Terminal,
  aiHub: Sparkles,
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
  const messages = useMessages();
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
                      {settingsSectionLabel(item, messages)}
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
      <SettingsRestartNotice />
    </nav>
  );
}

/**
 * 설정 전면에는 사이드바가 없다: 설치를 마친 업데이트가 다시 시작을 기다리는 동안 같은 알약·카드를 목록 아래에 세운다(#5661 수리
 * 2회차). 기다린 뒤의 다시 시작 예고(30초 · 「지금 말고」)가 이 화면에서도 보이고, 예고 없이 앱이 꺼지는 화면이 없다. 새 판을
 * 알리기만 하는 동안(받기 전)에는 세우지 않는다 — 그 알약은 앱 화면의 것이다.
 */
function SettingsRestartNotice() {
  const update = useUpdateState();
  if (update.kind !== "installed") return null;
  return (
    // 목록 스크롤 바닥에 붙는다(sticky): 창이 낮아 목록이 넘쳐도 알약 · 예고 카드가 창 안에 선다(수리 3회차 M1). 바닥 색(`canvas-mid`)을 깔아
    // 아래로 지나가는 목록 글자가 알약 뒤로 비치지 않게 하고, 목록의 아래 안쪽 여백(8px)까지 덮는다(`-bottom-2`).
    <div className="settings-nav-group sticky -bottom-2 bg-canvas-mid pb-4" data-testid="settings-restart-notice">
      <UpdateButton placement="row" />
    </div>
  );
}
