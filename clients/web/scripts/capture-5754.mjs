#!/usr/bin/env node
// =============================================================================
// #5754 인박스 한 칸 ↔ 두 칸: 기준은 화면 폭이 아니라 인박스 자리의 폭(목록 352 + 상세 바닥 192 = 544).
// 720×480 · 사이드바 펼침(자리 388)에서 항목을 열면 한 칸(상세만)이고 「보내기」가 화면 안이며, 900×600 · 1024 · 1280 · 1440은
// 두 칸 그대로, 390은 한 칸 그대로다. 사이드바를 접고 펴는 동안 열어 둔 항목이 유지된다. Chromium · WebKit 둘 다 잰다.
//
//   npm run build && OUT_DIR=<dir> CAPTURE_PORT=27581 node scripts/capture-5754.mjs
//
// 백엔드는 없다(capture-5696.mjs와 같은 고정 응답 틀). 사람·채널 이름은 모두 가상이다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/inbox-source");
const PORT = Number(process.env.CAPTURE_PORT || 26701);
const NOW = Date.now();
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const DOHYUN = "00000000-0000-7000-8000-000000000102";
const SEOYEON = "00000000-0000-7000-8000-000000000103";
const JUNHO = "00000000-0000-7000-8000-000000000104";
const MINJI = "00000000-0000-7000-8000-000000000105";
const BOT = "00000000-0000-7000-8000-000000000301";
const ch = (n) => `00000000-0000-7000-8000-0000000002${n}`;
const WB = ch("01");
const LONG = ch("02");
const DM_DOHYUN = ch("03");
const DM_GROUP = ch("04");
const DM_LEFT = ch("05"); // 내 목록에 없는 DM(떠났다)
const PRIVATE_GONE = ch("06"); // 내 목록에 없는 비공개 채널(볼 수 없게 됐다)
const LONG_NAME = "release-notes-2026-4분기-모바일-데스크탑-통합-점검";
const channels = [
  { id: WB, workspaceId, kind: "public", name: "workbench", muted: false },
  { id: LONG, workspaceId, kind: "public", name: LONG_NAME, muted: false },
  { id: DM_DOHYUN, workspaceId, kind: "dm", dmKey: "a", memberIds: [ME, DOHYUN], muted: false },
  { id: DM_GROUP, workspaceId, kind: "dm", dmKey: "b", memberIds: [ME, JUNHO, MINJI, SEOYEON, DOHYUN], muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId, kind: "human", displayName: "구민수", handle: "minsu" },
  realtimeWebSocketUrl: "ws://inbox-source-capture.invalid/connection/websocket",
};
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 4,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(ME, "human", "구민수", "minsu", { role: "owner" }),
  person(DOHYUN, "human", "김도현", "dohyun", { role: "member" }),
  person(SEOYEON, "human", "이서연", "seoyeon", { role: "member" }),
  person(JUNHO, "human", "박준호", "junho", { role: "member" }),
  person(MINJI, "human", "최민지", "minji", { role: "member" }),
  person(BOT, "agent", "새벽봇", "dawn-bot", { ownerHumanId: ME }),
];

const mid = (channelId, seq) => `00000000-0000-7000-8000-00000000${channelId.slice(-2)}${String(seq).padStart(2, "0")}`;
const iso = (agoMin) => new Date(NOW - agoMin * MIN).toISOString().replace(/\.(\d{3})Z$/, ".$1123Z");
const ROOT = mid(WB, 3);
const wireItem = (n, kind, channel, seq, author, preview, agoMin, readAgoMin, extra = {}) => ({
  id: `00000000-0000-7000-8000-0000000009${String(n).padStart(2, "0")}`,
  kind,
  reasons: [kind],
  channel,
  message: { id: mid(channel.id, seq), seq, authorMemberId: author, preview, deleted: false },
  actorMemberId: author,
  createdAt: iso(agoMin),
  readAt: readAgoMin === null ? null : iso(readAgoMin),
  ...extra,
});
const wire = (id) => {
  const c = channels.find((x) => x.id === id);
  return { id: c.id, name: c.name ?? null, kind: c.kind };
};
const seed = () => [
  wireItem(1, "thread_reply", wire(WB), 9, BOT, "QA 확인 끝나면 바로 공유드릴게요. 빌드는 통과했어요.", 3, null, { rootId: ROOT }),
  wireItem(2, "dm", wire(DM_DOHYUN), 8, DOHYUN, "오늘 4시 디자인 리뷰 같이 볼 수 있을까요?", 8, null),
  wireItem(3, "dm", wire(DM_GROUP), 12, JUNHO, "회의록 정리해서 올렸어요. 빠진 거 있으면 알려 주세요.", 15, null),
  wireItem(4, "mention", wire(LONG), 5, MINJI, "@minsu 4분기 점검표 모바일 항목 확인 부탁드려요", 25, null),
  wireItem(5, "reply_to_me", wire(WB), 10, SEOYEON, "체크리스트 반영해서 다시 올렸어요.", 40, 30, {
    quotedMessage: { id: mid(WB, 8), authorMemberId: ME, preview: "배포 전에 체크리스트 한 번 더 확인해 줄래?", deleted: false },
  }),
  wireItem(6, "dm", { id: DM_LEFT, name: null, kind: "dm" }, 4, SEOYEON, "파일은 공유 드라이브에 올려 뒀어요.", 60 * 5, 60 * 4),
  wireItem(7, "mention", { id: PRIVATE_GONE, name: "design-private", kind: "private" }, 7, JUNHO, "@minsu 시안 3번 확인해 주세요", 60 * 20, 60 * 18),
  wireItem(8, "mention", wire(LONG), 6, DOHYUN, "@minsu 이 스레드에서 이어서 볼게요", 60 * 30, 60 * 28, { rootId: mid(LONG, 2) }),
];
const approval = {
  id: "ap-5696", workspace_id: workspaceId, run_id: "run-5696", channel_id: WB, requested_by: BOT,
  action_type: "tool_call", status: "pending", expires_at_ms: NOW + 3_600_000, created_at_ms: NOW - 2 * MIN,
  payload: { tool_call: { name: "work.session.end" } },
};

const EXPECTED = [
  "처리할 일 · 승인 요청",
  "스레드 · #workbench",
  "DM · 김도현",
  "DM · 박준호, 최민지 외 2명",
  `#${LONG_NAME}`,
  "#workbench",
  "DM",
  "#design-private",
  `스레드 · #${LONG_NAME}`,
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(context) {
  const items = seed();
  const unread = () => items.filter((i) => i.readAt === null).length;
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: NOW + 600_000, ttlSeconds: 60, workspaceId, memberId: ME });
    }
    const inbox = path.match(/\/inbox(\/(.*))?$/);
    if (inbox) {
      const rest = inbox[2] ?? "";
      if (rest === "" && method === "GET") {
        return json(route, { items, nextCursor: null, unreadCount: unread(), approvalsPending: [] });
      }
      if (rest.endsWith("/read") && method === "PUT") {
        const id = rest.replace("/read", "");
        const item = items.find((i) => i.id === id);
        if (!item) return json(route, { error: { code: "not_found", message: "inbox item not found" } }, 404);
        item.readAt ??= iso(0);
        return json(route, { id, readAt: item.readAt, unreadCount: unread() });
      }
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 0, latest_seq: 0, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (/\/channels\/[^/]+\/read-state$/.test(path) && method === "PUT") return json(route, {});
    if (path.endsWith("/approvals")) {
      return json(route, { approvals: url.searchParams.get("status") === "pending" ? [approval] : [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
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
          if (c.connect) return { id: c.id, connect: { client: "inbox-source-capture", version: "6" } };
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

async function open(browser, origin, { width, height, scheme }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    locale: "ko-KR",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForFunction(() => !document.querySelector("[data-testid='login-submit']"), null, { timeout: 20_000 });
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.getByTestId("inbox-route").waitFor();
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid='mailbox-row']").length === n, EXPECTED.length, { timeout: 20_000 });
  await page.waitForTimeout(400);
  return { context, page };
}

const box = (page, id) =>
  page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid='${testId}']`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, right: r.right, width: r.width, y: r.y, bottom: r.bottom };
  }, id);
const present = (page, id) => page.evaluate((testId) => document.querySelector(`[data-testid='${testId}']`) !== null, id);
const DM = "[data-testid='mailbox-row'][data-entry-key='inbox:00000000-0000-7000-8000-000000000902']";

async function scene(browser, engine, origin, opts) {
  const tag = `${engine}-${opts.name}-${opts.scheme}`;
  const { context, page } = await open(browser, origin, opts);
  const W = opts.width;
  const snap = (n) => page.screenshot({ path: resolve(OUT_DIR, `${n}-${tag}.png`) });
  const listBefore = await box(page, "inbox-list-pane");
  await snap("1-list");
  if (opts.single) {
    check(`${tag} 한 칸: 목록이 자리를 다 쓴다 (${listBefore.width.toFixed(0)}px)`, listBefore.width > 352 || W <= 400, JSON.stringify(listBefore));
  } else {
    check(`${tag} 두 칸: 목록 352px 그대로`, Math.abs(listBefore.width - 352) <= 1, JSON.stringify(listBefore));
    check(`${tag} 두 칸: 빈 상세 안내가 서 있다`, await present(page, "inbox-detail-empty"));
  }
  await page.locator(DM).click();
  await page.getByTestId("inbox-detail").waitFor();
  await page.waitForTimeout(300);
  const detail = await box(page, "inbox-detail");
  const send = await box(page, "inbox-reply-send");
  const input = await box(page, "inbox-reply-input");
  const back = await present(page, "inbox-detail-back");
  const listShown = await present(page, "inbox-list-pane");
  await snap("2-open");
  check(`${tag} 「보내기」 상자가 화면 안`, send !== null && send.x >= 0 && send.right <= W && send.bottom <= opts.height, JSON.stringify(send));
  check(`${tag} 답장 칸이 화면 안`, input !== null && input.x >= 0 && input.right <= W, JSON.stringify(input));
  check(`${tag} 가로 넘침 0`, (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0);
  if (opts.single) {
    check(`${tag} 한 칸: 목록 대신 상세, 「목록으로」 있음`, !listShown && back);
    check(`${tag} 한 칸: 상세 폭 ${detail.width.toFixed(0)} >= 192`, detail.width >= 192, JSON.stringify(detail));
    // 사이드바 접고 펴기: 열어 둔 항목 유지
    if (opts.toggles) {
      await page.locator("[data-testid='inbox-detail']").focus();
      await page.keyboard.press("ControlOrMeta+b");
      await page.waitForTimeout(500);
      const wide = await box(page, "inbox-detail");
      await snap("3-collapsed");
      check(`${tag} 접으면 두 칸(목록 + 상세), 항목 유지 (상세 ${wide?.width.toFixed(0)})`, (await present(page, "inbox-list-pane")) && wide !== null && wide.width >= 192 && !(await present(page, "inbox-detail-back")), JSON.stringify(wide));
      await page.keyboard.press("ControlOrMeta+b");
      await page.waitForTimeout(500);
      const again = await box(page, "inbox-detail");
      check(`${tag} 다시 펴면 한 칸, 같은 항목 유지`, again !== null && !(await present(page, "inbox-list-pane")) && (await page.getByTestId("inbox-detail").getAttribute("data-kind")) === "dm", JSON.stringify(again));
    }
    await page.getByTestId("inbox-detail-back").click();
    await page.getByTestId("inbox-list-pane").waitFor();
    check(`${tag} 「목록으로」 뒤 목록이 돌아오고 상세는 닫힘`, (await present(page, "inbox-list-pane")) && !(await present(page, "inbox-detail")));
  } else {
    check(`${tag} 두 칸: 목록과 상세가 함께, 「목록으로」 없음 (상세 ${detail.width.toFixed(0)})`, listShown && !back && detail.width >= 192, JSON.stringify(detail));
  }
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const engines = [["chromium", chromium], ["webkit", webkit]];
  const only = process.env.ENGINE;
  const schemes = process.env.SCHEMES ? process.env.SCHEMES.split(",") : ["light"];
  try {
    for (const [engine, type] of engines) {
      if (only && only !== engine) continue;
      const browser = await type.launch();
      try {
        for (const scheme of schemes) {
          await scene(browser, engine, preview.origin, { name: "720", width: 720, height: 480, scheme, single: true, toggles: true });
          await scene(browser, engine, preview.origin, { name: "900", width: 900, height: 600, scheme, single: false });
          await scene(browser, engine, preview.origin, { name: "1024", width: 1024, height: 700, scheme, single: false });
          await scene(browser, engine, preview.origin, { name: "1280", width: 1280, height: 800, scheme, single: false });
          await scene(browser, engine, preview.origin, { name: "1440", width: 1440, height: 900, scheme, single: false });
          await scene(browser, engine, preview.origin, { name: "390", width: 390, height: 780, scheme, single: true });
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await preview.stop?.();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
