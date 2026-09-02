#!/usr/bin/env node
// GATE: huddle configuration, active projection and realtime end transition.
//
// No backend, credentials, microphone, or real audio. LiveKit media and the
// Tauri WKWebView permission prompt remain orchestrator-owned manual checks.
// This gate locks the browser states the ticket can prove with fixtures:
//   1. a server WITHOUT huddles shows nothing at all: no control, no banner, no
//      error. Two shapes answer that way and both are checked (goal B6): 503
//      (operator configured LiveKit off) and 404 (the route is not built yet,
//      which is what momowebqa answers today). The 404 used to fall through to
//      the generic failure branch, so every channel header carried a red
//      "허들 상태를 불러오지 못했습니다" line about a feature the server never
//      claimed to have;
//   2. active Live badge and participant display names come from REST;
//   3. huddle_ended removes the badge even when an older active GET resolves
//      afterwards (the intentionally inverted response timing);
//   4. at 760x480 joined controls have a finite width, leaving the channel title
//      measurable and the terminal-dock toggle inside the viewport;
//   5. at 390x844 (live + joined) the right group stays inside the viewport,
//      does not paint over the drawer toggle or channel hash, and the title
//      still has a measurable width. Joined Live chip and mic picker yield
//      (wide-only) so mute/leave do not paint over the member button.
//      Controls inside the header do not overlap each other;
//   6. after audio joined, a projection 500 cannot hide Live, microphone or exit.
//
// Red proofs:
//   HUDDLE_GATE_PROVE_RED_503=1 npm run gate:huddle
//   HUDDLE_GATE_PROVE_RED_ENDED=1 npm run gate:huddle

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HUDDLE_GATE_PORT || 5183);
const origin = `http://127.0.0.1:${port}`;
const outDir = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(webRoot, "artifacts/huddle");
const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const huddleId = "00000000-0000-7000-8000-000000000643";
const teammateId = "019f9a01-0000-7000-8000-000000000400";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://huddle-gate.invalid/connection/websocket",
};
const channel = {
  id: channelId,
  workspaceId,
  kind: "public",
  name: "제품-웹",
  muted: false,
};
const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: teammateId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "admin",
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];
const activeHuddle = {
  id: huddleId,
  workspaceId,
  channelId,
  startedBy: teammateId,
  startedAtMs: 1_722_000_000_000,
  endedAtMs: null,
  participants: [
    {
      memberId: teammateId,
      displayName: "Nadia Rahman — 제품 디자인 운영",
      joinedAtMs: 1_722_000_001_000,
    },
    {
      memberId,
      displayName: "곽성재 — 웹 클라이언트",
      joinedAtMs: 1_722_000_002_000,
    },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    let offset = 0;
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
        this.subscriptions = new Set();
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) {
            replies.push({
              id: command.id,
              connect: { client: "huddle-gate-client", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: false,
                epoch: "huddle-gate",
                offset,
              },
            });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            replies.push({ id: command.id, unsubscribe: {} });
          } else {
            replies.push({ id: command.id });
          }
        }
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
          );
        });
      }

      close() {
        this.readyState = GateWebSocket.CLOSED;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }

    window.WebSocket = GateWebSocket;
    window.__huddleGatePublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const channelName of socket.subscriptions) {
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: {
                  channel: channelName,
                  pub: { data: frame, offset },
                },
              }),
            })
          );
        }
      }
    };
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    // 로그인 직후의 토큰 회전 (#1089). 이 분기가 없으면 맨 아래 포괄
    // `return json(route, {})` 가 200 을 주지만 **모양이 비어 있고**, 코어의
    // `refreshResponseFromWire`(packages/momo-core/src/lib/api.ts:632)는 두 필드가
    // 문자열이 아니면 throw 한다 → `markAuthExpired()` → 앱이 스스로 로그아웃한다.
    // 증상은 `openSignedIn` 이 `nav[aria-label='워크스페이스 탐색']` 을 30초
    // 기다리다 죽는 것이었다(규명 3/4).
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/channels")) return json(route, { channels: [channel] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [] });
    }
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) {
      if (state.mode === "unconfigured") {
        return json(route, { error: { message: "허들 미구성" } }, 503);
      }
      // 허들 라우트가 아직 없는 세대의 서버 (goal B6). momowebqa가 지금 답하는
      // 형태이고, 이 티켓을 연 실캡처의 빨간 배너가 여기서 나왔다.
      if (state.mode === "unimplemented") {
        return json(route, { error: { message: "not found" } }, 404);
      }
      if (state.mode === "error") {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      if (state.delayActiveMs) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, state.delayActiveMs)
        );
      }
      return json(route, {
        huddle: state.mode === "active" ? activeHuddle : null,
      });
    }
    if (path.endsWith(`/huddles/${huddleId}/join`)) {
      return json(route, {
        huddle: activeHuddle,
        livekitUrl: "wss://livekit.gate.invalid",
        token: "gate-livekit-token",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
      });
    }
    if (path.endsWith(`/huddles/${huddleId}/leave`)) {
      return json(route, { huddle: activeHuddle, ended: false });
    }
    return json(route, {});
  });
}

async function openSignedIn(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("huddle@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");
  return page;
}

async function assertJoinedHeaderFits(page, { width, height, requireDrawer }) {
  await page.setViewportSize({ width, height });
  const geometry = await page.evaluate((vpWidth) => {
    const overlap = (a, b) =>
      Boolean(
        a &&
          b &&
          a.width > 0 &&
          b.width > 0 &&
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top
      );
    const header = document.querySelector("[data-testid='channel-header']");
    const left = header?.children[0];
    const title = header?.querySelector("h1")?.getBoundingClientRect();
    const toggle = document
      .querySelector("[data-testid='open-sidebar-drawer']")
      ?.getBoundingClientRect();
    const hash = left
      ?.querySelector(":scope > span[aria-hidden='true']")
      ?.getBoundingClientRect();
    const group = document
      .querySelector("[data-testid='channel-header-controls']")
      ?.getBoundingClientRect();
    const live = document
      .querySelector("[data-testid='huddle-live']")
      ?.getBoundingClientRect();
    const menu = document
      .querySelector("[data-testid='channel-title-menu']")
      ?.getBoundingClientRect();
    const workToggle = document
      .querySelector("[data-testid='open-terminal-dock']")
      ?.getBoundingClientRect();
    const controlIds = [
      "open-sidebar-drawer",
      "open-terminal-dock",
      "open-pin-list",
      "channel-member-count",
      "huddle-live",
      "huddle-microphone",
      "huddle-mic-devices",
      "huddle-leave",
      "channel-title-menu",
    ];
    const boxes = [];
    for (const id of controlIds) {
      const node = document.querySelector(`[data-testid='${id}']`);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({
        id,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    }
    if (hash && hash.width > 0 && hash.height > 0) {
      boxes.push({
        id: "channel-hash",
        left: hash.left,
        right: hash.right,
        top: hash.top,
        bottom: hash.bottom,
        width: hash.width,
        height: hash.height,
      });
    }
    const overlaps = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top
        ) {
          overlaps.push(`${a.id}×${b.id}`);
        }
      }
    }
    return {
      titleWidth: title?.width ?? 0,
      groupLeft: group?.left ?? -1,
      groupRight: group?.right ?? Number.POSITIVE_INFINITY,
      liveRight: live?.right ?? Number.POSITIVE_INFINITY,
      menuRight: menu?.right ?? Number.POSITIVE_INFINITY,
      workToggleRight: workToggle?.right ?? Number.POSITIVE_INFINITY,
      hashRight: hash?.right ?? 0,
      toggleRight: toggle?.right ?? 0,
      overlapsToggle: overlap(group, toggle),
      overlapsHash: overlap(group, hash),
      controlOverlaps: overlaps,
      controlBoxes: boxes,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: vpWidth,
    };
  }, width);
  if (geometry.titleWidth <= 0) {
    throw new Error(
      `joined header erased channel title at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  if (geometry.groupRight > width + 0.5 || geometry.menuRight > width + 0.5) {
    throw new Error(
      `control group escaped viewport at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  if (geometry.workToggleRight > width + 0.5) {
    throw new Error(
      `terminal-dock toggle escaped viewport at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  if (geometry.overlapsHash) {
    throw new Error(
      `control group overlapped the channel hash at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  if (requireDrawer && geometry.overlapsToggle) {
    throw new Error(
      `control group overlapped the drawer toggle at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  if (geometry.controlOverlaps.length > 0) {
    throw new Error(
      `header controls overlapped each other at ${width}: ${JSON.stringify(geometry.controlOverlaps)} ${JSON.stringify(geometry.controlBoxes)}`
    );
  }
  if (geometry.scrollWidth > width) {
    throw new Error(
      `joined header widened the document at ${width}: ${JSON.stringify(geometry)}`
    );
  }
  return geometry;
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "HUDDLE_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      for (const mode of ["unconfigured", "unimplemented", "idle", "error"]) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          reducedMotion: "reduce",
          colorScheme: "dark",
        });
        const state = { mode, delayActiveMs: 0 };
        await installRoutes(context, state);
        const page = await openSignedIn(context);
        const absent = mode === "unconfigured" || mode === "unimplemented";
        if (absent) {
          // 없는 기능은 아무 자리도 차지하지 않는다 (goal B6). 기다릴 것이
          // 없으므로 대신 **채널이 다 섰다는 사실**을 기다린 뒤, 허들이 남긴
          // 것이 정말 하나도 없는지 센다. 컴포저는 채널 표면의 마지막 줄이라,
          // 그것이 서 있으면 헤더도 배너 자리도 이미 확정이다.
          await page.getByTestId("composer-input").waitFor();
          const leftovers = {};
          for (const testId of [
            "huddle-surface",
            "huddle-start",
            "huddle-join",
            "huddle-live",
            "huddle-loading",
            "huddle-unconfigured",
            "huddle-error",
            "huddle-error-retry",
            "huddle-notice",
          ]) {
            leftovers[testId] = await page.getByTestId(testId).count();
          }
          const total = Object.values(leftovers).reduce((a, b) => a + b, 0);
          // 붉은 증명: isHuddleUnsupportedStatus에서 404(또는 503)를 빼면 이
          // 판정이 error로 떨어지고 huddle-error가 하나 남는다.
          const expected =
            process.env.HUDDLE_GATE_PROVE_RED_503 === "1" ? 1 : 0;
          if (total !== expected) {
            throw new Error(
              `${mode}: 허들 표면이 ${total}개 남았다 (기대 ${expected}) ${JSON.stringify(leftovers)}`
            );
          }
          // 채널 자체는 멀쩡해야 한다: 허들을 접는 것이 헤더를 지우는 것으로
          // 번지면 고친 것보다 더 큰 것을 부순 것이다.
          const title = await page.locator("h1").first().textContent();
          if (!title?.includes("제품-웹")) {
            throw new Error(`${mode}: 채널 제목이 사라졌다 (${title})`);
          }
          console.log(`ok  ${mode}: 허들 표면 0개, 채널 제목 "${title}" 유지`);
        } else {
          await page
            .getByTestId(mode === "idle" ? "huddle-start" : "huddle-error")
            .waitFor();
        }
        await page.screenshot({
          path: resolve(outDir, `${mode}.png`),
          fullPage: true,
        });
        await context.close();
      }

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
        colorScheme: "light",
      });
      const state = { mode: "active", delayActiveMs: 0 };
      await installRoutes(context, state);
      const page = await openSignedIn(context);
      await page.getByTestId("huddle-live").waitFor();
      const names = await page.getByTestId("huddle-participants").textContent();
      if (!names?.includes("Nadia Rahman") || !names.includes("곽성재")) {
        throw new Error(`active participants missing: ${JSON.stringify(names)}`);
      }
      await page.screenshot({
        path: resolve(outDir, "active.png"),
        fullPage: true,
      });

      await page.getByTestId("huddle-join").click();
      await page.getByTestId("huddle-microphone").waitFor();
      await page.getByTestId("huddle-leave").waitFor();
      await assertJoinedHeaderFits(page, {
        width: 760,
        height: 480,
        requireDrawer: false,
      });
      const geo390 = await assertJoinedHeaderFits(page, {
        width: 390,
        height: 844,
        requireDrawer: true,
      });
      console.log(
        "ok  390 joined header overlap 0",
        JSON.stringify({
          overlaps: geo390.controlOverlaps,
          boxes: geo390.controlBoxes,
        })
      );
      if (await page.getByTestId("huddle-live").isVisible()) {
        throw new Error(
          "joined Live chip must yield at 390 so mute and leave do not cover the member button"
        );
      }
      if (await page.getByTestId("huddle-mic-devices").isVisible()) {
        throw new Error(
          "mic picker caret must yield at 390 (folded into the mute split, wide-only)"
        );
      }
      if (await page.getByTestId("huddle-participants").isVisible()) {
        throw new Error("participant names must yield at 390");
      }
      await page.screenshot({
        path: resolve(outDir, "joined-390.png"),
        fullPage: true,
      });

      state.mode = "error";
      await page.evaluate(({ id, ch }) => {
        window.__huddleGatePublish?.({
          type: "huddle_participants_changed",
          v: 1,
          ts: Date.now(),
          payload: {
            huddle_id: id,
            channel_id: ch,
            participant_member_ids: [],
          },
        });
      }, { id: huddleId, ch: channelId });
      await page.getByTestId("huddle-error").waitFor();
      await page.getByTestId("huddle-microphone").waitFor();
      await page.getByTestId("huddle-leave").waitFor();
      if (!(await page.getByTestId("huddle-live").count())) {
        throw new Error("projection 500 hid joined Live state");
      }
      state.mode = "active";
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.evaluate(
        ({ id, ch, proveRed }) => {
          window.__huddleGatePublish?.({
            type: proveRed ? "huddle.participants.changed" : "huddle_ended",
            v: 1,
            ts: Date.now(),
            payload: {
              huddle_id: id,
              channel_id: ch,
              participant_member_ids: [],
            },
          });
        },
        {
          id: huddleId,
          ch: channelId,
          proveRed: process.env.HUDDLE_GATE_PROVE_RED_ENDED === "1",
        }
      );
      await page.getByTestId("huddle-live").waitFor({ state: "detached" });
      await page.getByTestId("huddle-start").waitFor();

      // Invert the fixture timing: an active read begins, huddle_ended wins,
      // then the old read finally resolves. The tombstone must keep Live gone.
      state.delayActiveMs = 700;
      await page.evaluate(({ id, ch }) => {
        window.__huddleGatePublish?.({
          type: "huddle_participants_changed",
          v: 1,
          ts: Date.now(),
          payload: {
            huddle_id: id,
            channel_id: ch,
            participant_member_ids: [],
          },
        });
      }, { id: huddleId, ch: channelId });
      await page.evaluate(({ id, ch }) => {
        window.__huddleGatePublish?.({
          type: "huddle_ended",
          v: 1,
          ts: Date.now(),
          payload: {
            huddle_id: id,
            channel_id: ch,
            participant_member_ids: [],
          },
        });
      }, { id: huddleId, ch: channelId });
      await page.waitForTimeout(900);
      if (await page.getByTestId("huddle-live").count()) {
        throw new Error("delayed active response resurrected the Live badge");
      }
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(
    "GATE PASS: configuration, joined width/exit controls (760 and 390 live), projection failure isolation, and huddle_ended ordering hold."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
