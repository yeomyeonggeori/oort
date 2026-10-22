#!/usr/bin/env node
// =============================================================================
// GATE — 설정 > 테마: 고른 스킴이 실제로 화면을 지배하고, 새로고침을 넘어 살아남고,
// 첫 페인트보다 먼저 붙는다 (U2).
//
// 단위 테스트(src/design/theme.test.ts)는 이 티켓의 규칙을 **함수와 파일**에 대해
// 잰다: 가짜 문서의 속성, tokens.css의 두 규칙, index.html의 태그 순서. 이 게이트가
// 재는 것은 그 규칙들이 배포되는 번들 안에서 합쳐졌을 때의 결과다. 셋 다 조립되지
// 않으면 어느 단위도 틀리지 않은 채로 화면만 틀릴 수 있다.
//
//   ① 고른 스킴이 OS를 이긴다. 컨텍스트는 OS 다크로 에뮬레이트되고, 「라이트」를
//      고른 뒤의 본문 배경은 그 다크 배경보다 **밝아야** 한다. 색을 여기 적지 않는
//      이유는 팔레트가 tokens.css의 것이기 때문이다: 이 게이트는 값이 아니라
//      **방향**(밝다/어둡다)과 **변화**(바뀌었다)를 잰다.
//   ② 저장 왕복. 새로고침한 뒤에도 같은 스탬프와 같은 배경이어야 한다. 설정 화면을
//      떠났다 돌아왔을 때 라디오가 고른 값을 그대로 들고 있어야 한다.
//   ③ FOUC. 앱 번들의 응답을 붙잡아 둔 채로 문서를 열어, **React가 아직 한 줄도
//      그리지 않은 시점에** 스탬프가 이미 붙어 있는지 본다. 이것이 이 티켓의 가장
//      깨지기 쉬운 성질이다: 스탬프를 번들 안으로 옮기면 나머지 단언은 전부 그대로
//      통과하면서 이 하나만 무너진다.
//   ④ 브라우저 크롬. theme-color 두 줄은 prefers-color-scheme으로 갈리므로, 앱만
//      고정하면 다크 앱 위에 라이트 주소창이 남는다(홈 화면 앱에서 크게 보인다).
//   ⑤ 시스템으로 되돌리기. 스탬프가 사라지고 배경이 OS 쪽으로 돌아와야 한다.
//      한쪽으로만 가는 스위치는 스위치가 아니다.
//   ⑥ 외양 v2 (AP-1a #4186). ③과 같은 방법(번들을 붙잡고 첫 문서를 읽는다)으로 셋을 잰다.
//      · v2 레코드의 아홉 속성(+ 옛 data-accent)이 번들보다 먼저 찍힌다(data-glass는 일부러 없다).
//      · 부트 캐시(momo.web.theme.cache.v1)는 파생 테마(catalog:·user:)의 것이다. 파생 테마의
//        캐시가 있으면 변수가 첫 페인트에 이미 꽂혀 있고(앱이 올라온 뒤에도 그대로: 걷는 것은
//        엔진의 몫), 첫 파티 팔레트는 캐시가 있어도 첫 페인트에 꽂지 않고 앱이 올라오면 낡은
//        항목을 걷는다(잔존 0).
//      · 캐시가 없으면 아무 변수도 없이 기본 테마로 서고 앱은 깨지지 않는다.
//
//   ⑦ 파생 테마와 엔진 (AP-1b #4188). ⑥은 부트가 **심어 둔** 캐시를 읽는 쪽만 쟀다. 이제 쓰는 쪽(파생 엔진, 지연
//      청크)이 있으므로 **폐곡선**을 잰다: 엔진이 쓴 캐시를 부트가 그대로 되꽂는다.
//      · 갤러리로 카탈로그 테마를 고르면 전 화면이 그 테마로 바뀐다(루트 변수 전부, 본문 바닥색, `meta theme-color`),
//        새로고침 뒤에도 남고, 첫 파티를 고르면 자기가 꽂은 변수가 하나도 안 남고 캐시 항목이 걷힌다(잔존 0).
//      · 캐시 없이 다크 단독 테마(`catalog:nord`)로 첫 방문 → 엔진이 변수·캐시(`mode: "dark"`)를 쓴다 → 같은
//        저장소로 JS를 붙잡고 재방문하면 **React가 그리기 전에** 엔진이 쓴 변수 전부가 꽂혀 있고 `data-theme`가
//        OS(라이트)와 무관하게 다크로 못 박혀 있다. 캐시가 없는 첫 방문의 한 프레임(기본 모습)은 허용된 어긋남이라
//        여기서 그 사실(변수 0)을 명시적으로 잰다(청사진 §5.2-i, design-review N-1).
//
// 서버는 라우트 층에서 스텁된다(gate-ailink 전례). 이 게이트가 재는 것은 번들이
// 그리는 화면과 그것이 브라우저 저장소에 남기는 것뿐이라, 살아 있는 스택이 필요
// 없다.
//
// 빌드 뒤에 실행:
//   npm run gate:theme
//
// Red proof (둘 다 FAIL이 정답):
//   THEME_GATE_PROVE_RED_BOOT=1 npm run gate:theme
//     /theme-boot.js를 빈 응답으로 바꾼다. 스탬프를 붙일 사람이 사라지므로 ③이
//     무너져야 한다. 통과한다면 그 단언은 첫 페인트가 아니라 아무거나 재고 있었던
//     것이다.
//   THEME_GATE_PROVE_RED_PERSIST=1 npm run gate:theme
//     테마 키(v2 레코드)에 대한 localStorage.setItem만 무력화한다. 화면은 즉시 바뀌지만 저장이
//     없으므로 ②가 무너져야 한다.
//   THEME_GATE_PROVE_RED_CACHE=1 npm run gate:theme
//     ⑥의 「캐시가 있으면」 장면에서 캐시 항목만 비운다. 첫 페인트에 꽂힐 변수가 사라지므로 그
//     단언이 무너져야 한다. 통과한다면 그 단언은 캐시가 아니라 아무거나 재고 있었던 것이다.
//   THEME_GATE_PROVE_RED_LOOP=1 npm run gate:theme
//     ⑦의 재방문(엔진이 쓴 캐시를 부트가 읽는 장면)에서 캐시 항목만 비운다. 첫 페인트에 꽂힐 변수가 사라지므로 폐곡선
//     단언이 무너져야 한다(⑥의 심어 둔 캐시 장면은 그대로라 ⑦만 잡는다는 것까지 보인다).
//   THEME_GATE_PROVE_RED_ENGINE=1 npm run gate:theme
//     파생 엔진 청크(`derivedApplier-*.js`)의 요청을 막는다. 엔진이 안 도니 변수도 캐시도 다시 쓰이지 않아서 ⑥①(엔진이
//     심어 둔 가짜 캐시를 인수한다)과 ⑦이 무너져야 한다. 통과한다면 그 단언들은 엔진이 아니라 부트가 심은 값만 재고
//     있었던 것이다. 첫 파티만 쓰는 ①~⑤는 이 청크가 필요 없어 그대로 선다.
// 다섯 씨앗 모두 환경 변수 전용이고, 기본 실행은 손대지 않은 번들을 읽는다.
//
// LIMIT: Chromium against Vite preview, WKWebView도 iOS 사파리도 아니다. 여기서
// 재는 것은 전부 번들 자바스크립트와 CSS의 성질이고 두 곳에서 동일하지만, 홈 화면
// 앱의 상태바가 실제로 어떤 색으로 그려지는지는 기기에서만 보인다.
//
// LIMIT: 라이트 스킴에서 **모든** 표면이 성립하는지는 이 게이트의 일이 아니다.
// 그것은 두 스킴에서 도는 캡처 레인(npm run capture:design)과 팔레트 대비 시험
// (src/design/tokens.contrast.test.ts)이 나눠 갖는다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.THEME_GATE_PORT || 5192);
const origin = `http://127.0.0.1:${port}`;
const outDir = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(webRoot, "artifacts/design");
const proveRedBoot = process.env.THEME_GATE_PROVE_RED_BOOT === "1";
const proveRedPersist = process.env.THEME_GATE_PROVE_RED_PERSIST === "1";
const proveRedCache = process.env.THEME_GATE_PROVE_RED_CACHE === "1";
const proveRedLoop = process.env.THEME_GATE_PROVE_RED_LOOP === "1";
const proveRedEngine = process.env.THEME_GATE_PROVE_RED_ENGINE === "1";

// 저장 항목 이름: core appearance.ts · themeCache.ts의 상수와 같다(게이트는 번들 밖이라 문자열로 적는다).
const V2_ENTRY = "momo.web.appearance.v2";
const V1_ENTRY = "momo.web.appearance.v1";
const CACHE_ENTRY = "momo.web.theme.cache.v1";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
};

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installRoutes(context) {
  await context.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }
    // 토큰을 **거절하지 않는** 것이 load-bearing이다(gate-ailink 머리말): 거절하면
    // centrifuge-js가 복구 불가로 보고 셸이 disconnected가 되며, 그때 설정의 쓰기
    // 컨트롤이 전부 오프라인으로 잠긴다.
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "gate-only-not-a-credential" });
    }
    if (path.endsWith("/channels")) return json(route, { channels: [] });
    if (path.endsWith("/roster")) return json(route, { members: [] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });

  if (proveRedEngine) {
    // Red proof ⑦-엔진: 파생 엔진을 싣는 청크만 막는다. 첫 파티는 이 청크가 필요 없어서 ①~⑤는 그대로 서고, 파생 테마를
    // 다루는 ⑥①·⑦만 변수·캐시를 못 얻는다.
    await context.route("**/assets/derivedApplier-*.js", (route) => route.abort());
  }

  if (proveRedBoot) {
    // Red proof ①: 첫 페인트를 맡은 스크립트만 지운다. 번들도 CSS도 그대로이므로
    // 앱은 부팅한 뒤 자기 몫의 스탬프를 붙이고, 정확히 그 사이의 프레임이 FOUC다.
    await context.route("**/theme-boot.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: "" })
    );
  }
}

function fail(message) {
  throw new Error(message);
}

function nonDefaultAccentId() {
  const src = readFileSync(
    resolve(webRoot, "src/design/themes/index.ts"),
    "utf8"
  );
  const classMatch = src.match(/export const ACCENT_ID_CHAR_CLASS = "([^"]+)"/);
  if (!classMatch) fail("ACCENT_ID_CHAR_CLASS를 카탈로그에서 읽지 못했다");
  const ACCENT_ID_CHAR_CLASS = classMatch[1];
  const ids = [
    ...src.matchAll(new RegExp(`id: "([${ACCENT_ID_CHAR_CLASS}]+)"`, "g")),
  ].map((match) => match[1]);
  const other = ids.find((id) => id !== "dawn");
  if (!other) fail("카탈로그에 기본이 아닌 액센트가 없다");
  return other;
}

/** `rgb(r, g, b)` -> WCAG 상대 휘도. 값이 아니라 방향을 재기 위한 자다. */
function luminance(color) {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) fail(`배경색을 읽지 못했다: ${color}`);
  const [r, g, b] = parts.slice(0, 3).map((n) => {
    const v = Number(n) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function surfaceOf(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

function stampOf(page) {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

function themeColorsOf(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("meta[name='theme-color'][media]")].map(
      (meta) => ({
        media: meta.getAttribute("media"),
        content: meta.getAttribute("content"),
        system: meta.getAttribute("data-theme-color-system"),
      })
    )
  );
}

/** 번들이 오기 전(React 미렌더)과 번들이 올라온 뒤에 같은 문서를 읽는다. 둘 다 이 함수가 serialize 한다. */
function readDocument() {
  const root = document.documentElement;
  const vars = {};
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i);
    vars[name] = root.style.getPropertyValue(name);
  }
  return {
    rendered: (document.getElementById("root")?.childElementCount ?? -1) > 0,
    attrs: Object.fromEntries([...root.attributes].map((a) => [a.name, a.value])),
    vars,
    cache: localStorage.getItem("momo.web.theme.cache.v1"),
  };
}

/** 파생 엔진(지연 청크)이 변수를 꽂고 캐시를 다시 쓴 뒤의 문서. `seededCache`와 다른 캐시 항목이 생기면 엔진이 인수한 것이다. */
async function firstPaintFacts(browser, seeds, { colorScheme = "light", untilEngine = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    colorScheme,
  });
  try {
    await installRoutes(context);
    await context.addInitScript((entries) => {
      for (const [name, value] of entries) localStorage.setItem(name, value);
    }, Object.entries(seeds));
    const page = await context.newPage();
    const held = [];
    await page.route("**/assets/*.js", async (route) => {
      held.push(route);
    });
    await page.goto(origin, { waitUntil: "commit" });
    await page.waitForFunction(() => document.getElementById("root") !== null, undefined, { timeout: 5_000 });
    const early = await page.evaluate(readDocument);
    await page.unroute("**/assets/*.js");
    for (const route of held) await route.continue().catch(() => {});
    await page.waitForFunction(
      () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
      undefined,
      { timeout: 20_000 }
    );
    if (untilEngine !== null) {
      // 엔진은 번들보다 늦게 도착하는 지연 청크라 「루트에 자식이 생긴 때」와 경쟁한다. 읽기 전에 그것이 끝나기를 기다린다.
      await page
        .waitForFunction(
          ([name, seeded]) => {
            const raw = localStorage.getItem(name);
            return raw !== null && raw !== seeded && raw.includes('"vars"');
          },
          [CACHE_ENTRY, untilEngine.seededCache ?? ""],
          { timeout: 20_000 }
        )
        .catch(() => fail(untilEngine.failure));
    }
    const late = await page.evaluate(readDocument);
    late.themeColors = await themeColorsOf(page);
    return { early, late };
  } finally {
    await context.close();
  }
}

function v2Record(over = {}) {
  return JSON.stringify({
    v: 2,
    scheme: "system",
    theme: "dawnsky",
    signal: null,
    density: "comfortable",
    ...over,
  });
}

async function signIn(page) {
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("theme@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
}

/** 색 모드 세그먼트의 칸(라벨)을 누른다. 라디오 입력은 화면에서 숨겨져 있다. */
async function choose(page, mode) {
  await page.locator(`label:has([data-testid="theme-choice-${mode}"])`).click();
  if (!(await page.getByTestId(`theme-choice-${mode}`).isChecked())) {
    fail(`「${mode}」 칸을 눌렀는데 라디오가 선택되지 않았다`);
  }
}

/** `#rrggbb` → `rgb(r, g, b)`(브라우저가 계산한 배경색과 같은 모양). */
function rgbOf(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) fail(`#rrggbb가 아니다: ${hex}`);
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

/** `light-dark(a, b)`에서 모드에 맞는 쪽을, 색 하나면 그대로 돌려준다. */
function pickMode(value, mode) {
  const pair = /^light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)$/.exec(value.trim());
  if (pair) return mode === "dark" ? pair[2] : pair[1];
  return value.trim();
}

async function openThemePanel(page) {
  await page.evaluate('location.hash = "/settings?section=appearance"');
  await page.waitForSelector('[data-testid="theme-choice"]');
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  mkdirSync(outDir, { recursive: true });

  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "THEME_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      // OS는 다크다. 이 게이트의 모든 「라이트」 단언은 그래서 OS를 이긴다는 뜻이
      // 된다 — 시스템을 그냥 따라도 통과하는 단언은 아무것도 증명하지 않는다.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      await installRoutes(context);

      if (proveRedPersist) {
        // Red proof ②: 테마 키의 쓰기만 삼킨다. 다른 키(세션·서버 주소)는 그대로
        // 지나가므로 로그인도 셸도 평소와 같고, 사라지는 것은 **기억**뿐이다.
        await context.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key === "momo.web.appearance.v2") return;
            return original.call(this, key, value);
          };
        });
      }

      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      await signIn(page);
      await openThemePanel(page);

      // ---- 기본값은 시스템 -------------------------------------------------
      if ((await stampOf(page)) !== null) {
        fail(
          "아무것도 고르지 않은 첫 방문에 이미 data-theme이 찍혀 있다. 기본값은 " +
            "OS를 따르는 것이고, 스탬프의 부재가 그 표현이다."
        );
      }
      const systemDark = await surfaceOf(page);
      const systemDarkLum = luminance(systemDark);
      const systemShot = `${outDir}/settings-theme-system-dark.png`;
      await page.screenshot({ path: systemShot });

      // ---- ① 고른 스킴이 OS를 이긴다 ---------------------------------------
      await choose(page, "light");
      await page.waitForFunction(
        () => document.documentElement.getAttribute("data-theme") === "light",
        undefined,
        { timeout: 5_000 }
      ).catch(() => {
        fail("「라이트」를 골랐는데 루트에 data-theme=\"light\"가 찍히지 않았다");
      });
      const pinnedLight = await surfaceOf(page);
      const pinnedLightLum = luminance(pinnedLight);
      if (pinnedLight === systemDark) {
        fail(
          `「라이트」를 골랐는데 본문 배경이 그대로다(${pinnedLight}). 스탬프는 ` +
            `찍혔지만 tokens.css가 그것을 읽지 못하고 있다.`
        );
      }
      if (pinnedLightLum <= systemDarkLum) {
        fail(
          `라이트로 고정한 배경(${pinnedLight})이 OS 다크 배경(${systemDark})보다 ` +
            `밝지 않다`
        );
      }
      const lightShot = `${outDir}/settings-theme-pinned-light.png`;
      await page.screenshot({ path: lightShot });

      // ---- ④ 브라우저 크롬도 같이 고정된다 ---------------------------------
      const pinnedMetas = await themeColorsOf(page);
      if (pinnedMetas.length !== 2) {
        fail(`theme-color 줄이 둘이 아니라 ${pinnedMetas.length}개다`);
      }
      const lightLine = pinnedMetas.find((m) => m.media.includes("light"));
      if (!lightLine?.system) {
        fail("시스템 색을 되돌릴 자리(data-theme-color-system)가 기록되지 않았다");
      }
      for (const meta of pinnedMetas) {
        if (meta.content !== lightLine.system) {
          fail(
            `theme-color ${meta.media}가 ${meta.content}로 남아 있다. 스킴을 ` +
              `고정하면 두 줄 모두 고른 쪽 색이어야 하고, 아니면 다크 OS의 ` +
              `주소창만 이전 스킴으로 남는다.`
          );
        }
      }

      // ---- ② 저장 왕복 ------------------------------------------------------
      await page.reload({ waitUntil: "networkidle" });
      await openThemePanel(page);
      if ((await stampOf(page)) !== "light") {
        fail(
          "새로고침하니 고정이 풀렸다. 이 선택은 localStorage " +
            "(momo.web.appearance.v2)에 남아야 한다."
        );
      }
      if (await surfaceOf(page) !== pinnedLight) {
        fail("새로고침 뒤 배경이 고른 스킴과 다르다");
      }
      const restored = await page
        .getByTestId("theme-choice-light")
        .isChecked();
      if (!restored) {
        fail(
          "화면은 라이트인데 설정의 라디오는 다른 값을 가리킨다. 두 개의 진실이 " +
            "있는 화면은 어느 쪽도 못 믿게 만든다."
        );
      }

      // ---- ③ FOUC: 스탬프가 앱보다 먼저 있다 --------------------------------
      // 진입 청크를 붙잡아 둔 채로 문서를 연다. 그 창 안에서 React는 아무것도
      // 그리지 못하고, 스탬프는 이미 있어야 한다.
      const held = [];
      await page.route("**/assets/*.js", async (route) => {
        held.push(route);
      });
      const navigation = page.goto(origin, { waitUntil: "commit" });
      await navigation;
      await page.waitForFunction(
        () => document.getElementById("root") !== null,
        undefined,
        { timeout: 5_000 }
      );
      const early = await page.evaluate(() => ({
        stamp: document.documentElement.getAttribute("data-theme"),
        rendered: (document.getElementById("root")?.childElementCount ?? -1) > 0,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      await page.unroute("**/assets/*.js");
      for (const route of held) await route.continue().catch(() => {});

      if (early.rendered) {
        fail(
          "앱이 이미 그려진 뒤에 쟀다. 이 창에서는 FOUC를 볼 수 없으므로 단언이 " +
            "성립하지 않는다."
        );
      }
      if (early.stamp !== "light") {
        fail(
          `번들이 도착하기 전의 문서에 스탬프가 없다(${early.stamp}). 저장된 ` +
            `선택이 OS와 반대인 사람은 매 새로고침마다 반대 스킴 한 프레임을 ` +
            `보게 된다. 스탬프는 defer가 아닌 /theme-boot.js가 붙여야 한다.`
        );
      }
      if (luminance(early.background) <= systemDarkLum) {
        fail(
          `스탬프는 있는데 첫 프레임의 배경(${early.background})이 아직 어둡다. ` +
            `스타일시트가 그 속성을 읽지 못하고 있다.`
        );
      }

      // ---- ③b FOUC: 액센트 스탬프도 앱보다 먼저 있다 ----------------------
      // 시드를 기본값(dawn)으로 두면 스탬프가 깨져도 이 게이트는 초록이다.
      const accentId = nonDefaultAccentId();
      const accentOs = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      await installRoutes(accentOs);
      await accentOs.addInitScript((id) => {
        localStorage.setItem(
          "momo.web.appearance.v1",
          JSON.stringify({ scheme: "dark", accent: id })
        );
      }, accentId);
      const accentPage = await accentOs.newPage();
      const accentHeld = [];
      await accentPage.route("**/assets/*.js", async (route) => {
        accentHeld.push(route);
      });
      await accentPage.goto(origin, { waitUntil: "commit" });
      await accentPage.waitForFunction(
        () => document.getElementById("root") !== null,
        undefined,
        { timeout: 5_000 }
      );
      const earlyAccent = await accentPage.evaluate(() => ({
        accent: document.documentElement.getAttribute("data-accent"),
        stamp: document.documentElement.getAttribute("data-theme"),
        rendered: (document.getElementById("root")?.childElementCount ?? -1) > 0,
      }));
      await accentPage.unroute("**/assets/*.js");
      for (const route of accentHeld) await route.continue().catch(() => {});
      if (earlyAccent.rendered) {
        fail(
          "액센트 첫 페인트 창에서 앱이 이미 그려졌다. 이 창에서는 FOUC를 볼 수 없다."
        );
      }
      if (earlyAccent.accent !== accentId) {
        fail(
          `번들이 도착하기 전의 문서에 data-accent=${earlyAccent.accent}다 ` +
            `(시드 ${accentId}). 액센트 스탬프는 defer가 아닌 /theme-boot.js가 붙여야 한다.`
        );
      }
      if (earlyAccent.stamp !== "dark") {
        fail(
          `액센트 시드와 함께 저장한 다크 스탬프가 없다(${earlyAccent.stamp})`
        );
      }
      await accentOs.close();

      // ---- ⑥ 외양 v2: 아홉 속성 · 부트 캐시 -----------------------------------------
      const full = await firstPaintFacts(
        browser,
        {
          [V2_ENTRY]: v2Record({
            scheme: "dark",
            theme: "graphite",
            signal: { preset: "seongun" },
            density: "compact",
            fontSize: "larger",
            threadLayout: "focus",
            prominentActive: true,
            wallpaper: { kind: "preset", id: "bam" },
            glass: { on: true, opacity: 80 },
          }),
        },
        { colorScheme: "light" }
      );
      if (full.early.rendered) {
        fail("v2 첫 페인트 창에서 앱이 이미 그려졌다. 이 창에서는 FOUC를 볼 수 없다.");
      }
      const expectedAttrs = {
        "data-theme": "dark",
        "data-palette": "graphite",
        "data-theme-ref": "graphite",
        "data-signal": "seongun",
        "data-accent": "seongun",
        "data-density": "compact",
        "data-font-size": "larger",
        "data-thread-layout": "focus",
        "data-prominent-active": "",
        "data-wallpaper": "preset",
      };
      for (const [name, value] of Object.entries(expectedAttrs)) {
        if (full.early.attrs[name] !== value) {
          fail(
            `번들이 도착하기 전의 문서에 ${name}=${JSON.stringify(full.early.attrs[name])}다 ` +
              `(v2 시드는 ${JSON.stringify(value)}). 아홉 속성은 defer가 아닌 /theme-boot.js가 붙여야 한다.`
          );
        }
      }
      if ("data-glass" in full.early.attrs || "data-glass" in full.late.attrs) {
        fail(
          "data-glass가 찍혔다. 저장소와 부트는 이 속성을 찍지 않는다: 네이티브 vibrancy가 선 " +
            "뒤에 켜는 것은 AP-3의 몫이다(planner 결정 2026-10-22)."
        );
      }
      for (const [name, value] of Object.entries(expectedAttrs)) {
        if (full.late.attrs[name] !== value) {
          fail(`앱이 올라온 뒤 ${name}=${JSON.stringify(full.late.attrs[name])}다(부트가 찍은 ${JSON.stringify(value)}와 어긋남)`);
        }
      }

      const INK = "light-dark(#16171b, #f1f1f3)";
      // 파생 테마가 루트에 꽂는 변수 가운데 화면이 가장 먼저 읽는 것들(전체 33개의 이름은 core derive.test.ts가 정본).
      const MUST_HAVE_VARS = ["--ink", "--ink-muted", "--surface", "--pane", "--canvas-mid", "--signal", "--agent", "--danger", "--line-strong"];
      const DERIVED = "catalog:nord";
      const cacheOf = (theme) => JSON.stringify({ key: `1|${theme}|-`, vars: { "--ink": INK } });

      // ① 파생 테마 + 캐시가 있다. red proof(THEME_GATE_PROVE_RED_CACHE)는 이 항목만 비운다.
      // 심어 둔 캐시는 `--ink` 하나뿐인 가짜다. 부트가 그것을 첫 페인트에 꽂는지(early)를 재고, 앱이 올라온 뒤에는
      // 파생 엔진이 인수해 **엔진의 값**으로 덮고 캐시를 다시 쓴다(late, AP-1b #4188).
      const seededCache = cacheOf(DERIVED);
      const withCache = await firstPaintFacts(
        browser,
        {
          [V2_ENTRY]: v2Record({ theme: DERIVED }),
          ...(proveRedCache ? {} : { [CACHE_ENTRY]: seededCache }),
        },
        {
          untilEngine: {
            seededCache,
            failure:
              "파생 엔진이 캐시를 다시 쓰지 않았다(20초). 파생 테마(catalog:nord)가 저장돼 있으면 앱이 올라온 뒤 " +
              "엔진 청크를 싣고 변수·캐시를 써야 한다.",
          },
        }
      );
      if (withCache.early.rendered) {
        fail("캐시 첫 페인트 창에서 앱이 이미 그려졌다. 이 창에서는 FOUC를 볼 수 없다.");
      }
      if (withCache.early.attrs["data-palette"] !== "derived") {
        fail(`파생 테마(${DERIVED}) 레코드의 첫 문서에 data-palette=${JSON.stringify(withCache.early.attrs["data-palette"])}다(derived여야 한다)`);
      }
      if (withCache.early.vars["--ink"] !== INK) {
        fail(
          `번들이 도착하기 전의 문서에 캐시 변수가 없다(--ink=${JSON.stringify(withCache.early.vars["--ink"])}). ` +
            `파생 테마의 캐시가 있으면 /theme-boot.js가 첫 렌더 전에 setProperty로 되꽂아야 한다.`
        );
      }
      if (withCache.late.cache === null) {
        fail("파생 팔레트인데 앱이 올라온 뒤 캐시 항목이 걷혔다. 파생 테마의 캐시는 엔진이 다시 써야 한다.");
      }
      // 엔진이 인수했다: 심어 둔 가짜 값(--ink 하나)이 아니라 엔진의 33개 변수가 서 있다.
      if (withCache.late.vars["--ink"] === INK || Object.keys(withCache.late.vars).length < MUST_HAVE_VARS.length) {
        fail(
          `앱이 올라오고 엔진이 캐시를 다시 썼는데 루트의 변수가 엔진의 것이 아니다(--ink=${JSON.stringify(
            withCache.late.vars["--ink"]
          )}, 변수 ${Object.keys(withCache.late.vars).length}개). 심어 둔 가짜 캐시를 엔진이 덮어야 한다.`
        );
      }

      // ② 첫 파티 레코드: 키가 맞는 캐시가 있어도 첫 페인트에 꽂지 않고, 앱이 올라오면 낡은 항목을 걷는다.
      const firstParty = await firstPaintFacts(browser, {
        [V2_ENTRY]: v2Record(),
        [CACHE_ENTRY]: cacheOf("dawnsky"),
      });
      if (firstParty.early.vars["--ink"] !== undefined) {
        fail(
          "첫 파티 팔레트(dawnsky) 문서의 첫 페인트에 캐시 변수가 꽂혔다. 정적 CSS가 색을 주는 첫 파티는 " +
            "캐시를 쓰지 않는다(첫 프레임에 캐시 색이 섰다가 걷히는 번쩍임이 생긴다)."
        );
      }
      if (firstParty.late.cache !== null || firstParty.late.vars["--ink"] !== undefined) {
        fail("첫 파티 팔레트인데 앱이 올라온 뒤에도 낡은 캐시 항목이나 인라인 변수가 남았다(잔존 0).");
      }

      // ③ 캐시가 없다(파생·첫 파티 둘 다): 변수 없이 기본 테마로 서고 앱은 깨지지 않는다.
      for (const theme of ["dawnsky", DERIVED]) {
        const noCache = await firstPaintFacts(browser, { [V2_ENTRY]: v2Record({ theme }) });
        if (Object.keys(noCache.early.vars).length !== 0) {
          fail(`캐시가 없는데(${theme}) 첫 문서에 인라인 변수가 있다(${JSON.stringify(noCache.early.vars)})`);
        }
        if (!noCache.late.rendered || noCache.late.attrs["data-theme-ref"] !== theme) {
          fail(`캐시가 없을 때(${theme}) 앱이 올라오지 못했거나 테마 참조가 유지되지 않았다`);
        }
      }

      // ④ 다른 테마의 캐시는 파생 테마 문서의 첫 페인트에도 얹지 않는다(키가 맞지 않는다).
      const stale = await firstPaintFacts(browser, {
        [V2_ENTRY]: v2Record({ theme: DERIVED }),
        [CACHE_ENTRY]: cacheOf("catalog:dracula"),
      });
      if (stale.early.vars["--ink"] !== undefined) {
        fail("키가 맞지 않는 캐시(catalog:dracula)가 catalog:nord 문서의 첫 페인트에 꽂혔다");
      }

      // v1만 있는 사람: 속성도 글꼴도 v2와 같은 규칙으로 선다(이행).
      const legacy = await firstPaintFacts(browser, {
        [V1_ENTRY]: JSON.stringify({ scheme: "dark", accent: "gamram", fontSans: "Pretendard" }),
      });
      if (
        legacy.early.attrs["data-theme"] !== "dark" ||
        legacy.early.attrs["data-signal"] !== "gamram" ||
        legacy.early.attrs["data-accent"] !== "gamram" ||
        legacy.early.vars["--font-user-sans"] !== '"Pretendard", var(--font-sans)'
      ) {
        fail(
          `v1 레코드가 v2 규칙으로 이행되어 찍히지 않았다(${JSON.stringify(legacy.early.attrs)} ` +
            `${JSON.stringify(legacy.early.vars)})`
        );
      }

      // ---- ⑦b 폐곡선: 엔진이 쓴 캐시를 부트가 그대로 되꽂는다 (AP-1b #4188, AC 4) -------------
      // OS는 라이트, 저장된 것은 다크 단독 테마(nord) + 시스템 스킴이다. 다크로 못 박히려면 캐시의 mode가 일해야 한다.
      const nordSeed = { [V2_ENTRY]: v2Record({ theme: DERIVED, scheme: "system" }) };
      const first = await firstPaintFacts(browser, nordSeed, {
        colorScheme: "light",
        untilEngine: {
          seededCache: "",
          failure:
            "캐시 없이 파생 테마(catalog:nord)로 첫 방문했는데 엔진이 캐시를 쓰지 않았다(20초). 엔진 청크가 " +
            "안 왔거나 적용기가 파생 테마를 보지 못한다.",
        },
      });
      if (first.early.rendered) fail("⑦b 첫 방문의 첫 페인트 창에서 앱이 이미 그려졌다. FOUC를 볼 수 없다.");
      // 허용된 어긋남: 캐시가 없는 첫 실행의 한 프레임은 기본 모습이다(청사진 §5.2-i). 그 사실을 명시적으로 잰다.
      if (Object.keys(first.early.vars).length !== 0 || "data-theme" in first.early.attrs) {
        fail(
          `캐시가 없는 첫 방문의 첫 페인트에 변수나 data-theme이 있다(${JSON.stringify(first.early.vars)}, ` +
            `${first.early.attrs["data-theme"]}). 부트는 캐시 없이 파생 값을 지어내지 않는다.`
        );
      }
      if (first.late.attrs["data-theme"] !== "dark") {
        fail(
          `다크 단독 테마(nord)인데 OS 라이트 위에서 앱이 올라온 뒤 data-theme=${first.late.attrs["data-theme"]}다. ` +
            `단일 모드 테마는 사람이 고른 스킴(시스템)이나 OS와 무관하게 그 모드로 못 박혀야 한다.`
        );
      }
      for (const name of MUST_HAVE_VARS) {
        const value = first.late.vars[name];
        if (!value) fail(`엔진이 ${name}을 꽂지 않았다`);
        if (value.includes("light-dark")) fail(`단일 모드 테마의 ${name}이 light-dark 쌍이다(${value}). 색 하나여야 한다.`);
      }
      const written = JSON.parse(first.late.cache);
      if (!/^[^|]+\|catalog:nord\|-$/.test(written.key)) fail(`엔진이 쓴 캐시 키가 틀리다: ${written.key}`);
      if (written.mode !== "dark") {
        fail(
          `엔진이 단일 모드(다크) 테마의 캐시에 mode를 쓰지 않았다(${JSON.stringify(written.mode)}). mode가 없으면 ` +
            `다음 부팅의 첫 프레임에 부트와 런타임이 data-theme를 다르게 찍는다.`
        );
      }
      for (const [name, value] of Object.entries(written.vars)) {
        if (first.late.vars[name] !== value) fail(`캐시의 ${name}(${value})이 루트에 꽂힌 값(${first.late.vars[name]})과 다르다`);
      }
      for (const meta of first.late.themeColors) {
        if (meta.content.toLowerCase() !== first.late.vars["--canvas-mid"].toLowerCase()) {
          fail(`엔진이 올라온 뒤 theme-color ${meta.media}가 ${meta.content}다(파생 바닥색 ${first.late.vars["--canvas-mid"]}이어야 한다)`);
        }
      }

      // 재방문: 엔진이 쓴 캐시 그대로를 심고 JS를 붙잡는다. red proof(THEME_GATE_PROVE_RED_LOOP)는 이 캐시만 비운다.
      const second = await firstPaintFacts(
        browser,
        { ...nordSeed, ...(proveRedLoop ? {} : { [CACHE_ENTRY]: first.late.cache }) },
        { colorScheme: "light" }
      );
      if (second.early.rendered) fail("⑦b 재방문의 첫 페인트 창에서 앱이 이미 그려졌다. FOUC를 볼 수 없다.");
      const missing = Object.keys(written.vars).filter((name) => second.early.vars[name] !== written.vars[name]);
      if (missing.length > 0) {
        fail(
          `엔진이 쓴 캐시가 있는데 번들이 도착하기 전의 문서에 변수 ${missing.length}/${Object.keys(written.vars).length}개가 ` +
            `없거나 다르다(${missing.slice(0, 4).join(", ")}). 파생 테마는 엔진이 쓴 캐시를 부트가 첫 렌더 전에 되꽂아야 한다.`
        );
      }
      if (second.early.attrs["data-theme"] !== "dark" || second.early.attrs["data-palette"] !== "derived") {
        fail(
          `재방문의 첫 페인트에 data-theme=${second.early.attrs["data-theme"]} data-palette=${second.early.attrs["data-palette"]}다 ` +
            `(OS는 라이트지만 다크 단독 테마의 캐시 mode가 첫 프레임을 다크로 못 박아야 한다)`
        );
      }

      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
      await openThemePanel(page);

      // ---- ⑦a 갤러리로 파생 테마를 고른다 (AP-1b #4188) ----------------------
      // 위 ②에서 새로고침한 라이트 고정 상태(첫 파티)에서 시작한다. 갤러리를 펴고 카탈로그의 짝 테마 GitHub를 고른다.
      await page.getByTestId("theme-style-trigger").waitFor({ timeout: 20_000 }); // 갤러리는 지연 청크다
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.locator('label.theme-tile:has(input[value="catalog:github"])').click();
      await page
        .waitForFunction(
          (names) =>
            document.documentElement.getAttribute("data-theme-ref") === "catalog:github" &&
            names.every((name) => document.documentElement.style.getPropertyValue(name) !== ""),
          MUST_HAVE_VARS,
          { timeout: 20_000 }
        )
        .catch(() =>
          fail(
            "갤러리에서 GitHub를 골랐는데 루트에 파생 변수가 서지 않았다. 고른 테마는 저장·스탬프만 되고 엔진이 변수를 " +
              "꽂지 못했다(파생 엔진 청크가 안 왔거나 적용기가 구독하지 않는다)."
          )
        );
      const picked = await page.evaluate(() => {
        const root = document.documentElement;
        const vars = {};
        for (let i = 0; i < root.style.length; i++) {
          const name = root.style.item(i);
          vars[name] = root.style.getPropertyValue(name);
        }
        return {
          attrs: Object.fromEntries([...root.attributes].map((a) => [a.name, a.value])),
          vars,
          cache: localStorage.getItem("momo.web.theme.cache.v1"),
          stored: localStorage.getItem("momo.web.appearance.v2"),
        };
      });
      if (picked.attrs["data-palette"] !== "derived" || picked.attrs["data-theme"] !== "light") {
        fail(
          `GitHub를 골랐는데 루트가 data-palette=${picked.attrs["data-palette"]} data-theme=${picked.attrs["data-theme"]}다 ` +
            `(derived·light여야 한다: 라이트 고정은 테마를 바꿔도 유지된다)`
        );
      }
      const derivedPane = pickMode(picked.vars["--pane"], "light");
      const bodyAfterPick = await surfaceOf(page);
      if (bodyAfterPick !== rgbOf(derivedPane)) {
        fail(
          `전 화면이 고른 테마로 바뀌지 않았다. 본문 배경이 ${bodyAfterPick}인데 엔진의 --pane(라이트)은 ` +
            `${derivedPane}(${rgbOf(derivedPane)})다. 변수는 꽂혔지만 화면이 그것을 읽지 않는다.`
        );
      }
      if (bodyAfterPick === pinnedLight) {
        fail(`고른 테마(GitHub)와 첫 파티(새벽하늘)의 본문 배경이 같다(${bodyAfterPick}). 테마가 화면에 닿지 않았다.`);
      }
      if (luminance(bodyAfterPick) <= systemDarkLum) {
        fail(`라이트 고정 위에서 파생 테마의 배경(${bodyAfterPick})이 OS 다크(${systemDark})보다 밝지 않다`);
      }
      // ④ 파생 바닥색을 따라간다: 라이트 고정이면 두 줄 모두 라이트의 바닥색이다.
      const derivedCanvas = pickMode(picked.vars["--canvas-mid"], "light");
      const derivedMetas = await themeColorsOf(page);
      for (const meta of derivedMetas) {
        if (meta.content.toLowerCase() !== derivedCanvas.toLowerCase()) {
          fail(
            `theme-color ${meta.media}가 ${meta.content}다. 파생 테마를 고르면 파생 바닥색(${derivedCanvas})으로 ` +
              `맞춰져야 한다(주소창이 앱 색과 어긋난다).`
          );
        }
      }
      const pickedCache = JSON.parse(picked.cache ?? "null");
      if (!pickedCache || !/^[^|]+\|catalog:github\|-$/.test(pickedCache.key) || pickedCache.mode !== undefined) {
        fail(`파생 테마를 고른 뒤 부트 캐시가 없거나 키·mode가 틀리다: ${picked.cache}`);
      }
      for (const name of MUST_HAVE_VARS) {
        if (pickedCache.vars[name] !== picked.vars[name]) {
          fail(`캐시의 ${name}(${pickedCache.vars[name]})이 루트의 값(${picked.vars[name]})과 다르다`);
        }
      }
      if (JSON.parse(picked.stored).theme !== "catalog:github") {
        fail("고른 테마가 localStorage(momo.web.appearance.v2)에 저장되지 않았다");
      }
      await page.screenshot({ path: `${outDir}/settings-theme-derived-github-light.png` });

      // 새로고침 뒤에도 남는다(저장 + 캐시 + 엔진).
      await page.reload({ waitUntil: "networkidle" });
      await openThemePanel(page);
      await page
        .waitForFunction(
          (names) =>
            document.documentElement.getAttribute("data-theme-ref") === "catalog:github" &&
            names.every((name) => document.documentElement.style.getPropertyValue(name) !== ""),
          MUST_HAVE_VARS,
          { timeout: 20_000 }
        )
        .catch(() => fail("새로고침하니 고른 파생 테마가 풀렸거나 변수가 다시 서지 않았다"));
      await page.getByTestId("theme-style-trigger").waitFor({ timeout: 20_000 });
      if (!(await page.getByTestId("theme-style-trigger").getAttribute("aria-label"))?.includes("GitHub")) {
        fail("새로고침 뒤 갤러리 행이 고른 테마(GitHub)를 가리키지 않는다");
      }

      // 첫 파티로 돌아가면 자기가 꽂은 변수가 하나도 안 남고 캐시 항목이 걷힌다(잔존 0).
      await page.getByTestId("theme-style-trigger").click();
      await page.getByTestId("theme-style-options").waitFor();
      await page.locator('label.theme-tile:has(input[value="dawnsky"])').click();
      await page
        .waitForFunction(() => document.documentElement.getAttribute("data-theme-ref") === "dawnsky", undefined, {
          timeout: 5_000,
        })
        .catch(() => fail("갤러리에서 새벽하늘을 골랐는데 테마 참조가 바뀌지 않았다"));
      const back = await page.evaluate((names) => {
        const root = document.documentElement;
        return {
          left: names.filter((name) => root.style.getPropertyValue(name) !== ""),
          palette: root.getAttribute("data-palette"),
          cache: localStorage.getItem("momo.web.theme.cache.v1"),
        };
      }, MUST_HAVE_VARS);
      if (back.left.length !== 0 || back.palette !== "dawnsky" || back.cache !== null) {
        fail(
          `첫 파티로 돌아왔는데 파생 흔적이 남았다: 변수 ${JSON.stringify(back.left)}, palette ${back.palette}, ` +
            `캐시 ${back.cache === null ? "없음" : "있음"} (잔존 0이어야 한다)`
        );
      }
      if ((await surfaceOf(page)) !== pinnedLight) {
        fail("첫 파티로 돌아왔는데 본문 배경이 원래 라이트 새벽하늘이 아니다");
      }
      const backMetas = await themeColorsOf(page);
      for (const meta of backMetas) {
        if (meta.content.toLowerCase() === derivedCanvas.toLowerCase()) {
          fail(`첫 파티로 돌아왔는데 theme-color ${meta.media}가 파생 바닥색(${derivedCanvas})에 묶여 있다`);
        }
      }

      // ---- ⑤ 시스템으로 되돌아온다 ------------------------------------------
      await choose(page, "system");
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-theme"),
        undefined,
        { timeout: 5_000 }
      ).catch(() => {
        fail(
          "「시스템 설정 따르기」를 골랐는데 data-theme이 남아 있다. 시스템은 다른 " +
            "값이 아니라 스탬프의 부재다."
        );
      });
      const backToSystem = await surfaceOf(page);
      if (backToSystem !== systemDark) {
        fail(
          `시스템으로 되돌렸는데 배경이 OS 다크(${systemDark})가 아니라 ` +
            `${backToSystem}다`
        );
      }
      const releasedMetas = await themeColorsOf(page);
      for (const meta of releasedMetas) {
        if (meta.content !== meta.system) {
          fail(
            `고정을 풀었는데 theme-color ${meta.media}가 ${meta.content}에 묶여 ` +
              `있다(원래 ${meta.system})`
          );
        }
      }
      await page.reload({ waitUntil: "networkidle" });
      await openThemePanel(page);
      if ((await stampOf(page)) !== null) {
        fail("시스템 선택이 새로고침을 넘기지 못하고 고정으로 되살아났다");
      }

      // ---- 반대 방향: OS 라이트 위의 다크 고정 ------------------------------
      // 한쪽 방향만 재면 "라이트가 기본이 됐다"는 회귀를 통과시킨다.
      const lightOs = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      await installRoutes(lightOs);
      await lightOs.addInitScript(() => {
        localStorage.setItem(
          "momo.web.appearance.v1",
          JSON.stringify({ scheme: "dark", accent: "dawn" })
        );
      });
      const darkPage = await lightOs.newPage();
      await darkPage.goto(origin, { waitUntil: "networkidle" });
      await signIn(darkPage);
      await openThemePanel(darkPage);
      if ((await stampOf(darkPage)) !== "dark") {
        fail("OS가 라이트인 기기에서 저장된 다크 선택이 적용되지 않았다");
      }
      const pinnedDarkLum = luminance(await surfaceOf(darkPage));
      if (pinnedDarkLum >= pinnedLightLum) {
        fail("다크로 고정한 배경이 라이트로 고정한 배경보다 어둡지 않다");
      }
      const darkShot = `${outDir}/settings-theme-pinned-dark.png`;
      await darkPage.screenshot({ path: darkShot });
      await lightOs.close();

      console.log(
        [
          "GATE PASS: 설정 > 테마",
          `  시스템(OS 다크) 배경   ${systemDark}`,
          `  라이트 고정 배경       ${pinnedLight}`,
          `  첫 페인트 스탬프       ${early.stamp} (React 미렌더 상태에서 측정)`,
          `  첫 페인트 액센트       ${earlyAccent.accent} (시드 ${accentId}, 미렌더)`,
          `  첫 페인트 v2 속성      ${Object.keys(expectedAttrs).length}개 (아홉 + 옛 data-accent, data-glass 없음, 미렌더)`,
          `  부트 캐시              파생 테마: 첫 페인트에 --ink 꽂힘 · 첫 파티: 안 꽂고 앱 뒤 항목 걷힘 · 없으면 기본 테마`,
          `  파생 엔진(AP-1b)       갤러리로 GitHub 선택 → 본문 배경 ${bodyAfterPick} = 엔진의 --pane · theme-color ${derivedCanvas} · 새로고침 유지 · 첫 파티로 돌아오면 잔존 0`,
          `  폐곡선                 엔진이 쓴 캐시 ${Object.keys(written.vars).length}개 변수가 재방문 첫 페인트(미렌더)에 모두 꽂힘 · OS 라이트 위 다크 단독 테마 data-theme=dark`,
          `  캡처                   ${systemShot}`,
          `                         ${lightShot}`,
          `                         ${darkShot}`,
        ].join("\n")
      );
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  const message = String(error.message ?? error);
  console.error(message.startsWith("GATE FAIL:") ? message : `GATE FAIL: ${message}`);
  process.exit(1);
});
