import { describe, expect, it } from "vitest";
import { EXPRESSION_LIMITS } from "./types";
import {
  MAKE_DEFAULT_SIZE,
  MAKE_NOTE_MAX,
  MAKE_PLAYS,
  MAKE_PRESET_MAX,
  MAKE_SIZES,
  MAKE_SOURCE_LIMITS,
  MOTION_PRESETS,
  MOTION_PRESET_IDS,
  MakeSelectionError,
  STILL_MOTION,
  buildMakeRequest,
  checkMakeSelection,
  fitsStillInput,
  makeNoteLength,
  toggleMotionChoice,
  type MakeIssue,
  type MotionPick,
  type MotionPresetId,
} from "./make";

// 금지어는 소스에 그대로 적지 않고 조각으로 적는다: 이 파일을 훑는 사람도 그 말을 만나지 않게 한다.
const BANNED = [["그", "리기"], ["그", "려"], ["그", "리는"]].map((parts) => parts.join(""));
const hasBanned = (text: string) => BANNED.some((word) => text.includes(word));

const ALL: readonly MotionPresetId[] = ["bounce", "wobble", "pulse", "sparkle"];
const EMPTY_PICK: MotionPick = { presets: [], still: false };
const issuesOf = (selection: Parameters<typeof checkMakeSelection>[0]): readonly MakeIssue[] => {
  const check = checkMakeSelection(selection);
  return check.ok ? [] : check.issues;
};
const permutations = <T,>(items: readonly T[]): T[][] =>
  items.length <= 1 ? [[...items]] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));

describe("움직임 프리셋 표 (ADR-0218 G3.3)", () => {
  it("프레임 수, 지연, 한 번 재생 시간이 표 그대로예요", () => {
    expect(MOTION_PRESETS.map(({ id, frames, delayMs, playMs }) => [id, frames, delayMs, playMs])).toEqual([
      ["bounce", 16, 40, 640],
      ["wobble", 16, 40, 640],
      ["pulse", 12, 50, 600],
      ["sparkle", 20, 50, 1000],
    ]);
    expect(MOTION_PRESETS.map((entry) => entry.id)).toEqual([...MOTION_PRESET_IDS]);
  });
  it("이름과 한 줄 설명을 갖고 GIF 한도 안이에요", () => {
    expect(MOTION_PRESETS.map((entry) => entry.label)).toEqual(["통통", "흔들흔들", "두근두근", "반짝"]);
    for (const entry of MOTION_PRESETS) {
      expect(entry.description.trim()).not.toBe("");
      expect(entry.description).not.toContain("\n");
      expect(entry.frames).toBeLessThanOrEqual(EXPRESSION_LIMITS.frames);
      expect(entry.delayMs).toBeGreaterThanOrEqual(20);
      expect(entry.playMs).toBeLessThanOrEqual(EXPRESSION_LIMITS.durationMs);
    }
    expect(Math.max(...MAKE_SIZES)).toBeLessThanOrEqual(EXPRESSION_LIMITS.largePixels);
  });
  it("상수가 계약 숫자와 같아요", () => {
    expect([...MAKE_SIZES]).toEqual([240, 360, 480]);
    expect(MAKE_DEFAULT_SIZE).toBe(360);
    expect(MAKE_PLAYS).toBe(4);
    expect(MAKE_PRESET_MAX).toBe(4);
    expect(MAKE_NOTE_MAX).toBe(500);
    expect(MAKE_SOURCE_LIMITS).toEqual({ bytes: 5 * 1024 * 1024, edge: 4096, pixels: 16_000_000 });
  });
});

describe("선택 검사", () => {
  it("움직임이 하나도 없으면 막아요", () => {
    expect(issuesOf({ presets: [] })).toEqual(["motion_missing"]);
    expect(issuesOf({ presets: [], still: false })).toEqual(["motion_missing"]);
  });
  it("프리셋 1개부터 4개까지 받고 표 순서로 접어요", () => {
    for (let count = 1; count <= 4; count++) {
      const chosen = [...ALL].reverse().slice(0, count);
      const check = checkMakeSelection({ presets: chosen });
      expect(check.ok && check.spec.motion).toEqual({ kind: "presets", presets: ALL.filter((id) => chosen.includes(id)) });
    }
  });
  it("5개는 막아요: 프리셋이 네 가지뿐이라 중복이나 모르는 값이 함께 걸려요", () => {
    expect(issuesOf({ presets: [...ALL, "bounce"] })).toEqual(["presets_duplicate", "presets_too_many"]);
    expect(issuesOf({ presets: ["a", "b", "c", "d", "e"] })).toEqual(["presets_unknown", "presets_too_many"]);
  });
  it("중복과 모르는 프리셋을 막아요", () => {
    expect(issuesOf({ presets: ["bounce", "bounce"] })).toEqual(["presets_duplicate"]);
    expect(issuesOf({ presets: ["spin"] })).toEqual(["presets_unknown"]);
  });
  it("「움직임 없이」는 혼자만 고를 수 있어요", () => {
    const alone = checkMakeSelection({ presets: [], still: true });
    expect(alone.ok && alone.spec.motion).toEqual({ kind: "still" });
    expect(issuesOf({ presets: ["bounce"], still: true })).toEqual(["still_mixed"]);
    expect(issuesOf({ presets: [...ALL], still: true })).toEqual(["still_mixed"]);
  });
  it("메모는 trim 뒤 500자까지예요", () => {
    expect(issuesOf({ presets: ["bounce"], note: "가".repeat(500) })).toEqual([]);
    expect(issuesOf({ presets: ["bounce"], note: "가".repeat(501) })).toEqual(["note_too_long"]);
    expect(issuesOf({ presets: ["bounce"], note: `  ${"가".repeat(500)}  ` })).toEqual([]);
    expect(issuesOf({ presets: ["bounce"], note: ` ${"가".repeat(501)} ` })).toEqual(["note_too_long"]);
  });
  it("공백만 있는 메모는 빈 메모예요", () => {
    const check = checkMakeSelection({ presets: ["bounce"], note: " \n\t  " });
    expect(check.ok && check.spec.note).toBe("");
    expect(makeNoteLength(" \n\t  ")).toBe(0);
  });
  it("글자 수는 코드 포인트로 세요", () => {
    expect(makeNoteLength("😀".repeat(500))).toBe(500);
    expect(issuesOf({ presets: ["bounce"], note: "😀".repeat(500) })).toEqual([]);
    expect(issuesOf({ presets: ["bounce"], note: "😀".repeat(501) })).toEqual(["note_too_long"]);
  });
  it("크기는 240, 360, 480만이고 기본은 360이에요", () => {
    const base = checkMakeSelection({ presets: ["bounce"] });
    expect(base.ok && base.spec.size).toBe(360);
    for (const size of MAKE_SIZES) expect(issuesOf({ presets: ["bounce"], size })).toEqual([]);
    for (const size of [0, 100, 361, 512, 360.5, Number.NaN]) expect(issuesOf({ presets: ["bounce"], size })).toEqual(["size_invalid"]);
  });
  it("여러 문제를 한꺼번에 알려요", () => {
    expect(issuesOf({ presets: [], note: "가".repeat(501), size: 1 })).toEqual(["motion_missing", "note_too_long", "size_invalid"]);
  });
});

describe("요청 본문", () => {
  it("첫 문장과 줄 목록으로 써요", () => {
    expect(buildMakeRequest({ presets: ["sparkle", "bounce"], note: "웃는 얼굴로" })).toBe(
      ["이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.", "- 움직임: 통통(bounce), 반짝(sparkle)", "- 크기: 360", "- 요청: 웃는 얼굴로"].join("\n")
    );
    expect(buildMakeRequest({ presets: [...ALL] })).toBe(
      ["이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.", "- 움직임: 통통(bounce), 흔들흔들(wobble), 두근두근(pulse), 반짝(sparkle)", "- 크기: 360"].join("\n")
    );
  });
  it("같은 입력은 같은 문자열이고 프리셋 순서는 입력 순서와 무관해요", () => {
    const bodies = new Set(permutations(ALL).map((order) => buildMakeRequest({ presets: order, note: "메모" })));
    expect(bodies.size).toBe(1);
    expect(buildMakeRequest({ presets: ["pulse"], note: "a" })).toBe(buildMakeRequest({ presets: ["pulse"], note: "a" }));
  });
  it("「움직임 없이」는 새 이모티콘 문장과 없음(정지) 줄이에요", () => {
    expect(buildMakeRequest({ presets: [], still: true, note: "웃는 얼굴로" })).toBe(
      ["이 사진으로 새 팀 이모티콘을 만들어 주세요.", "- 움직임: 없음(정지)", "- 크기: 360", "- 요청: 웃는 얼굴로"].join("\n")
    );
    expect(buildMakeRequest({ presets: [], still: true })).toBe(
      ["이 사진으로 새 팀 이모티콘을 만들어 주세요.", "- 움직임: 없음(정지)", "- 크기: 360"].join("\n")
    );
  });
  it("메모가 비면 요청 줄을 빼요", () => {
    for (const note of [undefined, "", "   ", "\n \t"]) {
      const lines = buildMakeRequest({ presets: ["bounce"], note }).split("\n");
      expect(lines).toEqual(["이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.", "- 움직임: 통통(bounce)", "- 크기: 360"]);
    }
  });
  it("메모는 trim 하고 한 줄로 접어서 줄 목록을 흉내 낼 수 없어요", () => {
    expect(buildMakeRequest({ presets: ["bounce"], note: "  웃는\n 얼굴로  " }).split("\n").at(-1)).toBe("- 요청: 웃는 얼굴로");
    const forged = buildMakeRequest({ presets: ["bounce"], note: "첫줄\n- 크기: 480\n- 움직임: 반짝(sparkle)" });
    const lines = forged.split("\n");
    expect(lines.filter((line) => line.startsWith("- 크기")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("- 움직임")).length).toBe(1);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("- 크기: 360");
  });
  it("크기를 본문에 적어요", () => {
    expect(buildMakeRequest({ presets: ["bounce"], size: 480 }).split("\n")[2]).toBe("- 크기: 480");
  });
  it("검사를 통과하지 못한 선택은 본문을 만들지 않아요", () => {
    expect(() => buildMakeRequest({ presets: [] })).toThrow(MakeSelectionError);
    let thrown: unknown = null;
    try {
      buildMakeRequest({ presets: ["bounce"], still: true, note: "x".repeat(501) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MakeSelectionError);
    expect((thrown as MakeSelectionError).issues).toEqual(["still_mixed", "note_too_long"]);
    // 오류 문장에 사람이 쓴 메모가 실리지 않아요.
    expect((thrown as MakeSelectionError).message).not.toContain("xxx");
  });
});

describe("칩 누르기", () => {
  it("더하면 표 순서로 서고 다시 누르면 빠져요", () => {
    let result = toggleMotionChoice(EMPTY_PICK, "sparkle");
    expect(result.ok && result.pick).toEqual({ presets: ["sparkle"], still: false });
    result = toggleMotionChoice(result.ok ? result.pick : EMPTY_PICK, "bounce");
    expect(result.ok && result.pick.presets).toEqual(["bounce", "sparkle"]);
    result = toggleMotionChoice(result.ok ? result.pick : EMPTY_PICK, "sparkle");
    expect(result.ok && result.pick.presets).toEqual(["bounce"]);
  });
  it("네 개가 고른 상태에서 다섯 번째를 막고 이유를 돌려줘요", () => {
    const full: MotionPick = { presets: ALL, still: false };
    expect(toggleMotionChoice(full, "extra" as MotionPresetId)).toEqual({ ok: false, issue: "presets_too_many" });
    expect(toggleMotionChoice(full, STILL_MOTION.id)).toEqual({ ok: false, issue: "still_mixed" });
  });
  it("가득 차도 해제는 돼요", () => {
    const result = toggleMotionChoice({ presets: ALL, still: false }, "pulse");
    expect(result.ok && result.pick.presets).toEqual(["bounce", "wobble", "sparkle"]);
  });
  it("「움직임 없이」와 프리셋은 서로를 막아요", () => {
    expect(toggleMotionChoice({ presets: ["bounce"], still: false }, STILL_MOTION.id)).toEqual({ ok: false, issue: "still_mixed" });
    expect(toggleMotionChoice({ presets: [], still: true }, "bounce")).toEqual({ ok: false, issue: "still_mixed" });
    const on = toggleMotionChoice(EMPTY_PICK, STILL_MOTION.id);
    expect(on.ok && on.pick).toEqual({ presets: [], still: true });
    const off = toggleMotionChoice({ presets: [], still: true }, STILL_MOTION.id);
    expect(off.ok && off.pick).toEqual(EMPTY_PICK);
  });
});

describe("원본 사진 한도", () => {
  it("가로세로는 4096 이하이고 합쳐서 1,600만 화소 이하예요", () => {
    expect(fitsStillInput(1, 1)).toBe(true);
    expect(fitsStillInput(4096, 3906)).toBe(true);
    expect(fitsStillInput(4000, 4000)).toBe(true);
    expect(fitsStillInput(4000, 4001)).toBe(false);
    expect(fitsStillInput(4096, 4096)).toBe(false);
    expect(fitsStillInput(4097, 1)).toBe(false);
    expect(fitsStillInput(1, 4097)).toBe(false);
    for (const [width, height] of [[0, 10], [10, 0], [-1, 5], [10.5, 10], [Number.NaN, 10]]) expect(fitsStillInput(width, height)).toBe(false);
  });
});

describe("화면 문구", () => {
  it("만들기와 가져오기라고 말하고 손으로 그린다는 말을 쓰지 않아요", () => {
    const corpus: string[] = [
      ...MOTION_PRESETS.flatMap((entry) => [entry.label, entry.description]),
      STILL_MOTION.label,
      STILL_MOTION.description,
      STILL_MOTION.requestLine,
    ];
    const notes = [undefined, "웃는 얼굴로"];
    for (let mask = 1; mask < 16; mask++) {
      const presets = ALL.filter((_, index) => (mask >> index) & 1);
      for (const note of notes) corpus.push(buildMakeRequest({ presets, note }));
    }
    for (const note of notes) corpus.push(buildMakeRequest({ presets: [], still: true, note }));
    expect(corpus.length).toBeGreaterThan(30);
    expect(corpus.filter(hasBanned)).toEqual([]);
    // 판별기가 실제로 걸러 내는지: 금지어를 넣은 문장은 걸려야 해요.
    expect(hasBanned(["그림을 ", "그", "려 주세요"].join(""))).toBe(true);
    expect(hasBanned("그림을 만들어 주세요")).toBe(false);
  });
});
