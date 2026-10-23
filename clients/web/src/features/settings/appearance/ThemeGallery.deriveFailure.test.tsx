// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DeriveError } from "@momo/core/design/derive";
import { reloadAppearanceForTest, updateAppearance } from "@/design/theme";
import { derivedVarsFor, paintFor, presetsFor, defaultSignalFor } from "@/design/themes/derived";
import { AppearanceSection } from "../AppearanceSection";
import { tileTestId } from "./tileIds";

// =============================================================================
// 한 테마의 파생이 던져도 그 테마만 비운다 (AP-1b #4188, 설계 리뷰 M8). 번들 57종은 어떤 시험이 막지만 같은 함수를 쓰는
// 사용자 테마(AP-5)에는 열려 있다: `DeriveError`가 갤러리·칩·적용기 어디서도 설정 화면 전체를 무너뜨리면 안 된다.
// 파생 호출만 id로 갈라 던지게 하고(나머지는 진짜 엔진), 화면이 그 테마 하나만 비우는지 잰다.
// =============================================================================

const mocks = vi.hoisted(() => ({ failIds: new Set<string>(), failWith: "derive" as "derive" | "type" }));

vi.mock("@momo/core/design/deriveCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/design/deriveCatalog")>();
  const guard =
    <A extends unknown[], R>(fn: (id: string, ...rest: A) => R) =>
    (id: string, ...rest: A): R => {
      if (mocks.failIds.has(id)) {
        if (mocks.failWith === "type") throw new TypeError(`forced bug for ${id}`);
        throw new DeriveError("ink", `forced failure for ${id}`);
      }
      return fn(id, ...rest);
    };
  return {
    ...actual,
    deriveCatalogMode: guard(actual.deriveCatalogMode),
    deriveCatalogVars: guard(actual.deriveCatalogVars),
    catalogPresetOutcomes: guard(actual.catalogPresetOutcomes),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  await Promise.all([import("./ThemeGallery"), import("./AccentGroup")]);
}, 60_000);

beforeEach(() => {
  localStorage.clear();
  reloadAppearanceForTest();
  mocks.failIds.clear();
  mocks.failWith = "derive";
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  localStorage.clear();
  reloadAppearanceForTest();
});

const q = (host: HTMLElement, testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function mountSection(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(AppearanceSection));
  });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(
      () => {
        expect(q(host, "theme-style-trigger")).not.toBeNull();
        expect(host.querySelector<HTMLElement>('[data-testid="accent-swatch-dawn"]')?.style.getPropertyValue("--signal")).toBeTruthy();
      },
      { timeout: 15_000, interval: 10 }
    );
  } finally {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  }
  return host;
}

const paintedVars = (node: HTMLElement | null) =>
  [...(node?.querySelectorAll<HTMLElement>(".theme-tile-paint") ?? [])].map((paint) => paint.style.length);

describe("derived.ts: DeriveError는 null이 된다", () => {
  it("파생이 던지는 테마는 변수·타일·칩·기본 신호가 모두 null이고 다른 테마는 그대로다", () => {
    mocks.failIds.add("nord");
    expect(derivedVarsFor("catalog:nord", null)).toBeNull();
    expect(paintFor("catalog:nord", "dark", null)).toBeNull();
    expect(presetsFor("catalog:nord", "dark")).toBeNull();
    expect(defaultSignalFor("catalog:nord", "dark")).toBeNull();
    expect(derivedVarsFor("catalog:github", null)).not.toBeNull();
    expect(paintFor("catalog:github", "dark", null)).not.toBeNull();
    expect(presetsFor("catalog:github", "dark")).not.toBeNull();
  });

  it("DeriveError가 아닌 오류는 삼키지 않는다 (진짜 버그를 가리지 않는다)", () => {
    mocks.failIds.add("nord");
    mocks.failWith = "type";
    expect(() => derivedVarsFor("catalog:nord", null)).toThrow(TypeError);
    expect(() => paintFor("catalog:nord", "dark", null)).toThrow(TypeError);
  });
});

describe("화면: 한 테마의 파생이 던져도 설정 화면은 서고 그 타일만 빈다", () => {
  it("다크 탭에서 Nord만 던진다: 그 타일은 색을 꽂지 않고(층이 루트를 물려받는다) 나머지는 자기 색이다", async () => {
    mocks.failIds.add("nord");
    updateAppearance({ theme: "catalog:github", scheme: "dark" });
    const host = await mountSection();
    act(() => {
      q(host, "theme-style-trigger")!.click();
    });
    expect(q(host, "theme-style-options")).not.toBeNull();
    const nord = q(host, tileTestId("catalog:nord"));
    expect(nord).not.toBeNull(); // 타일은 그대로 있고
    expect(paintedVars(nord)).toEqual([0]); // 색만 비어 있다
    const github = q(host, tileTestId("catalog:github"));
    expect(paintedVars(github)[0]).toBeGreaterThan(0);
    // 칩과 나머지 화면도 선다.
    expect(host.querySelectorAll('[data-testid^="accent-swatch-"]')).toHaveLength(5);
  });

  it("고른 테마 자신이 던져도 접힌 행·칩이 무너지지 않는다 (칩은 기본 신호가 없어 그리지 않는다)", async () => {
    // 저장소가 막 읽은 값이 던지는 테마여도 화면 전체가 무너지면 안 된다: 칩은 null 결과를 그린 채 남는다.
    updateAppearance({ theme: "catalog:github", scheme: "dark" });
    mocks.failIds.add("github");
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(createElement(AppearanceSection));
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await vi.waitFor(() => expect(q(host, "theme-style-trigger")).not.toBeNull(), { timeout: 15_000, interval: 10 });
    } finally {
      reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(q(host, "theme-style-trigger")!.getAttribute("aria-label")).toContain("GitHub");
    expect(q(host, "theme-style-selected-preview")).not.toBeNull();
  });
});
