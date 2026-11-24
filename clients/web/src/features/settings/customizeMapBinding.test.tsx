// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { firstPartyGlassSources } from "@momo/core/design/glass";
import {
  APPEARANCE_LAYOUT,
  CUSTOMIZE_ITEM_IDS,
  CUSTOMIZE_MAP,
  acceptsCustomizeValue,
  type AppearanceRow,
  type AppearanceRowCondition,
  type CustomizeItemId,
} from "@momo/core/design/customizeMap";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { isKnownCode } from "@/app/shortcutBindings";
import {
  ACCENT_THEMES,
  getAppearance,
  reloadAppearanceForTest,
  subscribeSystemScheme,
  subscribeTheme,
  systemScheme,
  updateAppearance,
} from "@/design/theme";
import { ExpressionsContext } from "@/features/expressions/context";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { resetExpressionSuggestOnForTest } from "@/features/expressions/suggestSetting";
import { createExpressionFixtureTransport } from "@/features/expressions/transport";
import { LINK_PREVIEW_PREFERENCES, reloadLinkPreviewPreferenceForTest } from "@/features/timeline/linkPreviewPreference";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { AppearanceSection } from "./AppearanceSection";
import { MY_THEMES_CARD_OPEN } from "./appearance/MyThemesCard";
import { PROMINENT_ROW_OPEN } from "./appearance/ProminentRow";
import { SIDEBAR_COLOR_ROW_OPEN } from "./appearance/SidebarColorRow";
import { THREAD_LAYOUT_ROW_OPEN } from "./appearance/ThreadLayoutRow";
import { createDesktopEffects, setDesktopEffectsForTest, type DesktopEffectsDeps } from "./appearance/desktopEffects";
import { FakeMedia } from "./appearance/desktopEffectsTestKit";
import { SETTINGS_SECTIONS } from "./settingsNav";

// =============================================================================
// 꾸미기 지도(#6085, core `design/customizeMap.ts`)와 설정 › 모양의 실제 줄을 묶는다.
//
// 페이지를 진짜로 그려서 `.settings-row`를 위에서 아래로 세고, 줄마다 자리 표의 `anchor`(줄 자신이나 그 안의
// `data-testid`)로 어느 항목 · 보조 줄인지 가른다. 그래서 표에 없는 줄을 화면에 더해도, 표에만 항목 · 줄을 더해도,
// 줄의 차례나 카드를 바꿔도 빨갛다. 화면 문구는 보지 않는다(문구는 그 줄의 파일이 정본이다).
// =============================================================================

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let korean: AppLocale;
let root: Root | null = null;
let host: HTMLElement | null = null;
let stopEffects: (() => void) | null = null;

beforeAll(async () => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
  await Promise.all([import("./appearance/ThemeGallery"), import("./appearance/AccentGroup")]);
}, 60_000);

function resetStores() {
  localStorage.clear();
  reloadAppearanceForTest();
  reloadLinkPreviewPreferenceForTest(localStorage);
  resetExpressionSuggestOnForTest();
}

beforeEach(resetStores);

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  stopEffects?.();
  stopEffects = null;
  setDesktopEffectsForTest(null);
  document.documentElement.removeAttribute("data-glass");
  document.documentElement.removeAttribute("style");
  resetStores();
});

/** 맥 데스크탑 앱처럼: 유리를 쓸 수 있고 켜 둔 상태(불투명도 줄이 선다). 셸 쪽만 가짜다(GlassRows.test와 같은 고리). */
function desktopWithGlassOn() {
  const media = new Map([
    ["(prefers-reduced-transparency: reduce)", new FakeMedia(false)],
    ["(prefers-contrast: more)", new FakeMedia(false)],
  ]);
  const deps: DesktopEffectsDeps = {
    root: () => document.documentElement,
    supported: () => true,
    setVibrancy: async () => true,
    setAppTheme: async () => true,
    media: (query) => media.get(query) ?? null,
    onWake: () => () => {},
    getAppearance,
    setGlass: (glass) => updateAppearance({ glass }),
    subscribeAppearance: subscribeTheme,
    systemScheme,
    subscribeSystemScheme,
    sources: (_ref, signal) => firstPartyGlassSources("dawnsky", signal),
  };
  const effects = createDesktopEffects(deps);
  setDesktopEffectsForTest(effects);
  updateAppearance({ glass: { on: true } });
  return effects;
}

async function mountPage(opts: { desktopGlass: boolean }): Promise<HTMLElement> {
  const effects = opts.desktopGlass ? desktopWithGlassOn() : null;
  const store = new ExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID)
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <LocaleProvider locale={korean}>
        <ExpressionsContext.Provider value={store}>
          <AppearanceSection />
        </ExpressionsContext.Provider>
      </LocaleProvider>
    )
  );
  if (effects) stopEffects = effects.start();
  // 테마 격자(지연 청크)와 유리의 비동기 고리가 가라앉은 뒤에 센다.
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(
      () => {
        expect(host?.querySelector('[data-testid="theme-style-group"]')).not.toBeNull();
        if (opts.desktopGlass) expect(host?.querySelector('[data-testid="glass-opacity-row"]')).not.toBeNull();
      },
      { timeout: 15_000, interval: 10 }
    );
  } finally {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  }
  return host;
}

const label = (row: AppearanceRow) => `${"item" in row ? row.item : `(${row.aid})`}@${row.anchor}`;

/** 그려진 페이지: 카드(`section`)마다 줄 이름의 차례. 자리 표의 어느 줄로도 못 가르거나 둘 이상이면 그렇게 적는다. */
function drawnPage(page: HTMLElement): string[][] {
  const rows = APPEARANCE_LAYOUT.flatMap((card) => card.rows);
  return [...page.querySelectorAll("section")].map((section) =>
    [...section.querySelectorAll<HTMLElement>(".settings-row")].map((el) => {
      const hits = rows.filter(
        (row) => el.dataset.testid === row.anchor || el.querySelector(`[data-testid="${row.anchor}"]`) !== null
      );
      if (hits.length === 1) return label(hits[0]);
      return hits.length === 0 ? `표에 없는 줄(${el.dataset.testid ?? el.textContent?.slice(0, 12)})` : `겹친 줄(${hits.map(label).join(", ")})`;
    })
  );
}

function expectedPage(met: ReadonlySet<AppearanceRowCondition>): string[][] {
  return APPEARANCE_LAYOUT.map((card) => card.rows.filter((row) => !row.when || met.has(row.when)).map(label));
}

describe("꾸미기 지도 ↔ 설정 › 모양", () => {
  it("브라우저: 그려진 줄의 카드 · 차례 · 수가 자리 표와 같다(유리 불투명도 줄은 없다)", async () => {
    const page = await mountPage({ desktopGlass: false });
    expect(drawnPage(page)).toEqual(expectedPage(new Set(["expression-store"])));
  });

  it("맥 앱에서 유리를 켰을 때: 모든 조건의 줄이 서고, 줄을 가진 항목 수 = 표의 「설정 › 모양에 있음」 항목 수", async () => {
    const page = await mountPage({ desktopGlass: true });
    const drawn = drawnPage(page);
    expect(drawn).toEqual(expectedPage(new Set(["expression-store", "glass-adjustable"])));

    const drawnItems = new Set(drawn.flat().filter((name) => !name.startsWith("(")).map((name) => name.split("@")[0]));
    const inSettings = CUSTOMIZE_ITEM_IDS.filter(
      (id) => CUSTOMIZE_MAP[id].status === "live" && CUSTOMIZE_MAP[id].settings === "appearance"
    );
    expect(drawnItems.size).toBe(inSettings.length);
    expect([...drawnItems].sort()).toEqual([...inSettings].sort());
  });

  it("예약 항목의 행 슬롯은 닫혀 있다(슬롯을 열면 표의 항목도 live로 바꾼다)", () => {
    const slots: Partial<Record<CustomizeItemId, boolean>> = {
      prominentActive: PROMINENT_ROW_OPEN,
      sidebarColor: SIDEBAR_COLOR_ROW_OPEN,
      threadLayout: THREAD_LAYOUT_ROW_OPEN,
      myThemes: MY_THEMES_CARD_OPEN,
    };
    for (const [id, open] of Object.entries(slots)) {
      expect(open, id).toBe(CUSTOMIZE_MAP[id as CustomizeItemId].status === "live");
    }
  });
});

describe("꾸미기 지도의 값 모양 = 웹이 실제로 받는 값", () => {
  it("강조색 · 링크 미리보기의 id와 차례가 웹의 목록과 같다", () => {
    expect(CUSTOMIZE_MAP.accent.shape.options).toEqual(ACCENT_THEMES.map((theme) => theme.id));
    expect(CUSTOMIZE_MAP.linkPreview.shape.options).toEqual(LINK_PREVIEW_PREFERENCES);
  });

  it("단축키의 물리 키 집합이 설정 › 단축키의 판정(isKnownCode)과 키 전수로 같다", () => {
    const codes = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
      ..."0123456789".split("").map((d) => `Digit${d}`),
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      ...["Comma", "Period", "Slash", "Semicolon", "Quote", "Backslash", "BracketLeft", "BracketRight", "Minus", "Equal", "Backquote"],
      ...["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Enter", "Escape", "Tab", "Backspace", "Delete", "Home", "End"],
      ...["Numpad1", "IntlBackslash", "keyk", "Key", "KeyAA", ""],
    ];
    for (const code of codes) {
      expect(acceptsCustomizeValue(CUSTOMIZE_MAP.shortcuts.shape, { code, shift: false, alt: false }), code).toBe(isKnownCode(code));
    }
  });

  it("표가 가리키는 설정 갈래는 설정 목차에 있다", () => {
    const sections = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));
    for (const id of CUSTOMIZE_ITEM_IDS) {
      const place = CUSTOMIZE_MAP[id].settings;
      if (place !== null) expect(sections.has(place), id).toBe(true);
    }
  });
});
