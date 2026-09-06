/**
 * Shared idle `useTimeline` mock (#2050 R3 N-3). ChatShell.intro / .skel
 * and markUnread.rollback.visit each held a hand-extended copy; ChatShell
 * reading `pinArrivalGrant` made all three drift. One helper, overrides
 * for state.
 */
export function idleTimelineMock(
  over: {
    state?: {
      messages: unknown[];
      oldestSeq: number | null;
      newestSeq: number | null;
    };
  } = {}
) {
  return {
    state: over.state ?? { messages: [], oldestSeq: null, newestSeq: null },
    status: "ready" as const,
    resume: { lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 },
    recoveryMarkers: [],
    pending: [],
    send: async () => undefined,
    resend: async () => undefined,
    loadOlder: () => undefined,
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
  };
}
