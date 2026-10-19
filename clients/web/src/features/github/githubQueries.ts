import { useQuery } from "@tanstack/react-query";
import {
  fetchGithubAppStatus,
  fetchGithubOverview,
  listUnlinkedInstallations,
} from "@momo/core/features/github/api";

// =============================================================================
// GitHub 알림 질의 (ADR-0205, #3955). 키는 작업 공간으로 나눈다: 같은 서버의 다른 워크스페이스
// 설치 목록이 한 캐시 칸에 섞이면 남의 계정 이름이 보인다.
//
// `retry: false` 인 이유: 이 표면의 실패는 대부분 「권한이 없다(403)」 「이 서버에 없다(404)」
// 「키가 없다(503)」라서 다시 물어도 같은 답이다. 사람이 「다시 시도」를 눌러 다시 묻는다.
// =============================================================================

export function githubOverviewKey(workspaceId: string, channelId?: string) {
  return ["github", "overview", workspaceId.toLowerCase(), channelId?.toLowerCase() ?? "all"] as const;
}

export function githubOverviewPrefix(workspaceId: string) {
  return ["github", "overview", workspaceId.toLowerCase()] as const;
}

export const githubAppStatusKey = ["github", "app-status"] as const;
export const githubUnlinkedKey = ["github", "unlinked"] as const;

export function useGithubOverview(workspaceId: string, enabled = true, channelId?: string) {
  return useQuery({
    queryKey: githubOverviewKey(workspaceId, channelId),
    queryFn: () => fetchGithubOverview(workspaceId, channelId),
    retry: false,
    enabled,
  });
}

export function useGithubAppStatus(enabled = true) {
  return useQuery({
    queryKey: githubAppStatusKey,
    queryFn: fetchGithubAppStatus,
    retry: false,
    enabled,
  });
}

export function useUnlinkedInstallations(enabled: boolean) {
  return useQuery({
    queryKey: githubUnlinkedKey,
    queryFn: listUnlinkedInstallations,
    retry: false,
    enabled,
  });
}
