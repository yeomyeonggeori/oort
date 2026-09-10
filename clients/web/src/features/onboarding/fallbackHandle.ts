// Server `fallback_handle` (momo-settings join.rs), client-side so S1 can
// suggest the same value the join path would mint. Do not use `handleFromEmail`:
// that helper falls back to `oort-user` and does not cap at 32.

import { isValidHandle } from "@momo/core/features/settings/model";
import { SEED_HANDLE, SEED_WORKSPACE_NAME } from "./s1Copy";

function trimHandleEdges(value: string): string {
  return value.replace(/^[-_]+/, "").replace(/[-_]+$/, "");
}

/**
 * Email local-part → handle. Same rules as server `fallback_handle`:
 * keep `[a-z0-9]`, collapse other runs to one `-`, trim edge `-`/`_`,
 * cap at 32, replace with `member` if fewer than 2 characters survive.
 */
export function fallbackHandle(email: string): string {
  const local = (email.split("@")[0] ?? "member").toLowerCase();
  let output = "";
  let previousWasDash = false;
  for (const character of local) {
    if (
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9")
    ) {
      output += character;
      previousWasDash = false;
    } else if (!previousWasDash) {
      output += "-";
      previousWasDash = true;
    }
  }
  let value = trimHandleEdges(output);
  if ([...value].length > 32) {
    value = trimHandleEdges([...value].slice(0, 32).join(""));
  }
  if ([...value].length < 2) {
    value = "member";
  }
  return isValidHandle(value) ? value : "member";
}

export function defaultWorkspaceName(current: string | undefined): string {
  if (!current) return "";
  if (current.trim() === SEED_WORKSPACE_NAME) return "";
  return current;
}

/**
 * S1 suggested handle: derive from the email local part (or a bare handle)
 * with the same `fallback_handle` rule, then blank the seed `demo` the way
 * the workspace-name field blanks the seed workspace name.
 */
export function suggestedHandle(source: string | undefined): string {
  if (!source) return "";
  const derived = fallbackHandle(source);
  if (derived === SEED_HANDLE) return "";
  return derived;
}
