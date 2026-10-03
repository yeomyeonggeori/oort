import type { ReactNode } from "react";
import {
  AI_EXTERNAL_SUBSECTIONS,
  aiHubSection,
  glossaryEntry,
  type AiHubSectionId,
} from "@momo/core/features/ai/aiHubModel";
import { PluginSection } from "@/features/plugins/PluginSection";
import { AgentCredentialsSection } from "@/features/settings/AgentCredentialsSection";
import { AiLinkSection } from "@/features/settings/AiLinkSection";
import { EventSubscriptionSection } from "@/features/settings/EventSubscriptionSection";
import { WebhookSection } from "@/features/settings/WebhookSection";

interface PaneProps {
  offline: boolean;
  workspaceId: string;
  memberId: string;
}

// 구획 머리: 용어집 이름과 한 줄. 본문은 지금 있는 설정 구획이다(이후 AIH-4/6/7/8이 교체).
function PaneHead({ id, children }: { id: AiHubSectionId; children?: ReactNode }) {
  const entry = glossaryEntry(aiHubSection(id).glossaryId);
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-1" data-testid={`ai-hub-pane-${id}`}>
      <h2 className="text-display font-bold text-ink">{entry.term}</h2>
      <p className="max-w-2xl break-keep text-body text-ink-muted">{entry.meaning}</p>
      {children}
    </div>
  );
}

export { AiAccountsPane } from "./AiAccountsPane";
export { AiAgentsPane } from "./AiAgentsPane";

export function AiTeamKeysPane({ offline, workspaceId }: PaneProps) {
  return (
    <div className="flex min-w-0 flex-col">
      <PaneHead id="teamKeys" />
      <AiLinkSection offline={offline} workspaceId={workspaceId} heading={false} />
    </div>
  );
}

export function AiExternalPane({ offline, workspaceId, memberId }: PaneProps) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <PaneHead id="external" />
      <section aria-label={AI_EXTERNAL_SUBSECTIONS.apps} data-testid="ai-hub-external-apps">
        <PluginSection offline={offline} />
      </section>
      <section aria-label={AI_EXTERNAL_SUBSECTIONS.incoming} className="border-t border-line pt-6" data-testid="ai-hub-external-incoming">
        <WebhookSection workspaceId={workspaceId} memberId={memberId} offline={offline} />
      </section>
      <section aria-label={AI_EXTERNAL_SUBSECTIONS.outgoing} className="border-t border-line pt-6" data-testid="ai-hub-external-outgoing">
        <EventSubscriptionSection workspaceId={workspaceId} offline={offline} />
      </section>
      <section aria-label={AI_EXTERNAL_SUBSECTIONS.externalAgents} className="border-t border-line pt-6" data-testid="ai-hub-external-agents">
        <AgentCredentialsSection offline={offline} />
      </section>
    </div>
  );
}
