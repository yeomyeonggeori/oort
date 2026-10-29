import fs from 'node:fs';
import path from 'node:path';

/**
 * 문구 카탈로그 검사의 재료 — 「키 누락」과 「빈 문구」.
 *
 * 문장 사전(#4240)이 들어오면 두 가지를 사전 한 곳에서 잰다: 언어마다 같은 키를 갖는가(`missingKeys`),
 * 빈 문장이 없는가(`blankCopy`). 사전이 없는 지금은 소스의 `copy.ts` 류 모듈이 문구의 집이라서,
 * 거기서 내보낸 값을 같은 모양으로 잰다(`copyModules` 가 어디서 모으는지). 사전이 생기면 바뀌는 것은
 * 그 입력뿐이다.
 *
 * 키 누락이 지금은 컴파일러의 몫이기도 하다(`Record<Union, string>` 은 빠진 키가 있으면 tsc 가
 * 막는다). 이 함수는 키가 **런타임에 정해지는** 사전(언어별 파일)을 위한 것이다.
 */

/** `required` 중 `catalog` 에 없거나 `undefined` 인 키(최상위). 순서는 `required` 를 따른다. */
export function missingKeys(
  catalog: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter(
    key => !Object.prototype.hasOwnProperty.call(catalog, key) || catalog[key] === undefined,
  );
}

/**
 * 내보낸 값 중 **비어 있는 문구**의 경로. 문자열은 공백만이어도 비어 있다고 본다. 평범한 객체와
 * 배열은 안쪽까지 내려간다. 함수는 건너뛴다(인자 없이는 무엇을 돌려줄지 모른다).
 */
export function blankCopy(source: Record<string, unknown>, prefix = ''): string[] {
  const blanks: string[] = [];
  const visit = (value: unknown, where: string): void => {
    if (typeof value === 'string') {
      if (value.trim() === '') {
        blanks.push(where);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${where}[${index}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        visit(inner, `${where}.${key}`);
      }
    }
  };
  for (const [key, value] of Object.entries(source)) {
    visit(value, prefix === '' ? key : `${prefix}.${key}`);
  }
  return blanks;
}

/** 문구 문자열이 몇 개 있나(`blankCopy` 와 같은 걸음으로 센다). 빈 입력이 통과하지 못하게 한다. */
export function copyStringCount(source: Record<string, unknown>): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      count += 1;
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  Object.values(source).forEach(visit);
  return count;
}

/**
 * `srcDir` 아래에서 이름에 `copy` 가 든 `.ts`·`.tsx` 모듈 경로(디렉터리 이름만 훑는다 — 파일 내용은
 * 읽지 않고, 모듈은 시험이 `require` 해서 **값**으로 본다). 새 문구 모듈이 생기면 목록에 저절로 든다.
 */
export function copyModules(srcDir: string): string[] {
  return fs
    .readdirSync(srcDir, {recursive: true, encoding: 'utf8'})
    .filter(entry => /copy[^/]*\.tsx?$/i.test(path.basename(entry)))
    .map(entry => path.join(srcDir, entry))
    .sort();
}
