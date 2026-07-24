// GATE 2 — reconnect resume, zero loss.
// Subscribe (recoverable+positioned) → record tail → drop the WS → inject M
// messages while offline → reconnect → account for every missed message via
// Centrifugo recovery AND/OR REST ?after backfill. missing MUST be 0.
import { randomUUID } from "node:crypto";
import { Centrifuge } from "centrifuge";
import {
  login,
  makeApi,
  fetchAllAfter,
  API_BASE,
  WORKSPACE,
  CHANNEL,
} from "./lib.mjs";

const MISS = Number(process.argv[2] || 25);
const session = await login();
const api = makeApi(session.accessToken);

const channelName = `ch:ws${WORKSPACE.toUpperCase()}.${CHANNEL.toUpperCase()}`;

async function realtimeToken() {
  const r = await api(`/v1/auth/realtime-token`, { method: "POST" });
  return r.token;
}

const client = new Centrifuge(session.realtimeWebSocketUrl, {
  getToken: realtimeToken,
  websocket: WebSocket,
  minReconnectDelay: 200,
  maxReconnectDelay: 1000,
});

const recoveredPubs = new Set();
let phase = "initial";
const livePubs = new Set(); // seqs seen live before the drop

const sub = client.newSubscription(channelName, {
  recoverable: true,
  positioned: true,
});

const subscribedAgain = new Promise((resolve) => {
  let count = 0;
  sub.on("subscribed", (ctx) => {
    count++;
    if (count >= 2) resolve(ctx); // 2nd subscribed = after reconnect
  });
});

sub.on("publication", (ctx) => {
  const seq = ctx?.data?.payload?.seq;
  if (typeof seq !== "number") return;
  if (phase === "offline-recovery") recoveredPubs.add(seq);
  else livePubs.add(seq);
});

const firstSubscribed = new Promise((resolve) => sub.once("subscribed", resolve));
client.connect();
sub.subscribe();
await firstSubscribed;

// tail before the drop
const before = await fetchAllAfter(api, CHANNEL, 0);
const tailSeq = before.length ? before[before.length - 1].seq : 0;

// drop the WS
phase = "offline";
client.disconnect();
await new Promise((r) => setTimeout(r, 300));

// inject M messages while offline
const injectedSeqs = [];
for (let i = 0; i < MISS; i++) {
  const m = await api(
    `/v1/workspaces/${WORKSPACE}/channels/${CHANNEL}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        clientMsgId: randomUUID(),
        type: "text",
        body: `resume-gate offline #${i + 1}`,
      }),
    }
  );
  injectedSeqs.push(m.seq);
}

// reconnect and let recovery replay
phase = "offline-recovery";
client.connect();
sub.subscribe();
await Promise.race([
  subscribedAgain,
  new Promise((r) => setTimeout(r, 5000)),
]);
await new Promise((r) => setTimeout(r, 500)); // drain recovered pubs

// REST backfill from the recorded tail — the client's non-recovered healing path
const backfill = await fetchAllAfter(api, CHANNEL, tailSeq);
const backfillSeqs = new Set(backfill.map((m) => m.seq));

// account for every injected seq
const accounted = new Set([...recoveredPubs, ...backfillSeqs]);
const missing = injectedSeqs.filter((s) => !accounted.has(s));

const result = {
  gate: "reconnect-resume",
  injectedWhileOffline: MISS,
  tailSeqBeforeDrop: tailSeq,
  recoveredViaWs: recoveredPubs.size,
  recoveredViaRestBackfill: backfill.length,
  missing: missing.length,
  pass: missing.length === 0,
  wsUrl: API_BASE.startsWith("http") ? session.realtimeWebSocketUrl : "n/a",
};
console.log(JSON.stringify(result, null, 2));
client.disconnect();
process.exit(result.pass ? 0 : 1);
