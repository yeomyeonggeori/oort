// Byte-mode QR encoder, ECC level M, versions 1-16. No dependencies.
// Matrix is modules only (no quiet zone). SVG rendering belongs to the host.

const MAX_VERSION = 16;

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

const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
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

/** Degree-`n` generator polynomial coefficients, lowest power first. Length n. */
export function qrRsDivisor(degree: number): number[] {
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

export function qrRsRemainder(
  data: readonly number[],
  divisor: readonly number[]
): number[] {
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

function remainderBits(version: number): number {
  if (version >= 2 && version <= 6) return 7;
  if (version >= 14 && version <= 20) return 3;
  return 0;
}

function matrixSize(version: number): number {
  return 21 + 4 * (version - 1);
}

function countBitsForVersion(version: number): number {
  return version <= 9 ? 8 : 16;
}

function dataCodewordCount(version: number): number {
  return TOTAL_CODEWORDS[version] - ECC_M_PER_BLOCK[version] * ECC_M_BLOCKS[version];
}

export function qrByteCapacity(version: number): number {
  const capacityBits = dataCodewordCount(version) * 8;
  const header = 4 + countBitsForVersion(version);
  return Math.floor((capacityBits - header) / 8);
}

export function selectQrVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteLength <= qrByteCapacity(version)) return version;
  }
  throw new Error("QR payload is too long for versions 1-16 at ECC M.");
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function encodeDataBits(data: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, data.length, countBitsForVersion(version));
  for (const byte of data) pushBits(bits, byte, 8);
  const capacity = dataCodewordCount(version) * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < capacity) {
    pushBits(bits, pads[pad], 8);
    pad ^= 1;
  }
  return bits.slice(0, capacity);
}

function bitsToCodewords(bits: readonly number[]): number[] {
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    words.push(value);
  }
  return words;
}

function splitBlocks(data: readonly number[], version: number): {
  data: number[];
  ecc: number[];
}[] {
  const blockCount = ECC_M_BLOCKS[version];
  const ecCount = ECC_M_PER_BLOCK[version];
  const totalData = data.length;
  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;
  const shortCount = blockCount - longCount;
  const divisor = qrRsDivisor(ecCount);
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = i < shortCount ? shortLength : shortLength + 1;
    const slice = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: slice, ecc: qrRsRemainder(slice, divisor) });
  }
  return blocks;
}

function interleave(blocks: readonly { data: number[]; ecc: number[] }[]): number[] {
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  const maxEcc = Math.max(...blocks.map((block) => block.ecc.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]);
    }
  }
  for (let i = 0; i < maxEcc; i += 1) {
    for (const block of blocks) {
      if (i < block.ecc.length) out.push(block.ecc[i]);
    }
  }
  return out;
}

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

function formatBits(mask: number): number {
  const data = mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function blank(size: number): boolean[][] {
  return Array.from({ length: size }, () => Array<boolean>(size).fill(false));
}

function drawFinder(
  modules: boolean[][],
  reserved: boolean[][],
  row: number,
  col: number
): void {
  const size = modules.length;
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inPattern = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark =
        inPattern &&
        (r === 0 ||
          r === 6 ||
          c === 0 ||
          c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      modules[rr][cc] = dark;
      reserved[rr][cc] = true;
    }
  }
}

function drawAlignment(
  modules: boolean[][],
  reserved: boolean[][],
  row: number,
  col: number
): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      modules[row + r][col + c] =
        r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      reserved[row + r][col + c] = true;
    }
  }
}

function overlapsFinder(row: number, col: number, size: number): boolean {
  if (row <= 6 && col <= 6) return true;
  if (row <= 6 && col >= size - 7) return true;
  if (row >= size - 7 && col <= 6) return true;
  return false;
}

function drawFunctionPatterns(
  modules: boolean[][],
  reserved: boolean[][],
  version: number
): void {
  const size = modules.length;
  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, 0, size - 7);
  drawFinder(modules, reserved, size - 7, 0);
  for (const row of ALIGNMENT_CENTERS[version]) {
    for (const col of ALIGNMENT_CENTERS[version]) {
      if (overlapsFinder(row, col, size)) continue;
      drawAlignment(modules, reserved, row, col);
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    modules[6][i] = i % 2 === 0;
    modules[i][6] = i % 2 === 0;
    reserved[6][i] = true;
    reserved[i][6] = true;
  }
  reserved[4 * version + 9][8] = true;
  modules[4 * version + 9][8] = true;
  for (let i = 0; i < 8; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  reserved[8][8] = true;
  if (version >= 7) {
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        reserved[r][size - 11 + c] = true;
        reserved[size - 11 + c][r] = true;
      }
    }
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      modules[r][size - 11 + c] = dark;
      modules[size - 11 + c][r] = dark;
    }
  }
}

function placeFormat(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  // Spec: bit 14 (MSB) sits at (8, 0); bit 0 (LSB) sits at (0, 8). Writing
  // bit i into the 14−i slot was the B1 reverse-order bug.
  const first: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) first.push([i, 8]);
  first.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i += 1) first.push([8, 14 - i]);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    modules[first[i][0]][first[i][1]] = dark;
  }
  for (let i = 0; i < 8; i += 1) {
    modules[8][size - 1 - i] = ((bits >>> i) & 1) === 1;
  }
  for (let i = 8; i < 15; i += 1) {
    modules[size - 15 + i][8] = ((bits >>> i) & 1) === 1;
  }
  modules[size - 8][8] = true;
}

function placeData(
  modules: boolean[][],
  reserved: boolean[][],
  dataBits: readonly number[],
  mask: number
): void {
  const size = modules.length;
  let bit = 0;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col]) continue;
        let dark = bit < dataBits.length ? dataBits[bit] === 1 : false;
        bit += 1;
        if (maskBit(mask, row, col)) dark = !dark;
        modules[row][col] = dark;
      }
    }
  }
}

function runPenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) {
      run += 1;
      continue;
    }
    if (run >= 5) penalty += 3 + (run - 5);
    run = 1;
  }
  return penalty;
}

function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  for (let r = 0; r < size; r += 1) score += runPenalty(modules[r]);
  for (let c = 0; c < size; c += 1) {
    const col: boolean[] = [];
    for (let r = 0; r < size; r += 1) col.push(modules[r][c]);
    score += runPenalty(col);
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (
        v === modules[r][c + 1] &&
        v === modules[r + 1][c] &&
        v === modules[r + 1][c + 1]
      ) {
        score += 3;
      }
    }
  }
  const finder = [true, false, true, true, true, false, true];
  const hasFinder = (line: readonly boolean[], at: number): boolean => {
    for (let i = 0; i < 7; i += 1) if (line[at + i] !== finder[i]) return false;
    return true;
  };
  const fourLight = (line: readonly boolean[], at: number): boolean => {
    if (at < 0 || at + 4 > line.length) return false;
    return !line[at] && !line[at + 1] && !line[at + 2] && !line[at + 3];
  };
  const scan = (line: readonly boolean[]) => {
    for (let i = 0; i <= line.length - 7; i += 1) {
      if (!hasFinder(line, i)) continue;
      if (fourLight(line, i - 4) || fourLight(line, i + 7)) score += 40;
    }
  };
  for (let r = 0; r < size; r += 1) scan(modules[r]);
  for (let c = 0; c < size; c += 1) {
    const col: boolean[] = [];
    for (let r = 0; r < size; r += 1) col.push(modules[r][c]);
    scan(col);
  }
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  }
  const percent = (100 * dark) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

function cloneMatrix(modules: boolean[][]): boolean[][] {
  return modules.map((row) => row.slice());
}

export interface QrMatrix {
  version: number;
  size: number;
  modules: boolean[][];
}

export function encodeQr(payload: string): QrMatrix {
  const data = new TextEncoder().encode(payload);
  const version = selectQrVersion(data.length);
  const dataBits = encodeDataBits(data, version);
  const interleaved = interleave(splitBlocks(bitsToCodewords(dataBits), version));
  const stream: number[] = [];
  for (const word of interleaved) pushBits(stream, word, 8);
  for (let i = 0; i < remainderBits(version); i += 1) stream.push(0);

  const size = matrixSize(version);
  const reserved = blank(size);
  const base = blank(size);
  drawFunctionPatterns(base, reserved, version);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneMatrix(base);
    placeData(candidate, reserved, stream, mask);
    placeFormat(candidate, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) throw new Error("QR mask selection failed.");
  return { version, size, modules: best };
}

export function qrModulePath(modules: boolean[][], quiet = 4): {
  viewBox: number;
  d: string;
} {
  const size = modules.length;
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return { viewBox: size + quiet * 2, d: parts.join("") };
}
