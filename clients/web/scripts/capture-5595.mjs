#!/usr/bin/env node
// =============================================================================
// 웹·데스크탑 작업 멈추기가 kill 라우트로 (#5595, ADR-0188 D3): 작업 콘솔의 세션 상세에서 「멈추기」 단추, 확인 단계,
// 맥이 꺼져 있을 때의 한 줄(「맥이 켜지면 멈춰요」)을 번들 Chromium 헤드리스로 라이트·다크로 찍고, **서버로 나간 요청**을 잰다.
//
//   npm run build && node scripts/capture-5595.mjs --out <스크래치>/cap5595
//
// 모의 `/v1`(gates/connection-harness.mjs, 시크릿 없음, 인물은 전부 가상). 정적 서버는 `startGuardedPreview`가 띄우고 자기 PID 로만 끈다.
// 단정: 단추 이름이 「멈추기」인가, 확인을 누르면 `POST …/work-sessions/{id}/kill`이 한 번 나가고 `PATCH …/work-sessions/{id}`는
// 나가지 않는가, 맥이 꺼져 있다는 답에 코어 문장이 서는가.
//
// 옵션: --out(기본 captures/5595) --port(기본 5595) --soft(실패해도 끝까지 돌고 종료 코드 0)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// `runtime-unverified`: 실제 Tauri 셸, WebKit, 실제 맥(workd)이 멈추는 것.
// =============================================================================
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CHANNELS, ME, WORKSPACE_ID, installBackend, signIn } from "../gates/connection-harness.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { withCaptureLocale } from "./capture-locale.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const OUT = resolve(WEB_ROOT, String(arg("out", "captures/5595")));
const PORT = Number(arg("port", 5595));
const SOFT = arg("soft", false) === true;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

const results = [];
let scope = "";
function check(id, ok, detail = "") {
  results.push({ scope, id, ok: Boolean(ok), detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}${detail === "" ? "" : `  (${String(detail).slice(0, 200)})`}`);
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOW = Date.now();
const SESSION_ID = "019f9a10-0000-7000-8000-0000000000a1";
const WORK_HOST = {
  id: "00000000-0000-7000-8000-000000000302",
  workspaceId: WORKSPACE_ID,
  scope: "member",
  ownerMemberId: ME,
  type: "app",
  displayName: "곽성재의 MacBook Pro",
  capabilities: { terminal: true },
  lastSeenAtMs: NOW,
  createdAtMs: NOW - 60_000,
  online: true,
};
const SESSION = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  channelId: CHANNELS[0].id,
  memberId: ME,
  hostId: WORK_HOST.id,
  rootMessageId: "019f9a10-0000-7000-8000-0000000000b1",
  tool: "claude",
  label: "온보딩 문구 다듬기",
  status: "running",
  observation: "open",
  observerGrantCount: 0,
  remoteAttachAvailable: false,
  remoteDisplayAvailable: false,
  startedAtMs: NOW - 12 * 60_000,
  origin: "host",
};

async function installWork(context, calls) {
  await context.route("**/v1/workspaces/*/work-sessions", (route) => json(route, { workSessions: [SESSION] }));
  await context.route("**/v1/workspaces/*/work-hosts", (route) => json(route, { workHosts: [WORK_HOST] }));
  await context.route("**/v1/workspaces/*/work-sessions/*/kill", (route) => {
    calls.kill += 1;
    // 맥이 꺼져 있다: 컨트롤은 기다리고, 맥이 켜지면 멈춘다(work_kill.rs 「Offline Mac」).
    return json(route, { workControl: null, sessionStatus: "running", hostOnline: false, replayed: false }, 201);
  });
  await context.route(`**/v1/workspaces/*/work-sessions/${SESSION_ID}`, (route) => {
    if (route.request().method() === "PATCH") calls.patch += 1;
    return json(route, { workSession: { ...SESSION, status: "ended" } });
  });
}

async function shot(page, name) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  console.log(`  shot: ${path}`);
  return path;
}

async function scene(browser, scheme) {
  scope = scheme;
  console.log(`\n== 세션 상세의 멈추기 (${scheme}) ==`);
  const context = await browser.newContext(
    withCaptureLocale({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce", timezoneId: "Asia/Seoul" })
  );
  const calls = { kill: 0, patch: 0 };
  await installBackend(context, PORT);
  await installWork(context, calls);
  try {
    const page = await context.newPage();
    await signIn(page, ORIGIN);
    await page.evaluate((id) => {
      window.location.hash = `#/work?view=console&session=${id}`;
    }, SESSION_ID);
    const stop = page.getByTestId("work-end-session");
    await stop.waitFor({ state: "visible", timeout: 20_000 });
    check("단추 이름이 「멈추기」다", ((await stop.textContent()) ?? "").trim() === "멈추기", await stop.textContent());
    check("단추가 눌린다(내 맥의 내 세션)", await stop.isEnabled());
    await shot(page, `1-stop-idle-${scheme}`);

    await stop.click();
    const warning = page.getByTestId("work-end-warning");
    await warning.waitFor({ state: "visible" });
    check(
      "확인 문장은 코어 문장이다",
      (await warning.textContent()) === "이 작업을 멈출까요? 맥에서 돌고 있는 작업을 끝내요. 지금까지의 진행 내역은 남아요.",
      await warning.textContent()
    );
    await shot(page, `2-stop-confirm-${scheme}`);

    await page.getByTestId("work-end-commit").click();
    const line = page.getByTestId("work-stop-requested");
    await line.waitFor({ state: "visible", timeout: 10_000 });
    check("맥이 꺼져 있으면 「맥이 켜지면 멈춰요」다", (await line.textContent()) === "맥이 꺼져 있어요. 맥이 켜지면 멈춰요.", await line.textContent());
    check("kill 라우트가 한 번 나갔고 PATCH ended는 나가지 않았다", calls.kill === 1 && calls.patch === 0, JSON.stringify(calls));
    check("요청 뒤 단추는 잠긴다", await page.getByTestId("work-end-session").isDisabled());
    await shot(page, `3-stop-offline-${scheme}`);
  } finally {
    await context.close();
  }
}

mkdirSync(OUT, { recursive: true });
const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"]) await scene(browser, scheme);
} finally {
  await browser.close();
  await preview.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0 && !SOFT) process.exit(1);
