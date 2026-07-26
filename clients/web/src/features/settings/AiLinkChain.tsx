import { useState } from "react";
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
  cascadeProbeSummary,
  CHAIN_UNREADABLE,
  chainErrorCopy,
  chainSaveMessage,
  chainSummary,
  draftErrors,
  draftFromChain,
  draftIsDirty,
  draftToInput,
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
import { choiceLabel, errorMessage, isOperatorDenied, maskedBearer, PROVIDER_MODES } from "./model";
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
// Three properties of the surface, each from a server rule rather than taste:
//
//   * The head row is read-only here. `PUT /v1/provider/link/chain` rejects
//     position 0 with a 400, on purpose: two editors for one hop would let this
//     block overwrite the MOMO-583 gated singleton. The row names where it IS
//     edited instead of offering a control that answers 400.
//   * Saving replaces every fallback hop at once, and an omitted key means
//     "keep the one stored at this position". So the key field of a stored hop
//     starts empty and says so; it is not a blank that will wipe anything.
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
      className="flex flex-col gap-1 rounded-md border border-line bg-surface-raised p-3"
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
        <StatusChip tone="muted">{choiceLabel(PROVIDER_MODES, head.mode)}</StatusChip>
      </div>
      <p className="text-meta text-ink-muted">
        가장 먼저 시도합니다. 이 항목은 위의 provider 연결에서 바꿉니다.
      </p>
    </div>
  );
}

/** One editable fallback hop. */
function HopRow({
  row,
  index,
  error,
  busy,
  onPatch,
  onRemove,
}: {
  row: ChainDraftRow;
  index: number;
  error: DraftRowError | undefined;
  /**
   * A write is in flight. There is deliberately no `offline` here: everything
   * this row changes is DRAFT state, and the rail being down is answered by the
   * save button, not by refusing edits the panel can make perfectly well.
   */
  busy: boolean;
  onPatch: (
    patch: Partial<Pick<ChainDraftRow, "baseUrl" | "bearer" | "mode" | "enabled">>
  ) => void;
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
    <div
      className="flex flex-col gap-2 rounded-md border border-line p-3"
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
            aria-label={`${ordinal} provider 사용`}
            onChange={(event) => onPatch({ enabled: event.target.checked })}
            className="accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
          disabled={busy}
          onConfirm={onRemove}
          testId={`chain-remove-${row.key}`}
        />
      </div>

      {/* The error goes to the control it is about. `draftRowError` names the
          field for that reason: "새 provider는 키를 입력해야 저장됩니다."
          rendered under 주소 sends a person to fix the one field they filled
          in correctly. */}
      <Field
        label="provider 주소"
        htmlFor={urlId}
        hint="예: https://api.example.com/v1"
        error={error?.field === "baseUrl" ? error.message : null}
      >
        <Input
          id={urlId}
          value={row.baseUrl}
          autoComplete="off"
          aria-label={`${ordinal} provider 주소`}
          onChange={(event) => onPatch({ baseUrl: event.target.value })}
        />
      </Field>

      <Field
        label="키"
        htmlFor={bearerId}
        hint={
          row.isNew
            ? "입력한 값은 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다."
            : `저장된 키 ${maskedBearer(row.bearerLast4)}. 비워 두면 그대로 둡니다.`
        }
        error={error?.field === "bearer" ? error.message : null}
      >
        <Input
          id={bearerId}
          type="password"
          value={row.bearer}
          autoComplete="off"
          aria-label={`${ordinal} provider 키`}
          onChange={(event) => onPatch({ bearer: event.target.value })}
        />
      </Field>

      <SelectField
        id={modeId}
        label="모드"
        ariaLabel={`${ordinal} provider 모드`}
        value={row.mode}
        choices={PROVIDER_MODES.map((mode) => ({ id: mode.id, label: mode.label }))}
        onChange={(mode) => onPatch({ mode })}
      />
    </div>
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
}: {
  cascadeOk: boolean;
  entries: ProviderChainProbe[];
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
              <span className={cn("text-meta font-medium", PROBE_TONE[row.tone])}>
                {row.label}
              </span>
            </dt>
            <dd className="min-w-0 break-words text-meta text-ink-muted">
              {row.detail}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AiLinkChain({ offline }: { offline: boolean }) {
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
  if (query.data !== undefined && query.data !== loadedFor) {
    setLoadedFor(query.data);
    setDraft(draftFromChain(query.data));
  }

  const save = useMutation({
    mutationFn: () => readChain(() => putProviderChain(draftToInput(draft))),
    onSuccess: (chain) => {
      setLoadedFor(chain);
      setDraft(draftFromChain(chain));
      client.setQueryData(CHAIN_KEY, chain);
    },
  });

  const clear = useMutation({
    mutationFn: () => readChain(deleteProviderChain),
    onSuccess: (chain) => {
      setLoadedFor(chain);
      setDraft(draftFromChain(chain));
      client.setQueryData(CHAIN_KEY, chain);
    },
  });

  const lines = [
    "첫 provider가 응답하지 않거나 한도를 넘으면 다음 순서로 넘어갑니다.",
    "요청이 잘못되어 거절된 경우에는 넘기지 않습니다. 두 번째 provider에서도 같은 이유로 실패하기 때문입니다.",
  ];

  if (query.isPending) {
    return (
      <Subsection title="연결 순서" lines={lines}>
        <SkeletonRows rows={3} />
      </Subsection>
    );
  }

  if (query.isError) {
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

  const chain = query.data;
  const errors = draftErrors(draft);
  const dirty = draftIsDirty(draft, chain);
  const busy = save.isPending || clear.isPending;
  const full = draft.length >= MAX_FALLBACK_HOPS;

  return (
    <Subsection title="연결 순서" lines={lines}>
      <p className="text-body text-ink-muted" data-testid="chain-summary">
        {chainSummary(chain)}
      </p>

      <div className="flex flex-col gap-2" data-testid="chain-list">
        <HeadRow chain={chain} />
        {draft.map((row, index) => (
          <HopRow
            key={row.key}
            row={row}
            index={index}
            error={errors.get(row.key)}
            busy={busy}
            onPatch={(patch) =>
              setDraft((rows) => patchDraftRow(rows, row.key, patch))
            }
            onRemove={() => setDraft((rows) => removeDraftRow(rows, row.key))}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full || busy}
          onClick={() => setDraft((rows) => addDraftRow(rows))}
          data-testid="chain-add"
        >
          폴백 provider 추가
        </Button>
        <SaveButton
          label="연결 순서 저장"
          canSave={dirty && errors.size === 0 && !offline}
          busy={save.isPending}
          onSave={() => save.mutate()}
          testId="chain-save"
        />
        {chain.fallbackCount > 0 && (
          <ConfirmButton
            label="폴백 전부 지우기"
            question="저장된 폴백 provider를 모두 지웁니다."
            confirmLabel="지우기"
            disabled={offline || busy}
            onConfirm={() => clear.mutate()}
            testId="chain-clear"
          />
        )}
      </div>

      {full && (
        <p className="text-meta text-ink-muted" data-testid="chain-full">
          폴백 provider는 {MAX_FALLBACK_HOPS}개까지 둘 수 있습니다. 하나를 뺀 뒤
          추가하세요.
        </p>
      )}
      {dirty && errors.size === 0 && !save.isPending && (
        <p className="text-meta text-ink-muted" role="status">
          아직 저장되지 않았습니다. 연결 순서 저장을 눌러야 적용됩니다.
        </p>
      )}
      {errors.size > 0 && (
        <p className="text-meta text-ink-muted" data-testid="chain-blocked">
          위에 표시된 항목을 고쳐야 저장할 수 있습니다.
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
