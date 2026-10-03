import { useQuery } from "@tanstack/react-query";
import { agentMembers } from "@momo/core/features/agents/hubModel";
import { fetchProviderLink } from "@momo/core/features/settings/api";
import { listEventSubscriptions } from "@momo/core/features/settings/eventSubscriptions";
import { isOperatorDenied } from "@momo/core/features/settings/model";
import { listPlugins } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { webhookListQuery } from "@/features/settings/webhookCredentialScope";
import { readProbeFixture } from "@/features/settings/aiMyAccountsModel";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { IS_TAURI } from "@/lib/env";
import {
  READ_LOADING,
  accountsCard,
  agentsCard,
  externalAgentCount,
  externalCard,
  loginNudge,
  teamKeysCard,
  type AccountsInput,
  type ExternalInput,
  type HubCardView,
  type Read,
} from "./aiHubOverviewModel";

/** react-query 결과를 「읽었다 / 못 읽었다 / 권한이 없다」로 접는다. */
function toRead<T, U>(
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined },
  pick: (data: T) => U
): Read<U> {
  if (query.isPending) return READ_LOADING;
  if (query.isError || query.data === undefined) {
    return isOperatorDenied(query.error) ? { state: "denied" } : { state: "error" };
  }
  return { state: "ok", value: pick(query.data) };
}

/**
 * 외부 연결 네 줄의 개수 읽기. 개요 카드와 외부 연결 구획이 같은 값을 보도록 한 곳에서 센다.
 * `hosted`는 에이전트 카드도 쓰므로 함께 돌려준다.
 */
export function useExternalReads() {
  const { workspaceId } = useSession();
  const hosted = useQuery(hostedListQuery(workspaceId));
  const webhooks = useQuery(webhookListQuery(workspaceId));
  const events = useQuery({
    queryKey: ["settings", "event-subscriptions", workspaceId],
    queryFn: () => listEventSubscriptions(workspaceId),
    retry: false,
  });
  const plugins = useQuery({
    queryKey: ["plugins", workspaceId.toLowerCase()],
    queryFn: () => listPlugins(workspaceId),
    retry: false,
  });
  const input: ExternalInput = {
    apps: toRead(plugins, (catalog) => catalog.plugins.filter((p) => p.installed).length),
    incoming: toRead(webhooks, (rows) => rows.filter((row) => row.status === "active").length),
    outgoing: toRead(events, (rows) => rows.filter((row) => row.enabled).length),
    externalAgents: toRead(hosted, externalAgentCount),
  };
  return { input, hosted };
}

export interface AiHubOverview {
  cards: HubCardView[];
  nudge: boolean;
}

/**
 * 허브 개요가 쓰는 읽기. 설정의 각 구획이 이미 쓰는 쿼리 키·함수를 그대로 쓴다
 * (같은 캐시를 공유하므로 허브에서 본 값과 구획에서 본 값이 갈라지지 않는다).
 */
export function useAiHubOverview(): AiHubOverview {
  const { workspaceId } = useSession();
  const directory = useDirectory(workspaceId);
  const providerLink = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
  });
  const { input: externalInput, hosted } = useExternalReads();
  const probeFixture = readProbeFixture();
  const harness = useLocalHarnessWatch({
    enabled: IS_TAURI,
    fixture: probeFixture ? { probes: probeFixture } : null,
  });
  const accountsInput: AccountsInput =
    IS_TAURI || probeFixture ? { kind: "desktop", probes: harness.probes } : { kind: "web" };

  {
    const roster: Read<ReturnType<typeof agentMembers>> = directory.isPending
      ? READ_LOADING
      : directory.isError
        ? { state: "error" }
        : { state: "ok", value: agentMembers(directory.directory.members) };
    const connections = toRead(hosted, (rows) => rows);
    const cards = [
      accountsCard(accountsInput),
      teamKeysCard(
        toRead(providerLink, (link) => ({ configured: link.configured, format: link.format ?? null }))
      ),
      agentsCard({ roster, connections }),
      externalCard(externalInput),
    ];
    return { cards, nudge: loginNudge(accountsInput) };
  }
}
