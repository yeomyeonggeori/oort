// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ApiError, type Channel, type MembershipRole } from "@momo/core/lib/api";
import enChannels from "@momo/core/i18n/catalogs/en-US/channels.json";
import { useChannelActions, type ChannelActions } from "./channelActions";

// 채널 머리 ⋮ 의 「기본 채널로 지정」 줄 (ADR-0224 D6, #5845). 서버 계약은 코어 `defaultChannel.test.ts` 가 잰다. 여기서는 줄이 누구에게 서고,
// 누르면 요청이 나가 캐시가 응답으로 바뀌며, 마지막 하나를 끄려 할 때 서버의 문장이 말해지고 누름은 막히지 않는지만 본다.

const core = vi.hoisted(() => ({ setChannelDefault: vi.fn() }));
vi.mock("@momo/core/features/channels/defaultChannel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/channels/defaultChannel")>()),
  setChannelDefault: (...args: unknown[]) => core.setChannelDefault(...args),
}));

const EN = enChannels as Record<string, string>;
const channelRow = (extra: Partial<Channel> = {}): Channel => ({
  id: "c1",
  workspaceId: "ws",
  kind: "public",
  name: "출시-준비",
  muted: false,
  browseListed: true,
  isDefault: true,
  ...extra,
});

/** 목록의 첫 줄이 이 메뉴의 채널이다. 나머지는 내 목록의 다른 채널이다. */
async function mountActions(rows: Channel[], role: MembershipRole | undefined) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["channels", "ws"], rows);
  client.setQueryData(["channel-browse", "ws"], { pages: [] });
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
    item: () => ref.actions!.items("header").find((row) => row.key === "default-channel"),
    cleanup: () => {
      act(() => root.unmount());
      client.clear();
    },
  };
}

it.each([
  ["owner", { kind: "public" }, true],
  ["admin", { kind: "public", isDefault: false }, true],
  ["member", { kind: "public" }, false],
  ["guest", { kind: "public" }, false],
  [undefined, { kind: "public" }, false],
  ["owner", { kind: "private" }, false],
  // 기본 채널 표시를 싣지 않는 옛 서버: 문을 세우지 않는다.
  ["owner", { kind: "public", isDefault: undefined }, false],
] as const)("줄은 소유자 · 관리자가 든 공개 채널에만 선다: %s %o -> %s", async (role, extra, shown) => {
  const view = await mountActions([channelRow(extra as Partial<Channel>)], role);
  try {
    expect(view.item() !== undefined).toBe(shown);
    // 행 우클릭 메뉴에는 이 줄이 없다.
    expect(view.actions().items("row").some((row) => row.key === "default-channel")).toBe(false);
  } finally {
    view.cleanup();
  }
});

it("누르면 요청이 한 번 나가고 캐시는 응답의 채널로 바뀌고 둘러보기 목록은 다시 읽게 한다", async () => {
  core.setChannelDefault.mockReset();
  const view = await mountActions([channelRow({ isDefault: false })], "admin");
  try {
    expect(view.item()).toMatchObject({
      label: EN["channels.default.label"],
      description: EN["channels.default.description"],
      checked: false,
    });
    let answer!: (value: Channel) => void;
    core.setChannelDefault.mockReturnValue(new Promise<Channel>((resolve) => (answer = resolve)));
    act(() => view.actions().run("default-channel"));
    act(() => view.actions().run("default-channel"));
    await view.flush();
    expect(core.setChannelDefault).toHaveBeenCalledTimes(1);
    expect(core.setChannelDefault).toHaveBeenCalledWith("ws", "c1", true);
    expect(view.actions().isPending("default-channel")).toBe(true);
    // 답이 오기 전에는 바뀌지 않는다.
    expect(view.item()?.checked).toBe(false);
    await act(async () => {
      answer(channelRow({ isDefault: true, topic: "서버가 준 주제" }));
    });
    await view.flush();
    expect(view.client.getQueryData<Channel[]>(["channels", "ws"])).toEqual([channelRow({ isDefault: true, topic: "서버가 준 주제" })]);
    expect(view.item()?.checked).toBe(true);
    expect(view.actions().isPending("default-channel")).toBe(false);
    // 둘러보기 창의 「기본」 표시는 서버 목록에서 오므로 창을 다시 열면 새로 읽는다.
    expect(view.client.getQueryState(["channel-browse", "ws"])?.isInvalidated).toBe(true);
  } finally {
    view.cleanup();
  }
});

it("내 목록에 다른 기본 채널이 안 보이면 줄이 까닭을 말하되 누름은 막지 않고 서버의 409 문장을 보여 준다", async () => {
  core.setChannelDefault.mockReset();
  core.setChannelDefault.mockRejectedValue(
    new ApiError(409, "the last default channel cannot be turned off", "last_default_channel")
  );
  const view = await mountActions([channelRow(), channelRow({ id: "c2", name: "잡담", isDefault: false })], "owner");
  try {
    expect(view.item()?.description).toBe(EN["channels.default.lastHint"]);
    act(() => view.actions().run("default-channel"));
    await view.flush();
    expect(core.setChannelDefault).toHaveBeenCalledWith("ws", "c1", false);
    expect(view.actions().error).toBe(EN["channels.default.lastDefault"]);
    // 값은 그대로다.
    expect(view.item()?.checked).toBe(true);
  } finally {
    view.cleanup();
  }
});

it("내 목록에 다른 기본 채널이 보이면 까닭 대신 평소 설명이 선다", async () => {
  const view = await mountActions([channelRow(), channelRow({ id: "c2", name: "공지", isDefault: true })], "owner");
  try {
    expect(view.item()?.description).toBe(EN["channels.default.description"]);
  } finally {
    view.cleanup();
  }
});
