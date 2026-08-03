import { describe, expect, it } from "vitest";
import {
  BOOT_RESTORE_BUDGET_MS,
  SESSION_HYDRATE_BUDGET_MS,
  releaseAfter,
} from "./boot";

// Real timers and real elapsed time on purpose: the claim under test is "the
// screen is released on time", and a fake clock can only prove that a timer was
// scheduled. These are the measurements quoted in the DESK-1 PR.

const elapsed = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};

describe("boot budgets", () => {
  it("releases the boot path even when the work never settles", async () => {
    // The field case: `/v1/auth/refresh` against a host the webview cannot
    // resolve. Before DESK-1 this held the skeleton for 15 000 ms per round
    // trip; the promise here never settles at all, which is the honest upper
    // bound of that.
    const never = new Promise<void>(() => {});
    const took = await elapsed(() => releaseAfter(never, 120));
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(1_000);
  });

  it("does not wait out the budget when the work settles first", async () => {
    const quick = new Promise<void>((resolve) => setTimeout(resolve, 10));
    const took = await elapsed(() => releaseAfter(quick, 5_000));
    expect(took).toBeLessThan(1_000);
  });

  it("treats a rejection as settled rather than as an unhandled rejection", async () => {
    const failed = Promise.reject(new Error("keychain refused"));
    const took = await elapsed(() => releaseAfter(failed, 5_000));
    expect(took).toBeLessThan(1_000);
  });

  it("keeps the shipped budgets inside a person's patience", () => {
    // A budget longer than one REQUEST_TIMEOUT_MS (15 000) would be no budget at
    // all — the request deadline would fire first and the wait would be back.
    expect(BOOT_RESTORE_BUDGET_MS).toBeLessThan(15_000);
    expect(SESSION_HYDRATE_BUDGET_MS).toBeLessThan(15_000);
    expect(BOOT_RESTORE_BUDGET_MS).toBeGreaterThan(0);
    expect(SESSION_HYDRATE_BUDGET_MS).toBeGreaterThan(0);
  });
});
