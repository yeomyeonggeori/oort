// =============================================================================
// 보낼 사진·GIF 의 표시 크기를 재는 자 (ADR-0151 증보 9 I7, #5469).
//
// 서버에 선언하는 가로세로는 **받는 쪽이 같은 바이트에서 재는 것과 같은 자**로 잰다. 받는 웹은 `<img>` 의 `naturalWidth·Height` 를
// 읽고, 그 값은 EXIF 방향을 적용한 **표시 크기**다(세로로 찍은 사진은 세로). `createImageBitmap` 의 기본 방향 처리는 엔진과 버전마다
// 달라서(jsdom 은 보여 주지도 못한다) 기본값을 믿지 않고 **방향을 적용하라고 직접 말한다**(`decodeDisplayBitmap`). 파일 헤더를 읽어 재는
// 것(서버 몫으로 기각한 설계 (b))은 방향을 모르므로 세로 사진의 칸이 가로로 선다. 칸이 틀리면 그림이 올 때 한 번 움직이고, 그 움직임이
// 이 선언이 없애려던 것이다.
//
// ## 쓰임
//
// `draftStore.uploadOne` 이 바이트가 다 올라간 때 이 재기를 시작하고(완료 왕복과 겹친다), 선언 직전에 그 결과를 기다린다. **재지 못하면
// `null`** 이다 — 지원하지 않는 브라우저, 이 브라우저가 못 푸는 종류(Chrome 의 HEIC), 깨진 파일,
// 크기가 0 인 그림이 모두 같은 답이다. 호출처는 `null` 을 「선언하지 않음」으로 읽고, 선언 없이 간 사진은 받는 쪽이 지금처럼 기기
// 기억을 쓴다. 이 함수는 던지지 않는다.
//
// ## 캐시와 한 번만 풀기
//
// `File` 을 키로 한 WeakMap 이다(`draftThumbnail.ts` 와 같은 수명 규칙): 초안을 지우면 `draftStore` 가 `File` 을 놓고 결과도 같이
// 놓인다. 다시 올리기(재시도)가 같은 파일을 다시 풀지 않는다.
//
// 컴포저 트레이의 썸네일도 같은 파일을 `createImageBitmap` 으로 푼다(그림 한 장을 그리려고). 그 풀기가 이미 시작됐으면 크기는 거기서
// 받는다(`shareImageSize`): 큰 사진을 두 번 풀어 메모리와 시간을 두 배로 쓰지 않는다. 트레이가 안 떠 있어 아무도 안 풀었으면 이쪽이
// 한 번 푼다.
// =============================================================================

export interface PixelSize {
  width: number;
  height: number;
}

const measured = new WeakMap<File, Promise<PixelSize | null>>();

/**
 * 이 파일을 **풀기 시작하는 쪽**(트레이 썸네일)이 크기를 나눠 주는 자리. 돌려받은 함수를 풀기가 끝나는 때(디코드 성공 시 크기, 실패 시
 * `null`) 한 번 부른다. 이미 누가 이 파일의 크기를 맡았으면(재기가 먼저 시작했거나 앞서 나눴으면) 아무 일도 하지 않는 함수다.
 */
export function shareImageSize(file: File): (size: PixelSize | null) => void {
  if (measured.has(file)) return () => {};
  let settle: (size: PixelSize | null) => void = () => {};
  measured.set(
    file,
    new Promise<PixelSize | null>((resolve) => {
      settle = resolve;
    })
  );
  return settle;
}

/** 디코드된 그림의 크기. 그림이 아닌 값(0·무한)은 `null` — 틀린 크기를 선언하느니 선언하지 않는다. */
export function sizeOfBitmap(bitmap: { width: number; height: number }): PixelSize | null {
  const { width, height } = bitmap;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/**
 * 이 파일을 **표시되는 모양**(EXIF 방향 적용)으로 푼 그림. 트레이 썸네일(`draftThumbnail.ts`)과 이 파일의 재기가 **같은 함수**로 풀어서,
 * 그림을 그리는 쪽과 크기를 선언하는 쪽이 같은 방향의 같은 그림을 본다.
 *
 * 방향을 기본값에 맡기지 않고 `imageOrientation: "from-image"` 로 직접 청한다. 이 값을 모르는 엔진은 `TypeError` 로 거절하므로(WebIDL 의
 * 열거값 검사) **그때만** 한 번 기본값으로 다시 푼다. 그 밖의 실패(못 푸는 파일: `InvalidStateError` 등)는 다시 풀어도 같으므로 그대로
 * 던진다 — 파일을 두 번 풀지 않는다. 던진 것은 호출처가 「크기 없음」·「썸네일 실패」로 읽는다. 풀린 그림은 호출처가 `close()` 한다.
 */
export async function decodeDisplayBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return await createImageBitmap(file);
  }
}

async function decode(file: File): Promise<PixelSize | null> {
  try {
    const bitmap = await decodeDisplayBitmap(file);
    try {
      return sizeOfBitmap(bitmap);
    } finally {
      // 디코드된 픽셀을 바로 놓는다. 크기만 필요했다.
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** 이 파일의 표시 크기(픽셀), 못 쟀으면 `null`. 같은 `File` 은 한 번만 푼다. 던지지 않는다. */
export function measureImageFile(file: File): Promise<PixelSize | null> {
  let request = measured.get(file);
  if (request === undefined) {
    request = decode(file);
    measured.set(file, request);
  }
  return request;
}
