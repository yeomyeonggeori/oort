import path from 'node:path';

import {blankCopy, copyModules, copyStringCount} from './testkit';

// =============================================================================
// 문구 카탈로그 검사 (#4710) — 폰의 문구 모듈에 빈 문구가 없다.
//
// 사용자 문구는 7개 언어(#4240)로 넘어가면 문장 사전으로 옮겨 간다. 그 전에는 소스의 `*copy*.ts`
// 모듈이 문구의 집이다. 이 검사는 그 모듈들이 내보낸 값을 **값으로** 훑어(소스 글자를 읽지 않는다)
// 비었거나 공백뿐인 문구를 찾는다. 새 문구 모듈은 이름에 `copy` 가 들면 저절로 목록에 든다. 사전이
// 생기면 `copyModules` 의 입력만 사전으로 바뀐다(`testkit/catalog.ts`).
//
// 검사 자체가 실패할 수 있다는 증거(빈 문구를 실제로 잡는지)는 `testkit.test.tsx` 의 catalog 묶음에 있다.
// =============================================================================

const SRC = path.resolve(__dirname, '../src');
const MODULES = copyModules(SRC);
const relative = (file: string): string => path.relative(SRC, file);

describe('폰 문구 모듈 카탈로그', () => {
  it('문구 모듈을 찾고, 거기에 문구가 있다 (빈손으로 통과하지 못하게)', () => {
    expect(MODULES.length).toBeGreaterThan(0);
    const total = MODULES.reduce(
      (sum, file) => sum + copyStringCount(require(file) as Record<string, unknown>),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it.each(MODULES.map(file => [relative(file), file]))(
    '%s: 비어 있는 문구가 없다',
    (_name, file) => {
      expect(blankCopy(require(file) as Record<string, unknown>)).toEqual([]);
    },
  );
});
