/**
 * 게이트 3 — Node 기준선.
 *
 * 앱(Hermes)에서 도는 것과 **완전히 같은 성질**을 Node 에서 먼저 잰다.
 * 목적은 비교다: 앱에서 실패했을 때 "Hermes/RN 문제"인지 "우리 하네스가
 * 틀린 것"인지 이 기준선이 갈라 준다.
 *
 * 재는 성질은 웹 `clients/web/gates/gate-resume.mjs` 와 동일하다:
 *   구독(recoverable+positioned) → tail 기록 → WS 끊기 → 끊긴 동안 M건 주입
 *   → 재연결 → (Centrifugo 복구 ∪ REST ?after 백필) 로 전부 설명되는가.
 *   missing 은 반드시 0.
 *
 * 실행: node resume-node.mjs [주입건수]
 */
import {Centrifuge} from 'centrifuge';

const MISS = Number(process.argv[2] || 25);
const CENT_PORT = process.env.SPIKE_CENT_PORT || '18901';
const BROKER_PORT = process.env.SPIKE_BROKER_PORT || '18902';
const WS = `ws://127.0.0.1:${CENT_PORT}/connection/websocket`;
const BROKER = `http://127.0.0.1:${BROKER_PORT}`;
const CHANNEL = process.env.SPIKE_CHANNEL || 'ch:spike';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function token() {
  const r = await fetch(`${BROKER}/token`, {method: 'POST'});
  return (await r.json()).token;
}
async function publish(n, tag) {
  const r = await fetch(`${BROKER}/publish?n=${n}&tag=${tag}`, {method: 'POST'});
  return r.json();
}
async function after(seq) {
  const r = await fetch(`${BROKER}/after?seq=${seq}`);
  return r.json();
}

const client = new Centrifuge(WS, {
  getToken: token,
  websocket: WebSocket,
  minReconnectDelay: 200,
  maxReconnectDelay: 1000,
});

let phase = 'initial';
const recovered = new Set();
const live = new Set();
let recoveredFlag = null;

const sub = client.newSubscription(CHANNEL, {recoverable: true, positioned: true});

sub.on('publication', ctx => {
  const seq = ctx?.data?.payload?.seq;
  if (typeof seq !== 'number') return;
  if (phase === 'offline-recovery') recovered.add(seq);
  else live.add(seq);
});

let subCount = 0;
const subscribedAgain = new Promise(resolve => {
  sub.on('subscribed', ctx => {
    subCount++;
    if (subCount >= 2) {
      recoveredFlag = ctx?.recovered ?? null;
      resolve(ctx);
    }
  });
});
const firstSubscribed = new Promise(resolve => sub.once('subscribed', resolve));

client.connect();
sub.subscribe();
await firstSubscribed;

// 끊기 전 몇 건 살아 있는 상태를 만든다(라이브 수신이 되는지도 확인)
await publish(3, 'live');
await sleep(400);

const before = await after(0);
const tailSeq = before.count ? before.messages[before.messages.length - 1].seq : 0;

phase = 'offline';
client.disconnect();
await sleep(300);

const injected = await publish(MISS, 'offline');

phase = 'offline-recovery';
client.connect();
sub.subscribe();
await Promise.race([subscribedAgain, sleep(6000)]);
await sleep(700);

const backfill = await after(tailSeq);
const backfillSeqs = new Set(backfill.messages.map(m => m.seq));
const accounted = new Set([...recovered, ...backfillSeqs]);
const missing = injected.seqs.filter(s => !accounted.has(s));

const result = {
  gate: 'reconnect-resume (RN 스파이크 · Node 기준선)',
  liveBeforeDrop: live.size,
  injectedWhileOffline: injected.seqs.length,
  tailSeqBeforeDrop: tailSeq,
  recoveredViaWs: recovered.size,
  subscribedCtxRecovered: recoveredFlag,
  recoveredViaRestBackfill: backfill.count,
  missing: missing.length,
  pass: missing.length === 0,
};
console.log(JSON.stringify(result, null, 2));
client.disconnect();
process.exit(result.pass ? 0 : 1);
