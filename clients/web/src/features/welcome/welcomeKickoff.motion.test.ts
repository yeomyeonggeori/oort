import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
} from "@/design/motion";

const require_ = createRequire(import.meta.url);
const STAGE_TSX = readFileSync(
  new URL("./WelcomeKickoffStage.tsx", import.meta.url),
  "utf8"
);
const TOKENS_CSS = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function compileClasses(candidates: string[]): Promise<string> {
  const tokensPath = new URL("../../design/tokens.css", import.meta.url);
  const compiler = await compile(readFileSync(tokensPath, "utf8"), {
    base: dirname(fileURLToPath(tokensPath)),
    loadStylesheet,
  });
  return compiler.build(candidates);
}

function classSnippet(css: string, className: string): string {
  const selector = "." + className.replace(/[:[\]=.!]/g, (ch) => `\\${ch}`);
  const from = css.indexOf(selector);
  expect(from, `${className} 이 규칙을 내지 않는다`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(from, i + 1);
    }
  }
  return css.slice(from, from + 240);
}

describe("welcome kickoff band compiled motion (#2817)", () => {
  it("collapse is ADR-0193 D11 line-slide: 650ms, cubic-bezier(0.22,1,0.36,1), fill both", async () => {
    const css = await compileClasses([WELCOME_KICKOFF_EXIT_CLASS]);
    const snippet = classSnippet(css, WELCOME_KICKOFF_EXIT_CLASS);
    expect(snippet).toContain(WELCOME_KICKOFF_EXIT_ANIMATION_NAME);
    expect(snippet).toMatch(/650ms/);
    expect(snippet).toMatch(/cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
    expect(snippet).toMatch(/\bboth\b/);
    expect(snippet).not.toMatch(/backwards/);
  });

  it("collapse keyframe closes the row (grid 0fr), its gap, and its opacity", () => {
    const frames = TOKENS_CSS.match(
      new RegExp(`@keyframes\\s+${WELCOME_KICKOFF_EXIT_ANIMATION_NAME}\\s*\\{([\\s\\S]*?)\\n\\}`)
    )?.[1];
    expect(frames, "collapse keyframe missing").toBeTruthy();
    expect(frames).toMatch(/grid-template-rows:\s*0fr/);
    expect(frames).toMatch(/opacity:\s*0/);
    expect(frames).toMatch(/margin-block-end:\s*0/);
  });

  it("band row is a one-track grid and its clip lets the track reach 0", async () => {
    const css = await compileClasses(["welcome-band", "welcome-band-clip"]);
    expect(classSnippet(css, "welcome-band")).toMatch(/grid-template-rows:\s*1fr/);
    const clip = classSnippet(css, "welcome-band-clip");
    expect(clip).toMatch(/min-block-size:\s*0/);
    expect(clip).toMatch(/overflow:\s*hidden/);
  });

  it("band source has no duration-N class and no ms literals", () => {
    const code = codeOnly(STAGE_TSX);
    expect(code).not.toMatch(/duration-\d+/);
    expect(code).not.toMatch(/\d+ms/);
  });

  it("the constellation is gone: no welcome-kickoff-body / -mark rule survives", async () => {
    const css = await compileClasses(["welcome-kickoff-body", "welcome-kickoff-mark"]);
    expect(css).not.toMatch(/\.welcome-kickoff-(body|mark)\b/);
    expect(TOKENS_CSS).not.toMatch(/\.welcome-kickoff-(body|mark)\b/);
  });

  it("every data-onboarding-body selector begins with a class", async () => {
    const css = await compileClasses(["onboarding-cloud-body"]);
    const mentioned: string[] = [];
    for (const chunk of css.split("}")) {
      const open = chunk.lastIndexOf("{");
      if (open < 0) continue;
      const raw = chunk.slice(0, open);
      if (!raw.includes("data-onboarding-body")) continue;
      for (const piece of raw.split(",")) {
        const lines = piece
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const sel = lines[lines.length - 1] ?? "";
        if (!sel.includes("data-onboarding-body")) continue;
        mentioned.push(sel);
      }
    }
    expect(mentioned.length).toBeGreaterThan(0);
    for (const sel of mentioned) {
      expect(sel, `unscoped ${sel}`).toMatch(/^\.onboarding-cloud-body\[/);
    }
  });
});
