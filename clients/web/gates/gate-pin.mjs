#!/usr/bin/env node
// GATE: 채팅 pin v0 (이슈 #1112).
//
// 이 게이트가 지키는 것은 고정이 그려지는지가 아니라 **고정 목록이 하는 말이
// 참인가**다.
//
//   1. 재조회 금지     헤더 목록은 채널당 한 번 읽고, 그 뒤로는 프레임만으로 산다.
//                      `message.pinned`가 도착해 목록이 늘어나도 `/pins` 요청은
//                      **한 건도 더 나가지 않는다**. 이것이 서버가 프레임에 목록
//                      항목 전체를 싣는 이유이고, 그 페이로드를 id로 줄이면 여기서
//                      깨진다.
//   2. 두 방향 대칭    `message.unpinned`는 항목을 지운다. 지워진 메시지는
//                      `message.deleted` **하나로** 목록에서 빠진다 — 서버가 pin
//                      행을 함께 쓸어내고 두 번째 프레임을 쏘지 않기 때문이다.
//   3. 낱말은 상태다   행 메뉴의 항목은 고정 여부에 따라 뒤집힌다(고정하기 ↔ 고정
//                      해제하기). 낱말은 코어 소스에서 읽는다 — 게이트가 문자열을
//                      다시 적으면 정본이 바뀌었을 때 게이트만 혼자 초록으로 남는다.
//   4. 클릭 = 점프     목록 항목을 누르면 **기존 앵커 기계**가 원본을 물들인다.
//                      고정 목록은 자기만의 항법을 만들지 않는다.
//   5. 거절은 그 자리   상한 초과(409)는 그 행 안의 문장이다. 토스트가 아니고,
//                      서버의 영어 문장도 아니며, 숫자와 다음 행동을 말한다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   PIN_GATE_PROVE_RED_REFETCH=1 npm run gate:pin
//     expected failure: "the header list reached the network again"
//   PIN_GATE_PROVE_RED_LIVE=1 npm run gate:pin
//     expected failure: "a live pin never reached the header list"
//   PIN_GATE_PROVE_RED_LABEL=1 npm run gate:pin
//     expected failure: "the pin action did not flip with the state"
//   PIN_GATE_PROVE_RED_CAP=1 npm run gate:pin
//     expected failure: "the channel cap refusal was never stated in the row"
//
// red seam은 **목/드라이버의 행동만** 바꾼다. REFETCH는 페이지에서 `/pins`를 직접
// 한 번 더 부르고(카운터 단언이 네트워크를 실제로 보고 있음을 증명), LIVE는
// 프레임에서 `pinned_at_ms`를 빼고(목록이 프레임에서 산다는 것을 증명), LABEL은
// DOM에서 항목의 글자를 갈아치우고, CAP은 목이 409 대신 200을 돌려준다. 제품 소스
// 줄을 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 고정 액션의 두 낱말. 코어 소스에서 읽는다 (gate-quote가 `QUOTE_ACTION_LABEL`에
 * 대해 하는 것과 같은 규율이고 같은 이유다). `import`가 아니라 정규식인 이유도
 * 같다: 이 게이트는 node가 직접 도는 `.mjs`이고, 코어의 `.ts` 한 줄을 읽자고 TS
 * 로더를 끌어오는 것은 값에 비해 비싸다.
 */
function canonicalPinCopy(root) {
  const pins = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/pins.ts"),
    "utf8"
  );
  const labels = /return pinned \? "([^"]+)" : "([^"]+)";/.exec(pins);
  if (!labels) {
    throw new Error(
      "pinActionLabel의 낱말을 코어에서 찾지 못했다: 게이트가 검사할 문자열의 정본이 사라졌다"
    );
  }
  const copy = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/actionCopy.ts"),
    "utf8"
  );
  const conflict =
    /export function pinFailureMessage[\s\S]*?case 409:\s*\n\s*return "([^"]+)";/.exec(
      copy
    );
  if (!conflict) {
    throw new Error("pinFailureMessage의 409 문장을 코어에서 찾지 못했다");
  }
  return { unpin: labels[1], pin: labels[2], capSentence: conflict[1] };
}

const port = Number(process.env.PIN_GATE_PORT || 5197);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";

const { unpin: UNPIN_LABEL, pin: PIN_LABEL, capSentence: CAP_SENTENCE } =
  canonicalPinCopy(webRoot);

const proveRedRefetch = process.env.PIN_GATE_PROVE_RED_REFETCH === "1";
const proveRedLive = process.env.PIN_GATE_PROVE_RED_LIVE === "1";
const proveRedLabel = process.env.PIN_GATE_PROVE_RED_LABEL === "1";
const proveRedCap = process.env.PIN_GATE_PROVE_RED_CAP === "1";

// 행 id는 소문자다 — 행이 `data-message-id`를 소문자로 내놓는다.
const COLD_PINNED_MSG = "0199bbbb-0000-7000-8000-0000000000c1";
const LIVE_PINNED_MSG = "0199bbbb-0000-7000-8000-0000000000c2";
const PLAIN_MSG = "0199bbbb-0000-7000-8000-0000000000c3";
const CAPPED_MSG = "0199bbbb-0000-7000-8000-0000000000c4";

const COLD_BODY = "배포 순서는 이 문서가 정본입니다. 롤백까지 여기 있습니다.";
const LIVE_BODY = "온콜 교대는 매주 화요일 10시입니다.";
const PLAIN_BODY = "확인했습니다.";
const CAPPED_BODY = "이 채널은 고정이 꽉 찼습니다.";

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
  realtimeWebSocketUrl: "ws://pin-gate.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelId],
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
  {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    muted: false,
  },
];

const AT = 1_785_238_400_000;

function row(over) {
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    ...over,
    hlcTs: over.hlcTs ?? AT + over.seq * 1_000,
    createdAtMs: over.createdAtMs ?? AT + over.seq * 1_000,
  };
}

function historyPage() {
  return [
    row({
      id: COLD_PINNED_MSG,
      seq: 41,
      authorMemberId: memberId,
      body: COLD_BODY,
    }),
    row({ id: LIVE_PINNED_MSG, seq: 42, authorMemberId: peerId, body: LIVE_BODY }),
    row({ id: PLAIN_MSG, seq: 43, authorMemberId: memberId, body: PLAIN_BODY }),
    row({ id: CAPPED_MSG, seq: 44, authorMemberId: memberId, body: CAPPED_BODY }),
  ];
}

/** 서버 `PinnedMessageDto` 그대로 (camelCase, 소문자 id). */
function pinEntry(messageId, seq, authorMemberId, body, pinnedAtMs) {
  return {
    messageId,
    channelId,
    seq,
    authorMemberId,
    type: "text",
    state: "sent",
    body,
    createdAtMs: AT + seq * 1_000,
    pinnedBy: memberId,
    pinnedAtMs,
  };
}

/** 브로드캐스트 페이로드 (snake_case, 소문자 id) — `momo.message.pinned`. */
function pinnedFrame(entry) {
  const payload = {
    message_id: entry.messageId,
    channel_id: entry.channelId,
    seq: entry.seq,
    author_member_id: entry.authorMemberId,
    type: entry.type,
    state: entry.state,
    body: entry.body,
    created_at_ms: entry.createdAtMs,
    pinned_by: entry.pinnedBy,
    pinned_at_ms: entry.pinnedAtMs,
  };
  // red seam: 목록이 프레임에서 산다는 것을 증명한다. 서버는 이 키를 빼지 않고,
  // 코어의 `asPinFrame`은 빠진 프레임을 통째로 버린다 — 반쯤 그린 행은 다음 콜드
  // 로드까지 아무도 고치지 못하기 때문이다.
  if (proveRedLive) delete payload.pinned_at_ms;
  return {
    type: "message.pinned",
    v: 1,
    ts: entry.pinnedAtMs,
    seq: entry.seq,
    payload,
  };
}

function unpinnedFrame(messageId, seq) {
  return {
    type: "message.unpinned",
    v: 1,
    ts: AT + 900_000,
    seq,
    payload: { message_id: messageId, channel_id: channelId },
  };
}

function deletedFrame(messageId, seq) {
  return {
    type: "message.deleted",
    v: 1,
    ts: AT + 950_000,
    seq,
    payload: { message_id: messageId },
  };
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
              connect: { client: "pin-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: true`. false면 useTimeline이 `?after=` 백필을 돌고,
                // 「요청이 더 나가지 않는다」를 재는 창을 그 루프가 흔든다.
                recovered: true,
                epoch: "pin-gate",
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

    window.__pinGateChannelSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    // 고정 프레임은 메시지 레일을 그대로 탄다 — 자기 채널을 만들지 않는다.
    window.__pinGatePublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("ch:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: frame, offset } },
              }),
            })
          );
        }
      }
    };
  });
}

/**
 * 관측한 네트워크. 「목록을 다시 읽지 않는다」는 이 카운터로만 증명할 수 있다 —
 * 코드를 읽어서 하는 약속은 다음 리팩터에서 사라진다.
 */
function makeTraffic() {
  return { pinReads: [], pinWrites: [], allUrls: [] };
}

async function installRoutes(context, traffic) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    traffic.allUrls.push(`${method} ${path}${url.search}`);

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

    // pin 쓰기. 상한이 찬 메시지만 409로 거절한다 — 서버의 영어 문장 그대로,
    // 그것이 화면에 닿지 않는다는 것이 단언 5의 절반이다.
    if (path.endsWith("/pin")) {
      traffic.pinWrites.push(`${method} ${path}`);
      const target = path.split("/").at(-2) ?? "";
      if (method === "PUT" && target === CAPPED_MSG && !proveRedCap) {
        return json(
          route,
          { error: { code: "conflict", message: "channel pin limit reached" } },
          409
        );
      }
      if (method === "PUT") {
        return json(route, {
          action: "pinned",
          messageId: target,
          channelId,
          changed: true,
          pinned: pinEntry(
            target,
            44,
            memberId,
            CAPPED_BODY,
            AT + 800_000
          ),
        });
      }
      return json(route, {
        action: "unpinned",
        messageId: target,
        channelId,
        changed: true,
      });
    }

    if (path.endsWith("/pins")) {
      traffic.pinReads.push(`${method} ${path}`);
      return json(route, {
        pins: [
          pinEntry(COLD_PINNED_MSG, 41, memberId, COLD_BODY, AT + 700_000),
        ],
      });
    }

    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });

    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, { messages: historyPage() });
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
  throw new Error("pin gate preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("pin@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__pinGateChannelSubscribed(), undefined, {
    timeout: 15_000,
  });
  await page
    .locator(`[data-testid="timeline-message"][data-message-id="${COLD_PINNED_MSG}"]`)
    .waitFor();
}

function rowLocator(page, messageId) {
  return page.locator(
    `[data-testid="timeline-message"][data-message-id="${messageId}"]`
  );
}

async function openRowMenu(page, messageId) {
  const target = rowLocator(page, messageId);
  await target.hover();
  await target.getByTestId("message-actions-trigger").click();
  await page.getByTestId("message-action-menu").waitFor();
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("message-action-menu").waitFor({ state: "detached" });
}

async function openPinList(page) {
  await page.getByTestId("open-pin-list").click();
  await page.getByTestId("pin-list").waitFor();
}

async function closePinList(page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("pin-list").waitFor({ state: "detached" });
}

async function listedIds(page) {
  return page.getByTestId("pin-list-item").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-message-id"))
  );
}

async function exercise(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic);
  await login(page);

  // ---- 1. 콜드 로드: 채널당 한 번 --------------------------------------------
  await page.getByTestId("open-pin-list").waitFor();
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `the header list must be read exactly once per channel, saw ${traffic.pinReads.length}: ${traffic.pinReads.join(", ")}`
    );
  }
  await openPinList(page);
  if ((await listedIds(page)).join() !== COLD_PINNED_MSG) {
    throw new Error(
      `the cold list did not carry the server's entry, read ${(await listedIds(page)).join(", ")}`
    );
  }
  const coldText = (await page.getByTestId("pin-list").textContent()) ?? "";
  if (!coldText.includes("배포 순서는")) {
    throw new Error(
      `the list entry must carry the message the server projected, read "${coldText}"`
    );
  }
  if (!coldText.includes("곽성재")) {
    throw new Error(`the list entry must name its author, read "${coldText}"`);
  }
  await closePinList(page);

  // ---- 2. 재조회 금지: 프레임만으로 자란다 ------------------------------------
  if (proveRedRefetch) {
    // red seam: 페이지에서 목록을 한 번 더 부른다. 아래 카운터가 네트워크를 실제로
    // 보고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate(
      ({ ws, ch }) =>
        fetch(`/v1/workspaces/${ws}/channels/${ch}/pins`).catch(() => {}),
      { ws: workspaceId, ch: channelId }
    );
    await wait(300);
  }
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    pinnedFrame(
      pinEntry(LIVE_PINNED_MSG, 42, peerId, LIVE_BODY, AT + 750_000)
    )
  );
  await wait(300);
  await openPinList(page);
  const afterLive = await listedIds(page);
  if (!afterLive.includes(LIVE_PINNED_MSG)) {
    throw new Error(
      `a live pin never reached the header list, read ${afterLive.join(", ")}`
    );
  }
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `the header list reached the network again — the frame must carry the whole entry (${traffic.pinReads.length} reads: ${traffic.pinReads.join(", ")})`
    );
  }
  // 최근 고정이 위다. 도착 순서가 아니라 `pinnedAtMs`가 줄을 세운다.
  if (afterLive[0] !== LIVE_PINNED_MSG) {
    throw new Error(
      `the list must lead with the newest pin, read ${afterLive.join(", ")}`
    );
  }
  await closePinList(page);

  // ---- 3. 낱말은 상태다 -------------------------------------------------------
  await openRowMenu(page, PLAIN_MSG);
  const plainLabel =
    (await page.getByTestId("menu-pin").textContent())?.trim() ?? "";
  if (plainLabel !== PIN_LABEL) {
    throw new Error(
      `an unpinned row must offer "${PIN_LABEL}", read "${plainLabel}"`
    );
  }
  await closeAnyMenu(page);

  await openRowMenu(page, COLD_PINNED_MSG);
  if (proveRedLabel) {
    // red seam: DOM에서 글자를 갈아치운다. 아래 단언이 DOM을 읽고 있다면 깨진다.
    await page.evaluate((text) => {
      const node = document.querySelector('[data-testid="menu-pin"]');
      if (node) node.textContent = text;
    }, PIN_LABEL);
  }
  const pinnedLabel =
    (await page.getByTestId("menu-pin").textContent())?.trim() ?? "";
  if (pinnedLabel !== UNPIN_LABEL) {
    throw new Error(
      `the pin action did not flip with the state: a pinned row must offer "${UNPIN_LABEL}", read "${pinnedLabel}"`
    );
  }
  await closeAnyMenu(page);

  // ---- 4. 두 방향 대칭: unpin 프레임과 tombstone -------------------------------
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    unpinnedFrame(LIVE_PINNED_MSG, 42)
  );
  await wait(200);
  await openPinList(page);
  if ((await listedIds(page)).includes(LIVE_PINNED_MSG)) {
    throw new Error("message.unpinned did not take the entry off the list");
  }
  await closePinList(page);

  // 지워진 메시지는 프레임 **하나로** 목록에서 빠진다: 서버는 pin 행을 함께
  // 쓸어내고 두 번째 프레임을 쏘지 않는다.
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    deletedFrame(COLD_PINNED_MSG, 41)
  );
  await wait(200);
  await openPinList(page);
  if ((await listedIds(page)).length !== 0) {
    throw new Error(
      "a deleted message must leave the pin list on message.deleted alone — the server publishes no second frame for it"
    );
  }
  await page.getByTestId("pin-list-empty").waitFor();
  if (traffic.pinReads.length !== 1) {
    throw new Error(
      `nothing above may re-read the list (${traffic.pinReads.length} reads)`
    );
  }
  await closePinList(page);

  // ---- 5. 클릭 = 원본 점프 ----------------------------------------------------
  // 목록을 다시 채우고, 항목을 눌러 기존 앵커 기계가 원본을 물들이는지 본다.
  await page.evaluate(
    (frame) => window.__pinGatePublish(frame),
    pinnedFrame(pinEntry(PLAIN_MSG, 43, memberId, PLAIN_BODY, AT + 760_000))
  );
  await wait(200);
  await openPinList(page);
  await page
    .locator(`[data-testid="pin-list-item"][data-message-id="${PLAIN_MSG}"]`)
    .click();
  await page.waitForFunction(
    (id) => {
      const article = document.querySelector(
        `[data-testid="timeline-message"][data-message-id="${id}"]`
      );
      return article?.classList.contains("bg-accent-soft") === true;
    },
    PLAIN_MSG,
    { timeout: 5_000 }
  );
  if (await page.getByTestId("chat-anchor-missed").isVisible()) {
    throw new Error(
      "the jump landed but the shell still said it had not — the pin list must reuse the anchor machinery, not a second one"
    );
  }

  // ---- 6. 상한 거절은 그 행 안의 문장 -----------------------------------------
  await openRowMenu(page, CAPPED_MSG);
  await page.getByTestId("menu-pin").click();
  const capped = rowLocator(page, CAPPED_MSG);
  const banner = capped.getByTestId("message-action-error");
  try {
    await banner.waitFor({ timeout: 5_000 });
  } catch {
    throw new Error(
      "the channel cap refusal was never stated in the row (a 409 must land where the click was, not in a toast)"
    );
  }
  const bannerText = (await banner.textContent()) ?? "";
  if (!bannerText.includes(CAP_SENTENCE)) {
    throw new Error(
      `the row must say the core's sentence, read "${bannerText}"`
    );
  }
  if (bannerText.includes("channel pin limit reached")) {
    throw new Error("the server's wire sentence reached the screen");
  }
  if (!bannerText.includes("100")) {
    throw new Error(
      `the refusal must name the number or it reads as a bug, read "${bannerText}"`
    );
  }

  // ---- 7. 헤더 버튼은 하나의 이름을 갖는다 ------------------------------------
  const trigger = page.getByTestId("open-pin-list");
  const [ariaLabel, title] = await Promise.all([
    trigger.getAttribute("aria-label"),
    trigger.getAttribute("title"),
  ]);
  if (!ariaLabel || ariaLabel !== title) {
    throw new Error(
      `two names for one control is two controls to a reader: aria-label "${ariaLabel}" vs title "${title}"`
    );
  }

  await context.close();
}

/** 리뷰용 스크린샷. 판정하지 않는다 — 사람이 보는 자리다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/pin");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const traffic = makeTraffic();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, traffic);
    await login(page);
    await page.evaluate(
      (frame) => window.__pinGatePublish(frame),
      pinnedFrame(
        pinEntry(LIVE_PINNED_MSG, 42, peerId, LIVE_BODY, AT + 750_000)
      )
    );
    await wait(300);
    await openPinList(page);
    await page.screenshot({ path: resolve(outDir, `pin-list-${scheme}.png`) });
    await page
      .getByTestId("pin-list")
      .screenshot({ path: resolve(outDir, `pin-list-detail-${scheme}.png`) });
    await closePinList(page);
    await openRowMenu(page, COLD_PINNED_MSG);
    await page.screenshot({ path: resolve(outDir, `pin-menu-${scheme}.png`) });
    await context.close();
  }
  console.log("[shots] artifacts/pin/pin-{list,menu}-{light,dark}.png");
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
      await exercise(browser);
      if (process.env.PIN_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 고정 목록은 채널당 한 번 읽고 프레임만으로 살았고,");
  console.log("           unpin·tombstone 양쪽에서 빠졌고, 행 메뉴의 낱말은");
  console.log("           상태를 따라 뒤집혔고, 클릭은 기존 앵커로 원본에");
  console.log("           착지했고, 상한 거절은 그 행 안의 우리 문장이었다.");
}

await main();
