import {
  typingLabel,
  typingSentence,
} from "@momo/core/features/chat/typing";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「작성 중」 한 줄 (ADR-0149 · goal B3 W2).
//
// ## 왜 작업 중 줄 **바로 위**인가
//
// 이 줄과 `AgentActivityBar`(「김인턴이 작업 중」)는 같은 종류의 정보다: **지금 이
// 채널에서 누가 무엇을 하고 있나.** 그래서 한 구역에 함께 두고, 사람을 위에 둔다.
//
// 이 배치가 어휘 경계를 지키는 방식이 요점이다. 패킷은 「작성 중」과 「작업 중」의
// 혼용을 이 배치 최악의 회귀로 꼽는데, 두 줄을 **떨어뜨려** 두면 각자는 그냥 「무언가
// 진행 중」으로 읽히고 사람은 그 차이를 배울 기회가 없다. 나란히 두면 차이가 화면에서
// 대조되고, 두 줄이 실제로 다른 모양이라는 것도 함께 읽힌다:
//
//   | | 작성 중 (사람) | 작업 중 (에이전트) |
//   |---|---|---|
//   | 시계 | 없다 | 경과 시간이 붙는다 |
//   | 누를 수 있나 | 아니다 | 작업 패널이 열린다 |
//   | 이름 색 | 사람의 잉크 | `--agent` |
//   | 사라지는 법 | 6초 TTL, 스스로 | 턴이 끝나면 |
//
// ## live 영역이 아니다
//
// `aria-live`를 걸지 않는다. 작성 중은 3초마다 갱신되는 신호이고, live 영역에 두면
// 보조기술이 남이 타이핑하는 동안 같은 문장을 계속 낭독한다 — 작업 패널의 1Hz 시계를
// live 영역 **바깥**으로 뺀 것과 정확히 같은 판단이다(gate-work-panel의 live 시나리오).
// 문장은 DOM에 있으므로 읽으려는 사람은 언제든 읽을 수 있고, 강제로 끼어들지 않는다.
// =============================================================================

export function TypingLine({
  memberIds,
  threshold,
  directory,
}: {
  /** 지금 작성 중인 사람들. 이미 나·에이전트·만료분이 걸러져 있다. */
  memberIds: string[];
  /** 서버가 말한 뭉치기 임계 (grant 응답). */
  threshold: number;
  directory: Directory;
}) {
  // 이름을 못 찾은 사람은 코어의 `isEligible`이 이미 떨궜다. 그래도 여기서 한 번 더
  // 좁히는 이유는 명부가 그 사이에 갱신될 수 있기 때문이고, 「누군가 작성 중」은
  // 나르는 정보가 0이라 그리지 않는 편이 낫다.
  const names = memberIds
    .map((id) => memberFor(directory, id)?.displayName)
    .filter((name): name is string => Boolean(name));
  const sentence = typingSentence(names, threshold);
  if (sentence === null) return null;
  return (
    <p
      className="truncate px-4 pb-2 text-meta text-ink-muted"
      // 자리를 비워 두지 않는다. 「아무도 작성 중이 아님」은 문장이 아니고, 빈 줄
      // 하나를 상시 예약하면 조용한 채널에서 컴포저가 8px 죽은 공간을 얻는다.
      // (라우팅 줄이 자리를 예약하는 것과 다른 이유: 그 줄은 **이 글**에 적용되는
      // 값이라 쓰는 중에 붙었다 떨어지면 캐럿 아래가 흔들린다. 이 줄은 남의 일이다.)
      data-testid="composer-typing"
      data-count={memberIds.length}
      title={typingLabel(names, threshold) ?? undefined}
    >
      {sentence}
    </p>
  );
}
