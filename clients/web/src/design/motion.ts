/**
 * ADR-0179 D4·D5 — 공용 모션 클래스 상수.
 *
 * 숫자는 여기(모달 열림 200 / 닫힘 150, D4 예외 2호)와 `motion.css`(사다리)에만
 * 산다. 표면은 `\d+ms` 나 `duration-[0-9]+` 를 직접 적지 않는다.
 * 이 티켓은 상수를 조립만 하고 소비하지 않는다(UX-R1a~e).
 */

export const MODAL_OVERLAY_MOTION =
  "transition-none duration-200 ease-out data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none";

export const MODAL_CONTENT_MOTION =
  "origin-center transition-none duration-200 ease-out data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none";

export const POPOVER_MOTION =
  "motion-standard data-[state=closed]:motion-fast data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none";

/** D5. `active:scale-[0.98]` 은 arbitrary 금지와 충돌하므로 `@utility press`. */
export const PRESS_CLASS = "press";
