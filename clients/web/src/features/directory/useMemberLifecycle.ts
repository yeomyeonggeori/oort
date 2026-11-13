import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  reinstateWorkspaceMember,
  removeWorkspaceMember,
  suspendWorkspaceMember,
  type RosterMember,
  type WorkspaceMemberLifecycle,
} from "@momo/core/lib/api";
import {
  memberLifecycleFailure,
  type MemberLifecycleAction,
  type MemberLifecycleFailure,
} from "@momo/core/features/directory/model";
import { useSession } from "@/app/session";

// =============================================================================
// 멤버 정지·정지 풀기·내보내기 (#5781). `useChangeWorkspaceRole` 과 같은 모양: 요청 하나, 진행 중 표시, 실패는 그
// 자리에서 말할 **종류**(문장은 부르는 쪽이 사전으로). 성공하면 명부를 다시 읽는다.
//
// 서버 명부는 활성 멤버만 돌려준다(`list_workspace_roster` 의 `m.status = 'active'`): 정지하거나 내보낸 멤버는 다시 읽은
// 명부에서 빠진다. 그래서 성공 결과(서버가 적은 새 상태)를 `onApplied` 로 **명부를 다시 읽기 전에** 넘기고, 프로필 창이 그
// 값으로 창이 열린 동안 그 사람을 붙든다(다시 읽은 명부가 먼저 오면 한 번 그리는 동안 창이 「명부에 없음」으로 떨어진다).
// =============================================================================

export interface MemberLifecycleHandle {
  pending: boolean;
  failure: MemberLifecycleFailure | null;
  /** 성공하면 `onApplied`(명부를 다시 읽기 전)를 부르고 `true`, 실패하면 `failure` 를 세우고 `false`. */
  run: (
    member: RosterMember,
    action: MemberLifecycleAction,
    onApplied: (result: WorkspaceMemberLifecycle) => void
  ) => Promise<boolean>;
  clearError: () => void;
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
      setPending(true);
      setFailure(null);
      let result: WorkspaceMemberLifecycle;
      try {
        result = await CALLS[action](workspaceId, member.id);
      } catch (error) {
        setFailure(memberLifecycleFailure(error));
        setPending(false);
        return false;
      }
      onApplied(result);
      setPending(false);
      // 다시 읽기를 기다리지 않는다: 결과는 이미 손에 있고, 명부 실패가 성공한 정지를 실패처럼 보이게 하면 안 된다.
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
      return true;
    },
    [workspaceId, client]
  );

  const clearError = useCallback(() => setFailure(null), []);

  return { pending, failure, run, clearError };
}
