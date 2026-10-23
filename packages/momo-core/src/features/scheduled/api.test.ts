import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import {
  SCHEDULED_LIST_MAX_PAGES,
  createScheduledMessage,
  deleteScheduledMessage,
  listAllScheduledMessages,
  listScheduledMessages,
  scheduledListPath,
  sendScheduledMessageNow,
  updateScheduledMessage,
} from "./api";
import { isScheduledAbsent, isSchedulerDisabled } from "./errors";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ID = "00000000-0000-7000-8000-0000000004a1";
const REQ = "00000000-0000-7000-8000-0000000006a1";
const SEND_AT = 1_800_000_000_000;

function installHost(): void {
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function respond(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(...responses: Array<Response | Error>) {
  const mock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) mock.mockRejectedValueOnce(response);
    else mock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", mock);
  installHost();
  return mock;
}

function call(mock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: init.method ?? "GET",
    headers: new Headers(init.headers),
    body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
    rawBody: init.body,
  };
}

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "내일 회의 전에 자료 올려 둘게요",
    status: "pending",
    sendAtMs: SEND_AT,
    editableUntilMs: SEND_AT - 30_000,
    rev: 0,
    createdAtMs: SEND_AT - 86_400_000,
    updatedAtMs: SEND_AT - 86_400_000,
    ...overrides,
  };
}

describe("the five operations hit the contracted paths", () => {
  it("creates: POST under the channel with the closed body, bearer and JSON headers", async () => {
    const mock = stubFetch(respond(201, { scheduledMessage: wire() }));
    const row = await createScheduledMessage(WS, {
      channelId: CH,
      body: "  내일 회의 전에 자료 올려 둘게요 ",
      sendAtMs: SEND_AT,
      attachmentIds: ["a1"],
      clientRequestId: REQ,
    });
    expect(row.id).toBe(ID);
    const sent = call(mock);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`https://oort.test/v1/workspaces/${WS}/channels/${CH}/scheduled-messages`);
    expect(sent.headers.get("Authorization")).toBe("Bearer access-token");
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.body).toEqual({
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
      body: "내일 회의 전에 자료 올려 둘게요",
      attachmentIds: ["a1"],
    });
  });

  it("lists the caller's rows from the workspace collection", async () => {
    const mock = stubFetch(respond(200, { scheduledMessages: [wire()] }));
    const page = await listScheduledMessages(WS);
    expect(page.scheduledMessages).toHaveLength(1);
    expect(call(mock).url).toBe(`https://oort.test/v1/workspaces/${WS}/scheduled-messages`);
    expect(call(mock).method).toBe("GET");
  });

  it("edits with PATCH on the row and sends exactly the keys it is given", async () => {
    const mock = stubFetch(respond(200, { scheduledMessage: wire({ body: "고친 글", rev: 1 }) }));
    const row = await updateScheduledMessage(WS, ID, { body: "고친 글" });
    expect(row.rev).toBe(1);
    const sent = call(mock);
    expect(sent.method).toBe("PATCH");
    expect(sent.url).toBe(`https://oort.test/v1/workspaces/${WS}/scheduled-messages/${ID}`);
    expect(sent.body).toEqual({ body: "고친 글" });
    expect("sendAtMs" in (sent.body ?? {})).toBe(false);
  });

  it("sends now with POST …/send-now and no body", async () => {
    const mock = stubFetch(
      respond(200, {
        scheduledMessage: wire({ status: "sent", sentMessageId: "m1", sentAtMs: SEND_AT, rev: 2 }),
      })
    );
    const row = await sendScheduledMessageNow(WS, ID);
    expect(row.status).toBe("sent");
    expect(row.sentMessageId).toBe("m1");
    const sent = call(mock);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`https://oort.test/v1/workspaces/${WS}/scheduled-messages/${ID}/send-now`);
    expect(sent.rawBody).toBeUndefined();
  });

  it("deletes with DELETE and accepts the empty 204", async () => {
    const mock = stubFetch(respond(204));
    await expect(deleteScheduledMessage(WS, ID)).resolves.toBeUndefined();
    expect(call(mock).method).toBe("DELETE");
    expect(call(mock).url).toBe(`https://oort.test/v1/workspaces/${WS}/scheduled-messages/${ID}`);
  });

  it("percent-encodes every path segment it is given", async () => {
    const mock = stubFetch(respond(204));
    await deleteScheduledMessage("w s/1", "a/b?c");
    expect(call(mock).url).toBe("https://oort.test/v1/workspaces/w%20s%2F1/scheduled-messages/a%2Fb%3Fc");
  });

  it("throws a WireShapeError for a 200 whose row cannot be read", async () => {
    stubFetch(respond(200, { scheduledMessage: wire({ status: "weird" }) }));
    await expect(sendScheduledMessageNow(WS, ID)).rejects.toBeInstanceOf(WireShapeError);
  });
});

describe("list path and pagination", () => {
  it("leaves out every query key that was not asked for", () => {
    expect(scheduledListPath(WS)).toBe(`/v1/workspaces/${WS}/scheduled-messages`);
    expect(scheduledListPath(WS, { channelId: CH, status: "failed", cursor: ID, limit: 25 })).toBe(
      `/v1/workspaces/${WS}/scheduled-messages?channelId=${CH}&status=failed&cursor=${ID}&limit=25`
    );
  });

  it("follows the cursor across pages and asks for status=open explicitly", async () => {
    const id2 = "00000000-0000-7000-8000-0000000004a2";
    const mock = stubFetch(
      respond(200, { scheduledMessages: [wire()], nextCursor: ID }),
      respond(200, { scheduledMessages: [wire({ id: id2 })] })
    );
    const rows = await listAllScheduledMessages(WS);
    expect(rows.map((row) => row.id)).toEqual([ID, id2]);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(call(mock, 0).url).toBe(`https://oort.test/v1/workspaces/${WS}/scheduled-messages?status=open`);
    expect(call(mock, 1).url).toBe(
      `https://oort.test/v1/workspaces/${WS}/scheduled-messages?status=open&cursor=${ID}`
    );
  });

  it("stops at the page cap instead of looping forever on a server that always has a next page", async () => {
    const mock = vi.fn(async () => respond(200, { scheduledMessages: [wire()], nextCursor: ID }));
    vi.stubGlobal("fetch", mock);
    installHost();
    const rows = await listAllScheduledMessages(WS);
    expect(mock).toHaveBeenCalledTimes(SCHEDULED_LIST_MAX_PAGES);
    expect(rows).toHaveLength(SCHEDULED_LIST_MAX_PAGES);
  });
});

describe("errors keep their status and code, and only the list's 404 means an absent surface", () => {
  it("keeps error.code on a refused create, so the 409s are told apart by code", async () => {
    stubFetch(respond(409, { error: { message: "limit", code: "pending_limit_reached" } }));
    const error = await createScheduledMessage(WS, {
      channelId: CH,
      body: "글",
      sendAtMs: SEND_AT,
      clientRequestId: REQ,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("pending_limit_reached");
  });

  it("answers a list 404 as an absent surface, and a 5xx or a dropped connection as an outage", async () => {
    stubFetch(respond(404, { error: { message: "not found" } }));
    const absent = await listScheduledMessages(WS).catch((caught: unknown) => caught);
    expect(isScheduledAbsent(absent)).toBe(true);

    resetCoreHost();
    stubFetch(respond(503, { error: { message: "down" } }));
    const outage = await listScheduledMessages(WS).catch((caught: unknown) => caught);
    expect(isScheduledAbsent(outage)).toBe(false);

    resetCoreHost();
    stubFetch(new TypeError("Failed to fetch"));
    const offline = await listScheduledMessages(WS).catch((caught: unknown) => caught);
    expect(offline).toBeInstanceOf(NetworkError);
    expect(isScheduledAbsent(offline)).toBe(false);
  });

  it("does not swallow the 404 of an operation on one row: the caller still sees an ApiError", async () => {
    stubFetch(respond(404, { error: { message: "no such row" } }));
    const error = await deleteScheduledMessage(WS, ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it("tells a disabled scheduler (503 scheduler_disabled) from any other 503", async () => {
    stubFetch(respond(503, { error: { message: "off", code: "scheduler_disabled" } }));
    const disabled = await sendScheduledMessageNow(WS, ID).catch((caught: unknown) => caught);
    expect(isSchedulerDisabled(disabled)).toBe(true);

    resetCoreHost();
    stubFetch(respond(503, { error: { message: "down" } }));
    const down = await sendScheduledMessageNow(WS, ID).catch((caught: unknown) => caught);
    expect(isSchedulerDisabled(down)).toBe(false);
    expect(isSchedulerDisabled(new Error("x"))).toBe(false);
  });
});
