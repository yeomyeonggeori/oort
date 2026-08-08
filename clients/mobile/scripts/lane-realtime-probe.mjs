#!/usr/bin/env node
// =============================================================================
// clients/mobile/scripts/lane-realtime-probe.mjs — 폰 실시간 레일 단정 (#1051)
//
// 레인이 초록인데 실시간이 죽어 있을 수 있었다. 그게 #1051이 이름 붙인 구멍이다:
// 다섯 플로우 중 무엇도 "프레임이 소켓으로 왔다"를 단정하지 않는다 — 화면에 글자가
// 나타나면 통과이고, 그 글자는 재조회로도 나타난다. 그래서 QA 스택의 centrifugo가
// RN Origin을 거절하는 동안에도 레인은 초록일 수 있었다.
//
// 이 프로브가 단정하는 것은 정확히 하나다: **RN이 보내는 그 Origin으로 핸드셰이크가
// 열리고, 그 소켓으로 발행 프레임이 실제로 도착한다.**
//
// ## 왜 앱이 아니라 별도 프로브인가
//
// 앱 안에서 같은 것을 보려면 "이 글자가 재조회가 아니라 소켓으로 왔다"를 UI에서
// 구별해야 하는데, 그건 화면이 답해 줄 수 있는 질문이 아니다. 반대로 이 프로브는
// 앱이 쓰는 바로 그 라이브러리(`centrifuge` — clients/mobile/node_modules,
// src/realtime/centrifugeTransport.ts가 import 하는 그것)를 쓰고, RN WebSocket이
// 붙이는 바로 그 헤더를 붙인다. 즉 앱의 전송 계층을 앱 없이 재현한다.
//
// ## Origin — 이 프로브의 전부
//
// React Native의 WebSocket은 `Origin` 헤더를 보내고 그 값은 **웹소켓 URL 자신의
// origin**이다(clients/mobile/README.md:117 — 측정으로 확인된, 사전 조사가 틀렸던
// 지점). Node의 `ws`는 기본적으로 Origin을 보내지 않으므로, 여기서 명시적으로
// 붙이지 않으면 이 프로브는 앱이 겪지 않는 조건에서 초록이 되고 아무것도 증명하지
// 못한다. `--origin` 이 필수 인자인 이유다.
//
// red proof: 스택의 `CENTRIFUGO_ALLOWED_ORIGINS`에서 이 origin을 빼면 핸드셰이크가
// 거절되고 이 프로브는 빨강이 된다(레인 러너가 `--red-proof` 로 그 왕복을 돈다).
//
// 사용:
//   node lane-realtime-probe.mjs \
//     --server http://127.0.0.1:24330 --ws ws://127.0.0.1:24331/connection/websocket \
//     --origin http://127.0.0.1:24331 \
//     --email … --password … --workspace <uuid> --channel <uuid>
// =============================================================================
import {Centrifuge} from 'centrifuge';
import WebSocketImpl from 'ws';
import {randomUUID} from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const need = (name) => {
  const value = args.get(name);
  if (!value) {
    console.error(`[rt-probe] missing required --${name}`);
    process.exit(2);
  }
  return value;
};

const SERVER = need('server').replace(/\/$/, '');
const WS_URL = need('ws');
const ORIGIN = need('origin');
const EMAIL = need('email');
const PASSWORD = need('password');
const WORKSPACE = need('workspace');
const CHANNEL = need('channel');
const TIMEOUT_MS = Number(args.get('timeout') ?? 45000);
// `--expect-refused` inverts the verdict: the run PASSES when the handshake is
// refused. That is how the red proof proves itself rather than being asserted —
// a probe that only ever reports green cannot tell "the rail works" from "the
// probe is broken".
const EXPECT_REFUSED = args.has('expect-refused');

const say = (...parts) => console.log('[rt-probe]', ...parts);

// The channel string the relay publishes to: `ch:ws<WORKSPACE>.<CHANNEL>` with
// UPPERCASE uuids. Not a detail — the core builds it this way
// (packages/momo-core/src/lib/realtimeEvents.ts:168) and the Rust spine agrees
// (server-rust/crates/momo-messaging/src/message.rs:286-291). Subscribing to the
// lowercase spelling yields a subscription that is valid, quiet, and useless.
const CHANNEL_NAME = `ch:ws${WORKSPACE.toUpperCase()}.${CHANNEL.toUpperCase()}`;

/** RN's WebSocket sends an Origin; Node's does not unless told. */
class OriginWebSocket extends WebSocketImpl {
  constructor(address, protocols) {
    super(address, protocols, {origin: ORIGIN, headers: {Origin: ORIGIN}});
  }
}

async function api(path, {method = 'GET', token, body} = {}) {
  const response = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? {authorization: `Bearer ${token}`} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: {email: EMAIL, password: PASSWORD, workspace: WORKSPACE},
  });
  const access = login.accessToken;
  if (!access) throw new Error('login returned no accessToken');

  const realtime = await api('/v1/auth/realtime-token', {method: 'POST', token: access});
  const token = realtime.token ?? realtime.accessToken;
  if (!token) throw new Error(`realtime-token returned no token: ${JSON.stringify(realtime)}`);
  say(`connecting to ${WS_URL} with Origin: ${ORIGIN}`);

  const centrifuge = new Centrifuge(WS_URL, {token, websocket: OriginWebSocket});

  const marker = `rt-probe ${randomUUID()}`;
  let settle;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });

  let everSubscribed = false;
  centrifuge.on('error', (ctx) => {
    // A refused handshake is reported here, repeatedly, with the socket never
    // once open — the exact shape clients/mobile/README.md documents.
    say(`transport error: ${JSON.stringify(ctx?.error ?? ctx)}`);
    // Only fatal BEFORE the subscription is live. After it, a transport blip is
    // something centrifuge-js reconnects through, and failing on it would make
    // this probe report a shut rail for a rail that is merely having a moment —
    // a false red is worse than a slow one. Once subscribed, the deadline below
    // is what catches a rail that really died.
    if (!everSubscribed) {
      settle({ok: false, reason: 'transport error (handshake refused?)'});
    }
  });

  const subscription = centrifuge.newSubscription(CHANNEL_NAME);
  subscription.on('publication', (ctx) => {
    const body = JSON.stringify(ctx.data ?? {});
    if (body.includes(marker)) {
      settle({ok: true, frame: body.slice(0, 400)});
    }
  });
  subscription.on('error', (ctx) => {
    say(`subscription error: ${JSON.stringify(ctx?.error ?? ctx)}`);
    settle({ok: false, reason: 'subscribe refused'});
  });

  const subscribed = new Promise((resolve, reject) => {
    subscription.on('subscribed', () => {
      everSubscribed = true;
      resolve();
    });
    setTimeout(() => reject(new Error('subscription never became ready')), TIMEOUT_MS);
  });

  centrifuge.connect();
  subscription.subscribe();

  const timer = setTimeout(
    () => settle({ok: false, reason: `no publication within ${TIMEOUT_MS}ms`}),
    TIMEOUT_MS,
  );

  try {
    await subscribed;
    say(`subscribed to ${CHANNEL_NAME}; posting a message over REST`);
    // Posted only AFTER the subscription is ready, so a frame that arrives is
    // necessarily live traffic and not history replay.
    await api(`/v1/workspaces/${WORKSPACE}/channels/${CHANNEL}/messages`, {
      method: 'POST',
      token: access,
      body: {clientMsgId: randomUUID(), type: 'text', body: marker},
    });
  } catch (error) {
    settle({ok: false, reason: String(error.message ?? error)});
  }

  const result = await outcome;
  clearTimeout(timer);
  centrifuge.disconnect();

  if (EXPECT_REFUSED) {
    if (result.ok) {
      console.error('[rt-probe] FAIL red proof: the rail opened with the origin removed.');
      console.error('[rt-probe] The allow-list is not what gates this, so the green run proves nothing.');
      process.exit(1);
    }
    say(`PASS red proof — the rail stayed shut: ${result.reason}`);
    return;
  }

  if (!result.ok) {
    console.error(`[rt-probe] FAIL realtime: ${result.reason}`);
    console.error(`[rt-probe] channel=${CHANNEL_NAME} origin=${ORIGIN}`);
    process.exit(1);
  }
  say(`PASS realtime — live publication received on ${CHANNEL_NAME}`);
  say(`frame: ${result.frame}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[rt-probe] FAIL ${error?.message ?? error}`);
    process.exit(1);
  },
);
