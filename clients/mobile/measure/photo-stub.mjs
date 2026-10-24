#!/usr/bin/env node
/**
 * 사진 뷰어 캡처용 첨부 스텁 (#4293). 의존성 0 — `origin-stub.mjs` 와 같은 종류다.
 *
 * 폰의 사진 뷰어는 첨부 바이트를 `GET {apiBase}/v1/workspaces/{ws}/channels/{ch}/attachments/{id}/content`
 * 로 받아 앱 캐시에 쓴다(`src/features/attachments/content.ts`). 하네스에는 서버가 없으므로 이 스텁이
 * 그 한 길만 대신 답한다. 그래서 **배송되는 내려받기 코드가 그대로 돈다** — 앱 코드에 시험용 틈을
 * 내지 않았다.
 *
 * 답하는 그림은 **요청 때 만든 단색 PNG** 다(저장소에 사진 파일이 없다). 첨부 id 가 색과 비율을 정한다:
 *
 *   photo-solo   세로 3:4   청록
 *   photo-a      가로 4:3   주황
 *   photo-b      가로 4:3   남색
 *   photo-c      가로 4:3   겨자
 *
 * 그 밖의 id 는 404 다 — 실패 상태를 찍을 때 쓴다.
 *
 * Run:  node measure/photo-stub.mjs            (포트 18993, `PHOTO_STUB_PORT` 로 바꾼다)
 */
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';

const PORT = Number(process.env.PHOTO_STUB_PORT ?? 18993);

const PICTURES = {
  'photo-solo': {width: 900, height: 1200, rgb: [62, 142, 134]},
  'photo-a': {width: 1200, height: 900, rgb: [217, 123, 79]},
  'photo-b': {width: 1200, height: 900, rgb: [108, 123, 217]},
  'photo-c': {width: 1200, height: 900, rgb: [201, 180, 88]},
};

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 8비트 RGB 단색 PNG 한 장. */
function solidPng({width, height, rgb}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 비트 깊이
  header[9] = 2; // 색 유형: RGB
  const row = Buffer.alloc(1 + width * 3); // 첫 바이트는 필터 0
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({length: height}, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CONTENT = /\/attachments\/([^/]+)\/content$/;

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const id = CONTENT.exec(url.pathname)?.[1];
  const picture = id === undefined ? undefined : PICTURES[decodeURIComponent(id)];
  if (picture === undefined) {
    process.stdout.write(`404 ${url.pathname}\n`);
    response.writeHead(404).end();
    return;
  }
  const png = solidPng(picture);
  process.stdout.write(`200 ${url.pathname} (${png.length} bytes)\n`);
  response.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': png.length});
  response.end(png);
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`photo stub on 127.0.0.1:${PORT}\n`);
});
