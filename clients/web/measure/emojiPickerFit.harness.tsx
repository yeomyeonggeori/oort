import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import type { Expression, ExpressionList } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { ExpressionsContext } from "@/features/expressions/context";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
import "@/lib/coreHost";
import "@/design/tokens.css";
import "@/features/expressions/expressions.css";

// 이모티콘 창(고르개)이 작은 창에서 화면 안에 서는지 실제 엔진에서 재는 하네스 (#5527, 검수 7c B1).
// 진짜 `EmojiPickerDialog`(Radix 팝오버, 진짜 토큰)를 띄운다: 입력창의 ☺처럼 화면 아래쪽에 선 단추가 기준이고 창은 그 위로 뜬다(`?at=bottom`). `?at=middle`은 단추가 화면 가운데에
// 서는 자리(메시지 줄의 「반응 더하기」처럼 위·아래 어느 쪽도 넉넉하지 않은 자리)다. `?purpose=insert`는 첫 탭이 이모티콘(팀 보관함의 격자·세트 띠)이고 `?purpose=reaction`은 이모지 탭부터 연다.
// 팀 보관함은 세 세트 30칸이라 격자가 한 번에 다 보이지 않는다(그래야 격자가 줄어드는 몫을 질 수 있다). 시험은 `EmojiPickerDialog.fit.browser.test.ts`다.

const png = FIXTURE_MEDIA.png.image;
const STILL = { small: { ...png }, large: { ...png }, thumb: { ...png } };
let serial = 500;
const made = (name: string, tags: string[]): Expression => ({
  ...FIXTURE_EXPRESSIONS[1], id: `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`, name, displayName: name, tags, kind: "sticker", media: STILL, status: "active",
});
const names = (prefix: string, count: number) => Array.from({ length: count }, (_, at) => `${prefix}_${String(at + 1).padStart(2, "0")}`);
const ITEMS = [
  ...names("dam", 12).map((name) => made(name, ["농담곰"])),
  ...names("chi", 12).map((name) => made(name, ["치이"])),
  ...names("solo", 6).map((name) => made(name, [])),
];

const SOLID_PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='darkorange'/></svg>")}`;

// eslint-disable-next-line react-refresh/only-export-components -- 독립 브라우저 시험의 마운트 함수와 같은 파일에서만 쓰는 화면이에요.
function PickerHost({ purpose }: { purpose: "insert" | "reaction" }) {
  const [open, setOpen] = useState(true);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={setOpener} type="button" id="picker-opener" aria-label="이모티콘 넣기">☺</button>
      {opener && <EmojiPickerDialog open={open} onOpenChange={setOpen} onPick={() => {}} opener={opener} purpose={purpose} testId="picker" />}
    </>
  );
}

export async function mountEmojiPickerFitHarness() {
  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items: ITEMS };
  const transport: ExpressionTransport = { json: async () => list, image: async () => SOLID_PICTURE };
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  await store.refresh();
  const query = new URLSearchParams(window.location.search);
  document.body.dataset.at = query.get("at") ?? "bottom";
  createRoot(document.getElementById("root")!).render(
    <ExpressionsContext.Provider value={store}>
      <PickerHost purpose={query.get("purpose") === "reaction" ? "reaction" : "insert"} />
    </ExpressionsContext.Provider>,
  );
}
