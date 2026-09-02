// @vitest-environment jsdom
/**
 * DS-2 `#/design` gallery guards (#1956).
 *
 * red proof:
 *   - `src/design/ui/` 에 PascalCase export 를 하나 더하면 아래 렌더 단정이 붉다
 *   - `data-preview=hover` 선언이 `:hover` 선언과 다르면 붉다
 *   - production `vite build` 산출물에 "design-gallery" 가 있으면 붉다
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Gallery, GALLERY_TEXT_FIXTURE } from "./Gallery";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..", "..");
const UI_DIR = join(HERE, "ui");
const APP_SRC = readFileSync(join(HERE, "..", "app", "App.tsx"), "utf8");
const GALLERY_SRC = readFileSync(join(HERE, "Gallery.tsx"), "utf8");
const TOKENS_CSS = readFileSync(join(HERE, "tokens.css"), "utf8");
const require_ = createRequire(import.meta.url);

function pascalComponentExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export (?:function|const) ([A-Z][A-Za-z0-9]*)/gm
  )) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function uiComponentExports(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of readdirSync(UI_DIR).filter((name) => name.endsWith(".tsx")).sort()) {
    const names = pascalComponentExports(readFileSync(join(UI_DIR, file), "utf8"));
    for (const name of names) out.push({ file, name });
  }
  return out;
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[]): Promise<string> {
  const compiler = await compile(TOKENS_CSS, { base: HERE, loadStylesheet });
  return compiler.build(candidates);
}

function nestSelector(parent: string, child: string): string {
  const trimmed = child.trim();
  if (!parent) return trimmed;
  if (trimmed.includes("&")) return trimmed.replace(/&/g, parent);
  return `${parent} ${trimmed}`;
}

function parseRules(css: string): { selector: string; decls: string }[] {
  const rules: { selector: string; decls: string }[] = [];
  function walk(chunk: string, parentSelector: string) {
    let index = 0;
    while (index < chunk.length) {
      const brace = chunk.indexOf("{", index);
      if (brace < 0) break;
      const selector = chunk.slice(index, brace).trim();
      let depth = 1;
      let cursor = brace + 1;
      while (cursor < chunk.length && depth > 0) {
        if (chunk[cursor] === "{") depth += 1;
        else if (chunk[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = chunk.slice(brace + 1, cursor - 1);
      const combined = nestSelector(parentSelector, selector);
      if (body.includes("{")) walk(body, combined);
      else if (selector && !selector.startsWith("@") && body.trim()) {
        rules.push({ selector: combined, decls: body.trim() });
      }
      index = cursor;
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), "");
  return rules;
}

function normalizeDecls(body: string): string {
  return body
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join(";");
}

function declarationLists(
  rules: { selector: string; decls: string }[],
  selectorPart: RegExp
): string[] {
  return rules
    .filter((rule) => selectorPart.test(rule.selector))
    .map((rule) => normalizeDecls(rule.decls))
    .sort();
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function renderGallery(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoot = root;
  mountedHost = host;
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(Gallery)));
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

describe("갤러리 픽스처", () => {
  it("텍스트 픽스처는 한국어·영문·숫자·이모지 혼합 80자 경계다", () => {
    expect([...GALLERY_TEXT_FIXTURE].length).toBe(80);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/[가-힣]/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/[A-Za-z]/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/\d/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/🔥/);
  });
});

describe("src/design/ui export 전수", () => {
  it("갤러리가 ui/ PascalCase export 전부를 렌더한다", () => {
    const exports = uiComponentExports();
    expect(exports.length).toBeGreaterThan(0);
    const host = renderGallery();
    const missing = exports
      .map((entry) => entry.name)
      .filter((name) => host.querySelector(`[data-gallery-export="${name}"]`) === null);
    expect(missing, `갤러리 누락: ${missing.join(", ")}`).toEqual([]);
  });

  it("Gallery.tsx 소스가 같은 export 이름을 든다", () => {
    const exports = uiComponentExports();
    const missing = exports
      .map((entry) => entry.name)
      .filter((name) => !GALLERY_SRC.includes(name));
    expect(missing, `Gallery.tsx 소스 누락: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("data-preview 선언 공유", () => {
  it("hover/active/focus-visible 과 data-preview 가 같은 선언 목록을 공유한다", async () => {
    const css = await buildCss([
      "hover:bg-surface-hover",
      "active:opacity-90",
      "focus-visible:focus-ring",
      "press",
    ]);
    const rules = parseRules(css);

    const pairs: { live: RegExp; preview: RegExp; label: string }[] = [
      { live: /:hover\b/, preview: /\[data-preview=["']hover["']\]/, label: "hover" },
      { live: /:active\b/, preview: /\[data-preview=["']active["']\]/, label: "active" },
      {
        live: /:focus-visible\b/,
        preview: /\[data-preview=["']focus["']\]/,
        label: "focus-visible",
      },
    ];

    for (const pair of pairs) {
      const liveDecls = declarationLists(rules, pair.live);
      const previewDecls = declarationLists(rules, pair.preview);
      expect(liveDecls.length, `${pair.label} live 규칙`).toBeGreaterThan(0);
      expect(
        previewDecls,
        `${pair.label}: data-preview 선언이 :${pair.label} 선언과 같아야 한다`
      ).toEqual(liveDecls);
      const shared = rules.filter(
        (rule) => pair.live.test(rule.selector) && pair.preview.test(rule.selector)
      );
      expect(
        shared.length,
        `${pair.label} 는 :is()/@utility 로 한 몸을 써야 한다 (규칙 이중화 금지)`
      ).toBeGreaterThan(0);
    }
  });
});

describe("프로덕션 번들", () => {
  it("App.tsx 는 design 모드 또는 VITE_DESIGN_GALLERY 뒤에서만 lazy 한다", () => {
    expect(APP_SRC).toMatch(/import\.meta\.env\.MODE === ["']design["']/);
    expect(APP_SRC).toMatch(/VITE_DESIGN_GALLERY/);
    expect(APP_SRC).toMatch(/lazy\s*\(/);
    expect(APP_SRC).not.toMatch(/design-gallery/);
  });

  it(
    "production vite build dist 에 design-gallery 문자열이 0건이다",
    () => {
      const viteBin = resolve(WEB_ROOT, "node_modules/.bin/vite");
      expect(existsSync(viteBin), "clients/web/node_modules/.bin/vite").toBe(true);
      const outDir = mkdtempSync(join(tmpdir(), "momo-gallery-prod-"));
      try {
        execFileSync(viteBin, ["build", "--outDir", outDir, "--emptyOutDir"], {
          cwd: WEB_ROOT,
          env: { ...process.env, VITE_DESIGN_GALLERY: "" },
          stdio: "pipe",
          timeout: 180_000,
        });
        const hits: string[] = [];
        for (const file of walkFiles(outDir)) {
          const bytes = readFileSync(file);
          if (bytes.includes("design-gallery")) hits.push(file.slice(outDir.length + 1));
        }
        expect(hits, `production dist 에 design-gallery: ${hits.join(", ")}`).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    240_000
  );
});
