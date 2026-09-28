import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  deleteProviderLink,
  fetchProviderLink,
  testProviderLink,
  type ProviderLink,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import { teamCheckResult, teamProbeDetail } from "@momo/core/features/settings/teamKeyForm";
import type { AiDefaultsTeamKey } from "@momo/core/features/settings/aiDefaults";
import { IS_TAURI } from "@/lib/env";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { AiDefaultsTable } from "./AiDefaultsTable";
import { myAccountsBrowserTab } from "./aiMyAccountsModel";
import {
  choiceLabel,
  errorMessage,
  isOperatorDenied,
  maskedBearer,
  PROVIDER_MODES,
  providerSourceLabel,
  providerTestMessage,
} from "@momo/core/features/settings/model";
import {
  isLoopbackProviderRefusal,
  isLoopbackProviderUrl,
  loopbackProviderGuidance,
  parseProbeEntries,
} from "@momo/core/features/settings/chainModel";
import { arrayField } from "@momo/core/lib/wire";
import { KeyValueRows, type KeyValue } from "./SettingsFields";
import { AiLinkChain, ChainProbeResult } from "./AiLinkChain";
import {
  accessTokenStatus,
  credentialKind,
  credentialKindLabel,
  credentialMeta,
  formatMoment,
} from "./oauthGrant";
import {
  AiAccountRow,
  AiAside,
  AiCard,
  AiLineRow,
  AiOfflineBanner,
  AiPill,
  AiSection,
  AiSectionHead,
  AiSource,
  CheckNumbers,
  CheckSentence,
} from "./aiAccountsParts";
import {
  isLegacyTeamLink,
  linkPill,
  PROBE_NOT_RUN,
  type AiPillView,
} from "@momo/core/features/settings/aiLinkPill";
import { TeamKeyForm } from "./TeamKeyForm";
import { TeamUnlinkDialog } from "./TeamUnlinkDialog";
import { AiMyAccountsSection } from "./AiMyAccountsSection";

// =============================================================================
// 설정 › AI 연결 (#2877, 시안 claudedocs/ai-accounts/mockups.html §1·§6).
//
// 이름과 id(`ai`)는 그대로고 내용이 바뀌었다(제안서 Q3). 한 페이지에 절이
// 위에서 아래로 선다.
//   1. 내 계정 · 이 맥 — 이 맥의 공식 CLI 구독(`AiMyAccountsSection`)
//   2. 팀 연결 · 이 서버 — 서버 provider 연결(아래). 운영자만 바꾼다
//   3. 기본 AI — 기능별 표(#2881 `AiDefaultsTable`). 개인 줄은 이 기기 저장, 팀 줄은
//      운영자 서버 설정(읽기 전용)
// 줄을 누르면 오른쪽 곁판이 열린다. 목록은 평평한 행, 곁판만 `sheet` 판이다.
//
// 팀 연결 줄은 R-1 §5의 인스턴스 전역 provider 연결 하나다(GET/PUT/DELETE +
// 확인). ADR-0004 때문에 자격증명은 쓰기 전용이다: 있는지와 마스킹 꼬리만 보이고
// 「키 보기」는 없다. 「API 키 추가」·「키 바꾸기」는 채팅 연결 카드와 **같은**
// `TeamKeyForm`(프리셋 칩 + 직접 주소 + password 칸)을 곁판에 연다(#2880 AA-7).
// 서버에 저장 전 판정 경로가 없어서(test 라우트는 저장된 연결만 부른다) 저장한 뒤
// 곧바로 확인하고, 결과 칸은 코어 `teamCheckResult` 문장을 그린다. 「연결 끊기」
// (#2878 문구)는 확인 창에 이 키로 대답하는 팀 에이전트를 이름으로 보인다.
//
// ChatGPT `auth.json` 붙여넣기(ADR-0147)는 새로 만들 수 없다(제안서 Q3, ADR-0147
// 증보). 이미 그렇게 저장된 연결은 「내부용 · 새로 만들 수 없음」 읽기 전용 줄로
// 남고, 곁판에서 할 수 있는 일은 끊기뿐이다.
// =============================================================================

/**
 * 잠긴 세 컨트롤(저장·확인·해제)이 가리키는 두 사유 (#1559).
 *
 * 모듈 상수 id 인 이유는 형제 화면(`AiLinkChain.CHAIN_FULL_NOTE_ID`)과 같다: 이
 * 패널에 이 블록은 하나뿐이라 `useId` 가 벌어 주는 유일성이 살 자리가 없다.
 */
const LINK_OFFLINE_NOTE_ID = "ai-link-offline-note";
const LINK_BUSY_NOTE_ID = "ai-link-busy-note";
const LINK_OFFLINE_REASON =
  "연결이 끊겨 지금은 이 연결을 바꾸거나 확인할 수 없습니다.";
const LINK_BUSY_REASON =
  "앞서 누른 것이 아직 끝나지 않았습니다. 그것이 끝나면 이어서 바꾸거나 확인할 수 있습니다.";

const PAGE_HEADING_ID = "ai-page-title";
const TEAM_HEADING_ID = "ai-team-title";
const DEFAULTS_HEADING_ID = "ai-defaults-title";
const TEAM_ASIDE_ID = "ai-team-link-aside";

function loopbackHint(error: unknown, url: string): string | null {
  if (!isLoopbackProviderUrl(url) || !isLoopbackProviderRefusal(error)) {
    return null;
  }
  return loopbackProviderGuidance();
}

function LoopbackRefusalBanner({
  error,
  url,
  serverSentence,
}: {
  error: unknown;
  url: string;
  serverSentence: string;
}) {
  const hint = loopbackHint(error, url);
  if (hint === null) return null;
  return (
    <InlineBanner
      message={hint}
      items={serverSentence !== "" ? [serverSentence] : undefined}
      className="px-0"
      testId="ai-link-loopback-hint"
    />
  );
}

/** 3R M4: 와이어 가용성 값을 사용자 어휘로. 미지 값은 원문 유지. */
function availabilityLabel(availability: string): string {
  const known: Record<string, string> = {
    live: "연결됨",
    available: "연결됨",
    mock: "모의 응답",
    unavailable: "연결 안 됨",
  };
  return known[availability] ?? availability;
}

/** 줄의 날짜(시안 「9월 27일」). 전체 시각은 곁판의 「마지막 저장」이 든다. */
function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

/** 로고 칸 글자: 주소 이름의 첫 글자. 회사 로고 자산은 쓰지 않는다. */
function markFor(label: string): string {
  const first = label.trim().charAt(0);
  return first === "" ? "?" : first.toUpperCase();
}

export function AiLinkSection({ offline, workspaceId }: { offline: boolean; workspaceId: string }) {
  return (
    <div className="ai-board-host flex min-w-0 flex-col gap-6" data-testid="ai-page">
      <div className="flex break-keep flex-col gap-1">
        <h2 id={PAGE_HEADING_ID} className="text-display font-bold text-ink">
          AI 연결
        </h2>
        <p className="text-body text-ink-muted">
          내가 쓰는 구독과 팀이 함께 쓰는 API 키를 봅니다. 로그인은 각 회사의 공식 CLI가 합니다.
        </p>
      </div>
      {offline && <AiOfflineBanner />}
      <TeamBoard offline={offline} workspaceId={workspaceId} />
    </div>
  );
}

/**
 * 목록 열 + 곁판. 곁판을 여는 것은 팀 연결 줄뿐이라(내 계정 줄은 #2777 전까지
 * 비어 있다) 판의 상태를 이 한 곳이 든다.
 */
function TeamBoard({ offline, workspaceId }: { offline: boolean; workspaceId: string }) {
  const client = useQueryClient();
  const browserTab = myAccountsBrowserTab(useSubscriptionEntryState(), IS_TAURI);
  const query = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
  });

  const [asideOpen, setAsideOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  // 「저장하고 확인」 직후의 확인인가: 실패 문장이 저장한 키가 남아 있다고 덧붙인다.
  const [justSaved, setJustSaved] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  // The chain block below owns its own draft, and the probe table in the aside
  // is numbered by the SAVED order. When the two disagree the table says so
  // rather than letting one screen carry two meanings of "3차".
  const [chainPending, setChainPending] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  const moreRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  const asideHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);
  const wasEditing = useRef(false);
  // 해제가 끝나면 줄이 사라진다. 초점은 새로 고친 목록이 도착한 뒤에 선
  // 자리(「API 키 추가」, 환경값 줄이 남으면 그 ⋯)로 간다.
  const [focusAfterUnlink, setFocusAfterUnlink] = useState(false);
  // 비어 있던 서버에 키를 저장하면 줄이 새로 서고 곁판이 상세로 다시 뜬다.
  // 초점은 그 곁판 제목으로 간다(design-review #2877 2차 High).
  const [focusHeadingAfterSave, setFocusHeadingAfterSave] = useState(false);

  // 곁판이 열리면 초점은 곁판 제목으로, 닫히면 연 자리(⋯ 또는 「API 키 추가」)로.
  // 좁은 폭에서는 곁판이 연 절 바로 밑에 쌓이므로 제목까지 스크롤도 함께 한다.
  // 편집을 열면 첫 칸으로, 닫으면(취소·저장) 「키 바꾸기」로 돌아온다. 어느
  // 전환에서도 초점이 <body> 로 떨어지지 않는다(design-review #2877 H-2).
  useEffect(() => {
    const opened = asideOpen && !wasOpen.current;
    const closed = !asideOpen && wasOpen.current;
    const startedEditing = editing && !wasEditing.current;
    const stoppedEditing = !editing && wasEditing.current;
    wasOpen.current = asideOpen;
    wasEditing.current = editing;
    if (startedEditing) {
      // 첫 칸 초점은 폼(`TeamKeyForm`)이 마운트하며 스스로 준다.
      if (opened) asideHeadingRef.current?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (opened) {
      asideHeadingRef.current?.focus({ preventScroll: true });
      asideHeadingRef.current?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (closed) {
      if (focusAfterUnlink) return;
      (moreRef.current ?? addRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (stoppedEditing && asideOpen) {
      (editRef.current ?? asideHeadingRef.current)?.focus({ preventScroll: true });
    }
  }, [asideOpen, editing, focusAfterUnlink]);

  useEffect(() => {
    if (!focusAfterUnlink || query.isFetching) return;
    (addRef.current ?? moreRef.current)?.focus({ preventScroll: true });
    setFocusAfterUnlink(false);
  }, [focusAfterUnlink, query.isFetching, query.data]);

  const invalidate = () =>
    client.invalidateQueries({ queryKey: ["settings", "provider-link"] });

  const unlink = useMutation({
    mutationFn: deleteProviderLink,
    onSuccess: () => {
      setProbe(null);
      setUnlinkOpen(false);
      setFocusAfterUnlink(true);
      setAsideOpen(false);
      void invalidate();
    },
  });

  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: setProbe,
  });

  /**
   * 저장이 끝났다(폼은 `TeamKeyForm`, 채팅 카드와 같은 것). 폼을 닫고 곧바로 확인을
   * 돈다: 서버에 저장 전 판정 경로가 없으므로 「저장하고 확인」이 이 순서다.
   */
  function onSaved() {
    if (!hasRow) setFocusHeadingAfterSave(true);
    closeForm(true);
    setProbe(null);
    setJustSaved(true);
    void invalidate();
    check.mutate();
  }

  const busy = unlink.isPending || check.isPending;
  // 진행은 잠금이 아니다 (#1403 리뷰 H-1 / #1486 문법). `busy` 는 이 패널의 두
  // 쓰기를 묶은 이름이라 「연결 끊기」에 그대로 넘기면 끊기를 누른 그 버튼이
  // 자기가 켠 busy 로 자신을 잠근다. 잠금으로 남는 것은 다른 쓰기다 (#1541).
  // 저장은 폼(`TeamKeyForm`) 안의 일이고 폼이 열린 동안 확인·끊기는 화면에 없다.
  const unlinking = unlink.isPending;
  const checking = check.isPending;
  const checkLocked = offline || (busy && !checking);
  const unlinkLocked = offline || (busy && !unlinking);

  /**
   * 잠긴 컨트롤이 가리키는 사유 (#1542 규율 · design-review #1557 M · #1559).
   * 한 잠금에 한 문장이고 오프라인이 이긴다. 자기 쓰기가 날고 있는 컨트롤은
   * 사유를 들지 않는다: 그것은 잠긴 것이 아니라 진행 중이다.
   */
  function lockReason(mine: boolean): string | undefined {
    if (offline) return LINK_OFFLINE_NOTE_ID;
    return busy && !mine ? LINK_BUSY_NOTE_ID : undefined;
  }

  /**
   * 폼을 닫는다. 줄이 없는 서버(「API 키 추가」)에서는 폼이 곧 곁판의 전부라
   * 곁판도 함께 닫힌 것으로 둔다: 그래야 초점이 「API 키 추가」로 돌아오고 Esc
   * 층도 내려간다. 저장 성공은 예외다(`keepAside`): 곧 줄이 서고 곁판이 상세로 뜬다.
   */
  function closeForm(keepAside = false) {
    setEditing(false);
    if (!keepAside && !hasRow) setAsideOpen(false);
  }

  function closeAside() {
    closeForm();
    setAsideOpen(false);
  }


  function startEditing() {
    // 폼은 저장된 주소를 「지금 주소」 칩이나 같은 프리셋으로 연다(코어
    // `initialPresetId`). 환경값의 모의 주소는 시작값으로 내밀지 않는다.
    setEditing(true);
    setAsideOpen(true);
  }

  const link = query.data;
  const configured = link?.configured === true;
  // 줄이 서는 연결: 이 서버에 저장된 것, 또는 서버 환경값이 실제 provider 를
  // 가리키는 것. 환경값 연결을 「비어 있음」으로 그리면 거짓이다(팀 에이전트는
  // 그것으로 대답하고 있다). 모의 모드만 비어 있음이다.
  const hasRow = link
    ? configured || (link.keyConfigured && link.availability !== "mock")
    : false;
  const asideVisible = asideOpen && link !== undefined && (hasRow || editing);

  // Esc 는 곁판 층의 것이다(설정 전체가 아니라). 편집 중이면 [취소]와 같고, 아니면
  // 곁판을 닫는다. 층을 내리면 Esc 가 설정 라우트까지 떨어져 적던 키와 함께 설정이
  // 닫힌다(design-review #2877 H-1). 보이는 곁판이 없으면 층도 없다.
  useEscapeLayer(asideVisible, editing ? () => closeForm() : closeAside);

  useEffect(() => {
    if (!focusHeadingAfterSave || !asideHeadingRef.current) return;
    asideHeadingRef.current.focus({ preventScroll: true });
    setFocusHeadingAfterSave(false);
  }, [focusHeadingAfterSave, asideVisible, query.data]);
  const legacy = link ? isLegacyTeamLink(link) : false;
  const operator = query.isSuccess;
  // 기본 AI 표의 팀 줄 판정은 이 절과 같은 서버 답이다(운영자 200 · 아니면 403).
  const operatorAnswer: boolean | null = query.isSuccess
    ? true
    : query.isError && isOperatorDenied(query.error)
      ? false
      : null;

  const teamAction =
    operator && link && !hasRow ? (
      <Button
        ref={addRef}
        type="button"
        variant="outline"
        size="sm"
        className="tap-target"
        onClick={() => startEditing()}
        data-testid="ai-team-add"
      >
        <Plus aria-hidden="true" />
        API 키 추가
      </Button>
    ) : null;

  // 판정은 코어 한 곳(#2941): 채팅 연결 카드와 같은 입력이면 같은 알약이다.
  const pill = link ? linkPill({ link, offline, probe, checking: check.isPending }) : null;
  // 방금 확인에서 키가 실패했는가. 서버가 부르지 않은 확인(`probe_not_run`)은 실패가 아니다.
  const failed = probe !== null && !probe.ok && probe.reason !== PROBE_NOT_RUN;
  const defaultsTeamKey: AiDefaultsTeamKey = query.isPending
    ? { status: "loading" }
    : query.isError
      ? isOperatorDenied(query.error)
        ? { status: "hidden" }
        : { status: "error" }
      : !link
        ? { status: "loading" }
        : hasRow
          ? {
              status: "present",
              name: link.endpointLabel,
              failed,
              modelCount: teamProbeDetail(probe)?.modelCount ?? null,
            }
          : // 팀 연결 절의 둘째 줄과 같은 판정(모의 응답 / 대답하지 못함).
            link.availability === "mock"
            ? { status: "mock" }
            : { status: "absent" };
  const rowName = link ? (configured ? `${link.endpointLabel} · 팀 기본` : link.endpointLabel) : "";

  const teamSection = (
    <AiSection labelledBy={TEAM_HEADING_ID} testId="ai-team">
      <AiSectionHead
        id={TEAM_HEADING_ID}
        title="팀 연결"
        scope="이 서버"
        locked
        action={teamAction}
      />
      {query.isPending ? (
        <Skeleton ready={false} rows={2} className="py-3" />
      ) : query.isError ? (
        isOperatorDenied(query.error) ? (
          <div data-testid="operator-notice" role="status">
            <AiLineRow last>
              <span>
                팀 연결은 이 서버의 운영자만 보고 바꿀 수 있어요. 필요하면 이 서버를 운영하는
                사람에게 요청하세요.
              </span>
            </AiLineRow>
          </div>
        ) : (
          <InlineBanner
            message={errorMessage(query.error)}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="ai-link-error"
          />
        )
      ) : link && !hasRow ? (
        <AiLineRow testId="ai-link-empty" last>
          <span>아직 팀 연결이 없어요. 팀 에이전트가 대답하려면 API 키가 하나 필요해요.</span>
          {/* 둘째 줄은 지금 팀 에이전트가 무엇으로 대답하는지 한 가지만 말한다
              (design-review #2877 3차 M1: 「서버 환경값 사용 중」이 무언가 쓰이는
              것처럼 읽혔다). 어휘는 가용성 줄과 같은 「모의 응답」이다. */}
          <span className="text-meta text-ink-muted">
            {link.availability === "mock"
              ? "지금 팀 에이전트는 모의 응답으로만 대답해요."
              : "지금 팀 에이전트는 대답하지 못해요."}
          </span>
        </AiLineRow>
      ) : link ? (
        <AiAccountRow
          ref={moreRef}
          mark={markFor(link.endpointLabel)}
          name={rowName}
          badge={
            !legacy && configured ? (
              <span role="img" className="shrink-0 text-meta text-signal-text" aria-label="기본">
                ★
              </span>
            ) : undefined
          }
          detail={
            legacy ? (
              <>
                <AiSource>내부용</AiSource>새로 만들 수 없음
              </>
            ) : !configured ? (
              <>
                <AiSource>API 키</AiSource>
                {providerSourceLabel(link.source)}
              </>
            ) : (
              <>
                <AiSource>API 키</AiSource>
                <span className="font-mono" data-numeric>
                  {maskedBearer(link.bearerLast4)}
                </span>
                {offline
                  ? " · 마지막으로 받은 값"
                  : link.updatedAtMs
                    ? ` · ${shortDate(link.updatedAtMs)}`
                    : ` · ${providerSourceLabel(link.source)}`}
              </>
            )
          }
          state={
            pill && (
              <>
                <AiPill tone={pill.tone}>{pill.text}</AiPill>
                {/* 서버가 부르지 않은 확인에는 시각을 달지 않는다: 확인한 적이 없다
                    (design-review #2880 M1). */}
                {probe && !offline && probe.reason !== PROBE_NOT_RUN && (
                  <span>{formatMoment(probe.checkedAtMs)} 확인</span>
                )}
              </>
            )
          }
          use={<span className="break-keep">사용량 표시 준비 중</span>}
          moreLabel={`${link.endpointLabel} 더 보기`}
          selected={asideOpen}
          asideId={TEAM_ASIDE_ID}
          onOpen={() => {
            closeForm();
            setAsideOpen(true);
          }}
          testId="ai-link-row"
        />
      ) : null}
      {/* A saved chain makes the probe table describe a cascade that no longer
          exists, exactly as save/unlink do for the singleton. Same clear. 대체
          순서는 운영자 도구라 운영자에게만 선다(403 은 위 안내가 말한다). */}
      {operator && (
        <div className="flex min-w-0 flex-col gap-3 pt-3">
          {/* 대체 순서(ADR-0135 D1)는 지금 서버가 받는 운영자 도구라 남긴다. 시안의
              줄 목록 사이에 편집기를 펼쳐 두면 페이지가 그것으로 가득 차므로 접어
              둔다(#2880 이 여러 키를 줄로 올리면 이 자리가 그 줄들이 된다). */}
          <button
            type="button"
            aria-expanded={chainOpen}
            aria-controls="ai-team-chain"
            onClick={() => setChainOpen((open) => !open)}
            className="tap-target press inline-flex w-max items-center gap-2 rounded-md px-2 py-1 text-meta font-semibold text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
            data-testid="ai-team-chain-toggle"
          >
            <ChevronRight
              className={cn("size-4 shrink-0 transition-transform", chainOpen && "rotate-90")}
              aria-hidden="true"
            />
            예비 provider와 시도 순서
          </button>
          {chainOpen && (
            <div id="ai-team-chain" className="min-w-0">
              <AiLinkChain
                offline={offline}
                onSaved={() => setProbe(null)}
                onPendingChange={setChainPending}
              />
            </div>
          )}
        </div>
      )}
    </AiSection>
  );

  return (
    <div
      className="ai-board"
      data-aside-open={asideVisible ? "" : undefined}
      data-testid="ai-board"
    >
      <div className="ai-pane flex min-w-0 flex-col gap-6" data-area="top">
        {/* 추가 창의 「API 키 · 팀이 함께」는 이 절의 「API 키 추가」와 같은 폼을 연다. */}
        <AiMyAccountsSection onAddApiKey={operator && link ? startEditing : undefined} />
        {teamSection}
      </div>
      <div className="ai-pane flex min-w-0 flex-col gap-6" data-area="bottom">
        <AiSection labelledBy={DEFAULTS_HEADING_ID} testId="ai-defaults">
          <AiSectionHead
            id={DEFAULTS_HEADING_ID}
            title="기본 AI"
            scope="기능마다 부를 계정과 모델"
          />
          <AiDefaultsTable teamKey={defaultsTeamKey} operator={operatorAnswer} browserTab={browserTab} />
        </AiSection>
      </div>

      {asideVisible && link && (
        <div data-area="aside" className="min-w-0">
        <AiAside
          id={TEAM_ASIDE_ID}
          // 줄이 없는 서버에서 연 곁판은 추가 폼 하나다: 환경값의 모의 주소 이름을
          // 제목으로 내밀지 않는다(시안 §4 2b 「팀 API 키 추가」).
          label={hasRow ? `${link.endpointLabel} 상세` : "팀 API 키 추가"}
          mark={hasRow ? markFor(link.endpointLabel) : "+"}
          title={hasRow ? rowName : "팀 API 키 추가"}
          subtitle={
            !hasRow
              ? "운영자만 · 서버에 봉인해요"
              : legacy
                ? "내부용 연결 · 이 서버"
                : "API 키 · 이 서버 · 팀 에이전트가 씀"
          }
          onClose={closeAside}
          headingRef={asideHeadingRef}
          testId="ai-team-aside"
        >
          {editing ? (
            <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ai-link-form-title">
              <h4
                id="ai-link-form-title"
                className={hasRow ? "text-body font-bold text-ink" : "sr-only"}
              >
                {configured ? "키 바꾸기" : "API 키 추가"}
              </h4>
              {/* 채팅 연결 카드와 같은 폼(#2880): 프리셋 칩·password 칸·오프라인
                  잠금·대체 전 한 번 묻기가 두 표면에서 한 벌이다. 설정만 「직접 주소」를
                  세운다. */}
              <TeamKeyForm
                link={link}
                offline={offline}
                offlineNoteId={LINK_OFFLINE_NOTE_ID}
                currentFailed={failed}
                onCancel={() => closeForm()}
                onSaved={onSaved}
                surface="settings"
                saveErrorHint={loopbackHint}
                testIdPrefix="ai-link"
              />
            </section>
          ) : (
            <TeamLinkDetail link={link} legacy={legacy} pill={pill} probe={probe} />
          )}

          {!editing && (
            <div className="flex min-w-0 flex-col gap-2" data-testid="ai-team-aside-actions">
              <div className="flex flex-wrap items-center gap-2">
                {!legacy && (
                  <>
                    {/* 낱말꼴은 「명사 + 중」: 확인은 한자어 동작명사다 (#1501). */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-disabled={checkLocked || undefined}
                      aria-busy={checking || undefined}
                      aria-describedby={lockReason(checking)}
                      className={cn("tap-target bg-surface shadow-sm", checkLocked && "opacity-50")}
                      onClick={() => {
                        if (checkLocked || checking) return;
                        setJustSaved(false);
                        check.mutate();
                      }}
                      data-testid="ai-link-check"
                    >
                      {checking ? "확인 중" : probe && probe.reason !== PROBE_NOT_RUN ? "다시 확인" : "연결 확인"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-disabled={offline || undefined}
                      aria-describedby={offline ? LINK_OFFLINE_NOTE_ID : undefined}
                      className={cn("tap-target bg-surface shadow-sm", offline && "opacity-50")}
                      onClick={() => {
                        if (offline) return;
                        startEditing();
                      }}
                      ref={editRef}
                      data-testid="ai-link-edit"
                    >
                      {configured ? "키 바꾸기" : "API 키 추가"}
                    </Button>
                  </>
                )}
                {configured && (
                  // 문구는 「연결 끊기」(#2878 결정: 구독 줄은 「연결 해제」, 팀 API 키 줄은
                  // 「연결 끊기」). 누르면 영향 받는 에이전트를 먼저 보이는 확인 창이 뜬다.
                  <Button
                    ref={unlinkRef}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-disabled={unlinkLocked || undefined}
                    aria-describedby={lockReason(unlinking)}
                    aria-haspopup="dialog"
                    className={cn("tap-target bg-surface text-danger shadow-sm", unlinkLocked && "opacity-50")}
                    onClick={() => {
                      if (unlinkLocked) return;
                      unlink.reset();
                      setUnlinkOpen(true);
                    }}
                    data-testid="ai-link-unlink"
                  >
                    연결 끊기
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* 두 사유는 수정 폼과 그 폼이 닫힌 자리 **양쪽 밖**에 산다: 저장은 폼 안,
              확인과 끊기는 폼이 닫힌 자리에 있어 어느 한쪽에 두면 다른 쪽의
              `aria-describedby` 가 화면에 없는 id 를 가리키게 된다. */}
          {offline && (
            <p
              id={LINK_OFFLINE_NOTE_ID}
              className="break-keep text-meta text-ink-muted"
              data-testid="ai-link-offline"
            >
              {LINK_OFFLINE_REASON}
            </p>
          )}
          {!offline && busy && (
            <p
              id={LINK_BUSY_NOTE_ID}
              className="break-keep text-meta text-ink-muted"
              data-testid="ai-link-busy"
            >
              {LINK_BUSY_REASON}
            </p>
          )}

          {!editing && !offline && check.isError &&
            (loopbackHint(check.error, link.baseUrl) ? (
              <LoopbackRefusalBanner
                error={check.error}
                url={link.baseUrl}
                serverSentence={errorMessage(check.error)}
              />
            ) : (
              <p className="text-meta text-danger" role="alert">
                {errorMessage(check.error)}
              </p>
            ))}
          {!editing && !offline && probe && !checking && (
            <ProbeAnswer probe={probe} link={link} chainPending={chainPending} justSaved={justSaved} />
          )}
          {configured && (
            <TeamUnlinkDialog
              open={unlinkOpen}
              onOpenChange={(open) => {
                if (!open && unlinking) return;
                setUnlinkOpen(open);
              }}
              opener={unlinkRef}
              workspaceId={workspaceId}
              rowName={rowName}
              legacy={legacy}
              busy={unlinking}
              offline={offline}
              error={unlink.isError ? errorMessage(unlink.error) : null}
              onConfirm={() => {
                if (unlinking || offline) return;
                unlink.mutate();
              }}
            />
          )}
        </AiAside>
        </div>
      )}
    </div>
  );
}

/** 곁판 본문: 상태 카드와 쓰는 곳 카드(시안 §1 `.card` 둘). */
function TeamLinkDetail({
  link,
  legacy,
  pill,
  probe,
}: {
  link: ProviderLink;
  legacy: boolean;
  pill: AiPillView | null;
  probe: ProviderLinkTest | null;
}) {
  const kind = credentialKind(link);
  const meta = credentialMeta(link);
  const diagnostics = (arrayField(link, "diagnostics") ?? []).filter(
    (line): line is string => typeof line === "string"
  );

  // 연결 헬스는 한 줄씩 붙는 목록이지 고정 슬롯이 아니다. 행은 조건부 push로
  // 쌓는다 - 나중에 한 줄을 받는 데 구조 변경이 필요 없다.
  const rows: KeyValue[] = [
    { key: "등록 방식", value: credentialKindLabel(kind) },
    { key: "모드", value: choiceLabel(PROVIDER_MODES, link.mode) },
  ];
  if (legacy && meta) {
    rows.push({
      key: "계정",
      value: meta.accountLabel ?? "라벨 없음",
      prose: true,
    });
    // The stored `bearerLast4` of an OAuth link is the tail of the SHORT-LIVED
    // access token, not of a saved key, so the token's own row says what is
    // actually true about it. Colour reinforces the sentence, never replaces it.
    const token = accessTokenStatus(meta, Date.now());
    rows.push({
      key: "액세스 토큰",
      prose: true,
      value:
        token.tone === "warn" ? (
          <span className="text-warn">{token.text}</span>
        ) : token.tone === "muted" ? (
          <span className="text-ink-muted">{token.text}</span>
        ) : (
          token.text
        ),
    });
  } else {
    rows.push({ key: "저장된 키", value: maskedBearer(link.bearerLast4), numeric: true });
  }
  rows.push({ key: "가용성", value: availabilityLabel(link.availability) });
  if (link.updatedAtMs) {
    rows.push({ key: "마지막 저장", value: formatMoment(link.updatedAtMs) });
  }
  if (probe) {
    // Client-session only, and labelled as such: the server keeps no record of
    // when anyone last probed.
    rows.push({ key: "이 화면에서 마지막 확인", value: formatMoment(probe.checkedAtMs) });
  }

  return (
    <>
      <AiCard
        title="상태"
        trailing={pill && <AiPill tone={pill.tone}>{pill.text}</AiPill>}
        testId="ai-link-card"
      >
        <KeyValueRows rows={rows} />
        {/* The server's own sentence, rendered verbatim (ADR-0147 라벨 요구). */}
        {legacy && meta?.notice && (
          <p
            className="border-l-2 border-line pl-3 break-keep text-meta text-ink-muted"
            data-testid="ai-link-oauth-notice"
          >
            {meta.notice}
          </p>
        )}
        {legacy && (
          <p className="break-keep text-meta text-ink-muted" data-testid="ai-link-legacy-note">
            ChatGPT auth.json을 붙여 만든 내부용 연결이에요. 이 방식으로는 새로 만들 수 없고,
            끊은 뒤에는 API 키로 다시 연결하세요.
          </p>
        )}
        {diagnostics.length > 0 && (
          <ul className="flex flex-col gap-1">
            {diagnostics.map((line) => (
              <li key={line} className="text-meta text-warn">
                {line}
              </li>
            ))}
          </ul>
        )}
      </AiCard>
      <AiCard title="이 연결을 쓰는 곳">
        <ul className="flex flex-col gap-2 text-meta text-ink">
          <li className="break-keep">팀 에이전트가 대답할 때 먼저 부르는 연결</li>
        </ul>
        <p className="break-keep text-meta text-ink-muted">사용량 표시는 준비 중이에요.</p>
      </AiCard>
    </>
  );
}

/** 결과 칸의 색 갈래. 채팅 카드 결과 줄(`RESULT_TONE`)과 같은 뜻: ok 초록, bad 빨강, mute 무채. */
const PROBE_BOX_TONE: Record<"ok" | "bad" | "mute", string> = {
  ok: "border-ok/40 bg-ok-soft",
  bad: "border-danger/40 bg-danger-soft",
  mute: "border-line bg-surface",
};
const PROBE_HEAD_TONE: Record<"ok" | "bad" | "mute", string> = {
  ok: "text-ok",
  bad: "text-danger",
  mute: "text-ink",
};

/**
 * 확인 결과. 첫 칸(팀 기본 키)의 결과는 시안 §4 2b `.check` 칸 하나로, 문장은 채팅
 * 연결 카드와 같은 코어 `teamCheckResult`다. 예비 provider가 있는 서버(ADR-0135 D1
 * `entries[]`가 둘 이상)면 칸마다의 표가 그 밑에 선다.
 */
function ProbeAnswer({
  probe,
  link,
  chainPending,
  justSaved,
}: {
  probe: ProviderLinkTest;
  link: ProviderLink;
  chainPending: boolean;
  justSaved: boolean;
}) {
  // Parsed rather than trusted: `entries` is an ADR-0135 D1 addition, so an
  // unreadable answer degrades to the single-hop sentence (see chainModel).
  const probeEntries = parseProbeEntries(arrayField(probe, "entries"));
  if (loopbackHint(probe.reason ?? "", link.baseUrl)) {
    return (
      <LoopbackRefusalBanner
        error={probe.reason ?? ""}
        url={link.baseUrl}
        serverSentence={providerTestMessage(probe)}
      />
    );
  }
  const line = teamCheckResult({ probe, justSaved, nowMs: Date.now() });
  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2",
          PROBE_BOX_TONE[line.tone]
        )}
        role="status"
        data-testid="ai-link-probe"
        data-tone={line.tone}
      >
        <b className={cn("text-meta font-bold", PROBE_HEAD_TONE[line.tone])}>
          {line.headline}
        </b>
        <span className="break-keep text-meta text-ink-muted" data-testid="ai-link-probe-text">
          <CheckSentence text={line.text} />
        </span>
        {line.detailParts.length > 0 && (
          <span className="break-keep text-meta tabular-nums text-ink" data-testid="ai-link-probe-detail">
            <CheckNumbers parts={line.detailParts} />
          </span>
        )}
      </div>
      {probeEntries.length > 1 && (
        <ChainProbeResult
          cascadeOk={probe.cascadeOk === true}
          entries={probeEntries}
          checkedAtMs={probe.checkedAtMs}
          chainPending={chainPending}
        />
      )}
    </>
  );
}
