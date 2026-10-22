import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// =============================================================================
// 배경 사진은 이 기기를 떠나지 않는다: 소스를 읽어 단정한다 (AP-4 #4191, ADR-0189 증보 2 D6 → 증보 3 D4).
//
// 폰의 `backgroundPhoto.test.ts`가 「업로드 경로가 모듈에 없다」를 소스로 단정하는 것과 같은 방식이다. 런타임 시험은
// 「이번 실행에서 요청이 안 나갔다」만 말하지만 소스 시험은 「나갈 길이 없다」를 말한다. 주석은 낱말을 자유롭게 써야
// 하므로(`업로드`·`fetch`를 설명하는 글) 컴파일러로 주석을 걷어낸 뒤의 코드만 본다.
//
// 이 시험이 실패할 수 있다는 것은 아래 「자기 점검」이 보인다: 금지된 호출을 심은 가짜 소스를 같은 검사기에 넣으면
// 반드시 잡힌다. 검사기가 아무것도 못 잡는 채로 초록이면 그 초록은 아무 말도 하지 않은 것이기 때문이다.
// =============================================================================

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_SRC = `${HERE}../../`;
const REPO = `${WEB_SRC}../../../`;

const MODULES = [
  "design/wallpaper/idb.ts",
  "design/wallpaper/photo.ts",
  "design/wallpaper/store.ts",
  "design/wallpaper/signOut.ts",
  "design/wallpaper/runtime.ts",
  "design/wallpaper/plan.ts",
  "design/wallpaper/domTokens.ts",
  "design/wallpaper/WallpaperLayer.tsx",
  "features/settings/appearance/WallpaperRow.tsx",
].map((file) => `${WEB_SRC}${file}`);

/** 주석을 걷은 코드. 타입은 남는다(낱말 검사에는 상관없다). */
function code(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: true,
    },
  }).outputText;
}

/** 이 기기 밖으로 나갈 길이 되는 낱말들. */
const OUTBOUND: ReadonlyArray<readonly [string, RegExp]> = [
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["importScripts", /\bimportScripts\b/],
  ["serviceWorker", /\bserviceWorker\b/],
  ["upload", /upload/i],
  ["http 주소 문자열", /["'`]https?:/i],
  ["blob: URL (CSP가 막는다)", /\bblob:|createObjectURL/],
  ["window.open", /\bwindow\.open\b/],
];

function violations(source: string, fileName: string): string[] {
  const text = code(source, fileName);
  return OUTBOUND.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe("배경화면 모듈에는 이 기기 밖으로 나갈 길이 없다", () => {
  it("검사 대상 파일이 실제로 있다 (빈 목록의 초록이 아니다)", () => {
    for (const file of MODULES) expect(existsSync(file), file).toBe(true);
    expect(MODULES.length).toBeGreaterThanOrEqual(9);
  });

  it.each(MODULES.map((file) => [file.replace(WEB_SRC, "")] as const))("%s", (name) => {
    const file = `${WEB_SRC}${name}`;
    expect([name, violations(readFileSync(file, "utf8"), file)]).toEqual([name, []]);
  });

  it("core의 모델도 같다 (네트워크·플랫폼 낱말이 없다)", () => {
    const file = `${REPO}packages/momo-core/src/design/wallpaper.ts`;
    expect(violations(readFileSync(file, "utf8"), file)).toEqual([]);
  });

  it("자기 점검: 금지된 호출을 심으면 검사기가 잡는다 (실패할 수 있는 가드다)", () => {
    const planted: ReadonlyArray<readonly [string, string]> = [
      ["fetch", 'export const x = () => fetch("/v1/upload");'],
      ["XMLHttpRequest", "export const x = new XMLHttpRequest();"],
      ["sendBeacon", 'export const x = () => navigator.sendBeacon("/p", "");'],
      ["WebSocket", 'export const x = new WebSocket("ws://a");'],
      ["blob: URL (CSP가 막는다)", "export const x = (b: Blob) => URL.createObjectURL(b);"],
      ["http 주소 문자열", 'export const x = "https://example.test/a.png";'],
      ["upload", "export function uploadPhoto() {}"],
    ];
    for (const [name, source] of planted) expect([name, violations(source, "x.ts")]).toEqual([name, expect.arrayContaining([name])]);
  });

  it("자기 점검: 주석 속의 같은 낱말은 코드가 아니므로 통과한다 (산문은 이 낱말을 계속 써야 한다)", () => {
    expect(violations("// fetch(…)나 업로드(upload)는 없다\n/* XMLHttpRequest */\nexport const x = 1;", "x.ts")).toEqual([]);
  });
});

describe("JSX style=은 없고 색 문자열도 없다 (CSP: 이 코드베이스는 인라인 스타일을 쓰지 않는다)", () => {
  it.each(MODULES.filter((file) => file.endsWith(".tsx")).map((file) => [file.replace(WEB_SRC, "")] as const))("%s", (name) => {
    const text = code(readFileSync(`${WEB_SRC}${name}`, "utf8"), name);
    expect(text).not.toMatch(/\bstyle=/);
  });

  it("CSSOM으로 칠하는 곳은 정해져 있다: 층 요소(런타임)와 칩(행)뿐이다", () => {
    const users = MODULES.filter((file) => /\.style\.(backgroundColor|backgroundImage|setProperty)/.test(code(readFileSync(file, "utf8"), file))).map((file) => file.replace(WEB_SRC, ""));
    expect(users.sort()).toEqual(["design/wallpaper/runtime.ts", "features/settings/appearance/WallpaperRow.tsx"]);
  });
});

describe("CSP는 바뀌지 않았고 이 기능은 그 안에서 선다", () => {
  const policies: ReadonlyArray<readonly [string, string]> = [
    ["Tauri 셸", "clients/desktop/src-tauri/tauri.conf.json"],
    ["배포(Caddyfile)", "infra/rust/Caddyfile"],
    ["Railway", "infra/railway/Caddyfile.railway"],
  ];

  it.each(policies)("%s: 이미지는 'self'와 data:만이고 blob:은 없다", (_label, path) => {
    const text = readFileSync(`${REPO}${path}`, "utf8");
    const directive = /img-src ([^;"]+)/.exec(text.replace(/^\s*#.*$/gm, ""));
    expect(directive?.[1]?.trim(), path).toBe("'self' data:");
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/blob:/);
  });

  it("Tauri 셸은 스타일에 'unsafe-inline'을 이미 허용한다 (CSSOM 칠은 그 안이다). 이 PR은 정책을 바꾸지 않는다", () => {
    const conf = JSON.parse(readFileSync(`${REPO}clients/desktop/src-tauri/tauri.conf.json`, "utf8")) as { app: { security: { csp: string } } };
    expect(conf.app.security.csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(conf.app.security.csp).toContain("img-src 'self' data:");
  });
});

// ---- 배선: 셸의 첫 자식이 층 요소다 --------------------------------------------------------------------------------
//
// 층 요소가 셸에서 빠지거나 다른 데로 옮겨지면 런타임이 붙을 곳이 없어 배경은 영영 서지 않는다(켜도 아무 일 없음).
// 이 규칙들은 `.app-shell`의 직계 자식이라는 전제로 쓰였다(`wallpaper.css`의 `position: absolute; inset: 0`은 셸을 기준으로
// 한다). 서식이 바뀌어도 깨지지 않게 소스를 컴파일러로 읽는다.

/** `className="app-shell"`인 JSX 요소의 첫 번째 의미 있는 자식의 태그 이름(공백·주석 표현식은 건너뛴다). 요소가 없으면 null. */
function firstShellChild(source: string): string | null {
  const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isJsxElement(node)) {
      const isShell = node.openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText() === "className" &&
          attribute.initializer !== undefined &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === "app-shell"
      );
      if (isShell) {
        for (const child of node.children) {
          if (ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) continue;
          if (ts.isJsxExpression(child) && child.expression === undefined) continue;
          found = ts.isJsxSelfClosingElement(child) ? child.tagName.getText() : `(${ts.SyntaxKind[child.kind]})`;
          return;
        }
        found = "";
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("배선: 층 요소는 셸의 첫 자식이다", () => {
  it("AppShell의 `.app-shell` 첫 자식은 <WallpaperLayer />이고, 그 모듈을 가져온다", () => {
    const source = readFileSync(`${WEB_SRC}app/AppShell.tsx`, "utf8");
    expect(firstShellChild(source)).toBe("WallpaperLayer");
    expect(source).toContain('import { WallpaperLayer } from "@/design/wallpaper/WallpaperLayer";');
  });

  it("자기 점검: 층 요소가 둘째거나 없거나 셸이 없으면 잡는다 (실패할 수 있는 가드다)", () => {
    const shell = (children: string) => `export const A = () => (<div className="app-shell">${children}</div>);`;
    expect(firstShellChild(shell("<WallpaperLayer /><Titlebar />"))).toBe("WallpaperLayer");
    expect(firstShellChild(shell("{/* 주석 */}<WallpaperLayer />"))).toBe("WallpaperLayer");
    expect(firstShellChild(shell("<Titlebar /><WallpaperLayer />"))).toBe("Titlebar");
    expect(firstShellChild(shell(""))).toBe("");
    expect(firstShellChild("export const A = () => (<div className=\"other\"><WallpaperLayer /></div>);")).toBeNull();
  });
});
