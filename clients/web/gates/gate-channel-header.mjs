#!/usr/bin/env node
// GATE: 채널 헤더 (검수 피드백 #3 · #1865).
//
// 이 게이트가 지키는 것은 헤더가 그려지는지가 아니라 **헤더가 하는 말과 각 액션이
// 서버 진실을 따르는가**다.
//
//   1. 헤더는 1줄이다    토픽은 헤더에 상시 서지 않는다. ⋮ 메뉴의 「주제 보기」가
//                        기존 읽기 다이얼로그를 열고, 거기 서버가 준 전체 문장이
//                        선다. 갱신 라우트가 없어 「편집」은 그리지 않는다.
//   2. 인원수는 목록이다 헤더의 멤버 표시는 숫자 버튼이고, 사람·에이전트 목록과
//                        기존 멤버 추가 다이얼로그로 이어진다. 좁은 폭에서도 남는다.
//   3. ⋮ 가 메뉴다       우측 라운드 그룹의 마지막이 채널을 다루는 메뉴다. 항목은
//                        주제 보기·알림 끄기/켜기·채널 나가기다 — 「이름 수정」은
//                        서버 라우트가 없어(2026-08-10 실측) 그리지 않는다.
//   4. 낱말은 상태다     알림을 끄면 다음에 여는 메뉴의 낱말이 「켜기」로 뒤집힌다.
//                        그 뒤집힘은 낙관적 추측이 아니라 서버가 저장한 muted를
//                        다시 읽은 결과다.
//   5. 나가기는 파괴다    「채널 나가기」는 확인 다이얼로그를 거쳐 DELETE를 보내고,
//                        성공하면 그 채널을 떠난다. 낙관적으로 지운 목록은 실패
//                        하면 되돌아온다.
//   6. 권한 없는 문은 안 연다  서버 `remove_member`는 오너/관리자만 멤버십을 지울
//                        수 있으므로, 일반 멤버의 메뉴에는 「나가기」가 아예 서지
//                        않는다(확인 뒤 403으로 끝나는 막다른 길을 만들지 않는다).
//   7. 컨트롤 그룹       우측은 [👥 N] [허들] [⋮] 순(기존 터미널·고정은 같은
//                        문법으로 앞에 흡수). 각 버튼은 키보드로 닿고 aria-label
//                        이 있다.
//
// 이름 붙은 red proof (버릴 워크트리에서만 돌린다):
//   HEADER_GATE_PROVE_RED_COUNT=1 npm run gate:channel-header
//     expected failure: "the member count node was not read from the DOM"
//   HEADER_GATE_PROVE_RED_RENAME=1 npm run gate:channel-header
//     expected failure: "a rename item leaked into the menu"
//   HEADER_GATE_PROVE_RED_MUTE=1 npm run gate:channel-header
//     expected failure: "the mute word did not flip with the stored state"
//   HEADER_GATE_PROVE_RED_LEAVE=1 npm run gate:channel-header
//     expected failure: "leaving did not take effect"
//
// red seam은 **목/드라이버의 행동만** 바꾼다. COUNT는 DOM에서 인원수 노드를 걷어
// 내고, RENAME은 메뉴에 가짜 「이름 수정」 항목을 끼우고, MUTE는 목이 PUT을 무시해
// muted를 뒤집지 않으며, LEAVE는 목이 DELETE에 403을 돌려준다. 제품 소스 줄을
// 지우거나 단언을 빼라고 요구하지 않으므로 증명은 반복 가능하다.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 세 액션의 낱말을 코어 소스에서 읽는다(gate-pin이 pins.ts에 하는 것과 같은 규율).
 * 게이트가 문자열을 다시 적으면 정본이 바뀐 날 게이트만 혼자 초록으로 남는다.
 */
function canonicalCopy(root) {
  const model = readFileSync(
    resolve(root, "../../packages/momo-core/src/features/channels/model.ts"),
    "utf8"
  );
  const mute = /export const CHANNEL_MUTE_LABEL = "([^"]+)";/.exec(model);
  const unmute = /export const CHANNEL_UNMUTE_LABEL = "([^"]+)";/.exec(model);
  const leave = /export const CHANNEL_LEAVE_LABEL = "([^"]+)";/.exec(model);
  const topicView = /export const CHANNEL_TOPIC_VIEW_LABEL = "([^"]+)";/.exec(model);
  if (!mute || !unmute || !leave || !topicView) {
    throw new Error(
      "채널 헤더 메뉴의 낱말을 코어에서 찾지 못했다: 게이트가 검사할 문자열의 정본이 사라졌다"
    );
  }
  return {
    mute: mute[1],
    unmute: unmute[1],
    leave: leave[1],
    topicView: topicView[1],
  };
}

const {
  mute: MUTE_LABEL,
  unmute: UNMUTE_LABEL,
  topicView: TOPIC_VIEW_LABEL,
} = canonicalCopy(webRoot);

const proveRedCount = process.env.HEADER_GATE_PROVE_RED_COUNT === "1";
const proveRedRename = process.env.HEADER_GATE_PROVE_RED_RENAME === "1";
const proveRedMute = process.env.HEADER_GATE_PROVE_RED_MUTE === "1";
const proveRedLeave = process.env.HEADER_GATE_PROVE_RED_LEAVE === "1";

const port = Number(process.env.HEADER_GATE_PORT || 5198);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ownerId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const agentId = "00000000-0000-7000-8000-000000000103";
const channelId = "00000000-0000-7000-8000-000000000201";
// 서버가 저장하는 토픽은 이미 다듬어져 있고(CreateChannelInput.topic 주석),
// 클라이언트는 normalizeChannelTopic(=trim)을 한 번 더 걸어 방어한다. 그래서
// 이 상수도 정규화된 형태여야 한다 — 끝 공백을 달고 원본과 비교하면 컴포넌트의
// 정당한 trim이 게이트에서 거짓 실패로 읽힌다.
const CHANNEL_TOPIC = (
  "release-2026-08 운영 토픽: 온콜 교대, 배포 판단, 고객 영향, 롤백 조건을 이 채널에서 함께 기록합니다. " +
  "긴 문장도 헤더의 다른 컨트롤을 밀어내지 않으며, 전체 내용은 키보드로 열어 읽을 수 있어야 합니다. ".repeat(2)
).trim();

function session(memberId, displayName, handle) {
  return {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: { id: memberId, workspaceId, kind: "human", displayName, handle },
    realtimeWebSocketUrl: "ws://header-gate.invalid/connection/websocket",
  };
}

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

/** 두 사람 모두 이 채널에 있다 — 인원수는 2다. */
function roster(selfRole) {
  return [
    member({
      id: ownerId,
      kind: "human",
      role: selfRole,
      displayName: "곽성재",
      handle: "seongjae",
    }),
    member({ id: peerId, kind: "human", displayName: "이도현", handle: "dohyun" }),
    member({
      id: agentId,
      kind: "agent",
      displayName: "김인턴",
      handle: "kim-intern",
      ownerHumanId: ownerId,
      agentModel: "gpt-5.6",
    }),
  ];
}

function channelRow(muted) {
  return {
    id: channelId,
    workspaceId,
    kind: "public",
    name: "release-2026-08",
    topic: CHANNEL_TOPIC,
    muted,
  };
}

const AT = 1_785_238_400_000;

function message(over) {
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    authorMemberId: peerId,
    body: "온콜 교대는 매주 화요일 10시입니다.",
    seq: 42,
    id: "0199cccc-0000-7000-8000-0000000000a1",
    hlcTs: AT + 42_000,
    createdAtMs: AT + 42_000,
    ...over,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** 셸이 연결을 기다리므로 최소한의 WS 스텁이 필요하다(프레임은 쓰지 않는다). */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
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
            replies.push({ id: command.id, connect: { client: "header-gate", subs: {} } });
          } else if (command.subscribe) {
            this.subscriptions.add(command.subscribe.channel);
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, recovered: true, epoch: "header-gate", offset },
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
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

function makeTraffic() {
  return {
    mutePuts: [],
    memberDeletes: [],
    rosterAttempts: 0,
    releaseRoster: null,
  };
}

/**
 * @param options.selfRole  로그인 멤버의 역할("owner" | "member").
 */
async function installRoutes(context, traffic, options = {}) {
  const selfRole = options.selfRole ?? "owner";
  const rosterScenario = options.rosterScenario ?? "ready";
  // 서버 진실의 그림자: 알림을 끄면 여기서 뒤집히고, 나가면 목록에서 빠진다.
  let muted = false;
  let left = false;

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/v1/auth/login") {
      return json(route, session(ownerId, "곽성재", "seongjae"));
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: ownerId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }

    // 알림 끄기/켜기. 몸통은 플래그 하나뿐이고, 서버는 저장한 값을 그대로 준다.
    if (path.endsWith("/notification-pref") && method === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}");
      traffic.mutePuts.push(body);
      // red seam: PUT을 무시하고 muted를 뒤집지 않는다. 낱말이 서버 진실을 읽고
      // 있다면, 다시 연 메뉴는 여전히 「끄기」다.
      if (!proveRedMute) muted = Boolean(body.muted);
      return json(route, { muted });
    }

    // 채널 나가기. 자기 자신의 멤버십을 지운다.
    if (path.includes("/members/") && method === "DELETE") {
      traffic.memberDeletes.push(path);
      // red seam: 오너/관리자만 지울 수 있다는 서버를 흉내 내 403을 돌려준다.
      // 그러면 나가기는 발효되지 않고, 성공에 매인 단언들이 깨진다.
      if (proveRedLeave) {
        return json(route, { error: { code: "forbidden", message: "admin only" } }, 403);
      }
      left = true;
      return json(route, {
        membership: {
          id: "00000000-0000-7000-8000-000000000301",
          workspaceId,
          channelId,
          memberId: ownerId,
          role: selfRole,
          joinedAtMs: 1,
          leftAtMs: AT,
        },
      });
    }

    if (path.endsWith("/roster") || (path.endsWith("/members") && method === "GET")) {
      traffic.rosterAttempts += 1;
      if (rosterScenario === "loading" && traffic.rosterAttempts === 1) {
        await new Promise((resolveRoster) => {
          traffic.releaseRoster = resolveRoster;
        });
      }
      // QueryClient의 retry:1 두 번까지 실패시키고, 패널의 「다시 시도」가 만든
      // 셋째 요청에서 회복한다. 자동 재시도가 실패 표면을 지워 버리지 못하게 한다.
      if (rosterScenario === "failed-retry" && traffic.rosterAttempts <= 2) {
        return json(
          route,
          { error: { code: "unavailable", message: "roster unavailable" } },
          503
        );
      }
      return json(route, { members: roster(selfRole) });
    }
    if (path.endsWith("/channels")) {
      return json(route, { channels: left ? [] : [channelRow(muted)] });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, { messages: [message({})] });
    }

    return json(route, {});
  });
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("header@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor();
  await page.getByTestId("channel-item").first().click();
  await page.getByTestId("channel-title-menu").waitFor({ timeout: 15_000 });
}

async function openMenu(page) {
  await page.getByTestId("channel-title-menu").click();
  await page.getByTestId("channel-title-menu-content").waitFor();
}

async function exercise(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic, { selfRole: "owner" });
  await login(page);
  await page.getByTestId("huddle-start").waitFor({ timeout: 15_000 });

  // ---- 1. 헤더는 1줄이고, 토픽 전체는 ⋮ 메뉴에서 읽힌다 ----------------------
  const headerBox = await page.getByTestId("channel-header").boundingBox();
  if (!headerBox || headerBox.height > 52) {
    throw new Error(
      `the channel header must be a single row, height ${headerBox?.height}`
    );
  }
  if ((await page.getByTestId("channel-topic").count()) !== 0) {
    throw new Error("the channel topic was still drawn in the always-visible header");
  }
  const controlOrder = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="channel-header-controls"]');
    if (!group) return [];
    const ids = [];
    const walk = (root) => {
      for (const child of root.children) {
        const id = child.getAttribute("data-testid");
        if (id) ids.push(id);
        else walk(child);
      }
    };
    walk(group);
    return ids;
  });
  const memberIdx = controlOrder.indexOf("channel-member-count");
  const huddleIdx = controlOrder.indexOf("huddle-surface");
  const menuIdx = controlOrder.indexOf("channel-title-menu");
  if (!(memberIdx >= 0 && huddleIdx > memberIdx && menuIdx > huddleIdx)) {
    throw new Error(
      `control group order must be members, huddle, overflow; got ${JSON.stringify(controlOrder)}`
    );
  }
  const huddleStart = page.getByTestId("huddle-start");
  if ((await huddleStart.getAttribute("aria-label")) !== "허들 시작") {
    throw new Error("the idle huddle control must keep an aria-label for 허들 시작");
  }

  await openMenu(page);
  const topic = page.getByTestId("channel-topic");
  if ((await topic.count()) !== 1) {
    throw new Error("the overflow menu did not offer 주제 보기");
  }
  if (((await topic.textContent()) ?? "").trim() !== TOPIC_VIEW_LABEL) {
    throw new Error(
      `the topic item must read "${TOPIC_VIEW_LABEL}", read "${(await topic.textContent())?.trim()}"`
    );
  }
  await topic.focus();
  await page.keyboard.press("Enter");
  const topicDialog = page.getByTestId("channel-topic-dialog");
  await topicDialog.waitFor();
  if ((await page.getByTestId("channel-topic-full").textContent()) !== CHANNEL_TOPIC) {
    throw new Error("the topic dialog did not expose the full channel topic");
  }
  await page.keyboard.press("Escape");
  await topicDialog.waitFor({ state: "detached" });
  if (
    !(await page
      .getByTestId("channel-title-menu")
      .evaluate((node) => node === document.activeElement))
  ) {
    throw new Error(
      "closing the topic dialog with Escape did not return focus to the overflow menu"
    );
  }

  // ---- 2. 인원수는 숫자 버튼이고, 목록·추가 경로로 이어진다 --------------------
  if (proveRedCount) {
    // red seam: DOM에서 인원수 노드를 걷어낸다. 단언이 화면을 보고 있다면 깨진다.
    await page.evaluate(() => {
      document.querySelector('[data-testid="channel-member-count"]')?.remove();
    });
  }
  const countNode = page.getByTestId("channel-member-count");
  if ((await countNode.count()) !== 1) {
    throw new Error(
      "the member count node was not read from the DOM — the header must show 사람 아이콘 + 인원수"
    );
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="channel-member-count"]')
        ?.getAttribute("data-roster-status") === "ready",
    undefined,
    { timeout: 6_000 }
  );
  const countText = ((await countNode.textContent()) ?? "").trim();
  if (countText !== "3") {
    throw new Error(
      `the member count must be the roster's count of this channel (3), read "${countText}"`
    );
  }
  const countLabel = (await countNode.getAttribute("aria-label")) ?? "";
  if (!countLabel.includes("3")) {
    throw new Error(
      `the count needs an accessible name carrying the number, read "${countLabel}"`
    );
  }

  await countNode.focus();
  await page.keyboard.press("Enter");
  const memberPanel = page.getByTestId("channel-member-panel");
  await memberPanel.waitFor();
  if ((await page.getByTestId("channel-member-item").count()) !== 3) {
    throw new Error("the member panel did not render the same three rows the count names");
  }
  const agentRow = page.locator(
    '[data-testid="channel-member-item"][data-member-kind="agent"]'
  );
  if ((await agentRow.count()) !== 1 || !((await agentRow.textContent()) ?? "").includes("에이전트")) {
    throw new Error("the member panel did not distinguish the agent row in text");
  }
  await page.keyboard.press("Escape");
  await memberPanel.waitFor({ state: "detached" });
  if (!(await countNode.evaluate((node) => node === document.activeElement))) {
    throw new Error("closing the member panel with Escape did not return focus to the count");
  }

  // 오프라인은 실패와 다른 넷째 상태다. 마지막으로 받은 세 행은 계속 읽히고,
  // 재연결 전에는 같은 요청을 반복하라는 버튼 대신 연결 사실을 인라인으로 말한다.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await countNode.click();
  await page.getByTestId("channel-member-offline").waitFor();
  if ((await page.getByTestId("channel-member-item").count()) !== 3) {
    throw new Error("the offline member panel hid the last received roster");
  }
  if ((await page.getByTestId("channel-member-failed").count()) !== 0) {
    throw new Error("the offline member panel mislabeled disconnection as a retryable failure");
  }
  await page.keyboard.press("Escape");
  await memberPanel.waitFor({ state: "detached" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // The old `wide-only` count disappeared below 600px. Both context controls
  // remain reachable now, and the header still does not widen the document.
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    !(await countNode.isVisible()) ||
    !(await page.getByTestId("channel-title-menu").isVisible())
  ) {
    throw new Error("member count or overflow menu disappeared at the narrow viewport");
  }
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  if (horizontalOverflow) {
    throw new Error("the channel context controls widened the narrow document");
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // The panel's action reuses the one shell-owned add-member dialog.
  await countNode.click();
  await memberPanel.waitFor();
  await page.getByTestId("channel-member-add").click();
  const addDialog = page.getByTestId("add-channel-member-dialog");
  await addDialog.waitFor();
  await page.getByTestId("add-member-close").click();
  await addDialog.waitFor({ state: "detached" });

  // ---- 3. ⋮ 가 메뉴다, 그리고 「이름 수정」은 없다 -----------------------------
  await openMenu(page);
  if (proveRedRename) {
    // red seam: 메뉴에 가짜 「이름 수정」 항목을 끼운다. 「rename 없음」 단언이
    // 실제로 화면을 읽고 있다면 깨진다.
    await page.evaluate(() => {
      const menu = document.querySelector('[data-testid="channel-title-menu-content"]');
      if (menu) {
        const item = document.createElement("div");
        item.textContent = "이름 수정";
        menu.appendChild(item);
      }
    });
  }
  const menuText = (await page.getByTestId("channel-title-menu-content").textContent()) ?? "";
  if (menuText.includes("이름 수정")) {
    throw new Error(
      "a rename item leaked into the menu — there is no server route to rename a channel (2026-08-10 실측), so it must not be drawn"
    );
  }
  const muteItem = page.getByTestId("channel-mute-toggle");
  if (((await muteItem.textContent()) ?? "").trim() !== MUTE_LABEL) {
    throw new Error(
      `an unmuted channel's item must read "${MUTE_LABEL}", read "${(await muteItem.textContent())?.trim()}"`
    );
  }
  if ((await page.getByTestId("channel-leave").count()) !== 1) {
    throw new Error("an owner must be offered 채널 나가기");
  }

  // ---- 4. 낱말은 상태다: 알림을 끄면 다음에 여는 낱말이 뒤집힌다 --------------
  await muteItem.click();
  await page.getByTestId("channel-title-menu-content").waitFor({ state: "detached" });
  if (traffic.mutePuts.length !== 1 || traffic.mutePuts[0].muted !== true) {
    throw new Error(
      `muting must PUT exactly {muted:true} once, saw ${JSON.stringify(traffic.mutePuts)}`
    );
  }
  // 몸통에 memberId가 없어야 한다: 남을 음소거할 수 없다.
  if ("memberId" in traffic.mutePuts[0]) {
    throw new Error("the mute body named a member — a caller can only mute themselves");
  }
  // 다시 열어 낱말이 서버가 저장한 muted를 따라 뒤집혔는지 본다. 무효화 뒤
  // 재조회가 도착할 때까지 폴링한다.
  await page.waitForFunction(
    (unmute) => {
      const trigger = document.querySelector('[data-testid="channel-title-menu"]');
      if (trigger?.getAttribute("data-state") !== "open") {
        trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        trigger?.click?.();
      }
      const item = document.querySelector('[data-testid="channel-mute-toggle"]');
      return item?.textContent?.trim() === unmute;
    },
    UNMUTE_LABEL,
    { timeout: 6_000 }
  ).catch(() => {
    throw new Error(
      `the mute word did not flip with the stored state — after muting, reopening must read "${UNMUTE_LABEL}"`
    );
  });
  // 메뉴를 닫아 다음 단계로 넘어간다.
  await page.keyboard.press("Escape");
  await page.getByTestId("channel-title-menu-content").waitFor({ state: "detached" });

  // ---- 5. 나가기는 파괴다: 확인 → DELETE → 채널을 떠난다 ----------------------
  await openMenu(page);
  await page.getByTestId("channel-leave").click();
  await page.getByTestId("channel-leave-confirm").waitFor();
  // 확인 없이는 아무것도 지우지 않는다: 다이얼로그가 뜬 것만으로 DELETE가 나가면 안 된다.
  if (traffic.memberDeletes.length !== 0) {
    throw new Error("leaving fired before the confirmation was answered");
  }
  await page.getByTestId("channel-leave-confirm-action").click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="channel-item"]').length === 0,
    undefined,
    { timeout: 6_000 }
  ).catch(() => {
    throw new Error(
      "leaving did not take effect — the left channel must disappear from the sidebar"
    );
  });
  if (traffic.memberDeletes.length !== 1) {
    throw new Error(
      `leaving must DELETE the membership exactly once, saw ${traffic.memberDeletes.length}`
    );
  }
  if (!traffic.memberDeletes[0].endsWith(`/members/${ownerId}`)) {
    throw new Error(
      `leaving must remove the caller's own membership, deleted "${traffic.memberDeletes[0]}"`
    );
  }
  // 방금 나온 채널의 헤더에 머무를 수 없다.
  if ((await page.getByTestId("channel-title-menu").count()) !== 0) {
    throw new Error("the header still shows the channel a member just left");
  }

  await context.close();
}

/**
 * PinListMenu의 세 상태 문법을 멤버 목록도 지킨다. 첫 로스터 요청을 붙들어 실제
 * 로딩 막대를 보고, 다른 컨텍스트에서는 자동 재시도까지 실패시킨 뒤 패널 안의
 * 「다시 시도」가 목록을 회복하는지 본다.
 */
async function exerciseRosterStates(browser) {
  const loadingTraffic = makeTraffic();
  const loadingContext = await browser.newContext({
    viewport: { width: 900, height: 760 },
    reducedMotion: "reduce",
  });
  const loadingPage = await loadingContext.newPage();
  await installRealtimeSocket(loadingPage);
  await installRoutes(loadingContext, loadingTraffic, {
    selfRole: "owner",
    rosterScenario: "loading",
  });
  await login(loadingPage);
  const loadingTrigger = loadingPage.getByTestId("channel-member-count");
  if ((await loadingTrigger.getAttribute("data-roster-status")) !== "loading") {
    throw new Error("the member trigger did not expose the roster loading state");
  }
  await loadingTrigger.click();
  const loadingPanel = loadingPage.getByTestId("channel-member-panel");
  await loadingPanel.waitFor();
  if ((await loadingPanel.getByTestId("skeleton-row").count()) === 0) {
    throw new Error("the member panel loading state did not preserve its row height");
  }
  loadingTraffic.releaseRoster?.();
  await loadingPage.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="channel-member-panel"]')
        ?.getAttribute("data-roster-status") === "ready",
    undefined,
    { timeout: 6_000 }
  );
  if ((await loadingPage.getByTestId("channel-member-item").count()) !== 3) {
    throw new Error("the member panel did not replace loading rows with the roster");
  }
  await loadingContext.close();

  const retryTraffic = makeTraffic();
  const retryContext = await browser.newContext({
    viewport: { width: 900, height: 760 },
    reducedMotion: "reduce",
  });
  const retryPage = await retryContext.newPage();
  await installRealtimeSocket(retryPage);
  await installRoutes(retryContext, retryTraffic, {
    selfRole: "owner",
    rosterScenario: "failed-retry",
  });
  await login(retryPage);
  const retryTrigger = retryPage.getByTestId("channel-member-count");
  await retryPage.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="channel-member-count"]')
        ?.getAttribute("data-roster-status") === "failed",
    undefined,
    { timeout: 6_000 }
  );
  await retryTrigger.click();
  const failure = retryPage.getByTestId("channel-member-failed");
  await failure.waitFor();
  await failure.getByRole("button", { name: "다시 시도" }).click();
  await retryPage.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="channel-member-panel"]')
        ?.getAttribute("data-roster-status") === "ready",
    undefined,
    { timeout: 6_000 }
  );
  if (retryTraffic.rosterAttempts !== 3) {
    throw new Error(
      `the inline retry must make the third roster request, saw ${retryTraffic.rosterAttempts}`
    );
  }
  if ((await retryPage.getByTestId("channel-member-item").count()) !== 3) {
    throw new Error("the inline retry did not recover the member rows");
  }
  await retryContext.close();
}

/**
 * 일반 멤버에게는 「나가기」가 서지 않는다. 서버 `remove_member`가 오너/관리자만
 * 허용하므로, 확인 뒤 403으로 끝나는 막다른 길을 애초에 내놓지 않는다.
 */
async function exerciseMemberHidesLeave(browser) {
  const traffic = makeTraffic();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, traffic, { selfRole: "member" });
  await login(page);
  await openMenu(page);

  // 알림 항목은 누구에게나 선다(자기 자신의 설정이다).
  if ((await page.getByTestId("channel-mute-toggle").count()) !== 1) {
    throw new Error("every member can mute a channel — the item must be present");
  }
  // 나가기는 서지 않는다.
  if ((await page.getByTestId("channel-leave").count()) !== 0) {
    throw new Error(
      "a plain member was offered 채널 나가기 — the server rejects self-removal for non-admins, so the item must not appear"
    );
  }

  await context.close();
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "HEADER_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      await exercise(browser);
      await exerciseRosterStates(browser);
      await exerciseMemberHidesLeave(browser);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: 헤더는 1줄이고 토픽은 ⋮ 메뉴에서 전체 열람되며,");
  console.log("           우측 그룹은 멤버수·허들·⋮ 순이고 좁은 폭 멤버 목록을 열었다.");
  console.log("           명부 loading/ready/failed+재시도 및 멤버 추가 경로를 닫았다.");
  console.log("           ⋮ 메뉴는 주제 보기·알림·나가기만 세웠으며(이름 수정 없음),");
  console.log("           알림은 서버 상태를 따르고 나가기는 확인·DELETE 뒤 이탈했다.");
}

main().catch((error) => {
  const message = String(error.message ?? error);
  console.error(message.startsWith("GATE FAIL:") ? message : `GATE FAIL: ${message}`);
  process.exit(1);
});
