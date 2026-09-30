import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type {
  MemoryDigest,
  MemoryDigestPage,
  MemoryReceipt,
  MemorySettings,
} from "./model";
import {
  MEMORY_OFF_COPY,
  MISSED_EMPTY_COPY,
  MISSED_NOT_YET_COPY,
  CHANNEL_SWITCH_ADMIN_ONLY_REASON,
  WORKSPACE_SWITCH_ADMIN_ONLY_REASON,
  canChangeWorkspaceMemory,
  deriveMissedCard,
  deriveReceiptChip,
  evidenceAccessibleLabel,
  evidenceLabel,
  memoryEligibleRoom,
  memoryOffReason,
  memoryWriteErrorMessage,
} from "./presentation";

const CH = "00000000-0000-7000-8000-000000000201";
const OTHER = "00000000-0000-7000-8000-000000000202";

function digest(id: string, fromSeq: number, toSeq: number): MemoryDigest {
  return {
    id,
    channelId: CH,
    level: "window",
    fromSeq,
    toSeq,
    body: `요약 ${id}`,
    sourceCount: 4,
    createdAtMs: 1_800_000_000_000,
    evidence: [{ messageId: `m-${id}`, channelId: CH, seq: toSeq }],
  };
}

function settings(over: Partial<MemorySettings> = {}): MemorySettings {
  return {
    workspace: { enabled: true, paused: false, resetEpoch: 0 },
    channels: [],
    me: { paused: false },
    ...over,
  };
}

function page(over: Partial<MemoryDigestPage> = {}): MemoryDigestPage {
  return { digests: [], afterSeq: 10, ...over };
}

const ok = <T>(data: T) => ({ status: "success", data }) as const;

describe("memoryOffReason", () => {
  it("names the broadest switch first", () => {
    expect(
      memoryOffReason(
        settings({
          workspace: { enabled: false, paused: true, resetEpoch: 0 },
          channels: [{ channelId: CH, excluded: true, paused: true }],
          me: { paused: true },
        }),
        CH
      )
    ).toBe("workspaceOff");
    expect(
      memoryOffReason(
        settings({ workspace: { enabled: true, paused: true, resetEpoch: 0 } }),
        CH
      )
    ).toBe("workspacePaused");
  });

  it("reads a channel with no explicit row as on, not excluded", () => {
    expect(memoryOffReason(settings(), CH)).toBeNull();
    expect(
      memoryOffReason(
        settings({ channels: [{ channelId: OTHER, excluded: true, paused: false }] }),
        CH
      )
    ).toBeNull();
  });

  it("matches the channel id case-insensitively", () => {
    expect(
      memoryOffReason(
        settings({
          channels: [{ channelId: CH.toUpperCase(), excluded: true, paused: false }],
        }),
        CH
      )
    ).toBe("channelExcluded");
  });

  it("reports channel pause and personal pause", () => {
    expect(
      memoryOffReason(
        settings({ channels: [{ channelId: CH, excluded: false, paused: true }] }),
        CH
      )
    ).toBe("channelPaused");
    expect(memoryOffReason(settings({ me: { paused: true } }), CH)).toBe("mePaused");
  });
});

describe("deriveMissedCard", () => {
  const base = { channelId: CH, headSeq: 20 };

  it("is loading until settings and digests both answer", () => {
    expect(
      deriveMissedCard({ ...base, settings: { status: "pending" }, digests: null })
    ).toEqual({ kind: "loading" });
    expect(
      deriveMissedCard({
        ...base,
        settings: ok(settings()),
        digests: { status: "pending" },
      })
    ).toEqual({ kind: "loading" });
  });

  it("explains memory being off and never asks the digests", () => {
    const state = deriveMissedCard({
      ...base,
      settings: ok(settings({ me: { paused: true } })),
      digests: null,
    });
    expect(state).toEqual({
      kind: "off",
      reason: "mePaused",
      message: MEMORY_OFF_COPY.mePaused,
    });
  });

  it("says empty only when the worker has caught up to the head", () => {
    const state = deriveMissedCard({
      ...base,
      settings: ok(settings()),
      digests: ok(page({ summarizedThroughSeq: 20 })),
    });
    expect(state).toEqual({ kind: "empty", message: MISSED_EMPTY_COPY });
  });

  it("says not-yet when the worker is behind the head or does not say", () => {
    for (const summarizedThroughSeq of [12, undefined]) {
      const state = deriveMissedCard({
        ...base,
        settings: ok(settings()),
        digests: ok(page({ summarizedThroughSeq })),
      });
      expect(state).toEqual({ kind: "notYet", message: MISSED_NOT_YET_COPY });
    }
  });

  it("orders digests oldest first and reports how far behind the head it is", () => {
    const state = deriveMissedCard({
      ...base,
      settings: ok(settings()),
      digests: ok(
        page({
          digests: [digest("b", 15, 18), digest("a", 11, 14)],
          summarizedThroughSeq: 18,
        })
      ),
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.digests.map((row) => row.id)).toEqual(["a", "b"]);
    expect(state.behindHead).toBe(true);
    expect(state.unsummarizedCount).toBe(2);
  });

  it("is not behind when caught up", () => {
    const state = deriveMissedCard({
      ...base,
      settings: ok(settings()),
      digests: ok(page({ digests: [digest("a", 11, 20)], summarizedThroughSeq: 20 })),
    });
    expect(state).toMatchObject({ kind: "ready", behindHead: false, unsummarizedCount: null });
  });

  it("folds a route the server does not have into hidden, and anything else into error", () => {
    for (const status of [404, 405, 501]) {
      expect(
        deriveMissedCard({
          ...base,
          settings: { status: "error", error: new ApiError(status, "no") },
          digests: null,
        })
      ).toEqual({ kind: "hidden" });
    }
    expect(
      deriveMissedCard({
        ...base,
        settings: ok(settings()),
        digests: { status: "error", error: new ApiError(500, "boom") },
      }).kind
    ).toBe("error");
    expect(
      deriveMissedCard({
        ...base,
        settings: { status: "error", error: new ApiError(403, "no") },
        digests: null,
      }).kind
    ).toBe("error");
  });
});

describe("deriveReceiptChip", () => {
  function receipt(over: Partial<MemoryReceipt> = {}): MemoryReceipt {
    return {
      runId: "r",
      channelId: CH,
      servedCount: 2,
      digestIds: ["a", "b"],
      digests: [digest("a", 1, 2), digest("b", 3, 4)],
      budgetChars: 6000,
      usedChars: 900,
      createdAtMs: 1,
      ...over,
    };
  }

  it("draws no chip when nothing was served or there is no receipt", () => {
    expect(deriveReceiptChip(undefined)).toBeNull();
    expect(deriveReceiptChip(null)).toBeNull();
    expect(deriveReceiptChip(receipt({ servedCount: 0, digests: [] }))).toBeNull();
  });

  it("labels with what was served", () => {
    expect(deriveReceiptChip(receipt())?.label).toBe("기억 2개 참고");
  });

  it("echoes the withheld count only when the API returned it and it is above zero", () => {
    expect(deriveReceiptChip(receipt())?.withheldCount).toBeNull();
    expect(deriveReceiptChip(receipt({ withheldCount: 0 }))?.withheldCount).toBeNull();
    expect(deriveReceiptChip(receipt({ withheldCount: 3 }))?.withheldCount).toBe(3);
  });

  it("counts served items as listed, so only the unreadable remainder is unlisted", () => {
    const model = deriveReceiptChip(
      receipt({
        servedCount: 4,
        items: [
          {
            id: "i1",
            channelId: "c",
            kind: "decision",
            origin: "confirmed",
            body: "큐를 늘려요.",
            validFromMs: 1,
            sourceCount: 2,
          },
        ],
      })
    );
    expect(model?.items).toHaveLength(1);
    expect(model?.unlistedCount).toBe(1);
    expect(model?.usedChars).toBe(receipt().usedChars);
  });

  it("accounts for served items the reader cannot open", () => {
    expect(
      deriveReceiptChip(receipt({ servedCount: 5 }))?.unlistedCount
    ).toBe(3);
    expect(deriveReceiptChip(receipt())?.unlistedCount).toBe(0);
  });
});

describe("memoryWriteErrorMessage", () => {
  it("maps 403 to who may change it, per scope", () => {
    expect(memoryWriteErrorMessage(new ApiError(403, "x"), "workspace")).toBe(
      WORKSPACE_SWITCH_ADMIN_ONLY_REASON
    );
    expect(memoryWriteErrorMessage(new ApiError(403, "x"), "channel")).toBe(
      CHANNEL_SWITCH_ADMIN_ONLY_REASON
    );
  });

  it("maps 400 and 422 to the same retry sentence", () => {
    const a = memoryWriteErrorMessage(new ApiError(400, "x"), "workspace");
    const b = memoryWriteErrorMessage(new ApiError(422, "x"), "workspace");
    expect(a).toBe(b);
    expect(a).toContain("다시 시도");
  });

  it("falls back to a generic sentence with a next step, without echoing the server", () => {
    const text = memoryWriteErrorMessage(new ApiError(500, "SQL exploded"), "me");
    expect(text).not.toContain("SQL");
    expect(text).toContain("다시 시도");
    expect(memoryWriteErrorMessage(new Error("network"), "me")).toBe(text);
  });
});

describe("canChangeWorkspaceMemory", () => {
  it("is owner and admin only", () => {
    expect(canChangeWorkspaceMemory("owner")).toBe(true);
    expect(canChangeWorkspaceMemory("admin")).toBe(true);
    expect(canChangeWorkspaceMemory("member")).toBe(false);
    expect(canChangeWorkspaceMemory("guest")).toBe(false);
    expect(canChangeWorkspaceMemory(undefined)).toBe(false);
  });
});

describe("evidence labels", () => {
  it("the accessible name starts with the visible text (label in name)", () => {
    for (const index of [0, 1, 8]) {
      expect(evidenceAccessibleLabel(index).startsWith(evidenceLabel(index))).toBe(true);
    }
  });

  it("never shows a sequence number as text", () => {
    expect(evidenceLabel(0)).toBe("근거 1");
  });
});

describe("memoryEligibleRoom", () => {
  it("summarizes channels and agent DMs, never person-to-person or unknown-peer DMs", () => {
    expect(memoryEligibleRoom({ kind: "public", peerKind: undefined })).toBe(true);
    expect(memoryEligibleRoom({ kind: "private", peerKind: undefined })).toBe(true);
    expect(memoryEligibleRoom({ kind: "dm", peerKind: "agent" })).toBe(true);
    expect(memoryEligibleRoom({ kind: "dm", peerKind: "human" })).toBe(false);
    expect(memoryEligibleRoom({ kind: "dm", peerKind: undefined })).toBe(false);
  });
});
