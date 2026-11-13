import type { HTMLAttributes, ReactNode } from "react";
import type { StatusDotTone } from "@momo/core/features/presence/statusDot";
import type { WebStatusBadgeFace } from "@momo/core/features/presence/statusBadge";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 아바타 + 모서리 상태 점 — 웹의 **한 부품** (#5786, owner 2026-11-13 QA 15).
//
// 사이드바 DM 줄(24)·접힌 레일과 목록 끝의 내 프로필(24·32)·멤버 목록·채널 멤버 패널(32)·멤버 프로필 창의 큰 얼굴(112)이
// 모두 이 부품을 쓴다. 예전에는 세 군데가 점 크기·테두리를 따로 적어 비율이 25~37%로 갈렸다. 이제 크기는 코어
// `statusBadgeGeometry`(아바타 한 변 → 점 ≈ 38%·틈 2, 큰 얼굴은 비례) 한 함수가 정하고 `tokens.css` 의 `avatar-status`
// 규칙이 그 표를 옮긴다(인라인 스타일을 쓰지 않으므로 `data-status-face` 로 고른다).
//
// 모양: 아바타를 점 둘레만큼 **도려내고**(CSS 마스크, 새 `<svg>` 없음) 그 자리에 점을 앉힌다. 틈은 비어 있어 줄을
// 가리키거나 골라도, 띠 테마·사진 위에서도 점 둘레에 색 테가 서지 않는다. 점은 상태마다 모양이 다르다(채운 원 · 초승달
// · 가로 줄 · 속 빈 고리) — 글자가 곁에 없는 자리라 색만으로 말하지 않는다.
//
// **점이 없으면(모름 = `null`) 도려내지 않는다.** 근거 없는 점을 그리지 않는다는 규칙(ADR-0160 D3)과 같은 이유로, 빈
// 구멍도 그리지 않는다. 상자는 아바타 크기 그대로라 점이 늦게 와도 줄이 움직이지 않는다.
//
// 점은 보조기술에서 숨는다: 같은 사실을 줄·카드의 접근 가능한 이름과 툴팁이 낱말로 잇는다(#4692).
// =============================================================================

export function AvatarStatus({
  face,
  tone,
  dotTestId = "presence-dot",
  className,
  children,
  ...rest
}: {
  /** 아바타 한 변(px). 점의 크기·틈이 여기서 정해진다. */
  face: WebStatusBadgeFace;
  /** 점의 톤. `null` 이면 점도, 도려낸 자리도 없다. */
  tone: StatusDotTone | null;
  dotTestId?: string;
  className?: string;
  /** 아바타 하나. 감싸는 칸이 도려내므로 아바타 쪽은 아무것도 몰라도 된다. */
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  return (
    <span
      {...rest}
      className={cn("avatar-status", className)}
      data-status-face={face}
      data-status-cut={tone === null ? undefined : ""}
    >
      <span data-avatar-status-face="">{children}</span>
      {tone === null ? null : (
        <span aria-hidden="true" data-avatar-status-dot="" data-testid={dotTestId} data-tone={tone} />
      )}
    </span>
  );
}
