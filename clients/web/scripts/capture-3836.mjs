#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3836, ADR-0201): 「oort 도우미」
//   1. 도우미 승인 카드(도우미 제안 · 요청: ○○ / 도우미가 쓴 사유) + 넘기는 줄과
//      「그록봇에게 맡기기」 — 1440 light·dark, 390 light
//   2. 맡기기를 누른 뒤(보낸 본문을 로그로 남긴다)
//   3. 설정 › 워크스페이스 「oort 도우미」 스위치: 꺼짐 / 켜짐 / 이름 겹침 409
//   4. 스위치를 모르는 서버(물음이 unknown key): 카드 없음
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3836.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CAPTURE_PORT || 5236);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/3836");

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HANEUL = "019f94e3-7a10-79cd-9dee-208f47edd9b1";
const HELPER = "019f9a01-0000-7000-8000-000000000501";
const GROK = "019f9a01-0000-7000-8000-000000000502";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000036a1";
const SOURCE_ID = "msg-3836-3";
const DELEGATE_KEY = "0e5fa1d0-c0de-5201-9d00-7e4a11a12023";
const BASE_MS = Date.parse("2026-10-15T01:12:00.000Z");

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://capture-3836.invalid/connection/websocket",
};

const CHANNELS = [
  { id: CHANNEL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "운영", muted: false },
];

function member(id, kind, displayName, handle, extra = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    kind,
    status: "active",
    role: kind === "human" ? "owner" : "member",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...extra,
  };
}

const ROSTER = [
  member(ME, "human", "곽성재", "seongjae"),
  member(HANEUL, "human", "김하늘", "haneul", { role: "member" }),
  member(HELPER, "agent", "oort 도우미", "oort-helper", { ownerHumanId: ME }),
  member(GROK, "agent", "그록봇", "grokbot", { ownerHumanId: ME }),
];

// PR #3837 `propose_in_tx` 가 싣는 모양.
const APPROVAL_PROPS = {
  approval_id: APPROVAL_ID,
  run_id: "0199aa11-2222-7000-8000-0000000036b2",
  channel_id: CHANNEL_ID,
  action_type: "workspace_action",
  status: "pending",
  expires_at_ms: Date.now() + 3_600_000,
  title: "에이전트 프로필 바꾸기",
  action: {
    id: "agent.profile.update",
    rows: [
      { label: "에이전트", value: "그록봇" },
      { label: "소개", value: "주간 리포트 담당" },
    ],
    rationale: "김하늘 님이 그록봇 소개를 주간 리포트 담당으로 바꿔 달라고 했어요.",
    required_role: "admin",
  },
  proposed_via: { kind: "team_ai", requester_id: HANEUL, requester_name: "김하늘" },
};

// PR #3837 `fallback_props` 가 싣는 모양.
const DELEGATE_PROPS = {
  source: "team_ai_fallback",
  kind: "team_ai.delegate.v1",
  reason: "out_of_scope",
  agent_member_id: HELPER,
  notice_for_member_id: ME,
  run_id: "0199aa11-2222-7000-8000-0000000036c3",
  delegate: {
    source_message_id: SOURCE_ID,
    candidates: [
      { member_id: GROK, handle: "grokbot", display_name: "그록봇", client_msg_id: DELEGATE_KEY },
    ],
  },
};

const MESSAGES = [
  { id: "msg-3836-1", author: HANEUL, type: "text", body: "@oort-helper 그록봇 소개를 「주간 리포트 담당」으로 바꿔 줘" },
  { id: "msg-3836-2", author: HELPER, type: "approval_request", body: "에이전트 프로필 바꾸기", props: APPROVAL_PROPS },
  { id: SOURCE_ID, author: ME, type: "text", body: "@oort-helper oort 레포에서 깨진 웹 테스트 고쳐서 PR 올려 줘" },
  {
    id: "msg-3836-4",
    author: HELPER,
    type: "text",
    body: "이건 제가 바로 처리하기엔 큰 일이에요. 다른 에이전트에게 맡길 수 있어요.",
    props: DELEGATE_PROPS,
    replyToId: SOURCE_ID,
  },
];

function rows(list) {
  return list.map((row, index) => ({
    id: row.id,
    channelId: CHANNEL_ID,
    seq: 3100 + index,
    hlcTs: BASE_MS + index * 60_000,
    hlcCount: 0,
    authorMemberId: row.author,
    type: row.type,
    body: row.body,
    state: "sent",
    ...(row.props ? { props: row.props } : {}),
    ...(row.replyToId ? { replyToId: row.replyToId } : {}),
    createdAtMs: BASE_MS + index * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const WORKSPACE = {
  id: WORKSPACE_ID,
  slug: "oort-team",
  name: "oort 팀",
  updatedAtMs: BASE_MS,
  roleLabels: {},
  welcomePrompt: "",
  subscriptionAgentsEnabled: false,
};

/**
 * settings: "known-off" 가방에 false, "fresh" 키 없음 + 서버가 앎, "old" 키 없음 + 구서버.
 * enable: "ok" | "taken".
 */
async function installMocks(context, { settings = "known-off", enable = "ok", sent = [] } = {}) {
  let bag = settings === "known-off" ? { team_ai_fast_path: false } : {};
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken })
  );
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: ROSTER }));
  const readStates = [
    { channel_id: CHANNEL_ID, last_read_seq: 3103, latest_seq: 3103, unread_count: 0, mention_count: 0 },
  ];
  await context.route("**/v1/workspaces/*/read-state", (route) => json(route, { read_states: readStates }));
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) => json(route, readStates[0]));
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) =>
    json(route, { huddle: null, participants: [] })
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      sent.push(body);
      await new Promise((r) => setTimeout(r, 300));
      return json(route, {
        id: "msg-3836-5",
        channelId: CHANNEL_ID,
        seq: 3104,
        hlcTs: BASE_MS + 300_000,
        hlcCount: 0,
        authorMemberId: ME,
        type: "text",
        body: body.body,
        state: "sent",
        clientMsgId: body.clientMsgId,
        replyToId: body.replyToId,
        createdAtMs: BASE_MS + 300_000,
      });
    }
    return json(route, { messages: rows(MESSAGES) });
  });
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}`, (route) => json(route, { workspace: WORKSPACE }));
  await context.route("**/v1/workspaces/*/unfurl-settings", (route) => json(route, { enabled: true }));
  await context.route("**/v1/workspaces/*/settings", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return json(route, bag);
    const body = request.postDataJSON();
    const value = body.team_ai_fast_path;
    if (typeof value !== "boolean") {
      // 서버 `merge_workspace_settings` 의 두 문장(#3837 전·후).
      return json(
        route,
        {
          error: {
            code: "bad_request",
            message:
              settings === "old"
                ? "unknown settings key: team_ai_fast_path"
                : "team_ai_fast_path must be true or false",
          },
        },
        400
      );
    }
    await new Promise((r) => setTimeout(r, 400));
    if (value && enable === "taken") {
      return json(
        route,
        {
          error: {
            code: "team_ai_unavailable",
            message: "the 'oort-helper' handle is taken; rename that agent first",
          },
        },
        409
      );
    }
    bag = { ...bag, team_ai_fast_path: value, ...(value ? { team_ai_agent_member_id: HELPER } : {}) };
    return json(route, bag);
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function login(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return page;
}

async function openChannel(context) {
  const page = await login(context);
  await page.evaluate((id) => {
    location.hash = `/c/${id}`;
  }, CHANNEL_ID);
  await page.getByTestId("team-ai-delegate").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  return page;
}

async function openSettings(context) {
  const page = await login(context);
  await page.evaluate(() => {
    location.hash = "/settings?section=workspace";
  });
  await page.getByTestId("workspace-page").waitFor({ state: "visible" });
  await page.waitForTimeout(800);
  return page;
}

async function raise(page, testId) {
  await page
    .locator(`[data-testid="${testId}"]`)
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "auto" }));
  await page.waitForTimeout(300);
}

function newContext(browser, { width, scheme }) {
  return browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  process.on("exit", () => server.kill("SIGTERM"));
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      // 1. 타임라인: 카드 + 넘기는 줄
      for (const [width, scheme] of [
        [1440, "light"],
        [1440, "dark"],
        [390, "light"],
      ]) {
        const context = await newContext(browser, { width, scheme });
        const sent = [];
        await installMocks(context, { sent });
        const page = await openChannel(context);
        await raise(page, "agent-card");
        await page.screenshot({ path: `${OUT_DIR}/c3836-1-timeline-${width}-${scheme}.png` });
        if (width === 1440 && scheme === "light") {
          await raise(page, "team-ai-delegate");
          await page.getByTestId("team-ai-delegate-button").first().click();
          await page.getByTestId("team-ai-delegate-sent").waitFor({ timeout: 5000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${OUT_DIR}/c3836-2-delegated-${width}-${scheme}.png` });
          console.log(`  맡기기 POST: ${JSON.stringify(sent)}`);
          if (sent.length !== 1 || sent[0].clientMsgId !== DELEGATE_KEY) {
            throw new Error("맡기기 요청 모양이 다르다");
          }
          if (String(sent[0].body).includes("@oort-helper")) {
            throw new Error("도우미 멘션이 남았다");
          }
        }
        await context.close();
      }

      // 3. 설정: 꺼짐 → 켜짐, 그리고 이름 겹침
      for (const scheme of ["light", "dark"]) {
        const context = await newContext(browser, { width: 1440, scheme });
        await installMocks(context, { settings: "fresh" });
        const page = await openSettings(context);
        await page.getByTestId("workspace-team-ai-card").waitFor({ timeout: 5000 });
        await raise(page, "workspace-unfurl-card");
        await page.screenshot({ path: `${OUT_DIR}/c3836-3-settings-off-1440-${scheme}.png` });
        if (scheme === "light") {
          await page.getByTestId("workspace-team-ai").click();
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="workspace-team-ai"]')?.getAttribute("aria-checked") ===
                "true" && !document.querySelector('[data-testid="workspace-team-ai-card"]')?.textContent?.includes("켜는 중")
          );
          await page.screenshot({ path: `${OUT_DIR}/c3836-3-settings-on-1440-${scheme}.png` });
        }
        await context.close();
      }
      {
        const context = await newContext(browser, { width: 1440, scheme: "light" });
        await installMocks(context, { settings: "known-off", enable: "taken" });
        const page = await openSettings(context);
        await page.getByTestId("workspace-team-ai").click();
        await page.getByTestId("workspace-team-ai-save-error").waitFor({ timeout: 5000 });
        await raise(page, "workspace-unfurl-card");
        await page.screenshot({ path: `${OUT_DIR}/c3836-3-settings-taken-1440-light.png` });
        await context.close();
      }
      {
        const context = await newContext(browser, { width: 390, scheme: "light" });
        await installMocks(context, { settings: "fresh" });
        const page = await openSettings(context);
        await page.getByTestId("workspace-team-ai-card").waitFor({ timeout: 5000 });
        await raise(page, "workspace-team-ai-card");
        await page.screenshot({ path: `${OUT_DIR}/c3836-3-settings-off-390-light.png` });
        await context.close();
      }

      // 4. 구서버: 카드 없음
      {
        const context = await newContext(browser, { width: 1440, scheme: "light" });
        await installMocks(context, { settings: "old" });
        const page = await openSettings(context);
        await page.waitForTimeout(1200);
        const count = await page.getByTestId("workspace-team-ai-card").count();
        console.log(`  구서버 도우미 카드 수: ${count}`);
        if (count !== 0) throw new Error("구서버에 카드가 섰다");
        await raise(page, "workspace-unfurl-card");
        await page.screenshot({ path: `${OUT_DIR}/c3836-4-settings-old-server-1440-light.png` });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
