import { describe, expect, it } from "vitest";
import { stripJpegMetadata } from "./jpegMetadata";

// =============================================================================
// JPEG 메타데이터 제거 (AP-4 #4191). 캔버스가 EXIF를 옮기지 않는다는 것에 기대지 않는다: 실측으로 WebKit의 캔버스 인코더는
// 자기 Exif APP1과 Photoshop APP13을 쓴다(`jpegMetadata.ts` 머리말). 이 시험은 노드에서 **바이트 구조**를 합성해 규칙을 잰다.
// 진짜 엔진의 출력에서 같은 일이 되는지는 웹의 `photo.browser.test.ts`가 잰다.
// =============================================================================

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** `FF <marker> <길이> <페이로드>` 한 세그먼트. */
function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2), ...payload];
}

const JFIF = segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 72, 0, 72, 0, 0]);
// TIFF 헤더 + GPS 포인터 태그(0x8825)가 든 Exif. 구조의 진위가 아니라 「Exif와 GPS 글자가 든 세그먼트」가 필요하다.
const EXIF_GPS = segment(0xe1, [...ascii("Exif"), 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, ...ascii("GPSLatitude")]);
const XMP = segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")]);
const PHOTOSHOP = segment(0xed, [...ascii("Photoshop 3.0"), 0, ...ascii("8BIM")]);
const COMMENT = segment(0xfe, ascii("shot at home"));
const MAKER = segment(0xeb, ascii("vendor extension"));
const ICC = segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, 1, 2, 3, 4]);
const MPF = segment(0xe2, [...ascii("MPF"), 0, 1, 2, 3, 4]);
const ADOBE = segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
const DQT = segment(0xdb, [0, ...Array.from({ length: 64 }, (_, index) => index + 1)]);
const SOF0 = segment(0xc0, [8, ...u16(48), ...u16(64), 1, 1, 0x11, 0]);
const DHT = segment(0xc4, [0, ...Array.from({ length: 16 }, () => 0), 0]);
const DRI = segment(0xdd, u16(4));
const SOS_HEADER = segment(0xda, [1, 1, 0, 0, 63, 0]);
// 엔트로피 데이터: FF는 반드시 00이나 RSTn이 뒤따른다(바이트 스터핑). 헤더의 마커처럼 보이는 FF E1이 데이터 안에 있을 수는 없다.
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78];
const EOI = [0xff, 0xd9];
const SOI = [0xff, 0xd8];

const jpeg = (...segments: number[][]): Uint8Array => Uint8Array.from([...SOI, ...segments.flat(), ...SOS_HEADER, ...SCAN, ...EOI]);

/** 헤더 마커 이름 목록(SOS까지). */
function markers(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    out.push(marker.toString(16).toUpperCase());
    if (marker === 0xda) break;
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  }
  return out;
}

const text = (bytes: Uint8Array): string => [...bytes].map((value) => String.fromCharCode(value)).join("");
const tail = (bytes: Uint8Array): number[] => [...bytes.subarray(bytes.length - SCAN.length - EOI.length)];

describe("걷는 것", () => {
  const dirty = jpeg(JFIF, EXIF_GPS, XMP, PHOTOSHOP, COMMENT, MAKER, MPF, ICC, ADOBE, DQT, SOF0, DHT, DRI);

  it("전제: 합성한 입력에는 Exif·GPS·XMP·Photoshop·주석이 실제로 든다 (그래서 이 시험은 실패할 수 있다)", () => {
    const raw = text(dirty);
    for (const needle of ["Exif", "GPSLatitude", "xmpmeta", "Photoshop 3.0", "shot at home", "vendor extension"]) {
      expect(raw, needle).toContain(needle);
    }
    expect(markers(dirty)).toEqual(["E0", "E1", "E1", "ED", "FE", "EB", "E2", "E2", "EE", "DB", "C0", "C4", "DD", "DA"]);
  });

  it("Exif APP1(위치 태그 포함)·XMP APP1·Photoshop APP13·주석·제조사 확장·MPF를 모두 걷는다", () => {
    const out = stripJpegMetadata(dirty);
    expect(out).not.toBeNull();
    const raw = text(out!);
    for (const needle of ["Exif", "GPSLatitude", "xmpmeta", "Photoshop", "shot at home", "vendor extension", "MPF"]) {
      expect(raw, needle).not.toContain(needle);
    }
    expect(markers(out!)).not.toContain("E1");
    expect(markers(out!)).not.toContain("ED");
    expect(markers(out!)).not.toContain("FE");
    expect(markers(out!)).not.toContain("EB");
  });

  it("남기는 것: JFIF, ICC 프로필, Adobe 표지, 그리고 디코드에 필요한 모든 비-APP 헤더", () => {
    expect(markers(stripJpegMetadata(dirty)!)).toEqual(["E0", "E2", "EE", "DB", "C0", "C4", "DD", "DA"]);
    expect(text(stripJpegMetadata(dirty)!)).toContain("ICC_PROFILE");
  });

  it("스캔 데이터와 EOI는 한 바이트도 바뀌지 않는다 (바이트 스터핑·재시작 마커 포함)", () => {
    const out = stripJpegMetadata(dirty)!;
    expect(tail(out)).toEqual([...SCAN, ...EOI]);
    expect(out.subarray(out.length - SCAN.length - EOI.length)).toEqual(Uint8Array.from([...SCAN, ...EOI]));
  });

  it("입력은 바꾸지 않고 결과는 더 짧다", () => {
    const copy = Uint8Array.from(dirty);
    const out = stripJpegMetadata(dirty)!;
    expect(dirty).toEqual(copy);
    expect(out.length).toBeLessThan(dirty.length);
  });

  it("이미 깨끗하면 같은 바이트다 (멱등)", () => {
    const once = stripJpegMetadata(dirty)!;
    expect(stripJpegMetadata(once)).toEqual(once);
    const plain = jpeg(JFIF, DQT, SOF0, DHT);
    expect(stripJpegMetadata(plain)).toEqual(plain);
  });

  it("Exif가 먼저 오는 JPEG(JFIF 앞의 APP1)도 걷는다", () => {
    const out = stripJpegMetadata(jpeg(EXIF_GPS, JFIF, DQT, SOF0));
    expect(markers(out!)).toEqual(["E0", "DB", "C0", "DA"]);
    expect(text(out!)).not.toContain("Exif");
  });

  it("마커 앞의 채움 바이트(FF)가 있어도 구조를 읽는다", () => {
    const padded = Uint8Array.from([...SOI, 0xff, ...JFIF, 0xff, 0xff, ...EXIF_GPS, ...DQT, ...SOF0, ...SOS_HEADER, ...SCAN, ...EOI]);
    const out = stripJpegMetadata(padded);
    expect(out).not.toBeNull();
    expect(text(out!)).not.toContain("Exif");
  });
});

describe("형식이 맞지 않으면 null이다 (저장하지 않는다: fail-closed)", () => {
  const valid = jpeg(JFIF, EXIF_GPS, DQT, SOF0);
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["빈 입력", Uint8Array.from([])],
    ["SOI가 아닌 시작", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["SOI만 있다", Uint8Array.from(SOI)],
    ["SOS 없이 EOI", Uint8Array.from([...SOI, ...JFIF, ...EOI])],
    ["SOS 없이 끝난다 (헤더만)", Uint8Array.from([...SOI, ...JFIF, ...DQT])],
    ["세그먼트 길이가 입력 밖으로 나간다", Uint8Array.from([...SOI, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78])],
    ["세그먼트 길이가 2 미만이다", Uint8Array.from([...SOI, 0xff, 0xe1, 0x00, 0x01, 0, 0])],
    ["헤더에 길이 없는 마커(RST)가 온다", Uint8Array.from([...SOI, 0xff, 0xd0, ...DQT, ...SOS_HEADER])],
    ["마커 자리에 FF가 아닌 바이트가 온다", Uint8Array.from([...SOI, 0x12, 0x34, 0x56, 0x78])],
    ["마커 길이 바이트가 잘렸다", Uint8Array.from([...SOI, 0xff, 0xe1, 0x00])],
  ];

  it("전제: 정상 입력은 null이 아니다", () => {
    expect(stripJpegMetadata(valid)).not.toBeNull();
  });

  it.each(cases)("%s", (_name, bytes) => {
    expect(stripJpegMetadata(bytes)).toBeNull();
  });

  it("뒷부분이 잘린 정상 JPEG(스캔 중간)는 구조상 SOS를 지났으므로 받는다 (디코드 실패는 디코더가 가린다)", () => {
    expect(stripJpegMetadata(valid.subarray(0, valid.length - 4))).not.toBeNull();
  });
});
