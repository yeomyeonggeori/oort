import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useInlineConfirm } from "@/design/ui/inlineConfirm";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { StatusChip } from "./StatusChip";
import {
  EMPTY_CATALOG_COPY,
  UNKNOWN_TOOL_CHIP,
  enabledToolsFromRows,
  isToolToggleLocked,
  mergeToolRows,
  resolveToolTabStop,
  roveToolToggles,
  sameToolSet,
  toggleToolRow,
  type ToolRow,
} from "./enabledToolsModel";

export type ToolsSaveResult =
  | { ok: true }
  | { ok: false; forbidden: boolean; message: string };

export interface EnabledToolsSectionProps {
  catalog: readonly AgentToolCatalogEntry[] | null;
  catalogStatus: "loading" | "ready" | "absent" | "forbidden" | "unknown";
  catalogMessage: string | null;
  enabledTools: readonly string[];
  emptyLabel?: string;
  offline: boolean;
  editable: boolean;
  editDisabledReason: string | null;
  onRetryCatalog?: () => void;
  save: (enabledTools: string[]) => Promise<ToolsSaveResult>;
}

const OFFLINE_REASON = "연결이 끊긴 동안에는 바꿀 수 없습니다.";
const SAVE_ERROR =
  "도구 허용을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요.";
const SAVE_IDLE_REASON = "바꿀 내용이 없습니다.";
const TOOLS_EDITOR_LEAD =
  "이 에이전트가 부를 수 있는 도구입니다. 바꾼 뒤에는 저장해야 반영됩니다.";
const TOOLS_DISPLAY_LEAD = "이 에이전트에 허용된 도구입니다.";

/**
 * Reading this as: Agent Hub profile tools section for internal team users on
 * web+Tauri, density 7/10, motion 2/10.
 */
export function EnabledToolsSection({
  catalog,
  catalogStatus,
  catalogMessage,
  enabledTools,
  emptyLabel = "허용된 도구 없음",
  offline,
  editable,
  editDisabledReason,
  onRetryCatalog,
  save,
}: EnabledToolsSectionProps) {
  const savedRows = useMemo(
    () => mergeToolRows(catalog ?? [], enabledTools),
    [catalog, enabledTools]
  );
  const [draft, setDraft] = useState<ToolRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [roveName, setRoveName] = useState<string | null>(null);
  const { confirmed, confirm } = useInlineConfirm();
  const rows = draft ?? savedRows;
  const readOnly =
    !editable ||
    offline ||
    forbidden !== null ||
    catalogStatus === "forbidden";
  const dirty = !sameToolSet(enabledToolsFromRows(rows), [...enabledTools]);
  const canSave = dirty && !readOnly && !saving;
  const sharedReason = offline
    ? OFFLINE_REASON
    : forbidden
      ? forbidden
      : !editable
        ? editDisabledReason
        : null;
  const sharedReasonId = "agent-hub-enabled-tools-reason";
  const saveReasonId = "agent-hub-enabled-tools-save-reason";
  const tabStopName = resolveToolTabStop(rows, readOnly, roveName);
  const catalogReady = catalogStatus === "ready" && catalog !== null;
  const catalogEmpty = catalogReady && rows.length === 0;

  async function submit() {
    if (saving || readOnly || !dirty) return;
    setSaving(true);
    setError(null);
    const result = await save(enabledToolsFromRows(rows));
    setSaving(false);
    if (result.ok) {
      confirm();
      return;
    }
    if (result.forbidden) {
      setForbidden(result.message);
      return;
    }
    setError(result.message || SAVE_ERROR);
  }

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="agent-hub-enabled-tools"
      onKeyDown={(event) => {
        if (!PRIMARY_ACTION_SHORTCUT.matches(event)) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h3 className="text-body font-semibold text-ink">도구</h3>
        {(catalogReady ? !catalogEmpty : catalogStatus !== "loading") && (
          <p className="text-meta text-ink-muted">
            {catalogReady ? TOOLS_EDITOR_LEAD : TOOLS_DISPLAY_LEAD}
          </p>
        )}
      </div>

      {catalogStatus === "loading" ? (
        <Skeleton ready={false} rows={4} className="p-0" />
      ) : catalogEmpty ? (
        <p className="text-body text-ink">{EMPTY_CATALOG_COPY}</p>
      ) : catalogReady ? (
        <>
          {forbidden && (
            <InlineBanner
              tone="neutral"
              separator={false}
              message={forbidden}
              messageId={sharedReasonId}
              testId="agent-hub-enabled-tools-forbidden"
            />
          )}
          {error && (
            <InlineBanner
              separator={false}
              message={error}
              testId="agent-hub-enabled-tools-error"
            />
          )}
          {offline && (
            <p id={sharedReasonId} className="sr-only">
              {OFFLINE_REASON}
            </p>
          )}
          {!offline && !editable && editDisabledReason && !forbidden && (
            <p
              id={sharedReasonId}
              className="text-meta text-ink-muted"
              data-testid="agent-hub-enabled-tools-edit-reason"
            >
              {editDisabledReason}
            </p>
          )}
          {!canSave && (
            <p id={saveReasonId} className="sr-only">
              {readOnly ? (sharedReason ?? SAVE_IDLE_REASON) : SAVE_IDLE_REASON}
            </p>
          )}
          <ul
            className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
            onKeyDown={(event) => {
              if (roveToolToggles(event.currentTarget, event)) {
                const active = event.currentTarget.ownerDocument.activeElement;
                if (active instanceof HTMLElement) {
                  const name = active.getAttribute("data-tool-name");
                  if (name) setRoveName(name);
                }
              }
            }}
          >
            {rows.map((row, index) => (
              <ToolToggleRow
                key={row.name}
                row={row}
                index={index}
                locked={isToolToggleLocked(row, readOnly)}
                tabStop={row.name === tabStopName}
                describedBy={
                  [
                    `agent-hub-tool-${index}-desc`,
                    !row.executable || row.unknown
                      ? `agent-hub-tool-${index}-reason`
                      : null,
                    readOnly && sharedReason ? sharedReasonId : null,
                  ]
                    .filter((id): id is string => id !== null)
                    .join(" ")
                }
                onFocus={() => {
                  if (!isToolToggleLocked(row, readOnly)) setRoveName(row.name);
                }}
                onToggle={(next) => {
                  if (isToolToggleLocked(row, readOnly) || saving) return;
                  setError(null);
                  setDraft(toggleToolRow(rows, row.name, next));
                }}
              />
            ))}
          </ul>
          <Button
            type="button"
            size="sm"
            className={cn(
              "tap-target self-start",
              !canSave && !saving && "pointer-events-none",
              !canSave &&
                !confirmed &&
                !saving &&
                "opacity-50 hover:opacity-50"
            )}
            aria-disabled={!canSave || undefined}
            aria-busy={saving || undefined}
            aria-live="polite"
            aria-describedby={!canSave ? saveReasonId : undefined}
            data-testid="agent-hub-enabled-tools-save"
            onClick={() => {
              if (!canSave) return;
              void submit();
            }}
          >
            {saving && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {saving
              ? "저장 중"
              : confirmed
                ? "도구 변경 저장됨"
                : "도구 변경 저장"}
          </Button>
        </>
      ) : (
        <>
          {catalogStatus === "unknown" && (
            <InlineBanner
              message={
                catalogMessage ??
                "도구 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요."
              }
              actionLabel={onRetryCatalog ? "다시 시도" : undefined}
              onAction={onRetryCatalog}
              testId="agent-hub-enabled-tools-catalog-error"
            />
          )}
          {catalogStatus === "forbidden" && (
            <InlineBanner
              tone="neutral"
              separator={false}
              message={
                catalogMessage ??
                "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없습니다."
              }
              testId="agent-hub-enabled-tools-forbidden"
            />
          )}
          <ToolsChips tools={enabledTools} emptyLabel={emptyLabel} />
        </>
      )}
    </section>
  );
}

function ToolsChips({
  tools,
  emptyLabel,
}: {
  tools: readonly string[];
  emptyLabel: string;
}) {
  if (tools.length === 0) {
    return <span className="text-ink">{emptyLabel}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((tool) => (
        <StatusChip key={tool}>{tool}</StatusChip>
      ))}
    </div>
  );
}

function ToolToggleRow({
  row,
  index,
  locked,
  tabStop,
  describedBy,
  onFocus,
  onToggle,
}: {
  row: ToolRow;
  index: number;
  locked: boolean;
  tabStop: boolean;
  describedBy: string;
  onFocus: () => void;
  onToggle: (next: boolean) => void;
}) {
  const nameId = `agent-hub-tool-${index}-name`;
  const descId = `agent-hub-tool-${index}-desc`;
  const reasonId = `agent-hub-tool-${index}-reason`;
  const capability = row.unknown
    ? UNKNOWN_TOOL_CHIP
    : row.executable
      ? "실행 가능"
      : "실행 불가";
  return (
    <li className="border-b border-line last:border-b-0">
      <label
        className={cn(
          "flex min-w-0 items-start gap-3 p-3 tap-target",
          locked
            ? "cursor-default"
            : "cursor-pointer hover:bg-surface-hover active:bg-surface-pressed",
          row.enabled && "bg-accent-soft",
          "has-[:focus-visible]:focus-ring"
        )}
        data-testid={`agent-hub-tool-row-${row.name}`}
      >
        <input
          type="checkbox"
          data-tool-toggle=""
          data-tool-name={row.name}
          data-testid={`agent-hub-tool-toggle-${row.name}`}
          tabIndex={tabStop ? 0 : -1}
          checked={row.enabled}
          aria-disabled={locked || undefined}
          aria-labelledby={nameId}
          aria-describedby={describedBy}
          className={cn(
            "mt-1 size-4 shrink-0 rounded-sm accent-accent focus-visible:focus-ring",
            locked && "opacity-50"
          )}
          onFocus={onFocus}
          onChange={(event) => {
            if (locked) return;
            onToggle(event.target.checked);
          }}
          onKeyDown={(event) => {
            if (event.key !== " " && event.key !== "Spacebar") return;
            event.preventDefault();
            if (locked) return;
            onToggle(!row.enabled);
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={nameId} className="break-all text-body text-ink">
            {row.name}
          </span>
          {row.description !== "" && (
            <span id={descId} className="break-keep text-meta text-ink-muted">
              {row.description}
            </span>
          )}
          {row.description === "" && <span id={descId} className="sr-only" />}
          <div className="flex flex-wrap gap-1">
            <StatusChip tone="neutral">{capability}</StatusChip>
            {row.requiresApproval && (
              <StatusChip tone="warn">승인 필요</StatusChip>
            )}
          </div>
          {row.unavailableReason && (
            <span id={reasonId} className="break-keep text-meta text-ink-muted">
              {row.unavailableReason}
            </span>
          )}
        </div>
      </label>
    </li>
  );
}
