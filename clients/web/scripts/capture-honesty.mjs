#!/usr/bin/env node
// CAPTURE: 표면 정직화 + 메시지 검색 (goal B12).
//
// 이 스크립트는 게이트가 아니라 **증거**다. 판정 없이 화면만 찍는다.
//
// 중요한 것 하나: 여기서 쓰는 번들은 **프로덕션 빌드**여야 한다(`npm run build`).
// 게이트 모드로 빌드하면 판정표의 게이트 이음매가 열려서 작업 흐름이 제공되는
// 것으로 보이고, 그러면 이 캡처는 고치려는 상태가 아니라 고쳐지고 난 뒤의 상태를
// 찍게 된다.
//
// 모의 서버는 **실제 Rust 서버의 형상을 그대로** 흉내낸다:
//   있는 것  로그인, 채널, 로스터, read-state, 메시지, 그리고 search/messages
//   없는 것  workstreams / approvals / huddles / agent-runs(GET) / plugins / memories
// 없는 것에는 라우터 기본 404를 **본문 없이** 답한다. 본문 없는 404가 이 배치가
// 고친 거짓말의 출처이기 때문이다.
//
// 사용법:
//   npm run build && node scripts/capture-honesty.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HONESTY_CAPTURE_PORT || 5191);
const origin = `http://127.0.0.1:${port}`;
const outDir = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(webRoot, "artifacts/honesty");

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const teammateId = "019f9a01-0000-7000-8000-000000000400";
const agentId = "019f9a01-0000-7000-8000-000000000401";
const channelId = "00000000-0000-7000-8000-000000000201";
const channelTwoId = "00000000-0000-7000-8000-000000000202";

const session = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: meId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://honesty-capture.invalid/connection/websocket",
};

const channels = [
  { id: channelId, workspaceId, kind: "public", name: "제품-웹", muted: false },
  { id: channelTwoId, workspaceId, kind: "public", name: "배포", muted: false },
];

const NOW = Date.now();

/**
 * `isRosterMember`(lib/api.ts)가 요구하는 필드를 전부 갖춘 행. 하나라도 빠지면
 * 그 행은 조용히 버려지고 화면은 이름 대신 id 앞 8자를 보여준다. 그것은 이
 * 클라이언트의 의도된 동작이지만("못 푼 id는 id로 보여준다, 이름을 지어내지
 * 않는다") 캡처가 보여줄 상태는 아니다.
 */
function member(overrides) {
  return {
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    channelCount: 2,
    channelIds: [channelId, channelTwoId],
    capabilities: [],
    createdAtMs: NOW - 90 * 86_400_000,
    updatedAtMs: NOW - 86_400_000,
    ...overrides,
  };
}

const roster = [
  member({ id: meId, displayName: "곽성재", handle: "seongjae", role: "owner" }),
  member({ id: teammateId, displayName: "김도현", handle: "dohyun" }),
  member({
    id: agentId,
    kind: "agent",
    displayName: "김인턴",
    handle: "intern",
    ownerHumanId: meId,
  }),
];

// 실제 팀이 쓸 법한 한국어+영어 혼용. "테스트 메시지 1" 같은 자리표시자는 쓰지
// 않는다(design-taste-web §7).
const HITS = [
  {
    channelId,
    messageId: "00000000-0000-7000-8000-000000000901",
    seq: 812,
    authorMemberId: teammateId,
    createdAtMs: Date.now() - 42 * 60_000,
    snippet:
      "스테이징 배포는 끝났고 프로덕션 배포는 리뷰 하나만 더 받고 올릴게요",
    matchOffset: 5,
  },
  {
    channelId: channelTwoId,
    messageId: "00000000-0000-7000-8000-000000000902",
    seq: 77,
    authorMemberId: agentId,
    createdAtMs: Date.now() - 5 * 3_600_000,
    snippet:
      "3분 12초로 줄었습니다. migration 031을 적용한 뒤 캐시 워밍업까지 모두 포함한 수치이고, 이전과 같은 조건에서 다시 잰 값입니다 배포 파이프라인 로그는 스레드에 남겼어요",
    // 80 = 서버가 앞 80자에서 창을 열었다는 신호. 이 행만 말줄임을 갖는다.
    // (위 문자열에서 "배포"의 문자 인덱스가 정확히 80이다.)
    matchOffset: 80,
  },
  {
    channelId,
    messageId: "00000000-0000-7000-8000-000000000903",
    seq: 640,
    authorMemberId: meId,
    createdAtMs: Date.now() - 30 * 3_600_000,
    snippet: "금요일 배포는 하지 맙시다. 월요일 아침에 같이 보는 게 낫겠어요",
    matchOffset: 4,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * 라우터가 그 경로를 모를 때의 답. axum의 기본 404는 **본문이 없다**.
 * 이 배치가 고친 거짓말("서버 응답을 읽지 못했습니다. 다시 시도하세요")이
 * 바로 이 빈 본문에서 나왔으므로, 캡처도 같은 모양으로 답해야 의미가 있다.
 */
function absent(route) {
  return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
}

async function installRoutes(context) {
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture-only", url: session.realtimeWebSocketUrl });
    }

    // ---- 이 서버에 **없는** 경로 (실측 2026-08-02) ----
    if (
      path.includes("/workstreams") ||
      path.includes("/approvals") ||
      path.includes("/huddles") ||
      path.includes("/plugins") ||
      path.includes("/memories") ||
      path.endsWith("/agent-runs") ||
      path.includes("/agent-runs/")
    ) {
      return absent(route);
    }

    // ---- 이 서버에 **있는** 경로 ----
    if (path.endsWith("/search/messages")) {
      const q = url.searchParams.get("q") ?? "";
      // 서버 계약 그대로: 2자 미만은 400, 없는 말은 빈 hits, 마지막 페이지는
      // nextCursor 키 자체를 뺀다.
      if ([...q.trim()].length < 2) {
        return json(
          route,
          { error: { message: "q must contain at least 2 characters" } },
          400
        );
      }
      const hits = HITS.filter((hit) => hit.snippet.includes(q.trim()));
      return json(route, { hits });
    }
    if (path.endsWith("/roster") || path.endsWith("/members")) {
      return json(route, { members: roster });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith("/work-sessions")) return json(route, { workSessions: [] });
    if (path.endsWith("/effort-table")) return json(route, { providers: [] });
    if (path.endsWith(`/v1/workspaces/${workspaceId}`)) {
      return json(route, { id: workspaceId, name: "새벽팀", settings: {} });
    }
    return json(route, {});
  });
}

/** 실시간 소켓은 캡처에 필요 없다. 열리지 않게 막아 대기 상태를 없앤다. */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    class DeadSocket extends EventTarget {
      constructor() {
        super();
        this.readyState = 0;
      }
      send() {}
      close() {}
    }
    Object.defineProperty(window, "WebSocket", {
      value: DeadSocket,
      writable: true,
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // preview가 아직 올라오는 중
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("capture-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("nav-inbox").waitFor({ timeout: 15_000 });
}

const shots = [];

async function shoot(page, name) {
  const file = resolve(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
  console.log(`  shot ${name}`);
}

async function captureScheme(browser, scheme, viewport, suffix) {
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  await login(page);

  // ---- 정직화된 표면 ----
  // 1) 작업 흐름: 사이드바에서 줄이 사라졌고, 주소는 그대로 열리며 이유를 말한다.
  const wsRow = await page.getByTestId("nav-workstreams").count();
  if (wsRow !== 0) throw new Error("작업 흐름 진입점이 아직 서 있다");
  const searchRow = await page.getByTestId("nav-search").count();
  if (searchRow !== 1) throw new Error("검색 진입점이 없다");
  await page.goto(`${origin}/#/workstreams`);
  await page.getByTestId("surface-unavailable-route").waitFor();
  await shoot(page, `unavailable-workstreams-${suffix}`);

  // 2) 활동: 두 원천이 모두 없으므로 목록이 아니라 이유가 선다.
  await page.goto(`${origin}/#/activity`);
  await page.getByTestId("activity-unavailable").waitFor();
  await shoot(page, `unavailable-activity-${suffix}`);

  // 3) 인박스: 죽은 탭 둘이 사라지고 멘션만 남는다. 열자마자 빈 결정 대기에
  //    착지하던 것이 이 배치의 수정이다.
  await page.goto(`${origin}/#/inbox`);
  await page.getByTestId("inbox-route").waitFor();
  const tabs = await page.getByTestId("inbox-tab-needs-action").count();
  if (tabs !== 0) throw new Error("죽은 결정 대기 탭이 아직 서 있다");
  await shoot(page, `honest-inbox-${suffix}`);

  // 4) 설정 > 앱: 서버가 404로 답하면 구획 전체가 접힌다(이중 방어 (b)).
  await page.goto(`${origin}/#/settings?section=plugins`);
  await page.getByTestId("plugins-unavailable").waitFor({ timeout: 15_000 });
  await shoot(page, `unavailable-plugins-${suffix}`);

  // ---- 검색 세 상태 ----
  await page.goto(`${origin}/#/search`);
  await page.getByTestId("search-idle").waitFor();
  await shoot(page, `search-idle-${suffix}`);

  await page.getByTestId("search-input").fill("배");
  await page.getByTestId("search-too-short").waitFor();
  await shoot(page, `search-too-short-${suffix}`);

  await page.getByTestId("search-input").fill("배포");
  await page.getByTestId("search-results").waitFor({ timeout: 15_000 });
  const hitCount = await page.getByTestId("search-hit").count();
  if (hitCount !== HITS.length) {
    throw new Error(`검색 결과 ${HITS.length}건을 기대했으나 ${hitCount}건`);
  }
  const marks = await page.getByTestId("search-match").count();
  if (marks === 0) throw new Error("검색어 강조가 없다");
  await shoot(page, `search-results-${suffix}`);

  await page.getByTestId("search-input").fill("존재하지않는말");
  await page.getByTestId("search-empty").waitFor({ timeout: 15_000 });
  await shoot(page, `search-empty-${suffix}`);

  // 가로 스크롤 0 (모바일 폭에서 특히).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  if (overflow > 0) {
    throw new Error(`${suffix}: 문서가 가로로 ${overflow}px 넘친다`);
  }

  await context.close();
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ 가 없다. 먼저 `npm run build`를 돌려라.");
  }
  mkdirSync(outDir, { recursive: true });

  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      console.log("데스크탑 1280x800");
      await captureScheme(browser, "light", { width: 1280, height: 800 }, "light");
      await captureScheme(browser, "dark", { width: 1280, height: 800 }, "dark");
      console.log("폰 390x844");
      await captureScheme(browser, "light", { width: 390, height: 844 }, "phone");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }

  console.log(`\nCAPTURE OK: ${shots.length} shots`);
  console.log(`artifacts: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
