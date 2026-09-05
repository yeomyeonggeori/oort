/**
 * ADR-0179 D4·D5 — 공용 모션 클래스 상수.
 *
 * 숫자는 `motion.css`(사다리 + 모달 200/150)에만 산다. 이 파일은 그 유틸을
 * 조립한다. 표면은 `\d+ms` 나 `duration-[0-9]+` 를 직접 적지 않는다.
 * UX-R1a 소비: dialog · popover · dropdown-menu · context-menu.
 * UX-R1b 소비: 390 드로어 스크림 · 스레드 패널 · ⌘K 팔레트.
 *
 * `data-[state=closed]:pointer-events-none` is the owner on nodes we write
 * (thread panel, 390 scrim). Radix `DialogOverlay` writes
 * `pointer-events: auto` inline; the overlay/content closed class uses
 * Tailwind's `!` so the compiled rule is `pointer-events: none !important`
 * and beats that layer without an inline style (#1997 H-1).
 */

export const MODAL_OVERLAY_MOTION =
  "data-[state=open]:motion-modal-enter data-[state=closed]:motion-modal-exit data-[state=closed]:pointer-events-none! motion-reduce:animate-none";

export const MODAL_CONTENT_MOTION =
  "origin-center data-[state=open]:motion-modal-enter-zoom data-[state=closed]:motion-modal-exit-zoom data-[state=closed]:pointer-events-none! motion-reduce:animate-none";

export const POPOVER_MOTION =
  "data-[state=open]:pointer-events-auto data-[state=closed]:pointer-events-none data-[state=open]:motion-enter data-[state=closed]:motion-exit motion-reduce:animate-none";

/** 390 드로어 스크림. enter/exit 대칭 `--motion-fast`.
 * Enter fill is `backwards` (`motion-fast-enter`) so a finished fade does
 * not pin opacity over `.scrim-press:active` (#1997 R12). */
export const DRAWER_SCRIM_MOTION =
  "data-[state=open]:motion-fast-enter data-[state=closed]:motion-fast-exit data-[state=closed]:pointer-events-none motion-reduce:animate-none";

/** 스레드 패널. 열림 standard 우측 슬라이드, 닫힘 fast. */
export const PANEL_MOTION =
  "data-[state=open]:motion-slide-in-end data-[state=closed]:motion-slide-out-end data-[state=closed]:pointer-events-none motion-reduce:animate-none";

/** D5. `active:scale-[0.98]` 은 arbitrary 금지와 충돌하므로 `.press`. */
export const PRESS_CLASS = "press";

/** ADR-0179 D3. Class is the @utility; animationName is the keyframe. */
export const ENTER_CONVERSATION_CLASS = "enter-conversation";
export const ENTER_CONVERSATION_ANIMATION_NAME = "motion-enter-conversation";
