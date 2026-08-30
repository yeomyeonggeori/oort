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
//     테마 키에 대한 localStorage.setItem만 무력화한다. 화면은 즉시 바뀌지만 저장이
//     없으므로 ②가 무너져야 한다.
// 두 씨앗 모두 환경 변수 전용이고, 기본 실행은 손대지 않은 번들을 읽는다.
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
  const ids = [...src.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]);
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

async function signIn(page) {
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("theme@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
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
            if (key === "momo.web.appearance.v1") return;
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
      await page.locator("#theme-light").check();
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
            "(momo.web.appearance.v1)에 남아야 한다."
        );
      }
      if (await surfaceOf(page) !== pinnedLight) {
        fail("새로고침 뒤 배경이 고른 스킴과 다르다");
      }
      const restored = await page
        .locator("#theme-light")
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

      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
      await openThemePanel(page);

      // ---- ⑤ 시스템으로 되돌아온다 ------------------------------------------
      await page.locator("#theme-system").check();
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
