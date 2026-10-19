import type { PluginManifestTool } from "../../lib/api";

// =============================================================================
// 도구 등급 R · A · B (ADR-0113 증보 2 E4, 앱 화면 v2 #3949).
//
// 등급은 매니페스트의 세 값이 정한다. 화면이 도구 이름이나 설명을 읽고 추측하지 않는다:
//
//   R  읽기                                  risk=read  + approvalPolicy=none
//   A  내게만 영향이 있는 쓰기               risk=write + approvalPolicy=require_approval
//   B  다른 사람에게 보이거나 알림이 가는 쓰기 risk=write + approvalPolicy=always
//
// C(삭제·권한·공유·병합·코드 푸시)는 v1 매니페스트에서 아예 뺀다. 그래서 C 등급은 화면에도
// 없다: 목록에 없는 것이 가장 강한 거절이고, 화면이 「C」를 그리면 있는 것처럼 읽힌다.
//
// **알 수 없는 조합은 등급 없음이다**(`null`). 옛 서버가 `approvalPolicy`를 안 주거나 새 값이
// 오면 가장 가까운 등급으로 어림하지 않는다 — 어림한 등급은 사용자가 승인을 판단하는 근거이므로
// 틀린 등급은 없는 등급보다 나쁘다. 호출한 쪽이 기존 위험도·승인 칩으로 물러선다.
//
// 승인 단계(`approvalTier`)는 쓰지 않는다: A와 B가 둘 다 `network_write`라서 가르지 못한다.
// =============================================================================

export type AppGrade = "R" | "A" | "B";

export function appToolGrade(
  tool: Pick<PluginManifestTool, "risk" | "approvalPolicy">
): AppGrade | null {
  if (tool.risk === "read" && tool.approvalPolicy === "none") return "R";
  if (tool.risk === "write" && tool.approvalPolicy === "require_approval") return "A";
  if (tool.risk === "write" && tool.approvalPolicy === "always") return "B";
  return null;
}

/**
 * 칩에 쓰는 짧은 말. 글자(R·A·B)가 먼저이고 뜻이 따라온다: 색에만 기대지 않는다. 뜻은 **영향 범위**로 말한다
 * (E4 표). 「승인」은 A와 B가 모두 받는다(호출마다)고 선언돼 있어서 이름으로 둘을 가르지 못한다.
 * 호출 인자에 따라 등급이 갈리는 도구는 높은 쪽(B)으로 선언하므로 B는 「보일 수 있는」이라고 말한다.
 */
export const APP_GRADE_LABEL: Readonly<Record<AppGrade, string>> = {
  R: "R · 읽기",
  A: "A · 나만 영향받는 쓰기",
  B: "B · 남에게 보일 수 있는 쓰기",
};

const GRADE_MEANING: Readonly<Record<AppGrade, string>> = {
  R: "R은 읽기만 해요.",
  A: "A로 선언된 쓰기는 나만 영향받고 되돌릴 수 있어요.",
  B: "B로 선언된 쓰기는 다른 사람에게 보이거나 알림이 갈 수 있어요.",
};

/**
 * 이 앱의 도구에 **실제로 있는** 등급이 무엇인지 한 번 말하는 줄. 도구 줄마다 뜻을 달면 높이만
 * 늘어서 목록 위에서 한 번만 쓰고, 없는 등급은 말하지 않는다(읽기만 있는 앱에 쓰기 설명을 붙이지 않는다).
 * 등급을 아는 도구가 하나도 없으면 `null`이다.
 *
 * 쓰기가 「호출마다 승인」인 것은 **매니페스트가 선언한 것**이다. 실제로 막는 힘은 실행하는 곳마다
 * 다르고(E1) 그록봇에서는 oort가 막지 못하므로, 이 줄은 「물어요」가 아니라 「등록돼 있어요」라고 말한다. A·B의 뜻도
 * 매니페스트가 **선언한** 등급의 뜻이다.
 */
export function appGradeLegend(
  tools: readonly Pick<PluginManifestTool, "risk" | "approvalPolicy">[]
): string | null {
  const present = new Set(tools.map(appToolGrade).filter((grade): grade is AppGrade => grade !== null));
  if (present.size === 0) return null;
  const sentences = (["R", "A", "B"] as const).filter((grade) => present.has(grade)).map((grade) => GRADE_MEANING[grade]);
  if (present.has("A") || present.has("B")) sentences.push("쓰기는 부를 때마다 승인을 받는 것으로 등록돼 있어요.");
  return sentences.join(" ");
}
