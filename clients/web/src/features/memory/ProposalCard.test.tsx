// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Message } from "@momo/core/lib/api";
import {
  PROPOSAL_ACCEPTED,
  PROPOSAL_CONFLICT_MESSAGE,
  PROPOSAL_EVIDENCE_GONE,
  PROPOSAL_EVIDENCE_UNAVAILABLE,
  PROPOSAL_FAILED_MESSAGE,
  PROPOSAL_FORBIDDEN_MESSAGE,
  PROPOSAL_GUEST_READONLY,
  PROPOSAL_REJECTED,
  PROPOSAL_SELF_ACCEPT_WARNING,
} from "@momo/core/features/memory/browser";
import { RunProposalCards } from "./ProposalCard";
import {
  CH,
  ITEM,
  JIHOON,
  MSG_A,
  MSG_B,
  ME,
  PROPOSAL,
  RUN,
  WS,
  byTestId,
  click,
  flush,
  mount,
  proposal,
  unmount,
} from "./memoryTestKit";

const listMemoryProposals = vi.hoisted(() => vi.fn());
const acceptMemoryProposal = vi.hoisted(() => vi.fn());
const rejectMemoryProposal = vi.hoisted(() => vi.fn());
const fetchMessages = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    listMemoryProposals: (...a: unknown[]) => listMemoryProposals(...a) as unknown,
    acceptMemoryProposal: (...a: unknown[]) => acceptMemoryProposal(...a) as unknown,
    rejectMemoryProposal: (...a: unknown[]) => rejectMemoryProposal(...a) as unknown,
  };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchMessages: (...a: unknown[]) => fetchMessages(...a) as unknown };
});

function message(id: string, seq: number, authorMemberId: string, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId,
    type: "text",
    body,
    state: "sent",
    createdAtMs: 1_800_000_000_000 + seq,
  } as Message;
}

const TEXT_A = "재시도 큐가 밀려서 결제 콜백이 늦게 와요.";
const TEXT_B = "큐 크기를 두 배로 늘리는 걸로 정리하죠.";

beforeEach(() => {
  listMemoryProposals.mockReset().mockResolvedValue([proposal()]);
  acceptMemoryProposal.mockReset().mockResolvedValue(
    proposal({ status: "accepted", text: undefined, evidence: [], evidenceMessageIds: [], itemId: ITEM, decidedBy: ME })
  );
  rejectMemoryProposal.mockReset().mockResolvedValue(
    proposal({ status: "rejected", text: undefined, evidence: [], evidenceMessageIds: [], decidedBy: ME })
  );
  fetchMessages.mockReset().mockResolvedValue({
    messages: [message(MSG_A, 41, JIHOON, TEXT_A), message(MSG_B, 42, ME, TEXT_B)],
  });
});
afterEach(unmount);

async function render(role: "member" | "guest" = "member") {
  const view = mount(
    createElement(RunProposalCards, { workspaceId: WS, channelId: CH, runId: RUN }),
    { role }
  );
  for (let i = 0; i < 5; i += 1) await flush();
  return view;
}

const card = (host: HTMLElement) => byTestId(host, "memory-proposal");

describe("제안 카드: 대기", () => {
  it("제안 문장·종류·근거(작성자와 본문)를 그리고 두 버튼을 준다", async () => {
    const { host } = await render();
    expect(listMemoryProposals).toHaveBeenCalledWith(WS, CH, {
      runId: RUN,
      status: "pending",
      limit: 5,
    });
    expect(card(host)?.getAttribute("data-state")).toBe("pending");
    expect(byTestId(host, "memory-proposal-text")?.textContent).toContain("크기를 두 배로");
    expect(byTestId(host, "memory-proposal-kind")?.textContent).toBe("결정");
    expect(card(host)?.textContent).toContain("김인턴의 제안이에요");
    const rows = host.querySelectorAll('[data-testid="memory-proposal-evidence-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("박지훈");
    expect(rows[0]?.textContent).toContain(TEXT_A);
    expect(rows[1]?.textContent).toContain("곽성재");
    expect(rows[1]?.textContent).toContain(TEXT_B);
    // 근거 본문은 API가 아니라 일반 메시지 읽기 경로에서 온다(seq 구간 한 번).
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages).toHaveBeenCalledWith(WS, CH, { after: 40, limit: 2 });
    expect(byTestId(host, "memory-proposal-accept")).not.toBeNull();
    expect(byTestId(host, "memory-proposal-reject")).not.toBeNull();
    expect(host.textContent).toContain("기억하기를 누르기 전에는 아무것도 저장되지 않아요.");
  });

  it("제안이 없으면 아무것도 그리지 않는다", async () => {
    listMemoryProposals.mockResolvedValue([]);
    const { host } = await render();
    expect(card(host)).toBeNull();
    expect(byTestId(host, "memory-proposals")).toBeNull();
  });

  it("근거를 읽지 못하면 그 줄에 이유를 말하고 행은 남긴다", async () => {
    fetchMessages.mockRejectedValue(new ApiError(500, "x"));
    const { host } = await render();
    const rows = host.querySelectorAll('[data-testid="memory-proposal-evidence-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(PROPOSAL_EVIDENCE_UNAVAILABLE);
    // 본문을 못 봐도 결정은 막지 않는다.
    expect(byTestId(host, "memory-proposal-accept")).not.toBeNull();
  });

  it("지워졌거나 볼 수 없는 근거는 그렇게 말한다", async () => {
    fetchMessages.mockResolvedValue({ messages: [message(MSG_A, 41, JIHOON, TEXT_A)] });
    const { host } = await render();
    const rows = host.querySelectorAll('[data-testid="memory-proposal-evidence-row"]');
    expect(rows[0]?.textContent).toContain(TEXT_A);
    expect(rows[1]?.textContent).toContain(PROPOSAL_EVIDENCE_GONE);
  });
});

describe("제안 카드: 자기 수락 경고", () => {
  it("내가 부탁한 답에서 나온 제안이면 경고를 보이되 버튼은 막지 않는다", async () => {
    listMemoryProposals.mockResolvedValue([proposal({ callerIsRequester: true })]);
    const { host } = await render();
    expect(byTestId(host, "memory-proposal-self-warning")?.textContent).toBe(
      PROPOSAL_SELF_ACCEPT_WARNING
    );
    expect((byTestId(host, "memory-proposal-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("요청자가 아니면 경고가 없다", async () => {
    const { host } = await render();
    expect(byTestId(host, "memory-proposal-self-warning")).toBeNull();
  });
});

describe("제안 카드: 손님", () => {
  it("손님은 카드를 읽기만 하고 이유를 듣는다. 버튼도 요청도 없다", async () => {
    const { host } = await render("guest");
    expect(card(host)?.getAttribute("data-state")).toBe("readOnly");
    expect(byTestId(host, "memory-proposal-text")).not.toBeNull();
    expect(byTestId(host, "memory-proposal-accept")).toBeNull();
    expect(byTestId(host, "memory-proposal-reject")).toBeNull();
    expect(byTestId(host, "memory-proposal-readonly")?.textContent).toBe(PROPOSAL_GUEST_READONLY);
    expect(acceptMemoryProposal).not.toHaveBeenCalled();
  });
});

describe("제안 카드: 결정", () => {
  it("기억하기: 서버에 수락을 보내고, 기억했어요와 기억 보기 링크로 바뀐다", async () => {
    const { host } = await render();
    click(byTestId(host, "memory-proposal-accept"));
    await flush();
    await flush();
    expect(acceptMemoryProposal).toHaveBeenCalledWith(WS, PROPOSAL);
    expect(rejectMemoryProposal).not.toHaveBeenCalled();
    expect(card(host)?.getAttribute("data-state")).toBe("accepted");
    expect(byTestId(host, "memory-proposal-accepted")?.textContent).toBe(PROPOSAL_ACCEPTED);
    expect(byTestId(host, "memory-proposal-accept")).toBeNull();
    expect(byTestId(host, "memory-proposal-open")?.getAttribute("href")).toBe(
      `/memory?item=${ITEM}`
    );
    // 캐럿은 사라진 버튼이 아니라 결과 문장으로 간다.
    expect(document.activeElement).toBe(byTestId(host, "memory-proposal-accepted"));
  });

  it("아니요: 거절을 보내고 기억하지 않기로 했다고 말한다", async () => {
    const { host } = await render();
    click(byTestId(host, "memory-proposal-reject"));
    await flush();
    await flush();
    expect(rejectMemoryProposal).toHaveBeenCalledWith(WS, PROPOSAL);
    expect(acceptMemoryProposal).not.toHaveBeenCalled();
    expect(card(host)?.getAttribute("data-state")).toBe("rejected");
    expect(byTestId(host, "memory-proposal-rejected")?.textContent).toBe(PROPOSAL_REJECTED);
  });

  it("누르는 동안 다시 눌러도 요청은 한 번이다", async () => {
    let release: (value: unknown) => void = () => undefined;
    acceptMemoryProposal.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { host } = await render();
    click(byTestId(host, "memory-proposal-accept"));
    click(byTestId(host, "memory-proposal-accept"));
    click(byTestId(host, "memory-proposal-reject"));
    await flush();
    expect(card(host)?.getAttribute("data-state")).toBe("deciding");
    expect(byTestId(host, "memory-proposal-accept")?.getAttribute("aria-busy")).toBe("true");
    expect(acceptMemoryProposal).toHaveBeenCalledTimes(1);
    expect(rejectMemoryProposal).not.toHaveBeenCalled();
    release(proposal({ status: "accepted", text: undefined, evidence: [] }));
    await flush();
  });
});

describe("제안 카드: 실패", () => {
  it("409: 이미 처리됐거나 만료됐다고 말하고, 목록에서 사라져도 카드는 그 말을 들고 남는다", async () => {
    acceptMemoryProposal.mockRejectedValue(new ApiError(409, "already decided"));
    const { host, client } = await render();
    // 다시 읽으면 서버는 더 이상 대기 제안으로 주지 않는다.
    listMemoryProposals.mockResolvedValue([]);
    click(byTestId(host, "memory-proposal-accept"));
    await flush();
    await flush();
    await client.invalidateQueries({ queryKey: ["memory", "proposals"] });
    await flush();
    expect(card(host)?.getAttribute("data-state")).toBe("conflict");
    expect(byTestId(host, "memory-proposal-conflict")?.textContent).toBe(PROPOSAL_CONFLICT_MESSAGE);
    expect(byTestId(host, "memory-proposal-accept")).toBeNull();
  });

  it("403: 결정할 수 없다고 말하고 카드를 읽기 전용으로 바꾼다", async () => {
    acceptMemoryProposal.mockRejectedValue(new ApiError(403, "forbidden"));
    const { host } = await render();
    click(byTestId(host, "memory-proposal-accept"));
    await flush();
    await flush();
    expect(card(host)?.getAttribute("data-state")).toBe("readOnly");
    expect(byTestId(host, "memory-proposal-readonly")?.textContent).toBe(PROPOSAL_FORBIDDEN_MESSAGE);
    expect(byTestId(host, "memory-proposal-accept")).toBeNull();
  });

  it("그 밖의 실패: 오류 문장을 보이고 버튼은 남겨서 다시 시도하게 한다", async () => {
    acceptMemoryProposal.mockRejectedValueOnce(new ApiError(500, "boom"));
    const { host } = await render();
    click(byTestId(host, "memory-proposal-accept"));
    await flush();
    await flush();
    expect(card(host)?.getAttribute("data-state")).toBe("error");
    expect(byTestId(host, "memory-proposal-error")?.textContent).toBe(PROPOSAL_FAILED_MESSAGE);
    click(byTestId(host, "memory-proposal-accept"));
    await flush();
    await flush();
    expect(acceptMemoryProposal).toHaveBeenCalledTimes(2);
    expect(card(host)?.getAttribute("data-state")).toBe("accepted");
    // 성공하면 이전 오류 문장은 치워진다.
    expect(byTestId(host, "memory-proposal-error")).toBeNull();
  });
});
