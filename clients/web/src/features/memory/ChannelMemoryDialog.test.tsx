// @vitest-environment jsdom

import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { CHANNEL_SWITCH_ADMIN_ONLY_REASON } from "@momo/core/features/memory/presentation";
import { ChannelMemoryDialog } from "./ChannelMemoryDialog";
import { CH, OTHER_CH, WS, click, flush, mount, settings, unmount } from "./memoryTestKit";

const getMemorySettings = vi.hoisted(() => vi.fn());
const patchChannelMemorySettings = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    getMemorySettings: (...a: unknown[]) => getMemorySettings(...a) as unknown,
    patchChannelMemorySettings: (...a: unknown[]) => patchChannelMemorySettings(...a) as unknown,
  };
});

beforeEach(() => {
  getMemorySettings.mockReset();
  patchChannelMemorySettings.mockReset();
  getMemorySettings.mockResolvedValue(settings());
  patchChannelMemorySettings.mockResolvedValue({ channelId: CH, excluded: true, paused: false });
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

const q = (id: string) =>
  document.body.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);

async function render(canChange: boolean) {
  mount(
    createElement(ChannelMemoryDialog, {
      workspaceId: WS,
      channelId: CH,
      channelTitle: "결제-개발",
      canChange,
      open: true,
      onOpenChange: () => undefined,
      opener: createRef<HTMLElement>(),
    })
  );
  for (let i = 0; i < 6; i += 1) await flush();
}

describe("채널 기억 설정", () => {
  it("관리자는 제외를 바꾸고 서버에 채널 id와 그 값만 보낸다", async () => {
    await render(true);
    click(q("channel-memory-excluded"));
    await flush();
    expect(patchChannelMemorySettings).toHaveBeenCalledWith(WS, CH, { excluded: true });
  });

  it("행이 없는 채널은 기본값(켜짐·멈춤 아님)으로 읽는다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({ channels: [{ channelId: OTHER_CH, excluded: true, paused: true }] })
    );
    await render(true);
    expect(q("channel-memory-excluded")?.checked).toBe(false);
    expect(q("channel-memory-paused")?.checked).toBe(false);
  });

  it("제외된 채널은 일시정지가 잠긴다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({ channels: [{ channelId: CH, excluded: true, paused: false }] })
    );
    await render(true);
    expect(q("channel-memory-excluded")?.checked).toBe(true);
    expect(q("channel-memory-paused")?.disabled).toBe(true);
  });

  it("관리자가 아니면 잠기고 사유를 읽을 수 있으며 요청은 나가지 않는다", async () => {
    await render(false);
    const excluded = q("channel-memory-excluded");
    expect(excluded?.disabled).toBe(true);
    expect(q("channel-memory-reason")?.textContent).toBe(CHANNEL_SWITCH_ADMIN_ONLY_REASON);
    click(excluded);
    await flush();
    expect(patchChannelMemorySettings).not.toHaveBeenCalled();
  });

  it("서버가 403이면 역할 추정이 틀렸어도 같은 사유로 말한다", async () => {
    patchChannelMemorySettings.mockRejectedValue(new ApiError(403, "forbidden"));
    await render(true);
    click(q("channel-memory-paused"));
    for (let i = 0; i < 4; i += 1) await flush();
    expect(
      document.body.querySelector('[data-testid="channel-memory-error"]')?.textContent
    ).toContain(CHANNEL_SWITCH_ADMIN_ONLY_REASON);
  });

  it("서버가 기억을 모르면(404) 미제공 사유를 말한다", async () => {
    getMemorySettings.mockRejectedValue(new ApiError(404, "nope"));
    await render(true);
    expect(
      document.body.querySelector('[data-testid="channel-memory-load"]')?.textContent
    ).toContain("아직 팀 기억을 지원하지 않아요");
  });
});
