import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateChannelOpen } from "@/features/channels/useCreateChannel";
import { useAddChannelMemberOpen } from "@/features/channels/useAddChannelMember";
import { useAgentProfileOpen } from "@/features/routing/useAgentProfile";
import { useAddWorkspaceOpen } from "@/features/workspace/useAddWorkspace";
import { OPEN_INBOX_SHORTCUT } from "@/app/keyboardShortcuts";

/**
 * ⌘⇧A opens the inbox from anywhere (R-1 §2 키보드 경로). It lives in the shell
 * rather than in the route because a shortcut that only works once you are
 * already there is not a shortcut. Renders nothing.
 *
 * "Anywhere" stops at a modal. A form dialog is the app's only conversation
 * partner while it is open, so navigating out from under it would leave the
 * form standing on a route it has nothing to do with. Same defect the palette
 * had with ⌘K (R2 M4), same guard.
 */
export function InboxHotkeys() {
  const navigate = useNavigate();
  // 폼 다이얼로그는 넷이다(채널 만들기, 채널 멤버 추가, 에이전트 프로필,
  // 워크스페이스 추가). 하나라도 떠 있으면 전역 단축키는 물러선다. 네 훅을 먼저
  // 각각 부르고 나서 합치는 이유는 ||가 단축 평가라서, 붙여 쓰면 첫 값이 참인
  // 렌더에서 뒤의 훅이 호출되지 않아 훅 순서가 깨지기 때문이다.
  const createChannelOpen = useCreateChannelOpen();
  const addMemberOpen = useAddChannelMemberOpen();
  const agentProfileOpen = useAgentProfileOpen();
  const addWorkspaceOpen = useAddWorkspaceOpen();
  const formDialogOpen =
    createChannelOpen || addMemberOpen || agentProfileOpen || addWorkspaceOpen;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (formDialogOpen) return;
      if (!OPEN_INBOX_SHORTCUT.matches(event)) return;
      event.preventDefault();
      navigate("/inbox");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, formDialogOpen]);
  return null;
}
