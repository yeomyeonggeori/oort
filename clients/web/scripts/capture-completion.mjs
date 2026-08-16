#!/usr/bin/env node
// =============================================================================
// CAPTURE: 작업 완료 리포트 카드의 상태별 증거 (UXC-A / 커서 웹 ADE 벤치마크 §3-A).
//
// 게이트가 아니라 **증거**다. 판정은 둘만 하고(카드가 실제로 그려졌는가, 결정
// 컨트롤이 하나도 없는가 — 완료 리포트는 읽기뿐이다) 나머지는 사진이다.
//
// 찍는 상태 셋은 카드가 가지는 모양 전부다:
//   clean       모든 게이트 통과 — 요약·작업 시간·한 일·표면×게이트 표 전부.
//               머리 칩은 「완료」(ok).
//   attention   게이트 하나가 실패 — 통과/실패/건너뜀/진행 중 네 톤이 한 표에.
//               머리 칩은 「확인 필요」(warn), 붉은 셀은 실패 하나에만.
//   summary     요약만 있는 최소 리포트 — 표가 없을 때 빈 띠를 그리지 않는다.
//   edge        겹친 결과 — 한 표면의 같은 라벨 두 칸(통과+실패, 실패가 위)과
//               읽지 못한 결과 낱말(미상). H1·M1 의 반례를 눈으로 보인다.
//
//   npm run build && node scripts/capture-completion.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-completion.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.COMPLETION_CAPTURE_PORT || 5196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/completion");
const VIEWPORT = { width: 1280, height: 900 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f9a01-0000-7000-8000-000000000401";

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
  realtimeWebSocketUrl: "ws://completion-capture.invalid/connection/websocket",
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

// 완료 리포트는 **평범한 에이전트 턴 메시지**다 (type: "text"), props.kind 만
// 갈라진다 — 새 메시지 타입이 아니다. `arguments`/`tool_grant` 를 일부러 남겨
// 두는 것이 요점의 절반이다: 그 키들은 클라이언트 허용 목록 밖이라 화면 어디에도
// 나타나면 안 되고, 사진이 그 부재(그리고 「숨김 N개」 정직 표기)를 보여 준다.
const CLEAN_PROPS = {
  kind: "completion_report",
  title: "yeomyeonggeori/oort 환경 셋업 완료",
  summary:
    "oort 모노레포입니다. Rust 서버와 TS 코어, 웹과 폰 클라이언트가 한 트리에 있고, 게이트를 전부 초록으로 맞췄습니다.",
  elapsed_ms: 1_468_000,
  actions: [
    {
      text: "Rust 툴체인을 1.83에서 1.97로 올림",
      note: "워크스페이스가 edition2024를 요구해 고정된 1.83으로는 빌드되지 않았습니다.",
    },
    { text: "compose 스택을 기동하고 헬스체크를 확인함" },
  ],
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass", detail: "896 통과" },
        { label: "린트", outcome: "pass", detail: "경고 0" },
        { label: "빌드", outcome: "pass" },
      ],
    },
    {
      surface: "엔진",
      checks: [
        { label: "테스트", outcome: "pass", detail: "clippy 경고 0" },
        { label: "빌드", outcome: "pass" },
      ],
    },
    {
      surface: "compose",
      checks: [{ label: "실행", outcome: "pass", detail: "healthy" }],
    },
  ],
  arguments: JSON.stringify({ repo: "yeomyeonggeori/oort" }),
  tool_grant: "grant-opaque",
};

const ATTENTION_PROPS = {
  kind: "completion_report",
  title: "결제 어댑터 회귀 점검",
  summary:
    "결제 어댑터의 재시도 경로를 손봤습니다. 웹은 전부 통과했지만 엔진 테스트 하나가 실패해 확인이 필요합니다.",
  elapsed_ms: 372_000,
  actions: [
    { text: "지수 백오프 상한을 30초로 조정" },
    {
      text: "타임아웃 계약 테스트를 추가",
      note: "직전 회귀가 이 경로에서 났습니다.",
    },
  ],
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass", detail: "902 통과" },
        { label: "린트", outcome: "pass" },
      ],
    },
    {
      surface: "엔진",
      checks: [
        { label: "테스트", outcome: "fail", detail: "1 실패 · 340 통과" },
        { label: "린트", outcome: "pass" },
      ],
    },
    {
      surface: "compose",
      checks: [
        { label: "실행", outcome: "skip", detail: "이번 변경 범위 밖" },
        { label: "빌드", outcome: "pending" },
      ],
    },
  ],
};

const SUMMARY_ONLY_PROPS = {
  kind: "completion_report",
  title: "로그 정리 완료",
  summary:
    "스테이징 배포 로그를 훑고 반복되는 경고 세 종을 묶어 요약했습니다. 게이트를 돌릴 변경은 없었습니다.",
  elapsed_ms: 84_000,
};

// 겹친 결과 상태 (H1·M1): 한 표면(웹)의 「빌드」가 두 번 돌아 통과 옆에 실패가
// 서고(매트릭스가 첫 칸만 그려 실패를 접던 결함의 반례), 보안 스캐너의 결과
// 낱말은 이 빌드가 못 읽어 「미상 결과」로 표에 남는다(추측으로 pass 를 짓지
// 않는다). 사진은 한 셀에 쌓인 두 칸(실패가 위)과 warn 톤의 미상 칸을 보인다.
const EDGE_PROPS = {
  kind: "completion_report",
  title: "게이트 로그 파싱 — 겹친 결과",
  summary:
    "빌드 게이트를 두 번 돌렸습니다. 캐시본은 통과했지만 클린 빌드에서 하나가 실패했고, 보안 스캐너가 보낸 결과 낱말은 이 빌드가 읽지 못했습니다.",
  elapsed_ms: 205_000,
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "빌드", outcome: "pass", detail: "896 통과" },
        { label: "빌드", outcome: "fail", detail: "1 실패" },
        { label: "보안", outcome: "quarantined", detail: "검토 대기" },
      ],
    },
    {
      surface: "엔진",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "테스트", outcome: "pass", detail: "clippy 0" },
      ],
    },
  ],
};

const MESSAGES = [
  {
    author: ME,
    body: "@hermes 이 레포 환경 셋업하고, 끝나면 게이트 결과까지 정리해줘요.",
    type: "text",
  },
  { author: HERMES, body: "환경 셋업을 마쳤습니다.", type: "text", props: CLEAN_PROPS },
  {
    author: ME,
    body: "@hermes 결제 어댑터도 회귀 한 번 돌려줘요.",
    type: "text",
  },
  {
    author: HERMES,
    body: "회귀 점검을 마쳤습니다.",
    type: "text",
    props: ATTENTION_PROPS,
  },
  {
    author: HERMES,
    body: "로그 정리를 마쳤습니다.",
    type: "text",
    props: SUMMARY_ONLY_PROPS,
  },
  {
    author: HERMES,
    body: "게이트 로그를 정리했습니다.",
    type: "text",
    props: EDGE_PROPS,
  },
];

function messages() {
  return MESSAGES.map((row, index) => ({
    id: `completion-capture-${index + 1}`,
    channelId: CHANNEL_ID,
    seq: 2200 + index,
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
      last_read_seq: 2204,
      latest_seq: 2204,
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
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return page;
}

/**
 * 완료 리포트 카드에 결정 컨트롤이 하나도 없어야 한다 (UXC-A: 읽기뿐).
 *
 * 사진은 「이 카드에 버튼이 없다」를 스스로 말하지 않는다. 그래서 여기서 잰다:
 * 카드 안에 button·disabled·aria-disabled 가 하나도 없어야 한다. 있으면 사람은
 * 끝난 일 앞에서 「내가 뭘 눌러야 하나」를 묻게 된다.
 */
const CONTROLS_IN_REPORT_CARDS = `(() => {
  const cards = [...document.querySelectorAll('[data-card-kind="completion_report"]')];
  return {
    cards: cards.length,
    controls: cards.reduce(
      (n, card) =>
        n +
        card.querySelectorAll("button,[disabled],[aria-disabled='true']").length,
      0
    ),
  };
})()`;

async function shootCard(page, card, path) {
  await card.evaluate((el) =>
    el.scrollIntoView({ block: "start", behavior: "auto" })
  );
  await page.waitForTimeout(300);
  await card.screenshot({ path });
  return path;
}

async function goToBottom(page, cards) {
  await cards.last().scrollIntoViewIfNeeded();
  const jump = page.getByTestId("jump-latest");
  if (await jump.isVisible().catch(() => false)) await jump.click();
  await page.waitForTimeout(500);
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
  const cards = page.locator('[data-card-kind="completion_report"]');
  await cards.first().waitFor({ state: "visible" });
  await goToBottom(page, cards);

  const measured = await page.evaluate(CONTROLS_IN_REPORT_CARDS);
  if (measured.cards !== 4) {
    throw new Error(
      `${scheme}: expected four completion cards, found ${measured.cards}`
    );
  }
  if (measured.controls !== 0) {
    throw new Error(
      `${scheme}: 완료 리포트 카드에 컨트롤이 ${measured.controls}개 있다 ` +
        `(이 카드는 읽기뿐이다)`
    );
  }
  console.log(`  ${scheme}: cards=${measured.cards} controls=${measured.controls}`);

  const timeline = `${OUT_DIR}/completion-timeline-${scheme}.png`;
  await page.screenshot({ path: timeline });
  shots.push(timeline);

  const names = ["clean", "attention", "summary-only", "edge"];
  for (let i = 0; i < names.length; i += 1) {
    shots.push(
      await shootCard(page, cards.nth(i), `${OUT_DIR}/completion-${names[i]}-${scheme}.png`)
    );
  }

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
