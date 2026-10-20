#!/usr/bin/env node
// =============================================================================
// 닫은 DM 은 사람이 읽을 새 메시지가 올 때만 돌아온다 - 실측 + 캡처 (#4142).
//
// 성재(2026-10-20, 0.1.33): 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」.
//
//   npm run build && node scripts/capture-4142.mjs
//   DIST_DIR=… 로 수리 전 번들에도 돌려 적색/녹색 두 줄을 남긴다.
//
// 장면: kwak의 Claude(에이전트 DM)와 나간 멤버(로스터에 없는 상대) DM 을 X 로 닫는다 ->
//   (1) 에이전트가 기계 메시지(system·work_session)만 쌓는다 -> 새로고침(= 재시작) 뒤에도 둘 다 닫힌 채여야 한다.
//   (2) 에이전트가 사람이 읽을 글을 쓴다 -> 그 DM 만 돌아오고 나간 멤버 DM 은 닫힌 채다.
// =============================================================================
//      벗어났다 다시 들어올 필요가 없다(R4 M1: 호버 구독이 늦게 붙으면 mouseenter 는 이미 지나갔다).
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/dm-revival-4142");
const PREFIX = process.env.PREFIX || "c4142";
const PORT = Number(process.env.CAPTURE_PORT || 5342);
const ENGINES = (process.env.ENGINES || "chromium,webkit").split(",");
const SHOTS = process.env.SHOTS !== "0";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const CLOSED_KEY = "momo.web.sidebar-closed-dms.v1";
const chId = (n) => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const dmId = (n) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const P = (n) => `00000000-0000-7000-8000-0000000001${n}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const channelNames = ["general", "workbench", "agent-lab", "design-2-0", "release"];
const channels = channelNames.map((name, i) => ({ id: chId(i + 1), workspaceId, kind: "public", name, muted: false }));
const person = (n, displayName, handle, extra = {}) => ({
  id: P(n), workspaceId, kind: "human", status: "active", displayName, handle, channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person("01", "곽성재", "seongjae", { role: "owner", presenceStatus: "auto" }),
  person("11", "이도현", "dohyun"),
  person("12", "박서연", "seoyeon"),
  // 긴 이름(한글+부가 설명): 쉴 때도 잘리고, X가 서면 X 왼쪽에서 다시 잘려야 한다.
  person("13", "민수 (마케팅팀 · 글로벌 파트너십 총괄 디렉터)", "minsu", { presenceStatus: "away" }),
  person("15", "정하윤", "hayun", { presenceStatus: "dnd" }),
  person("14", "kwak의 Claude", "kwak-claude", { kind: "agent", hostOnline: true, ownerHumanId: P("01") }),
];
const dm = (n, other) => ({ id: dmId(n), workspaceId, kind: "dm", muted: false, memberIds: [P("01"), other] });
const dms = [dm(1, P("11")), dm(2, P("12")), dm(3, P("13")), dm(4, P("14")), dm(5, P("99"))];

// 서버 read-state 투영. [마지막으로 읽은 seq, 최신 seq]. 이도현 DM과 general만 안 읽음이 있다.
const READ = {
  [chId(1)]: [47, 50], [chId(2)]: [20, 20], [chId(3)]: [8, 8], [chId(4)]: [12, 12], [chId(5)]: [30, 30],
  [dmId(1)]: [10, 12], [dmId(2)]: [5, 5], [dmId(3)]: [7, 7], [dmId(4)]: [9, 9], [dmId(5)]: [3, 3],
};

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

const DEFAULT_PREFS = { version: 1, sections: [{ id: "sec-1", name: "출시 준비", order: 0, channelIds: [chId(5)] }], starredChannelIds: [chId(3)] };
function newState(cfg = {}) {
  return { read: structuredClone(READ), puts: [], writes: [], msgs: {}, messageReads: [], livenessState: "inactive", channels, dms, prefs: DEFAULT_PREFS, readMode: "ok", readDelayMs: 0, ...cfg };
}
const wireRead = (state, id) => ({
  channel_id: id, last_read_seq: state.read[id][0], latest_seq: state.read[id][1],
  unread_count: Math.max(0, state.read[id][1] - state.read[id][0]), mention_count: 0,
  marked_unread_before_seq: state.mark?.[id] ?? null,
});

async function installMocks(context, state) {
  const auth = {
    accessToken: "capture-only-not-a-credential", refreshToken: "capture-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: "ws://dm-revival-4142-capture.invalid/connection/websocket",
  };
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    if (req.method() !== "GET" && !path.startsWith("/v1/auth/")) state.writes.push(`${req.method()} ${path}`);
    const perChannel = /\/channels\/([^/]+)\/read-state$/.exec(path);
    if (perChannel && req.method() === "PUT") {
      const id = perChannel[1];
      const body = JSON.parse(req.postData() ?? "{}");
      state.puts.push({ channel: id, body });
      if (body.mark_unread_before_seq !== undefined) (state.mark ??= {})[id] = body.mark_unread_before_seq;
      if (body.read_intent === "explicit_open") {
        state.read[id][0] = Math.max(state.read[id][0], Math.min(body.last_read_seq, state.read[id][1]));
        if (state.mark) delete state.mark[id];
      }
      return json(route, wireRead(state, id));
    }
    if (path.endsWith("/read-state")) {
      if (state.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
      if (state.readMode === "error") return json(route, { error: "capture-forced-failure" }, 500);
      return json(route, { read_states: Object.keys(state.read).map((id) => wireRead(state, id)) });
    }
    if (path.endsWith("/members/me/sidebar-prefs")) return json(route, { prefs: state.prefs });
    if (/\/agents\/[^/]+\/liveness$/.test(path)) return json(route, { agentMemberId: P("14"), state: state.livenessState });
    if (path.endsWith("/channels")) return json(route, { channels: [...state.channels, ...state.dms] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    const msgMatch = /\/channels\/([^/]+)\/messages$/.exec(path);
    if (msgMatch) {
      const after = Number(new URL(req.url()).searchParams.get("after") ?? 0);
      state.messageReads.push({ channel: msgMatch[1], after });
      const rows = (state.msgs[msgMatch[1]] ?? []).filter((m) => m.seq > after);
      return json(route, { messages: rows.map((m) => ({ id: `m-${msgMatch[1]}-${m.seq}`, channelId: msgMatch[1], authorMemberId: P("14"), seq: m.seq, hlcTs: m.seq, hlcCount: 0, createdAtMs: 1_800_000_000_000 + m.seq, type: m.type, props: m.props, body: m.body })) });
    }
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

async function open(browserType, origin, scheme, state, viewport = { width: 1440, height: 900 }, ready = "sidebar-section-sec-1", launch = {}) {
  const browser = await browserType.launch(launch);
  const context = await browser.newContext({ viewport, colorScheme: scheme, serviceWorkers: "block", reducedMotion: "reduce" });
  await installMocks(context, state);
  await context.addInitScript((server) => { try { if (!localStorage.getItem("momo.web.server.v1")) localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await login(page);
  // 사이드바 배치(섹션·별표)가 도착해야 메뉴에 「섹션으로 이동」이 선다.
  if (ready) await page.getByTestId(ready).waitFor({ timeout: 20_000 });
  return { browser, context, page };
}

const rowOf = (page, id) => page.locator(`[data-testid="channel-item"][data-channel-id="${id}"]`);

const MACHINE = (seq) => ({ seq, type: "system", props: { kind: "work_session" }, body: "작업 상태" });

async function runEngine(browserType, engine, origin) {
  for (const scheme of engine === "chromium" ? ["light", "dark"] : ["light"]) {
    const state = newState();
    const { browser, context, page } = await open(browserType, origin, scheme, state);
    const shot = async (name) => {
      if (!SHOTS) return;
      await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}-${name}-${scheme}.png`), clip: { x: 0, y: 0, width: 420, height: 900 } });
    };
    const shown = (id) => rowOf(page, id).count().then((n) => n > 0);
    const settle = () => page.waitForTimeout(1200);
    try {
      await attempt(engine, scheme, "R.revival", async () => {
        await page.mouse.move(900, 450);
        check(engine, scheme, "R0 닫기 전: kwak의 Claude·나간 멤버 DM 이 사이드바에 있다", (await shown(dmId(4))) && (await shown(dmId(5))), null);
        await shot("1-before-close");
        for (const id of [dmId(4), dmId(5)]) {
          await rowOf(page, id).hover();
          await page.getByTestId("dm-close").waitFor({ timeout: 3_000 });
          await page.getByTestId("dm-close").click();
          await page.mouse.move(900, 450);
        }
        check(engine, scheme, "R1 X 로 닫으면 둘 다 사라진다", !(await shown(dmId(4))) && !(await shown(dmId(5))), null);
        await shot("2-after-close");
        // (1) 기계 메시지만 쌓인다: 투영의 latestSeq 는 오른다.
        state.read[dmId(4)] = [9, 12]; state.read[dmId(5)] = [3, 3];
        state.msgs[dmId(4)] = [MACHINE(10), MACHINE(11), MACHINE(12)];
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
        await settle();
        check(engine, scheme, "R2 새로고침(재시작) 뒤에도 원장이 남아 둘 다 닫힌 채다", !(await shown(dmId(4))) && !(await shown(dmId(5))), await page.evaluate((k) => localStorage.getItem(k), CLOSED_KEY));
        check(engine, scheme, "R3 기계 메시지만 쌓인 DM 은 seq 가 올랐어도 닫힌 채다(예전에는 되살아났다)", !(await shown(dmId(4))), state.messageReads);
        check(engine, scheme, "R4 닫은 뒤(9)부터를 읽어 사람이 읽을 것이 있는지 봤다", state.messageReads.some((r) => r.channel === dmId(4) && r.after === 9), state.messageReads);
        await shot("3-restart-machine-only");
        // (2) 사람이 읽을 글이 온다.
        state.read[dmId(4)] = [9, 13];
        state.msgs[dmId(4)] = [...state.msgs[dmId(4)], { seq: 13, type: "text", body: "다 했어요. 확인해 주세요." }];
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
        await settle();
        check(engine, scheme, "R5 사람이 읽을 글이 오면 kwak의 Claude DM 이 돌아온다", await shown(dmId(4)), state.messageReads);
        check(engine, scheme, "R6 나간 멤버 DM 은 새 메시지가 없으니 닫힌 채다", !(await shown(dmId(5))), null);
        await shot("4-restart-human-message");
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    if (ENGINES.includes("chromium")) await runEngine(chromium, "chromium", preview.origin);
    if (ENGINES.includes("webkit")) await runEngine(webkit, "webkit", preview.origin);
  } finally {
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 1));
  console.log(bad.length === 0 ? `DM-4142 PASS (${results.length} checks)` : `DM-4142 FAIL (${bad.length}/${results.length}): ${bad.map((r) => `${r.engine}/${r.scheme}/${r.name}`).join(" | ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
