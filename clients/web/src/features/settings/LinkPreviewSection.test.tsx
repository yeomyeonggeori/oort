// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LinkPreviewSection } from "./LinkPreviewSection";
import {
  linkPreviewPreference,
  reloadLinkPreviewPreferenceForTest,
} from "@/features/timeline/linkPreviewPreference";

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

describe("LinkPreviewSection", () => {
  it("offers three radios with the house ChoiceRadios grammar", () => {
    const host = mount(createElement(LinkPreviewSection));
    const group = host.querySelector('[data-testid="link-preview-choice"]');
    expect(group).not.toBeNull();
    expect(group?.tagName).toBe("FIELDSET");

    const rich = host.querySelector<HTMLInputElement>("#link-preview-rich");
    const compact = host.querySelector<HTMLInputElement>("#link-preview-compact");
    const off = host.querySelector<HTMLInputElement>("#link-preview-off");
    expect(rich?.type).toBe("radio");
    expect(compact?.type).toBe("radio");
    expect(off?.type).toBe("radio");
    expect(rich?.checked).toBe(true);
    expect(host.textContent).toContain("사진 카드");
    expect(host.textContent).toContain("작은 카드");
    expect(host.textContent).toContain("숨기기");
  });

  it("stores the chosen value immediately", () => {
    const host = mount(createElement(LinkPreviewSection));
    act(() => {
      host.querySelector<HTMLInputElement>("#link-preview-compact")?.click();
    });
    expect(linkPreviewPreference()).toBe("compact");
    expect(localStorage.getItem("momo.web.link-preview.v1")).toBe("compact");

    act(() => {
      host.querySelector<HTMLInputElement>("#link-preview-off")?.click();
    });
    expect(linkPreviewPreference()).toBe("off");
  });

  it("writes the default when the already-selected radio is clicked", () => {
    const host = mount(createElement(LinkPreviewSection));
    expect(localStorage.getItem("momo.web.link-preview.v1")).toBeNull();
    act(() => {
      host.querySelector<HTMLInputElement>("#link-preview-rich")?.click();
    });
    expect(linkPreviewPreference()).toBe("rich");
    expect(localStorage.getItem("momo.web.link-preview.v1")).toBe("rich");
  });

  it("keeps the device-scope sentence out of the save-state live region", () => {
    const host = mount(createElement(LinkPreviewSection));
    expect(host.textContent).toContain("이 기기에만 저장됩니다");
    const statuses = [...host.querySelectorAll('[role="status"]')];
    expect(
      statuses.some((node) => node.textContent?.includes("이 기기에만 저장됩니다"))
    ).toBe(false);
  });
});
