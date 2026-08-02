import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { openDirectMessage, type Channel, type RosterMember } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { openDmErrorMessage, upsertChannel } from "@momo/core/features/directory/model";

// =============================================================================
// DM 시작 (parity G-4). One place opens a DM, so the directory row and the ⌘K
// people section cannot drift apart.
//
// The server is the authority on which channel this is. POST /dms is idempotent
// per participant pair: it creates the channel on the first call and returns the
// existing one afterwards, in both cases naming the channel id. So this never
// searches the local channel list for "the DM with this person" — it navigates
// to the id the server answered with, and puts that channel into the cache so
// the sidebar shows it on the way there instead of one refetch later.
// =============================================================================

export interface OpenDmFailure {
  /** Which row failed, so the message can be shown next to that member. */
  memberId: string;
  message: string;
}

export interface OpenDmHandle {
  /** Member whose DM is being opened right now, if any. */
  pendingMemberId: string | null;
  error: OpenDmFailure | null;
  /** Resolves true when the DM was opened and the route changed. */
  openDm: (member: RosterMember) => Promise<boolean>;
  /**
   * Drop the banner because the surface that was showing it is going away.
   * For a route that is the surface, unmounting does this for free; for the ⌘K
   * palette, which stays mounted between openings, closing it is the moment.
   */
  clearError: () => void;
}

export function useOpenDm(): OpenDmHandle {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [error, setError] = useState<OpenDmFailure | null>(null);

  const openDm = useCallback(
    async (member: RosterMember): Promise<boolean> => {
      setPendingMemberId(member.id);
      setError(null);
      try {
        const opened = await openDirectMessage(workspaceId, member.id);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, opened.channel) : [opened.channel]
        );
        // Refetch anyway: the POST answers about one channel, and a DM that was
        // created while this tab was open changes read-state and ordering too.
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        navigate(`/c/${opened.channel.id}`);
        return true;
      } catch (failure) {
        setError({
          memberId: member.id,
          message: openDmErrorMessage(failure, member.displayName),
        });
        return false;
      } finally {
        setPendingMemberId(null);
      }
    },
    [workspaceId, client, navigate]
  );

  const clearError = useCallback(() => setError(null), []);

  // No dismiss button on purpose: an error a person can wave away without
  // acting on it is decoration. It goes away when the next attempt starts or
  // when the surface holding it closes — never on its own, never on a timer.
  return { pendingMemberId, error, openDm, clearError };
}
