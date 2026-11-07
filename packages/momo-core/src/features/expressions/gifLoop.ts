// =============================================================================
// 반응 칩의 GIF 가 계속 도는 방법 (#5504, owner 2026-11-07 「계속 움직임」).
//
// 서버가 만드는 움직이는 그림(small·large)은 NETSCAPE2.0 반복 횟수가 3(= 처음 한 번 + 3번 = 총 4번 재생, ADR-0218 D1, 서버 `media/motion.rs`)이라서
// 브라우저·iOS 모두 4번 돌면 마지막 장면에서 멈춘다. 메시지 속 그림은 그 규칙을 그대로 따르고, **반응 칩만** 계속 돈다(ADR-0218 증보 §13).
//
// 계속 도는 방법은 둘이 있다. 타이머로 4번마다 다시 시작하면(주소를 바꿔 다시 그림) 그때마다 디코드를 다시 하고 칩끼리 장면이 어긋난다.
// 그래서 받은 바이트에서 **반복 횟수 두 바이트만 0(무한)으로** 바꿔 그린다: 같은 그림은 같은 바이트(같은 주소)라 엔진이 디코드를 한 번만 하고 장면도 함께 간다.
// 이것은 그리는 쪽의 변환이다. 서버가 주는 그림·치수·해시(`sha256`)는 바꾸지 않고, 여기서 만든 바이트는 화면에만 쓴다.
//
// 순수 모듈이다: DOM·React·플랫폼 API가 없다(데이터 주소 도우미만 전역 `atob`·`btoa` 를 쓴다). 웹과 폰이 같이 쓴다.
// =============================================================================

const NETSCAPE = "NETSCAPE2.0";
/** 반복 횟수를 나르는 NETSCAPE 응용 확장 한 덩이: 소개(0x21 0xFF) + 크기 11 + 이름 + 하위 블록(크기 3, 식별 1, 횟수 2바이트) + 끝. */
const FOREVER_EXTENSION = [0x21, 0xff, 0x0b, ...Array.from(NETSCAPE, (char) => char.charCodeAt(0)), 0x03, 0x01, 0x00, 0x00, 0x00];

const hasHeader = (bytes: Uint8Array) =>
  bytes.length > 13 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;

/** `at` 의 하위 블록 사슬을 건너뛴 다음 위치. 사슬이 파일 밖으로 나가면 -1. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  let position = at;
  while (position < bytes.length) {
    const size = bytes[position];
    position += 1 + size;
    if (size === 0) return position <= bytes.length ? position : -1;
  }
  return -1;
}

/** 이 위치의 확장이 NETSCAPE2.0 응용 확장인가. */
function isNetscape(bytes: Uint8Array, at: number): boolean {
  if (bytes[at + 1] !== 0xff || bytes[at + 2] !== 0x0b || at + 3 + NETSCAPE.length > bytes.length) return false;
  for (let index = 0; index < NETSCAPE.length; index += 1) if (bytes[at + 3 + index] !== NETSCAPE.charCodeAt(index)) return false;
  return true;
}

/**
 * 반복 횟수를 0(무한)으로 바꾼 GIF 바이트. 입력은 바꾸지 않고 새 배열을 돌려준다.
 * 블록 구조를 따라가며 찾으므로 그림 데이터 안에 우연히 같은 글자가 있어도 건드리지 않는다. 확장이 없으면(한 번만 도는 GIF) 첫 블록 앞에 더한다.
 * GIF 가 아니거나 구조가 깨졌으면 **입력 그대로**(같은 참조) 돌려준다 - 반응 칩은 평소대로 그려진다.
 */
export function loopForever(bytes: Uint8Array): Uint8Array {
  if (!hasHeader(bytes)) return bytes;
  const packed = bytes[10];
  // 논리 화면 서술자(7바이트) 뒤에 전역 색 표가 있으면 건너뛴다(3바이트 × 2^(n+1)).
  let at = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const firstBlock = at;
  while (at < bytes.length) {
    const kind = bytes[at];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      if (isNetscape(bytes, at)) {
        // 응용 확장: [0x21, 0xFF, 0x0B, 이름 11바이트] 다음이 하위 블록 사슬이다. 첫 하위 블록이 [크기 ≥3, 식별 1, 횟수 두 바이트] 이면 횟수를 0 으로 한다.
        const sub = at + 3 + NETSCAPE.length;
        if (sub + 3 < bytes.length && bytes[sub] >= 3 && bytes[sub + 1] === 0x01) {
          const out = bytes.slice();
          out[sub + 2] = 0;
          out[sub + 3] = 0;
          return out;
        }
      }
      // 확장 하나를 건너뛴다: 소개(2바이트) + 하위 블록 사슬.
      const next = skipSubBlocks(bytes, at + 2);
      if (next < 0) return bytes;
      at = next;
      continue;
    }
    if (kind === 0x2c) {
      // 첫 그림 블록까지 NETSCAPE 확장이 없었다: 반복 정보가 없는 GIF(한 번만 돈다). 첫 블록 앞에 무한 확장을 더한다.
      const out = new Uint8Array(bytes.length + FOREVER_EXTENSION.length);
      out.set(bytes.subarray(0, firstBlock), 0);
      out.set(FOREVER_EXTENSION, firstBlock);
      out.set(bytes.subarray(firstBlock), firstBlock + FOREVER_EXTENSION.length);
      return out;
    }
    return bytes;
  }
  return bytes;
}

const GIF_DATA_PREFIX = "data:image/gif;base64,";
const CHUNK = 0x8000;

/**
 * `data:image/gif;base64,...` 주소를 반복 횟수 0 의 같은 그림으로 바꾼다. GIF 데이터 주소가 아니거나 바꿀 것이 없으면 입력 그대로(같은 문자열)다.
 * 같은 입력은 같은 출력이므로 호출하는 쪽이 입력 문자열을 열쇠로 한 번만 만들어 두면 같은 그림을 쓰는 모든 칸이 한 주소를 나눠 쓴다.
 */
export function loopForeverDataUrl(src: string): string {
  if (!src.startsWith(GIF_DATA_PREFIX)) return src;
  const raw = atob(src.slice(GIF_DATA_PREFIX.length));
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const looped = loopForever(bytes);
  if (looped === bytes) return src;
  let text = "";
  for (let at = 0; at < looped.length; at += CHUNK) text += String.fromCharCode(...looped.subarray(at, at + CHUNK));
  return `${GIF_DATA_PREFIX}${btoa(text)}`;
}
