// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_CONFIRM_MS, useInlineConfirm } from "./inlineConfirm";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let latest: ReturnType<typeof useInlineConfirm> | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  latest = null;
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

function Probe() {
  latest = useInlineConfirm();
  return null;
}

function mountProbe() {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(Probe));
  });
}

describe("useInlineConfirm", () => {
  it("ADR-0182 D5: 확인은 1.6초에 풀리고, 그 전에는 유지된다", () => {
    expect(INLINE_CONFIRM_MS).toBe(1_600);
    mountProbe();
    expect(latest?.confirmed).toBe(false);
    act(() => {
      latest?.confirm();
    });
    expect(latest?.confirmed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_599);
    });
    expect(latest?.confirmed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latest?.confirmed).toBe(false);
  });
});
