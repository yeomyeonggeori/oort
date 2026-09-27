import { KeyRound, Lock, Plug, type LucideIcon } from "lucide-react";
import type { CommandIcon } from "@momo/core/features/commands/registry";
import { Keycaps } from "@/app/ShortcutHelpDialog";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import {
  composerTriggerSpec,
  type ComposerCandidate,
  type ComposerListStatus,
  type ComposerTriggerKind,
} from "./composerAutocomplete";

/**
 * 자동완성 후보 목록 (#1930). `@`·`#`·`:` 가 **한 목록**을 쓴다.
 *
 * 행 해부는 하나다: 왼쪽에 넣을 것(`@handle`·`#name`·글리프), 오른쪽 흐린 자리에
 * 그것이 무엇인지(사람 이름·방 주제·숏코드). 트리거마다 다른 행 모양을 만들면
 * 강조·자르기·간격이 세 벌이 되고, 셋 중 둘은 아무도 다시 보지 않는다.
 *
 * ## 행이 못 담으면 **감싼다** (design-review #1930 M-1)
 *
 * 앞 판은 두 자리가 한 줄을 나눠 갖고 둘 다 `truncate` 였다. 멘션에서는 괜찮았다
 * — 핸들 문법이 `[A-Za-z0-9_.-]+` 라 짧다. `#` 가 이 행에 **자유 텍스트**를 처음
 * 넣으면서 그 가정이 깨졌다: 폭 192(`w-pane-sm`) 안에서 긴 한글 방 이름이 158px
 * 를 먹고 주제 칸은 **0px 로 소멸했고**(실측), 남는 것은 `#2026-하반기-릴리…` 라
 * 사람이 방금 친 `회고` 가 화면에 없었다.
 *
 * 셋(내용 폭 성장 / 두 줄 / 중간 생략) 중 **감싸기**를 고른 이유:
 *
 * 1. 상자 폭을 키우면(내용 폭 성장) 390 에서 목록이 컴포저를 넘어가고, 이름
 *    길이가 팝오버의 기하를 정하게 된다 — 후보마다 상자가 다른 폭이 된다.
 * 2. 중간 생략은 맞춘 자리를 계산해야 하고(질의가 이름 어디에 걸렸는지), 그
 *    계산은 목록이 아니라 파서의 일이다. 이 티켓의 값이 아니다.
 * 3. 감싸기는 **짧은 행을 건드리지 않는다**: 한 줄에 들어가면 앞 판과 같은 한
 *    줄이고, 안 들어갈 때만 이름이 두 줄을 쓰고 주제가 제 줄을 갖는다. 이름은
 *    `line-clamp-2` 로 두 줄에 가둔다 — 방 이름 길이에 목록 높이를 맡기지 않는다.
 */
const PANEL_CLASS =
  "absolute bottom-full left-3 mb-2 overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-lg";

export function ComposerAutocompleteList({
  id,
  kind,
  candidates,
  highlight,
  onChoose,
  testId,
  optionTestId,
  className,
  status = "ready",
  offline = false,
  onRetry,
}: {
  id: string;
  kind: ComposerTriggerKind | null;
  candidates: ComposerCandidate[];
  highlight: number;
  onChoose: (candidate: ComposerCandidate) => void;
  testId: string;
  optionTestId: string;
  className?: string;
  /** 후보 대신 그릴 것. 비동기 소스를 든 트리거에서만 `ready` 밖으로 나간다. */
  status?: ComposerListStatus;
  offline?: boolean;
  onRetry?: () => void;
}) {
  if (kind === null) return null;
  if (kind === "command") {
    return (
      <CommandList
        id={id}
        candidates={candidates}
        highlight={highlight}
        onChoose={onChoose}
        testId={testId}
        optionTestId={optionTestId}
        className={className}
      />
    );
  }
  const spec = composerTriggerSpec(kind);
  if (status !== "ready") {
    const copy = spec.deferred;
    if (copy === undefined) return null;
    return (
      <div
        data-testid={`${testId}-status`}
        data-status={status}
        // 이 상자는 listbox 가 아니다. 고를 것이 없으므로 `aria-controls` 도
        // `aria-activedescendant` 도 이것을 가리키지 않고, 입력창의
        // `aria-expanded` 는 여전히 후보가 있을 때만 참이다. 로딩 중의 Enter 가
        // 평문 전송이라는 뜻이 그 배선과 같은 사실이어야 한다.
        //
        // 폭은 **후보 목록과 같다** (design-review #1930 N-6). 앞 판은 문장이
        // 들어갈 자리를 벌려 `w-pane`(320)을 썼고, 그래서 같은 트리거의 같은
        // 자리가 상태에 따라 192↔320 으로 커졌다 작아졌다. 자리의 폭은 그
        // 자리의 것이지 지금 그 안에 무엇이 있느냐의 것이 아니다. 192 에서도
        // 문장은 읽힌다(실측: 오류 3줄 + 「다시 시도」 나란히, 무결과 3줄) —
        // 배너·무결과 상자에 `px-2` 를 주어 후보 행의 자와 맞추면 된다.
        className={cn(PANEL_CLASS, "w-pane-sm", className)}
        // 목록 자리의 클릭은 캐럿을 뺏지 않는다. 「다시 시도」를 누른 뒤에도
        // 사람은 쓰던 문장 안에 있어야 한다(후보 행의 mousedown 과 같은 규율).
        onMouseDown={(event) => event.preventDefault()}
      >
        {status === "loading" ? (
          <Skeleton ready={false} rows={3} className="p-0" />
        ) : status === "error" ? (
          <InlineBanner
            message={offline ? copy.offline : copy.error}
            actionLabel={copy.retry}
            onAction={onRetry}
            separator={false}
            // 배너의 기본 `px-4` 는 자기 상자에 혼자 설 때의 자다. 여기서는 후보
            // 행(`px-2`)의 자를 따른다 — 그 자리에 번갈아 서는 두 상자다.
            className="px-2"
            testId={`${testId}-error`}
          />
        ) : (
          <EmptyInvite
            headline={copy.emptyHeadline}
            detail={copy.emptyDetail}
            className="px-2 py-3"
            testId={`${testId}-empty`}
          />
        )}
      </div>
    );
  }
  if (candidates.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={spec.listLabel}
      data-testid={testId}
      className={cn(PANEL_CLASS, "w-pane-sm", className)}
    >
      {candidates.map((candidate, index) => (
        <li key={candidate.id}>
          <button
            id={`${id}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === highlight}
            data-testid={optionTestId}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(candidate);
            }}
            className={cn(
              "flex w-full flex-wrap items-center gap-x-2 rounded-sm px-2 py-1 text-left text-body",
              index === highlight
                ? "bg-accent-soft text-ink active:bg-surface-pressed"
                : "text-ink hover:bg-surface-hover active:bg-surface-pressed"
            )}
          >
            {candidate.mark === "private-channel" && (
              // 사이드바·⌘K 와 같은 글리프이고 같은 자리다(이름 앞, `#` 대신).
              // 행의 접근 이름은 방 이름이 진다 — 그 두 표면도 같은 규율이다.
              <Lock className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="line-clamp-2 break-words">{candidate.lead}</span>
            {candidate.hint !== "" && (
              <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
                {candidate.hint}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 명령 줄의 글리프. 이름만 받는 코어 아이콘(`CommandIcon`)을 이 목록이 쓰는
 * 것으로 푼다. ⌘K와 같은 글리프다(`QuickSwitcher` `COMMAND_ICONS`의 `ai-connect`
 * · `credentials`). 슬래시로 부를 수 있는 명령이 늘면 여기 한 줄씩 는다.
 */
const COMMAND_LIST_ICONS: Partial<Record<CommandIcon, LucideIcon>> = {
  "ai-connect": Plug,
  credentials: KeyRound,
};

/** 목록 발치의 키 안내(시안 ① `.mf`). */
const COMMAND_LIST_FOOT = ["↑↓ 고르기", "↵ 열기", "Esc 닫기", "메시지 맨 앞에서만 열려요"];

/**
 * `/` 명령 목록 (#2942 GC-1, 시안 `chat-genui-connect/mockups.html` ① `.menu`).
 *
 * `@`·`#`·`:` 의 한 줄 행과 모양이 다른 이유: 명령 줄은 **넣을 글자가 아니라
 * 할 일**이다. 그래서 무엇을 하는지(설명 줄)와 어떤 키가 그것을 하는지(↵ 키캡,
 * 발치 안내)가 줄에 함께 서야 하고, 시안이 그 모양을 정했다. 목록 기계(파서·
 * 강조·키 처리·listbox 배선)는 셋과 같은 한 벌이다 — 다른 것은 그리는 모양뿐이다.
 *
 * 머리글·발치는 listbox 밖이다. 고를 수 없는 글자가 옵션 사이에 끼면 화면
 * 낭독기가 그것을 옵션으로 센다.
 */
function CommandList({
  id,
  candidates,
  highlight,
  onChoose,
  testId,
  optionTestId,
  className,
}: {
  id: string;
  candidates: ComposerCandidate[];
  highlight: number;
  onChoose: (candidate: ComposerCandidate) => void;
  testId: string;
  optionTestId: string;
  className?: string;
}) {
  if (candidates.length === 0) return null;
  // 접근 이름과 머리글은 트리거 표의 데이터다(#1930 규율 그대로).
  const spec = composerTriggerSpec("command");
  return (
    <div
      data-testid={`${testId}-panel`}
      // 넓은 창에서는 시안의 440이고, 그보다 좁은 컴포저에서는 좌우 여백 안을
      // 채운다(폰·스레드가 열린 좁은 판). 폭이 목록을 넘어 화면 밖으로 새지 않는다.
      className={cn(
        "absolute bottom-full left-3 right-3 mb-2 max-w-pane-command overflow-hidden rounded-lg border border-line bg-surface-raised p-1 shadow-lg",
        className
      )}
      // 목록 자리의 클릭은 캐럿을 뺏지 않는다(후보 행의 mousedown과 같은 규율).
      onMouseDown={(event) => event.preventDefault()}
    >
      <p className="px-3 pb-1 pt-row text-timestamp font-semibold text-ink-muted" aria-hidden="true">
        {spec.listLabel}
      </p>
      <ul id={id} role="listbox" aria-label={spec.listLabel} data-testid={testId}>
        {candidates.map((candidate, index) => {
          const command = candidate.command;
          const Icon = (command && COMMAND_LIST_ICONS[command.icon]) ?? Plug;
          const matched = command?.matched ?? 0;
          const on = index === highlight;
          return (
            <li key={candidate.id}>
              <button
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={on}
                data-testid={optionTestId}
                data-command-id={command?.commandId}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChoose(candidate);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-row text-left text-body text-ink",
                  on
                    ? "bg-surface-hover active:bg-surface-pressed"
                    : "hover:bg-surface-hover active:bg-surface-pressed"
                )}
              >
                <span
                  className="grid size-control-sm shrink-0 place-items-center rounded-md border border-line bg-surface-muted text-ink-muted"
                  aria-hidden="true"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <span className="text-signal-text">{candidate.lead.slice(0, matched)}</span>
                    {candidate.lead.slice(matched)}
                  </span>
                  <span className="block truncate text-meta text-ink-muted">
                    {candidate.hint}
                  </span>
                </span>
                {on && (
                  <span className="shrink-0" aria-hidden="true">
                    <Keycaps keycaps={["↵"]} variant="inline" />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p
        className="mt-1 flex flex-wrap gap-x-3 border-t border-line px-3 pb-1 pt-row text-timestamp text-ink-muted"
        data-testid={`${testId}-foot`}
      >
        {COMMAND_LIST_FOOT.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </p>
    </div>
  );
}
