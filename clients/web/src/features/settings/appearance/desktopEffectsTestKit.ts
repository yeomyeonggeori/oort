import type { SignalChoice } from "@momo/core/design/appearance";
import { firstPartyGlassSources, type GlassSources } from "@momo/core/design/glass";
import type { ThemeRef } from "@momo/core/design/themeResolve";
import { isThemeId } from "@momo/core/design/themes";
import type { AppearanceState } from "@/design/theme";
import {
  GLASS_ATTRIBUTE,
  REDUCED_TRANSPARENCY_QUERIES,
  createDesktopEffects,
  type DesktopEffectsDeps,
  type MediaLike,
  type RootLike,
} from "./desktopEffects";

// 창 쪽 일(`desktopEffects.ts`)을 가짜 환경으로 돌리는 시험 도구. 시험 전용이다(앱 코드가 가져가지 않는다).
// DOM 조작과 네이티브 호출이 **한 줄의 기록**(`log`)에 섞여 쌓이므로 「블러가 선 뒤에 `data-glass`」 같은
// 순서를 문자열로 단정할 수 있다. 네이티브 호출은 시험이 쥔 약속(`Deferred`)이라 끝나기 전에 다른 입력을
// 넣어 경쟁 상태를 만들 수 있다.

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

export class FakeRoot implements RootLike {
  attrs = new Map<string, string>();
  vars = new Map<string, string>();
  constructor(private readonly log: string[]) {}
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.log.push(`attr+${name}`);
  }
  removeAttribute(name: string): void {
    if (this.attrs.delete(name)) this.log.push(`attr-${name}`);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  style = {
    setProperty: (name: string, value: string) => {
      this.vars.set(name, value);
      this.log.push(name === "background" ? "bg+" : "var+");
    },
    removeProperty: (name: string) => {
      if (this.vars.delete(name)) this.log.push(name === "background" ? "bg-" : "var-");
    },
  };
}

export class FakeMedia implements MediaLike {
  listeners = new Set<() => void>();
  constructor(public matches = false) {}
  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }
  fire(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface Options {
  supported?: boolean;
  glass?: AppearanceState["glass"];
  theme?: ThemeRef;
  scheme?: "light" | "dark" | null;
  wallpaper?: AppearanceState["wallpaper"];
  signal?: SignalChoice;
  system?: "light" | "dark";
  catalog?: Record<string, GlassSources>;
  /** 시작할 때 이미 켜져 있는 접근성 질의(`REDUCED_TRANSPARENCY_QUERIES`의 하나). */
  reduced?: (typeof REDUCED_TRANSPARENCY_QUERIES)[number];
  /** 네이티브 켜기·끄기의 응답. 기본은 즉시 성공이다. */
  vibrancy?: (enabled: boolean) => Promise<boolean>;
}

export function makeEnv(options: Options = {}) {
  const log: string[] = [];
  const root = new FakeRoot(log);
  if (options.scheme) root.attrs.set("data-theme", options.scheme);
  let appearance = {
    v: 2,
    scheme: options.scheme ?? "system",
    theme: options.theme ?? "dawnsky",
    signal: options.signal ?? null,
    density: "comfortable",
    glass: options.glass,
    wallpaper: options.wallpaper,
  } as AppearanceState;
  const appListeners = new Set<() => void>();
  const sysListeners = new Set<() => void>();
  let system: "light" | "dark" = options.system ?? "light";
  const medias = new Map<string, FakeMedia>(
    REDUCED_TRANSPARENCY_QUERIES.map((q) => [q, new FakeMedia(q === options.reduced)])
  );
  const wake = new Set<() => void>();
  const nativeCalls: boolean[] = [];
  const appThemeCalls: string[] = [];
  let supported = options.supported ?? true;

  const deps: DesktopEffectsDeps = {
    root: () => root,
    supported: () => supported,
    setVibrancy: async (enabled) => {
      log.push(`native:${enabled ? "on" : "off"}`);
      nativeCalls.push(enabled);
      return options.vibrancy ? options.vibrancy(enabled) : true;
    },
    setAppTheme: async (scheme) => {
      log.push(`appTheme:${scheme}`);
      appThemeCalls.push(scheme);
      return true;
    },
    media: (query) => medias.get(query) ?? null,
    onWake: (listener) => {
      wake.add(listener);
      return () => wake.delete(listener);
    },
    getAppearance: () => appearance,
    setGlass: (glass) => set({ glass }),
    subscribeAppearance: (listener) => {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
    systemScheme: () => system,
    subscribeSystemScheme: (listener) => {
      sysListeners.add(listener);
      return () => sysListeners.delete(listener);
    },
    sources: (ref, signal) =>
      isThemeId(ref) ? firstPartyGlassSources(ref, signal) : (options.catalog?.[ref] ?? null),
  };

  function set(patch: Partial<AppearanceState>): void {
    appearance = { ...appearance, ...patch };
    // 저장소는 적용(스탬프)을 한 뒤에 알린다: 스킴이 바뀌면 `data-theme`도 먼저 바뀐다.
    if ("scheme" in patch) {
      if (appearance.scheme === "system") root.attrs.delete("data-theme");
      else root.attrs.set("data-theme", appearance.scheme);
    }
    for (const listener of [...appListeners]) listener();
  }

  const effects = createDesktopEffects(deps);
  return {
    effects,
    root,
    log,
    nativeCalls,
    appThemeCalls,
    medias,
    set,
    setSupported: (next: boolean) => {
      supported = next;
    },
    setSystem(next: "light" | "dark") {
      system = next;
      for (const listener of [...sysListeners]) listener();
    },
    wake: () => {
      for (const listener of [...wake]) listener();
    },
    appearance: () => appearance,
    painted: () => root.attrs.has(GLASS_ATTRIBUTE),
  };
}


/** 마이크로태스크가 가라앉을 때까지 기다린다(네이티브 고리가 여러 번 await 한다). */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** 색 리터럴을 시험 코드에 적지 않으려는 도구(lint가 소스의 `#rrggbb` 문자열을 막는다). 채널 값으로 만든다. */
export const fromChannels = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
