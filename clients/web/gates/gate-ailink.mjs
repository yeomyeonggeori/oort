#!/usr/bin/env node
// GATE — AI 연결 OAuth 등록 (U3 / #1047, ADR-0147).
//
// Two properties, both of which the unit tests can only assert about a function
// and this gate asserts about the SHIPPED BUNDLE driven by a real pointer:
//
//   ① The PUT this panel sends for the OAuth method carries an `oauth` object
//      and no `bearer` key, and every key in it is one the server declares.
//      `PutProviderLinkRequest`/`PutProviderOAuthRequest` are
//      `#[serde(deny_unknown_fields)]`, so a stray key is a 400 and not a
//      tolerated extra — which makes "what exactly went on the wire" the thing
//      worth measuring, rather than "did the call happen".
//   ② No credential from the pasted document is anywhere in the DOM — not in
//      text, not in an input value, not in an attribute — across the WHOLE form
//      session: the moment after the paste is read, while the account label is
//      being typed, at submit, and after the save. ADR-0004 Rules #2/#5 held by
//      construction while the bearer was the only credential and this panel had
//      no box that ever contained one; a paste box holds an entire auth.json in
//      component state, so the rule now needs a measurement instead of an
//      argument.
//
//      The pre-save half of that window is the half a design review found
//      unmeasured (H1): the gate used to look only after the save had landed,
//      which is precisely the window in which the raw document was legible.
//
// The server is stubbed at the route layer, so this touches no live instance
// and needs no local stack. That is deliberate: the assertions are about the
// REQUEST this client composes and the SCREEN it draws, and both are fully
// determined by the bundle.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.AILINK_GATE_PORT || 5186);
const origin = `http://127.0.0.1:${port}`;
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: `ws://127.0.0.1:${port + 900}/connection/websocket`,
};

// Invented for this gate. Every one of these strings is a value the screen must
// never show and the wire must never carry twice.
const REFRESH_TOKEN = "gate-refresh-token-not-a-credential";
const ACCESS_TOKEN = "gate-access-token-not-a-credential";
const ID_TOKEN = "gate-id-token-not-a-credential";
const ACCOUNT_ID = "acct-01996f2a-7c3d-4f11-9a20-3d6f0c9b41ee";
const ACCOUNT_LABEL = "성재 개인 ChatGPT 구독";
const BASE_URL = "https://chatgpt.com/backend-api/codex";
// A tenant that is NOT the default. The old H3 assertion round-tripped an
// address that happened to equal the suggestion, which is the one case where
// losing it is invisible — so it never measured whether the operator's own
// value survives. That gap is exactly what a review found by hand.
const CUSTOM_BASE_URL = "https://codex.acme-internal.test/backend-api/codex";

// The measured key structure of `~/.codex/auth.json`
// (server-rust/crates/momo-settings/src/oauth.rs), values invented.
const AUTH_JSON = JSON.stringify(
  {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      id_token: ID_TOKEN,
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      account_id: ACCOUNT_ID,
    },
    last_refresh: "2026-08-04T11:20:03.914Z",
  },
  null,
  2
);

/** Every key `PutProviderLinkRequest` declares. Anything else is a 400. */
const PUT_LINK_KEYS = ["baseUrl", "bearer", "mode", "oauth"];
/** Every key `PutProviderOAuthRequest` declares. Anything else is a 400. */
const PUT_OAUTH_KEYS = [
  "refreshToken",
  "accessToken",
  "expiresAtMs",
  "accountId",
  "accountLabel",
  "clientId",
  "tokenEndpoint",
];

const unconfiguredLink = {
  schema: "momo.provider_link.v0",
  configured: false,
  source: "environment",
  mode: "external-hermes",
  baseUrl: "http://127.0.0.1:28080/mock",
  endpointLabel: "127.0.0.1:28080/mock",
  bearerConfigured: false,
  availability: "mock",
  keyConfigured: false,
  diagnostics: [],
};

// What the server answers once an ADR-0147 grant is sealed. Field for field the
// `ProviderLinkResponse` projection, including the two additive keys.
const oauthLink = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: BASE_URL,
  endpointLabel: "chatgpt.com/backend-api/codex",
  bearerConfigured: true,
  bearerLast4: "ntial",
  availability: "available",
  keyConfigured: true,
  updatedAtMs: 1_785_000_000_000,
  updatedBy: memberId,
  diagnostics: [],
  credentialKind: "oauth-openai",
  credentialMeta: {
    attribution: "personal-subscription",
    usageScope: "internal-only",
    accountLabel: ACCOUNT_LABEL,
    notice:
      "개인 계정 귀속 · 내부용. 이 연결은 특정 구성원의 개인 ChatGPT 구독으로 동작하며, 사용량은 그 사람의 구독 한도를 씁니다. 제품 기본 경로는 API 키입니다.",
    accessTokenPresent: true,
    accessTokenExpiresAtMs: 1_785_003_600_000,
  },
};

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }
    // Load-bearing, and not obvious: a getToken REJECTION is what centrifuge-js
    // treats as unrecoverable, so a stubbed-out token endpoint puts the shell
    // into `disconnected` and every settings write control disables itself as
    // offline. Answering a token lets the socket fail the ordinary way instead
    // (`connecting`, retrying), which is the state a gate wants — online panel,
    // no live realtime.
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "gate-only-not-a-credential" });
    }
    if (path === "/v1/provider/link") {
      if (request.method() === "PUT") {
        state.putBodies.push(request.postData());
        state.linkBody = oauthLink;
        return json(route, oauthLink);
      }
      return json(route, state.linkBody);
    }
    if (path === "/v1/provider/link/chain") {
      return json(route, {
        schema: "momo.provider_link.chain.v0",
        entries: [],
        fallbackCount: 0,
      });
    }
    if (path.endsWith("/channels")) return json(route, { channels: [] });
    if (path.endsWith("/roster")) return json(route, { members: [] });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.includes("/messages")) return json(route, { messages: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    return json(route, {});
  });
}

function fail(message) {
  throw new Error(message);
}

/**
 * Everything a person or a script could read off the page: rendered text plus
 * every form value and every attribute. A credential hiding in a `value=` is
 * exposed exactly as badly as one printed in a paragraph.
 */
async function pageExposure(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText ?? ""];
    for (const el of document.querySelectorAll("input, textarea")) {
      parts.push(el.value ?? "");
    }
    for (const el of document.querySelectorAll("*")) {
      for (const attr of el.attributes) parts.push(attr.value);
    }
    return parts.join("\n");
  });
}

async function assertNoCredentialOnScreen(page, when) {
  const exposure = await pageExposure(page);
  for (const [name, secret] of [
    ["refresh token", REFRESH_TOKEN],
    ["access token", ACCESS_TOKEN],
    ["id token", ID_TOKEN],
  ]) {
    if (exposure.includes(secret)) {
      fail(`${when}: the ${name} is readable on the page (ADR-0004 #2/#5)`);
    }
  }
  // The account id is not itself a token, but the server's own projection
  // declines to send it back. A client that displayed what the server withheld
  // would widen the disclosure boundary from the outside.
  if (exposure.includes(ACCOUNT_ID)) {
    fail(`${when}: the account id is on screen, which the server itself withholds`);
  }
}

function assertPutShape(raw) {
  if (!raw) fail("the panel sent a PUT with no body");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    fail(`the PUT body was not JSON: ${raw.slice(0, 120)}`);
  }

  if (!body.oauth || typeof body.oauth !== "object") {
    fail(
      `the PUT carried no oauth object, so this panel still cannot register a ` +
        `grant: keys were ${JSON.stringify(Object.keys(body))}`
    );
  }
  if ("bearer" in body) {
    fail(
      `the PUT names a bearer alongside the grant. The server refuses that pair ` +
        `outright ("send either bearer or oauth, not both"), and an empty string ` +
        `here is a body saying two things at once.`
    );
  }
  if (body.oauth.refreshToken !== REFRESH_TOKEN) {
    fail("the PUT did not carry the refresh token from the pasted document");
  }
  if (body.oauth.accessToken !== ACCESS_TOKEN) {
    fail("the PUT dropped the access token the pasted document supplied");
  }
  if (body.oauth.accountId !== ACCOUNT_ID) {
    fail("the PUT dropped the account id the pasted document supplied");
  }
  if (body.oauth.accountLabel !== ACCOUNT_LABEL) {
    fail("the PUT dropped the ADR-0147 attribution label the operator typed");
  }
  if (body.baseUrl !== BASE_URL) fail(`the PUT pointed at ${body.baseUrl}`);
  if (body.mode !== "external-hermes") {
    fail(`an OAuth link must be external-hermes, not ${body.mode}`);
  }

  // deny_unknown_fields coexistence, measured against dto.rs.
  for (const key of Object.keys(body)) {
    if (!PUT_LINK_KEYS.includes(key)) {
      fail(`the PUT carries \`${key}\`, which PutProviderLinkRequest rejects with a 400`);
    }
  }
  for (const key of Object.keys(body.oauth)) {
    if (!PUT_OAUTH_KEYS.includes(key)) {
      fail(
        `oauth.${key} is not a PutProviderOAuthRequest field, so this body is a 400 ` +
          `(id_token in particular is refused by name)`
      );
    }
  }
  if (raw.includes(ID_TOKEN)) {
    fail("the PUT forwarded id_token, which the server refuses and momo must not hold");
  }
}

async function openAiLinkForm(page) {
  await page.getByTestId("profile-card").click();
  await page.getByTestId("profile-card-menu").waitFor({ state: "visible" });
  await page.getByTestId("nav-settings").click();
  await page.waitForSelector('[data-testid="settings-route"]');
  await page.getByRole("button", { name: "AI 연결", exact: true }).click();
  await page.waitForSelector('[data-testid="ai-link-empty"]');
  await page.getByRole("button", { name: "provider 연결하기", exact: true }).click();
  await page.waitForSelector('[data-testid="ai-link-form"]');
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const state = { putBodies: [], linkBody: unconfiguredLink };
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "AILINK_GATE_PORT",
  });
  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      });
      await installRoutes(context, state);
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      await advanceToAccount(page);
      await page.getByTestId("login-email").fill("ailink@example.test");
      await page.getByTestId("login-password").fill("not-a-secret");
      await page.getByTestId("login-submit").click();
      await page.waitForSelector("nav[aria-label='워크스페이스 탐색']");

      await openAiLinkForm(page);

      // The method chooser has to exist before anything else is provable: with
      // only a key form on screen there is no OAuth path to measure, which is
      // precisely the pre-U3 state that forced a browser console snippet.
      const oauthRadio = page.locator("#provider-method-oauth");
      if ((await oauthRadio.count()) === 0) {
        fail("the AI 연결 form offers no OAuth registration method");
      }
      await oauthRadio.check();

      await page.getByTestId("ai-link-oauth-paste").fill(AUTH_JSON);

      // Reading the file back to the operator is the whole point of the preview,
      // and it must do it without quoting a single token.
      await page.waitForSelector('[data-testid="ai-link-oauth-preview"]');
      const preview = await page.getByTestId("ai-link-oauth-preview").innerText();
      for (const secret of [REFRESH_TOKEN, ACCESS_TOKEN, ID_TOKEN, ACCOUNT_ID]) {
        if (preview.includes(secret)) {
          fail("the parsed-document preview quotes a credential back at the screen");
        }
      }

      // ---- ② pre-save window ------------------------------------------------
      // The raw document must be off the screen the instant it has been read.
      // Everything after this point (typing the label, reaching the button) is
      // exposure time the operator did not choose.
      if ((await page.getByTestId("ai-link-oauth-paste").count()) !== 0) {
        fail(
          "the auth.json textarea is still on screen after a successful parse, so " +
            "the refresh token stays legible for the rest of the form session"
        );
      }
      await assertNoCredentialOnScreen(page, "right after the paste was read");

      // The control the operator was typing into just left the DOM. If focus is
      // not moved it falls to <body> and the next Tab restarts at the top of the
      // page — a keyboard user loses their place mid-task.
      const focusLanded = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return "body";
        return active.closest('[data-testid="ai-link-oauth-preview"]')
          ? "preview"
          : (active.getAttribute("data-testid") ?? active.tagName);
      });
      if (focusLanded !== "preview") {
        fail(
          `focus fell to ${focusLanded} when the paste box was swapped for the ` +
            `read-back, so a keyboard user is thrown to the top of the page`
        );
      }

      // The read-back is not a dead end: a wrong file has to be replaceable.
      await page.getByTestId("ai-link-oauth-repaste").click();
      await page.waitForSelector('[data-testid="ai-link-oauth-paste"]');
      if ((await page.getByTestId("ai-link-oauth-paste").inputValue()) !== "") {
        fail("다시 붙여넣기 restored the previous document into the box");
      }
      await page.getByTestId("ai-link-oauth-paste").fill(AUTH_JSON);
      await page.waitForSelector('[data-testid="ai-link-oauth-preview"]');

      // The attribution label is required by this form even though the wire
      // allows its absence: ADR-0147 asks every surface to say whose
      // subscription a link spends, and a blank makes that sentence a lie.
      await page.getByRole("button", { name: "연결 저장", exact: true }).click();
      // `Field` binds its message to the control it belongs to, so the error is
      // addressable by that binding rather than by matching prose.
      await page.waitForSelector("#provider-oauth-account-error");
      if (state.putBodies.length !== 0) {
        fail("the panel saved a subscription link with no attribution label");
      }

      await page.getByTestId("ai-link-oauth-label").fill(ACCOUNT_LABEL);
      // Still clean with the form fully populated and one click from submit.
      await assertNoCredentialOnScreen(page, "with the form ready to submit");
      await page.getByRole("button", { name: "연결 저장", exact: true }).click();
      await page.waitForSelector('[data-testid="ai-link-card"]');

      // ---------------------------------------------------------------- ① ---
      if (state.putBodies.length !== 1) {
        fail(`expected exactly one PUT, saw ${state.putBodies.length}`);
      }
      assertPutShape(state.putBodies[0]);

      // ---------------------------------------------------------------- ② ---
      await assertNoCredentialOnScreen(page, "after saving the grant");

      // The status card is the answer to "실패 카드가 첫 신호" — it has to state
      // the registration method, whose account it is, and the ADR-0147 notice.
      const card = await page.getByTestId("ai-link-card").innerText();
      for (const expected of ["ChatGPT 계정 (OAuth)", ACCOUNT_LABEL, "액세스 토큰"]) {
        if (!card.includes(expected)) {
          fail(`the connection card never says ${JSON.stringify(expected)}: ${card}`);
        }
      }
      if ((await page.getByTestId("ai-link-oauth-notice").count()) === 0) {
        fail("the 개인 계정 귀속 notice the server sends is not rendered");
      }

      // --- H4: amber must mean exactly one thing on this card ---------------
      // The attribution notice is a standing policy sentence, not an event. It
      // was drawn identically to the live diagnostics list directly beneath it.
      const noticeWarn = await page
        .getByTestId("ai-link-oauth-notice")
        .evaluate((el) => el.className.includes("text-warn"));
      if (noticeWarn) {
        fail(
          "the standing attribution notice is painted --warn, so it is " +
            "indistinguishable from a diagnostic that just happened"
        );
      }

      // Reopening the form must not repopulate the paste box from anywhere: the
      // document was dropped on save and there is nothing to restore it from.
      await page.getByRole("button", { name: "연결 수정", exact: true }).click();
      await page.waitForSelector('[data-testid="ai-link-form"]');
      const restored = await page.getByTestId("ai-link-oauth-paste").inputValue();
      if (restored !== "") {
        fail("reopening the form restored the pasted auth.json into the textarea");
      }
      await assertNoCredentialOnScreen(page, "after reopening the form");

      // --- H2: the card must not present the past in the present tense ------
      if ((await page.getByTestId("ai-link-card-tense").count()) === 0) {
        fail(
          "the status card stays on screen while the form is open without saying " +
            "that it describes the SAVED link and that saving replaces it"
        );
      }
      const replaceLabel = await page
        .getByRole("button", { name: "연결 교체 저장", exact: true })
        .count();
      if (replaceLabel === 0) {
        fail("editing an existing link offers a save button that never says it replaces one");
      }

      // --- H3: a method SUGGESTS an address; it does not own one ------------
      // First choice of a method offers its default...
      await page.locator("#provider-method-key").check();
      const afterKey = await page.locator("#provider-base-url").inputValue();
      if (afterKey === BASE_URL) {
        fail(
          "switching to the key method kept the ChatGPT grant endpoint, which " +
            "cannot take an API key, as the starting value"
        );
      }
      await page.locator("#provider-method-oauth").check();
      const afterOAuth = await page.locator("#provider-base-url").inputValue();
      if (afterOAuth !== BASE_URL) {
        fail(
          `switching back to OAuth left ${JSON.stringify(afterOAuth)} under a hint ` +
            `that calls the field the address a ChatGPT grant actually reaches`
        );
      }

      // ...and after that the box belongs to whoever typed in it. A round trip
      // through the other radio is a LOOK, not an edit: the button underneath
      // reads "연결 교체 저장", so silently restoring a default here replaces an
      // endpoint the operator never touched.
      await page.locator("#provider-base-url").fill(CUSTOM_BASE_URL);
      await page.locator("#provider-method-key").check();
      const keyAfterCustom = await page.locator("#provider-base-url").inputValue();
      if (keyAfterCustom === CUSTOM_BASE_URL) {
        fail("the key method inherited the OAuth tenant address instead of its own");
      }
      await page.locator("#provider-method-oauth").check();
      const restoredCustom = await page.locator("#provider-base-url").inputValue();
      if (restoredCustom !== CUSTOM_BASE_URL) {
        fail(
          `a radio round trip rewrote a custom tenant address: expected ` +
            `${JSON.stringify(CUSTOM_BASE_URL)}, got ${JSON.stringify(restoredCustom)}. ` +
            `The operator changed nothing and their endpoint would be replaced on save.`
        );
      }

      // The key side must come back too, not blank out.
      await page.locator("#provider-method-key").check();
      await page.locator("#provider-base-url").fill("https://api.openai.com/v1");
      await page.locator("#provider-method-oauth").check();
      await page.locator("#provider-method-key").check();
      const restoredKey = await page.locator("#provider-base-url").inputValue();
      if (restoredKey !== "https://api.openai.com/v1") {
        fail(
          `a radio round trip emptied the key method's address: got ` +
            `${JSON.stringify(restoredKey)}. Submitting now asks for an address ` +
            `the card is still showing as saved.`
        );
      }

      // And the wire agrees with the screen: what survived the round trip is
      // what gets saved.
      await page.locator("#provider-method-oauth").check();
      await page.getByTestId("ai-link-oauth-paste").fill(AUTH_JSON);
      await page.waitForSelector('[data-testid="ai-link-oauth-preview"]');
      await page.getByRole("button", { name: "연결 교체 저장", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="ai-link-form"]') === null,
        undefined,
        { timeout: 10_000 }
      );
      if (state.putBodies.length !== 2) {
        fail(`expected a second PUT after the round trip, saw ${state.putBodies.length}`);
      }
      const replaced = JSON.parse(state.putBodies[1]);
      if (replaced.baseUrl !== CUSTOM_BASE_URL) {
        fail(
          `the replace-save sent ${JSON.stringify(replaced.baseUrl)} for a link the ` +
            `operator had pointed at ${JSON.stringify(CUSTOM_BASE_URL)}`
        );
      }

      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
  console.log("GATE PASS: the OAuth method sends a deny_unknown_fields-clean `oauth` body");
  console.log("           with no bearer key; no pasted credential reaches the DOM at any");
  console.log("           point in the form session; the card states its tense; amber is");
  console.log("           reserved for live state; the address follows the method.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
