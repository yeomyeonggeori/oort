import {
  ApiError,
  completeMyAvatarUpload,
  createMyAvatarUpload,
  type MemberAvatarMedia,
} from "@momo/core/lib/api";
import { putAttachmentBytes } from "@/features/attachments/uploadTransport";

/**
 * 내 프로필 사진 올리기: 세션 열기 → Drive 로 바이트 → complete(서버가 크기·mime·
 * 매직 넘버·픽셀 상한을 대조하고 교체). 바이트는 이 서버를 지나지 않는다(0151).
 *
 * Drive PUT 실패는 서버 코드가 아니므로 status 0 으로 올려 일반 문구로 읽히게 한다
 * (Drive 의 413/409 가 서버의 같은 코드 문구로 오독되지 않게).
 */
export async function uploadMyAvatar(
  workspaceId: string,
  file: File,
  onProgress: (fraction: number) => void
): Promise<MemberAvatarMedia> {
  const created = await createMyAvatarUpload(workspaceId, {
    name: file.name,
    mime: file.type,
    size: file.size,
  });
  const result = await putAttachmentBytes(
    created.uploadUrl,
    file,
    file.type,
    onProgress
  ).done;
  if (!result.ok) throw new ApiError(0, "avatar bytes were not stored");
  return completeMyAvatarUpload(workspaceId, created.id);
}
