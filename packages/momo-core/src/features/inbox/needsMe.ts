// =============================================================================
// 「나에게 필요한 일」 수 (#3337, 사이드바·알림 시안 §1.1). 순수 판정.
//
// 이 수는 인박스의 배지·헤더, 레일 배지, 이후 독 배지·접힘 합산 알약이 **모두**
// 같은 값을 읽는 단일 출처다. 화면마다 자기 합을 갖는 순간 레일은 3, 인박스는 4를
// 말하기 시작한다(#2776 이전의 `useMentionCount`만 센 배지가 그 사고였다).
//
// 정의 (세 출처의 합, 각 출처 안에서 id로 중복 제거):
//   ① 결정 대기: 내가 결정할 수 있는 대기 승인. 승인 id로 센다.
//   ② 응답 필요: 이 기기(데스크탑)의 로컬 칸 중 입력을 기다리는 칸. 칸 id로 센다.
//      「끝남」은 일어난 일이지 해야 할 일이 아니므로 세지 않는다.
//   ③ 안 읽은 멘션: 서버 read-state 투영의 멘션 수(서버가 센 수를 그대로).
// 리마인더는 인박스 탭의 일이지만 이 수에는 넣지 않는다(결재 범위: 승인+응답 필요+멘션).
//
// 일반 안 읽음(호박 알약)과 활동(일어난 일 기록)은 이 수에 들어오지 않는다.
// =============================================================================

export interface NeedsMeInput {
  /** 내가 결정할 수 있는 대기 승인의 id. 같은 id가 두 번 와도 한 번만 센다. */
  decidableApprovalIds: readonly string[];
  /** 입력을 기다리는(waiting) 로컬 칸의 id. 웹에서는 빈 배열이다. */
  waitingPaneIds: readonly string[];
  /** 서버가 센 안 읽은 멘션 합. */
  unreadMentions: number;
}

export interface NeedsMe {
  approvals: number;
  panes: number;
  mentions: number;
  total: number;
}

export function needsMe(input: NeedsMeInput): NeedsMe {
  const approvals = new Set(input.decidableApprovalIds).size;
  const panes = new Set(input.waitingPaneIds).size;
  const mentions =
    Number.isFinite(input.unreadMentions) && input.unreadMentions > 0
      ? Math.floor(input.unreadMentions)
      : 0;
  return { approvals, panes, mentions, total: approvals + panes + mentions };
}
