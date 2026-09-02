import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCENT_ATTRIBUTE,
  APPEARANCE_STORAGE_KEY,
  applyAccent,
  applyTheme,
  migrateAppearance,
  normalizeAccentId,
  normalizeThemeChoice,
  parseAppearance,
  serializeAppearance,
  SYSTEM_COLOR_ATTRIBUTE,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from "./theme";

/**
 * 테마 전환의 계약을 세 곳에서 잰다 (U2).
 *
 *   1. 스탬프 규칙 자체 (applyTheme + 가짜 문서)
 *   2. tokens.css가 그 스탬프를 **이미 아는가** — 이 티켓이 문법을 새로 만든 것이
 *      아니라 있던 문법에 스위치를 붙였다는 주장이 여기서 사실이 된다.
 *   3. 첫 페인트를 맡은 public/theme-boot.js와 index.html의 순서. FOUC는 코드가
 *      아니라 **순서**의 결함이라, 그 순서를 문장이 아니라 단언으로 붙잡는다.
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

describe("appearance storage", () => {
  it("serializes scheme and accent together", () => {
    expect(
      parseAppearance(serializeAppearance({ scheme: "dark", accent: "seongun" }))
    ).toEqual({ scheme: "dark", accent: "seongun" });
  });

  it("treats unknown accents as Dawn", () => {
    expect(normalizeAccentId("indigo")).toBe("dawn");
    expect(normalizeAccentId(null)).toBe("dawn");
  });

  it("migrates the legacy scheme key into appearance.v1", () => {
    expect(migrateAppearance(null, "dark")).toEqual({
      scheme: "dark",
      accent: "dawn",
    });
    expect(migrateAppearance(null, "system")).toEqual({
      scheme: "system",
      accent: "dawn",
    });
    expect(
      migrateAppearance(
        serializeAppearance({ scheme: "light", accent: "gamram" }),
        "dark"
      )
    ).toEqual({ scheme: "light", accent: "gamram" });
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

describe("the pre-paint boot script mirrors this module", () => {
  it("reads the same storage key", () => {
    expect(BOOT).toContain(`"${APPEARANCE_STORAGE_KEY}"`);
    expect(BOOT).toContain(`"${THEME_STORAGE_KEY}"`);
  });

  it("writes the same attribute names", () => {
    expect(BOOT).toContain(`"${THEME_ATTRIBUTE}"`);
    expect(BOOT).toContain(`"${SYSTEM_COLOR_ATTRIBUTE}"`);
    expect(BOOT).toContain(`"${ACCENT_ATTRIBUTE}"`);
  });

  it("treats only light and dark as scheme pins", () => {
    // "system"과 미지의 값이 같은 답(스킴 스탬프 없음)을 받는다는 것이 이
    // 파일의 전부다. 그 판정이 여기서 갈라지면 부팅과 런타임이 서로 다른
    // 화면을 그린다.
    expect(BOOT).toMatch(/scheme\s*!==\s*"light"\s*&&\s*scheme\s*!==\s*"dark"/);
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
