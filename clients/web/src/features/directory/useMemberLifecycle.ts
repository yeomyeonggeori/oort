import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  reinstateWorkspaceMember,
  removeWorkspaceMember,
  suspendWorkspaceMember,
  uuidEq,
  type RosterMember,
  type WorkspaceMemberLifecycle,
} from "@momo/core/lib/api";
import {
  memberLifecycleFailure,
  type MemberLifecycleAction,
  type MemberLifecycleFailure,
} from "@momo/core/features/directory/model";
import { useSession } from "@/app/session";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";

// =============================================================================
// 멤버 정지·정지 풀기·내보내기 (#5781). `useChangeWorkspaceRole` 과 같은 모양: 요청 하나, 진행 중 표시, 실패는 그
// 자리에서 말할 **종류**(문장은 부르는 쪽이 사전으로). 성공하면 명부를 다시 읽는다.
//
// 소유자·관리자의 명부는 정지된 사람도 `status: "suspended"` 로 싣는다(#5814). 그래서 정지·풀기가 성공하면 서버가 적은
// 새 상태를 **명부 캐시에 바로 써 넣고**(멤버 탭과 프로필 창이 같은 값을 본다, 다시 읽기 전에 옛 상태가 한 번 서지 않는다)
// 다시 읽는다. 내보낸 사람은 명부 캐시에서 바로 뺀다(멤버 탭의 줄이 창을 닫기 전에 사라져, 닫을 때 초점이 이웃 줄로 간다):
// 결과는 `onApplied` 로 넘겨 창이 결과 화면으로 붙든다.
//
// 상태·대상이 어긋났다는 거절(그사이 정지됨·풀림·지워짐·서열이 바뀜)도 명부를 다시 읽는다(#5781 검수 r1 M2): 문장이
// 「그사이 바뀌었어요」라고 말하는데 창이 옛 상태로 남아 같은 단추를 다시 누르게 하지 않는다.
// =============================================================================

export interface MemberLifecycleHandle {
  pending: boolean;
  failure: MemberLifecycleFailure | null;
  /**
   * 성공하면 `onApplied`(명부 캐시를 고친 뒤, 다시 읽기 전)를 부르고 `true`, 실패하면 `failure` 를 세우고 `false`.
   */
  run: (
    member: RosterMember,
    action: MemberLifecycleAction,
    onApplied: (result: WorkspaceMemberLifecycle) => void
  ) => Promise<boolean>;
  clearError: () => void;
}

/** 명부가 옛 상태라서 생긴 거절: 다시 읽으면 화면이 서버의 지금을 보인다. */
const STALE_FAILURES: ReadonlySet<MemberLifecycleFailure> = new Set(["notActive", "notSuspended", "notFound", "rank", "forbidden"]);

/**
 * 결과를 명부 줄에 옮긴다. 정지된 줄에는 서버가 접속 여부(`online`)를 싣지 않는다(#5814) — 캐시도 같은 모양으로. 내보낸
 * 사람은 서버 명부에 누구에게도 없다: 줄을 뺀다.
 */
function withLifecycleResult(members: RosterMember[] | undefined, memberId: string, status: RosterMember["status"]) {
  if (members === undefined) return undefined;
  if (status === "deleted") return members.filter((m) => !uuidEq(m.id, memberId));
  return members.map((m) => {
    if (!uuidEq(m.id, memberId)) return m;
    const next: RosterMember = { ...m, status };
    if (status !== "active") delete next.online;
    return next;
  });
}

const CALLS = {
  suspend: suspendWorkspaceMember,
  reinstate: reinstateWorkspaceMember,
  remove: removeWorkspaceMember,
} as const satisfies Record<MemberLifecycleAction, (ws: string, id: string) => Promise<WorkspaceMemberLifecycle>>;

export function useMemberLifecycle(): MemberLifecycleHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<MemberLifecycleFailure | null>(null);

  const run = useCallback(
    async (
      member: RosterMember,
      action: MemberLifecycleAction,
      onApplied: (result: WorkspaceMemberLifecycle) => void
    ): Promise<boolean> => {
      const key = rosterQueryKey(workspaceId);
      setPending(true);
      setFailure(null);
      let result: WorkspaceMemberLifecycle;
      try {
        result = await CALLS[action](workspaceId, member.id);
      } catch (error) {
        const kind = memberLifecycleFailure(error);
        setFailure(kind);
        setPending(false);
        if (STALE_FAILURES.has(kind)) void client.invalidateQueries({ queryKey: key });
        return false;
      }
      // 도는 중인 명부 읽기(30초 주기)가 요청 전의 상태를 싣고 늦게 와서 새 값을 덮지 않게 먼저 거둔다.
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<RosterMember[]>(key, (prev) => withLifecycleResult(prev, member.id, action === "remove" ? "deleted" : result.status));
      onApplied(result);
      setPending(false);
      // 다시 읽기를 기다리지 않는다: 결과는 이미 손에 있고, 명부 실패가 성공한 정지를 실패처럼 보이게 하면 안 된다.
      void client.invalidateQueries({ queryKey: key });
      return true;
    },
    [workspaceId, client]
  );

  const clearError = useCallback(() => setFailure(null), []);

  return { pending, failure, run, clearError };
}
