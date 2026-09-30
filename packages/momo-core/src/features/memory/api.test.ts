import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { WireShapeError } from "../../lib/wire";
import {
  editMemoryItem,
  forgetMemoryItem,
  revertMemoryConsolidation,
  acceptMemoryProposal,
  getMemoryDigest,
  getMemoryItem,
  getMemoryItemEvents,
  getMemoryItemEvidence,
  getMemoryNotice,
  getMemorySettings,
  getRunMemoryReceipt,
  listMemoryDigests,
  listMemoryItems,
  listMemoryProposals,
  patchChannelMemorySettings,
  patchMyMemorySettings,
  patchWorkspaceMemorySettings,
  rejectMemoryProposal,
  resetWorkspaceMemory,
} from "./api";
import { memoryIsCaughtUp } from "./model";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const MSG = "00000000-0000-7000-8000-000000000301";
const DIGEST = "00000000-0000-7000-8000-000000000401";
const RUN = "00000000-0000-7000-8000-000000000501";

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function digestWire(overrides: Record<string, unknown> = {}) {
  return {
    id: DIGEST,
    channelId: CH,
    level: "window",
    fromSeq: 4,
    toSeq: 9,
    body: "배포 일정이 정해졌어요",
    sourceCount: 1,
    createdAtMs: 1_800_000_000_000,
    evidence: [{ messageId: MSG, channelId: CH, seq: 7 }],
    ...overrides,
  };
}

describe("memory reads", () => {
  it("lists digests with the missed-conversation anchor and evidence links", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        digests: [digestWire()],
        afterSeq: 3,
        summarizedThroughSeq: 9,
        nextCursor: "9.x",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await listMemoryDigests(WS, CH, { sinceLastRead: true, level: "window", limit: 5 });
    expect(page.afterSeq).toBe(3);
    expect(page.nextCursor).toBe("9.x");
    expect(page.digests[0].evidence).toEqual([{ messageId: MSG, channelId: CH, seq: 7 }]);
    expect(memoryIsCaughtUp(page, 9)).toBe(true);
    expect(memoryIsCaughtUp(page, 10)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/channels/${CH}/memory/digests?level=window&sinceLastRead=true&limit=5`,
      expect.anything()
    );
  });

  it("treats an empty page as empty, not as an error", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { digests: [], afterSeq: 0 })));
    const page = await listMemoryDigests(WS, CH);
    expect(page).toEqual({ digests: [], afterSeq: 0 });
    expect(memoryIsCaughtUp(page, 0)).toBe(false);
  });

  it("rejects a malformed digest instead of rendering a partial one", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { digests: [digestWire({ level: "year" })], afterSeq: 0 }))
    );
    await expect(listMemoryDigests(WS, CH)).rejects.toBeInstanceOf(WireShapeError);
  });

  it("surfaces a hidden digest as a 404 ApiError", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "digest not found" } }))
    );
    await expect(getMemoryDigest(WS, DIGEST)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getMemoryDigest(WS, DIGEST)).rejects.toBeInstanceOf(ApiError);
  });

  it("reads a receipt; withheldCount is only there for the requester", async () => {
    installHost();
    const receipt = {
      runId: RUN,
      channelId: CH,
      servedCount: 2,
      digestIds: [DIGEST],
      digests: [digestWire()],
      budgetChars: 6000,
      usedChars: 900,
      createdAtMs: 1_800_000_001_000,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { receipt: { ...receipt, withheldCount: 3 } }))
      .mockResolvedValueOnce(jsonResponse(200, { receipt }));
    vi.stubGlobal("fetch", fetchMock);
    const mine = await getRunMemoryReceipt(WS, RUN);
    expect(mine.withheldCount).toBe(3);
    expect(mine.servedCount).toBe(2);
    const others = await getRunMemoryReceipt(WS, RUN);
    expect(others.withheldCount).toBeUndefined();
  });
});

const PROPOSAL = "00000000-0000-7000-8000-000000000601";
const ITEM = "00000000-0000-7000-8000-000000000701";
const AGENT = "00000000-0000-7000-8000-000000000801";
const ALICE = "00000000-0000-7000-8000-000000000802";

function proposalWire(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL,
    channelId: CH,
    runId: RUN,
    agentMemberId: AGENT,
    requesterMemberId: ALICE,
    kind: "decision",
    status: "pending",
    text: "배포는 2026-10-02 금요일 오후 2시로 정했어요",
    subject: "배포 일정",
    evidenceMessageIds: [MSG],
    evidence: [{ messageId: MSG, seq: 7, authorMemberId: ALICE }],
    callerIsRequester: true,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_801_209_600_000,
    ...overrides,
  };
}

describe("memory receipt items (#3169)", () => {
  it("reads the items a run was served, tolerating a server that does not send them", async () => {
    installHost();
    const base = {
      runId: RUN,
      channelId: CH,
      servedCount: 1,
      digestIds: [],
      digests: [],
      budgetChars: 6000,
      usedChars: 300,
      createdAtMs: 1_800_000_001_000,
    };
    const item = {
      id: ITEM,
      channelId: CH,
      kind: "decision",
      origin: "confirmed",
      body: "배포는 금요일",
      validFromMs: 1_800_000_000_000,
      sourceCount: 2,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { receipt: { ...base, itemIds: [ITEM], items: [item] } }))
        .mockResolvedValueOnce(jsonResponse(200, { receipt: base }))
        .mockResolvedValueOnce(
          jsonResponse(200, { receipt: { ...base, itemIds: [ITEM], items: [{ ...item, kind: "gossip" }] } })
        )
    );
    const withItems = await getRunMemoryReceipt(WS, RUN);
    expect(withItems.itemIds).toEqual([ITEM]);
    expect(withItems.items?.[0]).toEqual(item);
    const legacy = await getRunMemoryReceipt(WS, RUN);
    expect(legacy.items).toBeUndefined();
    await expect(getRunMemoryReceipt(WS, RUN)).rejects.toBeInstanceOf(WireShapeError);
  });
});

describe("memory proposals (#3169)", () => {
  it("lists a channel's proposals with the filters it was given", async () => {
    installHost();
    const fetchMock = vi.fn(async () => jsonResponse(200, { proposals: [proposalWire()] }));
    vi.stubGlobal("fetch", fetchMock);
    const rows = await listMemoryProposals(WS, CH, { status: "pending", runId: RUN, limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: PROPOSAL, kind: "decision", status: "pending", runId: RUN });
    expect(rows[0].text).toContain("배포는");
    expect(rows[0].callerIsRequester).toBe(true);
    expect(rows[0].evidence).toEqual([{ messageId: MSG, seq: 7, authorMemberId: ALICE }]);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/channels/${CH}/memory/proposals?status=pending&runId=${RUN}&limit=5`,
      expect.anything()
    );
    await listMemoryProposals(WS, CH);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://oort.test/v1/workspaces/${WS}/channels/${CH}/memory/proposals`,
      expect.anything()
    );
  });

  it("treats an empty list as empty and refuses a malformed row", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { proposals: [] }))
        .mockResolvedValueOnce(jsonResponse(200, { proposals: [proposalWire({ status: "maybe" })] }))
        .mockResolvedValueOnce(jsonResponse(200, { proposals: [proposalWire({ evidenceMessageIds: [7] })] }))
        .mockResolvedValueOnce(jsonResponse(200, { proposals: [proposalWire({ evidence: [{ seq: 7 }] })] }))
        .mockResolvedValueOnce(jsonResponse(200, { proposals: [proposalWire({ callerIsRequester: undefined })] }))
    );
    expect(await listMemoryProposals(WS, CH)).toEqual([]);
    for (let n = 0; n < 4; n += 1) {
      await expect(listMemoryProposals(WS, CH)).rejects.toBeInstanceOf(WireShapeError);
    }
  });

  it("accepts and rejects with a bodiless POST; the decided shell has no text", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({});
      if (url.endsWith("/accept")) {
        return jsonResponse(200, {
          proposal: proposalWire({
            status: "accepted",
            text: undefined,
            subject: undefined,
            evidenceMessageIds: [],
            evidence: [],
            decidedBy: ALICE,
            decidedAtMs: 1_800_000_100_000,
            itemId: ITEM,
          }),
        });
      }
      return jsonResponse(200, {
        proposal: proposalWire({
          status: "rejected",
          text: undefined,
          subject: undefined,
          evidenceMessageIds: [],
          evidence: [],
          decidedBy: ALICE,
          decidedAtMs: 1_800_000_100_000,
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const accepted = await acceptMemoryProposal(WS, PROPOSAL);
    expect(accepted).toMatchObject({ status: "accepted", itemId: ITEM, decidedBy: ALICE });
    expect(accepted.text).toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://oort.test/v1/workspaces/${WS}/memory/proposals/${PROPOSAL}/accept`,
      expect.anything()
    );
    const rejected = await rejectMemoryProposal(WS, PROPOSAL);
    expect(rejected.status).toBe("rejected");
    expect(rejected.itemId).toBeUndefined();
  });

  it("surfaces 403 (may not decide) and 409 (already decided / changed) as ApiError", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(403, { error: { message: "not allowed" } }))
        .mockResolvedValueOnce(jsonResponse(409, { error: { message: "no longer" } }))
    );
    await expect(acceptMemoryProposal(WS, PROPOSAL)).rejects.toMatchObject({ status: 403 });
    await expect(rejectMemoryProposal(WS, PROPOSAL)).rejects.toMatchObject({ status: 409 });
  });
});

describe("memory settings", () => {
  it("reads settings and sends only the fields set", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.endsWith("/memory/settings/me")) {
        expect(JSON.parse(String(init.body))).toEqual({ paused: true });
        return jsonResponse(200, { paused: true });
      }
      if (init?.method === "PATCH" && url.endsWith(`/channels/${CH}/memory/settings`)) {
        expect(JSON.parse(String(init.body))).toEqual({ excluded: true });
        return jsonResponse(200, { channelId: CH, excluded: true, paused: false });
      }
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
        return jsonResponse(200, { enabled: false, paused: false, resetEpoch: 0 });
      }
      return jsonResponse(200, {
        workspace: { enabled: true, paused: false, resetEpoch: 0 },
        channels: [{ channelId: CH, excluded: false, paused: true }],
        me: { paused: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = await getMemorySettings(WS);
    expect(settings.channels[0]).toEqual({ channelId: CH, excluded: false, paused: true });
    expect(await patchWorkspaceMemorySettings(WS, { enabled: false })).toEqual({
      enabled: false,
      paused: false,
      resetEpoch: 0,
    });
    expect((await patchChannelMemorySettings(WS, CH, { excluded: true })).excluded).toBe(true);
    expect(await patchMyMemorySettings(WS, true)).toEqual({ paused: true });
  });

  it("surfaces a permission denial as a 403 ApiError", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: { message: "not allowed" } }))
    );
    await expect(patchWorkspaceMemorySettings(WS, { enabled: false })).rejects.toMatchObject({
      status: 403,
    });
  });
});

const BITEM = "00000000-0000-7000-8000-000000000691";
const BITEM_NEW = "00000000-0000-7000-8000-000000000692";

function itemWire(overrides: Record<string, unknown> = {}) {
  return {
    id: BITEM,
    channelId: CH,
    spaceKind: "channel",
    kind: "decision",
    origin: "extracted",
    body: "릴리스 동결은 금요일부터",
    validFromMs: 1_800_000_000_000,
    recordedAtMs: 1_800_000_000_500,
    confidence: 0.8,
    sourceCount: 1,
    ...overrides,
  };
}

describe("memory browser items", () => {
  it("lists with filters and a keyset cursor, and reads search scores", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { items: [itemWire({ score: 0.9 })], nextCursor: "1.x" })
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await listMemoryItems(WS, {
      channelId: CH,
      kind: "decision",
      status: "history",
      q: "  동결 ",
      cursor: "9.y",
      limit: 5,
    });
    expect(page.nextCursor).toBe("1.x");
    expect(page.items[0]).toMatchObject({ id: BITEM, kind: "decision", score: 0.9 });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/memory/items?channelId=${CH}&kind=decision&status=history&q=%EB%8F%99%EA%B2%B0&cursor=9.y&limit=5`,
      expect.anything()
    );
  });

  it("treats an empty list as empty and rejects a malformed item", async () => {
    installHost();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [] })));
    expect(await listMemoryItems(WS)).toEqual({ items: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [itemWire({ kind: "gossip" })] }))
    );
    await expect(listMemoryItems(WS)).rejects.toBeInstanceOf(WireShapeError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [itemWire({ spaceKind: "team" })] }))
    );
    await expect(listMemoryItems(WS)).rejects.toBeInstanceOf(WireShapeError);
  });

  it("reads detail, evidence and events; a hidden item is a 404 ApiError", async () => {
    installHost();
    const evidence = [{ messageId: MSG, channelId: CH, seq: 7 }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInit | URL | string) => {
        const url = String(input);
        if (url.endsWith("/evidence")) return jsonResponse(200, { evidence });
        if (url.endsWith("/events")) {
          return jsonResponse(200, {
            events: [
              {
                id: "e1",
                action: "superseded",
                actorMemberId: "m1",
                detail: { superseded_by: BITEM_NEW },
                createdAtMs: 5,
              },
            ],
          });
        }
        return jsonResponse(200, {
          item: itemWire({ retiredAtMs: 9, retiredReason: "edited", supersededById: BITEM_NEW }),
          evidence,
        });
      })
    );
    const detail = await getMemoryItem(WS, BITEM);
    expect(detail.item).toMatchObject({ retiredReason: "edited", supersededById: BITEM_NEW });
    expect(detail.evidence).toEqual(evidence);
    expect(await getMemoryItemEvidence(WS, BITEM)).toEqual(evidence);
    expect((await getMemoryItemEvents(WS, BITEM))[0]).toEqual({
      id: "e1",
      action: "superseded",
      actorMemberId: "m1",
      detail: { superseded_by: BITEM_NEW },
      createdAtMs: 5,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "memory item not found" } }))
    );
    await expect(getMemoryItem(WS, BITEM)).rejects.toMatchObject({ status: 404 });
    await expect(getMemoryItemEvents(WS, BITEM)).rejects.toBeInstanceOf(ApiError);
  });

  it("edits with only the fields set and forgets with a count", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInit | URL | string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ body: "새 문구", kind: "fact" });
        return jsonResponse(200, {
          item: itemWire({
            id: BITEM_NEW,
            origin: "curated",
            supersedesId: BITEM,
            kind: "fact",
            editedByMemberId: "m1",
            editedAtMs: 1_800_000_009_000,
          }),
          evidence: [{ messageId: MSG, channelId: CH, seq: 7 }],
          supersededId: BITEM,
        });
      }
      expect(init?.method).toBe("DELETE");
      return jsonResponse(200, { forgottenCount: 3 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const edited = await editMemoryItem(WS, BITEM, { body: "새 문구", kind: "fact" });
    expect(edited.item).toMatchObject({
      id: BITEM_NEW,
      origin: "curated",
      supersedesId: BITEM,
      editedByMemberId: "m1",
      editedAtMs: 1_800_000_009_000,
    });
    expect(edited.supersededId).toBe(BITEM);
    expect(edited.evidence).toHaveLength(1);
    expect(await forgetMemoryItem(WS, BITEM)).toBe(3);
  });

  it("reverts a consolidation event through the item's own path and rejects a bad answer", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string, init?: RequestInit) => {
      expect(String(input)).toContain(`/memory/items/${BITEM}/events/e-1/revert`);
      expect(init?.method).toBe("POST");
      return jsonResponse(200, { reverted: "merged", itemId: BITEM });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await revertMemoryConsolidation(WS, BITEM, "e-1")).toEqual({
      reverted: "merged",
      itemId: BITEM,
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { reverted: "forgotten", itemId: BITEM })));
    await expect(revertMemoryConsolidation(WS, BITEM, "e-1")).rejects.toBeInstanceOf(WireShapeError);
    for (const status of [403, 404, 409]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, { error: { message: "no" } })));
      await expect(revertMemoryConsolidation(WS, BITEM, "e-1")).rejects.toMatchObject({ status });
    }
  });

  it("surfaces 404, 409 and 422 of a write as ApiErrors, and rejects a bad forget body", async () => {
    installHost();
    for (const status of [404, 409, 422]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, { error: { message: "no" } })));
      await expect(editMemoryItem(WS, BITEM, { body: "x" })).rejects.toMatchObject({ status });
      await expect(forgetMemoryItem(WS, BITEM)).rejects.toMatchObject({ status });
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    await expect(forgetMemoryItem(WS, BITEM)).rejects.toBeInstanceOf(WireShapeError);
    await expect(editMemoryItem(WS, BITEM, { body: "x" })).rejects.toBeInstanceOf(WireShapeError);
  });
});

function noticeWire(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    paused: false,
    sending: true,
    resetEpoch: 2,
    summary: { configured: true, provider: { name: "OpenAI", host: "api.openai.com" }, modelId: "gpt-5.4-mini" },
    embeddings: { model: "multilingual-e5-small", location: "local", sentToProvider: false },
    sends: ["channel_message_text", "author_display_name", "agent_dm_message_text"],
    neverSends: ["human_direct_messages", "attachments", "deleted_messages", "excluded_channels", "paused_members_dms"],
    ...overrides,
  };
}

const COUNTS = {
  digests: 4,
  items: 3,
  evidence: 9,
  topics: 1,
  topicSummaries: 1,
  embeddings: 3,
  proposals: 0,
  servings: 2,
  consolidationPairs: 1,
  consolidationState: 1,
};

describe("memory notice and reset (#3212)", () => {
  it("reads the team notice: provider and model, local embeddings, the codes", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string) => {
      expect(String(input)).toBe(`https://oort.test/v1/workspaces/${WS}/memory/notice`);
      return jsonResponse(200, noticeWire());
    });
    vi.stubGlobal("fetch", fetchMock);
    const notice = await getMemoryNotice(WS);
    expect(notice.summary).toEqual({
      configured: true,
      provider: { name: "OpenAI", host: "api.openai.com" },
      modelId: "gpt-5.4-mini",
    });
    expect(notice.embeddings).toEqual({ model: "multilingual-e5-small", location: "local", sentToProvider: false });
    expect(notice.sending).toBe(true);
    expect(notice.neverSends).toContain("human_direct_messages");
  });

  it("accepts a provider without a host (a guest sees 사용자 지정 only)", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, noticeWire({ summary: { configured: true, provider: { name: "사용자 지정" } } }))
      )
    );
    const notice = await getMemoryNotice(WS);
    expect(notice.summary.provider).toEqual({ name: "사용자 지정" });
  });

  it("shows an unconfigured summary as such and drops codes it does not know", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          200,
          noticeWire({ sending: false, summary: { configured: false }, sends: ["channel_message_text", "from_the_future"] })
        )
      )
    );
    const notice = await getMemoryNotice(WS);
    expect(notice.summary).toEqual({ configured: false });
    expect(notice.sends).toEqual(["channel_message_text"]);
  });

  it("refuses a notice that claims embeddings leave the instance, or has no shape", async () => {
    installHost();
    for (const body of [
      noticeWire({ embeddings: { model: "m", location: "local", sentToProvider: true } }),
      noticeWire({ embeddings: { model: "m", location: "cloud", sentToProvider: false } }),
      noticeWire({ summary: { configured: true, provider: { host: "api.openai.com" } } }),
      noticeWire({ sends: "channel_message_text" }),
      {},
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, body)));
      await expect(getMemoryNotice(WS)).rejects.toBeInstanceOf(WireShapeError);
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: { message: "no" } })));
    await expect(getMemoryNotice(WS)).rejects.toMatchObject({ status: 403 });
  });

  it("posts the confirmation with the epoch it showed and returns the counts", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInit | URL | string, init?: RequestInit) => {
      expect(String(input)).toBe(`https://oort.test/v1/workspaces/${WS}/memory/reset`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ confirm: true, expectedEpoch: 2 });
      return jsonResponse(200, { epoch: 3, deleted: COUNTS });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await resetWorkspaceMemory(WS, 2)).toEqual({ epoch: 3, deleted: COUNTS });
  });

  it("surfaces 403 and 409 of a reset and rejects an incomplete answer", async () => {
    installHost();
    for (const status of [403, 409, 400]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, { error: { message: "no" } })));
      await expect(resetWorkspaceMemory(WS, 2)).rejects.toMatchObject({ status });
    }
    for (const body of [{}, { epoch: 3 }, { epoch: 3, deleted: { ...COUNTS, items: undefined } }]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, body)));
      await expect(resetWorkspaceMemory(WS, 2)).rejects.toBeInstanceOf(WireShapeError);
    }
  });
});
