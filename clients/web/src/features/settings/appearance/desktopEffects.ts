import { useSyncExternalStore } from "react";
import type { SignalChoice } from "@momo/core/design/appearance";
import {
  firstPartyGlassSources,
  glassOpacity,
  glassRange,
  glassVariables,
  resolveGlass,
  type GlassDecision,
  type GlassRange,
  type GlassSource,
  type GlassSources,
} from "@momo/core/design/glass";
import type { ThemeRef } from "@momo/core/design/themeResolve";
import { isThemeId, type Mode } from "@momo/core/design/themes";
import {
  getAppearance,
  subscribeSystemScheme,
  subscribeTheme,
  systemScheme,
  updateAppearance,
  type AppearanceState,
} from "@/design/theme";
import { isMacDesktop, setAppTheme, setWindowVibrancy } from "@/lib/tauri";

// =============================================================================
// 데스크탑 유리 배경의 창 쪽 일 (AP-3 #4190, ADR-0189 증보 1 D4 · 증보 3 D6).
//
// 한 일: 저장된 외양(`glass`·테마·강조색·배경화면)과 환경(맥 데스크탑인가, 투명도 줄이기인가, 네이티브
// 켜기가 됐는가)을 읽어 **그릴지**를 판정하고(`resolveGlass`, 설정 행과 같은 함수), 판정이 바뀌면 네이티브
// 블러 층과 루트의 `data-glass`·변수를 맞춘다. 외양 저장소(`design/theme.ts`)는 이 속성을 찍지도 지우지도
// 않는다(AP-1a의 약속): 켜는 순간은 네이티브가 **선 뒤**여야 해서(청사진 §5.4-b) 이 파일의 몫이다.
//
// ## 순서 (Buzz `ThemeProvider.tsx:331-356`의 경쟁 상태 방지를 우리 모양으로)
//
// 켤 때: ① 네이티브 블러를 깐다(`window_vibrancy_set(true)`: Rust가 블러를 깔고 **그 다음** 웹뷰 캔버스를
// 투명하게 만든다) ② 성공하면 변수 → 인라인 `background: transparent` → `data-glass` 순으로 루트에 꽂는다.
// 투명 바닥이 블러보다 먼저 서면 창 뒤가 비친다. 끌 때는 반대로 **`data-glass`를 먼저 걷고** 그다음
// 네이티브를 거둔다: 그림이 불투명으로 돌아온 뒤에 블러를 치운다.
//
// 네이티브 호출은 한 번에 하나이고, 끝날 때마다 **그때의** 바람을 다시 읽는다(마지막 바람이 이긴다).
// 켜는 중에 끄거나 끄는 중에 켜도 요청 번호를 따로 세지 않고 같은 고리가 맞춰 간다.
//
// ## 앱 네이티브 appearance (AC 7, Buzz에 없는 개선)
//
// `Sidebar` 재질은 페이지가 아니라 창의 effective appearance로 밝게·어둡게 흐려진다. 그래서 유리를 그리는
// 동안 색 모드가 고정이면 그 스킴을 `app_theme_set`으로 앱에 맞춘다. 이 호출은 페이지의
// `prefers-color-scheme`도 옮기므로(실측: 다크 macOS에서 `light`를 보내면 거짓이 된다) **그리는 동안에만,
// 고정일 때만** 보내고 그 밖에는 `system`으로 돌려준다.
//
// ## 세 폴백 (증보 1 D4)
//
//   미지원        브라우저·다른 OS: 이 파일은 아무것도 하지 않는다. 설정 행이 문장으로 말한다.
//   투명도 줄이기  `prefers-reduced-transparency`·`prefers-contrast: more`: 그리지 않는다(CSS도 같은 질의로
//                 불투명으로 돌아간다). 네이티브는 깔린 채다. WKWebView(macOS 27 실측)는 앞의 질의를
//                 구현하지 않아 「투명도 줄이기」는 못 읽고(`no-preference` 질의가 거짓), 뒤의 질의만
//                 읽힌다. 시스템이 투명도를 줄이면 AppKit이 블러 재질을 불투명 색으로 바꾸고 색조는
//                 하한 이상이라 어느 뒤 색이어도 읽힌다.
//   켜기 실패      `window_vibrancy_set`이 거절하면 반쯤 깔린 층을 거두고, 저장된 `glass.on`을 끄고(스위치가
//                 꺼진다), 설정 행이 문장으로 말한다. 토스트가 아니다.
// =============================================================================

export type { GlassDecision, GlassRange } from "@momo/core/design/glass";

/** 이 파일이 만지는 `<html>`의 최소한. 진짜 `document.documentElement`가 구조적으로 만족한다. */
export interface RootLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  style: { setProperty(name: string, value: string): unknown; removeProperty(name: string): unknown };
}

export interface MediaLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** 바닥을 불투명으로 돌려야 하는 시스템 접근성 질의 둘. */
export const REDUCED_TRANSPARENCY_QUERIES = [
  "(prefers-reduced-transparency: reduce)",
  "(prefers-contrast: more)",
] as const;

/** 유리가 켜졌을 때 루트에 서는 속성(이름은 core `ROOT_ATTRIBUTES.glass`다). */
export const GLASS_ATTRIBUTE = "data-glass";

export interface DesktopEffectsDeps {
  root(): RootLike | null;
  supported(): boolean;
  setVibrancy(enabled: boolean): Promise<boolean>;
  setAppTheme(scheme: "light" | "dark" | "system"): Promise<boolean>;
  media(query: string): MediaLike | null;
  /** 창이 다시 보이거나 초점을 받을 때(WKWebView가 `change`를 못 쏘는 경우의 재확인). */
  onWake(listener: () => void): () => void;
  getAppearance(): AppearanceState;
  setGlass(glass: AppearanceState["glass"]): void;
  subscribeAppearance(listener: () => void): () => void;
  systemScheme(): Mode;
  subscribeSystemScheme(listener: () => void): () => void;
  sources(ref: ThemeRef, signal: SignalChoice): GlassSources | null;
}

export interface GlassStatus {
  /** 맥 데스크탑 앱인가. */
  supported: boolean;
  /** 이번 실행에서 네이티브 켜기가 실패했는가. */
  failed: boolean;
  /** 시스템이 투명 효과를 줄이고 있는가. */
  reducedTransparency: boolean;
  /** 창에 블러 층이 깔려 있는가. */
  native: boolean;
  /** 루트에 `data-glass`가 서 있는가. */
  painted: boolean;
}

export interface GlassView {
  decision: GlassDecision;
  /** 지금 모드의 범위. 테마의 색을 아직 못 읽었으면 `null`. */
  range: GlassRange | null;
  /** 슬라이더가 보일 유효 불투명도(정수 퍼센트). 범위가 없거나 쓸 수 없으면 `null`. */
  opacity: number | null;
  /** 하한·보정을 잰 모드. */
  mode: Mode;
}

export interface GlassSnapshot {
  status: GlassStatus;
  view: GlassView;
}

export interface GlassEnv {
  supported: boolean;
  failed: boolean;
  reducedTransparency: boolean;
  mode: Mode;
  sources: GlassSources | null;
}

/** 모드의 원천. 단일 모드 테마에서 그 모드가 없으면 있는 모드로 본다(`effectiveScheme`이 못 박는 모드다). */
function sourceFor(sources: GlassSources | null, mode: Mode): GlassSource | null {
  if (!sources) return null;
  return sources[mode] ?? sources.light ?? sources.dark ?? null;
}

const rangeCache = new WeakMap<GlassSource, GlassRange>();
function rangeOf(source: GlassSource): GlassRange {
  const hit = rangeCache.get(source);
  if (hit) return hit;
  const range = glassRange(source);
  rangeCache.set(source, range);
  return range;
}

/**
 * 설정 행이 읽는 값과 창 쪽 일이 따르는 판정을 **같은 함수**로 낸다. 순수라 DOM 없이 규칙 전체를 잴 수 있다.
 * 배경화면(AP-4)과의 공존(결정 9)은 `wallpaper` 한 칸이다: 배경화면이 있으면 유리는 켤 수 없다.
 */
export function computeView(appearance: Pick<AppearanceState, "glass" | "wallpaper">, env: GlassEnv): GlassView {
  const source = sourceFor(env.sources, env.mode);
  const range = source ? rangeOf(source) : null;
  const decision = resolveGlass({
    on: appearance.glass?.on === true,
    supported: env.supported,
    floorPercent: range ? range.min : null,
    wallpaper: appearance.wallpaper !== undefined,
    failed: env.failed,
    reducedTransparency: env.reducedTransparency,
  });
  const opacity = range && range.usable ? glassOpacity(range, appearance.glass?.opacity) : null;
  return { decision, range, opacity, mode: env.mode };
}

// ---- 첫 파티 + 연결된 조회 -------------------------------------------------------

export type GlassSourcesResolver = (ref: ThemeRef, signal: SignalChoice) => GlassSources | null;

let extraResolver: GlassSourcesResolver | null = null;

/**
 * 첫 파티 밖의 테마(`catalog:`·`user:`)의 색을 이 모듈에 알리는 길. 그 색은 파생 엔진(AP-1b)이 만들고 엔진은
 * 지연 청크라, 엔진이 선 뒤에 파생 토큰(`canvas`·`band`·`color`)을 이 모양으로 돌려주는 조회를 꽂는다. 꽂기
 * 전의 비첫파티 테마는 「색을 아직 못 읽음」이라 그리지도 네이티브를 켜지도 않고, 설정 행도 그동안 걷는다(눌러도
 * 아무 일 없는 스위치를 두지 않는다). **이 연결은 나중에 머지되는 쪽(AP-1b 또는 AP-3)의 몫이다.** 엔진이 이미
 * 머지돼 있으면 파생 적용기(`derivedApplier`)가 엔진을 싣는 자리에서 한 번 꽂으면 된다:
 *
 *     registerGlassSourcesResolver((ref, signal) => {
 *       if (!ref.startsWith("catalog:")) return null; // `user:`는 AP-5
 *       const id = ref.slice("catalog:".length);
 *       const light = deriveCatalogMode(id, "light", signal)?.tokens;
 *       const dark = deriveCatalogMode(id, "dark", signal)?.tokens;
 *       return light || dark ? { ...(light && { light }), ...(dark && { dark }) } : null;
 *     });
 *
 * (`DerivedMode.tokens`는 `GlassSource` 모양을 이미 만족한다: `canvas`·`band`·`color`.)
 */
export function registerGlassSourcesResolver(resolver: GlassSourcesResolver | null): void {
  extraResolver = resolver;
  instance?.refresh();
}

let lastSources: { ref: ThemeRef; signalKey: string; value: GlassSources | null } | null = null;

function defaultSources(ref: ThemeRef, signal: SignalChoice): GlassSources | null {
  if (!isThemeId(ref)) return extraResolver ? extraResolver(ref, signal) : null;
  const signalKey = JSON.stringify(signal);
  if (lastSources && lastSources.ref === ref && lastSources.signalKey === signalKey) return lastSources.value;
  const value = firstPartyGlassSources(ref, signal);
  lastSources = { ref, signalKey, value };
  return value;
}

// ---- 창 쪽 일 ---------------------------------------------------------------------

export interface DesktopEffects {
  /** 입력(저장소·시스템 스킴·접근성 질의)을 구독하고 한 번 맞춘다. 두 번 불러도 한 번이다. */
  start(): () => void;
  /** 입력이 바뀌었다고 알리지 않아도 한 번 다시 맞춘다. */
  refresh(): void;
  /** 이번 실행의 켜기 실패 기억을 지운다(사람이 스위치를 다시 눌렀을 때). */
  clearFailure(): void;
  getSnapshot(): GlassSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createDesktopEffects(deps: DesktopEffectsDeps): DesktopEffects {
  let failed = false;
  let reduced = readReduced();
  let nativeOn = false;
  let nativeBusy = false;
  let painted = false;
  let paintedNames: string[] = [];
  let paintedKey = "";
  let pinned: "light" | "dark" | "system" = "system";
  let started = false;
  let stops: Array<() => void> = [];
  const listeners = new Set<() => void>();

  function readReduced(): boolean {
    return REDUCED_TRANSPARENCY_QUERIES.some((query) => deps.media(query)?.matches === true);
  }

  function currentMode(): Mode {
    const stamped = deps.root()?.getAttribute("data-theme");
    return stamped === "light" || stamped === "dark" ? stamped : deps.systemScheme();
  }

  function compute(): GlassSnapshot {
    const appearance = deps.getAppearance();
    const supported = deps.supported();
    const sources = deps.sources(appearance.theme, appearance.signal);
    const view = computeView(appearance, {
      supported,
      failed,
      reducedTransparency: reduced,
      mode: currentMode(),
      sources,
    });
    return { status: { supported, failed, reducedTransparency: reduced, native: nativeOn, painted }, view };
  }

  let snapshot = compute();

  function publish(): void {
    const next = compute();
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  // ---- 루트에 꽂고 걷는다 ----

  function unpaint(): void {
    const root = deps.root();
    if (!root || !painted) {
      painted = false;
      return;
    }
    // `data-glass`가 먼저다: 규칙이 불투명으로 돌아온 뒤에 인라인 투명과 변수를 거둔다.
    root.removeAttribute(GLASS_ATTRIBUTE);
    root.style.removeProperty("background");
    for (const name of paintedNames) root.style.removeProperty(name);
    paintedNames = [];
    paintedKey = "";
    painted = false;
  }

  function paintIfReady(): void {
    const { view } = compute();
    if (!view.decision.paintWanted || !nativeOn) return unpaint();
    const appearance = deps.getAppearance();
    const sources = deps.sources(appearance.theme, appearance.signal);
    const root = deps.root();
    if (!sources || !root) return unpaint();
    const key = `${appearance.theme}|${JSON.stringify(appearance.signal)}|${appearance.glass?.opacity ?? ""}`;
    if (painted && key === paintedKey) return;
    const vars = glassVariables(sources, appearance.glass?.opacity);
    const names = Object.keys(vars);
    if (names.length === 0) return unpaint();
    // 변수 → 인라인 투명 → 속성. 속성이 마지막이라 규칙이 읽는 값이 모두 선 뒤에야 반투명이 된다.
    for (const name of names) root.style.setProperty(name, vars[name]);
    for (const stale of paintedNames) if (!(stale in vars)) root.style.removeProperty(stale);
    root.style.setProperty("background", "transparent");
    root.setAttribute(GLASS_ATTRIBUTE, "");
    paintedNames = names;
    paintedKey = key;
    painted = true;
  }

  function pinAppearance(): void {
    const stamped = deps.root()?.getAttribute("data-theme");
    const want = painted && (stamped === "light" || stamped === "dark") ? stamped : "system";
    if (want === pinned) return;
    pinned = want;
    void deps.setAppTheme(want);
  }

  function afterStep(): void {
    paintIfReady();
    pinAppearance();
    publish();
  }

  function persistOff(): void {
    const opacity = deps.getAppearance().glass?.opacity;
    deps.setGlass(opacity === undefined ? undefined : { on: false, opacity });
  }

  /** 네이티브 층을 바람에 맞춘다. 한 번에 하나이고, 호출이 끝날 때마다 그때의 바람을 다시 읽는다. */
  async function reconcileNative(): Promise<void> {
    if (nativeBusy) return;
    nativeBusy = true;
    try {
      for (;;) {
        const wanted = compute().view.decision.nativeWanted;
        if (wanted === nativeOn) break;
        if (wanted) {
          const ok = await deps.setVibrancy(true);
          if (ok) {
            nativeOn = true;
          } else {
            // 켜기 실패: 반쯤 깔린 층을 거두고 스위치를 끈다(증보 1 D4 폴백 3). 문장은 설정 행이 말한다.
            failed = true;
            await deps.setVibrancy(false);
            nativeOn = false;
            persistOff();
            break;
          }
        } else {
          unpaint();
          await deps.setVibrancy(false);
          nativeOn = false;
        }
        afterStep();
      }
    } finally {
      nativeBusy = false;
    }
    afterStep();
  }

  function sync(): void {
    if (!compute().view.decision.paintWanted) unpaint();
    afterStep();
    void reconcileNative();
  }

  function onWake(): void {
    const next = readReduced();
    if (next === reduced) return;
    reduced = next;
    sync();
  }

  return {
    start(): () => void {
      const stop = () => {
        for (const off of stops) off();
        stops = [];
        started = false;
      };
      if (started) return stop;
      started = true;
      stops = [deps.subscribeAppearance(sync), deps.subscribeSystemScheme(sync), deps.onWake(onWake)];
      for (const query of REDUCED_TRANSPARENCY_QUERIES) {
        const media = deps.media(query);
        if (!media) continue;
        const onChange = () => {
          reduced = readReduced();
          sync();
        };
        media.addEventListener("change", onChange);
        stops.push(() => media.removeEventListener("change", onChange));
      }
      sync();
      return stop;
    },
    refresh: sync,
    clearFailure(): void {
      if (!failed) return;
      failed = false;
      publish();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---- 진짜 환경과 문 -----------------------------------------------------------------

function realDeps(): DesktopEffectsDeps {
  return {
    root: () => (typeof document === "undefined" ? null : document.documentElement),
    supported: isMacDesktop,
    setVibrancy: setWindowVibrancy,
    setAppTheme,
    media: (query) =>
      typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null,
    onWake(listener) {
      if (typeof window === "undefined" || typeof document === "undefined") return () => {};
      window.addEventListener("focus", listener);
      document.addEventListener("visibilitychange", listener);
      return () => {
        window.removeEventListener("focus", listener);
        document.removeEventListener("visibilitychange", listener);
      };
    },
    getAppearance,
    setGlass: (glass) => updateAppearance({ glass }),
    subscribeAppearance: subscribeTheme,
    systemScheme,
    subscribeSystemScheme,
    sources: defaultSources,
  };
}

let instance: DesktopEffects | null = null;

export function desktopEffects(): DesktopEffects {
  instance ??= createDesktopEffects(realDeps());
  return instance;
}

/** 시험 전용: 가짜 환경으로 만든 인스턴스를 문에 꽂거나(`null`이면 비운다) 한다. */
export function setDesktopEffectsForTest(next: DesktopEffects | null): void {
  instance = next;
}

/** `main.tsx`의 한 줄. 브라우저에서도 부르며(미지원 판정만 읽고 아무것도 하지 않는다), 두 번 불러도 한 번이다. */
export function installDesktopEffects(): void {
  desktopEffects().start();
}

/** 설정 행이 읽는 스냅샷. 첫 구독이 창 쪽 일을 시작한다(`installDesktopEffects`를 부르지 않은 환경도 선다). */
export function useGlassSnapshot(): GlassSnapshot {
  const effects = desktopEffects();
  return useSyncExternalStore(
    (listener) => {
      const off = effects.subscribe(listener);
      effects.start();
      return off;
    },
    effects.getSnapshot,
    effects.getSnapshot
  );
}

// ---- 설정 행이 쓰는 쓰기 ---------------------------------------------------------------

/**
 * 스위치. 새로 켜거나 끄는 것은 새 시도이므로 지난 켜기 실패의 기억을 먼저 지운다. 불투명도는 지우지 않는다:
 * 껐다 켜도 사람이 고른 값이 돌아온다.
 */
export function setGlassOn(next: boolean): void {
  desktopEffects().clearFailure();
  const opacity = getAppearance().glass?.opacity;
  updateAppearance({
    glass: opacity === undefined ? (next ? { on: true } : undefined) : { on: next, opacity },
  });
}

/** 슬라이더. 값이 있다는 것은 켜져 있다는 뜻이다(행이 켜진 동안에만 슬라이더를 보인다). `undefined`는 「기본값으로」. */
export function setGlassOpacity(percent: number | undefined): void {
  updateAppearance({ glass: percent === undefined ? { on: true } : { on: true, opacity: percent } });
}
