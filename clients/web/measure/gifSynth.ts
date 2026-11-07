// 시험·측정용 GIF 합성기 (#5504). 서버가 만드는 small 그림과 같은 모양 - 전역 색 표 256색, 장면마다 지연, NETSCAPE2.0 반복 횟수 3(= 총 4번 재생) - 의
// 움직이는 GIF 를 코드로 만든다. 장면은 매번 달라서(비스듬한 줄무늬가 움직이고 잡음이 낀다) 압축이 잘 안 되므로 디코드·그리기 비용이 실제 그림에 가깝다.
// 같은 `seed` 는 같은 바이트이고 다른 `seed` 는 다른 바이트다(다른 데이터 주소).

export interface SynthOptions {
  /** 한 변(px). 서버 small 은 긴 변이 128 이하다. */
  size: number;
  frames: number;
  /** 장면 하나의 지연(1/100초). */
  delayCs: number;
  seed: number;
  /** NETSCAPE 반복 횟수(처음 한 번 뒤의 반복). 서버는 3 이다. 0 이면 무한. */
  repeat?: number;
}

const word = (value: number) => [value & 0xff, (value >> 8) & 0xff];

/** omggif 와 같은 방식의 LZW(최소 코드 크기 8, 사전이 차면 비우기). */
function lzw(indices: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0;
  let shift = 0;
  let codeSize = 9;
  const clear = 256;
  const eoi = 257;
  let next = eoi + 1;
  const emit = (code: number) => {
    cur |= code << shift;
    shift += codeSize;
    while (shift >= 8) {
      out.push(cur & 0xff);
      cur >>>= 8;
      shift -= 8;
    }
  };
  let table = new Map<number, number>();
  emit(clear);
  let prefix = indices[0];
  for (let at = 1; at < indices.length; at += 1) {
    const k = indices[at];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found === undefined) {
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        next = eoi + 1;
        codeSize = 9;
        table = new Map();
      } else {
        if (next >= 1 << codeSize) codeSize += 1;
        table.set(key, next);
        next += 1;
      }
      prefix = k;
    } else {
      prefix = found;
    }
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) out.push(cur & 0xff);
  return out;
}

const subBlocks = (data: number[]) => {
  const out: number[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.slice(at, at + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
};

export function synthGif({ size, frames, delayCs, seed, repeat = 3 }: SynthOptions): Uint8Array {
  const out: number[] = [...Array.from("GIF89a", (char) => char.charCodeAt(0)), ...word(size), ...word(size), 0xf7, 0, 0];
  for (let color = 0; color < 256; color += 1) out.push((color * 5 + seed * 37) & 0xff, (color * 3 + seed * 11) & 0xff, (255 - color + seed * 53) & 0xff);
  out.push(0x21, 0xff, 0x0b, ...Array.from("NETSCAPE2.0", (char) => char.charCodeAt(0)), 0x03, 0x01, ...word(repeat), 0x00);
  let noise = seed * 2654435761 + 12345;
  for (let frame = 0; frame < frames; frame += 1) {
    const indices = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        noise = (Math.imul(noise, 1103515245) + 12345) >>> 0;
        indices[y * size + x] = (x * 3 + y * 5 + frame * 23 + seed * 7 + ((noise >>> 24) & 0x0f)) & 0xff;
      }
    }
    out.push(0x21, 0xf9, 0x04, 0x00, ...word(delayCs), 0x00, 0x00);
    out.push(0x2c, 0, 0, 0, 0, ...word(size), ...word(size), 0x00, 8, ...subBlocks(lzw(indices)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

export function dataUrlOf(bytes: Uint8Array, mime = "image/gif"): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${mime};base64,${btoa(text)}`;
}
