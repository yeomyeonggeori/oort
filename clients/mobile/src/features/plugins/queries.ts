import {
  getPlugin,
  listPlugins,
  type PluginCatalog,
  type PluginDetail,
} from '@momo/core/lib/api';
import {useQuery} from '@tanstack/react-query';

// =============================================================================
// 「앱」 읽기 화면의 두 읽기 (U-4 #3951). 쓰기는 없다 — 폰에는 설치·허용이 없다(plans 2.6).
//
// 목록의 키는 「쓴 앱」 꼬리(`conversation/appsTail.ts`)와 웹 `PluginSection` 의 것과 글자 그대로
// 같다(`['plugins', 워크스페이스]`): 같은 답을 세 군데가 따로 받지 않는다.
//
// `retry: false` — 이 표면의 404 는 「이 서버에 앱이 없다」(`serverSaysAbsent`)는 답이고, 기본
// 재시도는 그 답을 얻으려 두 번 더 왕복한다.
// =============================================================================

export const pluginKeys = {
  catalog: (workspaceId: string) => ['plugins', workspaceId.toLowerCase()] as const,
  detail: (workspaceId: string, pluginId: string) =>
    ['plugin-detail', workspaceId.toLowerCase(), pluginId] as const,
};

export function usePluginCatalog(workspaceId: string, enabled: boolean) {
  return useQuery<PluginCatalog>({
    queryKey: pluginKeys.catalog(workspaceId),
    queryFn: () => listPlugins(workspaceId),
    retry: false,
    staleTime: 60_000,
    enabled,
  });
}

export function usePluginDetail(workspaceId: string, pluginId: string) {
  return useQuery<PluginDetail>({
    queryKey: pluginKeys.detail(workspaceId, pluginId),
    queryFn: () => getPlugin(workspaceId, pluginId),
    retry: false,
    staleTime: 60_000,
  });
}
