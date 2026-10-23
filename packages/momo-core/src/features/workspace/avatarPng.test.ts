import { describe, expect, it } from "vitest";
import { buildPng } from "./__fixtures__/avatarFixture";
import { PNG_SIGNATURE, inspectPng, pngCrc32 } from "./avatarPng";

// PNG 구조 검사 (#4261). 디코더가 아니라 시그니처·IHDR·IEND 와 CRC 를 본다.

const bytesOf = (text: string): Uint8Array => Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));

describe("pngCrc32", () => {
  it("알려진 값과 같다: 빈 IEND 청크의 CRC 는 AE426082 다", () => {
    const iend = bytesOf("IEND");
    expect(pngCrc32(iend, 0, iend.length)).toBe(0xae426082);
  });
});

describe("inspectPng", () => {
  it("온전한 PNG 는 너비·높이·비트 깊이·색 종류를 돌려준다", () => {
    const png = buildPng({ width: 512, height: 512 });
    expect(inspectPng(png)).toEqual({
      width: 512,
      height: 512,
      bitDepth: 8,
      colorType: 6,
      byteLength: png.length,
    });
  });

  it("너비와 높이를 서로 바꿔 읽지 않는다", () => {
    expect(inspectPng(buildPng({ width: 640, height: 480 }))).toMatchObject({ width: 640, height: 480 });
  });

  it("PNG 가 아닌 것은 모두 거절한다: SVG, 빈 바이트, 짧은 바이트, 시그니처만 맞은 것", () => {
    expect(inspectPng(bytesOf('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"/>'))).toBeNull();
    expect(inspectPng(new Uint8Array(0))).toBeNull();
    expect(inspectPng(Uint8Array.from(PNG_SIGNATURE))).toBeNull();
    expect(inspectPng(new Uint8Array(200))).toBeNull();
  });

  it("시그니처 한 바이트만 틀려도 거절한다", () => {
    const png = buildPng();
    png[1] = 0x51;
    expect(inspectPng(png)).toBeNull();
  });

  it("IHDR 의 CRC 가 틀리면 너비·높이를 믿지 않는다", () => {
    const png = buildPng();
    png[20] ^= 0x01; // 높이를 조용히 바꾼다
    expect(inspectPng(png)).toBeNull();
  });

  it("잘린 파일은 거절한다: IEND 가 없다", () => {
    const png = buildPng();
    expect(inspectPng(png.slice(0, png.length - 12))).toBeNull();
    expect(inspectPng(png.slice(0, png.length - 1))).toBeNull();
  });

  it("너비나 높이가 0인 헤더는 거절한다", () => {
    expect(inspectPng(buildPng({ width: 0, height: 512 }))).toBeNull();
    expect(inspectPng(buildPng({ width: 512, height: 0 }))).toBeNull();
  });
});
