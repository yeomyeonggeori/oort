#!/usr/bin/env node
// =============================================================================
// 오르트 로더 캡처 (#3961, 시안 A 「공전」, owner 2026-10-17).
//
// 실제 앱(빌드한 dist)을 mock /v1 위에 띄워 로더가 서는 자리를 **구현된 화면 그대로**
// 라이트·다크 1440 으로 찍고, 같은 화면에서 움직임 GIF 를 뽑는다.
//
//   연결 배너      레일이 15초 안 올라오면 선다(never-connected). 도는 중, 다시 연결 누른 뒤,
//                  6초 뒤 실패(정지 마크), 브라우저 오프라인(정지 마크), 동작 줄이기(정지 + 숨).
//   첫 로딩        세션 복원을 붙잡아 둔 동안의 큰 로더(코메토 + 위성)와 「불러오는 중」.
//
//   OUT_DIR=/path DIST_DIR=/path/to/dist node scripts/capture-oort-loader.mjs
//
// 첫 로딩 화면은 제품에서 BOOT_RESTORE_BUDGET_MS(2.5초)까지만 머문다. GIF 를 한 주기(1.8초)
// 이상 찍으려고 **캡처용 빌드만** `VITE_MOMO_BOOT_RESTORE_BUDGET_MS=60000` 으로 만든다
// (`gate:boot` 가 같은 손잡이를 쓴다). 제품 기본값은 그대로다.
//
// GIF 프레임은 시계를 세워서 얻는다: 모든 CSS 애니메이션을 `currentTime` 으로 고정하고
// 그 순간을 찍는다. 기계 부하와 무관하게 같은 프레임이 나온다.
//
// No credentials and no backend: /v1 is fulfilled from the fixtures below.
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const PORT = Number(process.env.CAPTURE_PORT || 5183);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(process.env.CAPTURE_WIDTH || 1440);
const VIEWPORT = { width: WIDTH, height: 900 };
/** 1440 이 아닌 폭은 배너가 접히는 모습만 본다(연결 중 한 장, 파일 이름에 폭이 붙는다). */
const NARROW = WIDTH !== 1440;
const SUFFIX = NARROW ? `-w${WIDTH}` : "";
/** 한 주기(ms). tokens.css `--oort-loader-period`. */
const PERIOD_MS = 1800;
const SCHEMES = ["light", "dark"];

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  // 아무도 듣지 않는 포트: 레일이 영영 올라오지 않는 세션(never-connected).
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
];

function member(id, kind, displayName, handle, extra = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    kind,
    status: "active",
    displayName,
    handle,
    channelCount: 2,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_000,
    ...extra,
  };
}

const ROSTER = [
  member(ME, "human", "곽성재", "seongjae", { role: "owner" }),
  member("019F94E3-7B0F-7A22-9C13-4D5E6F708192", "human", "김인턴", "intern-kim", { role: "member" }),
  member("019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90", "agent", "김인턴", "kim-intern", { ownerHumanId: ME, agentModel: "claude-opus-5" }),
];

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 첫 로딩 장면에서만 토큰 회전을 붙잡는다(복원이 끝나지 않게). */
const gate = { holdRefresh: false };

async function installMocks(context) {
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", async (route) => {
    // 놓아 주기 전까지 붙잡고, 놓으면 정상 응답한다(예산 안에서 풀리지 않게 캡처 빌드는 예산이 길다).
    try {
      while (gate.holdRefresh) await sleep(100);
      await json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken });
    } catch {
      /* 장면이 끝나 컨텍스트가 먼저 닫혔다 */
    }
  });
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
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: ROSTER }));
}

async function signIn(page) {
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

/** 모든 애니메이션을 ms 로 세운다. 시계가 선 화면이 곧 그 순간의 프레임이다. */
async function freezeAt(page, ms) {
  await page.evaluate((t) => {
    document.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = t;
    });
  }, ms);
}

async function loaderBox(page, variant) {
  const box = await page.locator(`[data-oort-loader="${variant}"]`).first().boundingBox();
  if (!box) throw new Error(`로더(${variant})가 화면에 없다`);
  return box;
}

/** 한 주기를 `frames` 장으로 찍어 GIF 로 굽는다. clip 은 css px. */
async function recordGif(page, { clip, frames, from = 0, scale, out, workDir }) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  for (let i = 0; i < frames; i += 1) {
    await freezeAt(page, from + Math.round((PERIOD_MS * i) / frames));
    await page.screenshot({ path: join(workDir, `f_${String(i).padStart(3, "0")}.png`), clip });
  }
  const fps = Math.round(frames / (PERIOD_MS / 1000));
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-i",
      join(workDir, "f_%03d.png"),
      "-vf",
      `scale=iw*${scale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      "-loop",
      "0",
      out,
    ],
    { stdio: "inherit" }
  );
  rmSync(workDir, { recursive: true, force: true });
}

async function captureScheme(browser, scheme, shots, gifs) {
  // ---- 연결 배너 (움직임) --------------------------------------------------
  {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "no-preference" });
    await installMocks(context);
    const page = await context.newPage();
    await signIn(page);

    // 15초 안 올라오면 배너가 선다.
    await page.getByTestId("connection-banner").waitFor({ state: "visible", timeout: 40_000 });
    await freezeAt(page, 0.45 * PERIOD_MS); // 위성이 궤도에 나가 있는 순간
    const loading = join(OUT_DIR, `oort-loader-web-banner-connecting${SUFFIX}-${scheme}.png`);
    await page.screenshot({ path: loading });
    shots.push(loading);
    if (NARROW) {
      await context.close();
      return;
    }

    // GIF: 배너 왼쪽(아이콘 + 문장 앞부분). 시계를 세워 한 주기를 찍는다.
    const banner = await page.getByTestId("connection-banner").boundingBox();
    const gif = join(OUT_DIR, `oort-loader-web-banner-${scheme}.gif`);
    await recordGif(page, {
      clip: { x: banner.x, y: banner.y, width: 560, height: banner.height },
      frames: 36,
      scale: 0.75,
      out: gif,
      workDir: join(OUT_DIR, `.frames-banner-${scheme}`),
    });
    gifs.push(gif);

    // 애니메이션을 다시 흐르게 한다(이어서 실제 상호작용).
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));

    // 다시 연결을 누르면 「연결 중」, 로더는 계속 돈다.
    await page.getByRole("button", { name: "다시 연결" }).click();
    await page.getByRole("button", { name: "연결 중" }).waitFor({ state: "visible" });
    await freezeAt(page, 0.45 * PERIOD_MS);
    const running = join(OUT_DIR, `oort-loader-web-banner-retry-running-${scheme}.png`);
    await page.screenshot({ path: running });
    shots.push(running);
    await page.evaluate(() => document.getAnimations().forEach((a) => a.play()));

    // 6초 안에 안 붙으면 실패 문장, 같은 마크가 멈춰 선다.
    await page.getByText("다시 연결하지 못했습니다", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
    const failed = join(OUT_DIR, `oort-loader-web-banner-failed-still-${scheme}.png`);
    await page.screenshot({ path: failed });
    shots.push(failed);

    // 브라우저 오프라인: 대기 없이 서고, 정지 마크.
    await context.setOffline(true);
    await page.getByText("네트워크가 끊겼습니다", { exact: false }).waitFor({ state: "visible" });
    const offline = join(OUT_DIR, `oort-loader-web-banner-offline-still-${scheme}.png`);
    await page.screenshot({ path: offline });
    shots.push(offline);
    await context.close();
  }

  // ---- 연결 배너 (동작 줄이기) ------------------------------------------------
  {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
    await installMocks(context);
    const page = await context.newPage();
    await signIn(page);
    await page.getByTestId("connection-banner").waitFor({ state: "visible", timeout: 40_000 });
    await freezeAt(page, 0.5 * PERIOD_MS); // 투명도 숨의 가장 옅은 순간
    const reduced = join(OUT_DIR, `oort-loader-web-banner-reduced-motion-${scheme}.png`);
    await page.screenshot({ path: reduced });
    shots.push(reduced);
    await context.close();
  }

  // ---- 첫 로딩 (복원을 붙잡아 둔 동안) -------------------------------------------
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion });
    await installMocks(context);
    const page = await context.newPage();
    await signIn(page);
    gate.holdRefresh = true;
    await page.reload({ waitUntil: "commit" });
    await page.locator('[data-testid="session-restoring"] [data-oort-loader="hero"]').waitFor({ state: "attached" });
    await sleep(900); // 지연 + 나타나기(0.24 + 0.18초)가 끝난 뒤
    const tag = reducedMotion === "reduce" ? "-reduced-motion" : "";
    // 한 장: 위성이 아래쪽에 있는 순간.
    await freezeAt(page, 1100);
    const still = join(OUT_DIR, `oort-loader-web-first-load${tag}-${scheme}.png`);
    await page.screenshot({ path: still });
    shots.push(still);
    if (reducedMotion === "no-preference") {
      const hero = await loaderBox(page, "hero");
      const pad = 24;
      const gif = join(OUT_DIR, `oort-loader-web-first-load-${scheme}.gif`);
      await recordGif(page, {
        clip: { x: hero.x - pad, y: hero.y - pad, width: hero.width + pad * 2, height: hero.height + pad * 2 + 40 },
        frames: 36,
        from: 600, // 나타나기가 끝난 뒤부터 한 주기
        scale: 1,
        out: gif,
        workDir: join(OUT_DIR, `.frames-hero-${scheme}`),
      });
      gifs.push(gif);
    }
    gate.holdRefresh = false;
    await context.close();
  }
}

async function main() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    throw new Error(`${DIST_DIR}/index.html 이 없다. 먼저 빌드한다.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", DIST_DIR],
  });
  const browser = await chromium.launch();
  const shots = [];
  const gifs = [];
  try {
    for (const scheme of SCHEMES) await captureScheme(browser, scheme, shots, gifs);
  } finally {
    await browser.close();
    await preview.stop();
  }
  console.log(["shots:", ...shots, "gifs:", ...gifs].join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
