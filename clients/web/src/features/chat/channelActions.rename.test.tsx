// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { type Channel, type MembershipRole } from "@momo/core/lib/api";
import enChannels from "@momo/core/i18n/catalogs/en-US/channels.json";
import { useChannelActions, type ChannelActions } from "./channelActions";

// 채널 머리 ⋮ 의 「이름 바꾸기」 줄 (ADR-0225 D10, #5835). 줄은 소유자 · 관리자에게만, `general` · DM 에는 서지 않는다. 서버 계약과 판정 표는
// 코어 `rename.test.ts` 가 잰다. 여기서는 줄이 헤더에만 서고 사이드바 행 우클릭 메뉴에는 없다는 것까지 본다.

const channelRow = (extra: Partial<Channel> = {}): Channel => ({
  id: "c1",
  workspaceId: "ws",
  kind: "public",
  name: "출시-준비",
  muted: false,
  ...extra,
});

function mountActions(channel: Channel, role: MembershipRole | undefined, withHand = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient();
  const ref: { actions: ChannelActions | null } = { actions: null };
  function Probe() {
    ref.actions = useChannelActions({
      workspaceId: "ws",
      channel,
      title: channel.name ?? "",
      selfMemberId: "me",
      selfRole: role,
      onActionSucceeded: () => undefined,
      onRename: withHand ? () => undefined : undefined,
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
  return {
    actions: () => ref.actions!,
    cleanup: () => {
      act(() => root.unmount());
      client.clear();
    },
  };
}

it.each([
  ["owner", { kind: "public" }, true],
  ["admin", { kind: "private" }, true],
  ["member", { kind: "public" }, false],
  ["guest", { kind: "private" }, false],
  [undefined, { kind: "public" }, false],
  // general 은 이름이 잠겼다(D10) — 소유자에게도 문이 없다.
  ["owner", { name: "general" }, false],
  ["owner", { kind: "dm", name: undefined }, false],
  ["owner", { archivedAtMs: 1 }, false],
] as const)("줄은 소유자 · 관리자가 든 이름 바꿀 수 있는 채널에만 선다: %s %o -> %s", (role, extra, shown) => {
  const view = mountActions(channelRow(extra as Partial<Channel>), role);
  try {
    const header = view.actions().items("header");
    expect(header.some((item) => item.key === "rename")).toBe(shown);
    if (shown) {
      expect(header.find((item) => item.key === "rename")).toMatchObject({ label: (enChannels as Record<string, string>)["channels.rename.action"] });
    }
    // 행 우클릭 메뉴에는 이 줄이 없다.
    expect(view.actions().items("row").some((item) => item.key === "rename")).toBe(false);
  } finally {
    view.cleanup();
  }
});

it("다이얼로그를 세울 손이 없는 표면에는 줄이 서지 않는다", () => {
  const view = mountActions(channelRow(), "owner", false);
  try {
    expect(view.actions().items("header").some((item) => item.key === "rename")).toBe(false);
  } finally {
    view.cleanup();
  }
});
