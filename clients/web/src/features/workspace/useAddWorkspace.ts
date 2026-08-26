import { createContext, useContext } from "react";
import type { DialogFocusTarget } from "@/design/ui/dialog";

// =============================================================================
// 워크스페이스 추가 진입점 (검수 피드백 #4a-2).
//
// The rail's [+] used to be a <Link to="/settings">: it did not add a
// workspace, it left the rail entirely for a settings page that happens to
// carry the create form. That is the same dead end 채널 만들기 had before
// MOMO-614, and the repair is the same shape — one dialog owned by the shell,
// opened from the action's own seat. This is the verb half of that: the rail
// (and any future entry point) reads the opener from context instead of
// routing away.
//
// Splitting the opener from the open-state is the CreateChannel lesson kept:
// the rail only needs the verb, and it should not re-render every time the
// dialog opens or closes.
// =============================================================================

export type OpenAddWorkspace = (opener?: DialogFocusTarget | null) => void;

export const AddWorkspaceOpenContext = createContext<OpenAddWorkspace | null>(
  null
);

export function useOpenAddWorkspace(): OpenAddWorkspace {
  const open = useContext(AddWorkspaceOpenContext);
  if (!open) {
    throw new Error(
      "useOpenAddWorkspace must be used inside AddWorkspaceProvider"
    );
  }
  return open;
}

/**
 * Is the 워크스페이스 추가 dialog open. The shell's window-level shortcuts (⌘K,
 * ⌘⇧A) fire even over a Radix modal because they listen on `window`, so they
 * read this and step back — the same guard 채널 만들기 and 에이전트 프로필
 * already carry (R2 M4). A separate context from the opener so the entry points
 * that only need the verb do not re-render on every open and close.
 */
export const AddWorkspaceOpenStateContext = createContext(false);

export function useAddWorkspaceOpen(): boolean {
  return useContext(AddWorkspaceOpenStateContext);
}
