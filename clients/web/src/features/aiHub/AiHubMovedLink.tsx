import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/design/ui/button";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import {
  AI_HUB_FROM_SETTINGS,
  AI_HUB_NAV_COPY,
  aiExternalRowFromSettings,
  aiHubSection,
} from "@momo/core/features/ai/aiHubModel";

/**
 * 옛 설정 구획(AI 연결·에이전트 자격·앱·웹훅·이벤트 구독) 안내 (플랜 §7).
 * `ai` 구획은 본문 위의 링크 행 카드 한 장이고(#3578 S5c), 외부 연결로 옮긴 네 구획(AIH-8)은 본문
 * 없이 이 카드가 전부다. 외부 연결 줄이 따로 있으면 그 줄 상세로, 없으면 허브 구획으로 보낸다.
 *
 * 허브가 정본이다(ADR-0198 D3): 이 카드는 새 AI 표면이 아니라 허브로 가는 길이고, 옛 본문이 걷히면
 * (T3) 이 행만 남는다.
 */
export function AiHubMovedLink({ section }: { section: string }) {
  const target = AI_HUB_FROM_SETTINGS[section];
  if (target === undefined) return null;
  const row = aiExternalRowFromSettings(section);
  const to = row?.path ?? aiHubSection(target).path;
  return (
    <SettingsSection testId="ai-hub-moved-link" className="mb-4">
      <SettingsRow label={row?.settingsLine ?? AI_HUB_NAV_COPY.movedToHub}>
        <Button asChild variant="outline" size="sm">
          <Link to={to}>
            {AI_HUB_NAV_COPY.movedToHubAction}
            <ArrowUpRight aria-hidden />
          </Link>
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
