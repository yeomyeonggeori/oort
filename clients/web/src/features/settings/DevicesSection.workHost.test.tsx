// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkTierPolicy } from "@momo/core/features/settings/api";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";

// =============================================================================
// #3578 S4 설정 > 기기: 이 맥의 작업 호스트와 내 재개 정책이 **여기** 선다.
// 사보타주로 붉어지는 규율:
//   ① 브라우저 탭에 「이 맥」 카드가 서면(데스크탑 셸에만 있다)
//   ② 작업 표면이 없는 서버에서 내 재개 정책 질의가 나가면
//   ③ 이 페이지가 워크스페이스 기본 저장을 들면(범위가 섞인다)
// =============================================================================

const WS = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ME = "m-me";

const shell = vi.hoisted(() => ({ desktop: false }));
const bridge = vi.hoisted(() => ({
  status: vi.fn(),
  register: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  forget: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listWorkHosts: vi.fn(),
  fetchWorkTierPolicy: vi.fn(),
  putWorkTierPolicy: vi.fn(),
}));
const linked = vi.hoisted(() => vi.fn());
const keys = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
  desktopWorkHost: bridge,
  desktopDeviceKey: { status: async () => null },
}));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  ...api,
  resolveServerBaseUrl: () => "https://oort-team.example",
}));
vi.mock("@momo/core/features/auth/linkedDevices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/auth/linkedDevices")>()),
  listLinkedDevices: (...args: unknown[]) => linked(...args),
}));
vi.mock("@momo/core/features/auth/deviceKeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/auth/deviceKeys")>()),
  listDeviceKeys: (...args: unknown[]) => keys(...args),
}));

import { DevicesSection } from "./DevicesSection";

function local(): LocalWorkHostStatus {
  return {
    sidecar: true,
    registered: null,
    running: false,
    heartbeat: null,
    adapters: [{ key: "claude", executable: "claude-agent-acp", found: true }],
    workFolder: "/Users/sj/oort-work",
    displayNameSuggestion: "성재의 MacBook Pro",
  };
}

function policy(): WorkTierPolicy {
  return { workspaceId: WS, memberId: ME, mode: "ask", inherited: true };
}

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  shell.desktop = false;
  for (const fn of [...Object.values(api), ...Object.values(bridge), linked, keys]) fn.mockReset();
  api.listWorkHosts.mockResolvedValue([]);
  api.fetchWorkTierPolicy.mockResolvedValue(policy());
  bridge.status.mockResolvedValue(local());
  linked.mockResolvedValue({ devices: [] });
  keys.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: { workPolicy?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DevicesSection, { offline: false, workspaceId: WS, memberId: ME, ...props })
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("설정 > 기기: 작업 호스트는 개인 자리에 선다", () => {
  it("브라우저 탭, 작업 표면 없음: 이 맥 카드도 정책 카드도 없고 질의도 나가지 않는다", async () => {
    await render();
    expect(byTestId("this-mac-card")).toBeNull();
    expect(byTestId("work-tier-policy-card")).toBeNull();
    expect(api.listWorkHosts).not.toHaveBeenCalled();
    expect(api.fetchWorkTierPolicy).not.toHaveBeenCalled();
    // 기기 본연의 카드는 그대로 있다.
    expect(byTestId("linked-devices-card")).not.toBeNull();
    expect(byTestId("device-link-section")).not.toBeNull();
  });

  it("브라우저 탭, 작업 표면 있음: 내 정책만 서고 이 맥 카드는 여전히 없다", async () => {
    await render({ workPolicy: true });
    expect(byTestId("this-mac-card")).toBeNull();
    expect(byTestId("work-tier-save-member")).not.toBeNull();
    expect(byTestId("work-tier-save-workspace")).toBeNull();
    expect(api.fetchWorkTierPolicy).toHaveBeenCalledTimes(1);
    expect(api.fetchWorkTierPolicy).toHaveBeenCalledWith(WS, "member");
  });

  it("데스크탑: 이 맥 카드와 내 정책이 서고, 워크스페이스 기본은 이 페이지에 없다", async () => {
    shell.desktop = true;
    await render();
    expect(byTestId("this-mac-card")).not.toBeNull();
    expect(byTestId("this-mac")?.getAttribute("data-this-mac-state")).toBe("not_registered");
    expect(byTestId("this-mac-register-submit")?.textContent).toBe("이 맥을 호스트로 등록");
    expect(byTestId("work-tier-save-member")).not.toBeNull();
    expect(byTestId("work-tier-save-workspace")).toBeNull();
    // 등록부는 한 번만 읽는다: 이 맥 카드와 정책의 대상 고르기가 한 질의를 나눈다.
    expect(api.listWorkHosts).toHaveBeenCalledTimes(1);
    expect(api.listWorkHosts).toHaveBeenCalledWith(WS);
  });

  it("실행 엔진 선택은 기기에도 없다", async () => {
    shell.desktop = true;
    await render();
    expect(container.textContent).not.toContain("실행 엔진");
  });
});
