import { DERIVED_PALETTE, effectiveScheme, modesOf, paletteOf } from "@momo/core/design/themeResolve";
import { themeCacheKey } from "@momo/core/design/themeCache";
import { getAppearance } from "@/design/theme";
import { writeThemeCache, type CacheStorage } from "@/design/themeCache";
import { DERIVE_ENGINE_VERSION, derivedVarsFor } from "./derived";

// =============================================================================
// 파생 테마를 루트에 꽂는 일 (ADR-0189 증보 3 D2, AP-1b #4188, 청사진 §5.2-i). **지연 청크**다.
//
// 첫 파티 3종은 정적 CSS가 색을 준다. 카탈로그(`catalog:`)·사용자(`user:`) 테마는 정적 CSS가 없어서 이 모듈이 파생
// 엔진의 변수를 `<html>`에 인라인으로 꽂는다(`root.style.setProperty`, CSSOM이라 CSP·프리플라이트의 `inline_style`에
// 걸리지 않는다). 스탬프(`data-palette="derived"`·`data-theme-ref`)는 외양 저장소(`theme.ts`)가 이미 찍는다.
//
// 하는 일 넷.
//   1. 변수를 꽂는다. 인라인이 스타일시트의 `:root[data-palette]` 규칙을 이기므로 **모든 역할을 빠짐없이** 꽂는
//      것이 계약이다(파생 변수 이름 집합 = 생성 팔레트 CSS의 이름 집합 + `--pane`, core `derive.test.ts`).
//   2. 테마를 바꾸거나 첫 파티로 돌아가면 **자기가 꽂은 변수를 전부 걷는다**(잔존 0). 걷을 이름은 꽂을 때 기록해
//      둔다: 부트 캐시 항목은 프라이빗 모드에서 못 쓸 수 있어 저장소 쪽 정리(`retireThemeCache`)만으로는 모자란다.
//   3. 부트 캐시(`momo.web.theme.cache.v1`)를 쓴다. 다음 부팅의 첫 페인트가 `theme-boot.js`로 이 변수를 먼저 꽂는다.
//      단일 모드 테마는 `mode`를 같이 쓴다(안 쓰면 부트와 런타임의 첫 프레임 `data-theme`가 어긋날 수 있다).
//   4. `meta theme-color`를 파생 바닥색으로 맞춘다(`applyTheme`가 첫 파티 색으로 되돌리는 쪽의 짝).
//
// 메인 번들이 아는 것은 `applyDerived.ts`의 얇은 구독뿐이다: 저장된 테마가 파생 테마일 때만 이 청크를 싣는다.
// =============================================================================

/** 이 모듈이 만지는 문서의 최소한. 진짜 `document`가 구조적으로 만족한다. */
export interface DerivedDocument {
  documentElement: {
    style: { setProperty(name: string, value: string): unknown; removeProperty(name: string): unknown };
  };
  querySelectorAll(selector: string): Iterable<{
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  }>;
}

export interface DerivedApplierOptions {
  doc?: DerivedDocument;
  storage?: CacheStorage | null;
}

const THEME_COLOR_SELECTOR = "meta[name='theme-color'][media]";

export function createDerivedApplier(options: DerivedApplierOptions = {}): { sync(): void } {
  /** 이 문서에 꽂아 둔 변수(이름 → 값). */
  const applied = new Map<string, string>();
  const documentOf = () => options.doc ?? (typeof document === "undefined" ? null : document);

  function clear(): void {
    const style = documentOf()?.documentElement.style;
    if (style) for (const name of applied.keys()) style.removeProperty(name);
    applied.clear();
  }

  /** 지금 저장소의 외양 한 벌을 문서에 맞춘다. 파생 테마가 아니면 자기가 꽂은 변수를 걷는다. */
  function sync(): void {
    const doc = documentOf();
    if (!doc) return;
    const state = getAppearance();
    const out = paletteOf(state.theme) === DERIVED_PALETTE ? derivedVarsFor(state.theme, state.signal) : null;
    if (!out) return clear();

    const { style } = doc.documentElement;
    for (const name of [...applied.keys()]) {
      if (!(name in out.vars)) {
        style.removeProperty(name);
        applied.delete(name);
      }
    }
    let changed = false;
    for (const [name, value] of Object.entries(out.vars)) {
      if (applied.get(name) === value) continue;
      style.setProperty(name, value);
      applied.set(name, value);
      changed = true;
    }

    // 브라우저 크롬: 고정이면 두 줄 모두 그 모드의 바닥색, 시스템이면 줄마다 자기 모드의 바닥색이다.
    const pinned = out.pinned ?? effectiveScheme(state.scheme, modesOf(state.theme));
    for (const meta of doc.querySelectorAll(THEME_COLOR_SELECTOR)) {
      const line = (meta.getAttribute("media") ?? "").includes("dark") ? "dark" : "light";
      const color = out.canvas[pinned ?? line];
      if (color !== undefined) meta.setAttribute("content", color);
    }

    if (changed) {
      writeThemeCache(
        {
          key: themeCacheKey(DERIVE_ENGINE_VERSION, state),
          vars: out.vars,
          ...(out.pinned ? { mode: out.pinned } : {}),
        },
        options.storage
      );
    }
  }

  return { sync };
}
