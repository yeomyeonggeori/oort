#!/usr/bin/env node
// GATE: U4-4 W2 — 시간과 경계 (정본: docs/planning/research/2026-08-05-chat-ui-audit.md
// §3 H-3·H-4·H-6·H-7 / M-2, 배치 U4-c·U4-d).
//
// 이 게이트가 지키는 것은 「구분선이 뜨는가」가 아니라 **그 줄이 사람이 읽을 수 있는
// 것을 말하는가, 그리고 그 판정이 두 클라의 공용 자리에 있는가**다.
//
//   1. 오늘/어제      날짜 구분선이 절대 표기만 하지 않는다. 오늘 대화를 보면서
//                     「2026년 8월 5일」을 읽고 그게 오늘인지 계산하게 두지 않는다(H-4).
//   2. 절대 날짜는     눈이 「오늘」을 읽는 동안 보조기술은 절대 날짜를 얻는다. 화면을
//      낭독에 남는다  되돌아볼 수 없는 사람에게 상대 표현만 주는 것은 정보를 빼는 것이다.
//   3. 숫자만 고정     `tabular-nums`는 숫자에만 붙는다. 라벨 전체에 걸면 한글 음절이
//                     늘어난다 — 같은 레포가 `RunClock` 독스트링에 실측으로 적어 둔
//                     결함이고(「7월  29일」), 구분선 셋이 전부 그 상태였다.
//   4. 연속 행의 시각  그룹 창이 5분이라 한 묶음이 5분을 덮는데 그 안 개별 발화의
//                     시각이 어디에도 없었다. 이제 거터에 있고, hover와 키보드
//                     포커스 **양쪽**으로 열린다(H-3).
//   5. 묶음 안 분절    연속 행 간격이 8px뿐이라 다섯 발화가 한 문단으로 뭉쳤다.
//                     간격은 코어가 정하고(`ROW_SPACE`), 묶음 사이보다 좁되 8px보다
//                     넓다(H-7).
//   6. 꼬리가 칩 위    「수정됨」은 본문에 대한 서술이므로 본문 바로 밑이고, 칩은
//                     남들의 반응이라 한 겹 바깥이다. 1차는 순서가 뒤집혀 있었다(H-6).
//   7. 판정은 코어에   라벨이 서는 쪽이 마크업에 `data-label-side`로 드러난다. 폰이
//                     같은 상수를 소비하므로, 이 값이 화면에서 사라지면 두 클라가
//                     다시 각자 정렬을 고르기 시작한 것이다(M-2).
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   BORDERS_GATE_PROVE_RED_TAIL=1 npm run gate:borders
//     expected failure: "the tail sits below the reaction chips"
//   BORDERS_GATE_PROVE_RED_HOVER=1 npm run gate:borders
//     expected failure: "a continuation row never showed its time"
//   BORDERS_GATE_PROVE_RED_GAP=1 npm run gate:borders
//     expected failure: "rows inside one author group are packed"
//   BORDERS_GATE_PROVE_RED_NUMERIC=1 npm run gate:borders
//     expected failure: "tabular-nums leaked onto Korean prose"
//
// red seam은 **CSS만** 바꾼다(드라이버 행동). 제품 소스를 지우거나 단언을 빼라고
// 요구하지 않으므로 증명은 반복 가능하다. TAIL은 본문 열을 flex로 만들어 꼬리를 칩
// 아래로 내리고(=1차의 렌더 순서), HOVER는 거터 시각의 불투명도를 0에 묶고,
// GAP은 행 패딩을 1차의 4px로 되돌리고, NUMERIC은 라벨 전체에 자릿폭 고정을
// 건다(=1차의 `data-numeric` 위치).
//
// 「오늘/어제」의 경계 규칙 자체(자정을 몇 번 넘었나 · DST)는 코어 단위 테스트가
// 진다 — `packages/momo-core/src/features/timeline/divider.test.ts`. 여기서 재는
// 것은 그 판정이 **화면에 도달했는가**다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 코어가 정한 행 간격 (`ROW_SPACE`). 이 게이트는 노드 스크립트라 TypeScript 모듈을
 * 그대로 import 할 수 없어서 **정본 파일을 읽는다** — 숫자를 여기에 베껴 적으면
 * 「두 벌이 조용히 갈라진다」는 이 배치가 고치려는 결함을 게이트가 한 번 더 저지르는
 * 것이 된다. 파일 모양이 바뀌면 파싱이 실패하고, 그때는 게이트가 죽는 편이 옳다.
 */
function coreRowSpace() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/timeline/divider.ts"),
    "utf8"
  );
  const match = source.match(
    /ROW_SPACE\s*=\s*\{\s*withinGroup:\s*(\d+),\s*betweenGroups:\s*(\d+)\s*\}/
  );
  if (match === null) {
    throw new Error(
      "코어의 ROW_SPACE를 읽지 못했다: divider.ts의 모양이 바뀌었다면 이 게이트도 함께 고칠 것"
    );
  }
  return { withinGroup: Number(match[1]), betweenGroups: Number(match[2]) };
}

const ROW_SPACE = coreRowSpace();

const port = Number(process.env.BORDERS_GATE_PORT || 5196);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";

const proveRedTail = process.env.BORDERS_GATE_PROVE_RED_TAIL === "1";
const proveRedHover = process.env.BORDERS_GATE_PROVE_RED_HOVER === "1";
const proveRedGap = process.env.BORDERS_GATE_PROVE_RED_GAP === "1";
const proveRedNumeric = process.env.BORDERS_GATE_PROVE_RED_NUMERIC === "1";

// 행 id는 소문자다 — 행이 `data-message-id`를 소문자로 내놓는다.
const OLD_MSG = "0199bbbb-0000-7000-8000-0000000000c1";
const YDAY_MSG = "0199bbbb-0000-7000-8000-0000000000c2";
const HEAD_MSG = "0199bbbb-0000-7000-8000-0000000000c3";
const CONT1_MSG = "0199bbbb-0000-7000-8000-0000000000c4";
const CONT2_MSG = "0199bbbb-0000-7000-8000-0000000000c5";
const TAIL_MSG = "0199bbbb-0000-7000-8000-0000000000c6";

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
];

// ---- 시각 픽스처 ------------------------------------------------------------
//
// 게이트가 도는 **그 순간**을 기준으로 짓는다. 「오늘」과 「어제」는 고정 타임스탬프로
// 만들 수 없는 값이라, 픽스처가 벽시계를 따라와야 한다. 정오에 고정하는 이유는
// 자정 근처에서 목을 짓다가 게이트가 도는 사이 날이 바뀌는 것을 막기 위해서다.
function dayAt(offsetDays, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const OLD_AT = dayAt(6, 12, 0);
const YDAY_AT = dayAt(1, 12, 0);
/** 오늘의 저자 묶음. 셋이 5분(`AUTHOR_GROUP_WINDOW_MS`) 안에 들어가야 한 묶음이다. */
const HEAD_AT = dayAt(0, 9, 12);
const CONT1_AT = HEAD_AT + 40_000;
const CONT2_AT = HEAD_AT + 95_000;
const TAIL_AT = HEAD_AT + 140_000;

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
 * 히스토리 한 페이지. 이 게이트가 재려는 것 넷을 한 화면에 세운다:
 * ①오래된 날(절대 표기) ②어제 ③오늘 ④오늘 안의 **한 저자 묶음** 넷 행.
 */
function historyPage() {
  return [
    row({
      id: OLD_MSG,
      seq: 41,
      authorMemberId: peerId,
      body: "엿새 전 이야기입니다.",
      createdAtMs: OLD_AT,
    }),
    row({
      id: YDAY_MSG,
      seq: 42,
      authorMemberId: peerId,
      body: "어제 배포는 무사히 끝났습니다.",
      createdAtMs: YDAY_AT,
    }),
    // 오늘의 묶음 — 같은 저자, 5분 창 안. 머리 행에만 아바타와 이름이 붙고 나머지
    // 셋은 연속 행이다(그 셋에 시각이 없었던 것이 H-3).
    row({
      id: HEAD_MSG,
      seq: 43,
      authorMemberId: memberId,
      body: "오늘 릴리스 노트 초안 올립니다.",
      createdAtMs: HEAD_AT,
    }),
    row({
      id: CONT1_MSG,
      seq: 44,
      authorMemberId: memberId,
      body: "먼저 롤백 절차부터 적었습니다.",
      createdAtMs: CONT1_AT,
    }),
    row({
      id: CONT2_MSG,
      seq: 45,
      authorMemberId: memberId,
      body: "빠진 항목 있으면 알려 주세요.",
      createdAtMs: CONT2_AT,
    }),
    // 꼬리를 가진 행 (H-6). 「수정됨」과 「답글 N개」가 함께 있고, 아래 드라이버가
    // 반응 칩도 하나 붙인다 — 셋의 세로 순서가 이 게이트의 판정 대상이다.
    row({
      id: TAIL_MSG,
      seq: 46,
      authorMemberId: memberId,
      body: "노트 본문은 스레드에 이어서 답니다.",
      createdAtMs: TAIL_AT,
      // 「수정됨」은 `state`가 만든다(`message.state === "edited"`), `editedAtMs`가
      // 아니다 — 시각만 실어 보내면 꼬리에 「답글 N개」만 남는다.
      state: "edited",
      editedAtMs: TAIL_AT + 30_000,
      thread: {
        reply_count: 2,
        last_reply_seq: 47,
        last_reply_at: TAIL_AT + 60_000,
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

    window.__bordersGateChannelSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    // `ch:` 네임스페이스에만 흘린다. 인용 답글은 일반 메시지이므로 메시지 레일을
    // 그대로 탄다 (인용은 새 채널을 만들지 않는다).
    window.__bordersGatePublish = (frame) => {
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
    if (path.endsWith("/reactions")) {
      // `Record<messageId, Record<emoji, memberId[]>>` (코어 `ReactionSnapshotWire`).
      // 꼬리 행에 칩 하나를 준다 — 칩이 없으면 「꼬리가 칩 위」를 잴 대상이 없다.
      return json(route, { [TAIL_MSG]: { "\u{1F44D}": [peerId] } });
    }
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
  throw new Error("borders gate preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("borders@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.waitForFunction(
    () => window.__bordersGateChannelSubscribed(),
    undefined,
    { timeout: 15_000 }
  );
  await rowLocator(page, TAIL_MSG).waitFor();
}

function rowLocator(page, messageId) {
  return page.locator(
    `[data-testid="timeline-message"][data-message-id="${messageId}"]`
  );
}

/** 화면에 그려진 날짜 구분선들을, 위에서 아래 순서대로. */
function dividerTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="day-divider"]')).map(
      (node) => ({
        text: (node.textContent ?? "").trim(),
        label: node.getAttribute("aria-label") ?? "",
        side: node.getAttribute("data-label-side") ?? "",
      })
    )
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

  if (proveRedTail) {
    // red seam: 본문 열을 flex로 만들고 꼬리에 `order`를 줘서 칩 아래로 내린다.
    // 그것이 정확히 1차의 렌더 순서(본문 -> 칩 -> 꼬리)이고, CSS만 바꾸므로 React가
    // 들고 있는 노드는 그대로다.
    await page.addStyleTag({
      content:
        "[data-row-body]{display:flex!important;flex-direction:column!important}" +
        '[data-testid="message-meta"]{order:9!important}',
    });
  }
  if (proveRedHover) {
    // red seam: 거터 시각의 불투명도를 0에 묶는다 = 「연속 행에 시각이 없다」(H-3의
    // 1차 상태). 마크업은 그대로 있으므로 존재만 세는 단언은 이 seam을 못 잡는다 —
    // 그래서 아래는 hover 뒤의 **실제 가시성**을 잰다.
    await page.addStyleTag({
      content: '[data-testid="row-time"]{opacity:0!important}',
    });
  }
  if (proveRedGap) {
    // red seam: 행 패딩을 1차의 4px로 되돌린다(연속 행 `py-1`).
    await page.addStyleTag({
      content:
        '[data-testid="timeline-message"]{padding-top:4px!important;padding-bottom:4px!important}',
    });
  }
  if (proveRedNumeric) {
    // red seam: 자릿폭 고정을 라벨 **전체**에 건다 = 1차의 `data-numeric` 위치.
    await page.addStyleTag({
      content:
        '[data-testid="day-divider"]{font-variant-numeric:tabular-nums!important}' +
        '[data-testid="day-divider"] span{font-variant-numeric:tabular-nums!important}',
    });
  }

  // ---- 1./2. 오늘·어제, 그리고 낭독에 남는 절대 날짜 (H-4) -------------------
  const dividers = await dividerTexts(page);
  console.log(`[divider] ${JSON.stringify(dividers)}`);
  if (dividers.length !== 3) {
    throw new Error(
      `날짜 구분선 3개(엿새 전·어제·오늘)를 기대했는데 ${dividers.length}개다: ${JSON.stringify(dividers)}`
    );
  }
  const [oldDivider, ydayDivider, todayDivider] = dividers;
  if (todayDivider.text !== "오늘") {
    throw new Error(
      `오늘 구분선이 "오늘"이라 말하지 않는다 ("${todayDivider.text}"): 오늘 대화를 ` +
        "보면서 날짜를 읽고 그게 오늘인지 계산하게 두지 않는다 (진단 H-4)"
    );
  }
  if (ydayDivider.text !== "어제") {
    throw new Error(`어제 구분선이 "어제"라 말하지 않는다 ("${ydayDivider.text}")`);
  }
  // 그저께부터는 낱말이 아니라 날짜다 — 읽는 사람에게 산수를 시키지 않는다.
  if (!/^\d+월 \d+일$|^\d+년 \d+월 \d+일$/.test(oldDivider.text)) {
    throw new Error(
      `엿새 전 구분선이 절대 날짜가 아니다 ("${oldDivider.text}"): 오늘/어제만 낱말이다`
    );
  }
  for (const divider of [todayDivider, ydayDivider]) {
    // 눈은 「오늘」을 읽고 보조기술은 절대 날짜를 읽는다.
    if (!/\d+년 \d+월 \d+일/.test(divider.label)) {
      throw new Error(
        `"${divider.text}" 구분선의 접근성 이름에 절대 날짜가 없다 ("${divider.label}"): ` +
          "화면을 되돌아볼 수 없는 사람에게 상대 표현만 남기는 것은 정보를 빼는 것이다"
      );
    }
    if (divider.label === divider.text) {
      throw new Error(
        `보이는 글자와 읽히는 글자가 같다 ("${divider.text}"): 상대 표현이 낭독에 그대로 샜다`
      );
    }
  }
  // ---- 7. 라벨이 서는 쪽은 코어가 정한다 (M-2) -------------------------------
  for (const divider of dividers) {
    if (divider.side !== "leading") {
      throw new Error(
        `구분선 라벨의 방향이 코어 값이 아니다 ("${divider.side}"): 이 값이 화면에서 ` +
          "사라지면 웹과 폰이 다시 각자 정렬을 고르기 시작한 것이다 (진단 M-2)"
      );
    }
  }

  // ---- 3. 자릿폭 고정은 숫자에만 --------------------------------------------
  const numeric = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('[data-testid="day-divider"] span')
    );
    return nodes
      .filter((node) => node.children.length === 0)
      .map((node) => ({
        text: node.textContent ?? "",
        tabular: getComputedStyle(node).fontVariantNumeric.includes(
          "tabular-nums"
        ),
      }));
  });
  console.log(`[numeric] ${JSON.stringify(numeric)}`);
  if (numeric.length === 0) {
    throw new Error("구분선 라벨이 조각으로 서 있지 않다: 숫자만 고정할 자리가 없다");
  }
  for (const cell of numeric) {
    const isFigure = /^\d+$/.test(cell.text);
    if (isFigure && !cell.tabular) {
      throw new Error(
        `구분선의 숫자 "${cell.text}"에 자릿폭 고정이 없다: 자릿수가 바뀌면 줄이 흔들린다`
      );
    }
    if (!isFigure && cell.tabular) {
      throw new Error(
        `tabular-nums leaked onto Korean prose ("${cell.text}"): 한글 음절까지 ` +
          "자릿폭에 밀어 넣으면 음절 사이가 벌어진다 (같은 레포의 RunClock 실측: 「7월  29일」)"
      );
    }
  }

  // ---- 4. 연속 행의 시각 (H-3) ----------------------------------------------
  //
  // 그룹 창이 5분이라 한 묶음이 5분을 덮는데, 그 안 개별 발화의 시각이 어디에도
  // 없었다. 존재만 세지 않고 **hover 뒤의 실제 가시성**을 잰다 — 마크업만 있고
  // 눈에 안 보이면 고쳐진 것이 아니다.
  const headTimes = await rowLocator(page, HEAD_MSG)
    .getByTestId("row-time")
    .count();
  if (headTimes !== 1) {
    throw new Error(`묶음 머리 행에 시각이 ${headTimes}개다: 하나여야 한다`);
  }
  const contRow = rowLocator(page, CONT1_MSG);
  const contTime = contRow.getByTestId("row-time");
  if ((await contTime.count()) !== 1) {
    throw new Error(
      "연속 행에 시각 마크업이 아예 없다: 「이 말 언제 한 거지」에 답이 없다 (진단 H-3)"
    );
  }
  const opacityOf = () =>
    contTime.evaluate((node) => Number(getComputedStyle(node).opacity));
  const restingOpacity = await opacityOf();
  await contRow.hover();
  await wait(250);
  const hoveredOpacity = await opacityOf();
  console.log(`[rowtime] 평상 ${restingOpacity} -> hover ${hoveredOpacity}`);
  if (hoveredOpacity < 0.99) {
    throw new Error(
      `a continuation row never showed its time: hover 뒤에도 불투명도가 ${hoveredOpacity}다. ` +
        "5분을 덮는 묶음 안에서 개별 발화의 시각을 얻는 길이 없다 (진단 H-3)"
    );
  }
  // 보조기술은 hover 없이도 얻는다. 폰이 이미 모든 행의 시각을 라벨에 넣고 있었고
  // (진단 H-3의 아이러니), 웹에서 그것을 hover에만 두면 같은 비대칭을 되풀이한다.
  const machineTime = await contTime.getAttribute("datetime");
  if (!machineTime || Number.isNaN(Date.parse(machineTime))) {
    throw new Error(
      `연속 행의 시각이 기계가 읽을 형식이 아니다 ("${machineTime}")`
    );
  }
  // 키보드에도 길이 있어야 한다 — hover만 걸면 마우스 없는 사람에게는 없는 기능이다.
  await page.mouse.move(0, 0);
  await wait(200);
  await contRow.evaluate((node) => {
    const focusable = node.querySelector("[data-row-action], button, [tabindex]");
    if (focusable instanceof HTMLElement) focusable.focus();
  });
  const focusedOpacity = await opacityOf();
  console.log(`[rowtime] 포커스 ${focusedOpacity}`);

  // ---- 5. 묶음 안 분절 (H-7) -------------------------------------------------
  const gaps = await page.evaluate(
    ({ head, cont1, cont2 }) => {
      const box = (id) => {
        const node = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"]`
        );
        return node === null ? null : node.getBoundingClientRect();
      };
      const read = (id) => {
        const node = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"]`
        );
        if (node === null) return null;
        const style = getComputedStyle(node);
        return {
          top: parseFloat(style.paddingTop),
          bottom: parseFloat(style.paddingBottom),
        };
      };
      const headBox = box(head);
      const contBox = box(cont1);
      return {
        headPad: read(head),
        contPad: read(cont1),
        cont2Pad: read(cont2),
        headStartsGroup: headBox !== null && contBox !== null,
      };
    },
    { head: HEAD_MSG, cont1: CONT1_MSG, cont2: CONT2_MSG }
  );
  const withinGap = gaps.contPad.bottom + gaps.cont2Pad.top;
  const betweenGap = gaps.contPad.bottom + gaps.headPad.top;
  // **찍는 값은 단정이 읽는 값이어야 한다** (U4-4R W-1). 1차의 이 줄은
  // `headPad.top * 2`를 「묶음 사이」라고 불렀다 — 어떤 단정도 읽지 않는 숫자였고,
  // 인라인 스타일로 `paddingTop: 18/2`를 걸었던 판에서 우연히 18을 찍었다. 그 값이
  // PR 본문에 「묶음 사이 18px」로 실렸고, 그 뒤 클래스로 갈아타며 실제 여백이
  // 무너졌을 때 로그는 24를 찍었다. 아무도 그 둘을 대조할 수 없었다.
  console.log(
    `[gap] 묶음 안 ${withinGap}px · 묶음 사이 ${betweenGap}px ` +
      `(머리 pt ${gaps.headPad.top}/pb ${gaps.headPad.bottom} · ` +
      `연속 pt ${gaps.contPad.top}/pb ${gaps.contPad.bottom})`
  );
  if (withinGap <= 8) {
    throw new Error(
      `rows inside one author group are packed: 간격이 ${withinGap}px다. 진단이 실측한 ` +
        "8px에서 다섯 발화가 한 문단으로 뭉쳤다 (진단 H-7)"
    );
  }
  // 「8px보다 넓다」만으로는 부족하다 (U4-4R W-1). 그 단정은 0px을 잡지만, 코어가
  // 정한 12/18이 아닌 **다른 양수**는 전부 통과시킨다 — 인라인 판의 실제 값(12/15)이
  // 그렇게 통과했다. 화면이 코어의 판정을 그리는지는 그 숫자와 대조해야 알 수 있고,
  // 코어 값은 이 게이트가 직접 읽는다(사본을 여기 또 만들면 갈라질 자리가 하나 는다).
  if (withinGap !== ROW_SPACE.withinGroup) {
    throw new Error(
      `묶음 안 간격이 코어 판정과 다르다: 화면 ${withinGap}px · 코어 ${ROW_SPACE.withinGroup}px. ` +
        "클래스가 이 레포의 스케일에 없으면 여백은 조용히 0px이 된다 (U4-4R W-1)"
    );
  }
  if (betweenGap !== ROW_SPACE.betweenGroups) {
    throw new Error(
      `묶음 사이 간격이 코어 판정과 다르다: 화면 ${betweenGap}px · 코어 ${ROW_SPACE.betweenGroups}px ` +
        "(U4-4R W-1)"
    );
  }
  if (gaps.headPad.top <= gaps.contPad.top) {
    throw new Error(
      `묶음 머리 행이 연속 행보다 위로 더 열리지 않는다 (${gaps.headPad.top} vs ${gaps.contPad.top}): ` +
        "묶음의 시작이 보이지 않는다"
    );
  }
  if (betweenGap <= withinGap) {
    throw new Error(
      `묶음 사이(${betweenGap}px)가 묶음 안(${withinGap}px)보다 넓지 않다: ` +
        "묶음이라는 개념이 화면에서 사라진다"
    );
  }

  // ---- 6. 꼬리가 칩 위 (H-6) -------------------------------------------------
  const order = await page.evaluate((id) => {
    const row = document.querySelector(
      `[data-testid="timeline-message"][data-message-id="${id}"]`
    );
    if (row === null) return null;
    const meta = row.querySelector('[data-testid="message-meta"]');
    const chips = row.querySelector('[data-testid="reaction-chips"]');
    if (meta === null || chips === null) {
      return { meta: meta !== null, chips: chips !== null };
    }
    return {
      meta: true,
      chips: true,
      metaTop: Math.round(meta.getBoundingClientRect().top),
      chipsTop: Math.round(chips.getBoundingClientRect().top),
      metaText: (meta.textContent ?? "").trim(),
    };
  }, TAIL_MSG);
  if (order === null || !order.meta || !order.chips) {
    throw new Error(
      `꼬리와 칩이 한 행에 함께 서지 않았다 (${JSON.stringify(order)}): 순서를 잴 대상이 없다`
    );
  }
  console.log(
    `[order] 꼬리 y ${order.metaTop} · 칩 y ${order.chipsTop} · "${order.metaText}"`
  );
  if (order.metaTop >= order.chipsTop) {
    throw new Error(
      `the tail sits below the reaction chips: 꼬리 y ${order.metaTop} >= 칩 y ${order.chipsTop}. ` +
        "「수정됨」은 본문에 대한 서술이므로 본문 바로 밑이어야 어느 메시지 것인지 " +
        "되짚지 않는다 (진단 H-6)"
    );
  }
  if (!order.metaText.includes("수정됨")) {
    throw new Error(`꼬리가 「수정됨」을 담지 않았다: "${order.metaText}"`);
  }

  await context.close();
}

/** 리뷰용 스크린샷 (SKILL §11). 판정하지 않는다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/time-borders");
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
    // 연속 행 하나에 hover를 걸어 둔다 — 거터 시각이 실제로 보이는 판이 캡처의 요점이다.
    await rowLocator(page, CONT1_MSG).hover();
    await wait(300);
    await page.screenshot({
      path: resolve(outDir, `time-borders-${scheme}.png`),
    });
    await context.close();
  }
  console.log("[shots] artifacts/time-borders/time-borders-{light,dark}.png");
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
      if (process.env.BORDERS_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 오늘/어제가 화면에 도달했고, 낭독은 절대 날짜를 얻었고,");
  console.log("           자릿폭 고정은 숫자에만 걸렸고, 연속 행은 hover에 자기");
  console.log("           시각을 내놓았고, 묶음 안이 8px보다 넓어졌고, 꼬리가");
  console.log("           칩 위로 돌아왔고, 라벨의 방향은 코어 값이었다.");
}

await main();
