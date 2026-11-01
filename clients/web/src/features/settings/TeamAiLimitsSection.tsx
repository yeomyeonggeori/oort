import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isOperatorDenied } from "@momo/core/features/settings/model";
import {
  fetchTeamAiLimitsBag,
  readTeamAiLimitsStatus,
  saveTeamAiLimits,
  type TeamAiLimitField,
  type TeamAiLimitsStatus,
} from "@momo/core/features/settings/teamAiLimits";
import {
  limitChange,
  limitInputErrorCopy,
  limitInputText,
  limitRowCopy,
  limitRows,
  limitSaveFailure,
  limitSaveFailureCopy,
  limitSwitchDisabled,
  limitsHeaderNote,
  parseLimitInput,
  teamAiLimitsQueryKey,
  type LimitRow,
  type LimitRowCopy,
  type LimitsLocale,
} from "@momo/core/features/settings/teamAiLimitsView";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Switch } from "@/design/ui/switch";
import { InlineBanner } from "@/features/common/States";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useLocaleService } from "@/i18n/useLocaleService";

// =============================================================================
// 설정 › AI › 팀 AI 키 › 「사용 한도」 (#5026, #4944의 화면 몫, ADR-0201 증보 v3 B9).
//
// 도우미가 쓰는 양에 한도를 거는 곳이다. **기본은 제한 없음**이고(BYOK: 팀 키로 쓰는 만큼 팀이 정한다),
// 관리자가 원하면 하루 토큰·하루 웹 검색·한 달 금액을 따로 켠다. 판단(켤 수 있는가·입력 상한·0 거절·사용 %·
// 초기화 시각)과 문장은 전부 코어 `teamAiLimitsView.ts` 가 한다. 이 파일은 그리고 부르기만 한다.
//
// **이 칸은 확인된 뒤에만 선다** (`TeamAiSetting` 과 같은 규율). 소유자·관리자가 아니면(403), 서버가 한도
// 읽기를 모르면(`team_ai_limits_status` 없음), 읽는 중이면 아무것도 그리지 않는다: 없을 수도 있는 칸의 자리를
// 잡아 두면 그 자리가 거짓말이 된다. 읽기에 실패했을 때만 말을 하고 다시 시도 길을 둔다.
//
// 켜기는 값을 적고 「저장」을 눌러야 서버에 간다(켠 채 값이 없는 한도는 없다). 끄기는 그 한도의 `null` 하나이고
// **`0` 은 어디서도 보내지 않는다**(서버도 400). 운영자 천장은 입력 상한이고 넘는 값은 받지 않는다. 운영자가
// 팀 AI를 멈췄으면(`helperOff`) 모든 입력이 잠긴다.
// =============================================================================

interface SaveVars {
  field: TeamAiLimitField;
  value: number | null;
}

/** 시험 이름표는 JSX 밖에서 짓는다(직접 문구 장부는 JSX 식 안의 문자열을 문구로 센다). */
function limitTestIds(base: string) {
  return {
    item: `${base}-item`,
    toggle: `${base}-toggle`,
    input: `${base}-input`,
    save: `${base}-save`,
    error: `${base}-error`,
    status: `${base}-status`,
    headline: `${base}-headline`,
    detail: `${base}-detail`,
    resets: `${base}-resets`,
  };
}

function LimitItem({
  row,
  copy,
  locale,
  offline,
  pendingHere,
  pendingValue,
  saving,
  failure,
  succeeded,
  onSave,
}: {
  row: LimitRow;
  copy: LimitRowCopy;
  locale: LimitsLocale;
  offline: boolean;
  /** 이 행의 저장이 가는 중. */
  pendingHere: boolean;
  /** 가는 중인 저장의 값(`null` = 끄는 중). 이 행의 저장이 아니면 `undefined`. */
  pendingValue: number | null | undefined;
  /** 어느 행이든 저장이 가는 중(동시에 둘을 보내지 않는다). */
  saving: boolean;
  /** 이 행의 마지막 저장 실패 문장. */
  failure: string | null;
  /** 이 행의 마지막 저장이 성공했고 그 값(`null` = 껐다). `undefined` = 성공한 적 없음. */
  succeeded: number | null | undefined;
  onSave: (field: TeamAiLimitField, value: number | null) => void;
}) {
  const formatMessage = useFormatMessage();
  const nameId = useId();
  const hintId = useId();
  const inputId = useId();
  const noteBaseId = useId();
  const ids = limitTestIds(`team-ai-limit-${row.field}`);
  const [draft, setDraft] = useState(false);
  const [text, setText] = useState(limitInputText(row.saved));
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 서버의 값이 바뀌면(저장 성공·다른 곳에서 바꿈) 입력칸을 그 값으로 맞추고 초안을 접는다.
  useEffect(() => {
    setText(limitInputText(row.saved));
    setInvalid(null);
    setDraft(false);
  }, [row.saved]);
  useEffect(() => {
    if (draft) inputRef.current?.focus();
  }, [draft]);
  // 쓰던 초안은 이 행이 더는 쓸 수 없게 되면(운영자가 멈춤, 금액 한도 불가로 바뀜) 접는다: 잠긴 입력칸을 열어 두지 않는다.
  useEffect(() => {
    if (!row.editable) setDraft(false);
  }, [row.editable]);

  // 끄는 중에는 누른 값(꺼짐)을 보여 준다: 응답을 기다리는 동안 되돌아 튀는 스위치는 고장 난 것처럼 보인다(`TeamAiSetting` 과 같은 이유).
  // 실패하면 저장된 값이 그대로라 켜진 채로 돌아오고 실패 문장이 선다.
  const turningOff = pendingHere && pendingValue === null;
  const shownOn = !turningOff && (row.saved !== null || draft);
  const switchDisabled = offline || saving || limitSwitchDisabled(row, shownOn, draft);
  const typed = text.trim();
  const canSave = row.editable && !offline && !saving && typed !== "" && typed !== limitInputText(row.saved);
  const problem = invalid ?? failure;

  function toggle(next: boolean) {
    if (switchDisabled) return;
    setInvalid(null);
    if (next) {
      // 켜기는 값을 적어 저장해야 서버에 간다.
      setDraft(true);
      return;
    }
    if (row.saved === null) {
      setDraft(false);
      setText("");
      return;
    }
    // 끄기는 그 한도의 null 하나다. 0이 아니다.
    onSave(row.field, null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const parsed = parseLimitInput(row.field, text, row.ceiling);
    if (!parsed.ok) {
      setInvalid(limitInputErrorCopy(row.field, parsed, locale));
      return;
    }
    setInvalid(null);
    onSave(row.field, parsed.value);
  }

  const noteIds = copy.notes.map((_, index) => `${noteBaseId}-${index}`);
  const describedBy = [hintId, ...noteIds, problem !== null ? ids.error : null]
    .filter((id): id is string => id !== null)
    .join(" ");
  const saveLabel = formatMessage(
    pendingHere ? "settings.aiLimits.saving" : "settings.aiLimits.save"
  );

  return (
    <li className="flex min-w-0 flex-col gap-2 border-b border-line px-2 py-3" data-testid={ids.item}>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span id={nameId} className="break-keep text-body font-semibold text-ink">
            {copy.label}
          </span>
          <span id={hintId} className="break-keep text-meta text-ink-muted">
            {copy.hint}
          </span>
        </div>
        <Switch
          testId={ids.toggle}
          checked={shownOn}
          disabled={switchDisabled}
          labelledBy={nameId}
          describedBy={hintId}
          onCheckedChange={toggle}
        />
      </div>

      {shownOn ? (
        <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={submit}>
          <Input
            ref={inputRef}
            id={inputId}
            data-testid={ids.input}
            data-numeric
            className="min-w-0 flex-1 sm:max-w-xs"
            type="text"
            inputMode={row.inputMode}
            autoComplete="off"
            spellCheck={false}
            aria-label={copy.valueLabel}
            aria-invalid={problem !== null ? true : undefined}
            aria-describedby={describedBy}
            disabled={!row.editable || offline}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setInvalid(null);
            }}
          />
          <span className="text-meta text-ink-muted">{copy.unit}</span>
          <Button
            type="submit"
            size="sm"
            data-testid={ids.save}
            aria-busy={pendingHere || undefined}
            disabled={!canSave}
          >
            {saveLabel}
          </Button>
        </form>
      ) : null}

      {problem !== null ? (
        <p id={ids.error} role="alert" className="break-keep text-meta text-danger" data-testid={ids.error}>
          {problem}
        </p>
      ) : null}

      {copy.headline !== null ? (
        <p className="break-keep text-meta font-semibold text-ink" data-numeric data-testid={ids.headline}>
          {copy.headline}
        </p>
      ) : null}
      {copy.detail !== null ? (
        <p className="break-keep text-meta text-ink-muted" data-numeric data-testid={ids.detail}>
          {copy.detail}
        </p>
      ) : null}
      {copy.resets !== null ? (
        <p className="break-keep text-meta text-ink-muted" data-testid={ids.resets}>
          {copy.resets}
        </p>
      ) : null}
      {copy.notes.map((note, index) => (
        <p key={noteIds[index]} id={noteIds[index]} className="break-keep text-meta text-ink-muted">
          {note}
        </p>
      ))}
      {copy.pricingNote !== null ? (
        <p className="break-keep text-meta text-ink-muted">{copy.pricingNote}</p>
      ) : null}
      {succeeded !== undefined && problem === null ? (
        <p role="status" className="text-meta text-ink-muted" data-testid={ids.status}>
          {formatMessage(succeeded === null ? "settings.aiLimits.cleared" : "settings.aiLimits.saved")}
        </p>
      ) : null}
    </li>
  );
}

export function TeamAiLimitsSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const formatMessage = useFormatMessage();
  const locale = useLocaleService();
  const titleId = useId();
  const key = teamAiLimitsQueryKey(workspaceId);
  const bag = useQuery({
    queryKey: key,
    queryFn: () => fetchTeamAiLimitsBag(workspaceId),
    retry: false,
    staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: ({ field, value }: SaveVars) => saveTeamAiLimits(workspaceId, limitChange(field, value)),
    // 응답은 저장된 가방 + 계산된 읽기다: 그대로 캐시에 두면 값·사용량·불가 사유가 한 번에 맞는다.
    onSuccess: (saved) => client.setQueryData(key, saved),
    onError: (error) => {
      // 금액 한도를 켤 수 없다는 답은 까닭이 응답에 없다. 다시 읽어 행의 안내가 까닭을 말하게 한다.
      if (limitSaveFailure(error) === "usd_unavailable") void client.invalidateQueries({ queryKey: key });
    },
  });

  // 소유자·관리자가 아니거나(403) 읽는 중이면 칸 자리를 잡지 않는다.
  if (bag.isPending || (bag.isError && isOperatorDenied(bag.error))) return null;
  if (bag.isError) {
    return (
      <InlineBanner
        message={formatMessage("settings.aiLimits.loadFailed")}
        actionLabel={formatMessage("settings.aiLimits.retry")}
        onAction={() => void bag.refetch()}
        testId="team-ai-limits-load-error"
      />
    );
  }
  // 한도 읽기를 모르는 서버(#4944 이전)는 계산된 읽기를 싣지 않는다. 일부만 믿고 그리지 않는다.
  const status: TeamAiLimitsStatus | null = readTeamAiLimitsStatus(bag.data);
  if (status === null) return null;

  const now = Date.now();
  const headerNote = limitsHeaderNote(status, locale);
  const failureOf = (field: TeamAiLimitField): string | null =>
    save.isError && save.variables?.field === field
      ? limitSaveFailureCopy(limitSaveFailure(save.error), locale)
      : null;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col" data-testid="team-ai-limits">
      <div className="flex min-w-0 flex-wrap items-baseline gap-3 border-b border-line pb-2">
        <h3 id={titleId} className="text-body font-bold text-ink">
          {formatMessage("settings.aiLimits.title")}
        </h3>
        <span className="break-keep text-meta text-ink-muted">{formatMessage("settings.aiLimits.description")}</span>
      </div>
      {headerNote !== null ? (
        <p className="break-keep border-b border-line px-2 py-3 text-body text-ink" role="status" data-testid="team-ai-limits-operator-off">
          {headerNote}
        </p>
      ) : null}
      {offline ? (
        <p className="break-keep px-2 pt-2 text-meta text-ink-muted" data-testid="team-ai-limits-offline">
          {formatMessage("settings.aiLimits.offline")}
        </p>
      ) : null}
      <ul className="flex min-w-0 flex-col" aria-labelledby={titleId}>
        {limitRows(status).map((row) => (
          <LimitItem
            key={row.field}
            row={row}
            copy={limitRowCopy(row, status, locale, now)}
            locale={locale}
            offline={offline}
            pendingHere={save.isPending && save.variables?.field === row.field}
            pendingValue={save.isPending && save.variables?.field === row.field ? save.variables.value : undefined}
            saving={save.isPending}
            failure={failureOf(row.field)}
            succeeded={save.isSuccess && save.variables?.field === row.field ? save.variables.value : undefined}
            onSave={(field, value) => save.mutate({ field, value })}
          />
        ))}
      </ul>
    </section>
  );
}
