#!/usr/bin/env node
// =============================================================================
// 멘션 자동완성 주석 + composer 위 한 줄 캡처 (AIH-9, #3439): 하늘 님 화면에서 @ 를 열어 팀 키 · 내 구독 ·
// 남의 구독(잠금, 맥 꺼짐) · 개인 키 · 문의 중 · 외부 후보와, 못 부르는 에이전트를 부르는 글의 한 줄.
//
//   npm run build && OUT_DIR=/path/to/captures-3439 node scripts/capture-ai-mention.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다. 명부 행에는 서버가 내려주는
// brain · callableBy · owner · hostOnline · brainUnavailableReason 을 그대로 실었다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/ai-mention");
const PORT = Number(process.env.CAPTURE_PORT || 5347);

// 라우팅 줄이 읽는 세 물음(프로필 · 허용 모델 · effort 표)을 서버 형상 그대로 답한다.
const ROUTING = JSON.parse(readFileSync(resolve(WEB_ROOT, "src/features/routing/routingFixtures.json"), "utf8"));

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherHuman = "00000000-0000-7000-8000-000000000102";
const WORK_HOSTS = [
  {
    id: "019f9b10-0000-7000-8000-0000000000a1",
    workspaceId: workspaceId,
    scope: "member",
    ownerMemberId: memberId,
    type: "app",
    displayName: "성재 iMac, 집 작업실",
    capabilities: { code: true },
    lastSeenAtMs: Date.now() - 20_000,
    createdAtMs: Date.now() - 86_400_000,
    online: true,
  },
  {
    id: "019f9b10-0000-7000-8000-0000000000a2",
    workspaceId: workspaceId,
    scope: "workspace",
    ownerMemberId: memberId,
    type: "workd",
    displayName: "엔진 빌드 서버",
    capabilities: { code: true },
    lastSeenAtMs: Date.now() - 4 * 3_600_000,
    createdAtMs: Date.now() - 30 * 86_400_000,
    online: false,
  },
];
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://ai-agents-capture.invalid/connection/websocket",
};
const base = { workspaceId, status: "active", channelCount: 1, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0 };
const human = (id, displayName, handle, role) => ({ ...base, id, kind: "human", displayName, handle, role });
const bot = (n, displayName, handle, extra) => ({ ...base, id: `00000000-0000-7000-8000-00000000030${n}`, kind: "agent", displayName, handle, paused: false, ...extra });
const ownedBy = (id, name) => ({ ownerHumanId: id, owner: { id, displayName: name } });
// 보는 사람은 하늘 님(member)이다. 성재 님의 구독·키 에이전트는 하늘 님이 부를 수 없다.
const roster = [
  bot(1, "김인턴", "kim-intern", { brain: "team_key", callableBy: "everyone", ...ownedBy(otherHuman, "성재") }),
  bot(2, "하늘의 Codex", "haneul-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: true, ...ownedBy(memberId, "하늘") }),
  bot(3, "성재의 Codex", "seongjae-codex", { brain: "subscription", callableBy: "owner_only", hostOnline: false, ...ownedBy(otherHuman, "성재") }),
  bot(4, "성재의 API 키", "seongjae-key", { brain: "personal_key", callableBy: "owner_only", ...ownedBy(otherHuman, "성재") }),
  bot(5, "성재의 Claude Code", "seongjae-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...ownedBy(otherHuman, "성재"),
  }),
  bot(6, "hermes", "hermes", { brain: "external", callableBy: "everyone" }),
  human(memberId, "하늘", "haneul", "member"),
  human(otherHuman, "성재", "seongjae", "owner"),
  bot(7, "하늘의 Claude Code", "haneul-claude", {
    brain: "subscription", callableBy: "owner_only", hostOnline: true, brainUnavailableReason: "claude_subscription_agent_paused", ...ownedBy(memberId, "하늘"),
  }),
];
const message = {
  id: "00000000-0000-7000-8000-000000000301", channelId: channels[0].id, seq: 1, authorMemberId: otherHuman,
  body: "이번 주 배포 정리해 줄 사람?", type: "text", state: "sent", createdAtMs: 1_800_000_000_000, hlcTs: 1_800_000_000_000, hlcCount: 0,
};
// 장면마다 서버 답이 달라진다.
const scenario = { role: "member", members: "full", rosterDelayMs: 0, rosterError: false };
const ROSTER_MEMBERS = () => {
  if (scenario.members === "empty") return roster.filter((m) => m.kind === "human").map((m) => (m.id === memberId ? { ...m, role: scenario.role } : m));
  return roster.map((m) => (m.id === memberId ? { ...m, role: scenario.role } : m));
};

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) {
      if (scenario.rosterError) return json(route, { error: { code: "internal", message: "boom" } }, 500);
      if (scenario.rosterDelayMs > 0) await new Promise((r) => setTimeout(r, scenario.rosterDelayMs));
      return json(route, { members: ROSTER_MEMBERS() });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/hosted-agent-connections")) return json(route, { connections: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      return json(route, { workspace: { id: workspaceId, name: "여명거리", slug: "team", updatedAtMs: 1, roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: true } });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: WORK_HOSTS });
    if (path.endsWith("/work-tier-policy/me")) {
      return json(route, { workTierPolicy: { workspaceId, memberId, mode: "ask", inherited: true, updatedAtMs: Date.now() - 3 * 86_400_000 } });
    }
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/effort-table")) return json(route, ROUTING.effortTable);
    if (path.endsWith("/allowed-models")) return json(route, {});
    if (path.endsWith("/profile")) return json(route, { profile: ROUTING.inherit.profile });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    // 전송 오버라이드 프로브(`routing` + 없는 rootId): 이 서버는 routing 블록을 읽고 값을 거절한다.
    if (path.endsWith("/messages") && route.request().method() === "POST") return json(route, { error: { code: "invalid_request", message: "routing.effort is not allowed for this model" } }, 400);
    if (path.includes("/messages")) return json(route, { messages: [message] });
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
          if (c.connect) return { id: c.id, connect: { client: "ai-agents-capture", version: "6" } };
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

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function open(browser, origin, scheme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 2 });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-ai").waitFor({ timeout: 20_000 });
  await page.evaluate((id) => { window.location.hash = `#/c/${id}`; }, channels[0].id);
  await page.locator("#composer-input").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(400);
  return { context, page };
}

const lineOf = (page, handle) =>
  page.locator("[data-testid='composer-mention-option']").filter({ hasText: `@${handle}` }).first();

// 라우팅 줄의 직계 조각들이 가로로 겹치지 않고 줄 폭 안에 있다 (#3444).
async function assertRowClean(page, name) {
  const bar = page.getByTestId("composer-routing");
  if ((await bar.count()) === 0) return check(`${name}: 라우팅 줄 있음`, false);
  const r = await bar.evaluate((el) => {
    const row = el.firstElementChild;
    const rowBox = row.getBoundingClientRect();
    const leaf = (n) => (n.children.length === 0 || n.tagName === "BUTTON" ? [n] : [...n.children].flatMap(leaf));
    const boxes = [...row.children].flatMap(leaf).map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0);
    boxes.sort((a, b) => a.left - b.left);
    let overlap = 0;
    for (let i = 1; i < boxes.length; i++) overlap = Math.max(overlap, boxes[i - 1].right - boxes[i].left);
    const outside = Math.max(0, ...boxes.map((b) => b.right - rowBox.right), ...boxes.map((b) => rowBox.left - b.left));
    return { overlap, outside, scroll: row.scrollWidth - row.clientWidth };
  });
  check(`${name}: 줄 안 조각이 겹치지 않음 (겹침 ${r.overlap.toFixed(1)}px)`, r.overlap <= 0.5);
  check(`${name}: 줄 밖으로 넘치지 않음 (${r.outside.toFixed(1)}px / scroll ${r.scroll})`, r.outside <= 0.5 && r.scroll <= 0);
}

async function scenes(browser, origin, scheme, viewport) {
  const tag = `${viewport.width}-${scheme}`;
  const { context, page } = await open(browser, origin, scheme, viewport);
  try {
    const input = page.locator("#composer-input");
    await input.click();
    await page.keyboard.type("배포 요약 부탁해요 @");
    await page.getByTestId("composer-mention-list").waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `mention-list-${tag}.png`) });
    const text = (handle, sel) => lineOf(page, handle).locator(`[data-testid='${sel}']`).textContent();
    check(`${tag} 팀 키: 팀 키 · 누구나`, (await text("kim-intern", "mention-agent-line")) === "팀 키 · 누구나");
    check(`${tag} 내 구독: 내 구독 · 나만 부를 수 있어요`, (await text("haneul-codex", "mention-agent-line")) === "내 구독 · 나만 부를 수 있어요");
    check(`${tag} 남의 구독: 성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐`, (await text("seongjae-codex", "mention-agent-line")) === "성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐");
    check(`${tag} 개인 키: 개인 키 · 성재 님만`, (await text("seongjae-key", "mention-agent-line")) === "개인 키 · 성재 님만");
    check(`${tag} 문의 중 꼬리`, (await text("seongjae-claude", "mention-agent-line")).endsWith("· 문의 중"));
    check(`${tag} 외부: 외부 · 누구나`, (await text("hermes", "mention-agent-line")) === "외부 · 누구나");
    for (const h of ["seongjae-codex", "seongjae-key", "seongjae-claude"]) {
      check(`${tag} ${h} 잠금`, (await lineOf(page, h).getAttribute("data-locked")) !== null);
    }
    for (const h of ["kim-intern", "haneul-codex", "hermes"]) {
      check(`${tag} ${h} 잠금 아님`, (await lineOf(page, h).getAttribute("data-locked")) === null);
    }
    // 긴 표시 이름(「성재의 Claude Code」)이 감겨도 칩은 이름 줄(첫 줄)에 붙어 있다.
    for (const h of ["seongjae-claude", "seongjae-codex", "kim-intern"]) {
      const opt = lineOf(page, h);
      const first = await opt.locator("span").first().boundingBox();
      const chip = await opt.getByTestId("mention-badge").boundingBox();
      check(`${tag} ${h} 칩이 첫 줄에 붙음 (칩 top ${Math.round(chip.y)} / 줄 top ${Math.round(first.y)})`, Math.abs(chip.y - first.y) <= 6);
    }
    check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
    const box = await page.getByTestId("composer-mention-list").boundingBox();
    check(`${tag} 목록이 화면 안`, box.x >= 0 && box.x + box.width <= viewport.width, JSON.stringify(box));

    // 남의 구독을 골라 보내기 전
    await lineOf(page, "seongjae-codex").click();
    await page.keyboard.type("배포 요약 부탁해요");
    const notice = page.getByTestId("composer-agent-notice");
    await notice.waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-locked-notice-${tag}.png`) });
    check(`${tag} 못 부르는 글: 빈 예약 띠 없음`, (await page.getByTestId("composer-routing-reserved").count()) === 0);
    check(`${tag} 못 부르는 글: 라우팅 줄(이번만 바꾸기)이 없고 한 줄이 대신한다`, (await page.getByText("이번만 바꾸기").count()) === 0 && (await page.getByText("확인하지 못했습니다").count()) === 0);
    check(`${tag} 한 줄: 못 부름`, ((await notice.textContent()) ?? "").endsWith("성재 님만 부를 수 있어요. 보내도 답하지 않아요."), String(await notice.textContent()));

    // Claude 문의 중 (내 에이전트)
    await input.fill("@haneul-claude 요약 부탁해요");
    await notice.waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-paused-notice-${tag}.png`) });
    check(`${tag} 한 줄: 문의 중`, ((await notice.textContent()) ?? "").includes("약관 확인 전까지 쉬고 있어요"));
    check(`${tag} 한 줄 가로 넘침 0`, (await overflowX(page)) === 0);

    // 부를 수 있는 에이전트는 한 줄이 없고 라우팅 줄이 선다
    await input.fill("@kim-intern 요약 부탁해요");
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-callable-routing-${tag}.png`) });
    check(`${tag} 부를 수 있으면 라우팅 줄이 선다`, (await page.getByText("이번만 바꾸기").count()) > 0);
    check(`${tag} 라우팅 줄에 오류 문구 없음`, (await page.getByText("실행 위치 확인 필요").count()) === 0 && (await page.getByText("확인하지 못했습니다").count()) === 0 && (await page.getByText("불러오지 못해").count()) === 0);
    // 왼쪽 안쪽 여백: 한 줄과 라우팅 줄이 같은 x 에서 시작한다
    await input.fill("@seongjae-codex 요약 부탁해요");
    await notice.waitFor();
    const noticePad = await notice.evaluate((el) => { const r = el.getBoundingClientRect(); return r.x + parseFloat(getComputedStyle(el).paddingLeft); });
    await input.fill("@kim-intern @seongjae-codex 요약 부탁해요");
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-mixed-${tag}.png`) });
    const routingX = await page.getByText("이번만 바꾸기").first().evaluate((el) => { const d = el.closest("div.px-4") ?? el.closest("div"); const r = d.getBoundingClientRect(); return r.x + parseFloat(getComputedStyle(d).paddingLeft); });
    check(`${tag} 한 줄 왼쪽 여백 = 라우팅 줄 왼쪽 여백 (${Math.round(noticePad)} / ${Math.round(routingX)})`, Math.abs(noticePad - routingX) <= 1);

    // 일부만 답하는 글(#3444): 라우팅 줄은 답할 에이전트만 센다. 답하지 않는 에이전트는 아래 한 줄이 말한다.
    const routingRow = page.getByTestId("composer-routing");
    const routingLabel = async () => (await routingRow.textContent()) ?? "";
    check(`${tag} 일부만 답함: 라우팅 줄에 답하지 않는 @seongjae-codex 없음`, !(await routingLabel()).includes("seongjae-codex"), await routingLabel());
    check(`${tag} 일부만 답함: 라우팅 줄은 답하는 @kim-intern 하나`, (await routingLabel()).includes("@kim-intern") && (await routingRow.getAttribute("data-called")) === null);
    check(`${tag} 일부만 답함: 한 줄이 답하지 않는 에이전트를 말함`, ((await notice.textContent()) ?? "").includes("성재의 Codex"));
    await assertRowClean(page, `${tag} 일부만 답함`);

    // 둘 다 답하는 글: 420폭에서도 줄 안의 조각이 서로 겹치지 않는다
    await input.fill("@kim-intern @hermes 요약 부탁해요");
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-two-answering-${tag}.png`) });
    check(`${tag} 둘 다 답함: 라우팅 줄이 둘을 센다`, (await routingRow.getAttribute("data-called")) === "2");
    check(`${tag} 둘 다 답함: 한 줄 없음`, (await page.getByTestId("composer-agent-notice").count()) === 0);
    await assertRowClean(page, `${tag} 둘 다 답함`);
    await input.fill("@kim-intern @hermes @haneul-codex 요약 부탁해요");
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-three-answering-${tag}.png`) });
    await assertRowClean(page, `${tag} 셋 다 답함`);
    // 둘 답하고 하나 안 답함: 답할 둘만 센다
    await input.fill("@kim-intern @hermes @seongjae-codex 요약 부탁해요");
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, `composer-two-of-three-${tag}.png`) });
    check(`${tag} 셋 중 둘 답함: 라우팅 줄은 둘`, (await routingRow.getAttribute("data-called")) === "2" && !(await routingLabel()).includes("seongjae-codex"));
    await assertRowClean(page, `${tag} 셋 중 둘 답함`);

    // 오버라이드가 걸린 줄(칩 + 되돌리기 + 접기)도 좁은 폭에서 겹치지 않는다
    await input.fill("@kim-intern @hermes 요약 부탁해요");
    await page.waitForTimeout(500);
    await page.getByTestId("composer-routing-toggle").click();
    const modelSelect = page.getByTestId("composer-routing-model");
    await modelSelect.waitFor();
    await page.waitForFunction(() => document.querySelector("[data-testid='composer-routing-model']")?.disabled === false, null, { timeout: 5000 }).catch(() => undefined);
    const modelValue = await modelSelect.locator("option").evaluateAll((os) => os.map((o) => o.value).find((v) => v !== "") ?? "");
    if (modelValue !== "") {
      await modelSelect.selectOption(modelValue);
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(OUT_DIR, `composer-two-override-open-${tag}.png`) });
      await page.getByTestId("composer-routing-toggle").click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(OUT_DIR, `composer-two-override-${tag}.png`) });
      check(`${tag} 오버라이드: 한 번만 칩`, (await page.getByText("이번 한 번만").count()) > 0);
      await assertRowClean(page, `${tag} 오버라이드`);
    } else {
      await page.getByTestId("composer-routing-toggle").click();
      check(`${tag} 오버라이드: 고를 모델이 있다`, false);
    }

    // 스레드 패널의 작성창
    await input.fill("");
    const msg = page.getByTestId("timeline-message").first();
    await msg.hover();
    await page.getByRole("button", { name: /답글/ }).first().click();
    const tinput = page.getByTestId("thread-panel").locator("textarea");
    await tinput.waitFor({ timeout: 8000 });
    await tinput.click();
    await page.keyboard.type("@seongjae-codex 부탁해요");
    const tnotice = page.getByTestId("thread-composer-agent-notice");
    await tnotice.waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(OUT_DIR, `thread-locked-notice-${tag}.png`) });
    const tn = await tnotice.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + parseFloat(getComputedStyle(el).paddingLeft) }; });
    const ti = await tinput.boundingBox();
    check(`${tag} 스레드 한 줄 왼쪽 = 입력 글자 왼쪽 (${Math.round(tn.x)} / ${Math.round(ti.x + 12)})`, Math.abs(tn.x - (ti.x + 12)) <= 4);
    check(`${tag} 스레드 가로 넘침 0`, (await overflowX(page)) === 0);
    check(`${tag} 팀 키 에이전트는 한 줄 없음`, (await page.getByTestId("composer-agent-notice").count()) === 0);
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 420, height: 900 }]) {
        await scenes(browser, preview.origin, scheme, viewport);
      }
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
