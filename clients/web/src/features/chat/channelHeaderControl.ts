import { cn } from "@/design/lib/cn";

/**
 * 채널 헤더 우측 라운드 사각 컨트롤 (#1865).
 *
 * 새벽하늘(DS2-1 #2713): 시안 A 헤더 `.a-ibtn` — 34px(`size-icon-button`), 반경 10
 * (`rounded-md`), 테두리 없음, `--ink-muted`. hover 때만 채움. outline 테두리는
 * 텍스트 입력 그릇에만 남는다(ADR-0189 D6). 숫자가 붙으면 `wide`.
 */
export function channelHeaderControlClass(options?: {
  pressed?: boolean;
  wide?: boolean;
}) {
  return cn(
    "flex shrink-0 items-center justify-center rounded-md press focus-visible:focus-ring",
    options?.wide ? "h-icon-button gap-1 px-2 text-meta" : "size-icon-button",
    options?.pressed
      ? "bg-accent-soft text-signal-text active:bg-surface-pressed"
      : "text-ink-muted hover:bg-surface-hover data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
  );
}
