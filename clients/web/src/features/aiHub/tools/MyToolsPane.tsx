import { useCallback, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TOOLS_COPY, PERSONAL_HARNESS_WIRE, myHostView } from "@momo/core/features/ai/harnessCard";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { AI_HUB_DESKTOP_APP, AI_HUB_ACCOUNTS_COPY } from "@momo/core/features/ai/aiHubModel";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { useOffline } from "@/features/common/useOffline";
import { useWorkHosts } from "@/features/settings/workHostsQuery";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import { IS_TAURI } from "@/lib/env";
import { MyPersonalKeysSection } from "../MyPersonalKeysSection";
import { HarnessCard } from "./HarnessCard";
import { harnessSessions, type HarnessSessionStore } from "./harnessSessionStore";
import { createPersonalAgentPort, type PersonalAgentPort } from "./personalAgentPort";
import type { PersonalRead } from "./PersonalAgentRow";

const TOOLS: readonly LocalHarnessId[] = ["claude", "codex"];

/**
 * AI 허브 › 내 도구 (ADR-0198 D3, #3568). 하네스(내 구독 CLI)는 멤버가 아니라 도구다. 카드
 * 하나가 로그인 상태(공식 CLI 종료 코드)와 호스트 상태(서버 `online`)를 함께 말한다.
 * 테스트가 보관소·포트를 바꿔 끼울 수 있게 props로 받는다.
 */
export function MyToolsPane({
  sessions = harnessSessions,
  port: portOverride,
}: {
  sessions?: HarnessSessionStore;
  port?: PersonalAgentPort;
}) {
  const { workspaceId, session } = useSession();
  const offline = useOffline();
  const client = useQueryClient();
  const desktop = IS_TAURI;
  const watch = useLocalHarnessWatch({ enabled: desktop });
  const hosts = useWorkHosts(workspaceId);
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot);
  const port = portOverride ?? createPersonalAgentPort(workspaceId);
  const personalKey = ["ai", "personal-agents", workspaceId] as const;
  const personal = useQuery({
    queryKey: personalKey,
    queryFn: () => port.list(),
    staleTime: 15_000,
    retry: false,
  });
  const reload = useCallback(() => {
    void client.invalidateQueries({ queryKey: personalKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId]);

  const host = myHostView(
    hosts.isPending
      ? { state: "loading" }
      : hosts.isError
        ? { state: "error" }
        : { state: "ok", hosts: hosts.data ?? [] },
    session.member.id
  );

  const personalRead = (): PersonalRead =>
    personal.isPending ? "loading" : personal.isError ? "error" : personal.data.state;

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="ai-tools-pane" data-desktop={desktop ? "" : undefined}>
      <div className="flex min-w-0 flex-col gap-1" data-testid="ai-hub-pane-accounts">
        <h2 className="text-display font-bold text-ink">{TOOLS_COPY.title}</h2>
        <p className="max-w-2xl break-keep text-body text-ink-muted">
          {desktop ? TOOLS_COPY.desktopSubtitle : TOOLS_COPY.webSubtitle}
        </p>
        {desktop && (
          <p className="max-w-2xl break-keep text-meta text-ink-muted" data-testid="ai-accounts-login-not-stored">
            {TOOLS_COPY.loginNotStored}
          </p>
        )}
      </div>

      {!desktop && (
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-accounts-web-notice">
          <Button asChild size="sm" className="tap-target">
            <a href={AI_HUB_DESKTOP_APP.downloadUrl} target="_blank" rel="noreferrer" data-testid="ai-accounts-get-app">
              {AI_HUB_ACCOUNTS_COPY.web.getApp}
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="tap-target">
            <a href={AI_HUB_DESKTOP_APP.openUrl} data-testid="ai-accounts-open-app">
              {AI_HUB_ACCOUNTS_COPY.web.openApp}
            </a>
          </Button>
        </div>
      )}

      <ul className="flex min-w-0 flex-col gap-3" aria-label={TOOLS_COPY.title} data-testid="tool-cards">
        {TOOLS.map((harness) => {
          const wire = PERSONAL_HARNESS_WIRE[harness];
          const agent =
            personal.data?.state === "ok" ? (personal.data.agents.find((a) => a.harness === wire) ?? null) : null;
          return (
            <li key={harness} className="min-w-0">
              <HarnessCard
                harness={harness}
                desktop={desktop}
                pill={watch.pill(harness)}
                host={host}
                sessions={sessions}
                sessionsVersion={snapshot.version}
                onRecheck={watch.recheck}
                onRetryHost={() => void hosts.refetch()}
                personal={{ read: personalRead(), agent, port, onChanged: reload, offline }}
              />
            </li>
          );
        })}
      </ul>

      <MyPersonalKeysSection offline={offline} />
    </div>
  );
}
