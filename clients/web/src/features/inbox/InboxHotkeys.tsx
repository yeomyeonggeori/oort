import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * ⌘⇧A opens the inbox from anywhere (R-1 §2 키보드 경로). It lives in the shell
 * rather than in the route because a shortcut that only works once you are
 * already there is not a shortcut. Renders nothing.
 */
export function InboxHotkeys() {
  const navigate = useNavigate();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== "a") return;
      event.preventDefault();
      navigate("/inbox");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
  return null;
}
