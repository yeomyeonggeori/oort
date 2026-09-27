import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ExternalLink, Eye, KeyRound, Lock, Plug, RefreshCw, X } from "lucide-react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import type { AiConnectLine } from "@momo/core/features/commands/registry";
import { AI_CONNECT_SETTINGS_PATH } from "@momo/core/features/commands/registry";
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
  putProviderLink,
  testProviderLink,
  type ProviderFormat,
  type ProviderLink,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import {
  harnessPillView,
  isLegacyTeamLink,
  linkPill,
} from "@momo/core/features/settings/aiLinkPill";
import { errorMessage, isOperatorDenied, maskedBearer } from "@momo/core/features/settings/model";
import {
  initialPresetId,
  teamCheckReason,
  teamKeyPresets,
} from "@momo/core/features/settings/teamKeyForm";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";
import { AiLogo, AiPill, AiSource } from "@/features/settings/aiAccountsParts";
import {
  MY_ACCOUNTS_BROWSER_LINE,
  MY_ACCOUNTS_DENIED_DETAIL,
  MY_ACCOUNTS_EMPTY_DETAIL,
  MY_ACCOUNTS_EMPTY_LINE,
  myAccountsBrowserTab,
  readProbeFixture,
} from "@/features/settings/aiMyAccountsModel";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import {
  HarnessLoginDialog,
  type HarnessLoginFixture,
} from "@/features/welcome/harnessLogin/HarnessLoginDialog";

// Reading this as: agent card family (local tool card at the timeline tail) for
// internal team users on web+Tauri, density 6/10, motion 2/10.

// =============================================================================
// 채팅의 로컬 연결 카드 (#2944 GC-3, brief §3, 시안 mockups.html ①②).
//
// `/연결`·⌘K 「AI 연결 카드 열기」가 지금 보고 있는 채널의 타임라인 꼬리에 여는
// 「나에게만 보여요」 카드다. **메시지가 아니다**: 서버에 아무것도 보내지 않고,
// 닫기·Esc·채널 이동·새로고침에 사라진다(Q1). 에이전트 이름·아바타가 없다
// (봇 래핑 금지, F14): 사람이 자기 화면에서 여는 도구 창이다.
//
// 같은 판정 규율(brief §3.5): 줄의 알약은 코어 `aiLinkPill.ts`(#2941)가, 구독
// 감지는 설정 「내 계정」과 같은 `useLocalHarnessWatch`가, 팀 연결은 설정과 같은
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

const OFFLINE_NOTE = "연결이 끊겨 지금은 팀 연결을 확인하거나 바꿀 수 없어요.";
const TEAM_DENIED_LINE = "팀 키는 운영자만 바꾸고 확인할 수 있어요.";
const TEAM_EMPTY_SUB = "아직 없어요. 팀 에이전트가 대답하려면 키가 필요해요";
const OPERATOR_FOOT = "운영자만 보이는 입력이에요. 키는 서버 금고에 봉인되고 쓰기 전용이에요.";
const KEY_HINT = "저장하면 다시 보이지 않아요. 마스킹 꼬리만 남아요. 이 칸의 값은 채팅·초안에 남지 않아요.";
const GROK_SUB = "공식 CLI 상태 확인 방법을 확인하는 중이에요";

/** 「15:42」. 결과 줄의 시각은 이 화면에서 본 것이라 날짜를 싣지 않는다. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 결과 줄의 때: 1분 안이면 「방금」(brief §6), 아니면 「15:42」. */
function since(ms: number): string {
  return Date.now() - ms < 60_000 ? "방금" : clock(ms);
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function markFor(label: string): string {
  const first = label.trim().charAt(0);
  return first === "" ? "?" : first.toUpperCase();
}

// ---- design 캡처 전용 자세 ------------------------------------------------------

type CardPose = "login-modal" | "logged" | "unfinished";

/** `?aiCard=login-modal|logged|unfinished`. 제품 빌드에서는 늘 null이다. */
function readCardPose(): CardPose | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  const pose = new URLSearchParams(query).get("aiCard");
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
          <span className="min-w-0">{result.text}</span>
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
            AI 연결
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
            onClick={() => navigate(AI_CONNECT_SETTINGS_PATH)}
            aria-label="설정에서 열기"
            className="tap-target press inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
            data-testid="ai-connect-card-settings"
          >
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
            <span className="ai-card-wide">설정에서 열기</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="AI 연결 카드 닫기"
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
  const [loginFor, setLoginFor] = useState<LocalHarnessId | null>(() =>
    pose === "login-modal" ? "claude" : null
  );
  const loginFixture: HarnessLoginFixture | null =
    pose === "login-modal" ? { status: { phase: "waiting" } } : null;
  const [results, setResults] = useState<Partial<Record<LocalHarnessId, HarnessResult>>>(() => {
    const now = Date.now();
    if (pose === "logged") return { claude: { kind: "connected", at: now } };
    if (pose === "unfinished") return { codex: { kind: "unfinished", at: now } };
    return {};
  });
  // 모달이 「연결됐어요」로 끝난 하네스. 닫기(취소·시간 초과)와 성공을 가른다.
  const connectedRef = useRef<Set<LocalHarnessId>>(new Set());

  const record = (id: LocalHarnessId, result: HarnessResult) =>
    setResults((prev) => ({ ...prev, [id]: result }));

  function openLogin(id: LocalHarnessId) {
    connectedRef.current.delete(id);
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-busy={checking || undefined}
                aria-disabled={checking || undefined}
                aria-label={checking ? `${label} 확인 중` : `${label} 연결 확인`}
                className={cn(checking && "opacity-50")}
                onClick={() => {
                  if (!checking) check(id);
                }}
                data-testid={`ai-connect-card-${id}-check`}
              >
                {!checking && <RefreshCw aria-hidden="true" />}
                {checking ? "확인 중" : "연결 확인"}
              </Button>
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

// ---- 팀 연결 · 이 서버 -------------------------------------------------------------

function TeamSection({
  offline,
  autoOpenForm,
  escapeFormRef,
}: {
  offline: boolean;
  autoOpenForm: boolean;
  escapeFormRef: React.MutableRefObject<(() => boolean) | null>;
}) {
  const headId = useId();
  const client = useQueryClient();
  const query = useQuery({ queryKey: TEAM_QUERY_KEY, queryFn: fetchProviderLink, retry: false });
  const [editing, setEditing] = useState(false);
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const [justSaved, setJustSaved] = useState(false);
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
    if (probe.ok) {
      result = { tone: "ok", text: `응답을 확인했어요 · ${since(probe.checkedAtMs)}` };
    } else {
      const why = teamCheckReason(probe.reason);
      result = {
        tone: "bad",
        text: justSaved ? `${why} 저장한 키는 그대로 남아 있어요. 키를 바꾸려면 새로 넣으세요.` : why,
      };
    }
  }

  const failed = probe !== null && !probe.ok;
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
      className: cn(lockedByOffline && "opacity-50"),
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
          className={cn((lockedByOffline || checking) && "opacity-50")}
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
  } else if (query.isError) {
    body = (
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2" role="alert" data-testid="ai-connect-card-team-error">
        <span className="min-w-0 flex-1 break-keep text-meta text-danger">
          팀 연결을 불러오지 못했어요. {errorMessage(query.error)}
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
          name={hasRow ? (configured ? `${link.endpointLabel} · 팀 기본` : link.endpointLabel) : "팀 API 키"}
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
        <SectionHead id={headId} title="팀 연결 · 이 서버" />
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

/**
 * 팀 키 넣기(운영자). 프리셋 칩 + 마스킹 칸 + 「저장하고 확인」.
 *
 * 순서가 이름이다(design-review #2944 H1): 지금 서버에는 저장 전 판정 경로가
 * 없어서(#2880·#2872) 저장한 뒤에 확인한다. 그래서 이미 쓰는 키가 있으면 대체하기
 * 전에 한 번 묻는다: 확인 없이 잘 되던 팀 키를 덮어쓰지 않게.
 *
 * 키는 **비제어** 칸의 DOM 값이다. React 상태에도, 뮤테이션 변수에도 싣지 않는다:
 * `useMutation`은 마지막 변수를 캐시에 들고 있으므로 변수에 키를 넣으면 저장 뒤에도
 * 메모리에 남는다. 저장을 누르는 순간 칸을 비우고, 값은 요청 한 번에만 쓰인다.
 */
function TeamKeyForm({
  link,
  currentFailed,
  onCancel,
  onSaved,
}: {
  link: ProviderLink;
  /** 지금 키가 방금 확인에 실패했는가(대체 경고의 문장이 달라진다). */
  currentFailed: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const presets = teamKeyPresets(link);
  const [presetId, setPresetId] = useState<string | null>(() => initialPresetId(presets, link));
  const [fieldError, setFieldError] = useState<string | null>(null);
  // 이미 쓰는 키를 대체하기 전의 한 번 묻기. 키 값은 여전히 칸(DOM)에만 있다.
  const [confirmReplace, setConfirmReplace] = useState(false);
  const replacing = link.configured && link.keyConfigured;
  const inputRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef("");
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const preset = presets.find((row) => row.id === presetId) ?? null;
  const target: { baseUrl: string; format: ProviderFormat } | null = preset
    ? { baseUrl: preset.baseUrl, format: preset.format }
    : link.configured
      ? { baseUrl: link.baseUrl, format: "openai" }
      : null;

  const save = useMutation({
    mutationFn: (input: { baseUrl: string; format: ProviderFormat }) => {
      const bearer = secretRef.current;
      secretRef.current = "";
      return putProviderLink({ baseUrl: input.baseUrl, bearer, mode: "external-hermes", format: input.format });
    },
    onSuccess: onSaved,
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (save.isPending || target === null) return;
    const field = inputRef.current;
    const value = field?.value.trim() ?? "";
    if (value === "") {
      setFieldError("키를 붙여 넣으세요. 저장된 키는 다시 내려오지 않아서 매번 새로 넣어요.");
      field?.focus();
      return;
    }
    setFieldError(null);
    if (replacing && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    secretRef.current = value;
    if (field) field.value = "";
    save.mutate(target);
  }

  return (
    <form className="flex min-w-0 flex-col gap-2 pb-1 pt-1" onSubmit={submit} data-testid="ai-connect-card-key-form" aria-label="팀 API 키 넣기">
      {presets.length > 0 ? (
        <fieldset className="flex min-w-0 flex-wrap gap-2">
          <legend className="sr-only">provider</legend>
          {presets.map((row) => (
            <label key={row.id} className="press relative inline-flex">
              <input
                type="radio"
                name={`${inputId}-preset`}
                value={row.id}
                checked={presetId === row.id}
                onChange={() => {
                  setPresetId(row.id);
                  setConfirmReplace(false);
                }}
                className="peer sr-only"
                data-testid={`ai-connect-card-preset-${row.id}`}
              />
              <span className="tap-target inline-flex h-control-sm cursor-pointer items-center rounded-full border border-line px-3 text-meta font-semibold text-ink-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:focus-ring">
                {row.label}
              </span>
            </label>
          ))}
        </fieldset>
      ) : link.configured ? (
        <p className="break-keep text-meta text-ink-muted">지금 주소({link.endpointLabel})에 새 키를 넣어요.</p>
      ) : (
        <p className="break-keep text-meta text-ink-muted" data-testid="ai-connect-card-no-presets">
          이 서버는 provider 목록을 주지 않아요. 주소는 설정 › AI 연결에서 넣어 주세요.
        </p>
      )}
      <label htmlFor={inputId} className="sr-only">
        API 키
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        type="password"
        name="team-api-key"
        autoComplete="off"
        spellCheck={false}
        placeholder="키를 붙여 넣으세요"
        className="font-mono"
        aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
        aria-invalid={fieldError ? true : undefined}
        onInput={() => setConfirmReplace(false)}
        data-testid="ai-connect-card-key-input"
      />
      {fieldError && (
        <p id={errorId} className="break-keep text-meta text-danger" role="alert">
          {fieldError}
        </p>
      )}
      <p id={hintId} className="break-keep text-meta text-ink-muted">
        {KEY_HINT}
      </p>
      {save.isError && (
        <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-connect-card-save-error">
          {errorMessage(save.error)}
        </p>
      )}
      {confirmReplace && (
        <p className="break-keep text-meta text-warn" role="alert" data-testid="ai-connect-card-key-replace">
          지금 팀 기본 키({maskedBearer(link.bearerLast4)})를 이 키로 바꿔요. 팀 에이전트는 바로 새 키로 대답해요.
          {currentFailed
            ? " 지금 키는 방금 확인에 실패했어요. 새 키도 저장한 뒤에 확인해요."
            : " 저장한 뒤에 확인하니, 틀린 키면 팀 에이전트가 멈춰요."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          aria-busy={save.isPending || undefined}
          aria-disabled={target === null || save.isPending || undefined}
          className={cn((target === null || save.isPending) && "opacity-50")}
          data-testid="ai-connect-card-key-save"
        >
          {save.isPending ? "저장 중" : confirmReplace ? "바꿔 저장하고 확인" : "저장하고 확인"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid="ai-connect-card-key-cancel">
          취소
        </Button>
      </div>
    </form>
  );
}
