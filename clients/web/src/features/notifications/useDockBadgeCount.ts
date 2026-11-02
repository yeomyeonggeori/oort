import { useSession } from "@/app/session";
import { useNeedsMeCount } from "@/features/inbox/useNeedsMe";
import { useChannels, useReadStates } from "@/features/workspace/useWorkspace";
import { unreadFor } from "@momo/core/features/workspace/directory";
import { dockBadgeCount } from "./dockBadgeCount";
import { useDesktopNotificationKinds } from "./preference";

/**
 * 독 배지가 그리는 수(#3339). 독 배지(`DockBadge`)와 메뉴 막대 아이콘의 점(`TrayStatus`, #5193)이 같은 수를
 * 보도록 이 훅 하나에서 계산한다. 수는 `useNeedsMeCount` 하나에서 오고(레일·인박스 배지와 같은 값), 여기서는
 * 「독 배지」 스위치와 「안 읽은 DM도 합산」 옵션만 얹는다(`dockBadgeCount`).
 */
export function useDockBadgeCount(): number {
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
  return dockBadgeCount(needsMe, prefs, unreadDms);
}
