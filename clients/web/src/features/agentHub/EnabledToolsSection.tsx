import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";

export type ToolsSaveResult =
  | { ok: true }
  | { ok: false; forbidden: boolean; message: string };

export interface EnabledToolsSectionProps {
  catalog: readonly AgentToolCatalogEntry[] | null;
  catalogStatus: "loading" | "ready" | "absent" | "forbidden" | "unknown";
  catalogMessage: string | null;
  enabledTools: readonly string[];
  offline: boolean;
  editable: boolean;
  editDisabledReason: string | null;
  onRetryCatalog?: () => void;
  save: (enabledTools: string[]) => Promise<ToolsSaveResult>;
}

/**
 * Reading this as: Agent Hub profile tools section for internal team users on
 * web+Tauri, density 7/10, motion 2/10.
 *
 * RED stub (#1957): display-only chips. Toggles, save, 403, and keyboard proofs
 * fail against this on purpose.
 */
export function EnabledToolsSection({
  enabledTools,
}: EnabledToolsSectionProps) {
  return (
    <section data-testid="agent-hub-enabled-tools">
      <h3>도구</h3>
      <div>
        {enabledTools.length === 0 ? (
          <span>허용된 도구 없음</span>
        ) : (
          enabledTools.map((tool) => <span key={tool}>{tool}</span>)
        )}
      </div>
    </section>
  );
}
