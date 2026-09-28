import {
  setPresenceStatus,
  uuidEq,
  type PresenceWrite,
  type RosterMember,
} from '@momo/core/lib/api';
import {
  fetchNotificationRules,
  putNotificationRules,
  type NotificationRules,
} from '@momo/core/features/settings/notificationRules';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';

import {workspaceKeys} from '../workspace/queries';

// =============================================================================
// 내 상태와 알림 일시 중지의 쓰기 — 프로필 시트가 바로 바꾸는 두 가지 (#2848).
//
// 둘 다 **서버에 이미 있는 계약**이다. 새 길을 내지 않는다.
//
//   * 상태(온라인·자리 비움·방해 금지)와 상태 글 — `PUT /presence`
//     (ADR-0160 ③, ADR-0176). REST→PG→outbox→relay 한 길이고, 서버가 같은
//     트랜잭션에서 `type: presence` 를 내 채널들에 방송한다.
//   * 알림 일시 중지 — `PUT /notification-rules {dnd}` (ADR-0124 증보 1). 푸시
//     판정(`momo-push` `judge_targets`)이 이 행 하나로 내 모든 푸시를 거른다.
//
// 웹과 **같은 캐시 키**를 쓴다: 명부는 `['roster', ws]`(웹 `PresenceControl`),
// 알림 규칙은 `['settings', 'notification-rules', ws]`(웹
// `NotificationRulesSection`). 한 글자라도 다르면 「폰에서 바꿨는데 폰의 다른
// 자리가 옛 값을 그린다」가 된다.
//
// ## 알림 규칙은 통째로 바뀐다
//
// `PUT /notification-rules` 는 두 스위치를 **모두** 받는다(부분 갱신 없음). 폰이
// 일시 중지만 바꾸면서 `mentionOverridesMute` 를 모르는 채 `false` 로 보내면, 웹
// 설정에서 켜 둔 멘션 예외가 조용히 꺼진다. 그래서 쓰기는 **읽은 값 위에서만**
// 한다 — 읽기 전에는 스위치를 누를 수 없고, 누르면 서버에서 다시 읽은 값 위에
// 쓴다(`usePauseNotifications`, #2893).
// =============================================================================

export const notificationRulesKey = (workspaceId: string) =>
  ['settings', 'notification-rules', workspaceId] as const;

function patchSelf(
  rows: RosterMember[] | undefined,
  selfId: string,
  write: PresenceWrite,
): RosterMember[] | undefined {
  return rows?.map(row => {
    if (!uuidEq(row.id, selfId)) return row;
    const next: RosterMember = {...row, presenceStatus: write.status};
    // 키가 없으면 그대로, null 이면 지운다 — 서버의 omit/null 규칙과 같다.
    if (write.statusEmoji !== undefined) {
      if (write.statusEmoji === null) delete next.statusEmoji;
      else next.statusEmoji = write.statusEmoji;
    }
    if (write.statusText !== undefined) {
      if (write.statusText === null) delete next.statusText;
      else next.statusText = write.statusText;
    }
    if (write.statusExpiresAtMs !== undefined) {
      if (write.statusExpiresAtMs === null) delete next.statusExpiresAtMs;
      else next.statusExpiresAtMs = write.statusExpiresAtMs;
    }
    return next;
  });
}

/**
 * 내 선언 상태·상태 글 쓰기. 명부 캐시에 먼저 칠하고(시트의 알약이 바로
 * 바뀐다), 실패하면 되돌리고, 성공하면 서버 값으로 다시 읽는다.
 */
export function useSetPresence(workspaceId: string, selfId: string) {
  const client = useQueryClient();
  const key = workspaceKeys.roster(workspaceId);
  return useMutation({
    mutationFn: (write: PresenceWrite) => setPresenceStatus(workspaceId, write),
    onMutate: async (write: PresenceWrite) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<RosterMember[]>(key);
      client.setQueryData<RosterMember[]>(key, rows =>
        patchSelf(rows, selfId, write),
      );
      return {previous};
    },
    onError: (_error, _write, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({queryKey: key});
    },
  });
}

/**
 * 알림 일시 중지(= 서버 `notification_rule.dnd`).
 *
 * `ready` 가 거짓이면 규칙을 아직 못 읽었다. 그때는 스위치를 잠근다 — 모르는
 * 멘션 예외를 덮어쓰지 않으려고.
 *
 * ## 쓰기 직전에 다시 읽는다 (#2893)
 *
 * 폰 캐시는 최대 30초 오래됐을 수 있다(`queryClient` `staleTime`, 포커스 재조회
 * 없음). 그 사이 웹 설정이 멘션 예외를 켜면, 캐시 위에서 만든 통째 PUT 이 그것을
 * 조용히 끈다. 그래서 쓰기는 **서버에서 방금 읽은 규칙** 위에서 한다. 다시 읽기가
 * 실패하면 쓰지 않는다(쓰기 실패와 같게 되돌리고 말한다). 근본 해결은 서버 부분
 * 갱신이다(별도 이슈).
 *
 * ## 「읽지 못했다」는 한 번도 못 읽었을 때만
 *
 * 한 번 읽은 뒤의 재조회 실패는 화면을 바꾸지 않는다. 읽은 값으로 스위치를 계속
 * 그리면서 「불러오지 못했습니다」를 함께 말하면 화면이 스스로 모순된다. 쓰기는
 * 어차피 직전에 다시 읽으므로 오래된 값이 서버로 가지 않는다.
 */
export function usePauseNotifications(workspaceId: string) {
  const client = useQueryClient();
  const key = notificationRulesKey(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchNotificationRules(workspaceId),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (paused: boolean) => {
      const fresh = await fetchNotificationRules(workspaceId);
      return putNotificationRules(workspaceId, {...fresh, dnd: paused});
    },
    onMutate: async (paused: boolean) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<NotificationRules>(key);
      if (previous) {
        client.setQueryData<NotificationRules>(key, {...previous, dnd: paused});
      }
      return {previous};
    },
    onError: (_error, _paused, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: saved => {
      client.setQueryData(key, saved);
    },
  });
  const rules = query.data;
  return {
    ready: rules !== undefined,
    paused: rules?.dnd ?? false,
    loadFailed: query.isError && rules === undefined,
    retryLoad: () => void query.refetch(),
    pending: mutation.isPending,
    failed: mutation.isError,
    setPaused: (paused: boolean) => {
      // 한 번은 읽어야 스위치가 선다. 실제로 싣는 값은 직전 재조회가 정한다.
      if (rules === undefined || mutation.isPending) return;
      mutation.mutate(paused);
    },
  };
}
