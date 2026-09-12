// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { CANNOT_REVOKE_CURRENT } from "@momo/core/features/auth/linkedDevices";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { DevicesSection } from "./DevicesSection";
import { DEVICE_LINK_LIVE_KEY, writeDeviceLinkLive } from "./deviceLinkLive";
import {
  DEVICE_LINK_FIXTURE_DEVICE_NAME,
  DEVICE_LINK_FIXTURE_ID,
  deviceLinkFixtureIssue,
} from "./deviceLinkFixture";

const CURRENT_ID = "019f9b10-0000-7000-8000-000000000d01";
const OTHER_ID = "019f9b10-0000-7000-8000-000000000d02";
const NOW = 1_800_000_000_000;
const LIST_SOURCE = readFileSync(
  "src/features/settings/LinkedDevicesList.tsx",
  "utf8"
);

const listLinkedDevices = vi.hoisted(() => vi.fn());
const revokeLinkedDevice = vi.hoisted(() => vi.fn());
const issueDeviceLink = vi.hoisted(() => vi.fn());
const getDeviceLink = vi.hoisted(() => vi.fn());
const confirmDeviceLinkSas = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/auth/linkedDevices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/auth/linkedDevices")>();
  return {
    ...actual,
    listLinkedDevices: (...args: unknown[]) => listLinkedDevices(...args),
    revokeLinkedDevice: (...args: unknown[]) => revokeLinkedDevice(...args),
  };
});

vi.mock("@momo/core/features/auth/deviceLink", () => ({
  issueDeviceLink: (...args: unknown[]) => issueDeviceLink(...args),
  getDeviceLink: (...args: unknown[]) => getDeviceLink(...args),
  confirmDeviceLinkSas: (...args: unknown[]) => confirmDeviceLinkSas(...args),
  DEVICE_LINK_POLL_INTERVAL_MS: 2_000,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function twoDevices() {
  return {
    devices: [
      {
        id: CURRENT_ID,
        label: "성재 iMac, 집 작업실",
        platform: "macos",
        linkedAt: NOW - 86_400_000,
        current: true,
      },
      {
        id: OTHER_ID,
        label: DEVICE_LINK_FIXTURE_DEVICE_NAME,
        platform: "ios",
        linkedAt: NOW - 3_600_000,
        current: false,
      },
    ],
  };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
  );
});

beforeEach(() => {
  sessionStorage.clear();
  writeDeviceLinkLive(null);
  listLinkedDevices.mockReset();
  revokeLinkedDevice.mockReset();
  issueDeviceLink.mockReset();
  getDeviceLink.mockReset();
  confirmDeviceLinkSas.mockReset();
  listLinkedDevices.mockResolvedValue({ devices: [] });
  revokeLinkedDevice.mockResolvedValue(undefined);
  issueDeviceLink.mockResolvedValue(
    deviceLinkFixtureIssue({ sas: null, expiresAt: NOW + 120_000 })
  );
  getDeviceLink.mockResolvedValue({ status: "pending" });
  confirmDeviceLinkSas.mockResolvedValue({ status: "confirmed" });
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
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  sessionStorage.clear();
  writeDeviceLinkLive(null);
  resetEscapeLayers();
});

function mount(offline = false): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(DevicesSection, { offline })
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 4000) throw new Error(label);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid^="linked-device-row-"]')];
}

function currentBadges(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="linked-device-current"]')];
}

function disconnectOf(host: HTMLElement, id: string): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>(
    `[data-testid="linked-device-row-${id}"] [data-testid="linked-device-disconnect"]`
  );
  expect(node, `disconnect ${id}`).not.toBeNull();
  return node as HTMLButtonElement;
}

async function confirmRevoke(host: HTMLElement, id: string): Promise<void> {
  await act(async () => {
    disconnectOf(host, id).click();
  });
  await flush();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>(
        `[data-testid="linked-device-row-${id}"] [data-testid="linked-device-disconnect-confirm"]`
      )
      ?.click();
  });
  await flush();
}

describe("설정 › 기기 목록", () => {
  it("목록 2건은 행 2개이고 현재 기기 배지는 하나다", async () => {
    listLinkedDevices.mockResolvedValue(twoDevices());
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    expect(rows(host)).toHaveLength(2);
    expect(currentBadges(host)).toHaveLength(1);
    expect(currentBadges(host)[0]?.textContent).toBe("현재 기기");
    expect(host.textContent).toContain("성재 iMac, 집 작업실");
    expect(host.textContent).toContain(DEVICE_LINK_FIXTURE_DEVICE_NAME);
    expect(host.textContent).toContain("macOS");
    expect(host.textContent).toContain("iOS");
    expect(host.textContent).not.toContain("macos");
    expect(host.textContent).not.toContain("ios,");
    expect(host.textContent).toContain("마지막 사용 시각은 아직 기록하지 않습니다");
    expect(host.textContent).not.toContain("lastSeenAt");
    expect(host.textContent).not.toContain("최근 활동 미기록");
  });

  it("현재 기기가 아닌 행 해제는 DELETE 1회이고 행 1개가 남는다", async () => {
    const listed = twoDevices();
    listLinkedDevices.mockImplementation(async () => ({ devices: listed.devices }));
    revokeLinkedDevice.mockImplementation(async (id: string) => {
      listed.devices = listed.devices.filter((row) => row.id !== id);
    });
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    await confirmRevoke(host, OTHER_ID);
    await waitFor(() => rows(host).length === 1, "one row");
    expect(revokeLinkedDevice).toHaveBeenCalledTimes(1);
    expect(revokeLinkedDevice).toHaveBeenCalledWith(OTHER_ID);
    expect(rows(host)).toHaveLength(1);
    expect(currentBadges(host)).toHaveLength(1);
    expect(host.querySelector('[data-testid="linked-devices-removed"]')?.textContent).toContain(
      "연결을 해제했습니다"
    );
    expect(document.activeElement).toBe(disconnectOf(host, CURRENT_ID));
  });

  it("현재 기기 행 해제는 비활성이고 요청을 내지 않는다", async () => {
    listLinkedDevices.mockResolvedValue(twoDevices());
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    const trigger = disconnectOf(host, CURRENT_ID);
    expect(host.querySelector('[data-testid="linked-devices-current-reason"]')?.textContent).toMatch(
      /로그아웃/
    );
    await act(async () => {
      trigger.click();
    });
    await flush();
    const confirm = host.querySelector(
      `[data-testid="linked-device-row-${CURRENT_ID}"] [data-testid="linked-device-disconnect-confirm"]`
    );
    if (confirm) {
      await act(async () => {
        (confirm as HTMLButtonElement).click();
      });
      await flush();
    }
    expect(revokeLinkedDevice).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
  });

  it("목록 401은 설정 오류 상태 하나다", async () => {
    listLinkedDevices.mockRejectedValue(new ApiError(401, "unauthorized"));
    const host = mount();
    await waitFor(
      () => host.querySelector('[data-testid="linked-devices-error"]') !== null,
      "error"
    );
    expect(host.querySelectorAll('[data-testid="linked-devices-error"]')).toHaveLength(
      1
    );
    expect(host.querySelectorAll('[data-testid^="linked-device-row-"]')).toHaveLength(
      0
    );
    expect(host.querySelector('[data-testid="linked-devices-error"]')?.textContent).toMatch(
      /불러오지 못했습니다/
    );
    expect(host.querySelector('[data-testid="linked-devices-error"]')?.textContent).not.toMatch(
      /세션이 만료/
    );
    expect(host.querySelector('[data-testid="linked-devices-empty"]')).toBeNull();
    expect(LIST_SOURCE).not.toContain("세션이 만료");
  });

  it("빈 목록은 한 줄이다", async () => {
    listLinkedDevices.mockResolvedValue({ devices: [] });
    const host = mount();
    await waitFor(
      () => host.querySelector('[data-testid="linked-devices-empty"]') !== null,
      "empty"
    );
    expect(host.querySelectorAll('[data-testid="linked-devices-empty"]')).toHaveLength(
      1
    );
    expect(host.querySelector('[data-testid="linked-devices-empty"]')?.textContent).toBe(
      "연결된 기기가 없습니다."
    );
    expect(host.querySelector('[data-testid="device-link-card"]')).not.toBeNull();
  });

  it("404 해제는 행을 지우고 인라인 안내를 남긴다", async () => {
    const listed = twoDevices();
    listLinkedDevices.mockImplementation(async () => ({ devices: listed.devices }));
    revokeLinkedDevice.mockImplementation(async (id: string) => {
      listed.devices = listed.devices.filter((row) => row.id !== id);
      throw new ApiError(404, "not found");
    });
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    await confirmRevoke(host, OTHER_ID);
    await waitFor(
      () => host.querySelector('[data-testid="linked-devices-gone"]') !== null,
      "gone"
    );
    expect(host.querySelectorAll('[data-testid="linked-devices-gone"]')).toHaveLength(
      1
    );
    await waitFor(() => rows(host).length === 1, "row gone");
  });
});

describe("R2 nits", () => {
  it("해제 실패는 재조회가 오기 전에 목록을 되돌린다", async () => {
    const listed = twoDevices();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    listLinkedDevices.mockImplementation(async () => {
      if (listLinkedDevices.mock.calls.length <= 1) {
        return { devices: listed.devices };
      }
      await held;
      return { devices: listed.devices };
    });
    revokeLinkedDevice.mockRejectedValue(new ApiError(500, "boom"));
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    await confirmRevoke(host, OTHER_ID);
    await waitFor(
      () => host.querySelector('[data-testid="linked-devices-revoke-error"]') !== null,
      "error"
    );
    expect(rows(host)).toHaveLength(2);
    expect(listLinkedDevices.mock.calls.length).toBeGreaterThan(1);
    release();
    await flush();
  });

  it("400 cannot_revoke_current 는 행을 되돌리고 서버 사유를 말한다", async () => {
    const listed = twoDevices();
    listLinkedDevices.mockImplementation(async () => ({ devices: listed.devices }));
    revokeLinkedDevice.mockRejectedValue(
      new ApiError(400, CANNOT_REVOKE_CURRENT)
    );
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    await confirmRevoke(host, OTHER_ID);
    await waitFor(
      () => host.querySelector('[data-testid="linked-devices-revoke-error"]') !== null,
      "400"
    );
    expect(rows(host)).toHaveLength(2);
    expect(
      host.querySelector('[data-testid="linked-devices-revoke-error"]')?.textContent
    ).toMatch(/서버가 이 기기를 지금 쓰는 기기/);
  });

  it("취소와 Esc 는 초점을 트리거에 되돌린다", async () => {
    listLinkedDevices.mockResolvedValue(twoDevices());
    const host = mount();
    await waitFor(() => rows(host).length === 2, "two rows");
    const trigger = disconnectOf(host, OTHER_ID);
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await flush();
    expect(
      host.querySelector(
        `[data-testid="linked-device-row-${OTHER_ID}"] [data-testid="linked-device-disconnect-question"]`
      )
    ).not.toBeNull();
    const cancel = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "취소"
    );
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel?.click();
    });
    await flush();
    expect(document.activeElement).toBe(disconnectOf(host, OTHER_ID));

    await act(async () => {
      disconnectOf(host, OTHER_ID).click();
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    await flush();
    expect(
      host.querySelector(
        `[data-testid="linked-device-row-${OTHER_ID}"] [data-testid="linked-device-disconnect-question"]`
      )
    ).toBeNull();
    expect(document.activeElement).toBe(disconnectOf(host, OTHER_ID));
  });
});

describe("QR 연결 카드는 목록이 SoT다", () => {
  it("재로드 후 연결됨은 목록 GET이지 카드 로컬 상태가 아니다", async () => {
    const listed = {
      devices: [
        {
          id: DEVICE_LINK_FIXTURE_ID,
          label: DEVICE_LINK_FIXTURE_DEVICE_NAME,
          platform: "ios",
          linkedAt: NOW,
          current: false,
        },
      ],
    };
    listLinkedDevices.mockImplementation(async () => ({ devices: listed.devices }));
    getDeviceLink.mockResolvedValue({
      status: "consumed",
      device: { name: DEVICE_LINK_FIXTURE_DEVICE_NAME, platform: "ios" },
    });
    const host = mount();
    await waitFor(() => rows(host).length === 1, "row from GET");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="device-link-create"]')?.click();
    });
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="device-link-connected"]')?.textContent).toContain(
      "연결됨"
    );

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    mountedHost = null;

    const remounted = mount();
    await waitFor(() => rows(remounted).length === 1, "row after reload");
    expect(rows(remounted)).toHaveLength(1);
    expect(currentBadges(remounted)).toHaveLength(0);
    expect(remounted.querySelector('[data-testid="device-link-connected"]')).toBeNull();
    expect(sessionStorage.getItem(DEVICE_LINK_LIVE_KEY)).toBeNull();
    expect(listLinkedDevices.mock.calls.length).toBeGreaterThan(1);
  });
});
