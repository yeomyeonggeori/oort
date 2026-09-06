import type { UseTimelineResult } from "./useTimeline";
import { emptyTimeline } from "@momo/core/features/timeline/model";

/**
 * Shared idle `useTimeline` mock (#2050 R3 N-3 / R4 N-3). ChatShell.intro /
 * .skel and markUnread.rollback.visit each held a hand-extended copy;
 * ChatShell reading `pinArrivalGrant` made all three drift. One helper,
 * `satisfies UseTimelineResult` so a dropped member is a type error.
 */
export function idleTimelineMock(
  over: {
    state?: UseTimelineResult["state"];
  } = {}
): UseTimelineResult {
  return {
    state: over.state ?? emptyTimeline(),
    status: "ready" as const,
    resume: { lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 },
    recoveryMarkers: [],
    pending: [],
    send: async () => undefined,
    resend: async () => undefined,
    loadOlder: async () => undefined,
    reload: () => undefined,
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
    toggleReaction: async () => undefined,
    pins: {},
    pinsStatus: "ready" as const,
    reloadPins: () => undefined,
    togglePin: async () => undefined,
    editMessage: async () => undefined,
    deleteMessage: async () => undefined,
    unfurls: {},
    removeUnfurls: async () => undefined,
    isPlayEntrance: () => false,
    consumeEntrance: () => undefined,
    pinArrivalGrant: () => undefined,
    capUnmountedArrivals: () => undefined,
  } satisfies UseTimelineResult;
}
