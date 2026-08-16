import type { ApprovalNoteTone } from "@momo/core/features/timeline/approvalNote";

// =============================================================================
// 코어의 **역할**을 이 팔레트의 토큰으로 옮기는 다리 (#1429).
//
// `dividerTone.ts`가 구분선에 대해 하는 일을 승인 노트에 대해 한다. 같은 이유로
// 생겼고(코어는 값을 모르고 화면은 클래스만 받는다) 같은 방식으로 지켜진다 —
// `approvalNoteTone.test.ts`가 `tokens.css`를 직접 파싱해 코어의 명세
// (`APPROVAL_NOTE_TONE_SPEC`)를 이 표에 대고 잰다.
//
// ## 왜 이 파일이 생겼나
//
// 세 클래스는 `AgentCard.tsx`의 삼항 사슬 안에 있었다. 그 상태에서 이 클라가
// 말하고 있던 것은 「차단 줄은 `text-warn`이다」였고, 그것은 **어느 토큰인가**이지
// **왜 그 토큰인가**가 아니다. 그래서 폰이 같은 톤을 반대로 칠하고 있다는 사실도,
// 두 답이 왜 갈라져 있는지도 어느 파일에도 없었다 — #1429가 물은 것이 그것이다.
//
// 판정은 코어(`approvalNote.ts` §색 계약)에 있다: 두 답은 한 답을 두 팔레트에
// 옮겨 적은 것이고, 갈라지는 것은 값이 아니라 역할 배정이다. 이 팔레트에서
// 「사람이 할 일이 남아 있다」를 지는 것은 `--accent`이므로(`StatusChip.tsx`:
// *"사람이 할 일이 남아 있다는 뜻의 색은 이 제품에서 하나여야 한다"*) `--warn`은
// 「지금은 정상이 아니다」로 남아 있고, 차단 줄이 그 뜻이다. 폰에서는 그 두 역할이
// 한 토큰에 겹치지 않으므로 답이 다르게 나온다.
// =============================================================================

/**
 * 톤이 실제로 쓰는 CSS 변수 이름. 테스트가 `tokens.css`에서 이 이름을 찾는다.
 *
 * 잉크만 적는 이유: 이 클라가 위계를 내는 축은 잉크와 **텍스트 롤**(크기) 둘이고,
 * 롤은 아래 클래스 표가 진다. 값 대조가 필요한 것은 잉크 쪽뿐이다 — 롤은 팔레트의
 * 역할과 겹칠 일이 없다.
 */
export const APPROVAL_NOTE_TONE_TOKEN: Record<ApprovalNoteTone, string> = {
  receipt: "--ink",
  blocked: "--warn",
  guidance: "--ink-muted",
};

/**
 * 명세의 `mustDifferFrom`에 나오는 **팔레트 역할** 이름 → 이 팔레트의 토큰.
 *
 * 형제 톤 셋은 위 표가 이미 답하므로 여기 없다. 나머지 둘은 노트의 톤이 아니라
 * 다른 자리의 뜻이고, 그것들과 겹치지 않는 것이 계약이다.
 */
export const APPROVAL_NOTE_ROLE_TOKEN: Record<string, string> = {
  // 「여기를 보라 · 사람이 할 일이 남아 있다」. 멘션 · 미읽 경계(`dividerTone.ts`의
  // `boundary`) · 대기 승인 칩 · ADE 차단 개수가 전부 이 토큰이다.
  attention: "--accent",
  danger: "--danger",
};

/**
 * 한 줄에 걸리는 클래스. 문자열 리터럴이라 Tailwind 스캐너가 본다.
 *
 * 영수증만 본문 크기로 서는 이유는 `AgentCard.tsx`의 `ApprovalNoteLine` 독스트링에
 * 있다(방금 내가 한 되돌릴 수 없는 행동의 기록이고, 체크 아이콘이 함께 선다).
 * 나머지 둘은 `text-meta`를 공유하고 잉크로 갈린다.
 */
export const APPROVAL_NOTE_TONE_CLASS: Record<ApprovalNoteTone, string> = {
  receipt: "text-body text-ink",
  blocked: "text-meta text-warn",
  guidance: "text-meta text-ink-muted",
};
