import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentRunProgressFromWire, type AgentRunProgress, type Message } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import { triggerChip } from "@momo/core/features/agents/triggerChip";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { AgentCard } from "@/features/timeline/AgentCard";
import { ThreadRequestSummary } from "@/features/timeline/ThreadRequestSummary";
import { RequestThoughtLine } from "@/features/agents/RequestThoughtLine";
import { TriggerChipView } from "@/features/agents/TriggerChip";
import "@/lib/coreHost";
import "@/design/tokens.css";

const WS = "00000000-0000-7000-8000-000000000001";
const HUMAN = "00000000-0000-7000-8000-000000000101";
const AGENT = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";
const RUN = "00000000-0000-7000-8000-000000000301";
const directory = makeDirectory([
  { id: HUMAN, workspaceId: WS, kind: "human", displayName: "이도현", role: "owner", status: "active", channelIds: [] },
  { id: AGENT, workspaceId: WS, kind: "agent", displayName: "달무리봇", handle: "dalmuri", status: "active", channelIds: [] },
] as never);
const session = {
  workspaceId: WS, session: { member: { id: HUMAN, workspaceId: WS, kind: "human" } },
  realtime: null, connStatus: "connected", logout: () => undefined, replaceSessionMember: () => undefined,
} as unknown as SessionContextValue;

function requestLoopRun(phase: AgentRunProgress["phase"]): AgentRunProgress {
  return {
    id: RUN, channelId: CH, agentMemberId: AGENT, triggerMessageId: "request", phase,
    status: phase === "claimed" ? "queued" : phase, leaseState: "live", ahead: [], stepCount: 2,
    latestStage: "프로필 소개를 읽고 있어요", createdAtMs: 1_800_000_000_000,
    startedAtMs: 1_800_000_000_000, updatedAtMs: Date.now(), lastEventAtMs: Date.now(),
    ...(["succeeded", "cancelled", "timed_out"].includes(phase) ? { finishedAtMs: 1_800_000_120_000 } : {}),
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- 독립 브라우저 시험의 마운트 함수와 같은 파일에서만 쓰는 화면이에요.
function Harness() {
  const [phase, setPhase] = useState<AgentRunProgress["phase"] | null>(null);
  const [cardStatus, setCardStatus] = useState("pending");
  const [summaryMode, setSummaryMode] = useState("inline");
  Object.assign(window, { requestLoopHarness: { setPhase, setCardStatus, setSummaryMode } });
  const current = requestLoopRun(phase ?? "queued");
  // 서버가 보내는 모양(camelCase)을 실제 파서에 통과시켜요. 모르는 상태·모드는 파서가 안전한 쪽으로 읽어요.
  const summaryRun = agentRunProgressFromWire({ ...requestLoopRun("awaiting_approval"), bundle: {
    approvalId: "approval", status: cardStatus, decisionMode: summaryMode, canDecide: true, actionType: "workspace_action", intent: "소개를 바꿔도 될까요?",
  } });
  const chip = triggerChip([current], () => ({ name: "달무리봇" }), Date.now());
  const message = {
    id: "card", channelId: CH, authorMemberId: AGENT, type: "approval_request", seq: 10, state: "sent", createdAtMs: Date.now(), hlcTs: Date.now(), hlcCount: 0,
    props: { approval_id: "approval", status: cardStatus, action_type: "workspace_action", intent: "소개를 바꾸려고 해요", can_decide: true,
      action: { id: "agent.profile.update", rows: [{ label: "소개", before: "기존 소개", after: "알림 시험" }], required_role: "admin" } },
  } as Message;
  const card = agentCardModel(message)!;
  return (
    <main>
      <div id="chip-head" className="flex h-6 items-center gap-2"><span>이도현</span>{chip && <TriggerChipView chip={chip} />}</div>
      <section id="thought-flow" data-phase={phase ?? "reserved"}>
        {phase ? <RequestThoughtLine run={current} directory={directory} /> : <div className="h-6" />}
        <p id="thought-bottom">스레드 바닥 행</p>
      </section>
      <section id="summary"><ThreadRequestSummary runs={[summaryRun]} onOpen={() => undefined} /></section>
      <section id="card-scroller" data-message-scroll-container="">
        {Array.from({ length: 12 }, (_, index) => <p key={index} className="p-4">설계 의견 {index + 1}</p>)}
        <p id="above-card" className="p-4">카드 위에서 읽던 행</p>
        <AgentCard card={card} directory={directory} />
        {/* 카드 아래에도 한 화면 넘게 둬요. 짧으면 「위 행을 읽는 중」이 스크롤 끝에
            걸려(최대 스크롤로 잘려) 바닥 붙임 장면이 돼요 — §8.1은 둘을 따로 재요. */}
        {Array.from({ length: 8 }, (_, index) => <p key={`after-${index}`} className="p-4">이어서 이야기해요 {index + 1}</p>)}
      </section>
    </main>
  );
}

export function mountRequestLoopHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><SessionProvider value={session}><Harness /></SessionProvider></QueryClientProvider>);
}
