import { ApiError } from "../../lib/api";
import { AGENT_USAGE_COPY } from "./agentUsage";

/**
 * 구독 정액 저장 실패의 문장 (#4986). 원인이 달라도 한 문장이면 권한이 없는 사람에게 「다시 시도」를 권한다.
 * 상태가 403(권한)·409(다른 곳에서 바뀜)이면 그 말을 하고, 그 밖(연결·서버)만 일반 문장이다.
 *
 * `agentUsage.ts` 에 두지 않은 까닭: 비용 서식을 한 곳으로 모으는 같은 파일의 다른 수리(#4982)와 줄이 겹치지 않게.
 */
export function subscriptionSaveError(error: unknown): string {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 403) return AGENT_USAGE_COPY.saveForbidden;
  if (status === 409) return AGENT_USAGE_COPY.saveConflict;
  return AGENT_USAGE_COPY.saveError;
}
