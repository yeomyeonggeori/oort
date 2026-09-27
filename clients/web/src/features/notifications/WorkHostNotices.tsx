import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { isDesktop, showNotification } from "@/lib/tauri";
import {
  asWorkHostNotice,
  workHostNoticeText,
} from "@momo/core/features/settings/thisMacHost";

// =============================================================================
// ADR-0188 D2 (#2778): 「host 등록 사실은 소유자의 모든 기기에 알린다」.
//
// Renders nothing. Watches the signed-in member's own notice channel
// (`user:work-host#<ME>`), which the server writes in the same transaction as a
// host registration or its first revoke. Every runtime re-reads the host
// registry on a notice; the desktop shell also raises an OS notification, so a
// host added in the owner's name by anyone (a leaked token included) is said
// on the owner's screen, not only in a list they would have to go and read.
// =============================================================================

/** A reconnect replays history; one notice per (host, event) is enough. */
const REMEMBERED = 50;

export function WorkHostNotices() {
  const { session, workspaceId, realtime } = useSession();
  const client = useQueryClient();
  const selfId = session.member.id;
  const seen = useRef<string[]>([]);

  useEffect(() => {
    if (!realtime?.subscribeWorkHostNotices) return;
    return realtime.subscribeWorkHostNotices(selfId, {
      onNotice: (data) => {
        const notice = asWorkHostNotice(data);
        if (!notice) return;
        void client.invalidateQueries({ queryKey: ["settings", "work-hosts"] });
        void client.invalidateQueries({ queryKey: ["work-hosts"] });
        void client.invalidateQueries({ queryKey: ["settings", "this-mac-host"] });
        const key = `${notice.type}:${notice.hostId.toLowerCase()}`;
        if (seen.current.includes(key)) return;
        seen.current = [...seen.current, key].slice(-REMEMBERED);
        if (!isDesktop()) return;
        const { title, body } = workHostNoticeText(notice, selfId);
        void showNotification(title, body);
      },
    });
  }, [realtime, selfId, workspaceId, client]);

  return null;
}
