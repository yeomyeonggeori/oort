import { normalizeServerUrl } from "../../lib/serverUrl";

// =============================================================================
// 로그인 화면의 「이메일 기억하기」 (#4669). 서버 주소를 기억하는 자리 옆에서, 같은
// 서버에 다시 들어올 때 이메일 칸을 채워 주는 순수 모델이다. 폰(MMKV)·웹(localStorage)·
// 데스크탑(웹과 같은 코드)이 저장소 한 칸(`RememberedLoginPort`)만 다르게 건넨다.
//
// ## 무엇을 저장하나
//
// **이메일 하나가 서버 하나에 붙는다.** 서버 주소로 나눈다(`normalizeServerUrl`이 접어 준
// 주소가 키다): A 서버에서 기억한 이메일이 B 서버 칸에 채워지면 B 서버에 남의 아이디를
// 보내게 된다. 서버는 최근 다섯 곳까지만 남기고, 넘치면 오래된 쪽이 밀려난다.
//
// 비밀번호와 토큰은 **이 모듈을 지나가지 않는다.** 호출자가 이메일 칸의 글자만 건네고,
// 모듈은 그 글자가 이메일 모양일 때만 받는다(아래 `judgeRememberableEmail`).
//
// ## 켬·끔은 세 칸이다
//
// 저장된 선택은 「없음 / 켬 / 끔」이다. **없음**일 때만 플랫폼 기본(폰·데스크탑 켬,
// 웹 끔, 이슈 결정 10-27)을 따른다. 사람이 끈 것은 기록되어 재실행 뒤에도 꺼져 있다.
// 끄는 순간 저장된 이메일을 **전부, 그 자리에서** 지우고 「끔」을 적는다. 꺼진 동안은
// 저장도 불러오기도 하지 않는다(저장소에 값이 남아 있어도 읽지 않는다).
//
// ## 읽을 때마다 다시 검증한다
//
// 서버 주소를 읽을 때와 같은 원칙이다(`serverBase`): 저장소의 글은 이전 판이나 다른
// 탭이나 손으로 고친 값일 수 있어서, 모양이 틀린 칸은 버린다.
// =============================================================================

/** 서버를 이만큼만 기억한다(최근 순). 웹의 최근 서버 줄(`recentServers`)과 같은 수다. */
export const REMEMBERED_SERVERS_MAX = 5;

/** RFC 5321의 주소 전체 상한과 로컬 파트 상한. */
const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const LABEL_MAX = 63;
/** 서버 주소 키가 이보다 길면 이상한 값이다. */
const KEY_MAX = 2048;

export type RememberedEmailRejection = "empty" | "token-shaped" | "not-an-email";

export type RememberedEmailVerdict =
  | { ok: true; email: string }
  | { ok: false; reason: RememberedEmailRejection };

/**
 * 토큰·자격 증명 모양. 이메일 모양 검사 **앞에서** 먼저 본다: 이메일 칸에 토큰을 붙여 넣은
 * 사람에게 「이메일이 아니에요」와 「토큰이에요」는 다른 일이고, 무엇보다 `@`가 낀 토큰
 * (`eyJ….….…@x.y`처럼 앞부분만 토큰인 글)도 이메일 모양 검사만으로는 지나간다.
 *
 *  - 이 제품이 내는 봉투: `momo_dev_v1.…` `momo_agent_v1…` `momo_oauth_at_v1…`(`momo_<이름>_v<N>`), `oort_runner…`.
 *    `momo_kim@example.com`처럼 사람이 짓는 주소는 `_v<숫자>`가 없어서 지나간다.
 *  - JWT(`eyJ`로 시작하는 마디 둘 이상), `Bearer …`, 널리 알려진 서비스 토큰 머리(`sk-`·`ghp_`·`xox?-`·`AKIA…`)
 *  - **긴 불투명 덩어리**: 영숫자·`_`·`-`가 40자 넘게 이어지는 곳이 있으면 사람이 짓는 주소가 아니라
 *    만들어진 값이다.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /^bearer\s/i,
  /\bmomo_[a-z0-9_]*_v\d+/i,
  /\boort_runner/i,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{4,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /[A-Za-z0-9_-]{40,}/,
];

function tokenShaped(value: string): boolean {
  return TOKEN_SHAPES.some((shape) => shape.test(value));
}

/** 공백·제어 문자 없음, `@` 하나, 로컬 파트 상한, 도메인은 점으로 갈린 비지 않은 마디 둘 이상. */
function emailShaped(value: string): boolean {
  if (value.length > EMAIL_MAX) return false;
  if (/\s/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (at > LOCAL_MAX) return false;
  const labels = value.slice(at + 1).split(".");
  // 점이 없는 도메인(`P@ssw0rd`, `admin@localhost`)은 받지 않는다. 비밀번호가 가장 자주 닮는 모양이
  // 「글자@글자」라서, 점 없는 주소를 못 기억하는 비용이 비밀번호를 적는 비용보다 훨씬 싸다.
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= LABEL_MAX &&
      !label.startsWith("-") &&
      !label.endsWith("-")
  );
}

/**
 * 이 글자를 이메일로 기억해도 되는가. 허용목록이 주 규칙이다(이메일 모양일 때만 지나간다).
 * 토큰 모양은 그 앞에서 한 번 더 막는 보조 방어이고, 모양을 알아볼 뿐이라 일부러 쪼갠
 * 값까지 막지는 못한다. 통과하면 앞뒤 공백을 뗀 글자를 돌려준다.
 */
export function judgeRememberableEmail(raw: string): RememberedEmailVerdict {
  const email = raw.trim();
  if (email === "") return { ok: false, reason: "empty" };
  if (tokenShaped(email)) return { ok: false, reason: "token-shaped" };
  if (!emailShaped(email)) return { ok: false, reason: "not-an-email" };
  return { ok: true, email };
}

// ---- 저장소 ------------------------------------------------------------------

/** 문자열 하나를 읽고 쓰는 동기 저장소 한 칸. 웹은 localStorage, 폰은 MMKV다. `null`을 쓰면 지운다. */
export interface RememberedLoginPort {
  read(): string | null;
  write(value: string | null): void;
}

export type RememberResult =
  | { stored: true }
  | { stored: false; reason: "off" | "no-server" | RememberedEmailRejection };

export interface RememberedLoginStore {
  /** 지금 기억하기가 켜져 있는가(사람의 선택, 없으면 플랫폼 기본). */
  isEnabled(): boolean;
  /** 끄면 저장된 이메일을 **전부 그 자리에서** 지우고 「끔」을 적는다. 켜면 「켬」만 적는다. */
  setEnabled(on: boolean): void;
  /** 이 서버에 기억한 이메일. 꺼져 있거나 없으면 null. */
  recall(serverBase: string): string | null;
  /** 로그인에 **성공한 뒤** 부른다. 꺼져 있거나 이메일 모양이 아니면 저장하지 않는다. */
  remember(serverBase: string, rawEmail: string): RememberResult;
}

interface Saved {
  /** 사람이 고른 값. `undefined`면 고른 적이 없다(플랫폼 기본). */
  enabled: boolean | undefined;
  /** 최근 순. 칸 하나는 [서버 키, 이메일]. */
  entries: [string, string][];
}

const SCHEMA_VERSION = 1;

function serverKey(serverBase: string): string | null {
  const checked = normalizeServerUrl(serverBase);
  return checked.ok ? checked.base : null;
}

function parse(raw: string | null): Saved {
  const empty: Saved = { enabled: undefined, entries: [] };
  if (!raw) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  if (record.v !== SCHEMA_VERSION) return empty;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.entries)) {
    for (const item of record.entries) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, email] = item as unknown[];
      if (typeof key !== "string" || typeof email !== "string") continue;
      if (key.length > KEY_MAX || seen.has(key)) continue;
      // 키는 서버 주소로 접힌 값이어야 한다(다른 모양이면 어떤 서버에도 맞지 않는다).
      if (serverKey(key) !== key) continue;
      const verdict = judgeRememberableEmail(email);
      if (!verdict.ok) continue;
      seen.add(key);
      entries.push([key, verdict.email]);
      if (entries.length >= REMEMBERED_SERVERS_MAX) break;
    }
  }
  return { enabled, entries };
}

function serialize(saved: Saved): string | null {
  if (saved.enabled === undefined && saved.entries.length === 0) return null;
  return JSON.stringify({
    v: SCHEMA_VERSION,
    ...(saved.enabled === undefined ? {} : { enabled: saved.enabled }),
    entries: saved.entries,
  });
}

export function createRememberedLoginStore(
  port: RememberedLoginPort,
  options: { defaultEnabled: boolean }
): RememberedLoginStore {
  const load = (): Saved => {
    try {
      return parse(port.read());
    } catch {
      return { enabled: undefined, entries: [] };
    }
  };
  const save = (saved: Saved): void => {
    try {
      port.write(serialize(saved));
    } catch {
      // 막힌 저장소(사생활 보호 모드·용량): 기억이 이번 실행에서 끝날 뿐이고 로그인은 그대로다.
    }
  };
  const enabledOf = (saved: Saved): boolean => saved.enabled ?? options.defaultEnabled;

  return {
    isEnabled: () => enabledOf(load()),
    setEnabled(on) {
      // 끔은 **지우기와 한 쌍**이다. 먼저 이메일을 비운 상태로 「끔」을 적는다.
      save({ enabled: on, entries: on ? load().entries : [] });
    },
    recall(serverBase) {
      const saved = load();
      if (!enabledOf(saved)) return null;
      const key = serverKey(serverBase);
      if (key === null) return null;
      return saved.entries.find(([entryKey]) => entryKey === key)?.[1] ?? null;
    },
    remember(serverBase, rawEmail) {
      const saved = load();
      if (!enabledOf(saved)) return { stored: false, reason: "off" };
      const key = serverKey(serverBase);
      if (key === null) return { stored: false, reason: "no-server" };
      const verdict = judgeRememberableEmail(rawEmail);
      if (!verdict.ok) return { stored: false, reason: verdict.reason };
      const latest: [string, string] = [key, verdict.email];
      const entries = [latest, ...saved.entries.filter(([entryKey]) => entryKey !== key)].slice(
        0,
        REMEMBERED_SERVERS_MAX
      );
      save({ enabled: saved.enabled, entries });
      return { stored: true };
    },
  };
}
