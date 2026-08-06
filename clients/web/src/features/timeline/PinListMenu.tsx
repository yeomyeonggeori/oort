import { Pin } from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import {
  PIN_EMPTY_BODY_TEXT,
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  pinList,
  pinListLabel,
  type PinMap,
} from "@momo/core/features/timeline/pins";

// =============================================================================
// 채널의 고정 목록 (이슈 #1112).
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
// =============================================================================

/** 한 줄이 감당할 만큼만. 나머지는 원본에 있고, 한 번 누르면 거기로 간다. */
const EXCERPT_MAX_CHARS = 60;

function excerpt(body: string | null): string {
  const text = body?.trim();
  if (!text) return PIN_EMPTY_BODY_TEXT;
  const flattened = text.replace(/\s+/g, " ");
  return flattened.length > EXCERPT_MAX_CHARS
    ? `${flattened.slice(0, EXCERPT_MAX_CHARS)}…`
    : flattened;
}

function dayLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function PinListMenu({
  pins,
  directory,
  onJump,
}: {
  pins: PinMap;
  directory: Directory;
  /** 원본으로 간다. ChatShell의 기존 앵커 기계를 그대로 탄다. */
  onJump: (messageId: string, seq: number) => void;
}) {
  const entries = pinList(pins);
  const label = pinListLabel(entries.length);
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
          {entries.length > 0 && (
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
        // 채널마다 상한이 100이므로 목록은 스스로 스크롤한다. 화면을 넘기는
        // 메뉴는 마지막 항목에 닿을 수 없다.
        className="max-h-pane w-pane overflow-y-auto"
      >
        {entries.length === 0 ? (
          <p
            className="px-2 py-2 text-meta text-ink-muted"
            data-testid="pin-list-empty"
          >
            {`${PIN_LIST_EMPTY_HEADLINE} ${PIN_LIST_EMPTY_DETAIL}`}
          </p>
        ) : (
          entries.map((entry) => {
            const author = memberFor(directory, entry.authorMemberId);
            const name =
              author?.displayName ?? entry.authorMemberId.slice(0, 8);
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
                  <span className="ml-auto shrink-0" data-numeric>
                    {dayLabel(entry.createdAtMs)}
                  </span>
                </span>
                <span className="w-full truncate text-body text-ink">
                  {excerpt(entry.body)}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
