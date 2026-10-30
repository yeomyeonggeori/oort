import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { browserLaunchBlocked } from "@/testing/agentSandbox";

// =============================================================================
// 시험용: `tokens.css`를 Tailwind 컴파일러로 **진짜로** 컴파일해 CSS 문자열을 돌려주고, 이 컴퓨터에
// 설치된 브라우저 엔진 목록을 알려 준다(AP-2a #4189). 문자열을 파싱하는 시험은 「이 줄이 있다」만
// 말하고, 이 도구로 얻은 CSS를 실제 엔진에 먹이는 시험은 「브라우저가 계산한 값이 이렇다」를 말한다.
// `fieldTextFloor.browser.test.ts`가 같은 방법을 쓴다(그 파일은 자기 사본을 들고 있다).
//
// 엔진은 WebKit(사파리·WKWebView의 엔진)과 Chromium 중 설치된 것 전부다. 둘 다 없으면 경고를 남기고
// 빈 목록을 돌려주며, 시험은 `skipIf`로 건너뛴다(다른 브라우저 시험과 같은 규약, CI 레인은 #2129).
// 에이전트 격리 안이면 설치돼 있어도 띄우지 않고 같은 길로 건너뛴다(`@/testing/agentSandbox`, #4861).
// =============================================================================

const require_ = createRequire(import.meta.url);
const DESIGN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TOKENS_PATH = join(DESIGN_DIR, "tokens.css");

export type EngineName = "webkit" | "chromium";

function engineMissing(name: EngineName): string | null {
  const blocked = browserLaunchBlocked();
  if (blocked !== null) return blocked;
  try {
    const playwright = require_("playwright") as typeof import("playwright");
    const exe = playwright[name].executablePath();
    return existsSync(exe) ? null : exe;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const ENGINES: EngineName[] = (["webkit", "chromium"] as const).filter((name) => {
  const missing = engineMissing(name);
  if (missing !== null) console.warn(`tokens browser tests: Playwright ${name} missing (${missing})`);
  return missing === null;
});

async function loadStylesheet(id: string, base: string) {
  if (id === "tailwindcss" || id.endsWith("tailwindcss/index.css")) {
    const path = require_.resolve("tailwindcss/index.css");
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const path = id.startsWith(".") || id.startsWith("/") ? `${base}/${id}` : id;
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

/** `tokens.css`(와 그것이 `@import`하는 조각들)를 컴파일하고, 후보 클래스에 해당하는 유틸리티를 만든다. */
export async function compileTokensCss(candidates: Iterable<string>): Promise<string> {
  const compiler = await compile(readFileSync(TOKENS_PATH, "utf8"), {
    base: DESIGN_DIR,
    loadStylesheet,
  });
  return compiler.build([...new Set(candidates)]);
}
