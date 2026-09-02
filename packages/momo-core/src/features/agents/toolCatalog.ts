// =============================================================================
// Agent tool catalog wire (UX-R4a / #1957).
//
// The executable set lives in `server-rust/crates/momo-agent/src/tools.rs`
// (`CATALOG` + `DECLARED_NOT_EXECUTABLE`). This client does not copy that
// list. It reads whatever GET `/v1/workspaces/{ws}/agent-tool-catalog` returns,
// and G6 fail-closed applies to a missing `requiresApproval` flag: unknown is
// "approval required".
//
// The route is not in OpenAPI yet. Parse is total: a body this client cannot
// use is `null` (absent), never an invented catalog.
// =============================================================================

import { arrayField, bool, str } from "../../lib/wire";

export interface AgentToolCatalogEntry {
  name: string;
  description: string;
  executable: boolean;
  requiresApproval: boolean;
  unavailableReason: string | null;
}

/** 실행 불가 항목에 서버가 사유를 안 실었을 때. */
export const DECLARED_ONLY_REASON =
  "이 서버는 아직 이 도구를 실행하지 않습니다.";

export function catalogEntryFromWire(
  value: unknown
): AgentToolCatalogEntry | null {
  const name = str(value, "name")?.trim();
  if (!name) return null;
  const description = (str(value, "description") ?? "").trim();
  const executable = bool(value, "executable") ?? false;
  const requiresApproval = bool(value, "requiresApproval") ?? true;
  const rawReason = str(value, "unavailableReason")?.trim() ?? "";
  return {
    name,
    description,
    executable,
    requiresApproval,
    unavailableReason: executable ? null : rawReason || DECLARED_ONLY_REASON,
  };
}

/**
 * `tools` 키가 없거나 배열이 아니면 `null` (라우트가 없거나 본문을 못 읽음).
 * 빈 배열은 빈 카탈로그이지 부재가 아니다.
 */
export function parseAgentToolCatalog(
  value: unknown
): AgentToolCatalogEntry[] | null {
  const tools = arrayField(value, "tools");
  if (tools === null) return null;
  const parsed: AgentToolCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of tools) {
    const entry = catalogEntryFromWire(item);
    if (entry === null || seen.has(entry.name)) continue;
    seen.add(entry.name);
    parsed.push(entry);
  }
  return parsed;
}
