// =============================================================================
// 메뉴 막대 메뉴에서 고른 것을 셸이 페이지에 알리는 말의 어휘와 읽기 (#5193).
//
// 셸(Rust)은 메뉴 막대 아이콘의 메뉴에서 페이지가 해야 할 일이 있는 항목이 눌렸을 때만 `momo:tray-action` 을 쏜다
// (「oort 열기」는 셸이 창만 앞으로 가져오고 알리지 않는다). 페이로드는 IPC 경계를 넘어온 값이라 웹은 모양부터 읽는다.
// 그 읽기는 플랫폼과 무관한 순수 함수라서 여기에 둔다(`bannerClick.ts`와 같은 이유).
//
// Rust 쪽 짝: `clients/desktop/src-tauri/src/tray.rs`(`TrayAction`, `tag = "action"`·kebab-case 직렬화). 단어가 어긋나면
// 앱 안에서만 조용히 죽으므로 양쪽 시험이 각자 단어를 글자 그대로 적는다.
// =============================================================================

/** 셸이 알리는 두 가지. 값이 와이어의 `action` 이다. */
export const TRAY_ACTION = {
  /** 「새 메시지」: 새 다이렉트 메시지 모달을 연다. */
  newMessage: "new-message",
  /** 실행 중인 작업 줄: `id` 는 페이지가 마지막으로 보낸 줄의 id 다. */
  run: "run",
} as const;

export type TrayAction =
  | { action: typeof TRAY_ACTION.newMessage }
  | { action: typeof TRAY_ACTION.run; id: string };

/** 셸이 줄 id로 받는 모양: `[A-Za-z0-9_-]`, 1~64바이트(셸의 `row_id_ok`와 같다). */
export const TRAY_ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 셸이 알려 온 선택을 읽는다. 모르는 모양은 `null` 이고 아무 일도 일어나지 않는다. 이 함수는 모양만 본다 — 줄 id가 페이지가
 * 실제로 보낸 줄의 것인지는 호출한 쪽이 자기 장부와 대조한다(페이로드를 그대로 이동 경로로 쓰지 않는다).
 */
export function readTrayAction(value: unknown): TrayAction | null {
  if (typeof value !== "object" || value === null) return null;
  const { action, id } = value as { action?: unknown; id?: unknown };
  if (action === TRAY_ACTION.newMessage) return { action };
  if (action === TRAY_ACTION.run && typeof id === "string" && TRAY_ROW_ID.test(id)) {
    return { action, id };
  }
  return null;
}
