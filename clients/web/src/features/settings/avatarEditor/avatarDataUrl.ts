/**
 * PNG 바이트 → `data:image/png;base64,…` 주소 (#4261). 미리보기 전용이다.
 *
 * 왜 `blob:` 가 아닌가. 배포 CSP 는 `img-src 'self' data:` 라 `blob:` 이미지는 거절된다(`skill §1`). 코어의
 * `renderableAvatarUrl` 이 통과시키는 것도 `data:image/` 뿐이라, 이 주소는 진짜 아바타 컴포넌트(`Avatar`,
 * `DmAvatar`, `ProfileAvatar`)에 그대로 실려 **실제로 그려지는 모습**을 보여 준다.
 */
export function bytesToPngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000; // fromCharCode 인자 개수 상한을 넘지 않게 조각으로 나눈다.
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + step) as unknown as number[]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** 파일 → `data:` 주소. 읽지 못하면 `null`. 사진 미리보기 전용이다(올리는 바이트는 파일 그대로다). */
export function readFileAsDataUrl(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
