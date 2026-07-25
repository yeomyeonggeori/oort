import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateChannelOpen } from "@/features/channels/useCreateChannel";

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
  const formDialogOpen = useCreateChannelOpen();
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
