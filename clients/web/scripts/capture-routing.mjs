#!/usr/bin/env node
// =============================================================================
// 모델·추론 강도 라우팅 표면 캡처 (ADR-0134 / MOMO-626).
//
//   npm run build && node scripts/capture-routing.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-routing.mjs
//
// capture-screens.mjs와 같은 방식(REST를 라우트로 채우고 prefers-color-scheme을
// 브라우저 수준에서 에뮬레이트)이되, 이 티켓이 만든 화면만 찍는다. 픽스처는
// src/features/routing/routingFixtures.json 하나를 그대로 읽는다: 단위 테스트가
// 검증하는 값과 스크린샷이 보여 주는 값이 같아야 리뷰가 코드를 본 것이 된다.
//
// **네 서버 형상**을 각각 찍는다. 이 티켓의 절반은 "서버가 아직 못 하는 일을 어떻게
// 말하는가"이므로, 지원하는 서버만 찍으면 리뷰할 수 없다. 그리고 그 형상은 두
// 개가 아니다: effort 축(MOMO-621)과 전송 표면 routing(MOMO-625)이 다른 커밋이라
// 앞의 것만 올라간 서버가 실제로 존재하고, 아무 답도 확정하지 못한 물음은 또 다른
// 화면이다.
//
//   ready     effort-table 200 + 전송 프로브 400 routing  (두 층이 다 올라간 서버)
//   sendless  effort-table 200 + 전송 프로브 404          (track/engine 현재 형상)
//   unknown   effort-table 200 + 전송 프로브 500          (확정하지 못한 물음, R2 H1)
//   absent    effort-table 404                            (momowebqa 등 현재 서버들)
//
// `unknown`은 R2 H1이 잡은 영구 고착의 재현 형상이다. 그 자리에서 ①잠긴 줄에
// [다시 확인]이 서 있고 ②누르면 프로브가 실제로 다시 나가며 ③접었다 펴는 것만
// 으로도 다시 나간다는 것을, 이 스크립트가 프로브 POST 수를 세어 함께 출력한다.
//
// `absent`의 로스터는 **에이전트가 전부 같은 모델로 도는** 워크스페이스다
// (momowebqa 실측 형상). 그 서버에서 모델 피커는 상속과 같은 값 하나만 담게 되는데,
// 그 사실을 화면이 말하는지가 R2 M3의 물음이라 캡처 형상에도 그대로 둔다.
//
// 폭도 두 가지로 본다(SKILL §11 리뷰 루프: 1280과 900).
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/routing");
const PORT = Number(process.env.CAPTURE_PORT || 5179);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 800 };

const FIXTURES = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/routing/routingFixtures.json"), "utf8")
);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const KIM = "019f9a01-0000-7000-8000-000000000404";
const TIDY = "019f9a01-0000-7000-8000-000000000405";
/** 프로필 행이 아직 없는 에이전트. GET 404, PUT은 upsert로 만든다. */
const NOTE = "019f9a01-0000-7000-8000-000000000406";

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
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  {
    id: "00000000-0000-7000-8000-000000000202",
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "엔진",
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
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
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
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: KIM,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: CHANNELS.map((c) => c.id),
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: TIDY,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "정리봇",
    handle: "tidy-bot",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: NOTE,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "회의록봇",
    handle: "note-bot",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    ownerHumanId: ME,
    agentModel: "hermes-lite",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const READ_STATES = [
  { channel_id: GENERAL_ID, last_read_seq: 1410, latest_seq: 1410, unread_count: 0, mention_count: 0 },
  { channel_id: CHANNELS[1].id, last_read_seq: 40, latest_seq: 40, unread_count: 0, mention_count: 0 },
];

const BODIES = [
  [ME, "@hermes 어제 relay outbox 지연 그래프 한 번 봐 주세요. 배치 크기 조정 전에 원인부터."],
  [HERMES, "로그를 읽었습니다. drain 워커 하나가 재시작 루프에 있었고 지금은 안정입니다."],
  [ME, "이번 건은 가볍게만 봐도 됩니다. 다음 배포 전에 다시 정리하죠."],
];

function makeMessages() {
  const base = Date.now() - BODIES.length * 60_000;
  return BODIES.map(([author, body], i) => ({
    id: `routing-capture-${i + 1}`,
    channelId: GENERAL_ID,
    seq: 1400 + i,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * 이 형상의 로스터.
 *
 * `absent`는 momowebqa의 실제 모습이다: 에이전트가 전부 같은 모델로 돌고, 서버에는
 * 고를 수 있는 모델 목록을 주는 경로가 없다. 그래서 모델 피커에 담기는 값이 상속과
 * 같은 하나뿐이 되고, 그 사실을 화면이 말하는지가 R2 M3의 물음이다.
 */
function rosterFor(support) {
  if (support !== "absent") return ROSTER;
  return ROSTER.map((member) =>
    member.kind === "agent" ? { ...member, agentModel: "hermes-agent" } : member
  );
}

/**
 * `support`는 이 캡처가 흉내 내는 서버 형상이다.
 *   "ready"     effort-table 200 + effortPref를 아는 프로필 + 전송 프로브 400
 *   "sendless"  effort-table 200이지만 전송 표면은 routing을 모른다(404)
 *   "unknown"   effort-table 200이지만 전송 프로브가 500으로 끝난다(확정 실패)
 *   "absent"    effort-table 404 (momowebqa를 포함한 현재 살아 있는 서버들)
 *
 * `probes`는 전송 표면 프로브(POST .../messages)가 몇 번 나갔는지 세는 통이다.
 * R2 H1의 수정은 "확정하지 못한 물음은 다음 물음을 막지 않는다"이므로, 그 증거는
 * 스크린샷이 아니라 이 수다.
 */
async function installMocks(context, support, probes = { count: 0, puts: [] }) {
  const hasEffortAxis = support !== "absent";
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
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
  await context.route("**/v1/provider/effort-table", (route) =>
    hasEffortAxis
      ? json(route, FIXTURES.effortTable)
      : json(route, { error: { message: "not found" } }, 404)
  );
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) => {
    const request = route.request();
    const url = request.url();
    // hermes는 오버라이드 픽스처(프로필이 hermes-fast/low를 고정), 김인턴은
    // 무효 클리어 픽스처(hermes-agent/max)를 들고 있다. 두 시나리오가 한 화면
    // 에서 동시에 보이도록 에이전트별로 나눠 준다.
    const lowered = url.toLowerCase();
    // PUT은 replace다. 무엇이 실제로 실려 나갔는지를 여기서 받아 적는다: 라우팅
    // 저장이 저장돼 있던 triggers.schedule을 지우는지(R2 H2)는 화면이 아니라 이
    // 본문에서만 보인다. 서버 upsert가 `triggers = EXCLUDED.triggers`라 여기서
    // 빠진 키는 그대로 영구 삭제다.
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}");
      probes.puts.push(body);
      return json(route, {
        profile: {
          ...FIXTURES.inherit.profile,
          ...body,
          version: FIXTURES.inherit.profile.version + 1,
        },
      });
    }
    // 회의록봇에는 프로필 행 자체가 없다. 살아 있는 서버에서 흔한 상태이고
    // (momowebqa 실측: 두 에이전트 중 하나가 404), 같은 경로의 PUT이 upsert라
    // 그 화면은 막다른 길이 아니라 "저장하면 만들어집니다"여야 한다.
    if (lowered.includes(NOTE)) {
      return json(route, { error: { message: "agent profile not found" } }, 404);
    }
    const profile = lowered.includes(KIM)
      ? FIXTURES.invalidClear.profile
      : lowered.includes(TIDY)
        ? FIXTURES.inherit.profile
        : FIXTURES.override.profile;
    if (!hasEffortAxis) {
      // effort_pref를 모르는 서버는 그 키 없이 답한다.
      const { effortPref, ...rest } = profile;
      void effortPref;
      return json(route, { profile: rest });
    }
    return json(route, { profile });
  });
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: rosterFor(support) })
  );
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const request = route.request();
    // POST는 전송 표면 프로브다(capability.probeSendRouting). 두 세대의 답이
    // 갈리는 지점을 그대로 흉내 낸다: routing을 읽은 서버는 그 이름을 부르며
    // 400을 주고, 모르는 서버는 그것을 버린 채 없는 rootId에 404를 준다.
    // 어느 쪽도 아닌 답(500)은 판정이 아니라 "확인하지 못했다"이고, 그 뒤에도
    // 물음이 다시 나갈 수 있어야 한다(R2 H1) — 그래서 여기서 수를 센다.
    if (request.method() === "POST") {
      probes.count += 1;
      if (support === "unknown") {
        return json(route, { error: { message: "internal error" } }, 500);
      }
      return support === "ready"
        ? json(
            route,
            {
              error: {
                message: "routing.effort must be one of low, medium, high, xhigh, max",
              },
            },
            400
          )
        : json(route, { error: { message: "thread root not found" } }, 404);
    }
    const url = new URL(request.url());
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: makeMessages() });
  });
  await context.route("**/v1/workspaces/*/dms", (route) =>
    json(route, { channels: [] })
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
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

async function shoot(page, path, shots) {
  // focus/hover는 transition-colors(150ms)를 타므로, 그 사이에 찍으면 제품이
  // 실제로 머무르지 않는 색을 리뷰하게 된다.
  await page.waitForTimeout(250);
  await page.screenshot({ path });
  shots.push(path);
}

async function captureScheme(browser, scheme, support) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const probes = { count: 0, puts: [] };
  await installMocks(context, support, probes);
  const shots = [];
  const tag = `${support}-${scheme}`;
  const hasEffortAxis = support !== "absent";

  // 1. 디렉터리: 에이전트 행에만 붙는 [라우팅] 진입점.
  const directory = await context.newPage();
  await directory.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(directory);
  await directory.evaluate('location.hash = "/directory"');
  await directory.getByTestId("directory-row").first().waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/directory-routing-${tag}.png`, shots);

  // 2. 프로필 다이얼로그: 아무것도 지정하지 않은 에이전트(정리봇). 두 상자에
  //    "상속 (에이전트 기본: hermes-agent)"과 "상속 (지정 없음, 모델 기본 보통)"이
  //    그대로 적혀 있다 -- D3의 "상속 (실제값 병기)"가 실제로 보이는 프레임.
  //    absent 서버에서는 같은 프레임이 R2 M3도 함께 보여 준다: 고를 수 있는 값이
  //    상속과 같은 하나뿐이고, 그 이유가 상자 밑에 한 줄로 적혀 있다.
  await directory.locator(`[data-testid="directory-row-profile"][data-member-id="${TIDY}"]`).click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/agent-profile-inherit-${tag}.png`, shots);

  // 2a. 저장 한 번. 화면이 아니라 **나가는 본문**을 보기 위한 단계다(R2 H2):
  //     이 프로필의 triggers에는 schedule이 실려 있고, 모델만 바꾼 저장이 그것을
  //     들고 나가는지 아니면 지우는지는 PUT 본문에만 있다.
  //     고를 값은 형상마다 다르다: 표가 없는 서버의 피커에는 이 워크스페이스가
  //     실제로 쓰는 이름 하나뿐이고, 그것을 고르는 것도 상속에서 고정으로 바꾸는
  //     변경이라 저장이 열린다.
  await directory
    .getByTestId("agent-profile-model")
    .selectOption(hasEffortAxis ? "hermes-lite" : "hermes-agent");
  await directory.getByTestId("agent-profile-save").click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "hidden" });

  // 2b. 저장된 오버라이드가 있는 에이전트(hermes: hermes-fast / 낮음).
  //     absent 서버에서 특히 봐야 할 프레임이다: 모델 상자는 열려 있고, 잠긴
  //     것은 강도 상자 하나이며, 그 사유가 "지금 적용: 모델 hermes-fast" 줄과
  //     모순되지 않는다.
  await directory.locator(`[data-testid="directory-row-profile"][data-member-id="${HERMES}"]`).click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/agent-profile-saved-${tag}.png`, shots);
  await directory.getByTestId("agent-profile-cancel").click();

  // 2c. 프로필 행이 아직 없는 에이전트(회의록봇, GET 404). 폼은 열려 있고
  //     저장이 곧 생성이다. 한 줄 고지 + 액션 하나(SKILL §5 empty).
  await directory.locator(`[data-testid="directory-row-profile"][data-member-id="${NOTE}"]`).click();
  await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
  await directory.getByTestId("agent-profile-empty").waitFor({ state: "visible" });
  await shoot(directory, `${OUT_DIR}/agent-profile-new-${tag}.png`, shots);
  await directory.getByTestId("agent-profile-cancel").click();

  // 3. 프로필 다이얼로그: 모델을 바꿔 강도가 무효해지는 순간. 강도 축이 있는
  //    서버에서만 의미가 있다(absent에서는 강도 상자가 잠겨 있고 그 사유가
  //    이미 2b 프레임에 찍혀 있다).
  if (hasEffortAxis) {
    // 김인턴이 hermes-agent/max를 들고 있으므로, hermes-fast로 내리면 max가
    // 유효값에서 빠진다.
    await directory
      .locator(`[data-testid="directory-row-profile"][data-member-id="${KIM}"]`)
      .click();
    await directory.getByTestId("agent-profile-dialog").waitFor({ state: "visible" });
    await directory.getByTestId("agent-profile-model").selectOption("hermes-fast");
    await directory.getByTestId("agent-profile-cleared").waitFor({ state: "visible" });
    await shoot(directory, `${OUT_DIR}/agent-profile-cleared-${tag}.png`, shots);
  }

  // 4. 컴포저 멘션 줄: 상속 상태. 바꾸지 않으면 무엇이 되는지가 먼저 보인다.
  const chat = await context.newPage();
  await chat.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(chat);
  await chat.getByTestId("composer-input").waitFor({ state: "visible" });
  await chat.getByTestId("composer-input").fill("@hermes 빌드 로그 요약만 부탁합니다");
  await chat.getByTestId("composer-routing").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-inherit-${tag}.png`, shots);

  // 5. 펼친 상태. 펼치는 순간 전송 표면 프로브가 날아가고, 그 답이 나오기 전
  //    까지는 두 상자가 "확인 중"이라고 적힌 채 잠겨 있다. 답이 오면 열리거나
  //    (ready) 사유가 남는다(sendless: effort 표는 있지만 전송은 못 받는 서버).
  await chat.getByTestId("composer-routing-toggle").click();
  await chat.getByTestId("composer-routing-model").waitFor({ state: "visible" });
  await chat.waitForTimeout(300);
  await shoot(chat, `${OUT_DIR}/composer-routing-open-${tag}.png`, shots);

  // 6. 오버라이드 활성: 줄이 accent-soft로 바뀌고 "이번 한 번만"이 붙는다.
  //    전송 표면이 routing을 받는다고 서버가 직접 말한 서버에서만 가능하다.
  if (support === "ready") {
    await chat.getByTestId("composer-routing-model").selectOption("hermes-agent");
    await chat.getByTestId("composer-routing-effort").selectOption("xhigh");
    await chat
      .locator('[data-testid="composer-routing"][data-override]')
      .waitFor({ state: "visible" });
    await shoot(chat, `${OUT_DIR}/composer-routing-override-${tag}.png`, shots);
  }

  // 6b. 확정하지 못한 물음에서 빠져나가는 길 (R2 H1).
  //     프로브가 500으로 끝나면 상자는 잠기지만 그 판정은 서버에 대한 사실이
  //     아니다. 줄에는 [다시 확인]이 서 있고, 그것을 누르면 프로브가 실제로 다시
  //     나가며, 접었다 펴는 것만으로도 다시 나간다. 화면으로는 "잠긴 채 이유가
  //     적혀 있다"까지만 보이므로 나머지 절반은 POST 수로 남긴다.
  if (support === "unknown") {
    const afterFirstOpen = probes.count;
    await chat.getByTestId("composer-routing-recheck").waitFor({ state: "visible" });
    await shoot(chat, `${OUT_DIR}/composer-routing-unsettled-${tag}.png`, shots);
    await chat.getByTestId("composer-routing-recheck").click();
    await chat.waitForTimeout(400);
    const afterRecheck = probes.count;
    // 접기 → 다시 펼치기. 두 번째 회복 경로다.
    await chat.getByTestId("composer-routing-toggle").click();
    await chat.getByTestId("composer-routing-toggle").click();
    await chat.waitForTimeout(400);
    console.log(
      `[${tag}] 프로브 POST: 첫 펼침 ${afterFirstOpen}, [다시 확인] 뒤 ${afterRecheck}, 재펼침 뒤 ${probes.count}`
    );
    // 접힌 상태에서도 사유가 남고 [다시 확인]이 함께 있다.
    await chat.getByTestId("composer-routing-toggle").click();
    await chat.getByTestId("composer-routing-notice").waitFor({ state: "visible" });
    await shoot(chat, `${OUT_DIR}/composer-routing-unsettled-collapsed-${tag}.png`, shots);
  }

  // 7. 에이전트를 여러 명 부르면 붙일 수 없다고 말한다. 이름은 두 개까지 적고
  //    나머지는 수로 접는다(줄이 문단이 되지 않도록). 조사는 목록의 끝에 달려
  //    있으므로 두 명(라틴 핸들로 끝남)도 함께 찍는다(R2 M4).
  await chat
    .getByTestId("composer-input")
    .fill("@hermes @kim-intern 두 분 같이 확인 부탁합니다");
  await chat.getByTestId("composer-routing-many").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-many-two-${tag}.png`, shots);
  await chat
    .getByTestId("composer-input")
    .fill("@hermes @kim-intern @tidy-bot 세 분 같이 확인 부탁합니다");
  await chat.getByTestId("composer-routing-many").waitFor({ state: "visible" });
  await shoot(chat, `${OUT_DIR}/composer-routing-many-${tag}.png`, shots);
  console.log(`[${tag}] PUT triggers: ${JSON.stringify(probes.puts.map((p) => p.triggers))}`);
  await context.close();

  // 8. 좁은 폭(900). SKILL §11 리뷰 루프가 요구하는 두 번째 측정 폭이고, 줄이
  //    펼쳐졌을 때 컴포저가 얼마나 자라는지가 여기서 보인다.
  const narrowContext = await browser.newContext({
    viewport: NARROW,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(narrowContext, support, { count: 0, puts: [] });
  const narrow = await narrowContext.newPage();
  await narrow.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(narrow);
  await narrow.getByTestId("composer-input").waitFor({ state: "visible" });
  await narrow
    .getByTestId("composer-input")
    .fill("@hermes 빌드 로그 요약만 부탁합니다");
  await narrow.getByTestId("composer-routing").waitFor({ state: "visible" });
  await narrow.getByTestId("composer-routing-toggle").click();
  await narrow.getByTestId("composer-routing-model").waitFor({ state: "visible" });
  await narrow.waitForTimeout(300);
  await shoot(narrow, `${OUT_DIR}/narrow-900-composer-open-${tag}.png`, shots);
  await narrowContext.close();

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
      for (const support of ["ready", "sendless", "unknown", "absent"]) {
        for (const scheme of ["light", "dark"]) {
          all.push(...(await captureScheme(browser, scheme, support)));
        }
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
