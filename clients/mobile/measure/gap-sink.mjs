#!/usr/bin/env node
/**
 * `measure/dockGap.tsx` 가 `-momoGapSink 127.0.0.1:<port>` 로 보내는 레이아웃 값을 줄 단위 JSON 으로 받아 적는다 (#4264).
 *
 * 앱이 `measureInWindow` 로 읽은 값(목록 꼬리·도크·입력창의 창 좌표)은 시뮬레이터 안에서만 존재한다. 사진을 픽셀로 재는
 * 것과는 **다른 길**로 같은 간격을 재야 두 길이 서로를 확인한다 — 그 값을 호스트로 꺼내는 가장 작은 길이 이 서버다.
 * 의존성은 없다.
 *
 * Run:  node measure/gap-sink.mjs <out.jsonl> <port-file> [tag-file]
 *
 *   <out.jsonl>   받은 레코드를 한 줄씩 덧붙인다.
 *   <port-file>   임의 포트(0)로 열고 실제 포트를 여기에 쓴다 — 앱 실행 인자 `-momoGapSink 127.0.0.1:<그 포트>` 에 넣는다.
 *   [tag-file]    있으면 요청마다 이 파일의 현재 내용을 `tag` 로 붙인다(어느 기기·스킴·전/후인지 캡처 스크립트가 적어 둔다).
 */
import fs from 'node:fs';
import http from 'node:http';

const [, , outFile, portFile, tagFile] = process.argv;
if (!outFile || !portFile) {
  console.error('usage: node measure/gap-sink.mjs <out.jsonl> <port-file> [tag-file]');
  process.exit(2);
}

const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
  });
  request.on('end', () => {
    let record;
    try {
      record = JSON.parse(body);
    } catch (error) {
      record = {raw: body, parseError: String(error)};
    }
    let tag = '';
    if (tagFile) {
      try {
        tag = fs.readFileSync(tagFile, 'utf8').trim();
      } catch (error) {
        // 태그 파일이 아직 없으면 빈 태그로 남긴다.
      }
    }
    fs.appendFileSync(outFile, `${JSON.stringify({tag, at: new Date().toISOString(), ...record})}\n`);
    response.writeHead(204);
    response.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
