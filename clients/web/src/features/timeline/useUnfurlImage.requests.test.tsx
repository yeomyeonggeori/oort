// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchUnfurlImage } from "@momo/core/lib/api";
import { resetUnfurlImagesForTest, useUnfurlImage } from "./useUnfurlImage";

// What the proxy has already said "not now" or "not here" to is not asked again for a while (#4882,
// #4956). The network call is a spy; the clock is the only thing the wait depends on.
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchUnfurlImage: vi.fn() };
});
const requested = vi.mocked(fetchUnfurlImage);

const ICON = "/v1/workspaces/ws/unfurls/u-1/icon";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetUnfurlImagesForTest();
  requested.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  resetUnfurlImagesForTest();
});

function Probe({ enabled = true }: { enabled?: boolean }): ReactElement {
  const status = useUnfurlImage(ICON, { enabled });
  return createElement("span", { "data-status": status.kind });
}

async function mount(enabled = true): Promise<string | null | undefined> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe, { enabled }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return host.querySelector("[data-status]")?.getAttribute("data-status");
}

function unmount() {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

describe("unfurl image requests", () => {
  it("remembers a 404 so a card that scrolls out and back in does not ask again", async () => {
    requested.mockRejectedValue(new ApiError(404, "HTTP 404"));
    expect(await mount()).toBe("failed");
    unmount();
    expect(await mount()).toBe("failed");
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it("waits the Retry-After of a 429, then asks again", async () => {
    requested.mockRejectedValue(new ApiError(429, "HTTP 429", undefined, 30));
    expect(await mount()).toBe("failed");
    unmount();

    vi.setSystemTime(new Date("2026-11-01T00:00:29Z"));
    expect(await mount()).toBe("failed");
    expect(requested).toHaveBeenCalledTimes(1);
    unmount();

    vi.setSystemTime(new Date("2026-11-01T00:00:31Z"));
    await mount();
    expect(requested).toHaveBeenCalledTimes(2);
  });

  it("does not remember a network error: the next card may succeed", async () => {
    requested.mockRejectedValue(new TypeError("offline"));
    expect(await mount()).toBe("failed");
    unmount();
    await mount();
    expect(requested).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while the gate is closed", async () => {
    requested.mockRejectedValue(new ApiError(404, "HTTP 404"));
    expect(await mount(false)).toBe("loading");
    expect(requested).not.toHaveBeenCalled();
  });
});
