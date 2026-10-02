#!/usr/bin/env node
// =============================================================================
// 「팀 작업」 보드 + 세션 상세 드로어 캡처와 실측 (#2863, 시안 ④, 제안서 §4).
//
//   npm run build && node scripts/capture-team-board.mjs
//   → OUT_DIR(기본 ~/.cache/momo-scratch/2863/captures)/*.png + report.json
//
// 진짜 앱 셸을 Chromium으로 연다(웹 모드). 백엔드는 없다: `/v1/**`는 이 파일의 고정 응답이고
// 실시간 소켓은 곧바로 연결되는 흉내다(capture-rail-unified와 같은 모양). 보드가 읽는 것은
// `GET …/work-sessions/shared`와 `…/{id}/shared` 둘이고, 여기서 **서버 역할**을 한다: 보는
// 사람이 멤버가 아닌 채널의 세션은 응답에 넣지 않는다(작업 원장 쪽에는 공유 안 한 세션이 있다).
//
// 장면(밝음·어두움 × 1440·900): 보드(카드 여섯, A 레인 포함) · 드로어 열림 · 비어 있음 ·
// 오류 · 불러오는 중 · 오프라인. 재는 것: 가로 넘침 0, 드로어 폭 408(1440)·표 자리 대체(900),
// Enter가 드로어를 열고 포커스가 드로어로 가고 Esc가 닫고 열었던 줄로 돌아온다, 드로어에 입력
// 칸·터미널·멈춤이 없다, 공유하지 않은 세션이 화면에 없다. 단언이 틀리면 종료 코드 1이다.
// =============================================================================
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(homedir(), ".cache/momo-scratch/2863/captures");
const PORT = Number(process.env.CAPTURE_PORT || 5201);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const seId = "00000000-0000-7000-8000-000000000102";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "agent-lab", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "qa", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId, kind: "private", name: "release", muted: false },
];
const ch = Object.fromEntries(channels.map((c) => [c.name, c]));
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://team-board-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재",
    handle: "seongjae", channelCount: 4, channelIds: channels.map((c) => c.id), capabilities: [],
    createdAtMs: 0, updatedAtMs: 0,
  },
];

const MIN = 60;
const owner = (id, displayName) => ({ memberId: id, displayName });
function boardRows(now) {
  const sec = Math.floor(now / 1000);
  const diff = (added, deleted, files, ahead) => ({ added, deleted, files, ahead, behind: 0, uncommitted: 0 });
  const none = { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null };
  const base = {
    folderLabel: null, endedAtMs: null, startedAtMs: now - 3_600_000, sharedAtMs: now - 3_000_000, prUrl: null,
  };
  return [
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000a1", origin: "local_pty", label: "한글 입력 이중 전송 수리",
      folderLabel: "momo", status: "running", owner: owner(memberId, "곽성재"),
      homeChannel: { id: ch.workbench.id, name: "workbench" }, repo: "momo", branch: "feat/2774-xterm",
      harness: "claude", state: "waiting", stages: ["세션 시작", "작업 중", "실행 허락 기다림"],
      diff: diff(128, 40, 9, 2), lastActivityAt: sec - 3 * MIN,
    },
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000a2", origin: "local_pty", label: "relay 중복 발행 수리",
      folderLabel: "momo", status: "running", owner: owner(memberId, "곽성재"),
      homeChannel: { id: ch.workbench.id, name: "workbench" }, repo: "momo", branch: "fix/push-dup",
      harness: "codex", state: "waiting", stages: ["세션 시작", "작업 중", "답 기다림"],
      diff: diff(42, 18, 4, 1), lastActivityAt: sec - 2 * MIN,
    },
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000a3", origin: "local_pty", label: "PR #2851 푸시 중복 수리",
      folderLabel: "momo", status: "ended", endedAtMs: now - 11 * 60_000, owner: owner(memberId, "곽성재"),
      homeChannel: { id: ch.workbench.id, name: "workbench" }, repo: "momo", branch: "fix/push-dup",
      harness: "claude", state: "done", stages: ["세션 시작", "작업 중", "턴 끝남"],
      diff: diff(42, 18, 4, 3), prUrl: "https://github.com/yeomyeonggeori/oort/pull/2851", lastActivityAt: sec - 11 * MIN,
    },
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000b1", origin: "host", label: "온보딩 문구 다듬기",
      status: "running", owner: owner(memberId, "곽성재"),
      homeChannel: { id: ch["agent-lab"].id, name: "agent-lab" }, repo: null, branch: null, harness: "claude",
      state: "running", stages: [], diff: none, lastActivityAt: sec - 1 * MIN, sharedAtMs: null,
    },
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000c1", origin: "local_pty", label: "푸시 알림 재현 스크립트",
      folderLabel: "oort-mobile", status: "running", owner: owner(seId, "박세은"),
      homeChannel: { id: ch.qa.id, name: "qa" }, repo: "oort-mobile", branch: "qa/push-repro", harness: "codex",
      state: "running", stages: ["세션 시작", "작업 중"], diff: diff(31, 4, 3, 1), lastActivityAt: sec - 5 * MIN,
    },
    {
      ...base, sessionId: "00000000-0000-7000-8000-0000000000c2", origin: "local_pty",
      label: "릴리스 노트 초안: 한글 조합 중 ⌃` 키가 터미널로 새지 않는지 회귀 시험 결과 포함",
      folderLabel: "momo", status: "running", owner: owner(seId, "박세은"),
      homeChannel: { id: ch.release.id, name: "release" }, repo: "momo", branch: "docs/changelog", harness: "claude",
      state: "review", stages: ["세션 시작", "작업 중", "턴 끝남"], diff: diff(210, 12, 2, 2), lastActivityAt: sec - 24 * MIN,
    },
  ];
}

const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** mode: board | empty | error | slow. 서버 역할: 공유된 줄만 준다(원장의 비공유 세션은 없다). */
async function installRoutes(context, mode, hits) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) {
      hits.push(path);
      if (mode.value === "error") return json(route, { error: { message: "boom" } }, 500);
      if (mode.value === "slow") {
        await new Promise((r) => setTimeout(r, 60_000));
        return json(route, { sessions: [], nextCursor: null });
      }
      return json(route, { sessions: mode.value === "empty" ? [] : boardRows(Date.now()), nextCursor: null });
    }
    const single = /\/work-sessions\/([0-9a-f-]+)\/shared$/.exec(path);
    if (single) {
      const found = boardRows(Date.now()).find((r) => r.sessionId === single[1]);
      return found ? json(route, { session: found }) : json(route, { error: { message: "shared work session not found" } }, 404);
    }
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "team-board-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

async function scene(browser, origin, scheme, viewport, kind) {
  const tag = `${viewport.width}-${scheme}`;
  const mode = { value: kind === "empty" ? "empty" : kind === "error" ? "error" : kind === "loading" ? "slow" : "board" };
  const hits = [];
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, mode, hits);
  const page = await context.newPage();
  await installRealtime(page);
  await signIn(page, origin);
  await page.getByTestId("nav-team").click();
  await page.getByTestId("team-work-route").waitFor();

  if (kind === "board" || kind === "drawer") {
    await page.getByTestId("team-board-row").first().waitFor();
    const rows = await page.getByTestId("team-board-row").count();
    check(`${tag} 보드: 「지금」 카드 ${rows}개(공유된 것만, A 레인 포함, 끝난 1개는 「오늘 끝난 것」)`, rows === 5, rows);
    const text = await page.getByTestId("team-work-route").innerText();
    check(`${tag} 보드: 공유하지 않은 세션·터미널 글이 없다`, !text.includes("비밀") && !/\$ |❯/.test(text));
    check(`${tag} 보드: 에이전트 레인 줄이 있다`, (await page.locator('[data-origin="host"]').count()) === 1);
    check(`${tag} 보드: 가로 넘침 0`, (await overflowX(page)) === 0, await overflowX(page));
    if (kind === "board") await shot(page, `board-${tag}`);
  }
  if (kind === "drawer") {
    // 키보드: 첫 줄에 포커스 → j로 한 칸 → Enter로 드로어 → Esc로 닫기 → 열었던 줄로 복귀.
    const first = page.getByTestId("team-board-row").first();
    await first.focus();
    await page.keyboard.press("j");
    const second = await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"));
    check(`${tag} 키보드: j가 다음 줄로 옮긴다`, second === "00000000-0000-7000-8000-0000000000a2", second);
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    await page.getByTestId("team-board-drawer").waitFor();
    await page.waitForTimeout(150);
    const focusInDrawer = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    check(`${tag} 키보드: Enter 뒤 포커스가 드로어로 간다`, focusInDrawer === "team-board-drawer", focusInDrawer);
    const drawerBox = await page.getByTestId("team-board-drawer").boundingBox();
    if (viewport.width >= 1400) check(`${tag} 드로어 폭 408`, Math.round(drawerBox.width) === 408, drawerBox.width);
    else check(`${tag} 좁은 창: 드로어가 표 자리를 대신한다`, (await page.getByTestId("team-board-row").first().isVisible()) === false);
    const bad = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="team-board-drawer"]');
      return {
        inputs: d.querySelectorAll("textarea, input, [role='textbox'], .xterm, canvas").length,
        buttons: [...d.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent),
      };
    });
    check(`${tag} 드로어: 입력 칸·터미널 없음, 단추는 닫기 하나`, bad.inputs === 0 && bad.buttons.length === 1 && bad.buttons[0] === "닫기", bad);
    check(`${tag} 드로어: 가로 넘침 0`, (await overflowX(page)) === 0);
    await shot(page, `drawer-${tag}`);
    await page.keyboard.press("Escape");
    await page.getByTestId("team-board-drawer").waitFor({ state: "detached" });
    await page.waitForTimeout(100);
    const back = await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"));
    check(`${tag} 키보드: Esc가 닫고 열었던 줄로 돌아온다`, back === "00000000-0000-7000-8000-0000000000a1", back);

    // 에이전트 레인 줄의 드로어(저장소·diff를 지어내지 않는다).
    await page.locator('[data-origin="host"]').click();
    await page.getByTestId("team-board-drawer").waitFor();
    check(`${tag} 에이전트 드로어: 진행·로그 절이 숨는다`, (await page.getByTestId("team-board-stages").count()) === 0 && (await page.getByTestId("team-board-log").count()) === 0);
    await shot(page, `drawer-agent-${tag}`);
  }
  if (kind === "doneview") {
    await page.getByTestId("team-board-row").first().waitFor();
    await page.getByTestId("team-board-view-done").click();
    await page.waitForTimeout(150);
    const done = await page.getByTestId("team-board-row").count();
    check(`${tag} 「오늘 끝난 것」: 끝난 카드 1개`, done === 1, done);
    await shot(page, `board-done-${tag}`);
  }
  if (kind === "empty") {
    await page.getByTestId("team-board-empty").waitFor();
    check(`${tag} 비어 있음: 공유가 시작되는 말을 한다`, (await page.getByTestId("team-board-empty").innerText()).includes("공유를 켠 세션이 여기에 보여요"));
    await shot(page, `empty-${tag}`);
  }
  if (kind === "error") {
    await page.getByTestId("team-board-error").waitFor({ timeout: 15_000 });
    await shot(page, `error-${tag}`);
  }
  if (kind === "loading") {
    await page.waitForTimeout(400);
    check(`${tag} 불러오는 중: 막대가 선다`, (await page.locator(".skel").count()) > 0);
    await shot(page, `loading-${tag}`);
  }
  if (kind === "offline") {
    await page.getByTestId("team-board-row").first().waitFor();
    await context.setOffline(true);
    await page.getByText("네트워크가 끊겼습니다").waitFor();
    check(`${tag} 오프라인: 앱 셸 배너 하나만 서고(보드 배너 없음) 마지막 목록이 남는다`, (await page.getByTestId("team-board-offline").count()) === 0 && (await page.getByTestId("team-board-row").count()) === 5);
    await shot(page, `offline-${tag}`);
  }
  await context.close();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    const kinds = (process.env.KINDS ?? "board,drawer,doneview,empty,error,loading,offline").split(",");
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
        for (const kind of kinds) await scene(browser, preview.origin, scheme, viewport, kind);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
