import { GONE_MEMBER_LABEL } from "@momo/core/features/workspace/directory";
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

// =============================================================================
// Desktop notification rail (MOMO-607, ADR-0133 P2) — the trigger MOMO-603 left
// as a seam ("wiring which events notify is the web layer's job").
//
// Renders nothing. It watches the realtime rail for the two events addressed to
// a person (mention, pending approval — there is no DM/thread/ordinary-channel
// kind), asks `deviceNotify` whether either is worth an interruption, and hands
// the survivors to the shell bridge. Device kind toggles live in
// `preference.ts`; every other rule lives in the core model. This file is the
// impure half — subscriptions, window focus, and the OS call.
//
// In a browser it does nothing until the person opted in (a click in settings
// that ended in a granted Notification permission, #3340). Before that: no
// banner and no extra Centrifugo subscription, so a tab pays nothing for it.
// After: the same rules, defaults and grouping as the shell; "in front" means
// the tab is visible AND focused, and a banner click focuses the tab and routes.
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
  const desktop = isDesktop();
  const browserPermission = useBrowserPermission();
  // 데스크탑 셸이거나, 사람이 켜고 브라우저가 허락한 탭만 알릴 수 있다.
  const canNotify = desktop || browserPermission === "granted";

  const focusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus()
  );
  const announcedRef = useRef<string[]>([]);
  const armedRef = useRef<ArmedOpen | null>(null);

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
  const contextRef = useRef({ channels, directory, selfId });
  contextRef.current = { channels, directory, selfId };

  const canNotifyRef = useRef(canNotify);
  canNotifyRef.current = canNotify;

  const handle = useCallback((event: MessageNewEvent) => {
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
      actorFor: (memberId) => {
        const member = memberFor(current.directory, memberId);
        if (!member) return GONE_MEMBER_LABEL;
        return actorToken({
          name: member.displayName,
          handle: member.kind === "agent" ? member.handle : undefined,
          isAgent: member.kind === "agent",
        });
      },
      nowMs,
    });
    if (!decision.show) return;
    const { messageId, channelId, title, body } = decision.notification;
    announcedRef.current = rememberAnnounced(announcedRef.current, messageId);
    // 데스크탑은 알림을 눌러 창이 앞에 오는 순간 이동한다(arm). 브라우저는 배너 클릭이 직접 간다.
    if (isDesktop()) armedRef.current = armOpen(armedRef.current, channelId, nowMs);
    // 같은 종류는 한 묶음으로 쌓아 보낸다(osNotifier). 보내기는 fire and forget:
    // 브라우저나 거절된 권한은 false로 끝나는 정상 상태다.
    const kindMap: Record<typeof decision.notification.kind, OsNotifyKind> = {
      approval: "approval",
      mention: "mention",
      dm: "dm",
    };
    osNotifier().offer({
      kind: kindMap[decision.notification.kind],
      title,
      ...(body === undefined ? {} : { body }),
      label: title.replace(/^승인 필요 · /, ""),
      route: `/c/${channelId}`,
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
          onMessage: handle,
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
      const route = openTarget(armedRef.current, Date.now());
      armedRef.current = null;
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
  }, [location.key]);

  return null;
}
