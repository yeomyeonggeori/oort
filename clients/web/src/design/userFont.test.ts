import { describe, expect, it } from "vitest";
import {
  applyUserFonts,
  canQueryLocalFonts,
  FONT_NAME_MAX,
  FONT_NAME_PATTERN,
  fontStack,
  loadInstalledFontFamilies,
  normalizeFontName,
  parseFontName,
} from "./userFont";

class FakeRoot {
  attrs = new Map<string, string>();
  vars = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => void this.vars.set(name, value),
    removeProperty: (name: string) => this.vars.delete(name),
  };
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
}

describe("parseFontName", () => {
  it("accepts real family names, Korean included, and folds whitespace", () => {
    for (const name of ["Pretendard", "SF Mono", "D2Coding", "IBM Plex Sans KR", "나눔고딕", "Noto Sans CJK KR", "Fira Code-Retina"]) {
      expect(parseFontName(name)).toEqual({ ok: true, name });
    }
    expect(parseFontName("SF\u2028Mono")).toEqual({ ok: true, name: "SF Mono" });
    expect(parseFontName("  SF   Mono \n")).toEqual({ ok: true, name: "SF Mono" });
  });

  it("treats empty and non-string input as the default (no font)", () => {
    expect(parseFontName("")).toEqual({ ok: true, name: undefined });
    expect(parseFontName("   ")).toEqual({ ok: true, name: undefined });
    expect(parseFontName(undefined)).toEqual({ ok: true, name: undefined });
    expect(parseFontName(42)).toEqual({ ok: true, name: undefined });
  });

  it("rejects every character that could leave the quoted family name", () => {
    for (const bad of [
      "A;B", "A{B", "A}B", "A(B", "A)B", "A'B", 'A"B', "A\\B", "A/B", "A<B", "A>B", "A,B", "A:B",
      "x\"; } body { display:none", "url(https://evil.example/x)", "a\u0000b",
    ]) {
      expect(parseFontName(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "chars" });
    }
  });

  it("enforces the length ceiling after whitespace folding", () => {
    expect(parseFontName("a".repeat(FONT_NAME_MAX))).toEqual({ ok: true, name: "a".repeat(FONT_NAME_MAX) });
    expect(parseFontName("a".repeat(FONT_NAME_MAX + 1))).toEqual({ ok: false, reason: "long" });
  });

  it("normalizeFontName maps rejects to undefined", () => {
    expect(normalizeFontName('x"; y')).toBeUndefined();
    expect(normalizeFontName("Pretendard")).toBe("Pretendard");
  });
});

describe("applyUserFonts", () => {
  it("sets the CSS variable with a system fallback and the gating attribute", () => {
    const root = new FakeRoot();
    applyUserFonts({ fontSans: "Pretendard", fontMono: "D2Coding" }, { documentElement: root });
    expect(root.vars.get("--font-user-sans")).toBe('"Pretendard", var(--font-sans)');
    expect(root.vars.get("--font-user-mono")).toBe('"D2Coding", var(--font-mono)');
    expect(root.attrs.has("data-font-sans")).toBe(true);
    expect(root.attrs.has("data-font-mono")).toBe(true);
  });

  it("always ends the stack with the system variable", () => {
    expect(fontStack("X", "--font-sans")).toMatch(/, var\(--font-sans\)$/);
    expect(fontStack("X", "--font-mono")).toMatch(/, var\(--font-mono\)$/);
  });

  it("clears the variable and attribute when the value is absent or broken", () => {
    const root = new FakeRoot();
    applyUserFonts({ fontSans: "Pretendard", fontMono: "D2Coding" }, { documentElement: root });
    applyUserFonts({ fontSans: undefined, fontMono: 'bad"; x' }, { documentElement: root });
    expect(root.vars.size).toBe(0);
    expect(root.attrs.size).toBe(0);
  });
});

describe("queryLocalFonts branches (fake host)", () => {
  it("reports unsupported when the API is missing", async () => {
    expect(canQueryLocalFonts({})).toBe(false);
    expect(await loadInstalledFontFamilies({})).toEqual({ status: "unsupported" });
  });

  it("dedupes, drops unsafe names, and sorts the families", async () => {
    const host = {
      queryLocalFonts: async () => [
        { family: "Menlo" }, { family: "Menlo" }, { family: "D2Coding" }, { family: 'Bad";' }, { family: 3 },
      ],
    };
    expect(canQueryLocalFonts(host)).toBe(true);
    expect(await loadInstalledFontFamilies(host)).toEqual({ status: "ok", families: ["D2Coding", "Menlo"] });
  });

  it("maps permission errors to denied and anything else to error", async () => {
    const reject = (name: string) => ({
      queryLocalFonts: async () => {
        const error = new Error("x");
        error.name = name;
        throw error;
      },
    });
    expect(await loadInstalledFontFamilies(reject("NotAllowedError"))).toEqual({ status: "denied" });
    expect(await loadInstalledFontFamilies(reject("SecurityError"))).toEqual({ status: "denied" });
    expect(await loadInstalledFontFamilies(reject("TypeError"))).toEqual({ status: "error" });
  });
});

describe("the boot script's name rule is this module's rule", () => {
  it("carries the same allow pattern and ceiling", async () => {
    const { readFileSync } = await import("node:fs");
    const boot = readFileSync(new URL("../../public/theme-boot.js", import.meta.url), "utf8");
    expect(boot).toContain(JSON.stringify(FONT_NAME_PATTERN));
    expect(boot).toContain(`FONT_NAME_MAX = ${FONT_NAME_MAX};`);
  });
});
