// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TeamBoardDrawer } from "./TeamBoardDrawer";
import { agentRow, sharedRow } from "./teamBoardFixtures";

// 드로어는 큐레이션된 **읽기 전용** 뷰다(#2863 Acceptance, ADR-0190 D4): 터미널 원문, 입력,
// 멈춤이 없다. 이 시험은 실제로 그려 본 DOM과 소스의 import를 함께 잠근다. 아래 금지어 목록이
// 비어 있어서 통과하는 일이 없도록, 같은 검사기가 위반 DOM에서 빨개지는지도 한 번 잰다.

afterEach(() => cleanup());

const HERE = dirname(fileURLToPath(import.meta.url));

/** 컨트롤로 읽히는 이름. 행동은 대화에서 한다. */
const CONTROL_NAME = /멈춤|멈추기|중지|정지|종료|끝내기|허락|허용|승인|거절|거부|보내기|전송|입력|stop|kill|approve|deny|send|resume|인계|조작/i;

function controlViolations(root: ParentNode): string[] {
  const found: string[] = [];
  if (root.querySelector("textarea, input, [contenteditable=''], [contenteditable='true'], [role='textbox'], .xterm, canvas")) {
    found.push("입력·터미널 요소");
  }
  for (const el of root.querySelectorAll("button, [role='button'], a")) {
    const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`;
    // 닫기(Esc)는 드로어를 닫는 단추이지 세션 컨트롤이 아니다.
    if (el.getAttribute("data-testid") === "team-board-drawer-close") continue;
    if (CONTROL_NAME.test(name)) found.push(name.trim());
  }
  return found;
}

function renderDrawer(item = sharedRow()) {
  return render(
    <MemoryRouter>
      <TeamBoardDrawer item={item} nowMs={Date.now()} onClose={() => undefined} />
    </MemoryRouter>
  );
}

describe("세션 상세 드로어는 읽기 전용이다", () => {
  it.each([
    ["기다림", sharedRow({ state: "waiting" })],
    ["실행 중", sharedRow({ state: "running" })],
    ["끝남 + PR", sharedRow({ state: "done", prUrl: "https://github.com/yeomyeonggeori/oort/pull/2851" })],
    ["에이전트 레인", agentRow()],
  ])("%s: 입력 칸·터미널·멈춤·허락 단추가 없다", (_name, item) => {
    const view = renderDrawer(item);
    expect(controlViolations(view.container)).toEqual([]);
    // 단추는 닫기 하나뿐이고, 나머지 행동은 링크(집 채널, PR)다.
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    const links = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("data-testid"));
    expect(links.filter((id) => id !== "team-board-pr")).toEqual(["team-board-open-channel"]);
  });

  it("검사기가 실제로 잡는다: 멈춤 단추·입력 칸·터미널이 있는 DOM은 위반이다", () => {
    const view = renderDrawer();
    const bad = document.createElement("div");
    bad.innerHTML =
      '<button type="button">세션 멈춤</button><textarea></textarea><div class="xterm"></div><button aria-label="실행 허락">확인</button>';
    view.container.append(bad);
    expect(controlViolations(view.container).length).toBeGreaterThanOrEqual(3);
  });

  it("터미널 원문은 주인의 기기에만 있다고 말하고, 커밋 제목 자리는 없다", () => {
    renderDrawer();
    expect(screen.getByTestId("team-board-terminal-note").textContent).toContain("터미널 원문은 주인의 기기에만 있어요");
    expect(document.body.textContent).not.toMatch(/커밋 제목|commit message/i);
  });

  it("진행: 단계 표지가 없으면 절이 숨는다. 에이전트 레인은 diff·저장소를 지어내지 않는다", () => {
    renderDrawer(agentRow());
    expect(screen.queryByTestId("team-board-stages")).toBeNull();
    expect(screen.queryByTestId("team-board-log")).toBeNull();
    expect(screen.getByTestId("team-board-no-pr").textContent).toContain("아직 PR 없음");
  });

  it("PR 카드는 새 탭 외부 링크이고 형식이 틀린 주소는 링크가 되지 않는다", () => {
    renderDrawer(sharedRow({ state: "done", prUrl: "https://github.com/yeomyeonggeori/oort/pull/2851" }));
    const pr = screen.getByTestId("team-board-pr");
    expect(pr.getAttribute("href")).toBe("https://github.com/yeomyeonggeori/oort/pull/2851");
    expect(pr.getAttribute("target")).toBe("_blank");
    expect(pr.getAttribute("rel")).toContain("noopener");
    cleanup();
    renderDrawer(sharedRow({ prUrl: "javascript:alert(1)" }));
    expect(screen.queryByTestId("team-board-pr")).toBeNull();
  });

  it("바닥의 행동은 집 채널로 가는 링크 하나다", () => {
    renderDrawer();
    expect(screen.getByTestId("team-board-open-channel").getAttribute("href")).toBe(
      "/c/00000000-0000-7000-8000-000000000201"
    );
    expect(screen.getByTestId("team-board-open-channel").textContent).toBe("#workbench에서 보기");
  });
});

describe("소스 잠금: 보드 모듈은 터미널·컨트롤·원장 읽기를 끌어오지 않는다", () => {
  const FORBIDDEN =
    /(TerminalDock|ObserverTerminal|DisplayController|DisplayObserver|controlStream|observerStream|displayStream|terminalRuntime|xterm|endWorkSession|useWorkSessions|fetchWorkSessions|useWorkSessionRail|WorkSessionDetail|\bpty\b|openDisplayControl|decideApproval)/;
  const files = readdirSync(HERE).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !/Fixtures/.test(f));

  it("대상 파일을 실제로 찾았다(빈 목록으로 통과하지 않는다)", () => {
    expect(files).toEqual(
      expect.arrayContaining(["TeamBoardDrawer.tsx", "TeamBoardRoute.tsx", "TeamBoardParts.tsx", "useTeamBoard.ts"])
    );
  });

  it.each(files)("%s의 import와 식별자에 금지된 이름이 없다", (file) => {
    const source = readFileSync(resolve(HERE, file), "utf8");
    // 주석은 금지어를 설명하며 적을 수 있다: 주석을 걷고 코드만 본다.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code.match(FORBIDDEN)?.[0] ?? null).toBeNull();
  });

  it("보드의 읽기는 공유 목록·단건 둘뿐이다", () => {
    const source = readFileSync(resolve(HERE, "useTeamBoard.ts"), "utf8");
    expect(source).toContain("fetchSharedWorkSessions");
    expect(source).toContain("fetchSharedWorkSession,");
    const api = [...source.matchAll(/\b(fetch[A-Za-z]+)\b/g)].map((m) => m[1]);
    expect(new Set(api)).toEqual(new Set(["fetchSharedWorkSession", "fetchSharedWorkSessions"]));
  });
});

