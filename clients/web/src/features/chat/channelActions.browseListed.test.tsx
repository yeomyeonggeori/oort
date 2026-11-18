// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ApiError, type Channel, type MembershipRole } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import enChannels from "@momo/core/i18n/catalogs/en-US/channels.json";
import { useChannelActions, type ChannelActions } from "./channelActions";

// 채널 머리 ⋮ 의 「둘러보기에 보이기」 줄 (ADR-0224 D2, #5843). 서버 계약은 코어 `browse.test.ts` 가 잰다. 여기서는 줄이 누구에게 서고,
// 누르면 요청이 나가 캐시가 응답으로 바뀌며, 실패가 문장으로 말해지는지만 본다.

const core = vi.hoisted(() => ({ setChannelBrowseListed: vi.fn() }));
vi.mock("@momo/core/features/channels/browse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/channels/browse")>()),
  setChannelBrowseListed: (...args: unknown[]) => core.setChannelBrowseListed(...args),
}));

const EN = enChannels as Record<string, string>;
const channelRow = (extra: Partial<Channel> = {}): Channel => ({
  id: "c1",
  workspaceId: "ws",
  kind: "public",
  name: "출시-준비",
  muted: false,
  browseListed: true,
  ...extra,
});

async function mountActions(channel: Channel, role: MembershipRole | undefined) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(["channels", "ws"], [channel]);
  const ref: { actions: ChannelActions | null } = { actions: null };
  function Probe() {
    const { data } = useQuery<Channel[]>({ queryKey: ["channels", "ws"], queryFn: async () => [], enabled: false });
    ref.actions = useChannelActions({
      workspaceId: "ws",
      channel: data![0],
      title: "출시-준비",
      selfMemberId: "me",
      selfRole: role,
      onActionSucceeded: () => undefined,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      </MemoryRouter>
    )
  );
  const flush = async () => {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  };
  return {
    client,
    flush,
    actions: () => ref.actions!,
    cleanup: () => {
      act(() => root.unmount());
      client.clear();
    },
  };
}

const headerKeys = (actions: ChannelActions) => actions.items("header").map((item) => item.key);

it.each([
  ["owner", { kind: "public" }, true],
  ["admin", { kind: "public", browseListed: false }, true],
  ["member", { kind: "public" }, false],
  ["guest", { kind: "public" }, false],
  [undefined, { kind: "public" }, false],
  ["owner", { kind: "private" }, false],
  ["owner", { kind: "dm", name: undefined }, false],
  // 표시를 싣지 않는 옛 서버: 문을 세우지 않는다.
  ["owner", { kind: "public", browseListed: undefined }, false],
] as const)("줄은 소유자 · 관리자가 든 공개 채널에만 선다: %s %o -> %s", async (role, extra, shown) => {
  const view = await mountActions(channelRow(extra as Partial<Channel>), role);
  try {
    expect(headerKeys(view.actions()).includes("browse-listed")).toBe(shown);
    // 행 우클릭 메뉴에는 이 줄이 없다.
    expect(view.actions().items("row").some((item) => item.key === "browse-listed")).toBe(false);
  } finally {
    view.cleanup();
  }
});

it("누르면 요청이 한 번 나가고(둘째 누름은 버림) 캐시는 낙관이 아니라 응답의 채널로 바뀐다", async () => {
  core.setChannelBrowseListed.mockReset();
  const view = await mountActions(channelRow({ browseListed: false }), "admin");
  try {
    const item = () => view.actions().items("header").find((row) => row.key === "browse-listed")!;
    expect(item()).toMatchObject({ label: EN["channels.browse.switchLabel"], checked: false });
    let answer!: (value: Channel) => void;
    core.setChannelBrowseListed.mockReturnValue(new Promise<Channel>((resolve) => (answer = resolve)));
    act(() => view.actions().run("browse-listed"));
    act(() => view.actions().run("browse-listed"));
    await view.flush();
    expect(core.setChannelBrowseListed).toHaveBeenCalledTimes(1);
    expect(core.setChannelBrowseListed).toHaveBeenCalledWith("ws", "c1", true);
    expect(view.actions().isPending("browse-listed")).toBe(true);
    // 답이 오기 전에는 바뀌지 않는다.
    expect(item().checked).toBe(false);
    await act(async () => {
      answer(channelRow({ browseListed: true, topic: "서버가 준 주제" }));
    });
    await view.flush();
    expect(view.client.getQueryData<Channel[]>(["channels", "ws"])).toEqual([channelRow({ browseListed: true, topic: "서버가 준 주제" })]);
    expect(item().checked).toBe(true);
    expect(view.actions().isPending("browse-listed")).toBe(false);
  } finally {
    view.cleanup();
  }
});

it.each([
  [new ApiError(409, "only a live public channel can be shown in channel browse", "channel_not_listable"), EN["channels.browse.switchNotListable"]],
  [new ApiError(404, "channel not found"), EN["channels.browse.switchNotFound"]],
  [new ApiError(429, "rate limited", undefined, 30), EN["channels.browse.rateLimited"]],
  [new NetworkError("unreachable", 15_000), EN["channels.browse.switchNetwork"].replace("{reason}", new NetworkError("unreachable", 15_000).message)],
])("실패는 메뉴의 한 줄 문장으로 말하고 값은 그대로다: %o", async (error, sentence) => {
  core.setChannelBrowseListed.mockReset();
  core.setChannelBrowseListed.mockRejectedValue(error);
  const view = await mountActions(channelRow(), "owner");
  try {
    act(() => view.actions().run("browse-listed"));
    await view.flush();
    expect(view.actions().error).toBe(sentence);
    expect(view.actions().items("header").find((row) => row.key === "browse-listed")?.checked).toBe(true);
    expect(view.client.getQueryData<Channel[]>(["channels", "ws"])).toEqual([channelRow()]);
  } finally {
    view.cleanup();
  }
});
