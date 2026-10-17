import { useQuery } from "@tanstack/react-query";
import { pluginInstallVerdict } from "@momo/core/features/capabilities/serverSurfaces";
import { probePluginWriteRoutes } from "@momo/core/lib/api";

// =============================================================================
// 「앱 설치」가 열려 있는가 (#3860, ADR-0113 증보 P3).
//
// 읽기와 쓰기의 경로는 따로 선다. 이 서버가 앱 목록을 보여 준다고 설치·권한 버튼이
// 눌러지는 것은 아니고, 눌렀을 때 404가 오면 그 버튼은 처음부터 서 있지 말았어야 한다.
// 그래서 버튼을 세우기 전에 서버에 **바꾸는 것 없는 질문**을 한다(`probePluginWriteRoutes`,
// 읽는 법은 `pluginInstallVerdict`). 표를 손으로 뒤집지 않는 이유도 같다: 이 클라이언트는
// 서버보다 먼저 업데이트되는 일이 흔해서, 코드베이스의 서버가 경로를 싣는다는 사실이
// 지금 이야기하는 서버가 싣는다는 사실을 말해 주지 않는다.
//
// 세 상태만 있고, 화면은 각각 다르게 말한다.
//   checking  아직 답이 없다. 버튼도 안내도 그리지 않는다. 안내를 먼저 그렸다가 버튼으로
//             바꾸면 「곧 열려요」라는 문장이 열려 있는 서버 앞에서 깜빡인다.
//   open      두 경로가 모두 서 있다. 설치·권한 버튼이 선다.
//   closed    없거나 모른다. 버튼은 없고 차분한 안내 한 줄이 선다. **모르면 닫는다**:
//             눌렀더니 404인 버튼이 이 판정이 막으려는 화면이다.
//
// 열린 서버를 한 번 본 뒤에는 일시적인 실패(네트워크·5xx)가 그것을 닫지 않는다.
// react-query가 마지막 답을 그대로 들고 있고, 다음 재확인이 실패해도 지우지 않는다.
// =============================================================================

export type InstallAvailability = "checking" | "open" | "closed";

/** 같은 서버를 다시 묻는 간격. 서버가 업그레이드되는 일은 화면을 연 채 며칠씩 걸리지 않는다. */
export const INSTALL_PROBE_STALE_MS = 5 * 60_000;

/** 프로브 쿼리 키. 앱 목록 키(`["plugins", …]`)와 갈라 둔다: 쓰기 뒤의 무효화가 이 답을 지우지 않는다. */
export function installProbeKey(workspaceId: string): readonly unknown[] {
  return ["plugin-install-probe", workspaceId.toLowerCase()];
}

/**
 * @param pluginId 카탈로그가 준 실제 앱 하나. 경로의 한 칸을 채울 뿐이라 어느 앱이든 같은
 *                 답이 온다. 카탈로그가 아직 없으면 `undefined`이고 그동안은 묻지 않는다.
 */
export function useInstallAvailability(
  workspaceId: string,
  pluginId: string | undefined
): InstallAvailability {
  const probe = useQuery({
    queryKey: installProbeKey(workspaceId),
    queryFn: ({ signal }) => probePluginWriteRoutes(workspaceId, pluginId ?? "", signal),
    enabled: pluginId !== undefined,
    retry: false,
    staleTime: INSTALL_PROBE_STALE_MS,
  });
  if (pluginId === undefined || probe.isPending) return "checking";
  return pluginInstallVerdict(probe.data) === "present" ? "open" : "closed";
}
