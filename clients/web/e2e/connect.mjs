// CONNECT (MOMO-604, ADR-0133 P2): server selection, deep-link prefill and the
// dynamic API base, driven in a real browser against a live momowebqa.
//
// What each step proves, and why it is done this way:
//
//   deep-link fallback   A browser has no `momo://` scheme, so the invite
//                        parameters ride the page URL. The run opens a wrapped
//                        `?join=momo://join?server=...&code=...`, asserts both
//                        fields are prefilled and the invite code is GONE from
//                        the address bar afterwards (it is a bearer secret).
//   validation           `ws://...` is rejected inline, at the field, and no
//                        request leaves the page.
//   dynamic base         Two halves. First a base that cannot answer
//                        (127.0.0.1:1) makes login fail with the network copy,
//                        which is only possible if requests stopped being
//                        same-origin. Then the preview origin is entered
//                        explicitly and the same login succeeds, is stored, and
//                        survives a reload.
//   browser silence      The discovery card must not exist off the desktop
//                        shell (no mDNS in a web page).
//   offline              The banner appears and the submit is disabled.
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
  const deepLink = `momo://join?server=${encodeURIComponent(
    BASE
  )}&code=not-a-real-invite-code`;
  await page.goto(`${BASE}/?join=${encodeURIComponent(deepLink)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-testid="login-server"]', { timeout: 20000 });

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

  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? "none"
  );
  record(
    "deeplink-focus-lands-on-first-missing-field",
    focused === "login-email",
    `focused=${focused}`
  );

  const urlAfterPrefill = page.url();
  record(
    "deeplink-code-stripped-from-history",
    !urlAfterPrefill.includes("not-a-real-invite-code") &&
      !urlAfterPrefill.includes("join="),
    urlAfterPrefill
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
  let requestsDuringValidation = 0;
  const countV1 = (request) => {
    if (request.url().includes("/v1/")) requestsDuringValidation += 1;
  };
  page.on("request", countV1);
  await page.fill('[data-testid="login-server"]', "ws://momo.example.com");
  await page.fill('[data-testid="login-email"]', email);
  await page.fill('[data-testid="login-password"]', password);
  await page.click('[data-testid="login-submit"]');
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
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 20000 });
  record(
    "bare-host-read-as-https",
    (await readStoredServer()) === "https://127.0.0.1:1",
    `stored=${await readStoredServer()}`
  );

  // ---- 5) the base is really dynamic: an unreachable one must fail --------
  await page.fill('[data-testid="login-server"]', "http://127.0.0.1:1");
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="login-error"]', { timeout: 20000 });
  const deadBaseError = await page.textContent('[data-testid="login-error"]');
  record(
    "requests-follow-the-chosen-base",
    (deadBaseError ?? "").includes("서버에 연결하지 못했습니다"),
    `error=${deadBaseError}`
  );
  record(
    "chosen-base-is-stored",
    (await readStoredServer()) === "http://127.0.0.1:1",
    `stored=${await readStoredServer()}`
  );

  // ---- 6) an explicit, reachable base logs in and survives a reload -------
  await page.fill('[data-testid="login-server"]', `${BASE}/`);
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
  await page.waitForSelector('[data-testid="login-submit"]', { timeout: 20000 });
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
