import { useId } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Settings } from "lucide-react";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import {
  COMMAND_SUGGEST_SETTINGS_OPEN,
  commandSuggestHead,
  commandSuggestOneLine,
  commandSuggestViewer,
  settingsOpenLabel,
  settingsOpenTarget,
} from "@momo/core/features/timeline/commandSuggest";
import { Button } from "@/design/ui/button";
import { useSurfaceProvidedPredicate } from "@/features/capabilities/useSurfaceProvided";
import { reachableSettingsSections, resolveSettingsSection } from "@/features/settings/settingsNav";
import type { CommandSuggestSlotProps } from "@/features/timeline/commandSuggestSlot";
import { AiConnectSuggestion } from "./AiConnectCard";
import { WorkRequestOpenSuggestion } from "./WorkRequestOpenCard";

// =============================================================================
// 「설정 열기」 제안 카드 (U-S6 #3940, ADR-0201 v2 H6-4, 서버 #3939).
//
// 도우미는 앱을 직접 쓰지 않고 이 카드로 사람을 설정 화면 한 곳에 보낸다. 카드는
// 서버를 바꾸지 않는다(risk none) — 누르면 그 기기의 설정 화면으로 가는 것이 전부다.
// `ai.connect` 카드와 **같은 자리**(`CommandSuggestSlot`)·같은 머리·같은 한 줄 모양을
// 쓴다. 따로 서는 카드 컴포넌트를 만들지 않는다(#2939 brief).
//
// #3893(도우미 승인 카드)와의 경계: 그쪽은 서버 상태를 바꾸는 제안을 사람이 **승인**하는
// 카드(`approval` 행, 감사 행)이고, 이쪽은 승인할 것이 없는 **이동 제안**이다. 이 카드는
// 승인 행도 감사 행도 만들지 않고, 누르는 일은 이 기기에만 일어난다.
//
// 문구는 에이전트·메시지의 문자열이 아니라 `section` 에서 코어 표로 다시 만든다(라벨을
// 그리지 않는다 — 피싱 문구 차단). 본문 폴백은 카드를 **세우지 않는 것**이다: 행은 어차피
// 에이전트의 본문 글을 그리고 카드는 그 아래에 더해지는 것이라, null을 돌려주면 글만 남는다.
// 폴백이 되는 경우: 이 서버가 표면을 싣지 않는다(`settingsOpenCard`), 이 빌드에서 도착할 수
// 없는 섹션(데스크탑 전용 「업데이트」를 브라우저에서 받았거나 서버가 표면을 싣지 않는 「기억」·
// 「실행 호스트」). 도착할 수 없는 섹션으로 문을 세우면 누른 사람이 아무 말 없이 프로필에
// 떨어진다(settingsNav `reachableSettingsSections` 의 R1 H1 결함).
//
// 네 상태: 이 카드는 서버를 부르지 않는다. 로딩·오류·오프라인이 없고(이동은 클라이언트
// 라우팅이다), 빈 상태는 위의 본문 폴백이 맡는다. 키보드: 버튼 하나, 기본 포커스 링.
// =============================================================================

export function CommandSuggestion(props: CommandSuggestSlotProps) {
  if (props.card.commandId === "settings.open") return <SettingsOpenSuggestion {...props} />;
  // #4972: 「작업 요청 열기」 — 입력창을 미리 채우는 카드(`WorkRequestOpenCard.tsx`).
  if (props.card.commandId === "work.request.open") return <WorkRequestOpenSuggestion {...props} />;
  return <AiConnectSuggestion {...props} />;
}

/**
 * 이 섹션이 **지금 이 빌드·이 서버에서** 도착할 수 있는가. 설정 라우트와 같은 판정(런타임
 * 표면 판정 `useSurfaceProvidedPredicate`)을 쓴다 — 정적 표로 물으면 카드는 서는데 라우트가
 * 그 섹션을 접어 프로필에 떨어지거나, 그 반대가 된다(#2780). 허브로 옮겨 간 옛 id
 * (`plugins`)는 라우트가 허브로 바꿔 보내므로 늘 도착한다.
 */
function useSectionReachable(section: string | null): boolean {
  const provided = useSurfaceProvidedPredicate();
  if (section === null) return false;
  const resolved = resolveSettingsSection(section);
  if (resolved.kind === "ai-hub") return true;
  if (resolved.kind === "unknown") return false;
  return reachableSettingsSections(provided).some((item) => item.id === resolved.id);
}

export function SettingsOpenSuggestion({ card, viewerMemberId }: CommandSuggestSlotProps) {
  const navigate = useNavigate();
  const headingId = useId();
  const section = card.section;
  const reachable = useSectionReachable(section);
  if (!isSurfaceProvided("settingsOpenCard")) return null;
  // 모르는 section(깨진 제안)은 카드를 세우지 않는다: 행의 본문 글이 안내를 한다.
  if (section === null) return null;
  const viewer = commandSuggestViewer(card, viewerMemberId, false);
  if (viewer !== "target") {
    return (
      <div
        className="ai-card mt-2 flex min-w-0 flex-col gap-2"
        data-testid="settings-suggest"
        data-viewer="other"
      >
        <p
          className="flex min-w-0 items-center gap-2 rounded-lg bg-sheet px-3 py-2 text-meta text-ink-muted"
          data-testid="settings-suggest-line"
        >
          <Settings className="size-4 shrink-0 text-icon" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-keep">{commandSuggestOneLine(card)}</span>
        </p>
      </div>
    );
  }
  if (!reachable) return null;
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? "";
  const label = settingsOpenLabel(section);
  return (
    <section
      aria-labelledby={headingId}
      className="ai-card mt-2 min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      data-testid="settings-suggest"
      data-viewer="target"
      data-section={section}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-sm bg-agent-soft text-timestamp font-bold text-agent"
        >
          {initial}
        </span>
        <h3 id={headingId} className="min-w-0 break-keep text-meta font-semibold text-agent">
          {commandSuggestHead(card)}
        </h3>
      </div>
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <Settings className="size-4 shrink-0 text-icon" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-keep text-body text-ink" data-testid="settings-suggest-label">
          {settingsOpenTarget(section)}
        </span>
        <Button
          type="button"
          size="sm"
          // 눌리는 면은 좁은 폭에서 44(`tap-target`), 보이는 모양은 그대로(design-review #3940 H).
          className="tap-target"
          onClick={() => navigate(`/settings?section=${section}`)}
          aria-label={label}
          data-testid="settings-suggest-open"
        >
          <ArrowRight aria-hidden="true" />
          {COMMAND_SUGGEST_SETTINGS_OPEN}
        </Button>
      </div>
    </section>
  );
}
