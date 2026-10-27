import type { RosterMember } from "@momo/core/lib/api";
import { routineWaitText, type RoutineHint } from "@momo/core/features/agents/runWaiting";

// 맥락 띠가 싣는 것 (#4317). 띠는 입력창 카드 맨 위에 붙어 **지금 이 글이 무엇에 딸린 것인지**를 말하고,
// 실을 것이 없으면 서지 않는다. 이 파일은 순수 판정만 든다.

export interface ComposerContextHost {
  /** 에이전트 호스트가 Agent Port 에 닿아 있는가(명부의 `hostOnline`, 추정). */
  online: boolean;
  text: string;
  /** 루틴형 에이전트의 「다음 확인을 기다리는 중」이다(연결이 꺼진 것이 아니다, #4621). */
  routine?: true;
}

export const COMPOSER_CONTEXT_HOST_OFFLINE = "일하는 곳 · 연결 안 됨";

/**
 * 에이전트 DM 의 「이 에이전트가 일하는 곳」 칩. 이미 있는 정보(`hostOnline`)만 쓴다: 명부에 호스트
 * 이름은 없다. 값이 없는 서버·손님(`undefined`)이면 칩도 없고, 연결됨이면 정상이라 칩이 없다 — 모르는 것을 연결 안 됨으로 말하지 않는다.
 *
 * `routine`(에이전트의 확인 박자, #4621): 루틴형 에이전트는 실시간으로 연결돼 있지 않고 정해진 간격으로
 * 깨어난다. 그런 에이전트에게 「연결 안 됨」은 사실이 아니라(꺼진 것이 아니라 다음 확인을 기다리는 중)
 * 「다음 확인 때 가져가요(보통 N분 안)」로 말한다. 서버가 박자를 내려주기 전에는 호출부가 넘기지 않는다
 * (지어내지 않는다).
 */
export function composerContextHost(
  dmAgent: Pick<RosterMember, "kind" | "hostOnline"> | null,
  routine?: Pick<RoutineHint, "typicalMinutes">
): ComposerContextHost | null {
  if (dmAgent === null || dmAgent.kind !== "agent") return null;
  if (typeof dmAgent.hostOnline !== "boolean") return null;
  // 정상(연결됨)은 입력창에서 되풀이하지 않는다(#4044): 연결 안 됨일 때만 칩이 선다.
  if (dmAgent.hostOnline) return null;
  if (routine !== undefined) {
    return { online: false, text: routineWaitText(routine), routine: true };
  }
  return { online: false, text: COMPOSER_CONTEXT_HOST_OFFLINE };
}

/** 띠가 서는가: 인용 중이거나 호스트 칩이 있을 때. */
export function composerContextBandShows(options: {
  quoting: boolean;
  host: ComposerContextHost | null;
}): boolean {
  return options.quoting || options.host !== null;
}
