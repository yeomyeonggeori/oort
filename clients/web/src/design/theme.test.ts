import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_IDS,
  ROOT_ATTRIBUTES,
  THREAD_LAYOUT_IDS,
  WALLPAPER_KINDS,
  WEB_APPEARANCE_ENTRY,
  WEB_APPEARANCE_ENTRY_V1,
  WEB_LEGACY_SCHEME_ENTRY,
  readWebAppearance,
  serializeAppearance,
  type WebAppearance,
} from "@momo/core/design/appearance";
import { DENSITY_IDS } from "@momo/core/design/density";
import { STAMPED_ATTRIBUTES } from "@momo/core/design/rootStamp";
import { SIGNAL_PRESET_IDS } from "@momo/core/design/signal";
import {
  WEB_THEME_CACHE_ENTRY,
  cacheMatchesLook,
  parseThemeCache,
  themeCacheKey,
} from "@momo/core/design/themeCache";
import type { ModesLookup } from "@momo/core/design/themeResolve";
import { THEME_IDS } from "@momo/core/design/themes";
import {
  ACCENT_ATTRIBUTE,
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_STORAGE_KEY_V1,
  PALETTE_ATTRIBUTE,
  applyAccent,
  applyAppearance,
  applyTheme,
  normalizeAccentId,
  normalizeThemeChoice,
  SYSTEM_COLOR_ATTRIBUTE,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from "./theme";
import { THEME_CACHE_STORAGE_KEY } from "./themeCache";
import { FONT_NAME_PATTERN } from "./userFont";

/**
 * 테마 전환의 계약을 네 곳에서 잰다 (U2 + AP-1a #4186).
 *
 *   1. 스탬프 규칙 자체 (applyTheme + 가짜 문서)
 *   2. tokens.css가 그 스탬프를 **이미 아는가** — 이 티켓이 문법을 새로 만든 것이
 *      아니라 있던 문법에 스위치를 붙였다는 주장이 여기서 사실이 된다.
 *   3. 첫 페인트를 맡은 public/theme-boot.js와 index.html의 순서. FOUC는 코드가
 *      아니라 **순서**의 결함이라, 그 순서를 문장이 아니라 단언으로 붙잡는다.
 *   4. 그 부트 스크립트가 런타임 정본과 **같은 규칙**인가. 문자열을 대조하지 않고
 *      스크립트를 `node:vm`에서 **실제로 실행**해, 같은 저장소 내용을 런타임
 *      (`readWebAppearance` + `applyAppearance`)에도 먹여 두 결과 문서를 비교한다.
 *
 * 이 레포의 vitest는 node 환경이고 jsdom 의존성이 없다. 그래서 문서는 아래의
 * 가짜가 대신하고, 진짜 브라우저에서의 같은 주장은 gates/gate-theme.mjs가
 * 배포되는 번들을 실제 포인터로 몰아서 잰다.
 */

const TOKENS = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const BOOT = readFileSync(
  new URL("../../public/theme-boot.js", import.meta.url),
  "utf8"
);
const HTML = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

// 색이 아니라 **자리**를 재는 픽스처다. 실제 값은 index.html에만 있고, 이 모듈은
// 그 문자열을 옮길 뿐 읽지 않으므로, 여기서는 구분되는 이름 두 개면 충분하다.
const PAPER = "paper-by-day";
const NIGHT = "sky-after-dark";

class FakeElement {
  attrs: Record<string, string>;
  constructor(attrs: Record<string, string> = {}) {
    this.attrs = { ...attrs };
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
}

function fakeDocument(withMetas = true) {
  const documentElement = new FakeElement();
  const metas = withMetas
    ? [
        new FakeElement({
          media: "(prefers-color-scheme: light)",
          content: PAPER,
        }),
        new FakeElement({
          media: "(prefers-color-scheme: dark)",
          content: NIGHT,
        }),
      ]
    : [];
  return {
    documentElement,
    metas,
    querySelectorAll(selector: string) {
      expect(selector).toContain("theme-color");
      return metas;
    },
  };
}

describe("normalizeThemeChoice", () => {
  it("passes the three real choices through", () => {
    expect(normalizeThemeChoice("system")).toBe("system");
    expect(normalizeThemeChoice("light")).toBe("light");
    expect(normalizeThemeChoice("dark")).toBe("dark");
  });

  it("answers 시스템 for anything it does not recognise", () => {
    // 저장소에는 옛 버전이 쓴 값도, 손으로 넣은 값도 들어올 수 있다. 그중 어떤
    // 것도 화면을 알 수 없는 상태로 잠글 이유가 되지 못한다.
    for (const raw of [null, undefined, "", "LIGHT", "auto", "true", "0"]) {
      expect(normalizeThemeChoice(raw)).toBe("system");
    }
  });
});

describe("applyTheme", () => {
  it("stamps the root for a pinned scheme and clears it for 시스템", () => {
    const doc = fakeDocument();

    applyTheme("dark", doc);
    expect(doc.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");

    applyTheme("light", doc);
    expect(doc.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");

    // 시스템은 다른 값이 아니라 **부재**다. 속성이 남아 있으면 tokens.css의
    // `color-scheme: light dark`가 다시 OS를 따를 길이 없다.
    applyTheme("system", doc);
    expect(doc.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });

  it("pins the browser chrome to the chosen scheme, both lines at once", () => {
    const doc = fakeDocument();

    applyTheme("dark", doc);
    // 두 줄은 prefers-color-scheme으로 갈리므로, 하나만 바꾸면 OS가 반대쪽이던
    // 기기에서 주소창만 이전 스킴으로 남는다.
    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([
      NIGHT,
      NIGHT,
    ]);

    applyTheme("light", doc);
    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([
      PAPER,
      PAPER,
    ]);
  });

  it("gives each line back its own colour when the pin is released", () => {
    const doc = fakeDocument();

    applyTheme("dark", doc);
    applyTheme("system", doc);

    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([
      PAPER,
      NIGHT,
    ]);
  });

  it("remembers the system colours once, not once per switch", () => {
    // 되돌릴 값을 매번 다시 적으면, 두 번째 고정에서 **이미 고정된 값**이
    // 원본으로 굳는다. 그 뒤로는 시스템으로 돌아가도 주소창이 따라오지 못한다.
    const doc = fakeDocument();

    applyTheme("dark", doc);
    applyTheme("light", doc);
    applyTheme("dark", doc);
    applyTheme("system", doc);

    expect(doc.metas.map((m) => m.getAttribute(SYSTEM_COLOR_ATTRIBUTE))).toEqual(
      [PAPER, NIGHT]
    );
    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([
      PAPER,
      NIGHT,
    ]);
  });

  it("still stamps a document that carries no theme-color lines", () => {
    const doc = fakeDocument(false);
    applyTheme("light", doc);
    expect(doc.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
  });
});

describe("tokens.css already knows the stamp", () => {
  it("pins color-scheme for each value this module writes", () => {
    // 이 티켓은 문법을 새로 만들지 않았다. 아래 두 규칙은 캡처 하네스를 위해
    // 처음부터 있었고, 없던 것은 그것을 고르는 자리뿐이었다. 값이 어긋나면
    // (예: data-scheme으로 개명) 토글은 아무것도 하지 않는 스위치가 된다.
    expect(TOKENS).toMatch(
      /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/
    );
    expect(TOKENS).toMatch(
      /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/
    );
  });
});

describe("appearance storage (v2)", () => {
  it("keeps the three storage names apart, and writes only the v2 one", () => {
    expect(APPEARANCE_STORAGE_KEY).toBe(WEB_APPEARANCE_ENTRY);
    expect(APPEARANCE_STORAGE_KEY_V1).toBe(WEB_APPEARANCE_ENTRY_V1);
    expect(THEME_STORAGE_KEY).toBe(WEB_LEGACY_SCHEME_ENTRY);
    expect(new Set([APPEARANCE_STORAGE_KEY, APPEARANCE_STORAGE_KEY_V1, THEME_STORAGE_KEY]).size).toBe(3);
    expect(THEME_CACHE_STORAGE_KEY).toBe(WEB_THEME_CACHE_ENTRY);
  });

  it("serializes scheme and accent together (as a signal preset)", () => {
    const state: WebAppearance = { ...DEFAULT_APPEARANCE, scheme: "dark", signal: { preset: "seongun" } };
    expect(readWebAppearance({ v2: serializeAppearance(state) })).toEqual(state);
  });

  it("treats unknown accents as Dawn", () => {
    expect(normalizeAccentId("indigo")).toBe("dawn");
    expect(normalizeAccentId(null)).toBe("dawn");
  });

  it("migrates the legacy scheme key, and v2 beats v1 beats the legacy key", () => {
    expect(readWebAppearance({ legacyScheme: "dark" })).toEqual({ ...DEFAULT_APPEARANCE, scheme: "dark" });
    expect(readWebAppearance({ legacyScheme: "system" })).toEqual(DEFAULT_APPEARANCE);
    const v1 = JSON.stringify({ scheme: "light", accent: "gamram" });
    expect(readWebAppearance({ v1, legacyScheme: "dark" })).toMatchObject({ scheme: "light", signal: { preset: "gamram" } });
    const v2 = serializeAppearance({ ...DEFAULT_APPEARANCE, scheme: "dark" });
    expect(readWebAppearance({ v2, v1, legacyScheme: "light" }).scheme).toBe("dark");
  });
});

describe("user fonts in appearance storage (#3774)", () => {
  it("round-trips both font names through v2", () => {
    const state: WebAppearance = { ...DEFAULT_APPEARANCE, scheme: "dark", fontSans: "Pretendard", fontMono: "D2Coding" };
    expect(readWebAppearance({ v2: serializeAppearance(state) })).toEqual(state);
  });

  it("omits the keys when no font is set, so the record keeps its five-key shape", () => {
    expect(Object.keys(JSON.parse(serializeAppearance(DEFAULT_APPEARANCE)))).toEqual([
      "v",
      "scheme",
      "theme",
      "signal",
      "density",
    ]);
  });

  it("reads unknown or broken font values as undefined", () => {
    const v2 = JSON.stringify({ ...DEFAULT_APPEARANCE, scheme: "dark", fontSans: 'x"; y', fontMono: 7 });
    const parsed = readWebAppearance({ v2 });
    expect(parsed).toEqual({ ...DEFAULT_APPEARANCE, scheme: "dark" });
    expect(parsed).not.toHaveProperty("fontSans");
    expect(parsed).not.toHaveProperty("fontMono");
  });
});

describe("applyAccent", () => {
  it("stamps data-accent including Dawn", () => {
    const doc = fakeDocument(false);
    applyAccent("dawn", doc);
    expect(doc.documentElement.getAttribute(ACCENT_ATTRIBUTE)).toBe("dawn");
    applyAccent("seongun", doc);
    expect(doc.documentElement.getAttribute(ACCENT_ATTRIBUTE)).toBe("seongun");
  });
});

// ---- 부트 스크립트를 실제로 실행해 런타임과 비교한다 (AP-1a AC 2·3) ---------------------
//
// 문자열 대조는 「같은 낱말이 있다」만 말한다. 이 절은 public/theme-boot.js를 가짜 문서·저장소와
// 함께 `node:vm`에서 **돌리고**, 같은 저장소 내용을 런타임 정본(readWebAppearance +
// applyAppearance)에도 먹여서 결과 문서(속성·인라인 변수·theme-color 줄)가 같은지 본다.
// 스크립트가 표를 옮기다 한 줄을 빠뜨리거나 다르게 읽으면 여기서 빨개진다.

const V2_ENTRY = APPEARANCE_STORAGE_KEY;
const V1_ENTRY = APPEARANCE_STORAGE_KEY_V1;
const LEGACY_ENTRY = THEME_STORAGE_KEY;
const CACHE_ENTRY = THEME_CACHE_STORAGE_KEY;

class FakeStyle {
  vars = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.vars.set(name, value);
  }
  removeProperty(name: string): boolean {
    return this.vars.delete(name);
  }
}

class FakeRoot extends FakeElement {
  style = new FakeStyle();
}

class FakeStore {
  items = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(init)) this.items.set(name, value);
  }
  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  setItem(name: string, value: string): void {
    this.items.set(name, value);
  }
  removeItem(name: string): void {
    this.items.delete(name);
  }
}

function makeDoc(preset: Record<string, string> = {}) {
  const documentElement = new FakeRoot(preset);
  const metas = [
    new FakeElement({ media: "(prefers-color-scheme: light)", content: PAPER }),
    new FakeElement({ media: "(prefers-color-scheme: dark)", content: NIGHT }),
  ];
  return { documentElement, metas, querySelectorAll: () => metas };
}
type Doc = ReturnType<typeof makeDoc>;

const sorted = <T,>(entries: Array<[string, T]>) =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function snapshot(doc: Doc) {
  return {
    attrs: sorted(Object.entries(doc.documentElement.attrs)),
    vars: sorted([...doc.documentElement.style.vars.entries()]),
    // `data-theme-color-system`은 「고정을 풀 때 되돌릴 원래 색」이라 줄이 원래 색 그대로일 때는 있으나
    // 없으나 같은 문서다(런타임은 시스템일 때도 적어 두고 부트는 그때 줄을 만지지 않는다).
    metas: doc.metas.map((meta) => {
      const content = meta.getAttribute("content");
      const system = meta.getAttribute(SYSTEM_COLOR_ATTRIBUTE);
      return { content, system: system === content ? null : system };
    }),
  };
}

const BOOT_SCRIPT = new vm.Script(BOOT, { filename: "theme-boot.js" });

type Items = Record<string, string>;

function runBoot(items: Items, preset: Record<string, string> = {}): Doc {
  const doc = makeDoc(preset);
  BOOT_SCRIPT.runInNewContext({ document: doc, localStorage: new FakeStore(items) });
  return doc;
}

function runRuntime(items: Items, lookup?: ModesLookup, preset: Record<string, string> = {}): Doc {
  const doc = makeDoc(preset);
  const state = readWebAppearance({
    v2: items[V2_ENTRY] ?? null,
    v1: items[V1_ENTRY] ?? null,
    legacyScheme: items[LEGACY_ENTRY] ?? null,
  });
  applyAppearance(state, { doc, lookup, storage: new FakeStore(items) });
  return doc;
}

// 색 리터럴을 소스에 적지 않는다(lint·프리플라이트 raw_color). 값은 조각에서 조립한다.
const hex = (six: string) => `#${six}`;
const fn = (name: string, ...args: string[]) => `${name}(${args.join(", ")})`;
const lightDark = (a: string, b: string) => fn("light-dark", a, b);

const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 2, scheme: "system", theme: "dawnsky", signal: null, density: "comfortable", ...over });

const FIXTURES: Array<[string, Items]> = [
  ["저장소가 비어 있음", {}],
  [
    "v1: 다크 + 성운 + 글꼴 둘",
    { [V1_ENTRY]: JSON.stringify({ scheme: "dark", accent: "seongun", fontSans: "Pretendard", fontMono: "D2Coding" }) },
  ],
  ["v1: 모르는 액센트와 허용 밖 글꼴", { [V1_ENTRY]: JSON.stringify({ scheme: "light", accent: "indigo", fontSans: 'x"; y' }) }],
  ["v1: 문자열이 아닌 액센트", { [V1_ENTRY]: JSON.stringify({ scheme: "dark", accent: 3 }) }],
  ["옛 스킴 키만: 다크", { [LEGACY_ENTRY]: "dark" }],
  ["옛 스킴 키만: 시스템", { [LEGACY_ENTRY]: "system" }],
  ["옛 스킴 키만: 쓰레기", { [LEGACY_ENTRY]: "sepia" }],
  ["v2가 깨진 JSON이면 v1로", { [V2_ENTRY]: "{", [V1_ENTRY]: JSON.stringify({ scheme: "dark", accent: "gamram" }) }],
  ["v2의 버전이 2가 아니면 v1로", { [V2_ENTRY]: JSON.stringify({ v: 3, scheme: "dark" }), [V1_ENTRY]: JSON.stringify({ scheme: "light" }) }],
  ["v1이 깨진 JSON이면 옛 키로", { [V1_ENTRY]: "{", [LEGACY_ENTRY]: "dark" }],
  ["v1이 배열이면 옛 키로", { [V1_ENTRY]: "[1]", [LEGACY_ENTRY]: "light" }],
  ["v2가 v1·옛 키를 이긴다", { [V2_ENTRY]: record({ scheme: "dark" }), [V1_ENTRY]: JSON.stringify({ scheme: "light" }), [LEGACY_ENTRY]: "light" }],
  ["v2 기본", { [V2_ENTRY]: record() }],
  [
    "v2: 전부 기본이 아님",
    {
      [V2_ENTRY]: record({
        scheme: "dark",
        theme: "noeul",
        signal: { preset: "hongyeom" },
        density: "compact",
        fontSize: "larger",
        threadLayout: "focus",
        prominentActive: true,
        wallpaper: { kind: "preset", id: "bam" },
        fontSans: "Pretendard",
        fontMono: "D2Coding",
      }),
    },
  ],
  ["v2: 직접 고른 신호색", { [V2_ENTRY]: record({ signal: { custom: hex("9c447c") } }) }],
  ["v2: 틀린 신호색", { [V2_ENTRY]: record({ signal: { custom: hex("9c44") } }) }],
  // 두 모드를 가진 카탈로그 테마라 캐시 없이도 부트와 런타임이 같다. 모드가 하나뿐인 테마의 첫 프레임은 아래
  // 「단일 모드 테마」 절이 따로 잰다(캐시 `mode`가 있으면 같고, 없으면 첫 실행의 기본 모습 한 프레임이 허용된다).
  ["v2: 카탈로그 참조(쌍)", { [V2_ENTRY]: record({ theme: "catalog:github", scheme: "light" }) }],
  ["v2: 사용자 참조", { [V2_ENTRY]: record({ theme: "user:my-theme-2" }) }],
  ["v2: 문법이 틀린 참조", { [V2_ENTRY]: record({ theme: "catalog:Nord" }) }],
  ["v2: 너무 긴 참조", { [V2_ENTRY]: record({ theme: `catalog:${"a".repeat(41)}` }) }],
  [
    "v2: 값이 전부 쓰레기",
    {
      [V2_ENTRY]: record({
        scheme: "sepia",
        theme: 3,
        signal: "x",
        density: "dense",
        fontSize: "huge",
        threadLayout: "grid",
        prominentActive: "yes",
        wallpaper: { kind: "video" },
        fontSans: 7,
      }),
    },
  ],
  ["v2: 배경 단색 id가 틀림", { [V2_ENTRY]: record({ wallpaper: { kind: "solid", id: "Slate!" } }) }],
  ["v2: 배경 단색 id 없음", { [V2_ENTRY]: record({ wallpaper: { kind: "solid" } }) }],
  ["v2: 배경 단색 id 32자(상한 경계)", { [V2_ENTRY]: record({ wallpaper: { kind: "solid", id: "a".repeat(32) } }) }],
  ["v2: 배경 단색 id 33자(상한 초과)", { [V2_ENTRY]: record({ wallpaper: { kind: "solid", id: "a".repeat(33) } }) }],
  ["v2: 사진 배경(덤 필드가 틀려도 종류는 지킴)", { [V2_ENTRY]: record({ wallpaper: { kind: "image", width: -1 } }) }],
  ["v2: 유리 필드는 부트가 읽지 않음", { [V2_ENTRY]: record({ glass: { on: true, opacity: 80 } }) }],
];

// core 목록의 **모든** id를 부트에 먹인다: 목록에 값이 늘었는데 부트가 따라오지 않으면 여기서 빨개진다.
for (const theme of THEME_IDS) FIXTURES.push([`목록: 테마 ${theme}`, { [V2_ENTRY]: record({ theme }) }]);
for (const preset of SIGNAL_PRESET_IDS) FIXTURES.push([`목록: 신호 ${preset}`, { [V2_ENTRY]: record({ signal: { preset } }) }]);
for (const density of DENSITY_IDS) FIXTURES.push([`목록: 밀도 ${density}`, { [V2_ENTRY]: record({ density }) }]);
for (const fontSize of FONT_SIZE_IDS) FIXTURES.push([`목록: 글자 크기 ${fontSize}`, { [V2_ENTRY]: record({ fontSize }) }]);
for (const threadLayout of THREAD_LAYOUT_IDS) {
  FIXTURES.push([`목록: 스레드 배치 ${threadLayout}`, { [V2_ENTRY]: record({ threadLayout }) }]);
}
for (const kind of WALLPAPER_KINDS) {
  FIXTURES.push([`목록: 배경 ${kind}`, { [V2_ENTRY]: record({ wallpaper: kind === "image" ? { kind } : { kind, id: "bam" } }) }]);
}
for (const scheme of ["system", "light", "dark"]) FIXTURES.push([`목록: 스킴 ${scheme}`, { [V2_ENTRY]: record({ scheme }) }]);

describe("the pre-paint boot script is the runtime rule, executed (ADR-0189 증보 3, AP-1a)", () => {
  it.each(FIXTURES)("같은 저장소 → 같은 문서: %s", (_name, items) => {
    expect(snapshot(runBoot(items))).toEqual(snapshot(runRuntime(items)));
  });

  it("목록 시험이 헛돌지 않는다: 값이 다르면 문서도 다르다", () => {
    const a = snapshot(runBoot({ [V2_ENTRY]: record({ fontSize: "smaller" }) }));
    const b = snapshot(runBoot({ [V2_ENTRY]: record({ fontSize: "larger" }) }));
    expect(a.attrs["data-font-size"]).toBe("smaller");
    expect(b.attrs["data-font-size"]).toBe("larger");
    expect(a).not.toEqual(b);
  });

  it("v1에서 이어받은 값이 실제로 문서에 선다 (양쪽이 같이 틀리는 길을 막는다)", () => {
    const doc = runBoot(FIXTURES[1][1]);
    expect(snapshot(doc).attrs).toMatchObject({
      "data-theme": "dark",
      "data-palette": "dawnsky",
      "data-theme-ref": "dawnsky",
      "data-signal": "seongun",
      "data-accent": "seongun",
      "data-density": "comfortable",
      "data-font-size": "default",
      "data-thread-layout": "split",
      "data-font-sans": "",
      "data-font-mono": "",
    });
    expect(snapshot(doc).vars).toEqual({
      "--font-user-sans": '"Pretendard", var(--font-sans)',
      "--font-user-mono": '"D2Coding", var(--font-mono)',
    });
    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([NIGHT, NIGHT]);
  });

  it("스킴이 시스템이어도 팔레트·신호·글꼴은 찍힌다 (조기 반환보다 앞)", () => {
    const doc = runBoot({ [V1_ENTRY]: JSON.stringify({ scheme: "system", accent: "gamram", fontSans: "Pretendard" }) });
    const { attrs, vars } = snapshot(doc);
    expect(attrs).not.toHaveProperty("data-theme");
    expect(attrs).toMatchObject({ "data-palette": "dawnsky", "data-accent": "gamram", "data-signal": "gamram" });
    expect(vars["--font-user-sans"]).toBe('"Pretendard", var(--font-sans)');
    expect(doc.metas.map((m) => m.getAttribute("content"))).toEqual([PAPER, NIGHT]);
  });

  it("v2 하나로 모든 열 속성이 선다 (data-glass 제외)", () => {
    const { attrs } = snapshot(
      runBoot({
        [V2_ENTRY]: record({
          scheme: "light",
          theme: "graphite",
          signal: { preset: "hyeseong" },
          density: "compact",
          fontSize: "smaller",
          threadLayout: "focus",
          prominentActive: true,
          wallpaper: { kind: "solid", id: "slate" },
        }),
      })
    );
    expect(Object.keys(attrs).sort()).toEqual([...STAMPED_ATTRIBUTES].sort());
    expect(attrs).toEqual({
      "data-theme": "light",
      "data-palette": "graphite",
      "data-theme-ref": "graphite",
      "data-signal": "hyeseong",
      "data-accent": "hyeseong",
      "data-density": "compact",
      "data-font-size": "smaller",
      "data-thread-layout": "focus",
      "data-prominent-active": "",
      "data-wallpaper": "solid",
    });
  });

  it("data-glass는 부트도 런타임도 찍지도 지우지도 않는다 (AP-3의 몫, planner 결정 2026-10-22)", () => {
    const preset = { [ROOT_ATTRIBUTES.glass]: "" };
    const cases: Items[] = [{}, { [V2_ENTRY]: record({ glass: { on: true, opacity: 80 } }) }];
    for (const items of cases) {
      expect(snapshot(runBoot(items, preset)).attrs).toHaveProperty("data-glass", "");
      expect(snapshot(runRuntime(items, undefined, preset)).attrs).toHaveProperty("data-glass", "");
    }
    expect(BOOT).not.toMatch(/setAttribute\(\s*["']data-glass/);
    expect(STAMPED_ATTRIBUTES).not.toContain(ROOT_ATTRIBUTES.glass);
  });

  it("저장소가 막혀 있어도 던지지 않고 기본을 찍는다", () => {
    const doc = makeDoc();
    const denied = {
      getItem() {
        throw new Error("denied");
      },
    };
    expect(() => BOOT_SCRIPT.runInNewContext({ document: doc, localStorage: denied })).not.toThrow();
    expect(snapshot(doc).attrs).toMatchObject({ "data-palette": "dawnsky", "data-theme-ref": "dawnsky" });
    expect(snapshot(doc).attrs).not.toHaveProperty("data-theme");
    // localStorage 전역이 아예 없는 환경.
    const bare = makeDoc();
    expect(() => BOOT_SCRIPT.runInNewContext({ document: bare })).not.toThrow();
    expect(snapshot(bare).attrs).toMatchObject({ "data-palette": "dawnsky" });
  });

  it("고전 스크립트다: 화살표·const·let·템플릿 리터럴이 없다 (구형 웹뷰의 첫 페인트)", () => {
    const code = BOOT.split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/\b(?:const|let)\s/);
    expect(code).not.toContain("`");
  });
});

describe("단일 모드 테마: 스토어와 부트가 같은 모드로 못 박는다 (AP-1a AC 8, AP-1b #4188)", () => {
  // AP-1b: 카탈로그 색인이 진짜 답을 한다. nord는 다크 단독이다(24종 가운데 하나).
  const SOLO = "catalog:nord";
  const doc = (scheme: string, theme: string = SOLO) => ({ [V2_ENTRY]: record({ scheme, theme }) });

  it.each(["system", "light", "dark"])("런타임: 스킴 %s여도 다크 단독 테마는 data-theme=dark", (scheme) => {
    const { attrs, metas } = snapshot(runRuntime(doc(scheme)));
    expect(attrs["data-theme"]).toBe("dark");
    expect(metas.map((m) => m.content)).toEqual([NIGHT, NIGHT]);
  });

  it("런타임: 라이트 단독 테마는 스킴이 무엇이든 라이트다", () => {
    for (const scheme of ["system", "light", "dark"]) {
      expect(snapshot(runRuntime(doc(scheme, "catalog:snazzy-light"))).attrs["data-theme"], scheme).toBe("light");
    }
  });

  it("런타임: 조회를 주지 않으면 카탈로그 색인이 답하고, 주면 그것이 이긴다", () => {
    expect(snapshot(runRuntime(doc("system"))).attrs["data-theme"]).toBe("dark");
    expect(snapshot(runRuntime(doc("system"), () => null)).attrs).not.toHaveProperty("data-theme");
  });

  it("런타임: 짝 있는 테마와 첫 파티는 단일 모드 규칙을 타지 않는다", () => {
    const lookup: ModesLookup = (ref) => (ref === SOLO ? ["dark"] : null);
    expect(snapshot(runRuntime(doc("system", "dawnsky"), lookup)).attrs).not.toHaveProperty("data-theme");
    expect(snapshot(runRuntime(doc("system", "catalog:github"))).attrs).not.toHaveProperty("data-theme");
    expect(snapshot(runRuntime(doc("light", "dawnsky"), () => ["dark"])).attrs["data-theme"]).toBe("light");
  });

  it("부트: 캐시가 mode를 들고 있으면 같은 못 박기를 첫 페인트에 한다", () => {
    const entry = JSON.stringify({
      key: themeCacheKey("1", { theme: SOLO, signal: null }),
      vars: { "--ink": hex("d8dee9") },
      mode: "dark",
    });
    const booted = snapshot(runBoot({ ...doc("system"), [CACHE_ENTRY]: entry }));
    const runtime = snapshot(runRuntime(doc("system")));
    expect(booted.attrs).toEqual(runtime.attrs);
    expect(booted.metas).toEqual(runtime.metas);
    expect(booted.attrs["data-theme"]).toBe("dark");
  });

  it("부트: mode가 없는 캐시는 시스템을 건드리지 않는다", () => {
    const entry = JSON.stringify({
      key: themeCacheKey("1", { theme: SOLO, signal: null }),
      vars: { "--ink": hex("d8dee9") },
    });
    expect(snapshot(runBoot({ ...doc("system"), [CACHE_ENTRY]: entry })).attrs).not.toHaveProperty("data-theme");
  });

  it("허용된 어긋남: 카탈로그에 없는 catalog: 참조는 부트가 문법만 보고 런타임이 멤버십까지 본다 (색은 둘 다 기본이다)", () => {
    // 부트는 카탈로그를 모른다(씨앗 표는 지연 청크). 지워졌거나 미래 버전이 쓴 id는 부트가 `derived`로 찍지만 변수를
    // 꽂지 않으므로(캐시 키가 맞지 않는다) 색은 기본이고, 앱이 올라오면 런타임이 새벽하늘로 읽는다.
    const unknown = doc("system", "catalog:solo-dark");
    const booted = snapshot(runBoot(unknown));
    const runtime = snapshot(runRuntime(unknown));
    expect(booted.attrs["data-palette"]).toBe("derived");
    expect(runtime.attrs["data-palette"]).toBe("dawnsky");
    expect(booted.vars).toEqual({});
    expect(runtime.vars).toEqual({});
  });

  it("허용된 어긋남: 캐시 없이 다크 단독 테마를 처음 여는 한 프레임은 부트가 못 박지 못한다 (청사진 §5.2-i, design-review N-1)", () => {
    // 부트는 카탈로그를 모르므로 캐시가 없으면 기본 모습으로 서고, 앱이 올라오면 런타임이 못 박는다.
    // 파생 엔진이 캐시를 쓸 때 단일 모드 테마에는 반드시 mode를 함께 쓰므로(applyDerived) 첫 실행 한 번뿐이다.
    expect(snapshot(runBoot(doc("system"))).attrs).not.toHaveProperty("data-theme");
    expect(snapshot(runRuntime(doc("system"))).attrs["data-theme"]).toBe("dark");
  });
});

describe("부트 캐시: 있으면 첫 렌더 전에 꽂고, 없으면 아무것도 하지 않는다 (AP-1a AC 3)", () => {
  const INK = lightDark(hex("2e3440"), hex("d8dee9"));
  const GLASS = lightDark(fn("rgba", "255", "254", "252", ".74"), fn("rgba", "32", "35", "43", ".72"));
  const entry = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      key: themeCacheKey("1", { theme: "catalog:nord", signal: null }),
      vars: { "--ink": INK, "--glass": GLASS, "--line": hex("e7e4df") },
      ...over,
    });
  const nord = { [V2_ENTRY]: record({ theme: "catalog:nord" }) };

  it("키가 지금 레코드와 맞으면 모든 변수가 인라인으로 선다", () => {
    const { vars, attrs } = snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry() }));
    expect(vars).toEqual({ "--ink": INK, "--glass": GLASS, "--line": hex("e7e4df") });
    expect(attrs["data-palette"]).toBe("derived");
  });

  it("첫 파티 레코드는 키가 맞는 캐시가 있어도 꽂지 않는다: 캐시는 파생 테마의 것이다 (design-review M-1)", () => {
    // 정적 CSS가 색을 주는 첫 파티는 캐시 색이 첫 프레임에 섰다가 걷히는 번쩍임이 없어야 한다.
    for (const theme of THEME_IDS) {
      const first = { [V2_ENTRY]: record({ theme }) };
      const raw = entry({ key: themeCacheKey("1", { theme, signal: null }) });
      expect(snapshot(runBoot({ ...first, [CACHE_ENTRY]: raw })).vars, theme).toEqual({});
    }
  });

  it("첫 파티 레코드의 캐시 mode는 읽지 않는다: 부트와 런타임이 같은 data-theme를 찍는다 (design-review M-1)", () => {
    const first = { [V2_ENTRY]: record({ theme: "dawnsky", scheme: "system" }) };
    const raw = entry({ key: themeCacheKey("1", { theme: "dawnsky", signal: null }), mode: "dark" });
    const booted = snapshot(runBoot({ ...first, [CACHE_ENTRY]: raw }));
    const runtime = snapshot(runRuntime({ ...first, [CACHE_ENTRY]: raw }));
    expect(booted.attrs).toEqual(runtime.attrs);
    expect(booted.metas).toEqual(runtime.metas);
    expect(booted.attrs).not.toHaveProperty("data-theme");
  });

  it("앱이 올라오면 런타임이 첫 파티 레코드의 낡은 캐시 항목과 인라인 변수를 걷는다", () => {
    const first = { [V2_ENTRY]: record({ theme: "dawnsky" }) };
    const raw = entry({ key: themeCacheKey("1", { theme: "dawnsky", signal: null }) });
    const store = new FakeStore({ ...first, [CACHE_ENTRY]: raw });
    const doc2 = makeDoc();
    doc2.documentElement.style.setProperty("--ink", INK); // 파생 테마였을 때 엔진이 꽂은 변수
    applyAppearance(readWebAppearance({ v2: first[V2_ENTRY] }), { doc: doc2, storage: store });
    expect(doc2.documentElement.style.vars.has("--ink")).toBe(false);
    expect(store.getItem(CACHE_ENTRY)).toBeNull();
  });

  it("캐시가 없으면 아무 변수도 꽂지 않고, 기본 테마의 스탬프는 그대로 선다 (깨지지 않는다)", () => {
    const { vars, attrs } = snapshot(runBoot(nord));
    expect(vars).toEqual({});
    expect(attrs).toMatchObject({ "data-palette": "derived", "data-theme-ref": "catalog:nord" });
    const fresh = snapshot(runBoot({}));
    expect(fresh.vars).toEqual({});
    expect(fresh.attrs).toMatchObject({ "data-palette": "dawnsky", "data-theme-ref": "dawnsky" });
  });

  it("다른 테마·다른 신호의 캐시는 첫 페인트에 얹지 않는다", () => {
    for (const key of [
      themeCacheKey("1", { theme: "catalog:dracula", signal: null }),
      themeCacheKey("1", { theme: "catalog:nord", signal: { preset: "seongun" } }),
      themeCacheKey("1", { theme: "dawnsky", signal: null }),
      "1|catalog:nord-x|-",
      "catalog:nord|-",
    ]) {
      expect(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ key }) })).vars, key).toEqual({});
    }
  });

  it("엔진 판이 달라도, 뒤 칸이 더 붙어도 같은 모양이면 꽂는다", () => {
    for (const key of ["9|catalog:nord|-", "1|catalog:nord|-|o3f2a"]) {
      expect(Object.keys(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ key }) })).vars), key).toHaveLength(3);
    }
  });

  it("직접 고른 신호색은 색까지 같아야 맞는다", () => {
    const custom = { [V2_ENTRY]: record({ theme: "catalog:nord", signal: { custom: hex("9c447c") } }) };
    const ok = entry({ key: `1|catalog:nord|${hex("9C447C")}` });
    const stale = entry({ key: `1|catalog:nord|${hex("9C447D")}` });
    expect(Object.keys(snapshot(runBoot({ ...custom, [CACHE_ENTRY]: ok })).vars)).toHaveLength(3);
    expect(snapshot(runBoot({ ...custom, [CACHE_ENTRY]: stale })).vars).toEqual({});
  });

  it("계약을 하나라도 어기면 통째로 버린다 (일부만 꽂지 않는다)", () => {
    const bad = [
      { "--ink": INK, "--x": "url(https://evil.example/a.png)" },
      { "--ink": INK, "--x": "var(--ink)" },
      { "--ink": INK, "--x": `${hex("112233")}; background: red` },
      { "--ink": INK, "--x": "red" },
      { "--ink": INK, "Ink": hex("112233") },
      { "--ink": INK, "--Ink": hex("112233") },
      { "--ink": INK, "--x": 5 },
      {},
    ];
    for (const vars of bad) {
      expect(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ vars }) })).vars, JSON.stringify(vars)).toEqual({});
    }
    for (const raw of ["", "{", "[]", "null", '"x"', entry({ mode: "sepia" }), entry({ vars: [INK] }), entry({ key: "1|catalog:nord|-;" })]) {
      expect(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: raw })).vars, raw).toEqual({});
    }
  });

  it("상한: 변수 64개까지, 원문 12288자까지", () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`--v${i}`, hex("112233")]));
    expect(Object.keys(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ vars: many(64) }) })).vars)).toHaveLength(64);
    expect(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ vars: many(65) }) })).vars).toEqual({});
    expect(snapshot(runBoot({ ...nord, [CACHE_ENTRY]: entry({ pad: "x".repeat(13_000) }) })).vars).toEqual({});
  });

  it("값 문법은 core와 같다: 변이 말뭉치 위에서 부트가 받는 것 == core가 받는 것", () => {
    const seeds = [
      hex("112233"), hex("abc"), hex("11223344"), INK, GLASS, fn("rgb", "1", "2", "3"), fn("rgba", "1", "2", "3", "1"),
      fn("rgba", "1", "2", "3", "0.5"), fn("rgba", "1", "2", "3", "1.0"), lightDark("red", hex("000000")), "",
      fn("light-dark", hex("111111")), fn("light-dark", hex("111111"), hex("222222"), hex("333333")),
    ];
    let state = 4186;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const alphabet = "0123456789abcdefABCDEF#(),. -%;'\"{}:/@!urlvar\\\n";
    const pick = (n: number) => Math.floor(rand() * n);
    const mutate = (value: string): string => {
      let out = value;
      for (let k = 0, steps = 1 + pick(3); k < steps; k++) {
        const at = pick(out.length + 1);
        const ch = alphabet[pick(alphabet.length)];
        switch (pick(4)) {
          case 0:
            out = out.slice(0, at) + ch + out.slice(at);
            break;
          case 1:
            out = out.slice(0, at) + out.slice(at + 1);
            break;
          case 2:
            out = out.slice(0, at) + ch + out.slice(at + 1);
            break;
          default:
            out = out.slice(0, at);
        }
      }
      return out;
    };
    let accepted = 0;
    let rejected = 0;
    for (let n = 0; n < 1500; n++) {
      const seed = seeds[pick(seeds.length)];
      const value = n < seeds.length ? seeds[n] : mutate(seed);
      const raw = entry({ vars: { "--probe": value } });
      const core = parseThemeCache(raw);
      const coreApplies = core !== null && cacheMatchesLook(core.key, { theme: "catalog:nord", signal: null });
      const applied = snapshot(runBoot({ ...nord, [CACHE_ENTRY]: raw })).vars;
      expect(Object.keys(applied).length > 0, JSON.stringify(value)).toBe(coreApplies);
      if (coreApplies) {
        expect(applied).toEqual(core?.vars);
        accepted++;
      } else {
        rejected++;
      }
    }
    // 말뭉치가 한쪽으로만 쏠려 시험이 헛돌지 않는다.
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(500);
  });
});

describe("신호 프리셋: 두 CSS 바인딩이 같은 값이라 data-signal과 옛 data-accent를 함께 찍어도 화면이 같다 (design-review N-6)", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const ROLES = ["--signal", "--on-signal", "--signal-text", "--signal-soft"] as const;
  const declarations = (block: string) =>
    Object.fromEntries(ROLES.map((role) => [role, new RegExp(`${role}:\\s*([^;]+);`).exec(block)?.[1]?.trim()]));
  const blockOf = (css: string, selectorStart: string) => {
    const at = css.indexOf(selectorStart);
    if (at < 0) throw new Error(`${selectorStart} not found`);
    return css.slice(css.indexOf("{", at), css.indexOf("}", at));
  };

  it.each(SIGNAL_PRESET_IDS)("%s: themes/<id>.css(data-accent)와 palettes/dawnsky.css(data-signal)의 신호 네 값이 같다", (id) => {
    const accent = declarations(blockOf(read(`./themes/${id}.css`), `:root[data-palette="dawnsky"][data-accent="${id}"]`));
    const signal = declarations(blockOf(read("./themes/palettes/dawnsky.css"), `:root[data-palette="dawnsky"][data-signal="${id}"]`));
    for (const role of ROLES) expect(accent[role], `${id} ${role}`).toBeTruthy();
    expect(accent).toEqual(signal);
  });
});

describe("the pre-paint boot script keeps its text-level promises", () => {
  it("names every storage entry and attribute it uses", () => {
    for (const name of [V2_ENTRY, V1_ENTRY, LEGACY_ENTRY, CACHE_ENTRY, SYSTEM_COLOR_ATTRIBUTE]) {
      expect(BOOT).toContain(`"${name}"`);
    }
    for (const name of [...STAMPED_ATTRIBUTES, THEME_ATTRIBUTE, ACCENT_ATTRIBUTE, PALETTE_ATTRIBUTE]) {
      expect(BOOT).toContain(`"${name}"`);
    }
  });

  it("falls back to the default palette id the store defaults to", () => {
    expect(BOOT).toContain(`"${DEFAULT_APPEARANCE.theme}"`);
  });

  it("applies user fonts with the same names", () => {
    for (const name of [
      "--font-user-sans",
      "--font-user-mono",
      "data-font-sans",
      "data-font-mono",
      "var(--font-sans)",
      "var(--font-mono)",
    ]) {
      expect(BOOT, name).toContain(name);
    }
  });

  it("carries the font-name rule of core fontName.ts, character for character", () => {
    expect(BOOT).toContain(JSON.stringify(FONT_NAME_PATTERN));
    expect(BOOT).toContain("FONT_NAME_MAX = 64;");
  });

  it("is read by the two tokens.css rules and nothing else (#3774)", () => {
    expect(TOKENS).toContain(":root[data-font-sans] body {");
    expect(TOKENS).toContain("font-family: var(--font-user-sans);");
    expect(TOKENS).toContain(":root[data-font-mono] :is(.font-mono, code, pre, kbd, samp) {");
    expect(TOKENS).toContain("font-family: var(--font-user-mono);");
  });
});

describe("every surface that watches the scheme also watches the toggle", () => {
  // 이 티켓이 만든 새 사실: 스킴은 이제 **두 가지 방식**으로 바뀐다. OS 설정
  // (미디어 질의)과 설정 > 테마(루트 스탬프)다. 후자는 미디어 질의를 절대 깨우지
  // 않으므로, `prefers-color-scheme`만 듣고 색을 다시 읽던 자리는 토글에 대해
  // 귀머거리가 된다. 실제로 그런 자리가 하나 있었다: 관전 터미널은 xterm에 리터럴
  // 색을 넘겨야 해서 토큰을 DOM에서 읽는데(ObserverTerminal.tsx), 열어 둔 채로
  // 테마를 바꾸면 라이트 종이 위에 검은 판이 남았다.
  //
  // 그래서 규칙을 파일 하나가 아니라 **집합**에 건다: 미디어 질의로 스킴을 듣는
  // 모든 소스는 테마 저장소도 구독해야 한다. 다음에 같은 자리를 만드는 사람은
  // 그 사실을 리뷰가 아니라 여기서 듣는다.
  const srcRoot = fileURLToPath(new URL("..", import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  const watchers = sources(srcRoot).filter(
    (path) =>
      !path.endsWith(join("design", "theme.ts")) &&
      readFileSync(path, "utf8").includes("prefers-color-scheme")
  );

  it("has at least one such surface, so this rule is not vacuous", () => {
    expect(watchers.length).toBeGreaterThan(0);
  });

  it("subscribes each of them to the theme store as well", () => {
    const deaf = watchers.filter(
      (path) => !readFileSync(path, "utf8").includes("subscribeTheme")
    );
    expect(
      deaf.map((path) => path.slice(srcRoot.length)),
      "미디어 질의만 듣는 표면은 설정 > 테마의 전환을 놓친다"
    ).toEqual([]);
  });
});

describe("index.html loads the boot script in the only order that works", () => {
  // 주석이 아니라 **태그**를 찾는다. 이 파일의 머리말은 같은 경로를 산문으로도
  // 적고 있으므로, 문자열 위치로 순서를 재면 주석이 태그 행세를 하게 된다.
  const scriptTag = HTML.match(/<script[^>]*src=["'][^"']*theme-boot\.js["'][^>]*>/);
  const at = scriptTag ? HTML.indexOf(scriptTag[0]) : -1;

  it("loads it at all", () => {
    expect(scriptTag).not.toBeNull();
  });

  it("does not defer it", () => {
    // defer(그리고 type="module", 그것이 언제나 defer다)면 이 스크립트는 문서가
    // 이미 한 번 그려진 뒤에 돈다. 그 프레임이 곧 FOUC다.
    expect(scriptTag?.[0]).not.toMatch(/\bdefer\b|\basync\b|type=["']module["']/);
  });

  it("runs after the theme-color lines it copies from", () => {
    const lastMeta = HTML.lastIndexOf('name="theme-color"');
    expect(lastMeta).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(lastMeta);
  });

  it("runs before the app bundle", () => {
    expect(at).toBeLessThan(HTML.indexOf("/src/main.tsx"));
  });
});

describe("the preview card's scoped palette variant (#3578 S3a)", () => {
  // 설정 > 모양의 미리보기 카드는 루트가 아니라 **요소**에 팔레트를 묶는다. 루트에는
  // 팔레트가 하나만 찍히므로, 세 팔레트를 한 화면에 그리는 길은 생성 팔레트 CSS의
  // 주 규칙이 같은 선언을 `[data-palette-preview]`로도 싣는 것뿐이다. 이 단언이
  // 걸치는 두 자리: 생성 CSS가 그 선택자를 갖는가, tokens.css의 카드 층이 두 모드의
  // `color-scheme`을 요소에 주는가(없으면 `light-dark()`가 루트 스킴으로 풀려 카드가
  // 앱 색을 따라가고, 라이트/다크 대각 분할이 한 색이 된다).
  const palettes = new URL("./themes/palettes/", import.meta.url);

  it.each(THEME_IDS)("%s.css carries the scoped selector on its main rule", (id) => {
    const css = readFileSync(new URL(`${id}.css`, palettes), "utf8");
    expect(css).toContain(`:root[data-palette="${id}"], [data-palette-preview="${id}"] {`);
    // 신호 프리셋 블록은 범위 변형이 없다(알약은 `data-accent-swatch`가 자기 요소에서 묶는다).
    expect(css).not.toMatch(/\[data-palette-preview="[a-z]+"\]\[data-signal/);
  });

  it("binds color-scheme per preview layer, light and dark", () => {
    const layer = TOKENS.split("@utility theme-preview-layer {")[1]?.split("\n}\n")[0] ?? "";
    expect(layer).toMatch(/\[data-preview-mode="light"\]\s*\{\s*color-scheme:\s*light;/);
    expect(layer).toMatch(/\[data-preview-mode="dark"\]\s*\{\s*color-scheme:\s*dark;/);
  });
});
