#!/usr/bin/env node
/**
 * 첨부 내려받기 공유 시트 캡처용 스텁 (#5207). 의존성 0 — `photo-stub.mjs` 와 같은 종류다.
 *
 * 폰의 파일 카드는 눌리면 `GET {apiBase}/v1/workspaces/{ws}/channels/{ch}/attachments/{id}/content` 로 바이트를 받아 앱 캐시에 쓰고, 그 파일을
 * iOS 공유 시트(`Share.share`)에 넘긴다(`src/features/attachments/useShareAttachment.ts`). 하네스에는 서버가 없으므로 이 스텁이 그 한 길만 대신 답한다 —
 * 그래서 **배송되는 내려받기·공유 코드가 그대로 돈다**(앱 코드에 시험용 틈을 내지 않았다).
 *
 * 답하는 파일은 **요청 때 만든 영상 모양 바이트**다(저장소에 영상 파일이 없다). 영상으로 디코드되지는 않지만 공유 시트는 파일 이름·종류·크기만 읽으므로
 * 시트가 서는 모양은 같다. 첨부 id 가 크기를 정한다:
 *   video-small   6 MB    (기본 — 내려받기가 1초 안팎이라 한 번 돌리기 빠르다)
 *   video-big     58.4 MB (보고된 영상의 크기 — 내려받기 진행 줄이 여러 번 바뀐다)
 * 그 밖의 id 는 404 다 — 실패 상태를 찍을 때 쓴다.
 *
 * 천천히 보내서(조각 사이에 `SHARE_STUB_CHUNK_DELAY_MS`) `onProgress` 가 여러 번 불리게 한다. 0 이면 한 번에 보낸다.
 *
 * `POST /log` 는 하네스(`measure/shareAttachment.tsx`)가 보내는 기록 한 줄을 받는다: 표준 출력과 `SHARE_STUB_LOG` 파일(있으면)에 덧붙인다.
 * 앱 안의 console.log 는 개발 빌드에서 Metro 로 오지 않으므로, 앱 상태 전이·시트 열림·스크롤 기록은 이 길로 남는다.
 *
 * Run:  node measure/share-stub.mjs            (포트 18995, `SHARE_STUB_PORT` 로 바꾼다)
 */
import {appendFileSync} from 'node:fs';
import {createServer} from 'node:http';

const PORT = Number(process.env.SHARE_STUB_PORT ?? 18995);
const CHUNK_DELAY_MS = Number(process.env.SHARE_STUB_CHUNK_DELAY_MS ?? 25);
const CHUNK_BYTES = 256 * 1024;
const LOG_FILE = process.env.SHARE_STUB_LOG ?? '';

const FILES = {
  'video-small': 6 * 1024 * 1024,
  'video-big': Math.round(58.4 * 1024 * 1024),
};

const CONTENT = /\/attachments\/([^/]+)\/content$/;

/** MP4 의 첫 상자(`ftyp`) 뒤를 0 으로 채운 바이트. 영상 파일로 읽히지 않아도 이름·크기·종류만 보는 공유 시트에는 충분하다. */
function fileBytes(size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftypisom', 4, 'ascii');
  return bytes;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');

  if (url.pathname === '/log' && request.method === 'POST') {
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const line = Buffer.concat(chunks).toString('utf8');
    process.stdout.write(`LOG ${line}\n`);
    if (LOG_FILE !== '') appendFileSync(LOG_FILE, `${line}\n`);
    response.writeHead(204).end();
    return;
  }

  const id = CONTENT.exec(url.pathname)?.[1];
  const size = id === undefined ? undefined : FILES[decodeURIComponent(id)];
  if (size === undefined) {
    process.stdout.write(`404 ${url.pathname}\n`);
    response.writeHead(404).end();
    return;
  }
  process.stdout.write(`200 ${url.pathname} (${size} bytes)\n`);
  response.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': size});
  const bytes = fileBytes(size);
  for (let at = 0; at < size; at += CHUNK_BYTES) {
    if (response.destroyed) return;
    response.write(bytes.subarray(at, Math.min(size, at + CHUNK_BYTES)));
    if (CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
  }
  response.end();
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`share stub on 127.0.0.1:${PORT}\n`);
});
