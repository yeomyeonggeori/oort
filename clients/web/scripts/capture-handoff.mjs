#!/usr/bin/env node
// =============================================================================
// CAPTURE: 로그인 핸드오프 카드의 상태별 증거 (LIVE-4 / ADR-0004 증보 3).
//
// 게이트가 아니라 **증거**다. 판정은 두 가지만 하고(카드가 실제로 그려졌는가,
// 비활성 컨트롤이 하나도 없는가) 나머지는 사진이다.
//
// 왜 `capture-screens.mjs` 에 얹지 않았는가: 그 스크립트의 픽스처는 순환
// 배열이라(`BODIES[i % BODIES.length]`) 행을 하나 더하면 꼬리에서 상태를
// 골라 쓰는 다른 프레임들의 자리가 통째로 밀린다. 한 카드의 사진을 얻으려고
// 다른 열 장의 픽스처를 흔드는 것은 값이 맞지 않는다.
//
// 찍는 상태 넷은 카드가 가질 수 있는 국면 전부다:
//   waiting        에이전트가 세워져 있고, 사람이 할 일이 남아 있다
//   in-control     누군가 지금 그 화면을 잡고 있다 (컨트롤이 서지 않는다)
//   resolved       개입이 끝났다 — `expired`, 즉 「완료 불확실」
//   stopped        사람이 run 을 멈췄다
// 그리고 무장 상태 **둘**을 찍는다: 재개 확정과 중단 확정. 되돌릴 수 없는
// 액션의 확인 문구는 사진으로 읽혀야 하는 것 중 하나이고, 이 카드에서 실제로
// 무언가를 취소하는 쪽은 중단이다 — 그 문장이 사진에 없으면 증거가 반쪽이다
// (design-review M2).
//
// ## 칩이 사진을 먹던 자리 (design-review M2)
//
// 앞 판은 촬영 **전에 한 번** 「최신 메시지로 이동」 칩을 치우고, 그다음
// 카드마다 `scrollIntoViewIfNeeded` 를 불렀다. 그 호출이 바로 그 칩을 다시
// 부른다: 칩은 「바닥에 있지 않다」의 함수라(`Timeline.tsx` 의 `!atBottom`)
// 위로 스크롤하는 순간 되살아나고, 아래로 최소 이동한 카드는 뷰포트 **바닥**에
// 착지해 그 칩과 겹쳤다. 12장 중 6장에서 카드 글자가 가려졌고, 하필 in-control
// 카드의 blocked 줄이 그중 하나였다.
//
// 그래서 두 가지를 바꿨다. 카드를 **뷰포트 위쪽**에 세우고(`block: "start"`),
// 매 장 찍기 직전에 칩과 카드의 겹침 넓이를 재서 0 이 아니면 던진다. 사람이
// 사진을 넘겨보며 알아채야 하는 일이 아니라 스크립트가 지는 단정이다.
//
//   npm run build && node scripts/capture-handoff.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-handoff.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.HANDOFF_CAPTURE_PORT || 5194);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/handoff");
const VIEWPORT = { width: 1280, height: 800 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f9a01-0000-7000-8000-000000000401";
const SESSION_ID = "019fa1c4-3b21-7d0e-9aa1-5e6c82f41b77";

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
  realtimeWebSocketUrl: "ws://handoff-capture.invalid/connection/websocket",
};

const CHANNELS = [
  {
    id: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "배포",
    muted: false,
  },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: HERMES,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "hermes",
    handle: "hermes",
    ownerMemberId: ME,
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: ["code"],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const BASE_MS = Date.parse("2026-08-16T05:12:00.000Z");

/**
 * 카드 하나의 props.
 *
 * 서버가 실제로 싣는 모양 그대로다 (`momo_agent::approval::apply_login_handoff_props`
 * + `stamp_control_window_on_cards_in_tx`). `arguments` 를 남겨 두는 것이 요점의
 * 절반이다: 그 키는 클라이언트의 허용 목록에 없어 화면 어디에도 나타나면 안 되고,
 * 사진이 그 부재를 보여 준다.
 */
function handoffProps(over = {}) {
  return {
    kind: "login_handoff",
    approval_id: "0199aa11-2222-7000-8000-0000000000a1",
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: CHANNEL_ID,
    action_type: "tool_call",
    tool_name: "work.session.login_handoff",
    call_id: "call_7c02",
    session_id: SESSION_ID,
    summary:
      "배포 콘솔이 2단계 인증을 요구합니다. 세션 화면에서 직접 로그인해 주세요.",
    arguments: JSON.stringify({
      session_id: SESSION_ID,
      reason: "배포 콘솔이 2단계 인증을 요구합니다.",
    }),
    status: "pending",
    expires_at_ms: BASE_MS + 3_600_000,
    ...over,
  };
}

const MESSAGES = [
  {
    author: ME,
    body: "@hermes 스테이징 배포 로그 확인하고, 막히면 알려줘요.",
    type: "text",
  },
  {
    author: HERMES,
    body: "배포 콘솔에 접속했는데 로그인 화면입니다.",
    type: "text",
  },
  {
    author: HERMES,
    body: "Approval required: work.session.login_handoff",
    type: "approval_request",
    props: handoffProps(),
  },
  {
    author: HERMES,
    body: "Approval required: work.session.login_handoff",
    type: "approval_request",
    props: handoffProps({
      approval_id: "0199aa11-2222-7000-8000-0000000000a2",
      summary: "사내 위키가 SSO 재인증을 요구합니다.",
      control_started_at_ms: BASE_MS + 120_000,
    }),
  },
  {
    author: HERMES,
    body: "Approval required: work.session.login_handoff",
    type: "approval_request",
    props: handoffProps({
      approval_id: "0199aa11-2222-7000-8000-0000000000a3",
      summary: "레지스트리 토큰이 만료돼 다시 로그인해야 합니다.",
      approval_status: "approved",
      decided_by: ME,
      decided_at_ms: BASE_MS + 420_000,
      control_started_at_ms: BASE_MS + 240_000,
      control_ended_at_ms: BASE_MS + 390_000,
      control_end_reason: "expired",
    }),
  },
  {
    author: HERMES,
    body: "Approval required: work.session.login_handoff",
    type: "approval_request",
    props: handoffProps({
      approval_id: "0199aa11-2222-7000-8000-0000000000a4",
      summary: "결제 콘솔 로그인이 필요합니다.",
      approval_status: "rejected",
      decided_by: ME,
      decided_at_ms: BASE_MS + 500_000,
    }),
  },
];

function messages() {
  return MESSAGES.map((row, index) => ({
    id: `handoff-capture-${index + 1}`,
    channelId: CHANNEL_ID,
    seq: 2100 + index,
    hlcTs: BASE_MS + index * 60_000,
    hlcCount: 0,
    authorMemberId: row.author,
    type: row.type,
    body: row.body,
    state: "sent",
    ...(row.props ? { props: row.props } : {}),
    createdAtMs: BASE_MS + index * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, {
      accessToken: SESSION.accessToken,
      refreshToken: SESSION.refreshToken,
    })
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
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  const READ_STATES = [
    {
      channel_id: CHANNEL_ID,
      last_read_seq: 2105,
      latest_seq: 2105,
      unread_count: 0,
      mention_count: 0,
    },
  ];
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  // 허들은 이 배치의 주제가 아니고, 본문 없는 404는 셸에 붉은 줄을 세운다.
  // 사진에서 그 줄이 카드보다 먼저 눈에 들어오면 증거가 자기 일을 못 한다.
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) =>
    json(route, { huddle: null, participants: [] })
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) =>
    json(route, { messages: messages() })
  );
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
    if (Date.now() > deadline) {
      throw new Error(`preview server never came up: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return page;
}

/**
 * 어포던스 부재의 자 (LIVE-4 AC-4).
 *
 * 사진은 「이 버튼이 눌리지 않는다」를 보여 주지 않는다. 그래서 여기서 잰다:
 * 핸드오프 카드 안에 `disabled` 도 `aria-disabled` 도 하나도 없어야 한다.
 * 영원히 눌리지 않는 컨트롤은 사람에게 자기가 뭘 잘못했는지 묻게 만들고,
 * 그것이 이 카드가 문장으로 답하기로 한 이유다.
 */
const DISABLED_IN_HANDOFF_CARDS = `(() => {
  const cards = [...document.querySelectorAll('[data-card-kind="login_handoff"]')];
  return {
    cards: cards.length,
    disabled: cards.reduce(
      (n, card) =>
        n + card.querySelectorAll("[disabled],[aria-disabled='true']").length,
      0
    ),
  };
})()`;

/**
 * 「최신 메시지로 이동」 칩이 이 카드를 몇 px² 가리고 있는가.
 *
 * 사진은 자기가 무엇에 가려졌는지 말하지 않는다. 그래서 여기서 잰다 — 카드
 * 사진은 페이지의 그 사각형을 그대로 뜨므로, 겹친 칩은 그대로 사진에 들어간다.
 */
async function chipOverlap(page, card) {
  const jump = page.getByTestId("jump-latest");
  if (!(await jump.isVisible().catch(() => false))) return 0;
  const [chip, box] = await Promise.all([jump.boundingBox(), card.boundingBox()]);
  if (chip === null || box === null) return 0;
  const w = Math.min(chip.x + chip.width, box.x + box.width) - Math.max(chip.x, box.x);
  const h = Math.min(chip.y + chip.height, box.y + box.height) - Math.max(chip.y, box.y);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
}

/**
 * 카드 한 장. 뷰포트 **위쪽**에 세우고, 칩이 가리지 않는 것을 확인한 뒤 찍는다.
 *
 * `scrollIntoViewIfNeeded` 를 쓰지 않는 이유가 이 함수의 전부다: 그것은 최소
 * 이동이라 아래에 있는 카드를 뷰포트 **바닥**에 붙이고, 바닥은 칩이 사는 자리다.
 */
async function shootCard(page, card, path) {
  await card.evaluate((el) =>
    el.scrollIntoView({ block: "start", behavior: "auto" })
  );
  await page.waitForTimeout(400);
  const covered = await chipOverlap(page, card);
  if (covered > 0) {
    throw new Error(
      `${path}: 「최신 메시지로 이동」 칩이 카드를 ${covered}px² 가린다 ` +
        `(이 배치가 찍으려는 것은 카드다)`
    );
  }
  await card.screenshot({ path });
  return path;
}

/** 타임라인을 바닥으로. 칩은 바닥에서 스스로 사라진다(`!atBottom`). */
async function goToBottom(page, cards) {
  await cards.last().scrollIntoViewIfNeeded();
  const jump = page.getByTestId("jump-latest");
  if (await jump.isVisible().catch(() => false)) await jump.click();
  await page.waitForTimeout(600);
  if (await jump.isVisible().catch(() => false)) {
    throw new Error("바닥에 내려갔는데도 「최신 메시지로 이동」 칩이 남아 있다");
  }
}

/**
 * 확정 문장이 **코어의 것 그대로**인지.
 *
 * 문장을 이 파일에 적어 두면, 문장이 고쳐지는 날 증거 스크립트가 그 수리를
 * 막는다(`composerCopy.test.ts` 가 게이트에 대해 같은 말을 한다). 그래서 화면에서
 * 읽은 문장이 코어 소스 안에 있는지만 본다.
 */
const CORE_HANDOFF_SRC = readFileSync(
  resolve(WEB_ROOT, "../../packages/momo-core/src/features/timeline/loginHandoffCard.ts"),
  "utf8"
);

async function armAndShoot(page, card, testId, path) {
  await card.evaluate((el) =>
    el.scrollIntoView({ block: "start", behavior: "auto" })
  );
  await page.getByTestId(testId).first().click();
  const confirm = page.getByTestId("handoff-confirm").first();
  await confirm.waitFor({ state: "visible" });
  const sentence = (await confirm.locator("span").first().innerText()).trim();
  if (!CORE_HANDOFF_SRC.includes(sentence)) {
    throw new Error(
      `${path}: 확정 문장이 코어의 것이 아니다 — 화면: ${JSON.stringify(sentence)}`
    );
  }
  return shootCard(page, card, path);
}

async function captureScheme(browser, scheme) {
  const shots = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await signIn(context);
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page
    .locator(`[data-testid="channel-list"] a[href="#/c/${CHANNEL_ID}"]`)
    .first()
    .click();
  const cards = page.locator('[data-card-kind="login_handoff"]');
  await cards.first().waitFor({ state: "visible" });
  await goToBottom(page, cards);

  const measured = await page.evaluate(DISABLED_IN_HANDOFF_CARDS);
  if (measured.cards !== 4) {
    throw new Error(
      `${scheme}: expected four handoff cards, found ${measured.cards}`
    );
  }
  if (measured.disabled !== 0) {
    throw new Error(
      `${scheme}: 핸드오프 카드에 비활성 컨트롤이 ${measured.disabled}개 있다 ` +
        `(어포던스는 부재로 두고 문장으로 말한다)`
    );
  }
  console.log(`  ${scheme}: cards=${measured.cards} disabled=${measured.disabled}`);

  // 전체 타임라인 한 장 — 네 카드가 한 대화 안에서 어떤 밀도로 서는지. **바닥에서**
  // 찍는다: 그것이 대화가 쉬고 있는 자세이고, 거기서는 칩이 아예 없다.
  const timeline = `${OUT_DIR}/handoff-timeline-${scheme}.png`;
  await page.screenshot({ path: timeline });
  shots.push(timeline);

  // 카드 넷을 각각. 전체 창을 찍으면 상태 사이의 차이가 스크롤 안에 묻힌다.
  const names = ["waiting", "in-control", "resolved-expired", "stopped"];
  for (let i = 0; i < names.length; i += 1) {
    shots.push(
      await shootCard(
        page,
        cards.nth(i),
        `${OUT_DIR}/handoff-${names[i]}-${scheme}.png`
      )
    );
  }

  // 무장 상태 둘. 되돌릴 수 없는 액션의 확인 문장은 사진으로 읽혀야 한다.
  shots.push(
    await armAndShoot(
      page,
      cards.first(),
      "handoff-approve",
      `${OUT_DIR}/handoff-armed-${scheme}.png`
    )
  );
  // 무장을 풀고 반대편으로. 중단은 이 카드에서 **실제로 무언가를 취소하는** 쪽이라
  // 그 확정 문장이야말로 사진에 있어야 하는 것이다.
  await page.getByTestId("handoff-cancel").first().click();
  await page.getByTestId("handoff-approve").first().waitFor({ state: "visible" });
  shots.push(
    await armAndShoot(
      page,
      cards.first(),
      "handoff-reject",
      `${OUT_DIR}/handoff-armed-stop-${scheme}.png`
    )
  );

  await context.close();
  return shots;
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
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const all = [];
      for (const scheme of ["light", "dark"]) {
        all.push(...(await captureScheme(browser, scheme)));
      }
      for (const path of all) console.log(path);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
