import type {
  AgentProfile,
  AgentProfileInput,
} from "@momo/core/lib/api";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";

export interface ToolRow extends AgentToolCatalogEntry {
  enabled: boolean;
  unknown: boolean;
}

export function mergeToolRows(
  catalog: readonly AgentToolCatalogEntry[],
  enabledTools: readonly string[]
): ToolRow[] {
  const enabled = new Set(enabledTools);
  const seen = new Set<string>();
  const rows: ToolRow[] = [];
  for (const item of catalog) {
    seen.add(item.name);
    rows.push({
      ...item,
      enabled: enabled.has(item.name),
      unknown: false,
    });
  }
  for (const name of enabledTools) {
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({
      name,
      description: "",
      executable: true,
      requiresApproval: true,
      unavailableReason: null,
      enabled: true,
      unknown: true,
    });
  }
  return rows;
}

export function toggleToolRow(
  rows: readonly ToolRow[],
  name: string,
  next: boolean
): ToolRow[] {
  return rows.map((row) => {
    if (row.name !== name || !row.executable) return row;
    return { ...row, enabled: next };
  });
}

export function enabledToolsFromRows(rows: readonly ToolRow[]): string[] {
  return rows.filter((row) => row.enabled).map((row) => row.name);
}

export function isToolToggleLocked(row: ToolRow, readOnly: boolean): boolean {
  return readOnly || !row.executable;
}

export function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((name) => set.has(name));
}

export function isToolRoveKey(key: string): boolean {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

export const INSTRUCTION_BYTE_LIMIT = 8_192;

export const UNKNOWN_TOOL_CHIP = "이 서버 목록에 없음";
export const UNKNOWN_TOOL_REASON =
  "이 서버가 공개한 도구 목록에 없는 이름입니다.";

/** RED stub (#1957 R2 H-1): omits saved routing fields and the 8KB guard. */
export function toolsProfilePut(
  profile: AgentProfile | null,
  enabledTools: string[]
):
  | { ok: true; input: AgentProfileInput }
  | { ok: false; message: string } {
  return {
    ok: true,
    input: {
      instructions: profile?.instructions ?? "",
      enabledTools,
      triggers: profile?.triggers ?? { mention: true },
    },
  };
}

export function roveToolToggles(
  root: HTMLElement | null,
  event: {
    key: string;
    target: EventTarget | null;
    preventDefault: () => void;
  }
): boolean {
  if (!isToolRoveKey(event.key)) return false;
  if (!root) return false;
  const target = event.target;
  if (!(target instanceof Node) || !root.contains(target)) return false;
  const toggles = Array.from(
    root.querySelectorAll<HTMLElement>("[data-tool-toggle]")
  );
  if (toggles.length === 0) return false;
  const index = toggles.indexOf(
    root.ownerDocument.activeElement as HTMLElement
  );
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next =
    toggles[(Math.max(index, 0) + step + toggles.length) % toggles.length];
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}
