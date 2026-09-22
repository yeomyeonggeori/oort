import { describe, expect, it, vi } from "vitest";
import type { SurfaceId } from "../capabilities/serverSurfaces";
import { serverSurface } from "../capabilities/serverSurfaces";
import {
  KNOWN_COMMAND_IDS,
  agentRoutingCommandId,
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
    ...overrides,
  };
}

function context(): CommandContext & {
  navigate: ReturnType<typeof vi.fn>;
  openCreateChannel: ReturnType<typeof vi.fn>;
  openAgentProfile: ReturnType<typeof vi.fn>;
} {
  return {
    navigate: vi.fn(),
    openCreateChannel: vi.fn(),
    openAgentProfile: vi.fn(),
    session: { memberId: "member-1" },
    workspaceId: "ws-1",
  };
}

describe("명령 레지스트리", () => {
  it("id가 겹치지 않고 KNOWN_COMMAND_IDS가 고정 명령 전부를 덮는다", () => {
    const ids = visibleCommands(env()).map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of KNOWN_COMMAND_IDS) {
      expect(ids).toContain(id);
    }
  });

  it("이 티켓의 항목은 전부 navigate다 — client는 정의만 서 있다(AX-5)", () => {
    const agents = [{ id: "a-1", displayName: "김인턴", handle: "intern" }];
    for (const command of visibleCommands(env({ agents }))) {
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
    expect(status("nav.settings.agents")).toBe("에이전트 자격으로 이동");
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
