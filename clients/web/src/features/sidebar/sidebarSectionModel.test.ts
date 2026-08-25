import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldShowSectionActions } from "./sidebarSectionModel";

const sectionSource = readFileSync(
  fileURLToPath(new URL("./SidebarRow.tsx", import.meta.url)),
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

  it("포인터 클릭 링은 focus-visible 만 쓴다", () => {
    expect(sectionSource).toContain("focus-visible:focus-ring");
    expect(sectionSource).not.toMatch(/className=\{[^}]*\bfocus:focus-ring/);
  });
});
