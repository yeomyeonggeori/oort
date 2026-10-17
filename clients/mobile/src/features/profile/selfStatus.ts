import {
  setPresenceStatus,
  uuidEq,
  type PresenceWrite,
  type RosterMember,
} from '@momo/core/lib/api';
import {serverSaysAbsent} from '@momo/core/features/capabilities/serverSurfaces';
import {
  fetchNotificationRules,
  fetchPushKinds,
  patchNotificationRules,
  patchPushKinds,
  type NotificationRules,
  type PushKinds,
} from '@momo/core/features/settings/notificationRules';
import {pauseUntilElapsed} from '@momo/core/features/presence/pauseUntil';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';

import {useNow} from '../../lib/useNow';
import {workspaceKeys} from '../workspace/queries';

// =============================================================================
// 내 상태와 알림 일시 중지의 쓰기 — 프로필 시트가 바로 바꾸는 두 가지 (#2848).
//
// 둘 다 **서버에 이미 있는 계약**이다. 새 길을 내지 않는다.
//
//   * 상태(온라인·자리 비움·방해 금지)와 상태 글 — `PUT /presence`
//     (ADR-0160 ③, ADR-0176). REST→PG→outbox→relay 한 길이고, 서버가 같은
//     트랜잭션에서 `type: presence` 를 내 채널들에 방송한다.
//   * 알림 일시 중지 — `PATCH /notification-rules {dnd}` (ADR-0124 증보 1·3,
//     #3042). 푸시 판정(`momo-push` `judge_targets`)이 이 행 하나로 내 모든
//     푸시를 거른다.
//
// ## 기한은 항상 있다 (ADR-0204 D2, #2899)
//
// 두 쓰기 모두 **기한을 싣고서야** 켜진다. 길은 둘이고 섞지 않는다:
//
//   * 방해 금지 — `PUT /presence {status:'dnd', dndUntilMs}`. 서버가 같은 트랜잭션에서
//     알림 일시 중지도 같은 기한으로 켠다(ADR-0124 증보 2 「묶어」). 그래서 폰은
//     notification-rules 를 따로 쓰지 않는다.
//   * 알림 일시 중지 — `PATCH /notification-rules {dnd:true, dndUntilMs}`. 이 쓰기는
//     방해 금지와의 묶음을 끊는다(직접 고른 값을 방해 금지를 풀 때 덮지 않도록).
//
// 그런데 묶음 때문에 **방해 금지를 쓴 뒤에는 알림 규칙이 서버에서 바뀐다** — 들어갈 때만이
// 아니라 나올 때도(켜기 전 값으로 되돌린다). 폰은 규칙을 PUT 하지 않고 다시 읽어서 스위치가
// 실제 값을 보이게 한다. 지금까지는 읽지 않아서 방해 금지를 고른 뒤에도 일시 중지 스위치가
// 꺼짐으로 남았다(ADR-0204 맥락).
//
// 웹과 **같은 캐시 키**를 쓴다: 명부는 `['roster', ws]`(웹 `PresenceControl`),
// 알림 규칙은 `['settings', 'notification-rules', ws]`(웹
// `NotificationRulesSection`). 한 글자라도 다르면 「폰에서 바꿨는데 폰의 다른
// 자리가 옛 값을 그린다」가 된다.
//
// ## 알림 규칙은 바꾼 스위치만 보낸다
//
// `PUT /notification-rules` 는 두 스위치를 **모두** 받는 통째 치환이라, 폰이
// 일시 중지만 바꾸면서 모르는(또는 오래된) `mentionOverridesMute` 를 함께 보내면
// 웹 설정에서 켜 둔 멘션 예외가 조용히 꺼진다. 서버 부분 갱신(#3012 `PATCH`)으로
// 옮겨 `{dnd}` 하나만 싣는다(`usePauseNotifications`, #3042).
// =============================================================================

export const notificationRulesKey = (workspaceId: string) =>
  ['settings', 'notification-rules', workspaceId] as const;

/** `setTimeout` 은 이 값을 넘는 지연을 즉시 실행으로 읽는다(32비트). 더 먼 기한은 분 틱이 맡는다. */
const MAX_TIMER_MS = 2_147_483_647;
/** 타이머가 기한보다 조금 일찍 깨어도 「지났다」가 참이 되도록 두는 여유. */
const RECHECK_SLACK_MS = 500;

/**
 * 알고 있는 기한이 지나면 서버에 다시 묻는다 (ADR-0204 D2·D3, #2899 design-review H3).
 *
 * 방해 금지와 알림 일시 중지의 만료는 서버가 판정한다. 서버는 만료 시각에 이벤트를 보내지 않고
 * (`RosterMember.dndUntilMs`) 질의 캐시는 30초 동안 신선하다고 믿으며 포커스 재조회도 꺼져 있다
 * (`query/queryClient.ts`). 아무것도 하지 않으면 기한이 지난 뒤에도 시트가 낡은 방해 금지 줄과
 * 「오후 10:30까지」를 말한다.
 *
 * 이 훅은 **화면을 스스로 풀지 않는다.** 기한이 지난 것을 알면 규칙과 명부를 다시 읽을 뿐이고, 줄이
 * 사라지는 것은 서버의 새 답이 도착했을 때다. 서버가 아직 켜져 있다고 답하면(두 시계의 차이) 화면은
 * 그대로이고 분 틱마다 다시 묻는다. 기한이 오는 순간에 한 번 깨어(분 틱을 기다리지 않는다) 묻는다.
 */
export function useRecheckWhenElapsed(
  workspaceId: string,
  untilMs: number | undefined,
): void {
  const client = useQueryClient();
  const tick = useNow();
  const [, wake] = useState(0);

  useEffect(() => {
    if (untilMs === undefined) return;
    const wait = untilMs - Date.now();
    if (wait <= 0 || wait > MAX_TIMER_MS) return;
    const id = setTimeout(() => wake(n => n + 1), wait + RECHECK_SLACK_MS);
    return () => clearTimeout(id);
  }, [untilMs]);

  const elapsed = pauseUntilElapsed(untilMs, Date.now());
  useEffect(() => {
    if (!elapsed) return;
    void client.invalidateQueries({queryKey: notificationRulesKey(workspaceId)});
    void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
  }, [client, elapsed, tick, workspaceId]);
}

function patchSelf(
  rows: RosterMember[] | undefined,
  selfId: string,
  write: PresenceWrite,
): RosterMember[] | undefined {
  return rows?.map(row => {
    if (!uuidEq(row.id, selfId)) return row;
    const next: RosterMember = {...row, presenceStatus: write.status};
    // 기한은 방해 금지에만 있다. 방해 금지가 아니게 되면 서버가 기한도 지운다. 방해 금지에서
    // 키가 없으면 진행 중인 기한을 그대로 두고, null 이면 기한 없음, 값이면 그 시각이다.
    if (write.status !== 'dnd') {
      delete next.dndUntilMs;
    } else if (write.dndUntilMs !== undefined) {
      if (write.dndUntilMs === null) delete next.dndUntilMs;
      else next.dndUntilMs = write.dndUntilMs;
    }
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
    onSettled: (_data, _error, write, context) => {
      void client.invalidateQueries({queryKey: key});
      // 방해 금지에 들어가거나 나오면 서버가 알림 일시 중지를 함께 바꾼다(증보 2). 규칙을
      // 다시 읽지 않으면 스위치가 옛 값(꺼짐)으로 남아 멈춘 알림을 숨긴다. 쓰는 것이 아니라
      // 읽는 것이다 — 폰은 방해 금지를 고르며 notification-rules 를 쓰지 않는다.
      const was = context?.previous?.find(row => uuidEq(row.id, selfId));
      if (write.status === 'dnd' || was?.presenceStatus === 'dnd') {
        void client.invalidateQueries({queryKey: notificationRulesKey(workspaceId)});
      }
    },
  });
}

/** 켜는 쪽은 기한이 타입에 들어 있다 — 기한 없이 켜는 호출은 컴파일되지 않는다. */
type PauseChange = {paused: true; untilMs: number} | {paused: false};

/**
 * 알림 일시 중지(= 서버 `notification_rule.dnd`).
 *
 * `ready` 가 거짓이면 규칙을 아직 못 읽었다. 그때는 스위치를 잠근다 — 모르는
 * 멘션 예외를 덮어쓰지 않으려고.
 *
 * ## 켜는 쓰기는 기한을 싣는다 (ADR-0204 D2, #2899)
 *
 * `pauseUntil(untilMs)` 만 켠다. **기한 없이 켜는 길은 이 훅에 없다** — 기한 없는 켜기를
 * 화면에서 만들 수 있었던 것이 성재 계정이 15일 동안 알림 0건이던 원인이었다. 서버 계약
 * (`dndUntilMs: null` = 기한 없음)은 그대로이고, 이미 있는 기한 없는 행은 `untilMs` 가
 * 비어 있는 채로 읽힌다. 끄는 쓰기(`resume`)는 기한을 싣지 않는다(서버가 지운다).
 *
 * ## 쓰기는 이 스위치 하나만 싣는다 (#3042)
 *
 * 폰 캐시는 최대 30초 오래됐을 수 있다(`queryClient` `staleTime`, 포커스 재조회
 * 없음). 그 사이 웹 설정이 멘션 예외를 켜면, 읽은 값으로 만든 통째 PUT 은 그것을
 * 조용히 끈다. 쓰기 직전에 다시 읽어도(#2893) 읽기와 쓰기 사이의 틈은 남는다.
 * 그래서 `PATCH {dnd, dndUntilMs}` 로 이 스위치의 필드만 보낸다(#3012 서버 부분 갱신).
 * 서버가 행 잠금 아래에서 **도착한 때의** 값 위에 합치므로 멘션 예외는 누가 언제
 * 바꿨든 그대로 남는다.
 *
 * ## 「읽지 못했다」는 한 번도 못 읽었을 때만
 *
 * 한 번 읽은 뒤의 재조회 실패는 화면을 바꾸지 않는다. 읽은 값으로 스위치를 계속
 * 그리면서 「불러오지 못했습니다」를 함께 말하면 화면이 스스로 모순된다. 쓰기는
 * 이 스위치 하나만 싣으므로 오래된 값이 서버로 가지 않는다.
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
    mutationFn: (change: PauseChange) =>
      patchNotificationRules(
        workspaceId,
        change.paused ? {dnd: true, dndUntilMs: change.untilMs} : {dnd: false},
      ),
    onMutate: async (change: PauseChange) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<NotificationRules>(key);
      if (previous) {
        // 꺼지면 기한도 사라진다(서버가 지운다). 켜면 고른 기한이 옛 기한을 덮는다.
        const next: NotificationRules = {...previous, dnd: change.paused};
        if (change.paused) next.dndUntilMs = change.untilMs;
        else delete next.dndUntilMs;
        client.setQueryData<NotificationRules>(key, next);
      }
      return {previous};
    },
    onError: (_error, _change, context) => {
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
    /** 진행 중인 기한(에폭 ms). 켜져 있는데 비어 있으면 기한 없는 행이다. */
    untilMs: rules?.dnd ? rules.dndUntilMs : undefined,
    loadFailed: query.isError && rules === undefined,
    retryLoad: () => void query.refetch(),
    pending: mutation.isPending,
    failed: mutation.isError,
    /**
     * 기한을 걸어 켠다(이미 켜져 있으면 기한을 바꾼다). 썼으면 `true`, 실패하면 거절된다 —
     * 기한을 고르는 장이 그 결과로 닫힐지 말할지 정한다. 규칙을 한 번도 못 읽었거나 쓰는 중이면
     * 아무것도 보내지 않고 `false` 다(호출자가 성공으로 읽지 않게).
     */
    pauseUntil: async (untilMs: number): Promise<boolean> => {
      if (rules === undefined || mutation.isPending) return false;
      await mutation.mutateAsync({paused: true, untilMs});
      return true;
    },
    /**
     * 일시 중지를 끈다. `options.onError` 는 이 쓰기가 실패해 낙관값이 되돌려진 **뒤에** 불린다 — 호출자가
     * 「누른 줄에 이유를 붙이는」 일을 낙관 칠하기가 줄 모양을 바꾼 것과 독립으로 할 수 있게(인박스 멈춤 줄).
     */
    resume: (options?: {onError?: () => void}) => {
      // 한 번은 읽어야 스위치가 선다(모르는 상태를 「꺼짐」으로 그리지 않게).
      if (rules === undefined || mutation.isPending) return;
      mutation.mutate({paused: false}, options);
    },
  };
}

export const pushKindsKey = (workspaceId: string) =>
  ['settings', 'push-kinds', workspaceId] as const;

/**
 * 푸시 **종류** 스위치 — 지금은 「작업 끝남」 하나 (ADR-0120 부록 A, #3342).
 *
 * `usePauseNotifications` 와 같은 모양이고 같은 이유로 그렇다: 서버 값을 한 번 읽기
 * 전에는 스위치를 세우지 않고(모르는 상태를 「꺼짐」으로 그리면 켜 둔 사람에게 거짓이다
 * — 서버 기본은 **켬**이다), 쓰기는 이 스위치 하나만 PATCH 로 싣는다.
 *
 * `absent` 는 서버가 이 경로를 모른다고 직접 답했다는 뜻이다(404/405/501) — 아직
 * 이 기능을 배포하지 않은 서버. 그때 죽은 스위치를 세우는 것은 켜도 아무 일도 없는
 * 약속이므로 줄 자체를 세우지 않는다.
 */
export function usePushKinds(workspaceId: string) {
  const client = useQueryClient();
  const key = pushKindsKey(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchPushKinds(workspaceId),
    retry: (count, error) => !serverSaysAbsent(error) && count < 1,
  });
  const mutation = useMutation({
    mutationFn: (workComplete: boolean) =>
      patchPushKinds(workspaceId, {workComplete}),
    onMutate: async (workComplete: boolean) => {
      await client.cancelQueries({queryKey: key});
      const previous = client.getQueryData<PushKinds>(key);
      client.setQueryData<PushKinds>(key, {workComplete});
      return {previous};
    },
    onError: (_error, _next, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: saved => {
      client.setQueryData(key, saved);
    },
  });
  const kinds = query.data;
  return {
    absent: query.isError && serverSaysAbsent(query.error),
    ready: kinds !== undefined,
    workComplete: kinds?.workComplete ?? true,
    loadFailed:
      query.isError && kinds === undefined && !serverSaysAbsent(query.error),
    retryLoad: () => void query.refetch(),
    pending: mutation.isPending,
    failed: mutation.isError,
    setWorkComplete: (next: boolean) => {
      if (kinds === undefined || mutation.isPending) return;
      mutation.mutate(next);
    },
  };
}
