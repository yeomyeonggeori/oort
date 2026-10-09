import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { useSession } from "@/app/session";
import {
  AI_HUB_COPY,
  AI_HUB_NAV_COPY,
  AI_HUB_PATH,
  AI_HUB_SECTIONS,
  aiHubSection,
  glossaryEntry,
} from "@momo/core/features/ai/aiHubModel";
import { canCreateAgentNow } from "@/features/agentHub/createModel";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { memberFor } from "@momo/core/features/workspace/directory";
import { useOffline } from "@/features/common/useOffline";
import { AiHubOverview } from "./AiHubOverview";
import { AiAccountsPane } from "./AiAccountsPane";
import { AiAgentsPane } from "./AiAgentsPane";
import { AiExternalPane } from "./AiExternalPane";
import { AiTeamKeysPane } from "./AiTeamKeysPane";

const TAB_CLASS =
  "tap-target press rounded-full px-3 py-1 text-body text-ink-muted hover:bg-surface-hover focus-visible:focus-ring aria-[current=page]:bg-surface aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:shadow-sm";

/**
 * 「AI」 허브 (AIH-3, #3393, 플랜 §1; 두 탭은 ADR-0198 D3, #3568). 위 탭은 둘이다. 「에이전트」
 * (개요·에이전트 명부·팀 AI 키·외부 연결)와 「내 도구」(내 구독 CLI 카드). 에이전트 탭 안의
 * 구획은 아래 작은 탭으로 가고, 주소는 그대로 `/ai/*` 한 라우트다.
 */
export function AiHubRoute() {
  const { workspaceId, session } = useSession();
  const offline = useOffline();
  const directory = useDirectory(workspaceId);
  const mayCreate = canCreateAgentNow(
    !directory.isPending,
    session.member.kind,
    memberFor(directory.directory, session.member.id)?.role
  );
  const pane = { offline, workspaceId, memberId: session.member.id };
  const toolsPath = aiHubSection("accounts").path;
  const { pathname } = useLocation();
  const inTools = pathname === toolsPath || pathname.startsWith(`${toolsPath}/`);
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="ai-hub-route">
      <header className="border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1 className="text-body font-semibold text-ink">{AI_HUB_COPY.name}</h1>
        </div>
        <nav aria-label={AI_HUB_NAV_COPY.topTabsLabel} className="mt-2 flex min-w-0 flex-wrap gap-2" data-testid="ai-hub-top-tabs">
          <Link
            to={AI_HUB_PATH}
            className={cn(TAB_CLASS)}
            aria-current={inTools ? undefined : "page"}
            data-testid="ai-hub-top-agents"
          >
            {AI_HUB_NAV_COPY.agentsTab}
          </Link>
          <Link
            to={toolsPath}
            className={cn(TAB_CLASS)}
            aria-current={inTools ? "page" : undefined}
            data-testid="ai-hub-top-tools"
          >
            {AI_HUB_NAV_COPY.toolsTab}
          </Link>
        </nav>
        {!inTools && (
          <nav aria-label={AI_HUB_NAV_COPY.agentsSubTabsLabel} className="mt-2 flex min-w-0 flex-wrap gap-2" data-testid="ai-hub-tabs">
            <NavLink to={AI_HUB_PATH} end className={cn(TAB_CLASS)} data-testid="ai-hub-tab-overview">
              {AI_HUB_NAV_COPY.overviewTab}
            </NavLink>
            {AI_HUB_SECTIONS.filter((section) => section.id !== "accounts").map((section) => (
              <NavLink key={section.id} to={section.path} className={cn(TAB_CLASS)} data-testid={`ai-hub-tab-${section.id}`}>
                {glossaryEntry(section.glossaryId).term}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Routes>
          <Route index element={<AiHubOverview mayCreateAgent={mayCreate} />} />
          <Route path="accounts" element={<AiAccountsPane />} />
          <Route path="team-keys" element={<AiTeamKeysPane {...pane} />} />
          <Route path="agents" element={<AiAgentsPane />} />
          <Route path="external/*" element={<AiExternalPane {...pane} />} />
          <Route path="*" element={<AiHubOverview mayCreateAgent={mayCreate} />} />
        </Routes>
      </div>
    </div>
  );
}
