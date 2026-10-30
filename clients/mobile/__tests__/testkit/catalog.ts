import fs from 'node:fs';
import path from 'node:path';
import {messageKeys} from '@momo/core/i18n';

/**
 * 문구 카탈로그 검사의 재료 — 「키 누락」과 「빈 문구」.
 *
 * 새 사전의 원문 JSON과 이관 전 `copy.ts` 모듈을 함께 검사한다(P1까지).
 * 사전 원문은 fallback 서비스로 읽지 않는다. 파일 누락·빈 사전이 영어 fallback에 가려지면 안 된다.
 */

export {blankCopy, copyStringCount, missingKeys} from '@momo/core/testkit/catalog';

const CATALOGS = path.join(path.dirname(require.resolve('@momo/core/i18n')), 'catalogs');

/** Translation review input, separate from role/key-based screen behavior tests. */
export function readMessageCatalogs(
  directory = CATALOGS,
  required: readonly string[] = messageKeys,
): Record<string, Record<string, string>> {
  if (required.length === 0) throw new Error('Empty message key list');
  const catalogs: Record<string, Record<string, string>> = {};
  for (const locale of ['ko-KR', 'en-US']) {
    const folder = path.join(directory, locale);
    const files = fs.readdirSync(folder).filter(file => file.endsWith('.json')).sort();
    if (files.length === 0) throw new Error(`Empty message catalog: ${locale}`);
    const messages: Record<string, string> = Object.create(null);
    for (const file of files) {
      const source: unknown = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
      if (source === null || typeof source !== 'object' || Array.isArray(source) ||
          Object.keys(source).length === 0) {
        throw new Error(`Empty or invalid message catalog: ${locale}/${file}`);
      }
      for (const [key, value] of Object.entries(source)) {
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`Empty or invalid message: ${locale}/${key}`);
        }
        if (Object.hasOwn(messages, key)) throw new Error(`Duplicate message: ${locale}/${key}`);
        messages[key] = value;
      }
    }
    const missing = required.filter(key => !Object.hasOwn(messages, key));
    const extra = Object.keys(messages).filter(key => !required.includes(key));
    if (missing.length || extra.length) {
      throw new Error(`Message keys differ: ${locale}; missing=${missing}; extra=${extra}`);
    }
    catalogs[locale] = messages;
  }
  return catalogs;
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
