import copy from "./settlement-copy.json";

/** ADR-0186 v6 R-d: code is authoritative; body remains the legacy fallback. */
export function approvalOutcomeLine(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return copy.find((entry) => entry.code === code)?.line ?? null;
}
