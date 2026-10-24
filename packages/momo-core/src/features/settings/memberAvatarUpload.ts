import {
  ApiError,
  completeMyAvatarUpload,
  createMyAvatarUpload,
  type MemberAvatarMedia,
} from "../../lib/api";

// 내 프로필 사진 올리기의 순서 — 웹(`File`)과 폰(`file://` URI)이 같이 쓴다(#4384).
//
// 세션 열기 → Drive 로 바이트 → complete(서버가 크기·mime·매직 넘버·픽셀 상한을 대조하고
// 교체). 바이트는 이 서버를 지나지 않는다(0151). 순서와 「PUT 이 실패하면 complete 를
// 부르지 않는다」는 약속이 한 곳에 있어야 두 클라가 따로 틀리지 않는다. 바이트를 보내는
// 일(브라우저 XHR / 네이티브 업로더)만 클라의 것이라 `put` 으로 받는다.

/** Drive 쪽 PUT 의 결과. `ok` 가 아니면 complete 를 부르지 않는다. */
export interface AvatarBytesResult {
  ok: boolean;
}

export async function uploadMyAvatarWith(
  workspaceId: string,
  file: { name: string; mime: string; size: number },
  put: (uploadUrl: string) => Promise<AvatarBytesResult>
): Promise<MemberAvatarMedia> {
  const created = await createMyAvatarUpload(workspaceId, file);
  const result = await put(created.uploadUrl);
  // Drive PUT 실패는 서버 코드가 아니므로 status 0 으로 올려 일반 문구로 읽히게 한다
  // (Drive 의 413/409 가 서버의 같은 코드 문구로 오독되지 않게).
  if (!result.ok) throw new ApiError(0, "avatar bytes were not stored");
  return completeMyAvatarUpload(workspaceId, created.id);
}
