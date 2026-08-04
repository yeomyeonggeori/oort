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
//   7. 뭉치기          임계는 **grant 응답 값**이다. 3명이면 「3명이 작성 중」.
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
//
// red seam은 **목/드라이버의 행동만** 바꾼다. AGENT는 명부에서 에이전트를 사람으로
// 바꾸고, SELF는 내 id 대신 남의 id로 발행하고, TTL은 기다리는 동안 계속 재발행하고,
// STOP은 멈춰야 할 구간에도 계속 타이핑하고, GRANT는 grant TTL을 1초로 줄이고, LIVE는
// DOM에서 그 줄을 live 영역 안으로 넣는다. 제품 소스 줄을 지우거나 단언을 빼라고
// 요구하지 않으므로 증명은 반복 가능하다.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.TYPING_GATE_PORT || 5195);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const dohyunId = "00000000-0000-7000-8000-000000000102";
const minseoId = "00000000-0000-7000-8000-000000000103";
const jiwooId = "00000000-0000-7000-8000-000000000104";
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

// 목의 응답 지연 (#839 교훈). 같은 tick에 답하는 목은 아무것도 증명하지 않는다.
const GRANT_DELAY_MS = 180;
const PUBLISH_DELAY_MS = 60;

// 서버 값 그대로 (`momo-ephemeral::signal.rs`).
const REPUBLISH_MS = 3_000;
const AGGREGATE_THRESHOLD = 3;
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

function makeTraffic() {
  return { grants: 0, publishes: [], order: [], bodies: [] };
}

async function installRoutes(context, traffic) {
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
    if (path.includes("/messages")) return json(route, { messages: [] });
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
  throw new Error("typing gate preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
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
  await page.getByTestId("composer-working").waitFor({ timeout: 5_000 });

  const typingText = (await typingLine(page).textContent()) ?? "";
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
  // 사람이 위, 에이전트가 아래. 같은 구역에 나란히 두는 것이 사람이 두 낱말의 차이를
  // 배우는 자리이므로, 순서가 뒤집히면 그 설계 의도가 화면에서 사라진다.
  const order = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        '[data-testid="composer-typing"], [data-testid="composer-working"]'
      )
    );
    return nodes.map((node) => node.dataset.testid ?? "");
  });
  if (order.join(",") !== "composer-typing,composer-working") {
    throw new Error(
      `사람 위, 에이전트 아래여야 한다: read ${JSON.stringify(order)}`
    );
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

  // ---- 7. 뭉치기는 grant 값을 탄다 -----------------------------------------
  await publishTyping(page, { memberId: minseoId, ttlMs: 8_000 });
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="composer-typing"]')?.textContent ?? "")
        .includes("김민서"),
    undefined,
    { timeout: 5_000 }
  );
  const twoNames = (await typingLine(page).textContent()) ?? "";
  if (!twoNames.includes("이도현") || !twoNames.includes("김민서")) {
    throw new Error(`two typists must both be named: "${twoNames}"`);
  }
  await publishTyping(page, { memberId: jiwooId, ttlMs: 8_000 });
  await page.waitForFunction(
    (threshold) =>
      (document.querySelector('[data-testid="composer-typing"]')?.dataset.count ??
        "") === String(threshold),
    AGGREGATE_THRESHOLD,
    { timeout: 5_000 }
  );
  const collapsed = (await typingLine(page).textContent()) ?? "";
  if (collapsed !== `${AGGREGATE_THRESHOLD}명이 작성 중…`) {
    throw new Error(
      `at the server's threshold the names collapse to a count, read "${collapsed}"`
    );
  }
  if (collapsed.includes("이도현") || collapsed.includes("김민서")) {
    throw new Error(`a collapsed line must not still carry names: "${collapsed}"`);
  }

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
async function captureShots(browser) {
  const outDir = resolve(webRoot, "artifacts/typing");
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
    await publishAgentTurn(page, "queued", "queued");
    await publishAgentTurn(page, "streaming", "running");
    await publishTyping(page, { memberId: dohyunId, ttlMs: 30_000 });
    await publishTyping(page, { memberId: minseoId, ttlMs: 30_000 });
    await page.getByTestId("composer-typing").waitFor();
    await page.getByTestId("composer-input").fill("저도 곧 올립니다.");
    await page.screenshot({ path: resolve(outDir, `typing-${scheme}.png`) });
    await context.close();
  }
  console.log("[shots] artifacts/typing/typing-{light,dark}.png");
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
      if (process.env.TYPING_GATE_SHOTS === "1") await captureShots(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 소켓 1개로 「작성 중」이 실렸고, 에이전트도 나 자신도");
  console.log("           그려지지 않았고, 「작성 중」과 「작업 중」이 한 화면에서");
  console.log("           서로의 낱말을 쓰지 않았고, 신호는 자기 만료로 사라졌고,");
  console.log("           입력이 멈추자 송신도 멈췄고, grant는 한 번만 나갔다.");
}

await main();
