// =============================================================================
// 로컬 터미널 칸의 스크롤백 저장 형식 (#2774, ADR-0190 D1, 제안서 §2.2 Orca
// 「headless 미러 + serialize로 스크롤백 복원」).
//
// 칸마다 headless 미러가 PTY 출력을 받아 두고, 호스트는 그 미러를 직렬화한
// 문자열(ANSI 그대로)을 이 기기에 둔다. 앱을 다시 열면 PTY는 새로 뜨지만(앱이
// 닫힐 때 모든 세션이 끝난다, #2772), 칸은 전의 화면을 위에 그대로 보인다.
//
// 저장은 이 기기에만 한다. raw 출력을 서버에 싣지 않는다(ADR-0190 D2).
//
// 크기 상한이 둘이다. 칸 하나가 너무 크면 직렬화 줄 수를 줄여 다시 만든다
// (`fitSerialized`). 모든 칸의 합은 호스트가 저장소 할당량을 넘기지 않게
// `SCROLLBACK_TOTAL_MAX_CHARS`로 본다.
// =============================================================================

export const SCROLLBACK_ENTRY_PREFIX = "momo.web.workbench.scrollback.v1:";

/** 칸 하나의 직렬화 상한(UTF-16 글자 수). */
export const SCROLLBACK_PANE_MAX_CHARS = 192 * 1024;
/** 모든 칸의 합. localStorage 할당량(대개 5 MB)의 절반 아래. */
export const SCROLLBACK_TOTAL_MAX_CHARS = 2 * 1024 * 1024;
/** 직렬화할 스크롤백 줄 수를 이 순서로 줄여 가며 상한 안에 넣는다. */
export const SCROLLBACK_LINE_STEPS: readonly number[] = [2000, 1000, 500, 200, 50, 0];

export interface SavedScrollback {
  v: 1;
  /** 미러가 직렬화한 ANSI 문자열. */
  data: string;
  cols: number;
  rows: number;
  /** epoch ms. 복원 구분선에 쓰지 않고, 오래된 항목 정리에만 쓴다. */
  savedAt: number;
}

export function scrollbackEntry(sessionKey: string, paneId: string): string {
  return `${SCROLLBACK_ENTRY_PREFIX}${sessionKey}:${paneId}`;
}

/**
 * 줄 수를 줄여 가며 상한 안에 드는 첫 직렬화를 고른다. 0줄(화면만)도 넘치면
 * `null`이다. 그때 호스트는 저장하지 않는다(잘못 자른 이스케이프를 저장하지 않는다).
 */
export function fitSerialized(
  serialize: (scrollbackLines: number) => string,
  maxChars: number = SCROLLBACK_PANE_MAX_CHARS
): string | null {
  for (const lines of SCROLLBACK_LINE_STEPS) {
    const data = serialize(lines);
    if (data.length <= maxChars) return data;
  }
  return null;
}

export function serializeScrollback(saved: SavedScrollback): string {
  return JSON.stringify(saved);
}

function isDimension(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

export function parseScrollback(raw: string | null | undefined): SavedScrollback | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.data !== "string" || r.data.length > SCROLLBACK_PANE_MAX_CHARS) return null;
  if (!isDimension(r.cols, 1000) || !isDimension(r.rows, 500)) return null;
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt)) return null;
  return { v: 1, data: r.data, cols: r.cols, rows: r.rows, savedAt: r.savedAt };
}

/**
 * 저장소에 있는 스크롤백 항목 중 지금 배치에 없는 칸의 것을 고른다. 칸을 닫은
 * 뒤 앱이 죽어 지우지 못한 항목, 배치가 기본으로 돌아간 뒤의 옛 항목이다.
 */
export function staleScrollbackEntries(
  entries: readonly string[],
  sessionKey: string,
  livePaneIds: readonly string[]
): string[] {
  const prefix = `${SCROLLBACK_ENTRY_PREFIX}${sessionKey}:`;
  const live = new Set(livePaneIds.map((id) => prefix + id));
  return entries.filter((entry) => entry.startsWith(prefix) && !live.has(entry));
}
