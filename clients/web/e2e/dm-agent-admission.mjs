// S1 stack validation; authored by #4792, never run by the individual worker.
// Requires a fresh local fixture: two humans in MOMO_DM_CHANNEL_ID, a callable
// unseated MOMO_DM_AGENT_HANDLE, no other pending cards in that DM.
// Credentials stay in env. Repeat with MOMO_COLOR_SCHEME=dark and
// MOMO_REDUCED_MOTION=reduce. Large text is a separate stack inspection.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { advanceToAccount } from "./advanceOnboarding.mjs";

const base = process.env.MOMO_WEB_BASE ?? "http://127.0.0.1:5173";
assert(
  ["127.0.0.1", "localhost"].includes(new URL(base).hostname),
  "use the isolated local stack"
);
const required = (key) => {
  const value = process.env[key];
  assert(value, `${key} is required`);
  return value;
};
const channelId = required("MOMO_DM_CHANNEL_ID").toLowerCase();
assert(/^[0-9a-f-]{36}$/.test(channelId), "fixture channel must be a UUID");
const handle = required("MOMO_DM_AGENT_HANDLE");
assert(/^[A-Za-z0-9_.-]+$/.test(handle), "fixture agent handle required");
const requester = {
  email: required("MOMO_DM_REQUESTER_EMAIL"),
  password: required("MOMO_DM_REQUESTER_PASSWORD"),
};
const peer = {
  email: required("MOMO_DM_PEER_EMAIL"),
  password: required("MOMO_DM_PEER_PASSWORD"),
};
const browser = await chromium.launch({ headless: true });
const contexts = [];
async function openDm(page) {
  await page
    .locator(`[data-sidebar-row][data-channel-id="${channelId}"]`)
    .first()
    .click();
  await page.getByTestId("composer-input").waitFor();
}
async function signIn(credentials) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: process.env.MOMO_COLOR_SCHEME ?? "light",
    reducedMotion: process.env.MOMO_REDUCED_MOTION ?? "no-preference",
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(base);
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill(credentials.email);
  await page.getByTestId("login-password").fill(credentials.password);
  if (process.env.MOMO_WORKSPACE) {
    await page.getByTestId("login-workspace-toggle").click();
    await page.getByTestId("login-workspace").fill(process.env.MOMO_WORKSPACE);
  }
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor();
  await openDm(page);
  return page;
}
try {
  const callerPage = await signIn(requester);
  const peerPage = await signIn(peer);
  await callerPage
    .getByTestId("composer-input")
    .fill(`@${handle} fixture request`);
  const hint = callerPage.getByTestId("composer-dm-hint");
  await hint.waitFor();
  assert.match(await hint.textContent(), /허락하면.*이 대화에 들어와요/);
  assert.match(await hint.textContent(), /이후 대화를 봐요/);
  await callerPage.getByTestId("composer-send").click();
  const card = (page) =>
    page
      .locator('[data-testid="agent-card"][data-card-kind="approval"]')
      .filter({ hasText: "에이전트 들이기" })
      .last();
  await card(peerPage).waitFor();
  assert.equal(
    await card(callerPage).locator('[data-decision="approve"]').count(),
    0,
    "inviter cannot decide for the peer"
  );
  await card(peerPage).locator('[data-decision="approve"]').click();
  await peerPage
    .getByText(/들어왔어요 · 이후 대화를 봐요/)
    .last()
    .waitFor();
  await peerPage.locator("header").filter({ hasText: /3명/ }).first().waitFor();
  await peerPage.getByTestId("dm-agent-menu").click();
  await peerPage
    .getByRole("menuitem", { name: /내보내기/ })
    .first()
    .click();
  await peerPage
    .getByText(/내보냈어요 · 이제 이 대화를 보지 못해요/)
    .last()
    .waitFor();
  await peerPage.getByTestId("dm-agent-menu").waitFor({ state: "detached" });
  console.log(
    "PASS: consent hint, exact human controls, group header, participant removal"
  );
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
