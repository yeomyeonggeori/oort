// @vitest-environment jsdom
/**
 * DS-2 `#/design` gallery guards (#1956).
 *
 * red proof:
 *   - `src/design/ui/` 에 PascalCase export 를 하나 더하면 렌더 기하 단정이 붉다
 *   - 그 export 를 `.sr-only` 에 숨겨도 붉다 (속성 존재만으로는 통과하지 않는다)
 *   - tokens.css 에서 `@media (hover: hover)` 가드를 빼면 붉다
 *   - production CSS 에 `data-preview` 가 있으면 붉다
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
import ts from "typescript";
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
const PREVIEW_PATH = join(HERE, "gallery-preview.css");
const CAPTURE_SRC = readFileSync(
  join(HERE, "..", "..", "scripts", "capture-screens.mjs"),
  "utf8"
);
const require_ = createRequire(import.meta.url);

const ZERO_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON() {
    return this;
  },
};

function pascalComponentExports(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const names = new Set<string>();

  function isPascal(name: string): boolean {
    return /^[A-Z][A-Za-z0-9]*$/.test(name);
  }

  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      return;
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword) &&
      node.name &&
      isPascal(node.name.text)
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isPascal(decl.name.text)) {
          names.add(decl.name.text);
        }
      }
    }
    if (
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      ts.isIdentifier(node.expression) &&
      isPascal(node.expression.text)
    ) {
      names.add(node.expression.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      !node.isTypeOnly
    ) {
      for (const spec of node.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        const exported = spec.name.text;
        if (isPascal(exported)) names.add(exported);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return [...names].sort();
}

function uiComponentExports(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of readdirSync(UI_DIR).filter((name) => name.endsWith(".tsx")).sort()) {
    const names = pascalComponentExports(
      readFileSync(join(UI_DIR, file), "utf8"),
      file
    );
    for (const name of names) out.push({ file, name });
  }
  return out;
}

function sourceMentions(src: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(src);
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(candidates: string[], source = TOKENS_CSS): Promise<string> {
  const compiler = await compile(source, { base: HERE, loadStylesheet });
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

function captureDesignGallerySource(): string {
  const start = CAPTURE_SRC.indexOf("async function captureDesignGallery");
  const end = CAPTURE_SRC.indexOf("\nasync function main(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return CAPTURE_SRC.slice(start, end);
}

function visibleExportBox(root: ParentNode, name: string): DOMRect | null {
  const nodes = [...root.querySelectorAll(`[data-gallery-export="${name}"]`)];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(".sr-only")) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width * rect.height > 0) return rect;
  }
  return null;
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
  act(() => undefined);
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
    dispatchEvent: () => false,
  }));
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!this.isConnected) return ZERO_RECT;
    if (this.closest(".sr-only")) return ZERO_RECT;
    if (this.hidden) return ZERO_RECT;
    if (this.getAttribute("data-state") === "closed") return ZERO_RECT;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 80,
      bottom: 24,
      width: 80,
      height: 24,
      toJSON() {
        return this;
      },
    };
  };
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
  it("텍스트 픽스처는 한국어·영문·숫자·이모지 혼합이고 80자 상한을 넘지 않는다", () => {
    const length = [...GALLERY_TEXT_FIXTURE].length;
    expect(length).toBeGreaterThan(40);
    expect(length).toBeLessThanOrEqual(80);
    expect(length).not.toBe(80);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/[가-힣]/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/[A-Za-z]/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/\d/);
    expect(GALLERY_TEXT_FIXTURE).toMatch(/🔥/);
    expect(GALLERY_TEXT_FIXTURE).not.toMatch(/ship-notes ok/);
  });
});

describe("src/design/ui export 전수", () => {
  it("sr-only 안에 숨기면 면적 0 으로 붉다", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<span class="sr-only"><button data-gallery-export="ProbeSabotage">숨김</button></span>';
    document.body.append(host);
    try {
      expect(visibleExportBox(host, "ProbeSabotage")).toBeNull();
    } finally {
      host.remove();
    }
  });

  it("갤러리가 ui/ PascalCase export 전부를 면적 있는 상자로 렌더한다", () => {
    const exports = uiComponentExports();
    expect(exports.length).toBeGreaterThan(0);
    const host = renderGallery();
    const root = host.ownerDocument ?? document;
    const missing = exports
      .map((entry) => entry.name)
      .filter((name) => visibleExportBox(root, name) === null);
    expect(missing, `갤러리 누락 또는 비가시: ${missing.join(", ")}`).toEqual([]);
  });

  it("Gallery.tsx 소스가 같은 export 이름을 단어 경계로 든다", () => {
    expect(sourceMentions("CardHeader", "Card")).toBe(false);
    expect(sourceMentions("CardHeader", "CardHeader")).toBe(true);
    const exports = uiComponentExports();
    const missing = exports
      .map((entry) => entry.name)
      .filter((name) => !sourceMentions(GALLERY_SRC, name));
    expect(missing, `Gallery.tsx 소스 누락: ${missing.join(", ")}`).toEqual([]);
  });

  it("떠 있는 표면은 실제 프리미티브이고 FloatPanel 흉내가 없다", () => {
    expect(GALLERY_SRC).not.toMatch(/\bFloatPanel\b/);
    expect(GALLERY_SRC).toMatch(/container=\{/);
    expect(GALLERY_SRC).toMatch(/overlayClassName=/);
    expect(GALLERY_SRC).not.toMatch(/캡처가 실제 열림을 만들고/);
    expect(GALLERY_SRC).not.toMatch(/정적 판/);
    expect(GALLERY_SRC).not.toMatch(/`shadow-lg`/);
  });
});

describe("production hover 변이", () => {
  it("@media (hover: hover) 가 hover 변이를 지키고 data-preview 는 없다", async () => {
    const css = await buildCss(["hover:bg-surface-hover", "touch-only"]);
    expect(css, "production tokens 에 data-preview 금지").not.toMatch(/data-preview/);
    expect(TOKENS_CSS).not.toMatch(/@custom-variant\s+hover\b/);
    const media = /@media\s*\(\s*hover\s*:\s*hover\s*\)/;
    expect(css, "hover 미디어 가드").toMatch(media);
    const mediaIdx = css.search(media);
    const utilIdx = css.indexOf(".hover\\:bg-surface-hover:hover");
    expect(utilIdx, "hover:bg-surface-hover:hover 규칙").toBeGreaterThan(-1);
    expect(utilIdx, "hover 변이가 미디어 가드 안에 있어야 한다").toBeGreaterThan(mediaIdx);
    expect(css).not.toMatch(/hover\\:bg-surface-hover:is\(/);
  });
});

describe("data-preview 선언 공유", () => {
  it("gallery-preview.css 의 :is() 가 실제 :hover/:active/:focus-visible 선언과 같다", async () => {
    expect(existsSync(PREVIEW_PATH), "gallery-preview.css").toBe(true);
    const previewSrc = readFileSync(PREVIEW_PATH, "utf8");
    expect(previewSrc).toMatch(/\[data-gallery-root\]/);
    expect(GALLERY_SRC).toMatch(/gallery-preview\.css/);
    expect(TOKENS_CSS).not.toMatch(/gallery-preview\.css/);

    const liveCss = await buildCss([
      "hover:bg-surface-hover",
      "active:opacity-90",
      "focus-visible:focus-ring",
      "press",
    ]);
    const previewCss = await buildCss([], previewSrc);
    const liveRules = parseRules(liveCss);
    const previewRules = parseRules(previewCss);

    const pairs: { live: RegExp; preview: RegExp; label: string }[] = [
      {
        live: /hover\\:bg-surface-hover:hover\b/,
        preview: /\[data-preview=["']hover["']\]/,
        label: "hover",
      },
      {
        live: /active\\:opacity-90:active\b/,
        preview: /\[data-preview=["']active["']\]/,
        label: "active",
      },
      {
        live: /focus-visible\\:focus-ring:focus-visible\b/,
        preview: /\[data-preview=["']focus["']\]/,
        label: "focus-visible",
      },
    ];

    for (const pair of pairs) {
      const liveDecls = declarationLists(liveRules, pair.live);
      const previewDecls = declarationLists(previewRules, pair.preview);
      expect(liveDecls.length, `${pair.label} live 규칙`).toBeGreaterThan(0);
      expect(previewDecls.length, `${pair.label} preview 규칙`).toBeGreaterThan(0);
      expect(
        previewDecls,
        `${pair.label}: gallery-preview 선언이 실제 :${pair.label} 선언과 같아야 한다`
      ).toEqual(expect.arrayContaining(liveDecls));
      const shared = previewRules.filter(
        (rule) =>
          pair.preview.test(rule.selector) &&
          /:is\(/.test(rule.selector) &&
          /data-gallery-root/.test(rule.selector)
      );
      expect(
        shared.length,
        `${pair.label} 는 갤러리 스코프 :is() 한 몸이어야 한다`
      ).toBeGreaterThan(0);
    }

    const hoverPreview = previewRules.filter((rule) =>
      /\[data-preview=["']hover["']\]/.test(rule.selector)
    );
    expect(
      hoverPreview.every((rule) => /@media\s*\(\s*hover\s*:\s*hover\s*\)/.test(rule.selector)),
      "gallery hover 미리보기도 @media (hover: hover) 안에"
    ).toBe(true);
  });
});

describe("캡처 장면", () => {
  it("DOM 을 고치지 않고 단정을 붙이며 data-theme 을 덧찍지 않는다", () => {
    const scene = captureDesignGallerySource();
    expect(scene).not.toMatch(/replaceChildren/);
    expect(scene).not.toMatch(/data-theme/);
    expect(scene).toMatch(/assertNoHorizontalOverflow/);
    expect(scene).toMatch(/setViewportSize/);
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
    "production vite build dist 에 design-gallery 와 CSS data-preview 가 0건이다",
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
        const galleryHits: string[] = [];
        const previewHits: string[] = [];
        for (const file of walkFiles(outDir)) {
          const bytes = readFileSync(file);
          const rel = file.slice(outDir.length + 1);
          if (bytes.includes("design-gallery")) galleryHits.push(rel);
          if (file.endsWith(".css") && bytes.includes("data-preview")) previewHits.push(rel);
        }
        expect(
          galleryHits,
          `production dist 에 design-gallery: ${galleryHits.join(", ")}`
        ).toEqual([]);
        expect(
          previewHits,
          `production CSS 에 data-preview: ${previewHits.join(", ")}`
        ).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    240_000
  );
});
