import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import {
  createReminder,
  deleteReminder,
  listReminders,
  patchReminder,
} from "./api";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const MSG = "00000000-0000-7000-8000-000000000301";
const ID = "00000000-0000-7000-8000-000000000401";
const DUE = 1_800_000_030_000;

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
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reminderWire(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    workspaceId: WS,
    memberId: "00000000-0000-7000-8000-000000000101",
    channelId: CH,
    messageId: MSG,
    dueAtMs: DUE,
    createdAtMs: DUE - 60_000,
    messagePreview: "배포 점검 부탁드립니다",
    seq: 12,
    ...overrides,
  };
}

describe("reminder CRUD round-trip", () => {
  it("creates, lists, completes, snoozes, and deletes against the contracted paths", async () => {
    installHost();
    const store: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith(`/v1/workspaces/${WS}/reminders`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          channelId: CH,
          messageId: MSG,
          dueAtMs: DUE,
          note: "배포 후 확인",
        });
        const created = reminderWire({ note: body.note });
        store.push(created);
        return jsonResponse(201, { reminder: created });
      }
      if (method === "GET" && url.includes(`state=pending`)) {
        return jsonResponse(200, {
          reminders: store.filter((row) => row.completedAtMs === undefined),
        });
      }
      if (method === "PATCH" && url.endsWith(`/reminders/${ID}`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const current = store[0];
        if (body.completed === true) current.completedAtMs = DUE + 1;
        if (typeof body.dueAtMs === "number") {
          current.dueAtMs = body.dueAtMs;
          delete current.completedAtMs;
        }
        return jsonResponse(200, current);
      }
      if (method === "DELETE" && url.endsWith(`/reminders/${ID}`)) {
        store.splice(0, store.length);
        return jsonResponse(204, null);
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createReminder(WS, {
      channelId: CH,
      messageId: MSG,
      dueAtMs: DUE,
      note: "배포 후 확인",
    });
    expect(created.id).toBe(ID);
    expect(created.note).toBe("배포 후 확인");

    const listed = await listReminders(WS);
    expect(listed.reminders).toHaveLength(1);
    expect(listed.reminders[0].messagePreview).toBe("배포 점검 부탁드립니다");

    const completed = await patchReminder(WS, ID, { completed: true });
    expect(completed.completedAtMs).toBe(DUE + 1);
    expect((await listReminders(WS)).reminders).toHaveLength(0);

    const snoozed = await patchReminder(WS, ID, { dueAtMs: DUE + 3_600_000 });
    expect(snoozed.dueAtMs).toBe(DUE + 3_600_000);
    expect(snoozed.completedAtMs).toBeUndefined();

    await deleteReminder(WS, ID);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://oort.test/v1/workspaces/${WS}/reminders/${ID}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("defaults GET to state=pending", async () => {
    installHost();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { reminders: [] })
    );
    vi.stubGlobal("fetch", fetchMock);
    await listReminders(WS);
    await listReminders(WS, { state: "all" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://oort.test/v1/workspaces/${WS}/reminders?state=pending`,
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://oort.test/v1/workspaces/${WS}/reminders?state=all`,
      expect.anything()
    );
  });
});
