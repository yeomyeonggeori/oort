import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { expressionForState } from "@momo/core/features/onboarding/guide";
import {
  fetchProviderLink,
  testProviderLink,
  type ProviderLinkTest,
} from "@momo/core/features/settings/api";
import { PROBE_NOT_RUN } from "@momo/core/features/settings/aiLinkPill";
import { isOperatorDenied } from "@momo/core/features/settings/model";
import {
  TEAM_AI_NAME_STATUS_COPY,
  TEAM_AI_NOTICE_COPY,
  TEAM_AI_RENAME_ERROR_COPY,
  teamAiSetupErrorCopy,
} from "@momo/core/features/settings/teamAiCopyKeys";
import {
  readTeamAiAliasStatus,
  readTeamAiNameStatus,
  teamAiCallableNames,
} from "@momo/core/features/settings/teamAiNextStep";
import {
  providerLinkHasKey,
  TEAM_AI_QUERY_KEYS,
  TEAM_AI_STAGE_VIEW as VIEW,
  teamAiStageGuide,
  teamAiStageView,
  type TeamAiStageView,
} from "@momo/core/features/settings/teamAiStageModel";
import {
  defaultTeamAiRoles,
  teamAiNoticeKind,
  type TeamAiRoles,
} from "@momo/core/features/settings/teamAiRoles";
import {
  newTeamAiSetupProgress,
  runTeamAiSetup,
  teamAiNameDraft,
  teamAiRenameErrorKind,
  TEAM_AI_NAME_MAX_LENGTH,
  type TeamAiSetupResult,
} from "@momo/core/features/settings/teamAiSetup";
import { TEAM_AI_DEFAULT_NAME } from "@momo/core/features/settings/teamAiSwitch";
import { teamCheckReason } from "@momo/core/features/settings/teamKeyForm";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import { TeamAiRolesList } from "@/features/settings/TeamAiRolesList";
import { teamAiSettingKey } from "@/features/settings/TeamAiSetting";
import { TeamKeyForm } from "@/features/settings/TeamKeyForm";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { KomettoGuide } from "./guide/KomettoGuide";
import { ONBOARDING_ACTION_CLASS, ONBOARDING_FIELD_CLASS } from "./guide/OnboardingFrame";

// Reading this as: onboarding 팀 AI 단계 (ADR-0201 증보 v3 B3·B10, #4945) for internal team
// users on web+Tauri, density 5/10, motion 2/10.
//
// 건너뛸 수 있는 마지막 단계 하나: 팀 AI 키 넣기와 연결 확인 → 도우미 이름 → 할 수 있는 일(역할
// 일곱 묶음, 처음엔 모두 켬) → 「도우미 켜기」. 키가 없으면 「나중에」로 넘어가고 도우미는 꺼진
// 채다. **「나중에」는 서버에 아무것도 쓰지 않는다.**
//
// 운영자만 키를 넣는다(`GET /v1/provider/link`가 403이면 키 칸 대신 한 줄과 계속). 키는
// `TeamKeyForm`(설정·채팅 카드와 같은 폼)이 받아 저장하고, 이 단계는 저장 뒤 시험 호출
// (`POST …/link/test`)을 부른다. 키 값은 폼의 비제어 칸에만 있고 이 컴포넌트 상태·로그·시험
// 출력 어디에도 없다.
//
// 「도우미 켜기」의 쓰기 순서와 실패 규칙은 코어 `runTeamAiSetup`이 정한다(기본 AI → 역할 →
// 켜기 → 이름). 이 컴포넌트는 그리고 부른다. 코메토는 상태마다 표정과 문장이 함께 바뀐다
// (ADR-0193 D11): 확인 중 · 기다림 · 켜는 중 · 기쁨 · 당황.
//
// 문구는 전부 사전(`teamAi.*`)이다. 키·확인 실패 사유 문장은 설정과 같은 코어 문장을 쓴다.

const LOCKED_CLASS = "opacity-50";

export function TeamAiStage({
  workspaceId,
  onComplete,
  onSkip,
  headingRef,
}: {
  workspaceId: string;
  /** 도우미를 켜고 「계속」을 눌렀다. */
  onComplete: () => void;
  /** 「나중에」. 쓰기 0회로 다음으로 간다. */
  onSkip: () => void;
  /** 단계 착지 포커스(OwnerOnboarding). 코메토의 문장이 받는다. 없으면 이 컴포넌트가 하나 쥔다. */
  headingRef?: RefObject<HTMLHeadingElement>;
}) {
  const formatMessage = useFormatMessage();
  const offline = useBrowserOffline();
  const client = useQueryClient();
  const offlineNoteId = useId();
  const nameInputId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const rolesTitleId = useId();
  const noticeId = useId();

  const link = useQuery({
    queryKey: TEAM_AI_QUERY_KEYS.providerLink,
    queryFn: fetchProviderLink,
    retry: false,
  });
  const denied = link.isError && isOperatorDenied(link.error);
  const linkData = link.isSuccess ? link.data : null;
  // 저장된 키가 이미 있다(사용자가 저장했거나 서버 환경값). 있으면 키를 다시 묻지 않고 확인부터 한다.
  const hasKey = providerLinkHasKey(linkData);

  const [probe, setProbe] = useState<ProviderLinkTest | null>(null);
  const [checkError, setCheckError] = useState(false);
  const autoChecked = useRef(false);
  const check = useMutation({
    mutationFn: testProviderLink,
    onSuccess: (result) => {
      setProbe(result);
      setCheckError(false);
    },
    onError: () => {
      setProbe(null);
      setCheckError(true);
    },
  });

  // 이미 키가 있는 서버는 열자마자 한 번 확인한다(끊긴 동안에는 하지 않는다).
  useEffect(() => {
    if (!hasKey || probe !== null || checkError || autoChecked.current || offline) return;
    autoChecked.current = true;
    check.mutate();
  }, [hasKey, probe, checkError, offline, check]);

  const [name, setName] = useState(TEAM_AI_DEFAULT_NAME);
  const [nameMissing, setNameMissing] = useState(false);
  const [roles, setRoles] = useState<TeamAiRoles>(defaultTeamAiRoles);
  const [result, setResult] = useState<TeamAiSetupResult | null>(null);
  const progress = useRef(newTeamAiSetupProgress());
  const nameRef = useRef<HTMLInputElement>(null);
  const enable = useMutation({
    mutationFn: () =>
      runTeamAiSetup(
        // 저장한 키는 연결 순서의 머리(위치 0)다. 기본 AI 줄이 이 키를 가리키게 한다.
        { workspaceId, linkPosition: 0, name, roles },
        progress.current
      ),
    onSuccess: (done) => {
      setResult(done);
      // 새 도우미 멤버·별칭이 명부에, 켜진 스위치가 설정 가방에, 기본 AI 줄이 표에 실리도록.
      void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
      void client.invalidateQueries({ queryKey: teamAiSettingKey(workspaceId) });
      void client.invalidateQueries({ queryKey: TEAM_AI_QUERY_KEYS.providerDefaultAi });
    },
  });

  const verified = probe !== null && (probe.ok || probe.reason === PROBE_NOT_RUN);
  const unverified = probe !== null && !probe.ok && probe.reason === PROBE_NOT_RUN;
  const failed = checkError || (probe !== null && !verified);
  const verifying =
    check.isPending || (hasKey && probe === null && !checkError && !offline);

  const view: TeamAiStageView = teamAiStageView({
    done: result !== null,
    enabling: enable.isPending,
    linkPending: link.isPending,
    denied,
    linkError: link.isError,
    verified,
    verifying,
  });

  // 화면이 바뀌면 코메토 문장으로 초점을 옮긴다(저장 버튼이 사라져 초점이 떨어지지 않게).
  // 키 칸은 열릴 때 스스로 초점을 가진다.
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  const lastView = useRef<TeamAiStageView | null>(null);
  useEffect(() => {
    const previous = lastView.current;
    lastView.current = view;
    if (previous === null || previous === view || view === VIEW.key) return;
    heading.current?.focus();
  }, [view, heading]);

  function handleKeySaved() {
    autoChecked.current = true;
    setProbe(null);
    setCheckError(false);
    void client.invalidateQueries({ queryKey: TEAM_AI_QUERY_KEYS.providerLink });
    void client.invalidateQueries({ queryKey: TEAM_AI_QUERY_KEYS.providerLinkChain });
    check.mutate();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (offline || enable.isPending) return;
    if (!teamAiNameDraft(name).valid) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    setNameMissing(false);
    enable.mutate();
  }

  // ---- 코메토의 말 ---------------------------------------------------------------
  const guide = teamAiStageGuide(view, {
    keyFailed: failed,
    enableFailed: enable.isError,
    unverified,
  });
  const line = formatMessage(guide.line);
  const detail = guide.detailIsCheckReason
    ? teamCheckReason(checkError ? undefined : probe?.reason)
    : guide.detail === null
      ? undefined
      : formatMessage(guide.detail);

  // ---- 결과 줄 (켠 뒤) -------------------------------------------------------------
  const aliasNames = result === null ? null : teamAiCallableNames(readTeamAiAliasStatus(result.bag));
  const nameStatus = result === null ? null : readTeamAiNameStatus(result.bag);
  const renameFailure =
    result === null || result.renameError === null
      ? null
      : `${formatMessage(TEAM_AI_RENAME_ERROR_COPY[teamAiRenameErrorKind(result.renameError)])} ${formatMessage("teamAi.stage.renameFailedNote")}`;

  const setupError = teamAiSetupErrorCopy(enable.error);
  const noticeKind = teamAiNoticeKind(roles);
  const locked = offline || enable.isPending;
  const showSkip = view !== VIEW.enabling && view !== VIEW.done;
  const enableLabel = enable.isPending
    ? formatMessage("teamAi.stage.enabling")
    : enable.isError
      ? formatMessage("teamAi.stage.retry")
      : formatMessage("teamAi.stage.enable");
  const nameDescribedBy = nameMissing ? `${nameHintId} ${nameErrorId}` : nameHintId;

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-team-ai" data-view={view}>
      <KomettoGuide
        as="h1"
        expression={expressionForState(guide.state)}
        line={line}
        detail={detail}
        lineRef={heading}
        lineTestId="onboarding-team-ai-title"
      />

      {offline && (
        <InlineBanner
          tone="neutral"
          message={formatMessage("teamAi.stage.offline")}
          messageId={offlineNoteId}
          testId="onboarding-team-ai-offline"
        />
      )}

      {view === VIEW.loadError && (
        <Button
          type="button"
          className={ONBOARDING_ACTION_CLASS}
          onClick={() => void link.refetch()}
          data-testid="onboarding-team-ai-retry"
        >
          {formatMessage("teamAi.stage.retry")}
        </Button>
      )}

      {view === VIEW.notOperator && (
        <Button
          type="button"
          className={ONBOARDING_ACTION_CLASS}
          onClick={onSkip}
          data-testid="onboarding-team-ai-continue-skip"
        >
          {formatMessage("teamAi.stage.continue")}
        </Button>
      )}

      {view === VIEW.key && linkData !== null && (
        <TeamKeyForm
          link={linkData}
          offline={offline}
          offlineNoteId={offlineNoteId}
          currentFailed={failed}
          onCancel={onSkip}
          onSaved={handleKeySaved}
          surface="card"
          showCancel={false}
          testIdPrefix="onboarding-team-ai"
        />
      )}

      {(view === VIEW.setup || view === VIEW.enabling) && (
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit}
          noValidate
          data-testid="onboarding-team-ai-setup"
        >
          <div className="flex flex-col gap-1 text-body">
            <label htmlFor={nameInputId} className="text-ink-muted">
              {formatMessage("teamAi.helper.nameLabel")}
            </label>
            <Input
              ref={nameRef}
              id={nameInputId}
              name="helperName"
              className={ONBOARDING_FIELD_CLASS}
              value={name}
              maxLength={TEAM_AI_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={enable.isPending}
              aria-invalid={nameMissing ? true : undefined}
              aria-describedby={nameDescribedBy}
              data-testid="onboarding-team-ai-name"
              onChange={(event) => {
                setName(event.currentTarget.value);
                setNameMissing(false);
              }}
            />
            <p id={nameHintId} className="break-keep text-meta text-ink-muted">
              {formatMessage("teamAi.helper.nameHint")}
            </p>
            {nameMissing && (
              <p
                id={nameErrorId}
                role="alert"
                className="text-meta text-danger"
                data-testid="onboarding-team-ai-name-error"
              >
                {formatMessage("teamAi.stage.nameRequired")}
              </p>
            )}
          </div>

          <section aria-labelledby={rolesTitleId} className="flex min-w-0 flex-col gap-2">
            <h2 id={rolesTitleId} className="text-body font-semibold text-ink">
              {formatMessage("teamAi.helper.rolesHeading")}
            </h2>
            <p className="break-keep text-meta text-ink-muted">
              {formatMessage("teamAi.helper.rolesHint")}
            </p>
            <TeamAiRolesList
              roles={roles}
              disabled={enable.isPending}
              testIdPrefix="onboarding-team-ai"
              labelledBy={rolesTitleId}
              onToggle={(bundle, next) => setRoles((current) => ({ ...current, [bundle]: next }))}
            />
            {noticeKind !== null && (
              <p
                id={noticeId}
                className="break-keep text-meta text-ink"
                data-testid="onboarding-team-ai-notice"
              >
                {formatMessage(TEAM_AI_NOTICE_COPY[noticeKind])}
              </p>
            )}
          </section>

          {enable.isError && (
            <InlineBanner
              tone="error"
              message={setupError.key === undefined ? setupError.text : formatMessage(setupError.key)}
              testId="onboarding-team-ai-error"
            />
          )}

          <Button
            type="submit"
            aria-disabled={locked || undefined}
            aria-busy={enable.isPending || undefined}
            aria-describedby={offline ? offlineNoteId : undefined}
            className={cn(ONBOARDING_ACTION_CLASS, locked && LOCKED_CLASS)}
            data-testid="onboarding-team-ai-enable"
          >
            {enableLabel}
          </Button>
        </form>
      )}

      {view === VIEW.done && (
        <div className="flex flex-col gap-4" data-testid="onboarding-team-ai-done">
          {aliasNames !== null && (
            <p className="break-keep text-body text-ink" data-testid="onboarding-team-ai-aliases">
              {formatMessage("teamAi.helper.aliasesLine", { names: aliasNames })}
            </p>
          )}
          {nameStatus !== null && (
            <p
              className="break-keep text-meta text-ink-muted"
              data-testid="onboarding-team-ai-name-status"
            >
              {formatMessage(TEAM_AI_NAME_STATUS_COPY[nameStatus])}
            </p>
          )}
          {renameFailure !== null && (
            <InlineBanner
              tone="error"
              message={renameFailure}
              testId="onboarding-team-ai-rename-failed"
            />
          )}
          <Button
            type="button"
            className={ONBOARDING_ACTION_CLASS}
            onClick={onComplete}
            data-testid="onboarding-team-ai-continue"
          >
            {formatMessage("teamAi.stage.continue")}
          </Button>
        </div>
      )}

      <p className="onboarding-reentry" data-testid="onboarding-team-ai-reentry">
        {showSkip ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="onboarding-skip"
              onClick={onSkip}
              data-testid="onboarding-team-ai-skip"
            >
              {formatMessage("teamAi.stage.later")}
            </Button>
            <span className="onboarding-reentry-sep" aria-hidden="true">
              {" · "}
            </span>
          </>
        ) : null}
        {formatMessage("teamAi.stage.reentry")}
      </p>
    </div>
  );
}
