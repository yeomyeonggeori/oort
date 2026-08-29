// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  UNREAD_PILL_CLASS,
  UnreadPill,
  jumpLatestAriaLabel,
  jumpLatestLabel,
  jumpUnreadAriaLabel,
  jumpUnreadLabel,
} from "./UnreadPill";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
});

function mount(node: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(node);
  });
  return host;
}

describe("UnreadPill", () => {
  it("위 화살표와 문장형 aria-label로 한 탭 스톱이다", () => {
    const clicks: number[] = [];
    const root = mount(
      createElement(UnreadPill, {
        direction: "up",
        testId: "jump-unread",
        count: 3,
        label: jumpUnreadLabel(3),
        accessibleLabel: jumpUnreadAriaLabel(3),
        onClick: () => clicks.push(1),
      })
    );
    const button = root.querySelector<HTMLButtonElement>(
      "[data-testid='jump-unread']"
    );
    expect(button).not.toBeNull();
    if (!button) throw new Error("missing pill");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-direction")).toBe("up");
    expect(button.getAttribute("aria-label")).toBe("위쪽의 새 메시지 3개 보기");
    expect(button.textContent).toBe("새 메시지 3개 보기");
    expect(button.hasAttribute("data-unread-pill")).toBe(true);
    expect(button.className).toContain("shadow-lg");
    expect(button.className).toContain("tap-target");
    expect(button.querySelector("[data-numeric]")?.textContent).toBe("3");
    expect(button.tabIndex).toBe(0);
    expect(button.className).toBe(UNREAD_PILL_CLASS);

    act(() => {
      button.click();
    });
    expect(clicks).toEqual([1]);

    act(() => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    // Native buttons activate on Enter. jsdom does not synthesize click from
    // keydown, so the contract we can lock is: one real button, one tab stop.
    expect(button.tagName).toBe("BUTTON");
  });

  it("아래 필은 같은 옷을 입고 최신으로 간다", () => {
    const root = mount(
      createElement(UnreadPill, {
        direction: "down",
        testId: "jump-latest",
        count: 2,
        label: jumpLatestLabel(2),
        accessibleLabel: jumpLatestAriaLabel(2),
        onClick: () => undefined,
      })
    );
    const button = root.querySelector("[data-testid='jump-latest']");
    expect(button?.getAttribute("data-direction")).toBe("down");
    expect(button?.getAttribute("aria-label")).toBe("새 메시지 2개 보기");
    expect(button?.textContent).toBe("새 메시지 2개 보기");
    expect(button?.className).toBe(UNREAD_PILL_CLASS);
  });

  it("쌓인 것이 없으면 최신 이동 문장이다", () => {
    expect(jumpLatestAriaLabel(0)).toBe("최신 메시지로 이동");
    expect(jumpLatestLabel(0)).toBe("최신 메시지로 이동");
  });

  it("상단 접근명만 「위쪽의」를 붙인다", () => {
    expect(jumpUnreadAriaLabel(5)).toBe("위쪽의 새 메시지 5개 보기");
    expect(jumpLatestAriaLabel(5)).toBe("새 메시지 5개 보기");
  });
});

const timelineSource = readFileSync(
  join(process.cwd(), "src/features/timeline/Timeline.tsx"),
  "utf8"
);

describe("하단 필 회귀", () => {
  it("상·하단이 같은 UnreadPill을 쓰고 jump-latest testid를 지킨다", () => {
    expect(timelineSource).toContain('testId="jump-unread"');
    expect(timelineSource).toContain('testId="jump-latest"');
    expect(timelineSource).toContain('direction="up"');
    expect(timelineSource).toContain('direction="down"');
    expect(timelineSource).toContain("UnreadPill");
    expect(timelineSource).not.toContain("from \"lucide-react\"");
  });
});
