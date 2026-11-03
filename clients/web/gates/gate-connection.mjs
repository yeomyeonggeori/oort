// 연결 상태 화면 게이트 (#5220, #5201 S-B). 실제 번들 + 가짜 /v1 + 가짜 실시간 서버, 실제 Chromium.
//
//   npm run build && node gates/gate-connection.mjs        (CONNECTION_GATE_PORT 로 포트를 옮긴다)
//
// 이 게이트가 지키는 것(감사 문서 §8의 화면 몫):
//   A 실시간만 끊김: 1초 안은 침묵, 1초부터 「연결 중」(단추 없음), 10초부터 「끊김」(단추 있음) — 그리고
//     그 내내 보내기와 승인이 **열려 있다**(결정 ③). 다시 연결을 누르면 붙고 2초 「다시 연결됐어요」.
//   B 기기 오프라인: 즉시 「오프라인」(단추 없음, 마크 정지), 보내기가 막히고 초안은 남는다.
//   C 서버에 닿지 못함: 서로 다른 요청 3건이 실패하면 카드(단추 있음), 보내기가 막힌다. 응답 한 건에 풀린다.
//   D 한 자리에서만: 목록 열이 보이면 카드(띠 없음), ⌘B로 접으면 띠(카드 없음), 폰 폭에서도 띠.
//
// 번들은 `clients/web/dist`다. 다른 워크트리가 같은 포트를 쥐고 있으면 가드가 요란하게 죽는다.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import {
  CHANNELS,
  GENERAL_ID,
  installBackend,
  openGeneral,
  pageSocketStatus,
  signIn,
  sleep,
} from "./connection-harness.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CONNECTION_GATE_PORT || 5231);
const origin = `http://127.0.0.1:${port}`;

const results = [];
/** 목록 열 접기(⌘B / Ctrl+B)의 수식 키는 브라우저가 알리는 플랫폼을 따른다(Playwright는 실행 호스트 그대로다). */
const TOGGLE_LIST = `${process.platform === "darwin" ? "Meta" : "Control"}+b`;

function check(condition, message) {
  if (!condition) throw new Error(`GATE FAIL: ${message}`);
}

async function until(read, label, { timeout = 15_000, interval = 50 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value) return { value, at: Date.now() };
    if (Date.now() - started > timeout) throw new Error(`GATE FAIL: 시간 안에 ${label}가 오지 않았다 (${timeout}ms)`);
    await sleep(interval);
  }
}

const card = (page) => page.getByTestId("connection-card");
const banner = (page) => page.getByTestId("connection-banner");
const tone = async (page) => (await card(page).count()) > 0 ? await card(page).getAttribute("data-tone") : null;
const waitTone = (page, expected, timeout) =>
  until(async () => (await tone(page)) === expected, `카드 ${expected}`, { timeout });

async function fresh(browser, viewport = { width: 1440, height: 900 }) {
  // 문장은 기기 언어를 따른다. 이 앱의 첫 언어(ko-KR)로 돌린다(단정은 testid·data 표지로 하므로 문장은 가리지 않는다).
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "ko-KR" });
  const backend = await installBackend(context, port);
  const page = await context.newPage();
  await signIn(page, origin);
  await openGeneral(page);
  return { context, backend, page };
}

/** 컴포저에 글을 쓰고 보낸다. 보냈는지는 가짜 서버가 받은 POST 수로 본다. */
async function trySend(page, backend, text) {
  const before = backend.state.sends.length;
  const input = page.getByTestId("composer-input");
  await input.fill(text);
  await input.press("Enter");
  // 막혔으면 나가지 않는다: 요청이 오갈 시간을 준 뒤에 센다.
  await sleep(900);
  return backend.state.sends.length - before;
}

async function scenarioRealtimeOnly(browser) {
  const { context, backend, page } = await fresh(browser);
  try {
    await until(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000); // 붙은 지 5초가 지나야 첫 틈이 풀린다
    check((await card(page).count()) === 0, "정상일 때 카드가 서 있다(건강은 침묵)");

    backend.socket("refuse");
    backend.dropSockets();
    const { at: dropped } = await until(async () => (await pageSocketStatus(page)) === "disconnected", "소켓 끊김");
    check((await card(page).count()) === 0, "끊긴 직후(1초 안)에 카드가 선다");

    const connecting = await waitTone(page, "connecting", 4_000);
    const connectingMs = connecting.at - dropped;
    check(connectingMs >= 700 && connectingMs <= 3_500, `「연결 중」이 ${connectingMs}ms에 섰다(1초 근처여야 한다)`);
    check((await page.getByTestId("connection-card-action").count()) === 0, "「연결 중」에 단추가 있다");
    check((await banner(page).count()) === 0, "카드가 있는데 띠도 서 있다");

    // 10초 경계: 9초 시점에도 아직 「연결 중」이다.
    await sleep(Math.max(0, dropped + 8_800 - Date.now()));
    check((await tone(page)) === "connecting", "9초 안에 「끊김」이 섰다");
    const down = await waitTone(page, "down", 5_000);
    const downMs = down.at - dropped;
    check(downMs >= 9_000 && downMs <= 13_500, `「끊김」이 ${downMs}ms에 섰다(10초 근처여야 한다)`);
    check((await page.getByTestId("connection-card-action").count()) === 1, "「끊김」에 「지금 다시 연결」이 없다");
    check((await card(page).getAttribute("data-cause")) === "realtimeDown", "원인이 실시간만 끊김이 아니다");

    // 결정 ③: 실시간만 끊겼으면 보내기가 열려 있다.
    check((await page.getByTestId("composer-offline").count()) === 0, "실시간만 끊겼는데 컴포저가 오프라인 줄을 말한다");
    const sent = await trySend(page, backend, "실시간이 끊겨도 보내져야 해요");
    check(sent === 1, `실시간만 끊긴 채 보낸 글이 ${sent}건 나갔다(1건이어야 한다)`);

    // 결정 ③: 승인도 열려 있다.
    const approve = page.getByTestId("approval-approve");
    check((await approve.count()) >= 1, "승인 카드의 「승인」 단추가 없다(실시간만 끊겼을 때 열려 있어야 한다)");
    check((await approve.first().getAttribute("aria-disabled")) !== "true", "승인 단추가 잠겨 있다");

    // 다시 연결: 누르면 「연결 중」, 붙으면 2초 「다시 연결됐어요」, 그리고 사라진다.
    backend.socket("ok");
    const handshakes = backend.state.handshakes;
    await page.getByTestId("connection-card-action").click();
    // 가짜 서버가 곧바로 받아 주므로 「연결 중」은 한두 프레임이다(그 장면은 단위 시험이 잰다). 여기서는 결과를 본다.
    const recovered = await waitTone(page, "recovered", 15_000);
    check((await card(page).locator('[data-connection-mark="check"]').count()) === 1, "복구 표시에 확인 마크가 없다");
    await until(async () => (await card(page).count()) === 0, "복구 표시가 사라짐", { timeout: 4_000 });
    check(Date.now() - recovered.at >= 1_500, "복구 표시가 2초를 못 채우고 사라졌다");
    check(backend.state.handshakes > handshakes, "누른 뒤 실시간 연결을 다시 열지 않았다");
    results.push(`A 실시간만 끊김: 「연결 중」 ${connectingMs}ms · 「끊김」 ${downMs}ms · 보내기 열림 · 승인 열림 · 복구 2초`);
  } finally {
    await context.close();
  }
}

async function scenarioDeviceOffline(browser) {
  const { context, backend, page } = await fresh(browser);
  try {
    await until(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);
    await context.setOffline(true);
    await waitTone(page, "offline", 3_000);
    check((await page.getByTestId("connection-card-action").count()) === 0, "오프라인 카드에 단추가 있다");
    check(
      (await card(page).locator("[data-oort-loader]").getAttribute("data-motion")) === "still",
      "오프라인인데 마크가 돈다"
    );
    const sent = await trySend(page, backend, "오프라인에서는 나가면 안 돼요");
    check(sent === 0, `기기 오프라인인데 글이 ${sent}건 나갔다`);
    check((await page.getByTestId("composer-offline").count()) === 1, "막힌 컴포저가 이유 줄을 말하지 않는다");
    check(
      (await page.getByTestId("composer-input").inputValue()).includes("오프라인에서는"),
      "막힌 동안 쓰던 글(초안)이 사라졌다"
    );
    await context.setOffline(false);
    await until(async () => (await tone(page)) !== "offline", "오프라인 카드가 내려감", { timeout: 20_000 });
    await until(async () => (await page.getByTestId("composer-offline").count()) === 0, "컴포저가 다시 열림");
    const again = await trySend(page, backend, "다시 연결됐으니 나가요");
    check(again === 1, `돌아온 뒤 글이 ${again}건 나갔다(1건이어야 한다)`);
    results.push("B 기기 오프라인: 즉시 「오프라인」 · 마크 정지 · 단추 없음 · 보내기 막힘 · 초안 유지 · 돌아오면 열림");
  } finally {
    await context.close();
  }
}

async function scenarioServerUnreachable(browser) {
  const { context, backend, page } = await fresh(browser);
  try {
    await until(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);
    backend.rest("503");
    // 채널마다 읽기 요청의 주소가 다르다: 서로 다른 요청 3건이 연달아 닿지 못해야 선언이 선다.
    for (const channel of CHANNELS.slice(1)) {
      await page.locator(`[data-channel-id="${channel.id}"]`).first().click();
      await sleep(250);
    }
    await waitTone(page, "unreachable", 6_000);
    check((await page.getByTestId("connection-card-action").count()) === 1, "서버에 닿지 못함 카드에 단추가 없다");
    const sent = await trySend(page, backend, "서버가 안 닿으면 나가면 안 돼요");
    check(sent === 0, `서버에 닿지 못하는데 글이 ${sent}건 나갔다`);
    check((await page.getByTestId("composer-offline").count()) === 1, "막힌 컴포저가 이유 줄을 말하지 않는다");

    backend.rest("ok");
    await page.locator(`[data-channel-id="${GENERAL_ID}"]`).first().click(); // 응답 한 건이 풀어 준다
    await until(async () => (await tone(page)) !== "unreachable", "서버에 닿지 못함 카드가 내려감", { timeout: 8_000 });
    await until(async () => (await page.getByTestId("composer-offline").count()) === 0, "컴포저가 다시 열림");
    const again = await trySend(page, backend, "서버가 돌아왔어요");
    check(again === 1, `돌아온 뒤 글이 ${again}건 나갔다(1건이어야 한다)`);
    results.push("C 서버에 닿지 못함: 서로 다른 요청 3건 → 카드 · 단추 있음 · 보내기 막힘 · 응답 한 건에 풀림");
  } finally {
    await context.close();
  }
}

async function scenarioPlacement(browser) {
  const { context, page } = await fresh(browser);
  try {
    await until(async () => (await pageSocketStatus(page)) === "connected", "소켓 연결");
    await sleep(6_000);
    await context.setOffline(true); // 기다림 없이 서는 상태로 자리만 본다
    await waitTone(page, "offline", 3_000);
    check((await banner(page).count()) === 0, "넓은 창에서 카드와 띠가 함께 선다");

    await page.keyboard.press(TOGGLE_LIST); // 목록 열 접기
    await until(async () => (await banner(page).count()) === 1, "목록 열이 접혔는데 띠가 서지 않음", { timeout: 4_000 });
    check((await card(page).count()) === 0, "목록 열이 접혔는데 카드가 남아 있다");
    check(
      (await banner(page).evaluate((node) => node.closest("main") !== null)),
      "띠가 본문(main) 안에 서지 않는다"
    );
    await page.keyboard.press(TOGGLE_LIST); // 다시 펴기
    await until(async () => (await card(page).count()) === 1, "목록 열을 폈는데 카드가 돌아오지 않음", { timeout: 4_000 });
    check((await banner(page).count()) === 0, "목록 열을 폈는데 띠가 남아 있다");

    await page.setViewportSize({ width: 480, height: 800 }); // 폰 폭: 사이드바는 서랍이다
    await until(async () => (await banner(page).count()) === 1, "폰 폭에서 띠가 서지 않음", { timeout: 4_000 });
    check((await card(page).count()) === 0, "폰 폭 서랍 밖에 카드가 서 있다");
    results.push("D 한 자리에서만: 넓은 창=카드 · 목록 열 접힘(⌘B)=띠 · 폰 폭=띠, 둘이 함께 서지 않음");
  } finally {
    await context.close();
  }
}

async function main() {
  // 사보타주(고의로 깬 소스를 따로 빌드한 번들)는 `CONNECTION_GATE_DIST`로 그 번들을 가리킨다. 기본은 `dist`다.
  const dist = process.env.CONNECTION_GATE_DIST;
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "CONNECTION_GATE_PORT",
    ...(dist ? { extraArgs: ["--outDir", resolve(dist)] } : {}),
  });
  try {
    const browser = await chromium.launch();
    try {
      await scenarioRealtimeOnly(browser);
      await scenarioDeviceOffline(browser);
      await scenarioServerUnreachable(browser);
      await scenarioPlacement(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  for (const line of results) console.log(`GATE PASS: ${line}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
