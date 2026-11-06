#!/usr/bin/env node
// =============================================================================
// clients/mobile/scripts/lane-api-ctl.mjs — 폰 레인의 api 컨테이너 하나만 내렸다 올리는 작은 컨트롤러 (#5310)
//
// 시뮬레이터는 네트워크를 못 끈다(Maestro 도 마찬가지 — `5222-shell-connection-strip` 이 NetInfo 를 덮어 쓰는 까닭). 「서버에 닿지 못함」을 실제로 만들려면 서버 쪽을 끊어야 하고,
// Maestro 흐름 안에서는 `evalScript: ${http.get(CTL + '/api-stop').status}` 로 이 컨트롤러를 부른다. 흐름 밖에 두는 까닭: docker 를 부르는 일은 흐름이 못 한다.
//
//   node scripts/lane-api-ctl.mjs --project <compose 프로젝트> --port <포트> [--service api|centrifugo]
//   GET /api-stop    `docker stop -t 1 <프로젝트>-api-1`          (--service api, 기본)
//   GET /api-start   `docker start <프로젝트>-api-1`
//   GET /stop        `docker stop -t 1 <프로젝트>-<서비스>-1`      (고른 서비스 하나. 실시간(소켓) 연결만 끊으려면 `--service centrifugo`, #4895)
//   GET /start       `docker start <프로젝트>-<서비스>-1`
//   GET /status      그 프로젝트의 컨테이너 상태(이름 · 상태)
//
// **허용 범위가 고정이다**: 이 프로젝트의 `api` 또는 `centrifugo` 컨테이너 **하나**(`--service`로 고르고, 기본은 api), 동작은 stop·start·status 셋뿐이다. 남의 compose(검증 줄·다른 칸)의 컨테이너나 다른
// 서비스(postgres 등)는 이 스크립트로 건드릴 수 없다. `/api-*` 길은 `--service api` 일 때만 열린다(이름과 다른 컨테이너가 멈추는 일이 없게). `--project` 는 **반드시 명시**한다(기본값이 없다 — 기본값이 있으면 아무 레인의 api 나 내릴 수 있다). 127.0.0.1 에만 귀를 연다. 끝낼 때(SIGTERM·SIGINT)는
// 올려 두고 나간다 — 내린 채 끝나 다음 흐름이 죽은 서버를 만나지 않게.
//
// 쓰는 흐름: `maestro/5310-resend-tail-live.yaml` (머리말에 전체 실행 순서). 레인 스택은 `npm run lane:phone -- --keep --skip-flows` 로 올린다.
// =============================================================================
import {execFile} from 'node:child_process';
import http from 'node:http';

function argOf(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const project = argOf('project');
const port = Number(argOf('port'));
// 건드릴 수 있는 서비스는 이 둘뿐이다(#4895: 서버(api)는 멀쩡하고 실시간(소켓)만 끊기는 장면이 필요했다).
const SERVICES = ['api', 'centrifugo'];
const service = argOf('service') ?? 'api';

if (project === undefined || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
  console.error('usage: lane-api-ctl.mjs --project <compose project (lowercase, digits, _ -)> --port <port> [--service api|centrifugo]');
  process.exit(2);
}
if (!SERVICES.includes(service)) {
  console.error(`lane-api-ctl: --service must be one of ${SERVICES.join(' | ')}`);
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('lane-api-ctl: --port must be an integer in 1024..65535');
  process.exit(2);
}

const api = `${project}-${service}-1`;

/** docker 를 셸 없이 부른다. 인자는 위에서 고른 컨테이너 이름뿐이다. */
function docker(args) {
  return new Promise(resolve => {
    execFile('docker', args, {timeout: 60_000}, (error, stdout, stderr) => {
      resolve({rc: error === null ? 0 : (error.code ?? 1), out: String(stdout).trim(), err: String(stderr).trim()});
    });
  });
}

const stamp = () => new Date().toTimeString().slice(0, 8);

const server = http.createServer(async (request, response) => {
  const path = (request.url ?? '').replace(/^\/+|\/+$/g, '');
  const result = {path, t: stamp()};
  if (path === 'stop' || (path === 'api-stop' && service === 'api')) {
    result.rc = (await docker(['stop', '-t', '1', api])).rc;
  } else if (path === 'start' || (path === 'api-start' && service === 'api')) {
    result.rc = (await docker(['start', api])).rc;
  } else if (path === 'status') {
    const status = await docker(['ps', '-a', '--filter', `name=${project}-`, '--format', '{{.Names}} {{.Status}}']);
    result.rc = status.rc;
    result.status = status.out.split('\n').filter(line => line !== '');
  } else {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(result));
  console.log(JSON.stringify(result));
});

let leaving = false;
async function leave() {
  if (leaving) return;
  leaving = true;
  await docker(['start', api]);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', leave);
process.on('SIGINT', leave);

server.listen(port, '127.0.0.1', () => {
  console.log(`listening ${port} -> ${api}`);
});
