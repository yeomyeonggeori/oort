import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { InlineBanner, Skeleton } from "@/features/common/States";
import {
  AI_TEAM_KEYS_COPY,
  aiHubSection,
  glossaryEntry,
  teamKeyCompany,
  teamKeyFeatureUses,
  teamKeyOperatorOnlyNotice,
} from "@momo/core/features/ai/aiHubModel";
import {
  deleteProviderLink,
  fetchProviderChain,
  fetchProviderLink,
  testProviderLink,
  type ProviderChainEntry,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import { parseProviderChain } from "@momo/core/features/settings/chainModel";
import { isLegacyTeamLink, linkPill, PROBE_NOT_RUN } from "@momo/core/features/settings/aiLinkPill";
import { teamLinkAffectedAgents } from "@momo/core/features/settings/teamLinkImpact";
import {
  fetchProviderDefaultAi,
  probeModelLists,
  putProviderDefaultAi,
  teamDefaultSaveMessage,
  type TeamDefaultAiInput,
  type TeamDefaultRowId,
} from "@momo/core/features/settings/defaultAi";
import type { AiDefaultsTeamKey } from "@momo/core/features/settings/aiDefaults";
import { teamProbeDetail } from "@momo/core/features/settings/teamKeyForm";
import { errorMessage, isOperatorDenied, maskedBearer, providerSourceLabel } from "@momo/core/features/settings/model";
import {
  isLoopbackProviderRefusal,
  isLoopbackProviderUrl,
  loopbackProviderGuidance,
} from "@momo/core/features/settings/chainModel";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { useOpenDm } from "@/features/directory/useOpenDm";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { IS_TAURI } from "@/lib/env";
import { AiDefaultsTable, type TeamDefaultsState } from "@/features/settings/AiDefaultsTable";
import { AiLinkChain } from "@/features/settings/AiLinkChain";
import { LoopbackRefusalBanner, ProbeAnswer } from "@/features/settings/AiLinkSection";
import { AiOfflineBanner, AiPill } from "@/features/settings/aiAccountsParts";
import { myAccountsBrowserTab } from "@/features/settings/aiMyAccountsModel";
import { formatMoment } from "@/features/settings/oauthGrant";
import { TeamKeyForm } from "@/features/settings/TeamKeyForm";
import { TeamUnlinkDialog } from "@/features/settings/TeamUnlinkDialog";

// =============================================================================
// 「팀 AI 키」 구획 (AIH-6, #3400, 플랜 §8-6, 시안 panel-team-keys).
//
// 위: 넣어 둔 키 표(AI 회사 · 키 · 쓰는 곳 · 상태). 가운데: 기본 AI 표(기능마다 누구를
// 위한 것인지, 어떤 AI로, 고르지 않으면 무슨 일이 일어나는지). 아래: 「개인 API 키」 자리.
//
// 새 API는 없다. 쿼리 키와 함수는 설정 › AI 연결(`AiLinkSection`)과 같아서 두 화면이 같은
// 캐시를 본다. 폼(`TeamKeyForm`)·끊기 확인(`TeamUnlinkDialog`)·확인 결과(`ProbeAnswer`)도 같은
// 부품이다. 운영자인지는 서버 답(`GET /v1/provider/link` 200 / 403)이 정하고, 이 화면은
// 역할 이름으로 편집 컨트롤을 열지 않는다.
//
// 비운영자는 키의 있고 없음도 보지 못한다(서버가 403이다): 연결됨/없음을 지어내지 않고
// 운영자에게 요청하는 길만 보인다. 표의 행은 저장된 연결이다. 시안의 「OpenAI · 추가 안 됨」
// 같은 가짜 행은 없다: 지금 서버에서 그 버튼은 맨 위 키를 바꾸는 일이라서다.
// =============================================================================

const OFFLINE_NOTE_ID = "ai-team-keys-offline-note";
const OFFLINE_REASON = "연결이 끊겨 지금은 이 연결을 바꾸거나 확인할 수 없습니다.";
const COLS = "sm:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1.1fr)]";

function loopbackHint(error: unknown, url: string): string | null {
  return isLoopbackProviderUrl(url) && isLoopbackProviderRefusal(error) ? loopbackProviderGuidance() : null;
}

/** 줄의 날짜(「9월 27일」). */
function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

interface PaneProps {
  offline: boolean;
  workspaceId: string;
  memberId: string;
}

function PaneHead() {
  const entry = glossaryEntry(aiHubSection("teamKeys").glossaryId);
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-1" data-testid="ai-hub-pane-teamKeys">
      <h2 className="text-display font-bold text-ink">{entry.term}</h2>
      <p className="max-w-2xl break-keep text-body text-ink-muted">{entry.meaning}</p>
    </div>
  );
}

export function AiTeamKeysPane({ offline, workspaceId, memberId }: PaneProps) {
  const client = useQueryClient();
  const browserTab = myAccountsBrowserTab(useSubscriptionEntryState(), IS_TAURI);
  const linkQuery = useQuery({ queryKey: ["settings", "provider-link"], queryFn: fetchProviderLink, retry: false });
  const operator = linkQuery.isSuccess;
  const denied = linkQuery.isError && isOperatorDenied(linkQuery.error);
  const operatorAnswer: boolean | null = operator ? true : denied ? false : null;
  const link = linkQuery.data;

  const chainQuery = useQuery({
    queryKey: ["settings", "provider-link-chain"],
    queryFn: fetchProviderChain,
    retry: false,
    enabled: operator,
  });
  const chain = chainQuery.isSuccess ? parseProviderChain(chainQuery.data) : null;
  const hops: ProviderChainEntry[] = chain ? chain.entries.filter((entry) => entry.position >= 1) : [];

  const defaultAiKey = ["settings", "provider-default-ai"];
  const defaultAi = useQuery({ queryKey: defaultAiKey, queryFn: fetchProviderDefaultAi, retry: false, enabled: operator });

  const directory = useDirectory(workspaceId);
  const hosted = useQuery(hostedListQuery(workspaceId));
  const channels = useChannels(workspaceId);

  const [editing, setEditing] = useState(false);
  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [chainPending, setChainPending] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const unlinkRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (wasEditing.current && !editing) (editRef.current ?? addRef.current)?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);

  const invalidate = () => client.invalidateQueries({ queryKey: ["settings", "provider-link"] });
  const check = useMutation({ mutationFn: testProviderLink, onSuccess: setProbe });
  const unlink = useMutation({
    mutationFn: deleteProviderLink,
    onSuccess: () => {
      setProbe(null);
      setUnlinkOpen(false);
      void invalidate();
      void client.invalidateQueries({ queryKey: ["settings", "provider-link-chain"] });
    },
  });
  const [teamSaveError, setTeamSaveError] = useState<TeamDefaultsState["saveError"]>(null);
  const saveTeamDefault = useMutation({
    mutationFn: (vars: { rowId: TeamDefaultRowId; input: TeamDefaultAiInput | null }) =>
      putProviderDefaultAi(vars.rowId, vars.input),
    onMutate: () => setTeamSaveError(null),
    onSuccess: (value) => {
      if (value) client.setQueryData(defaultAiKey, value);
      else void client.invalidateQueries({ queryKey: defaultAiKey });
    },
    onError: (error, vars) => {
      setTeamSaveError({ rowId: vars.rowId, message: teamDefaultSaveMessage(error) });
      if (isOperatorDenied(error)) void client.invalidateQueries({ queryKey: defaultAiKey });
    },
  });

  const configured = link?.configured === true;
  const hasRow = link ? configured || (link.keyConfigured && link.availability !== "mock") : false;
  const legacy = link ? isLegacyTeamLink(link) : false;
  const failed = probe !== null && !probe.ok && probe.reason !== PROBE_NOT_RUN;
  const busy = unlink.isPending || check.isPending;
  const checkLocked = offline || (busy && !check.isPending);
  const unlinkLocked = offline || (busy && !unlink.isPending);
  const pill = link ? linkPill({ link, offline, probe, checking: check.isPending }) : null;
  const rowName = link ? (configured ? `${link.endpointLabel} · 팀 기본` : link.endpointLabel) : "";

  // 기본 AI 표가 읽는 팀 키 사실: 설정 › AI 연결과 같은 판정.
  const defaultsTeamKey: AiDefaultsTeamKey = linkQuery.isPending
    ? { status: "loading" }
    : linkQuery.isError
      ? denied
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
          : link.availability === "mock"
            ? { status: "mock" }
            : { status: "absent" };
  const teamDefaults: TeamDefaultsState = {
    status: !operator
      ? denied
        ? "hidden"
        : "loading"
      : defaultAi.isPending
        ? "loading"
        : defaultAi.isError
          ? isOperatorDenied(defaultAi.error)
            ? "hidden"
            : "error"
          : defaultAi.data
            ? "ready"
            : "error",
    value: defaultAi.data ?? null,
    links: probeModelLists(probe),
    pending: saveTeamDefault.isPending ? saveTeamDefault.variables : null,
    saveError: teamSaveError,
    offline,
    onChoose: (rowId, input) => saveTeamDefault.mutate({ rowId, input }),
  };

  // 쓰는 곳: 팀 줄이 가리키는 위치에서 계산한다(고르지 않으면 맨 위 키).
  const positions = defaultAi.data
    ? {
        teamAgent: defaultAi.data.teamAgent?.linkPosition ?? null,
        summary: defaultAi.data.summary?.linkPosition ?? null,
      }
    : null;
  const defaultsKnown = defaultAi.isSuccess && positions !== null;
  const agents = teamLinkAffectedAgents({
    roster: directory.data,
    hostedAgentIds: hosted.isSuccess ? hosted.data.map((row) => row.agentMemberId) : null,
    channels: (channels.data ?? []).map((channel) => ({ id: channel.id, name: channel.name ?? "" })),
  });

  function onSaved() {
    setEditing(false);
    setProbe(null);
    setJustSaved(true);
    void invalidate();
    void client.invalidateQueries({ queryKey: ["settings", "provider-link-chain"] });
    check.mutate();
  }

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="ai-team-keys">
      <div className="flex min-w-0 flex-col">
        <PaneHead />
        {offline && <AiOfflineBanner />}
        {linkQuery.isPending ? (
          <Skeleton ready={false} rows={3} className="py-3" />
        ) : denied ? (
          <NonOperatorNotice workspaceId={workspaceId} memberId={memberId} />
        ) : linkQuery.isError ? (
          <InlineBanner
            message={errorMessage(linkQuery.error)}
            actionLabel="다시 시도"
            onAction={() => void linkQuery.refetch()}
            testId="ai-team-keys-error"
          />
        ) : link ? (
          <section aria-labelledby="ai-team-keys-title" className="flex min-w-0 flex-col" data-testid="ai-team-keys-table">
            <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-line pb-2">
              <h3 id="ai-team-keys-title" className="text-body font-bold text-ink">
                {AI_TEAM_KEYS_COPY.keysHeading}
              </h3>
              <span className="text-meta text-ink-muted">{AI_TEAM_KEYS_COPY.keysSubtitle}</span>
              <span className="flex-1" />
              {!hasRow && !editing && (
                <Button
                  ref={addRef}
                  type="button"
                  size="sm"
                  className="tap-target"
                  onClick={() => setEditing(true)}
                  data-testid="ai-team-add"
                >
                  <Plus aria-hidden="true" />
                  {AI_TEAM_KEYS_COPY.addKey}
                </Button>
              )}
            </div>
            <div
              className={cn("hidden gap-3 border-b border-line px-2 py-2 text-meta text-ink-muted sm:grid", COLS)}
              aria-hidden="true"
            >
              <span>{AI_TEAM_KEYS_COPY.columns.company}</span>
              <span>{AI_TEAM_KEYS_COPY.columns.key}</span>
              <span>{AI_TEAM_KEYS_COPY.columns.usedBy}</span>
              <span>{AI_TEAM_KEYS_COPY.columns.status}</span>
            </div>
            <ul className="flex min-w-0 flex-col" aria-label={AI_TEAM_KEYS_COPY.keysHeading}>
              {hasRow ? (
                <KeyRow
                  testId="ai-link-row"
                  company={teamKeyCompany(link.baseUrl)}
                  keyText={
                    configured
                      ? maskedBearer(link.bearerLast4)
                      : providerSourceLabel(link.source)
                  }
                  keyMono={configured}
                  savedText={configured && link.updatedAtMs ? `${shortDate(link.updatedAtMs)} 저장` : null}
                  badge={AI_TEAM_KEYS_COPY.firstKeyBadge}
                  uses={usesFor(0, positions, defaultsKnown, agents, directory.isPending || hosted.isPending)}
                  status={
                    <>
                      {pill && <AiPill tone={pill.tone}>{pill.text}</AiPill>}
                      <span className="text-timestamp text-ink-muted" data-testid="ai-team-keys-checked">
                        {probe && !offline && probe.reason !== PROBE_NOT_RUN
                          ? `${formatMoment(probe.checkedAtMs)} 확인`
                          : AI_TEAM_KEYS_COPY.lastCheckUnknown}
                      </span>
                    </>
                  }
                  actions={
                    editing ? null : (
                      <>
                        {!legacy && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-disabled={checkLocked || undefined}
                              aria-busy={check.isPending || undefined}
                              aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}
                              className={cn("tap-target bg-surface shadow-sm", checkLocked && "opacity-50")}
                              onClick={() => {
                                if (checkLocked || check.isPending) return;
                                setJustSaved(false);
                                check.mutate();
                              }}
                              data-testid="ai-link-check"
                            >
                              {check.isPending ? "확인 중" : probe && probe.reason !== PROBE_NOT_RUN ? "다시 확인" : "연결 확인"}
                            </Button>
                            <Button
                              ref={editRef}
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-disabled={offline || undefined}
                              aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}
                              className={cn("tap-target bg-surface shadow-sm", offline && "opacity-50")}
                              onClick={() => {
                                if (!offline) setEditing(true);
                              }}
                              data-testid="ai-link-edit"
                            >
                              {configured ? "키 바꾸기" : AI_TEAM_KEYS_COPY.addKey}
                            </Button>
                          </>
                        )}
                        {configured && (
                          <Button
                            ref={unlinkRef}
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-disabled={unlinkLocked || undefined}
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
                      </>
                    )
                  }
                />
              ) : (
                <li className="flex flex-col gap-1 px-2 py-3 text-body text-ink" data-testid="ai-link-empty">
                  <span>{AI_TEAM_KEYS_COPY.emptyLine}</span>
                  <span className="text-meta text-ink-muted">
                    {link.availability === "mock" ? AI_TEAM_KEYS_COPY.mockLine : AI_TEAM_KEYS_COPY.noAnswerLine}
                  </span>
                </li>
              )}
              {hops.map((hop) => (
                <KeyRow
                  key={hop.position}
                  testId="ai-team-hop-row"
                  company={teamKeyCompany(hop.baseUrl)}
                  keyText={hop.bearerConfigured ? maskedBearer(hop.bearerLast4) : AI_TEAM_KEYS_COPY.keyNone}
                  keyMono={hop.bearerConfigured}
                  savedText={hop.updatedAtMs ? `${shortDate(hop.updatedAtMs)} 저장` : null}
                  badge={AI_TEAM_KEYS_COPY.fallbackBadge}
                  uses={usesFor(hop.position, positions, defaultsKnown, agents, directory.isPending || hosted.isPending)}
                  status={<AiPill tone={hop.enabled ? "ok" : "mute"}>{hop.enabled ? "켜짐" : "꺼짐"}</AiPill>}
                  actions={null}
                />
              ))}
            </ul>

            {editing && (
              <section
                className="mt-3 flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
                aria-labelledby="ai-team-keys-form-title"
                data-testid="ai-team-keys-form"
              >
                <h4 id="ai-team-keys-form-title" className="text-body font-bold text-ink">
                  {configured ? "키 바꾸기" : "팀 API 키 추가"}
                </h4>
                <TeamKeyForm
                  link={link}
                  offline={offline}
                  offlineNoteId={OFFLINE_NOTE_ID}
                  currentFailed={failed}
                  onCancel={() => setEditing(false)}
                  onSaved={onSaved}
                  surface="settings"
                  saveErrorHint={loopbackHint}
                  testIdPrefix="ai-link"
                />
              </section>
            )}

            {offline && (
              <p id={OFFLINE_NOTE_ID} className="break-keep pt-2 text-meta text-ink-muted" data-testid="ai-link-offline">
                {OFFLINE_REASON}
              </p>
            )}
            {!editing && !offline && check.isError &&
              (loopbackHint(check.error, link.baseUrl) ? (
                <LoopbackRefusalBanner error={check.error} url={link.baseUrl} serverSentence={errorMessage(check.error)} />
              ) : (
                <p className="pt-2 text-meta text-danger" role="alert">
                  {errorMessage(check.error)}
                </p>
              ))}
            {!editing && !offline && probe && !check.isPending && (
              <div className="mt-3 flex min-w-0 flex-col gap-2">
                <ProbeAnswer probe={probe} link={link} chainPending={chainPending} justSaved={justSaved} />
              </div>
            )}

            <div className="flex min-w-0 flex-col gap-3 pt-3">
              <button
                type="button"
                aria-expanded={chainOpen}
                aria-controls="ai-team-keys-chain"
                onClick={() => setChainOpen((open) => !open)}
                className="tap-target press inline-flex w-max items-center gap-2 rounded-md px-2 py-1 text-meta font-semibold text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
                data-testid="ai-team-chain-toggle"
              >
                <ChevronRight className={cn("size-4 shrink-0 transition-transform", chainOpen && "rotate-90")} aria-hidden="true" />
                {AI_TEAM_KEYS_COPY.chainToggle}
              </button>
              {chainOpen && (
                <div id="ai-team-keys-chain" className="min-w-0">
                  <AiLinkChain
                    offline={offline}
                    onSaved={() => {
                      setProbe(null);
                      void client.invalidateQueries({ queryKey: ["settings", "provider-link-chain"] });
                    }}
                    onPendingChange={setChainPending}
                  />
                </div>
              )}
            </div>

            {configured && (
              <TeamUnlinkDialog
                open={unlinkOpen}
                onOpenChange={(open) => {
                  if (!open && unlink.isPending) return;
                  setUnlinkOpen(open);
                }}
                opener={unlinkRef}
                workspaceId={workspaceId}
                rowName={rowName}
                legacy={legacy}
                busy={unlink.isPending}
                offline={offline}
                error={unlink.isError ? errorMessage(unlink.error) : null}
                onConfirm={() => {
                  if (unlink.isPending || offline) return;
                  unlink.mutate();
                }}
              />
            )}
          </section>
        ) : null}
      </div>

      <section aria-labelledby="ai-team-defaults-title" className="flex min-w-0 flex-col" data-testid="ai-defaults">
        <div className="flex min-w-0 flex-wrap items-baseline gap-3 border-b border-line pb-2">
          <h3 id="ai-team-defaults-title" className="text-body font-bold text-ink">
            {AI_TEAM_KEYS_COPY.defaultsHeading}
          </h3>
          <span className="text-meta text-ink-muted">{AI_TEAM_KEYS_COPY.defaultsSubtitle}</span>
        </div>
        <AiDefaultsTable
          variant="hub"
          teamKey={defaultsTeamKey}
          operator={operatorAnswer}
          browserTab={browserTab}
          team={teamDefaults}
        />
      </section>

      <PersonalKeysReserved />
    </div>
  );
}

/** 이 키가 쓰이는 곳: 기능 이름과 대답하는 팀 에이전트. 읽지 못한 것은 아는 척하지 않는다. */
function usesFor(
  position: number,
  positions: { teamAgent: number | null; summary: number | null } | null,
  known: boolean,
  agents: ReturnType<typeof teamLinkAffectedAgents>,
  loading: boolean
): { features: string[] | null; agents: string | null } {
  if (!known) return { features: null, agents: null };
  const features = teamKeyFeatureUses(position, positions);
  const answersAsTeamAgent = features.includes("팀 에이전트 대답");
  return {
    features,
    agents: !answersAsTeamAgent
      ? null
      : loading
        ? ""
        : agents === null
          ? AI_TEAM_KEYS_COPY.agentsUnknown
          : AI_TEAM_KEYS_COPY.usedByAgents(agents.map((agent) => agent.name)),
  };
}

function KeyRow({
  testId,
  company,
  keyText,
  keyMono,
  savedText,
  badge,
  uses,
  status,
  actions,
}: {
  testId: string;
  company: { name: string; models: string | null };
  keyText: string;
  keyMono: boolean;
  savedText: string | null;
  badge: string;
  uses: { features: string[] | null; agents: string | null };
  status: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2 border-b border-line px-2 py-3" data-testid={testId}>
      <div className={cn("grid min-w-0 grid-cols-1 gap-2 sm:items-start sm:gap-3", COLS)}>
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-body font-semibold text-ink">
            <span className="break-keep [overflow-wrap:anywhere]">{company.name}</span>
            <span className="rounded-sm bg-muted-soft px-1 py-px text-timestamp font-semibold text-ink-muted">{badge}</span>
          </span>
          {company.models && <span className="text-meta text-ink-muted">{company.models}</span>}
        </div>
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-body text-ink", keyMono && "font-mono")} data-numeric={keyMono || undefined}>
            {keyText}
          </span>
          {savedText && <span className="text-timestamp text-ink-muted">{savedText}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-meta" data-testid={`${testId}-uses`}>
          {uses.features === null ? (
            <span className="text-ink-muted">{AI_TEAM_KEYS_COPY.usedByUnknown}</span>
          ) : uses.features.length === 0 ? (
            <span className="text-ink-muted">{AI_TEAM_KEYS_COPY.usedByNobody}</span>
          ) : (
            <span className="break-keep text-ink">{uses.features.join(" · ")}</span>
          )}
          {uses.agents && <span className="break-keep text-ink-muted">{uses.agents}</span>}
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1">{status}</div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  );
}

/** 비운영자: 서버가 키를 보여 주지 않는다(403). 있다 없다를 지어내지 않고 요청 길만 둔다. */
function NonOperatorNotice({ workspaceId, memberId }: { workspaceId: string; memberId: string }) {
  const directory = useDirectory(workspaceId);
  const { openDm, pendingMemberId, error } = useOpenDm();
  const operators = (directory.data ?? []).filter(
    (member) => member.kind === "human" && member.status === "active" && member.id !== memberId && member.role === "owner"
  );
  const first = operators[0];
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4" role="status" data-testid="operator-notice">
      <p className="break-keep text-body text-ink" data-testid="ai-team-keys-readonly">
        {teamKeyOperatorOnlyNotice(operators.length === 1 ? first.displayName : null)}
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-meta font-semibold text-ink-muted">{AI_TEAM_KEYS_COPY.requestHeading}</span>
        {operators.length === 0 ? (
          <span className="break-keep text-meta text-ink-muted">{AI_TEAM_KEYS_COPY.requestNoOperator}</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {operators.slice(0, 3).map((member) => (
              <Button
                key={member.id}
                type="button"
                variant="outline"
                size="sm"
                className="tap-target"
                aria-busy={pendingMemberId === member.id || undefined}
                onClick={() => void openDm(member)}
                data-testid="ai-team-keys-request"
              >
                {AI_TEAM_KEYS_COPY.requestDm(member.displayName)}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <span className="text-meta text-danger" role="alert">
            {error.message}
          </span>
        )}
        <span className="break-keep text-meta text-ink-muted">{AI_TEAM_KEYS_COPY.requestHint}</span>
      </div>
    </div>
  );
}

/** 개인 API 키 자리. 아직 서버가 없다: 눌러 볼 컨트롤 없이 무엇이 오는지만 말한다. */
function PersonalKeysReserved() {
  const copy = AI_TEAM_KEYS_COPY.personalKeys;
  return (
    <section
      aria-labelledby="ai-personal-keys-title"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-line p-4"
      data-testid="ai-personal-keys"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id="ai-personal-keys-title" className="text-body font-bold text-ink">
          {copy.heading}
        </h3>
        <span className="rounded-full bg-muted-soft px-2 py-1 text-timestamp font-semibold leading-none text-ink-muted">
          {copy.badge}
        </span>
      </div>
      <p className="max-w-2xl break-keep text-body text-ink-muted">{copy.body}</p>
      <p className="max-w-2xl break-keep text-meta text-ink-muted">{copy.nowLine}</p>
    </section>
  );
}
