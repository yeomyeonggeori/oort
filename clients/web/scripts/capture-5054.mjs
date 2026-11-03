#!/usr/bin/env node
// =============================================================================
// 업데이트 소식 화면 캡처 (#5054, owner 11-03): 웹·데스크탑 화면, 라이트·다크, 한국어·영어.
//
//   npm run build && node scripts/capture-5054.mjs    # -> artifacts/design/release-notes-*.png
//   OUT_DIR=<dir> node scripts/capture-5054.mjs
//   APP_VERSION=0.1.42 node scripts/capture-5054.mjs  # 데스크탑 셸이 말하는 앱 버전(기본: 가장 새 소식의 desktopFrom[0])
//   DIST_DIR=<빌드 폴더> node scripts/capture-5054.mjs  # `vite build --outDir <빌드 폴더>`로 따로 만든 번들을 그린다(기본: dist)
//
// 등록부의 **실제 소식**을 그린다(가짜 소식이 아니다): 승격 때 `notes/v<버전>.ts`와 사전을 더한 뒤 같은 명령으로 owner 검수
// 화면을 뽑는다. 소식의 `others`가 비어 있으면 「그 밖에 바뀐 점」은 화면에 서지 않고, 채우면 같은 상세 화면에 선다.
//
// 장면(언어×스킴마다 한 번씩, 같은 기기 상태로 이어서):
//   popup   첫 실행 자동 창. 브라우저 탭은 앱 버전이 없어 자동으로 안 뜨므로(`useAppVersion`) 데스크탑 셸을 흉내 낸다:
//           `lib/env.ts`의 `IS_TAURI`는 `__TAURI_INTERNALS__`가 창에 있으면 참이고, `app_version` 명령만 답한다.
//   list    「자세히 보기」가 연 설정 › 업데이트 소식 목록(새 소식이 맨 위, 「지금 쓰는 버전」 표지).
//   detail  가장 새 소식의 버전 상세. 설정 본문은 안에서 스크롤하므로 내용 높이만큼 창을 늘려 한 장에 담는다.
//
// 백엔드도 자격도 없다: /v1은 아래 고정값으로 답한다. 데스크탑 셸 흉내는 화면을 그리는 데만 쓰고 네이티브 동작은 답하지 않는다
// (`runtime-unverified`: 실제 Tauri 셸·실기기 폰 화면은 이 캡처가 증명하지 않는다).
// =============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5254);
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const WINDOW = { width: 1280, height: 800 };
/** 버전 상세는 내용 높이만큼 창을 늘려 한 장에 담는다(캡처 한 장의 높이 한계 안에서). */
const MAX_DETAIL_HEIGHT = 6000;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const TOKEN = "capture-only-not-a-credential";

const SESSION = {
  accessToken: TOKEN,
  refreshToken: TOKEN,
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 2,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_000,
  },
];

/** 가장 새 소식 파일의 `desktopFrom[0]`: 데스크탑 셸이 그 버전이라고 말하게 한다(없으면 `APP_VERSION`을 준다). */
function newestDesktopVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const dir = resolve(WEB_ROOT, "../../packages/momo-core/src/features/releaseNotes/notes");
  const key = (file) => file.replace(/^v|\.ts$/g, "").split("_").map(Number);
  const files = readdirSync(dir)
    .filter((file) => /^v\d+_\d+_\d+\.ts$/.test(file))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
  const match = /desktopFrom:\s*\[\s*"([^"]+)"/.exec(readFileSync(resolve(dir, files[0]), "utf8"));
  if (!match) throw new Error(`desktopFrom을 못 읽었다: ${files[0]} (APP_VERSION을 주세요)`);
  return match[1];
}

function json(route, body) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) => json(route, { channels: [], members: [], read_states: [], messages: [] }));
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) => json(route, { accessToken: TOKEN, refreshToken: TOKEN }));
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: TOKEN,
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    }),
  );
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: ROSTER }));
}

/**
 * 데스크탑 셸 흉내(머리말 참고): 브라우저 안에서 실행되는 함수라 바깥 값을 쓰지 못한다. 인자로 버전만 받는다.
 * `app_version`만 답한다. 자격 저장소(`keychain_*`)는 없는 셸로 답해(거절) 세션이 웹 저장소로 내려가 브라우저 탭과 같은 길로
 * 머문다: 저장소가 답하지 않는 흉내를 내면 첫 갱신이 어긋나 로그인 직후 로그아웃된다. 나머지 명령은 「없음」(null)이다.
 */
function desktopShell(version) {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command.startsWith("keychain_")) throw new Error("no credential store in this capture shell");
      return command === "app_version" ? version : null;
    },
    transformCallback: () => 0,
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))),
  );
}

async function captureOne(browser, { scheme, language, version }) {
  const context = await browser.newContext({
    viewport: WINDOW,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    locale: language,
    reducedMotion: "reduce",
  });
  const shots = [];
  try {
    await installMocks(context);
    await context.addInitScript(desktopShell, version);
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    // 데스크탑 셸의 첫 화면은 같은 출처 서버를 가정하지 않아서 서버 주소를 받는다(`connect-entry`): 이 미리보기 서버의 주소를 준다.
    await advanceToAccount(page, { path: "invite", inviteLink: ORIGIN });
    await page.getByTestId("login-email").fill("seongjae@dawn.example");
    await page.getByTestId("login-password").fill(TOKEN);
    await page.getByTestId("login-submit").click();
    await page.getByTestId("channel-list").waitFor({ state: "visible" });

    const shoot = async (scene) => {
      await settle(page);
      const path = `${OUT_DIR}/release-notes-${scene}-${language}-${scheme}.png`;
      await page.screenshot({ path });
      shots.push(path);
    };

    // popup: 업데이트 뒤 처음 여는 자동 창.
    await page.getByTestId("release-notes-dialog").waitFor({ state: "visible" });
    await shoot("popup");

    // list: 「자세히 보기」가 설정 › 업데이트 소식으로 데려간다.
    await page.getByTestId("release-notes-details").click();
    await page.getByTestId("release-notes-page").waitFor({ state: "visible" });
    await shoot("list");

    // detail: 가장 새 소식(목록의 맨 위 줄)의 버전 상세. 설정 본문은 안에서 스크롤하므로 내용 높이만큼 창을 늘린다.
    await page.locator('[data-testid^="release-notes-open-"]').first().click();
    const detail = page.getByTestId("release-notes-detail");
    await detail.waitFor({ state: "visible" });
    const box = await detail.boundingBox();
    const fit = Math.ceil((box?.y ?? 0) + (box?.height ?? 0) + 96);
    await page.setViewportSize({ width: WINDOW.width, height: Math.min(MAX_DETAIL_HEIGHT, Math.max(WINDOW.height, fit)) });
    await shoot("detail");
  } finally {
    await context.close();
  }
  return shots;
}

const ORIGIN = `http://127.0.0.1:${PORT}`;

async function main() {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    throw new Error(`${DIST_DIR}/index.html is missing. Run \`npm run build\` first.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const version = newestDesktopVersion();
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: ["--outDir", DIST_DIR],
  });
  try {
    const browser = await chromium.launch();
    try {
      for (const language of ["ko-KR", "en-US"]) {
        for (const scheme of ["light", "dark"]) {
          for (const path of await captureOne(browser, { scheme, language, version })) console.log(path);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
