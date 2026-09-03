import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertQrModulePitch, qrModulePitch } from "./qrModulePitch";

const TOKENS = readFileSync("src/design/tokens.css", "utf8");

function tokenPx(name: string): number {
  const match = TOKENS.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  if (!match) throw new Error(`tokens.css에 --${name} 이 없다`);
  return Number(match[1]);
}

describe("qr module pitch (H-1)", () => {
  it("throws on empty geometry so jsdom cannot fake a pass", () => {
    expect(() => qrModulePitch(0, 57)).toThrow(/empty geometry/);
    expect(() => qrModulePitch(Number.NaN, 57)).toThrow(/empty geometry/);
  });

  it("a fixed 192px square misses the named floor at version 8", () => {
    const floor = tokenPx("spacing-qr-module");
    expect(floor).toBe(4);
    expect(() => assertQrModulePitch(192, 57, floor, "fixed-square")).toThrow(
      /< floor/
    );
  });

  it("content box of modules × floor meets the floor", () => {
    const floor = tokenPx("spacing-qr-module");
    expect(assertQrModulePitch(53 * floor, 53, floor)).toBe(floor);
    expect(assertQrModulePitch(57 * floor, 57, floor)).toBe(floor);
  });
});
