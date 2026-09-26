import {
  INVITE_CREATE_BUSY,
  INVITE_CREATE_LABEL,
} from "@/features/settings/inviteLabels";

// 코메토의 말(ADR-0193 D11 해요체 한 문장, brief D3). 발급 전은 대기, 발급 뒤는 기쁨.
export const S2_TITLE = "함께할 팀원을 불러요.";
export const S2_DETAIL = "초대 링크를 만들어 건네면 돼요.";
export const S2_ISSUED_LINE = "초대 링크가 준비됐어요.";
export const S2_ISSUED_DETAIL = "지금 복사해서 팀원에게 건네요.";
export const S2_TROUBLE_LINE = "초대 링크를 만들지 못했어요.";
export const S2_OFFLINE_LINE = "연결이 끊겨서 잠깐 기다려요.";
/** 발급 카드 안의 작은 글씨(brief D3: 「해시만 보관」 문장은 카드 안으로 내린다). */
export const S2_CODE_NOTE =
  "코드는 발급 직후 한 번만 보입니다. 서버는 해시만 보관합니다.";
export const S2_PRIMARY_LABEL = INVITE_CREATE_LABEL;
export const S2_PRIMARY_BUSY = INVITE_CREATE_BUSY;
export const S2_SKIP_LABEL = "나중에";
export const S2_SKIP_SENTENCE =
  "설정 › 멤버와 초대에서 언제든 이어서 초대할 수 있습니다.";
export const S2_CONTINUE_LABEL = "계속";
export const S2_REENTRY = "설정 › 멤버와 초대에서 언제든";
export const S2_OFFLINE_NOTE_ID = "onboarding-s2-offline-note";
export const S2_OFFLINE_REASON =
  "연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다.";
export const S2_ISSUE_ERROR_ID = "onboarding-s2-issue-error";
