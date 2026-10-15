#!/usr/bin/env node
// =============================================================================
// CAPTURE: 워크스페이스 행동 카드 4장면 (AX-4 #2510 / ADR-0186 D4·D5)
//
// 1440 light. 찍는 것은 이 배치가 세운 카드의 생애 전부다:
//
//   pending        제안이 도착했다 — 행·사유·결정 권한이 카드 표면에 있다(부록 A)
//   link-once      승인 확정 직후, 버튼이 있던 자리에 링크가 선다(부록 C · ADR-0182 ①)
//   result         새로고침 뒤 남는 것 — 값 없는 영속 카드(부록 B)
//   role-required  403 — 「관리자가 승인해야 해요」와 다음 행동(§5)
//
// ## 왜 `capture-screens.mjs` 에 얹지 않았는가
//
// 그 스크립트의 채널 픽스처는 순환 배열이라(`BODIES[i % BODIES.length]`) 행을
// 더하면 꼬리에서 상태를 골라 쓰는 다른 프레임들의 자리가 통째로 밀린다 —
// `capture-handoff.mjs` 가 같은 이유로 자기 파일을 갖는다. 그리고 link-once 장면은
// **시간이 흘러야** 한다: `CONFIRM_GUARD_MS` 는 무장 뒤 400ms 를 기다리고, 저쪽
// 레인은 `Date` 를 얼려 두어 시간 게이트를 여는 장면을 아예 금지한다
// (`capture-clock.mjs`). 여기서는 시계를 얼리지 않으므로 그 문이 정상적으로 열린다.
//
// ## 서버는 아직 없다
//
// AX-3a/3b 가 랜딩하기 전이라 REST 는 **ADR-0186 부록 A·B·C 샘플 JSON** 으로
// 채운다. 부록이 지금의 계약이고, 랜딩 뒤 실샘플로 갈아 끼우는 자리가 여기다.
//
//   npm run build && node scripts/capture-actions.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-actions.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ACTIONS_CAPTURE_PORT || 5197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/actions");
const DESKTOP = { width: 1440, height: 900 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f9a01-0000-7000-8000-000000000401";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";
const INVITE_ID = "0199aa11-2222-7000-8000-0000000000f1";
const BASE_MS = Date.parse("2026-09-22T05:12:00.000Z");

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
  realtimeWebSocketUrl: "ws://actions-capture.invalid/connection/websocket",
};

const CHANNELS = [
  {
    id: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "온보딩",
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

/** ADR-0186 부록 A 그대로. */
const APPROVAL_PROPS = {
  approval_id: APPROVAL_ID,
  run_id: "0199aa11-2222-7000-8000-0000000000b2",
  channel_id: CHANNEL_ID,
  action_type: "workspace_action",
  status: "pending",
  expires_at_ms: Date.now() + 3_600_000,
  title: "팀원 초대 링크 만들기",
  summary:
    "hermes가 제안했어요. 승인하면 관리자 권한으로 초대 링크를 만들어요.",
  action: {
    id: "invite.create",
    rows: [
      { label: "역할", value: "member" },
      { label: "사용 횟수", value: "1회" },
      { label: "만료", value: "7일" },
    ],
    rationale: "새 팀원 온보딩 요청",
    required_role: "admin",
  },
};

/** ADR-0186 부록 B 그대로. `next.href` 는 이 클라이언트에 실물이 있는 섹션이다. */
function actionResultProps(over = {}) {
  return {
    "momo.action_result": {
      v: 1,
      action_id: "invite.create",
      status: "executed",
      approval_id: APPROVAL_ID,
      decided_by: ME,
      ref: { type: "invite", id: INVITE_ID },
      rows: [
        { label: "역할", value: "member" },
        { label: "만료", value: "2026-09-29" },
      ],
      secret_shown_once: true,
      // **확정된 계약값** (AX-3b #2549): 서버는 `?section=members` 를 보낸다.
      // 부록 B 샘플의 `?section=invites` 는 이 클라이언트에 없는 섹션이었고,
      // 그 값이 오면 어떻게 되는지는 아래 세 번째 카드가 그대로 보여 준다.
      next: {
        label: "설정 › 멤버와 초대에서 보기",
        href: "/settings?section=members",
      },
      ...over,
    },
  };
}

/** ADR-0186 부록 C 그대로. 승인 성공에만 실린다. */
const SECRET_VALUE = "https://oort.example/join?code=Ab3-_xQ7mK";

const DECISION_OK = {
  approval_id: APPROVAL_ID,
  status: "approved",
  decided_by: ME,
  decided_at_ms: BASE_MS + 180_000,
  result: {
    actionId: "invite.create",
    ref: { type: "invite", id: INVITE_ID },
    secretOnce: {
      kind: "invite_link",
      value: SECRET_VALUE,
      expiresAtMs: BASE_MS + 604_800_000,
    },
  },
};

const MESSAGES = [
  {
    author: ME,
    type: "text",
    body: "@hermes 다음 주 합류하는 디자이너 초대 링크 하나 만들어 주세요.",
  },
  {
    author: HERMES,
    type: "approval_request",
    body: "팀원 초대 링크 만들기",
    props: APPROVAL_PROPS,
  },
];

function rows(list) {
  return list.map((row, index) => ({
    id: `actions-capture-${index + 1}`,
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

async function installMocks(context, { messages, decisionStatus }) {
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
  const readStates = [
    {
      channel_id: CHANNEL_ID,
      last_read_seq: 2105,
      latest_seq: 2105,
      unread_count: 0,
      mention_count: 0,
    },
  ];
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: readStates })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, readStates[0])
  );
  // 허들 404 는 셸에 붉은 줄을 세운다. 사진에서 그 줄이 카드보다 먼저 눈에
  // 들어오면 증거가 자기 일을 못 한다(`capture-handoff.mjs` 와 같은 이유).
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) =>
    json(route, { huddle: null, participants: [] })
  );
  // 결정. 200 이면 부록 C 를 그대로 돌려주고, 403 이면 영수증 스키마에 여전히
  // `pending` 인 승인을 싣는다(§5: 「approval 은 여전히 pending 이다」).
  // 403 은 영수증으로 답한다. 역할 부족은 봉투의 코드 칸이 아니라 **영수증의
  // `status: "role_required"`** 로 온다(AX-3b #2549 계약 확정).
  await context.route("**/v1/workspaces/*/approvals/*/decision", (route) =>
    decisionStatus === 403
      ? json(route, { approval_id: APPROVAL_ID, status: "role_required" }, 403)
      : json(route, DECISION_OK)
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) =>
    json(route, { messages: rows(messages) })
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

async function openChannel(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  // 주소로 간다. 390 에서 사이드바는 닫힌 서랍이라 목록의 줄을 누를 수 없다.
  await page.evaluate(
    (id) => {
      location.hash = `/c/${id}`;
    },
    CHANNEL_ID
  );
  await page.getByTestId("agent-card").first().waitFor({ state: "visible" });
  return page;
}

/** 승인 한 번 (#3819 — 확정 단계가 없다). 키보드로 민다. */
async function decide(page) {
  await page.getByTestId("approval-approve").first().focus();
  await page.keyboard.press("Enter");
}

/** 카드를 뷰포트 위쪽에 세운다. 최소 이동은 카드를 바닥의 칩 아래로 민다. */
async function raise(page, testId) {
  await page
    .locator(`[data-testid="${testId}"]`)
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "auto" }));
  await page.waitForTimeout(300);
}


// #3771: 승인 직후 카드가 다시 버튼을 그렸다. 서버는 결정을 방송하지 않으므로 REST가 주는
// 메시지는 계속 `pending`이다 — 이 목업이 그 낡은 스냅샷을 그대로 돌려준다.
const STALE_THEN_RESULT = [
  ...MESSAGES,
  {
    author: HERMES,
    type: "tool_result",
    body: "초대 링크를 만들었어요.",
    props: actionResultProps(),
  },
];

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
      const context = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: 2,
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      await installMocks(context, {
        messages: STALE_THEN_RESULT,
        decisionStatus: 200,
      });
      const page = await openChannel(context);
      const shot = (name) => page.screenshot({ path: `${OUT_DIR}/c3771-${name}-1440-light.png` });
      await raise(page, "agent-card");
      await shot("1-pending");
      const buttons = () => page.locator('[data-testid="approval-approve"]').count();
      if ((await buttons()) !== 1) throw new Error("대기 카드에 승인 버튼이 하나여야 한다");

      await decide(page);
      await page.getByTestId("approval-link-once").waitFor({ state: "visible" });
      await raise(page, "agent-card");
      await shot("2-just-approved");
      if ((await buttons()) !== 0) throw new Error("승인 직후 버튼이 남았다");

      // 카드가 새로 마운트되는 순간을 만든다: 다른 화면에 갔다 돌아온다.
      // REST는 여전히 낡은 `pending` 메시지를 준다.
      await page.evaluate(() => { location.hash = "/settings"; });
      await page.waitForTimeout(500);
      await page.evaluate((id) => { location.hash = `/c/${id}`; }, CHANNEL_ID);
      await page.getByTestId("agent-card").first().waitFor({ state: "visible" });
      await page.waitForTimeout(500);
      await raise(page, "agent-card");
      await shot("3-after-remount");
      const after = await buttons();
      const text = await page.locator('[data-testid="agent-card"]').first().innerText();
      console.log(`  재마운트 뒤 승인 버튼 ${after}개`);
      console.log(text.split("\n").filter(Boolean).join(" | "));
      if (after !== 0) throw new Error(`재마운트 뒤 승인 버튼이 ${after}개 되살아났다`);
      await context.close();
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
