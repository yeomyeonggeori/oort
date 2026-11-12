import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { delegationInputText, parseDelegationInput } from "@momo/core/features/settings/teamAiHermesView";
import {
  DAILY_DELEGATIONS_DEFAULT,
  DAILY_DELEGATIONS_MAX,
  saveTeamAiLimits,
  type TeamAiDelegationStatus,
} from "@momo/core/features/settings/teamAiLimits";
import {
  limitSaveFailure,
  limitSaveFailureCopy,
  teamAiLimitsQueryKey,
} from "@momo/core/features/settings/teamAiLimitsView";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useLocaleService } from "@/i18n/useLocaleService";

// =============================================================================
// 「사용 한도」의 「하루 Hermes 맡기기」 칸 (ADR-0201 증보 v4 P7·P8, #5375 = P14-S7).
//
// 다른 세 한도와 뜻이 달라 행 모델(`LimitItem`)에 넣지 않는다: 이 값은 **없으면 기본 30**이지 「제한 없음」이 아니고,
// 그래서 끄는 스위치가 없다. 빈 칸으로 저장하면 기본 30으로 돌아간다(`dailyDelegations: null`). 받는 값은 1~200의 정수이고
// 운영자 천장을 넘을 수 없다(코어 `parseDelegationInput`, 서버도 같은 범위를 거절한다).
//
// 보이는 숫자는 서버 값 그대로다: 「오늘 Hermes에 맡긴 횟수 {오늘}/{실제 상한}」(실제 상한 = min(관리자 값 또는 30, 천장)).
// 이 칸은 운영자가 위임을 연 서버에서만 선다(`hermesSettingsVisible`, 부르는 쪽이 판정한다). 칸이 있는 「사용 한도」 자체가
// 소유자·관리자에게만 선다(403이면 아무것도 그리지 않는다) — 다른 멤버에게는 조작이 보이지 않는다.
//
// 칸의 잠금은 이웃 행과 같다: 운영자가 팀 AI를 멈췄으면(`helperOff`) 입력이 잠기고, 이웃 행의 저장이 가는 중이면 이 칸의
// 저장 단추도 잠긴다(동시에 둘을 보내지 않는다). 반대로 이 칸의 저장이 가는 동안 이웃 행은 막지 않는다 — 서버가 한 단계
// 아래로 병합하는 PATCH라 다른 필드끼리는 서로 지우지 않는다(인계의 알려진 한계).
// =============================================================================

export function TeamAiDelegationLimitItem({
  workspaceId,
  status,
  offline,
  locked = false,
  busy = false,
}: {
  workspaceId: string;
  status: TeamAiDelegationStatus;
  offline: boolean;
  /** 운영자가 팀 AI를 멈췄다(`helperOff`): 이웃 행처럼 입력이 잠긴다. */
  locked?: boolean;
  /** 이웃 행의 저장이 가는 중이다. */
  busy?: boolean;
}) {
  const formatMessage = useFormatMessage();
  const locale = useLocaleService();
  const client = useQueryClient();
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const savedText = delegationInputText(status);
  const [text, setText] = useState(savedText);
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: number | null) => saveTeamAiLimits(workspaceId, { dailyDelegations: value }),
    // 응답은 저장된 가방 + 계산된 읽기다: 같은 캐시(역할 행의 「Hermes 도움」도 읽는다)에 그대로 둔다.
    onSuccess: (saved) => client.setQueryData(teamAiLimitsQueryKey(workspaceId), saved),
  });

  // 서버의 값이 바뀌면(저장 성공·다른 곳에서 바꿈) 칸을 그 값으로 맞춘다.
  useEffect(() => {
    setText(savedText);
    setInvalid(null);
  }, [savedText]);

  const typed = text.trim();
  const canSave = !offline && !locked && !busy && !save.isPending && typed !== savedText;
  const failure = save.isError ? limitSaveFailureCopy(limitSaveFailure(save.error), locale) : null;
  const problem = invalid ?? failure;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const parsed = parseDelegationInput(text, status);
    if (!parsed.ok) {
      setInvalid(
        parsed.error === "over_ceiling"
          ? formatMessage("settings.aiLimits.errorOverCeiling", { max: parsed.max })
          : formatMessage("settings.aiLimits.errorInvalidDelegations")
      );
      return;
    }
    setInvalid(null);
    save.mutate(parsed.value);
  }

  const describedBy = [hintId, problem === null ? null : errorId].filter((id): id is string => id !== null).join(" ");
  return (
    <li className="flex min-w-0 flex-col gap-2 border-b border-line px-2 py-3" data-testid="team-ai-limit-delegations-item">
      <div className="flex min-w-0 flex-col gap-1">
        <span id={nameId} className="break-keep text-body font-semibold text-ink">
          {formatMessage("settings.aiLimits.delegationsLabel")}
        </span>
        <span id={hintId} className="break-keep text-meta text-ink-muted">
          {formatMessage("settings.aiLimits.delegationsHint")}
        </span>
      </div>
      <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={submit} aria-labelledby={nameId}>
        <Input
          data-testid="team-ai-limit-delegations-input"
          data-numeric
          className="min-w-0 flex-1 sm:max-w-xs"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder={String(DAILY_DELEGATIONS_DEFAULT)}
          aria-label={formatMessage("settings.aiLimits.delegationsValueLabel")}
          aria-invalid={problem !== null ? true : undefined}
          aria-describedby={describedBy}
          disabled={offline || locked}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(null);
          }}
        />
        <span className="text-meta text-ink-muted">{formatMessage("settings.aiLimits.searchesUnit")}</span>
        <Button
          type="submit"
          size="sm"
          data-testid="team-ai-limit-delegations-save"
          aria-busy={save.isPending || undefined}
          disabled={!canSave}
        >
          {formatMessage(save.isPending ? "settings.aiLimits.saving" : "settings.aiLimits.save")}
        </Button>
      </form>
      {problem !== null ? (
        <p id={errorId} role="alert" className="break-keep text-meta text-danger" data-testid="team-ai-limit-delegations-error">
          {problem}
        </p>
      ) : null}
      {status.today !== null && status.effective !== null ? (
        <p className="break-keep text-meta font-semibold text-ink" data-numeric data-testid="team-ai-limit-delegations-today">
          {formatMessage("settings.aiLimits.delegationsToday", { used: status.today, limit: status.effective })}
        </p>
      ) : null}
      {/* 운영자 천장은 설정 상한(200)보다 낮을 때만 입력을 막는다: 그때만 말한다. */}
      {status.ceiling !== null && status.ceiling < DAILY_DELEGATIONS_MAX ? (
        <p className="break-keep text-meta text-ink-muted" data-testid="team-ai-limit-delegations-ceiling">
          {formatMessage("settings.aiLimits.ceilingDelegations", { limit: status.ceiling })}
        </p>
      ) : null}
      {save.isSuccess && problem === null ? (
        <p role="status" className="text-meta text-ink-muted" data-testid="team-ai-limit-delegations-status">
          {formatMessage("settings.aiLimits.saved")}
        </p>
      ) : null}
    </li>
  );
}
