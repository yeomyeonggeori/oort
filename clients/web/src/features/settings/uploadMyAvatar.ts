import { type MemberAvatarMedia } from "@momo/core/lib/api";
import { uploadMyAvatarWith } from "@momo/core/features/settings/memberAvatarUpload";
import { putAttachmentBytes } from "@/features/attachments/uploadTransport";

/**
 * 내 프로필 사진 올리기: 순서(세션 열기 → Drive 로 바이트 → complete)는 코어
 * `uploadMyAvatarWith` 의 것이고(폰과 같다, #4384), 여기는 브라우저로 바이트를 보내는 일만 한다.
 *
 * Drive PUT 실패는 서버 코드가 아니므로 코어가 status 0 으로 올려 일반 문구로 읽히게 한다
 * (Drive 의 413/409 가 서버의 같은 코드 문구로 오독되지 않게).
 */
export async function uploadMyAvatar(
  workspaceId: string,
  file: File,
  onProgress: (fraction: number) => void
): Promise<MemberAvatarMedia> {
  return uploadMyAvatarWith(
    workspaceId,
    { name: file.name, mime: file.type, size: file.size },
    (uploadUrl) =>
      putAttachmentBytes(uploadUrl, file, file.type, onProgress).done
  );
}
