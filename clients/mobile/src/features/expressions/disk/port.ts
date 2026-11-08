import type {
  ExpressionDiskBackend,
  ExpressionDiskCompartment,
} from '@momo/core/features/expressions/diskCache';

// =============================================================================
// 폰의 보관 칸 포트 (ADR-0218 §14·증보 8, #5455 B-2).
//
// 코어 `diskCache.ts` 의 포트(`ExpressionDiskCompartment`·`ExpressionDiskBackend`)를 그대로 구현하고, 폰만의 두 가지를 더한다:
//   · `locate` — 바이트를 JS 힙에 올리지 않고 **파일 주소**와 길이만 돌려준다(폰은 그림을 파일 주소로 그린다, D3). 읽기 문을 통과한 읽기는 이것 하나다.
//   · `uriOf` — 쓴 파일의 주소(디스크를 보지 않는 순수 계산).
// `trim` 은 화면이 쥔 파일(`pinned`)을 지우지 않는다. 읽기 문·대조 청소·알림 규칙은 여기가 아니라 **저장소 한 곳**(`store.ts`)에 있다 — 포트는 어떤 항목이 지금
// 그려도 되는지 모른다.
// =============================================================================

/** 디스크에서 찾은 그림: 파일 주소와 저장 길이(부르는 쪽이 목록의 `media.bytes` 와 견준다). */
export interface LocatedImage {
  uri: string;
  bytes: number;
}

export interface PhoneDiskCompartment extends ExpressionDiskCompartment {
  /** 이 키의 그림이 놓일 파일의 주소(디스크를 읽지 않는다). 모양이 틀린 키·형식이면 던진다. */
  uriOf(key: string, mime: string): string;
  /** 디스크에서 이 그림을 찾는다: 있으면 파일 주소와 길이, 없으면 `null`. **읽기 한 번**으로 센다(마지막 읽은 시각을 1분 단위로 갱신한다). */
  locate(key: string, mime: string): Promise<LocatedImage | null>;
  /** 수명이 지난 항목을 지우고 바이트 상한을 넘으면 오래 읽지 않은 것부터 버린다. `pinned` 의 키(지금 화면이 쥔 파일)는 지우지 않는다. */
  trim(pinned?: ReadonlySet<string>): Promise<void>;
}

export interface PhoneDiskBackend extends ExpressionDiskBackend {
  open(name: string): PhoneDiskCompartment | null;
}

/** 저장소(`createPhoneExpressionStore`)가 쥐는 디스크 한 칸과 그 칸을 연 때의 세션 세대. */
export interface PhoneExpressionDisk {
  readonly name: string;
  readonly compartment: PhoneDiskCompartment;
  /** 이 칸을 연 뒤 세션이 끝나지 않았는가(로그아웃이 세대를 올린다). */
  sessionUnchanged(): boolean;
  /** 세대를 지금 값으로 다시 잡는다(저장소가 시작할 때 부른다: 앞 세션의 정리가 새 저장소가 만들어진 **뒤** 돌아도 새 저장소를 막지 않는다). */
  arm(): void;
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_HEAD = [0x47, 0x49, 0x46, 0x38];
const GIF_SEVEN = 0x37;
const GIF_NINE = 0x39;
const GIF_TAIL = 0x61;

/** 받은 바이트의 머리로 형식을 가린다(PNG 서명 8바이트, GIF87a·GIF89a). 둘 다 아니면 `null`. */
export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/gif' | null {
  if (bytes.length >= PNG_HEAD.length && PNG_HEAD.every((value, index) => bytes[index] === value)) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    GIF_HEAD.every((value, index) => bytes[index] === value) &&
    (bytes[4] === GIF_SEVEN || bytes[4] === GIF_NINE) &&
    bytes[5] === GIF_TAIL
  ) {
    return 'image/gif';
  }
  return null;
}

/** 이 바이트만 담은 `ArrayBuffer`(뷰가 버퍼 전체이면 복사하지 않는다). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
