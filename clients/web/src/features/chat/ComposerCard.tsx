import type { MouseEvent, ReactNode, RefObject } from "react";
import { AtSign, SendHorizontal, Smile } from "lucide-react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { AttachButton } from "@/features/attachments/AttachmentTray";
import { ComposerFormatButton } from "@/features/chat/ComposerFormatButton";
import { ScheduleSendMenu, type ScheduleSendMenuProps } from "@/features/scheduled/ScheduleSendMenu";

// =============================================================================
// 입력창의 카드 (#5324, owner 2026-11-05). 채널 입력창(`Composer`)과 스레드 패널 답글 입력창(`ThreadComposer`)이 **같은 카드**다.
//
// 스레드 입력창은 자기 그릇을 따로 그리고 있었다(`rounded-md border border-line-strong` 상자, 위 경계선, 서식 단추 없음, 손으로 만든 보내기
// 단추). 사람 눈에는 같은 일(글 쓰기)을 하는 입력창이 두 모양이었고, owner 가 「답글 채팅창은 보더 있고 UI 독특하던데」라고 짚었다. 그래서
// 그릇·도구 줄·보내기 알약을 이 한 곳에 둔다: 반경·그림자·테두리·바탕·안쪽 여백은 `composer-card`(tokens.css) 한 유틸리티가 정하고, 도구 줄의
// 단추 묶음(첨부·멘션·이모지·서식)과 보내기 + ▾ 알약은 아래 두 부품이 정한다. 두 입력창이 다른 것은 **자리표시 글과 그릇 안에 넣는 내용**
// (맥락 띠·힌트 줄·작성 중 줄)뿐이다 — 그 자리는 이 부품의 `children`·`meta` 슬롯이다.
//
// 이 부품은 상태를 갖지 않는다: 초안·보내기·멘션·예약은 각 입력창의 것이고, 여기는 그것을 **같은 모양으로 그리기만** 한다.
// 시험 열쇠는 `testIdPrefix`("composer" | "thread-composer")가 앞에 붙는다 — 두 입력창이 한 화면에 함께 서므로 열쇠가 겹치지 않는다.
// =============================================================================

/**
 * 글 칸의 옷 — 두 입력창이 같은 글 칸이다(`px-3 py-2` 인셋·글자 크기·줄 간격·안내 문구 색). `composer-placeholder` 는 안내 문구가 한 줄을 넘지
 * 않게 하는 마지막 방어선이다(tokens.css). 포커스 표시는 한 컨트롤인 바깥 그릇(`composer-card`)이 진다: 안쪽 textarea 의 UA outline 까지 남기면
 * 그릇 안에 두 번째 상자가 생긴다.
 */
export const COMPOSER_TEXTAREA_CLASS =
  "tap-target composer-placeholder block w-full min-w-0 resize-none rounded-sm bg-transparent px-3 py-2 text-body leading-relaxed outline-none placeholder:text-ink-muted focus-visible:outline-none";

/** 카드 안에서 누른 곳이 자기 액션을 가진 컨트롤(단추·첨부 카드)이 아니면 캐럿을 글 칸으로 돌려준다. */
function focusInputUnlessControl(event: MouseEvent, inputRef: RefObject<HTMLTextAreaElement | null>) {
  // 버튼과 그 자식(svg/path)은 자기 액션을 가진다. 나머지 그릇 면적은 한 입력 컨트롤의 일부이므로 액션 행의 빈 폭을 눌러도 캐럿을 돌려준다.
  // 첨부 카드는 초점을 받는 자기 컨트롤이다(Backspace/Delete 로 뺀다). 눌러서 캐럿을 글 칸으로 돌려주면 방금 카드에 둔 초점이 튕겨 나간다.
  if (event.target instanceof Element && event.target.closest("button, [data-attachment-card]")) {
    return;
  }
  inputRef.current?.focus();
}

export function ComposerCard({
  testIdPrefix,
  inputRef,
  warn = false,
  sending = false,
  tools,
  meta,
  send,
  children,
}: {
  testIdPrefix: "composer" | "thread-composer";
  /** 글 칸. 카드의 빈 면적을 누르면 캐럿이 여기로 돌아온다. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 비밀 키 모양 때문에 막았다: 그릇 테두리가 경고색이 된다. */
  warn?: boolean;
  /** 보내는 중: 그릇 전체가 50%로 흐려지고 `aria-busy` 다(안쪽 컨트롤은 따로 더 흐리지 않는다). */
  sending?: boolean;
  /** 도구 줄의 왼쪽 묶음(`ComposerTools`). */
  tools: ReactNode;
  /** 도구 줄의 가운데 슬롯(힌트·작성 중·예약 확정 줄). 없으면 도구와 보내기가 양끝에 선다. */
  meta?: ReactNode;
  /** 도구 줄의 오른쪽 알약(`ComposerSend`). */
  send: ReactNode;
  /** 글 칸 위의 것들(맥락 띠·첨부 줄)과 글 칸. */
  children: ReactNode;
}) {
  return (
    <div
      // 입력 그릇이 곧 떠 있는 카드다. 폰에서는 3:1 경계(--line-strong)의 그릇이고, 넓은 창에서는 반경 20 · float 그림자 · 1px 선 고리다(시안).
      // 고대비에서는 고리가 다시 --line-strong이 된다(tokens.css).
      className={cn(
        "composer-card @container focus-visible-within:focus-ring data-warn:border-warn",
        sending && "opacity-50"
      )}
      aria-busy={sending || undefined}
      data-sending={sending ? "" : undefined}
      data-warn={warn ? "" : undefined}
      data-testid={`${testIdPrefix}-frame`}
      data-composer-frame=""
      onClick={(event) => focusInputUnlessControl(event, inputRef)}
    >
      {children}
      <div
        className="flex items-center justify-between gap-2 pb-2 pl-1 pr-2"
        data-testid={`${testIdPrefix}-actions`}
      >
        {tools}
        {meta}
        {send}
      </div>
    </div>
  );
}

/**
 * 도구 줄의 왼쪽 묶음: 「+」 첨부, 멘션, 이모지, 서식. 「+」는 맨 왼쪽이다(Codex 입력창·폰 #4305와 같은 순서). 서식 단추는 글 칸을 고른
 * 글에 서식을 입히는 두 번째 길이라 `useComposerFormat` 이 `available` 일 때만 선다(터치 기기는 OS 콜아웃이 같은 자리를 쓴다).
 */
export function ComposerTools({
  testIdPrefix,
  onPickFiles,
  attachDisabled = false,
  toolsDisabled = false,
  settledWhenDisabled = false,
  onInsertMention,
  onOpenEmoji,
  format,
}: {
  testIdPrefix: "composer" | "thread-composer";
  onPickFiles: (files: File[]) => void;
  /** 첨부만 막힌다(채널 입력창은 오프라인에서 첨부만 막는다). */
  attachDisabled?: boolean;
  /** 멘션·이모지가 막힌다(보내는 중). */
  toolsDisabled?: boolean;
  /** 막혀도 더 흐리지 않는다 — 그릇이 이미 흐려져(`sending`) 단추까지 겹쳐 흐리면 이중이다. */
  settledWhenDisabled?: boolean;
  onInsertMention: () => void;
  /** 눌린 이모지 단추(`event.currentTarget`)를 피커의 열림 자리로 넘긴다. */
  onOpenEmoji: (opener: HTMLButtonElement) => void;
  /** `useComposerFormat` 에서 온 값. `hasText` 가 거짓이면 단추는 흐리고 눌러도 아무 일이 없다. */
  format: { available: boolean; open: boolean; hasText: boolean; onPress: () => void };
}) {
  const settled = settledWhenDisabled ? "disabled:opacity-100" : undefined;
  return (
    <div className="flex items-center gap-1">
      {/* 「+」는 도구 줄의 맨 왼쪽이다. 첨부이고, 앱 피커(#4315)가 서면 이 자리의 메뉴가 된다. */}
      <AttachButton onPick={onPickFiles} disabled={attachDisabled} className={settled} />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("tap-target shrink-0", settled)}
        disabled={toolsDisabled}
        aria-label="멘션 넣기"
        title="멘션 넣기"
        data-testid={`${testIdPrefix}-mention-trigger`}
        onClick={onInsertMention}
      >
        <AtSign aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("tap-target shrink-0", settled)}
        disabled={toolsDisabled}
        aria-label="이모지 넣기"
        title="이모지 넣기"
        data-testid={`${testIdPrefix}-emoji-trigger`}
        onClick={(event) => onOpenEmoji(event.currentTarget)}
      >
        <Smile aria-hidden="true" />
      </Button>
      <ComposerFormatButton
        available={format.available}
        open={format.open}
        hasText={format.hasText}
        onPress={format.onPress}
        testId={`${testIdPrefix}-format-trigger`}
        // 카드가 xs(320px)보다 좁으면(접히지 않은 사이드바 옆 600폭, 스레드 패널) 서식 단추부터 접는다: 단추를 더 얹으면 ▾가 카드 밖으로
        // 나간다. 서식은 ⌘B·⌘I 로도 닿는다.
        className="@max-xs:hidden"
      />
    </div>
  );
}

/**
 * 보내기 반쪽 + ▾ 반쪽이 알약 하나다(UI 명세 1.1). ▾가 없는 서버에서는 예전 그대로 원 하나다. 보내기 단추는 `Button size="icon"`(34px
 * 원, 잉크 채움)이다. 채널 입력창은 `<form>` 의 제출(`type="submit"`)이고 스레드 입력창은 자기 `submit()` 을 부른다(`type="button"` + `onClick`).
 */
export function ComposerSend({
  testIdPrefix,
  type,
  onClick,
  disabled,
  busy = false,
  settledWhenDisabled = false,
  label,
  title,
  showsSchedule,
  schedule,
}: {
  testIdPrefix: "composer" | "thread-composer";
  type: "submit" | "button";
  onClick?: () => void;
  disabled: boolean;
  /** 예약 요청이 나는 동안: `aria-busy`. */
  busy?: boolean;
  /** 막혀도 더 흐리지 않는다(보내는 중에는 그릇이 흐림을 진다). 빈 초안처럼 그릇이 정상인 판에서는 단추 자신이 50%로 흐려진다. */
  settledWhenDisabled?: boolean;
  label: string;
  title: string;
  showsSchedule: boolean;
  schedule: ScheduleSendMenuProps;
}) {
  return (
    <div className="flex shrink-0 items-center gap-px">
      <Button
        type={type}
        size="icon"
        className={cn(
          "tap-target shrink-0",
          showsSchedule && "rounded-r-none",
          settledWhenDisabled && "disabled:opacity-100"
        )}
        // 오프라인에서는 보낼 수 없다 (진단 H-10). 누르면 실패 행 하나를 만들고 끝나므로, 막고 **왜**를 위 한 줄이 말한다.
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={label}
        title={title}
        data-testid={`${testIdPrefix}-send`}
        onClick={onClick}
      >
        <SendHorizontal />
      </Button>
      <ScheduleSendMenu {...schedule} />
    </div>
  );
}
