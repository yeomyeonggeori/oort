// 흔들림 게이트의 가짜 서버 · 대화 픽스처 (#5641) — expression-jitter 에서 꺼내 공용으로 쓴다.
//
// 실제 번들을 Playwright 로 띄우고 `/v1` 과 실시간(센트리퓨고 JSON 프로토콜의 최소판, `routeWebSocket`)을 이 파일이 맡는다.
// 인물 · 대화 · 그림은 지어낸 것이다. 기본값(`history()` · `installBackend(context, { port })`)은 expression-jitter 가 #5575 ·
// #5638 에서 잰 기하 그대로다 — 그 게이트의 숫자가 이 파일로 옮긴 뒤에도 같아야 한다. 장면표 게이트(`gate-timeline-still`)는
// 옛 줄 · 링크 카드 · 쪽 나누기 · 반응 알림을 옵션으로 더한다.

import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

export const workspaceId = "00000000-0000-7000-8000-000000000001";
export const meId = "00000000-0000-7000-8000-000000000121";
export const peerId = "00000000-0000-7000-8000-000000000122";
export const dmChannelId = "00000000-0000-7000-8000-000000000222";
export const generalId = "00000000-0000-7000-8000-000000000221";
const WS_UPPER = workspaceId.toUpperCase();

// ---------------------------------------------------------------------------------------------- 그림 (지어낸 PNG)

/** RGBA PNG 하나를 만든다(zlib + crc32, 의존 없음). */
export function png(width, height, paint) {
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
export function faceSticker(width, height, [r, g, b]) {
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

export const EXPRESSION_DEFS = [
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
export const DEF = Object.fromEntries(EXPRESSION_DEFS.map((def) => [def.key, def]));

/** 링크 카드 그림(1.91:1). */
const UNFURL_PNG = png(382, 200, (x, y) => [80 + (x % 64), 120 + (y % 48), 180, 255]);

/** 서버가 읽어 둔 링크 카드 하나(작게 카드 · 그림 · 아이콘 있음). */
export function unfurlCard(row, url, index = 1) {
  const id = `0199dddd-0000-7000-8000-${String(row.seq * 10 + index).padStart(12, "0")}`;
  return {
    id,
    messageId: row.id,
    url,
    status: "ok",
    title: "릴리스 노트 초안 — 이번 주 바뀐 것",
    description: "배포 순서, 롤백 절차, 알려 둘 것을 한 장에 모았어요.",
    domain: new URL(url).hostname,
    siteName: "팀 문서",
    imageUrl: `/v1/workspaces/${workspaceId}/unfurls/${id}/image`,
    iconUrl: `/v1/workspaces/${workspaceId}/unfurls/${id}/icon`,
    imageWidth: 1200,
    imageHeight: 628,
  };
}

// ---------------------------------------------------------------------------------------------- 대화 (지어낸 것)

/** 로그인 응답. 실시간 주소의 포트는 쓰이지 않는다(`routeWebSocket` 이 가로챈다) — 예전 값(미리보기 포트 + 900)을 그대로 둔다. */
function sessionFor(port) {
  return {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: { id: meId, workspaceId, kind: "human", displayName: "서하늘", handle: "haneul" },
    realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
  };
}

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
export const BODIES = (() => {
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

export const ANCHOR_TEXT = "앵커 줄: 회의록 정리는 내일 오전에 마칠게요.";

/**
 * 줄의 시각. 세 줄(나 · 상대 · 상대)마다 한 분이고, 상대의 두 줄은 **같은 분**이라 한 묶음이다(#5603: 묶음은 같은 로컬 분까지만).
 * 예전에는 줄마다 1분 간격이었고 5분 묶음 창이 상대의 두 줄을 이어 붙였다 — 이 게이트가 잰 기하(머리 줄 수 · 높이)를 그대로 지키려고
 * 묶음 모양을 같게 둔다. 기준 시각은 분의 처음(초 0)이다. 시간대 차이는 분 단위라 로컬에서도 초가 그대로다.
 */
const HISTORY_MINUTE0_MS = 1_785_238_380_000;
function historyAt(i) {
  return HISTORY_MINUTE0_MS + Math.floor(i / 3) * 60_000 + (((i % 3) + 3) % 3) * 10_000;
}

/** 옛 이야기 줄(위로 더 불러오기 장면의 재료). */
const OLDER_LINES = [
  "지난주 회고에서 나온 것 정리해 둘게요.",
  "알림 설정 화면은 다음 주에 다시 볼게요.",
  "검색 색인 다시 만드는 데 20분쯤 걸렸어요.",
  "그 문서 링크는 채널 머리에 고정해 둘게요.",
];

/** 메시지 id: 본문 차례 i(0부터, 옛 줄을 앞에 붙이면 음수)에서 짓는다. 옛 줄이 없으면 예전 id 그대로다. */
export function historyId(i) {
  return i >= 0 ? `0199eeee-0000-7000-8000-${String(i).padStart(12, "0")}` : `0199eeef-0000-7000-8000-${String(-i).padStart(12, "0")}`;
}

/**
 * 대화 기록. 기본값(옛 줄 0 · 덮어쓰기 없음)은 expression-jitter 가 잰 기하 그대로다(seq 1..62).
 * @param {{ olderCount?: number, overrides?: Record<number, string> }} [options]
 *   `olderCount` 옛 줄을 앞에 더한다(seq 는 1부터 다시 매긴다) · `overrides` 본문 차례 → 바꿀 본문
 */
export function history({ olderCount = 0, overrides = {} } = {}) {
  const rows = [];
  for (let i = -olderCount; i < BODIES.length; i += 1) {
    const body = i >= 0 ? (overrides[i] ?? BODIES[i]) : OLDER_LINES[(-i) % OLDER_LINES.length];
    rows.push({
      id: historyId(i),
      channelId: dmChannelId,
      seq: rows.length + 1,
      hlcTs: historyAt(i),
      hlcCount: 0,
      authorMemberId: ((i % 3) + 3) % 3 === 0 ? meId : peerId,
      type: "text",
      body,
      state: "sent",
      createdAtMs: historyAt(i),
    });
  }
  return rows;
}

export function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export function wait(ms) {
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

/**
 * 가짜 `/v1` 과 가짜 실시간(센트리퓨고 JSON 프로토콜의 최소판, `routeWebSocket`)을 컨텍스트에 건다.
 * 기본값은 expression-jitter 가 잰 그대로다(기록 전체를 한 번에 · 링크 카드 없음).
 * @param {import("playwright").BrowserContext} context
 * @param {object} options
 * @param {number} options.port               미리보기 포트(로그인 응답의 실시간 주소에만 쓴다)
 * @param {object[]} [options.rows]           대화 기록(기본 `history()`)
 * @param {boolean} [options.paged]           참이면 `limit`·`before` 대로 쪽을 나누고 `nextBefore` 를 싣는다(위로 더 불러오기)
 * @param {number} [options.olderDelayMs]     `before` 쪽 응답을 늦추는 시간
 * @param {number} [options.imageDelayMs]     그림(이모티콘 · 링크 카드) 응답을 늦추는 시간
 * @param {Record<string, { restDelayMs?: number, cards: object[] }>} [options.unfurls]  메시지 id → 처음 읽을 때의 링크 카드
 */
export async function installBackend(context, { port, rows = history(), paged = false, olderDelayMs = 0, imageDelayMs = 250, unfurls = {} } = {}) {
  const state = {
    restMode: "ok", // ok | abort
    imageMode: "ok", // ok | abort
    /** 그림 응답을 늦추는 시간: 실제 망에서 다시 받기는 수백 ms 걸린다(가상 목록이 스스로 따라붙는 100ms 창 밖). */
    imageDelayMs,
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
    olderReads: 0,
    unfurlReads: 0,
    unfurlImageReads: 0,
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
    // 링크 카드 그림 · 사이트 아이콘(ADR-0170 D5 프록시 경로): 실제 PNG 를 늦게 준다. 깨진 그림이면 카드가 한 번 더 모양을 바꾼다.
    if (/\/unfurls\/[^/]+\/(image|icon)$/.test(path) && state.restMode !== "abort") {
      state.unfurlImageReads += 1;
      await wait(state.imageDelayMs);
      return route.fulfill({ status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" }, body: UNFURL_PNG });
    }
    if (state.restMode === "abort") {
      state.failedTargets.push(`${request.method()} ${path}`);
      if (/\/expressions$/.test(path)) state.listReadsFailed += 1;
      return route.abort("connectionrefused");
    }
    if (path === "/v1/auth/login") return json(route, sessionFor(port));
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
      return json(route, { accessToken: sessionFor(port).accessToken, refreshToken: sessionFor(port).refreshToken });
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
    const unfurlMatch = /\/messages\/([0-9a-f-]{36})\/unfurls$/.exec(path);
    if (unfurlMatch) {
      state.unfurlReads += 1;
      const entry = unfurls[unfurlMatch[1]];
      if (entry?.restDelayMs) await wait(entry.restDelayMs);
      return json(route, { unfurls: entry?.cards ?? [] });
    }
    if (path.includes("/messages")) {
      if (!path.includes(dmChannelId) || url.searchParams.has("after")) return json(route, { messages: [] });
      if (!paged) return json(route, { messages: rows });
      const limit = Number(url.searchParams.get("limit") || 50);
      const before = url.searchParams.get("before");
      const pool = before === null ? rows : rows.filter((row) => row.seq < Number(before));
      const page = pool.slice(-limit);
      if (before !== null) {
        state.olderReads += 1;
        await wait(olderDelayMs);
      }
      return json(route, { messages: page, ...(pool.length > page.length ? { nextBefore: page[0].seq } : {}) });
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
    /** 서버가 링크 카드를 다 읽고 알린다(`message.unfurl`, 메시지의 seq 를 다시 쓴다). */
    unfurl: (row, cards) =>
      publish("ch:", { type: "message.unfurl", v: 1, ts: Date.now(), seq: row.seq, payload: { message_id: row.id, channel_id: dmChannelId, unfurls: cards } }),
    /** 반응 하나가 붙거나 떨어진다(`reaction.added` · `reaction.removed`, id 는 서버처럼 대문자). */
    reaction: (action, row, emoji, memberId = peerId) =>
      publish("ch:", {
        type: action === "added" ? "reaction.added" : "reaction.removed",
        v: 1,
        ts: Date.now(),
        seq: row.seq,
        payload: { action, message_id: row.id.toUpperCase(), member_id: memberId.toUpperCase(), emoji },
      }),
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

// ---------------------------------------------------------------------------------------------- 장면

export const scrollerSelector = '[data-testid="chat-timeline"] [data-virtuoso-scroller]';

/** DM 을 열고 기록 · 그림이 다 서고 바닥에 앉을 때까지 기다린다. `settle: false` 면 바닥으로 다시 놓지 않는다(진입 장면). */
export async function openDm(page, backend, origin, { settle = true, minImages = 4 } = {}) {
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
    ({ selector, minImages }) => {
      const scroller = document.querySelector(selector);
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 200) return false;
      return scroller.querySelectorAll("img.expression-image").length >= minImages;
    },
    { selector: scrollerSelector, minImages },
    { timeout: 15_000 }
  );
  if (settle) await settleToBottom(page);
}

/** 첫 착지는 바닥에서 몇 px 위일 수 있다(#5567 기록). 재기 전에 정확히 바닥으로 놓고 그림이 다 앉기를 기다린다. */
export async function settleToBottom(page) {
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

export async function focusEvent(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

export async function untilTrue(fn, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(100);
  }
  throw new Error(`기다리던 일이 오지 않았다: ${label}`);
}

export const BASE_IMAGES = ["coffee_break", "good_job", "rocket_launch", "sleepy_cat", "bug_hunt", "high_five", "old_flag"];

/** 앵커 줄을 화면 가운데쯤에 둔다(가상 목록이 줄을 붙일 때까지 기다리며 올라간다). */
export async function placeAnchor(page) {
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
