import { missingMemberLabel } from "@momo/core/features/workspace/directory";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { isBelowHistoryFloor } from "@momo/core/features/channels/dmLeave";
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { useMessages } from "@/i18n/useMessages";
import { isDesktop, notificationClickSupported, onNotificationClick } from "@/lib/tauri";
import type { MessageNewEvent } from "@/lib/realtime";
import { fetchWorkSessions, uuidEq, type WorkSession } from "@momo/core/lib/api";
import { agentPanePath } from "@momo/core/features/workbench/workTab";
import { workSessionsKey } from "@/features/work/useWorkSessions";
import {
  historyFloorFromCache,
  useChannels,
  useDirectory,
  memberFor,
} from "@/features/workspace/useWorkspace";
import { actorToken } from "@momo/core/features/inbox/model";
import {
  admitThreadBanner,
  armOpen,
  EMPTY_THREAD_BANNER_LEDGER,
  openTarget,
  rememberAnnounced,
  windowIsFront,
  type ArmedOpen,
  type ThreadBannerLedger,
} from "@momo/core/features/notifications/model";
import { notifyThisDevice } from "./deviceNotify";
import { claimBanner, clearBanners, setPlainBannerHandler, type BannerArm } from "./bannerClicks";
import { osNotifier, type OsNotifyKind } from "./osNotifier";
import { setBrowserOpenHandler, useBrowserPermission } from "./browserNotify";
import { useServerPause } from "./useServerPause";
import { requestNotificationTarget } from "./requestNotificationTarget";
import { followingKnown, resolveFollowing } from "./threadFollowStore";
import { isThreadViewed } from "./viewedThread";
import { isAgentSessionViewed } from "./viewedAgentSession";
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
// 같은 스레드의 답글이 한 묶음 배너가 되어도 그 스레드로 가고, 한 스레드의 배너는 분당 상한까지만 뜬다(#5017).
//
// 배너를 눌러 가는 길 (#5059, #4667 후속). 데스크탑 셸이 배너의 클릭을 알려 주면(macOS) 눌린 배너가 곧 이동이다:
// 셸이 배너마다 핸들을 쥐고 있다가 클릭 때만 `momo:notification-click` 을 쏘고, 여기서는 그 페이로드를 **앱이 만든 배너의
// 장부**(`bannerClicks.ts`)와 대조해 장부에 적힌 목적지로 간다. 이 길에서는 「창이 앞에 왔다」를 클릭으로 어림하지 않는다 —
// 배너를 무시하고 20초 안에 돌아와도 이동하지 않는다. 옛 어림(알림이 올 때 목적지를 무장하고 다음 창 포커스에서 소비)은
// 셸이 클릭을 못 알리는 곳에만 남는다: 다른 OS, 클릭 길이 없는 옛 셸, 동시에 기다리는 배너가 한도를 넘어 일반 배너로
// 뜬 것(그 배너의 재료로만 무장한다).
//
// 맥 작업 세션의 권한 요청(#5595, ADR-0188 D5·D8)은 승인 배너다. 데스크탑 셸에서만, 그 세션의 주인에게만(서버 원장이 말한
// 주인: 캐시에 없으면 원장을 한 번 읽고 다시 판정한다). 누르면 승인 카드가 있는 그 세션의 A 칸이 열린다(`agentPanePath`).
// 브라우저 탭에는 허락할 카드가 없어(ADR-0146 D-4) 띄우지 않는다.
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

/** 옛 어림: 알림 하나의 재료를 무장 상태(`armOpen`)에 보탠다. 이벤트 시점 무장과 일반 배너 무장이 같은 규칙을 쓴다. */
function applyArm(
  armedRef: MutableRefObject<ArmedOpen | null>,
  threadRef: MutableRefObject<{ messageId: string; rootId: string } | null>,
  arm: BannerArm,
  nowMs: number
): void {
  armedRef.current = armOpen(armedRef.current, arm.channelId, nowMs, undefined, arm.messageId, arm.threadRoot);
  threadRef.current =
    armedRef.current.messageId && arm.eventRootId
      ? { messageId: armedRef.current.messageId, rootId: arm.eventRootId }
      : null;
}

export function DesktopNotifications() {
  const { session, workspaceId, realtime } = useSession();
  const queryClient = useQueryClient();
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const navigate = useNavigate();
  const location = useLocation();
  // 알림은 **새 입구**다(#4667). 사람은 열려 있던 대화상자·팔레트·서랍에서 그 메시지로 온 것이 아니라 배너에서 왔다 — 그 표면들이
  // 그대로 떠 있으면 클릭한 메시지가 그 밑에 있다. 배너를 눌러 가는 두 길(브라우저 배너의 클릭, 데스크탑 창이 앞에 오는 순간)은
  // 모두 이 한 함수를 지난다: 이동하기 직전에 방송 하나로 겹친 표면을 걷고(`dismissTemporarySurfaces`), 그다음 간다.
  const landOnNotification = useCallback(
    (route: string) => {
      dismissTemporarySurfaces();
      navigate(route);
    },
    [navigate]
  );
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
  // 스레드마다 분당 배너 상한의 장부(#5017). 폰 푸시의 대량 층과 같은 값이다(코어 `THREAD_BANNER_CAP`).
  const threadBannersRef = useRef<ThreadBannerLedger>(EMPTY_THREAD_BANNER_LEDGER);
  const armedRef = useRef<ArmedOpen | null>(null);
  const armedThreadRef = useRef<{ messageId: string; rootId: string } | null>(null);
  // 셸이 배너의 클릭을 알려 준다고 답했는가(#5059). 그렇다면 알림이 올 때 목적지를 무장하지 않는다 — 클릭이 직접 간다.
  // 답이 오기 전의 알림은 옛 방식으로 무장되고, 답이 「그렇다」로 오면 그 무장을 거둔다(아래 효과).
  const clickReportsRef = useRef(false);

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
  const contextRef = useRef({ channels, directory, selfId, workspaceId, queryClient });
  contextRef.current = { channels, directory, selfId, workspaceId, queryClient };

  const canNotifyRef = useRef(canNotify);
  canNotifyRef.current = canNotify;

  // 도우미 초대 링크 메시지의 배너가 서버의 preview를 못 쓸 때 말하는 고정 문장은 사전에서 지금 언어로 읽는다(#5025).
  // 핸들러는 구독이 끊기지 않게 안정적이어야 하므로 ref로 읽는다.
  const messages = useMessages();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const handle = useCallback(function handleEvent(event: MessageNewEvent, answered = false): void {
    const current = contextRef.current;
    // 1:1 대화에서 나간 사람의 하한 아래 발행물(실시간 서버가 끊긴 구간을 다시 보내며 온 나가기 전 글)은 알리지 않는다
    // (ADR-0177 증보 2026-11-14 D22 한계 3 가운데 기기 몫, #5825). 하한 위의 새 글은 평소처럼 알린다(owner D-2).
    if (
      isBelowHistoryFloor(
        event.payload.seq,
        historyFloorFromCache(current.queryClient, current.workspaceId, event.payload.channel_id)
      )
    ) {
      return;
    }
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
      inviteLinkSentence: () =>
        messagesRef.current.formatMessage("notifications.inviteLink.fallback"),
      // 작업 권한 요청(#5595): 승인 카드를 열 수 있는 데스크탑 셸만 원장을 준다. 원장은 서버가 말한 값(캐시)뿐이다.
      ...(isDesktop()
        ? {
            workSession: (sessionId: string) =>
              current.queryClient
                .getQueryData<WorkSession[]>(workSessionsKey(current.workspaceId))
                ?.find((candidate) => uuidEq(candidate.id, sessionId)),
            isWorkSessionVisible: isAgentSessionViewed,
            workPermissionTitle: () =>
              messagesRef.current.formatMessage("desktop.notify.workPermissionTitle"),
            workPermissionSentence: (sessionName: string) =>
              formatRef.current("desktop.notify.workPermission", { session: sessionName }),
          }
        : {}),
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
      // 이 기기가 아직 모르는 세션의 권한 요청(#5595): 세션 원장을 한 번 읽고 한 번만 다시 판정한다. 못 읽으면 접는다.
      // 캐시가 신선해도 서버까지 간다(`staleTime: 0`, design-review H-2): 그 캐시에 이 세션이 없다는 것이 곧 캐시가
      // 낡았다는 뜻이다. 앱 기본 `staleTime`(30초)이면 `fetchQuery`가 그 캐시를 그대로 돌려줘, 보지 않던 채널에서
      // 막 시작한 세션의 첫 권한 요청이 소리 없이 빠진다.
      if (decision.skip === "owner-unknown" && !answered) {
        const askedIn = current.workspaceId;
        void current.queryClient
          .fetchQuery({
            queryKey: workSessionsKey(askedIn),
            queryFn: () => fetchWorkSessions(askedIn),
            staleTime: 0,
          })
          .then(
            () => {
              if (aliveRef.current && contextRef.current.workspaceId === askedIn) handleEvent(event, true);
            },
            () => undefined
          );
      }
      return;
    }
    const { messageId, channelId, body, workSessionId, summaryLabel, bannerGroup } = decision.notification;
    const approval = decision.notification.kind === "approval";
    const threadReply = decision.notification.kind === "thread-reply";
    // 작업 권한 요청(#5595)의 제목은 코어가 정한 세션 이름이다(작성자는 흔히 받는 사람 자신이다).
    const title =
      approval && workSessionId === undefined
        ? memberFor(current.directory, event.payload.author_member_id)?.displayName ?? decision.notification.title
        : decision.notification.title;
    announcedRef.current = rememberAnnounced(announcedRef.current, messageId);
    // 같은 스레드의 답글은 분당 상한까지만 배너가 된다(#5017). 넘은 답글은 알린 것으로 적었으니 다시 오지 않고, 배너도 무장도 없다.
    const threadRoot = threadReply ? event.payload.root_id ?? undefined : undefined;
    if (threadRoot !== undefined) {
      const verdict = admitThreadBanner(threadBannersRef.current, threadRoot, nowMs);
      threadBannersRef.current = verdict.ledger;
      if (!verdict.admitted) return;
    }
    // 승인 알림은 그 카드로 착지한다(#3738). 스레드 답글은 그 답글로(#4890): 아래에서 스레드를 연다. 멘션·DM은 채널이다.
    // 같은 스레드의 답글 여럿은 그 스레드로(#5017).
    const arm: BannerArm = {
      channelId,
      ...(approval || threadReply ? { messageId } : {}),
      ...(threadRoot === undefined ? {} : { threadRoot }),
      ...(event.payload.root_id ? { eventRootId: event.payload.root_id } : {}),
    };
    // 셸이 클릭을 못 알리면 알림을 눌러 창이 앞에 오는 순간 이동한다(arm). 알려 주면 무장하지 않는다(#5059): 배너의 클릭이
    // 직접 간다. 브라우저는 배너 클릭이 직접 간다. 작업 권한 요청(#5595)은 어림하지 않는다: 어림의 목적지는 채널·스레드뿐인데
    // 그 카드는 A 칸에 있어서, 어림은 사람을 카드가 없는 곳에 데려간다. 클릭이 오는 배너만 카드로 간다.
    const work = workSessionId !== undefined;
    if (isDesktop() && !clickReportsRef.current && !work) applyArm(armedRef, armedThreadRef, arm, nowMs);
    // 같은 종류는 한 묶음으로 쌓아 보낸다(osNotifier). 보내기는 fire and forget:
    // 브라우저나 거절된 권한은 false로 끝나는 정상 상태다.
    const kindMap: Record<typeof decision.notification.kind, OsNotifyKind> = {
      approval: "approval",
      mention: "mention",
      dm: "dm",
      "thread-reply": "thread-reply",
    };
    osNotifier().offer({
      // 작업 권한 요청(#5595)은 로컬 칸의 「응답 필요」 배너와 한 묶음이다: 같은 순간(맥에서 실행 허락을 기다림)을 같은
      // 제목으로 말하고, 묶이면 「응답 필요 N건」에 세션 이름·칸 이름이 나란히 선다(design-review M-1).
      kind: bannerGroup ?? kindMap[decision.notification.kind],
      title,
      ...(body === undefined ? {} : { body }),
      label: summaryLabel ?? title.replace(/^승인 필요 · /, ""),
      // 승인 알림은 채널 맨 아래가 아니라 **그 카드**로 연다(#3738): 놓친 카드를 찾느라
      // 위로 스크롤하다 만료를 맞이하지 않게. 스레드 답글은 그 스레드를 열고 그 답글로 간다(#4890).
      // 멘션·DM은 지금까지처럼 채널이다.
      route: work
        ? agentPanePath(workSessionId)
        : approval || threadReply
          ? requestNotificationTarget(channelId, messageId, event.payload.root_id)
          : `/c/${channelId}`,
      ...(threadReply
        ? { summaryTitle: (count: number) => formatRef.current("desktop.notify.threadSummary", { count }) }
        : {}),
      ...(threadRoot === undefined ? {} : { rootId: threadRoot }),
      // 셸이 이 배너의 클릭을 못 알릴 때만 쓰이는 어림 재료(#5059). 작업 권한 요청에는 없다(위).
      ...(work ? {} : { arm }),
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
    setBrowserOpenHandler(landOnNotification);
    return () => setBrowserOpenHandler(null);
  }, [desktop, landOnNotification]);

  // ---- banner clicks from the shell (#5059) ---------------------------------

  // 셸이 배너의 클릭을 알려 주는가. 한 번 묻고 기억한다(`notificationClickSupported`) — 배너를 보내는 쪽(`showDesktopBanner`)도
  // 같은 답을 쓰므로 둘이 어긋나지 않는다. 「그렇다」면 답이 오기 전에 무장된 것을 거둔다: 그 알림의 배너는 클릭으로 간다.
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void notificationClickSupported().then((supported) => {
      if (!live || !supported) return;
      clickReportsRef.current = true;
      armedRef.current = null;
      armedThreadRef.current = null;
    });
    return () => {
      live = false;
    };
  }, [desktop]);

  // 셸이 알려 온 클릭을 장부와 대조해 간다. 구독은 한 번만 만든다: `navigate` 는 경로가 바뀔 때마다 새 함수라서(라우터 v6)
  // 그 변화에 다시 구독하면 그 사이에 온 클릭을 놓친다. 그래서 가장 최근의 이동 함수를 ref 로 읽는다.
  const landRef = useRef(landOnNotification);
  landRef.current = landOnNotification;
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void onNotificationClick((click) => {
      const route = claimBanner(click);
      if (route !== null) landRef.current(route);
    }).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      },
      () => undefined
    );
    return () => {
      cancelled = true;
      stop?.();
      // 이 화면이 내려간다(로그아웃): 앞 사람의 대화 주소가 장부에 남지 않게.
      clearBanners();
    };
  }, [desktop]);

  // 셸이 「떴지만 클릭은 못 알린다」고 한 배너(한도 초과 등)는 옛 어림이 마지막 길이다: 그 배너의 재료로 무장한다.
  useEffect(() => {
    if (!desktop) return;
    setPlainBannerHandler((arms) => {
      const nowMs = Date.now();
      for (const arm of arms) applyArm(armedRef, armedThreadRef, arm, nowMs);
    });
    return () => setPlainBannerHandler(null);
  }, [desktop]);

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
      if (route !== null) landOnNotification(route);
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
  }, [landOnNotification]);

  // Someone who navigated on their own has answered the question the armed
  // target was there to answer; a later focus must not move them again.
  useEffect(() => {
    armedRef.current = null;
    armedThreadRef.current = null;
  }, [location.key]);

  return null;
}
