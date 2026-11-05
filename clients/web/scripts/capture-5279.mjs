#!/usr/bin/env node
// =============================================================================
// 남은 「불러오지 못했어요」 자리 B·C와 소식 창의 「더 보기」 (#5279, #5242 후속): 작업 콘솔의 실패 상자, 호스트 목록 실패 한 줄, 표현 고르개의
// 팀 그림 실패 한 줄, 업데이트 소식 창의 「더 보기」를 번들 Chromium 헤드리스로 찍고 **화면의 문장과 서버로 나간 요청**을 잰다.
//
//   npm run build && node scripts/capture-5279.mjs --out <스크래치>/cap5279
//
// 모의 `/v1`(gates/connection-harness.mjs, 시크릿 없음, 인물은 전부 가상). 정적 서버는 `startGuardedPreview`가 띄우고 자기 PID 로만 끈다.
// 단정은 구현 이름이 아니라 화면의 문장을 잰다: 제목 + 원인 이유가 나오는가(서버에 닿지 못함: `route.abort`), 상태 코드가 한 글자도 없는가,
// 다시 시도가 그 자리의 읽기를 다시 부르는가(요청 수가 늘어나는가), 소식 창의 단추 이름이 「더 보기」인가.
//
// 옵션: --out(기본 captures/5279) --port(기본 5579) --soft(실패해도 끝까지 돌고 종료 코드 0)
// 캡처는 저장소에 올리지 않는다: --out 을 스크래치로 준다.
// `runtime-unverified`: 실제 Tauri 셸(소식 창은 셸 흉내), WebKit, 실제 네트워크 끊김(`route.abort`로 흉내), 폰.
// =============================================================================
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { ME, WORKSPACE_ID, installBackend, openGeneral, signIn, sleep } from "../gates/connection-harness.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { withCaptureLocale } from "./capture-locale.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

const OUT = resolve(WEB_ROOT, String(arg("out", "captures/5279")));
const PORT = Number(arg("port", 5579));
const SOFT = arg("soft", false) === true;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

// ---- 결과 장부 ---------------------------------------------------------------

const results = [];
let scope = "";
function check(id, ok, detail = "") {
  results.push({ scope, id, ok: Boolean(ok), detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}${detail === "" ? "" : `  (${String(detail).slice(0, 200)})`}`);
}
const hasStatusCode = (text) => /(^|[^\d])\d{3}([^\d]|$)/.test(text);

// ---- 모의 서버 ----------------------------------------------------------------

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NOW = Date.now();
const WORK_HOST = {
  id: "00000000-0000-7000-8000-000000000302",
  workspaceId: WORKSPACE_ID,
  scope: "member",
  ownerMemberId: ME,
  type: "workd",
  displayName: "개발실 워크스테이션",
  capabilities: { terminal: true },
  lastSeenAtMs: NOW,
  createdAtMs: NOW - 60_000,
  online: true,
};

/** 읽기 하나가 몇 번 나갔는지 센다. 모드: ok | abort(응답 없음). */
function makeReads() {
  return { sessions: { mode: "abort", count: 0 }, hosts: { mode: "ok", count: 0 }, expressions: { mode: "abort", count: 0 } };
}

/** 컨텍스트에 자리별 읽기 모의를 건다(기본 모의 위에 얹는다: 나중에 건 route 가 먼저 받는다). */
async function installReads(context, reads) {
  await context.route("**/v1/workspaces/*/work-sessions", (route) => {
    reads.sessions.count += 1;
    return reads.sessions.mode === "abort" ? route.abort("connectionrefused") : json(route, { workSessions: [] });
  });
  await context.route("**/v1/workspaces/*/work-hosts", (route) => {
    reads.hosts.count += 1;
    return reads.hosts.mode === "abort" ? route.abort("connectionrefused") : json(route, { workHosts: [WORK_HOST] });
  });
  await context.route("**/v1/workspaces/*/expressions", (route) => {
    reads.expressions.count += 1;
    return reads.expressions.mode === "abort" ? route.abort("connectionrefused") : json(route, { error: { message: "capture: not served" } }, 404);
  });
}

async function shot(page, name) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, animations: "disabled", caret: "hide" });
  console.log(`  shot: ${path}`);
  return path;
}

async function openContext(browser, scheme, reads) {
  const context = await browser.newContext(
    withCaptureLocale({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce", timezoneId: "Asia/Seoul" })
  );
  await installBackend(context, PORT);
  await installReads(context, reads);
  return context;
}

// ---- 장면 1: 작업 콘솔의 세션 목록 실패 (상자) ------------------------------------

async function consoleFailure(browser, scheme) {
  scope = `console-${scheme}`;
  console.log(`\n== 작업 콘솔 실패 상자 (${scheme}) ==`);
  const reads = makeReads();
  const context = await openContext(browser, scheme, reads);
  try {
    const page = await context.newPage();
    await signIn(page, ORIGIN);
    await page.evaluate(() => {
      window.location.hash = "#/work?view=console";
    });
    const box = page.getByTestId("work-console-error");
    await box.waitFor({ state: "visible", timeout: 20_000 });
    const text = (await box.textContent()) ?? "";
    check("제목: 무엇을 못 불러왔는지", text.includes("작업 세션을 불러오지 못했어요"), text);
    check("이유: 서버에 닿지 못했어요", (await box.getByTestId("load-failure-reason").textContent()) === "서버에 닿지 못했어요.", text);
    check("상태 코드가 한 글자도 없다", !hasStatusCode(text), text);
    check("옛 문장이 없다", !text.includes("불러오지 못했습니다"), text);
    check("역할이 alert 이고 단추가 하나다", (await box.getAttribute("role")) === "alert" && (await box.getByRole("button").count()) === 1);
    await shot(page, `console-failure-${scheme}`);
    if (scheme === "light") {
      const before = reads.sessions.count;
      reads.sessions.mode = "ok";
      await box.getByRole("button", { name: "다시 시도" }).click();
      await page.getByTestId("work-console-empty").waitFor({ state: "visible", timeout: 15_000 });
      check("다시 시도가 세션 목록을 다시 읽고 상자가 풀린다", reads.sessions.count > before && (await page.getByTestId("work-console-error").count()) === 0, `읽기 ${before} → ${reads.sessions.count}`);
    }
  } finally {
    await context.close();
  }
}

// ---- 장면 2: 호스트 목록 실패 (표면 문의 한 줄) -------------------------------------

async function surfaceFailure(browser) {
  scope = "surface-light";
  console.log("\n== 호스트 목록 실패 한 줄 (light) ==");
  const reads = makeReads();
  reads.hosts.mode = "abort";
  const context = await openContext(browser, "light", reads);
  try {
    const page = await context.newPage();
    await signIn(page, ORIGIN);
    await page.evaluate(() => {
      window.location.hash = "#/work?view=console";
    });
    const line = page.getByTestId("surface-route-error-banner");
    await line.waitFor({ state: "visible", timeout: 20_000 });
    const text = (await line.textContent()) ?? "";
    check("제목 + 이유 한 줄", text.includes("코드 실행 호스트 목록을 불러오지 못했어요. 서버에 닿지 못했어요."), text);
    check("상태 코드가 한 글자도 없다", !hasStatusCode(text), text);
    check("「호스트가 없다」고 말하지 않는다", (await page.getByTestId("surface-unavailable-route").count()) === 0);
    await shot(page, "surface-failure-light");
    const before = reads.hosts.count;
    reads.hosts.mode = "ok";
    await line.getByRole("button", { name: "다시 시도" }).click();
    await page.getByTestId("work-console-route").waitFor({ state: "visible", timeout: 15_000 });
    check("다시 시도가 호스트 목록을 다시 읽고 콘솔이 선다", reads.hosts.count > before, `읽기 ${before} → ${reads.hosts.count}`);
  } finally {
    await context.close();
  }
}

// ---- 장면 3: 표현 고르개의 팀 그림 읽기 실패 (한 줄) -------------------------------

async function expressionFailure(browser, scheme) {
  scope = `expressions-${scheme}`;
  console.log(`\n== 표현 고르개 팀 그림 실패 한 줄 (${scheme}) ==`);
  const reads = makeReads();
  const context = await openContext(browser, scheme, reads);
  try {
    const page = await context.newPage();
    await signIn(page, ORIGIN);
    await openGeneral(page);
    await page.getByTestId("composer-emoji-trigger").click();
    const popover = page.getByTestId("composer-emoji-picker");
    await popover.waitFor({ state: "visible", timeout: 15_000 });
    const group = popover.getByRole("group").first();
    await group.getByRole("button", { name: "이모티콘", exact: true }).click();
    const line = popover.getByTestId("team-expressions-error");
    await line.waitFor({ state: "visible", timeout: 15_000 });
    const text = (await line.textContent()) ?? "";
    check("제목 + 이유 한 줄", text.includes("팀 그림을 불러오지 못했어요. 서버에 닿지 못했어요."), text);
    check("상태 코드가 한 글자도 없다", !hasStatusCode(text), text);
    check("받아 둔 것이 없으면 「아직 팀 그림이 없어요」라고 말하지 않는다", (await popover.getByText("아직 팀 그림이 없어요").count()) === 0);
    await sleep(300);
    await shot(page, `team-expressions-failure-${scheme}`);
    if (scheme === "light") {
      const before = reads.expressions.count;
      await line.getByRole("button", { name: "다시 시도" }).click();
      await sleep(600);
      check("다시 시도가 목록을 다시 읽는다", reads.expressions.count > before, `읽기 ${before} → ${reads.expressions.count}`);
    }
  } finally {
    await context.close();
  }
}

// ---- 장면 4: 소식 창의 「더 보기」 (데스크탑 셸 흉내, capture-5054 와 같은 길) ------

function newestDesktopVersion() {
  const dir = resolve(WEB_ROOT, "../../packages/momo-core/src/features/releaseNotes/notes");
  const key = (file) => file.replace(/^v|\.ts$/g, "").split("_").map(Number);
  const files = readdirSync(dir)
    .filter((file) => /^v\d+_\d+_\d+\.ts$/.test(file))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
  const match = /desktopFrom:\s*\[\s*"([^"]+)"/.exec(readFileSync(resolve(dir, files[0]), "utf8"));
  if (!match) throw new Error(`desktopFrom을 못 읽었다: ${files[0]}`);
  return match[1];
}

/** 데스크탑 셸 흉내: `app_version`만 답한다(capture-5054.mjs 와 같다). 브라우저 안에서 실행되는 함수라 인자로 버전만 받는다. */
function desktopShell(version) {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command.startsWith("keychain_")) throw new Error("no credential store in this capture shell");
      return command === "app_version" ? version : null;
    },
    transformCallback: () => 0,
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
}

async function releaseNotesMore(browser, scheme) {
  scope = `release-notes-${scheme}`;
  console.log(`\n== 소식 창 「더 보기」 (${scheme}) ==`);
  const context = await browser.newContext(
    withCaptureLocale({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: "reduce" })
  );
  await installBackend(context, PORT);
  try {
    await context.addInitScript(desktopShell, newestDesktopVersion());
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await advanceToAccount(page, { path: "invite", inviteLink: ORIGIN });
    await page.getByTestId("login-email").fill("seongjae@dawn.example");
    await page.getByTestId("login-password").fill("capture-only-not-a-credential");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("release-notes-dialog").waitFor({ state: "visible", timeout: 20_000 });
    const more = page.getByTestId("release-notes-dialog-more");
    check("펼치는 단추가 서 있다", (await more.count()) === 1);
    check("단추 이름이 「더 보기」다(띄어쓰기 표준)", (await more.textContent())?.trim() === "더 보기", await more.textContent());
    check("옛 「더보기」가 창에 없다", !((await page.getByTestId("release-notes-dialog").textContent()) ?? "").includes("더보기"));
    await sleep(300);
    await shot(page, `release-notes-popup-${scheme}`);
  } finally {
    await context.close();
  }
}

// ---- 본체 -----------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      await consoleFailure(browser, "light");
      await consoleFailure(browser, "dark");
      await surfaceFailure(browser);
      await expressionFailure(browser, "light");
      await expressionFailure(browser, "dark");
      await releaseNotesMore(browser, "light");
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  writeFileSync(resolve(OUT, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0 && !SOFT) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
