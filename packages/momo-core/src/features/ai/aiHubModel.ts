import { particleFor } from "../../lib/koreanParticle";
import type { AiDefaultRowId, AiDefaultsTeamKey } from "../settings/aiDefaults";
import { teamKeyHost } from "../settings/aiDefaults";

// =============================================================================
// 「AI」 허브 용어·라벨 모델 (AIH-1, #3391, claudedocs/ai-hub-2026-10/plan.md).
//
// 화면이 「누가 어떤 AI를 쓰고, 누가 부를 수 있고, 비용이 누구 몫인가」를 말하는
// 모든 문장을 한 곳에 둔다. 에이전트 표, 멘션 자동완성, 비소유자 안내가 같은
// 사실을 서로 다른 말로 하는 일(팀 키로 대신 답한다는 거짓 약속 포함)을 구조로
// 막는 것이 목적이다. UI 없음, 플랫폼 API 없음, 순수 함수.
//
// ## 입력: 오늘의 서버 필드와 AIH-2의 미래 필드
//
// 서버가 `brain`·`callable_by`·`owner`·`host_online`을 내려주는 것은 AIH-2(공개 API
// 변경, ADR 증보)다. 그 전에도, 그 뒤에도 같은 함수가 돈다.
//
//   · 미래 필드(brain, callableBy, ownerDisplayName, hostOnline)가 있으면 그 값이 먼저다.
//   · 없으면 오늘 있는 값으로 추론한다: `invocationScope === "owner_only"` 또는
//     `subscriptionHarness` 가 있으면 내 구독, `hostedConnection === true` 면 외부,
//     `hostedConnection === false` 면 팀 키.
//   · 둘 다 없으면 `unknown`. unknown 은 「모른다」이지 기본값이 아니다. 라벨 함수는
//     unknown 에 대해 아무 문장도 만들지 않는다(null). 플랜 §9: 구버전 서버에서는
//     보조 줄을 그리지 않는다. 모르는 것을 팀 키 · 누구나 로 읽으면 구독 에이전트를
//     누구나 부를 수 있다고 약속하게 된다.
//
// ## 약관 선을 모델이 지킨다 (플랜 §4-3, §4-5)
//
// 내 구독 에이전트는 서버가 뭐라고 내려주든 「만든 사람만」이다. brain 이 구독인데
// callable_by 가 everyone 이면 서버 값을 믿지 않고 owner 로 읽는다. 그리고 구독
// 에이전트의 맥이 꺼져 있을 때 어떤 문장도 「팀 키로 대신 답한다」고 하지 않는다.
//
// ## 소유자를 모를 때
//
// 보는 사람이 소유자인지 알 수 없으면(ownerHumanId 또는 viewerHumanId 부재) 「내 구독」
// 도 「성재 님만」도 말하지 않고 「개인 구독 · 만든 사람만」이라 한다. 소유자 본인에게
// 자물쇠와 「보내도 답하지 않아요」를 보이는 쪽이 훨씬 나쁜 오류라서 비소유자 안내는
// ownership === "other" 일 때만 만든다.
// =============================================================================

// ---------------------------------------------------------------------------
// 용어집 (9개)
// ---------------------------------------------------------------------------

export type AiGlossaryId =
  | "myAiAccount"
  | "teamAiKey"
  | "personalKey"
  | "defaultAi"
  | "agent"
  | "callableBy"
  | "cost"
  | "externalConnection"
  | "myWork";

export interface AiGlossaryEntry {
  id: AiGlossaryId;
  /** 화면에 쓰는 말. */
  term: string;
  /** 화면에 쓰는 한 줄. */
  meaning: string;
}

export const AI_GLOSSARY: readonly AiGlossaryEntry[] = [
  {
    id: "myAiAccount",
    term: "내 AI 계정",
    meaning: "내가 로그인한 Claude Code·Codex 구독과 내 API 키. 나만 써요.",
  },
  {
    id: "teamAiKey",
    term: "팀 AI 키",
    meaning: "운영자가 넣은 API 키. 팀이 같이 쓰고 비용은 팀 몫이에요.",
  },
  {
    id: "personalKey",
    term: "개인 키 · 나만",
    meaning: "운영자가 한 사람에게 발급한 API 키. 그 사람의 본인 전용 에이전트만 써요.",
  },
  {
    id: "defaultAi",
    term: "기본 AI",
    meaning: "기능마다 먼저 쓸 AI. 표에서 기능별로 골라요.",
  },
  {
    id: "agent",
    term: "에이전트",
    meaning: "@로 부르는 AI 멤버. 쓰는 AI는 내 구독, 팀 키, 외부 중 하나예요.",
  },
  {
    id: "callableBy",
    term: "부를 수 있는 사람",
    meaning: "누구나 또는 한 사람만. 에이전트마다 하나예요.",
  },
  {
    id: "cost",
    term: "비용",
    meaning: "답할 때 나가는 돈이 누구 몫인지: 내 구독, 팀, 외부 운영자.",
  },
  {
    id: "externalConnection",
    term: "외부 연결",
    meaning: "oort 밖과 주고받는 통로. 앱 · 채널로 들어오는 주소 · 밖으로 보내는 알림 · 외부 에이전트 연결.",
  },
  {
    id: "myWork",
    term: "내 작업",
    meaning: "내 맥 터미널에서 내 계정으로 직접 하는 일.",
  },
];

/**
 * 각 용어가 흡수하는 지금의 말(시안 용어집 오른쪽 열). 화면에 그려지지 않는 데이터라 옛 말 글자가 그대로 있다.
 * design-preflight-allow: 옛 말을 정의하는 표(#3445). 제목·설명을 든 `AI_GLOSSARY`는 마커 없이 게이트를 받는다.
 */
export const AI_GLOSSARY_ABSORBS: Readonly<Record<AiGlossaryId, readonly string[]>> = {
  myAiAccount: ["내 계정", "이 맥", "구독", "구독 추가", "로그인(단독)", "개인 구독", "내 설정", "로컬 터미널 기본 로그인"],
  personalKey: ["개인 API 키", "owner_only 키", "본인 키"],
  teamAiKey: ["팀 연결", "팀 API 키", "팀 키", "팀 기본", "운영자 설정"],
  defaultAi: ["기본 AI(유지)", "앱 명령", "원격 작업 기본 계정", "팀 에이전트 대답", "로컬 터미널 새 세션"],
  agent: ["호스티드 에이전트", "구독 에이전트", "합류/합류시키기", "봇(AI 봇)", "에이전트 초대(초대하기만 유지)"],
  callableBy: ["owner_only", "오너 전용", "소유자 전용", "본인 1인"],
  cost: ["과금", "사용량 소스", "팀 키만"],
  externalConnection: ["웹훅", "이벤트 구독", "에이전트 자격", "MCP", "Agent Port", "1회용 연결 값(발급 화면에서만 사용)", "앱"],
  myWork: ["내 작업(유지)", "로컬 터미널", "코드 실행 호스트(설정에 유지)"],
};

/** 시안 용어집 아래 「금지」 줄. **화면에 렌더하면 안 된다**(옛 말을 인용하는 문장이다). design-preflight-allow: 금지어를 말하는 문장이라 옛 말을 인용한다(화면에는 그려지지 않는다, #3445). */
export const AI_GLOSSARY_BANS =
  "「AI 연결」은 허브 이름 「AI」로 흡수해요. 「합류」는 화면에서 안 써요(만들기·초대). 영어 약자 MCP·Agent Port는 외부 에이전트 연결 상세 화면의 괄호 안에서만 써요.";

export function glossaryEntry(id: AiGlossaryId): AiGlossaryEntry {
  const found = AI_GLOSSARY.find((entry) => entry.id === id);
  // 위 표가 AiGlossaryId 를 전부 덮는다는 것은 시험이 고정한다.
  if (!found) throw new Error(`unknown glossary id: ${id}`);
  return found;
}

/** 외부 연결 하위 이름 (플랜 §2). */
export const AI_EXTERNAL_SUBSECTIONS = {
  apps: "앱",
  incoming: "채널로 들어오는 주소",
  outgoing: "밖으로 보내는 알림",
  externalAgents: "외부 에이전트 연결",
  hostedBotInvite: "호스티드 봇 초대",
} as const;

export type AiExternalRowId = keyof typeof AI_EXTERNAL_SUBSECTIONS;

/** 외부 연결 구획의 한 줄 (AIH-8, #3438, 시안 panel-external). */
export interface AiExternalRow {
  id: AiExternalRowId;
  /** 용어집 이름. */
  title: string;
  /** 줄 머리의 작은 옛 이름. 영어 약자는 넣지 않는다(상세 화면 괄호에서만). */
  legacy: string | null;
  /** 상세 화면 머리의 괄호. 영어 약자가 여기서만 선다. */
  detailLegacy: string | null;
  /** 줄 아래 한 문장. */
  summary: string;
  /** 상세 화면 머리 설명(옛 구획 설명을 해요체로 옮긴 것). */
  detail: readonly string[];
  /** 개수 칩의 단위. 센 값이 없는 줄은 null. */
  countNoun: string | null;
  /** 상세 화면 주소. 상세 본문이 없는 줄은 null. */
  path: string | null;
  /** 이 줄로 옮겨 온 옛 설정 구획 id. */
  fromSettings: string | null;
  /** 설정의 옛 구획 자리에 서는 한 문장. 옮겨 온 줄이 없으면 null. */
  settingsLine: string | null;
}

export const AI_EXTERNAL_BASE_PATH = "/ai/external";

export const AI_EXTERNAL_ROWS: readonly AiExternalRow[] = [
  {
    id: "apps",
    title: AI_EXTERNAL_SUBSECTIONS.apps,
    legacy: null,
    detailLegacy: null,
    summary: "워크스페이스에 설치한 앱과 쓸 수 있는 도구를 관리해요.",
    detail: ["워크스페이스에 설치한 앱과, 에이전트가 쓸 수 있는 도구를 관리해요."],
    countNoun: "설치",
    path: `${AI_EXTERNAL_BASE_PATH}/apps`,
    fromSettings: "plugins",
    settingsLine: "앱은 AI › 외부 연결의 「앱」으로 옮겼어요.",
  },
  {
    id: "incoming",
    title: AI_EXTERNAL_SUBSECTIONS.incoming,
    legacy: "웹훅",
    detailLegacy: "웹훅",
    summary: "외부 서비스가 채널에 메시지를 보낼 때 써요. 주소와 비밀값을 발급해요.",
    detail: [
      "외부 서비스가 이 워크스페이스의 채널로 알림을 보내도록 받는 주소를 발급해요.",
      "비밀값은 발급 직후 한 번만 보여요. 서버는 원문을 보관하지 않아요.",
    ],
    countNoun: "주소",
    path: `${AI_EXTERNAL_BASE_PATH}/incoming`,
    fromSettings: "webhooks",
    settingsLine: "웹훅은 AI › 외부 연결의 「채널로 들어오는 주소」로 옮겼어요.",
  },
  {
    id: "outgoing",
    title: AI_EXTERNAL_SUBSECTIONS.outgoing,
    legacy: "이벤트 구독",
    detailLegacy: "이벤트 구독",
    summary: "워크스페이스에서 일어난 일을 외부 HTTPS 주소로 보내요. 슬랙 알림, 대시보드에 써요.",
    detail: [
      "워크스페이스에서 일어난 일을 외부 HTTPS 주소로 보내요. 슬랙 알림, 사내 대시보드, 자동화 스크립트를 붙일 때 써요.",
      "구독은 워크스페이스 전체에 걸려요. 채널 하나만 골라 보낼 수는 없어요.",
    ],
    countNoun: "구독",
    path: `${AI_EXTERNAL_BASE_PATH}/outgoing`,
    fromSettings: "events",
    settingsLine: "이벤트 구독은 AI › 외부 연결의 「밖으로 보내는 알림」으로 옮겼어요.",
  },
  {
    id: "externalAgents",
    title: AI_EXTERNAL_SUBSECTIONS.externalAgents,
    legacy: "에이전트 자격",
    detailLegacy: "에이전트 자격 · MCP · Agent Port",
    summary: "다른 곳에서 도는 에이전트를 멤버로 들여요. 연결 값은 발급할 때 한 번만 보여요.",
    detail: [
      "다른 인프라에서 도는 에이전트를 이 워크스페이스의 멤버로 들이는 연결이에요.",
      "연결 값은 발급 직후 한 번만 보여요. 해제는 서버가 끊겼다고 답한 뒤에야 끝나요.",
    ],
    countNoun: "연결",
    path: `${AI_EXTERNAL_BASE_PATH}/agents`,
    fromSettings: "agents",
    settingsLine: "에이전트 자격은 AI › 외부 연결의 「외부 에이전트 연결」로 옮겼어요.",
  },
  {
    id: "hostedBotInvite",
    title: AI_EXTERNAL_SUBSECTIONS.hostedBotInvite,
    legacy: null,
    detailLegacy: null,
    summary: "서버가 대신 돌려 주는 봇을 초대해요. 에이전트 만들기 목록에서도 열려요.",
    detail: [],
    countNoun: "봇",
    path: null,
    fromSettings: null,
    settingsLine: null,
  },
];

/** 외부 연결 구획 문구 (AIH-8). */
export const AI_EXTERNAL_COPY = {
  permission: "만들고 지우는 건 소유자·관리자만 해요. 그 밖의 멤버는 볼 수만 있어요.",
  open: "열기",
  back: "외부 연결",
  inviteHref: "/ai/agents?create=1",
  codeHost: {
    text: "코드 실행 호스트(내 작업이 도는 맥·서버)는 「내 작업」 관련이라 설정에 있어요.",
    action: "설정에서 열기",
    href: "/settings?section=code",
  },
  notFound: "이 연결은 찾지 못했어요. 외부 연결에서 다시 골라 주세요.",
} as const;

export function aiExternalRow(id: AiExternalRowId): AiExternalRow {
  const found = AI_EXTERNAL_ROWS.find((row) => row.id === id);
  if (!found) throw new Error(`unknown external row: ${id}`);
  return found;
}

/** 옛 설정 구획 id(`?section=`)가 옮겨 간 외부 연결 줄. 없으면 null. */
export function aiExternalRowFromSettings(section: string): AiExternalRow | null {
  return AI_EXTERNAL_ROWS.find((row) => row.fromSettings === section) ?? null;
}

// ---------------------------------------------------------------------------
// 화면 문구 상수 (플랜 §5)
// ---------------------------------------------------------------------------

export const AI_HUB_COPY = {
  name: "AI",
  subtitle: "누가 어떤 AI를 쓰는지, 누가 부를 수 있는지, 비용이 누구 몫인지 한 곳에서 봐요.",
  webAccountsNotice:
    "Claude Code·Codex 로그인은 데스크탑 앱에서 해요. 로그인 정보가 브라우저로 오지 않도록, 내 맥에 설치한 공식 CLI로만 로그인해요.",
  phoneAccountsNotice: "로그인은 맥에서 해요.",
  loginNotStored: "로그인 정보는 oort에 저장하지 않아요.",
  defaultAiDescription:
    "기능마다 먼저 쓸 AI를 골라요. 고르지 않으면 팀 AI 키로 답해요. 내 구독은 내 줄에서만 고를 수 있고, 팀 에이전트는 내 구독을 쓰지 않아요.",
  agentsPageTagline: "@로 부르는 AI 멤버예요.",
  subscriptionHostOfflineDetail: "켜지면 답해요. 팀 키로 대신하지 않아요.",
  /** 에이전트 만들기 3종 (시안 5번 패널). */
  createKinds: {
    team: {
      title: "팀 에이전트",
      description: "팀 AI 키로 답해요. 누구나 부르고, 비용은 팀 몫이에요.",
      audience: "소유자·관리자",
    },
    mySubscription: {
      title: "내 Claude Code·Codex",
      description: "내 구독으로 답해요. 나만 부르고, 비용은 내 구독이에요.",
      audience: "데스크탑",
    },
    external: {
      title: "다른 곳에서 도는 에이전트",
      description: "직접 운영하는 에이전트를 초대해요. 비용은 운영하는 쪽이 내요.",
      audience: "소유자·관리자",
    },
  },
} as const;

/**
 * 「에이전트」 구획(/ai/agents) 화면 문구 (AIH-7, #3428). 표 머리·상태·만들기 3종 선택.
 * 칸의 값은 `aiAgentLabels` 가 만든다; 여기는 표 둘레의 말만 둔다.
 */
export const AI_AGENTS_PANE_COPY = {
  columns: {
    agent: "에이전트",
    brain: "쓰는 AI",
    callable: "부를 수 있는 사람",
    cost: "비용",
    status: "상태",
  },
  tableLabel: "에이전트별 쓰는 AI · 부를 수 있는 사람 · 비용 · 상태",
  loading: "에이전트를 불러오는 중이에요.",
  error: "에이전트를 불러오지 못했어요.",
  retry: "다시 불러오기",
  empty: "아직 에이전트가 없어요.",
  emptyCanCreate: "만들면 채널에서 @로 부를 수 있어요.",
  emptyCannotCreate: "에이전트는 워크스페이스 소유자나 관리자가 만들 수 있어요.",
  unknownBrain: "쓰는 AI를 아직 몰라요",
  locked: "내가 부를 수 없어요",
  inactive: "사용 중지",
  paused: "일시정지",
  active: "활성",
  statusUnknown: "상태를 볼 수 없어요",
  manageLine: "프로필 · 이력 · 연결 상세는 에이전트에서 봐요.",
  manageLink: "에이전트 열기",
  offline: "연결이 끊겼어요. 마지막으로 받은 내용을 보여 줘요.",
  create: {
    button: "에이전트 만들기",
    title: "에이전트 만들기",
    description: "어떤 AI로 답하게 할지 골라요.",
    cancel: "닫기",
    desktopHint: "데스크탑에서 해요",
    webReason: "로그인과 만들기는 데스크탑 앱에서 해요. 웹에서는 만들 수 없어요.",
    pending: "확인하는 중이에요.",
    serverOff: "이 서버에서는 꺼져 있어요. 운영자에게 요청하세요.",
    unavailable: "이 빌드에서는 쓸 수 없어요.",
    denied: "소유자·관리자만 만들 수 있어요.",
    externalOff: "이 빌드에서는 외부 에이전트를 초대할 수 없어요.",
  },
} as const;

/** 팀 키 비운영자 안내. 운영자 이름을 모르면 「운영자」로 말한다. */
export function teamKeyOperatorOnlyNotice(operatorName?: string | null): string {
  const name = cleanName(operatorName);
  const who = name ? `${name} 님` : "운영자";
  return `팀 키는 운영자만 보고 바꿀 수 있어요. 필요하면 ${who}에게 요청하세요.`;
}

// ---------------------------------------------------------------------------
// 「팀 AI 키」 구획과 「기본 AI」 표 (AIH-6, #3400, 플랜 §5·§8-6)
//
// 화면 문장은 여기서 나온다. 「고르지 않으면」 문장은 서버가 실제로 하는 일을
// 옮긴 것이다(2026-10-03 코드 확인):
//   · 팀 에이전트 줄이 비어 있으면 `resolve_default_ai_role` 이 NotApplicable 을 돌려주고
//     턴은 그대로 간다: 연결 순서 맨 위 키(위치 0)와 서버 기본 모델. 팀 키가 없으면
//     `provider_required` 로 대답하지 못한다(내 구독으로 넘어가지 않는다).
//   · 첫 인사도 같은 길이다(`is_welcome` 은 summary 줄을 읽고, 줄이 없으면 맨 위 키).
//   · 채널 요약은 다르다: `summary.rs resolve_summary_model` 은 줄이 없으면
//     `no_summary_row` 로 모델을 부르지 않는다(「대신 다른 걸로 간다」가 없다).
//     그래서 플랜의 한 문장 「고르지 않으면 팀 AI 키로 답해요」는 채널 요약에는 거짓이다.
//   · 개인 줄 셋은 이 기기 저장이고 서버가 모른다(`aiDefaults.ts`).
// 표의 「고르지 않으면」 칸은 이 파일의 구조(kind)에서 문장을 만들고, 시험이 코어
// 판정(`resolveRow`)과 어긋나지 않는지 본다.
// ---------------------------------------------------------------------------

/** 팀 AI 키 구획의 화면 문구. */
export const AI_TEAM_KEYS_COPY = {
  keysHeading: "넣어 둔 키",
  keysSubtitle: "운영자만 보고 바꿔요",
  addKey: "API 키 추가",
  columns: {
    company: "AI 회사",
    key: "키",
    usedBy: "쓰는 곳",
    status: "상태",
  },
  keyNone: "아직 넣은 키가 없어요",
  emptyLine: "아직 팀 AI 키가 없어요. 팀 에이전트가 대답하려면 API 키가 하나 필요해요.",
  mockLine: "지금 팀 에이전트는 모의 응답으로만 대답해요.",
  noAnswerLine: "지금 팀 에이전트는 대답하지 못해요.",
  fallbackBadge: "예비",
  firstKeyBadge: "맨 위 키",
  firstKeyNote: "고르지 않은 기능은 맨 위 키를 써요.",
  lastCheckUnknown: "이 화면에서는 아직 확인하지 않았어요",
  usedByNobody: "쓰는 곳이 아직 없어요",
  usedByUnknown: "쓰는 곳을 불러오지 못했어요",
  usedByAgents: (names: readonly string[]) => {
    if (names.length === 0) return "";
    const head = names.slice(0, 2).map((n) => `@${n}`).join(", ");
    return names.length > 2 ? `${head} 외 ${names.length - 2}명` : head;
  },
  agentsUnknown: "쓰는 에이전트를 불러오지 못했어요",
  chainToggle: "예비 키와 시도 순서",
  requestHeading: "운영자에게 요청",
  requestDm: (name: string) => `${name} 님에게 메시지`,
  requestNoOperator: "이 워크스페이스의 운영자를 찾지 못했어요. 이 서버를 운영하는 사람에게 요청하세요.",
  requestHint: "키를 넣거나 바꾸는 일은 운영자가 해요.",
  readOnlyDefaults: "기본 AI는 볼 수만 있어요. 팀 줄은 운영자가 바꿔요.",
  checkFirst: "연결 확인을 하면 줄마다 고를 수 있는 모델이 보여요.",
  defaultsHeading: "기본 AI",
  defaultsSubtitle: "기능마다 먼저 쓸 AI",
  defaultsColumns: {
    feature: "이 기능은",
    serves: "누구를 위해",
    uses: "이 AI로",
    unset: "고르지 않으면",
  },
  defaultsFootTeam: "팀 줄은 운영자가 바꿔요. 모델을 직접 고른 에이전트는 자기 모델을 써요.",
  defaultsFootPersonal: "내 줄은 내 구독을 고를 수 있어요. 팀 에이전트는 내 구독으로 넘어가지 않아요.",
} as const;

/** 서버가 알려준 주소로 AI 회사 이름을 붙인다. 모르는 주소는 주소 이름 그대로. */
export function teamKeyCompany(baseUrl: string): { name: string; models: string | null } {
  const host = teamKeyHost(baseUrl);
  if (host === "api.anthropic.com") return { name: AI_HUB_OVERVIEW_COPY.providerLabel.anthropic, models: "Claude 모델" };
  if (host === "api.openai.com") return { name: AI_HUB_OVERVIEW_COPY.providerLabel.openai, models: "GPT 모델" };
  return { name: host === "" ? "알 수 없는 주소" : host, models: null };
}

export type AiTeamFeatureId = "appCommand" | "teamAgent" | "greeting" | "channelSummary";

const TEAM_FEATURE_NAME: Readonly<Record<AiTeamFeatureId, string>> = {
  appCommand: "말로 앱 설정 바꾸기",
  teamAgent: "팀 에이전트의 답",
  greeting: "첫 인사",
  channelSummary: "채널 요약",
};

/**
 * 연결 순서의 한 자리(위치)가 쓰이는 기능. `defaultAi` 는 서버에 저장된 팀 줄이 가리키는 위치
 * (없으면 null = 고르지 않음). 위치 0 은 맨 위 키라서 고르지 않은 기능이 모두 거기로 간다.
 * 채널 요약은 줄을 고른 위치에서만 돈다(고르지 않으면 어디서도 돌지 않는다).
 */
export function teamKeyFeatureUses(
  position: number,
  defaultAi: { teamAgent: number | null; summary: number | null } | null
): string[] {
  const out: AiTeamFeatureId[] = [];
  const teamAgent = defaultAi?.teamAgent ?? null;
  const summary = defaultAi?.summary ?? null;
  if (position === 0) out.push("appCommand");
  if (teamAgent === null ? position === 0 : teamAgent === position) out.push("teamAgent");
  if (summary === null ? position === 0 : summary === position) out.push("greeting");
  if (summary !== null && summary === position) out.push("channelSummary");
  return out.map((id) => TEAM_FEATURE_NAME[id]);
}

/** 「고르지 않으면」 일이 어떻게 되는지의 구조. 문장은 여기서 만든다. */
export type AiDefaultUnsetKind =
  | "teamKeyFirst" // 팀 AI 키 맨 위 키로 답한다. 키가 없으면 못 한다.
  | "greetingFirstSummaryOff" // 첫 인사는 맨 위 키, 채널 요약은 돌지 않는다.
  | "macDefaultLogin" // 이 맥 기본 로그인
  | "askEachTime" // 매번 묻는다
  | "off"; // 꺼져 있다

export interface AiDefaultFeatureRow {
  readonly rowId: AiDefaultRowId;
  /** 기능 이름(평문). */
  readonly feature: string;
  /** 어디서 쓰는지 한 줄. */
  readonly hint: string;
  /** 누구를 위한 줄인가: 나만(이 기기) / 팀 모두. */
  readonly serves: "me" | "team";
  readonly servesText: string;
  readonly whenUnset: AiDefaultUnsetKind;
}

export const AI_HUB_DEFAULT_ROWS: readonly AiDefaultFeatureRow[] = [
  { rowId: "teamAgent", feature: "팀 에이전트가 대답할 때", hint: "멘션, DM, 팀이 보는 곳", serves: "team", servesText: "팀 모두", whenUnset: "teamKeyFirst" },
  { rowId: "summary", feature: "첫 인사 · 채널 요약", hint: "서버가 만들고 팀이 봐요", serves: "team", servesText: "팀 모두", whenUnset: "greetingFirstSummaryOff" },
  { rowId: "appCommand", feature: "말로 앱 설정 바꾸기", hint: "⌘K에서 「테마 바꿔 줘」 · 이 기기에만", serves: "me", servesText: "나만", whenUnset: "teamKeyFirst" },
  { rowId: "localTerminal", feature: "내 맥 터미널을 열 때", hint: "새 세션을 열 때 먼저 쓸 계정 · 이 기기에만", serves: "me", servesText: "나만", whenUnset: "macDefaultLogin" },
  { rowId: "remoteWork", feature: "폰에서 시작한 작업", hint: "내 맥에서 도는 원격 작업 · 이 기기에만", serves: "me", servesText: "나만", whenUnset: "askEachTime" },
  { rowId: "guardrail", feature: "승인이 필요한지 판정할 때", hint: "가드레일", serves: "team", servesText: "팀 모두", whenUnset: "off" },
];

export function aiDefaultFeatureRow(rowId: AiDefaultRowId): AiDefaultFeatureRow {
  const found = AI_HUB_DEFAULT_ROWS.find((row) => row.rowId === rowId);
  if (!found) throw new Error(`unknown default ai row: ${rowId}`);
  return found;
}

/**
 * 「고르지 않으면」 문장. 팀 키 상태(`absent`/`mock`)에 따라 달라지는 것만 갈라진다.
 * 상태를 모를 때(`hidden`·`loading`·`error`)는 키가 있다고도 없다고도 하지 않는다.
 */
export function defaultAiUnsetSentence(
  rowId: AiDefaultRowId,
  teamKey: AiDefaultsTeamKey["status"]
): string {
  const kind = aiDefaultFeatureRow(rowId).whenUnset;
  const noKey = teamKey === "absent" || teamKey === "mock";
  switch (kind) {
    case "teamKeyFirst":
      if (rowId === "appCommand") {
        return noKey
          ? "팀 AI 키가 없어 쓸 수 없어요."
          : "팀 AI 키 맨 위 키로 답해요.";
      }
      if (teamKey === "mock") return "저장된 키가 없어 모의 응답으로만 대답해요. 내 구독으로 넘어가지 않아요.";
      if (teamKey === "absent") return "팀 AI 키가 없어 대답하지 못해요. 내 구독으로 넘어가지 않아요.";
      return "팀 AI 키 맨 위 키와 서버 기본 모델로 답해요. 내 구독으로 넘어가지 않아요.";
    case "greetingFirstSummaryOff":
      return noKey
        ? "팀 AI 키가 없어 요약은 쉬고, 첫 인사는 정해진 문구로 나가요."
        : "첫 인사는 팀 AI 키 맨 위 키로 나가요. 채널 요약은 여기서 고를 때까지 만들지 않아요.";
    case "macDefaultLogin":
      return "이 맥 기본 로그인으로 열려요.";
    case "askEachTime":
      return "매번 묻기로 해요. 어떤 계정으로 할지 그때 골라요.";
    case "off":
      return "지금은 꺼져 있어요. 기존 승인 규칙을 그대로 써요.";
  }
}

// ---------------------------------------------------------------------------
// 입력 사실과 분류
// ---------------------------------------------------------------------------

export type AiBrain = "subscription" | "team_key" | "external" | "personal_key";
export type AiCallableBy = "owner" | "everyone";
export type AiCostOwner = "owner" | "team" | "external";

/**
 * 서버 `brain_unavailable_reason` 의 값. Claude Code 구독 대행(서버가 사용자 대신 구독 세션에
 * 말을 거는 길)이 Anthropic 약관 확인 전까지 꺼져 있을 때 서버가 내려준다
 * (`momo_agent::CLAUDE_SUBSCRIPTION_AGENT_PAUSED`, #3401). 모르는 값은 상태를 만들지 않는다.
 */
export const CLAUDE_SUBSCRIPTION_AGENT_PAUSED = "claude_subscription_agent_paused";
export type AiHarness = "claude_code" | "codex";
export type AiOwnership = "mine" | "other" | "unknown";

/**
 * 에이전트 한 명에 대해 클라이언트가 가진 사실. 모든 필드가 선택이다.
 *
 * 앞 묶음은 AIH-2 의 미래 필드이고 서버 값(문자열)을 그대로 받는다. 모르는 값은
 * 부재와 같다. 뒤 묶음은 오늘 서버가 이미 내려주는 값이다.
 */
export interface AiAgentFacts {
  // --- AIH-2 (아직 서버에 없음) ---
  brain?: string | null;
  callableBy?: string | null;
  /** 소유자 표시 이름(멤버 표시 이름). */
  ownerDisplayName?: string | null;
  hostOnline?: boolean | null;
  /** `brain_unavailable_reason`. 있으면 이 에이전트의 brain 이 지금은 답하지 않는다는 서버의 말. */
  brainUnavailableReason?: string | null;
  // --- 오늘 있는 값 ---
  /** `RosterMember.ownerHumanId`. */
  ownerHumanId?: string | null;
  /** `HostedAgentConnection.invocationScope`. */
  invocationScope?: string | null;
  /** `HostedAgentConnection.subscriptionHarness`. */
  subscriptionHarness?: string | null;
  /**
   * 호스티드 연결(외부 에이전트)이 있는가. true=있음, false=연결 목록을 읽었고 없음,
   * undefined=읽지 못함. false 와 undefined 는 다른 사실이다.
   */
  hostedConnection?: boolean | null;
  /** 팀 키 줄의 괄호 안(예: Anthropic). 있을 때만 쓴다. */
  providerLabel?: string | null;
}

export interface AiViewer {
  /** 보는 사람의 사람 멤버 id. 없으면 소유 여부를 모른다. */
  humanId?: string | null;
}

export interface AiAgentClassification {
  brain: AiBrain | "unknown";
  /** brain 을 서버가 말했는지, 오늘 값에서 추론했는지, 모르는지. */
  brainSource: "server" | "inferred" | "unknown";
  harness: AiHarness | null;
  callableBy: AiCallableBy | "unknown";
  cost: AiCostOwner | "unknown";
  ownership: AiOwnership;
  ownerName: string | null;
  hostOnline: boolean | null;
  /** 서버가 알려준 사유 중 이 모듈이 아는 것만. 모르는 사유는 null. */
  unavailableReason: typeof CLAUDE_SUBSCRIPTION_AGENT_PAUSED | null;
  providerLabel: string | null;
}

const BRAINS: readonly AiBrain[] = ["subscription", "team_key", "external", "personal_key"];

function cleanName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function toBrain(raw: string | null | undefined): AiBrain | null {
  return BRAINS.find((brain) => brain === raw) ?? null;
}

function toHarness(raw: string | null | undefined): AiHarness | null {
  return raw === "claude_code" || raw === "codex" ? raw : null;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function classifyAiAgent(facts: AiAgentFacts, viewer: AiViewer = {}): AiAgentClassification {
  const harness = toHarness(facts.subscriptionHarness);

  let brain: AiBrain | null = toBrain(facts.brain);
  let brainSource: AiAgentClassification["brainSource"] = brain ? "server" : "unknown";
  if (!brain) {
    if (facts.invocationScope === "owner_only" || harness) brain = "subscription";
    else if (facts.hostedConnection === true) brain = "external";
    else if (facts.hostedConnection === false) brain = "team_key";
    if (brain) brainSource = "inferred";
  }

  // 구독은 서버 값과 무관하게 소유자만. 그 밖에는 서버 값 > 오늘 값 > brain 에서 유도.
  let callableBy: AiCallableBy | "unknown";
  // 개인 키도 발급받은 사람의 본인 전용 에이전트만 쓴다(#3396, 서버가 팀 키로 대신하지 않는다).
  if (brain === "subscription" || brain === "personal_key") callableBy = "owner";
  // 서버(`callable_by`)는 `owner_only` | `everyone` 을 내려준다. 코어 안에서는 `owner` 로 읽는다.
  else if (facts.callableBy === "owner" || facts.callableBy === "owner_only") callableBy = "owner";
  else if (facts.callableBy === "everyone") callableBy = "everyone";
  else if (facts.invocationScope === "owner_only") callableBy = "owner";
  else if (facts.invocationScope === "workspace") callableBy = "everyone";
  else if (brain === "team_key" || brain === "external") callableBy = "everyone";
  else callableBy = "unknown";

  const cost: AiAgentClassification["cost"] =
    brain === "subscription" || brain === "personal_key" ? "owner" : brain === "team_key" ? "team" : brain === "external" ? "external" : "unknown";

  let ownership: AiOwnership = "unknown";
  const ownerId = cleanName(facts.ownerHumanId);
  const viewerId = cleanName(viewer.humanId);
  if (ownerId && viewerId) ownership = sameId(ownerId, viewerId) ? "mine" : "other";

  return {
    brain: brain ?? "unknown",
    brainSource,
    harness,
    callableBy,
    cost,
    ownership,
    ownerName: cleanName(facts.ownerDisplayName),
    hostOnline: typeof facts.hostOnline === "boolean" ? facts.hostOnline : null,
    // 이 사유는 Claude 구독 대행에만 붙는다. 다른 brain 에 잘못 내려와도 「문의 중」을 만들지 않는다.
    unavailableReason:
      brain === "subscription" && facts.brainUnavailableReason === CLAUDE_SUBSCRIPTION_AGENT_PAUSED ? facts.brainUnavailableReason : null,
    providerLabel: cleanName(facts.providerLabel),
  };
}

// ---------------------------------------------------------------------------
// 라벨
// ---------------------------------------------------------------------------

export const HARNESS_LABEL: Readonly<Record<AiHarness, string>> = {
  claude_code: "Claude Code",
  codex: "Codex",
};

/** 소유자를 문장 안에서 부르는 말. 이름을 모르면 「만든 사람」. */
function ownerRef(c: AiAgentClassification): string {
  return c.ownerName ? `${c.ownerName} 님` : "만든 사람";
}

/** 에이전트 상태 칸의 서버 사유 표시. 회색(muted) 한 가지 톤이다. */
export interface AiAgentStatusLabel {
  label: string;
  tone: "muted";
  /** 칩 옆 보조 줄 · 툴팁 본문. */
  detail: string;
}

export const AI_AGENT_PAUSED_STATUS: AiAgentStatusLabel = {
  label: "문의 중",
  tone: "muted",
  detail:
    "Claude 구독 대행은 Anthropic 약관 확인 전까지 꺼져 있어요. 내 맥 터미널이나 Remote Control로 직접 쓰는 건 그대로예요.",
};

export interface AiAgentLabels {
  /** 표 「쓰는 AI」 열. */
  brain: string | null;
  /** 표 「부를 수 있는 사람」 열(칩). */
  callable: string | null;
  /** 표 「비용」 열. */
  cost: string | null;
  /** 표 「상태」 열의 맥 켜짐/꺼짐. 구독 에이전트가 아니거나 모르면 null. */
  host: { label: string; detail: string | null } | null;
  /**
   * 서버가 이 에이전트의 brain 이 지금 답하지 않는다고 알린 경우의 상태(회색 칩 + 설명).
   * 이게 있으면 `host`(맥 켜짐/꺼짐)는 null 이다: 맥을 켜도 답하지 않으니 「켜지면 답해요」를 말하지 않는다.
   */
  status: AiAgentStatusLabel | null;
  /** 멘션 후보의 보조 줄(`쓰는 AI · 부를 수 있는 사람`). null 이면 줄을 그리지 않는다. */
  mentionLine: string | null;
  /** 멘션 후보 오른쪽 칩. */
  mentionBadge: string | null;
  /**
   * 보조 줄이 한 줄로 접히는 큰 글자용: **상태(문의 중·맥 꺼짐)를 앞에** 둔 같은 사실.
   * 말줄임은 꼬리를 자르므로 「문의 중」/「맥 꺼짐」이 꼬리에 있으면 정작 둘을 가르는 말이 사라진다.
   * 상태가 없으면 `mentionLine` 과 같다.
   */
  mentionLineStatusFirst: string | null;
  /** 멘션 후보에 자물쇠를 붙이고 흐리게: 보는 사람이 못 부르는 에이전트. */
  lockedForViewer: boolean;
}

export function aiAgentLabels(c: AiAgentClassification): AiAgentLabels {
  const mine = c.ownership === "mine";
  const other = c.ownership === "other";
  // 소유자 이름을 알거나 남의 것이면 이름(또는 「만든 사람」)으로 말한다. 둘 다 아니면 중립.
  const named = c.ownerName !== null || other;
  const harness = c.harness ? ` (${HARNESS_LABEL[c.harness]})` : "";

  let brain: string | null = null;
  let callable: string | null = null;
  let cost: string | null = null;
  let mentionBrain: string | null = null;
  let mentionCallable: string | null = null;
  let mentionBadge: string | null = null;

  switch (c.brain) {
    case "subscription":
      brain = `${mine ? "내 구독" : "개인 구독"}${harness}`;
      callable = mine ? "나만" : `${ownerRef(c)}만`;
      cost = mine ? "내 구독" : `${ownerRef(c)} 구독`;
      mentionBrain = mine ? "내 구독" : named ? `${ownerRef(c)} 개인 구독` : "개인 구독";
      mentionCallable = mine ? "나만 부를 수 있어요" : `${ownerRef(c)}만 부를 수 있어요`;
      mentionBadge = mine ? "내 구독" : named ? `${ownerRef(c)}만` : "개인 구독";
      break;
    case "personal_key":
      // 운영자가 사람마다 발급한 API 키. 그 사람의 본인 전용 에이전트만 쓴다. 구독이 아니다.
      brain = "개인 키";
      callable = mine ? "나만" : `${ownerRef(c)}만`;
      cost = "개인 키";
      mentionBrain = "개인 키";
      mentionCallable = mine ? "나만" : `${ownerRef(c)}만`;
      mentionBadge = "개인 키";
      break;
    case "team_key":
      brain = `팀 AI 키${c.providerLabel ? ` (${c.providerLabel})` : ""}`;
      callable = "누구나";
      cost = "팀";
      mentionBrain = "팀 키";
      mentionCallable = "누구나";
      mentionBadge = "팀 키";
      break;
    case "external":
      brain = "외부 (직접 운영)";
      callable = "누구나";
      cost = "외부 운영자";
      mentionBrain = "외부";
      mentionCallable = "누구나";
      mentionBadge = "외부";
      break;
    default:
      break;
  }

  // brain 을 모르는 채 callable 만 아는 경우(서버가 callable_by 만 내려준 경우)에도
  // 표의 칩은 그린다. 보조 줄은 두 값을 다 알 때만.
  if (callable === null && c.callableBy === "everyone") callable = "누구나";
  if (callable === null && c.callableBy === "owner") callable = `${ownerRef(c)}만`;

  const status = c.unavailableReason === CLAUDE_SUBSCRIPTION_AGENT_PAUSED ? AI_AGENT_PAUSED_STATUS : null;

  // 「문의 중」이면 맥 상태는 말하지 않는다(위 status 주석).
  let host: AiAgentLabels["host"] = null;
  if (status === null && c.brain === "subscription" && c.hostOnline === true) {
    host = { label: mine ? "내 맥 켜짐" : "맥 켜짐", detail: null };
  } else if (status === null && c.brain === "subscription" && c.hostOnline === false) {
    host = { label: "맥 꺼짐", detail: AI_HUB_COPY.subscriptionHostOfflineDetail };
  }

  const statusWord = status ? status.label : host?.label === "맥 꺼짐" ? "맥 꺼짐" : null;
  const offlineSuffix = statusWord !== null ? ` · ${statusWord}` : "";
  const mentionLine =
    mentionBrain !== null && mentionCallable !== null ? `${mentionBrain} · ${mentionCallable}${offlineSuffix}` : null;

  return {
    brain,
    callable,
    cost,
    host,
    status,
    mentionLine,
    mentionBadge,
    mentionLineStatusFirst:
      mentionLine !== null && statusWord !== null
        ? `${statusWord} · ${mentionBrain} · ${mentionCallable}`
        : mentionLine,
    lockedForViewer: (c.brain === "subscription" || c.brain === "personal_key") && other,
  };
}

// ---------------------------------------------------------------------------
// 안내 문구 (보낸 사람에게만 보이는 정적 문구)
// ---------------------------------------------------------------------------

/** 「성재의 Claude Code는」 처럼 주제 조사를 붙인다. */
function withTopic(name: string): string {
  return `${name}${particleFor(name, "topic")}`;
}

/**
 * 비소유자가 구독 에이전트를 멘션한 뒤 타임라인에 보이는 안내(나만 보여요).
 * 비소유자가 아니거나 구독 에이전트가 아니면 null. 팀 에이전트가 없으면 앞 문장만.
 */
export function nonOwnerNotice(
  c: AiAgentClassification,
  agentName: string,
  teamAgentName?: string | null
): string | null {
  if ((c.brain !== "subscription" && c.brain !== "personal_key") || c.ownership !== "other") return null;
  const owner = ownerRef(c);
  const what = c.brain === "personal_key" ? "개인 키라서" : "개인 구독이라";
  const first = `${withTopic(agentName)} ${owner} ${what} ${owner}만 부를 수 있어요.`;
  const team = cleanName(teamAgentName);
  if (!team) return first;
  return `${first} 팀 키로 답하는 @${team}에게 물어보거나, ${owner}에게 부탁해 보세요.`;
}

/** 작성 중 composer 위 한 줄에서 가장 먼저 읽혀야 하는 말(큰 글자에서 꼬리가 잘려도 남는다). */
export const COMPOSER_WILL_NOT_ANSWER = "보내도 답하지 않아요.";

/**
 * 작성 중 composer 위 한 줄. 비소유자일 때만.
 * `essentialFirst`: 큰 글자에서 두 줄에 안 드는 폰용 — 「보내도 답하지 않아요」를 문장 앞으로 올린다.
 */
export function nonOwnerComposerNotice(
  c: AiAgentClassification,
  agentName: string,
  essentialFirst = false
): string | null {
  if ((c.brain !== "subscription" && c.brain !== "personal_key") || c.ownership !== "other") return null;
  const why = `${withTopic(agentName)} ${ownerRef(c)}만 부를 수 있어요.`;
  return essentialFirst ? `${COMPOSER_WILL_NOT_ANSWER} ${why}` : `${why} ${COMPOSER_WILL_NOT_ANSWER}`;
}

/** 구독 에이전트의 맥이 꺼져 있을 때. 어떤 경우에도 팀 키로 대신한다고 하지 않는다. */
export function hostOfflineNotice(c: AiAgentClassification): string | null {
  if (c.brain !== "subscription" || c.hostOnline !== false || c.unavailableReason !== null) return null;
  const whose = c.ownership === "mine" ? "내 맥이" : `${ownerRef(c)} 맥이`;
  return `${whose} 꺼져 있어요. 켜지면 답해요. 팀 키로 대신하지 않아요.`;
}

// ---------------------------------------------------------------------------
// 에이전트 기본 이름 (결재 2026-10-03, 플랜 §10-2)
// ---------------------------------------------------------------------------

/** 서버 `DISPLAY_NAME_MAX`(문자 수)와 같다. 기본 이름이 그 한도를 넘지 않게 한다. */
const NAME_MAX_CHARS = 100;

function nameToken(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "-")
    .replace(/\p{Cc}/gu, "");
}

export interface DefaultAgentNameInput {
  /** 만드는 사람의 표시 이름. */
  displayName: string;
  harness: AiHarness;
  /** 이미 쓰는 이름·핸들 전부. 대소문자는 가리지 않는다. */
  takenNames: readonly string[];
  /** 이 맥의 기기 이름. `multipleDevices` 일 때만 쓴다. */
  deviceName?: string | null;
  /** 이 사람이 에이전트를 만든 맥이 여러 대인가. */
  multipleDevices?: boolean;
}

/**
 * `<표시이름>-claude` / `-codex`. 맥이 여러 대면 뒤에 `-<기기이름>`. 겹치면 `-2`, `-3`.
 * 만들기 전에 사용자가 고칠 수 있는 기본값일 뿐이고, 최종 검증은 서버 몫이다.
 */
export function defaultAgentName(input: DefaultAgentNameInput): string {
  const who = nameToken(input.displayName) || "me";
  const kind = input.harness === "codex" ? "codex" : "claude";
  const device = input.multipleDevices ? nameToken(input.deviceName) : "";
  const tail = device ? `-${kind}-${device}` : `-${kind}`;

  // 한도에 걸리면 표시이름 쪽을 깎는다. 꼬리(종류·기기)가 이름의 뜻이다.
  // `-99` 같은 중복 번호가 붙을 자리 5자를 남긴다.
  const roomForWho = Math.max(1, NAME_MAX_CHARS - [...tail].length - 5);
  const base = `${[...who].slice(0, roomForWho).join("")}${tail}`;

  const taken = new Set(input.takenNames.map((name) => name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------------------
// 옛 말 → 새 말 (AIH-10 grep 게이트의 입력)
// ---------------------------------------------------------------------------

export interface LegacyTermEntry {
  /** 사용자에게 보이는 글에서 없애거나 바꿀 말. */
  old: string;
  /** 대신 쓸 말. */
  next: string;
  /**
   * true: 사용자에게 보이는 글에 이 글자열이 있으면 그대로 위반(grep 게이트 대상).
   * false: 새 문구도 같은 글자를 쓰거나(「팀 키」, 「개인 구독」), 다른 뜻으로 흔히 쓰여서
   * 글자 검사로는 판정할 수 없다. 사람이 문맥으로 본다.
   */
  grepGate: boolean;
  note?: string;
}

// design-preflight-allow: 옛 말을 정의하는 표. 게이트(design_preflight_ast.mjs loadLegacyTerms)의 정본이라 옛 말 글자가 여기 있어야 한다(#3445)
export const LEGACY_TERM_MAP: readonly LegacyTermEntry[] = [
  { old: "AI 연결", next: "AI", grepGate: true, note: "허브 이름으로 흡수" },
  { old: "합류", next: "만들기 · 초대", grepGate: true, note: "합류시키기 포함. 화면에서 쓰지 않아요" },
  { old: "호스티드 에이전트", next: "에이전트", grepGate: true },
  { old: "구독 에이전트", next: "에이전트", grepGate: true, note: "쓰는 AI 열이 내 구독을 말해요" },
  { old: "owner_only", next: "부를 수 있는 사람", grepGate: true, note: "코드·API 값은 유지, 화면 문구만" },
  { old: "오너 전용", next: "부를 수 있는 사람", grepGate: true },
  { old: "소유자 전용", next: "부를 수 있는 사람", grepGate: true },
  { old: "본인 1인", next: "부를 수 있는 사람", grepGate: true },
  { old: "과금", next: "비용", grepGate: true },
  { old: "사용량 소스", next: "비용", grepGate: true },
  { old: "팀 연결", next: "팀 AI 키", grepGate: true },
  { old: "팀 API 키", next: "팀 AI 키", grepGate: true },
  { old: "팀 기본", next: "기본 AI", grepGate: true },
  { old: "운영자 설정", next: "팀 AI 키", grepGate: true },
  { old: "앱 명령", next: "기본 AI (기능 이름은 평문)", grepGate: true },
  { old: "원격 작업 기본 계정", next: "기본 AI (기능 이름은 평문)", grepGate: true },
  { old: "팀 에이전트 대답", next: "기본 AI (기능 이름은 평문)", grepGate: true },
  { old: "로컬 터미널 새 세션", next: "기본 AI (기능 이름은 평문)", grepGate: true },
  { old: "로컬 터미널 기본 로그인", next: "내 AI 계정", grepGate: true },
  { old: "구독 추가", next: "내 AI 계정", grepGate: true },
  { old: "1회용 연결 값", next: "외부 에이전트 연결", grepGate: true, note: "발급 화면에서만 사용" },
  { old: "오너", next: "소유자", grepGate: true, note: "워크스페이스 역할 이름은 화면에서 「소유자」로 써요" },
  { old: "구독 붙이기", next: "에이전트 만들기", grepGate: true },
  { old: "owner·admin", next: "소유자·관리자", grepGate: true, note: "한글 문장 안의 영문 역할 이름" },
  { old: "뿌리", next: "서명 기기", grepGate: true, note: "서명을 맡는 맥은 「서명 기기」로 써요(#3573)" },
  { old: "붙인 세션", next: "QR로 연결한 로그인", grepGate: true },
  { old: "내 계정", next: "내 AI 계정", grepGate: false, note: "프로필 화면의 「내 계정」과 겹쳐요" },
  { old: "이 맥", next: "내 AI 계정", grepGate: false, note: "「이 맥의 Claude Code」 같은 정상 문장이 있어요" },
  { old: "구독", next: "내 AI 계정 · 내 구독", grepGate: false, note: "새 문구도 「내 구독」을 써요" },
  { old: "개인 구독", next: "내 AI 계정", grepGate: false, note: "남의 구독을 말하는 새 문구가 이 글자를 써요" },
  { old: "내 설정", next: "내 AI 계정", grepGate: false },
  { old: "팀 키", next: "팀 AI 키", grepGate: false, note: "멘션 칩 「팀 키」는 새 문구예요" },
  { old: "로그인", next: "내 AI 계정 (Claude Code로 로그인)", grepGate: false, note: "단독 사용만 바꿔요" },
  { old: "봇", next: "에이전트", grepGate: false, note: "「호스티드 봇 초대」 이름은 유지해요" },
  { old: "웹훅", next: "채널로 들어오는 주소", grepGate: false, note: "상세 화면 괄호 안은 허용" },
  { old: "이벤트 구독", next: "밖으로 보내는 알림", grepGate: false, note: "상세 화면 괄호 안은 허용" },
  { old: "에이전트 자격", next: "외부 에이전트 연결", grepGate: false, note: "상세 화면 괄호 안은 허용" },
  { old: "MCP", next: "외부 에이전트 연결", grepGate: false, note: "외부 에이전트 연결 상세 괄호 안에서만" },
  { old: "Agent Port", next: "외부 에이전트 연결", grepGate: false, note: "외부 에이전트 연결 상세 괄호 안에서만" },
];

/**
 * 글에 남은 옛 말(grepGate 항목만)을 찾는다. AIH-10 의 게이트가 쓰고, 이 모듈의
 * 새 문구가 옛 말을 되살리지 않는다는 시험이 쓴다.
 */
export function findLegacyTerms(text: string): LegacyTermEntry[] {
  return LEGACY_TERM_MAP.filter((entry) => entry.grepGate && text.includes(entry.old));
}

// ---------------------------------------------------------------------------
// 허브 구획과 주소 (AIH-3, #3393, 플랜 §1·§7)
// ---------------------------------------------------------------------------

export type AiHubSectionId = "accounts" | "teamKeys" | "agents" | "external";

export interface AiHubSection {
  id: AiHubSectionId;
  /** 허브 안 상대 주소가 아니라 앱의 절대 주소(해시 라우터 기준). */
  path: string;
  /** 용어집 이름. 화면의 제목이다. */
  glossaryId: AiGlossaryId;
  /** ⌘K 항목의 검색 낱말. */
  keywords: readonly string[];
}

export const AI_HUB_PATH = "/ai";

export const AI_HUB_SECTIONS: readonly AiHubSection[] = [
  { id: "accounts", path: "/ai/accounts", glossaryId: "myAiAccount", keywords: ["구독", "로그인", "claude", "codex", "api 키"] },
  { id: "teamKeys", path: "/ai/team-keys", glossaryId: "teamAiKey", keywords: ["팀", "api 키", "기본 ai", "운영자"] },
  { id: "agents", path: "/ai/agents", glossaryId: "agent", keywords: ["에이전트", "비용", "부를 수 있는 사람"] },
  { id: "external", path: "/ai/external", glossaryId: "externalConnection", keywords: ["앱", "웹훅", "이벤트", "mcp", "외부"] },
];

export function aiHubSection(id: AiHubSectionId): AiHubSection {
  const found = AI_HUB_SECTIONS.find((section) => section.id === id);
  if (!found) throw new Error(`unknown AI hub section: ${id}`);
  return found;
}

/** 옛 입구(설정 섹션 id)가 옮겨 간 허브 구획. 설정 쪽의 한 줄 링크가 쓴다. */
export const AI_HUB_FROM_SETTINGS: Readonly<Record<string, AiHubSectionId>> = {
  ai: "accounts",
  agents: "external",
  plugins: "external",
  webhooks: "external",
  events: "external",
};

/** 허브 화면과 옛 입구의 안내 문구 (플랜 §7). */
export const AI_HUB_NAV_COPY = {
  movedToHub: "AI 화면으로 옮겼어요",
  movedToHubAction: "AI에서 열기",
  agentsPageLine: "설정·권한·비용은 AI 화면에서",
  openAiAction: "AI에서 열기",
  tabsLabel: "AI 구획",
  overviewTab: "개요",
  paneNote: "이 화면은 지금 있는 설정을 그대로 보여줘요. 곧 이 자리에 맞게 다시 짜요.",
} as const;

/** 허브 개요 카드의 문구. 숫자가 없으면 없다고 말하고 0으로 채우지 않는다. */
export const AI_HUB_OVERVIEW_COPY = {
  cardBadge: {
    accounts: "나만 써요",
    teamKeys: "팀이 같이 써요",
  },
  openLink: {
    accounts: "내 AI 계정 열기",
    teamKeys: "팀 AI 키 열기",
    agents: "에이전트 열기",
    external: "외부 연결 열기",
  },
  chip: {
    ready: "준비됨",
    loginNeeded: "로그인 필요",
    notInstalled: "설치 안 됨",
    unknown: "확인 못 했어요",
    checking: "확인하는 중이에요",
    connected: "연결됨",
    notConnected: "아직 없어요",
    desktopOnly: "로그인은 데스크탑 앱에서 해요",
    operatorOnly: "소유자·관리자만 볼 수 있어요",
    readFailed: "읽지 못했어요",
    onlyMe: "나만 부름",
    everyone: "모두 부름",
    kindUnknown: "쓰는 AI를 아직 몰라요",
  },
  /** 팀 키 연결 종류. 서버가 알려준 와이어 이름일 때만 쓴다. */
  providerLabel: {
    anthropic: "Anthropic",
    openai: "OpenAI",
  },
  nextAction: {
    loginNeeded: "Claude Code 구독을 채널에서 @로 부르려면 먼저 「내 AI 계정」에서 로그인하세요. 로그인하면 바로 이어서 에이전트로 만들 수 있어요.",
    goAccounts: "내 AI 계정으로 가기",
  },
  webNote: "웹에서도 같은 화면이 열려요. 로그인이 필요한 줄만 「데스크탑 앱에서 해요」로 바뀌어요.",
  createAgent: "에이전트 만들기",
  count: {
    people: (n: number) => `${n}명`,
    items: (n: number) => `${n}개`,
  },
} as const;

// ---------------------------------------------------------------------------
// 내 AI 계정 구획 (AIH-4, #3399)
// ---------------------------------------------------------------------------

export const AI_HUB_ACCOUNTS_COPY = {
  /** 데스크탑 머리 아래 한 줄(시안 2-a). */
  desktopSubtitle: "이 맥에 로그인한 구독이에요. 나만 쓰고, 로그인은 각 회사의 공식 CLI가 해요.",
  /** 웹 머리 아래 한 줄(시안 2-b). */
  webSubtitle: "웹에서는 보기만 해요.",
  subscriptionHead: "구독",
  subscriptionScope: "이 맥",
  /** 구독 줄 옆 연결된 에이전트가 없을 때. */
  noAgent: "아직 에이전트 없음",
  /** 웹: 로그인은 못 하지만 길이 있다(막다른 길 금지). */
  web: {
    getApp: "데스크탑 앱 받기",
    openApp: "이미 설치했어요: oort 앱 열기",
    myAgentsHead: "내가 만든 에이전트",
    myAgentsScope: "서버에 있는 것만 보여요",
    myAgentsEmpty: "아직 만든 에이전트가 없어요.",
    myAgentsLoading: "에이전트를 불러오는 중이에요.",
    myAgentsFailed: "에이전트를 불러오지 못했어요.",
    apiKeyNote: "API 키는 웹에 저장하지 않아요.",
  },
  /** 폰: 같은 상태를 작게. */
  phone: {
    myAgentsHead: "내가 만든 에이전트",
    apiKeyNote: "API 키는 폰에 저장하지 않아요.",
  },
} as const;

/** 데스크탑 앱을 받는 곳과 이미 설치한 앱을 여는 주소(`oort` 스킴은 tauri.conf.json deep-link). */
export const AI_HUB_DESKTOP_APP = {
  downloadUrl: "https://github.com/yeomyeonggeori/oort/releases/latest",
  openUrl: "oort://open",
} as const;

/** 구독 줄 옆의 「에이전트 @이름」 또는 「아직 에이전트 없음」. */
export function subscriptionAgentText(agentName: string | null | undefined): string {
  const name = cleanName(agentName)?.replace(/^@/, "") ?? null;
  return name ? `에이전트 @${name}` : AI_HUB_ACCOUNTS_COPY.noAgent;
}

export type SubscriptionAgentTone = "ok" | "neutral";

export interface SubscriptionAgentStatus {
  /** 줄 오른쪽 칩. 에이전트가 없으면 null. */
  chip: { text: string; tone: SubscriptionAgentTone } | null;
  /** 칩으로 못 담는 설명 한 줄. 없으면 null. */
  detail: string | null;
  /** 이 구독 에이전트를 지금 부를 수 있다고 말해도 되는가. */
  callable: boolean;
}

/**
 * Claude 구독 에이전트 대행 보수 모드 (#3397, 성재 2026-10-03). Anthropic 해석 답이 올 때까지
 * oort가 `claude -p`/ACP로 대신 구동하는 @내-claude는 「회색 · 문의 중」이다. 오류가 아니다.
 * 서버가 대행을 명시적으로 켠 값(`claudeDriveEnabled === true`)을 내려줄 때만 풀린다. 값이 없거나
 * 모르면 보수 모드다(AIH-2 전에는 서버 필드가 없다). Codex는 영향이 없다.
 * 내 작업의 직접 PTY 로그인은 이 상태와 무관하다.
 */
export function subscriptionAgentStatus(
  harness: AiHarness,
  hasAgent: boolean,
  opts: { claudeDriveEnabled?: boolean | null } = {}
): SubscriptionAgentStatus {
  if (harness === "claude_code" && opts.claudeDriveEnabled !== true) {
    return {
      chip: hasAgent ? { text: "문의 중", tone: "neutral" } : null,
      detail:
        "Anthropic에 확인하는 중이라 oort가 Claude Code 구독으로 에이전트를 대신 구동하지 않아요. 내 맥 터미널의 로그인은 그대로 써요.",
      callable: false,
    };
  }
  return {
    chip: hasAgent ? { text: "나만 부름", tone: "ok" } : null,
    detail: null,
    callable: hasAgent,
  };
}

export interface MySubscriptionAgent {
  agentId: string;
  name: string;
  harness: AiHarness;
}

/**
 * 내가 만든 구독 에이전트: 명부의 에이전트 중 소유자가 나이고 호스티드 연결에 구독
 * 하니스가 적힌 것(끊긴 연결 제외). 소유자나 하니스를 모르면 넣지 않는다(남의 것을 내 줄에 올리지 않는다).
 * 같은 하니스에 여럿이면 이름순 첫 번째가 앞에 온다.
 */
export function mySubscriptionAgents(
  roster: ReadonlyArray<{ id: string; displayName: string; ownerHumanId?: string | null }>,
  connections: ReadonlyArray<{ agentMemberId: string; subscriptionHarness?: string | null; status?: string | null }>,
  viewerHumanId: string | null | undefined
): MySubscriptionAgent[] {
  const viewer = cleanName(viewerHumanId);
  if (!viewer) return [];
  const harnessByAgent = new Map<string, AiHarness>();
  for (const conn of connections) {
    // 끊겼거나 정리 중인 연결의 에이전트는 내 줄에 올리지 않는다.
    if (conn.status === "disconnected" || conn.status === "cleanup_pending") continue;
    const harness = toHarness(conn.subscriptionHarness);
    if (harness) harnessByAgent.set(conn.agentMemberId.toLowerCase(), harness);
  }
  const found: MySubscriptionAgent[] = [];
  for (const agent of roster) {
    const owner = cleanName(agent.ownerHumanId);
    const harness = harnessByAgent.get(agent.id.toLowerCase());
    if (!owner || !harness || !sameId(owner, viewer)) continue;
    found.push({ agentId: agent.id, name: agent.displayName, harness });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

// ---------------------------------------------------------------------------
// 작성 중 composer 위 한 줄: Claude 구독 대행이 쉬는 중일 때 (AIH-9, #3439)
// ---------------------------------------------------------------------------

/**
 * 서버가 「Claude 구독 대행은 확인 전까지 쉰다」(`brain_unavailable_reason`)고 알린 에이전트를
 * 부르는 글을 쓰는 중에 composer 위에 올리는 한 줄. 소유자든 아니든 같다: 이 에이전트는 지금
 * 아무에게도 답하지 않는다. 사유가 없으면 null. 팀 키로 대신 답한다고 말하지 않는다.
 */
export function pausedComposerNotice(
  c: AiAgentClassification,
  agentName: string,
  essentialFirst = false
): string | null {
  if (c.unavailableReason !== CLAUDE_SUBSCRIPTION_AGENT_PAUSED) return null;
  const why = `${withTopic(agentName)} Claude 구독 대행이 Anthropic 약관 확인 전까지 쉬고 있어요.`;
  return essentialFirst ? `${COMPOSER_WILL_NOT_ANSWER} ${why}` : `${why} ${COMPOSER_WILL_NOT_ANSWER}`;
}
