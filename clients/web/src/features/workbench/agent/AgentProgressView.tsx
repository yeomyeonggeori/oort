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
  PERMISSION_LAPSED_LINE,
  PERMISSION_OFFLINE_LINE,
  PERMISSION_HOST_WAIT_MS,
  canAllow,
  permissionFailure,
  permissionLapsed,
  permissionSentLine,
  permissionWaitingLine,
  rejectWithInstructionLine,
  type AgentFeedItem,
  type AgentPaneModel,
  type AgentToolCard,
  type PendingPermission,
  type ReplyMode,
  type ToolCardKind,
} from "@momo/core/features/workbench/agentPane";
import {
  PERMISSION_PREVIEW_KIND_LABEL,
  PERMISSION_PREVIEW_LOADING_LINE,
  permissionGateAsk,
  permissionPreviewRows,
  type PermissionPreviewGate,
} from "@momo/core/features/workbench/permissionPreviewGate";
import type { PermissionPreview } from "@momo/core/features/workbench/permissionPreview";
import { StatusMark } from "../local/SessionList";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import type { WorkPermissionDecisionBody } from "@momo/core/lib/api";
import {
  NOT_DELIVERED,
  instructionFailureLine,
  type Delivery,
  type PermissionScope,
  type RejectWithInstructionOutcome,
} from "@momo/core/features/auth/signedControl";
import {
  INSTRUCT_IN_APP_LINE,
  humanSignatureRefusal,
  type InstructFrom,
} from "@momo/core/features/auth/humanSignature";
import "./agentPane.css";

// Reading this as: 작업 공간 A 칸 진행 뷰(에이전트 작업 레인 한 세션) for internal
// team users on web+Tauri, density 7/10, motion 1/10.
//
// 제안서 §3.3 (4)와 시안 ⑤ 스레드 root 카드(`.wcard` · `.pwaitc` · `.sysl` · `.comp`)를
// 격자 칸 안에 옮긴다. 칸 머리(번호·이름·상태·레인)는 격자가 그린다.
//
// - 위: 목표 한 줄, 호스트 · 하네스, 계획 진행.
// - 가운데: ACP plan 단계 목록, tool-call은 접힌 카드. 펼치기(「원문 보기」)는 소유자만.
// - 권한 카드: 「이번 한 번 허락」·「거부」(ADR-0188 D5). 서명하는 표면이 서명을
//   요구하는 서버에 있으면(R2-E8 #3028) 「이 세션 동안 허락」과 「거부 + 지시」(거부
//   확인 칸의 선택 입력)가 더해진다. 두 번 눌러야
//   결정한다(무장 → 확정, 무장 직후 400ms와 키 반복은 받지 않는다). 결정은 사람이
//   확정 버튼을 눌렀을 때만 만든다. 마운트·다시 그리기·이벤트 재전달에는 부르지 않는다.
//   결정은 #3000 라우트로 간다(§8.6, 골든 work-permission-decision). 지시를 붙인
//   거부는 R2까지 서버가 400으로 거부하므로 입력 칸도 두지 않는다(#3013).
// - 아래: 답장 칸. 기본은 다음 차례 예약, 끼어들기는 따로 누르는 버튼(D4).
// - 일반 브라우저 + 서명을 요구하는 서버(`instructFrom` = "app", ADR-0146 개정 D-4):
//   「이번 한 번 허락」과 답장 칸은 「폰이나 데스크탑 앱에서 보내 주세요」로 바뀐다.
//   거부는 그대로다(거부는 서명하지 않는다). 두 자리는 같은 값 하나를 읽는다(#3029).
//
// 모든 글은 React 텍스트 노드로 그린다. HTML로 해석하는 자리가 없다.

/**
 * 칸이 만드는 결정. `sessionId`는 경로로, 나머지 셋이 본문 전부다(골든). 지시문
 * 자리는 없다: 서버가 R2 전까지 비어 있지 않은 `instruction`을 400으로 거부한다.
 */
export interface PermissionDecision extends Omit<WorkPermissionDecisionBody, "humanSignature"> {
  sessionId: string;
  /** 허락의 범위. 서명하는 경로만 `session`을 받는다(#3028). */
  scope?: PermissionScope;
  /**
   * 서명하는 허락(#3128, control v3): 카드가 보여 주고 확인한 host 미리보기와 앱이
   * 다시 계산한 해시. 서명 경로는 이것 없이는 서명하지 않는다.
   */
  preview?: { preview: PermissionPreview; sha256: string };
}

export interface RejectWithInstructionRequest {
  sessionId: string;
  requestEventId: string;
  optionId: string;
  text: string;
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
  /** 서명한 지시는 닿았는지(`Delivery`)를 돌려준다. 닿지 않으면 「전달 안 됨」. */
  reply: ((reply: AgentReply) => Promise<Delivery | void>) | null;
  /** 「이 세션 동안 허락」을 낼 수 있다(서명하는 표면 + 서명을 요구하는 서버). */
  sessionScope?: boolean;
  /** 「거부 + 지시」: 서명 없는 거부 + 서명한 지시. 없으면 거부만. */
  rejectWithInstruction?: ((request: RejectWithInstructionRequest) => Promise<RejectWithInstructionOutcome>) | null;
}

export const DECIDE_UNAVAILABLE = "이 서버는 아직 칸에서 한 권한 결정을 받지 않아요. 결정 경로가 열리면 여기서 허락할 수 있어요.";
export const CRAMPED_LINE = "칸을 키우면(⌘⇧↵) 결정할 수 있어요.";

/**
 * 칸 높이가 이보다 낮으면 권한 카드가 질문·미리보기·결정 칸을 함께 보일 수 없다
 * (격자 반 높이의 900×700 창에서 진행 뷰 약 270). 1280×800 반 높이(약 318)는 넘는다.
 */
const CRAMPED_HEIGHT = 290;

function useCramped(ref: React.RefObject<HTMLElement>): boolean {
  const [cramped, setCramped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setCramped(el.getBoundingClientRect().height < CRAMPED_HEIGHT && el.getBoundingClientRect().height > 0);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return cramped;
}

export const REPLY_UNAVAILABLE = "이 서버는 아직 칸에서 보낸 지시를 받지 않아요.";

/** 브라우저에서 허락을 누를 수 없는 이유(D-4). 거부는 여기서 된다고 함께 말한다. */
export const ALLOW_IN_APP_LINE = `이번 한 번 허락은 ${INSTRUCT_IN_APP_LINE}. 거부는 여기서도 할 수 있어요.`;
/** 브라우저의 답장 칸(D-4). 어디서 보내는지는 힌트가, 여기서 안 되는 것은 자리 표시 글이 말한다. */
export const REPLY_IN_APP_HINT = `지시는 ${INSTRUCT_IN_APP_LINE}`;
export const REPLY_IN_APP_PLACEHOLDER = "브라우저에서는 지시를 보낼 수 없어요";

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
  offline = false,
  instructFrom = "here",
  previewGate = null,
  className,
}: {
  model: AgentPaneModel;
  /** 소유자 표시 이름(소유자가 아닌 사람에게 「누구의 확인」을 말할 때). */
  ownerName: string | null;
  actions: AgentPaneActions;
  /** 실시간 연결이 끊겼다. 결정은 잠그고 이유를 한 줄로 말한다. */
  offline?: boolean;
  /**
   * 허락·지시를 이 화면에서 보내는가(`here`), 앱에서 보내라고 안내하는가(`app`).
   * 권한 카드와 답장 칸이 이 한 값을 함께 읽는다(ADR-0146 개정 D-4, #3029).
   */
  instructFrom?: InstructFrom;
  /**
   * 서명하는 표면(#3128): 소유자 조회로 받은 host 미리보기의 허락 문. 있으면 권한
   * 카드는 추론한 미리보기 대신 이것을 그대로 보이고, `ready`일 때만 허락을 연다.
   * null이면 서명하지 않는 표면이다(지금 그대로).
   */
  previewGate?: PermissionPreviewGate | null;
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

  const [planOpen, setPlanOpen] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  // 권한 카드의 결과 문장은 칸 수준에서 읽힌다: 서버의 `approval.decided`가 오면 카드는
  // 곧바로 사라지므로, 카드 안의 status 줄은 읽히기 전에 없어진다(design-review H1).
  const [announce, setAnnounce] = useState("");
  const [replySeed, setReplySeed] = useState<{ text: string } | null>(null);
  // 확정 버튼(또는 카드)에 있던 캐럿이 카드와 함께 사라지면 칸이 받는다(body로 떨어지지 않게).
  const catchFocus = useCallback(() => {
    queueMicrotask(() => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (root && (!active || active === document.body || !active.isConnected)) root.focus({ preventScroll: true });
    });
  }, []);
  const cramped = useCramped(rootRef);
  const planId = useId();

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-cramped={cramped ? "" : undefined}
      className={cn("agent-pane flex min-h-0 min-w-0 flex-1 flex-col bg-surface text-ink focus-visible:focus-ring", className)}
      data-testid="agent-pane"
      data-status={model.status}
    >
      <p role="status" className="sr-only" data-testid="agent-pane-announce">
        {announce}
      </p>
      {/* 목표 한 줄은 칸 머리 제목이다(격자가 그린다). 여기는 호스트 · 하네스 · 상태 · 단계. */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-4 py-2">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-ink-muted" data-testid="agent-pane-meta">
          <span className="sr-only" data-testid="agent-pane-goal">{model.goal}</span>
          <span className="truncate">{[model.hostName, model.harness].filter(Boolean).join(" · ")}</span>
          <span className="flex items-center gap-1" data-testid="agent-pane-status">
            {/* 관전자가 보는 「소유자 확인 기다림」은 도는 표지가 아니라 빈 원(대기)이다. */}
            <StatusMark status={model.permission && !model.viewerIsOwner ? "idle" : model.status} />
            <span className="font-semibold">{model.statusLabel}</span>
          </span>
          {model.plan.length > 0 ? (
            <button
              type="button"
              className="agent-plan-toggle press focus-visible:focus-ring"
              aria-expanded={planOpen}
              aria-controls={planId}
              onClick={() => setPlanOpen((v) => !v)}
              data-testid="agent-pane-plan-toggle"
            >
              <span data-numeric>{`계획 ${model.planDone}/${model.plan.length} 단계`}</span>
              <ChevronRight aria-hidden className={cn("size-3", planOpen && "rotate-90")} />
            </button>
          ) : null}
        </p>
        {currentStep ? (
          <p
            className="agent-current min-w-0 truncate text-meta text-ink"
            title={currentStep}
            data-plan-open={planOpen ? "" : undefined}
            data-testid="agent-pane-current-step"
          >
            {`지금: ${currentStep}`}
          </p>
        ) : null}
      </div>
      {/* 계획은 진행이 흘러도 밀려나지 않게 머리 아래에 붙인다(design-review R1 M4). */}
      {model.plan.length > 0 && planOpen ? <PlanSteps id={planId} plan={model.plan} /> : null}

      <div
        className="agent-scroll overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
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

      {/*
        권한 카드는 진행 줄과 답장 칸 사이에 붙는다. 칸이 낮으면 진행 줄이 두 줄(바닥)까지
        먼저 줄고, 그다음 카드가 줄며 카드 안이 스크롤된다. 질문 줄과 버튼 줄은 카드
        안에서 위아래로 붙어 늘 보인다(design-review R1·R2 B1).
      */}
      {model.permission ? (
        <PermissionCard
          key={model.permission.requestEventId}
          sessionId={model.sessionId}
          permission={model.permission}
          gate={previewGate}
          viewerIsOwner={model.viewerIsOwner}
          ownerName={ownerName}
          decide={actions.decide}
          sessionScope={actions.sessionScope === true}
          rejectWithInstruction={actions.rejectWithInstruction ?? null}
          cramped={cramped}
          offline={offline}
          inApp={instructFrom === "app"}
          onOutcome={setAnnounce}
          onUndelivered={(text) => setReplySeed({ text })}
          onLeave={catchFocus}
        />
      ) : null}

      {model.viewerIsOwner ? (
        <>
          <ReplyBox
            seed={replySeed}
            sessionId={model.sessionId}
            reply={actions.reply}
            ended={model.status === "done" || model.status === "stopped"}
            inApp={instructFrom === "app"}
          />
          {/* 낮은 칸에서 권한 카드가 있으면 답장 칸 대신 이 한 줄이 보인다(agentPane.css). */}
          <p className="agent-reply-collapsed shrink-0 border-t border-line px-4 py-1 text-timestamp text-ink-muted">
            답장 칸은 칸을 키우면 보여요 · ⌘⇧↵ 최대화
          </p>
        </>
      ) : (
        <p className="shrink-0 border-t border-line px-4 py-2 text-meta text-ink-muted" data-testid="agent-pane-reply-owner-only">
          {ownerName ? `${ownerName}만 이 세션에 지시할 수 있어요.` : "소유자만 이 세션에 지시할 수 있어요."}
        </p>
      )}
    </div>
  );
}

function PlanSteps({ id, plan }: { id: string; plan: AgentPaneModel["plan"] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const current = plan.findIndex((s) => s.status !== "completed");
  // 계획 칸이 낮아 몇 줄만 보일 때 지금 단계가 보이게 한다(칸 밖은 움직이지 않는다).
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = current >= 0 ? (list?.children[current] as HTMLElement | undefined) : undefined;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top + row.offsetHeight > list.scrollTop + list.clientHeight || top < list.scrollTop) {
      list.scrollTop = Math.max(0, top - row.offsetHeight);
    }
  }, [current, plan.length]);
  return (
    <ol ref={listRef} id={id} aria-label="계획" className="agent-steps flex shrink-0 flex-col border-b border-line px-4 py-2" data-testid="agent-pane-plan">
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

const SEND_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘↵"
    : "Ctrl+↵";

type Armed = "allow" | "allow_session" | "reject" | null;

/** 미리보기 칸이 한 번에 보이는 줄 수(agentPane.css `.agent-perm-code`와 같다). */
const PREVIEW_LINES = 3;

function previewLines(text: string): number {
  return text.split("\n").length;
}

/**
 * 결정을 보낸 뒤의 카드: 보냈다(`sent`), 다시 눌러도 소용없다(`closed`), 거부는 갔지만
 * 함께 보낸 지시가 닿지 않았다(`partial`, 「전달 안 됨」).
 */
type Outcome = { tone: "sent" | "closed" | "partial"; text: string } | null;

/** 요청이 host 대기 시간을 넘기는 순간 한 번 다시 그린다(주기 타이머가 아니다). */
function useLapsed(atMs: number): boolean {
  const [lapsed, setLapsed] = useState(() => permissionLapsed({ atMs }, Date.now()));
  useEffect(() => {
    if (lapsed) return;
    const left = atMs + PERMISSION_HOST_WAIT_MS - Date.now();
    if (left <= 0) {
      setLapsed(true);
      return;
    }
    const timer = setTimeout(() => setLapsed(true), left);
    return () => clearTimeout(timer);
  }, [atMs, lapsed]);
  return lapsed;
}

/** 확인한 미리보기 칸의 줄 수(종류 한 줄 + 필드마다 표지 한 줄과 글). */
function gatedLines(preview: PermissionPreview): number {
  return permissionPreviewRows(preview).reduce((n, row) => n + 1 + previewLines(row.text), 1);
}

/** 확인한 host 미리보기: 종류 표지와 필드를 그대로(#3128). 렌더가 곧 해시한 글이다. */
function GatedPreview({ preview }: { preview: PermissionPreview }) {
  return (
    <div
      tabIndex={0}
      aria-label="요청 미리보기"
      className="agent-perm-code focus-visible:focus-ring"
      data-testid="agent-permission-preview"
      data-kind={preview.kind}
    >
      <p className="agent-perm-kind">{PERMISSION_PREVIEW_KIND_LABEL[preview.kind]}</p>
      {permissionPreviewRows(preview).map((row) => (
        <div key={row.key} className="agent-perm-field">
          <p className="agent-perm-field-label">{row.label}</p>
          <p className="agent-perm-field-text" data-testid={`agent-permission-preview-${row.key}`}>
            {row.text}
          </p>
        </div>
      ))}
    </div>
  );
}

function PermissionCard({
  sessionId,
  permission,
  gate,
  viewerIsOwner,
  ownerName,
  decide,
  sessionScope,
  rejectWithInstruction,
  cramped,
  offline,
  inApp,
  onOutcome,
  onUndelivered,
  onLeave,
}: {
  sessionId: string;
  permission: PendingPermission;
  /** 서명하는 표면의 미리보기 허락 문(#3128). null이면 서명하지 않는 표면. */
  gate: PermissionPreviewGate | null;
  viewerIsOwner: boolean;
  ownerName: string | null;
  decide: AgentPaneActions["decide"];
  sessionScope: boolean;
  rejectWithInstruction: NonNullable<AgentPaneActions["rejectWithInstruction"]> | null;
  /** 칸이 너무 낮아 요청과 결정 칸을 함께 보일 수 없다. */
  cramped: boolean;
  /** 실시간 연결이 끊겼다. */
  offline: boolean;
  /** 이 브라우저는 허락을 보낼 수 없다(D-4). 거부는 그대로. */
  inApp: boolean;
  /** 결과 문장을 칸의 live region으로 올린다. */
  onOutcome: (text: string) => void;
  /** 「거부 + 지시」의 지시가 닿지 않았다: 쓴 글을 지시 칸으로 옮긴다(D-5b). */
  onUndelivered: (text: string) => void;
  /** 카드가 캐럿을 품은 채 사라진다. */
  onLeave: () => void;
}) {
  const [armed, setArmed] = useState<Armed>(null);
  const lapsed = useLapsed(permission.atMs);
  // 무장한 채 칸이 낮아지거나, 연결이 끊기거나, 요청이 닫히면 푼다(보이지 않거나
  // 누를 수 없는 확정 버튼을 남기지 않는다).
  useEffect(() => {
    if ((cramped || offline || lapsed) && armed !== null) setArmed(null);
  }, [cramped, offline, lapsed, armed]);
  const armedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [rejectNote, setRejectNote] = useState("");
  const unavailableId = useId();
  const rejectNoteId = useId();
  const rejectHintId = useId();
  const allowRef = useRef<HTMLButtonElement>(null);
  const sessionRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // 허락을 보낸 뒤 서버가 서명을 요구한다고 답해 칸이 안내로 바뀌면(#3029): 허락 무장을
  // 풀고 캐럿을 카드로 옮기며, 같은 말을 하는 오류 줄은 안내 줄 하나로 줄인다(review M1).
  useEffect(() => {
    if (!inApp) return;
    setError(null);
    if (armed === "allow" || armed === "allow_session") {
      setArmed(null);
      sectionRef.current?.focus({ preventScroll: true });
    }
  }, [inApp, armed]);
  /** 무장을 풀면 캐럿을 누른 버튼으로 돌려준다(design-review R1 M3). */
  const returnTo = useRef<Armed>(null);
  useEffect(() => {
    if (armed !== null || returnTo.current === null) return;
    const target =
      returnTo.current === "allow"
        ? allowRef.current
        : returnTo.current === "allow_session"
          ? sessionRef.current
          : rejectRef.current;
    returnTo.current = null;
    (target && !target.disabled ? target : sectionRef.current)?.focus({ preventScroll: true });
  }, [armed]);
  // 확정 버튼이 사라지면 캐럿이 body로 떨어지지 않게 카드가 받는다. 결과 문장은 칸이 읽는다.
  useEffect(() => {
    if (outcome) sectionRef.current?.focus({ preventScroll: true });
  }, [outcome]);
  // 카드가 내려갈 때(서버의 `approval.decided`) 캐럿이 안에 있었으면 칸이 받는다.
  useLayoutEffect(() => {
    const section = sectionRef;
    return () => {
      const el = section.current;
      if (el && el.contains(document.activeElement)) onLeave();
    };
  }, [onLeave]);
  // 서명하는 표면의 질문은 확인한 미리보기의 종류에서만 고른다(#3118 H1: 추론 금지).
  const ask = gate ? permissionGateAsk(gate) : permission.tool ? permission.tool.headline : PERMISSION_ASK.other;
  const checked = gate?.state === "ready" ? gate : null;
  const shown = gate?.state === "ready" || gate?.state === "blocked" ? gate.preview : null;

  if (!viewerIsOwner) {
    return (
      <section className="agent-perm" aria-label="권한 요청" data-testid="agent-permission">
        <p className="agent-perm-l1">
          <StatusMark status="waiting" srLabel />
          {ask}
        </p>
        <p className="text-meta text-ink-muted" data-testid="agent-permission-waiting">
          {lapsed ? PERMISSION_LAPSED_LINE : permissionWaitingLine(ownerName)}
        </p>
      </section>
    );
  }

  // 보냈거나 닫힌 요청: 버튼을 거둔다. 서버의 `approval.decided`가 오면 카드 자체가
  // 사라진다(모든 소유자 기기의 카드가 같은 이벤트로 닫힌다, §8.6).
  // 보내는 중에 만료되면 응답이 결론을 낸다(두 문장이 차례로 뒤집히지 않게, review M5).
  const settled: Outcome = outcome ?? (lapsed && !busy ? { tone: "closed", text: PERMISSION_LAPSED_LINE } : null);
  if (settled) {
    return (
      <section
        ref={sectionRef}
        tabIndex={-1}
        className="agent-perm focus-visible:focus-ring"
        aria-label="권한 요청"
        data-testid="agent-permission"
        data-settled={settled.tone}
      >
        <p className="agent-perm-l1 agent-perm-sticky-top">
          {/* 닫힘은 실패가 아니다(다른 기기가 허락했을 수도 있다): 중립 빈 원. */}
          {/* partial: 거부는 갔다(완료). 닿지 않은 것은 지시이고, 문장이 danger로 말한다. */}
          <StatusMark status={settled.tone === "closed" ? "idle" : "done"} srLabel />
          {ask}
        </p>
        <p
          className={cn("agent-perm-settled break-keep text-meta", settled.tone === "partial" ? "text-danger" : "text-ink")}
          role={settled.tone === "partial" ? "alert" : undefined}
          data-testid="agent-permission-outcome"
        >
          {settled.text}
        </p>
      </section>
    );
  }

  const disarm = () => {
    returnTo.current = armed;
    setArmed(null);
  };
  const arm = (next: Armed) => {
    armedAt.current = Date.now();
    setError(null);
    setArmed(next);
  };
  const commit = async (kind: "allow_once" | "reject_once", scope: PermissionScope = "once") => {
    if (Date.now() - armedAt.current < CONFIRM_GUARD_MS) return;
    const choice = kind === "allow_once" ? permission.allow : permission.reject;
    if (!decide || !choice || busy || cramped || offline) return;
    if (permissionLapsed(permission, Date.now())) return;
    if (kind === "allow_once" && (inApp || !canAllow(permission))) return;
    if (kind === "allow_once" && gate && !checked) return;
    if (scope === "session" && !sessionScope) return;
    const note = kind === "reject_once" && rejectWithInstruction ? rejectNote.trim() : "";
    setBusy(true);
    setError(null);
    try {
      if (note !== "" && rejectWithInstruction) {
        // 「거부 + 지시」: 서명이 먼저다. 취소하면 거부도 보내지 않는다(signedControl).
        const out = await rejectWithInstruction({
          sessionId,
          requestEventId: permission.requestEventId,
          optionId: choice.optionId,
          text: note,
        });
        if (out.state === "not_sent") {
          setError(`${NOT_DELIVERED} · ${out.text}`);
          return;
        }
        if (out.state === "reject_failed") throw out.error;
        const delivered = out.instruction.state === "sent";
        if (!delivered) onUndelivered(note);
        const line = rejectWithInstructionLine(
          delivered,
          out.instruction.state === "not_delivered" ? out.instruction.text : undefined
        );
        // partial은 카드 문장이 role=alert로 직접 말한다(두 번 읽히지 않게, review R2 L-1).
        if (delivered) onOutcome(line);
        setOutcome({ tone: delivered ? "sent" : "partial", text: line });
        return;
      }
      // 같은 결정을 다시 보내면 서버가 200으로 같은 행을 준다.
      await decide({
        sessionId,
        requestEventId: permission.requestEventId,
        optionId: choice.optionId,
        kind,
        ...(kind === "allow_once" ? { scope } : {}),
        ...(kind === "allow_once" && checked ? { preview: { preview: checked.preview, sha256: checked.sha256 } } : {}),
      });
      // 칸에 먼저 올린다: 실시간 `approval.decided`가 응답보다 먼저 와 카드가 이미
      // 내려갔어도 결과는 읽힌다(design-review R2 Low).
      onOutcome(permissionSentLine(kind, scope));
      setOutcome({ tone: "sent", text: permissionSentLine(kind, scope) });
    } catch (err) {
      const failure = permissionFailure(err);
      if (failure.closed) {
        onOutcome(failure.text);
        setOutcome({ tone: "closed", text: failure.text });
      } else setError(failure.text);
    } finally {
      setBusy(false);
    }
  };
  // 눌린 채 반복된 keydown은 두 번째 의도가 아니다(ApprovalActions 2R과 같은 규칙).
  const noRepeat = (event: ReactKeyboardEvent) => {
    if (event.repeat) event.preventDefault();
  };
  const allowable = gate ? checked !== null && permission.allow !== null && !inApp : canAllow(permission) && !inApp;
  const unavailable = decide === null;
  // 낮은 칸에서는 요청을 다 보이지 못하므로 결정도 받지 않는다(design-review R3 B1).
  // 연결이 끊기면 결정이 닿았는지 알 길(실시간 `approval.decided`)이 없으므로 잠근다.
  const blocked = unavailable || cramped || offline;
  const describedBy = blocked ? unavailableId : undefined;
  const reason = unavailable ? DECIDE_UNAVAILABLE : offline ? PERMISSION_OFFLINE_LINE : CRAMPED_LINE;
  // 브라우저의 허락(D-4): 허락만 잠그고 한 줄로 말한다. 거부는 잠그지 않는다.
  const inAppLine = inApp && !blocked && permission.allow !== null;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="agent-perm focus-visible:focus-ring"
      aria-label="권한 요청"
      data-testid="agent-permission"
      data-armed={armed ?? undefined}
      onKeyDown={(event) => {
        // 무장한 행은 제자리 확인이라 대화상자의 Esc를 공짜로 받지 못한다. 여기서 푼다.
        if (event.key !== "Escape" || armed === null || busy) return;
        event.preventDefault();
        event.stopPropagation();
        disarm();
      }}
    >
      <p className="agent-perm-l1 agent-perm-sticky-top">
        <StatusMark status="waiting" srLabel />
        {ask}
      </p>
      {/* 누를 수 없는 이유는 질문 바로 밑에 한 줄로(버튼 뒤에 두면 잘린다, design-review R4). */}
      {blocked ? (
        <p
          id={unavailableId}
          className={cn("break-keep text-meta text-ink-muted", cramped && "truncate")}
          data-testid="agent-permission-unavailable"
        >
          {reason}
        </p>
      ) : null}
      {inAppLine ? (
        <p id={unavailableId} className="break-keep text-meta text-ink-muted" data-testid="agent-permission-in-app">
          {ALLOW_IN_APP_LINE}
        </p>
      ) : null}
      {gate ? (
        shown ? (
          <GatedPreview preview={shown} />
        ) : null
      ) : permission.preview ? (
        <pre
          tabIndex={0}
          aria-label="요청 미리보기"
          className="agent-perm-code focus-visible:focus-ring"
          data-testid="agent-permission-preview"
        >
          {permission.preview.text}
        </pre>
      ) : null}
      {shown && gatedLines(shown) > PREVIEW_LINES ? (
        <p className="text-timestamp text-ink-muted" data-testid="agent-permission-more">
          {`전체 ${gatedLines(shown)}줄 · 미리보기 칸을 스크롤해서 끝까지 보세요`}
        </p>
      ) : null}
      {!gate && permission.preview && previewLines(permission.preview.text) > PREVIEW_LINES ? (
        <p className="text-timestamp text-ink-muted" data-testid="agent-permission-more">
          {`전체 ${previewLines(permission.preview.text)}줄 · 미리보기 칸을 스크롤해서 끝까지 보세요`}
        </p>
      ) : null}

      {armed === null ? (
        <div className="agent-perm-sticky-bottom flex flex-wrap items-center gap-2">
          <Button
            ref={allowRef}
            type="button"
            size="sm"
            className="tap-target"
            disabled={blocked || !allowable || busy}
            aria-describedby={inAppLine ? unavailableId : describedBy}
            onClick={() => arm("allow")}
            data-testid="agent-permission-allow"
          >
            이번 한 번 허락
          </Button>
          {sessionScope ? (
            <Button
              ref={sessionRef}
              type="button"
              size="sm"
              variant="secondary"
              className="tap-target"
              disabled={blocked || !allowable || busy}
              aria-describedby={inAppLine ? unavailableId : describedBy}
              onClick={() => arm("allow_session")}
              data-testid="agent-permission-allow-session"
            >
              이 세션 동안 허락
            </Button>
          ) : null}
          <Button
            ref={rejectRef}
            type="button"
            size="sm"
            variant="secondary"
            className="tap-target"
            disabled={blocked || permission.reject === null || busy}
            aria-describedby={describedBy}
            onClick={() => arm("reject")}
            data-testid="agent-permission-reject"
          >
            거부
          </Button>
          {blocked ? null : <span className="text-timestamp text-ink-muted">나에게만 보이는 버튼이에요</span>}
        </div>
      ) : (
        <div className="agent-perm-sticky-bottom flex flex-col gap-2" data-testid="agent-permission-confirm">
          {armed === "reject" && rejectWithInstruction ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={rejectNoteId} className="text-meta text-ink">
                거부하면서 보낼 지시 <span className="text-ink-muted">(비우면 거부만 보내요)</span>
              </label>
              <textarea
                id={rejectNoteId}
                // 확정 버튼 대신 이 칸이 캐럿을 받는다(누른 「거부」가 사라진다, design-review H1).
                autoFocus
                aria-describedby={rejectHintId}
                rows={2}
                value={rejectNote}
                disabled={busy}
                onChange={(event) => setRejectNote(event.target.value)}
                className="w-full min-w-0 resize-none rounded-lg border border-line-strong bg-surface px-3 py-1 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-60"
                placeholder="예: 그 파일 말고 테스트만 고쳐 줘"
                data-testid="agent-permission-reject-note"
              />
              <p id={rejectHintId} className="text-timestamp text-ink-muted">
                지시는 기기 서명을 거쳐 다음 차례에 전달돼요.
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta font-medium">
              {armed === "allow"
                ? "이번 한 번만 허락할까요?"
                : armed === "allow_session"
                  ? "이 세션이 끝날 때까지 같은 요청을 허락할까요?"
                  : "이번 요청을 거부할까요?"}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={disarm} disabled={busy}>
              취소
            </Button>
            <Button
              type="button"
              size="sm"
              variant={armed === "reject" ? "destructive" : "default"}
              autoFocus={!(armed === "reject" && rejectWithInstruction)}
              disabled={busy || (armed !== "reject" && !allowable)}
              onKeyDown={noRepeat}
              onClick={() =>
                void (armed === "reject"
                  ? commit("reject_once")
                  : commit("allow_once", armed === "allow_session" ? "session" : "once"))
              }
              data-testid="agent-permission-commit"
            >
              {armed === "allow" || armed === "allow_session"
                ? "허락 보내기"
                : rejectNote.trim() !== "" && rejectWithInstruction
                  ? "거부하고 지시 보내기"
                  : "거부 보내기"}
            </Button>
          </div>
        </div>
      )}
      {gate && !inApp && !blocked && permission.allow !== null && gate.state !== "ready" ? (
        <p className="break-keep text-meta text-ink-muted" data-testid="agent-permission-preview-state">
          {gate.state === "loading" ? PERMISSION_PREVIEW_LOADING_LINE : gate.line}
        </p>
      ) : null}
      {!gate && !inApp && !allowable && !blocked && permission.allow !== null ? (
        <p className="text-meta text-ink-muted" data-testid="agent-permission-truncated">
          미리보기가 길어 가운데가 잘렸어요. 전체를 보지 않고는 허락할 수 없어요. 거부하거나 호스트에서 결정하세요.
        </p>
      ) : null}
      {permission.allow === null && !blocked ? (
        <p className="text-meta text-ink-muted">이번 한 번 허락할 선택지가 없어요. 거부하거나 호스트에서 결정하세요.</p>
      ) : null}
      {error ? (
        <p role="alert" className="break-keep text-meta text-danger" data-testid="agent-permission-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ReplyBox({
  seed,
  sessionId,
  reply,
  ended,
  inApp,
}: {
  /** 닿지 않은 「거부 + 지시」의 글. 칸이 비어 있으면 옮겨 담는다. */
  seed: { text: string } | null;
  sessionId: string;
  reply: AgentPaneActions["reply"];
  ended: boolean;
  /** 이 브라우저는 지시를 보낼 수 없다(D-4). 경로가 있어도 보내지 않는다. */
  inApp: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 서명한 지시가 닿지 않았다(D-5b 「전달 안 됨」). 글은 칸에 남긴다. */
  const [failed, setFailed] = useState(false);
  const hintId = useId();
  useEffect(() => {
    setNote(null);
    setFailed(false);
  }, [text]);
  useEffect(() => {
    // 칸에 쓰던 글이 있어도 잃지 않는다: 뒤에 붙인다(design-review R2 M-1).
    if (seed) setText((current) => (current.trim() === "" ? seed.text : `${current.trimEnd()}\n${seed.text}`));
  }, [seed]);
  const unavailable = reply === null;
  const disabled = inApp || unavailable || ended || busy;
  const send = async (mode: ReplyMode) => {
    const body = text.trim();
    if (inApp || !reply || body === "" || busy) return;
    setBusy(true);
    try {
      const out = await reply({ sessionId, text: body, mode });
      if (out && out.state === "not_delivered") {
        // 글을 지우지 않는다: 그대로 다시 보낼 수 있다. 채팅으로 조용히 남기지 않는다.
        setNote(`${NOT_DELIVERED} · ${out.text}`);
        setFailed(true);
        return;
      }
      setText("");
      setNote(mode === "queue" ? "다음 차례에 전달돼요." : "지금 차례에 끼어들었어요.");
    } catch (err) {
      setNote(`${NOT_DELIVERED} · ${humanSignatureRefusal(err)?.text ?? instructionFailureLine(err)}`);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="agent-reply flex shrink-0 flex-col gap-1 border-t border-line px-3 pb-2 pt-2"
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
        placeholder={ended ? "끝난 세션이에요" : inApp ? REPLY_IN_APP_PLACEHOLDER : "다음 지시를 적어요"}
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
      <p
        id={hintId}
        className={cn("agent-reply-hint min-w-0 text-timestamp", failed ? "text-danger" : "text-ink-muted")}
        data-testid="agent-pane-reply-hint"
        data-in-app={inApp ? "" : undefined}
        data-failed={failed ? "" : undefined}
        role={failed ? "alert" : undefined}
      >
        {inApp ? REPLY_IN_APP_HINT : unavailable ? REPLY_UNAVAILABLE : note ?? `기본은 다음 차례 예약이에요 · ${SEND_KEY}`}
      </p>
    </form>
  );
}
