import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../../runtime/host";
import { fetchAgentRunEvents, resetRunLedgerIncludeProbe } from "../../lib/api";

// =============================================================================
// 원장 읽기의 `?include=doorbell` (#3824). 옛 서버는 쿼리를 읽지 않으므로 그대로
// 예전 원장을 준다. 쿼리를 읽고 거절하는 서버(400)에는 쿼리 없이 한 번 더 읽고, 그
// 읽기가 성공했을 때만 「이 서버는 쿼리를 거절한다」고 기억한다.
// =============================================================================

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

const WS = "00000000-0000-7000-8000-000000000001";
const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const LEDGER = { runId: RUN, events: [{ ordinal: 1, kind: "queued", createdAtMs: 1 }] };
const ok = () =>
  new Response(JSON.stringify(LEDGER), { status: 200, headers: { "content-type": "application/json" } });
const bad = () =>
  new Response(JSON.stringify({ error: { code: "bad_request", message: "include must be doorbell" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
const urls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map((call) => String(call[0]).replace("https://oort.test", ""));

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
  resetRunLedgerIncludeProbe();
});

describe("fetchAgentRunEvents ?include=doorbell", () => {
  it("깨우는 신호 행을 쿼리로 묻는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok());
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true });
    expect(urls(fetchMock)).toEqual([`/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`]);
  });

  it("400이면 쿼리 없이 다시 읽고, 성공했으니 다음부터는 쿼리를 보내지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes("include=") ? bad() : ok()
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAgentRunEvents(WS, RUN, { includeDoorbell: true })).resolves.toMatchObject({ runId: RUN });
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true });
    expect(urls(fetchMock)).toEqual([
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events`,
    ]);
  });

  it("쿼리 없이도 400이면(틀린 id) 거절을 기억하지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bad());
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAgentRunEvents(WS, RUN, { includeDoorbell: true })).rejects.toThrow();
    fetchMock.mockImplementation(async () => ok());
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true });
    expect(urls(fetchMock).at(-1)).toBe(`/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`);
  });
});

// =============================================================================
// 원장 읽기의 `include=tools` (#4654, ADR-0200 증보 2026-10-15 T4). 물을 것을 한 칸씩 줄여 다시
// 읽는다: `doorbell,tools` → `doorbell` → 쿼리 없음. 「doorbell은 알고 tools는 모르는」 서버가 핵심이다.
// =============================================================================

const rejectsTools = (input: RequestInfo | URL) => {
  const url = String(input);
  return url.includes("tools");
};
const rejectsAny = (input: RequestInfo | URL) => String(input).includes("include=");

describe("fetchAgentRunEvents include=tools", () => {
  it("깨움과 도구 호출을 한 번에 묻는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok());
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true });
    expect(urls(fetchMock)).toEqual([
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell,tools`,
    ]);
  });

  it("tools만 모르는 서버: doorbell은 지키고 한 번만 물러서며, 다음부터는 곧장 doorbell만 묻는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      rejectsTools(input) ? bad() : ok()
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true })
    ).resolves.toMatchObject({ runId: RUN });
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true });
    expect(urls(fetchMock)).toEqual([
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell,tools`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`,
    ]);
  });

  it("쿼리를 모두 거절하는 서버: 끝칸(쿼리 없음)까지 물러서고 둘 다 기억한다", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      rejectsAny(input) ? bad() : ok()
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true });
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true });
    expect(urls(fetchMock)).toEqual([
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell,tools`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events`,
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events`,
    ]);
  });

  it("쿼리 없이도 400이면(틀린 id) 거절을 기억하지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => bad());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockImplementation(async () => ok());
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true, includeTools: true });
    expect(urls(fetchMock).at(-1)).toBe(
      `/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell,tools`
    );
  });

  it("폰의 호출(깨움만)은 그대로다: 쿼리 모양이 바뀌지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ok());
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgentRunEvents(WS, RUN, { includeDoorbell: true });
    expect(urls(fetchMock)).toEqual([`/v1/workspaces/${WS}/agent-runs/${RUN}/events?include=doorbell`]);
  });
});

describe("fetchAgentRunEvents include=activity (#4657)", () => {
  const all = { includeDoorbell: true, includeTools: true, includeActivity: true };
  const path = (include: string) => `/v1/workspaces/${WS}/agent-runs/${RUN}/events${include === "" ? "" : `?include=${include}`}`;
  const knows = (input: RequestInfo | URL, allowed: readonly string[]) => {
    const query = String(input).split("include=")[1];
    return query === undefined || query.split(",").every((value) => allowed.includes(value));
  };

  it("셋을 한 번에 묻고, activity만 모르는 서버에는 가장 새 값부터 한 번 물러서며 다음부터는 곧장 doorbell,tools를 묻는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      knows(input, ["doorbell", "tools"]) ? ok() : bad()
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAgentRunEvents(WS, RUN, all)).resolves.toMatchObject({ runId: RUN });
    await fetchAgentRunEvents(WS, RUN, all);
    expect(urls(fetchMock)).toEqual([path("doorbell,tools,activity"), path("doorbell,tools"), path("doorbell,tools")]);
  });

  it("doorbell만 아는 서버: 세 칸째에서 읽고 둘 다 기억한다. 쿼리 없이도 400이면(틀린 id) 아무것도 기억하지 않는다", async () => {
    installHost();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      knows(input, ["doorbell"]) ? ok() : bad()
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgentRunEvents(WS, RUN, all);
    await fetchAgentRunEvents(WS, RUN, all);
    expect(urls(fetchMock)).toEqual([
      path("doorbell,tools,activity"),
      path("doorbell,tools"),
      path("doorbell"),
      path("doorbell"),
    ]);
    resetRunLedgerIncludeProbe();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => bad());
    await expect(fetchAgentRunEvents(WS, RUN, all)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockImplementation(async () => ok());
    await fetchAgentRunEvents(WS, RUN, all);
    expect(urls(fetchMock).at(-1)).toBe(path("doorbell,tools,activity"));
  });
});
