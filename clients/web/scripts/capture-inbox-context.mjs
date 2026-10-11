#!/usr/bin/env node
// =============================================================================
// #3694 인박스 패널 맥락 캡처: 긴 채널 기록 속 인용 답(그록봇)을 열면 패널이 그 메시지로
// 스크롤되고 잠깐 물드는지, 목록과 패널이 같은 이름(@grokbot)을 쓰는지, 부제가 「내 글에…」인지.
// 라이트·다크 × 1440×900.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-inbox-context.mjs
//
// 백엔드는 없다: `/v1/**`는 고정 응답이고 `/inbox*`는 E2(#3683) 응답 모양 그대로다
// (camelCase, 시각은 RFC3339 마이크로초 Z, 키셋 커서). 모의 서버는 한 쪽을 4건으로 끊어
// 「더 보기」를 보이게 한다. 구 서버 후퇴 경로는 capture-inbox-mailbox.mjs가 맡는다.
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/inbox-context");
const PORT = Number(process.env.CAPTURE_PORT || 5216);
const PAGE_CAP = 4;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000301";
const dawnId = "00000000-0000-7000-8000-000000000302";
const ch = (n) => `00000000-0000-7000-8000-0000000002${n}`;
const WB = ch("01");
const LAB = ch("02");
const DM_SEO = ch("03");
const DM_DAWN = ch("04");
const channels = [
  { id: WB, workspaceId, kind: "public", name: "workbench", muted: false },
  { id: LAB, workspaceId, kind: "public", name: "agent-lab", muted: false },
  { id: DM_SEO, workspaceId, kind: "dm", dmKey: "a", memberIds: [memberId, otherId], muted: false },
  { id: DM_DAWN, workspaceId, kind: "dm", dmKey: "b", memberIds: [memberId, dawnId], muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://inbox-capture.invalid/connection/websocket",
};
const MIN = 60_000;
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 4,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(otherId, "human", "서연", "seoyeon", { role: "member" }),
  person(agentId, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
  person(dawnId, "agent", "grok", "grokbot", { ownerHumanId: otherId }),
];

const mid = (channelId, seq) => `00000000-0000-7000-8000-00000000${channelId.slice(-2)}${String(seq).padStart(2, "0")}`;
const iso = (agoMin) => new Date(Date.now() - agoMin * MIN).toISOString().replace(/\.(\d{3})Z$/, ".$1123Z");
const msg = (channelId, seq, authorMemberId, body, minAgo, extra = {}) => ({
  id: mid(channelId, seq), channelId, seq, hlcTs: Date.now() - minAgo * MIN, hlcCount: 0, authorMemberId, type: "text", body,
  createdAtMs: Date.now() - minAgo * MIN, ...extra,
});
const rootMine = msg(WB, 3, memberId, "배포 일정 언제쯤 확정될까요?", 200, {
  thread: { reply_count: 2, last_reply_seq: 9, last_reply_at: Date.now() - 6 * MIN },
});
const wbPage = [
  msg(WB, 8, memberId, "배포 전에 체크리스트 한 번 더 확인해 줄래?", 30),
  msg(WB, 10, agentId, "체크리스트 반영해서 다시 올렸어요. 빌드는 통과했고 QA만 남았어요.", 4),
  rootMine,
];
const replies = [
  msg(WB, 7, otherId, "다음 주 화요일 예정이에요", 30, { rootId: rootMine.id }),
  msg(WB, 9, agentId, "QA 확인 끝나면 바로 공유드릴게요.", 6, { rootId: rootMine.id }),
];

const DAY = 24 * 60 * MIN;
const labLong = Array.from({ length: 24 }, (_, i) => {
  const seq = i + 1;
  const target = seq === 22;
  const author = target ? dawnId : seq % 3 === 0 ? otherId : memberId;
  const body = target
    ? "말씀하신 로그는 19:07에 올려 뒀어요. 인용해서 답해요."
    : seq === 21
      ? "어제 배포 로그 어디 있어?"
      : `기록 ${seq}번: 채널 초반 대화예요. 시안 검토와 배포 일정 이야기가 이어졌어요.`;
  return msg(LAB, seq, author, body, (24 - seq) * (8 * DAY / MIN / 24) + 5, target ? { replyToId: mid(LAB, 21) } : {});
});
const wireItem = (id, kind, channel, seq, author, preview, agoMin, readAgoMin, extra = {}) => ({
  id,
  kind,
  reasons: [kind],
  channel: { id: channel.id, name: channel.name ?? null, kind: channel.kind },
  message: { id: mid(channel.id, seq), seq, authorMemberId: author, preview, deleted: false },
  actorMemberId: author,
  createdAt: iso(agoMin),
  readAt: readAgoMin === null ? null : iso(readAgoMin),
  ...extra,
});
const by = (id) => channels.find((c) => c.id === id);
// 최신순. 서버가 정렬해서 준다.
const seed = () => [
  wireItem("00000000-0000-7000-8000-0000000009a1", "reply_to_me", by(WB), 10, agentId, "체크리스트 반영해서 다시 올렸어요. 빌드는 통과했고 QA만 남았어요.", 4, null, {
    quotedMessage: { id: mid(WB, 8), authorMemberId: memberId, preview: "배포 전에 체크리스트 한 번 더 확인해 줄래?", deleted: false },
  }),
  wireItem("00000000-0000-7000-8000-0000000009a2", "thread_reply", by(WB), 9, agentId, "QA 확인 끝나면 바로 공유드릴게요.", 6, null, { rootId: rootMine.id }),
  wireItem("00000000-0000-7000-8000-0000000009a3", "dm", by(DM_SEO), 8, otherId, "오늘 4시에 디자인 리뷰 있는데, 같이 보면 좋겠어요", 12, null),
  wireItem("00000000-0000-7000-8000-0000000009a4", "mention", by(LAB), 5, dawnId, "@seongjae 시안 3번 컬러 토큰 확인 부탁드려요", 25, null),
  wireItem("00000000-0000-7000-8000-0000000009a5", "reply_to_me", by(LAB), 22, dawnId, "말씀하신 로그는 19:07에 올려 뒀어요. 인용해서 답해요.", 2, null, {
    quotedMessage: { id: mid(LAB, 21), authorMemberId: memberId, preview: "어제 배포 로그 어디 있어?", deleted: false },
  }),
  wireItem("00000000-0000-7000-8000-0000000009a6", "mention", by(WB), 6, otherId, "@seongjae 릴리스 노트 초안 봐 주세요", 60 * 20, 60 * 18),
  wireItem("00000000-0000-7000-8000-0000000009a7", "dm", by(DM_DAWN), 4, dawnId, "정리해서 #workbench에 올려 뒀어요.", 60 * 72, 60 * 70),
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const calls = { labFetches: [], inbox: [], itemReads: [], readAlls: [], channelReadPuts: [] };

function matches(item, filter) {
  if (filter === "all") return true;
  if (filter === "unread") return item.readAt === null;
  const key = { mention: "mention", reply: "reply_to_me", dm: "dm", thread: "thread_reply" }[filter];
  return item.reasons.includes(key);
}

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
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    const inbox = path.match(/\/inbox(\/(.*))?$/);
    if (inbox) {
      const rest = inbox[2] ?? "";
      if (rest === "" && method === "GET") {
        calls.inbox.push(url.search);
        const filter = url.searchParams.get("filter") ?? "all";
        const cursor = Number(url.searchParams.get("cursor")?.replace("p", "") ?? 0);
        const visible = items.filter((i) => matches(i, filter));
        const slice = visible.slice(cursor, cursor + PAGE_CAP);
        const more = cursor + PAGE_CAP < visible.length;
        return json(route, { items: slice, nextCursor: more ? `p${cursor + PAGE_CAP}` : null, unreadCount: unread(), approvalsPending: [] });
      }
      if (rest === "read-all" && method === "POST") {
        const filter = url.searchParams.get("filter") ?? "all";
        let marked = 0;
        for (const item of items) if (item.readAt === null && matches(item, filter)) { item.readAt = iso(0); marked += 1; }
        calls.readAlls.push(filter);
        return json(route, { marked, unreadCount: unread() });
      }
      if (rest.endsWith("/read") && method === "PUT") {
        const id = rest.replace("/read", "");
        const item = items.find((i) => i.id === id);
        if (!item) return json(route, { error: { code: "not_found", message: "inbox item not found" } }, 404);
        item.readAt ??= iso(0);
        calls.itemReads.push(id);
        return json(route, { id, readAt: item.readAt, unreadCount: unread() });
      }
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 0, latest_seq: 0, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (/\/channels\/[^/]+\/read-state$/.test(path) && method === "PUT") {
      calls.channelReadPuts.push(path);
      return json(route, {});
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.endsWith("/replies")) return json(route, { messages: replies });
    if (path.includes("/messages")) {
      if (path.includes(WB)) return json(route, { messages: wbPage });
      if (path.includes(LAB)) {
        const before = Number(url.searchParams.get("before") ?? 10_000);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const page = labLong.filter((m) => m.seq < before).slice(-limit);
        calls.labFetches.push(url.search);
        return json(route, { messages: page });
      }
      return json(route, { messages: [msg(DM_SEO, 8, otherId, "오늘 4시에 디자인 리뷰 있는데, 같이 보면 좋겠어요", 12)] });
    }
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
          if (c.connect) return { id: c.id, connect: { client: "inbox-capture", version: "6" } };
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
const rows = (page) => page.locator("[data-testid='mailbox-row']");

async function open(browser, origin, scheme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  await page.evaluate(() => { location.hash = "#/inbox"; });
  await page.getByTestId("inbox-route").waitFor();
  return { context, page };
}

async function scenes(browser, origin, scheme) {
  for (const key of Object.keys(calls)) calls[key].length = 0;
  const tag = `1440-${scheme}`;
  const { context, page } = await open(browser, origin, scheme);
  const shot = (name) => page.screenshot({ path: resolve(OUT_DIR, `${name}-${tag}.png`) });
  await rows(page).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);

  await page.getByTestId("inbox-tab-reply").click();
  await page.waitForTimeout(500);
  const replyRow = page.locator("[data-kind='reply'][data-unread='true']").filter({ hasText: "agent-lab" }).first();
  const listText = (await replyRow.innerText()).replace(/\s+/g, " ");
  check(`${tag} 목록 줄은 @grokbot`, listText.includes("@grokbot"), listText);
  await replyRow.click();
  await page.getByTestId("inbox-quoted").waitFor();
  await page.waitForTimeout(350);
  await shot("context-reply-flash");

  const panel = page.getByTestId("inbox-detail");
  const header = (await panel.locator("header").innerText()).replace(/\s+/g, " ");
  check(`${tag} 부제는 「내 글에 답하거나 인용했어요.」`, header.includes("내 글에 답하거나 인용했어요.") && !header.includes("회원님"), header);
  const names = await panel.locator("[data-testid='inbox-context-row']").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
  check(`${tag} 패널 보낸 이도 @grokbot (grok 아님)`, names.some((n) => n.includes("@grokbot")) && !names.some((n) => /(^|\s)grok(\s|$)/.test(n)), JSON.stringify(names));
  const count = await panel.locator("[data-testid='inbox-context-row']").count();
  check(`${tag} 맥락은 몇 개만 (앞 4·뒤 2 이하)`, count <= 7 && count >= 2, String(count));
  const first = (await panel.locator("[data-testid='inbox-context-row']").first().innerText()).replace(/\s+/g, " ");
  check(`${tag} 채널 맨 처음(기록 1번)이 아니라 항목 근처에서 시작`, !first.includes("기록 1번") && first.includes("기록 18번"), first);
  const flash = await panel.locator("[data-highlighted='true']").innerText().catch(() => "");
  check(`${tag} 항목 메시지가 물든다`, flash.includes("인용해서 답해요"), flash);
  const visible = await panel.locator("[data-target='true']").evaluate((el) => {
    const box = document.querySelector("[data-testid='inbox-detail-scroll']").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom;
  });
  check(`${tag} 항목 메시지가 패널 안에 보인다`, visible);
  await page.waitForTimeout(1_900);
  check(`${tag} 물듦은 잠깐 뒤 사라진다`, (await panel.locator("[data-highlighted='true']").count()) === 0);
  await shot("context-reply-settled");
  check(`${tag} 가로 넘침 0`, (await overflowX(page)) === 0);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) await scenes(browser, preview.origin, scheme);
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
