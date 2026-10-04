// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  MEMORY_PAUSE_DETAIL_OFF,
  MEMORY_PAUSE_DETAIL_ON,
  MEMORY_PAUSE_LABEL,
  MEMORY_PAUSE_WORKSPACE_OFF,
  WORKSPACE_SWITCH_ADMIN_ONLY_REASON,
  memoryWriteErrorMessage,
} from "@momo/core/features/memory/presentation";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { WS, byTestId, click, flush, mount, settings, unmount } from "./memoryTestKit";

const getMemorySettings = vi.hoisted(() => vi.fn());
const patchWorkspaceMemorySettings = vi.hoisted(() => vi.fn());
const patchMyMemorySettings = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    getMemorySettings: (...a: unknown[]) => getMemorySettings(...a) as unknown,
    patchWorkspaceMemorySettings: (...a: unknown[]) =>
      patchWorkspaceMemorySettings(...a) as unknown,
    patchMyMemorySettings: (...a: unknown[]) => patchMyMemorySettings(...a) as unknown,
  };
});

beforeEach(() => {
  getMemorySettings.mockReset();
  patchWorkspaceMemorySettings.mockReset();
  patchMyMemorySettings.mockReset();
  getMemorySettings.mockResolvedValue(settings());
  patchWorkspaceMemorySettings.mockResolvedValue({ enabled: false, paused: false, resetEpoch: 0 });
  patchMyMemorySettings.mockResolvedValue({ paused: true });
});
afterEach(unmount);

async function render(role: "owner" | "admin" | "member", offline = false) {
  const view = mount(createElement(MemorySettingsSection, { workspaceId: WS, offline }), { role });
  for (let i = 0; i < 6; i += 1) await flush();
  return view;
}

const input = (host: HTMLElement, id: string) =>
  byTestId<HTMLInputElement>(host, id) as HTMLInputElement;

describe("설정 › 기억: 권한", () => {
  it("관리자는 팀 스위치를 바꾸고 서버에 그 값만 보낸다", async () => {
    const { host } = await render("admin");
    expect(input(host, "memory-workspace-enabled").disabled).toBe(false);
    expect(byTestId(host, "memory-admin-reason")).toBeNull();
    click(input(host, "memory-workspace-enabled"));
    await flush();
    expect(patchWorkspaceMemorySettings).toHaveBeenCalledWith(WS, { enabled: false });
  });

  it("소유자도 같다", async () => {
    const { host } = await render("owner");
    expect(input(host, "memory-workspace-paused").disabled).toBe(false);
  });

  it("멤버는 팀 스위치가 잠기고 사유를 읽을 수 있으며 요청은 나가지 않는다", async () => {
    const { host } = await render("member");
    const enabled = input(host, "memory-workspace-enabled");
    expect(enabled.disabled).toBe(true);
    expect(input(host, "memory-workspace-paused").disabled).toBe(true);
    expect(byTestId(host, "memory-admin-reason")?.textContent).toBe(
      WORKSPACE_SWITCH_ADMIN_ONLY_REASON
    );
    expect(enabled.getAttribute("aria-describedby")).toContain("memory-workspace-admin-reason");
    click(enabled);
    await flush();
    expect(patchWorkspaceMemorySettings).not.toHaveBeenCalled();
  });

  it("멤버도 자기 일시정지는 바꾼다", async () => {
    const { host } = await render("member");
    const mine = input(host, "memory-me-paused");
    expect(mine.disabled).toBe(false);
    click(mine);
    await flush();
    expect(patchMyMemorySettings).toHaveBeenCalledWith(WS, true);
  });

  it("역할 표가 낡아 서버가 403을 주면 같은 사유를 그 자리에서 말한다", async () => {
    patchWorkspaceMemorySettings.mockRejectedValue(new ApiError(403, "forbidden"));
    const { host } = await render("admin");
    click(input(host, "memory-workspace-enabled"));
    for (let i = 0; i < 4; i += 1) await flush();
    expect(byTestId(host, "memory-write-error")?.textContent).toContain(
      memoryWriteErrorMessage(new ApiError(403, "x"), "workspace")
    );
  });

  it("422와 400은 다시 시도하라는 문장으로 옮긴다", async () => {
    for (const status of [422, 400]) {
      unmount();
      patchWorkspaceMemorySettings.mockRejectedValue(new ApiError(status, "bad"));
      const { host } = await render("admin");
      click(input(host, "memory-workspace-paused"));
      for (let i = 0; i < 4; i += 1) await flush();
      const text = byTestId(host, "memory-write-error")?.textContent ?? "";
      expect(text).toContain("다시 시도");
      expect(text).not.toContain(String(status));
    }
  });
});

describe("설정 › 기억: 상태", () => {
  it("현재 값을 서버 답 그대로 보여 준다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({
        workspace: { enabled: true, paused: true, resetEpoch: 1 },
        me: { paused: true },
      })
    );
    const { host } = await render("admin");
    expect(input(host, "memory-workspace-enabled").checked).toBe(true);
    expect(input(host, "memory-workspace-paused").checked).toBe(true);
    expect(input(host, "memory-me-paused").checked).toBe(true);
  });

  it("팀 기억이 꺼져 있으면 일시정지는 잠긴다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({ workspace: { enabled: false, paused: false, resetEpoch: 0 } })
    );
    const { host } = await render("admin");
    expect(input(host, "memory-workspace-paused").disabled).toBe(true);
  });

  it("연결이 끊기면 전부 잠기고 이유를 말한다", async () => {
    const { host } = await render("admin", true);
    expect(input(host, "memory-workspace-enabled").disabled).toBe(true);
    expect(input(host, "memory-me-paused").disabled).toBe(true);
    expect(byTestId(host, "memory-offline-reason")?.textContent).toContain("연결이 끊겨");
  });

  it("내 일시정지 문장은 폰과 같은 상수이고, 켜져 있으면 지금 상태를 말한다", async () => {
    const { host } = await render("member");
    expect(host.textContent).toContain(MEMORY_PAUSE_LABEL);
    expect(host.textContent).toContain(MEMORY_PAUSE_DETAIL_OFF);
    unmount();
    getMemorySettings.mockResolvedValue(settings({ me: { paused: true } }));
    const paused = await render("member");
    expect(paused.host.textContent).toContain(MEMORY_PAUSE_DETAIL_ON);
  });

  it("팀 설정에서 꺼져 있으면 내 행 아래에서 그 사실을 말한다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({ workspace: { enabled: false, paused: false, resetEpoch: 0 } })
    );
    const { host } = await render("member");
    expect(byTestId(host, "memory-mine-workspace-off")?.textContent).toBe(
      MEMORY_PAUSE_WORKSPACE_OFF
    );
  });

  it("팀 고지: 채널 대화가 요약 AI에게 간다고 스위치 옆에서 말한다", async () => {
    const { host } = await render("admin");
    expect(host.textContent).toContain("채널 대화가 요약을 만드는 AI에게 전달돼요");
  });

  it("불러오기 실패는 다시 시도를 준다", async () => {
    getMemorySettings.mockRejectedValue(new ApiError(500, "boom"));
    const { host } = await render("admin");
    expect(byTestId(host, "memory-settings-load")?.textContent).toContain("다시 시도");
  });

  it("서버가 기억을 모르면(404) 미제공 사유를 말하고 다시 시도는 없다", async () => {
    getMemorySettings.mockRejectedValue(new ApiError(404, "nope"));
    const { host } = await render("admin");
    const banner = byTestId(host, "memory-settings-load");
    expect(banner?.textContent).toContain("아직 팀 기억을 지원하지 않아요");
    expect(banner?.textContent).not.toContain("다시 시도");
  });
});

describe("설정 › 기억: 브라우저로 가는 길", () => {
  it("기억 브라우저로 가는 링크를 준다 (권한과 무관하게)", async () => {
    for (const role of ["member", "admin"] as const) {
      unmount();
      const { host } = await render(role);
      expect(byTestId(host, "memory-open-browser")?.getAttribute("href")).toBe("/memory");
    }
  });
});
