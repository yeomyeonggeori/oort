#!/usr/bin/env node
// =============================================================================
// 워크스페이스 4b 재캡처 (ADR-0161 · 3R design-review H-1/H-2/M-2).
//
// 두 자리만 찍는다. 3R 이 실측으로 잡아낸 바로 그 두 자리다.
//
//   w4b-rail-avatar-{light,dark}.png    H-1: 아바타가 걸린 현재 워크스페이스
//                                       타일에서 액센트 마커가 실제로 보이는가.
//   w4b-leave-confirm-{light,dark}.png  H-2/M-2: 나가기 질문이 문장으로 서고,
//                                       포커스가 파괴 버튼이 아니라 질문에 있고,
//                                       Esc 가 설정이 아니라 질문만 닫는가.
//
//   node scripts/capture-w4b.mjs        # -> artifacts/design/w4b-*.png
//   OUT_DIR=/tmp/shots node scripts/capture-w4b.mjs
//
// **사진만으로 끝내지 않는다.** 3R 의 결함은 둘 다 "화면을 봐서는 애매한" 종류였다
// (마커 가시 폭 0px, 포커스가 어느 노드에 태어나는가). 그래서 이 스크립트는 찍기
// 전에 같은 것을 **재고**, 값이 틀리면 실패한다 — 사진은 사람이 보고, 수는 게이트가
// 본다. 앞 판이 초록이었던 이유가 정확히 "아무도 그 수를 재지 않아서"였다.
//
// 자격증명도 백엔드도 없다: /v1 은 아래 픽스처가 답한다. 아바타 바이트는 이 파일이
// 만든 PNG 한 장이고(Drive 미접촉), 토큰 문자열은 전부 캡처용 상수다.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5187);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 900 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const AVATAR_MEDIA = "019f94e3-2222-7000-8000-0000000000a1";

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
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
];

/**
 * 아바타 한 장. 8x8 단색 PNG 를 손으로 짠다 — 외부 에셋을 들이지 않기 위해서이고,
 * 색은 팔레트와 무관한 중립 회색이라 "마커가 보이는가"를 색으로 헷갈리게 하지
 * 않는다. (마커는 --accent, 아바타는 회색 → 겹치면 눈으로도 구분된다.)
 */
function avatarPng() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // one filter byte + RGB per row
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x8a)])
    )
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const AVATAR_BYTES = avatarPng();

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * `withAvatar` 가 참이면 워크스페이스가 아바타를 갖는다 — H-1 의 조건이다
 * (아바타가 **없을** 때는 앞 판에서도 마커가 보였다; 자르는 상자가 아바타 때문에
 * 생겼으므로).
 */
async function installMocks(context, { withAvatar }) {
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
    json(route, { members: [] })
  );
  // 아바타 바이트: 서버의 인가 프록시 자리. 클라는 베어러를 실어 부르고 dataURL 로 건다.
  await context.route("**/v1/workspaces/*/avatar/content*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "private, max-age=31536000, immutable" },
      body: AVATAR_BYTES,
    })
  );
  // 포괄 스텁 뒤에 등록해야 이긴다(capture-usage/eventsub 와 같은 관례).
  await context.route(
    new RegExp(`/v1/workspaces/[^/]+$`),
    (route) =>
      json(route, {
        workspace: {
          id: WORKSPACE_ID,
          slug: "dawnlab",
          name: "새벽연구소",
          updatedAtMs: Date.now(),
          roleLabels: {},
          ...(withAvatar
            ? { avatarUrl: `/v1/workspaces/${WORKSPACE_ID}/avatar/content?v=${AVATAR_MEDIA}` }
            : {}),
        },
      })
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
 * H-1 의 자 — 마커가 **부모의 클리핑을 통과해** 화면에 남긴 폭.
 *
 * `getBoundingClientRect` 만으로는 못 잡는다: 클리핑된 요소도 자기 사각형은 그대로
 * 보고한다(앞 판이 초록이었던 이유). 그래서 조상들의 `overflow` 를 훑어 실제 잘리는
 * 상자와 교집합을 낸다 — 3R 이 `markerVisibleWidthUnderClip` 이라 부른 그 수다.
 */
const MARKER_VISIBLE_WIDTH = `((tile) => {
  const marker = tile.querySelector('[aria-hidden="true"]');
  if (!marker) return { error: "no marker" };
  const rect = marker.getBoundingClientRect();
  let left = rect.left;
  let right = rect.right;
  for (let node = marker.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips = /hidden|clip|auto|scroll/.test(style.overflowX);
    if (!clips) continue;
    const box = node.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return {
    declaredWidth: Math.round(rect.width * 100) / 100,
    visibleWidth: Math.round(Math.max(0, right - left) * 100) / 100,
  };
})(document.querySelector('[data-testid="workspace-current"]'))`;

async function captureScheme(browser, scheme) {
  const shots = [];

  // ---- H-1: 아바타가 걸린 타일에서 마커가 살아 있는가 ----------------------
  {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context, { withAvatar: true });
    const page = await signIn(context);
    await page.getByTestId("workspace-avatar-image").waitFor({ state: "visible" });

    const measured = await page.evaluate(MARKER_VISIBLE_WIDTH);
    if (measured.error) throw new Error(`H-1 ${scheme}: ${measured.error}`);
    // 3R 실측은 visibleWidth 0 이었다. 마커 폭은 --spacing-marker(2px)이고, 이제
    // 부모가 자르지 않으므로 선언 폭이 그대로 남아야 한다.
    if (measured.visibleWidth < measured.declaredWidth) {
      throw new Error(
        `H-1 ${scheme}: 현재 워크스페이스 마커가 아직 잘린다 — ` +
          `declared=${measured.declaredWidth}px visible=${measured.visibleWidth}px ` +
          `(아바타가 걸린 타일에서 「현재」 신호가 사라진다)`
      );
    }
    console.log(
      `  H-1 ${scheme}: marker declared=${measured.declaredWidth}px visible=${measured.visibleWidth}px`
    );

    const path = `${OUT_DIR}/w4b-rail-avatar-${scheme}.png`;
    // 레일과 그 이웃만. 전체 창을 찍으면 2px 마커가 리뷰어 눈에 보이지 않는다.
    await page.locator('[data-testid="sidebar"]').screenshot({ path });
    shots.push(path);
    await context.close();
  }

  // ---- H-2/M-2: 나가기 질문 · 포커스 · Esc ---------------------------------
  {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context, { withAvatar: true });
    const page = await signIn(context);
    await page.evaluate('location.hash = "/settings?section=workspace"');
    await page.getByTestId("workspace-card").waitFor({ state: "visible" });

    // 질문을 연다.
    await page.getByTestId("workspace-leave").click();
    const question = page.getByTestId("workspace-leave-question");
    await question.waitFor({ state: "visible" });

    // ① 포커스는 질문 그룹 위에 있다 — 파괴 버튼이 아니라. (앞 판: 노드 재사용으로
    //    파괴 버튼 위에 태어나 Enter-Enter 가 즉시 탈퇴+로그아웃이었다.)
    const focus = await page.evaluate(`(() => {
      const el = document.activeElement;
      return {
        testid: el && el.getAttribute("data-testid"),
        role: el && el.getAttribute("role"),
        label: el && el.getAttribute("aria-label"),
      };
    })()`);
    if (focus.testid !== "workspace-leave-question" || focus.role !== "group") {
      throw new Error(
        `H-2 ${scheme}: 포커스가 질문 그룹이 아니다 — ${JSON.stringify(focus)}`
      );
    }
    // ② 질문이 로그아웃까지 말한다 (M-2).
    if (!/로그아웃/.test(focus.label || "")) {
      throw new Error(
        `M-2 ${scheme}: 질문이 로그아웃을 말하지 않는다 — ${JSON.stringify(focus.label)}`
      );
    }
    console.log(`  H-2 ${scheme}: focus=${focus.testid} label="${focus.label}"`);

    const path = `${OUT_DIR}/w4b-leave-confirm-${scheme}.png`;
    await page.locator('[data-testid="settings-route"]').screenshot({ path });
    shots.push(path);

    // ③ Esc 는 질문만 닫는다 — 설정 전체가 아니라. (앞 판: 설정이 통째로 닫혔다.)
    await page.keyboard.press("Escape");
    await question.waitFor({ state: "hidden" });
    await page.getByTestId("settings-route").waitFor({ state: "visible" });
    await page.getByTestId("workspace-leave").waitFor({ state: "visible" });
    const afterEsc = await page.evaluate(
      `document.activeElement && document.activeElement.getAttribute("data-testid")`
    );
    if (afterEsc !== "workspace-leave") {
      throw new Error(
        `H-2 ${scheme}: Esc 뒤 포커스가 트리거로 돌아오지 않았다 — ${afterEsc}`
      );
    }
    console.log(`  H-2 ${scheme}: Esc → 질문만 닫힘, 설정 살아 있음, 포커스=${afterEsc}`);

    await context.close();
  }

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
