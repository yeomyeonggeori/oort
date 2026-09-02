import { cn } from "@/design/lib/cn";

/**
 * 채널 헤더 우측 라운드 사각 컨트롤 (#1865).
 *
 * 32px(`size-control` / `h-control`), 1px `--line-strong`, `rounded-sm`.
 * 아이콘만이면 정사각, 인원수처럼 숫자가 붙으면 `wide`.
 */
export function channelHeaderControlClass(options?: {
  pressed?: boolean;
  wide?: boolean;
}) {
  return cn(
    "flex shrink-0 items-center justify-center rounded-sm border border-line-strong transition-colors focus-visible:focus-ring",
    options?.wide ? "h-control gap-1 px-2 text-meta" : "size-control",
    options?.pressed
      ? "bg-accent-soft text-accent"
      : "text-ink-muted hover:bg-surface-hover data-[state=open]:bg-surface-hover data-[state=open]:text-ink"
  );
}
