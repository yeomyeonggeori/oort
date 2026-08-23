#!/usr/bin/env node
// GATE: B3 W1 「인용 답글」 (결정 정본 ADR-0148, 패킷 2026-08-05-B3).
//
// 이 게이트가 지키는 것은 인용이 그려지는지가 아니라 **인용이 하는 말이 참인가**다.
//
//   1. 재조회 금지     인용 블록은 페이지가 동봉한 값으로 그려진다. 타임라인이
//                      가라앉은 뒤 인용을 읽고·누르고·스크롤해도 `/messages`
//                      요청이 **한 건도 더 나가지 않는다**. 인용 대상의 id가 어떤
//                      요청 URL에도 등장하지 않는다(N+1이 시작되는 자리다).
//   2. 삭제 정직       원본이 지워졌으면 「삭제된 메시지」이고, 원문 글자는 화면
//                      어디에도 없다. 사본을 남기지 않는 것이 삭제의 뜻이다(규칙 3).
//   3. 라이브 인용     `message.new`에는 원문이 실리지 않는다(규칙 3). 프레임의
//                      `reply_to_id`로 **이미 로드된 행**에서 풀어 그린다.
//   4. 전송 바인딩     칩을 걸고 보내면 POST 바디에 `replyToId`가 실린다. 취소하면
//                      실리지 않는다 — 취소는 버튼과 Esc 둘 다.
//   5. 두 장치 분리    답글(스레드)과 인용이 같은 메뉴에 **다른 말·다른 자리**로
//                      있다: 인용 블록은 본문 **위**, 「답글 N개」는 본문 **아래**.
//                      한 행에 인용 블록은 하나뿐이다(규칙 4 — 계단 금지).
//   6. 긴 출력         에이전트의 구조화 출력을 인용하면 종류만 말한다. 그 카드의
//                      페이로드는 인용 블록에 오지 않는다(미결 2 · SKILL §9).
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   QUOTE_GATE_PROVE_RED_REFETCH=1 npm run gate:quote
//     expected failure: "resolving a quote reached the network"
//   QUOTE_GATE_PROVE_RED_DELETED=1 npm run gate:quote
//     expected failure: "a deleted original's text reached the screen"
//   QUOTE_GATE_PROVE_RED_LIVE=1 npm run gate:quote
//     expected failure: "a live quote reply drew no quote block"
//   QUOTE_GATE_PROVE_RED_BINDING=1 npm run gate:quote
//     expected failure: "the send carried no replyToId"
//   QUOTE_GATE_PROVE_RED_PLACE=1 npm run gate:quote
//     expected failure: "the quote block did not sit above the body"
//   QUOTE_GATE_PROVE_RED_ACCENT=1 npm run gate:quote
//     expected failure: "the quote rail is wearing the accent"
//
// red seam은 **목/드라이버의 행동만** 바꾼다. REFETCH는 페이지에서 인용 대상 하나를
// 직접 fetch하고(카운터 단언이 네트워크를 실제로 보고 있음을 증명), DELETED는 목이
// tombstone에 본문을 실어 `state`를 살아 있는 값으로 보내고("원문은 화면에 없다"가
// DOM을 읽고 있음을 증명), LIVE는 프레임에서 `reply_to_id`를 빼고, BINDING은 보내기
// 전에 인용을 취소하고, PLACE는 DOM에서 블록을 본문 아래로 옮기고, ACCENT는 레일을
// 앰버로 칠한다. 제품 소스 줄을
// 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 인용 액션의 낱말. **코어 소스에서 읽는다** — 게이트가 문자열을 다시 적으면 정본이
 * 바뀌었을 때 게이트만 혼자 초록으로 남는다(「인용하기」 → 「인용해서 답하기」 교체가
 * 정확히 그 사고를 만들 수 있었다).
 *
 * `import`가 아니라 정규식인 이유: 이 게이트는 node가 직접 도는 `.mjs`이고, 코어의
 * `.ts`를 import하면 그 파일이 다시 import하는 확장자 없는 경로들을 node가 풀지
 * 못한다. 상수 한 줄을 읽는 데 TS 로더를 끌어오는 것은 값에 비해 비싸다.
 */
function canonicalActionLabel(root) {
  const source = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/timeline/quote.ts"),
    "utf8"
  );
  const match = /export const QUOTE_ACTION_LABEL = "([^"]+)"/.exec(source);
  if (!match) {
    throw new Error(
      "QUOTE_ACTION_LABEL을 코어에서 찾지 못했다: 게이트가 검사할 낱말의 정본이 사라졌다"
    );
  }
  return match[1];
}
const port = Number(process.env.QUOTE_GATE_PORT || 5191);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";
const dmChannelId = "00000000-0000-7000-8000-000000000202";

const QUOTE_ACTION_LABEL = canonicalActionLabel(webRoot);

const proveRedRefetch = process.env.QUOTE_GATE_PROVE_RED_REFETCH === "1";
const proveRedDeleted = process.env.QUOTE_GATE_PROVE_RED_DELETED === "1";
const proveRedLive = process.env.QUOTE_GATE_PROVE_RED_LIVE === "1";
const proveRedBinding = process.env.QUOTE_GATE_PROVE_RED_BINDING === "1";
const proveRedPlace = process.env.QUOTE_GATE_PROVE_RED_PLACE === "1";
const proveRedAccent = process.env.QUOTE_GATE_PROVE_RED_ACCENT === "1";

// 인용 대상들. id는 소문자다 — 행이 `data-message-id`를 소문자로 내놓는다.
const ORIGIN_MSG = "0199aaaa-0000-7000-8000-0000000000a1";
const QUOTING_MSG = "0199aaaa-0000-7000-8000-0000000000a2";
const DELETED_MSG = "0199aaaa-0000-7000-8000-0000000000a3";
const QUOTES_DELETED_MSG = "0199aaaa-0000-7000-8000-0000000000a4";
const DIFF_MSG = "0199aaaa-0000-7000-8000-0000000000a5";
const QUOTES_DIFF_MSG = "0199aaaa-0000-7000-8000-0000000000a6";
const QUOTES_QUOTE_MSG = "0199aaaa-0000-7000-8000-0000000000a7";
const LIVE_QUOTING_MSG = "0199aaaa-0000-7000-8000-0000000000a8";

const ORIGIN_BODY = "배포 되돌리기 절차부터 확인해 줘. **롤백 스크립트**가 최신인지도.";
const DELETED_BODY_MARKER = "이 문장은 지워졌으므로 화면에 있을 수 없다";
const DIFF_PAYLOAD_MARKER = "infra/prod/Caddyfile";
const LIVE_BODY = "그 절차 먼저 확인했습니다.";
const SENT_BODY = "인용해서 답합니다.";

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
  realtimeWebSocketUrl: "ws://quote-gate.invalid/connection/websocket",
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
  member({
    id: peerId,
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  }),
  member({
    id: agentId,
    kind: "agent",
    displayName: "김인턴",
    handle: "kim-intern",
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
  }),
];

const channels = [
  { id: channelId, workspaceId, kind: "public", name: "release-2026-08", muted: false },
  {
    id: dmChannelId,
    workspaceId,
    kind: "dm",
    dmKey: `${memberId}:${peerId}`,
    memberIds: [memberId, peerId],
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

/** 목이 돌려주는 히스토리 한 페이지. 서버가 LEFT JOIN으로 동봉하는 그 형상이다. */
function historyPage() {
  return [
    // 원본. 답글 롤업을 달아 둔다 — 「답글 N개」가 본문 **아래**에 있고 인용 블록이
    // 본문 **위**에 있다는 것이 두 장치를 화면에서 가르는 첫 축이라, 같은 행에서
    // 둘을 재려면 롤업이 필요하다.
    row({
      id: ORIGIN_MSG,
      seq: 41,
      authorMemberId: memberId,
      body: ORIGIN_BODY,
      thread: { reply_count: 2, last_reply_seq: 43, last_reply_at: AT + 60_000 },
    }),
    // 살아 있는 원본을 인용한 답. `replyTo`가 페이지에 동봉돼 온다.
    row({
      id: QUOTING_MSG,
      seq: 42,
      authorMemberId: peerId,
      body: "롤백 스크립트는 어제 갱신했습니다.",
      replyToId: ORIGIN_MSG,
      replyTo: {
        id: ORIGIN_MSG,
        seq: 41,
        authorMemberId: memberId,
        type: "text",
        body: ORIGIN_BODY,
        state: "sent",
      },
    }),
    // 지워진 원본. 서버는 본문을 빼고 tombstone으로 준다.
    row({
      id: DELETED_MSG,
      seq: 43,
      authorMemberId: peerId,
      state: "deleted",
      deletedAtMs: AT + 50_000,
    }),
    row({
      id: QUOTES_DELETED_MSG,
      seq: 44,
      authorMemberId: memberId,
      body: "지워진 글을 가리키는 답입니다.",
      replyToId: DELETED_MSG,
      replyTo: proveRedDeleted
        ? // red seam: 목이 tombstone에 본문을 실어 살아 있는 상태로 보낸다. 서버는
          // 이런 응답을 만들지 않는다 — 「원문은 화면 어디에도 없다」 단언이 DOM을
          // 읽고 있음을 증명하기 위한 드라이버 행동이다.
          {
            id: DELETED_MSG,
            seq: 43,
            authorMemberId: peerId,
            type: "text",
            body: DELETED_BODY_MARKER,
            state: "sent",
          }
        : {
            id: DELETED_MSG,
            seq: 43,
            authorMemberId: peerId,
            type: "text",
            state: "deleted",
            deletedAtMs: AT + 50_000,
          },
    }),
    // 에이전트의 구조화 출력과 그것을 인용한 답 (미결 2).
    row({
      id: DIFF_MSG,
      seq: 45,
      authorMemberId: agentId,
      type: "diff",
      body: `--- a/${DIFF_PAYLOAD_MARKER}\n+++ b/${DIFF_PAYLOAD_MARKER}\n@@ -1 +1 @@`,
    }),
    row({
      id: QUOTES_DIFF_MSG,
      seq: 46,
      authorMemberId: memberId,
      body: "이 변경은 이번 배포에 넣지 말아 주세요.",
      replyToId: DIFF_MSG,
      replyTo: {
        id: DIFF_MSG,
        seq: 45,
        authorMemberId: agentId,
        type: "diff",
        body: `--- a/${DIFF_PAYLOAD_MARKER}\n+++ b/${DIFF_PAYLOAD_MARKER}`,
        state: "sent",
      },
    }),
    // 인용의 인용 (규칙 4). 서버는 안쪽 대상의 id를 주지 않고 표시만 준다.
    row({
      id: QUOTES_QUOTE_MSG,
      seq: 47,
      authorMemberId: peerId,
      body: "그 답에 한 줄 더 붙입니다.",
      replyToId: QUOTING_MSG,
      replyTo: {
        id: QUOTING_MSG,
        seq: 42,
        authorMemberId: peerId,
        type: "text",
        body: "롤백 스크립트는 어제 갱신했습니다.",
        state: "sent",
        quotesAnother: true,
      },
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
              connect: { client: "quote-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                // `recovered: true`. false면 useTimeline이 `?after=` 백필을 돌고,
                // 이 게이트의 첫 단언이 「가라앉은 뒤 요청 0건」이라 그 루프가 측정
                // 창을 흔든다. 복구된 재구독은 백필을 돌지 않는다.
                recovered: true,
                epoch: "quote-gate",
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

    window.__quoteGateChannelSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    // `ch:` 네임스페이스에만 흘린다. 인용 답글은 일반 메시지이므로 메시지 레일을
    // 그대로 탄다 (인용은 새 채널을 만들지 않는다).
    window.__quoteGatePublish = (frame) => {
      offset += 1;
      const stamped = { ...frame, ts: frame.ts ?? Date.now() };
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith("ch:")) continue;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: stamped, offset } },
              }),
            })
          );
        }
      }
    };
  });
}

/**
 * 관측한 네트워크. 「인용을 풀려고 서버를 다시 때리지 않는다」는 이 카운터로만
 * 증명할 수 있다 — 코드를 읽어서 하는 약속은 다음 리팩터에서 사라진다.
 */
function makeTraffic() {
  return { messageRequests: [], allUrls: [], sends: [] };
}

async function installRoutes(context, traffic) {
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    traffic.allUrls.push(`${request.method()} ${path}${url.search}`);

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
    if (path.endsWith("/reactions")) return json(route, { reactions: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });

    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        traffic.sends.push(body);
        // 전송 응답은 서버가 그러는 대로 `replyToId`만 싣고 `replyTo`는 싣지 않는다.
        return json(
          route,
          row({
            id: "0199aaaa-0000-7000-8000-0000000000b1",
            seq: 48,
            authorMemberId: memberId,
            body: body.body,
            ...(body.replyToId === undefined
              ? {}
              : { replyToId: body.replyToId }),
          })
        );
      }
      traffic.messageRequests.push(`${path}${url.search}`);
      // `?after=`는 빈 페이지로 끝낸다: 백필 루프가 측정 창 안에서 계속 돌면
      // 「요청이 더 나가지 않는다」를 잴 수 없다.
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, { messages: historyPage() });
    }

    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("quote@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(() => window.__quoteGateChannelSubscribed(), undefined, {
    timeout: 15_000,
  });
  await page
    .locator(`[data-testid="timeline-message"][data-message-id="${QUOTING_MSG}"]`)
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

async function exercise(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic);
  await login(page);

  // ---- 1. 렌더: 페이지가 동봉한 값으로 그린다 --------------------------------
  const quoting = rowLocator(page, QUOTING_MSG);
  const block = quoting.getByTestId("quote-block");
  await block.waitFor();
  const blockText = (await block.textContent()) ?? "";
  if (!blockText.includes("배포 되돌리기 절차부터")) {
    throw new Error(
      `the quote block did not carry the original's text, read "${blockText}"`
    );
  }
  if (!blockText.includes("곽성재")) {
    throw new Error(
      `the quote block did not name the quoted author, read "${blockText}"`
    );
  }
  if ((await block.getAttribute("data-kind")) !== "ready") {
    throw new Error("a live original must resolve as a ready quote");
  }

  // ---- 2. 자리: 인용은 본문 위, 「답글 N개」는 본문 아래 -----------------------
  if (proveRedPlace) {
    // red seam: DOM에서 블록을 본문 뒤로 옮긴다. 아래 순서 단언이 DOM을 읽고
    // 있다면 반드시 깨진다. 제품 소스는 그대로다.
    await page.evaluate((id) => {
      const article = document.querySelector(
        `[data-testid="timeline-message"][data-message-id="${id}"]`
      );
      const node = article?.querySelector('[data-testid="quote-block"]');
      const body = article?.querySelector("[data-row-body]");
      if (node && body) body.append(node);
    }, QUOTING_MSG);
  }
  const placement = await page.evaluate(
    ({ quotingId, quotingBody, originId, originBody }) => {
      // 본문에는 자기 testid가 없다(마크다운 렌더러가 그린다). 그래서 위치는
      // **그 메시지가 실제로 쓴 문장**으로 찾는다 - 인용 블록에는 원본의 글이
      // 들어 있으므로 「글이 있는 첫 블록」으로는 둘을 구분할 수 없다.
      const read = (id, needle) => {
        const article = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"]`
        );
        if (!article) return null;
        const box = article.querySelector("[data-row-body]");
        if (!box) return null;
        const children = Array.from(box.children);
        const indexOf = (selector) =>
          children.findIndex(
            (child) => child.matches(selector) || child.querySelector(selector)
          );
        return {
          quote: indexOf('[data-testid="quote-block"]'),
          meta: indexOf('[data-testid="message-meta"]'),
          body: children.findIndex(
            (child) =>
              !child.matches('[data-testid="quote-block"]') &&
              child.querySelector('[data-testid="quote-block"]') === null &&
              (child.textContent ?? "").includes(needle)
          ),
        };
      };
      return {
        quoting: read(quotingId, quotingBody),
        origin: read(originId, originBody),
      };
    },
    {
      quotingId: QUOTING_MSG,
      quotingBody: "롤백 스크립트는 어제 갱신했습니다.",
      originId: ORIGIN_MSG,
      originBody: "배포 되돌리기 절차부터",
    }
  );
  if (placement.quoting === null || placement.quoting.quote < 0) {
    throw new Error("the quote block is not inside the row body box");
  }
  if (placement.quoting.body < 0) {
    throw new Error("could not find the quoting row's own body to measure against");
  }
  if (placement.quoting.quote > placement.quoting.body) {
    throw new Error(
      `the quote block did not sit above the body (quote at ${placement.quoting.quote}, body at ${placement.quoting.body})`
    );
  }
  if (placement.origin === null || placement.origin.meta <= placement.origin.body) {
    throw new Error(
      "the thread rollup must stay BELOW the body: the two devices are told apart by where they sit"
    );
  }
  // 한 행에 인용 블록은 하나뿐이다 (규칙 4 — 두 번째 겹은 표시뿐).
  const nested = rowLocator(page, QUOTES_QUOTE_MSG);
  if ((await nested.getByTestId("quote-block").count()) !== 1) {
    throw new Error(
      "a quote of a quote drew more than one block; ADR-0148 규칙 4 draws one layer only"
    );
  }
  if ((await nested.getByTestId("quote-nested").count()) !== 1) {
    throw new Error("a quote of a quote must carry the 인용 포함 marker");
  }

  // ---- 2b. 색이 뜻을 겹쳐 쓰지 않는다 (design-review B-1) --------------------
  //
  // 이 화면에서 앰버(`--accent`)는 이미 **멘션**(나를 불렀다)과 **미읽 경계**(여기부터
  // 안 읽었다)를 뜻한다. 인용은 그 둘과 관계없는 「참조」이므로 같은 색을 쓰면
  // 「가리킨다」가 「나를 불렀다」로 읽힌다. 정지 상태와 **hover 상태 둘 다** 잰다 —
  // 1차의 실제 위반은 hover(`border-accent`)였고 정지 상태만 보면 그것을 못 잡는다.
  const railColors = await page.evaluate((paintAccent) => {
    // 토큰의 실제 계산값을 얻는 방법: 그 유틸리티를 입은 프로브를 한 번 만든다.
    // 하드코딩한 hex와 비교하면 팔레트가 재조정될 때 이 단언만 조용히 낡는다.
    const probeWith = (className, read) => {
      const probe = document.createElement("div");
      probe.className = className;
      document.body.append(probe);
      const value = read(getComputedStyle(probe));
      probe.remove();
      return value;
    };
    const accent = probeWith("border-accent border-l-2", (s) => s.borderLeftColor);
    // 앰버가 이 표면에서 이미 맡고 있는 세 뜻. 로그에 함께 남겨, 「인용이 저것들과
    // 같은 색인가」를 사람이 눈이 아니라 숫자로 확인할 수 있게 한다.
    const mention = probeWith("text-accent", (s) => s.color);
    const unreadRule = probeWith("bg-accent", (s) => s.backgroundColor);
    const anchorTint = probeWith("bg-accent-soft", (s) => s.backgroundColor);

    const blocks = document.querySelectorAll('[data-testid="quote-block"]');
    if (paintAccent) {
      // red seam: 드라이버가 레일을 앰버로 칠한다. 계산된 색을 **직접** 넣는 이유는
      // `classList.add("border-accent")`가 확실하지 않기 때문이다 — 두 색 유틸리티는
      // 특정도가 같아서 컴파일된 스타일시트의 순서가 승자를 정하고, 그 순서는 게이트가
      // 통제하지 못한다. 첫 시도가 그래서 red가 되지 않았다.
      for (const node of blocks) {
        if (node instanceof HTMLElement) node.style.borderLeftColor = accent;
      }
    }
    const block = blocks[0];
    return {
      accent,
      mention,
      unreadRule,
      anchorTint,
      rail: block === undefined ? null : getComputedStyle(block).borderLeftColor,
      railBackground:
        block === undefined ? null : getComputedStyle(block).backgroundColor,
    };
  }, proveRedAccent);
  console.log(
    `[color] 인용 레일 ${railColors.rail} / accent ${railColors.accent} ` +
      `(멘션 ${railColors.mention} · 미읽 규칙 ${railColors.unreadRule} · 앵커 틴트 ${railColors.anchorTint})`
  );
  if (railColors.rail === null) {
    throw new Error("측정할 인용 블록이 없다");
  }
  if (railColors.rail === railColors.accent) {
    throw new Error(
      `the quote rail is wearing the accent (${railColors.rail}); 앰버는 이 화면에서 ` +
        "멘션과 미읽 경계의 색이고, 인용은 참조라 같은 기호를 쓸 수 없다 (taste §4)"
    );
  }
  await quoting.hover();
  const hoverRail = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="quote-block"]');
    return block === null ? null : getComputedStyle(block).borderLeftColor;
  });
  console.log(`[color] hover 레일 ${hoverRail}`);
  if (hoverRail === railColors.accent) {
    throw new Error(
      `the quote rail is wearing the accent on hover (${hoverRail}); 정지 상태만 중성인 ` +
        "것으로는 부족하다 - 마우스를 얹은 순간 인용이 멘션의 색이 된다"
    );
  }
  // 앵커 착지 틴트(`--accent-soft`)와도 겹치지 않는다. 그것은 「방금 여기로 왔다」는
  // 일시적 피드백이고, 인용이 상시로 그 색을 입으면 모든 인용이 방금 점프해 온 자리로
  // 보인다.
  if (
    railColors.railBackground !== null &&
    railColors.railBackground === railColors.anchorTint
  ) {
    throw new Error(
      `the quote block wears the anchor landing tint as its resting background (${railColors.railBackground})`
    );
  }

  // 포커스 링은 예외이고, 그 예외가 의도임을 여기서 못박는다: accent 링은 「포커스가
  // 여기 있다」를 말하는 하우스 패턴이고(SKILL §6) 이 앱의 모든 컨트롤이 같은 링을
  // 쓴다. 인용만 다른 링을 쓰면 그게 새로운 오독이다.
  const focusRing = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="quote-block"]');
    if (!(block instanceof HTMLElement)) return null;
    block.focus();
    return getComputedStyle(block).outlineColor;
  });
  if (focusRing !== null && focusRing === railColors.rail) {
    throw new Error(
      "포커스 링이 레일과 같은 색이면 포커스가 어디 있는지 보이지 않는다"
    );
  }

  // ---- 3. 삭제 정직 ----------------------------------------------------------
  const quotesDeleted = rowLocator(page, QUOTES_DELETED_MSG);
  const deletedBlock = quotesDeleted.getByTestId("quote-block");
  await deletedBlock.waitFor();
  const pageText = (await page.getByTestId("timeline-virtuoso").textContent()) ?? "";
  if (pageText.includes(DELETED_BODY_MARKER)) {
    throw new Error(
      "a deleted original's text reached the screen; a quote must not be a copy that outlives the delete (ADR-0148 규칙 3)"
    );
  }
  if ((await quotesDeleted.getByTestId("quote-deleted").count()) !== 1) {
    throw new Error(
      "a quote of a deleted original must say 삭제된 메시지 in its own words"
    );
  }

  // ---- 4. 긴 출력은 종류만 (미결 2) -----------------------------------------
  const quotesDiff = rowLocator(page, QUOTES_DIFF_MSG);
  const diffBlockText =
    (await quotesDiff.getByTestId("quote-block").textContent()) ?? "";
  if (!diffBlockText.includes("코드 변경")) {
    throw new Error(
      `quoting a diff must name the kind, read "${diffBlockText}"`
    );
  }
  if (diffBlockText.includes(DIFF_PAYLOAD_MARKER)) {
    throw new Error(
      `the quoted card's payload reached the quote block ("${DIFF_PAYLOAD_MARKER}")`
    );
  }

  // ---- 5. 재조회 금지 -------------------------------------------------------
  // 타임라인이 가라앉을 시간을 준다. 여기까지 나간 요청은 「채널을 여는 값」이고,
  // 이 뒤로 나가는 요청이 있다면 그것은 인용을 풀기 위한 것이다.
  await wait(600);
  const settled = traffic.messageRequests.length;
  if (proveRedRefetch) {
    // red seam: 인용 대상 하나를 직접 fetch한다. N+1이 시작되는 정확한 모양이고,
    // 아래 카운터 단언이 네트워크를 실제로 보고 있다면 반드시 깨진다.
    await page.evaluate(
      async ({ ws, ch, target }) => {
        await fetch(
          `/v1/workspaces/${ws}/channels/${ch}/messages?before=${target}`,
          { headers: { accept: "application/json" } }
        ).catch(() => undefined);
      },
      { ws: workspaceId, ch: channelId, target: 41 }
    );
  }
  // 인용을 읽고, 누르고, 스크롤한다. 어느 것도 서버에 물어볼 일이 아니다.
  await quoting.hover();
  await block.click();
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, 400);
  await wait(600);
  if (traffic.messageRequests.length !== settled) {
    throw new Error(
      `resolving a quote reached the network: ${settled} -> ${
        traffic.messageRequests.length
      } /messages requests. Extra: ${JSON.stringify(
        traffic.messageRequests.slice(settled)
      )}`
    );
  }
  for (const url of traffic.allUrls) {
    for (const id of [ORIGIN_MSG, DELETED_MSG, DIFF_MSG, QUOTING_MSG]) {
      if (url.toLowerCase().includes(id)) {
        throw new Error(
          `a quote target's id appeared in a request URL (${url}); that is where the N+1 starts`
        );
      }
    }
  }

  // ---- 6. 점프: 기존 앵커 기계 ----------------------------------------------
  // 클릭은 위에서 이미 했다. 원본 행이 착지 표식을 받았는지 본다.
  const landed = await rowLocator(page, ORIGIN_MSG).evaluate((node) =>
    node.classList.contains("bg-accent-soft")
  );
  if (!landed) {
    throw new Error(
      "clicking a quote did not land on the original (the anchor watcher never tinted the row)"
    );
  }

  // ---- 7. 라이브 인용: 프레임에는 원문이 없다 --------------------------------
  await page.evaluate(
    ({ ch, author, id, target, body, dropTarget }) => {
      window.__quoteGatePublish({
        type: "message.new",
        v: 1,
        seq: 49,
        payload: {
          id,
          channel_id: ch,
          seq: 49,
          type: "text",
          body,
          author_member_id: author,
          hlc_ts: Date.now(),
          hlc_count: 0,
          // red seam: `reply_to_id`를 빼면 라이브 인용이 인용이 아니게 된다.
          ...(dropTarget ? {} : { reply_to_id: target }),
        },
      });
    },
    {
      ch: channelId,
      author: peerId,
      id: LIVE_QUOTING_MSG,
      target: ORIGIN_MSG,
      body: LIVE_BODY,
      dropTarget: proveRedLive,
    }
  );
  const liveRow = rowLocator(page, LIVE_QUOTING_MSG);
  await liveRow.waitFor({ timeout: 5_000 });
  await wait(200);
  if ((await liveRow.getByTestId("quote-block").count()) !== 1) {
    throw new Error(
      "a live quote reply drew no quote block; `message.new` carries only reply_to_id, so it must be resolved against the rows already on screen"
    );
  }
  const liveBlock = liveRow.getByTestId("quote-block");
  if ((await liveBlock.getAttribute("data-kind")) !== "ready") {
    throw new Error(
      `a live quote whose original IS loaded must resolve, got "${await liveBlock.getAttribute(
        "data-kind"
      )}"`
    );
  }
  const liveBlockText = (await liveBlock.textContent()) ?? "";
  if (!liveBlockText.includes("배포 되돌리기 절차부터")) {
    throw new Error(
      `a live quote resolved to the wrong row, read "${liveBlockText}"`
    );
  }
  const afterLive = traffic.messageRequests.length;
  if (afterLive !== settled) {
    throw new Error(
      `a live quote reply triggered ${afterLive - settled} extra /messages request(s); the frame is not an invitation to refetch`
    );
  }

  // ---- 8. 두 장치는 메뉴에서도 다른 말이다 -----------------------------------
  await openRowMenu(page, ORIGIN_MSG);
  const menu = page.getByTestId("message-action-menu");
  const menuText = (await menu.textContent()) ?? "";
  if (
    !menuText.includes("답글 달기") ||
    !menuText.includes(QUOTE_ACTION_LABEL)
  ) {
    throw new Error(
      `the menu must offer both devices with different words, read "${menuText}"`
    );
  }
  // 두 항목은 서로 다른 낱말이어야 하고, 그 다름이 *어디로 가는지*를 말해야 한다.
  // 「인용하기」였을 때는 둘 다 「~하기/달기」로 끝나 메뉴에서 「답을 단다」로 똑같이
  // 읽혔다. 지금은 인용 쪽만 「답하기」를 품고 있고, 답글 쪽은 「달기」다.
  if (QUOTE_ACTION_LABEL === "답글 달기") {
    throw new Error("the two devices must not share one label");
  }
  if ((await menu.getByTestId("menu-quote").count()) !== 1) {
    throw new Error(`${QUOTE_ACTION_LABEL} is not its own menu item`);
  }
  const menuKeys = await menu
    .locator('[data-testid^="menu-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")?.slice("menu-".length))
    );
  if (!menuKeys.includes("copy")) {
    throw new Error(`the visible menu has no copy action: ${JSON.stringify(menuKeys)}`);
  }

  // ---- 8b. 원문 복사 + 우클릭 동등성 ----------------------------------------
  await menu.getByTestId("menu-copy").click();
  await page.getByTestId("menu-copy").getByText("복사됨").waitFor();
  const menuCopy = await page.evaluate(() => navigator.clipboard.readText());
  if (menuCopy !== ORIGIN_BODY) {
    throw new Error(
      `the ⋯ menu copied rendered text instead of raw markdown: ${JSON.stringify(menuCopy)}`
    );
  }
  await page.keyboard.press("Escape");

  const originRow = rowLocator(page, ORIGIN_MSG);
  await originRow.click({ button: "right", position: { x: 180, y: 24 } });
  const contextMenu = page.getByTestId("message-context-menu");
  await contextMenu.waitFor();
  const contextKeys = await contextMenu
    .locator('[data-testid^="context-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.getAttribute("data-testid")?.slice("context-".length)
      )
    );
  if (JSON.stringify(contextKeys) !== JSON.stringify(menuKeys)) {
    throw new Error(
      `right-click and ⋯ actions drifted: ${JSON.stringify(contextKeys)} != ${JSON.stringify(menuKeys)}`
    );
  }
  await contextMenu.getByTestId("context-copy").click();
  await page.getByTestId("context-copy").getByText("복사됨").waitFor();
  const contextCopy = await page.evaluate(() => navigator.clipboard.readText());
  if (contextCopy !== ORIGIN_BODY) {
    throw new Error(
      `the right-click menu copied rendered text instead of raw markdown: ${JSON.stringify(contextCopy)}`
    );
  }
  await page.keyboard.press("Escape");

  // A partial selection belongs to the browser. Record defaultPrevented at the
  // target while headless Chromium receives the same contextmenu event.
  await originRow.evaluate((row) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !(text.textContent ?? "").includes("배포")) {
      text = walker.nextNode();
    }
    if (!text) throw new Error("selection fixture text not found");
    const start = (text.textContent ?? "").indexOf("배포");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 2);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window.__quoteGateContextDefaultPrevented = null;
    document.addEventListener(
      "contextmenu",
      (event) => {
        setTimeout(() => {
          window.__quoteGateContextDefaultPrevented = event.defaultPrevented;
        }, 0);
      },
      { once: true, capture: true }
    );
  });
  await wait(100);
  await originRow.click({ button: "right", position: { x: 180, y: 24 } });
  await wait(100);
  const selectedContext = await page.evaluate(
    () => window.__quoteGateContextDefaultPrevented
  );
  if (selectedContext !== false) {
    throw new Error(
      `a selected message did not yield to the native context menu (defaultPrevented=${selectedContext})`
    );
  }
  if ((await page.getByTestId("message-context-menu").count()) !== 0) {
    throw new Error("the app context menu opened over a text selection");
  }
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await wait(100);

  await openRowMenu(page, ORIGIN_MSG);
  // 이미 답글인 행에서도 인용은 열려 있다 (규칙 1). 스레드 답글이 없는 이 채널에서는
  // `rootId`가 붙은 행을 목으로 만들 수 없으므로, 코어 단정(quote.test.ts)이 그
  // 자리를 지키고 여기서는 두 항목이 **함께** 있는 것만 확인한다.

  // ---- 9. 전송 바인딩 -------------------------------------------------------
  await menu.getByTestId("menu-quote").click();
  await page.getByTestId("composer-quote").waitFor();
  const chipTarget = await page
    .getByTestId("composer-quote")
    .getAttribute("data-target-id");
  if (chipTarget !== ORIGIN_MSG) {
    throw new Error(
      `the composer chip pinned the wrong message (${chipTarget} != ${ORIGIN_MSG})`
    );
  }
  if (proveRedBinding) {
    // red seam: 보내기 전에 취소한다. 아래 바인딩 단언이 살아 있다면 반드시 깨진다.
    await page.getByTestId("composer-quote-cancel").click();
    await page.getByTestId("composer-quote").waitFor({ state: "detached" });
  }
  await page.getByTestId("composer-input").fill(SENT_BODY);
  await page.getByTestId("composer-send").click();
  await page.waitForFunction(
    (needle) =>
      Array.from(document.querySelectorAll('[data-testid="timeline-message"]')).some(
        (node) => (node.textContent ?? "").includes(needle)
      ),
    SENT_BODY,
    { timeout: 5_000 }
  );
  const sent = traffic.sends.at(-1);
  if (!sent || sent.body !== SENT_BODY) {
    throw new Error(`the send never reached the write path: ${JSON.stringify(sent)}`);
  }
  if (sent.replyToId !== ORIGIN_MSG) {
    throw new Error(
      `the send carried no replyToId (got ${JSON.stringify(
        sent.replyToId
      )}); the quote binding rides the one write path, not a second endpoint`
    );
  }
  // 인용은 이 전송분과 함께 떠난다. 남아 있으면 다음 글이 고른 적 없는 주장을 한다.
  if ((await page.getByTestId("composer-quote").count()) !== 0) {
    throw new Error("the quote chip survived its own send");
  }

  // ---- 10. 나오는 길이 둘 있다 (미결 3) --------------------------------------
  for (const exit of ["button", "escape"]) {
    await openRowMenu(page, ORIGIN_MSG);
    await page.getByTestId("menu-quote").click();
    await page.getByTestId("composer-quote").waitFor();
    if (exit === "button") {
      await page.getByTestId("composer-quote-cancel").click();
    } else {
      await page.getByTestId("composer-input").click();
      await page.keyboard.press("Escape");
    }
    await page
      .getByTestId("composer-quote")
      .waitFor({ state: "detached", timeout: 3_000 })
      .catch(() => {
        throw new Error(
          `인용을 ${exit}로 뗄 수 없다: 들어가는 길만 있고 나오는 길이 없으면 안 된다 (ADR-0148 미결 3)`
        );
      });
  }
  const before = traffic.sends.length;
  await page.getByTestId("composer-input").fill("취소한 뒤에는 그냥 보냅니다.");
  await page.getByTestId("composer-send").click();
  await page.waitForFunction(
    (count) => count >= 0,
    0,
    { timeout: 1_000 }
  );
  await wait(400);
  const afterCancel = traffic.sends.at(-1);
  if (traffic.sends.length === before) {
    throw new Error("the send after a cancelled quote never left");
  }
  if (afterCancel?.replyToId !== undefined) {
    throw new Error(
      `a cancelled quote still shipped: replyToId=${afterCancel?.replyToId}`
    );
  }

  // ---- 11. 키보드 경로 ------------------------------------------------------
  // 인용 블록은 행의 로빙 그룹 안에 있어야 한다: 인용마다 탭 스톱이 하나 늘면
  // 가상 목록에서 컴포저까지 가는 경로가 메시지 수만큼 길어진다.
  const rowAction = await quoting
    .getByTestId("quote-block")
    .getAttribute("data-row-action");
  if (rowAction === null) {
    throw new Error(
      "the quote block is not part of the row's roving focus group (data-row-action missing)"
    );
  }

  // The avatar joins the row's roving group; it does not add another Tab stop.
  const rowStops = await quoting
    .locator('[data-row-action][tabindex="0"]')
    .count();
  if (rowStops !== 1) {
    throw new Error(`the profile avatar changed one message row into ${rowStops} tab stops`);
  }
  const avatar = quoting.getByTestId("row-avatar-profile");
  await avatar.focus();
  await page.keyboard.press("Enter");
  const profile = page.getByTestId("member-profile-dialog");
  await profile.waitFor();
  const profileText = (await profile.textContent()) ?? "";
  for (const expected of ["이도현", "@dohyun", "사람", "활성", "멤버"]) {
    if (!profileText.includes(expected)) {
      throw new Error(`the shared profile omitted ${expected}: ${profileText}`);
    }
  }
  if ((await profile.getByTestId("member-profile-dm").count()) !== 1) {
    throw new Error("an active peer profile has no direct-message action");
  }
  await page.keyboard.press("Escape");
  if (!(await avatar.evaluate((node) => document.activeElement === node))) {
    throw new Error("Esc from the member profile did not return focus to the message avatar");
  }

  // Directory rows and a DM header open the same card and return to themselves.
  await page.getByTestId("nav-directory").click();
  const directoryRow = page.locator(
    `[data-testid="directory-row"][data-member-id="${peerId}"]`
  );
  await directoryRow.waitFor();
  await directoryRow.click();
  await profile.waitFor();
  await page.keyboard.press("Escape");
  if (!(await directoryRow.evaluate((node) => document.activeElement === node))) {
    throw new Error("the directory profile did not return focus to its row");
  }

  await page.locator(`[data-channel-id="${dmChannelId}"]`).click();
  const dmProfileTrigger = page.getByTestId("dm-profile-trigger");
  await dmProfileTrigger.waitFor();
  await dmProfileTrigger.click();
  await profile.waitFor();
  await page.keyboard.press("Escape");
  if (!(await dmProfileTrigger.evaluate((node) => document.activeElement === node))) {
    throw new Error("the DM-header profile did not return focus to its trigger");
  }

  await context.close();
  return menuKeys;
}

async function exerciseTouch(browser, menuKeys) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 800, height: 900 },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic);
  await login(page);

  const originRow = rowLocator(page, ORIGIN_MSG);
  await originRow.evaluate((row) => {
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "touch",
        clientX: rect.left + 32,
        clientY: rect.top + 24,
      })
    );
  });
  await page.getByTestId("message-action-sheet").waitFor({ timeout: 3_000 });
  const sheet = page.getByTestId("message-action-sheet");
  const sheetKeys = await sheet
    .locator('[data-testid^="sheet-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")?.slice("sheet-".length))
    );
  if (JSON.stringify(sheetKeys) !== JSON.stringify(menuKeys)) {
    throw new Error(
      `long-press and ⋯ actions drifted: ${JSON.stringify(sheetKeys)} != ${JSON.stringify(menuKeys)}`
    );
  }
  await sheet.getByTestId("sheet-copy").click();
  await sheet.getByTestId("sheet-copy").getByText("복사됨").waitFor();
  const sheetCopy = await page.evaluate(() => navigator.clipboard.readText());
  if (sheetCopy !== ORIGIN_BODY) {
    throw new Error(
      `the long-press sheet copied rendered text instead of raw markdown: ${JSON.stringify(sheetCopy)}`
    );
  }
  await page.keyboard.press("Escape");
  await context.close();
}

/** 리뷰용 스크린샷 (SKILL §11). 판정하지 않는다 — 사람이 보는 자리다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/quote");
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
    await openRowMenu(page, ORIGIN_MSG);
    await page.getByTestId("menu-quote").click();
    await page.getByTestId("composer-quote").waitFor();
    await page.getByTestId("composer-input").fill("이 절차부터 다시 봅시다.");
    await page.screenshot({ path: resolve(outDir, `quote-${scheme}.png`) });
    await context.close();
  }
  console.log("[shots] artifacts/quote/quote-{light,dark}.png");
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "QUOTE_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      const menuKeys = await exercise(browser);
      await exerciseTouch(browser, menuKeys);
      if (process.env.QUOTE_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 인용은 페이지가 준 값으로만 그려졌고(요청 0건 추가),");
  console.log("           삭제된 원본은 사본을 남기지 않았고, 라이브 프레임은");
  console.log("           로드된 행에서 풀렸고, 전송은 한 쓰기경로에 replyToId를");
  console.log("           실었고, 인용에서 나오는 길이 둘 있었다.");
  console.log("           메시지 액션 세 표면은 같은 목록과 원문 복사를 썼고,");
  console.log("           프로필 세 진입점은 Esc 뒤 원래 포커스로 돌아갔다.");
}

await main();
