import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  deleteProviderLink,
  fetchProviderLink,
  putProviderLink,
  testProviderLink,
  type ProviderLink,
  type ProviderLinkInput,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
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
import {
  ChoiceRadios,
  ConfirmButton,
  Field,
  KeyValueRows,
  type KeyValue,
} from "./SettingsFields";
import { AiLinkChain, ChainProbeResult } from "./AiLinkChain";
import {
  accessTokenStatus,
  credentialKind,
  credentialKindLabel,
  credentialMeta,
  formatMoment,
  OAUTH_CREDENTIAL_KIND,
  type LinkFormField,
  validateBaseUrl,
} from "./oauthGrant";
import {
  AiAccountRow,
  AiAside,
  AiCard,
  AiFoot,
  AiLineRow,
  AiOfflineBanner,
  AiPill,
  AiSection,
  AiSectionHead,
  AiSource,
  type AiPillTone,
} from "./aiAccountsParts";
import { AiMyAccountsSection } from "./AiMyAccountsSection";

// =============================================================================
// 설정 › AI 연결 (#2877, 시안 claudedocs/ai-accounts/mockups.html §1·§6).
//
// 이름과 id(`ai`)는 그대로고 내용이 바뀌었다(제안서 Q3). 한 페이지에 절이
// 위에서 아래로 선다.
//   1. 내 계정 · 이 맥 — 이 맥의 공식 CLI 구독(`AiMyAccountsSection`)
//   2. 팀 연결 · 이 서버 — 서버 provider 연결(아래). 운영자만 바꾼다
//   3. 기본 AI — 자리만(#2881)
// 줄을 누르면 오른쪽 곁판이 열린다. 목록은 평평한 행, 곁판만 `sheet` 판이다.
//
// 팀 연결 줄은 R-1 §5의 인스턴스 전역 provider 연결 하나다(GET/PUT/DELETE +
// 확인). ADR-0004 때문에 자격증명은 쓰기 전용이다: 있는지와 마스킹 꼬리만 보이고
// 「키 보기」는 없다. 프리셋으로 여러 키를 더하는 흐름은 #2880이 이 자리에 올린다.
// 그 전까지 「API 키 추가」·「키 바꾸기」는 지금 서버가 받는 한 벌 PUT 폼을
// 곁판에 연다.
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

/** 줄의 상태 알약. 오프라인이면 마지막 값을 확인할 수 없다고 말한다(시안 §6). */
function linkPill(
  link: ProviderLink,
  legacy: boolean,
  offline: boolean,
  probe: ProviderLinkTest | null
): { tone: AiPillTone; text: string } {
  if (offline) return { tone: "mute", text: "확인할 수 없음" };
  if (legacy) return { tone: "mute", text: "읽기 전용" };
  if (probe) return probe.ok ? { tone: "ok", text: "확인됨" } : { tone: "warn", text: "확인 실패" };
  if (link.configured && link.keyConfigured) {
    return link.availability === "mock"
      ? { tone: "mute", text: "모의 응답" }
      : { tone: "ok", text: "연결됨" };
  }
  if (link.configured) return { tone: "warn", text: "자격증명 없음" };
  return { tone: "mute", text: "연결 안 됨" };
}

export function AiLinkSection({ offline }: { offline: boolean }) {
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
      <TeamBoard offline={offline} />
    </div>
  );
}

/**
 * 목록 열 + 곁판. 곁판을 여는 것은 팀 연결 줄뿐이라(내 계정 줄은 #2777 전까지
 * 비어 있다) 판의 상태를 이 한 곳이 든다.
 */
function TeamBoard({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
  });

  const [asideOpen, setAsideOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [mode, setMode] = useState("external-hermes");
  const [fieldError, setFieldError] = useState<
    Partial<Record<LinkFormField, string>>
  >({});
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  // The chain block below owns its own draft, and the probe table in the aside
  // is numbered by the SAVED order. When the two disagree the table says so
  // rather than letting one screen carry two meanings of "3차".
  const [chainPending, setChainPending] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  const moreRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const asideHeadingRef = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(false);

  // 곁판이 열리면 초점은 곁판 제목으로, 닫히면 연 자리(⋯ 또는 「API 키 추가」)로.
  // 좁은 폭에서는 곁판이 목록 아래에 쌓이므로 제목까지 스크롤도 함께 한다.
  useEffect(() => {
    if (asideOpen && !wasOpen.current) {
      asideHeadingRef.current?.focus({ preventScroll: true });
      asideHeadingRef.current?.scrollIntoView?.({ block: "nearest" });
    } else if (!asideOpen && wasOpen.current) {
      (moreRef.current ?? addRef.current)?.focus({ preventScroll: true });
    }
    wasOpen.current = asideOpen;
  }, [asideOpen]);

  const invalidate = () =>
    client.invalidateQueries({ queryKey: ["settings", "provider-link"] });

  const save = useMutation({
    mutationFn: (input: ProviderLinkInput) => putProviderLink(input),
    onSuccess: () => {
      closeForm();
      setProbe(null);
      void invalidate();
    },
  });

  const unlink = useMutation({
    mutationFn: deleteProviderLink,
    onSuccess: () => {
      setProbe(null);
      setAsideOpen(false);
      void invalidate();
    },
  });

  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: setProbe,
  });

  const busy = save.isPending || unlink.isPending || check.isPending;
  // 진행은 잠금이 아니다 (#1403 리뷰 H-1 / #1486 문법). `busy` 는 이 패널의 세
  // 쓰기를 묶은 이름이라 「연결 해제」에 그대로 넘기면 해제를 누른 그 버튼이
  // 자기가 켠 busy 로 자신을 잠근다. 잠금으로 남는 것은 다른 두 쓰기다 (#1541).
  const unlinking = unlink.isPending;
  const saving = save.isPending;
  const checking = check.isPending;
  const saveLocked = offline || (busy && !saving);
  const checkLocked = offline || (busy && !checking);

  /**
   * 잠긴 컨트롤이 가리키는 사유 (#1542 규율 · design-review #1557 M · #1559).
   * 한 잠금에 한 문장이고 오프라인이 이긴다. 자기 쓰기가 날고 있는 컨트롤은
   * 사유를 들지 않는다: 그것은 잠긴 것이 아니라 진행 중이다.
   */
  function lockReason(mine: boolean): string | undefined {
    if (offline) return LINK_OFFLINE_NOTE_ID;
    return busy && !mine ? LINK_BUSY_NOTE_ID : undefined;
  }

  function closeForm() {
    setEditing(false);
    setBearer("");
    setFieldError({});
  }

  function closeAside() {
    closeForm();
    setAsideOpen(false);
  }

  // Esc 는 곁판을 닫는다(설정 전체가 아니라). 키를 적는 중에는 층을 세우지
  // 않는다: 반사적 Esc 가 입력을 날리지 않게(SettingsRoute 3R M5 와 같은 이유).
  useEscapeLayer(asideOpen && !editing, closeAside);

  function startEditing(link: ProviderLink) {
    // Prefill only from a stored link. The environment fallback is a mock
    // address, and offering it as the starting value for a real provider would
    // be a suggestion, not a default.
    setBaseUrl(link.configured ? link.baseUrl : "");
    setMode(link.configured ? link.mode : "external-hermes");
    setBearer("");
    setFieldError({});
    setEditing(true);
    setAsideOpen(true);
  }

  function submitKey() {
    const addressError = validateBaseUrl(baseUrl);
    if (addressError) {
      setFieldError({ [addressError.field]: addressError.message });
      return;
    }
    if (!bearer.trim()) {
      setFieldError({
        bearer: "키를 입력하세요. 저장된 키는 다시 내려오지 않으므로 매번 새로 입력합니다.",
      });
      return;
    }
    setFieldError({});
    save.mutate({ baseUrl: baseUrl.trim(), bearer, mode });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // 잠금이 `aria-disabled` 라 클릭도 Enter 도 막지 않는다. 막는 일은 핸들러가
    // 지고, 폼의 `onSubmit` 인 이유는 주소 칸의 Enter(암묵적 제출)도 같은 쓰기를
    // 내기 때문이다.
    if (saveLocked || saving) return;
    submitKey();
  }

  const link = query.data;
  const configured = link?.configured === true;
  // 줄이 서는 연결: 이 서버에 저장된 것, 또는 서버 환경값이 실제 provider 를
  // 가리키는 것. 환경값 연결을 「비어 있음」으로 그리면 거짓이다(팀 에이전트는
  // 그것으로 대답하고 있다). 모의 모드만 비어 있음이다.
  const hasRow = link
    ? configured || (link.keyConfigured && link.availability !== "mock")
    : false;
  const legacy = link ? credentialKind(link) === OAUTH_CREDENTIAL_KIND : false;
  const operator = query.isSuccess;

  const teamAction =
    operator && link && !hasRow ? (
      <Button
        ref={addRef}
        type="button"
        variant="outline"
        size="sm"
        className="tap-target"
        onClick={() => startEditing(link)}
        data-testid="ai-team-add"
      >
        <Plus aria-hidden="true" />
        API 키 추가
      </Button>
    ) : null;

  const pill = link ? linkPill(link, legacy, offline, probe) : null;
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
              <span>팀 연결은 이 서버의 운영자만 보고 바꿀 수 있어요.</span>
            </AiLineRow>
            <AiFoot>
              키를 추가하거나 바꾸는 것은 운영자만 할 수 있어요. 필요하면 이 서버를 운영하는
              사람에게 요청하세요.
            </AiFoot>
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
          <span className="text-meta text-ink-muted">
            {`지금은 ${providerSourceLabel(link.source)}이며, 모드는 ${choiceLabel(
              PROVIDER_MODES,
              link.mode
            )}입니다.`}
          </span>
        </AiLineRow>
      ) : link ? (
        <AiAccountRow
          ref={moreRef}
          mark={markFor(link.endpointLabel)}
          name={
            <>
              {rowName}
              {!legacy && (
                <span className="ms-1 text-meta text-signal-text" aria-label="기본">
                  ★
                </span>
              )}
            </>
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
                {probe && !offline && <span>{formatMoment(probe.checkedAtMs)} 확인</span>}
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
          dim={legacy}
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
      data-aside-open={asideOpen && link && (hasRow || editing) ? "" : undefined}
      data-testid="ai-board"
    >
      <div className="ai-pane flex min-w-0 flex-col gap-6">
        <AiMyAccountsSection />
        {teamSection}
        <AiSection labelledBy={DEFAULTS_HEADING_ID} testId="ai-defaults">
          <AiSectionHead
            id={DEFAULTS_HEADING_ID}
            title="기본 AI"
            scope="기능마다 부를 계정과 모델"
          />
          <AiLineRow last>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              기능마다 어떤 AI를 부를지 고르는 표는 준비 중이에요.
              <AiPill tone="mute">준비 중</AiPill>
            </span>
          </AiLineRow>
        </AiSection>
      </div>

      {asideOpen && link && (hasRow || editing) && (
        <AiAside
          id={TEAM_ASIDE_ID}
          label={`${link.endpointLabel} 상세`}
          mark={markFor(link.endpointLabel)}
          title={editing ? (configured ? "키 바꾸기" : "API 키 추가") : rowName}
          subtitle={legacy ? "내부용 연결 · 이 서버" : "API 키 · 이 서버 · 팀 에이전트가 씀"}
          onClose={closeAside}
          headingRef={asideHeadingRef}
          testId="ai-team-aside"
        >
          {editing ? (
            <form
              className="flex min-w-0 flex-col gap-3"
              onSubmit={submit}
              data-testid="ai-link-form"
            >
              {configured && (
                <p className="break-keep text-meta text-ink-muted" data-testid="ai-link-card-tense">
                  저장하면 지금 연결을 대체합니다. 키는 다시 보여 주지 않으니 새로 넣으세요.
                </p>
              )}
              <Field
                label="provider 주소"
                htmlFor="provider-base-url"
                hint="OpenAI 호환 주소. 예: https://api.example.com/v1"
                error={fieldError.baseUrl}
              >
                <Input
                  id="provider-base-url"
                  name="baseUrl"
                  value={baseUrl}
                  autoComplete="off"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Field>
              <Field
                label="API 키"
                htmlFor="provider-bearer"
                hint="저장하면 서버에 봉인됩니다. 다시 볼 수 없고 바꾸기만 할 수 있어요."
                error={fieldError.bearer}
              >
                <Input
                  id="provider-bearer"
                  name="bearer"
                  type="password"
                  value={bearer}
                  autoComplete="off"
                  onChange={(e) => setBearer(e.target.value)}
                />
              </Field>
              <ChoiceRadios
                name="provider-mode"
                legend="모드"
                choices={PROVIDER_MODES}
                value={mode}
                onChange={setMode}
              />

              {save.isError &&
                (loopbackHint(save.error, baseUrl) ? (
                  <LoopbackRefusalBanner
                    error={save.error}
                    url={baseUrl}
                    serverSentence={errorMessage(save.error)}
                  />
                ) : (
                  <p className="text-meta text-danger" role="alert">
                    {errorMessage(save.error)}
                  </p>
                ))}

              <div className="flex flex-wrap items-center gap-2">
                {/* 진행은 `aria-busy` 와 바뀐 낱말이 지고 흐리지 않는다. 잠금은
                    `aria-disabled` + 흐림 + 가드가 지고 tab order 를 떠나지 않는다
                    (#1486 회전 · #1541). */}
                <Button
                  type="submit"
                  size="sm"
                  aria-disabled={saveLocked || undefined}
                  aria-busy={saving || undefined}
                  aria-describedby={lockReason(saving)}
                  className={cn("tap-target", saveLocked && "opacity-50")}
                  data-testid="ai-link-save"
                >
                  {saving ? "저장 중" : configured ? "키 바꿔 저장" : "연결 저장"}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="tap-target" onClick={closeForm}>
                  취소
                </Button>
              </div>
            </form>
          ) : (
            <TeamLinkDetail link={link} legacy={legacy} pill={pill} probe={probe} />
          )}

          {!editing && (
            <div className="flex min-w-0 flex-col gap-2" data-testid="ai-team-aside-actions">
              {!legacy && (
                <div className="flex flex-wrap items-center gap-2">
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
                      check.mutate();
                    }}
                    data-testid="ai-link-check"
                  >
                    {checking ? "확인 중" : "연결 확인"}
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
                      startEditing(link);
                    }}
                    data-testid="ai-link-edit"
                  >
                    {configured ? "키 바꾸기" : "API 키 추가"}
                  </Button>
                </div>
              )}
              {configured && (
                <ConfirmButton
                label={legacy ? "연결 끊기" : "연결 해제"}
                question={
                  legacy
                    ? "이 내부용 연결을 지웁니다. 같은 방식으로는 다시 만들 수 없어요."
                    : "저장된 주소와 자격증명을 지웁니다. 팀 에이전트가 이 연결로 대답하지 못하게 됩니다."
                }
                confirmLabel={legacy ? "끊기" : "해제"}
                disabled={offline || (busy && !unlinking)}
                describedBy={lockReason(unlinking)}
                busy={unlinking}
                // 한자어 동작명사(해제)가 있는 자리라 「명사 + 중」이다 (#1501).
                busyLabel="해제 중"
                onConfirm={() => unlink.mutate()}
                testId="ai-link-unlink"
              />
              )}
            </div>
          )}

          {/* 두 사유는 수정 폼과 그 폼이 닫힌 자리 **양쪽 밖**에 산다: 저장은 폼 안,
              확인과 해제는 폼이 닫힌 자리에 있어 어느 한쪽에 두면 다른 쪽의
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

          {check.isError &&
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
          {unlink.isError && (
            <p className="text-meta text-danger" role="alert">
              {errorMessage(unlink.error)}
            </p>
          )}
          {!editing && probe && (
            <ProbeAnswer probe={probe} link={link} chainPending={chainPending} />
          )}
        </AiAside>
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
  pill: { tone: AiPillTone; text: string } | null;
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

/**
 * One probe, two shapes. A server that carries the ADR-0135 D1 chain answers
 * `entries[]`, and then the per-hop table IS the result. A server built before
 * the chain landed answers the MOMO-572 body, and that sentence stays.
 */
function ProbeAnswer({
  probe,
  link,
  chainPending,
}: {
  probe: ProviderLinkTest;
  link: ProviderLink;
  chainPending: boolean;
}) {
  // Parsed rather than trusted: `entries` is an ADR-0135 D1 addition, so an
  // unreadable answer degrades to the single-hop sentence (see chainModel).
  const probeEntries = parseProbeEntries(arrayField(probe, "entries"));
  if (probeEntries.length > 0) {
    return (
      <ChainProbeResult
        cascadeOk={probe.cascadeOk === true}
        entries={probeEntries}
        checkedAtMs={probe.checkedAtMs}
        chainPending={chainPending}
      />
    );
  }
  if (loopbackHint(probe.reason ?? "", link.baseUrl)) {
    return (
      <LoopbackRefusalBanner
        error={probe.reason ?? ""}
        url={link.baseUrl}
        serverSentence={providerTestMessage(probe)}
      />
    );
  }
  return (
    <p
      className={probe.ok ? "text-meta text-ok" : "text-meta text-warn"}
      role="status"
      data-testid="ai-link-probe"
    >
      {providerTestMessage(probe)}
    </p>
  );
}
