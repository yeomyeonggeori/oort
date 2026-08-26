import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countSectionActionTabStops,
  sectionUnreadTotals,
  shouldShowSectionActions,
} from "./sidebarSectionModel";

const sectionSource = readFileSync(
  fileURLToPath(new URL("./SidebarRow.tsx", import.meta.url)),
  "utf8"
);
const sidebarSource = readFileSync(
  fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)),
  "utf8"
);

describe("shouldShowSectionActions", () => {
  const rest = {
    pointerCanHover: true,
    headerHovered: false,
    headerKeyboardFocused: false,
    overlayOpen: false,
  };

  it("포인터 rest 헤더에는 안 뜬다", () => {
    expect(shouldShowSectionActions(rest)).toBe(false);
  });

  it("hover 또는 키보드 포커스이면 뜬다", () => {
    expect(shouldShowSectionActions({ ...rest, headerHovered: true })).toBe(
      true
    );
    expect(
      shouldShowSectionActions({ ...rest, headerKeyboardFocused: true })
    ).toBe(true);
  });

  it("열린 오버레이가 있으면 포인터가 떠나도 유지한다", () => {
    expect(shouldShowSectionActions({ ...rest, overlayOpen: true })).toBe(true);
  });

  it("터치에서는 항상 뜬다 (hover 가 없다)", () => {
    expect(
      shouldShowSectionActions({
        ...rest,
        pointerCanHover: false,
        headerHovered: false,
      })
    ).toBe(true);
  });
});

describe("UX-HT 계약 (소스)", () => {
  it("opacity / visibility 트릭으로 숨기지 않는다", () => {
    expect(sectionSource).not.toMatch(/\bopacity-0\b/);
    expect(sectionSource).not.toContain("invisible");
    expect(sectionSource).not.toMatch(/\bvisibility-hidden\b/);
  });

  it("접기는 호버와 별개의 상시 탭 스톱이다", () => {
    expect(sectionSource).toContain("data-testid={`section-collapse-${sectionId}`}");
    expect(sectionSource).toContain("shouldShowSectionActions");
  });

  it("overlayOpen 은 섹션 props 이고, 닫힘 전이가 hold 를 푼다 (B-1 / R2-1)", () => {
    expect(sectionSource).not.toContain("useCreateChannelOpen");
    expect(sectionSource).toContain("overlayHeld");
    expect(sectionSource).toContain("overlayOpen: overlayOpen || overlayHeld");
    expect(sectionSource).toContain("requestAnimationFrame");
    expect(sectionSource).not.toMatch(/overlayOpen:\s*false/);
  });

  it("rest 헤더는 컨트롤 높이를 바닥선으로 예약한다 (M-1 / R2-2)", () => {
    expect(sectionSource).toContain(
      'className="flex min-h-control-sm items-center gap-1 px-2"'
    );
    expect(sectionSource).not.toMatch(
      /className="flex h-control-sm items-center gap-1 px-2"/
    );
    expect(sectionSource).not.toMatch(/rounded-sm py-1 text-left text-meta/);
  });

  it("제목 버튼은 보이는 글자를 이름으로 쓴다 (N-3)", () => {
    expect(sectionSource).not.toContain("aria-label={`${title} 섹션");
    expect(sectionSource).toContain("aria-controls={collapsed ? undefined : listId}");
  });

  it("포인터 클릭 링은 focus-visible 만 쓴다", () => {
    expect(sectionSource).toContain("focus-visible:focus-ring");
    expect(sectionSource).not.toMatch(/className=\{[^}]*\bfocus:focus-ring/);
  });
});

describe("countSectionActionTabStops", () => {
  it("mounted section-action 탭 스톱만 센다", () => {
    const action = { hasAttribute: () => false, tabIndex: 0 };
    const disabled = { hasAttribute: (name: string) => name === "disabled", tabIndex: 0 };
    const root = {
      querySelectorAll: () => [action, disabled],
    } as unknown as ParentNode;
    expect(countSectionActionTabStops(root)).toBe(1);
  });
});

describe("채널 만들기 오버레이 스코프 (R2-1)", () => {
  it("전역 열림 상태는 채널 섹션에만 배선한다", () => {
    expect(sidebarSource).toContain("useCreateChannelOpen");
    expect(sidebarSource).toContain("overlayOpen={createChannelOpen}");
    const dmBlock = sidebarSource.split('sectionId="dms"')[1] ?? "";
    const dmHeader = dmBlock.slice(0, dmBlock.indexOf("</SidebarSection>"));
    expect(dmHeader).not.toContain("overlayOpen");
  });
});

describe("sectionUnreadTotals", () => {
  it("접힌 섹션이 헤더에 올릴 합을 낸다", () => {
    expect(
      sectionUnreadTotals([
        { unreadCount: 5, mentionCount: 1 },
        { unreadCount: 2, mentionCount: 0 },
      ])
    ).toEqual({ unreadCount: 7, mentionCount: 1 });
  });
});
