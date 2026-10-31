import { describe, expect, it } from "vitest";
import {
  MAX_RELEASE_NOTE_ITEMS,
  RELEASE_NOTE_SURFACES,
  compareReleaseVersions,
  findReleaseNote,
  itemsForSurface,
  listReleaseNotes,
  noteForDesktopVersion,
  noteForPhoneBuild,
  pickReleaseNoteLocale,
  shouldAnnounceNote,
  type ReleaseNote,
} from "./model";
import { RELEASE_NOTES } from "./notes";

/** 규칙 시험용 소식. 실제 등록부와 섞이지 않게 모양만 갖춘 가짜다. */
function fake(version: string, phoneBuild: number, desktopFrom: string[]): ReleaseNote {
  return {
    version,
    releasedOn: "2026-01-01",
    phoneBuild,
    desktopFrom,
    summary: { "ko-KR": "요약", "en-US": "Summary" },
    items: [
      {
        id: "only",
        surfaces: ["phone"],
        copy: {
          "ko-KR": { title: "제목", changed: "바뀐 점", tryIt: "써 보기" },
          "en-US": { title: "Title", changed: "Changed", tryIt: "Try it" },
        },
      },
    ],
  };
}

const OLD = fake("0.1.41", 3058, ["0.1.41"]);
const NEW = fake("0.1.42", 3070, ["0.1.42", "0.1.0-next.11"]);

describe("어느 소식이 어느 앱 버전에 붙는가", () => {
  it("폰: 처음 담은 빌드 번호 이상이면 가장 새 소식이고, 배열 순서에 기대지 않는다", () => {
    for (const notes of [[OLD, NEW], [NEW, OLD]]) {
      expect(noteForPhoneBuild(notes, 3057)).toBeNull();
      expect(noteForPhoneBuild(notes, 3058)?.version).toBe("0.1.41");
      expect(noteForPhoneBuild(notes, "3069")?.version).toBe("0.1.41");
      expect(noteForPhoneBuild(notes, 3070)?.version).toBe("0.1.42");
      // 자기 번호의 소식이 아직 없는 새 빌드는 직전 소식으로 간다.
      expect(noteForPhoneBuild(notes, 4000)?.version).toBe("0.1.42");
    }
    // 읽지 못한 빌드(개발 빌드의 빈 값·「1」)는 어느 소식도 붙지 않는다.
    for (const build of [null, undefined, "", " ", "abc", "3058.5", 0, -1, 3058.5, "1"]) {
      expect(noteForPhoneBuild([OLD, NEW], build), String(build)).toBeNull();
    }
  });

  it("데스크탑: 같은 채널에서만 견주고, 다음 채널은 소식이 적어 준 버전부터다", () => {
    const notes = [OLD, NEW];
    expect(noteForDesktopVersion(notes, "0.1.40")).toBeNull();
    expect(noteForDesktopVersion(notes, "0.1.41")?.version).toBe("0.1.41");
    expect(noteForDesktopVersion(notes, "0.1.41+7")?.version).toBe("0.1.41");
    expect(noteForDesktopVersion(notes, "0.1.42")?.version).toBe("0.1.42");
    expect(noteForDesktopVersion(notes, "0.2.0")?.version).toBe("0.1.42");
    // 다음 채널: `0.1.0-next.12`가 `0.1.41`보다 낮은 semver여도, 같은 채널의 적힌 버전(next.11) 이상이면 붙는다.
    expect(noteForDesktopVersion(notes, "0.1.0-next.10")).toBeNull();
    expect(noteForDesktopVersion(notes, "0.1.0-next.11")?.version).toBe("0.1.42");
    expect(noteForDesktopVersion(notes, "0.1.0-next.12")?.version).toBe("0.1.42");
    // 다음 채널을 적지 않은 소식만 있으면 그 채널의 앱은 자동으로 아무것도 보지 않는다(닫힌 쪽으로 실패).
    expect(noteForDesktopVersion([OLD], "0.1.0-next.12")).toBeNull();
    // 다른 이름의 사전 릴리스 채널은 서로 견주지 않는다.
    expect(noteForDesktopVersion(notes, "0.1.0-beta.99")).toBeNull();
    // 채널이 다르면 숫자가 더 커도 붙지 않는다: 정식 앱은 다음 채널에만 적힌 소식을 아직 담지 않았고(0.1.5 > 0.1.0-next.20),
    // 다음 채널 앱은 정식 번호에만 적힌 소식을 담지 않았다(1.0.0-next.1 > 0.1.41).
    const nextOnly = fake("0.1.43", 3080, ["0.1.0-next.20"]);
    expect(noteForDesktopVersion([nextOnly], "0.1.0")).toBeNull();
    expect(noteForDesktopVersion([nextOnly], "0.1.5")).toBeNull();
    expect(noteForDesktopVersion([nextOnly], "0.1.0-next.20")?.version).toBe("0.1.43");
    expect(noteForDesktopVersion([OLD], "1.0.0-next.1")).toBeNull();
    // 앱 버전이 없다(브라우저 탭)·읽을 수 없다.
    for (const version of [null, undefined, "", "next", "1.0", "v0.1.41"]) {
      expect(noteForDesktopVersion(notes, version), String(version)).toBeNull();
    }
  });
});

describe("한 번만 보이기", () => {
  it("본 적 없거나 읽을 수 없으면 보이고, 같은 소식·더 새 소식을 본 뒤에는 조용하다", () => {
    expect(shouldAnnounceNote(null, null)).toBe(false);
    expect(shouldAnnounceNote(null, "0.1.0")).toBe(false);
    expect(shouldAnnounceNote(OLD, null)).toBe(true);
    expect(shouldAnnounceNote(OLD, undefined)).toBe(true);
    expect(shouldAnnounceNote(OLD, "")).toBe(true);
    expect(shouldAnnounceNote(OLD, "garbage")).toBe(true);
    expect(shouldAnnounceNote(OLD, "0.1.40")).toBe(true);
    // 닫은 소식은 그 버전에서 다시 뜨지 않는다.
    expect(shouldAnnounceNote(OLD, "0.1.41")).toBe(false);
    // 새 소식에서는 다시 뜬다.
    expect(shouldAnnounceNote(NEW, "0.1.41")).toBe(true);
    // 앱을 낮춘 뒤(더 새 소식을 본 기기)에도 조용하다.
    expect(shouldAnnounceNote(OLD, "0.1.42")).toBe(false);
  });
});

describe("버전 비교와 목록", () => {
  it("semver 순서로 견주고 버전이 아니면 null이다", () => {
    const ordered = ["0.1.0-next.9", "0.1.0-next.10", "0.1.0-rc.1", "0.1.0", "0.1.41", "0.2.0", "1.0.0"];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareReleaseVersions(ordered[i - 1], ordered[i]), `${ordered[i - 1]} < ${ordered[i]}`).toBe(-1);
      expect(compareReleaseVersions(ordered[i], ordered[i - 1])).toBe(1);
    }
    expect(compareReleaseVersions("0.1.41", "0.1.41+build.5")).toBe(0);
    expect(compareReleaseVersions("0.1.41", "oops")).toBeNull();
    expect(compareReleaseVersions("", "0.1.41")).toBeNull();
  });

  it("목록은 새 소식이 맨 위이고 입력 순서에 기대지 않으며, 항목은 화면별로 거른다", () => {
    expect(listReleaseNotes([OLD, NEW]).map((note) => note.version)).toEqual(["0.1.42", "0.1.41"]);
    expect(listReleaseNotes([NEW, OLD]).map((note) => note.version)).toEqual(["0.1.42", "0.1.41"]);
    expect(listReleaseNotes([fake("not-a-version", 1, []), OLD]).map((note) => note.version)).toEqual([
      "0.1.41",
      "not-a-version",
    ]);
    expect(findReleaseNote([OLD, NEW], "0.1.42")).toBe(NEW);
    expect(findReleaseNote([OLD, NEW], "9.9.9")).toBeNull();
    expect(itemsForSurface(OLD, "phone")).toHaveLength(1);
    expect(itemsForSurface(OLD, "desktop")).toHaveLength(0);
    expect(pickReleaseNoteLocale("ko-KR")).toBe("ko-KR");
    expect(pickReleaseNoteLocale("en-US")).toBe("en-US");
    // 사전이 없는 언어는 영어 문장이다(ADR-0213).
    expect(pickReleaseNoteLocale("ja-JP")).toBe("en-US");
    expect(pickReleaseNoteLocale(undefined)).toBe("en-US");
  });
});

describe("등록부: 통합자가 더하는 소식의 모양 규칙", () => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const SECRET_SHAPES = /https?:\/\/|www\.|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|@[A-Za-z0-9_]{2,}/;

  it("비어 있지 않고 새 소식이 맨 위이며, 버전과 폰 빌드가 함께 앞으로 간다", () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
    expect(RELEASE_NOTES.at(-1)?.version).toBe("0.1.41");
    const versions = RELEASE_NOTES.map((note) => note.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < RELEASE_NOTES.length; i += 1) {
      expect(compareReleaseVersions(RELEASE_NOTES[i - 1].version, RELEASE_NOTES[i].version)).toBe(1);
      expect(RELEASE_NOTES[i - 1].phoneBuild).toBeGreaterThan(RELEASE_NOTES[i].phoneBuild);
    }
  });

  it("소식마다: 유효한 번호·날짜, 항목 1~8개, 빈 글 없음, 화면 표지, 비밀 모양 없음", () => {
    for (const note of RELEASE_NOTES) {
      const where = `v${note.version}`;
      expect(compareReleaseVersions(note.version, "0.0.0"), where).toBe(1);
      expect(note.releasedOn, where).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(`${note.releasedOn}T00:00:00Z`)), where).toBe(false);
      expect(Number.isInteger(note.phoneBuild) && note.phoneBuild > 0, where).toBe(true);
      expect(note.desktopFrom.length, where).toBeGreaterThan(0);
      for (const from of note.desktopFrom) {
        expect(compareReleaseVersions(from, "0.0.0"), `${where} desktopFrom ${from}`).toBe(1);
      }
      expect(note.items.length, where).toBeGreaterThanOrEqual(1);
      expect(note.items.length, where).toBeLessThanOrEqual(MAX_RELEASE_NOTE_ITEMS);
      const ids = note.items.map((item) => item.id);
      expect(new Set(ids).size, `${where} item ids`).toBe(ids.length);
      const texts: string[] = [];
      for (const locale of ["ko-KR", "en-US"] as const) {
        texts.push(note.summary[locale]);
        for (const item of note.items) {
          expect(item.surfaces.length, `${where}/${item.id}`).toBeGreaterThan(0);
          for (const surface of item.surfaces) expect(RELEASE_NOTE_SURFACES).toContain(surface);
          texts.push(item.copy[locale].title, item.copy[locale].changed, item.copy[locale].tryIt);
        }
      }
      for (const text of texts) {
        expect(text.trim(), where).toBe(text);
        expect(text.length, `${where}: 빈 글`).toBeGreaterThan(0);
        expect(text, `${where}: 주소·이메일·핸들 모양`).not.toMatch(SECRET_SHAPES);
      }
      // 영어 쪽은 한국어 글을 그대로 베낀 칸이 없어야 한다(번역 누락을 잡는다). 자칭 표기(한국어)는 문장 안에 쓸 수 있다.
      for (const item of note.items) {
        expect(item.copy["en-US"].changed, `${where}/${item.id}`).not.toBe(item.copy["ko-KR"].changed);
        expect(item.copy["en-US"].title, `${where}/${item.id}`).not.toBe(item.copy["ko-KR"].title);
      }
    }
  });

  it("v0.1.41은 이 폰 빌드와 이 데스크탑 버전부터 붙는다", () => {
    expect(noteForPhoneBuild(RELEASE_NOTES, 3058)?.version).toBe("0.1.41");
    expect(noteForPhoneBuild(RELEASE_NOTES, 3057)).toBeNull();
    expect(noteForDesktopVersion(RELEASE_NOTES, "0.1.41")?.version).toBe("0.1.41");
    expect(noteForDesktopVersion(RELEASE_NOTES, "0.1.0-next.1")).toBeNull();
  });
});
