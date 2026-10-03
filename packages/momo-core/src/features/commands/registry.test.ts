import { describe, expect, it, vi } from "vitest";
import type { SurfaceId } from "../capabilities/serverSurfaces";
import { serverSurface } from "../capabilities/serverSurfaces";
import {
  AGENT_SUGGESTABLE_COMMANDS,
  AI_CONNECT_HUB_PATH,
  KNOWN_COMMAND_IDS,
  TOGGLE_SIDEBAR_COMMAND_ID,
  agentRoutingCommandId,
  slashCommands,
  commandSearchValue,
  visibleCommands,
  type CommandContext,
  type CommandEnv,
} from "./registry";

// =============================================================================
// 레지스트리가 **정의의 유일한 자리**라는 것을 잰다 (ADR-0186 D1).
//
// 단축키와의 양방향 드리프트 가드는 여기 없다. `keyboardShortcuts.ts`는 웹
// 클라이언트에 살고 이 패키지는 그쪽을 import할 수 없으므로(purity 게이트),
// 그 시험은 `clients/web/src/app/commandRegistry.test.ts`에 있다.
// =============================================================================

const ALL_SURFACES = (): boolean => true;
const NO_SURFACES = (): boolean => false;

function env(overrides: Partial<CommandEnv> = {}): CommandEnv {
  return {
    showDrafts: true,
    canCreateChannel: true,
    isSurfaceProvided: ALL_SURFACES,
    agents: [],
    canOpenLocalCard: () => false,
    ...overrides,
  };
}

function context(opened = false): CommandContext & {
  navigate: ReturnType<typeof vi.fn>;
  openCreateChannel: ReturnType<typeof vi.fn>;
  openAgentProfile: ReturnType<typeof vi.fn>;
  openLocalCard: ReturnType<typeof vi.fn>;
} {
  return {
    navigate: vi.fn(),
    openCreateChannel: vi.fn(),
    openAgentProfile: vi.fn(),
    openLocalCard: vi.fn(() => opened),
    session: { memberId: "member-1" },
    workspaceId: "ws-1",
  };
}

describe("명령 레지스트리", () => {
  it("id가 겹치지 않고 KNOWN_COMMAND_IDS가 고정 명령 전부를 덮는다", () => {
    const ids = visibleCommands(env({ sidebarList: { collapsed: false } })).map(
      (command) => command.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of KNOWN_COMMAND_IDS) {
      expect(ids).toContain(id);
    }
  });

  it("client 명령은 ai.connect·view.sidebar 둘이다 — 나머지는 전부 navigate(#2943·#3299)", () => {
    const agents = [{ id: "a-1", displayName: "김인턴", handle: "intern" }];
    for (const command of visibleCommands(
      env({ agents, sidebarList: { collapsed: false } })
    )) {
      if (command.id === "ai.connect" || command.id === TOGGLE_SIDEBAR_COMMAND_ID) continue;
      expect(command.kind).toBe("navigate");
    }
  });

  it("환경이 항목을 실제로 줄인다", () => {
    const full = visibleCommands(env()).map((command) => command.id);
    const bare = visibleCommands(
      env({
        showDrafts: false,
        canCreateChannel: false,
        isSurfaceProvided: NO_SURFACES,
      })
    ).map((command) => command.id);

    expect(full).toContain("nav.drafts");
    expect(full).toContain("create.channel");
    expect(full).toContain("nav.workConsole");
    expect(full).toContain("nav.workstreams");

    expect(bare).not.toContain("nav.drafts");
    expect(bare).not.toContain("create.channel");
    expect(bare).not.toContain("nav.workConsole");
    expect(bare).not.toContain("nav.workstreams");
    expect(bare.length).toBe(full.length - 4);
  });

  it("표면 이름은 판정표에서 들고 온다 — 손으로 다시 적지 않는다", () => {
    const commands = visibleCommands(env());
    const console = commands.find((command) => command.id === "nav.workConsole");
    const streams = commands.find((command) => command.id === "nav.workstreams");
    expect(console?.title).toBe(serverSurface("workConsole").label);
    expect(streams?.title).toBe(serverSurface("workstreams").label);
  });

  it("제공 여부는 표면 id로 묻는다", () => {
    const asked: SurfaceId[] = [];
    visibleCommands(
      env({
        isSurfaceProvided: (id) => {
          asked.push(id);
          return true;
        },
      })
    );
    expect(asked).toContain("workConsole");
    expect(asked).toContain("workstreams");
  });

  it("에이전트마다 라우팅 명령이 하나씩 생긴다", () => {
    const agents = [
      { id: "a-1", displayName: "김인턴", handle: "intern" },
      { id: "a-2", displayName: "헤르메스", handle: "hermes" },
    ];
    const commands = visibleCommands(env({ agents }));
    const routing = commands.filter(
      (command) => command.testId === "switcher-agent-routing"
    );
    expect(routing.map((command) => command.id)).toEqual([
      agentRoutingCommandId("a-1"),
      agentRoutingCommandId("a-2"),
    ]);
    expect(routing.map((command) => command.memberId)).toEqual(["a-1", "a-2"]);
    expect(routing[0]?.title).toBe("김인턴 라우팅");
    expect(routing[0]?.meta).toBe("@intern");
  });

  it("표시 이름이 같은 에이전트 둘도 cmdk 값이 갈린다", () => {
    const commands = visibleCommands(
      env({
        agents: [
          { id: "a-1", displayName: "김인턴", handle: "intern" },
          { id: "a-2", displayName: "김인턴", handle: "kim" },
        ],
      })
    );
    const values = commands
      .filter((command) => command.testId === "switcher-agent-routing")
      .map(commandSearchValue);
    expect(values[0]).not.toBe(values[1]);
  });

  it("run은 context를 통해서만 바깥에 닿고 결과를 말한다", () => {
    const commands = visibleCommands(
      env({ agents: [{ id: "a-1", displayName: "김인턴", handle: "intern" }] })
    );

    const inbox = commands.find((command) => command.id === "nav.inbox")!;
    const ctxA = context();
    expect(inbox.run(ctxA)).toEqual({
      status: "인박스로 이동",
      closesSurface: true,
    });
    expect(ctxA.navigate).toHaveBeenCalledWith("/inbox");

    const create = commands.find((command) => command.id === "create.channel")!;
    const ctxB = context();
    expect(create.run(ctxB).closesSurface).toBe(true);
    expect(ctxB.openCreateChannel).toHaveBeenCalledTimes(1);
    expect(ctxB.navigate).not.toHaveBeenCalled();

    const routing = commands.find(
      (command) => command.id === agentRoutingCommandId("a-1")
    )!;
    const ctxC = context();
    routing.run(ctxC);
    expect(ctxC.openAgentProfile).toHaveBeenCalledWith("a-1");
  });

  it("이동 문장의 조사가 저장소의 규칙을 따른다 (로/으로)", () => {
    const commands = visibleCommands(env());
    const status = (id: string) =>
      commands.find((command) => command.id === id)!.run(context()).status;
    // ㄹ은 열린 음절처럼 로를 받는다 — 「작업 콘솔으로」가 아니다.
    expect(status("nav.workConsole")).toBe("작업 콘솔로 이동");
    expect(status("nav.workstreams")).toBe("작업 흐름으로 이동");
    expect(status("nav.inbox")).toBe("인박스로 이동");
    expect(status("nav.activity")).toBe("활동으로 이동");
    expect(status("nav.directory")).toBe("멤버로 이동");
    expect(status("nav.settings.agents")).toBe("외부 에이전트 연결로 이동");
  });

  it("작업 콘솔은 웹·데스크탑 모두 /work?view=console로 간다 (#2854·#3334 — /work는 데스크탑에서 「내 작업」 격자, 웹에서 설명 상태)", () => {
    const command = visibleCommands(env()).find((c) => c.id === "nav.workConsole")!;
    const web = context();
    command.run(web);
    const desktop = { ...context(), desktop: true };
    const result = command.run(desktop);
    expect(web.navigate.mock.calls).toEqual([["/work?view=console"]]);
    expect(desktop.navigate.mock.calls).toEqual([["/work?view=console"]]);
    expect(result.status).toBe("작업 콘솔로 이동");
  });

  it("AI 허브 이동 명령 다섯이 ⌘K에 서고 제 경로로 간다 (AIH-3)", () => {
    const commands = visibleCommands(env());
    const ctx = context();
    const ids = ["nav.ai", "nav.ai.accounts", "nav.ai.teamKeys", "nav.ai.agents", "nav.ai.external"];
    for (const id of ids) commands.find((command) => command.id === id)!.run(ctx);
    expect(ctx.navigate.mock.calls).toEqual([
      ["/ai"],
      ["/ai/accounts"],
      ["/ai/team-keys"],
      ["/ai/agents"],
      ["/ai/external"],
    ]);
    expect(commands.filter((c) => c.id.startsWith("nav.ai")).map((c) => c.title)).toEqual([
      "AI",
      "내 AI 계정",
      "팀 AI 키",
      "AI 에이전트",
      "외부 연결",
    ]);
  });

  it("설정 갈래의 두 명령이 제 경로로 간다", () => {
    const commands = visibleCommands(env());
    const ctx = context();
    commands.find((command) => command.id === "nav.settings")!.run(ctx);
    commands.find((command) => command.id === "nav.settings.agents")!.run(ctx);
    expect(ctx.navigate.mock.calls).toEqual([
      ["/settings"],
      ["/settings?section=agents"],
    ]);
  });

  it("cmdk 값에 별칭과 id가 함께 실린다", () => {
    const directory = visibleCommands(env()).find(
      (command) => command.id === "nav.directory"
    )!;
    const value = commandSearchValue(directory);
    expect(value).toContain("멤버");
    expect(value).toContain("디렉터리");
    expect(value).toContain("명부");
    expect(value).toContain("nav.directory");
  });
});

// =============================================================================
// ADR-0186 증보 G2 — 에이전트가 제안할 수 있는 명령.
//
// 서버 허용목록과의 드리프트 가드는 웹 `app/commandRegistry.test.ts`에 있다:
// 두 언어가 만나는 자리는 `docs/api/openapi.yaml`의 `SuggestableCommandId`인데,
// 이 패키지는 `import.meta`와 `node:fs` 타입이 없어 그 파일을 읽을 수 없다.
// 여기서는 코어만으로 잴 수 있는 규칙을 잰다.
// =============================================================================

describe("탐색 패널 접기/열기 (#3299)", () => {
  const find = (overrides: Partial<CommandEnv> = {}) =>
    visibleCommands(env(overrides)).find(
      (command) => command.id === TOGGLE_SIDEBAR_COMMAND_ID
    );

  it("접을 목록 열이 없는 클라이언트(폰)에는 줄이 서지 않는다", () => {
    expect(find()).toBeUndefined();
    expect(find({ sidebarList: undefined })).toBeUndefined();
  });

  it("이름이 지금 상태를 따른다: 펼침이면 접기, 접힘이면 열기", () => {
    expect(find({ sidebarList: { collapsed: false } })?.title).toBe("탐색 패널 접기");
    expect(find({ sidebarList: { collapsed: true } })?.title).toBe("탐색 패널 열기");
  });

  it("client 명령이고 단축키 정본 toggle-sidebar를 가리키며 에이전트 제안 대상이 아니다", () => {
    const command = find({ sidebarList: { collapsed: false } })!;
    expect(command.kind).toBe("client");
    expect(command.shortcutId).toBe("toggle-sidebar");
    expect(command.agentSuggestable).toBeUndefined();
    expect(AGENT_SUGGESTABLE_COMMANDS.map((c) => c.id)).not.toContain(
      TOGGLE_SIDEBAR_COMMAND_ID
    );
  });

  it("run은 훅을 한 번 부르고 바뀐 상태를 말한다 — 이동·폼은 건드리지 않는다", () => {
    const ctx = { ...context(), toggleSidebarList: vi.fn(() => true) };
    const result = find({ sidebarList: { collapsed: false } })!.run(ctx);
    expect(ctx.toggleSidebarList).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "탐색 패널 접기", closesSurface: true });
    expect(ctx.navigate).not.toHaveBeenCalled();
    const open = { ...context(), toggleSidebarList: vi.fn(() => false) };
    expect(find({ sidebarList: { collapsed: true } })!.run(open).status).toBe(
      "탐색 패널 열기"
    );
  });

  it("훅이 없으면 아무 일도 하지 않고 표면을 닫지도 않는다(방어)", () => {
    const result = find({ sidebarList: { collapsed: false } })!.run(context());
    expect(result).toEqual({ status: null, closesSurface: false });
  });

  it("슬래시 목록에는 서지 않는다", () => {
    expect(slashCommands().map((c) => c.id)).not.toContain(TOGGLE_SIDEBAR_COMMAND_ID);
  });
});

describe("agentSuggestable", () => {
  it("client 명령에만 붙는다 — 서버 상태를 바꾸지 않는 명령만 제안 카드가 된다", () => {
    for (const command of AGENT_SUGGESTABLE_COMMANDS) {
      expect(command.kind, command.id).toBe("client");
    }
  });

  it("고정 명령만 담고, 같은 id가 두 번 나오지 않는다", () => {
    const ids = AGENT_SUGGESTABLE_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(KNOWN_COMMAND_IDS).toContain(id);
    }
  });

  it("ai.connect가 첫 제안 가능 명령이다(서버 허용목록 v1)", () => {
    expect(AGENT_SUGGESTABLE_COMMANDS).toEqual([{ id: "ai.connect", kind: "client" }]);
  });
});

describe("ai.connect (#2943 GC-2)", () => {
  const aiConnect = (overrides: Partial<CommandEnv> = {}) =>
    visibleCommands(env(overrides)).find((command) => command.id === "ai.connect")!;

  it("client 명령이고 설정 갈래이며 제목은 「AI 계정 카드 열기」다", () => {
    const command = aiConnect();
    expect(command.kind).toBe("client");
    expect(command.group).toBe("settings");
    expect(command.title).toBe("AI 계정 카드 열기");
    expect(commandSearchValue(command)).toContain("connect");
  });

  it("카드 자리가 있으면 카드를 열고 이동하지 않는다", () => {
    const ctx = context(true);
    const result = aiConnect().run(ctx, { line: "claude" });
    expect(ctx.openLocalCard).toHaveBeenCalledWith("ai.connect", { line: "claude" });
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "AI 계정 카드 열기", closesSurface: true });
  });

  it("카드 자리가 없으면 AI 허브로 간다(채널 밖·GC-3 전 폴백)", () => {
    const ctx = context(false);
    const result = aiConnect().run(ctx);
    expect(ctx.openLocalCard).toHaveBeenCalledWith("ai.connect", {});
    expect(ctx.navigate.mock.calls).toEqual([[AI_CONNECT_HUB_PATH]]);
    expect(AI_CONNECT_HUB_PATH).toBe("/ai/accounts");
    expect(result).toEqual({ status: "AI로 이동", closesSurface: true });
  });

  it("모르는 인자는 카드에 가지 않는다(의도만, 비밀값 없음)", () => {
    const ctx = context(true);
    aiConnect().run(ctx, { line: "sk-bogus", apiKey: "x" } as never);
    expect(ctx.openLocalCard).toHaveBeenCalledWith("ai.connect", {});
  });

  it("줄의 작은 글씨가 누른 결과를 거짓 없이 말한다", () => {
    expect(aiConnect({ canOpenLocalCard: () => true }).meta).toBe("이 채널 · 나에게만");
    expect(aiConnect({ canOpenLocalCard: () => false }).meta).toBe("AI 화면에서 열려요");
  });

  it("옛 「AI」 이동 줄은 허브 줄로 흡수됐다", () => {
    const ids = visibleCommands(env()).map((command) => command.id);
    expect(ids).not.toContain("nav.settings.ai");
    expect(ids).toContain("nav.ai.accounts");
  });

  it("슬래시 이름은 client 명령만 갖는다", () => {
    const slash = slashCommands();
    expect(slash.map((command) => command.id)).toEqual(["ai.connect"]);
    for (const command of visibleCommands(env())) {
      if (command.slash !== undefined) expect(command.kind).toBe("client");
    }
    expect(slash[0].slash?.name).toBe("연결");
    expect(slash[0].slash?.aliases).toEqual(["connect", "ai"]);
  });
});
