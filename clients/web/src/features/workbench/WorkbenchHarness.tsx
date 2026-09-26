import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Select } from "@/design/ui/select";
import {
  defaultWorkbenchLayout,
  splitPane,
  toggleMaximize,
  type LayoutResult,
  type WorkbenchLayout,
} from "@momo/core/features/workbench/layoutTree";
import {
  serializeWorkbenchLayout,
  workbenchLayoutEntry,
} from "@momo/core/features/workbench/layoutStore";
import { WorkbenchGrid, type WorkbenchPaneInfo } from "./WorkbenchGrid";
import {
  browserLayoutStorage,
  memoryLayoutStorage,
  useWorkbenchLayout,
  type LayoutStorage,
} from "./useWorkbenchLayout";

// Reading this as: 작업 공간 격자 하네스(진단 표면) for internal team users on
// web+Tauri, density 7/10, motion 1/10.
//
// `#/design/workbench`. 격자 엔진(#2773)을 칸 내용 없이 본다. 칸 내용(xterm)은
// #2774가 붙인다. `?preset=two|four|max`는 캡처용 고정 배치를 메모리 저장소에
// 심고, 없으면 이 기기 localStorage에 세션마다 저장한다(새로고침으로 확인).

const SESSIONS = [
  { key: "~/momo/.worktrees/fix-login-401", label: "로그인 오류 수정 · fix/login-401" },
  { key: "~/momo/.worktrees/onboarding-copy", label: "온보딩 문구 · feat/onboarding-copy" },
] as const;

/** 칸 머리 문구. 하네스·계정·폴더를 제안서 §3.3 (3) 스케치대로 적는다. */
const PANE_FIXTURES = [
  { title: "claude · 개인(Max) · ~/momo", body: "로그인 401 재현 로그를 읽고 refresh 토큰 경로를 고치는 칸입니다." },
  { title: "codex · 회사 · ~/momo", body: "onboarding 문구 diff 검토 칸입니다. 줄 12개, 파일 3개." },
  { title: "zsh · ~/momo/.worktrees/fix-login", body: "$ cargo test -p momo-workd 결과를 보는 셸 칸입니다." },
  { title: "zsh · ~/momo/clients/web", body: "Playwright 캡처 스크립트를 돌리는 칸입니다." },
];

const PRESET_SIZE = { width: 1600, height: 1000 };

function must(result: LayoutResult): WorkbenchLayout {
  return result.layout;
}

function presetLayout(name: string | null): WorkbenchLayout | null {
  const base = defaultWorkbenchLayout();
  switch (name) {
    case "two":
      return must(splitPane(base, "p1", "row", PRESET_SIZE));
    case "four": {
      let l = must(splitPane(base, "p1", "row", PRESET_SIZE));
      l = must(splitPane(l, "p1", "column", PRESET_SIZE));
      l = must(splitPane(l, "p2", "column", PRESET_SIZE));
      return l;
    }
    case "max": {
      let l = presetLayout("four")!;
      l = must(toggleMaximize(l, "p3"));
      return l;
    }
    default:
      return null;
  }
}

/** 칸 id(p1, p2, …)로 픽스처를 고른다. 번호(트리 순서)로 고르면 분할 뒤 기존 칸의 제목이 바뀐다. */
function fixtureOf(pane: WorkbenchPaneInfo) {
  const serial = Number(/^p(\d+)$/.exec(pane.id)?.[1] ?? pane.index);
  return PANE_FIXTURES[(serial - 1) % PANE_FIXTURES.length]!;
}

function paneTitle(pane: WorkbenchPaneInfo): string {
  return fixtureOf(pane).title;
}

function PanePlaceholder({ pane }: { pane: WorkbenchPaneInfo }) {
  const fixture = fixtureOf(pane);
  return (
    <div className="flex flex-1 flex-col gap-2 bg-pane p-4">
      <p className="text-body text-ink">{fixture.body}</p>
      <p className="text-meta text-ink-muted">
        터미널 자리입니다. 실제 터미널은 다음 단계에서 이 칸에 붙습니다.
      </p>
    </div>
  );
}

export function WorkbenchHarness() {
  const [params] = useSearchParams();
  const preset = params.get("preset");
  const [session, setSession] = useState<string>(SESSIONS[0].key);

  const storage: LayoutStorage | null = useMemo(() => {
    const seeded = presetLayout(preset);
    if (seeded === null) return browserLayoutStorage();
    return memoryLayoutStorage(
      Object.fromEntries(SESSIONS.map((s) => [workbenchLayoutEntry(s.key), serializeWorkbenchLayout(seeded)]))
    );
  }, [preset]);

  const { layout, storage: storageStatus, setLayout } = useWorkbenchLayout(session, storage);

  return (
    <div
      data-testid="workbench-harness"
      className="flex h-full min-h-0 flex-col gap-4 bg-pane p-4 text-ink"
    >
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-title font-medium">작업 공간 격자</h1>
        <label className="flex min-w-0 items-center gap-2 text-meta text-ink-muted">
          세션
          <Select
            aria-label="세션 고르기"
            value={session}
            onChange={(event) => setSession(event.target.value)}
            className="w-auto"
          >
            {SESSIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-meta text-ink-muted">배치는 세션마다 이 기기에 저장됩니다.</p>
      </header>
      <WorkbenchGrid
        className="flex-1"
        layout={layout}
        onLayoutChange={setLayout}
        storage={storageStatus}
        paneTitle={paneTitle}
        renderPane={(pane) => <PanePlaceholder pane={pane} />}
      />
    </div>
  );
}
