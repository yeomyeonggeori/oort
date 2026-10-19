import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchAgentRunDetail,
  listPlugins,
  type Message,
} from "@momo/core/lib/api";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { appNoticeFor, hasAppNotice, isWorkingAppNotice, type AppNotice } from "@momo/core/features/timeline/appNotice";
import {
  appsRunIdOf,
  appsRunSiteOf,
  type AppsTailContext,
  type AppsTailPlugin,
} from "@momo/core/features/timeline/teamAiReply";
import { useSession } from "@/app/session";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「쓴 앱」 꼬리의 바깥 사실 (ADR-0113 증보 2 E8·E10, #3950).
//
// 꼬리를 그리는 순수 함수는 코어(`teamAiReply`)에 있고, 여기는 그 재료를 모은다:
//   · 어떤 앱을 몇 번 썼나   → 답의 run 상세(`appsUsed`). 서버는 이 칸을 message.props 에
//                              싣지 않는다(#3946 은 run 에만 싣는다).
//   · 앱 이름·연결 주소       → 앱 목록(`listPlugins`)
//   · 누구의 권한으로         → 이 답이 받는 글(`replyTo`)의 작성자(위임 사용자 = 트리거 작성자, E5)
//   · 채널에 몇 명이 읽나     → 채널 표면이 내려 주는 값(DM·모르면 null)
//
// 조회는 **조용히** 한다: 이 설치에 켜진 앱이 하나도 없으면 run 을 부르지 않는다(앱을 안
// 쓰는 워크스페이스의 모든 에이전트 답이 요청을 하나씩 만들지 않게). 실패해도 꼬리만 없다.
// =============================================================================

/** 이 채널을 읽는 사람 수. DM 이거나 모르면 null. 채널 표면(ChatShell)이 내린다. */
export const ChannelAudienceContext = createContext<number | null>(null);

/** 이 메시지가 「쓴 앱」을 가질 수 있는 에이전트 답인가: 성공한 게이트웨이 답 + run id. */
function runIdOf(
  message: Pick<Message, "props" | "state" | "authorMemberId">,
  directory: Directory
): string | null {
  // props 는 사람이 쓴 메시지에도 실을 수 있다: 에이전트 멤버가 쓴 답에만 꼬리를 단다.
  if (memberFor(directory, message.authorMemberId)?.kind !== "agent") return null;
  return appsRunIdOf(message);
}

export function useAppsTailContext(
  message: Message,
  directory: Directory
): AppsTailContext | undefined {
  const { workspaceId } = useSession();
  const audience = useContext(ChannelAudienceContext);
  const runId = runIdOf(message, directory);
  const provided = isSurfaceProvided("plugins") && isSurfaceProvided("appsUsedTail");
  const ws = workspaceId.toLowerCase();

  const catalog = useQuery({
    queryKey: ["plugins", ws],
    queryFn: () => listPlugins(workspaceId),
    retry: false,
    enabled: provided && runId !== null,
    staleTime: 60_000,
  });
  const anyInstalled = catalog.data?.plugins.some((plugin) => plugin.installed) ?? false;
  const run = useQuery({
    queryKey: ["agent-run-apps-used", ws, runId],
    queryFn: async () => (await fetchAgentRunDetail(workspaceId, runId as string)).appsUsed ?? null,
    retry: false,
    // 끝난 run 의 보고는 바뀌지 않는다.
    staleTime: Infinity,
    enabled: provided && runId !== null && anyInstalled,
  });

  const appsUsed = run.data ?? null;
  const trigger = message.replyTo?.authorMemberId;
  // 위임 사용자는 사람이다(E5). 받는 글이 에이전트 것이면 명의를 말하지 않는다.
  const triggerMember = trigger ? memberFor(directory, trigger) : null;
  const onBehalfOf = triggerMember?.kind === "human" ? triggerMember.displayName : null;
  const plugins = useMemo(() => {
    const map = new Map<string, AppsTailPlugin>();
    for (const plugin of catalog.data?.plugins ?? []) {
      map.set(plugin.pluginId, { name: plugin.name, egressDomains: plugin.egressDomains });
    }
    return map;
  }, [catalog.data]);

  return useMemo(
    () =>
      appsUsed === null
        ? undefined
        : { appsUsed, plugins, onBehalfOf, site: appsRunSiteOf(message.props), audience },
    [appsUsed, plugins, onBehalfOf, message.props, audience]
  );
}

// ---- 막힘 문장 ---------------------------------------------------------------------------

/** 분이 바뀔 때마다 한 번 다시 그리는 시계. 진행 중 안내(「n분째」)가 있을 때만 돈다. */
function useMinuteNow(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => bump((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now();
}

/**
 * `props.app_notice` 의 한 문장(+ 행동 하나). 칸이 없으면 null 이고 **요청도 하지 않는다**
 * (앱 이름은 앱 목록에서 읽는데, 막힘 문장이 없는 행이 그 목록을 부를 이유가 없다).
 */
export function useAppNotice(message: Message): AppNotice | null {
  const { workspaceId } = useSession();
  const has = hasAppNotice(message);
  const provided = isSurfaceProvided("plugins");
  const catalog = useQuery({
    queryKey: ["plugins", workspaceId.toLowerCase()],
    queryFn: () => listPlugins(workspaceId),
    retry: false,
    enabled: has && provided,
    staleTime: 60_000,
  });
  const plugins = useMemo(() => {
    const map = new Map<string, AppsTailPlugin>();
    for (const plugin of catalog.data?.plugins ?? []) {
      map.set(plugin.pluginId, { name: plugin.name, egressDomains: plugin.egressDomains });
    }
    return map;
  }, [catalog.data]);
  const working = has && isWorkingAppNotice(message);
  const nowMs = useMinuteNow(working);
  return has ? appNoticeFor(message, { surface: "web", plugins, nowMs }) : null;
}
