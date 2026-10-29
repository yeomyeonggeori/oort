import {
  devAccessError,
  getDevAccessPolicy,
  listDevCredentials,
  revokeDevCredential,
  type DevCredential,
} from '@momo/core/features/auth/devAccess';
import {isOwnDevCredential} from '@momo/core/features/auth/devAccessModel';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback} from 'react';

// =============================================================================
// 「명령줄·AI 도구」의 읽기와 폐기. 설정 페이지의 안쪽 장과 「연결」 카드의 행이 함께 읽는다 (#4663, ADR-0216 D6·D7).
//
// 폰은 **목록과 폐기만** 한다(만들기는 컴퓨터의 설정). 토큰 원문을 폰이 받을 길이 없다: 이 파일이 부르는 세 호출
// (`getDevAccessPolicy`·`listDevCredentials`·`revokeDevCredential`)의 답에는 비밀이 없고, 새로 만들 비밀 처리도 없다.
//
// 키는 웹의 `["settings", "dev-access", …]` 접두를 따른다(폰의 설정 질의 관례: `['settings', 'notification-rules', ws]`
// 등). 두 클라이언트는 캐시를 나누지 않으므로 이름만 겹치지 않으면 되지만, 한 접두라야 같은 범위를 말한다.
// =============================================================================

export const devAccessPolicyKey = (workspaceId: string) =>
  ['settings', 'dev-access', 'policy', workspaceId] as const;

export const devCredentialsKey = (workspaceId: string) =>
  ['settings', 'dev-access', 'credentials', workspaceId] as const;

/**
 * 워크스페이스 스위치와 내가 할 수 있는 일. `retry: false`: 이 서버에 길이 없으면(404) 되풀이해도 같다.
 */
export function useDevAccessPolicy(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: devAccessPolicyKey(workspaceId),
    queryFn: () => getDevAccessPolicy(workspaceId),
    enabled,
    retry: false,
  });
}

/**
 * **내** 연결 목록(살아 있는 것만, 최신순). 서버가 `scope=all` 없이 내 것만 주지만 폰은 한 번 더 거른다: 이 장의
 * 행에는 모두 「지우기」가 서므로 남의 행이 섞여 오면 그 단추가 서고 서버는 거절한다. 폰은 전체 보기를 두지 않는다
 * (관리자는 컴퓨터에서 본다).
 *
 * `staleTime: 0`: 「마지막 사용」은 보안 판단의 재료라 장을 열 때마다 서버에서 다시 읽는다. 같은 키를 설정 페이지의
 * 행(`useDevToolsEntry`)도 읽지만, 관찰자가 하나 더 붙을 때 다시 읽히는 것은 의도다.
 */
export function useMyDevCredentials(workspaceId: string, selfId: string, enabled = true) {
  const mine = useCallback(
    (rows: DevCredential[]) => rows.filter(row => isOwnDevCredential(row, selfId)),
    [selfId],
  );
  return useQuery({
    queryKey: devCredentialsKey(workspaceId),
    queryFn: () => listDevCredentials(workspaceId),
    enabled,
    retry: false,
    staleTime: 0,
    select: mine,
  });
}

/**
 * 한 연결을 지운다. 서버의 200 이 그 id 에 대한 답이다(`revokedNow:false` 도 「이미 끝나 있었다」는 성공이다).
 *
 * - 성공: 이미 날아가던 읽기가 옛 목록으로 덮지 못하게 먼저 멈추고, 캐시에서 그 줄만 뺀다. 목록은 낡았다고만
 *   적는다(`refetchType: 'none'`): 다른 줄은 이 답이 말한 것이 아니고, 다음에 이 목록을 보는 곳이 서버에서 읽는다.
 * - 404: 없는 id 이거나 이미 지워졌다. 목록이 서버와 어긋나 있다는 뜻이라 바로 다시 읽는다.
 * - `networkMode: 'always'`: 끊긴 채 누르면 요청이 「보류」로 서서 연결이 돌아온 **나중에** 혼자 나가 버린다. 지우는
 *   일은 사람이 누른 그 순간에만 나가야 해서(화면도 끊김에는 단추를 잠근다) 보류하지 않고 곧바로 실패하게 한다.
 */
export function useRevokeDevCredential(workspaceId: string) {
  const client = useQueryClient();
  const key = devCredentialsKey(workspaceId);
  return useMutation({
    mutationFn: (id: string) => revokeDevCredential(workspaceId, id),
    networkMode: 'always',
    onSuccess: async (_result, id) => {
      await client.cancelQueries({queryKey: key});
      client.setQueryData<DevCredential[]>(key, rows =>
        rows?.filter(row => row.id !== id),
      );
      void client.invalidateQueries({queryKey: key, refetchType: 'none'});
    },
    onError: error => {
      if (devAccessError(error).kind === 'not_found') {
        void client.invalidateQueries({queryKey: key});
      }
    },
  });
}

/**
 * 설정 페이지의 「명령줄·AI 도구 ›」 행이 서는가. **접근하지 못하는 기능을 광고하지 않는다**: 내가 만들 수 있거나(소유자·관리자),
 * 이미 만든 연결이 하나라도 있을 때(스위치가 바뀐 뒤에도 지우러 올 길이 남는다)만 선다.
 *
 * - 정책 조회가 끝나기 전(`isPending`)에는 그리지 않는다. 끝났다는 것은 답이 왔거나 실패했다는 뜻이다. 실패하면 모르는 것을
 *   「만들 수 있다」로 읽지 않고, 목록이 말하는 사실(내 연결 1개 이상)만 본다.
 * - 목록은 모르는 동안 0 으로 읽는다. 만들 수 있는 사람은 목록을 기다리지 않고 행이 서고, 개수는 목록이 온 뒤에 붙는다.
 * - `enabled` 가 거짓이면(행을 열 문이 없는 호스트: 측정 하네스의 직접 호출) 아무것도 읽지 않는다.
 */
export function useDevToolsEntry(workspaceId: string, selfId: string, enabled: boolean) {
  const policy = useDevAccessPolicy(workspaceId, enabled);
  const credentials = useMyDevCredentials(workspaceId, selfId, enabled);
  const count = credentials.data?.length;
  const visible =
    enabled &&
    !policy.isPending &&
    (policy.data?.canCreate === true || (count ?? 0) > 0);
  return {visible, count};
}
