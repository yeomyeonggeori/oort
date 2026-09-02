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

import { arrayField, bool, record, str } from "../../lib/wire";

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

/**
 * `tools` 키가 없거나 배열이 아니면 `null` (라우트가 없거나 본문을 못 읽음).
 * 빈 배열은 빈 카탈로그이지 부재가 아니다.
 */
export function parseAgentToolCatalog(
  value: unknown
): AgentToolCatalogEntry[] | null {
  void value;
  return null;
}

export function catalogEntryFromWire(
  value: unknown
): AgentToolCatalogEntry | null {
  void value;
  void arrayField;
  void bool;
  void record;
  void str;
  return null;
}
