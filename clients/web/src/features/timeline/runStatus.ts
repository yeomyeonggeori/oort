import type { AgentRunProgress, Message } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

/** 빈 목록 하나를 돌려 쓴다: 행 props가 매 렌더 새 배열로 바뀌어 행이 다시 그려지지 않게 한다. */
export const NO_RUNS: readonly AgentRunProgress[] = [];

/**
 * 한 메시지 행에 내려줄 「이 메시지가 일으킨 run들」. 타임라인이 채널의 run을 한 번 모아 `runsByMessage`로 만들고(행마다
 * 스토어를 구독하면 가상 목록 전체가 다시 그려진다) 이 함수로 행마다 골라 준다.
 *
 * 규칙 (#4619 planner 결정 2):
 *   - 대화 표면(행 동작이 있는 곳, `myMemberId`가 있는 곳)에서만 선다. 스레드 패널·검색 결과 같은 곳은 undefined다.
 *   - 에이전트를 부른 **사람**의 메시지면 **누구의 것이든** run을 준다. 레일은 채널 전체의 일을 말하는데 칩이 내 요청에만
 *     있으면 남이 부른 일이 어디까지 갔는지는 아무 데도 없다.
 *   - 에이전트가 쓴 글은 사람이 부른 일이 아니다: undefined.
 *   - 내가 방금 보낸 메시지는 run이 아직 없어도 **빈 목록**을 준다: 행이 슬롯을 세우고 진행을 한 번 당겨 읽어 칩이 1초 안에
 *     서게 한다(`MessageRunStatus`). 남의 메시지는 run이 있을 때만 슬롯이 선다 — 남의 새 메시지마다 채널 읽기가 돌지 않는다.
 */
export function runStatusForMessage(options: {
  message: Pick<Message, "id" | "authorMemberId">;
  myMemberId: string | undefined;
  directory: Directory;
  runsByMessage: ReadonlyMap<string, readonly AgentRunProgress[]>;
}): readonly AgentRunProgress[] | undefined {
  const { message, myMemberId, directory, runsByMessage } = options;
  if (myMemberId === undefined) return undefined;
  if (memberFor(directory, message.authorMemberId)?.kind === "agent") return undefined;
  const runs = runsByMessage.get(message.id.toLowerCase());
  if (runs !== undefined) return runs;
  return uuidEq(message.authorMemberId, myMemberId) ? NO_RUNS : undefined;
}
