import { EXPRESSION_LIMITS } from "./types";

// =============================================================================
// 「AI와 만들기」 요청 (ADR-0218 §7 G3.2·G3.3·G3.4, #4820 B).
//
// 화면은 두 가지만 한다: 사람이 고른 것을 검사하고, 에이전트와의 DM에 보낼 한국어
// 본문 한 덩이로 만든다. 그림을 만드는 일(에이전트)도 움직임을 입히는 일(서버 조립)도
// 여기 없다. 원본 사진은 같은 메시지의 첨부로 가고, 본문에는 파일 이름·주소·id를
// 싣지 않는다.
//
// 프리셋 표(프레임 수·지연)는 G3.3이 정본이다. 값을 바꾸는 것은 ADR 증보로만 하고
// 시험이 이 값을 잰다. 이름과 설명은 화면 몫이라 이 파일이 정한다.
//
// 순수 모듈이다: DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다.
// =============================================================================

export const MOTION_PRESET_IDS = ["bounce", "wobble", "pulse", "sparkle"] as const;
export type MotionPresetId = (typeof MOTION_PRESET_IDS)[number];

export interface MotionPreset {
  readonly id: MotionPresetId;
  /** 사람이 읽는 이름. 칩과 요청 본문이 같이 쓴다. */
  readonly label: string;
  /** 한 줄 설명. */
  readonly description: string;
  /** GIF 프레임 수 (G3.3). */
  readonly frames: number;
  /** 프레임 지연 ms (G3.3). */
  readonly delayMs: number;
  /** 한 번 재생 시간 ms = frames × delayMs. */
  readonly playMs: number;
}

function preset(id: MotionPresetId, label: string, description: string, frames: number, delayMs: number): MotionPreset {
  return Object.freeze({ id, label, description, frames, delayMs, playMs: frames * delayMs });
}

/** G3.3 표 순서 그대로다. 요청 본문의 프리셋 순서도 이 순서로 고정된다. */
export const MOTION_PRESETS: readonly MotionPreset[] = Object.freeze([
  preset("bounce", "통통", "위아래로 통통 튀어요", 16, 40),
  preset("wobble", "흔들흔들", "좌우로 살살 흔들려요", 16, 40),
  preset("pulse", "두근두근", "심장처럼 두 번 두근거려요", 12, 50),
  preset("sparkle", "반짝", "그림은 그대로, 작은 별이 반짝여요", 20, 50),
]);

/**
 * 「움직임 없이」: 정지된 새 표현. 프리셋과 섞지 않고 혼자만 고른다.
 * 이 선택을 서버·에이전트가 처리하는 길은 화면 밖의 일이고, 화면은 요청 본문까지만 만든다.
 */
export const STILL_MOTION = Object.freeze({
  id: "still",
  label: "움직임 없이",
  description: "움직이지 않는 새 이모티콘으로 만들어요",
  /** 요청 본문의 움직임 줄에 쓰는 말. */
  requestLine: "없음(정지)",
} as const);

export type MotionChoice = MotionPresetId | typeof STILL_MOTION.id;

/** 한 번에 고를 수 있는 프리셋 수. 후보는 프리셋마다 하나라 후보 상한(4)과 같다. */
export const MAKE_PRESET_MAX = 4;
/** 요청 메모 상한(자). trim 뒤의 글자 수(코드 포인트)로 잰다. */
export const MAKE_NOTE_MAX = 500;
/** 정사각 캔버스 한 변(G3.2). 화면에는 고르개가 없고 본문에는 기본값을 적는다. */
export const MAKE_SIZES = [240, 360, 480] as const;
export type MakeSize = (typeof MAKE_SIZES)[number];
export const MAKE_DEFAULT_SIZE: MakeSize = 360;
/** 움직이는 결과는 총 4회 재생하고 멈춘다(G3.4). 미리보기도 같다. */
export const MAKE_PLAYS = 4;

/**
 * 원본 사진의 한도. 대화 첨부(100 MiB)보다 D3 정지 입력 한도가 더 엄격하므로 이쪽을 쓴다
 * (G3.2: 서버 안에서 옮겨 온 원본은 5 MiB, 한 변 4096, 합쳐서 16,000,000 화소).
 */
export const MAKE_SOURCE_LIMITS = Object.freeze({
  bytes: EXPRESSION_LIMITS.inputBytes,
  edge: 4096,
  pixels: 16_000_000,
});

/** 가로세로가 정지 입력 한도 안인가. 0이거나 정수가 아니면 안이 아니다. */
export function fitsStillInput(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAKE_SOURCE_LIMITS.edge &&
    height <= MAKE_SOURCE_LIMITS.edge &&
    width * height <= MAKE_SOURCE_LIMITS.pixels
  );
}

export type MakeIssue =
  | "motion_missing"
  | "presets_unknown"
  | "presets_duplicate"
  | "presets_too_many"
  | "still_mixed"
  | "note_too_long"
  | "size_invalid";

/** 화면이 들고 있는 날것의 선택. 잘못된 조합도 담을 수 있어야 검사가 그것을 잡는다. */
export interface MakeSelection {
  readonly presets: readonly string[];
  readonly still?: boolean;
  readonly note?: string;
  readonly size?: number;
}

export type MakeMotion =
  | { readonly kind: "presets"; readonly presets: readonly MotionPresetId[] }
  | { readonly kind: "still" };

/** 검사를 통과한 선택. 프리셋은 표 순서, 메모는 한 줄이다. */
export interface MakeSpec {
  readonly motion: MakeMotion;
  readonly note: string;
  readonly size: MakeSize;
}

export type MakeCheck =
  | { readonly ok: true; readonly spec: MakeSpec }
  | { readonly ok: false; readonly issues: readonly MakeIssue[] };

/** 메모의 글자 수. UTF-16 길이가 아니라 코드 포인트로 센다(이모지 하나가 둘이 되지 않는다). */
export function makeNoteLength(note: string): number {
  return Array.from(note.trim()).length;
}

const KNOWN_PRESETS: ReadonlySet<string> = new Set(MOTION_PRESET_IDS);

export function checkMakeSelection(selection: MakeSelection): MakeCheck {
  const raw = selection.presets;
  const still = selection.still === true;
  const size = selection.size ?? MAKE_DEFAULT_SIZE;
  const note = (selection.note ?? "").trim();
  const issues: MakeIssue[] = [];
  if (raw.length === 0 && !still) issues.push("motion_missing");
  if (raw.some((id) => !KNOWN_PRESETS.has(id))) issues.push("presets_unknown");
  if (new Set(raw).size !== raw.length) issues.push("presets_duplicate");
  if (raw.length > MAKE_PRESET_MAX) issues.push("presets_too_many");
  if (raw.length > 0 && still) issues.push("still_mixed");
  if (Array.from(note).length > MAKE_NOTE_MAX) issues.push("note_too_long");
  if (!(MAKE_SIZES as readonly number[]).includes(size)) issues.push("size_invalid");
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    spec: {
      motion: still
        ? { kind: "still" }
        : { kind: "presets", presets: MOTION_PRESET_IDS.filter((id) => raw.includes(id)) },
      // 줄 목록의 한 줄에 들어가므로 안의 줄바꿈과 공백 뭉치는 한 칸으로 접는다.
      note: note.replace(/\s+/g, " "),
      size: size as MakeSize,
    },
  };
}

/** 검사를 통과하지 못한 선택으로 본문을 만들려 할 때. 화면은 먼저 검사하므로 일어나지 않아야 한다. */
export class MakeSelectionError extends Error {
  readonly issues: readonly MakeIssue[];
  constructor(issues: readonly MakeIssue[]) {
    super(`invalid make selection: ${issues.join(",")}`);
    this.name = "MakeSelectionError";
    this.issues = issues;
  }
}

/**
 * 에이전트와의 DM에 보낼 한국어 본문. 같은 입력이면 같은 문자열이다.
 * 사람이 읽는 첫 문장과 에이전트가 읽기 쉬운 줄 목록으로 쓴다:
 *
 *   이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.
 *   - 움직임: 통통(bounce), 반짝(sparkle)
 *   - 크기: 360
 *   - 요청: 웃는 얼굴로
 */
export function buildMakeRequest(selection: MakeSelection): string {
  const check = checkMakeSelection(selection);
  if (!check.ok) throw new MakeSelectionError(check.issues);
  const { motion, note, size } = check.spec;
  const still = motion.kind === "still";
  const motionLine = motion.kind === "still"
    ? STILL_MOTION.requestLine
    : motion.presets
        .map((id) => {
          const found = MOTION_PRESETS.find((entry) => entry.id === id);
          return `${found?.label ?? id}(${id})`;
        })
        .join(", ");
  const lines = [
    still ? "이 사진으로 새 팀 이모티콘을 만들어 주세요." : "이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.",
    `- 움직임: ${motionLine}`,
    `- 크기: ${size}`,
  ];
  if (note !== "") lines.push(`- 요청: ${note}`);
  return lines.join("\n");
}

/** 칩 묶음의 현재 선택. 프리셋은 표 순서로 유지된다. */
export interface MotionPick {
  readonly presets: readonly MotionPresetId[];
  readonly still: boolean;
}

export type MotionToggle =
  | { readonly ok: true; readonly pick: MotionPick }
  | { readonly ok: false; readonly issue: "presets_too_many" | "still_mixed" };

/**
 * 칩 하나를 눌렀을 때의 결과. 해제는 언제나 된다. 더하는 것이 규칙을 깨면 막고 이유를
 * 코드로 돌려준다: 말없이 다른 선택을 지우지 않는다. 화면과 폰이 같은 규칙을 쓰게 여기 둔다.
 */
export function toggleMotionChoice(pick: MotionPick, choice: MotionChoice): MotionToggle {
  if (choice === STILL_MOTION.id) {
    if (pick.still) return { ok: true, pick: { presets: pick.presets, still: false } };
    if (pick.presets.length > 0) return { ok: false, issue: "still_mixed" };
    return { ok: true, pick: { presets: [], still: true } };
  }
  if (pick.presets.includes(choice)) {
    return { ok: true, pick: { presets: pick.presets.filter((id) => id !== choice), still: pick.still } };
  }
  if (pick.still) return { ok: false, issue: "still_mixed" };
  if (pick.presets.length >= MAKE_PRESET_MAX) return { ok: false, issue: "presets_too_many" };
  return {
    ok: true,
    pick: { presets: MOTION_PRESET_IDS.filter((id) => id === choice || pick.presets.includes(id)), still: false },
  };
}
