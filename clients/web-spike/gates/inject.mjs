// Inject N text messages into the spike gate channel (never #general).
// Usage: MOMO_EMAIL=.. MOMO_PASSWORD=.. node gates/inject.mjs [count] [prefix]
import { randomUUID } from "node:crypto";
import { login, makeApi, WORKSPACE, CHANNEL } from "./lib.mjs";

const count = Number(process.argv[2] || 120);
const prefix = process.argv[3] || "seq-gate";

const session = await login();
const api = makeApi(session.accessToken);

let firstSeq = null;
let lastSeq = null;
const t0 = performance.now();
for (let i = 1; i <= count; i++) {
  const msg = await api(
    `/v1/workspaces/${WORKSPACE}/channels/${CHANNEL}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        clientMsgId: randomUUID(),
        type: "text",
        body: `${prefix} #${i} — ${new Date().toISOString()}`,
      }),
    }
  );
  if (firstSeq === null) firstSeq = msg.seq;
  lastSeq = msg.seq;
}
const ms = Math.round(performance.now() - t0);
console.log(
  JSON.stringify(
    { injected: count, firstSeq, lastSeq, channel: CHANNEL, ms },
    null,
    2
  )
);
