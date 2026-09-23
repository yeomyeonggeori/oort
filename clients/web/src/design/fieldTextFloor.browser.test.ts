import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * 입력 칸의 글자는 손가락 화면에서 16px 밑으로 내려가지 않는다 (#2616).
 *
 * iOS 사파리는 포커스를 받은 입력 칸의 글자가 16px보다 작으면 **페이지를 확대**하고,
 * 확대된 채로 남아 가로로 끌리는 화면을 만든다. 성재가 폰으로 owner claim을 하다가
 * 만난 「타이핑하면 줌되고 화면 깨짐」이 그것이다. 막는 길은 `maximum-scale`(확대 자체를
 * 끄는 것, 접근성을 끈다)이 아니라 글자를 16px 이상으로 두는 것뿐이다.
 *
 * 그 규칙은 이미 `tokens.css`에 있었다. 다만 `@layer base` 안에 있었고, 입력 칸이 다는
 * 역할 클래스(`text-body` 등)는 `@layer utilities`에 있어서 **뒤 레이어가 특정도와
 * 무관하게 이겼다**. 폰에서 로그인 칸·컴포저가 모두 14px였다(WebKit iPhone 프로필 실측).
 * 이 시험은 그 규칙을 문자열이 아니라 **엔진이 계산한 글자 크기**로 잰다.
 *
 * 무엇을 재나:
 *   - 역할 매트릭스: tokens.css가 정의한 텍스트 역할 전부 × input/textarea/select. 역할
 *     목록은 tokens.css에서 읽으므로, 16px보다 작은 역할이 새로 생기면 여기서 빨개진다.
 *   - 실제 컴포넌트의 클래스: Input·Select 프리미티브, 채널·스레드 컴포저, 메시지 편집기.
 *     소스에서 그대로 읽는다(손으로 옮긴 사본은 원본이 바뀌어도 초록으로 남는다).
 *   - 클래스 없는 칸: 부모의 `text-body`를 상속하는 자리도 바닥을 받아야 한다.
 *   - 칸 안의 표식(`data-field-adornment`, 핸들 칸의 `@`): 칸 글자와 같은 크기여야 한다.
 *
 * 어디서 재나(두 축을 따로):
 *   - 좁은 창 375px, 마우스: `width < 600px` 갈래
 *   - 넓은 창 1024px, 손가락(`hasTouch`): `hover: none` 갈래(아이패드)
 *   - 넓은 창 1280px, 마우스: 대조군. 데스크탑 밀도(14px)는 그대로여야 한다. 이 칸이
 *     없으면 「어디서나 16px」도 초록이 된다.
 *
 * 엔진: WebKit(사파리의 엔진)과 Chromium 중 설치된 것 전부. 둘 다 없으면 경고를 남기고
 * 건너뛴다(다른 브라우저 시험과 같은 규약, CI 레인은 #2129).
 */

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const TOKENS = join(HERE, "tokens.css");

const FLOOR_PX = 16;

type EngineName = "webkit" | "chromium";

function engineMissing(name: EngineName): string | null {
  try {
    const playwright = require_("playwright") as typeof import("playwright");
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) {
    console.warn(`field text floor: Playwright ${name} missing (${missing})`);
  }
  return missing === null;
});

/** tokens.css `@theme`의 텍스트 역할과 그 rem 값. `--text-*: initial`과 줄 높이는 뺀다. */
function textRoles(): { role: string; px: number }[] {
  const css = readFileSync(TOKENS, "utf8");
  const roles = [...css.matchAll(/^\s*--text-([a-z]+):\s*([\d.]+)rem;/gm)].map(
    (m) => ({ role: m[1]!, px: Number(m[2]) * 16 })
  );
  if (roles.length < 5) {
    throw new Error(`tokens.css text roles not found (${roles.length})`);
  }
  return roles;
}

/** `cn(` 다음의 첫 문자열 리터럴. 사이에 낀 `//` 주석은 건너뛴다. */
function primitiveClasses(file: string): string {
  const source = readFileSync(join(SRC, file), "utf8");
  const match = source.match(/cn\(\s*(?:\/\/[^\n]*\n\s*)*"([^"]+)"/);
  if (!match) throw new Error(`${file}: no cn("...") base class list`);
  return match[1]!;
}

/** `data-field-adornment`를 단 요소의 `className="..."`(그 속성 앞에 선다). */
function adornmentClasses(file: string): string {
  const source = readFileSync(join(SRC, file), "utf8");
  const at = source.indexOf("data-field-adornment=");
  if (at < 0) throw new Error(`${file}: no data-field-adornment`);
  const open = source.lastIndexOf("<span", at);
  const match = source.slice(open, at).match(/className="([^"]+)"/);
  if (!match) throw new Error(`${file}: adornment without a literal className`);
  return match[1]!;
}

/** 파일 안 첫 `<textarea`의 첫 `className="..."`. */
function textareaClasses(file: string): string {
  const source = readFileSync(join(SRC, file), "utf8");
  const start = source.indexOf("<textarea");
  if (start < 0) throw new Error(`${file}: no <textarea`);
  const match = source.slice(start).match(/className="([^"]+)"/);
  if (!match) throw new Error(`${file}: <textarea without a literal className`);
  return match[1]!;
}

interface Field {
  label: string;
  /** span = 칸 안에 겹쳐 그리는 표식(`data-field-adornment`, 핸들 칸의 `@`). */
  tag: "input" | "textarea" | "select" | "span";
  classes: string;
  /** 부모 상자의 클래스. 클래스 없는 칸이 무엇을 상속하는지 정한다. */
  parent?: string;
  /** 대조군(넓은 창·마우스)에서 기대하는 크기. 없으면 재지 않는다. */
  widePx?: number;
}

function fields(): Field[] {
  const roleFields: Field[] = textRoles().flatMap(({ role, px }) =>
    (["input", "textarea", "select"] as const).map((tag) => ({
      label: `${tag}.text-${role}`,
      tag,
      classes: `text-${role}`,
      widePx: px,
    }))
  );
  const real: Field[] = [
    { label: "Input 프리미티브", tag: "input", classes: primitiveClasses("design/ui/input.tsx"), widePx: 14 },
    { label: "Select 프리미티브", tag: "select", classes: primitiveClasses("design/ui/select.tsx"), widePx: 14 },
    { label: "채널 컴포저", tag: "textarea", classes: textareaClasses("features/chat/Composer.tsx"), widePx: 14 },
    { label: "스레드 컴포저", tag: "textarea", classes: textareaClasses("features/timeline/ThreadComposer.tsx"), widePx: 14 },
    { label: "메시지 편집기", tag: "textarea", classes: textareaClasses("features/timeline/MessageEditor.tsx"), widePx: 14 },
  ];
  const bare: Field[] = (["input", "textarea", "select"] as const).map((tag) => ({
    label: `클래스 없는 ${tag}`,
    tag,
    classes: "",
    parent: "text-body",
    widePx: 14,
  }));
  const adornment: Field = {
    label: "핸들 칸의 @ 표식",
    tag: "span",
    classes: adornmentClasses("features/profile/shared/HandleField.tsx"),
    parent: "text-body",
    widePx: 14,
  };
  return [...roleFields, ...real, ...bare, adornment];
}

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

async function buildCss(list: Field[]): Promise<string> {
  const compiler = await compile(readFileSync(TOKENS, "utf8"), {
    base: HERE,
    loadStylesheet,
  });
  const candidates = new Set<string>();
  for (const field of list) {
    for (const tok of `${field.classes} ${field.parent ?? ""}`.split(/\s+/)) {
      if (tok) candidates.add(tok);
    }
  }
  return compiler.build([...candidates]);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function pageHtml(css: string, list: Field[]): string {
  const rows = list
    .map((field, index) => {
      const cls = escapeAttr(field.classes);
      const control =
        field.tag === "select"
          ? `<select data-field="${index}" class="${cls}"><option>팀 서버</option></select>`
          : field.tag === "textarea"
            ? `<textarea data-field="${index}" class="${cls}"></textarea>`
            : field.tag === "span"
              ? `<span data-field="${index}" data-field-adornment="" class="${cls}">@</span>`
              : `<input data-field="${index}" class="${cls}" />`;
      return `<div class="${escapeAttr(field.parent ?? "")}">${control}</div>`;
    })
    .join("\n");
  return `<!doctype html><html lang="ko"><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${css}</style></head><body>${rows}</body></html>`;
}

const CONTEXTS = [
  {
    name: "좁은 창 375 · 마우스",
    options: { viewport: { width: 375, height: 667 } },
    expect: { width: true, hoverNone: false },
    floor: true,
  },
  {
    name: "넓은 창 1024 · 손가락",
    options: { viewport: { width: 1024, height: 768 }, hasTouch: true },
    expect: { width: false, hoverNone: true },
    floor: true,
  },
  {
    name: "넓은 창 1280 · 마우스 (대조군)",
    options: { viewport: { width: 1280, height: 800 } },
    expect: { width: false, hoverNone: false },
    floor: false,
  },
] as const;

describe("입력 칸 글자 바닥 16px (#2616)", () => {
  it.skipIf(ENGINES.length === 0)(
    "손가락·좁은 화면에서 모든 입력 칸이 16px 이상이고, 넓은 마우스 화면의 밀도는 그대로다",
    async () => {
      const list = fields();
      const html = pageHtml(await buildCss(list), list);
      const playwright = await import("playwright");
      const violations: string[] = [];
      const measured: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const context of CONTEXTS) {
            const ctx = await browser.newContext(context.options);
            try {
              const page = await ctx.newPage();
              await page.setContent(html);
              const media = await page.evaluate(() => ({
                width: matchMedia("(width < 600px)").matches,
                hoverNone: matchMedia("(hover: none)").matches,
              }));
              // 축이 흉내 내어지지 않으면 이 칸의 초록은 아무것도 재지 않은 것이다.
              expect(media, `${engine} ${context.name} media`).toEqual(context.expect);
              const sizes = await page.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>("[data-field]")].map((el) =>
                  Number.parseFloat(getComputedStyle(el).fontSize)
                )
              );
              list.forEach((field, index) => {
                const px = sizes[index]!;
                if (context.floor && !(px >= FLOOR_PX)) {
                  violations.push(`${engine} ${context.name} ${field.label}: ${px}px < ${FLOOR_PX}px`);
                }
                // 바닥은 올리기만 한다. 바닥보다 큰 역할(title·display)이 16px로
                // 끌려 내려오면 그것은 바닥이 아니라 덮어쓰기다.
                if (
                  context.floor &&
                  field.widePx !== undefined &&
                  field.widePx > FLOOR_PX &&
                  px !== field.widePx
                ) {
                  violations.push(`${engine} ${context.name} ${field.label}: ${px}px, 기대 ${field.widePx}px (바닥보다 큰 역할)`);
                }
                if (!context.floor && field.widePx !== undefined && px !== field.widePx) {
                  violations.push(`${engine} ${context.name} ${field.label}: ${px}px, 기대 ${field.widePx}px`);
                }
              });
              const composer = list.findIndex((field) => field.label === "채널 컴포저");
              measured.push(`${engine} ${context.name}: 채널 컴포저 ${sizes[composer]}px`);
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }

      expect(violations).toEqual([]);
      expect(measured.length).toBe(ENGINES.length * CONTEXTS.length);
    },
    60_000
  );

  // 브라우저가 없는 곳(CI 유닛 레인)에서도 도는 절반. 계산된 크기는 못 재지만,
  // 역할이 새로 생겼는데 입력 칸 규칙이 그것을 다시 묶지 않은 상태는 잡는다.
  it("tokens.css의 입력 칸 규칙이 바닥 밑 역할을 전부 다시 묶는다", () => {
    const css = readFileSync(TOKENS, "utf8");
    const block = css.match(
      /@media \(width < 600px\), \(hover: none\) \{\s*input,\s*textarea,\s*select,\s*\[data-field-adornment\] \{([^}]*)\}/
    );
    expect(block, "입력 칸 규칙(@media (width < 600px), (hover: none))이 없다").not.toBeNull();
    const body = block![1]!;
    const rebound = [...body.matchAll(/--text-([a-z]+):\s*var\(--field-text-floor\);/g)].map(
      (m) => m[1]
    );
    const belowFloor = textRoles()
      .filter((r) => r.px < FLOOR_PX)
      .map((r) => r.role);
    expect(belowFloor.length).toBeGreaterThan(0);
    expect(rebound.sort()).toEqual([...belowFloor].sort());
    for (const role of belowFloor) {
      expect(body).toContain(`--text-${role}--line-height: var(--field-text-floor-leading);`);
    }
    expect(body).toMatch(/font-size:\s*var\(--field-text-floor\);/);
    expect(css).toMatch(/--field-text-floor:\s*1rem;/);
  });
});
