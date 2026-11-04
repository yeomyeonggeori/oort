#!/usr/bin/env node
// 입력창·승인 줄의 막힘 문장 캡처 (#5239, #5201 S-B 후속). 실제 번들(dist) + 가짜 /v1 + 가짜 실시간 서버
// (gates/connection-harness.mjs, #5220과 같은 하네스).
//
//   npm run build && OUT_DIR=/path node scripts/capture-5239.mjs
//   DIST_DIR=<다른 dist> OUT_DIR=/path node scripts/capture-5239.mjs   # 고치기 전 번들로 RED 를 다시 볼 때(#5294)
//
// 1440 라이트·다크로 같은 화면(대화 + 내가 결정할 승인 카드 + 쓰던 글이 든 입력창)을 원인마다 찍는다. 찍으면서
// 두 줄이 무엇을 말하는지도 단정한다(캡처가 곧 실행 증거다):
//
//   1-offline        기기 오프라인        입력창 줄 「오프라인이라 …」, 승인 줄 「오프라인이라 …」
//   2-unreachable    서버에 닿지 못함     입력창 줄 「서버에 닿지 못해 …」. 승인 카드가 화면에 있으면 승인 줄도
//                                         「서버에 닿지 못해 …」(읽기가 모두 실패하는 동안 채널을 옮겨 다녀야 선언이 서므로
//                                         타임라인이 불러오기 실패 상자일 수 있다. 승인 줄은 렌더 시험이 원인마다 잰다)
//   3-unknown        알 수 없음           줄이 서지 않는다. 보내기와 승인 단추가 열려 있다
//   4-realtime-down  실시간만 끊김        줄이 서지 않는다. 보내기와 승인 단추가 열려 있다
//
// 「알 수 없음」은 실시간이 10초 넘게 끊긴 채 응답 없는 요청이 한두 건뿐일 때다: 보내기 한 번만 코드 없는 503으로 만든다
// (읽기까지 막으면 서로 다른 요청 3건이 차서 「서버에 닿지 못함」이 된다). 그 보내기는 실패 행으로 남는다.
// 「끊김」을 찍으려면 10초를 채워야 한다(모델의 문턱). 짧게 줄이는 손잡이는 일부러 두지 않았다.
// 문장은 한국어 사전(connection.json)에서 읽는다: 손으로 적으면 이 캡처가 문장이 고쳐지는 것을 막는 쪽이 된다.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import {
  CHANNELS,
  installBackend,
  openGeneral,
  pageSocketStatus,
  signIn,
  sleep,
} from "../gates/connection-harness.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5239);
const DIST_DIR = process.env.DIST_DIR || "";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SCHEMES = (process.env.CAPTURE_SCHEMES || "light,dark").split(",");
const DRAFT = "내일 배포 전에 확인할 목록을 정리해서 올릴게요.";

const KO = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "../../packages/momo-core/src/i18n/catalogs/ko-KR/connection.json"), "utf8")
);
const line = (key) => {
  const text = KO[key];
  if (typeof text !== "string") throw new Error(`한국어 사전에 ${key}가 없다`);
  return text;
};

const card = (page) => page.getByTestId("connection-card");
const composerLine = (page) => page.getByTestId("composer-offline");
const approvalLine = (page) => page.getByTestId("approval-note-offline");
const normalized = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/g, " ").trim();
/** 엔진이 **계산한** `word-break` — 한국어 문장이 어절에서 꺾이려면 `keep-all` 이다(`break-keep` 이 빠지면 `normal`, #5294). */
const wordBreakOf = (locator) => locator.evaluate((el) => getComputedStyle(el).wordBreak);

async function waitFor(read, label, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await read()) return;
    if (Date.now() - started > timeout) throw new Error(`시간 안에 ${label}가 오지 않았다`);
    await sleep(50);
  }
}

const waitCause = (page, cause, timeout) =>
  waitFor(
    async () => (await card(page).count()) > 0 && (await card(page).getAttribute("data-cause")) === cause,
    `카드 원인 ${cause}`,
    timeout
  );

const waitTone = (page, tone, timeout) =>
  waitFor(
    async () => (await card(page).count()) > 0 && (await card(page).getAttribute("data-tone")) === tone,
    `카드 ${tone}`,
    timeout
  );

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * 막힌 원인의 문장이 입력창 위 줄에 서 있고 보내기가 잠겨 있다. 승인 카드가 화면에 있으면 그 줄도 같은 원인을 말하고
 * 승인 단추가 없다(`requireCard`면 카드가 없을 때 실패한다).
 */
async function expectBlocked(page, composerKey, approvalKey, label, { requireCard = true } = {}) {
  expect((await composerLine(page).count()) === 1, `${label}: 입력창 위 줄이 없다`);
  expect((await normalized(composerLine(page))) === line(composerKey), `${label}: 입력창 줄이 ${composerKey}가 아니다`);
  expect((await wordBreakOf(composerLine(page))) === "keep-all", `${label}: 입력창 줄이 어절에서 꺾이지 않는다(word-break)`);
  expect(await page.getByTestId("composer-send").isDisabled(), `${label}: 보내기가 열려 있다`);
  const cardOnScreen = (await page.getByTestId("agent-card").count()) > 0;
  if (!cardOnScreen && !requireCard) {
    console.log(`  (${label}: 승인 카드가 화면에 없어 승인 줄은 단정하지 않는다)`);
    return;
  }
  expect((await approvalLine(page).count()) === 1, `${label}: 승인 줄이 없다`);
  expect((await normalized(approvalLine(page))) === line(approvalKey), `${label}: 승인 줄이 ${approvalKey}가 아니다`);
  expect((await wordBreakOf(approvalLine(page))) === "keep-all", `${label}: 승인 줄이 어절에서 꺾이지 않는다(word-break)`);
  expect((await page.getByTestId("approval-approve").count()) === 0, `${label}: 승인 단추가 남아 있다`);
}

/** 막지 않는 원인: 줄이 없고 보내기와 승인 단추가 열려 있다. */
async function expectOpen(page, label) {
  expect((await composerLine(page).count()) === 0, `${label}: 입력창에 막힘 줄이 섰다`);
  expect(!(await page.getByTestId("composer-send").isDisabled()), `${label}: 보내기가 잠겼다`);
  expect((await approvalLine(page).count()) === 0, `${label}: 승인 줄이 섰다`);
  expect((await page.getByTestId("approval-approve").count()) === 1, `${label}: 승인 단추가 없다`);
}

async function shoot(page, scheme, name, shots) {
  const base = join(OUT_DIR, `cap5239-${name}-${scheme}-w1440`);
  await page.screenshot({ path: `${base}.png` });
  shots.push(`${base}.png`);
  await page.getByTestId("composer").screenshot({ path: `${base}-crop-composer.png` });
  shots.push(`${base}-crop-composer.png`);
  const approval = page.getByTestId("agent-card").first();
  if ((await approval.count()) > 0) {
    await approval.screenshot({ path: `${base}-crop-card.png` });
    shots.push(`${base}-crop-card.png`);
  }
  if ((await card(page).count()) > 0) {
    const pane = await page.getByTestId("sidebar-channel-pane").boundingBox();
    if (pane) {
      const height = Math.min(220, pane.height);
      await page.screenshot({
        path: `${base}-crop-connection.png`,
        clip: { x: pane.x, y: pane.y + pane.height - height, width: pane.width, height },
      });
      shots.push(`${base}-crop-connection.png`);
    }
  }
}

async function captureScheme(browser, scheme, shots) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
    // 문장은 사전에서 오고 기기 언어를 따른다. 이 앱의 첫 언어(ko-KR)로 찍는다.
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const backend = await installBackend(context, PORT);
  // 보내기(POST)만 코드 없는 503으로 만드는 손잡이(「알 수 없음」 장면). 나중에 건 길이 먼저 맞으므로 꺼 두면 하네스로 넘긴다.
  let sendFails = false;
  await context.route("**/channels/*/messages", (route) =>
    sendFails && route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "service unavailable" } }),
        })
      : route.fallback()
  );
  const page = await context.newPage();
  try {
    await signIn(page, ORIGIN);
    await openGeneral(page);
    await waitFor(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);
    // 쓰던 글이 있어야 「쓰던 글은 그대로 있고」가 눈에 보인다.
    await page.getByTestId("composer-input").fill(DRAFT);
    await page.getByTestId("approval-approve").waitFor({ state: "visible" });

    // 1. 기기 오프라인(즉시)
    await context.setOffline(true);
    await waitTone(page, "offline", 4_000);
    await expectBlocked(page, "connection.composer.offline", "connection.approval.offline", "기기 오프라인");
    await shoot(page, scheme, "1-offline", shots);
    await context.setOffline(false);
    await waitFor(
      async () => (await card(page).count()) === 0 || (await card(page).getAttribute("data-tone")) === "recovered",
      "오프라인 해제",
      25_000
    );
    await waitFor(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", 8_000);
    expect((await page.getByTestId("composer-input").inputValue()) === DRAFT, "쓰던 글이 사라졌다");

    // 4. 실시간만 끊김(10초부터)
    backend.socket("refuse");
    backend.dropSockets();
    await waitCause(page, "realtimeDown", 16_000);
    await expectOpen(page, "실시간만 끊김");
    await shoot(page, scheme, "4-realtime-down", shots);

    // 3. 알 수 없음: 실시간이 이미 10초 넘게 끊긴 채 응답 없는 요청이 한 건(선언에는 모자라다). 막지 않으므로 보내기는 나가고,
    //    그 한 번이 닿지 못한 것이 「알 수 없음」의 근거다. 나간 글은 실패 행이 되고 입력창은 비므로 다시 채워 찍는다.
    sendFails = true;
    await page.getByTestId("composer-input").press("Enter");
    await waitCause(page, "unknown", 8_000);
    await page.getByTestId("composer-input").fill(DRAFT);
    await expectOpen(page, "알 수 없음");
    await shoot(page, scheme, "3-unknown", shots);
    sendFails = false; // 찍는 동안은 켜 둔다: 보내기가 한 번 더 닿으면 응답이 연속을 끊어 「알 수 없음」이 풀린다
    backend.socket("ok");
    await page.getByTestId("connection-card-action").click();
    await waitTone(page, "recovered", 15_000);
    await waitFor(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", 5_000);

    // 2. 서버에 닿지 못함: 서로 다른 요청 셋이 연달아 닿지 못했다.
    backend.rest("503");
    for (const channel of CHANNELS.slice(1)) {
      await page.locator(`[data-channel-id="${channel.id}"]`).first().click();
      await sleep(250);
    }
    await waitCause(page, "serverUnreachable", 8_000);
    await page.getByTestId("composer-input").waitFor({ state: "visible" });
    await sleep(500);
    await expectBlocked(page, "connection.composer.serverUnreachable", "connection.approval.serverUnreachable", "서버에 닿지 못함", {
      requireCard: false,
    });
    await shoot(page, scheme, "2-unreachable", shots);
    backend.rest("ok");
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    ...(DIST_DIR ? { extraArgs: ["--outDir", resolve(DIST_DIR)] } : {}),
  });
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
