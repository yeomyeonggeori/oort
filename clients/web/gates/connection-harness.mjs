// 연결 상태 화면 레인의 공용 도구 (#5220, #5201 S-B).
//
// 실제 번들(dist)을 가짜 `/v1`과 가짜 실시간 서버(센트리퓨고 JSON 프로토콜의 최소판) 위에 띄운다. 둘 다
// 이 레인이 쥔 손잡이로 바뀐다:
//
//   backend.rest("ok" | "abort" | "503")   REST를 정상으로, 응답 없이 끊김으로, 코드 없는 503으로
//   backend.socket("ok" | "refuse")        새 실시간 연결을 받아 줄지(refuse: 열자마자 닫는다)
//   backend.dropSockets()                  붙어 있는 실시간 연결을 서버 쪽에서 끊는다(다시 붙는 건 socket 모드가 정한다)
//   backend.state.probes                   앱이 스스로 보낸 확인 요청(`GET /healthz`, #5407)의 수. 기본은 REST 모드를 `/v1` 과 똑같이 따른다
//                                          (가로채지 않으면 미리보기 서버가 답해 「서버에 닿지 못함」 카드가 2초 만에 걷힌다)
//   backend.healthz("ok" | "abort" | "503" | null)   확인 요청만 따로 정한다(null: REST 모드를 따른다). `/v1` 은 죽어 있는데 확인만 살아난 장면에서
//                                          카드를 걷는 것이 정말 확인 요청인지(백그라운드 `/v1` 요청이 아니라) 가른다
//
// 게이트(`gate-connection.mjs`)가 단정하고 캡처(`scripts/capture-5220.mjs`)가 같은 장면을 찍는다. 자격 증명은
// 없다: `/v1`은 아래 픽스처로만 답한다.

import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

export const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
export const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
export const PEER = "019F94E3-7B0F-7A22-9C13-4D5E6F708192";
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

/** 다른 사람(PEER)이 쓴 메시지 한 줄. `live` 모드의 게이트가 「다른 기기에서 보낸 글」로 쓴다. */
export function peerMessage(seq, body, extra = {}) {
  return message(seq, PEER, body, { hlcTs: Date.now(), createdAtMs: Date.now(), ...extra });
}

/** 레일이 실어 나르는 `message.new` 프레임(서버 `build_broadcast_payload`의 모양). */
export function messageNewFrame(row) {
  return {
    type: "message.new",
    v: 1,
    ts: row.createdAtMs,
    seq: row.seq,
    payload: {
      id: row.id,
      channel_id: row.channelId.toUpperCase(),
      seq: row.seq,
      type: row.type,
      body: row.body,
      author_member_id: row.authorMemberId,
      hlc_ts: row.hlcTs,
      hlc_count: 0,
      created_at_ms: row.createdAtMs,
      state: "sent",
      ...(row.props ? { props: row.props } : {}),
    },
  };
}

/** 채널의 실시간 이름(`centrifugoChannelName`과 같은 규칙). */
export const channelRail = (channelId) => `ch:ws${WORKSPACE_ID.toUpperCase()}.${channelId.toUpperCase()}`;
/** 내 개인 채널(인박스·읽음 신호, `readStateRailChannelName`). */
export const personalRail = `user:read-state#${ME.toUpperCase()}`;

/**
 * 가짜 서버 한 벌을 컨텍스트에 건다. `port`는 실시간 주소를 짓는 데만 쓴다(그 주소는 아무도 듣지 않고,
 * 컨텍스트가 `routeWebSocket`으로 가로챈다).
 *
 * `options.live`(#5660): 서버가 먼저 말하는 모드. 기본은 꺼짐이고, 꺼져 있으면 예전과 바이트까지 같다.
 *   - 연결 답에 `ping`·`pong`을 싣고 그 간격으로 핑을 보낸다(`options.pingSeconds`, 기본 25 — 운영 센트리퓨고의 기본값).
 *     이게 없으면 클라이언트는 조용히 죽은 소켓을 영영 알아채지 못한다(재는 값이 구조상 ∞가 된다).
 *   - `publish(rail, data)`: 채널마다 기록(offset)을 쌓고, 그 채널을 구독한 살아 있는 소켓에 밀어 준다.
 *     재구독이 `recover`로 오면 그 offset 뒤의 기록을 `recovered: true`로 되돌려 준다(운영의 `ch:` 네임스페이스처럼).
 *   - `silenceSockets()`: 지금 붙어 있는 소켓을 **닫지 않고** 죽인다(맥 잠자기·웹뷰 멈춤 뒤의 소켓: 핑도 답도 프레임도 없다).
 *     `dropSockets()`는 깨끗한 닫힘이라 클라이언트가 곧바로 안다 — 잠자기는 그렇지 않다. 새로 여는 소켓은 멀쩡하다.
 *   - `state.readStates`(선 모양 그대로)를 `GET …/read-state`로, `state.extraMessages`를 메시지 목록(`after`를 따른다)으로 답한다.
 */
export async function installBackend(context, port, options = {}) {
  const live = options.live === true;
  const pingSeconds = options.pingSeconds ?? 25;
  const session = {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
    realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
  };
  const state = {
    restMode: "ok",
    /** 앱이 스스로 보낸 확인 요청(`GET /healthz`)의 수. */
    probes: 0,
    /** 확인 요청만의 모드. null 이면 `restMode` 를 따른다. */
    healthzMode: null,
    socketMode: "ok",
    sends: [],
    /** 연 적이 있는 실시간 연결의 수(다시 연결 시도가 실제로 나갔는지 센다). */
    handshakes: 0,
    sockets: new Set(),
    /** `live`: 채널 이름 → 쌓인 발행물(`{ offset, data }`). */
    history: new Map(),
    /** `live`: 소켓 → 그 소켓이 구독한 채널 이름들. */
    subscriptions: new Map(),
    /** `live`: 조용히 죽은 소켓(닫히지 않았지만 아무것도 오가지 않는다). */
    silenced: new Set(),
    /** `live`: `GET …/read-state`가 돌려주는 줄(선 모양: `channel_id`·`mention_count` …). */
    readStates: [],
    /** `live`: 메시지 목록 끝에 붙는 줄(다른 기기에서 보낸 글). */
    extraMessages: [],
    /** `live`: 서버가 받은 `GET …/read-state`의 시각들. */
    readStateFetches: [],
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
    if (live && /\/workspaces\/[^/]+\/read-state$/.test(path) && request.method() === "GET") {
      state.readStateFetches.push(Date.now());
      return json(route, { read_states: state.readStates });
    }
    if (/\/channels\/[^/]+\/messages$/.test(path)) {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const seq = 2_000 + state.sends.length;
        state.sends.push(body);
        return json(route, message(seq, ME, String(body.body ?? ""), { clientMsgId: body.clientMsgId }));
      }
      if (live) {
        const channelId = path.split("/channels/")[1].split("/")[0].toLowerCase();
        const after = Number(url.searchParams.get("after") ?? "0");
        const rows = [...TIMELINE, ...state.extraMessages].filter(
          (row) => row.channelId.toLowerCase() === channelId && row.seq > after
        );
        return json(route, { messages: rows });
      }
      return json(route, { messages: TIMELINE });
    }
    return json(route, { channels: [], members: [], read_states: [], messages: [] });
  });

  // 센트리퓨고 JSON 프로토콜의 최소판: connect·subscribe·그 밖의 명령에 답한다. 서버가 먼저 보내는 것은 없다.
  // 저절로 다시 확인(#5407): 앱이 「서버에 닿지 못함」 카드가 서 있는 동안 보내는 `GET /healthz` 도 같은 REST 모드를 따른다.
  await context.route("**/healthz", async (route) => {
    state.probes += 1;
    const mode = state.healthzMode ?? state.restMode;
    if (mode === "abort") return route.abort("connectionrefused");
    if (mode === "503") return json(route, { error: { message: "service unavailable" } }, 503);
    return json(route, { status: "ok" });
  });

  await context.routeWebSocket(/\/connection\/websocket/, (ws) => {
    if (state.socketMode === "refuse") {
      ws.close({ code: 4000, reason: "gate-refuse" });
      return;
    }
    state.sockets.add(ws);
    let pinger = null;
    ws.onClose(() => {
      state.sockets.delete(ws);
      state.subscriptions.delete(ws);
      state.silenced.delete(ws);
      if (pinger !== null) clearInterval(pinger);
    });
    ws.onMessage((raw) => {
      // 조용히 죽은 소켓: 받은 것에 답하지 않는다(닫지도 않는다).
      if (state.silenced.has(ws)) return;
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        if (command.connect) {
          state.handshakes += 1;
          const connect = { client: "gate-client", version: "6.0.0" };
          if (live) {
            Object.assign(connect, { ping: pingSeconds, pong: true });
            pinger = setInterval(() => {
              if (!state.silenced.has(ws)) ws.send("{}");
            }, pingSeconds * 1_000);
          }
          ws.send(JSON.stringify({ id: command.id, connect }));
        } else if (command.subscribe && live) {
          const name = command.subscribe.channel;
          const log = state.history.get(name) ?? [];
          const top = log.length;
          const asked = command.subscribe.recover === true && command.subscribe.epoch === "gate";
          const since = Number(command.subscribe.offset ?? 0);
          const publications = asked
            ? log.filter((pub) => pub.offset > since).map((pub) => ({ data: pub.data, offset: pub.offset }))
            : [];
          if (!state.subscriptions.has(ws)) state.subscriptions.set(ws, new Set());
          state.subscriptions.get(ws).add(name);
          ws.send(
            JSON.stringify({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                epoch: "gate",
                offset: top,
                recovered: asked,
                was_recovering: asked,
                publications,
              },
            })
          );
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
    healthz: (mode) => {
      state.healthzMode = mode;
    },
    socket: (mode) => {
      state.socketMode = mode;
    },
    dropSockets: () => {
      for (const ws of [...state.sockets]) ws.close({ code: 4000, reason: "gate-drop" });
    },
    /** `live`: 지금 붙은 소켓을 닫지 않고 죽인다(잠자기·웹뷰 멈춤 뒤의 소켓). */
    silenceSockets: () => {
      for (const ws of state.sockets) state.silenced.add(ws);
    },
    /** `live`: 채널에 한 건 발행한다. 그 채널을 구독한 살아 있는 소켓만 받는다(죽은 소켓의 몫은 기록에만 남는다). */
    publish: (rail, data) => {
      const log = state.history.get(rail) ?? [];
      const pub = { offset: log.length + 1, data };
      log.push(pub);
      state.history.set(rail, log);
      for (const [ws, names] of state.subscriptions) {
        if (!names.has(rail) || state.silenced.has(ws)) continue;
        ws.send(JSON.stringify({ push: { channel: rail, pub: { data, offset: pub.offset } } }));
      }
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
