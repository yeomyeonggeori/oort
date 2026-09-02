import { describe, expect, it } from "vitest";
import {
  encodeQr,
  qrByteCapacity,
  qrModulePath,
  selectQrVersion,
} from "./qr";

const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

function assertFinder(modules: boolean[][], row: number, col: number): void {
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      expect(modules[row + y][col + x]).toBe(Boolean(FINDER[y][x]));
    }
  }
}

describe("qr byte-mode ECC M", () => {
  it("picks a version that fits the payload and stays on the 4n+17 size", () => {
    expect(selectQrVersion(1)).toBe(1);
    expect(selectQrVersion(qrByteCapacity(1))).toBe(1);
    expect(selectQrVersion(qrByteCapacity(1) + 1)).toBe(2);
    const matrix = encodeQr("A");
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(21);
    expect(matrix.modules).toHaveLength(21);
    expect(matrix.modules[0]).toHaveLength(21);
  });

  it("draws the three finder patterns", () => {
    const { modules, size } = encodeQr("oort");
    assertFinder(modules, 0, 0);
    assertFinder(modules, 0, size - 7);
    assertFinder(modules, size - 7, 0);
  });

  it("keeps timing patterns alternating from the finders", () => {
    const { modules, size } = encodeQr("timing-check");
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6][i]).toBe(i % 2 === 0);
      expect(modules[i][6]).toBe(i % 2 === 0);
    }
  });

  it("is deterministic and changes when the payload changes", () => {
    const a = encodeQr("https://team.example.com/a");
    const b = encodeQr("https://team.example.com/a");
    const c = encodeQr("https://team.example.com/b");
    expect(a.modules).toEqual(b.modules);
    expect(a.modules).not.toEqual(c.modules);
  });

  it("fits a device-link deepLink of a long self-host origin at ECC M", () => {
    const origin =
      "https://self-hosted-oort.internal.yeomyeonggeori.example.com:8443";
    const token = ["ABCDEFGHIJKLMNOPQRSTUV", "WXYZabcdefghijklmnopq"].join("");
    const encodedOrigin = origin.replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
      return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    });
    const deepLink = `oort://link?server=${encodedOrigin}&token=${token}`;
    const bytes = new TextEncoder().encode(deepLink).length;
    const version = selectQrVersion(bytes);
    expect(version).toBeLessThanOrEqual(10);
    const matrix = encodeQr(deepLink);
    expect(matrix.version).toBe(version);
    const svg = qrModulePath(matrix.modules);
    expect(svg.d).not.toContain(token);
    expect(svg.d).not.toContain("oort://");
    expect(svg.viewBox).toBe(matrix.size + 8);
  });

  it("encodes every byte value without throwing", () => {
    const raw = Uint8Array.from({ length: 64 }, (_, i) => i);
    const payload = Array.from(raw, (byte) => String.fromCharCode(byte)).join("");
    const matrix = encodeQr(payload);
    expect(matrix.size).toBeGreaterThanOrEqual(21);
  });
});
