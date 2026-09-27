import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_SUGGESTABLE_COMMANDS,
  KNOWN_COMMAND_IDS,
  visibleCommands,
} from "@momo/core/features/commands/registry";
import { REGISTERED_SHORTCUTS } from "@/app/keyboardShortcuts";

// =============================================================================
// 드리프트 가드 — 명령 레지스트리 ↔ 단축키 정본 (ADR-0186 D1).
//
// 두 표가 서로를 가리킨다. 가리키는 쪽만 움직이면 **화면은 멀쩡하고 사실만
// 틀린다**: 팔레트가 없는 키를 키캡으로 그리거나(레지스트리의 `shortcutId`가
// 죽은 id), 「팔레트에도 있다」고 표시된 단축키가 팔레트에 없다
// (`paletteCommandId`가 죽은 명령). 둘 다 눈으로는 잡히지 않는다 — 키캡은
// 그려지고, 단축키는 여전히 동작하기 때문이다.
//
// 그래서 여기서 잰다. 이 시험은 웹에 산다: 단축키 정본이 `clients/web`에 있고
// 코어는 그쪽을 import할 수 없다(purity 게이트).
// =============================================================================

/** 모든 조건이 참인 환경. 고정 명령 전부가 보인다. */
const EVERYTHING = {
  showDrafts: true,
  canCreateChannel: true,
  isSurfaceProvided: () => true,
  agents: [{ id: "agent-1", displayName: "김인턴", handle: "intern" }],
  canOpenLocalCard: () => false,
};

const switcherSource = readFileSync("src/app/QuickSwitcher.tsx", "utf8");

describe("명령 레지스트리 ↔ 단축키 정본", () => {
  it("레지스트리의 shortcutId는 전부 등록된 단축키다", () => {
    const registered = new Set(REGISTERED_SHORTCUTS.map((s) => s.id));
    const pointed = visibleCommands(EVERYTHING)
      .map((command) => command.shortcutId)
      .filter((id): id is string => id !== undefined);

    expect(pointed.length).toBeGreaterThan(0);
    for (const id of pointed) {
      expect(registered).toContain(id);
    }
  });

  it("팔레트에 노출된다고 표시한 단축키는 전부 레지스트리에 있다", () => {
    const known = new Set(KNOWN_COMMAND_IDS);
    const flagged = REGISTERED_SHORTCUTS.map(
      (shortcut) => shortcut.paletteCommandId
    ).filter((id): id is string => id !== undefined);

    expect(flagged.length).toBeGreaterThan(0);
    for (const id of flagged) {
      expect(known).toContain(id);
    }
  });

  it("짝지어진 둘은 서로를 가리킨다", () => {
    const commands = new Map(
      visibleCommands(EVERYTHING).map((command) => [command.id, command])
    );
    for (const shortcut of REGISTERED_SHORTCUTS) {
      if (shortcut.paletteCommandId === undefined) continue;
      expect(commands.get(shortcut.paletteCommandId)?.shortcutId).toBe(
        shortcut.id
      );
    }
    expect(
      REGISTERED_SHORTCUTS.filter((s) => s.paletteCommandId !== undefined).map(
        (s) => s.id
      )
    ).toEqual(["open-settings", "open-inbox"]);
  });
});

describe("팔레트에 손으로 적힌 명령이 없다", () => {
  // 채널·다이렉트 메시지·검색은 목록에서 오므로 `go(\`/c/${id}\`)`·
  // `go(searchRoutePath(...))`처럼 **값이 들어간** 호출이다. 손으로 적힌 명령은
  // 반대로 리터럴 경로를 갖는다 — 그 모양이 0이어야 한다. `go("/inbox")` 한 줄을
  // 되살리면 이 시험이 붉어진다.
  it("리터럴 경로로 가는 줄이 0이다", () => {
    const literals = switcherSource.match(/\bgo\("\/[^"]*"\)/g) ?? [];
    expect(literals).toEqual([]);
  });

  it("레지스트리가 아는 줄을 팔레트가 손으로 그리지 않는다", () => {
    // 레지스트리의 모든 testId가 대상이다. 팔레트가 그중 하나라도 자기 JSX에
    // 직접 적고 있으면 그 줄은 표 밖에서 사는 줄이고, 다음 소비자(에이전트
    // 카탈로그)는 그 줄을 영영 보지 못한다.
    const testIds = [
      ...new Set(visibleCommands(EVERYTHING).map((command) => command.testId)),
    ];
    expect(testIds.length).toBeGreaterThanOrEqual(9);
    for (const testId of testIds) {
      expect(switcherSource).not.toContain(`data-testid="${testId}"`);
    }
  });

  it("합쳐진 세 머리글이 팔레트에서 사라졌다", () => {
    expect(switcherSource).not.toContain('heading="이동"');
    expect(switcherSource).not.toContain('heading="만들기"');
    expect(switcherSource).not.toContain('heading="에이전트 설정"');
    expect(switcherSource).toContain('heading="명령"');
  });

  it("검색 그룹과 사람 섹션은 그대로다 (회귀 우선)", () => {
    expect(switcherSource).toContain("heading={SEARCH_SURFACE_NAME} forceMount");
    expect(switcherSource).toContain('heading="사람"');
    expect(switcherSource).toContain('heading="채널"');
    expect(switcherSource).toContain('heading="다이렉트 메시지"');
  });
});

// =============================================================================
// 드리프트 가드 — 에이전트가 제안할 수 있는 명령 (ADR-0186 증보 G2).
//
// 서버 허용목록(`momo_agent::card_suggest::SUGGESTABLE_COMMANDS`)과 TS 레지스트리의
// `agentSuggestable: true` 집합은 같아야 한다. Rust는 TS를 읽지 못하므로 두 언어가
// 만나는 자리는 `docs/api/openapi.yaml`의 `SuggestableCommandId`이고, Rust 쪽은
// `routes::actions::the_suggestable_ids_are_one_list_in_four_places`가 잰다.
//
// 이 시험이 웹에 사는 이유: 코어는 `import.meta`가 금지되고 `node:fs` 타입이 없어
// 저장소의 다른 파일을 읽을 수 없다(`momo-core` purity·eslint). 웹 시험은 이미
// 이 레지스트리를 import하고 cwd 기준으로 파일을 읽는다.
// =============================================================================

function openapiEnum(schema: string): string[] {
  const spec = readFileSync("../../docs/api/openapi.yaml", "utf8");
  const lines = spec.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `    ${schema}:`);
  expect(start, `openapi.yaml declares ${schema}`).toBeGreaterThan(-1);
  for (const line of lines.slice(start + 1)) {
    // 다음 스키마 키(네 칸 들여쓰기)에서 멈춘다 — 다른 스키마의 enum을 읽지 않는다.
    if (line.trim() !== "" && !line.startsWith("      ")) break;
    const match = line.match(/^\s+enum:\s*\[(.*)\]\s*$/);
    if (match) {
      return match[1]
        .split(",")
        .map((item) => item.trim().replace(/^"|"$/g, ""))
        .filter((item) => item !== "");
    }
  }
  throw new Error(`${schema} declares no inline enum`);
}

describe("에이전트 제안 명령 ↔ 서버 허용목록 (SuggestableCommandId)", () => {
  const spec = openapiEnum("SuggestableCommandId");
  const flagged = AGENT_SUGGESTABLE_COMMANDS.map((command) => command.id);

  it("스펙 enum을 실제로 읽는다", () => {
    expect(spec.length).toBeGreaterThan(0);
    expect(spec).toContain("ai.connect");
  });

  it("레지스트리가 제안 가능하다고 표시한 명령은 전부 서버가 받는다", () => {
    for (const id of flagged) {
      expect(spec, `${id}는 SuggestableCommandId에 없다`).toContain(id);
    }
  });

  it("서버가 받는 명령은 전부 레지스트리에 있다", () => {
    for (const id of spec) {
      expect(flagged, `${id}는 agentSuggestable 명령이 아니다`).toContain(id);
    }
  });

  it("두 집합은 같다(순서 무관)", () => {
    expect([...flagged].sort()).toEqual([...spec].sort());
  });
});
