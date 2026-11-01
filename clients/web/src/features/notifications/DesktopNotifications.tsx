import { missingMemberLabel } from "@momo/core/features/workspace/directory";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/app/session";
import { isDesktop } from "@/lib/tauri";
import type { MessageNewEvent } from "@/lib/realtime";
import { uuidEq } from "@momo/core/lib/api";
import {
  useChannels,
  useDirectory,
  memberFor,
} from "@/features/workspace/useWorkspace";
import { actorToken } from "@momo/core/features/inbox/model";
import {
  armOpen,
  openTarget,
  rememberAnnounced,
  windowIsFront,
  type ArmedOpen,
} from "@momo/core/features/notifications/model";
import { notifyThisDevice } from "./deviceNotify";
import { osNotifier, type OsNotifyKind } from "./osNotifier";
import { setBrowserOpenHandler, useBrowserPermission } from "./browserNotify";
import { useServerPause } from "./useServerPause";
import { requestNotificationTarget } from "./requestNotificationTarget";
import { followingKnown, resolveFollowing } from "./threadFollowStore";
import { isThreadViewed } from "./viewedThread";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// Desktop notification rail (MOMO-607, ADR-0133 P2) — the trigger MOMO-603 left
// as a seam ("wiring which events notify is the web layer's job").
//
// Renders nothing. It watches the realtime rail for the events addressed to a
// person (mention, pending approval, a DM, and — #4890 — a new reply in a thread
// the server says this member follows; there is no ordinary-channel kind), asks
// `deviceNotify` whether one is worth an interruption, and hands the survivors
// to the shell bridge. Device kind toggles live in
// `preference.ts`; every other rule lives in the core model. This file is the
// impure half — subscriptions, window focus, and the OS call.
//
// In a browser it does nothing until the person opted in (a click in settings
// that ended in a granted Notification permission, #3340). Before that: no
// banner and no extra Centrifugo subscription, so a tab pays nothing for it.
// After: the same rules, defaults and grouping as the shell; "in front" means
// the tab is visible AND focused, and a banner click focuses the tab and routes.
//
// 따라가는 스레드의 답글(#4890)은 **서버가 말한 값**으로만 판정한다. 이 기기가 아는 것은 `threadFollowStore` 가 적은 서버의
// 답뿐이고(스레드 열기·따라가기 응답), 모르는 스레드는 그 스레드 하나를 서버에 물은 뒤 다시 판정한다(`follow-unknown`).
// 물음은 다른 이유(내 글·음소거·꺼 둔 종류·보는 중)로 걸러질 글에는 나가지 않는다. 누르면 그 답글이 있는 스레드가 열린다.
//
// While the member's 알림 일시 중지 is on, none of it becomes a banner (#4197):
// the phone push is stopped by the server for the same rule, so this device
// reads the server's answer (`useServerPause`) instead of deciding alone.
// =============================================================================

/**
 * How many channels the rail will watch for mentions.
 *
 * Each one is a Centrifugo subscription, so this is a real cost and not a
 * formality. A member of more channels than this still gets notified for the
 * ones the sidebar lists first and, for everything else, the inbox is the
 * complete record — a bounded rail is better than an unbounded socket count.
 */
const WATCH_CAP = 30;

export function DesktopNotifications() {
  const { session, workspaceId, realtime } = useSession();
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const navigate = useNavigate();
  const location = useLocation();
  const selfId = session.member.id;
  const formatMessage = useFormatMessage();
  const formatRef = useRef(formatMessage);
  formatRef.current = formatMessage;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const desktop = isDesktop();
  const browserPermission = useBrowserPermission();
  // 데스크탑 셸이거나, 사람이 켜고 브라우저가 허락한 탭만 알릴 수 있다.
  const canNotify = desktop || browserPermission === "granted";
  // 서버의 알림 일시 중지를 읽어 배너 판정(`notifyThisDevice`)과 로컬 칸 알림이 함께 본다(#4197).
  useServerPause(workspaceId, canNotify);

  const focusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus()
  );
  const announcedRef = useRef<string[]>([]);
  const armedRef = useRef<ArmedOpen | null>(null);
  const armedThreadRef = useRef<{ messageId: string; rootId: string } | null>(null);

  const channels = useMemo(
    () => [...groups.channels, ...groups.dms],
    [groups]
  );

  // Muted channels are not watched at all — the server already decided nobody
  // wants to hear about them, so subscribing would be paying for silence. The
  // model still checks `isMuted` because the mute can change mid-session while
  // the subscription is up.
  const watched = useMemo(
    () =>
      channels
        .filter((channel) => !channel.muted)
        .slice(0, WATCH_CAP)
        .map((channel) => channel.id)
        .join(","),
    [channels]
  );

  // Everything the decision needs that changes on render, read through a ref so
  // the message handler below can stay stable — rebuilding it would tear down
  // and re-establish every subscription on each roster refetch.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const contextRef = useRef({ channels, directory, selfId, workspaceId });
  contextRef.current = { channels, directory, selfId, workspaceId };

  const canNotifyRef = useRef(canNotify);
  canNotifyRef.current = canNotify;

  const handle = useCallback(function handleEvent(event: MessageNewEvent, answered = false): void {
    const current = contextRef.current;
    const nowMs = Date.now();
    const decision = notifyThisDevice(event, {
      isDesktop: canNotifyRef.current,
      windowFocused: isDesktop()
        ? focusedRef.current
        : windowIsFront(document.visibilityState, document.hasFocus()),
      // 창이 앞이어도 대상 채널이 화면에 없으면 알린다(#3339).
      isTargetVisible: (channelId) => {
        // 경로의 id와 이벤트의 id는 대소문자가 다를 수 있다: uuidEq로 비교한다.
        const routeId = /^\/c\/([^/]+)/.exec(pathnameRef.current)?.[1];
        return routeId !== undefined && uuidEq(routeId, channelId);
      },
      isDirect: (channelId) =>
        current.channels.some(
          (channel) => uuidEq(channel.id, channelId) && channel.kind === "dm"
        ),
      selfMemberId: current.selfId,
      isMuted: (channelId) =>
        current.channels.some(
          (channel) => uuidEq(channel.id, channelId) && channel.muted
        ),
      isAnnounced: (messageId) => announcedRef.current.includes(messageId),
      // 따라가는 스레드는 서버가 말한 값만 믿는다(#4890). 그 스레드 패널이 열려 있고 창이 앞이면 본 것이다.
      isFollowingThread: (rootId) => followingKnown(current.workspaceId, rootId, nowMs),
      isThreadVisible: (rootId) => isThreadViewed(rootId),
      actorFor: (memberId) => {
        const member = memberFor(current.directory, memberId);
        if (!member) return missingMemberLabel(current.directory);
        return actorToken({
          name: member.displayName,
          handle: member.kind === "agent" ? member.handle : undefined,
          isAgent: member.kind === "agent",
        });
      },
      nowMs,
    });
    if (!decision.show) {
      // 알릴 만한 스레드 답글인데 따라가는지 서버가 아직 말하지 않았다: 그 스레드 하나를 묻고 한 번만 다시 판정한다.
      // 되풀이하지 않는 것이 요청 폭주를 막는다(`answered`). 그 사이 창·워크스페이스가 바뀌었으면 접는다.
      const rootId = event.payload.root_id;
      if (decision.skip === "follow-unknown" && !answered && typeof rootId === "string") {
        const askedIn = current.workspaceId;
        void resolveFollowing(askedIn, event.payload.channel_id, rootId).then(() => {
          if (aliveRef.current && contextRef.current.workspaceId === askedIn) handleEvent(event, true);
        });
      }
      return;
    }
    const { messageId, channelId, body } = decision.notification;
    const approval = decision.notification.kind === "approval";
    const threadReply = decision.notification.kind === "thread-reply";
    const title = approval ? memberFor(current.directory, event.payload.author_member_id)?.displayName ?? decision.notification.title : decision.notification.title;
    announcedRef.current = rememberAnnounced(announcedRef.current, messageId);
    // 데스크탑은 알림을 눌러 창이 앞에 오는 순간 이동한다(arm). 브라우저는 배너 클릭이 직접 간다.
    if (isDesktop()) {
      armedRef.current = armOpen(
        armedRef.current,
        channelId,
        nowMs,
        undefined,
        // 승인 알림은 그 카드로 착지한다(#3738). 스레드 답글은 그 답글로(#4890): 아래에서 스레드를 연다. 멘션·DM은 채널이다.
        approval || threadReply ? messageId : undefined
      );
      armedThreadRef.current = armedRef.current.messageId && event.payload.root_id
        ? { messageId: armedRef.current.messageId, rootId: event.payload.root_id } : null;
    }
    // 같은 종류는 한 묶음으로 쌓아 보낸다(osNotifier). 보내기는 fire and forget:
    // 브라우저나 거절된 권한은 false로 끝나는 정상 상태다.
    const kindMap: Record<typeof decision.notification.kind, OsNotifyKind> = {
      approval: "approval",
      mention: "mention",
      dm: "dm",
      "thread-reply": "thread-reply",
    };
    osNotifier().offer({
      kind: kindMap[decision.notification.kind],
      title,
      ...(body === undefined ? {} : { body }),
      label: title.replace(/^승인 필요 · /, ""),
      // 승인 알림은 채널 맨 아래가 아니라 **그 카드**로 연다(#3738): 놓친 카드를 찾느라
      // 위로 스크롤하다 만료를 맞이하지 않게. 스레드 답글은 그 스레드를 열고 그 답글로 간다(#4890).
      // 멘션·DM은 지금까지처럼 채널이다.
      route:
        approval || threadReply
          ? requestNotificationTarget(channelId, messageId, event.payload.root_id)
          : `/c/${channelId}`,
      ...(threadReply
        ? { summaryTitle: (count: number) => formatRef.current("desktop.notify.threadSummary", { count }) }
        : {}),
    });
  }, []);

  // ---- the rail -----------------------------------------------------------

  useEffect(() => {
    if (!canNotify || !realtime || watched === "") return;
    const stops = watched
      .split(",")
      .map((channelId) =>
        realtime.subscribeChannel(workspaceId, channelId, {
          onSubscribed: () => {},
          onMessage: (event) => handle(event),
        })
      );
    return () => {
      for (const stop of stops) stop();
    };
  }, [canNotify, realtime, workspaceId, watched, handle]);

  // 브라우저 배너를 누르면 이 탭이 앞에 오고 대상으로 간다.
  useEffect(() => {
    if (desktop) return;
    setBrowserOpenHandler((route) => navigate(route));
    return () => setBrowserOpenHandler(null);
  }, [desktop, navigate]);

  // ---- window focus -------------------------------------------------------

  useEffect(() => {
    if (!isDesktop()) return;
    const land = () => {
      focusedRef.current = true;
      let route = openTarget(armedRef.current, Date.now());
      const thread = armedThreadRef.current;
      if (route !== null && thread && armedRef.current?.channelId && armedRef.current.messageId === thread.messageId) {
        route = requestNotificationTarget(armedRef.current.channelId, thread.messageId, thread.rootId);
      }
      armedRef.current = null;
      armedThreadRef.current = null;
      if (route !== null) navigate(route);
    };
    const leave = () => {
      focusedRef.current = false;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("focus", land);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", land);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [navigate]);

  // Someone who navigated on their own has answered the question the armed
  // target was there to answer; a later focus must not move them again.
  useEffect(() => {
    armedRef.current = null;
    armedThreadRef.current = null;
  }, [location.key]);

  return null;
}
