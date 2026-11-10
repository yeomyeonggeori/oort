import { RespondingDots } from "@/features/agents/RespondingIndicator";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { blockedLineSentences, typingLeadCells, typingLineParts } from "./typingLineParts";

// =============================================================================
// 「작성 중」 줄 — 입력 카드 바로 아래 한 줄 (#5567, owner 11-09: 입력창 안 오른쪽 자리는 일반적이지 않다는 지적).
//
// ## 자리: 카드 아래, 왼쪽, 늘 잡아 둔 한 줄
//
// 앞 판(#1749 U-8)은 이 문장을 카드 안 도구 줄의 가운데 슬롯, 보내기 단추 바로 왼쪽에 오른쪽 정렬로 세웠다. 높이를 새로
// 잡지 않으려는 선택이었지만, 입력하는 손 바로 옆에서 남의 이름이 깜빡이고 보내기 단추에 붙어 서는 자리는 어느 도구도
// 쓰지 않는 자리였다. 이제 Slack·Discord처럼 **카드 바로 아래 왼쪽**에 작은 보조 글자로 선다.
//
//   - 아래인 이유: 위(카드와 대화 목록 사이)에는 에이전트의 「작업 중」 줄(`ComposerActivityRail`)이 이미 선다. 사람 줄을
//     같은 자리에 쌓으면 두 상태 줄이 붙어 서고 「작성 중(사람) / 작업 중(에이전트)」 낱말 경계가 한 덩어리로 읽힌다.
//   - 늘 잡아 둔다: 아무도 치지 않아도 줄 칸(글 한 줄 + 위아래 숨 8)이 서 있다. 줄이 나타나고 사라질 때 아무것도 움직이지
//     않는다(`tokens.css` `typing-line`). 숨이 있는 이유는 design-review M-1이다: 칸이 글 한 줄 높이뿐이면 글자가 카드
//     밑변·판 밑변에서 3~4px에 끼고 카드의 그림자 띠 안에 선다.
//
// ## 문구는 사전에서 (ko/en `timeline.typing.*`), 낱말은 「작성 중」
//
// 낱말은 폰(`TypingBar`)·코어(`typingLabel`)·ADR-0149와 같은 「작성 중」이다(사람은 작성 중, 에이전트는 작업 중). 한 사람이면
// 「○○님이 작성 중…」, 둘이면 두 이름 다 「○○님, △△님이 작성 중…」, 셋부터 「○○님 외 N명이 작성 중…」이다 — 폰과
// Slack·Discord처럼 둘까지 이름을 부른다(design-review M-2). 줄이 카드 폭 전체라 이름 둘이 들어갈 자리가 있고, 넘치면
// 아래 규칙대로 이름 쪽이 잘린다. 이름은 사람의 잉크(`--ink`, 굵게), 나머지는 muted다: 에이전트 줄의 `--agent`와
// 대조되는 축이다(리뷰 PR 1059 M-1).
//
// ## 잘리는 것은 이름이고 서술어는 안 잘린다 (M-3 · W-3)
//
// 한국어는 동사가 끝에 온다. 줄 전체에 말줄임을 걸면 넘칠 때 사라지는 것이 「작성 중」이다. 그래서 문장을 둘로 나눈다:
// 이름(들)과 **마지막 이름에 붙은 조사**(「님이」·「님」)는 줄어드는 앞부분, 그 뒤 빈칸부터(「 작성 중…」·「 외 2명이
// 작성 중…」)는 안 줄어드는 꼬리다. 조사가 이름과 함께 잘리므로 「…님이」처럼 붙을 이름을 잃은 조사가 남지 않는다.
// 나누는 자리는 번역문에서 찾는다: 이름 자리에 보이지 않는 표지를 넣어 문장을 만들고, 마지막 표지에 붙은(빈칸 없는)
// 글자까지를 앞부분으로 본다. 영어는 붙은 글자가 없어 「Alice and Bob」 | 「 are typing…」으로 나뉜다. 번역에 이름 자리가
// 없으면 문장 하나가 통째로 줄어든다.
//
// ## 읽기: 보이는 조각은 aria-hidden, 온전한 문장은 sr-only (M-2), live 영역은 아니다
//
// 보이는 조각은 폭에 따라 잘릴 수 있으므로 보조기술에는 온전한 문장 하나(말줄임표 없이)를 준다. live 영역이 아닌 것은
// 그대로다: 3초마다 다시 오는 신호라 live 영역에 두면 남이 치는 동안 같은 문장을 계속 낭독한다. 점은 사람 줄의 색
// (`--ink-muted`)이고 움직임 줄이기에서는 멈춘다(`RespondingDots`).
//
// ## 입력창이 막히면 같은 칸이 그 이유를 말한다 (#5575 검수 H1)
//
// 기기 오프라인 · 서버에 닿지 못함으로 보내기가 막히면 「…지금은 보낼 수 없어요」 문장이 **이 칸에** 선다. 이 문장은 원래 카드 위에 따로
// 서는 줄이었고, 서고 질 때마다 대화 목록의 바닥이 26px(넓은 창)·44px(폰 폭, 두 줄로 접힘) 올라갔다 내려왔다 — 사람이 아무것도 안
// 했는데 대화가 움직였다. 늘 잡아 둔 칸에 서면 목록 상자가 바뀌지 않는다. 막힌 동안은 이 문장이 「작성 중」보다 먼저다: 연결이 끊긴
// 동안에는 남의 「작성 중」 신호가 오지 않고, 남아 있던 것도 낡은 것이다. 이 문장은 상태 알림(status 역할)이고 보내기 단추의
// 설명(`title`)과 같은 값이다. 칸이 한 줄이라 넘치면 문장을 통째로 버린다(`blockedLineSentences`) — 폰 폭에서는 첫 문장만 보이고,
// 온전한 문장은 보조기술과 `title`이 받는다.
// =============================================================================

/** 이름 칸: 넘치면 자기 안에서 말줄임된다(#5582 R2-M1). 사이 글 칸: 앞뒤 빈칸을 지키고 줄지 않는다. */
const NAME_CELL_CLASS = "min-w-0 truncate";
const TEXT_CELL_CLASS = "whitespace-pre";

export function TypingLine({
  memberIds,
  directory,
  blocked = null,
}: {
  /** 지금 작성 중인 사람들. 나·에이전트·만료분은 이미 걸러져 있다. */
  memberIds: string[];
  directory: Directory;
  /** 보내기가 막힌 이유 문장(기기 오프라인 · 서버에 닿지 못함). 있으면 「작성 중」 대신 이 문장이 선다. */
  blocked?: string | null;
}) {
  const format = useFormatMessage();
  // 이름을 못 찾은 사람은 코어의 `isEligible`이 이미 떨궜다. 명부가 그 사이에 바뀔 수 있어 한 번 더 좁힌다: 이름 없는
  // 「누군가 작성 중」은 나르는 정보가 0이다.
  const names = memberIds
    .map((id) => memberFor(directory, id)?.displayName)
    .filter((name): name is string => Boolean(name));
  const parts = blocked === null ? typingLineParts(format, names) : null;

  return (
    <div
      className="typing-line"
      data-testid="typing-line"
      data-state={blocked !== null ? "blocked" : parts === null ? "off" : "on"}
    >
      {blocked !== null && (
        <p
          role="status"
          // 옷은 승인 카드의 차단 줄과 같다(`APPROVAL_NOTE_TONE_CLASS.blocked`, U4-6 M-2) — 자리만 이 칸으로 옮겼다.
          className="flex h-full min-w-0 flex-wrap gap-x-1 overflow-hidden text-meta text-warn break-keep"
          data-testid="composer-offline"
          title={blocked}
        >
          {/* 문장마다 한 덩어리: 들어가지 않는 문장은 숨은 둘째 줄로 내려간다. 첫 문장도 안 들어가는 폭에서만 말줄임이 마지막 방어선이다. */}
          {blockedLineSentences(blocked).map((sentence, index) => (
            <span key={index} className={index === 0 ? "min-w-0 truncate" : "whitespace-nowrap"}>
              {sentence}
            </span>
          ))}
        </p>
      )}
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
          {/* 줄어드는 쪽: 이름과 거기 붙은 조사. 이름마다 격자 칸 하나라 이름마다 자기 칸에서 줄어든다(#5582 R2-M1, `typing-names`):
              짧은 이름은 온전하고 긴 이름이 남는 폭을 나눠 말줄임된다. 조사는 자기 이름 칸 안이라 이름과 함께 잘린다(W-3,
              `typingLeadCells`). `title`은 포인터 사용자에게 얹히는 보너스다. */}
          <span
            className="typing-names ml-1 min-w-0"
            aria-hidden="true"
            data-testid="composer-typing-lead"
            title={parts.label}
          >
            {typingLeadCells(parts.lead).map((cell, index) => (
              <span
                key={index}
                className={cell.name ? NAME_CELL_CLASS : TEXT_CELL_CLASS}
                data-typing-name={cell.name ? "" : undefined}
              >
                {cell.pieces.map((piece, at) =>
                  piece.name ? (
                    <span key={at} className="font-bold text-ink">
                      {piece.text}
                    </span>
                  ) : (
                    piece.text
                  )
                )}
              </span>
            ))}
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
