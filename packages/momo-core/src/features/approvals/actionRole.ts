import { DEFAULT_ROLE_LABELS, ROLE_KEYS, type RoleKey } from "../directory/model";
import { attachParticle } from "../../lib/koreanParticle";

// =============================================================================
// 「누가 결정할 수 있는가」의 낱말 (ADR-0186 부록 A `required_role` · §5 의 403)
//
// 역할 이름을 여기서 새로 짓지 않는다. 디렉터리가 이미 그 표를 갖고 있고
// (`DEFAULT_ROLE_LABELS`), 멤버 목록·설정·이 카드가 같은 사람을 다른 낱말로
// 부르면 사람은 서로 다른 권한 체계가 둘 있다고 읽는다.
//
// ## 403 을 이 파일이 지는 이유
//
// 서버의 오류 봉투에는 코드 칸이 없고(`ErrorResponse` = `{error:{message}}`),
// 부록 A~C·E 는 `role_required` 를 실어 보내는 필드를 고정하지 않았다. 그래서
// 전송 계층은 403 을 `forbidden` 이라고만 말하고(`approvalDecision.ts`), **무엇이
// 모자랐는지는 카드가 이미 아는 사실**로 판정한다: 부록 A 의 `required_role` 이
// 실린 승인이 403 을 받았다면 모자란 것은 역할이다.
//
// 그 판정을 화면이 아니라 여기서 하는 이유는 폰(AX-7)이 같은 403 을 같은 문장으로
// 말해야 하기 때문이다. 문장이 두 파일에 있으면 한쪽만 고쳐지는 날이 온다.
// =============================================================================

function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/**
 * 이 빌드가 **이름을 아는** 역할인가.
 *
 * 문장이 갈라지는 자리다(R1 N5). 아는 역할에는 한글 이름이 있으므로 조사를 붙인
 * 문장이 읽히고, 모르는 값은 서버의 원문 토큰이라 그 뒤에 조사를 붙이면
 * 「member가 승인해야 합니다」가 된다 — 조사는 맞는데(`attachParticle` 이
 * 라틴 끝도 옳게 읽는다) **낱말이 한국어 문장의 주어 자리에 설 수 없다**.
 * 그래서 모르는 값은 조사 없이, 원문임이 드러나는 자리에 둔다.
 */
function isKnownRole(role: string): boolean {
  return isRoleKey(role);
}

/**
 * 역할의 사람 이름. 모르는 역할은 **원문 그대로** 지나간다 — 서버가 내일 역할을
 * 하나 더 만들어도 화면이 그것을 감추지 않는다(`TIER_LABEL` 과 같은 규율).
 */
export function roleDisplayName(role: string): string {
  return isRoleKey(role) ? DEFAULT_ROLE_LABELS[role] : role;
}

/**
 * 결정 전에 미리 말하는 줄: 이 행동은 누가 승인할 수 있는가.
 *
 * 「만」은 받침을 타지 않는 보조사라 모르는 토큰 뒤에서도 문장이 깨지지 않는다.
 * 그래서 이 한 줄만은 아는 역할과 모르는 역할이 같은 모양을 쓴다.
 */
export function approvalRoleCopy(role: string): string {
  return `${roleDisplayName(role)}만 승인할 수 있습니다.`;
}

/**
 * 무장 줄의 확정 문장 — **행동 승인일 때만** (R1 M2).
 *
 * 기본 문장("승인하면 에이전트가 이어서 진행합니다.")은 도구 호출 승인의 것이고,
 * 거기서는 참이다: 승인이 park 된 run 을 다시 큐에 넣고 에이전트가 이어서 간다.
 * **행동 승인은 그렇지 않다.** 제안한 turn 은 이미 끝났고(ADR-0186 D2 run park),
 * 승인하면 **서버가 결정자 권한으로** 실행한다. 에이전트는 이 제안으로 돌아오지
 * 않는다. 같은 문장을 두 갈래에 쓰면 그중 하나는 반드시 거짓이다.
 *
 * 무엇을 만드는지까지 말하지 않는 이유: 그것은 서버가 이미 카드의 `summary` 에
 * 적어 보냈고(부록 A: 「승인하면 관리자 권한으로 초대 링크를 만듭니다」), 그 줄은
 * 확정 화면에서도 카드 위에 그대로 서 있다. 이 자리에서 다시 지어 말하면 행동이
 * 늘 때마다 클라이언트가 서버의 문장을 두 번째로 쓰게 된다.
 */
export function actionApproveConfirmCopy(requiredRole: string | null): string {
  if (requiredRole === null || !isKnownRole(requiredRole)) {
    return "승인하면 서버가 이 행동을 실행합니다.";
  }
  return `승인하면 서버가 ${roleDisplayName(requiredRole)} 권한으로 이 행동을 실행합니다.`;
}

/**
 * 403 뒤에 카드 안에 서는 문장 (이슈 #2510 수용기준의 「관리자가 승인해야 합니다」).
 *
 * 두 번째 문장이 **다음 행동**이다. 「권한이 없습니다」로 끝내면 사람은 자기가
 * 무엇을 하면 되는지 모른 채 남고, 그 자리에서 하는 일은 같은 버튼을 다시
 * 누르는 것이다.
 */
const STILL_PENDING =
  "이 요청은 아직 대기 중이니 결정할 수 있는 사람에게 알려 주세요.";

export function roleRequiredCopy(role: string): string {
  if (!isKnownRole(role)) {
    // 원문 토큰은 주어가 되지 못한다(위 `isKnownRole` 참고). 조사를 붙이는 대신
    // 「역할」이라는 한국어 낱말에 조사를 달고, 서버가 보낸 값은 그 앞에 둔다.
    return `승인하려면 ${role} 역할이 필요합니다. ${STILL_PENDING}`;
  }
  return `${attachParticle(roleDisplayName(role), "subject")} 승인해야 합니다. ${STILL_PENDING}`;
}
