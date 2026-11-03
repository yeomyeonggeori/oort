import { useFormatMessage } from "@/i18n/useFormatMessage";
import { replyHomeCopy } from "@momo/core/features/timeline/replyHomeCopy";
import type { ReplyHomeLine as ReplyHomeLineModel } from "@momo/core/features/timeline/threadHome";
import type { Directory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「↳ ○○님 스레드에 답글」 + 원문 한 줄 — 본류에 선 답글(「대화에도 보내기」)이 **어느 스레드의 것인지** 말하는 줄 (이슈 #4888).
//
// 스레드 요약 줄(`ThreadSummaryLine`)이 본문 **아래** 꼬리에 서서 「여기 스레드가 있다」를 알리는 것과 대칭으로, 이 줄은 본문 **위**에
// 서서 「이 말은 저기서 왔다」를 알린다. 인용 블록(`QuoteBlock`)과는 다른 장치다: 인용은 본류에 두면서 원문을 **끌어오는** 것이라 테두리
// 상자로 서고, 이 줄은 **소속**을 말하는 한 줄이라 상자가 없다. 한 행이 둘 다 가질 수 있다(ADR-0148 규칙 1).
//
// 문구는 코어 `replyHomeCopy` 한 곳에서 온다(폰과 같은 문장). 화살표는 모양이라 낭독에서 뺀다.
//
// 눌리는 것은 **열 스레드가 있을 때만**이다(`onOpen`). 루트가 불러온 범위 위에 있으면(`unloaded`) 문장이지 단추가 아니다 — 없는 방으로
// 가는 문은 짓지 않는다.
// =============================================================================

export function ReplyHomeLine({
  line,
  directory,
  myMemberId,
  onOpen,
}: {
  line: ReplyHomeLineModel;
  directory: Directory;
  myMemberId: string | undefined;
  /** 그 스레드를 연다. 열 곳이 없으면 생략 — 줄은 글이 된다. */
  onOpen?: () => void;
}) {
  const formatMessage = useFormatMessage();
  const copy = replyHomeCopy(line, { directory, myMemberId, formatMessage });
  const content = (
    <>
      <span className="max-w-full truncate font-semibold" data-testid="reply-home-header">
        <span aria-hidden="true">↳ </span>
        {copy.header}
      </span>
      {copy.excerpt !== null && (
        <span className="max-w-full truncate" data-testid="reply-home-excerpt">
          {copy.excerpt}
        </span>
      )}
    </>
  );
  if (onOpen === undefined) {
    return (
      <p
        className="flex min-w-0 max-w-full flex-col items-start text-left text-meta text-ink-muted"
        data-testid="reply-home"
      >
        {content}
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      // 이름은 「머리, 원문」 한 문장이다(화살표는 낭독에서 빠진다 — 화면의 글자를 모두 포함해 「보이는 글이 이름에 든다」). 열린다는 말은 설명이 진다.
      aria-label={copy.spoken}
      title={copy.openLabel}
      data-testid="reply-home"
      className="press tap-target -mx-1 flex min-w-0 max-w-full flex-col items-start rounded-md px-1 text-left text-meta text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
    >
      {content}
    </button>
  );
}
