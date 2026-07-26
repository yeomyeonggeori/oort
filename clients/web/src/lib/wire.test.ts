import { describe, expect, it } from "vitest";
import { arrayField, bool, num, record, responseRecord, str, WireShapeError } from "./wire";

describe("wire helpers", () => {
  it("treats null, arrays, and primitives as unavailable records", () => {
    expect(record(null)).toBeNull();
    expect(record([])).toBeNull();
    expect(record("wrong")).toBeNull();
    expect(() => responseRecord(null)).toThrow(WireShapeError);
  });

  it("does not coerce swapped scalar fields", () => {
    const body = { name: 3, count: "3", enabled: "true" };
    expect(str(body, "name")).toBeUndefined();
    expect(num(body, "count")).toBeUndefined();
    expect(bool(body, "enabled")).toBeUndefined();
  });

  it("keeps a missing or non-array collection distinct from an empty collection", () => {
    expect(arrayField({}, "messages")).toBeNull();
    expect(arrayField({ messages: null }, "messages")).toBeNull();
    expect(arrayField({ messages: {} }, "messages")).toBeNull();
    expect(arrayField({ messages: [] }, "messages")).toEqual([]);
  });

  it("reads nested fields without dereferencing a missing parent", () => {
    expect(arrayField(null, "diagnostics")).toBeNull();
    expect(arrayField({ diagnostics: ["server changed"] }, "diagnostics")).toEqual([
      "server changed",
    ]);
  });
});
