/**
 * #4910: the phone takes its two catalogs by STATIC import and never through the core's dynamic loader.
 *
 * `loadMessageCatalog` loads each catalog with `import()`. Metro's dev server (`lazy=true`) serves that as a
 * lazy bundle by URL, and the URL cannot name a file outside this project root (`packages/momo-core`), so a dev
 * build stalled on `mobile-locale-initialization-failed`. A release bundle resolves it, which is why only dev broke.
 *
 * Two halves, each measuring a value: the controller really boots with the core's loader made to throw, and
 * a parser-based scan of everything Metro can bundle finds no spelling of the loader or of a dynamic catalog import.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import {catalog as enCatalog} from '@momo/core/i18n/generated/en-US';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService, SAFE_MESSAGE} from '@momo/core/i18n/service';
import type {LocalePreferencePort} from '@momo/core/i18n/preferences';

const APP_ROOT = path.resolve(__dirname, '..');

describe('the controller boots from its static catalogs', () => {
  const KEY = 'settings.profile.languageLabel'; // ko "언어", en "Language": a real catalog string, not SAFE_MESSAGE

  function deviceIn(language: string): LocalePreferencePort {
    return {
      readPreference: () => 'system',
      writePreference: () => {},
      readDevice: () => ({languages: [language], timeZone: 'Asia/Seoul'}),
    };
  }

  afterEach(() => {
    jest.dontMock('@momo/core/i18n/catalogs');
  });

  it.each([
    ['ko-KR', koCatalog],
    ['en-US', enCatalog],
  ] as const)('%s: serves that catalog while the core loader throws if anything calls it', async (locale, catalog) => {
    let controllerModule!: typeof import('../src/i18n/controller');
    jest.isolateModules(() => {
      // Mocks are keyed by the resolved file, so every route to the loader (the barrel's re-export, an alias,
      // a namespace member) reaches this one.
      jest.doMock('@momo/core/i18n/catalogs', () => ({
        loadMessageCatalog: () => {
          throw new Error('the phone must not take its catalogs from the core dynamic loader (#4910)');
        },
      }));
      controllerModule = require('../src/i18n/controller');
    });
    const controller = await controllerModule.createMobileLocaleController({
      port: deviceIn(locale),
      initializeIntl: () => {},
    });
    try {
      const snapshot = controller.getSnapshot();
      const expected = createMessageService({messageLocale: locale, catalog}).formatMessage(KEY);
      expect(expected).not.toBe(SAFE_MESSAGE);
      expect(snapshot.effectiveLocale).toBe(locale);
      expect(snapshot.locale.formatMessage(KEY)).toBe(expected);
    } finally {
      controller.dispose();
    }
  });
});

describe('no phone runtime source reaches the core dynamic catalog loader', () => {
  /** What the detector flags: the loader's name in any spelling, its module, or a dynamic import of a generated catalog. */
  function dynamicCatalogUse(fileName: string, text: string): string[] {
    const kind = fileName.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : fileName.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : fileName.endsWith('.js')
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
    const hits: string[] = [];
    const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const visit = (node: ts.Node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'loadMessageCatalog') {
        hits.push(`${fileName}:${line(node)} names loadMessageCatalog`);
      }
      if (ts.isStringLiteralLike(node) && /(^|\/)i18n\/catalogs$/.test(node.text)) {
        hits.push(`${fileName}:${line(node)} reaches ${node.text}`);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        /i18n\/generated\//.test(node.arguments[0].text)
      ) {
        hits.push(`${fileName}:${line(node)} imports ${node.arguments[0].text} dynamically`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return hits;
  }

  /** Everything Metro can put in the app bundle: `src/`, `App.tsx` and `index.js`. Tests are not bundled. */
  function runtimeSources(): string[] {
    const files: string[] = [path.join(APP_ROOT, 'App.tsx'), path.join(APP_ROOT, 'index.js')];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(path.join(APP_ROOT, 'src'));
    return files;
  }

  it('the detector flags every spelling and passes the static form (it can fail)', () => {
    const dirty: Record<string, string> = {
      'aliased import and call': "import {loadMessageCatalog as load} from '@momo/core/i18n';\nvoid load('ko-KR');",
      'namespace member': "import * as i18n from '@momo/core/i18n';\nvoid i18n.loadMessageCatalog('ko-KR');",
      'the loader module itself': "import {x} from '@momo/core/i18n/catalogs';",
      'inline dynamic import of a catalog':
        "const load = async () => (await import('@momo/core/i18n/generated/ko-KR')).catalog;",
      'string key': "const load = i18n['loadMessageCatalog'];",
    };
    const missed = Object.entries(dirty)
      .filter(([, text]) => dynamicCatalogUse('probe.tsx', text).length === 0)
      .map(([label]) => label);
    expect(missed).toEqual([]);
    expect(
      dynamicCatalogUse(
        'probe.ts',
        "import {catalog} from '@momo/core/i18n/generated/ko-KR';\n// loadMessageCatalog is only named in this comment\nexport const ko = catalog;",
      ),
    ).toEqual([]);
  });

  it('finds no use of the loader or a dynamic catalog import in the phone runtime source', () => {
    const files = runtimeSources();
    // A scan over nothing proves nothing: the phone really has hundreds of files, the controller among them.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(path.join(APP_ROOT, 'src/i18n/controller.ts'));
    const hits = files
      // Only parse a file that could possibly name one of the three; the parser then separates code from comments.
      .filter(file => /loadMessageCatalog|i18n\/catalogs|i18n\/generated/.test(fs.readFileSync(file, 'utf8')))
      .flatMap(file => dynamicCatalogUse(path.relative(APP_ROOT, file), fs.readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});
