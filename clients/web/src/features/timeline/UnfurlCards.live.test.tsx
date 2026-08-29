// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { LinkPreviewSection } from "@/features/settings/LinkPreviewSection";
import { UnfurlCardView, UnfurlCards } from "./UnfurlCards";
import { reloadLinkPreviewPreferenceForTest } from "./linkPreviewPreference";

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

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  reloadLinkPreviewPreferenceForTest(localStorage);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadLinkPreviewPreferenceForTest(null);
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(tree);
  });
  return host;
}

function Harness() {
  return createElement(
    "div",
    null,
    createElement(LinkPreviewSection),
    createElement(UnfurlCards, {
      unfurls: [base],
      canRemove: false,
      onRemove: async () => undefined,
    })
  );
}

describe("link preview live preference", () => {
  it("hides the unfurl when settings switch to 숨기기, without a reload", () => {
    const host = mount(createElement(Harness));
    expect(host.querySelector('[data-testid="unfurl-card"]')).not.toBeNull();

    const off = host.querySelector<HTMLInputElement>("#link-preview-off");
    expect(off).not.toBeNull();
    act(() => {
      off?.click();
    });
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="unfurl-group"]')).toBeNull();
  });

  it("restores the compact card from 숨기기 immediately", () => {
    const host = mount(createElement(Harness));
    act(() => {
      host.querySelector<HTMLInputElement>("#link-preview-off")?.click();
    });
    expect(host.querySelector('[data-testid="unfurl-card"]')).toBeNull();

    act(() => {
      host.querySelector<HTMLInputElement>("#link-preview-compact")?.click();
    });
    const card = host.querySelector('[data-testid="unfurl-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-layout")).toBe("compact");
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
  });
});
