#!/usr/bin/env node
// #5567 캡처: 입력창 영역 — 밝게·어둡게 × 1280·900, 혼자 작성 중(두 사람 DM)·둘 작성 중(채널). 판정하지 않는다.
//
//   npm run build && node scripts/capture-5567.mjs                       지금 번들(dist)
//   CAP5567_DIST=<다른 번들 폴더> CAP5567_TAG=before node scripts/capture-5567.mjs   수리 전 번들
//   CAP5567_ABOVE=1 …                                                   다른 자리 안(입력 카드 위) 흉내 — 캡처 안에서 줄을
//                                                                       카드 위로 옮겨 찍는다(제품 코드가 아니다, 미검증 시안)
//   CAP5567_OUT=<폴더>                                                   기본 artifacts/cap5567
//
// 번들 Chromium 헤드리스만 띄운다. 목은 gates/gate-typing-jitter.mjs 와 같은 모양이다(가짜 레일·라우트).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CAP5567_PORT || 5199);
const origin = `http://127.0.0.1:${port}`;
const tag = process.env.CAP5567_TAG || "after";
const dist = process.env.CAP5567_DIST || null;
const above = process.env.CAP5567_ABOVE === "1";
const outDir = resolve(process.env.CAP5567_OUT || resolve(webRoot, "artifacts/cap5567"));

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "00000000-0000-7000-8000-000000000111";
const peerId = "00000000-0000-7000-8000-000000000112";
const thirdId = "00000000-0000-7000-8000-000000000113";
const dmChannelId = "00000000-0000-7000-8000-000000000212";
const generalId = "00000000-0000-7000-8000-000000000211";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: meId, workspaceId, kind: "human", displayName: "윤서진", handle: "seojin" },
  realtimeWebSocketUrl: "ws://capture-5567.invalid/connection/websocket",
};

function rosterMember(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 2,
    channelIds: [generalId, dmChannelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  rosterMember({ id: meId, kind: "human", role: "owner", displayName: "윤서진", handle: "seojin" }),
  rosterMember({ id: peerId, kind: "human", displayName: "한지후", handle: "jihu" }),
  rosterMember({ id: thirdId, kind: "human", displayName: "오민재", handle: "minjae", channelIds: [generalId] }),
];

const channels = [
  { id: generalId, workspaceId, kind: "public", name: "release-11", topic: "", muted: false },
  { id: dmChannelId, workspaceId, kind: "dm", muted: false, memberIds: [meId, peerId] },
];

const LINES = [
  "오늘 배포 전에 마이그레이션 순서 한 번만 같이 봐 줄 수 있어요?",
  "네, 10분 뒤에 볼게요. outbox relay 쪽은 어제 고친 그대로예요.",
  "staging에서 5xx 두 건 있었는데 둘 다 timeout이었어요.",
  "그건 Centrifugo 재연결 구간이라 서버 오류는 아니었던 것 같아요.",
  "릴리스 노트에 그 문장 한 줄만 추가해 둘게요.",
  "확인했어요. 그러면 이번 배포는 그대로 가도 되겠네요.",
];

function history(channelId, authors) {
  return Array.from({ length: 30 }, (_, i) => ({
    id: `0199${channelId === dmChannelId ? "dddd" : "cccc"}-0000-7000-8000-${String(i).padStart(12, "0")}`,
    channelId,
    seq: i + 1,
    hlcTs: 1_785_238_400_000 + i * 60_000,
    hlcCount: 0,
    authorMemberId: authors[i % authors.length],
    type: "text",
    body: LINES[i % LINES.length],
    state: "sent",
    createdAtMs: 1_785_238_400_000 + i * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installRoutes(context) {
  const dm = history(dmChannelId, [peerId, meId, peerId]);
  const general = history(generalId, [peerId, thirdId, meId]);
  await context.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "t", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 600, workspaceId, memberId: meId });
    }
    if (path === "/v1/auth/refresh") return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (path.endsWith("/typing/grant")) {
      return json(route, { grant: "g", channel: "typing:x", expiresAtMs: Date.now() + 600_000, ttlSeconds: 600, signalTtlMs: 6_000, republishIntervalMs: 3_000, aggregateThreshold: 3 });
    }
    if (path.endsWith("/typing")) return json(route, { channel: "typing:x", expiresAtMs: Date.now() + 6_000, republishAfterMs: 3_000 }, 202);
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      if (path.includes(dmChannelId)) return json(route, { messages: dm });
      if (path.includes(generalId)) return json(route, { messages: general });
      return json(route, { messages: [] });
    }
    return json(route, {});
  });
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
    let offset = 0;
    class CaptureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.subscriptions = new Set();
        sockets.add(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      send(data) {
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) replies.push({ id: command.id, connect: { client: "cap5567", version: "6" } });
          else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({ id: command.id, subscribe: { recoverable: true, positioned: true, recovered: true, epoch: "cap5567", offset } });
          } else if (command.unsubscribe) {
            this.subscriptions.delete(command.unsubscribe.channel);
            replies.push({ id: command.id, unsubscribe: {} });
          } else replies.push({ id: command.id });
        }
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() {
        this.readyState = 3;
        sockets.delete(this);
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = CaptureWebSocket;
    window.__capReady = (channelId) => {
      for (const socket of sockets) for (const name of socket.subscriptions) if (name.startsWith("typing:") && name.includes(channelId)) return true;
      return false;
    };
    window.__capPublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("typing:")) continue;
          socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ push: { channel: name, pub: { data: frame, offset } } }) }));
        }
      }
    };
  });
}

async function openChannel(page, channelId) {
  await page.locator(`[data-testid="channel-item"][data-channel-id="${channelId}"]`).click();
  await page.getByTestId("composer-input").waitFor();
  await page.waitForFunction((id) => window.__capReady(id.toUpperCase()), channelId, { timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function typing(page, channelId, memberIds) {
  for (const memberId of memberIds) {
    await page.evaluate(
      ({ ws, ch, who }) =>
        window.__capPublish({
          type: "ephemeral.typing",
          v: 1,
          ts: Date.now(),
          payload: { workspace_id: ws.toUpperCase(), channel_id: ch.toUpperCase(), member_id: who.toUpperCase(), expires_at: Date.now() + 60_000 },
        }),
      { ws: workspaceId, ch: channelId, who: memberId }
    );
  }
  await page.waitForFunction(
    (count) => document.querySelector('[data-testid="composer-typing"]')?.getAttribute("data-count") === String(count),
    memberIds.length,
    { timeout: 5_000 }
  );
}

/** 다른 자리 안: 줄을 카드 위로 옮기고 카드 아래 여백 18을 되돌린다(시안 흉내, 제품 코드가 아니다). */
async function moveAbove(page) {
  await page.evaluate(() => {
    const line = document.querySelector('[data-testid="typing-line"]');
    const frame = document.querySelector('[data-testid="composer-frame"]');
    const form = frame?.parentElement;
    if (!line || !frame || !form) throw new Error("다른 자리 안을 만들 노드가 없다");
    form.insertBefore(line, frame);
    form.classList.add("cap5567-above");
  });
  await page.addStyleTag({ content: ".cap5567-above{padding-bottom:18px!important}.cap5567-above>[data-testid=typing-line]{margin-block-end:4px}" });
}

async function shoot(page, name) {
  const box = await page.evaluate(() => {
    const dock = document.querySelector('[data-testid="composer"]');
    const column = document.querySelector('[data-testid="chat-timeline"]');
    if (!dock || !column) return null;
    const d = dock.getBoundingClientRect();
    const c = column.getBoundingClientRect();
    return { x: Math.floor(c.left), y: Math.floor(d.top - 140), width: Math.ceil(c.width), height: Math.ceil(d.bottom - d.top + 140 + 8) };
  });
  if (box === null) throw new Error("캡처할 입력창 영역이 없다");
  await page.screenshot({ path: resolve(outDir, `${name}.png`), clip: box });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "CAP5567_PORT",
    extraArgs: dist ? ["--outDir", dist] : [],
  });
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const scheme of ["light", "dark"]) {
        for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 700 }]) {
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", locale: "ko-KR" });
          const page = await context.newPage();
          await installRealtimeSocket(page);
          await installRoutes(context);
          await page.goto(origin, { waitUntil: "networkidle" });
          await advanceToAccount(page);
          await page.getByTestId("login-email").fill("capture@example.test");
          await page.getByTestId("login-password").fill("gate-only");
          await page.getByTestId("login-submit").click();
          const suffix = `${scheme}-${viewport.width}`;
          await openChannel(page, dmChannelId);
          await page.getByTestId("composer-input").fill("네 지금 확인해 볼게요");
          await typing(page, dmChannelId, [peerId]);
          if (above) await moveAbove(page);
          await shoot(page, `${tag}-solo-${suffix}`);
          if (!above) {
            await openChannel(page, generalId);
            await typing(page, generalId, [peerId, thirdId]);
            await shoot(page, `${tag}-two-${suffix}`);
          }
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log(`[cap5567] ${tag}${above ? " (위 자리 흉내)" : ""} → ${outDir}`);
}

await main();
