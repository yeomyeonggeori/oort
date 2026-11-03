import { describe, expect, it } from "vitest";
import { catalog as enCatalog } from "../../i18n/generated/en-US";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { messageKeys, type MessageKey } from "../../i18n/generated/messages";
import { SAFE_MESSAGE, createMessageService } from "../../i18n/service";
import { TYPE } from "../../i18n/tooling/pseudo.mjs";
import type { MessageCatalog } from "../../i18n/types";
import {
  MAX_RELEASE_NOTE_ITEMS,
  RELEASE_NOTE_SURFACES,
  compareReleaseVersions,
  findReleaseNote,
  itemsForSurface,
  listReleaseNotes,
  noteForDesktopVersion,
  noteForPhoneBuild,
  shouldAnnounceNote,
  type ReleaseNote,
  type ReleaseNoteKey,
} from "./model";
import { RELEASE_NOTES } from "./notes";
import { RELEASE_NOTE_0_1_41 } from "./notes/v0_1_41";

/**
 * 규칙 시험용 소식. 글은 사전에 있는 아무 키나 쓴다: 번호·순서·화면 규칙을 재는 시험이라 글은 주제가 아니다.
 * 실제 등록부와 섞이지 않게 모양만 갖춘 가짜다.
 */
const ANY: ReleaseNoteKey = "releaseNotes.page.title";
function fake(version: string, phoneBuild: number, desktopFrom: string[]): ReleaseNote {
  return {
    version,
    releasedOn: "2026-01-01",
    phoneBuild,
    desktopFrom,
    summary: ANY,
    items: [{ id: "only", surfaces: ["phone"], title: ANY, changed: ANY, tryIt: ANY }],
    others: [],
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
  });
});

// ---- 소식의 글은 사전에 산다 (#5054) --------------------------------------------------------------
//
// 소식 파일은 번호·빌드·**키 목록**만 들고, 글은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`에 있다. 그래서
// 언어를 더하는 길(ADR-0213 P2)과 빈칸 검사(`i18n:check`), 영어 대체가 소식에도 그대로 선다. 아래 규칙은
// 「키를 잘못 적은 소식」이 조용히 틀린 글을 보이는 길을 막는다: 키 오타는 컴파일이 막고, 그 밖의 어긋남은 여기서 잡는다.

/**
 * 이 구역의 고정값은 v0.1.41 **파일**에 못 박는다. 등록부의 맨 앞(`RELEASE_NOTES[0]`)은 승격 때 새 소식이 더해지면 바뀌므로,
 * 그것을 「v0.1.41」로 읽는 시험은 새 소식을 더하는 날 깨진다. 등록부 전체를 도는 시험(아래 「등록부」)만 등록부를 읽는다.
 */
const PINNED = RELEASE_NOTE_0_1_41;

const ko = createMessageService({ messageLocale: "ko-KR", catalog: koCatalog });
const en = createMessageService({ messageLocale: "en-US", catalog: enCatalog });
const KEY_SET: ReadonlySet<string> = new Set(messageKeys);

/** 공용 주제 이름(「대화」「첨부」…). 소식 칸 밖에 있어도 되는 키는 이것뿐이다. */
const SHARED_TOPIC_PREFIX = "releaseNotes.topic.";
const SHARED_TOPICS = messageKeys.filter((key) => key.startsWith(SHARED_TOPIC_PREFIX));
const ID_SHAPE = /^[a-z][a-zA-Z0-9]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_SHAPES = /https?:\/\/|www\.|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|@[A-Za-z0-9_]{2,}/;
// 코어 문자열의 대시는 `design_preflight_core`가 재지만 글이 사전(JSON)으로 옮겨 가서 그 검사가 못 본다: 여기서 잰다.
const DASH = /—|–/;
/** 「그 밖에 바뀐 점」의 한 줄은 한 줄이다: 줄바꿈이 없고 이 길이 안이다. */
const MAX_OTHER_LINE_LENGTH = 120;

/** `0.1.41` → `releaseNotes.v0141.`: 사전 키는 점·밑줄을 못 쓴다(`feature.surface.intent`). 릴리스 버전 `x.y.z`만. */
function keyPrefix(version: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(version) ? `releaseNotes.v${version.replaceAll(".", "")}.` : null;
}

type KeyRole = "summary" | "title" | "changed" | "tryIt" | "topic" | "line";
interface UsedKey {
  key: string;
  role: KeyRole;
  /** 어느 자리의 키인가(실패 메시지용). */
  where: string;
  /** 이 자리에서 기대하는 이름(소식 칸 안). `null`이면 접두만 본다. */
  expected: string | null;
}

/** 소식이 쓰는 모든 사전 키와, 그 키가 있어야 할 자리의 이름. */
function usedKeys(note: ReleaseNote): UsedKey[] {
  const prefix = keyPrefix(note.version) ?? "?.";
  const used: UsedKey[] = [{ key: note.summary, role: "summary", where: "summary", expected: `${prefix}summary` }];
  for (const item of note.items) {
    used.push(
      { key: item.title, role: "title", where: `${item.id}.title`, expected: `${prefix}${item.id}Title` },
      { key: item.changed, role: "changed", where: `${item.id}.changed`, expected: `${prefix}${item.id}Changed` },
      { key: item.tryIt, role: "tryIt", where: `${item.id}.tryIt`, expected: `${prefix}${item.id}TryIt` },
    );
  }
  for (const group of note.others) {
    used.push({ key: group.title, role: "topic", where: `${group.id}.topic`, expected: `${prefix}${group.id}Topic` });
    group.lines.forEach((line, index) => {
      used.push({ key: line, role: "line", where: `${group.id}.line${index + 1}`, expected: `${prefix}${group.id}Line` });
    });
  }
  return used;
}

/**
 * 한 소식의 키·글 규칙을 어긴 곳의 목록(비어 있으면 통과). 등록부 시험이 실제 소식에 걸고, 아래 시험이 가짜로 어긋난 소식에도
 * 걸어 이 규칙이 실제로 실패하는 것을 보인다.
 */
function noteViolations(note: ReleaseNote): string[] {
  const out: string[] = [];
  const prefix = keyPrefix(note.version);
  if (prefix === null) out.push(`버전 ${note.version}은 x.y.z가 아니라서 사전 키 칸(releaseNotes.v<숫자>.)을 만들 수 없다`);
  const ids = note.items.map((item) => item.id);
  const groupIds = note.others.map((group) => group.id);
  for (const id of [...ids, ...groupIds]) if (!ID_SHAPE.test(id)) out.push(`${id}: 이름은 영문 낱말로 시작하는 영숫자다`);
  if (new Set(ids).size !== ids.length) out.push("항목 이름이 겹친다");
  if (new Set(groupIds).size !== groupIds.length) out.push("주제 묶음 이름이 겹친다");
  for (const group of note.others) if (group.lines.length === 0) out.push(`${group.id}: 줄이 없는 주제 묶음`);

  const seen = new Set<string>();
  for (const { key, role, where, expected } of usedKeys(note)) {
    const at = `${where} (${key})`;
    if (seen.has(key)) out.push(`${at}: 한 소식 안에서 같은 키를 두 곳에 쓴다`);
    seen.add(key);
    if (!KEY_SET.has(key)) {
      out.push(`${at}: 사전에 없는 키`);
      continue;
    }
    const shared = role === "topic" && SHARED_TOPICS.includes(key as MessageKey);
    if (!shared) {
      const fits = role === "line" ? expected !== null && key.startsWith(expected) : key === expected;
      if (!fits) out.push(`${at}: 이 자리의 키는 ${expected}${role === "line" ? "…" : ""}여야 한다`);
    }
    const korean = ko.formatMessage(key as ReleaseNoteKey);
    const english = en.formatMessage(key as ReleaseNoteKey);
    if (korean === english) out.push(`${at}: 한국어와 영어 글이 같다(번역 누락)`);
    for (const [language, text] of [["ko", korean], ["en", english]] as const) {
      const here = `${at} [${language}]`;
      if (text === SAFE_MESSAGE) out.push(`${here}: 글을 읽지 못한다`);
      if (text.length === 0 || text.trim() !== text) out.push(`${here}: 빈 글이거나 앞뒤 공백`);
      if (SECRET_SHAPES.test(text)) out.push(`${here}: 주소·이메일·핸들 모양`);
      if (DASH.test(text)) out.push(`${here}: 대시(—, –)`);
      if (role === "line" && (/[\r\n]/.test(text) || text.length > MAX_OTHER_LINE_LENGTH)) {
        out.push(`${here}: 한 줄이 아니다(줄바꿈 없음, ${MAX_OTHER_LINE_LENGTH}자 이하)`);
      }
    }
  }
  return out;
}

describe("소식의 글은 사전 키다", () => {
  it("키는 컴파일이 막는다: 없는 키·값을 받는 키는 소식에 못 쓴다", () => {
    // @ts-expect-error 사전에 없는 키
    const missing: ReleaseNoteKey = "releaseNotes.v0141.nope";
    // @ts-expect-error 값(`{count}`)을 받는 키는 값 없이 읽는 소식 글이 못 쓴다
    const needsValue: ReleaseNoteKey = "releaseNotes.popup.more";
    expect([missing, needsValue]).toHaveLength(2);
  });

  it("v0.1.41의 키는 모두 사전에 있고 한국어·영어 둘 다 글이 있다", () => {
    const note = PINNED;
    const keys = usedKeys(note).map((used) => used.key);
    const others = note.others.reduce((count, group) => count + 1 + group.lines.length, 0);
    expect(keys).toHaveLength(1 + 3 * note.items.length + others);
    for (const key of keys) {
      expect(Object.hasOwn(koCatalog, key), `ko ${key}`).toBe(true);
      expect(Object.hasOwn(enCatalog, key), `en ${key}`).toBe(true);
      expect(koCatalog[key].length, `ko ${key}`).toBeGreaterThan(0);
      expect(enCatalog[key].length, `en ${key}`).toBeGreaterThan(0);
    }
  });

  it("다른 언어는 사전의 영어 대체를 그대로 탄다: 사전이 비면 영어, 일부만 번역되면 키마다 영어로 내려간다", () => {
    const note = PINNED;
    const none = createMessageService({ messageLocale: "ja-JP", catalog: {} });
    for (const { key } of usedKeys(note)) {
      expect(none.formatMessage(key as ReleaseNoteKey), key).toBe(en.formatMessage(key as ReleaseNoteKey));
    }
    // 요약만 번역된 일본어(P2의 중간 상태): 번역된 키는 일본어, 나머지는 영어 문장이다.
    const partial: MessageCatalog = { [note.summary]: [{ type: TYPE.literal, value: "要約だけ訳した" }] };
    const ja = createMessageService({ messageLocale: "ja-JP", catalog: partial });
    expect(ja.formatMessage(note.summary)).toBe("要約だけ訳した");
    const [first] = note.items;
    expect(ja.formatMessage(first.title)).toBe(en.formatMessage(first.title));
    expect(ja.formatMessage(first.title)).not.toBe(ko.formatMessage(first.title));
  });
});

describe("등록부: 통합자가 더하는 소식의 모양 규칙", () => {
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

  it("소식마다: 유효한 번호·날짜, 항목 1~8개, 화면 표지", () => {
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
      for (const item of note.items) {
        expect(item.surfaces.length, `${where}/${item.id}`).toBeGreaterThan(0);
        for (const surface of item.surfaces) expect(RELEASE_NOTE_SURFACES).toContain(surface);
      }
    }
  });

  it("소식마다 키·글 규칙을 지키고, 소식끼리 키를 나누지 않으며, 쓰이지 않는 소식 키가 없다", () => {
    for (const note of RELEASE_NOTES) expect(noteViolations(note), `v${note.version}`).toEqual([]);
    // 소식끼리 키를 나누지 않는다(공용 주제 이름은 나눠 쓴다): 옛 소식 파일을 베낀 새 소식이 옛 글을 보이는 길을 막는다.
    const own = RELEASE_NOTES.flatMap((note) => usedKeys(note).map((used) => used.key)).filter(
      (key) => !key.startsWith(SHARED_TOPIC_PREFIX),
    );
    expect(new Set(own).size).toBe(own.length);
    // 사전에 있는 버전별 키는 모두 어느 등록된 소식이 쓴다(키만 더하고 소식을 안 더한 승격을 막는다).
    const orphans = messageKeys.filter((key) => /^releaseNotes\.v\d+\./.test(key) && !own.includes(key));
    expect(orphans).toEqual([]);
  });

  it("규칙은 실제로 실패한다: 어긋난 소식은 어긋난 자리를 정확히 말한다", () => {
    const real = PINNED;
    const [first, second] = real.items;
    const longest = real.items.find((item) => item.id === "phoneConversation") ?? first;
    expect(noteViolations(real)).toEqual([]);
    // 다른 버전 칸의 키(옛 소식을 베끼고 키를 안 바꾼 경우)·같은 키를 두 곳에 쓴 경우.
    expect(noteViolations({ ...real, summary: ANY })).toEqual([expect.stringContaining("summary (releaseNotes.page.title)")]);
    expect(noteViolations({ ...real, version: "0.1.42" })).toEqual(expect.arrayContaining([expect.stringContaining("releaseNotes.v0142.")]));
    const swapped = { ...real, items: [{ ...first, changed: second.changed }, ...real.items.slice(1)] };
    expect(noteViolations(swapped)).toEqual(
      expect.arrayContaining([expect.stringContaining(`${first.id}.changed`)]),
    );
    // 버전이 x.y.z가 아니면 키 칸을 못 만든다.
    expect(noteViolations({ ...real, version: "0.1.42-next.1" })).toEqual(expect.arrayContaining([expect.stringContaining("x.y.z")]));
    // 「그 밖에 바뀐 점」: 줄 없는 묶음, 긴 글(한 줄 아님), 겹친 이름, 공용 주제 이름은 통과.
    expect(SHARED_TOPICS.length).toBeGreaterThan(0);
    const topic = SHARED_TOPICS[0] as ReleaseNoteKey;
    const withOthers = (groups: ReleaseNote["others"]): ReleaseNote => ({ ...real, others: groups });
    expect(noteViolations(withOthers([{ id: "empty", title: topic, lines: [] }]))).toEqual([
      expect.stringContaining("줄이 없는 주제 묶음"),
    ]);
    expect(noteViolations(withOthers([{ id: "a", title: topic, lines: [longest.changed] }]))).toEqual(
      expect.arrayContaining([expect.stringContaining("한 줄이 아니다")]),
    );
    expect(
      noteViolations(
        withOthers([
          { id: "a", title: topic, lines: [] },
          { id: "a", title: topic, lines: [] },
        ]),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("주제 묶음 이름이 겹친다")]));
    // 이름 규칙·소식 칸 밖의 키.
    expect(noteViolations({ ...real, items: [{ ...first, id: "bad-id" }] })).toEqual(
      expect.arrayContaining([expect.stringContaining("bad-id: 이름은")]),
    );
    expect(noteViolations(withOthers([{ id: "a", title: ANY, lines: [] }]))).toEqual(
      expect.arrayContaining([expect.stringContaining("a.topic (releaseNotes.page.title)")]),
    );
  });

  it("v0.1.41은 이 폰 빌드와 이 데스크탑 버전부터 붙는다", () => {
    expect(noteForPhoneBuild(RELEASE_NOTES, 3058)?.version).toBe("0.1.41");
    expect(noteForPhoneBuild(RELEASE_NOTES, 3057)).toBeNull();
    expect(noteForDesktopVersion(RELEASE_NOTES, "0.1.41")?.version).toBe("0.1.41");
    expect(noteForDesktopVersion(RELEASE_NOTES, "0.1.0-next.1")).toBeNull();
  });
});
