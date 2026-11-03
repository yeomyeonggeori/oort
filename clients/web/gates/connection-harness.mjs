// 연결 상태 화면 레인의 공용 도구 (#5220, #5201 S-B).
//
// 실제 번들(dist)을 가짜 `/v1`과 가짜 실시간 서버(센트리퓨고 JSON 프로토콜의 최소판) 위에 띄운다. 둘 다
// 이 레인이 쥔 손잡이로 바뀐다:
//
//   backend.rest("ok" | "abort" | "503")   REST를 정상으로, 응답 없이 끊김으로, 코드 없는 503으로
//   backend.socket("ok" | "refuse")        새 실시간 연결을 받아 줄지(refuse: 열자마자 닫는다)
//   backend.dropSockets()                  붙어 있는 실시간 연결을 서버 쪽에서 끊는다(다시 붙는 건 socket 모드가 정한다)
//
// 게이트(`gate-connection.mjs`)가 단정하고 캡처(`scripts/capture-5220.mjs`)가 같은 장면을 찍는다. 자격 증명은
// 없다: `/v1`은 아래 픽스처로만 답한다.

import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

export const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
export const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const PEER = "019F94E3-7B0F-7A22-9C13-4D5E6F708192";
const AGENT = "019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90";

export const CHANNELS = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "public", name: "디자인", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "릴리스", muted: false },
];
export const GENERAL_ID = CHANNELS[0].id;

function member(id, kind, displayName, handle, extra = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    kind,
    status: "active",
    displayName,
    handle,
    channelCount: 2,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 1_750_000_000_000,
    updatedAtMs: 1_750_000_000_000,
    ...extra,
  };
}

const ROSTER = [
  member(ME, "human", "곽성재", "seongjae", { role: "owner" }),
  member(PEER, "human", "김인턴", "intern-kim", { role: "member" }),
  member(AGENT, "agent", "코메토", "kometto", { ownerHumanId: ME, agentModel: "claude-opus-5" }),
];

const NOW = Date.now();

function message(seq, author, body, extra = {}) {
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: GENERAL_ID,
    seq,
    hlcTs: NOW - (10 - seq) * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: NOW - (10 - seq) * 60_000,
    ...extra,
  };
}

/** 에이전트를 이 대화에 들이는 승인 카드. 결정하는 사람은 나(ME)다. */
function consentCard(seq) {
  const approvalId = `0199aa11-3333-7000-8000-${String(seq).padStart(12, "0")}`;
  return message(seq, PEER, "코메토 들이기 허락을 기다려요", {
    type: "approval_request",
    props: {
      approval_id: approvalId,
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      channel_id: GENERAL_ID,
      action_type: "workspace_action",
      status: "pending",
      title: "에이전트를 이 대화에 들이기",
      expires_at_ms: NOW + 3_600_000,
      target_member_id: ME,
      action: {
        id: "dm.agent.admit",
        required_role: "dm_participant",
        target_member_id: ME,
        rows: [{ label: "에이전트", value: "코메토 (@kometto)" }],
      },
    },
  });
}

export const TIMELINE = [
  message(7, PEER, "오늘 배포 끝났어요."),
  message(8, ME, "확인했어요, 고마워요."),
  consentCard(9),
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * 가짜 서버 한 벌을 컨텍스트에 건다. `port`는 실시간 주소를 짓는 데만 쓴다(그 주소는 아무도 듣지 않고,
 * 컨텍스트가 `routeWebSocket`으로 가로챈다).
 */
export async function installBackend(context, port) {
  const session = {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
  };
  const state = {
    restMode: "ok",
    socketMode: "ok",
    sends: [],
    /** 연 적이 있는 실시간 연결의 수(다시 연결 시도가 실제로 나갔는지 센다). */
    handshakes: 0,
    sockets: new Set(),
  };

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // 아래 정상 응답은 `state.restMode === "ok"`일 때만이다. 끊김 모드는 모든 `/v1`에 걸린다.
    if (state.restMode === "abort") return route.abort("connectionrefused");
    if (state.restMode === "503") {
      return json(route, { error: { message: "service unavailable" } }, 503);
    }
    const path = url.pathname;
    if (path.endsWith("/auth/login")) return json(route, session);
    if (path.endsWith("/auth/refresh")) {
      return json(route, { accessToken: session.accessToken, refreshToken: session.refreshToken });
    }
    if (path.endsWith("/auth/realtime-token")) {
      return json(route, {
        token: "gate-only-not-a-credential",
        tokenType: "jwt",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId: WORKSPACE_ID,
        memberId: ME,
      });
    }
    if (/\/workspaces\/[^/]+\/channels$/.test(path)) return json(route, { channels: CHANNELS });
    if (/\/workspaces\/[^/]+\/roster$/.test(path)) return json(route, { members: ROSTER });
    if (/\/channels\/[^/]+\/messages$/.test(path)) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const seq = 2_000 + state.sends.length;
        state.sends.push(body);
        return json(route, message(seq, ME, String(body.body ?? ""), { clientMsgId: body.clientMsgId }));
      }
      return json(route, { messages: TIMELINE });
    }
    return json(route, { channels: [], members: [], read_states: [], messages: [] });
  });

  // 센트리퓨고 JSON 프로토콜의 최소판: connect·subscribe·그 밖의 명령에 답한다. 서버가 먼저 보내는 것은 없다.
  await context.routeWebSocket(/\/connection\/websocket/, (ws) => {
    if (state.socketMode === "refuse") {
      ws.close({ code: 4000, reason: "gate-refuse" });
      return;
    }
    state.sockets.add(ws);
    ws.onClose(() => state.sockets.delete(ws));
    ws.onMessage((raw) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        if (command.connect) {
          state.handshakes += 1;
          ws.send(JSON.stringify({ id: command.id, connect: { client: "gate-client", version: "6.0.0" } }));
        } else if (command.subscribe) {
          ws.send(
            JSON.stringify({
              id: command.id,
              subscribe: { recoverable: true, positioned: true, epoch: "gate", offset: 0, recovered: false, publications: [] },
            })
          );
        } else if (command.id !== undefined) {
          const key = Object.keys(command).find((name) => name !== "id") ?? "ping";
          ws.send(JSON.stringify({ id: command.id, [key]: {} }));
        }
      }
    });
  });

  return {
    state,
    session,
    rest: (mode) => {
      state.restMode = mode;
    },
    socket: (mode) => {
      state.socketMode = mode;
    },
    dropSockets: () => {
      for (const ws of [...state.sockets]) ws.close({ code: 4000, reason: "gate-drop" });
    },
  };
}

/** `ready`: 로그인이 끝났다는 표지. 폰 폭에서는 채널 목록이 닫힌 서랍 안이라 보이지 않으므로 사이드바 자체로 본다. */
export async function signIn(page, origin, ready = { testId: "channel-list", state: "visible" }) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("gate-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId(ready.testId).waitFor({ state: ready.state });
}

/** 첫 채널을 연다(로그인 직후 어디에 서 있든 컴포저가 있는 화면으로). */
export async function openGeneral(page) {
  await page.locator(`[data-channel-id="${GENERAL_ID}"]`).first().click();
  await page.getByTestId("composer-input").waitFor({ state: "visible" });
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 페이지가 본 소켓 상태(ChatShell이 게이트 러너용으로 내놓는 읽기 전용 표지). */
export const pageSocketStatus = (page) =>
  page.evaluate(() => window.__spike?.connStatus ?? null);
