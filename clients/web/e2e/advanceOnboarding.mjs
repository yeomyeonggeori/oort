// Walk the onboarding 2.0 connect screens (ADR-0193 D7, #2808·#2809·#2810) from
// whatever is showing to the screen that holds email / password / login-submit.
//
// First paint is D0 (`onboarding-welcome`) when no server is stored and no invite
// is prefilled. A stored `momo.web.server.v1` skips D0 onto D1 (`onboarding-sign-in`);
// a `?code=` / `?join=` prefill skips it onto D1′ (`onboarding-join`). Email,
// password and login-submit live on D1 and D1′ both, so the names below kept their
// old meaning: "account" is whichever of the two asks for them.
//
// On D0 an empty box means "this page's server" in a browser tab, which is what
// every capture and gate lane serves from, so the server path just presses 계속.
// The invite path needs a link to paste (`inviteLink`), because D0 has no code box.
//
// Capture of D0 itself must happen BEFORE calling this. Reduced-motion capture
// contexts skip the mask-reveal, so the next screen is visible immediately.

export const ONBOARDING_SURFACE =
  '[data-testid="onboarding-welcome"], [data-testid="onboarding-sign-in"], [data-testid="onboarding-join"]';

const ACCOUNT_SURFACE =
  '[data-testid="onboarding-sign-in"], [data-testid="onboarding-join"]';

/**
 * @param {import("playwright").Page} page
 * @param {{ path?: "server" | "invite"; inviteLink?: string; timeout?: number }} [options]
 */
export async function advanceToAccount(page, options = {}) {
  const path = options.path === "invite" ? "invite" : "server";
  const timeout = options.timeout ?? 20_000;

  await page.locator(ONBOARDING_SURFACE).first().waitFor({
    state: "visible",
    timeout,
  });

  const welcome = page.getByTestId("onboarding-welcome");
  if (await welcome.isVisible()) {
    if (path === "invite") {
      if (!options.inviteLink) {
        throw new Error("advanceToAccount: the invite path on D0 needs options.inviteLink");
      }
      await page.getByTestId("connect-entry").fill(options.inviteLink);
    }
    await page.getByTestId("connect-entry-submit").click();
  }

  await page.locator(ACCOUNT_SURFACE).first().waitFor({ state: "visible", timeout });
}

/**
 * @param {import("playwright").Page} page
 * @param {{ email: string; password: string; path?: "server" | "invite"; inviteLink?: string; timeout?: number }} creds
 */
export async function signInThroughOnboarding(page, creds) {
  await advanceToAccount(page, creds);
  await page.getByTestId("login-email").fill(creds.email);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
}
