import { useLocation } from "react-router-dom";
import { useSession } from "@/app/session";
import { useDocumentForeground } from "@/features/chat/useChannelViewingBeat";
import { useNeedsMeCount } from "@/features/inbox/useNeedsMe";
import { useChannels, useReadStates } from "@/features/workspace/useWorkspace";
import { unreadFor } from "@momo/core/features/workspace/directory";
import { dmUnreadForBadge, followedRepliesForBadge } from "@momo/core/features/notifications/model";
import { dockBadgeCount } from "./dockBadgeCount";
import { useDesktopNotificationKinds } from "./preference";
import { useViewedThreadChannelId } from "./viewedThread";

/** 주소가 가리키는 대화(`/c/:id`). 대화 화면이 아니면 null. */
function routeChannelId(pathname: string): string | null {
  return /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/**
 * 독 배지가 그리는 수(#3339). 독 배지(`DockBadge`)와 메뉴 막대 아이콘의 점(`TrayStatus`, #5193)이 같은 수를
 * 보도록 이 훅 하나에서 계산한다. 수는 `useNeedsMeCount` 하나에서 오고(레일·인박스 배지와 같은 값), 여기서는
 * 「독 배지」 스위치와 DM 몫만 얹는다(`dockBadgeCount`).
 *
 * DM 몫(#5660, owner 11-11 「켜줘」): 안 읽은 DM의 수를 코어 `dmUnreadForBadge`가 낸다. 서버 읽음 투영 그대로이고, 다른 몫과 같이
 * 채널 알림 끄기·알림 일시 중지와 무관하다(ADR-0124 D2·D4-A). 거르는 것은 지금 앞에서 보고 있는 대화와 멘션과의 겹침뿐이다.
 *
 * 따라가는 스레드의 답글 몫(#5660, 같은 owner 결정): 코어 `followedRepliesForBadge`가 서버 읽음 투영의 채널 줄 값(#5667)으로 낸다. 규칙은 DM
 * 몫과 같고, 거르는 것은 앞에 있는 창이 지금 열어 둔 스레드의 채널과 멘션과의 겹침이다. 그 값이 없는 옛 서버에서는 0이다.
 */
export function useDockBadgeCount(): number {
  const { workspaceId } = useSession();
  const needsMe = useNeedsMeCount();
  const prefs = useDesktopNotificationKinds();
  const { groups } = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  const { pathname } = useLocation();
  const foreground = useDocumentForeground();
  const viewedThreadChannelId = useViewedThreadChannelId();
  const readState = (id: string) => unreadFor(readStates.byChannel, id) ?? undefined;
  const unreadDms = prefs.dockDms
    ? dmUnreadForBadge({
        dms: groups.dms,
        readState,
        viewingChannelId: foreground ? routeChannelId(pathname) : null,
      })
    : 0;
  const followedReplies = followedRepliesForBadge({
    channels: groups.channels,
    readState,
    viewingThreadChannelId: foreground ? viewedThreadChannelId : null,
  });
  return dockBadgeCount(needsMe, prefs, unreadDms, followedReplies);
}
