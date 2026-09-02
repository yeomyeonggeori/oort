// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  previousMessageRowHasOpenBanner,
  rectsIntersect,
  shouldShowHoverToolbar,
} from "./hoverToolbarModel";

describe("행 배너 「닫기」와 이웃 툴바 (M-6)", () => {
  it("이전 메시지 행의 data-row-banner=open 을 읽는다", () => {
    const root = document.createElement("div");
    root.setAttribute("data-testid", "timeline-virtuoso");
    const first = document.createElement("article");
    first.setAttribute("data-testid", "timeline-message");
    first.setAttribute("data-row-banner", "open");
    const second = document.createElement("article");
    second.setAttribute("data-testid", "timeline-message");
    root.append(first, second);
    expect(previousMessageRowHasOpenBanner(second)).toBe(true);
    expect(previousMessageRowHasOpenBanner(first)).toBe(false);
  });

  it("호버 유지 중에 이웃 배너 속성이 열리면 다시 읽힌다 (N-6)", () => {
    const root = document.createElement("div");
    root.setAttribute("data-testid", "timeline-virtuoso");
    const first = document.createElement("article");
    first.setAttribute("data-testid", "timeline-message");
    const second = document.createElement("article");
    second.setAttribute("data-testid", "timeline-message");
    root.append(first, second);
    expect(previousMessageRowHasOpenBanner(second)).toBe(false);
    first.setAttribute("data-row-banner", "open");
    expect(previousMessageRowHasOpenBanner(second)).toBe(true);
  });

  it("이웃 배너가 열린 행은 툴바를 달지 않아 「닫기」와 교차하지 않는다", () => {
    const show = shouldShowHoverToolbar({
      pointerCanHover: true,
      editing: false,
      rowHovered: true,
      rowFocused: false,
      overlayOpen: false,
      selecting: false,
      neighborBannerOpen: true,
    });
    expect(show).toBe(false);
    const close = { left: 1840, right: 1973, top: 674, bottom: 706 };
    const absentToolbar = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(rectsIntersect(close, absentToolbar)).toBe(false);
  });
});
