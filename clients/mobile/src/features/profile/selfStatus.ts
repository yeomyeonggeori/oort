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
// 한다 — 읽기 전에는 스위치를 누를 수 없다(`usePauseNotifications().ready`).
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
 * `ready` 가 거짓이면 규칙을 아직 못 읽었거나 읽기에 실패한 것이다. 그때는
 * 스위치를 잠근다 — 모르는 멘션 예외를 덮어쓰지 않으려고.
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
    mutationFn: (next: NotificationRules) =>
      putNotificationRules(workspaceId, next),
    onMutate: async (next: NotificationRules) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<NotificationRules>(key);
      client.setQueryData<NotificationRules>(key, next);
      return {previous};
    },
    onError: (_error, _next, context) => {
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
    loadFailed: query.isError,
    retryLoad: () => void query.refetch(),
    pending: mutation.isPending,
    failed: mutation.isError,
    setPaused: (paused: boolean) => {
      // 읽은 규칙 위에서만 쓴다. 다른 스위치는 읽은 값 그대로 싣는다.
      if (rules === undefined || mutation.isPending) return;
      mutation.mutate({...rules, dnd: paused});
    },
  };
}
