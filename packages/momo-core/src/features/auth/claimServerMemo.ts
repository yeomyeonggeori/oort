import { normalizeServerUrl } from "../../lib/serverUrl";

// =============================================================================
// 링크가 바꾸기 전의 서버 선택을 적어 두는 글 (ADR-0215 D8, #4601).
//
// 데스크탑은 claim 링크의 출처를 **먼저 저장하고** claim 화면으로 간다. 그 화면에서 서버를 거절하면
// 링크가 저장해 둔 서버를 전의 선택으로 되돌려야 하므로, 바꾸기 전의 선택을 이 탭의 세션에 적어 둔다.
// 저장소는 웹의 몫이고(`claimHandoff.ts`), 이 파일은 적는 글과 읽는 규칙만 가진다: 읽을 때 서버
// 주소 규칙을 다시 지나게 해서 변조된 글이 서버 선택이 되지 못하게 한다.
// =============================================================================

export type ServerBeforeClaim = { found: true; base: string | null } | { found: false };

/** 서버가 없던 기기는 `null`로 적는다(「아무것도 안 골랐다」도 되돌릴 선택이다). */
export function serializeServerBeforeClaim(previous: string | null): string {
  return JSON.stringify({ base: previous });
}

/** 적어 둔 글을 읽는다. 없거나 읽을 수 없거나 서버 주소가 아니면 `found: false`다. */
export function parseServerBeforeClaim(raw: string | null): ServerBeforeClaim {
  if (raw === null) return { found: false };
  let base: unknown;
  try {
    base = (JSON.parse(raw) as { base?: unknown } | null)?.base;
  } catch {
    return { found: false };
  }
  if (base === null) return { found: true, base: null };
  const checked = typeof base === "string" ? normalizeServerUrl(base) : null;
  return checked !== null && checked.ok ? { found: true, base: checked.base } : { found: false };
}
