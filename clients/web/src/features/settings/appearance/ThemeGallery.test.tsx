// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_REJECTION_COPY } from "@momo/core/design/signal";
import { THEMES } from "@momo/core/design/themes";
import {
  APPEARANCE_STORAGE_KEY,
  getAccent,
  getAppearance,
  getThemeRef,
  reloadAppearanceForTest,
  updateAppearance,
} from "@/design/theme";
import { paintFor, presetsFor, defaultSignalFor } from "@/design/themes/derived";
import { AppearanceSection } from "../AppearanceSection";
import { tileTestId } from "./tileIds";

// =============================================================================
// 테마 스타일 행과 갤러리, 색 모드 규칙, 강조색 칩 (AP-1b #4188, AC 3·6). 진짜 외양 저장소 · 진짜 엔진 · 진짜 지연
// 청크(`React.lazy` 경계 포함) 위에서 잰다. 규칙 표 자체(단일 모드 세 규칙, 목록 수)는 core 시험이 재고, 여기서는 그
// 규칙이 화면 경로에서 실제로 불리는지를 잰다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  // 지연 청크의 첫 `import()`는 vite-node가 카탈로그·엔진을 변환하는 동안 느리다. 시험마다 기다리지 않게 미리 데운다.
  await Promise.all([import("./ThemeGallery"), import("./AccentGroup")]);
}, 60_000);

beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  localStorage.clear();
  reloadAppearanceForTest();
  vi.restoreAllMocks();
});

const q = (host: HTMLElement, testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
/** 라디오 입력. 색 모드 세그먼트는 입력 자신이 testid를 들고(`theme-choice-light`), 타일·칩은 라벨이 들고 입력을 품는다. */
const radio = (host: HTMLElement, testId: string) => {
  const node = q(host, testId);
  return node instanceof HTMLInputElement ? node : (node?.querySelector<HTMLInputElement>("input") ?? null);
};

/**
 * 지연 청크가 도착해 선 화면을 기다린다. **act 밖에서** 기다린다: `act` 범위 안에서는 React가 Suspense의 재시도를
 * 큐에만 쌓고 범위가 끝나야 비우므로, 그 범위 안에서 결과를 기다리면 영영 안 온다(RTL의 `asyncWrapper`와 같은 이유로
 * 기다리는 동안만 act 환경을 끈다).
 */
async function settled(host: HTMLElement) {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(
      () => {
        expect(q(host, "theme-style-trigger")).not.toBeNull();
        // 강조색 칩: 지연 청크가 도착하면 칩 요소에 푼 색이 꽂힌다.
        expect(
          host.querySelector<HTMLElement>('[data-testid="accent-swatch-dawn"]')?.style.getPropertyValue("--signal")
        ).toBeTruthy();
      },
      { timeout: 15_000, interval: 10 }
    );
  } finally {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

function mountOnly(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(AppearanceSection));
  });
  return host;
}

async function mountSection(): Promise<HTMLElement> {
  const host = mountOnly();
  await settled(host);
  return host;
}

/** 마운트된 화면 아래에서 저장소를 바꾼다(구독자의 상태 갱신이 act 안에서 일어나게). */
function change(patch: Parameters<typeof updateAppearance>[0]) {
  act(() => updateAppearance(patch));
}

function click(node: Element | null) {
  expect(node).not.toBeNull();
  act(() => {
    (node as HTMLElement).click();
  });
}

function open(host: HTMLElement) {
  click(q(host, "theme-style-trigger"));
  expect(q(host, "theme-style-options")).not.toBeNull();
}

const tiles = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".theme-tile")];
const tileRefs = (host: HTMLElement) =>
  tiles(host).map((tile) => tile.querySelector<HTMLInputElement>("input")!.value);

function paintOf(host: HTMLElement, testId: string): Record<string, string>[] {
  return [...(q(host, testId)?.querySelectorAll<HTMLElement>(".theme-tile-paint") ?? [])].map((node) =>
    Object.fromEntries(Array.from({ length: node.style.length }, (_, i) => [node.style.item(i), node.style.getPropertyValue(node.style.item(i))]))
  );
}

describe("행: 접힌 모습", () => {
  it("청크를 받는 동안은 같은 라벨의 행과 중립 막대 자리가 서고, 강조색 칩은 기존 모양 그대로다", async () => {
    const host = mountOnly();
    // 같은 틱: 아직 아무 청크도 오지 않았다.
    const pending = q(host, "theme-style-row-pending");
    expect(pending).not.toBeNull();
    expect(pending?.textContent).toContain("테마 스타일");
    expect(pending?.querySelector(".theme-style-skeleton")).not.toBeNull();
    expect(q(host, "theme-style-trigger")).toBeNull();
    expect(host.querySelectorAll('[data-testid^="accent-swatch-"]')).toHaveLength(5);
    // 청크가 도착해 선 뒤까지 기다려서 다음 시험으로 갱신이 새지 않게 한다.
    await settled(host);
  });

  it("지금 고른 테마의 이름을 말하는 접힌 트리거 + 썸네일 한 장(시스템이면 분할)", async () => {
    const host = await mountSection();
    const trigger = q(host, "theme-style-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("테마 스타일, 지금은 새벽하늘");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(q(host, "theme-style-options")).toBeNull();
    const thumb = q(host, "theme-style-selected-preview")!.querySelector<HTMLElement>("[data-tile-kind]")!;
    expect(thumb.getAttribute("data-tile-kind")).toBe("split");
    expect(thumb.querySelectorAll(".theme-tile-paint")).toHaveLength(2);
  });

  it("접힌 행이 지금 고른 테마의 이름을 글자로 말한다 (aria-label에만 있지 않다, 설계 리뷰 M1)", async () => {
    let host = await mountSection();
    expect(q(host, "theme-style-selected-name")?.textContent).toBe("새벽하늘");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    updateAppearance({ theme: "catalog:github", scheme: "dark" });
    host = await mountSection();
    expect(q(host, "theme-style-selected-name")?.textContent).toBe("GitHub");
    change({ theme: "catalog:nord" });
    expect(q(host, "theme-style-selected-name")?.textContent).toBe("Nord");
  });

  it("이름은 한 줄이고 썸네일과 chevron은 한 덩이다: 줄바꿈 flex가 아니다 (설계 리뷰 2차 H-A · 3차 M-1)", async () => {
    const host = await mountSection();
    const name = q(host, "theme-style-selected-name")!;
    // jsdom에는 레이아웃이 없다: 클래스와 구조가 약속한 것을 고정하고, 실제 폭 위의 한 줄·배치·높이는 캡처 스크립트의 `names` 장면
    // (모든 이름 × 320~760 폭)이 잰다. 배치는 이름 길이가 아니라 카드 폭이 정한다(`theme-gallery.css`의 컨테이너 질의).
    expect(name.className).toContain("truncate");
    expect(name.className).not.toContain("break-");
    const trigger = q(host, "theme-style-trigger")!;
    expect(trigger.className).toContain("theme-style-trigger");
    // 이름이 줄바꿈 flex의 항목이면 이름마다 배치가 갈리고 chevron이 홀로 아랫줄에 떨어진다(3차 M-1).
    expect(trigger.className).not.toContain("flex-wrap");
    expect(name.parentElement).toBe(trigger);
    const tail = trigger.querySelector(".theme-style-trigger-tail")!;
    expect(tail.parentElement).toBe(trigger);
    expect(tail.contains(q(host, "theme-style-selected-preview"))).toBe(true);
    expect(tail.querySelector("svg")).not.toBeNull();
    expect(name.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("썸네일은 그 테마의 색으로 칠해진다 (루트가 아니라 요소의 변수): 새벽하늘 라이트의 바닥", async () => {
    const host = await mountSection();
    const [light, dark] = paintOf(host, "theme-style-selected-preview");
    expect(light["--canvas-mid"]).toBe(THEMES.dawnsky.light.canvas[1]);
    expect(dark["--canvas-mid"]).toBe(THEMES.dawnsky.dark.canvas[1]);
    expect(Object.keys(light)).toHaveLength(13);
  });

  it("고정 스킴이면 그 모드 한 장이고, 단일 모드 테마는 그 모드 한 장이다", async () => {
    updateAppearance({ scheme: "dark" });
    let host = await mountSection();
    expect(q(host, "theme-style-selected-preview")!.querySelector("[data-tile-kind]")!.getAttribute("data-tile-kind")).toBe("dark");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    updateAppearance({ theme: "catalog:snazzy-light", scheme: "light" });
    host = await mountSection();
    expect(q(host, "theme-style-trigger")!.getAttribute("aria-label")).toBe("테마 스타일, 지금은 Snazzy Light");
    expect(q(host, "theme-style-selected-preview")!.querySelector("[data-tile-kind]")!.getAttribute("data-tile-kind")).toBe("light");
  });
});

describe("갤러리: 색 모드가 목록을 정한다 (탭이 모드를 따른다)", () => {
  it("펼치면 격자가 서고 aria-expanded·aria-controls가 맞는다", async () => {
    const host = await mountSection();
    open(host);
    const trigger = q(host, "theme-style-trigger")!;
    const region = q(host, "theme-style-options")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(region.id);
    click(trigger);
    expect(q(host, "theme-style-options")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("시스템 19 · 라이트 20 · 다크 43 타일, 첫 파티가 먼저다", async () => {
    const host = await mountSection();
    open(host);
    expect(tiles(host)).toHaveLength(19);
    expect(tileRefs(host).slice(0, 3)).toEqual(["dawnsky", "graphite", "noeul"]);
    click(radio(host, "theme-choice-light"));
    expect(tiles(host)).toHaveLength(20);
    click(radio(host, "theme-choice-dark"));
    expect(tiles(host)).toHaveLength(43);
    expect(tileRefs(host).slice(0, 3)).toEqual(["dawnsky", "graphite", "noeul"]);
    click(radio(host, "theme-choice-system"));
    expect(tiles(host)).toHaveLength(19);
  });

  it("시스템에서는 짝이 있는 테마만 (한 장이 분할), 탭마다 안 보이는 테마가 어디서 보이는지 안내 한 줄이 선다", async () => {
    const host = await mountSection();
    open(host);
    expect(q(host, "theme-style-hint")?.textContent).toBe(
      "라이트와 다크를 모두 가진 테마만 보여요. 한쪽만 있는 테마는 라이트나 다크에서 골라요."
    );
    expect(tileRefs(host)).not.toContain("catalog:nord");
    expect(tileRefs(host)).not.toContain("catalog:snazzy-light");
    for (const tile of tiles(host)) expect(tile.querySelector("[data-tile-kind]")?.getAttribute("data-tile-kind")).toBe("split");
    click(radio(host, "theme-choice-dark"));
    expect(q(host, "theme-style-hint")?.textContent).toBe("다크가 있는 테마만 보여요. 라이트 전용 테마는 라이트에서 골라요.");
    expect(tileRefs(host)).toContain("catalog:nord");
    expect(tileRefs(host)).not.toContain("catalog:snazzy-light");
    for (const tile of tiles(host)) expect(tile.querySelector("[data-tile-kind]")?.getAttribute("data-tile-kind")).toBe("dark");
    click(radio(host, "theme-choice-light"));
    expect(q(host, "theme-style-hint")?.textContent).toBe("라이트가 있는 테마만 보여요. 다크 전용 테마는 다크에서 골라요.");
    expect(tileRefs(host)).toContain("catalog:snazzy-light");
    expect(tileRefs(host)).not.toContain("catalog:nord");
  });

  it("펼치면 고른 타일이 보이는 자리로 스크롤한다 (43장 가운데 어디에 있든, 설계 리뷰 M1)", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      updateAppearance({ theme: "catalog:github", scheme: "dark" });
      const host = await mountSection();
      expect(scrolled).toHaveLength(0); // 접힌 행은 아무것도 움직이지 않는다
      open(host);
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toBe(q(host, tileTestId("catalog:github")));
      expect(scrolled[0].hasAttribute("data-selected")).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("라디오 그룹이다: fieldset + 보이지 않는 legend, 한 이름, 고른 칸은 하나", async () => {
    const host = await mountSection();
    open(host);
    const group = q(host, "theme-style-group")!;
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")?.textContent).toBe("테마 스타일");
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(19);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["dawnsky"]);
  });

  it("타일마다 자기 테마의 색으로 칠해진다: 첫 파티도 카탈로그도 같은 길, 분할은 두 층이 다르다", async () => {
    const host = await mountSection();
    open(host);
    const dawn = paintOf(host, tileTestId("dawnsky"));
    expect(dawn).toHaveLength(2);
    expect(dawn[0]["--canvas-mid"]).toBe(THEMES.dawnsky.light.canvas[1]);
    expect(dawn[1]["--canvas-mid"]).toBe(THEMES.dawnsky.dark.canvas[1]);
    const github = paintOf(host, tileTestId("catalog:github"));
    expect(github[0]).toEqual(paintFor("catalog:github", "light", null));
    expect(github[1]).toEqual(paintFor("catalog:github", "dark", null));
    expect(github[0]["--canvas-mid"]).not.toBe(github[1]["--canvas-mid"]);
    expect(paintOf(host, tileTestId("graphite"))[1]["--canvas-mid"]).toBe(THEMES.graphite.dark.canvas[1]);
    click(radio(host, "theme-choice-dark"));
    const nord = paintOf(host, tileTestId("catalog:nord"));
    expect(nord).toHaveLength(1);
    expect(nord[0]).toEqual(paintFor("catalog:nord", "dark", null));
  });

  it("타일의 알약은 고른 강조색을 그 테마에 올린 색이다 (거절되면 그 테마의 기본 신호)", async () => {
    updateAppearance({ scheme: "dark", signal: { preset: "hyeseong" } });
    const host = await mountSection();
    open(host);
    const github = paintOf(host, tileTestId("catalog:github"))[0];
    expect(github["--signal"]).toBe(paintFor("catalog:github", "dark", { preset: "hyeseong" })!["--signal"]);
    expect(github["--signal"]).not.toBe(paintFor("catalog:github", "dark", null)!["--signal"]);
    // 거절되는 조합(홍염 × catppuccin-frappe 다크)은 그 테마의 기본 신호다.
    change({ signal: { preset: "hongyeom" } });
    const frappe = paintOf(host, tileTestId("catalog:catppuccin-frappe"))[0];
    expect(frappe["--signal"]).toBe(paintFor("catalog:catppuccin-frappe", "dark", null)!["--signal"]);
  });

  it("네 상태: 목록은 로컬 데이터라 빈 상태가 없고, 모든 모드의 모든 타일이 칠해진다 (파생이 던지는 테마가 없다)", async () => {
    const host = await mountSection();
    open(host);
    for (const mode of ["system", "light", "dark"] as const) {
      click(radio(host, `theme-choice-${mode}`));
      expect(tiles(host).length).toBeGreaterThan(0);
      for (const tile of tiles(host)) {
        for (const paint of tile.querySelectorAll<HTMLElement>(".theme-tile-paint")) {
          expect(paint.style.getPropertyValue("--canvas-mid"), `${mode} ${tile.textContent}`).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      }
    }
  });
});

describe("고르면 앱 전체가 바뀐다 (AC 3)", () => {
  it("카탈로그 테마를 고르면 저장소·루트 스탬프·저장(localStorage)·접힌 트리거가 따라온다", async () => {
    const host = await mountSection();
    open(host);
    click(radio(host, tileTestId("catalog:github")));
    expect(getThemeRef()).toBe("catalog:github");
    expect(document.documentElement.getAttribute("data-palette")).toBe("derived");
    expect(document.documentElement.getAttribute("data-theme-ref")).toBe("catalog:github");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}").theme).toBe("catalog:github");
    expect(q(host, "theme-style-trigger")!.getAttribute("aria-label")).toBe("테마 스타일, 지금은 GitHub");
    expect(q(host, tileTestId("catalog:github"))!.hasAttribute("data-selected")).toBe(true);
    expect(radio(host, tileTestId("catalog:github"))!.checked).toBe(true);
    expect(tiles(host).filter((tile) => tile.hasAttribute("data-selected"))).toHaveLength(1);
    // 쌍 테마를 시스템에서 골랐으니 색 모드는 그대로다.
    expect(getAppearance().scheme).toBe("system");
  });

  it("다크 단독 테마를 다크 목록에서 고르면 색 모드는 다크 그대로이고 안내는 없다 (이미 그 모드다)", async () => {
    updateAppearance({ scheme: "dark" });
    const host = await mountSection();
    open(host);
    click(radio(host, tileTestId("catalog:nord")));
    expect(getThemeRef()).toBe("catalog:nord");
    expect(getAppearance().scheme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(q(host, "theme-style-notice")?.textContent).toBe("");
  });

  it("새로고침 뒤에도 남는다: 저장된 레코드를 다시 읽으면 같은 테마가 선택된 타일이다", async () => {
    updateAppearance({ scheme: "light" });
    let host = await mountSection();
    open(host);
    click(radio(host, tileTestId("catalog:solarized")));
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    reloadAppearanceForTest();
    host = await mountSection();
    expect(q(host, "theme-style-trigger")!.getAttribute("aria-label")).toBe("테마 스타일, 지금은 Solarized");
    open(host);
    expect(radio(host, tileTestId("catalog:solarized"))!.checked).toBe(true);
  });

  it("첫 파티를 다시 고르면 되돌아온다", async () => {
    const host = await mountSection();
    open(host);
    click(radio(host, tileTestId("catalog:github")));
    click(radio(host, tileTestId("graphite")));
    expect(getThemeRef()).toBe("graphite");
    expect(document.documentElement.getAttribute("data-palette")).toBe("graphite");
  });

  it("Esc는 펼친 갤러리를 닫고 포커스를 트리거에 돌려준다", async () => {
    const host = await mountSection();
    open(host);
    const first = radio(host, tileTestId("graphite"))!;
    first.focus();
    act(() => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q(host, "theme-style-options")).toBeNull();
    expect(document.activeElement).toBe(q(host, "theme-style-trigger"));
  });
});

describe("색 모드를 바꿀 때 단일 모드 규칙 2·3이 화면 경로에서 불린다", () => {
  it("규칙 3: 다크 단독 테마에서 라이트로 바꾸면 새벽하늘로 옮기고 한 줄로 알린다 (스킴과 테마는 한 번에)", async () => {
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    const host = await mountSection();
    click(radio(host, "theme-choice-light"));
    expect(getAppearance().scheme).toBe("light");
    expect(getThemeRef()).toBe("dawnsky");
    expect(q(host, "theme-mode-notice")?.textContent).toBe("이 테마에는 라이트가 없어서 새벽하늘로 바꿨어요.");
  });

  it("규칙 2: 짝 없는 테마에서 시스템으로 바꾸면 새벽하늘로 옮기고 한 줄로 알린다", async () => {
    updateAppearance({ theme: "catalog:snazzy-light", scheme: "light" });
    const host = await mountSection();
    click(radio(host, "theme-choice-system"));
    expect(getAppearance().scheme).toBe("system");
    expect(getThemeRef()).toBe("dawnsky");
    expect(q(host, "theme-mode-notice")?.textContent).toBe("이 테마는 한쪽 모드만 있어서 새벽하늘로 바꿨어요.");
  });

  it("옮길 필요가 없으면 테마도 안내도 그대로다 (쌍 테마·첫 파티·같은 모드)", async () => {
    updateAppearance({ theme: "catalog:github", scheme: "dark" });
    const host = await mountSection();
    click(radio(host, "theme-choice-light"));
    click(radio(host, "theme-choice-system"));
    expect(getThemeRef()).toBe("catalog:github");
    expect(q(host, "theme-mode-notice")?.textContent).toBe("");
    change({ theme: "catalog:nord", scheme: "dark" });
    click(radio(host, "theme-choice-dark"));
    expect(getThemeRef()).toBe("catalog:nord");
    expect(q(host, "theme-mode-notice")?.textContent).toBe("");
  });

  it("안내는 다음 색 모드 변경에서 걷힌다", async () => {
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    const host = await mountSection();
    click(radio(host, "theme-choice-light"));
    expect(q(host, "theme-mode-notice")?.textContent).not.toBe("");
    click(radio(host, "theme-choice-dark"));
    expect(q(host, "theme-mode-notice")?.textContent).toBe("");
  });

  it("읽어 주는 영역은 안내가 생기기 전부터 있다: 같은 노드의 내용만 바뀐다 (설계 리뷰 M7)", async () => {
    updateAppearance({ theme: "catalog:nord", scheme: "dark" });
    const host = await mountSection();
    const region = q(host, "theme-mode-notice")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");
    click(radio(host, "theme-choice-light"));
    expect(q(host, "theme-mode-notice")).toBe(region); // 새로 붙은 노드가 아니다
    expect(region.textContent).not.toBe("");
  });
});

describe("강조색 칩: 그 테마·모드에서 푼 색과 쓸 수 있는지 (AC 6)", () => {
  const chip = (host: HTMLElement, id: string) => q(host, `accent-swatch-${id}`)!;

  it("첫 파티(흑연)에서도 칩 색은 그 테마의 값이다 (새벽하늘 값에 묶이지 않는다)", async () => {
    updateAppearance({ theme: "graphite", scheme: "light" });
    const host = await mountSection();
    const dflt = defaultSignalFor("graphite", "light")!;
    expect(chip(host, "dawn").style.getPropertyValue("--signal")).toBe(dflt.signal);
    expect(dflt.signal).not.toBe(defaultSignalFor("dawnsky", "light")!.signal);
    const presets = presetsFor("graphite", "light")!;
    for (const id of ["seongun", "hongyeom", "hyeseong", "gamram"] as const) {
      const outcome = presets[id];
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(chip(host, id).style.getPropertyValue("--signal")).toBe(outcome.signal);
    }
  });

  it("「기본」 칩의 이름: 새벽하늘이면 「새벽」, 다른 테마면 「기본」이고 설명도 그에 맞는다", async () => {
    let host = await mountSection();
    expect(chip(host, "dawn").textContent).toContain("새벽");
    expect(host.textContent).toContain("기본은 새벽이에요.");
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    updateAppearance({ theme: "catalog:github" });
    host = await mountSection();
    expect(chip(host, "dawn").textContent).toContain("기본");
    expect(chip(host, "dawn").textContent).not.toContain("새벽");
    expect(host.textContent).toContain("기본은 이 테마의 색이에요.");
  });

  it("거절되는 조합(catppuccin-frappe 다크)은 비활성이고 이유 한 줄이 선다: core의 문구 그대로", async () => {
    updateAppearance({ theme: "catalog:catppuccin-frappe", scheme: "dark" });
    const host = await mountSection();
    const outcomes = presetsFor("catalog:catppuccin-frappe", "dark")!;
    const rejected = (["seongun", "hongyeom", "hyeseong", "gamram"] as const).filter((id) => !outcomes[id].ok);
    expect(rejected).toContain("hongyeom");
    for (const id of rejected) {
      expect(chip(host, id).getAttribute("aria-disabled")).toBe("true");
      expect(radio(host, `accent-swatch-${id}`)!.disabled).toBe(true);
    }
    const reason = q(host, "accent-unavailable")!;
    // 같은 이유(위험색과 겹침)로 거절된 두 칩은 한 줄로 묶인다: 같은 문장을 칩마다 되풀이하지 않는다.
    expect(rejected).toEqual(["seongun", "hongyeom"]);
    expect(reason.textContent).toBe(`성운·홍염: ${SIGNAL_REJECTION_COPY["near-danger"]}`);
    expect(reason.id).toBe("appearance-accent-unavailable");
    expect(radio(host, "accent-swatch-hongyeom")!.getAttribute("aria-describedby")).toBe(reason.id);
    // 서는 조합은 활성이다.
    for (const id of ["dawn", "hyeseong", "gamram"] as const) {
      if (id === "dawn" || outcomes[id].ok) expect(chip(host, id).hasAttribute("aria-disabled")).toBe(false);
    }
  });

  it("비활성 칩을 눌러도 아무것도 바뀌지 않는다 (신호 저장이 그대로)", async () => {
    updateAppearance({ theme: "catalog:catppuccin-frappe", scheme: "dark" });
    const host = await mountSection();
    const before = JSON.stringify(getAppearance().signal);
    click(radio(host, "accent-swatch-hongyeom"));
    expect(JSON.stringify(getAppearance().signal)).toBe(before);
    expect(getAccent()).toBe("dawn");
  });

  it("서 있던 칩이 테마를 바꿔 거절되면 앞 테마가 꽂은 색을 걷는다 (흐린 칩이 늘 같은 정적 색이다)", async () => {
    // 홍염이 서는 테마·모드에서 거절되는 테마·모드로: 같은 화면 마운트 안에서 바꾼다.
    expect(presetsFor("catalog:github", "light")!.hongyeom.ok).toBe(true);
    expect(presetsFor("catalog:catppuccin-frappe", "dark")!.hongyeom.ok).toBe(false);
    change({ theme: "catalog:github", scheme: "light" });
    const host = await mountSection();
    expect(chip(host, "hongyeom").style.getPropertyValue("--signal")).not.toBe("");
    expect(chip(host, "hongyeom").hasAttribute("aria-disabled")).toBe(false);
    change({ theme: "catalog:catppuccin-frappe", scheme: "dark" });
    expect(chip(host, "hongyeom").getAttribute("aria-disabled")).toBe("true");
    expect(chip(host, "hongyeom").style.getPropertyValue("--signal")).toBe("");
    expect(chip(host, "hongyeom").style.getPropertyValue("--on-signal")).toBe("");
    // 서는 칩은 그대로 새 테마의 색이다.
    const outcome = presetsFor("catalog:catppuccin-frappe", "dark")!.gamram;
    expect(outcome.ok && chip(host, "gamram").style.getPropertyValue("--signal")).toBe(outcome.ok ? outcome.signal : "");
  });

  it("서는 조합은 눌러서 고른다 (칩 색은 그 테마·모드의 값)", async () => {
    updateAppearance({ theme: "catalog:catppuccin-frappe", scheme: "dark" });
    const host = await mountSection();
    click(radio(host, "accent-swatch-gamram"));
    expect(getAccent()).toBe("gamram");
    expect(radio(host, "accent-swatch-gamram")!.checked).toBe(true);
    const outcome = presetsFor("catalog:catppuccin-frappe", "dark")!.gamram;
    expect(outcome.ok && chip(host, "gamram").style.getPropertyValue("--signal")).toBe(outcome.ok ? outcome.signal : "");
  });

  it("저장된 프리셋이 이 테마에서 거절되면 「기본」 칩이 골라진 것으로 보이고 저장은 그대로다", async () => {
    updateAppearance({ theme: "catalog:catppuccin-frappe", scheme: "dark", signal: { preset: "hongyeom" } });
    const host = await mountSection();
    expect(radio(host, "accent-swatch-dawn")!.checked).toBe(true);
    expect(radio(host, "accent-swatch-hongyeom")!.checked).toBe(false);
    expect(getAccent()).toBe("hongyeom"); // 저장된 선택은 건드리지 않는다
    // 화면이 왜 기본 색인지 문장이 말한다(폰도 같은 말을 한다).
    expect(q(host, "accent-unavailable")!.textContent).toContain("고른 강조색은 이 테마에서 쓸 수 없어 기본 색으로 보여요.");
  });

  it("모든 프리셋이 서는 테마에서는 이유 줄이 없다", async () => {
    updateAppearance({ theme: "catalog:github", scheme: "light" });
    const host = await mountSection();
    expect(q(host, "accent-unavailable")).toBeNull();
    for (const id of ["dawn", "seongun", "hongyeom", "hyeseong", "gamram"]) expect(chip(host, id).hasAttribute("aria-disabled")).toBe(false);
  });
});
