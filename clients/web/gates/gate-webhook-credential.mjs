#!/usr/bin/env node
// =============================================================================
// GATE — 일회성 웹훅 비밀값은 그것을 보여준 화면보다 오래 살지 않는다 (#1202 / #1205).
//
//   npm run build && npm run gate:webhook
//
// ## 왜 힙인가
//
// 이 결함은 두 번 "고쳐졌고" 두 번 다 모듈 단위 단정은 초록이었다.
//
//   1차: 발급 카드를 「저장했습니다」 없이 떠나면 원문이 MutationCache 에 5분
//        남았다(gcTime 300000). 수리 후 그 캐시는 실제로 비었다.
//   2차: 그런데 원문은 여전히 5분을 살았다. 붙잡고 있던 것은 캐시에 담긴 본문이
//        아니라 캐시에 얹힌 **클로저**였다 — 컴포넌트 안에서 만든 목록 쿼리의
//        `queryFn` 이 렌더 스코프를 통째로 캡처했고, 그 쿼리는 관찰자가 0이 된
//        뒤 자기 gcTime 타이머에 붙잡혀 있었다. 힙 스냅샷의 리테이너 경로:
//
//          Window → DOMTimer → [closure] → 목록 Query
//            → options.queryFn → (렌더 스코프) → revealed.credential.secret
//
// 두 라운드 모두 "캐시에 무엇이 담겼는가"를 쟀고, 결함은 "무엇이 도달 가능한가"에
// 있었다. 그래서 이 게이트는 캐시를 읽지 않는다. **힙을 읽는다**: 강제 GC 뒤
// 힙 스냅샷을 스트리밍하며 센티넬 문자열을 센다. 재는 것이 도달 가능성 자체라
// 리테이너가 무엇으로 바뀌든(캐시·타이머·전역·클로저) 같은 자로 잡힌다.
//
// ## 이 게이트가 스스로를 증명하는 방식
//
// 매 실행이 **양성 대조부터** 시작한다: 카드가 떠 있는 동안 센티넬이 힙에 있어야
// 한다. 그 검사가 초록이어야만 이어지는 "떠난 뒤에는 없다"가 뜻을 갖는다 — 문자열을
// 못 보는 프로브는 언제나 "없다"고 답하기 때문이다. 즉 비어 있지 않음(non-vacuity)이
// red seam 때만이 아니라 모든 실행에서 함께 측정된다.
//
// 그리고 abandon 뒤에도 **목록 쿼리 자체는 살아 있음**을 함께 찍는다(obs 0,
// gcTime 300000). 리테이너 후보가 여전히 서 있는데 값은 도달 불가라는 것이 이
// 수리의 주장이고, 쿼리가 사라져서 통과하는 것과 구별되어야 한다.
//
// ## Esc (리뷰 R2 신규 H)
//
// 되돌릴 수 없는 것 둘이 이 표면에 있다: 파괴 확인과, 서버가 원문을 보관하지 않는
// 발급 카드. 설정 셸의 Esc 는 라우트를 닫으므로 둘 다 반사적인 한 번에 날아갔다.
// 여기서 재는 것은 네 상태의 Esc 다 — 확인 중(취소되고 설정은 남는다), 카드가 떠
// 있는 중(아무 일도 없다), 아무것도 없을 때(설정이 닫힌다), 그리고 팔레트가 열린
// 채(팔레트만 닫힌다). 셋째가 양성 대조다: 그것이 없으면 "Esc 를 전부 죽였다"도
// 초록이 된다. 넷째는 두 번 잰다 — 캐럿이 팔레트 안에 있을 때와 밖에 있을 때.
// 앞의 것은 셸의 옛 태그 면제만으로도 통과하고(포커스가 `INPUT` 이다), 뒤의 것은
// 통과하지 못한다. 그 둘의 차이가 셸이 층·다이얼로그를 묻게 된 이유 전부다.
//
// ## 이름 붙은 red proof (버릴 워크트리에서만 돌린다)
//
//   WEBHOOK_GATE_PROVE_RED_LIFETIME=1 npm run gate:webhook
//     expected failure: "닫기(abandon) 뒤 힙에 원문이 없다"
//     목의 행동만 바꾼다: 카드가 뜬 뒤, 살아 있는 목록 Query 의 `options.queryFn`
//     을 화면의 값을 캡처한 인라인 클로저로 바꿔 끼운다. 리뷰가 힙에서 찾아낸 그
//     리테이너를 그대로 재현하는 것이고, 제품 소스는 한 줄도 건드리지 않는다.
//
//   WEBHOOK_GATE_PROVE_RED_ESC=1 npm run gate:webhook
//     expected failure: Esc 검사 5건(양성 대조와 팔레트 전제 2건은 초록 유지) —
//                       "확인 중 …", "발급 카드가 떠 있는 중 …" 넷과 팔레트 하나
//     예전 판의 리스너를 하나 되살린다: 앱보다 **먼저** window 캡처 단계에 붙는
//     Esc→뒤로가기 리스너(= 층 스택이 없던 시절의 설정 셸). 층이 있어도 앞에
//     등록된 리스너는 막지 못하므로, 그 시절의 동작이 그대로 재현된다.
//
// 백엔드도 자격증명도 없다: `/v1` 은 아래 픽스처로 채운다(gate-shell-layout 과
// 같은 방식). 센티넬은 캡처 하네스의 값과 다른 문자열이라, 커밋된 스크린샷이나
// 다른 게이트의 목이 이 측정에 섞이지 않는다.
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WEBHOOK_GATE_PORT || 5187);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

const proveRedLifetime = process.env.WEBHOOK_GATE_PROVE_RED_LIFETIME === "1";
const proveRedEsc = process.env.WEBHOOK_GATE_PROVE_RED_ESC === "1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ENGINE_ID = "00000000-0000-7000-8000-000000000202";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

// 이 게이트에서만 쓰는 문자열이고, 이름 자체가 그렇게 말한다. 힙에서 이것이
// 보이면 그것은 **이 실행이 방금 발급받은 값**이지 다른 무엇도 아니다.
const SENTINEL = "whsec_gateonlysentinel_do_not_reuse_9f2c";

const SESSION = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
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
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "channel", name: "general", topic: "" },
  { id: ENGINE_ID, workspaceId: WORKSPACE_ID, kind: "channel", name: "engine", topic: "" },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
];

const INSTALLATIONS = [
  {
    id: "019f9b10-0000-7000-8000-0000000009a1",
    channelId: GENERAL_ID,
    authorMemberId: ME,
    mode: "native",
    label: "배포 알림 (GitHub Actions)",
    status: "active",
    createdAtMs: Date.now() - 3 * 86_400_000,
    updatedAtMs: Date.now() - 3 * 86_400_000,
  },
  {
    id: "019f9b10-0000-7000-8000-0000000009a2",
    channelId: ENGINE_ID,
    authorMemberId: ME,
    mode: "native",
    label: "Sentry 이슈 알림",
    status: "active",
    createdAtMs: Date.now() - 9 * 86_400_000,
    updatedAtMs: Date.now() - 9 * 86_400_000,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context) {
  // 역순 매칭이라 이 포괄 스텁을 **먼저** 등록한다(= 마지막에 매칭된다). 짝 없는
  // /v1 요청이 프리뷰 프록시로 새면 401 이 돌아오고 앱이 스스로 로그아웃한다.
  await context.route("**/v1/**", (route) =>
    json(route, {
      channels: [], members: [], read_states: [], messages: [],
      invites: [], approvals: [], runs: [], installations: [],
    })
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
      token: "gate-only-not-a-credential",
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
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: [] })
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) =>
    json(route, { messages: [] })
  );

  // 발급·회전은 원문을 **한 번만** 돌려주는 그 응답이다. 이 게이트가 재는 값이
  // 태어나는 자리이므로 여기서만 센티넬이 나온다.
  await context.route("**/v1/workspaces/*/webhooks", (route) => {
    if (route.request().method() !== "POST") {
      return json(route, { installations: INSTALLATIONS });
    }
    const body = JSON.parse(route.request().postData() || "{}");
    const created = {
      id: "019f9b10-0000-7000-8000-0000000009c1",
      channelId: body.channelId,
      authorMemberId: ME,
      mode: body.mode,
      label: body.label,
      status: "active",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    return json(route, {
      installation: created,
      keyId: "019f9b10-0000-7000-8000-0000000009d1",
      secret: SENTINEL,
      url: `/v1/webhooks/${WORKSPACE_ID}/${created.id}`,
      signatureVersion: "v1",
      algorithm: "HMAC-SHA256",
    });
  });
  await context.route("**/v1/workspaces/*/webhooks/*/rotate", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    return json(route, {
      installation: INSTALLATIONS.find((row) => row.id === id),
      keyId: "019f9b10-0000-7000-8000-0000000009d2",
      secret: SENTINEL,
      url: `/v1/webhooks/${WORKSPACE_ID}/${id}`,
      signatureVersion: "v1",
      algorithm: "HMAC-SHA256",
      overlapSeconds: 86_400,
    });
  });
  await context.route("**/v1/workspaces/*/webhooks/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const row = INSTALLATIONS.find((item) => item.id === id);
    return json(route, {
      installation: { ...row, status: "revoked", updatedAtMs: Date.now() },
      revoked: true,
    });
  });
}

const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/**
 * 강제 GC 뒤 힙 스냅샷에서 센티넬을 센다.
 *
 * 스냅샷을 디스크에 쓰지 않고 청크를 흐르는 대로 훑는다(18MB × 여러 번이다).
 * 청크 경계에서 문자열이 잘릴 수 있으므로 꼬리를 이어 붙인다.
 */
async function heapHasSecret(cdp) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  let hits = 0;
  let tail = "";
  const onChunk = ({ chunk }) => {
    const hay = tail + chunk;
    let i = 0;
    while ((i = hay.indexOf(SENTINEL, i)) !== -1) {
      hits += 1;
      i += SENTINEL.length;
    }
    tail = hay.slice(-SENTINEL.length);
  };
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.disable");
  return hits;
}

async function signIn(page) {
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("gate-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

async function openWebhooks(page) {
  await page.evaluate('location.hash = "/inbox"');
  await page.waitForTimeout(150);
  await page.evaluate('location.hash = "/settings?section=webhooks"');
  await page.getByTestId("webhook-list").waitFor({ state: "visible" });
}

/** 발급까지: 카드가 뜨면 원문이 화면에 있다. */
async function issueCredential(page) {
  await page.getByTestId("webhook-label").fill("배포 알림 (GitHub Actions)");
  await page.getByTestId("webhook-create").click();
  await page.getByTestId("webhook-revealed").waitFor({ state: "visible" });
}

const secretInDom = (page) =>
  page.evaluate(
    `document.body.innerHTML.includes(${JSON.stringify(SENTINEL)})`
  );

/** 앱이 쓰는 진짜 QueryClient 를 React fiber 로 붙잡아 window 에 매단다. */
const GRAB_CLIENT = `(() => {
  const el = document.querySelector('[data-testid="webhook-section"]');
  if (!el) return false;
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  let fiber = el[key];
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props && props.client && props.client.getQueryCache) {
      window.__gateQueryClient = props.client;
      return true;
    }
    fiber = fiber.return;
  }
  return false;
})()`;

const CACHE_SHAPE = `JSON.stringify({
  mutations: window.__gateQueryClient.getMutationCache().getAll().length,
  queries: window.__gateQueryClient
    .getQueryCache()
    .getAll()
    .filter((q) => JSON.stringify(q.queryKey).includes("webhooks"))
    .map((q) => ({ gcTime: q.gcTime, obs: q.getObserversCount() })),
})`;

/**
 * red seam(LIFETIME): 살아 있는 목록 Query 의 `queryFn` 을 화면의 값을 캡처한
 * 인라인 클로저로 바꿔 끼운다 — 리뷰가 힙에서 찾아낸 리테이너의 재현.
 */
const REATTACH_LEAK = `(() => {
  const card = document.querySelector('[data-testid="webhook-revealed"]');
  const captured = { credential: { secret: card.textContent } };
  const query = window.__gateQueryClient
    .getQueryCache()
    .getAll()
    .find((q) => JSON.stringify(q.queryKey).includes("webhooks"));
  query.options.queryFn = async () => captured;
  return true;
})()`;

const WHERE = `(() => ({
  settings: !!document.querySelector('[data-testid="settings-route"]'),
  asking: !!document.querySelector('[data-testid^="webhook-ask-"]'),
  revealed: !!document.querySelector('[data-testid="webhook-revealed"]'),
  dialog: !!document.querySelector('[role="dialog"][data-state="open"]'),
  focus: (document.activeElement &&
    (document.activeElement.getAttribute('data-testid') ||
      document.activeElement.tagName)) || 'none',
}))()`;

async function measureLifetime(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);

  // ── 양성 대조: 프로브가 이 값을 볼 수 있는가 ────────────────────────────
  await openWebhooks(page);
  await page.evaluate(GRAB_CLIENT);
  await issueCredential(page);
  check("발급 카드가 떠 있는 동안 원문은 DOM 에 있다", await secretInDom(page));
  const open = await heapHasSecret(cdp);
  check(
    "발급 카드가 떠 있는 동안 원문은 힙에 있다 (프로브 양성 대조)",
    open > 0,
    `heap hits=${open}`
  );

  // ── abandon ①: 「저장했습니다」 없이 설정을 닫는다 ──────────────────────
  if (proveRedLifetime) await page.evaluate(REATTACH_LEAK);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.waitForTimeout(500);
  check(
    "닫기 뒤 이 표면은 언마운트됐다",
    (await page.locator('[data-testid="webhook-section"]').count()) === 0
  );
  const shapeAfterClose = await page.evaluate(CACHE_SHAPE);
  const shape = JSON.parse(shapeAfterClose);
  check(
    "닫기 뒤 mutation 캐시는 비었다",
    shape.mutations === 0,
    shapeAfterClose
  );
  // 리테이너 후보가 여전히 서 있다는 것을 함께 찍는다: 쿼리가 사라져서 통과하는
  // 것과, 쿼리가 살아 있는데도 값이 도달 불가인 것은 다른 결과다.
  check(
    "닫기 뒤에도 목록 쿼리 자체는 캐시에 살아 있다 (관찰자 0)",
    shape.queries.length === 1 && shape.queries[0].obs === 0,
    shapeAfterClose
  );
  const closed = await heapHasSecret(cdp);
  check("닫기(abandon) 뒤 힙에 원문이 없다", closed === 0, `heap hits=${closed}`);

  // ── abandon ②: 섹션 전환 ───────────────────────────────────────────────
  await openWebhooks(page);
  await page.evaluate(GRAB_CLIENT);
  await issueCredential(page);
  await page.getByRole("button", { name: "멤버와 초대", exact: true }).click();
  await page.waitForTimeout(500);
  const switched = await heapHasSecret(cdp);
  check(
    "섹션 전환(abandon) 뒤 힙에 원문이 없다",
    switched === 0,
    `heap hits=${switched}`
  );

  // ── happy 경로: 「저장했습니다」를 누르고 떠난다 ────────────────────────
  await openWebhooks(page);
  await page.evaluate(GRAB_CLIENT);
  await issueCredential(page);
  await page.getByTestId("webhook-reveal-done").click();
  await page.waitForTimeout(200);
  check("「저장했습니다」 뒤 원문은 DOM 에서 사라진다", !(await secretInDom(page)));
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.waitForTimeout(500);
  const done = await heapHasSecret(cdp);
  check("저장 확인 뒤 힙에 원문이 없다", done === 0, `heap hits=${done}`);

  // ── 폐기가 먼저 일어난 판 ──────────────────────────────────────────────
  // 폐기 mutation 은 비밀값을 실어 나르지 않지만 그 콜백이 같은 렌더 스코프를
  // 붙잡는다. 이 순서(폐기 → 발급 → 떠남)가 그 경로를 여는 유일한 순서다.
  await openWebhooks(page);
  await page.evaluate(GRAB_CLIENT);
  await page.locator('[data-testid^="webhook-revoke-"]').first().click();
  await page.locator('[data-testid$="-commit"]').first().click();
  await page.waitForTimeout(400);
  await issueCredential(page);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.waitForTimeout(500);
  const afterRevoke = await heapHasSecret(cdp);
  check(
    "폐기가 먼저 있었던 판에서도 떠난 뒤 힙에 원문이 없다",
    afterRevoke === 0,
    `heap hits=${afterRevoke}`
  );

  await context.close();
}

async function measureEscape(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await installMocks(context);
  if (proveRedEsc) {
    // 층 스택이 없던 시절의 설정 셸을 되살린다. 앱보다 먼저 등록되므로
    // `stopImmediatePropagation` 이 막지 못한다 — 그 판이 정확히 이 결함이 났던 판이다.
    await context.addInitScript(`
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") window.history.back();
      }, true);
    `);
  }
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);

  // ── ① 파괴 확인이 열려 있는 중의 Esc ────────────────────────────────────
  await openWebhooks(page);
  await page.locator('[data-testid^="webhook-revoke-"]').first().click();
  await page.locator('[data-testid$="-commit"]').first().waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterConfirmEsc = await page.evaluate(WHERE);
  check(
    "확인 중 Esc 는 설정을 닫지 않는다",
    afterConfirmEsc.settings === true,
    JSON.stringify(afterConfirmEsc)
  );
  check(
    "확인 중 Esc 는 확인을 취소하고 포커스를 트리거로 돌려준다",
    afterConfirmEsc.asking === false &&
      String(afterConfirmEsc.focus).startsWith("webhook-revoke-"),
    JSON.stringify(afterConfirmEsc)
  );

  // ── ② 다시 볼 수 없는 값이 떠 있는 중의 Esc ────────────────────────────
  await openWebhooks(page);
  await issueCredential(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterCardEsc = await page.evaluate(WHERE);
  check(
    "발급 카드가 떠 있는 중 Esc 는 설정을 닫지 않는다",
    afterCardEsc.settings === true,
    JSON.stringify(afterCardEsc)
  );
  check(
    "발급 카드가 떠 있는 중 Esc 는 카드를 없애지 않는다",
    afterCardEsc.revealed === true && (await secretInDom(page)),
    JSON.stringify(afterCardEsc)
  );

  // ── ③ 양성 대조: 아무 층도 없으면 Esc 는 여전히 설정을 닫는다 ───────────
  //
  // 층이 하나도 없는 판을 새로 세운다(앞 검사의 잔여 상태를 물려받지 않는다).
  // 포커스는 섹션 nav 에 둔다: 「저장했습니다」가 돌려주는 이름 칸에서는 Esc 가
  // 층과 무관하게 무시되는 것이 맞고(3R M5 — 편집 중인 폼을 반사적 Esc 가
  // 날리지 않는다), 양성 대조는 그 면제와 겹치지 않는 자리에서 재야 "Esc 를
  // 통째로 죽였다"를 잡는다.
  await openWebhooks(page);
  await page.getByRole("button", { name: "웹훅", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterPlainEsc = await page.evaluate(WHERE);
  check(
    "층이 없으면 Esc 는 설정을 닫는다 (양성 대조)",
    afterPlainEsc.settings === false,
    JSON.stringify(afterPlainEsc)
  );

  // ── ④ 다이얼로그는 층이 아니다 ─────────────────────────────────────────
  // Radix 는 자기 Esc 를 갖고 층 스택에 들어오지 않는다. 그때 설정 셸이 같은
  // Esc 를 자기 것으로도 처리하면, 팔레트를 닫으려던 한 번이 라우트까지 닫는다.
  await openWebhooks(page);
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(400);
  const paletteOpen = await page.evaluate(WHERE);
  check(
    "⌘K 팔레트가 설정 위에 열린다 (다음 검사의 전제)",
    paletteOpen.dialog === true,
    JSON.stringify(paletteOpen)
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterPaletteEsc = await page.evaluate(WHERE);
  check(
    "팔레트를 닫는 Esc 는 그 아래 설정까지 닫지 않는다",
    afterPaletteEsc.dialog === false && afterPaletteEsc.settings === true,
    JSON.stringify(afterPaletteEsc)
  );

  // 같은 것을 포커스 없이 한 번 더. 위 검사는 셸의 옛 태그 면제만으로도
  // 통과한다 — 팔레트의 캐럿이 `INPUT` 안에 있기 때문이다(실측). 즉 그 안전은
  // 규칙이 아니라 포커스의 위치에 얹혀 있었다. 캐럿을 빼고 같은 Esc 를 누르면
  // 무엇이 그것을 지키는지가 드러난다.
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(400);
  await page.evaluate("document.activeElement && document.activeElement.blur()");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterBlurredPaletteEsc = await page.evaluate(WHERE);
  check(
    "캐럿이 팔레트 밖에 있어도 그 Esc 는 설정을 닫지 않는다",
    afterBlurredPaletteEsc.dialog === false &&
      afterBlurredPaletteEsc.settings === true,
    JSON.stringify(afterBlurredPaletteEsc)
  );

  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  const server = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "WEBHOOK_GATE_PORT",
  });
  const shutdown = () => server.child.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    // 힙 스냅샷은 브라우저가 정직해야 뜻이 있다. `--js-flags=--expose-gc` 없이도
    // CDP 의 `HeapProfiler.collectGarbage` 는 실제 GC 를 돌린다.
    const browser = await chromium.launch();
    try {
      console.log("\n=== 비밀값의 수명 (힙) ===");
      await measureLifetime(browser);
      console.log("\n=== Esc 는 누구의 것인가 ===");
      await measureEscape(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }

  if (failures.length > 0) {
    console.error(`\nGATE FAIL: ${failures.length} check(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    "\nGATE PASS: 원문은 화면과 함께 죽고, Esc 는 되돌릴 수 없는 것을 지운 적이 없다."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
