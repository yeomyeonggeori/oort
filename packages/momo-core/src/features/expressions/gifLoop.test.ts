import { describe, expect, it } from "vitest";
import { FIXTURE_MEDIA } from "./fixtureMedia";
import { loopForever, loopForeverDataUrl } from "./gifLoop";

// =============================================================================
// 반응 칩의 GIF 가 계속 도는 방법 (#5504): 서버 GIF 의 NETSCAPE2.0 반복 횟수(3 = 총 4번)를 그릴 때만 0(무한)으로 바꾼다.
// 이 시험은 바이트를 직접 읽는다: 바뀐 곳이 반복 횟수 두 바이트뿐인가, 그림 데이터 안의 같은 글자를 건드리지 않는가, 반복 정보가 없는 GIF 에는 더하는가.
// 실제 엔진이 이 바이트로 정말 계속 도는지는 웹의 브라우저 시험(`ReactionChips.motion.browser.test.ts`)이 잰다.
// =============================================================================

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const base64Of = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** 서버(`media/motion.rs`)가 쓰는 모양 그대로의 GIF: 1x1, 두 장면, 반복 횟수 3. */
const SERVER_SHAPED_GIF = bytesOf(FIXTURE_MEDIA.gif.bodyBase64);
const SIGNATURE = Array.from("NETSCAPE2.0", (char) => char.charCodeAt(0));

/** `needle` 이 처음 나오는 위치(없으면 -1). */
function find(haystack: Uint8Array, needle: readonly number[], from = 0): number {
  for (let at = from; at + needle.length <= haystack.length; at += 1) if (needle.every((value, index) => haystack[at + index] === value)) return at;
  return -1;
}

describe("loopForever: 반복 횟수 두 바이트만 0 으로", () => {
  it("서버가 만든 모양의 GIF 는 NETSCAPE 의 횟수 3 이 0 이 되고 나머지 바이트는 하나도 달라지지 않는다", () => {
    const at = find(SERVER_SHAPED_GIF, SIGNATURE) + SIGNATURE.length;
    expect(Array.from(SERVER_SHAPED_GIF.subarray(at, at + 5))).toEqual([3, 1, 3, 0, 0]);
    const copy = SERVER_SHAPED_GIF.slice();
    const looped = loopForever(SERVER_SHAPED_GIF);
    expect(Array.from(looped.subarray(at, at + 5))).toEqual([3, 1, 0, 0, 0]);
    expect(looped.length).toBe(SERVER_SHAPED_GIF.length);
    const changed = Array.from(looped).flatMap((value, index) => (value === SERVER_SHAPED_GIF[index] ? [] : [index]));
    expect(changed).toEqual([at + 2]);
    // 입력은 바뀌지 않는다(저장소가 쥔 바이트를 칩이 고쳐 쓰지 않는다).
    expect(SERVER_SHAPED_GIF).toEqual(copy);
    expect(looped).not.toBe(SERVER_SHAPED_GIF);
  });

  it("이미 무한이면 값이 같고, 두 번 해도 한 번 한 것과 같다", () => {
    const once = loopForever(SERVER_SHAPED_GIF);
    expect(loopForever(once)).toEqual(once);
  });

  it("그림 데이터 안에 같은 글자가 있어도 건드리지 않는다: 블록 구조를 따라간다", () => {
    // 논리 화면 서술자와 색 표(2색) 뒤에 NETSCAPE 확장이 **없고**, 첫 그림 블록의 압축 데이터 안에 NETSCAPE 글자와 [3,1,3,0,0] 이 우연히 들어 있는 GIF.
    const header = Array.from("GIF89a", (char) => char.charCodeAt(0));
    const screen = [1, 0, 1, 0, 0x80, 0, 0];
    const table = [0, 0, 0, 255, 255, 255];
    const lookAlike = [...SIGNATURE, 3, 1, 3, 0, 0];
    const image = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, lookAlike.length, ...lookAlike, 0];
    const crafted = Uint8Array.from([...header, ...screen, ...table, ...image, 0x3b]);
    const looped = loopForever(crafted);
    // 앞에 더해졌고(19바이트), 그림 데이터의 같은 글자 뒤 [3,1,3,0,0] 은 그대로다.
    expect(looped.length).toBe(crafted.length + 19);
    const real = find(looped, SIGNATURE) + SIGNATURE.length;
    expect(Array.from(looped.subarray(real, real + 5))).toEqual([3, 1, 0, 0, 0]);
    const decoy = find(looped, SIGNATURE, real) + SIGNATURE.length;
    expect(Array.from(looped.subarray(decoy, decoy + 5))).toEqual([3, 1, 3, 0, 0]);
    // 더한 확장은 색 표 바로 뒤, 첫 그림 블록 앞이다.
    expect(looped[header.length + screen.length + table.length]).toBe(0x21);
    expect(looped[header.length + screen.length + table.length + 19]).toBe(0x2c);
  });

  it("GIF 가 아니거나 구조가 깨졌으면 입력 그대로(같은 참조)다", () => {
    const png = bytesOf(FIXTURE_MEDIA.png.bodyBase64);
    expect(loopForever(png)).toBe(png);
    const empty = new Uint8Array(0);
    expect(loopForever(empty)).toBe(empty);
    // 확장 하나의 하위 블록 사슬이 파일 끝을 넘는다.
    const truncated = SERVER_SHAPED_GIF.slice(0, find(SERVER_SHAPED_GIF, SIGNATURE) + 4);
    expect(loopForever(truncated)).toBe(truncated);
  });
});

describe("loopForeverDataUrl: 데이터 주소 도우미", () => {
  const url = `data:image/gif;base64,${FIXTURE_MEDIA.gif.bodyBase64}`;

  it("GIF 데이터 주소는 같은 그림의 무한 반복 주소가 되고, 같은 입력은 같은 출력이다", () => {
    const looped = loopForeverDataUrl(url);
    expect(looped).not.toBe(url);
    expect(looped.startsWith("data:image/gif;base64,")).toBe(true);
    expect(base64Of(loopForever(SERVER_SHAPED_GIF))).toBe(looped.slice("data:image/gif;base64,".length));
    expect(loopForeverDataUrl(url)).toBe(looped);
    expect(loopForeverDataUrl(looped)).toBe(looped);
  });

  it("GIF 가 아닌 주소(정지 PNG·빈 문자열)는 그대로다", () => {
    const png = `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
    expect(loopForeverDataUrl(png)).toBe(png);
    expect(loopForeverDataUrl("")).toBe("");
  });
});
