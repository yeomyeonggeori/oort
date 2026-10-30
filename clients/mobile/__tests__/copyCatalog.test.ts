import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {messageKeys} from '@momo/core/i18n';

import {blankCopy, copyModules, copyStringCount, readMessageCatalogs} from './testkit/catalog';

// =============================================================================
// 번역 문장 검수 (#4835 / ADR-0213 §4·§9): 사전과 이관 전 문구 모듈 두 입력을 유지한다.
// 키·역할 기반 화면 행동은 testkit/query.test.tsx에서 검증한다. 이 파일에서는 화면을 올리지 않는다.
// =============================================================================

const SRC = path.resolve(__dirname, '../src');
const MODULES = copyModules(SRC);
const relative = (file: string): string => path.relative(SRC, file);

describe('공유 ko/en 사전 원문', () => {
  it('출시 사전이 비어 있지 않고 생성된 모든 키에 빈 문구 없이 대응한다', () => {
    const catalogs = readMessageCatalogs();
    expect(messageKeys.length).toBeGreaterThan(0);
    expect(Object.keys(catalogs).sort()).toEqual(['en-US', 'ko-KR']);
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).sort()).toEqual([...messageKeys].sort());
      expect(blankCopy(catalog)).toEqual([]);
    }
  });

  it('사보타주: 키 0개·빈 사전·읽을 수 없는 입력·빠진 키·빈 문구를 거절한다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-copy-catalog-'));
    const key = 'settings.profile.languageLabel';
    const ko = path.join(root, 'ko-KR');
    const en = path.join(root, 'en-US');
    try {
      // Sabotage the actual exported default input, then restore it for every other test.
      const keys = messageKeys as unknown as string[];
      const savedKeys = keys.splice(0);
      try {
        expect(() => readMessageCatalogs()).toThrow('Empty message key list');
      } finally {
        keys.push(...savedKeys);
      }
      expect(() => readMessageCatalogs(root, [])).toThrow('Empty message key list');
      expect(() => readMessageCatalogs(root, [key])).toThrow(/ENOENT/);
      fs.mkdirSync(ko);
      fs.mkdirSync(en);
      expect(() => readMessageCatalogs(root, [key])).toThrow('Empty message catalog');
      const file = path.join(ko, 'settings.json');
      for (const broken of ['{}', '{', JSON.stringify({[key]: '  '}), JSON.stringify({wrong: 'x'})]) {
        fs.writeFileSync(file, broken);
        expect(() => readMessageCatalogs(root, [key])).toThrow();
      }
      fs.writeFileSync(file, JSON.stringify({[key]: 'x'}));
      fs.writeFileSync(path.join(en, 'settings.json'), JSON.stringify({[key]: 'y'}));
      expect(readMessageCatalogs(root, [key])['en-US'][key]).toBe('y');
    } finally {
      fs.rmSync(root, {recursive: true});
    }
  });
});

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
