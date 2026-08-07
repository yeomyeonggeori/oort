import { Pin } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { appNote } from "@momo/core/features/timeline/appVoice";
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
//
// ## #1149 M1 — 스켈레톤은 **보여줄 것이 없을 때만** 선다
//
// 「가진 것을 숨기지 않는다」를 실패에는 지켰고 **재시도에는 지키지 못했다.**
// `reloadPins()` 가 상태를 `loading` 으로 되돌리므로, 「다시 시도」를 누른 사람의
// 화면에서는 방금까지 읽던 항목들이 회색 막대 뒤로 사라졌다 — 그 항목들은 여전히
// 지도에 있고 여전히 참이다. 폰은 같은 순간에 목록을 그대로 두므로(`FlatList` 의
// `data` 는 상태와 무관하다) 한 제품의 두 화면이 같은 클릭에 다르게 답하고 있었다.
//
// 스켈레톤이 하는 말은 「곧 무언가 올 자리다」이고, 그 말이 필요한 것은 그 자리가
// **비어 있을 때**뿐이다. 이미 채워진 목록 위에서는 아무것도 알리지 않으면서 읽던
// 것을 가져간다.
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
            표면이 열려 있어야 한다.

            ## 줄은 어디에 속하는가 (이슈 #1149 M3)

            1차는 배너의 `separator` 를 「항목이 있을 때」로 켰다. 그러면 그 줄은
            문장과 **자기 버튼 사이**에 떨어진다 — `InlineBanner` 의 아래 테두리는
            액자가 아니라 「이 배너와 그 아래 내용을 가르는 칸막이」라고 그 원자가
            스스로 적어 두었는데(MOMO-628 R1 M2), 「다시 시도」는 아래 내용이 아니라
            **이 배너의 행동**이다. 키보드 때문에 상자 밖으로 나갔을 뿐이라는 것이
            바로 위 문단의 내용이고, 그 사정이 화면에서 두 조각으로 보이면 안 된다.

            그래서 배너는 칸막이를 갖지 않고(`separator={false}` — 가를 것이 자기
            버튼뿐이다), 칸막이는 **실패 블록 전체와 목록 사이**에 한 번 선다. 메뉴가
            자기 어휘로 가진 `DropdownMenuSeparator` 를 쓰는 것은 이 자리가 메뉴 안의
            구분이기 때문이다 — 항목 사이를 가르는 줄은 이 메뉴가 이미 아는 모양이다. */}
        {status === "failed" && (
          <>
            <InlineBanner
              message={`${PIN_LIST_FAILED_HEADLINE} ${PIN_LIST_FAILED_DETAIL}`}
              separator={false}
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
            {entries.length > 0 && (
              <DropdownMenuSeparator data-testid="pin-list-divider" />
            )}
          </>
        )}
        {/* 스켈레톤은 **보여줄 것이 없을 때만** (이슈 #1149 M1 — 머리말). 재시도
            중에도 상태는 `loading` 이고, 그때 이미 가진 항목을 회색 막대로 덮으면
            「가진 것을 숨기지 않는다」가 재시도 한 번에 무너진다. */}
        {status === "loading" && entries.length === 0 ? (
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
                {/* 이 줄이 **누구의 말인가** (이슈 #1149 M4).

                    코어는 `PinExcerpt.empty` 로 「이 글자는 저자의 것이 아니다」를
                    이미 쥐여 주는데 1차의 웹은 그 깃발을 읽지 않았다. 그래서 본문
                    없는 메시지의 카드가 「내용 없는 메시지」를 **저자가 그렇게 쓴 것과
                    똑같은 결**로 세웠다 — 앱의 해명이 남의 말로 읽히는 자리다. 폰은
                    같은 카드에서 `※` 를 달고 흐린 색으로 세운다.

                    표시도 색도 폰의 것을 그대로 든다(`appNote` 는 이제 코어에 있다).
                    주(註) 기호 하나로 축이 서므로 크기는 건드리지 않는다: 이 줄이
                    `text-meta` 로 내려가면 위의 이름 줄과 같은 급이 되어 카드의
                    위계가 사라진다. */}
                <span
                  className={cn(
                    "w-full truncate text-body",
                    excerpt.empty ? "text-ink-muted" : "text-ink"
                  )}
                  data-testid="pin-list-excerpt"
                  data-app-voice={excerpt.empty ? "" : undefined}
                >
                  {excerpt.empty ? (
                    <>
                      {/* 표시는 **눈으로 훑을 때** 「본문이 아님」을 주는 것이지 소리
                          내어 읽을 것이 아니다 — 폰이 낭독 라벨에서 `※` 를 빼는 것과
                          같은 규율(`appVoice` 머리말). 폰은 라벨이 따로라 거기서 빼고,
                          웹의 메뉴 항목은 라벨이 곧 글자라 빼는 자리가 이 노드다.
                          사이 공백까지 `appNote` 가 짓는다: 간격을 손으로 적으면 두
                          표면에서 같은 낱말이 다른 모양으로 선다. */}
                      <span aria-hidden="true">{appNote("")}</span>
                      {excerpt.text}
                    </>
                  ) : (
                    excerpt.text
                  )}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
