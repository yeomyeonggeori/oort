import type {
  AgentProfile,
  AgentProfileInput,
} from "@momo/core/lib/api";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";

export interface ToolRow extends AgentToolCatalogEntry {
  enabled: boolean;
  unknown: boolean;
}

export const INSTRUCTION_BYTE_LIMIT = 8_192;

export const UNKNOWN_TOOL_CHIP = "이 서버 목록에 없음";
export const UNKNOWN_TOOL_REASON =
  "이 서버가 공개한 도구 목록에 없는 이름입니다.";

export const EMPTY_CATALOG_COPY = "이 서버가 공개한 도구가 없습니다";

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
      executable: false,
      requiresApproval: true,
      unavailableReason: UNKNOWN_TOOL_REASON,
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
    if (row.name !== name) return row;
    if (!row.executable && !row.unknown) return row;
    return { ...row, enabled: next };
  });
}

export function enabledToolsFromRows(rows: readonly ToolRow[]): string[] {
  return rows.filter((row) => row.enabled).map((row) => row.name);
}

export function isToolToggleLocked(row: ToolRow, readOnly: boolean): boolean {
  return readOnly || (!row.executable && !row.unknown);
}

export function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((name) => set.has(name));
}

export function instructionByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function toolsProfilePut(
  profile: AgentProfile | null,
  enabledTools: string[]
):
  | { ok: true; input: AgentProfileInput }
  | { ok: false; message: string } {
  const instructions = profile?.instructions ?? "";
  if (instructionByteLength(instructions) > INSTRUCTION_BYTE_LIMIT) {
    return {
      ok: false,
      message: "지시문은 UTF-8 기준 8KB 이하로 줄여야 합니다.",
    };
  }
  const input: AgentProfileInput = {
    instructions,
    enabledTools,
    triggers: profile?.triggers ?? { mention: true },
  };
  if (profile?.modelPref) input.modelPref = profile.modelPref;
  if (profile?.effortPref) input.effortPref = profile.effortPref;
  return { ok: true, input };
}

export function isToolRoveKey(key: string): boolean {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

export function resolveToolTabStop(
  rows: readonly ToolRow[],
  readOnly: boolean,
  preferred: string | null
): string | null {
  const names = rows.map((row) => row.name);
  const unlocked = rows
    .filter((row) => !isToolToggleLocked(row, readOnly))
    .map((row) => row.name);
  const candidates = unlocked.length > 0 ? unlocked : names;
  if (candidates.length === 0) return null;
  if (preferred !== null && candidates.includes(preferred)) return preferred;
  return candidates[0] ?? null;
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
  const all = Array.from(
    root.querySelectorAll<HTMLElement>("[data-tool-toggle]")
  );
  const live = all.filter((el) => el.getAttribute("aria-disabled") !== "true");
  const pool = live.length > 0 ? live : all;
  if (pool.length === 0) return false;
  const active = root.ownerDocument.activeElement as HTMLElement;
  let next: HTMLElement | undefined;
  if (event.key === "Home") {
    next = pool[0];
  } else if (event.key === "End") {
    next = pool[pool.length - 1];
  } else {
    const step = event.key === "ArrowDown" ? 1 : -1;
    const from = all.indexOf(active);
    if (from < 0) {
      const stop = pool.find((el) => el.tabIndex === 0) ?? pool[0];
      const stopIndex = pool.indexOf(stop);
      next = pool[(stopIndex + step + pool.length) % pool.length];
    } else {
      for (let offset = 1; offset <= all.length; offset += 1) {
        const candidate = all[(from + offset * step + all.length) % all.length];
        if (pool.includes(candidate)) {
          next = candidate;
          break;
        }
      }
    }
  }
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}
