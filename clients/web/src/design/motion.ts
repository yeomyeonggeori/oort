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

/**
 * 이미지 라이트박스의 무대 (#4751). 화면 전체가 뷰어라서 패널처럼 줌하지 않고 **불투명도만** 움직인다: 열림은 사다리의
 * standard(`motion-enter`), 닫힘은 fast(`motion-exit`). 새 시간·곡선 값을 만들지 않고 사다리 유틸을 그대로 쓴다.
 * 동작 줄이기에서는 사다리가 0이고 `animate-none`도 함께 건다(D9).
 */
export const STAGE_MOTION =
  "data-[state=open]:motion-enter data-[state=closed]:motion-exit data-[state=closed]:pointer-events-none! motion-reduce:animate-none";

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

/** #2817 / ADR-0193 D11. 첫 대화 킥오프 띠의 접힘(line-slide). Fill `both`라 접힌
 * 끝이 React가 노드를 걷을 때까지 남는다. keyframe은 tokens.css(온보딩 650ms 자리). */
export const WELCOME_KICKOFF_EXIT_CLASS = "welcome-kickoff-exit";
export const WELCOME_KICKOFF_EXIT_ANIMATION_NAME = "motion-welcome-band-collapse";

/** 이미지 미리보기의 확대 비율 칩 (#4770). 마지막 확대 뒤 이만큼 머물렀다가 걷힌다(움직임이 아니라 머무는 시간). 숫자는 여기 한 곳이다. */
export const ZOOM_CHIP_LINGER_MS = 1200;

/** 공용 툴팁 (#4324). 가리켜서 뜨는 지연. 키보드 초점은 지연 없이 즉시 뜬다.
 * 숫자는 여기 한 곳이다: 표면은 `\d+`ms를 직접 적지 않는다. */
export const TOOLTIP_DELAY_MS = 500;

/** 툴팁 나타남. 정지(`motion-reduce`)면 애니메이션 없이 즉시 선다. */
export const TOOLTIP_MOTION = "motion-tooltip-enter motion-reduce:animate-none";

/** Photo/decision stage (#4775): existing phone VIEWER_SNAP_SPRING (260ms, bounce .14).
 * WAAPI samples the same damped spring within the ladder's arrival window. No motion library. */
export const STAGE_HERO_SPRING = { stiffness: 584, damping: 41.6, mass: 1 } as const;
export const STAGE_HERO_WINDOW_MS = 500;
