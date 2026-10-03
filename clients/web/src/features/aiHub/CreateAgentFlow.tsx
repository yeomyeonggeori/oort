import { useId, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import {
  AI_AGENTS_PANE_COPY as COPY,
} from "@momo/core/features/ai/aiHubModel";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import type { CreatedAgent } from "@momo/core/lib/api";
import { CreateAgentDialog } from "@/features/agentHub/CreateAgentDialog";
import { EMPTY_AGENT_DRAFT, type AgentDraft } from "@/features/agentHub/createModel";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { SubscriptionAgentStart } from "@/features/welcome/harnessLogin/SubscriptionAgentStart";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { createKindOptions, type CreateKindId, type CreateKindOption } from "./aiAgentsModel";

// =============================================================================
// 「에이전트 만들기」 3종 선택 (AIH-7, #3428, 플랜 §1·§8-7).
//
// 새 서버 길이 없다. 고른 종류가 이미 있는 창을 연다:
//   팀 에이전트       → CreateAgentDialog (팀 AI 키로 답하는 멤버를 만든다)
//   내 Claude Code·Codex → SubscriptionAgentStart (로그인 → 에이전트로 만들기 한 흐름, #3419, 데스크탑)
//   다른 곳에서 도는 에이전트 → HostedAgentWizard (연결 값 발급)
// 잠긴 종류는 숨기지 않고 사유를 보여 준다: 웹에서 내 구독은 「데스크탑에서 해요」.
// =============================================================================

const isExternalProvided = () => isSurfaceProvided("hostedAgentPairing");

function KindRow({
  option,
  onChoose,
}: {
  option: CreateKindOption;
  onChoose: (id: CreateKindId) => void;
}) {
  const reasonId = useId();
  const locked = option.state === "locked";
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        // 잠긴 버튼도 포커스를 받아야 사유를 들을 수 있다: disabled 대신 aria-disabled.
        // 눌림 효과는 누를 수 있는 줄에만 있다. 사유는 버튼 안에 있어 포커스 링이 한 덩어리로 감싼다.
        aria-disabled={locked || undefined}
        aria-describedby={option.reason ? reasonId : undefined}
        onClick={() => {
          if (!locked) onChoose(option.id);
        }}
        data-testid={`create-kind-${option.id}`}
        data-state={option.state}
        className={cn(
          "tap-target flex w-full min-w-0 flex-col gap-1 px-1 py-3 text-left focus-visible:focus-ring",
          locked ? "cursor-not-allowed" : "hover:bg-surface-hover active:bg-surface-pressed"
        )}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn("break-keep text-body font-semibold", locked ? "text-ink-muted" : "text-ink")}>
            {option.title}
          </span>
          {locked && <Lock aria-hidden="true" className="size-3 shrink-0 text-ink-muted" />}
          <span
            className="rounded-sm bg-muted-soft px-1 py-px text-timestamp font-semibold text-ink-muted"
            data-testid={`create-kind-${option.id}-audience`}
          >
            {option.desktopHint ? COPY.create.desktopHint : option.audience}
          </span>
        </span>
        <span className={cn("break-keep text-meta", locked ? "text-ink-faint" : "text-ink-muted")}>
          {option.description}
        </span>
        {option.reason && (
          <span
            id={reasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid={`create-kind-${option.id}-reason`}
          >
            {option.reason}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * 고르는 창 + 고른 뒤의 창들. `open` 은 고르는 창이다. 한 번에 창은 하나만 선다.
 * 부르는 쪽은 소유자·관리자일 때만 이 흐름을 열어 준다(`mayCreate`).
 */
export function CreateAgentFlow({
  open,
  onOpenChange,
  mayCreate,
  opener,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mayCreate: boolean;
  /** 고르는 창을 연 단추. 닫으면 포커스가 여기로 돌아온다(마우스로 눌러 포커스가 body 일 때도). */
  opener?: HTMLElement | null;
  onCreated?: (created: CreatedAgent) => void;
}) {
  const subscription = useSubscriptionEntryState();
  const [flow, setFlow] = useState<CreateKindId | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_AGENT_DRAFT);
  const openerRef = useRef<HTMLElement | null>(null);
  const options = createKindOptions({ mayCreate, subscription, externalProvided: isExternalProvided() });

  const choose = (id: CreateKindId) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpenChange(false);
    setFlow(id);
  };

  return (
    <>
      <Dialog open={open && flow === null} onOpenChange={onOpenChange}>
        <DialogContent className="gap-3 p-6" opener={opener} data-testid="create-agent-chooser">
          <DialogTitle className="text-title font-bold">{COPY.create.title}</DialogTitle>
          <DialogDescription className="break-keep text-body text-ink-muted">
            {COPY.create.description}
          </DialogDescription>
          <ul aria-label={COPY.create.title} className="flex min-w-0 flex-col border-t border-line">
            {options.map((option) => (
              <KindRow key={option.id} option={option} onChoose={choose} />
            ))}
          </ul>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {COPY.create.cancel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CreateAgentDialog
        open={flow === "team"}
        onOpenChange={(next) => {
          if (!next) setFlow(null);
        }}
        draft={draft}
        setDraft={setDraft}
        opener={opener}
        onCreated={(created) => onCreated?.(created)}
      />
      {flow === "mySubscription" && <SubscriptionAgentStart open onClose={() => setFlow(null)} />}
      <HostedAgentWizard
        open={flow === "external"}
        onOpenChange={(next) => {
          if (!next) setFlow(null);
        }}
        opener={opener ?? openerRef.current}
      />
    </>
  );
}
