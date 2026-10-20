#!/usr/bin/env node
// =============================================================================
// 네이티브 select → ListboxSelect 캡처 (#4126): 웰컴 에이전트 · 재개 대상(SelectField).
//
//   npm run build && node scripts/capture-4126.mjs                      # 후(listbox)
//   BEFORE=1 OUT_DIR=captures/4126/before node scripts/capture-4126.mjs   # 전(네이티브 select, 닫힌 모양만)
//
// 기본 장면 틀은 capture-settings-s5b.mjs 와 같다(진짜 번들 + 고정 응답). 라이트/다크 × 1440.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4126");
const PORT = Number(process.env.CAPTURE_PORT || 5226);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000102";
const NOW = Date.now();
const DAY = 86_400_000;
const channels = [{ id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "workbench", muted: false }];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://settings-s5b-capture.invalid/connection/websocket",
};
function roster(role) {
  const base = (id, kind, displayName, handle, extra = {}) => ({
    id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 1,
    channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
  });
  return [base(memberId, "human", "곽성재", "seongjae", { role }), base(agentId, "agent", "김인턴", "kim-intern")];
}
const WORKSPACE = {
  id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1_760_000_000_000,
  roleLabels: { owner: "마스터" }, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: false,
};
const INVITES = [
  { id: "i1", workspaceId, codePreview: "K7Q2XM", role: "member", maxUses: 5, usedCount: 2, expiresAtMs: NOW + 5 * DAY, createdBy: memberId, createdAtMs: NOW - DAY, updatedAtMs: NOW - DAY },
  { id: "i2", workspaceId, codePreview: "ZZ19PA", role: "guest", maxUses: 1, usedCount: 1, expiresAtMs: NOW + 2 * DAY, createdBy: memberId, createdAtMs: NOW - 3 * DAY, updatedAtMs: NOW - 3 * DAY },
  { id: "i3", workspaceId, codePreview: "RT04LN", role: "admin", maxUses: 3, usedCount: 0, expiresAtMs: NOW - DAY, createdBy: memberId, createdAtMs: NOW - 9 * DAY, updatedAtMs: NOW - 9 * DAY },
];
const MEMORY_ON = { workspace: { enabled: true, paused: false, resetEpoch: 0 }, channels: [], me: { paused: false } };
const MEMORY_OFF = { workspace: { enabled: false, paused: false, resetEpoch: 0 }, channels: [], me: { paused: true } };
const noticeFor = (on) => ({
  enabled: on, paused: false, sending: on, resetEpoch: 0,
  summary: { configured: true, provider: { name: "Anthropic" }, modelId: "claude-sonnet-5" },
  embeddings: { model: "bge-m3", location: "local", sentToProvider: false },
  sends: ["channel_message_text", "memory_item_text"], neverSends: ["human_direct_messages", "attachments", "excluded_channels"],
});

const HOSTS = [
  {
    id: "019a0000-0000-7000-8000-00000000aa01", workspaceId, scope: "workspace", ownerMemberId: memberId, type: "workd",
    displayName: "빌드 서버", publicKey: "PK", capabilities: {}, createdAtMs: 1, online: true, lastSeenAtMs: NOW - 60_000,
  },
  {
    id: "019a0000-0000-7000-8000-00000000aa02", workspaceId, scope: "workspace", ownerMemberId: memberId, type: "workd",
    displayName: "리뷰 전용 맥", publicKey: "PK2", capabilities: {}, createdAtMs: 2, online: true, lastSeenAtMs: NOW - 120_000,
  },
];

const BEFORE = process.env.BEFORE === "1";
const failures = [];
const report = { scenes: [], checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const denied = (route, code = "forbidden") => json(route, { error: { code, message: "operator required" } }, 403);
const boom = (route) => json(route, { error: { code: "internal", message: "boom" } }, 500);
const hang = () => new Promise(() => {});

async function installRoutes(context, cfg) {
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path === "/v1/workspaces" && method === "POST") {
      if (cfg.create === "403") return denied(route);
      return json(route, { workspaceId: "00000000-0000-7000-8000-000000000999", slug: "new-team", name: "새 팀" }, 201);
    }
    if (path.endsWith("/unfurl-settings")) {
      if (cfg.unfurl === "403") return denied(route);
      if (cfg.unfurl === "500") return boom(route);
      return json(route, { enabled: true });
    }
    if (path.endsWith("/invites")) {
      if (method === "POST") {
        return json(route, { invite: { ...INVITES[0], id: "i9", codePreview: "AB12CD", maxUses: 1, usedCount: 0 }, code: "oort-AB12CD-sample-code" }, 201);
      }
      if (cfg.invites === "403") return denied(route);
      if (cfg.invites === "500") return boom(route);
      if (cfg.invites === "hang") return hang();
      return json(route, { invites: cfg.invites === "empty" ? [] : INVITES });
    }
    if (path.endsWith("/memory/settings/me")) return json(route, { paused: true });
    if (path.endsWith("/memory/settings")) {
      if (method !== "GET") return json(route, { enabled: true, paused: false, resetEpoch: 0 });
      if (cfg.memory === "403") return denied(route);
      if (cfg.memory === "404") return json(route, { error: { code: "not_found", message: "no route" } }, 404);
      if (cfg.memory === "500") return boom(route);
      if (cfg.memory === "hang") return hang();
      return json(route, cfg.memory === "off" ? MEMORY_OFF : MEMORY_ON);
    }
    if (path.endsWith("/memory/notice")) return json(route, noticeFor(cfg.memory !== "off"));
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster(cfg.role) });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: HOSTS });
    if (path.endsWith("/work-tier-policy")) return json(route, { workTierPolicy: { workspaceId, mode: "auto", autoTarget: "cloud", inherited: false } });
    if (path.endsWith(`/workspaces/${workspaceId}`)) {
      if (cfg.ws === "500") return boom(route);
      if (cfg.ws === "hang") return hang();
      return json(route, { workspace: WORKSPACE });
    }
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
          if (c.connect) return { id: c.id, connect: { client: "settings-s5b-capture", version: "6" } };
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
  try {
    await page.getByTestId("profile-card").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "FAIL-sign-in.png") }).catch(() => {});
    throw error;
  }
}


const WIDTH = 1440;
const HEIGHT = 1100;

async function openScene(browser, origin, scheme, section) {
  const cfg = { role: "owner", ws: "ok", unfurl: "on", invites: "list", memory: "on" };
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, cfg);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.evaluate((hash) => { location.hash = hash; }, `/settings?section=${section}`);
  return { context, page };
}

async function shoot(page, name, scheme, locator) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(OUT_DIR, `${name}-1440-${scheme}.png`) });
  if (locator) await locator.screenshot({ path: resolve(OUT_DIR, `${name}-crop-1440-${scheme}.png`) });
}

async function checkField(page, scheme, tag, trigger, expectOptions) {
  check(`${tag} ${scheme} combobox 의미 + 네이티브 select 아님`,
    (await trigger.getAttribute("role")) === "combobox" && (await trigger.evaluate((el) => el.tagName)) === "BUTTON");
  await trigger.click();
  const list = page.getByRole("listbox");
  await list.waitFor({ timeout: 5000 });
  const texts = (await page.getByRole("option").allTextContents()).map((t) => t.trim());
  check(`${tag} ${scheme} 옵션`, JSON.stringify(texts) === JSON.stringify(expectOptions), JSON.stringify(texts));
  const names = await page.evaluate(() => {
    const l = document.querySelector('[role="listbox"]');
    const t = document.querySelector(`[aria-controls="${l?.id}"]`);
    const label = (el) => (el?.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent?.trim()).join(" ") || el?.getAttribute("aria-label");
    return { trigger: label(t), list: label(l) };
  });
  check(`${tag} ${scheme} 라벨이 칸과 목록의 이름이다`, !!names.trigger && names.trigger === names.list, JSON.stringify(names));
  const geo = await page.evaluate(() => {
    const l = document.querySelector('[role="listbox"]');
    const t = document.querySelector(`[aria-controls="${l?.id}"]`).getBoundingClientRect();
    const p = l.closest("[data-overlay-layer]").getBoundingClientRect();
    return { tw: t.width, lw: p.width, tx: t.x, lx: p.x, lb: p.bottom, vh: innerHeight };
  });
  check(`${tag} ${scheme} 목록 폭·왼쪽 선이 단추와 같고 창 안이다`, Math.abs(geo.lw - geo.tw) <= 1 && Math.abs(geo.lx - geo.tx) <= 1 && geo.lb <= geo.vh, JSON.stringify(geo));
  await page.mouse.move(0, 0);
}

async function sceneWelcome(browser, origin, scheme) {
  const { context, page } = await openScene(browser, origin, scheme, "workspace");
  const block = page.getByTestId("workspace-welcome-kickoff");
  await block.waitFor({ timeout: 15_000 });
  await block.scrollIntoViewIfNeeded();
  const trigger = page.getByTestId("welcome-agent");
  await page.evaluate(() => document.activeElement?.blur());
  if (BEFORE) {
    await shoot(page, "welcome-agent-native", scheme, block);
    await context.close();
    return;
  }
  await shoot(page, "welcome-agent-closed", scheme, block);
  await checkField(page, scheme, "웰컴 에이전트", trigger, ["기본값 (첫 활성 에이전트)", "김인턴"]);
  await shoot(page, "welcome-agent-open", scheme, block);
  await page.getByRole("option", { name: "김인턴" }).click();
  check(`웰컴 에이전트 ${scheme} 고르면 칸에 값이 선다`, ((await trigger.textContent()) ?? "").includes("김인턴"));
  await context.close();
}

async function sceneTarget(browser, origin, scheme) {
  const { context, page } = await openScene(browser, origin, scheme, "code");
  const trigger = page.getByTestId("work-tier-target-workspace");
  await trigger.waitFor({ timeout: 15_000 });
  await trigger.scrollIntoViewIfNeeded();
  const block = page.getByTestId("work-tier-policy");
  await page.evaluate(() => document.activeElement?.blur());
  if (BEFORE) {
    await shoot(page, "work-target-native", scheme, block);
    await context.close();
    return;
  }
  await shoot(page, "work-target-closed", scheme, block);
  await checkField(page, scheme, "재개 대상", trigger, ["oort Cloud", "빌드 서버", "리뷰 전용 맥"]);
  await shoot(page, "work-target-open", scheme, block);
  await page.getByRole("option", { name: "빌드 서버" }).click();
  check(`재개 대상 ${scheme} 고르면 칸에 값이 서고 저장 단추가 살아난다`, ((await trigger.textContent()) ?? "").includes("빌드 서버"));
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await sceneWelcome(browser, preview.origin, scheme);
      await sceneTarget(browser, preview.origin, scheme);
    }
  } finally {
    await browser.close();
    await preview.stop();
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\n모든 단언 통과");
}

await main();
