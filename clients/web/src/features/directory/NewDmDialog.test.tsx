// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { NewDmProvider } from "./NewDmDialog";
import { useOpenNewDm } from "./useNewDm";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const DOHYUN = "00000000-0000-7000-8000-000000000111";
const SEOYEON = "00000000-0000-7000-8000-000000000112";
const INTERN = "00000000-0000-7000-8000-000000000114";
const SUSPENDED = "00000000-0000-7000-8000-000000000115";
const EXISTING_DM = "00000000-0000-7000-8000-000000000301";
const CREATED_DM = "00000000-0000-7000-8000-000000000399";

const openDirectMessage = vi.fn();
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  openDirectMessage: (...args: unknown[]) => openDirectMessage(...args),
}));

function member(id: string, patch: Partial<RosterMember>): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...patch,
  };
}
const roster = [
  member(ME, { displayName: "곽성재", handle: "seongjae" }),
  member(DOHYUN, { displayName: "이도현", handle: "dohyun" }),
  member(SEOYEON, { displayName: "박서연", handle: "seoyeon" }),
  member(INTERN, { displayName: "김인턴", handle: "intern", kind: "agent" }),
  member(SUSPENDED, { displayName: "정지된사람", handle: "gone", status: "suspended" }),
];
const dmWithDohyun: Channel = {
  id: EXISTING_DM,
  workspaceId: WS,
  kind: "dm",
  muted: false,
  memberIds: [ME, DOHYUN],
} as Channel;

const channelsState = { dms: [dmWithDohyun] as Channel[] };
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({ groups: { channels: [], dms: channelsState.dms } }),
    useDirectory: () => ({
      directory: makeDirectory(roster),
      isPending: false,
      error: null,
      refetch: () => undefined,
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

const session: SessionContextValue = {
  session: {
    accessToken: "a",
    refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

function Opener() {
  const open = useOpenNewDm();
  return createElement("button", { "data-testid": "opener", onClick: (e: React.MouseEvent<HTMLElement>) => open(e.currentTarget) }, "열기");
}
function Where() {
  return createElement("span", { "data-testid": "where" }, useLocation().pathname);
}

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(NewDmProvider, null, createElement(Opener), createElement(Where))
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  return host;
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="new-dm-dialog"]');
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="new-dm-row"]')];
const where = () => document.querySelector('[data-testid="where"]')!.textContent;
async function openDialog(h: HTMLElement) {
  await act(async () => {
    h.querySelector<HTMLElement>('[data-testid="opener"]')!.click();
    await Promise.resolve();
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  channelsState.dms = [dmWithDohyun];
  openDirectMessage.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("새 다이렉트 메시지 모달 (#3662)", () => {
  it("닫혀 있을 때는 마운트되지 않고, 열면 받는 사람 검색 칸에 캐럿이 선다", async () => {
    const h = await mount();
    expect(dialog()).toBeNull();
    await openDialog(h);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("new-dm-search");
  });

  it("목록은 나와 활동 중이 아닌 멤버를 뺀 사람·에이전트고, 이미 DM이 있는 사람만 「대화 중」이다", async () => {
    const h = await mount();
    await openDialog(h);
    const names = rows().map((r) => r.getAttribute("data-member-id"));
    expect(names.sort()).toEqual([DOHYUN, SEOYEON, INTERN].sort());
    expect(document.querySelector('[data-testid="new-dm-agents"]')).not.toBeNull();
    const withDm = rows().filter((r) => r.hasAttribute("data-has-dm")).map((r) => r.getAttribute("data-member-id"));
    expect(withDm).toEqual([DOHYUN]);
  });

  it("이름·핸들로 거르고, 일치가 없으면 비어 있음을 말한다", async () => {
    const h = await mount();
    await openDialog(h);
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-dm-search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "seoyeon");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((r) => r.getAttribute("data-member-id"))).toEqual([SEOYEON]);
    await act(async () => {
      set.call(input, "zzzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="new-dm-no-match"]')).not.toBeNull();
  });

  it("이미 DM이 있는 사람을 고르면 만들지 않고 그 DM으로 이동하고 닫힌다", async () => {
    const h = await mount();
    await openDialog(h);
    await act(async () => {
      rows().find((r) => r.getAttribute("data-member-id") === DOHYUN)!.click();
      await Promise.resolve();
    });
    expect(openDirectMessage).not.toHaveBeenCalled();
    expect(where()).toBe(`/c/${EXISTING_DM}`);
    expect(dialog()).toBeNull();
  });

  it("DM이 없는 사람을 고르면 POST /dms로 만들고 서버가 준 DM으로 이동하고 닫힌다", async () => {
    openDirectMessage.mockResolvedValue({ channel: { id: CREATED_DM, workspaceId: WS, kind: "dm", muted: false, memberIds: [ME, SEOYEON] } });
    const h = await mount();
    await openDialog(h);
    await act(async () => {
      rows().find((r) => r.getAttribute("data-member-id") === SEOYEON)!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openDirectMessage).toHaveBeenCalledTimes(1);
    expect(openDirectMessage).toHaveBeenCalledWith(WS, SEOYEON);
    expect(where()).toBe(`/c/${CREATED_DM}`);
    expect(dialog()).toBeNull();
  });

  it("만들기가 실패하면 모달이 열린 채 그 사람 행 아래에 이유가 선다", async () => {
    openDirectMessage.mockRejectedValue(new Error("boom"));
    const h = await mount();
    await openDialog(h);
    await act(async () => {
      rows().find((r) => r.getAttribute("data-member-id") === SEOYEON)!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dialog()).not.toBeNull();
    expect(where()).toBe("/");
    expect(document.querySelector('[data-testid="new-dm-error"]')).not.toBeNull();
  });

  it("검색 결과가 한 명이면 Enter 한 번으로 고른다", async () => {
    const h = await mount();
    await openDialog(h);
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-dm-search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "dohyun");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(where()).toBe(`/c/${EXISTING_DM}`);
  });

  it("검색 칸에서 ↓ 로 목록에 들어가고, 목록에서 ↑ 로 첫 행에서 검색 칸으로 돌아온다", async () => {
    const h = await mount();
    await openDialog(h);
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-dm-search"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows()[0]);
    await act(async () => {
      rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows()[1]);
    await act(async () => {
      rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
  });
});
