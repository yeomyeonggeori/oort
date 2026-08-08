import type { Block } from "@momo/core/features/timeline/markdown";

// =============================================================================
// 접기 예산 (U4-e · 진단 H-8 「긴 응답에 접기가 없다」).
//
// 새 기계가 아니다. 같은 폴더의 `ArtifactCard`가 이미 같은 모양을 쓴다
// (`EAGER_LINE_BUDGET = 200`): **위에서부터 예산을 쓰고, 예산이 끝난 자리부터는
// 접되, 접힌 것이 몇 줄인지 정직하게 말한다.** 바뀌는 것은 예산의 크기와 세는
// 대상(패치 줄 -> 본문 줄)뿐이고, 접힌 쪽을 **마운트하지 않는 것**까지 같다 —
// 그 카드가 예산을 둔 이유가 정확히 그것이었다(500개 모노스페이스 행을 세우면
// 가상 리스트가 그 레이아웃을 다시 재야 한다).
//
// ## 왜 「줄」로 세는가
//
// 읽는 사람이 검산할 수 있는 단위여야 한다. 화면에 감긴 줄로 세면 그 숫자는 창
// 폭의 함수라, 같은 메시지가 채널에서는 「40줄 더」이고 스레드 패널에서는
// 「70줄 더」가 된다 — 어느 쪽도 저자가 쓴 값이 아니다. 아티팩트 카드가 패치
// **줄**을 세는 것과 같은 이유이고, 그래서 이 숫자는 원문을 열어 세어 보면 맞는다.
//
// **그 대가는 적어 둔다**: 개행 없이 3000자를 쓴 한 문단은 이 예산에 걸리지
// 않는다. 그것은 저자가 쓴 **한 줄**이고, 거기서 접는 일은 문장을 반으로 자르는
// 일이 된다. 진단이 실측한 아픔(H-8: 「에이전트가 로그 500줄을 뱉으면 채널이
// 그것 하나로 덮인다」)은 줄 수 현상이므로 줄로 잡는다.
//
// ## 숫자의 근거
//
// 본문 줄 높이는 22px(`--text-body--line-height`)이다. 1280x900 창에서 헤더와
// 컴포저를 빼면 타임라인이 쓰는 세로가 대략 700px이므로 **32줄이 한 화면**이다.
// 24줄(528px)을 넘는 메시지는 그 화면의 3/4을 혼자 쓰기 시작하는 메시지이고,
// 거기서부터 접는다. 접힌 상태에 남기는 12줄(264px)은 「무슨 종류의 답인가」를
// 판단하기에 충분한 양이다 — 첫 문단, 또는 로그의 머리. 두 숫자의 간격이 곧
// **최소로 접히는 양(12줄)**이라, 누르는 값보다 얻는 것이 언제나 크다.
// =============================================================================

export interface FoldBudget {
  /** 이 줄 수를 넘는 것만 접는다. 이하는 손대지 않는다. */
  threshold: number;
  /** 접힌 상태에 남기는 줄 수. */
  eager: number;
}

/** 메시지 본문 — 한 화면의 3/4에서 접고, 절반을 남긴다. */
export const BODY_FOLD: FoldBudget = { threshold: 24, eager: 12 };

/**
 * 에이전트 카드 안의 **값** (진단 H-8 「에이전트 카드 값 무제한」).
 *
 * 본문보다 훨씬 짜다. 카드는 이미 본문 옆에 선 부속이고, 그 안의 한 값(결정
 * 사유, 실패 상세)이 본문보다 길어지는 순간 위계가 뒤집힌다. 8줄을 넘으면
 * 4줄만 남기므로 여기서도 최소 4줄이 접힌다.
 *
 * `detail.rows`의 **개수**에는 예산을 두지 않는다: 코어의 `payloadDetail`이
 * 이름 붙은 필드 7개(라벨 중복 제거 후 최대 6)만 만들므로 개수는 이미 유한하다.
 * 무한한 축은 행이 아니라 **값의 길이**이고, 그래서 예산이 거기 붙는다.
 */
export const CARD_FOLD: FoldBudget = { threshold: 8, eager: 4 };

/** 이 블록이 원문에서 차지한 줄 수. */
export function blockLines(block: Block): number {
  if (block.kind === "code") return block.text.split("\n").length;
  if (block.kind === "list") return block.items.length;
  return block.lines.length;
}

export function countBlockLines(blocks: readonly Block[]): number {
  let total = 0;
  for (const block of blocks) total += blockLines(block);
  return total;
}

/** 블록의 앞 `take`줄만 남긴 사본. 종류마다 「줄」이 무엇인지가 다르다. */
function sliceBlock(block: Block, take: number): Block {
  if (block.kind === "code") {
    return { ...block, text: block.text.split("\n").slice(0, take).join("\n") };
  }
  if (block.kind === "list") {
    return { ...block, items: block.items.slice(0, take) };
  }
  return { ...block, lines: block.lines.slice(0, take) };
}

export interface FoldedBlocks {
  /** 접힌 상태에서 그릴 블록들. 접지 않았으면 원본 그대로다. */
  blocks: Block[];
  /** 접힌 줄 수. **0이면 접지 않았다** — 그때는 컨트롤도 그리지 않는다. */
  hiddenLines: number;
}

/**
 * 파싱된 본문에 예산을 쓴다. 예산이 블록 하나의 한가운데서 끝나면 그 블록을
 * 잘라서 남긴다 — 아티팩트 카드가 패치를 자른 자리에 정직한 배너를 두는 것과
 * 같다. 잘린 코드 펜스는 짧은 펜스로 보이고, 남은 줄 수는 컨트롤이 말한다.
 */
export function foldBlocks(
  blocks: readonly Block[],
  budget: FoldBudget = BODY_FOLD
): FoldedBlocks {
  const total = countBlockLines(blocks);
  if (total <= budget.threshold) return { blocks: [...blocks], hiddenLines: 0 };
  const kept: Block[] = [];
  let left = budget.eager;
  for (const block of blocks) {
    if (left <= 0) break;
    const lines = blockLines(block);
    if (lines <= left) {
      kept.push(block);
      left -= lines;
      continue;
    }
    kept.push(sliceBlock(block, left));
    left = 0;
  }
  return { blocks: kept, hiddenLines: total - budget.eager };
}

export interface FoldedText {
  text: string;
  /** 접힌 줄 수. 0이면 접지 않았다. */
  hiddenLines: number;
}

/**
 * 마크다운이 없는 본문과 카드 값에 쓰는 같은 예산. 평문 경로는 파서를 타지
 * 않으므로(`isPlainText`) 여기서 줄을 직접 센다.
 */
export function foldText(
  body: string,
  budget: FoldBudget = BODY_FOLD
): FoldedText {
  const lines = body.split("\n");
  if (lines.length <= budget.threshold) return { text: body, hiddenLines: 0 };
  return {
    text: lines.slice(0, budget.eager).join("\n"),
    hiddenLines: lines.length - budget.eager,
  };
}

// ---- 펼쳐 둔 상태 -----------------------------------------------------------
//
// React 트리 **밖**에 둔다. react-virtuoso는 행이 뷰포트를 벗어나는 순간
// 언마운트하므로, 컴포넌트 안의 `useState`는 읽던 사람이 그 답을 지나쳤다가
// 돌아오면 사라진다 — 긴 답을 펴 놓고 위 대화를 확인하러 갔다 오는 것은 정확히
// 이 접기가 만드는 동작이다. `ArtifactCard.OPEN_FILES`가 같은 이유로 같은 자리에
// 있고, 여기 있는 것은 그 사본이 아니라 같은 규율의 두 번째 적용이다.

const OPEN_BODIES = new Map<string, boolean>();
const OPEN_BODIES_LIMIT = 500;

/** 이 본문을 사람이 펴 두었는가. 키가 없으면(임시 행) 언제나 접힌 채 시작한다. */
export function foldWasOpened(key: string | undefined): boolean {
  return key === undefined ? false : OPEN_BODIES.get(key) === true;
}

/** 새것이 이기고 가장 오래된 것이 밀린다 — 긴 세션이 맵을 영원히 키우지 않는다. */
export function rememberFoldOpen(key: string | undefined, open: boolean): void {
  if (key === undefined) return;
  OPEN_BODIES.delete(key);
  OPEN_BODIES.set(key, open);
  if (OPEN_BODIES.size > OPEN_BODIES_LIMIT) {
    const oldest = OPEN_BODIES.keys().next().value;
    if (oldest !== undefined) OPEN_BODIES.delete(oldest);
  }
}
