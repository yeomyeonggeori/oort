#!/usr/bin/env node
// GATE: #1202 첨부 축 — 진행률이 거짓말하지 않고, 첨부 없는 경로가 그대로다
// (정본: ADR-0151 D2 · openapi tag `attachments` · 핸드오프 패킷 워커 T)
//
// 이 게이트가 지키는 것은 「첨부가 되는가」가 아니라 **화면이 참말을 하는가**다.
//
//   1. 네 칸이 화면에    고르면 업로드 중(막대+퍼센트), 바이트가 다 가면 확인 중,
//      실제로 다르다     서버가 확인하면 업로드 완료, 거절하면 이유 한 줄.
//   2. 100%는 끝이       바이트를 다 건넨 순간은 `complete` 왕복 **전**이다. 그
//      아니다            사이에 「업로드 완료」가 뜨면 화면이 안 끝난 일을 끝났다고
//                        말하는 것이고, 이 게이트의 무게중심이 그 한 순간이다.
//   3. 못 보낼 때는      올라가는 중이거나 실패한 첨부가 있으면 전송이 막히고
//      막고 말한다       **왜**가 트레이 발치에 있다. 서버는 첨부 한 건의 거절에
//                        메시지째 롤백하므로, 그 롤백을 만나기 전에 화면이 말한다.
//   4. 재시도는 되돌릴   `mismatch`·`unavailable`에만 「다시 시도」가 선다. 상한을
//      값이 있을 때만    넘긴 파일에 재시도 버튼을 다는 것은 죽은 컨트롤이다.
//   5. 타임라인이        이미지는 인라인으로 펴지고 그 밖은 카드다. 두 모양 다
//      두 모양을 갖는다  이름과 「타입 · 크기」를 말하고 내려받기를 갖는다.
//   6. **첨부 없는 경로가 그대로다** — 파일을 한 번도 안 붙인 메시지의 DOM에는
//      첨부 노드가 하나도 없고, 컴포저의 전송 조건도 이전과 같다.
//
// 이름 붙은 red proof (전부 DOM/네트워크 mock만 건드린다 — 제품 소스는 그대로다):
//   ATTACH_GATE_PROVE_RED_HONESTY=1  "the chip claims완료 while the server is still checking"
//   ATTACH_GATE_PROVE_RED_BLOCK=1    "the send button stays live while bytes are moving"
//   ATTACH_GATE_PROVE_RED_CARD=1     "the timeline draws no card for a message that has one"
//
// 값의 정본은 소스를 읽는다(`ATTACH_COPY`). 여기 베껴 적으면 두 벌이 조용히
// 갈라지고, 이 레포는 U4-4R W-2에서 그 값을 이미 치렀다.

import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 첨부 문구의 정본은 코어다. 게이트가 베껴 적으면 두 벌이 갈라진다. */
function attachCopy() {
  const source = readFileSync(
    resolve(
      webRoot,
      "../../packages/momo-core/src/features/attachments/model.ts"
    ),
    "utf8"
  );
  const block = source.match(/export const ATTACH_COPY = \{([\s\S]*?)\n\} as const;/);
  if (block === null) throw new Error("코어의 ATTACH_COPY를 읽지 못했다");
  const copy = {};
  for (const line of block[1].split("\n")) {
    const entry = line.match(/^\s{2}(\w+):\s*"([^"]+)",\s*$/);
    if (entry !== null) copy[entry[1]] = entry[2];
  }
  for (const key of ["uploading", "verifying", "uploaded", "retry", "sendBlocked"]) {
    if (typeof copy[key] !== "string") {
      throw new Error(`ATTACH_COPY.${key}를 읽지 못했다`);
    }
  }
  return copy;
}

/** 실패 문구도 코어가 갖는다. `uploadIssueCopy`의 switch 를 그대로 읽는다. */
function issueCopy(issue) {
  const source = readFileSync(
    resolve(
      webRoot,
      "../../packages/momo-core/src/features/attachments/model.ts"
    ),
    "utf8"
  );
  const found = source.match(
    new RegExp(`case "${issue}":\\s*\\n\\s*return "([^"]+)";`)
  );
  if (found === null) throw new Error(`uploadIssueCopy(${issue})를 읽지 못했다`);
  return found[1];
}

const COPY = attachCopy();
const MISMATCH_COPY = issueCopy("mismatch");
const TOO_LARGE_COPY = issueCopy("too-large");

const port = Number(process.env.ATTACH_GATE_PORT || 5199);
const origin = `http://127.0.0.1:${port}`;

const proveRedHonesty = process.env.ATTACH_GATE_PROVE_RED_HONESTY === "1";
const proveRedBlock = process.env.ATTACH_GATE_PROVE_RED_BLOCK === "1";
const proveRedCard = process.env.ATTACH_GATE_PROVE_RED_CARD === "1";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelA = "00000000-0000-7000-8000-000000000201";

const PLAIN_MSG = "0199dddd-0000-7000-8000-000000000001";
const FILE_MSG = "0199dddd-0000-7000-8000-000000000002";
const IMAGE_MSG = "0199dddd-0000-7000-8000-000000000003";

const FILE_ATTACHMENT = {
  id: "0199eeee-0000-7000-8000-0000000000f1",
  name: "drain-2026-08-09.log",
  mime: "text/plain",
  sizeBytes: 20480,
};
const IMAGE_ATTACHMENT = {
  id: "0199eeee-0000-7000-8000-0000000000f2",
  name: "lag-curve.png",
  mime: "image/png",
  sizeBytes: 4096,
};

/**
 * 프록시가 돌려주는 진짜 PNG 바이트. 손으로 인코딩하는 이유는 **1x1 이면
 * 안 되기 때문**이다: 1px 이미지는 어떤 레이아웃 버그도 드러내지 않고, 실제로
 * 이 판은 그것 때문에 늘어난 이미지를 한 번 통과시킨 적이 있다(캡처 1차).
 * 320x180 은 사람들이 실제로 붙이는 스크린샷의 비율이다.
 */
function makePng(width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      // 가로로 밝아지고 세로로 어두워지는 밋밋한 그라디언트. 내용이 목적이
      // 아니라 「가장자리와 비율이 보이는 면」이 목적이다.
      raw[at++] = 40 + Math.round((x / width) * 150);
      raw[at++] = 60 + Math.round((y / height) * 120);
      raw[at++] = 150 - Math.round((x / width) * 90);
    }
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const PREVIEW_PNG = makePng(320, 180);

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
  realtimeWebSocketUrl: "ws://attach-gate.invalid/connection/websocket",
};

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
  member({
    id: memberId,
    kind: "human",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
  }),
  member({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
];

const channels = [
  { id: channelA, workspaceId, kind: "public", name: "release-2026-08", muted: false },
];

function row(over) {
  return {
    channelId: channelA,
    hlcCount: 0,
    type: "text",
    state: "sent",
    ...over,
    hlcTs: over.hlcTs ?? over.createdAtMs,
  };
}

const FIRST_AT = Date.now() - 3_600_000;

function page() {
  return [
    row({
      id: PLAIN_MSG,
      seq: 100,
      authorMemberId: peerId,
      body: "스테이징 확인했습니다. 첨부 없이 한 줄만 남깁니다.",
      createdAtMs: FIRST_AT,
    }),
    row({
      id: FILE_MSG,
      seq: 101,
      authorMemberId: peerId,
      body: "드레인 로그 붙입니다.",
      createdAtMs: FIRST_AT + 60_000,
      attachments: [FILE_ATTACHMENT],
    }),
    row({
      id: IMAGE_MSG,
      seq: 102,
      authorMemberId: memberId,
      body: "지연 곡선입니다.",
      createdAtMs: FIRST_AT + 120_000,
      attachments: [IMAGE_ATTACHMENT],
    }),
  ];
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function installRealtimeSocket(page_) {
  await page_.addInitScript(() => {
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
            replies.push({
              id: command.id,
              connect: { client: "attach-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "attach-gate",
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
    window.__attachGateSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
  });
}

/**
 * 이 판의 서버. 세 왕복 각각을 **테스트가 손으로 연다** — 그래야 「바이트가 다
 * 갔지만 아직 확인 전」이라는 한 순간을 화면에서 잡을 수 있다.
 */
function createArchive() {
  // 걸쇠(latch)다. **먼저 풀어 두고 나중에 잠기는 순서**가 실제로 일어난다:
  // `complete` 왕복을 미리 열어 두고 바이트를 놓으면, 라우트 핸들러가 들어올
  // 때는 이미 풀려 있어야 한다. 콜백만 들고 있는 판이면 그 요청이 영원히 매달린다.
  const latch = () => {
    let open = false;
    let waiting = null;
    return {
      wait: () =>
        open
          ? Promise.resolve()
          : new Promise((release) => {
              waiting = release;
            }),
      release: () => {
        open = true;
        waiting?.();
        waiting = null;
      },
      relock: () => {
        open = false;
        waiting = null;
      },
    };
  };
  const gates = { bytes: latch(), complete: latch(), completeStatus: 200 };
  return {
    hold: (key) => gates[key].wait(),
    releaseBytes: () => gates.bytes.release(),
    releaseComplete: () => gates.complete.release(),
    relock: () => {
      gates.bytes.relock();
      gates.complete.relock();
    },
    setCompleteStatus: (status) => {
      gates.completeStatus = status;
    },
    completeStatus: () => gates.completeStatus,
  };
}

async function installRoutes(context, archive) {
  // capability URL 을 **같은 출처**로 발급한다. 실제 배포에서는 Google 의
  // 주소이고, 이 판이 재는 것은 그 주소가 어디냐가 아니라 클라가 그 주소로
  // 베어러 없이 바이트를 보내고 진행을 화면에 옮기느냐다.
  await context.route(`${origin}/__gate/upload/*`, async (route) => {
    if (route.request().headers().authorization !== undefined) {
      throw new Error("capability URL 에 베어러가 실렸다");
    }
    await archive.hold("bytes");
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
        memberId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
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

    // ---- 첨부 3경로 -------------------------------------------------------
    if (path.endsWith("/attachments/uploads")) {
      const body = JSON.parse(request.postData() ?? "{}");
      return json(
        route,
        {
          id: "0199eeee-0000-7000-8000-0000000000aa",
          status: "pending",
          uploadUrl: `${origin}/__gate/upload/${encodeURIComponent(body.name)}`,
        },
        201
      );
    }
    if (path.endsWith("/complete")) {
      await archive.hold("complete");
      if (archive.completeStatus() !== 200) {
        return json(
          route,
          { error: { message: "uploaded file size or mime does not match" } },
          archive.completeStatus()
        );
      }
      return json(route, {
        id: "0199eeee-0000-7000-8000-0000000000aa",
        channelId: channelA,
        uploaderMemberId: memberId,
        name: "drain-2026-08-09.log",
        mime: "text/plain",
        size: 20480,
        status: "complete",
        createdAtMs: Date.now(),
      });
    }
    if (path.endsWith("/content")) {
      // 인가 프록시. 베어러가 **반드시** 있어야 한다 — 없으면 이 판은 실제
      // 배포에서 401 이 될 요청을 초록으로 통과시키게 된다.
      if (request.headers().authorization === undefined) {
        return json(route, { error: { message: "unauthorized" } }, 401);
      }
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "content-disposition": "attachment" },
        body: PREVIEW_PNG,
      });
    }

    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        return json(
          route,
          row({
            id: "0199dddd-0000-7000-8000-0000000000f9",
            seq: 300,
            authorMemberId: memberId,
            body: body.body,
            createdAtMs: Date.now(),
            ...(Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0
              ? {
                  attachments: body.attachmentIds.map((id) => ({
                    id,
                    name: "drain-2026-08-09.log",
                    mime: "text/plain",
                    sizeBytes: 20480,
                  })),
                }
              : {}),
          }),
          201
        );
      }
      if (url.searchParams.has("after") || url.searchParams.has("before")) {
        return json(route, { messages: [] });
      }
      return json(route, { messages: page() });
    }

    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* preview 서버가 아직 뜨는 중 */
    }
    await wait(200);
  }
  throw new Error("attachment gate preview server never came up");
}

async function login(page_) {
  await page_.goto(origin, { waitUntil: "networkidle" });
  await page_.getByTestId("login-email").fill("attach@example.test");
  await page_.getByTestId("login-password").fill("gate-only");
  await page_.getByTestId("login-submit").click();
  await page_.getByTestId("channel-item").first().waitFor();
}

async function openChannel(page_) {
  await page_.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, channelA);
  await page_.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page_.waitForFunction(() => window.__attachGateSubscribed(), undefined, {
    timeout: 15_000,
  });
  await wait(400);
}

function fixturePath(name, contents) {
  const dir = resolve(webRoot, "artifacts/attachment-fixtures");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name);
  writeFileSync(file, contents);
  return file;
}

function fail(message) {
  console.error(`GATE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

// ---- 1~4. 컴포저의 네 칸 ----------------------------------------------------

async function exerciseComposer(browser) {
  const archive = createArchive();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page_ = await context.newPage();
  await installRealtimeSocket(page_);
  await installRoutes(context, archive);
  await login(page_);
  await openChannel(page_);

  // 첨부를 붙이기 전: 트레이는 서지 않는다 (6번의 절반).
  expect(
    (await page_.getByTestId("attachment-tray").count()) === 0,
    "첨부가 없는데 트레이가 서 있다"
  );

  const logFile = fixturePath(
    "drain-2026-08-09.log",
    "2026-08-09T09:10:00Z drain batch=1 lag=12ms\n".repeat(40)
  );
  await page_.locator('input[type="file"]').first().setInputFiles(logFile);

  // ① 업로드 중: 막대와 퍼센트가 있고, 전송은 막혀 있다.
  const chip = page_.getByTestId("attachment-chip").first();
  await chip.waitFor({ timeout: 10_000 });
  await page_.waitForFunction(
    () =>
      document.querySelector('[data-testid="attachment-chip"]')?.dataset
        .attachmentStatus === "uploading",
    undefined,
    { timeout: 10_000 }
  );
  expect(
    (await page_.getByTestId("attachment-chip-progress").count()) === 1,
    "업로드 중인데 진행 막대가 없다"
  );
  expect(
    (await chip.getByTestId("attachment-chip-status").innerText()) === COPY.uploading,
    `업로드 중 칩이 "${COPY.uploading}" 라고 말하지 않는다`
  );

  if (proveRedBlock) {
    await page_.evaluate(() => {
      document
        .querySelector('[data-testid="composer-send"]')
        ?.removeAttribute("disabled");
    });
  }
  expect(
    await page_.getByTestId("composer-send").isDisabled(),
    "바이트가 아직 가는 중인데 전송 버튼이 살아 있다"
  );
  const blocked = page_.getByTestId("attachment-blocked");
  expect(
    (await blocked.getAttribute("data-block-reason")) === "uploading",
    "막힌 이유가 화면에 없다"
  );
  expect(
    (await blocked.innerText()) === COPY.sendBlocked,
    "막힌 이유를 코어의 문장으로 말하지 않는다"
  );

  // ② 확인 중: 바이트는 다 갔고 서버는 아직 대조 중이다. **이 한 순간**이 이
  //    게이트의 무게중심이다.
  archive.releaseBytes();
  await page_.waitForFunction(
    () =>
      document.querySelector('[data-testid="attachment-chip"]')?.dataset
        .attachmentStatus === "verifying",
    undefined,
    { timeout: 10_000 }
  );
  if (proveRedHonesty) {
    await page_.evaluate((word) => {
      const node = document.querySelector('[data-testid="attachment-chip-status"]');
      if (node) node.textContent = word;
    }, COPY.uploaded);
  }
  const verifyingText = await chip.getByTestId("attachment-chip-status").innerText();
  expect(
    verifyingText === COPY.verifying,
    `바이트만 다 갔을 뿐인데 칩이 "${verifyingText}" 라고 말한다`
  );
  expect(
    (await page_.getByTestId("attachment-chip-progress").count()) === 0,
    "셈이 끝났는데 다 찬 막대가 남아 있다"
  );
  expect(
    await page_.getByTestId("composer-send").isDisabled(),
    "서버가 아직 확인 중인데 전송 버튼이 살아 있다"
  );

  // ③ 업로드 완료: 이제서야 끝이고, 전송이 열린다.
  archive.releaseComplete();
  await page_.waitForFunction(
    () =>
      document.querySelector('[data-testid="attachment-chip"]')?.dataset
        .attachmentStatus === "uploaded",
    undefined,
    { timeout: 10_000 }
  );
  expect(
    (await page_.getByTestId("attachment-blocked").count()) === 0,
    "다 올라갔는데 막힘 문장이 남아 있다"
  );
  expect(
    !(await page_.getByTestId("composer-send").isDisabled()),
    "본문 없이 파일만 있는데 전송이 열리지 않는다"
  );

  // ④ 보내면 트레이가 비고, 보낸 행이 자기 카드를 그린다.
  await page_.getByTestId("composer-send").click();
  await wait(600);
  expect(
    (await page_.getByTestId("attachment-tray").count()) === 0,
    "보낸 뒤에도 트레이가 남아 있다"
  );
  expect(
    (await page_.getByTestId("attachment-card").count()) >= 1,
    "보낸 메시지가 파일 카드를 그리지 않는다"
  );

  await context.close();
  console.log("[1~4] 네 칸이 다르고, 100%가 끝이 아니며, 막힐 때는 이유를 말한다");
}

// ---- 5. 실패와 재시도 -------------------------------------------------------

async function exerciseFailure(browser) {
  const archive = createArchive();
  archive.setCompleteStatus(409);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page_ = await context.newPage();
  await installRealtimeSocket(page_);
  await installRoutes(context, archive);
  await login(page_);
  await openChannel(page_);

  const logFile = fixturePath("mismatch.log", "one line\n");
  await page_.locator('input[type="file"]').first().setInputFiles(logFile);
  await page_.waitForFunction(
    () =>
      document.querySelector('[data-testid="attachment-chip"]')?.dataset
        .attachmentStatus === "uploading",
    undefined,
    { timeout: 10_000 }
  );
  archive.releaseBytes();
  archive.releaseComplete();
  await page_.waitForFunction(
    () =>
      document.querySelector('[data-testid="attachment-chip"]')?.dataset
        .attachmentStatus === "failed",
    undefined,
    { timeout: 10_000 }
  );

  const chip = page_.getByTestId("attachment-chip").first();
  expect(
    (await chip.getByTestId("attachment-chip-status").innerText()) === MISMATCH_COPY,
    "검증 불일치가 그 이유로 말해지지 않는다"
  );
  expect(
    (await chip.getByTestId("attachment-chip-retry").count()) === 1,
    "되돌릴 값이 있는 실패에 재시도가 없다"
  );
  expect(
    await page_.getByTestId("composer-send").isDisabled(),
    "실패한 첨부를 달고 전송이 열려 있다"
  );
  expect(
    (await page_.getByTestId("attachment-blocked").getAttribute("data-block-reason")) ===
      "failed",
    "실패로 막힌 이유가 화면에 없다"
  );

  // 상한을 넘긴 파일은 재시도가 없다 — 다시 눌러도 같은 답이 오는 컨트롤은
  // 고장 난 버튼이다.
  //
  // 100 MB 를 실제로 쓰지 않는다. `Blob.prototype.size` 의 getter 를 이 파일
  // 하나에만 덮어써서, 상한 판정이 도는 경로를 그대로 지나게 한다. `size` 는
  // `File` 이 아니라 `Blob` 의 속성이다.
  const huge = fixturePath("huge.bin", Buffer.alloc(1024));
  await page_.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(Blob.prototype, "size");
    if (original === undefined || original.get === undefined) {
      throw new Error("Blob.prototype.size 를 찾지 못했다");
    }
    Object.defineProperty(Blob.prototype, "size", {
      configurable: true,
      get() {
        return this.name === "huge.bin"
          ? 100 * 1024 * 1024 + 1
          : original.get.call(this);
      },
    });
  });
  await page_.locator('input[type="file"]').first().setInputFiles(huge);
  await page_.waitForFunction(
    () => document.querySelectorAll('[data-testid="attachment-chip"]').length === 2,
    undefined,
    { timeout: 10_000 }
  );
  const second = page_.getByTestId("attachment-chip").nth(1);
  expect(
    (await second.getByTestId("attachment-chip-status").innerText()) === TOO_LARGE_COPY,
    "상한을 넘긴 파일이 그 이유로 말해지지 않는다"
  );
  expect(
    (await second.getByTestId("attachment-chip-retry").count()) === 0,
    "다시 눌러도 같은 답이 올 실패에 재시도 버튼이 붙었다"
  );

  await context.close();
  console.log("[5] 실패가 이유를 말하고, 되돌릴 값이 있을 때만 재시도가 선다");
}

// ---- 6. 타임라인의 두 모양, 그리고 첨부 없는 경로 ---------------------------

async function exerciseTimeline(browser) {
  const archive = createArchive();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page_ = await context.newPage();
  await installRealtimeSocket(page_);
  await installRoutes(context, archive);
  await login(page_);
  await openChannel(page_);

  if (proveRedCard) {
    await page_.evaluate(() => {
      for (const node of document.querySelectorAll(
        '[data-testid="attachment-list"]'
      )) {
        node.remove();
      }
    });
  }

  const fileRow = page_.locator(
    `[data-testid="timeline-message"][data-message-id="${FILE_MSG.toLowerCase()}"]`
  );
  await fileRow.waitFor({ timeout: 10_000 });
  const card = fileRow.getByTestId("attachment-card");
  expect((await card.count()) === 1, "파일 첨부가 카드로 그려지지 않는다");
  const meta = await card.getByTestId("attachment-meta").innerText();
  expect(
    meta === "PLAIN · 20 KB",
    `카드가 타입과 크기를 말하지 않는다 (읽은 값: ${meta})`
  );
  expect(
    (await card.getByTestId("attachment-download").count()) === 1,
    "카드에 내려받기가 없다"
  );

  const imageRow = page_.locator(
    `[data-testid="timeline-message"][data-message-id="${IMAGE_MSG.toLowerCase()}"]`
  );
  await imageRow.waitFor({ timeout: 10_000 });
  const figure = imageRow.getByTestId("attachment-image");
  expect((await figure.count()) === 1, "이미지 첨부가 인라인으로 펴지지 않는다");
  await page_.waitForFunction(
    (id) => {
      const node = document.querySelector(
        `[data-testid="timeline-message"][data-message-id="${id}"] [data-testid="attachment-image"]`
      );
      return node?.getAttribute("data-preview") === "ready";
    },
    IMAGE_MSG.toLowerCase(),
    { timeout: 15_000 }
  );
  const src = await figure.locator("img").getAttribute("src");
  expect(
    typeof src === "string" && src.startsWith("data:image/"),
    "미리보기가 프록시 바이트에서 나지 않았다"
  );

  // **첨부 없는 경로 무회귀.** 파일을 한 번도 안 붙인 행에는 첨부 노드가 하나도
  // 없다. 이 단정이 없으면 「모든 행에 빈 컨테이너 하나」 같은 회귀가 조용히 산다.
  const plainRow = page_.locator(
    `[data-testid="timeline-message"][data-message-id="${PLAIN_MSG.toLowerCase()}"]`
  );
  await plainRow.waitFor({ timeout: 10_000 });
  expect(
    (await plainRow.getByTestId("attachment-list").count()) === 0,
    "첨부 없는 메시지가 첨부 컨테이너를 그린다"
  );

  // 그리고 첨부 없는 전송은 이전과 같은 요청이다: `attachmentIds` 키가 아예 없다.
  const sent = page_.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/messages")
  );
  await page_.getByTestId("composer-input").fill("첨부 없이 한 줄 보냅니다");
  await page_.getByTestId("composer-send").click();
  const body = JSON.parse((await sent).postData() ?? "{}");
  expect(
    !("attachmentIds" in body),
    "첨부 없는 전송이 attachmentIds 키를 실어 보낸다"
  );

  await context.close();
  console.log("[6] 두 모양이 서고, 첨부 없는 경로는 DOM도 요청도 그대로다");
}

// ---- 캡처 ------------------------------------------------------------------

async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/attachment");
  mkdirSync(outDir, { recursive: true });
  const logFile = fixturePath(
    "drain-2026-08-09.log",
    "2026-08-09T09:10:00Z drain batch=1 lag=12ms\n".repeat(40)
  );

  for (const scheme of ["light", "dark"]) {
    // 1) 업로드 중 · 2) 확인 중 — 같은 판에서 연속으로.
    {
      const archive = createArchive();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page_ = await context.newPage();
      await installRealtimeSocket(page_);
      await installRoutes(context, archive);
      await login(page_);
      await openChannel(page_);
      await page_.locator('input[type="file"]').first().setInputFiles(logFile);
      await page_.waitForFunction(
        () =>
          document.querySelector('[data-testid="attachment-chip"]')?.dataset
            .attachmentStatus === "uploading",
        undefined,
        { timeout: 10_000 }
      );
      await page_.mouse.move(0, 0);
      await wait(300);
      await page_.screenshot({ path: resolve(outDir, `uploading-${scheme}.png`) });

      archive.releaseBytes();
      await page_.waitForFunction(
        () =>
          document.querySelector('[data-testid="attachment-chip"]')?.dataset
            .attachmentStatus === "verifying",
        undefined,
        { timeout: 10_000 }
      );
      await wait(200);
      await page_.screenshot({ path: resolve(outDir, `verifying-${scheme}.png`) });

      archive.releaseComplete();
      await page_.waitForFunction(
        () =>
          document.querySelector('[data-testid="attachment-chip"]')?.dataset
            .attachmentStatus === "uploaded",
        undefined,
        { timeout: 10_000 }
      );
      await wait(200);
      await page_.screenshot({ path: resolve(outDir, `uploaded-${scheme}.png`) });
      await context.close();
    }

    // 3) 실패 + 재시도.
    {
      const archive = createArchive();
      archive.setCompleteStatus(409);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page_ = await context.newPage();
      await installRealtimeSocket(page_);
      await installRoutes(context, archive);
      await login(page_);
      await openChannel(page_);
      await page_.locator('input[type="file"]').first().setInputFiles(logFile);
      await page_.waitForFunction(
        () =>
          document.querySelector('[data-testid="attachment-chip"]')?.dataset
            .attachmentStatus === "uploading",
        undefined,
        { timeout: 10_000 }
      );
      archive.releaseBytes();
      archive.releaseComplete();
      await page_.waitForFunction(
        () =>
          document.querySelector('[data-testid="attachment-chip"]')?.dataset
            .attachmentStatus === "failed",
        undefined,
        { timeout: 10_000 }
      );
      await page_.mouse.move(0, 0);
      await wait(300);
      await page_.screenshot({ path: resolve(outDir, `failed-${scheme}.png`) });
      await context.close();
    }

    // 4) 타임라인: 이미지 인라인 + 파일 카드.
    {
      const archive = createArchive();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
        colorScheme: scheme,
      });
      const page_ = await context.newPage();
      await installRealtimeSocket(page_);
      await installRoutes(context, archive);
      await login(page_);
      await openChannel(page_);
      await page_.waitForFunction(
        (id) => {
          const node = document.querySelector(
            `[data-testid="timeline-message"][data-message-id="${id}"] [data-testid="attachment-image"]`
          );
          return node?.getAttribute("data-preview") === "ready";
        },
        IMAGE_MSG.toLowerCase(),
        { timeout: 15_000 }
      );
      await page_.mouse.move(0, 0);
      await wait(300);
      await page_.screenshot({ path: resolve(outDir, `timeline-${scheme}.png`) });
      await context.close();
    }
  }
  console.log(
    "[shots] artifacts/attachment/{uploading,verifying,uploaded,failed,timeline}-{light,dark}.png"
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      await exerciseComposer(browser);
      await exerciseFailure(browser);
      await exerciseTimeline(browser);
      if (process.env.ATTACH_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 네 칸이 화면에서 다르고, 바이트가 다 간 순간을 완료라고");
  console.log("           부르지 않았으며, 올라가는 중과 실패한 첨부는 전송을 막고");
  console.log("           이유를 말했고, 되돌릴 값이 있는 실패에만 재시도가 섰고,");
  console.log("           이미지는 펴지고 그 밖은 카드가 되었으며, 첨부 없는");
  console.log("           메시지의 DOM 과 요청은 이 티켓 이전과 같다.");
}

await main();
