// Shared helpers for the MOMO-595 gate runners. Node 24 (global fetch +
// global WebSocket). Credentials come ONLY from the shell env — never hardcode.
//
//   MOMO_API_BASE   default http://127.0.0.1:28000
//   MOMO_WORKSPACE  default demo workspace
//   MOMO_EMAIL      required for auth
//   MOMO_PASSWORD   required for auth
//   MOMO_CHANNEL    default the spike gate channel

export const API_BASE =
  (process.env.MOMO_API_BASE || "http://127.0.0.1:28000").replace(/\/+$/, "");
export const WORKSPACE =
  process.env.MOMO_WORKSPACE || "00000000-0000-7000-8000-000000000001";
export const CHANNEL =
  process.env.MOMO_CHANNEL || "019f94e3-0e04-79cd-9dee-208f47edd9a8";

export function requireCreds() {
  const email = process.env.MOMO_EMAIL;
  const password = process.env.MOMO_PASSWORD;
  if (!email || !password) {
    console.error(
      "MOMO_EMAIL and MOMO_PASSWORD must be set in the environment (never hardcode)."
    );
    process.exit(2);
  }
  return { email, password };
}

export async function login() {
  const { email, password } = requireCreds();
  const res = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, workspace: WORKSPACE }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  return res.json();
}

export function makeApi(accessToken) {
  return async function api(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const b = await res.json();
        if (b?.error?.message) msg = b.error.message;
      } catch {
        /* non-JSON */
      }
      throw new Error(`${path}: ${msg}`);
    }
    return res.json();
  };
}

/** Ascending pull of every message via `?after` from `afterSeq` (default 0). */
export async function fetchAllAfter(api, channel, afterSeq = 0, pageLimit = 100) {
  let after = afterSeq;
  const all = [];
  for (;;) {
    const page = await api(
      `/v1/workspaces/${WORKSPACE}/channels/${channel}/messages?after=${after}&limit=${pageLimit}`
    );
    if (!page.messages.length) break;
    all.push(...page.messages);
    const maxSeq = page.messages.reduce((m, x) => Math.max(m, x.seq), after);
    if (maxSeq <= after) break;
    after = maxSeq;
    if (page.messages.length < pageLimit) break;
  }
  return all;
}

/** Mirror of src/features/timeline/model.ts mergeMessages (seq authority). */
export function mergeAscending(existing, batch) {
  const bySeq = new Map(existing.map((m) => [m.seq, m]));
  for (const m of batch) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function isStrictlyOrdered(messages) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].seq <= messages[i - 1].seq) return false;
  }
  return true;
}
