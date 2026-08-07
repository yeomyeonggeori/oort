import { Pin } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  PIN_LIST_FAILED_DETAIL,
  PIN_LIST_FAILED_HEADLINE,
  pinExcerpt,
  pinList,
  pinListHeaderLabel,
  pinStampLabel,
  pinStampSegments,
  type PinListStatus,
  type PinMap,
} from "@momo/core/features/timeline/pins";

// =============================================================================
// 채널의 고정 목록 (이슈 #1112 · 후속 #1146).
//
// **왜 패널이 아니라 메뉴인가.** 이 표면에서 사람이 하는 일은 하나다 — 고정된
// 메시지를 골라 그 자리로 간다. 고르고 나면 이 표면은 사라져야 하고, 남아 있을
// 이유가 없다. 스레드·작업 세션 패널은 반대다: 거기서는 읽고 쓰고 머문다. 그래서
// 그 둘은 채널 옆의 열이고 서로 배타적으로 열리는데(ChatShell의
// `thread && !workPanelOpen`), 세 번째 열을 그 춤에 넣는 것은 이 기능이 지불할
// 이유가 없는 복잡도다. 헤더 버튼에 달린 메뉴는 열고, 고르고, 닫힌다.
//
// **클릭 = 원본 점프.** 새 항법을 만들지 않는다. `onJump`는 ChatShell이 인용
// 점프와 인박스 점프에 이미 쓰는 `watchForMessageId` 감시자를 그대로 태우고,
// 못 찾았을 때의 문장도 그 자리(`chat-anchor-missed`)에 이미 있다. 고정 목록이
// 자기만의 "못 찾았습니다"를 새로 그리면 같은 사실을 두 군데서 말하게 된다.
//
// 목록은 항상 이 채널의 것이다 — 스레드 답글이 고정돼 있어도 `seq`로 본류에
// 착지한다(서버가 답글도 같은 채널의 메시지로 저장한다).
//
// ## #1146 M2 — 못 불러온 목록은 「없다」고 말하지 않는다
//
// 1차는 `/pins` 가 실패해도 조용히 빈 지도로 남았고, 그래서 오프라인에서 이 메뉴를
// 연 사람은 「고정한 메시지가 없습니다」를 읽었다. 채널에 고정이 열 개 있어도.
// 그것은 느린 것이 아니라 **틀린 말을 하는 것**이고, 읽은 사람은 고정이 지워졌다고
// 결론 내린다. 이제 상태를 받아 세 가지를 갈라 그린다 — 그리고 실패한 목록에
// 프레임으로 들어온 항목이 있으면 **둘 다** 그린다(가진 것을 숨기지 않고, 모르는
// 것을 아는 척하지 않는다).
// =============================================================================

/** 한 줄이 감당할 만큼만. 나머지는 원본에 있고, 한 번 누르면 거기로 간다. */
const EXCERPT_MAX_CHARS = 60;

export function PinListMenu({
  pins,
  status,
  directory,
  onJump,
  onRetry,
}: {
  pins: PinMap;
  /** 이슈 #1146 M2 — 빈 지도가 무엇을 뜻하는지 아는 유일한 값. */
  status: PinListStatus;
  directory: Directory;
  /** 원본으로 간다. ChatShell의 기존 앵커 기계를 그대로 탄다. */
  onJump: (messageId: string, seq: number) => void;
  /** 목록만 다시 읽는다(채널 전체가 아니라). 실패 문장 뒤의 행동. */
  onRetry: () => void;
}) {
  const entries = pinList(pins);
  // **셀 자격이 있을 때만** 센다 (#1146 M2): 목록을 못 불러온 채로 「고정 3개」라고
  // 적으면, 목록 안에서 고친 거짓말이 버튼으로 옮겨 갈 뿐이다.
  const label = pinListHeaderLabel(entries.length, status);
  // 메뉴가 열리는 순간의 시각. `Timeline`의 날짜 구분선이 쓰는 것과 같은 값이고
  // 같은 이유다 — 이 표면은 고르면 닫히므로 째깍이는 시계를 살 이유가 없다.
  const nowMs = Date.now();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // 이름과 툴팁이 같은 문자열이다: 하나를 듣고 하나를 보는 사람에게
          // 이름이 둘이면 컨트롤도 둘이다 (작업 세션 토글과 같은 규칙).
          aria-label={label}
          title={label}
          data-testid="open-pin-list"
          data-pin-count={entries.length}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-sm px-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "min-h-control-sm text-ink-muted hover:bg-surface-hover",
            "data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
          )}
        >
          <Pin className="size-4" aria-hidden="true" />
          {/* 0개일 때 숫자를 그리지 않는다: 「고정 0개」는 아무것도 알리지 않으면서
              헤더의 폭만 가져간다. 버튼 자체는 남는다 — 처음 고정하는 사람이
              어디서 목록을 여는지 배울 자리가 필요하다. */}
          {status === "ready" && entries.length > 0 && (
            <span className="text-meta" data-numeric>
              {entries.length}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={label}
        data-testid="pin-list"
        data-pin-status={status}
        // 채널마다 상한이 100이므로 목록은 스스로 스크롤한다. 화면을 넘기는
        // 메뉴는 마지막 항목에 닿을 수 없다.
        className="max-h-pane w-pane overflow-y-auto"
      >
        {/* 실패는 목록 **위에** 선다. 가진 항목이 있어도 지우지 않는 이유는,
            프레임으로 들어온 그 항목들이 실제로 고정돼 있기 때문이다 — 목록이
            반쪽이라는 사실과 그 반쪽은 둘 다 참이다.

            두 문장을 공백으로 잇는 것은 빈 문장과 같은 규칙이다: 코어가 쪼개 두는
            이유는 폰의 `ErrorState` 가 둘을 따로 받기 때문이고, 웹은 한 줄로 읽는다.

            **「다시 시도」가 배너 밖에 있는 것은 키보드 때문이다.** Radix 메뉴는
            항목들로만 로빙 포커스를 돌리고 Tab 은 메뉴를 닫으므로, 배너 안의
            `<button>` 은 마우스로만 닿는 컨트롤이 된다. 그래서 항목으로 세우고
            `preventDefault` 로 **닫히지 않게** 한다 — 다시 읽은 결과를 보려면 이
            표면이 열려 있어야 한다. */}
        {status === "failed" && (
          <>
            <InlineBanner
              message={`${PIN_LIST_FAILED_HEADLINE} ${PIN_LIST_FAILED_DETAIL}`}
              separator={entries.length > 0}
              testId="pin-list-failed"
            />
            <DropdownMenuItem
              data-testid="pin-list-retry"
              onSelect={(event) => {
                event.preventDefault();
                onRetry();
              }}
            >
              다시 시도
            </DropdownMenuItem>
          </>
        )}
        {status === "loading" ? (
          // 로딩은 **문장을 갖지 않는다.** 한 번의 REST 왕복이고, 「불러오는 중…」은
          // 대개 읽히기 전에 사라진다. 요점은 이 순간에 빈 문장(「없습니다」)을
          // 그리지 않는 것이다 — 그것이 1차가 로딩과 빈 상태를 구별하지 못해 하던
          // 거짓말의 절반이다. 앱의 로딩 어휘 그대로: 높이를 지키는 중립 막대이고
          // 반짝이지 않는다.
          <SkeletonRows rows={2} />
        ) : entries.length === 0 ? (
          status === "failed" ? null : (
            <p
              className="px-2 py-2 text-meta text-ink-muted"
              data-testid="pin-list-empty"
            >
              {`${PIN_LIST_EMPTY_HEADLINE} ${PIN_LIST_EMPTY_DETAIL}`}
            </p>
          )
        ) : (
          entries.map((entry) => {
            const author = memberFor(directory, entry.authorMemberId);
            const name =
              author?.displayName ?? entry.authorMemberId.slice(0, 8);
            const excerpt = pinExcerpt(entry.body, EXCERPT_MAX_CHARS);
            return (
              <DropdownMenuItem
                key={entry.messageId}
                data-testid="pin-list-item"
                data-message-id={entry.messageId}
                // 항목 하나가 두 줄이다 — 누구의 어떤 말인지 한 줄에 넣으면 발췌가
                // 열 글자로 줄어 어느 메시지인지 알아볼 수 없다.
                layout="stack"
                onSelect={() => onJump(entry.messageId, entry.seq)}
              >
                <span className="flex w-full items-baseline gap-2 text-meta text-ink-muted">
                  <span className="min-w-0 truncate">{name}</span>
                  {/* **고정된 때**이지 쓰인 때가 아니다 (#1146 N1): 이 열이
                      목록의 정렬 근거이고, 다른 값을 그리면 정렬이 깨진 것처럼
                      보인다. 자릿폭 표지는 숫자에만 — 한글 음절이 함께 잡히면
                      「8월  5일」로 벌어진다(`divider.ts` 실측). */}
                  <span
                    className="ml-auto shrink-0"
                    data-testid="pin-list-stamp"
                    aria-label={pinStampLabel(entry.pinnedAtMs)}
                  >
                    {pinStampSegments(entry.pinnedAtMs, nowMs).map(
                      (segment, index) =>
                        segment.kind === "figure" ? (
                          <span key={index} data-numeric>
                            {segment.text}
                          </span>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        )
                    )}
                  </span>
                </span>
                <span className="w-full truncate text-body text-ink">
                  {excerpt.text}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
