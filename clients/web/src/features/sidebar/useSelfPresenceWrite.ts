import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  setPresenceStatus,
  uuidEq,
  type PresenceWrite,
  type RosterMember,
} from "@momo/core/lib/api";
import { notificationRulesQueryKey } from "@/features/settings/notificationRulesKey";

// =============================================================================
// 내 선언 상태(온라인·자리 비움·방해 금지) 쓰기 한 길 (ADR-0160 ③, #2899).
//
// 사이드바 프로필 메뉴의 라디오(`PresenceStatusItems`)와 방해 금지 기한 다이얼로그
// (`PresenceDndDialog`)가 **같은 쓰기**를 쓰도록 한 훅으로 모았다. 둘이 낙관 갱신을 따로
// 가지면 한쪽만 `dndUntilMs` 를 알게 된다.
//
// ## 알림 규칙도 함께 다시 읽는다
//
// 서버는 방해 금지를 고르면 같은 트랜잭션에서 알림 일시 중지를 켜고, 방해 금지에서
// 나오면 켜기 전 값으로 되돌린다(ADR-0124 증보 2 D8). 클라이언트는 규칙을 따로 쓰지
// 않는다 — 쓰면 묶음이 끊긴다. 대신 규칙 질의를 **무효화**해 설정 › 알림의 스위치가
// 실제 값을 그리게 한다. 성공과 실패 모두 뒤에 한다: 실패해도 서버가 어디까지 적용했는지
// 이쪽은 모른다.
// =============================================================================

/** 낙관 갱신: 명부의 내 행에 방금 쓴 선언 상태와 기한을 칠한다. */
function paintPresence(row: RosterMember, write: PresenceWrite): RosterMember {
  const next: RosterMember = { ...row, presenceStatus: write.status };
  if (write.status !== "dnd" || write.dndUntilMs === null) {
    // 방해 금지가 아니면 기한도 없다. `null` 은 기한 없음이다.
    delete next.dndUntilMs;
  } else if (write.dndUntilMs !== undefined) {
    next.dndUntilMs = write.dndUntilMs;
  }
  return next;
}

export function useSelfPresenceWrite(workspaceId: string, selfMemberId: string) {
  const client = useQueryClient();
  const rosterKey = ["roster", workspaceId];
  return useMutation({
    mutationFn: (write: PresenceWrite) => setPresenceStatus(workspaceId, write),
    onMutate: async (write) => {
      // Optimistic: paint the new status onto the roster cache the profile row
      // and every member surface read from, then reconcile with the server.
      await client.cancelQueries({ queryKey: rosterKey });
      const previous = client.getQueryData<RosterMember[]>(rosterKey);
      client.setQueryData<RosterMember[]>(rosterKey, (rows) =>
        rows?.map((row) =>
          uuidEq(row.id, selfMemberId) ? paintPresence(row, write) : row
        )
      );
      return { previous };
    },
    onError: (_error, _write, context) => {
      if (context?.previous) {
        client.setQueryData(rosterKey, context.previous);
      }
    },
    onSuccess: () => {
      // The server broadcast is the truth co-members see; re-read so this device
      // matches it (and any change made on another device). PUT is the durable
      // ③ write (REST→PG→outbox→relay); availability ② is not this request.
      void client.invalidateQueries({ queryKey: rosterKey });
    },
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: notificationRulesQueryKey(workspaceId),
      });
    },
  });
}
