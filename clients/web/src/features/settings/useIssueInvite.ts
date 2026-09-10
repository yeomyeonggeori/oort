import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createInvite,
  type CreatedInvite,
  type InviteInput,
} from "@momo/core/features/settings/api";

// =============================================================================
// Shared invite issue mutation (#2333).
//
// Settings `InviteSection` and onboarding S2 both POST the same
// `/v1/workspaces/{ws}/invites` route. The raw code arrives once; this hook
// holds it in component state so callers can render it and never log it.
// =============================================================================

export function useIssueInvite(workspaceId: string) {
  const client = useQueryClient();
  const [issued, setIssued] = useState<CreatedInvite | null>(null);
  const issuedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (issued && issuedRef.current) {
      issuedRef.current.focus({ preventScroll: true });
      issuedRef.current.scrollIntoView?.({ block: "nearest" });
    }
  }, [issued]);

  const create = useMutation({
    mutationFn: (input: InviteInput) => createInvite(workspaceId, input),
    onSuccess: (result) => {
      setIssued(result);
      void client.invalidateQueries({
        queryKey: ["settings", "invites", workspaceId],
      });
    },
  });

  const clearIssued = () => setIssued(null);

  return { issued, issuedRef, create, clearIssued };
}
