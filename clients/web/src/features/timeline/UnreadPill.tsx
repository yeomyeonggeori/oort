import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 타임라인 점프 필 (BF-A2).
//
// 하단 「최신으로」와 상단 「안읽음으로」는 목적지만 다르고 옷은 같다. 두 벌을
// 그리면 한쪽만 손대는 다음 티켓이 얼굴을 가른다 — 그래서 direction 하나로
// 같은 버튼을 쓴다 (buzz UnreadPill 동형).
// =============================================================================

/** 하단 jump-latest가 쓰던 클래스. 상단 필도 이 한 줄을 입는다. */
export const UNREAD_PILL_CLASS =
  "pointer-events-auto flex h-control-sm items-center gap-2 rounded-sm border border-line-strong bg-surface-raised px-3 text-meta text-ink hover:bg-surface-hover focus-visible:focus-ring";

export function UnreadPill({
  direction,
  label,
  accessibleLabel,
  onClick,
  testId,
  count,
}: {
  direction: "up" | "down";
  label: ReactNode;
  accessibleLabel: string;
  onClick: () => void;
  testId: string;
  count?: number;
}) {
  const Arrow = direction === "up" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      data-testid={testId}
      data-new-count={count}
      data-direction={direction}
      aria-label={accessibleLabel}
      onClick={onClick}
      className={UNREAD_PILL_CLASS}
    >
      <Arrow className="size-4 shrink-0" aria-hidden="true" />
      {/* 라벨은 한 조각. flex 자식으로 쪼개면 gap이 낱말 사이에 끼어
          「새 메시지  1  개」가 된다. */}
      <span>{label}</span>
    </button>
  );
}

/** 타임라인 스크롤러 위/아래에 띄우는 자리. 클릭은 필만 받고 아래 행은 통과. */
export function UnreadPillDock({
  side,
  children,
}: {
  side: "top" | "bottom";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex justify-center",
        side === "top" ? "top-2" : "bottom-2"
      )}
    >
      {children}
    </div>
  );
}

export function jumpLatestLabel(newCount: number): ReactNode {
  if (newCount > 0) {
    return (
      <>
        새 메시지 <span data-numeric>{newCount}</span>개 보기
      </>
    );
  }
  return "최신 메시지로 이동";
}

export function jumpUnreadLabel(count: number): ReactNode {
  return (
    <>
      새 메시지 <span data-numeric>{count}</span>개
    </>
  );
}

/** 보이는 문장과 같은 이름. 새 aria-label을 붙이면 낭독이 달라진다. */
export function jumpLatestAriaLabel(newCount: number): string {
  return newCount > 0 ? `새 메시지 ${newCount}개 보기` : "최신 메시지로 이동";
}

export function jumpUnreadAriaLabel(count: number): string {
  return `위쪽의 새 메시지 ${count}개로 이동합니다`;
}