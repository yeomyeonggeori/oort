// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TimelineLiveRegionProvider } from "./timelineLiveRegion";
import { useTimelineLive } from "./timelineLiveContext";

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

function Announcer({ text }: { text: string }) {
  const live = useTimelineLive();
  useEffect(() => {
    live.announce(text);
  }, [live, text]);
  return createElement("div", { "data-testid": "announcer" });
}

describe("타임라인 live 영역 (N-4)", () => {
  it("공급자 아래에서는 polite 영역이 하나이고 마지막 알림만 남는다", () => {
    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(
          TimelineLiveRegionProvider,
          null,
          createElement(Announcer, { text: "첫 알림" }),
          createElement(Announcer, { text: "여기부터 안 읽음으로 표시했습니다" })
        )
      );
    });
    const regions = host.querySelectorAll("[data-testid='message-row-live']");
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute("aria-live")).toBe("polite");
    expect(regions[0]?.textContent).toBe(
      "여기부터 안 읽음으로 표시했습니다"
    );
  });
});
