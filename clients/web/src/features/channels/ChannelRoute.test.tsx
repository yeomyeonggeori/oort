// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import type { ChannelPreview } from "@momo/core/features/channels/browse";
import enChannels from "@momo/core/i18n/catalogs/en-US/channels.json";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ChannelRoute } from "./ChannelRoute";

// 공개 채널 미리 보기 (ADR-0224 D5 · 화면 웹 줄 ③, #5844). `/c/{id}` 의 자리를 고르는 길(`ChannelRoute`)을 지나서 잰다 — 미리 보기
// 화면만 따로 그리면 `ChatShell` 이 옆에 서 있어도 통과한다. `ChatShell` 은 마운트되는 순간 이력 읽기 · 구독 · 읽음 알림을 거는 부품이라
// (여기서는 서 있는지만 보이는 표지 하나로 바꿨다), 「참여하지 않은 채널에서 그것들이 돌지 않는다」는 `ChatShell` 이 서지 않는 것과
// 서버 호출이 미리 보기 하나뿐인 것으로 잰다.
//   1. 내 목록에 없는 id 는 미리 보기, 있는 id 는 대화. 낡은 목록은 한 번 새로 읽고 그래도 없을 때만 미리 보기.
//   2. 꺼진 · 없는 채널(404)은 구별 없이 「찾을 수 없음」 한 화면, 게스트(403)는 권한 문장, 그 밖은 다시 시도.
//   3. 누를 수 있는 것은 「참여」 하나 — 입력창 · 반응 · 스레드 · 첨부 열기가 없다. 글은 오래된 것이 위.
//   4. 「참여」 → 두 번 눌러도 요청 1, 같은 주소가 대화로 바뀐다.

vi.mock("@/features/chat/ChatShell", () => ({
  ChatShell: () => createElement("div", { "data-testid": "chat-shell" }),
}));
vi.mock("@/app/SidebarDrawerToggle", () => ({ SidebarDrawerToggle: () => null }));
vi.mock("@/features/common/useOffline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/common/useOffline")>()),
  useOffline: () => false,
}));

const core = vi.hoisted(() => ({ previewChannel: vi.fn(), joinChannel: vi.fn(), listChannels: vi.fn(), fetchRoster: vi.fn() }));
vi.mock("@momo/core/features/channels/browse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/channels/browse")>()),
  previewChannel: (...args: unknown[]) => core.previewChannel(...args),
  joinChannel: (...args: unknown[]) => core.joinChannel(...args),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/lib/api")>()),
  listChannels: (...args: unknown[]) => core.listChannels(...args),
  fetchRoster: (...args: unknown[]) => core.fetchRoster(...args),
}));

const EN = enChannels as Record<string, string>;
const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const id = (n: number) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const MINE: Channel = { id: id(1), workspaceId: WS, kind: "public", name: "general", muted: false };
const JOINED: Channel = { id: id(11), workspaceId: WS, kind: "public", name: "출시-준비", muted: false, browseListed: true };

const PREVIEW: ChannelPreview = {
  channel: { id: id(11), name: "출시-준비", topic: "v0.2 일정", memberCount: 7, isMember: false },
  // 서버 차례: 0번이 가장 최근.
  messages: [
    { id: "m4", body: "회의록 올려요.", author: { displayName: "박지후", kind: "human" }, createdAtMs: 4000, edited: false, deleted: false, replyCount: 0, attachmentNames: ["회의록.pdf"] },
    { id: "m3", author: { kind: "human" }, createdAtMs: 3000, edited: false, deleted: true, replyCount: 0, attachmentNames: [] },
    { id: "m2", body: "확인했어요.", author: { displayName: "박지후", kind: "human" }, createdAtMs: 2000, edited: true, deleted: false, replyCount: 0, attachmentNames: [] },
    { id: "m1", body: "체크리스트를 정리했어요.", author: { displayName: "이서윤", kind: "human" }, createdAtMs: 1000, edited: false, deleted: false, replyCount: 2, attachmentNames: [] },
  ],
};

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

function Where() {
  return createElement("span", { "data-testid": "where" }, useLocation().pathname);
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}

/** `list` 는 내 채널 목록 캐시, `ageMs` 는 그 목록을 읽은 지 얼마나 됐는가(낡은 목록은 한 번 새로 읽는다). */
async function mountAt(channelId: string, list: Channel[] | null, ageMs = 0): Promise<void> {
  if (list !== null) client.setQueryData(["channels", WS], list, { updatedAt: Date.now() - ageMs });
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
        { initialEntries: [`/c/${channelId}`] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: "c/:channelId", element: createElement(ChannelRoute) })
        ),
        createElement(Where)
      )
    )
  );
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
  await flush();
  await flush();
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  core.previewChannel.mockReset();
  core.joinChannel.mockReset();
  core.listChannels.mockReset();
  core.fetchRoster.mockReset();
  core.fetchRoster.mockResolvedValue([]);
  core.listChannels.mockResolvedValue([MINE]);
  core.previewChannel.mockResolvedValue(PREVIEW);
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

describe("공개 채널 미리 보기 — /c/{id} 의 자리", () => {
  it("내 목록에 없는 id 는 미리 보기(대화 부품 없음, 서버 호출은 미리 보기 하나), 있는 id 는 대화다", async () => {
    await mountAt(id(11), [MINE]);
    expect(q("channel-preview")).not.toBeNull();
    expect(q("chat-shell")).toBeNull();
    expect(core.previewChannel).toHaveBeenCalledTimes(1);
    expect(core.previewChannel).toHaveBeenCalledWith(WS, id(11));
    // 방금 읽은 목록은 한 번 더 읽지 않는다.
    expect(core.listChannels).not.toHaveBeenCalled();
    expect(core.joinChannel).not.toHaveBeenCalled();
    expect(q("channel-preview-title")?.textContent).toBe("출시-준비");
    expect(q("channel-preview-topic")?.textContent).toBe("v0.2 일정");

    act(() => root?.unmount());
    root = null;
    host?.remove();
    core.previewChannel.mockClear();
    await mountAt(id(1), [MINE]);
    expect(q("chat-shell")).not.toBeNull();
    expect(q("channel-preview")).toBeNull();
    expect(core.previewChannel).not.toHaveBeenCalled();
  });

  it("낡은 목록은 한 번 새로 읽고, 그 사이에 든 채널이면 미리 보기 없이 대화로 간다", async () => {
    core.listChannels.mockResolvedValue([MINE, JOINED]);
    await mountAt(id(11), [MINE], 60_000);
    expect(core.listChannels).toHaveBeenCalledTimes(1);
    expect(q("chat-shell")).not.toBeNull();
    expect(core.previewChannel).not.toHaveBeenCalled();
  });

  it("낡은 목록을 새로 읽어도 없으면 그때 미리 보기다 — 확인은 한 번", async () => {
    await mountAt(id(11), [MINE], 60_000);
    expect(core.listChannels).toHaveBeenCalledTimes(1);
    expect(q("channel-preview")).not.toBeNull();
    expect(core.previewChannel).toHaveBeenCalledTimes(1);
  });

  it("글은 오래된 것이 위이고, 고쳐짐 · 지워짐 · 답글 수 · 첨부 이름과 잠김 문장이 서며, 누를 수 있는 것은 「참여」 하나다", async () => {
    await mountAt(id(11), [MINE]);
    const rows = Array.from(document.querySelectorAll('[data-testid="channel-preview-message"]'));
    expect(rows.map((row) => row.getAttribute("data-message-id"))).toEqual(["m1", "m2", "m3", "m4"]);
    expect(rows[0].textContent).toContain("체크리스트를 정리했어요.");
    expect(rows[0].querySelector('[data-testid="channel-preview-replies"]')?.textContent).toMatch(/2/);
    expect(rows[1].querySelector('[data-testid="channel-preview-edited"]')).not.toBeNull();
    expect(rows[2].querySelector('[data-testid="tombstone"]')).not.toBeNull();
    // 지워진 글의 글쓴이 이름이 없으면 기존 「나간 멤버」 말씨.
    expect(rows[2].textContent).toContain("나간 멤버");
    expect(rows[3].textContent).toContain("회의록.pdf");
    expect(rows[3].querySelector('[data-testid="channel-preview-locked"]')?.textContent).toBe(EN["channels.preview.attachmentLocked"]);
    // 누를 수 있는 것: 「참여」 하나. 입력창 · 반응 · 호버 동작 · 스레드 열기 · 링크가 없다.
    expect(Array.from(document.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"))).toEqual(["channel-preview-join"]);
    expect(document.querySelectorAll("textarea, input, [contenteditable], a[href]").length).toBe(0);
  });

  it("꺼진 · 없는 채널(404)은 구별 없이 「찾을 수 없음」 한 화면이고 참여 단추가 없다", async () => {
    core.previewChannel.mockRejectedValue(new ApiError(404, "channel not found"));
    await mountAt(id(11), [MINE]);
    expect(q("channel-preview")?.getAttribute("data-state")).toBe("gone");
    expect(q("channel-preview-gone")?.textContent).toBe(EN["channels.preview.notFound"]);
    expect(q("channel-preview-join")).toBeNull();
    expect(q("chat-shell")).toBeNull();
  });

  it("게스트(403)는 권한 문장이고 다시 시도 · 참여가 없으며, 그 밖의 실패는 다시 시도가 선다", async () => {
    core.previewChannel.mockRejectedValue(new ApiError(403, "guests cannot browse or join public channels"));
    await mountAt(id(11), [MINE]);
    expect(q("channel-preview-error")?.textContent).toBe(EN["channels.preview.loadForbidden"]);
    expect(q("channel-preview-join")).toBeNull();

    act(() => root?.unmount());
    root = null;
    host?.remove();
    client.clear();
    core.previewChannel.mockReset();
    core.previewChannel.mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue(PREVIEW);
    await mountAt(id(11), [MINE]);
    expect(q("channel-preview-error")?.textContent).toContain(EN["channels.browse.retry"]);
    await act(async () => {
      q("channel-preview-error")?.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    await flush();
    expect(q("channel-preview")?.getAttribute("data-state")).toBe("list");
    expect(core.previewChannel).toHaveBeenCalledTimes(2);
  });

  it("「참여」는 두 번 눌러도 요청이 하나이고, 성공하면 같은 주소가 대화로 바뀐다", async () => {
    let answer!: (value: unknown) => void;
    core.joinChannel.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mountAt(id(11), [MINE]);
    // 참여한 뒤 서버의 목록은 그 채널을 싣는다(참여가 목록을 다시 읽게 한다).
    core.listChannels.mockResolvedValue([MINE, JOINED]);
    const join = q("channel-preview-join") as HTMLButtonElement;
    act(() => {
      join.click();
      join.click();
    });
    expect(core.joinChannel).toHaveBeenCalledTimes(1);
    expect(core.joinChannel).toHaveBeenCalledWith(WS, id(11));
    expect(join.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      answer({ channel: JOINED, newlyJoined: true });
      await Promise.resolve();
    });
    await flush();
    expect(client.getQueryData<Channel[]>(["channels", WS])?.map((c) => c.id)).toContain(id(11));
    expect(q("chat-shell")).not.toBeNull();
    expect(q("channel-preview")).toBeNull();
    expect(q("where")?.textContent).toBe(`/c/${id(11)}`);
  });

  it("참여가 실패하면 띠 위에 한 줄 문장이 서고 단추는 다시 시도가 된다", async () => {
    core.joinChannel.mockRejectedValue(new ApiError(429, "rate limited", undefined, 30));
    await mountAt(id(11), [MINE]);
    await act(async () => {
      (q("channel-preview-join") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await flush();
    expect(q("channel-preview-join-error")?.textContent).toBe(EN["channels.browse.rateLimited"]);
    expect(q("channel-preview-join")?.textContent).toBe(EN["channels.browse.retry"]);
    expect(q("channel-preview")).not.toBeNull();
  });
});
