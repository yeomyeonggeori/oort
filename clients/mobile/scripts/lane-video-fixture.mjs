#!/usr/bin/env node
// =============================================================================
// clients/mobile/scripts/lane-video-fixture.mjs — 폰 레인에 영상 첨부를 심는다 (#5208).
//
// `maestro/124-video-viewer-live.yaml` 이 보는 대화를 만든다. 실제 서버(레인의 배포 이미지)에 **진짜 REST 길**로 올린다:
//
//   POST …/attachments/uploads → PUT <uploadUrl> (bearer 없음) → POST …/complete → PUT …/media (길이·치수·포스터) → POST …/messages
//
// 영상·포스터·사진은 ffmpeg 로 이 자리에서 만든다(저장소에 바이너리를 두지 않는다). 레인은 사람의 영상이 아니라 **시험 그림**(testsrc2 + 사인파)을
// 쓴다 — 재생이 시작되었는지는 화면의 움직임이 아니라 서버 기록(`Range` 요청의 206)과 앱의 재생 표시로 잰다.
//
// 심는 메시지 셋(#general, 이 순서):
//   ① 「영상 포스터」   가로 16:9 영상 + 포스터                      → 포스터 카드, 재생 가능
//   ② 「사진과 영상」   사진 한 장 + 세로 9:16 영상 + 포스터         → 섞인 묶음(넘기기)
//   ③ 「포스터 없는 영상」 가로 영상, 길이는 있고 포스터는 없음       → 영상기 아이콘 카드
//
// 출력(stdout 마지막 줄): 올라간 첨부 id 들의 JSON — 레인이 서버 기록에서 그 id 의 `Range` 요청을 찾는다.
// 토큰은 어디에도 찍지 않는다.
// =============================================================================
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined) {
    console.error(`lane-video-fixture: missing --${name}`);
    process.exit(2);
  }
  return value;
}

const baseUrl = arg('base-url');
const email = arg('email');
const password = arg('password');
const workspace = arg('workspace');
const channel = arg('channel');
const out = arg('out');
mkdirSync(out, { recursive: true });

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** 시험 영상: 움직이는 시험 그림 + 사인파. `bitrate` 가 높아야 구간 읽기가 여러 번 일어날 만큼 크다. */
function makeVideo(name, { width, height, seconds, bitrate }) {
  const file = join(out, name);
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate,
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file,
  ]);
  return file;
}

function makePoster(videoFile, name, width) {
  const file = join(out, name);
  ffmpeg(['-i', videoFile, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', file]);
  return file;
}

const landscape = makeVideo('landscape.mp4', { width: 1280, height: 720, seconds: 12, bitrate: '12M' });
const portrait = makeVideo('portrait.mp4', { width: 720, height: 1280, seconds: 6, bitrate: '6M' });
const landscapePoster = makePoster(landscape, 'landscape-poster.jpg', 640);
const portraitPoster = makePoster(portrait, 'portrait-poster.jpg', 360);
const photoFile = join(out, 'photo.png');
ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=1', '-frames:v', '1', photoFile]);

async function call(method, url, { token, body, headers = {}, expect } = {}) {
  const response = await fetch(new URL(url, baseUrl), {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const text = await response.text();
  if (expect !== undefined && response.status !== expect) {
    throw new Error(`${method} ${url} -> ${response.status} (expected ${expect}): ${text.slice(0, 200)}`);
  }
  return text === '' ? null : JSON.parse(text);
}

const login = await call('POST', '/v1/auth/login', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
  expect: 200,
});
const token = login.accessToken;
const channelPath = `/v1/workspaces/${workspace}/channels/${channel}`;
const json = { 'content-type': 'application/json' };

/** 한 건을 올려 `complete` 까지. 영상이면 길이·치수(·포스터)를 `PUT …/media` 로 더한다. */
async function upload({ file, name, mime, media }) {
  const bytes = readFileSync(file);
  const created = await call('POST', `${channelPath}/attachments/uploads`, {
    token,
    headers: json,
    body: JSON.stringify({ name, mime, size: statSync(file).size }),
    expect: 201,
  });
  const put = await fetch(new URL(created.uploadUrl, baseUrl), {
    method: 'PUT',
    headers: { 'content-type': mime },
    body: bytes,
  });
  if (!put.ok) throw new Error(`PUT upload -> ${put.status}`);
  await call('POST', `${channelPath}/attachments/${created.id}/complete`, { token, headers: json, body: '{}', expect: 200 });
  if (media !== undefined) {
    const body = {
      durationMs: media.durationMs,
      width: media.width,
      height: media.height,
      ...(media.poster === undefined
        ? {}
        : { poster: { mime: 'image/jpeg', dataBase64: readFileSync(media.poster).toString('base64') } }),
    };
    await call('PUT', `${channelPath}/attachments/${created.id}/media`, {
      token,
      headers: json,
      body: JSON.stringify(body),
      expect: 200,
    });
  }
  return created.id;
}

async function send(text, attachmentIds) {
  await call('POST', `${channelPath}/messages`, {
    token,
    headers: json,
    body: JSON.stringify({ clientMsgId: randomUUID(), body: text, attachmentIds }),
    expect: 201,
  });
}

const ids = {};
ids.poster = await upload({
  file: landscape,
  name: 'landscape.mp4',
  mime: 'video/mp4',
  media: { durationMs: 12_000, width: 1280, height: 720, poster: landscapePoster },
});
await send('영상 포스터', [ids.poster]);

ids.mixedPhoto = await upload({ file: photoFile, name: 'photo.png', mime: 'image/png' });
ids.mixedVideo = await upload({
  file: portrait,
  name: 'portrait.mp4',
  mime: 'video/mp4',
  media: { durationMs: 6_000, width: 720, height: 1280, poster: portraitPoster },
});
await send('사진과 영상', [ids.mixedPhoto, ids.mixedVideo]);

ids.noPoster = await upload({
  file: landscape,
  name: 'no-poster.mp4',
  mime: 'video/mp4',
  media: { durationMs: 12_000, width: 1280, height: 720 },
});
await send('포스터 없는 영상', [ids.noPoster]);

console.log(JSON.stringify(ids));
