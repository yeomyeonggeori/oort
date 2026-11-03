#!/usr/bin/env node
'use strict';
// =============================================================================
// clients/mobile/scripts/lane-request-recorder.cjs — 폰 레인의 「요청 기록」 (#5208).
//
// 레인의 서버(배포 이미지)는 요청을 로그로 남기지 않는다(HTTP 추적 층이 없고, 시작 줄만 찍힌다). 그래서 「네이티브 플레이어가 구간 읽기
// (`Range`)로 영상 바이트를 받아 갔는가」는 서버 쪽에서는 볼 수 없다. 이 도구는 앱과 서버 사이에 서는 **기록하는 중계**다: 요청을 그대로
// 서버에 넘기고 응답을 그대로 돌려주며, 첨부 바이트의 두 길(`…/attachments/{id}/content`, `…/poster`)에 대해서만 한 줄씩 적는다.
//
//   serve   node lane-request-recorder.cjs serve --listen 27782 --target 127.0.0.1:27780 --out requests.jsonl
//   verify  node lane-request-recorder.cjs verify --records requests.jsonl --played <id,…> --posters <id,…> --no-poster <id,…>
//
// ## 무엇을 적고 무엇을 적지 않는가
//
// 적는다: 시각 · 메서드 · 길(content|poster) · 첨부 id · `Range` 값 · 응답 상태 · `Content-Range` 값 · 보낸 바이트 수 · 끊겼는가 ·
// **`Authorization` 이 베어러 꼴로 실려 왔는가(참·거짓뿐이다)**.
// 적지 않는다: 토큰의 값, 그 밖의 어떤 머리, 본문, 질의 문자열. 기록 파일이 로그·산출물로 남아도 토큰은 거기 없다(시험이 잰다 —
// `__tests__/laneRequestRecorder.test.ts`).
//
// ## verify 가 요구하는 것 (재생한 영상마다)
//
//   · 열기 전 인가 확인(`HEAD`)이 베어러와 함께 200 으로 한 번 이상 있었다 — 앱이 소스를 만들기 전에 토큰을 확인한다.
//   · **첫 `GET` 이 `Range` 를 달고 206 + `Content-Range` 로 답했다** — 전부 받기 전에 구간 읽기로 시작했다는 뜻이다.
//   · 모든 `GET` 에 베어러가 실려 있었다 — 네이티브 플레이어가 헤더를 정말 보냈다(결정 (a)의 사실 근거).
// 포스터가 있는 영상은 `poster` 길이 200 + 베어러로 한 번 이상 읽혔고, 포스터가 없는 영상은 `poster` 길을 **한 번도** 부르지 않았다.
// =============================================================================
const fs = require('node:fs');
const http = require('node:http');

const ROUTE =
  /\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(content|poster)(?:[?#]|$)/i;
const CONTENT_RANGE = /^bytes \d+-\d+\/\d+$/;

/** 기록하는 중계를 연다. 돌려주는 서버의 `address().port` 가 실제 포트다(`listen: 0` 이면 임의). */
function startRecorder({ listen = 0, target, out }) {
  const server = http.createServer((req, res) => {
    const matched = ROUTE.exec(req.url || '');
    const base =
      matched === null
        ? null
        : {
            at: new Date().toISOString(),
            method: req.method,
            route: matched[2].toLowerCase(),
            attachment: matched[1].toLowerCase(),
            range: typeof req.headers.range === 'string' ? req.headers.range : null,
            // 값은 적지 않는다 — 베어러가 실려 왔는가뿐이다.
            auth: /^Bearer\s+\S+/i.test(String(req.headers.authorization || '')),
          };
    let written = false;
    const note = (upstream, bytes, aborted) => {
      if (base === null || written) return;
      written = true;
      fs.appendFileSync(
        out,
        `${JSON.stringify({
          ...base,
          status: upstream.statusCode || 0,
          contentRange: upstream.headers['content-range'] || null,
          bytes,
          aborted,
        })}\n`,
      );
    };
    const forward = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${target.host}:${target.port}` },
      },
      upstream => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        let bytes = 0;
        upstream.on('data', chunk => {
          bytes += chunk.length;
        });
        upstream.on('end', () => note(upstream, bytes, false));
        // 플레이어는 필요한 만큼만 받고 연결을 끊는다 — 끊긴 응답도 한 줄이다(상태는 서버가 준 그대로).
        res.on('close', () => note(upstream, bytes, !upstream.complete));
        upstream.pipe(res);
      },
    );
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => forward.destroy());
    req.pipe(forward);
  });
  return new Promise(resolve => {
    server.listen(listen, '127.0.0.1', () => resolve(server));
  });
}

/** JSON 줄 파일 → 기록들. 깨진 줄은 버리지 않고 알린다(기록이 말없이 줄면 검사가 헛돈다). */
function parseRecords(text) {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`record line ${index + 1} is not JSON`);
      }
    });
}

/**
 * 기록이 약속을 지켰는지 본다. 어긋난 것마다 한 문장을 돌려준다(빈 배열이 통과다).
 * `played`: 재생한 영상 id · `posters`: 포스터가 있어 받았어야 하는 id · `noPoster`: 포스터가 없어 부르지 않았어야 하는 id.
 */
function verifyRecords(records, { played = [], posters = [], noPoster = [] }) {
  const failures = [];
  const of = (id, route) =>
    records.filter(record => record.attachment === id.toLowerCase() && record.route === route);
  if (played.length === 0) failures.push('nothing was named as played — the check would prove nothing');
  for (const id of played) {
    const content = of(id, 'content');
    const heads = content.filter(record => record.method === 'HEAD');
    const gets = content.filter(record => record.method === 'GET');
    if (!heads.some(record => record.auth && record.status === 200)) {
      failures.push(`${id}: no authorised HEAD answered 200 before the source was built`);
    }
    if (gets.length === 0) {
      failures.push(`${id}: the player never read the content route`);
      continue;
    }
    const first = gets[0];
    if (first.range === null || first.status !== 206 || !CONTENT_RANGE.test(first.contentRange || '')) {
      failures.push(
        `${id}: the first GET was not a ranged 206 (range=${first.range} status=${first.status}) — playback began by downloading the whole file`,
      );
    }
    if (gets.some(record => !record.auth)) {
      failures.push(`${id}: a player request carried no bearer — the header never reached the native player`);
    }
  }
  for (const id of posters) {
    if (!of(id, 'poster').some(record => record.method === 'GET' && record.status === 200 && record.auth)) {
      failures.push(`${id}: the poster was never read (200 with a bearer)`);
    }
  }
  for (const id of noPoster) {
    if (of(id, 'poster').length > 0) {
      failures.push(`${id}: a video without a poster still asked for one`);
    }
  }
  return failures;
}

function flag(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}
const list = value => (value === undefined || value === '' ? [] : value.split(',').filter(Boolean));

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'serve') {
    const [host, port] = String(flag(args, 'target') || '').split(':');
    const out = flag(args, 'out');
    if (!host || !port || !out) {
      console.error('usage: serve --listen <port> --target <host:port> --out <file>');
      return 2;
    }
    fs.writeFileSync(out, '');
    const server = await startRecorder({
      listen: Number(flag(args, 'listen') || 0),
      target: { host, port: Number(port) },
      out,
    });
    console.log(`listening ${server.address().port}`);
    // 레인이 PID 로 끝낸다. 끝나기 전에 쓴 줄은 이미 파일에 있다(줄마다 바로 적는다).
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    return new Promise(() => {});
  }
  if (command === 'verify') {
    const file = flag(args, 'records');
    if (!file || !fs.existsSync(file)) {
      console.error('verify: --records <file> is missing or unreadable');
      return 2;
    }
    const records = parseRecords(fs.readFileSync(file, 'utf8'));
    const failures = verifyRecords(records, {
      played: list(flag(args, 'played')),
      posters: list(flag(args, 'posters')),
      noPoster: list(flag(args, 'no-poster')),
    });
    for (const record of records) {
      console.log(
        `${record.method} ${record.route} ${record.attachment.slice(-8)} range=${record.range} -> ${record.status} ${record.contentRange || '-'} ${record.bytes}B auth=${record.auth}${record.aborted ? ' (cut)' : ''}`,
      );
    }
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      return 1;
    }
    console.log(`PASS ${records.length} request(s) recorded`);
    return 0;
  }
  console.error('usage: lane-request-recorder.cjs serve|verify …');
  return 2;
}

module.exports = { startRecorder, parseRecords, verifyRecords };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    if (typeof code === 'number') process.exit(code);
  });
}
