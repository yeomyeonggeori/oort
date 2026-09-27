import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronRight, FileDiff, FilePen, FileText, Globe, Search, SquareTerminal, Wrench } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { CONFIRM_GUARD_MS } from "@/features/timeline/ApprovalActions";
import {
  DEFAULT_REPLY_MODE,
  PERMISSION_ASK,
  canAllow,
  permissionWaitingLine,
  type AgentFeedItem,
  type AgentPaneModel,
  type AgentToolCard,
  type PendingPermission,
  type ReplyMode,
  type ToolCardKind,
} from "@momo/core/features/workbench/agentPane";
import { StatusMark } from "../local/SessionList";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import "./agentPane.css";

// Reading this as: 작업 공간 A 칸 진행 뷰(에이전트 작업 레인 한 세션) for internal
// team users on web+Tauri, density 7/10, motion 1/10.
//
// 제안서 §3.3 (4)와 시안 ⑤ 스레드 root 카드(`.wcard` · `.pwaitc` · `.sysl` · `.comp`)를
// 격자 칸 안에 옮긴다. 칸 머리(번호·이름·상태·레인)는 격자가 그린다.
//
// - 위: 목표 한 줄, 호스트 · 하네스, 계획 진행.
// - 가운데: ACP plan 단계 목록, tool-call은 접힌 카드. 펼치기(「원문 보기」)는 소유자만.
// - 권한 카드: 「이번 한 번 허락」·「거부하고 지시」만(ADR-0188 D5). 두 번 눌러야
//   결정한다(무장 → 확정, 무장 직후 400ms와 키 반복은 받지 않는다). 결정은 사람이
//   확정 버튼을 눌렀을 때만 만든다. 마운트·다시 그리기·이벤트 재전달에는 부르지 않는다.
// - 아래: 답장 칸. 기본은 다음 차례 예약, 끼어들기는 따로 누르는 버튼(D4).
//
// 모든 글은 React 텍스트 노드로 그린다. HTML로 해석하는 자리가 없다.

export interface PermissionDecision {
  sessionId: string;
  requestEventId: string;
  optionId: string;
  kind: "allow_once" | "reject_once";
  /** 거부하고 지시: 다음 입력으로 보낼 지시문. */
  instruction?: string;
}

export interface AgentReply {
  sessionId: string;
  text: string;
  mode: ReplyMode;
}

/**
 * 칸이 서버로 보내는 두 가지. null이면 이 서버에 그 길이 없다: 버튼은 보이되 누를 수
 * 없고, 그 사실을 한 줄로 말한다(조용히 숨기지 않는다).
 */
export interface AgentPaneActions {
  decide: ((decision: PermissionDecision) => Promise<void>) | null;
  reply: ((reply: AgentReply) => Promise<void>) | null;
}

export const DECIDE_UNAVAILABLE = "이 서버는 아직 칸에서 한 권한 결정을 받지 않아요. 결정 경로가 열리면 여기서 허락할 수 있어요.";
export const REPLY_UNAVAILABLE = "이 서버는 아직 칸에서 보낸 지시를 받지 않아요.";

const KIND_ICON: Record<ToolCardKind, typeof FileText> = {
  read: FileText,
  edit: FilePen,
  execute: SquareTerminal,
  diff: FileDiff,
  search: Search,
  fetch: Globe,
  other: Wrench,
};

const ROW_STATUS: Record<AgentToolCard["state"], SessionStatus> = {
  running: "running",
  pending: "waiting",
  done: "done",
  error: "stopped",
};

function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

export function AgentProgressView({
  model,
  ownerName,
  actions,
  className,
}: {
  model: AgentPaneModel;
  /** 소유자 표시 이름(소유자가 아닌 사람에게 「누구의 확인」을 말할 때). */
  ownerName: string | null;
  actions: AgentPaneActions;
  className?: string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const feedRef = useRef<HTMLOListElement>(null);
  const currentStep = model.plan.find((s) => s.status === "in_progress")?.content ?? null;
  const stickRef = useRef(true);
  // 바닥에 붙어 있을 때만 새 줄을 따라 내려간다. 위로 올려 읽는 중이면 두지 않는다.
  useLayoutEffect(() => {
    const el = feedRef.current?.parentElement;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [model.feed.length]);

  return (
    <div
      className={cn("agent-pane @container flex min-h-0 min-w-0 flex-1 flex-col bg-surface text-ink", className)}
      data-testid="agent-pane"
      data-status={model.status}
    >
      {/* 목표 한 줄은 칸 머리 제목이다(격자가 그린다). 여기는 호스트 · 하네스 · 상태 · 단계. */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-4 py-2">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-ink-muted" data-testid="agent-pane-meta">
          <span className="sr-only" data-testid="agent-pane-goal">{model.goal}</span>
          <span className="truncate">{[model.hostName, model.harness].filter(Boolean).join(" · ")}</span>
          <StatusMark status={model.status} withLabel />
          {model.plan.length > 0 ? (
            <span data-numeric>{`${model.planDone}/${model.plan.length} 단계`}</span>
          ) : null}
        </p>
        {currentStep ? (
          <p className="min-w-0 truncate text-meta text-ink" title={currentStep} data-testid="agent-pane-current-step">
            {`지금: ${currentStep}`}
          </p>
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {model.plan.length > 0 ? <PlanSteps plan={model.plan} /> : null}
        {model.feed.length === 0 ? (
          <p className="px-4 py-3 text-meta text-ink-muted" data-testid="agent-pane-empty">
            에이전트가 첫 단계를 보고하면 여기에 한 줄씩 쌓여요.
          </p>
        ) : (
          <ol ref={feedRef} aria-label="진행" className="flex flex-col py-1" data-testid="agent-pane-feed">
            {model.feed.map((item) => (
              <FeedRow
                key={item.type === "tool" ? item.card.id : item.id}
                item={item}
                expandable={model.viewerIsOwner}
                expanded={open.has(item.type === "tool" ? item.card.id : item.id)}
                onToggle={toggle}
              />
            ))}
          </ol>
        )}
        {model.truncated ? (
          <p className="px-4 pb-2 text-meta text-ink-muted" data-testid="agent-pane-truncated">
            기록이 길어 앞부분만 읽었어요. 최근 진행은 세션 스레드에서 보세요.
          </p>
        ) : null}
        {model.skipped > 0 ? (
          <p className="px-4 pb-2 text-meta text-ink-muted" data-testid="agent-pane-skipped">
            {`알아보지 못한 진행 ${model.skipped}개는 건너뛰었어요.`}
          </p>
        ) : null}
      </div>

      {/* 권한 카드는 진행이 흘러도 밀려나지 않게 답장 칸 바로 위에 붙인다. */}
      {model.permission ? (
        <PermissionCard
          key={model.permission.requestEventId}
          sessionId={model.sessionId}
          permission={model.permission}
          viewerIsOwner={model.viewerIsOwner}
          ownerName={ownerName}
          decide={actions.decide}
        />
      ) : null}

      {model.viewerIsOwner ? (
        <ReplyBox sessionId={model.sessionId} reply={actions.reply} ended={model.status === "done" || model.status === "stopped"} />
      ) : (
        <p className="shrink-0 border-t border-line px-4 py-2 text-meta text-ink-muted" data-testid="agent-pane-reply-owner-only">
          {ownerName ? `${ownerName}만 이 세션에 지시할 수 있어요.` : "소유자만 이 세션에 지시할 수 있어요."}
        </p>
      )}
    </div>
  );
}

function PlanSteps({ plan }: { plan: AgentPaneModel["plan"] }) {
  return (
    <ol aria-label="계획" className="agent-steps flex flex-col border-b border-line px-4 py-2" data-testid="agent-pane-plan">
      {plan.map((step, i) => {
        const status: SessionStatus =
          step.status === "completed" ? "done" : step.status === "in_progress" ? "running" : "idle";
        return (
          <li key={`${i}-${step.content}`} className="agent-step" data-step={step.status}>
            <StatusMark status={status} srLabel />
            <span className="min-w-0 break-words">{step.content}</span>
          </li>
        );
      })}
    </ol>
  );
}

const FeedRow = memo(function FeedRow({
  item,
  expandable,
  expanded,
  onToggle,
}: {
  item: AgentFeedItem;
  expandable: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  if (item.type === "line") {
    return (
      <li className="agent-row" data-kind={item.kind}>
        <StatusMark status={ROW_STATUS[item.state]} srLabel />
        <span className={cn("min-w-0 whitespace-pre-wrap break-words", item.kind === "message" && "text-ink")}>
          {item.text.text}
        </span>
        <time className="agent-time" data-numeric>{clock(item.atMs)}</time>
      </li>
    );
  }
  const card = item.card;
  const Icon = KIND_ICON[card.kind];
  const canOpen = expandable && card.detail !== null;
  const head = (
    <>
      <StatusMark status={ROW_STATUS[card.state]} srLabel />
      <span className="flex min-w-0 items-center gap-2">
        <span className="agent-kind" data-kind={card.kind}>
          <Icon aria-hidden className="size-3" />
          {card.kindLabel}
        </span>
        <span className="min-w-0 truncate">{card.headline}</span>
      </span>
      <span className="flex items-center gap-1">
        <time className="agent-time" data-numeric>{clock(card.atMs)}</time>
        {canOpen ? (
          <ChevronRight aria-hidden className={cn("size-4 text-icon", expanded && "rotate-90")} />
        ) : null}
      </span>
    </>
  );
  return (
    <li className="agent-card" data-kind={card.kind} data-testid="agent-tool-card">
      {canOpen ? (
        <button
          type="button"
          className="agent-row agent-row-button press focus-visible:focus-ring"
          aria-expanded={expanded}
          aria-label={`${card.kindLabel}, ${card.headline}, 원문 보기`}
          onClick={() => onToggle(card.id)}
        >
          {head}
        </button>
      ) : (
        <div className="agent-row">{head}</div>
      )}
      {canOpen && expanded && card.detail ? (
        <div className="agent-raw" data-testid="agent-tool-raw">
          <p className="text-timestamp text-ink-muted">원문 보기 · 나에게만 보여요</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-meta">{card.detail.text}</pre>
          {card.detail.masked > 0 ? (
            <p className="text-timestamp text-ink-muted">{`자격 문자열로 보이는 ${card.detail.masked}곳을 가렸어요.`}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
});

type Armed = "allow" | "reject" | null;

function PermissionCard({
  sessionId,
  permission,
  viewerIsOwner,
  ownerName,
  decide,
}: {
  sessionId: string;
  permission: PendingPermission;
  viewerIsOwner: boolean;
  ownerName: string | null;
  decide: AgentPaneActions["decide"];
}) {
  const [armed, setArmed] = useState<Armed>(null);
  const armedAt = useRef(0);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailableId = useId();
  const ask = permission.tool ? permission.tool.headline : PERMISSION_ASK.other;

  if (!viewerIsOwner) {
    return (
      <section className="agent-perm" aria-label="권한 요청" data-testid="agent-permission">
        <p className="agent-perm-l1">
          <StatusMark status="waiting" srLabel />
          {ask}
        </p>
        <p className="text-meta text-ink-muted" data-testid="agent-permission-waiting">
          {permissionWaitingLine(ownerName)}
        </p>
      </section>
    );
  }

  const arm = (next: Armed) => {
    armedAt.current = Date.now();
    setError(null);
    setArmed(next);
  };
  const commit = async (kind: "allow_once" | "reject_once") => {
    if (Date.now() - armedAt.current < CONFIRM_GUARD_MS) return;
    const choice = kind === "allow_once" ? permission.allow : permission.reject;
    if (!decide || !choice || busy) return;
    if (kind === "allow_once" && !canAllow(permission)) return;
    setBusy(true);
    setError(null);
    try {
      await decide({
        sessionId,
        requestEventId: permission.requestEventId,
        optionId: choice.optionId,
        kind,
        ...(kind === "reject_once" && instruction.trim() !== "" ? { instruction: instruction.trim() } : {}),
      });
      setArmed(null);
    } catch {
      setError("결정을 보내지 못했어요. 호스트가 요청을 거둬들였을 수 있어요. 잠시 뒤 다시 누르세요.");
    } finally {
      setBusy(false);
    }
  };
  // 눌린 채 반복된 keydown은 두 번째 의도가 아니다(ApprovalActions 2R과 같은 규칙).
  const noRepeat = (event: ReactKeyboardEvent) => {
    if (event.repeat) event.preventDefault();
  };
  const allowable = canAllow(permission);
  const unavailable = decide === null;
  const describedBy = unavailable ? unavailableId : undefined;

  return (
    <section className="agent-perm" aria-label="권한 요청" data-testid="agent-permission" data-armed={armed ?? undefined}>
      <p className="agent-perm-l1">
        <StatusMark status="waiting" srLabel />
        {ask}
      </p>
      {permission.preview ? (
        <pre
          tabIndex={0}
          aria-label="요청 미리보기"
          className="agent-perm-code focus-visible:focus-ring"
          data-testid="agent-permission-preview"
        >
          {permission.preview.text}
        </pre>
      ) : null}

      {armed === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={unavailable || !allowable || busy}
            aria-describedby={describedBy}
            onClick={() => arm("allow")}
            data-testid="agent-permission-allow"
          >
            이번 한 번 허락
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={unavailable || permission.reject === null || busy}
            aria-describedby={describedBy}
            onClick={() => arm("reject")}
            data-testid="agent-permission-reject"
          >
            거부하고 지시
          </Button>
          <span className="text-timestamp text-ink-muted">나에게만 보이는 버튼이에요</span>
        </div>
      ) : armed === "allow" ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="agent-permission-confirm">
          <span className="text-meta font-medium">이번 한 번만 허락할까요?</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setArmed(null)}>
            취소
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={busy || !allowable}
            onKeyDown={noRepeat}
            onClick={() => void commit("allow_once")}
            data-testid="agent-permission-commit"
          >
            허락 보내기
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="agent-permission-confirm">
          <label className="flex flex-col gap-1 text-meta font-medium">
            대신 할 일을 적어 주세요(비워 두면 거부만 해요)
            <textarea
              autoFocus
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              className="min-h-control resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-body font-normal text-ink placeholder:text-ink-muted focus-visible:focus-ring"
              placeholder="예: 설치하지 말고 이미 있는 패키지로 고쳐 줘"
              data-testid="agent-permission-instruction"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setArmed(null)}>
              취소
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onKeyDown={noRepeat}
              onClick={() => void commit("reject_once")}
              data-testid="agent-permission-commit"
            >
              거부하고 보내기
            </Button>
          </div>
        </div>
      )}
      {!allowable && !unavailable && permission.allow !== null ? (
        <p className="text-meta text-ink-muted" data-testid="agent-permission-truncated">
          미리보기가 길어 가운데가 잘렸어요. 전체를 보지 않고는 허락할 수 없어요. 거부하거나 호스트에서 결정하세요.
        </p>
      ) : null}
      {permission.allow === null && !unavailable ? (
        <p className="text-meta text-ink-muted">이번 한 번 허락할 선택지가 없어요. 거부하거나 호스트에서 결정하세요.</p>
      ) : null}
      {unavailable ? (
        <p id={unavailableId} className="text-meta text-ink-muted" data-testid="agent-permission-unavailable">
          {DECIDE_UNAVAILABLE}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ReplyBox({
  sessionId,
  reply,
  ended,
}: {
  sessionId: string;
  reply: AgentPaneActions["reply"];
  ended: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const hintId = useId();
  useEffect(() => setNote(null), [text]);
  const unavailable = reply === null;
  const disabled = unavailable || ended || busy;
  const send = async (mode: ReplyMode) => {
    const body = text.trim();
    if (!reply || body === "" || busy) return;
    setBusy(true);
    try {
      await reply({ sessionId, text: body, mode });
      setText("");
      setNote(mode === "queue" ? "다음 차례에 전달돼요." : "지금 차례에 끼어들었어요.");
    } catch {
      setNote("지시를 보내지 못했어요. 호스트 연결을 확인한 뒤 다시 보내세요.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex shrink-0 flex-col gap-1 border-t border-line px-3 pb-2 pt-2"
      data-testid="agent-pane-reply"
      onSubmit={(event) => {
        event.preventDefault();
        void send(DEFAULT_REPLY_MODE);
      }}
    >
      {/* 좁은 칸(448px 미만)에서는 입력이 한 줄을 다 쓰고 버튼이 아래로 내려간다. */}
      <div className="flex flex-wrap items-end justify-end gap-2">
      <textarea
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="다음 지시"
        aria-describedby={hintId}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // ⌘↵: 기본(다음 차례)으로 보낸다. 끼어들기는 키가 없다(명시 버튼만, D4).
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(DEFAULT_REPLY_MODE);
          }
        }}
        className="h-control w-full min-w-0 resize-none @md:w-auto @md:flex-1 rounded-lg border border-line-strong bg-surface px-3 py-1 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={ended ? "끝난 세션이에요" : "다음 지시를 적어요"}
        data-testid="agent-pane-reply-input"
      />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || text.trim() === ""}
          onClick={() => void send("interrupt")}
          data-testid="agent-pane-interrupt"
        >
          지금 끼어들기
        </Button>
        <Button type="submit" size="sm" disabled={disabled || text.trim() === ""} data-testid="agent-pane-queue">
          다음 차례로 보내기
        </Button>
      </div>
      <p id={hintId} className="min-w-0 text-timestamp text-ink-muted" data-testid="agent-pane-reply-hint">
        {unavailable ? REPLY_UNAVAILABLE : note ?? "기본은 다음 차례 예약이에요 · ⌘↵"}
      </p>
    </form>
  );
}
