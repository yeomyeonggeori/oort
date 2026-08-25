#!/usr/bin/env node
// GATE: MOMO-644 my-session continuity surface.
//
// TC-1 (#1758): 채널 스코프 세션은 도크, 전역 목록은 작업 콘솔에서 같은
// 강도로 잰다. WorkPanel 고유 단정(범위 칩·320px 피커·내 세션 행)은
// 작업 콘솔 경유(`open-work-panel` → `?work-panel=1`)로 연 뒤에 유지한다.
//
// No backend or credentials. The long DM label locks scope-chip shrink priority,
// and the session projection resolves before the host projection on purpose:
// every scope must wait for host truth instead of briefly painting an offline
// host's running ledger row as active. An empty host registry still keeps
// ledger-backed rows visible with the neutral unknown-host fallback.
//
// **좁은 판의 호스트 피커도 여기서 잰다** (MOMO-679 2R H2). 이 게이트가 여는
// 작업 세션 pane은 320px이고 그 안의 재개 블록 내용은 ~262px인데, 공용
// HostPicker의 두 번째 호출자가 바로 그 자리다. 1440 상세 한 줄에서만 피커를
// 보던 것이 2R H2의 원인이었으므로, 진짜 pane 측정 폭의 단정은 형제 게이트가
// 아니라 여기 있어야 한다: `<select>` 한 줄 + 채움 버튼 하나, 칠해진 컨트롤은
// 정확히 하나, 그룹 높이는 자격 호스트 수와 무관.
//
// 같은 화면에서 재개 토글의 위계도 잰다(2R M9): 닫히면 채움, 열리면 ghost +
// `호스트 선택 닫기`. 형제 표면과 컨트롤을 공유하면서 그 컨트롤이 존재하는
// 이유인 규칙만 한쪽에 두고 오면, `aria-expanded=true`인데 이름은 여전히 여는
// 이름이 된다.
//
// 붉히는 절차(제품 한 줄 되돌리기, `git checkout --` 로 복구):
//   좁은 pane 피커 — features/work/HostPicker 확정 버튼의 `max-w-full`을
//     `w-full`로 바꾼다. 실측된 실패: "확정 버튼이 전폭이 됐다 (261px / 폼
//     261px)". 쌓임 절반은 같은 파일의 `<Select>` 블록을 v1의
//     `targets.map(...)` 버튼 N개로 되돌리면 붉는다(고르는 컨트롤이 사라지므로
//     재개 왕복이 먼저 실패한다).
//   재개 토글 위계 — WorkPanel의 `variant={orphaned ? (resumeOpen ? "ghost" :
//     "default") : "outline"}`을 `variant="outline"` 고정으로 되돌린다.
//     실측된 실패: "닫힌 재개 토글이 채움 없이 서 있다 (rgba(0, 0, 0, 0))".
//
// Red proofs:
//   MY_SESSIONS_GATE_PROVE_RED_OFFLINE=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_FILTER=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_IDLE=1 npm run gate:my-sessions
//   MY_SESSIONS_GATE_PROVE_RED_TRANSITION=1 npm run gate:my-sessions

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import {
  openTerminalDock,
  openWorkPanelViaConsole,
} from "./work-openers.mjs";

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
const longNameHostId = "00000000-0000-7000-8000-000000000705";
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
  remoteDisplayAvailable = false,
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
    remoteDisplayAvailable,
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
    // 이 세션은 터미널과 화면을 **둘 다** 띄웠다. 호스트 오프라인 배너가
    // 가리는 것이 두 블록이므로, 배너의 명사가 둘을 덮는지 확인할 수 있는
    // 유일한 픽스처가 여기다 (LIVE-2 리뷰 M1).
    remoteDisplayAvailable: true,
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
  // 세 번째 자격 호스트이자 가장 긴 이름. 262px 판에서 v1의 버튼 N개 형태는
  // 이 이름을 전폭 채움으로 만들면서 **가장 긴 이름에 가장 큰 강조**를 줬다
  // (2R H2). 폭이 이름을 따라가지 않는다는 주장은 이름 길이가 제각각인
  // 목록에서만 증명되므로, 자격 호스트 중 하나는 반드시 길어야 한다.
  host(longNameHostId, "성재의 매우 긴 MacBook Pro 개발 호스트 이름 02", true),
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
    // 로그인 직후의 토큰 회전 (#1089). 이 분기가 없으면 맨 아래 포괄
    // `return json(route, {})` 가 200 을 주지만 **모양이 비어 있고**, 코어의
    // `refreshResponseFromWire`(packages/momo-core/src/lib/api.ts:632)는 두 필드가
    // 문자열이 아니면 throw 한다 → `markAuthExpired()` → 앱이 스스로 로그아웃한다.
    // 증상은 `loginPage` 가 헤더 터미널 토글(`open-terminal-dock`)을 30초 기다리다 죽는 것이었다(규명 2/4).
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
      });
    }
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

async function loginAndOpenPanel(context) {
  const page = await loginPage(context);
  await openWorkPanelViaConsole(page);
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
  const terminalToggle = page.getByTestId("open-terminal-dock");
  await Promise.race([
    loginSubmit.waitFor({ timeout: 30_000 }).catch(() => {}),
    terminalToggle.waitFor({ timeout: 30_000 }).catch(() => {}),
  ]);
  if ((await loginSubmit.count()) > 0) {
    await page.getByTestId("login-email").fill("gate@example.test");
    await page.getByTestId("login-password").fill("not-a-secret");
    await loginSubmit.click();
  }
  await terminalToggle.waitFor();
  return page;
}

/** 채널 스코프 세션은 이제 도크에 산다. 탭 수와 원장 id 를 같은 강도로 잰다. */
async function assertChannelDock(page, expectedIds) {
  await openTerminalDock(page);
  const tabs = page.getByTestId("terminal-dock-tab");
  await tabs.first().waitFor();
  const ids = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => String(node.getAttribute("data-session-id") ?? "").toLowerCase())
  );
  const missing = expectedIds.filter(
    (id) => !ids.includes(id.toLowerCase())
  );
  if (missing.length > 0 || ids.length !== expectedIds.length) {
    throw new Error(
      `channel dock lost ledger sessions: rendered ${JSON.stringify(ids)}, expected ${JSON.stringify(expectedIds)}`
    );
  }
  await page.getByTestId("terminal-dock-close").click();
  await page.getByTestId("terminal-dock").waitFor({ state: "detached" });
}

/** 전역 세션 목록은 작업 콘솔에 산다. */
async function assertWorkConsoleList(page, expectedCount) {
  await page.getByTestId("nav-work-console").click();
  await page.getByTestId("work-console-route").waitFor();
  const rows = page.getByTestId("work-console-row");
  await rows.first().waitFor();
  if ((await rows.count()) !== expectedCount) {
    throw new Error(
      `work console lost ledger sessions: rendered ${await rows.count()}, expected ${expectedCount}`
    );
  }
}

/**
 * 진짜 pane 측정 폭에서의 호스트 피커 (MOMO-679 2R H2).
 *
 * 320px 판 안, px-4 와 재개 블록의 px-3 을 빼고 남는 ~262px이 공용 HostPicker의
 * 두 번째 호출자가 실제로 사는 폭이다. 형제 게이트는 1280/600에서 같은 형태를
 * 재지만 이만큼 좁은 판이 그 표면에는 없다.
 *
 * 세 가지를 잰다. 셋 다 v1의 "자격 호스트마다 채움 버튼 하나" 형태가 이 폭에서
 * 무너진 자리다:
 *   - 그룹 높이가 자격 호스트 수와 무관하다(`<select>` 한 줄 + 버튼 한 줄).
 *     쌓이면 폭이 가장 큰 변별자가 되고 이름이 긴 호스트가 가장 큰 컨트롤을 갖는다.
 *   - 칠해진 컨트롤이 정확히 하나다. N개의 동급 채움은 아무것도 강조하지 않는다.
 *   - 확정 버튼이 전폭이 아니다(§8이 금지한 iOS 폼).
 */
async function assertNarrowPanePicker(page, row) {
  const shape = await row
    .getByTestId("work-session-resume-targets")
    .evaluate((group) => {
      const transparent = (value) =>
        value === null || value === "rgba(0, 0, 0, 0)" || value === "transparent";
      const picker = group.querySelector('[role="group"]');
      const select = group.querySelector(
        '[data-testid="work-session-resume-host-select"]'
      );
      const confirm = group.querySelector(
        '[data-testid="work-session-resume-confirm"]'
      );
      const labelId = picker?.getAttribute("aria-labelledby") ?? null;
      const label = labelId === null ? null : document.getElementById(labelId);
      const box = (node) =>
        node === null
          ? null
          : {
              width: Math.round(node.getBoundingClientRect().width),
              height: Math.round(node.getBoundingClientRect().height),
              right: Math.round(node.getBoundingClientRect().right),
            };
      return {
        blockWidth: Math.round(group.getBoundingClientRect().width),
        labelFor: label?.getAttribute("for") ?? null,
        selectId: select?.getAttribute("id") ?? null,
        selectRects: select === null ? 0 : select.getClientRects().length,
        options:
          select === null
            ? []
            : Array.from(select.options).map((option) => option.textContent ?? ""),
        filled:
          picker === null
            ? []
            : Array.from(picker.querySelectorAll("button, select"))
                .filter(
                  (node) => !transparent(getComputedStyle(node).backgroundColor)
                )
                .map((node) => node.getAttribute("data-testid")),
        pickerBox: box(picker),
        selectBox: box(select),
        confirmBox: box(confirm),
      };
    });

  // 이 단정이 실제로 좁은 pane을 재고 있는가.
  if (shape.blockWidth > 300) {
    throw new Error(
      `좁은 pane 피커: 재개 블록이 ${shape.blockWidth}px다. pane이 320px가 아니면 이 단정은 아무것도 재지 않는다`
    );
  }
  if (shape.options.length < 3) {
    throw new Error(
      `좁은 pane 피커: 자격 호스트가 ${shape.options.length}개다. 쌓이는지 아닌지는 셋 이상에서만 보인다`
    );
  }
  const longest = shape.options.reduce(
    (max, name) => Math.max(max, name.length),
    0
  );
  if (longest < 20) {
    throw new Error(
      `좁은 pane 피커: 가장 긴 호스트 이름이 ${longest}자다. 폭이 이름을 따라가지 않는다는 주장은 긴 이름에서만 증명된다`
    );
  }
  if (shape.labelFor === null || shape.labelFor !== shape.selectId) {
    throw new Error(
      `좁은 pane 피커: 라벨이 고르는 컨트롤에 묶이지 않았다 (for ${shape.labelFor}, select ${shape.selectId})`
    );
  }
  if (shape.selectRects !== 1) {
    throw new Error(
      `좁은 pane 피커: 고르는 컨트롤이 ${shape.selectRects}줄이다. 한 줄이어야 선택지 수와 높이가 무관하다`
    );
  }
  // label 16 + gap 4 + h-control 32 + gap 8 + h-control-sm 28 = 88 (실측 90).
  const HEIGHT_MAX = 100;
  if (shape.pickerBox === null || shape.pickerBox.height > HEIGHT_MAX) {
    throw new Error(
      `좁은 pane 피커: 자격 호스트 ${shape.options.length}개가 폼을 ${shape.pickerBox?.height}px로 키웠다 (상한 ${HEIGHT_MAX}). 호스트마다 제 줄을 가지면 이름이 긴 호스트가 가장 큰 컨트롤을 갖는다`
    );
  }
  if (
    shape.filled.length !== 1 ||
    shape.filled[0] !== "work-session-resume-confirm"
  ) {
    throw new Error(
      `좁은 pane 피커: 칠해진 컨트롤이 ${shape.filled.length}개다 (${JSON.stringify(shape.filled)}). 결정은 하나다`
    );
  }
  if (
    shape.confirmBox === null ||
    shape.confirmBox.width >= shape.pickerBox.width
  ) {
    throw new Error(
      `좁은 pane 피커: 확정 버튼이 전폭이 됐다 (${shape.confirmBox?.width}px / 폼 ${shape.pickerBox.width}px)`
    );
  }
  if (shape.confirmBox.right > shape.pickerBox.right) {
    throw new Error(
      `좁은 pane 피커: 확정 버튼이 폼 밖으로 나갔다 (${shape.confirmBox.right} > ${shape.pickerBox.right})`
    );
  }
  console.log(
    `narrow pane picker: 블록 ${shape.blockWidth}px, 폼 ${shape.pickerBox.width}x${shape.pickerBox.height}px, ` +
      `선택지 ${shape.options.length}개(최장 ${longest}자), select ${shape.selectBox?.width}px, 확정 버튼 ${shape.confirmBox.width}px`
  );
}

// =============================================================================
// hover 에서도 칩이 그릇을 잃지 않는가 (#1515 회전 2).
//
// 이 레포의 게이트들은 마우스를 **일부러** 치워 둔다(`gate-workstream.mjs:875` —
// 커서가 남아 있으면 hover 잔상이 150ms 전이와 겹쳐 측정을 흔든다). 옳은 조치였지만
// 값을 치렀다: 「그릇이 상호작용 상태에서 사라진다」는, 이 티켓이 다루는 바로 그
// 결함을 **사진 찍은 레인이 하나도 없었다.** 회전 2 의 1.000 두 건은 리뷰어가 손으로
// hover 프레임을 계측해 찾았고 그때 모든 게이트는 초록이었다.
//
// 그래서 이 자리에 rest/hover 짝을 세운다. 사진만 남기지 않고 **수를 잰다**: 칩의
// 계산된 바탕이 자기가 선 카드의 바탕과 같은 값이면 실패다. 사진은 사람이 볼 때만
// 보고, 수는 매번 본다.
//
// 컨텍스트가 `reducedMotion: "reduce"` 라 전이를 기다릴 필요가 없다 — hover 는 즉시
// 최종 값에 선다.
// =============================================================================
async function assertIdleChipVessel(page, idleCard, { shots, outDir }) {
  const chip = idleCard.getByTestId("work-session-idle-chip");
  const readPair = async () => ({
    card: await idleCard.evaluate((el) => getComputedStyle(el).backgroundColor),
    chip: await chip.evaluate((el) => getComputedStyle(el).backgroundColor),
  });

  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(0, 0); // rest: 커서를 카드 밖으로 확실히 치운다
    const rest = await readPair();
    if (shots) {
      await idleCard.screenshot({
        path: resolve(outDir, `idle-card-rest-${scheme}.png`),
      });
    }
    await idleCard.hover();
    const hover = await readPair();
    if (shots) {
      await idleCard.screenshot({
        path: resolve(outDir, `idle-card-hover-${scheme}.png`),
      });
    }
    for (const [phase, pair] of [
      ["rest", rest],
      ["hover", hover],
    ]) {
      if (pair.chip === pair.card) {
        throw new Error(
          `idle card chip lost its vessel at ${phase} (${scheme}): ` +
            `chip ${pair.chip} === card ${pair.card} — ` +
            "칩 그릇이 카드의 상호작용 바탕과 같은 값이 됐다 (#1515)."
        );
      }
    }
    console.log(
      `[idle-chip] ${scheme}: rest card ${rest.card} / chip ${rest.chip} · ` +
        `hover card ${hover.card} / chip ${hover.chip}`
    );
  }
  await page.emulateMedia({ colorScheme: null });
  await page.mouse.move(0, 0);
}

async function assertContinuity(context, state) {
  const page = await loginPage(context);

  const idleCard = page.getByTestId("work-session-idle-card");
  await idleCard.waitFor();
  await idleCard.getByText("현재 세션 보기", { exact: true }).waitFor();

  const shots = process.env.MY_SESSIONS_GATE_SHOTS === "1";
  const outDir = resolve(webRoot, "artifacts/my-sessions");
  if (shots) mkdirSync(outDir, { recursive: true });
  await assertIdleChipVessel(page, idleCard, { shots, outDir });
  if (shots) {
    console.log(
      "[shots] artifacts/my-sessions/idle-card-{rest,hover}-{light,dark}.png"
    );
  }

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
  // 호스트 지연 단정은 패널을 다시 연 직후에 잰다. 도크/콘솔을 먼저 들르면
  // 1200ms 지연이 이미 끝나 원 단정이 허공이 된다. 목적지는 작업 콘솔이
  // 내는 것과 같은 `?work-panel=1` 이다.
  await page.goto(`${origin}/#/c/${channelId}?work-panel=1`, {
    waitUntil: "domcontentloaded",
  });
  const panel = page.getByTestId("work-panel");
  await panel.waitFor();
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
  // R1 H2: 배너는 **화면에 없는 버튼**을 지시하지 않는다. 1R 은 「목록으로 돌아가
  // '세션 스레드'를 선택하면」이라고 적었는데, 이 배너가 서는 행은 대개 재개가
  // 성립하는 행이고 그런 행에는 그 버튼이 없다 — 돌아가 봐야 그 이름이 없다.
  const offlineBanner =
    (await page.getByTestId("work-host-offline").textContent())?.trim() ?? "";
  if (offlineBanner.includes("세션 스레드") || !offlineBanner.includes("아래")) {
    throw new Error(
      `오프라인 배너가 이 화면에 없는 동선을 지시한다 (${offlineBanner})`
    );
  }
  // LIVE-2 리뷰 M1: 이 배너는 터미널 관전과 라이브 화면 **두 블록을** 대체한다.
  // 화면을 띄운 세션(remoteDisplayAvailable)에서 명사가 터미널 하나뿐이면,
  // 라이브 화면 블록은 아무 설명 없이 사라진 것이 된다.
  if ((await page.getByTestId("work-display").count()) !== 0) {
    throw new Error("오프라인 배너 아래에 라이브 화면 블록이 그대로 남았다");
  }
  if (!offlineBanner.includes("라이브 화면")) {
    throw new Error(
      `화면을 띄운 세션인데 오프라인 배너가 터미널만 설명한다 (${offlineBanner})`
    );
  }
  // 그리고 목록 행이 잃은 채널 스레드 동선은 여기서 다시 난다(H2 부수). 상세는
  // 세션 원장이고 스레드는 채널 대화라 서로를 대신하지 않는다 — 동사가 선 행에서
  // 그 버튼을 뺀 대가를 이 줄이 치른다.
  if ((await page.getByTestId("work-detail-thread").count()) !== 1) {
    throw new Error(
      "채널 스레드로 가는 길이 어디에도 없다: 목록 행에서 뺀 동선을 상세가 받지 않았다 (R1 H2 부수)"
    );
  }
  await page.getByTestId("work-detail-back").click();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-testid") ===
      "my-work-session-detail"
  );

  // ADE 3단계 D3 (#1137): 두 동사는 **다른 버튼**이고, 판정은 행이 실어 나른다
  // (`data-verb`). 상세로 가는 길은 하나이며 그 하나의 이름이 도착해서 할 수 있는
  // 일을 따른다 — 재개가 성립하면 「이어서 보기」, 아니면 「세션 상세」. 1R 은 이
  // 자리에 두 버튼을 나란히 세워 같은 핸들러를 눌렀다(R1 M3): 같은 곳으로 가는 두
  // 이름은 두 곳이 있다고 말한다.
  const online = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${onlineSessionId}"]`);
  if (
    (await online.getByTestId("my-work-session-status").textContent())?.trim() !==
      "완료 · 대기 중" ||
    (await online.getAttribute("data-verb")) !== "resume" ||
    (await online.getByTestId("my-work-session-detail").textContent())?.trim() !==
      "이어서 보기"
  ) {
    throw new Error("idle row lost its neutral status or same-PTY action");
  }
  // 목적지가 하나면 버튼도 하나다. 「세션 상세」와 「이어서 보기」가 같은 행에서
  // 같은 핸들러를 함께 누르고 있으면 여기서 깨진다.
  if (
    (await online.getByTestId("my-work-session-detail").count()) !== 1 ||
    (await online.getByRole("button", { name: "세션 상세", exact: true }).count()) !== 0
  ) {
    throw new Error(
      "쌍둥이 버튼이 돌아왔다: 재개 행이 상세로 가는 길을 두 이름으로 세우고 있다 (R1 M3)"
    );
  }
  const orphaned = page.locator(`li[data-testid="my-work-session-row"][data-session-id="${orphanedSessionId}"]`);
  if (
    (await orphaned.getAttribute("data-verb")) !== "takeover" ||
    (await orphaned.getByTestId("my-work-session-takeover").textContent())?.trim() !==
      "인수" ||
    (await orphaned.getByTestId("my-work-session-detail").textContent())?.trim() !==
      "세션 상세"
  ) {
    throw new Error("orphaned row lost its distinct lineage-resume action");
  }
  // 두 낱말이 같은 화면에 함께 서고 **서로 다르다**. 한 act 에 두 이름이거나 두
  // act 에 한 이름이면 사람은 무엇이 무엇인지 배울 수 없다(D3).
  if (
    (await page.getByText("이어서 보기", { exact: true }).count()) === 0 ||
    (await page.getByText("인수", { exact: true }).count()) === 0
  ) {
    throw new Error("reattach and lineage-resume labels did not coexist");
  }
  // 고아 행에 재개가, 살아 있는 행에 인수가 서지 않는다.
  if (
    (await orphaned.getByText("이어서 보기", { exact: true }).count()) !== 0 ||
    (await online.getByTestId("my-work-session-takeover").count()) !== 0
  ) {
    throw new Error("a verb stood on the wrong row: 재개와 인수가 뒤바뀌었다");
  }
  // 하트비트가 끊긴 실행 중 세션도 **재개를 잃지 않는다**. 앞 판의
  // `canReattachWorkSession` 은 `online === true` 를 게이트로 썼는데, 그 칼럼은
  // 실측으로 못 믿는 값이고(momowebqa: 릴레이 중인 호스트가 online:false), 서버의
  // 같은 판정은 그것을 일부러 보지 않는다. 그래서 돌아갈 수 있는 세션에 돌아갈
  // 길이 없었다. 침묵은 게이트가 아니라 경고로 내려온다.
  if (
    (await offline.getAttribute("data-verb")) !== "resume" ||
    (await offline.getByTestId("my-work-session-detail").textContent())?.trim() !==
      "이어서 보기"
  ) {
    throw new Error(
      "a silent heartbeat removed the way back: 응답 없는 호스트의 실행 중 세션이 재개를 잃었다 (서버 판정은 online 을 보지 않는다)"
    );
  }
  if ((await offline.getByTestId("my-work-session-advisory").count()) !== 1) {
    throw new Error(
      "the silence was neither gated nor stated: 하트비트가 끊겼는데 경고 한 줄이 없다"
    );
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
  // 위계는 형제 표면과 같은 규칙이다 (2R M9). 닫힌 재개 토글은 이 행의 결정이라
  // 채움이고(같은 행의 `세션 상세`는 outline인 보조다), 열리면 결정이 확정
  // 버튼으로 옮겨가므로 ghost로 물러나면서 이름도 바뀐다. 컨트롤은 공유하면서
  // 그 컨트롤이 존재하는 이유인 규칙만 한쪽에 두고 오면, `aria-expanded=true`인데
  // 이름은 여전히 여는 이름이 된다.
  const resumeToggle = orphaned.getByTestId("my-work-session-takeover");
  const transparentFill = (value) =>
    value === "rgba(0, 0, 0, 0)" || value === "transparent";
  const closedFill = await resumeToggle.evaluate(
    (node) => getComputedStyle(node).backgroundColor
  );
  if (transparentFill(closedFill)) {
    throw new Error(
      `닫힌 재개 토글이 채움 없이 서 있다 (${closedFill}). 고아 행에서 되돌리기 가장 어려운 act가 가장 가벼우면 안 된다`
    );
  }
  await resumeToggle.click();
  const targets = orphaned.getByTestId("work-session-resume-targets");
  await targets.waitFor();
  // 부분 복원 고지는 이제 산문 두 줄이 아니라 **두 목록**이다(#1137). 앞 판의
  // "Git 계보만 새 호스트로 이어집니다"는 틀렸다 — 실제로 이어지는 것은
  // 스레드이고(서버가 원본의 root_message_id 를 그대로 쓴다), git 계보는 이
  // 원장이 아예 모르는 것이다.
  await targets.getByTestId("takeover-restored").waitFor();
  await targets
    .getByText("커밋하지 않은 변경", { exact: false })
    .waitFor();
  await page.mouse.move(0, 0);
  await page.waitForFunction(
    () =>
      document.getAnimations().every((animation) => animation.playState !== "running"),
    undefined,
    { timeout: 5_000 }
  );
  if ((await resumeToggle.textContent())?.trim() !== "호스트 선택 닫기") {
    throw new Error(
      `열린 재개 토글의 이름이 아직 여는 이름이다 (${await resumeToggle.textContent()})`
    );
  }
  const openFill = await resumeToggle.evaluate(
    (node) => getComputedStyle(node).backgroundColor
  );
  if (!transparentFill(openFill)) {
    throw new Error(
      `열린 재개 토글이 아직 칠해져 있다 (${openFill}). 결정이 확정 버튼으로 옮겨갔으면 토글은 물러나야 한다`
    );
  }
  await assertNarrowPanePicker(page, orphaned);
  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .toLowerCase()
        .endsWith(`/work-sessions/${orphanedSessionId}/resume`)
  );
  await targets
    .getByTestId("work-session-resume-host-select")
    .selectOption(onlineHostId);
  await targets.getByTestId("work-session-resume-confirm").click();
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

  await page.getByTestId("work-panel-close").click();
  await assertChannelDock(page, [
    offlineSessionId,
    onlineSessionId,
    orphanedSessionId,
    otherSessionId,
  ]);
  await assertWorkConsoleList(page, 4);
  await page.close();
}

async function assertTransitionBeforeList(context, state) {
  state.mode = "continuity";
  state.sessionStatuses[onlineSessionId] = "running";
  state.nextSessionDelayMs = 1_200;
  const page = await loginPage(context);
  await openWorkPanelViaConsole(page);
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
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "MY_SESSIONS_GATE_PORT",
  });
  try {
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
    await server.stop();
  }
  console.log(
    "PASS my sessions: idle card, reattach/resume copy split, transition timing, shared host wait, owner filter, terminal states, and a host picker that holds one select plus one filled button at the 262px pane measure"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
