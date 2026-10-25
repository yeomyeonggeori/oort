#!/usr/bin/env node
// =============================================================================
// #4294 캡처: 글 없이 사진·파일만 보낸 메시지가 받는 쪽에서 빈 메시지로 보이던 자리.
//
//   inbox-server   서버 투영 인박스(운영 경로): 목록 줄은 서버 preview 가 비어 있어 그대로이고(엔진 후속
//                  #4439), 우측 상세의 맥락 줄은 빈 칸이 아니라 muted 「사진 2장」이다.
//   inbox-legacy   구서버 후퇴 경로(`/inbox` 404): 목록 줄이 「사진 2장」·「파일 1개」로 말한다.
//   conversation   대화 행(정상 확인용): 사진 카드만 서고 빈 줄이 없다.
//   remind         리마인더 대화상자의 미리보기 한 줄: 「내용 없는 메시지」가 아니라 「사진 2장」.
//
// 라이트·다크 × 1440×900. 백엔드는 없다: `/v1/**`는 고정 응답이고 사진은 요청 때 만든 단색 PNG다.
// 이름·문구는 가상이다(이도현·박서연·최민수, 회사 「달무리 스튜디오」).
//
// 수리 전·후를 같은 스크립트로 비교한다: 수리 전 번들에서는 아래 단언이 빨개져야 하고(빨강이 아니면
// 이 스크립트가 아무것도 못 잡는 것이다), 수리 후 번들에서는 모두 초록이어야 한다.
//
//   npm run build && OUT_DIR=<dir> PHASE=after node scripts/capture-4294.mjs
//   DIST_DIR=dist-before  — dist 말고 다른 빌드 폴더를 서빙한다(수리 전 번들 비교용)
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/photo-only-4294");
const PORT = Number(process.env.CAPTURE_PORT || 5494);
const PHASE = process.env.PHASE || "after";
const DIST_DIR = process.env.DIST_DIR || "dist";
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const seoyeonId = "00000000-0000-7000-8000-000000000102";
const minsuId = "00000000-0000-7000-8000-000000000103";
const ch = (n) => `00000000-0000-7000-8000-0000000002${n}`;
const STUDIO = ch("01");
const DM_SEO = ch("03");
const DM_MIN = ch("04");
const channels = [
  { id: STUDIO, workspaceId, kind: "public", name: "스튜디오", muted: false },
  { id: DM_SEO, workspaceId, kind: "dm", dmKey: "a", memberIds: [memberId, seoyeonId], muted: false },
  { id: DM_MIN, workspaceId, kind: "dm", dmKey: "b", memberIds: [memberId, minsuId], muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://photo-only-capture.invalid/connection/websocket",
};
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: channels.length,
  channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "이도현", "dohyun", { role: "owner" }),
  person(seoyeonId, "human", "박서연", "seoyeon", { role: "member" }),
  person(minsuId, "human", "최민수", "minsu", { role: "member" }),
];

// ---- 단색 PNG (저장소에 사진 파일이 없다) --------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(width, height, rgb) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", h), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PICTURES = {
  "photo-orange": solidPng(640, 480, [217, 123, 79]),
  "photo-teal": solidPng(640, 480, [62, 142, 134]),
};

// ---- 메시지 ------------------------------------------------------------------------
const mid = (channelId, seq) =>
  `00000000-0000-7000-8000-00000000${channelId.slice(-2)}${String(seq).padStart(2, "0")}`;
const iso = (agoMin) => new Date(Date.now() - agoMin * MIN).toISOString().replace(/\.(\d{3})Z$/, ".$1123Z");
const msg = (channelId, seq, authorMemberId, body, minAgo, extra = {}) => ({
  id: mid(channelId, seq), channelId, seq, hlcTs: Date.now() - minAgo * MIN, hlcCount: 0, authorMemberId,
  type: "text", body, state: "sent", createdAtMs: Date.now() - minAgo * MIN, ...extra,
});
const photo = (id, name) => ({ id, name, mime: "image/png", sizeBytes: 31_000 });
const pdf = { id: "file-estimate", name: "견적서.pdf", mime: "application/pdf", sizeBytes: 182_000 };

// 서버는 빈 본문을 null 로 싣는다(사진만) — 하나는 null, 하나는 빈 문자열로 둬 두 모양을 모두 지난다.
const dmSeo = [
  msg(DM_SEO, 1, seoyeonId, "오픈 준비 사진이에요. 확인해 주세요.", 14),
  msg(DM_SEO, 2, memberId, "와, 보여 주세요", 12),
  msg(DM_SEO, 3, seoyeonId, null, 9, { attachments: [photo("photo-orange", "입구.png"), photo("photo-teal", "내부.png")] }),
];
const dmMin = [
  msg(DM_MIN, 1, minsuId, "견적서 보낼게요", 20),
  msg(DM_MIN, 2, minsuId, "", 6, { attachments: [pdf] }),
];
const studio = [
  msg(STUDIO, 1, memberId, "이번 주 오픈 일정 공유해요", 90),
  msg(STUDIO, 2, seoyeonId, "@dohyun 시안 확인 부탁드려요", 40),
];
const byChannel = { [DM_SEO]: dmSeo, [DM_MIN]: dmMin, [STUDIO]: studio };

const wireItem = (id, kind, channel, message, preview, agoMin, readAgoMin) => ({
  id,
  kind,
  reasons: [kind],
  channel: { id: channel.id, name: channel.name ?? null, kind: channel.kind },
  message: { id: message.id, seq: message.seq, authorMemberId: message.authorMemberId, preview, deleted: false },
  actorMemberId: message.authorMemberId,
  createdAt: iso(agoMin),
  readAt: readAgoMin === null ? null : iso(readAgoMin),
});
const chById = (id) => channels.find((c) => c.id === id);
// 서버 투영 경로: 사진만·파일만 보낸 DM 의 preview 는 서버가 본문만 보고 만들어 빈 문자열이다(엔진 후속 #4439).
const serverItems = () => [
  wireItem("00000000-0000-7000-8000-0000000009a1", "dm", chById(DM_SEO), dmSeo[2], "", 9, null),
  wireItem("00000000-0000-7000-8000-0000000009a2", "dm", chById(DM_MIN), dmMin[1], "", 6, null),
  wireItem("00000000-0000-7000-8000-0000000009a3", "mention", chById(STUDIO), studio[1], "@dohyun 시안 확인 부탁드려요", 40, null),
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** scene.inbox = "server" | "legacy" */
async function installRoutes(context, scene) {
  const items = serverItems();
  const unread = () => items.filter((i) => i.readAt === null).length;
  // 읽음 커서: 사진만 보낸 DM 한 건(그리고 파일만 보낸 DM·멘션 한 건)만 안 읽은 상태로 연다.
  const cursors = { [STUDIO]: 1, [DM_SEO]: 2, [DM_MIN]: 1 };
  const readStateOf = (c) => {
    const latest = (byChannel[c.id] ?? []).length;
    const last = cursors[c.id] ?? 0;
    return {
      channel_id: c.id, last_read_seq: last, latest_seq: latest, unread_count: Math.max(0, latest - last),
      mention_count: 0, marked_unread_before_seq: null,
    };
  };
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    const content = path.match(/\/attachments\/([^/]+)\/content$/);
    if (content) {
      const bytes = PICTURES[content[1]];
      if (!bytes) return json(route, { error: { code: "not_found", message: "attachment not found" } }, 404);
      return route.fulfill({ status: 200, contentType: "image/png", headers: { "cache-control": "private, no-store" }, body: bytes });
    }
    const inbox = path.match(/\/inbox(\/(.*))?$/);
    if (inbox) {
      if (scene.inbox === "legacy") return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      const rest = inbox[2] ?? "";
      if (rest === "" && method === "GET") {
        return json(route, { items, nextCursor: null, unreadCount: unread(), approvalsPending: [] });
      }
      if (rest === "read-all" && method === "POST") return json(route, { marked: 0, unreadCount: unread() });
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
    if (path.endsWith("/read-state") && method === "GET") return json(route, { read_states: channels.map(readStateOf) });
    if (/\/channels\/[^/]+\/read-state$/.test(path) && method === "PUT") {
      const id = path.split("/channels/")[1].split("/")[0];
      const requested = JSON.parse(route.request().postData() ?? "{}").last_read_seq ?? 0;
      cursors[id] = Math.max(cursors[id] ?? 0, requested);
      return json(route, readStateOf(chById(id)));
    }
    if (path.endsWith("/approvals")) return json(route, { approvals: [] });
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    const messages = path.match(/\/channels\/([^/]+)\/messages$/);
    if (messages) return json(route, { messages: byChannel[messages[1]] ?? [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "photo-only-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() {
        this.readyState = 3;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = CaptureSocket;
  });
}

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}
function note(name, detail) {
  console.log(`note ${name}: ${detail}`);
}
const squash = (text) => (text ?? "").replace(/\s+/g, " ").trim();
/** 증거 사진에 모의 서버의 응답 모양 탓에 생긴 오류 띠가 끼어들지 않았는지. */
const noFailureBanner = async (page) => !(await page.locator("body").innerText()).includes("하지 못했어요");

async function open(browser, origin, scheme, scene) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
  });
  await installRoutes(context, scene);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => {
    try {
      localStorage.setItem("momo.web.server.v1", server);
    } catch {
      /* 저장소 없는 캡처 */
    }
  }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  // 로그인 뒤 셸이 서기까지 잠깐 기다린다(최근 캡처 스크립트와 같다). 경로마다 자기 요소를 따로 기다린다.
  await page.waitForTimeout(1500);
  return { context, page };
}

async function openInbox(page) {
  await page.evaluate(() => {
    location.hash = "#/inbox";
  });
  await page.getByTestId("inbox-route").waitFor();
  await page.locator("[data-testid='mailbox-row']").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function scenes(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${PHASE}-${name}-${tag}.png`) });

  // ---- 서버 투영 인박스 ------------------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { inbox: "server" });
    await openInbox(page);
    const photoRow = page.locator("[data-testid='mailbox-row'][data-kind='dm']").filter({ hasText: "박서연" }).first();
    note(`${tag} server 목록 줄(서버 preview 그대로, 엔진 후속 #4439)`, squash(await photoRow.innerText()));
    await photoRow.click();
    await page.getByTestId("inbox-detail").waitFor();
    await page.waitForTimeout(500);
    const panel = page.getByTestId("inbox-detail");
    const target = panel.locator("[data-target='true']");
    const line = panel.locator("[data-testid='inbox-context-attachments']");
    check(`${tag} server 상세: 사진만 보낸 맥락 줄이 「사진 2장」이다`, squash(await line.first().innerText().catch(() => "")) === "사진 2장", squash(await target.innerText().catch(() => "")));
    const muted = await line.first().evaluate((el) => el.parentElement?.className.includes("text-ink-muted") ?? false).catch(() => false);
    check(`${tag} server 상세: 그 줄은 본문이 아니라 muted 로 선다`, muted);
    // 이름·시각 줄 아래 본문 칸(font-semibold 가 아닌 text-body)이 비어 있지 않다 — 수리 전에는 이 칸이 빈 줄이었다.
    const bodyText = squash(await target.locator("span.text-body:not(.font-semibold)").first().innerText().catch(() => ""));
    check(`${tag} server 상세: 대상 행의 본문 칸이 비어 있지 않다`, bodyText.length > 0, JSON.stringify(bodyText));
    check(`${tag} server 상세: 화면에 실패 띠가 없다`, await noFailureBanner(page));
    await shot(page, "inbox-server");
    await context.close();
  }

  // ---- 구서버 후퇴 경로 --------------------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { inbox: "legacy" });
    await openInbox(page);
    const rows = await page.locator("[data-testid='mailbox-row'][data-kind='dm']").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    check(`${tag} legacy 목록: 박서연 DM 줄이 「사진 2장」이다`, rows.some((r) => r.includes("박서연") && r.includes("사진 2장")), JSON.stringify(rows));
    check(`${tag} legacy 목록: 최민수 DM 줄이 「파일 1개」다`, rows.some((r) => r.includes("최민수") && r.includes("파일 1개")), JSON.stringify(rows));
    check(`${tag} legacy 목록: 「첨부 파일을 보냈어요.」·「내용 없는 메시지예요.」는 어느 줄에도 없다`, !rows.some((r) => r.includes("첨부 파일을 보냈어요.") || r.includes("내용 없는 메시지예요.")), JSON.stringify(rows));
    await shot(page, "inbox-legacy-list");
    await page.locator("[data-testid='mailbox-row'][data-kind='dm']").filter({ hasText: "박서연" }).first().click();
    await page.getByTestId("inbox-detail").waitFor();
    await page.waitForTimeout(500);
    const line = page.getByTestId("inbox-detail").locator("[data-testid='inbox-context-attachments']");
    check(`${tag} legacy 상세: 맥락 줄이 「사진 2장」이다`, squash(await line.first().innerText().catch(() => "")) === "사진 2장");
    check(`${tag} legacy 상세: 화면에 실패 띠가 없다`, await noFailureBanner(page));
    await shot(page, "inbox-legacy");
    await context.close();
  }

  // ---- 대화 행 + 리마인더 대화상자 ----------------------------------------------------
  {
    const { context, page } = await open(browser, origin, scheme, { inbox: "legacy" });
    await page.evaluate((h) => {
      location.hash = h;
    }, `/c/${DM_SEO}`);
    const row = page.locator("[data-seq='3']").first();
    await row.waitFor({ timeout: 15_000 });
    await row.locator("[data-testid='attachment-image']").first().waitFor({ timeout: 15_000 });
    // 타일은 <figure data-preview=…> 이고 그림은 그 안의 <img> 다 — 둘 다 준비되고 디코드될 때까지 기다린다.
    await page.waitForFunction(
      () => {
        const tiles = [...document.querySelectorAll("[data-seq='3'] [data-testid='attachment-image']")];
        return tiles.length === 2 && tiles.every((t) => t.getAttribute("data-preview") === "ready" && (t.querySelector("img")?.naturalWidth ?? 0) > 0);
      },
      undefined,
      { timeout: 15_000 },
    );
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    check(`${tag} 대화(대조, 수리 전에도 정상): 사진만 보낸 행에 사진 카드 2장이 선다`, (await row.locator("[data-testid='attachment-image']").count()) === 2);
    check(`${tag} 대화(대조, 수리 전에도 정상): 그 행에 「내용 없는 메시지」가 없다`, !(await row.innerText()).includes("내용 없는 메시지"));
    await shot(page, "conversation");

    await row.hover();
    await row.getByTestId("message-actions-trigger").click();
    await page.getByTestId("menu-remind").click();
    const preview = page.getByTestId("remind-dialog-preview");
    await preview.waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    check(`${tag} 리마인더: 미리보기 한 줄이 「사진 2장」이다`, squash(await preview.innerText()) === "사진 2장", squash(await preview.innerText()));
    await shot(page, "remind");
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, DIST_DIR, "index.html"))) throw new Error(`${DIST_DIR}/ is missing. Run npm run build first.`);
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: DIST_DIR === "dist" ? [] : ["--outDir", DIST_DIR],
  });
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
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
