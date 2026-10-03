#!/usr/bin/env node
// =============================================================================
// 로그인 → 에이전트로 만들기 한 모달 캡처 (#3389 AIH-5, 시안 panel-flow).
//
//   npm run build:design && OUT=/path node scripts/capture-register-flow.mjs
//
// design 번들에서 `/연결` 카드를 열고 `?aiCard=register-…`로 모달의 단계 하나를 그대로
// 세운다(서버·셸 없이 정적 그림). 제품 빌드는 이 질의를 늘 무시한다. 장면: 로그인 중 →
// 이름 확인 → 만드는 중(서버/CLI) → 완료 / 이미 있음 / 멈춤(Claude 기본 꺼짐) / 꺼짐 /
// 권한 / Codex 두 칸 / CLI 연결 실패 폴백 / 서버 실패. 라이트·다크 × 1280·390.
// 모든 장면에서 접근성 트리에 가짜 값이 있으면 실패한다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CARD_CAPTURE_PORT || 5338);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const channelA = "00000000-0000-7000-8000-000000000201";


const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://slash-gate.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelA],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  member({ id: memberId, kind: "human", role: "owner", displayName: "곽성재", handle: "seongjae" }),
  member({ id: peerId, kind: "human", displayName: "김하늘", handle: "haneul" }),
  member({
    id: agentId,
    kind: "agent",
    displayName: "hermes",
    handle: "hermes",
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
  }),
];

const channels = [
  { id: channelA, workspaceId, kind: "public", name: "에이전트-실험", muted: false },
];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function row(over) {
  return { channelId: channelA, hlcCount: 0, type: "text", state: "sent", ...over, hlcTs: over.createdAtMs };
}

const messages = [
  row({
    id: "0199dddd-0000-7000-8000-000000000001",
    seq: 10,
    authorMemberId: peerId,
    body: "hermes가 오늘 아침부터 대답을 안 하네요. 연결이 끊긴 건가요?",
    createdAtMs: todayAt(15, 31),
  }),
  row({
    id: "0199dddd-0000-7000-8000-000000000002",
    seq: 11,
    authorMemberId: memberId,
    body: "제 맥 쪽 구독부터 확인해 볼게요.",
    createdAtMs: todayAt(15, 38),
  }),
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) replies.push({ id: command.id, connect: { client: "slash-gate", version: "6" } });
          else if (command.subscribe)
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "slash-gate", offset: 0 },
            });
          else replies.push({ id: command.id });
        }
        queueMicrotask(() =>
          this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") }))
        );
      }
      close() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

/** POST /messages 본문을 모은다. 이 게이트의 「전송했는가」의 정본이다. */
async function installRoutes(context, posted, team) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token")
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    if (path === "/v1/auth/refresh")
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    // 팀 연결은 운영자만(#2944 카드의 팀 절). 이 게이트는 입구만 잰다.
    if (path.startsWith("/v1/provider/link")) return team(route, request, path);
    if (path.endsWith("/channels")) return json(route, { channels });
    if (/\/v1\/workspaces\/[^/]+$/.test(path))
      return json(route, {
        id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1, roleLabels: {},
        welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true,
      });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        posted.push(body.body);
        return json(
          route,
          row({ id: "0199dddd-0000-7000-8000-0000000000f1", seq: 12, authorMemberId: memberId, body: body.body, createdAtMs: Date.now() })
        );
      }
      if (url.searchParams.has("after") || url.searchParams.has("before")) return json(route, { messages: [] });
      return json(route, { messages });
    }
    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("slash@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
}

const FAKE_KEY = "capture-only-not-a-key-000000000000";

const outDir = resolve(process.env.OUT || resolve(webRoot, "captures/3389"));

async function scene(browser, { width, scheme, name, query, team, act }) {
  const height = width === 390 ? 844 : 800;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, [], team);
  await login(page);
  await page.evaluate(
    ([id, q]) => {
      window.location.hash = `#/c/${id}?${q}`;
    },
    [channelA, query]
  );
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.getByTestId("timeline-message").first().waitFor();
  await wait(300);
  const input = page.getByTestId("composer-input");
  await input.click();
  await page.keyboard.type(act?.slash ?? "/연결");
  // 목록의 첫 줄을 누른다(좁은 폭의 ↵는 줄바꿈이라 목록 선택으로 연다).
  await page.getByTestId("composer-command-option").first().click();
  await page.getByTestId("ai-connect-card").waitFor({ timeout: 5_000 }).catch(async (error) => {
    await page.screenshot({ path: resolve(outDir, `DEBUG-${name}.png`) });
    console.log("hash", await page.evaluate(() => location.hash), "input", await input.inputValue());
    throw error;
  });
  await wait(400);
  // 접근성 트리를 먼저 잰다: 새 CDP 세션은 Playwright의 오프라인 흉내를 풀어 버린다.
  if (act?.run) await act.run(page, () => assertNoKeyInAxTree(context, page, name));
  if (!act?.checksAx) await assertNoKeyInAxTree(context, page, name);
  // 오프라인 장면은 잠긴 저장 버튼 위의 포인터(흐린 상태)를 그대로 찍는다.
  if (!act?.keepPointer) await page.mouse.move(0, 0);
  await wait(300);
  const path = resolve(outDir, `${name}-${width}-${scheme}.png`);
  await page.screenshot({ path });
  const dialog = page.getByTestId("harness-login-dialog");
  await dialog.waitFor({ timeout: 5_000 });
  const text = ((await dialog.textContent()) ?? "").replace(/\s+/g, " ");
  if (text.includes("capture-only-not-a-value")) {
    // 가짜 값은 Codex·폴백 장면의 칸에만 보인다(사람이 복사하는 자리). 그 밖에는 없어야 한다.
    if (!/codex|cli-failed/.test(name)) throw new Error(`[${name}] 값이 화면에 있다`);
  }
  await context.close();
  return { name, width, scheme, path, text };
}

/** 접근성 트리에 가짜 키가 이름·값으로 나오면 실패한다(스크린리더·접근성 권한 앱이 읽는 면). */
async function assertNoKeyInAxTree(context, page, name) {
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const leaks = nodes.filter((node) =>
    [node.name?.value, node.value?.value, node.description?.value].some(
      (text) => typeof text === "string" && text.includes(FAKE_KEY.slice(0, 16))
    )
  );
  if (leaks.length > 0) {
    throw new Error(`[${name}] 접근성 트리에 키가 평문으로 있다: ${JSON.stringify(leaks.map((n) => n.role?.value))}`);
  }
}

const SCENES = [
  ["1-login-waiting", "aiCard=login-modal"],
  ["2-confirm-name", "aiCard=register-confirm"],
  ["2b-confirm-name-taken", "aiCard=register-confirm-problem"],
  ["3a-registering-server", "aiCard=register-registering-server"],
  ["3b-registering-cli", "aiCard=register-registering-cli"],
  ["4-done", "aiCard=register-done"],
  ["5-existing", "aiCard=register-existing"],
  ["6-paused-claude", "aiCard=register-paused"],
  ["6b-server-off", "aiCard=register-disabled"],
  ["6c-not-admin", "aiCard=register-forbidden"],
  ["7-codex-manual", "aiCard=register-codex"],
  ["8-cli-failed-fallback", "aiCard=register-cli-failed"],
  ["9-server-failed", "aiCard=register-failed"],
];

const team = () => async (route) => json(route, { error: { code: "not_found", message: "none" } }, 404);

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build:design first.");
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "CARD_CAPTURE_PORT" });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  try {
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        for (const scheme of ["light", "dark"]) {
          for (const [name, pose] of SCENES) {
            if (only && !only.includes(name)) continue;
            const result = await scene(browser, {
              width,
              scheme,
              name,
              query: `aiEntry=rows&aiProbe=claude-ready&${pose}`,
              team: team(),
              act: { checksAx: /codex|cli-failed/.test(name) },
            });
            console.log(`[shot] ${name}-${width}-${scheme}: ${result.text.slice(0, 60)}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
