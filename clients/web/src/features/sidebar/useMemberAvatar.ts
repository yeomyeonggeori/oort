import { fetchMemberAvatar } from "@momo/core/lib/api";
import { createAvatarImageHook } from "./avatarImageStore";

// 업로드된 멤버 아바타(ADR-0161 증보 2026-10-01, #3277)의 `data:` URL. 워크스페이스
// 아바타와 같은 길이다 — `useWorkspaceAvatar.ts` 머리말 참조. CSP 는 `img-src 'self'
// data:` 그대로이고 바꾸지 않는다.
const memberAvatar = createAvatarImageHook(fetchMemberAvatar);

/** `contentPath` 의 `data:` URL, 받는 중·실패면 `null`(이니셜로 물러난다). */
export const useMemberAvatar = memberAvatar.useAvatar;

/** 테스트 전용. */
export const resetMemberAvatarsForTest = memberAvatar.reset;

/** 올린 직후 새 주소의 캐시를 그 파일로 채운다(깜박임·재요청 없음). */
export const primeMemberAvatar = memberAvatar.prime;
