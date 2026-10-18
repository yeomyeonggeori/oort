import {createContext, useContext, useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';
import {
  fetchAgentRunDetail,
  listPlugins,
  type Message,
} from '@momo/core/lib/api';
import {coreHost} from '@momo/core/runtime/host';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {
  APPS_SCREEN_PATH,
  appNoticeFor,
  type AppNotice,
} from '@momo/core/features/timeline/appNotice';
import {
  appsRunSiteOf,
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

/** 이 채널을 읽는 사람 수. DM 이거나 모르면 null. 대화 화면이 내린다. */
export const ChannelAudienceContext = createContext<number | null>(null);

function runIdOf(message: Pick<Message, 'props' | 'state'>): string | null {
  if (message.state === 'deleted') {
    return null;
  }
  const props = message.props;
  if (!props || appsRunSiteOf(props) === null || props.status === 'failed') {
    return null;
  }
  const runId = props.run_id;
  return typeof runId === 'string' && runId !== '' ? runId : null;
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
  const runId = runIdOf(message);
  const provided = isSurfaceProvided('plugins');
  const ws = (workspaceId ?? '').toLowerCase();
  const ready = provided && runId !== null && ws !== '';

  const catalog = useQuery({
    queryKey: ['plugins', ws],
    queryFn: () => listPlugins(workspaceId as string),
    retry: false,
    enabled: ready,
    staleTime: 60_000,
  });
  const anyInstalled = catalog.data?.plugins.some(plugin => plugin.installed) ?? false;
  const run = useQuery({
    queryKey: ['agent-run-apps-used', ws, runId],
    queryFn: async () =>
      (await fetchAgentRunDetail(workspaceId as string, runId as string))
        .appsUsed ?? null,
    retry: false,
    staleTime: Infinity,
    enabled: ready && anyInstalled,
  });

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
            site: appsRunSiteOf(message.props),
            audience,
          },
    [appsUsed, plugins, onBehalfOf, message.props, audience],
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
  const has =
    message.state !== 'deleted' &&
    typeof message.props?.app_notice === 'object' &&
    message.props.app_notice !== null;
  const ws = (workspaceId ?? '').toLowerCase();
  const catalog = useQuery({
    queryKey: ['plugins', ws],
    queryFn: () => listPlugins(workspaceId as string),
    retry: false,
    enabled: has && isSurfaceProvided('plugins') && ws !== '',
    staleTime: 60_000,
  });
  const plugins = useMemo(() => pluginMap(catalog.data?.plugins), [catalog.data]);
  return has
    ? appNoticeFor(message, {surface: 'phone', plugins, nowMs})
    : null;
}

/**
 * 폰의 「웹에서 열기」가 여는 주소: 이 서버의 웹 앱에서 앱 화면. 폰에는 동의 창이 없다
 * (plans 2.6) — 허용은 웹·데스크탑에서 한다. 서버 주소를 모르면 null 이고, 그때 행동은
 * 세우지 않는다(열 수 없는 버튼을 만들지 않는다). 섹션 id 로 잇는 링크는 #3951(U-4)이
 * 맡고, 여기는 화면 경로까지만 안다.
 */
export function appsOnWebUrl(): string | null {
  const base = coreHost().absoluteApiBase().replace(/\/+$/, '');
  return base === '' ? null : `${base}${APPS_SCREEN_PATH}`;
}
