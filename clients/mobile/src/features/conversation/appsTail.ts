import {createContext, useContext, useMemo} from 'react';
import {QueryClient, QueryClientContext, useQuery} from '@tanstack/react-query';
import {
  fetchAgentRunDetail,
  listPlugins,
  type Message,
} from '@momo/core/lib/api';
import {coreHost} from '@momo/core/runtime/host';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {appsOnWebPath} from '@momo/core/features/plugins/phoneApps';
import {
  appNoticeFor,
  hasAppNotice,
  type AppNotice,
} from '@momo/core/features/timeline/appNotice';
import {
  appsRunIdOf,
  appsRunSiteOfMessage,
  type AppsTailContext,
  type AppsTailPlugin,
} from '@momo/core/features/timeline/teamAiReply';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';

// =============================================================================
// 「쓴 앱」 꼬리의 바깥 사실 — 폰 (ADR-0113 증보 2 E8·E10, #3950). 웹 `appsTail.ts` 와 같은 길이다:
// 앱 보고 = run 상세, 앱 이름·주소 = 앱 목록, 명의 = 받는 글의 작성자, 노출 수 = 채널 표면.
// 문장과 판정은 코어(`teamAiReply` · `appNotice`)다. 이쪽은 재료를 모으는 일만 한다.
//
// 조회는 조용히 한다: 켜진 앱이 하나도 없으면 run 을 부르지 않고, 실패해도 꼬리만 없다.
// =============================================================================

// 질의 공급자가 없는 자리(공급자 없이 행만 세우는 화면·시험)에서도 행이 죽지 않게 한다: 그때는
// 조회를 하지 않고 꼬리·문장도 없다. 조회가 켜지는 것은 공급자가 있을 때뿐이다.
const NO_PROVIDER_CLIENT = new QueryClient();

/** 이 채널을 읽는 사람 수. DM 이거나 모르면 null. 대화 화면이 내린다. */
export const ChannelAudienceContext = createContext<number | null>(null);

function runIdOf(
  message: Pick<Message, 'props' | 'state' | 'authorMemberId'>,
  directory: Directory,
): string | null {
  // props 는 사람이 쓴 메시지에도 실을 수 있다: 에이전트 멤버가 쓴 답에만 꼬리를 단다.
  if (memberFor(directory, message.authorMemberId)?.kind !== 'agent') {
    return null;
  }
  return appsRunIdOf(message);
}

function pluginMap(
  plugins: readonly {pluginId: string; name: string; egressDomains: string[]}[] | undefined,
): Map<string, AppsTailPlugin> {
  const map = new Map<string, AppsTailPlugin>();
  for (const plugin of plugins ?? []) {
    map.set(plugin.pluginId, {
      name: plugin.name,
      egressDomains: plugin.egressDomains,
    });
  }
  return map;
}

export function useAppsTailContext(
  message: Message,
  directory: Directory,
  workspaceId: string | undefined,
): AppsTailContext | undefined {
  const audience = useContext(ChannelAudienceContext);
  const provider = useContext(QueryClientContext);
  const client = provider ?? NO_PROVIDER_CLIENT;
  const runId = runIdOf(message, directory);
  const provided = isSurfaceProvided('plugins') && isSurfaceProvided('appsUsedTail');
  const ws = (workspaceId ?? '').toLowerCase();
  const ready = provider !== undefined && provided && runId !== null && ws !== '';

  const catalog = useQuery({
    queryKey: ['plugins', ws],
    queryFn: () => listPlugins(workspaceId as string),
    retry: false,
    enabled: ready,
    staleTime: 60_000,
  }, client);
  const anyInstalled = catalog.data?.plugins.some(plugin => plugin.installed) ?? false;
  const run = useQuery({
    queryKey: ['agent-run-apps-used', ws, runId],
    queryFn: async () =>
      (await fetchAgentRunDetail(workspaceId as string, runId as string))
        .appsUsed ?? null,
    retry: false,
    staleTime: Infinity,
    enabled: ready && anyInstalled,
  }, client);

  const appsUsed = run.data ?? null;
  const trigger = message.replyTo?.authorMemberId;
  // 위임 사용자는 사람이다(E5). 받는 글이 에이전트 것이면 명의를 말하지 않는다.
  const triggerMember = trigger ? memberFor(directory, trigger) : null;
  const onBehalfOf =
    triggerMember?.kind === 'human' ? triggerMember.displayName : null;
  const plugins = useMemo(() => pluginMap(catalog.data?.plugins), [catalog.data]);

  return useMemo(
    () =>
      appsUsed === null
        ? undefined
        : {
            appsUsed,
            plugins,
            onBehalfOf,
            site: appsRunSiteOfMessage(message),
            audience,
          },
    [appsUsed, plugins, onBehalfOf, message, audience],
  );
}

/**
 * `props.app_notice` 의 한 문장(+ 행동 하나). 칸이 없으면 null 이고 요청도 하지 않는다.
 * `nowMs` 는 행이 이미 들고 있는 시계다(「n분째」).
 */
export function useAppNotice(
  message: Message,
  workspaceId: string | undefined,
  nowMs: number,
): AppNotice | null {
  const has = hasAppNotice(message);
  const ws = (workspaceId ?? '').toLowerCase();
  const provider = useContext(QueryClientContext);
  const catalog = useQuery({
    queryKey: ['plugins', ws],
    queryFn: () => listPlugins(workspaceId as string),
    retry: false,
    enabled: provider !== undefined && has && isSurfaceProvided('plugins') && ws !== '',
    staleTime: 60_000,
  }, provider ?? NO_PROVIDER_CLIENT);
  const plugins = useMemo(() => pluginMap(catalog.data?.plugins), [catalog.data]);
  return has
    ? appNoticeFor(message, {surface: 'phone', plugins, nowMs})
    : null;
}

/**
 * 폰의 「웹에서 열기」가 여는 주소: 이 서버의 웹 앱에서 앱 화면. 폰에는 동의 창이 없다
 * (plans 2.6) — 허용은 웹·데스크탑에서 한다. 서버 주소를 모르면 null 이고, 그때 행동은
 * 세우지 않는다(열 수 없는 버튼을 만들지 않는다). 화면은 **설정 section id**(`?section=plugins`,
 * #3951)로 잇는다: 웹이 그 id 를 앱 화면으로 풀어 주므로, 웹이 화면을 옮겨도 폰의 링크는 낡지 않는다.
 */
export function appsOnWebUrl(): string | null {
  const base = coreHost().absoluteApiBase().replace(/\/+$/, '');
  return base === '' ? null : `${base}${appsOnWebPath()}`;
}
