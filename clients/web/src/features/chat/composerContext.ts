import type { RosterMember } from "@momo/core/lib/api";

// 맥락 띠가 싣는 것 (#4317). 띠는 입력창 카드 맨 위에 붙어 **지금 이 글이 무엇에 딸린 것인지**를 말하고,
// 실을 것이 없으면 서지 않는다. 이 파일은 순수 판정만 든다.

export interface ComposerContextHost {
  /** 에이전트 호스트가 Agent Port 에 닿아 있는가(명부의 `hostOnline`, 추정). */
  online: boolean;
  text: string;
}

export const COMPOSER_CONTEXT_HOST_ONLINE = "일하는 곳 · 연결됨";
export const COMPOSER_CONTEXT_HOST_OFFLINE = "일하는 곳 · 연결 안 됨";

/**
 * 에이전트 DM 의 「이 에이전트가 일하는 곳」 칩. 이미 있는 정보(`hostOnline`)만 쓴다: 명부에 호스트
 * 이름은 없다. 값이 없는 서버·손님(`undefined`)이면 칩도 없다 — 모르는 것을 연결 안 됨으로 말하지 않는다.
 */
export function composerContextHost(
  dmAgent: Pick<RosterMember, "kind" | "hostOnline"> | null
): ComposerContextHost | null {
  if (dmAgent === null || dmAgent.kind !== "agent") return null;
  if (typeof dmAgent.hostOnline !== "boolean") return null;
  return dmAgent.hostOnline
    ? { online: true, text: COMPOSER_CONTEXT_HOST_ONLINE }
    : { online: false, text: COMPOSER_CONTEXT_HOST_OFFLINE };
}

/** 띠가 서는가: 인용 중이거나 호스트 칩이 있을 때. */
export function composerContextBandShows(options: {
  quoting: boolean;
  host: ComposerContextHost | null;
}): boolean {
  return options.quoting || options.host !== null;
}
