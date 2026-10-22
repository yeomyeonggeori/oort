// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "./AppearanceSection";
import { BackdropCard } from "./appearance/BackdropCard";

// =============================================================================
// 설정 > 모양의 합성 (AP-1a #4186, 청사진 §5.7.1 「파일 소유 규칙」).
//
// 슬롯은 카드 안에서 **실제로 불리고**, 정해진 자리에 선다. 파일만 있고 아무도 부르지 않는
// 모듈은 소유 이슈가 합성 파일을 고쳐야 하므로 「자기 파일만 만진다」가 거짓이 된다. 슬롯을
// 표식 하나로 갈아 끼워서(vi.mock) 어느 카드의 몇 번째에서 불리는지를 문서 순서로 잰다.
// 슬롯이 열기 전에 아무것도 그리지 않는다는 쪽은 짝 파일 appearanceSlots.test.tsx다.
// =============================================================================

vi.mock("./appearance/ThemeStyleRow", () => ({ ThemeStyleRow: () => <div data-testid="slot-ThemeStyleRow" /> }));
vi.mock("./appearance/GlassRows", () => ({ GlassRows: () => <div data-testid="slot-GlassRows" /> }));
vi.mock("./appearance/ProminentRow", () => ({ ProminentRow: () => <div data-testid="slot-ProminentRow" /> }));
vi.mock("./appearance/FontSizeRow", () => ({ FontSizeRow: () => <div data-testid="slot-FontSizeRow" /> }));
vi.mock("./appearance/DensityRow", () => ({ DensityRow: () => <div data-testid="slot-DensityRow" /> }));
vi.mock("./appearance/ThreadLayoutRow", () => ({ ThreadLayoutRow: () => <div data-testid="slot-ThreadLayoutRow" /> }));
vi.mock("./appearance/WallpaperRow", () => ({ WallpaperRow: () => <div data-testid="slot-WallpaperRow" /> }));
vi.mock("./appearance/SidebarColorRow", () => ({ SidebarColorRow: () => <div data-testid="slot-SidebarColorRow" /> }));
vi.mock("./appearance/MyThemesCard", () => ({ MyThemesCard: () => <div data-testid="slot-MyThemesCard" /> }));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
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

/** 카드(`section`) 하나 안에서 행·슬롯을 문서 순서로 이름 붙인다. */
function entriesOf(card: Element): string[] {
  return [...card.querySelectorAll<HTMLElement>('.settings-row, [data-testid^="slot-"]')].map((node) => {
    const slot = node.getAttribute("data-testid");
    if (slot?.startsWith("slot-")) return slot;
    return node.querySelector(":scope > div > div")?.textContent ?? "?";
  });
}

describe("합성: 슬롯이 정해진 카드의 정해진 자리에서 불린다", () => {
  const cards = (host: HTMLElement) =>
    Object.fromEntries(
      [...host.querySelectorAll("section")].map((section) => [section.querySelector("h2")?.textContent ?? "", section])
    );

  it("카드 「색상」: 색 모드 → 테마 스타일 → 강조색 → 유리 → 선택한 항목 강조 → 미리보기", () => {
    const host = mount(createElement(AppearanceSection));
    expect(entriesOf(cards(host)["색상"])).toEqual([
      "색 모드",
      "slot-ThemeStyleRow",
      "강조색",
      "slot-GlassRows",
      "slot-ProminentRow",
      "미리보기",
    ]);
  });

  it("카드 「대화 표시」: 글자 크기 → 대화 밀도 → 링크 미리보기 → 대화 미리보기 → 스레드 배치", () => {
    const host = mount(createElement(AppearanceSection));
    expect(entriesOf(cards(host)["대화 표시"])).toEqual([
      "slot-FontSizeRow",
      "slot-DensityRow",
      "링크 미리보기",
      "대화 미리보기",
      "slot-ThreadLayoutRow",
    ]);
  });

  it("페이지 순서: 색상 → (배경) → 글꼴 → 대화 표시 → (내 테마). 배경 카드는 닫혀 있어 그려지지 않는다", () => {
    const host = mount(createElement(AppearanceSection));
    const order = [...host.querySelectorAll<HTMLElement>("section > div h2, [data-testid=\"slot-MyThemesCard\"]")].map(
      (node) => node.textContent || node.getAttribute("data-testid")
    );
    expect(order).toEqual(["색상", "글꼴", "대화 표시", "slot-MyThemesCard"]);
    expect(host.querySelector('[data-testid="slot-WallpaperRow"]')).toBeNull();
    expect(host.querySelector('[data-testid="slot-SidebarColorRow"]')).toBeNull();
  });

  it("카드 「배경」은 열리면 AP-4의 행 다음에 AP-5의 행을 부른다", () => {
    const host = mount(createElement(BackdropCard, { open: true }));
    expect(host.querySelector("h2")?.textContent).toBe("배경");
    expect(entriesOf(host.querySelector("section") as Element)).toEqual([
      "slot-WallpaperRow",
      "slot-SidebarColorRow",
    ]);
  });
});
