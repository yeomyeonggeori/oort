import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import type { Expression, ExpressionList } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { ExpressionsContext } from "@/features/expressions/context";
import { TeamExpressionsPanel } from "@/features/expressions/TeamExpressionsPanel";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
import "@/lib/coreHost";
import "@/design/tokens.css";
import "@/features/expressions/expressions.css";

// 이모티콘 칸 메뉴의 키보드 길과 세트 띠의 「지금 구역」 표시를 실제 엔진에서 재는 하네스 (#5486, 검수 7a H1·M1).
// 진짜 `TeamExpressionsPanel`(칸 메뉴의 즐겨찾기·신고·삭제)과 진짜 토큰·Radix를 띄운다. 그림은 **가장자리까지 불투명하게 칠해진** 정사각형이다:
// 모서리가 투명한 그림으로는 M1(채움이 그림에 가려지는 일)이 드러나지 않았다. 시험은 `ExpressionGrid.keyboardMenu.browser.test.ts`다.

const png = FIXTURE_MEDIA.png.image;
const STILL = { small: { ...png }, large: { ...png }, thumb: { ...png } };
let serial = 300;
const made = (name: string, tags: string[] = []): Expression => ({
  ...FIXTURE_EXPRESSIONS[1], id: `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`, name, displayName: name, tags, kind: "sticker", media: STILL, status: "active",
});
// 세트 둘(공통 태그가 있는 dam, 없는 chi)과 낱개 하나: 구역은 chi, dam, 기타 순이다.
const ITEMS = [...["dam_a", "dam_b", "dam_c"].map((name) => made(name, ["농담곰"])), ...["chi_a", "chi_b"].map((name) => made(name)), made("solo")];

const SOLID_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='darkorange'/></svg>")}`;

declare global {
  interface Window {
    expressionGridMenuHarness: { picked: string[] };
  }
}

// `?host=picker`: 진짜 고르개(`EmojiPickerDialog`, 모달 팝오버)가 패널을 품은 모양. 메뉴 층이 고르개 층 안에 포개져도 Esc 한 번이 메뉴만 닫는지 잰다.
// eslint-disable-next-line react-refresh/only-export-components -- 독립 브라우저 시험의 마운트 함수와 같은 파일에서만 쓰는 화면이에요.
function PickerHost({ picked }: { picked: string[] }) {
  const [open, setOpen] = useState(true);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setOpener} type="button" id="picker-opener">고르개 열기</button>
      {opener && <EmojiPickerDialog open={open} onOpenChange={setOpen} onPick={(token) => picked.push(token)} opener={opener} purpose="insert" testId="picker" />}
    </>
  );
}

export async function mountExpressionGridMenuHarness() {
  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items: ITEMS };
  const transport: ExpressionTransport = { json: async () => list, image: async () => SOLID_PICTURE };
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  await store.refresh();
  const harness = { picked: [] as string[] };
  window.expressionGridMenuHarness = harness;
  const inPicker = new URLSearchParams(window.location.search).get("host") === "picker";
  createRoot(document.getElementById("root")!).render(
    <ExpressionsContext.Provider value={store}>
      {inPicker ? <PickerHost picked={harness.picked} /> : <TeamExpressionsPanel purpose="insert" view="emoticon" onPick={(token) => harness.picked.push(token)} />}
    </ExpressionsContext.Provider>,
  );
}
