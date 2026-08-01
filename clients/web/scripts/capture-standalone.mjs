#!/usr/bin/env node
// =============================================================================
// 홈 화면 앱 검증 + 캡처 (goal B10).
//
//   npm run capture:standalone        # -> artifacts/pwa/*.png
//
// 스크린샷만 찍는 스크립트가 아니다. PWA는 눈으로 봐서 맞는지 알 수 없는 것들로
// 이루어져 있어서(매니페스트가 유효한가, 워커가 무엇을 캐시했는가, 오프라인에서
// 무엇을 돌려주는가), 이 파일은 먼저 **재고** 그 다음에 찍는다. 재는 것 중 하나
// 라도 어긋나면 캡처 전에 실패한다.
//
// 재는 것:
//   1. 매니페스트가 JSON MIME으로 오고, standalone이며, 192/512/maskable 아이콘이
//      선언한 크기 그대로 존재하는가.
//   2. 서비스 워커가 등록되고 셸(문서 + 진입 청크 + CSS)을 미리 받아 두는가.
//   3. **캐시에 /v1 응답이 하나도 없는가.** 이 배치의 정직성 계약이다.
//   4. 네트워크를 끊었을 때 셸이 뜨는가.
//   5. display-mode: standalone에서 셸이 상단 안전 영역만큼 물러나는가.
//
// 찍는 것: 폰 브라우저(설치 안내 한 줄), 홈 화면 모드(안내 없음), 오프라인,
// 그리고 로그인한 셸 위의 같은 한 줄.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/pwa");
const PORT = Number(process.env.CAPTURE_PORT || 5182);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// 390x844 = iPhone 14/15의 CSS 뷰포트. 이 티켓을 연 실캡처를 찍은 그 기기다.
const PHONE = { width: 390, height: 844 };
// UA를 바꾸는 이유는 하나다: iOS에는 beforeinstallprompt가 없어서 설치 경로가
// 공유 시트 안내로 갈라지고(store.ts isIosWebKit), 그 갈래가 성재의 기기다.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 1}/connection/websocket`,
};

const CHANNELS = [
  {
    id: GENERAL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "general",
    topic: "팀 전체 공지와 잡담",
    muted: false,
  },
  {
    id: "00000000-0000-7000-8000-000000000202",
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "engine",
    topic: "엔진 트랙 작업",
    muted: false,
  },
];

const shots = [];

function log(line) {
  console.log(line);
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- 1. 매니페스트와 아이콘 --------------------------------------------------

/** PNG 헤더에서 실제 픽셀 크기를 읽는다. 선언한 sizes와 맞는지 재기 위해서. */
function pngSize(buffer) {
  const view = new DataView(buffer);
  const signature = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
  if (!signature) throw new Error("not a PNG");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function assertManifest() {
  const res = await fetch(`${ORIGIN}/manifest.json`);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  // 스펙이 요구하는 것은 "JSON MIME"이다: application/json도, +json으로 끝나는
  // 것도 통과한다. text/plain으로 나가면 브라우저는 매니페스트를 무시한다.
  if (!/(^|\/|\+)json\b/.test(contentType)) {
    throw new Error(`manifest is not served as JSON: ${contentType}`);
  }
  const manifest = await res.json();
  if (manifest.display !== "standalone") {
    throw new Error(`display must be standalone, got ${manifest.display}`);
  }
  for (const field of ["name", "short_name", "start_url", "scope", "theme_color", "background_color"]) {
    if (!manifest[field]) throw new Error(`manifest is missing ${field}`);
  }

  const wanted = [
    { size: 192, purpose: "any" },
    { size: 512, purpose: "any" },
    { size: 512, purpose: "maskable" },
  ];
  for (const want of wanted) {
    const icon = (manifest.icons ?? []).find(
      (candidate) =>
        candidate.sizes === `${want.size}x${want.size}` &&
        (candidate.purpose ?? "any") === want.purpose
    );
    if (!icon) throw new Error(`manifest has no ${want.size}px ${want.purpose} icon`);
    const iconRes = await fetch(new URL(icon.src, ORIGIN));
    if (!iconRes.ok) throw new Error(`icon ${icon.src} is missing: ${iconRes.status}`);
    const measured = pngSize(await iconRes.arrayBuffer());
    if (measured.width !== want.size || measured.height !== want.size) {
      throw new Error(
        `icon ${icon.src} says ${icon.sizes} but is ${measured.width}x${measured.height}`
      );
    }
    log(`  icon ${icon.src}: ${measured.width}x${measured.height} ${want.purpose}`);
  }
  log(`  manifest: ${contentType}, display=${manifest.display}, ${manifest.icons.length} icons`);
}

// ---- 2~5. 워커, 오프라인, 홈 화면 모드 --------------------------------------

/**
 * 홈 화면에서 연 앱이라고 스크립트에게 말해 주는 방법. iOS가 실제로 쓰는 신호이고
 * (store.ts standaloneNow), 문서가 실행되기 전에 심어야 첫 판단에서 보인다.
 */
const IOS_STANDALONE_INIT =
  "Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });";

/**
 * 상단 안전 영역 규칙의 CSS 절반.
 *
 * 한계부터 적는다: **크로미움은 display-mode를 흉내 내지 못한다.** CDP의
 * Emulation.setEmulatedMedia가 아는 미디어 기능 목록에 그것이 없다(실측:
 * prefers-color-scheme류만 받는다). 그래서 이 검사는 하나를 두 조각으로 나눠 잰다.
 *
 *   1. 배포되는 스타일시트 안에 `@media (display-mode: standalone)`로 감싸인
 *      셸(#root) 규칙이 실제로 들어 있는가. 규칙이 사라지면 여기서 잡힌다.
 *   2. 그 선언(env(safe-area-inset-top))이 기기가 준 값으로 풀리는가. 안전 영역은
 *      CDP가 덮어쓸 수 있으므로(Emulation.setSafeAreaInsetsOverride, 실측 가능),
 *      같은 선언을 조건 없이 걸어 계산값을 잰다.
 *
 * 스크린샷도 2번 상태에서 찍는다: 미디어가 켜졌을 때 아이폰이 그리는 화면과 같은
 * 픽셀이고, 다른 방법으로는 그 띠를 그릴 수 없다.
 */
const SAFE_AREA_TOP_DECLARATION = "padding-block-start: env(safe-area-inset-top, 0px)";
const SAFE_AREA_INSET_TOP = 59;

async function shoot(page, name) {
  const path = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
  log(`  shot ${name}.png`);
}

async function runWorkerChecks(browser) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
  });
  const page = await context.newPage();

  // `?pwa`는 store.ts의 seam이다: 배포는 https에서만 워커를 켜므로, 로컬 preview
  // 에서 같은 경로를 걷으려면 명시적으로 열어야 한다.
  await page.goto(`${ORIGIN}/?pwa=1`, { waitUntil: "load" });
  await page.waitForFunction(
    "navigator.serviceWorker.getRegistration().then((r) => Boolean(r && r.active))",
    null,
    { timeout: 20_000 }
  );

  // 브라우저 자신이 매니페스트를 어떻게 읽었는가. 위의 fetch는 파일이 온다는
  // 사실만 재고, 이 호출은 **크로미움의 파서**를 통과한 결과와 그 오류 목록을
  // 돌려준다. 링크 태그가 빠지거나 필드가 틀리면 여기서 잡힌다.
  const client = await context.newCDPSession(page);
  const parsed = await client.send("Page.getAppManifest");
  if (!parsed.url || !parsed.url.endsWith("/manifest.json")) {
    throw new Error(`the page did not link a manifest: ${JSON.stringify(parsed.url)}`);
  }
  const blocking = (parsed.errors ?? []).filter((error) => error.critical);
  if (blocking.length > 0) {
    throw new Error(`chromium rejected the manifest: ${JSON.stringify(blocking)}`);
  }
  log(
    `  chromium parsed ${new URL(parsed.url).pathname}: ` +
      `${blocking.length} critical, ${(parsed.errors ?? []).length} total notes`
  );

  // 설치 가능한가. 라이트하우스의 "installable" 감사와 같은 판정을 브라우저에게
  // 직접 묻는다(매니페스트 + 아이콘 + 활성 워커 + 보안 컨텍스트). 이 CDP 명령은
  // deprecated이므로, 사라진 크로미움에서는 거짓 실패 대신 한 줄을 남기고 넘어
  // 간다. 위의 개별 실측이 이미 같은 조건들을 하나씩 재고 있다.
  try {
    const { installabilityErrors } = await client.send("Page.getInstallabilityErrors");
    if (installabilityErrors.length > 0) {
      throw new Error(
        `chromium would not offer to install: ${JSON.stringify(installabilityErrors)}`
      );
    }
    log("  installable: chromium reports 0 blockers");
  } catch (error) {
    if (!/wasn't found|not found|Protocol error/i.test(String(error.message))) throw error;
    log("  installable: this chromium no longer answers getInstallabilityErrors");
  }

  // 설치 안내 한 줄. iOS UA이므로 공유 시트 갈래다.
  await page.getByTestId("pwa-install-invite").waitFor({ state: "visible" });
  await shoot(page, "phone-browser-install-invite");

  // 프리캐시가 실제로 무엇을 담았는가.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const entries = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) entries.push(request.url);
    }
    return { names, entries };
  });
  const shellCaches = cached.names.filter((name) => name.startsWith("oort-shell-"));
  if (shellCaches.length !== 1) {
    throw new Error(`expected one shell cache, got ${JSON.stringify(cached.names)}`);
  }
  const paths = cached.entries.map((url) => new URL(url).pathname);
  for (const required of ["/index.html"]) {
    if (!paths.includes(required)) {
      throw new Error(`shell cache is missing ${required}: ${JSON.stringify(paths)}`);
    }
  }
  if (!paths.some((path) => path.startsWith("/assets/") && path.endsWith(".js"))) {
    throw new Error(`shell cache has no entry chunk: ${JSON.stringify(paths)}`);
  }
  if (!paths.some((path) => path.startsWith("/assets/") && path.endsWith(".css"))) {
    throw new Error(`shell cache has no stylesheet: ${JSON.stringify(paths)}`);
  }
  // 이 배치의 정직성 계약. 데이터는 캐시되지 않는다.
  const leaked = paths.filter((path) => path.startsWith("/v1/") || path === "/health");
  if (leaked.length > 0) {
    throw new Error(`shell cache holds API responses: ${JSON.stringify(leaked)}`);
  }
  log(`  cache ${shellCaches[0]}: ${paths.length} entries, 0 API responses`);
  log(`    ${paths.join("\n    ")}`);

  // 두 번째 방문: 이번에는 워커가 문서를 쥐고 있다.
  await page.reload({ waitUntil: "load" });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  if (!controlled) throw new Error("the second visit is not controlled by the worker");
  log("  second visit: controlled by the worker");

  // 오프라인: 셸은 뜨고, 데이터는 없다.
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("login-submit").waitFor({ state: "visible", timeout: 15_000 });
  const apiOffline = await page.evaluate(async () => {
    try {
      const res = await fetch("/v1/workspaces/x/channels");
      return `answered ${res.status}`;
    } catch {
      return "failed";
    }
  });
  if (apiOffline !== "failed") {
    throw new Error(`an offline /v1 call was answered from somewhere: ${apiOffline}`);
  }
  log("  offline: shell rendered, /v1 still fails (no stale data)");
  await shoot(page, "phone-offline-shell");
  await context.setOffline(false);
  await context.close();
}

/** 홈 화면 모드. 설치 안내는 사라지고, body가 상단 안전 영역만큼 물러난다. */
async function runStandaloneChecks(browser) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
  });
  await context.addInitScript(IOS_STANDALONE_INIT);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/?pwa=1`, { waitUntil: "load" });

  // 1. 규칙이 배포되는 스타일시트 안에 있는가.
  const shippedRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue;
      }
      for (const rule of rules) {
        const media = rule.media?.mediaText ?? "";
        if (media.includes("display-mode") && media.includes("standalone")) {
          return rule.cssText.replace(/\s+/g, " ");
        }
      }
    }
    return null;
  });
  if (!shippedRule) {
    throw new Error("the shipped stylesheet has no (display-mode: standalone) rule");
  }
  if (!/#root/.test(shippedRule) || !/safe-area-inset-top/.test(shippedRule)) {
    throw new Error(`the standalone rule is not the shell inset one: ${shippedRule}`);
  }
  log(`  rule: ${shippedRule}`);

  // 2. 그 선언이 기기가 준 안전 영역으로 풀리는가. 이 크로미움에는 안전 영역
  //    오버라이드가 있으므로 값까지 잰다.
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: SAFE_AREA_INSET_TOP, left: 0, bottom: 34, right: 0 },
  });
  await page.addStyleTag({ content: `#root { ${SAFE_AREA_TOP_DECLARATION}; }` });

  const standalone = await page.evaluate(() => ({
    scriptStandalone: navigator.standalone === true,
    paddingTop: getComputedStyle(document.getElementById("root")).paddingTop,
    invite: Boolean(document.querySelector('[data-testid="pwa-install-invite"]')),
    documentScroll:
      (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
  }));
  if (!standalone.scriptStandalone) throw new Error("standalone seed did not take");
  if (standalone.invite) {
    throw new Error("the install invite is still offered inside the installed app");
  }
  if (standalone.paddingTop !== `${SAFE_AREA_INSET_TOP}px`) {
    throw new Error(
      `the shell should step back ${SAFE_AREA_INSET_TOP}px, got ${standalone.paddingTop}`
    );
  }
  if (standalone.documentScroll > 0) {
    throw new Error(
      `the document grew past the window by ${standalone.documentScroll}px`
    );
  }
  log(
    `  standalone: invite hidden, #root padding-top ${standalone.paddingTop}, ` +
      `document does not scroll`
  );
  await shoot(page, "phone-standalone-connect");

  await context.close();
}

// ---- 로그인한 셸 -------------------------------------------------------------

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * 셸 한 장을 찍기 위한 최소 목. 워커는 이 컨텍스트에서 끈다: 워커가 문서를 쥐면
 * 라우트 가로채기와 경로가 겹쳐서, 캡처가 실패했을 때 원인을 두 겹으로 파야 한다.
 * 워커 자체는 위에서 이미 실측했다.
 */
async function captureSignedInShell(browser, { standalone, scheme = "light" }) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    colorScheme: scheme,
    serviceWorkers: "block",
  });
  // 플레이라이트는 **나중에 건 라우트를 먼저** 본다. 그래서 포괄 목이 맨 위에
  // 오고, 구체적인 목이 그 뒤에 서서 이긴다.
  await context.route("**/v1/**", (route) => json(route, {}));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: [SESSION.member] })
  );
  // 포괄 목의 `{}`를 허들 파서가 "불러오지 못했습니다"로 읽는다. 없는 허들은
  // 빈 객체가 아니라 null이다.
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) =>
    json(route, { huddle: null })
  );
  if (standalone) await context.addInitScript(IOS_STANDALONE_INIT);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
  if (standalone) {
    const client = await context.newCDPSession(page);
    await client.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: SAFE_AREA_INSET_TOP, left: 0, bottom: 34, right: 0 },
    });
    await page.addStyleTag({ content: `#root { ${SAFE_AREA_TOP_DECLARATION}; }` });
  }
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await shoot(
    page,
    `${standalone ? "phone-standalone-shell" : "phone-browser-shell"}-${scheme}`
  );
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run capture:standalone`.");
  }
  if (!existsSync(resolve(WEB_ROOT, "dist/sw.js"))) {
    throw new Error("dist/sw.js is missing: the build did not emit the worker.");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    log("manifest + icons");
    await assertManifest();

    const browser = await chromium.launch();
    try {
      log("service worker + offline");
      await runWorkerChecks(browser);
      log("standalone (home screen) mode");
      await runStandaloneChecks(browser);
      log("signed-in shell");
      // 두 스킴 모두 본다: 배너의 색은 전부 토큰이라 light-dark()가 갈라 준다.
      await captureSignedInShell(browser, { standalone: false, scheme: "light" });
      await captureSignedInShell(browser, { standalone: false, scheme: "dark" });
      await captureSignedInShell(browser, { standalone: true, scheme: "dark" });
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }

  log(`\nPASS: ${shots.length} shots in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(`\nFAIL: ${error.message}`);
  process.exit(1);
});
