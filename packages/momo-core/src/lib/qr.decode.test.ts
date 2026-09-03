import { describe, expect, it } from "vitest";
import {
  encodeQr,
  qrRsDivisor,
  qrRsRemainder,
  selectQrVersion,
} from "./qr";

// Independent of qr.ts internals: ISO tables, BCH format, zigzag, GF(256) RS.
// If the encoder's helpers were imported here, a matching bug would stay green.

const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
  733,
];
const ECC_M_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28,
];
const ECC_M_BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10,
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function refRsDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i += 1) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function refRsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

/** The B1 rsDivisor: degree+1 coefficients, poly[0] ≠ 1. */
function buggyRsDivisor(degree: number): number[] {
  const poly = [1];
  for (let i = 0, root = 1; i < degree; i += 1, root = gfMul(root, 2)) {
    poly.push(0);
    for (let j = poly.length - 1; j > 0; j -= 1) {
      poly[j] = gfMul(poly[j - 1], root) ^ poly[j];
    }
    poly[0] = gfMul(poly[0], root);
  }
  return poly;
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function fixtureToken(): string {
  return ["ABCDEFGHIJKLMNOPQRSTUV", "WXYZabcdefghijklmnopq"].join("");
}

function byteModeDataCodewords(payload: string, version: number): number[] {
  const data = new TextEncoder().encode(payload);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, version <= 9 ? 8 : 16);
  for (const byte of data) push(byte, 8);
  const dataCw =
    TOTAL_CODEWORDS[version] - ECC_M_PER_BLOCK[version] * ECC_M_BLOCKS[version];
  const capacity = dataCw * 8;
  const term = Math.min(4, capacity - bits.length);
  for (let i = 0; i < term; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < capacity) {
    push(pads[pad], 8);
    pad ^= 1;
  }
  const words: number[] = [];
  for (let i = 0; i < capacity; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    words.push(value);
  }
  return words;
}

/** ECC M format strings, MSB first. Mask 2 is the Apple-verified vector. */
const FORMAT_M_MSB = [
  "101010000010010",
  "101000100100101",
  "101111001111100",
  "101101101001011",
  "100010111111001",
  "100000011001110",
  "100111110010111",
  "100101010100000",
] as const;

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function isFunctionModule(row: number, col: number, size: number, version: number): boolean {
  const inFinder = (r: number, c: number) =>
    r >= -1 && r <= 7 && c >= -1 && c <= 7;
  if (inFinder(row, col) || inFinder(row, col - (size - 7)) || inFinder(row - (size - 7), col)) {
    return true;
  }
  if (row === 6 || col === 6) return true;
  if (row === 8 || col === 8) {
    if (row === 8 && (col <= 8 || col >= size - 8)) return true;
    if (col === 8 && (row <= 8 || row >= size - 8)) return true;
  }
  if (row === 4 * version + 9 && col === 8) return true;
  if (version >= 7) {
    if (row < 6 && col >= size - 11 && col < size - 8) return true;
    if (col < 6 && row >= size - 11 && row < size - 8) return true;
  }
  const centers: Record<number, readonly number[]> = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
  };
  const pos = centers[version] ?? [];
  for (const ar of pos) {
    for (const ac of pos) {
      if (ar <= 6 && ac <= 6) continue;
      if (ar <= 6 && ac >= size - 7) continue;
      if (ar >= size - 7 && ac <= 6) continue;
      if (Math.abs(row - ar) <= 2 && Math.abs(col - ac) <= 2) return true;
    }
  }
  return false;
}

function readFormatMsb(modules: boolean[][]): string {
  const size = modules.length;
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

function readFormatLsbFirst(modules: boolean[][]): string {
  return [...readFormatMsb(modules)].reverse().join("");
}

function extractCodewords(modules: boolean[][], version: number, mask: number): number[] {
  const size = modules.length;
  const bits: number[] = [];
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunctionModule(row, col, size, version)) continue;
        let dark = modules[row][col];
        if (maskBit(mask, row, col)) dark = !dark;
        bits.push(dark ? 1 : 0);
      }
    }
  }
  const total = TOTAL_CODEWORDS[version];
  const words: number[] = [];
  for (let i = 0; i < total; i += 1) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i * 8 + j] ?? 0);
    words.push(value);
  }
  return words;
}

function deinterleave(
  words: readonly number[],
  version: number
): { data: number[]; ecc: number[] }[] {
  const blockCount = ECC_M_BLOCKS[version];
  const ecCount = ECC_M_PER_BLOCK[version];
  const totalData = TOTAL_CODEWORDS[version] - ecCount * blockCount;
  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;
  const shortCount = blockCount - longCount;
  const lengths = Array.from({ length: blockCount }, (_, i) =>
    i < shortCount ? shortLength : shortLength + 1
  );
  const blocks = lengths.map((length) => ({
    data: Array<number>(length).fill(0),
    ecc: Array<number>(ecCount).fill(0),
  }));
  let offset = 0;
  const maxData = Math.max(...lengths);
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      if (i < blocks[b].data.length) {
        blocks[b].data[i] = words[offset];
        offset += 1;
      }
    }
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      blocks[b].ecc[i] = words[offset];
      offset += 1;
    }
  }
  return blocks;
}

function decodePayload(payload: string): {
  version: number;
  mask: number;
  format: string;
} {
  const matrix = encodeQr(payload);
  const format = readFormatMsb(matrix.modules);
  const mask = FORMAT_M_MSB.indexOf(format as (typeof FORMAT_M_MSB)[number]);
  expect(mask, `format ${format}`).toBeGreaterThanOrEqual(0);
  const copy2Bits: number[] = [];
  const size = matrix.size;
  for (let i = 0; i < 8; i += 1) {
    copy2Bits.push(matrix.modules[8][size - 1 - i] ? 1 : 0);
  }
  for (let i = 8; i < 15; i += 1) {
    copy2Bits.push(matrix.modules[size - 15 + i][8] ? 1 : 0);
  }
  const copy2Msb = [...copy2Bits].reverse().join("");
  expect(copy2Msb).toBe(format);
  const words = extractCodewords(matrix.modules, matrix.version, mask);
  const blocks = deinterleave(words, matrix.version);
  const divisor = refRsDivisor(ECC_M_PER_BLOCK[matrix.version]);
  for (const block of blocks) {
    expect(hex(refRsRemainder(block.data, divisor))).toBe(hex(block.ecc));
  }
  const dataBytes = blocks.flatMap((block) => block.data);
  const bits: number[] = [];
  for (const word of dataBytes) {
    for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1);
  }
  expect(bits.slice(0, 4).join("")).toBe("0100");
  const countBits = matrix.version <= 9 ? 8 : 16;
  let count = 0;
  for (let i = 0; i < countBits; i += 1) count = (count << 1) | bits[4 + i];
  const raw = new TextEncoder().encode(payload);
  expect(count).toBe(raw.length);
  const recovered = raw.map((_, i) => {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | bits[4 + countBits + i * 8 + j];
    }
    return value;
  });
  expect(Array.from(recovered)).toEqual(Array.from(raw));
  return { version: matrix.version, mask, format };
}

describe("QR golden vectors and independent decode (B1 / M8)", () => {
  it("matches the Apple-verified RS divisor and remainder for oort at v1 M", () => {
    expect(hex(qrRsDivisor(10))).toBe("d8 c2 9f 6f c7 5e 5f 71 9d c1");
    const data = byteModeDataCodewords("oort", 1);
    expect(hex(qrRsRemainder(data, qrRsDivisor(10)))).toBe(
      "17 d8 df de bd df a8 9d 2c 28"
    );
  });

  it("the previous divisor polynomial misses the golden vector", () => {
    expect(hex(buggyRsDivisor(10))).not.toBe("d8 c2 9f 6f c7 5e 5f 71 9d c1");
    expect(buggyRsDivisor(10)).toHaveLength(11);
    expect(buggyRsDivisor(10)[0]).not.toBe(0xd8);
  });

  it("the reversed format order misses the published M/mask table", () => {
    const { modules } = encodeQr("oort");
    const msb = readFormatMsb(modules);
    const lsb = readFormatLsbFirst(modules);
    expect(FORMAT_M_MSB.includes(msb as (typeof FORMAT_M_MSB)[number])).toBe(
      true
    );
    expect(msb).not.toBe(lsb);
    expect(FORMAT_M_MSB.includes(lsb as (typeof FORMAT_M_MSB)[number])).toBe(
      false
    );
  });

  it("round-trips a short payload through an independent decoder", () => {
    const result = decodePayload("oort");
    expect(result.version).toBe(1);
    expect(result.format).toBe(FORMAT_M_MSB[result.mask]);
  });

  it("round-trips a Railway-length device-link payload at version 7", () => {
    const token = fixtureToken();
    const payload = `oort://link?server=https%3A%2F%2Foort-production-1a2b.up.railway.app&token=${token}`;
    expect(selectQrVersion(new TextEncoder().encode(payload).length)).toBe(7);
    const result = decodePayload(payload);
    expect(result.version).toBe(7);
  });

  it("round-trips a long self-host device-link payload at version 8", () => {
    const token = fixtureToken();
    const origin =
      "https://self-hosted-oort.internal.yeomyeonggeori.example.com:8443";
    const encodedOrigin = origin.replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
      return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    });
    const payload = `oort://link?server=${encodedOrigin}&token=${token}`;
    expect(selectQrVersion(new TextEncoder().encode(payload).length)).toBe(8);
    const result = decodePayload(payload);
    expect(result.version).toBe(8);
  });
});
