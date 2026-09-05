import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  WELCOME_KICKOFF_EXIT_CLASS,
  WELCOME_KICKOFF_MARK_CLASS,
} from "@/design/motion";

const require_ = createRequire(import.meta.url);
const STAGE_TSX = readFileSync(
  new URL("./WelcomeKickoffStage.tsx", import.meta.url),
  "utf8"
);
const MOTION_CSS = readFileSync(
  new URL("../../design/motion.css", import.meta.url),
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

describe("welcome kickoff compiled motion", () => {
  it("rise uses instant stagger, arrival duration, arrival ease; no ms literals in the utility", async () => {
    expect(MOTION_CSS).toMatch(
      /animation-delay:\s*calc\(\s*var\(--stagger-index,\s*0\)\s*\*\s*var\(--motion-instant\)\s*\)/
    );
    const css = await compileClasses([WELCOME_KICKOFF_MARK_CLASS]);
    const snippet = classSnippet(css, WELCOME_KICKOFF_MARK_CLASS);
    expect(snippet).toMatch(/var\(--motion-instant\)/);
    expect(snippet).toMatch(/var\(--motion-arrival\)/);
    expect(snippet).toMatch(/var\(--motion-ease-arrival\)/);
    expect(snippet).not.toMatch(/\d+ms/);
  });

  it("exit uses --motion-standard and both fill", async () => {
    const css = await compileClasses([WELCOME_KICKOFF_EXIT_CLASS]);
    const snippet = classSnippet(css, WELCOME_KICKOFF_EXIT_CLASS);
    expect(snippet).toMatch(/var\(--motion-standard\)/);
    expect(snippet).toMatch(/\bboth\b/);
    expect(snippet).not.toMatch(/backwards/);
    expect(snippet).not.toMatch(/\d+ms/);
  });

  it("stage source has no duration-N class and no ms literals", () => {
    const code = codeOnly(STAGE_TSX);
    expect(code).not.toMatch(/duration-\d+/);
    expect(code).not.toMatch(/\d+ms/);
  });
});
