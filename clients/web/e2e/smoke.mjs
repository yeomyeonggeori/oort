// SMOKE (MOMO-598 / MOMO-602, R-1 P1): login → channel select → timeline →
// send → live receipt → duplicate check → reload resume.
//
// Drives the real browser bundle against a live momowebqa. Nothing is stubbed.
//
// The send now inserts a local echo (M10), so the live-receipt assertion is
// deliberately scoped to `timeline-message`, the CONFIRMED row: it carries a
// data-seq, and only the merge of a server row (POST response or Centrifugo
// publication) can produce one. The echo renders as `timeline-pending` and is
// asserted separately, together with the duplicate count across both, which is
// what proves the reconcile replaced the echo instead of stacking on it.
//
// The run also records `resubscribeCount` before and after, so a row that
// arrived via a reconnect backfill instead of a live publication is reported,
// not hidden, and finishes by reloading the page to prove the session resumes
// from the stored refresh token (M9) instead of falling back to the login form.
//
// Credentials come ONLY from the shell env, never from source:
//   MOMO_EMAIL / MOMO_PASSWORD   required
//   MOMO_WEB_BASE                default http://127.0.0.1:5173 (dev or preview)
//   MOMO_WORKSPACE               optional, overrides the form prefill
//   MOMO_CHANNEL                 optional, otherwise the first sidebar channel
//
// Usage:
//   npm run preview -- --host 127.0.0.1     # or npm run dev
//   MOMO_EMAIL=... MOMO_PASSWORD=... npm run smoke
import { chromium } from "playwright";
import { advanceToAccount, ONBOARDING_SURFACE } from "./advanceOnboarding.mjs";

const BASE = (process.env.MOMO_WEB_BASE || "http://127.0.0.1:5173").replace(
  /\/+$/,
  ""
);
const email = process.env.MOMO_EMAIL;
const password = process.env.MOMO_PASSWORD;
const workspace = process.env.MOMO_WORKSPACE || "";
const wantChannel = (process.env.MOMO_CHANNEL || "").toLowerCase();

if (!email || !password) {
  console.error("MOMO_EMAIL and MOMO_PASSWORD must be set in the environment.");
  process.exit(2);
}

const steps = [];
function record(name, ok, detail) {
  steps.push({ step: name, ok, ...(detail ? { detail } : {}) });
  if (!ok) throw new Error(`${name} failed: ${detail ?? "assertion"}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));

let result = { smoke: "r1-timeline", base: BASE };
try {
  // ---- 1) login ------------------------------------------------------------
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.fill('[data-testid="login-email"]', email);
  await page.fill('[data-testid="login-password"]', password);
  // goal B13 R2 High 1: the workspace box is collapsed by default now (its right
  // answer is "blank" for almost everyone), so naming one means opening the
  // disclosure first.
  if (workspace) {
    await page.click('[data-testid="login-workspace-toggle"]');
    await page.fill('[data-testid="login-workspace"]', workspace);
  }
  await page.click('[data-testid="login-submit"]');
  // Race the signed-in shell against the login error, so bad credentials report
  // what the server said instead of a bare selector timeout.
  const loginOutcome = await Promise.race([
    page
      .waitForSelector('[data-testid="channel-list"]', { timeout: 20000 })
      .then(() => "signed-in", () => "timeout"),
    page
      .waitForSelector('[data-testid="login-error"]', { timeout: 20000 })
      .then(() => "rejected", () => "timeout"),
  ]);
  const loginError =
    loginOutcome === "rejected"
      ? await page.locator('[data-testid="login-error"]').first().textContent()
      : null;
  record(
    "login",
    loginOutcome === "signed-in",
    loginError ? `server said: ${loginError}` : loginOutcome
  );

  // ---- 2) keyboard path: Cmd+K quick switcher ------------------------------
  await page.keyboard.press("Meta+k");
  await page.waitForSelector('[data-testid="quick-switcher-input"]', {
    timeout: 5000,
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page
    .locator('[data-testid="quick-switcher-input"]')
    .waitFor({ state: "detached", timeout: 5000 });
  record("quick-switcher", true);

  // ---- 3) channel select (sidebar row, real server data) -------------------
  const rows = page.locator('[data-testid="channel-item"]');
  await rows.first().waitFor({ timeout: 20000 });
  const rowCount = await rows.count();
  let target = rows.first();
  let targetId = await target.getAttribute("data-channel-id");
  if (wantChannel) {
    for (let i = 0; i < rowCount; i++) {
      const id = await rows.nth(i).getAttribute("data-channel-id");
      if (id && id.toLowerCase() === wantChannel) {
        target = rows.nth(i);
        targetId = id;
        break;
      }
    }
  }
  await target.click();
  record("channel-select", Boolean(targetId), `channelId=${targetId}`);

  // ---- 4) timeline load ----------------------------------------------------
  // Either real rows or the empty-channel invitation counts as loaded; both are
  // declared states of this surface.
  await page.waitForFunction(
    () => {
      const probe = window.__spike;
      if (!probe) return false;
      return (
        document.querySelector('[data-testid="timeline-message"]') !== null ||
        document.querySelector('[data-testid="timeline-empty"]') !== null
      );
    },
    null,
    { timeout: 20000 }
  );
  // The rail must be up before we claim a live receipt below.
  await page.waitForFunction(
    () => window.__spike?.connStatus === "connected",
    null,
    { timeout: 20000 }
  );
  const beforeProbe = await page.evaluate(() => window.__spike);
  record(
    "timeline-load",
    true,
    `loaded=${beforeProbe.count} newestSeq=${beforeProbe.newestSeq}`
  );

  // ---- 5) send -------------------------------------------------------------
  const token = `smoke-${Date.now().toString(36)}`;
  const body = `${token} 스모크: 로그인에서 실시간 수신까지 한 번에 확인합니다.`;
  await page.fill('[data-testid="composer-input"]', body);
  await page.click('[data-testid="composer-send"]');
  record("send", true, token);

  // ---- 6) live receipt -----------------------------------------------------
  // `timeline-message` is the confirmed row (it has a data-seq), so this waits
  // on the server echo, not on the optimistic one.
  const t0 = Date.now();
  const arrived = page.locator(
    `[data-testid="timeline-message"]:has-text("${token}")`
  );
  await arrived.first().waitFor({ timeout: 20000 });
  const receiveMs = Date.now() - t0;

  const after = await page.evaluate((tok) => {
    const rows = [...document.querySelectorAll('[data-testid="timeline-message"]')];
    const seqs = rows.map((r) => Number(r.getAttribute("data-seq")));
    const hit = rows.find((r) => (r.textContent || "").includes(tok));
    let ascending = true;
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] <= seqs[i - 1]) ascending = false;
    }
    const echoes = [
      ...document.querySelectorAll('[data-testid="timeline-pending"]'),
    ].filter((r) => (r.textContent || "").includes(tok));
    return {
      probe: window.__spike,
      renderedRows: rows.length,
      renderedAscending: ascending,
      arrivedSeq: hit ? Number(hit.getAttribute("data-seq")) : null,
      confirmedCopies: rows.filter((r) => (r.textContent || "").includes(tok))
        .length,
      pendingCopies: echoes.length,
    };
  }, token);

  record(
    "live-receipt",
    after.arrivedSeq !== null &&
      after.arrivedSeq === after.probe.newestSeq &&
      after.renderedAscending,
    `seq=${after.arrivedSeq} newestSeq=${after.probe.newestSeq} ascending=${after.renderedAscending}`
  );

  // ---- 7) optimistic reconcile: exactly one row, echo settled (M10) --------
  const copies = after.confirmedCopies + after.pendingCopies;
  record(
    "optimistic-reconcile",
    copies === 1 && after.pendingCopies === 0,
    `confirmed=${after.confirmedCopies} pending=${after.pendingCopies} probePending=${after.probe.pending}`
  );

  // ---- 8) session resume across a reload (M9) ------------------------------
  // The access token is memory-only, so surviving this reload means the stored
  // refresh token rotated successfully, not that anything was cached.
  await page.reload({ waitUntil: "domcontentloaded" });
  const resumeOutcome = await Promise.race([
    page
      .waitForSelector('[data-testid="channel-list"]', { timeout: 20000 })
      .then(() => "resumed", () => "timeout"),
    page
      .locator(ONBOARDING_SURFACE)
      .first()
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => "logged-out", () => "timeout"),
  ]);
  record("session-resume", resumeOutcome === "resumed", resumeOutcome);

  result = {
    ...result,
    channelId: targetId,
    channelsInSidebar: rowCount,
    messagesBeforeSend: beforeProbe.count,
    messagesAfterSend: after.probe.count,
    arrivedSeq: after.arrivedSeq,
    newestSeq: after.probe.newestSeq,
    receiveMs,
    renderedRows: after.renderedRows,
    renderedAscending: after.renderedAscending,
    // 0 means the row came from a live publication, not a reconnect backfill.
    resubscribesDuringRun:
      after.probe.resume.resubscribeCount - beforeProbe.resume.resubscribeCount,
    recoveryMarkers: after.probe.recoveryMarkers,
    // 1 confirmed + 0 pending is the duplicate-free reconcile (M10).
    confirmedCopies: after.confirmedCopies,
    pendingCopies: after.pendingCopies,
    sessionResume: resumeOutcome,
  };
} catch (err) {
  result = { ...result, error: String(err && err.message ? err.message : err) };
} finally {
  await browser.close();
}

const pass = steps.length > 0 && steps.every((s) => s.ok) && !result.error;
console.log(
  JSON.stringify({ ...result, steps, pageErrors, pass }, null, 2)
);
process.exit(pass ? 0 : 1);
