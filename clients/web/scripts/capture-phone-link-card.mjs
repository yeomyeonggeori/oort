#!/usr/bin/env node
// =============================================================================
// 첫 대화 채널의 「폰에서도」 카드 캡처 (#2818, ADR-0193 D7).
//
// 1280 + 390, light + dark: 대기 / QR 열림 / 접힘 / 연결됨, 그리고 1280 light
// 큰 글씨(루트 125%). 시안(온보딩 2.0 D5 `.kband`)과 나란히 놓은 비교 이미지는
// MOCKUP 경로가 있을 때만 만든다(시안 원본은 gitignore).
//
//   npm run capture:phone-link-card          # -> artifacts/design/phone-link-card-*.png
//   OUT_DIR=/tmp/shots MOCKUP=../../claudedocs/onboarding-2.0/mockups.html \
//     npm run capture:phone-link-card
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const MOCKUP = process.env.MOCKUP ? resolve(process.env.MOCKUP) : null;
const PORT = Number(process.env.CAPTURE_PORT || 5187);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const NOW = Date.UTC(2026, 8, 26, 6, 12, 0);

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const AGENT = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";
const LINK_ID = "019f9b10-0000-7000-8000-000000000d01";
const CARD_KEY = `oort.phoneLinkCard.v1:${WORKSPACE_ID}`;

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
  {
    id: GENERAL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "general",
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
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: AGENT,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "성재의 Claude",
    handle: "claude",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "claude-code",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const OPENER = {
  id: "0199eeee-0000-7000-8000-000000000501",
  workspaceId: WORKSPACE_ID,
  channelId: GENERAL_ID,
  seq: 1,
  hlcTs: NOW - 60_000,
  hlcCount: 0,
  authorMemberId: AGENT,
  type: "text",
  body:
    "안녕하세요 @곽성재님, 저는 이 맥의 Claude Code로 돌아가는 성재님의 에이전트예요. 여기서 부르면 바로 일을 받아요. 오늘 무엇부터 같이 할까요?",
  state: "sent",
  createdAtMs: NOW - 60_000,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context, { linked }) {
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
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname.includes("/replies")) {
      return json(route, { messages: [] });
    }
    return json(route, { messages: [OPENER] });
  });
  await context.route("**/v1/auth/device-link**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const tail = url.pathname.split("/device-link")[1] ?? "";
    if (method === "POST" && (tail === "" || tail === "/")) {
      return json(
        route,
        {
          id: LINK_ID,
          token: "capture-only-not-a-credential",
          expiresAt: Date.now() + 120_000,
          deepLink: `oort://link?server=${encodeURIComponent("https://team.example.com")}&token=capture-only-not-a-credential`,
        },
        201
      );
    }
    if (method === "GET") {
      return json(
        route,
        linked
          ? {
              status: "consumed",
              device: { name: "성재 iPhone 16 Pro", platform: "ios" },
            }
          : { status: "pending" }
      );
    }
    return route.fallback();
  });
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
    if (Date.now() > deadline) throw new Error(`preview never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openGeneral(context, cardState) {
  await context.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* capture only */
      }
    },
    { key: CARD_KEY, value: cardState }
  );
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, GENERAL_ID);
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  return page;
}

const SCENES = {
  idle: { state: "pending", linked: false, drive: async (page) => {
    await page.getByTestId("phone-link-card").waitFor({ state: "visible" });
  } },
  open: { state: "pending", linked: false, drive: async (page) => {
    await page.getByTestId("phone-link-card-create").click();
    await page.getByTestId("device-link-qr").waitFor({ state: "visible" });
  } },
  collapsed: { state: "pending", linked: false, drive: async (page) => {
    await page.getByTestId("phone-link-card-later").click();
    await page.getByTestId("phone-link-card-collapsed").waitFor({ state: "visible" });
  } },
  linked: { state: "pending", linked: true, drive: async (page) => {
    await page.getByTestId("phone-link-card-create").click();
    await page
      .locator('[data-testid="phone-link-card"][data-state="linked"]')
      .waitFor({ state: "visible" });
  } },
};

async function shoot(browser, { scene, scheme, viewport, large = false }) {
  const spec = SCENES[scene];
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context, { linked: spec.linked });
  const page = await openGeneral(context, spec.state);
  if (large) {
    await page.addStyleTag({ content: "html{font-size:125%}" });
  }
  await spec.drive(page);
  // 로그인 클릭 자리의 포인터가 메시지 행 호버 툴바를 띄우지 않게 치운다.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  const suffix = large ? "-large" : "";
  const path = `${OUT_DIR}/phone-link-card-${scene}-${viewport.width}-${scheme}${suffix}.png`;
  await page.screenshot({ path });
  await context.close();
  return path;
}

/** 시안 D5 창 한 장과 구현 한 장을 나란히 놓는다. */
async function compare(browser, { scheme, implPath }) {
  if (!MOCKUP || !existsSync(MOCKUP)) return null;
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(MOCKUP).href, { waitUntil: "load" });
  await page.evaluate((s) => {
    document.documentElement.setAttribute("data-theme", s);
    // D5 창에 다크 토큰을 입힌다(시안 `.T.dark`).
    const win = document.querySelector('[aria-label="데스크탑 첫 대화 화면"]');
    if (s === "dark") win?.classList.add("dark");
  }, scheme);
  const win = page.locator('[aria-label="데스크탑 첫 대화 화면"]');
  await win.scrollIntoViewIfNeeded();
  const mockPng = await win.screenshot();
  const implPng = readFileSync(implPath);
  const html = `<!doctype html><html><body style="margin:0;background:${scheme === "dark" ? "#111214" : "#e8e8eb"};font:14px -apple-system,sans-serif;color:${scheme === "dark" ? "#ededf0" : "#18181b"}">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:8px">시안 D5 (${scheme})</figcaption>
        <img style="width:760px" src="data:image/png;base64,${mockPng.toString("base64")}"></figure>
      <figure style="margin:0"><figcaption style="margin-bottom:8px">구현 #2818 (${scheme})</figcaption>
        <img style="width:760px" src="data:image/png;base64,${implPng.toString("base64")}"></figure>
    </div></body></html>`;
  const sheet = await context.newPage();
  await sheet.setContent(html, { waitUntil: "load" });
  const out = `${OUT_DIR}/phone-link-card-compare-${scheme}.png`;
  await sheet.screenshot({ path: out, fullPage: true });
  await context.close();
  return out;
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
      const shots = [];
      for (const scheme of ["light", "dark"]) {
        for (const viewport of [DESKTOP, PHONE]) {
          for (const scene of Object.keys(SCENES)) {
            shots.push(await shoot(browser, { scene, scheme, viewport }));
          }
        }
      }
      shots.push(
        await shoot(browser, {
          scene: "idle",
          scheme: "light",
          viewport: DESKTOP,
          large: true,
        })
      );
      for (const scheme of ["light", "dark"]) {
        const out = await compare(browser, {
          scheme,
          implPath: `${OUT_DIR}/phone-link-card-idle-1280-${scheme}.png`,
        });
        if (out) shots.push(out);
      }
      for (const path of shots) console.log(path);
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
