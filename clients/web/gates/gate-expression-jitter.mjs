#!/usr/bin/env node
// GATE: #5575 — 이모티콘이 든 DM이 맨 아래에 붙어 있을 때, 일시적인 상태(연결 흔들림 · 목록 다시 읽기 · 창 포커스 ·
// 세대 교체 · 실시간 다시 연결 · 상대 「입력 중」)가 몇 번 지나가도
//   ① 아는 이모티콘이 `:이름:` 글자로 바뀌지 않는다(0회),
//   ② 목록이 맨 아래에서 떨어지지 않는다(거리 0),
//   ③ 「최신 메시지로 이동」이 서지 않는다(0회).
// 진짜로 목록 높이가 바뀌어도(등록으로 글자 → 그림, 숨김으로 그림 → 글자) 맨 아래는 맨 아래이고, 위로 올려 읽던 중이면
//   ④ 보던 메시지의 화면(창) 위치가 2px 넘게 움직이지 않는다(이 목록 안에서는 어느 엔진도 스크롤 앵커링을 하지 않는다 — 가상
//      목록이 줄마다, 타임라인이 스크롤러에 `overflow-anchor:none`을 건다, #5638).
// 연결이 끊겼다 돌아와도(기기 오프라인 · 서버에 닿지 못함) ⑤ 맨 아래의 마지막 줄과 위를 읽던 줄이 **창에서** 1px 넘게 움직이지
// 않는다 — 1280 · 900 · 390. 목록 안쪽 좌표(바닥 거리 · 스크롤러 위쪽에서 줄까지)는 목록 상자가 통째로 움직이면 0을 보고하므로
// (#5575 검수 H1: 입력창 위 오프라인 줄 26~44px, 머리 아래 허들 배너 39px), 마지막 줄의 아래 끝과 보던 줄의 위 끝을 창 좌표로도 잰다.
// 칸 안의 이름 표지(`data-expression-label`, 오래 가는 오프라인·실패에서 같은 크기 칸 안에 서는 `:이름:`)는 「글자로 바뀜」으로 세지
// 않는다 — 칸의 크기가 그대로이기 때문이다.
//
// 실제 번들 · 실제 가상 목록 · 실제 이모티콘 저장소/그림 칸을 **WebKit**(데스크탑 앱의 WKWebView와 같은 엔진)과 Chromium에서
// 잰다. 서버는 이 파일의 가짜 `/v1`과 가짜 실시간(센트리퓨고 JSON 프로토콜의 최소판, `routeWebSocket`)이다. 인물·대화는 지어낸 것이다.
//
// 사용: npm run build && node gates/gate-expression-jitter.mjs
//   EXPRESSION_JITTER_ENGINES=webkit,chromium   (기본 둘 다)
//   EXPRESSION_JITTER_PORT=<포트>               미리보기 포트(기본 5207)
//   EXPRESSION_JITTER_OUT=<폴더>                프레임 기록 JSON을 남긴다
//   EXPRESSION_JITTER_MEASURE_ONLY=1            단정 없이 숫자만 찍는다(원인 실측용, 메커니즘 탐침 포함)
//   EXPRESSION_JITTER_REAL_INTERVAL=1           30초 주기 다시 읽기를 실제로 한 번 기다린다(기본은 같은 함수를 부르는 창 포커스로 대신한다)
//   EXPRESSION_JITTER_DIST=<폴더>               dist 대신 이 번들을 띄운다(수리 전 번들로 RED 를 다시 보일 때)
//   EXPRESSION_JITTER_IMAGE_DELAY_MS=<ms>       그림 응답 지연(기본 250: 실제 망처럼 가상 목록의 100ms 따라붙기 창 밖에서 도착한다)
//   EXPRESSION_JITTER_CAPTURE=<폴더>            오프라인 흔들림 장면에서 대화 목록을 찍는다(온라인 · 오프라인 1초 · 돌아온 뒤)
//   EXPRESSION_JITTER_ONLY=connection           연결 끊김 → 돌아옴 장면(창 기준, 1280 · 900 · 390)만 돈다
//   EXPRESSION_JITTER_ONLY=bottom               맨 아래 장면(1~10, 등록 · 숨김 포함)만 돈다
//   EXPRESSION_JITTER_REPEAT=<N>                맨 아래 장면을 새 창으로 N번 되풀이한다(기본 1, 단정은 회차마다 같다 — #5638)
// 머리 출력: 엔진마다 `CSS.supports('overflow-anchor','auto')`와 타임라인 스크롤러의 계산값을 찍는다(#5638, `engine-anchor.mjs`).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, webkit } from "playwright";
import { printEngineAnchorHeader, scrollerOverflowAnchor } from "./engine-anchor.mjs";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.EXPRESSION_JITTER_PORT || 5207);
const origin = `http://127.0.0.1:${port}`;
const engineNames = (process.env.EXPRESSION_JITTER_ENGINES || "webkit,chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const outDir = process.env.EXPRESSION_JITTER_OUT || null;
const measureOnly = process.env.EXPRESSION_JITTER_MEASURE_ONLY === "1";
const realInterval = process.env.EXPRESSION_JITTER_REAL_INTERVAL === "1";
const viewport = { width: 1280, height: 800 };
/** 연결 끊김 → 돌아옴을 창 기준으로 재는 폭들(넓은 창 · 좁은 창 · 폰 폭). 폰 폭에서는 셸 위쪽 연결 띠도 선다. */
const connectionViewports = [
  { width: 1280, height: 800 },
  { width: 900, height: 800 },
  { width: 390, height: 844 },
];
const onlyScene = process.env.EXPRESSION_JITTER_ONLY || null;
const bottomRepeat = Math.max(1, Number(process.env.EXPRESSION_JITTER_REPEAT || 1));
const distOverride = process.env.EXPRESSION_JITTER_DIST || null;
const captureDir = process.env.EXPRESSION_JITTER_CAPTURE || null;

async function capture(page, engine, name) {
  if (captureDir === null) return;
  mkdirSync(captureDir, { recursive: true });
  await page.locator('[data-testid="chat-timeline"]').screenshot({ path: resolve(captureDir, `${engine}-${name}.png`) });
}

/** 창 전체를 찍는다(창 기준 흔들림은 목록 밖 — 머리 · 배너 · 입력창 — 이 함께 보여야 읽힌다). */
async function captureWindow(page, engine, name) {
  if (captureDir === null) return;
  mkdirSync(captureDir, { recursive: true });
  await page.screenshot({ path: resolve(captureDir, `${engine}-${name}.png`) });
}

const workspaceId = "00000000-0000-7000-8000-000000000001";
const meId = "00000000-0000-7000-8000-000000000121";
const peerId = "00000000-0000-7000-8000-000000000122";
const dmChannelId = "00000000-0000-7000-8000-000000000222";
const generalId = "00000000-0000-7000-8000-000000000221";
const WS_UPPER = workspaceId.toUpperCase();

// ---------------------------------------------------------------------------------------------- 그림 (지어낸 PNG)

/** RGBA PNG 하나를 만든다(zlib + crc32, 의존 없음). */
function png(width, height, paint) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const at = y * stride + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 둥근 얼굴 하나(색만 다르다). 투명 배경 · 테두리 · 눈 두 개 · 입. */
function faceSticker(width, height, [r, g, b]) {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.42;
  const ry = height * 0.42;
  return png(width, height, (x, y) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    const d = dx * dx + dy * dy;
    if (d > 1) return [0, 0, 0, 0];
    if (d > 0.86) return [40, 36, 32, 255];
    const eye = (ex) => ((x - ex) / (width * 0.05)) ** 2 + ((y - (cy - ry * 0.25)) / (height * 0.07)) ** 2 <= 1;
    if (eye(cx - rx * 0.35) || eye(cx + rx * 0.35)) return [40, 36, 32, 255];
    const mouth = Math.abs(dx) < 0.4 && Math.abs(dy - 0.35 - dx * dx * 0.6) < 0.05;
    if (mouth) return [40, 36, 32, 255];
    return [r, g, b, 255];
  });
}

function imageMeta(bytes, width, height) {
  // 서버와 같은 키 차례(serde_json Map = BTreeMap: 이름 차례)로 둔다.
  return {
    bytes: bytes.length,
    durationMs: 0,
    frameCount: 1,
    height,
    mime: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width,
  };
}

const COLORS = [
  [247, 178, 72],
  [120, 196, 140],
  [116, 160, 232],
  [236, 128, 140],
  [182, 146, 226],
  [244, 214, 92],
  [120, 208, 214],
  [214, 160, 120],
];

const EXPRESSION_DEFS = [
  // 처음부터 등록된 것
  { key: "coffee", name: "coffee_break", displayName: "커피 한잔" },
  { key: "good", name: "good_job", displayName: "잘했어요" },
  { key: "rocket", name: "rocket_launch", displayName: "출발" },
  { key: "cat", name: "sleepy_cat", displayName: "졸린 고양이" },
  { key: "bug", name: "bug_hunt", displayName: "버그 잡기" },
  { key: "five", name: "high_five", displayName: "하이파이브" },
  // 진짜 높이 변화용: 위를 읽는 장면에서 숨기는 것 · 나중에 등록되는 것 둘
  { key: "flag", name: "old_flag", displayName: "옛 깃발" },
  { key: "badge", name: "new_badge", displayName: "새 배지", later: true },
  { key: "star", name: "late_star", displayName: "늦은 별", later: true },
].map((def, index) => {
  const color = COLORS[index % COLORS.length];
  const large = faceSticker(240, 180, color);
  const small = faceSticker(128, 96, color);
  const thumb = faceSticker(128, 96, color);
  return {
    ...def,
    id: `0199e0e0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    bytes: { large, small, thumb },
    media: {
      large: imageMeta(large, 240, 180),
      small: imageMeta(small, 128, 96),
      thumb: imageMeta(thumb, 128, 96),
    },
  };
});
const DEF = Object.fromEntries(EXPRESSION_DEFS.map((def) => [def.key, def]));

// ---------------------------------------------------------------------------------------------- 대화 (지어낸 것)

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: { id: meId, workspaceId, kind: "human", displayName: "서하늘", handle: "haneul" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
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
  rosterMember({ id: meId, kind: "human", role: "owner", displayName: "서하늘", handle: "haneul" }),
  rosterMember({ id: peerId, kind: "human", displayName: "도윤재", handle: "yunjae" }),
];

const channels = [
  { id: generalId, workspaceId, kind: "public", name: "general", topic: "", muted: false },
  { id: dmChannelId, workspaceId, kind: "dm", muted: false, memberIds: [meId, peerId] },
];

const LINES = [
  "오늘 배포 전에 마이그레이션 순서 한 번만 같이 봐 줄 수 있어요?",
  "네, 10분 뒤에 볼게요. outbox relay 쪽은 어제 고친 그대로예요.",
  "좋아요 :good_job: 롤백 스크립트도 최신인지 확인해 둘게요.",
  "staging에서 5xx 두 건 있었는데 둘 다 timeout이었어요.",
  "그건 재연결 구간이라 서버 오류는 아니었던 것 같아요.",
  "릴리스 노트에 그 문장 한 줄만 추가해 둘게요.",
  "점심 먹고 QA 체크리스트 마지막 세 줄 같이 봐요.",
  "확인했어요. 그러면 이번 배포는 그대로 가도 되겠네요.",
];

/** 몸 글의 차례. 이모티콘만 있는 메시지는 큰 그림(약 150px 높이)으로 선다. */
const BODIES = (() => {
  const bodies = [];
  for (let i = 0; i < 62; i += 1) bodies.push(LINES[i % LINES.length]);
  // 위를 읽는 장면의 재료: 숨길 그림 · 나중에 등록될 이름은 보던 줄보다 열 줄 넘게 위(화면 위 밖, 가상 목록이 붙여 둔 600px 안)에 둔다.
  // 화면 안에서 줄이 자라면 무엇이든 움직일 수밖에 없다 — 이 시험이 묻는 것은 「보이지 않는 위쪽이 바뀌어도 보던 줄은 제자리」다.
  bodies[17] = ":old_flag:";
  bodies[15] = ":late_star:";
  bodies[30] = "앵커 줄: 회의록 정리는 내일 오전에 마칠게요.";
  bodies[34] = ":coffee_break: :good_job: :high_five:";
  bodies[38] = ":bug_hunt:";
  bodies[42] = ":rocket_launch:";
  // 맨 아래 쪽: 큰 그림 여럿과, 나중에 등록되는 이름(처음엔 글자).
  bodies[50] = ":coffee_break:";
  bodies[52] = "다들 고생 많았어요 :high_five: 내일 봬요.";
  bodies[53] = ":sleepy_cat:";
  bodies[55] = ":new_badge:";
  bodies[56] = ":rocket_launch:";
  bodies[58] = ":good_job:";
  bodies[60] = "저녁 먹고 다시 볼게요.";
  bodies[61] = ":bug_hunt:";
  return bodies;
})();

const ANCHOR_TEXT = "앵커 줄: 회의록 정리는 내일 오전에 마칠게요.";

/**
 * 줄의 시각. 세 줄(나 · 상대 · 상대)마다 한 분이고, 상대의 두 줄은 **같은 분**이라 한 묶음이다(#5603: 묶음은 같은 로컬 분까지만).
 * 예전에는 줄마다 1분 간격이었고 5분 묶음 창이 상대의 두 줄을 이어 붙였다 — 이 게이트가 잰 기하(머리 줄 수 · 높이)를 그대로 지키려고
 * 묶음 모양을 같게 둔다. 기준 시각은 분의 처음(초 0)이다. 시간대 차이는 분 단위라 로컬에서도 초가 그대로다.
 */
const HISTORY_MINUTE0_MS = 1_785_238_380_000;
function historyAt(i) {
  return HISTORY_MINUTE0_MS + Math.floor(i / 3) * 60_000 + (i % 3) * 10_000;
}

function history() {
  return BODIES.map((body, i) => ({
    id: `0199eeee-0000-7000-8000-${String(i).padStart(12, "0")}`,
    channelId: dmChannelId,
    seq: i + 1,
    hlcTs: historyAt(i),
    hlcCount: 0,
    authorMemberId: i % 3 === 0 ? meId : peerId,
    type: "text",
    body,
    state: "sent",
    createdAtMs: historyAt(i),
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------------------------- 가짜 서버

function expressionItem(def, version) {
  return {
    id: def.id,
    workspaceId,
    name: def.name,
    displayName: def.displayName,
    tags: [],
    subjectMemberId: null,
    kind: "sticker",
    version: String(version),
    origin: { kind: "upload", sourceUrl: null, prompt: null },
    createdBy: meId,
    createdAtMs: 1_785_000_000_000,
    status: "active",
    media: def.media,
  };
}

async function installBackend(context) {
  const rows = history();
  const state = {
    restMode: "ok", // ok | abort
    imageMode: "ok", // ok | abort
    /** 그림 응답을 늦추는 시간: 실제 망에서 다시 받기는 수백 ms 걸린다(가상 목록이 스스로 따라붙는 100ms 창 밖). */
    imageDelayMs: Number(process.env.EXPRESSION_JITTER_IMAGE_DELAY_MS || 250),
    catalogVersion: 10,
    /** 등록된 표현 key → 그 등록의 version. */
    active: new Map(EXPRESSION_DEFS.filter((def) => !def.later).map((def, index) => [def.key, index + 1])),
    listReads: 0,
    listReadsFailed: 0,
    imageReads: 0,
    imageReadsFailed: 0,
    handshakes: 0,
    sockets: new Set(),
    offset: 0,
    failedTargets: [],
  };

  const list = (since) => {
    const items = EXPRESSION_DEFS.filter((def) => state.active.has(def.key)).map((def) => expressionItem(def, state.active.get(def.key)));
    if (since !== null && since === String(state.catalogVersion)) {
      return { workspaceId, version: String(state.catalogVersion), baseVersion: since, reset: false, addPolicy: "members", items: [] };
    }
    // 그 밖의 since는 전체로 답한다(계약: 넘치면 full reset).
    return { workspaceId, version: String(state.catalogVersion), baseVersion: null, reset: true, addPolicy: "members", items };
  };

  await context.route("**/healthz", async (route) => {
    if (state.restMode === "abort") return route.abort("connectionrefused");
    return json(route, { status: "ok" });
  });

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const imageMatch = /\/expressions\/([0-9a-f-]{36})\/image$/.exec(path);
    if (imageMatch) {
      state.imageReads += 1;
      if (state.restMode === "abort" || state.imageMode === "abort") {
        state.imageReadsFailed += 1;
        return route.abort("connectionrefused");
      }
      await wait(state.imageDelayMs);
      if (state.restMode === "abort" || state.imageMode === "abort") {
        state.imageReadsFailed += 1;
        return route.abort("connectionrefused");
      }
      const def = EXPRESSION_DEFS.find((entry) => entry.id === imageMatch[1]);
      const size = url.searchParams.get("size");
      if (!def || !state.active.has(def.key) || !def.bytes[size]) {
        return json(route, { error: { code: "not_found", message: "not found" } }, 404);
      }
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
        body: def.bytes[size],
      });
    }
    if (state.restMode === "abort") {
      state.failedTargets.push(`${request.method()} ${path}`);
      if (/\/expressions$/.test(path)) state.listReadsFailed += 1;
      return route.abort("connectionrefused");
    }
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-only-not-a-credential",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        workspaceId,
        memberId: meId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    if (/\/workspaces\/[^/]+\/expressions$/.test(path)) {
      state.listReads += 1;
      return json(route, list(url.searchParams.get("since")));
    }
    if (path.endsWith("/typing/grant")) {
      return json(route, {
        grant: "gate-grant-1",
        channel: `typing:ws${WS_UPPER}.${dmChannelId.toUpperCase()}`,
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 600,
        signalTtlMs: 6_000,
        republishIntervalMs: 3_000,
        aggregateThreshold: 3,
      });
    }
    if (path.endsWith("/typing")) {
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ channel: `typing:ws${WS_UPPER}.${dmChannelId.toUpperCase()}`, expiresAtMs: Date.now() + 6_000, republishAfterMs: 3_000 }),
      });
    }
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/messages")) {
      if (!path.includes(dmChannelId) || url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, { messages: rows });
    }
    return json(route, {});
  });

  await context.routeWebSocket(/\/connection\/websocket/, (ws) => {
    const entry = { ws, channels: new Set() };
    state.sockets.add(entry);
    ws.onClose(() => state.sockets.delete(entry));
    ws.onMessage((raw) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        if (command.connect) {
          state.handshakes += 1;
          ws.send(JSON.stringify({ id: command.id, connect: { client: "expression-jitter", version: "6.0.0" } }));
        } else if (command.subscribe) {
          entry.channels.add(command.subscribe.channel);
          ws.send(
            JSON.stringify({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, epoch: "expression-jitter", offset: state.offset, recovered: false, publications: [] },
            })
          );
        } else if (command.unsubscribe) {
          entry.channels.delete(command.unsubscribe.channel);
          ws.send(JSON.stringify({ id: command.id, unsubscribe: {} }));
        } else if (command.id !== undefined) {
          const key = Object.keys(command).find((name) => name !== "id") ?? "ping";
          ws.send(JSON.stringify({ id: command.id, [key]: {} }));
        }
      }
    });
  });

  const publish = (prefix, data) => {
    state.offset += 1;
    let delivered = 0;
    for (const entry of state.sockets) {
      for (const name of entry.channels) {
        if (!name.startsWith(prefix)) continue;
        delivered += 1;
        entry.ws.send(JSON.stringify({ push: { channel: name, pub: { data, offset: state.offset } } }));
      }
    }
    return delivered;
  };

  return {
    state,
    rest: (mode) => {
      state.restMode = mode;
    },
    images: (mode) => {
      state.imageMode = mode;
    },
    subscribed: (prefix) => [...state.sockets].some((entry) => [...entry.channels].some((name) => name.startsWith(prefix))),
    dropSockets: () => {
      for (const entry of [...state.sockets]) entry.ws.close({ code: 4000, reason: "gate-drop" });
    },
    publish,
    /** 옛 알림(`expression.changed`): 무엇이 바뀌었는지 말하지 않는다 → 저장소가 그림 세대를 통째로 바꾼다. */
    bumpCatalog: () => {
      state.catalogVersion += 1;
      return publish("expressions:", { type: "expression.changed", workspaceId, version: String(state.catalogVersion) });
    },
    /** 상세 알림: 등록(글자였던 이름이 그림이 된다) · 숨김(그림이 글자가 된다). */
    detail: (action, key) => {
      state.catalogVersion += 1;
      if (action === "created") state.active.set(key, state.catalogVersion);
      if (action === "hidden") state.active.delete(key);
      return publish("expressions:", {
        type: "expression.changed.detail",
        workspaceId,
        version: String(state.catalogVersion),
        action,
        expressionIds: [DEF[key].id],
      });
    },
    typing: (ttlMs) =>
      publish("typing:", {
        type: "ephemeral.typing",
        v: 1,
        ts: Date.now(),
        payload: {
          workspace_id: WS_UPPER,
          channel_id: dmChannelId.toUpperCase(),
          member_id: peerId.toUpperCase(),
          expires_at: Date.now() + ttlMs,
        },
      }),
  };
}

// ---------------------------------------------------------------------------------------------- 계측

/**
 * 프레임마다 그려진 모양을 적는다(rAF 안에서 게시한 메시지는 그 프레임의 그리기 · ResizeObserver 콜백이 끝난 뒤에 돈다).
 * 그 사이의 잠깐 값도 놓치지 않게 MutationObserver가 「글자 폴백이 붙은 횟수」와 「필이 선 횟수」를 따로 센다.
 */
async function installProbe(page) {
  await page.addInitScript(() => {
    window.__ej = { on: false, gen: 0 };
  });
}

async function startWindow(page, { expectImages, anchorText = null }) {
  await page.evaluate(
    ({ expectImages, anchorText }) => {
      const J = window.__ej;
      const timeline = document.querySelector('[data-testid="chat-timeline"]');
      const scroller = timeline?.querySelector("[data-virtuoso-scroller]");
      if (!timeline || !scroller) throw new Error("계측할 목록이 없다");
      const known = new Set(expectImages);
      const pattern = /:([a-z0-9_-]{2,30}):/g;
      /** 이 노드 아래의 「그림이어야 하는데 글자인」 이모티콘 이름들. */
      // 같은 크기 칸 안의 이름 표지는 세지 않는다(칸의 크기가 그대로다). 칸을 버리고 글자가 된 것만 센다.
      const inLabel = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest?.("[data-expression-label]") != null;
      const textHits = (root) => {
        const hits = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (inLabel(node)) continue;
          for (const match of node.data.matchAll(pattern)) if (known.has(match[1])) hits.push(match[1]);
        }
        return hits;
      };
      const anchorRow = () => {
        if (anchorText === null) return null;
        for (const row of scroller.querySelectorAll("[data-index]")) if (row.textContent?.includes(anchorText)) return row;
        return null;
      };
      J.frames = [];
      J.intermediate = [];
      J.scrolls = [];
      J.textInsertions = [];
      J.pillMounts = 0;
      J.on = true;
      J.gen += 1;
      const gen = J.gen;
      const live = () => J.on && J.gen === gen;
      const t0 = performance.now();
      const onScroll = () => {
        if (live()) J.scrolls.push({ t: Math.round(performance.now() - t0), top: scroller.scrollTop });
      };
      // 그려진 모양만 센다: 이 프레임의 rAF 뒤로 DOM 이 바뀌었으면(React 의 커밋이 그리기와 이 표본 사이에 끼었다) 그 표본은 아직 그려지지
      // 않은 중간 상태다(다음 그리기 전에 ResizeObserver 가 바로잡을 수 있다). 그런 표본은 따로 적는다.
      let dirty = false;
      const dirtyWatch = new MutationObserver(() => {
        dirty = true;
      });
      dirtyWatch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      scroller.addEventListener("scroll", onScroll, { passive: true });
      const mo = new MutationObserver((records) => {
        if (!live()) return;
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && (node.matches?.('[data-testid="jump-latest"]') || node.querySelector?.('[data-testid="jump-latest"]'))) J.pillMounts += 1;
            if (!scroller.contains(node) || inLabel(node)) continue;
            const hits = node.nodeType === 3 ? [...node.data.matchAll(pattern)].map((m) => m[1]).filter((n) => known.has(n)) : textHits(node);
            if (hits.length) J.textInsertions.push({ t: Math.round(performance.now() - t0), hits });
          }
          if (record.type === "characterData" && scroller.contains(record.target) && !inLabel(record.target)) {
            const hits = [...record.target.data.matchAll(pattern)].map((m) => m[1]).filter((n) => known.has(n));
            if (hits.length) J.textInsertions.push({ t: Math.round(performance.now() - t0), hits });
          }
        }
      });
      mo.observe(timeline, { childList: true, subtree: true, characterData: true });
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (!live()) return;
        const anchor = anchorRow();
        const scrollerBox = scroller.getBoundingClientRect();
        const scrollerTop = scrollerBox.top;
        const rows = scroller.querySelectorAll("[data-index]");
        const last = rows[rows.length - 1] ?? null;
        const round = (value) => Math.round(value * 100) / 100;
        (dirty ? J.intermediate : J.frames).push({
          t: Math.round(performance.now() - t0),
          top: scroller.scrollTop,
          sh: scroller.scrollHeight,
          gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          pill: document.querySelector('[data-testid="jump-latest"]') !== null,
          text: textHits(scroller).length,
          canvases: scroller.querySelectorAll("canvas.expression-image").length,
          images: scroller.querySelectorAll("img.expression-image").length,
          anchorY: anchor ? Math.round((anchor.getBoundingClientRect().top - scrollerTop) * 100) / 100 : null,
          // 창 좌표(#5575 검수 H1): 사람의 눈이 보는 자리. 목록 상자가 통째로 움직여도 잡힌다.
          anchorScreen: anchor ? round(anchor.getBoundingClientRect().top) : null,
          lastIndex: last?.getAttribute("data-index") ?? null,
          lastBottom: last ? round(last.getBoundingClientRect().bottom) : null,
          scrollerTop: round(scrollerTop),
          scrollerBottom: round(scrollerBox.bottom),
          typing: document.querySelector('[data-testid="typing-line"][data-state="on"], [data-testid="composer-typing"]') !== null,
          blocked: document.querySelector('[data-testid="composer-offline"]') !== null,
        });
      };
      // 창을 여는 순간의 그려진 모양을 첫 표본으로 둔다: 장면의 변화가 첫 rAF 보다 먼저 오더라도 「바뀌기 전」이 기록에 남는다.
      channel.port1.onmessage();
      const tick = () => {
        if (!live()) {
          scroller.removeEventListener("scroll", onScroll);
          mo.disconnect();
          dirtyWatch.disconnect();
          return;
        }
        dirty = false;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { expectImages, anchorText }
  );
}

async function stopWindow(page) {
  return page.evaluate(() => {
    const J = window.__ej;
    J.on = false;
    return { frames: J.frames, intermediate: J.intermediate, scrolls: J.scrolls, textInsertions: J.textInsertions, pillMounts: J.pillMounts };
  });
}

function summarize(label, raw, extra = {}) {
  const frames = raw.frames;
  const gaps = frames.map((frame) => frame.gap);
  const anchors = frames.map((frame) => frame.anchorY).filter((value) => value !== null);
  const spread = (values) => (values.length ? Math.round((Math.max(...values) - Math.min(...values)) * 100) / 100 : null);
  const anchorScreens = frames.map((frame) => frame.anchorScreen).filter((value) => value !== null && value !== undefined);
  // 마지막 줄이 바뀌면(새 줄이 붙음) 같은 줄끼리만 견준다: 첫 표본의 마지막 줄.
  const firstLast = frames.find((frame) => frame.lastIndex !== null)?.lastIndex ?? null;
  const lastBottoms = frames.filter((frame) => frame.lastIndex === firstLast && frame.lastBottom !== null).map((frame) => frame.lastBottom);
  const pillFrames = frames.filter((frame) => frame.pill).length;
  let pillShows = 0;
  for (let i = 0; i < frames.length; i += 1) if (frames[i].pill && (i === 0 || !frames[i - 1].pill)) pillShows += 1;
  return {
    label,
    frames: frames.length,
    maxText: frames.length ? Math.max(...frames.map((frame) => frame.text)) : 0,
    textFrames: frames.filter((frame) => frame.text > 0).length,
    textInsertions: raw.textInsertions.length,
    textNames: [...new Set(raw.textInsertions.flatMap((entry) => entry.hits))],
    maxGap: gaps.length ? Math.max(...gaps) : null,
    gapFrames: frames.filter((frame) => frame.gap > 1).length,
    finalGap: frames.length ? frames[frames.length - 1].gap : null,
    pillShows,
    pillFrames,
    pillMounts: raw.pillMounts,
    scrollEvents: raw.scrolls.length,
    heights: [...new Set(frames.map((frame) => frame.sh))].slice(0, 12),
    maxCanvases: frames.length ? Math.max(...frames.map((frame) => frame.canvases)) : 0,
    minImages: frames.length ? Math.min(...frames.map((frame) => frame.images)) : 0,
    intermediateSamples: raw.intermediate.length,
    intermediateMaxGap: raw.intermediate.length ? Math.max(...raw.intermediate.map((frame) => frame.gap)) : null,
    anchorSpread: anchors.length ? Math.round((Math.max(...anchors) - Math.min(...anchors)) * 100) / 100 : null,
    anchorFirst: anchors[0] ?? null,
    anchorLast: anchors[anchors.length - 1] ?? null,
    anchorScreenSpread: spread(anchorScreens),
    anchorScreenRange: anchorScreens.length ? [Math.min(...anchorScreens), Math.max(...anchorScreens)] : null,
    lastBottomSpread: spread(lastBottoms),
    lastBottomRange: lastBottoms.length ? [Math.min(...lastBottoms), Math.max(...lastBottoms)] : null,
    lastRowChanged: frames.some((frame) => frame.lastIndex !== null && frame.lastIndex !== firstLast),
    scrollerTops: [...new Set(frames.map((frame) => frame.scrollerTop))].slice(0, 8),
    scrollerBottoms: [...new Set(frames.map((frame) => frame.scrollerBottom))].slice(0, 8),
    typingFrames: frames.filter((frame) => frame.typing).length,
    blockedFrames: frames.filter((frame) => frame.blocked).length,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------- 장면

const scrollerSelector = '[data-testid="chat-timeline"] [data-virtuoso-scroller]';

async function openDm(page, backend) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("haneul@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  const item = page.locator(`[data-testid="channel-item"][data-channel-id="${dmChannelId}"]`);
  if ((page.viewportSize()?.width ?? 1280) >= 600) {
    await item.click();
  } else {
    // 폰 폭: 목록은 닫힌 서랍 안에 있다. 그 줄의 링크(`#/c/<id>`)로 간다.
    await item.waitFor({ state: "attached" });
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, dmChannelId);
  }
  await page.getByTestId("composer-input").waitFor();
  const deadline = Date.now() + 15_000;
  while (!backend.subscribed("typing:") || !backend.subscribed("expressions:")) {
    if (Date.now() > deadline) throw new Error("실시간 구독(typing · expressions)이 서지 않았다");
    await wait(100);
  }
  // 기록이 다 그려지고 그림이 다 서고 목록이 바닥에 앉을 때까지.
  await page.waitForFunction(
    (selector) => {
      const scroller = document.querySelector(selector);
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 200) return false;
      return scroller.querySelectorAll("img.expression-image").length >= 4;
    },
    scrollerSelector,
    { timeout: 15_000 }
  );
  await settleToBottom(page);
}

/** 첫 착지는 바닥에서 몇 px 위일 수 있다(#5567 기록). 재기 전에 정확히 바닥으로 놓고 그림이 다 앉기를 기다린다. */
async function settleToBottom(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate((selector) => {
      const scroller = document.querySelector(selector);
      scroller.scrollTop = scroller.scrollHeight;
    }, scrollerSelector);
    await wait(500);
  }
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await wait(400);
}

async function focusEvent(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function untilTrue(fn, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(100);
  }
  throw new Error(`기다리던 일이 오지 않았다: ${label}`);
}

const BASE_IMAGES = ["coffee_break", "good_job", "rocket_launch", "sleepy_cat", "bug_hunt", "high_five", "old_flag"];

async function runBottomScene(browser, engine, run = 1) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  if (run === 1) console.log(`[${engine}] 타임라인 스크롤러 overflow-anchor=${await scrollerOverflowAnchor(page, scrollerSelector)}`);
  const results = [];
  const record = async (label, body, { expect = BASE_IMAGES, settle = 1_200 } = {}) => {
    const before = { ...backend.state, sockets: undefined, active: undefined };
    const contentHeight = () => page.evaluate((selector) => document.querySelector(selector).scrollHeight, scrollerSelector);
    const heightBefore = await contentHeight();
    await startWindow(page, { expectImages: expect });
    await body();
    await wait(settle);
    const raw = await stopWindow(page);
    const extra = {
      heightBefore,
      heightAfter: await contentHeight(),
      listReads: backend.state.listReads - before.listReads,
      listReadsFailed: backend.state.listReadsFailed - before.listReadsFailed,
      imageReads: backend.state.imageReads - before.imageReads,
      imageReadsFailed: backend.state.imageReadsFailed - before.imageReadsFailed,
      handshakes: backend.state.handshakes - before.handshakes,
    };
    results.push({ summary: summarize(label, raw, extra), raw });
  };

  await record("1 포커스(30초 다시 읽기와 같은 함수) ×4", async () => {
    for (let i = 0; i < 4; i += 1) {
      await focusEvent(page);
      await wait(700);
    }
  });
  if (realInterval) {
    await record("1b 30초 주기 다시 읽기(실제)", async () => {
      await wait(31_000);
    });
  }
  await record("2 세대 교체(옛 변경 알림) ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      backend.bumpCatalog();
      await wait(900);
    }
  });
  await record("3 실시간 다시 연결 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      const handshakes = backend.state.handshakes;
      backend.dropSockets();
      await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
      await wait(900);
    }
  });
  await record("4 다시 연결 + 그림 받기 실패(서버 재시작) ×2", async () => {
    for (let i = 0; i < 2; i += 1) {
      backend.images("abort");
      const handshakes = backend.state.handshakes;
      backend.dropSockets();
      await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
      await wait(1_200);
      backend.images("ok");
      await wait(800);
    }
  });
  await record("5 기기 오프라인 흔들림 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      if (i === 0) await capture(page, engine, "1-online");
      await context.setOffline(true);
      await wait(1_000);
      if (i === 0) await capture(page, engine, "2-offline");
      await wait(300);
      await context.setOffline(false);
      await wait(1_800);
      if (i === 0) await capture(page, engine, "3-back-online");
    }
  }, { settle: 2_000 });
  await record("6 서버에 닿지 못함 선언 ×2", async () => {
    for (let i = 0; i < 2; i += 1) {
      backend.rest("abort");
      const deadline = Date.now() + 8_000;
      // 서로 다른 요청 3건이 연달아 닿지 못해야 선언이 선다: 포커스(목록 읽기 등)와 실시간 끊기(토큰·다시 읽기)로 요청을 낸다.
      backend.dropSockets();
      while (Date.now() < deadline) {
        await focusEvent(page);
        await wait(400);
        const blocked = await page.evaluate(() => document.querySelector('[data-testid="composer-offline"]') !== null);
        if (blocked) break;
      }
      await wait(1_200);
      backend.rest("ok");
      await focusEvent(page);
      await untilTrue(async () => page.evaluate(() => document.querySelector('[data-testid="composer-offline"]') === null), "선언이 풀림", 20_000);
      await wait(1_500);
    }
  }, { settle: 2_000 });
  await record("7 상대 「입력 중」 켜고 끄기 ×3", async () => {
    for (let i = 0; i < 3; i += 1) {
      backend.typing(700);
      await wait(1_700);
    }
  });

  // 진짜 높이 변화: 맨 아래에서.
  // 등록 전의 `:new_badge:` 는 모르는 이름이라 글자가 맞다. 그림이 됐는지는 다음 창(9)이 `new_badge` 까지 그림으로 센다.
  await record("8 등록: 글자였던 이름이 그림이 된다(목록이 자람)", async () => {
    backend.detail("created", "badge");
    await wait(1_500);
  });
  await record("9 숨김: 그림이 글자가 된다(목록이 줆)", async () => {
    backend.detail("hidden", "cat");
    await wait(1_500);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "sleepy_cat"), "new_badge"] });

  // 화면 밖으로 갔다 돌아오기(IntersectionObserver · 줄 다시 붙이기): 글자만 센다.
  await record("10 화면 밖 갔다 오기(보임 바뀜)", async () => {
    await page.evaluate((selector) => {
      document.querySelector(selector).scrollTop -= 1_600;
    }, scrollerSelector);
    await wait(900);
    await page.evaluate((selector) => {
      const scroller = document.querySelector(selector);
      scroller.scrollTop = scroller.scrollHeight;
    }, scrollerSelector);
    await wait(900);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "sleepy_cat"), "new_badge"] });

  if (measureOnly) results.push(...(await mechanismProbe(page)));
  await context.close();
  return results.map((entry) => ({ engine, scene: "bottom", run, ...entry }));
}

/** 앵커 줄을 화면 가운데쯤에 둔다(가상 목록이 줄을 붙일 때까지 기다리며 올라간다). */
async function placeAnchor(page) {
  let placed = false;
  for (let step = 0; step < 40 && !placed; step += 1) {
    placed = await page.evaluate(
      ({ selector, text }) => {
        const scroller = document.querySelector(selector);
        const row = [...scroller.querySelectorAll("[data-index]")].find((node) => node.textContent?.includes(text));
        if (!row) {
          scroller.scrollTop -= 300;
          return false;
        }
        scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight * 0.55;
        return true;
      },
      { selector: scrollerSelector, text: ANCHOR_TEXT }
    );
    await wait(120);
  }
  if (!placed) throw new Error("앵커 줄을 찾지 못했다");
}

/**
 * 연결 끊김 → 돌아옴, **창 기준** (#5575 검수 H1). 맨 아래에 붙은 채(C1)와 위를 읽던 중(C2)에 기기 오프라인을 두 번 흔든다.
 * 오프라인이 되면 입력창 쪽 「보낼 수 없어요」 줄 · 머리 아래 허들 배너 · (폰 폭) 셸 위쪽 연결 띠가 서고 진다. 목록 안쪽 좌표는 목록 상자가
 * 통째로 움직이면 0을 보고하므로, 마지막 줄의 아래 끝과 보던 줄의 위 끝을 창 좌표로 잰다.
 */
async function runConnectionScene(browser, engine, vp) {
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  const results = [];
  const record = async (label, body, { anchorText = null } = {}) => {
    await startWindow(page, { expectImages: BASE_IMAGES, anchorText });
    await body();
    await wait(1_500);
    const raw = await stopWindow(page);
    results.push({ summary: summarize(label, raw, { width: vp.width }), raw });
  };
  const flap = async (tag) => {
    for (let i = 0; i < 2; i += 1) {
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-1-online`);
      await context.setOffline(true);
      await wait(1_500);
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-2-offline`);
      await context.setOffline(false);
      await wait(2_500);
      if (i === 0) await captureWindow(page, engine, `${tag}-${vp.width}-3-back`);
    }
  };
  // 위 읽기를 먼저 잰다: 한 번 흔든 뒤에는 허들 상태가 「불러오지 못했습니다」 배너로 남아(검수 O2) 위 가장자리가 더 움직이지 않을 수 있다.
  await placeAnchor(page);
  await wait(1_500);
  await record(`C2 위 읽기: 연결 끊김 → 돌아옴 ×2 (창 기준, ${vp.width})`, () => flap("C2"), { anchorText: ANCHOR_TEXT });
  await settleToBottom(page);
  await record(`C1 맨 아래: 연결 끊김 → 돌아옴 ×2 (창 기준, ${vp.width})`, () => flap("C1"));
  await context.close();
  return results.map((entry) => ({ engine, scene: "connection", ...entry }));
}

/** 위로 올려 읽던 중: 보던 줄이 화면에서 움직이지 않아야 한다. */
async function runAnchorScene(browser, engine) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ko-KR" });
  const backend = await installBackend(context);
  const page = await context.newPage();
  await installProbe(page);
  await openDm(page, backend);
  await placeAnchor(page);
  await wait(1_500);
  const results = [];
  const record = async (label, body, { expect = BASE_IMAGES, settle = 1_200, extra = {} } = {}) => {
    await startWindow(page, { expectImages: expect, anchorText: ANCHOR_TEXT });
    await body();
    await wait(settle);
    const raw = await stopWindow(page);
    results.push({ summary: summarize(label, raw, extra), raw });
  };
  await record("A1 일시적 상태들(세대 교체 · 다시 연결 · 포커스 · 오프라인 흔들림 · 입력 중)", async () => {
    backend.bumpCatalog();
    await wait(900);
    const handshakes = backend.state.handshakes;
    backend.dropSockets();
    await untilTrue(async () => backend.state.handshakes > handshakes && backend.subscribed("expressions:"), "다시 연결");
    await wait(900);
    await focusEvent(page);
    await wait(700);
    await context.setOffline(true);
    await wait(1_300);
    await context.setOffline(false);
    await wait(1_800);
    backend.typing(700);
    await wait(1_500);
  });
  /** 바뀔 줄이 붙어 있고(가상 목록 안) 화면 위 밖에 있는가(바닥이 스크롤러 위쪽보다 위). */
  const above = (name) =>
    page.evaluate(
      ({ selector, name }) => {
        const scroller = document.querySelector(selector);
        const row = [...scroller.querySelectorAll("[data-index]")].find((node) => node.textContent?.includes(`:${name}:`) || node.querySelector(`[data-expression-name="${name}"]`));
        if (!row) return "붙어 있지 않다";
        const gap = scroller.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
        return gap > 0 ? true : `화면 안에 있다(위쪽에서 ${Math.round(-gap)}px 아래까지)`;
      },
      { selector: scrollerSelector, name }
    );
  // 등록 전의 `:late_star:` 는 모르는 이름이라 글자가 맞다(셀 이름에서 뺀다). 숨김 뒤의 `:old_flag:` 도 같다.
  const starAbove = await above("late_star");
  await record("A2 위쪽에서 등록(글자 → 그림, 보던 곳 위가 자람)", async () => {
    backend.detail("created", "star");
    await wait(1_500);
  }, { extra: { targetAbove: starAbove } });
  const flagAbove = await above("old_flag");
  await record("A3 위쪽에서 숨김(그림 → 글자, 보던 곳 위가 줆)", async () => {
    backend.detail("hidden", "flag");
    await wait(1_500);
  }, { expect: [...BASE_IMAGES.filter((name) => name !== "old_flag"), "late_star"], extra: { targetAbove: flagAbove } });
  await context.close();
  return results.map((entry) => ({ engine, scene: "anchor", ...entry }));
}

/** 메커니즘 탐침(측정 전용): 줄 하나의 높이를 바꿨을 때 이 엔진 · 이 목록이 스크롤을 어떻게 다루는가. */
async function mechanismProbe(page) {
  const probe = await page.evaluate(async (selector) => {
    const scroller = document.querySelector(selector);
    const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    const rows = [...scroller.querySelectorAll("[data-index]")];
    const box = scroller.getBoundingClientRect();
    const inView = rows.filter((row) => row.getBoundingClientRect().bottom > box.top && row.getBoundingClientRect().top < box.bottom);
    const last = inView[inView.length - 1];
    const out = { atBottom: { start: { gap: gap(), top: scroller.scrollTop } } };
    // (a) 맨 아래: 화면 안 줄이 120px 줄었다가(그림 → 글자) 다시 자란다(글자 → 그림).
    const spacer = document.createElement("div");
    spacer.style.height = "120px";
    last.appendChild(spacer);
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    out.atBottom.withSpacer = { gap: gap(), top: scroller.scrollTop };
    spacer.remove();
    await frames();
    out.atBottom.shrunk = { gap: gap(), top: scroller.scrollTop };
    await new Promise((done) => setTimeout(done, 300));
    last.appendChild(spacer);
    await frames();
    out.atBottom.grownSameTask = { gap: gap(), top: scroller.scrollTop };
    await new Promise((done) => setTimeout(done, 400));
    out.atBottom.grownLater = { gap: gap(), top: scroller.scrollTop };
    spacer.remove();
    scroller.scrollTop = scroller.scrollHeight;
    await frames();
    await new Promise((done) => setTimeout(done, 300));
    // (b) 위를 읽는 중: 화면 위쪽 밖의 줄이 120px 자란다.
    scroller.scrollTop -= 900;
    await frames();
    await new Promise((done) => setTimeout(done, 400));
    const rows2 = [...scroller.querySelectorAll("[data-index]")];
    const box2 = scroller.getBoundingClientRect();
    const above = rows2.filter((row) => row.getBoundingClientRect().bottom < box2.top - 10);
    const visible = rows2.find((row) => row.getBoundingClientRect().top >= box2.top);
    const before = visible.getBoundingClientRect().top;
    const topBefore = scroller.scrollTop;
    const grow = document.createElement("div");
    grow.style.height = "120px";
    above[above.length - 1]?.appendChild(grow);
    await frames();
    const sameFrames = visible.getBoundingClientRect().top - before;
    await new Promise((done) => setTimeout(done, 400));
    out.readingUp = {
      aboveRows: above.length,
      moveAfter2Frames: Math.round(sameFrames * 100) / 100,
      moveAfter400ms: Math.round((visible.getBoundingClientRect().top - before) * 100) / 100,
      scrollTopDelta: scroller.scrollTop - topBefore,
      overflowAnchorScroller: getComputedStyle(scroller).overflowAnchor,
      overflowAnchorRow: getComputedStyle(visible).overflowAnchor,
    };
    grow.remove();
    return out;
  }, scrollerSelector);
  return [{ summary: { label: "탐침", probe }, raw: null }];
}

// ---------------------------------------------------------------------------------------------- 판정

function judge(all) {
  const failures = [];
  for (const entry of all) {
    const { summary, engine, scene, run } = entry;
    if (summary.probe) continue;
    const where = `${engine}${bottomRepeat > 1 ? ` #${run}` : ""} ${summary.label}`;
    if (summary.frames < 20) failures.push(`${where}: 그려진 프레임 표본이 ${summary.frames}개뿐이다(재기가 장면을 못 봤다)`);
    if (summary.maxText !== 0 || summary.textInsertions !== 0) {
      failures.push(`${where}: 아는 이모티콘이 :이름: 글자로 바뀌었다 (프레임 최대 ${summary.maxText}개, 붙은 횟수 ${summary.textInsertions}, ${JSON.stringify(summary.textNames)})`);
    }
    if (scene === "bottom" && !summary.label.startsWith("10")) {
      // 진짜 높이 변화(등록 · 숨김)도 두 엔진 모두 바닥 거리 ≤1px 이다(#5638). 예전에는 Chromium 만 기록만 했다(#5583 당시 가상 목록이
      // 바로잡은 scrollTop 을 한 프레임 되돌려 쓰고 끝맞춤이 2px 모자랐다). 2026-11-10 새 창 10번 되풀이
      // (`EXPRESSION_JITTER_ONLY=bottom EXPRESSION_JITTER_REPEAT=10`)에서 스크롤러 앵커링을 끈 번들도, 끄기 전 번들도 10/10 바닥 거리 0 ·
      // 마지막 줄 ≤0.75px 이라 단정으로 올렸다 — 2px 모자람은 지금 번들에서 재현되지 않는다. 바닥 붙이기(`scrollHold`)를 끈 번들에서는
      // Chromium 등록이 165px, 숨김이 2px 떨어져 이 단정이 빨개진다.
      if (summary.maxGap > 1) {
        failures.push(`${where}: 맨 아래에 붙은 목록이 ${summary.maxGap}px 떨어졌다(${summary.gapFrames}프레임)`);
      }
      if (summary.pillShows !== 0 || summary.pillMounts !== 0) {
        failures.push(`${where}: 「최신 메시지로 이동」이 ${Math.max(summary.pillShows, summary.pillMounts)}번 섰다`);
      }
      // 창 기준(#5575 검수 H1): 바닥 거리가 0이어도 목록 상자가 움직이면 마지막 줄이 화면에서 움직인다.
      if (summary.lastBottomSpread === null || summary.lastBottomSpread > 1) {
        failures.push(`${where}: 맨 아래의 마지막 줄이 창에서 ${summary.lastBottomSpread}px 움직였다 ${JSON.stringify(summary.lastBottomRange)}`);
      }
    }
    if (scene === "connection") {
      if (summary.blockedFrames === 0) failures.push(`${where}: 오프라인이 서지 않았다(장면을 못 만들었다)`);
      if (summary.label.startsWith("C1")) {
        // 맨 아래에서는 같은 마지막 줄을 재야 한다(위를 읽는 중에는 목록 상자 크기에 따라 붙는 줄이 바뀌어도 된다).
        if (summary.lastRowChanged) failures.push(`${where}: 마지막 줄이 바뀌었다(장면을 못 만들었다)`);
        if (summary.lastBottomSpread === null || summary.lastBottomSpread > 1) {
          failures.push(`${where}: 맨 아래의 마지막 줄이 창에서 ${summary.lastBottomSpread}px 움직였다 ${JSON.stringify(summary.lastBottomRange)}`);
        }
        if (summary.maxGap > 1) failures.push(`${where}: 맨 아래에 붙은 목록이 ${summary.maxGap}px 떨어졌다(${summary.gapFrames}프레임)`);
        if (summary.pillShows !== 0 || summary.pillMounts !== 0) {
          failures.push(`${where}: 「최신 메시지로 이동」이 ${Math.max(summary.pillShows, summary.pillMounts)}번 섰다`);
        }
      }
      if (summary.label.startsWith("C2") && (summary.anchorScreenSpread === null || summary.anchorScreenSpread > 1)) {
        failures.push(`${where}: 위를 읽던 줄이 창에서 ${summary.anchorScreenSpread}px 움직였다 ${JSON.stringify(summary.anchorScreenRange)}`);
      }
      // 장면이 실제로 만들어졌는가: 위를 읽는 동안 목록 상자의 위 가장자리가 한 번은 움직였어야 한다(배너 · 띠가 섰다).
      if (summary.label.startsWith("C2") && summary.scrollerTops.length < 2) {
        failures.push(`${where}: 목록의 위 가장자리가 한 번도 움직이지 않았다(장면을 못 만들었다)`);
      }
    }
    if (scene === "bottom" && summary.label.startsWith("10") && summary.finalGap > 1) {
      failures.push(`${where}: 돌아온 뒤 목록이 바닥에서 ${summary.finalGap}px 떨어져 있다`);
    }
    if (scene === "anchor" && summary.targetAbove !== undefined && summary.targetAbove !== true) {
      failures.push(`${where}: 바뀔 줄이 화면 위 밖에 붙어 있지 않다 — ${summary.targetAbove}(장면을 못 만들었다)`);
    }
    // 보던 줄의 자는 **창 좌표**다(#5575 검수 H1). 목록 안쪽 좌표(`anchorSpread`)는 기록만 한다: 목록 상자가 움직일 때(배너 · 띠) 줄을 창에서
    // 제자리에 두려면 목록 안쪽 좌표는 그만큼 바뀌어야 하고, 옛 판처럼 안쪽 좌표만 지키면 줄이 상자와 함께 창에서 움직인다.
    // 창 기준: 연결 흔들림이 든 A1은 1px, 진짜 높이 변화(A2 · A3)는 2px.
    const screenLimit = summary.label.startsWith("A1") ? 1 : 2;
    if (scene === "anchor" && (summary.anchorScreenSpread === null || summary.anchorScreenSpread > screenLimit)) {
      failures.push(`${where}: 보던 줄이 창에서 ${summary.anchorScreenSpread}px 움직였다(${screenLimit}px 이하여야 한다) ${JSON.stringify(summary.anchorScreenRange)}`);
    }
    // 장면이 실제로 만들어졌는가.
    if (summary.label.startsWith("5") && summary.blockedFrames === 0) failures.push(`${where}: 오프라인이 서지 않았다(장면을 못 만들었다)`);
    if (summary.label.startsWith("6") && summary.blockedFrames === 0) failures.push(`${where}: 서버에 닿지 못함 선언이 서지 않았다(장면을 못 만들었다)`);
    if ((summary.label.startsWith("4") || summary.label.startsWith("6")) && summary.imageReadsFailed === 0) {
      failures.push(`${where}: 그림 받기가 한 번도 실패하지 않았다(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("7") && summary.typingFrames === 0) failures.push(`${where}: 상대 「입력 중」이 그려지지 않았다(장면을 못 만들었다)`);
    if ((summary.label.startsWith("2") || summary.label.startsWith("3")) && summary.imageReads === 0) {
      failures.push(`${where}: 그림을 다시 받지 않았다 — 세대가 바뀌지 않았다(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("3") && summary.handshakes < 3) failures.push(`${where}: 실시간이 다시 붙지 않았다(장면을 못 만들었다)`);
    if (summary.label.startsWith("8") && summary.heightAfter <= summary.heightBefore) {
      failures.push(`${where}: 등록으로 목록이 자라지 않았다 ${summary.heightBefore}→${summary.heightAfter}(장면을 못 만들었다)`);
    }
    if (summary.label.startsWith("9") && summary.heightAfter >= summary.heightBefore) {
      failures.push(`${where}: 숨김으로 목록이 줄지 않았다 ${summary.heightBefore}→${summary.heightAfter}(장면을 못 만들었다)`);
    }
  }
  return failures;
}

async function main() {
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "EXPRESSION_JITTER_PORT",
    extraArgs: distOverride ? ["--outDir", resolve(distOverride)] : [],
  });
  const all = [];
  try {
    for (const name of engineNames) {
      const type = name === "webkit" ? webkit : name === "chromium" ? chromium : null;
      if (type === null) throw new Error(`모르는 엔진: ${name}`);
      const browser = await type.launch({ headless: true });
      try {
        await printEngineAnchorHeader(browser, name);
        if (onlyScene !== null && onlyScene !== "connection" && onlyScene !== "bottom") throw new Error(`모르는 장면: ${onlyScene}`);
        if (onlyScene === null || onlyScene === "bottom") {
          for (let run = 1; run <= bottomRepeat; run += 1) all.push(...(await runBottomScene(browser, name, run)));
        }
        if (onlyScene === null) all.push(...(await runAnchorScene(browser, name)));
        if (onlyScene === null || onlyScene === "connection") {
          for (const vp of connectionViewports) all.push(...(await runConnectionScene(browser, name, vp)));
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }
  for (const entry of all) console.log(`[${entry.engine}${bottomRepeat > 1 && entry.run ? ` #${entry.run}` : ""}] ${JSON.stringify(entry.summary)}`);
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "expression-jitter.json"), JSON.stringify(all, null, 1));
    console.log(`프레임 기록: ${resolve(outDir, "expression-jitter.json")}`);
  }
  if (measureOnly) return;
  const failures = judge(all);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  if (onlyScene === "bottom") {
    console.log(`PASS expression-jitter (맨 아래 장면만 × ${bottomRepeat}회): ${engineNames.join("·")} — 글자 0 · 바닥 거리 ≤1px · 필 0 · 마지막 줄 창 기준 ≤1px`);
    return;
  }
  console.log(
    `PASS expression-jitter: ${engineNames.join("·")} — 글자 0 · 바닥 거리 0 · 필 0 · 보던 줄 ≤2px · 연결 끊김 → 돌아옴에 마지막 줄·보던 줄 창 기준 ≤1px (${connectionViewports.map((vp) => vp.width).join(" · ")})`
  );
}

await main();
