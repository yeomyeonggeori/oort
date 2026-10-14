#!/usr/bin/env node
// =============================================================================
// CAPTURE (#3818): 서버가 이미 결정한 옛 승인 카드 — 1440 light.
//
// 배포 전에 결정된 카드는 영수증 저장소가 모른다. props 에 status/decided_by 만 있는
// 카드가 거부/승인 버튼을 다시 그리던 결함의 증거 사진이다.
//
//   npm run build && OUT_DIR=<dir> node scripts/capture-3818.mjs
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

const DECIDED_PROPS = {
  ...APPROVAL_PROPS,
  status: "approved",
  approval_status: "approved",
  decided_by: ME,
  decided_at_ms: BASE_MS + 180_000,
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
    props: DECIDED_PROPS,
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

/** 카드를 뷰포트 위쪽에 세운다. 최소 이동은 카드를 바닥의 칩 아래로 민다. */
async function raise(page, testId) {
  await page
    .locator(`[data-testid="${testId}"]`)
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "auto" }));
  await page.waitForTimeout(300);
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
      const context = await browser.newContext({
        viewport: DESKTOP,
        deviceScaleFactor: 2,
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      await installMocks(context, { messages: MESSAGES, decisionStatus: 200 });
      const page = await openChannel(context);
      await raise(page, "agent-card");
      await page.screenshot({ path: `${OUT_DIR}/c3818-old-decided-card-1440-light.png` });
      const approve = await page.locator('[data-testid="approval-approve"]').count();
      const reject = await page.locator('[data-testid="approval-reject"]').count();
      const text = await page.locator('[data-testid="agent-card"]').first().innerText();
      console.log(text.split("\n").filter(Boolean).join(" | "));
      console.log(`  승인 버튼 ${approve}개 · 거부 버튼 ${reject}개`);
      if (approve !== 0 || reject !== 0) throw new Error("결정된 옛 카드에 버튼이 남았다");
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
