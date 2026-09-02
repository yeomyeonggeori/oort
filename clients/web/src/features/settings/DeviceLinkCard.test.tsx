// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { DeviceLinkCard } from "./DeviceLinkCard";
import {
  DEVICE_LINK_FIXTURE_DEVICE_NAME,
  DEVICE_LINK_FIXTURE_ID,
  DEVICE_LINK_FIXTURE_SAS,
  deviceLinkFixtureIssue,
  deviceLinkFixtureToken,
} from "./deviceLinkFixture";

const issueDeviceLink = vi.hoisted(() => vi.fn());
const getDeviceLink = vi.hoisted(() => vi.fn());
const confirmDeviceLinkSas = vi.hoisted(() => vi.fn());

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

const NOW = 1_800_000_000_000;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof HTMLElement !== "undefined" && !("innerText" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return (this as HTMLElement).textContent ?? "";
      },
    });
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  issueDeviceLink.mockReset();
  getDeviceLink.mockReset();
  confirmDeviceLinkSas.mockReset();
  issueDeviceLink.mockResolvedValue(deviceLinkFixtureIssue({ expiresAt: NOW + 120_000 }));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(tree: ReactElement = createElement(DeviceLinkCard)): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

function testId(id: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${id}"]`);
  expect(node, id).not.toBeNull();
  return node as HTMLElement;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function createLink(): Promise<void> {
  await act(async () => {
    testId("device-link-create").click();
  });
  await flush();
}

function assertSecretAbsent(host: HTMLElement, secret: string): void {
  const hostText = host.innerText || host.textContent || "";
  const bodyText = document.body.innerText || document.body.textContent || "";
  expect(hostText).not.toContain(secret);
  expect(bodyText).not.toContain(secret);
  for (const el of host.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      const copyData =
        el.getAttribute("data-testid") === "device-link-copy" &&
        attr.name.startsWith("data-");
      if (copyData) continue;
      expect(attr.value, `${el.tagName}.${attr.name}`).not.toContain(secret);
    }
  }
}

describe("DeviceLinkCard red proofs", () => {
  it("keeps the issue voucher out of DOM text and non-copy attributes", async () => {
    const host = mount();
    await createLink();
    const token = deviceLinkFixtureToken();
    assertSecretAbsent(host, token);
    const qr = testId("device-link-qr");
    expect(qr.getAttribute("aria-label")).toBe("폰 연결 QR");
    expect(qr.getAttribute("aria-label")).not.toContain(token);
    expect(testId("device-link-copy")).not.toBeNull();
  });

  it("moves the action to recreate after the voucher expires", async () => {
    mount();
    await createLink();
    expect(testId("device-link-create").textContent).not.toContain("다시 만들기");
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await flush();
    expect(testId("device-link-create").textContent).toContain("다시 만들기");
  });

  it("shows the SAS block only when the issue response carries sas", async () => {
    issueDeviceLink.mockResolvedValueOnce(
      deviceLinkFixtureIssue({ sas: null, expiresAt: NOW + 120_000 })
    );
    mount();
    await createLink();
    expect(document.querySelector('[data-testid="device-link-sas"]')).toBeNull();

    issueDeviceLink.mockResolvedValueOnce(
      deviceLinkFixtureIssue({
        sas: DEVICE_LINK_FIXTURE_SAS,
        expiresAt: NOW + 120_000,
      })
    );
    await act(async () => {
      testId("device-link-create").click();
    });
    await flush();
    const sas = testId("device-link-sas");
    expect(sas.textContent).toContain(DEVICE_LINK_FIXTURE_SAS);
    expect(sas.getAttribute("aria-label")).toContain(DEVICE_LINK_FIXTURE_SAS);
  });

  it("stops polling once the status is consumed", async () => {
    let polls = 0;
    getDeviceLink.mockImplementation(async () => {
      polls += 1;
      if (polls >= 3) {
        return {
          status: "consumed",
          device: { name: DEVICE_LINK_FIXTURE_DEVICE_NAME, platform: "ios" },
        };
      }
      return { status: "pending" };
    });
    const host = mount();
    await createLink();
    expect(getDeviceLink).toHaveBeenCalledWith(DEVICE_LINK_FIXTURE_ID);
    const afterIssue = polls;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(host.textContent).toContain("연결됨");
    expect(host.textContent).toContain(DEVICE_LINK_FIXTURE_DEVICE_NAME);
    const stopped = polls;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    await flush();
    expect(polls).toBe(stopped);
    expect(afterIssue).toBeGreaterThanOrEqual(1);
  });

  it("renders an InlineBanner when confirm-sas is rejected", async () => {
    mount();
    await createLink();
    confirmDeviceLinkSas.mockRejectedValueOnce(
      new ApiError(409, "SAS is not required, or the token has not been redeemed")
    );
    await act(async () => {
      testId("device-link-confirm-sas").click();
    });
    await flush();
    expect(testId("device-link-banner").textContent).toMatch(/폰|확인|다시/);

    confirmDeviceLinkSas.mockRejectedValueOnce(new ApiError(400, "bad request"));
    await act(async () => {
      testId("device-link-confirm-sas").click();
    });
    await flush();
    expect(testId("device-link-banner").textContent).toMatch(/다시/);
  });

  it("announces the countdown only on 30-second boundaries", async () => {
    mount();
    await createLink();
    const live = testId("device-link-countdown-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    const first = live.textContent;
    expect(first).toContain("120");
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();
    expect(live.textContent).toBe(first);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();
    expect(testId("device-link-countdown-live").textContent).toContain("90");
    expect(testId("device-link-countdown").textContent).toMatch(/\d+/);
  });
});
