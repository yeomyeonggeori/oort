import { useCallback, useEffect, useRef, useState } from "react";
import { memberFor, type Directory } from "@momo/core/features/workspace/directory";
import { prefersReducedMotion } from "@/app/sidebarPane";
import type { RealtimeHandle } from "@/lib/realtime";
import { peekFreshSignup, clearFreshSignup } from "./freshSignup";
import { settleKickoffHold } from "./firstRunGate";
import {
  WELCOME_BACKSTOP_MS,
  countActiveAgents,
  decideWelcomeMount,
  hasAgentAuthoredMessage,
  isWelcomeDecisionPending,
  messagesBelongToChannel,
  readShownMarker,
  welcomeBandSpeaker,
  writeShownMarker,
  type WelcomeBandSpeaker,
  type WelcomeKickoffPhase,
} from "./welcomeKickoff";

/**
 * Mount gates, opener exit, 120s backstop.
 *
 * #2817: the kickoff is a band above the composer, outside the message list,
 * so the opener row no longer waits for the band's exit to play its arrival.
 * Mockup D5 shows the opener row and the joy band together. (ADR-0181 D7's
 * exit→arrival order was a same-list rule: the stage row sat above the opener.)
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
  speaker: WelcomeBandSpeaker;
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
  const activeAgentCount = countActiveAgents(directory.members);
  const canDecideZeroAgents =
    directoryStatus === "success" && activeAgentCount === 0;
  const canDecideKickoff =
    timelineStatus === "ready" &&
    directoryStatus === "success" &&
    messagesBelongToChannel(messages, channelId);

  if (!lockedRef.current && (canDecideZeroAgents || canDecideKickoff)) {
    const decision = decideWelcomeMount({
      freshSignup: peekFreshSignup(),
      workspaceId,
      memberId,
      channelKind,
      channelName,
      timelineStatus,
      directoryStatus,
      activeAgentCount,
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
    } else if (
      decision.reason !== "timeline-not-ready" &&
      decision.reason !== "directory-not-ready" &&
      decision.reason !== "unresolved-author" &&
      decision.reason !== "not-default-channel"
    ) {
      queueMicrotask(() => settleKickoffHold());
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
    settleKickoffHold();
  }, [workspaceId, memberId]);

  const finish = useCallback(() => {
    persistExit();
    setPhase("hidden");
  }, [persistExit]);

  // Reduced-motion also passes through `exiting`: the band swaps to joy and
  // leaves after the hold without collapsing (issue: 표정 교체만).
  const beginExit = useCallback(() => {
    const current = phaseRef.current;
    if (current !== "stage" && current !== "backstop") return;
    setPhase("exiting");
  }, []);

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
    speaker: welcomeBandSpeaker(directory.members, memberId),
    holdWriteAction,
    reducedMotion: prefersReducedMotion(),
    onExitComplete: finish,
  };
}
