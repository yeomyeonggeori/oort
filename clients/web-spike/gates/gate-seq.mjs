// GATE 1 — seq ordering preservation.
// Pulls every message in the spike channel via REST pagination, folds it
// through the same seq-authority merge the UI uses, and asserts the result is
// strictly ascending and gapless-covered relative to the injected range.
import {
  login,
  makeApi,
  fetchAllAfter,
  mergeAscending,
  isStrictlyOrdered,
  CHANNEL,
} from "./lib.mjs";

const session = await login();
const api = makeApi(session.accessToken);

// Simulate the client fold: shuffle the fetched rows to mimic out-of-order
// realtime arrival, then merge — the invariant must hold regardless of input
// order.
const all = await fetchAllAfter(api, CHANNEL, 0);
const shuffled = all.slice();
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const merged = mergeAscending([], shuffled);

const seqs = merged.map((m) => m.seq);
const ordered = isStrictlyOrdered(merged);
const minSeq = seqs[0];
const maxSeq = seqs[seqs.length - 1];
// contiguous check within the loaded range (server seq is gapless per channel)
let gaps = 0;
for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) gaps++;

const pass = ordered && gaps === 0 && merged.length >= 100;
console.log(
  JSON.stringify(
    {
      gate: "seq-order",
      fetched: all.length,
      afterMerge: merged.length,
      minSeq,
      maxSeq,
      strictlyAscending: ordered,
      gapsWithinRange: gaps,
      pass,
    },
    null,
    2
  )
);
process.exit(pass ? 0 : 1);
