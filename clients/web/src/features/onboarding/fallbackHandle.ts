// Server `fallback_handle` (momo-settings join.rs), client-side so S1 can
// suggest the same value the join path would mint. Do not use `handleFromEmail`:
// that helper falls back to `oort-user` and does not cap at 32.

import { SEED_WORKSPACE_NAME } from "./s1Copy";

const HANDLE_PATTERN = /^[a-z0-9_-]+$/;

export function isValidHandle(value: string): boolean {
  const length = [...value].length;
  return length >= 2 && length <= 32 && HANDLE_PATTERN.test(value);
}

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
  if (!current || current === SEED_WORKSPACE_NAME) return "";
  return current;
}

export const HANDLE_FORMAT_SENTENCE =
  "handle must be 2-32 chars of a-z, 0-9, _ or -";

export function handleFieldError(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!isValidHandle(value)) return HANDLE_FORMAT_SENTENCE;
  return null;
}
