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
  retry: () => Promise<boolean>;
}

export function useChangeWorkspaceRole(): ChangeWorkspaceRoleHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<{
    member: RosterMember;
    role: MembershipRole;
  } | null>(null);

  const apply = useCallback(
    async (member: RosterMember, role: MembershipRole): Promise<boolean> => {
      setPending(true);
      setError(null);
      setLastAttempt({ member, role });
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

  const retry = useCallback(async (): Promise<boolean> => {
    if (lastAttempt === null) return false;
    return apply(lastAttempt.member, lastAttempt.role);
  }, [apply, lastAttempt]);

  return { pending, error, apply, retry };
}
