import { useCallback, useEffect, useRef, useState } from "react";
import { uuidEq } from "@momo/core/lib/api";
import { memberFor, type Directory } from "@momo/core/features/workspace/directory";
import { prefersReducedMotion } from "@/app/sidebarPane";
import type { RealtimeHandle } from "@/lib/realtime";
import { peekFreshSignup, clearFreshSignup } from "./freshSignup";
import {
  WELCOME_BACKSTOP_MS,
  decideWelcomeMount,
  hasAgentAuthoredMessage,
  isWelcomeDecisionPending,
  messagesBelongToChannel,
  readShownMarker,
  writeShownMarker,
  type WelcomeKickoffPhase,
} from "./welcomeKickoff";

/**
 * Mount gates, opener exit, 120s backstop, and the hold that keeps
 * enter-conversation off the opener row until the stage's exit animationend.
 */
export function useWelcomeKickoff(input: {
  workspaceId: string;
  memberId: string;
  channelKind?: string;
  channelName?: string;
  channelId: string | null;
  timelineStatus: "loading" | "ready" | "error";
  directoryStatus: "pending" | "success" | "error";
  messages: readonly { id: string; authorMemberId: string; channelId?: string }[];
  directory: Directory;
  realtime: RealtimeHandle | null;
}): {
  phase: WelcomeKickoffPhase;
  holdEntranceId: string | null;
  holdWriteAction: boolean;
  reducedMotion: boolean;
  onExitComplete: () => void;
} {
  const {
    workspaceId,
    memberId,
    channelKind,
    channelName,
    channelId,
    timelineStatus,
    directoryStatus,
    messages,
    directory,
    realtime,
  } = input;

  const [phase, setPhase] = useState<WelcomeKickoffPhase>("hidden");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const lockedRef = useRef(false);
  const mountIdsRef = useRef<Set<string> | null>(null);
  const channelKeyRef = useRef("");
  const channelKey = `${workspaceId}:${channelId ?? ""}:${channelKind ?? ""}:${channelName ?? ""}`;

  if (channelKeyRef.current !== channelKey) {
    channelKeyRef.current = channelKey;
    lockedRef.current = false;
    mountIdsRef.current = null;
    if (phase !== "hidden") setPhase("hidden");
  }

  const authorKind = (id: string) => memberFor(directory, id)?.kind;
  const hasUnresolvedAuthor =
    directoryStatus === "success" &&
    messages.some((message) => memberFor(directory, message.authorMemberId) == null);

  if (
    !lockedRef.current &&
    timelineStatus === "ready" &&
    directoryStatus === "success" &&
    messagesBelongToChannel(messages, channelId)
  ) {
    const decision = decideWelcomeMount({
      freshSignup: peekFreshSignup(),
      workspaceId,
      memberId,
      channelKind,
      channelName,
      timelineStatus,
      directoryStatus,
      hasUnresolvedAuthor,
      hasAgentAuthoredMessage: hasAgentAuthoredMessage(messages, authorKind),
      shown: readShownMarker(workspaceId, memberId),
    });
    // Freeze only on show. A deny on the previous channel's still-ready head
    // must not stick: capture dump 2026-09-05 after 엔진→general was
    // introEmpty=true messages=0 fresh present copy=false. makeMessages stamps
    // channelId GENERAL_ID on every room (capture-screens.mjs:889), so the
    // belong check treated that head as this channel's.
    if (decision.show) {
      lockedRef.current = true;
      mountIdsRef.current = new Set(
        messages.map((message) => message.id.toLowerCase())
      );
      setPhase("stage");
    }
  }

  const openerId = (() => {
    const seen = mountIdsRef.current;
    if (!seen) return null;
    for (const message of messages) {
      if (seen.has(message.id.toLowerCase())) continue;
      if (authorKind(message.authorMemberId) === "agent") return message.id;
    }
    return null;
  })();

  const persistExit = useCallback(() => {
    clearFreshSignup();
    writeShownMarker(workspaceId, memberId);
  }, [workspaceId, memberId]);

  const finish = useCallback(() => {
    persistExit();
    setPhase("hidden");
  }, [persistExit]);

  const beginExit = useCallback(() => {
    const current = phaseRef.current;
    if (current !== "stage" && current !== "backstop") return;
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    setPhase("exiting");
  }, [finish]);

  useEffect(() => {
    if ((phase === "stage" || phase === "backstop") && openerId) {
      beginExit();
    }
  }, [phase, openerId, beginExit]);

  useEffect(() => {
    if (phase !== "stage") return;
    const timer = window.setTimeout(() => {
      if (phaseRef.current !== "stage") return;
      persistExit();
      setPhase("backstop");
    }, WELCOME_BACKSTOP_MS);
    return () => window.clearTimeout(timer);
  }, [phase, persistExit]);

  useEffect(() => {
    if (!realtime || channelId === null) return;
    if (phase !== "stage" && phase !== "backstop") return;
    const agents = directory.members.filter(
      (member) => member.kind === "agent" && member.status === "active"
    );
    const unsubs = agents.map((agent) =>
      realtime.subscribeAgent(workspaceId, channelId, agent.id, {
        onEvent: (event) => {
          if (event.type !== "agent.partial") return;
          beginExit();
        },
      })
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [realtime, workspaceId, channelId, directory, phase, beginExit]);

  const holdEntranceId =
    openerId &&
    (phase === "stage" || phase === "exiting" || phase === "backstop")
      ? openerId
      : null;

  const holdWriteAction =
    phase === "stage" ||
    phase === "exiting" ||
    phase === "backstop" ||
    isWelcomeDecisionPending({
      freshSignup: peekFreshSignup(),
      workspaceId,
      memberId,
      channelKind,
      channelName,
      timelineStatus,
      directoryStatus,
      channelId,
      messages,
    });

  return {
    phase,
    holdEntranceId,
    holdWriteAction,
    reducedMotion: prefersReducedMotion(),
    onExitComplete: finish,
  };
}

export function welcomeHoldsEntrance(
  holdEntranceId: string | null,
  messageId: string
): boolean {
  return holdEntranceId !== null && uuidEq(holdEntranceId, messageId);
}

/** ChatShell and the Chromium harness share this composition (N12). */
export function welcomePlayEntrance(
  holdEntranceId: string | null,
  messageId: string,
  storePlay: ((id: string) => boolean) | undefined
): boolean {
  if (welcomeHoldsEntrance(holdEntranceId, messageId)) return false;
  return storePlay?.(messageId) ?? false;
}
