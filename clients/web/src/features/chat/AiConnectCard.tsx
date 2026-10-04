import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, Eye, KeyRound, Lock, Plug, RefreshCw, X } from "lucide-react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import type { AiConnectLine } from "@momo/core/features/commands/registry";
import { AI_HUB_NAV_COPY } from "@momo/core/features/ai/aiHubModel";
import { AI_CONNECT_HUB_PATH } from "@momo/core/features/commands/registry";
import {
  AI_CONNECT_ROW_COPY,
  AI_CONNECT_SERVER_OFF_NOTE,
  HARNESS_INSTALL_URL,
  HARNESS_LABEL,
  type HarnessPill,
} from "@momo/core/features/onboarding/aiConnect";
import { loginActionLabel } from "@momo/core/features/onboarding/harnessLogin";
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import {
  harnessPillView,
  isLegacyTeamLink,
  linkPill,
  PROBE_NOT_RUN,
} from "@momo/core/features/settings/aiLinkPill";
import { errorMessage, isOperatorDenied, maskedBearer } from "@momo/core/features/settings/model";
import { teamCheckClock, teamCheckResult, teamCheckSince } from "@momo/core/features/settings/teamKeyForm";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";
import { AiLogo, AiPill, AiSource, CheckNumbers, CheckSentence } from "@/features/settings/aiAccountsParts";
import { TeamKeyForm } from "@/features/settings/TeamKeyForm";
import {
  MY_ACCOUNTS_BROWSER_LINE,
  MY_ACCOUNTS_DENIED_DETAIL,
  MY_ACCOUNTS_EMPTY_DETAIL,
  MY_ACCOUNTS_EMPTY_LINE,
  myAccountsBrowserTab,
  readProbeFixture,
} from "@/features/settings/aiMyAccountsModel";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { useOffline } from "@/features/common/useOffline";
import { useSession } from "@/app/session";
import { seedComposerText, seedThreadComposerText } from "@/features/chat/draftStore";
import type { Directory } from "@momo/core/features/workspace/directory";
import {
  COMMAND_SUGGEST_ASK_BUSY,
  COMMAND_SUGGEST_ASK_NONE,
  COMMAND_SUGGEST_ASK_OPERATOR,
  COMMAND_SUGGEST_ASK_THREAD,
  COMMAND_SUGGEST_ONLY_ME,
  COMMAND_SUGGEST_TEAM_CLOSE,
  COMMAND_SUGGEST_TEAM_OPEN,
  commandSuggestHead,
  commandSuggestOneLine,
  commandSuggestViewer,
  operatorMentionDraft,
  type CommandSuggestCard,
} from "@momo/core/features/timeline/commandSuggest";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import {
  HarnessLoginDialog,
  type HarnessLoginFixture,
} from "@/features/welcome/harnessLogin/HarnessLoginDialog";
import { useRegisterContext } from "@/features/welcome/harnessLogin/useRegisterContext";
import {
  isRegisterPose,
  registerPoseFixture,
  type RegisterPose,
} from "@/features/welcome/harnessLogin/registerFixtures";
import { START_CREATE_LABEL } from "@momo/core/features/onboarding/subscriptionRegister";

// Reading this as: agent card family (local tool card at the timeline tail) for
// internal team users on web+Tauri, density 6/10, motion 2/10.

// =============================================================================
// 채팅의 로컬 연결 카드 (#2944 GC-3, brief §3, 시안 mockups.html ①②).
//
// `/연결`·⌘K 「AI 계정 카드 열기」가 지금 보고 있는 채널의 타임라인 꼬리에 여는
// 「나에게만 보여요」 카드다. **메시지가 아니다**: 서버에 아무것도 보내지 않고,
// 닫기·Esc·채널 이동·새로고침에 사라진다(Q1). 에이전트 이름·아바타가 없다
// (봇 래핑 금지, F14): 사람이 자기 화면에서 여는 도구 창이다.
//
// 같은 판정 규율(brief §3.5): 줄의 알약은 코어 `aiLinkPill.ts`(#2941)가, 구독
// 감지는 설정 「내 계정」과 같은 `useLocalHarnessWatch`가, 팀 AI 키는 설정과 같은
// 쿼리 키(`["settings","provider-link"]`)가 준다. 그래서 설정과 카드는 같은 입력에
// 같은 알약을 말한다. 구독 감지는 훅 지역 상태라 두 화면이 한 저장소를 나누지는
// 않는다: 둘 다 열릴 때 이 맥의 CLI에 다시 묻기 때문에 같은 답을 받는다.
//
// 흐름 넷(§3.4): 구독 로그인(#2816 모달) · 팀 키(운영자, 기존 쓰기 전용 PUT →
// test) · 연결 확인(구독은 상태 명령만, 팀은 test 라우트) · 실패 제자리. 결과는
// 누른 그 줄에서만 바뀐다. 카드 밖 토스트는 없다(ADR-0182).
//
// 비밀값(§3.4·§5): 키는 비제어 password 칸의 DOM 값으로만 있다. React 상태·
// 뮤테이션 변수·초안·컴포저·로그에 들어가지 않고, 저장 요청을 내는 순간 칸을
// 비운다.
// =============================================================================

const TEAM_QUERY_KEY = ["settings", "provider-link"] as const;

const OFFLINE_NOTE = "연결이 끊겨 지금은 팀 AI 키를 확인하거나 바꿀 수 없어요.";
const TEAM_DENIED_LINE = "팀 키는 운영자만 바꾸고 확인할 수 있어요.";
const TEAM_EMPTY_SUB = "아직 없어요. 팀 에이전트가 대답하려면 키가 필요해요";
const OPERATOR_FOOT = "운영자만 보이는 입력이에요. 키는 서버 금고에 봉인되고 쓰기 전용이에요.";

/** 잠긴 버튼: 흐림이 포인터를 올려도 풀리지 않는다(variant의 hover:opacity-90을 덮는다). */
const LOCKED = "opacity-50 hover:opacity-50";

const GROK_SUB = "공식 CLI 상태 확인 방법을 확인하는 중이에요";

/** 「15:42」·「방금」: 설정 곁판과 같은 코어 함수(#2880). */
const clock = teamCheckClock;
const since = (ms: number) => teamCheckSince(ms, Date.now());

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function markFor(label: string): string {
  const first = label.trim().charAt(0);
  return first === "" ? "?" : first.toUpperCase();
}

// ---- design 캡처 전용 자세 ------------------------------------------------------

type CardPose = "login-modal" | "logged" | "unfinished" | RegisterPose;

/** `?aiCard=login-modal|logged|unfinished`. 제품 빌드에서는 늘 null이다. */
function readCardPose(): CardPose | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  const pose = new URLSearchParams(query).get("aiCard");
  if (isRegisterPose(pose)) return pose;
  return pose === "login-modal" || pose === "logged" || pose === "unfinished" ? pose : null;
}

// ---- 줄 부품 --------------------------------------------------------------------

type ResultTone = "ok" | "warn" | "bad" | "mute";

const RESULT_TONE: Record<ResultTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-danger",
  mute: "text-ink-muted",
};

interface RowResult {
  tone: ResultTone;
  text: string;
  /** provider가 밝힌 숫자 칸들(#2975). 비었으면 그리지 않는다. */
  detailParts?: readonly string[];
}

/** 시안 `.row`: 로고 · 이름(출처 알약) · 상태 알약 · 행동 하나, 그 밑에 결과 줄. */
function CardRow({
  mark,
  name,
  source,
  sub,
  mono = false,
  pill,
  action,
  result,
  form,
  dim = false,
  last = false,
  testId,
  pillKey,
  wrapSub = false,
}: {
  mark: string;
  name: string;
  source: string;
  sub: ReactNode;
  mono?: boolean;
  pill: { tone: Parameters<typeof AiPill>[0]["tone"]; text: string } | null;
  action?: ReactNode;
  result?: RowResult | null;
  form?: ReactNode;
  dim?: boolean;
  last?: boolean;
  testId: string;
  pillKey?: string;
  /** 설명문이 줄의 요점이면(빈 줄의 「왜」) 자르지 않고 접는다. */
  wrapSub?: boolean;
}) {
  return (
    <li
      className={cn(
        "ai-card-row py-2",
        !last && "border-b border-line",
        dim && "opacity-60",
        // 시안 `.flash`: 방금 성공한 줄은 옅은 ok 바탕으로 「바뀐 곳은 여기」를 말한다.
        result?.tone === "ok" && "-mx-2 rounded-lg bg-ok-soft px-2"
      )}
      data-flash={result?.tone === "ok" ? "" : undefined}
      data-testid={testId}
    >
      <span data-slot="logo">
        <AiLogo mark={mark} small />
      </span>
      <span data-slot="name" className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-body font-semibold text-ink">
          <span className="truncate">{name}</span>
          <AiSource>{source}</AiSource>
        </span>
        <span
          className={cn(
            "text-meta text-ink-muted",
            wrapSub ? "break-keep" : "truncate",
            mono && "font-mono"
          )}
        >
          {sub}
        </span>
      </span>
      <span data-slot="pill" data-testid={`${testId}-pill`} data-pill={pillKey}>
        {pill && <AiPill tone={pill.tone}>{pill.text}</AiPill>}
      </span>
      {action && <span data-slot="act">{action}</span>}
      {result && (
        <p
          data-slot="res"
          role="status"
          className={cn("flex min-w-0 items-start gap-1 break-keep text-meta", RESULT_TONE[result.tone])}
          data-testid={`${testId}-result`}
          data-tone={result.tone}
        >
          {result.tone === "ok" && <Check className="mt-px size-3 shrink-0" aria-hidden="true" />}
          {(result.tone === "warn" || result.tone === "bad") && (
            <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="flex min-w-0 flex-col">
            <span>
              <CheckSentence text={result.text} />
            </span>
            {result.detailParts && result.detailParts.length > 0 && (
              <span className="tabular-nums text-ink" data-testid={`${testId}-result-detail`}>
                <CheckNumbers parts={result.detailParts} />
              </span>
            )}
          </span>
        </p>
      )}
      {form && <div data-slot="form">{form}</div>}
    </li>
  );
}

function SectionHead({ id, title }: { id: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 pb-1 pt-2">
      <h4 id={id} className="text-meta font-bold text-ink-muted">
        {title}
      </h4>
    </div>
  );
}

function LineNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="break-keep py-2 text-body text-ink" data-testid={testId}>
      {children}
    </p>
  );
}

// ---- 카드 ------------------------------------------------------------------------

export function AiConnectCard({
  line,
  focusNonce,
  offline,
  onClose,
  claimFocus = () => true,
}: {
  /** `/연결 claude`·`codex`·`팀키`: 그 줄만 펼친다. null이면 두 절 전부. */
  line: AiConnectLine | null;
  /** 이미 떠 있는 카드를 다시 열면 늘어난다: 초점만 옮긴다(채널당 한 장). */
  focusNonce: number;
  offline: boolean;
  onClose: () => void;
  /**
   * 이 nonce의 초점 이동을 가져가도 되는가. 타임라인이 목록을 다시 세우면(virtuoso
   * `key={epoch}`) 꼬리 카드도 다시 마운트되는데, 그때 컴포저의 초점을 빼앗지
   * 않는다(design-review #2944 M5). 한 nonce에 한 번만 참이다.
   */
  claimFocus?: (nonce: number) => boolean;
}) {
  const navigate = useNavigate();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  // 팀 키 폼이 열려 있으면 Esc는 폼을 먼저 닫는다(설정 곁판과 같은 층 순서).
  const escapeFormRef = useRef<(() => boolean) | null>(null);

  // 열리면(또는 다시 부르면) 카드 전체가 보이게 바닥까지 내리고 제목에 초점.
  // 꼬리 행은 virtuoso가 한 프레임 뒤에 잰다: 그 전에 내리면 카드 아래가 잘린다.
  useEffect(() => {
    if (!claimFocus(focusNonce)) return;
    headingRef.current?.focus({ preventScroll: true });
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView?.({ block: "end" });
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
    // claimFocus는 부른 쪽의 ref 판정이라 의존에 넣지 않는다(nonce가 바뀔 때만).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // 결과 줄·키 칸이 붙어 카드가 자라면, 초점이 카드 안에 있는 동안은 카드 끝이
  // 컴포저 뒤로 숨지 않게 필요한 만큼만 내린다(보는 사람이 위를 읽는 중이면 두지 않는다).
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (root.contains(document.activeElement)) root.scrollIntoView?.({ block: "nearest" });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (escapeFormRef.current?.()) return;
    onClose();
  }

  const showMine = line === null || line === "claude" || line === "codex";
  const showTeam = line === null || line === "team";

  return (
    <section
      ref={rootRef}
      aria-labelledby={headingId}
      className="flex gap-2 px-4 pb-3 pt-1"
      data-testid="ai-connect-card"
      data-line={line ?? "all"}
      onKeyDown={onKeyDown}
    >
      {/* 메시지 행의 아바타 거터(w-8)와 같은 자리를 비워 카드가 본문 줄에 선다. */}
      <div className="w-8 shrink-0" aria-hidden="true" />
      <div className="ai-card min-w-0 flex-1 overflow-hidden rounded-2xl border border-dashed border-line-strong bg-surface shadow-sm">
        <div className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-2">
          <Plug className="size-4 shrink-0 text-icon" aria-hidden="true" />
          <h3
            id={headingId}
            // 줄바꿈 없이 한 줄: 좁은 폭에서도 × 가 머리 줄에 남는다.
            ref={headingRef}
            tabIndex={-1}
            className="shrink-0 rounded-sm text-body font-bold text-ink focus-visible:focus-ring"
          >
            AI 계정
          </h3>
          <span
            className="inline-flex min-w-0 items-center gap-1 truncate rounded-full bg-muted-soft px-2 py-px text-timestamp font-semibold text-ink-muted"
            data-testid="ai-connect-card-only-me"
          >
            <Eye className="size-3 shrink-0" aria-hidden="true" />
            나에게만 보여요
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => navigate(AI_CONNECT_HUB_PATH)}
            aria-label={AI_HUB_NAV_COPY.openAiAction}
            className="tap-target press inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
            data-testid="ai-connect-card-settings"
          >
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            <span className="ai-card-wide">{AI_HUB_NAV_COPY.openAiAction}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="AI 계정 카드 닫기"
            className="tap-target press grid size-icon-button shrink-0 place-items-center rounded-full text-icon hover:bg-surface-hover focus-visible:focus-ring"
            data-testid="ai-connect-card-close"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {showMine && <MineSection only={line === "claude" || line === "codex" ? line : null} />}
        {showTeam && (
          <TeamSection
            offline={offline}
            autoOpenForm={line === "team"}
            escapeFormRef={escapeFormRef}
          />
        )}
      </div>
    </section>
  );
}

// ---- 에이전트가 제안한 카드 (#2948 GC-7, ADR-0186 증보 G3·G4, 시안 ③) ------------
//
// 에이전트 메시지 props `momo.command_suggest(ai.connect)`를 보는 사람별로 그린다.
// 몸은 위 로컬 카드와 **같은 절**(`MineSection`·`TeamSection`)이고 머리만 다르다:
// 「{에이전트}가 제안했어요 · 나에게만 조작돼요」. 점선이 아니라 실선이다 — 이
// 카드는 로컬 도구 창이 아니라 실제 메시지에 붙은 것이다(시안 `.ccard` vs `.local`).
//
// props는 의도만 싣는다(G3). 이 컴포넌트는 props에서 상태를 읽지 않는다: 알약은
// 설정과 같은 훅(구독 감지)·같은 쿼리(`TEAM_QUERY_KEY`)가 준다. 그래서 로그인하면
// props 패치 없이 이 자리에서 바뀐다.
//
// 타임라인 행이다: 마운트해도 초점을 가져가거나 스크롤하지 않는다(virtuoso가 행을
// 다시 세울 때마다 컴포저 초점을 빼앗게 된다). × 도 없다 — 메시지는 닫는 것이 아니다.

/** 운영자 판정 한 번의 신선도. 제안 행이 여러 개 떠도 한 요청을 나눠 읽는다. */
const OPERATOR_STALE_MS = 60_000;

/**
 * 제안 카드 자리. `viewerMemberId`가 없으면(읽기 전용 표면) 누구도 대상이 아니다.
 *
 * 운영자는 **기존 provider_link 응답**으로 안다(200 운영자, 403 아님 — G4). 같은
 * 쿼리 키라 설정·로컬 카드와 한 캐시를 나눈다. 대상 본인에게는 묻지 않는다: 본인
 * 카드는 팀 절이 스스로 같은 쿼리를 읽는다.
 */
export function AiConnectSuggestion({
  card,
  viewerMemberId,
  directory,
  channelId,
  rootId,
}: {
  card: CommandSuggestCard;
  viewerMemberId: string | undefined;
  /** 「운영자에게 부탁하기」가 멘션할 운영자를 찾는 멤버 목록. */
  directory: Directory;
  /** 그 멘션을 채울 컴포저의 채널(이 메시지의 채널). */
  channelId: string;
  /** 스레드 답글이면 그 뿌리: 멘션은 채널이 아니라 그 스레드 입력창에 심는다. */
  rootId?: string | undefined;
}) {
  const isTarget = commandSuggestViewer(card, viewerMemberId, false) === "target";
  const operatorQuery = useQuery({
    queryKey: TEAM_QUERY_KEY,
    queryFn: fetchProviderLink,
    retry: false,
    staleTime: OPERATOR_STALE_MS,
    // 403(비운영자)은 데이터가 없는 채로 남는다. virtuoso가 행을 다시 세울 때마다
    // 다시 묻지 않게 한다(design-review #2948 M: `routing/capability.ts`와 같은 규율).
    retryOnMount: false,
    enabled: card.shape === "ok" && !isTarget,
  });
  const viewer = commandSuggestViewer(card, viewerMemberId, operatorQuery.isSuccess);
  if (viewer === "target") {
    return <SuggestedCard
        card={card}
        directory={directory}
        channelId={channelId}
        rootId={rootId}
        viewerMemberId={viewerMemberId}
      />;
  }
  return <SuggestionLine card={card} operator={viewer === "operator"} />;
}

/** 남에게 보이는 한 줄(시안 `.oneline`). 운영자면 「팀 AI 키 보기」가 팀 줄만 편다. */
function SuggestionLine({ card, operator }: { card: CommandSuggestCard; operator: boolean }) {
  const [open, setOpen] = useState(false);
  const offline = useOffline();
  const panelId = useId();
  const escapeFormRef = useRef<(() => boolean) | null>(null);
  return (
    <div className="ai-card mt-2 flex min-w-0 flex-col gap-2" data-testid="ai-suggest" data-viewer={operator ? "operator" : "other"}>
      <p
        className="flex min-w-0 items-center gap-2 rounded-lg bg-sheet px-3 py-2 text-meta text-ink-muted"
        data-testid="ai-suggest-line"
      >
        <Plug className="size-4 shrink-0 text-icon" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-keep">{commandSuggestOneLine(card)}</span>
        {operator && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((value) => !value)}
            // 눌리는 면은 좁은 폭에서 44(`tap-target`), 보이는 줄은 시안 `.oneline` 높이
            // 그대로: 넓힌 만큼 음의 세로 여백으로 돌려준다(design-review #2948 M).
            className="tap-target press -my-3 shrink-0 rounded-md px-1 text-meta font-semibold text-agent hover:underline focus-visible:focus-ring"
            data-testid="ai-suggest-team-open"
          >
            {open ? COMMAND_SUGGEST_TEAM_CLOSE : COMMAND_SUGGEST_TEAM_OPEN}
          </button>
        )}
      </p>
      {operator && open && (
        <div
          id={panelId}
          className="min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
          data-testid="ai-suggest-team-panel"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (escapeFormRef.current?.()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <TeamSection offline={offline} autoOpenForm={false} escapeFormRef={escapeFormRef} />
        </div>
      )}
    </div>
  );
}

/** 대상 본인의 조작 카드. 로컬 카드와 같은 절, 머리만 제안 머리. */
function SuggestedCard({
  card,
  directory,
  channelId,
  rootId,
  viewerMemberId,
}: {
  card: CommandSuggestCard;
  directory: Directory;
  channelId: string;
  rootId: string | undefined;
  viewerMemberId: string | undefined;
}) {
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  // 「운영자에게 부탁하기」: 컴포저에 운영자 멘션만 채운다. 보내는 것은 사람이다.
  // 쓰던 글은 덮지 않는다(`seedComposerText`는 빈 입력창에만 심는다).
  const askOperator = (): string | null => {
    const draft = operatorMentionDraft(directory, viewerMemberId);
    if (draft === null) return COMMAND_SUGGEST_ASK_NONE;
    // 스레드 안의 제안은 그 스레드 입력창에(design-review #2948 B). 채널 입력창은
    // 좁은 폭에서 서랍 뒤에 `inert`로 가려져 있어, 거기 심으면 아무 일도 안 난 것처럼 보인다.
    if (rootId) {
      const seeded = seedThreadComposerText(rootId, draft);
      if (!seeded.mounted) return COMMAND_SUGGEST_ASK_THREAD;
      return seeded.accepted ? null : COMMAND_SUGGEST_ASK_BUSY;
    }
    if (!seedComposerText(workspaceId, channelId, draft)) return COMMAND_SUGGEST_ASK_BUSY;
    const input = document.getElementById("composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
    return null;
  };
  const headingId = useId();
  const offline = useOffline();
  const escapeFormRef = useRef<(() => boolean) | null>(null);
  const focus = card.focus;
  const showMine = focus !== "team";
  // 시안 ③ 요청자: `harness:"claude"` 제안도 그 구독 줄 + 팀 AI 키 절을 함께 보인다
  // (로컬 `/연결 claude`는 그 줄만 편다 — 제안은 「무엇을 연결할지」의 맥락이 대화에
  // 있으므로 팀 쪽 사실도 같이 놓는다). `scope:"mine"`만 온 제안은 내 계정 절만.
  const showTeam = focus !== "mine";
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? "";

  return (
    <section
      aria-labelledby={headingId}
      className="ai-card mt-2 min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      data-testid="ai-suggest"
      data-viewer="target"
      data-focus={focus ?? "all"}
      onKeyDown={(event) => {
        // 키 칸이 열려 있을 때만 Esc를 가져간다(폼 닫기). 그 밖의 Esc는 타임라인 것이다.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (escapeFormRef.current?.()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {/* 좁은 폭에서는 칩과 「설정에서 열기」가 다음 줄로 내려간다: 제안한 에이전트의
          이름이 잘리지 않는 것이 먼저다(design-review #2948 B1). */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-sm bg-agent-soft text-timestamp font-bold text-agent"
        >
          {initial}
        </span>
        <h3 id={headingId} className="min-w-0 break-keep text-meta font-semibold text-agent">
          {commandSuggestHead(card)}
        </h3>
        <span className="ai-card-chipline flex">
          <span
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-muted-soft px-2 py-px text-timestamp font-semibold text-ink-muted"
            data-testid="ai-suggest-only-me"
          >
            <Eye className="size-3 shrink-0" aria-hidden="true" />
            {COMMAND_SUGGEST_ONLY_ME}
          </span>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => navigate(AI_CONNECT_HUB_PATH)}
          aria-label={AI_HUB_NAV_COPY.openAiAction}
          className="tap-target press inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
          data-testid="ai-suggest-settings"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          <span className="ai-card-wide">{AI_HUB_NAV_COPY.openAiAction}</span>
        </button>
      </div>
      {showMine && <MineSection only={focus === "claude" || focus === "codex" ? focus : null} />}
      {showTeam && (
        <TeamSection
          offline={offline}
          autoOpenForm={false}
          escapeFormRef={escapeFormRef}
          onAskOperator={askOperator}
        />
      )}
    </section>
  );
}

// ---- 내 계정 · 이 맥 ---------------------------------------------------------------

function MineSection({ only }: { only: LocalHarnessId | null }) {
  const headId = useId();
  const state = useSubscriptionEntryState();
  const browserTab = myAccountsBrowserTab(state, IS_TAURI);
  return (
    <section className="flex min-w-0 flex-col px-3 pb-1" aria-labelledby={headId} data-testid="ai-connect-card-mine">
      <SectionHead id={headId} title="내 계정 · 이 맥" />
      {state === "pending" && !browserTab ? (
        <Skeleton ready={false} rows={2} className="py-2" />
      ) : browserTab ? (
        <LineNote testId="ai-connect-card-browser">{MY_ACCOUNTS_BROWSER_LINE}</LineNote>
      ) : state === "rows" ? (
        <HarnessRows only={only} />
      ) : (
        <div className="flex min-w-0 flex-col gap-1 py-2" data-testid="ai-connect-card-mine-empty">
          <span className="break-keep text-body text-ink">{MY_ACCOUNTS_EMPTY_LINE}</span>
          <span className="break-keep text-meta text-ink-muted">
            {state === "server-off"
              ? AI_CONNECT_SERVER_OFF_NOTE
              : state === "denied"
                ? MY_ACCOUNTS_DENIED_DETAIL
                : MY_ACCOUNTS_EMPTY_DETAIL}
          </span>
        </div>
      )}
    </section>
  );
}

type HarnessResult =
  | { kind: "connected"; at: number }
  | { kind: "unfinished"; at: number }
  | { kind: "checked"; at: number };

function harnessResultLine(result: HarnessResult | undefined, pill: HarnessPill): RowResult | null {
  if (!result) return null;
  if (result.kind === "connected") {
    return { tone: "ok", text: `방금 연결됐어요 · ${clock(result.at)}` };
  }
  if (result.kind === "unfinished") {
    return pill === "ready" ? null : { tone: "warn", text: "로그인이 끝나지 않았어요" };
  }
  if (pill === "checking") return null;
  if (pill === "recheck") return { tone: "warn", text: "CLI가 답하지 않았어요" };
  if (pill === "login") return { tone: "warn", text: "이 맥의 로그인이 풀려 있어요" };
  return { tone: "mute", text: `마지막 확인 ${since(result.at)}` };
}

function HarnessRows({ only }: { only: LocalHarnessId | null }) {
  const pose = readCardPose();
  const fixture = readProbeFixture();
  const harness = useLocalHarnessWatch({
    enabled: true,
    fixture: fixture ? { probes: fixture } : null,
  });
  const registerPose = pose !== null && isRegisterPose(pose) ? registerPoseFixture(pose) : null;
  const [loginFor, setLoginFor] = useState<LocalHarnessId | null>(() =>
    registerPose ? registerPose.harness : pose === "login-modal" ? "claude" : null
  );
  const loginFixture: HarnessLoginFixture | null = registerPose
    ? { status: { phase: "connected" }, register: { state: registerPose.state } }
    : pose === "login-modal"
      ? { status: { phase: "waiting" } }
      : null;
  const [results, setResults] = useState<Partial<Record<LocalHarnessId, HarnessResult>>>(() => {
    const now = Date.now();
    if (pose === "logged") return { claude: { kind: "connected", at: now } };
    if (pose === "unfinished") return { codex: { kind: "unfinished", at: now } };
    return {};
  });
  // 모달이 「연결됐어요」로 끝난 하네스. 닫기(취소·시간 초과)와 성공을 가른다.
  const connectedRef = useRef<Set<LocalHarnessId>>(new Set());
  // 로그인 뒤 「에이전트로 만들기」(#3389). 이미 로그인된 줄에서는 곧장 확인 단계로 연다.
  const register = useRegisterContext();
  const [registerOnly, setRegisterOnly] = useState(false);

  const record = (id: LocalHarnessId, result: HarnessResult) =>
    setResults((prev) => ({ ...prev, [id]: result }));

  function openLogin(id: LocalHarnessId) {
    connectedRef.current.delete(id);
    setRegisterOnly(false);
    setLoginFor(id);
  }

  function openRegister(id: LocalHarnessId) {
    connectedRef.current.delete(id);
    setRegisterOnly(true);
    setLoginFor(id);
  }

  function check(id: LocalHarnessId) {
    // 상태 명령만 다시 돌린다(ADR-0190 D3-a). 모델을 부르지 않는다(F12).
    harness.recheck(id);
    record(id, { kind: "checked", at: Date.now() });
  }

  if (harness.probes === null) {
    return <Skeleton ready={false} rows={2} className="py-2" />;
  }
  const ids = (["claude", "codex"] as const).filter((id) => only === null || only === id);

  return (
    <>
      <ul className="flex min-w-0 flex-col" aria-label="이 맥의 구독 CLI">
        {ids.map((id) => {
          const pill = harness.pill(id);
          const result = results[id];
          const unfinished = result?.kind === "unfinished" && pill !== "ready";
          const label = HARNESS_LABEL[id];
          let action: ReactNode = null;
          if (pill === "install") {
            action = (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void openExternalUrl(HARNESS_INSTALL_URL[id])}
                aria-label={`${label} 설치 안내 열기`}
                data-testid={`ai-connect-card-${id}-install`}
              >
                설치 안내
              </Button>
            );
          } else if (unfinished) {
            action = (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => openLogin(id)}
                aria-label={`${label} 로그인 다시 시도`}
                data-testid={`ai-connect-card-${id}-retry`}
              >
                다시 시도
              </Button>
            );
          } else if (pill === "login") {
            action = (
              <Button
                type="button"
                size="sm"
                onClick={() => openLogin(id)}
                data-testid={`ai-connect-card-${id}-login`}
              >
                {loginActionLabel(id)}
              </Button>
            );
          } else {
            const checking = pill === "checking";
            // 도는 동안은 시안처럼 흐리고 낱말도 바뀐다(design-review M1).
            action = (
              <>
                {pill === "ready" && register !== null && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => openRegister(id)}
                    data-testid={`ai-connect-card-${id}-register`}
                  >
                    {START_CREATE_LABEL}
                  </Button>
                )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-busy={checking || undefined}
                aria-disabled={checking || undefined}
                aria-label={checking ? `${label} 확인 중` : `${label} 연결 확인`}
                className={cn(checking && LOCKED)}
                onClick={() => {
                  if (!checking) check(id);
                }}
                data-testid={`ai-connect-card-${id}-check`}
              >
                {!checking && <RefreshCw aria-hidden="true" />}
                {checking ? "확인 중" : "연결 확인"}
              </Button>
              </>
            );
          }
          return (
            <CardRow
              key={id}
              mark={AI_CONNECT_ROW_COPY[id].mark}
              name={label}
              source="구독"
              sub="이 맥의 공식 CLI 기본 로그인"
              pill={harnessPillView(pill)}
              pillKey={pill}
              action={action}
              result={harnessResultLine(result, pill)}
              last={only !== null}
              testId={`ai-connect-card-${id}`}
            />
          );
        })}
        {only === null && (
          <CardRow
            mark="G"
            name="Grok"
            source="구독"
            sub={GROK_SUB}
            pill={{ tone: "mute", text: "준비 중" }}
            dim
            last
            testId="ai-connect-card-grok"
          />
        )}
      </ul>
      <HarnessLoginDialog
        harness={loginFor}
        fixture={loginFixture}
        register={register}
        startAt={registerOnly ? "register" : "login"}
        onClose={() => {
          const id = loginFor;
          setLoginFor(null);
          if (id !== null && !connectedRef.current.has(id) && harness.pill(id) !== "ready") {
            record(id, { kind: "unfinished", at: Date.now() });
          }
        }}
        onConnected={(id) => {
          connectedRef.current.add(id);
          harness.recheck(id);
          record(id, { kind: "connected", at: Date.now() });
        }}
        onFallbackStarted={harness.startLoginWatch}
      />
    </>
  );
}

// ---- 팀 AI 키 · 이 서버 -------------------------------------------------------------

function TeamSection({
  offline,
  autoOpenForm,
  escapeFormRef,
  onAskOperator,
}: {
  offline: boolean;
  autoOpenForm: boolean;
  escapeFormRef: React.MutableRefObject<(() => boolean) | null>;
  /**
   * 비운영자의 다음 행동(#2948, G4 「운영자에게 부탁하기」). 있으면 거절 줄 밑에
   * 버튼이 선다. 결과 문장을 돌려주면(채우지 못함) 그 줄에 보인다.
   */
  onAskOperator?: () => string | null;
}) {
  const headId = useId();
  const client = useQueryClient();
  const query = useQuery({ queryKey: TEAM_QUERY_KEY, queryFn: fetchProviderLink, retry: false });
  const [editing, setEditing] = useState(false);
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [askNote, setAskNote] = useState<string | null>(null);
  const autoOpened = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);

  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: setProbe,
  });

  const link = query.data;
  const operator = query.isSuccess;
  const denied = query.isError && isOperatorDenied(query.error);
  const hasRow = link ? link.configured || (link.keyConfigured && link.availability !== "mock") : false;

  useEffect(() => {
    if (!autoOpenForm || autoOpened.current || !link || offline) return;
    autoOpened.current = true;
    if (!hasRow) setEditing(true);
  }, [autoOpenForm, link, hasRow, offline]);

  useEffect(() => {
    escapeFormRef.current = editing
      ? () => {
          setEditing(false);
          return true;
        }
      : null;
    return () => {
      escapeFormRef.current = null;
    };
  }, [editing, escapeFormRef]);

  // 폼이 닫히면 초점은 줄의 행동 버튼으로 돌아온다(<body>로 떨어지지 않게).
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) actionRef.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);

  function onSaved() {
    setEditing(false);
    setProbe(null);
    setJustSaved(true);
    void client.invalidateQueries({ queryKey: TEAM_QUERY_KEY });
    // 「저장하고 확인」: 기존 API는 저장 뒤에만 확인할 수 있다(저장 전 판정은
    // #2880·#2872). 그래서 저장 직후 같은 줄에서 확인을 이어 돈다.
    check.mutate();
  }

  const legacy = link ? isLegacyTeamLink(link) : false;
  const pill = link ? linkPill({ link, offline, probe, checking: check.isPending }) : null;

  let result: RowResult | null = null;
  if (!offline && check.isError) {
    result = { tone: "bad", text: errorMessage(check.error) };
  } else if (!offline && probe && !check.isPending) {
    // 문장은 코어 한 곳(#2880): 설정 곁판과 같은 확인에 같은 말.
    const line = teamCheckResult({ probe, justSaved, nowMs: Date.now() });
    result = { tone: line.tone, text: line.text, detailParts: line.detailParts };
  }

  // 서버가 부르지 않은 확인(`probe_not_run`)은 실패가 아니다: 「키 바꾸기」로 몰지 않는다(#2880).
  const failed = probe !== null && !probe.ok && probe.reason !== PROBE_NOT_RUN;
  let action: ReactNode = null;
  if (operator && link && !legacy && !editing) {
    const lockedByOffline = offline;
    const common = {
      ref: actionRef,
      type: "button" as const,
      variant: "secondary" as const,
      size: "sm" as const,
      "aria-disabled": lockedByOffline || undefined,
      "aria-describedby": lockedByOffline ? `${headId}-offline` : undefined,
      className: cn(lockedByOffline && LOCKED),
    };
    if (!hasRow || failed) {
      action = (
        <Button
          {...common}
          onClick={() => {
            if (!lockedByOffline) setEditing(true);
          }}
          data-testid="ai-connect-card-team-key"
        >
          <KeyRound aria-hidden="true" />
          {hasRow ? "키 바꾸기" : "키 넣기"}
        </Button>
      );
    } else {
      const checking = check.isPending;
      action = (
        <Button
          {...common}
          aria-busy={checking || undefined}
          aria-disabled={lockedByOffline || checking || undefined}
          className={cn((lockedByOffline || checking) && LOCKED)}
          onClick={() => {
            if (lockedByOffline || checking) return;
            setJustSaved(false);
            check.mutate();
          }}
          data-testid="ai-connect-card-team-check"
        >
          {!checking && <RefreshCw aria-hidden="true" />}
          {checking ? "확인 중" : "연결 확인"}
        </Button>
      );
    }
  }

  let body: ReactNode;
  if (query.isPending) {
    body = <Skeleton ready={false} rows={1} className="py-2" />;
  } else if (denied) {
    body = (
      <p
        className="flex items-start gap-2 break-keep py-2 text-body text-ink"
        data-testid="ai-connect-card-team-denied"
      >
        <Lock className="mt-1 size-3 shrink-0 text-icon" aria-hidden="true" />
        <span>{TEAM_DENIED_LINE}</span>
      </p>
    );
    if (onAskOperator) {
      body = (
        <div className="flex min-w-0 flex-col pb-1">
          {body}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAskNote(onAskOperator())}
              data-testid="ai-connect-card-ask-operator"
            >
              {COMMAND_SUGGEST_ASK_OPERATOR}
            </Button>
            {askNote && (
              <span role="status" className="min-w-0 break-keep text-meta text-ink-muted" data-testid="ai-connect-card-ask-note">
                {askNote}
              </span>
            )}
          </div>
        </div>
      );
    }
  } else if (query.isError) {
    body = (
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2" role="alert" data-testid="ai-connect-card-team-error">
        <span className="min-w-0 flex-1 break-keep text-meta text-danger">
          팀 AI 키를 불러오지 못했어요. {errorMessage(query.error)}
        </span>
        <Button type="button" variant="secondary" size="sm" onClick={() => void query.refetch()}>
          다시 불러오기
        </Button>
      </div>
    );
  } else if (link) {
    const configured = link.configured;
    body = (
      <ul className="flex min-w-0 flex-col">
        <CardRow
          mark={hasRow ? markFor(link.endpointLabel) : "?"}
          name={hasRow ? (configured ? `${link.endpointLabel} · 팀 AI 키` : link.endpointLabel) : "팀 AI 키"}
          source={legacy ? "내부용" : "API 키"}
          mono={hasRow && configured}
          sub={
            !hasRow
              ? TEAM_EMPTY_SUB
              : configured
                ? `${maskedBearer(link.bearerLast4)}${
                    offline ? " · 마지막으로 받은 값" : link.updatedAtMs ? ` · ${shortDate(link.updatedAtMs)} 저장` : ""
                  }`
                : "서버 환경값"
          }
          wrapSub={!hasRow}
          pill={pill}
          action={action}
          result={result}
          form={
            editing ? (
              <TeamKeyForm
                link={link}
                offline={offline}
                offlineNoteId={`${headId}-offline`}
                currentFailed={failed}
                onCancel={() => setEditing(false)}
                onSaved={onSaved}
              />
            ) : null
          }
          last
          testId="ai-connect-card-team"
        />
      </ul>
    );
  }

  return (
    <section className="flex min-w-0 flex-col" aria-labelledby={headId} data-testid="ai-connect-card-team-section">
      <div className="flex min-w-0 flex-col px-3 pb-1">
        <SectionHead id={headId} title="팀 AI 키 · 이 서버" />
        {body}
        {offline && operator && (
          <p id={`${headId}-offline`} className="break-keep pb-2 text-meta text-ink-muted" data-testid="ai-connect-card-offline">
            {OFFLINE_NOTE}
          </p>
        )}
      </div>
      {editing && (
        // 시안 `.cft`: 운영자 입력의 봉인 문장은 카드 발에 한 번.
        <p className="flex items-center gap-2 border-t border-line bg-sheet px-3 py-2 text-meta text-ink-muted">
          <Lock className="size-3 shrink-0 text-icon" aria-hidden="true" />
          {OPERATOR_FOOT}
        </p>
      )}
    </section>
  );
}
