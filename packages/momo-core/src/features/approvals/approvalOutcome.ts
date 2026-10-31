import copy from "./settlement-copy.json";
import expressionFailures from "./expression-failure-copy.json";

/**
 * ADR-0186 v6 R-d: code is authoritative; body remains the legacy fallback.
 *
 * Two golden files feed this one lookup. `settlement-copy.json` is the four terminal
 * approval statuses the server mirrors row by row. `expression-failure-copy.json` is the
 * six generation and assembly failures of ADR-0218 section 7 G3.8, kept in its own file
 * because the server's mirror test walks every row of the first one by `status`.
 */
export function approvalOutcomeLine(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return copy.find((entry) => entry.code === code)?.line ?? expressionFailureLine(code);
}

/**
 * ADR-0218 section 7 G3.8: the one Korean sentence for a generation or assembly failure,
 * or null for any other code (including `assembly_params_invalid`, which is a call error
 * and never a card). The server writes this same sentence into the card `body`.
 */
export function expressionFailureLine(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return expressionFailures.find((entry) => entry.code === code)?.line ?? null;
}
