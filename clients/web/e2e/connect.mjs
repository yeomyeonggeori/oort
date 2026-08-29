// CONNECT (MOMO-604, ADR-0133 P2): server selection, deep-link prefill and the
// dynamic API base, driven in a real browser against a live momowebqa.
//
// What each step proves, and why it is done this way:
//
//   deep-link fallback   A browser has no `oort://` scheme, so the invite
//                        parameters ride the page URL. The run opens a wrapped
//                        `?join=oort://join?server=...&code=...`, asserts both
//                        fields are prefilled and the invite code is GONE from
//                        the address bar afterwards (it is a bearer secret).
//                        BZ-6a: invite prefill skips S0 and opens S1; email
//                        and the join submit live on S2.
//   validation           `ws://...` is rejected inline on S1, at the field, and
//                        no request leaves the page.
//   dynamic base         Two halves. First a base that cannot answer
//                        (127.0.0.1:1) makes login fail with the network copy,
//                        which is only possible if requests stopped being
//                        same-origin. Then the preview origin is entered
//                        explicitly and the same login succeeds, is stored, and
//                        survives a reload.
//   browser silence      The discovery card must not exist off the desktop
//                        shell (no mDNS in a web page).
//   offline              The banner appears on S2 and the submit is disabled.
//
// The absolute base used here is the preview origin itself, ON PURPOSE: the
// momowebqa REST server sends no CORS headers and does not answer preflight
// (verified: OPTIONS /v1/auth/login -> 404, no Access-Control-*), so a browser
// cannot address a different origin directly. Reaching a remote server from a
// browser needs the same-origin proxy; from the desktop shell it needs either
// server-side CORS for the app origin or the Rust HTTP plugin. That boundary is
// a shell/server concern, not something this surface can paper over.
//
// Credentials come ONLY from the shell env, never from source:
//   MOMO_EMAIL / MOMO_PASSWORD   required
//   MOMO_WEB_BASE                default http://127.0.0.1:5173 (dev or preview)
//
// Usage:
//   npm run preview -- --host 127.0.0.1
//   MOMO_EMAIL=... MOMO_PASSWORD=... node e2e/connect.mjs
import { chromium } from "playwright";
import {
  ONBOARDING_SURFACE,
  advanceToAccount,
} from "./advanceOnboarding.mjs";

const BASE = (process.env.MOMO_WEB_BASE || "http://127.0.0.1:5173").replace(
  /\/+$/,
  ""
);
const email = process.env.MOMO_EMAIL;
const password = process.env.MOMO_PASSWORD;

if (!email || !password) {
  console.error("MOMO_EMAIL and MOMO_PASSWORD must be set in the environment.");
  process.exit(2);
}

const steps = [];
function record(name, ok, detail) {
  steps.push({ step: name, ok, ...(detail ? { detail } : {}) });
  if (!ok) throw new Error(`${name} failed: ${detail ?? "assertion"}`);
}

async function openGateway(page) {
  await page.locator(ONBOARDING_SURFACE).first().waitFor({ timeout: 20_000 });
  const landing = page.getByTestId("onboarding-landing");
  const account = page.getByTestId("onboarding-account");
  if (await landing.isVisible()) {
    await page.getByTestId("onboarding-choose-server").click();
  } else if (await account.isVisible()) {
    await page.getByTestId("onboarding-back").click();
  }
  await page.getByTestId("onboarding-gateway").waitFor({ state: "visible" });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));

const STORAGE_KEY = "momo.web.server.v1";
const readStoredServer = () =>
  page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

let result = { e2e: "p2-connect", base: BASE };
try {
  // ---- 1) deep-link prefill through the browser query fallback -------------
  const deepLink = `oort://join?server=${encodeURIComponent(
    BASE
  )}&code=not-a-real-invite-code`;
  await page.goto(`${BASE}/?join=${encodeURIComponent(deepLink)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-testid="login-server"]', { timeout: 20000 });
  record(
    "deeplink-skips-s0",
    (await page.locator('[data-testid="onboarding-landing"]').count()) === 0
  );

  const prefilledServer = await page.inputValue('[data-testid="login-server"]');
  record(
    "deeplink-server-prefill",
    prefilledServer === BASE,
    `server=${prefilledServer}`
  );

  const prefilledCode = await page.inputValue('[data-testid="login-invite-code"]');
  record(
    "deeplink-code-prefill",
    prefilledCode === "not-a-real-invite-code",
    `code-length=${prefilledCode.length}`
  );

  const urlAfterPrefill = page.url();
  record(
    "deeplink-code-stripped-from-history",
    !urlAfterPrefill.includes("not-a-real-invite-code") &&
      !urlAfterPrefill.includes("join="),
    urlAfterPrefill
  );

  await page.click('[data-testid="onboarding-next"]');
  await page.waitForSelector('[data-testid="onboarding-account"]', {
    timeout: 5000,
  });
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? "none"
  );
  record(
    "deeplink-focus-lands-on-first-missing-field",
    focused === "login-email",
    `focused=${focused}`
  );

  const submitLabel = await page.textContent('[data-testid="login-submit"]');
  record(
    "deeplink-switches-to-join",
    (submitLabel ?? "").includes("참여"),
    `submit=${submitLabel}`
  );

  // ---- 2) the discovery card never appears in a browser --------------------
  record(
    "discovery-silent-in-browser",
    (await page.locator('[data-testid="connect-discovery"]').count()) === 0
  );

  // ---- 3) server URL validation is inline and blocks the request ----------
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="onboarding-landing"]', {
    timeout: 20000,
  });
  record(
    "fresh-visit-opens-s0",
    (await page.locator('[data-testid="onboarding-landing"]').count()) === 1
  );
  await page.click('[data-testid="onboarding-choose-server"]');
  await page.waitForSelector('[data-testid="onboarding-gateway"]');
  let requestsDuringValidation = 0;
  const countV1 = (request) => {
    if (request.url().includes("/v1/")) requestsDuringValidation += 1;
  };
  page.on("request", countV1);
  await page.fill('[data-testid="login-server"]', "ws://momo.example.com");
  await page.click('[data-testid="onboarding-next"]');
  await page.waitForSelector('[data-testid="login-server-error"]', { timeout: 5000 });
  const fieldError = await page.textContent('[data-testid="login-server-error"]');
  await page.waitForTimeout(500);
  page.off("request", countV1);
  record(
    "server-url-rejected-inline",
    (fieldError ?? "").includes("http://") && requestsDuringValidation === 0,
    `error=${fieldError} requests=${requestsDuringValidation}`
  );
  record(
    "server-url-rejection-is-not-stored",
    (await readStoredServer()) === null,
    `stored=${await readStoredServer()}`
  );

  // ---- 4) a bare host is accepted and read as https, not blocked by the
  //         browser's own url validity check ---------------------------------
  await page.fill('[data-testid="login-server"]', "127.0.0.1:1");
  await page.click('[data-testid="onboarding-next"]');
  await page.waitForSelector('[data-testid="login-submit"]', { timeout: 5000 });
  await page.fill('[data-testid="login-email"]', email);
  await page.fill('[data-testid="login-password"]', password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 20000 });
  record(
    "bare-host-read-as-https",
    (await readStoredServer()) === "https://127.0.0.1:1",
    `stored=${await readStoredServer()}`
  );

  // ---- 5) the base is really dynamic: an unreachable one must fail --------
  await openGateway(page);
  await page.fill('[data-testid="login-server"]', "http://127.0.0.1:1");
  await page.click('[data-testid="onboarding-next"]');
  await page.waitForSelector('[data-testid="login-submit"]', { timeout: 5000 });
  await page.fill('[data-testid="login-email"]', email);
  await page.fill('[data-testid="login-password"]', password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 20000 });
  const deadBaseError = await page.textContent('[data-testid="login-error"]');
  record(
    "requests-follow-the-chosen-base",
    (deadBaseError ?? "").includes("서버에 닿지 못했습니다"),
    `error=${deadBaseError}`
  );
  // MOMO-609 / G-1: a base that cannot answer must END, with a retry attached
  // to the failure rather than a button that stays on its busy label forever.
  record(
    "unreachable-base-offers-a-retry",
    (deadBaseError ?? "").includes("다시 시도"),
    `error=${deadBaseError}`
  );
  record(
    "chosen-base-is-stored",
    (await readStoredServer()) === "http://127.0.0.1:1",
    `stored=${await readStoredServer()}`
  );

  // ---- 6) an explicit, reachable base logs in and survives a reload -------
  await openGateway(page);
  await page.fill('[data-testid="login-server"]', `${BASE}/`);
  await page.click('[data-testid="onboarding-next"]');
  await page.waitForSelector('[data-testid="login-submit"]', { timeout: 5000 });
  await page.fill('[data-testid="login-email"]', email);
  await page.fill('[data-testid="login-password"]', password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="channel-list"]', { timeout: 30000 });
  record("login-with-explicit-base", true, `base=${BASE}`);
  record(
    "explicit-base-normalised-and-stored",
    (await readStoredServer()) === BASE,
    `stored=${await readStoredServer()}`
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="channel-list"]', { timeout: 30000 });
  record(
    "session-resumes-on-the-stored-base",
    (await readStoredServer()) === BASE
  );

  // ---- 7) offline state ---------------------------------------------------
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await context.setOffline(true);
  await page.waitForSelector('[data-testid="connect-offline"]', { timeout: 5000 });
  const submitDisabled = await page.isDisabled('[data-testid="login-submit"]');
  record("offline-banner-and-disabled-submit", submitDisabled);
  await context.setOffline(false);
  await page.waitForSelector('[data-testid="connect-offline"]', {
    state: "detached",
    timeout: 5000,
  });
  record("offline-banner-clears-on-reconnect", true);

  result = { ...result, steps, pageErrors, pass: pageErrors.length === 0 };
} catch (error) {
  result = { ...result, steps, pageErrors, pass: false, error: String(error) };
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
