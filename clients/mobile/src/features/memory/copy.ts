// =============================================================================
// 팀 기억 v2 폰 표면의 문장 (ADR-0196 D9·D12 / #3166).
//
// 말투는 해요체 하나다. 웹 #3165와 같은 문장을 쓰려고 했으나, 이 브랜치를 자르는
// 시점에 두 클라이언트가 함께 읽는 코어 자리(`momo-core/features/memory/copy`)는
// 없었다. 그래서 이 파일이 폰의 유일한 문장 창고이고, 코어에 공용 자리가 생기면
// 여기서 그리로 옮긴다. 화면·테스트는 모두 이 상수만 읽는다(문장을 베끼지 않는다).
//
// 「모르면 모른다고 말한다」: 실패를 「기억이 없다」로, 준비 중을 「요약할 게 없다」로
// 바꿔 말하지 않는다. 각 상태는 다른 문장을 든다.
// =============================================================================

export const MISSED_TITLE = '안 읽은 동안';
export const MISSED_DISMISS_LABEL = '닫기';
export const MISSED_DISMISS_A11Y = '안 읽은 동안 요약 닫기';
export const MISSED_MORE = '더 보기';
export const MISSED_LOADING = '안 읽은 대화를 요약하고 있어요.';
export const MISSED_ERROR = '요약을 불러오지 못했어요.';
export const MISSED_RETRY = '다시 시도';
export const MISSED_NOT_SUMMARIZED =
  '아직 요약을 만들지 못했어요. 만들어지면 여기에 보여 줄게요.';
export const MISSED_EMPTY = '요약할 만큼 쌓인 대화가 아직 없어요.';
export const MISSED_PARTIAL = '가장 최근 대화는 아직 요약하지 못했어요.';
export const EVIDENCE_LABEL = '근거';

export type MissedOffCause =
  | 'workspace'
  | 'workspacePaused'
  | 'channel'
  | 'channelPaused'
  | 'me';

export const MISSED_OFF: Readonly<Record<MissedOffCause, string>> = {
  workspace: '이 워크스페이스는 기억 기능을 꺼 두었어요.',
  workspacePaused: '팀 기억이 잠시 멈춰 있어서 요약을 만들지 않아요.',
  channel: '이 채널은 요약에서 빠져 있어요.',
  channelPaused: '이 채널의 요약이 잠시 멈춰 있어요.',
  me: '내 기억 일시정지가 켜져 있어서 요약을 보여 주지 않아요.',
};

export function evidenceLabel(index: number): string {
  return `${EVIDENCE_LABEL} ${index}`;
}

export function evidenceA11y(index: number): string {
  return `${index}번 근거 메시지로 이동`;
}

export function evidenceMore(rest: number): string {
  return `외 ${rest}개`;
}

// ---- 「기억 n개 참고」 칩 ------------------------------------------------------

export function receiptChipLabel(count: number): string {
  return `기억 ${count}개 참고`;
}

export function receiptChipA11y(count: number): string {
  return `기억 ${count}개 참고, 눌러서 목록 보기`;
}

export const RECEIPT_SHEET_TITLE = '이 답에 참고한 기억';
export const RECEIPT_CLOSE = '닫기';
export const RECEIPT_CLOSE_A11Y = '기억 목록 닫기';
export const RECEIPT_ONLY_READABLE = '이 목록에는 내가 볼 수 있는 기억만 나와요.';

export function receiptSheetSummary(count: number): string {
  return `기억 ${count}개를 참고해서 답했어요.`;
}

export function withheldLine(count: number): string {
  return `이 채널이라 싣지 않은 기억 ${count}개`;
}

export const WITHHELD_EXPLAIN =
  '질문한 사람은 볼 수 있지만 이 채널의 모든 멤버가 볼 수는 없어서, 답에는 싣지 않았어요. 내용은 보여 주지 않고 개수만 알려 줘요.';

export function digestSourceLine(sourceCount: number): string {
  return `대화 ${sourceCount}개를 요약했어요`;
}

// ---- 개인 일시정지 (프로필 시트) ---------------------------------------------

export const MEMORY_SECTION = '기억';
export const MEMORY_PAUSE_LABEL = '내 기억 일시정지';
export const MEMORY_PAUSE_DETAIL_OFF =
  '켜 두면 새 기억을 모으지도, 에이전트 답에 싣지도 않아요. 이미 있는 기억은 지우지 않고 그대로 둬요.';
export const MEMORY_PAUSE_DETAIL_ON =
  '지금 멈춰 있어요. 끄면 다시 요약하고 답에 실어요.';
export const MEMORY_PAUSE_WORKSPACE_OFF =
  '지금은 팀 설정에서 기억이 꺼져 있어요.';
export const MEMORY_PAUSE_LOAD_FAILED = '기억 설정을 불러오지 못했어요.';
export const MEMORY_PAUSE_SAVE_FAILED =
  '바꾸지 못했어요. 연결을 확인하고 다시 눌러 주세요.';
export const MEMORY_PAUSE_RETRY = '다시 불러오기';
export const MEMORY_ADMIN_ROW = '팀·채널 기억 설정';
export const MEMORY_ADMIN_DETAIL =
  '팀 전체 스위치와 채널별 제외는 데스크탑에서 바꿀 수 있어요.';
export const MEMORY_PAUSE_CHECKING = '기억 설정을 확인하고 있어요.';
