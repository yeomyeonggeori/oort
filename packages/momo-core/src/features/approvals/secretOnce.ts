// =============================================================================
// 결정 응답의 `result` — 1회 시크릿이 사는 **유일한** 자리 (ADR-0186 D4 · 부록 C)
//
// 승인이 성공하면 서버는 영수증에 `result` 를 얹어 보낸다. 그 안의
// `secretOnce.value` 는 초대 링크 같은 1회 값이고, 그 값이 존재하는 곳은
// 이 HTTP 응답 본문 하나뿐이다: `approval.payload` 에도, 메시지 props 에도,
// 감사 행에도, 로그에도, outbox 에도 없다(D4 가 서버 쪽에 건 규율).
//
// ## 그래서 이 모듈은 값을 **돌려줄 뿐 아무 데도 두지 않는다**
//
// 이 파일에는 저장소가 없다. 모듈 스코프 변수도, 캐시도, 마지막 값 기억도 없다.
// 호출자가 받은 것을 React 상태에 두고 언마운트와 함께 잃는 것이 D4 의
// 클라이언트 절반이고, 그 절반을 지키는 가장 확실한 방법은 **여기에 둘 자리를
// 만들지 않는 것**이다. 값을 새로고침에 살아남게 하려고 어딘가에 쓰는 구현은
// ADR 이 이름으로 적어 둔 위반이다.
//
// 영속 카드(부록 B)는 이 값을 갖지 않는다. 그 카드가 아는 것은 「한 번 보여
// 줬다」는 이력과 다시 만들 수 있는 문 하나뿐이다(`actionResultCard`).
//
// ## 총 파싱
//
// 모양이 어긋나면 `null` 이다. 반쯤 읽은 시크릿은 링크가 아니라 **잘린 문자열**
// 이고, 화면에 세우면 사람이 그것을 복사해 붙여 넣고 실패한다. 없는 것이 낫다 —
// 없으면 영속 카드의 「다시 만드세요」가 그대로 답이 된다.
// =============================================================================

/**
 * 1회 값. `kind` 는 서버가 붙인 갈래이고(`invite_link` 등) 이 빌드는 그것을
 * 해석하지 않는다 — 화면이 하는 일은 값을 보여 주고 복사시키는 것뿐이라, 모르는
 * 갈래라고 해서 보여 주지 못할 이유가 없다.
 */
export interface SecretOnce {
  kind: string;
  value: string;
  /** 이 값이 쓸모를 잃는 시각. 서버가 실었을 때만 있다. */
  expiresAtMs: number | null;
}

/** 결정이 실제로 **무엇을 했는가**. 이것도 응답에만 있다. */
export interface DecisionActionResult {
  actionId: string;
  ref: { type: string; id: string } | null;
  secretOnce: SecretOnce | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseRef(value: unknown): { type: string; id: string } | null {
  if (!isRecord(value)) return null;
  const type = nonEmptyString(value.type);
  const id = nonEmptyString(value.id);
  return type !== null && id !== null ? { type, id } : null;
}

export function parseSecretOnce(value: unknown): SecretOnce | null {
  if (!isRecord(value)) return null;
  const kind = nonEmptyString(value.kind);
  const secret = nonEmptyString(value.value);
  if (kind === null || secret === null) return null;
  const expiresAtMs = value.expiresAtMs;
  return {
    kind,
    value: secret,
    expiresAtMs:
      typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)
        ? expiresAtMs
        : null,
  };
}

/**
 * 영수증의 `result` 블록을 읽는다. 없거나 모양이 어긋나면 `null`.
 *
 * `actionId` 가 없으면 블록이 아니다. 어느 행동의 결과인지 모르면서 시크릿만
 * 그리면, 화면은 사람에게 **무엇의 링크인지 모르는 링크**를 준다.
 */
export function parseDecisionResult(value: unknown): DecisionActionResult | null {
  if (!isRecord(value)) return null;
  const actionId = nonEmptyString(value.actionId);
  if (actionId === null) return null;
  return {
    actionId,
    ref: parseRef(value.ref),
    secretOnce: parseSecretOnce(value.secretOnce),
  };
}
