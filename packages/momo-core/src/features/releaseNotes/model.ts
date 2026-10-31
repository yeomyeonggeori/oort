// =============================================================================
// 앱 안 「업데이트 소식」 모델 (#4937, owner 10-31).
//
// 업데이트마다 사용자에게 보이는 변화를 쉬운 말로 적은 **버전별 파일**(`notes/v*.ts`, ko·en 한 파일)을 앱에
// 묶어 넣는다. 서버에서 받아 오지 않는다. 이 파일은 그 파일들의 **모양**과, 두 가지 규칙을 코어 한 곳에 둔다.
//
//   1. 어느 소식이 어느 앱 버전에 붙는가 (`noteForPhoneBuild` · `noteForDesktopVersion`)
//   2. 업데이트 뒤 처음 열 때 보여 줄 것인가 (`shouldAnnounceNote`)
//
// ## 소식 하나는 서로 다른 두 번호에 붙는다
//
// 소식은 릴리스 버전(`0.1.41`, 서버·GitHub Release와 같은 번호)으로 이름 짓는다. 그런데 설치된 앱이 말하는 번호는
// 다르다. 데스크탑은 앱 버전(`0.1.41`, 다음 채널 빌드는 `0.1.0-next.N`)이고, 폰은 마케팅 버전이 `1.0`에서 움직이지
// 않아서 **빌드 번호**(`CFBundleVersion`, 예: 3058)만 앞으로 간다. 그래서 소식마다 두 앱의 「처음 이 릴리스를 담은
// 번호」를 적는다(`phoneBuild` · `desktopFrom`). 앱은 자기보다 새롭지 않은 소식 중 **가장 새 것**을 자기 소식으로
// 삼는다: 자기 번호의 소식이 아직 없는 새 빌드는 직전 소식을 한 번 보고, 그 뒤로는 더 새 소식이 생길 때까지 조용하다.
//
// 데스크탑은 번호 체계가 둘이다(`docs/RELEASING.md` 「데스크탑 next 채널과의 경계」): 증거·공개 빌드의 `0.1.41`과
// 다음 채널의 `0.1.0-next.N`. 둘은 semver로는 비교할 수 있지만 같은 줄 위의 숫자가 아니다(`0.1.0-next.12`가
// `0.1.41`보다 낮다). 그래서 **같은 채널끼리만** 견준다: 채널은 사전 릴리스 표지의 첫 토막(`next`)이고 없으면
// `release`다. 소식의 `desktopFrom`은 채널마다 하나씩 「처음 담은 버전」을 적는다. 다음 채널 빌드가 그 소식을 담게
// 되면 `0.1.0-next.N`을 더하는 것이 통합자의 일이다. 적지 않은 채널의 앱은 자동으로 아무것도 보지 않는다(닫힌 쪽으로 실패).
//
// ## 「본 적 있는지」는 소식의 버전으로 비교한다
//
// 기기에는 마지막으로 닫은 **소식의 버전**을 적는다(앱 버전이 아니다: 두 번호가 다르다). 지금 소식이 그것보다 새로울
// 때만 한 번 보인다. 적힌 값이 없거나 읽을 수 없으면 본 적 없음이다. 업데이트가 아니라 새로 깐 앱도 한 번 보게 되는
// 값싼 쪽을 택했다: 「처음 깐 앱은 조용히 현재로 표시한다」를 택하면 이 기능이 처음 들어가는 빌드를 받은 모두가
// 첫 소식을 놓친다(저장된 값이 아직 없는 것이 그들의 공통 상태다).
// =============================================================================

export type ReleaseNoteLocale = "ko-KR" | "en-US";

/** 소식이 말하는 화면. 웹 브라우저 탭은 데스크탑과 같은 화면이라 따로 두지 않는다. */
export type ReleaseNoteSurface = "phone" | "desktop";

export const RELEASE_NOTE_SURFACES: readonly ReleaseNoteSurface[] = ["phone", "desktop"];

/**
 * 화면이 이 이름들을 문자열로 다시 적지 않게 코어가 건넨다: 웹·폰의 직접 문구 장부(`direct-copy.mjs`)는 클라 소스의
 * 낱말 하나짜리 문자열을 문구로 세는데, 이것들은 문구가 아니라 이름이다.
 */
export const PHONE_SURFACE = "phone" as const satisfies ReleaseNoteSurface;
export const DESKTOP_SURFACE = "desktop" as const satisfies ReleaseNoteSurface;

/** 설정 안에서 소식을 읽는 곳의 이름: 웹 설정의 `?section=` 값이고, 폰 설정의 안쪽 장 이름이다. */
export const RELEASE_NOTES_SETTINGS_PAGE = "releaseNotes" as const;

export interface ReleaseNoteItemCopy {
  /** 한 줄 제목. 자동으로 뜨는 작은 창에는 이것만 나온다. */
  title: string;
  /** 바뀐 점. 사용자에게 보이는 것만, 쉬운 말로. */
  changed: string;
  /** 「이렇게 써 보세요」: 어디를 열고 무엇을 눌러 볼지. */
  tryIt: string;
}

export interface ReleaseNoteItem {
  /** 소식 안에서 유일한 이름. 화면의 key·testID가 쓴다. */
  id: string;
  /** 이 변화가 보이는 화면. 비어 있지 않다. */
  surfaces: readonly ReleaseNoteSurface[];
  copy: Readonly<Record<ReleaseNoteLocale, ReleaseNoteItemCopy>>;
}

export interface ReleaseNote {
  /** 릴리스 버전(`0.1.41`). 소식의 이름이고, 기기에는 이 값을 「마지막으로 본 소식」으로 적는다. */
  version: string;
  /** 공개일 `YYYY-MM-DD`. 화면은 이 글자를 그대로 보인다(시간대로 하루가 밀리지 않게). */
  releasedOn: string;
  /** 이 릴리스를 처음 담은 폰 빌드 번호(`CFBundleVersion`). 그 번호 이상의 폰이 이 소식을 자기 것으로 삼는다. */
  phoneBuild: number;
  /** 이 릴리스를 처음 담은 데스크탑 앱 버전, 채널(`release` · `next`)마다 하나. 같은 채널에서 그 버전 이상이면 이 소식이다. */
  desktopFrom: readonly string[];
  /** 한 문장 요약. 자동으로 뜨는 작은 창과 버전 목록이 보인다. */
  summary: Readonly<Record<ReleaseNoteLocale, string>>;
  /** 핵심 변화, 1~8개. 앞에 있는 것이 더 중요하다. */
  items: readonly ReleaseNoteItem[];
}

/** 한 소식에 담을 수 있는 핵심 항목 수의 위쪽 끝(이슈 #4937 「5~8개 핵심」). */
export const MAX_RELEASE_NOTE_ITEMS = 8;

/** 앱의 문구 언어가 소식의 어느 쪽 글을 쓰는가. 사전이 없는 언어는 영어 문장으로 간다(ADR-0213). */
export function pickReleaseNoteLocale(messageLocale: string | null | undefined): ReleaseNoteLocale {
  return typeof messageLocale === "string" && messageLocale.toLowerCase().startsWith("ko") ? "ko-KR" : "en-US";
}

// ---- 버전 비교 ----------------------------------------------------------------------------------

interface ParsedVersion {
  core: readonly [number, number, number];
  /** 사전 릴리스 표지를 점으로 나눈 것. 없으면 정식 릴리스다. */
  pre: readonly string[] | null;
}

const VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.pre === null && b.pre === null) return 0;
  // 같은 번호에서는 사전 릴리스가 정식보다 낮다(`0.1.0-next.9` < `0.1.0`).
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** semver 순서. 둘 중 하나라도 버전이 아니면 `null`이다(0도 음수도 아니다: 모르는 채로 견주지 않는다). */
export function compareReleaseVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left && right ? compareParsed(left, right) : null;
}

/** 사전 릴리스 표지의 첫 토막이 채널이다(`0.1.0-next.12` → `next`). 표지가 없으면 `release`. */
function channelOf(version: ParsedVersion): string {
  return version.pre === null ? "release" : version.pre[0];
}

// ---- 어느 소식이 어느 앱 버전에 붙는가 --------------------------------------------------------------

function newest(candidates: readonly ReleaseNote[]): ReleaseNote | null {
  let best: ReleaseNote | null = null;
  for (const note of candidates) {
    if (best === null || (compareReleaseVersions(note.version, best.version) ?? 0) > 0) best = note;
  }
  return best;
}

/** 빌드 번호 글자(`"3058"`)나 숫자를 양의 정수로. 개발 빌드의 빈 값·`"1"` 같은 것은 어느 소식도 붙지 않게 그대로 둔다. */
function parsePhoneBuild(build: string | number | null | undefined): number | null {
  if (typeof build === "number") return Number.isInteger(build) && build > 0 ? build : null;
  if (typeof build !== "string") return null;
  const text = build.trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/**
 * 이 폰 빌드의 소식: 처음 담은 빌드 번호가 자기 번호 이하인 소식 중 가장 새 것. 빌드를 읽지 못하면 `null`.
 * 배열 순서에 기대지 않는다(통합자가 파일을 아무 자리에나 더해도 맞는다).
 */
export function noteForPhoneBuild(
  notes: readonly ReleaseNote[],
  build: string | number | null | undefined,
): ReleaseNote | null {
  const number = parsePhoneBuild(build);
  if (number === null) return null;
  return newest(notes.filter((note) => note.phoneBuild <= number));
}

/**
 * 이 데스크탑 앱 버전의 소식: **같은 채널**에서 처음 담은 버전이 자기 버전 이하인 소식 중 가장 새 것. 버전을 읽지
 * 못하거나(브라우저 탭은 앱 버전이 없다) 그 채널을 담은 소식이 없으면 `null`.
 */
export function noteForDesktopVersion(
  notes: readonly ReleaseNote[],
  appVersion: string | null | undefined,
): ReleaseNote | null {
  const app = typeof appVersion === "string" ? parseVersion(appVersion) : null;
  if (app === null) return null;
  const channel = channelOf(app);
  return newest(
    notes.filter((note) =>
      note.desktopFrom.some((from) => {
        const first = parseVersion(from);
        return first !== null && channelOf(first) === channel && compareParsed(app, first) >= 0;
      }),
    ),
  );
}

// ---- 한 번만 보이기 -----------------------------------------------------------------------------

/**
 * 업데이트 뒤 처음 열 때 이 소식을 보일 것인가. 소식이 없으면 아니다. 마지막으로 본 소식이 없거나 읽을 수 없는 값이면
 * 본 적 없음이다. 지금 소식이 마지막으로 본 것보다 **새로울 때만** 참이다: 같은 소식은 다시 뜨지 않고, 앱을 낮춘 뒤
 * (옛 빌드)에도 조용하다.
 */
export function shouldAnnounceNote(note: ReleaseNote | null, lastSeenVersion: string | null | undefined): boolean {
  if (note === null) return false;
  if (typeof lastSeenVersion !== "string") return true;
  const order = compareReleaseVersions(note.version, lastSeenVersion);
  return order === null || order > 0;
}

// ---- 목록과 고르기 ------------------------------------------------------------------------------

/** 새 소식이 맨 위. 입력 순서에 기대지 않고, 버전이 아닌 값은 맨 뒤로 보낸다(그릴 수는 있게). */
export function listReleaseNotes(notes: readonly ReleaseNote[]): readonly ReleaseNote[] {
  return [...notes].sort((a, b) => {
    const left = parseVersion(a.version);
    const right = parseVersion(b.version);
    if (left && right) return compareParsed(right, left);
    if (left) return -1;
    if (right) return 1;
    return 0;
  });
}

export function findReleaseNote(notes: readonly ReleaseNote[], version: string): ReleaseNote | null {
  return notes.find((note) => note.version === version) ?? null;
}

/** 한 화면에 해당하는 항목만. 자동으로 뜨는 작은 창이 이 기기에서 보이는 변화만 말하게 한다. */
export function itemsForSurface(note: ReleaseNote, surface: ReleaseNoteSurface): readonly ReleaseNoteItem[] {
  return note.items.filter((item) => item.surfaces.includes(surface));
}
