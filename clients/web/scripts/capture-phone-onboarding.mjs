#!/usr/bin/env node
// =============================================================================
// 폰 브라우저 온보딩 캡처 (#2616).
//
// 성재가 팀 서버 owner claim을 폰으로 하다가 만난 두 가지를 잰다.
//   1. 타이핑하면 화면이 확대되고 깨진다. iOS 사파리는 포커스 받은 입력 칸의 글자가
//      16px보다 작으면 페이지를 확대한다. 확대 자체는 사파리 UI(UIKit)의 동작이라
//      Playwright WebKit이 재현하지 못한다(실측: 포커스 뒤에도 visualViewport.scale 1).
//      그래서 확대의 **원인**인 계산된 글자 크기를 잰다.
//   2. 에이전트 단계의 건너뛰기가 스크롤해야 보인다.
//
// 엔진은 WebKit, 프로필은 Playwright `iPhone 13 Mini`(375×629 CSS px, 사파리 막대를 뺀
// 보이는 높이)다. 「첫 화면에 보이는가」는 한 번 더, 375×548에서 잰다. iPhone SE(3세대)
// 사파리가 주소창·도구막대를 세운 채 보여 주는 높이의 근사이고, 375px 폭 기기 중 가장
// 낮다.
//
// 모션은 사람들이 쓰는 기본값(`no-preference`)이다. 단계 사이 미끄러짐이 가로 넘침을
// 만드는지가 재는 대상 중 하나라서다. 캡처는 유한 애니메이션이 끝난 뒤에 찍는다.
//
// 장면마다 라이트·다크 캡처를 남기고 다음을 잰다.
//   - 가로 넘침 0: 문서와 **모든 스크롤 상자**. 앱 전체가 main.tsx의 세로 스크롤
//     상자 안에 있어서, 문서만 재면 그 상자의 가로 넘침(화면이 옆으로 끌리는 것)을
//     못 본다(capture-screens.mjs assertNoHorizontalOverflow와 같은 자).
//   - 옮겨 가는 동안의 가로 넘침 0: 단계를 넘기는 동작 뒤 1초 동안 프레임마다 잰다.
//   - 글자 입력 칸(input·textarea·select)의 계산된 글자 크기 >= 16px.
//   - 키보드 흉내: 뷰포트 높이를 629 → 329로 줄인다(키보드 300px). 앱의
//     viewportHeight.ts가 visualViewport resize를 받아 --app-viewport-height를 새로
//     쓰는 경로가 그대로 돈다. 마지막 입력 칸에 포커스를 두고 iOS처럼 가운데로 굴린
//     뒤, 주요 버튼이 스크롤로 닿고(가려지지 않고) 가로 넘침이 0인지 잰다. 실기기의
//     레이아웃 뷰포트 고정·시각 뷰포트 팬은 흉내 내지 못한다(runtime-unverified).
//   - 에이전트 단계: 「건너뛰기」가 스크롤 0에서 첫 화면 안에 있고 가려지지 않는다.
//
//   npm run capture:phone-onboarding
//       build:design 뒤 dist/를 잰다 → artifacts/phone-onboarding/*.png + report.json
//   DIST_DIR=<다른 빌드> OUT_DIR=<dir> ALLOW_FAILURES=1 node scripts/capture-phone-onboarding.mjs
//       수리 전 빌드처럼 실패가 예상되는 판을 찍을 때. 실패는 report.json에 남고
//       종료 코드는 0이다.
//
// `--mode design` 빌드가 필요하다: 에이전트 단계의 자세(`?firstAgent=`)는 그 모드에서만
// 열린다(firstAgent.ts readFirstAgentCapturePoseFromLocation).
// 자격증명·백엔드는 없다. /v1은 아래 픽스처가 답한다.
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devices, webkit } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/phone-onboarding");
const PORT = Number(process.env.CAPTURE_PORT || 5192);
const ALLOW_FAILURES = process.env.ALLOW_FAILURES === "1";
const PROFILE_NAME = "iPhone 13 Mini";
const PROFILE = devices[PROFILE_NAME];
const SHORT_PHONE = { width: 375, height: 548 };
const KEYBOARD_PX = 300;
const FLOOR_PX = 16;
const TRANSITION_WATCH_MS = 1000;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
// base64url 43자: claimPath.ts TOKEN_SHAPE. 캡처 전용 값이다.
const CLAIM_TOKEN = "capture-only-2616".padEnd(43, "x");
const INVITE_CODE = "Ab3-_xQ7mZ";

function session(port) {
  return {
    accessToken: "capture-only-not-a-credential",
    refreshToken: "capture-only-not-a-credential",
    member: {
      id: ME,
      workspaceId: WORKSPACE_ID,
      kind: "human",
      displayName: "곽성재",
      handle: "seongjae",
    },
    realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
  };
}

const WORKSPACE = {
  id: WORKSPACE_ID,
  slug: "yeomyeong",
  name: "여명거리 제품팀",
  updatedAtMs: Date.UTC(2026, 8, 24, 1, 0, 0),
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

// 에이전트 단계 `done` 자세가 찾는 에이전트(firstAgent.ts firstAgentCaptureAgent)와 같은
// id다. 명부에 없으면 그 자세는 멘션 줄 대신 빈 대체 문장을 그린다.
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
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000404",
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: ["code"],
    ownerHumanId: ME,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  const sess = session(PORT);
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [], connections: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, sess));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: sess.accessToken, refreshToken: sess.refreshToken })
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
  await context.route("**/v1/join", (route) => json(route, { ...sess, createdMember: true }));
  await context.route("**/v1/claim", (route) => json(route, sess));
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}`, (route) =>
    json(route, { workspace: WORKSPACE })
  );
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}/members/me`, (route) =>
    json(route, { member: { ...sess.member, displayName: "곽성재", handle: "seongjae" } })
  );
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}/invites`, (route) => {
    if (route.request().method() !== "POST") return json(route, { invites: [] });
    const now = Date.now();
    return json(route, {
      code: "oort-yeomyeong-7Kq2-Wd9x",
      invite: {
        id: "019f9b10-0000-7000-8000-00000000c001",
        workspaceId: WORKSPACE_ID,
        codePreview: "Wd9x",
        role: "member",
        maxUses: 10,
        usedCount: 0,
        expiresAtMs: now + 7 * 86_400_000,
        createdBy: ME,
        createdAtMs: now,
        updatedAtMs: now,
      },
    });
  });
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}/channels`, (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route(`**/v1/workspaces/${WORKSPACE_ID}/roster`, (route) =>
    json(route, { members: ROSTER })
  );
}

/** 두 프레임 + 유한 애니메이션(단계 미끄러짐·페이드)이 끝날 때까지. 무한 반복
 *  애니메이션(S0 별빛)은 기다리지 않는다. */
async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
  await page.waitForFunction(
    () =>
      document.getAnimations().every((animation) => {
        if (animation.playState !== "running") return true;
        const timing = animation.effect?.getComputedTiming?.();
        return !timing || timing.iterations === Infinity || timing.endTime === Infinity;
      }),
    null,
    { timeout: 5_000 }
  );
  await page.waitForTimeout(120);
}

/** 모든 스크롤 상자를 맨 위·맨 왼쪽으로. 앱의 스크롤은 문서가 아니라 main.tsx의
 *  상자에 있으므로 window.scrollTo만으로는 「첫 화면」이 안 된다. */
async function scrollAllToOrigin(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    }
  });
}

/** 문서와 모든 스크롤 상자의 가로 넘침. 페이지 안에서 도는 함수라 문자열로 넘긴다. */
const HORIZONTAL_LEAKS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const leaks = [];
  const docOver = doc.scrollWidth - doc.clientWidth;
  if (docOver > 0) leaks.push({ where: "document", over: docOver });
  for (const el of document.querySelectorAll("*")) {
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    if (el.hasAttribute("data-scroll-x")) continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 0) continue;
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).slice(0, 4).join(".");
    leaks.push({ where: el.getAttribute("data-testid") || el.tagName.toLowerCase() + (cls ? "." + cls : ""), over, scrollLeft: el.scrollLeft });
  }
  return leaks;
})()`;

/** 동작 하나(단계 넘기기)를 하는 동안 프레임마다 가로 넘침을 잰다. 페이지 쪽 함수를
 *  문자열 식 하나로 넘긴다(eval·new Function 없이, 페이지 CSP와 무관하게). */
async function watchTransition(page, action) {
  const sampler = page.evaluate(`new Promise((done) => {
    const probe = () => ${HORIZONTAL_LEAKS};
    let worst = { over: 0 };
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames += 1;
      for (const leak of probe()) {
        if (leak.over > worst.over) worst = { ...leak, atMs: Math.round(performance.now() - start) };
      }
      if (performance.now() - start < ${TRANSITION_WATCH_MS}) requestAnimationFrame(tick);
      else done({ frames, worst });
    };
    requestAnimationFrame(tick);
  })`);
  await action();
  return sampler;
}

const TEXT_ENTRY_EXCLUDED = ["checkbox", "radio", "hidden", "range", "color", "file", "submit", "button", "image", "reset"];

async function readGeometry(page) {
  const leaks = await page.evaluate(HORIZONTAL_LEAKS);
  const rest = await page.evaluate((excluded) => {
    const skipSet = new Set(excluded);
    const fields = [...document.querySelectorAll("input, textarea, select")]
      .filter((el) => !(el instanceof HTMLInputElement && skipSet.has(el.type)))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({
        id: el.getAttribute("data-testid") || el.id || el.tagName.toLowerCase(),
        fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
      }));
    let scroller = null;
    for (const el of document.querySelectorAll("*")) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        if (!scroller || el.scrollHeight > scroller.scrollHeight) scroller = el;
      }
    }
    return {
      innerWidth,
      innerHeight,
      contentOverflowY: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
      fields,
    };
  }, TEXT_ENTRY_EXCLUDED);
  return { ...rest, leaks };
}

/** 요소가 지금 뷰포트 안에 통째로 있고, 가운데 점을 누르면 그 요소가 받는가. */
async function readTarget(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const inside = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
    const hit = inside ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return {
      present: true,
      text: (el.textContent || "").trim(),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      right: Math.round(r.right),
      height: Math.round(r.height),
      inside,
      uncovered: Boolean(hit && (hit === el || el.contains(hit))),
    };
  }, testId);
}

const report = {
  profile: PROFILE_NAME,
  viewport: PROFILE.viewport,
  shortPhone: SHORT_PHONE,
  keyboardPx: KEYBOARD_PX,
  motion: "no-preference",
  dist: DIST_DIR,
  scenes: [],
  failures: [],
};

function fail(where, message) {
  report.failures.push(`${where}: ${message}`);
}

async function checkFirstScreen(page, where, ids, entry, label) {
  const results = {};
  for (const id of ids) {
    const target = await readTarget(page, id);
    results[id] = target;
    if (!target.present) fail(where, `${id} 없음 (${label})`);
    else if (!target.inside || !target.uncovered) {
      const height = await page.evaluate(() => innerHeight);
      fail(
        where,
        `${id}(${target.text})가 ${label} 첫 화면에 없다: top ${target.top}, bottom ${target.bottom}, 화면 높이 ${height}`
      );
    }
  }
  entry[label] = results;
}

async function measureScene(page, scheme, spec) {
  const where = `${spec.name} ${scheme}`;
  await page.getByTestId(spec.ready).waitFor({ state: "visible" });
  await settle(page);
  await scrollAllToOrigin(page);
  await settle(page);
  const entry = { name: spec.name, scheme };
  if (spec.transition) {
    entry.transition = spec.transition;
    if (spec.transition.worst.over > 0) {
      fail(where, `옮겨 가는 동안 가로 넘침 ${JSON.stringify(spec.transition.worst)}`);
    }
  }
  const shot = `${OUT_DIR}/${spec.name}-375-${scheme}.png`;
  await page.screenshot({ path: shot });
  entry.shot = shot;
  const geometry = await readGeometry(page);
  entry.geometry = geometry;
  for (const leak of geometry.leaks) fail(where, `가로 넘침 ${JSON.stringify(leak)}`);
  for (const field of geometry.fields) {
    if (!(field.fontSize >= FLOOR_PX)) fail(where, `${field.id} 글자 ${field.fontSize}px < ${FLOOR_PX}px`);
  }

  if (spec.firstScreen) {
    await checkFirstScreen(page, where, spec.firstScreen, entry, "firstScreen629");
  }

  // 내용이 한 화면보다 길면 전체를 한 장 더 찍는다. 앱의 스크롤은 문서가 아니라
  // 안쪽 상자라 fullPage가 먹지 않으므로 뷰포트를 내용 높이만큼 늘렸다 되돌린다.
  if (geometry.contentOverflowY > 0) {
    const full = PROFILE.viewport;
    await page.setViewportSize({ width: full.width, height: full.height + geometry.contentOverflowY });
    await settle(page);
    const fullShot = `${OUT_DIR}/${spec.name}-375-${scheme}-full.png`;
    await page.screenshot({ path: fullShot });
    entry.fullShot = fullShot;
    await page.setViewportSize(full);
    await settle(page);
    await scrollAllToOrigin(page);
  }

  if (spec.firstScreen) {
    await page.setViewportSize(SHORT_PHONE);
    await settle(page);
    await scrollAllToOrigin(page);
    await settle(page);
    await checkFirstScreen(page, where, spec.firstScreen, entry, "firstScreen548");
    if (spec.shortShot) {
      const shortShot = `${OUT_DIR}/${spec.name}-375x548-${scheme}.png`;
      await page.screenshot({ path: shortShot });
      entry.shortShot = shortShot;
    }
    await page.setViewportSize(PROFILE.viewport);
    await settle(page);
    await scrollAllToOrigin(page);
  }

  if (spec.keyboard) {
    const { focus, primary, fill: values = {} } = spec.keyboard;
    const full = PROFILE.viewport;
    await page.setViewportSize({ width: full.width, height: full.height - KEYBOARD_PX });
    await settle(page);
    // 빈 칸은 14px이든 16px이든 같은 그림이다. 사람이 친 글자가 보여야 확대의
    // 원인(글자 크기)이 캡처에 남는다.
    for (const [testId, value] of Object.entries(values)) {
      await page.getByTestId(testId).fill(value);
    }
    // iOS는 포커스 받은 칸을 키보드 위 보이는 영역의 가운데 근처로 굴린다.
    await page.getByTestId(focus).evaluate((el) => {
      el.focus();
      el.scrollIntoView({ block: "center" });
    });
    await settle(page);
    const kbShot = `${OUT_DIR}/${spec.name}-keyboard-375-${scheme}.png`;
    await page.screenshot({ path: kbShot });
    const kbGeometry = await readGeometry(page);
    const appHeight = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--app-viewport-height").trim()
    );
    const focused = await readTarget(page, focus);
    const primaryWithFocus = await readTarget(page, primary);
    await page.getByTestId(primary).scrollIntoViewIfNeeded();
    await settle(page);
    const primaryReachable = await readTarget(page, primary);
    entry.keyboard = {
      shot: kbShot,
      viewportHeight: kbGeometry.innerHeight,
      appViewportHeight: appHeight,
      leaks: kbGeometry.leaks,
      focused,
      primaryVisibleWithFocus: primaryWithFocus.inside && primaryWithFocus.uncovered,
      primaryReachable,
    };
    for (const leak of kbGeometry.leaks) fail(`${where} 키보드`, `가로 넘침 ${JSON.stringify(leak)}`);
    if (!focused.present || !focused.inside) {
      fail(`${where} 키보드`, `포커스 받은 ${focus}가 보이는 영역 밖이다 ${JSON.stringify(focused)}`);
    }
    if (!primaryReachable.present || !primaryReachable.inside || !primaryReachable.uncovered) {
      fail(`${where} 키보드`, `${primary}가 스크롤로 닿지 않거나 가려진다 ${JSON.stringify(primaryReachable)}`);
    }
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.setViewportSize(full);
    await settle(page);
    await scrollAllToOrigin(page);
  }
  report.scenes.push(entry);
  const leakText = geometry.leaks.length ? geometry.leaks.map((l) => `${l.where}+${l.over}`).join(",") : "0";
  console.log(
    `  ${where}: 가로 넘침 ${leakText}` +
      (entry.transition ? ` · 옮기는 동안 ${entry.transition.worst.over}` : "") +
      ` · 칸 ${geometry.fields.map((f) => `${f.id} ${f.fontSize}`).join(" / ") || "-"}` +
      (entry.keyboard ? ` · 키보드 ${entry.keyboard.appViewportHeight} 주요 버튼 ${entry.keyboard.primaryReachable.inside && entry.keyboard.primaryReachable.uncovered ? "닿음" : "안 닿음"}` : "")
  );
}

async function newPhonePage(browser, scheme) {
  const context = await browser.newContext({
    ...PROFILE,
    colorScheme: scheme,
    reducedMotion: "no-preference",
  });
  await installMocks(context);
  const page = await context.newPage();
  return { context, page };
}

async function login(page, origin) {
  await page.goto(origin, { waitUntil: "networkidle" });
  // D0(#2808): 빈 칸 [계속]은 이 페이지의 서버다.
  await page.getByTestId("connect-entry-submit").click();
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="onboarding-sign-in"]'));
}

async function flowLogin(browser, origin, scheme) {
  const { context, page } = await newPhonePage(browser, scheme);
  await page.goto(origin, { waitUntil: "networkidle" });
  await measureScene(page, scheme, {
    name: "login-welcome",
    ready: "onboarding-welcome",
    keyboard: { focus: "connect-entry", primary: "connect-entry-submit" },
  });
  const transition = await watchTransition(page, () =>
    page.getByTestId("connect-entry-submit").click()
  );
  await measureScene(page, scheme, {
    name: "login-sign-in",
    ready: "onboarding-sign-in",
    transition,
    keyboard: {
      focus: "login-password",
      primary: "login-submit",
      fill: { "login-email": "seongjae@dawn.example", "login-password": "capture-only-not-a-credential" },
    },
  });
  await context.close();
}

async function flowJoin(browser, origin, scheme) {
  const { context, page } = await newPhonePage(browser, scheme);
  await page.goto(`${origin}/join?code=${INVITE_CODE}`, { waitUntil: "networkidle" });
  // D1′(#2810): 링크가 코드를 채우고 이메일·새 비밀번호·표시 이름이 한 화면이다.
  await measureScene(page, scheme, {
    name: "join",
    ready: "onboarding-join",
    keyboard: {
      focus: "onboarding-profile-name",
      primary: "login-submit",
      fill: {
        "login-email": "jiwoo@dawn.example",
        "login-password": "capture-only-not-a-credential",
        "onboarding-profile-name": "박지우",
      },
    },
  });
  await context.close();
}

async function flowClaim(browser, origin, scheme) {
  const { context, page } = await newPhonePage(browser, scheme);
  await page.goto(`${origin}/claim/${CLAIM_TOKEN}`, { waitUntil: "networkidle" });
  await measureScene(page, scheme, {
    name: "claim",
    ready: "claim-submit",
    keyboard: {
      focus: "claim-confirm",
      primary: "claim-submit",
      fill: { "claim-password": "capture-only-not-a-credential", "claim-confirm": "capture-only-not-a-credential" },
    },
  });
  await page.getByTestId("claim-password").fill("capture-only-not-a-credential");
  await page.getByTestId("claim-confirm").fill("capture-only-not-a-credential");
  let transition = await watchTransition(page, () => page.getByTestId("claim-submit").click());
  await measureScene(page, scheme, {
    name: "claim-s1",
    ready: "onboarding-s1",
    transition,
    keyboard: {
      focus: "onboarding-s1-handle",
      primary: "onboarding-s1-submit",
      fill: { "onboarding-s1-display-name": "곽성재" },
    },
  });
  await page.getByTestId("onboarding-s1-display-name").fill("곽성재");
  transition = await watchTransition(page, () => page.getByTestId("onboarding-s1-submit").click());
  await measureScene(page, scheme, { name: "claim-s2", ready: "onboarding-s2", transition });
  transition = await watchTransition(page, () => page.getByTestId("onboarding-s2-issue").click());
  await measureScene(page, scheme, { name: "claim-s2-issued", ready: "onboarding-s2-continue", transition });
  await context.close();
}

const FIRST_AGENT_POSES = [
  ["cards", "first-agent-cards"],
  ["one-time", "hosted-pairing-card"],
  ["detecting", "first-agent-detecting"],
  ["done", "first-agent-mention"],
];

async function flowFirstAgent(browser, origin, scheme) {
  for (const [pose, ready] of FIRST_AGENT_POSES) {
    const { context, page } = await newPhonePage(browser, scheme);
    await login(page, origin);
    const transition = await watchTransition(page, () =>
      page.evaluate((next) => {
        window.location.hash = `/?firstAgent=${next}`;
      }, pose)
    );
    await page.getByTestId("first-agent-stage").waitFor({ state: "visible" });
    await measureScene(page, scheme, {
      name: `first-agent-${pose}`,
      ready,
      transition,
      firstScreen: ["first-agent-skip"],
      shortShot: pose === "cards",
    });
    await context.close();
  }
}

async function flowPhoneLink(browser, origin, scheme) {
  const { context, page } = await newPhonePage(browser, scheme);
  await login(page, origin);
  await page.evaluate(() => sessionStorage.setItem("momo.web.phoneLinkFirstRun.v1", "pending"));
  await page.reload({ waitUntil: "networkidle" });
  await measureScene(page, scheme, { name: "phone-link", ready: "onboarding-phone-link" });
  await context.close();
}

async function main() {
  if (!PROFILE) throw new Error(`Playwright device profile missing: ${PROFILE_NAME}`);
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    throw new Error(`${DIST_DIR}/index.html is missing. Run \`npm run build:design\` first.`);
  }
  if (!existsSync(webkit.executablePath())) {
    throw new Error(`Playwright WebKit is missing (${webkit.executablePath()}). Run \`npx playwright install webkit\`.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", DIST_DIR],
  });
  try {
    const browser = await webkit.launch();
    try {
      for (const scheme of ["light", "dark"]) {
        console.log(`[${scheme}]`);
        await flowLogin(browser, preview.origin, scheme);
        await flowJoin(browser, preview.origin, scheme);
        await flowClaim(browser, preview.origin, scheme);
        await flowFirstAgent(browser, preview.origin, scheme);
        await flowPhoneLink(browser, preview.origin, scheme);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  writeFileSync(`${OUT_DIR}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${OUT_DIR}/report.json (${report.scenes.length} scenes)`);
  if (report.failures.length > 0) {
    console.log(`failures (${report.failures.length}):`);
    for (const line of report.failures) console.log(`  - ${line}`);
    if (!ALLOW_FAILURES) process.exit(1);
  } else {
    console.log("failures: 0");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
