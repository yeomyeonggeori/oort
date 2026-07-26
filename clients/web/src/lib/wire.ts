// =============================================================================
// Small, total helpers for values that crossed the HTTP boundary.
//
// TypeScript annotations describe the client we hoped the server sent. These
// helpers describe what actually arrived. They never throw: a caller can turn
// a failed shape into its own empty/error state without risking a render throw.
// =============================================================================

export type WireRecord = Record<string, unknown>;

export function record(value: unknown): WireRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as WireRecord
    : null;
}

export function str(source: unknown, key: string): string | undefined {
  const value = record(source)?.[key];
  return typeof value === "string" ? value : undefined;
}

export function num(source: unknown, key: string): number | undefined {
  const value = record(source)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bool(source: unknown, key: string): boolean | undefined {
  const value = record(source)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function arrayField<T = unknown>(source: unknown, key: string): T[] | null {
  const value = record(source)?.[key];
  return Array.isArray(value) ? value as T[] : null;
}

/** A failed response shape is an unavailable response, not usable query data. */
export class WireShapeError extends Error {
  constructor() {
    super("서버 응답을 읽지 못했습니다. 다시 시도하세요.");
    this.name = "WireShapeError";
  }
}

/** The transport funnels reject only non-record JSON; field parsers stay total. */
export function responseRecord(value: unknown): WireRecord {
  const parsed = record(value);
  if (parsed === null) throw new WireShapeError();
  return parsed;
}
