// =============================================================================
// JPEG에서 메타데이터를 벗긴다 (AP-4 #4191, ADR-0189 증보 3 D4 「EXIF 제거」).
//
// 내 사진은 항상 캔버스로 다시 쓴다(`wallpaper.ts` `importPhoto`). 캔버스는 원본의 EXIF를 옮기지 않으므로 위치(GPS)·촬영
// 기기·시각 태그는 거기서 사라진다. **그러나 인코더가 자기 메타데이터를 새로 쓰는 엔진이 있다.** 실측(Playwright WebKit,
// 데스크탑 앱의 WKWebView와 같은 엔진): `canvas.toBlob("image/jpeg")`의 출력에 인코더가 쓴 Exif APP1(76바이트)과 Photoshop
// APP13이 든다. 원본의 GPS는 아니지만 「출력에 EXIF 없음」이라는 약속을 엔진의 사정에 맡길 수 없다. 그래서 인코딩이 끝난
// 바이트를 이 함수로 한 번 더 걸러, 사진이 이 기기에 저장되기 전에 메타데이터 세그먼트를 전부 걷는다.
//
// ## 무엇을 남기고 무엇을 걷는가
//
// 스캔 시작(SOS) 앞의 헤더 세그먼트만 본다. 남기는 것은 그림을 디코드하는 데 필요한 것이다.
//   · SOI·EOI·양자화·허프만·프레임(SOFn)·재시작 간격(DRI)·스캔(SOS) 등 비-APP 마커 중 COM이 아닌 것
//   · APP0(JFIF)
//   · APP2 중 `ICC_PROFILE`(색 프로필: 색을 보존한다. 개인 정보가 아니다)
//   · APP14(Adobe: CMYK·YCCK 변환 표지가 디코드에 필요하다)
// 걷는 것은 나머지 APPn 전부(Exif·XMP가 든 APP1, IPTC·Photoshop이 든 APP13, 다중 사진(MPF)이 든 APP2, 제조사 확장)와 COM(주석)이다.
// SOS 뒤(엔트로피 부호화 데이터와 EOI)는 한 바이트도 건드리지 않는다.
//
// 형식이 맞지 않으면(SOI로 시작하지 않음, 길이가 어긋남, SOS 없음) `null`이다. 호출부는 그 사진을 **저장하지 않는다**: 걸러지지
// 않은 바이트를 「아마 괜찮다」고 저장하는 것보다 거절하는 쪽이 이 약속에 맞다(fail-closed).
//
// 순수 함수다(바이트 배열만 다룬다).
// =============================================================================

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP_FIRST = 0xe0;
const APP_LAST = 0xef;
const COM = 0xfe;

const ICC_SIGNATURE = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

function startsWith(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
  if (at + signature.length > bytes.length) return false;
  return signature.every((value, index) => bytes[at + index] === value);
}

/** 이 헤더 세그먼트를 남기는가(`marker`와 그 페이로드 시작 위치). */
function keep(marker: number, bytes: Uint8Array, payloadAt: number): boolean {
  if (marker === COM) return false;
  if (marker < APP_FIRST || marker > APP_LAST) return true;
  if (marker === APP0 || marker === APP14) return true;
  if (marker === APP2) return startsWith(bytes, payloadAt, ICC_SIGNATURE);
  return false;
}

/**
 * 메타데이터 세그먼트를 걷은 새 바이트 배열. 입력이 JPEG의 구조를 지키지 않으면 `null`이다. 입력은 바꾸지 않는다.
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) return null;
  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let at = 2;
  while (at < input.length) {
    if (input[at] !== 0xff) return null;
    // 마커 앞의 채움 바이트(FF)는 건너뛴다.
    let markerAt = at + 1;
    while (markerAt < input.length && input[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= input.length) return null;
    const marker = input[markerAt];
    if (marker === EOI) return null; // 스캔 없이 끝났다.
    // 길이가 없는 마커(재시작·TEM·SOI)는 헤더에 올 수 없다.
    if (marker === 0x00 || marker === 0x01 || marker === SOI || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (markerAt + 2 >= input.length) return null;
    const length = (input[markerAt + 1] << 8) | input[markerAt + 2];
    if (length < 2) return null;
    const end = markerAt + 1 + length;
    if (end > input.length) return null;
    if (marker === SOS) {
      // 스캔 헤더와 그 뒤(엔트로피 데이터, EOI)는 그대로 복사한다.
      parts.push(input.subarray(at, input.length));
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }
    if (keep(marker, input, markerAt + 3)) parts.push(input.subarray(at, end));
    at = end;
  }
  return null; // SOS를 만나지 못했다.
}
