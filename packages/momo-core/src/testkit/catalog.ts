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

