import {
  typingLabel,
  typingSegments,
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
//   | 이름 색 | `--ink` (사람의 잉크) | `--agent` |
//   | 이름 뒤 | 「님」 | 없다 |
//   | 사라지는 법 | 6초 TTL, 스스로 | 턴이 끝나면 |
//
// **셋째 축은 문서였다가 이제 마크업이다** (design-review PR 1059 M-1). 1차는 문장
// 전체를 `text-ink-muted` 하나로 칠하면서 표에 「이름 색」을 적어 뒀다 — 없는 축을
// 주장한 것이다. 그 축이 없으면 **작업 중 줄이 없을 때**(에이전트 턴이 없는 대부분의
// 시각) 사람 줄이 가진 단서는 한 음절과 「님」뿐이고, 위 배치의 논지 자체가 그 상태를
// 기본값으로 만든다. 이름을 `--ink`로 올려 사람 줄에도 자기 표지를 준다.
//
// ## 자리는 예약한다 (H-2)
//
// 1차는 예약하지 않았고, 그 근거가 「이 줄은 남의 일이다」였다. 그 문장은 **내용**의
// 차이는 설명하지만 **흔들림**의 차이는 설명하지 못한다: 캐럿 이동량은 26px로 같고,
// 트리거가 내 손이 아니라 남의 키라 예측 가능성은 오히려 더 낮다. 빈도도 다르다 —
// 라우팅 줄은 내가 @를 지울 때 한 번, 이 줄은 팀원이 치기 시작할 때마다 + 멈추고 6초
// 뒤마다. 폰에서는 키보드가 올라온 상태에서 **엄지 아래의 전송 버튼**이 움직인다.
//
// 그래서 같은 컴포저의 라우팅 줄(`MENTION_ROUTING_ROW_CLASS`, 32px)이 이미 하는 것을
// 그대로 한다: 문장이 없으면 **같은 높이의 빈 자리**를 남긴다.
//
// 「포커스가 있을 때만 예약」은 검토했고 **기각했다.** 그러면 컴포저를 클릭하는 순간
// 예약이 생겨 입력창이 손가락 아래에서 26px 움직인다 — 병보다 나쁜 약이고, 흔들림의
// 원인을 남의 키에서 내 클릭으로 옮기는 것일 뿐이다.
//
// ## live 영역이 아니다
//
// `aria-live`를 걸지 않는다. 작성 중은 3초마다 갱신되는 신호이고, live 영역에 두면
// 보조기술이 남이 타이핑하는 동안 같은 문장을 계속 낭독한다 — 작업 패널의 1Hz 시계를
// live 영역 **바깥**으로 뺀 것과 정확히 같은 판단이다(gate-work-panel의 live 시나리오).
// 문장은 DOM에 있으므로 읽으려는 사람은 언제든 읽을 수 있고, 강제로 끼어들지 않는다.
// =============================================================================

/**
 * 이 줄이 차지하는 높이. 문장이 있든 없든 같아야 한다 (H-2).
 *
 * `px-6`은 위 힌트 줄과 같은 값이다 (`Composer.tsx`의 그 주석: 폼의 `p-3` +
 * 텍스트에어리어의 `px-3` = 24px, 그래서 첫 글자가 플레이스홀더의 첫 글자와 같은
 * 세로선에 선다). 1차는 `px-4`였고, 입력창 아래 12px 회색 3행이 왼쪽 모서리를 두 개
 * 갖고 있었다 — 그 판정이 이미 같은 파일 주석에 적혀 있었다
 * (design-review PR 1059 H-3).
 */
const LINE_CLASS = "truncate px-6 pb-2 text-meta";

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
  const segments = typingSegments(names, threshold);

  if (segments.length === 0) {
    // 문장은 없고 자리는 있다 (H-2). 라우팅 줄의 예약 자리와 같은 성질이며, 아무것도
    // 주장하지 않으므로 보조기술에서도 빠진다.
    return (
      <p
        className={LINE_CLASS}
        aria-hidden="true"
        data-testid="composer-typing-reserved"
      >
        {/* 빈 문자열이 아니라 zero-width space: 빈 <p>는 line-height를 갖지 않아
            자리를 예약하지 못한다. 높이를 h-* 로 못박는 대신 이것을 쓰는 이유는,
            문장이 있는 판과 없는 판이 **같은 글자 상자**에서 높이를 얻어야 둘이
            어긋날 수 없기 때문이다. */}
        {"\u200b"}
      </p>
    );
  }

  return (
    <p
      className={LINE_CLASS}
      data-testid="composer-typing"
      data-count={memberIds.length}
      title={typingLabel(names, threshold) ?? undefined}
    >
      {segments.map((segment, index) =>
        segment.kind === "name" ? (
          // 사람의 잉크 (M-1). 에이전트 줄의 `--agent`와 대조되는 축이고, 이 앱이
          // 메시지 행에서 이미 쓰는 규칙과 같다: 이름은 `--ink`, 부속물은 muted.
          <span key={index} className="text-ink">
            {segment.text}
          </span>
        ) : (
          <span key={index} className="text-ink-muted">
            {segment.text}
          </span>
        )
      )}
    </p>
  );
}
