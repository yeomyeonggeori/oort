import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/app/session";
import { isDesktop, showNotification } from "@/lib/tauri";
import type { MessageNewEvent } from "@/lib/realtime";
import { uuidEq } from "@/lib/api";
import {
  useChannels,
  useDirectory,
  memberFor,
} from "@/features/workspace/useWorkspace";
import { actorToken } from "@/features/inbox/model";
import {
  armOpen,
  notifyDecision,
  openTarget,
  rememberAnnounced,
  type ArmedOpen,
} from "./model";

// =============================================================================
// Desktop notification rail (MOMO-607, ADR-0133 P2) — the trigger MOMO-603 left
// as a seam ("wiring which events notify is the web layer's job").
//
// Renders nothing. It watches the realtime rail for the two events addressed to
// a person, asks `./model.ts` whether either is worth an interruption, and hands
// the survivors to the shell bridge. Every rule lives in the pure model; this
// file is the impure half — subscriptions, window focus, and the OS call.
//
// In a browser it does nothing at all: no notification, and no extra Centrifugo
// subscription either, so the web build pays nothing for a desktop capability.
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
  const contextRef = useRef({ channels, directory, selfId });
  contextRef.current = { channels, directory, selfId };

  const handle = useCallback((event: MessageNewEvent) => {
    const current = contextRef.current;
    const nowMs = Date.now();
    const decision = notifyDecision(event, {
      isDesktop: isDesktop(),
      windowFocused: focusedRef.current,
      selfMemberId: current.selfId,
      isMuted: (channelId) =>
        current.channels.some(
          (channel) => uuidEq(channel.id, channelId) && channel.muted
        ),
      isAnnounced: (messageId) => announcedRef.current.includes(messageId),
      actorFor: (memberId) => {
        const member = memberFor(current.directory, memberId);
        if (!member) return memberId.slice(0, 8);
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
    armedRef.current = armOpen(armedRef.current, channelId, nowMs);
    // Fire and forget: `showNotification` resolves false for a browser or a
    // refused permission, which are both normal states, not failures.
    void showNotification(title, body);
  }, []);

  // ---- the rail -----------------------------------------------------------

  useEffect(() => {
    if (!isDesktop() || !realtime || watched === "") return;
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
  }, [realtime, workspaceId, watched, handle]);

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
