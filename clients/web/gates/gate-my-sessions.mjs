#!/usr/bin/env node
// GATE: MOMO-644 my-session continuity surface.
//
// No backend or credentials. The long DM label locks scope-chip shrink priority,
// and the session projection resolves before the host projection on purpose:
// every scope must wait for host truth instead of briefly painting an offline
// host's running ledger row as active. An empty host registry still keeps
// ledger-backed rows visible with the neutral unknown-host fallback.
//
// Red proofs:
//   MY_SESSIONS_GATE_PROVE_RED_OFFLINE=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_FILTER=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_IDLE=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_TRANSITION=1 npm run gate:my-sessions

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MY_SESSIONS_GATE_PORT || 5184);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const channelId = "00000000-0000-7000-8000-000000000201";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherMemberId = "00000000-0000-7000-8000-000000000102";
const offlineSessionId = "00000000-0000-7000-8000-000000000644";
const onlineSessionId = "00000000-0000-7000-8000-000000000645";
const otherSessionId = "00000000-0000-7000-8000-000000000646";
const orphanedSessionId = "00000000-0000-7000-8000-000000000647";
const resumedSessionId = "00000000-0000-7000-8000-000000000648";
const offlineHostId = "00000000-0000-7000-8000-000000000701";
const onlineHostId = "00000000-0000-7000-8000-000000000702";
const otherHostId = "00000000-0000-7000-8000-000000000703";
const orphanedHostId = "00000000-0000-7000-8000-000000000704";
const offlineRootId = "00000000-0000-7000-8000-000000000801";
const onlineRootId = "00000000-0000-7000-8000-000000000802";
const otherRootId = "00000000-0000-7000-8000-000000000803";
const orphanedRootId = "00000000-0000-7000-8000-000000000804";
const proveRedOffline = process.env.MY_SESSIONS_GATE_PROVE_RED_OFFLINE === "1";
const proveRedFilter = process.env.MY_SESSIONS_GATE_PROVE_RED_FILTER === "1";
const proveRedIdle = process.env.MY_SESSIONS_GATE_PROVE_RED_IDLE === "1";
const proveRedTransition =
  process.env.MY_SESSIONS_GATE_PROVE_RED_TRANSITION === "1";

const auth = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://my-sessions-gate.invalid/connection/websocket",
};

const channel = {
  id: channelId,
  workspaceId,
  kind: "dm",
  dmKey: `${memberId}:${otherMemberId}`,
  memberIds: [memberId, otherMemberId],
  muted: false,
};

const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: otherMemberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "Nadia Rahman · 제품 웹 품질과 세션 연속성 검증 담당",
    handle: "nadia",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

function workSession({
  id,
  owner,
  hostId,
  rootMessageId,
  label,
  status = "running",
  exitCode,
}) {
  return {
    id,
    workspaceId,
    channelId,
    memberId: owner,
    hostId,
    rootMessageId,
    tool: "codex",
    label,
    status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    startedAtMs: 1_785_163_200_000,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

const sessions = [
  workSession({
    id: offlineSessionId,
    owner: memberId,
    hostId: offlineHostId,
    rootMessageId: offlineRootId,
    label: "세션 연속성 표면 구현",
  }),
  workSession({
    id: onlineSessionId,
    owner: memberId,
    hostId: onlineHostId,
    rootMessageId: onlineRootId,
    label: "게이트 검증 정리",
    status: proveRedIdle ? "future" : "idle",
    exitCode: 0,
  }),
  workSession({
    id: orphanedSessionId,
    owner: memberId,
    hostId: orphanedHostId,
    rootMessageId: orphanedRootId,
    label: "새 호스트 계보 복구",
    status: "orphaned",
  }),
  workSession({
    id: otherSessionId,
    owner: proveRedFilter ? memberId : otherMemberId,
    hostId: otherHostId,
    rootMessageId: otherRootId,
    label: "다른 멤버의 비공개 세션",
  }),
];

function host(id, displayName, online) {
  return {
    id,
    workspaceId,
    scope: "member",
    ownerMemberId: memberId,
    type: "app",
    displayName,
    capabilities: { terminal: true },
    createdAtMs: 1_785_163_000_000,
    online,
  };
}

const hosts = [
  host(
    offlineHostId,
    "성재의 매우 긴 MacBook Pro 개발 호스트 이름",
    proveRedOffline
  ),
  host(onlineHostId, "개발실 Mac mini", true),
  host(otherHostId, "Nadia MacBook Air", true),
  host(orphanedHostId, "응답이 끊긴 원격 Mac", false),
];

function rootMessage(id, authorMemberId, body, seq) {
  return {
    id,
    channelId,
    seq,
    hlcTs: 1_785_163_200_000 + seq,
    hlcCount: 0,
    authorMemberId,
    type: "system",
    body,
    createdAtMs: 1_785_163_200_000 + seq,
  };
}

const rootMessages = [
  rootMessage(offlineRootId, memberId, "세션 연속성 표면 구현", 11),
  rootMessage(onlineRootId, memberId, "게이트 검증 정리", 12),
  rootMessage(otherRootId, otherMemberId, "다른 멤버의 비공개 세션", 13),
  rootMessage(orphanedRootId, memberId, "새 호스트 계보 복구", 14),
  {
    ...rootMessage(
      "00000000-0000-7000-8000-000000000901",
      memberId,
      "작업 완료",
      15
    ),
    rootId: onlineRootId,
    props: {
      kind: "work_session_idle",
      session_id: onlineSessionId.toUpperCase(),
      owner_member_id: memberId.toUpperCase(),
    },
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
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
        const replies = String(data)
          .trim()
          .split("\n")
          .map((line) => {
            const command = JSON.parse(line);
            if (command.connect) {
              return {
                id: command.id,
                connect: { client: "my-sessions-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              this.subscriptions.add(command.subscribe.channel);
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "my-sessions-gate",
                  offset,
                },
              };
            }
            if (command.unsubscribe) {
              this.subscriptions.delete(command.unsubscribe.channel);
              return { id: command.id, unsubscribe: {} };
            }
            return { id: command.id };
          });
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
    window.__workSessionGatePublish = (frame) => {
      offset += 1;
      for (const socket of sockets) {
        for (const channelName of socket.subscriptions) {
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                push: {
                  channel: channelName,
                  pub: { data: frame, offset },
                },
              }),
            })
          );
        }
      }
    };
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
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
    if (path.endsWith("/channels")) return json(route, { channels: [channel] });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) {
      return json(route, { read_states: [] });
    }
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) {
      if (state.mode === "error") {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      const snapshot =
        state.mode === "sessions-empty"
          ? []
          : sessions.map((session) => ({
              ...session,
              status: state.sessionStatuses[session.id] ?? session.status,
            }));
      const delay = state.nextSessionDelayMs;
      state.nextSessionDelayMs = 0;
      if (delay > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
      return json(route, { workSessions: snapshot });
    }
    if (
      route.request().method() === "POST" &&
      path.toLowerCase().endsWith(
        `/work-sessions/${orphanedSessionId}/resume`
      )
    ) {
      const body = route.request().postDataJSON();
      state.resumeTargetId = body.targetHostId;
      return json(
        route,
        {
          workSession: workSession({
            id: resumedSessionId,
            owner: memberId,
            hostId: body.targetHostId,
            rootMessageId: orphanedRootId,
            label: "새 호스트 계보 복구",
            status: "running",
          }),
        },
        201
      );
    }
    if (path.endsWith("/work-hosts")) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, state.hostDelayMs)
      );
      return json(route, {
        workHosts: state.mode === "hosts-empty" ? [] : hosts,
      });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      return json(route, { messages: [] });
    }
    if (path.endsWith("/messages")) {
      return json(route, { messages: rootMessages });
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
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("preview server never came up");
}

async function loginAndOpenPanel(context) {
  const page = await loginPage(context);
  await page.getByTestId("open-work-panel").click();
  return page;
}

async function loginPage(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  // domcontentloaded fires before React commits, so a count() probe taken here
  // races the first render: it can read 0 for a login form that is about to
  // appear, skip sign-in, and then wait forever for the shell. Wait until ONE
  // of the two possible surfaces actually exists before deciding which one.
  const loginSubmit = page.getByTestId("login-submit");
  const workPanelToggle = page.getByTestId("open-work-panel");
  await Promise.race([
    loginSubmit.waitFor({ timeout: 30_000 }).catch(() => {}),
    workPanelToggle.waitFor({ timeout: 30_000 }).catch(() => {}),
  ]);
  if ((await loginSubmit.count()) > 0) {
    await page.getByTestId("login-email").fill("gate@example.test");
    await page.getByTestId("login-password").fill("not-a-secret");
    await loginSubmit.click();
  }
  await workPanelToggle.waitFor();
  return page;
}

async function assertContinuity(context, state) {
  const page = await loginPage(context);

  const idleCard = page.getByTestId("work-session-idle-card");
  await idleCard.waitFor();
  await idleCard.getByText("현재 세션 보기", { exact: true }).waitFor();
  if (
    (await idleCard.getAttribute("data-session-id"))?.toLowerCase() !==
    onlineSessionId
  ) {
    throw new Error("idle channel card did not preserve uppercase UUID identity");
  }
  await idleCard.click();
  await page.getByTestId("work-detail").waitFor();
  if (
    (await page.getByTestId("work-detail-status").textContent())?.trim() !==
    "완료 · 대기 중"
  ) {
    throw new Error("idle channel card did not open the matching session");
  }
  await page.getByTestId("work-panel-close").click();
  await page.getByTestId("open-work-panel").click();

  const panel = page.getByTestId("work-panel");
  await panel
    .getByTestId("work-panel-summary")
    .filter({ hasText: "세션 4개" })
    .waitFor();

  for (const [testId, expected] of [
    ["work-scope-all", "전체"],
    ["work-scope-mine", "내 세션"],
  ]) {
    const chip = panel.getByTestId(testId);
    if ((await chip.textContent())?.trim() !== expected) {
      throw new Error(`${testId} lost its complete fixed label`);
    }
    const clipped = await chip.evaluate(
      (element) => element.scrollWidth > element.clientWidth
    );
    if (clipped) throw new Error(`${testId} was clipped by the long DM label`);
  }
  const channelChip = panel.getByTestId("work-scope-channel");
  if (
    !(await channelChip.evaluate(
      (element) => element.scrollWidth > element.clientWidth
    ))
  ) {
    throw new Error("long DM label did not yield space before fixed scope labels");
  }

  if ((await page.getByTestId("work-session-row").count()) !== 0) {
    throw new Error(
      "channel rows rendered before the delayed host projection resolved"
    );
  }
  if ((await panel.getByText("실행 중", { exact: true }).count()) !== 0) {
    throw new Error("channel scope claimed running before host truth arrived");
  }

  await page.getByTestId("work-scope-mine").click();
  if ((await page.getByTestId("my-work-session-row").count()) !== 0) {
    throw new Error("mine rows rendered before the delayed host projection resolved");
  }
  await page
    .locator(`[data-session-id="${offlineSessionId}"]`)
    .waitFor({ timeout: 10_000 });

  const rows = page.getByTestId("my-work-session-row");
  if ((await rows.count()) !== 3) {
    throw new Error(`mine filter rendered ${await rows.count()} rows, expected 3`);
  }
  if (
    (await page.locator(`li[data-testid="my-work-session-row"][data-session-id="${otherSessionId}"]`).count()) !== 0
  ) {
    throw new Error("mine filter exposed another member's session");
  }

  const offline = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${offlineSessionId}"]`);
  if ((await offline.getAttribute("data-status")) !== "unavailable") {
    throw new Error(
      `offline running session rendered as ${await offline.getAttribute("data-status")}`
    );
  }
  if (
    (await offline.getByTestId("my-work-session-status").textContent())?.trim() !==
    "호스트 응답 없음"
  ) {
    throw new Error("offline running session lost the host-unavailable copy");
  }
  await offline.getByTestId("my-work-session-detail").click();
  await page.getByTestId("work-detail").waitFor();
  await page.getByTestId("work-host-offline").waitFor();
  if ((await page.getByTestId("work-observer-terminal").count()) !== 0) {
    throw new Error("offline detail still offers terminal observation");
  }
  await page.getByTestId("work-detail-back").click();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-testid") ===
      "my-work-session-detail"
  );

  const online = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${onlineSessionId}"]`);
  if (
    (await online.getByTestId("my-work-session-status").textContent())?.trim() !==
      "완료 · 대기 중" ||
    (await online.getByTestId("my-work-session-detail").textContent())?.trim() !==
      "이어서 보기"
  ) {
    throw new Error("idle row lost its neutral status or same-PTY action");
  }
  const orphaned = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${orphanedSessionId}"]`);
  if (
    (await orphaned.getByTestId("my-work-session-thread").textContent())?.trim() !==
    "새 호스트에서 재개"
  ) {
    throw new Error("orphaned row lost its distinct lineage-resume action");
  }
  if (
    (await page.getByText("이어서 보기", { exact: true }).count()) === 0 ||
    (await page.getByText("새 호스트에서 재개", { exact: true }).count()) === 0
  ) {
    throw new Error("reattach and lineage-resume labels did not coexist");
  }
  await online.getByTestId("my-work-session-detail").click();
  await page.getByTestId("work-detail").waitFor();
  // The meta block ships collapsed (<details>), so the exit-code row exists
  // but is not VISIBLE until the summary is opened — a blind-authored wait
  // here timed out against perfectly correct UI. Open it like a person would.
  await page.getByTestId("work-detail-meta").locator("summary").click();
  await page.getByText("마지막 실행 결과", { exact: true }).waitFor();
  await page.getByTestId("work-observer-start").waitFor();
  await page.getByTestId("work-detail-back").click();
  await orphaned.getByTestId("my-work-session-thread").click();
  const targets = orphaned.getByTestId("work-session-resume-targets");
  await targets.waitFor();
  await targets
    .getByText("미커밋 변경은 옮겨지지 않습니다.", { exact: false })
    .waitFor();
  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .toLowerCase()
        .endsWith(`/work-sessions/${orphanedSessionId}/resume`)
  );
  await targets.locator(`[data-host-id="${onlineHostId}"]`).click();
  await resumeResponse;
  if (state.resumeTargetId !== onlineHostId) {
    throw new Error("orphaned lineage resume did not POST the chosen host");
  }

  await online.waitFor();
  state.sessionStatuses[onlineSessionId] = "running";
  await page.evaluate(
    ({ session, channel, root, member, host }) => {
      window.__workSessionGatePublish({
        type: "work.session.resumed-to-running",
        v: 1,
        ts: Date.now(),
        seq: 15,
        payload: {
          session_id: session.toUpperCase(),
          channel_id: channel.toUpperCase(),
          root_message_id: root.toUpperCase(),
          member_id: member.toUpperCase(),
          host_id: host.toUpperCase(),
          status: "running",
          exit_code: 0,
          resumed_at: Date.now(),
        },
      });
    },
    {
      session: onlineSessionId,
      channel: channelId,
      root: onlineRootId,
      member: memberId,
      host: onlineHostId,
    }
  );
  await online
    .getByTestId("my-work-session-status")
    .filter({ hasText: "실행 중" })
    .waitFor();
  await page.close();
}

async function assertTransitionBeforeList(context, state) {
  state.mode = "continuity";
  state.sessionStatuses[onlineSessionId] = "running";
  state.nextSessionDelayMs = 1_200;
  const page = await loginPage(context);
  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor();
  await page.waitForTimeout(100);

  state.sessionStatuses[onlineSessionId] = "idle";
  await page.evaluate(
    ({ session, channel, root, member, host, suppressTransition }) => {
      if (suppressTransition) return;
      window.__workSessionGatePublish({
        type: "work.session.idle",
        v: 1,
        ts: Date.now(),
        seq: 16,
        payload: {
          session_id: session.toUpperCase(),
          channel_id: channel.toUpperCase(),
          root_message_id: root.toUpperCase(),
          member_id: member.toUpperCase(),
          host_id: host.toUpperCase(),
          status: "idle",
          exit_code: 0,
          idle_at: Date.now(),
        },
      });
    },
    {
      session: onlineSessionId,
      channel: channelId,
      root: onlineRootId,
      member: memberId,
      host: onlineHostId,
      suppressTransition: proveRedTransition,
    }
  );
  await page.getByTestId("work-scope-mine").click();
  const idle = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${onlineSessionId}"]`);
  await idle.waitFor({ timeout: 10_000 });
  if ((await idle.getAttribute("data-status")) !== "idle") {
    throw new Error("idle frame before the first list response was overwritten");
  }
  await page.close();
}

async function assertTerminalState(context, state, testId) {
  state.mode = testId;
  state.hostDelayMs = 0;
  const page = await loginAndOpenPanel(context);
  await page.getByTestId("work-scope-mine").click();
  if (testId === "hosts-empty") {
    const rows = page.getByTestId("my-work-session-row");
    await rows.first().waitFor({ timeout: 10_000 });
    // 3 = this fixture's owner-ledger sessions (offline/idle/orphaned). The
    // stale "2" predated the idle/orphaned fixtures this branch added.
    if ((await rows.count()) !== 3) {
      throw new Error(
        `empty host registry hid ledger sessions: rendered ${await rows.count()}, expected 3`
      );
    }
    if ((await page.getByTestId("work-panel-hosts-empty").count()) !== 0) {
      throw new Error("host-empty invitation replaced existing session rows");
    }
    const first = rows.first();
    if (
      (await first.getByTestId("my-work-session-host").textContent())?.trim() !==
        "알 수 없는 호스트" ||
      (await first
        .getByTestId("my-work-session-host-state")
        .textContent())?.trim() !== "상태 확인 필요"
    ) {
      throw new Error("host-empty session lost its neutral unknown-host fallback");
    }
    await page.close();
    return;
  }
  const expected =
    testId === "sessions-empty"
      ? "work-panel-empty"
      : "work-panel-error";
  await page.getByTestId(expected).waitFor({ timeout: 10_000 });
  await page.close();
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
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const state = {
        mode: "continuity",
        hostDelayMs: 1_200,
        nextSessionDelayMs: 0,
        sessionStatuses: {},
        resumeTargetId: null,
      };
      await installRoutes(context, state);
      await assertContinuity(context, state);
      await assertTransitionBeforeList(context, state);
      await assertTerminalState(context, state, "hosts-empty");
      await assertTerminalState(context, state, "sessions-empty");
      await assertTerminalState(context, state, "error");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "PASS my sessions: idle card, reattach/resume copy split, transition timing, shared host wait, owner filter, and terminal states"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
