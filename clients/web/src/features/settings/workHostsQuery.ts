import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { listWorkHosts, type WorkHost } from "@momo/core/features/settings/api";

// 작업 호스트 등록부의 질의 (ADR-0125). 설정 > 실행 호스트(목록)와 설정 > 기기(이 맥,
// 재개 대상 고르기)가 같은 질의 키를 나눠 쓴다(#3578 S4).

/**
 * Registry re-read interval. Half the server's 90 second heartbeat window
 * (`WorkHostRoutes.onlineWindowSeconds`), so a host that comes up is named
 * online within one window rather than whenever someone reloads the browser.
 */
export const REGISTRY_POLL_MS = 30_000;

export const WORK_HOSTS_QUERY_KEY = (workspaceId: string) =>
  ["settings", "work-hosts", workspaceId] as const;

/**
 * One read of the registry serves the list and the auto-target choices.
 *
 * `online` is the server's 90 second heartbeat window, so a value painted once
 * and never re-read is a claim about the past wearing the present tense. This
 * query polls at half the heartbeat window and goes stale immediately, which also
 * makes leaving and re-entering a page a real re-read rather than a cache hit.
 */
export function useWorkHosts(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: WORK_HOSTS_QUERY_KEY(workspaceId),
    queryFn: () => listWorkHosts(workspaceId),
    retry: false,
    staleTime: 0,
    refetchInterval: REGISTRY_POLL_MS,
    enabled,
  });
}

/**
 * What the panel is allowed to say about the registry.
 *
 * `hosts` is one query shared by the list and the target picker, and "이 호스트는
 * 등록에 없습니다" is only true once it has actually answered. While it is in
 * flight or failed there is no ledger to compare against, so the target control
 * says so instead of drawing a picker whose every claim would be a guess.
 */
export type RegistryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; hosts: WorkHost[] };

export function registryState(query: UseQueryResult<WorkHost[], unknown>): RegistryState {
  if (query.isPending) return { status: "loading" };
  if (query.isError) return { status: "error" };
  return { status: "ready", hosts: query.data ?? [] };
}

