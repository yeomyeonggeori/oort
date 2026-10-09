#!/usr/bin/env node
// =============================================================================
// 설정 S5b 캡처 (#3620, 에픽 #3578): 워크스페이스 · 멤버와 초대 · 기억.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-settings-s5b.mjs
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는
// 흉내. 관리자(소유자)와 일반 멤버 시점은 명부의 내 역할로 가른다.
//
// 모든 장면은 **기다리는 값이 기대 상태**다: 다른 상태이면 시간 초과로 실패하고
// `FAIL-<장면>.png`를 남긴다. 장면마다 라이트/다크 × 1440/390.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/settings-s5b");
const PORT = Number(process.env.CAPTURE_PORT || 5198);

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
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
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
    await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "FAIL-sign-in.png") }).catch(() => {});
    throw error;
  }
}

const VIEWPORTS = [
  { w: 1440, h: 1500 },
  { w: 390, h: 3200 },
];

async function scene(browser, origin, def, scheme, vp) {
  const tag = `${def.name}-${vp.w}-${scheme}`;
  const cfg = { role: "owner", ws: "ok", unfurl: "on", invites: "list", memory: "on", ...def.cfg };
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, cfg);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  await page.evaluate((hash) => { location.hash = hash; }, `/settings?section=${def.section}`);
  try {
    await def.ready(page, tag);
    if (def.after) await def.after(page, context);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => {
      const v = document.querySelector("[data-settings-scroll-viewport]") ?? document.documentElement;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, v.scrollWidth - v.clientWidth);
    });
    check(`${tag} 가로 넘침 0`, overflow <= 0, { overflow });
    // 잘린 컨트롤이 없다: 모든 스위치가 화면 폭 안에 온전히 들어온다(좁은 폭에서 표 열이 잘리던 결함).
    const clipped = await page.evaluate((width) =>
      [...document.querySelectorAll('[role="switch"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > width + 0.5 || r.left < -0.5);
      }).length, vp.w);
    check(`${tag} 화면 밖으로 잘린 스위치 0`, clipped === 0, { clipped });
    if (def.verify) await def.verify(page, tag);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

const waitText = (page, id, text) => page.getByTestId(id).filter({ hasText: text }).first().waitFor({ timeout: 10_000 });
const offlineNow = async (page, context) => {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.getByTestId("settings-offline-banner").waitFor({ timeout: 10_000 });
};
const text = (page) => page.locator("body").innerText();
const noCheckbox = async (page, tag) =>
  check(`${tag} 네이티브 체크박스가 없다(스위치만)`, (await page.locator("[data-testid=settings-route] input[type=checkbox]").count()) === 0);
const noKeum = async (page, tag) =>
  check(`${tag} 합쇼체가 없다`, !/(습니다|됩니다|십시오)/.test(await text(page)));
const h2s = (page) => page.locator("[data-testid=settings-route] h2").allInnerTexts();
const noRetryIn = async (page, tag, testId) =>
  check(`${tag} 다시 시도 단추가 없다`, (await page.locator(`[data-testid=${testId}] button`).count()) === 0);
const noContactLine = async (page, tag) =>
  check(`${tag} 「서버 운영자에게 문의」 문구가 없다`, !(await text(page)).includes("서버 운영자에게 문의"));

const SCENES = [
  // ---- 워크스페이스 ------------------------------------------------------------
  {
    name: "workspace-admin", section: "workspace",
    ready: async (page) => { await page.getByTestId("workspace-role-labels-save").waitFor({ timeout: 10_000 }); await page.getByTestId("workspace-unfurls").waitFor(); },
    verify: async (page, tag) => {
      await noCheckbox(page, tag);
      await noKeum(page, tag);
      const titles = await h2s(page);
      check(`${tag} 카드 순서`, JSON.stringify(titles) === JSON.stringify(["일반", "링크 확인(서버)", "역할 표시명", "웰컴 킥오프", "새 워크스페이스 만들기"]), titles);
      check(`${tag} 링크 확인 스위치는 서버 값(켬)을 말한다`, (await page.getByTestId("workspace-unfurls").getAttribute("aria-checked")) === "true");
      check(`${tag} 아바타 변경 단추가 있다(운영자)`, (await page.getByTestId("workspace-avatar-change").count()) === 1);
      check(`${tag} 이름 칸에 현재 이름`, (await page.getByTestId("workspace-rename-name").inputValue()) === "여명거리");
      check(`${tag} 운영자 안내가 없다`, (await page.getByTestId("operator-notice").count()) === 0);
    },
  },
  {
    name: "workspace-member-403", section: "workspace", cfg: { role: "member", unfurl: "403" },
    ready: async (page) => { await waitText(page, "workspace-unfurl-card", "소유자와 관리자만"); await page.getByTestId("workspace-name-readonly").waitFor(); },
    verify: async (page, tag) => {
      await noKeum(page, tag);
      check(`${tag} 운영자 안내 3곳(링크 확인·역할 표시명·웰컴)`, (await page.getByTestId("operator-notice").count()) === 3, { n: await page.getByTestId("operator-notice").count() });
      check(`${tag} 스위치가 없다`, (await page.getByRole("switch").count()) === 0);
      check(`${tag} 편집 칸·저장 단추가 없다`, (await page.locator("[data-testid=role-label-owner], [data-testid=welcome-prompt], [data-testid=workspace-role-labels-save], [data-testid=workspace-welcome-save], [data-testid=workspace-rename-save]").count()) === 0);
      await noRetryIn(page, tag, "workspace-unfurl-card");
      check(`${tag} 아바타 변경 단추가 없다(비운영자)`, (await page.getByTestId("workspace-avatar-change").count()) === 0);
      check(`${tag} 역할 표시명이 읽기 값으로 보인다(마스터)`, (await page.getByTestId("workspace-role-labels").innerText()).includes("마스터"));
    },
  },
  {
    name: "workspace-create-403", section: "workspace", cfg: { create: "403" },
    ready: async (page) => { await page.getByTestId("workspace-create").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.locator("#workspace-name").fill("새 팀");
      await page.locator("#workspace-slug").fill("new-team");
      await page.getByTestId("workspace-create").click();
      await waitText(page, "workspace-create-card", "서버의 운영자만");
    },
    verify: async (page, tag) => {
      check(`${tag} 만들기 폼이 안내로 바뀌었다`, (await page.getByTestId("workspace-create-form").count()) === 0);
      check(`${tag} 안내가 카드 안에 있다`, (await page.locator("[data-testid=workspace-create-card] [data-testid=operator-notice]").count()) === 1);
    },
  },
  {
    name: "workspace-created", section: "workspace",
    ready: async (page) => { await page.getByTestId("workspace-create").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.locator("#workspace-name").fill("새 팀");
      await page.locator("#workspace-slug").fill("new-team");
      await page.getByTestId("workspace-create").click();
      await waitText(page, "workspace-created", "새 팀 워크스페이스를 만들었어요");
      await page.getByTestId("workspace-created").scrollIntoViewIfNeeded();
    },
    verify: async (page, tag) => noKeum(page, tag),
  },
  {
    name: "workspace-error", section: "workspace", cfg: { ws: "500", unfurl: "500" },
    ready: async (page) => { await page.getByTestId("workspace-error").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 일반 카드에 다시 시도 단추가 있다`, (await page.locator("[data-testid=workspace-error] button").count()) === 1);
      check(`${tag} 링크 확인 카드에도 다시 시도(403과 구분)`, (await page.locator("[data-testid=workspace-unfurls-error] button").count()) === 1);
      check(`${tag} 이 장면에는 운영자 안내가 없다`, (await page.getByTestId("operator-notice").count()) === 0);
    },
  },
  {
    name: "workspace-loading", section: "workspace", cfg: { ws: "hang" },
    ready: async (page) => { await page.locator("[data-testid=workspace-card] [data-testid=skeleton][data-ready=false]").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 편집 카드는 아직 없다`, (await page.getByTestId("workspace-role-labels").count()) === 0);
      check(`${tag} 이름 칸은 아직 없다`, (await page.getByTestId("workspace-rename-name").count()) === 0);
    },
  },
  {
    name: "workspace-offline", section: "workspace",
    ready: async (page) => { await page.getByTestId("workspace-role-labels-save").waitFor({ timeout: 10_000 }); },
    after: async (page, context) => {
      await offlineNow(page, context);
      await waitText(page, "workspace-unfurl-card", "연결이 끊겨 지금은 이 설정을 바꿀 수 없어요");
    },
    verify: async (page, tag) => {
      check(`${tag} 링크 확인 스위치가 잠겼다`, await page.getByTestId("workspace-unfurls").isDisabled());
      check(`${tag} 표시명 저장 이유가 있다`, (await text(page)).includes("연결이 끊겨 지금은 표시 이름을 저장할 수 없어요"));
      check(`${tag} 만들기 이유가 있다`, (await page.getByTestId("workspace-create-offline").count()) === 1);
    },
  },
  // ---- 멤버와 초대 --------------------------------------------------------------
  {
    name: "members-admin", section: "members",
    ready: async (page) => { await page.getByTestId("invite-list").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await noKeum(page, tag);
      check(`${tag} 목록 3줄`, (await page.locator("[data-testid=invite-list] li").count()) === 3);
      const body = await page.getByTestId("invite-list").innerText();
      check(`${tag} 상태 문구가 모두 보인다`, ["사용 가능", "모두 사용됨", "만료됨"].every((label) => body.includes(label)), body);
      check(`${tag} 카드 순서`, JSON.stringify(await h2s(page)) === JSON.stringify(["발급한 초대 링크", "새 초대 링크"]));
    },
  },
  {
    name: "members-empty", section: "members", cfg: { invites: "empty" },
    ready: async (page) => { await waitText(page, "invite-empty", "아직 발급한 초대 링크가 없어요"); },
    verify: async (page, tag) => check(`${tag} 목록이 없고 만들기 폼은 있다`, (await page.getByTestId("invite-list").count()) === 0 && (await page.getByTestId("invite-create-form").count()) === 1),
  },
  {
    name: "members-member-403", section: "members", cfg: { role: "member", invites: "403" },
    ready: async (page) => { await waitText(page, "operator-notice", "소유자나 관리자만 발급할 수 있어요"); },
    verify: async (page, tag) => {
      check(`${tag} 만들기 폼이 없다`, (await page.getByTestId("invite-create-form").count()) === 0);
      await noRetryIn(page, tag, "operator-notice");
      check(`${tag} 다시 시도 배너가 없다`, (await page.getByTestId("invite-error").count()) === 0);
    },
  },
  {
    name: "members-error", section: "members", cfg: { invites: "500" },
    ready: async (page) => { await page.getByTestId("invite-error").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 다시 시도 단추가 있다`, (await page.locator("[data-testid=invite-error] button").count()) === 1);
      check(`${tag} 운영자 안내가 없다`, (await page.getByTestId("operator-notice").count()) === 0);
    },
  },
  {
    name: "members-loading", section: "members", cfg: { invites: "hang" },
    ready: async (page) => { await page.locator("[data-testid=members-page] [data-testid=skeleton][data-ready=false]").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => check(`${tag} 만들기 폼은 아직 없다`, (await page.getByTestId("invite-create-form").count()) === 0),
  },
  {
    name: "members-offline", section: "members",
    ready: async (page) => { await page.getByTestId("invite-list").waitFor({ timeout: 10_000 }); },
    after: async (page, context) => { await offlineNow(page, context); await page.getByTestId("invite-create-offline").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => check(`${tag} 만들기가 잠겼다`, (await page.getByTestId("invite-create").getAttribute("aria-disabled")) === "true"),
  },
  {
    name: "members-issued", section: "members",
    ready: async (page) => { await page.getByTestId("invite-list").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("invite-create").click();
      await waitText(page, "invite-issued", "oort-AB12CD-sample-code");
      await page.getByTestId("invite-issued").scrollIntoViewIfNeeded();
    },
    verify: async (page, tag) => {
      await noKeum(page, tag);
      check(`${tag} 발급 카드가 카드 안에 있다`, (await page.locator("[data-testid=invite-issued-card] [data-testid=invite-issued]").count()) === 1);
    },
  },
  // ---- 기억 --------------------------------------------------------------------
  {
    name: "memory-admin", section: "memory",
    ready: async (page) => { await page.getByTestId("memory-workspace-enabled").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await noCheckbox(page, tag);
      await noKeum(page, tag);
      check(`${tag} 스위치 3개(내 일시정지·팀 켜기·팀 멈추기)`, (await page.getByRole("switch").count()) === 3);
      check(`${tag} 팀 켜기는 켬`, (await page.getByTestId("memory-workspace-enabled").getAttribute("aria-checked")) === "true");
      check(`${tag} 내 일시정지는 끔`, (await page.getByTestId("memory-me-paused").getAttribute("aria-checked")) === "false");
      check(`${tag} 팀 스위치가 열려 있다`, !(await page.getByTestId("memory-workspace-enabled").isDisabled()));
    },
  },
  {
    name: "memory-member", section: "memory", cfg: { role: "member" },
    ready: async (page) => { await page.getByTestId("memory-admin-reason").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 팀 스위치가 잠겼다`, (await page.getByTestId("memory-workspace-enabled").isDisabled()) && (await page.getByTestId("memory-workspace-paused").isDisabled()));
      check(`${tag} 내 일시정지는 열려 있다`, !(await page.getByTestId("memory-me-paused").isDisabled()));
      check(`${tag} 이유가 스위치에 걸려 있다`, ((await page.getByTestId("memory-workspace-enabled").getAttribute("aria-describedby")) ?? "").includes("memory-workspace-admin-reason"));
      check(`${tag} 초기화 단추 대신 문장`, (await page.getByTestId("memory-reset-open").count()) === 0 && (await page.getByTestId("memory-reset-admin-only").count()) === 1);
    },
  },
  {
    name: "memory-team-off", section: "memory", cfg: { memory: "off" },
    ready: async (page) => { await page.getByTestId("memory-mine-workspace-off").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 팀 켜기는 끔`, (await page.getByTestId("memory-workspace-enabled").getAttribute("aria-checked")) === "false");
      check(`${tag} 팀 멈추기는 잠겼다`, await page.getByTestId("memory-workspace-paused").isDisabled());
      check(`${tag} 내 일시정지는 켬`, (await page.getByTestId("memory-me-paused").getAttribute("aria-checked")) === "true");
    },
  },
  {
    name: "memory-enable-ask", section: "memory", cfg: { memory: "off" },
    ready: async (page) => { await page.getByTestId("memory-workspace-enabled").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("memory-workspace-enabled").click();
      await page.getByTestId("memory-enable-ask").waitFor({ timeout: 10_000 });
      await page.getByTestId("memory-enable-confirm").scrollIntoViewIfNeeded();
    },
    verify: async (page, tag) => {
      check(`${tag} 확인 질문에 고지가 함께 선다`, (await page.locator("[data-testid=memory-enable-ask] [data-testid=memory-notice-body]").count()) === 1);
      check(`${tag} 확인 칸에 상자 테두리가 없다`, !(await page.getByTestId("memory-enable-ask").evaluate((el) => el.className)).includes("border"));
    },
  },
  {
    name: "memory-reset-confirm", section: "memory",
    ready: async (page) => { await page.getByTestId("memory-reset-open").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("memory-reset-open").click();
      await page.getByTestId("memory-reset-confirm").waitFor({ timeout: 10_000 });
      await page.getByTestId("memory-reset-confirm").scrollIntoViewIfNeeded();
    },
    verify: async (page, tag) => check(`${tag} 확인 입력 전에는 초기화가 잠겨 있다`, (await page.getByTestId("memory-reset-submit").getAttribute("aria-disabled")) === "true"),
  },
  {
    name: "memory-403", section: "memory", cfg: { memory: "403" },
    ready: async (page) => { await page.getByTestId("memory-settings-forbidden").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await noRetryIn(page, tag, "memory-page");
      await noContactLine(page, tag);
      check(`${tag} 사람 멤버 사실을 말한다`, (await text(page)).includes("사람 멤버만 기억 설정을 볼 수 있어요"));
      check(`${tag} 운영자 안내 컴포넌트를 쓰지 않는다`, (await page.getByTestId("operator-notice").count()) === 0);
    },
  },
  {
    name: "memory-absent", section: "memory", cfg: { memory: "404" },
    ready: async (page) => { await waitText(page, "memory-settings-load", "아직 팀 기억을 지원하지 않아요"); },
    verify: async (page, tag) => noRetryIn(page, tag, "memory-page"),
  },
  {
    name: "memory-error", section: "memory", cfg: { memory: "500" },
    ready: async (page) => { await waitText(page, "memory-settings-load", "불러오지 못했어요"); },
    verify: async (page, tag) => check(`${tag} 다시 시도 단추가 있다`, (await page.locator("[data-testid=memory-settings-load] button").count()) === 1),
  },
  {
    name: "memory-loading", section: "memory", cfg: { memory: "hang" },
    ready: async (page) => { await page.locator("[data-testid=memory-page] [data-testid=skeleton][data-ready=false]").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => check(`${tag} 스위치는 아직 없다`, (await page.getByRole("switch").count()) === 0),
  },
  {
    name: "memory-offline", section: "memory",
    ready: async (page) => { await page.getByTestId("memory-workspace-enabled").waitFor({ timeout: 10_000 }); },
    after: async (page, context) => { await offlineNow(page, context); await page.getByTestId("memory-offline-reason").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      check(`${tag} 세 스위치가 모두 잠겼다`, (await page.getByRole("switch").evaluateAll((els) => els.every((el) => el.disabled))));
      check(`${tag} 초기화 단추가 잠겼다`, (await page.getByTestId("memory-reset-open").getAttribute("aria-disabled")) === "true");
    },
  },
];

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        for (const def of SCENES) await scene(browser, preview.origin, def, scheme, vp);
      }
    }
  } finally {
    await browser.close();
    await preview.stop();
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
