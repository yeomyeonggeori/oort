#!/usr/bin/env node
// 연결 카드·띠 캡처 (#5220, #5201 S-B). 실제 번들(dist) + 가짜 /v1 + 가짜 실시간 서버(gates/connection-harness.mjs).
//
//   npm run build && OUT_DIR=/path node scripts/capture-5220.mjs
//
// 폭마다(720·1100·1440) 라이트·다크로 같은 장면을 찍는다:
//   연결 중 · 끊김(실시간만) · 오프라인 · 서버에 닿지 못함 · 복구(2초) — 사이드바 아래 연결 카드
//   띠 — 목록 열을 접은(⌘B) 끊김과 오프라인. 폰 폭(480, 서랍)은 한 번 더.
// 720은 목록 열이 아직 보이는 폭이다(폰 폭 문턱은 600): 그 폭에서 띠가 서는 것은 접었을 때뿐이라 띠 장면은
// 폭마다 접어서 찍고, 폰 폭 장면이 서랍 쪽을 맡는다.
//
// 「끊김」을 찍으려면 10초를 채워야 한다(모델의 문턱). 짧게 줄이는 손잡이는 일부러 두지 않았다.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import {
  CHANNELS,
  GENERAL_ID,
  installBackend,
  openGeneral,
  pageSocketStatus,
  signIn,
  sleep,
} from "../gates/connection-harness.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5232);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WIDTHS = (process.env.CAPTURE_WIDTHS || "720,1100,1440").split(",").map(Number);
const SCHEMES = (process.env.CAPTURE_SCHEMES || "light,dark").split(",");
const TOGGLE_LIST = `${process.platform === "darwin" ? "Meta" : "Control"}+b`;

const card = (page) => page.getByTestId("connection-card");
const banner = (page) => page.getByTestId("connection-banner");

async function waitFor(read, label, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await read()) return;
    if (Date.now() - started > timeout) throw new Error(`시간 안에 ${label}가 오지 않았다`);
    await sleep(50);
  }
}

const waitTone = (page, tone, timeout) =>
  waitFor(async () => (await card(page).count()) > 0 && (await card(page).getAttribute("data-tone")) === tone, `카드 ${tone}`, timeout);

/** 사이드바 열의 아래쪽(카드 + 프로필 줄)을 잘라 찍는다. */
async function shootCardCrop(page, path) {
  const pane = await page.getByTestId("sidebar-channel-pane").boundingBox();
  if (!pane) return;
  const height = Math.min(220, pane.height);
  await page.screenshot({ path, clip: { x: pane.x, y: pane.y + pane.height - height, width: pane.width, height } });
}

async function captureWidth(browser, scheme, width, shots) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
    // 문장은 사전에서 오고 기기 언어를 따른다. 이 앱의 첫 언어(ko-KR)로 찍는다.
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const backend = await installBackend(context, PORT);
  const page = await context.newPage();
  const tag = `${scheme}-w${width}`;
  const shoot = async (name, { crop = true } = {}) => {
    const full = join(OUT_DIR, `cap5220-${name}-${tag}.png`);
    await page.screenshot({ path: full });
    shots.push(full);
    if (crop && (await card(page).count()) > 0) {
      const small = join(OUT_DIR, `cap5220-${name}-crop-${tag}.png`);
      await shootCardCrop(page, small);
      shots.push(small);
    }
  };
  try {
    await signIn(page, ORIGIN);
    await openGeneral(page);
    await waitFor(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);

    // 연결 중(1~10초) → 끊김(10초~, 실시간만)
    backend.socket("refuse");
    backend.dropSockets();
    await waitTone(page, "connecting", 5_000);
    await shoot("1-connecting");
    await waitTone(page, "down", 14_000);
    await shoot("2-down");

    // 띠: 같은 「끊김」을 목록 열을 접어서(⌘B)
    await page.keyboard.press(TOGGLE_LIST);
    await waitFor(async () => (await banner(page).count()) === 1, "접힌 목록 열의 띠");
    await shoot("6-strip-down", { crop: false });
    await page.keyboard.press(TOGGLE_LIST);
    await waitFor(async () => (await card(page).count()) === 1, "펼친 목록 열의 카드");

    // 복구(2초): 다시 붙으면 확인 표시
    backend.socket("ok");
    await page.getByTestId("connection-card-action").click();
    await waitTone(page, "recovered", 15_000);
    await shoot("5-recovered");
    await waitFor(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", 5_000);

    // 오프라인(즉시)
    await context.setOffline(true);
    await waitTone(page, "offline", 4_000);
    await shoot("3-offline");
    await page.keyboard.press(TOGGLE_LIST);
    await waitFor(async () => (await banner(page).count()) === 1, "접힌 목록 열의 띠");
    await shoot("7-strip-offline", { crop: false });
    await page.keyboard.press(TOGGLE_LIST);
    await context.setOffline(false);
    await waitFor(async () => (await card(page).count()) === 0 || (await card(page).getAttribute("data-tone")) === "recovered", "오프라인 해제", 25_000);
    await waitFor(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", 8_000);

    // 서버에 닿지 못함(서로 다른 요청 3건)
    backend.rest("503");
    for (const channel of CHANNELS.slice(1)) {
      await page.locator(`[data-channel-id="${channel.id}"]`).first().click();
      await sleep(250);
    }
    await waitTone(page, "unreachable", 8_000);
    await shoot("4-unreachable");
    backend.rest("ok");
    await page.locator(`[data-channel-id="${GENERAL_ID}"]`).first().click();
  } finally {
    await context.close();
  }
}

/** 폰 폭(서랍): 사이드바는 서랍이라 카드가 아니라 띠가 말한다. */
async function captureDrawer(browser, scheme, shots) {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
    hasTouch: true,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await installBackend(context, PORT);
  const page = await context.newPage();
  try {
    await signIn(page, ORIGIN, { testId: "sidebar", state: "attached" });
    await context.setOffline(true);
    await waitFor(async () => (await banner(page).count()) === 1, "폰 폭의 띠", 6_000);
    const path = join(OUT_DIR, `cap5220-8-strip-drawer-${scheme}-w480.png`);
    await page.screenshot({ path });
    shots.push(path);
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const shots = [];
  try {
    const browser = await chromium.launch();
    try {
      for (const scheme of SCHEMES) {
        for (const width of WIDTHS) {
          console.log(`… ${scheme} ${width}`);
          await captureWidth(browser, scheme, width, shots);
        }
        await captureDrawer(browser, scheme, shots);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(`${shots.length}장 → ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
