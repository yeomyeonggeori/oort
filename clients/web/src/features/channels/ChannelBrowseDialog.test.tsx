// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import type { BrowseChannel } from "@momo/core/features/channels/browse";
import enChannels from "@momo/core/i18n/catalogs/en-US/channels.json";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { ChannelBrowseProvider } from "./ChannelBrowseDialog";
import { useOpenChannelBrowse } from "./useChannelBrowse";

// 채널 둘러보기 창 (ADR-0224 화면 · D3 · D4, #5842). 서버 계약(E2 #5838 인계 0절)은 코어 `browse.test.ts` 가 잰다. 여기서는 그
// 두 함수의 답을 흉내 내고 화면이 그 답으로 무엇을 하는지만 본다.
//   1. 줄은 서버 목록 그대로다 — 화면이 내 채널 캐시(꺼진 공개 · 비공개 포함)를 섞지 않는다. 참여하지 않은 줄이 위.
//   2. 참여 → 응답의 채널이 사이드바 캐시에 서고, 명부에 내가 들고, 그 채널로 가며 창이 닫힌다. 두 번 눌러도 요청은 하나.
//   3. 실패: 404 는 줄을 걷고 그 자리에 문장, 429 · 망은 줄에 문장과 다시 시도.
//   4. 조합 중인 글자는 서버에 보내지 않고(확정된 글자만), 받은 줄을 화면에서 좁힌다.

const EN = enChannels as Record<string, string>;
const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const id = (n: number) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;

const core = vi.hoisted(() => ({ browseChannels: vi.fn(), joinChannel: vi.fn(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/features/channels/browse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/channels/browse")>()),
  browseChannels: (...args: unknown[]) => core.browseChannels(...args),
  joinChannel: (...args: unknown[]) => core.joinChannel(...args),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  fetchRoster: (...args: unknown[]) => core.fetchRoster(...args),
}));
vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient;

const session: SessionContextValue = {
  session: {
    accessToken: "a",
    refreshToken: "r",
    member: { id: ME, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: WS,
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

const SELF: RosterMember = {
  id: ME,
  workspaceId: WS,
  kind: "human",
  status: "active",
  role: "member",
  displayName: "김도현",
  handle: "dohyeon",
  channelCount: 1,
  channelIds: [id(1)],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
};

const row = (n: number, name: string, isMember = false, extra: Partial<BrowseChannel> = {}): BrowseChannel => ({
  id: id(n),
  name,
  memberCount: 3,
  isMember,
  isDefault: false,
  ...extra,
});
const channelOf = (r: BrowseChannel): Channel => ({
  id: r.id,
  workspaceId: WS,
  kind: "public",
  name: r.name,
  muted: false,
  browseListed: true,
  isDefault: r.isDefault,
});

function Opener() {
  const open = useOpenChannelBrowse();
  return createElement("button", { "data-testid": "opener", onClick: () => open?.() }, "open");
}
function Where() {
  return createElement("span", { "data-testid": "where" }, useLocation().pathname);
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}

async function mountAndOpen(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: session },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(ChannelBrowseProvider, null, createElement(Opener), createElement(Where))
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector<HTMLElement>('[data-testid="opener"]')?.click();
    await Promise.resolve();
  });
  await flush();
}

const rowIds = () =>
  Array.from(document.querySelectorAll('[data-testid="channel-browse-row"]')).map((node) => node.getAttribute("data-channel-id"));
const rowOf = (n: number) => document.querySelector<HTMLElement>(`[data-testid="channel-browse-row"][data-channel-id="${id(n)}"]`);

function setInput(value: string, composing: boolean) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="channel-browse-search"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: composing, data: value.slice(-1) }));
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  core.browseChannels.mockReset();
  core.joinChannel.mockReset();
  core.fetchRoster.mockReset();
  core.fetchRoster.mockResolvedValue([SELF]);
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

describe("채널 둘러보기 창", () => {
  it("줄은 서버 목록 그대로이고(내 채널 캐시를 섞지 않는다) 참여하지 않은 채널이 위에 선다", async () => {
    // 내 채널 캐시: 서버 목록에 없는 꺼진 공개 채널과 비공개 채널이 있다. 둘러보기에 나오면 안 된다.
    client.setQueryData<Channel[]>(["channels", WS], [
      { id: id(1), workspaceId: WS, kind: "public", name: "general", muted: false, browseListed: true, isDefault: true },
      { id: id(5), workspaceId: WS, kind: "public", name: "숨은-공개", muted: false, browseListed: false },
      { id: id(6), workspaceId: WS, kind: "private", name: "리더-회의", muted: false },
    ]);
    core.browseChannels.mockResolvedValue({
      channels: [row(1, "general", true, { isDefault: true }), row(11, "출시-준비"), row(12, "고객-지원", false, { topic: "문의 정리" })],
    });
    await mountAndOpen();
    expect(rowIds()).toEqual([id(11), id(12), id(1)]);
    expect(document.querySelector('[data-testid="channel-browse-not-joined"]')?.textContent).toContain("출시-준비");
    expect(rowOf(1)?.querySelector('[data-testid="channel-browse-joined"]')).not.toBeNull();
    expect(rowOf(1)?.querySelector('[data-testid="channel-browse-default"]')).not.toBeNull();
    expect(rowOf(12)?.textContent).toContain("문의 정리");
  });

  it("참여하면 응답의 채널이 사이드바 캐시와 명부에 서고 그 채널로 간다 — 두 번 눌러도 요청은 하나", async () => {
    client.setQueryData<Channel[]>(["channels", WS], [{ id: id(1), workspaceId: WS, kind: "public", name: "general", muted: false }]);
    const target = row(11, "출시-준비");
    core.browseChannels.mockResolvedValue({ channels: [target] });
    // 명부 다시 읽기는 붙잡아 둔다: 다시 읽기 덕이 아니라 참여한 순간 명부에 내가 들어야 한다(머리의 멤버 수, #5784 와 같은 까닭).
    core.fetchRoster.mockReset();
    core.fetchRoster.mockResolvedValueOnce([SELF]).mockReturnValue(new Promise(() => undefined));
    let answer!: (value: unknown) => void;
    core.joinChannel.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mountAndOpen();
    await flush();
    const join = rowOf(11)?.querySelector<HTMLButtonElement>('[data-testid="channel-browse-join"]');
    act(() => {
      join?.click();
      join?.click();
    });
    expect(core.joinChannel).toHaveBeenCalledTimes(1);
    expect(core.joinChannel).toHaveBeenCalledWith(WS, id(11));
    expect(join?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      answer({ channel: channelOf(target), newlyJoined: true });
      await Promise.resolve();
    });
    await flush();
    expect(client.getQueryData<Channel[]>(["channels", WS])?.map((c) => c.id)).toContain(id(11));
    expect(client.getQueryData<RosterMember[]>(rosterQueryKey(WS))?.find((m) => m.id === ME)?.channelIds).toContain(id(11));
    expect(document.querySelector('[data-testid="where"]')?.textContent).toBe(`/c/${id(11)}`);
    expect(document.querySelector('[data-testid="channel-browse-dialog"]')).toBeNull();
  });

  it("404 는 그 줄을 걷고 그 자리에 문장이 서며, 429 · 망 오류는 줄에 문장과 다시 시도가 선다", async () => {
    core.browseChannels.mockResolvedValue({ channels: [row(11, "꺼진-채널"), row(12, "바쁜-채널"), row(13, "끊긴-채널")] });
    core.joinChannel.mockImplementation(async (_ws: string, channelId: string) => {
      if (channelId === id(11)) throw new ApiError(404, "channel not found");
      if (channelId === id(12)) throw new ApiError(429, "rate limited", undefined, 30);
      throw new NetworkError("unreachable", 15_000);
    });
    await mountAndOpen();
    for (const n of [11, 12, 13]) {
      await act(async () => {
        rowOf(n)?.querySelector<HTMLButtonElement>('[data-testid="channel-browse-join"]')?.click();
        await Promise.resolve();
      });
      await flush();
    }
    // 404: 줄의 단추가 걷히고 같은 자리에 문장.
    expect(rowOf(11)?.hasAttribute("data-gone")).toBe(true);
    expect(rowOf(11)?.querySelector('[data-testid="channel-browse-join"]')).toBeNull();
    expect(rowOf(11)?.textContent).toContain(EN["channels.browse.joinNotFound"]);
    // 429: 그 줄에 문장, 단추는 다시 시도.
    expect(rowOf(12)?.querySelector('[data-testid="channel-browse-row-error"]')?.textContent).toBe(EN["channels.browse.rateLimited"]);
    expect(rowOf(12)?.querySelector('[data-testid="channel-browse-join"]')?.textContent).toBe(EN["channels.browse.retry"]);
    // 망: 전송 계층의 문장을 싣는다.
    expect(rowOf(13)?.querySelector('[data-testid="channel-browse-row-error"]')?.textContent).toBe(
      EN["channels.browse.joinNetwork"].replace("{reason}", new NetworkError("unreachable", 15_000).message)
    );
    // 다시 시도는 다시 보낸다.
    core.joinChannel.mockClear();
    await act(async () => {
      rowOf(12)?.querySelector<HTMLButtonElement>('[data-testid="channel-browse-join"]')?.click();
      await Promise.resolve();
    });
    expect(core.joinChannel).toHaveBeenCalledWith(WS, id(12));
  });

  it("조합 중인 글자는 서버에 보내지 않고, 받은 줄을 마지막 글자까지 느슨하게 좁힌다", async () => {
    core.browseChannels.mockResolvedValue({ channels: [row(11, "디자인-리뷰"), row(12, "디저트-모임"), row(13, "백엔드")] });
    await mountAndOpen();
    expect(core.browseChannels).toHaveBeenCalledTimes(1);
    expect(core.browseChannels.mock.calls[0][1]).toMatchObject({ q: "" });
    const input = document.querySelector<HTMLInputElement>('[data-testid="channel-browse-search"]')!;
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });
    // 「디자인」을 치는 입력기의 중간 단계: 디 → 디ㅈ → 디자 → 디장.
    for (const step of ["디", "디ㅈ", "디자", "디장"]) {
      act(() => setInput(step, true));
    }
    expect(rowIds()).toEqual([id(11)]);
    await flush(400);
    expect(core.browseChannels).toHaveBeenCalledTimes(1);
    // 조합이 끝나면 그 값이 서버로 간다(쉬는 시간 뒤 한 번).
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "장" }));
    });
    await flush(400);
    expect(core.browseChannels).toHaveBeenCalledTimes(2);
    expect(core.browseChannels.mock.calls[1][1]).toMatchObject({ q: "디장" });
  });
});
