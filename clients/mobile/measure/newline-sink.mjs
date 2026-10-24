#!/usr/bin/env node
/**
 * `measure/composerNewline.tsx` 의 받는 쪽 (#4321). 두 가지를 한 포트에서 한다:
 *
 *   POST /probe                                   표면이 단계마다 보내는 `{surface, stage, body, hasNewline}` 를 줄 단위 JSON 으로 적는다.
 *   POST /v1/workspaces/<ws>/channels/<ch>/messages   코어의 진짜 `sendMessage` 가 보낸 요청 JSON 을 **받은 그대로**(rawBody) 적고,
 *                                                 본문을 그대로 돌려준다(서버가 하는 일의 전부가 아니라, 「요청에 줄바꿈이 실렸는가」만 본다).
 *
 * 앱이 시뮬레이터 안에서 읽은 값(입력창의 값·보내기 직전 본문·말풍선에 그려진 본문)은 시뮬레이터 안에만 있다 —
 * 호스트로 꺼내는 가장 작은 길이 이 서버다(`gap-sink.mjs` 와 같은 모양). 의존성은 없다.
 *
 * Run:  node measure/newline-sink.mjs <out.jsonl> <port-file>
 *
 *   <out.jsonl>   받은 레코드를 한 줄씩 덧붙인다.
 *   <port-file>   임의 포트(0)로 열고 실제 포트를 여기에 쓴다 — 앱 실행 인자 `-momoGapSink 127.0.0.1:<그 포트>` 에 넣는다.
 *
 * 서버 저장(④)은 이 서버가 답하지 않는다. 진짜 서버가 든 증거는 `maestro/70-composer-newline.yaml` 이다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const [, , outFile, portFile] = process.argv;
if (!outFile || !portFile) {
  console.error('usage: node measure/newline-sink.mjs <out.jsonl> <port-file>');
  process.exit(2);
}

/** `measure/composerNewline.tsx` 의 `SELF` — 확정 메시지가 「내 것」으로 그려지게 한다. */
const SELF = '00000000-0000-7000-8000-0000000000e1';
const MESSAGES = /^\/v1\/workspaces\/([^/]+)\/channels\/([^/]+)\/messages$/;

let seq = 100;
const write = record =>
  fs.appendFileSync(outFile, `${JSON.stringify({at: new Date().toISOString(), ...record})}\n`);

const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => {
    raw += chunk;
  });
  request.on('end', () => {
    if (request.method === 'POST' && request.url === '/probe') {
      let record;
      try {
        record = JSON.parse(raw);
      } catch (error) {
        record = {raw, parseError: String(error)};
      }
      write(record);
      response.writeHead(204);
      response.end();
      return;
    }
    const route = MESSAGES.exec(request.url ?? '');
    if (request.method === 'POST' && route) {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 아래 레코드의 parsed 가 null 이면 요청이 JSON 이 아니었다.
      }
      const body = typeof parsed?.body === 'string' ? parsed.body : undefined;
      write({
        surface: 'api',
        stage: '3-request-json',
        url: request.url,
        rawBody: raw,
        bodyField: body,
        hasNewline: body?.includes('\n') ?? false,
      });
      seq += 1;
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          id: crypto.randomUUID(),
          channelId: route[2],
          seq,
          hlcTs: seq,
          hlcCount: 0,
          authorMemberId: SELF,
          type: 'text',
          body,
          state: 'sent',
          createdAtMs: Date.now(),
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
