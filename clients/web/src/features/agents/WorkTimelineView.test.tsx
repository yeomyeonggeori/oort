// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentRunLedgerFromWire } from "@momo/core/lib/api";
import {
  workTimelineSections,
  workToolRecord,
  type WorkTimelineRow,
} from "@momo/core/features/agents/workTimeline";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { OortRecordSection, WorkTimelineSections } from "./WorkTimelineView";

// =============================================================================
// 작업 타임라인의 칸과 줄 (#4654). 무엇을 접고 어떻게 가르는지는 core가 가진다
// (`workTimeline.test.ts`). 여기서 지키는 것은 그것이 **화면에 그대로 서는가**다: 칸이 출처마다
// 갈리고 배지가 하나씩 서는가, 에이전트가 쓴 글이 마크업이 되지 않는가, 실패가 개별 줄로 서는가,
// 구 서버의 「모름」이 「0번」으로 읽히지 않는가.
// =============================================================================

const RUN = "0199aa11-2222-7000-8000-0000000000b1";
const T = 1_800_000_000_000;

let korean: AppLocale;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(element: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(LocaleProvider, { locale: korean, children: element }));
  });
  return host;
}

function row(
  over: Partial<WorkTimelineRow> & Pick<WorkTimelineRow, "id" | "source">
): WorkTimelineRow {
  return { kind: "tool", label: null, status: "done", atMs: T, count: 1, ...over };
}

const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];
const text = (el: Element | null) => el?.textContent ?? "";

function call(n: number, tool: string, code = "ok", durationMs = 12) {
  return { ordinal: n, kind: "tool_call", tool, code, durationMs, createdAtMs: T + n * 1000 };
}

describe("칸은 출처마다 하나다", () => {
  it("세 출처가 세 칸으로 서고 칸마다 배지가 하나이며 줄은 자기 출처만 가진다", () => {
    const sections = workTimelineSections([
      row({ id: "o1", source: "oort", label: "oort_run_event", durationMs: 35 }),
      row({ id: "a1", source: "agent", toolKind: "read", count: 12 }),
      row({ id: "a2", source: "agent", toolKind: "search", count: 3 }),
      row({ id: "a3", source: "agent", toolKind: "edit", label: "<img src=x onerror=alert(1)>" }),
      row({ id: "c1", source: "computer", toolKind: "run", label: null }),
      row({ id: "o2", source: "oort", toolKind: "read", label: "oort_inbox_read", count: 3 }),
    ]);
    const el = render(createElement(WorkTimelineSections, { sections, nowMs: T }));

    const cells = qa(el, "work-timeline-section");
    expect(cells.map((c) => c.getAttribute("data-source"))).toEqual(["oort", "agent", "computer"]);
    for (const cell of cells) {
      expect(qa(cell, "work-timeline-source-badge")).toHaveLength(1);
      for (const line of qa(cell, "work-timeline-row")) {
        expect(line.getAttribute("data-source")).toBe(cell.getAttribute("data-source"));
      }
    }
    expect(cells.map((c) => text(q(c, "work-timeline-source-badge")))).toEqual([
      "oort 기록",
      "에이전트 보고",
      "내 컴퓨터",
    ]);
    // 에이전트의 「읽기 12 · 검색 3」과 oort의 「읽기 3」은 한 줄에 합쳐지지 않는다.
    const [oortCell, agentCell, computerCell] = cells as [Element, Element, Element];
    expect(qa(agentCell, "work-timeline-label").map(text)).toEqual([
      "읽기 12 · 검색 3",
      "<img src=x onerror=alert(1)>",
    ]);
    expect(qa(oortCell, "work-timeline-label").map(text)).toEqual(["진행 알리기", "읽기 3"]);
    expect(qa(computerCell, "work-timeline-label").map(text)).toEqual(["명령 실행"]);
    // 에이전트가 쓴 글은 마크업이 아니라 글자다.
    expect(el.querySelector("img")).toBeNull();
    // 칸마다 믿음의 정도를 말하는 한 줄이 선다.
    expect(text(q(oortCell, "work-timeline-source-note"))).toContain("인자와 내용은 기록하지 않아요");
    expect(text(q(agentCell, "work-timeline-source-note"))).toContain("oort가 확인한 것은 아니에요");
  });
});

describe("「oort 기록」 칸의 네 상태", () => {
  it("반복은 한 줄로 접히고 실패는 개별 줄에 칩과 이유가 서며, 합계는 서버가 센 값이고 줄 상한은 한 줄로 알린다", () => {
    const events = [
      call(1, "oort_jobs_claim"),
      ...[2, 3, 4].map((n) => call(n, "oort_run_event", "ok", 35)),
      call(5, "oort_job_renew", "conflict", 1234),
      call(6, "oort_job_renew"),
    ];
    const record = workToolRecord(
      agentRunLedgerFromWire({
        runId: RUN,
        events,
        toolTally: [
          { tool: "oort_jobs_claim", ok: 1, error: 0, durationMsSum: 12 },
          { tool: "oort_run_event", ok: 120, error: 0, durationMsSum: 4200 },
          { tool: "oort_job_renew", ok: 9, error: 1, durationMsSum: 1500 },
        ],
        toolCallRowsCapped: true,
      })
    );
    const el = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));

    const lines = qa(el, "work-timeline-row");
    expect(lines.map((l) => text(q(l, "work-timeline-label")))).toEqual([
      "일 가져가기",
      "진행 알리기 · 3번",
      "맡은 시간 늘리기",
      "맡은 시간 늘리기",
    ]);
    const failed = lines[2] as Element;
    expect(failed.getAttribute("data-status")).toBe("failed");
    expect(text(q(failed, "work-timeline-status"))).toBe("실패");
    expect(text(q(failed, "work-timeline-failure"))).toBe("다른 변경과 겹쳤어요");
    expect(text(q(failed, "work-timeline-duration"))).toBe("1.2초");
    // 접힌 줄에는 시간이 없고 실패하지 않은 줄에는 칩이 없다.
    expect(q(lines[1] as Element, "work-timeline-duration")).toBeNull();
    expect(q(lines[3] as Element, "work-timeline-status")).toBeNull();
    // 합계는 서버가 센 값(행 상한을 넘은 호출까지)이고, 상한 문장은 줄로 선 수를 말한다.
    expect(text(q(el, "agent-work-panel-oort-summary"))).toBe("도구 호출 131번 · 실패 1번");
    expect(text(q(el, "agent-work-panel-oort-capped"))).toContain("처음 6번만 줄로 보여요");
    expect(q(el, "agent-work-panel-oort-unsupported")).toBeNull();
  });

  it("합계 없는 응답(구 서버)은 「서버 업데이트 뒤에 보여요」이고 0번이라고 말하지 않는다", () => {
    const record = workToolRecord(
      agentRunLedgerFromWire({ runId: RUN, events: [{ ordinal: 1, kind: "queued", createdAtMs: T }] })
    );
    const el = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));
    expect(text(q(el, "agent-work-panel-oort-unsupported"))).toBe("oort 호출 기록은 서버 업데이트 뒤에 보여요.");
    expect(q(el, "agent-work-panel-oort-summary")).toBeNull();
    expect(q(el, "agent-work-panel-oort-empty")).toBeNull();
    expect(q(el, "work-timeline-rows")).toBeNull();
    expect(text(el)).not.toMatch(/0번/);
    // 칸 머리는 구 서버에서도 서서 이 칸이 무엇인지 말한다.
    expect(text(q(el, "work-timeline-source-badge"))).toBe("oort 기록");
  });

  it("빈 합계는 「호출 없음」이다: 열린 run과 끝난 run의 말이 다르고 합계 줄은 서지 않는다", () => {
    const record = workToolRecord(
      agentRunLedgerFromWire({ runId: RUN, events: [], toolTally: [], toolCallRowsCapped: false })
    );
    const open = render(createElement(OortRecordSection, { record, open: true, nowMs: T }));
    expect(text(q(open, "agent-work-panel-oort-empty"))).toBe("아직 oort가 잰 도구 호출이 없어요.");
    expect(q(open, "agent-work-panel-oort-summary")).toBeNull();
    expect(q(open, "agent-work-panel-oort-unsupported")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const ended = render(createElement(OortRecordSection, { record, open: false, nowMs: T }));
    expect(text(q(ended, "agent-work-panel-oort-empty"))).toBe("이 일에서 oort가 잰 도구 호출은 없었어요.");
  });
});
