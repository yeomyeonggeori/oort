import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/design/ui/button";
import { ListboxSelect } from "@/design/ui/listbox-select";
import { cn } from "@/design/lib/cn";
import { fetchProviderLink } from "@momo/core/features/settings/api";
import { fetchProviderDefaultAi } from "@momo/core/features/settings/defaultAi";
import {
  fetchWorkspaceSettingsBag,
  probeTeamAiSwitch,
  readTeamAiSwitch,
  setTeamAiSwitch,
  teamAiHelperName,
  teamAiSaveErrorCopy,
} from "@momo/core/features/settings/teamAiSwitch";
import {
  readTeamAiAliasStatus,
  TEAM_AI_NEXT_STEP_COPY as COPY,
  teamAiAliasNotices,
  teamAiCallableLine,
  teamAiNextStepView,
  teamAiSeedName,
  teamAiSeedText,
  teamAiTryLabel,
} from "@momo/core/features/settings/teamAiNextStep";
import { memberFor } from "@momo/core/features/workspace/directory";
import { seedComposerText } from "@/features/chat/draftStore";
import { channelPath } from "@/features/inbox/anchor";
import { teamAiSettingKey } from "@/features/settings/TeamAiSetting";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";

// =============================================================================
// 「팀 AI 키」 구획의 다음 단계 카드 (ADR-0201 증보 v2 H8, #3893).
//
// 키를 넣고 나면 할 일이 없던 자리에 「이 키를 기본으로 → 도우미 켜기 → 채널에서 불러
// 보기」를 세운다. 판정·문구는 코어 `teamAiNextStep.ts` 가 하고, 이 컴포넌트는 그리고
// 부른다. 「팀 AI 키」 화면(`AiTeamKeysPane`)에는 마운트 한 줄만 있다: 그 파일을 다른
// 작업(키 확인·한도 패널)이 함께 고치고 있어서다.
//
// 쿼리 키는 이웃과 같다: 키 행은 pane 과(`settings/provider-link`), 기본 AI 표도 pane 과,
// 스위치 가방은 설정 › 워크스페이스의 「oort 도우미」 스위치와(`teamAiSettingKey`). 그래서
// 여기서 켜면 그 스위치도 같은 값을 본다.
//
// 서지 않는 경우(코어가 hidden): 운영자 아님, 서버가 스위치를 모름(#3837 이전), 키 없음,
// 이미 켜짐, 기본 AI 표를 못 읽음. 로딩 중에도 서지 않는다(뼈대 없음): 없을 수도 있는
// 카드의 자리를 잡아 두면 그 자리가 거짓말이 된다(`TeamAiSetting` 과 같은 규율).
// =============================================================================

const DEFAULTS_SELECT = '[data-testid="ai-default-teamAgent-select"]';
const DEFAULTS_ROW = '[data-testid="ai-default-teamAgent"]';
const DEFAULTS_SECTION = '[data-testid="ai-defaults"]';

/** 「기본 AI 표로 가기」: 「팀 에이전트의 답」 줄의 선택 칸에 초점, 없으면 그 줄로 스크롤. */
function goToDefaults() {
  if (typeof document === "undefined") return;
  const select = document.querySelector<HTMLElement>(DEFAULTS_SELECT);
  if (select) {
    select.scrollIntoView({ block: "center" });
    select.focus({ preventScroll: true });
    return;
  }
  const target =
    document.querySelector<HTMLElement>(DEFAULTS_ROW) ??
    document.querySelector<HTMLElement>(DEFAULTS_SECTION);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

export function TeamAiNextStepCard({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const titleId = useId();
  const channelSelectId = useId();
  const blockedId = useId();
  const offlineId = useId();

  const link = useQuery({
    queryKey: ["settings", "provider-link"],
    queryFn: fetchProviderLink,
    retry: false,
  });
  const operator = link.isSuccess;
  const defaultAi = useQuery({
    queryKey: ["settings", "provider-default-ai"],
    queryFn: fetchProviderDefaultAi,
    retry: false,
    enabled: operator,
  });
  const bagKey = teamAiSettingKey(workspaceId);
  const bag = useQuery({
    queryKey: bagKey,
    queryFn: () => fetchWorkspaceSettingsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
    enabled: operator,
  });
  const state = bag.data === undefined ? null : readTeamAiSwitch(bag.data);
  const probe = useQuery({
    queryKey: [...bagKey, "probe"],
    queryFn: () => probeTeamAiSwitch(workspaceId),
    enabled: state !== null && !state.known,
    retry: false,
    staleTime: Infinity,
  });

  const directory = useDirectory(workspaceId);
  const channels = useChannels(workspaceId);

  // 켠 뒤의 3단계는 이 화면에 있는 동안만 선다. 다시 들어오면 스위치가 켜져 있어 카드가
  // 없다(H8: 꺼져 있을 때만). 켠 결과(가방)는 여기 들고 있다.
  const [enabledBag, setEnabledBag] = useState<unknown>(null);
  const enable = useMutation({
    mutationFn: () => setTeamAiSwitch(workspaceId, true),
    onSuccess: (saved) => {
      setEnabledBag(saved);
      client.setQueryData(bagKey, saved);
      // 새 도우미 멤버와 별칭이 명부에 실리도록.
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    },
  });

  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (enabledBag !== null) doneRef.current?.focus();
  }, [enabledBag]);

  // 문구가 부르는 이름은 도우미 멤버의 표시 이름이다(ADR-0201 증보 v3 B10-7). 멤버가 아직 없으면 기본 이름.
  const helperMemberId = (enabledBag !== null ? readTeamAiSwitch(enabledBag) : state)?.memberId ?? undefined;
  const helperName = teamAiHelperName(memberFor(directory.directory, helperMemberId));

  const roomChannels = useMemo(
    () =>
      channels.groups.channels.filter((channel) => (channel.name ?? "") !== ""),
    [channels.groups.channels]
  );
  const [pickedChannel, setPickedChannel] = useState<string | null>(null);
  const channel =
    roomChannels.find((row) => row.id === pickedChannel) ?? roomChannels[0] ?? null;

  if (enabledBag !== null) {
    const savedState = readTeamAiSwitch(enabledBag);
    const aliasStatus = readTeamAiAliasStatus(enabledBag);
    const helper = memberFor(directory.directory, savedState.memberId ?? undefined);
    const name = teamAiSeedName(aliasStatus, helper);
    const callable = teamAiCallableLine(aliasStatus);
    const notices = teamAiAliasNotices(
      aliasStatus,
      (alias) => {
        const holder = (directory.data ?? []).find(
          (member) =>
            member.status !== "deleted" && member.handle.toLowerCase() === alias
        );
        return holder?.displayName ?? null;
      },
      helperName
    );
    return (
      <section
        aria-labelledby={titleId}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        data-testid="team-ai-next-step"
        data-state="enabled"
      >
        <h3 id={titleId} className="text-body font-bold text-ink">
          {COPY.step3Title}
        </h3>
        <p
          ref={doneRef}
          tabIndex={-1}
          role="status"
          className="flex items-center gap-2 rounded-sm text-body text-ink focus-visible:focus-ring"
          data-testid="team-ai-next-step-enabled"
        >
          <Check aria-hidden="true" className="size-4 shrink-0 text-ok" />
          {COPY.enabled(helperName)}
        </p>
        {callable !== null && (
          <p className="text-meta text-ink" data-testid="team-ai-next-step-aliases">
            {callable}
          </p>
        )}
        {notices.map((notice) => (
          <p
            key={notice}
            className="break-keep text-meta text-ink-muted"
            data-testid="team-ai-next-step-alias-notice"
          >
            {notice}
          </p>
        ))}
        {roomChannels.length === 0 ? (
          <p className="break-keep text-meta text-ink-muted" data-testid="team-ai-next-step-no-channel">
            {COPY.noChannel}
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-col gap-1 sm:max-w-xs sm:flex-1">
              <label id={`${channelSelectId}-label`} htmlFor={channelSelectId} className="text-meta font-semibold text-ink-muted">
                {COPY.channelLabel}
              </label>
              <ListboxSelect
                id={channelSelectId}
                aria-labelledby={`${channelSelectId}-label`}
                value={channel?.id ?? ""}
                onValueChange={(next) => setPickedChannel(next)}
                placeholder={COPY.channelLabel}
                options={roomChannels.map((row) => ({
                  value: row.id,
                  label: row.kind === "private" ? `${row.name} (비공개)` : `#${row.name}`,
                }))}
                data-testid="team-ai-next-step-channel"
              />
            </div>
            <Button
              type="button"
              className="tap-target sm:self-end"
              data-testid="team-ai-next-step-try"
              onClick={() => {
                if (channel === null) return;
                // 쓰다 만 글이 있으면 덮지 않는다(`seedComposerText` 가 false). 그래도
                // 채널은 연다: 사람이 이름을 직접 칠 수 있다.
                seedComposerText(workspaceId, channel.id, teamAiSeedText(name));
                navigate(channelPath(channel.id));
              }}
            >
              {teamAiTryLabel(channel?.name ?? null, name)}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const view = teamAiNextStepView({
    bag: bag.data,
    state,
    support: probe.data,
    keySaved: link.data?.configured === true,
    defaultAi: defaultAi.isSuccess ? defaultAi.data : null,
  });
  if (view.kind === "hidden") return null;

  const blocked = !view.defaultReady;
  const locked = blocked || offline || enable.isPending;
  // 상세 칸은 둘 중 하나만 그린다(잠김이 먼저). 그리지 않은 id 를 가리키지 않는다.
  const describedBy = [blocked ? blockedId : null, !blocked && offline ? offlineId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4"
      data-testid="team-ai-next-step"
      data-state="steps"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={titleId} className="text-body font-bold text-ink">
          {COPY.title(helperName)}
        </h3>
        <p className="max-w-2xl break-keep text-meta text-ink-muted">{COPY.lead(helperName)}</p>
      </div>

      <ol className="flex min-w-0 flex-col gap-3">
        <Step
          index={1}
          done={view.defaultReady}
          title={COPY.step1Title}
          testId="team-ai-next-step-1"
          detail={
            view.defaultReady
              ? COPY.step1Done
              : view.defaultStale
                ? COPY.step1Stale
                : COPY.step1Todo
          }
          action={
            view.defaultReady ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tap-target bg-surface shadow-sm"
                onClick={goToDefaults}
                data-testid="team-ai-next-step-defaults"
              >
                {COPY.step1Action}
              </Button>
            )
          }
        />
        <Step
          index={2}
          done={false}
          title={COPY.step2Title(helperName)}
          testId="team-ai-next-step-2"
          detail={
            blocked ? (
              <span id={blockedId}>{COPY.step2Blocked}</span>
            ) : offline ? (
              <span id={offlineId}>{COPY.offline}</span>
            ) : null
          }
          action={
            <Button
              type="button"
              size="sm"
              className={cn("tap-target", locked && !enable.isPending && "opacity-50")}
              aria-disabled={locked || undefined}
              aria-busy={enable.isPending || undefined}
              aria-describedby={describedBy === "" ? undefined : describedBy}
              onClick={() => {
                if (locked) return;
                enable.mutate();
              }}
              data-testid="team-ai-next-step-enable"
            >
              {enable.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {enable.isPending ? COPY.step2Busy : COPY.step2Action(helperName)}
            </Button>
          }
        />
      </ol>
      {enable.isError && (
        <p className="break-keep text-meta text-danger" role="alert" data-testid="team-ai-next-step-error">
          {teamAiSaveErrorCopy(enable.error)}
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-1 border-t border-line pt-3 text-meta text-ink-muted">
        <p className="break-keep">{COPY.capLine}</p>
        <p className="break-keep">
          <span className="font-semibold text-ink">{COPY.sendsTitle}</span>
          {": "}
          {COPY.sendsLine}
        </p>
      </div>
    </section>
  );
}

function Step({
  index,
  done,
  title,
  detail,
  action,
  testId,
}: {
  index: number;
  done: boolean;
  title: string;
  detail: React.ReactNode;
  action: React.ReactNode;
  testId: string;
}) {
  return (
    <li
      className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
      data-testid={testId}
      data-done={done ? "yes" : "no"}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={cn(
            "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-timestamp font-semibold",
            done ? "bg-ok-soft text-ok" : "bg-muted-soft text-ink-muted"
          )}
          aria-hidden="true"
          data-numeric
        >
          {done ? <Check className="size-3" /> : index}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-body font-semibold text-ink">
            {title}
            {done && <span className="sr-only">, {COPY.stepDone}</span>}
          </span>
          {detail && <span className="break-keep text-meta text-ink-muted">{detail}</span>}
        </div>
      </div>
      {action && <div className="flex shrink-0 pl-8 sm:pl-0">{action}</div>}
    </li>
  );
}
