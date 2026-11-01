import type { Message } from "../../lib/api";
import { attachParticle, attachRecipient } from "../../lib/koreanParticle";
import { aiHubSection } from "../ai/aiHubModel";
import {
  AGENT_SUGGESTABLE_COMMANDS,
  type AiConnectLine,
} from "../commands/registry";
import {
  memberFor,
  memberNameParts,
  type Directory,
  type MemberNameParts,
} from "../workspace/directory";

// =============================================================================
// 에이전트가 제안한 클라이언트 명령 카드 (ADR-0186 D6 · 부록 D · 증보 G3·G4,
// #2948 GC-7).
//
// 서버(#2959 `oort_card_suggest`·`card_suggest`)는 채널의 모든 멤버에게 **같은
// props**를 보낸다:
//
//   {"momo.command_suggest": {"v": 1, "command_id": "ai.connect",
//     "args": {"harness": "claude", "scope": "mine"},
//     "for_member_id": "<요청자>", "label": "Claude 구독 연결"}}
//
// 보는 사람별 분기는 클라이언트 렌더다(G4). 이 파일은 그 분기의 **판정**만 갖고
// 웹과 폰이 같이 쓴다.
//
// ## props는 의도만 — 상태는 읽지 않는다
//
// 이 파서는 연결 상태·결과·키 꼬리 같은 것을 읽는 코드가 **없다**. 카드는 보는
// 사람의 클라이언트가 자기 설정 스토어(AI과 같은 훅·같은 판정)에서
// 살아 있는 상태를 읽어 그린다(G3 불변식). 누가 props에 `state:"ready"`를 넣어
// 보내도 그것을 옮길 칸이 모델에 없다.
//
// `label`도 그리지 않는다. 서버가 파생한 값이지만(G3) 화면 문구는 클라이언트가
// `command_id`·`args`에서 다시 만든다 — 메시지에 실린 문자열이 카드 제목이 되는
// 길을 클라이언트 쪽에서도 닫는다(피싱 문구 차단). 모양 검사만 한다.
//
// ## 두 층의 폴백
//
// 1. **본문 폴백(null)** — 카드를 세울 근거가 없다. props가 없거나 객체가 아니다,
//    `v≠1`, `command_id`가 이 빌드의 레지스트리에서 `agentSuggestable`인 `client`
//    명령이 아니다, `for_member_id`가 문자열이 아니거나 멤버 목록에 없다, 작성자가
//    에이전트가 아니다(부록 D·G4 마지막 줄). 행은 평범한 메시지로 보인다.
// 2. **한 줄 폴백(degraded)** — 봉투는 맞는데 안쪽이 이 빌드가 아는 모양이 아니다:
//    모르는 최상위 키, 모르는 `args` 키, enum 밖 값, 짝이 어긋난 인자, `label`
//    모양 위반. 누가 보든 「{이름}에게 AI 계정 연결을 제안했어요」 한 줄만 보이고
//    입력·버튼은 0이다. 반쯤 아는 제안으로 조작 카드를 세우지 않는다.
// =============================================================================

/** 이 카드를 세우는 props 키. 서버 `COMMAND_SUGGEST_PROPS_KEY`와 같은 글자. */
export const COMMAND_SUGGEST_PROP_KEY = "momo.command_suggest";

/** 이 빌드가 읽는 판. */
export const COMMAND_SUGGEST_VERSION = 1;

/** 서버 `SUGGESTION_LABEL_MAX_CHARS`(G3 상한). */
export const COMMAND_SUGGEST_LABEL_MAX = 40;

/** props 봉투의 필드는 정확히 이 다섯이다(G3). */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "v",
  "command_id",
  "args",
  "for_member_id",
  "label",
]);

/**
 * `ai.connect` 카드에서 펼칠 부분.
 *
 * `AiConnectLine`(슬래시 인자) 셋에 `mine`(내 계정 절 전부)을 더한다: 서버는
 * `{scope:"mine"}`만 온 제안을 허용하고(harness 없이 scope만), 그 뜻은 「내 구독
 * 줄들」이다. null은 두 절 전부.
 */
export type AiConnectFocus = AiConnectLine | "mine" | null;

/**
 * `settings.open`의 section id (#3939 E-S6, ADR-0201 v2 H6-4) — 서버
 * `momo_agent::card_suggest::SETTINGS_OPEN_SECTIONS`와 같은 열두 값, 같은 순서.
 * 경로가 아니라 설정 섹션 id다. 라벨은 서버가 파생해 props에 싣지만 화면 문구는
 * 여기서 다시 만든다(에이전트·메시지 문자열이 카드 제목이 되는 길을 닫는다).
 * 서버 쪽은 Rust 시험이 이 파일 아닌 설정 목차를 읽어 맞추고, 이 표는
 * `docs/api/command-suggest-settings-open.golden.json` 시험이 서버와 맞춘다.
 */
export const SETTINGS_OPEN_SECTIONS = [
  "profile",
  "appearance",
  "notifications",
  "shortcuts",
  "devices",
  "workspace",
  "members",
  "memory",
  "usage",
  "code",
  "updates",
  "plugins",
] as const;

export type SettingsOpenSection = (typeof SETTINGS_OPEN_SECTIONS)[number];

/** 서버 `settings_open_label` 표와 같은 글자(골든 시험이 잰다). */
const SETTINGS_OPEN_LABELS: Readonly<Record<SettingsOpenSection, string>> = {
  profile: "프로필 설정 열기",
  appearance: "모양 설정 열기",
  notifications: "알림 설정 열기",
  shortcuts: "단축키 설정 열기",
  devices: "기기 설정 열기",
  workspace: "워크스페이스 설정 열기",
  members: "멤버와 초대 열기",
  memory: "기억 설정 열기",
  usage: "사용량 열기",
  code: "실행 호스트 설정 열기",
  updates: "업데이트 설정 열기",
  plugins: "앱 설정 열기",
};

export function settingsOpenLabel(section: SettingsOpenSection): string {
  return SETTINGS_OPEN_LABELS[section];
}

/**
 * 카드 줄에 쓰는 대상 이름 — 라벨에서 동사 「열기」를 뗀 것(「알림 설정」). 줄 옆 버튼이
 * 이미 「열기」라, 같은 말을 두 번 읽지 않게 한다.
 */
export function settingsOpenTarget(section: SettingsOpenSection): string {
  return SETTINGS_OPEN_LABELS[section].replace(/ 열기$/, "");
}

/**
 * `settings.open`의 `args`를 읽는다. 키는 `section` 하나뿐이고 필수이며 enum 안이어야
 * 한다(서버 `normalize_settings_open_args`와 같다). 아니면 undefined(→ 한 줄 폴백).
 */
export function settingsOpenSection(args: unknown): SettingsOpenSection | undefined {
  if (!isObj(args)) return undefined;
  for (const key of Object.keys(args)) {
    if (key !== "section") return undefined;
  }
  const section = args["section"];
  return oneOf(SETTINGS_OPEN_SECTIONS, section) ? section : undefined;
}

/**
 * `work.request.open`의 harness (#4972 S9, ADR-0201 증보 v3 B8 C1) — 서버
 * `momo_agent::card_suggest::WORK_REQUEST_HARNESSES`와 같은 둘. 「작업 요청」 시트가 늘 내놓는 도구이고
 * (OpenCode는 맥이 알릴 때만 서므로 카드가 이름 붙이지 않는다), `ai.connect`의 `harness`와 같은
 * 낱말이 같은 도구다. 팀 키를 뜻하는 `team_key`는 여기 없다.
 */
export const WORK_REQUEST_OPEN_HARNESSES = ["claude", "codex"] as const;

export type WorkRequestHarness = (typeof WORK_REQUEST_OPEN_HARNESSES)[number];

/**
 * 도우미 카드가 글을 채워 여는 폰 시트(「내 맥에 보내기」)의 모드 — **작업 요청**(`work`). 글이 시킬 일이라서
 * 물어보기(`ask`)로 열지 않는다. 폰 `AskMode`의 한 값과 같은 낱말이다.
 */
export const WORK_REQUEST_SHEET_MODE = "work" as const;

/** 서버 `WORK_REQUEST_PROMPT_MAX_BYTES` — 시트에 채우는 글의 상한(UTF-8 바이트). */
export const WORK_REQUEST_PROMPT_MAX_BYTES = 8_000;

/** 서버 `work_request_open_label` 표와 같은 글자(골든 시험이 잰다). harness로만 가른다. */
export function workRequestOpenLabel(harness: WorkRequestHarness | null): string {
  switch (harness) {
    case "claude":
      return "내 맥의 Claude Code에 맡기기";
    case "codex":
      return "내 맥의 Codex에 맡기기";
    default:
      return "내 맥에 작업 맡기기";
  }
}

/** 「작업 요청」 시트를 채우는 값. 카드가 아는 것은 이 둘이 전부다(폴더·채널·맥은 사람이 고른다). */
export interface WorkRequestOpen {
  /** 카드가 이름 붙인 도구. 없거나 이 빌드가 모르는 값이면 null — 시트가 평소 기본값을 쓴다. */
  harness: WorkRequestHarness | null;
  /** 시트에 미리 채우는 글. 서버가 정리한 값이다. 보내는 것은 사람이다. */
  prompt: string;
}

/**
 * 개인 에이전트의 하네스 낱말(`claude`·`claude_code`·`codex`, 로스터가 싣는 서명 낱말)을 카드가 쓰는 두
 * 도구로 접는다. 모르는 낱말은 null — 카드가 아는 도구가 아니다.
 */
export function workRequestHarnessOfWire(wire: string): WorkRequestHarness | null {
  if (wire === "claude" || wire === "claude_code") return "claude";
  if (wire === "codex") return "codex";
  return null;
}

/**
 * 내 개인 에이전트가 하나도 없을 때 웹 카드가 보내는 곳 — 내 도구(Claude Code·Codex 로그인과 개인
 * 에이전트)가 있는 AI 화면. 주소의 주인은 AI 허브 표다.
 */
export const WORK_REQUEST_TOOLS_PATH: string = aiHubSection("accounts").path;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * `work.request.open`의 `args`를 읽는다. 키는 `harness`·`prompt`뿐이고 `prompt`는 필수다(비어 있지
 * 않은 글, 8,000바이트 안). 아니면 undefined(→ 한 줄 폴백).
 *
 * **`harness`만은 너그럽다**: 없거나 `null`이거나 이 빌드가 모르는 값(더 새 서버가 도구를 더한 경우)이면
 * 그냥 「정해지지 않음」(null)이다 — 시트가 평소 기본값(마지막에 쓴 도구)으로 열린다. 서버는 enum 밖
 * 값을 이미 거절하므로 서버가 만든 props에서는 일어나지 않는 일이고, 그런 값 때문에 쓸 만한 글까지
 * 버리지 않는다.
 */
export function workRequestOpenArgs(args: unknown): WorkRequestOpen | undefined {
  if (!isObj(args)) return undefined;
  for (const key of Object.keys(args)) {
    if (key !== "harness" && key !== "prompt") return undefined;
  }
  const prompt = args["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") return undefined;
  if (utf8Bytes(prompt) > WORK_REQUEST_PROMPT_MAX_BYTES) return undefined;
  const harness = args["harness"];
  return {
    harness: oneOf(WORK_REQUEST_OPEN_HARNESSES, harness) ? harness : null,
    prompt,
  };
}

export interface CommandSuggestCard {
  kind: "command_suggest";
  /** 이 빌드가 아는 명령(G2): `ai.connect`, `settings.open`(#3939), `work.request.open`(#4972). */
  commandId: "ai.connect" | "settings.open" | "work.request.open";
  /** `ok`면 보는 사람별 카드, `degraded`면 누구에게나 한 줄. */
  shape: "ok" | "degraded";
  /** `ok`일 때만 뜻이 있다. `ai.connect` 전용(그 밖의 명령은 null). */
  focus: AiConnectFocus;
  /** `settings.open`이고 `ok`일 때만 값이 있다. 그 밖에는 null. */
  section: SettingsOpenSection | null;
  /** `work.request.open`이고 `ok`일 때만 값이 있다. 그 밖에는 null. */
  workRequest: WorkRequestOpen | null;
  /** 제안 대상. 서버가 run의 트리거 작성자로 채운 값(G3). */
  forMemberId: string;
  /** 한 줄 문구에 쓰는 대상 이름(멤버 목록에서 찾은 것, props가 아니다). */
  forMemberName: MemberNameParts;
  /** 제안한 에이전트의 이름(머리 「{에이전트}가 제안했어요」). */
  agentName: string;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUGGESTABLE_CLIENT_IDS: ReadonlySet<string> = new Set(
  AGENT_SUGGESTABLE_COMMANDS.filter((command) => command.kind === "client").map(
    (command) => command.id
  )
);

const HARNESSES = ["claude", "codex", "team_key"] as const;
const SCOPES = ["mine", "team"] as const;
type Harness = (typeof HARNESSES)[number];
type Scope = (typeof SCOPES)[number];

function oneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

/**
 * `ai.connect`의 `args`를 읽는다. 모르는 모양이면 undefined(→ 한 줄 폴백).
 * 규칙은 서버 `normalize_ai_connect_args`와 같다(G2): 키는 `harness`·`scope`뿐,
 * 짝은 `team_key ⇔ team`, `claude|codex ⇔ mine`.
 */
export function aiConnectFocus(args: unknown): AiConnectFocus | undefined {
  if (!isObj(args)) return undefined;
  for (const key of Object.keys(args)) {
    if (key !== "harness" && key !== "scope") return undefined;
  }
  const rawHarness = args["harness"];
  const rawScope = args["scope"];
  if (rawHarness !== undefined && !oneOf(HARNESSES, rawHarness)) return undefined;
  if (rawScope !== undefined && !oneOf(SCOPES, rawScope)) return undefined;
  const harness = rawHarness as Harness | undefined;
  const scope = rawScope as Scope | undefined;
  if (harness !== undefined) {
    const pair: Scope = harness === "team_key" ? "team" : "mine";
    if (scope !== undefined && scope !== pair) return undefined;
    return harness === "team_key" ? "team" : harness;
  }
  if (scope === "team") return "team";
  if (scope === "mine") return "mine";
  return null;
}

/**
 * 메시지 → 제안 카드 모델. null이면 본문 폴백(머리말 1층).
 */
export function commandSuggestCard(
  message: Message,
  directory: Directory
): CommandSuggestCard | null {
  if (message.state === "deleted") return null;
  const envelope = message.props?.[COMMAND_SUGGEST_PROP_KEY];
  if (!isObj(envelope)) return null;
  if (envelope["v"] !== COMMAND_SUGGEST_VERSION) return null;
  const commandId = envelope["command_id"];
  if (typeof commandId !== "string" || !SUGGESTABLE_CLIENT_IDS.has(commandId)) {
    return null;
  }
  // 이 빌드가 그리는 명령은 이 셋이다. 레지스트리에 새 제안 명령이 생겨도 이 파일이
  // 그 명령의 카드를 모르면 본문 폴백이다(AX-5가 여기에 갈래를 더한다).
  if (
    commandId !== "ai.connect" &&
    commandId !== "settings.open" &&
    commandId !== "work.request.open"
  ) {
    return null;
  }
  const forMemberId = envelope["for_member_id"];
  if (typeof forMemberId !== "string" || forMemberId === "") return null;
  const target = memberFor(directory, forMemberId);
  if (target === null) return null;
  const author = memberFor(directory, message.authorMemberId);
  // 제안은 에이전트의 메시지에만 실린다(G1). 사람의 REST 전송은 props를 문자열로만
  // 받아 봉투가 객체일 수 없지만, 그 사실에 기대지 않고 여기서 한 번 더 막는다.
  if (author === null || author.kind !== "agent") return null;

  const label = envelope["label"];
  const extraKey = Object.keys(envelope).some((key) => !ENVELOPE_KEYS.has(key));
  const labelOk =
    label === undefined ||
    (typeof label === "string" && [...label].length <= COMMAND_SUGGEST_LABEL_MAX);
  const isSettings = commandId === "settings.open";
  const isWorkRequest = commandId === "work.request.open";
  const isAiConnect = !isSettings && !isWorkRequest;
  const focus = isAiConnect ? aiConnectFocus(envelope["args"] ?? {}) : null;
  // `settings.open`·`work.request.open`은 `args`가 필수다(`?? {}`로 메우지 않는다 — 비면 한 줄 폴백).
  const section = isSettings ? settingsOpenSection(envelope["args"]) : undefined;
  const workRequest = isWorkRequest ? workRequestOpenArgs(envelope["args"]) : undefined;
  const degraded =
    extraKey ||
    !labelOk ||
    (isSettings
      ? section === undefined
      : isWorkRequest
        ? workRequest === undefined
        : focus === undefined);

  return {
    kind: "command_suggest",
    commandId,
    shape: degraded ? "degraded" : "ok",
    focus: degraded || !isAiConnect ? null : (focus as AiConnectFocus),
    section: degraded || !isSettings ? null : (section as SettingsOpenSection),
    workRequest: degraded || !isWorkRequest ? null : (workRequest as WorkRequestOpen),
    forMemberId,
    forMemberName: memberNameParts(directory, forMemberId, target.displayName),
    agentName: author.displayName.trim() === "" ? `@${author.handle}` : author.displayName,
  };
}

/** 이 카드의 **대상 본인**이 보고 있는가(조작 카드가 서는 유일한 경우). */
export function commandSuggestIsTarget(
  card: CommandSuggestCard,
  viewerMemberId: string | undefined
): boolean {
  return commandSuggestViewer(card, viewerMemberId, false) === "target";
}

/** 보는 사람. 판정은 이 셋뿐이다(G4 표). */
export type CommandSuggestViewer = "target" | "operator" | "other";

/**
 * 보는 사람을 가른다.
 *
 * - `viewerMemberId`가 없으면(읽기 전용 표면) 대상이 아니다.
 * - `degraded` 카드는 누구에게나 `other`(한 줄, 입력·버튼 0).
 * - `isOperator`는 **기존 provider_link 응답**에서 온다(200이면 운영자, 403이면
 *   아님 — G4, 코어 `isOperatorDenied`). props에서 오지 않는다.
 */
export function commandSuggestViewer(
  card: CommandSuggestCard,
  viewerMemberId: string | undefined,
  isOperator: boolean
): CommandSuggestViewer {
  if (card.shape === "degraded") return "other";
  if (
    viewerMemberId !== undefined &&
    viewerMemberId.toLowerCase() === card.forMemberId.toLowerCase()
  ) {
    return "target";
  }
  return isOperator ? "operator" : "other";
}

function nameText(name: MemberNameParts): string {
  return name.handle ? `${name.name}(${name.handle})` : name.name;
}

/**
 * 남에게 보이는 한 줄. 「구민수에게 AI 계정 연결을 제안했어요」.
 * `settings.open`은 「구민수에게 「알림 설정 열기」 카드를 제안했어요」 — 깨진 제안
 * (`section` 없음)은 어느 화면인지 말하지 않고 「설정 열기」만 말한다.
 */
export function commandSuggestOneLine(card: CommandSuggestCard): string {
  if (card.commandId === "work.request.open") {
    // 라벨은 harness로만 갈린다 — 글(prompt)은 남에게 보이는 줄에도 싣지 않는다.
    const what = workRequestOpenLabel(card.workRequest?.harness ?? null);
    return `${attachRecipient(nameText(card.forMemberName), "person")} 「${what}」 카드를 제안했어요`;
  }
  if (card.commandId === "settings.open") {
    const what = card.section === null ? "설정 열기" : settingsOpenLabel(card.section);
    return `${attachRecipient(nameText(card.forMemberName), "person")} 「${what}」 카드를 제안했어요`;
  }
  return `${attachRecipient(nameText(card.forMemberName), "person")} AI 계정 연결을 제안했어요`;
}

/** 대상에게 보이는 카드 머리. 「hermes가 제안했어요」. */
export function commandSuggestHead(card: CommandSuggestCard): string {
  return `${attachParticle(card.agentName)} 제안했어요`;
}

/** 머리의 칩. 1단계 로컬 카드의 「나에게만 보여요」 자리. */
export const COMMAND_SUGGEST_ONLY_ME = "나에게만 조작돼요";

/** 운영자(대상 아님) 한 줄의 문. 팀 키 줄만 펼친다. */
export const COMMAND_SUGGEST_TEAM_OPEN = "팀 AI 키 보기";
export const COMMAND_SUGGEST_TEAM_CLOSE = "팀 AI 키 접기";

/**
 * 폰 대상 카드의 내 계정 절(Q5, #2816 결재: 폰은 구독 로그인 불가).
 * A 레인 host 보고(#2781·#2782)가 오기 전이라 상태 줄 없이 이 한 줄이다.
 */
export const COMMAND_SUGGEST_PHONE_MINE =
  "구독 로그인은 맥에서 해요. 맥에서 이 카드를 열면 바로 로그인할 수 있어요.";

/** 폰 `settings.open` 카드의 안내: 폰에는 이 설정 화면이 없다(맥·웹에서 연다). */
export const COMMAND_SUGGEST_SETTINGS_PHONE = "이 설정은 맥·웹에서 열어요.";

/** 대상 본인의 `settings.open` 카드에서 설정으로 가는 버튼. */
export const COMMAND_SUGGEST_SETTINGS_OPEN = "열기";

/** 폰 카드의 발(키 입력은 폰에서 받지 않는다, Q5). */
export const COMMAND_SUGGEST_PHONE_FOOT = "키 입력은 맥·웹에서 해요";

/** 비운영자에게 남는 다음 행동(G4 · brief §4.4). */
export const COMMAND_SUGGEST_ASK_OPERATOR = "운영자에게 부탁하기";
/** 쓰던 글이 있어 멘션을 채우지 않았을 때. */
export const COMMAND_SUGGEST_ASK_BUSY =
  "쓰던 글이 있어 채우지 않았어요. 운영자를 직접 멘션해 주세요.";
/** 스레드 답글의 제안인데 그 스레드 입력창이 열려 있지 않을 때. */
export const COMMAND_SUGGEST_ASK_THREAD = "스레드를 열고 운영자를 멘션해 주세요.";
/** 멤버 목록에 운영자가 없을 때. */
export const COMMAND_SUGGEST_ASK_NONE = "이 워크스페이스에서 운영자를 찾지 못했어요.";

/**
 * 「운영자에게 부탁하기」가 컴포저에 채울 멘션(보내는 것은 사람이다).
 *
 * 운영자는 워크스페이스 역할 owner·admin인 활성 사람 멤버다. 서버 운영자 판정에는
 * `PLATFORM_ADMIN_EMAILS`도 들지만 그 목록은 클라이언트가 모른다 — 역할로 알 수 있는
 * 사람만 부른다. 나는 빼고, 없으면 null.
 */
export function operatorMentionDraft(
  directory: Directory,
  selfMemberId: string | undefined
): string | null {
  const self = selfMemberId?.toLowerCase();
  const handles = directory.members
    .filter(
      (member) =>
        member.kind === "human" &&
        member.status === "active" &&
        (member.role === "owner" || member.role === "admin") &&
        member.id.toLowerCase() !== self
    )
    .map((member) => `@${member.handle}`);
  return handles.length === 0 ? null : `${handles.join(" ")} `;
}
