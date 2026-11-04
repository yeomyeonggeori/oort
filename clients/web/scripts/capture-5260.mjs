#!/usr/bin/env node
// 막힌 자리의 문장이 원인을 말하는 모습 캡처 (#5260, #5239 후속). 실제 번들(dist) + 가짜 /v1 + 가짜 실시간 서버
// (gates/connection-harness.mjs, #5220·#5239와 같은 하네스).
//
//   npm run build && OUT_DIR=/path node scripts/capture-5260.mjs
//
// 1440 라이트·다크로 대표 세 자리를 원인마다 찍는다. 찍으면서 문장도 단정한다(캡처가 곧 실행 증거다):
//
//   설정 위쪽 띠        `settings-offline-banner`   「오프라인이에요. 저장은 …」 / 「서버에 닿지 못했어요. 저장은 …」
//   설정 › 워크스페이스  `workspace-card`의 잠금 사유  (불러와지면) 「오프라인이라 지금은 …」 / 「서버에 닿지 못해 지금은 …」
//   받은함 띠           `inbox-offline`             「오프라인이에요. …」 / 「서버에 닿지 못했어요. …」
//
// 문장은 한국어 사전(blocked.json)에서 읽는다: 손으로 적으면 이 캡처가 문장이 고쳐지는 것을 막는 쪽이 된다.
// 컨텍스트 언어는 `withCaptureLocale`(기본 ko-KR)이다.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { CHANNELS, installBackend, openGeneral, pageSocketStatus, signIn, sleep } from "../gates/connection-harness.mjs";
import { withCaptureLocale } from "./capture-locale.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5260);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SCHEMES = (process.env.CAPTURE_SCHEMES || "light,dark").split(",");

const BLOCKED = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "../../packages/momo-core/src/i18n/catalogs/ko-KR/blocked.json"), "utf8")
);
const line = (key) => {
  const text = BLOCKED[key];
  if (typeof text !== "string") throw new Error(`한국어 사전에 ${key}가 없다`);
  return text;
};
const normalized = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/g, " ").trim();
const card = (page) => page.getByTestId("connection-card");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(read, label, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await read()) return;
    if (Date.now() - started > timeout) throw new Error(`시간 안에 ${label}가 오지 않았다`);
    await sleep(50);
  }
}

/** 화면을 사람이 하듯 옮긴다(사이드바 목적지·프로필 메뉴): 주소만 바꾸면 라우터가 알지 못한다. 세션과 연결 모델의 입력이 그대로 이어진다. */
async function go(page, path) {
  if (path === "/inbox") {
    await page.getByTestId("nav-inbox").click();
  } else if (path === "/settings") {
    await page.getByTestId("profile-card").click();
    await page.getByTestId("nav-settings").click();
  } else if (path === "/") {
    await openGeneral(page);
  } else {
    throw new Error(`옮길 줄 모르는 화면: ${path}`);
  }
}

/** 설정은 사이드바를 걷는 화면이다: 뒤로 가서 사이드바가 돌아오기를 기다린다. */
async function backFromSettings(page) {
  await page.goBack();
  await page.getByTestId("nav-inbox").waitFor({ state: "visible", timeout: 10_000 });
}

async function shoot(page, scheme, name, shots, crop) {
  const base = join(OUT_DIR, `cap5260-${name}-${scheme}-w1440`);
  await page.screenshot({ path: `${base}.png` });
  shots.push(`${base}.png`);
  if (crop && (await crop.count()) > 0) {
    await crop.first().screenshot({ path: `${base}-crop.png` });
    shots.push(`${base}-crop.png`);
  }
}

/** 한 원인에서 세 자리를 돈다. `head`는 그 원인의 띠가 시작해야 하는 말이다. */
async function visit(page, scheme, scene, head, shots) {
  const forbidden = scene === "unreachable" ? "오프라인" : null;

  await go(page, "/settings");
  const banner = page.getByTestId("settings-offline-banner");
  await banner.waitFor({ state: "visible", timeout: 10_000 });
  const settingsLine = await normalized(banner);
  expect(
    settingsLine === line(`blocked.saveAfterReconnect.${scene === "offline" ? "offline" : "serverUnreachable"}`),
    `${scene}: 설정 띠가 원인의 문장이 아니다 (${settingsLine})`
  );
  if (forbidden) expect(!settingsLine.includes(forbidden), `${scene}: 설정 띠가 「오프라인」이라 말한다`);
  await shoot(page, scheme, `${scene}-1-settings`, shots, banner);

  // 워크스페이스 카드는 가짜 서버가 답할 때만 선다(없으면 이 장면은 전체 화면만 남긴다).
  const workspace = page.getByTestId("workspace-card");
  if ((await workspace.count()) > 0) {
    const text = await normalized(workspace);
    const tail = scene === "offline" ? "오프라인이라 지금은" : "서버에 닿지 못해 지금은";
    expect(!text.includes("연결이 끊"), `${scene}: 워크스페이스 카드에 옛 문장이 남았다`);
    if (text.includes("지금은")) expect(text.includes(tail), `${scene}: 워크스페이스 카드의 사유가 원인과 다르다`);
    await shoot(page, scheme, `${scene}-2-workspace`, shots, workspace);
  } else {
    console.log(`  (${scene}: 워크스페이스 카드가 가짜 서버에서 서지 않아 전체 화면만 남긴다)`);
    await shoot(page, scheme, `${scene}-2-workspace`, shots);
  }

  await backFromSettings(page);
  await go(page, "/inbox");
  const inbox = page.getByTestId("inbox-offline");
  await inbox.waitFor({ state: "visible", timeout: 10_000 });
  const inboxLine = await normalized(inbox);
  expect(inboxLine.startsWith(head), `${scene}: 받은함 띠가 「${head}」로 시작하지 않는다 (${inboxLine})`);
  if (forbidden) expect(!inboxLine.includes(forbidden), `${scene}: 받은함 띠가 「오프라인」이라 말한다`);
  await shoot(page, scheme, `${scene}-3-inbox`, shots, inbox);
}

async function captureScheme(browser, scheme, shots) {
  const context = await browser.newContext(
    withCaptureLocale({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
      timezoneId: "Asia/Seoul",
    })
  );
  const backend = await installBackend(context, PORT);
  const page = await context.newPage();
  try {
    await signIn(page, ORIGIN);
    await openGeneral(page);
    await waitFor(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);

    // 화면 덩어리를 미리 받아 둔다: 기기 오프라인에서는 아직 안 받은 화면의 덩어리를 가져올 수 없어 화면이 서지 못한다.
    await go(page, "/settings");
    await sleep(2_000);
    await backFromSettings(page);
    await go(page, "/inbox");
    await sleep(2_000);
    await openGeneral(page);
    await waitFor(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");

    // 1. 기기 오프라인(즉시)
    await context.setOffline(true);
    await waitFor(async () => (await card(page).count()) > 0 && (await card(page).getAttribute("data-tone")) === "offline", "기기 오프라인", 4_000);
    await visit(page, scheme, "offline", "오프라인이에요.", shots);
    await go(page, "/");
    await context.setOffline(false);
    await waitFor(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", 30_000);

    // 2. 서버에 닿지 못함: 서로 다른 요청 셋이 연달아 닿지 못했다.
    await openGeneral(page);
    backend.rest("503");
    for (const channel of CHANNELS.slice(1)) {
      await page.locator(`[data-channel-id="${channel.id}"]`).first().click();
      await sleep(250);
    }
    await waitFor(
      async () => (await card(page).count()) > 0 && (await card(page).getAttribute("data-cause")) === "serverUnreachable",
      "서버에 닿지 못함",
      8_000
    );
    await visit(page, scheme, "unreachable", "서버에 닿지 못했어요.", shots);
    backend.rest("ok");
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
        console.log(`… ${scheme}`);
        await captureScheme(browser, scheme, shots);
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
