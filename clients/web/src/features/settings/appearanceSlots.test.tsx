// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackdropCard } from "./appearance/BackdropCard";
import { DensityRow } from "./appearance/DensityRow";
import { FontSizeRow } from "./appearance/FontSizeRow";
import { GlassRows } from "./appearance/GlassRows";
import { MyThemesCard } from "./appearance/MyThemesCard";
import { ProminentRow } from "./appearance/ProminentRow";
import { SidebarColorRow } from "./appearance/SidebarColorRow";
import { ThemeStyleRow } from "./appearance/ThemeStyleRow";
import { ThreadLayoutRow } from "./appearance/ThreadLayoutRow";
import { WallpaperRow } from "./appearance/WallpaperRow";

// =============================================================================
// 설정 > 모양의 골격 (AP-1a #4186, 청사진 §5.7.1 「파일 소유 규칙」).
//
// 슬롯 모듈은 소유 이슈가 열기 전까지 **아무것도 그리지 않는다**. 그래서 합성 전과 페이지의
// DOM이 같다(눌러도 안 바뀌는 컨트롤이 한 번도 나가지 않는다). 슬롯이 카드 안의 정해진 자리에서
// 실제로 불리는지는 짝 파일 appearanceComposition.test.tsx가 잰다(그 파일은 슬롯을 표식으로 갈아
// 끼우므로 이 파일과 나눠야 한다).
//
// 소유 이슈가 행을 열면 이 파일의 해당 줄(아래 표의 `open`)을 `true`로 바꾸고 자기 시험을 더한다.
// =============================================================================

const SLOTS = [
  { name: "ThemeStyleRow", owner: "AP-1b", Component: ThemeStyleRow, open: false },
  { name: "GlassRows", owner: "AP-3", Component: GlassRows, open: false },
  { name: "ProminentRow", owner: "AP-2b", Component: ProminentRow, open: false },
  { name: "FontSizeRow", owner: "AP-2a", Component: FontSizeRow, open: false },
  { name: "DensityRow", owner: "AP-2a", Component: DensityRow, open: false },
  { name: "ThreadLayoutRow", owner: "AP-2b", Component: ThreadLayoutRow, open: false },
  { name: "WallpaperRow", owner: "AP-4", Component: WallpaperRow, open: false },
  { name: "SidebarColorRow", owner: "AP-5", Component: SidebarColorRow, open: false },
  { name: "MyThemesCard", owner: "AP-5", Component: MyThemesCard, open: false },
] as const;

describe("슬롯 모듈은 열리기 전까지 아무것도 그리지 않는다 (페이지 DOM 불변)", () => {
  it.each(SLOTS.filter((slot) => !slot.open))("$name($owner)", ({ Component }) => {
    expect(renderToStaticMarkup(createElement(Component))).toBe("");
  });

  it("BackdropCard도 열기 전에는 카드 껍데기를 그리지 않는다", () => {
    expect(renderToStaticMarkup(createElement(BackdropCard))).toBe("");
  });
});
