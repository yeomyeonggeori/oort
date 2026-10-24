#!/usr/bin/env node
// =============================================================================
// DM 닫기를 서버 상태로 - 닫기 전후 + 「⋯ › 닫은 대화」 목록 캡처와 실측 (#4228, ADR-0177 증보 D6~D12).
//
//   npm run build && node scripts/capture-4228.mjs
//
// 장면(서버가 닫기를 기억하는 새 서버의 모양을 하네스가 대신 답한다 - **런타임 미검증**: 이 트리에는 엔진이 없다):
//   이도현 · 박서연 · 최민수 · 김인턴(에이전트) · 나간 멤버(명부에 없음, 안 읽음 없음).
//   ① 닫기 전: DM 구역에 넷이 서고 나간 멤버는 목록에 없다(줄도 없다).
//   ② 이도현 DM 의 호버 X 를 누른다: 하네스가 PUT …/closure 를 받아 `closed_at_seq` 를 기억하고, 앱이 즉시 그 행을 치운다.
//   ③ 다른 기기를 모사: 투영을 다시 읽으면(30초 재조회 대신 페이지를 다시 연다) 닫힌 채다.
//   ④ 「⋯ › 닫은 대화」: 이도현(내가 닫았어요)과 나간 멤버(안 읽은 메시지가 없어요)가 「다시 열기」와 함께 선다.
//   ⑤ 「다시 열기」: DELETE 를 받고 그 대화가 열리고 목록에 돌아온다.
// 라이트·다크 × 1440x900. 웹킷(데스크탑 셸의 엔진)은 라이트만 한 번 더 건다.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/dm-closure-4228");
const PORT = Number(process.env.CAPTURE_PORT || 5428);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const SHOTS = process.env.SHOTS !== "0";
const PREFIX = process.env.PREFIX || "c4228";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channels = ["general", "workbench", "release"].map((name, i) => ({
  id: chId(i + 1), workspaceId, kind: "public", name, muted: false,
}));
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "하윤", "hayun", { role: "owner", presenceStatus: "auto" }),
  person("11", "이도현", "dohyun"),
  person("12", "박서연", "seoyeon"),
  person("13", "최민수", "minsu"),
  person("14", "김인턴", "intern", { kind: "agent", hostOnline: true }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [dm(1, P("11")), dm(2, P("12")), dm(3, P("13")), dm(4, P("14")), dm(5, P("98"))];
const GONE = dmId(5);
const DOHYUN = dmId(1);

function freshServer() {
  // [마지막으로 읽은 seq, 최신 seq, 읽을 최신 seq]
  const read = {
    [chId(1)]: [50, 50, 50], [chId(2)]: [20, 20, 20], [chId(3)]: [8, 8, 8],
    [dmId(1)]: [12, 12, 12], [dmId(2)]: [5, 5, 5], [dmId(3)]: [9, 9, 9], [dmId(4)]: [4, 4, 4], [dmId(5)]: [6, 6, 6],
  };
  return { read, closed: {}, calls: [] };
}
let server = freshServer();
const isDm = (id) => dms.some((d) => d.id === id);

const results = [];
function check(engine, scheme, name, ok, detail) {
  results.push({ engine, scheme, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ engine, scheme, check: name, ok: Boolean(ok), detail }));
}
async function attempt(engine, scheme, name, fn) {
  try {
    await fn();
  } catch (error) {
    check(engine, scheme, `${name} (실행 실패)`, false, String(error?.message ?? error).split("\n")[0]);
  }
}

const wireRead = (id) => ({
  channel_id: id, last_read_seq: server.read[id][0], latest_seq: server.read[id][1],
  unread_count: Math.max(0, server.read[id][1] - server.read[id][0]), mention_count: 0, marked_unread_before_seq: null,
  // 새 서버(migration 146): 읽을 최신 seq 와 **요청자 본인의** 닫은 seq(안 닫았으면 null). 비-DM 은 null.
  latest_readable_seq: server.read[id][2],
  closed_at_seq: isDm(id) ? (server.closed[id] ?? null) : null,
});
const wireReadPut = (id) => {
  // `PUT read-state` 응답에는 두 필드가 없다(D10). 앱이 이것으로 닫힘을 지우면 안 된다.
  const { latest_readable_seq, closed_at_seq, ...rest } = wireRead(id);
  return rest;
};

async function installMocks(context) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "하윤", handle: "hayun" },
    realtimeWebSocketUrl: "ws://dm-closure-4228-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    const closure = /\/channels\/([^/]+)\/closure$/.exec(path);
    if (closure) {
      const id = closure[1];
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() ?? "{}");
        server.calls.push({ method: "PUT", id, seenSeq: body.seenSeq });
        // GREATEST(기존, LEAST(seenSeq, head)): 클라이언트가 본 seq 로 기억한다.
        server.closed[id] = Math.max(server.closed[id] ?? 0, Math.min(body.seenSeq, server.read[id][1]));
      } else if (req.method() === "DELETE") {
        server.calls.push({ method: "DELETE", id });
        delete server.closed[id];
      }
      return route.fulfill({ status: 204 });
    }
    if (/\/channels\/([^/]+)\/read-state$/.test(path) && req.method() === "PUT") {
      const id = /\/channels\/([^/]+)\/read-state$/.exec(path)[1];
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.read_intent === "explicit_open" && server.read[id]) server.read[id][0] = server.read[id][1];
      return json(route, server.read[id] ? wireReadPut(id) : {});
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: Object.keys(server.read).map(wireRead) });
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: { version: 1, sections: [], starredChannelIds: [] } });
    const live = /\/agents\/([^/]+)\/liveness$/.exec(path);
    if (live) return json(route, { agentMemberId: live[1], state: "responsive" });
    if (path.endsWith("/channels")) return json(route, { channels: [...channels, ...dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
  await context.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) { this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); }); }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "row", version: "6" } };
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

async function login(page) {
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
}

async function open(browserType, origin, scheme) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context);
  await context.addInitScript((serverOrigin) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", serverOrigin); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await login(page);
  return { browser, context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);
const scrollDmsIntoView = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="sidebar-section-dms"]')?.scrollIntoView({ block: "end" }));

async function runScheme(browserType, engine, origin, scheme) {
  server = freshServer();
  const { browser, context, page } = await open(browserType, origin, scheme);
  const shot = async (name, clip) => {
    if (!SHOTS) return;
    await scrollDmsIntoView(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-${engine}-${name}-${scheme}.png`), clip: clip ?? { x: 0, y: 0, width: 420, height: 900 } });
  };
  const settle = () => page.waitForTimeout(900);
  const shown = (id) => rowOf(page, id).count().then((n) => n > 0);
  try {
    await attempt(engine, scheme, "A.close", async () => {
      await page.mouse.move(900, 450);
      await settle();
      check(engine, scheme, "A0 닫기 전: 이도현·박서연·최민수·김인턴이 목록에 서고 나간 멤버는 목록에 없다", (await shown(dmId(1))) && (await shown(dmId(2))) && (await shown(dmId(3))) && (await shown(dmId(4))) && !(await shown(GONE)), null);
      check(engine, scheme, "A1 「나간 멤버와의 대화 N개」 줄이 어디에도 없다", (await page.getByTestId("gone-dm-toggle").count()) === 0 && !(await page.locator("body").innerText()).includes("나간 멤버와의 대화"), null);
      await page.getByTestId("sidebar-section-dms-header").hover();
      await shot("dm-before-close");
      await scrollDmsIntoView(page);
      await rowOf(page, DOHYUN).hover();
      check(engine, scheme, "A2 호버하면 이름을 말하는 X(「이도현, 대화 닫기」)가 선다", (await page.getByTestId("dm-close").getAttribute("aria-label")) === "이도현, 대화 닫기", await page.getByTestId("dm-close").getAttribute("aria-label"));
      await shot("dm-hover-close");
      await page.getByTestId("dm-close").click();
      await settle();
      check(engine, scheme, "A3 서버에 PUT …/closure 가 seenSeq=12(화면이 본 투영의 latestSeq)로 나갔다", JSON.stringify(server.calls) === JSON.stringify([{ method: "PUT", id: DOHYUN, seenSeq: 12 }]), JSON.stringify(server.calls));
      check(engine, scheme, "A4 닫은 기기는 즉시 반영한다: 이도현이 목록에서 빠졌다(재조회 전)", !(await shown(DOHYUN)) && (await shown(dmId(2))), null);
      await page.mouse.move(900, 450);
      await shot("dm-after-close");
      // 다른 기기를 모사: 투영을 처음부터 다시 읽는다. 로컬 저장소의 원장은 쓰지 않았으므로 서버 사실만으로 닫혀 있어야 한다.
      const ledger = await page.evaluate(() => localStorage.getItem("momo.web.sidebar-closed-dms.v1"));
      check(engine, scheme, "A5 서버 갈래는 이 기기의 원장에 쓰지 않는다", ledger === null || ledger === "{}", ledger);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
      await settle();
      check(engine, scheme, "A6 다시 읽어도 닫혀 있다(서버가 기억한다)", !(await shown(DOHYUN)) && (await shown(dmId(2))), null);
      await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("momo.web.dm-closure")) localStorage.removeItem(key); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
      await settle();
      check(engine, scheme, "A7 저장소를 지운 뒤(재설치 모사)에도 투영이 오면 닫혀 있다", !(await shown(DOHYUN)), null);
    });
    await attempt(engine, scheme, "B.list", async () => {
      await page.mouse.move(900, 450);
      await page.getByTestId("sidebar-section-dms-header").hover();
      await page.getByTestId("dm-section-menu").waitFor({ timeout: 5000 });
      check(engine, scheme, "B0 DM 구역 머리에 「⋯」 가 서고 닫은 대화 둘(내가 닫은 하나 + 나간 멤버)을 센다", (await page.getByTestId("dm-section-menu").getAttribute("data-closed-count")) === "2", await page.getByTestId("dm-section-menu").getAttribute("data-closed-count"));
      await page.getByTestId("dm-section-menu").click();
      await page.getByTestId("dm-closed-list-open").waitFor({ timeout: 5000 });
      await shot("dm-menu-open");
      await page.getByTestId("dm-closed-list-open").click();
      await page.getByTestId("dm-closed-list").waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      const items = await page.getByTestId("dm-closed-list-item").allInnerTexts();
      check(engine, scheme, "B1 목록에 이도현(내가 닫았어요)과 나간 멤버(안 읽은 메시지가 없어요)가 있고 지금 보이는 대화는 없다", items.length === 2 && items.some((t) => t.includes("이도현") && t.includes("내가 닫았어요")) && items.some((t) => t.includes("나간 멤버") && t.includes("안 읽은 메시지가 없어요")), items.join(" | "));
      if (SHOTS) await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-${engine}-dm-closed-list-${scheme}.png`) });
      server.calls.length = 0;
      await page.getByTestId("dm-closed-list-reopen").first().click();
      await settle();
      check(engine, scheme, "B2 「다시 열기」: DELETE 가 나가고 그 대화가 열린다", JSON.stringify(server.calls) === JSON.stringify([{ method: "DELETE", id: DOHYUN }]) && page.url().toLowerCase().endsWith(`/c/${DOHYUN}`), JSON.stringify(server.calls) + " " + page.url());
      check(engine, scheme, "B3 이도현이 목록에 돌아왔다", await shown(DOHYUN), null);
      await shot("dm-after-reopen");
    });
    await attempt(engine, scheme, "C.gone-open", async () => {
      server.calls.length = 0;
      await page.goto(`${origin}/#/c/${GONE}`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("dm-avatar").first().waitFor({ timeout: 20_000 });
      await settle();
      check(engine, scheme, "C0 나간 상대의 DM 을 열면 서버에 아무것도 쓰지 않고, 열려 있는 동안 목록에 선다", server.calls.length === 0 && (await shown(GONE)), JSON.stringify(server.calls));
      await shot("gone-dm-open");
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    for (const [type, engine] of [[chromium, "chromium"], [webkit, "webkit"]]) {
      if (!ENGINES.includes(engine)) continue;
      for (const scheme of engine === "chromium" ? ["light", "dark"] : ["light"]) {
        await runScheme(type, engine, preview.origin, scheme);
      }
    }
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DM-CLOSURE-4228 PASS (${results.length} checks)` : `DM-CLOSURE-4228 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.engine}/${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
