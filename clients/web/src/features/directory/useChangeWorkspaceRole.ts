import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  changeWorkspaceMemberRole,
  type MembershipRole,
  type RosterMember,
} from "@momo/core/lib/api";
import { changeWorkspaceRoleErrorMessage } from "@momo/core/features/directory/model";
import { useSession } from "@/app/session";

export interface ChangeWorkspaceRoleHandle {
  pending: boolean;
  error: string | null;
  apply: (member: RosterMember, role: MembershipRole) => Promise<boolean>;
  /** 지난 실패 문장을 지운다: 확인 단계를 새로 열거나 취소할 때 앞 시도의 오류가 남지 않게(#5780). */
  clearError: () => void;
}

export function useChangeWorkspaceRole(): ChangeWorkspaceRoleHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (member: RosterMember, role: MembershipRole): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        await changeWorkspaceMemberRole(workspaceId, member.id, role);
        await client.invalidateQueries({ queryKey: ["roster", workspaceId] });
        return true;
      } catch (failure) {
        setError(changeWorkspaceRoleErrorMessage(failure));
        return false;
      } finally {
        setPending(false);
      }
    },
    [workspaceId, client]
  );

  const clearError = useCallback(() => setError(null), []);

  return { pending, error, apply, clearError };
}
