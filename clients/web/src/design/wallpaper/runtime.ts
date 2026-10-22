import { useSyncExternalStore } from "react";
import type { WallpaperRef } from "@momo/core/design/appearance";
import type { Mode } from "@momo/core/design/themes";
import { WALLPAPER_MIN_WINDOW_PX, isKnownWallpaper } from "@momo/core/design/wallpaper";
import { getAppearance, subscribeSystemScheme, subscribeTheme, systemScheme, updateAppearance } from "@/design/theme";
import { readDomTokens } from "./domTokens";
import { EMPTY_PLAN, planWallpaper, type PlanInput, type WallpaperPlan } from "./plan";
import { wallpaperStore, type PhotoView } from "./store";

// =============================================================================
// 배경화면을 문서에 올리는 일 (ADR-0189 증보 3 D4, AP-4 #4191).
//
// 입력이 바뀔 때마다 계획(`plan.ts`)을 다시 세우고 DOM에 옮긴다. 하는 일은 셋뿐이다.
//   · 루트 `data-wallpaper-live`: **실제로 깔릴 때만** 켠다. 외양 레코드가 찍는 `data-wallpaper`(종류)는 선택을
//     말하고, 접근성이 꺼도·이 테마에서 못 써도·사진이 아직 없어도 남아 있다. CSS의 scrim·보정 규칙은 이 속성에만
//     걸려서, 선택은 있으나 그림이 없는 동안 평평한 scrim만 서는 일이 없다. 저장소의 속성 표(`rootStamp`)는 건드리지 않는다.
//   · 루트 변수(`--wallpaper-*`): scrim 색과 보정한 역할. 깔릴 때만 꽂고 끄면 모두 걷는다(잔존 0).
//   · 배경 요소(`[data-wallpaper-layer]`)의 `backgroundColor`·`backgroundImage`: CSSOM으로 **그림이 바뀔 때만** 한 번.
//     사진은 약 2MB 문자열이라 상속되는 커스텀 프로퍼티가 아니라 이 요소의 속성에 싣는다(JSX `style=`도 아니다).
//
// 다시 세우는 계기는 외양 레코드, 시스템 스킴, 시스템 접근성 두 가지, 사진 상태, 그리고 **루트의 색이 바뀌는 순간**이다.
// 마지막은 파생 테마(AP-1b)가 자기 변수를 비동기로 꽂는 경우를 따라가려는 것이다. 이 모듈이 꽂는 변수도 루트의
// `style`을 바꾸므로 같은 계기를 한 번 더 부르지만, 입력이 같으면 서명이 같아서 아무것도 하지 않는다.
// =============================================================================

export const LIVE_ATTRIBUTE = "data-wallpaper-live";
/**
 * 켜져 있는 동안 이 테마의 사이드바에 띠(`--band`)가 있는가. 띠는 scrim 위에 불투명하게 서므로, 띠 위에 서는 열(사이드바·펼친
 * 상단 줄·설정 목록 열)의 호스트는 scrim 위의 사진이 아니라 띠다. 보정색은 scrim 최악 합성에 맞춘 값이라 그 열에서는 맞지 않아서,
 * CSS는 이 속성이 있으면 그 세 자리의 보정을 하지 않는다(`wallpaper.css`). 켜지지 않았으면 찍지 않는다.
 */
export const BAND_ATTRIBUTE = "data-wallpaper-band";

interface MediaFlag {
  matches(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface WallpaperRuntimeDeps {
  root: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    style: { setProperty(name: string, value: string): unknown; removeProperty(name: string): unknown };
  };
  /** 루트의 계산된 값. */
  readVar(name: string): string;
  appearance: { get(): { wallpaper?: WallpaperRef }; subscribe(listener: () => void): () => void };
  /** 참조가 모르는 id를 가리킬 때 「없음」으로 거둔다. */
  clearWallpaper(): void;
  photo: { get(): PhotoView; subscribe(listener: () => void): () => void; ensureLoaded(): void };
  systemScheme: { get(): Mode; subscribe(listener: () => void): () => void };
  reduceTransparency: MediaFlag;
  increaseContrast: MediaFlag;
  /** 루트의 색을 바꿀 수 있는 속성이 바뀔 때 부른다. */
  observeRoot(listener: () => void): () => void;
}

export interface WallpaperRuntime {
  attach(layer: HTMLElement): void;
  detach(): void;
  getPlan(): WallpaperPlan;
  subscribe(listener: () => void): () => void;
}

export function createWallpaperRuntime(deps: WallpaperRuntimeDeps): WallpaperRuntime {
  let layer: HTMLElement | null = null;
  let plan: WallpaperPlan = EMPTY_PLAN;
  let signature = "";
  let paintedKey = "";
  let unsubscribe: (() => void)[] = [];
  const appliedVars = new Map<string, string>();
  const listeners = new Set<() => void>();

  function effectiveMode(): Mode {
    const pinned = deps.root.getAttribute("data-theme");
    return pinned === "light" || pinned === "dark" ? pinned : deps.systemScheme.get();
  }

  function inputs(): PlanInput {
    return {
      ref: deps.appearance.get().wallpaper,
      mode: effectiveMode(),
      dom: readDomTokens(deps.readVar),
      reduceTransparency: deps.reduceTransparency.matches(),
      increaseContrast: deps.increaseContrast.matches(),
      photo: deps.photo.get(),
    };
  }

  function signatureOf(input: PlanInput): string {
    const photo = input.photo.status === "ready" ? `ready:${input.photo.rev}` : input.photo.status;
    return JSON.stringify([input.ref ?? null, input.mode, input.dom, input.reduceTransparency, input.increaseContrast, photo]);
  }

  function setBand(on: boolean): void {
    const root = deps.root;
    const has = root.getAttribute(BAND_ATTRIBUTE) !== null;
    if (on && !has) root.setAttribute(BAND_ATTRIBUTE, "");
    else if (!on && has) root.removeAttribute(BAND_ATTRIBUTE);
  }

  function apply(next: WallpaperPlan): void {
    const root = deps.root;
    const live = next.decision.live && next.paint !== null;
    const want: Readonly<Record<string, string>> = live ? next.vars : {};
    for (const name of [...appliedVars.keys()]) {
      if (!(name in want)) {
        root.style.removeProperty(name);
        appliedVars.delete(name);
      }
    }
    for (const [name, value] of Object.entries(want)) {
      if (appliedVars.get(name) === value) continue;
      root.style.setProperty(name, value);
      appliedVars.set(name, value);
    }
    if (live && next.paint !== null) {
      // 그림을 먼저 칠하고 속성을 켠다: 요소가 보이는 첫 프레임에 이미 그림이 있다.
      if (layer !== null && paintedKey !== next.paint.key) {
        layer.style.backgroundColor = next.paint.backgroundColor;
        layer.style.backgroundImage = next.paint.backgroundImage;
        paintedKey = next.paint.key;
      }
      if (root.getAttribute(LIVE_ATTRIBUTE) === null) root.setAttribute(LIVE_ATTRIBUTE, "");
      setBand(next.hasBand);
    } else {
      // 속성을 먼저 끄고 그림을 걷는다. 띠 표지는 켜짐보다 먼저 걷는다(켜짐 없이 표지만 남지 않는다).
      setBand(false);
      if (root.getAttribute(LIVE_ATTRIBUTE) !== null) root.removeAttribute(LIVE_ATTRIBUTE);
      if (layer !== null && paintedKey !== "") {
        layer.style.backgroundColor = "";
        layer.style.backgroundImage = "";
        paintedKey = "";
      }
    }
  }

  function sync(): void {
    if (layer === null) return;
    const input = inputs();
    // 모르는 id(다른 버전이 쓴 값)는 「없음」으로 거둔다. 거두면 외양 레코드가 알려서 다시 온다.
    if (input.ref !== undefined && !isKnownWallpaper(input.ref)) {
      deps.clearWallpaper();
      return;
    }
    // 참조가 사진이면 바이트를 읽어 온다(이미 읽었거나 읽는 중이면 아무 일도 없다).
    if (input.ref?.kind === "image" && input.photo.status === "none") deps.photo.ensureLoaded();
    const sig = signatureOf(input);
    if (sig === signature) return;
    signature = sig;
    plan = planWallpaper(input);
    apply(plan);
    for (const listener of [...listeners]) listener();
  }

  return {
    attach(element) {
      if (layer !== null) this.detach();
      layer = element;
      signature = "";
      unsubscribe = [
        deps.appearance.subscribe(sync),
        deps.photo.subscribe(sync),
        deps.systemScheme.subscribe(sync),
        deps.reduceTransparency.subscribe(sync),
        deps.increaseContrast.subscribe(sync),
        deps.observeRoot(sync),
      ];
      sync();
    },

    detach() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      // 앱 셸이 사라지면(로그아웃) 루트에 아무것도 남기지 않는다.
      const root = deps.root;
      setBand(false);
      if (root.getAttribute(LIVE_ATTRIBUTE) !== null) root.removeAttribute(LIVE_ATTRIBUTE);
      for (const name of appliedVars.keys()) root.style.removeProperty(name);
      appliedVars.clear();
      if (layer !== null) {
        layer.style.backgroundColor = "";
        layer.style.backgroundImage = "";
      }
      paintedKey = "";
      layer = null;
      signature = "";
      plan = EMPTY_PLAN;
      for (const listener of [...listeners]) listener();
    },

    getPlan: () => plan,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---- 브라우저에 붙이는 한 벌 -----------------------------------------------------

function mediaFlag(query: string): MediaFlag {
  const list = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  return {
    matches: () => list?.matches ?? false,
    subscribe(listener) {
      if (list === null) return () => undefined;
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
  };
}

const ROOT_ATTRIBUTES = ["style", "data-theme", "data-palette", "data-theme-ref", "data-signal"];

function browserDeps(): WallpaperRuntimeDeps {
  const root = document.documentElement;
  const store = wallpaperStore();
  return {
    root,
    readVar: (name) => getComputedStyle(root).getPropertyValue(name),
    appearance: { get: getAppearance, subscribe: subscribeTheme },
    clearWallpaper: () => updateAppearance({ wallpaper: undefined }),
    photo: {
      get: store.getView,
      subscribe: store.subscribe,
      ensureLoaded: () => void store.ensureLoaded(),
    },
    systemScheme: { get: systemScheme, subscribe: subscribeSystemScheme },
    reduceTransparency: mediaFlag("(prefers-reduced-transparency: reduce)"),
    increaseContrast: mediaFlag("(prefers-contrast: more)"),
    observeRoot(listener) {
      if (typeof MutationObserver === "undefined") return () => undefined;
      const observer = new MutationObserver(() => listener());
      observer.observe(root, { attributes: true, attributeFilter: ROOT_ATTRIBUTES });
      return () => observer.disconnect();
    },
  };
}

let instance: WallpaperRuntime | null = null;

/** 앱의 런타임. 처음 부를 때 만든다(붙는 것은 `WallpaperLayer`다). */
export function wallpaperRuntime(): WallpaperRuntime {
  if (instance === null) instance = createWallpaperRuntime(browserDeps());
  return instance;
}

/**
 * 창이 배경화면이 보이는 폭(600px 이상)보다 좁은가. 좁으면 판이 창 자체라 바닥이 보이지 않는다(core `WALLPAPER_MIN_WINDOW_PX`).
 * 설정 행이 그 사실을 말하는 데 쓴다. 질의를 모르는 환경(시험)에서는 넓은 것으로 본다.
 */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
}

const NARROW_QUERY = `(width < ${WALLPAPER_MIN_WINDOW_PX}px)`;

function narrowNow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false;
}

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

/** 설정 화면이 읽는 계획. 셸이 떠 있는 동안에만 채워져 있다. */
export function useWallpaperPlan(): WallpaperPlan {
  const runtime = wallpaperRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getPlan, runtime.getPlan);
}
