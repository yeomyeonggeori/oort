import { cn } from "@/design/lib/cn";

/**
 * 채널 헤더 우측 라운드 사각 컨트롤 (#1865).
 *
 * 새벽하늘(DS2-1 #2713): 시안 A 헤더 `.a-ibtn` — 34px(`size-icon-button`), 반경 10
 * (`rounded-md`), `--ink-muted`. 숫자가 붙으면 `wide`.
 *
 * #4591(owner 2026-10-26, Buzz 캡처): 단추마다 **아주 연한 선**(`--line`)으로 구분한 둥근 사각이다. 이전의
 * 「테두리 없음, hover 때만 채움」(ADR-0189 D6)을 머리 단추에 한해 바꾼 것이다. 이 선은 **구분**이지
 * 어포던스가 아니다: 컨트롤이라는 말은 아이콘과 hover 채움이 하고(`#1210 D1`은 컨트롤 경계를 3:1 `--line-strong`으로
 * 요구한다), 선은 단추들이 서로 그리고 머리와 나뉘어 읽히게만 한다. 대비를 높이는 사용자(`prefers-contrast: more`)에게는
 * 3:1 선이 돌아온다. 텍스트 입력 그릇의 3:1 테두리 규칙은 그대로다.
 *
 * 상태는 전부 토큰이다.
 *   · 쉼        `border-line` + 투명 면, `text-ink-muted`
 *   · hover     `bg-surface-hover`
 *   · 눌림      `active:bg-surface-pressed` + `.press`(scale)
 *   · 열림      `data-[state=open]`(메뉴·팝오버가 열려 있는 동안) hover 채움 + `text-ink`
 *   · 켜짐      `pressed`: 신호 면(`bg-accent-soft`)이 구분을 맡으므로 선은 투명이다(1px는 그대로 자리를 지킨다)
 *   · 초점      `focus-visible:focus-ring`
 *
 * 이 클래스를 쓰는 단추는 전부 디자인 시스템 `Tooltip`으로 감싼다(네이티브 `title` 금지).
 * 툴팁은 **아래** 방향이다: 본문 판이 `overflow: clip`이고 머리 위쪽 여백(13)이 툴팁 높이보다 낮아 위로는
 * 잘린다(`ChatShell.header.test.ts`가 모든 사용처를 잰다).
 */
export function channelHeaderControlClass(options?: {
  pressed?: boolean;
  wide?: boolean;
}) {
  return cn(
    "flex shrink-0 items-center justify-center rounded-md border press focus-visible:focus-ring",
    options?.wide ? "h-icon-button gap-1 px-2 text-meta" : "size-icon-button",
    options?.pressed
      ? "border-transparent bg-accent-soft text-signal-text active:bg-surface-pressed"
      : "border-line text-ink-muted hover:bg-surface-hover active:bg-surface-pressed contrast-more:border-line-strong data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
  );
}
