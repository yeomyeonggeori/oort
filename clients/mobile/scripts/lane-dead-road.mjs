#!/usr/bin/env node
// =============================================================================
// clients/mobile/scripts/lane-dead-road.mjs — 폰 레인의 「죽은 길」 중계 (#4895)
//
// 시뮬레이터는 네트워크를 못 끈다. 그리고 서버를 내리는 것(`lane-api-ctl.mjs`)은 **죽은 길**을 만들지 못한다: 서버가 꺼진 길은 연결이 곧바로 거절돼서 앱이 바로 알고, 서버가 켜져 있는데 길만
// 끊긴 길(신호가 끊긴 Wi-Fi 상위 회선·셀룰러 음영·Wi-Fi ↔ 셀룰러가 넘어가는 순간)은 패킷이 사라져서 요청이 **기한이 다 되도록 아무 소식도 못 듣는다**. 이 중계가 그 길을 만든다.
//
//   앱 -> (이 중계 :<포트>) -> api(:<대상>)
//
//   node scripts/lane-dead-road.mjs --listen <포트> --target <api 포트>        (제어 포트 = listen + 1, 127.0.0.1 에만)
//   GET /hole-on    지금 열려 있는 연결 전부와 새 연결을 **얼린다**: 받은 바이트를 넘기지도, 끊지도, 답하지도 않는다. 앱은 자기 기한(15초)에 끊을 때까지 모른다.
//   GET /hole-off   새 연결은 다시 지나간다. **얼린 연결은 끝내 풀리지 않는다**(실제 죽은 길에서 이미 나간 요청이 그렇다 — 길이 살아나도 그 요청은 답을 못 받는다).
//   GET /state      { hole, frozen }
//
// 앱이 이 중계를 보게 하려면 로그인 주소를 중계로 준다(`SERVER_URL=http://127.0.0.1:<포트>`). 소켓(centrifugo)은 로그인 응답의 주소를 그대로 쓰므로 이 중계를 지나지 않는다 — 소켓은
// `lane-api-ctl.mjs --service centrifugo` 로 끊는다. 토큰·본문은 읽지도 적지도 않는다(바이트를 그대로 넘기거나 버릴 뿐이다).
//
// 쓰는 흐름: `maestro/4895-dead-road-reconnect.yaml` (머리말에 전체 실행 순서). 끝낼 때(SIGTERM·SIGINT)는 얼린 연결을 모두 끊고 나간다.
// =============================================================================
import http from 'node:http';
import net from 'node:net';

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const listen = Number(argOf('listen'));
const target = Number(argOf('target'));
for (const [name, value] of [['listen', listen], ['target', target]]) {
  if (!Number.isInteger(value) || value < 1024 || value > 65534) {
    console.error(`usage: lane-dead-road.mjs --listen <port> --target <port>   (${name} must be an integer in 1024..65534)`);
    process.exit(2);
  }
}

let hole = false;
/** 얼린 연결(앱 쪽). 닫히면 빠진다. */
const frozen = new Set();
/** 지금 api 와 이어져 흐르는 연결(앱 쪽) → 그 연결을 얼리는 함수. */
const flowing = new Map();

const stamp = () => new Date().toTimeString().slice(0, 8);

function freeze(client, upstream) {
  frozen.add(client);
  client.on('close', () => frozen.delete(client));
  client.on('data', () => undefined); // 받아서 버린다
  if (upstream !== undefined) {
    client.unpipe(upstream);
    upstream.unpipe(client);
    upstream.destroy();
  }
}

net
  .createServer(client => {
    client.on('error', () => undefined);
    if (hole) {
      freeze(client);
      return;
    }
    const upstream = net.connect(target, '127.0.0.1');
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    flowing.set(client, () => {
      flowing.delete(client);
      freeze(client, upstream);
    });
    client.on('close', () => {
      flowing.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      if (flowing.has(client)) client.destroy();
    });
  })
  .listen(listen, '127.0.0.1', () => {
    console.log(`${stamp()} dead-road relay ${listen} -> ${target}, control ${listen + 1}`);
  });

http
  .createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\/+|\/+$/g, '');
    if (path === 'hole-on') {
      hole = true;
      for (const freezeFlowing of [...flowing.values()]) freezeFlowing();
    } else if (path === 'hole-off') {
      hole = false;
    } else if (path !== 'state') {
      response.writeHead(404).end();
      return;
    }
    const result = {path, hole, frozen: frozen.size, t: stamp()};
    console.log(JSON.stringify(result));
    response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(result));
  })
  .listen(listen + 1, '127.0.0.1');

function leave() {
  for (const client of [...frozen, ...flowing.keys()]) client.destroy();
  process.exit(0);
}
process.on('SIGTERM', leave);
process.on('SIGINT', leave);
