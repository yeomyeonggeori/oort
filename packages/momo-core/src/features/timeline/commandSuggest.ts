import type { Message } from "../../lib/api";
import { attachParticle, attachRecipient } from "../../lib/koreanParticle";
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

export interface CommandSuggestCard {
  kind: "command_suggest";
  /** 이 빌드가 아는 명령. v1은 `ai.connect` 하나(G2). */
  commandId: "ai.connect";
  /** `ok`면 보는 사람별 카드, `degraded`면 누구에게나 한 줄. */
  shape: "ok" | "degraded";
  /** `ok`일 때만 뜻이 있다. */
  focus: AiConnectFocus;
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
  // v1이 그리는 명령은 이것 하나다. 레지스트리에 새 제안 명령이 생겨도 이 파일이
  // 그 명령의 카드를 모르면 본문 폴백이다(AX-5가 여기에 갈래를 더한다).
  if (commandId !== "ai.connect") return null;
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
  const focus = aiConnectFocus(envelope["args"] ?? {});
  const degraded = extraKey || !labelOk || focus === undefined;

  return {
    kind: "command_suggest",
    commandId: "ai.connect",
    shape: degraded ? "degraded" : "ok",
    focus: degraded ? null : (focus as AiConnectFocus),
    forMemberId,
    forMemberName: memberNameParts(directory, forMemberId, target.displayName),
    agentName: author.displayName.trim() === "" ? `@${author.handle}` : author.displayName,
  };
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

/** 남에게 보이는 한 줄. 「곽성재에게 AI 계정 연결을 제안했어요」. */
export function commandSuggestOneLine(card: CommandSuggestCard): string {
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
