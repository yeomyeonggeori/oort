/**
 * 게이트 3 — 스파이크 브로커 (의존성 0, node:http + node:crypto 만)
 *
 * 이것은 momo API 서버가 아니다. 게이트 3이 재려는 성질만 남긴 최소 대역이다:
 *   - 연결 토큰 발급        (실서버의 POST /v1/auth/realtime-token 자리)
 *   - 오프라인 중 메시지 주입 (실서버의 POST …/messages 자리)
 *   - seq 기준 REST 백필     (실서버의 GET …/messages?after=<seq> 자리)
 *
 * 왜 실서버를 안 쓰나: 실서버 왕복에는 자격증명이 필요하고 이 배치는
 * 자격증명을 쓰지 않는다(지시). 실서버 왕복은 오케스트레이터 몫으로 남긴다.
 *
 * 시크릿은 인자로 받지 않는다 — 환경변수로만 들어오고 로그에 찍지 않는다.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const HMAC = process.env.SPIKE_CENT_HMAC;
const API_KEY = process.env.SPIKE_CENT_API_KEY;
const CENT_HTTP = process.env.SPIKE_CENT_HTTP || 'http://127.0.0.1:18901';
const PORT = Number(process.env.SPIKE_BROKER_PORT || 18902);
const CHANNEL = process.env.SPIKE_CHANNEL || 'ch:spike';

if (!HMAC || !API_KEY) {
  console.error('SPIKE_CENT_HMAC / SPIKE_CENT_API_KEY 가 필요하다. run.sh 로 실행해라.');
  process.exit(2);
}

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(claims, ttlSeconds = 600) {
  const header = {alg: 'HS256', typ: 'JWT'};
  const now = Math.floor(Date.now() / 1000);
  const body = {...claims, iat: now, exp: now + ttlSeconds};
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', HMAC).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

/** 채널에 실제로 실린 메시지 원장. REST 백필의 근거가 된다. */
const log = [];
let nextSeq = 0;

async function centrifugoPublish(channel, data) {
  const res = await fetch(`${CENT_HTTP}/api/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({channel, data}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`centrifugo publish ${res.status}: ${text}`);
  }
  const parsed = JSON.parse(text || '{}');
  if (parsed.error) {
    throw new Error(`centrifugo publish error: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }
  try {
    if (url.pathname === '/health') {
      return json(res, 200, {ok: true, channel: CHANNEL, published: log.length});
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      // 실서버의 연결 토큰과 같은 모양: sub + ws 클레임.
      const token = signJwt({
        sub: 'spike-member-0001',
        ws: 'spike-workspace-0001',
        info: {member: 'spike', workspace: 'spike'},
      });
      return json(res, 200, {token, tokenType: 'centrifugo.connection.jwt'});
    }

    if (url.pathname === '/publish' && req.method === 'POST') {
      const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n') || 25)));
      const tag = url.searchParams.get('tag') || 'offline';
      const seqs = [];
      for (let i = 0; i < n; i++) {
        nextSeq += 1;
        const entry = {
          seq: nextSeq,
          body: `spike ${tag} #${i + 1}`,
          at: Date.now(),
        };
        // 웹 게이트가 읽는 모양 그대로: ctx.data.payload.seq
        await centrifugoPublish(CHANNEL, {payload: entry});
        log.push(entry);
        seqs.push(nextSeq);
      }
      return json(res, 200, {published: seqs.length, seqs, tailSeq: nextSeq});
    }

    if (url.pathname === '/after') {
      const after = Number(url.searchParams.get('seq') || 0);
      const rows = log.filter(m => m.seq > after);
      return json(res, 200, {after, count: rows.length, messages: rows});
    }

    if (url.pathname === '/reset' && req.method === 'POST') {
      log.length = 0;
      nextSeq = 0;
      return json(res, 200, {ok: true});
    }

    return json(res, 404, {error: 'not found'});
  } catch (e) {
    return json(res, 500, {error: String(e && e.message ? e.message : e)});
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[broker] listening on 0.0.0.0:${PORT} · channel=${CHANNEL} · centrifugo=${CENT_HTTP}`);
});
