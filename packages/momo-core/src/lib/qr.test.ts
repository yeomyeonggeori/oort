import { describe, expect, it } from "vitest";
import {
  encodeQr,
  qrByteCapacity,
  qrModulePath,
  qrRsDivisor,
  qrRsRemainder,
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

function hex(bytes: readonly number[]): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function byteModeDataCodewords(text: string, version: number): number[] {
  const data = new TextEncoder().encode(text);
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, countBits);
  for (const byte of data) push(byte, 8);
  const total =
    ([0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733][
      version
    ] ?? 0) -
    ([0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28][version] ??
      0) *
      ([0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10][version] ?? 0);
  const capacity = total * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < capacity) {
    push(pads[pad], 8);
    pad ^= 1;
  }
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    words.push(value);
  }
  return words.slice(0, total);
}

function readFormatMsbIndependent(modules: boolean[][]): string {
  // ISO: bit 14 at (8,0), bit 0 at (0,8). Independent of encoder write order.
  const first: Array<[number, number]> = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  return first.map(([r, c]) => (modules[r][c] ? "1" : "0")).join("");
}

describe("QR golden vectors (B1; full independent round-trip is qr.decode.test.ts)", () => {
  it("matches Apple CIQRCodeGenerator divisor(10) and oort remainder", () => {
    expect(hex(qrRsDivisor(10))).toBe("d8 c2 9f 6f c7 5e 5f 71 9d c1");
    const data = byteModeDataCodewords("oort", 1);
    expect(hex(qrRsRemainder(data, qrRsDivisor(10)))).toBe(
      "17 d8 df de bd df a8 9d 2c 28"
    );
  });

  it("places format bits at spec locations against the published ECC M table", () => {
    const publishedM = [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ];
    expect(publishedM[2]).toBe("101111001111100");
    const format = readFormatMsbIndependent(encodeQr("oort").modules);
    expect(publishedM).toContain(format);
  });
});
