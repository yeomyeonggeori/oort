import type { ThreadRollup } from "@momo/core/lib/api";
import { threadSummary, threadSummaryCopy } from "@momo/core/features/timeline/threadSummary";
import { cn } from "@/design/lib/cn";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { Avatar } from "./MessageRow";
import {
  THREAD_FACE_OVERLAP_CLASS,
  THREAD_FACE_RING_CLASS,
  THREAD_FACE_SIZE_CLASS,
} from "./spacing";

// =============================================================================
// 메시지 아래 스레드 요약 줄 (#4878, owner 10-31 — Buzz식).
//
//   [겹친 얼굴 ≤3]  답글 N개  [새 답글 M]
//
// 무엇을 보일지의 판정(얼굴 상한·칩 조건·문구)은 전부 코어 `threadSummary`가 정한다. 이 파일은 그 값을 **그리기만**
// 한다 — 폰이 같은 값을 자기 모양으로 그린다. 「마지막 답글 X 전」은 owner가 뺐다(10-31 23:49).
//
// 줄 전체가 「스레드 열기」 버튼 하나다: 얼굴·글·칩이 각자 눌리는 것이 아니라 하나의 타깃이고, 초점 링은 그 버튼
// 전체에 선다. 안 읽은 답글이 있으면(`hasUnread`) 글이 신호색(`--signal-text`, 호박은 신호에만)으로 바뀌고 칩이 붙는다.
// 칩 면은 읽지 않은 수의 면과 같은 `bg-signal text-on-signal`(측정된 쌍)이라 새 대비 쌍이 생기지 않는다.
//
// 얼굴은 행 아바타와 **같은 `Avatar`**다: 에이전트는 둥근 사각·agent 색, 명부에서 못 푸는 id는 「알 수 없는 사람」
// (점선 원), 업로드된 사진은 같은 길로 받는다. 한 변 20·겹침 6·링 2px는 `spacing.ts`의 이름 클래스다.
// =============================================================================

// 클래스 묶음은 JSX 밖의 상수다: 직접 문구 장부(`direct-copy`)는 JSX 식 안의 문자열을 문구 후보로 세므로, 클래스 이름을
// 식 안에 흩지 않는다. 얼굴의 크기·링·겹침은 `spacing.ts`의 이름 클래스다.
const FACE_CLASS = cn(THREAD_FACE_SIZE_CLASS, THREAD_FACE_RING_CLASS, "text-timestamp");
// `truncate`와 같은 세 속성을 풀어 쓴다: 낱말 하나짜리 문자열(`"truncate"`)은 장부가 영어 문구로 센다.
const COUNT_CLASS = cn("min-w-0", "overflow-hidden", "text-ellipsis", "whitespace-nowrap", "font-semibold");
const COUNT_TONE = { unread: "text-signal-text", read: "text-ink" } as const;

export function ThreadSummaryLine({
  rollup,
  directory,
  onOpen,
}: {
  rollup: ThreadRollup;
  directory: Directory;
  /**
   * 스레드를 여는 동작. 없으면(이미 연 자리·읽기 전용 마운트) **죽은 버튼을 만들지 않고** 같은 모양의 글로 선다 —
   * 눌러도 아무 일이 없는 포커스 정거장이 생기지 않게 한다(goal P3 1-1).
   */
  onOpen?: () => void;
}) {
  const formatMessage = useFormatMessage();
  const summary = threadSummary(rollup);
  const copy = threadSummaryCopy(summary, formatMessage);

  const inner = (
    <>
      {summary.faces.length > 0 && (
        <span className="flex shrink-0 items-center" aria-hidden="true" data-testid="thread-faces">
          {summary.faces.map((id, index) => (
            <Avatar
              key={id.toLowerCase()}
              testId="thread-face"
              member={memberFor(directory, id) ?? null}
              className={cn(FACE_CLASS, index > 0 && THREAD_FACE_OVERLAP_CLASS)}
            />
          ))}
        </span>
      )}
      <span
        className={cn(COUNT_CLASS, summary.hasUnread ? COUNT_TONE.unread : COUNT_TONE.read)}
        data-testid="thread-count"
      >
        {copy.count}
      </span>
      {copy.unreadChip !== null && (
        <span
          className="shrink-0 rounded-full bg-signal px-2 text-timestamp font-semibold text-on-signal"
          data-testid="thread-unread-chip"
        >
          {copy.unreadChip}
        </span>
      )}
    </>
  );

  if (onOpen === undefined) {
    return (
      <span
        className="flex min-w-0 max-w-full items-center gap-2 text-meta"
        data-testid="thread-anchor"
        data-unread={summary.hasUnread || undefined}
      >
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={copy.open}
      data-testid="thread-anchor"
      data-row-action=""
      data-unread={summary.hasUnread || undefined}
      className="press tap-target -mx-1 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 text-meta hover:bg-surface-hover focus-visible:focus-ring"
    >
      {inner}
    </button>
  );
}
