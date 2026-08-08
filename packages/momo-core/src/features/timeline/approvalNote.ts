// =============================================================================
// 승인 카드가 컨트롤 대신 말하는 한 줄 — 무엇을 말하고, 어떤 격으로 말하는가
// (design-review U4-4 M-3).
//
// ## 리뷰가 실측한 것
//
// *"세 문장이 전부 같은 옷을 입는다. 영수증(`승인을 기록했습니다.`), 안내(`이
// 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.`), 오프라인 문장이 모두
// `styles.cardNote`다. 성격이 셋 다 다르다 — 하나는 **내가 방금 한 되돌릴 수 없는
// 행동의 영수증**, 하나는 길 안내, 하나는 일시적 차단. (…) 카드에서 가장 값어치
// 있는 문장인 영수증이 가장 조용한 차림으로 나온다."*
//
// 웹도 같았다(실측 U4-6W): `AgentCard.tsx` 의 영수증(`approval-note`)·재개 제안
// 설명(`resume-offer-note`)·원장 없음 고지(`approval-unsupported`)가 전부
// `text-meta text-ink-muted` 한 벌이다. 게다가 웹에는 **오프라인 문장이 아예
// 없었다** — 연결이 끊긴 채로 승인 버튼이 그대로 서 있고, 누르면 나가지 않는다.
//
// ## 왜 판정이 코어인가
//
// 고쳐야 할 것이 둘이고 성질이 다르다:
//
//   1. **무엇을 말하는가** — 영수증이 먼저인가 오프라인이 먼저인가, 컨트롤은 언제
//      서는가. 이것은 순수한 판정이고 두 클라가 갈라지면 같은 상황에서 다른 문장을
//      말한다. 폰이 이미 이 순서를 실측으로 얻었다(*"영수증이 컨트롤보다 **먼저**
//      온다: 결정한 순간 그 승인은 대기 목록에서 빠져 `approval` 이 `null` 이 되므로,
//      순서를 반대로 두면 방금 누른 사람이 영수증 대신 예전 안내 문장을 보게 된다"*).
//      그 순서가 폰 파일 안의 삼항 연산자 사슬로만 존재하면 웹이 그것을 다시 짓는다.
//   2. **어떤 격으로 말하는가** — 여기서는 `tone` 이름과 그 **순서**만 정한다. 굵기·
//      색·크기는 각 클라의 팔레트가 정할 일이고, 코어가 `text-body` 같은 것을 알면
//      그때부터 코어가 화면이 된다.
//
// ## 격의 순서 (`APPROVAL_NOTE_TONE_ORDER`)
//
//     receipt > blocked > guidance
//
//   * `receipt` — **방금 내가 한, 되돌릴 수 없는 행동의 기록.** 이 카드에서 가장
//     값어치 있는 문장이고, 읽는 사람이 다시 확인하러 돌아오는 문장이다. 격상되는
//     것이 이 톤이다.
//   * `blocked` — 지금은 못 한다. 사고가 아니라 **때**의 문제이므로 위험 색이
//     아니지만, 조용한 안내로 묻히면 사람이 버튼을 계속 누른다. 가운데.
//   * `guidance` — 길 안내. 읽으면 좋고 안 읽어도 잃는 것이 없다. 가장 조용하다.
//
// 셋이 한 카드에 동시에 서는 일은 없다(아래 판정이 하나만 고른다). 순서가 필요한
// 이유는 **같은 카드를 시간축으로 볼 때** 격이 뒤집히면 안 되기 때문이다: 오프라인
// 이었다가 온라인이 되어 결정하면 `blocked` → `receipt` 로 올라가야지 내려가면
// 안 된다.
// =============================================================================

/** 문장이 지는 격. 값이 아니라 순서다 — 굵기·색은 각 클라가 정한다. */
export type ApprovalNoteTone = "receipt" | "blocked" | "guidance";

/** 격의 순서. 앞이 셀수록 앞으로 나온다. 클라의 계약 테스트가 이 배열을 읽는다. */
export const APPROVAL_NOTE_TONE_ORDER: readonly ApprovalNoteTone[] = [
  "receipt",
  "blocked",
  "guidance",
];

/** 0이 가장 앞. 두 톤의 격을 비교해야 하는 자리(테스트·회귀 가드)를 위한 것. */
export function approvalNoteRank(tone: ApprovalNoteTone): number {
  return APPROVAL_NOTE_TONE_ORDER.indexOf(tone);
}

/**
 * 카드가 말하는 줄의 종류.
 *
 * `kind` 와 `tone` 을 나누는 이유: 종류는 **왜 이 줄이 섰는가**이고 톤은 **얼마나
 * 앞으로 나오는가**다. 지금은 안내 셋이 같은 톤을 쓰지만, 그 셋이 서는 이유는
 * 서로 다르고 테스트·게이트는 이유로 지목해야 한다.
 */
export type ApprovalNoteKind =
  | "receipt"
  | "offline"
  | "elsewhere"
  | "unsupported"
  | "resume-offer";

export interface ApprovalCardNote {
  kind: ApprovalNoteKind;
  tone: ApprovalNoteTone;
  text: string;
}

export interface ApprovalCardNoteInput {
  /**
   * 원장이 방금 답해 준 영수증 문장. 있으면 이 사람은 **이미 결정했다**.
   *
   * 문장 자체는 결정 결과에서 오므로(`DecisionOutcome.note`) 여기서 짓지 않는다 —
   * 서버가 무엇을 기록했는지는 서버가 말한다.
   */
  receiptNote?: string | null;
  /** 재개 제안 카드인가. 승인할 대상이 아예 없는 종류다(`approvalId === null`). */
  isResumeOffer?: boolean;
  /** 재개 제안이 설명할 문장. 화면이 들고 있다. */
  resumeOfferText?: string | null;
  /**
   * 이 승인이 **이미 끝났는가**(스냅샷 또는 원장 기준).
   *
   * `pendingHere`와 갈라 두는 것이 load-bearing이다. 끝난 결정에 「인박스나
   * 데스크톱에서 처리하세요」를 붙이면 그것은 거짓 안내다 — 처리할 것이 없다.
   * 끝난 카드가 할 말은 원장 줄(누가·언제·원장 #xxxx)이 이미 하고 있다.
   */
  settled: boolean;
  /** 이 카드에 결정할 대상이 있는가(`approvalId !== null`). */
  hasTarget: boolean;
  /**
   * **이 표면에서** 지금 결정할 수 있는가 — 원장이 「지금도 대기」라고 말하는가.
   *
   * 폰은 대기 승인 목록으로 답하고(다른 데서 이미 결정된 건은 목록에서 빠진다),
   * 웹의 타임라인 카드는 그 목록을 구독하지 않으므로 스냅샷이 대기이면 참이다.
   * 두 클라의 답이 다른 것은 아는 것이 다르기 때문이지 규칙이 다르기 때문이
   * 아니다 — 규칙은 이 함수 하나다.
   */
  pendingHere: boolean;
  /** 이 기기가 지금 결정을 보낼 수 있는가. */
  offline: boolean;
  /** 이 서버에 승인 원장 표면이 있는가. 없으면 버튼은 결코 성공하지 못한다. */
  approvalsProvided?: boolean;
  /** 표면 부재를 설명하는 문장. 화면이 들고 있다(웹 `serverSurface`). */
  unsupportedText?: string | null;
}

/**
 * 연결이 끊겼을 때 승인 컨트롤 자리에 서는 문장.
 *
 * 폰이 `features/inbox/useOnline.ts` 에서 landing 시킨 문장 **그대로**다. 두 클라가
 * 같은 상수를 들어야 같은 상황에 같은 말을 한다 — 그 파일 주석이 적은 이유가
 * 그것이고, 이제 그 「두 화면」이 두 클라가 됐다.
 */
export const APPROVAL_OFFLINE_COPY =
  "연결이 끊겨 지금은 결정할 수 없습니다. 다시 연결되면 여기서 승인하거나 거부할 수 있습니다.";

/** 이 표면에서는 결정할 수 없고 다른 자리가 있는 경우. 폰의 문장 그대로. */
export const APPROVAL_ELSEWHERE_COPY =
  "이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.";

/**
 * 카드가 컨트롤 대신 말할 줄. `null`이면 **컨트롤을 세우거나, 할 말이 없다**.
 *
 * 순서가 곧 계약이고, 각 단계는 「왜 여기 컨트롤이 없는가」에 답한다:
 *
 *   1. **영수증이 가장 먼저.** 결정한 순간 그 승인은 대기 목록에서 빠지므로
 *      `pendingHere`가 거짓이 된다. 영수증을 뒤에 두면 방금 누른 사람이 자기 영수증
 *      대신 「다른 데서 하세요」를 읽는다 (폰이 실측한 순서).
 *   2. **재개 제안은 승인이 아니다.** 승인할 대상이 없는 카드에 승인 문장을 붙이면
 *      그 문장이 무엇에 대한 말인지 아무도 모른다.
 *   3. **끝난 결정은 할 말이 없다.** 원장 줄이 이미 누가·언제·어느 기록인지 말한다.
 *      여기에 안내를 얹으면 처리할 것이 없는데 처리하러 가라고 하는 셈이다.
 *   4. **결정할 대상이 없으면** 역시 할 말이 없다. 승인할 것이 없는 카드에 승인
 *      안내를 붙이면 그 안내가 무엇을 가리키는지 아무도 모른다.
 *   5. **원장 없는 서버.** 버튼을 세우면 결코 성공할 수 없는 요청이 나가고 화면은
 *      그 404를 원장의 답인 양 읽는다. 카드는 남기고 컨트롤만 지운다.
 *   6. **이 표면에서는 결정할 수 없다** → 길 안내. **자리**의 문제다.
 *   7. **결정할 수 있는데 지금 못 보낸다** → 오프라인. **때**의 문제다. 두 문장이
 *      달라야 하는 이유가 이 둘의 차이다.
 *   8. → `null`, 컨트롤이 선다.
 *
 * 5가 6·7보다 앞인 이유: 원장이 없는 서버에서는 다른 자리로 가도, 온라인이 되어도
 * 아무 일도 일어나지 않는다. 그 서버에서 「인박스에서 처리하세요」와 「다시
 * 연결되면 여기서」는 둘 다 거짓말이다.
 */
export function approvalCardNote(
  input: ApprovalCardNoteInput
): ApprovalCardNote | null {
  const receipt = input.receiptNote?.trim();
  if (receipt) {
    return { kind: "receipt", tone: "receipt", text: receipt };
  }
  if (input.isResumeOffer === true) {
    const text = input.resumeOfferText?.trim();
    return text ? { kind: "resume-offer", tone: "guidance", text } : null;
  }
  if (input.settled || !input.hasTarget) return null;
  if (input.approvalsProvided === false) {
    const text = input.unsupportedText?.trim();
    return {
      kind: "unsupported",
      tone: "guidance",
      text: text ? text : APPROVAL_ELSEWHERE_COPY,
    };
  }
  if (!input.pendingHere) {
    return {
      kind: "elsewhere",
      tone: "guidance",
      text: APPROVAL_ELSEWHERE_COPY,
    };
  }
  if (input.offline) {
    return { kind: "offline", tone: "blocked", text: APPROVAL_OFFLINE_COPY };
  }
  return null;
}
