// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { fetchUnfurlImage } from "@momo/core/lib/api";
import { AppearanceSection } from "@/features/settings/AppearanceSection";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { UnfurlCardView, UnfurlCards } from "./UnfurlCards";
import { reloadLinkPreviewPreferenceForTest } from "./linkPreviewPreference";
import { resetUnfurlImagesForTest } from "./useUnfurlImage";

// The picture and icon requests are the thing under test, so the network call is a spy. It never
// answers unless a test makes it: a card then stays in "loading", like a slow proxy.
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchUnfurlImage: vi.fn() };
});
const requested = vi.mocked(fetchUnfurlImage);

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const base: MessageUnfurl = {
  id: "u-1",
  messageId: "m-1",
  url: "https://example.com/guide",
  status: "ok",
  title: "운영 가이드",
  description: "문제가 생겼을 때 확인할 순서입니다.",
  domain: "example.com",
  imageUrl: "/v1/workspaces/ws/unfurls/u-1/image",
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let korean: AppLocale;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

beforeEach(() => {
  localStorage.clear();
  reloadLinkPreviewPreferenceForTest(localStorage);
  resetUnfurlImagesForTest();
  requested.mockReset();
  requested.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadLinkPreviewPreferenceForTest(null);
  resetUnfurlImagesForTest();
  vi.unstubAllGlobals();
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(LocaleProvider, { locale: korean }, tree));
  });
  return host;
}

function Harness() {
  return createElement(
    "div",
    null,
    createElement(AppearanceSection),
    createElement(UnfurlCards, {
      unfurls: [base],
      canRemove: false,
      onRemove: async () => undefined,
    })
  );
}

describe("link preview live preference", () => {
  const layoutOf = (host: HTMLElement) =>
    host.querySelector('[data-testid="unfurl-card"]')?.getAttribute("data-layout");

  it("starts on the small card and follows 크게 and 끄기 from settings without a reload", () => {
    const host = mount(createElement(Harness));
    expect(layoutOf(host)).toBe("compact");

    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-rich"]')?.click();
    });
    expect(layoutOf(host)).toBe("rich");

    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-off"]')?.click();
    });
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="unfurl-group"]')).toBeNull();
  });

  it("restores the small card from 끄기 immediately", () => {
    const host = mount(createElement(Harness));
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-off"]')?.click();
    });
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();

    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="link-preview-choice-compact"]')?.click();
    });
    expect(layoutOf(host)).toBe("compact");
  });
});

describe("rich image decode failure", () => {
  it("degrades the hero to compact when the image errors", () => {
    const host = mount(
      createElement(UnfurlCardView, {
        unfurl: base,
        image: PIXEL,
        preference: "rich",
      })
    );
    const card = host.querySelector('[data-testid="unfurl-card"]');
    expect(card?.getAttribute("data-layout")).toBe("rich");
    const img = host.querySelector<HTMLImageElement>('[data-testid="unfurl-image"]');
    expect(img).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    const after = host.querySelector('[data-testid="unfurl-card"]');
    expect(after?.getAttribute("data-layout")).toBe("compact");
    expect(host.querySelector('[data-testid="unfurl-image"]')).toBeNull();
    expect(host.querySelector('[data-testid="unfurl-hero"]')).toBeNull();
    // The broken picture becomes the icon tile, never an empty frame.
    expect(host.querySelector('[data-testid="unfurl-tile"]')).not.toBeNull();
  });
});

describe("site icon requests", () => {
  const ICON = "/v1/workspaces/ws/unfurls/u-1/icon";
  const withIcon: MessageUnfurl = { ...base, imageUrl: undefined, iconUrl: ICON };
  type Entry = { isIntersecting: boolean };
  let observers: Array<(entries: Entry[]) => void> = [];

  function stubObserver() {
    observers = [];
    class FakeObserver {
      constructor(callback: (entries: Entry[]) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  }
  const iconRequests = () => requested.mock.calls.filter(([path]) => path === ICON);

  it("asks for the icon only once the card is on screen", () => {
    stubObserver();
    mount(
      createElement(UnfurlCards, { unfurls: [withIcon], canRemove: false, preference: "compact" })
    );
    expect(observers.length).toBeGreaterThan(0);
    expect(iconRequests()).toHaveLength(0);

    act(() => observers.forEach((notify) => notify([{ isIntersecting: false }])));
    expect(iconRequests()).toHaveLength(0);

    act(() => observers.forEach((notify) => notify([{ isIntersecting: true }])));
    expect(iconRequests()).toHaveLength(1);
  });

  it("does not hold the icon back for good when the engine has no IntersectionObserver", () => {
    mount(
      createElement(UnfurlCards, { unfurls: [withIcon], canRemove: false, preference: "compact" })
    );
    expect(iconRequests()).toHaveLength(1);
  });

  it("asks for the picture at once, before the card is on screen", () => {
    stubObserver();
    mount(
      createElement(UnfurlCards, {
        unfurls: [{ ...withIcon, imageUrl: "/v1/workspaces/ws/unfurls/u-1/image" }],
        canRemove: false,
        preference: "compact",
      })
    );
    expect(requested.mock.calls.map(([path]) => path)).toEqual([
      "/v1/workspaces/ws/unfurls/u-1/image",
    ]);
  });
});
