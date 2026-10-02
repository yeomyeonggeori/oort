import type { SharedWorkSession } from "@momo/core/lib/api";

// 시험용 줄. 팀 내용처럼 한국어와 영어가 섞인 현실적인 값이다.
export const WS = "00000000-0000-7000-8000-000000000001";
export const ME = "00000000-0000-7000-8000-000000000101";
export const CH_WORKBENCH = "00000000-0000-7000-8000-000000000201";
export const CH_AGENT_LAB = "00000000-0000-7000-8000-000000000202";

export function sharedRow(overrides: Partial<SharedWorkSession> = {}): SharedWorkSession {
  const now = Date.now();
  return {
    sessionId: "00000000-0000-7000-8000-0000000000a1",
    origin: "local_pty",
    label: "한글 입력 이중 전송 수리",
    folderLabel: "momo",
    status: "running",
    owner: { memberId: ME, displayName: "곽성재" },
    homeChannel: { id: CH_WORKBENCH, name: "workbench" },
    startedAtMs: now - 3_600_000,
    endedAtMs: null,
    sharedAtMs: now - 3_000_000,
    repo: "momo",
    branch: "feat/2774-xterm",
    harness: "claude",
    state: "waiting",
    stages: ["세션 시작", "작업 중", "실행 허락 기다림"],
    diff: { added: 128, deleted: 40, files: 9, ahead: 2, behind: 0, uncommitted: 1 },
    prUrl: null,
    lastActivityAt: Math.floor((now - 3 * 60_000) / 1000),
    ...overrides,
  };
}

export function agentRow(overrides: Partial<SharedWorkSession> = {}): SharedWorkSession {
  const now = Date.now();
  return sharedRow({
    sessionId: "00000000-0000-7000-8000-0000000000b1",
    origin: "host",
    label: "온보딩 문구 다듬기",
    folderLabel: null,
    repo: null,
    branch: null,
    harness: "claude",
    state: "running",
    stages: [],
    diff: { added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null },
    prUrl: null,
    homeChannel: { id: CH_AGENT_LAB, name: "agent-lab" },
    lastActivityAt: Math.floor((now - 60_000) / 1000),
    ...overrides,
  });
}
