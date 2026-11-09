#!/usr/bin/env node
// GATE: B3 W2 「작성 중」 (결정 정본 ADR-0149, 패킷 2026-08-05-B3).
//
// 이 게이트가 지키는 것은 줄이 뜨는지가 아니라 **그 줄이 참인가, 그리고 그것을 위해
// 척추를 건드리지 않았는가**다.
//
//   1. 어휘 경계       「작성 중」(사람)과 「작업 중」(에이전트)이 한 화면에 함께
//                      있어도 서로의 낱말을 쓰지 않는다. 에이전트는 작성 중으로
//                      **절대** 그려지지 않는다 — 서버가 403으로 막는 것과 별개로
//                      화면도 막는다.
//   2. 새 소켓 금지    세션 전체에서 WebSocket은 **한 개**다. 「작성 중」은 기존
//                      레일에 채널 하나를 더 붙인 것이고, 그 채널은 보고 있는
//                      채널뿐이다.
//   3. TTL 소멸        받은 신호는 자기 `expires_at`에 스스로 사라진다. 사라지게
//                      하려고 서버에 무엇도 묻지 않고, **「정지」 요청이 존재하지
//                      않는다**(계약).
//   4. 입력이 멈추면   송신도 멈춘다. 타이머가 아니라 키가 발행을 만든다.
//   5. grant 재사용    한 번 받은 자격을 만료까지 쓴다. 발행마다 grant를 받으면
//                      분당 20번의 멤버십 SELECT가 되고, 두 라우트로 나눈 이유가
//                      사라진다.
//   6. 자기 자신 금지  내 발행이 레일로 돌아와도 내 화면에는 뜨지 않는다.
//   7. 뭉치기          하나·둘은 이름을 다 부르고(「이도현님, 김민서님이 작성 중…」), 셋부터
//                      「첫 이름님 외 N명」이다(#5567 design-review M-2, 폰·Slack과 같은 규칙).
//   8. 자리 예약       「작성 중」 줄은 입력 카드 **바로 아래 늘 잡아 둔 한 줄**(글 한 줄 18 +
//                      위아래 숨 8 = 34px)이다(#5567, owner 11-09: 보내기 옆 오른쪽 슬롯은 일반적인
//                      자리가 아니다). 줄이 서고 져도 **캐럿·전송 버튼·독 높이가 움직이지 않고**,
//                      도구 줄의 힌트 슬롯과 입력창 설명(aria-describedby)도 바뀌지 않는다.
//   9. 이름 표지       사람 이름은 `--ink`, 나머지는 muted. 에이전트 줄의 `--agent`와
//                      대조되는 축이 문서가 아니라 마크업에 있다.
//
// **목은 같은 tick에 답하지 않는다** (#839 교훈). grant는 180ms, 발행은 60ms 늦게
// 답한다: 같은 tick에 답하는 목은 「기다렸다」를 아무것도 증명하지 못한다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   TYPING_GATE_PROVE_RED_AGENT=1 npm run gate:typing
//     expected failure: "an agent was rendered as 작성 중"
//   TYPING_GATE_PROVE_RED_SELF=1 npm run gate:typing
//     expected failure: "my own typing was shown to me"
//   TYPING_GATE_PROVE_RED_TTL=1 npm run gate:typing
//     expected failure: "the typing line outlived its own expiry"
//   TYPING_GATE_PROVE_RED_STOP=1 npm run gate:typing
//     expected failure: "publishing continued after the input stopped"
//   TYPING_GATE_PROVE_RED_GRANT=1 npm run gate:typing
//     expected failure: "the grant was re-fetched"
//   TYPING_GATE_PROVE_RED_LIVE=1 npm run gate:typing
//     expected failure: "the 작성 중 line sits inside a live region"
//   TYPING_GATE_PROVE_RED_SHIFT=1 npm run gate:typing
//     expected failure: "the composer moved when the 작성 중 line appeared"
//   TYPING_GATE_PROVE_RED_TAIL=1 npm run gate:typing
//     expected failure: "the verb was truncated away"
//   TYPING_GATE_PROVE_RED_LABEL=1 npm run gate:typing
//     expected failure: "assistive tech was left reading the truncated text"
//
// W-3(「…님이」 고아)에는 이름 붙은 seam이 없다. 그 결함은 **문구의 조각 경계**가
// 만드는 것이라 CSS나 목으로는 재현되지 않는다 — 증명은 코어 `typingSegments`의
// 경계를 1차대로 되돌려(한 줄) 이 게이트를 돌리는 것이고, 그 결과는
//   "잘린 이름에 조사가 매달렸다: … 이도현 플랫폼…님이 작성 중…"
// 이다(U4-4R에서 실제로 그렇게 확인했다). 되돌린 줄은 컴파일되고 다른 단정은 전부
// 초록인 채라, 이 seam이 겨누는 자리가 정확히 그 한 줄임이 드러난다.
//
// red seam은 **목/드라이버의 행동만** 바꾼다. AGENT는 명부에서 에이전트를 사람으로
// 바꾸고, SELF는 내 id 대신 남의 id로 발행하고, TTL은 기다리는 동안 계속 재발행하고,
// STOP은 멈춰야 할 구간에도 계속 타이핑하고, GRANT는 grant TTL을 12초로 줄이고, LIVE는
// DOM에서 그 줄을 live 영역 안으로 넣고, SHIFT는 줄 상자의 예약 높이를 풀어(`block-size:auto`)
// 「없을 때 숨 16, 있을 때 34」인 예약 없는 줄을 되돌린다. TAIL은 꼬리를 다시 줄어들게 만들고(=1차의 「줄 전체 truncate」),
// LABEL은 sr-only 라벨을 접근성 트리에서 뺀다(=1차의 「title뿐」). 제품 소스 줄을
// 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.TYPING_GATE_PORT || 5195);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const dohyunId = "00000000-0000-7000-8000-000000000102";
const minseoId = "00000000-0000-7000-8000-000000000103";
const jiwooId = "00000000-0000-7000-8000-000000000104";
// 긴 표시명 둘. U4-4 W1의 잘림 장면 전용이고, 리뷰가 M-3을 폭 실측 **추정**으로만
// 남긴 자리("긴 표시명 2명에서 발생 — 런타임 캡처는 확보하지 못했다")를 실제 렌더로
// 바꾼다.
const longAId = "00000000-0000-7000-8000-000000000105";
const longBId = "00000000-0000-7000-8000-000000000106";
// #5567: 320폭을 혼자서도 넘칠 만큼 긴 표시명(이름 + 직군 + 직책). 둘이 치면 이 이름과 둘째 이름이 함께 선다.
const longCId = "00000000-0000-7000-8000-000000000107";
const agentId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAA613";
const channelId = "00000000-0000-7000-8000-000000000201";
const otherChannelId = "00000000-0000-7000-8000-000000000202";
const runId = "9F1C8B2A-0000-7000-8000-00000000RUN1";

const proveRedAgent = process.env.TYPING_GATE_PROVE_RED_AGENT === "1";
const proveRedSelf = process.env.TYPING_GATE_PROVE_RED_SELF === "1";
const proveRedTtl = process.env.TYPING_GATE_PROVE_RED_TTL === "1";
const proveRedStop = process.env.TYPING_GATE_PROVE_RED_STOP === "1";
const proveRedGrant = process.env.TYPING_GATE_PROVE_RED_GRANT === "1";
const proveRedLive = process.env.TYPING_GATE_PROVE_RED_LIVE === "1";
const proveRedShift = process.env.TYPING_GATE_PROVE_RED_SHIFT === "1";
const proveRedTail = process.env.TYPING_GATE_PROVE_RED_TAIL === "1";
const proveRedLabel = process.env.TYPING_GATE_PROVE_RED_LABEL === "1";

// 목의 응답 지연 (#839 교훈). 같은 tick에 답하는 목은 아무것도 증명하지 않는다.
const GRANT_DELAY_MS = 180;
const PUBLISH_DELAY_MS = 60;

// 서버 값 그대로 (`momo-ephemeral::signal.rs`).
const REPUBLISH_MS = 3_000;
const AGGREGATE_THRESHOLD = 3;
// 공유 슬롯은 `text-meta` 한 줄이다. 옛 26px 예약 행을 없앤 뒤의 구체 높이이며,
// 0보다 크기만 하면 된다는 단정은 높이 축을 사실상 지워 버린다 (R2 N-8).
const ACTION_META_SLOT_HEIGHT_PX = 18;
/** 「작성 중」 줄의 예약 높이(text-meta 행간 18 + 위아래 숨 `--spacing-2` 8). 아무도 안 칠 때도 이 높이다 (#5567, M-1). */
const TYPING_LINE_HEIGHT_PX = 34;
/** 이 게이트가 쓰는 짧은 TTL. 실제 6초를 기다리면 게이트가 분 단위로 길어진다. */
const GATE_TTL_MS = 1_200;
/**
 * grant 수명. 한 버스트(7초) 안에서 갱신이 일어나지 않을 만큼 길다.
 *
 * red seam은 **12초**를 준다. 1초로 줄이는 것이 첫 시도였는데 그건 red가 아니라
 * 다른 결함을 열었다: 수명이 여유(10초)보다 짧으면 클라가 grant만 계속 받으며 한
 * 번도 발행하지 않았고, 게이트는 「발행 0건」으로 죽었다. 그 결함은 코어에서
 * 고쳤고(`renewMargin`이 수명의 절반으로 깎는다), red seam은 이제 의도한 자리를
 * 정확히 찌른다 — 12초 자격의 여유는 6초이므로 t=6s의 재발행에서 갱신이 한 번 더
 * 나가고, 「grant는 버스트당 한 번」 단언이 깨진다.
 */
const GRANT_TTL_MS = proveRedGrant ? 12_000 : 60_000;

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
  realtimeWebSocketUrl: "ws://typing-gate.invalid/connection/websocket",
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
  member({ id: dohyunId, kind: "human", displayName: "이도현", handle: "dohyun" }),
  member({ id: minseoId, kind: "human", displayName: "김민서", handle: "minseo" }),
  member({ id: jiwooId, kind: "human", displayName: "박지우", handle: "jiwoo" }),
  // 리뷰가 M-3의 발생 조건으로 지목한 모양 그대로다: 「이름 + 직군」을 표시명에 담는
  // 흔한 관례. 폰 폭(390)에서 둘이 함께 치면 한 줄에 들어가지 않는다.
  member({
    id: longAId,
    kind: "human",
    displayName: "김민서 프로덕트디자인",
    handle: "minseo-design",
  }),
  member({
    id: longBId,
    kind: "human",
    displayName: "이도현 플랫폼엔지니어링",
    handle: "dohyun-platform",
  }),
  member({
    id: longCId,
    kind: "human",
    displayName: "이도현 플랫폼엔지니어링 테크리드",
    handle: "dohyun-platform-lead",
  }),
  member({
    id: agentId,
    // red seam: 명부가 에이전트를 사람이라고 말한다. 「에이전트는 작성 중으로
    // 그려지지 않는다」 단언이 DOM을 읽고 있다면 반드시 깨진다. 제품 소스는 그대로다.
    kind: proveRedAgent ? "human" : "agent",
    displayName: "김인턴",
    handle: "kim-intern",
    ownerHumanId: memberId,
    agentModel: "hermes-agent",
    capabilities: ["work.observe"],
  }),
];

const channels = [
  { id: channelId, workspaceId, kind: "public", name: "release-2026-08", muted: false },
];

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
    let constructed = 0;
    let offset = 0;
    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        constructed += 1;
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
              connect: { client: "typing-gate", version: "6" },
            });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "typing-gate",
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

    /** 이 세션에서 만들어진 소켓의 총수. 「새 소켓 금지」의 유일한 측정값이다. */
    window.__typingGateSocketCount = () => constructed;
    window.__typingGateChannels = () => {
      const all = new Set();
      for (const socket of sockets) {
        for (const name of socket.subscriptions) all.add(name);
      }
      return Array.from(all);
    };
    window.__typingGateReady = (prefix) =>
      window.__typingGateChannels().some((name) => name.startsWith(prefix));

    /**
     * 지정한 네임스페이스에만 흘린다. 휘발 신호를 `ch:`에도 뿌리면 타임라인 핸들러가
     * 자기 것이 아닌 프레임을 읽게 되고, 그건 목의 성질이 만든 거짓 통과다.
     */
    window.__typingGatePublish = (prefix, frame) => {
      offset += 1;
      let delivered = 0;
      for (const socket of sockets) {
        for (const name of socket.subscriptions) {
          if (!name.startsWith(prefix)) continue;
          delivered += 1;
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: { channel: name, pub: { data: frame, offset } },
              }),
            })
          );
        }
      }
      return delivered;
    };
  });
}

/**
 * 밀집 타임라인 200행 (루브릭 phase 5 · design-review PR 1059 N-4).
 *
 * **`?stress=200`을 쓰지 않는다 — 그 모드는 이 캡처를 만들 수 없다.** `ChatShell`이
 * 스트레스 모드에서 `useTypingReceive`에 `null` 레일과 `null` 채널을 넘기므로
 * (`ChatShell.tsx`) 「작성 중」 구독이 아예 없고, 따라서 그 줄이 렌더될 수 없다.
 * 목으로 200행을 돌려주는 편이 증거로도 낫다: 실제 페이지 경로·실제 가상 리스트·
 * 실제 반응 맵을 그대로 통과한다.
 *
 * 내용은 실제 팀 대화처럼 섞는다(사람·에이전트·길고 짧은 줄) — 「테스트 메시지 1」로
 * 채운 200행은 밀도를 재는 데 쓸모가 없다(SKILL §7).
 */
const DENSE_LINES = [
  "롤백 스크립트 최신인지 확인 부탁합니다.",
  "어제 배포분에서 마이그레이션 044까지 적용됐어요.",
  "@kim-intern 이 채널 로그에서 5xx만 뽑아 줄 수 있어?",
  "네, 지금 봅니다. 배포 로그부터 읽었습니다.",
  "그 구간은 relay 지연이지 서버 오류가 아니었습니다. outbox 적체 3분.",
  "확인했습니다. 그러면 이번 배포는 그대로 가도 되겠네요.",
  "센트리에 같은 스택 두 건 더 있는데 원인은 같아 보입니다.",
  "좋아요. 릴리스 노트에 그 문장 한 줄만 추가해 둘게요.",
];

function densePage(memberIds) {
  const rows = [];
  for (let i = 0; i < 200; i += 1) {
    const author = memberIds[i % memberIds.length];
    rows.push({
      id: `0199dddd-0000-7000-8000-${String(i).padStart(12, "0")}`,
      channelId,
      seq: i + 1,
      hlcTs: 1_785_238_400_000 + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: "text",
      body: DENSE_LINES[i % DENSE_LINES.length],
      state: "sent",
      createdAtMs: 1_785_238_400_000 + i * 60_000,
    });
  }
  return rows;
}

function makeTraffic() {
  return { grants: 0, publishes: [], order: [], bodies: [] };
}

async function installRoutes(context, traffic, options = {}) {
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

    // ---- 휘발 표면 --------------------------------------------------------
    if (path.endsWith("/typing/grant")) {
      traffic.grants += 1;
      traffic.order.push("grant");
      // #839: 같은 tick에 답하지 않는다.
      await wait(GRANT_DELAY_MS);
      return json(route, {
        grant: `gate-grant-${traffic.grants}`,
        channel: `typing:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`,
        expiresAtMs: Date.now() + GRANT_TTL_MS,
        ttlSeconds: Math.round(GRANT_TTL_MS / 1_000),
        signalTtlMs: GATE_TTL_MS,
        republishIntervalMs: REPUBLISH_MS,
        aggregateThreshold: AGGREGATE_THRESHOLD,
      });
    }
    if (path.endsWith("/typing")) {
      const body = JSON.parse(request.postData() ?? "{}");
      traffic.publishes.push({ atMs: Date.now(), grant: body.grant });
      traffic.bodies.push(body);
      traffic.order.push("typing");
      await wait(PUBLISH_DELAY_MS);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          channel: `typing:ws${workspaceId.toUpperCase()}.${channelId.toUpperCase()}`,
          expiresAtMs: Date.now() + GATE_TTL_MS,
          republishAfterMs: REPUBLISH_MS,
        }),
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
      if (options.dense !== true) return json(route, { messages: [] });
      // 밀집 캡처: 첫 페이지만 채우고 이후 페이지 요청은 비운다(백필 루프 종료).
      if (new URL(request.url()).searchParams.has("after")) {
        return json(route, { messages: [] });
      }
      return json(route, {
        messages: densePage([memberId, dohyunId, minseoId, agentId]),
      });
    }
    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("typing@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.getByTestId("composer-input").waitFor();
  await page.waitForFunction(() => window.__typingGateReady("typing:"), undefined, {
    timeout: 15_000,
  });
}

/** 한 건의 「작성 중」을 레일에 흘린다. 서버가 만드는 그 형상 그대로. */
async function publishTyping(page, options) {
  return page.evaluate(
    ({ ws, ch, who, ttl }) =>
      window.__typingGatePublish("typing:", {
        type: "ephemeral.typing",
        v: 1,
        ts: Date.now(),
        payload: {
          workspace_id: ws.toUpperCase(),
          channel_id: ch.toUpperCase(),
          member_id: who.toUpperCase(),
          expires_at: Date.now() + ttl,
        },
      }),
    {
      ws: workspaceId,
      ch: options.channelId ?? channelId,
      who: options.memberId,
      ttl: options.ttlMs ?? GATE_TTL_MS,
    }
  );
}

async function publishAgentTurn(page, phase, runStatus) {
  await page.evaluate(
    ({ ch, agent, run, p, rs }) =>
      window.__typingGatePublish("agent:", {
        type: "agent.status",
        v: 1,
        ts: Date.now(),
        payload: {
          run_id: run,
          agent_member_id: agent,
          channel_id: ch,
          phase: p,
          run_status: rs,
        },
      }),
    { ch: channelId, agent: agentId, run: runId, p: phase, rs: runStatus }
  );
}

function typingLine(page) {
  return page.getByTestId("composer-typing");
}

function metaSlot(page) {
  return page.locator("[data-composer-meta-slot]");
}

/**
 * 줄이 **눈에** 말하는 글자 = 조각들(lead + tail)의 합.
 *
 * `textContent`를 그냥 읽으면 U4-4 W1이 넣은 `sr-only` 라벨까지 딸려 와 문장이 두 번
 * 나온다. 보이는 것과 보조기술이 읽는 것이 **일부러 다른 값**이 되었으므로(M-2), 그
 * 둘을 세는 함수도 갈라 둔다.
 */
function visibleTypingText(page) {
  return page.evaluate(() => {
    const read = (testid) =>
      document.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
    return `${read("composer-typing-lead")}${read("composer-typing-tail")}`;
  });
}

/**
 * 보조기술이 **실제로** 읽게 되는 글자.
 *
 * `aria-hidden`과 `display:none`을 존중하며 훑는다 — 이 줄의 M-2 수리가 바로 그
 * 두 축 위에 서 있기 때문이다(보이는 조각은 숨기고, 온전한 문장만 남긴다).
 * `textContent`로는 이 구분이 보이지 않아 라벨이 트리에서 빠져도 초록이 된다.
 */
function accessibleTypingText(page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="composer-typing"]');
    if (line === null) return null;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.getAttribute("aria-hidden") === "true") return "";
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
      return Array.from(node.childNodes).map(walk).join("");
    };
    return Array.from(line.childNodes).map(walk).join("");
  });
}

/**
 * 사람이 실제로 치는 모양: 한 글자씩, 사람 속도로.
 *
 * `pressSequentially`를 쓰는 이유는 `fill()`이 값 전체를 한 번에 넣어 `onChange`를
 * **한 번만** 부른다는 것이다. 「작성 중」은 키에서만 나가므로, 한 번의 change로는
 * 케이던스를 잴 수 없다 — 재려면 실제로 여러 번 쳐야 한다.
 */
async function typeFor(page, ms, text = "지금 쓰고 있는 문장입니다. ") {
  const input = page.getByTestId("composer-input");
  await input.click();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await input.pressSequentially(text, { delay: 70 });
  }
}

async function exercise(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    // 「작성 중」 문구는 사전에서 온다(#5567). 브라우저 기본(en-US)이면 영어 사전이 서므로 한국어로 고정한다.
    locale: "ko-KR",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic);
  await login(page);

  // ---- 2. 새 소켓 금지 + 보이는 채널만 --------------------------------------
  const socketCount = await page.evaluate(() => window.__typingGateSocketCount());
  if (socketCount !== 1) {
    throw new Error(
      `「작성 중」 must ride the existing rail: ${socketCount} WebSockets were constructed, expected 1`
    );
  }
  const subscribed = await page.evaluate(() => window.__typingGateChannels());
  const typingChannels = subscribed.filter((name) => name.startsWith("typing:"));
  if (typingChannels.length !== 1) {
    throw new Error(
      `exactly one typing channel must be subscribed (the visible one), got ${JSON.stringify(
        typingChannels
      )}`
    );
  }
  if (!typingChannels[0].includes(channelId.toUpperCase())) {
    throw new Error(
      `the subscribed typing channel is not the open one: ${typingChannels[0]}`
    );
  }

  // ---- 6. 자기 자신은 안 보인다 ---------------------------------------------
  // 내 발행은 Centrifugo가 나에게도 돌려준다(내가 그 채널의 구독자다).
  await publishTyping(page, {
    memberId: proveRedSelf ? dohyunId : memberId,
    ttlMs: 4_000,
  });
  await wait(300);
  if ((await typingLine(page).count()) !== 0) {
    throw new Error(
      `my own typing was shown to me: the line read "${await typingLine(
        page
      ).textContent()}"`
    );
  }

  // ---- 8. 「작성 중」 줄은 카드 아래 늘 잡아 둔 한 줄이다: 서고 져도 아무것도 안 움직인다 (#5567) ----
  //
  // 「입력창과 전송 버튼이 그 자리에 있는가」는 의견이 아니라 좌표다. 아무도 안 칠 때 재고, 두 명이 치기 시작해 줄이 선 뒤
  // 다시 재고, 만료로 줄이 진 뒤 또 잰다. 세 판에서 입력창·전송 y, 독 높이, 줄 상자 높이(34)가 같아야 하고, 도구 줄의
  // 힌트 슬롯과 입력창 설명은 남의 입력과 무관하게 그대로여야 한다(옛 판은 힌트를 밀어내고 그 자리에 섰다).
  const composerBox = async () => {
    const input = await page.getByTestId("composer-input").boundingBox();
    const send = await page.getByTestId("composer-send").boundingBox();
    const dock = await page.getByTestId("composer").boundingBox();
    const line = await page.getByTestId("typing-line").boundingBox();
    return {
      inputY: Math.round(input?.y ?? -1),
      sendY: Math.round(send?.y ?? -1),
      dockH: Math.round(dock?.height ?? -1),
      lineH: Math.round(line?.height ?? -1),
    };
  };
  if (proveRedShift) {
    // red seam: 줄 상자의 예약 높이를 푼다. 빈 줄은 숨 16, 문장이 서면 34가 되어 남의 키가 내 캐럿과 보내기 단추를 민다.
    // React 노드는 건드리지 않으므로 실패가 줄 전환 자체를 깨뜨린 결과가 아니다.
    await page.addStyleTag({
      content: '[data-testid="typing-line"]{block-size:auto!important}',
    });
  }
  const hintSlot = () =>
    metaSlot(page).evaluateAll((nodes) => ({
      count: nodes.length,
      height:
        nodes.length === 1
          ? Math.round(nodes[0].getBoundingClientRect().height)
          : -1,
      kind: nodes[0]?.getAttribute("data-testid") ?? "missing",
    }));
  const describedBy = () =>
    page.getByTestId("composer-input").getAttribute("aria-describedby");
  const beforeTyping = await composerBox();
  if (beforeTyping.inputY < 0 || beforeTyping.sendY < 0 || beforeTyping.dockH < 0) {
    throw new Error("컴포저를 측정할 수 없다");
  }
  const beforeMeta = await hintSlot();
  const beforeDescribedBy = await describedBy();
  if (
    beforeMeta.count !== 1 ||
    beforeMeta.height !== ACTION_META_SLOT_HEIGHT_PX ||
    beforeMeta.kind !== "composer-hint" ||
    beforeDescribedBy !== "composer-hint"
  ) {
    throw new Error(
      `기본 액션 슬롯은 힌트 하나·${ACTION_META_SLOT_HEIGHT_PX}px이어야 한다: ${JSON.stringify({
        ...beforeMeta,
        describedBy: beforeDescribedBy,
      })}`
    );
  }
  if (!proveRedShift && beforeTyping.lineH !== TYPING_LINE_HEIGHT_PX) {
    throw new Error(
      `아무도 안 칠 때도 「작성 중」 줄은 ${TYPING_LINE_HEIGHT_PX}px을 잡아 둬야 한다: ${beforeTyping.lineH}px`
    );
  }
  await publishTyping(page, { memberId: dohyunId, ttlMs: 2_500 });
  await publishTyping(page, { memberId: minseoId, ttlMs: 2_500 });
  await typingLine(page).waitFor({ timeout: 5_000 });
  const duringTyping = await composerBox();
  const duringMeta = await hintSlot();
  const duringDescribedBy = await describedBy();
  console.log(
    `[shift] 입력창 y ${beforeTyping.inputY} -> ${duringTyping.inputY} · ` +
      `전송 y ${beforeTyping.sendY} -> ${duringTyping.sendY} · 독 ${beforeTyping.dockH} -> ${duringTyping.dockH} · ` +
      `줄 ${beforeTyping.lineH} -> ${duringTyping.lineH}px`
  );
  if (
    duringMeta.count !== 1 ||
    duringMeta.kind !== "composer-hint" ||
    duringMeta.height !== ACTION_META_SLOT_HEIGHT_PX ||
    duringDescribedBy !== "composer-hint"
  ) {
    throw new Error(
      `남이 치기 시작하자 도구 줄의 힌트 슬롯이 바뀌었다: ${JSON.stringify({
        ...duringMeta,
        describedBy: duringDescribedBy,
      })}`
    );
  }
  const typingPlacement = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="composer-typing"]');
    const frame = document.querySelector('[data-testid="composer-frame"]');
    if (line === null || frame === null) return null;
    return {
      inFrame: frame.contains(line),
      inActions: line.closest('[data-testid="composer-actions"]') !== null,
      belowFrame: Math.round(line.getBoundingClientRect().top - frame.getBoundingClientRect().bottom),
    };
  });
  if (
    typingPlacement === null ||
    typingPlacement.inFrame ||
    typingPlacement.inActions ||
    typingPlacement.belowFrame < 0
  ) {
    throw new Error(
      `「작성 중」은 카드 밖, 카드 바로 아래 줄이어야 한다: ${JSON.stringify(typingPlacement)}`
    );
  }
  if (
    duringTyping.inputY !== beforeTyping.inputY ||
    duringTyping.sendY !== beforeTyping.sendY ||
    duringTyping.dockH !== beforeTyping.dockH ||
    (!proveRedShift && duringTyping.lineH !== TYPING_LINE_HEIGHT_PX)
  ) {
    throw new Error(
      `the composer moved when the 작성 중 line appeared: 입력창 ${beforeTyping.inputY}->${duringTyping.inputY}, ` +
        `전송 ${beforeTyping.sendY}->${duringTyping.sendY}, 독 ${beforeTyping.dockH}->${duringTyping.dockH}, ` +
        `줄 ${beforeTyping.lineH}->${duringTyping.lineH}. 남의 키 입력이 내 캐럿과 ` +
        "전송 버튼을 밀어서는 안 된다 (리뷰 H-2 · #5567)"
    );
  }
  // 사라질 때도 같다. TTL로 스스로 사라지므로 여기서 기다리는 것이 곧 그 경로다.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-typing"]') === null,
    undefined,
    { timeout: 8_000 }
  );
  const afterTyping = await composerBox();
  const afterMeta = await hintSlot();
  const afterDescribedBy = await describedBy();
  if (
    afterMeta.count !== 1 ||
    afterMeta.height !== beforeMeta.height ||
    afterMeta.kind !== "composer-hint" ||
    afterDescribedBy !== "composer-hint"
  ) {
    throw new Error(
      `작성 종료 뒤 기본 힌트 한 행이 그대로가 아니다: ${JSON.stringify({
        ...afterMeta,
        describedBy: afterDescribedBy,
      })}`
    );
  }
  console.log(
    `[reserve] 줄 ${beforeTyping.lineH} -> ${duringTyping.lineH} -> ${afterTyping.lineH}px · 독 ${beforeTyping.dockH} -> ` +
      `${duringTyping.dockH} -> ${afterTyping.dockH}px · 힌트 슬롯 ${beforeMeta.kind} 그대로`
  );
  if (
    afterTyping.inputY !== beforeTyping.inputY ||
    afterTyping.sendY !== beforeTyping.sendY ||
    afterTyping.dockH !== beforeTyping.dockH
  ) {
    throw new Error(
      `the composer moved when the 작성 중 line expired: 입력창 ${beforeTyping.inputY}->${afterTyping.inputY}, ` +
        `독 ${beforeTyping.dockH}->${afterTyping.dockH}`
    );
  }

  // ---- 9. 이름에 자기 표지가 있다 (리뷰 M-1) ---------------------------------
  // 짧은 TTL을 쓰고 끝에서 비워 둔다: 다음 절이 「에이전트는 안 그려진다」를 재므로,
  // 사람 신호가 남아 있으면 그 단언이 남의 신호를 보고 실패한다.
  await publishTyping(page, { memberId: dohyunId, ttlMs: GATE_TTL_MS });
  await typingLine(page).waitFor({ timeout: 5_000 });
  const nameTone = await page.evaluate(() => {
    const lead = document.querySelector('[data-testid="composer-typing-lead"]');
    const tail = document.querySelector('[data-testid="composer-typing-tail"]');
    if (lead === null || tail === null) return null;
    // `lead` 안에서 이름 조각만 고른다. 라벨(`sr-only`)은 문장 전체를 들고 있어
    // 「이름을 담은 노드」로도 「동사를 담은 노드」로도 잡히므로, 그것을 피하려면
    // 조각을 이름으로 찾지 말고 **구조로** 찾아야 한다.
    const name = Array.from(lead.querySelectorAll("span")).find((node) =>
      (node.textContent ?? "").includes("이도현")
    );
    if (!name) return null;
    return {
      name: getComputedStyle(name).color,
      tail: getComputedStyle(tail).color,
    };
  });
  if (nameTone === null) {
    throw new Error(
      "이름과 나머지가 각자의 span에 있지 않다: 「이름 색」 축이 문서에만 있으면 " +
        "작업 중 줄이 없을 때 사람 줄에는 표지가 남지 않는다 (리뷰 M-1)"
    );
  }
  console.log(`[tone] 이름 ${nameTone.name} · 나머지 ${nameTone.tail}`);
  if (nameTone.name === nameTone.tail) {
    throw new Error(
      `이름과 나머지가 같은 색이다 (${nameTone.name}); 표가 주장하는 「이름 색」 축이 ` +
        "마크업에 없다 (리뷰 M-1)"
    );
  }
  // 다음 절로 깨끗한 화면을 넘긴다.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-typing"]') === null,
    undefined,
    { timeout: 8_000 }
  );

  // ---- 10. 좁은 폭 + 긴 이름: 이름이 잘려도 말은 안 잘린다 (U4-4 W1) ---------
  //
  // 예약 높이를 1줄로 못 박은 이상 잘림 자체는 없앨 수 없다 — 고를 수 있는 것은
  // **무엇이 잘리는가**뿐이다(`TypingLine.tsx` 머리 주석의 결정). 한국어는 동사가
  // 끝에 오므로 1차처럼 줄 전체에 말줄임을 걸면 잘려 나가는 것이 하필 「작성 중」이고,
  // 남는 문자열은 아무 말도 하지 않는다.
  //
  // 리뷰(M-3)는 이 조건을 **폭 계산으로 추정**만 하고 런타임 증거를 남기지 못했다
  // ("긴 표시명 2명, 약 340px+ … 확인 필요"). 이 게이트가 그 자리를 실측으로 바꾸면서
  // 추정을 하나 **정정한다**: 리뷰가 예로 든 이름 둘("김민서 프로덕트디자인" 급)은
  // 390폭에서 실제로는 **잘리지 않는다** — 문장 오른끝 334px, 본문 끝 366px로 32px가
  // 남는다(이 게이트를 390에서 돌려 얻은 값이다). 리뷰의 산술은 맞았고 경계에 걸쳐
  // 있었을 뿐이다.
  //
  // 그래서 장면은 **지원하는 가장 좁은 폭**인 320에서 만든다. 여기서 같은 두 이름이
  // 60px 넘게 넘치고, 그것이 M-3이 말한 화면이다. 좁은 폭을 고른 것은 궁색해서가
  // 아니라 그쪽이 이 결함의 실제 서식지이기 때문이다 — 폰에서 시스템 글자 크기를
  // 키우면 390에서도 같은 일이 벌어지고, 그 경로는 게이트가 재현하기 어렵다.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByTestId("composer-input").fill("");
  if (proveRedTail) {
    // red seam: 꼬리를 다시 줄어들게 만든다 = 1차의 「줄 전체 truncate」. 앞부분이
    // 안 줄어들면 넘치는 자리를 꼬리가 뒤집어쓰고, 그것이 정확히 1차의 화면이다.
    // CSS만 바꾸므로 React가 들고 있는 노드는 그대로다.
    await page.addStyleTag({
      content:
        '[data-testid="composer-typing-tail"]{flex-shrink:1!important;min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}' +
        '[data-testid="composer-typing-lead"]{flex-shrink:0!important}',
    });
  }
  if (proveRedLabel) {
    // red seam: sr-only 라벨을 접근성 트리에서 뺀다 = 1차의 「title 하나뿐」. 보이는
    // 조각은 `aria-hidden`이므로, 라벨이 빠지면 보조기술이 읽을 것이 남지 않는다.
    await page.addStyleTag({
      content: '[data-testid="composer-typing-label"]{display:none!important}',
    });
  }
  const emptyMeta = page.getByTestId("composer-meta-empty");
  await emptyMeta.waitFor({
    state: "attached",
    timeout: 5_000,
  });
  const emptyMetaState = await emptyMeta.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      ariaHidden: node.getAttribute("aria-hidden"),
      hasSlot: node.hasAttribute("data-composer-meta-slot"),
      text: node.textContent ?? "",
      display: style.display,
      visibility: style.visibility,
      flexGrow: style.flexGrow,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  if (
    emptyMetaState.ariaHidden !== "true" ||
    !emptyMetaState.hasSlot ||
    emptyMetaState.text !== "" ||
    emptyMetaState.display === "none" ||
    emptyMetaState.visibility === "hidden" ||
    emptyMetaState.flexGrow !== "1" ||
    emptyMetaState.width <= 0 ||
    emptyMetaState.height !== 0
  ) {
    throw new Error(
      `폰 기본판의 빈 액션 슬롯이 새 설계와 다르다: ${JSON.stringify(emptyMetaState)}`
    );
  }
  if ((await page.getByTestId("composer-hint").count()) !== 0) {
    throw new Error("폰 기본판에 wide-only Enter 힌트가 남았다");
  }
  const reservedActionHeight = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="composer-actions"]');
    return node === null ? -1 : Math.round(node.getBoundingClientRect().height);
  });
  await publishTyping(page, { memberId: longCId, ttlMs: 20_000 });
  await publishTyping(page, { memberId: longAId, ttlMs: 20_000 });
  await typingLine(page).waitFor({ timeout: 5_000 });
  // 둘이 치면 보이는 줄에 두 이름이 다 선다(#5567 M-2). 둘째 신호까지 들어온 뒤에 잰다.
  await page.waitForFunction(
    () => {
      const line = document.querySelector('[data-testid="composer-typing"]');
      return (
        line?.getAttribute("data-count") === "2" &&
        (document.querySelector('[data-testid="composer-typing-lead"]')?.textContent ?? "").includes(
          "테크리드"
        )
      );
    },
    undefined,
    { timeout: 5_000 }
  );

  const fit = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="composer-typing"]');
    const lead = document.querySelector('[data-testid="composer-typing-lead"]');
    const tail = document.querySelector('[data-testid="composer-typing-tail"]');
    if (line === null || lead === null || tail === null) return null;
    const lineBox = line.getBoundingClientRect();
    const style = getComputedStyle(line);
    const contentWidth =
      lineBox.width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    return {
      // 잘리지 않았다면 이만큼을 원했다 — 장면이 실제로 넘치는지는 이 값으로 본다. 앞의 점과 그 간격(#5567)도 줄 폭을 쓴다.
      wanted: Math.round(
        lead.getBoundingClientRect().left - lineBox.left + lead.scrollWidth + tail.scrollWidth
      ),
      contentWidth: Math.round(contentWidth),
      leadClipped: Math.round(lead.scrollWidth - lead.clientWidth),
      tailClipped: Math.round(tail.scrollWidth - tail.clientWidth),
      tailRight: Math.round(tail.getBoundingClientRect().right),
      contentRight: Math.round(lineBox.right - parseFloat(style.paddingRight)),
      height: Math.round(lineBox.height),
      tailText: tail.textContent ?? "",
    };
  });
  if (fit === null) {
    throw new Error(
      "줄이 lead/tail 두 조각으로 서 있지 않다: 무엇이 잘릴지 고를 수 없는 구조다 (리뷰 M-3)"
    );
  }
  console.log(
    `[fit] 320폭 · 원한 폭 ${fit.wanted}px / 있는 폭 ${fit.contentWidth}px · ` +
      `lead 넘침 ${fit.leadClipped}px · tail 넘침 ${fit.tailClipped}px · ` +
      `tail 오른끝 ${fit.tailRight} (본문 끝 ${fit.contentRight}) · 높이 ${fit.height}px`
  );
  // 장면이 실제로 넘치지 않으면 아래 단언은 아무것도 증명하지 못한다.
  //
  // **어느 조각이 잘렸는지로 묻지 않는다** — 그것이 곧 판정 대상이기 때문이다.
  // 묻는 것은 「문장이 원한 폭이 있는 폭보다 큰가」이고, 그 답은 어느 쪽이 잘리든
  // 같다. (여기서 `lead`가 잘렸는지로 물었다가, TAIL red seam이 잘림을 꼬리로
  // 옮기자 **의도한 단언 대신 이 가드가** 먼저 터졌다. 가드가 red를 가리면 red proof는
  // 자기가 무엇을 증명했는지 말할 수 없다.)
  if (fit.wanted <= fit.contentWidth) {
    throw new Error(
      `이 장면이 잘림을 만들지 못했다 (원한 폭 ${fit.wanted}px ≤ 있는 폭 ${fit.contentWidth}px): ` +
        "긴 이름 둘이 320폭에 다 들어갔다면 픽스처가 M-3의 조건을 못 만든 것이다"
    );
  }
  // **본론**: 잘리는 것은 이름이고, 동사는 어떤 폭에서도 살아남는다.
  if (fit.tailClipped > 1 || fit.tailRight > fit.contentRight + 1) {
    throw new Error(
      `the verb was truncated away: 꼬리("${fit.tailText}")가 ${fit.tailClipped}px 잘렸고 ` +
        `오른끝 ${fit.tailRight}이 본문 끝 ${fit.contentRight}을 넘었다. 한국어는 동사가 ` +
        "끝에 오므로 줄 전체에 말줄임을 걸면 사라지는 것이 「작성 중」이다 (리뷰 M-3)"
    );
  }
  const narrowVisible = (await visibleTypingText(page)) ?? "";
  if (!narrowVisible.endsWith("작성 중…")) {
    throw new Error(
      `잘린 줄이 문장으로 끝나지 않는다: "${narrowVisible}" (리뷰 M-3)`
    );
  }
  // ---- W-3. 잘림은 한국어가 끊어도 되는 자리에서만 일어난다 ------------------
  //
  // 동사가 살아남는 것만으로는 부족하다는 것을 리뷰가 이 폭에서 실측했다: 꼬리가
  // 「님이 작성 중…」이던 판에서는 앞부분이 이름 한가운데를 자르고 화면에
  // `이도현 플랫폼…님이 작성 중…`이 남았다. 님은 이름에 붙는 의존 형태소라 붙을
  // 이름이 사라지면 존대할 대상이 없고, 그 줄은 한국어 문장이 아니다.
  //
  // **이 판정은 `textContent`로 할 수 없다.** CSS의 말줄임은 DOM을 바꾸지 않으므로
  // 텍스트를 읽으면 잘리지 않은 문장이 그대로 나온다 — 리뷰가 본 것은 픽셀이었다.
  // 그래서 여기서는 **글자 하나하나의 사각형**을 재서 잘림 상자 안에 실제로 그려진
  // 글자만 모은다. 그것이 「화면이 말하는 것」이다.
  const painted = await page.evaluate(() => {
    const lead = document.querySelector('[data-testid="composer-typing-lead"]');
    const tail = document.querySelector('[data-testid="composer-typing-tail"]');
    if (lead === null) return null;
    const box = lead.getBoundingClientRect();
    const walker = document.createTreeWalker(lead, NodeFilter.SHOW_TEXT);
    let visible = "";
    let clipped = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // 오른쪽 경계를 넘는 글자는 그려지지 않는다(`overflow: hidden`).
        if (rect.right <= box.right + 0.5) visible += text[i];
        else clipped = true;
      }
    }
    return {
      lead: visible,
      clipped,
      // 말줄임표는 마지막 보이는 글자를 대체해 그려진다. 줄이 눈에 말하는 문장은
      // 「보이는 앞부분 + (잘렸으면) … + 꼬리」다.
      line: `${visible}${clipped ? "…" : ""}${tail?.textContent ?? ""}`,
    };
  });
  if (painted === null) {
    throw new Error("잘림 장면에서 앞부분을 측정하지 못했다");
  }
  console.log(
    `[cut] 320폭에서 화면이 말하는 것: "${painted.line}" (잘림 ${painted.clipped ? "있음" : "없음"})`
  );
  if (!painted.clipped) {
    throw new Error(
      `이 장면이 잘림을 만들지 못했다: 화면이 "${painted.line}"을 온전히 그렸다`
    );
  }
  // **본론**: 말줄임표 바로 뒤에 조사가 오면 그것이 고아다.
  const orphan = painted.line.match(/…\s*(님|명)/);
  if (orphan !== null) {
    throw new Error(
      `잘린 이름에 조사가 매달렸다: "${painted.line}" — 「${orphan[1]}」은 앞 낱말에 ` +
        "붙는 의존 형태소라, 그 낱말이 잘려 나간 자리에 남으면 문장이 아니다 (리뷰 W-3)"
    );
  }
  // 꼬리는 **이름 없이 성립하는 서술어**여야 한다. 조사를 꼬리에 두면 위 고아가
  // 구조적으로 다시 생긴다 — 그 자리를 코어의 조각 경계가 진다.
  if (/^\s*(님|명)?[이가은는]/.test(fit.tailText)) {
    throw new Error(
      `꼬리가 조사로 시작한다 ("${fit.tailText}"): 앞부분이 잘리는 순간 그 조사는 ` +
        "붙을 낱말을 잃는다. 꼬리는 주어 없이 성립하는 서술어여야 한다 (리뷰 W-3)"
    );
  }
  // 잘린 이름과 서술어가 붙어 버리지 않는다 (`플랫폼…작성 중…`). 빈칸은 꼬리 조각이
  // 들고 있고, `whitespace-pre`가 그것을 지킨다.
  if (!/…\s/.test(painted.line)) {
    throw new Error(
      `잘린 이름과 서술어 사이에 빈칸이 없다: "${painted.line}" (리뷰 W-3)`
    );
  }
  // 1줄 고정을 지켰는가. 내용이 생겨도 액션 행 높이가 같아야 한다 (H-2와 같은 축).
  const activeActionHeight = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="composer-actions"]');
    return node === null ? -1 : Math.round(node.getBoundingClientRect().height);
  });
  if (reservedActionHeight > 0 && activeActionHeight !== reservedActionHeight) {
    throw new Error(
      `잘림 장면에서 액션 행 높이가 ${reservedActionHeight} -> ${activeActionHeight}px로 바뀌었다: ` +
        "슬롯은 1줄 고정이고, 두 줄이 되는 순간 남의 키가 내 캐럿을 민다 (리뷰 H-2)"
    );
  }

  // ---- 10b. 보조기술은 잘린 글자를 읽지 않는다 (리뷰 M-2) --------------------
  //
  // 1차는 온전한 문장을 `title`에 실었는데, 역할 없는 `<p>`의 접근 이름은 텍스트
  // 콘텐츠에서 나오므로 그 치환이 한 번도 일어나지 않았다 — 스크린리더는 잘린 채로
  // 읽었고, 잘린 이름을 되찾는 길은 사실상 마우스 hover 하나였다.
  const spoken = await accessibleTypingText(page);
  console.log(`[a11y] 보조기술이 읽는 글자: "${spoken}"`);
  if (spoken === null || spoken.trim() === "") {
    throw new Error(
      "assistive tech was left reading the truncated text: 이 줄에는 자기 접근 텍스트가 " +
        "없다. `title`은 역할 없는 `<p>`의 접근 이름을 대체하지 않는다 (리뷰 M-2)"
    );
  }
  // 보이는 줄이 부르는 두 이름은 잘려도 보조기술에는 온전히 간다(#5567 M-2: 둘이면 두 이름 다).
  if (!spoken.includes("이도현 플랫폼엔지니어링 테크리드") || !spoken.includes("김민서 프로덕트디자인")) {
    throw new Error(
      `assistive tech was left reading the truncated text: "${spoken}" 에 온전한 두 이름이 없다. ` +
        "보이는 글자가 잘려도 보조기술은 온전한 문장을 얻어야 한다 (리뷰 M-2)"
    );
  }
  if (spoken.includes("…")) {
    throw new Error(
      `보조기술이 읽을 문장에 말줄임표가 남아 있다: "${spoken}" — 스크린리더는 그것을 ` +
        "「점점점」으로 읽거나 통째로 삼킨다"
    );
  }
  // 보이는 글자와 읽히는 글자가 **다르다**는 것 자체가 이 수리의 형태다.
  if (spoken === narrowVisible) {
    throw new Error(
      "보이는 글자와 읽히는 글자가 같다: 잘림이 접근성 트리로 그대로 새어 나갔다 (리뷰 M-2)"
    );
  }
  // ---- 10c. 님은 부르는 이름마다 붙는다 (리뷰 N-1 → #5567 M-2) ---------------
  // 둘이면 두 이름을 다 부르므로 님도 이름마다 하나씩, 둘이다: 「○○님, △△님이 작성 중」.
  const honorifics = (spoken.match(/님/g) ?? []).length;
  if (honorifics !== 2 || !/테크리드님, 김민서 프로덕트디자인님이 작성 중/.test(spoken)) {
    throw new Error(
      `둘이 치는데 님이 ${honorifics}개이거나 이름마다 붙지 않았다 ("${spoken}"): 「○○님, △△님이 작성 중」이어야 한다 (#5567)`
    );
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-typing"]') === null,
    undefined,
    { timeout: 25_000 }
  );

  // ---- 1. 에이전트는 작성 중이 아니다 ---------------------------------------
  await publishTyping(page, { memberId: agentId, ttlMs: 4_000 });
  await wait(300);
  if ((await typingLine(page).count()) !== 0) {
    throw new Error(
      `an agent was rendered as 작성 중 ("${await typingLine(page).textContent()}"). ` +
        "사람은 작성 중, 에이전트는 작업 중 (ADR-0149)"
    );
  }
  const shellText = (await page.locator("body").textContent()) ?? "";
  if (shellText.includes("김인턴") && shellText.includes("작성 중")) {
    throw new Error("an agent's name appeared beside 작성 중 somewhere on the shell");
  }

  // ---- 1b. 두 낱말이 한 화면에 있어도 섞이지 않는다 --------------------------
  await publishAgentTurn(page, "queued", "queued");
  await publishAgentTurn(page, "streaming", "running");
  await publishTyping(page, { memberId: dohyunId, ttlMs: 8_000 });
  await typingLine(page).waitFor({ timeout: 5_000 });
  // #4619: `composer-working`은 이제 **예약된 칸**이다(에이전트가 있는 채널이면 비어 있어도 서 있다). 줄이 섰는지는 칸이 아니라
  // 줄의 글(`composer-working-text`)이 말한다 — 칸만 기다리면 줄이 서기 전의 빈 칸을 읽는다.
  await page.getByTestId("composer-working-text").waitFor({ timeout: 5_000 });

  const typingText = (await visibleTypingText(page)) ?? "";
  const workingText =
    (await page.getByTestId("composer-working").textContent()) ?? "";
  if (!typingText.includes("작성 중") || typingText.includes("작업")) {
    throw new Error(`the human line must say 작성 중 and nothing about 작업: "${typingText}"`);
  }
  if (!workingText.includes("작업 중") || workingText.includes("작성 중")) {
    throw new Error(
      `the agent line must say 작업 중 and never 작성 중: "${workingText}"`
    );
  }
  if (!typingText.includes("이도현")) {
    throw new Error(`the typing line must name the human: "${typingText}"`);
  }
  // 에이전트 신호는 그릇 **위**(레일), 사람 신호는 그릇 **아래** 줄이다(#5567). 두 상태 줄이 그릇을 사이에 두고 갈라 서서
  // 「작업 중」과 「작성 중」이 한 덩어리로 읽히지 않는다.
  const placement = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        '[data-testid="composer-typing"], [data-testid="composer-working"]'
      )
    );
    const typing = document.querySelector('[data-testid="composer-typing"]');
    const working = document.querySelector('[data-testid="composer-working"]');
    const frame = document.querySelector('[data-testid="composer-frame"]');
    const frameBox = frame?.getBoundingClientRect();
    return {
      order: nodes.map((node) => node.dataset.testid ?? ""),
      typingInFrame: frame?.contains(typing) ?? true,
      workingInFrame: frame?.contains(working) ?? true,
      workingAbove: frameBox ? Math.round(frameBox.top - (working?.getBoundingClientRect().bottom ?? Infinity)) : -1,
      typingBelow: frameBox ? Math.round((typing?.getBoundingClientRect().top ?? -Infinity) - frameBox.bottom) : -1,
    };
  });
  if (
    placement.order.join(",") !== "composer-working,composer-typing" ||
    placement.typingInFrame ||
    placement.workingInFrame ||
    placement.workingAbove < 0 ||
    placement.typingBelow < 0
  ) {
    throw new Error(
      `작업 중은 그릇 위, 작성 중은 그릇 아래 줄이어야 한다: ${JSON.stringify(placement)}`
    );
  }

  // ---- 1d. 작성 중은 왼쪽 정렬이고 그릇 안 글 칸의 첫 글자와 같은 세로줄에서 시작한다 (#5567) -----
  //
  // 옛 판은 보내기 단추 왼쪽에 오른쪽 정렬로 섰다. 새 줄은 Slack·Discord처럼 왼쪽이다: 점과 문장이 글 칸의 글자 기둥
  // (그릇 테두리 1 + 안쪽 여백 4 + 글 칸 인셋 12)에서 1px 안으로 시작하고, 그릇 오른끝을 넘지 않는다.
  const edges = await page.evaluate(() => {
    const typing = document.querySelector('[data-testid="composer-typing"]');
    const input = document.querySelector('[data-testid="composer-input"]');
    const frame = document.querySelector('[data-testid="composer-frame"]');
    if (!typing || !input || !frame) return null;
    const textStart = input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft);
    return {
      typingLeft: Math.round(typing.getBoundingClientRect().left),
      textStart: Math.round(textStart),
      typingRight: Math.round(typing.getBoundingClientRect().right),
      frameRight: Math.round(frame.getBoundingClientRect().right),
    };
  });
  console.log(`[align] 작성 중 왼쪽 ${edges?.typingLeft} · 글 칸 글자 ${edges?.textStart} · 오른끝 ${edges?.typingRight}/${edges?.frameRight}`);
  if (
    edges === null ||
    Math.abs(edges.typingLeft - edges.textStart) > 1 ||
    edges.typingRight > edges.frameRight
  ) {
    throw new Error(`작성 중 줄이 왼쪽 글자 기둥에서 시작하지 않거나 그릇 폭을 넘는다: ${JSON.stringify(edges)}`);
  }

  // ---- 1c. live 영역이 아니다 ----------------------------------------------
  if (proveRedLive) {
    // red seam: 드라이버가 그 줄을 live 영역 안으로 넣는다. 아래 단언이 DOM을 읽고
    // 있다면 반드시 깨진다.
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="composer-typing"]');
      node?.parentElement?.setAttribute("aria-live", "polite");
    });
  }
  const insideLive = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="composer-typing"]');
    if (!node) return "missing";
    return node.closest("[aria-live]") === null ? "outside" : "inside";
  });
  if (insideLive !== "outside") {
    throw new Error(
      `the 작성 중 line sits inside a live region (${insideLive}); a 3s-cadence signal would be read aloud over and over`
    );
  }

  // ---- 7. 뭉치기: 둘은 두 이름 다, 셋부터 「첫 이름님 외 N명」 (#5567 M-2) ----------
  // 줄이 카드 폭 전체라 이름 둘이 들어갈 자리가 있고, 넘치면 이름 쪽이 잘린다(10절). 폰(`typingVisualSegments`)과 Slack·Discord도
  // 둘까지 이름을 부른다. 집계 수(`data-count`)는 그대로 센다.
  await publishTyping(page, { memberId: minseoId, ttlMs: 8_000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="composer-typing"]')?.getAttribute("data-count") === "2",
    undefined,
    { timeout: 5_000 }
  );
  // 둘이면 두 이름 다(#5567 M-2, ADR-0149 미결 「몇 명부터」를 「셋부터」로 정함).
  const twoNames = (await visibleTypingText(page)) ?? "";
  if (twoNames !== "이도현님, 김민서님이 작성 중…") {
    throw new Error(`two typists must read as both names: "${twoNames}"`);
  }
  await publishTyping(page, { memberId: jiwooId, ttlMs: 8_000 });
  await page.waitForFunction(
    (threshold) =>
      (document.querySelector('[data-testid="composer-typing"]')?.dataset.count ??
        "") === String(threshold),
    AGGREGATE_THRESHOLD,
    { timeout: 5_000 }
  );
  const dots = typingLine(page).getByTestId("responding-dots");
  if ((await dots.getAttribute("data-motion")) !== "still" ||
      await dots.locator(".responding-dot").count() !== 0 ||
      await dots.locator(":scope > span").count() !== 3) {
    throw new Error("human typing dots must stand still under reduced motion");
  }
  // 사람 줄의 점은 글자와 같은 muted 잉크다. `--agent`는 에이전트 표지에만 쓴다(#5567).
  if ((await dots.getAttribute("data-human")) !== "" ||
      await dots.locator(".bg-agent").count() !== 0) {
    throw new Error("human typing dots must not wear the agent color");
  }
  const collapsed = (await visibleTypingText(page)) ?? "";
  if (collapsed !== `이도현님 외 ${AGGREGATE_THRESHOLD - 1}명이 작성 중…`) {
    throw new Error(
      `three or more typists retain the first name and remaining count, read "${collapsed}"`
    );
  }
  if (collapsed.includes("김민서") || collapsed.includes("박지우")) {
    throw new Error(`a collapsed line must retain only the first name: "${collapsed}"`);
  }
  // ---- N-2. 집계 숫자는 자릿폭이 고정이다 -----------------------------------
  // 2 → 3 → 4명으로 바뀌는 숫자다. 26px 아래 같은 컴포저의 「외 N명」이 이미 이
  // 표지를 쓰고 있어, 안 쓰면 한 화면에서 같은 종류의 숫자가 다르게 움직인다.
  // 숫자는 사전 문장 안(꼬리 「 외 2명이 작성 중…」)에 있다. 꼬리 조각 전체가 자릿폭 고정이다(#5567).
  const countCell = await page.evaluate(() => {
    const node = document.querySelector(
      '[data-testid="composer-typing-tail"][data-numeric]'
    );
    if (node === null) return null;
    return {
      text: node.textContent ?? "",
      variant: getComputedStyle(node).fontVariantNumeric,
    };
  });
  if (countCell === null || !/\d/.test(countCell.text)) {
    throw new Error(
      `집계 숫자가 자기 원소를 갖고 있지 않다 (${JSON.stringify(countCell)}); ` +
        "문자열 안에 녹아 있으면 자릿폭 고정을 걸 자리가 없다 (리뷰 N-2)"
    );
  }
  if (!countCell.variant.includes("tabular-nums")) {
    throw new Error(
      `집계 숫자에 tabular-nums가 걸리지 않았다 (${countCell.variant}); ` +
        "2→3→4명에서 줄 폭이 흔들린다 (리뷰 N-2)"
    );
  }
  console.log(`[numeric] 집계 숫자 "${countCell.text}" · ${countCell.variant}`);

  // 다른 채널의 신호는 이 채널의 줄에 오지 않는다.
  await publishTyping(page, {
    memberId: dohyunId,
    channelId: otherChannelId,
    ttlMs: 8_000,
  });
  await wait(300);
  const stillThree = await typingLine(page).getAttribute("data-count");
  if (stillThree !== String(AGGREGATE_THRESHOLD)) {
    throw new Error(
      `a signal for another channel leaked into this one (count ${stillThree})`
    );
  }

  // ---- 3. TTL 소멸: 사라지게 하려고 서버에 묻지 않는다 -----------------------
  const publishesBeforeWait = traffic.publishes.length;
  const ttlStart = Date.now();
  // 새 신호 하나만 남기고 짧은 TTL로 갈아 준다. 나머지는 8초 TTL이라 아래 대기와
  // 섞이므로, 먼저 그것들이 만료되기를 기다린다.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-typing"]') === null,
    undefined,
    { timeout: 12_000 }
  );
  console.log(
    `[ttl] 8s TTL 신호 3건이 ${Math.round(Date.now() - ttlStart)}ms 뒤 스스로 사라졌다`
  );
  await publishTyping(page, { memberId: dohyunId, ttlMs: GATE_TTL_MS });
  await typingLine(page).waitFor({ timeout: 5_000 });
  const ttlWaitMs = GATE_TTL_MS + 1_500;
  if (proveRedTtl) {
    // red seam: **기다리는 창 전체에 걸쳐** 계속 재발행한다. 재발행하면 살아 있는
    // 것이 맞는 동작이므로, 「스스로 사라진다」 단언이 DOM을 읽고 있다면 반드시
    // 깨진다. (첫 시도는 창보다 짧게 재발행해서 red가 되지 않았다 — 마지막 재발행이
    // 판정 시점보다 TTL만큼 앞이면 그 사이에 정상적으로 만료된다.)
    const deadline = Date.now() + ttlWaitMs;
    while (Date.now() < deadline) {
      await wait(400);
      await publishTyping(page, { memberId: dohyunId, ttlMs: GATE_TTL_MS });
    }
  } else {
    await wait(ttlWaitMs);
  }
  if ((await typingLine(page).count()) !== 0) {
    throw new Error(
      `the typing line outlived its own expiry: still reads "${await typingLine(
        page
      ).textContent()}"`
    );
  }
  if (traffic.publishes.length !== publishesBeforeWait) {
    throw new Error(
      "the client asked the server something in order to forget; the expiry rides the signal (가드 4)"
    );
  }

  // ---- 3b. 「정지」 요청은 존재하지 않는다 ------------------------------------
  for (const body of traffic.bodies) {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "grant") {
      throw new Error(
        `a typing publish carried more than its grant: ${JSON.stringify(body)}`
      );
    }
  }

  // ---- 4./5. 송신: 키가 발행을 만들고, 멈추면 멈춘다 -------------------------
  const sendStart = Date.now();
  await typeFor(page, 7_000);
  const duringBurst = traffic.publishes.length;
  const grantsAfterBurst = traffic.grants;

  if (duringBurst < 2) {
    throw new Error(
      `7초를 치는 동안 발행이 ${duringBurst}건이다: 키가 발행을 만들지 못했다`
    );
  }
  // 3초 간격이면 7초에 3건이 상한선 근처다. 4건을 넘으면 서버가 말한 간격을 안 지킨
  // 것이고, 그것이 outbox 대신 이 통로를 뚫은 이유를 되돌린다.
  if (duringBurst > 4) {
    throw new Error(
      `발행이 ${duringBurst}건이다: 서버가 말한 ${REPUBLISH_MS}ms 간격을 지키지 않았다`
    );
  }
  const gaps = traffic.publishes
    .slice(1)
    .map((entry, index) => entry.atMs - traffic.publishes[index].atMs);
  console.log(
    `[cadence] ${Math.round(Date.now() - sendStart)}ms 타이핑 -> 발행 ${duringBurst}건, 간격 ${JSON.stringify(
      gaps.map(Math.round)
    )}`
  );

  // ---- 5. grant 재사용 -----------------------------------------------------
  if (grantsAfterBurst !== 1) {
    throw new Error(
      `the grant was re-fetched: ${grantsAfterBurst} grant requests for one burst. ` +
        "발행마다 grant를 받으면 분당 20번의 멤버십 SELECT가 되고, 두 라우트로 나눈 이유가 사라진다"
    );
  }
  const tokens = new Set(traffic.publishes.map((entry) => entry.grant));
  if (tokens.size !== 1) {
    throw new Error(
      `one burst used ${tokens.size} different grants: ${JSON.stringify(
        Array.from(tokens)
      )}`
    );
  }
  // #839: 목이 같은 tick에 답하지 않았고, 그래서 순서가 실제 순서다.
  if (traffic.order[0] !== "grant") {
    throw new Error(
      `the first thing on the wire must be the grant, read ${JSON.stringify(
        traffic.order.slice(0, 3)
      )}`
    );
  }

  // ---- 4. 입력이 멈추면 송신도 멈춘다 ---------------------------------------
  const beforeIdle = traffic.publishes.length;
  if (proveRedStop) {
    // red seam: 멈춰야 할 구간에도 계속 친다. 「멈추면 멈춘다」 단언이 실제로
    // 발행을 세고 있다면 반드시 깨진다.
    await typeFor(page, 6_500);
  } else {
    await wait(6_500);
  }
  if (traffic.publishes.length !== beforeIdle) {
    throw new Error(
      `publishing continued after the input stopped: ${
        traffic.publishes.length - beforeIdle
      } more publish(es) in 6.5s of silence. TTL owns disappearance, and there is no stop signal (ADR-0149)`
    );
  }
  console.log(
    `[idle] 6.5초 무입력 -> 발행 0건 추가 (총 ${traffic.publishes.length}건)`
  );

  // ---- 소켓은 여전히 하나다 -------------------------------------------------
  const finalSockets = await page.evaluate(() => window.__typingGateSocketCount());
  if (finalSockets !== 1) {
    throw new Error(
      `a second socket appeared during the run (${finalSockets}); 「작성 중」 must not open one`
    );
  }

  await context.close();
}

/** 리뷰용 스크린샷 (SKILL §11). 판정하지 않는다. */
async function captureShots(browser, options = {}) {
  const dense = options.dense === true;
  // 좁은 폭 + 긴 표시명. 이 판이 U4-4 W1이 실제로 바꾼 화면이다 — 이름은 줄고
  // 「님이 작성 중…」은 그대로 남는다 (M-3).
  const narrow = options.narrow === true;
  const outDir = resolve(webRoot, "artifacts/typing");
  mkdirSync(outDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    const traffic = makeTraffic();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
      colorScheme: scheme,
      locale: "ko-KR",
    });
    const page = await context.newPage();
    await installRealtimeSocket(page);
    await installRoutes(context, traffic, { dense });
    await login(page);
    // 좁히는 것은 **로그인 뒤**다. 320폭에서는 연결 화면의 버튼이 뷰포트 밖으로
    // 밀려 클릭이 타임아웃한다 — 캡처하려는 것은 채팅 표면이지 그 경로가 아니다.
    if (narrow) await page.setViewportSize({ width: 320, height: 800 });
    await publishAgentTurn(page, "queued", "queued");
    await publishAgentTurn(page, "streaming", "running");
    await publishTyping(page, {
      memberId: narrow ? longAId : dohyunId,
      ttlMs: 30_000,
    });
    await publishTyping(page, {
      memberId: narrow ? longBId : minseoId,
      ttlMs: 30_000,
    });
    await page.getByTestId("composer-typing").waitFor();
    await page.getByTestId("composer-input").fill("저도 곧 올립니다.");
    if (dense) {
      // 200행이 실제로 화면에 있는지 확인한 뒤 찍는다 — 밀집을 주장하는 캡처가
      // 빈 채널이면 증거가 아니다.
      const count =
        (await page.getByTestId("message-count").textContent()) ?? "";
      if (!count.includes("200")) {
        throw new Error(`밀집 캡처가 200행을 담지 못했다: "${count}"`);
      }
    }
    const name = dense
      ? `typing-dense-${scheme}`
      : narrow
        ? `typing-narrow-${scheme}`
        : `typing-${scheme}`;
    await page.screenshot({ path: resolve(outDir, `${name}.png`) });
    await context.close();
  }
  console.log(
    dense
      ? "[shots] artifacts/typing/typing-dense-{light,dark}.png (200행)"
      : narrow
        ? "[shots] artifacts/typing/typing-narrow-{light,dark}.png (320폭 · 긴 표시명)"
        : "[shots] artifacts/typing/typing-{light,dark}.png"
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "TYPING_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exercise(browser);
      if (process.env.TYPING_GATE_SHOTS === "1") {
        await captureShots(browser);
        // N-4: 루브릭 phase 5. 액션 슬롯의 작성 중+그릇 위 작업 중이 밀집
        // 타임라인 위에서 어떻게 읽히는가.
        await captureShots(browser, { dense: true });
        // U4-4 W1: 잘림이 실제로 일어나는 판. 이름은 줄고 말은 안 줄어야 한다 (M-3).
        await captureShots(browser, { narrow: true });
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 소켓 1개로 「작성 중」이 실렸고, 에이전트도 나 자신도");
  console.log("           그려지지 않았고, 「작성 중」과 「작업 중」이 한 화면에서");
  console.log("           서로의 낱말을 쓰지 않았고, 신호는 자기 만료로 사라졌고,");
  console.log("           입력이 멈추자 송신도 멈췄고, grant는 한 번만 나갔다.");
}

await main();
