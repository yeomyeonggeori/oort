import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  deleteProviderChain,
  fetchProviderChain,
  putProviderChain,
  type ProviderChain,
  type ProviderChainProbe,
} from "./api";
import {
  addDraftRow,
  bearerHint,
  cascadeProbeSummary,
  CHAIN_UNREADABLE,
  chainDirtyHint,
  chainErrorCopy,
  chainSaveMessage,
  chainSummary,
  chainUnreadableCopy,
  draftBlockedHint,
  draftErrors,
  draftFromChain,
  draftIsDirty,
  draftToInput,
  headClaim,
  headEntry,
  hopOrdinal,
  MAX_FALLBACK_HOPS,
  parseProviderChain,
  patchDraftRow,
  probeRows,
  removeDraftRow,
  type ChainDraftRow,
  type DraftRowError,
} from "./chainModel";
import { choiceLabel, errorMessage, isOperatorDenied, PROVIDER_MODES } from "./model";
import {
  ConfirmButton,
  Field,
  SaveButton,
  SelectField,
  StatusChip,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 연결 순서 (ADR-0135 D1 / MOMO-627): the provider cascade, edited as an ordered
// list of fallback hops.
//
// It lives inside 설정 > AI 연결 rather than in a section of its own, because it
// governs the same one thing the panel above governs: which provider an agent
// talks to. The head of the list IS the 연결 above; this block only adds what
// happens when that one stops answering.
//
// Four properties of the surface, each from a server rule rather than taste:
//
//   * The head row is read-only here. `PUT /v1/provider/link/chain` rejects
//     position 0 with a 400, on purpose: two editors for one hop would let this
//     block overwrite the MOMO-583 gated singleton. The row names where it IS
//     edited instead of offering a control that answers 400.
//   * Saving replaces every fallback hop at once, and an omitted key means
//     "keep the one stored at this position". So the key field of a stored hop
//     starts empty and says so; it is not a blank that will wipe anything.
//   * That same replace-all rule makes a chain with an entry this client cannot
//     read UNSAVABLE. A hop that never reached the draft is a hop the next save
//     deletes from the server, ciphertext and all, so the panel refuses to
//     write and says which entry it could not read (`chainUnreadableCopy`).
//   * A server without the endpoint answers 404, and that is the live case
//     until the engine ticket lands. It is stated as "this server has no chain
//     yet", never drawn as a chain with zero hops.
// =============================================================================

const CHAIN_KEY = ["settings", "provider-chain"];

/**
 * Every read and write goes through the parser, so nothing downstream ever
 * holds an object the server did not actually shape. An unreadable 200 becomes
 * a plain Error and lands on the same inline banner a network failure does.
 */
async function readChain(call: () => Promise<unknown>): Promise<ProviderChain> {
  const chain = parseProviderChain(await call());
  if (chain === null) throw new Error(CHAIN_UNREADABLE);
  return chain;
}

/** Read-only projection of position 0: the singleton, or the env fallback. */
function HeadRow({ chain }: { chain: ProviderChain }) {
  const head = headEntry(chain);
  if (head === null) return null;
  return (
    <div
      className="flex flex-col gap-1 border-b border-line bg-surface-raised p-3 last:border-b-0"
      data-testid="chain-head"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-ink-muted" data-numeric>
          {hopOrdinal(0)}
        </span>
        <span className="min-w-0 break-all text-body font-medium text-ink">
          {head.endpointLabel}
        </span>
        <StatusChip tone={head.bearerConfigured ? "ok" : "warn"}>
          {head.bearerConfigured ? "키 있음" : "키 없음"}
        </StatusChip>
        {!head.enabled && <StatusChip tone="muted">꺼둠</StatusChip>}
        <StatusChip tone="muted">{choiceLabel(PROVIDER_MODES, head.mode)}</StatusChip>
      </div>
      {/* Never an unconditional "가장 먼저 시도합니다.": the server's
          `attemptable` is `enabled && isUsable`, so a head with a 키 없음 chip
          is one the cascade skips. See chainModel.headClaim. */}
      <p className="text-meta text-ink-muted">{headClaim(head)}</p>
    </div>
  );
}

/** One editable fallback hop. */
function HopRow({
  row,
  index,
  error,
  busy,
  locked,
  onPatch,
  onBlurField,
  onRemove,
}: {
  row: ChainDraftRow;
  index: number;
  /** Already filtered by the block: absent until this row has had its turn. */
  error: DraftRowError | undefined;
  /** A write is in flight. Announced, and the reason `locked` is usually true. */
  busy: boolean;
  /**
   * The controls are read-only, for one of two reasons.
   *
   * While a write is IN FLIGHT, because the answer to it REPLACES this draft
   * (`save.onSuccess`): a key typed during the round trip would be thrown away
   * with nothing on screen having said so, which is the one kind of loss this
   * panel cannot undo (R-1 §5, tokens.md §5b: 검증 중에는 폼을 잠근다).
   *
   * And while the chain carries an entry this client could not read, because
   * every edit here would then be one that can never be saved.
   *
   * Locking is safe in a way it is not for ChoiceRadios: the control that
   * starts a save is the save BUTTON, which keeps `aria-disabled` and stays
   * focusable, so no focused element is disabled out from under a keyboard user.
   */
  locked: boolean;
  onPatch: (
    patch: Partial<Pick<ChainDraftRow, "baseUrl" | "bearer" | "mode" | "enabled">>
  ) => void;
  onBlurField: (field: DraftRowError["field"]) => void;
  onRemove: () => void;
}) {
  // Attempt order, not `position`: after a middle hop is deleted the two stop
  // agreeing, and the number a person acts on is the order things are tried in.
  const ordinal = hopOrdinal(index + 1);
  const urlId = `chain-url-${row.key}`;
  const bearerId = `chain-bearer-${row.key}`;
  const modeId = `chain-mode-${row.key}`;
  const enabledId = `chain-enabled-${row.key}`;

  return (
    // A real grouping element, so a screen reader hears "3차 provider" once and
    // then four controls inside it, instead of four unrelated controls whose
    // only tie is a repeated prefix in each aria-label. `aria-label` rather than
    // a `legend`, because the group's header line carries the 사용 checkbox and
    // the 삭제 button: a legend cannot hold them without pushing every hop onto
    // an extra row, and aria-label names the fieldset just as well.
    <fieldset
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      aria-label={`${ordinal} provider`}
      aria-busy={busy || undefined}
      data-testid="chain-hop"
      data-hop-enabled={row.enabled ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta text-ink-muted" data-numeric>
          {ordinal}
        </span>
        {!row.enabled && <StatusChip tone="muted">꺼둠</StatusChip>}
        {row.isNew && <StatusChip tone="warn">저장 전</StatusChip>}
        <span className="flex-1" />
        {/* Native checkbox: this bundle carries no Radix Switch, and the
            platform control already ships the label association, the keyboard
            path and the checked state a screen reader announces.

            The accessible name carries the row, the visible one stays "사용":
            eight fallback hops make eight identical "사용" stops otherwise, and
            a screen reader user tabbing the list cannot tell which provider
            they are about to park. Same rule as the three inputs below, and the
            visible word is kept inside the name so speech input still matches. */}
        <label
          htmlFor={enabledId}
          className="flex shrink-0 cursor-pointer items-center gap-2 text-meta text-ink"
        >
          <input
            type="checkbox"
            id={enabledId}
            checked={row.enabled}
            disabled={locked}
            aria-label={`${ordinal} provider 사용`}
            onChange={(event) => onPatch({ enabled: event.target.checked })}
            className="accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
          사용
        </label>
        {/* Not gated on `offline`: taking a row out of the DRAFT writes
            nothing, and the save below is what the rail being down actually
            blocks. Disabling it offline would make the panel refuse an edit it
            was perfectly able to make. */}
        <ConfirmButton
          label="삭제"
          ariaLabel={`${ordinal} provider 삭제`}
          question={`${ordinal} provider를 목록에서 뺍니다.`}
          confirmLabel="빼기"
          disabled={locked}
          onConfirm={onRemove}
          testId={`chain-remove-${row.key}`}
        />
      </div>

      {/* Address and key share a line, and wrap to two on a narrow window.
          Still label-above-control, so the Korean label and the long URL never
          fight over one column width; what is dropped is the stacked THIRD of
          the block's height, eight times over. A cascade is read as a list, and
          eight hops that need three screens stop being one.

          The error goes to the control it is about. `draftRowError` names the
          field for that reason: "새 provider는 키를 입력해야 저장됩니다."
          rendered under 주소 sends a person to fix the one field they filled
          in correctly. */}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {/* The format example is shown where it is still information: on a row
            being filled in, and on a row whose address the panel just
            rejected. On five stored rows it was five repetitions of a rule
            each row's own value already demonstrates. */}
        <div className="min-w-pane-sm flex-1">
          <Field
            label="provider 주소"
            htmlFor={urlId}
            hint={
              row.isNew || error?.field === "baseUrl"
                ? "예: https://api.example.com/v1"
                : undefined
            }
            error={error?.field === "baseUrl" ? error.message : null}
          >
            <Input
              id={urlId}
              value={row.baseUrl}
              autoComplete="off"
              disabled={locked}
              aria-label={`${ordinal} provider 주소`}
              onChange={(event) => onPatch({ baseUrl: event.target.value })}
              onBlur={() => onBlurField("baseUrl")}
            />
          </Field>
        </div>

        <div className="min-w-pane-sm flex-1">
          <Field
            label="키"
            htmlFor={bearerId}
            hint={bearerHint(row)}
            error={error?.field === "bearer" ? error.message : null}
          >
            <Input
              id={bearerId}
              type="password"
              value={row.bearer}
              autoComplete="off"
              disabled={locked}
              aria-label={`${ordinal} provider 키`}
              onChange={(event) => onPatch({ bearer: event.target.value })}
              onBlur={() => onBlurField("bearer")}
            />
          </Field>
        </div>
      </div>

      <SelectField
        id={modeId}
        label="모드"
        ariaLabel={`${ordinal} provider 모드`}
        value={row.mode}
        disabled={locked}
        choices={PROVIDER_MODES.map((mode) => ({ id: mode.id, label: mode.label }))}
        onChange={(mode) => onPatch({ mode })}
      />
    </fieldset>
  );
}

const PROBE_TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-ink-muted",
};

/** Per-hop probe results from `POST /v1/provider/link/test` (`entries[]`). */
export function ChainProbeResult({
  cascadeOk,
  entries,
  checkedAtMs,
  chainPending,
}: {
  cascadeOk: boolean;
  entries: ProviderChainProbe[];
  /** `ProviderLinkTest.checkedAtMs`: when this answer was measured. */
  checkedAtMs?: number;
  /**
   * The 연결 순서 list below has unsaved edits.
   *
   * These rows are numbered by the order the SERVER tried, and that list is
   * the saved one. Add or remove a hop without saving and the same "3차" names
   * two different providers in one screen, so the table says which of the two
   * it is describing rather than letting the reader assume they match.
   */
  chainPending?: boolean;
}) {
  const rows = probeRows(entries);
  // Tone comes from the summary, not from `cascadeOk` alone: an instance whose
  // only hop is a mock mode has cascadeOk false and nothing wrong with it, so
  // it is drawn muted rather than as a warning about a failure that did not
  // happen (see cascadeProbeSummary).
  const summary = cascadeProbeSummary(cascadeOk, entries);
  return (
    <div className="flex flex-col gap-2" data-testid="chain-probe">
      <p
        role="status"
        data-tone={summary.tone}
        className={cn("text-meta", PROBE_TONE[summary.tone])}
      >
        {summary.text}
      </p>
      <dl className="flex flex-col overflow-hidden rounded-md border border-line">
        {rows.map((row) => (
          <div
            key={row.ordinal}
            className="flex min-w-0 flex-col gap-px border-b border-line p-2 last:border-b-0"
            data-testid="chain-probe-row"
            data-tone={row.tone}
          >
            <dt className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-ink-muted" data-numeric>
                {row.ordinal}
              </span>
              <span className="min-w-0 break-all text-body text-ink">
                {row.endpointLabel}
              </span>
              {/* The same chip the hop list uses for 키 있음 / 꺼둠 / 저장 전.
                  One panel, one way of writing a status: a bare coloured word
                  two blocks under a bordered chip reads as two different kinds
                  of fact. */}
              <StatusChip tone={row.tone}>{row.label}</StatusChip>
            </dt>
            <dd className="min-w-0 break-words text-meta text-ink-muted">
              {row.detail}
            </dd>
          </div>
        ))}
      </dl>
      {(checkedAtMs !== undefined || chainPending) && (
        <p className="text-meta text-ink-muted" data-testid="chain-probe-scope">
          {checkedAtMs !== undefined && (
            <span data-numeric>
              {new Date(checkedAtMs).toLocaleString("ko-KR")}에 확인했습니다.{" "}
            </span>
          )}
          {chainPending
            ? "이 순서는 서버에 저장된 순서입니다. 아래 목록에는 아직 저장하지 않은 변경이 있어 번호가 서로 다를 수 있습니다."
            : "번호는 서버에 저장된 순서입니다."}
        </p>
      )}
    </div>
  );
}

export function AiLinkChain({
  offline,
  onSaved,
  onPendingChange,
}: {
  offline: boolean;
  /**
   * The stored chain changed, so any probe result on screen now describes a
   * cascade that no longer exists. The singleton form already clears it on
   * save and unlink; this is the third path that had to.
   */
  onSaved?: () => void;
  /** Unsaved edits exist, so probe ordinals and list ordinals may disagree. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: CHAIN_KEY,
    queryFn: () => readChain(fetchProviderChain),
    retry: false,
  });

  // The draft is seeded from the server answer and then owned by the operator.
  // `loadedFor` is what makes that safe without an effect: a refetch that
  // returns the same rows must not throw away a half-typed hop, so the draft is
  // rebuilt only when a DIFFERENT answer arrives.
  const [draft, setDraft] = useState<ChainDraftRow[]>([]);
  const [loadedFor, setLoadedFor] = useState<ProviderChain | null>(null);
  // Which fields have had their turn. A row created one click ago has not
  // failed at anything, so its error is held back until the person leaves the
  // field or asks to save (see DraftRowError.message).
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  if (query.data !== undefined && query.data !== loadedFor) {
    setLoadedFor(query.data);
    setDraft(draftFromChain(query.data));
    setSeen(new Set());
  }

  function reload(chain: ProviderChain) {
    setLoadedFor(chain);
    setDraft(draftFromChain(chain));
    setSeen(new Set());
    client.setQueryData(CHAIN_KEY, chain);
    onSaved?.();
  }

  const save = useMutation({
    mutationFn: () => readChain(() => putProviderChain(draftToInput(draft))),
    onSuccess: reload,
  });

  const clear = useMutation({
    mutationFn: () => readChain(deleteProviderChain),
    onSuccess: reload,
  });

  const chain = query.data;
  const errors = draftErrors(draft);
  const dirty = chain === undefined ? false : draftIsDirty(draft, chain);

  useEffect(() => {
    onPendingChange?.(dirty);
  }, [dirty, onPendingChange]);

  const lines = [
    "첫 provider가 응답하지 않거나 한도를 넘으면 다음 예비 provider로 넘어갑니다.",
    "요청이 잘못되어 거절된 경우에는 넘기지 않습니다. 두 번째 provider에서도 같은 이유로 실패하기 때문입니다.",
  ];

  if (query.isPending) {
    return (
      <Subsection title="연결 순서" lines={lines}>
        <SkeletonRows rows={3} />
      </Subsection>
    );
  }

  if (query.isError || chain === undefined) {
    // A server that predates the endpoint is not a broken panel: it is a server
    // with one provider, which is exactly what the block above already shows.
    const notYet = chainErrorCopy(query.error);
    // …and on that server the intro lines are dropped, not just contradicted.
    // "첫 provider가 응답하지 않으면 다음 순서로 넘어갑니다." is present tense
    // about a behaviour this instance does not have, and leaving it above the
    // correction put two opposite sentences in one screen (measured on
    // momowebqa, light and dark). The correction is the whole answer here.
    return (
      <Subsection title="연결 순서" lines={notYet !== null ? undefined : lines}>
        {notYet !== null ? (
          <p className="text-body text-ink-muted" data-testid="chain-unavailable">
            {notYet}
          </p>
        ) : isOperatorDenied(query.error) ? (
          <p className="text-body text-ink-muted" data-testid="chain-denied">
            연결 순서는 이 서버의 운영자만 볼 수 있습니다.
          </p>
        ) : (
          <InlineBanner
            message={errorMessage(query.error)}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="chain-error"
          />
        )}
      </Subsection>
    );
  }

  const busy = save.isPending || clear.isPending;
  const full = draft.length >= MAX_FALLBACK_HOPS;
  // The one condition that makes this block READ-ONLY rather than merely
  // unsaved: a PUT built from a draft that is missing an entry would delete
  // that entry, and its stored key with it.
  const unreadable = chainUnreadableCopy(chain);
  const readOnly = unreadable !== null;
  const canSave = dirty && errors.size === 0 && !offline && !readOnly;
  const blocked = draftBlockedHint(draft, errors);

  return (
    <Subsection title="연결 순서" lines={lines}>
      {unreadable !== null && (
        <InlineBanner message={unreadable} testId="chain-partial" />
      )}
      <p className="text-body text-ink-muted" data-testid="chain-summary">
        {chainSummary(chain)}
      </p>

      {/* One bordered group with hairline rows, head included: the head IS 1차,
          and a box per hop is the web-card AI-tell the radio group in
          SettingsFields already refuses for the same reason. */}
      <div
        className="flex flex-col overflow-hidden rounded-md border border-line"
        data-testid="chain-list"
      >
        <HeadRow chain={chain} />
        {draft.map((row, index) => {
          const error = errors.get(row.key);
          return (
          <HopRow
            key={row.key}
            row={row}
            index={index}
            error={
              error !== undefined && seen.has(`${row.key}:${error.field}`)
                ? error
                : undefined
            }
            busy={busy}
            locked={busy || readOnly}
            onPatch={(patch) =>
              setDraft((rows) => patchDraftRow(rows, row.key, patch))
            }
            onBlurField={(field) =>
              setSeen((current) => new Set(current).add(`${row.key}:${field}`))
            }
            onRemove={() => setDraft((rows) => removeDraftRow(rows, row.key))}
          />
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full || busy || readOnly}
          onClick={() => setDraft((rows) => addDraftRow(rows))}
          data-testid="chain-add"
        >
          예비 provider 추가
        </Button>
        <SaveButton
          label="연결 순서 저장"
          canSave={canSave}
          busy={save.isPending}
          onSave={() => save.mutate()}
          testId="chain-save"
        />
        {chain.fallbackCount > 0 && !readOnly && (
          <ConfirmButton
            label="예비 provider 전부 지우기"
            question="저장된 예비 provider를 모두 지웁니다."
            confirmLabel="지우기"
            disabled={offline || busy}
            onConfirm={() => clear.mutate()}
            testId="chain-clear"
          />
        )}
      </div>

      {/* Position is the credential's identity on the server, so a saved hop
          cannot be moved without re-typing its key. That is a rule the list
          obeys silently otherwise: new rows land at the end and nothing on
          screen says why there is no way to move them. */}
      <p className="text-meta text-ink-muted" data-testid="chain-order-rule">
        새 provider는 목록 맨 아래에 붙습니다. 저장된 키는 그 자리에 함께
        보관되므로 순서만 따로 바꿀 수는 없고, 순서를 바꾸려면 해당 provider를
        지운 뒤 키와 함께 다시 추가하세요.
      </p>
      {/* ENGINE_HANDOFF X-15: the transition row in the timeline is built from
          a live frame and there is no REST history behind it, so a person who
          reloads sees nothing for a turn that really did fall over. ADR-0135 D1
          bans the silent switch, and an absence a reader would misread as "아무
          일도 없었다" is one. Said here, once, until X-15 lands. */}
      <p className="text-meta text-ink-muted" data-testid="chain-record-scope">
        전환이 일어나면 그 실행 기록 아래에 한 줄로 남습니다. 지금은 화면을 열어
        둔 동안 도착한 전환만 남으므로, 줄이 없다고 전환이 없었다는 뜻은
        아닙니다.
      </p>

      {full && (
        <p className="text-meta text-ink-muted" data-testid="chain-full">
          예비 provider는 {MAX_FALLBACK_HOPS}개까지 둘 수 있습니다. 하나를 뺀 뒤
          추가하세요.
        </p>
      )}
      {/* Offline is named where the button is, not only in the route banner at
          the top of the page: this block is the foot of a tall panel, and by
          the time a person reaches it the reason their save does nothing has
          scrolled off screen. */}
      {dirty && errors.size === 0 && !save.isPending && !readOnly && (
        <p className="text-meta text-ink-muted" role="status" data-testid="chain-dirty">
          {chainDirtyHint(offline)}
        </p>
      )}
      {blocked !== null && !readOnly && (
        <p className="text-meta text-ink-muted" data-testid="chain-blocked">
          {blocked}
        </p>
      )}
      {save.isError && (
        <p className="text-meta text-danger" role="alert" data-testid="chain-save-error">
          {chainSaveMessage(save.error)}
        </p>
      )}
      {clear.isError && (
        <p className="text-meta text-danger" role="alert">
          {chainSaveMessage(clear.error)}
        </p>
      )}
    </Subsection>
  );
}
