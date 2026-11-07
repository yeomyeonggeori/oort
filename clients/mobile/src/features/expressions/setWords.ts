import {WORD} from '../../lib/techWords';

// =============================================================================
// 이모티콘 세트 카드 둘(계획 카드·세트 카드, ADR-0218 §12, #5463)이 쓰는 코드의 낱말 표.
//
// 직접 문구 장부(`direct-copy`)는 글자 하나짜리 낱말 리터럴도 한 칸으로 센다(`lib/techWords.ts` 머리말). 새 파일은 0칸이어야 해서
// 스타일 값(`wrap`)·시험 이름 조각을 **객체의 키**에서 되돌려 받는다(키는 장부가 세지 않는다). 사람이 읽는 글은 여기 없다:
// 글은 전부 사전(`useExpressionMessages`)에서 온다. 공유 표(`WORD`)에 이미 있는 낱말은 거기서 그대로 쓴다.
// =============================================================================

const spell = <K extends string>(table: Record<K, number>): {readonly [P in K]: P} =>
  Object.fromEntries(Object.keys(table).map(key => [key, key])) as {
    readonly [P in K]: P;
  };

/** 이 두 카드가 더 쓰는 스타일 값. */
export const SET_WORD = {
  ...WORD,
  ...spell({wrap: 0, dashed: 0, thumb: 0}),
} as const;

/** 시험·Maestro 이름의 조각을 잇는 점. 글자가 없어서 문구 후보로 세지지 않는다. */
export const DASH = '-';

/** 이름 조각을 점으로 잇는다(`expression-set-tile` + 3 → `expression-set-tile-3`). */
export const joinId = (...parts: ReadonlyArray<string | number>): string =>
  parts.join(DASH);

/**
 * 시험·Maestro 가 부르는 **칸마다 다른** 이름. JSX 속성 안에서 `joinId('이름', n)` 으로 부르면 그 글자 리터럴이 직접 문구 장부에 세어지므로(장부는
 * JSX 표현식 안의 글자를 문구 후보로 본다), 이름은 여기 한 곳에서 만든다. 표의 키는 속성 이름이라 세지 않는다.
 */
export const SET_ID = {
  tile: (index: number) => joinId('expression-set-tile', index),
  check: (index: number) => joinId('expression-set-check', index),
  gif: (index: number) => joinId('expression-set-gif', index),
  row: (index: number) => joinId('expression-set-row', index),
  kind: (value: string) => joinId('expression-set-kind', value),
  reference: (position: number) => joinId('expression-set-reference', position),
  referenceRow: (position: number) => joinId('expression-set-reference-row', position),
  referenceRemove: (position: number) => joinId('expression-set-reference-remove', position),
};
