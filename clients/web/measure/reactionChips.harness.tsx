import { createRoot } from "react-dom/client";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import type { Expression, ExpressionImage as Picture, ExpressionList } from "@momo/core/features/expressions/types";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import type { ExpressionTransport } from "@/features/expressions/transport";
import { ExpressionsContext } from "@/features/expressions/context";
import { ReactionChips } from "@/features/timeline/ReactionChips";
import "@/lib/coreHost";
import "@/design/tokens.css";
import "@/features/expressions/expressions.css";
import { dataUrlOf, synthGif } from "./gifSynth";

// 반응 칩의 GIF 가 실제 엔진에서 계속 도는지·화면 밖에서 멈추는지·몇 번 받고 몇 장을 그리는지 재는 하네스 (#5504). 진짜 `ReactionChips`·`ExpressionImage`·`ExpressionStore` 를 띄운다.
// 그림은 두 가지다. `gif=tiny`(기본)는 코어 fixture 의 1x1 GIF(100ms 마다 주황 ↔ 파랑, 반복 횟수 3 = 총 4번)라서 칩이 한 가지 색 네모로 보이고 움직임이 색 바뀜으로 드러난다.
// `gif=synth` 는 서버 small 과 같은 모양(128x128, 12장면, 반복 횟수 3)의 합성 GIF 라서 디코드·그리기 비용이 실제에 가깝다. 시험은 `ReactionChips.motion.browser.test.ts` 다.
//
//   ?chips=N   한 메시지 줄의 칩 수(서로 다른 표현 N 개 = 서로 다른 그림 N 장)   ?rows=M   같은 줄을 M 번(= 같은 그림을 M 개 메시지에서 쓴다)
//   ?gif=tiny|synth   ?spacer=1   줄 위에 화면보다 큰 여백(칩을 화면 밖으로 스크롤하는 시험)   ?still=1   모두 정지 PNG 인 표현(비교 기준)

type Variant = "tiny" | "synth";
declare global {
  interface Window {
    reactionChipsHarness: { imageCalls: string[]; decodes: number };
  }
}

const STILL_PICTURE = FIXTURE_MEDIA.png.image;
const pad = (value: number) => String(value).padStart(12, "0");

function pictures(still: boolean, variant: Variant, bytes: number): { small: Picture; large: Picture; thumb: Picture } {
  const gif: Picture = variant === "tiny"
    ? { ...FIXTURE_MEDIA.gif.image }
    : { mime: "image/gif", sha256: "c".repeat(64), bytes, width: 128, height: 128, frameCount: 12, durationMs: 960 };
  const animated = still ? { ...STILL_PICTURE } : gif;
  return { small: { ...animated }, large: { ...animated }, thumb: { ...STILL_PICTURE } };
}

export async function mountReactionChipsHarness() {
  const query = new URLSearchParams(window.location.search);
  const chips = Number(query.get("chips") ?? 1);
  const rows = Number(query.get("rows") ?? 1);
  const variant: Variant = query.get("gif") === "synth" ? "synth" : "tiny";
  const still = query.get("still") === "1";
  const harness = { imageCalls: [] as string[], decodes: 0 };
  window.reactionChipsHarness = harness;

  // 표현마다 다른 바이트의 GIF(합성은 seed 가 다르고, tiny 는 전역 색 표의 두 색을 바꾼다)를 미리 만들어 둔다.
  const gifOf = new Map<string, string>();
  const items: Expression[] = Array.from({ length: chips }, (_, index) => {
    const id = `00000000-0000-4000-8000-${pad(500 + index)}`;
    let bytes: Uint8Array;
    if (variant === "tiny") {
      bytes = Uint8Array.from(atob(FIXTURE_MEDIA.gif.bodyBase64), (char) => char.charCodeAt(0));
      // 1x1 GIF 의 전역 색 표(13번째 바이트부터 두 색) 중 첫 색의 R·G 만 바꿔 표현마다 다른 주소를 만든다(36가지까지). 둘째 색은 파랑 그대로라 두 장면이 늘 다르다.
      bytes[13] = 255 - (index % 6) * 30;
      bytes[14] = 200 - Math.floor(index / 6) * 30;
    } else {
      bytes = synthGif({ size: 128, frames: 12, delayCs: 8, seed: index + 1 });
    }
    gifOf.set(id, dataUrlOf(bytes));
    return {
      ...FIXTURE_EXPRESSIONS[0], id, name: `chip_${index}`, displayName: `칩 ${index}`, tags: [], kind: "sticker", status: "active",
      media: pictures(still, variant, bytes.length),
    };
  });

  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items };
  const transport: ExpressionTransport = {
    json: async () => list,
    image: async (path) => {
      harness.imageCalls.push(path);
      if (path.includes("size=thumb") || still) return `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
      const id = /expressions\/([^/]+)\/image/.exec(path)?.[1] ?? "";
      return gifOf.get(id) ?? "";
    },
  };
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  await store.refresh();

  // 디코드를 센다: `ExpressionImage` 는 그림을 바꿔 끼우기 전에 화면 밖 `Image` 로 먼저 디코드한다.
  const originalDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function decode(this: HTMLImageElement) {
    harness.decodes += 1;
    return originalDecode.call(this);
  };

  const directory = makeDirectory([]);
  const rowChips = items.map((item) => ({ emoji: `:${item.name}:`, count: 1, mine: false, memberIds: [] as string[] }));
  createRoot(document.getElementById("root")!).render(
    <ExpressionsContext.Provider value={store}>
      {query.get("spacer") === "1" && <div id="spacer" />}
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} data-testid="message-row">
          <ReactionChips chips={rowChips} directory={directory} myMemberId={undefined} onToggle={() => {}} />
        </div>
      ))}
    </ExpressionsContext.Provider>,
  );
}
