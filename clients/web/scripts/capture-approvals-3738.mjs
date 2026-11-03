#!/usr/bin/env node
// =============================================================================
// #3738 · #3729 캡처: 에이전트가 올린 승인 카드를 놓치지 않게.
//
//   card-*        새 행동 카드 다섯 (channel.create · channel.member.add · agent.rename ·
//                 hosted.channels.grant · workspace.settings.update), 「자세히」를 연 모습.
//                 사이드바 채널 알약이 「작업 중」이 아니라 「승인 필요」인 것도 같은 사진에 있다.
//   inbox-tasks   인박스 「처리할 일」 — 행동 승인 줄이 우리말 제목으로 선다.
//   expiry-soon   만료 10분 전 경고 줄.
//   expired       만료 뒤: 컨트롤이 없고 「다시 요청」 → 입력창에 초안.
//
// 라이트·다크 × 1440×900. 백엔드는 없다: `/v1/**`는 고정 응답이다.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-approvals-3738.mjs
// =============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/approvals-3738");
const PORT = Number(process.env.CAPTURE_PORT || 5219);
const MIN = 60_000;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const agentId = "00000000-0000-7000-8000-000000000301";
const otherAgentId = "00000000-0000-7000-8000-000000000302";
const CH = "00000000-0000-7000-8000-000000000201";
const GENERAL = "00000000-0000-7000-8000-000000000202";
const person = (id, kind, displayName, handle, extra = {}) => ({
  id, workspaceId, kind, status: "active", displayName, handle, channelCount: 2,
  channelIds: [CH, GENERAL], capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
});
const roster = [
  person(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
  person(agentId, "agent", "그록봇", "grokbot", { ownerHumanId: memberId }),
  person(otherAgentId, "agent", "김인턴", "kim-intern", { ownerHumanId: memberId }),
];
const channels = [
  { id: CH, workspaceId, kind: "public", name: "계획", muted: false },
  { id: GENERAL, workspaceId, kind: "public", name: "general", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://approvals-capture.invalid/connection/websocket",
};

// ---- 카드 픽스처 (ADR-0186 증보 2026-10-11 부록 A 모양) -------------------------------
const CARDS = {
  "channel-create": {
    title: "채널 만들기",
    summary: "그록봇이 제안했습니다. 승인하면 관리자 권한으로 채널을 만듭니다.",
    role: "admin",
    id: "channel.create",
    rows: [
      { label: "채널", value: "#릴리스-점검" },
      { label: "공개 범위", value: "비공개" },
      { label: "주제", value: "10월 릴리스 점검" },
      { label: "이 에이전트도 참여", value: "예 (이 채널이 승인 채널에 들어가요)" },
      { label: "함께 넣을 멤버", value: "김 인턴" },
    ],
    rationale: "릴리스 점검 대화를 따로 모으고 싶다고 하셔서요.",
  },
  "member-add": {
    title: "채널에 멤버 추가",
    summary: "그록봇이 제안했습니다. 승인하면 관리자 권한으로 멤버를 넣습니다.",
    role: "admin",
    id: "channel.member.add",
    rows: [
      { label: "채널", value: "#계획" },
      { label: "현재 인원", value: "3명" },
      { label: "추가할 멤버", value: "김 인턴 (@kim-intern, 에이전트)" },
    ],
    rationale: "계획 채널에서 일정 정리를 맡기려고요.",
  },
  "agent-rename": {
    title: "에이전트 이름 바꾸기",
    summary: "그록봇이 다른 에이전트의 이름을 바꾸자고 제안했습니다.",
    role: "agent_editor",
    id: "agent.rename",
    rows: [
      { label: "대상 에이전트", value: "김인턴 (@kim-intern)" },
      { label: "이름 변경", value: "김인턴 → 일정 담당" },
    ],
    rationale: null,
  },
  "hosted-grant": {
    title: "승인 채널 늘리기",
    summary: "그록봇이 자기 연결의 승인 채널을 넓히자고 제안했습니다.",
    role: "admin",
    id: "hosted.channels.grant",
    rows: [
      { label: "추가 채널", value: "#계획 (공개, 4명)" },
      { label: "추가 채널", value: "#릴리스-점검 (비공개, 2명)" },
      { label: "승인 채널 수", value: "1개 → 3개" },
    ],
    rationale: "두 채널에서도 요청을 받으려고요.",
  },
  "settings-update": {
    title: "워크스페이스 설정 바꾸기",
    summary: "그록봇이 설정 두 가지를 바꾸자고 제안했습니다.",
    role: "workspace_operator",
    id: "workspace.settings.update",
    rows: [
      { label: "환영 문구", value: "\"여명거리에 오신 걸 환영해요\" → \"오르트에 오신 걸 환영해요. 궁금한 건 @grokbot 에게 물어보세요\"" },
      { label: "역할 이름 (admin)", value: "\"관리자\" → — 지움" },
    ],
    rationale: null,
  },
};

function cardProps(card, expiresAtMs, approvalId) {
  return {
    approval_id: approvalId,
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: CH,
    action_type: "workspace_action",
    status: "pending",
    expires_at_ms: expiresAtMs,
    title: card.title,
    summary: card.summary,
    action: {
      id: card.id,
      rows: card.rows,
      ...(card.rationale ? { rationale: card.rationale } : {}),
      required_role: card.role,
    },
  };
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** scene = { cards: [{key, expiresInMin, approvalId, messageId}], inbox } */
async function installRoutes(context, scene) {
  const now = Date.now();
  const messageRows = [
    {
      id: "00000000-0000-7000-8000-0000000a0001", channelId: CH, seq: 10, hlcTs: now - 6 * MIN, hlcCount: 0,
      authorMemberId: memberId, type: "text",
      body: "@grokbot 릴리스 점검용으로 정리 좀 해 줄래요?", state: "sent", createdAtMs: now - 6 * MIN,
    },
    ...scene.cards.map((c, i) => ({
      id: c.messageId, channelId: CH, seq: 11 + i, hlcTs: now - 5 * MIN, hlcCount: 0,
      authorMemberId: agentId, type: "approval_request", body: CARDS[c.key].title, state: "sent",
      createdAtMs: now - 5 * MIN,
      props: cardProps(CARDS[c.key], now + c.expiresInMin * MIN, c.approvalId),
    })),
  ];
  const approvals = scene.cards.map((c) => ({
    id: c.approvalId, workspaceId, runId: "0199aa11-2222-7000-8000-0000000000b2", channelId: CH,
    requestMessageId: c.messageId, requestedBy: agentId, actionType: "workspace_action",
    payload: { action: { id: CARDS[c.key].id, args: {}, rationale: null }, proposed_by: agentId, resume_model: null },
    status: "pending", expiresAtMs: now + c.expiresInMin * MIN, createdAtMs: now - 5 * MIN,
  }));
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    // 구 서버 후퇴 경로: 인박스 투영이 없으면 처리할 일은 승인 원장에서 온다.
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
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: { id: workspaceId, name: "여명거리" } });
    if (path.includes(`/channels/${CH}/messages`)) return json(route, { messages: messageRows });
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

let counter = 0;
function cardSpec(key, expiresInMin) {
  counter += 1;
  const n = String(counter).padStart(4, "0");
  return {
    key,
    expiresInMin,
    approvalId: `0199aa11-2222-7000-8000-00000000${n}`,
    messageId: `00000000-0000-7000-8000-0000000b${n}`,
  };
}

async function open(browser, origin, scheme, scene, hash) {
  const context = await browser.newContext({
    // 문구는 한국어 사전으로 읽는다: 기기 언어를 ko-KR 로 고정한다(헤드리스 기본은 en-US). 경고 줄 문장이 사전 키다(#5174 L7).
    viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block",
    locale: "ko-KR", timezoneId: "Asia/Seoul",
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
  // 로그인 뒤 셸이 섰다는 신호: 사이드바 채널 줄(옛 `nav-team` test id 는 앱에서 사라졌다).
  await page.getByTestId("channel-item").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  return { context, page };
}

/** 묶음 카드의 「자세히」를 연다(#4986). 서버 행·결정 권한은 접힌 안에만 있고, 닫힌 안은 DOM 에도 없다. */
async function openDetails(page) {
  const details = page.getByTestId("agent-card").first().getByTestId("request-bundle-details");
  await details.locator("summary").click();
  // 본문 목록이 먼저이고, 원본 보기(`agent-payload`) 안에도 목록이 하나 더 있어 첫 것만 기다린다.
  await details.locator("dl").first().waitFor({ timeout: 5_000 });
}

async function raise(page) {
  await page.locator('[data-testid="agent-card"]').first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "auto" }));
  await page.waitForTimeout(400);
}

// `ONLY=expiry-soon` 처럼 장면 이름(cards · inbox · expiry-soon · expired, 쉼표로 여럿)을 주면 그것만 돈다. 비우면 넷 다 돈다(검증 줄 기본).
// 넷 모두 지금 화면에서 초록이다(#5251): ①은 묶음 카드의 「자세히」를 열어 읽고, ③은 #5174 L7 의 한 줄 시간 말을 잰다.
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const runs = (name) => ONLY.length === 0 || ONLY.includes(name);

async function scenes(browser, origin, scheme) {
  const tag = `1440-${scheme}`;
  const shotPath = (name) => resolve(OUT_DIR, `${name}-${tag}.png`);

  // ① 새 행동 카드 다섯
  if (runs("cards")) for (const key of Object.keys(CARDS)) {
    const spec = cardSpec(key, 52);
    const { context, page } = await open(browser, origin, scheme, { cards: [spec] }, `/c/${CH}`);
    await page.getByTestId("agent-card").first().waitFor({ timeout: 15_000 });
    await raise(page);
    // 한 줄로 접힌 카드가 기본이다(#4986). 행·권한 문장은 「자세히」를 열어야 읽고, 사진에도 열린 카드가 찍힌다.
    await openDetails(page);
    await raise(page);
    const shown = await page.locator('[data-testid="approval-action-row"]').evaluateAll((els) =>
      els.map((el) => ({
        label: el.querySelector("dt")?.textContent ?? "",
        // 접근 범위 강조 줄은 서버 값 밑에 덧붙는 한 줄이라 값에서 뺀다.
        value: [...(el.querySelector("dd")?.childNodes ?? [])]
          .filter((n) => !(n instanceof Element && n.matches('[data-testid="approval-access-widening"]')))
          .map((n) => n.textContent ?? "")
          .join(""),
      }))
    );
    check(`${tag} card-${key}: 서버 행 ${CARDS[key].rows.length}개가 보낸 순서·글 그대로 선다`, JSON.stringify(shown) === JSON.stringify(CARDS[key].rows), JSON.stringify(shown));
    // 값 칸(`dd`)을 통째로 같음 비교한다. `includes`는 「관리자만 승인할 수 있어요.」가 다른 역할 문장
    // 「대상 에이전트의 소유자 또는 관리자만 …」의 꼬리라서 틀린 문장도 통과시켰다.
    const roleText = (await page.getByTestId("approval-action-role").locator("dd").textContent()) ?? "";
    const expectRole = {
      admin: "관리자만 승인할 수 있어요.",
      agent_editor: "대상 에이전트의 소유자 또는 관리자만 승인할 수 있어요.",
      workspace_operator: "워크스페이스 운영자(관리자)만 승인할 수 있어요.",
    }[CARDS[key].role];
    check(`${tag} card-${key}: 결정 권한 문장`, roleText === expectRole, roleText);
    if (key === "channel-create") {
      check(`${tag} card-channel-create: 접근 범위 강조 줄`, (await page.getByTestId("approval-access-widening").count()) === 1);
    }
    // 사이드바 채널 알약: 승인 원장이 레일보다 이긴다.
    const pill = page.locator('[data-testid="channel-item"][data-channel-id="' + CH + '"] [data-testid="agent-turn-badge"]');
    await pill.waitFor({ timeout: 10_000 });
    // 알약 낱말은 요청 고리 사전의 「승인 필요」다(#4760 이 「승인 대기」를 대신했다). 상태값은 그대로 awaiting_approval.
    check(`${tag} card-${key}: 채널 알약이 「승인 필요」`, ((await pill.textContent()) ?? "").includes("승인 필요") && (await pill.getAttribute("data-state")) === "awaiting_approval");
    await page.screenshot({ path: shotPath(`card-${key}`) });
    await context.close();
  }

  // ② 처리할 일
  if (runs("inbox")) {
    const specs = [cardSpec("channel-create", 52), cardSpec("agent-rename", 41), cardSpec("settings-update", 28)];
    const { context, page } = await open(browser, origin, scheme, { cards: specs }, "/inbox");
    await page.getByTestId("inbox-route").waitFor();
    const rowsLoc = page.locator("[data-testid='mailbox-row']");
    await rowsLoc.first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    const text = (await rowsLoc.allTextContents()).join(" | ");
    check(`${tag} inbox-tasks: 행동 승인 줄이 우리말 제목`, text.includes("채널 만들기 허가를 요청했어요") && text.includes("에이전트 이름 바꾸기 허가를 요청했어요") && !text.includes("workspace_action"), text);
    await rowsLoc.first().click();
    await page.waitForTimeout(500);
    // 문이 없으면 건너뛰지 않고 붉게 한다: `if (count)`로 감싸면 문이 사라진 날 이 확인이 조용히 초록이 된다.
    const door = page.getByTestId("inbox-open-conversation");
    const doorShown = await door.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const href = doorShown ? ((await door.getAttribute("href")) ?? "") : "";
    check(`${tag} inbox-tasks: 「대화에서 보기」가 그 카드로 간다`, doorShown && href.includes("?msg=") && href.includes(specs[0].messageId.toLowerCase()), doorShown ? href : "문이 없어요");
    await page.screenshot({ path: shotPath("inbox-tasks") });
    await context.close();
  }

  // ③ 만료 10분 전 경고
  if (runs("expiry-soon")) {
    const spec = cardSpec("channel-create", 8);
    const { context, page } = await open(browser, origin, scheme, { cards: [spec] }, `/c/${CH}`);
    await page.getByTestId("agent-card").first().waitFor({ timeout: 15_000 });
    await raise(page);
    const warn = page.getByTestId("approval-note-expiry-soon");
    await warn.waitFor({ timeout: 5_000 });
    const t = (await warn.textContent()) ?? "";
    // #5174 L7: 경고 줄은 결과만 말하고, 남은 시간은 조용한 줄이 한 번만 말한다(카드 글의 시간 말이 정확히 하나).
    check(`${tag} expiry-soon: 경고 줄은 시간 없이 결과만`, t === "결정하지 않으면 에이전트가 다시 제안해야 해요.", t);
    const cardText = (await page.getByTestId("agent-card").first().textContent()) ?? "";
    const timeWords = cardText.match(/\d+\s*분 안에 만료돼요|\d+\s*(?:분|시간|일) 남음/g) ?? [];
    check(`${tag} expiry-soon: 카드의 시간 말은 하나`, timeWords.length === 1 && timeWords[0] === "10분 안에 만료돼요", JSON.stringify(timeWords));
    check(`${tag} expiry-soon: 승인 컨트롤은 그대로`, (await page.getByTestId("approval-approve").count()) === 1);
    await page.screenshot({ path: shotPath("expiry-soon") });
    await context.close();
  }

  // ④ 만료 뒤
  if (runs("expired")) {
    const spec = cardSpec("channel-create", -3);
    const { context, page } = await open(browser, origin, scheme, { cards: [spec] }, `/c/${CH}`);
    await page.getByTestId("agent-card").first().waitFor({ timeout: 15_000 });
    await raise(page);
    check(`${tag} expired: 승인 컨트롤이 없다`, (await page.getByTestId("approval-approve").count()) === 0);
    await page.getByTestId("approval-repropose").click();
    await page.getByTestId("approval-repropose-note").waitFor();
    const composer = page.locator("form textarea").first();
    const value = (await composer.count()) ? await composer.inputValue() : "";
    check(`${tag} expired: 입력창에 @grokbot 초안`, value.startsWith("@grokbot "), value);
    await page.screenshot({ path: shotPath("expired") });
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
  if (failures.length > 0) {
    console.error(`\n${failures.length}개 단언 실패`);
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
