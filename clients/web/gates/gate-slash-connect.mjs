#!/usr/bin/env node
// GATE: #2942 GC-1 · #2943 GC-2 — 컴포저 `/` 명령, 키 붙여넣기 차단, ⌘K 「AI 연결 카드 열기」
// (설계: claudedocs/chat-genui-connect/brief.md §3.1·§3.4, 시안 mockups.html ①)
//
// 실제 빌드(dist)를 실브라우저에서 돌려 **제품의 컴포저**가 아래를 하는지 잰다.
// 유닛 시험이 하네스로 잰 것을 여기서는 진짜 전송 경로(POST /messages)로 다시 잰다.
//
//   1. `/연` → 명령 목록(4줄), ↵ → **전송 없이** 설정 › AI 연결로 간다(카드 본체
//      GC-3 전의 계약된 폴백). 컴포저 본문과 초안이 비워진다.
//   2. 키 모양을 붙이고 ↵ → **전송 없음**, 입력창 위 경고 한 줄, 글은 남고, 초안
//      저장소에 키가 없다.
//   3. 알 수 없는 `/shrug` ↵ → 평문 전송(POST 1회, 본문 그대로).
//   4. 문장 중간의 `/연결`은 목록을 열지 않는다.
//   5. ⌘K 「AI 연결 카드 열기」 → 채널 안이라도 카드 자리가 없으면 설정 › AI 연결.
//
// SLASH_GATE_SHOTS=1 이면 라이트·다크 × 1280·900 캡처를 `captures/2942/`에 남긴다.
// 가짜 키는 조각을 이어 실행 중에 만든다 — 이 파일에 키 모양 리터럴은 없다.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.SLASH_GATE_PORT || 5231);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const channelA = "00000000-0000-7000-8000-000000000201";

const FAKE_KEY = ["s", "k-", "proj-", "Q7mZ2xL9vB4nR8tK1wE6yU3iO5pA0sD", "_", "hJ2kL4"].join("");

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
async function installRoutes(context, posted) {
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
    if (path.endsWith("/channels")) return json(route, { channels });
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

async function openChannel(page) {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, channelA);
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await wait(500);
}

const hash = (page) => page.evaluate(() => window.location.hash);

function fail(message) {
  throw new Error(`GATE FAIL: ${message}`);
}

/** 초안 저장소(`momo.draft.v1:` 열쇠, `draftStore.ts`) 중 이 글을 든 열쇠. */
async function draftsHold(page, needle) {
  return page.evaluate((text) => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith("momo.draft.v1:")) continue;
      if ((localStorage.getItem(key) ?? "").includes(text)) return key;
    }
    return null;
  }, needle);
}

async function exercise(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const posted = [];
  await installRealtimeSocket(page);
  await installRoutes(context, posted);
  await login(page);
  await openChannel(page);
  const input = page.getByTestId("composer-input");

  // ---- 1. `/연` → 목록 → ↵ → 설정 › AI 연결, 전송 없음 ----------------------
  await input.click();
  await page.keyboard.type("/연");
  const options = page.getByTestId("composer-command-option");
  await options.first().waitFor({ timeout: 5_000 });
  const labels = await options.allTextContents();
  // 카드 자리가 없는 채널(GC-3 전): 명령당 한 줄, 설정 폴백을 말한다(review H-1).
  if (labels.length !== 1) fail(`/연 목록이 한 줄로 접히지 않았다: ${JSON.stringify(labels)}`);
  if (!labels[0].includes("/연결") || !labels[0].includes("설정 › AI 연결로 이동"))
    fail(`첫 줄이 설정 폴백을 말하지 않는다: ${labels[0]}`);
  if (labels[0].includes("나에게만")) fail("카드 자리가 없는데 「나에게만」을 약속한다");
  const expanded = await input.getAttribute("aria-expanded");
  if (expanded !== "true") fail("목록이 떴는데 입력창 aria-expanded 가 참이 아니다");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.location.hash.startsWith("#/settings"), undefined, { timeout: 5_000 });
  const landed = await hash(page);
  if (landed !== "#/settings?section=ai") fail(`/연결 ↵ 가 설정 › AI 연결로 가지 않았다: ${landed}`);
  if (posted.length !== 0) fail(`명령이 메시지로 전송됐다: ${JSON.stringify(posted)}`);
  if ((await draftsHold(page, "/연")) !== null) fail("명령 글자가 초안에 남았다");
  console.log(`[1] /연 → 한 줄(설정 폴백) → ↵ → ${landed}, 전송 0`);

  // ---- 1b. 목록을 Esc로 닫고 ↵ 해도 명령은 메시지가 아니다 --------------------
  await openChannel(page);
  await input.click();
  await page.keyboard.type("/connect codex");
  await options.first().waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  if ((await options.count()) !== 0) fail("Esc 가 명령 목록을 닫지 않았다");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.location.hash.startsWith("#/settings"), undefined, { timeout: 5_000 });
  if (posted.length !== 0) fail(`Esc 뒤 ↵ 가 명령을 전송했다: ${JSON.stringify(posted)}`);
  if ((await draftsHold(page, "/connect")) !== null) fail("Esc 뒤 실행한 명령이 초안에 남았다");
  console.log("[1b] /connect codex → Esc → ↵ → 설정, 전송 0");

  // ---- 2. 키 붙여넣기 → 전송 없음, 경고, 글 남음, 초안 없음 -------------------
  await openChannel(page);
  await input.click();
  await input.fill(`/연결 ${FAKE_KEY}`);
  await page.keyboard.press("Enter");
  const warn = page.getByTestId("composer-secret-block");
  await warn.waitFor({ timeout: 3_000 });
  if (posted.length !== 0) fail(`키가 든 글이 전송됐다: ${JSON.stringify(posted)}`);
  if ((await input.inputValue()) !== `/연결 ${FAKE_KEY}`) fail("막은 뒤 글이 남아 있지 않다");
  if ((await draftsHold(page, FAKE_KEY)) !== null) fail("키가 초안 저장소에 남았다");
  const frameWarn = await page.getByTestId("composer-frame").getAttribute("data-warn");
  if (frameWarn === null) fail("입력 그릇이 경고 테두리를 입지 않았다");
  // 보내기 버튼도 같은 문을 지난다.
  await page.getByTestId("composer-send").click();
  if (posted.length !== 0) fail("보내기 버튼이 키 차단을 우회했다");
  console.log("[2] 키 붙여넣기 → 전송 0, 경고 한 줄, 글 유지, 초안 없음");
  await input.fill("");
  if ((await warn.count()) !== 0) fail("글을 고쳤는데 경고가 내려가지 않았다");

  // ---- 3. 알 수 없는 `/`는 평문 -------------------------------------------
  await input.fill("");
  await page.keyboard.type("/shrug");
  if ((await options.count()) !== 0) fail("알 수 없는 /shrug 에 목록이 떴다");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  if (posted.length !== 1 || posted[0] !== "/shrug") fail(`/shrug 가 평문으로 가지 않았다: ${JSON.stringify(posted)}`);
  console.log("[3] /shrug → 평문 전송 1회");

  // ---- 4. 문장 중간의 `/연결`은 목록을 열지 않는다 ---------------------------
  await input.fill("");
  await page.keyboard.type("그럼 /연결");
  await page.waitForTimeout(200);
  if ((await options.count()) !== 0) fail("문장 중간의 /연결 에 목록이 떴다");
  console.log("[4] 문장 중간 /연결 → 목록 없음");
  await input.fill("");

  // ---- 5. ⌘K 「AI 연결 카드 열기」 → 폴백 이동 -------------------------------
  await page.keyboard.press("ControlOrMeta+k");
  const row5 = page.getByTestId("switcher-ai-connect");
  await row5.waitFor({ timeout: 5_000 });
  const meta = await row5.textContent();
  if (!meta?.includes("설정에서 열려요")) fail(`카드 자리가 없는데 줄이 「설정에서 열려요」를 말하지 않는다: ${meta}`);
  // 시안 ①: 「ai 연결」을 치면 첫 강조가 「AI 연결 카드 열기」다(review H-2).
  await page.keyboard.type("ai 연결");
  await wait(300);
  const selected = await page.locator('[cmdk-item][aria-selected="true"]').getAttribute("data-testid");
  if (selected !== "switcher-ai-connect") fail(`「ai 연결」의 첫 강조가 카드 열기가 아니다: ${selected}`);
  if ((await page.getByTestId("switcher-message-search").count()) !== 1)
    fail("명령이 앞에 서며 메시지 검색 줄이 사라졌다(R1 B-2)");
  // 부정 질의: id 조각(`gen`)은 명령을 앞세우지 않는다(review R2 H-1).
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("gen");
  await wait(300);
  const selectedGen = await page.locator('[cmdk-item][aria-selected="true"]').getAttribute("data-testid");
  if (selectedGen !== "switcher-message-search") fail(`「gen」의 첫 강조가 메시지 검색이 아니다: ${selectedGen}`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("ai 연결");
  await wait(300);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.location.hash.startsWith("#/settings"), undefined, { timeout: 5_000 });
  if ((await hash(page)) !== "#/settings?section=ai") fail("⌘K 줄이 설정 › AI 연결로 가지 않았다");
  if (posted.length !== 1) fail("⌘K 줄이 무언가를 전송했다");
  console.log("[5] ⌘K 「ai 연결」 첫 강조 = AI 연결 카드 열기 → ↵ → #/settings?section=ai (GC-3 전 폴백), 검색 줄 유지");

  await context.close();
}

async function captureShots(browser) {
  const outDir = resolve(webRoot, "captures/2942");
  mkdirSync(outDir, { recursive: true });
  for (const width of [1280, 900, 390]) {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        reducedMotion: "reduce",
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await installRealtimeSocket(page);
      await installRoutes(context, []);
      await login(page);
      await openChannel(page);
      await page.getByTestId("timeline-message").first().waitFor();
      const input = page.getByTestId("composer-input");

      await input.click();
      await page.keyboard.type("/연");
      await page.getByTestId("composer-command-option").first().waitFor();
      await page.mouse.move(0, 0);
      await wait(200);
      await page.screenshot({ path: resolve(outDir, `slash-menu-${width}-${scheme}.png`) });

      await page.keyboard.press("Escape");
      await input.fill(`/연결 ${FAKE_KEY}`);
      // 폰 폭에서 ↵는 줄바꿈이다(goal B8 H4). 두 폭이 같은 문을 지나도록 버튼으로 보낸다.
      await page.getByTestId("composer-send").click();
      await page.getByTestId("composer-secret-block").waitFor();
      // 제품이 그리는 그대로 찍는다(review M-3). FAKE_KEY 는 합성 값이다.
      await wait(200);
      await page.screenshot({ path: resolve(outDir, `key-block-${width}-${scheme}.png`) });

      await input.fill("");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("switcher-ai-connect").waitFor();
      await page.keyboard.type("ai 연결");
      await wait(300);
      await page.screenshot({ path: resolve(outDir, `palette-${width}-${scheme}.png`) });
      await context.close();
    }
  }
  console.log("[shots] captures/2942/{slash-menu,key-block,palette}-{1280,900,390}-{light,dark}.png");
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  const server = await startGuardedPreview({ webRoot, port, portEnvVar: "SLASH_GATE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      await exercise(browser);
      if (process.env.SLASH_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: `/`는 맨 앞에서만 열렸고, 명령은 전송되지 않고 실행됐고, 키는");
  console.log("           보내지 않고 이유를 말했으며 초안에도 남지 않았고, 모르는 `/`는");
  console.log("           평문으로 갔고, ⌘K 줄은 카드 자리가 없어 설정 › AI 연결로 갔다.");
}

await main();
