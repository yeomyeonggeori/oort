import { createContext, useContext } from "react";

export type OpenMemberProfile = (
  memberId: string,
  opener?: HTMLElement | null
) => void;

export const OpenMemberProfileContext =
  createContext<OpenMemberProfile | null>(null);

/** Opens the one shared human/agent identity card owned by AppShell. */
export function useOpenMemberProfile(): OpenMemberProfile {
  const open = useContext(OpenMemberProfileContext);
  if (!open) {
    throw new Error(
      "useOpenMemberProfile must be used inside MemberProfileProvider"
    );
  }
  return open;
}
