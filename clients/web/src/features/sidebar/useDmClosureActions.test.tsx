// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadState } from "@momo/core/lib/api";
import { dmClosureFolded, resetDmClosureFoldForTest } from "./dmClosureModel";
import { closedAtSeqOf, closedDmsFor, reloadClosedDmsForTest } from "./sidebarDmClosure";
import { useDmClosureActions, type DmClosureActions } from "./useDmVisibility";

// 닫기·다시 열기 쓰기 (ADR-0177 D7·D8·D10, #4228): 쓴 기기는 성공을 기다리지 않고 캐시 행에 먼저 적고, 실패하면 되돌린다.

const WS = "00000000-0000-7000-8000-000000000001";
const DM = "00000000-0000-7000-8000-000000000301";
const OTHER = "00000000-0000-7000-8000-000000000302";

const wire = vi.hoisted(() => ({
  calls: [] as string[],
  fail: null as number | null,
  gate: null as Promise<void> | null,
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  const answer = async (label: string) => {
    wire.calls.push(label);
    if (wire.gate !== null) await wire.gate;
    if (wire.fail !== null) throw new actual.ApiError(wire.fail, "x");
  };
  return {
    ...actual,
    closeDm: (_ws: string, channelId: string, seenSeq: number) => answer(`PUT ${channelId} ${seenSeq}`),
    reopenDm: (_ws: string, channelId: string) => answer(`DELETE ${channelId}`),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;
let actions: DmClosureActions;

function row(channelId: string, patch: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    latestReadableSeq: 10,
    closedAtSeq: null,
    ...patch,
  };
}
const cached = (channelId: string) =>
  client.getQueryData<ReadState[]>(["read-state", WS])?.find((r) => r.channelId === channelId);

function Probe(props: { mode: "server" | "legacy" | "unknown"; rows: ReadState[] }) {
  actions = useDmClosureActions({
    workspaceId: WS,
    mode: props.mode,
    byChannel: new Map(props.rows.map((r) => [r.channelId.toLowerCase(), r])),
  });
  return null;
}

async function mount(mode: "server" | "legacy" | "unknown", rows: ReadState[]): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<ReadState[]>(["read-state", WS], rows);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(Probe, { mode, rows })));
    await Promise.resolve();
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  wire.calls.length = 0;
  wire.fail = null;
  wire.gate = null;
  localStorage.clear();
  reloadClosedDmsForTest(null);
  resetDmClosureFoldForTest();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  reloadClosedDmsForTest(null);
});

describe("닫기 (D7·D10)", () => {
  it("서버 갈래: 성공을 기다리지 않고 캐시 행에 먼저 적는다 - 쓴 기기는 즉시 반영한다", async () => {
    await mount("server", [row(DM), row(OTHER)]);
    let release: () => void = () => undefined;
    wire.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done: Promise<boolean> | undefined;
    await act(async () => {
      done = actions.close(DM, 10);
      await Promise.resolve();
    });
    // 아직 서버 응답 전이다: 캐시는 이미 닫혀 있다.
    expect(cached(DM)?.closedAtSeq).toBe(10);
    expect(cached(OTHER)?.closedAtSeq).toBeNull();
    release();
    await act(async () => {
      expect(await done).toBe(true);
    });
    expect(wire.calls).toEqual([`PUT ${DM} 10`]);
    expect(cached(DM)?.closedAtSeq).toBe(10);
    // 서버 갈래는 이 기기의 원장에 쓰지 않는다.
    expect(closedDmsFor(WS)).toEqual({});
  });

  it("실패하면 되돌리고 false 를 준다", async () => {
    wire.fail = 500;
    await mount("server", [row(DM, { closedAtSeq: null })]);
    await act(async () => {
      expect(await actions.close(DM, 10)).toBe(false);
    });
    expect(cached(DM)?.closedAtSeq).toBeNull();
    expect(dmClosureFolded(WS)).toBe(false);
  });

  it("404 는 경로가 없다는 뜻이 아니다(그 DM 이 없다): 되돌리고 접지 않는다", async () => {
    wire.fail = 404;
    await mount("server", [row(DM)]);
    await act(async () => {
      expect(await actions.close(DM, 10)).toBe(false);
    });
    expect(dmClosureFolded(WS)).toBe(false);
    expect(closedDmsFor(WS)).toEqual({});
  });

  it("405 는 경로가 없다: 이 워크스페이스를 접고 이 닫기를 원장에 쓴다(사람이 한 닫기가 사라지지 않는다)", async () => {
    wire.fail = 405;
    await mount("server", [row(DM)]);
    await act(async () => {
      expect(await actions.close(DM, 9)).toBe(true);
    });
    expect(dmClosureFolded(WS)).toBe(true);
    expect(closedAtSeqOf(closedDmsFor(WS), DM)).toBe(9);
    expect(cached(DM)?.closedAtSeq).toBeNull();
  });

  it("legacy·unknown 갈래는 서버에 아무것도 보내지 않고 원장에 쓴다", async () => {
    for (const mode of ["legacy", "unknown"] as const) {
      await mount(mode, [row(DM, { closedAtSeq: undefined, latestReadableSeq: undefined })]);
      await act(async () => {
        await actions.close(DM, 7);
      });
      expect(closedAtSeqOf(closedDmsFor(WS), DM)).toBe(7);
      act(() => root?.unmount());
      root = null;
      host?.remove();
      host = null;
      reloadClosedDmsForTest(null);
    }
    expect(wire.calls).toEqual([]);
  });
});

describe("다시 열기 (D8)", () => {
  it("닫은 적이 있으면 DELETE 를 보내고 캐시 행의 닫힘을 먼저 푼다", async () => {
    await mount("server", [row(DM, { closedAtSeq: 10 })]);
    await act(async () => {
      expect(await actions.reopen(DM)).toBe(true);
    });
    expect(wire.calls).toEqual([`DELETE ${DM}`]);
    expect(cached(DM)?.closedAtSeq).toBeNull();
  });

  it("닫은 적이 없으면(null) 왕복도 만들지 않는다 - 나간 상대의 DM 을 열 때도 마찬가지다", async () => {
    await mount("server", [row(DM, { closedAtSeq: null })]);
    await act(async () => {
      expect(await actions.reopen(DM)).toBe(true);
    });
    expect(wire.calls).toEqual([]);
  });

  it("닫힘을 말하지 않은 행(undefined)이나 행이 없는 DM 에도 보내지 않는다", async () => {
    await mount("server", [row(DM, { closedAtSeq: undefined })]);
    await act(async () => {
      expect(await actions.reopen(DM)).toBe(true);
      expect(await actions.reopen(OTHER)).toBe(true);
    });
    expect(wire.calls).toEqual([]);
  });

  it("실패하면 닫힘을 되돌려 놓고 false 를 준다. 404 는 이미 닫혀 있지 않은 것과 같아 true 다", async () => {
    wire.fail = 500;
    await mount("server", [row(DM, { closedAtSeq: 10 })]);
    await act(async () => {
      expect(await actions.reopen(DM)).toBe(false);
    });
    expect(cached(DM)?.closedAtSeq).toBe(10);
    wire.fail = 404;
    await act(async () => {
      expect(await actions.reopen(DM)).toBe(true);
    });
  });

  it("legacy 갈래는 원장 항목을 지운다", async () => {
    await mount("legacy", [row(DM, { closedAtSeq: undefined, latestReadableSeq: undefined })]);
    await act(async () => {
      await actions.close(DM, 7);
      await actions.reopen(DM);
    });
    expect(closedDmsFor(WS)).toEqual({});
    expect(wire.calls).toEqual([]);
  });
});
