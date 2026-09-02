import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";

export interface ToolRow extends AgentToolCatalogEntry {
  enabled: boolean;
  unknown: boolean;
}

/** RED stub (#1957): returns nothing so merge/toggle/PUT proofs fail. */
export function mergeToolRows(
  _catalog: readonly AgentToolCatalogEntry[],
  _enabledTools: readonly string[]
): ToolRow[] {
  return [];
}

export function toggleToolRow(
  rows: readonly ToolRow[],
  name: string,
  next: boolean
): ToolRow[] {
  void name;
  void next;
  return rows.map((row) => ({ ...row }));
}

export function enabledToolsFromRows(rows: readonly ToolRow[]): string[] {
  void rows;
  return [];
}

export function isToolToggleLocked(
  row: ToolRow,
  readOnly: boolean
): boolean {
  void row;
  void readOnly;
  return false;
}
