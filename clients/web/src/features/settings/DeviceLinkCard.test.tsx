// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { encodeQr, selectQrVersion } from "@momo/core/lib/qr";
import { DeviceLinkCard } from "./DeviceLinkCard";
import { DEVICE_LINK_LIVE_KEY, writeDeviceLinkLive } from "./deviceLinkLive";
import { clearSession } from "@/lib/session";
import { assertQrModulePitch } from "@/lib/qrModulePitch";
import {
  DEVICE_LINK_FIXTURE_DEVICE_NAME,
  DEVICE_LINK_FIXTURE_ID,
  DEVICE_LINK_FIXTURE_SAS,
  deviceLinkFixtureDeepLink,
  deviceLinkFixtureIssue,
  deviceLinkFixtureToken,
} from "./deviceLinkFixture";

const TOKENS_CSS = readFileSync("src/design/tokens.css", "utf8");
const CARD_SOURCE = readFileSync(
  "src/features/settings/DeviceLinkCard.tsx",
  "utf8"
);

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
  sessionStorage.clear();
  writeDeviceLinkLive(null);
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
  sessionStorage.clear();
  writeDeviceLinkLive(null);
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

function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    return labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const label = el.getAttribute("aria-label");
  if (label) return label;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function filledAccentButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((button) => {
    const cls = button.className;
    return /\bbg-accent\b/.test(cls) && /\btext-on-accent\b/.test(cls);
  });
}

function tokenPx(name: string): number {
  const match = TOKENS_CSS.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  if (!match) throw new Error(`tokens.css에 --${name} 이 없다`);
  return Number(match[1]);
}

function v8DeepLink(): string {
  return deviceLinkFixtureDeepLink(
    "https://self-hosted-oort.internal.yeomyeonggeori.example.com:8443"
  );
}

function consumedDevice() {
  return {
    status: "consumed" as const,
    device: { name: DEVICE_LINK_FIXTURE_DEVICE_NAME, platform: "ios" as const },
  };
}

function liveDeepLink(): string | undefined {
  const raw = sessionStorage.getItem(DEVICE_LINK_LIVE_KEY);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as { deepLink?: string };
  return parsed.deepLink;
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
    expect(qr.getAttribute("role")).toBe("img");
    expect(accessibleName(qr)).toBe("폰 연결 QR");
    expect(accessibleName(qr)).not.toContain(token);
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
    expect(document.querySelector('[data-testid="device-link-sas"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="device-link-confirm-sas"]')
    ).toBeNull();

    getDeviceLink.mockResolvedValue(consumedDevice());
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    const sas = testId("device-link-sas");
    expect(sas.textContent).toContain(DEVICE_LINK_FIXTURE_SAS);
    expect(accessibleName(sas)).toContain(DEVICE_LINK_FIXTURE_SAS);
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
    expect(host.textContent).not.toContain("연결됨");
    expect(host.textContent).toContain(DEVICE_LINK_FIXTURE_DEVICE_NAME);
    expect(testId("device-link-awaiting-confirm")).not.toBeNull();
    expect(testId("device-link-confirm-sas")).not.toBeNull();
    const stopped = polls;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    await flush();
    expect(polls).toBe(stopped);
    expect(afterIssue).toBeGreaterThanOrEqual(1);
  });

  it("renders an InlineBanner when confirm-sas is rejected", async () => {
    getDeviceLink.mockResolvedValue(consumedDevice());
    mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
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
    const visible = testId("device-link-countdown");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
    expect(visible.textContent).toContain("남은 시간");
    expect(visible.textContent).toMatch(/\d+/);
  });
});

describe("DeviceLinkCard R2 proofs", () => {
  it("does not say 연결됨 while consumed still needs SAS confirm, then does after confirm", async () => {
    getDeviceLink.mockResolvedValue(consumedDevice());
    const host = mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(host.textContent).not.toContain("연결됨");
    expect(testId("device-link-confirm-sas")).not.toBeNull();
    expect(testId("device-link-confirm-sas").className).toMatch(/\btap-target\b/);
    expect(filledAccentButtons(host)).toHaveLength(1);
    expect(filledAccentButtons(host)[0].getAttribute("data-testid")).toBe(
      "device-link-confirm-sas"
    );

    await act(async () => {
      testId("device-link-confirm-sas").click();
    });
    await flush();
    expect(testId("device-link-connected").textContent).toContain("연결됨");
    expect(document.querySelector('[data-testid="device-link-confirm-sas"]')).toBeNull();
  });

  it("keeps at most one filled-accent control in idle, live, expired", async () => {
    const host = mount();
    expect(filledAccentButtons(host)).toHaveLength(1);
    expect(testId("device-link-create").className).toMatch(/\bbg-accent\b/);
    expect(testId("device-link-create").className).not.toMatch(/\bw-full\b/);

    await createLink();
    expect(filledAccentButtons(host)).toHaveLength(0);
    expect(testId("device-link-create").className).toMatch(/\bborder-line-strong\b/);
    expect(
      document.querySelector('[data-testid="device-link-confirm-sas"]')
    ).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await flush();
    expect(filledAccentButtons(host)).toHaveLength(1);
    expect(testId("device-link-create").textContent).toContain("다시 만들기");
    expect(testId("device-link-create").className).toMatch(/\bbg-accent\b/);
  });

  it("renders a version-8 QR at module pitch at least the named floor", async () => {
    const payload = v8DeepLink();
    expect(selectQrVersion(new TextEncoder().encode(payload).length)).toBe(8);
    const encoded = encodeQr(payload);
    expect(encoded.version).toBe(8);
    issueDeviceLink.mockResolvedValueOnce(
      deviceLinkFixtureIssue({
        expiresAt: NOW + 120_000,
        deepLink: payload,
      })
    );
    mount();
    await createLink();
    const qr = testId("device-link-qr");
    expect(qr.getAttribute("class") ?? "").not.toMatch(/\bsize-pane-sm\b/);
    expect(CARD_SOURCE).not.toContain("size-pane-sm");
    const floor = tokenPx("spacing-qr-module");
    const modules = Number(qr.getAttribute("data-qr-modules"));
    expect(modules).toBe(encoded.size + 8);
    expect(modules).toBe(57);
    expect(TOKENS_CSS).toMatch(
      /calc\(var\(--qr-modules\)\s*\*\s*var\(--spacing-qr-module\)\)/
    );
    expect(TOKENS_CSS).toMatch(
      /\.qr-well\[data-qr-modules="57"\]\s*\{\s*--qr-modules:\s*57;/
    );
    expect(TOKENS_CSS).toMatch(/@utility qr-well \{[\s\S]*box-sizing:\s*content-box/);
    expect(192 / modules).toBeLessThan(floor);
    expect(() => assertQrModulePitch(192, modules, floor, "fixed-square")).toThrow(
      /< floor/
    );
    expect(assertQrModulePitch(modules * floor, modules, floor)).toBe(floor);
  });

  it("describes the offline-locked create control with the reason sentence", () => {
    const host = mount(createElement(DeviceLinkCard, { offline: true }));
    const create = testId("device-link-create");
    const describedBy = create.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(
      /연결이 끊겼/
    );
    expect(host.querySelector('[data-testid="device-link-offline"]')?.textContent).toMatch(
      /연결이 끊겼/
    );
  });

  it("states what happened and the next step when the code expires", async () => {
    mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await flush();
    expect(testId("device-link-expired").textContent).toMatch(/만료/);
    expect(testId("device-link-expired").textContent).toMatch(/다시 만들/);
  });

  it("survives remount from the poll status rather than a local flag", async () => {
    getDeviceLink.mockResolvedValue(consumedDevice());
    mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    await act(async () => {
      testId("device-link-confirm-sas").click();
    });
    await flush();
    expect(testId("device-link-connected").textContent).toContain("연결됨");

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    mountedHost = null;

    getDeviceLink.mockResolvedValue(consumedDevice());
    const remounted = mount();
    await flush();
    await flush();
    expect(remounted.textContent).toContain("연결됨");
    expect(document.querySelector('[data-testid="device-link-confirm-sas"]')).toBeNull();
  });

  it("cancels the previous poll when a new code is issued", async () => {
    const first = deviceLinkFixtureIssue({
      id: "019f9b10-0000-7000-8000-000000000d01",
      expiresAt: NOW + 120_000,
    });
    const second = deviceLinkFixtureIssue({
      id: "019f9b10-0000-7000-8000-000000000d02",
      expiresAt: NOW + 120_000,
    });
    issueDeviceLink.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(getDeviceLink).toHaveBeenCalledWith(first.id);

    await act(async () => {
      testId("device-link-create").click();
    });
    await flush();
    getDeviceLink.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    const polled = getDeviceLink.mock.calls.map((call) => call[0]);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.every((id) => id === second.id)).toBe(true);
    expect(polled).not.toContain(first.id);
  });

  it("connects immediately when loopback issue has no SAS", async () => {
    issueDeviceLink.mockResolvedValueOnce(
      deviceLinkFixtureIssue({ sas: null, expiresAt: NOW + 120_000 })
    );
    getDeviceLink.mockResolvedValue(consumedDevice());
    const host = mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(host.textContent).toContain("연결됨");
    expect(document.querySelector('[data-testid="device-link-sas"]')).toBeNull();
    expect(document.querySelector('[data-testid="device-link-confirm-sas"]')).toBeNull();
  });

  it("backs off poll failures and names what happened", async () => {
    getDeviceLink.mockRejectedValue(new NetworkError("unreachable", 15_000));
    mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(testId("device-link-banner").textContent).toMatch(/unreachable|서버|연결/);
    const afterFirst = getDeviceLink.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    expect(getDeviceLink.mock.calls.length).toBe(afterFirst);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    expect(getDeviceLink.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("does not keep an unreachable 만료됨 live-band branch", () => {
    expect(CARD_SOURCE).not.toMatch(/liveBand === 0/);
    expect(CARD_SOURCE).not.toMatch(/남은 시간 \$\{liveBand\}초` : "만료됨"/);
  });

  it("pending names the live code and does not offer SAS confirm", async () => {
    const host = mount();
    await createLink();
    expect(testId("device-link-pending").textContent).toMatch(/살아 있|카메라/);
    expect(testId("device-link-pending").textContent).not.toMatch(/만드세요/);
    expect(
      document.querySelector('[data-testid="device-link-confirm-sas"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="device-link-sas"]')
    ).toBeNull();
    expect(filledAccentButtons(host)).toHaveLength(0);
  });

  it("awaitingConfirm is the only state with the SAS confirm filled action", async () => {
    getDeviceLink.mockResolvedValue(consumedDevice());
    const host = mount();
    await createLink();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(testId("device-link-awaiting-confirm").textContent).toMatch(/코드를 쓴/);
    expect(testId("device-link-awaiting-confirm").textContent).not.toMatch(/가 코드/);
    expect(filledAccentButtons(host)).toHaveLength(1);
    expect(filledAccentButtons(host)[0].getAttribute("data-testid")).toBe(
      "device-link-confirm-sas"
    );
  });

  it("drops the voucher from sessionStorage when the code expires", async () => {
    const token = deviceLinkFixtureToken();
    mount();
    await createLink();
    expect(liveDeepLink()).toContain(token);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await flush();
    expect(liveDeepLink()).toBeUndefined();
  });

  it("drops the voucher from sessionStorage when the code is consumed", async () => {
    const token = deviceLinkFixtureToken();
    getDeviceLink.mockResolvedValue({ status: "pending" });
    mount();
    await createLink();
    expect(liveDeepLink()).toContain(token);
    getDeviceLink.mockResolvedValue(consumedDevice());
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    expect(liveDeepLink()).toBeUndefined();
    expect(sessionStorage.getItem(DEVICE_LINK_LIVE_KEY)).toBeTruthy();
  });

  it("drops the voucher from sessionStorage on logout", () => {
    const token = deviceLinkFixtureToken();
    writeDeviceLinkLive({
      id: DEVICE_LINK_FIXTURE_ID,
      expiresAt: NOW + 120_000,
      deepLink: deviceLinkFixtureDeepLink(),
    });
    expect(liveDeepLink()).toContain(token);
    clearSession();
    expect(liveDeepLink()).toBeUndefined();
    expect(sessionStorage.getItem(DEVICE_LINK_LIVE_KEY)).toBeNull();
  });
});
