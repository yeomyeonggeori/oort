#!/usr/bin/env node
// GATE: U4-6W — 컴포저의 완성·문장의 격·경계의 색·묘비의 접힘
// (정본: research/2026-08-05-chat-ui-audit.md §4 U4-f(H-10·M-7)·H-11 /
//  research/2026-08-05-u44-design-review.md M-3·D-2·C-1 /
//  research/2026-08-06-u45-design-review.md M-1 / 이슈 1100 이탈 1)
//
// 이 게이트가 지키는 것은 「기능이 있는가」가 아니라 **그것이 사람에게 참인가**다.
//
//   1. 쓰던 글은         채널을 옮겨도, 창을 다시 열어도 남는다. 보내면 사라진다 —
//      사라지지 않는다   화면에 없는 글이 저장소에 남으면 다음 방문에 유령이 온다.
//   2. 못 보낼 때는      연결이 끊기면 전송이 막히고 **왜**가 화면에 있다. 입력창은
//      막고 말한다       잠기지 않는다: 쓰는 것까지 막을 이유가 없고, 그동안 쓴
//                        글은 1번이 지킨다.
//   3. 상자는 접힌 줄도  줄바꿈 없는 한 문단이 창 폭에서 세 줄로 접히면 상자도
//      따라 자란다       세 줄이 된다. 앞 판은 `\n`만 세어 이 경우를 못 봤다.
//   4. 배운 사람에게     ↵로 한 번 보내면 키 배치 설명이 사라진다.
//      다시 가르치지 않는다
//   5. 카드의 세 문장이  영수증 > 오프라인 > 안내. 격이 다르면 옷도 다르다 —
//      같은 옷을 입지 않는다  앞 판은 셋 다 `text-meta text-ink-muted` 한 벌이었다.
//   6. 경계의 색이       안읽음 구분선의 라벨과 rule이 같은 색이고, 그 색은 조용한
//      계약이다          표지와도 에이전트 정체와도 위험과도 다르다.
//   7. 복구 표지가       화면에 seq가 없고, 낭독은 「이 줄 위까지」로 그 자리를
//      내부 어휘를 안 쓴다  말로 되돌려 받는다. 진단 값(`data-seq`)은 남는다.
//   8. 지워진 것들이     연속 묘비는 한 줄로 접히고 그 줄이 몇 개를 대신하는지
//      자리를 덜 먹는다  말한다. 그리고 접힌 원본을 겨눈 인용은 **그것을 대신해
//                        서 있는 행**에 착지한다 (이슈 1105가 고친 거짓 지시).
//   9. 손가락이 닿는다   hover 없는 기기에서 접기 토글의 타깃이 24px 이상이다
//                        (WCAG 2.5.8).
//  10. 아바타가 얼굴이다 32px, 사람과 에이전트가 모양으로도 갈리고, 명부에 없는
//                        작성자는 uuid 첫 글자를 이니셜인 척 그리지 않는다.
//  11. 빈 채널의 첫 문이  메시지 0인 채널에서 맨 앞에 서는 액션이 「첫 메시지
//      이 컴포저다        쓰기」이고, 누르면 캐럿이 이 컴포저에 온다. 멤버 추가는
//      (#1536)            지워지지 않고 뒤에 서며, 위계는 채움 순서로 잰다.
//
// 이름 붙은 red proof (전부 CSS/DOM/저장소만 건드린다 — 제품 소스는 그대로다):
//   COMPOSER_GATE_PROVE_RED_DRAFT=1     "a half-written message did not survive"
//   COMPOSER_GATE_PROVE_RED_OFFLINE=1   "the composer never says why it will not send"
//   COMPOSER_GATE_PROVE_RED_GROW=1      "a wrapped paragraph does not grow the box"
//   COMPOSER_GATE_PROVE_RED_TOMBSTONE=1 "the fold hides a count it refuses to state"
//   COMPOSER_GATE_PROVE_RED_STANDIN=1   "a quote into a folded tombstone lands nowhere"
//   COMPOSER_GATE_PROVE_RED_TAP=1       "a finger cannot reliably hit the fold toggle"
//   COMPOSER_GATE_PROVE_RED_FIRST_ACTION=1
//     "an empty channel offers no door to the first message" — 실측 F5 당시의
//     화면 그대로다: 첫 행동 버튼을 DOM에서 걷어내면 멤버 추가 하나만 남는다.
//
// 값의 정본은 소스를 읽는다(`--touch-target`, `AVATAR_SIZE`). 여기 베껴 적으면
// 두 벌이 조용히 갈라지고, 이 레포는 U4-4R W-2에서 그 값을 이미 치렀다.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 24px 최소 타깃의 정본은 `tokens.css` 다. */
function touchTargetPx() {
  const css = readFileSync(resolve(webRoot, "src/design/tokens.css"), "utf8");
  const match = css.match(/--touch-target:\s*(\d+)px/);
  if (match === null) {
    throw new Error("tokens.css의 --touch-target을 읽지 못했다");
  }
  return Number(match[1]);
}

/** 아바타 지름의 정본은 코어다. */
function avatarSizePx() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/workspace/avatar.ts"),
    "utf8"
  );
  const match = source.match(/export const AVATAR_SIZE = (\d+);/);
  if (match === null) {
    throw new Error("코어의 AVATAR_SIZE를 읽지 못했다");
  }
  return Number(match[1]);
}

/**
 * 오프라인 문장의 정본도 코어다 (U4-6 리뷰 H-1).
 *
 * 이 게이트는 문장 조각("쓰던 글은 그대로 남습니다")을 손으로 적고 있었고, 그
 * 조각은 **웹만 쓰던 판**의 것이었다. 리뷰가 두 클라의 갈라짐을 실측해 값이
 * 코어로 올라간 순간, 손으로 적힌 조각은 화면을 지키는 것이 아니라 화면이
 * 고쳐지는 것을 막는 쪽이 된다. 아바타 지름과 같은 방법으로 읽는다.
 */
function composerOfflineCopy() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/chat/composerCopy.ts"),
    "utf8"
  );
  const match = source.match(
    /export const COMPOSER_OFFLINE_COPY\s*=\s*"([^"]+)"/
  );
  if (match === null) {
    throw new Error("코어의 COMPOSER_OFFLINE_COPY를 읽지 못했다");
  }
  return match[1];
}

/**
 * 빈 대화가 내놓는 두 액션의 라벨. 정본은 코어다 (#1536) — 오프라인 문장과 같은
 * 이유로, 그리고 같은 방법으로 읽는다. 여기 손으로 적으면 이 게이트는 화면을
 * 지키는 것이 아니라 화면의 문장이 고쳐지는 것을 막는 쪽이 된다.
 */
function emptyActionLabels() {
  const source = readFileSync(
    resolve(webRoot, "../../packages/momo-core/src/features/timeline/model.ts"),
    "utf8"
  );
  const read = (name) => {
    const match = source.match(
      new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`)
    );
    if (match === null) throw new Error(`코어의 ${name}을 읽지 못했다`);
    return match[1];
  };
  return {
    write: read("EMPTY_WRITE_ACTION_LABEL"),
    addMember: read("EMPTY_ADD_MEMBER_ACTION_LABEL"),
  };
}

const TOUCH_TARGET = touchTargetPx();
const AVATAR_SIZE = avatarSizePx();
const COMPOSER_OFFLINE_COPY = composerOfflineCopy();
const EMPTY_ACTIONS = emptyActionLabels();

const port = Number(process.env.COMPOSER_GATE_PORT || 5198);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelA = "00000000-0000-7000-8000-000000000201";
const channelB = "00000000-0000-7000-8000-000000000202";

const proveRedDraft = process.env.COMPOSER_GATE_PROVE_RED_DRAFT === "1";
const proveRedOffline = process.env.COMPOSER_GATE_PROVE_RED_OFFLINE === "1";
const proveRedGrow = process.env.COMPOSER_GATE_PROVE_RED_GROW === "1";
const proveRedTombstone = process.env.COMPOSER_GATE_PROVE_RED_TOMBSTONE === "1";
const proveRedStandIn = process.env.COMPOSER_GATE_PROVE_RED_STANDIN === "1";
const proveRedTap = process.env.COMPOSER_GATE_PROVE_RED_TAP === "1";
const proveRedFirstAction =
  process.env.COMPOSER_GATE_PROVE_RED_FIRST_ACTION === "1";

// 접힐 묘비 넷과, 그중 하나를 가리키는 인용 답글.
const TOMB_HEAD = "0199cccc-0000-7000-8000-0000000000c1";
const TOMB_2 = "0199cccc-0000-7000-8000-0000000000c2";
const TOMB_3 = "0199cccc-0000-7000-8000-0000000000c3";
const TOMB_4 = "0199cccc-0000-7000-8000-0000000000c4";
const QUOTING_MSG = "0199cccc-0000-7000-8000-0000000000c9";
const LONG_MSG = "0199cccc-0000-7000-8000-0000000000d1";
const APPROVAL_MSG = "0199cccc-0000-7000-8000-0000000000e1";
const FOLDABLE_MSG = "0199cccc-0000-7000-8000-0000000000e2";

/** 접기 예산을 넘기는 답변 하나. 9번(터치 타깃)이 겨누는 컨트롤이 여기서 난다. */
const FOLDABLE_BODY = [
  "드레인 로그 전문입니다.",
  "",
  "```sh",
  ...Array.from(
    { length: 40 },
    (_, i) => `2026-08-06T09:1${i % 10}:00Z drain batch=${i + 1} lag=12ms`
  ),
  "```",
].join("\n");

/** 줄바꿈이 하나도 없는 한 문단. 이것이 자라야 3번이 참이다. */
const WRAPPED_PARAGRAPH =
  "배포 롤백의 원인은 outbox drain 워커가 배치 크기를 200으로 올린 뒤부터 " +
  "커넥션 풀을 다 쓰고 있었다는 점이고, 그래서 relay가 프레임을 놓친 구간이 " +
  "정확히 그 시간대와 겹칩니다. 배치 크기를 되돌리고 풀 상한을 함께 올리는 " +
  "쪽으로 정리하겠습니다. 재현 절차와 대시보드 링크는 스레드에 이어서 " +
  "남기고, 되돌린 뒤의 지연 곡선은 내일 아침에 다시 확인하겠습니다.";

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
  realtimeWebSocketUrl: "ws://composer-gate.invalid/connection/websocket",
};

function member(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 2,
    channelIds: [channelA, channelB],
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
    id: channelA,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    muted: false,
  },
  {
    id: channelB,
    workspaceId,
    kind: "public",
    name: "infra-alerts",
    muted: false,
  },
];

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

const FIRST_AT = todayAt(9, 0);

function row(channelId, over) {
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
 * 승인 요청 한 건. 모양은 `AgentGatewayRoutes.approvalRequestProps` 이고,
 * 불투명하게 남아야 할 필드(`arguments`·`tool_grant`)도 함께 실어 그것들이
 * 화면에 새지 않는 것까지 이 판에서 본다.
 */
function approvalRow() {
  return row(channelA, {
    id: APPROVAL_MSG,
    seq: 250,
    authorMemberId: agentId,
    type: "approval_request",
    body: "승인 필요: 빌드 캐시 정리",
    createdAtMs: FIRST_AT + 20 * 600_000,
    props: {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      channel_id: channelA,
      action_type: "shell",
      tier: "workspace_write",
      call_id: "call_9f31",
      tool_name: "shell",
      title: "빌드 캐시 정리",
      summary: "빌드 산출물 디렉터리를 지웁니다.",
      arguments: { command: "rm -rf build/", cwd: "/tmp/gate" },
      tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
      status: "pending",
      source: "hermes_gateway",
    },
  });
}

const FILLER = 8;

function pageA() {
  const rows = [];
  for (let i = 0; i < FILLER; i++) {
    rows.push(
      row(channelA, {
        id: `0199cccc-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
        seq: 100 + i,
        authorMemberId: i % 2 === 0 ? peerId : memberId,
        body: `릴리스 점검 ${i + 1}: 스테이징 확인했습니다.`,
        createdAtMs: FIRST_AT + i * 600_000,
      })
    );
  }
  const base = FIRST_AT + FILLER * 600_000;
  rows.push(
    // 긴 한 문단 — 접기 예산 아래로 짧게 유지해 접기 컨트롤이 붙지 않는다.
    row(channelA, {
      id: LONG_MSG,
      seq: 200,
      authorMemberId: agentId,
      body: WRAPPED_PARAGRAPH,
      createdAtMs: base,
    }),
    approvalRow(),
    row(channelA, {
      id: FOLDABLE_MSG,
      seq: 255,
      authorMemberId: agentId,
      body: FOLDABLE_BODY,
      createdAtMs: base + 900_000,
    }),
    // 한 저자의 묘비 넷. 첫 번째가 묶음의 머리이고 나머지 셋이 그 밑으로 접힌다.
    row(channelA, {
      id: TOMB_HEAD,
      seq: 260,
      authorMemberId: memberId,
      body: null,
      state: "deleted",
      createdAtMs: base + 1_200_000,
    }),
    row(channelA, {
      id: TOMB_2,
      seq: 261,
      authorMemberId: memberId,
      body: null,
      state: "deleted",
      createdAtMs: base + 1_240_000,
    }),
    row(channelA, {
      id: TOMB_3,
      seq: 262,
      authorMemberId: memberId,
      body: null,
      state: "deleted",
      createdAtMs: base + 1_280_000,
    }),
    row(channelA, {
      id: TOMB_4,
      seq: 263,
      authorMemberId: memberId,
      body: null,
      state: "deleted",
      createdAtMs: base + 1_320_000,
    }),
    // 접힌 묘비 하나(TOMB_3)를 가리키는 인용. 서버가 원본 스냅샷을 동봉한다.
    row(channelA, {
      id: QUOTING_MSG,
      seq: 264,
      authorMemberId: peerId,
      body: "이거 왜 지웠어요?",
      createdAtMs: base + 1_400_000,
      replyToId: TOMB_3,
      replyTo: {
        id: TOMB_3,
        seq: 262,
        authorMemberId: memberId,
        state: "deleted",
        body: null,
        createdAtMs: base + 1_280_000,
      },
    })
  );
  return rows;
}

function pageB() {
  return [
    row(channelB, {
      id: "0199bbbb-0000-7000-8000-000000000001",
      seq: 10,
      authorMemberId: peerId,
      body: "알림 라우팅 규칙 정리했습니다.",
      createdAtMs: FIRST_AT,
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
              connect: { client: "composer-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "composer-gate",
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
    window.__composerGateDropSocket = () => {
      for (const socket of [...sockets]) {
        socket.readyState = GateWebSocket.CLOSED;
        sockets.delete(socket);
        socket.onclose?.(new CloseEvent("close", { code: 1006 }));
      }
    };
    window.__composerGateSubscribed = () => {
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (name.startsWith("ch:")) return true;
        }
      }
      return false;
    };
    void offset;
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
    if (path.endsWith("/read-state")) {
      if (request.method() !== "GET") return json(route, {});
      // 안읽음 경계를 세운다 (D-2를 잴 판). 커서는 묘비 묶음 **앞**에 두어 구분선이
      // 접힌 줄 위에 서게 한다 — 두 표지가 같은 화면에 함께 있어야 색을 대조한다.
      return json(route, {
        read_states: [
          {
            channel_id: channelA,
            last_read_seq: 250,
            latest_seq: 264,
            unread_count: 5,
            mention_count: 0,
          },
        ],
      });
    }
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.endsWith("/decision")) {
      // 원장이 답한 영수증. 여기서 200을 주므로 카드가 「승인을 기록했습니다」를
      // 말할 수 있다 — 그 문장이 M-3이 「가장 값어치 있는 문장」이라 부른 줄이다.
      return json(route, {
        approval_id: "0199aa11-2222-7000-8000-0000000000a1",
        status: "approved",
        decided_by: memberId,
        decided_at_ms: Date.now(),
      });
    }
    if (path.includes("/approvals")) {
      // 원장 표면은 있다: 카드가 결정 컨트롤을 세울 수 있는 판.
      return json(route, { approvals: [] });
    }

    if (path.endsWith("/messages")) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const inB = path.includes(channelB);
        return json(
          route,
          row(inB ? channelB : channelA, {
            id: "0199cccc-0000-7000-8000-0000000000f1",
            seq: 300,
            authorMemberId: memberId,
            body: body.body,
            createdAtMs: Date.now(),
          })
        );
      }
      if (url.searchParams.has("after") || url.searchParams.has("before")) {
        return json(route, { messages: [] });
      }
      return json(route, {
        messages: path.includes(channelB) ? pageB() : pageA(),
      });
    }

    return json(route, {});
  });
}

function rowLocator(page, messageId) {
  return page.locator(
    `[data-testid="timeline-message"][data-message-id="${messageId.toLowerCase()}"]`
  );
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByTestId("login-email").fill("composer@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
}

async function openChannel(page, channelId) {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, channelId);
  await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => window.__composerGateSubscribed(), undefined, {
    timeout: 15_000,
  });
  await wait(400);
}

function boxHeight(locator) {
  return locator.evaluate((node) => Math.round(node.getBoundingClientRect().height));
}

function colorOf(locator) {
  return locator.evaluate((node) => getComputedStyle(node).color);
}

// ---- 1~4. 컴포저 (포인터가 있는 창) -----------------------------------------

async function exerciseComposer(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  await login(page);
  await openChannel(page, channelA);

  const input = page.getByTestId("composer-input");
  const send = page.getByTestId("composer-send");

  // ---- 4. 키 배치 설명은 처음에는 있다 --------------------------------------
  const keysHint = page.getByTestId("composer-keys-hint");
  if ((await keysHint.count()) !== 1) {
    throw new Error(
      "↵가 전송이 된 앱인데 그 사실을 말하는 줄이 첫 화면에 없다: 바뀐 키가 " +
        "어디로 갔는지는 그 자리에서 말해야 한다 (goal B8)"
    );
  }

  // ---- 3. 접힌 줄도 함께 자란다 (진단 H-10) ---------------------------------
  const oneLine = await boxHeight(input);
  if (proveRedGrow) {
    // red seam: 상자 높이를 한 줄에 못 박는다 = `\n`만 세던 앞 판의 상태.
    await page.addStyleTag({
      content: `[data-testid="composer-input"]{height:${oneLine}px!important}`,
    });
  }
  await input.fill(WRAPPED_PARAGRAPH);
  await wait(200);
  const wrappedHeight = await boxHeight(input);
  const lineHeight = await input.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).lineHeight)
  );
  console.log(
    `[grow] 한 줄 ${oneLine}px -> 감긴 한 문단 ${wrappedHeight}px (행간 ${lineHeight}px, 개행 0개)`
  );
  // 여유 2px: 한 줄 높이도 상자 높이도 정수로 반올림되므로, 정확히 한 줄만큼
  // 자란 경우가 산술적으로 1~2px 모자라게 측정될 수 있다. 재려는 것은 「한 줄
  // 이상 자랐는가」이지 픽셀 단위의 일치가 아니다.
  if (wrappedHeight < oneLine + lineHeight - 2) {
    throw new Error(
      "a wrapped paragraph does not grow the box: 줄바꿈이 하나도 없는 한 문단이 " +
        `창 폭에서 여러 줄로 접혔는데 상자는 ${wrappedHeight}px 그대로다. 한국어 ` +
        "메시지는 대개 이 모양으로 오고, `\\n`을 세는 구현은 그 전부를 못 본다 " +
        "(진단 H-10)"
    );
  }

  // ---- 1. 초안은 채널을 옮겨도 남는다 ---------------------------------------
  if (proveRedDraft) {
    // red seam: 저장소를 지운다 = 본문이 `useState`에만 있던 상태.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("momo.draft.")) localStorage.removeItem(key);
      }
      const noop = () => {};
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patched(key, value) {
        if (String(key).startsWith("momo.draft.")) return noop();
        return original.call(this, key, value);
      };
    });
    await input.fill("");
    await input.fill(WRAPPED_PARAGRAPH);
    await wait(200);
  }
  await openChannel(page, channelB);
  const inB = await input.inputValue();
  if (inB !== "") {
    throw new Error(
      `다른 채널의 초안이 이 채널 입력창에 있다 ("${inB.slice(0, 20)}…"): 초안은 ` +
        "채널의 것이고, 섞이면 사람이 고르지 않은 방에 글이 나간다"
    );
  }
  await openChannel(page, channelA);
  const restored = await input.inputValue();
  console.log(`[draft] 채널 왕복 뒤 복원 ${restored.length}자`);
  if (restored !== WRAPPED_PARAGRAPH) {
    throw new Error(
      "a half-written message did not survive: 채널을 옮겼다 돌아왔더니 쓰던 글이 " +
        `없다(${restored.length}자 / 원래 ${WRAPPED_PARAGRAPH.length}자). 보낸 ` +
        "메시지는 지워도 원장에 남지만, 안 보낸 글은 어디에도 없다 (진단 H-10)"
    );
  }

  // 창을 다시 열어도 남는다 — `sessionStorage`였다면 여기서 사라진다.
  await page.reload({ waitUntil: "networkidle" });
  await openChannel(page, channelA);
  const afterReload = await input.inputValue();
  console.log(`[draft] 새로고침 뒤 복원 ${afterReload.length}자`);
  if (afterReload !== WRAPPED_PARAGRAPH) {
    throw new Error(
      `새로고침에 초안이 사라졌다(${afterReload.length}자): 데스크톱 셸에서는 창을 ` +
        "닫는 것이 곧 앱을 닫는 것이라, 「내일 이어서 쓴다」가 통째로 없어진다"
    );
  }

  // ---- 2. 연결이 끊기면 막고, 말한다 (진단 H-10) ---------------------------
  await context.setOffline(true);
  await wait(400);
  if (proveRedOffline) {
    // red seam: 왜 못 보내는지 말하는 줄을 지운다. 버튼은 여전히 비활성이므로
    // 남는 것은 「눌러도 아무 일이 없는데 이유가 없는」 화면이다.
    await page.addStyleTag({
      content: '[data-testid="composer-offline"]{display:none!important}',
    });
  }
  const offlineLine = page.getByTestId("composer-offline");
  const sendDisabled = await send.isDisabled();
  const inputDisabled = await input.isDisabled();
  const offlineVisible = await offlineLine.isVisible().catch(() => false);
  console.log(
    `[offline] 전송 disabled=${sendDisabled} · 입력창 disabled=${inputDisabled} · 고지 ${offlineVisible}`
  );
  if (!sendDisabled) {
    throw new Error(
      "연결이 끊겼는데 전송 버튼이 살아 있다: 누르면 실패 행 하나를 만들고 끝난다"
    );
  }
  if (inputDisabled) {
    throw new Error(
      "오프라인이라고 입력창까지 잠겼다: 연결이 끊겼다고 글을 못 쓸 이유가 없고, " +
        "그동안 쓴 것은 초안이 지킨다"
    );
  }
  if (!offlineVisible) {
    throw new Error(
      "the composer never says why it will not send: 비활성 버튼은 자기가 왜 " +
        "비활성인지 말하지 못하고, `title`은 포인터가 있어야 열린다"
    );
  }
  const offlineCopy = ((await offlineLine.textContent()) ?? "").trim();
  if (offlineCopy !== COMPOSER_OFFLINE_COPY) {
    throw new Error(
      `오프라인 문장이 코어의 문장이 아니다 ("${offlineCopy}"): 기다리라고만 하고 ` +
        "기다리는 동안 쓴 글을 잃게 하면 그 문장은 거짓이 되고, 폰과 다른 말을 " +
        `하면 같은 앱의 말이 아니다 — 정본은 "${COMPOSER_OFFLINE_COPY}"`
    );
  }
  await context.setOffline(false);
  await wait(600);
  if (await send.isDisabled()) {
    throw new Error("연결이 돌아왔는데 전송이 여전히 막혀 있다");
  }

  // ---- 4. ↵로 한 번 보내면 설명이 사라진다 (감사 M-7) ----------------------
  await input.click();
  await page.keyboard.press("Enter");
  await wait(600);
  const hintAfterSend = await page.getByTestId("composer-keys-hint").count();
  const draftAfterSend = await input.inputValue();
  console.log(
    `[hint] ↵ 전송 뒤 키 힌트 ${hintAfterSend}개 · 입력창 ${draftAfterSend.length}자`
  );
  if (hintAfterSend !== 0) {
    throw new Error(
      "↵로 보낸 사람에게 ↵가 무엇인지 계속 설명한다: 두 번째 메시지부터는 읽을 " +
        "필요 없는 문장이 계속 자리를 차지한다 (감사 M-7)"
    );
  }
  if (draftAfterSend !== "") {
    throw new Error("보냈는데 입력창에 글이 남았다");
  }
  const storedAfterSend = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("momo.draft.")).length
  );
  if (storedAfterSend !== 0) {
    throw new Error(
      `보낸 뒤에도 초안이 저장소에 남았다(${storedAfterSend}건): 다음 방문에 방금 ` +
        "보낸 문장이 입력창에 복원돼 두 번 보내진다"
    );
  }

  await context.close();
}

// ---- 5~8. 타임라인 (문장의 격·경계의 색·복구 어휘·묘비의 접힘) ---------------

async function exerciseTimeline(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  await login(page);
  await openChannel(page, channelA);

  // ---- 8. 연속 묘비는 한 줄로 접힌다 (감사 M-1 · 코어 승격) -----------------
  if (proveRedTombstone) {
    // red seam: 접힌 개수를 숨긴다 = 「접었으면서 몇 개인지 말하지 않는」 상태.
    await page.addStyleTag({
      content: '[data-testid="tombstone"] [data-numeric]{display:none!important}',
    });
  }
  const tombstones = page.locator('[data-testid="tombstone"]');
  const tombCount = await tombstones.count();
  const headRow = rowLocator(page, TOMB_HEAD);
  const repeat = Number(
    await headRow.locator('[data-testid="tombstone"]').getAttribute("data-deleted-repeat")
  );
  // `innerText` 다: `textContent` 는 `display:none` 인 조각까지 읽어서, 화면에
  // 없는 숫자를 「말했다」고 셈한다. 이 줄이 재려는 것은 **눈에 닿는 문장**이다.
  const tombText = (
    await tombstones.first().evaluate((node) => node.innerText)
  ).trim();
  console.log(
    `[deleted] 묘비 4개 심음 -> 화면 ${tombCount}줄 · 머리 행이 대신하는 수 ${repeat} · "${tombText}"`
  );
  if (tombCount !== 1) {
    throw new Error(
      `연달아 지워진 메시지 넷이 ${tombCount}줄로 서 있다: 지워진 것들이 지워지지 ` +
        "않은 것들만큼 자리를 차지한다 (감사 M-1). 묘비는 메시지에 **대한** " +
        "서술이지 메시지가 아니다"
    );
  }
  if (repeat !== 4) {
    throw new Error(`살아남은 행이 대신하는 수가 4가 아니라 ${repeat}이다`);
  }
  if (!tombText.includes("4") || !tombText.includes("삭제된 메시지")) {
    throw new Error(
      `the fold hides a count it refuses to state ("${tombText}"): 접기는 감추는 ` +
        "장치가 아니라 세어 주는 장치다. 숫자를 말하지 않으면 몇 개가 사라졌는지 " +
        "아무도 모른다"
    );
  }
  // 접힌 행에는 자기 저자가 있어야 한다: 머리를 접으면 「누가 지웠는가」가 사라진다.
  if ((await headRow.getByTestId("row-avatar").count()) !== 1) {
    throw new Error("접힌 묘비 줄이 자기 작성자 줄을 잃었다");
  }

  // ---- 8b. 접힌 원본을 겨눈 인용은 대신 서 있는 행에 착지한다 (이슈 1105) ----
  if (proveRedStandIn) {
    // red seam: 대리 착지의 열쇠를 DOM에서 걷어낸다 = 접힌 묘비를 가리킨 점프가
    // 「위로 올려 더 불러오세요」라는 거짓 지시를 하던 상태.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll("[data-deleted-folded-ids]")) {
        node.removeAttribute("data-deleted-folded-ids");
      }
    });
  }
  const standInKey = await headRow.getAttribute("data-deleted-folded-ids");
  console.log(`[standin] 머리 행이 대신하는 id 목록 "${standInKey ?? "(없음)"}"`);
  await rowLocator(page, QUOTING_MSG).getByTestId("quote-block").click();
  await wait(800);
  const missed = await page.getByTestId("anchor-missed").count();
  const tinted = await headRow.evaluate((node) =>
    node.classList.contains("bg-accent-soft")
  );
  console.log(`[standin] 착지 틴트 ${tinted} · 「못 찾음」 고지 ${missed}건`);
  if (!tinted || missed !== 0) {
    throw new Error(
      "a quote into a folded tombstone lands nowhere: 삭제 원본을 가리킨 인용을 " +
        "눌렀는데 화면이 「위로 올려 이전 대화를 더 불러오세요」라고 말한다. 그 " +
        "메시지는 이미 로드돼 있고 접혀 있을 뿐이다 (design-review U4-5 H-1)"
    );
  }

  // ---- 6. 경계의 색은 계약이다 (design-review D-2) --------------------------
  const unread = page.getByTestId("unread-divider");
  const day = page.getByTestId("day-divider").first();
  const unreadLabel = await colorOf(unread);
  const unreadRule = await unread
    .locator("[data-divider-rule]")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const dayLabel = await colorOf(day);
  const agentInk = await page
    .locator(".text-agent")
    .first()
    .evaluate((node) => getComputedStyle(node).color)
    .catch(() => null);
  const tone = await unread.getAttribute("data-tone");
  console.log(
    `[tone] 안읽음 라벨 ${unreadLabel} · rule ${unreadRule} · 날짜 라벨 ${dayLabel} · 에이전트 ${agentInk} · 역할 ${tone}`
  );
  if (tone !== "boundary") {
    throw new Error(
      `안읽음 구분선이 「경계」 역할을 들고 있지 않다 (data-tone=${tone}): 색을 ` +
        "토큰 이름으로만 고르면 팔레트를 손대는 사람에게 이 줄이 걸려 있다는 " +
        "사실이 보이지 않는다 (D-2)"
    );
  }
  if (unreadLabel !== unreadRule.replace("rgba", "rgb").replace(/,\s*1\)$/, ")")) {
    // 한 경계는 한 색이다. 두 값이 다르면 그 줄이 두 가지를 말한다.
    if (unreadLabel !== unreadRule) {
      throw new Error(
        `안읽음 경계의 라벨(${unreadLabel})과 rule(${unreadRule})이 다른 색이다`
      );
    }
  }
  if (unreadLabel === dayLabel) {
    throw new Error(
      "경계의 색이 조용한 표지와 같다: 경계가 배경 표지와 같은 색이면 그것은 " +
        "경계가 아니다"
    );
  }
  if (agentInk !== null && unreadLabel === agentInk) {
    throw new Error(
      "경계의 색이 에이전트 정체와 같다: 안읽음은 누구의 정체도 아니다"
    );
  }

  // ---- 7. 복구 표지는 내부 어휘를 쓰지 않는다 (design-review C-1) ------------
  //
  // 표지는 레일이 한 번 끊겼다 붙어야 생긴다. 소켓을 비정상 종료로 닫으면
  // centrifuge가 다시 붙고, 이 판의 스텁은 `recovered: true`로 답하므로
  // `replay` 표지가 선다 — 실제 경로 그대로다.
  await page.evaluate(() => window.__composerGateDropSocket());
  const recovery = page.getByTestId("recovery-divider");
  await recovery.first().waitFor({ timeout: 20_000 });
  {
    const text = ((await recovery.first().textContent()) ?? "").trim();
    const label = await recovery.first().getAttribute("aria-label");
    const seq = await recovery.first().getAttribute("data-seq");
    console.log(`[recovery] 화면 "${text}" · 낭독 "${label}" · 진단 seq=${seq}`);
    if (text.includes("seq") || /\d/.test(text)) {
      throw new Error(
        `복구 구분선이 내부 어휘를 화면에 쓴다 ("${text}"): 읽는 사람에게 seq가 ` +
          "무엇인지에 대한 모델이 없고, 어느 행도 자기 seq를 그리지 않으므로 그 " +
          "숫자는 대조할 대상조차 없다 (SKILL §4)"
      );
    }
    if (label === null || !label.includes("이 줄 위까지")) {
      throw new Error(
        `낭독이 위치를 잃었다 ("${label}"): 화면의 「여기까지」는 이 줄이 서 있는 ` +
          "자리가 답을 마저 해서 성립하는 말인데, 듣는 사람에게 「여기」는 가리킬 " +
          "곳이 없다"
      );
    }
    if (seq === null) {
      throw new Error("진단 값(data-seq)까지 사라졌다: 검사 도구가 볼 곳이 없다");
    }
  }

  // ---- 5. 승인 카드의 세 문장이 같은 옷을 입지 않는다 (design-review M-3) ----
  const card = rowLocator(page, APPROVAL_MSG).getByTestId("agent-card");
  await card.scrollIntoViewIfNeeded();
  await wait(300);
  // 온라인: 결정 컨트롤이 선다.
  if ((await card.getByTestId("approval-approve").count()) !== 1) {
    throw new Error("대기 승인 카드에 결정 컨트롤이 없다");
  }
  await context.setOffline(true);
  await wait(500);
  const blockedNote = card.getByTestId("approval-note-offline");
  if ((await blockedNote.count()) !== 1) {
    throw new Error(
      "연결이 끊겼는데 승인 카드가 버튼을 그대로 세우고 있다: 누르면 결코 나가지 " +
        "않는 요청이고, 그 사실을 말하는 줄이 화면에 없다 (M-3 오프라인 갈래)"
    );
  }
  if ((await card.getByTestId("approval-approve").count()) !== 0) {
    throw new Error("오프라인인데 승인 버튼이 남아 있다");
  }
  const blockedTone = await blockedNote.getAttribute("data-tone");
  const blockedColor = await colorOf(blockedNote);
  const blockedSize = await blockedNote.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize)
  );
  await context.setOffline(false);
  await wait(600);
  // 결정한다 → 영수증. 격이 올라가야 한다.
  await card.getByTestId("approval-approve").click();
  await wait(200);
  await card.getByTestId("approval-commit").waitFor({ timeout: 5_000 });
  await wait(500);
  await card.getByTestId("approval-commit").click();
  await wait(800);
  const receipt = card.getByTestId("approval-note-receipt");
  if ((await receipt.count()) !== 1) {
    throw new Error("결정했는데 영수증 줄이 없다");
  }
  const receiptColor = await colorOf(receipt);
  const receiptSize = await receipt.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize)
  );
  console.log(
    `[card] 영수증 ${receiptSize}px ${receiptColor} · 오프라인 ${blockedSize}px ${blockedColor} (tone=${blockedTone})`
  );
  if (!(receiptSize > blockedSize)) {
    throw new Error(
      `영수증(${receiptSize}px)이 오프라인 문장(${blockedSize}px)보다 크지 않다: ` +
        "카드에서 가장 값어치 있는 문장이 가장 조용한 차림으로 나온다 (M-3)"
    );
  }
  if (receiptColor === blockedColor) {
    throw new Error(
      "영수증과 오프라인 문장이 같은 색이다: 하나는 방금 내가 한 되돌릴 수 없는 " +
        "행동의 기록이고 하나는 일시적 차단이다"
    );
  }
  if (blockedTone !== "blocked") {
    throw new Error(`오프라인 줄의 격이 blocked가 아니라 ${blockedTone}이다`);
  }

  // ---- 10. 아바타가 얼굴이다 (진단 H-11) -----------------------------------
  const humanAvatar = rowLocator(page, QUOTING_MSG).getByTestId("row-avatar");
  const agentAvatar = rowLocator(page, LONG_MSG).getByTestId("row-avatar");
  const size = await humanAvatar.evaluate((node) =>
    Math.round(node.getBoundingClientRect().width)
  );
  const humanRadius = await humanAvatar.evaluate(
    (node) => getComputedStyle(node).borderTopLeftRadius
  );
  const agentRadius = await agentAvatar.evaluate(
    (node) => getComputedStyle(node).borderTopLeftRadius
  );
  const agentKind = await agentAvatar.getAttribute("data-avatar-kind");
  console.log(
    `[avatar] ${size}px (코어 ${AVATAR_SIZE}) · 사람 radius ${humanRadius} · 에이전트 radius ${agentRadius} (${agentKind})`
  );
  if (size !== AVATAR_SIZE) {
    throw new Error(
      `아바타가 ${size}px이다 (코어 계약 ${AVATAR_SIZE}px). 24px 정사각 이니셜은 ` +
        "아바타로 읽히지 않고 워크스페이스 스위처의 같은 글자와 충돌한다 (H-11)"
    );
  }
  if (humanRadius === agentRadius) {
    throw new Error(
      "사람과 에이전트가 같은 모양이다: 색만으로 가르면 색각 이상이 있는 사람에게 " +
        "구분이 없다 (코어 `AVATAR_SHAPE`)"
    );
  }
  if (agentKind !== "agent") {
    throw new Error(`에이전트 행의 아바타가 ${agentKind}로 그려진다`);
  }

  await context.close();
}

// ---- 9. 손가락이 닿는다 (design-review U4-5 M-1) -----------------------------

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
  await login(page);
  await openChannel(page, channelA);

  if (proveRedTap) {
    // red seam: 최소 타깃을 걷어낸다 = 터치 웹에서 ~18px이던 상태.
    await page.addStyleTag({
      content:
        '[data-testid="message-fold"]{min-block-size:0!important;min-inline-size:0!important;display:inline!important}',
    });
  }

  const fold = page.getByTestId("message-fold").first();
  await fold.scrollIntoViewIfNeeded();
  await wait(300);
  const box = await fold.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  const fontSize = await fold.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize)
  );
  console.log(
    `[tap] 접기 토글 ${box.w}x${box.h}px (기준 ${TOUCH_TARGET}) · 글자 ${fontSize}px`
  );
  if (box.h < TOUCH_TARGET || box.w < TOUCH_TARGET) {
    throw new Error(
      `a finger cannot reliably hit the fold toggle: ${box.w}x${box.h}px는 WCAG ` +
        `2.5.8의 ${TOUCH_TARGET}px 바닥선 아래다. 같은 배치가 폰에는 44pt를 ` +
        "도출식으로 강제하면서 터치 웹만 놓여 있었다 (design-review U4-5 M-1)"
    );
  }
  // 커지는 것은 면적뿐이다: 글자가 함께 커지면 밀도를 잃는다.
  if (fontSize > 13) {
    throw new Error(
      `타깃을 키우면서 글자까지 커졌다 (${fontSize}px): 커지는 것은 누를 수 있는 ` +
        "면적뿐이어야 한다"
    );
  }

  await context.close();
}

// ---- 11. 빈 채널의 첫 문 (#1536, 온보딩 실측 F5) -----------------------------
//
// 실측이 잡은 것: 첫 로그인 직후 채널 2개·메시지 0인 화면에서 채널 분기가 내놓는
// 유일한 액션이 `멤버 초대하기`였다. 기능은 전부 있었다 — 컴포저도 바로 아래
// 있었고 `첫 메시지 쓰기`도 DM 분기에 이미 있었다. 없던 것은 **그 둘을 잇는
// 문장**이고, 그래서 이 절의 질문은 「버튼이 있는가」가 아니라 「빈 채널에서 맨
// 앞에 선 것이 첫 메시지로 가는 문인가」다.
//
// 채널 B의 메시지를 이 판에서만 비운다. Playwright는 나중에 등록한 라우트를 먼저
// 보므로 이 한 줄이 `installRoutes`의 것을 이기고, 나머지 경로는 그대로 흐른다
// (`route.fallback()`).
async function exerciseEmptyFirstAction(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context);
  // GET 만 가로챈다. 전송(POST)까지 이 빈 배열로 답하면 「빈 채널에서 첫 줄을
  // 보내면 무엇이 보이나」를 다음에 재려는 사람이 조용히 틀린 판 위에 선다.
  await context.route("**/v1/**/messages*", (route) => {
    const request = route.request();
    return request.method() === "GET" && request.url().includes(channelB)
      ? json(route, { messages: [] })
      : route.fallback();
  });
  await login(page);
  await openChannel(page, channelB);

  const empty = page.getByTestId("timeline-empty");
  await empty.waitFor({ state: "visible", timeout: 15_000 });
  const emptyKind = await empty.getAttribute("data-empty-kind");
  if (emptyKind !== "channel") {
    throw new Error(`빈 채널인데 빈 상태가 "${emptyKind}"라고 말한다`);
  }

  if (proveRedFirstAction) {
    // red seam: 첫 행동 버튼만 DOM에서 걷어낸다 = F5 당시의 화면(멤버 추가 하나뿐).
    await page.evaluate(() => {
      document.querySelector('[data-testid="timeline-empty-primary"]')?.remove();
    });
  }

  // 순서는 DOM 순서다. 「맨 앞」이 곧 탭이 먼저 닿는 자리이고, 빈 상태가 답해야
  // 하는 질문(다음에 무엇을 하나)의 답이다.
  const actions = await empty.locator("button").evaluateAll((nodes) =>
    nodes.map((node) => ({
      testid: node.dataset.testid,
      kind: node.dataset.actionKind,
      label: (node.textContent ?? "").trim(),
      fill: getComputedStyle(node).backgroundColor,
      borderWidth: Number.parseFloat(getComputedStyle(node).borderTopWidth),
      borderStyle: getComputedStyle(node).borderTopStyle,
    }))
  );
  console.log(
    `[empty] 액션 ${actions.length}개: ` +
      actions.map((a) => `${a.label}(${a.kind})`).join(" > ")
  );

  const [first, second] = actions;
  if (first === undefined || first.kind !== "write") {
    throw new Error(
      "an empty channel offers no door to the first message: 맨 앞에 선 액션이 " +
        `${first ? `「${first.label}」(${first.kind})` : "없다"}. 실측 F5가 잡은 ` +
        "화면이 바로 이것이다 — 첫 실행에서 사람이 첫 메시지가 아니라 초대로 간다"
    );
  }
  if (first.label !== EMPTY_ACTIONS.write) {
    throw new Error(
      `첫 행동의 이름이 코어와 다르다: 화면 「${first.label}」 vs 코어 ` +
        `「${EMPTY_ACTIONS.write}」`
    );
  }
  if (second === undefined || second.kind !== "add-member") {
    throw new Error(
      "빈 채널의 멤버 추가가 사라졌다: 이 클라에서 「채널에 멤버 추가」로 가는 문은 " +
        "여기 하나뿐이라(AppShell), 강등이 아니라 삭제가 되면 기능 하나가 없어진다"
    );
  }
  if (second.label !== EMPTY_ACTIONS.addMember) {
    throw new Error(
      `멤버 추가의 이름이 코어와 다르다: 화면 「${second.label}」 vs 코어 ` +
        `「${EMPTY_ACTIONS.addMember}」`
    );
  }
  if (actions.length !== 2) {
    throw new Error(`빈 채널의 액션이 2개가 아니라 ${actions.length}개다`);
  }

  // 위계는 값이 아니라 **관계**다 (디자인 시스템 §3). 주 액션의 채움은 이 창이
  // 이미 accent 채움을 주는 컨트롤 — 컴포저의 보내기 — 과 같아야 하고, 보조는 그
  // 채움을 입지 않은 채 자기 윤곽으로 선다.
  const sendFill = await page
    .getByTestId("composer-send")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  if (first.fill !== sendFill) {
    throw new Error(
      `첫 행동의 채움(${first.fill})이 이 창의 주 액션 채움(${sendFill})과 다르다`
    );
  }
  if (second.fill === first.fill) {
    throw new Error(
      `두 액션이 같은 옷(${first.fill})을 입었다: 같은 자리에 같은 옷 두 벌은 ` +
        "「둘 중 아무거나」라고 말하는 것이고, 그것은 첫 행동을 묻는 사람에게 답이 아니다"
    );
  }
  if (second.borderStyle === "none" || !(second.borderWidth >= 1)) {
    throw new Error(
      `보조 액션에 윤곽이 없다(${second.borderStyle} ${second.borderWidth}px): ` +
        "채움도 윤곽도 없으면 그것은 물러선 것이 아니라 사라진 것이다"
    );
  }

  // 그리고 그 문은 실제로 컴포저로 열린다. 캐럿이 오는 것이 전부다 — 가짜 타이핑도
  // 스크롤도 아니다.
  await empty.getByTestId("timeline-empty-primary").click();
  await wait(200);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null
  );
  if (focused !== "composer-input") {
    throw new Error(
      `첫 메시지 쓰기를 눌렀는데 캐럿이 컴포저에 오지 않았다 (focus: ${focused})`
    );
  }
  console.log("[empty] 첫 행동 → 캐럿이 컴포저에 도착");

  await context.close();
}

/** 리뷰용 스크린샷 (SKILL §11). 판정하지 않는다. */
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/composer");
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
    await openChannel(page, channelA);

    // 초안이 들어 있고 상자가 자란 컴포저 + 접힌 묘비 + 승인 카드가 한 장에.
    await page.getByTestId("composer-input").fill(WRAPPED_PARAGRAPH);
    await wait(400);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(outDir, `composer-${scheme}.png`) });

    // 오프라인: 막힌 전송과 그 이유, 그리고 승인 카드의 「때」 문장.
    await context.setOffline(true);
    await wait(600);
    await rowLocator(page, APPROVAL_MSG)
      .getByTestId("agent-card")
      .scrollIntoViewIfNeeded();
    await wait(300);
    await page.screenshot({ path: resolve(outDir, `offline-${scheme}.png`) });
    await context.setOffline(false);
    await context.close();
  }
  console.log(
    "[shots] artifacts/composer/composer-{light,dark}.png · offline-{light,dark}.png"
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "COMPOSER_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exerciseComposer(browser);
      await exerciseTimeline(browser);
      await exerciseTouch(browser);
      await exerciseEmptyFirstAction(browser);
      if (process.env.COMPOSER_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 쓰던 글은 채널 전환과 새로고침을 넘겼고, 끊긴 동안에는");
  console.log("           막고 이유를 말했고, 감긴 한 문단이 상자를 키웠고, ↵를");
  console.log("           배운 사람에게 설명이 사라졌고, 카드의 영수증이 안내보다");
  console.log("           앞에 섰고, 경계의 색이 조용한 표지·에이전트와 갈렸고,");
  console.log("           복구 표지에서 seq가 사라지고 낭독이 자리를 되찾았고,");
  console.log("           묘비 넷이 한 줄로 접히고도 그 줄이 몇 개를 대신하는지");
  console.log("           말했으며 그 줄이 인용의 착지점이 되었고, 손가락 타깃과");
  console.log("           아바타가 각자의 바닥선을 넘었으며, 빈 채널의 맨 앞에 선");
  console.log("           문이 첫 메시지로 열렸다(멤버 추가는 뒤에 그대로 서 있다).");
}

await main();
