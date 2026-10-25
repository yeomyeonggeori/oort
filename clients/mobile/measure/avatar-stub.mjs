#!/usr/bin/env node
/**
 * `member.avatar.set` 카드 캡처용 미리보기 스텁 (#4394). 의존성 0 — `photo-stub.mjs` 와 같은 종류다.
 *
 * 카드는 `GET {apiBase}/v1/workspaces/{ws}/approvals/{approval}/avatar-preview?v={sha256}` 로 사진을
 * 받는다. 승인 id 가 답을 가른다:
 *
 *   ap-ready  200 단색 PNG(청록)
 *   ap-slow   응답을 붙들고 안 준다(받는 중 상태)
 *   ap-gone   404(사진 주인이 아닌 사람에게 서버가 주는 답)
 *
 * Run:  node measure/avatar-stub.mjs     (포트 18994, `AVATAR_STUB_PORT` 로 바꾼다)
 */
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';

const PORT = Number(process.env.AVATAR_STUB_PORT ?? 18994);

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
function solidPng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
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

const PNG = solidPng(256, 256, [62, 142, 134]);
const ROUTE = /\/approvals\/([^/]+)\/avatar-preview$/;

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub');
  const id = ROUTE.exec(url.pathname)?.[1];
  const auth = request.headers.authorization ? 'bearer' : 'no-auth';
  if (id === 'ap-ready') {
    process.stdout.write(`200 ${url.pathname}${url.search} (${auth})\n`);
    response.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': PNG.length});
    response.end(PNG);
    return;
  }
  if (id === 'ap-slow') {
    process.stdout.write(`HOLD ${url.pathname}\n`);
    return; // 응답하지 않는다
  }
  process.stdout.write(`404 ${url.pathname}\n`);
  response.writeHead(404, {'Content-Type': 'application/json'}).end('{"error":{"code":"not_found"}}');
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`avatar stub on 127.0.0.1:${PORT}\n`);
});
