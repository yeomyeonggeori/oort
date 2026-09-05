// Walk the BZ-6a connect shell from whatever step is showing to S2 (account).
//
// First paint is S0 (landing) when no server is stored and no invite is
// prefilled. A stored `momo.web.server.v1` or a `?code=` / `?join=` prefill
// skips S0 and opens S1 (gateway). Email / password / login-submit live on S2.
// Lanes that still wait for login-submit as the first paint hang on S0.
//
// Capture of S0 itself must happen BEFORE calling this. Reduced-motion capture
// contexts skip the mask-reveal, so the gateway card is visible immediately.

export const ONBOARDING_SURFACE =
  '[data-testid="onboarding-landing"], [data-testid="onboarding-gateway"], [data-testid="onboarding-account"], [data-testid="onboarding-profile"]';

/**
 * @param {import("playwright").Page} page
 * @param {{ path?: "server" | "invite"; timeout?: number }} [options]
 */
export async function advanceToAccount(page, options = {}) {
  const path = options.path === "invite" ? "invite" : "server";
  const timeout = options.timeout ?? 20_000;

  await page.locator(ONBOARDING_SURFACE).first().waitFor({
    state: "visible",
    timeout,
  });

  const landing = page.getByTestId("onboarding-landing");
  if (await landing.isVisible()) {
    const choice =
      path === "invite"
        ? "onboarding-choose-invite"
        : "onboarding-choose-server";
    await page.getByTestId(choice).click();
    await page.getByTestId("onboarding-gateway").waitFor({
      state: "visible",
      timeout,
    });
  }

  const account = page.getByTestId("onboarding-account");
  if (await account.isVisible()) return;

  await page.getByTestId("onboarding-next").click();
  await account.waitFor({ state: "visible", timeout });
}

/**
 * @param {import("playwright").Page} page
 * @param {{ email: string; password: string; path?: "server" | "invite"; timeout?: number }} creds
 */
export async function signInThroughOnboarding(page, creds) {
  await advanceToAccount(page, creds);
  await page.getByTestId("login-email").fill(creds.email);
  await page.getByTestId("login-password").fill(creds.password);
  await page.getByTestId("login-submit").click();
}

/**
 * Join that created a member lands on S3. Sign-in and rejoin do not.
 * Lanes that submit a join wait for `onboarding-profile` then call this;
 * a sign-in lane that is already past S2 sees nothing and returns.
 *
 * @param {import("playwright").Page} page
 */
export async function skipProfileIfPresent(page) {
  const profile = page.getByTestId("onboarding-profile");
  if (!(await profile.isVisible())) return;
  await page.getByTestId("onboarding-profile-skip").click();
  await profile.waitFor({ state: "hidden" });
}
