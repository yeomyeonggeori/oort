/**
 * ADR-0179 D4·D5 — 공용 모션 클래스 상수.
 *
 * 숫자는 `motion.css`(사다리 + 모달 200/150)에만 산다. 이 파일은 그 유틸을
 * 조립한다. 표면은 `\d+ms` 나 `duration-[0-9]+` 를 직접 적지 않는다.
 * 이 티켓은 상수를 조립만 하고 소비하지 않는다(UX-R1a~e).
 */

export const MODAL_OVERLAY_MOTION =
  "data-[state=open]:motion-modal-enter data-[state=closed]:motion-modal-exit motion-reduce:animate-none";

export const MODAL_CONTENT_MOTION =
  "origin-center data-[state=open]:motion-modal-enter-zoom data-[state=closed]:motion-modal-exit-zoom motion-reduce:animate-none";

export const POPOVER_MOTION =
  "data-[state=open]:motion-enter data-[state=closed]:motion-exit motion-reduce:animate-none";

/** D5. `active:scale-[0.98]` 은 arbitrary 금지와 충돌하므로 `.press`. */
export const PRESS_CLASS = "press";
