#!/usr/bin/env node
// =============================================================================
// #4394 캡처: `member.avatar.set` 승인 카드 — 「내 프로필 사진 바꾸기」.
//
//   photo-ready        사진이 보이는 카드(사진 주인 본인) — 한 문장 · 서버 행 · 사진 · 버튼
//   photo-loading      사진을 받는 중(서버가 느리게 답한다)
//   photo-unavailable  본인이 아니라 서버가 404 — 「이 사진은 요청한 본인만 볼 수 있어요.」
//   result-executed    승인 뒤 결과 카드(행동 결과 줄)
//
// 라이트·다크 × 1440×900. 백엔드는 없다: `/v1/**`는 고정 응답이고 사진은 단색 PNG다.
// 이름은 가상 인물(이도현, 달무리봇)이다.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-4394.mjs
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
  : resolve(WEB_ROOT, "artifacts/avatar-approval-4394");
const PORT = Number(process.env.CAPTURE_PORT || 5294);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const APPROVAL = "0199aa11-2222-7000-8000-00000000a001";
const CARD_MSG = "00000000-0000-7000-8000-0000000ba001";
const RESULT_MSG = "00000000-0000-7000-8000-0000000ba002";
const SHA = "ab".repeat(32);

const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "이도현", "dohyun", { role: "owner" }),
  person(agentId, "agent", "달무리봇", "dalmuri", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "스튜디오", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "이도현", handle: "dohyun" },
  realtimeWebSocketUrl: "ws://avatar-capture.invalid/connection/websocket",
};

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(width, height, rgb) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", h), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = solidPng(256, 256, [62, 142, 134]);

const PREVIEW = {
  kind: "avatar_image",
  imageId: "11111111-1111-4111-8111-111111111111",
  sha256: SHA, mime: "image/png", width: 512, height: 384, sizeBytes: 48213, origin: "attachment",
};

function cardProps(expiresAtMs) {
  return {
    approval_id: APPROVAL,
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: CH,
    action_type: "workspace_action",
    status: "pending",
    expires_at_ms: expiresAtMs,
    title: "내 프로필 사진 바꾸기",
    summary: "에이전트가 제안했어요. 승인하면 사진 주인 본인 권한으로 카드에 보이는 이미지로 내 프로필 사진을 바꿔요.",
    action: {
      id: "member.avatar.set",
      rows: [
        { label: "대상", value: "이도현 (@dohyun)" },
        { label: "프로필 사진", value: "없음 → 카드에 보이는 새 이미지" },
        { label: "사진 출처", value: "내가 이 대화에 보낸 첨부" },
      ],
      required_role: "requesting_member",
      preview: PREVIEW,
    },
  };
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** scene.preview = "ready" | "slow" | "404" · scene.result = true 이면 결정이 끝난 대화 */
async function installRoutes(context, scene) {
  const now = Date.now();
  const messageRows = [
    {
      id: "00000000-0000-7000-8000-0000000a0001", channelId: CH, seq: 10, hlcTs: now - 6 * MIN, hlcCount: 0,
      authorMemberId: memberId, type: "text",
      body: "@dalmuri 방금 보낸 사진으로 내 프로필 사진 바꿔 줘", state: "sent", createdAtMs: now - 6 * MIN,
    },
    {
      id: CARD_MSG, channelId: CH, seq: 11, hlcTs: now - 5 * MIN, hlcCount: 0,
      authorMemberId: agentId, type: "approval_request", body: "승인 요청: 내 프로필 사진 바꾸기", state: "sent",
      createdAtMs: now - 5 * MIN,
      props: { ...cardProps(now + 50 * MIN), ...(scene.result ? { status: "approved" } : {}) },
    },
    ...(scene.result
      ? [{
          id: RESULT_MSG, channelId: CH, seq: 12, hlcTs: now - 2 * MIN, hlcCount: 0,
          authorMemberId: agentId, type: "tool_result", body: "프로필 사진을 바꿨어요", state: "sent",
          createdAtMs: now - 2 * MIN,
          props: {
            "momo.action_result": {
              v: 1, action_id: "member.avatar.set", status: "executed", approval_id: APPROVAL,
              decided_by: memberId, ref: { type: "member", id: memberId },
              rows: [{ label: "프로필 사진", value: "카드에 보인 이미지로 바뀌었어요" }],
              secret_shown_once: false,
            },
          },
        }]
      : []),
  ];
  const approvals = scene.result ? [] : [{
    id: APPROVAL, workspaceId, runId: "0199aa11-2222-7000-8000-0000000000b2", channelId: CH,
    requestMessageId: CARD_MSG, requestedBy: agentId, actionType: "workspace_action",
    payload: { action: { id: "member.avatar.set", args: {}, rationale: null }, proposed_by: agentId, resume_model: null },
    status: "pending", expiresAtMs: now + 50 * MIN, createdAtMs: now - 5 * MIN,
  }];
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path.endsWith("/avatar-preview")) {
      previewRequests.push(`${path}${url.search}`);
      if (scene.preview === "404") return json(route, { error: { code: "not_found", message: "avatar preview not found" } }, 404);
      if (scene.preview === "slow") { await new Promise((r) => setTimeout(r, 60_000)); return route.abort(); }
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    }
    if (/\/inbox(\/|$)/.test(path)) return json(route, { error: { code: "not_found", message: "not found" } }, 404);
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state") && method === "GET") {
      return json(route, { read_states: channels.map((c) => ({ channel_id: c.id, last_read_seq: 99, latest_seq: 99, unread_count: 0, mention_count: 0, marked_unread_before_seq: null })) });
    }
    if (path.endsWith("/approvals")) {
      return json(route, { approvals: url.searchParams.get("status") === "pending" ? approvals : [] });
    }
    if (path.endsWith("/agent-runs")) return json(route, { runs: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions/shared")) return json(route, { sessions: [], nextCursor: null });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/reminders")) return json(route, { reminders: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "달무리 스튜디오" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}
const previewRequests = [];

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
          if (c.connect) return { id: c.id, connect: { client: "approvals-capture", version: "6" } };
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

async function open(browser, origin, scheme, scene) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
  });
  await installRoutes(context, scene);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForTimeout(1500);
  await page.evaluate((h) => { location.hash = h; }, `/c/${CH}`);
  await page.getByTestId("agent-card").first().waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="agent-card"]').first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "auto" }));
  await page.waitForTimeout(600);
  return { context, page };
}

async function scenes(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shot = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);

  {
    const { context, page } = await open(browser, origin, scheme, { preview: "ready" });
    await page.getByTestId("approval-avatar-image").waitFor({ timeout: 10_000 });
    const headline = (await page.getByTestId("approval-avatar-headline").textContent()) ?? "";
    check(`${tag} photo-ready: 첫 문장`, headline === "달무리봇이 내 프로필 사진을 이 사진으로 바꾸려고 해요", headline);
    check(`${tag} photo-ready: 서버 행 3개`, (await page.locator('[data-testid="approval-action-row"]').count()) === 3);
    check(`${tag} photo-ready: 승인·거절 버튼`, (await page.getByTestId("approval-approve").count()) === 1);
    const natural = await page.getByTestId("approval-avatar-image").evaluate((img) => img.naturalWidth);
    check(`${tag} photo-ready: 사진이 실제로 디코드됐다`, natural > 0, String(natural));
    const roleText = (await page.getByTestId("approval-action-role").textContent()) ?? "";
    check(`${tag} photo-ready: 결정 권한 문장`, roleText.includes("사진 주인 본인"), roleText);
    await page.screenshot({ path: shot("photo-ready") });
    await context.close();
  }
  {
    const { context, page } = await open(browser, origin, scheme, { preview: "slow" });
    await page.getByTestId("approval-avatar-frame").waitFor({ timeout: 10_000 });
    check(`${tag} photo-loading: 사진 자리는 비어 있고 한 줄 안내가 선다`, (await page.getByTestId("approval-avatar-image").count()) === 0 && ((await page.getByTestId("approval-avatar-caption").textContent()) ?? "").includes("승인하면"));
    await page.screenshot({ path: shot("photo-loading") });
    await context.close();
  }
  {
    const { context, page } = await open(browser, origin, scheme, { preview: "404" });
    await page.getByTestId("approval-avatar-caption").filter({ hasText: "요청한 본인만" }).waitFor({ timeout: 10_000 });
    check(`${tag} photo-unavailable: 본인만 볼 수 있다는 한 줄`, true);
    await page.screenshot({ path: shot("photo-unavailable") });
    await context.close();
  }
  {
    const { context, page } = await open(browser, origin, scheme, { preview: "ready", result: true });
    const note = page.getByTestId("action-result-note").first();
    await note.waitFor({ timeout: 10_000 });
    await note.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "auto" }));
    await page.waitForTimeout(500);
    const text = await page.locator("main").innerText();
    check(`${tag} result-executed: 결과 카드의 사진 행`, text.includes("카드에 보인 이미지로 바뀌었어요"), text.slice(-300));
    await page.screenshot({ path: shot("result-executed") });
    await context.close();
  }
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
  check("미리보기 요청은 해시가 붙은 인가 경로 한 모양뿐", previewRequests.length > 0 && previewRequests.every((p) => p.endsWith(`/approvals/${APPROVAL}/avatar-preview?v=${SHA}`)), previewRequests[0] ?? "none");
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
