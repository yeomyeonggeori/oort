import { Link } from "react-router-dom";
import {
  AI_HUB_FROM_SETTINGS,
  AI_HUB_NAV_COPY,
  aiHubSection,
} from "@momo/core/features/ai/aiHubModel";

/**
 * 옛 설정 구획(AI 연결·에이전트 자격·앱·웹훅·이벤트 구독) 위의 한 줄 (플랜 §7).
 * 구획은 그대로 열리고, 새 자리가 어디인지만 말한다.
 */
export function AiHubMovedLink({ section }: { section: string }) {
  const target = AI_HUB_FROM_SETTINGS[section];
  if (target === undefined) return null;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-2 text-meta text-ink-muted" data-testid="ai-hub-moved-link">
      <span>{AI_HUB_NAV_COPY.movedToHub}</span>
      <Link
        to={aiHubSection(target).path}
        className="font-semibold text-ink underline underline-offset-4 press focus-visible:focus-ring"
      >
        {AI_HUB_NAV_COPY.movedToHubAction}
      </Link>
    </p>
  );
}
