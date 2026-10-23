// =============================================================================
// JPEG의 EXIF를 바이트로 만들고 읽는 작은 도구 (AP-4 #4191, 배경 사진의 EXIF 제거 시험).
//
// 시험이 「위치 태그가 든 JPEG를 넣으면 출력에 EXIF가 없다」를 단정하려면 입력에 **실제로** EXIF가 있어야
// 하고, 검사기가 그것을 **실제로** 잡을 수 있어야 한다. 그래서 둘을 이 파일 하나에 둔다.
//   · `exifSegment`   Orientation과 GPS(위도·경도) 태그가 든 APP1 세그먼트를 만든다.
//   · `injectExif`    JPEG의 SOI 뒤(JFIF APP0 다음)에 그 세그먼트를 꽂는다.
//   · `inspectJpeg`   마커를 훑어 EXIF APP1과 GPS 태그가 있는지, 크기가 얼마인지 읽는다.
// 이 도구들은 자기 입력에 대해 서로를 검증한다(`jpegExif.test.mjs`가 아니라 시험 안의 전제 단정): 꽂은 JPEG를
// 검사기가 「EXIF 있음, GPS 있음」으로 읽어야 하고, 그러지 않으면 시험은 입력을 탓하며 멈춘다.
// =============================================================================

const u16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

// TIFF 값의 종류: 2 = ASCII, 3 = SHORT, 4 = LONG, 5 = RATIONAL.
function entry(tag, type, count, valueBytes) {
  return [...u16(tag), ...u16(type), ...u32(count), ...valueBytes];
}

/**
 * @param {{ orientation?: number; gps?: { lat: [number, number, number]; lon: [number, number, number] } }} options
 * @returns {Uint8Array} `FF E1 <길이> "Exif\0\0" <TIFF>` 한 세그먼트
 */
export function exifSegment({ orientation = 1, gps } = {}) {
  // TIFF 헤더(8바이트) 뒤에 IFD0, 그 뒤에 GPS IFD, 그 뒤에 유리수 데이터.
  const ifd0Count = gps ? 2 : 1;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsIfdOffset = 8 + ifd0Size;
  const gpsEntries = gps ? 4 : 0;
  const gpsIfdSize = gps ? 2 + gpsEntries * 12 + 4 : 0;
  const rationalOffset = gpsIfdOffset + gpsIfdSize;

  const ifd0 = [
    ...u16(ifd0Count),
    ...entry(0x0112, 3, 1, [...u16(orientation), 0, 0]),
    ...(gps ? entry(0x8825, 4, 1, u32(gpsIfdOffset)) : []),
    ...u32(0),
  ];
  const rational = ([d, m, s]) => [...u32(d), ...u32(1), ...u32(m), ...u32(1), ...u32(s), ...u32(1)];
  const gpsIfd = gps
    ? [
        ...u16(gpsEntries),
        ...entry(0x0001, 2, 2, [0x4e, 0, 0, 0]), // GPSLatitudeRef "N"
        ...entry(0x0002, 5, 3, u32(rationalOffset)),
        ...entry(0x0003, 2, 2, [0x45, 0, 0, 0]), // GPSLongitudeRef "E"
        ...entry(0x0004, 5, 3, u32(rationalOffset + 24)),
        ...u32(0),
        ...rational(gps.lat),
        ...rational(gps.lon),
      ]
    : [];
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, ...u32(8), ...ifd0, ...gpsIfd];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0"
  const segment = [0xff, 0xe1, ...u16(body.length + 2), ...body];
  return Uint8Array.from(segment);
}

/** JPEG(SOI로 시작)의 SOI와 JFIF APP0 뒤에 세그먼트를 꽂는다. */
export function injectExif(jpeg, segment) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG (no SOI)");
  let at = 2;
  if (jpeg[at] === 0xff && jpeg[at + 1] === 0xe0) at += 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(segment, at);
  out.set(jpeg.subarray(at), at + segment.length);
  return out;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const textOf = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/**
 * 마커를 훑어 읽는다. 스캔 데이터(SOS) 앞까지만 본다: 메타데이터는 거기 앞에 있다.
 * @returns {{ isJpeg: boolean; width: number; height: number; exif: boolean; gps: boolean; orientation: number | null; markers: string[] }}
 */
export function inspectJpeg(bytes) {
  const result = { isJpeg: false, width: 0, height: 0, exif: false, gps: false, orientation: null, markers: [] };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return result;
  result.isJpeg = true;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    const start = at + 4;
    const end = at + 2 + length;
    result.markers.push(`FF${marker.toString(16).toUpperCase()}`);
    if (SOF_MARKERS.has(marker)) {
      result.height = (bytes[start + 1] << 8) | bytes[start + 2];
      result.width = (bytes[start + 3] << 8) | bytes[start + 4];
    }
    if (marker === 0xe1 && textOf(bytes, start, start + 4) === "Exif") {
      result.exif = true;
      readTiff(bytes.subarray(start + 6, end), result);
    }
    at = end;
  }
  return result;
}

function readTiff(tiff, result) {
  if (tiff.length < 8) return;
  const little = tiff[0] === 0x49;
  const get16 = (offset) => (little ? tiff[offset] | (tiff[offset + 1] << 8) : (tiff[offset] << 8) | tiff[offset + 1]);
  const get32 = (offset) =>
    little
      ? (tiff[offset] | (tiff[offset + 1] << 8) | (tiff[offset + 2] << 16) | (tiff[offset + 3] << 24)) >>> 0
      : ((tiff[offset] << 24) | (tiff[offset + 1] << 16) | (tiff[offset + 2] << 8) | tiff[offset + 3]) >>> 0;
  const ifdTags = (offset) => {
    if (offset + 2 > tiff.length) return [];
    const count = get16(offset);
    const tags = [];
    for (let index = 0; index < count && offset + 2 + index * 12 + 12 <= tiff.length; index += 1) {
      const at = offset + 2 + index * 12;
      tags.push({ tag: get16(at), type: get16(at + 2), value: at + 8 });
    }
    return tags;
  };
  const ifd0 = ifdTags(get32(4));
  for (const { tag, type, value } of ifd0) {
    if (tag === 0x0112 && type === 3) result.orientation = get16(value);
    if (tag === 0x8825) result.gps = ifdTags(get32(value)).length > 0;
  }
}
