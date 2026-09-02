import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useInlineConfirm } from "@/design/ui/inlineConfirm";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  enabledToolsFromRows,
  isToolToggleLocked,
  mergeToolRows,
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
  const { confirmed, confirm } = useInlineConfirm();
  const rows = draft ?? savedRows;
  const readOnly =
    !editable ||
    offline ||
    forbidden !== null ||
    catalogStatus === "forbidden";
  const dirty = !sameToolSet(enabledToolsFromRows(rows), [...enabledTools]);
  const sharedReason = offline
    ? OFFLINE_REASON
    : forbidden
      ? forbidden
      : !editable
        ? editDisabledReason
        : null;
  const sharedReasonId = "agent-hub-enabled-tools-reason";

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
        <p className="text-meta text-ink-muted">
          이 에이전트가 부를 수 있는 도구입니다. 바꾼 뒤에는 저장해야 반영됩니다.
        </p>
      </div>

      {catalogStatus === "loading" ? (
        <SkeletonRows rows={4} className="p-0" />
      ) : catalogStatus === "ready" && catalog !== null ? (
        <>
          {forbidden && (
            <InlineBanner
              tone="neutral"
              separator={false}
              message={
                forbidden ??
                catalogMessage ??
                "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없습니다."
              }
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
            <p id={sharedReasonId} className="sr-only">
              {editDisabledReason}
            </p>
          )}
          <ul
            className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
            onKeyDown={(event) => {
              roveToolToggles(event.currentTarget, event);
            }}
          >
            {rows.map((row, index) => (
              <ToolToggleRow
                key={row.name}
                row={row}
                index={index}
                locked={isToolToggleLocked(row, readOnly)}
                describedBy={
                  [
                    `agent-hub-tool-${index}-desc`,
                    !row.executable ? `agent-hub-tool-${index}-reason` : null,
                    readOnly && sharedReason ? sharedReasonId : null,
                  ]
                    .filter((id): id is string => id !== null)
                    .join(" ")
                }
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
            className="tap-target self-start motion-instant"
            aria-disabled={!dirty || readOnly || undefined}
            aria-busy={saving || undefined}
            aria-live="polite"
            data-testid="agent-hub-enabled-tools-save"
            onClick={() => {
              void submit();
            }}
          >
            {saving && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {saving ? "저장 중" : confirmed ? "저장됨" : "저장"}
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
        <span
          key={tool}
          className="rounded-sm border border-line px-1 text-timestamp text-ink-muted"
        >
          {tool}
        </span>
      ))}
    </div>
  );
}

function ToolToggleRow({
  row,
  index,
  locked,
  describedBy,
  onToggle,
}: {
  row: ToolRow;
  index: number;
  locked: boolean;
  describedBy: string;
  onToggle: (next: boolean) => void;
}) {
  const nameId = `agent-hub-tool-${index}-name`;
  const descId = `agent-hub-tool-${index}-desc`;
  const reasonId = `agent-hub-tool-${index}-reason`;
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-3 border-b border-line p-3 last:border-b-0 tap-target",
        row.enabled ? "bg-accent-soft" : "hover:bg-surface-hover"
      )}
      data-testid={`agent-hub-tool-row-${row.name}`}
    >
      <input
        type="checkbox"
        data-tool-toggle=""
        data-testid={`agent-hub-tool-toggle-${row.name}`}
        checked={row.enabled}
        aria-disabled={locked || undefined}
        aria-labelledby={nameId}
        aria-describedby={describedBy}
        className={cn(
          "mt-1 size-4 shrink-0 rounded-sm accent-accent focus-visible:focus-ring",
          locked && "opacity-50"
        )}
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
          <span className="rounded-sm border border-line px-1 text-timestamp text-ink-muted">
            {row.executable ? "실행 가능" : "선언만"}
          </span>
          {row.requiresApproval && (
            <span className="rounded-sm border border-warn px-1 text-timestamp text-warn">
              승인 필요
            </span>
          )}
        </div>
        {!row.executable && row.unavailableReason && (
          <span id={reasonId} className="break-keep text-meta text-ink-muted">
            {row.unavailableReason}
          </span>
        )}
      </div>
    </li>
  );
}
