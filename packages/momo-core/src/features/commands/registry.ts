// =============================================================================
// 클라이언트 명령 레지스트리 — 정의는 한 곳, 소비자는 여럿 (ADR-0186 D1).
//
// ⌘K 팔레트의 「이동」·「만들기」·「에이전트 설정」 항목은 각자 자기 자리에서
// `go("/inbox")`처럼 **손으로** 적혀 있었다. 그래서 같은 행동에 이름이 둘
// 생기고(사이드바와 팔레트), 단축키 정본(`keyboardShortcuts.ts`)이 「⌘⇧A는
// 인박스」라고 말하는 동안 팔레트는 그 사실을 모른 채 자기 줄을 그렸다. 에이전트
// 카탈로그(AX-3a)가 같은 어휘를 써야 하는 시점이 오면 그 손복사는 세 갈래가 된다.
//
// 그래서 정의를 여기로 올린다. **한 명령 = 한 정의**이고, 소비자는 그 정의를
// 읽을 뿐 다시 적지 않는다:
//
//   ① ⌘K 팔레트 — 이 파일의 `visibleCommands()`를 map해서 「명령」 그룹을 그린다.
//   ② 단축키 정본 — `Command.shortcutId` ↔ `KeyboardShortcut.paletteCommandId`가
//      서로를 가리키고, 웹의 드리프트 가드 시험이 양방향 존재를 강제한다.
//   ③ D6 `command_suggest` 카드(AX-5) — 에이전트가 보낸 `command_id`를 이 표에서
//      찾고, 없으면 본문으로 폴백한다.
//
// ## 여기 없는 것
//
// **워크스페이스를 바꾸는 행동**(초대·웹훅·채널 생성·역할)은 이 표가 아니라
// Rust `actions.rs`가 정본이다(ADR-0186 D1 전반, D3 risk=`approval`). 그쪽은
// 승인 카드를 거쳐 서버가 결정자 권한으로 실행한다. 이 파일의 명령은 전부
// **서버 상태를 바꾸지 않는다**(risk none): 표면으로 이동하거나, 폼을 열거나,
// 이 기기의 외양을 바꾼다. 서버 카탈로그를 읽는 자리는 `serverActions.ts`이고
// 실제 fetch·병합은 AX-4가 붙인다.
//
// **플랫폼도 여기 없다.** 이 패키지는 `scripts/purity.mjs`가 지키는 순수 TS라
// `requestAnimationFrame`·`localStorage`·React가 들어올 수 없다. 그래서 명령은
// 「무엇을 한다」만 말하고(`run(ctx)`), 「어떻게」는 호출자가 `CommandContext`로
// 넣는다 — 팔레트가 폼을 한 프레임 뒤에 여는 이유(포커스 스코프 겹침)나 설정
// 복귀 지점을 기억하는 규율은 웹 쪽 배선에 남는다. 아이콘도 이름(`CommandIcon`)
// 으로만 오간다: 렌더는 클라이언트의 일이다.
// =============================================================================

import { serverSurface, type SurfaceId } from "../capabilities/serverSurfaces";
import { attachDirection } from "../../lib/koreanParticle";
import { WORK_CONSOLE_VIEW_PATH } from "../workbench/workTab";
import { AI_HUB_PATH, AI_HUB_SECTIONS, glossaryEntry } from "../ai/aiHubModel";

/**
 * 팔레트가 명령을 묶는 갈래.
 *
 * 화면의 머리글이 아니라 **분류**다. 팔레트는 이 티켓에서 갈래를 한 줄의
 * 「명령」 그룹으로 합쳐 랭킹 순으로 그린다(ADR-0186 D1). 갈래가 남아 있는 것은
 * 카탈로그 소비자(AX-3a·AX-5)가 「이동」과 「설정 변경」을 구분해야 하기
 * 때문이다.
 */
export type CommandGroup = "navigate" | "create" | "settings" | "agent";

/**
 * 명령이 무엇을 건드리는가 (ADR-0186 D3 risk `none`의 두 갈래).
 *
 * - `navigate` — 표면으로 데려가거나 폼을 연다. 아무 상태도 바꾸지 않는다.
 * - `client` — 이 기기의 값을 바꾼다(외양·밀도, ADR-0174 D3). 서버는 모른다.
 *
 * 첫 `client` 명령은 `ai.connect`다(#2943, 채팅 연결 카드 GC-2). 서버를 바꾸지
 * 않고 **이 기기·이 채널 화면에만** 붙는 로컬 카드를 연다 — 메시지가 아니므로
 * 새로고침·채널 이동에 사라진다(brief §3.2). 카드를 붙일 자리가 없으면 설정 ›
 * AI 연결로 간다. 테마 명령(AX-5 #2511)이 같은 갈래에 들어온다.
 */
export type CommandKind = "navigate" | "client";

/**
 * 로컬 카드의 이름 (#2943 GC-2 계약, 카드 본체는 GC-3 #2944).
 *
 * 코어는 「이 카드를 열어 달라」만 말한다. 카드가 **어디에** 붙는지(지금 보고
 * 있는 채널의 타임라인 꼬리)와 붙일 자리가 있는지는 웹이 안다.
 */
export type LocalCardId = "ai.connect";

/** AI 계정 카드에서 펼쳐 둘 줄. `/연결 claude`·`/연결 codex`·`/연결 팀키`. */
export type AiConnectLine = "claude" | "codex" | "team";

/**
 * 명령·카드에 실리는 인자. **의도만** 싣는다: 상태도 비밀값도 여기 없다(brief
 * §0-3). 키는 카드의 입력 칸에서만 받고, 슬래시 인자로는 받지 않는다(GC-1이
 * 키 모양을 보면 전송 자체를 막는다).
 */
export interface LocalCardArgs {
  readonly line?: AiConnectLine;
}

/**
 * 아이콘의 **이름**. 코어는 React를 import할 수 없으므로(purity 게이트) 이름만
 * 건네고 클라이언트가 자기 아이콘 세트로 푼다.
 */
export type CommandIcon =
  | "inbox"
  | "drafts"
  | "activity"
  | "members"
  | "settings"
  | "credentials"
  | "work-console"
  | "workstreams"
  | "create-channel"
  | "agent"
  | "ai-connect"
  | "ai-hub"
  | "sidebar";

/** 명령이 알아야 하는 나 자신. 지금은 멤버 id 하나면 충분하다. */
export interface CommandSession {
  readonly memberId: string;
}

/**
 * 명령이 바깥 세계에 닿는 유일한 통로.
 *
 * 플랫폼 호출은 전부 여기 들어온다. 팔레트는 `navigate`에 자기 `go()`를 넣어
 * 설정 복귀 지점 기억·중복 히스토리 방지를 유지하고, 폼 두 개는 한 프레임 뒤에
 * 열리는 자기 규율을 그대로 쥔 채 넣는다.
 */
export interface CommandContext {
  readonly navigate: (path: string) => void;
  readonly openCreateChannel: () => void;
  readonly openAgentProfile: (memberId: string) => void;
  readonly session: CommandSession;
  readonly workspaceId: string;
  /**
   * 로컬 카드를 연다(#2943). 붙일 자리(지금 보고 있는 채널의 카드 자리)가
   * 있어서 **열었으면 true**, 없으면 false다. false를 받은 명령은 스스로 폴백한다
   * — `ai.connect`는 AI로 간다. 카드 자리가 아직 없는 클라이언트는
   * 언제나 false를 돌려주면 된다(GC-3 전의 웹, 폰).
   */
  readonly openLocalCard: (card: LocalCardId, args: LocalCardArgs) => boolean;
  /**
   * 데스크탑 셸인가(#2854). 데스크탑의 `/work`는 「내 작업」 격자라 작업 콘솔은
   * `/work?view=console`에 산다. 없으면 웹으로 읽는다.
   */
  readonly desktop?: boolean;
  /**
   * 탐색 패널(목록 열)을 접고 펴고, **바뀐 뒤의 접힘**(접혔으면 true)을 돌려준다(#3299).
   *
   * **선택 능력이다.** 접을 목록 열이 있는 클라이언트(웹·데스크탑 셸)만 넣는다. 폰은
   * 넣지 않는다 — 접을 열이 없다. 없으면 `view.sidebar`는 `CommandEnv.sidebarList`도
   * 없어 **표 자체에서 빠지므로** 폰에서 깨진 줄이 아니라 줄이 없는 것이다.
   */
  readonly toggleSidebarList?: () => boolean;
}

/**
 * 명령을 실행한 결과.
 *
 * `status`는 ADR-0182 ②가 말하는 팔레트 하단 한 줄이다. `closesSurface`가 참인
 * 명령은 실행과 동시에 표면이 닫히므로 그 한 줄은 **닫히는 동안** 낭독되고 함께
 * 사라진다(같은 ADR의 「표면이 닫히면 함께 소거」). 3s 동안 보이는 줄은 표면을
 * 열어 둔 채 끝나는 명령의 것이고, 그런 명령은 AX-5가 처음 들여온다.
 */
export interface CommandResult {
  readonly status: string | null;
  readonly closesSurface: boolean;
}

export interface Command {
  readonly id: string;
  /** 줄에 그려지는 이름. **목적지가 쓰는 말** 그대로다(팔레트 어휘 계승 규칙). */
  readonly title: string;
  /** 이름 옆의 작은 글씨(에이전트 핸들 등). 없으면 그리지 않는다. */
  readonly meta?: string;
  readonly group: CommandGroup;
  readonly kind: CommandKind;
  /** `keyboardShortcuts.ts`의 `KeyboardShortcut.id`. 시험이 실존을 강제한다. */
  readonly shortcutId?: string;
  /** 이름으로 못 찾을 때 걸리는 별칭. cmdk의 `value`에 함께 실린다. */
  readonly keywords: readonly string[];
  readonly icon: CommandIcon;
  /** 이 줄의 `data-testid`. 캡처 장면·진입점 시험이 부르는 이름이다. */
  readonly testId: string;
  /** 에이전트별 명령만 갖는다. 줄의 `data-member-id`가 된다. */
  readonly memberId?: string;
  /**
   * 에이전트가 이 명령을 **카드로 제안할 수 있는가** (ADR-0186 증보 G2).
   *
   * 참인 명령만 `momo.command_suggest` 카드가 될 수 있다. 서버 허용목록
   * (`momo_agent::card_suggest::SUGGESTABLE_COMMANDS`)과 같은 집합이어야 하고,
   * 두 언어가 만나는 자리는 OpenAPI `SuggestableCommandId`다 — 웹
   * `app/commandRegistry.test.ts`가 이 표와 그 enum을 잰다. `kind: "client"`
   * 명령에만 붙는다(서버 상태를 바꾸지 않는 명령만 제안 카드가 된다).
   */
  readonly agentSuggestable?: true;
  /**
   * 컴포저 맨 앞 `/`로 부르는 이름(#2942 GC-1). `client` 명령만 가질 수 있다.
   * 없으면 슬래시 목록에 서지 않는다.
   */
  readonly slash?: SlashSpec;
  /** `args`는 슬래시 인자처럼 **의도만** 담는다. 팔레트는 넘기지 않는다. */
  readonly run: (ctx: CommandContext, args?: LocalCardArgs) => CommandResult;
}

/** 슬래시 인자 한 줄. `/연결 claude`의 `claude`. */
export interface SlashArg {
  /** 목록에 그려지는 인자 이름. */
  readonly value: string;
  /** 같은 인자를 부르는 다른 이름(대소문자 무시). */
  readonly aliases: readonly string[];
  /** 목록 줄 아래 흐린 설명. */
  readonly hint: string;
  readonly icon: CommandIcon;
  /** 이 인자가 명령에 싣는 의도. */
  readonly args: LocalCardArgs;
}

/** 슬래시로 부르는 명령의 이름표. */
export interface SlashSpec {
  /** 정본 이름(`/` 없이). */
  readonly name: string;
  /** 별칭(`/` 없이). 정본과 같은 명령을 연다. */
  readonly aliases: readonly string[];
  /** 목록 줄 아래 흐린 설명. 카드 자리가 있을 때의 말이다. */
  readonly hint: string;
  /**
   * 카드 자리가 **없을 때**의 설명(#2943 design-review H-1). 그때 명령은 설정으로
   * 폴백하므로 「나에게만 보여요」·「줄만 펼쳐」를 약속하지 않는다. 팔레트 줄의
   * `metaFor`와 같은 판정(`canOpenLocalCard`)을 따른다.
   */
  readonly fallbackHint: string;
  readonly args: readonly SlashArg[];
}

/** 지금 이 워크스페이스에서 무엇이 보일 수 있는가. */
export interface CommandAgent {
  readonly id: string;
  readonly displayName: string;
  readonly handle: string;
}

export interface CommandEnv {
  /** 초안 패널이 내비에 서 있는가. */
  readonly showDrafts: boolean;
  /** 지금 이 사람이 채널을 만들 수 있는가(사이드바 +와 같은 판정). */
  readonly canCreateChannel: boolean;
  /** 이 서버가 그 표면을 싣고 있는가(`capabilities/serverSurfaces`). */
  readonly isSurfaceProvided: (id: SurfaceId) => boolean;
  /** 라우팅을 열 수 있는 활성 에이전트. */
  readonly agents: readonly CommandAgent[];
  /**
   * 지금 이 카드를 붙일 자리가 있는가(#2943). 줄의 작은 글씨가 이 답을 따른다:
   * 자리가 있으면 「이 채널 · 나에게만」, 없으면 「AI에서 열려요」. 누르면
   * 무엇이 일어나는지를 줄이 거짓 없이 말하게 한다.
   */
  readonly canOpenLocalCard: (card: LocalCardId) => boolean;
  /**
   * 접을 탐색 패널이 있는가, 있다면 지금 접혀 있는가(#3299). **없으면(undefined)
   * 그 명령이 서지 않는다** — `CommandContext.toggleSidebarList`와 짝이다. 줄의 이름이
   * 지금 상태를 따른다(접혀 있으면 「열기」).
   */
  readonly sidebarList?: { readonly collapsed: boolean };
}

interface StaticCommand extends Command {
  /** 이 명령이 지금 보이는가. 표에 남아 있으나 조건이 거짓이면 그리지 않는다. */
  readonly available: (env: CommandEnv) => boolean;
  /** 환경에 따라 바뀌는 작은 글씨. 있으면 `meta`보다 앞선다. */
  readonly metaFor?: (env: CommandEnv) => string;
  /** 환경에 따라 바뀌는 이름. 있으면 `title`보다 앞선다(#3299 「접기/열기」). */
  readonly titleFor?: (env: CommandEnv) => string;
}

/** 탐색 패널 접기 명령의 id. 단축키 정본(`toggle-sidebar`)의 `paletteCommandId`가 가리킨다. */
export const TOGGLE_SIDEBAR_COMMAND_ID = "view.sidebar";

function sidebarTitle(collapsed: boolean): string {
  return collapsed ? "탐색 패널 열기" : "탐색 패널 접기";
}

/** AI 허브 › 내 AI 계정의 주소(AIH-3). 카드와 폴백과 이동 명령이 같은 자리를 가리킨다. */
export const AI_CONNECT_HUB_PATH = "/ai/accounts";

/** 허브 화면의 이름. */
const AI_CONNECT_HUB_LABEL = "AI";

const AI_CONNECT_LINES: ReadonlySet<string> = new Set<AiConnectLine>([
  "claude",
  "codex",
  "team",
]);

/** 인자에서 알려진 의도만 남긴다. 모르는 키는 카드에 가지 않는다. */
function aiConnectArgs(args: LocalCardArgs | undefined): LocalCardArgs {
  const line = args?.line;
  return line !== undefined && AI_CONNECT_LINES.has(line) ? { line } : {};
}

/**
 * `ai.connect` 실행(#2943 GC-2).
 *
 * 카드를 붙일 자리가 있으면 거기 연다. 없으면(채널 밖, 또는 카드 본체 GC-3
 * 전) AI로 간다. 어느 쪽이든 표면(팔레트)은 닫힌다.
 */
function runAiConnect(ctx: CommandContext, args?: LocalCardArgs): CommandResult {
  if (ctx.openLocalCard("ai.connect", aiConnectArgs(args))) {
    return { status: "AI 계정 카드 열기", closesSurface: true };
  }
  ctx.navigate(AI_CONNECT_HUB_PATH);
  return {
    status: `${attachDirection(AI_CONNECT_HUB_LABEL)} 이동`,
    closesSurface: true,
  };
}

const always = (): boolean => true;

/**
 * 「어디로 간다」는 한 문장.
 *
 * 조사는 `attachDirection`이 정한다. 로/으로는 받침만으로 갈리지 않고(ㄹ은
 * 열린 음절처럼 로를 받는다 — 「작업 콘솔로」), 그 규칙은 이 저장소가 이미 한
 * 곳에 적어 둔 것이다(`lib/koreanParticle`). 여기서 손으로 적으면 「작업
 * 콘솔으로」가 나오는 날이 오고, 그날 고칠 자리는 두 곳이 된다.
 */
function navigateTo(path: string, title: string) {
  const status = `${attachDirection(title)} 이동`;
  return (ctx: CommandContext): CommandResult => {
    ctx.navigate(path);
    return { status, closesSurface: true };
  };
}

/**
 * 명령 표 (동적인 에이전트 라우팅 제외).
 *
 * 순서는 팔레트의 **바닥 순서**다. 랭킹(최근·빈도)이 그 위에 얹히고, 아무것도
 * 쓴 적 없는 사람은 이 순서를 본다.
 */
const STATIC_COMMANDS: readonly StaticCommand[] = [
  {
    id: "nav.inbox",
    title: "인박스",
    group: "navigate",
    kind: "navigate",
    shortcutId: "open-inbox",
    keywords: ["inbox"],
    icon: "inbox",
    testId: "switcher-inbox",
    available: always,
    run: navigateTo("/inbox", "인박스"),
  },
  {
    id: "nav.drafts",
    title: "초안",
    group: "navigate",
    kind: "navigate",
    keywords: ["drafts"],
    icon: "drafts",
    testId: "switcher-drafts",
    available: (env) => env.showDrafts,
    run: navigateTo("/drafts", "초안"),
  },
  {
    id: "nav.activity",
    title: "활동",
    group: "navigate",
    kind: "navigate",
    keywords: ["activity"],
    icon: "activity",
    testId: "switcher-activity",
    available: always,
    run: navigateTo("/activity", "활동"),
  },
  {
    // 멤버, the same word the sidebar row and the route's own h1 use. 옛 이름은
    // 별칭으로만 남아 「디렉터리」·「명부」를 쳐도 찾힌다 (R-1 어휘 계승).
    id: "nav.directory",
    title: "멤버",
    group: "navigate",
    kind: "navigate",
    keywords: ["디렉터리", "명부", "directory"],
    icon: "members",
    testId: "switcher-directory",
    available: always,
    run: navigateTo("/directory", "멤버"),
  },
  {
    id: "nav.settings",
    title: "설정",
    group: "navigate",
    kind: "navigate",
    shortcutId: "open-settings",
    keywords: ["settings"],
    icon: "settings",
    testId: "switcher-settings",
    available: always,
    run: navigateTo("/settings", "설정"),
  },
  {
    id: "nav.ai",
    title: "AI",
    group: "navigate",
    kind: "navigate",
    keywords: ["ai", "허브", "구독", "에이전트 비용", "연결"],
    icon: "ai-hub",
    testId: "switcher-ai",
    available: always,
    run: navigateTo(AI_HUB_PATH, "AI"),
  },
  ...AI_HUB_SECTIONS.map((section): StaticCommand => {
    const title = section.id === "agents" ? "AI 에이전트" : glossaryEntry(section.glossaryId).term;
    return {
      id: `nav.ai.${section.id}`,
      title,
      group: "navigate",
      kind: "navigate",
      keywords: ["ai", ...section.keywords],
      icon: "ai-hub",
      testId: `switcher-ai-${section.id}`,
      available: always,
      run: navigateTo(section.path, title),
    };
  }),
  {
    id: "nav.settings.agents",
    title: "에이전트 자격",
    group: "settings",
    kind: "navigate",
    keywords: ["설정", "연결", "hosted", "pairing"],
    icon: "credentials",
    testId: "switcher-settings-agents",
    available: always,
    run: navigateTo("/settings?section=agents", "에이전트 자격"),
  },
  {
    // 채팅 연결 카드의 입구(#2939 brief §3.1). 슬래시·⌘K·(2단계) 에이전트
    // 제안 카드의 「열기」가 모두 이 한 정의의 `run`을 부른다.
    id: "ai.connect",
    title: "AI 계정 카드 열기",
    group: "settings",
    kind: "client",
    keywords: ["연결", "connect", "ai", "구독", "api 키", "claude", "codex"],
    icon: "ai-connect",
    testId: "switcher-ai-connect",
    // ADR-0186 증보 G2 — 에이전트가 이 카드를 제안할 수 있다(서버 허용목록
    // `SUGGESTABLE_COMMANDS`와 OpenAPI `SuggestableCommandId`에 같은 id).
    agentSuggestable: true,
    available: always,
    metaFor: (env) =>
      env.canOpenLocalCard("ai.connect") ? "이 채널 · 나에게만" : "AI에서 열려요",
    slash: {
      name: "연결",
      aliases: ["connect", "ai"],
      hint: "AI 계정 카드 열기 · 나에게만 보여요",
      fallbackHint: "AI로 이동 · 메시지로 보내지 않아요",
      args: [
        {
          value: "claude",
          aliases: ["클로드"],
          hint: "Claude 구독 줄만 펼쳐 열기",
          icon: "ai-connect",
          args: { line: "claude" },
        },
        {
          value: "codex",
          aliases: ["코덱스"],
          hint: "Codex 구독 줄만 펼쳐 열기",
          icon: "ai-connect",
          args: { line: "codex" },
        },
        {
          value: "팀키",
          aliases: ["team", "팀"],
          hint: "팀 AI 키 줄만 펼쳐 열기 · 운영자",
          icon: "credentials",
          args: { line: "team" },
        },
      ],
    },
    run: runAiConnect,
  },
  {
    // 표면 이름은 판정표에서 든다. 진입점과 도착지가 각자 적으면 갈라진다.
    id: "nav.workConsole",
    title: serverSurface("workConsole").label,
    group: "navigate",
    kind: "navigate",
    keywords: ["work console"],
    icon: "work-console",
    testId: "switcher-work-console",
    available: (env) => env.isSurfaceProvided("workConsole"),
    // #2854·#3334: `/work`는 데스크탑에서 「내 작업」 격자, 웹에서 「내 작업」 설명 상태다.
    // 작업 콘솔은 어느 쪽이든 `?view=console`이다(사이드바 줄과 같은 주소).
    run: (ctx) =>
      navigateTo(WORK_CONSOLE_VIEW_PATH, serverSurface("workConsole").label)(ctx),
  },
  {
    id: "nav.workstreams",
    title: serverSurface("workstreams").label,
    group: "navigate",
    kind: "navigate",
    keywords: ["workstreams"],
    icon: "workstreams",
    testId: "switcher-workstreams",
    available: (env) => env.isSurfaceProvided("workstreams"),
    run: navigateTo("/workstreams", serverSurface("workstreams").label),
  },
  {
    // 목록 열 접기(#3299, #3280의 ⌘B). 접을 열이 있는 클라이언트만 `env.sidebarList`를
    // 넣는다 — 폰은 넣지 않아 줄이 없다. 이 기기의 외양을 바꾸는 `client` 명령이지만
    // `agentSuggestable`이 아니다: 에이전트가 사람의 패널을 접자고 카드로 조르는 것은
    // 가치가 없고, 제안 가능으로 올리면 서버 허용목록·OpenAPI enum까지 함께 움직여야 한다.
    id: TOGGLE_SIDEBAR_COMMAND_ID,
    title: sidebarTitle(false),
    group: "navigate",
    kind: "client",
    shortcutId: "toggle-sidebar",
    keywords: ["사이드바", "목록", "패널", "접기", "열기", "sidebar", "panel", "collapse", "toggle"],
    icon: "sidebar",
    testId: "switcher-toggle-sidebar",
    available: (env) => env.sidebarList !== undefined,
    titleFor: (env) => sidebarTitle(env.sidebarList?.collapsed === true),
    run: (ctx) => {
      if (ctx.toggleSidebarList === undefined) {
        return { status: null, closesSurface: false };
      }
      const collapsed = ctx.toggleSidebarList();
      return { status: sidebarTitle(!collapsed), closesSurface: true };
    },
  },
  {
    // 채널 만들기 has a seat because ⌘K is the house grammar for "every action
    // has a keyboard path" (SKILL §6). 서버에 묻지 않고 같은 함수로 판정하므로
    // 팔레트는 서버가 403으로 답할 것을 내놓지 않는다.
    id: "create.channel",
    title: "채널 만들기",
    group: "create",
    kind: "navigate",
    keywords: ["새 채널", "create channel"],
    icon: "create-channel",
    testId: "switcher-create-channel",
    available: (env) => env.canCreateChannel,
    run: (ctx) => {
      ctx.openCreateChannel();
      return { status: "채널 만들기 열기", closesSurface: true };
    },
  },
];

/**
 * 이름이 고정된 명령의 id 전부.
 *
 * 에이전트 라우팅처럼 **멤버마다 생기는** 명령은 여기 없다. 단축키의
 * `paletteCommandId`는 고정 명령만 가리킬 수 있고, 드리프트 가드가 그것을 이
 * 집합으로 잰다.
 */
export const KNOWN_COMMAND_IDS: readonly string[] = STATIC_COMMANDS.map(
  (command) => command.id
);

/**
 * 에이전트가 카드로 제안할 수 있는 고정 명령 (ADR-0186 증보 G2), 바닥 순서로.
 *
 * 멤버마다 생기는 명령은 여기 오지 않는다 — 제안은 서버 허용목록과 같은
 * 집합이어야 하고, 그 목록은 고정 id만 담는다. `kind`를 함께 내는 것은
 * 「`client` 명령만 제안 카드가 된다」를 시험이 잴 수 있게 하기 위해서다.
 */
export const AGENT_SUGGESTABLE_COMMANDS: readonly Pick<Command, "id" | "kind">[] =
  STATIC_COMMANDS.filter((command) => command.agentSuggestable === true).map(
    ({ id, kind }) => ({ id, kind })
  );

/** 에이전트 라우팅 명령의 id. 한 에이전트에 하나다. */
export function agentRoutingCommandId(memberId: string): string {
  return `agent.routing:${memberId}`;
}

/**
 * 에이전트 라우팅 명령 (R1 M7).
 *
 * 타임라인의 이름은 이제 이름일 뿐이라, 마우스 없이 이 다이얼로그에 닿는 길은
 * 디렉터리를 거치는 것뿐이었다. 팔레트가 그 길을 하나로 줄인다.
 */
export function agentRoutingCommands(
  agents: readonly CommandAgent[]
): readonly Command[] {
  return agents.map((agent) => ({
    id: agentRoutingCommandId(agent.id),
    title: `${agent.displayName} 라우팅`,
    meta: `@${agent.handle}`,
    group: "agent" as const,
    kind: "navigate" as const,
    keywords: [
      agent.displayName,
      agent.handle,
      "라우팅",
      "모델",
      "추론 강도",
      "routing model effort",
    ],
    icon: "agent" as const,
    testId: "switcher-agent-routing",
    memberId: agent.id,
    run: (ctx: CommandContext): CommandResult => {
      ctx.openAgentProfile(agent.id);
      return { status: `${agent.displayName} 라우팅 열기`, closesSurface: true };
    },
  }));
}

/** 지금 이 환경에서 팔레트가 그릴 수 있는 명령 전부, 바닥 순서로. */
export function visibleCommands(env: CommandEnv): readonly Command[] {
  const fixed = STATIC_COMMANDS.filter((command) => command.available(env)).map(
    ({ available: _available, metaFor, titleFor, ...command }) => ({
      ...command,
      ...(titleFor === undefined ? {} : { title: titleFor(env) }),
      ...(metaFor === undefined ? {} : { meta: metaFor(env) }),
    })
  );
  return [...fixed, ...agentRoutingCommands(env.agents)];
}

/**
 * 슬래시로 부를 수 있는 명령 전부(#2942). 컴포저 `/` 목록의 유일한 소스다.
 *
 * `client` 명령만 이름을 가질 수 있다: 슬래시로 연 명령은 **전송되지 않고**
 * 이 기기에서 끝나야 하므로(brief §3.1), 서버 상태를 바꾸는 명령이나 단순 이동은
 * 이 목록에 서지 않는다.
 */
export function slashCommands(): readonly Command[] {
  return STATIC_COMMANDS.filter(
    (command) => command.kind === "client" && command.slash !== undefined
  ).map(
    ({ available: _available, metaFor: _metaFor, titleFor: _titleFor, ...command }) =>
      command
  );
}

/**
 * cmdk가 거를 때 보는 문자열.
 *
 * id를 함께 싣는 이유는 두 가지다. 같은 이름의 명령이 둘 생겨도 cmdk의 값이
 * 겹치지 않고(에이전트 둘의 표시 이름이 같을 수 있다), 시험이 줄 하나를 값으로
 * 집을 수 있다.
 */
export function commandSearchValue(command: Command): string {
  return [command.title, command.meta ?? "", ...command.keywords, command.id]
    .filter((part) => part !== "")
    .join(" ");
}
