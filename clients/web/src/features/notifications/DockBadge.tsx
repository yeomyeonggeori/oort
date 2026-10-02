import { useEffect } from "react";
import { useSession } from "@/app/session";
import { useNeedsMeCount } from "@/features/inbox/useNeedsMe";
import { useChannels, useReadStates } from "@/features/workspace/useWorkspace";
import { unreadFor } from "@momo/core/features/workspace/directory";
import { isDesktop, setDockBadge } from "@/lib/tauri";
import { dockBadgeCount } from "./dockBadgeCount";
import { useDesktopNotificationKinds } from "./preference";

/**
 * 독 배지를 그린다 (#3339). 아무것도 렌더하지 않는다. 데스크탑 밖에서는 효과도 없다.
 * 수는 `useNeedsMeCount` 하나에서 온다(레일·인박스 배지와 같은 값).
 */
export function DockBadge() {
  const { workspaceId } = useSession();
  const needsMe = useNeedsMeCount();
  const prefs = useDesktopNotificationKinds();
  const { groups } = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  // DM 합산은 옵션이 켜졌을 때만 센다(기본 끔).
  const unreadDms = prefs.dockDm
    ? groups.dms.reduce(
        (sum, dm) => sum + (unreadFor(readStates.byChannel, dm.id)?.unreadCount ?? 0),
        0
      )
    : 0;
  const count = dockBadgeCount(needsMe, prefs, unreadDms);

  useEffect(() => {
    if (!isDesktop()) return;
    void setDockBadge(count);
  }, [count]);

  // 앱이 내려갈 때 남은 배지가 거짓이 되지 않게 한다.
  useEffect(
    () => () => {
      if (isDesktop()) void setDockBadge(0);
    },
    []
  );
  return null;
}
