#!/usr/bin/env node
// GATE: 채널 헤더 (검수 피드백 #3).
//
// 이 게이트가 지키는 것은 헤더가 그려지는지가 아니라 **헤더가 하는 말과 각 액션이
// 서버 진실을 따르는가**다.
//
//   1. 인원수는 숫자다   헤더의 멤버 표시는 이름 나열이 아니라 사람 아이콘과
//                        인원수다. 수는 명부에서 이 채널의 멤버를 세어 얻는다.
//   2. 이름이 메뉴다     채널 이름을 누르면 채널을 다루는 메뉴가 선다. 항목은
//                        알림 끄기/켜기와 채널 나가기 둘뿐이다 — 「이름 수정」은
//                        서버 라우트가 없어(2026-08-10 실측) 그리지 않는다.
//   3. 낱말은 상태다     알림을 끄면 다음에 여는 메뉴의 낱말이 「켜기」로 뒤집힌다.
//                        그 뒤집힘은 낙관적 추측이 아니라 서버가 저장한 muted를
//                        다시 읽은 결과다.
//   4. 나가기는 파괴다    「채널 나가기」는 확인 다이얼로그를 거쳐 DELETE를 보내고,
//                        성공하면 그 채널을 떠난다. 낙관적으로 지운 목록은 실패
//                        하면 되돌아온다.
//   5. 권한 없는 문은 안 연다  서버 `remove_member`는 오너/관리자만 멤버십을 지울
//                        수 있으므로, 일반 멤버의 메뉴에는 「나가기」가 아예 서지
//                        않는다(확인 뒤 403으로 끝나는 막다른 길을 만들지 않는다).
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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
  if (!mute || !unmute || !leave) {
    throw new Error(
      "채널 헤더 메뉴의 낱말을 코어에서 찾지 못했다: 게이트가 검사할 문자열의 정본이 사라졌다"
    );
  }
  return { mute: mute[1], unmute: unmute[1], leave: leave[1] };
}

const { mute: MUTE_LABEL, unmute: UNMUTE_LABEL, leave: LEAVE_LABEL } =
  canonicalCopy(webRoot);

const proveRedCount = process.env.HEADER_GATE_PROVE_RED_COUNT === "1";
const proveRedRename = process.env.HEADER_GATE_PROVE_RED_RENAME === "1";
const proveRedMute = process.env.HEADER_GATE_PROVE_RED_MUTE === "1";
const proveRedLeave = process.env.HEADER_GATE_PROVE_RED_LEAVE === "1";

const port = Number(process.env.HEADER_GATE_PORT || 5198);
const origin = `http://127.0.0.1:${port}`;

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ownerId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";

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
  ];
}

function channelRow(muted) {
  return { id: channelId, workspaceId, kind: "public", name: "release-2026-08", muted };
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

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
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
  return { mutePuts: [], memberDeletes: [] };
}

/**
 * @param options.selfRole  로그인 멤버의 역할("owner" | "member").
 */
async function installRoutes(context, traffic, options = {}) {
  const selfRole = options.selfRole ?? "owner";
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

    if (path.endsWith("/roster") || path.endsWith("/members")) {
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
  throw new Error("channel-header gate preview server never came up");
}

async function login(page) {
  await page.goto(origin, { waitUntil: "networkidle" });
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

  // ---- 1. 인원수는 숫자다 ----------------------------------------------------
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
  const countText = ((await countNode.textContent()) ?? "").trim();
  if (countText !== "2") {
    throw new Error(
      `the member count must be the roster's count of this channel (2), read "${countText}"`
    );
  }
  const countLabel =
    (await countNode.locator("[aria-label]").getAttribute("aria-label")) ?? "";
  if (!countLabel.includes("2")) {
    throw new Error(
      `the count needs an accessible name carrying the number, read "${countLabel}"`
    );
  }

  // ---- 2. 이름이 메뉴다, 그리고 「이름 수정」은 없다 ---------------------------
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

  // ---- 3. 낱말은 상태다: 알림을 끄면 다음에 여는 낱말이 뒤집힌다 --------------
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

  // ---- 4. 나가기는 파괴다: 확인 → DELETE → 채널을 떠난다 ----------------------
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
      await exerciseMemberHidesLeave(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log("GATE PASS: 헤더는 인원수를 숫자로 말했고, 채널 이름 메뉴는 알림·나가기");
  console.log("           둘만 세웠으며(이름 수정 없음), 알림 낱말은 저장된 muted를");
  console.log("           따라 뒤집혔고, 나가기는 확인·DELETE·이탈로 이어졌으며,");
  console.log("           일반 멤버에게는 나가기가 서지 않았다.");
}

main().catch((error) => {
  console.error(`GATE FAIL: ${error.message}`);
  process.exit(1);
});
