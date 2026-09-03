export const PHONE_LINK_FIRST_RUN_KEY = "momo.web.phoneLinkFirstRun.v1";

export function markPhoneLinkFirstRunPending(): void {
  try {
    sessionStorage.setItem(PHONE_LINK_FIRST_RUN_KEY, "pending");
  } catch {
    // Private mode can refuse sessionStorage; the card then does not appear.
  }
}

export function phoneLinkFirstRunIsPending(): boolean {
  try {
    return sessionStorage.getItem(PHONE_LINK_FIRST_RUN_KEY) === "pending";
  } catch {
    return false;
  }
}

export function dismissPhoneLinkFirstRun(): void {
  try {
    sessionStorage.setItem(PHONE_LINK_FIRST_RUN_KEY, "done");
  } catch {
    // same as mark
  }
}
