import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateChannelOpen } from "@/features/channels/useCreateChannel";
import { useAgentProfileOpen } from "@/features/routing/useAgentProfile";
import { useAddWorkspaceOpen } from "@/features/workspace/useAddWorkspace";

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
  // 폼 다이얼로그는 셋이다(채널 만들기, 에이전트 프로필, 워크스페이스 추가).
  // 하나라도 떠 있으면 전역 단축키는 물러선다. 세 훅을 먼저 각각 부르고 나서
  // 합치는 이유는 ||가 단축 평가라서, 붙여 쓰면 첫 값이 참인 렌더에서 뒤의 훅이
  // 호출되지 않아 훅 순서가 깨지기 때문이다.
  const createChannelOpen = useCreateChannelOpen();
  const agentProfileOpen = useAgentProfileOpen();
  const addWorkspaceOpen = useAddWorkspaceOpen();
  const formDialogOpen =
    createChannelOpen || agentProfileOpen || addWorkspaceOpen;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (formDialogOpen) return;
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== "a") return;
      event.preventDefault();
      navigate("/inbox");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, formDialogOpen]);
  return null;
}
