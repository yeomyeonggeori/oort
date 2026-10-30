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

export {blankCopy, copyStringCount, missingKeys} from '@momo/core/testkit/catalog';

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
