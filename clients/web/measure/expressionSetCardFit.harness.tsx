import { createRoot } from "react-dom/client";
import { FIXTURE_CHANNEL_ID, FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import type { ExpressionList } from "@momo/core/features/expressions/types";
import { EXPRESSION_SET_ACTION_ID } from "@momo/core/features/expressions/set";
import { FIXTURE_SET_APPROVAL_ID, FIXTURE_SET_NORMAL, FIXTURE_SET_PLAN_CARD, FIXTURE_SET_REFUSED } from "@momo/core/features/expressions/setFixtures";
import { EXPRESSION_SET_PLAN_ACTION_ID } from "@momo/core/features/expressions/setWire";
import type { AgentApprovalCard } from "@momo/core/features/timeline/agentCardModel";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { ExpressionsContext } from "@/features/expressions/context";
import { ExpressionSetApprovalCard } from "@/features/expressions/ExpressionSetApprovalCard";
import { ExpressionPlanCard } from "@/features/expressions/ExpressionPlanCard";
import "@/lib/coreHost";
import "@/design/tokens.css";
import "@/features/expressions/expressions.css";
import "@/features/expressions/expressionSet.css";

// 세트 카드·계획 카드를 카드 폭을 바꿔 가며 실제 엔진에서 재는 하네스 (#5527, 검수 7c M1·M2).
// 진짜 카드(진짜 토큰, `expressionSet.css`)를 폭이 정해진 상자(`#root`) 안에 세운다. `?card=set|plan`, `?fixture=normal|refused`(세트 카드), `?w=`(상자 폭 px).
// 실행 중에 폭을 바꾸려면 `window.cardFit.setWidth(px)`다(창 크기가 바뀌어 `ResizeObserver`가 열 수를 다시 정하는 길). 그림은 가장자리까지 칠해진 정사각형이라 칸을 넘으면 그대로 보인다.
// 참조 그림(`/v1` 첨부)이 없는 세트를 쓴다(네트워크 없이). 시험은 `ExpressionSetApprovalCard.fit.browser.test.ts`다.

const SOLID_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='darkorange'/></svg>")}`;

const approvalCard = (actionId: string, title: string): AgentApprovalCard => ({
  kind: "approval", approvalId: FIXTURE_SET_APPROVAL_ID, title, status: "pending", isResumeOffer: false, execution: null,
  action: { id: actionId, rows: [], omittedRows: 0, rationale: null, requiredRole: null }, detail: { rows: [], withheld: 0 }, channelId: FIXTURE_CHANNEL_ID,
});

declare global {
  interface Window {
    cardFit: { setWidth: (px: number) => void };
  }
}

export async function mountExpressionSetCardFitHarness() {
  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items: [] };
  const transport: ExpressionTransport = { json: async () => list, image: async () => SOLID_PICTURE };
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  await store.refresh();
  const query = new URLSearchParams(window.location.search);
  const root = document.getElementById("root")!;
  const setWidth = (px: number) => { root.style.width = `${px}px`; };
  setWidth(Number(query.get("w") ?? 400));
  window.cardFit = { setWidth };
  const expiresAtMs = Date.now() + 3_600_000;
  const set = { ...(query.get("fixture") === "refused" ? FIXTURE_SET_REFUSED : FIXTURE_SET_NORMAL), expiresAtMs, references: [] };
  const plan = { ...FIXTURE_SET_PLAN_CARD, expiresAtMs };
  createRoot(root).render(
    <ExpressionsContext.Provider value={store}>
      {query.get("card") === "plan"
        ? <ExpressionPlanCard card={approvalCard(EXPRESSION_SET_PLAN_ACTION_ID, "세트 계획")} plan={plan} />
        : <ExpressionSetApprovalCard card={approvalCard(EXPRESSION_SET_ACTION_ID, "그림 세트 등록 요청")} set={set} result={null} />}
    </ExpressionsContext.Provider>,
  );
}
