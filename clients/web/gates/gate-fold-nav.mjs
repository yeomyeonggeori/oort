#!/usr/bin/env node
// GATE: U4-5W — 접기·항법·거터의 시계 (정본: docs/planning/research/2026-08-05-chat-ui-audit.md
// §3 H-8·M-9, 배치 U4-e·U4-j / research/2026-08-05-u44-design-review.md W-4).
//
// 이 게이트가 지키는 것은 「접히는가·버튼이 있는가」가 아니라 **그 접힘이 정직한가,
// 그 항법이 사람을 원래 있던 자리에 두는가, 그리고 그 시각에 닿는 길이 입력 장치마다
// 있는가**다.
//
//   1. 접힌 것은 숨기지  긴 답변은 예산만큼만 펴고, 남은 줄 수를 **숫자로** 말한다.
//      않고 세어 준다     페이드아웃이 아니라 검산 가능한 숫자다 — 편 줄 + 접힌 줄이
//                        원문의 줄 수와 같아야 한다 (H-8).
//   2. 짧은 답변은        예산 안의 본문에는 컨트롤이 붙지 않는다. 채널의 대부분이
//      그대로다           그것이고, 거기에 「더 보기」가 붙으면 접기가 잡음이 된다.
//   3. 펴면 전부 온다     누른 뒤에는 원문의 모든 줄이 화면에 있고, 컨트롤은 「접기」로
//                        바뀐다. 접기는 감추는 장치가 아니라 미루는 장치다.
//   4. 돌아갈 길이 있다   위로 올라가 읽는 동안 최신으로 돌아가는 컨트롤이 뜬다.
//                        진단 M-9: `VirtuosoHandle`이 선언·전달만 되고 한 번도
//                        역참조되지 않았다.
//   5. 읽던 화면은        읽는 중에 새 메시지가 오면 화면은 움직이지 않고 개수만
//      움직이지 않는다    올라간다. 바닥에 있으면 그 컨트롤은 아예 뜨지 않는다
//                        (`followOutput`이 이미 따라간다).
//   6. hover가 없는       포인터가 없는 기기에서는 거터의 시각이 정지 상태로 선다.
//      기기의 시계        hover로만 여는 것은 그 기기에서 「없는 기능」이다 (리뷰 W-4).
//   7. 컨트롤 없는 행도   액션이 없는 행은 자기 자신이 탭 정거장이 되어, 키보드만
//      정거장이 된다      쓰는 사람도 그 행의 시각에 닿는다 (리뷰 W-4 후반).
//
// 이름 붙은 red proof (CSS/DOM만 건드린다 — 제품 소스는 그대로 컴파일된다):
//   FOLD_GATE_PROVE_RED_FOLD=1 npm run gate:fold
//     expected failure: "a long answer offered no way to see the rest"
//   FOLD_GATE_PROVE_RED_JUMP=1 npm run gate:fold
//     expected failure: "no way back to the newest message"
//   FOLD_GATE_PROVE_RED_ROWTIME=1 npm run gate:fold
//     expected failure: "a touch reader can never see a row's time"
//   FOLD_GATE_PROVE_RED_ROWSTOP=1 npm run gate:fold
//     expected failure: "a row with no controls is not reachable by keyboard"
//
// 예산의 숫자는 **정본 파일을 읽는다**(`src/features/timeline/fold.ts`). 여기에
// 베껴 적으면 「두 벌이 조용히 갈라진다」는, 이 레포가 U4-4R에서 한 번 치른 값을
// 게이트가 다시 저지르는 것이 된다. 접기 임계를 되돌리면(예산을 무한대로) 아래
// 1·2번이 붉다.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 접기 예산의 정본은 제품 소스다. 모양이 바뀌면 게이트가 죽는 편이 옳다. */
function bodyFoldBudget() {
  const source = readFileSync(
    resolve(webRoot, "src/features/timeline/fold.ts"),
    "utf8"
  );
  const match = source.match(
    /BODY_FOLD:\s*FoldBudget\s*=\s*\{\s*threshold:\s*(\d+),\s*eager:\s*(\d+)\s*\}/
  );
  if (match === null) {
    throw new Error(
      "fold.ts의 BODY_FOLD를 읽지 못했다: 모양이 바뀌었다면 이 게이트도 함께 고칠 것"
    );
  }
  return { threshold: Number(match[1]), eager: Number(match[2]) };
}

const BODY_FOLD = bodyFoldBudget();

const port = Number(process.env.FOLD_GATE_PORT || 5197);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";

const proveRedFold = process.env.FOLD_GATE_PROVE_RED_FOLD === "1";
const proveRedJump = process.env.FOLD_GATE_PROVE_RED_JUMP === "1";
const proveRedRowTime = process.env.FOLD_GATE_PROVE_RED_ROWTIME === "1";
const proveRedRowStop = process.env.FOLD_GATE_PROVE_RED_ROWSTOP === "1";

const LONG_MSG = "0199dddd-0000-7000-8000-0000000000d1";
const SHORT_MSG = "0199dddd-0000-7000-8000-0000000000d2";
const GROUP_HEAD_MSG = "0199dddd-0000-7000-8000-0000000000d3";
const CONT_MSG = "0199dddd-0000-7000-8000-0000000000d4";
const TOMBSTONE_MSG = "0199dddd-0000-7000-8000-0000000000d5";
const LIVE_MSG = "0199dddd-0000-7000-8000-0000000000e1";

/** 진단이 든 예: 에이전트가 로그를 통째로 뱉는다. 산문 2줄 + 펜스 40줄. */
const FENCE_LINES = 40;
const LONG_BODY = [
  "배포 롤백의 원인을 찾았습니다.",
  "아래는 `outbox_drain_worker` 로그 전문입니다.",
  "",
  "```sh",
  ...Array.from(
    { length: FENCE_LINES },
    (_, i) => `2026-08-05T09:1${i % 10}:00Z drain batch=${i + 1} lag=12ms`
  ),
  "```",
].join("\n");
/**
 * 이 답변이 화면에서 몇 줄인가.
 *
 * 산문 2줄 + 펜스 40줄이다. 블록을 가르는 빈 줄과 펜스 마커(```)는 세지 않는다 —
 * 그것들은 마크업이지 사람이 읽는 줄이 아니고, 펼쳤을 때 화면에 서지도 않는다.
 * 이 게이트가 아래에서 실제로 세는 것이 그 「화면의 줄」이므로, 여기 적은 숫자도
 * 같은 것을 세야 대조가 성립한다.
 */
const LONG_BODY_LINES = 2 + FENCE_LINES;

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
  realtimeWebSocketUrl: "ws://fold-gate.invalid/connection/websocket",
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
  {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    muted: false,
  },
];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const FILLER_COUNT = 30;
const FIRST_AT = todayAt(9, 0);

function row(over) {
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    ...over,
    hlcTs: over.hlcTs ?? over.createdAtMs,
  };
}

/**
 * 한 페이지. 스크롤백이 있어야 항법을 잴 수 있으므로 짧은 행을 채워 넣는다 —
 * 다섯 줄짜리 채널에서는 「바닥이 아닌 상태」 자체가 만들어지지 않는다.
 */
function historyPage() {
  const rows = [];
  for (let i = 0; i < FILLER_COUNT; i++) {
    rows.push(
      row({
        id: `0199dddd-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
        seq: 100 + i,
        // 저자를 번갈아 두어 묶음이 계속 새로 열린다 = 행 높이가 고르다.
        authorMemberId: i % 2 === 0 ? peerId : memberId,
        body: `릴리스 점검 ${i + 1}: 스테이징 확인했습니다.`,
        createdAtMs: FIRST_AT + i * 600_000,
      })
    );
  }
  const base = FIRST_AT + FILLER_COUNT * 600_000;
  rows.push(
    row({
      id: LONG_MSG,
      seq: 200,
      authorMemberId: agentId,
      body: LONG_BODY,
      createdAtMs: base,
    }),
    row({
      id: SHORT_MSG,
      seq: 201,
      authorMemberId: peerId,
      body: "확인했습니다. 롤백 태그는 그대로 두겠습니다.",
      createdAtMs: base + 600_000,
    }),
    // 한 저자의 묶음: 머리 + 연속 + tombstone(연속). tombstone은 액션이 하나도
    // 없는 행이라(`isActionable`이 거짓) 컨트롤 없는 행의 실물 표본이다.
    row({
      id: GROUP_HEAD_MSG,
      seq: 202,
      authorMemberId: memberId,
      body: "노트 초안은 스레드에 이어서 답니다.",
      createdAtMs: base + 1_200_000,
    }),
    row({
      id: CONT_MSG,
      seq: 203,
      authorMemberId: memberId,
      body: "빠진 항목 있으면 알려 주세요.",
      createdAtMs: base + 1_240_000,
    }),
    row({
      id: TOMBSTONE_MSG,
      seq: 204,
      authorMemberId: memberId,
      body: null,
      state: "deleted",
      createdAtMs: base + 1_280_000,
    })
  );
  return rows;
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
              connect: { client: "fold-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "fold-gate",
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

    window.__foldGateChannelSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    window.__foldGatePublish = (frame) => {
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

async function installRoutes(context) {
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

    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        return json(
          route,
          row({
            id: "0199dddd-0000-7000-8000-0000000000f1",
            seq: 300,
            authorMemberId: memberId,
            body: body.body,
            createdAtMs: Date.now(),
          })
        );
      }
      // 위·아래 어느 쪽으로 더 달라고 해도 빈 페이지로 끝낸다: 페이지네이션
      // 루프가 측정 창 안에서 계속 돌면 스크롤 위치를 이 게이트가 통제하지 못한다.
      if (url.searchParams.has("after") || url.searchParams.has("before")) {
        return json(route, { messages: [] });
      }
      return json(route, { messages: historyPage() });
    }

    return json(route, {});
  });
}

function rowLocator(page, messageId) {
  return page.locator(
    `[data-testid="timeline-message"][data-message-id="${messageId}"]`
  );
}

async function login(page, { narrow = false } = {}) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("fold@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  if (narrow) {
    // 390px에서 사이드바는 열이 아니라 서랍이다(tokens.css `sidebar-drawer`):
    // 채널 행은 DOM에 있지만 화면 밖으로 밀려 있어 클릭할 수 없다. 여는 몸짓을
    // 흉내 내는 대신 라우터에 직접 말한다 — 이 게이트가 재려는 것은 서랍이 아니다.
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, channelId);
  } else {
    await page.getByTestId("channel-item").first().click();
  }
  await page.waitForFunction(() => window.__foldGateChannelSubscribed(), undefined, {
    timeout: 15_000,
  });
  await rowLocator(page, TOMBSTONE_MSG).waitFor({ timeout: 15_000 });
}

/** 화면에 실제로 그려진 본문 줄 수. 블록 종류마다 「줄」이 다르다(fold.ts). */
function renderedBodyLines(page, messageId) {
  return page.evaluate((id) => {
    const row = document.querySelector(
      `[data-testid="timeline-message"][data-message-id="${id}"]`
    );
    if (row === null) return null;
    const body = row.querySelector("[data-row-body]");
    if (body === null) return null;
    let lines = 0;
    for (const node of body.querySelectorAll("p, pre, li")) {
      if (node.closest("[data-testid='message-fold']") !== null) continue;
      if (node.tagName === "LI") {
        lines += 1;
        continue;
      }
      lines += (node.textContent ?? "").split("\n").length;
    }
    return lines;
  }, messageId);
}

async function scrollUp(page) {
  const scroller = page.locator('[data-testid="timeline-virtuoso"]');
  await scroller.evaluate((node) => {
    // 절반쯤 올라간다. 0으로 가면 `startReached`가 옛 페이지를 부르고, 그 왕복이
    // 측정 창을 흔든다.
    node.scrollTop = Math.round(node.scrollHeight * 0.35);
  });
  await wait(600);
}

/** 바닥으로 되돌린다. 접기 시험이 목록 높이를 바꾼 뒤의 출발선. */
async function settleAtBottom(page) {
  await page
    .locator('[data-testid="timeline-virtuoso"]')
    .evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
  await wait(600);
}

async function scrollTopOf(page) {
  return page
    .locator('[data-testid="timeline-virtuoso"]')
    .evaluate((node) => Math.round(node.scrollTop));
}

async function publishLive(page, id, seq, body) {
  await page.evaluate(
    ({ ch, author, msgId, msgSeq, msgBody }) => {
      window.__foldGatePublish({
        type: "message.new",
        v: 1,
        seq: msgSeq,
        payload: {
          id: msgId,
          channel_id: ch,
          seq: msgSeq,
          type: "text",
          body: msgBody,
          author_member_id: author,
          hlc_ts: Date.now(),
          hlc_count: 0,
        },
      });
    },
    { ch: channelId, author: peerId, msgId: id, msgSeq: seq, msgBody: body }
  );
  await wait(500);
}

// ---- 1~5. 접기와 항법 (포인터가 있는 창) -------------------------------------

async function exercisePointer(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  await login(page);

  if (proveRedFold) {
    // red seam: 접기 컨트롤을 화면에서 지운다. 예산은 그대로 도므로 본문은 여전히
    // 잘려 있고, **나머지로 가는 길만** 사라진다 = 「접었으면서 말하지 않는다」.
    await page.addStyleTag({
      content: '[data-testid="message-fold"]{display:none!important}',
    });
  }
  if (proveRedJump) {
    // red seam: 항법 컨트롤만 지운다 = 진단 M-9의 상태(손으로 끝까지 밀기).
    await page.addStyleTag({
      content: '[data-testid="jump-latest"]{display:none!important}',
    });
  }

  // ---- 4. 바닥에서는 항법 컨트롤이 뜨지 않는다 -------------------------------
  //
  // 먼저 재는 이유: 아래 접기 시험이 본문 높이를 바꾸므로, 「첫 화면은 바닥이다」는
  // 그 전에만 참인 사실이다.
  const jump = page.getByTestId("jump-latest");
  if ((await jump.count()) !== 0) {
    throw new Error(
      "바닥에 있는데 「최신으로」가 떠 있다: virtuoso가 이미 따라가는 자리에서 " +
        "그 컨트롤이 하는 일은 0이다 (followOutput)"
    );
  }

  // ---- 1. 긴 답변은 접힌 채로 오고, 접힌 줄을 숫자로 말한다 (H-8) ------------
  const longRow = rowLocator(page, LONG_MSG);
  const foldControl = longRow.getByTestId("message-fold");
  if (!(await foldControl.isVisible())) {
    throw new Error(
      `a long answer offered no way to see the rest: 원문 ${LONG_BODY_LINES}줄짜리 ` +
        "답변에 접기 컨트롤이 없다. 에이전트가 로그를 뱉으면 채널이 그것 하나로 " +
        "덮인다 (진단 H-8)"
    );
  }
  const hidden = Number(await foldControl.getAttribute("data-fold-hidden"));
  const shown = await renderedBodyLines(page, LONG_MSG);
  console.log(
    `[fold] 원문 ${LONG_BODY_LINES}줄 · 편 ${shown}줄 · 접힌 ${hidden}줄 ` +
      `(예산 임계 ${BODY_FOLD.threshold} / 남기는 ${BODY_FOLD.eager})`
  );
  if (shown !== BODY_FOLD.eager) {
    throw new Error(
      `접힌 상태에 남은 줄이 예산과 다르다: 화면 ${shown}줄 · 예산 ${BODY_FOLD.eager}줄 ` +
        "(접기 임계를 되돌리면 이 줄이 붉다)"
    );
  }
  if (shown + hidden !== LONG_BODY_LINES) {
    throw new Error(
      `접힘이 정직하지 않다: 편 ${shown} + 접힌 ${hidden} = ${shown + hidden}인데 ` +
        `원문은 ${LONG_BODY_LINES}줄이다. 숫자를 말하기로 한 이상 그 숫자는 검산된다`
    );
  }
  const foldLabel = (await foldControl.textContent()) ?? "";
  if (!foldLabel.includes(String(hidden)) || !foldLabel.includes("줄 더 보기")) {
    throw new Error(
      `접기 컨트롤이 남은 줄 수를 말하지 않는다 ("${foldLabel.trim()}"): 겸손한 ` +
        "표기는 줄 수를 모를 때의 것이고, 여기서는 안다"
    );
  }

  // ---- 2. 짧은 답변은 그대로다 ----------------------------------------------
  const shortFold = rowLocator(page, SHORT_MSG).getByTestId("message-fold");
  if ((await shortFold.count()) !== 0) {
    throw new Error(
      "예산 안의 짧은 메시지에 접기 컨트롤이 붙었다: 채널의 대부분이 그런 " +
        "메시지이고, 거기 붙는 컨트롤은 기능이 아니라 잡음이다"
    );
  }

  // ---- 3. 펴면 전부 온다 -----------------------------------------------------
  await foldControl.click();
  await wait(200);
  const expandedLines = await renderedBodyLines(page, LONG_MSG);
  const expandedLabel = (await foldControl.textContent()) ?? "";
  console.log(`[fold] 펼친 뒤 ${expandedLines}줄 · 컨트롤 "${expandedLabel.trim()}"`);
  if (expandedLines !== LONG_BODY_LINES) {
    throw new Error(
      `펼쳤는데 원문이 다 오지 않았다: ${expandedLines}줄 / 원문 ${LONG_BODY_LINES}줄. ` +
        "접기는 감추는 장치가 아니라 미루는 장치다"
    );
  }
  if (!expandedLabel.includes("접기")) {
    throw new Error(
      `펼친 뒤에도 컨트롤이 「더 보기」라고 말한다 ("${expandedLabel.trim()}"): ` +
        "되돌릴 길이 없으면 그것은 접기가 아니다"
    );
  }
  await foldControl.click();
  await wait(200);
  if ((await renderedBodyLines(page, LONG_MSG)) !== BODY_FOLD.eager) {
    throw new Error("다시 접히지 않는다: 접기가 한 방향으로만 도는 컨트롤이 됐다");
  }

  // ---- 5. 위로 올라가면 돌아갈 길이 생긴다 (M-9) -----------------------------
  //
  // 접었다 폈다 하는 동안 목록 높이가 바뀌었으므로 바닥으로 되돌려 놓고 시작한다.
  await settleAtBottom(page);
  await scrollUp(page);
  const parkedTop = await scrollTopOf(page);
  if (!(await jump.isVisible())) {
    throw new Error(
      "no way back to the newest message: 위로 올라가 읽는 동안 최신으로 돌아가는 " +
        "컨트롤이 없다. 손으로 끝까지 밀어야 한다 (진단 M-9)"
    );
  }
  const idleLabel = ((await jump.textContent()) ?? "").trim();
  const idleCount = Number(await jump.getAttribute("data-new-count"));
  console.log(`[jump] 스크롤 위치 ${parkedTop} · 라벨 "${idleLabel}" · 개수 ${idleCount}`);
  if (idleCount !== 0 || idleLabel.includes("새 메시지")) {
    throw new Error(
      `새 메시지가 온 적 없는데 「${idleLabel}」이라고 말한다: 오지 않은 것을 ` +
        "세는 순간 이 숫자는 아무도 못 믿는다"
    );
  }

  // 읽는 중에 새 메시지가 온다: 화면은 그대로, 개수만 오른다.
  await publishLive(page, LIVE_MSG, 205, "핫픽스 태그 올렸습니다.");
  const afterPublishTop = await scrollTopOf(page);
  const liveCount = Number(await jump.getAttribute("data-new-count"));
  const liveLabel = ((await jump.textContent()) ?? "").trim();
  console.log(
    `[jump] 새 메시지 뒤: 스크롤 ${afterPublishTop} · 라벨 "${liveLabel}" · 개수 ${liveCount}`
  );
  if (liveCount !== 1) {
    throw new Error(
      `아래에 쌓인 새 메시지를 ${liveCount}개로 센다: 1개여야 한다`
    );
  }
  if (!liveLabel.includes("새 메시지")) {
    throw new Error(
      `새 메시지가 왔는데 컨트롤이 그 말을 하지 않는다 ("${liveLabel}")`
    );
  }
  if (Math.abs(afterPublishTop - parkedTop) > 8) {
    throw new Error(
      `읽던 화면이 새 메시지에 밀렸다: ${parkedTop} -> ${afterPublishTop}. 읽던 줄이 ` +
        "밀려나는 것은 새 메시지가 저지를 수 있는 가장 나쁜 일이다"
    );
  }

  // 누르면 바닥으로, 그리고 컨트롤은 사라진다.
  await jump.click();
  await wait(900);
  if ((await page.getByTestId("jump-latest").count()) !== 0) {
    throw new Error(
      "「최신으로」를 눌렀는데 컨트롤이 남아 있다: 바닥에 닿지 못했거나, 닿고도 " +
        "자기 상태를 모른다"
    );
  }
  const liveRow = rowLocator(page, LIVE_MSG);
  if (!(await liveRow.isVisible())) {
    throw new Error("바닥으로 갔는데 방금 온 메시지가 화면에 없다");
  }

  // 바닥에 있는 동안 온 메시지는 배지가 아니라 화면으로 온다 (followOutput).
  await publishLive(page, "0199dddd-0000-7000-8000-0000000000e2", 206, "확인.");
  if ((await page.getByTestId("jump-latest").count()) !== 0) {
    throw new Error(
      "바닥에 있는데 새 메시지가 배지를 띄웠다: 이미 화면에 온 것을 「아래에 " +
        "있다」고 말하는 셈이다"
    );
  }

  // ---- 7. 컨트롤 없는 행의 키보드 경로 (리뷰 W-4) ----------------------------
  if (proveRedRowStop) {
    // red seam: 행의 정거장을 걷어낸다 = 액션 없는 행에 포커스 갈 자리가 없던
    // 상태. DOM만 건드리므로 제품 소스는 그대로다.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll(
        '[data-testid="timeline-message"]'
      )) {
        node.removeAttribute("tabindex");
      }
    });
  }
  const tombstone = rowLocator(page, TOMBSTONE_MSG);
  await tombstone.scrollIntoViewIfNeeded();
  await wait(200);
  const tombstoneStop = await tombstone.getAttribute("tabindex");
  const actionableStop = await rowLocator(page, CONT_MSG).getAttribute("tabindex");
  console.log(
    `[rowstop] 컨트롤 없는 행 tabindex=${tombstoneStop} · 컨트롤 있는 행 tabindex=${actionableStop}`
  );
  if (tombstoneStop !== "0") {
    throw new Error(
      "a row with no controls is not reachable by keyboard: 액션이 없는 행에 " +
        "포커스 받을 자식이 하나도 없어서, 눈으로 읽으며 키보드만 쓰는 사람에게 " +
        "그 행의 시각으로 가는 길이 없다 (리뷰 W-4)"
    );
  }
  if (actionableStop !== null) {
    throw new Error(
      `컨트롤이 있는 행까지 정거장을 얻었다 (tabindex=${actionableStop}): 행 하나가 ` +
        "키보드에 청구하는 값이 둘이 됐다 (rowFocus.ts)"
    );
  }
  // 그 정거장이 실제로 시각을 연다.
  await tombstone.evaluate((node) => node.focus());
  await wait(200);
  const focusedClock = await tombstone
    .locator("[data-row-clock]")
    .evaluate((node) => Number(getComputedStyle(node).opacity));
  console.log(`[rowstop] 포커스 뒤 거터 시계 불투명도 ${focusedClock}`);
  if (focusedClock < 0.99) {
    throw new Error(
      `행에 포커스를 줬는데 거터의 시각이 여전히 보이지 않는다 (${focusedClock}): ` +
        "정거장만 생기고 그 정거장이 여는 것이 없다"
    );
  }

  // 포인터가 있는 창의 정지 상태는 그대로다 — 최소 개입의 실측 (리뷰 W-4).
  const restingClock = await rowLocator(page, CONT_MSG)
    .locator("[data-row-clock]")
    .evaluate((node) => Number(getComputedStyle(node).opacity));
  console.log(`[rowtime] 포인터 창의 정지 상태 불투명도 ${restingClock}`);
  if (restingClock > 0.01) {
    throw new Error(
      `포인터가 있는 창에서 거터의 시각이 상시로 켜졌다 (${restingClock}): 5분을 ` +
        "덮는 묶음마다 시계를 켜면 타임라인의 밀도가 시계에 먹힌다"
    );
  }

  await context.close();
}

// ---- 6. hover가 없는 기기 (리뷰 W-4) ----------------------------------------

async function exerciseTouch(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  await login(page, { narrow: true });

  if (proveRedRowTime) {
    // red seam: 거터의 시각을 다시 hover에만 맡긴다 = 손가락만 쓰는 사람에게는
    // 그 시각을 여는 제스처가 하나도 없는 상태 (진단 H-3이 폰에서 살아남은 꼴).
    await page.addStyleTag({
      content: "[data-row-clock]{opacity:0!important}",
    });
  }

  const hoverless = await page.evaluate(
    () => window.matchMedia("(hover: none)").matches
  );
  if (!hoverless) {
    throw new Error(
      "이 컨텍스트에 hover가 있다: 「hover 없는 기기」를 재려는 판이 아니다"
    );
  }
  const contRow = rowLocator(page, CONT_MSG);
  await contRow.scrollIntoViewIfNeeded();
  await wait(300);
  const clock = contRow.locator("[data-row-clock]");
  if ((await clock.count()) !== 1) {
    throw new Error("연속 행에 거터의 시각 마크업이 없다");
  }
  const opacity = await clock.evaluate((node) =>
    Number(getComputedStyle(node).opacity)
  );
  const toolbarCount = await contRow
    .locator('[data-testid="message-hover-toolbar"]')
    .count();
  console.log(
    `[touch] 정지 상태 불투명도 ${opacity} · 호버 툴바 ${toolbarCount}개`
  );
  if (opacity < 0.99) {
    throw new Error(
      `a touch reader can never see a row's time: 정지 상태 불투명도가 ${opacity}인데 ` +
        "이 기기에는 hover가 없다. 드러낼 제스처가 없는 것을 hover 뒤에 두면 " +
        "그 기기에서는 없는 기능이다 (리뷰 W-4)"
    );
  }
  if (toolbarCount !== 0) {
    throw new Error(
      `hover 없는 기기에 호버 툴바가 ${toolbarCount}개 있다: 터치에서는 마운트 ` +
        "자체가 없어야 한다 (#1743)"
    );
  }

  await context.close();
}

/** 리뷰용 스크린샷 (SKILL §11). 판정하지 않는다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/fold-nav");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context);
    await login(page);
    // 접힌 긴 답변이 보이는 자리에서, 항법 컨트롤이 떠 있는 상태로 찍는다.
    await rowLocator(page, LONG_MSG).scrollIntoViewIfNeeded();
    await wait(600);
    await page.screenshot({ path: resolve(outDir, `fold-${scheme}.png`) });

    // 펼친 뒤 한 장 더: 접기가 무엇을 미뤘는지가 두 장의 차이로 보인다.
    await rowLocator(page, LONG_MSG).getByTestId("message-fold").click();
    await wait(400);
    await page.screenshot({ path: resolve(outDir, `fold-open-${scheme}.png`) });

    // 항법 한 장: 위로 올라가 읽는 중에 새 메시지가 아래에 쌓인 판.
    await rowLocator(page, LONG_MSG).getByTestId("message-fold").click();
    await settleAtBottom(page);
    await scrollUp(page);
    await publishLive(page, LIVE_MSG, 205, "핫픽스 태그 올렸습니다.");
    // 포커스와 포인터를 모두 치우고 찍는다: virtuoso가 행 노드를 재활용하므로,
    // 접기 컨트롤을 누른 자리에 남은 포커스/커서가 스크롤 뒤에는 엉뚱한 행의
    // hover 띠와 액션 열을 띄운 채로 찍힌다.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.mouse.move(0, 0);
    await wait(200);
    await page.screenshot({ path: resolve(outDir, `jump-${scheme}.png`) });
    await context.close();
  }
  console.log(
    "[shots] artifacts/fold-nav/fold-{light,dark}.png · fold-open-{light,dark}.png" +
      " · jump-{light,dark}.png"
  );
}

async function captureTouchShots(browser) {
  const outDir = resolve(webRoot, "artifacts/fold-nav");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context);
    await login(page, { narrow: true });
    await rowLocator(page, CONT_MSG).scrollIntoViewIfNeeded();
    await wait(400);
    await page.screenshot({ path: resolve(outDir, `touch-clock-${scheme}.png`) });
    await context.close();
  }
  console.log("[shots] artifacts/fold-nav/touch-clock-{light,dark}.png");
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "FOLD_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exercisePointer(browser);
      await exerciseTouch(browser);
      if (process.env.FOLD_GATE_SHOTS === "1") {
        await captureShots(browser);
        await captureTouchShots(browser);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 긴 답변은 예산만큼만 펴고 남은 줄을 숫자로 말했고, 짧은");
  console.log("           답변은 그대로였고, 펼치면 원문이 전부 왔고, 위로 올라간");
  console.log("           사람에게 돌아갈 길이 생겼고, 읽던 화면은 새 메시지에");
  console.log("           밀리지 않았고, hover 없는 기기의 시각은 정지 상태로");
  console.log("           섰고, 컨트롤 없는 행도 키보드의 정거장이 되었다.");
}

await main();
