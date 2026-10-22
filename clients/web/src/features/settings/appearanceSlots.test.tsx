// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackdropCard } from "./appearance/BackdropCard";
import { DENSITY_ROW_OPEN, DensityRow } from "./appearance/DensityRow";
import { FONT_SIZE_ROW_OPEN, FontSizeRow } from "./appearance/FontSizeRow";
import { GLASS_ROWS_OPEN, GlassRows } from "./appearance/GlassRows";
import { MY_THEMES_CARD_OPEN, MyThemesCard } from "./appearance/MyThemesCard";
import { PROMINENT_ROW_OPEN, ProminentRow } from "./appearance/ProminentRow";
import { SIDEBAR_COLOR_ROW_OPEN, SidebarColorRow } from "./appearance/SidebarColorRow";
import { THEME_STYLE_ROW_OPEN, ThemeStyleRow } from "./appearance/ThemeStyleRow";
import { THREAD_LAYOUT_ROW_OPEN, ThreadLayoutRow } from "./appearance/ThreadLayoutRow";
import { WALLPAPER_ROW_OPEN, WallpaperRow } from "./appearance/WallpaperRow";

// =============================================================================
// 설정 > 모양의 골격 (AP-1a #4186, 청사진 §5.7.1 「파일 소유 규칙」).
//
// 슬롯 모듈은 소유 이슈가 열기 전까지 **아무것도 그리지 않는다**. 그래서 합성 전과 페이지의
// DOM이 같다(눌러도 안 바뀌는 컨트롤이 한 번도 나가지 않는다). 슬롯이 카드 안의 정해진 자리에서
// 실제로 불리는지는 짝 파일 appearanceComposition.test.tsx가 잰다(그 파일은 슬롯을 표식으로 갈아
// 끼우므로 이 파일과 나눠야 한다).
//
// 소유 이슈가 행을 열면 **자기 행 파일의 `*_OPEN` 상수**를 `true`로 바꾼다. 그 행은 아래 단정에서 저절로
// 빠지므로 이 파일은 고치지 않는다(자기 시험은 자기 파일에 더한다).
// =============================================================================

const SLOTS = [
  { name: "ThemeStyleRow", owner: "AP-1b", Component: ThemeStyleRow, open: THEME_STYLE_ROW_OPEN },
  { name: "GlassRows", owner: "AP-3", Component: GlassRows, open: GLASS_ROWS_OPEN },
  { name: "ProminentRow", owner: "AP-2b", Component: ProminentRow, open: PROMINENT_ROW_OPEN },
  { name: "FontSizeRow", owner: "AP-2a", Component: FontSizeRow, open: FONT_SIZE_ROW_OPEN },
  { name: "DensityRow", owner: "AP-2a", Component: DensityRow, open: DENSITY_ROW_OPEN },
  { name: "ThreadLayoutRow", owner: "AP-2b", Component: ThreadLayoutRow, open: THREAD_LAYOUT_ROW_OPEN },
  { name: "WallpaperRow", owner: "AP-4", Component: WallpaperRow, open: WALLPAPER_ROW_OPEN },
  { name: "SidebarColorRow", owner: "AP-5", Component: SidebarColorRow, open: SIDEBAR_COLOR_ROW_OPEN },
  { name: "MyThemesCard", owner: "AP-5", Component: MyThemesCard, open: MY_THEMES_CARD_OPEN },
] as const;

describe("슬롯 모듈은 열리기 전까지 아무것도 그리지 않는다 (페이지 DOM 불변)", () => {
  it.each(SLOTS.filter((slot) => !slot.open))("$name($owner)", ({ Component }) => {
    expect(renderToStaticMarkup(createElement(Component))).toBe("");
  });

  it("BackdropCard는 닫혀 있으면(open=false) 카드 껍데기를 그리지 않는다", () => {
    expect(renderToStaticMarkup(createElement(BackdropCard, { open: false }))).toBe("");
  });

  // 두 행이 모두 닫혀 있는 동안의 기본값. 소유 이슈가 행을 열면 이 단정은 저절로 빠지고 그 이슈의 시험이 맡는다.
  it.skipIf(WALLPAPER_ROW_OPEN || SIDEBAR_COLOR_ROW_OPEN)(
    "BackdropCard의 기본값은 두 행이 모두 닫혀 있으면 카드 껍데기가 없다",
    () => {
      expect(renderToStaticMarkup(createElement(BackdropCard))).toBe("");
    }
  );
});
