#!/usr/bin/env node
// GATE: #5189 이미지 첨부 카드 — 모서리가 알약이 되지 않고, 가로로 긴 캡처가 읽히며,
// 그려진 픽셀이 표시 크기를 받친다. (규칙 정본: docs/design-system/README.md §2.10)
//
// 재는 것은 클래스 이름이 아니라 **렌더된 상자**다:
//
//   1. 모서리      그림의 반경이 짧은 변의 1/4 을 넘지 않는다(그리고 `--radius-md`
//                  10 을 넘지 않는다). 계산된 스타일의 표기(`min(10px, 25%)`)를 폭·높이로
//                  풀어 재고, 따로 **찍힌 픽셀**로 알약을 한 번 더 본다(왼쪽 가장자리 줄에서 바탕색이
//                  몇 픽셀 이어지는가 — 표기·래퍼·clip 어디서 깎았든 보이는 모양을 잰다).
//                  버튼 틀이 그림과 같은 반경을 가져야 클립과 포커스 링이 어긋나지 않는다.
//   2. 크기 규칙   표시 크기가 README §2.10 의 글로 적힌 공식(보통 상자 360×320 과 넓은 상자
//                  높이 180·배율 1/2 중 더 크게 서는 쪽, 열이 좁으면 비율대로 줄어듦)과 같다.
//                  이 판이 공식을 다시 쓰고(모델을 import 하지 않는다), 열 1020 에서는 손 계산 표와도
//                  맞춘다. 어느 것도 원본보다 크게 그려지지 않고 열 밖으로 나가지 않으며, 띠 모양
//                  캡처의 배율(표시 ÷ 자연)은 열이 허락하는 만큼 원본 폭의 절반까지 선다.
//   3. 해상도      자연 픽셀 ≥ 표시 크기 × devicePixelRatio (2배 기기 흉내). 원본이 보통 상자 안에
//                  들어가는 작은 그림만 예외다: 없는 픽셀은 만들 수 없어 원본 크기에서 멈춘다.
//   4. 같은 원본   보낸 사람 화면의 echo 행과 확정 행, 받는 사람 화면이 **같은 원본
//                  바이트**(`data:` 주소 동일, 자연 폭 = 원본 폭)를 쓴다. 컴포저 트레이의
//                  초안 썸네일(캔버스 변은 소스의 `THUMB_EDGE_PX × 2`)은 타임라인에 오지 않는다.
//
// 이름 붙은 red proof (제품 소스가 아니라 이 판의 DOM·스타일만 건드린다):
//   IMAGE_CARD_PROVE_RED=pill     "그림 반경이 알약(9999px)으로 돌아간다"
//   IMAGE_CARD_PROVE_RED=narrow   "넓은 그림이 다시 폭 360 에 갇힌다"
//   IMAGE_CARD_PROVE_RED=upscale  "작은 그림이 원본보다 크게 그려진다"
//   IMAGE_CARD_PROVE_RED=thumb    "받는 쪽 그림이 초안 썸네일 크기 그림으로 바뀐다"
//
// 환경:
//   IMAGE_CARD_GATE_PORT    preview 포트(기본 5489). 다른 워크트리의 preview 와 겹치면
//                           preview-guard 가 요란하게 죽는다.
//   IMAGE_CARD_ENGINES      기본 `chromium,webkit`. 데스크탑 셸은 WKWebView 라 둘 다 돈다.
//   IMAGE_CARD_SHOTS_DIR    있으면 캡처를 이 폴더에 남긴다(검증 전에 먼저 찍는다 — RED 에서도
//                           「전」 캡처가 남는다).
//   IMAGE_CARD_SHOT_TAG     캡처 파일명 머리(기본 `after`).
//   IMAGE_CARD_REPORT       있으면 잰 값 표를 JSON 으로 남긴다.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";
import { DRAFT_THUMBNAIL_PX, FIXTURES, renderFixtures } from "./image-card-fixtures.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.IMAGE_CARD_GATE_PORT || 5489);
const origin = `http://127.0.0.1:${port}`;
const proveRed = process.env.IMAGE_CARD_PROVE_RED || "";
const engines = (process.env.IMAGE_CARD_ENGINES || "chromium,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const shotsDir = process.env.IMAGE_CARD_SHOTS_DIR || "";
const shotTag = process.env.IMAGE_CARD_SHOT_TAG || "after";
const reportPath = process.env.IMAGE_CARD_REPORT || "";

/**
 * 규칙 상수는 소스(`inlineImageModel.ts`)가 아니라 README §2.10 에서 옮긴 이 판의 사본이다.
 * 이 파일은 모델을 import 하지 않는다: 모델과 렌더 결과를 **글로 적힌 규칙**에 각각 대조한다.
 */
const RULE = {
  /** 모서리: 한 축의 반경은 그 축 변의 1/4 을 넘지 않는다. */
  cornerRatio: 0.25,
  /** 모서리 상한 = `--radius-md`. */
  cornerMax: 10,
  /** 보통 상자 = `--spacing-inline-image-w/h`. */
  standardWidth: 360,
  maxHeight: 320,
  /** 넓은 상자의 높이 = `--spacing-preview-frame`. */
  wideHeight: 180,
  /** 넓은 상자 배율 상한: 원본 폭의 절반(2배 화면에서 원본 픽셀 1:1). */
  wideScaleLimit: 0.5,
};

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelA = "00000000-0000-7000-8000-000000000201";
const SENT_MESSAGE_ID = "0199dddd-0000-7000-8000-0000000000f9";

const failures = [];
const report = { rows: [], flows: {} };

function check(ok, name, detail = "") {
  if (!ok) {
    failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
    console.error(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
  return ok;
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// ---- 서버 모의 ---------------------------------------------------------------

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelA],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const roster = [
  member({ id: memberId, kind: "human", role: "owner", displayName: "곽성재", handle: "seongjae" }),
  member({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
];
const channels = [
  { id: channelA, workspaceId, kind: "public", name: "release-2026-11", muted: false },
];

function sessionFor(who) {
  const id = who === "receiver" ? peerId : memberId;
  return {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: {
      id,
      workspaceId,
      kind: "human",
      displayName: who === "receiver" ? "이도현" : "곽성재",
      handle: who === "receiver" ? "dohyun" : "seongjae",
    },
    realtimeWebSocketUrl: "ws://image-card-gate.invalid/connection/websocket",
  };
}

function messageRow(over) {
  return {
    channelId: channelA,
    hlcCount: 0,
    type: "text",
    state: "sent",
    ...over,
    hlcTs: over.hlcTs ?? over.createdAtMs,
  };
}

function attachmentId(index) {
  return `0199eeee-0000-7000-8000-${String(0xa00 + index).padStart(12, "0")}`;
}

/** 이 판의 서버 상태. 보낸 사람과 받는 사람 문맥이 같은 상태를 본다. */
function createWorld(pngs) {
  const firstAt = Date.now() - 3_600_000;
  const messages = FIXTURES.map((fixture, index) =>
    messageRow({
      id: `0199dddd-0000-7000-8000-${String(0xe00 + index).padStart(12, "0")}`,
      seq: 100 + index,
      authorMemberId: peerId,
      body: fixture.body,
      createdAtMs: firstAt + index * 60_000,
      attachments: [
        {
          id: attachmentId(index),
          name: `${fixture.key}.png`,
          mime: "image/png",
          sizeBytes: pngs.get(fixture.key).length,
        },
      ],
    })
  );
  const bytesById = new Map(
    FIXTURES.map((fixture, index) => [attachmentId(index), pngs.get(fixture.key)])
  );
  const uploads = new Map();
  let holdPost = null;
  return {
    messages,
    bytesById,
    uploads,
    holdPost: () => holdPost,
    setHold: (promise) => {
      holdPost = promise;
    },
  };
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    const sockets = new Set();
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
            replies.push({ id: command.id, connect: { client: "image-card-gate", version: "6" } });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "image-card-gate",
                offset: 0,
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
    window.__imageCardSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
  });
}

async function installRoutes(context, world, who) {
  const session = sessionFor(who);
  // 업로드 바이트를 받는 같은 출처 주소. 실제 배포에서는 Drive 주소이고, 이 판이 재는 것은
  // 그 주소가 아니라 「올린 바이트가 그대로 타임라인 원본이 된다」는 사실이다.
  await context.route(`${origin}/__gate/upload/*`, async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const entry = world.uploads.get(id);
    if (entry !== undefined) {
      entry.bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
      world.bytesById.set(id, entry.bytes);
    }
    await route.fulfill({ status: 200, body: "" });
  });

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: session.member.id,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/approvals")) return json(route, { approvals: [] });
    if (path.includes("/pins")) return json(route, { pins: [] });

    if (path.endsWith("/attachments/uploads")) {
      const body = JSON.parse(request.postData() ?? "{}");
      const id = attachmentId(100 + world.uploads.size);
      world.uploads.set(id, { name: body.name, mime: body.mime, size: body.size, bytes: null });
      return json(
        route,
        { id, status: "pending", uploadUrl: `${origin}/__gate/upload/${encodeURIComponent(id)}` },
        201
      );
    }
    if (path.endsWith("/complete")) {
      const id = path.split("/").slice(-2, -1)[0];
      const entry = world.uploads.get(id);
      return json(route, {
        id,
        channelId: channelA,
        uploaderMemberId: memberId,
        name: entry?.name ?? "upload.png",
        mime: entry?.mime ?? "image/png",
        size: entry?.size ?? 0,
        status: "complete",
        createdAtMs: Date.now(),
      });
    }
    if (path.endsWith("/content")) {
      if (request.headers().authorization === undefined) {
        return json(route, { error: { message: "unauthorized" } }, 401);
      }
      const id = path.split("/").slice(-2, -1)[0];
      const bytes = world.bytesById.get(id);
      if (bytes === undefined) return json(route, { error: { message: "not found" } }, 404);
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "content-disposition": "attachment" },
        body: bytes,
      });
    }

    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const held = world.holdPost();
        if (held !== null) await held;
        const attachments = (Array.isArray(body.attachmentIds) ? body.attachmentIds : []).map((id) => {
          const entry = world.uploads.get(id);
          return {
            id,
            name: entry?.name ?? "upload.png",
            mime: entry?.mime ?? "image/png",
            sizeBytes: entry?.bytes?.length ?? entry?.size ?? 0,
          };
        });
        const sent = messageRow({
          id: SENT_MESSAGE_ID,
          seq: 300,
          authorMemberId: memberId,
          body: body.body,
          createdAtMs: Date.now(),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        world.messages.push(sent);
        return json(route, sent, 201);
      }
      if (url.searchParams.has("after") || url.searchParams.has("before")) {
        return json(route, { messages: [] });
      }
      return json(route, { messages: world.messages });
    }
    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("image-card@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
}

async function openChannel(page) {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, channelA);
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => window.__imageCardSubscribed(), undefined, { timeout: 15_000 });
  await wait(400);
}

// ---- 페이지 안에서 재기 ------------------------------------------------------

/**
 * 한 메시지 행의 그림 상자. 레이아웃이 가라앉을 때까지(연속 표본이 같을 때까지) 기다린 뒤 잰다.
 * 옛 빌드와 새 빌드 둘 다 같은 방식으로 잰다 — 새 속성(`data-shape` 등)에 기대지 않는다.
 */
async function settleAndMeasure(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const img = document.querySelector(sel);
      return img !== null && img.complete && img.naturalWidth > 0;
    },
    selector,
    { timeout: 20_000 }
  );
  let previous = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sample = await page.evaluate((sel) => {
      const img = document.querySelector(sel);
      const r = img.getBoundingClientRect();
      return `${r.width.toFixed(2)}x${r.height.toFixed(2)}@${r.left.toFixed(1)},${r.top.toFixed(1)}`;
    }, selector);
    if (sample === previous) break;
    previous = sample;
    await wait(120);
  }
  return page.evaluate((sel) => {
    const img = document.querySelector(sel);
    {
      const box = img.getBoundingClientRect();
      if (box.top < 4 || box.bottom > window.innerHeight - 4) {
        img.scrollIntoView({ block: "center" });
      }
    }
    const button = img.closest("button");
    const item = img.closest("li");
    const r = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return {
      width: r.width,
      height: r.height,
      left: r.left,
      top: r.top,
      inViewport: r.top >= 4 && r.bottom <= window.innerHeight - 4 && r.left >= 4,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      dpr: window.devicePixelRatio,
      radius: style.borderTopLeftRadius,
      buttonRadius: button === null ? null : getComputedStyle(button).borderTopLeftRadius,
      column: item === null ? null : item.clientWidth,
      srcLength: img.src.length,
      srcHead: img.src.slice(0, 40),
      srcTail: img.src.slice(-48),
    };
  }, selector);
}

// ---- 눈으로 보이는 모서리 (픽셀) --------------------------------------------

/**
 * 스크린샷 PNG 를 RGBA 로 푼다. 같은 엔진의 빈 페이지 캔버스를 쓴다 — node 에는 PNG 해독기가
 * 없고, 이 판은 새 의존을 더하지 않는다.
 */
async function decodePng(decoder, buffer) {
  return decoder.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const g = canvas.getContext("2d");
    g.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      data: Array.from(g.getImageData(0, 0, image.width, image.height).data),
    };
  }, buffer.toString("base64"));
}

/**
 * 그림의 왼쪽 위 모서리가 **눈에 보이게** 얼마나 깎였는지. 계산된 스타일의 표기가 아니라 찍힌
 * 픽셀을 본다: 왼쪽 가장자리에서 1 CSS px 안쪽 줄을 위에서 아래로 내려가며, 바탕(그림 밖)과
 * 같은 색인 픽셀이 몇 개 이어지는지가 깎인 깊이(기기 픽셀)다. 알약이면 그 깊이가 높이의
 * 25~29% (옛 빌드 실측), 짧은 변의 1/4 반경이면 14% 안팎이라 문턱은 19% + 1px 이다.
 */
async function measureCornerCut(page, decoder, m) {
  const pad = 4;
  const visibleHeight = Math.min(m.height, 48);
  const clip = {
    x: m.left - pad,
    y: m.top - pad,
    width: Math.min(m.width, 24) + pad,
    height: visibleHeight + pad * 2,
  };
  const { width, height, data } = await decodePng(decoder, await page.screenshot({ clip }));
  const pixel = (x, y) => {
    const at = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4;
    return [data[at], data[at + 1], data[at + 2]];
  };
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const scale = width / clip.width;
  const background = pixel(1, 1);
  const column = Math.round((pad + 1) * scale);
  const inside = pixel(column, Math.round((pad + visibleHeight / 2) * scale));
  const contrast = distance(background, inside);
  const topRow = Math.round(pad * scale);
  let row = topRow;
  while (row < height && distance(pixel(column, row), background) <= contrast / 2) row += 1;
  return { cutDevicePx: row - topRow, contrast, heightDevicePx: m.height * scale };
}

function imageSelector(messageId) {
  return `[data-testid="timeline-message"][data-message-id="${messageId.toLowerCase()}"] [data-testid="attachment-image"] img`;
}

// ---- 반경 표기 풀기 ----------------------------------------------------------

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && (separator === " " ? /\s/.test(ch) : ch === separator)) {
      if (i > start) parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < text.length) parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

function evalLength(token, reference) {
  const text = token.trim();
  let match = text.match(/^(-?[\d.]+(?:e[+-]?\d+)?)px$/i);
  if (match !== null) return Number(match[1]);
  match = text.match(/^(-?[\d.]+)%$/);
  if (match !== null) return (Number(match[1]) / 100) * reference;
  if (text === "0") return 0;
  match = text.match(/^(min|max)\((.*)\)$/s);
  if (match !== null) {
    const values = splitTopLevel(match[2], ",").map((arg) => evalLength(arg, reference));
    return match[1] === "min" ? Math.min(...values) : Math.max(...values);
  }
  match = text.match(/^calc\((.*)\)$/s);
  if (match !== null && /infinity/.test(match[1])) return Number.POSITIVE_INFINITY;
  throw new Error(`반경 표기를 풀지 못했다: ${token}`);
}

/** 계산된 `border-top-left-radius` → { rx, ry } (가로 반경은 폭, 세로 반경은 높이를 기준으로 푼다). */
function resolveRadius(value, width, height) {
  const parts = splitTopLevel(value, " ");
  const first = parts[0] ?? "0px";
  const second = parts[1] ?? first;
  return { rx: evalLength(first, width), ry: evalLength(second, height) };
}

// ---- 단정 -------------------------------------------------------------------

/**
 * README §2.10 의 공식을 이 판에서 다시 쓴 것이다.
 *   배율 = max(보통 배율, 넓은 배율)
 *   보통 배율 = min(1, 360/w, 320/h)      넓은 배율 = min(1, 180/h, 1/2)
 * 열이 표시 폭보다 좁으면 비율을 지킨 채 줄어든다.
 */
function expectedDisplay(fixture, column) {
  const standard = Math.min(1, RULE.standardWidth / fixture.w, RULE.maxHeight / fixture.h);
  const wide = Math.min(1, RULE.wideHeight / fixture.h, RULE.wideScaleLimit);
  const scale = Math.max(standard, wide);
  let width = Math.round(fixture.w * scale);
  let height = Math.round(fixture.h * scale);
  if (width > column) {
    height = (height * column) / width;
    width = column;
  }
  return { width, height };
}

/**
 * 열이 1020 인 창(1440 폭)에서의 손 계산 값. 위 공식이 조용히 어긋나지 않게 못 박는다:
 * 공식과 이 표가 둘 다 렌더 결과와 맞아야 한다. (strip 은 1036×55 가 열 1020 에 맞춰 줄었다.)
 */
const LITERAL_AT_COLUMN_1020 = {
  strip: { width: 1020, height: 54.15 },
  ultra: { width: 600, height: 30 },
  "wide-mid": { width: 450, height: 180 },
  tall: { width: 80, height: 320 },
  small: { width: 240, height: 160 },
  large: { width: 360, height: 270 },
  square: { width: 320, height: 320 },
};

function assertFixture({ engine, viewportName, scheme }, fixture, m) {
  const label = `[${engine} ${viewportName} ${scheme}] ${fixture.key}`;
  const { rx, ry } = resolveRadius(m.radius, m.width, m.height);
  const tag = `${label} (${m.width.toFixed(1)}x${m.height.toFixed(1)}, 반경 ${m.radius})`;

  check(m.inViewport, `${label}: 측정할 수 없다(그림이 화면 밖이다)`, tag);
  check(m.width >= 1 && m.height >= 1, `${label}: 그림이 사라졌다`, tag);

  // 1. 모서리
  check(
    ry <= RULE.cornerRatio * m.height + 0.01 && rx <= RULE.cornerRatio * m.width + 0.01,
    `${label}: 반경이 변의 1/4 을 넘는다`,
    `rx=${rx.toFixed(2)} ry=${ry.toFixed(2)} 허용 ry≤${(RULE.cornerRatio * m.height).toFixed(2)}`
  );
  check(
    Math.max(rx, ry) <= RULE.cornerMax + 0.01,
    `${label}: 반경이 이미지 모서리 상한(${RULE.cornerMax})을 넘는다`,
    `rx=${rx.toFixed(2)} ry=${ry.toFixed(2)}`
  );
  if (m.cut !== undefined) {
    check(
      m.cut.contrast >= 40,
      `${label}: 모서리 픽셀을 잴 수 없다(그림과 바탕의 색 차이가 너무 작다)`,
      `차이 ${m.cut.contrast.toFixed(0)}`
    );
    check(
      m.cut.cutDevicePx <= 0.19 * m.cut.heightDevicePx + 1,
      `${label}: 눈에 보이는 모서리가 알약이다`,
      `깎인 깊이 ${m.cut.cutDevicePx}px / 높이 ${m.cut.heightDevicePx.toFixed(1)}px (기기 픽셀)`
    );
  }
  check(
    m.buttonRadius === m.radius,
    `${label}: 버튼 틀의 반경이 그림과 다르다`,
    `button=${m.buttonRadius} img=${m.radius}`
  );

  // 2. 크기 규칙 (글로 적힌 공식과 같은가)
  const column = m.column ?? Infinity;
  const expected = expectedDisplay(fixture, column);
  check(
    Math.abs(m.width - expected.width) <= 1.5 && Math.abs(m.height - expected.height) <= 1.5,
    `${label}: 규칙 공식의 크기와 다르다`,
    `표시 ${m.width.toFixed(1)}x${m.height.toFixed(1)} / 규칙 ${expected.width}x${expected.height.toFixed(1)} (열 ${m.column})`
  );
  if (column >= 1020 && column < 1100) {
    const literal = LITERAL_AT_COLUMN_1020[fixture.key];
    check(
      Math.abs(m.width - literal.width) <= 1.5 && Math.abs(m.height - literal.height) <= 1.5,
      `${label}: 손 계산 값과 다르다`,
      `표시 ${m.width.toFixed(1)}x${m.height.toFixed(1)} / 손 계산 ${literal.width}x${literal.height}`
    );
  }
  check(
    m.width <= m.naturalWidth + 0.5 && m.height <= m.naturalHeight + 0.5,
    `${label}: 원본보다 크게 그려진다`,
    `표시 ${m.width.toFixed(1)}x${m.height.toFixed(1)} / 자연 ${m.naturalWidth}x${m.naturalHeight}`
  );
  check(
    m.height <= RULE.maxHeight + 0.5,
    `${label}: 높이가 상한 ${RULE.maxHeight} 을 넘는다`,
    `${m.height.toFixed(1)}`
  );
  check(
    m.width <= column + 0.5,
    `${label}: 그림이 열 밖으로 나간다(잘린다)`,
    `표시 ${m.width.toFixed(1)} / 열 ${m.column}`
  );
  check(
    Math.abs(m.width / m.height - fixture.w / fixture.h) / (fixture.w / fixture.h) <= 0.03,
    `${label}: 비율이 깨졌다`,
    `표시 ${(m.width / m.height).toFixed(3)} / 원본 ${(fixture.w / fixture.h).toFixed(3)}`
  );
  if (fixture.h <= 120 && fixture.kind === "wide") {
    // 띠 모양 캡처의 배율 하한: 열이 허락하는 만큼, 원본 폭의 절반까지 쓴다.
    const floor = 0.97 * Math.min(RULE.wideScaleLimit, column / fixture.w);
    check(
      m.width / fixture.w >= floor,
      `${label}: 가로 캡처가 열 폭을 넉넉히 쓰지 않는다 (배율 하한)`,
      `배율 ${(m.width / fixture.w).toFixed(3)} < 하한 ${floor.toFixed(3)} (열 ${m.column})`
    );
  }
  if (fixture.kind === "tall") {
    check(
      m.width <= RULE.standardWidth + 0.5,
      `${label}: 높은 그림이 보통 폭 ${RULE.standardWidth} 을 넘는다`,
      `${m.width.toFixed(1)}`
    );
  }

  // 3. 해상도: 표시 크기 × DPR 이하의 원본 픽셀만 그린다. 원본이 보통 상자 안에 들어가는 작은
  //    그림은 예외다 — 없는 픽셀은 만들 수 없으므로 원본 크기에서 멈추는 것(위 「원본보다 크게」)이 규칙이다.
  if (fixture.kind === "small") {
    check(
      Math.abs(m.width - fixture.w) <= 0.5 && Math.abs(m.height - fixture.h) <= 0.5,
      `${label}: 작은 그림이 원본 크기가 아니다`,
      `표시 ${m.width.toFixed(1)}x${m.height.toFixed(1)} / 원본 ${fixture.w}x${fixture.h}`
    );
  } else {
    check(
      m.naturalWidth >= m.width * m.dpr - 0.5 && m.naturalHeight >= m.height * m.dpr - 0.5,
      `${label}: 그려진 픽셀이 표시 크기 × DPR 보다 적다`,
      `자연 ${m.naturalWidth}x${m.naturalHeight} < ${(m.width * m.dpr).toFixed(1)}x${(m.height * m.dpr).toFixed(1)} (DPR ${m.dpr})`
    );
  }
}

// ---- 한 장면 ----------------------------------------------------------------

async function injectRed(page) {
  if (proveRed === "pill") {
    await page.addStyleTag({
      content: '[data-testid="attachment-image"] img, [data-testid="attachment-image"] button { border-radius: 9999px !important; }',
    });
  } else if (proveRed === "narrow") {
    await page.addStyleTag({
      content: '[data-testid="attachment-image"] img { width: auto !important; max-width: 360px !important; }',
    });
  } else if (proveRed === "upscale") {
    await page.addStyleTag({
      content: '[data-testid="attachment-image"] img { min-width: 480px !important; height: auto !important; }',
    });
  }
}

/**
 * 호버 행동 줄(32)이 낮은 띠 그림 안에 선다. 높이 48 이상(strip)은 위에서 8 띄운 자리에 들어가고,
 * 48 미만(ultra, 30)은 세로 가운데에 놓여 위아래로 같은 만큼만 삐져나온다.
 * 가상 목록이 위쪽 행을 내려놓기 전에, 그 행을 잰 직후에 부른다.
 */
async function checkHoverOverlay(page, world, index, name, { engine, viewportName, scheme }) {
  const id = world.messages[index].id.toLowerCase();
  const where = `[${engine} ${viewportName} ${scheme}] ${name}`;
  const figure = page.locator(
    `[data-testid="timeline-message"][data-message-id="${id}"] [data-testid="attachment-image"]`
  );
  if ((await figure.count()) === 0) {
    check(false, `${where}: 호버를 재려는 행이 화면에 없다`);
    return;
  }
  await figure.hover();
  const overlay = figure.getByTestId("attachment-image-actions");
  await overlay.waitFor({ timeout: 5_000 });
  const actions = await overlay.boundingBox();
  const picture = await figure.locator("img").boundingBox();
  if (actions === null || picture === null) {
    check(false, `${where}: 호버 행동 줄을 잴 수 없다`);
  } else if (picture.height >= 48) {
    check(
      actions.y >= picture.y - 0.5 && actions.y + actions.height <= picture.y + picture.height + 0.5,
      `${where}: 호버 행동 줄이 그림 밖으로 삐져나온다`,
      `줄 ${actions.y.toFixed(1)}..${(actions.y + actions.height).toFixed(1)} / 그림 ${picture.y.toFixed(1)}..${(picture.y + picture.height).toFixed(1)}`
    );
  } else {
    const gap = actions.y + actions.height / 2 - (picture.y + picture.height / 2);
    check(
      Math.abs(gap) <= 1,
      `${where}: 낮은 그림의 호버 행동 줄이 세로 가운데가 아니다`,
      `가운데 차이 ${gap.toFixed(2)}px`
    );
  }
  if (shotsDir !== "" && engine === "chromium") {
    await page
      .locator(`[data-testid="timeline-message"][data-message-id="${id}"]`)
      .screenshot({ path: resolve(shotsDir, `${shotTag}-${viewportName}-${scheme}-${name}-hover.png`) });
  }
  await page.mouse.move(2, 2);
}

async function exerciseTimeline(browser, world, scenario) {
  const { engine, viewportName, viewport, scheme } = scenario;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, world, "viewer");
  await login(page);
  await openChannel(page);
  await injectRed(page);

  const measured = [];
  for (const [index, fixture] of FIXTURES.entries()) {
    const messageId = world.messages[index].id;
    const m = await settleAndMeasure(page, imageSelector(messageId));
    measured.push([fixture, m]);
    if (index < 2 && (m.column ?? 0) >= 640) {
      await checkHoverOverlay(page, world, index, fixture.key, scenario);
    }
  }
  await wait(250);
  // 낮은 그림(알약이 될 수 있는 것)만 모서리를 픽셀로 본다. 높은 그림은 반경이 높이에 비해 작아
  // 판별할 것이 없고, 색이 바탕과 비슷한 그림은 판별이 불가능하다.
  const decoder = await context.newPage();
  for (const [fixture, m] of measured) {
    if (fixture.kind === "wide" && fixture.h <= 120) {
      m.cut = await measureCornerCut(page, decoder, m);
    }
  }
  await decoder.close();

  if (shotsDir !== "" && engine === "chromium") {
    mkdirSync(shotsDir, { recursive: true });
    // 검증보다 먼저 찍는다: RED 실행에서도 「전」 캡처가 남는다.
    await page.screenshot({ path: resolve(shotsDir, `${shotTag}-${viewportName}-${scheme}.png`) });
    const strip = page.locator(
      `[data-testid="timeline-message"][data-message-id="${world.messages[0].id.toLowerCase()}"]`
    );
    await strip.screenshot({ path: resolve(shotsDir, `${shotTag}-${viewportName}-${scheme}-strip.png`) });
  }

  for (const [fixture, m] of measured) {
    assertFixture({ engine, viewportName, scheme }, fixture, m);
    report.rows.push({
      engine,
      viewport: viewportName,
      scheme,
      fixture: fixture.key,
      natural: `${m.naturalWidth}x${m.naturalHeight}`,
      shown: `${m.width.toFixed(1)}x${m.height.toFixed(1)}`,
      scale: Number((m.width / m.naturalWidth).toFixed(3)),
      column: m.column,
      radius: m.radius,
      cutDevicePx: m.cut === undefined ? null : m.cut.cutDevicePx,
    });
  }
  console.log(
    `[${engine} ${viewportName} ${scheme}] ` +
      measured
        .map(([fixture, m]) => `${fixture.key} ${m.width.toFixed(0)}x${m.height.toFixed(0)}`)
        .join(" · ")
  );
  await context.close();
}

// ---- 보낸 사람 · 받는 사람 --------------------------------------------------

async function exerciseSenderReceiver(browser, world, pngs) {
  const viewport = { width: 1440, height: 1500 };
  const strip = FIXTURES.find((fixture) => fixture.key === "strip");
  const original = pngs.get("strip");

  const senderContext = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const sender = await senderContext.newPage();
  await installRealtimeSocket(sender);
  await installRoutes(senderContext, world, "sender");
  await login(sender);
  await openChannel(sender);

  await sender.locator('input[type="file"]').first().setInputFiles({
    name: "terminal-strip.png",
    mimeType: "image/png",
    buffer: original,
  });
  await sender.getByTestId("attachment-chip-thumb").waitFor({ timeout: 15_000 });
  const draft = await sender.evaluate(() => {
    const thumb = document.querySelector('[data-testid="attachment-chip-thumb"]');
    return { naturalWidth: thumb.naturalWidth, naturalHeight: thumb.naturalHeight };
  });
  // 초안 썸네일은 작다: 이 그림이 타임라인에 오면 안 된다.
  check(
    draft.naturalWidth === DRAFT_THUMBNAIL_PX,
    `보낸 사람: 트레이 썸네일이 예상한 ${DRAFT_THUMBNAIL_PX}px 가 아니다(기준선이 흔들렸다)`,
    `${draft.naturalWidth}`
  );
  await sender.waitForFunction(
    () => !document.querySelector('[data-testid="composer-send"]')?.disabled,
    undefined,
    { timeout: 20_000 }
  );

  // echo 행을 붙잡는다: POST 응답을 손으로 연다.
  let release = () => {};
  world.setHold(
    new Promise((done) => {
      release = done;
    })
  );
  await sender.getByTestId("composer-send").click();
  const echoSelector = '[data-testid="timeline-pending"] [data-testid="attachment-image"] img';
  const echo = await settleAndMeasure(sender, echoSelector);
  release();
  world.setHold(null);
  const confirmedSelector = imageSelector(SENT_MESSAGE_ID);
  await sender.waitForSelector(confirmedSelector, { timeout: 20_000 });
  await sender.waitForFunction(
    () => document.querySelector('[data-testid="timeline-pending"]') === null,
    undefined,
    { timeout: 20_000 }
  );
  const confirmed = await settleAndMeasure(sender, confirmedSelector);
  await senderContext.close();

  const receiverContext = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const receiver = await receiverContext.newPage();
  await installRealtimeSocket(receiver);
  await installRoutes(receiverContext, world, "receiver");
  await login(receiver);
  await openChannel(receiver);
  if (proveRed === "thumb") {
    // red proof: 받는 쪽 그림을 초안 썸네일 크기의 그림으로 바꿔 끼운다(제품 소스는 그대로).
    await receiver.evaluate(
      ({ id, size }) => {
        const img = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"] [data-testid="attachment-image"] img`
        );
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        img.src = canvas.toDataURL("image/png");
      },
      { id: SENT_MESSAGE_ID.toLowerCase(), size: DRAFT_THUMBNAIL_PX }
    );
    await wait(300);
  }
  const received = await settleAndMeasure(receiver, confirmedSelector);
  await receiverContext.close();

  const rows = { echo, confirmed, received };
  for (const [name, m] of Object.entries(rows)) {
    check(
      m.naturalWidth === strip.w && m.naturalHeight === strip.h,
      `같은 원본: ${name} 그림이 원본 ${strip.w}x${strip.h} 가 아니다`,
      `자연 ${m.naturalWidth}x${m.naturalHeight}`
    );
    check(
      m.naturalWidth > DRAFT_THUMBNAIL_PX,
      `같은 원본: ${name} 그림이 ${DRAFT_THUMBNAIL_PX}px 초안 썸네일이다`,
      `${m.naturalWidth}`
    );
    check(m.srcHead.startsWith("data:image/png"), `같은 원본: ${name} 그림이 data:image/png 가 아니다`, m.srcHead);
  }
  check(
    echo.srcLength === confirmed.srcLength && echo.srcTail === confirmed.srcTail,
    "같은 원본: 보낸 사람의 echo 행과 확정 행이 다른 바이트를 쓴다",
    `${echo.srcLength} vs ${confirmed.srcLength}`
  );
  check(
    confirmed.srcLength === received.srcLength && confirmed.srcTail === received.srcTail,
    "같은 원본: 보낸 사람 화면과 받는 사람 화면이 다른 바이트를 쓴다",
    `${confirmed.srcLength} vs ${received.srcLength}`
  );
  check(
    Math.abs(confirmed.width - received.width) <= 0.5 && Math.abs(confirmed.height - received.height) <= 0.5,
    "같은 원본: 보낸 사람 화면과 받는 사람 화면의 그림 크기가 다르다",
    `${confirmed.width.toFixed(1)}x${confirmed.height.toFixed(1)} vs ${received.width.toFixed(1)}x${received.height.toFixed(1)}`
  );
  check(
    Math.abs(echo.width - confirmed.width) <= 0.5 && Math.abs(echo.height - confirmed.height) <= 0.5,
    "같은 원본: echo 행이 확정 행과 다른 크기로 그린다(seq 가 도착하면 튄다)",
    `${echo.width.toFixed(1)}x${echo.height.toFixed(1)} vs ${confirmed.width.toFixed(1)}x${confirmed.height.toFixed(1)}`
  );
  report.flows = {
    draftThumbnail: draft,
    echo: { natural: `${echo.naturalWidth}x${echo.naturalHeight}`, shown: `${echo.width.toFixed(1)}x${echo.height.toFixed(1)}` },
    confirmed: { natural: `${confirmed.naturalWidth}x${confirmed.naturalHeight}`, shown: `${confirmed.width.toFixed(1)}x${confirmed.height.toFixed(1)}` },
    received: { natural: `${received.naturalWidth}x${received.naturalHeight}`, shown: `${received.width.toFixed(1)}x${received.height.toFixed(1)}` },
  };
  console.log(
    `[sender/receiver] 초안 썸네일 ${draft.naturalWidth}px · echo ${echo.naturalWidth}px→${echo.width.toFixed(0)}x${echo.height.toFixed(0)} · ` +
      `확정 ${confirmed.naturalWidth}px · 받는 쪽 ${received.naturalWidth}px→${received.width.toFixed(0)}x${received.height.toFixed(0)}`
  );
}

// ---- main -------------------------------------------------------------------

const VIEWPORTS = [
  // 일곱 장이 한 화면에 다 들어오게 키가 크다(타임라인은 맨 아래에 붙는다). 화면 밖의 그림은
  // 히트 테스트가 null 을 돌려주므로 아래에서 따로 막는다.
  { name: "1440", viewport: { width: 1440, height: 2100 } },
  { name: "900", viewport: { width: 900, height: 2100 } },
  { name: "480", viewport: { width: 480, height: 2400 } },
  // 열이 상자(360)보다 좁다: 스레드 패널·폰 폭 창. 그림이 잘리지 않고 비율대로 줄어야 한다.
  { name: "360", viewport: { width: 360, height: 2600 } },
];

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  if (proveRed !== "" && !["pill", "narrow", "upscale", "thumb"].includes(proveRed)) {
    throw new Error(`IMAGE_CARD_PROVE_RED=${proveRed} 는 알 수 없는 이름이다`);
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "IMAGE_CARD_GATE_PORT",
  });
  try {
    const launchers = { chromium, webkit };
    for (const name of engines) {
      if (launchers[name] === undefined) throw new Error(`알 수 없는 엔진: ${name}`);
    }
    const seed = await chromium.launch();
    const pngs = await renderFixtures(seed);
    await seed.close();

    for (const engine of engines) {
      const browser = await launchers[engine].launch();
      try {
        // WebKit 은 데스크탑 셸(WKWebView)과 같은 엔진이라 한 장면(넓은 창·라이트)만 돈다.
        const scenarios =
          engine === "chromium"
            ? VIEWPORTS.flatMap((v) =>
                ["light", "dark"].map((scheme) => ({
                  engine,
                  viewportName: v.name,
                  viewport: v.viewport,
                  scheme,
                }))
              )
            : [
                { engine, viewportName: "1440", viewport: VIEWPORTS[0].viewport, scheme: "light" },
                { engine, viewportName: "900", viewport: VIEWPORTS[1].viewport, scheme: "dark" },
              ];
        for (const scenario of scenarios) {
          await exerciseTimeline(browser, createWorld(pngs), scenario);
        }
        if (engine === "chromium") {
          await exerciseSenderReceiver(browser, createWorld(pngs), pngs);
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }

  if (reportPath !== "") {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({ ...report, failures }, null, 2)}\n`);
  }
  if (failures.length > 0) {
    console.error(`\nGATE FAIL (${failures.length}건)${proveRed === "" ? "" : ` [red proof: ${proveRed}]`}`);
    process.exitCode = 1;
    return;
  }
  console.log("GATE PASS: 이미지 카드의 모서리는 알약이 아니고, 넓은 그림은 열 폭을 쓰며,");
  console.log("           그려진 픽셀이 표시 크기를 받치고, 보낸 사람과 받는 사람이 같은 원본을 쓴다.");
}

await main();
