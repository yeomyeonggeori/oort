import { RespondingDots } from "@/features/agents/RespondingIndicator";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { typingLineParts } from "./typingLineParts";

// =============================================================================
// 「입력 중」 줄 — 입력 카드 바로 아래 한 줄 (#5567, owner 11-09 「작성중이 채팅창 우측 영역을 활용하는데 일반적이진 않은 거 같아」).
//
// ## 자리: 카드 아래, 왼쪽, 늘 잡아 둔 한 줄
//
// 앞 판(#1749 U-8)은 이 문장을 카드 안 도구 줄의 가운데 슬롯, 보내기 단추 바로 왼쪽에 오른쪽 정렬로 세웠다. 높이를 새로
// 잡지 않으려는 선택이었지만, 입력하는 손 바로 옆에서 남의 이름이 깜빡이고 보내기 단추에 붙어 서는 자리는 어느 도구도
// 쓰지 않는 자리였다. 이제 Slack·Discord처럼 **카드 바로 아래 왼쪽**에 작은 보조 글자로 선다.
//
//   - 아래인 이유: 위(카드와 대화 목록 사이)에는 에이전트의 「작업 중」 줄(`ComposerActivityRail`)이 이미 선다. 사람 줄을
//     같은 자리에 쌓으면 두 상태 줄이 붙어 서고 「입력 중(사람) / 작업 중(에이전트)」 낱말 경계가 한 덩어리로 읽힌다.
//     아래는 넓은 창에서 카드가 떠 있던 18px 아래 여백 자리라, 그 여백을 이 줄이 맡으면 카드·입력창·대화 목록의 자리가
//     예전과 한 픽셀도 다르지 않다(`tokens.css` `composer-dock`·`typing-line`).
//   - 늘 잡아 둔다: 아무도 치지 않아도 줄 높이(18)가 서 있다. 줄이 나타나고 사라질 때 아무것도 움직이지 않는다.
//
// ## 문구는 사전에서 (ko/en `timeline.typing.*`)
//
// 한 사람이면 「○○님이 입력 중…」, 둘 이상이면 「○○님 외 N명이 입력 중…」이다. 뭉치는 기준은 둘부터다(ADR-0149 「미결:
// 몇 명부터 뭉칠까」를 이 판이 정한다 — 한 줄짜리 보조 글자에서 이름 둘을 늘어놓으면 긴 이름에서 바로 넘친다).
// 이름은 사람의 잉크(`--ink`, 굵게), 나머지는 muted다: 에이전트 줄의 `--agent`와 대조되는 축이다(리뷰 PR 1059 M-1).
//
// ## 잘리는 것은 이름이고 서술어는 안 잘린다 (M-3 · W-3)
//
// 한국어는 동사가 끝에 온다. 줄 전체에 말줄임을 걸면 넘칠 때 사라지는 것이 「입력 중」이다. 그래서 문장을 둘로 나눈다:
// 이름과 **이름에 붙은 조사**(「님이」·「님」)는 줄어드는 앞부분, 그 뒤 빈칸부터(「 입력 중…」·「 외 2명이 입력 중…」)는
// 안 줄어드는 꼬리다. 조사가 이름과 함께 잘리므로 「…님이」처럼 붙을 이름을 잃은 조사가 남지 않는다. 나누는 자리는
// 번역문에서 찾는다: 이름 자리에 보이지 않는 표지를 넣어 문장을 만들고, 표지에 붙은(빈칸 없는) 글자까지를 앞부분으로 본다.
// 영어는 붙은 글자가 없어 「Alice」 | 「 is typing…」으로 나뉜다. 번역에 이름 자리가 없으면 문장 하나가 통째로 줄어든다.
//
// ## 읽기: 보이는 조각은 aria-hidden, 온전한 문장은 sr-only (M-2), live 영역은 아니다
//
// 보이는 조각은 폭에 따라 잘릴 수 있으므로 보조기술에는 온전한 문장 하나(말줄임표 없이)를 준다. live 영역이 아닌 것은
// 그대로다: 3초마다 다시 오는 신호라 live 영역에 두면 남이 치는 동안 같은 문장을 계속 낭독한다. 점은 사람 줄의 색
// (`--ink-muted`)이고 움직임 줄이기에서는 멈춘다(`RespondingDots`).
// =============================================================================

export function TypingLine({
  memberIds,
  directory,
}: {
  /** 지금 입력 중인 사람들. 나·에이전트·만료분은 이미 걸러져 있다. */
  memberIds: string[];
  directory: Directory;
}) {
  const format = useFormatMessage();
  // 이름을 못 찾은 사람은 코어의 `isEligible`이 이미 떨궜다. 명부가 그 사이에 바뀔 수 있어 한 번 더 좁힌다: 이름 없는
  // 「누군가 입력 중」은 나르는 정보가 0이다.
  const names = memberIds
    .map((id) => memberFor(directory, id)?.displayName)
    .filter((name): name is string => Boolean(name));
  const parts = typingLineParts(format, names);

  return (
    <div
      className="typing-line"
      data-testid="typing-line"
      data-state={parts === null ? "off" : "on"}
    >
      {parts !== null && (
        <p
          className="flex min-w-0 items-center"
          data-testid="composer-typing"
          data-count={names.length}
        >
          <RespondingDots human />
          <span className="sr-only" data-testid="composer-typing-label">
            {parts.label}
          </span>
          {/* 줄어드는 쪽: 이름과 거기 붙은 조사. `title`은 포인터 사용자에게 얹히는 보너스다. */}
          <span
            className="ml-1 min-w-0 truncate"
            aria-hidden="true"
            data-testid="composer-typing-lead"
            title={parts.label}
          >
            {parts.before}
            {parts.name !== "" && (
              <span className="font-bold text-ink">{parts.name}</span>
            )}
            {parts.attached}
          </span>
          {/* 안 줄어드는 쪽: 서술어. 앞 빈칸을 `whitespace-pre`가 지켜 잘린 이름과 서술어가 붙지 않는다. 「외 N명」의 숫자가
              바뀌어도 폭이 흔들리지 않게 자릿폭을 고정한다(N-2). */}
          <span
            className="shrink-0 whitespace-pre"
            aria-hidden="true"
            data-testid="composer-typing-tail"
            data-numeric
          >
            {parts.tail}
          </span>
        </p>
      )}
    </div>
  );
}
