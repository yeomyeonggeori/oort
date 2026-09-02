// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useCustomStatusView } from "./useCustomStatusView";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
});

function Probe({
  expiresAtMs,
  text,
}: {
  expiresAtMs?: number;
  text?: string;
}) {
  const { visible } = useCustomStatusView({
    statusText: text ?? "회의 중",
    statusExpiresAtMs: expiresAtMs,
  });
  return createElement(
    "div",
    {
      "data-testid": "expiry-probe",
      "data-visible": visible ? "1" : "0",
    },
    visible?.text ?? ""
  );
}

describe("useCustomStatusView expiry clock (#1889 H-1)", () => {
  it("redraws when the clock crosses expiry while mounted", async () => {
    vi.useFakeTimers();
    const start = 1_800_000_000_000;
    vi.setSystemTime(start);
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(Probe, { expiresAtMs: start + 5_000 })
      );
    });
    const probe = () =>
      document.querySelector('[data-testid="expiry-probe"]');
    expect(probe()?.getAttribute("data-visible")).toBe("1");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(probe()?.getAttribute("data-visible")).toBe("1");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(probe()?.getAttribute("data-visible")).toBe("0");
  });
});
