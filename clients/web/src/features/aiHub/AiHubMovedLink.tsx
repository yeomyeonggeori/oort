import { Link } from "react-router-dom";
import {
  AI_HUB_FROM_SETTINGS,
  AI_HUB_NAV_COPY,
  aiExternalRowFromSettings,
  aiHubSection,
} from "@momo/core/features/ai/aiHubModel";

/**
 * 옛 설정 구획(AI 연결·에이전트 자격·앱·웹훅·이벤트 구독) 안내 (플랜 §7).
 * `ai` 구획은 본문 위의 한 줄이고, 외부 연결로 옮긴 네 구획(AIH-8)은 본문 없이 이 한 줄이 전부다.
 * 외부 연결 줄이 따로 있으면 그 줄 상세로, 없으면 허브 구획으로 보낸다.
 */
export function AiHubMovedLink({ section }: { section: string }) {
  const target = AI_HUB_FROM_SETTINGS[section];
  if (target === undefined) return null;
  const row = aiExternalRowFromSettings(section);
  const to = row?.path ?? aiHubSection(target).path;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-2 text-meta text-ink-muted" data-testid="ai-hub-moved-link">
      <span>{row?.settingsLine ?? AI_HUB_NAV_COPY.movedToHub}</span>
      <span aria-hidden="true">·</span>
      <Link
        to={to}
        className="font-semibold text-ink underline underline-offset-4 press focus-visible:focus-ring"
      >
        {AI_HUB_NAV_COPY.movedToHubAction}
      </Link>
    </p>
  );
}
